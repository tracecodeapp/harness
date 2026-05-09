import type { CodeExecutionResult, RuntimeExecutionTimings } from '../../harness-core/src/types';
import { javaTraceHooksEventsToRuntimeTrace } from '../../harness-core/src/trace-adapters/java';
import { createEmptyRuntimeTrace, type RuntimeTrace } from '../../harness-core/src/runtime-trace';

type MessageId = string;
export type JavaExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export interface JavaWorkerClientOptions {
  workerUrl: string;
  debug?: boolean;
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
  timings?: RuntimeExecutionTimings;
}

export interface JavaWorkerRawTraceResult {
  success: boolean;
  output?: unknown;
  events: string[];
  sourceText?: string;
  executionTimeMs: number;
  error?: string;
  errorLine?: number;
  consoleOutput: string[];
  traceLimitExceeded?: boolean;
  timeoutReason?: 'trace-limit';
  droppedEventCount?: number;
  timings?: RuntimeExecutionTimings;
}

export interface JavaWorkerTraceResult extends JavaWorkerRawTraceResult {
  trace: RuntimeTrace;
}

interface JavaWorkerCodeResult {
  success: boolean;
  output?: unknown;
  executionTimeMs?: number;
  error?: string;
  errorLine?: number;
  consoleOutput?: string[];
  timings?: RuntimeExecutionTimings;
}

export interface JavaTraceExecutionOptions {
  maxTraceSteps?: number;
  maxLineEvents?: number;
  maxSingleLineHits?: number;
  maxStoredEvents?: number;
  minimalTrace?: boolean;
}

const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 25_000;
const INIT_TIMEOUT_MS = 120_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const JAVA_DEFAULT_FILE = 'solution.java';

export class JavaWorkerClient {
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private readonly debug: boolean;

  constructor(private readonly options: JavaWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
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

    this.worker = new Worker(workerUrl);
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
      const workerError = new Error(error.message || 'Java worker error');
      this.workerReadyReject?.(workerError);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;
      for (const [, pending] of this.pendingMessages) {
        if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
        pending.reject(workerError);
      }
      this.pendingMessages.clear();
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
          `Java worker failed to initialize in time (${Math.round(WORKER_READY_TIMEOUT_MS / 1000)}s)`
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
        this.terminateAndReset();
        reject(
          new Error(
            `Java execution timed out after ${Math.round(timeoutMs / 1000)} seconds.`
          )
        );
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

  private terminateAndReset(reason: Error = new Error('Worker was terminated')): void {
    this.workerReadyReject?.(reason);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    this.isInitializing = false;
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
    if (this.isInitializing) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      return this.init();
    }

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        return await this.sendMessage<InitResult>('init', undefined, INIT_TIMEOUT_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldRetry =
          message.includes('Worker request timed out: init') ||
          message.includes('Worker was terminated') ||
          message.includes('Java worker error') ||
          message.includes('failed to initialize in time');

        if (!shouldRetry) {
          throw error;
        }

        if (this.debug) {
          console.warn('[JavaWorkerClient] init failed, resetting worker and retrying once', { message });
        }

        this.terminateAndReset(error instanceof Error ? error : new Error(message));
        return this.sendMessage<InitResult>('init', undefined, INIT_TIMEOUT_MS);
      }
    })();
    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  async executeWithTracing(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<JavaWorkerTraceResult> {
    await this.init();
    const result = await this.executeWithTimeout(
      () =>
        this.sendMessage<JavaWorkerRawTraceResult>(
          'execute-with-tracing',
          { code, functionName, inputs, options, executionStyle },
          TRACING_TIMEOUT_MS + 5_000
        ),
      TRACING_TIMEOUT_MS
    );
    return {
      ...result,
      trace: result.success
        ? javaTraceHooksEventsToRuntimeTrace(result.events, result.sourceText, {
            runId: 'java:run',
            file: JAVA_DEFAULT_FILE,
          })
        : createEmptyRuntimeTrace('java', { runId: 'java:run', file: JAVA_DEFAULT_FILE }),
    };
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<CodeExecutionResult> {
    return this.executeCodeMessage('execute-code', code, functionName, inputs, options, executionStyle);
  }

  private async executeCodeMessage(
    type: 'execute-code' | 'execute-code-interview',
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<CodeExecutionResult> {
    await this.init();
    const result = await this.executeWithTimeout(
      () =>
        this.sendMessage<JavaWorkerCodeResult>(
          type,
          { code, functionName, inputs, options, executionStyle },
          EXECUTION_TIMEOUT_MS + 5_000
        ),
      EXECUTION_TIMEOUT_MS
    );
    if (!result.success) {
      return {
        success: false,
        output: null,
        error: result.error ?? 'Java execution failed',
        ...(result.errorLine !== undefined ? { errorLine: result.errorLine } : {}),
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }
    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<CodeExecutionResult> {
    return this.executeCodeMessage('execute-code-interview', code, functionName, inputs, options, executionStyle);
  }

  terminate(): void {
    this.terminateAndReset();
  }
}
