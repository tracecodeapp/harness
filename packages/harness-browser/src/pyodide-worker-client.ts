/**
 * Pyodide Worker Client
 * 
 * TypeScript client for communicating with the Pyodide Web Worker.
 * Provides a promise-based API for executing Python code off the main thread.
 */

import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { assertWorkerFamilyAllowed, getActiveRuntimeLanguage } from './runtime-language-gate';

type MessageId = string;
export type ExecutionStyle = 'function' | 'solution-method' | 'ops-class';

interface PendingMessage {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof globalThis.setTimeout>;
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

interface StatusResult {
  isReady: boolean;
  isLoading: boolean;
}

// Execution timeout in milliseconds for simple code execution (10 seconds)
const EXECUTION_TIMEOUT_MS = 10000;

// Interview mode timeout - shorter, no detailed error info (5 seconds)
const INTERVIEW_MODE_TIMEOUT_MS = 5000;

// Tracing timeout - longer because Python heuristic detection handles infinite loops
// This is just a safety net for truly stuck executions
const TRACING_TIMEOUT_MS = 30000;

// Initial Pyodide load timeout can be significantly higher on first boot/network-constrained setups
const INIT_TIMEOUT_MS = 120000;

// Message timeout for non-execution operations (20 seconds)
const MESSAGE_TIMEOUT_MS = 20000;
// Worker bootstrap timeout - prevents deadlock when worker never emits "worker-ready"
const WORKER_READY_TIMEOUT_MS = 10000;

class PyodideWorkerClient {
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private debug = process.env.NODE_ENV === 'development';

  /**
   * Check if Web Workers are supported
   */
  isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  /**
   * Get or create the worker instance
   */
  private getWorker(): Worker {
    assertWorkerFamilyAllowed('python');

    if (this.worker) return this.worker;

    if (!this.isSupported()) {
      throw new Error('Web Workers are not supported in this environment');
    }

    // Create promise that resolves when worker signals it's ready
    this.workerReadyPromise = new Promise((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = (error: Error) => reject(error);
    });

    const workerUrl =
      process.env.NODE_ENV === 'development'
        ? `/workers/pyodide-worker.js?dev=${Date.now()}`
        : '/workers/pyodide-worker.js';
    this.worker = new Worker(workerUrl);
    
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, type, payload } = event.data;

      // Handle worker-ready signal
      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        if (this.debug) console.log('[PyodideWorkerClient] worker-ready');
        return;
      }

      if (this.debug && !id) {
        console.log('[PyodideWorkerClient] event', { type, payload });
      }

