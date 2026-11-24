// An untraced result does not depend on what ran earlier on the host: after
// any traced history, verdict requests and Submit give a fresh host's answer.
// Shared by the Node test and the Chromium test.

import {
  allCasesPassPolicy,
  createAlgorithmJudgeBundle,
  type BrowserJudgeHost,
} from '../../src/judge';
import { getLanguageRuntimeProfile } from '../../packages/runtime-browser/src/runtime-profiles';
import {
  buildTraceCompileProgram,
  traceCompileCases,
  type TraceCompileLanguage,
} from './javascript-trace-compile-cases';

export interface UntracedRouteCheck {
  readonly name: string;
  /** Untraced evaluations compared with a fresh host's. */
  compared: number;
  readonly violations: string[];
}

// The app's budgets (its lib/utils.ts getTracingOptions), in each variant.
const APP_BUDGETS = {
  'app default': { maxTraceSteps: 4000, maxLineEvents: 12000, maxSingleLineHits: 1000, maxStoredEvents: 16000 },
  'app heavy recursion': { maxTraceSteps: 4000, maxLineEvents: 20000, maxSingleLineHits: 4000, maxStoredEvents: 16000 },
  'app iOS': { maxTraceSteps: 1000, maxLineEvents: 5000, maxSingleLineHits: 2000, maxStoredEvents: 1000 },
  'app iOS heavy recursion': { maxTraceSteps: 4000, maxLineEvents: 20000, maxSingleLineHits: 4000, maxStoredEvents: 4000 },
};

// A value for each control a profile can advertise; a new control needs one.
const CONTROL_VALUES: Record<string, unknown> = {
  maxTraceSteps: 4000,
  maxLineEvents: 12000,
  maxSingleLineHits: 1000,
  maxStoredEvents: 16000,
  maxTraceBytes: 1_000_000,
  maxPathDepth: 4,
  minimalTrace: true,
  traceProfile: true,
};

const LANGUAGES = ['javascript', 'typescript'] as const;
const STYLES = ['function', 'solution-method', 'ops-class'] as const;

function canonical(evaluation: any): string {
  return JSON.stringify({
    status: evaluation.status,
    compile: [evaluation.compile?.status, evaluation.compile?.failure, evaluation.compile?.diagnostics],
    cases: evaluation.cases.map(answer),
  });
}

function answer(result: any): unknown[] {
  return [result.caseId, result.status, result.verdict, result.value ?? null, result.failure ?? null, result.diagnostics, result.stdout];
}

const passes = (result: any) => result.verdict?.kind === 'passed';

