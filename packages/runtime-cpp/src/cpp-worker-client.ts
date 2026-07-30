/**
 * C++ Worker Client
 *
 * Session lifecycle, request/response, and the Promise boundary live in the
 * shared WorkerSessionCore; this file owns C++-specific concerns: the
 * one-command-per-worker retire/prewarm cycle with generation fencing, the
 * compiler coordinator (hidden compiler iframe or external compiler URL) with
 * its byte-bounded artifact cache, progress-aware execution deadlines, sync
 * kernel-HTTP wiring, and structured timeout results.
 *
 * Lifecycle vocabulary: a *retire* closes the current session but preserves
 * the compiler coordinator (frames, artifact cache, warmup memo); a *reset*
 * tears everything down and bumps the generation counters that fence queued
 * work from stale sessions.
 */

import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import type {
  CodeExecutionResult,
  CodeExecutionBatchResult,
  ExecutionResult,
  RuntimePreparedCodeCall,
  RuntimePreparedTraceCall,
  RuntimeExecutionTimings,
  RuntimeProgramPreparationCall,
} from '@tracecode/runtime-core';
import type {
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeProjectCommandRequest,
  RuntimeProjectEngineLeaseController,
} from '@tracecode/runtime-core';
import {
  createEmptyRuntimeTrace,
  liftCodeBatchOutcome,
  liftCodeOutcome,
  liftTraceOutcome,
  type RawExecutionBatchPayload,
  type RawExecutionPayload,
} from '@tracecode/runtime-core';
import type { RuntimeTrace } from '@tracecode/runtime-core';
import type { CppCompilerIntegrityManifest } from '../../runtime-browser/src/runtime-assets';
export type {
  CppCompilerIntegrityEntry,
  CppCompilerIntegrityManifest,
} from '../../runtime-browser/src/runtime-assets';

/** Raw wire payload from the tracing commands; lifted into the outcome union here. */
type CppRawTraceResult = RawExecutionPayload & { trace?: RuntimeTrace };
import type { RuntimeBatchCall, RuntimeCodeCall, RuntimeTraceCall, TraceExecutionOptions } from '@tracecode/runtime-core';
import {
  closeKernelHttpSyncServers,
  handleKernelHttpCloseMessage,
  handleKernelHttpDispatchSyncMessage,
  handleKernelHttpListenSyncMessage,
} from '@tracecode/runtime-browser/internal';
import { isDevEnvironment } from '@tracecode/runtime-browser/internal';
import { logRuntimeDiagnostic } from '@tracecode/runtime-browser/internal';
import type { BrowserWorkerFactory, BrowserWorkerLike } from '@tracecode/runtime-browser/internal';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from '@tracecode/runtime-browser/internal';
import {
  WorkerCrashedError,
  WorkerReadyTimeoutError,
  WorkerReportedError,
  WorkerRequestTimeoutError,
  WorkerTerminatedError,
} from '@tracecode/runtime-browser/internal';
import { WorkerSessionCore, type WorkerSessionMessage } from '@tracecode/runtime-browser/internal';
import { createWorkerProtocolToken } from '@tracecode/runtime-browser/internal';

const CPP_KERNEL_HTTP_RUNTIME_LABEL = 'C++';

export type CppExecutionStyle = 'function' | 'solution-method' | 'ops-class';
export type CppProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CppProjectCommandResult = RuntimeCommandResult;

export interface CppWorkerAssets {
  compilerWasmUrl: string;
  linkerWasmUrl: string;
  sysrootUrl: string;
  runtimeHeaderUrl: string;
  compilerBundleUrl: string;
  compilerFrameUrl?: string;
  compilerWorkerUrl?: string;
  compilerIntegrity?: CppCompilerIntegrityManifest;
}

export interface CppWorkerClientOptions extends CppWorkerAssets {
  workerUrl: string;
  workerFactory?: BrowserWorkerFactory;
  /** Verifies the execution-worker asset before constructing a Worker. */
  assetPreflight?: () => Promise<void>;
  /** Verifies compiler-frame and compiler assets only when compilation is requested. */
  runtimeAssetPreflight?: () => Promise<void>;
  debug?: boolean;
  initTimeoutMs?: number;
  executionTimeoutMs?: number;
  tracingTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  programCacheLimit?: number;
  usePrecompiledHeader?: boolean;
  externalCompilerUrl?: string;
}

