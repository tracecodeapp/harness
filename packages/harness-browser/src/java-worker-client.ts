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
import type { CodeExecutionBatchResult, CodeExecutionResult, RuntimeBatchCall, RuntimeCodeCall, RuntimeExecutionTimings, RuntimeTraceCall } from '@tracecode/harness-core';
import { liftCodeBatchOutcome, liftCodeOutcome, type RawExecutionBatchPayload } from '@tracecode/harness-core';
import type {
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeProjectCommandRequest,
} from '@tracecode/harness-core';
import { javaTraceHooksEventsToRuntimeTrace } from '@tracecode/harness-core';
import { createEmptyRuntimeTrace, type RuntimeTrace } from '@tracecode/harness-core';
import {
  closeKernelHttpSyncServers,
  handleKernelHttpCloseMessage,
  handleKernelHttpDispatchSyncMessage,
  handleKernelHttpListenSyncMessage,
} from './kernel-http-sync';
import { logRuntimeDiagnostic } from './runtime-diagnostics';
import { restoreTransferredTraceEvents, traceEventTransferRequest } from './trace-event-transport';
import { isDevEnvironment } from './browser-client-env';
import {
  WorkerCrashedError,
  WorkerReadyTimeoutError,
  WorkerRequestTimeoutError,
  WorkerTerminatedError,
} from './worker-errors';
import { WorkerSessionCore, type WorkerSessionMessage } from './worker-session-core';
import type { BrowserWorkerFactory, BrowserWorkerLike } from './execution-host';
import { handleHostArtifactCacheRequest, HostArtifactCache } from './host-artifact-cache';

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
  /** Default-off VM diagnostics used by compatibility/performance campaigns. */
  bytecodeProfile?: unknown;
  diagnosticError?: string;
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
  private activeExternalCompileControllers = new Set<AbortController>();
  private readonly debug: boolean;
  private readonly core: WorkerSessionCore;
  private readonly artifactCache: HostArtifactCache;

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
      this.initPromise = null;
      this.warmupPromise = null;
      for (const controller of this.activeExternalCompileControllers) {
        controller.abort();
      }
      this.activeExternalCompileControllers.clear();
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
  private shouldResetRuntimeLoadError(error: unknown): boolean {
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
  private initEffect(): Effect.Effect<InitResult, Error> {
    const attempt = this.core.sendMessageEffect<InitResult>('init', this.workerOptionsPayload(), INIT_TIMEOUT_MS);
    return attempt.pipe(
      Effect.catchIf(
        (error): error is Error => this.shouldResetRuntimeLoadError(error),
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

  /** Clears CheerpJ's persistent learner-addressable filesystem before a safe execution. */
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
          }, null), // the enclosing execution deadline is the only clock
          Number.isFinite(this.options.tracingTimeoutMs) && Number(this.options.tracingTimeoutMs) > 0
            ? Math.floor(Number(this.options.tracingTimeoutMs))
            : TRACING_TIMEOUT_MS
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);
    return {
      ...result,
      trace: result.success
        ? javaTraceHooksEventsToRuntimeTrace(result.events, result.sourceText, {
            runId: 'java:run',
            file: JAVA_DEFAULT_FILE,
            maxPathDepth: traceOptions?.maxPathDepth,
          })
        : createEmptyRuntimeTrace('java', { runId: 'java:run', file: JAVA_DEFAULT_FILE }),
    };
  }

  async executeCode(call: RuntimeCodeCall & { traceOptions?: JavaTraceExecutionOptions }): Promise<CodeExecutionResult> {
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
          }, null),
          wallClockMs
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);
    return liftCodeOutcome(result, 'Java execution failed');
  }

  async executeCodeBatch(call: RuntimeBatchCall & { traceOptions?: JavaTraceExecutionOptions }): Promise<CodeExecutionBatchResult> {
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
          }, null),
          EXECUTION_TIMEOUT_MS
        )
      )
    );

    const result = await this.core.runClientEffect(program, signal);
    return liftCodeBatchOutcome(result, 'Java execution failed');
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
