/**
 * C# Worker Client
 *
 * Session lifecycle, request/response, deadlines, and the Promise boundary
 * live in the shared WorkerSessionCore; this file owns C#-specific concerns:
 * worker construction, asset preflights, idle-timeout handling, runtime-load
 * retry policy, request-timeout teardown policy, kernel-HTTP wiring, result
 * mapping, and trace assembly.
 */

import * as Effect from 'effect/Effect';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  withRuntimeTraceOptions,
  type RuntimeTrace,
  type RuntimeTraceEvent,
} from '@tracecode/harness-core';
import type { ExecutionLimitReason, RuntimeBatchCall, RuntimeCodeCall, RuntimeTraceCall } from '@tracecode/harness-core';
import { liftCodeBatchOutcome, liftTraceOutcome, type RawExecutionBatchPayload } from '@tracecode/harness-core';
import type {
  CodeExecutionResult,
  CodeExecutionBatchResult,
  ExecutionResult,
  RuntimeExecutionTimings,
} from '@tracecode/harness-core';
import type {
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeKernelSyscallBridge,
  RuntimeProjectCommandRequest,
  RuntimeProjectEngineLeaseController,
} from '@tracecode/harness-core';
import { isDevEnvironment } from './browser-client-env';
import {
  cleanupAsyncKernelHttp,
  handleAsyncKernelHttpProtocolMessage,
  type AsyncKernelHttpHost,
} from './kernel-http-async';
import { logRuntimeDiagnostic } from './runtime-diagnostics';
import type { BrowserWorkerFactory, BrowserWorkerLike } from './execution-host';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from './trace-event-transport';
import {
  ExecutionTimeoutError,
  WorkerCrashedError,
  WorkerReadyTimeoutError,
  WorkerReportedError,
  WorkerRequestTimeoutError,
  WorkerTerminatedError,
} from './worker-errors';
import { WorkerSessionCore } from './worker-session-core';
import type { WorkerSessionMessage } from './worker-session-core';
import { handleHostArtifactCacheRequest, HostArtifactCache } from './host-artifact-cache';

export type CSharpExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export interface CSharpWorkerClientOptions {
  workerUrl: string;
  workerFactory?: BrowserWorkerFactory;
  assetBaseUrl: string;
  debug?: boolean;
  initTimeoutMs?: number;
  executionTimeoutMs?: number;
  tracingTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  assetPreflight?: () => Promise<void>;
  runtimeAssetPreflight?: () => Promise<void>;
  /** Permanent mode is only safe when this worker is retired after its project command. */
  projectUserAuthorityMode?: 'temporary' | 'permanent';
  /** Declared runtime files preflighted by the browser harness; dotnet still resolves them from assetBaseUrl. */
  runtimeDependencies?: Readonly<Record<string, string>>;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
  timings?: RuntimeExecutionTimings;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
  error?: string;
  timings?: RuntimeExecutionTimings;
}

const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 45_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const CSHARP_DEFAULT_FILE = 'solution.cs';
const CSHARP_LEGACY_USER_FILE = 'UserCode.cs';
const CSHARP_HOST_ARTIFACT_CACHE_MAX_ENTRIES = 24;
const CSHARP_HOST_ARTIFACT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

const KERNEL_HTTP_MESSAGE_TYPES = new Set([
  'kernel-http-listen',
  'kernel-http-close',
  'kernel-http-response',
  'kernel-http-dispatch',
  'kernel-http-abort-dispatch',
  'kernel-http-error',
]);

export interface CSharpDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: string;
  id?: string;
}

export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CSharpProjectCommandResult = RuntimeCommandResult;

interface CSharpWorkerExecuteResult {
  success: boolean;
  output?: unknown;
  error?: string;
  diagnostics?: CSharpDiagnostic[];
  consoleOutput?: string[];
  events?: RuntimeTraceEvent[];
  executionTimeMs?: number;
  traceLimitExceeded?: boolean;
  timeoutReason?: ExecutionLimitReason;
  timings?: RuntimeExecutionTimings;
}

function isCSharpUserFile(file: string | undefined): boolean {
  return Boolean(file?.endsWith(CSHARP_DEFAULT_FILE) || file?.endsWith(CSHARP_LEGACY_USER_FILE));
}

function isCSharpUserDiagnostic(diagnostic: CSharpDiagnostic): boolean {
  return isCSharpUserFile(diagnostic.file);
}

function normalizeCSharpTraceEventFile(event: RuntimeTraceEvent): RuntimeTraceEvent {
  return isCSharpUserFile(event.file) ? { ...event, file: CSHARP_DEFAULT_FILE } : event;
}

