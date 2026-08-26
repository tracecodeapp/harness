import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedExecutionProvider,
  RuntimePreparedTraceBatchCall,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '@tracecode/runtime-contracts';
import type {
  PromotableBrowserBackgroundTask,
} from '@tracecode/runtime-browser/internal';
import { CppWorkerClient } from './cpp-worker-client';

export interface CppPreparedExecutionProviderOptions {
  createWorkerClient(): CppWorkerClient;
  /**
   * Perform one trusted toolchain warmup while establishing
   * the provider standby. The warmup runner is retired immediately.
   */
  warmCompilerOnInit?: boolean;
  /**
   * Queue compiler asset prewarm behind a browser-idle boundary while
   * retaining a foreground promotion path for the learner's first compile.
   */
  prewarmCompiler?: () => Promise<void>;
  scheduleCompilerPrewarm?: (
    prewarm: () => Promise<void>
  ) => PromotableBrowserBackgroundTask;
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
  let scheduledCompilerPrewarm: PromotableBrowserBackgroundTask | null = null;

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

  const cancelScheduledCompilerPrewarm = (): void => {
    scheduledCompilerPrewarm?.cancel();
    scheduledCompilerPrewarm = null;
  };

  const scheduleCompilerPrewarm = (): void => {
    if (
      terminated ||
      scheduledCompilerPrewarm ||
      !options.prewarmCompiler ||
      !options.scheduleCompilerPrewarm
    ) {
      return;
    }
    const expectedGeneration = generation;
    scheduledCompilerPrewarm = options.scheduleCompilerPrewarm(async () => {
      assertGeneration(expectedGeneration);
      await options.prewarmCompiler?.();
      assertGeneration(expectedGeneration);
    });
  };

  return {
    async init() {
      assertActive();
      const expectedGeneration = generation;
      const client = standbyClient ?? createClient();
      try {
        if (options.warmCompilerOnInit) {
          const result = await client.warmup();
          assertGeneration(expectedGeneration);
          // Warming currently needs the execution worker to generate the
          // trusted driver request. Do not retain that temporary runner: only
          // the separately owned compiler service may survive init.
          retireClient(client);
          return {
            success: result.success,
            loadTimeMs: result.loadTimeMs,
          };
        }
        const result = await client.init();
        assertGeneration(expectedGeneration);
        standbyClient = client;
        scheduleCompilerPrewarm();
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
      const compilerPrewarm = scheduledCompilerPrewarm;
      scheduledCompilerPrewarm = null;
      if (compilerPrewarm) {
        // A click promotes queued background work. A failed speculative prewarm
        // must not brick compilation; the normal prepare path retries it.
        await compilerPrewarm.promote().catch(() => undefined);
        assertGeneration(expectedGeneration);
      }
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
                  return client.executePreparedTraceBatch(
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
                executeBatchIsolated: async (
                  execution: RuntimePreparedCodeBatchCall
                ): Promise<readonly CodeExecutionResult[]> => {
                  if (disposed) {
                    throw new Error(
                      `C++ prepared program "${preparation.handle.programId}" was already disposed.`
                    );
                  }
                  return client.executePreparedCodeBatch(
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
        retireClient(client);
        throw error;
      }
    },

    reset(): void {
      assertActive();
      cancelScheduledCompilerPrewarm();
      generation += 1;
      for (const forceDispose of [...activePrograms]) forceDispose();
      for (const client of [...ownedClients]) retireClient(client);
      standbyClient = null;
    },

    terminate(): void {
      if (terminated) return;
      cancelScheduledCompilerPrewarm();
      generation += 1;
      terminated = true;
      for (const forceDispose of [...activePrograms]) forceDispose();
      for (const client of [...ownedClients]) retireClient(client);
      standbyClient = null;
    },
  };
}
