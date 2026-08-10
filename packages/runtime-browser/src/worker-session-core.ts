/**
 * Generic Effect-based worker session core shared by browser worker clients.
 *
 * The core owns everything every client used to hand-roll separately:
 *
 * - the worker session as a scoped resource (`Scope`/`acquireRelease`), whose
 *   release finalizer is the single teardown path,
 * - the pending-message registry bridging `onmessage` into Effect,
 * - request/response with protocol-token correlation and per-message deadlines
 *   (`Effect.timeoutFail`), execution deadlines, and
 * - the Promise boundary (`runClientEffect`) that maps the caller's
 *   AbortSignal to fiber interruption and rethrows typed failures unwrapped.
 *
 * A client supplies a {@link WorkerSessionCoreConfig}: how to build its
 * worker, which preflights run per message type, and hooks for its
 * language-specific sub-protocols (kernel-HTTP, compiler relays, idle
 * timeouts). Domain methods (init/warmup/execute) live in the client and
 * compose the core's effects.
 */

// Subpath imports keep effect's optional modules (e.g. FastCheck -> fast-check)
// out of the bundled dist.
import * as Cause from 'effect/Cause';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Scope from 'effect/Scope';
import type {
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpResponse,
  RuntimeKernelSignalBridge,
  RuntimeKernelSyscallBridge,
  RuntimeProjectEngineLeaseController,
} from '@tracecode/runtime-contracts';
import type { KernelHttpSyncServerBridge } from './kernel-http-sync';
import type { BrowserWorkerLike } from './execution-host';
import { logRuntimeDiagnostic } from './runtime-diagnostics';
import {
  ExecutionAbortedError,
  ExecutionTimeoutError,
  isExecutionTimeoutError,
  WorkerCrashedError,
  WorkerReadyTimeoutError,
  WorkerReportedError,
  WorkerRequestTimeoutError,
  WorkerTerminatedError,
} from './worker-errors';
import { createWorkerProtocolToken } from './worker-protocol';

type MessageId = string;

export interface WorkerSessionPendingMessage {
  protocolToken: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: RuntimeCommandEventHandler;
  kernelHttp?: RuntimeKernelHttpBridge;
  kernelSyscalls?: RuntimeKernelSyscallBridge;
  httpListeners?: Map<string, RuntimeKernelHttpListenerHandle>;
  httpRequests?: Map<
    string,
    { resolve: (response: RuntimeKernelHttpResponse) => void; reject: (error: Error) => void }
  >;
  httpDispatchAbortControllers?: Map<string, AbortController>;
  httpServers?: Map<string, KernelHttpSyncServerBridge>;
}

export interface WorkerSessionMessage {
  id?: MessageId;
  requestId?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

/**
 * One spawned worker generation. Everything that must die together when the
 * worker is torn down hangs off this object; the scope's release finalizer is
 * the single teardown path (there is no other way to close a session).
 */
export interface WorkerSession {
  readonly worker: BrowserWorkerLike;
  readonly ready: {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  };
  readonly scope: Scope.CloseableScope;
}

export interface WorkerSessionCoreConfig {
  /** Human label for messages and tagged errors, e.g. 'Python'. */
  readonly runtimeLabel: string;
  /** Diagnostics identifiers. */
  readonly component: string;
  readonly runtime: string;
  readonly debug: boolean;
  readonly readyTimeoutMs: number;
  readonly defaultMessageTimeoutMs: number;
  isSupported(): boolean;
  /** Construct the worker (URL building, factory routing, worker options). */
  createWorker(): BrowserWorkerLike;
  /** Per-message-type preflights (asset checks); runs before the session is touched. */
  preflight?(type: string): Promise<void>;
  /**
   * Language-specific routing for correlated messages (kernel-HTTP, compiler
   * relays). Runs after token validation, before generic resolution; return
   * true when the message was consumed.
   */
  onCommandMessage?(commandId: string, type: string, payload: unknown, pending: WorkerSessionPendingMessage): boolean;
  /**
   * Routing for uncorrelated messages (idle timeouts, unsolicited events).
   * Return true when consumed.
   */
  onUnhandledMessage?(message: WorkerSessionMessage, session: WorkerSession): boolean;
  /** Decode a successful reply payload (e.g. restore transferred trace events). */
  decodeReply?(payload: unknown): unknown;
  /**
   * Close the session when the worker fires `onerror` (crash-implies-restart
   * runtimes). When false, in-flight work fails but the session stays open and
   * recovery remains the caller's retry policy.
   */
  closeSessionOnWorkerError?: boolean;
}

export class WorkerSessionCore {
  private session: WorkerSession | null = null;
  private engineLeaseTail: Promise<void> = Promise.resolve();
  readonly pendingMessages = new Map<MessageId, WorkerSessionPendingMessage>();
  private messageId = 0;
  /** Runs when a session closes (with the close reason), before pending rejection; clients clear memos here. */
  onSessionClosed?: (reason: Error) => void;

