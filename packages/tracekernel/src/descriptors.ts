import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Queue from 'effect/Queue';
import {
  TraceKernelBadFileDescriptorError,
  TraceKernelBrokenPipeError,
  TraceKernelDescriptorLimitError,
  TraceKernelInvalidDescriptorOperationError,
} from './errors';
import type { TraceKernelStat } from './vfs';

export type TraceKernelDescriptorKind =
  | 'file'
  | 'pipe-reader'
  | 'pipe-writer'
  | 'fs-watch'
  | 'tcp-socket';

export interface TraceKernelDescriptorSnapshot {
  readonly fd: number;
  readonly kind: TraceKernelDescriptorKind;
  readonly resourceId: string;
}

export interface TraceKernelDescriptor {
  readonly kind: TraceKernelDescriptorKind;
  readonly resourceId: string;
  /**
   * Kernel-private backing resource used by typed session control operations.
   * It is never included in descriptor snapshots or syscall responses.
   */
  readonly resource?: unknown;
  read?(maxBytes: number, position?: number): Effect.Effect<Uint8Array, Error>;
  write?(bytes: Uint8Array, position?: number): Effect.Effect<number, Error>;
  stat?(): Effect.Effect<TraceKernelStat, Error>;
  truncate?(length: number): Effect.Effect<void, Error>;
  duplicate(): Effect.Effect<TraceKernelDescriptor, Error>;
  close(): Effect.Effect<void>;
}

export interface TraceKernelReadableDescriptor extends TraceKernelDescriptor {
  readonly kind: 'pipe-reader';
  read(maxBytes: number): Effect.Effect<Uint8Array, Error>;
}

export interface TraceKernelWritableDescriptor extends TraceKernelDescriptor {
  readonly kind: 'pipe-writer';
  write(bytes: Uint8Array): Effect.Effect<number, Error>;
}

export type TraceKernelDescriptorReadError =
  | TraceKernelBadFileDescriptorError
  | TraceKernelInvalidDescriptorOperationError;

export type TraceKernelDescriptorWriteError =
  | TraceKernelBadFileDescriptorError
  | TraceKernelInvalidDescriptorOperationError
  | TraceKernelBrokenPipeError;

export interface TraceKernelDescriptorTableOptions {
  readonly maxDescriptors?: number;
}

export type TraceKernelDescriptorDupError =
  | TraceKernelBadFileDescriptorError
  | TraceKernelDescriptorLimitError;

export type TraceKernelDescriptorInheritanceError =
  | TraceKernelBadFileDescriptorError
  | TraceKernelDescriptorLimitError;

export class TraceKernelDescriptorTable {
  private readonly descriptors = new Map<number, TraceKernelDescriptor>();
  private nextFd = 3;
  readonly maxDescriptors: number;

  constructor(options: TraceKernelDescriptorTableOptions = {}) {
    const requested = Number(options.maxDescriptors ?? 1024);
    this.maxDescriptors = Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : 1024;
  }

