/**
 * Python Worker Client
 *
 * TypeScript client for communicating with the Python Web Worker.
 * Session lifecycle, request/response, deadlines, and the Promise boundary
 * live in the shared WorkerSessionCore; this file owns Python-specific
 * concerns: worker construction, asset preflights, runtime-load retry
 * policy, kernel-HTTP wiring, and the execution API surface.
 */

import * as Effect from 'effect/Effect';
import type { CodeExecutionBatchResult, CodeExecutionResult } from '@tracecode/runtime-contracts';
import {
  createEmptyRuntimeTrace,
  liftCodeBatchOutcome,
  liftCodeOutcome,
  type RawExecutionBatchPayload,
  type RawExecutionPayload,
} from '@tracecode/runtime-contracts';

/**
 * Raw wire payload from the tracing command. The Python runtime client
 * normalizes and lifts this into the outcome union (`liftTraceOutcome`);
 * the worker client deliberately passes it through untyped-trace and all.
 */
export type PythonRawTraceResult = RawExecutionPayload & { trace?: unknown };
export type PythonRawTraceBatchResult = {
  results?: PythonRawTraceResult[];
  error?: string;
  consoleOutput?: string[];
  timings?: RuntimeExecutionTimings;
};
import type {
  RuntimeBatchCall,
  RuntimeCodeCall,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeExecutionLimits,
  RuntimeProjectCommandRequest,
  RuntimeProjectEngineLeaseController,
  RuntimeProjectSnapshot,
  RuntimeProgramPreparationCall,
  RuntimeExecutionTimings,
  RuntimeTraceCall,
} from '@tracecode/runtime-contracts';
import { appendWorkerUrlQueryParameter, isDevEnvironment } from '@tracecode/runtime-browser/internal';
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
  WorkerRequestTimeoutError,
  WorkerTerminatedError,
} from '@tracecode/runtime-browser/internal';
import { WorkerSessionCore } from '@tracecode/runtime-browser/internal';
import type {
  PythonRuntimeImage,
  PythonRuntimeImageFactory,
} from './python-runtime-image';

export type ExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export interface PythonWorkerClientOptions {
  workerUrl: string;
  workerFactory?: BrowserWorkerFactory;
  /** Worker construction mode. Module Python runtime loaders require a module worker. */
  workerFormat?: 'classic' | 'module';
  /** Bounded compiled Classic harness/source entries retained by this worker (0-16). */
  compileCacheLimit?: number;
  debug?: boolean;
  assetPreflight?: () => Promise<void>;
  runtimeAssetPreflight?: () => Promise<void>;
  /** Immutable page-lifetime image factory used only by disposable prepared runners. */
  runtimeImageFactory?: PythonRuntimeImageFactory;
  /** Permanent mode is only safe when this worker is retired after its project command. */
  projectUserAuthorityMode?: 'temporary' | 'permanent';
  runtimeAssets?: {
    loaderUrl?: string;
    indexUrl?: string;
    loaderFormat?: 'classic-script' | 'module';
    runtimeCoreUrl?: string;
    snippetsUrl?: string;
    packageUrls?: Readonly<Record<string, string>>;
  };
}

/** Guest-enforced limits forwarded to the worker; wallClockMs stays client-side. */
function pickGuestLimits(
  limits: RuntimeExecutionLimits | undefined
): Pick<RuntimeExecutionLimits, 'maxLineEvents' | 'maxSingleLineHits' | 'maxCallDepth' | 'maxMemoryBytes'> | undefined {
  if (!limits) return undefined;
  const guest = {
    ...(limits.maxLineEvents !== undefined ? { maxLineEvents: limits.maxLineEvents } : {}),
    ...(limits.maxSingleLineHits !== undefined ? { maxSingleLineHits: limits.maxSingleLineHits } : {}),
    ...(limits.maxCallDepth !== undefined ? { maxCallDepth: limits.maxCallDepth } : {}),
    ...(limits.maxMemoryBytes !== undefined ? { maxMemoryBytes: limits.maxMemoryBytes } : {}),
  };
  return Object.keys(guest).length > 0 ? guest : undefined;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
}

