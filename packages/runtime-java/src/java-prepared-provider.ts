import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedCodeCall,
  RuntimePreparedCodeProgram,
  RuntimePreparedExecutionProvider,
  RuntimePreparedTraceCall,
  RuntimePreparedTraceBatchCall,
  RuntimePreparedTraceProgram,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeTraceCall,
} from '@tracecode/runtime-contracts';
import {
  createEmptyRuntimeTrace,
  liftTraceOutcome,
} from '@tracecode/runtime-contracts';
import { getLanguageRuntimeProfile } from '@tracecode/runtime-browser/internal';
import { assertRuntimeRequestSupported } from '@tracecode/runtime-browser/internal';
import { ExecutionTimeoutError } from '@tracecode/runtime-browser/internal';
import {
  JavaWorkerClient,
  type JavaWorkerClientOptions,
  type JavaWorkerPreparedProgramSnapshot,
  type JavaWorkerPreparedProgramResult,
  type JavaWorkerTraceResult,
} from './java-worker-client';

export interface JavaPreparedExecutionProviderOptions {
  /**
   * Creates one warm compiler Worker client owned by this provider.
   *
   * A prepared program leases that client while TraceJVM replaces the inner
   * runner JVM and TraceKernel process for every case. A hard Worker failure
   * restores only the immutable compiled snapshot into a new generation.
   */
  readonly createWorkerClient: () => JavaWorkerClient;
}

/**
 * Browser construction boundary for the root prepared-provider registry.
 *
 * The registry supplies the selected prepared Java worker URL and host
 * preflights here. This factory never calls createJavaRuntimeClient and cannot
 * fall back to the legacy single-call Java provider.
 */
export type JavaBrowserPreparedExecutionProviderOptions =
  JavaWorkerClientOptions;

export interface JavaPreparedExecutionProvider
  extends RuntimePreparedExecutionProvider {
  /**
   * Releases only an unused warm standby. The provider remains valid and will
   * lazily create a new standby on its next init or preparation.
   */
  releaseStandby(): void;

  /**
   * Permanently invalidates the provider and releases its standby or active
   * preparation. Prepared programs remain independently owned and must still
   * be disposed by their evaluation owner.
   */
  dispose(): void;
}

interface StandbyWorker {
  readonly client: JavaWorkerClient;
  readonly ready: Promise<{ success: boolean; loadTimeMs: number }>;
}

function preparationFailure(
  result: JavaWorkerPreparedProgramResult
): RuntimeProgramPreparationResult {
  return {
    kind: 'failed',
    error: result.error ?? 'Java program preparation failed.',
    ...(result.errorLine === undefined
      ? {}
      : { errorLine: result.errorLine }),
    diagnosticStage: 'compile',
    consoleOutput: result.consoleOutput ?? [],
    ...(result.timings ? { timings: result.timings } : {}),
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException('Java prepared execution was aborted.', 'AbortError');
}

abstract class JavaPreparedProgramBase {
  readonly capabilities = Object.freeze({
    caseIsolation: 'fresh-case-state' as const,
    // A case owns a fresh JavaWorkerClient, but the program intentionally
    // serializes admission so disposal and backpressure have one lifecycle
    // authority and no caller can accidentally overlap heavyweight VMs.
    maxConcurrency: 1,
  });

  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private active = false;
  private released = false;
  private restoredGeneration: number;

  constructor(
    protected readonly programId: string,
    private readonly snapshot: JavaWorkerPreparedProgramSnapshot,
    private readonly client: JavaWorkerClient,
    private readonly releaseClient: (client: JavaWorkerClient) => void
  ) {
    this.restoredGeneration = client.sessionGeneration;
  }

  protected assertActive(): void {
    if (this.disposed) {
      throw new Error('Java prepared program is already disposed.');
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      if (this.active) this.client.terminate();
      await this.operationTail;
      try {
        await this.client.disposePreparedRuntimeProgram(this.programId);
      } finally {
        this.releaseOnce();
      }
    })();
    return this.disposePromise;
  }

  protected async executeWithClient<Result>(
    operation: (client: JavaWorkerClient) => Promise<Result>,
    signal?: AbortSignal
  ): Promise<Result> {
    const execution = this.operationTail.then(() =>
      this.executeInFreshProcess(operation, signal)
    );
    this.operationTail = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }

  private async executeInFreshProcess<Result>(
    operation: (client: JavaWorkerClient) => Promise<Result>,
    signal?: AbortSignal
  ): Promise<Result> {
    this.assertActive();
    if (signal?.aborted) throw abortReason(signal);
    this.active = true;
    try {
      if (this.client.sessionGeneration !== this.restoredGeneration) {
        const initialized = await this.client.init(signal);
        if (!initialized.success) {
          throw new Error(
            'Java runtime initialization was unsuccessful during prepared execution.'
          );
        }
        const restored = await this.client.restorePreparedRuntimeProgram(
          this.snapshot
        );
        if (!restored.success || restored.programId !== this.programId) {
          throw new Error(
            restored.error ??
              'Java prepared program restoration was unsuccessful.'
          );
        }
        this.restoredGeneration = this.client.sessionGeneration;
      }
      this.assertActive();
      return await operation(this.client);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      throw error;
    } finally {
      this.active = false;
    }
  }

  private releaseOnce(): void {
    if (this.released) return;
    this.released = true;
    this.releaseClient(this.client);
  }
}

