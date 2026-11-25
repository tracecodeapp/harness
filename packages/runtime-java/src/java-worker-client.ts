/**
 * Java Worker Client
 *
 * Session lifecycle, request/response, deadlines, and the Promise boundary
 * live in the shared WorkerSessionCore; this file owns Java-specific
 * concerns: worker construction, asset preflights, idle-timeout handling,
 * the external-compiler relay, sync kernel-HTTP wiring, runtime-load retry
 * policy, and trace assembly.
 */

import * as Effect from 'effect/Effect';
import type {
  CodeExecutionBatchResult,
  CodeExecutionResult,
  Cut,
  Drawing,
  Refusal,
  RuntimeBatchCall,
  RuntimeCodeCall,
  RuntimeExecutionTimings,
  ExecutionLimitReason,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedCodeCall,
  RuntimePreparedTraceBatchCall,
  RuntimePreparedTraceCall,
  RuntimeProgramPreparationCall,
  RuntimeTraceCall,
  TraceExecutionOptions,
} from '@tracecode/runtime-contracts';
import type { JudgedPreparationCall } from '../../runtime-contracts/src/judged-output-policy';
import { liftCodeBatchOutcome, liftCodeOutcome, type RawExecutionBatchPayload } from '@tracecode/runtime-contracts';
import type {
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeProjectCommandRequest,
} from '@tracecode/runtime-contracts';
import {
  isTraceUnavailableError,
  javaTraceHooksEventsToRuntimeTrace,
  RuntimeProviderError,
  TRACE_UNAVAILABLE_CODE,
} from '@tracecode/runtime-contracts';
import { createEmptyRuntimeTrace, type RuntimeTrace } from '@tracecode/runtime-contracts';
import {
  closeKernelHttpSyncServers,
  handleKernelHttpCloseMessage,
  handleKernelHttpDispatchSyncMessage,
  handleKernelHttpListenSyncMessage,
} from '@tracecode/runtime-browser/internal';
import { logRuntimeDiagnostic } from '@tracecode/runtime-browser/internal';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from '@tracecode/runtime-browser/internal';
import { isDevEnvironment } from '@tracecode/runtime-browser/internal';
import {
  InterruptedCodeBatchError,
  isExecutionTimeoutError,
  WorkerCrashedError,
  WorkerReportedError,
  WorkerStartupError,
  WorkerReadyTimeoutError,
  WorkerRequestTimeoutError,
  WorkerTerminatedError,
} from '@tracecode/runtime-browser/internal';
import { WorkerSessionCore, type WorkerSessionMessage } from '@tracecode/runtime-browser/internal';
import type { BrowserWorkerFactory, BrowserWorkerLike } from '@tracecode/runtime-browser/internal';
import { handleHostArtifactCacheRequest, HostArtifactCache } from '@tracecode/runtime-browser/internal';
import type { JudgeOrdinaryBatchCall } from '../../runtime-browser/src/browser-runtime-host-internal';
import { createJavaKernelProcess } from './java-process-kernel';
import { javaBatchTransportDeadlineMs } from './java-batch-deadline';

export type JavaExecutionStyle = 'function' | 'solution-method' | 'ops-class';

const JAVA_KERNEL_HTTP_RUNTIME_LABEL = 'Java';

