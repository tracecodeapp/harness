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
  RuntimeProviderError,
  type RawExecutionBatchPayload,
  type RawExecutionPayload,
} from '@tracecode/runtime-contracts';

/**
 * Raw wire payload from the tracing command. The Python runtime client
 * normalizes and lifts this into the outcome union (`liftTraceOutcome`);
 * the worker client deliberately passes it through untyped-trace and all.
 */
export type PythonRawTraceResult = RawExecutionPayload & {
  trace?: unknown;
  observation?: unknown;
};
export type PythonRawTraceBatchResult = {
  results?: PythonRawTraceResult[];
  error?: string;
  consoleOutput?: string[];
  timings?: RuntimeExecutionTimings;
  algorithmFastBatchUnavailable?: boolean;
  algorithmFastBatchFailureClass?: 'capability-fallback' | 'driver-failure';
};

type PythonRawCodeBatchResult = RawExecutionBatchPayload & {
  algorithmFastBatchUnavailable?: boolean;
  algorithmFastBatchFailureClass?: 'capability-fallback' | 'driver-failure';
};

export class PythonAlgorithmFastBatchUnavailableError extends Error {
  constructor() {
    super('Prepared Python algorithm-fast batch requires hard isolation.');
    this.name = 'PythonAlgorithmFastBatchUnavailableError';
  }
}
import type {
  RuntimeCodeCall,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeExecutionLimits,
  RuntimeProjectCommandRequest,
  RuntimeProjectEngineLeaseController,
  RuntimeProjectSnapshot,
  RuntimePreparedTraceCall,
  RuntimePreparedTraceBatchCall,
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
  isExecutionTimeoutError,
  WorkerCrashedError,
  WorkerStartupError,
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
  /** Permanent mode is only safe when this worker is retired after its project command. */
  projectUserAuthorityMode?: 'temporary' | 'permanent';
  runtimeAssets?: {
    loaderUrl?: string;
    indexUrl?: string;
    loaderFormat?: 'classic-script' | 'module';
    runtimeUrl?: string;
    snippetsUrl?: string;
    packageUrls?: Readonly<Record<string, string>>;
  };
}

interface PythonWorkerClientInternalOptions extends PythonWorkerClientOptions {
  /** Immutable page-lifetime image factory used only by disposable prepared runners. */
  runtimeImageFactory?: PythonRuntimeImageFactory;
}

/**
 * Guest-enforced limits forwarded to the worker. wallClockMs remains guarded
 * by the client deadline too, but retained fast batches also need the value to
 * enforce the deadline independently for each case.
 */