interface StatusResult {
  isReady: boolean;
  isLoading: boolean;
}

export interface PythonPreparedProgramArtifact {
  readonly schemaVersion: 'tracecode.python.prepared-program.v1';
  readonly fingerprint: {
    readonly cacheTag: string;
    readonly magicNumber: string;
    readonly marshalVersion: number;
  };
  readonly mode: 'code' | 'trace';
  readonly code: string;
  readonly functionName: string | null;
  readonly executionStyle: RuntimeProgramPreparationCall['executionStyle'];
  readonly traceOptions: RuntimeProgramPreparationCall['traceOptions'];
  readonly userCode: string;
  readonly executorCode: string;
}

export type PythonPreparedProgramHandle = {
  artifact: PythonPreparedProgramArtifact;
  mode: 'code' | 'trace';
  consoleOutput: string[];
  timings?: RuntimeExecutionTimings;
};

type PythonPreparedProgramFailure = {
  error: string;
  errorLine?: number;
  consoleOutput: string[];
  timings?: RuntimeExecutionTimings;
};

export type PythonPreparedProgramResult =
  | ({ success: true } & PythonPreparedProgramHandle)
  | ({ success: false } & PythonPreparedProgramFailure);

export type PythonProjectFile = RuntimeFile;
export type PythonProjectSnapshot = RuntimeProjectSnapshot;
export type PythonProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin' | 'module'
>;
export type PythonProjectCommandResult = RuntimeCommandResult;

const EXECUTION_TIMEOUT_MS = 30000;
const PROJECT_EXECUTION_TIMEOUT_MS = 30000;

// Tracing timeout - longer because Python heuristic detection handles infinite loops
// This is just a safety net for truly stuck executions
const TRACING_TIMEOUT_MS = 30000;

// Python runtime warmup/load timeout can be significantly higher on first boot/network-constrained setups
const INIT_TIMEOUT_MS = 120000;

// Message timeout for non-execution operations (20 seconds)
const MESSAGE_TIMEOUT_MS = 20000;
// Worker bootstrap timeout - prevents deadlock when worker never emits "worker-ready"
const WORKER_READY_TIMEOUT_MS = 10000;

const KERNEL_HTTP_MESSAGE_TYPES = new Set([
  'kernel-http-listen',
  'kernel-http-close',
  'kernel-http-response',
  'kernel-http-dispatch',
  'kernel-http-abort-dispatch',
  'kernel-http-error',
]);

export class PythonWorkerClient {
  private httpRequestId = 0;
  private readonly kernelHttpHost: AsyncKernelHttpHost = {
    runtimeLabel: 'Python',
    getPending: (commandId) => this.core.pendingMessages.get(commandId),
    postWorkerMessage: (commandId, type, payload) => this.core.postCommandMessage(commandId, type, payload),
    isWorkerRunning: () => this.core.isWorkerRunning,
    nextHttpRequestId: () => ++this.httpRequestId,
  };
  /** Memoized runtime-load results for the current session; cleared by the session finalizer. */
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private readonly debug: boolean;
  private readonly workerFormat: 'classic' | 'module';
  private readonly loaderFormat: 'classic-script' | 'module';
  private readonly core: WorkerSessionCore;
  private terminated = false;

