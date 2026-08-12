/**
 * C# Worker Client
 *
 * Session lifecycle, request/response, deadlines, and the Promise boundary
 * live in the shared WorkerSessionCore; this file owns C#-specific concerns:
 * worker construction, asset preflights, idle-timeout handling, runtime-load
 * retry policy, request-timeout teardown policy, kernel-HTTP wiring, result
 * mapping, and trace assembly.
 */

import * as Effect from 'effect/Effect';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  withRuntimeTraceOptions,
  type RuntimeTrace,
  type RuntimeTraceEvent,
} from '@tracecode/runtime-contracts';
import type {
  ExecutionLimitReason,
  RuntimeBatchCall,
  RuntimeCodeCall,
  RuntimePreparedCodeCall,
  RuntimePreparedTraceCall,
  RuntimeProgramPreparationCall,
  RuntimeTraceCall,
  TraceExecutionOptions,
} from '@tracecode/runtime-contracts';
import { liftCodeBatchOutcome, liftTraceOutcome, type RawExecutionBatchPayload } from '@tracecode/runtime-contracts';
import type {
  CodeExecutionResult,
  CodeExecutionBatchResult,
  ExecutionResult,
  RuntimeExecutionTimings,
} from '@tracecode/runtime-contracts';
import type {
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeKernelSignalBridge,
  RuntimeKernelSyscallBridge,
  RuntimeProjectCommandRequest,
  RuntimeProjectEngineLeaseController,
} from '@tracecode/runtime-contracts';
import { isDevEnvironment } from '@tracecode/runtime-browser/internal';
import {
  cleanupAsyncKernelHttp,
  handleAsyncKernelHttpProtocolMessage,
  type AsyncKernelHttpHost,
} from '@tracecode/runtime-browser/internal';
import { logRuntimeDiagnostic } from '@tracecode/runtime-browser/internal';
import type { BrowserWorkerFactory, BrowserWorkerLike } from '@tracecode/runtime-browser/internal';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from '@tracecode/runtime-browser/internal';
import {
  ExecutionTimeoutError,
  WorkerCrashedError,
  WorkerReadyTimeoutError,
  WorkerReportedError,
  WorkerRequestTimeoutError,
  WorkerTerminatedError,
} from '@tracecode/runtime-browser/internal';
import { WorkerSessionCore } from '@tracecode/runtime-browser/internal';
import type { WorkerSessionMessage } from '@tracecode/runtime-browser/internal';
import { handleHostArtifactCacheRequest, HostArtifactCache } from '@tracecode/runtime-browser/internal';
import {
  decodeTraceClrWireResult,
  encodeTraceClrWireInputs,
  type TraceClrWireContractDescriptor,
} from './traceclr-wire';

export type CSharpExecutionStyle = 'function' | 'solution-method' | 'ops-class';
export type CSharpPreparedRunnerTier = 'algorithm-fast' | 'compatibility';

export interface CSharpWorkerClientOptions {
  workerUrl: string;
  workerFactory?: BrowserWorkerFactory;
  assetBaseUrl: string;
  debug?: boolean;
  initTimeoutMs?: number;
  executionTimeoutMs?: number;
  tracingTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  assetPreflight?: () => Promise<void>;
  runtimeAssetPreflight?: () => Promise<void>;
  /** Permanent mode is only safe when this worker is retired after its project command. */
  projectUserAuthorityMode?: 'temporary' | 'permanent';
  /** Declared runtime files preflighted by the browser harness and resolved beneath assetBaseUrl. */
  runtimeDependencies?: Readonly<Record<string, string>>;
  /** Capability role fixed for the lifetime of this worker. */
  runtimeRole?: 'general' | 'compiler' | 'runner';
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
  timings?: RuntimeExecutionTimings;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
  error?: string;
  timings?: RuntimeExecutionTimings;
  trustedPreparedArtifact?: CSharpPreparedProgramArtifact;
}

const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 45_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const CSHARP_DEFAULT_FILE = 'solution.cs';
const CSHARP_LEGACY_USER_FILE = 'UserCode.cs';
const CSHARP_HOST_ARTIFACT_CACHE_MAX_ENTRIES = 24;
const CSHARP_HOST_ARTIFACT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

