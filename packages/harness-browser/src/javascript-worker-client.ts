import type { CodeExecutionBatchResult, CodeExecutionResult, ExecutionResult } from '@tracecode/harness-core';
import { logRuntimeDiagnostic } from './runtime-diagnostics';
import type { BrowserWorkerFactory, BrowserWorkerLike } from './execution-host';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from './trace-event-transport';
import { createWorkerProtocolToken } from './worker-protocol';

type MessageId = string;
export type JavaScriptExecutionStyle = 'function' | 'solution-method' | 'ops-class';
export type JavaScriptWorkerLanguage = 'javascript' | 'typescript';

export interface JavaScriptWorkerClientOptions {
  workerUrl: string;
  workerFactory?: BrowserWorkerFactory;
  debug?: boolean;
  assetPreflight?: () => Promise<void>;
  runtimeAssetPreflight?: () => Promise<void>;
  javascriptLibrariesUrl?: string;
  typescriptCompilerUrl?: string;
  typescriptCompilerPreflight?: () => Promise<void>;
}

interface PendingMessage {
  protocolToken: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface WorkerMessage {
  id?: MessageId;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
}

const EXECUTION_TIMEOUT_MS = 20000;
const INTERVIEW_MODE_TIMEOUT_MS = 5000;
const TRACING_TIMEOUT_MS = 20000;
const INIT_TIMEOUT_MS = 10000;
const TYPESCRIPT_WARMUP_TIMEOUT_MS = 30000;
const MESSAGE_TIMEOUT_MS = 12000;
const WORKER_READY_TIMEOUT_MS = 10000;

type JavaScriptWorkerRole = 'coordinator' | 'executor';

function appendWorkerQueryParameter(workerUrl: string, name: string, value: string): string {
  const hashIndex = workerUrl.indexOf('#');
  const beforeHash = hashIndex >= 0 ? workerUrl.slice(0, hashIndex) : workerUrl;
  const hash = hashIndex >= 0 ? workerUrl.slice(hashIndex) : '';
  const encodedName = encodeURIComponent(name);
  const encodedValue = encodeURIComponent(value);
  const existing = new RegExp(`([?&])${encodedName}=[^&#]*`);
  if (existing.test(beforeHash)) {
    return `${beforeHash.replace(existing, `$1${encodedName}=${encodedValue}`)}${hash}`;
  }
  return `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}${encodedName}=${encodedValue}${hash}`;
}

class JavaScriptWorkerConnection {
  private worker: BrowserWorkerLike | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private disposed = false;

  constructor(
    private readonly workerUrl: string,
    private readonly role: JavaScriptWorkerRole,
    private readonly debug: boolean,
    private readonly assetPreflight?: () => Promise<void>,
    private readonly workerFactory?: BrowserWorkerFactory
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  private getWorker(): BrowserWorkerLike {
    if (this.disposed) {
      throw new Error(`JavaScript ${this.role} worker was terminated`);
    }
    if (this.worker) return this.worker;
    if (!this.workerFactory && typeof Worker === 'undefined') {
      throw new Error('Web Workers are not supported in this environment');
    }

    this.workerReadyPromise = new Promise((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = reject;
    });

    let resolvedWorkerUrl = appendWorkerQueryParameter(this.workerUrl, 'tracecodeRole', this.role);
    if (this.debug) {
      resolvedWorkerUrl = appendWorkerQueryParameter(resolvedWorkerUrl, 'dev', String(Date.now()));
    }
    const worker = this.workerFactory
      ? this.workerFactory(resolvedWorkerUrl)
      : new Worker(resolvedWorkerUrl);
    this.worker = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, type, payload, protocolToken } = event.data;
      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        logRuntimeDiagnostic('info', {
          component: 'JavaScriptWorkerClient',
          runtime: 'javascript',
          phase: 'worker-ready',
          message: `JavaScript ${this.role} worker is ready.`,
        }, { enabled: this.debug });
        return;
      }

      if (!id) return;
      const pending = this.pendingMessages.get(id);
      if (!pending || protocolToken !== pending.protocolToken) return;
      this.pendingMessages.delete(id);
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
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

