import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  isRuntimeProviderError,
  type JudgeAlgorithmLanguage,
  type JudgeAlgorithmReceipt,
  type JudgeCaseResult,
  type JudgeEvaluationResult,
} from '../../src/judge';

export type ParityProblem = Omit<Parameters<typeof createAlgorithmJudgeBundle>[0], 'trace'>;

function summarizeCase(result: JudgeCaseResult) {
  const trace = result.trace as { events?: Array<{ kind: string; line?: number }> } | undefined;
  const executableLines = trace?.events?.filter(({ kind, line }) =>
    ['line', 'write', 'return'].includes(kind) && Number.isInteger(line) && line! > 0
  ).map(({ line }) => line!);
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
    executableLines: executableLines ? [...new Set(executableLines)].sort((a, b) => a - b) : undefined,
  };
}

function summarizeEvaluation(evaluation: JudgeEvaluationResult) {
  const compile = evaluation.compile;
  return {
    status: evaluation.status,
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

function summarizeReceipt(receipt: JudgeAlgorithmReceipt) {
  return { ...summarizeEvaluation(receipt.evaluation), verdict: receipt.verdict };
}

async function capture<T>(operation: () => Promise<T>) {
  try {
    return { receipt: await operation() };
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
    return capture(async () => summarizeReceipt(await host.evaluateAlgorithm({ bundle })));
  }

  async function interactive(problem: ParityProblem) {
    let executionId: string | undefined;
    const run = await capture(async () => {
      const bundle = await createAlgorithmJudgeBundle({
        ...problem, id: problem.id + '-run',
      });
      const initial = await host.execute({
        bundle, interactive: true, tracing: { caseIds: ['selected'] },
      });
      executionId = initial.executionId;
      return summarizeEvaluation(initial.evaluation);
    });
    if (executionId === undefined) return { run, continuation: undefined };
    try {
      const retainedId = executionId;
      const continuation = await capture(async () => {
        const result = await host.execute({
          executionId: retainedId, tracing: { caseIds: ['continuation'] },
        });
        return summarizeEvaluation(result.evaluation);
      });
      return { run, continuation };
    } finally {
      await host.disposeExecution(executionId);
    }
  }

  return {
    async run(problem: ParityProblem) {
      const untraced = await evaluate(problem, false);
      const traced = await evaluate(problem, true);
      return { untraced, traced };
    },
    async runSyntaxParity(problem: ParityProblem) {
      const untraced = await evaluate(problem, false);
      const traced = await evaluate(problem, true);
      return { untraced, traced, ...await interactive(problem) };
    },
    dispose: () => host.dispose(),
  };
}

export type TraceParityRunner = ReturnType<typeof createTraceParityRunner>;