const KERNEL_HTTP_MESSAGE_TYPES = new Set([
  'kernel-http-listen',
  'kernel-http-close',
  'kernel-http-response',
  'kernel-http-dispatch',
  'kernel-http-abort-dispatch',
  'kernel-http-error',
]);

export interface CSharpDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: string;
  id?: string;
}

export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CSharpProjectCommandResult = RuntimeCommandResult;

interface CSharpWorkerExecuteResult {
  success: boolean;
  output?: unknown;
  error?: string;
  diagnostics?: CSharpDiagnostic[];
  consoleOutput?: string[];
  events?: RuntimeTraceEvent[];
  executionTimeMs?: number;
  traceLimitExceeded?: boolean;
  timeoutReason?: ExecutionLimitReason;
  timings?: RuntimeExecutionTimings;
  outputBytes?: Uint8Array;
}

export interface CSharpWorkerPrepareResult extends CSharpWorkerExecuteResult {
  compiledArtifactKey?: string;
  compiledArtifactBase64?: string;
  compiledArtifactSha256?: string;
  preparedRunnerTier?: CSharpPreparedRunnerTier;
  preparedRunnerReason?: string;
  traceClrWireContract?: TraceClrWireContractDescriptor;
}

export interface CSharpPreparedProgramArtifact {
  readonly mode: 'code' | 'trace';
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle: CSharpExecutionStyle;
  readonly traceOptions?: TraceExecutionOptions;
  readonly compiledArtifactKey: string;
  readonly compiledArtifactBase64: string;
  readonly compiledArtifactSha256: string;
  readonly preparedRunnerTier: CSharpPreparedRunnerTier;
  readonly preparedRunnerReason: string;
  readonly traceClrWireContract?: TraceClrWireContractDescriptor;
}

function isCSharpUserFile(file: string | undefined): boolean {
  return Boolean(file?.endsWith(CSHARP_DEFAULT_FILE) || file?.endsWith(CSHARP_LEGACY_USER_FILE));
}

function isCSharpUserDiagnostic(diagnostic: CSharpDiagnostic): boolean {
  return isCSharpUserFile(diagnostic.file);
}

function normalizeCSharpTraceEventFile(event: RuntimeTraceEvent): RuntimeTraceEvent {
  return isCSharpUserFile(event.file) ? { ...event, file: CSHARP_DEFAULT_FILE } : event;
}

export class CSharpWorkerClient {
  private httpRequestId = 0;
  private readonly kernelHttpHost: AsyncKernelHttpHost = {
    runtimeLabel: 'C#',
    getPending: (commandId) => this.core.pendingMessages.get(commandId),
    postWorkerMessage: (commandId, type, payload) => this.core.postCommandMessage(commandId, type, payload),
    isWorkerRunning: () => this.core.isWorkerRunning,
    nextHttpRequestId: () => ++this.httpRequestId,
  };
  /** Memoized runtime-load results for the current session; cleared by the session finalizer. */
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  /**
   * One authority spans every prepared handle backed by this client. Prepared
   * programs may share the immutable host artifact cache, but never a mutable
   * C# runtime process generation.
   */
  private preparedOperationTail: Promise<void> = Promise.resolve();
  private readonly debug: boolean;
  private readonly initTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly tracingTimeoutMs: number;
  private readonly core: WorkerSessionCore;
  private readonly artifactCache = new HostArtifactCache(
    CSHARP_HOST_ARTIFACT_CACHE_MAX_ENTRIES,
    CSHARP_HOST_ARTIFACT_CACHE_MAX_BYTES
  );

