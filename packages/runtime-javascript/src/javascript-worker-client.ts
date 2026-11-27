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
  Drawing,
  ExecutionResult,
  RuntimeBatchCall,
  RuntimeCodeCall,
  RuntimeExecutionTimings,
  RuntimeObservationCall,
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
  isTraceUnavailableError,
  liftCodeOutcome,
  liftTraceOutcome,
  RuntimeProviderError,
  TRACE_UNAVAILABLE_CODE,
  traceUnavailableOutcome,
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
import type { JudgeObservationLease } from '../../runtime-browser/src/browser-runtime-host-internal';
import {
  detachPreparedRuntimeRequest,
  RuntimeProgramConcurrencyGate,
} from '../../runtime-browser/src/program-concurrency-gate';
import type {
  JudgedOutputPolicy,
  JudgedPreparationCall,
} from '../../runtime-contracts/src/judged-output-policy';
import { createJavaScriptPreparedProgram } from './javascript-prepared-program';
import type {
  SesAlgorithmWorkerPool,
  SesAlgorithmPreparedProgram,
  SesAlgorithmPreparedSource,
} from './ses-algorithm-worker-client';

type SesAlgorithmWorkerModule =
  typeof import('./ses-algorithm-worker-client');

interface OrdinaryArtifact {
  readonly generation: number;
  readonly language: JavaScriptWorkerLanguage;
  readonly code: string;
  readonly functionName: string | null;
  readonly executionStyle: JavaScriptExecutionStyle;
  readonly preparedExecution: unknown;
}

type ObservationOptions = RuntimeObservationCall['traceOptions'];
type ObservationArtifact = JudgeObservationLease & { dispose(): void };
type ObservationPreparation = (options: ObservationOptions, signal?: AbortSignal) => Promise<ObservationArtifact>;

interface ObservationPreparationSlot {
  readonly ready: Promise<ObservationPreparation>;
  readonly bind: (prepare: ObservationPreparation) => void;
}

const OBSERVATION_REFUSALS = new Set([
  'recorder-unavailable', 'unsupported-program', 'unsupported-option',
  'observer-prepare', 'observer-encode', 'observer-runtime', 'observer-protocol',
  'observer-timeout', 'uncertified-drawing',
]);
const OBSERVATION_CUTS = new Set([
  'step-budget', 'line-budget', 'single-line-budget', 'stored-event-budget',
  'byte-budget', 'observer-deadline', 'depth-budget',
]);

function certifyObservation(
  reply: unknown,
  attemptToken: string,
  language: JavaScriptWorkerLanguage,
  requireDisabledRecorder: boolean,
): Drawing {
  const protocol: Drawing = { status: 'refused', reason: 'observer-protocol' };
  const envelope = reply as { attemptToken?: unknown; drawing?: unknown; recorderDisabled?: unknown } | null;
  if (envelope?.attemptToken !== attemptToken) return protocol;
  const drawing = envelope.drawing as Drawing | null;
  if (requireDisabledRecorder && (envelope.recorderDisabled !== true || drawing?.status !== 'refused' ||
    drawing.reason !== 'recorder-unavailable')) return protocol;
  if (drawing?.status === 'refused') {
    return OBSERVATION_REFUSALS.has(drawing.reason)
      ? { status: 'refused', reason: drawing.reason }
      : protocol;
  }
  if (drawing?.status !== 'drawn' && drawing?.status !== 'truncated') return protocol;
  const trace = drawing.trace;
  if (trace?.schemaVersion !== 'runtime-trace-2026-04-28' || trace.language !== language ||
      typeof trace.runId !== 'string' || !Array.isArray(trace.events) ||
      trace.traceStepCount !== trace.events.length ||
      trace.lineEventCount !== trace.events.filter((event) => event?.kind === 'line').length ||
      Array.from(trace.events).some((event) => !event || event.runId !== trace.runId ||
        typeof event.kind !== 'string')) return protocol;
  if (drawing.status === 'truncated') {
    const { reason, attemptedEvents } = drawing;
    if (!OBSERVATION_CUTS.has(reason) || !Number.isSafeInteger(attemptedEvents) ||
        attemptedEvents <= trace.events.length ||
        (trace.events.length === 0 && reason !== 'byte-budget')) return protocol;
    return { status: 'truncated', reason, trace, attemptedEvents };
  }
  return trace.events.length > 0
    ? { status: 'drawn', trace }
    : { status: 'refused', reason: 'uncertified-drawing' };
}

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