interface PendingCompilerFrameRequest {
  protocolToken: string;
  resolve: (value: Record<string, unknown>) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

type CppClientTimeoutStage = 'compile-run' | 'trace';

interface CppRuntimeProgress {
  stage?: string;
  elapsedMs?: number;
  tracing?: boolean;
}

class CppClientTimeoutError extends Error {
  constructor(
    message: string,
    readonly stage: CppClientTimeoutStage,
    readonly timeoutMs: number,
    readonly progress?: CppRuntimeProgress
  ) {
    super(message);
    this.name = 'CppClientTimeoutError';
  }
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
  error?: string;
  timings?: RuntimeExecutionTimings;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
  error?: string;
  timings?: RuntimeExecutionTimings;
}

export interface CppPreparedProgramHandle {
  readonly programId: string;
  readonly mode: 'code' | 'trace';
  readonly lifecycleGeneration: number;
}

export type CppPreparedProgramPreparationResult =
  | {
      readonly success: true;
      readonly handle: CppPreparedProgramHandle;
      readonly consoleOutput: string[];
      readonly timings?: RuntimeExecutionTimings;
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly errorLine?: number;
      readonly diagnosticStage?: 'compile' | 'runtime' | 'trace' | 'driver-compile' | 'trace-driver-compile' | 'driver-link';
      readonly consoleOutput: string[];
      readonly timings?: RuntimeExecutionTimings;
      readonly limitReason?: 'client-timeout';
    };

interface CppPreparedProgramWorkerResult {
  success: boolean;
  programId?: string;
  mode?: 'code' | 'trace';
  error?: string;
  errorLine?: number;
  diagnosticStage?: 'compile' | 'runtime' | 'trace' | 'driver-compile' | 'trace-driver-compile' | 'driver-link';
  consoleOutput?: string[];
  timings?: RuntimeExecutionTimings;
  timeoutReason?: 'client-timeout';
}

const INIT_TIMEOUT_MS = 120_000;
// The outer client timeout is the hard product budget. Compiler and runtime
// phases report progress separately so timeout diagnostics show where we died.
const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 20_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const CPP_DEFAULT_FILE = 'solution.cpp';
const DEFAULT_CPP_COMPILER_ARTIFACT_CACHE_LIMIT = 32;
const MAX_CPP_COMPILER_ARTIFACT_CACHE_LIMIT = 512;
const MAX_CPP_COMPILER_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_CPP_COMPILER_ARTIFACT_CACHE_BYTES = 64 * 1024 * 1024;

const KERNEL_HTTP_SYNC_MESSAGE_TYPES = new Set([
  'kernel-http-dispatch-sync',
  'kernel-http-listen-sync',
  'kernel-http-close',
]);

interface CppCompilerArtifactCacheEntry {
  bytes: Uint8Array;
  result: Record<string, unknown>;
}

function canonicalCompilerPayload(value: unknown, seen = new Set<object>()): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (value === undefined) return 'null';
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (const item of value) {
        if (item === undefined) {
          entries.push('null');
          continue;
        }
        const encoded = canonicalCompilerPayload(item, seen);
        if (encoded === null) return null;
        entries.push(encoded);
      }
      return `[${entries.join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const entries: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      const encoded = canonicalCompilerPayload(item, seen);
      if (encoded === null) return null;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class CppWorkerClient {
  /** Memoized runtime-load results for the current session; cleared on retire/reset. */
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private readonly debug: boolean;
  private readonly initTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly tracingTimeoutMs: number;
  private readonly compilerFrameUrl?: string;
  private readonly externalCompilerUrl?: string;
  private lastRuntimeProgress: CppRuntimeProgress | null = null;
  private readonly activeExternalCompileControllers = new Set<AbortController>();
  private readonly activeCompilerFrames = new Set<HTMLIFrameElement>();
  private compilerFrame: HTMLIFrameElement | null = null;
  private compilerFrameReadyPromise: Promise<void> | null = null;
  private compilerFrameReadyResolve: (() => void) | null = null;
  private compilerFrameReadyReject: ((error: Error) => void) | null = null;
  private compilerFrameTargetOrigin = '';
  private compilerFrameToken = '';
  private compilerFrameRequestId = 0;
  private compilerFrameMessageHandler: ((event: MessageEvent) => void) | null = null;
  private pendingCompilerFrameRequests = new Map<string, PendingCompilerFrameRequest>();
  private executionQueue: Promise<void> = Promise.resolve();
  private readonly disposedPreparedPrograms = new Set<string>();
  private compilerArtifactCache = new Map<string, CppCompilerArtifactCacheEntry>();
  private compilerArtifactCacheBytes = 0;
  private compilerCoordinatorGeneration = 0;
  private executionLifecycleGeneration = 0;
  private executionResetReason: Error = new Error('C++ execution worker was reset');
  /** Distinguishes client-driven resets (which run their own cleanup) from core-initiated closes. */
  private suppressSessionClosedHook = false;
  private readonly core: WorkerSessionCore;

  constructor(private readonly options: CppWorkerClientOptions) {
    this.debug = options.debug ?? isDevEnvironment();
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    this.tracingTimeoutMs = options.tracingTimeoutMs ?? TRACING_TIMEOUT_MS;
    this.compilerFrameUrl = options.compilerFrameUrl;
    this.externalCompilerUrl = options.externalCompilerUrl;

    this.core = new WorkerSessionCore({
      runtimeLabel: 'C++',
      component: 'CppWorkerClient',
      runtime: 'cpp',
      debug: this.debug,
      readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
      defaultMessageTimeoutMs: MESSAGE_TIMEOUT_MS,
      isSupported: () => this.isSupported(),
      createWorker: () => this.createWorker(),
      preflight: async (type) => {
        await this.options.assetPreflight?.();
        if (this.messageRequiresCompilerAssets(type)) {
          await this.options.runtimeAssetPreflight?.();
        }
      },
      onCommandMessage: (commandId, type, payload, pending) => {
        if (type === 'runtime-progress') {
          this.lastRuntimeProgress = payload && typeof payload === 'object' ? (payload as CppRuntimeProgress) : {};
          return true;
        }
        if (type === 'kernel-syscall') {
          if (!pending.kernelSyscalls) return true;
          void pending.kernelSyscalls.service().catch(() => {
            pending.kernelSyscalls?.close();
          });
          return true;
        }
        if (!KERNEL_HTTP_SYNC_MESSAGE_TYPES.has(type)) return false;
        if (type === 'kernel-http-dispatch-sync') {
          handleKernelHttpDispatchSyncMessage(pending, payload, CPP_KERNEL_HTTP_RUNTIME_LABEL);
        } else if (type === 'kernel-http-listen-sync') {
          handleKernelHttpListenSyncMessage(pending, payload, CPP_KERNEL_HTTP_RUNTIME_LABEL);
        } else {
          handleKernelHttpCloseMessage(pending, payload, CPP_KERNEL_HTTP_RUNTIME_LABEL);
        }
        return true;
      },
      onUnhandledMessage: (message, session) => {
        if (message.type === 'idle-timeout') {
          logRuntimeDiagnostic('info', {
            component: 'CppWorkerClient',
            runtime: 'cpp',
            phase: 'idle-timeout',
            message: 'C++ worker closed after idle timeout.',
          }, { enabled: this.debug });
          this.terminateAndReset(new WorkerTerminatedError('C++ worker closed after idle timeout'));
          return true;
        }
        if (message.type === 'compile-request') {
          if (!this.hasPendingProtocolToken(message.protocolToken)) return true;
          this.handleCompileRequest(message, session.worker).catch((error) => {
            if (!message.requestId) return;
            session.worker.postMessage({
              type: 'compile-response',
              requestId: message.requestId,
              protocolToken: message.protocolToken,
              payload: { success: false, error: error instanceof Error ? error.message : String(error) },
            });
          });
          return true;
        }
        return false;
      },
      decodeReply: (payload) => restoreTransferredTraceEvents(payload),
      // The clang/wasm runtime does not survive script errors; a crashed
      // worker is fully reset (generations bumped) and lazily respawned.
      closeSessionOnWorkerError: true,
    });
    this.core.cleanupPending = (pending) => closeKernelHttpSyncServers(pending, CPP_KERNEL_HTTP_RUNTIME_LABEL);
    // Core-initiated closes (crash, ready timeout, abort interruption) are
    // full resets; client-driven retire/reset paths suppress this hook and
    // run their own cleanup with the right preservation policy.
    this.core.onSessionClosed = (reason) => {
      if (this.suppressSessionClosedHook) return;
      this.completeReset(reason, false);
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

  private messageRequiresCompilerAssets(type: string): boolean {
    if (type === 'init' || type === 'status') return false;
    if (type === 'execute-prepared-runtime-program' || type === 'dispose-prepared-runtime-program') {
      return false;
    }
    if (this.externalCompilerUrl) return false;
    // Project runs decide per-payload; the run wrappers preflight explicitly.
    return type !== 'execute-project-cpp';
  }

  private hasPendingProtocolToken(protocolToken: unknown): protocolToken is string {
    return typeof protocolToken === 'string' &&
      Array.from(this.core.pendingMessages.values()).some((pending) => pending.protocolToken === protocolToken);
  }

  /**
   * Progress-aware execution deadline. On a trip the error carries the stage
   * and last runtime progress for diagnostics, and the worker is reset when
   * the timeout policy says the worker is unrecoverable.
   */
  private withCppExecutionDeadline<A>(
    effect: Effect.Effect<A, Error>,
    timeoutMs: number,
    stage: CppClientTimeoutStage
  ): Effect.Effect<A, Error> {
    return Effect.suspend(() => {
      this.lastRuntimeProgress = null;
      return effect;
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () => {
          const timeoutLabel = stage === 'trace' ? 'tracing' : 'compile/run';
          return new CppClientTimeoutError(
            `C++ ${timeoutLabel} timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            stage,
            timeoutMs,
            this.lastRuntimeProgress ?? undefined
          );
        },
      }),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!(error instanceof CppClientTimeoutError)) return;
          const shouldTerminate = this.shouldTerminateWorkerForTimeout(error.progress ?? null);
          logRuntimeDiagnostic('warn', {
            component: 'CppWorkerClient',
            runtime: 'cpp',
            phase: 'execution-timeout',
            message: 'C++ execution timed out; terminating worker.',
            detail: { timeoutMs, stage, terminateWorker: shouldTerminate, lastProgress: error.progress ?? undefined },
          }, { enabled: this.debug });
          if (shouldTerminate) {
            this.terminateAndReset(error);
          }
        })
      )
    );
  }

  private isClientTimeout(error: unknown): boolean {
    return error instanceof CppClientTimeoutError;
  }

  private shouldTerminateWorkerForTimeout(progress: CppRuntimeProgress | null): boolean {
    void progress;
    return true;
  }

  private timeoutCodeResult(error: unknown): Extract<CodeExecutionResult, { kind: 'limit' }> {
    const timeoutError = error instanceof CppClientTimeoutError ? error : null;
    return {
      kind: 'limit',
      reason: 'client-timeout',
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      timings: { totalMs: timeoutError?.timeoutMs ?? this.executionTimeoutMs },
      diagnostic: timeoutError?.progress
        ? {
            schema: 'tracecode.runtime-diagnostic.v1',
            source: 'harness',
            component: 'CppWorkerClient',
            runtime: 'cpp',
            phase: 'execution-timeout',
            message: 'C++ execution timed out; terminating worker.',
            detail: {
              timeoutMs: timeoutError.timeoutMs,
              stage: timeoutError.stage,
              terminateWorker: this.shouldTerminateWorkerForTimeout(timeoutError.progress),
              lastProgress: timeoutError.progress,
            },
          }
        : undefined,
    };
  }

  private timeoutTraceResult(error: unknown): Extract<ExecutionResult, { kind: 'limit' }> {
    const timeoutError = error instanceof CppClientTimeoutError ? error : null;
    const trace = createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: CPP_DEFAULT_FILE });
    trace.events = [
      {
        kind: 'timeout',
        runId: 'cpp:run',
        file: CPP_DEFAULT_FILE,
        message: error instanceof Error ? error.message : String(error),
      },
    ];
    trace.traceStepCount = 1;
    return {
      kind: 'limit',
      reason: 'client-timeout',
      error: error instanceof Error ? error.message : String(error),
      trace,
      executionTimeMs: timeoutError?.timeoutMs ?? this.tracingTimeoutMs,
      consoleOutput: [],
      timings: { totalMs: timeoutError?.timeoutMs ?? this.tracingTimeoutMs },
      diagnostic: timeoutError?.progress
        ? {
            schema: 'tracecode.runtime-diagnostic.v1',
            source: 'harness',
            component: 'CppWorkerClient',
            runtime: 'cpp',
            phase: 'execution-timeout',
            message: 'C++ execution timed out; terminating worker.',
            detail: {
              timeoutMs: timeoutError.timeoutMs,
              stage: timeoutError.stage,
              terminateWorker: this.shouldTerminateWorkerForTimeout(timeoutError.progress),
              lastProgress: timeoutError.progress,
            },
          }
        : undefined,
    };
  }

  /** Non-worker cleanup shared by retires (preserve coordinator) and resets (full teardown). */
  private completeReset(reason: Error, preserveCompilerCoordinator: boolean): void {
    this.initPromise = null;
    if (!preserveCompilerCoordinator) this.warmupPromise = null;
    for (const controller of this.activeExternalCompileControllers) {
      controller.abort();
    }
    this.activeExternalCompileControllers.clear();
    if (!preserveCompilerCoordinator || this.pendingCompilerFrameRequests.size > 0) {
      this.clearCompilerFrames(reason);
    }
    if (!preserveCompilerCoordinator) {
      this.executionLifecycleGeneration += 1;
      this.executionResetReason = reason;
      this.compilerCoordinatorGeneration += 1;
      this.clearCompilerArtifactCache();
    }
  }

  private resetExecutionWorker(reason: Error, preserveCompilerCoordinator: boolean): void {
    this.suppressSessionClosedHook = true;
    try {
      this.core.closeSession(reason);
    } finally {
      this.suppressSessionClosedHook = false;
    }
    this.completeReset(reason, preserveCompilerCoordinator);
  }

  private terminateAndReset(reason: Error = new WorkerTerminatedError()): void {
    this.resetExecutionWorker(reason, false);
  }

  private retireExecutionWorker(): void {
    this.resetExecutionWorker(new WorkerTerminatedError('C++ execution worker completed and was retired'), true);
  }

  private assertLifecycleGeneration(expectedLifecycleGeneration?: number): void {
    if (
      expectedLifecycleGeneration !== undefined &&
      expectedLifecycleGeneration !== this.executionLifecycleGeneration
    ) {
      throw this.executionResetReason;
    }
  }

  private runInDisposableExecutionWorker<T>(operation: (lifecycleGeneration: number) => Promise<T>): Promise<T> {
    const lifecycleGeneration = this.executionLifecycleGeneration;
    const run = this.executionQueue.then(async () => {
      try {
        this.assertLifecycleGeneration(lifecycleGeneration);
        return await operation(lifecycleGeneration);
      } finally {
        this.retireExecutionWorker();
        if (lifecycleGeneration === this.executionLifecycleGeneration) {
          // Start the next clean worker as soon as this command retires. It only
          // receives trusted init state until the next queued command consumes
          // it, preserving one-command-per-worker isolation while moving worker
          // bootstrap into normal user think time.
          void this.init(lifecycleGeneration).catch(() => undefined);
        }
      }
    });
    this.executionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Prepared programs deliberately retain one execution worker for the
   * evaluation lifetime. The worker owns only immutable compiled modules;
   * every case instantiates a fresh WASI process, memory, and filesystem.
   */
  private runInPreparedExecutionWorker<T>(
    operation: (lifecycleGeneration: number) => Promise<T>
  ): Promise<T> {
    const lifecycleGeneration = this.executionLifecycleGeneration;
    const run = this.executionQueue.then(async () => {
      this.assertLifecycleGeneration(lifecycleGeneration);
      return operation(lifecycleGeneration);
    });
    this.executionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private assertPreparedProgramHandle(
    handle: CppPreparedProgramHandle,
    expectedMode?: 'code' | 'trace'
  ): void {
    if (handle.lifecycleGeneration !== this.executionLifecycleGeneration) {
      throw new Error(
        `C++ prepared program "${handle.programId}" is unavailable because its worker session was reset.`
      );
    }
    if (this.disposedPreparedPrograms.has(this.preparedProgramHandleKey(handle))) {
      throw new Error(`C++ prepared program "${handle.programId}" was already disposed.`);
    }
    if (expectedMode && handle.mode !== expectedMode) {
      throw new Error(
        `C++ prepared program "${handle.programId}" was prepared for ${handle.mode}, not ${expectedMode}.`
      );
    }
  }

  private preparedProgramHandleKey(handle: CppPreparedProgramHandle): string {
    return `${handle.lifecycleGeneration}:${handle.programId}`;
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
    // Worker-reported load failures arrive as prose from the compiler loader;
    // fetch failures are the one retryable class we recognize by text.
    return error instanceof WorkerReportedError && (
      error.message.includes('Failed to fetch') || error.message.includes('timed out')
    );
  }

  private sendInitEffect(expectedLifecycleGeneration?: number): Effect.Effect<InitResult, Error> {
    return Effect.suspend(() => {
      if (
        expectedLifecycleGeneration !== undefined &&
        expectedLifecycleGeneration !== this.executionLifecycleGeneration
      ) {
        return Effect.fail(this.executionResetReason);
      }
      return this.core.sendMessageEffect<InitResult>(
        'init',
        {
          assets: {
            clangWasmUrl: this.options.compilerWasmUrl,
            lldWasmUrl: this.options.linkerWasmUrl,
            sysrootUrl: this.options.sysrootUrl,
            runtimeHeaderUrl: this.options.runtimeHeaderUrl,
            compilerBundleUrl: this.options.compilerBundleUrl,
            compilerFrameEnabled: Boolean(this.externalCompilerUrl || (this.compilerFrameUrl && typeof document !== 'undefined')),
            compilerFrameUrl: this.compilerFrameUrl,
            compilerWorkerUrl: this.options.compilerWorkerUrl,
            toolchainIntegrity: this.options.compilerIntegrity,
          },
          ...this.workerOptionsPayload(),
        },
        this.initTimeoutMs,
        undefined,
        undefined,
        () => this.assertLifecycleGeneration(expectedLifecycleGeneration)
      );
    });
  }

  private initEffect(expectedLifecycleGeneration?: number): Effect.Effect<InitResult, Error> {
    const attempt = this.sendInitEffect(expectedLifecycleGeneration);
    return attempt.pipe(
      Effect.catchIf(
        (error): error is Error => {
          if (
            expectedLifecycleGeneration !== undefined &&
            expectedLifecycleGeneration !== this.executionLifecycleGeneration
          ) {
            return false;
          }
          return this.shouldResetRuntimeLoadError(error);
        },
        (error) =>
          Effect.suspend(() => {
            logRuntimeDiagnostic('warn', {
              component: 'CppWorkerClient',
              runtime: 'cpp',
              phase: 'init-retry',
              message: 'C++ worker init failed; resetting worker and retrying once.',
              detail: { message: error.message },
            }, { enabled: this.debug });
            this.terminateAndReset(error);
            return attempt;
          })
      )
    );
  }

  async init(expectedLifecycleGeneration?: number): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;

    const promise = this.core.runClientEffect(this.initEffect(expectedLifecycleGeneration));
    this.initPromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.initPromise === promise) this.initPromise = null;
      throw error;
    }
  }

  private workerOptionsPayload(): { idleTimeoutMs?: number; programCacheLimit?: number; usePrecompiledHeader?: boolean } {
    return {
      ...(this.options.workerIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.options.workerIdleTimeoutMs }),
      ...(this.options.programCacheLimit === undefined ? {} : { programCacheLimit: this.options.programCacheLimit }),
      ...(this.options.usePrecompiledHeader === undefined ? {} : { usePrecompiledHeader: this.options.usePrecompiledHeader }),
    };
  }

  async warmup(): Promise<WarmupResult> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = this.runInDisposableExecutionWorker(async (lifecycleGeneration) => {
      try {
        await this.init(lifecycleGeneration);
        return await this.core.sendMessage<WarmupResult>(
          'warmup',
          this.workerOptionsPayload(),
          this.initTimeoutMs,
          undefined,
          undefined,
          () => this.assertLifecycleGeneration(lifecycleGeneration)
        );
      } catch (error) {
        this.warmupPromise = null;
        throw error;
      }
    });
    return this.warmupPromise;
  }

  private clearCompilerFrames(reason: Error = new Error('C++ compiler frame was closed')): void {
    this.compilerFrameReadyReject?.(reason);
    this.compilerFrameReadyPromise = null;
    this.compilerFrameReadyResolve = null;
    this.compilerFrameReadyReject = null;
    if (this.compilerFrameMessageHandler) {
      globalThis.removeEventListener('message', this.compilerFrameMessageHandler);
      this.compilerFrameMessageHandler = null;
    }
    for (const [, pending] of this.pendingCompilerFrameRequests) {
      globalThis.clearTimeout(pending.timeoutId);
      pending.resolve({ success: false, error: reason.message });
    }
    this.pendingCompilerFrameRequests.clear();
    this.compilerFrame = null;
    this.compilerFrameTargetOrigin = '';
    this.compilerFrameToken = '';
    for (const frame of this.activeCompilerFrames) {
      frame.remove();
    }
    this.activeCompilerFrames.clear();
  }

  private compilerArtifactCacheLimit(): number {
    const requested = this.options.programCacheLimit ?? DEFAULT_CPP_COMPILER_ARTIFACT_CACHE_LIMIT;
    if (!Number.isFinite(requested)) return DEFAULT_CPP_COMPILER_ARTIFACT_CACHE_LIMIT;
    return Math.min(MAX_CPP_COMPILER_ARTIFACT_CACHE_LIMIT, Math.max(0, Math.floor(requested)));
  }

  private clearCompilerArtifactCache(): void {
    this.compilerArtifactCache.clear();
    this.compilerArtifactCacheBytes = 0;
  }

  private async compilerArtifactCacheKey(payload: unknown): Promise<string | null> {
    if (this.compilerArtifactCacheLimit() === 0 || !globalThis.crypto?.subtle) return null;
    const canonical = canonicalCompilerPayload(payload);
    if (canonical === null) return null;
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`tracecode.cpp.compiler-artifact.v1\0${canonical}`)
    );
    return bytesToHex(new Uint8Array(digest));
  }

  private cachedCompilerArtifact(cacheKey: string): Record<string, unknown> | null {
    const cached = this.compilerArtifactCache.get(cacheKey);
    if (!cached) return null;
    this.compilerArtifactCache.delete(cacheKey);
    this.compilerArtifactCache.set(cacheKey, cached);
    const timings = cached.result.timings && typeof cached.result.timings === 'object'
      ? cached.result.timings as Record<string, unknown>
      : {};
    return {
      ...cached.result,
      success: true,
      programBuffer: cached.bytes.slice().buffer,
      compileMs: 0,
      artifactDigest: cacheKey,
      timings: {
        ...timings,
        compileCacheHit: true,
        artifactCacheHit: true,
      },
    };
  }

  private storeCompilerArtifact(
    cacheKey: string,
    payload: unknown,
    result: Record<string, unknown>
  ): Record<string, unknown> {
    if (result.success !== true || !(result.programBuffer instanceof ArrayBuffer)) return result;
    const bytes = new Uint8Array(result.programBuffer);
    const isClassicDriver = Boolean(
      payload &&
        typeof payload === 'object' &&
        typeof (payload as { driverSource?: unknown }).driverSource === 'string' &&
        !(payload as { project?: unknown }).project
    );
    if (isClassicDriver && !WebAssembly.validate(bytes)) {
      return {
        success: false,
        error: 'C++ compiler returned an invalid WebAssembly program artifact.',
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
      };
    }
    if (bytes.byteLength > MAX_CPP_COMPILER_ARTIFACT_BYTES) return result;

    const storedResult = { ...result };
    delete storedResult.programBuffer;
    const existing = this.compilerArtifactCache.get(cacheKey);
    if (existing) {
      this.compilerArtifactCacheBytes -= existing.bytes.byteLength;
      this.compilerArtifactCache.delete(cacheKey);
    }
    const cachedBytes = bytes.slice();
    this.compilerArtifactCache.set(cacheKey, { bytes: cachedBytes, result: storedResult });
    this.compilerArtifactCacheBytes += cachedBytes.byteLength;
    const limit = this.compilerArtifactCacheLimit();
    while (
      this.compilerArtifactCache.size > limit ||
      this.compilerArtifactCacheBytes > MAX_CPP_COMPILER_ARTIFACT_CACHE_BYTES
    ) {
      const oldestKey = this.compilerArtifactCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.compilerArtifactCache.get(oldestKey);
      this.compilerArtifactCache.delete(oldestKey);
      if (oldest) this.compilerArtifactCacheBytes -= oldest.bytes.byteLength;
    }
    return {
      ...result,
      artifactDigest: cacheKey,
      timings: {
        ...(result.timings && typeof result.timings === 'object'
          ? result.timings as Record<string, unknown>
          : {}),
        compileCacheHit: false,
        artifactCacheHit: false,
      },
    };
  }

  private async handleCompileRequest(message: WorkerSessionMessage, worker: BrowserWorkerLike): Promise<void> {
    if (!message.requestId) return;
    const coordinatorGeneration = this.compilerCoordinatorGeneration;

    const cacheKey = await this.compilerArtifactCacheKey(message.payload);
    // Hashing is asynchronous. The caller may cancel and retire this client
    // while Web Crypto is still producing the cache key. Never let that stale
    // continuation create a new compiler iframe after terminate() has already
    // removed the client's owned resources.
    if (
      coordinatorGeneration !== this.compilerCoordinatorGeneration ||
      worker !== this.core.currentSession?.worker
    ) {
      return;
    }
    const cached = cacheKey ? this.cachedCompilerArtifact(cacheKey) : null;
    const compiled = cached ?? (this.externalCompilerUrl
      ? await this.compileWithExternalUrl(message.payload)
      : await this.compileInFrame(message.payload));
    if (
      coordinatorGeneration !== this.compilerCoordinatorGeneration ||
      worker !== this.core.currentSession?.worker
    ) {
      return;
    }
    const result = !cached && cacheKey
      ? this.storeCompilerArtifact(cacheKey, message.payload, compiled)
      : compiled;
    const transfer = result?.programBuffer instanceof ArrayBuffer ? [result.programBuffer] : [];
    worker.postMessage(
      {
        type: 'compile-response',
        requestId: message.requestId,
        protocolToken: message.protocolToken,
        payload: result,
      },
      transfer
    );
  }

  private async compileWithExternalUrl(payload: unknown): Promise<Record<string, unknown>> {
    if (!this.externalCompilerUrl) {
      return { success: false, error: 'C++ external compiler URL is not configured.' };
    }

    const controller = new AbortController();
    this.activeExternalCompileControllers.add(controller);
    let response: Response;
    try {
      response = await fetch(this.externalCompilerUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/wasm, application/json',
        },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.activeExternalCompileControllers.delete(controller);
    }

    const headerNumber = (name: string): number | undefined => {
      const value = response.headers.get(name);
      if (!value) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const headerBoolean = (name: string): boolean | undefined => {
      const value = response.headers.get(name);
      if (value === null) return undefined;
      return value === 'true';
    };

    const timings = {
      ...(headerNumber('x-tracecode-pch-ms') === undefined ? {} : { pchMs: headerNumber('x-tracecode-pch-ms') }),
      ...(headerBoolean('x-tracecode-pch-cache-hit') === undefined
        ? {}
        : { pchCacheHit: headerBoolean('x-tracecode-pch-cache-hit') }),
      ...(headerBoolean('x-tracecode-pch-fallback') === undefined
        ? {}
        : { pchFallback: headerBoolean('x-tracecode-pch-fallback') }),
    };

    if (response.ok) {
      const programBuffer = await response.arrayBuffer();
      return {
        success: true,
        programBuffer,
        stdout: '',
        stderr: '',
        compileMs: headerNumber('x-tracecode-compile-ms'),
        timings,
      };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body = (await response.json()) as Record<string, unknown>;
        return {
          success: false,
          error: typeof body.error === 'string' ? body.error : `C++ external compiler failed with HTTP ${response.status}.`,
          stdout: typeof body.stdout === 'string' ? body.stdout : '',
          stderr: typeof body.stderr === 'string' ? body.stderr : '',
          compileMs: typeof body.compileMs === 'number' ? body.compileMs : headerNumber('x-tracecode-compile-ms'),
          timings: typeof body.timings === 'object' && body.timings !== null ? body.timings : timings,
        };
      } catch {
        // Fall through to text response handling below.
      }
    }

    const text = await response.text().catch(() => '');
    return {
      success: false,
      error: text || `C++ external compiler failed with HTTP ${response.status}.`,
      stdout: '',
      stderr: text,
      compileMs: headerNumber('x-tracecode-compile-ms'),
      timings,
    };
  }

  private ensureCompilerFrame(): Promise<void> {
    if (!this.compilerFrameUrl || typeof document === 'undefined') {
      return Promise.reject(new Error('C++ compiler frame is not available.'));
    }
    if (this.compilerFrame && this.compilerFrameReadyPromise) return this.compilerFrameReadyPromise;

    const frameUrl = new URL(this.compilerFrameUrl, globalThis.location?.href);
    const hostOrigin = new URL(globalThis.location?.href ?? frameUrl.href).origin;
    const compilerWorkerUrl = this.options.compilerWorkerUrl
      ? new URL(this.options.compilerWorkerUrl, globalThis.location?.href ?? frameUrl.href)
      : new URL('cpp-compiler-worker.js', frameUrl.href);
    if (compilerWorkerUrl.origin !== frameUrl.origin) {
      return Promise.reject(new Error('C++ compiler worker must be served from the compiler frame origin.'));
    }
    this.compilerFrameTargetOrigin = frameUrl.origin;
    this.compilerFrameToken = createWorkerProtocolToken();
    frameUrl.searchParams.set('tracecodeFrameToken', this.compilerFrameToken);
    frameUrl.searchParams.set('tracecodeParentOrigin', hostOrigin);
    frameUrl.searchParams.set('tracecodeCompilerWorkerUrl', compilerWorkerUrl.href);
    const iframe = document.createElement('iframe');
    iframe.src = frameUrl.href;
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');
    this.compilerFrame = iframe;
    this.activeCompilerFrames.add(iframe);

    this.compilerFrameReadyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout>;

      const finishReady = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        this.compilerFrameReadyResolve = null;
        this.compilerFrameReadyReject = null;
        resolve();
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return;
        if (event.origin !== this.compilerFrameTargetOrigin) return;
        if ((event.data as { frameToken?: unknown })?.frameToken !== this.compilerFrameToken) return;
        if ((event.data as { type?: string })?.type === 'frame-ready') {
          finishReady();
          return;
        }
        const requestId = (event.data as { id?: string })?.id;
        if (!requestId) return;
        const pending = this.pendingCompilerFrameRequests.get(requestId);
        if (!pending) return;
        if ((event.data as { protocolToken?: unknown })?.protocolToken !== pending.protocolToken) return;
        this.pendingCompilerFrameRequests.delete(requestId);
        globalThis.clearTimeout(pending.timeoutId);
        const response = event.data as { payload?: Record<string, unknown> };
        pending.resolve(response.payload ?? { success: false, error: 'C++ compiler frame returned an empty response.' });
      };
      this.compilerFrameMessageHandler = onMessage;

      timeoutId = globalThis.setTimeout(() => {
        const error = new Error('C++ compiler frame request timed out.');
        this.clearCompilerFrames(error);
        reject(error);
      }, this.initTimeoutMs);

      this.compilerFrameReadyResolve = finishReady;
      this.compilerFrameReadyReject = (error: Error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        reject(error);
      };
      globalThis.addEventListener('message', onMessage);
      document.body.appendChild(iframe);
    });
    return this.compilerFrameReadyPromise;
  }

  private async compileInFrame(payload: unknown): Promise<Record<string, unknown>> {
    try {
      await this.ensureCompilerFrame();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    const iframe = this.compilerFrame;
    const frameWindow = iframe?.contentWindow;
    if (!frameWindow) {
      return { success: false, error: 'C++ compiler frame is not available.' };
    }

    return new Promise((resolve) => {
      const requestId = `compile-${++this.compilerFrameRequestId}`;
      const protocolToken = createWorkerProtocolToken();
      const timeoutId = globalThis.setTimeout(() => {
        this.pendingCompilerFrameRequests.delete(requestId);
        resolve({ success: false, error: 'C++ compiler frame request timed out.' });
        this.clearCompilerFrames(new Error('C++ compiler frame request timed out.'));
      }, this.initTimeoutMs);
      this.pendingCompilerFrameRequests.set(requestId, { protocolToken, resolve, timeoutId });
      frameWindow.postMessage(
        {
          id: requestId,
          type: 'compile',
          frameToken: this.compilerFrameToken,
          protocolToken,
          payload,
        },
        this.compilerFrameTargetOrigin
      );
    });
  }

  /** Runtime load ahead of an execution. Memoization stays Promise-based on the client. */
  private initGateEffect(expectedLifecycleGeneration: number): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.init(expectedLifecycleGeneration).then(() => {
        this.assertLifecycleGeneration(expectedLifecycleGeneration);
      }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  private runExecution<T>(
    sendEffect: Effect.Effect<T, Error>,
    timeoutMs: number,
    stage: CppClientTimeoutStage,
    signal: AbortSignal | undefined,
    expectedLifecycleGeneration: number
  ): Promise<T> {
    const program = this.initGateEffect(expectedLifecycleGeneration).pipe(
      Effect.andThen(this.withCppExecutionDeadline(sendEffect, timeoutMs, stage))
    );
    return this.core.runClientEffect(program, signal);
  }

  async prepareRuntimeProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<CppPreparedProgramPreparationResult> {
    const timeoutMs = call.mode === 'trace'
      ? this.tracingTimeoutMs
      : this.executionTimeoutMs;
    const stage: CppClientTimeoutStage = call.mode === 'trace'
      ? 'trace'
      : 'compile-run';

    return this.runInPreparedExecutionWorker(async (lifecycleGeneration) => {
      try {
        const result = await this.runExecution(
          this.core.sendMessageEffect<CppPreparedProgramWorkerResult>(
            'prepare-runtime-program',
            {
              mode: call.mode,
              code: call.code,
              functionName: call.functionName,
              executionStyle: call.executionStyle,
              traceOptions: call.traceOptions,
            },
            null,
            undefined,
            undefined,
            () => this.assertLifecycleGeneration(lifecycleGeneration)
          ),
          timeoutMs,
          stage,
          call.signal,
          lifecycleGeneration
        );
        if (
          result.success === true &&
          typeof result.programId === 'string' &&
          (result.mode === 'code' || result.mode === 'trace')
        ) {
          const handle: CppPreparedProgramHandle = {
            programId: result.programId,
            mode: result.mode,
            lifecycleGeneration,
          };
          return {
            success: true,
            handle,
            consoleOutput: result.consoleOutput ?? [],
            ...(result.timings ? { timings: result.timings } : {}),
          };
        }
        return {
          success: false,
          error: result.error ?? 'C++ program preparation failed.',
          consoleOutput: result.consoleOutput ?? [],
          ...(result.errorLine !== undefined ? { errorLine: result.errorLine } : {}),
          ...(result.diagnosticStage !== undefined
            ? { diagnosticStage: result.diagnosticStage }
            : {}),
          ...(result.timings ? { timings: result.timings } : {}),
          ...(result.timeoutReason === 'client-timeout'
            ? { limitReason: 'client-timeout' as const }
            : {}),
        };
      } catch (error) {
        if (!this.isClientTimeout(error)) throw error;
        const timeout = this.timeoutCodeResult(error);
        return {
          success: false,
          error: timeout.error,
          consoleOutput: timeout.consoleOutput,
          timings: timeout.timings,
          limitReason: 'client-timeout',
        };
      }
    });
  }

  async executePreparedCode(
    handle: CppPreparedProgramHandle,
    call: RuntimePreparedCodeCall
  ): Promise<CodeExecutionResult> {
    const wallClockMs = call.limits?.wallClockMs ?? this.executionTimeoutMs;
    return this.runInPreparedExecutionWorker(async (lifecycleGeneration) => {
      this.assertPreparedProgramHandle(handle, 'code');
      try {
        const result = await this.runExecution(
          this.core.sendMessageEffect<RawExecutionPayload>(
            'execute-prepared-runtime-program',
            {
              programId: handle.programId,
              mode: 'code',
              inputs: call.inputs,
            },
            null,
            undefined,
            undefined,
            () => {
              this.assertLifecycleGeneration(lifecycleGeneration);
              this.assertPreparedProgramHandle(handle, 'code');
            }
          ),
          wallClockMs,
          'compile-run',
          call.signal,
          lifecycleGeneration
        );
        return liftCodeOutcome(result, 'C++ prepared execution failed');
      } catch (error) {
        if (this.isClientTimeout(error)) return this.timeoutCodeResult(error);
        throw error;
      }
    });
  }

  async executePreparedTrace(
    handle: CppPreparedProgramHandle,
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult> {
    const wallClockMs = call.limits?.wallClockMs ?? this.tracingTimeoutMs;
    return this.runInPreparedExecutionWorker(async (lifecycleGeneration) => {
      this.assertPreparedProgramHandle(handle, 'trace');
      try {
        const result = await this.runExecution(
          this.core.sendMessageEffect<CppRawTraceResult>(
            'execute-prepared-runtime-program',
            {
              programId: handle.programId,
              mode: 'trace',
              inputs: call.inputs,
              traceEventTransport: traceEventTransferRequest(),
            },
            null,
            undefined,
            undefined,
            () => {
              this.assertLifecycleGeneration(lifecycleGeneration);
              this.assertPreparedProgramHandle(handle, 'trace');
            }
          ),
          wallClockMs,
          'trace',
          call.signal,
          lifecycleGeneration
        );
        return liftTraceOutcome(
          result,
          result.trace ??
            createEmptyRuntimeTrace('cpp', {
              runId: 'cpp:run',
              file: CPP_DEFAULT_FILE,
            }),
          'C++ prepared tracing failed'
        );
      } catch (error) {
        if (this.isClientTimeout(error)) return this.timeoutTraceResult(error);
        throw error;
      }
    });
  }

  async disposePreparedProgram(handle: CppPreparedProgramHandle): Promise<void> {
    const handleKey = this.preparedProgramHandleKey(handle);
    if (this.disposedPreparedPrograms.has(handleKey)) {
      throw new Error(`C++ prepared program "${handle.programId}" was already disposed.`);
    }
    if (handle.lifecycleGeneration !== this.executionLifecycleGeneration) {
      // A timeout, caller abort, crash, or explicit termination already
      // destroyed the worker and therefore the worker-owned program table.
      this.disposedPreparedPrograms.add(handleKey);
      return;
    }
    return this.runInPreparedExecutionWorker(async (lifecycleGeneration) => {
      this.assertPreparedProgramHandle(handle);
      const result = await this.runExecution(
        this.core.sendMessageEffect<{ success: boolean }>(
          'dispose-prepared-runtime-program',
          {
            programId: handle.programId,
            mode: handle.mode,
          },
          null,
          undefined,
          undefined,
          () => {
            this.assertLifecycleGeneration(lifecycleGeneration);
            this.assertPreparedProgramHandle(handle);
          }
        ),
        this.executionTimeoutMs,
        'compile-run',
        undefined,
        lifecycleGeneration
      );
      if (result.success !== true) {
        throw new Error(`C++ prepared program "${handle.programId}" could not be disposed.`);
      }
      this.disposedPreparedPrograms.add(handleKey);
    });
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    const { code, functionName, inputs, executionStyle = 'solution-method', signal, limits } = call;
    const wallClockMs = limits?.wallClockMs ?? this.executionTimeoutMs;
    return this.runInDisposableExecutionWorker(async (lifecycleGeneration) => {
      try {
        const result = await this.runExecution(
          this.core.sendMessageEffect<RawExecutionPayload>(
            'compile-run',
            { code, functionName, inputs, executionStyle },
            null, // the enclosing execution deadline is the only clock
            undefined,
            undefined,
            () => this.assertLifecycleGeneration(lifecycleGeneration)
          ),
          wallClockMs,
          'compile-run',
          signal,
          lifecycleGeneration
        );
        return liftCodeOutcome(result, 'C++ execution failed');
      } catch (error) {
        if (this.isClientTimeout(error)) return this.timeoutCodeResult(error);
        throw error;
      }
    });
  }

  async executeCodeBatch(call: RuntimeBatchCall): Promise<CodeExecutionBatchResult> {
    const { code, functionName, inputBatch, executionStyle = 'solution-method', signal } = call;
    return this.runInDisposableExecutionWorker(async (lifecycleGeneration) => {
      try {
        const result = await this.runExecution(
          this.core.sendMessageEffect<RawExecutionBatchPayload>(
            'compile-run-batch',
            { code, functionName, inputBatch, executionStyle },
            null,
            undefined,
            undefined,
            () => this.assertLifecycleGeneration(lifecycleGeneration)
          ),
          this.executionTimeoutMs,
          'compile-run',
          signal,
          lifecycleGeneration
        );
        return liftCodeBatchOutcome(result, 'C++ execution failed');
      } catch (error) {
        if (!this.isClientTimeout(error)) throw error;
        const timeout = this.timeoutCodeResult(error);
        return {
          results: inputBatch.map(() => timeout),
          error: timeout.error,
          consoleOutput: timeout.consoleOutput,
          timings: timeout.timings,
        };
      }
    });
  }

  async executeTraceBatch(call: RuntimeBatchCall & { traceOptions?: TraceExecutionOptions }): Promise<{ results: ExecutionResult[]; error?: string; consoleOutput?: string[]; timings?: RuntimeExecutionTimings }> {
    const { code, functionName, inputBatch, traceOptions, executionStyle = 'solution-method', signal } = call;
    return this.runInDisposableExecutionWorker(async (lifecycleGeneration) => {
      try {
        const result = await this.runExecution(
          this.core.sendMessageEffect<{ results?: CppRawTraceResult[]; error?: string; consoleOutput?: string[]; timings?: RuntimeExecutionTimings }>(
            'execute-trace-batch',
            {
              code,
              functionName,
              inputBatch,
              options: traceOptions,
              executionStyle,
              traceEventTransport: traceEventTransferRequest(),
            },
            null,
            undefined,
            undefined,
            () => this.assertLifecycleGeneration(lifecycleGeneration)
          ),
          this.tracingTimeoutMs,
          'trace',
          signal,
          lifecycleGeneration
        );
        return {
          results: (result.results ?? []).map((entry) =>
            liftTraceOutcome(
              entry,
              entry.trace ?? createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: CPP_DEFAULT_FILE }),
              'C++ tracing failed'
            )
          ),
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(result.consoleOutput ? { consoleOutput: result.consoleOutput } : {}),
          ...(result.timings ? { timings: result.timings } : {}),
        };
      } catch (error) {
        if (!this.isClientTimeout(error)) throw error;
        const timeout = this.timeoutTraceResult(error);
        return {
          results: inputBatch.map(() => timeout),
          error: timeout.error,
          consoleOutput: timeout.consoleOutput,
          timings: timeout.timings,
        };
      }
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    const { code, inputs, traceOptions, executionStyle = 'solution-method', signal } = call;
    const functionName = call.functionName ?? '';
    return this.runInDisposableExecutionWorker(async (lifecycleGeneration) => {
      try {
        const result = await this.runExecution(
          this.core.sendMessageEffect<CppRawTraceResult>(
            'execute-with-tracing',
            {
              code,
              functionName,
              inputs,
              options: traceOptions,
              executionStyle,
              traceEventTransport: traceEventTransferRequest(),
            },
            null,
            undefined,
            undefined,
            () => this.assertLifecycleGeneration(lifecycleGeneration)
          ),
          this.tracingTimeoutMs,
          'trace',
          signal,
          lifecycleGeneration
        );
        return liftTraceOutcome(
          result,
          result.trace ?? createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: CPP_DEFAULT_FILE }),
          'C++ tracing failed'
        );
      } catch (error) {
        if (this.isClientTimeout(error)) return this.timeoutTraceResult(error);
        throw error;
      }
    });
  }

  async executeProjectCpp(
    request: CppProjectCommandRequest,
    timeoutMs = this.executionTimeoutMs,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal,
    engineLease?: RuntimeProjectEngineLeaseController
  ): Promise<CppProjectCommandResult> {
    // C++ execution workers are already one-command resources. The retained
    // compiler coordinator is trusted host infrastructure, not process state,
    // so TraceKernel observes a destroy-only engine lease here.
    engineLease?.attach({ release: () => undefined });
    return this.runInDisposableExecutionWorker(async (lifecycleGeneration) => {
      const {
        signal: _signal,
        onEvent: _requestOnEvent,
        engineLease: _engineLease,
        kernelHttp,
        kernelSyscalls,
        kernelSignals,
        ...workerRequest
      } = request;
      if (!this.externalCompilerUrl && workerRequest.source === 'compile') {
        await this.options.runtimeAssetPreflight?.();
        this.assertLifecycleGeneration(lifecycleGeneration);
      }
      return this.runExecution(
        this.core.sendMessageEffect<CppProjectCommandResult>(
          'execute-project-cpp',
          {
            ...workerRequest,
            projectUserAuthorityMode: 'permanent',
            ...this.workerOptionsPayload(),
          },
          null,
          onEvent,
          kernelHttp,
          () => this.assertLifecycleGeneration(lifecycleGeneration),
          kernelSyscalls,
          kernelSignals
        ),
        timeoutMs,
        'compile-run',
        signal,
        lifecycleGeneration
      );
    });
  }

  terminate(): void {
    this.terminateAndReset();
  }
}