export class CSharpWorkerClient {
  private httpRequestId = 0;
  private readonly kernelHttpHost: AsyncKernelHttpHost = {
    runtimeLabel: 'C#',
    getPending: (commandId) => this.core.pendingMessages.get(commandId),
    postWorkerMessage: (commandId, type, payload) => this.core.postCommandMessage(commandId, type, payload),
    isWorkerRunning: () => this.core.isWorkerRunning,
    nextHttpRequestId: () => ++this.httpRequestId,
  };
  /** Memoized runtime-load results for the current session; cleared by the session finalizer. */
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private readonly debug: boolean;
  private readonly initTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly tracingTimeoutMs: number;
  private readonly core: WorkerSessionCore;
  private readonly artifactCache = new HostArtifactCache(
    CSHARP_HOST_ARTIFACT_CACHE_MAX_ENTRIES,
    CSHARP_HOST_ARTIFACT_CACHE_MAX_BYTES
  );

  constructor(private readonly options: CSharpWorkerClientOptions) {
    this.debug = options.debug ?? isDevEnvironment();
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    this.tracingTimeoutMs = options.tracingTimeoutMs ?? TRACING_TIMEOUT_MS;

    this.core = new WorkerSessionCore({
      runtimeLabel: 'C#',
      component: 'CSharpWorkerClient',
      runtime: 'csharp',
      debug: this.debug,
      readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
      defaultMessageTimeoutMs: MESSAGE_TIMEOUT_MS,
      isSupported: () => this.isSupported(),
      createWorker: () => this.createWorker(),
      preflight: async (type) => {
        await this.options.assetPreflight?.();
        if (type !== 'init' && type !== 'status') {
          await this.options.runtimeAssetPreflight?.();
        }
      },
      onCommandMessage: (commandId, type, payload, pending) => {
        if (type === 'kernel-syscall') {
          if (!pending.kernelSyscalls) return true;
          void pending.kernelSyscalls.service().catch(() => {
            pending.kernelSyscalls?.close();
          });
          return true;
        }
        if (!KERNEL_HTTP_MESSAGE_TYPES.has(type)) return false;
        handleAsyncKernelHttpProtocolMessage(this.kernelHttpHost, commandId, type, payload);
        return true;
      },
      onUnhandledMessage: (message, session) => {
        if (message.type === 'compiler-artifact-cache-request') {
          this.handleArtifactCacheRequest(message, session.worker);
          return true;
        }
        if (message.type !== 'idle-timeout') return false;
        logRuntimeDiagnostic('info', {
          component: 'CSharpWorkerClient',
          runtime: 'csharp',
          phase: 'idle-timeout',
          message: 'C# worker closed after idle timeout.',
        }, { enabled: this.debug });
        this.core.closeSession(new WorkerTerminatedError('C# worker closed after idle timeout'));
        return true;
      },
      decodeReply: (payload) => restoreTransferredTraceEvents(payload),
      // The dotnet runtime does not survive script errors; a crashed worker is
      // torn down and lazily respawned on the next request.
      closeSessionOnWorkerError: true,
    });
    this.core.executionTimeoutLabel = 'C#';
    this.core.cleanupPending = (pending) => cleanupAsyncKernelHttp(pending, 'C#');
    this.core.onSessionClosed = () => {
      this.initPromise = null;
      this.warmupPromise = null;
    };
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
      ? this.options.workerFactory(workerUrl, { type: 'module' })
      : new Worker(workerUrl, { type: 'module' });
  }

  private hasPendingProtocolToken(protocolToken: unknown): protocolToken is string {
    return typeof protocolToken === 'string' &&
      Array.from(this.core.pendingMessages.values()).some((pending) => pending.protocolToken === protocolToken);
  }

  private handleArtifactCacheRequest(message: WorkerSessionMessage, worker: BrowserWorkerLike): void {
    handleHostArtifactCacheRequest({
      cache: this.artifactCache,
      message,
      worker,
      validateProtocolToken: (protocolToken) => this.hasPendingProtocolToken(protocolToken),
    });
  }

