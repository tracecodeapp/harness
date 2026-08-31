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
import type {
  CodeExecutionBatchResult,
  CodeExecutionResult,
  ExecutionResult,
  RuntimeBatchCall,
  RuntimeCodeCall,
  RuntimeExecutionTimings,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedCodeCall,
  RuntimePreparedProgram,
  RuntimePreparedTraceBatchCall,
  RuntimePreparedTraceCall,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeTrace,
  RuntimeTraceCall,
} from '@tracecode/runtime-contracts';
import {
  createEmptyRuntimeTrace,
  liftCodeOutcome,
  liftTraceOutcome,
  type RawExecutionPayload,
} from '@tracecode/runtime-contracts';

/** Raw wire payload from the tracing command; lifted into the outcome union here. */
type JavaScriptRawTraceResult = RawExecutionPayload & { trace?: RuntimeTrace };
import { appendWorkerUrlQueryParameter, isDevEnvironment } from '@tracecode/runtime-browser/internal';
import type { BrowserWorkerFactory } from '@tracecode/runtime-browser/internal';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from '@tracecode/runtime-browser/internal';
import {
  ExecutionTimeoutError,
  isExecutionTimeoutError,
  WorkerReportedError,
  WorkerTerminatedError,
} from '@tracecode/runtime-browser/internal';
import { WorkerSessionCore } from '@tracecode/runtime-browser/internal';
import { createJavaScriptPreparedProgram } from './javascript-prepared-program';
import type {
  SesAlgorithmWorkerPool,
  SesAlgorithmPreparedProgram,
  SesAlgorithmPreparedSource,
} from './ses-algorithm-worker-client';

type SesAlgorithmWorkerModule =
  typeof import('./ses-algorithm-worker-client');

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
  /** Replenish one clean executor after leasing the current standby. */
  replenishStandbyAfterUse?: boolean;
  /** @internal Retained hardened workers with one fresh SES compartment per case. */
  algorithmExecution?: 'disposable-worker' | 'ses-compartment-pool';
  /** @internal Module Worker asset used only by `ses-compartment-pool`. */
  algorithmWorkerUrl?: string;
  /** @internal Absolute library asset URL used only by the SES module Worker. */
  algorithmJavascriptLibrariesUrl?: string;
  /** @internal Optional SRI pin enforced by the SES module Worker. */
  algorithmJavascriptLibrariesIntegrity?: string;
  /** @internal Readiness check for the SES algorithm Worker asset. */
  algorithmWorkerPreflight?: () => Promise<void>;
}

export interface JavaScriptWorkerBatchCall extends RuntimeBatchCall {
  readonly language?: JavaScriptWorkerLanguage;
  /** Applied independently to each case in the batch. */
  readonly limits?: RuntimePreparedCodeBatchCall['limits'];
  /**
   * Aggregate safety deadline for the complete batch. Per-case limits remain
   * in `limits`; this separate clock preserves the historical direct-batch
   * budget without changing Judge's per-case semantics.
   */
  readonly batchWallClockMs?: number;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
}

interface PreparedExecutionReply {
  preparedExecution: unknown;
  timings?: RuntimeExecutionTimings;
}

interface SesCompatiblePreparedExecution {
  readonly executableCode: string;
  readonly instrumentedCode?: string | null;
  readonly traceLineBounds?: {
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly materializers: Readonly<Record<string, unknown>>;
  readonly inputArguments: readonly {
    readonly key: string;
    readonly rest?: boolean;
  }[];
}

const EXECUTION_TIMEOUT_MS = 20000;
const TRACING_TIMEOUT_MS = 20000;
const INIT_TIMEOUT_MS = 10000;
const TYPESCRIPT_WARMUP_TIMEOUT_MS = 30000;
const MESSAGE_TIMEOUT_MS = 12000;
const WORKER_READY_TIMEOUT_MS = 10000;
// Four keeps the renderer's transient CPU/memory burst bounded while still
// overlapping the per-worker startup that dominates multi-case drains.
const BATCH_PREWARM_LIMIT = 4;

type JavaScriptWorkerRole = 'coordinator' | 'executor';

function performanceNow(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

interface SesAlgorithmInputScanState {
  readonly visited: WeakSet<object>;
  remaining: number;
}

function scanSesAlgorithmInput(
  value: unknown,
  state: SesAlgorithmInputScanState,
  depth: number
): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (typeof value !== 'object' || depth > 64 || state.remaining-- <= 0) {
    return false;
  }
  // JSON duplicates shared references and cannot represent cycles. Reject both
  // rather than silently changing identity semantics inside the compartment.
  if (state.visited.has(value)) return false;
  state.visited.add(value);

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string' ||
        (key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key)))) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable ||
          !scanSesAlgorithmInput(descriptor.value, state, depth + 1)) return false;
    }
    return ownKeys.length === value.length + 1;
  }
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable ||
        !scanSesAlgorithmInput(descriptor.value, state, depth + 1)) return false;
  }
  return true;
}

function isSesAlgorithmInputEligible(value: unknown): boolean {
  return scanSesAlgorithmInput(value, {
    visited: new WeakSet(),
    remaining: 100_000,
  }, 0);
}

