import type {
  CodeExecutionResult,
  Drawing,
  ExecutionResult,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedCodeCall,
  RuntimePreparedCodeProgram,
  RuntimePreparedExecutionProvider,
  RuntimePreparedTraceCall,
  RuntimePreparedTraceBatchCall,
  RuntimePreparedTraceProgram,
  RuntimeObservationCall,
  RuntimeObservationProvider,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeTraceCall,
} from '@tracecode/runtime-contracts';
import { RuntimeProviderError } from '@tracecode/runtime-contracts';
import {
  createEmptyRuntimeTrace,
  liftTraceOutcome,
  traceUnavailableOutcome,
} from '@tracecode/runtime-contracts';
import { getLanguageRuntimeProfile } from '@tracecode/runtime-browser/internal';
import { assertRuntimeRequestSupported } from '@tracecode/runtime-browser/internal';
import { isExecutionTimeoutError } from '@tracecode/runtime-browser/internal';
import type { JudgeReceiptProvider } from '../../runtime-browser/src/browser-runtime-host-internal';
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
   * A prepared program leases that client while the runtime isolates case
   * state and retires any unclean runner JVM. A hard Worker failure
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
  /** @internal A retained observer artifact on a worker separate from the ordinary lease. */
  prepareObservation(
    program: RuntimeObservationCall['program']
  ): JavaPreparedObservation;
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

/** @internal The evaluation owner controls this lifetime and when cases are admitted. */
export interface JavaPreparedObservation extends RuntimeObservationProvider {
  readonly ready: Promise<boolean>;
  dispose(): Promise<void>;
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
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    consoleOutput: result.consoleOutput ?? [],
    ...(result.timings ? { timings: result.timings } : {}),
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException('Java prepared execution was aborted.', 'AbortError');
}