/** The learner's line for a preparation failure, as the worker reported it. */
function preparationErrorLine(error: unknown): number | undefined {
  return error instanceof WorkerReportedError ? error.errorLine : undefined;
}

/** The refusal of a case, worded as the worker words it. */

/** Traced results whose console the disposable worker found over the pool's budget. */
/** A failure the worker reports as the runtime's own stays the provider's. */
function reportedRuntimeFault(error: unknown): RuntimeProviderError | undefined {
  return error instanceof WorkerReportedError && error.code === 'runtime-provider-error'
    ? new RuntimeProviderError(error.message, { cause: error })
    : undefined;
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
  private readonly preparationQueue = new RuntimeProgramConcurrencyGate(1);
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
      onCommandMessage: (_id, type) => type === 'runtime-progress',
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

  prepareEffect<T>(
    type: 'prepare-execution' | 'prepare-observation',
    payload: unknown,
    { observerSignal, onRequestRegistered }: { observerSignal?: AbortSignal; onRequestRegistered?: () => void } = {},
  ): Effect.Effect<T, Error> {
    return this.core.sendMessageEffectWithOptions<T>(type, payload, {
      timeoutMs: null,
      onRequestRegistered,
      scheduleReply: (reply) => Effect.flatten(Effect.tryPromise({
        try: (signal) => this.preparationQueue.run(
          observerSignal ? AbortSignal.any([signal, observerSignal]) : signal,
          () => {
            signal.throwIfAborted();
            observerSignal?.throwIfAborted();
            // Hold the permit through the reply even if the caller detaches.
            return Effect.runPromiseExit(reply);
          },
          type === 'prepare-observation' ? 'background' : 'foreground',
        ),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      })),
    });
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
  /**
   * Observer derivations keyed by the ordinary preparation call. A slot lives
   * as long as its key, not as long as the ordinary program: the Judge
   * disposes that program once the first request's receipt is joined, and a
   * later continuation may still prepare the observer from the same trusted
   * reply.
   */
  private readonly observationPreparations = new WeakMap<object, ObservationPreparationSlot>();
  private readonly preparedPrograms = new Set<RuntimePreparedProgram>();
  private readonly leasedExecutionWorkers =
    new Set<JavaScriptWorkerConnection>();
  private generation = 1;
  private terminated = false;
  private readonly debug: boolean;
  private sesAlgorithmPool: SesAlgorithmWorkerPool | null;
  private sesAlgorithmModule: SesAlgorithmWorkerModule | null = null;
  private async ensureSesAlgorithmPool(): Promise<SesAlgorithmWorkerPool | null> {
    if (this.options.algorithmExecution !== 'ses-compartment-pool') return null;
    if (this.sesAlgorithmPool) return this.sesAlgorithmPool;
    const module = await import('./ses-algorithm-worker-client');
    if (this.sesAlgorithmPool) return this.sesAlgorithmPool;
    this.sesAlgorithmModule = module;
    this.sesAlgorithmPool = new module.SesAlgorithmWorkerPool({
      workerUrl: this.options.algorithmWorkerUrl!,
      debug: this.debug,
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
        const prepared = yield* this.getCoordinator(expectedGeneration).prepareEffect<{ preparedExecution: unknown }>(
          'prepare-execution',
          { operation, request: payload },
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
    operation: 'execute-code' | 'execute-with-tracing' | 'observe-execution',
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
        this.options.algorithmExecution === 'ses-compartment-pool';
      const executionReadyPromise = useSesAlgorithm
        ? (async () => {
            await this.options.algorithmWorkerPreflight?.();
            const pool = await this.ensureSesAlgorithmPool();
            if (!pool) throw new Error('SES algorithm pool is required by this profile.');
            await pool.init();
          })()
        : this.ensureStandbyExecutionWorker(generation);
      // Either worker can fail first. Observe the executor immediately while
      // the coordinator loads; awaiting the original promise below propagates it.
      void executionReadyPromise.catch(() => undefined);
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
        await executionReadyPromise;
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
    const judgedOutputPolicy = call.mode === 'code'
      ? judgedOutputPolicySnapshot((call as JudgedPreparationCall).judgedOutputPolicy)
      : undefined;
    const preparation = Object.freeze({
      mode: call.mode,
      code: call.code,
      functionName: call.functionName,
      executionStyle: call.executionStyle ?? 'function',
      ...(call.traceOptions
        ? { traceOptions: Object.freeze({ ...call.traceOptions }) }
        : {}),
      ...(judgedOutputPolicy ? { judgedOutputPolicy } : {}),
    });

    const trusted = (async (): Promise<PreparedExecutionReply> => {
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
      let posted = false;
      const reply = await coordinator.core.runClientEffect(
        coordinator.prepareEffect<PreparedExecutionReply>(
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
          { onRequestRegistered: () => { posted = true; } },
        ),
        call.signal,
        () => posted,
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

      return reply;
    })();
    if (preparation.mode === 'code') {
      this.observationSlot(call).bind(async (options, signal) => {
        const reply = await trusted;
        signal?.throwIfAborted();
        return this.prepareObservationArtifact({
          generation,
          language,
          code: preparation.code,
          functionName: preparation.functionName,
          executionStyle: preparation.executionStyle,
          preparedExecution: reply.preparedExecution,
        }, options, signal);
      });
    }

    try {
      const reply = await trusted;
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
      const sesModule = this.sesAlgorithmModule;
      const pool = this.sesAlgorithmPool;
      const prepared = sesCompatiblePreparedExecution(preparedExecution);
      const requiredModules = sesModule && pool && prepared && preparation.functionName &&
        sesModule.isSesAlgorithmSourceEligible(preparation.code) &&
        sesModule.isSesAlgorithmSourceEligible(prepared.executableCode)
        ? sesModule.detectSesAlgorithmRequiredModules(prepared.executableCode)
        : null;
      let sesProgram: SesAlgorithmPreparedProgram | undefined;
      let sesTraceProgram: SesAlgorithmPreparedProgram | undefined;
      if (pool && prepared && preparation.functionName && requiredModules) {
        if (requiredModules.length > 0) await this.options.runtimeAssetPreflight?.();
        const ordinarySource: SesAlgorithmPreparedSource = {
          mode: 'code',
          language,
          code: prepared.executableCode,
          functionName: preparation.functionName,
          executionStyle: preparation.executionStyle,
          requiredModules,
          inputArguments: prepared.inputArguments,
          materializers: prepared.materializers,
          ...(preparation.judgedOutputPolicy
            ? { judgedOutputPolicy: preparation.judgedOutputPolicy }
            : {}),
        };
        // Legacy direct trace callers still receive a traced result. The receipt
        // path prepares in code mode and observes from a separate lease.
        if (preparation.mode === 'trace' &&
            prepared.instrumentedCode && prepared.traceLineBounds &&
            sesModule?.supportsSesTraceOptions(preparation.traceOptions)) {
          try {
            sesTraceProgram = await pool.prepare({
              ...ordinarySource,
              mode: 'trace',
              instrumentedCode: prepared.instrumentedCode,
              traceLineBounds: prepared.traceLineBounds,
              traceOptions: preparation.traceOptions,
            }, call.signal);
          } catch (error) {
            if (!(error instanceof sesModule.SesAlgorithmWorkerReportedError) ||
                error.stage !== 'trace-compile') throw error;
            preparedExecution = { ...prepared, instrumentedCode: null };
          }
        }
        if (!sesTraceProgram) sesProgram = await pool.prepare(ordinarySource, call.signal);
      }
      if (!sesProgram && !sesTraceProgram) await this.options.runtimeAssetPreflight?.();

      const executeCodeBatch = async (batchCall: RuntimePreparedCodeBatchCall) => {
        const runDisposable = (inputBatch: RuntimePreparedCodeBatchCall['inputBatch']) =>
          this.executePreparedCodeBatch(
            language, preparation, requirePreparedExecution(), { ...batchCall, inputBatch }, generation
          );
        if (!pool || !sesProgram) return runDisposable(batchCall.inputBatch);
        const usesSes = batchCall.inputBatch.map(isSesAlgorithmInputEligible);
        const eligible = batchCall.inputBatch.filter((_, index) => usesSes[index]);
        const runSes = () => pool.executeBatch(sesProgram, eligible, batchCall.limits, batchCall.signal);
        if (eligible.length === usesSes.length) return runSes();
        if (eligible.length === 0) return runDisposable(batchCall.inputBatch);
        const [pooled, disposable] = await Promise.all([
          runSes(),
          runDisposable(batchCall.inputBatch.filter((_, index) => !usesSes[index])),
        ]);
        let pooledIndex = 0;
        let disposableIndex = 0;
        return usesSes.map((eligible) => eligible ? pooled[pooledIndex++]! : disposable[disposableIndex++]!);
      };

      const executeTraceBatch = async (batchCall: RuntimePreparedTraceBatchCall): Promise<readonly ExecutionResult[]> => {
        if (pool && sesTraceProgram && batchCall.inputBatch.every(isSesAlgorithmInputEligible)) {
          return pool.executeTraceBatch(
            sesTraceProgram, batchCall.inputBatch, batchCall.traceEnabledBatch, batchCall.limits, batchCall.signal
          );
        }
        if (!sesProgram || batchCall.traceEnabledBatch === undefined ||
            !batchCall.inputBatch.every(isSesAlgorithmInputEligible)) {
          return this.executePreparedTraceBatchInternal(
            language, { ...preparation, untracedCompiles: Boolean(sesProgram) },
            requirePreparedExecution(), batchCall, generation
          );
        }
        const selected = batchCall.traceEnabledBatch;
        if (selected.length !== batchCall.inputBatch.length ||
            Array.from(selected).some((enabled) => typeof enabled !== 'boolean')) {
          throw new TypeError('JavaScript trace selection must contain one boolean per batch case.');
        }
        const ordinaryInputs = batchCall.inputBatch.filter((_, index) => !selected[index]);
        const observerInputs = batchCall.inputBatch.filter((_, index) => selected[index]);
        const [ordinary, traced] = await Promise.all([
          executeCodeBatch({ ...batchCall, inputBatch: ordinaryInputs }),
          this.executePreparedTraceBatchInternal(
            language, { ...preparation, untracedCompiles: true }, requirePreparedExecution(),
            { ...batchCall, inputBatch: observerInputs, traceEnabledBatch: undefined }, generation
          ),
        ]);
        let ordinaryIndex = 0;
        let traceIndex = 0;
        return selected.map((enabled): ExecutionResult => {
          if (enabled) return traced[traceIndex++]!;
          const result = ordinary[ordinaryIndex++]!;
          return {
            ...result,
            trace: createEmptyRuntimeTrace(language),
            executionTimeMs: result.timings?.totalMs ?? 0,
          };
        });
      };

      let program: RuntimePreparedProgram;
      program = createJavaScriptPreparedProgram({
        mode: preparation.mode,
        profile: sesProgram || sesTraceProgram ? 'fast' : 'compatibility',
        executeCode: preparation.mode === 'code'
          ? async (caseCall) => {
              if (!sesProgram || !isSesAlgorithmInputEligible(caseCall.inputs)) {
                return this.executePreparedCode(
                  language, preparation, requirePreparedExecution(), caseCall, generation
                );
              }
              const results = await executeCodeBatch({ ...caseCall, inputBatch: [caseCall.inputs] });
              return results[0]!;
            }
          : undefined,
        executeCodeBatch: preparation.mode === 'code' ? executeCodeBatch : undefined,
        executeTrace: preparation.mode === 'trace'
          ? async (caseCall) => {
              if (!sesProgram && !sesTraceProgram) {
                return this.executePreparedTrace(
                  language, preparation, requirePreparedExecution(), caseCall, generation,
                  caseCall.recordTrace ?? true
                );
              }
              const results = await executeTraceBatch({
                ...caseCall, inputBatch: [caseCall.inputs], traceEnabledBatch: [caseCall.recordTrace ?? true],
              });
              return results[0]!;
            }
          : undefined,
        executeTraceBatch: preparation.mode === 'trace' ? executeTraceBatch : undefined,
        dispose: async () => {
          preparedExecution = undefined;
          // Keep the observer slot: it derives only from the trusted reply,
          // and a continuation may prepare it after this disposal.
          this.preparedPrograms.delete(program);
          if (sesProgram) await pool?.disposeProgram(sesProgram).catch(() => undefined);
          if (sesTraceProgram) await pool?.disposeProgram(sesTraceProgram).catch(() => undefined);
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
      const fault = reportedRuntimeFault(error);
      if (fault) throw fault;
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

  private observationSlot(key: object): ObservationPreparationSlot {
    const existing = this.observationPreparations.get(key);
    if (existing) return existing;
    let bind!: ObservationPreparationSlot['bind'];
    const ready = new Promise<ObservationPreparation>((resolve) => { bind = resolve; });
    const slot = { ready, bind };
    this.observationPreparations.set(key, slot);
    return slot;
  }

  async prepareObservation(
    ordinaryPreparationKey: object,
    traceOptions: ObservationOptions,
    signal?: AbortSignal,
  ): Promise<ObservationArtifact> {
    signal?.throwIfAborted();
    // Browser runtime preflight can defer entry to the ordinary provider.
    const { ready } = this.observationSlot(ordinaryPreparationKey);
    const prepare = await new Promise<ObservationPreparation>((resolve, reject) => {
      const abort = () => reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      void ready.then((value) => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      });
    });
    signal?.throwIfAborted();
    return prepare(traceOptions, signal);
  }

  /** Derive one observer artifact from a prepared ordinary program's trusted bytes. */
  private async prepareObservationArtifact(
    artifact: OrdinaryArtifact,
    traceOptions: ObservationOptions,
    signal?: AbortSignal,
  ): Promise<ObservationArtifact> {
    const { generation, language, ...payload } = artifact;
    this.assertActive(generation);
    let preparedExecution: unknown;
    try {
      await this.options.typescriptCompilerPreflight?.();
      signal?.throwIfAborted();
      const coordinator = this.getCoordinator(generation);
      // Cancelling the attempt removes a queued request or detaches from a
      // posted one. Passing its signal to runClientEffect closes the session.
      const work = coordinator.core.runClientEffect(
        coordinator.prepareEffect('prepare-observation', { ...payload, options: traceOptions }, { observerSignal: signal }),
      );
      preparedExecution = await detachPreparedRuntimeRequest(work, signal);
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    const lifetime = new AbortController();
    const observe = async (call: RuntimeObservationCall, disableRecorderForTest: boolean): Promise<Drawing> => {
      const signal = call.signal ? AbortSignal.any([lifetime.signal, call.signal]) : lifetime.signal;
      signal.throwIfAborted();
      if (!preparedExecution) return { status: 'refused', reason: 'observer-prepare' };
      this.assertActive(generation);
      const worker = this.createExecutionWorker();
      this.leasedExecutionWorkers.add(worker);
      const terminate = () => worker.terminate();
      signal.addEventListener('abort', terminate, { once: true });
      try {
        await worker.prewarm(this.executionRuntimeAssetsPayload());
        signal.throwIfAborted();
        const result = await this.runExecution(
          worker,
          this.dispatchPreparedExecutionEffect<unknown>(worker, 'observe-execution', {
            ...payload,
            language,
            preparedExecution,
            options: traceOptions,
            inputs: call.inputs,
            attemptToken: call.attemptToken,
            ...(disableRecorderForTest ? { disableRecorderForTest: true } : {}),
          }),
          TRACING_TIMEOUT_MS,
          signal,
        );
        signal.throwIfAborted();
        return certifyObservation(result, call.attemptToken, language, disableRecorderForTest);
      } catch (error) {
        signal.throwIfAborted();
        return {
          status: 'refused',
          reason: isExecutionTimeoutError(error) ? 'observer-timeout' : 'observer-runtime',
        };
      } finally {
        signal.removeEventListener('abort', terminate);
        this.leasedExecutionWorkers.delete(worker);
        worker.terminate();
      }
    };
    return {
      dispose: () => {
        preparedExecution = undefined;
        lifetime.abort();
      },
      observe: (call) => observe(call, false),
      ...(language === 'javascript' ? {
        observeWithoutRecorderForTest: (call: RuntimeObservationCall) => observe(call, true),
      } : {}),
    };
  }

  private async executePreparedCode(
    language: JavaScriptWorkerLanguage,
    preparation: {
      readonly code: string;
      readonly functionName: string | null;
      readonly executionStyle: JavaScriptExecutionStyle;
      readonly judgedOutputPolicy?: JudgedOutputPolicy;
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
      readonly judgedOutputPolicy?: JudgedOutputPolicy;
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
            reportCaseProgress: true,
            ...(preparation.judgedOutputPolicy
              ? { judgedOutputPolicy: preparation.judgedOutputPolicy }
              : {}),
          }
        ),
        wallClockMs,
        call.signal
      );
      return liftCodeOutcome(result, 'JavaScript execution failed');
    } catch (error) {
      // The program ran past its time limit, configured or default: the
      // learner's limit, never a provider failure.
      if (isExecutionTimeoutError(error)) {
        return {
          kind: 'limit',
          reason: 'client-timeout',
          error: error.message,
          consoleOutput: [],
          timings: {
            totalMs: wallClockMs,
            runMs: wallClockMs,
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
      readonly untracedCompiles?: boolean;
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
            ...(preparation.untracedCompiles ? { untracedCompiles: true } : {}),
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
      if (isTraceUnavailableError(error)) {
        return traceUnavailableOutcome(error as Error, language);
      }
      if (isExecutionTimeoutError(error)) {
        return {
          kind: 'limit',
          reason: 'client-timeout',
          error: error.message,
          trace: createEmptyRuntimeTrace(language),
          executionTimeMs: wallClockMs,
          consoleOutput: [],
          timings: {
            totalMs: wallClockMs,
            runMs: wallClockMs,
            artifactCacheHit: true,
          },
        };
      }
      throw reportedRuntimeFault(error) ?? error;
    }
  }

  private executePreparedCodeBatch(
    language: JavaScriptWorkerLanguage,
    preparation: {
      readonly code: string;
      readonly functionName: string | null;
      readonly executionStyle: JavaScriptExecutionStyle;
      readonly judgedOutputPolicy?: JudgedOutputPolicy;
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
      readonly untracedCompiles?: boolean;
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
    ).catch((error: unknown): never => {
      if (!isTraceUnavailableError(error)) throw reportedRuntimeFault(error) ?? error;
      throw new RuntimeProviderError((error as Error).message, { cause: error, code: TRACE_UNAVAILABLE_CODE });
    });
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

/**
 * The judged-output policy as this client forwards it: the four bounds, each
 * a non-negative safe integer, or none. Only the Judge composition sets it.
 */
function judgedOutputPolicySnapshot(policy: unknown): JudgedOutputPolicy | undefined {
  if (policy === undefined) return undefined;
  const record = policy as Partial<Record<keyof JudgedOutputPolicy, unknown>> | null;
  const bounds = record && typeof record === 'object'
    ? [record.maxBytes, record.maxItems, record.maxNodes, record.maxDepth]
    : [];
  if (bounds.length !== 4 || !bounds.every((bound) => Number.isSafeInteger(bound) && (bound as number) >= 0)) {
    throw new TypeError('JavaScript preparation received an invalid judged-output policy.');
  }
  const [maxBytes, maxItems, maxNodes, maxDepth] = bounds as number[];
  return Object.freeze({ maxBytes: maxBytes!, maxItems: maxItems!, maxNodes: maxNodes!, maxDepth: maxDepth! });
}