function preparationErrorLine(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\bline\s+(\d+)\b/i.exec(message) ??
    /\((\d+):\d+\)/.exec(message);
  if (!match) return undefined;
  const line = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function sesCompatiblePreparedExecution(
  value: unknown
): SesCompatiblePreparedExecution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prepared = value as Partial<SesCompatiblePreparedExecution>;
  if (
    typeof prepared.executableCode !== 'string' ||
    !prepared.materializers ||
    typeof prepared.materializers !== 'object' ||
    Array.isArray(prepared.materializers) ||
    !Array.isArray(prepared.inputArguments)
  ) {
    return null;
  }
  if (
    prepared.instrumentedCode !== undefined &&
    prepared.instrumentedCode !== null &&
    typeof prepared.instrumentedCode !== 'string'
  ) return null;
  if (
    prepared.traceLineBounds !== undefined &&
    (
      !prepared.traceLineBounds ||
      !Number.isSafeInteger(prepared.traceLineBounds.startLine) ||
      !Number.isSafeInteger(prepared.traceLineBounds.endLine)
    )
  ) return null;
  for (let index = 0; index < prepared.inputArguments.length; index += 1) {
    const argument = prepared.inputArguments[index];
    if (
      !(index in prepared.inputArguments) ||
      !argument ||
      typeof argument !== 'object' ||
      typeof argument.key !== 'string' ||
      (argument.rest !== undefined && typeof argument.rest !== 'boolean')
    ) {
      return null;
    }
  }
  return prepared as SesCompatiblePreparedExecution;
}

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
  private standbyExecutionWorker: JavaScriptWorkerConnection | null = null;
  private standbyExecutionPromise: Promise<void> | null = null;
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromises = new Map<JavaScriptWorkerLanguage, Promise<WarmupResult>>();
  private executionTail: Promise<void> = Promise.resolve();
  private readonly preparedPrograms = new Set<RuntimePreparedProgram>();
  private readonly leasedExecutionWorkers =
    new Set<JavaScriptWorkerConnection>();
  private generation = 1;
  private terminated = false;
  private readonly debug: boolean;
  private sesAlgorithmPool: SesAlgorithmWorkerPool | null;
  private sesAlgorithmModule: SesAlgorithmWorkerModule | null = null;
  private sesAlgorithmDisabled = false;

  private disableSesAlgorithmPool(): void {
    this.sesAlgorithmDisabled = true;
    this.sesAlgorithmPool?.terminate();
    this.sesAlgorithmPool = null;
  }

  private async ensureSesAlgorithmPool(): Promise<SesAlgorithmWorkerPool | null> {
    if (this.sesAlgorithmDisabled ||
        this.options.algorithmExecution !== 'ses-compartment-pool') return null;
    if (this.sesAlgorithmPool) return this.sesAlgorithmPool;
    const module = await import('./ses-algorithm-worker-client');
    if (this.sesAlgorithmDisabled) return null;
    this.sesAlgorithmModule = module;
    this.sesAlgorithmPool = new module.SesAlgorithmWorkerPool({
      workerUrl: this.options.algorithmWorkerUrl!,
      ...(this.options.workerFactory ? { workerFactory: this.options.workerFactory } : {}),
      ...(this.options.algorithmJavascriptLibrariesUrl
        ? { javascriptLibrariesUrl: this.options.algorithmJavascriptLibrariesUrl }
        : {}),
      ...(this.options.algorithmJavascriptLibrariesIntegrity
        ? { javascriptLibrariesIntegrity: this.options.algorithmJavascriptLibrariesIntegrity }
        : {}),
    });
    return this.sesAlgorithmPool;
  }

  constructor(private readonly options: JavaScriptWorkerClientOptions) {
    this.debug = options.debug ?? isDevEnvironment();
    if (options.algorithmExecution === 'ses-compartment-pool') {
      if (!options.algorithmWorkerUrl) {
        throw new TypeError(
          'SES JavaScript algorithm execution requires algorithmWorkerUrl.'
        );
      }
    }
    this.sesAlgorithmPool = null;
  }

  isSupported(): boolean {
    return this.options.workerFactory !== undefined || typeof Worker !== 'undefined';
  }

  private assertActive(expectedGeneration: number = this.generation): void {
    if (this.terminated) {
      throw new Error('JavaScript worker client has been terminated.');
    }
    if (expectedGeneration !== this.generation) {
      throw new Error('JavaScript worker client generation was reset.');
    }
  }

  private getCoordinator(
    expectedGeneration: number = this.generation
  ): JavaScriptWorkerConnection {
    this.assertActive(expectedGeneration);
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

  private ensureStandbyExecutionWorker(
    expectedGeneration: number = this.generation
  ): Promise<void> {
    this.assertActive(expectedGeneration);
    if (
      this.standbyExecutionWorker &&
      !this.standbyExecutionWorker.isDisposed &&
      this.standbyExecutionPromise
    ) {
      return this.standbyExecutionPromise;
    }

    const worker = this.createExecutionWorker();
    this.standbyExecutionWorker = worker;
    const prewarmPromise = worker
      .prewarm(this.executionRuntimeAssetsPayload())
      .then(() => this.assertActive(expectedGeneration))
      .catch((error) => {
        if (this.standbyExecutionWorker === worker) {
          worker.terminate(
            error instanceof Error ? error : new Error(String(error))
          );
          this.standbyExecutionWorker = null;
          this.standbyExecutionPromise = null;
        }
        throw error;
      });
    this.standbyExecutionPromise = prewarmPromise;
    return prewarmPromise;
  }

  private async takeStandbyExecutionWorker(
    expectedGeneration: number = this.generation
  ): Promise<JavaScriptWorkerConnection> {
    await this.ensureStandbyExecutionWorker(expectedGeneration);
    this.assertActive(expectedGeneration);
    const worker = this.standbyExecutionWorker;
    if (!worker || worker.isDisposed) {
      throw new Error('JavaScript standby execution worker was terminated before use');
    }
    this.standbyExecutionWorker = null;
    this.standbyExecutionPromise = null;
    return worker;
  }

  private terminateGeneration(
    reason: Error = new WorkerTerminatedError()
  ): void {
    this.terminateStandbyExecution(reason);
    this.coordinator?.terminate(reason);
    this.coordinator = null;
    for (const worker of this.leasedExecutionWorkers) {
      worker.terminate(reason);
    }
    this.leasedExecutionWorkers.clear();
    this.initPromise = null;
    this.warmupPromises.clear();
  }

  private disposePreparedPrograms(): void {
    const programs = [...this.preparedPrograms];
    this.preparedPrograms.clear();
    for (const program of programs) {
      void program.dispose().catch(() => undefined);
    }
  }

  /**
   * One dispatched command as an Effect: trusted preparation on the
   * coordinator when required, then the operation on the executor. Message
   * deadlines are null throughout — the enclosing execution deadline is the
   * only clock, and interruption reaches the preparation step too.
   */
  private dispatchExecutionEffect<T>(
    worker: JavaScriptWorkerConnection,
    operation: 'execute-code' | 'execute-with-tracing',
    payload: Record<string, unknown>,
    language: JavaScriptWorkerLanguage,
    expectedGeneration: number
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
            await this.init(expectedGeneration);
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        const prepared = yield* this.getCoordinator(expectedGeneration).sendMessageEffect<{ preparedExecution: unknown }>(
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

  /**
   * Dispatch a previously prepared immutable artifact to a disposable
   * executor. Trusted compiler preparation must never re-enter this path.
   */
  private dispatchPreparedExecutionEffect<T>(
    worker: JavaScriptWorkerConnection,
    operation: 'execute-code' | 'execute-with-tracing',
    payload: Record<string, unknown>
  ): Effect.Effect<T, Error> {
    return Effect.gen(this, function* () {
      yield* Effect.tryPromise({
        try: () =>
          this.options.runtimeAssetPreflight?.() ?? Promise.resolve(),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });

      return yield* worker.sendMessageEffect<T>(
        operation,
        this.options.javascriptLibrariesUrl
          ? {
              ...payload,
              runtimeAssets: {
                javascriptLibrariesUrl: this.options.javascriptLibrariesUrl,
              },
            }
          : payload,
        null
      );
    });
  }

  private async runIsolatedExecution<T>(
    executor: (worker: JavaScriptWorkerConnection) => Promise<T>,
    expectedGeneration: number
  ): Promise<T> {
    this.assertActive(expectedGeneration);
    const previous = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    let worker: JavaScriptWorkerConnection | null = null;
    try {
      this.assertActive(expectedGeneration);
      worker = await this.takeStandbyExecutionWorker(expectedGeneration);
      this.leasedExecutionWorkers.add(worker);
      // Keep one clean executor ready while the current command runs. The
      // standby never receives user code, so every command still gets a fresh
      // authority boundary without paying worker bootstrap on its critical path.
      if (this.options.replenishStandbyAfterUse ?? true) {
        void this.ensureStandbyExecutionWorker(expectedGeneration).catch(
          () => undefined
        );
      }
      return await executor(worker);
    } finally {
      if (worker) this.leasedExecutionWorkers.delete(worker);
      worker?.terminate();
      release();
    }
  }

  /**
   * Prewarm bounded clean capacity for a prepared batch, then run each wave's
   * learner cases concurrently. Every case owns one never-before-used Worker
   * and that Worker is retired immediately afterward; waves remain bounded to
   * cap transient renderer CPU and memory.
   */
  private async runIsolatedBatch<T>(
    caseCount: number,
    executor: (
      worker: JavaScriptWorkerConnection,
      index: number
    ) => Promise<T>,
    expectedGeneration: number
  ): Promise<T[]> {
    this.assertActive(expectedGeneration);
    const previous = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);

    const results = new Array<T>(caseCount);
    try {
      this.assertActive(expectedGeneration);
      const initialStandby =
        caseCount > 0
          ? await this.takeStandbyExecutionWorker(expectedGeneration)
          : null;
      if (initialStandby) {
        this.leasedExecutionWorkers.add(initialStandby);
      }
      if (this.options.replenishStandbyAfterUse ?? true) {
        void this.ensureStandbyExecutionWorker(expectedGeneration).catch(
          () => undefined
        );
      }
      for (
        let offset = 0;
        offset < caseCount;
        offset += BATCH_PREWARM_LIMIT
      ) {
        const waveSize = Math.min(
          BATCH_PREWARM_LIMIT,
          caseCount - offset
        );
        const workers = Array.from(
          { length: waveSize },
          (_, index) => {
            if (offset === 0 && index === 0 && initialStandby) {
              return initialStandby;
            }
            const worker = this.createExecutionWorker();
            this.leasedExecutionWorkers.add(worker);
            return worker;
          }
        );
        const cleanupWorkers = new Set(workers);
        try {
          await Promise.all(
            workers.map((worker, index) =>
              offset === 0 && index === 0 && initialStandby
                ? Promise.resolve()
                : worker.prewarm(this.executionRuntimeAssetsPayload())
            )
          );
          this.assertActive(expectedGeneration);
          // Every worker in this wave has its own disposable realm and has
          // already completed prewarm. Run the cases concurrently so the
          // execution phase overlaps the per-worker message/VM startup that
          // otherwise dominates the trace-all drain. Results are written by
          // index, preserving the caller's case ordering; each worker is
          // still retired as soon as its one case settles.
          await Promise.all(
            workers.map(async (worker, index) => {
              try {
                results[offset + index] = await executor(
                  worker,
                  offset + index
                );
              } finally {
                this.leasedExecutionWorkers.delete(worker);
                worker.terminate();
                cleanupWorkers.delete(worker);
              }
            })
          );
        } finally {
          for (const worker of cleanupWorkers) {
            this.leasedExecutionWorkers.delete(worker);
            worker.terminate();
          }
        }
      }
      return results;
    } finally {
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

  private async runBatchWithDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    let deadlineExpired = false;
    const abortFromCaller = (): void => {
      if (!controller.signal.aborted) controller.abort();
    };
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      deadlineExpired = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await operation(controller.signal);
    } catch (error) {
      if (deadlineExpired) {
        throw new ExecutionTimeoutError({
          timeoutMs,
          runtimeLabel: 'JavaScript batch',
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async init(expectedGeneration: number = this.generation): Promise<InitResult> {
    this.assertActive(expectedGeneration);
    const generation = expectedGeneration;
    if (this.coordinator?.isDisposed) {
      this.coordinator = null;
      this.initPromise = null;
      this.warmupPromises.clear();
    }
    if (this.initPromise) return this.initPromise;

    const promise = (async () => {
      const useSesAlgorithm =
        this.options.algorithmExecution === 'ses-compartment-pool' &&
        !this.sesAlgorithmDisabled;
      const executionReadyPromise = useSesAlgorithm
        ? (async () => {
            await this.options.algorithmWorkerPreflight?.();
            const pool = await this.ensureSesAlgorithmPool();
            if (!pool) throw new Error('SES algorithm pool was disabled during initialization.');
            await pool.init();
          })()
        : this.ensureStandbyExecutionWorker(generation);
      try {
        if (!useSesAlgorithm) {
          await this.options.runtimeAssetPreflight?.();
        }
        this.assertActive(generation);
        const result = await this.getCoordinator(generation).sendMessage<InitResult>(
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
        try {
          await executionReadyPromise;
        } catch (error) {
          if (!useSesAlgorithm) throw error;
          this.disableSesAlgorithmPool();
          await this.options.runtimeAssetPreflight?.();
          await this.ensureStandbyExecutionWorker(generation);
        }
        this.assertActive(generation);
        return result;
      } catch (error) {
        await executionReadyPromise.catch(() => undefined);
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
    this.assertActive();
    const generation = this.generation;
    const existing = this.warmupPromises.get(language);
    if (existing) return existing;

    const warmupPromise = (async () => {
      if (language === 'typescript') await this.options.typescriptCompilerPreflight?.();
      await this.init(generation);
      this.assertActive(generation);
      return this.getCoordinator(generation).sendMessage<WarmupResult>(
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

  /**
   * Prepare immutable source artifacts once on the trusted coordinator, then
   * expose only isolated case execution and disposal.
   */
  async prepareProgram(
    call: RuntimeProgramPreparationCall,
    language: JavaScriptWorkerLanguage = 'javascript'
  ): Promise<RuntimeProgramPreparationResult> {
    this.assertActive();
    const generation = this.generation;
    const startedAt = performanceNow();
    const preparation = Object.freeze({
      mode: call.mode,
      code: call.code,
      functionName: call.functionName,
      executionStyle: call.executionStyle ?? 'function',
      ...(call.traceOptions
        ? { traceOptions: Object.freeze({ ...call.traceOptions }) }
        : {}),
    });

    try {
      if (call.signal?.aborted) {
        const error = new Error('Prepared JavaScript execution aborted.');
        error.name = 'AbortError';
        throw error;
      }
      if (language === 'typescript' || call.mode === 'trace') {
        await this.options.typescriptCompilerPreflight?.();
      }
      await this.init(generation);
      this.assertActive(generation);
      if (call.signal?.aborted) {
        const error = new Error('Prepared JavaScript execution aborted.');
        error.name = 'AbortError';
        throw error;
      }

      const operation =
        call.mode === 'trace' ? 'execute-with-tracing' : 'execute-code';
      const coordinator = this.getCoordinator(generation);
      const reply = await coordinator.core.runClientEffect(
        coordinator.sendMessageEffect<PreparedExecutionReply>(
          'prepare-execution',
          {
            operation,
            request: {
              code: preparation.code,
              functionName: preparation.functionName,
              executionStyle: preparation.executionStyle,
              language,
              ...(preparation.traceOptions
                ? { options: preparation.traceOptions }
                : {}),
            },
          },
          null
        ),
        call.signal
      );
      if (
        !reply ||
        typeof reply !== 'object' ||
        !('preparedExecution' in reply)
      ) {
        throw new Error(
          'JavaScript coordinator returned an invalid prepared artifact.'
        );
      }

      let preparedExecution: unknown | undefined = reply.preparedExecution;
      const requirePreparedExecution = (): unknown => {
        if (preparedExecution === undefined) {
          const error = new Error(
            'Prepared JavaScript program has been disposed.'
          );
          error.name = 'AbortError';
          throw error;
        }
        return preparedExecution;
      };
      let sesProgram: SesAlgorithmPreparedProgram | undefined;
      const sesModule = this.sesAlgorithmModule;
      if (
        this.sesAlgorithmPool &&
        sesModule &&
        preparation.functionName
      ) {
        const prepared = sesCompatiblePreparedExecution(preparedExecution);
        if (
          prepared &&
          (preparation.mode === 'code' ||
            (typeof prepared.instrumentedCode === 'string' &&
              prepared.traceLineBounds !== undefined)) &&
          sesModule.isSesAlgorithmSourceEligible(preparation.code) &&
          sesModule.isSesAlgorithmSourceEligible(prepared.executableCode)
        ) {
          const requiredModules = sesModule.detectSesAlgorithmRequiredModules(
            prepared.executableCode
          );
          if (requiredModules) {
            const source: SesAlgorithmPreparedSource = {
              mode: preparation.mode,
              language,
              code: prepared.executableCode,
              ...(preparation.mode === 'trace'
                ? {
                    instrumentedCode: prepared.instrumentedCode!,
                    traceLineBounds: prepared.traceLineBounds!,
                    ...(preparation.traceOptions
                      ? { traceOptions: preparation.traceOptions }
                      : {}),
                  }
                : {}),
              functionName: preparation.functionName,
              executionStyle: preparation.executionStyle,
              requiredModules,
              inputArguments: prepared.inputArguments,
              materializers: prepared.materializers,
            };
            try {
              if (source.requiredModules.length > 0) {
                await this.options.runtimeAssetPreflight?.();
              }
              sesProgram = await this.sesAlgorithmPool.prepare(source, call.signal);
            } catch (error) {
              if (error instanceof Error &&
                  (error.name === 'AbortError' || call.signal?.aborted)) {
                throw error;
              }
              if (error instanceof sesModule.SesAlgorithmWorkerReportedError &&
                  error.stage === 'compile') {
                throw error;
              }
              this.disableSesAlgorithmPool();
            }
          }
        }
      }
      if (!sesProgram) {
        await this.options.runtimeAssetPreflight?.();
      }
      const programSesPool = sesProgram ? this.sesAlgorithmPool : null;
      let programSesEligible = Boolean(sesProgram && programSesPool);

      const executeSesBatchOrFallback = async (
        batchCall: RuntimePreparedCodeBatchCall
      ): Promise<readonly CodeExecutionResult[]> => {
        if (!sesProgram || !programSesPool || !programSesEligible ||
            this.sesAlgorithmPool !== programSesPool) {
          programSesEligible = false;
          return this.executePreparedCodeBatch(
            language,
            preparation,
            requirePreparedExecution(),
            batchCall,
            generation
          );
        }
        if (!batchCall.inputBatch.every(isSesAlgorithmInputEligible)) {
          return this.executePreparedCodeBatch(
            language,
            preparation,
            requirePreparedExecution(),
            batchCall,
            generation
          );
        }
        try {
          return await programSesPool.executeBatch(
            sesProgram,
            batchCall.inputBatch,
            batchCall.limits,
            batchCall.signal
          );
        } catch (error) {
          if (error instanceof Error &&
              (error.name === 'AbortError' || batchCall.signal?.aborted)) {
            throw error;
          }
          if ((sesModule &&
                error instanceof sesModule.SesAlgorithmCompatibilityRequiredError) ||
              (error instanceof Error &&
                error.name === 'SesAlgorithmCompatibilityRequiredError')) {
            programSesEligible = false;
            await this.options.runtimeAssetPreflight?.();
            await this.ensureStandbyExecutionWorker(generation);
            return this.executePreparedCodeBatch(
              language,
              preparation,
              requirePreparedExecution(),
              batchCall,
              generation
            );
          }
          // Infrastructure failure invalidates the retained pool. Replay the
          // entire batch on the prepared disposable path so one evaluation
          // still has one correctness result per case and no partial SES work
          // is ever surfaced.
          programSesEligible = false;
          this.disableSesAlgorithmPool();
          await this.options.runtimeAssetPreflight?.();
          await this.ensureStandbyExecutionWorker(generation);
          return this.executePreparedCodeBatch(
            language,
            preparation,
            requirePreparedExecution(),
            batchCall,
            generation
          );
        }
      };

      const executeSesTraceBatchOrFallback = async (
        batchCall: RuntimePreparedTraceBatchCall
      ): Promise<readonly ExecutionResult[]> => {
        if (!sesProgram || !programSesPool || !programSesEligible ||
            this.sesAlgorithmPool !== programSesPool) {
          programSesEligible = false;
          return this.executePreparedTraceBatchInternal(
            language,
            preparation,
            requirePreparedExecution(),
            batchCall,
            generation
          );
        }
        if (!batchCall.inputBatch.every(isSesAlgorithmInputEligible)) {
          return this.executePreparedTraceBatchInternal(
            language,
            preparation,
            requirePreparedExecution(),
            batchCall,
            generation
          );
        }
        try {
          return await programSesPool.executeTraceBatch(
            sesProgram,
            batchCall.inputBatch,
            batchCall.traceEnabledBatch,
            batchCall.limits,
            batchCall.signal
          );
        } catch (error) {
          if (error instanceof Error &&
              (error.name === 'AbortError' || batchCall.signal?.aborted)) {
            throw error;
          }
          programSesEligible = false;
          if (!(
            (sesModule &&
              error instanceof sesModule.SesAlgorithmCompatibilityRequiredError) ||
            (error instanceof Error &&
              error.name === 'SesAlgorithmCompatibilityRequiredError')
          )) {
            this.disableSesAlgorithmPool();
          }
          await this.options.runtimeAssetPreflight?.();
          await this.ensureStandbyExecutionWorker(generation);
          return this.executePreparedTraceBatchInternal(
            language,
            preparation,
            requirePreparedExecution(),
            batchCall,
            generation
          );
        }
      };

      let program: RuntimePreparedProgram;
      program = createJavaScriptPreparedProgram({
        mode: preparation.mode,
        profile:
          sesProgram && programSesPool
            ? 'fast'
            : 'compatibility',
        executeCode:
          preparation.mode === 'code'
            ? sesProgram && programSesPool
              ? async (caseCall) => {
                  const results = await executeSesBatchOrFallback({
                    inputBatch: [caseCall.inputs],
                    signal: caseCall.signal,
                    limits: caseCall.limits,
                  });
                  const result = results[0];
                  if (!result) {
                    throw new Error('SES code execution returned no result.');
                  }
                  return result;
                }
              : (caseCall) => this.executePreparedCode(
                  language,
                  preparation,
                  requirePreparedExecution(),
                  caseCall,
                  generation
                )
            : undefined,
        executeCodeBatch:
          preparation.mode === 'code'
            ? sesProgram && programSesPool
              ? executeSesBatchOrFallback
              : (batchCall) =>
                  this.executePreparedCodeBatch(
                    language,
                    preparation,
                    requirePreparedExecution(),
                    batchCall,
                    generation
                  )
            : undefined,
        executeTrace:
          preparation.mode === 'trace'
            ? sesProgram && programSesPool
              ? async (caseCall) => {
                  const results = await executeSesTraceBatchOrFallback({
                    inputBatch: [caseCall.inputs],
                    traceEnabledBatch: [caseCall.recordTrace ?? true],
                    signal: caseCall.signal,
                    limits: caseCall.limits,
                  });
                  const result = results[0];
                  if (!result) {
                    throw new Error('SES trace execution returned no result.');
                  }
                  return result;
                }
              : (caseCall) =>
                  this.executePreparedTrace(
                    language,
                    preparation,
                    requirePreparedExecution(),
                    caseCall,
                    generation,
                    caseCall.recordTrace ?? true
                  )
            : undefined,
        executeTraceBatch:
          preparation.mode === 'trace'
            ? sesProgram && programSesPool
              ? executeSesTraceBatchOrFallback
              : (batchCall) =>
                  this.executePreparedTraceBatchInternal(
                    language,
                    preparation,
                    requirePreparedExecution(),
                    batchCall,
                    generation
                  )
            : undefined,
        dispose: async () => {
          preparedExecution = undefined;
          this.preparedPrograms.delete(program);
          if (sesProgram && programSesPool && this.sesAlgorithmPool === programSesPool) {
            try {
              await programSesPool.disposeProgram(sesProgram);
            } catch {
              // A lane disposal failure already retires that lane. Cleanup is
              // best-effort and must not replace a completed correctness batch.
            }
            sesProgram = undefined;
          }
        },
      });
      this.assertActive(generation);
      this.preparedPrograms.add(program);
      const totalMs = performanceNow() - startedAt;
      return {
        kind: 'prepared',
        program,
        consoleOutput: [],
        timings: {
          ...(reply.timings ?? {}),
          totalMs,
        },
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || call.signal?.aborted)
      ) {
        throw error;
      }
      const sesReportedError = this.sesAlgorithmModule?.SesAlgorithmWorkerReportedError;
      if (sesReportedError && error instanceof sesReportedError &&
          error.stage === 'compile') {
        const errorLine = preparationErrorLine(error);
        return {
          kind: 'failed',
          error: error.message,
          ...(errorLine !== undefined ? { errorLine } : {}),
          diagnosticStage: 'compile',
          consoleOutput: [],
          timings: { totalMs: performanceNow() - startedAt },
        };
      }
      if (!(error instanceof WorkerReportedError)) {
        throw error;
      }
      const errorLine = preparationErrorLine(error);
      return {
        kind: 'failed',
        error: error.message,
        ...(errorLine !== undefined ? { errorLine } : {}),
        diagnosticStage: 'compile',
        consoleOutput: [],
        timings: { totalMs: performanceNow() - startedAt },
      };
    }
  }

  private async executePreparedCode(
    language: JavaScriptWorkerLanguage,
    preparation: {
      readonly code: string;
      readonly functionName: string | null;
      readonly executionStyle: JavaScriptExecutionStyle;
    },
    preparedExecution: unknown,
    call: RuntimePreparedCodeCall,
    expectedGeneration: number
  ): Promise<CodeExecutionResult> {
    return this.runIsolatedExecution(
      (worker) =>
        this.executePreparedCodeOnWorker(
          worker,
          language,
          preparation,
          preparedExecution,
          call
        ),
      expectedGeneration
    );
  }

  private async executePreparedCodeOnWorker(
    worker: JavaScriptWorkerConnection,
    language: JavaScriptWorkerLanguage,
    preparation: {
      readonly code: string;
      readonly functionName: string | null;
      readonly executionStyle: JavaScriptExecutionStyle;
    },
    preparedExecution: unknown,
    call: RuntimePreparedCodeCall
  ): Promise<CodeExecutionResult> {
    const wallClockMs = call.limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS;
    try {
      const result = await this.runExecution(
        worker,
        this.dispatchPreparedExecutionEffect<RawExecutionPayload>(
          worker,
          'execute-code',
          {
            code: preparation.code,
            functionName: preparation.functionName ?? '',
            inputs: call.inputs,
            executionStyle: preparation.executionStyle,
            language,
            preparedExecution,
          }
        ),
        wallClockMs,
        call.signal
      );
      return liftCodeOutcome(result, 'JavaScript execution failed');
    } catch (error) {
      if (
        call.limits?.wallClockMs !== undefined &&
        isExecutionTimeoutError(error)
      ) {
        return {
          kind: 'limit',
          reason: 'client-timeout',
          error: error.message,
          consoleOutput: [],
          timings: {
            totalMs: call.limits.wallClockMs,
            runMs: call.limits.wallClockMs,
            artifactCacheHit: true,
          },
        };
      }
      throw error;
    }
  }

  private async executePreparedTrace(
    language: JavaScriptWorkerLanguage,
    preparation: {
      readonly code: string;
      readonly functionName: string | null;
      readonly executionStyle: JavaScriptExecutionStyle;
      readonly traceOptions?: RuntimeTraceCall['traceOptions'];
    },
    preparedExecution: unknown,
    call: RuntimePreparedTraceCall,
    expectedGeneration: number,
    tracingEnabled: boolean = true
  ): Promise<ExecutionResult> {
    return this.runIsolatedExecution(
      (worker) =>
        this.executePreparedTraceOnWorker(
          worker,
          language,
          preparation,
          preparedExecution,
          call,
          tracingEnabled
        ),
      expectedGeneration
    );
  }

  private async executePreparedTraceOnWorker(
    worker: JavaScriptWorkerConnection,
    language: JavaScriptWorkerLanguage,
    preparation: {
      readonly code: string;
      readonly functionName: string | null;
      readonly executionStyle: JavaScriptExecutionStyle;
      readonly traceOptions?: RuntimeTraceCall['traceOptions'];
    },
    preparedExecution: unknown,
    call: RuntimePreparedTraceCall,
    tracingEnabled: boolean = true
  ): Promise<ExecutionResult> {
    const wallClockMs = call.limits?.wallClockMs ?? TRACING_TIMEOUT_MS;
    try {
      const result = await this.runExecution(
        worker,
        this.dispatchPreparedExecutionEffect<JavaScriptRawTraceResult>(
          worker,
          'execute-with-tracing',
          {
            code: preparation.code,
            functionName: preparation.functionName,
            inputs: call.inputs,
            options: preparation.traceOptions,
            executionStyle: preparation.executionStyle,
            language,
            preparedExecution,
            tracingEnabled,
            traceEventTransport: traceEventTransferRequest(),
          }
        ),
        wallClockMs,
        call.signal
      );
      return liftTraceOutcome(
        result,
        result.trace ??
          createEmptyRuntimeTrace(language, { runId: `${language}:run` }),
        'JavaScript tracing failed'
      );
    } catch (error) {
      if (
        call.limits?.wallClockMs !== undefined &&
        isExecutionTimeoutError(error)
      ) {
        return {
          kind: 'limit',
          reason: 'client-timeout',
          error: error.message,
          trace: createEmptyRuntimeTrace(language),
          executionTimeMs: call.limits.wallClockMs,
          consoleOutput: [],
          timings: {
            totalMs: call.limits.wallClockMs,
            runMs: call.limits.wallClockMs,
            artifactCacheHit: true,
          },
        };
      }
      throw error;
    }
  }

  private executePreparedCodeBatch(
    language: JavaScriptWorkerLanguage,
    preparation: {
      readonly code: string;
      readonly functionName: string | null;
      readonly executionStyle: JavaScriptExecutionStyle;
    },
    preparedExecution: unknown,
    call: RuntimePreparedCodeBatchCall,
    expectedGeneration: number
  ): Promise<readonly CodeExecutionResult[]> {
    return this.runIsolatedBatch(
      call.inputBatch.length,
      (worker, index) =>
        this.executePreparedCodeOnWorker(
          worker,
          language,
          preparation,
          preparedExecution,
          {
            inputs: call.inputBatch[index]!,
            signal: call.signal,
            limits: call.limits,
          }
        ),
      expectedGeneration
    );
  }

  private executePreparedTraceBatchInternal(
    language: JavaScriptWorkerLanguage,
    preparation: {
      readonly code: string;
      readonly functionName: string | null;
      readonly executionStyle: JavaScriptExecutionStyle;
      readonly traceOptions?: RuntimeTraceCall['traceOptions'];
    },
    preparedExecution: unknown,
    call: RuntimePreparedTraceBatchCall,
    expectedGeneration: number
  ): Promise<readonly ExecutionResult[]> {
    if (
      (
        call.traceEnabledBatch !== undefined &&
        (
          call.traceEnabledBatch.length !== call.inputBatch.length ||
          call.traceEnabledBatch.some(
            (enabled) => typeof enabled !== 'boolean'
          )
        )
      )
    ) {
      return Promise.reject(new TypeError(
        'JavaScript trace selection must contain one boolean per batch case.'
      ));
    }
    return this.runIsolatedBatch(
      call.inputBatch.length,
      (worker, index) =>
        this.executePreparedTraceOnWorker(
          worker,
          language,
          preparation,
          preparedExecution,
          {
            inputs: call.inputBatch[index]!,
            signal: call.signal,
            limits: call.limits,
          },
          call.traceEnabledBatch?.[index] ?? true
        ),
      expectedGeneration
    );
  }

  async executeWithTracing(call: RuntimeTraceCall & { language?: JavaScriptWorkerLanguage }): Promise<ExecutionResult> {
    const expectedGeneration = this.generation;
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
          language,
          expectedGeneration
        ),
        TRACING_TIMEOUT_MS,
        signal
      ),
      expectedGeneration
    );
    return liftTraceOutcome(
      result,
      result.trace ?? createEmptyRuntimeTrace(language, { runId: `${language}:run` }),
      'JavaScript tracing failed'
    );
  }

  async executeCode(call: RuntimeCodeCall & { language?: JavaScriptWorkerLanguage }): Promise<CodeExecutionResult> {
    const expectedGeneration = this.generation;
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
          language,
          expectedGeneration
        ),
        wallClockMs,
        signal
      ),
      expectedGeneration
    );
    return liftCodeOutcome(result, 'JavaScript execution failed');
  }

  async executeCodeBatch(call: JavaScriptWorkerBatchCall): Promise<CodeExecutionBatchResult> {
    const startedAt = performanceNow();
    const {
      code,
      functionName,
      inputBatch,
      executionStyle = 'function',
      language = 'javascript',
      signal,
      limits,
      batchWallClockMs = EXECUTION_TIMEOUT_MS,
    } = call;
    const preparation = await this.prepareProgram(
      {
        mode: 'code',
        code,
        functionName,
        executionStyle,
        signal,
      },
      language
    );
    if (preparation.kind !== 'prepared') {
      const results = inputBatch.map<CodeExecutionResult>(() =>
        preparation.kind === 'failed'
          ? {
              kind: 'failed',
              error: preparation.error,
              ...(preparation.errorLine !== undefined
                ? { errorLine: preparation.errorLine }
                : {}),
              diagnosticStage: preparation.diagnosticStage ?? 'compile',
              ...(preparation.diagnostic !== undefined
                ? { diagnostic: preparation.diagnostic }
                : {}),
              consoleOutput: [...preparation.consoleOutput],
              ...(preparation.timings ? { timings: preparation.timings } : {}),
            }
          : {
              kind: 'limit',
              reason: preparation.reason,
              error: preparation.error,
              ...(preparation.diagnostic !== undefined
                ? { diagnostic: preparation.diagnostic }
                : {}),
              consoleOutput: [...preparation.consoleOutput],
              ...(preparation.timings ? { timings: preparation.timings } : {}),
            }
      );
      return {
        results,
        error: preparation.error,
        consoleOutput: results.flatMap((result) => result.consoleOutput),
        executionTimeMs: performanceNow() - startedAt,
        timings: {
          ...(preparation.timings ?? {}),
          totalMs: performanceNow() - startedAt,
        },
      };
    }
    if (preparation.program.mode !== 'code') {
      await preparation.program.dispose();
      throw new Error('JavaScript code batch prepared a tracing program.');
    }
    try {
      const executeBatch = preparation.program.executeBatchIsolated;
      if (!executeBatch) {
        throw new Error(
          'Prepared JavaScript code program did not expose isolated batching.'
        );
      }
      const results = [
        ...(await this.runBatchWithDeadline(
          (batchSignal) =>
            executeBatch({ inputBatch, signal: batchSignal, limits }),
          batchWallClockMs,
          signal
        )),
      ];
      const totalMs = performanceNow() - startedAt;
      return {
        results,
        consoleOutput: results.flatMap((result) => result.consoleOutput),
        executionTimeMs: totalMs,
        timings: {
          totalMs,
          runMs: results.reduce(
            (total, result) => total + (result.timings?.runMs ?? 0),
            0
          ),
          artifactCacheHit: true,
        },
      };
    } finally {
      await preparation.program.dispose();
    }
  }

  reset(): void {
    if (this.terminated) return;
    this.generation += 1;
    this.disposePreparedPrograms();
    this.terminateGeneration(
      new WorkerTerminatedError('JavaScript worker generation was reset.')
    );
    this.sesAlgorithmPool?.reset();
    this.executionTail = Promise.resolve();
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.generation += 1;
    this.disposePreparedPrograms();
    this.terminateGeneration();
    this.sesAlgorithmPool?.terminate();
    this.executionTail = Promise.resolve();
  }
}
