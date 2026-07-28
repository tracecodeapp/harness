import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import type {
  TraceKernelDescriptor,
  TraceKernelDescriptorReadiness,
  TraceKernelDescriptorKind,
  TraceKernelPollEvents,
} from './descriptors';
import { TraceKernelBadFileDescriptorError } from './errors';

export type TraceKernelWatchEventType = 'change' | 'rename' | 'overflow';
export type TraceKernelWatchEntryOperation = 'create' | 'delete';

export interface TraceKernelWatchEvent {
  readonly eventType: TraceKernelWatchEventType;
  /**
   * Exact namespace mutation behind a Node-compatible `rename` event.
   *
   * Older TKW1 producers may omit this field. Consumers that need exact
   * create/delete semantics must treat an omitted value as ambiguous.
   */
  readonly entryOperation?: TraceKernelWatchEntryOperation;
  /** Absolute path in the session namespace. Empty only for overflow. */
  readonly path: string;
}

export interface TraceKernelWatchOptions {
  readonly recursive?: boolean;
  readonly capacityEvents?: number;
}

export type TraceKernelFileSystemMutationOperation =
  | 'chmod'
  | 'utimes'
  | 'mkdir'
  | 'rmdir'
  | 'write'
  | 'link'
  | 'symlink'
  | 'unlink'
  | 'rename'
  | 'open-create'
  | 'open-truncate'
  | 'truncate'
  | 'clear';

/**
 * Optional in-process attribution for a committed TKFS mutation.
 *
 * Identity is intentionally opaque. It lets host adapters distinguish their
 * own writes from process syscalls without relying on async timing or exposing
 * authority-bearing data to runtimes.
 */
export interface TraceKernelFileSystemMutationContext {
  readonly origin?: object;
}

export interface TraceKernelFileSystemMutation {
  readonly generation: number;
  readonly eventType: Exclude<TraceKernelWatchEventType, 'overflow'>;
  readonly operation: TraceKernelFileSystemMutationOperation;
  readonly paths: readonly string[];
  readonly origin?: object;
}

const WATCH_FRAME_MAGIC = Uint8Array.from([0x54, 0x4b, 0x57, 0x31]);
const WATCH_FRAME_HEADER_BYTES = 9;
const WATCH_MAX_PATH_BYTES = 16 * 1024;