  constructor(private readonly options: CSharpWorkerClientOptions) {
    this.debug = options.debug ?? isDevEnvironment();
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    this.tracingTimeoutMs = options.tracingTimeoutMs ?? TRACING_TIMEOUT_MS;

    this.core = new WorkerSessionCore({
      runtimeLabel: 'C#',
      component: 'CSharpWorkerClient',
      runtime: 'csharp',
      debug: this.debug,
      readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
      defaultMessageTimeoutMs: MESSAGE_TIMEOUT_MS,
      isSupported: () => this.isSupported(),
      createWorker: () => this.createWorker(),
      preflight: async (type) => {
        await this.options.assetPreflight?.();
        if (type !== 'init' && type !== 'status') {
          await this.options.runtimeAssetPreflight?.();
        }
      },
      onCommandMessage: (commandId, type, payload, pending) => {
        if (type === 'kernel-syscall') {
          if (!pending.kernelSyscalls) return true;
          void pending.kernelSyscalls.service().catch(() => {
            pending.kernelSyscalls?.close();
          });
          return true;
        }
        if (!KERNEL_HTTP_MESSAGE_TYPES.has(type)) return false;
        handleAsyncKernelHttpProtocolMessage(this.kernelHttpHost, commandId, type, payload);
        return true;
      },
      onUnhandledMessage: (message, session) => {
        if (message.type === 'compiler-artifact-cache-request') {
          this.handleArtifactCacheRequest(message, session.worker);
          return true;
        }
        if (message.type !== 'idle-timeout') return false;
        logRuntimeDiagnostic('info', {
          component: 'CSharpWorkerClient',
          runtime: 'csharp',
          phase: 'idle-timeout',
          message: 'C# worker closed after idle timeout.',
        }, { enabled: this.debug });
        this.core.closeSession(new WorkerTerminatedError('C# worker closed after idle timeout'));
        return true;
      },
      decodeReply: (payload) => restoreTransferredTraceEvents(payload),
      // The dotnet runtime does not survive script errors; a crashed worker is
      // torn down and lazily respawned on the next request.
      closeSessionOnWorkerError: true,
    });
    this.core.executionTimeoutLabel = 'C#';
    this.core.cleanupPending = (pending) => cleanupAsyncKernelHttp(pending, 'C#');
    this.core.onSessionClosed = () => {
      this.initPromise = null;
      this.warmupPromise = null;
    };
  }

  isSupported(): boolean {
    return this.options.workerFactory !== undefined || typeof Worker !== 'undefined';
  }

  private createWorker(): BrowserWorkerLike {
    const workerUrl =
      this.debug && !this.options.workerUrl.includes('?')
        ? `${this.options.workerUrl}?dev=${Date.now()}`
        : this.options.workerUrl;

    return this.options.workerFactory
      ? this.options.workerFactory(workerUrl, { type: 'module' })
      : new Worker(workerUrl, { type: 'module' });
  }

  private hasPendingProtocolToken(protocolToken: unknown): protocolToken is string {
    return typeof protocolToken === 'string' &&
      Array.from(this.core.pendingMessages.values()).some((pending) => pending.protocolToken === protocolToken);
  }

  private handleArtifactCacheRequest(message: WorkerSessionMessage, worker: BrowserWorkerLike): void {
    handleHostArtifactCacheRequest({
      cache: this.artifactCache,
      message,
      worker,
      validateProtocolToken: (protocolToken) => this.hasPendingProtocolToken(protocolToken),
    });
  }

