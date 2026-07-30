import * as Effect from 'effect/Effect';
import {
  createBrowserRuntimeHost,
  type Language,
} from '../../src/browser';
import {
  type JudgeEvaluationResult,
} from '../../src/judge';
import {
  createBrowserRuntimeJudge,
} from '../../src/internal/browser-judge';

export interface BrowserRuntimeEvaluationRequest {
  readonly language: Extract<Language, 'javascript' | 'typescript'>;
  readonly code: string;
  readonly functionName: string;
  readonly inputs: readonly Readonly<Record<string, unknown>>[];
  readonly trace?: boolean;
  readonly maxConcurrency?: number;
}

export function evaluateBrowserRuntime(
  request: BrowserRuntimeEvaluationRequest
): Promise<JudgeEvaluationResult> {
  const sourcePath =
    request.language === 'typescript'
      ? '/workspace/solution.ts'
      : '/workspace/solution.js';
  return Effect.runPromise(
    Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() =>
          createBrowserRuntimeHost({
            assetBaseUrl: '/workers',
            providers: [request.language],
          })
        ),
        (host) => Effect.sync(() => host.dispose())
      ).pipe(
        Effect.flatMap((host) =>
          createBrowserRuntimeJudge({
            host,
            language: request.language,
            binding: {
              sourcePath,
              functionName: request.functionName,
              executionStyle: 'function',
              ...(request.trace ? { trace: true as const } : {}),
            },
          })
        ),
        Effect.flatMap((judge) =>
          judge.evaluate({
            id: `${request.language}-authority-browser`,
            runtime: request.language,
            workspace: {
              cwd: '/workspace',
              files: [{
                path: sourcePath,
                contents: request.code,
                visibility: 'submission',
              }],
            },
            driver: { files: [] },
            run: {
              command: 'runtime-provider-case',
              timeoutMs: 20_000,
            },
            cases: request.inputs.map((input, index) => ({
              id: `case-${index + 1}`,
              input,
            })),
            isolation: {
              mode: 'fresh-session-per-case',
              maxConcurrency: request.maxConcurrency ?? 1,
            },
          })
        )
      )
    )
  );
}
