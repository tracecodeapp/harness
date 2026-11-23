// The untraced answer is the truth on whether a program compiles.
//
// For every program this runs untraced Submit, an interactive Run (case 1
// traced), its continuation (case 2 traced) and a traced Submit through a
// Judge host, and requires:
// - untraced does not compile: every action reports exactly the untraced
//   answer, with no trace and no marker;
// - untraced compiles: a traced case gives the untraced answer and either a
//   drawing or a typed refusal independent of the grade;
// - the untraced cases of a Run always equal untraced Submit's.
//
// Shared by the Node test and the Chromium test.

import {
  createAlgorithmJudgeBundle,
  judgeCaseExecutionOutcome,
  type BrowserJudgeHost,
} from '../../src/judge';
import {
  buildTraceCompileProgram,
  traceCompileCases,
  TRACE_COMPILE_STYLES,
  type TraceCompileCase,
  type TraceCompileLanguage,
  type TraceCompileStyle,
} from './javascript-trace-compile-cases';

/** Every way a traced build can fail by itself, made to fail on purpose. */
export const TRACE_BUILD_FAULTS = {
  // Re-transpiling instrumented TypeScript fails; for JavaScript, building it does.
  'printer-emits-invalid-code': [
    { file: 'javascript-worker.js', from: 'return printer.printFile(outputFile);', to: "return printer.printFile(outputFile) + '\\n)';" },
  ],
  'instrumenter-throws': [
    { file: 'javascript-worker.js', from: 'const transformed = ts.transform(', to: "throw new SyntaxError('injected instrumenter failure');\n  const transformed = ts.transform(" },
  ],
  // The instrumented program is fine; assembling its runner is not.
  'traced-runner-does-not-build': [
    { file: 'javascript-worker.js', from: '${getTracingRuntimeHelpersSource(maxPathDepth)}', to: '${getTracingRuntimeHelpersSource(maxPathDepth)}\n)' },
    { file: 'javascript-ses-algorithm-worker.js', from: 'const tracePrelude = tracing ?', to: 'const tracePrelude = tracing ? ")" +' },
  ],
} as const;

export type TraceBuildFault = keyof typeof TRACE_BUILD_FAULTS;

export function injectTraceBuildFault(file: string, source: string, fault: TraceBuildFault): string {
  let injected = source;
  for (const edit of TRACE_BUILD_FAULTS[fault]) {
    if (edit.file !== file) continue;
    if (!injected.includes(edit.from)) throw new Error(`Cannot inject ${fault} into ${file}: anchor not found.`);
    injected = injected.split(edit.from).join(edit.to);
  }
  return injected;
}

// The app sends these observation budgets with its traced Run.
const APP_TRACE_BUDGETS = {
  maxTraceSteps: 4_000,
  maxLineEvents: 12_000,
  maxSingleLineHits: 1_000,
  maxStoredEvents: 16_000,
};

const ROUTES = {
  ses: undefined,
  'app-budgets': APP_TRACE_BUDGETS,
} as const;

type Route = keyof typeof ROUTES;

interface CaseObservation {
  id: string;
  answer: Record<string, unknown>;
  events: number;
  refused: boolean;
  attachmentStatus?: string;
  presentation?: string;
  legacyRefusal: boolean;
}

interface EvaluationObservation {
  status: string;
  compile: unknown;
  cases: CaseObservation[];
}

export interface TraceCompileObservation {
  label: string;
  submit: EvaluationObservation;
  run: EvaluationObservation;
  continuation?: EvaluationObservation;
  tracedSubmit: EvaluationObservation;
}

export interface TraceCompileMatrixResult {
  observations: TraceCompileObservation[];
  violations: string[];
  checked: number;
}

export interface TraceCompileMatrixOptions {
  createHost(fault?: TraceBuildFault): BrowserJudgeHost;
  languages?: readonly string[];
  styles?: readonly string[];
  cases?: readonly string[];
  routes?: readonly string[];
}

function plain(value: unknown): any {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Key-order-free text of a JSON value. */
function canonical(value: unknown): string {
  return JSON.stringify(plain(value), (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1)))
      : entry
  ) ?? 'undefined';
}

