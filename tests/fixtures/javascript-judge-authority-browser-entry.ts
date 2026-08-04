import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  type JudgeEvaluationResult,
} from '../../src/judge';
import type { Language } from '../../src/browser';

export interface BrowserRuntimeEvaluationRequest {
  readonly language: Extract<Language, 'javascript' | 'typescript'>;
  readonly code: string;
  readonly functionName: string;
  readonly inputs: readonly Readonly<Record<string, unknown>>[];
  readonly trace?: boolean;
  readonly limits?: {
    readonly wallClockMs?: number;
  };
}

export function evaluateBrowserRuntime(
  request: BrowserRuntimeEvaluationRequest
): Promise<JudgeEvaluationResult> {
  const host = createBrowserJudgeHost({
    assetBaseUrl: '/workers',
    providers: [request.language],
  });
  return (async () => {
    try {
      const bundle = await createAlgorithmJudgeBundle({
        id: `${request.language}-authority-browser`,
        language: request.language,
        code: request.code,
        functionName: request.functionName,
        executionStyle: 'function',
        cases: request.inputs.map((input, index) => ({
          id: `case-${index + 1}`,
          input,
        })),
        ...(request.trace ? { trace: true as const } : {}),
        ...(request.limits ? { limits: request.limits } : {}),
      });
      return (await host.evaluateAlgorithm({ bundle })).evaluation;
    } finally {
      host.dispose();
    }
  })();
}
