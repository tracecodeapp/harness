import type {
  CodeExecutionResult,
  CodeExecutionBatchResult,
  ExecutionResult,
  RuntimeExecutionTimings,
} from '@tracecode/harness-core';
import type {
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeProjectCommandRequest,
} from '@tracecode/harness-core';
import { createEmptyRuntimeTrace } from '@tracecode/harness-core';
import type { TraceExecutionOptions } from '@tracecode/harness-core';
import {
  closeKernelHttpSyncServers,
  handleKernelHttpCloseMessage,
  handleKernelHttpDispatchSyncMessage,
  handleKernelHttpListenSyncMessage,
  type KernelHttpSyncServerBridge,
} from './kernel-http-sync';
import { logRuntimeDiagnostic } from './runtime-diagnostics';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from './trace-event-transport';
import { createWorkerProtocolToken } from './worker-protocol';

type MessageId = string;

const CPP_KERNEL_HTTP_RUNTIME_LABEL = 'C++';

export type CppExecutionStyle = 'function' | 'solution-method' | 'ops-class';
export type CppProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CppProjectCommandResult = RuntimeCommandResult;

export interface CppWorkerAssets {
  clangWasmUrl: string;
  lldWasmUrl: string;
  sysrootUrl: string;
  runtimeHeaderUrl: string;
  compilerBundleUrl: string;
  compilerFrameUrl?: string;
  compilerWorkerUrl?: string;
  toolchainIntegrity?: CppToolchainIntegrityManifest;
}

export interface CppWorkerClientOptions extends CppWorkerAssets {
  workerUrl: string;
  /** Verifies the execution-worker asset before constructing a Worker. */
  assetPreflight?: () => Promise<void>;
  /** Verifies compiler-frame and toolchain assets only when compilation is requested. */
  runtimeAssetPreflight?: () => Promise<void>;
  debug?: boolean;
  initTimeoutMs?: number;
  executionTimeoutMs?: number;
  tracingTimeoutMs?: number;
  interviewTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  programCacheLimit?: number;
  usePrecompiledHeader?: boolean;
  externalCompilerUrl?: string;
}

export interface CppToolchainIntegrityEntry {
  url: string;
  sha256: string;
  size?: number;
}

export interface CppToolchainIntegrityManifest {
  assets: readonly CppToolchainIntegrityEntry[];
}

interface PendingMessage {
  protocolToken: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: RuntimeCommandEventHandler;
  kernelHttp?: RuntimeKernelHttpBridge;
  httpServers?: Map<string, KernelHttpSyncServerBridge>;
  timeoutId?: ReturnType<typeof setTimeout>;
  lastProgress?: CppRuntimeProgress;
}

function createExecutionAbortError(): Error {
  return Object.assign(new Error('Execution aborted'), { name: 'AbortError' });
}

interface PendingCompilerFrameRequest {
  protocolToken: string;
  resolve: (value: Record<string, unknown>) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

type CppClientTimeoutStage = 'compile-run' | 'trace' | 'interview';

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

interface WorkerMessage {
  id?: MessageId;
  type: string;
  requestId?: string;
  payload?: unknown;
  protocolToken?: string;
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

const INIT_TIMEOUT_MS = 120_000;
// The outer client timeout is the hard product budget. Compiler and runtime
// phases report progress separately so timeout diagnostics show where we died.
const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 20_000;
const INTERVIEW_MODE_TIMEOUT_MS = 30_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const CPP_DEFAULT_FILE = 'solution.cpp';
const DEFAULT_CPP_COMPILER_ARTIFACT_CACHE_LIMIT = 32;
const MAX_CPP_COMPILER_ARTIFACT_CACHE_LIMIT = 512;
const MAX_CPP_COMPILER_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_CPP_COMPILER_ARTIFACT_CACHE_BYTES = 64 * 1024 * 1024;

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
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private readonly debug: boolean;
  private readonly initTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly tracingTimeoutMs: number;
  private readonly interviewTimeoutMs: number;
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
  private compilerArtifactCache = new Map<string, CppCompilerArtifactCacheEntry>();
  private compilerArtifactCacheBytes = 0;
  private compilerCoordinatorGeneration = 0;
  private executionLifecycleGeneration = 0;
  private executionResetReason = new Error('C++ execution worker was reset');

  constructor(private readonly options: CppWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    this.tracingTimeoutMs = options.tracingTimeoutMs ?? TRACING_TIMEOUT_MS;
    this.interviewTimeoutMs = options.interviewTimeoutMs ?? INTERVIEW_MODE_TIMEOUT_MS;
    this.compilerFrameUrl = options.compilerFrameUrl;
    this.externalCompilerUrl = options.externalCompilerUrl;
  }

  isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    if (!this.isSupported()) {
      throw new Error('Web Workers are not supported in this environment');
    }

    this.workerReadyPromise = new Promise((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = (error: Error) => reject(error);
    });

    const workerUrl =
      this.debug && !this.options.workerUrl.includes('?')
        ? `${this.options.workerUrl}?dev=${Date.now()}`
        : this.options.workerUrl;

    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, type, payload, protocolToken } = event.data;

      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        logRuntimeDiagnostic('info', {
          component: 'CppWorkerClient',
          runtime: 'cpp',
          phase: 'worker-ready',
          message: 'C++ worker is ready.',
        }, { enabled: this.debug });
        return;
      }

      if (type === 'idle-timeout') {
        logRuntimeDiagnostic('info', {
          component: 'CppWorkerClient',
          runtime: 'cpp',
          phase: 'idle-timeout',
          message: 'C++ worker closed after idle timeout.',
        }, { enabled: this.debug });
        this.terminateAndReset(new Error('C++ worker closed after idle timeout'));
        return;
      }

      if (type === 'compile-request') {
        if (!this.hasPendingProtocolToken(protocolToken)) return;
        this.handleCompileRequest(event.data).catch((error) => {
          if (!event.data.requestId) return;
          this.worker?.postMessage({
            type: 'compile-response',
            requestId: event.data.requestId,
            protocolToken: event.data.protocolToken,
            payload: { success: false, error: error instanceof Error ? error.message : String(error) },
          });
        });
        return;
      }

      if (!id) return;
      const pending = this.pendingMessages.get(id);
      if (!pending) return;
      if (protocolToken !== pending.protocolToken) return;
      if (type === 'project-event') {
        pending.onEvent?.(payload as RuntimeCommandEvent);
        return;
      }
      if (type === 'runtime-progress') {
        const progress = payload && typeof payload === 'object' ? (payload as CppRuntimeProgress) : {};
        pending.lastProgress = progress;
        this.lastRuntimeProgress = progress;
        return;
      }
      if (type === 'kernel-http-dispatch-sync') {
        handleKernelHttpDispatchSyncMessage(pending, payload, CPP_KERNEL_HTTP_RUNTIME_LABEL);
        return;
      }
      if (type === 'kernel-http-listen-sync') {
        handleKernelHttpListenSyncMessage(pending, payload, CPP_KERNEL_HTTP_RUNTIME_LABEL);
        return;
      }
      if (type === 'kernel-http-close') {
        handleKernelHttpCloseMessage(pending, payload, CPP_KERNEL_HTTP_RUNTIME_LABEL);
        return;
      }
      this.pendingMessages.delete(id);
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      closeKernelHttpSyncServers(pending, CPP_KERNEL_HTTP_RUNTIME_LABEL);

      if (type === 'error') {
        pending.reject(new Error((payload as { error: string }).error));
        return;
      }

      try {
        pending.resolve(restoreTransferredTraceEvents(payload));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    this.worker.onerror = (error) => {
      logRuntimeDiagnostic('error', {
        component: 'CppWorkerClient',
        runtime: 'cpp',
        phase: 'worker-error',
        message: 'C++ worker emitted an error event.',
        detail: {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        },
      });
      const workerError = new Error(error.message || 'C++ worker error');
      this.workerReadyReject?.(workerError);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;
      this.terminateAndReset(workerError);
    };

    return this.worker;
  }

  private async waitForWorkerReady(): Promise<void> {
    const readyPromise = this.workerReadyPromise;
    if (!readyPromise) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = new Error(
          `C++ worker failed to initialize in time (${Math.round(WORKER_READY_TIMEOUT_MS / 1000)}s)`
        );
        logRuntimeDiagnostic('warn', {
          component: 'CppWorkerClient',
          runtime: 'cpp',
          phase: 'worker-ready-timeout',
          message: 'C++ worker did not send worker-ready before the timeout.',
          detail: { timeoutMs: WORKER_READY_TIMEOUT_MS },
        }, { enabled: this.debug });
        this.terminateAndReset(timeoutError);
        reject(timeoutError);
      }, WORKER_READY_TIMEOUT_MS);

      readyPromise
        .then(() => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          resolve();
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async sendMessage<T>(
    type: string,
    payload?: unknown,
    timeoutMs = MESSAGE_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    kernelHttp?: RuntimeKernelHttpBridge,
    expectedLifecycleGeneration?: number
  ): Promise<T> {
    await this.options.assetPreflight?.();
    if (
      expectedLifecycleGeneration !== undefined &&
      expectedLifecycleGeneration !== this.executionLifecycleGeneration
    ) {
      throw this.executionResetReason;
    }
    if (this.messageRequiresCompilerAssets(type, payload)) {
      await this.options.runtimeAssetPreflight?.();
    }
    const worker = this.getWorker();
    await this.waitForWorkerReady();
    if (
      expectedLifecycleGeneration !== undefined &&
      expectedLifecycleGeneration !== this.executionLifecycleGeneration
    ) {
      throw this.executionResetReason;
    }
    const id = String(++this.messageId);
    const protocolToken = createWorkerProtocolToken();

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        protocolToken,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onEvent ? { onEvent } : {}),
        ...(kernelHttp ? { kernelHttp } : {}),
        httpServers: new Map(),
      });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
        closeKernelHttpSyncServers(pending, CPP_KERNEL_HTTP_RUNTIME_LABEL);
        logRuntimeDiagnostic('warn', {
          component: 'CppWorkerClient',
          runtime: 'cpp',
          phase: 'worker-request-timeout',
          message: 'C++ worker request timed out.',
          detail: { id, type, timeoutMs },
        }, { enabled: this.debug });
        pending.reject(new Error(`Worker request timed out: ${type}`));
      }, timeoutMs);

      const pending = this.pendingMessages.get(id);
      if (pending) pending.timeoutId = timeoutId;

      worker.postMessage({ id, type, payload, protocolToken });
    });
  }

  private messageRequiresCompilerAssets(type: string, payload: unknown): boolean {
    if (type === 'init' || type === 'status') return false;
    if (this.externalCompilerUrl) return false;
    if (type !== 'execute-project-cpp') return true;
    return Boolean(
      payload &&
        typeof payload === 'object' &&
        (payload as { source?: unknown }).source === 'compile'
    );
  }

  private hasPendingProtocolToken(protocolToken: unknown): protocolToken is string {
    return typeof protocolToken === 'string' &&
      Array.from(this.pendingMessages.values()).some((pending) => pending.protocolToken === protocolToken);
  }

  private async executeWithTimeout<T>(
    executor: () => Promise<T>,
    timeoutMs: number,
    stage: CppClientTimeoutStage,
    signal?: AbortSignal
  ): Promise<T> {
    this.lastRuntimeProgress = null;
    if (signal?.aborted) {
      const abortError = createExecutionAbortError();
      this.terminateAndReset(abortError);
      throw abortError;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        globalThis.clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const abortError = createExecutionAbortError();
        this.terminateAndReset(abortError);
        settleReject(abortError);
      };
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        const progress = this.lastRuntimeProgress;
        const shouldTerminate = this.shouldTerminateWorkerForTimeout(progress);
        const timeoutLabel =
          stage === 'trace'
            ? 'tracing'
            : stage === 'interview'
              ? 'interview execution'
              : 'compile/run';
        const timeoutError = new CppClientTimeoutError(
          `C++ ${timeoutLabel} timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          stage,
          timeoutMs,
          this.lastRuntimeProgress ?? undefined
        );
        logRuntimeDiagnostic('warn', {
          component: 'CppWorkerClient',
          runtime: 'cpp',
          phase: 'execution-timeout',
          message: 'C++ execution timed out; terminating worker.',
          detail: { timeoutMs, stage, terminateWorker: shouldTerminate, lastProgress: progress ?? undefined },
        }, { enabled: this.debug });
        if (shouldTerminate) {
          this.terminateAndReset(timeoutError);
        }
        reject(timeoutError);
      }, timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });

      executor()
        .then((result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private isClientTimeout(error: unknown): boolean {
    return (
      error instanceof CppClientTimeoutError ||
      (error instanceof Error && error.message.includes('C++') && error.message.includes('timed out'))
    );
  }

  private shouldTerminateWorkerForTimeout(progress: CppRuntimeProgress | null): boolean {
    void progress;
    return true;
  }

  private timeoutCodeResult(error: unknown): CodeExecutionResult {
    const timeoutError = error instanceof CppClientTimeoutError ? error : null;
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      timeoutReason: 'client-timeout',
      diagnosticStage: timeoutError?.stage === 'interview' ? 'interview' : 'runtime',
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

  private timeoutTraceResult(error: unknown): ExecutionResult {
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
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      trace,
      executionTimeMs: timeoutError?.timeoutMs ?? this.tracingTimeoutMs,
      consoleOutput: [],
      traceLimitExceeded: true,
      timeoutReason: 'client-timeout',
      lineEventCount: 0,
      traceStepCount: 1,
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

  private resetExecutionWorker(
    reason: Error,
    preserveCompilerCoordinator: boolean
  ): void {
    this.workerReadyReject?.(reason);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    if (!preserveCompilerCoordinator) this.warmupPromise = null;
    this.workerReadyPromise = null;
    this.workerReadyResolve = null;
    this.workerReadyReject = null;

    for (const [, pending] of this.pendingMessages) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      closeKernelHttpSyncServers(pending, CPP_KERNEL_HTTP_RUNTIME_LABEL);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
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

  private terminateAndReset(reason: Error = new Error('Worker was terminated')): void {
    this.resetExecutionWorker(reason, false);
  }

  private retireExecutionWorker(): void {
    this.resetExecutionWorker(new Error('C++ execution worker completed and was retired'), true);
  }

  private runInDisposableExecutionWorker<T>(operation: () => Promise<T>): Promise<T> {
    const lifecycleGeneration = this.executionLifecycleGeneration;
    const run = this.executionQueue.then(async () => {
      try {
        if (lifecycleGeneration !== this.executionLifecycleGeneration) {
          throw this.executionResetReason;
        }
        return await operation();
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

  private async initForExecution(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      const abortError = createExecutionAbortError();
      this.terminateAndReset(abortError);
      throw abortError;
    }
    const onAbort = () => this.terminateAndReset(createExecutionAbortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.init();
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private shouldRetryInit(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('timed out') ||
      message.includes('Worker request timed out') ||
      message.includes('worker error') ||
      message.includes('Failed to fetch') ||
      message.includes('was terminated') ||
      message.includes('closed after idle timeout')
    );
  }

  private sendInitMessage(expectedLifecycleGeneration?: number): Promise<InitResult> {
    return this.sendMessage<InitResult>(
      'init',
      {
        assets: {
          clangWasmUrl: this.options.clangWasmUrl,
          lldWasmUrl: this.options.lldWasmUrl,
          sysrootUrl: this.options.sysrootUrl,
          runtimeHeaderUrl: this.options.runtimeHeaderUrl,
          compilerBundleUrl: this.options.compilerBundleUrl,
          compilerFrameEnabled: Boolean(this.externalCompilerUrl || (this.compilerFrameUrl && typeof document !== 'undefined')),
          compilerFrameUrl: this.compilerFrameUrl,
          compilerWorkerUrl: this.options.compilerWorkerUrl,
          toolchainIntegrity: this.options.toolchainIntegrity,
        },
        ...this.workerOptionsPayload(),
      },
      this.initTimeoutMs,
      undefined,
      undefined,
      expectedLifecycleGeneration
    );
  }

  async init(expectedLifecycleGeneration?: number): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        return await this.sendInitMessage(expectedLifecycleGeneration);
      } catch (error) {
        if (
          expectedLifecycleGeneration !== undefined &&
          expectedLifecycleGeneration !== this.executionLifecycleGeneration
        ) {
          throw error;
        }
        if (!this.shouldRetryInit(error)) throw error;
        this.terminateAndReset(error instanceof Error ? error : new Error(String(error)));
        return this.sendInitMessage(expectedLifecycleGeneration);
      }
    })();
    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
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
    this.warmupPromise = this.runInDisposableExecutionWorker(async () => {
      try {
        await this.init();
        return await this.sendMessage<WarmupResult>('warmup', this.workerOptionsPayload(), this.initTimeoutMs);
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

  private async handleCompileRequest(message: WorkerMessage): Promise<void> {
    if (!message.requestId) return;
    const worker = this.worker;
    if (!worker) return;
    const coordinatorGeneration = this.compilerCoordinatorGeneration;

    const cacheKey = await this.compilerArtifactCacheKey(message.payload);
    const cached = cacheKey ? this.cachedCompilerArtifact(cacheKey) : null;
    const compiled = cached ?? (this.externalCompilerUrl
      ? await this.compileWithExternalUrl(message.payload)
      : await this.compileInFrame(message.payload));
    if (coordinatorGeneration !== this.compilerCoordinatorGeneration || worker !== this.worker) return;
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

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: CppExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    return this.runInDisposableExecutionWorker(async () => {
      await this.initForExecution(signal);
      try {
        return await this.executeWithTimeout(
          () =>
            this.sendMessage<CodeExecutionResult>(
              'compile-run',
              { code, functionName, inputs, executionStyle },
              this.executionTimeoutMs + 5_000
            ),
          this.executionTimeoutMs,
          'compile-run',
          signal
        );
      } catch (error) {
        if (this.isClientTimeout(error)) return this.timeoutCodeResult(error);
        throw error;
      }
    });
  }

  async executeCodeBatch(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    executionStyle: CppExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionBatchResult> {
    return this.runInDisposableExecutionWorker(async () => {
      await this.initForExecution(signal);
      try {
        return await this.executeWithTimeout(
          () =>
            this.sendMessage<CodeExecutionBatchResult>(
              'compile-run-batch',
              { code, functionName, inputBatch, executionStyle },
              this.executionTimeoutMs + 5_000
            ),
          this.executionTimeoutMs,
          'compile-run',
          signal
        );
      } catch (error) {
        if (!this.isClientTimeout(error)) throw error;
        const timeout = this.timeoutCodeResult(error);
        return {
          success: false,
          results: inputBatch.map(() => timeout),
          error: timeout.error,
          consoleOutput: timeout.consoleOutput,
          timings: timeout.timings,
        };
      }
    });
  }

  async executeTraceBatch(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    options: TraceExecutionOptions | undefined,
    executionStyle: CppExecutionStyle,
    signal?: AbortSignal
  ): Promise<{ success: boolean; results: ExecutionResult[]; error?: string; consoleOutput?: string[]; timings?: RuntimeExecutionTimings }> {
    return this.runInDisposableExecutionWorker(async () => {
      await this.initForExecution(signal);
      try {
        return await this.executeWithTimeout(
          () =>
            this.sendMessage<{ success: boolean; results: ExecutionResult[]; error?: string; consoleOutput?: string[]; timings?: RuntimeExecutionTimings }>(
              'execute-trace-batch',
              {
                code,
                functionName,
                inputBatch,
                options,
                executionStyle,
                traceEventTransport: traceEventTransferRequest(),
              },
              this.tracingTimeoutMs + 5_000
            ),
          this.tracingTimeoutMs,
          'trace',
          signal
        );
      } catch (error) {
        if (!this.isClientTimeout(error)) throw error;
        const timeout = this.timeoutTraceResult(error);
        return {
          success: false,
          results: inputBatch.map(() => timeout),
          error: timeout.error,
          consoleOutput: timeout.consoleOutput,
          timings: timeout.timings,
        };
      }
    });
  }

  async executeWithTracing(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: TraceExecutionOptions | undefined,
    executionStyle: CppExecutionStyle,
    signal?: AbortSignal
  ): Promise<ExecutionResult> {
    return this.runInDisposableExecutionWorker(async () => {
      await this.initForExecution(signal);
      try {
        return await this.executeWithTimeout(
          () =>
            this.sendMessage<ExecutionResult>(
              'execute-with-tracing',
              {
                code,
                functionName,
                inputs,
                options,
                executionStyle,
                traceEventTransport: traceEventTransferRequest(),
              },
              this.tracingTimeoutMs + 5_000
            ),
          this.tracingTimeoutMs,
          'trace',
          signal
        );
      } catch (error) {
        if (this.isClientTimeout(error)) return this.timeoutTraceResult(error);
        throw error;
      }
    });
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: CppExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    return this.runInDisposableExecutionWorker(async () => {
      try {
        await this.initForExecution(signal);
        return await this.executeWithTimeout(
          () =>
            this.sendMessage<CodeExecutionResult>(
              'execute-code-interview',
              { code, functionName, inputs, executionStyle },
              this.interviewTimeoutMs + 5_000
            ),
          this.interviewTimeoutMs,
          'interview',
          signal
        );
      } catch {
        return {
          success: false,
          output: null,
          error: 'Time Limit Exceeded',
          timeoutReason: 'client-timeout',
          diagnosticStage: 'interview',
          consoleOutput: [],
          timings: { totalMs: this.interviewTimeoutMs },
        };
      }
    });
  }

  async executeProjectCpp(
    request: CppProjectCommandRequest,
    timeoutMs = this.executionTimeoutMs,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal
  ): Promise<CppProjectCommandResult> {
    return this.runInDisposableExecutionWorker(async () => {
      await this.initForExecution(signal);
      const { signal: _signal, onEvent: _requestOnEvent, kernelHttp, ...workerRequest } = request;
      return this.executeWithTimeout(
        () =>
          this.sendMessage<CppProjectCommandResult>(
            'execute-project-cpp',
            {
              ...workerRequest,
              projectUserAuthorityMode: 'permanent',
              ...this.workerOptionsPayload(),
            },
            timeoutMs + 5_000,
            onEvent,
            kernelHttp
          ),
        timeoutMs,
        'compile-run',
        signal
      );
    });
  }

  terminate(): void {
    this.terminateAndReset();
  }
}