  /**
   * A C# worker that misses a request deadline is presumed stuck (dotnet has
   * no in-worker cancellation), so request timeouts also tear the session down.
   */
  private sendCommandEffect<T>(
    type: string,
    payload?: unknown,
    timeoutMs: number | null = MESSAGE_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    kernelHttp?: RuntimeKernelHttpBridge,
    kernelSyscalls?: RuntimeKernelSyscallBridge
  ): Effect.Effect<T, Error> {
    return this.core.sendMessageEffect<T>(
      type,
      payload,
      timeoutMs,
      onEvent,
      kernelHttp,
      undefined,
      kernelSyscalls
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error instanceof WorkerRequestTimeoutError) this.core.closeSession(error);
        })
      )
    );
  }

  /** Runtime-load failures that warrant a worker reset + one retry. */
  private shouldResetRuntimeLoadError(error: unknown): boolean {
    if (
      error instanceof WorkerRequestTimeoutError ||
      error instanceof WorkerTerminatedError ||
      error instanceof WorkerCrashedError ||
      error instanceof WorkerReadyTimeoutError
    ) {
      return true;
    }
    // Worker-reported load failures arrive as prose from the dotnet loader;
    // fetch failures are the one retryable class we recognize by text.
    return error instanceof WorkerReportedError && (
      error.message.includes('Failed to fetch') || error.message.includes('timed out')
    );
  }

  private workerOptionsPayload(): {
    idleTimeoutMs?: number;
    runtimeDependencies?: Readonly<Record<string, string>>;
  } {
    return {
      ...(this.options.workerIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.options.workerIdleTimeoutMs }),
      ...(this.options.runtimeDependencies
        ? { runtimeDependencies: this.options.runtimeDependencies }
        : {}),
    };
  }

  /**
   * The init program: one attempt, and on a runtime-load failure, reset the
   * session and run the same description once more.
   */
  private initEffect(): Effect.Effect<InitResult, Error> {
    const attempt = this.sendCommandEffect<InitResult>(
      'init',
      { assetBaseUrl: this.options.assetBaseUrl, ...this.workerOptionsPayload() },
      this.initTimeoutMs
    );
    return attempt.pipe(
      Effect.catchIf(
        (error): error is Error => this.shouldResetRuntimeLoadError(error),
        (error) =>
          Effect.suspend(() => {
            logRuntimeDiagnostic('warn', {
              component: 'CSharpWorkerClient',
              runtime: 'csharp',
              phase: 'init-retry',
              message: 'C# worker init failed; resetting worker and retrying once.',
              detail: { message: error.message },
            }, { enabled: this.debug });
            this.core.closeSession();
            return attempt;
          })
      )
    );
  }

  async init(): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;

    const promise = this.core.runClientEffect(this.initEffect());
    this.initPromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.initPromise === promise) this.initPromise = null;
      throw error;
    }
  }

  async warmup(): Promise<WarmupResult> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      try {
        await this.init();
        return await this.core.runClientEffect(
          this.sendCommandEffect<WarmupResult>(
            'warmup',
            { assetBaseUrl: this.options.assetBaseUrl, ...this.workerOptionsPayload() },
            this.initTimeoutMs
          )
        );
      } catch (error) {
        const warmupError = error instanceof Error ? error : new Error(String(error));
        this.warmupPromise = null;
        if (this.shouldResetRuntimeLoadError(warmupError)) this.core.closeSession(warmupError);
        throw warmupError;
      }
    })();
    return this.warmupPromise;
  }

  /** Runtime load ahead of an execution. Memoization stays Promise-based on the client. */
  private warmupEffect(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.warmup().then(() => undefined),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    const { code, functionName, inputs, executionStyle = 'solution-method', signal, limits } = call;
    const wallClockMs = limits?.wallClockMs ?? this.executionTimeoutMs;
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.sendCommandEffect<CSharpWorkerExecuteResult>('execute-code', {
            code,
            functionName,
            inputs,
            executionStyle,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, wallClockMs - 1_000),
            ...this.workerOptionsPayload(),
          }, null), // the enclosing execution deadline is the only clock
          wallClockMs
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);

    if (!result.success) {
      if (result.timeoutReason) {
        return {
          kind: 'limit',
          reason: result.timeoutReason,
          error: result.error ?? 'C# execution failed',
          consoleOutput: result.consoleOutput ?? [],
          timings: result.timings,
        };
      }
      const firstUserDiagnostic = result.diagnostics?.find(isCSharpUserDiagnostic);
      return {
        kind: 'failed',
        error: result.error ?? 'C# execution failed',
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }

    return {
      kind: 'completed',
      output: result.output ?? null,
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

  async executeCodeBatch(call: RuntimeBatchCall): Promise<CodeExecutionBatchResult> {
    const { code, functionName, inputBatch, executionStyle = 'solution-method', signal } = call;
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.sendCommandEffect<RawExecutionBatchPayload>('execute-code-batch', {
            code,
            functionName,
            inputBatch,
            executionStyle,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, this.executionTimeoutMs - 1_000),
            ...this.workerOptionsPayload(),
          }, null),
          this.executionTimeoutMs
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);

    return liftCodeBatchOutcome(result, 'C# execution failed');
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    const { code, inputs, traceOptions, executionStyle = 'solution-method', signal } = call;
    const functionName = call.functionName ?? '';
    let result: CSharpWorkerExecuteResult;
    const tracingTimeoutMs = this.resolveTracingTimeoutMs(functionName, executionStyle);
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.sendCommandEffect<CSharpWorkerExecuteResult>('execute-with-tracing', {
            code,
            functionName,
            inputs,
            executionStyle,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, tracingTimeoutMs - 1_000),
            maxTraceSteps: traceOptions?.maxTraceSteps,
            maxLineEvents: traceOptions?.maxLineEvents,
            maxSingleLineHits: traceOptions?.maxSingleLineHits,
            maxStoredEvents: traceOptions?.maxStoredEvents,
            maxPathDepth: traceOptions?.maxPathDepth,
            minimalTrace: traceOptions?.minimalTrace,
            traceEventTransport: traceEventTransferRequest(),
            ...this.workerOptionsPayload(),
          }, null),
          tracingTimeoutMs
        )
      )
    );

    try {
      result = await this.core.runClientEffect(program, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const trace = this.createTrace([
        {
          kind: 'timeout',
          runId: 'csharp:run',
          file: CSHARP_DEFAULT_FILE,
          message,
        },
      ]);
      return {
        kind: 'limit',
        reason: 'client-timeout',
        error: message,
        trace,
        executionTimeMs: tracingTimeoutMs,
        consoleOutput: [],
        timings: { totalMs: tracingTimeoutMs },
      };
    }

    const consoleOutput = result.consoleOutput ?? [];
    const hostEmittedStdout = result.events?.some((event) => event.kind === 'stdout') === true;
    const events = [
      ...(result.events ?? []),
      ...(hostEmittedStdout
        ? []
        : consoleOutput.map((text): RuntimeTraceEvent => ({
            kind: 'stdout',
            runId: 'csharp:run',
            file: CSHARP_DEFAULT_FILE,
            text,
          }))),
    ];
    const trace = this.createTrace(events, { maxPathDepth: traceOptions?.maxPathDepth });

    const firstUserDiagnostic = result.diagnostics?.find(isCSharpUserDiagnostic);
    return liftTraceOutcome(
      {
        ...result,
        consoleOutput,
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
      },
      trace,
      'C# execution failed'
    );
  }

  async executeProjectCSharp(
    request: CSharpProjectCommandRequest,
    timeoutMs = this.executionTimeoutMs,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal,
    engineLease?: RuntimeProjectEngineLeaseController
  ): Promise<CSharpProjectCommandResult> {
    if (engineLease) await this.core.acquireReusableEngineLease(engineLease);
    const {
      signal: _signal,
      onEvent: _requestOnEvent,
      engineLease: _engineLease,
      kernelHttp,
      kernelSyscalls,
      ...workerRequest
    } = request;
    const program = this.warmupEffect().pipe(
      Effect.andThen(
        this.core.withExecutionDeadline(
          this.sendCommandEffect<CSharpProjectCommandResult>(
            'execute-project-csharp',
            {
              ...workerRequest,
              assetBaseUrl: this.options.assetBaseUrl,
              timeoutMs: Math.max(100, timeoutMs - 1_000),
              ...(this.options.projectUserAuthorityMode
                ? { projectUserAuthorityMode: this.options.projectUserAuthorityMode }
                : {}),
              ...this.workerOptionsPayload(),
            },
            null,
            onEvent,
            kernelHttp,
            kernelSyscalls
          ),
          timeoutMs
        )
      )
    );

    return this.core.runClientEffect(program, signal);
  }

  private createTrace(events: RuntimeTraceEvent[], options: { maxPathDepth?: number } = {}): RuntimeTrace {
    return withRuntimeTraceOptions({
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'csharp',
      runId: 'csharp:run',
      events: events.map(normalizeCSharpTraceEventFile),
      lineEventCount: events.filter((event) => event.kind === 'line').length,
      traceStepCount: events.length,
    }, options);
  }

  private resolveTracingTimeoutMs(functionName: string, executionStyle: CSharpExecutionStyle): number {
    void functionName;
    void executionStyle;
    return this.tracingTimeoutMs;
  }

  terminate(): void {
    this.core.closeSession();
  }
}