  constructor(private readonly config: WorkerSessionCoreConfig) {}

  get currentSession(): WorkerSession | null {
    return this.session;
  }

  get isWorkerRunning(): boolean {
    return this.session !== null;
  }

  /**
   * Bind this reusable worker generation to one TraceKernel process.
   *
   * The attachment is host-only. TraceKernel asks the client to prove that
   * the request registry is empty and that the same ready worker generation
   * is still alive before it may issue a reuse disposition. Every other
   * disposition closes the session through its scoped finalizer.
   */
  async acquireReusableEngineLease(controller: RuntimeProjectEngineLeaseController): Promise<void> {
    const predecessor = this.engineLeaseTail;
    let releaseTurn!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.engineLeaseTail = predecessor
      .catch(() => undefined)
      .then(() => releaseGate);
    await predecessor.catch(() => undefined);

    let validatedSession: WorkerSession | null = null;
    try {
      controller.attach({
        revalidate: async () => {
          const session = this.session;
          if (!session) {
            throw new Error(`${this.config.runtimeLabel} worker is not running after execution.`);
          }
          if (this.pendingMessages.size !== 0) {
            throw new Error(
              `${this.config.runtimeLabel} worker still owns ${this.pendingMessages.size} pending request(s).`
            );
          }
          await session.ready.promise;
          if (this.session !== session) {
            throw new Error(`${this.config.runtimeLabel} worker generation changed during revalidation.`);
          }
          validatedSession = session;
        },
        release: (disposition) => {
          try {
            if (disposition.kind === 'reuse') return;
            if (validatedSession && this.session !== validatedSession) return;
            this.closeSession(
              new WorkerTerminatedError(
                `${this.config.runtimeLabel} engine lease destroyed: ${disposition.reason}`
              )
            );
          } finally {
            releaseTurn();
          }
        },
      });
    } catch (error) {
      releaseTurn();
      throw error;
    }
  }