  install(descriptor: TraceKernelDescriptor): number {
    if (this.descriptors.size >= this.maxDescriptors) {
      throw new TraceKernelDescriptorLimitError({
        code: 'EMFILE',
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: process descriptor limit ${this.maxDescriptors} reached`,
      });
    }
    let fd = this.nextFd;
    while (this.descriptors.has(fd)) fd += 1;
    this.descriptors.set(fd, descriptor);
    this.nextFd = fd + 1;
    return fd;
  }

  /**
   * Install a descriptor at a kernel-selected numeric identity.
   *
   * This is intentionally separate from dup/inherit: process launch uses it
   * to establish fd 0/1/2 before a runtime lease starts, while ordinary
   * runtime opens continue to allocate from fd 3 upward.
   */
  installAt(fd: number, descriptor: TraceKernelDescriptor): number {
    const targetFd = Math.floor(fd);
    if (!Number.isSafeInteger(fd) || targetFd < 0) {
      throw new TraceKernelBadFileDescriptorError({
        fd: targetFd,
        operation: 'inherit',
        message: `EBADF: invalid target descriptor ${fd}`,
      });
    }
    if (this.descriptors.size >= this.maxDescriptors) {
      throw new TraceKernelDescriptorLimitError({
        code: 'EMFILE',
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: process descriptor limit ${this.maxDescriptors} reached`,
      });
    }
    if (this.descriptors.has(targetFd)) {
      throw new TraceKernelDescriptorLimitError({
        code: 'EMFILE',
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: target descriptor ${targetFd} is already occupied`,
      });
    }
    this.descriptors.set(targetFd, descriptor);
    if (targetFd === this.nextFd) this.resetNextFd();
    return targetFd;
  }

  snapshots(): readonly TraceKernelDescriptorSnapshot[] {
    return [...this.descriptors.entries()]
      .map(([fd, descriptor]) => Object.freeze({
        fd,
        kind: descriptor.kind,
        resourceId: descriptor.resourceId,
      }))
      .sort((left, right) => left.fd - right.fd);
  }

  lookup(fd: number): Effect.Effect<TraceKernelDescriptor, TraceKernelBadFileDescriptorError> {
    const descriptor = this.descriptors.get(fd);
    return descriptor
      ? Effect.succeed(descriptor)
      : Effect.fail(new TraceKernelBadFileDescriptorError({
          fd,
          operation: 'stat',
          message: `EBADF: bad file descriptor ${fd}`,
        }));
  }

  read(
    fd: number,
    maxBytes: number,
    position?: number
  ): Effect.Effect<Uint8Array, TraceKernelDescriptorReadError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'read',
        message: `EBADF: bad file descriptor, read ${fd}`,
      }));
    }
    if (!descriptor.read) {
      return Effect.fail(new TraceKernelInvalidDescriptorOperationError({
        fd,
        operation: 'read',
        message: `EBADF: descriptor ${fd} is not readable`,
      }));
    }
    return descriptor.read(
      Math.max(0, Math.floor(maxBytes)),
      position === undefined ? undefined : Math.max(0, Math.floor(position))
    ).pipe(
      Effect.mapError((error) => error instanceof TraceKernelBadFileDescriptorError
        ? error
        : new TraceKernelBadFileDescriptorError({
            fd,
            operation: 'read',
            message: error.message,
          }))
    );
  }

  write(
    fd: number,
    bytes: Uint8Array,
    position?: number
  ): Effect.Effect<number, TraceKernelDescriptorWriteError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'write',
        message: `EBADF: bad file descriptor, write ${fd}`,
      }));
    }
    if (!descriptor.write) {
      return Effect.fail(new TraceKernelInvalidDescriptorOperationError({
        fd,
        operation: 'write',
        message: `EBADF: descriptor ${fd} is not writable`,
      }));
    }
    return descriptor.write(
      Uint8Array.from(bytes),
      position === undefined ? undefined : Math.max(0, Math.floor(position))
    ).pipe(
      Effect.mapError((error) => error instanceof TraceKernelBrokenPipeError
        ? error
        : new TraceKernelBadFileDescriptorError({
            fd,
            operation: 'write',
            message: error.message,
          }))
    );
  }

  stat(fd: number): Effect.Effect<TraceKernelStat, TraceKernelBadFileDescriptorError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor?.stat) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'stat',
        message: `EBADF: descriptor ${fd} does not support fstat`,
      }));
    }
    return descriptor.stat().pipe(
      Effect.mapError((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'stat',
        message: error.message,
      }))
    );
  }

  truncate(
    fd: number,
    length: number
  ): Effect.Effect<void, TraceKernelBadFileDescriptorError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor?.truncate) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'truncate',
        message: `EBADF: descriptor ${fd} does not support ftruncate`,
      }));
    }
    return descriptor.truncate(Math.max(0, Math.floor(length))).pipe(
      Effect.mapError((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'truncate',
        message: error.message,
      }))
    );
  }

  dup(fd: number): Effect.Effect<number, TraceKernelDescriptorDupError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'dup',
        message: `EBADF: bad file descriptor, dup ${fd}`,
      }));
    }
    return descriptor.duplicate().pipe(
      Effect.mapError((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'dup',
        message: error.message,
      })),
      Effect.flatMap((duplicate) => this.installEffect(duplicate))
    );
  }

  dup2(
    fd: number,
    targetFd: number
  ): Effect.Effect<number, TraceKernelDescriptorDupError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'dup2',
        message: `EBADF: bad file descriptor, dup2 ${fd}`,
      }));
    }
    const target = Math.floor(targetFd);
    if (!Number.isSafeInteger(targetFd) || target < 0) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd: target,
        operation: 'dup2',
        message: `EBADF: invalid target descriptor ${targetFd}`,
      }));
    }
    if (fd === target) return Effect.succeed(target);

    const replaced = this.descriptors.get(target);
    if (!replaced && this.descriptors.size >= this.maxDescriptors) {
      return Effect.fail(new TraceKernelDescriptorLimitError({
        code: 'EMFILE',
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: process descriptor limit ${this.maxDescriptors} reached`,
      }));
    }

