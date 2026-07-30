import * as Effect from 'effect/Effect';
import * as Scope from 'effect/Scope';
import {
  TraceKernelFileSystemError,
  TraceKernelHostClosedError,
  TraceKernelRuntimeUnavailableError,
} from '../errors';
import { TraceKernelNetworkNamespace } from '../network';
import type {
  TraceKernelHostOptions,
  TraceKernelRuntimeLease,
  TraceKernelRuntimeName,
  TraceKernelRuntimeProcessContext,
  TraceKernelSessionOptions,
} from '../model';
import { TraceKernelFileSystem } from '../vfs';

import { TraceKernelSession } from './session';
import {
  acquireTraceKernelRuntimeLease,
  makeTraceKernelRuntimeProviderSlots,
  type TraceKernelRuntimeProviderSlot,
} from './runtime-providers';

function normalizeDescriptorLimit(value: number | undefined): number {
  const requested = Number(value ?? 1024);
  return Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : 1024;
}

function normalizeProcessLimit(value: number | undefined): number {
  const requested = Number(value ?? 256);
  return Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : 256;
}

function normalizeSignalGracePeriod(value: number | undefined): number {
  const requested = Number(value ?? 1_000);
  return Number.isFinite(requested) && requested >= 0
    ? Math.floor(requested)
    : 1_000;
}

export class TraceKernelHost {
  private readonly sessions = new Map<string, TraceKernelSession>();
  private readonly claimedFileSystems = new WeakSet<TraceKernelFileSystem>();
  private nextSessionId = 1;
  private closed = false;

  constructor(
    private readonly providerSlots: ReadonlyMap<TraceKernelRuntimeName, TraceKernelRuntimeProviderSlot>
  ) {}

  openSession(
    options: TraceKernelSessionOptions = {}
  ): Effect.Effect<
    TraceKernelSession,
    TraceKernelHostClosedError | TraceKernelFileSystemError,
    Scope.Scope
  > {
    return Effect.gen(this, function* () {
      if (this.closed) {
        return yield* Effect.fail(new TraceKernelHostClosedError({
          message: 'TraceKernel host is closed.',
        }));
      }
      const cwd = options.cwd ?? '/workspace';
      if (options.fileSystem && options.fileSystemImage) {
        return yield* Effect.fail(new TraceKernelFileSystemError({
          code: 'EINVAL',
          path: cwd,
          message: 'EINVAL: fileSystem and fileSystemImage are mutually exclusive',
        }));
      }
      const ownsFileSystem = options.fileSystem === undefined;
      const fileSystem = options.fileSystem ??
        (options.fileSystemImage
          ? yield* TraceKernelFileSystem.fromImage(options.fileSystemImage)
          : yield* TraceKernelFileSystem.make());
      const cwdStat = yield* fileSystem.stat(cwd, '/');
      if (cwdStat.kind !== 'directory') {
        return yield* Effect.fail(new TraceKernelFileSystemError({
          code: 'ENOTDIR',
          path: cwd,
          message: `ENOTDIR: session cwd is not a directory ${JSON.stringify(cwd)}`,
        }));
      }
      const networkNamespace = yield* TraceKernelNetworkNamespace.make();
      const sessionScope = yield* Scope.make();
      return yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            if (!ownsFileSystem) {
              if (this.claimedFileSystems.has(fileSystem)) {
                throw new TraceKernelFileSystemError({
                  code: 'EBUSY',
                  path: cwd,
                  message: 'EBUSY: TKFS is already claimed by a live session',
                });
              }
              this.claimedFileSystems.add(fileSystem);
            }
            const id = `session-${this.nextSessionId++}`;
            try {
              const session = new TraceKernelSession(
                id,
                this,
                sessionScope,
                fileSystem,
                networkNamespace,
                cwd,
                Object.freeze({ ...(options.env ?? {}) }),
                normalizeDescriptorLimit(options.maxDescriptorsPerProcess),
                normalizeProcessLimit(options.maxProcesses),
                normalizeSignalGracePeriod(options.signalGracePeriodMs),
                ownsFileSystem,
                options.fileSystemPolicy
              );
              this.sessions.set(id, session);
              return session;
            } catch (error) {
              if (!ownsFileSystem) this.claimedFileSystems.delete(fileSystem);
              throw error;
            }
          },
          catch: (error) =>
            error instanceof TraceKernelFileSystemError
              ? error
              : new TraceKernelFileSystemError({
                  code: 'EINVAL',
                  path: cwd,
                  message: error instanceof Error ? error.message : String(error),
                }),
        }),
        (session) => session.shutdown()
      );
    });
  }

  sessionIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  acquireRuntimeLease(
    runtime: TraceKernelRuntimeName,
    process: TraceKernelRuntimeProcessContext
  ): Effect.Effect<
    TraceKernelRuntimeLease,
    TraceKernelRuntimeUnavailableError | Error
  > {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(new TraceKernelHostClosedError({
          message: 'TraceKernel host is closed.',
        }));
      }
      return acquireTraceKernelRuntimeLease(
        this.providerSlots,
        runtime,
        process
      );
    });
  }

  shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      this.closed = true;
      return Effect.forEach(
        [...this.sessions.values()],
        (session) => session.shutdown(),
        { concurrency: 'unbounded', discard: true }
      ).pipe(
        Effect.ensuring(Effect.sync(() => this.sessions.clear()))
      );
    });
  }

  unregisterSession(id: string, fileSystem?: TraceKernelFileSystem): void {
    this.sessions.delete(id);
    if (fileSystem) this.claimedFileSystems.delete(fileSystem);
  }
}

/**
 * Acquire a host as a scoped resource.
 *
 * Provider initialization is memoized but remains lazy: constructing a host or
 * opening a session does not initialize any language runtime.
 */
export function makeTraceKernelHost(
  options: TraceKernelHostOptions = {}
): Effect.Effect<TraceKernelHost, never, Scope.Scope> {
  return Effect.acquireRelease(
    makeTraceKernelRuntimeProviderSlots(options.providers ?? []).pipe(
      Effect.map((slots) => new TraceKernelHost(slots))
    ),
    (host) => host.shutdown()
  );
}