    worker.onerror = (error) => {
      logRuntimeDiagnostic('error', {
        component: 'JavaScriptWorkerClient',
        runtime: 'javascript',
        phase: 'worker-error',
        message: `JavaScript ${this.role} worker emitted an error event.`,
        detail: {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        },
      });
      this.terminate(new Error(`JavaScript ${this.role} worker error`));
    };

    return worker;
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
          `JavaScript ${this.role} worker failed to initialize in time (${Math.round(WORKER_READY_TIMEOUT_MS / 1000)}s)`
        );
        this.terminate(timeoutError);
        reject(timeoutError);
      }, WORKER_READY_TIMEOUT_MS);

      readyPromise.then(() => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        resolve();
      }).catch((error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async sendMessage<T>(
    type: string,
    payload?: unknown,
    timeoutMs: number = MESSAGE_TIMEOUT_MS
  ): Promise<T> {
    await this.assetPreflight?.();
    const worker = this.getWorker();
    await this.waitForWorkerReady();
    if (this.disposed || worker !== this.worker) {
      throw new Error(`JavaScript ${this.role} worker was terminated`);
    }
    const id = String(++this.messageId);
    const protocolToken = createWorkerProtocolToken();

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        protocolToken,
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
      worker.postMessage({ id, type, payload, protocolToken });
    });
  }

  async prewarm(payload?: unknown): Promise<void> {
    await this.sendMessage('prewarm-executor', payload, INIT_TIMEOUT_MS);
  }

  terminate(reason: Error = new Error('Worker was terminated')): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workerReadyReject?.(reason);
    this.workerReadyResolve = null;
    this.workerReadyReject = null;
    this.worker?.terminate();
    this.worker = null;
    this.workerReadyPromise = null;
    for (const pending of this.pendingMessages.values()) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }
}

export class JavaScriptWorkerClient {
  private coordinator: JavaScriptWorkerConnection | null = null;
  private activeExecutionWorker: JavaScriptWorkerConnection | null = null;
  private standbyExecutionWorker: JavaScriptWorkerConnection | null = null;
  private standbyExecutionPromise: Promise<void> | null = null;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromises = new Map<JavaScriptWorkerLanguage, Promise<WarmupResult>>();
  private executionTail: Promise<void> = Promise.resolve();
  private readonly debug: boolean;

  constructor(private readonly options: JavaScriptWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
  }

  isSupported(): boolean {
    return this.options.workerFactory !== undefined || typeof Worker !== 'undefined';
  }

  private getCoordinator(): JavaScriptWorkerConnection {
    if (!this.isSupported()) {
      throw new Error('Web Workers are not supported in this environment');
    }
    if (!this.coordinator || this.coordinator.isDisposed) {
      this.coordinator = new JavaScriptWorkerConnection(
        this.options.workerUrl,
        'coordinator',
        this.debug,
        this.options.assetPreflight,
        this.options.workerFactory
      );
    }
    return this.coordinator;
  }

  private createExecutionWorker(): JavaScriptWorkerConnection {
    return new JavaScriptWorkerConnection(
      this.options.workerUrl,
      'executor',
      this.debug,
      this.options.assetPreflight,
      this.options.workerFactory
    );
  }

  private terminateExecution(reason: Error = new Error('Execution worker was terminated')): void {
    this.activeExecutionWorker?.terminate(reason);
    this.activeExecutionWorker = null;
  }

  private terminateStandbyExecution(reason: Error = new Error('Standby execution worker was terminated')): void {
    this.standbyExecutionWorker?.terminate(reason);
    this.standbyExecutionWorker = null;
    this.standbyExecutionPromise = null;
  }

  private executionRuntimeAssetsPayload(): Record<string, unknown> | undefined {
    return this.options.javascriptLibrariesUrl
      ? { runtimeAssets: { javascriptLibrariesUrl: this.options.javascriptLibrariesUrl } }
      : undefined;
  }

