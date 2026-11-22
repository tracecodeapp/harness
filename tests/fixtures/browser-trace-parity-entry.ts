import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  isRuntimeProviderError,
  type JudgeAlgorithmLanguage,
  type JudgeAlgorithmReceipt,
  type JudgeCaseResult,
} from '../../src/judge';

export type ParityProblem = Omit<Parameters<typeof createAlgorithmJudgeBundle>[0], 'trace'>;

function summarizeCase(result: JudgeCaseResult) {
  const trace = result.trace as { events?: unknown } | undefined;
  return {
    status: result.status,
    verdict: result.verdict,
    hasValue: Object.hasOwn(result, 'value'),
    value: result.value,
    failure: result.failure,
    notRun: result.notRun,
    protocolError: result.protocolError,
    diagnostics: result.diagnostics,
    stderr: result.stderr,
    traceEvents: Array.isArray(trace?.events) ? trace.events.length : undefined,
  };
}

function summarizeReceipt(receipt: JudgeAlgorithmReceipt) {
  const { evaluation } = receipt;
  const compile = evaluation.compile;
  return {
    status: evaluation.status,
    verdict: receipt.verdict,
    compile: compile && {
      status: compile.status,
      failure: compile.failure,
      diagnostics: compile.diagnostics,
      stdout: compile.stdout,
      stderr: compile.stderr,
    },
    cases: Object.fromEntries(evaluation.cases.map((result) => [
      result.caseId, summarizeCase(result),
    ])),
  };
}

export function createTraceParityRunner(providers: readonly JudgeAlgorithmLanguage[]) {
  const host = createBrowserJudgeHost({
    assetBaseUrl: '/workers',
    providers,
    cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 },
  });

  async function evaluate(problem: ParityProblem, trace: boolean) {
    const bundle = await createAlgorithmJudgeBundle({
      ...problem,
      id: problem.id + (trace ? '-traced' : '-untraced'),
      trace,
    });
    try {
      return { receipt: summarizeReceipt(await host.evaluateAlgorithm({ bundle })) };
    } catch (error) {
      return {
        exception: {
          origin: isRuntimeProviderError(error) ? 'provider' : 'unclassified',
          reason: isRuntimeProviderError(error) ? error.reason : undefined,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  return {
    async run(problem: ParityProblem) {
      const untraced = await evaluate(problem, false);
      const traced = await evaluate(problem, true);
      return { untraced, traced };
    },
    dispose: () => host.dispose(),
  };
}

export type TraceParityRunner = ReturnType<typeof createTraceParityRunner>;