export interface JavaWorkerClientOptions {
  workerUrl: string;
  debug?: boolean;
  workerIdleTimeoutMs?: number;
  /** Overrides the default trace execution deadline for controlled test or host environments. */
  tracingTimeoutMs?: number;
  /** Bounded content-addressed compiled-class entries retained by this worker (0-64). */
  compileCacheLimit?: number;
  externalCompilerUrl?: string;
  loaderUrl?: string;
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

const JAVA_TRACE_UNAVAILABLE_MESSAGE = 'TraceCode could not trace this case.';

const JAVA_OBSERVER_CUTS: ReadonlySet<string> = new Set<Cut>([
  'step-budget', 'line-budget', 'single-line-budget', 'stored-event-budget', 'byte-budget',
]);
const JAVA_OBSERVER_REFUSALS: ReadonlySet<string> = new Set<Refusal>([
  'recorder-unavailable', 'observer-encode', 'observer-runtime', 'observer-protocol', 'observer-timeout',
]);

function decodeJavaObservation(
  entry: JavaWorkerRawObservation,
  attemptToken: string,
  options?: TraceExecutionOptions
): Drawing {
  const { observation } = entry;
  if (!observation || observation.attemptToken !== attemptToken) {
    return { status: 'refused', reason: 'observer-protocol' };
  }
  if (!entry.success) {
    const reason = observation.reason;
    return {
      status: 'refused',
      reason: typeof reason === 'string' && JAVA_OBSERVER_REFUSALS.has(reason)
        ? reason as Refusal
        : 'observer-protocol',
    };
  }
  let events: string[];
  try {
    events = javaTraceEvents(entry.trace?.events);
  } catch {
    return { status: 'refused', reason: 'observer-protocol' };
  }
  const { cut, attemptedEvents } = observation;
  if (cut !== undefined && (
    typeof cut !== 'string' || !JAVA_OBSERVER_CUTS.has(cut) ||
    typeof attemptedEvents !== 'number' || !Number.isSafeInteger(attemptedEvents) ||
    attemptedEvents <= events.length || (cut !== 'byte-budget' && events.length === 0)
  )) {
    return { status: 'refused', reason: 'observer-protocol' };
  }
  try {
    const trace = javaTraceHooksEventsToRuntimeTrace(events, entry.sourceText, {
      runId: 'java:run',
      file: JAVA_DEFAULT_FILE,
      maxPathDepth: options?.maxPathDepth,
    });
    if (cut !== undefined) {
      return { status: 'truncated', reason: cut as Cut, trace, attemptedEvents: attemptedEvents as number };
    }
    return trace.events.some((event) => event.kind === 'line' && event.line > 0)
      ? { status: 'drawn', trace }
      : { status: 'refused', reason: 'uncertified-drawing' };
  } catch {
    return { status: 'refused', reason: 'observer-encode' };
  }
}

/**
 * The events of a successful traced reply. A reply without an array of event
 * strings broke the worker protocol, whether or not the case recorded.
 */
function javaTraceEvents(events: unknown): string[] {
  if (!Array.isArray(events) || !events.every((event) => typeof event === 'string')) {
    throw new RuntimeProviderError(
      'The Java worker returned a trace result without a valid events array.',
      { reason: 'protocol' }
    );
  }
  return events;
}

/**
 * The runtime trace of a traced Java case. When the case recorded a trace
 * that cannot be read back (for example, an event that refers to a call
 * stack the trace never recorded), that one case is rejected as
 * trace-unavailable; a case that recorded nothing is never refused.
 */
function javaTraceOrRefusal(
  events: unknown,
  sourceText: string | undefined,
  options: Parameters<typeof javaTraceHooksEventsToRuntimeTrace>[2],
  recorded: boolean
): RuntimeTrace {
  // Outside the catch: a malformed reply is never an untraceable case.
  const traceEvents = javaTraceEvents(events);
  try {
    return javaTraceHooksEventsToRuntimeTrace(traceEvents, sourceText, options);
  } catch (error) {
    if (!recorded) throw error;
    throw new RuntimeProviderError(JAVA_TRACE_UNAVAILABLE_MESSAGE, {
      cause: error,
      code: TRACE_UNAVAILABLE_CODE,
    });
  }
}

export interface JavaWorkerRawTraceResult {
  success: boolean;
  output?: unknown;
  events: string[];
  sourceText?: string;
  executionTimeMs: number;
  error?: string;
  errorLine?: number;
  diagnosticStage?: 'runtime' | 'trace';
  diagnostic?: unknown;
  consoleOutput: string[];
  traceLimitExceeded?: boolean;
  traceLimitReason?: ExecutionLimitReason;
  timeoutReason?: ExecutionLimitReason;
  droppedEventCount?: number;
  timings?: RuntimeExecutionTimings;
  retirementRecommended?: boolean;
  /**
   * Set by the direct trace batch on an entry whose recorded trace could not
   * be read back: the runtime could not trace that case.
   */
  traceUnavailable?: boolean;
  runtimeIsolation?: unknown;
  /** Default-off VM diagnostics used by compatibility/performance campaigns. */
  bytecodeProfile?: unknown;
  diagnosticError?: string;
  algorithmIsolationProfile?: JavaAlgorithmIsolationProfile;
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
  diagnosticStage?: 'runtime';
  diagnostic?: unknown;
  consoleOutput?: string[];
  timeoutReason?: ExecutionLimitReason;
  timings?: RuntimeExecutionTimings;
  retirementRecommended?: boolean;
  runtimeIsolation?: unknown;
  algorithmIsolationProfile?: JavaAlgorithmIsolationProfile;
}

interface JavaWorkerPreparedBatchResult<Result> {
  success: boolean;
  results?: Result[];
  resultsStreamed?: number;
  error?: string;
  executionTimeMs?: number;
  timings?: RuntimeExecutionTimings & { runnerProcessCount?: number };
}

interface JavaWorkerRawPreparedTraceBatchItem
  extends Omit<JavaWorkerRawTraceResult, 'events'> {
  trace: { events: string[] };
}

interface JavaWorkerRawObservation {
  success: boolean;
  trace?: { events?: unknown };
  observation?: { attemptToken?: unknown; cut?: unknown; attemptedEvents?: unknown; reason?: unknown };
  sourceText?: string;
}

export interface JavaWorkerPreparedProgramSnapshot {
  readonly schema: 'tracecode.java.prepared-program-snapshot.v1';
  readonly programId: string;
  readonly algorithmIsolationProfile?: JavaAlgorithmIsolationProfile;
  readonly [key: string]: unknown;
}

export interface JavaAlgorithmIsolationProfile {
  readonly schema: 'tracecode.java.algorithm-isolation-profile.v1';
  readonly tier: 'algorithm-fast' | 'compatibility';
  readonly boundary:
    | 'fresh-application-class-loader'
    | 'fresh-runtime-process';
  readonly reasons: readonly string[];
  readonly scannedClasses: number;
}

export interface JavaWorkerPreparedProgramResult {
  success: boolean;
  programId?: string;
  snapshot?: JavaWorkerPreparedProgramSnapshot;
  error?: string;
  errorLine?: number;
  /** Structured compiler output (`tracecode.compiler-diagnostic.v1`). */
  diagnostic?: unknown;
  consoleOutput?: string[];
  timings?: RuntimeExecutionTimings;
  algorithmIsolationProfile?: JavaAlgorithmIsolationProfile;
}

export interface JavaWorkerPreparedExecutionMetadata {
  readonly retirementRecommended: boolean;
  readonly runtimeIsolation?: unknown;
  readonly algorithmIsolationProfile?: JavaAlgorithmIsolationProfile;
}

type JavaPreparedMetadataSource = Pick<
  JavaWorkerRawTraceResult,
  'retirementRecommended' | 'runtimeIsolation' | 'algorithmIsolationProfile'
>;

function javaPreparedExecutionMetadata(
  result: JavaPreparedMetadataSource
): JavaWorkerPreparedExecutionMetadata {
  return {
    retirementRecommended: result.retirementRecommended === true,
    ...(result.algorithmIsolationProfile === undefined
      ? {}
      : { algorithmIsolationProfile: result.algorithmIsolationProfile }),
    ...(result.runtimeIsolation === undefined
      ? {}
      : { runtimeIsolation: result.runtimeIsolation }),
  };
}

export type JavaWorkerPreparedCodeResult =
  CodeExecutionResult & JavaWorkerPreparedExecutionMetadata;

type JavaBatchCaseReport = Pick<JavaWorkerCodeResult, 'success' | 'timeoutReason' | 'timings'>;

function isJavaBatchRunaway(entry: JavaBatchCaseReport): boolean {
  return !entry.success && (
    entry.timeoutReason === 'client-timeout' ||
    entry.timeoutReason === 'line-limit' ||
    entry.timeoutReason === 'single-line-limit'
  );
}

function javaBatchProtocolError(message: string): RuntimeProviderError {
  return new RuntimeProviderError(message, { reason: 'protocol' });
}

// Ordinary result fields are scalars, arrays, or plain objects produced from
// the runner's JSON report. The optional full terminal must agree field for field.
function sameJavaBatchValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
    Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;
  const rightFields = right as Record<string, unknown>;
  const fields = Object.entries(left);
  return fields.length === Object.keys(rightFields).length && fields.every(([key, value]) =>
    Object.hasOwn(rightFields, key) && sameJavaBatchValue(value, rightFields[key])
  );
}