  private ensureStandbyExecutionWorker(): Promise<void> {
    if (
      this.standbyExecutionWorker &&
      !this.standbyExecutionWorker.isDisposed &&
      this.standbyExecutionPromise
    ) {
      return this.standbyExecutionPromise;
    }

    const worker = this.createExecutionWorker();
    this.standbyExecutionWorker = worker;
    const prewarmPromise = worker.prewarm(this.executionRuntimeAssetsPayload()).catch((error) => {
      if (this.standbyExecutionWorker === worker) {
        worker.terminate(error instanceof Error ? error : new Error(String(error)));
        this.standbyExecutionWorker = null;
        this.standbyExecutionPromise = null;
      }
      throw error;
    });
    this.standbyExecutionPromise = prewarmPromise;
    return prewarmPromise;
  }

  private async takeStandbyExecutionWorker(): Promise<JavaScriptWorkerConnection> {
    await this.ensureStandbyExecutionWorker();
    const worker = this.standbyExecutionWorker;
    if (!worker || worker.isDisposed) {
      throw new Error('JavaScript standby execution worker was terminated before use');
    }
    this.standbyExecutionWorker = null;
    this.standbyExecutionPromise = null;
    return worker;
  }

  private terminateAll(reason: Error = new Error('Worker was terminated')): void {
    this.terminateExecution(reason);
    this.terminateStandbyExecution(reason);
    this.coordinator?.terminate(reason);
    this.coordinator = null;
    this.initPromise = null;
    this.warmupPromises.clear();
    this.isInitializing = false;
  }

  private async dispatchExecution<T>(
    worker: JavaScriptWorkerConnection,
    operation: 'execute-code' | 'execute-code-batch' | 'execute-with-tracing' | 'execute-code-interview',
    payload: Record<string, unknown>,
    language: JavaScriptWorkerLanguage,
    timeoutMs: number
  ): Promise<T> {
    await this.options.runtimeAssetPreflight?.();
    const requiresTrustedPreparation =
      language === 'typescript' ||
      operation === 'execute-with-tracing' ||
      operation === 'execute-code-interview';
    let executionPayload = payload;
    if (requiresTrustedPreparation) {
      await this.options.typescriptCompilerPreflight?.();
      await this.init();
      const prepared = await this.getCoordinator().sendMessage<{ preparedExecution: unknown }>(
        'prepare-execution',
        { operation, request: payload },
        timeoutMs
      );
      executionPayload = { ...payload, preparedExecution: prepared.preparedExecution };
    }
    return worker.sendMessage<T>(
      operation,
      this.options.javascriptLibrariesUrl
        ? {
            ...executionPayload,
            runtimeAssets: { javascriptLibrariesUrl: this.options.javascriptLibrariesUrl },
          }
        : executionPayload,
      timeoutMs
    );
  }

  private async executeWithTimeout<T>(
    executor: () => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      const abortError = new Error('Execution aborted');
      this.terminateExecution(abortError);
      throw abortError;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        globalThis.clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const abortError = new Error('Execution aborted');
        this.terminateExecution(abortError);
        reject(abortError);
      };

      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this.terminateExecution();
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
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runIsolatedExecution<T>(
    executor: (worker: JavaScriptWorkerConnection) => Promise<T>
  ): Promise<T> {
    const previous = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    let worker: JavaScriptWorkerConnection | null = null;
    try {
      worker = await this.takeStandbyExecutionWorker();
      this.activeExecutionWorker = worker;
      // Keep one clean executor ready while the current command runs. The
      // standby never receives user code, so every command still gets a fresh
      // authority boundary without paying worker bootstrap on its critical path.
      void this.ensureStandbyExecutionWorker().catch(() => undefined);
      return await executor(worker);
    } finally {
      worker?.terminate();
      if (this.activeExecutionWorker === worker) this.activeExecutionWorker = null;
      release();
    }
  }

  async init(): Promise<InitResult> {
    if (this.coordinator?.isDisposed) {
      this.coordinator = null;
      this.initPromise = null;
      this.warmupPromises.clear();
    }
    if (this.initPromise) return this.initPromise;

    if (this.isInitializing) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      return this.init();
    }