      // Handle responses to our messages
      if (id) {
        const pending = this.pendingMessages.get(id);
        if (pending) {
          this.pendingMessages.delete(id);
          if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
          
          if (type === 'error') {
            pending.reject(new Error((payload as { error: string }).error));
          } else {
            if (this.debug) console.log('[PyodideWorkerClient] recv', { id, type });
            pending.resolve(payload);
          }
        }
      }
    };

    this.worker.onerror = (error) => {
      console.error('[PyodideWorkerClient] Worker error:', error);
      const workerError = new Error('Worker error');
      this.workerReadyReject?.(workerError);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;
      // Reject all pending messages and clear their timeouts
      for (const [id, pending] of this.pendingMessages) {
        if (pending.timeoutId) {
          globalThis.clearTimeout(pending.timeoutId);
        }
        pending.reject(workerError);
        this.pendingMessages.delete(id);
      }
    };

    return this.worker;
  }

  /**
   * Wait for worker bootstrap signal with timeout.
   * Guards against deadlocks when the worker script fails before posting "worker-ready".
   */
  private async waitForWorkerReady(): Promise<void> {
    const readyPromise = this.workerReadyPromise;
    if (!readyPromise) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = new Error(
          `Python worker failed to initialize in time (${Math.round(WORKER_READY_TIMEOUT_MS / 1000)}s)`
        );
        if (this.debug) {
          console.warn('[PyodideWorkerClient] worker-ready timeout', { timeoutMs: WORKER_READY_TIMEOUT_MS });
        }
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

  /**
   * Send a message to the worker and wait for a response
   */
  private async sendMessage<T>(type: string, payload?: unknown, timeoutMs: number = MESSAGE_TIMEOUT_MS): Promise<T> {
    const worker = this.getWorker();
    
    // Wait for worker to be ready before sending messages
    await this.waitForWorkerReady();
    
    const id = String(++this.messageId);

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      if (this.debug) console.log('[PyodideWorkerClient] send', { id, type });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
        if (this.debug) console.warn('[PyodideWorkerClient] timeout', { id, type });
        pending.reject(new Error(`Worker request timed out: ${type}`));
      }, timeoutMs);

      const pending = this.pendingMessages.get(id);
      if (pending) pending.timeoutId = timeoutId;

      worker.postMessage({ id, type, payload });
    });
  }

  /**
   * Execute code with a timeout - terminates worker if execution takes too long
   */
  private async executeWithTimeout<T>(
    executor: () => Promise<T>,
    timeoutMs: number = EXECUTION_TIMEOUT_MS
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        
        // Terminate the stuck worker and clear state
        if (this.debug) {
          console.warn('[PyodideWorkerClient] Execution timeout - terminating worker');
        }
        this.terminateAndReset();
        
        const seconds = Math.round(timeoutMs / 1000);
        reject(new Error(`Execution timed out (possible infinite loop). Code execution was stopped after ${seconds} seconds.`));
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

  /**
   * Terminate the worker and reset state for recreation
   */
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
    
    // Reject all pending messages
    for (const [, pending] of this.pendingMessages) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }

  /**
   * Initialize Pyodide in the worker
   */
  async init(): Promise<InitResult> {
    // Return existing promise if already initializing
    if (this.initPromise) {
      return this.initPromise;
    }

    if (this.isInitializing) {
      // Wait for existing init to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
      return this.init();
    }

    this.isInitializing = true;

    this.initPromise = (async () => {
      try {
        return await this.sendMessage<InitResult>('init', undefined, INIT_TIMEOUT_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const activeLanguage = getActiveRuntimeLanguage();
        if (activeLanguage && activeLanguage !== 'python') {
          if (this.debug) {
            console.log('[PyodideWorkerClient] init aborted after language switch', {
              activeLanguage,
              message,
            });
          }
          throw new Error(
            `Python runtime init aborted because active language is "${activeLanguage}".`
          );
        }

        const shouldRetry =
          message.includes('Worker request timed out: init') ||
          message.includes('Worker was terminated') ||
          message.includes('Worker error') ||
          message.includes('failed to initialize in time');

        if (!shouldRetry) {
          throw error;
        }

        if (this.debug) {
          console.warn('[PyodideWorkerClient] init failed, resetting worker and retrying once', { message });
        }

        this.terminateAndReset();
        return this.sendMessage<InitResult>('init', undefined, INIT_TIMEOUT_MS);
      }
    })();
    
    try {
      const result = await this.initPromise;
      return result;
    } catch (error) {
      this.initPromise = null;
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Execute Python code with tracing for step-by-step visualization
   * @param options.maxLineEvents - Max line events before abort (for complexity analysis, use higher values)
   */
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
    executionStyle: ExecutionStyle = 'function'
  ): Promise<ExecutionResult> {
    // Ensure Pyodide is initialized
    await this.init();
    
    // Use longer timeout for tracing - Python heuristic detection handles infinite loops
    try {
      return await this.executeWithTimeout(
        () => this.sendMessage<ExecutionResult>('execute-with-tracing', {
          code,
          functionName,
          inputs,
          executionStyle,
          options,
        }, TRACING_TIMEOUT_MS + 5000), // Message timeout slightly longer than execution timeout
        TRACING_TIMEOUT_MS
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isClientTimeout =
        errorMessage.includes('Execution timed out') ||
        errorMessage.includes('possible infinite loop');

      if (isClientTimeout) {
        return {
          success: false,
          error: errorMessage,
          trace: [],
          executionTimeMs: TRACING_TIMEOUT_MS,
          consoleOutput: [],
          traceLimitExceeded: true,
          timeoutReason: 'client-timeout',
          lineEventCount: 0,
          traceStepCount: 0,
        };
      }

      throw error;
    }
  }

  /**
   * Execute Python code without tracing (for running tests)
   */
  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: ExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    // Ensure Pyodide is initialized
    await this.init();
    
    return this.executeWithTimeout(
      () => this.sendMessage<CodeExecutionResult>('execute-code', {
        code,
        functionName,
        inputs,
        executionStyle,
      }, EXECUTION_TIMEOUT_MS + 5000),
      EXECUTION_TIMEOUT_MS
    );
  }

  /**
   * Execute Python code in interview mode - 5 second timeout, generic error messages
   * Does not reveal which line caused the timeout
   */
  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: ExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    // Ensure Pyodide is initialized
    await this.init();
    
    try {
      const result = await this.executeWithTimeout(
        () => this.sendMessage<CodeExecutionResult>('execute-code-interview', {
          code,
          functionName,
          inputs,
          executionStyle,
        }, INTERVIEW_MODE_TIMEOUT_MS + 2000),
        INTERVIEW_MODE_TIMEOUT_MS
      );
      
      // Sanitize error messages in interview mode - don't reveal line numbers for timeouts
      if (!result.success && result.error) {
        // Keep basic error types but remove line-specific info for timeouts
        const normalizedError = result.error.toLowerCase();
        const isTimeoutOrResourceLimit =
          normalizedError.includes('timed out') ||
          normalizedError.includes('execution timeout') ||
          normalizedError.includes('infinite loop') ||
          normalizedError.includes('interview_guard_triggered') ||
          normalizedError.includes('memory-limit') ||
          normalizedError.includes('line-limit') ||
          normalizedError.includes('single-line-limit') ||
          normalizedError.includes('recursion-limit');

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
    } catch (error) {
      // Handle timeout from executeWithTimeout
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('timed out') || errorMsg.includes('Execution timeout')) {
        return {
          success: false,
          output: null,
          error: 'Time Limit Exceeded',
          consoleOutput: [],
        };
      }
      return {
        success: false,
        output: null,
        error: errorMsg,
        consoleOutput: [],
      };
    }
  }

  /**
   * Check the status of the worker
   */
  async getStatus(): Promise<StatusResult> {
    return this.sendMessage<StatusResult>('status');
  }

  /**
   * Analyze Python code using AST (off main thread)
   * Returns CodeFacts with semantic information about the code
   */
  async analyzeCode(code: string): Promise<unknown> {
    // Ensure Pyodide is initialized
    await this.init();
    
    // Use a shorter timeout for analysis (5 seconds should be plenty)
    return this.sendMessage<unknown>('analyze-code', { code }, 5000);
  }

  /**
   * Terminate the worker and clean up resources
   */
  terminate(): void {
    this.terminateAndReset();
  }
}

// Singleton instance
let workerClient: PyodideWorkerClient | null = null;

/**
 * Get the singleton PyodideWorkerClient instance
 */
export function getPyodideWorkerClient(): PyodideWorkerClient {
  if (!workerClient) {
    workerClient = new PyodideWorkerClient();
  }
  return workerClient;
}

/**
 * Check if the worker client is supported
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}
