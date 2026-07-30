import type {
  RuntimePreparedExecutionProvider,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '@tracecode/runtime-core';
import { CppWorkerClient } from './cpp-worker-client';

export interface CppPreparedExecutionProviderOptions {
  createWorkerClient(): CppWorkerClient;
}

/**
 * Compile-once C++ provider for Judge-backed execution.
 *
 * A prepared program owns one worker for its evaluation lifetime. The worker
 * retains only an immutable WebAssembly.Module; every executeIsolated call
 * creates a fresh WASI instance, memory, and filesystem. maxConcurrency is
 * intentionally one because the worker protocol serializes executions.
 */
export function createCppPreparedExecutionProvider(
  options: CppPreparedExecutionProviderOptions
): RuntimePreparedExecutionProvider {
  let standbyClient: CppWorkerClient | null = null;

  const acquireClient = (): CppWorkerClient => {
    const client = standbyClient ?? options.createWorkerClient();
    standbyClient = null;
    return client;
  };

  return {
    async init() {
      const client = standbyClient ?? options.createWorkerClient();
      try {
        const result = await client.init();
        standbyClient = client;
        return {
          success: result.success,
          loadTimeMs: result.loadTimeMs,
        };
      } catch (error) {
        client.terminate();
        throw error;
      }
    },

    async prepareProgram(
      call: RuntimeProgramPreparationCall
    ): Promise<RuntimeProgramPreparationResult> {
      const client = acquireClient();
      try {
        await client.init();
        const preparation = await client.prepareRuntimeProgram(call);
        // Use an explicit literal comparison here. The declaration bundler
        // type-checks with a different strictness envelope than the package
        // project, and `!preparation.success` does not reliably preserve the
        // discriminated-union branch there.
        if (preparation.success === false) {
          client.terminate();
          if (preparation.limitReason === 'client-timeout') {
            return {
              kind: 'limit',
              reason: 'client-timeout',
              error: preparation.error,
              consoleOutput: preparation.consoleOutput,
              ...(preparation.timings
                ? { timings: preparation.timings }
                : {}),
            };
          }
          return {
            kind: 'failed',
            error: preparation.error,
            consoleOutput: preparation.consoleOutput,
            ...(preparation.errorLine !== undefined
              ? { errorLine: preparation.errorLine }
              : {}),
            ...(preparation.diagnosticStage !== undefined
              ? { diagnosticStage: preparation.diagnosticStage }
              : {}),
            ...(preparation.timings
              ? { timings: preparation.timings }
              : {}),
          };
        }

        let disposed = false;
        const capabilities = {
          caseIsolation: 'fresh-case-state' as const,
          maxConcurrency: 1,
        };
        const dispose = async (): Promise<void> => {
          if (disposed) return;
          disposed = true;
          try {
            await client.disposePreparedProgram(preparation.handle);
          } finally {
            client.terminate();
          }
        };

        return call.mode === 'trace'
          ? {
              kind: 'prepared',
              program: {
                mode: 'trace',
                capabilities,
                executeIsolated: (execution) => {
                  if (disposed) {
                    return Promise.reject(
                      new Error(
                        `C++ prepared program "${preparation.handle.programId}" was already disposed.`
                      )
                    );
                  }
                  return client.executePreparedTrace(
                    preparation.handle,
                    execution
                  );
                },
                dispose,
              },
              consoleOutput: preparation.consoleOutput,
              ...(preparation.timings
                ? { timings: preparation.timings }
                : {}),
            }
          : {
              kind: 'prepared',
              program: {
                mode: 'code',
                capabilities,
                executeIsolated: (execution) => {
                  if (disposed) {
                    return Promise.reject(
                      new Error(
                        `C++ prepared program "${preparation.handle.programId}" was already disposed.`
                      )
                    );
                  }
                  return client.executePreparedCode(
                    preparation.handle,
                    execution
                  );
                },
                dispose,
              },
              consoleOutput: preparation.consoleOutput,
              ...(preparation.timings
                ? { timings: preparation.timings }
                : {}),
            };
      } catch (error) {
        client.terminate();
        throw error;
      }
    },
  };
}