    this.isInitializing = true;
    this.initPromise = (async () => {
      const standbyPromise = this.ensureStandbyExecutionWorker();
      try {
        await this.options.runtimeAssetPreflight?.();
        const result = await this.getCoordinator().sendMessage<InitResult>(
          'init',
          this.options.typescriptCompilerUrl || this.options.javascriptLibrariesUrl
            ? {
                ...(this.options.typescriptCompilerUrl
                  ? { typescriptCompilerUrl: this.options.typescriptCompilerUrl }
                  : {}),
                ...(this.options.javascriptLibrariesUrl
                  ? { javascriptLibrariesUrl: this.options.javascriptLibrariesUrl }
                  : {}),
              }
            : undefined,
          INIT_TIMEOUT_MS
        );
        await standbyPromise;
        return result;
      } catch (error) {
        await standbyPromise.catch(() => undefined);
        throw error;
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

  async warmup(language: JavaScriptWorkerLanguage = 'javascript'): Promise<WarmupResult> {
    const existing = this.warmupPromises.get(language);
    if (existing) return existing;

    const warmupPromise = (async () => {
      if (language === 'typescript') await this.options.typescriptCompilerPreflight?.();
      await this.init();
      return this.getCoordinator().sendMessage<WarmupResult>(
        'warmup',
        { language },
        language === 'typescript' ? TYPESCRIPT_WARMUP_TIMEOUT_MS : INIT_TIMEOUT_MS
      );
    })();

    this.warmupPromises.set(language, warmupPromise);

    try {
      return await warmupPromise;
    } catch (error) {
      this.warmupPromises.delete(language);
      throw error;
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
      maxStoredEvents?: number;
      minimalTrace?: boolean;
    },
    executionStyle: JavaScriptExecutionStyle = 'function',
    language: JavaScriptWorkerLanguage = 'javascript',
    signal?: AbortSignal
  ): Promise<ExecutionResult> {
    return this.runIsolatedExecution((worker) =>
      this.executeWithTimeout(
        () =>
          this.dispatchExecution<ExecutionResult>(
            worker,
            'execute-with-tracing',
            {
              code,
              functionName,
              inputs,
              options,
              executionStyle,
              language,
              traceEventTransport: traceEventTransferRequest(),
            },
            language,
            TRACING_TIMEOUT_MS + 2000
          ),
        TRACING_TIMEOUT_MS,
        signal
      )
    );
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: JavaScriptExecutionStyle = 'function',
    language: JavaScriptWorkerLanguage = 'javascript',
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    return this.runIsolatedExecution((worker) =>
      this.executeWithTimeout(
        () =>
          this.dispatchExecution<CodeExecutionResult>(
            worker,
            'execute-code',
            {
              code,
              functionName,
              inputs,
              executionStyle,
              language,
            },
            language,
            EXECUTION_TIMEOUT_MS + 2000
          ),
        EXECUTION_TIMEOUT_MS,
        signal
      )
    );
  }

  async executeCodeBatch(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    executionStyle: JavaScriptExecutionStyle = 'function',
    language: JavaScriptWorkerLanguage = 'javascript',
    signal?: AbortSignal
  ): Promise<CodeExecutionBatchResult> {
    return this.runIsolatedExecution((worker) =>
      this.executeWithTimeout(
        () =>
          this.dispatchExecution<CodeExecutionBatchResult>(
            worker,
            'execute-code-batch',
            {
              code,
              functionName,
              inputBatch,
              executionStyle,
              language,
            },
            language,
            EXECUTION_TIMEOUT_MS + 2000
          ),
        EXECUTION_TIMEOUT_MS,
        signal
      )
    );
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: JavaScriptExecutionStyle = 'function',
    language: JavaScriptWorkerLanguage = 'javascript',
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    return this.runIsolatedExecution(async (worker) => {
      const result = await this.executeWithTimeout(
        () =>
          this.dispatchExecution<CodeExecutionResult>(
            worker,
            'execute-code-interview',
            {
              code,
              functionName,
              inputs,
              executionStyle,
              language,
            },
            language,
            INTERVIEW_MODE_TIMEOUT_MS + 2000
          ),
        INTERVIEW_MODE_TIMEOUT_MS,
        signal
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
    }).catch(() => ({
      success: false,
      output: null,
      error: 'Time Limit Exceeded',
      consoleOutput: [],
    }));
  }

  terminate(): void {
    this.terminateAll();
  }
}

export function isJavaScriptWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}
