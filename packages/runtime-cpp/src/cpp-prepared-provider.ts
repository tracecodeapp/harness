import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedExecutionProvider,
  RuntimePreparedTraceBatchCall,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '@tracecode/runtime-contracts';
import { CppWorkerClient } from './cpp-worker-client';

export interface CppPreparedExecutionProviderOptions {
  createWorkerClient(): CppWorkerClient;
}

export interface CppPreparedExecutionProviderController
  extends RuntimePreparedExecutionProvider {
  /** Retire standby, preparation, and prepared-program workers but allow reuse. */
  reset(): void;
  /** Permanently retire every worker owned by this provider. */
  terminate(): void;
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
): CppPreparedExecutionProviderController {
  let standbyClient: CppWorkerClient | null = null;
  let generation = 0;
  let terminated = false;
  const ownedClients = new Set<CppWorkerClient>();
  const activePrograms = new Set<() => void>();

  const createClient = (): CppWorkerClient => {
    const client = options.createWorkerClient();
    ownedClients.add(client);
    return client;
  };

  const retireClient = (client: CppWorkerClient): void => {
    if (!ownedClients.delete(client)) return;
    if (standbyClient === client) standbyClient = null;
    client.terminate();
  };

  const assertActive = (): void => {
    if (terminated) {
      throw new Error('Prepared C++ execution provider has been terminated.');
    }
  };

  const assertGeneration = (expected: number): void => {
    assertActive();
    if (generation !== expected) {
      throw new Error('Prepared C++ execution provider was reset.');
    }
  };

  const acquireClient = (): CppWorkerClient => {
    assertActive();
    const client = standbyClient ?? createClient();
    standbyClient = null;
    return client;
  };

  return {
    async init() {
      assertActive();
      const expectedGeneration = generation;
      const client = standbyClient ?? createClient();
      try {
        const result = await client.init();
        assertGeneration(expectedGeneration);
        standbyClient = client;
        return {
          success: result.success,
          loadTimeMs: result.loadTimeMs,
        };
      } catch (error) {
        retireClient(client);
        throw error;
      }
    },

    async prepareProgram(
      call: RuntimeProgramPreparationCall
    ): Promise<RuntimeProgramPreparationResult> {
      const expectedGeneration = generation;
      const client = acquireClient();
      try {
        await client.init();
        assertGeneration(expectedGeneration);
        const preparation = await client.prepareRuntimeProgram(call);
        assertGeneration(expectedGeneration);
        // Use an explicit literal comparison here. The declaration bundler
        // type-checks with a different strictness envelope than the package
        // project, and `!preparation.success` does not reliably preserve the
        // discriminated-union branch there.
        if (preparation.success === false) {
          retireClient(client);
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
        const forceDispose = (): void => {
          if (disposed) return;
          disposed = true;
          activePrograms.delete(forceDispose);
          retireClient(client);
        };
        activePrograms.add(forceDispose);
        const capabilities = {
          caseIsolation: 'fresh-case-state' as const,
          maxConcurrency: 1,
        };
        const dispose = async (): Promise<void> => {
          if (disposed) return;
          disposed = true;
          activePrograms.delete(forceDispose);
          try {
            await client.disposePreparedProgram(preparation.handle);
          } finally {
            retireClient(client);
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
                executeBatchIsolated: async (
                  execution: RuntimePreparedTraceBatchCall
                ): Promise<readonly ExecutionResult[]> => {
                  if (disposed) {
                    throw new Error(
                      `C++ prepared program "${preparation.handle.programId}" was already disposed.`
                    );
                  }
                  const results: ExecutionResult[] = [];
                  for (const inputs of execution.inputBatch) {
                    results.push(await client.executePreparedTrace(
                      preparation.handle,
                      {
                        inputs,
                        signal: execution.signal,
                        limits: execution.limits,
                      }
                    ));
                  }
                  return results;
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
                executeBatchIsolated: async (
                  execution: RuntimePreparedCodeBatchCall
                ): Promise<readonly CodeExecutionResult[]> => {
                  if (disposed) {
                    throw new Error(
                      `C++ prepared program "${preparation.handle.programId}" was already disposed.`
                    );
                  }
                  const results: CodeExecutionResult[] = [];
                  for (const inputs of execution.inputBatch) {
                    results.push(await client.executePreparedCode(
                      preparation.handle,
                      {
                        inputs,
                        signal: execution.signal,
                        limits: execution.limits,
                      }
                    ));
                  }
                  return results;
                },
                dispose,
              },
              consoleOutput: preparation.consoleOutput,
              ...(preparation.timings
                ? { timings: preparation.timings }
                : {}),
            };
      } catch (error) {
        retireClient(client);
        throw error;
      }
    },

    reset(): void {
      assertActive();
      generation += 1;
      for (const forceDispose of [...activePrograms]) forceDispose();
      for (const client of [...ownedClients]) retireClient(client);
      standbyClient = null;
    },

    terminate(): void {
      if (terminated) return;
      generation += 1;
      terminated = true;
      for (const forceDispose of [...activePrograms]) forceDispose();
      for (const client of [...ownedClients]) retireClient(client);
      standbyClient = null;
    },
  };
}