    return descriptor.duplicate().pipe(
      Effect.mapError((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'dup2',
        message: error.message,
      })),
      Effect.flatMap((duplicate) =>
        Effect.sync(() => {
          this.descriptors.set(target, duplicate);
          this.resetNextFd();
        }).pipe(
          Effect.andThen(replaced ? replaced.close() : Effect.void),
          Effect.as(target)
        )
      )
    );
  }

  /**
   * Duplicate selected descriptors from a parent table while preserving their
   * numeric descriptor identities.
   *
   * All source descriptors are validated and all duplicate references are
   * acquired before the child table is mutated. A failure closes every
   * provisional reference, leaving the target table unchanged.
   */
  inherit(
    source: TraceKernelDescriptorTable,
    fds?: readonly number[]
  ): Effect.Effect<void, TraceKernelDescriptorInheritanceError> {
    return Effect.try({
      try: () => {
        const selectedFds = fds === undefined
          ? [...source.descriptors.keys()].sort((left, right) => left - right)
          : [...new Set(fds.map((fd) => Math.floor(fd)))].sort((left, right) => left - right);
        return selectedFds.map((fd) => {
          const descriptor = source.descriptors.get(fd);
          if (!descriptor) {
            throw new TraceKernelBadFileDescriptorError({
              fd,
              operation: 'inherit',
              message: `EBADF: bad file descriptor, inherit ${fd}`,
            });
          }
          return [fd, descriptor] as const;
        });
      },
      catch: (error) => this.inheritanceError(error),
    }).pipe(
      Effect.flatMap((selected) => this.inheritSelected(selected))
    );
  }

  inheritMapped(
    source: TraceKernelDescriptorTable,
    mappings: readonly {
      readonly sourceFd: number;
      readonly targetFd: number;
    }[]
  ): Effect.Effect<void, TraceKernelDescriptorInheritanceError> {
    return Effect.try({
      try: () => {
        const targets = new Set<number>();
        return mappings.map(({ sourceFd, targetFd }) => {
          const sourceNumber = Math.floor(sourceFd);
          const targetNumber = Math.floor(targetFd);
          if (
            !Number.isSafeInteger(sourceFd) ||
            !Number.isSafeInteger(targetFd) ||
            sourceNumber < 0 ||
            targetNumber < 0
          ) {
            throw new TraceKernelBadFileDescriptorError({
              fd: targetNumber,
              operation: 'inherit',
              message: `EBADF: invalid descriptor mapping ${sourceFd} -> ${targetFd}`,
            });
          }
          if (targets.has(targetNumber)) {
            throw new TraceKernelBadFileDescriptorError({
              fd: targetNumber,
              operation: 'inherit',
              message: `EBADF: duplicate child descriptor mapping ${targetNumber}`,
            });
          }
          targets.add(targetNumber);
          const descriptor = source.descriptors.get(sourceNumber);
          if (!descriptor) {
            throw new TraceKernelBadFileDescriptorError({
              fd: sourceNumber,
              operation: 'inherit',
              message: `EBADF: bad parent descriptor, inherit ${sourceNumber}`,
            });
          }
          return [targetNumber, descriptor] as const;
        });
      },
      catch: (error) => this.inheritanceError(error),
    }).pipe(
      Effect.flatMap((selected) => this.inheritSelected(selected))
    );
  }

  private inheritSelected(
    selected: readonly (readonly [number, TraceKernelDescriptor])[]
  ): Effect.Effect<void, TraceKernelDescriptorInheritanceError> {
    return Effect.gen(this, function* () {
      if (this.descriptors.size + selected.length > this.maxDescriptors) {
        return yield* Effect.fail(new TraceKernelDescriptorLimitError({
          code: 'EMFILE',
          maxDescriptors: this.maxDescriptors,
          message: `EMFILE: inherited descriptors exceed process descriptor limit ${this.maxDescriptors}`,
        }));
      }
      for (const [fd] of selected) {
        if (this.descriptors.has(fd)) {
          return yield* Effect.fail(new TraceKernelDescriptorLimitError({
            code: 'EMFILE',
            maxDescriptors: this.maxDescriptors,
            message: `EMFILE: target descriptor ${fd} is already occupied`,
          }));
        }
      }

      const duplicates: Array<readonly [number, TraceKernelDescriptor]> = [];
      yield* Effect.forEach(
        selected,
        ([fd, descriptor]) => descriptor.duplicate().pipe(
          Effect.tap((duplicate) => Effect.sync(() => {
            duplicates.push([fd, duplicate]);
          })),
          Effect.mapError((error) => new TraceKernelBadFileDescriptorError({
            fd,
            operation: 'inherit',
            message: error.message,
          }))
        ),
        { concurrency: 1, discard: true }
      ).pipe(
        Effect.onError(() =>
          Effect.forEach(
            duplicates,
            ([, duplicate]) => duplicate.close(),
            { concurrency: 'unbounded', discard: true }
          )
        )
      );

      for (const [fd, duplicate] of duplicates) {
        this.descriptors.set(fd, duplicate);
      }
      this.resetNextFd();
    });
  }

  private inheritanceError(error: unknown): TraceKernelBadFileDescriptorError {
    return error instanceof TraceKernelBadFileDescriptorError
      ? error
      : new TraceKernelBadFileDescriptorError({
          fd: -1,
          operation: 'inherit',
          message: error instanceof Error ? error.message : String(error),
        });
  }

  close(fd: number): Effect.Effect<void, TraceKernelBadFileDescriptorError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'close',
        message: `EBADF: bad file descriptor, close ${fd}`,
      }));
    }
    this.descriptors.delete(fd);
    if (fd < this.nextFd) this.nextFd = fd;
    return descriptor.close();
  }

  closeAll(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const descriptors = [...this.descriptors.values()];
      this.descriptors.clear();
      this.nextFd = 3;
      return Effect.forEach(
        descriptors,
        (descriptor) => descriptor.close(),
        { concurrency: 'unbounded', discard: true }
      );
    });
  }

  private resetNextFd(): void {
    this.nextFd = 3;
    while (this.descriptors.has(this.nextFd)) this.nextFd += 1;
  }

  private installEffect(
    descriptor: TraceKernelDescriptor
  ): Effect.Effect<number, TraceKernelDescriptorLimitError> {
    return Effect.try({
      try: () => this.install(descriptor),
      catch: (error) => error instanceof TraceKernelDescriptorLimitError
        ? error
        : new TraceKernelDescriptorLimitError({
            code: 'EMFILE',
            maxDescriptors: this.maxDescriptors,
            message: error instanceof Error ? error.message : String(error),
          }),
    }).pipe(
      Effect.tapError(() => descriptor.close())
    );
  }
}

