import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimeExecutionTimings,
} from '../../harness-core/src/types';
import { createEmptyRuntimeTrace } from '../../harness-core/src/runtime-trace';
import type { TraceExecutionOptions } from '../../harness-core/src/runtime-types';

type MessageId = string;

export type CppExecutionStyle = 'function' | 'solution-method' | 'ops-class';

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
}

interface PendingMessage {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

type CppClientTimeoutStage = 'compile-run' | 'trace' | 'interview';

class CppClientTimeoutError extends Error {
  constructor(
    message: string,
    readonly stage: CppClientTimeoutStage,
    readonly timeoutMs: number
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
const EXECUTION_TIMEOUT_MS = 25_000;
const TRACING_TIMEOUT_MS = 30_000;
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
  private readonly activeCompilerFrames = new Set<HTMLIFrameElement>();

  constructor(private readonly options: CppWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    this.tracingTimeoutMs = options.tracingTimeoutMs ?? TRACING_TIMEOUT_MS;
    this.interviewTimeoutMs = options.interviewTimeoutMs ?? INTERVIEW_MODE_TIMEOUT_MS;
    this.compilerFrameUrl = options.compilerFrameUrl;
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
      const { id, type, payload } = event.data;

      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        return;
      }

      if (type === 'idle-timeout') {
        this.terminateAndReset(new Error('C++ worker closed after idle timeout'));
        return;
      }

      if (type === 'compile-request') {
        this.handleCompileRequest(event.data).catch((error) => {
          if (!event.data.requestId) return;
          this.worker?.postMessage({
            type: 'compile-response',
            requestId: event.data.requestId,
            payload: { success: false, error: error instanceof Error ? error.message : String(error) },
          });
        });
        return;
      }

      if (!id) return;
      const pending = this.pendingMessages.get(id);
      if (!pending) return;
      this.pendingMessages.delete(id);
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);

      if (type === 'error') {
        pending.reject(new Error((payload as { error: string }).error));
        return;
      }

      pending.resolve(payload);
    };

    this.worker.onerror = (error) => {
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
    timeoutMs = MESSAGE_TIMEOUT_MS
  ): Promise<T> {
    const worker = this.getWorker();
    await this.waitForWorkerReady();
    const id = String(++this.messageId);

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
        pending.reject(new Error(`Worker request timed out: ${type}`));
      }, timeoutMs);

      const pending = this.pendingMessages.get(id);
      if (pending) pending.timeoutId = timeoutId;

      worker.postMessage({ id, type, payload });
    });
  }

  private async executeWithTimeout<T>(
    executor: () => Promise<T>,
    timeoutMs: number,
    stage: CppClientTimeoutStage
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = new CppClientTimeoutError(
          `C++ ${stage === 'trace' ? 'tracing' : stage === 'interview' ? 'interview execution' : 'execution'} timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          stage,
          timeoutMs
        );
        this.terminateAndReset(timeoutError);
        reject(timeoutError);
      }, timeoutMs);

      executor()
        .then((result) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  private isClientTimeout(error: unknown): boolean {
    return (
      error instanceof CppClientTimeoutError ||
      (error instanceof Error && error.message.includes('C++') && error.message.includes('timed out'))
    );
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
          compilerFrameEnabled: Boolean(this.compilerFrameUrl && typeof document !== 'undefined'),
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

  private workerOptionsPayload(): { idleTimeoutMs?: number } {
    return this.options.workerIdleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: this.options.workerIdleTimeoutMs };
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

  private clearCompilerFrames(): void {
    for (const frame of this.activeCompilerFrames) {
      frame.remove();
    }
    this.activeCompilerFrames.clear();
  }

  private async handleCompileRequest(message: WorkerMessage): Promise<void> {
    if (!message.requestId) return;
    const worker = this.worker;
    if (!worker) return;

    const result = await this.compileInFrame(message.payload);
    const transfer = result?.programBuffer instanceof ArrayBuffer ? [result.programBuffer] : [];
    worker.postMessage(
      {
        type: 'compile-response',
        requestId: message.requestId,
        payload: result,
      },
      transfer
    );
  }

  private compileInFrame(payload: unknown): Promise<Record<string, unknown>> {
    if (!this.compilerFrameUrl || typeof document === 'undefined') {
      return Promise.resolve({ success: false, error: 'C++ compiler frame is not available.' });
    }

    const frameUrl = new URL(this.compilerFrameUrl, globalThis.location?.href);
    const targetOrigin = frameUrl.origin;
    const iframe = document.createElement('iframe');
    iframe.src = frameUrl.href;
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');
    this.activeCompilerFrames.add(iframe);

    return new Promise((resolve) => {
      const requestId = `compile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;
      let ready = false;
      let timeoutId: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        globalThis.removeEventListener('message', onMessage);
        globalThis.clearTimeout(timeoutId);
        this.activeCompilerFrames.delete(iframe);
        iframe.remove();
      };
      const finish = (result: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const postCompileRequest = () => {
        iframe.contentWindow?.postMessage(
          {
            id: requestId,
            type: 'compile',
            payload,
          },
          targetOrigin
        );
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return;
        if (event.origin !== targetOrigin) return;
        if ((event.data as { type?: string })?.type === 'frame-ready') {
          if (ready) return;
          ready = true;
          postCompileRequest();
          return;
        }
        if ((event.data as { id?: string })?.id !== requestId) return;
        const response = event.data as { payload?: Record<string, unknown> };
        finish(response.payload ?? { success: false, error: 'C++ compiler frame returned an empty response.' });
      };

      timeoutId = globalThis.setTimeout(() => {
        finish({ success: false, error: 'C++ compiler frame request timed out.' });
      }, this.initTimeoutMs);

      globalThis.addEventListener('message', onMessage);
      document.body.appendChild(iframe);
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

  terminate(): void {
    this.terminateAndReset();
  }
}
