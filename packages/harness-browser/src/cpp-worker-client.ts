import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { createEmptyRuntimeTrace } from '../../harness-core/src/runtime-trace';
import type { TraceExecutionOptions } from '../../harness-core/src/runtime-types';

type MessageId = string;

export type CppExecutionStyle = 'solution-method' | 'ops-class';

export interface CppWorkerAssets {
  clangWasmUrl: string;
  lldWasmUrl: string;
  sysrootUrl: string;
  runtimeHeaderUrl: string;
  compilerBundleUrl: string;
}

export interface CppWorkerClientOptions extends CppWorkerAssets {
  workerUrl: string;
  debug?: boolean;
  executionTimeoutMs?: number;
  tracingTimeoutMs?: number;
}

interface PendingMessage {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface WorkerMessage {
  id?: MessageId;
  type: string;
  payload?: unknown;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
  error?: string;
}

const INIT_TIMEOUT_MS = 10_000;
const EXECUTION_TIMEOUT_MS = 25_000;
const TRACING_TIMEOUT_MS = 30_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;

export class CppWorkerClient {
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private initPromise: Promise<InitResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private readonly debug: boolean;
  private readonly executionTimeoutMs: number;
  private readonly tracingTimeoutMs: number;

  constructor(private readonly options: CppWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    this.tracingTimeoutMs = options.tracingTimeoutMs ?? TRACING_TIMEOUT_MS;
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

  private async executeWithTimeout<T>(executor: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = new Error(`C++ execution timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
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
    return error instanceof Error && error.message.includes('C++ execution timed out');
  }

  private timeoutCodeResult(error: unknown): CodeExecutionResult {
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
    };
  }

  private timeoutTraceResult(error: unknown): ExecutionResult {
    const trace = createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: 'UserCode.cpp' });
    trace.events = [
      {
        kind: 'timeout',
        runId: 'cpp:run',
        file: 'UserCode.cpp',
        message: error instanceof Error ? error.message : String(error),
      },
    ];
    trace.traceStepCount = 1;
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      trace,
      executionTimeMs: this.tracingTimeoutMs,
      consoleOutput: [],
      traceLimitExceeded: true,
      timeoutReason: 'client-timeout',
      lineEventCount: 0,
      traceStepCount: 1,
    };
  }

  private terminateAndReset(reason: Error = new Error('Worker was terminated')): void {
    this.workerReadyReject?.(reason);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    this.workerReadyPromise = null;
    this.workerReadyResolve = null;
    this.workerReadyReject = null;

    for (const [, pending] of this.pendingMessages) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }

  async init(): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.sendMessage<InitResult>(
      'init',
      {
        assets: {
          clangWasmUrl: this.options.clangWasmUrl,
          lldWasmUrl: this.options.lldWasmUrl,
          sysrootUrl: this.options.sysrootUrl,
          runtimeHeaderUrl: this.options.runtimeHeaderUrl,
          compilerBundleUrl: this.options.compilerBundleUrl,
        },
      },
      INIT_TIMEOUT_MS
    );
    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
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
        this.executionTimeoutMs
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
        this.tracingTimeoutMs
      );
    } catch (error) {
      if (this.isClientTimeout(error)) return this.timeoutTraceResult(error);
      throw error;
    }
  }

  terminate(): void {
    this.terminateAndReset();
  }
}
