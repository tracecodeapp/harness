import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';

type BatchLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'csharp'
  | 'cpp';

interface BatchFixture {
  readonly language: BatchLanguage;
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle?: 'function' | 'solution-method';
}

const BATCH_FIXTURES: readonly BatchFixture[] = [
  {
    language: 'python',
    code: [
      'history = []',
      'def solve(value):',
      '    history.append(value)',
      '    return len(history)',
    ].join('\n'),
    functionName: 'solve',
  },
  {
    language: 'javascript',
    code: [
      'const history = [];',
      'function solve(value) {',
      '  history.push(value);',
      '  return history.length;',
      '}',
    ].join('\n'),
    functionName: 'solve',
  },
  {
    language: 'typescript',
    code: [
      'const history: number[] = [];',
      'function solve(value: number): number {',
      '  history.push(value);',
      '  return history.length;',
      '}',
    ].join('\n'),
    functionName: 'solve',
  },
  {
    language: 'java',
    code: [
      'class Solution {',
      '  private static int history = 0;',
      '  public int solve(int value) {',
      '    history += 1;',
      '    return history;',
      '  }',
      '}',
    ].join('\n'),
    functionName: 'solve',
    executionStyle: 'solution-method',
  },
  {
    language: 'csharp',
    code: [
      'public class Solution {',
      '  private static int history = 0;',
      '  public int Solve(int value) {',
      '    history += 1;',
      '    return history;',
      '  }',
      '}',
    ].join('\n'),
    functionName: 'Solve',
    executionStyle: 'solution-method',
  },
  {
    language: 'cpp',
    code: [
      'class Solution {',
      'public:',
      '  int solve(int value) {',
      '    static int history = 0;',
      '    history += 1;',
      '    return history;',
      '  }',
      '};',
    ].join('\n'),
    functionName: 'solve',
    executionStyle: 'solution-method',
  },
] as const;

function receiptSummary(receipt: Awaited<ReturnType<ReturnType<
  typeof createBrowserJudgeHost
>['evaluateAlgorithm']>>): {
  verdict: string;
  evaluationStatus: string;
  caseVerdicts: string[];
  sessionIds: string[];
  outputs: unknown[];
  diagnostics: readonly unknown[];
  compileStdout: string;
  compileStderr: string;
} {
  if (receipt.evaluation.status !== 'completed') {
    return {
      verdict: receipt.verdict,
      evaluationStatus: receipt.evaluation.status,
      caseVerdicts: [],
      sessionIds: [],
      outputs: [],
      diagnostics: receipt.evaluation.compile.diagnostics,
      compileStdout: receipt.evaluation.compile.stdout,
      compileStderr: receipt.evaluation.compile.stderr,
    };
  }
  return {
    verdict: receipt.verdict,
    evaluationStatus: receipt.evaluation.status,
    caseVerdicts: receipt.evaluation.cases.map(
      (testCase) => testCase.verdict.kind
    ),
    sessionIds: receipt.evaluation.cases.map(
      (testCase) => testCase.sessionId
    ),
    outputs: receipt.evaluation.cases.map((testCase) => testCase.value),
    diagnostics: receipt.evaluation.cases.flatMap(
      (testCase) => testCase.diagnostics
    ),
    compileStdout: receipt.evaluation.compile?.stdout ?? '',
    compileStderr: receipt.evaluation.compile?.stderr ?? '',
  };
}

export async function runBrowserAlgorithmBatch(
  assetBaseUrl: string,
  selectedLanguages: readonly BatchLanguage[] = BATCH_FIXTURES.map(
    (fixture) => fixture.language
  )
): Promise<unknown> {
  const NativeWorker = globalThis.Worker;
  const workerUrls: string[] = [];
  const workerCommands: Array<{
    type?: string;
    runtimeRole?: string;
    preparedMode?: string;
    preparedFunctionName?: string;
    inputs?: unknown;
  }> = [];
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      workerUrls.push(String(url));
      super(url, options);
      const nativePostMessage = this.postMessage.bind(this);
      this.postMessage = ((
        message: {
          type?: string;
          payload?: {
            runtimeRole?: string;
            prepared?: { mode?: string; functionName?: string };
            inputs?: unknown;
          };
        },
        transferOrOptions?: StructuredSerializeOptions | Transferable[]
      ) => {
        workerCommands.push({
          type: message?.type,
          runtimeRole: message?.payload?.runtimeRole,
          preparedMode: message?.payload?.prepared?.mode,
          preparedFunctionName: message?.payload?.prepared?.functionName,
          inputs: message?.payload?.inputs,
        });
        nativePostMessage(message, transferOrOptions as Transferable[]);
      }) as typeof this.postMessage;
    }
  }
  globalThis.Worker = ObservedWorker;

  const results: Record<string, unknown> = {};
  try {
    for (const fixture of BATCH_FIXTURES.filter((candidate) =>
      selectedLanguages.includes(candidate.language)
    )) {
      const host = createBrowserJudgeHost({
        assetBaseUrl,
        providers: [fixture.language],
        safeExecution: {
          prewarmAfterUse: false,
        },
      });
      try {
        let trustedPrewarm = false;
        if (fixture.language === 'csharp') {
          const deadline = performance.now() + 30_000;
          while (
            !workerCommands.some(
              (command) =>
                command.type === 'execute-prepared-code' &&
                command.runtimeRole === 'runner' &&
                command.preparedMode === 'trace' &&
                command.preparedFunctionName === 'Add' &&
                JSON.stringify(command.inputs) === '{"a":1,"b":2}'
            )
          ) {
            if (performance.now() >= deadline) {
              throw new Error(
                'C# public Judge provider did not complete its fixed trusted standby-runner prime.'
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          trustedPrewarm = true;
        }
        const cases = Array.from({ length: 10 }, (_, index) => ({
          id: `case-${index + 1}`,
          input: { value: index + 1 },
          expected: 1,
        }));
        const plainBundle = await createAlgorithmJudgeBundle({
          id: `browser-${fixture.language}-isolated-batch`,
          language: fixture.language,
          code: fixture.code,
          functionName: fixture.functionName,
          ...(fixture.executionStyle
            ? { executionStyle: fixture.executionStyle }
            : {}),
          cases,
        });
        const plainReceipt = await host.evaluateAlgorithm({
          bundle: plainBundle,
        });
        const plainWorkerUrls = workerUrls.splice(0);

        const traceBundle = await createAlgorithmJudgeBundle({
          id: `browser-${fixture.language}-isolated-trace-batch`,
          language: fixture.language,
          code: fixture.code,
          functionName: fixture.functionName,
          ...(fixture.executionStyle
            ? { executionStyle: fixture.executionStyle }
            : {}),
          cases,
          trace: true,
        });
        const traceReceipt = await host.evaluateAlgorithm({
          bundle: traceBundle,
        });
        const traceWorkerUrls = workerUrls.splice(0);

        results[fixture.language] = {
          plain: receiptSummary(plainReceipt),
          plainWorkerUrls,
          trace: receiptSummary(traceReceipt),
          traceWorkerUrls,
          ...(fixture.language === 'csharp' ? { trustedPrewarm } : {}),
        };
      } finally {
        host.dispose();
      }
    }
    return results;
  } finally {
    globalThis.Worker = NativeWorker;
  }
}
