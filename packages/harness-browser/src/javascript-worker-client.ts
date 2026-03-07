import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { assertWorkerFamilyAllowed } from './runtime-language-gate';

type MessageId = string;
export type JavaScriptExecutionStyle = 'function' | 'solution-method' | 'ops-class';
export type JavaScriptWorkerLanguage = 'javascript' | 'typescript';

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
}

const EXECUTION_TIMEOUT_MS = 7000;
const INTERVIEW_MODE_TIMEOUT_MS = 5000;
const TRACING_TIMEOUT_MS = 7000;
const INIT_TIMEOUT_MS = 10000;
const MESSAGE_TIMEOUT_MS = 12000;
const WORKER_READY_TIMEOUT_MS = 10000;

class JavaScriptWorkerClient {
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private debug = process.env.NODE_ENV === 'development';

  isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  private getWorker(): Worker {
    assertWorkerFamilyAllowed('javascript');

    if (this.worker) return this.worker;

    if (!this.isSupported()) {
      throw new Error('Web Workers are not supported in this environment');
    }

    this.workerReadyPromise = new Promise((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = (error: Error) => reject(error);
    });

    const workerUrl =
      process.env.NODE_ENV === 'development'
        ? `/workers/javascript-worker.js?dev=${Date.now()}`
        : '/workers/javascript-worker.js';
    this.worker = new Worker(workerUrl);

    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, type, payload } = event.data;

      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        if (this.debug) console.log('[JavaScriptWorkerClient] worker-ready');
        return;
      }

      if (id) {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;

        this.pendingMessages.delete(id);
        if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);

        if (type === 'error') {
          pending.reject(new Error((payload as { error: string }).error));
          return;
        }

        pending.resolve(payload);
      }
    };

    this.worker.onerror = (error) => {
      console.error('[JavaScriptWorkerClient] Worker error:', error);
      const workerError = new Error('Worker error');
      this.workerReadyReject?.(workerError);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;

      for (const [id, pending] of this.pendingMessages) {
        if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
        pending.reject(workerError);
        this.pendingMessages.delete(id);
      }
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
          `JavaScript worker failed to initialize in time (${Math.round(WORKER_READY_TIMEOUT_MS / 1000)}s)`
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
    timeoutMs: number = MESSAGE_TIMEOUT_MS
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
            `Execution timed out (possible infinite loop). Code execution was stopped after ${Math.round(timeoutMs / 1000)} seconds.`
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
    this.initPromise = this.sendMessage<InitResult>('init', undefined, INIT_TIMEOUT_MS);

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
    functionName: string | null,
    inputs: Record<string, unknown>,
    options?: {
      maxTraceSteps?: number;
      maxLineEvents?: number;
      maxSingleLineHits?: number;
      minimalTrace?: boolean;
    },
    executionStyle: JavaScriptExecutionStyle = 'function',
    language: JavaScriptWorkerLanguage = 'javascript'
  ): Promise<ExecutionResult> {
    await this.init();
    return this.executeWithTimeout(
      () =>
        this.sendMessage<ExecutionResult>(
          'execute-with-tracing',
          {
            code,
            functionName,
            inputs,
            options,
            executionStyle,
            language,
          },
          TRACING_TIMEOUT_MS + 2000
        ),
      TRACING_TIMEOUT_MS
    );
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: JavaScriptExecutionStyle = 'function',
    language: JavaScriptWorkerLanguage = 'javascript'
  ): Promise<CodeExecutionResult> {
    await this.init();
    return this.executeWithTimeout(
      () =>
        this.sendMessage<CodeExecutionResult>(
          'execute-code',
          {
            code,
            functionName,
            inputs,
            executionStyle,
            language,
          },
          EXECUTION_TIMEOUT_MS + 2000
        ),
      EXECUTION_TIMEOUT_MS
    );
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: JavaScriptExecutionStyle = 'function',
    language: JavaScriptWorkerLanguage = 'javascript'
  ): Promise<CodeExecutionResult> {
    await this.init();

    try {
      const result = await this.executeWithTimeout(
        () =>
          this.sendMessage<CodeExecutionResult>(
            'execute-code-interview',
            {
              code,
              functionName,
              inputs,
              executionStyle,
              language,
            },
            INTERVIEW_MODE_TIMEOUT_MS + 2000
          ),
        INTERVIEW_MODE_TIMEOUT_MS
      );

      if (!result.success && result.error) {
        const normalized = result.error.toLowerCase();
        const isTimeoutOrResourceLimit =
          normalized.includes('timed out') ||
          normalized.includes('infinite loop') ||
          normalized.includes('line-limit') ||
          normalized.includes('single-line-limit') ||
          normalized.includes('recursion-limit') ||
          normalized.includes('trace-limit') ||
          normalized.includes('line events') ||
          normalized.includes('trace steps') ||
          normalized.includes('call depth');
        if (isTimeoutOrResourceLimit) {
          return {
            success: false,
            output: null,
            error: 'Time Limit Exceeded',
            consoleOutput: result.consoleOutput ?? [],
          };
        }
      }

      return result;
    } catch {
      return {
        success: false,
        output: null,
        error: 'Time Limit Exceeded',
        consoleOutput: [],
      };
    }
  }

  terminate(): void {
    this.terminateAndReset();
  }
}

let workerClient: JavaScriptWorkerClient | null = null;

export function getJavaScriptWorkerClient(): JavaScriptWorkerClient {
  if (!workerClient) {
    workerClient = new JavaScriptWorkerClient();
  }
  return workerClient;
}

export function isJavaScriptWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}