export function encodeTraceKernelWatchEvent(
  event: TraceKernelWatchEvent
): Uint8Array {
  const path = new TextEncoder().encode(event.path);
  if (path.byteLength > WATCH_MAX_PATH_BYTES) {
    throw Object.assign(
      new Error(`ENAMETOOLONG: watch event path exceeds ${WATCH_MAX_PATH_BYTES} bytes`),
      { code: 'ENAMETOOLONG' }
    );
  }
  const frame = new Uint8Array(WATCH_FRAME_HEADER_BYTES + path.byteLength);
  frame.set(WATCH_FRAME_MAGIC, 0);
  frame[4] = event.eventType === 'change'
    ? 1
    : event.eventType === 'rename'
      ? event.entryOperation === 'create'
        ? 4
        : event.entryOperation === 'delete'
          ? 5
          : 2
      : 3;
  new DataView(frame.buffer).setUint32(5, path.byteLength, true);
  frame.set(path, WATCH_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeTraceKernelWatchEvent(
  frame: Uint8Array
): TraceKernelWatchEvent {
  if (
    frame.byteLength < WATCH_FRAME_HEADER_BYTES ||
    WATCH_FRAME_MAGIC.some((byte, index) => frame[index] !== byte)
  ) {
    throw Object.assign(new Error('EPROTO: invalid TraceKernel watch frame'), {
      code: 'EPROTO',
    });
  }
  const type = frame[4];
  if (type !== 1 && type !== 2 && type !== 3 && type !== 4 && type !== 5) {
    throw Object.assign(
      new Error(`EPROTO: invalid TraceKernel watch event type ${type}`),
      { code: 'EPROTO' }
    );
  }
  const pathLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength
  ).getUint32(5, true);
  if (pathLength > WATCH_MAX_PATH_BYTES || frame.byteLength !== WATCH_FRAME_HEADER_BYTES + pathLength) {
    throw Object.assign(new Error('EPROTO: invalid TraceKernel watch frame length'), {
      code: 'EPROTO',
    });
  }
  return Object.freeze({
    eventType: type === 1
      ? 'change'
      : type === 2 || type === 4 || type === 5
        ? 'rename'
        : 'overflow',
    ...(type === 4
      ? { entryOperation: 'create' as const }
      : type === 5
        ? { entryOperation: 'delete' as const }
        : {}),
    path: new TextDecoder().decode(frame.subarray(WATCH_FRAME_HEADER_BYTES)),
  });
}

interface TraceKernelWatchRegistration {
  readonly path: string;
  readonly directory: boolean;
  readonly recursive: boolean;
}

class TraceKernelFileWatch {
  private remainder = new Uint8Array();
  private closed = false;
  private references = 1;
  private overflowPending = false;

  private constructor(
    readonly id: string,
    readonly registration: TraceKernelWatchRegistration,
    private readonly events: Queue.Queue<Uint8Array>,
    private readonly closedSignal: Deferred.Deferred<void>,
    private readinessChanged: Deferred.Deferred<void>,
    private readonly readMutex: Effect.Semaphore,
    private readonly onFinalClose: (id: string) => void
  ) {}

  static make(
    id: string,
    registration: TraceKernelWatchRegistration,
    options: TraceKernelWatchOptions,
    onFinalClose: (id: string) => void
  ): Effect.Effect<TraceKernelFileWatch> {
    return Effect.gen(function* () {
      const events = yield* Queue.dropping<Uint8Array>(
        Math.max(1, Math.floor(options.capacityEvents ?? 1024))
      );
      const closedSignal = yield* Deferred.make<void>();
      const readinessChanged = yield* Deferred.make<void>();
      const readMutex = yield* Effect.makeSemaphore(1);
      return new TraceKernelFileWatch(
        id,
        registration,
        events,
        closedSignal,
        readinessChanged,
        readMutex,
        onFinalClose
      );
    });
  }

  matches(path: string): boolean {
    const watched = this.registration.path;
    if (path === watched) return true;
    if (!this.registration.directory) return false;
    const prefix = watched === '/' ? '/' : `${watched}/`;
    if (!path.startsWith(prefix)) return false;
    const relative = path.slice(prefix.length);
    return this.registration.recursive || !relative.includes('/');
  }

  publish(event: TraceKernelWatchEvent): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      let frame: Uint8Array;
      try {
        frame = encodeTraceKernelWatchEvent(event);
      } catch {
        this.overflowPending = true;
        return this.enqueueOverflowIfNeeded();
      }
      return Queue.offer(this.events, frame).pipe(
        Effect.tap((accepted) => accepted
          ? this.notifyReadiness()
          : Effect.sync(() => {
              this.overflowPending = true;
            })),
        Effect.asVoid
      );
    });
  }

  descriptor(): TraceKernelDescriptor {
    return {
      kind: 'fs-watch' as TraceKernelDescriptorKind,
      resourceId: this.id,
      resource: this,
      read: (maxBytes) => this.read(maxBytes).pipe(
        Effect.tap(() => this.notifyReadiness())
      ),
      readiness: (events) => this.readiness(events),
      awaitReadiness: (events) => this.awaitReadiness(events),
      duplicate: () => this.duplicate(),
      close: () => this.close(),
    };
  }

  private read(
    maxBytes: number
  ): Effect.Effect<Uint8Array, TraceKernelBadFileDescriptorError> {
    if (maxBytes === 0) return Effect.succeed(new Uint8Array());
    return this.readMutex.withPermits(1)(
      Effect.suspend(() => {
        if (this.closed) return this.closedError();
        if (this.remainder.byteLength > 0) {
          return Effect.succeed(this.takeRemainder(maxBytes));
        }
        return Effect.raceFirst(
          Queue.take(this.events),
          Deferred.await(this.closedSignal).pipe(
            Effect.andThen(this.closedError())
          )
        ).pipe(
          Effect.tap(() => this.enqueueOverflowIfNeeded()),
          Effect.map((frame) => this.takeFrame(frame, maxBytes))
        );
      })
    );
  }

  private enqueueOverflowIfNeeded(): Effect.Effect<void> {
    if (!this.overflowPending || this.closed) return Effect.void;
    return Queue.offer(
      this.events,
      encodeTraceKernelWatchEvent({ eventType: 'overflow', path: '' })
    ).pipe(
      Effect.tap((accepted) => accepted
        ? Effect.sync(() => {
            this.overflowPending = false;
          }).pipe(Effect.andThen(this.notifyReadiness()))
        : Effect.void),
      Effect.asVoid
    );
  }

  private readiness(
    events: TraceKernelPollEvents
  ): Effect.Effect<TraceKernelDescriptorReadiness> {
    return Queue.isEmpty(this.events).pipe(
      Effect.map((empty) => Object.freeze({
        read: events.read &&
          (this.remainder.byteLength > 0 || !empty),
        write: false,
        hangup: this.closed,
        error: false,
      }))
    );
  }

  private awaitReadiness(
    events: TraceKernelPollEvents
  ): Effect.Effect<TraceKernelDescriptorReadiness> {
    return Effect.suspend(() => {
      const changed = this.readinessChanged;
      return this.readiness(events).pipe(
        Effect.flatMap((readiness) =>
          readiness.read || readiness.hangup
            ? Effect.succeed(readiness)
            : Deferred.await(changed).pipe(
                Effect.andThen(this.awaitReadiness(events))
              )
        )
      );
    });
  }

  private notifyReadiness(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const previous = this.readinessChanged;
      const next = yield* Deferred.make<void>();
      this.readinessChanged = next;
      yield* Deferred.succeed(previous, undefined);
    });
  }

  private takeFrame(frame: Uint8Array, maxBytes: number): Uint8Array {
    if (frame.byteLength <= maxBytes) return frame;
    this.remainder = frame.slice(maxBytes);
    return frame.slice(0, maxBytes);
  }

  private takeRemainder(maxBytes: number): Uint8Array {
    const bytes = this.remainder.slice(0, maxBytes);
    this.remainder = this.remainder.slice(bytes.byteLength);
    return bytes;
  }

  private duplicate(): Effect.Effect<TraceKernelDescriptor, Error> {
    return Effect.suspend(() => {
      if (this.closed) return this.closedError();
      this.references += 1;
      return Effect.succeed(this.descriptor());
    });
  }

  private close(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      this.references -= 1;
      if (this.references > 0) return Effect.void;
      this.closed = true;
      this.onFinalClose(this.id);
      return Deferred.succeed(this.closedSignal, undefined).pipe(
        Effect.asVoid,
        Effect.andThen(this.notifyReadiness())
      );
    });
  }

  private closedError(): Effect.Effect<never, TraceKernelBadFileDescriptorError> {
    return Effect.fail(new TraceKernelBadFileDescriptorError({
      fd: -1,
      operation: 'read',
      message: 'EBADF: filesystem watch is closed',
    }));
  }
}

