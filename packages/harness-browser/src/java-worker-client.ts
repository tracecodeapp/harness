import type { CodeExecutionBatchResult, CodeExecutionResult, RuntimeExecutionTimings } from '@tracecode/harness-core';
import type {
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeProjectCommandRequest,
} from '@tracecode/harness-core';
import { javaTraceHooksEventsToRuntimeTrace } from '@tracecode/harness-core';
import { createEmptyRuntimeTrace, type RuntimeTrace } from '@tracecode/harness-core';
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
import type { BrowserWorkerFactory, BrowserWorkerLike } from './execution-host';

type MessageId = string;
export type JavaExecutionStyle = 'function' | 'solution-method' | 'ops-class';

const JAVA_KERNEL_HTTP_RUNTIME_LABEL = 'Java';

export interface JavaWorkerClientOptions {
  workerUrl: string;
  debug?: boolean;
  workerIdleTimeoutMs?: number;
  externalCompilerUrl?: string;
  cheerpjLoaderUrl?: string;
  assetPreflight?: () => Promise<void>;
  runtimeAssetPreflight?: () => Promise<void>;
  workerFactory?: BrowserWorkerFactory;
  /** Enables runtime-owned IndexedDB only when the worker runs on a dedicated execution origin. */
  isolatedRuntimeStorage?: boolean;
  /** Permanent mode is only safe when this worker is retired after its project command. */
  projectUserAuthorityMode?: 'temporary' | 'permanent' | 'isolated-origin';
  runtimeAssets?: {
    loaderUrl?: string;
    helperJarUrl?: string;
    compilerJarUrl?: string;
    rewriterJarUrl?: string;
    parserJarUrl?: string;
  };
}

interface PendingMessage {
  protocolToken: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: RuntimeCommandEventHandler;
  kernelHttp?: RuntimeKernelHttpBridge;
  httpServers?: Map<string, KernelHttpSyncServerBridge>;
  timeoutId?: ReturnType<typeof setTimeout>;
}

function createExecutionAbortError(): Error {
  return Object.assign(new Error('Execution aborted'), { name: 'AbortError' });
}

interface WorkerMessage {
  id?: MessageId;
  requestId?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
  timings?: RuntimeExecutionTimings;
}

interface WarmupResult {
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

export type JavaWorkerProjectRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type JavaWorkerProjectResult = RuntimeCommandResult;

export interface JavaTraceExecutionOptions {
  maxTraceSteps?: number;
  maxLineEvents?: number;
  maxSingleLineHits?: number;
  maxStoredEvents?: number;
  maxPathDepth?: number;
  minimalTrace?: boolean;
}

const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 25_000;
const INIT_TIMEOUT_MS = 120_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const JAVA_DEFAULT_FILE = 'solution.java';

export class JavaWorkerClient {
  private worker: BrowserWorkerLike | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private activeExternalCompileControllers = new Set<AbortController>();
  private readonly debug: boolean;

  constructor(private readonly options: JavaWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
  }

  isSupported(): boolean {
    return this.options.workerFactory !== undefined || typeof Worker !== 'undefined';
  }