function observe(evaluation: any, language: TraceCompileLanguage): EvaluationObservation {
  const compile = evaluation.compile;
  return {
    status: evaluation.status,
    compile: plain(compile && {
      status: compile.status,
      failure: compile.failure,
      diagnostics: compile.diagnostics,
    }),
    cases: evaluation.cases.map((result: any) => {
      const refused = result.attachment?.status === 'refused';
      const presentation = refused
        ? judgeCaseExecutionOutcome(result, { language, trace: true }).kind
        : undefined;
      return {
        id: result.caseId,
        answer: plain({
          status: result.status,
          verdict: result.verdict,
          hasValue: Object.prototype.hasOwnProperty.call(result, 'value'),
          value: result.value,
          failure: result.failure,
          diagnostics: result.diagnostics,
          notRun: result.notRun,
          stdout: result.stdout,
        }),
        events: result.trace?.events?.length ?? 0,
        refused,
        attachmentStatus: result.attachment?.status,
        presentation,
        legacyRefusal: Boolean(result.diagnostics?.some((entry: any) => entry.code === 'trace-unavailable')),
      };
    }),
  };
}

async function observeActions(
  host: BrowserJudgeHost,
  testCase: TraceCompileCase,
  language: TraceCompileLanguage,
  style: TraceCompileStyle,
  route: Route,
  label: string
): Promise<TraceCompileObservation> {
  const program = buildTraceCompileProgram(testCase, language, style);
  const bundle = (trace: boolean) => createAlgorithmJudgeBundle({
    id: `${label}-${trace}`.replace(/[^\w-]/g, '-'),
    language,
    ...program,
    trace,
    ...(trace && ROUTES[route] ? { traceOptions: ROUTES[route] } : {}),
  });
  const submit = observe((await host.evaluateAlgorithm({ bundle: await bundle(false) })).evaluation, language);
  const started = await host.execute({
    bundle: await bundle(true),
    interactive: true,
    tracing: { caseIds: ['1'] },
  });
  const run = observe(started.evaluation, language);
  let continuation: EvaluationObservation | undefined;
  if (started.executionId) {
    try {
      const next = await host.execute({
        executionId: started.executionId,
        tracing: { caseIds: ['2'] },
      });
      continuation = observe(next.evaluation, language);
    } finally {
      await host.disposeExecution(started.executionId);
    }
  }
  const tracedSubmit = observe((await host.evaluateAlgorithm({ bundle: await bundle(true) })).evaluation, language);
  return { label, submit, run, ...(continuation ? { continuation } : {}), tracedSubmit };
}

function check(
  testCase: TraceCompileCase,
  language: TraceCompileLanguage,
  observed: TraceCompileObservation,
  report: (message: string) => void
): void {
  const { submit, run, continuation, tracedSubmit } = observed;
  const submitCompileFailed = submit.status === 'compile-failed';
  const submitPassed = !submitCompileFailed && submit.cases.length === 3 &&
    submit.cases.every(({ answer }) => (answer.verdict as any)?.kind === 'passed');
  const submitRejected = submitCompileFailed ||
    (submit.cases.length === 3 && submit.cases.every(({ answer }) => (answer.failure as any)?.origin === 'program'));
  if (testCase.untraced === 'passes' && !submitPassed) {
    report(`untraced Submit should pass: ${canonical(submit).slice(0, 400)}`);
  }
  if (testCase.untraced === 'rejects' && !submitRejected) {
    report(`untraced Submit should reject: ${canonical(submit).slice(0, 400)}`);
  }

  const actions = [
    { name: 'Run', evaluation: run, caseIds: ['1', '2', '3'], tracedIds: ['1'] },
    ...(continuation ? [{ name: 'continuation', evaluation: continuation, caseIds: ['2'], tracedIds: ['2'] }] : []),
    { name: 'traced Submit', evaluation: tracedSubmit, caseIds: ['1', '2', '3'], tracedIds: ['1', '2', '3'] },
  ];
  if (!submitCompileFailed && !continuation) report('the Run was not retained, so it has no continuation');

  for (const { name, evaluation, caseIds, tracedIds } of actions) {
    if (evaluation.status !== submit.status || canonical(evaluation.compile) !== canonical(submit.compile)) {
      report(`${name}: receipt ${canonical([evaluation.status, evaluation.compile])} != untraced Submit ${canonical([submit.status, submit.compile])}`);
      continue;
    }
    if (submitCompileFailed) {
      if (canonical(evaluation.cases) !== canonical(submit.cases)) {
        report(`${name}: a compile-failed receipt's cases differ from untraced Submit's`);
      }
      continue;
    }
    if (evaluation.cases.map(({ id }) => id).sort().join() !== caseIds.join()) {
      report(`${name}: cases ${evaluation.cases.map(({ id }) => id)} instead of ${caseIds}`);
      continue;
    }
    for (const actual of evaluation.cases) {
      const where = `${name} case ${actual.id}`;
      const truth = submit.cases.find(({ id }) => id === actual.id);
      if (!truth) {
        report(`${where}: untraced Submit has no such case`);
        continue;
      }
      const same = canonical(actual.answer) === canonical(truth.answer);
      const notTheUntracedAnswer = `${where}: ${canonical(actual.answer).slice(0, 300)} != untraced ${canonical(truth.answer).slice(0, 300)}`;
      const truthPassed = (truth.answer.verdict as any)?.kind === 'passed';

      if (!same) report(notTheUntracedAnswer);
      if (actual.legacyRefusal) report(`${where}: emitted a legacy trace-unavailable diagnostic`);
      if (!tracedIds.includes(actual.id)) {
        if (actual.events || actual.attachmentStatus) report(`${where}: an unselected case has an attachment`);
      } else if (actual.refused) {
        if (truthPassed && !testCase.traced) report(`${where}: refused, but this program must be traced`);
        if (actual.events) report(`${where}: a refusal has a trace`);
        if (actual.presentation !== 'trace-refused' && actual.presentation !== 'not-run') {
          report(`${where}: incorrect refusal presentation ${actual.presentation}`);
        }
      } else {
        if (truthPassed && testCase.traced === 'refused') report(`${where}: should have been refused`);
        if (truthPassed && !actual.events) report(`${where}: passed traced with no trace`);
      }
    }
  }
}