export async function runUntracedRouteChecks(
  createHost: () => BrowserJudgeHost,
  settings: { readonly runaway?: boolean } = {}
): Promise<UntracedRouteCheck[]> {
  const checks: UntracedRouteCheck[] = [];
  const named = (name: string): UntracedRouteCheck => {
    const check = { name, compared: 0, violations: [] };
    checks.push(check);
    return check;
  };
  let nextId = 0;
  const bundle = (language: TraceCompileLanguage, program: any, traceOptions?: object) =>
    createAlgorithmJudgeBundle({
      id: `untraced-route-${nextId++}`,
      language,
      ...program,
      trace: traceOptions !== undefined,
      ...(traceOptions ? { traceOptions } : {}),
    });
  const onHost = async <T>(body: (host: BrowserJudgeHost) => Promise<T>): Promise<T> => {
    const host = createHost();
    try {
      return await body(host);
    } finally {
      await host.dispose();
    }
  };
  const submit = async (host: BrowserJudgeHost, language: TraceCompileLanguage, program: any) =>
    (await host.evaluateAlgorithm({ bundle: await bundle(language, program) })).evaluation as any;
  // The app's verdict request: neither `interactive` nor `tracing`.
  const verdictRequest = async (host: BrowserJudgeHost, language: TraceCompileLanguage, program: any) =>
    (await host.execute({ bundle: await bundle(language, program) })).evaluation as any;
  const tracedRun = async (
    host: BrowserJudgeHost,
    language: TraceCompileLanguage,
    program: any,
    options: object,
    continued: readonly string[] = []
  ) => {
    const started = await host.execute({
      bundle: await bundle(language, program, options),
      interactive: true,
      tracing: { caseIds: ['1'] },
    });
    if (started.executionId) {
      try {
        for (const id of continued) {
          await host.execute({ executionId: started.executionId, tracing: { caseIds: [id] } });
        }
      } finally {
        await host.disposeExecution(started.executionId);
      }
    }
    return started.evaluation as any;
  };
  const same = (check: UntracedRouteCheck, where: string, actual: any, fresh: any) => {
    check.compared += 1;
    if (canonical(actual) !== canonical(fresh)) {
      check.violations.push(`${where}: ${canonical(actual).slice(0, 260)} != fresh host ${canonical(fresh).slice(0, 260)}`);
    }
  };

  // The app's warm-up: one traced case, before anything else.
  const warmUpFor = (language: TraceCompileLanguage) => {
    const plain = buildTraceCompileProgram({}, language, 'function') as any;
    return { ...plain, cases: plain.cases.slice(0, 1) };
  };
  const budgets = APP_BUDGETS['app default'];

  /** Every history of one program, each compared with a fresh host's Submit. */
  const histories = async (check: UntracedRouteCheck, label: string, language: TraceCompileLanguage, program: any) => {
    const fresh = await onHost(async (host) => {
      const submitted = await submit(host, language, program);
      same(check, `${label}: verdict request on a fresh host`, await verdictRequest(host, language, program), submitted);
      return submitted;
    });
    let run: any;
    await onHost(async (host) => {
      await tracedRun(host, language, warmUpFor(language), budgets);
      same(check, `${label}: Submit after a warm-up`, await submit(host, language, program), fresh);
    });
    await onHost(async (host) => {
      run = await tracedRun(host, language, program, budgets);
      same(check, `${label}: verdict request after a Run`, await verdictRequest(host, language, program), fresh);
      await tracedRun(host, language, program, budgets, ['2', '3']);
      same(check, `${label}: Submit after a Run and continuations`, await submit(host, language, program), fresh);
    });
    return { fresh, run };
  };

  const programs = (ids: readonly string[]) => ids.flatMap((id) => {
    const testCase = traceCompileCases.find((entry) => entry.id === id)!;
    return LANGUAGES.filter((language) => !testCase.languages || testCase.languages.includes(language)).flatMap((language) =>
      STYLES.filter((style) => !testCase.styles || testCase.styles.includes(style)).map((style) => ({
        label: `${language}/${style}/${id}`,
        language,
        program: buildTraceCompileProgram(testCase, language, style) as any,
      }))
    );
  });

  const rejected = named('false pass: a program a fresh Submit rejects never passes after a traced Run');
  const rejectedPrograms = programs(['ses-restricted-tagged-template']);
  if (rejectedPrograms.length !== 6) rejected.violations.push(`expected 6 programs, got ${rejectedPrograms.length}`);
  for (const { label, language, program } of rejectedPrograms) {
    const { fresh, run } = await histories(rejected, label, language, program);
    if (fresh.status !== 'compile-failed') rejected.violations.push(`${label}: a fresh Submit should fail to compile`);
    if (run.cases.some(passes)) rejected.violations.push(`${label}: the Run passed a program a fresh Submit rejects`);
    same(rejected, `${label}: the Run itself`, run, fresh);
  }

  const accepted = named('false failure: a program a fresh Submit passes still passes after a traced Run');
  const acceptedPrograms = programs(['hashbang', 'top-level-window', 'top-level-worker-class', 'top-level-process', 'top-level-console']);
  if (acceptedPrograms.length !== 30) accepted.violations.push(`expected 30 programs, got ${acceptedPrograms.length}`);
  for (const { label, language, program } of acceptedPrograms) {
    const { fresh, run } = await histories(accepted, label, language, program);
    if (fresh.cases.length !== 3 || !fresh.cases.every(passes)) accepted.violations.push(`${label}: a fresh Submit should pass`);
    for (const result of run.cases) {
      if (result.failure?.stage === 'compile') accepted.violations.push(`${label}: Run case ${result.caseId} is a compile error`);
    }
    accepted.compared += 1;
    const untraced = (evaluation: any) => JSON.stringify(evaluation.cases.filter((result: any) => result.caseId !== '1').map(answer));
    if (untraced(run) !== untraced(fresh)) accepted.violations.push(`${label}: the Run's untraced cases are not a fresh Submit's`);
  }

  const receipts = named('receipts: a compile error keeps its fresh-host receipt after a traced Run');
  for (const { label, language, program } of programs(['octal-literal', 'with-statement'])) {
    const { fresh, run } = await histories(receipts, label, language, program);
    if (fresh.status === 'compile-failed') same(receipts, `${label}: the Run itself`, run, fresh);
  }

  const warmFirst = named('warm-up first: a traced warm-up as the first request, then Submit of function process(n)');
  for (const language of LANGUAGES) {
    const program = {
      code: language === 'typescript'
        ? 'function process(n: number): number {\n  return n * 2;\n}'
        : 'function process(n) {\n  return n * 2;\n}',
      functionName: 'process',
      executionStyle: 'function',
      cases: [1, 2, 3].map((n) => ({ id: String(n), input: { n }, expected: n * 2 })),
      policy: allCasesPassPolicy(),
    };
    const { fresh } = await histories(warmFirst, `${language}/process`, language, program);
    if (!fresh.cases.length || !fresh.cases.every(passes)) warmFirst.violations.push(`${language}: a fresh Submit should pass`);
  }

  const options = named('trace options: no advertised control, alone or together, and no unknown key changes the untraced route');
  for (const language of LANGUAGES) {
    const advertised = Object.entries(getLanguageRuntimeProfile(language).capabilities.tracing.controls)
      .filter(([, supported]) => supported)
      .map(([key]) => {
        if (!Object.hasOwn(CONTROL_VALUES, key)) options.violations.push(`${language}: no test value for control ${key}`);
        return [key, CONTROL_VALUES[key]] as const;
      });
    const sets: Array<readonly [string, object]> = [
      ...advertised.map(([key, value]) => [key, { [key]: value }] as const),
      ['every advertised control', Object.fromEntries(advertised)],
      ...Object.entries(APP_BUDGETS),
      ['unknown key', { notATraceControl: 1 }],
    ];
    const traced = buildTraceCompileProgram({}, language, 'function') as any;
    // Only the SES route passes the first and rejects the second.
    const probes = [
      ...programs(['top-level-process']),
      ...programs(['ses-restricted-tagged-template']),
    ].filter((probe) => probe.language === language && probe.program.executionStyle === 'function');
    if (probes.length !== 2) options.violations.push(`${language}: expected 2 probes, got ${probes.length}`);
    const fresh: any[] = [];
    for (const probe of probes) fresh.push(await onHost((host) => submit(host, language, probe.program)));
    for (const [name, traceOptions] of sets) {
      await onHost(async (host) => {
        try {
          await tracedRun(host, language, traced, traceOptions, ['2']);
        } catch (error) {
          if (name !== 'unknown key') options.violations.push(`${language}/${name}: traced Run threw ${String(error)}`);
        }
        for (const [index, probe] of probes.entries()) {
          same(options, `${language}/${name}: ${probe.label}`, await submit(host, language, probe.program), fresh[index]);
        }
      });
    }
  }
  // Untraced Submit sends a batch to compatibility workers when a case
  // outgrows the pool's console, and keeps the program there (stop-mode
  // Submit: every later case too). A Run equals that Submit of the same cases.
  const consoleCheck = named('bounded console preserves the ordinary answer across Run and Submit');
  const noisyPrograms = {
    process: {
      javascript: 'function process(n) {\n  for (let i = 0; i < n; i++) console.log(i);\n  return n;\n}',
      typescript: 'function process(n: number): number {\n  for (let i = 0; i < n; i++) console.log(i);\n  return n;\n}',
      functionName: 'process',
    },
    window: {
      javascript: 'const window = [];\nfunction solve(n) {\n  for (let i = 0; i < n; i++) console.log(i);\n  return n;\n}',
      typescript: 'const window: number[] = [];\nfunction solve(n: number): number {\n  for (let i = 0; i < n; i++) console.log(i);\n  return n;\n}',
      functionName: 'solve',
    },
  } as const;
  // The quiet case's localeCompare distinguishes the profiles if a noisy
  // sibling changes its selected route.
  const UNPRINTABLE = "const bad = { toJSON() { throw new Error('no json'); }, toString() { throw new Error('no string'); } };";
  const witnessBody = (noisy: string) => ({
    javascript: `function solve(n) {\n  if (n === 1) {\n    ${noisy}\n  }\n  return 'ä'.localeCompare('z');\n}`,
    typescript: `function solve(n: number): number {\n  if (n === 1) {\n    ${noisy}\n  }\n  return 'ä'.localeCompare('z');\n}`,
    functionName: 'solve',
  });
  const witnesses = {
    // The learner's code fails after filling the console.
    'fails after 100 lines': witnessBody("for (let i = 0; i < 100; i++) console.log(i);\n    throw new Error('boom');"),
    // One short line that ends in the pool's truncation marker.
    'logs the truncation marker': witnessBody("console.log('…[truncated]');"),
    // An argument that cannot be printed is handled by the bounded capture.
    '99 lines, then an unprintable argument': witnessBody(`${UNPRINTABLE}\n    for (let i = 0; i < 99; i++) console.log(i);\n    try { console.log(bad); } catch (error) { }`),
    '40 arguments, then an unprintable one': witnessBody(`${UNPRINTABLE}\n    try { console.log(...Array.from({ length: 40 }, (_, i) => i), bad); } catch (error) { }`),
    '100 unprintable lines': witnessBody(`${UNPRINTABLE}\n    for (let i = 0; i < 100; i++) { try { console.log(bad); } catch (error) { } }`),
  } as const;
  const pastTraceBudget = witnessBody('for (let i = 0; i < 1500; i++) console.log(i);');
  for (const language of LANGUAGES) {
    for (const [name, source] of [...Object.entries(noisyPrograms), ...Object.entries(witnesses)]) {
      const isWitness = Object.hasOwn(witnesses, name);
      for (const [order, ns] of (isWitness
        ? [['noisy first', [1, 2]], ['noisy last', [2, 1]]]
        : [['noisy first', [100, 1]], ['noisy last', [1, 100]]]) as ReadonlyArray<readonly [string, readonly number[]]>) {
        const program = {
          code: source[language],
          functionName: source.functionName,
          executionStyle: 'function',
          cases: ns.map((n, index) => ({ id: String(index + 1), input: { n }, expected: n })),
          policy: allCasesPassPolicy(),
        };
        const fresh = await onHost(async (host) => ({
          stop: (await host.evaluateAlgorithm({ bundle: await bundle(language, program), stopAtFirstRunaway: true })).evaluation as any,
          batch: (await host.evaluateAlgorithm({ bundle: await bundle(language, program) })).evaluation as any,
        }));
        for (const [optionsName, traceOptions] of [['app budgets', budgets], ['no trace options', {}]] as const) {
          for (const tracedId of ['1', '2']) {
            for (const shape of ['one case at a time', 'one batch'] as const) {
              const label = `${language}/${name}/${order}/${optionsName}/case ${tracedId} traced/${shape}`;
              const truth = shape === 'one case at a time' ? fresh.stop : fresh.batch;
              const run = await onHost(async (host) => {
                const started = await host.execute({
                  bundle: await bundle(language, program, traceOptions),
                  ...(shape === 'one case at a time' ? { interactive: true } : {}),
                  tracing: { caseIds: [tracedId] },
                });
                if (started.executionId) await host.disposeExecution(started.executionId);
                return started.evaluation as any;
              });
              consoleCheck.compared += 1;
              if (truth.status === 'compile-failed' || run.status === 'compile-failed') {
                if (canonical(run) !== canonical(truth)) consoleCheck.violations.push(`${label}: ${canonical(run).slice(0, 200)} != Submit ${canonical(truth).slice(0, 200)}`);
                continue;
              }
              for (const result of run.cases) {
                const expected = truth.cases.find((entry: any) => entry.caseId === result.caseId);
                const same = JSON.stringify(answer(result)) === JSON.stringify(answer(expected));
                if (!same) {
                  consoleCheck.violations.push(`${label}: case ${result.caseId} ${JSON.stringify(answer(result)).slice(0, 160)} != Submit ${JSON.stringify(answer(expected)).slice(0, 160)}`);
                }
              }
            }
          }
        }
      }
    }
  }

  const residual = named('a trace cutoff and a bounded console preserve both ordinary rows');
  for (const language of LANGUAGES) {
    const program = {
      code: pastTraceBudget[language],
      functionName: pastTraceBudget.functionName,
      executionStyle: 'function',
      cases: [{ id: '1', input: { n: 1 }, expected: 1 }, { id: '2', input: { n: 2 }, expected: 2 }],
      policy: allCasesPassPolicy(),
    };
    const stop = await onHost(async (host) =>
      (await host.evaluateAlgorithm({ bundle: await bundle(language, program) })).evaluation as any);
    const alone = await onHost(async (host) =>
      (await host.evaluateAlgorithm({ bundle: await bundle(language, { ...program, cases: program.cases.slice(1) }) })).evaluation as any);
    const run = await onHost(async (host) => {
      return (await host.execute({ bundle: await bundle(language, program, budgets), tracing: { caseIds: ['1'] } })).evaluation as any;
    });
    residual.compared += 1;
    const at = (evaluation: any, id: string) => JSON.stringify(answer(evaluation.cases.find((result: any) => result.caseId === id)));
    const selected = run.cases.find((result: any) => result.caseId === '1');
    if (selected?.attachment?.status !== 'truncated' || selected.status !== 'completed' ||
        at(run, '1') !== at(stop, '1')) {
      residual.violations.push(`${language}: trace cutoff changed the selected ordinary row`);
    }
    if (at(run, '2') !== at(alone, '2')) residual.violations.push(`${language}: the untraced sibling left the pool: ${at(run, '2')}`);
    if (at(stop, '2') !== at(alone, '2')) residual.violations.push(`${language}: Submit moved the sibling off the pool`);
  }

  if (settings.runaway) {
    // A traced case that hit a limit already has its answer: no second run,
    // even with a console at the pool's budget.
    const once = named('runaway: no traced case a limit stopped is asked of the pool, and each is timed once');
    // Which deadline released Run, read from the receipt and the trusted Judge
    // journal rather than the clock.
    const released = named('runaway: the ordinary deadline releases Run; a step cut keeps its prefix');
    const neighbours = named('runaway: after an expired observer, redraw, click draw, the next Run and Submit on the same host stay correct');
    type JournalEvent = { phase: string; evaluationId: string; caseId?: string; attemptToken?: string };
    const journal: JournalEvent[] = [];
    const bridgeKey = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
    Object.defineProperty(globalThis, bridgeKey, {
      configurable: true,
      value: { onEvent: (event: JournalEvent) => { journal.push(event); } },
    });
    const phasesOf = (evaluationId: string | undefined, from: number) =>
      journal.slice(from).filter((event) => event.evaluationId === evaluationId);
    const limitMs = 1500;
    const runaways = [
      // No line events inside the regex, so only the clock stops it.
      ['time limit', 'timed-out', 'for (let i = 0; i < 200; i++) console.log(i);\n  return /^(a+)+$/.test("a".repeat(40 + n) + "b") ? 1 : n;'],
      // The app's single-line budget stops these first: never asked of the pool.
      ['step limit', undefined, 'for (let i = 0; i < 200; i++) console.log(i);\n  while (n > -1) { n += 1; }\n  return n;'],
      ['printing loop', undefined, 'while (true) console.log(n);'],
    ] as const;
    try {
      for (const language of LANGUAGES) {
        for (const [kind, status, body] of runaways) {
          const program = {
            code: language === 'typescript' ? `function solve(n: number): number {\n  ${body}\n}` : `function solve(n) {\n  ${body}\n}`,
            functionName: 'solve',
            executionStyle: 'function',
            limits: { wallClockMs: limitMs },
            cases: [{ id: '1', input: { n: 1 }, expected: 1 }, { id: '2', input: { n: 0 }, expected: 0 }],
            policy: allCasesPassPolicy(),
          };
          const label = `${language}/${kind}`;
          await onHost(async (host) => {
            await submit(host, language, warmUpFor(language));
            const from = journal.length;
            const startedAt = performance.now();
            const started = await host.execute({ bundle: await bundle(language, program, budgets), interactive: true, tracing: { caseIds: ['1'] } });
            const elapsed = performance.now() - startedAt;
            const traced = (started.evaluation as any).cases.find((result: any) => result.caseId === '1');
            once.compared += 1;
            if (status && traced?.status !== status) once.violations.push(`${label}: the traced case should be ${status}, got ${traced?.status}`);
            if (!status && traced?.status === 'completed') once.violations.push(`${label}: the traced case should stop at a limit`);
            if (elapsed > limitMs * 1.8) once.violations.push(`${label}: the Run took ${Math.round(elapsed)} ms for one ${limitMs} ms limit`);
            // 0.21 grades from the untraced ordinary run, which no line budget
            // stops: a loop's verdict exists only at its 1,500 ms clock. The
            // drawing's step cut is the receipt's attachment, checked below.

            released.compared += 1;
            const attachment = traced?.attachment;
            const events = phasesOf(attachment?.evaluationId, from);
            const phases = events.map(({ phase }) => phase);
            const expired = events.filter(({ phase, caseId }) => phase === 'observer-expire' && caseId === '1');
            const clockStopped = traced?.failure?.origin === 'limit' && traced.failure.reason === 'client-timeout';
            if (!clockStopped) released.violations.push(`${label}: the ordinary row should be limit/client-timeout, got ${JSON.stringify(traced?.failure)}`);
            if (status) {
              if (attachment?.status !== 'refused' || attachment.reason !== 'observer-timeout') {
                released.violations.push(`${label}: expected refused/observer-timeout, got ${JSON.stringify(attachment).slice(0, 120)}`);
              }
              const order = ['ordinary-commit', 'observer-expire', 'attachment-bind', 'public-resolve'].map((phase) => phases.indexOf(phase));
              if (expired.length !== 1 || order.some((at, index) => at < 0 || (index > 0 && at < order[index - 1]!))) {
                released.violations.push(`${label}: the ordinary deadline did not release Run: ${phases.join(' > ')}`);
              }
            } else {
              if (attachment?.status !== 'truncated') {
                released.violations.push(`${label}: the step cut's prefix should be kept, got ${JSON.stringify(attachment).slice(0, 120)}`);
              }
              if (expired.length) released.violations.push(`${label}: a delivered prefix was expired: ${phases.join(' > ')}`);
            }

            if (!status || !started.executionId) {
              if (started.executionId) await host.disposeExecution(started.executionId);
              return;
            }
            neighbours.compared += 1;
            const fail = (message: string) => neighbours.violations.push(`${label}: ${message}`);
            const expiredToken = expired[0]?.attemptToken;
            try {
              // Redraw of the timed-out case returns the settled refusal.
              let mark = journal.length;
              const redraw = (await host.execute({ executionId: started.executionId, tracing: { caseIds: ['1'] } })).evaluation as any;
              const redrawn = redraw.cases[0];
              if (JSON.stringify(redrawn?.attachment) !== JSON.stringify(attachment)) fail(`redraw changed the attachment: ${JSON.stringify(redrawn?.attachment)}`);
              if (JSON.stringify(answer(redrawn)) !== JSON.stringify(answer(traced))) fail('redraw changed the ordinary row');
              let after = phasesOf(attachment?.evaluationId, mark);
              if (after.some(({ phase }) => phase === 'observer-start')) fail('redraw re-observed the timed-out case');
              if (!after.some(({ phase, attemptToken }) => phase === 'observation-cache-hit' && attemptToken === expiredToken)) {
                fail(`redraw was not a cache hit of the expired attempt: ${after.map(({ phase }) => phase).join(' > ')}`);
              }
              // Click draw on the stopped suffix: refused as not run, no observer.
              mark = journal.length;
              const suffix = ((await host.execute({ executionId: started.executionId, tracing: { caseIds: ['2'] } })).evaluation as any).cases[0];
              if (suffix?.status !== 'not-run' || suffix.attachment?.reason !== 'case-not-run') fail(`stopped suffix: ${JSON.stringify(suffix?.attachment)}`);
              after = phasesOf(attachment?.evaluationId, mark);
              if (after.some(({ phase }) => phase === 'observer-start')) fail('click draw observed the stopped suffix');
            } finally {
              await host.disposeExecution(started.executionId);
            }
            // The next Run on the same host prepares its own observer and draws.
            const healthy = warmUpFor(language);
            let mark = journal.length;
            const next = await host.execute({ bundle: await bundle(language, healthy, budgets), interactive: true, tracing: { caseIds: [healthy.cases[0].id] } });
            try {
              const row = (next.evaluation as any).cases[0];
              const nextEvents = phasesOf(row?.attachment?.evaluationId, mark);
              const starts = nextEvents.filter(({ phase }) => phase === 'observer-start');
              if (row?.attachment?.status !== 'drawn') fail(`next Run: expected a drawing, got ${JSON.stringify(row?.attachment).slice(0, 120)}`);
              if (!passes(row)) fail(`next Run: the healthy case should pass, got ${JSON.stringify(answer(row)).slice(0, 160)}`);
              if (starts.length !== 1 || starts[0]?.attemptToken === expiredToken) fail('next Run reused the expired attempt');
              if (row?.attachment?.evaluationId === attachment?.evaluationId) fail('next Run reused the expired evaluation');
              // Its redraw is a cache hit of its own attempt.
              mark = journal.length;
              const redraw = ((await host.execute({ executionId: next.executionId!, tracing: { caseIds: [row.caseId] } })).evaluation as any).cases[0];
              if (JSON.stringify(redraw?.attachment) !== JSON.stringify(row?.attachment)) fail('next Run redraw changed the drawing');
              if (phasesOf(row?.attachment?.evaluationId, mark).some(({ phase }) => phase === 'observer-start')) fail('next Run redraw re-observed');
            } finally {
              if (next.executionId) await host.disposeExecution(next.executionId);
            }
            // Submit on the same host grades the runaway exactly as the Run did.
            const graded = await submit(host, language, program);
            const gradedFirst = graded.cases.find((result: any) => result.caseId === '1');
            if (gradedFirst?.status !== traced?.status || JSON.stringify(gradedFirst?.failure) !== JSON.stringify(traced?.failure)) {
              fail(`Submit graded case 1 ${JSON.stringify([gradedFirst?.status, gradedFirst?.failure])}, Run ${JSON.stringify([traced?.status, traced?.failure])}`);
            }
            if (graded.cases.some((result: any) => result.attachment !== undefined)) fail('Submit carried an attachment');
            const fresh = await submit(host, language, healthy);
            if (!fresh.cases.every(passes)) fail('a healthy Submit after the runaway did not pass');
          });
        }
      }
    } finally {
      delete (globalThis as Record<symbol, unknown>)[bridgeKey];
    }
  }
  return checks;
}