type PipeReadEvent =
  | { readonly kind: 'data'; readonly bytes: Uint8Array }
  | { readonly kind: 'writer-closed' }
  | { readonly kind: 'reader-closed' };

export interface TraceKernelPipeOptions {
  readonly capacityChunks?: number;
}

/**
 * Session-owned bounded byte pipe.
 *
 * Queue provides interruptible backpressure for data chunks. Deferred endpoint
 * state wakes blocked reads/writes without injecting control messages into the
 * bounded data queue.
 */
export class TraceKernelPipe {
  private remainder = new Uint8Array(0);
  private readerIsClosed = false;
  private writerIsClosed = false;
  private readerReferences = 1;
  private writerReferences = 1;

  private constructor(
    readonly id: string,
    private readonly chunks: Queue.Queue<Uint8Array>,
    private readonly readerClosed: Deferred.Deferred<void>,
    private readonly writerClosed: Deferred.Deferred<void>,
    private readonly readMutex: Effect.Semaphore,
    private readonly onFullyClosed: (id: string) => void
  ) {}

  static make(
    id: string,
    options: TraceKernelPipeOptions = {},
    onFullyClosed: (id: string) => void = () => undefined
  ): Effect.Effect<TraceKernelPipe> {
    return Effect.gen(function* () {
      const chunks = yield* Queue.bounded<Uint8Array>(
        Math.max(1, Math.floor(options.capacityChunks ?? 16))
      );
      const readerClosed = yield* Deferred.make<void>();
      const writerClosed = yield* Deferred.make<void>();
      const readMutex = yield* Effect.makeSemaphore(1);
      return new TraceKernelPipe(
        id,
        chunks,
        readerClosed,
        writerClosed,
        readMutex,
        onFullyClosed
      );
    });
  }

