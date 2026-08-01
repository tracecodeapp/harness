import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';

export async function runBrowserAlgorithmBatch(
  assetBaseUrl: string
): Promise<unknown> {
  const NativeWorker = globalThis.Worker;
  const workerUrls: string[] = [];
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      workerUrls.push(String(url));
      super(url, options);
    }
  }
  globalThis.Worker = ObservedWorker;

  const host = createBrowserJudgeHost({
    assetBaseUrl,
    providers: ['python'],
    safeExecution: {
      prewarmAfterUse: false,
    },
  });
  try {
    const code = [
        'history = []',
        'def solve(value):',
        '    history.append(value)',
        '    return len(history)',
      ].join('\n');
    const cases = Array.from({ length: 10 }, (_, index) => ({
        id: `case-${index + 1}`,
        input: { value: index + 1 },
        expected: 1,
      }));
    const plainBundle = await createAlgorithmJudgeBundle({
      id: 'browser-python-isolated-batch',
      language: 'python',
      code,
      functionName: 'solve',
      cases,
    });
    const plainReceipt = await host.evaluateAlgorithm({ bundle: plainBundle });
    const plainWorkerUrls = workerUrls.splice(0);
    const traceBundle = await createAlgorithmJudgeBundle({
      id: 'browser-python-isolated-trace-batch',
      language: 'python',
      code,
      functionName: 'solve',
      cases,
      trace: true,
    });
    const traceReceipt = await host.evaluateAlgorithm({ bundle: traceBundle });
    const traceWorkerUrls = workerUrls.splice(0);
    return {
      verdict: plainReceipt.verdict,
      caseVerdicts:
        plainReceipt.evaluation.status === 'completed'
          ? plainReceipt.evaluation.cases.map((testCase) => testCase.verdict.kind)
          : [],
      sessionIds:
        plainReceipt.evaluation.status === 'completed'
          ? plainReceipt.evaluation.cases.map((testCase) => testCase.sessionId)
          : [],
      plainWorkerUrls,
      traceVerdict: traceReceipt.verdict,
      traceCaseVerdicts:
        traceReceipt.evaluation.status === 'completed'
          ? traceReceipt.evaluation.cases.map((testCase) => testCase.verdict.kind)
          : [],
      traceSessionIds:
        traceReceipt.evaluation.status === 'completed'
          ? traceReceipt.evaluation.cases.map((testCase) => testCase.sessionId)
          : [],
      traceWorkerUrls,
    };
  } finally {
    host.dispose();
    globalThis.Worker = NativeWorker;
  }
}
