/**
 * JavaScript/TypeScript Worker Client
 *
 * Two-role topology: a long-lived trusted `coordinator` worker (compiler,
 * trusted preparation) plus disposable `executor` workers that each run one
 * command and are retired, with a prewarmed standby so user commands do not
 * pay worker bootstrap on the critical path.
 *
 * Each role wraps a shared WorkerSessionCore (session lifecycle,
 * request/response, deadlines, Promise boundary). Connections are single-use:
 * once terminated they never respawn — the client creates a fresh connection
 * instead.
 */

import * as Effect from 'effect/Effect';
import type { CodeExecutionBatchResult, CodeExecutionResult, ExecutionResult, RuntimeBatchCall, RuntimeCodeCall, RuntimeTrace, RuntimeTraceCall } from '@tracecode/harness-core';
import {
  createEmptyRuntimeTrace,
  liftCodeBatchOutcome,
  liftCodeOutcome,
  liftTraceOutcome,
  type RawExecutionBatchPayload,
  type RawExecutionPayload,
} from '@tracecode/harness-core';

/** Raw wire payload from the tracing command; lifted into the outcome union here. */
type JavaScriptRawTraceResult = RawExecutionPayload & { trace?: RuntimeTrace };
import { appendWorkerUrlQueryParameter, isDevEnvironment } from '@tracecode/harness-browser/internal';
import type { BrowserWorkerFactory, BrowserWorkerLike } from '@tracecode/harness-browser/internal';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from '@tracecode/harness-browser/internal';
import { WorkerTerminatedError } from '@tracecode/harness-browser/internal';
import { WorkerSessionCore } from '@tracecode/harness-browser/internal';

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

interface InitResult {
  success: boolean;
  loadTimeMs: number;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
}

const EXECUTION_TIMEOUT_MS = 20000;
const TRACING_TIMEOUT_MS = 20000;
const INIT_TIMEOUT_MS = 10000;
const TYPESCRIPT_WARMUP_TIMEOUT_MS = 30000;
const MESSAGE_TIMEOUT_MS = 12000;
const WORKER_READY_TIMEOUT_MS = 10000;

type JavaScriptWorkerRole = 'coordinator' | 'executor';

class JavaScriptWorkerConnection {
  private disposed = false;
  readonly core: WorkerSessionCore;

  constructor(
    workerUrl: string,
    private readonly role: JavaScriptWorkerRole,
    debug: boolean,
    assetPreflight?: () => Promise<void>,
    workerFactory?: BrowserWorkerFactory
  ) {
    this.core = new WorkerSessionCore({
      runtimeLabel: `JavaScript ${role}`,
      component: 'JavaScriptWorkerClient',
      runtime: 'javascript',
      debug,
      readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
      defaultMessageTimeoutMs: MESSAGE_TIMEOUT_MS,
      isSupported: () => workerFactory !== undefined || typeof Worker !== 'undefined',
      createWorker: () => {
        if (this.disposed) {
          throw new Error(`JavaScript ${role} worker was terminated`);
        }
        let resolvedWorkerUrl = appendWorkerUrlQueryParameter(workerUrl, 'tracecodeRole', role);
        if (debug) {
          resolvedWorkerUrl = appendWorkerUrlQueryParameter(resolvedWorkerUrl, 'dev', String(Date.now()));
        }
        return workerFactory ? workerFactory(resolvedWorkerUrl) : new Worker(resolvedWorkerUrl);
      },
      preflight: async () => {
        await assetPreflight?.();
        if (this.disposed) {
          throw new Error(`JavaScript ${role} worker was terminated`);
        }
      },
      decodeReply: (payload) => restoreTransferredTraceEvents(payload),
      closeSessionOnWorkerError: true,
    });
    // Connections are single-use: any session close (crash, timeout, explicit
    // terminate) permanently retires this connection.
    this.core.onSessionClosed = () => {
      this.disposed = true;
    };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  sendMessageEffect<T>(type: string, payload?: unknown, timeoutMs: number | null = MESSAGE_TIMEOUT_MS): Effect.Effect<T, Error> {
    return this.core.sendMessageEffect<T>(type, payload, timeoutMs);
  }

  sendMessage<T>(type: string, payload?: unknown, timeoutMs: number = MESSAGE_TIMEOUT_MS): Promise<T> {
    return this.core.sendMessage<T>(type, payload, timeoutMs);
  }

  async prewarm(payload?: unknown): Promise<void> {
    await this.sendMessage('prewarm-executor', payload, INIT_TIMEOUT_MS);
  }

  terminate(reason: Error = new WorkerTerminatedError()): void {
    if (this.disposed) return;
    this.disposed = true;
    this.core.closeSession(reason);
  }
}

export class JavaScriptWorkerClient {
  private coordinator: JavaScriptWorkerConnection | null = null;
  private activeExecutionWorker: JavaScriptWorkerConnection | null = null;
  private standbyExecutionWorker: JavaScriptWorkerConnection | null = null;
  private standbyExecutionPromise: Promise<void> | null = null;
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromises = new Map<JavaScriptWorkerLanguage, Promise<WarmupResult>>();
  private executionTail: Promise<void> = Promise.resolve();
  private readonly debug: boolean;