  reader(): TraceKernelReadableDescriptor {
    return {
      kind: 'pipe-reader',
      resourceId: this.id,
      read: (maxBytes) => this.read(maxBytes),
      duplicate: () => this.duplicateReader(),
      close: () => this.closeReader(),
    };
  }

  writer(): TraceKernelWritableDescriptor {
    return {
      kind: 'pipe-writer',
      resourceId: this.id,
      write: (bytes) => this.write(bytes),
      duplicate: () => this.duplicateWriter(),
      close: () => this.closeWriter(),
    };
  }

  dispose(): Effect.Effect<void> {
    return Effect.all([
      this.closeReader(),
      this.closeWriter(),
    ], { concurrency: 'unbounded', discard: true }).pipe(
      Effect.andThen(Queue.shutdown(this.chunks))
    );
  }

  private read(maxBytes: number): Effect.Effect<Uint8Array, TraceKernelBadFileDescriptorError> {
    if (maxBytes === 0) return Effect.succeed(new Uint8Array(0));
    return this.readMutex.withPermits(1)(
      Effect.suspend(() => {
        if (this.readerIsClosed) return this.readerClosedError();
        if (this.remainder.byteLength > 0) return Effect.succeed(this.takeRemainder(maxBytes));
        return Queue.poll(this.chunks).pipe(
          Effect.flatMap((available) => Option.isSome(available)
            ? Effect.succeed(this.takeBytes(available.value, maxBytes))
            : this.awaitReadEvent(maxBytes))
        );
      })
    );
  }