export class TraceKernelWatchRegistry {
  private readonly watches = new Map<string, TraceKernelFileWatch>();
  private nextId = 1;

  create(
    path: string,
    directory: boolean,
    options: TraceKernelWatchOptions = {}
  ): Effect.Effect<TraceKernelDescriptor> {
    const id = `watch-${this.nextId++}`;
    return TraceKernelFileWatch.make(
      id,
      {
        path,
        directory,
        recursive: directory && options.recursive === true,
      },
      options,
      (closedId) => this.watches.delete(closedId)
    ).pipe(
      Effect.tap((watch) => Effect.sync(() => {
        this.watches.set(id, watch);
      })),
      Effect.map((watch) => watch.descriptor())
    );
  }

  publish(mutation: TraceKernelFileSystemMutation): Effect.Effect<void> {
    return Effect.forEach(
      this.watches.values(),
      (watch) => Effect.forEach(
        mutation.paths,
        (path, index) => watch.matches(path)
          ? watch.publish({
              eventType: mutation.eventType,
              ...(mutation.eventType === 'rename'
                ? {
                    entryOperation: this.entryOperation(
                      mutation.operation,
                      index
                    ),
                  }
                : {}),
              path,
            })
          : Effect.void,
        { concurrency: 1, discard: true }
      ),
      { concurrency: 'unbounded', discard: true }
    );
  }

  activeCount(): number {
    return this.watches.size;
  }

  private entryOperation(
    operation: TraceKernelFileSystemMutationOperation,
    pathIndex: number
  ): TraceKernelWatchEntryOperation | undefined {
    switch (operation) {
      case 'mkdir':
      case 'write':
      case 'link':
      case 'symlink':
      case 'open-create':
        return 'create';
      case 'rmdir':
      case 'unlink':
      case 'clear':
        return 'delete';
      case 'rename':
        return pathIndex === 0 ? 'delete' : 'create';
      default:
        return undefined;
    }
  }
}
