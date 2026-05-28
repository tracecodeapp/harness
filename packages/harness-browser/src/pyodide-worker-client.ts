/**
 * Python Worker Client
 * 
 * TypeScript client for communicating with the Python Web Worker.
 * Provides a promise-based API for executing Python code off the main thread.
 */

import type { CodeExecutionBatchResult, CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { createEmptyRuntimeTrace } from '../../harness-core/src/runtime-trace';
import type {
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpProtocolMessage,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeProjectCommandRequest,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import { logRuntimeDiagnostic } from './runtime-diagnostics';

type MessageId = string;
export type ExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export interface PythonWorkerClientOptions {
  workerUrl: string;
  debug?: boolean;
}

interface PendingMessage {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: RuntimeCommandEventHandler;
  kernelHttp?: RuntimeKernelHttpBridge;
  httpListeners?: Map<string, RuntimeKernelHttpListenerHandle>;
  httpRequests?: Map<string, { resolve: (response: RuntimeKernelHttpResponse) => void; reject: (error: Error) => void }>;
  timeoutId?: ReturnType<typeof globalThis.setTimeout>;
}

function createExecutionAbortError(): Error {
  return Object.assign(new Error('Execution aborted'), { name: 'AbortError' });
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

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
}

interface StatusResult {
  isReady: boolean;
  isLoading: boolean;
}

export type PythonProjectFile = RuntimeFile;
export type PythonProjectSnapshot = RuntimeProjectSnapshot;
export type PythonProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin' | 'module'
>;
export type PythonProjectCommandResult = RuntimeCommandResult;

// Execution timeout in milliseconds for simple code execution (10 seconds)
const EXECUTION_TIMEOUT_MS = 30000;
const PROJECT_EXECUTION_TIMEOUT_MS = 30000;

// Interview mode timeout - shorter, no detailed error info (5 seconds)
const INTERVIEW_MODE_TIMEOUT_MS = 5000;

// Tracing timeout - longer because Python heuristic detection handles infinite loops
// This is just a safety net for truly stuck executions
const TRACING_TIMEOUT_MS = 30000;

// Python runtime warmup/load timeout can be significantly higher on first boot/network-constrained setups
const INIT_TIMEOUT_MS = 120000;

// Message timeout for non-execution operations (20 seconds)
const MESSAGE_TIMEOUT_MS = 20000;
// Worker bootstrap timeout - prevents deadlock when worker never emits "worker-ready"
const WORKER_READY_TIMEOUT_MS = 10000;

export class PythonWorkerClient {
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private httpRequestId = 0;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private readonly debug: boolean;

  constructor(private readonly options: PythonWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
  }

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
      this.debug && !this.options.workerUrl.includes('?')
        ? `${this.options.workerUrl}?dev=${Date.now()}`
        : this.options.workerUrl;
    this.worker = new Worker(workerUrl);
    
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, type, payload } = event.data;

      // Handle worker-ready signal
      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        logRuntimeDiagnostic('info', {
          component: 'PythonWorkerClient',
          runtime: 'python',
          phase: 'worker-ready',
          message: 'Python worker is ready.',
        }, { enabled: this.debug });
        return;
      }

      if (this.debug && !id) {
        logRuntimeDiagnostic('debug', {
          component: 'PythonWorkerClient',
          runtime: 'python',
          phase: 'worker-event',
          message: 'Python worker emitted an unsolicited event.',
          detail: { type, payload },
        }, { enabled: this.debug });
      }

      // Handle responses to our messages
      if (id) {
        const pending = this.pendingMessages.get(id);
        if (pending) {
          if (type === 'project-event') {
            pending.onEvent?.(payload as RuntimeCommandEvent);
            return;
          }
          if (type === 'kernel-http-listen' || type === 'kernel-http-close' || type === 'kernel-http-response' || type === 'kernel-http-error') {
            this.handleKernelHttpProtocolMessage(id, type, payload);
            return;
          }
          this.pendingMessages.delete(id);
          this.cleanupPendingKernelHttp(pending);
          if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
          
          if (type === 'error') {
            pending.reject(new Error((payload as { error: string }).error));
          } else {
            logRuntimeDiagnostic('debug', {
              component: 'PythonWorkerClient',
              runtime: 'python',
              phase: 'worker-response',
              message: 'Python worker response received.',
              detail: { id, type },
            }, { enabled: this.debug });
            pending.resolve(payload);
          }
        }
      }
    };

    this.worker.onerror = (error) => {
      logRuntimeDiagnostic('error', {
        component: 'PythonWorkerClient',
        runtime: 'python',
        phase: 'worker-error',
        message: 'Python worker emitted an error event.',
        detail: {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        },
      });
      const workerError = new Error('Worker error');
      this.workerReadyReject?.(workerError);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;
      // Reject all pending messages and clear their timeouts
      for (const [id, pending] of this.pendingMessages) {
        if (pending.timeoutId) {
          globalThis.clearTimeout(pending.timeoutId);
        }
        this.cleanupPendingKernelHttp(pending);
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
        logRuntimeDiagnostic('warn', {
          component: 'PythonWorkerClient',
          runtime: 'python',
          phase: 'worker-ready-timeout',
          message: 'Python worker did not send worker-ready before the timeout.',
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

  /**
   * Send a message to the worker and wait for a response
   */
  private async sendMessage<T>(
    type: string,
    payload?: unknown,
    timeoutMs: number = MESSAGE_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    kernelHttp?: RuntimeKernelHttpBridge
  ): Promise<T> {
    const worker = this.getWorker();
    
    // Wait for worker to be ready before sending messages
    await this.waitForWorkerReady();
    
    const id = String(++this.messageId);

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onEvent ? { onEvent } : {}),
        ...(kernelHttp ? { kernelHttp } : {}),
        httpListeners: new Map(),
        httpRequests: new Map(),
      });

      logRuntimeDiagnostic('debug', {
        component: 'PythonWorkerClient',
        runtime: 'python',
        phase: 'worker-request',
        message: 'Sending request to Python worker.',
        detail: { id, type },
      }, { enabled: this.debug });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
        logRuntimeDiagnostic('warn', {
          component: 'PythonWorkerClient',
          runtime: 'python',
          phase: 'worker-request-timeout',
          message: 'Python worker request timed out.',
          detail: { id, type, timeoutMs },
        }, { enabled: this.debug });
        pending.reject(new Error(`Worker request timed out: ${type}`));
      }, timeoutMs);

      const pending = this.pendingMessages.get(id);
      if (pending) pending.timeoutId = timeoutId;

      worker.postMessage({ id, type, payload });
    });
  }

  private handleKernelHttpProtocolMessage(commandId: string, type: string, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (type === 'kernel-http-listen' && message.type === 'kernel-http-listen') {
      if (!pending.kernelHttp) {
        this.postKernelHttpError(commandId, { listenerId: message.listenerId, error: 'TraceKernel HTTP is not available.' });
        return;
      }
      try {
        const handle = pending.kernelHttp.listen(message.options, (request) => this.dispatchWorkerKernelHttpRequest(commandId, message.listenerId, request));
        pending.httpListeners?.set(message.listenerId, handle);
        this.worker?.postMessage({
          id: commandId,
          type: 'kernel-http-listen-result',
          payload: {
            type: 'kernel-http-listen-result',
            listenerId: message.listenerId,
            info: handle.info,
          } satisfies RuntimeKernelHttpProtocolMessage,
        });
      } catch (error) {
        this.postKernelHttpError(commandId, {
          listenerId: message.listenerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (type === 'kernel-http-close' && message.type === 'kernel-http-close') {
      pending.httpListeners?.get(message.listenerId)?.close();
      pending.httpListeners?.delete(message.listenerId);
      return;
    }
    if (type === 'kernel-http-response' && message.type === 'kernel-http-response') {
      const request = pending.httpRequests?.get(message.requestId);
      pending.httpRequests?.delete(message.requestId);
      request?.resolve(message.response);
      return;
    }
    if (type === 'kernel-http-error' && message.type === 'kernel-http-error' && message.requestId) {
      const request = pending.httpRequests?.get(message.requestId);
      pending.httpRequests?.delete(message.requestId);
      request?.reject(new Error(message.error));
    }
  }

  private dispatchWorkerKernelHttpRequest(
    commandId: string,
    listenerId: string,
    request: RuntimeKernelHttpRequest
  ): Promise<RuntimeKernelHttpResponse> {
    const pending = this.pendingMessages.get(commandId);
    if (!pending || !this.worker) return Promise.reject(new Error('Python worker is not running.'));
    const requestId = `${commandId}:http:${++this.httpRequestId}`;
    return new Promise<RuntimeKernelHttpResponse>((resolve, reject) => {
      pending.httpRequests?.set(requestId, { resolve, reject });
      this.worker?.postMessage({
        id: commandId,
        type: 'kernel-http-request',
        payload: {
          type: 'kernel-http-request',
          listenerId,
          requestId,
          request,
        } satisfies RuntimeKernelHttpProtocolMessage,
      });
    });
  }

  private postKernelHttpError(
    commandId: string,
    error: Omit<Extract<RuntimeKernelHttpProtocolMessage, { type: 'kernel-http-error' }>, 'type'>
  ): void {
    this.worker?.postMessage({
      id: commandId,
      type: 'kernel-http-error',
      payload: {
        type: 'kernel-http-error',
        ...error,
      } satisfies RuntimeKernelHttpProtocolMessage,
    });
  }

  private cleanupPendingKernelHttp(pending: PendingMessage): void {
    for (const listener of pending.httpListeners?.values() ?? []) listener.close();
    pending.httpListeners?.clear();
    for (const request of pending.httpRequests?.values() ?? []) request.reject(new Error('Python worker finished before HTTP response.'));
    pending.httpRequests?.clear();
  }

  /**
   * Execute code with a timeout - terminates worker if execution takes too long
   */
  private async executeWithTimeout<T>(
    executor: () => Promise<T>,
    timeoutMs: number = EXECUTION_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<T> {
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
        
        // Terminate the stuck worker and clear state
        logRuntimeDiagnostic('warn', {
          component: 'PythonWorkerClient',
          runtime: 'python',
          phase: 'execution-timeout',
          message: 'Python execution timed out; terminating worker.',
          detail: { timeoutMs },
        }, { enabled: this.debug });
        this.terminateAndReset();
        
        const seconds = Math.round(timeoutMs / 1000);
        reject(new Error(`Execution timed out (possible infinite loop). Code execution was stopped after ${seconds} seconds.`));
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
    this.warmupPromise = null;
    this.isInitializing = false;
    this.workerReadyPromise = null;
    this.workerReadyResolve = null;
    
    // Reject all pending messages
    for (const [, pending] of this.pendingMessages) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      this.cleanupPendingKernelHttp(pending);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }

  /**
   * Initialize the Python worker. Runtime loading is lazy unless warmup() is called.
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

        const shouldRetry =
          message.includes('Worker request timed out: init') ||
          message.includes('Worker was terminated') ||
          message.includes('Worker error') ||
          message.includes('failed to initialize in time');

        if (!shouldRetry) {
          throw error;
        }

        logRuntimeDiagnostic('warn', {
          component: 'PythonWorkerClient',
          runtime: 'python',
          phase: 'init-retry',
          message: 'Python worker init failed; resetting worker and retrying once.',
          detail: { message },
        }, { enabled: this.debug });

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

  async warmup(): Promise<WarmupResult> {
    if (this.warmupPromise) return this.warmupPromise;

    this.warmupPromise = (async () => {
      try {
        await this.init();
        return await this.sendMessage<WarmupResult>('warmup', undefined, INIT_TIMEOUT_MS);
      } catch (error) {
        this.warmupPromise = null;
        throw error;
      }
    })();

    return this.warmupPromise;
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
      maxStoredEvents?: number;
      minimalTrace?: boolean;
    },
    executionStyle: ExecutionStyle = 'function'
  ): Promise<ExecutionResult> {
    // Ensure the Python worker is initialized. Runtime loading is handled inside the worker.
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
          trace: createEmptyRuntimeTrace('python', { runId: 'python:run', file: 'solution.py' }),
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
    // Ensure the Python worker is initialized. Runtime loading is handled inside the worker.
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

  async executeCodeBatch(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    executionStyle: ExecutionStyle = 'function'
  ): Promise<CodeExecutionBatchResult> {
    await this.init();

    return this.executeWithTimeout(
      () => this.sendMessage<CodeExecutionBatchResult>('execute-code-batch', {
        code,
        functionName,
        inputBatch,
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
    // Ensure the Python worker is initialized. Runtime loading is handled inside the worker.
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

  async executeProjectPython(
    request: PythonProjectCommandRequest,
    timeoutMs: number = PROJECT_EXECUTION_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal
  ): Promise<PythonProjectCommandResult> {
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
    const { signal: _signal, onEvent: _requestOnEvent, kernelHttp, ...workerRequest } = request;
    return this.executeWithTimeout(
      () => this.sendMessage<PythonProjectCommandResult>(
        'execute-project-python',
        workerRequest,
        timeoutMs + 5000,
        onEvent,
        kernelHttp
      ),
      timeoutMs,
      signal
    );
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
    // Ensure the Python worker is initialized. Runtime loading is handled inside the worker.
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

export type PyodideWorkerClientOptions = PythonWorkerClientOptions;
export { PythonWorkerClient as PyodideWorkerClient };

/**
 * Check if the worker client is supported
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}