export async function runTraceCompileMatrix(options: TraceCompileMatrixOptions): Promise<TraceCompileMatrixResult> {
  const result: TraceCompileMatrixResult = { observations: [], violations: [], checked: 0 };
  const selected = <T extends string>(all: readonly T[], requested: readonly string[] | undefined): T[] =>
    all.filter((value) => !requested?.length || requested.includes(value));
  const languages = selected<TraceCompileLanguage>(['javascript', 'typescript'], options.languages);
  const styles = selected(TRACE_COMPILE_STYLES, options.styles);
  const wanted = (id: string) => !options.cases?.length || options.cases.includes(id);

  // A refusal must not depend on which step failed, and a learner compile
  // error must win over a traced build that fails as well.
  const base = (id: string) => traceCompileCases.find((testCase) => testCase.id === id)!;
  const groups: Array<{ fault?: TraceBuildFault; cases: readonly TraceCompileCase[] }> = [
    { cases: traceCompileCases.filter(({ id }) => wanted(id)) },
    ...(Object.keys(TRACE_BUILD_FAULTS) as TraceBuildFault[]).map((fault) => ({
      fault,
      cases: [
        { ...base('plain'), id: `${fault}:valid`, traced: 'refused' as const },
        { ...base('missing-brace'), id: `${fault}:missing-brace` },
        { ...base('duplicate-let'), id: `${fault}:duplicate-let` },
      ].filter(({ id }) => wanted(id) || wanted(fault)),
    })),
  ];

  for (const route of selected(Object.keys(ROUTES) as Route[], options.routes)) {
    for (const { fault, cases } of groups) {
      if (!cases.length) continue;
      const host = options.createHost(fault);
      try {
        if (ROUTES[route]) {
          // Put the host where the app's is after its first traced Run, so
          // untraced Submit and the Run are judged on the same route.
          const primer = buildTraceCompileProgram({}, 'javascript', 'function');
          await host.evaluateAlgorithm({
            bundle: await createAlgorithmJudgeBundle({
              id: `primer-${fault ?? 'none'}`,
              language: 'javascript',
              ...primer,
              trace: true,
              traceOptions: ROUTES[route],
            }),
          });
        }
        for (const testCase of cases) {
          for (const language of languages) {
            if (testCase.languages && !testCase.languages.includes(language)) continue;
            for (const style of styles) {
              if (testCase.styles && !testCase.styles.includes(style)) continue;
              const label = `${route}/${language}/${style}/${testCase.id}`;
              const report = (message: string) => result.violations.push(`${label}: ${message}`);
              try {
                const observed = await observeActions(host, testCase, language, style, route, label);
                result.observations.push(observed);
                check(testCase, language, observed, report);
              } catch (error) {
                report(`threw ${String(error)}`);
              }
              result.checked += 1;
            }
          }
        }
      } finally {
        await host.dispose();
      }
    }
  }
  // Primed and unprimed: what the host ran before cannot change untraced Submit.
  const untraced = new Map(result.observations.map(({ label, submit }) => [label, canonical(submit)]));
  for (const [label, submit] of untraced) {
    if (!label.startsWith('app-budgets/')) continue;
    const unprimed = untraced.get(label.replace('app-budgets/', 'ses/'));
    if (unprimed !== undefined && submit !== unprimed) {
      result.violations.push(`${label}: untraced Submit on a primed host differs from an unprimed host's`);
    }
  }
  return result;
}