function javaPreparedCodeOutcome(entry: JavaWorkerCodeResult): JavaWorkerPreparedCodeResult {
  return {
    ...liftCodeOutcome(entry, 'Java prepared execution failed'),
    ...javaPreparedExecutionMetadata(entry),
  };
}

class JavaCodeBatchProgress {
  readonly reports: JavaWorkerCodeResult[] = [];
  readonly outcomes: JavaWorkerPreparedCodeResult[] = [];
  private running: number | undefined;
  stopped = false;

  constructor(
    readonly admissionId: number,
    private readonly call: JudgeOrdinaryBatchCall,
    private readonly onCaseAdmitted?: (index: number) => void
  ) {}

  get interruptedIndex(): number | undefined {
    return this.running;
  }

  receive(payload: unknown): void {
    if (this.call.signal?.aborted) return;
    const progress = payload as {
      stage?: string;
      detail?: { admissionId?: number; caseIndex?: number; result?: JavaWorkerCodeResult };
    } | undefined;
    const started = progress?.stage === 'ordinary-case-started';
    if (!started && progress?.stage !== 'ordinary-case-finished') return;
    const { admissionId, caseIndex, result } = progress.detail ?? {};
    if (admissionId !== this.admissionId || this.stopped ||
      caseIndex !== this.reports.length || caseIndex >= this.call.inputBatch.length
    ) {
      throw javaBatchProtocolError('Java prepared batch returned invalid case progress.');
    }
    if (started) {
      if (this.running !== undefined) {
        throw javaBatchProtocolError('Java prepared batch started a case more than once.');
      }
      this.running = caseIndex;
      this.onCaseAdmitted?.(caseIndex);
      return;
    }
    if (this.running !== caseIndex || typeof result?.success !== 'boolean') {
      throw javaBatchProtocolError('Java prepared batch finished a case without a matching start and result.');
    }
    const outcome = javaPreparedCodeOutcome(result);
    this.reports.push(result);
    this.outcomes.push(outcome);
    this.running = undefined;
    this.stopped = this.call.stopAtFirstRunaway === true && isJavaBatchRunaway(result);
    this.call.onCaseFinished?.(caseIndex, outcome);
  }
}

export type JavaWorkerPreparedTraceResult =
  JavaWorkerTraceResult & JavaWorkerPreparedExecutionMetadata;

export type JavaWorkerProjectRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type JavaWorkerProjectResult = RuntimeCommandResult;

export interface JavaTraceExecutionOptions {
  maxTraceSteps?: number;
  maxLineEvents?: number;
  maxSingleLineHits?: number;
  maxStoredEvents?: number;
  maxPathDepth?: number;
  minimalTrace?: boolean;
  /** Opt-in TraceHooks hot-path profile (nanoTime spans + PROFILE marker). */
  traceProfile?: boolean;
}

const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 25_000;
const INIT_TIMEOUT_MS = 120_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const JAVA_DEFAULT_FILE = 'solution.java';
const JAVA_HOST_ARTIFACT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const KERNEL_HTTP_SYNC_MESSAGE_TYPES = new Set([
  'kernel-http-dispatch-sync',
  'kernel-http-listen-sync',
  'kernel-http-close',
]);

export class JavaWorkerClient {
  /** Memoized runtime-load results for the current session; cleared by the session finalizer. */
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private generation = 0;
  private activeExternalCompileControllers = new Set<AbortController>();
  private readonly debug: boolean;
  private readonly core: WorkerSessionCore;
  private readonly artifactCache: HostArtifactCache;
  private nextAdmissionId = 0;
  private readonly codeBatchProgress = new Map<string, Pick<JavaCodeBatchProgress, 'receive'>>();

