// Browser entry for the cross-version release diff (tests/test-release-diff-catalog.ts).
// It is bundled once per Harness revision with `tracecode-harness-under-test` aliased to that
// revision's package root, so it may only use API that 0.17.1 and 0.20.x both export.
// Everything is typed loosely on purpose: result fields are recorded raw and normalized offline.
import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from 'tracecode-harness-under-test/judge';
import { getLanguageRuntimeProfile } from 'tracecode-harness-under-test/tracekernel';

type Json = any;

export interface ReleaseDiffFixture {
  id: string;
  language: string;
  code: string;
  functionName: string;
  executionStyle: string;
  comparison: Json;
  limits?: Json;
  /** Desktop Practice Run budgets before the per-language control filter. */
  traceBudget: Record<string, number>;
  submitCases: Json[];
  runCases: Json[];
  /** Target only: main's Submit asks non-Python runtimes to stop at the first runaway case. */
  stopSubmitAtFirstRunaway: boolean;
}

const TRACE_CONTROL_KEYS = [
  'maxTraceSteps', 'maxLineEvents', 'maxSingleLineHits', 'maxStoredEvents',
  'maxTraceBytes', 'maxPathDepth', 'minimalTrace', 'traceProfile',
];

// Mirrors the app's lib/execution/runtime-trace-options.ts on deploy and main.
function supportedTraceOptions(language: string, options: Record<string, number>) {
  const controls = (getLanguageRuntimeProfile as any)(language).capabilities.tracing.controls;
  return Object.fromEntries(TRACE_CONTROL_KEYS.flatMap((key) =>
    controls[key] && options[key] !== undefined ? [[key, options[key]]] : []));
}

function summarizeCase(result: Json) {
  const trace = result.trace as { events?: unknown; exitReason?: unknown; truncated?: unknown } | undefined;
  return {
    status: result.status,
    verdict: result.verdict,
    hasValue: Object.hasOwn(result, 'value'),
    value: result.value,
    failure: result.failure,
    notRun: result.notRun,
    protocolError: result.protocolError,
    timedOut: result.timedOut,
    termination: result.termination,
    diagnostics: result.diagnostics,
    stdout: result.stdout,
    stderr: result.stderr,
    hasTrace: trace !== undefined,
    traceEvents: Array.isArray(trace?.events) ? trace.events.length : undefined,
    traceExitReason: trace?.exitReason,
    traceTruncated: trace?.truncated,
  };
}

function summarizeEvaluation(evaluation: Json) {
  const compile = evaluation.compile;
  return {
    status: evaluation.status,
    compile: compile && {
      status: compile.status,
      failure: compile.failure,
      timedOut: compile.timedOut,
      diagnostics: compile.diagnostics,
      stdout: compile.stdout,
      stderr: compile.stderr,
    },
    caseOrder: (evaluation.cases ?? []).map((result: Json) => result.caseId),
    cases: Object.fromEntries((evaluation.cases ?? []).map((result: Json) => [
      result.caseId, summarizeCase(result),
    ])),
  };
}

function exception(error: unknown) {
  const e = error as Json;
  return {
    exception: {
      name: e?.name,
      tag: e?._tag,
      reason: e?.reason,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function createReleaseDiffRunner(providers: readonly string[]) {
  // Mirrors the app's lib/execution/browser-judge-host.ts (identical on deploy and main).
  const host: Json = (createBrowserJudgeHost as any)({
    assetBaseUrl: '/workers',
    providers,
    cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 },
  });

  async function bundle(fixture: ReleaseDiffFixture, mode: 'submit' | 'run') {
    const trace = mode === 'run';
    const cases = mode === 'run' ? fixture.runCases : fixture.submitCases;
    return (createAlgorithmJudgeBundle as any)({
      id: fixture.id + '-' + mode,
      language: fixture.language,
      code: fixture.code,
      functionName: fixture.functionName,
      executionStyle: fixture.executionStyle,
      trace,
      ...(trace ? { traceOptions: supportedTraceOptions(fixture.language, fixture.traceBudget) } : {}),
      ...(fixture.limits ? { limits: fixture.limits } : {}),
      cases,
      comparison: fixture.comparison,
    });
  }

  // Submit: the app's judgeAlgorithm -> executeWithJudge -> host.evaluateAlgorithm (untraced).
  async function submit(fixture: ReleaseDiffFixture) {
    const started = performance.now();
    try {
      const receipt = await host.evaluateAlgorithm({
        bundle: await bundle(fixture, 'submit'),
        ...(fixture.stopSubmitAtFirstRunaway ? { stopAtFirstRunaway: true } : {}),
      });
      return {
        elapsedMs: Math.round(performance.now() - started),
        verdict: receipt.verdict,
        evaluation: summarizeEvaluation(receipt.evaluation),
      };
    } catch (error) {
      return { elapsedMs: Math.round(performance.now() - started), ...exception(error) };
    }
  }

  // Run: the app's startInteractiveTraceExecution. The initial execute traces the selected
  // (first) case and returns every case's result; the learner then opens the other cases,
  // which the app traces through continuations on the same execution.
  async function run(fixture: ReleaseDiffFixture) {
    const started = performance.now();
    const [first, ...rest] = fixture.runCases.map((c: Json) => c.id as string);
    let executionId: string | undefined;
    try {
      const initial = await host.execute({
        bundle: await bundle(fixture, 'run'),
        interactive: true,
        tracing: { caseIds: [first] },
      });
      executionId = initial.executionId;
      const continuation: Record<string, Json> = {};
      let continuationError: Json;
      if (initial.evaluation.status !== 'compile-failed' && executionId) {
        for (const caseId of rest) {
          try {
            const next = await host.execute({ executionId, tracing: { caseIds: [caseId] } });
            const result = (next.evaluation.cases ?? []).find((c: Json) => c.caseId === caseId);
            continuation[caseId] = result ? summarizeCase(result) : { status: 'missing-case' };
          } catch (error) {
            continuationError = { caseId, ...exception(error) };
            break;
          }
        }
      }
      return {
        elapsedMs: Math.round(performance.now() - started),
        initial: summarizeEvaluation(initial.evaluation),
        continuation,
        ...(continuationError ? { continuationError } : {}),
        hadExecutionId: Boolean(executionId),
      };
    } catch (error) {
      return { elapsedMs: Math.round(performance.now() - started), ...exception(error) };
    } finally {
      if (executionId) await host.disposeExecution(executionId).catch(() => {});
    }
  }

  return {
    submit,
    run,
    dispose: () => host.dispose(),
  };
}

export type ReleaseDiffRunner = ReturnType<typeof createReleaseDiffRunner>;
