import type {
  CodeExecutionResult,
  CodeExecutionBatchResult,
  ExecutionResult,
  RuntimeExecutionTimings,
} from '../../harness-core/src/types';
import type {
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeProjectCommandRequest,
} from '../../harness-core/src/runtime-project';
import { createEmptyRuntimeTrace } from '../../harness-core/src/runtime-trace';
import type { TraceExecutionOptions } from '../../harness-core/src/runtime-types';
import { logRuntimeDiagnostic } from './runtime-diagnostics';
import { createWorkerProtocolToken } from './worker-protocol';

type MessageId = string;

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
}

export interface CppWorkerClientOptions extends CppWorkerAssets {
  workerUrl: string;
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

interface PendingMessage {
  protocolToken: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: RuntimeCommandEventHandler;
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
  private compilerFrameRequestId = 0;
  private compilerFrameMessageHandler: ((event: MessageEvent) => void) | null = null;
  private pendingCompilerFrameRequests = new Map<string, PendingCompilerFrameRequest>();

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
      this.pendingMessages.delete(id);
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);

      if (type === 'error') {
        pending.reject(new Error((payload as { error: string }).error));
        return;
      }

      pending.resolve(payload);
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
    onEvent?: RuntimeCommandEventHandler
  ): Promise<T> {
    const worker = this.getWorker();
    await this.waitForWorkerReady();
    const id = String(++this.messageId);
    const protocolToken = createWorkerProtocolToken();

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        protocolToken,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onEvent ? { onEvent } : {}),
      });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
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
          message: shouldTerminate
            ? 'C++ execution timed out; terminating worker.'
            : 'C++ execution timed out before program execution; keeping worker alive for compiler reuse.',
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
    const stage = progress?.stage;
    if (!stage) return true;
    return stage === 'program-run:start' || stage.startsWith('program-run:');
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
            message: this.shouldTerminateWorkerForTimeout(timeoutError.progress)
              ? 'C++ execution timed out; terminating worker.'
              : 'C++ execution timed out before program execution; keeping worker alive for compiler reuse.',
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
            message: this.shouldTerminateWorkerForTimeout(timeoutError.progress)
              ? 'C++ execution timed out; terminating worker.'
              : 'C++ execution timed out before program execution; keeping worker alive for compiler reuse.',
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

  private terminateAndReset(reason: Error = new Error('Worker was terminated')): void {
    this.workerReadyReject?.(reason);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    this.warmupPromise = null;
    this.workerReadyPromise = null;
    this.workerReadyResolve = null;
    this.workerReadyReject = null;

    for (const [, pending] of this.pendingMessages) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
    for (const controller of this.activeExternalCompileControllers) {
      controller.abort();
    }
    this.activeExternalCompileControllers.clear();
    this.clearCompilerFrames();
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

  private sendInitMessage(): Promise<InitResult> {
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
        },
        ...this.workerOptionsPayload(),
      },
      this.initTimeoutMs
    );
  }

  async init(): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        return await this.sendInitMessage();
      } catch (error) {
        if (!this.shouldRetryInit(error)) throw error;
        this.terminateAndReset(error instanceof Error ? error : new Error(String(error)));
        return this.sendInitMessage();
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
    this.warmupPromise = (async () => {
      try {
        await this.init();
        return await this.sendMessage<WarmupResult>('warmup', this.workerOptionsPayload(), this.initTimeoutMs);
      } catch (error) {
        this.warmupPromise = null;
        throw error;
      }
    })();
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
    for (const frame of this.activeCompilerFrames) {
      frame.remove();
    }
    this.activeCompilerFrames.clear();
  }

  private async handleCompileRequest(message: WorkerMessage): Promise<void> {
    if (!message.requestId) return;
    const worker = this.worker;
    if (!worker) return;

    const result = this.externalCompilerUrl
      ? await this.compileWithExternalUrl(message.payload)
      : await this.compileInFrame(message.payload);
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
    this.compilerFrameTargetOrigin = frameUrl.origin;
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
      }, this.initTimeoutMs);
      this.pendingCompilerFrameRequests.set(requestId, { protocolToken, resolve, timeoutId });
      frameWindow.postMessage(
        {
          id: requestId,
          type: 'compile',
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
    executionStyle: CppExecutionStyle
  ): Promise<CodeExecutionResult> {
    await this.init();
    try {
      return await this.executeWithTimeout(
        () =>
          this.sendMessage<CodeExecutionResult>(
            'compile-run',
            { code, functionName, inputs, executionStyle },
            this.executionTimeoutMs + 5_000
          ),
        this.executionTimeoutMs,
        'compile-run'
      );
    } catch (error) {
      if (this.isClientTimeout(error)) return this.timeoutCodeResult(error);
      throw error;
    }
  }

  async executeCodeBatch(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    executionStyle: CppExecutionStyle
  ): Promise<CodeExecutionBatchResult> {
    await this.init();
    try {
      return await this.executeWithTimeout(
        () =>
          this.sendMessage<CodeExecutionBatchResult>(
            'compile-run-batch',
            { code, functionName, inputBatch, executionStyle },
            this.executionTimeoutMs + 5_000
          ),
        this.executionTimeoutMs,
        'compile-run'
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
  }

  async executeWithTracing(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: TraceExecutionOptions | undefined,
    executionStyle: CppExecutionStyle
  ): Promise<ExecutionResult> {
    await this.init();
    try {
      return await this.executeWithTimeout(
        () =>
          this.sendMessage<ExecutionResult>(
            'execute-with-tracing',
            { code, functionName, inputs, options, executionStyle },
            this.tracingTimeoutMs + 5_000
          ),
        this.tracingTimeoutMs,
        'trace'
      );
    } catch (error) {
      if (this.isClientTimeout(error)) return this.timeoutTraceResult(error);
      throw error;
    }
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: CppExecutionStyle
  ): Promise<CodeExecutionResult> {
    await this.init();
    try {
      return await this.executeWithTimeout(
        () =>
          this.sendMessage<CodeExecutionResult>(
            'execute-code-interview',
            { code, functionName, inputs, executionStyle },
            this.interviewTimeoutMs + 5_000
          ),
        this.interviewTimeoutMs,
        'interview'
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
  }

  async executeProjectCpp(
    request: CppProjectCommandRequest,
    timeoutMs = this.executionTimeoutMs,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal
  ): Promise<CppProjectCommandResult> {
    if (signal?.aborted) {
      const abortError = createExecutionAbortError();
      this.terminateAndReset(abortError);
      throw abortError;
    }
    const abortInit = () => this.terminateAndReset(createExecutionAbortError());
    signal?.addEventListener('abort', abortInit, { once: true });
    try {
      await this.init();
    } finally {
      signal?.removeEventListener('abort', abortInit);
    }
    const { signal: _signal, onEvent: _requestOnEvent, ...workerRequest } = request;
    return this.executeWithTimeout(
      () =>
        this.sendMessage<CppProjectCommandResult>(
          'execute-project-cpp',
          {
            ...workerRequest,
            ...this.workerOptionsPayload(),
          },
          timeoutMs + 5_000,
          onEvent
        ),
      timeoutMs,
      'compile-run',
      signal
    );
  }

  terminate(): void {
    this.terminateAndReset();
  }
}