  constructor(private readonly options: JavaWorkerClientOptions) {
    if (
      options.compileCacheLimit !== undefined &&
      (!Number.isInteger(options.compileCacheLimit) || options.compileCacheLimit < 0 || options.compileCacheLimit > 64)
    ) {
      throw new TypeError('Java compileCacheLimit must be an integer from 0 to 64.');
    }
    this.debug = options.debug ?? isDevEnvironment();
    this.artifactCache = new HostArtifactCache(
      options.compileCacheLimit ?? 16,
      JAVA_HOST_ARTIFACT_CACHE_MAX_BYTES
    );

    this.core = new WorkerSessionCore({
      runtimeLabel: 'Java',
      component: 'JavaWorkerClient',
      runtime: 'java',
      debug: this.debug,
      readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
      defaultMessageTimeoutMs: MESSAGE_TIMEOUT_MS,
      isSupported: () => this.isSupported(),
      createWorker: () => this.createWorker(),
      preflight: async (type) => {
        await this.options.assetPreflight?.();
        if (type !== 'status') {
          await this.options.runtimeAssetPreflight?.();
        }
      },
      onCommandMessage: (commandId, type, payload, pending) => {
        if (type === 'runtime-progress') {
          try {
            this.codeBatchProgress.get(commandId)?.receive(payload);
          } catch (error) {
            this.core.closeSession(error instanceof Error ? error : new Error(String(error)));
          }
          return true;
        }
        if (type === 'kernel-execution-scope-reset') {
          const requestId =
            typeof payload === 'object' &&
            payload !== null &&
            'requestId' in payload &&
            typeof payload.requestId === 'string'
              ? payload.requestId
              : '';
          const session = this.core.currentSession;
          const reset = pending.kernelSyscalls?.resetExecutionScope;
          void (
            requestId && session && reset
              ? reset()
              : Promise.reject(
                  new Error(
                    'Java batch requested a TraceKernel execution-scope reset without an active host checkpoint.'
                  )
                )
          ).then(
            () => {
              if (!session || this.core.currentSession !== session) return;
              session.worker.postMessage({
                id: commandId,
                type: 'kernel-execution-scope-reset-complete',
                protocolToken: pending.protocolToken,
                payload: { requestId },
              });
            },
            (error) => {
              if (this.core.currentSession !== session) return;
              session?.worker.postMessage({
                id: commandId,
                type: 'kernel-execution-scope-reset-failed',
                protocolToken: pending.protocolToken,
                payload: {
                  requestId,
                  error:
                    error instanceof Error
                      ? error.message
                      : String(error),
                },
              });
            }
          );
          return true;
        }
        if (type === 'kernel-syscall') {
          if (!pending.kernelSyscalls) return true;
          void pending.kernelSyscalls.service().catch(() => {
            pending.kernelSyscalls?.close();
          });
          return true;
        }
        if (!KERNEL_HTTP_SYNC_MESSAGE_TYPES.has(type)) return false;
        if (type === 'kernel-http-dispatch-sync') {
          handleKernelHttpDispatchSyncMessage(pending, payload, JAVA_KERNEL_HTTP_RUNTIME_LABEL);
        } else if (type === 'kernel-http-listen-sync') {
          handleKernelHttpListenSyncMessage(pending, payload, JAVA_KERNEL_HTTP_RUNTIME_LABEL);
        } else {
          handleKernelHttpCloseMessage(pending, payload, JAVA_KERNEL_HTTP_RUNTIME_LABEL);
        }
        return true;
      },
      onUnhandledMessage: (message, session) => {
        if (message.type === 'idle-timeout') {
          logRuntimeDiagnostic('info', {
            component: 'JavaWorkerClient',
            runtime: 'java',
            phase: 'idle-timeout',
            message: 'Java worker closed after idle timeout.',
          }, { enabled: this.debug });
          this.core.closeSession(new WorkerTerminatedError('Java worker closed after idle timeout'));
          return true;
        }
        if (message.type === 'java-compile-request') {
          this.handleJavaCompileRequest(message, session.worker);
          return true;
        }
        if (message.type === 'compiler-artifact-cache-request') {
          this.handleArtifactCacheRequest(message, session.worker);
          return true;
        }
        return false;
      },
      decodeReply: (payload) => restoreTransferredTraceEvents(payload),
      // The CheerpJ runtime does not survive script errors; a crashed worker is
      // torn down and lazily respawned on the next request.
      closeSessionOnWorkerError: true,
    });
    this.core.executionTimeoutLabel = 'Java';
    this.core.cleanupPending = (pending) => closeKernelHttpSyncServers(pending, JAVA_KERNEL_HTTP_RUNTIME_LABEL);
    this.core.onSessionClosed = () => {
      this.generation += 1;
      this.initPromise = null;
      this.warmupPromise = null;
      for (const controller of this.activeExternalCompileControllers) {
        controller.abort();
      }
      this.activeExternalCompileControllers.clear();
    };
  }

  /** Changes whenever the physical Java Worker session is retired. */
  get sessionGeneration(): number {
    return this.generation;
  }

  isSupported(): boolean {
    return this.options.workerFactory !== undefined || typeof Worker !== 'undefined';
  }

  private createWorker(): BrowserWorkerLike {
    const workerUrl =
      this.debug && !this.options.workerUrl.includes('?')
        ? `${this.options.workerUrl}?dev=${Date.now()}`
        : this.options.workerUrl;

    return this.options.workerFactory
      ? this.options.workerFactory(workerUrl)
      : new Worker(workerUrl);
  }

  private hasPendingProtocolToken(protocolToken: unknown): protocolToken is string {
    return typeof protocolToken === 'string' &&
      Array.from(this.core.pendingMessages.values()).some((pending) => pending.protocolToken === protocolToken);
  }