  /**
   * Get or lazily create the current worker session.
   *
   * Acquisition and release are declared together: `Effect.acquireRelease`
   * registers the teardown checklist into the session's scope at the moment
   * the worker is spawned, so a session can never exist without its cleanup.
   * Spawning is fully synchronous, which is what makes `runSync` safe here.
   */
  getOrCreateSession(): WorkerSession {
    if (this.session) return this.session;

    if (!this.config.isSupported()) {
      throw new Error('Web Workers are not supported in this environment');
    }

    const scope = Effect.runSync(Scope.make());
    const session = Effect.runSync(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(() => this.spawnSession(scope)),
          (acquired, exit) => Effect.sync(() => this.releaseSession(acquired, exit))
        ),
        scope
      )
    );
    this.session = session;
    return session;
  }

  private spawnSession(scope: Scope.CloseableScope): WorkerSession {
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // A session torn down before (or without) a waiter must not surface an
    // unhandled rejection; waiters attach their own handlers.
    readyPromise.catch(() => undefined);

    const worker = this.config.createWorker();

    const session: WorkerSession = {
      worker,
      ready: { promise: readyPromise, resolve: readyResolve, reject: readyReject },
      scope,
    };

    worker.onmessage = (event: MessageEvent<WorkerSessionMessage>) => {
      const { id, type, payload, protocolToken } = event.data;

      if (type === 'worker-ready') {
        session.ready.resolve();
        logRuntimeDiagnostic('info', {
          component: this.config.component,
          runtime: this.config.runtime,
          phase: 'worker-ready',
          message: `${this.config.runtimeLabel} worker is ready.`,
        }, { enabled: this.config.debug });
        return;
      }

      if (!id) {
        if (this.config.onUnhandledMessage?.(event.data, session)) return;
        logRuntimeDiagnostic('debug', {
          component: this.config.component,
          runtime: this.config.runtime,
          phase: 'worker-event',
          message: `${this.config.runtimeLabel} worker emitted an unsolicited event.`,
          detail: { type, payload },
        }, { enabled: this.config.debug });
        return;
      }

      const pending = this.pendingMessages.get(id);
      if (!pending) {
        this.config.onUnhandledMessage?.(event.data, session);
        return;
      }
      if (protocolToken !== pending.protocolToken) return;
      if (type === 'project-event') {
        pending.onEvent?.(payload as RuntimeCommandEvent);
        return;
      }
      if (this.config.onCommandMessage?.(id, type, payload, pending)) return;

      this.pendingMessages.delete(id);

      if (type === 'error') {
        pending.reject(new WorkerReportedError({ workerMessage: (payload as { error: string }).error }));
        return;
      }
      logRuntimeDiagnostic('debug', {
        component: this.config.component,
        runtime: this.config.runtime,
        phase: 'worker-response',
        message: `${this.config.runtimeLabel} worker response received.`,
        detail: { id, type },
      }, { enabled: this.config.debug });
      try {
        pending.resolve(this.config.decodeReply ? this.config.decodeReply(payload) : payload);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    worker.onerror = (error) => {
      logRuntimeDiagnostic('error', {
        component: this.config.component,
        runtime: this.config.runtime,
        phase: 'worker-error',
        message: `${this.config.runtimeLabel} worker emitted an error event.`,
        detail: {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        },
      });
      const workerError = new WorkerCrashedError({
        workerMessage: error.message,
        filename: error.filename,
        lineno: error.lineno,
        colno: error.colno,
      });
      session.ready.reject(workerError);
      this.rejectAllPending(workerError);
      // Whether an error event also implies teardown is per-runtime policy:
      // some runtimes fail in-flight work but keep the session for retry.
      if (this.config.closeSessionOnWorkerError) {
        this.closeSession(workerError);
      }
    };

    return session;
  }

  /**
   * The release finalizer: the entire teardown checklist, in one place, with
   * the teardown reason carried by the scope's closing Exit.
   */
  private releaseSession(session: WorkerSession, exit: Exit.Exit<unknown, unknown>): void {
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    const reason =
      Option.isSome(failure) && failure.value instanceof Error
        ? failure.value
        : new WorkerTerminatedError();

    session.ready.reject(reason);
    session.worker.terminate();
    this.onSessionClosed?.(reason);
    this.rejectAllPending(reason);
  }

  private rejectAllPending(reason: Error): void {
    for (const [, pending] of this.pendingMessages) {
      this.cleanupPending?.(pending);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }

  /** Optional per-pending cleanup (e.g. kernel-HTTP teardown) run before rejection/interrupt removal. */
  cleanupPending?: (pending: WorkerSessionPendingMessage) => void;

  /** Close the current session (if any), running its finalizers exactly once. */
  closeSession(reason: Error = new WorkerTerminatedError()): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    Effect.runSync(Scope.close(session.scope, Exit.fail(reason)));
  }

  /** Post a raw correlated message on the current session (sub-protocol relays). */
  postCommandMessage(commandId: string, type: string, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    this.session?.worker.postMessage({
      id: commandId,
      type,
      payload,
      protocolToken: pending.protocolToken,
    });
  }

  /**
   * Wait for the session's bootstrap signal with timeout.
   * Guards against deadlocks when the worker script fails before posting "worker-ready".
   */
  private awaitSessionReady(session: WorkerSession): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => session.ready.promise,
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(this.config.readyTimeoutMs),
        onTimeout: () =>
          new WorkerReadyTimeoutError({
            runtimeLabel: this.config.runtimeLabel,
            timeoutMs: this.config.readyTimeoutMs,
          }),
      }),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!(error instanceof WorkerReadyTimeoutError)) return;
          logRuntimeDiagnostic('warn', {
            component: this.config.component,
            runtime: this.config.runtime,
            phase: 'worker-ready-timeout',
            message: `${this.config.runtimeLabel} worker did not send worker-ready before the timeout.`,
            detail: { timeoutMs: this.config.readyTimeoutMs },
          }, { enabled: this.config.debug });
          this.closeSession(error);
        })
      )
    );
  }

  /**
   * Send a message to the worker and wait for a response, as an Effect.
   *
   * The request/response registry bridges the callback world of `onmessage`
   * into the Effect world: worker handlers complete the request via `resume`,
   * and the returned cleanup runs on interruption (deadline or abort), when
   * the reply can no longer be delivered.
   */
  sendMessageEffect<T>(
    type: string,
    payload?: unknown,
    /** Per-message deadline; `null` when an enclosing execution deadline governs instead. */
    timeoutMs: number | null = this.config.defaultMessageTimeoutMs,
    onEvent?: RuntimeCommandEventHandler,
    kernelHttp?: RuntimeKernelHttpBridge,
    validateLifecycle?: () => void,
    kernelSyscalls?: RuntimeKernelSyscallBridge,
    kernelSignals?: RuntimeKernelSignalBridge
  ): Effect.Effect<T, Error> {
    return Effect.gen(this, function* () {
      yield* Effect.try({
        try: () => validateLifecycle?.(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      yield* Effect.tryPromise({
        try: () => this.config.preflight?.(type) ?? Promise.resolve(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      yield* Effect.try({
        try: () => validateLifecycle?.(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });

      const session = yield* Effect.try({
        try: () => this.getOrCreateSession(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });

      yield* this.awaitSessionReady(session);
      yield* Effect.try({
        try: () => validateLifecycle?.(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });

      const reply = this.postAndAwaitReply<T>(
        session.worker,
        type,
        payload,
        onEvent,
        kernelHttp,
        kernelSyscalls,
        kernelSignals
      );
      if (timeoutMs === null) {
        return yield* reply;
      }
      return yield* reply.pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new WorkerRequestTimeoutError({ messageType: type, timeoutMs }),
        }),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (!(error instanceof WorkerRequestTimeoutError)) return;
            logRuntimeDiagnostic('warn', {
              component: this.config.component,
              runtime: this.config.runtime,
              phase: 'worker-request-timeout',
              message: `${this.config.runtimeLabel} worker request timed out.`,
              detail: { type, timeoutMs },
            }, { enabled: this.config.debug });
          })
        )
      );
    });
  }

  private postAndAwaitReply<T>(
    worker: BrowserWorkerLike,
    type: string,
    payload?: unknown,
    onEvent?: RuntimeCommandEventHandler,
    kernelHttp?: RuntimeKernelHttpBridge,
    kernelSyscalls?: RuntimeKernelSyscallBridge,
    kernelSignals?: RuntimeKernelSignalBridge
  ): Effect.Effect<T, Error> {
    return Effect.async<T, Error>((resume) => {
      const id = String(++this.messageId);
      const protocolToken = createWorkerProtocolToken();

      this.pendingMessages.set(id, {
        protocolToken,
        resolve: (value) => resume(Effect.succeed(value as T)),
        reject: (error) => resume(Effect.fail(error)),
        ...(onEvent ? { onEvent } : {}),
        ...(kernelHttp ? { kernelHttp } : {}),
        ...(kernelSyscalls ? { kernelSyscalls } : {}),
        httpListeners: new Map(),
        httpRequests: new Map(),
        httpDispatchAbortControllers: new Map(),
        httpServers: new Map(),
      });

      logRuntimeDiagnostic('debug', {
        component: this.config.component,
        runtime: this.config.runtime,
        phase: 'worker-request',
        message: `Sending request to ${this.config.runtimeLabel} worker.`,
        detail: { id, type },
      }, { enabled: this.config.debug });

      try {
        worker.postMessage({
          id,
          type,
          payload,
          protocolToken,
          ...(kernelSyscalls
            ? {
                kernelSyscallChannel: kernelSyscalls.channel,
                ...(kernelSyscalls.generationBuffer
                  ? {
                      kernelSyscallGenerationBuffer:
                        kernelSyscalls.generationBuffer,
                    }
                  : {}),
              }
            : {}),
          ...(kernelSignals
            ? { kernelSignalMailbox: kernelSignals.mailbox }
            : {}),
        });
      } catch (error) {
        const entry = this.pendingMessages.get(id);
        if (entry) {
          this.pendingMessages.delete(id);
          this.cleanupPending?.(entry);
        }
        resume(Effect.fail(error instanceof Error ? error : new Error(String(error))));
      }

      // Interruption cleanup: the reply is unwanted now, so drop the
      // registration and tear down any sub-protocol state it accumulated.
      return Effect.sync(() => {
        const entry = this.pendingMessages.get(id);
        if (!entry) return;
        this.pendingMessages.delete(id);
        this.cleanupPending?.(entry);
      });
    });
  }

  /** Promise-facing send for call sites outside the Effect core (init/warmup/status). */
  sendMessage<T>(
    type: string,
    payload?: unknown,
    timeoutMs: number | null = this.config.defaultMessageTimeoutMs,
    onEvent?: RuntimeCommandEventHandler,
    kernelHttp?: RuntimeKernelHttpBridge,
    validateLifecycle?: () => void,
    kernelSyscalls?: RuntimeKernelSyscallBridge,
    kernelSignals?: RuntimeKernelSignalBridge
  ): Promise<T> {
    return this.runClientEffect(
      this.sendMessageEffect<T>(
        type,
        payload,
        timeoutMs,
        onEvent,
        kernelHttp,
        validateLifecycle,
        kernelSyscalls,
        kernelSignals
      )
    );
  }

  /**
   * Impose the execution wall-clock deadline. On a trip, the worker is presumed
   * stuck: there is no in-worker cancellation, so the whole worker is torn down.
   */
  withExecutionDeadline<A>(effect: Effect.Effect<A, Error>, timeoutMs: number): Effect.Effect<A, Error> {
    return effect.pipe(
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () => new ExecutionTimeoutError({ timeoutMs, runtimeLabel: this.executionTimeoutLabel }),
      }),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!isExecutionTimeoutError(error)) return;
          logRuntimeDiagnostic('warn', {
            component: this.config.component,
            runtime: this.config.runtime,
            phase: 'execution-timeout',
            message: `${this.config.runtimeLabel} execution timed out; terminating worker.`,
            detail: { timeoutMs },
          }, { enabled: this.config.debug });
          this.closeSession();
        })
      )
    );
  }

  /** Label used on ExecutionTimeoutError; undefined keeps the generic message. */
  executionTimeoutLabel: string | undefined;

  /**
   * The single boundary between the Effect core and the Promise-facing API.
   *
   * - The caller's AbortSignal becomes fiber interruption; interruption keeps
   *   the legacy contract (worker torn down, callers see an AbortError).
   * - Typed failures are rethrown as-is so `instanceof` classification keeps
   *   working across the boundary; defects surface unwrapped.
   */
  runClientEffect<A>(effect: Effect.Effect<A, Error>, signal?: AbortSignal): Promise<A> {
    const interruptionError = (): Error => signal?.aborted
      ? new ExecutionAbortedError()
      : new WorkerTerminatedError('Worker execution was interrupted internally');
    const program = effect.pipe(
      Effect.onInterrupt(() => Effect.sync(() => this.closeSession(interruptionError())))
    );
    return Effect.runPromiseExit(program, signal ? { signal } : undefined).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) throw failure.value;
      if (Cause.isInterruptedOnly(exit.cause)) throw interruptionError();
      throw Cause.squash(exit.cause);
    });
  }
}