abstract class JavaPreparedProgramBase {
  readonly capabilities;

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
    this.capabilities = Object.freeze({
      profile:
        snapshot.algorithmIsolationProfile?.tier === 'algorithm-fast'
          ? 'fast' as const
          : 'compatibility' as const,
      caseIsolation: 'fresh-case-state' as const,
      // The program leases one worker and serializes requests so disposal
      // and runner lifetimes share a single owner.
      maxConcurrency: 1,
      stopsAtFirstRunaway: true as const,
    });
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
      this.executeInSession(operation, signal)
    );
    this.operationTail = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }

  private async executeInSession<Result>(
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
        // A configured or default deadline expiring is the learner's time
        // limit, never a provider failure.
        if (isExecutionTimeoutError(error)) {
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
    call: RuntimePreparedCodeBatchCall & { onCaseStarted?: (index: number) => void }
  ): Promise<readonly CodeExecutionResult[]> {
    return this.executeWithClient(
      (client) =>
        client.executePreparedCodeBatch(this.programId, call, call.onCaseStarted),
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

  observe(call: RuntimeObservationCall): Promise<Drawing> {
    return this.executeWithClient(
      (client) => client.observePreparedProgram(
        this.programId, call.inputs, call.traceOptions, call.signal
      ),
      call.signal
    );
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
      if (isExecutionTimeoutError(error)) {
        return {
          kind: 'limit',
          reason: 'client-timeout',
          error: error.message,
          trace: createEmptyRuntimeTrace('java', {
            runId: 'java:run',
            file: 'solution.java',
          }),
          executionTimeMs: call.limits?.wallClockMs ?? error.timeoutMs,
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

  async executeBatchIsolated(
    call: RuntimePreparedTraceBatchCall
  ): Promise<readonly ExecutionResult[]> {
    const results = await this.executeWithClient(
      (client) => client.executePreparedTraceBatch(
        this.programId,
        call,
        this.traceCall.traceOptions
      ),
      call.signal
    );
    return results.map((result) =>
      result.traceUnavailable
        ? traceUnavailableOutcome(new Error(result.error), 'java')
        : liftTraceOutcome(result, result.trace, 'Java prepared tracing failed')
    );
  }
}

class JavaPreparedExecutionProviderImpl
  implements JavaPreparedExecutionProvider {
  /** JVM start, restore and replacement run outside each case's own clock. */
  readonly lifecycleAllowanceMs = 120_000;
  private standby: StandbyWorker | undefined;
  private observerStandby: StandbyWorker | undefined;
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
      traceOptions: call.traceOptions,
    });
    return this.prepareInLease(call, false);
  }

  prepareObservation(program: RuntimeObservationCall['program']): JavaPreparedObservation {
    this.assertActive();
    const lifetime = new AbortController();
    const ready = this.prepareInLease({
      ...program,
      mode: 'trace',
      signal: lifetime.signal,
    }, true).then((result) => result.kind === 'prepared' &&
      result.program instanceof JavaPreparedTraceProgramImpl ? result.program : undefined,
      () => undefined);
    let disposed: Promise<void> | undefined;
    return {
      ready: ready.then(Boolean),
      async observe(call) {
        if (call.signal?.aborted) throw abortReason(call.signal);
        if (lifetime.signal.aborted) throw abortReason(lifetime.signal);
        if (call.traceOptions?.minimalTrace === true) {
          return { status: 'refused', reason: 'unsupported-option' };
        }
        const prepared = await ready;
        if (call.signal?.aborted) throw abortReason(call.signal);
        if (lifetime.signal.aborted) throw abortReason(lifetime.signal);
        if (!prepared) return { status: 'refused', reason: 'observer-prepare' };
        try {
          return await prepared.observe(call);
        } catch (error) {
          if (call.signal?.aborted) throw abortReason(call.signal);
          if (lifetime.signal.aborted) throw abortReason(lifetime.signal);
          return {
            status: 'refused',
            reason: error instanceof RuntimeProviderError && error.reason === 'protocol'
              ? 'observer-protocol'
              : 'observer-runtime',
          };
        }
      },
      dispose() {
        if (disposed) return disposed;
        lifetime.abort();
        disposed = ready.then(async (prepared) => prepared?.dispose());
        return disposed;
      },
    };
  }

  private async prepareInLease(
    call: RuntimeProgramPreparationCall,
    observerOnly: boolean
  ): Promise<RuntimeProgramPreparationResult> {
    if (call.signal?.aborted) throw abortReason(call.signal);
    const standby = this.ensureStandby(observerOnly);
    if (observerOnly) this.observerStandby = undefined;
    else this.standby = undefined;
    this.activePreparationClients.add(standby.client);
    const cancel = () => this.terminatePreparationClientOnce(standby.client);
    call.signal?.addEventListener('abort', cancel, { once: true });
    let result: JavaWorkerPreparedProgramResult;
    try {
      const initialized = await standby.ready;
      this.assertActive();
      if (call.signal?.aborted) throw abortReason(call.signal);
      if (!initialized.success) {
        throw new RuntimeProviderError('Java runtime initialization was unsuccessful.');
      }
      result = await standby.client.prepareRuntimeProgram(call, observerOnly);
      this.assertActive();
      if (call.signal?.aborted) throw abortReason(call.signal);
    } catch (error) {
      this.terminatePreparationClientOnce(standby.client);
      if (call.signal?.aborted) throw abortReason(call.signal);
      throw error;
    } finally {
      call.signal?.removeEventListener('abort', cancel);
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
      throw new RuntimeProviderError(
        'Java prepared execution requires a resumable class artifact, but the selected runtime did not provide one.'
      );
    }
    // Transfer the warm compiler Worker to the prepared program. TraceJVM
    // derives whether a correctness case can reuse a reset runner JVM or needs
    // a fresh one; this outer Worker and compiler survive either boundary until
    // the program returns the lease.
    this.activePreparationClients.delete(standby.client);
    const returnClient = (client: JavaWorkerClient) =>
      this.returnWarmClient(client, observerOnly);

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
    if (this.observerStandby) {
      this.terminatePreparationClientOnce(this.observerStandby.client);
    }
    this.observerStandby = undefined;
    for (const client of this.activePreparationClients) {
      this.terminatePreparationClientOnce(client);
    }
  }

  releaseStandby(): void {
    this.assertActive();
    if (this.standby) this.terminatePreparationClientOnce(this.standby.client);
    if (this.observerStandby) this.terminatePreparationClientOnce(this.observerStandby.client);
    this.standby = undefined;
    this.observerStandby = undefined;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Java prepared execution provider is disposed.');
    }
  }

  private ensureStandby(observerOnly = false): StandbyWorker {
    const prior = observerOnly ? this.observerStandby : this.standby;
    if (prior) return prior;
    const client = this.options.createWorkerClient();
    const standby = {
      client,
      ready: client.init(),
    };
    // A caller may abandon init(). Prevent a rejected warmup from becoming an
    // unhandled rejection while preserving the original Promise for consumers.
    standby.ready.catch(() => undefined);
    if (observerOnly) this.observerStandby = standby;
    else this.standby = standby;
    return standby;
  }

  private returnWarmClient(client: JavaWorkerClient, observerOnly: boolean): void {
    if (this.disposed || (observerOnly ? this.observerStandby : this.standby)) {
      this.terminatePreparationClientOnce(client);
      return;
    }
    const standby = {
      client,
      ready: client.init(),
    };
    standby.ready.catch(() => undefined);
    if (observerOnly) this.observerStandby = standby;
    else this.standby = standby;
  }

  private terminatePreparationClientOnce(client: JavaWorkerClient): void {
    this.activePreparationClients.delete(client);
    if (this.terminatedPreparationClients.has(client)) return;
    this.terminatedPreparationClients.add(client);
    client.terminate();
  }
}

/** @internal Bind the observer to the Java provider already owned by this host. */
export function createJavaJudgeReceiptProvider(
  provider: JavaPreparedExecutionProvider,
  runtimeVersion: string
): JudgeReceiptProvider {
  return {
    runtimeVersion,
    capabilities: {
      observationLease: 'separate',
      observationDeadlineMs: 30_000,
      observationPrepareDeadlineMs: 120_000,
      stoppingBatchAdmission: 'worker-start',
    },
    async prepareObservation(program, signal, traceOptions) {
      signal.throwIfAborted();
      if (traceOptions?.minimalTrace === true) {
        return { status: 'refused', reason: 'unsupported-option' };
      }
      const observation = provider.prepareObservation(program);
      const abort = () => { void observation.dispose().catch(() => undefined); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!(await observation.ready)) {
          signal.throwIfAborted();
          await observation.dispose();
          return { status: 'refused', reason: 'observer-prepare' };
        }
        signal.throwIfAborted();
        return observation;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
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