class JavaPreparedCodeProgramImpl
  extends JavaPreparedProgramBase
  implements RuntimePreparedCodeProgram {
  readonly mode = 'code' as const;

  executeIsolated(
    call: RuntimePreparedCodeCall
  ): Promise<CodeExecutionResult> {
    return this.executeWithClient(
      (client) => client.executePreparedCode(this.programId, call),
      call.signal
    )
      .catch((error: unknown) => {
        if (
          call.limits?.wallClockMs !== undefined &&
          error instanceof ExecutionTimeoutError
        ) {
          return {
            kind: 'limit' as const,
            reason: 'client-timeout' as const,
            error: error.message,
            consoleOutput: [],
          };
        }
        throw error;
      });
  }

  executeBatchIsolated(
    call: RuntimePreparedCodeBatchCall
  ): Promise<readonly CodeExecutionResult[]> {
    return this.executeWithClient(
      (client) =>
        client.executePreparedCodeBatch(this.programId, call),
      call.signal
    );
  }
}

class JavaPreparedTraceProgramImpl
  extends JavaPreparedProgramBase
  implements RuntimePreparedTraceProgram {
  readonly mode = 'trace' as const;

  constructor(
    programId: string,
    snapshot: JavaWorkerPreparedProgramSnapshot,
    client: JavaWorkerClient,
    releaseClient: (client: JavaWorkerClient) => void,
    private readonly traceCall: Pick<
      RuntimeTraceCall,
      'traceOptions'
    >
  ) {
    super(programId, snapshot, client, releaseClient);
  }

  async executeIsolated(
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult> {
    let result: JavaWorkerTraceResult;
    try {
      result = await this.executeWithClient(
        (client) => client.executePreparedWithTracing(
          this.programId,
          call,
          this.traceCall.traceOptions
        ),
        call.signal
      );
    } catch (error) {
      if (
        call.limits?.wallClockMs !== undefined &&
        error instanceof ExecutionTimeoutError
      ) {
        return {
          kind: 'limit',
          reason: 'client-timeout',
          error: error.message,
          trace: createEmptyRuntimeTrace('java', {
            runId: 'java:run',
            file: 'solution.java',
          }),
          executionTimeMs: call.limits.wallClockMs,
          consoleOutput: [],
        };
      }
      throw error;
    }
    return liftTraceOutcome(
      result,
      result.trace,
      'Java prepared tracing failed'
    );
  }

  executeBatchIsolated(
    call: RuntimePreparedTraceBatchCall
  ): Promise<readonly ExecutionResult[]> {
    return this.executeWithClient(
      async (client) => {
        const results = await client.executePreparedTraceBatch(
          this.programId,
          call,
          this.traceCall.traceOptions
        );
        return results.map((result) =>
          liftTraceOutcome(
            result,
            result.trace,
            'Java prepared tracing failed'
          )
        );
      },
      call.signal
    );
  }
}

class JavaPreparedExecutionProviderImpl
  implements JavaPreparedExecutionProvider {
  private standby: StandbyWorker | undefined;
  private disposed = false;
  private readonly activePreparationClients = new Set<JavaWorkerClient>();
  private readonly terminatedPreparationClients =
    new WeakSet<JavaWorkerClient>();

  constructor(
    private readonly options: JavaPreparedExecutionProviderOptions
  ) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    this.assertActive();
    return this.ensureStandby().ready;
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    this.assertActive();
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('java'), {
      request: call.mode === 'trace' ? 'trace' : 'execute',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
    });

    const standby = this.takeStandby();
    this.activePreparationClients.add(standby.client);
    let initialized: { success: boolean; loadTimeMs: number };
    try {
      initialized = await standby.ready;
      this.assertActive();
    } catch (error) {
      this.terminatePreparationClientOnce(standby.client);
      throw error;
    }
    if (!initialized.success) {
      this.terminatePreparationClientOnce(standby.client);
      return {
        kind: 'failed',
        error: 'Java runtime initialization was unsuccessful.',
        diagnosticStage: 'compile',
        consoleOutput: [],
      };
    }

    let result: JavaWorkerPreparedProgramResult;
    try {
      result = await standby.client.prepareRuntimeProgram(call);
      this.assertActive();
    } catch (error) {
      this.terminatePreparationClientOnce(standby.client);
      throw error;
    }
    if (!result.success || !result.programId) {
      this.terminatePreparationClientOnce(standby.client);
      return preparationFailure(result);
    }
    if (
      !result.snapshot ||
      result.snapshot.programId !== result.programId
    ) {
      this.terminatePreparationClientOnce(standby.client);
      return {
        kind: 'failed',
        error:
          'Java prepared execution requires a resumable class artifact, but the selected runtime did not provide one.',
        diagnosticStage: 'compile',
        consoleOutput: result.consoleOutput ?? [],
        ...(result.timings ? { timings: result.timings } : {}),
      };
    }
    // Transfer the warm compiler Worker to the prepared program. TraceJVM
    // creates and disposes a fresh runner JVM for every execution while this
    // outer Worker and compiler survive until the program returns the lease.
    this.activePreparationClients.delete(standby.client);
    const returnClient = (client: JavaWorkerClient) =>
      this.returnWarmClient(client);

    const program =
      call.mode === 'trace'
        ? new JavaPreparedTraceProgramImpl(
            result.programId,
            result.snapshot,
            standby.client,
            returnClient,
            { traceOptions: call.traceOptions }
          )
        : new JavaPreparedCodeProgramImpl(
            result.programId,
            result.snapshot,
            standby.client,
            returnClient
          );
    return {
      kind: 'prepared',
      program,
      consoleOutput: result.consoleOutput ?? [],
      ...(result.timings ? { timings: result.timings } : {}),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.standby) {
      this.terminatePreparationClientOnce(this.standby.client);
    }
    this.standby = undefined;
    for (const client of this.activePreparationClients) {
      this.terminatePreparationClientOnce(client);
    }
  }

  releaseStandby(): void {
    this.assertActive();
    if (!this.standby) return;
    this.terminatePreparationClientOnce(this.standby.client);
    this.standby = undefined;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Java prepared execution provider is disposed.');
    }
  }

  private ensureStandby(): StandbyWorker {
    if (this.standby) return this.standby;
    const client = this.options.createWorkerClient();
    const standby = {
      client,
      ready: client.init(),
    };
    // A caller may abandon init(). Prevent a rejected warmup from becoming an
    // unhandled rejection while preserving the original Promise for consumers.
    standby.ready.catch(() => undefined);
    this.standby = standby;
    return standby;
  }

  private takeStandby(): StandbyWorker {
    const standby = this.ensureStandby();
    this.standby = undefined;
    return standby;
  }

  private returnWarmClient(client: JavaWorkerClient): void {
    if (this.disposed || this.standby) {
      this.terminatePreparationClientOnce(client);
      return;
    }
    const standby = {
      client,
      ready: client.init(),
    };
    standby.ready.catch(() => undefined);
    this.standby = standby;
  }

  private terminatePreparationClientOnce(client: JavaWorkerClient): void {
    this.activePreparationClients.delete(client);
    if (this.terminatedPreparationClients.has(client)) return;
    this.terminatedPreparationClients.add(client);
    client.terminate();
  }
}

export function createJavaPreparedExecutionProvider(
  options: JavaPreparedExecutionProviderOptions
): JavaPreparedExecutionProvider {
  if (!options || typeof options.createWorkerClient !== 'function') {
    throw new TypeError(
      'Java prepared execution requires a createWorkerClient factory.'
    );
  }
  return new JavaPreparedExecutionProviderImpl(options);
}

export function createJavaBrowserPreparedExecutionProvider(
  options: JavaBrowserPreparedExecutionProviderOptions
): JavaPreparedExecutionProvider {
  if (!options || typeof options.workerUrl !== 'string' || !options.workerUrl) {
    throw new TypeError(
      'Browser Java prepared execution requires an explicit workerUrl.'
    );
  }
  return createJavaPreparedExecutionProvider({
    createWorkerClient: () => new JavaWorkerClient(options),
  });
}
