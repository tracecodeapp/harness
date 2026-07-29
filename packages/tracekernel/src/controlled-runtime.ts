import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import type {
  TraceKernelRuntimeLease,
  TraceKernelRuntimeLeaseReleaseDisposition,
  TraceKernelRuntimeProcessContext,
  TraceKernelRuntimeProvider,
  TraceKernelRuntimeResult,
  TraceKernelSignal,
} from './model';

type CatchableTraceKernelSignal = Exclude<TraceKernelSignal, 'SIGKILL'>;

export type TraceKernelControlledRuntimeSignalHandler = (
  signal: CatchableTraceKernelSignal
) => Promise<void> | void;

export interface TraceKernelControlledRuntimeLeaseHandler {
  revalidate?(): Promise<void> | void;
  release(
    disposition: TraceKernelRuntimeLeaseReleaseDisposition
  ): Promise<void> | void;
}

interface TraceKernelControlledRuntimeEntry {
  readonly context: TraceKernelRuntimeProcessContext;
  readonly completion: Deferred.Deferred<TraceKernelRuntimeResult, Error>;
  signalHandler?: TraceKernelControlledRuntimeSignalHandler;
  leaseHandler?: TraceKernelControlledRuntimeLeaseHandler;
}

/**
 * Runtime provider for execution engines whose event loop is owned by a host
 * integration rather than by TraceKernel itself.
 *
 * TraceKernel still owns PID allocation, process topology, descriptors,
 * signals, interruption, and lease cleanup. The host merely completes the
 * runtime lease when its existing executor finishes. This is the migration
 * boundary used to attach product runners without creating a second process
 * identity.
 */
export class TraceKernelControlledRuntime {
  readonly provider: TraceKernelRuntimeProvider;
  private readonly entries = new Map<number, TraceKernelControlledRuntimeEntry>();
  private readonly attachmentWaiters = new Map<
    number,
    Deferred.Deferred<TraceKernelRuntimeProcessContext, Error>
  >();

  constructor(readonly runtime: string) {
    if (runtime.trim().length === 0) {
      throw new Error('TraceKernel controlled runtime name must not be empty.');
    }
    this.provider = Object.freeze({
      runtime,
      initialize: Effect.succeed({
        acquire: (context: TraceKernelRuntimeProcessContext) =>
          this.attach(context),
      }),
    });
  }

  awaitAttached(
    pid: number
  ): Effect.Effect<TraceKernelRuntimeProcessContext, Error> {
    return Effect.suspend(() => {
      const entry = this.entries.get(pid);
      if (entry) return Effect.succeed(entry.context);
      const existing = this.attachmentWaiters.get(pid);
      if (existing) return Deferred.await(existing);
      return Deferred.make<TraceKernelRuntimeProcessContext, Error>().pipe(
        Effect.tap((waiter) =>
          Effect.sync(() => {
            this.attachmentWaiters.set(pid, waiter);
          })
        ),
        Effect.flatMap(Deferred.await)
      );
    });
  }

  complete(
    pid: number,
    result: TraceKernelRuntimeResult
  ): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const entry = this.entries.get(pid);
      return entry
        ? Deferred.succeed(entry.completion, Object.freeze({ ...result }))
        : Effect.succeed(false);
    });
  }

  fail(pid: number, error: Error): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const entry = this.entries.get(pid);
      return entry
        ? Deferred.fail(entry.completion, error)
        : Effect.succeed(false);
    });
  }

  setSignalHandler(
    pid: number,
    handler: TraceKernelControlledRuntimeSignalHandler
  ): Effect.Effect<() => void, Error> {
    return Effect.suspend(() => {
      const entry = this.entries.get(pid);
      if (!entry) {
        return Effect.fail(
          new Error(`TraceKernel process ${pid} has no attached ${this.runtime} runtime lease.`)
        );
      }
      entry.signalHandler = handler;
      return Effect.succeed(() => {
        if (entry.signalHandler === handler) delete entry.signalHandler;
      });
    });
  }

  setLeaseHandler(
    pid: number,
    handler: TraceKernelControlledRuntimeLeaseHandler
  ): Effect.Effect<() => void, Error> {
    return Effect.suspend(() => {
      const entry = this.entries.get(pid);
      if (!entry) {
        return Effect.fail(
          new Error(`TraceKernel process ${pid} has no attached ${this.runtime} runtime lease.`)
        );
      }
      if (entry.leaseHandler && entry.leaseHandler !== handler) {
        return Effect.fail(
          new Error(`TraceKernel process ${pid} already has a controlled lease handler.`)
        );
      }
      entry.leaseHandler = handler;
      return Effect.succeed(() => {
        if (entry.leaseHandler === handler) delete entry.leaseHandler;
      });
    });
  }

  attachedPids(): readonly number[] {
    return Object.freeze([...this.entries.keys()].sort((left, right) => left - right));
  }

  private attach(
    context: TraceKernelRuntimeProcessContext
  ): Effect.Effect<TraceKernelRuntimeLease, Error> {
    return Effect.gen(this, function* () {
      if (this.entries.has(context.pid)) {
        const existing = this.entries.get(context.pid)!;
        return yield* Effect.fail(
          new Error(
            `TraceKernel process ${context.pid} already has a controlled runtime lease ` +
            `for ${JSON.stringify(existing.context.command)} while attaching ` +
            `${JSON.stringify(context.command)}.`
          )
        );
      }
      const completion = yield* Deferred.make<TraceKernelRuntimeResult, Error>();
      const entry: TraceKernelControlledRuntimeEntry = {
        context,
        completion,
      };
      this.entries.set(context.pid, entry);
      const waiter = this.attachmentWaiters.get(context.pid);
      this.attachmentWaiters.delete(context.pid);
      if (waiter) yield* Deferred.succeed(waiter, context);

      return {
        id: `${this.runtime}-${context.pid}`,
        runtime: this.runtime,
        execute: () => Deferred.await(completion),
        signal: (signal) => {
          const current = this.entries.get(context.pid);
          if (current !== entry || !entry.signalHandler) {
            return Effect.fail(
              new Error(
                `TraceKernel process ${context.pid} has no controlled signal handler.`
              )
            );
          }
          return Effect.tryPromise({
            try: () => Promise.resolve(entry.signalHandler!(signal)),
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
          });
        },
        revalidate: () => {
          const current = this.entries.get(context.pid);
          if (current !== entry || !entry.leaseHandler?.revalidate) {
            return Effect.fail(
              new Error(
                `TraceKernel process ${context.pid} has no controlled runtime revalidation handler.`
              )
            );
          }
          return Effect.tryPromise({
            try: () => Promise.resolve(entry.leaseHandler!.revalidate!()),
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
          });
        },
        release: (disposition) =>
          this.release(context.pid, disposition),
      };
    });
  }

  private release(
    pid: number,
    disposition: TraceKernelRuntimeLeaseReleaseDisposition
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const entry = this.entries.get(pid);
      if (!entry) return Effect.void;
      this.entries.delete(pid);
      if (!entry.leaseHandler) return Effect.void;
      return Effect.tryPromise({
        try: () => Promise.resolve(entry.leaseHandler!.release(disposition)),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.void));
    });
  }
}