  constructor(private readonly options: PythonWorkerClientOptions) {
    if (
      options.compileCacheLimit !== undefined &&
      (!Number.isInteger(options.compileCacheLimit) || options.compileCacheLimit < 0 || options.compileCacheLimit > 16)
    ) {
      throw new TypeError('Python compileCacheLimit must be an integer from 0 to 16.');
    }
    this.debug = options.debug ?? isDevEnvironment();
    this.workerFormat = options.workerFormat ?? 'classic';
    this.loaderFormat = options.runtimeAssets?.loaderFormat ?? 'classic-script';
    const coherentFormatPair =
      (this.workerFormat === 'classic' && this.loaderFormat === 'classic-script') ||
      (this.workerFormat === 'module' && this.loaderFormat === 'module');
    if (!coherentFormatPair) {
      throw new TypeError(
        `Python workerFormat "${this.workerFormat}" and loaderFormat "${this.loaderFormat}" are incompatible; ` +
          'use classic + classic-script or module + module.'
      );
    }
    if (
      this.workerFormat === 'module' &&
      (!options.runtimeAssets?.loaderUrl ||
        !options.runtimeAssets.indexUrl ||
        !options.runtimeAssets.runtimeCoreUrl ||
        !options.runtimeAssets.snippetsUrl)
    ) {
      throw new TypeError(
        'Module Python workers require consumer-supplied runtimeAssets.loaderUrl, indexUrl, runtimeCoreUrl, and snippetsUrl.'
      );
    }

    this.core = new WorkerSessionCore({
      runtimeLabel: 'Python',
      component: 'PythonWorkerClient',
      runtime: 'python',
      debug: this.debug,
      readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
      defaultMessageTimeoutMs: MESSAGE_TIMEOUT_MS,
      isSupported: () => this.isSupported(),
      createWorker: () => this.createWorker(),
      preflight: async (type) => {
        await this.options.assetPreflight?.();
        if (type !== 'status' && (type !== 'init' || this.loaderFormat === 'module')) {
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
      decodeReply: (payload) => restoreTransferredTraceEvents(payload),
    });
    this.core.cleanupPending = (pending) => cleanupAsyncKernelHttp(pending, 'Python');
    this.core.onSessionClosed = () => {
      this.initPromise = null;
      this.warmupPromise = null;
    };
  }

  /**
   * Check if Web Workers are supported
   */
  isSupported(): boolean {
    return this.options.workerFactory !== undefined || typeof Worker !== 'undefined';
  }

  private assertActive(): void {
    if (this.terminated) {
      throw new WorkerTerminatedError(
        'Python worker client has been terminated.'
      );
    }
  }

  private createWorker(): BrowserWorkerLike {
    let workerUrl = this.options.workerUrl;
    if (this.debug) {
      workerUrl = appendWorkerUrlQueryParameter(workerUrl, 'dev', String(Date.now()));
    }
    if (this.workerFormat === 'classic' && this.options.runtimeAssets?.snippetsUrl) {
      workerUrl = appendWorkerUrlQueryParameter(
        workerUrl,
        'tracecodePythonSnippets',
        this.options.runtimeAssets.snippetsUrl
      );
    }
    if (this.workerFormat === 'module') {
      workerUrl = appendWorkerUrlQueryParameter(workerUrl, 'tracecodePythonWorkerFormat', 'module');
    }
    const workerOptions = this.workerFormat === 'module' ? { type: 'module' as const } : undefined;
    return this.options.workerFactory
      ? this.options.workerFactory(workerUrl, workerOptions)
      : new Worker(workerUrl, workerOptions);
  }

  /** Runtime load ahead of an execution. Memoization stays Promise-based on the client. */
  private warmupEffect(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.warmup().then(() => undefined),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  /** Runtime-load failures that warrant a worker reset + one retry. Every error this can see is tagged. */
  private shouldResetRuntimeLoadError(error: unknown): boolean {
    if (this.terminated) return false;
    if (error instanceof WorkerRequestTimeoutError) {
      return error.messageType === 'init' || error.messageType === 'warmup';
    }
    return (
      error instanceof WorkerTerminatedError ||
      error instanceof WorkerCrashedError ||
      error instanceof WorkerReadyTimeoutError
    );
  }

  /**
   * The init program: one attempt, and on a runtime-load failure, reset the
   * session and run the same description once more. `attempt` being an inert,
   * immutable value is what makes "run it again" a one-liner.
   */
  private initEffect(): Effect.Effect<InitResult, Error> {
    const attempt = Effect.suspend(() =>
      Effect.tryPromise({
        try: async () => {
          if (this.options.runtimeImageFactory) {
            await this.options.runtimeAssetPreflight?.();
            this.assertActive();
          }
          const payload = await this.runtimeAssetsPayload();
          this.assertActive();
          return this.core.sendMessage<InitResult>(
            'init',
            payload,
            INIT_TIMEOUT_MS,
            undefined,
            undefined,
            () => this.assertActive()
          );
        },
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      })
    );
    return attempt.pipe(
      Effect.catchIf(
        (error): error is Error => this.shouldResetRuntimeLoadError(error),
        (error) =>
          Effect.suspend(() => {
            logRuntimeDiagnostic('warn', {
              component: 'PythonWorkerClient',
              runtime: 'python',
              phase: 'init-retry',
              message: 'Python worker init failed; resetting worker and retrying once.',
              detail: { message: error.message },
            }, { enabled: this.debug });
            this.core.closeSession();
            return attempt;
          })
      )
    );
  }

  /**
   * Initialize the Python worker. Runtime loading is lazy unless warmup() is called.
   */
  async init(): Promise<InitResult> {
    this.assertActive();
    if (this.initPromise) {
      return this.initPromise;
    }

    const promise = this.core.runClientEffect(this.initEffect());
    this.initPromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.initPromise === promise) this.initPromise = null;
      throw error;
    }
  }

  private async runtimeAssetsPayload(): Promise<{
    compileCacheLimit?: number;
    runtimeAssets?: PythonWorkerClientOptions['runtimeAssets'];
    runtimeImage?: PythonRuntimeImage;
  }> {
    const runtimeImage = this.options.runtimeImageFactory
      ? await this.options.runtimeImageFactory.acquire()
      : undefined;
    this.assertActive();
    return {
      ...(this.options.compileCacheLimit === undefined
        ? {}
        : { compileCacheLimit: this.options.compileCacheLimit }),
      ...(this.options.runtimeAssets ? { runtimeAssets: this.options.runtimeAssets } : {}),
      ...(runtimeImage ? { runtimeImage } : {}),
    };
  }

  async warmup(): Promise<WarmupResult> {
    this.assertActive();
    if (this.warmupPromise) return this.warmupPromise;

    this.warmupPromise = (async () => {
      try {
        await this.init();
        this.assertActive();
        return await this.core.sendMessage<WarmupResult>(
          'warmup',
          undefined,
          INIT_TIMEOUT_MS,
          undefined,
          undefined,
          () => this.assertActive()
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

  /**
   * Execute Python code with tracing for step-by-step visualization
   * @param options.maxLineEvents - Max line events before abort (for complexity analysis, use higher values)
   */
  async executeWithTracing(call: RuntimeTraceCall): Promise<PythonRawTraceResult> {
    const { code, functionName, inputs, traceOptions, executionStyle = 'function', signal } = call;
    // Use longer timeout for tracing - Python heuristic detection handles infinite loops
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<PythonRawTraceResult>('execute-with-tracing', {
            code,
            functionName,
            inputs,
            executionStyle,
            options: traceOptions,
            traceEventTransport: traceEventTransferRequest(),
          }, null), // the enclosing execution deadline is the only clock
          TRACING_TIMEOUT_MS
        )
      )
    );

    try {
      return await this.core.runClientEffect(program, signal);
    } catch (error) {
      if (error instanceof ExecutionTimeoutError) {
        return {
          success: false,
          error: error.message,
          trace: createEmptyRuntimeTrace('python', { runId: 'python:run', file: 'solution.py' }),
          executionTimeMs: TRACING_TIMEOUT_MS,
          consoleOutput: [],
          timeoutReason: 'client-timeout',
        };
      }

      throw error;
    }
  }

  /**
   * Execute Python code without tracing (for running tests)
   */
  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    const { code, functionName, inputs, executionStyle = 'function', signal, limits } = call;
    const wallClockMs = limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS;
    const guestLimits = pickGuestLimits(limits);

    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<RawExecutionPayload>('execute-code', {
            code,
            functionName,
            inputs,
            executionStyle,
            ...(guestLimits ? { limits: guestLimits } : {}),
          }, null),
          wallClockMs
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);
    return liftCodeOutcome(result, 'Python execution failed');
  }

  async executeCodeBatch(call: RuntimeBatchCall): Promise<CodeExecutionBatchResult> {
    const { code, functionName, inputBatch, executionStyle = 'function', signal } = call;
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<RawExecutionBatchPayload>('execute-code-batch', {
            code,
            functionName,
            inputBatch,
            executionStyle,
          }, null),
          EXECUTION_TIMEOUT_MS
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);
    return liftCodeBatchOutcome(result, 'Python execution failed');
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<PythonPreparedProgramResult> {
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<PythonPreparedProgramResult>(
            'prepare-program',
            {
              mode: call.mode,
              code: call.code,
              functionName: call.functionName,
              executionStyle: call.executionStyle ?? 'function',
              traceOptions: call.traceOptions ?? {},
            },
            null
          ),
          EXECUTION_TIMEOUT_MS
        )
      )
    );
    return this.core.runClientEffect(program, call.signal);
  }

  async executePreparedCode(
    handle: PythonPreparedProgramHandle,
    call: Pick<RuntimeCodeCall, 'inputs' | 'signal' | 'limits'>
  ): Promise<CodeExecutionResult> {
    const wallClockMs = call.limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS;
    const guestLimits = pickGuestLimits(call.limits);
    const program = this.core.withExecutionDeadline(
      this.core.sendMessageEffect<RawExecutionPayload>(
        'execute-prepared-program',
        {
          artifact: handle.artifact,
          mode: 'code',
          inputs: call.inputs,
          ...(guestLimits ? { limits: guestLimits } : {}),
        },
        null
      ),
      wallClockMs
    );
    const result = await this.core.runClientEffect(program, call.signal);
    return liftCodeOutcome(result, 'Prepared Python execution failed');
  }

  async executePreparedCodeBatch(
    handle: PythonPreparedProgramHandle,
    call: {
      readonly inputBatch: readonly Record<string, unknown>[];
      readonly signal?: AbortSignal;
      readonly limits?: RuntimeExecutionLimits;
    }
  ): Promise<CodeExecutionBatchResult> {
    const wallClockMs = call.limits?.wallClockMs === undefined
      ? EXECUTION_TIMEOUT_MS
      : Math.min(
          2_147_483_647,
          call.limits.wallClockMs * Math.max(1, call.inputBatch.length)
        );
    const guestLimits = pickGuestLimits(call.limits);
    const program = this.core.withExecutionDeadline(
      this.core.sendMessageEffect<RawExecutionBatchPayload>(
        'execute-prepared-program-batch',
        {
          artifact: handle.artifact,
          mode: 'code',
          inputBatch: call.inputBatch,
          ...(guestLimits ? { limits: guestLimits } : {}),
        },
        null
      ),
      wallClockMs
    );
    try {
      const result = await this.core.runClientEffect(program, call.signal);
      return liftCodeBatchOutcome(
        result,
        'Prepared Python batch execution failed'
      );
    } catch (error) {
      if (
        call.limits?.wallClockMs !== undefined &&
        error instanceof ExecutionTimeoutError
      ) {
        return {
          results: call.inputBatch.map(() => ({
            kind: 'limit',
            reason: 'client-timeout',
            error: error.message,
            consoleOutput: [],
            timings: {
              totalMs: call.limits!.wallClockMs,
              runMs: call.limits!.wallClockMs,
              artifactCacheHit: true,
            },
          })),
        };
      }
      throw error;
    }
  }

  async executePreparedTrace(
    handle: PythonPreparedProgramHandle,
    call: Pick<RuntimeTraceCall, 'inputs' | 'signal' | 'limits'>
  ): Promise<PythonRawTraceResult> {
    const wallClockMs = call.limits?.wallClockMs ?? TRACING_TIMEOUT_MS;
    const guestLimits = pickGuestLimits(call.limits);
    const program = this.core.withExecutionDeadline(
      this.core.sendMessageEffect<PythonRawTraceResult>(
        'execute-prepared-program',
        {
          artifact: handle.artifact,
          mode: 'trace',
          inputs: call.inputs,
          ...(guestLimits ? { limits: guestLimits } : {}),
          traceEventTransport: traceEventTransferRequest(),
        },
        null
      ),
      wallClockMs
    );
    try {
      return await this.core.runClientEffect(program, call.signal);
    } catch (error) {
      if (error instanceof ExecutionTimeoutError) {
        return {
          success: false,
          error: error.message,
          trace: createEmptyRuntimeTrace('python', {
            runId: 'python:run',
            file: 'solution.py',
          }),
          executionTimeMs: wallClockMs,
          consoleOutput: [],
          timeoutReason: 'client-timeout',
        };
      }
      throw error;
    }
  }

  async executePreparedTraceBatch(
    handle: PythonPreparedProgramHandle,
    call: {
      readonly inputBatch: readonly Record<string, unknown>[];
      readonly signal?: AbortSignal;
      readonly limits?: RuntimeExecutionLimits;
    }
  ): Promise<PythonRawTraceBatchResult> {
    const perCaseWallClockMs = call.limits?.wallClockMs ?? TRACING_TIMEOUT_MS;
    const wallClockMs = Math.min(
      2_147_483_647,
      perCaseWallClockMs * Math.max(1, call.inputBatch.length)
    );
    const guestLimits = pickGuestLimits(call.limits);
    const program = this.core.withExecutionDeadline(
      this.core.sendMessageEffect<PythonRawTraceBatchResult>(
        'execute-prepared-program-batch',
        {
          artifact: handle.artifact,
          mode: 'trace',
          inputBatch: call.inputBatch,
          ...(guestLimits ? { limits: guestLimits } : {}),
          traceEventTransport: traceEventTransferRequest(),
        },
        null
      ),
      wallClockMs
    );
    try {
      return await this.core.runClientEffect(program, call.signal);
    } catch (error) {
      if (error instanceof ExecutionTimeoutError) {
        return {
          results: call.inputBatch.map(() => ({
            success: false,
            error: error.message,
            trace: createEmptyRuntimeTrace('python', {
              runId: 'python:run',
              file: 'solution.py',
            }),
            executionTimeMs: perCaseWallClockMs,
            consoleOutput: [],
            timeoutReason: 'client-timeout',
          })),
        };
      }
      throw error;
    }
  }

  async executeProjectPython(
    request: PythonProjectCommandRequest,
    timeoutMs: number = PROJECT_EXECUTION_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal,
    engineLease?: RuntimeProjectEngineLeaseController
  ): Promise<PythonProjectCommandResult> {
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
          this.core.sendMessageEffect<PythonProjectCommandResult>(
            'execute-project-python',
            {
              ...workerRequest,
              ...(this.options.projectUserAuthorityMode
                ? { projectUserAuthorityMode: this.options.projectUserAuthorityMode }
                : {}),
            },
            null,
            onEvent,
            kernelHttp,
            undefined,
            kernelSyscalls,
            kernelSignals
          ),
          timeoutMs
        )
      )
    );

    return this.core.runClientEffect(program, signal);
  }

  /**
   * Check the status of the worker
   */
  async getStatus(): Promise<StatusResult> {
    return this.core.sendMessage<StatusResult>('status');
  }

  /**
   * Analyze Python code using AST (off main thread)
   * Returns CodeFacts with semantic information about the code
   */
  async analyzeCode(code: string): Promise<unknown> {
    // Keep runtime loading under the longer warmup budget so analysis timers only measure user code.
    await this.warmup();

    // Use a shorter timeout for analysis (5 seconds should be plenty)
    return this.core.sendMessage<unknown>('analyze-code', { code }, 5000);
  }

  /**
   * Terminate the worker and clean up resources
   */
  terminate(): void {
    this.terminated = true;
    this.core.closeSession();
  }
}

/**
 * Check if the worker client is supported
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}