  /**
   * A C# worker that misses a request deadline is presumed stuck because the
   * runtime has no in-worker cancellation, so request timeouts tear the session down.
   */
  private sendCommandEffect<T>(
    type: string,
    payload?: unknown,
    timeoutMs: number | null = MESSAGE_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    kernelHttp?: RuntimeKernelHttpBridge,
    kernelSyscalls?: RuntimeKernelSyscallBridge,
    kernelSignals?: RuntimeKernelSignalBridge
  ): Effect.Effect<T, Error> {
    return this.core.sendMessageEffect<T>(
      type,
      payload,
      timeoutMs,
      onEvent,
      kernelHttp,
      undefined,
      kernelSyscalls,
      kernelSignals
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error instanceof WorkerRequestTimeoutError) this.core.closeSession(error);
        })
      )
    );
  }

  /** Runtime-load failures that warrant a worker reset + one retry. */
  private shouldResetRuntimeLoadError(error: unknown): boolean {
    if (
      error instanceof WorkerRequestTimeoutError ||
      error instanceof WorkerTerminatedError ||
      error instanceof WorkerCrashedError ||
      error instanceof WorkerReadyTimeoutError
    ) {
      return true;
    }
    // Worker-reported load failures arrive as prose from the dotnet loader;
    // fetch failures are the one retryable class we recognize by text.
    return error instanceof WorkerReportedError && (
      error.message.includes('Failed to fetch') || error.message.includes('timed out')
    );
  }

  private workerOptionsPayload(): {
    idleTimeoutMs?: number;
    runtimeDependencies?: Readonly<Record<string, string>>;
    runtimeRole: 'general' | 'compiler' | 'runner';
  } {
    return {
      runtimeRole: this.options.runtimeRole ?? 'general',
      ...(this.options.workerIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.options.workerIdleTimeoutMs }),
      ...(this.options.runtimeDependencies
        ? { runtimeDependencies: this.options.runtimeDependencies }
        : {}),
    };
  }

  private runPreparedExclusive<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const queued = this.preparedOperationTail.then(async () => {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('Prepared C# operation was aborted.');
      }
      return operation();
    });
    this.preparedOperationTail = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  /**
   * Run one prepared lifecycle operation in a clean outer worker generation.
   *
   * A collectible AssemblyLoadContext only isolates learner assemblies. The
   * C# runtime process also owns its filesystem, environment, current directory,
   * cultures, thread/runtime switches, and other framework state. Retiring the
   * whole worker before and after each case is the only honest
   * fresh-case-state boundary; the opaque PE remains reusable through the
   * host-owned artifact cache and the descriptor's base64 payload.
   */
  private runFreshPreparedGeneration<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runPreparedExclusive(signal, async () => {
      this.terminate();
      try {
        return await operation();
      } finally {
        this.terminate();
      }
    });
  }

  /**
   * A role-scoped runner is already a disposable outer lease owned by the
   * prepared authority. Keep that lease alive for the duration of one call or
   * eager batch so it can be prewarmed, then let the authority retire it.
   * Legacy/general workers retain the defensive fresh-generation behavior.
   */
  private runPreparedExecutionGeneration<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.options.runtimeRole === 'runner'
      ? this.runPreparedExclusive(signal, operation)
      : this.runFreshPreparedGeneration(signal, operation);
  }

  /**
   * The init program: one attempt, and on a runtime-load failure, reset the
   * session and run the same description once more.
   */
  private initEffect(): Effect.Effect<InitResult, Error> {
    const attempt = this.sendCommandEffect<InitResult>(
      'init',
      { assetBaseUrl: this.options.assetBaseUrl, ...this.workerOptionsPayload() },
      this.initTimeoutMs
    );
    return attempt.pipe(
      Effect.catchIf(
        (error): error is Error => this.shouldResetRuntimeLoadError(error),
        (error) =>
          Effect.suspend(() => {
            logRuntimeDiagnostic('warn', {
              component: 'CSharpWorkerClient',
              runtime: 'csharp',
              phase: 'init-retry',
              message: 'C# worker init failed; resetting worker and retrying once.',
              detail: { message: error.message },
            }, { enabled: this.debug });
            this.core.closeSession();
            return attempt;
          })
      )
    );
  }

  async init(): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;

    const promise = this.core.runClientEffect(this.initEffect());
    this.initPromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.initPromise === promise) this.initPromise = null;
      throw error;
    }
  }

  async warmup(): Promise<WarmupResult> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      try {
        await this.init();
        return await this.core.runClientEffect(
          this.sendCommandEffect<WarmupResult>(
            'warmup',
            { assetBaseUrl: this.options.assetBaseUrl, ...this.workerOptionsPayload() },
            this.initTimeoutMs
          )
        );
      } catch (error) {
        const warmupError = error instanceof Error ? error : new Error(String(error));
        this.warmupPromise = null;
        if (this.shouldResetRuntimeLoadError(warmupError)) this.core.closeSession(warmupError);
        throw warmupError;
      }
    })();
    return this.warmupPromise;
  }

  /** Runtime load ahead of an execution. Memoization stays Promise-based on the client. */
  private warmupEffect(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.warmup().then(() => undefined),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  private preparedReadyEffect(): Effect.Effect<void, Error> {
    // The compiler warmup performs one fixed trusted emit. Await the memoized
    // promise so an immediate learner preparation cannot race ahead of Roslyn
    // priming. A disposable runner only needs its runtime load, which the
    // provider starts concurrently and execution itself will await.
    return this.options.runtimeRole === 'runner'
      ? Effect.void
      : this.warmupEffect();
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    const { code, functionName, inputs, executionStyle = 'solution-method', signal, limits } = call;
    const wallClockMs = limits?.wallClockMs ?? this.executionTimeoutMs;
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.sendCommandEffect<CSharpWorkerExecuteResult>('execute-code', {
            code,
            functionName,
            inputs,
            executionStyle,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, wallClockMs - 1_000),
            ...this.workerOptionsPayload(),
          }, null), // the enclosing execution deadline is the only clock
          wallClockMs
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);

    if (!result.success) {
      if (result.timeoutReason) {
        return {
          kind: 'limit',
          reason: result.timeoutReason,
          error: result.error ?? 'C# execution failed',
          consoleOutput: result.consoleOutput ?? [],
          timings: result.timings,
        };
      }
      const firstUserDiagnostic = result.diagnostics?.find(isCSharpUserDiagnostic);
      return {
        kind: 'failed',
        error: result.error ?? 'C# execution failed',
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }

    return {
      kind: 'completed',
      output: result.output ?? null,
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

  async executeCodeBatch(call: RuntimeBatchCall): Promise<CodeExecutionBatchResult> {
    const { code, functionName, inputBatch, executionStyle = 'solution-method', signal } = call;
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.sendCommandEffect<RawExecutionBatchPayload>('execute-code-batch', {
            code,
            functionName,
            inputBatch,
            executionStyle,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, this.executionTimeoutMs - 1_000),
            ...this.workerOptionsPayload(),
          }, null),
          this.executionTimeoutMs
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);

    return liftCodeBatchOutcome(result, 'C# execution failed');
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<CSharpWorkerPrepareResult> {
    const prepare = async () => {
      const functionName = call.functionName ?? '';
      const executionStyle = call.executionStyle ?? 'solution-method';
      const timeoutMs = call.mode === 'trace'
        ? this.resolveTracingTimeoutMs(functionName, executionStyle)
        : this.executionTimeoutMs;
      const program = this.preparedReadyEffect().pipe(
        Effect.andThen(
          this.core.withExecutionDeadline(
            this.sendCommandEffect<CSharpWorkerPrepareResult>('prepare-program', {
              mode: call.mode,
              code: call.code,
              functionName,
              executionStyle,
              traceOptions: call.traceOptions,
              assetBaseUrl: this.options.assetBaseUrl,
              timeoutMs: Math.max(100, timeoutMs - 1_000),
              ...this.workerOptionsPayload(),
            }, null),
            timeoutMs
          )
        )
      );

      return this.core.runClientEffect(program, call.signal);
    };
    return this.options.runtimeRole === 'compiler'
      ? this.runPreparedExclusive(call.signal, prepare)
      : this.runFreshPreparedGeneration(call.signal, prepare);
  }

  async executePreparedCode(
    prepared: CSharpPreparedProgramArtifact,
    call: RuntimePreparedCodeCall
  ): Promise<CodeExecutionResult> {
    return this.runPreparedExecutionGeneration(call.signal, async () => {
      const wallClockMs = call.limits?.wallClockMs ?? this.executionTimeoutMs;
      const inputBytes = prepared.preparedRunnerTier === 'algorithm-fast'
        ? encodeTraceClrWireInputs(
            prepared.traceClrWireContract!,
            call.inputs
          )
        : undefined;
      const program = this.preparedReadyEffect().pipe(
        Effect.andThen(
          this.core.withExecutionDeadline(
            this.sendCommandEffect<CSharpWorkerExecuteResult>('execute-prepared-code', {
              prepared,
              inputs: call.inputs,
              ...(inputBytes ? { inputBytes } : {}),
              assetBaseUrl: this.options.assetBaseUrl,
              timeoutMs: Math.max(100, wallClockMs - 1_000),
              ...this.workerOptionsPayload(),
            }, null),
            wallClockMs
          )
        )
      );
      const result = await this.core.runClientEffect(program, call.signal);
      if (prepared.preparedRunnerTier === 'algorithm-fast' && result.success) {
        if (!(result.outputBytes instanceof Uint8Array)) {
          throw new TypeError(
            'The algorithm-fast C# runner returned no binary output payload.'
          );
        }
        result.output = decodeTraceClrWireResult(
          prepared.traceClrWireContract!,
          result.outputBytes
        );
      }
      return this.toCodeExecutionResult(result);
    });
  }

  async executePreparedTrace(
    prepared: CSharpPreparedProgramArtifact,
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult> {
    if (
      call.recordTrace !== undefined &&
      typeof call.recordTrace !== 'boolean'
    ) {
      throw new TypeError(
        'C# trace selection requires a boolean recordTrace value.'
      );
    }
    return this.runPreparedExecutionGeneration(call.signal, async () => {
      const wallClockMs = call.limits?.wallClockMs
        ?? this.resolveTracingTimeoutMs(prepared.functionName, prepared.executionStyle);
      const inputBytes = prepared.preparedRunnerTier === 'algorithm-fast'
        ? encodeTraceClrWireInputs(
            prepared.traceClrWireContract!,
            call.inputs
          )
        : undefined;
      let result: CSharpWorkerExecuteResult;
      const program = this.preparedReadyEffect().pipe(
        Effect.andThen(
          this.core.withExecutionDeadline(
            this.sendCommandEffect<CSharpWorkerExecuteResult>('execute-prepared-trace', {
              prepared,
              inputs: call.inputs,
              ...(inputBytes ? { inputBytes } : {}),
              ...(call.recordTrace === undefined
                ? {}
                : { tracingEnabled: call.recordTrace }),
              assetBaseUrl: this.options.assetBaseUrl,
              timeoutMs: Math.max(100, wallClockMs - 1_000),
              traceEventTransport: traceEventTransferRequest(),
              ...this.workerOptionsPayload(),
            }, null),
            wallClockMs
          )
        )
      );

      try {
        result = await this.core.runClientEffect(program, call.signal);
      } catch (error) {
        return this.traceClientFailure(error, wallClockMs);
      }

      if (prepared.preparedRunnerTier === 'algorithm-fast' && result.success) {
        if (!(result.outputBytes instanceof Uint8Array)) {
          throw new TypeError(
            'The algorithm-fast C# trace runner returned no binary output payload.'
          );
        }
        result.output = decodeTraceClrWireResult(
          prepared.traceClrWireContract!,
          result.outputBytes
        );
      }

      return this.toTraceExecutionResult(
        result,
        prepared.traceOptions,
        wallClockMs
      );
    });
  }

  async disposePreparedProgram(
    prepared: Pick<CSharpPreparedProgramArtifact, 'compiledArtifactKey'>
  ): Promise<void> {
    await this.runPreparedExclusive(undefined, async () => {
      if (!this.core.isWorkerRunning) return;
      await this.core.runClientEffect(
        this.sendCommandEffect<{ success: boolean }>(
          'dispose-prepared-program',
          { compiledArtifactKey: prepared.compiledArtifactKey }
        )
      );
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    const { code, inputs, traceOptions, executionStyle = 'solution-method', signal } = call;
    const functionName = call.functionName ?? '';
    let result: CSharpWorkerExecuteResult;
    const tracingTimeoutMs = this.resolveTracingTimeoutMs(functionName, executionStyle);
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.sendCommandEffect<CSharpWorkerExecuteResult>('execute-with-tracing', {
            code,
            functionName,
            inputs,
            executionStyle,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, tracingTimeoutMs - 1_000),
            maxTraceSteps: traceOptions?.maxTraceSteps,
            maxLineEvents: traceOptions?.maxLineEvents,
            maxSingleLineHits: traceOptions?.maxSingleLineHits,
            maxStoredEvents: traceOptions?.maxStoredEvents,
            maxPathDepth: traceOptions?.maxPathDepth,
            minimalTrace: traceOptions?.minimalTrace,
            traceEventTransport: traceEventTransferRequest(),
            ...this.workerOptionsPayload(),
          }, null),
          tracingTimeoutMs
        )
      )
    );

    try {
      result = await this.core.runClientEffect(program, signal);
    } catch (error) {
      return this.traceClientFailure(error, tracingTimeoutMs);
    }

    return this.toTraceExecutionResult(result, traceOptions, tracingTimeoutMs);
  }

  private toCodeExecutionResult(
    result: CSharpWorkerExecuteResult
  ): CodeExecutionResult {
    if (!result.success) {
      if (result.timeoutReason) {
        return {
          kind: 'limit',
          reason: result.timeoutReason,
          error: result.error ?? 'C# execution failed',
          consoleOutput: result.consoleOutput ?? [],
          timings: result.timings,
        };
      }
      const firstUserDiagnostic = result.diagnostics?.find(isCSharpUserDiagnostic);
      return {
        kind: 'failed',
        error: result.error ?? 'C# execution failed',
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }

    return {
      kind: 'completed',
      output: result.output ?? null,
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

  private toTraceExecutionResult(
    result: CSharpWorkerExecuteResult,
    traceOptions: TraceExecutionOptions | undefined,
    fallbackExecutionTimeMs: number
  ): ExecutionResult {
    const consoleOutput = result.consoleOutput ?? [];
    const hostEmittedStdout = result.events?.some((event) => event.kind === 'stdout') === true;
    const events = [
      ...(result.events ?? []),
      ...(hostEmittedStdout
        ? []
        : consoleOutput.map((text): RuntimeTraceEvent => ({
            kind: 'stdout',
            runId: 'csharp:run',
            file: CSHARP_DEFAULT_FILE,
            text,
          }))),
    ];
    const trace = this.createTrace(events, { maxPathDepth: traceOptions?.maxPathDepth });

    const firstUserDiagnostic = result.diagnostics?.find(isCSharpUserDiagnostic);
    return liftTraceOutcome(
      {
        ...result,
        executionTimeMs: result.executionTimeMs ?? fallbackExecutionTimeMs,
        consoleOutput,
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
      },
      trace,
      'C# execution failed'
    );
  }

  private traceClientFailure(
    error: unknown,
    executionTimeMs: number
  ): ExecutionResult {
    const message = error instanceof Error ? error.message : String(error);
    const trace = this.createTrace([
      {
        kind: 'timeout',
        runId: 'csharp:run',
        file: CSHARP_DEFAULT_FILE,
        message,
      },
    ]);
    return {
      kind: 'limit',
      reason: 'client-timeout',
      error: message,
      trace,
      executionTimeMs,
      consoleOutput: [],
      timings: { totalMs: executionTimeMs },
    };
  }

  async executeProjectCSharp(
    request: CSharpProjectCommandRequest,
    timeoutMs = this.executionTimeoutMs,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal,
    engineLease?: RuntimeProjectEngineLeaseController
  ): Promise<CSharpProjectCommandResult> {
    if (engineLease) await this.core.acquireReusableEngineLease(engineLease);
    const {
      signal: _signal,
      onEvent: _requestOnEvent,
      engineLease: _engineLease,
      kernelHttp,
      kernelSyscalls,
      kernelSignals,
      ...workerRequest
    } = request;
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.sendCommandEffect<CSharpProjectCommandResult>(
            'execute-project-csharp',
            {
              ...workerRequest,
              assetBaseUrl: this.options.assetBaseUrl,
              timeoutMs: Math.max(100, timeoutMs - 1_000),
              ...(this.options.projectUserAuthorityMode
                ? { projectUserAuthorityMode: this.options.projectUserAuthorityMode }
                : {}),
              ...this.workerOptionsPayload(),
            },
            null,
            onEvent,
            kernelHttp,
            kernelSyscalls,
            kernelSignals
          ),
          timeoutMs
        )
      )
    );

    return this.core.runClientEffect(program, signal);
  }

  private createTrace(events: RuntimeTraceEvent[], options: { maxPathDepth?: number } = {}): RuntimeTrace {
    return withRuntimeTraceOptions({
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'csharp',
      runId: 'csharp:run',
      events: events.map(normalizeCSharpTraceEventFile),
      lineEventCount: events.filter((event) => event.kind === 'line').length,
      traceStepCount: events.length,
    }, options);
  }

  private resolveTracingTimeoutMs(functionName: string, executionStyle: CSharpExecutionStyle): number {
    void functionName;
    void executionStyle;
    return this.tracingTimeoutMs;
  }

  terminate(): void {
    this.core.closeSession();
  }
}