  private awaitReadEvent(maxBytes: number): Effect.Effect<Uint8Array, TraceKernelBadFileDescriptorError> {
    if (this.writerIsClosed) {
      return Queue.poll(this.chunks).pipe(
        Effect.map((available) => Option.isSome(available)
          ? this.takeBytes(available.value, maxBytes)
          : new Uint8Array(0))
      );
    }
    return Effect.raceAll([
      Queue.take(this.chunks).pipe(
        Effect.map((bytes): PipeReadEvent => ({ kind: 'data', bytes }))
      ),
      Deferred.await(this.writerClosed).pipe(
        Effect.as<PipeReadEvent>({ kind: 'writer-closed' })
      ),
      Deferred.await(this.readerClosed).pipe(
        Effect.as<PipeReadEvent>({ kind: 'reader-closed' })
      ),
    ]).pipe(
      Effect.flatMap((event) => {
        if (event.kind === 'data') return Effect.succeed(this.takeBytes(event.bytes, maxBytes));
        if (event.kind === 'reader-closed') return this.readerClosedError();
        return Queue.poll(this.chunks).pipe(
          Effect.map((available) => Option.isSome(available)
            ? this.takeBytes(available.value, maxBytes)
            : new Uint8Array(0))
        );
      })
    );
  }

  private write(bytes: Uint8Array): Effect.Effect<number, TraceKernelBrokenPipeError> {
    return Effect.suspend(() => {
      if (this.writerIsClosed || this.readerIsClosed) return this.brokenPipeError();
      if (bytes.byteLength === 0) return Effect.succeed(0);
      return Effect.raceFirst(
        Queue.offer(this.chunks, Uint8Array.from(bytes)).pipe(Effect.as(bytes.byteLength)),
        Deferred.await(this.readerClosed).pipe(
          Effect.andThen(this.brokenPipeError())
        )
      );
    });
  }

  private closeReader(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.readerIsClosed) return Effect.void;
      this.readerReferences -= 1;
      if (this.readerReferences > 0) return Effect.void;
      this.readerIsClosed = true;
      return Deferred.succeed(this.readerClosed, undefined).pipe(
        Effect.asVoid,
        Effect.tap(() => Effect.sync(() => this.notifyIfFullyClosed()))
      );
    });
  }

  private closeWriter(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.writerIsClosed) return Effect.void;
      this.writerReferences -= 1;
      if (this.writerReferences > 0) return Effect.void;
      this.writerIsClosed = true;
      return Deferred.succeed(this.writerClosed, undefined).pipe(
        Effect.asVoid,
        Effect.tap(() => Effect.sync(() => this.notifyIfFullyClosed()))
      );
    });
  }

  private duplicateReader(): Effect.Effect<TraceKernelDescriptor, Error> {
    return Effect.suspend(() => {
      if (this.readerIsClosed) {
        return Effect.fail(new Error('EBADF: pipe reader is closed'));
      }
      this.readerReferences += 1;
      return Effect.succeed(this.reader());
    });
  }

  private duplicateWriter(): Effect.Effect<TraceKernelDescriptor, Error> {
    return Effect.suspend(() => {
      if (this.writerIsClosed) {
        return Effect.fail(new Error('EBADF: pipe writer is closed'));
      }
      this.writerReferences += 1;
      return Effect.succeed(this.writer());
    });
  }

  private takeBytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
    if (bytes.byteLength <= maxBytes) return bytes;
    const result = bytes.slice(0, maxBytes);
    this.remainder = bytes.slice(maxBytes);
    return result;
  }

  private takeRemainder(maxBytes: number): Uint8Array {
    const result = this.remainder.slice(0, maxBytes);
    this.remainder = this.remainder.slice(result.byteLength);
    return result;
  }

  private notifyIfFullyClosed(): void {
    if (this.readerIsClosed && this.writerIsClosed) this.onFullyClosed(this.id);
  }

  private readerClosedError(): Effect.Effect<never, TraceKernelBadFileDescriptorError> {
    return Effect.fail(new TraceKernelBadFileDescriptorError({
      fd: -1,
      operation: 'read',
      message: 'EBADF: pipe reader is closed',
    }));
  }

  private brokenPipeError(): Effect.Effect<never, TraceKernelBrokenPipeError> {
    return Effect.fail(new TraceKernelBrokenPipeError({
      message: 'EPIPE: broken pipe',
    }));
  }
}