function pickGuestLimits(
  limits: RuntimeExecutionLimits | undefined
): Pick<RuntimeExecutionLimits, 'wallClockMs' | 'maxLineEvents' | 'maxSingleLineHits' | 'maxCallDepth' | 'maxMemoryBytes'> | undefined {
  if (!limits) return undefined;
  const guest = {
    ...(limits.wallClockMs !== undefined ? { wallClockMs: limits.wallClockMs } : {}),
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
  readonly schemaVersion: 'tracecode.python.prepared-program.v4';
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
  readonly onDemandTracing?: boolean;
  readonly observationOnly?: true;
  readonly isolationProfile: {
    readonly tier: 'algorithm-fast' | 'judge-compatible' | 'hard-isolated';
    readonly reasons: readonly string[];
  };
  readonly algorithmFastBatchCode?: string;
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
const MAX_WORKER_DEADLINE_MS = 2_147_483_647;
const BATCH_DRIVER_BASE_HEADROOM_MS = 5_000;
const BATCH_DRIVER_PER_CASE_HEADROOM_MS = 100;
const BATCH_DRIVER_MAX_HEADROOM_MS = 30_000;
/**
 * A stopping batch's per-case client clock runs this much past the case's own
 * limit, so the worker's in-process deadline (same limit, started a moment
 * earlier) names the limit precisely whenever it can, and the client clock
 * only catches what the worker cannot interrupt.
 */
const STOPPING_BATCH_CASE_HEADROOM_MS = 1_000;

export function calculatePythonCodeBatchDeadlineMs(
  caseCount: number,
  perCaseWallClockMs?: number
): number {
  if (perCaseWallClockMs === undefined) return EXECUTION_TIMEOUT_MS;
  const normalizedCaseCount = Math.max(1, Math.floor(caseCount));
  const normalizedPerCaseMs = Math.max(1, perCaseWallClockMs);
  const driverHeadroomMs = Math.min(
    BATCH_DRIVER_MAX_HEADROOM_MS,
    BATCH_DRIVER_BASE_HEADROOM_MS +
      BATCH_DRIVER_PER_CASE_HEADROOM_MS * normalizedCaseCount
  );
  return Math.min(
    MAX_WORKER_DEADLINE_MS,
    normalizedPerCaseMs * normalizedCaseCount + driverHeadroomMs
  );
}

// Tracing timeout - longer because Python heuristic detection handles infinite loops
// This is just a safety net for truly stuck executions
const TRACING_TIMEOUT_MS = 30000;

// Python runtime warmup/load timeout can be significantly higher on first boot/network-constrained setups
const INIT_TIMEOUT_MS = 120000;

// Message timeout for non-execution operations (20 seconds)
const MESSAGE_TIMEOUT_MS = 20000;
// Worker bootstrap timeout - prevents deadlock when worker never emits "worker-ready"
const WORKER_READY_TIMEOUT_MS = 10000;

type StoppingBatchOutcome<R> =
  | { readonly kind: 'reply'; readonly reply: R }
  | {
      /** The case at `finished.length` started and never finished in time. */
      readonly kind: 'case-timeout';
      readonly finished: readonly unknown[];
      readonly error: ExecutionTimeoutError;
    };

/**
 * Follows a stopping batch's `batch-case-progress` messages. Only the next
 * case in order may start, and only the running case may finish, so a
 * malformed or replayed message can neither extend the clock past one
 * restart per case nor reorder the prefix.
 */
class StoppingBatchProgress {
  readonly finished: unknown[] = [];
  running: number | undefined;
  invalid: Error | undefined;

  constructor(private readonly caseCount: number) {}

  /** True when the message advanced the batch (and so restarts the clock). */
  accept(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const { index, phase, result } = message as {
      index?: unknown;
      phase?: unknown;
      result?: unknown;
    };
    if (phase === 'started') {
      if (this.running !== undefined || index !== this.finished.length || index >= this.caseCount) {
        return false;
      }
      this.running = index;
      return true;
    }
    if (phase === 'finished') {
      if (this.running === undefined || index !== this.running) return false;
      try {
        this.finished.push(restoreTransferredTraceEvents(result));
      } catch (error) {
        this.invalid = error instanceof Error ? error : new Error(String(error));
        return false;
      }
      this.running = undefined;
      return true;
    }
    return false;
  }

  /** The last finished case hit a time or line limit, which ends a stopping batch. */
  stoppedAtLimit(): boolean {
    const last = this.finished[this.finished.length - 1] as
      | { success?: unknown; timeoutReason?: unknown }
      | undefined;
    return last?.success === false &&
      typeof last.timeoutReason === 'string' &&
      PYTHON_RUNAWAY_TIMEOUT_REASONS.has(last.timeoutReason);
  }
}

/** Raw worker reasons after which a stopping batch runs no further case. */
const PYTHON_RUNAWAY_TIMEOUT_REASONS: ReadonlySet<string> = new Set([
  'client-timeout',
  'line-limit',
  'single-line-limit',
]);

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
  /** Stopping-batch progress handlers by worker command id. */
  private readonly batchProgress = new Map<string, (message: unknown) => void>();

  constructor(private readonly options: PythonWorkerClientInternalOptions) {
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
        !options.runtimeAssets.runtimeUrl ||
        !options.runtimeAssets.snippetsUrl)
    ) {
      throw new TypeError(
        'Module Python workers require consumer-supplied runtimeAssets.loaderUrl, indexUrl, runtimeUrl, and snippetsUrl.'
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
        if (type === 'batch-case-progress') {
          this.batchProgress.get(commandId)?.(payload);
          return true;
        }
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
  private shouldResetRuntimeLoadError(failure: unknown): boolean {
    const error = failure instanceof WorkerStartupError ? failure.cause : failure;
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
      if (isExecutionTimeoutError(error)) {
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

  async prepareProgram(
    call: RuntimeProgramPreparationCall,
    observationOnly = false
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
              ...(observationOnly ? { observationOnly: true } : {}),
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
    call: Pick<RuntimeCodeCall, 'inputs' | 'signal' | 'limits'> & {
      readonly onCaseStarted?: () => void;
    }
  ): Promise<CodeExecutionResult> {
    const wallClockMs = call.limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS;
    const guestLimits = pickGuestLimits(call.limits);
    let commandId: string | undefined;
    const send = this.core.sendMessageEffectWithOptions<RawExecutionPayload>(
      'execute-prepared-program',
      {
        artifact: handle.artifact,
        mode: 'code',
        inputs: call.inputs,
        ...(call.onCaseStarted ? { reportCaseProgress: true } : {}),
        ...(guestLimits ? { limits: guestLimits } : {}),
      },
      {
        timeoutMs: null,
        onRequestRegistered: (id) => {
          if (!call.onCaseStarted) return;
          commandId = id;
          const progress = new StoppingBatchProgress(1);
          this.batchProgress.set(id, (message) => {
            if (progress.accept(message) && progress.running === 0) call.onCaseStarted?.();
          });
        },
      }
    );
    const program = this.core.withExecutionDeadline(send, wallClockMs).pipe(
      Effect.ensuring(Effect.sync(() => {
        if (commandId !== undefined) this.batchProgress.delete(commandId);
      }))
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
      readonly stopAtFirstRunaway?: boolean;
      readonly onCaseStarted?: (index: number) => void;
    }
  ): Promise<CodeExecutionBatchResult> {
    const perCaseWallClockMs =
      call.limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS;
    const wallClockMs = calculatePythonCodeBatchDeadlineMs(
      call.inputBatch.length,
      call.limits?.wallClockMs
    );
    const guestLimits = pickGuestLimits({
      ...call.limits,
      wallClockMs: perCaseWallClockMs,
    });
    const request = {
      artifact: handle.artifact,
      mode: 'code',
      inputBatch: call.inputBatch,
      ...(guestLimits ? { limits: guestLimits } : {}),
    };
    let result: PythonRawCodeBatchResult;
    if (call.stopAtFirstRunaway === true) {
      const outcome = await this.executeStoppingBatch<PythonRawCodeBatchResult>(
        request,
        call.inputBatch.length,
        perCaseWallClockMs,
        wallClockMs,
        call.signal,
        call.onCaseStarted
      );
      if (outcome.kind === 'case-timeout') {
        return liftCodeBatchOutcome(
          {
            results: [
              ...(outcome.finished as RawExecutionPayload[]),
              {
                success: false,
                error: outcome.error.message,
                consoleOutput: [],
                executionTimeMs: perCaseWallClockMs,
                timeoutReason: 'client-timeout',
              },
            ],
          },
          'Prepared Python batch execution failed'
        );
      }
      result = outcome.reply;
    } else {
      const program = this.core.withExecutionDeadline(
        this.core.sendMessageEffect<PythonRawCodeBatchResult>(
          'execute-prepared-program-batch',
          request,
          null
        ),
        wallClockMs
      );
      result = await this.core.runClientEffect(program, call.signal);
    }
    if (result.algorithmFastBatchUnavailable === true) {
      const unexpected =
        result.algorithmFastBatchFailureClass !== 'capability-fallback';
      logRuntimeDiagnostic(unexpected ? 'error' : 'debug', {
        component: 'PythonWorkerClient',
        runtime: 'python',
        phase: 'algorithm-fast-batch-fallback',
        message: unexpected
          ? 'Python algorithm-fast batch driver failed; requesting hard isolation.'
          : 'Python algorithm-fast batch requires hard isolation.',
        detail: {
          caseCount: call.inputBatch.length,
          failureClass:
            result.algorithmFastBatchFailureClass ?? 'driver-failure',
        },
      }, { enabled: unexpected || this.debug });
      throw new PythonAlgorithmFastBatchUnavailableError();
    }
    // The aggregate watchdog is the batch's caller-visible deadline, not an
    // isolation-admission failure. Let it surface instead of silently granting
    // a second full budget to the hard-isolated path.
    return liftCodeBatchOutcome(
      result,
      'Prepared Python batch execution failed'
    );
  }

  async executePreparedTrace(
    handle: PythonPreparedProgramHandle,
    call: RuntimePreparedTraceCall
  ): Promise<PythonRawTraceResult> {
    const wallClockMs = call.limits?.wallClockMs ?? TRACING_TIMEOUT_MS;
    const guestLimits = pickGuestLimits({
      ...call.limits,
      wallClockMs,
    });
    const program = this.core.withExecutionDeadline(
      this.core.sendMessageEffect<PythonRawTraceResult>(
        'execute-prepared-program',
        {
          artifact: handle.artifact,
          mode: 'trace',
          inputs: call.inputs,
          ...(call.recordTrace === undefined
            ? {}
            : { tracingEnabled: call.recordTrace }),
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
      if (isExecutionTimeoutError(error)) {
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
    call: RuntimePreparedTraceBatchCall
  ): Promise<PythonRawTraceBatchResult> {
    const traceEnabledBatch = call.traceEnabledBatch;
    if (
      traceEnabledBatch !== undefined &&
      (
        traceEnabledBatch.length !== call.inputBatch.length ||
        traceEnabledBatch.some(
          (enabled) => typeof enabled !== 'boolean'
        )
      )
    ) {
      throw new TypeError(
        'Python trace selection must contain one boolean per batch case.'
      );
    }
    const perCaseWallClockMs = call.limits?.wallClockMs ?? TRACING_TIMEOUT_MS;
    const wallClockMs = Math.min(
      2_147_483_647,
      perCaseWallClockMs * Math.max(1, call.inputBatch.length)
    );
    const guestLimits = pickGuestLimits({
      ...call.limits,
      wallClockMs: perCaseWallClockMs,
    });
    const request = {
      artifact: handle.artifact,
      mode: 'trace',
      inputBatch: call.inputBatch,
      ...(traceEnabledBatch
        ? { traceEnabledBatch }
        : {}),
      ...(guestLimits ? { limits: guestLimits } : {}),
      traceEventTransport: traceEventTransferRequest(),
    };
    const timedOutCase = (error: Error): PythonRawTraceResult => ({
      success: false,
      error: error.message,
      trace: createEmptyRuntimeTrace('python', {
        runId: 'python:run',
        file: 'solution.py',
      }),
      executionTimeMs: perCaseWallClockMs,
      consoleOutput: [],
      timeoutReason: 'client-timeout',
    });
    try {
      let result: PythonRawTraceBatchResult;
      if (call.stopAtFirstRunaway === true) {
        const outcome = await this.executeStoppingBatch<PythonRawTraceBatchResult>(
          request,
          call.inputBatch.length,
          perCaseWallClockMs,
          wallClockMs,
          call.signal
        );
        if (outcome.kind === 'case-timeout') {
          return {
            results: [
              ...(outcome.finished as PythonRawTraceResult[]),
              timedOutCase(outcome.error),
            ],
          };
        }
        result = outcome.reply;
      } else {
        const program = this.core.withExecutionDeadline(
          this.core.sendMessageEffect<PythonRawTraceBatchResult>(
            'execute-prepared-program-batch',
            request,
            null
          ),
          wallClockMs
        );
        result = await this.core.runClientEffect(program, call.signal);
      }
      if (result.algorithmFastBatchUnavailable === true) {
        const unexpected =
          result.algorithmFastBatchFailureClass !== 'capability-fallback';
        logRuntimeDiagnostic(unexpected ? 'error' : 'debug', {
          component: 'PythonWorkerClient',
          runtime: 'python',
          phase: 'algorithm-fast-batch-fallback',
          message: unexpected
            ? 'Python algorithm-fast trace batch driver failed; requesting hard isolation.'
            : 'Python algorithm-fast trace batch requires hard isolation.',
          detail: {
            caseCount: call.inputBatch.length,
            failureClass:
              result.algorithmFastBatchFailureClass ?? 'driver-failure',
          },
        }, { enabled: unexpected || this.debug });
        throw new PythonAlgorithmFastBatchUnavailableError();
      }
      return result;
    } catch (error) {
      // A stopping batch never times out here: executeStoppingBatch names the
      // running case or rejects as a provider failure.
      if (isExecutionTimeoutError(error) && call.stopAtFirstRunaway !== true) {
        return { results: call.inputBatch.map(() => timedOutCase(error)) };
      }
      throw error;
    }
  }

  /**
   * A stopping batch (Run) under a per-case clock instead of one clock for the
   * whole batch. The worker reports each case as it starts and finishes; each
   * report restarts the clock at the case's limit plus headroom. Until the
   * first case starts (runtime and artifact setup, before any learner code)
   * the whole-batch deadline applies, as it does for a worker that does not
   * report progress.
   *
   * When a case outlives its clock the worker is terminated (nothing inside it
   * can interrupt learner code) and the outcome is the finished prefix plus
   * the case that was running: no second clock and no re-run.
   *
   * A time limit is the learner's only for a case that started and never
   * finished. When the clock expires with no case running (trusted setup
   * before the first case, or between cases, such as the next trace chunk's
   * setup), no learner code was running: unless the batch was already over,
   * the worker is terminated and the call rejects with RuntimeProviderError.
   * That includes a worker that never reports progress at all; the client and
   * worker ship together, so such a worker is a provider failure, and
   * blaming case 1 would hand the learner a time limit no code of theirs hit.
   *
   * Every result already reached the client as progress, so the worker's
   * final reply carries `resultsStreamed` instead of `results`; a reply that
   * still carries `results` (a worker double, or a reply the worker could not
   * stream, such as a fast-batch fallback) is used as is.
   */
  private async executeStoppingBatch<R extends { results?: unknown[]; resultsStreamed?: unknown }>(
    request: Record<string, unknown>,
    caseCount: number,
    perCaseWallClockMs: number,
    startupDeadlineMs: number,
    signal: AbortSignal | undefined,
    onCaseStarted?: (index: number) => void
  ): Promise<StoppingBatchOutcome<R>> {
    const progress = new StoppingBatchProgress(caseCount);
    const caseClockMs = Math.min(
      MAX_WORKER_DEADLINE_MS,
      perCaseWallClockMs + STOPPING_BATCH_CASE_HEADROOM_MS
    );
    let commandId: string | undefined;
    let restartClock: () => void = () => undefined;
    const clock = Effect.async<never, ExecutionTimeoutError>((resume) => {
      // The error names the limit the learner set (or the batch deadline
      // before any case started), not the headroom on top of it.
      let limitMs = startupDeadlineMs;
      const expire = () =>
        resume(Effect.fail(new ExecutionTimeoutError({
          timeoutMs: limitMs,
          runtimeLabel: this.core.executionTimeoutLabel,
        })));
      let timer = setTimeout(expire, startupDeadlineMs);
      restartClock = () => {
        clearTimeout(timer);
        limitMs = perCaseWallClockMs;
        timer = setTimeout(expire, caseClockMs);
      };
      return Effect.sync(() => clearTimeout(timer));
    });
    const reply = this.core.sendMessageEffectWithOptions<R>(
      'execute-prepared-program-batch',
      { ...request, stopAtFirstRunaway: true, reportCaseProgress: true },
      {
        timeoutMs: null,
        onRequestRegistered: (id) => {
          commandId = id;
          this.batchProgress.set(id, (message) => {
            if (!progress.accept(message)) return;
            restartClock();
            if (progress.running !== undefined) onCaseStarted?.(progress.running);
          });
        },
      }
    );
    const program = Effect.raceFirst(reply, clock).pipe(
      Effect.ensuring(Effect.sync(() => {
        if (commandId !== undefined) this.batchProgress.delete(commandId);
      })),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!isExecutionTimeoutError(error)) return;
          logRuntimeDiagnostic('warn', {
            component: 'PythonWorkerClient',
            runtime: 'python',
            phase: 'execution-timeout',
            message: 'Python stopping batch timed out; terminating worker.',
            detail: {
              timeoutMs: error.timeoutMs,
              runningCase: progress.running,
              finishedCases: progress.finished.length,
            },
          }, { enabled: this.debug });
          this.core.closeSession();
        })
      )
    );
    try {
      const result = await this.core.runClientEffect(program, signal);
      if (Array.isArray(result.results) || result.resultsStreamed === undefined) {
        return { kind: 'reply', reply: result };
      }
      if (progress.invalid || result.resultsStreamed !== progress.finished.length) {
        throw new Error('Prepared Python batch returned an invalid result envelope.');
      }
      const { resultsStreamed: _streamed, ...reply } = result;
      return { kind: 'reply', reply: { ...reply, results: progress.finished } as unknown as R };
    } catch (error) {
      if (!isExecutionTimeoutError(error)) throw error;
      if (progress.invalid) {
        throw new RuntimeProviderError(
          'The Python worker streamed a batch case result that could not be decoded.',
          { cause: progress.invalid, reason: 'protocol' }
        );
      }
      // The case that started and never finished outlived its clock.
      if (progress.running !== undefined) {
        return { kind: 'case-timeout', finished: progress.finished, error };
      }
      // The batch was over (every case finished, or the last one finished at
      // a limit and stopped it) and only the reply was late.
      if (progress.finished.length === caseCount || progress.stoppedAtLimit()) {
        return { kind: 'reply', reply: { results: progress.finished } as unknown as R };
      }
      // No case was running, so no learner code was: the worker stalled.
      const finished = progress.finished.length;
      throw new RuntimeProviderError(
        finished === 0
          ? 'The Python worker did not start the batch\'s first case in time; no learner code ran.'
          : `The Python worker did not start case ${finished + 1} in time after case ${finished} finished; no learner code was running.`,
        { cause: error }
      );
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
   * False once this client's worker is gone, for instance after a stopping
   * batch's clock terminated it. The next request would start a fresh worker
   * without the init and warmup this client already counts as done, so such
   * a client must not be kept as a warm worker.
   */
  get hasLiveWorker(): boolean {
    return !this.terminated && this.core.isWorkerRunning;
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
