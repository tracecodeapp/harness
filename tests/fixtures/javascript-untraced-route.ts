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

export async function runUntracedRouteChecks(createHost: () => BrowserJudgeHost): Promise<UntracedRouteCheck[]> {
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
  return checks;
}