  constructor(private readonly options: JavaScriptWorkerClientOptions) {
    this.debug = options.debug ?? isDevEnvironment();
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

  private terminateAll(reason: Error = new WorkerTerminatedError()): void {
    this.terminateExecution(reason);
    this.terminateStandbyExecution(reason);
    this.coordinator?.terminate(reason);
    this.coordinator = null;
    this.initPromise = null;
    this.warmupPromises.clear();
  }

  /**
   * One dispatched command as an Effect: trusted preparation on the
   * coordinator when required, then the operation on the executor. Message
   * deadlines are null throughout — the enclosing execution deadline is the
   * only clock, and interruption reaches the preparation step too.
   */
  private dispatchExecutionEffect<T>(
    worker: JavaScriptWorkerConnection,
    operation: 'execute-code' | 'execute-code-batch' | 'execute-with-tracing',
    payload: Record<string, unknown>,
    language: JavaScriptWorkerLanguage
  ): Effect.Effect<T, Error> {
    return Effect.gen(this, function* () {
      yield* Effect.tryPromise({
        try: () => this.options.runtimeAssetPreflight?.() ?? Promise.resolve(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });

      const requiresTrustedPreparation =
        language === 'typescript' ||
        operation === 'execute-with-tracing';
      let executionPayload = payload;
      if (requiresTrustedPreparation) {
        yield* Effect.tryPromise({
          try: async () => {
            await this.options.typescriptCompilerPreflight?.();
            await this.init();
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        const prepared = yield* this.getCoordinator().sendMessageEffect<{ preparedExecution: unknown }>(
          'prepare-execution',
          { operation, request: payload },
          null
        );
        executionPayload = { ...payload, preparedExecution: prepared.preparedExecution };
      }

      return yield* worker.sendMessageEffect<T>(
        operation,
        this.options.javascriptLibrariesUrl
          ? {
              ...executionPayload,
              runtimeAssets: { javascriptLibrariesUrl: this.options.javascriptLibrariesUrl },
            }
          : executionPayload,
        null
      );
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

  /** Run one command on the executor under the wall-clock deadline, with abort mapped to interruption. */
  private runExecution<T>(
    worker: JavaScriptWorkerConnection,
    program: Effect.Effect<T, Error>,
    wallClockMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    return worker.core.runClientEffect(worker.core.withExecutionDeadline(program, wallClockMs), signal);
  }

  async init(): Promise<InitResult> {
    if (this.coordinator?.isDisposed) {
      this.coordinator = null;
      this.initPromise = null;
      this.warmupPromises.clear();
    }
    if (this.initPromise) return this.initPromise;

    const promise = (async () => {
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
    this.initPromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.initPromise === promise) this.initPromise = null;
      throw error;
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

  async executeWithTracing(call: RuntimeTraceCall & { language?: JavaScriptWorkerLanguage }): Promise<ExecutionResult> {
    const { code, functionName, inputs, traceOptions, executionStyle = 'function', language = 'javascript', signal } = call;
    const result = await this.runIsolatedExecution((worker) =>
      this.runExecution(
        worker,
        this.dispatchExecutionEffect<JavaScriptRawTraceResult>(
          worker,
          'execute-with-tracing',
          {
            code,
            functionName,
            inputs,
            options: traceOptions,
            executionStyle,
            language,
            traceEventTransport: traceEventTransferRequest(),
          },
          language
        ),
        TRACING_TIMEOUT_MS,
        signal
      )
    );
    return liftTraceOutcome(
      result,
      result.trace ?? createEmptyRuntimeTrace(language, { runId: `${language}:run` }),
      'JavaScript tracing failed'
    );
  }

  async executeCode(call: RuntimeCodeCall & { language?: JavaScriptWorkerLanguage }): Promise<CodeExecutionResult> {
    const { code, functionName, inputs, executionStyle = 'function', language = 'javascript', signal, limits } = call;
    const wallClockMs = limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS;
    const result = await this.runIsolatedExecution((worker) =>
      this.runExecution(
        worker,
        this.dispatchExecutionEffect<RawExecutionPayload>(
          worker,
          'execute-code',
          {
            code,
            functionName,
            inputs,
            executionStyle,
            language,
          },
          language
        ),
        wallClockMs,
        signal
      )
    );
    return liftCodeOutcome(result, 'JavaScript execution failed');
  }

  async executeCodeBatch(call: RuntimeBatchCall & { language?: JavaScriptWorkerLanguage }): Promise<CodeExecutionBatchResult> {
    const { code, functionName, inputBatch, executionStyle = 'function', language = 'javascript', signal } = call;
    const result = await this.runIsolatedExecution((worker) =>
      this.runExecution(
        worker,
        this.dispatchExecutionEffect<RawExecutionBatchPayload>(
          worker,
          'execute-code-batch',
          {
            code,
            functionName,
            inputBatch,
            executionStyle,
            language,
          },
          language
        ),
        EXECUTION_TIMEOUT_MS,
        signal
      )
    );
    return liftCodeBatchOutcome(result, 'JavaScript execution failed');
  }

  terminate(): void {
    this.terminateAll();
  }
}

export function isJavaScriptWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}