  private getWorker(): BrowserWorkerLike {
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

    this.worker = this.options.workerFactory
      ? this.options.workerFactory(workerUrl)
      : new Worker(workerUrl);
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, type, payload, protocolToken } = event.data;

      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        logRuntimeDiagnostic('info', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'worker-ready',
          message: 'Java worker is ready.',
        }, { enabled: this.debug });
        return;
      }

      if (type === 'idle-timeout') {
        logRuntimeDiagnostic('info', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'idle-timeout',
          message: 'Java worker closed after idle timeout.',
        }, { enabled: this.debug });
        this.terminateAndReset(new Error('Java worker closed after idle timeout'));
        return;
      }

      if (type === 'java-compile-request') {
        if (!this.hasPendingProtocolToken(protocolToken)) return;
        this.handleJavaCompileRequest(event.data).catch((error) => {
          if (!event.data.requestId) return;
          this.worker?.postMessage({
            type: 'java-compile-response',
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
      if (type === 'kernel-http-dispatch-sync') {
        this.handleKernelHttpDispatchSync(id, payload);
        return;
      }
      if (type === 'kernel-http-listen-sync') {
        this.handleKernelHttpListenSync(id, payload);
        return;
      }
      if (type === 'kernel-http-close') {
        this.handleKernelHttpClose(id, payload);
        return;
      }
      this.pendingMessages.delete(id);
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      this.closePendingHttpListeners(pending);

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
        component: 'JavaWorkerClient',
        runtime: 'java',
        phase: 'worker-error',
        message: 'Java worker emitted an error event.',
        detail: {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        },
      });
      const workerError = new Error(error.message || 'Java worker error');
      this.workerReadyReject?.(workerError);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;
      for (const [, pending] of this.pendingMessages) {
        if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
        this.closePendingHttpListeners(pending);
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
        logRuntimeDiagnostic('warn', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'worker-ready-timeout',
          message: 'Java worker did not send worker-ready before the timeout.',
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
    kernelHttp?: RuntimeKernelHttpBridge
  ): Promise<T> {
    await this.options.assetPreflight?.();
    if (type !== 'status') {
      await this.options.runtimeAssetPreflight?.();
    }
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
        ...(kernelHttp ? { kernelHttp } : {}),
        httpServers: new Map(),
      });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
        this.closePendingHttpListeners(pending);
        logRuntimeDiagnostic('warn', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'worker-request-timeout',
          message: 'Java worker request timed out.',
          detail: { id, type, timeoutMs },
        }, { enabled: this.debug });
        pending.reject(new Error(`Worker request timed out: ${type}`));
      }, timeoutMs);

      const pending = this.pendingMessages.get(id);
      if (pending) pending.timeoutId = timeoutId;

      worker.postMessage({ id, type, payload, protocolToken });
    });
  }

  private closePendingHttpListeners(pending: PendingMessage): void {
    closeKernelHttpSyncServers(pending, JAVA_KERNEL_HTTP_RUNTIME_LABEL);
  }

  private handleKernelHttpDispatchSync(commandId: MessageId, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    handleKernelHttpDispatchSyncMessage(pending, payload, JAVA_KERNEL_HTTP_RUNTIME_LABEL);
  }

  private handleKernelHttpListenSync(commandId: MessageId, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    handleKernelHttpListenSyncMessage(pending, payload, JAVA_KERNEL_HTTP_RUNTIME_LABEL);
  }

  private handleKernelHttpClose(commandId: MessageId, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    handleKernelHttpCloseMessage(pending, payload, JAVA_KERNEL_HTTP_RUNTIME_LABEL);
  }

  private hasPendingProtocolToken(protocolToken: unknown): protocolToken is string {
    return typeof protocolToken === 'string' &&
      Array.from(this.pendingMessages.values()).some((pending) => pending.protocolToken === protocolToken);
  }

  private async handleJavaCompileRequest(message: WorkerMessage): Promise<void> {
    if (!message.requestId) return;
    const worker = this.worker;
    if (!worker) return;

    const result = await this.compileJavaWithExternalUrl(message.payload);
    worker.postMessage({
      type: 'java-compile-response',
      requestId: message.requestId,
      protocolToken: message.protocolToken,
      payload: result,
    });
  }

  private async compileJavaWithExternalUrl(payload: unknown): Promise<Record<string, unknown>> {
    if (!this.options.externalCompilerUrl) {
      return { success: false, error: 'Java external compiler URL is not configured.' };
    }

    const controller = new AbortController();
    this.activeExternalCompileControllers.add(controller);
    let response: Response;
    try {
      response = await fetch(this.options.externalCompilerUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
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

    let body: Record<string, unknown> = {};
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    } else {
      const text = await response.text();
      body = text ? { error: text } : {};
    }

    if (response.ok) {
      return {
        ...body,
        success: body.success !== false,
        compileMs: typeof body.compileMs === 'number' ? body.compileMs : headerNumber('x-tracecode-compile-ms'),
        compileCacheHit: typeof body.compileCacheHit === 'boolean'
          ? body.compileCacheHit
          : headerBoolean('x-tracecode-compile-cache-hit'),
      };
    }

    return {
      success: false,
      error: typeof body.error === 'string' ? body.error : `Java external compiler failed with HTTP ${response.status}.`,
      stdout: typeof body.stdout === 'string' ? body.stdout : '',
      stderr: typeof body.stderr === 'string' ? body.stderr : '',
      compileMs: typeof body.compileMs === 'number' ? body.compileMs : headerNumber('x-tracecode-compile-ms'),
      compileCacheHit: typeof body.compileCacheHit === 'boolean'
        ? body.compileCacheHit
        : headerBoolean('x-tracecode-compile-cache-hit'),
    };
  }

  private async executeWithTimeout<T>(executor: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
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
        logRuntimeDiagnostic('warn', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'execution-timeout',
          message: 'Java execution timed out; terminating worker.',
          detail: { timeoutMs },
        }, { enabled: this.debug });
        this.terminateAndReset();
        reject(
          new Error(
            `Java execution timed out after ${Math.round(timeoutMs / 1000)} seconds.`
          )
        );
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
    this.workerReadyReject = null;

    for (const [, pending] of this.pendingMessages) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      this.closePendingHttpListeners(pending);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
    for (const controller of this.activeExternalCompileControllers) {
      controller.abort();
    }
    this.activeExternalCompileControllers.clear();
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
        return await this.sendMessage<InitResult>('init', this.workerOptionsPayload(), INIT_TIMEOUT_MS);
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

        logRuntimeDiagnostic('warn', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'init-retry',
          message: 'Java worker init failed; resetting worker and retrying once.',
          detail: { message },
        }, { enabled: this.debug });

        this.terminateAndReset(error instanceof Error ? error : new Error(message));
        return this.sendMessage<InitResult>('init', this.workerOptionsPayload(), INIT_TIMEOUT_MS);
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

  private workerOptionsPayload(): {
    idleTimeoutMs?: number;
    externalCompilerEnabled?: boolean;
    cheerpjLoaderUrl?: string;
    runtimeAssets?: JavaWorkerClientOptions['runtimeAssets'];
    allowIsolatedRuntimeStorage?: boolean;
  } {
    return {
      ...(this.options.workerIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.options.workerIdleTimeoutMs }),
      ...(this.options.externalCompilerUrl ? { externalCompilerEnabled: true } : {}),
      ...(this.options.cheerpjLoaderUrl ? { cheerpjLoaderUrl: this.options.cheerpjLoaderUrl } : {}),
      ...(this.options.runtimeAssets ? { runtimeAssets: this.options.runtimeAssets } : {}),
      ...(this.options.isolatedRuntimeStorage ? { allowIsolatedRuntimeStorage: true } : {}),
    };
  }

  async warmup(): Promise<WarmupResult> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      try {
        await this.init();
        return await this.sendMessage<WarmupResult>(
          'warmup',
          this.workerOptionsPayload(),
          INIT_TIMEOUT_MS
        );
      } catch (error) {
        this.warmupPromise = null;
        throw error;
      }
    })();
    return this.warmupPromise;
  }

  async executeWithTracing(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle,
    signal?: AbortSignal
  ): Promise<JavaWorkerTraceResult> {
    await this.init();
    const result = await this.executeWithTimeout(
      () =>
        this.sendMessage<JavaWorkerRawTraceResult>(
          'execute-with-tracing',
          {
            code,
            functionName,
            inputs,
            options,
            executionStyle,
            traceEventTransport: traceEventTransferRequest(),
            ...this.workerOptionsPayload(),
          },
          TRACING_TIMEOUT_MS + 5_000
        ),
      TRACING_TIMEOUT_MS,
      signal
    );
    return {
      ...result,
      trace: result.success
        ? javaTraceHooksEventsToRuntimeTrace(result.events, result.sourceText, {
            runId: 'java:run',
            file: JAVA_DEFAULT_FILE,
            maxPathDepth: options?.maxPathDepth,
          })
        : createEmptyRuntimeTrace('java', { runId: 'java:run', file: JAVA_DEFAULT_FILE }),
    };
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    return this.executeCodeMessage('execute-code', code, functionName, inputs, options, executionStyle, signal);
  }

  async executeCodeBatch(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionBatchResult> {
    await this.init();
    return this.executeWithTimeout(
      () =>
        this.sendMessage<CodeExecutionBatchResult>(
          'execute-code-batch',
          { code, functionName, inputBatch, options, executionStyle, ...this.workerOptionsPayload() },
          EXECUTION_TIMEOUT_MS + 5_000
        ),
      EXECUTION_TIMEOUT_MS,
      signal
    );
  }

  private async executeCodeMessage(
    type: 'execute-code' | 'execute-code-interview',
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    await this.init();
    const result = await this.executeWithTimeout(
      () =>
        this.sendMessage<JavaWorkerCodeResult>(
          type,
          { code, functionName, inputs, options, executionStyle, ...this.workerOptionsPayload() },
          EXECUTION_TIMEOUT_MS + 5_000
        ),
      EXECUTION_TIMEOUT_MS,
      signal
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
    executionStyle: JavaExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    return this.executeCodeMessage('execute-code-interview', code, functionName, inputs, options, executionStyle, signal);
  }

  async executeProjectJava(
    request: JavaWorkerProjectRequest,
    timeoutMs = EXECUTION_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal
  ): Promise<JavaWorkerProjectResult> {
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
      () =>
        this.sendMessage<JavaWorkerProjectResult>(
          'execute-project-java',
          {
            ...workerRequest,
            ...(this.options.projectUserAuthorityMode
              ? { projectUserAuthorityMode: this.options.projectUserAuthorityMode }
              : {}),
          },
          timeoutMs + 5_000,
          onEvent,
          kernelHttp
        ),
      timeoutMs,
      signal
    );
  }

  terminate(): void {
    this.terminateAndReset();
  }
}
