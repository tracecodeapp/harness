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
    const bundle = await createAlgorithmJudgeBundle({
      id: 'browser-python-isolated-batch',
      language: 'python',
      code: [
        'history = []',
        'def solve(value):',
        '    history.append(value)',
        '    return len(history)',
      ].join('\n'),
      functionName: 'solve',
      cases: Array.from({ length: 10 }, (_, index) => ({
        id: `case-${index + 1}`,
        input: { value: index + 1 },
        expected: 1,
      })),
    });
    const receipt = await host.evaluateAlgorithm({ bundle });
    return {
      verdict: receipt.verdict,
      caseVerdicts:
        receipt.evaluation.status === 'completed'
          ? receipt.evaluation.cases.map((testCase) => testCase.verdict.kind)
          : [],
      sessionIds:
        receipt.evaluation.status === 'completed'
          ? receipt.evaluation.cases.map((testCase) => testCase.sessionId)
          : [],
      workerUrls,
    };
  } finally {
    host.dispose();
    globalThis.Worker = NativeWorker;
  }
}