  private handleJavaCompileRequest(message: WorkerSessionMessage, worker: BrowserWorkerLike): void {
    if (!this.hasPendingProtocolToken(message.protocolToken)) return;
    if (!message.requestId) return;

    this.compileJavaWithExternalUrl(message.payload)
      .then((result) => {
        worker.postMessage({
          type: 'java-compile-response',
          requestId: message.requestId,
          protocolToken: message.protocolToken,
          payload: result,
        });
      })
      .catch((error) => {
        worker.postMessage({
          type: 'java-compile-response',
          requestId: message.requestId,
          protocolToken: message.protocolToken,
          payload: { success: false, error: error instanceof Error ? error.message : String(error) },
        });
      });
  }

  private handleArtifactCacheRequest(message: WorkerSessionMessage, worker: BrowserWorkerLike): void {
    handleHostArtifactCacheRequest({
      cache: this.artifactCache,
      message,
      worker,
      validateProtocolToken: (protocolToken) => this.hasPendingProtocolToken(protocolToken),
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

  /** Runtime-load failures that warrant a worker reset + one retry. Every error this can see is tagged. */
  private shouldResetRuntimeLoadError(failure: unknown): boolean {
    const error = failure instanceof WorkerStartupError ? failure.cause : failure;
    if (error instanceof WorkerRequestTimeoutError) {
      return error.messageType === 'init';
    }
    return (
      error instanceof WorkerTerminatedError ||
      error instanceof WorkerCrashedError ||
      error instanceof WorkerReadyTimeoutError
    );
  }

  /**
   * The init program: one attempt, and on a runtime-load failure, reset the
   * session and run the same description once more.
   */
  private initEffect(signal?: AbortSignal): Effect.Effect<InitResult, Error> {
    const attempt = this.core.sendMessageEffect<InitResult>('init', this.workerOptionsPayload(), INIT_TIMEOUT_MS);
    return attempt.pipe(
      Effect.catchIf(
        (error): error is Error =>
          signal?.aborted !== true &&
          this.shouldResetRuntimeLoadError(error),
        (error) =>
          Effect.suspend(() => {
            logRuntimeDiagnostic('warn', {
              component: 'JavaWorkerClient',
              runtime: 'java',
              phase: 'init-retry',
              message: 'Java worker init failed; resetting worker and retrying once.',
              detail: { message: error.message },
            }, { enabled: this.debug });
            this.core.closeSession();
            return attempt;
          })
      )
    );
  }

  async init(signal?: AbortSignal): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;

    const promise = this.core.runClientEffect(this.initEffect(signal), signal);
    this.initPromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.initPromise === promise) this.initPromise = null;
      throw error;
    }
  }

  private workerOptionsPayload(): {
    idleTimeoutMs?: number;
    compileCacheLimit?: number;
    externalCompilerEnabled?: boolean;
    cheerpjLoaderUrl?: string;
    runtimeAssets?: JavaWorkerClientOptions['runtimeAssets'];
    allowIsolatedRuntimeStorage?: boolean;
  } {
    return {
      ...(this.options.workerIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.options.workerIdleTimeoutMs }),
      ...(this.options.compileCacheLimit === undefined ? {} : { compileCacheLimit: this.options.compileCacheLimit }),
      ...(this.options.externalCompilerUrl ? { externalCompilerEnabled: true } : {}),
      ...(this.options.loaderUrl ? { cheerpjLoaderUrl: this.options.loaderUrl } : {}),
      ...(this.options.runtimeAssets ? { runtimeAssets: this.options.runtimeAssets } : {}),
      ...(this.options.isolatedRuntimeStorage ? { allowIsolatedRuntimeStorage: true } : {}),
    };
  }

  async warmup(): Promise<WarmupResult> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      try {
        await this.init();
        return await this.core.sendMessage<WarmupResult>(
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

  /** Clears persistent learner-addressable runtime storage before a safe execution. */
  async resetPersistentStorage(): Promise<void> {
    await this.init();
    await this.core.sendMessage<{ success: boolean }>(
      'reset-persistent-storage',
      undefined,
      INIT_TIMEOUT_MS
    );
  }

  /** Runtime load ahead of an execution. Memoization stays Promise-based on the client. */
  private initGateEffect(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.init().then(() => undefined),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<JavaWorkerTraceResult> {
    const kernelProcess = await createJavaKernelProcess();
    const { code, inputs, traceOptions, executionStyle = 'function', signal } = call;
    const functionName = call.functionName ?? '';
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<JavaWorkerRawTraceResult>('execute-with-tracing', {
            code,
            functionName,
            inputs,
            options: traceOptions,
            executionStyle,
            traceEventTransport: traceEventTransferRequest(),
            ...this.workerOptionsPayload(),
          }, null, undefined, undefined, undefined, kernelProcess.bridge),
          // The enclosing execution deadline is the only clock.
          Number.isFinite(this.options.tracingTimeoutMs) && Number(this.options.tracingTimeoutMs) > 0
            ? Math.floor(Number(this.options.tracingTimeoutMs))
            : TRACING_TIMEOUT_MS
        )
      )
    );

    let result: JavaWorkerRawTraceResult;
    try {
      result = await this.core.runClientEffect(program, signal);
      await kernelProcess.complete(result.success ? 0 : 1);
      if (kernelProcess.retireWorkerAfterCompletion) this.core.closeSession();
    } catch (error) {
      await kernelProcess.fail(error);
      throw error;
    }
    // The worker and its process finished normally; a trace that cannot be
    // read back refuses this case only.
    return {
      ...result,
      trace: result.success
        ? javaTraceOrRefusal(result.events, result.sourceText, {
            runId: 'java:run',
            file: JAVA_DEFAULT_FILE,
            maxPathDepth: traceOptions?.maxPathDepth,
          }, true)
        : createEmptyRuntimeTrace('java', { runId: 'java:run', file: JAVA_DEFAULT_FILE }),
    };
  }

  async executeCode(call: RuntimeCodeCall & { traceOptions?: JavaTraceExecutionOptions }): Promise<CodeExecutionResult> {
    const kernelProcess = await createJavaKernelProcess();
    const { code, functionName, inputs, traceOptions, executionStyle = 'function', signal, limits } = call;
    const wallClockMs = limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS;
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<JavaWorkerCodeResult>('execute-code', {
            code,
            functionName,
            inputs,
            options: traceOptions,
            executionStyle,
            ...this.workerOptionsPayload(),
          }, null, undefined, undefined, undefined, kernelProcess.bridge),
          wallClockMs
        )
      )
    );

    try {
      const result = await this.core.runClientEffect(program, signal);
      await kernelProcess.complete(result.success ? 0 : 1);
      if (kernelProcess.retireWorkerAfterCompletion) this.core.closeSession();
      return liftCodeOutcome(result, 'Java execution failed');
    } catch (error) {
      await kernelProcess.fail(error);
      throw error;
    }
  }

  async executeCodeBatch(call: RuntimeBatchCall & { traceOptions?: JavaTraceExecutionOptions }): Promise<CodeExecutionBatchResult> {
    const kernelProcess = await createJavaKernelProcess();
    const { code, functionName, inputBatch, traceOptions, executionStyle = 'function', signal } = call;
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<RawExecutionBatchPayload>('execute-code-batch', {
            code,
            functionName,
            inputBatch,
            options: traceOptions,
            executionStyle,
            ...this.workerOptionsPayload(),
          }, null, undefined, undefined, undefined, kernelProcess.bridge),
          EXECUTION_TIMEOUT_MS
        )
      )
    );

    try {
      const result = await this.core.runClientEffect(program, signal);
      await kernelProcess.complete(result.success ? 0 : 1);
      if (kernelProcess.retireWorkerAfterCompletion) this.core.closeSession();
      return liftCodeBatchOutcome(result, 'Java execution failed');
    } catch (error) {
      await kernelProcess.fail(error);
      throw error;
    }
  }

  async prepareRuntimeProgram(
    call: RuntimeProgramPreparationCall,
    observerOnly = false
  ): Promise<JavaWorkerPreparedProgramResult> {
    const judgedOutputPolicy = call.mode === 'code'
      ? (call as JudgedPreparationCall).judgedOutputPolicy
      : undefined;
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.sendMessageEffect<JavaWorkerPreparedProgramResult>(
          'prepare-runtime-program',
          {
            mode: call.mode,
            code: call.code,
            functionName: call.functionName ?? '',
            executionStyle: call.executionStyle ?? 'function',
            options: call.traceOptions,
            ...(judgedOutputPolicy ? { judgedOutputPolicy } : {}),
            ...(observerOnly ? { observerOnly: true } : {}),
            ...this.workerOptionsPayload(),
          },
          null
        )
      )
    );
    return this.core.runClientEffect(program, call.signal);
  }

  async restorePreparedRuntimeProgram(
    snapshot: JavaWorkerPreparedProgramSnapshot
  ): Promise<JavaWorkerPreparedProgramResult> {
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.sendMessageEffect<JavaWorkerPreparedProgramResult>(
          'restore-prepared-runtime-program',
          {
            snapshot,
            ...this.workerOptionsPayload(),
          },
          null
        )
      )
    );
    return this.core.runClientEffect(program);
  }

  async executePreparedCode(
    programId: string,
    call: RuntimePreparedCodeCall
  ): Promise<JavaWorkerPreparedCodeResult> {
    const kernelProcess = await createJavaKernelProcess();
    const wallClockMs = call.limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS;
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<JavaWorkerCodeResult>(
            'execute-prepared-runtime-program',
            {
              programId,
              inputs: call.inputs,
            },
            null,
            undefined,
            undefined,
            undefined,
            kernelProcess.bridge
          ),
          wallClockMs
        )
      )
    );
    try {
      const result = await this.core.runClientEffect(program, call.signal);
      await kernelProcess.complete(result.success ? 0 : 1);
      if (kernelProcess.retireWorkerAfterCompletion) this.core.closeSession();
      return {
        ...liftCodeOutcome(result, 'Java prepared execution failed'),
        ...javaPreparedExecutionMetadata(result),
      };
    } catch (error) {
      await kernelProcess.fail(error);
      throw error;
    }
  }

  private async executePreparedBatch<
    Raw extends JavaBatchCaseReport,
    Result
  >(
    programId: string,
    call: RuntimePreparedCodeBatchCall,
    perCaseWallClockMs: number,
    options: Record<string, unknown>,
    decode: (entry: Raw, index: number) => Result,
    stream?: { receive(payload: unknown): void; readonly reports: readonly Raw[] }
  ): Promise<readonly Result[]> {
    if (call.inputBatch.length === 0) return [];
    const kernelProcess = await createJavaKernelProcess();
    let commandId: string | undefined;
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffectWithOptions<JavaWorkerPreparedBatchResult<Raw>>(
            'execute-prepared-runtime-program-batch',
            {
              programId,
              inputBatch: call.inputBatch,
              perCaseWallClockMs,
              stopAtFirstRunaway: call.stopAtFirstRunaway === true,
              ...options,
            },
            {
              timeoutMs: null,
              kernelSyscalls: kernelProcess.bridge,
              onRequestRegistered: stream && ((id) => {
                commandId = id;
                this.codeBatchProgress.set(id, stream);
              }),
            }
          ),
          javaBatchTransportDeadlineMs(
            perCaseWallClockMs, call.inputBatch.length, INIT_TIMEOUT_MS
          )
        )
      )
    );
    try {
      const reply = await this.core.runClientEffect(program, call.signal);
      let results = reply?.results;
      if (stream) {
        if (typeof reply?.success !== 'boolean') {
          throw javaBatchProtocolError('Java prepared batch returned an invalid terminal reply.');
        }
        if (reply.success === false && typeof reply.error === 'string' &&
          Array.isArray(results) && results.length === 0 && reply.resultsStreamed === undefined
        ) {
          throw new RuntimeProviderError(reply.error);
        }
        const matches = reply.resultsStreamed === undefined
          ? Array.isArray(results) && sameJavaBatchValue(results, stream.reports)
          : results === undefined && reply.resultsStreamed === stream.reports.length;
        if (!matches) {
          throw javaBatchProtocolError('Java prepared batch terminal did not match its streamed results.');
        }
        results = stream.reports.slice();
        // Runner count is known only at the terminal. Keep the historical
        // placement of this batch-wide diagnostic on the first decoded row.
        const first = results[0];
        const runnerProcessCount = reply.timings?.runnerProcessCount;
        if (first?.timings && runnerProcessCount !== undefined) {
          results[0] = {
            ...first,
            timings: { ...first.timings, runnerProcessCount },
          };
        }
      }
      if (
        !Array.isArray(results) ||
        results.some((entry) => typeof entry?.success !== 'boolean')
      ) {
        throw new RuntimeProviderError('Java prepared batch returned an invalid result array.', {
          reason: 'protocol',
        });
      }
      if (results.length === 0 && typeof reply.error === 'string') {
        throw new RuntimeProviderError(reply.error);
      }
      const runawayIndex = call.stopAtFirstRunaway
        ? results.findIndex(isJavaBatchRunaway)
        : -1;
      if (
        results.length > call.inputBatch.length ||
        (runawayIndex === -1
          ? results.length !== call.inputBatch.length
          : runawayIndex !== results.length - 1)
      ) {
        throw new RuntimeProviderError(
          `Java prepared batch returned an invalid prefix of ${results.length} results for ${call.inputBatch.length} cases.`,
          { reason: 'protocol' }
        );
      }
      const decoded = results.map(decode);
      await kernelProcess.complete(reply.success ? 0 : 1);
      return decoded;
    } catch (error) {
      await kernelProcess.fail(error);
      if (isExecutionTimeoutError(error)) {
        throw new RuntimeProviderError(
          'The Java prepared batch exceeded its transport deadline.',
          { cause: error }
        );
      }
      throw error;
    } finally {
      if (commandId !== undefined) this.codeBatchProgress.delete(commandId);
    }
  }

  async executePreparedCodeBatch(
    programId: string,
    call: JudgeOrdinaryBatchCall,
    onCaseAdmitted?: (index: number) => void
  ): Promise<readonly JavaWorkerPreparedCodeResult[]> {
    const admissionId = ++this.nextAdmissionId;
    const progress = new JavaCodeBatchProgress(admissionId, call, onCaseAdmitted);
    try {
      return await this.executePreparedBatch<JavaWorkerCodeResult, JavaWorkerPreparedCodeResult>(
        programId,
        call,
        call.limits?.wallClockMs ?? EXECUTION_TIMEOUT_MS,
        { admissionId },
        javaPreparedCodeOutcome,
        progress
      );
    } catch (error) {
      if (call.signal?.aborted) throw error;
      const cause = error instanceof WorkerCrashedError || error instanceof WorkerReportedError ||
        error instanceof WorkerTerminatedError
        ? new RuntimeProviderError(error.message, { cause: error })
        : error;
      if (!(cause instanceof RuntimeProviderError) || cause.reason === 'protocol') throw cause;
      if (progress.stopped) return progress.outcomes;
      if (progress.outcomes.length === 0) throw cause;
      // Keep the original failure in the chain when the deadline or reply
      // revealed the loss.
      const loss = error instanceof WorkerCrashedError ? error : Object.assign(
        new WorkerCrashedError({
          workerMessage: cause.message,
          filename: undefined,
          lineno: undefined,
          colno: undefined,
        }),
        { cause }
      );
      throw new InterruptedCodeBatchError(progress.outcomes, loss, {
        interruption: isExecutionTimeoutError(cause.cause) ? 'transport-deadline' : 'worker-loss',
        interruptedIndex: progress.interruptedIndex,
      });
    }
  }

  async observePreparedProgram(
    programId: string,
    input: Record<string, unknown>,
    attemptToken: string,
    options?: TraceExecutionOptions,
    signal?: AbortSignal
  ): Promise<Drawing> {
    const deadline = this.options.tracingTimeoutMs;
    const [drawing] = await this.executePreparedBatch<JavaWorkerRawObservation, Drawing>(
      programId,
      { inputBatch: [input], signal },
      typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0
        ? Math.floor(deadline)
        : TRACING_TIMEOUT_MS,
      { traceEventTransport: traceEventTransferRequest(), observationOptions: options, attemptToken },
      (entry) => decodeJavaObservation(entry, attemptToken, options)
    );
    return drawing ?? { status: 'refused', reason: 'observer-protocol' };
  }

  async executePreparedWithTracing(
    programId: string,
    call: RuntimePreparedTraceCall,
    traceOptions?: JavaTraceExecutionOptions
  ): Promise<JavaWorkerPreparedTraceResult> {
    const kernelProcess = await createJavaKernelProcess();
    const wallClockMs = call.limits?.wallClockMs ??
      (
        Number.isFinite(this.options.tracingTimeoutMs) &&
        Number(this.options.tracingTimeoutMs) > 0
          ? Math.floor(Number(this.options.tracingTimeoutMs))
          : TRACING_TIMEOUT_MS
      );
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<JavaWorkerRawTraceResult>(
            'execute-prepared-runtime-program',
            {
              programId,
              inputs: call.inputs,
              ...(call.recordTrace === undefined
                ? {}
                : { traceEnabled: call.recordTrace }),
              traceEventTransport: traceEventTransferRequest(),
            },
            null,
            undefined,
            undefined,
            undefined,
            kernelProcess.bridge
          ),
          wallClockMs
        )
      )
    );
    let result: JavaWorkerRawTraceResult;
    try {
      result = await this.core.runClientEffect(program, call.signal);
      await kernelProcess.complete(result.success ? 0 : 1);
      if (kernelProcess.retireWorkerAfterCompletion) this.core.closeSession();
    } catch (error) {
      await kernelProcess.fail(error);
      throw error;
    }
    // The worker and its process finished normally; a recorded trace that
    // cannot be read back refuses this case only.
    return {
      ...result,
      trace: result.success
        ? javaTraceOrRefusal(result.events, result.sourceText, {
            runId: 'java:run',
            file: JAVA_DEFAULT_FILE,
            maxPathDepth: traceOptions?.maxPathDepth,
          }, call.recordTrace !== false)
        : createEmptyRuntimeTrace('java', {
            runId: 'java:run',
            file: JAVA_DEFAULT_FILE,
          }),
      ...javaPreparedExecutionMetadata(result),
    };
  }

  async executePreparedTraceBatch(
    programId: string,
    call: RuntimePreparedTraceBatchCall,
    traceOptions?: JavaTraceExecutionOptions
  ): Promise<readonly JavaWorkerPreparedTraceResult[]> {
    const traceEnabledBatch = call.traceEnabledBatch;
    if (
      traceEnabledBatch !== undefined &&
      (
        traceEnabledBatch.length !== call.inputBatch.length ||
        traceEnabledBatch.some(
          (enabled) => typeof enabled !== 'boolean'
        )
      )
    ) {
      throw new TypeError(
        'Java trace selection must contain one boolean per batch case.'
      );
    }
    const perCaseWallClockMs =
      call.limits?.wallClockMs ??
      (
        Number.isFinite(this.options.tracingTimeoutMs) &&
        Number(this.options.tracingTimeoutMs) > 0
          ? Math.floor(Number(this.options.tracingTimeoutMs))
          : TRACING_TIMEOUT_MS
      );
    return this.executePreparedBatch<JavaWorkerRawPreparedTraceBatchItem, JavaWorkerPreparedTraceResult>(
      programId,
      call,
      perCaseWallClockMs,
      {
        traceEventTransport: traceEventTransferRequest(),
        ...(traceEnabledBatch ? { traceEnabledBatch } : {}),
      },
      (entry, index) => {
        const events = javaTraceEvents(entry.trace?.events);
        const empty = createEmptyRuntimeTrace('java', {
          runId: 'java:run',
          file: JAVA_DEFAULT_FILE,
        });
        let trace = empty;
        if (entry.success) {
          try {
            trace = javaTraceOrRefusal(
              events,
              entry.sourceText,
              {
                runId: 'java:run',
                file: JAVA_DEFAULT_FILE,
                maxPathDepth: traceOptions?.maxPathDepth,
              },
              traceEnabledBatch?.[index] !== false
            );
          } catch (error) {
            if (!isTraceUnavailableError(error)) throw error;
            // This entry's recorded trace cannot be read back: the runtime
            // could not trace this case; the other entries keep theirs.
            return {
              ...entry,
              events,
              success: false,
              traceUnavailable: true,
              error: (error as Error).message,
              diagnosticStage: 'runtime' as const,
              trace: empty,
              ...javaPreparedExecutionMetadata(entry),
            };
          }
        }
        return {
          ...entry,
          events,
          trace,
          ...javaPreparedExecutionMetadata(entry),
        };
      }
    );
  }

  async disposePreparedRuntimeProgram(programId: string): Promise<void> {
    if (!this.core.isWorkerRunning) return;
    await this.core.sendMessage<{ success: boolean }>(
      'dispose-prepared-runtime-program',
      { programId },
      MESSAGE_TIMEOUT_MS
    );
  }

  async executeProjectJava(
    request: JavaWorkerProjectRequest,
    timeoutMs = EXECUTION_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal
  ): Promise<JavaWorkerProjectResult> {
    const {
      signal: _signal,
      onEvent: _requestOnEvent,
      kernelHttp,
      kernelSyscalls,
      kernelSignals,
      ...workerRequest
    } = request;
    const program = this.initGateEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.core.sendMessageEffect<JavaWorkerProjectResult>(
            'execute-project-java',
            {
              ...workerRequest,
              ...(this.options.projectUserAuthorityMode
                ? { projectUserAuthorityMode: this.options.projectUserAuthorityMode }
                : {}),
            },
            null,
            onEvent,
            kernelHttp,
            undefined,
            kernelSyscalls,
            kernelSignals
          ),
          timeoutMs
        )
      )
    );

    return this.core.runClientEffect(program, signal);
  }

  terminate(): void {
    this.core.closeSession();
  }
}
