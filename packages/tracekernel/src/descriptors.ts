import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Queue from 'effect/Queue';
import {
  TraceKernelBadFileDescriptorError,
  TraceKernelBrokenPipeError,
  TraceKernelDescriptorLimitError,
  TraceKernelInvalidArgumentError,
  TraceKernelInvalidDescriptorOperationError,
  TraceKernelTerminalError,
  TraceKernelWouldBlockError,
} from './errors';
import type { TraceKernelStat } from './vfs';

export type TraceKernelDescriptorKind =
  | 'device'
  | 'file'
  | 'pipe-reader'
  | 'pipe-writer'
  | 'fs-watch'
  | 'terminal'
  | 'tcp-socket';

export interface TraceKernelDescriptorSnapshot {
  readonly fd: number;
  readonly kind: TraceKernelDescriptorKind;
  readonly resourceId: string;
  readonly closeOnExec: boolean;
  readonly nonblocking: boolean;
}

export interface TraceKernelPollEvents {
  readonly read: boolean;
  readonly write: boolean;
}

export interface TraceKernelDescriptorReadiness {
  readonly read: boolean;
  readonly write: boolean;
  readonly hangup: boolean;
  readonly error: boolean;
}

export interface TraceKernelDescriptorOperationContext {
  readonly pid: number;
  readonly pgid: number;
  readonly sid: number;
}

export type TraceKernelSeekWhence = 'set' | 'current' | 'end';

export interface TraceKernelDescriptor {
  readonly kind: TraceKernelDescriptorKind;
  readonly resourceId: string;
  /**
   * Kernel-private backing resource used by typed session control operations.
   * It is never included in descriptor snapshots or syscall responses.
   */
  readonly resource?: unknown;
  read?(
    maxBytes: number,
    position?: number,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<Uint8Array, Error>;
  readNonblocking?(
    maxBytes: number,
    position?: number,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<Uint8Array, Error>;
  write?(
    bytes: Uint8Array,
    position?: number,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<number, Error>;
  writeNonblocking?(
    bytes: Uint8Array,
    position?: number,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<number, Error>;
  readiness?(
    events: TraceKernelPollEvents,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<TraceKernelDescriptorReadiness, Error>;
  awaitReadiness?(
    events: TraceKernelPollEvents,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<TraceKernelDescriptorReadiness, Error>;
  stat?(): Effect.Effect<TraceKernelStat, Error>;
  truncate?(
    length: number,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<void, Error>;
  seek?(
    offset: number,
    whence: TraceKernelSeekWhence
  ): Effect.Effect<number, Error>;
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
  | TraceKernelInvalidDescriptorOperationError
  | TraceKernelTerminalError
  | TraceKernelWouldBlockError;

export type TraceKernelDescriptorWriteError =
  | TraceKernelBadFileDescriptorError
  | TraceKernelInvalidDescriptorOperationError
  | TraceKernelBrokenPipeError
  | TraceKernelTerminalError
  | TraceKernelWouldBlockError;

export type TraceKernelDescriptorSeekError =
  | TraceKernelBadFileDescriptorError
  | TraceKernelInvalidArgumentError;

export interface TraceKernelDescriptorTableOptions {
  readonly maxDescriptors?: number;
  readonly operationContext?: () => TraceKernelDescriptorOperationContext;
}

export interface TraceKernelDescriptorReplacement {
  readonly fd: number;
  readonly descriptor: TraceKernelDescriptor;
  readonly closeOnExec?: boolean;
  readonly nonblocking?: boolean;
}

interface TraceKernelOpenDescriptionStatus {
  nonblocking: boolean;
}

const openDescriptionStatuses = new WeakMap<
  TraceKernelDescriptor,
  TraceKernelOpenDescriptionStatus
>();

function statusFor(
  descriptor: TraceKernelDescriptor
): TraceKernelOpenDescriptionStatus {
  let status = openDescriptionStatuses.get(descriptor);
  if (!status) {
    status = { nonblocking: false };
    openDescriptionStatuses.set(descriptor, status);
  }
  return status;
}

function shareStatus(
  source: TraceKernelDescriptor,
  duplicate: TraceKernelDescriptor
): TraceKernelDescriptor {
  openDescriptionStatuses.set(duplicate, statusFor(source));
  return duplicate;
}

export type TraceKernelDescriptorDupError =
  | TraceKernelBadFileDescriptorError
  | TraceKernelDescriptorLimitError;

export type TraceKernelDescriptorDup3Error =
  | TraceKernelDescriptorDupError
  | TraceKernelInvalidArgumentError;

export type TraceKernelDescriptorInheritanceError =
  | TraceKernelBadFileDescriptorError
  | TraceKernelDescriptorLimitError;

export class TraceKernelDescriptorTable {
  private readonly descriptors = new Map<number, TraceKernelDescriptor>();
  private readonly closeOnExecDescriptors = new Set<number>();
  private nextFd = 3;
  readonly maxDescriptors: number;
  private readonly operationContext?: () => TraceKernelDescriptorOperationContext;

  constructor(options: TraceKernelDescriptorTableOptions = {}) {
    const requested = Number(options.maxDescriptors ?? 1024);
    this.maxDescriptors = Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : 1024;
    this.operationContext = options.operationContext;
  }

  install(
    descriptor: TraceKernelDescriptor,
    options: {
      readonly closeOnExec?: boolean;
      readonly nonblocking?: boolean;
    } = {}
  ): number {
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
    if (options.nonblocking) statusFor(descriptor).nonblocking = true;
    if (options.closeOnExec) this.closeOnExecDescriptors.add(fd);
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
  installAt(
    fd: number,
    descriptor: TraceKernelDescriptor,
    options: {
      readonly closeOnExec?: boolean;
      readonly nonblocking?: boolean;
    } = {}
  ): number {
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
    if (options.nonblocking) statusFor(descriptor).nonblocking = true;
    if (options.closeOnExec) this.closeOnExecDescriptors.add(targetFd);
    if (targetFd === this.nextFd) this.resetNextFd();
    return targetFd;
  }

  /**
   * Atomically replace a set of descriptor identities.
   *
   * Validation happens before the table changes. Once committed, every target
   * refers to its new open description before any replaced description is
   * closed, so observers cannot see partially remapped stdio.
   */
  replaceMany(
    replacements: readonly TraceKernelDescriptorReplacement[]
  ): Effect.Effect<
    void,
    TraceKernelBadFileDescriptorError | TraceKernelDescriptorLimitError
  > {
    return Effect.gen(this, function* () {
      const targets = new Set<number>();
      for (const replacement of replacements) {
        const fd = Math.floor(replacement.fd);
        if (
          !Number.isSafeInteger(replacement.fd) ||
          fd < 0 ||
          targets.has(fd)
        ) {
          yield* Effect.forEach(
            replacements,
            ({ descriptor }) => descriptor.close(),
            { concurrency: 'unbounded', discard: true }
          );
          return yield* Effect.fail(new TraceKernelBadFileDescriptorError({
            fd,
            operation: 'dup2',
            message: targets.has(fd)
              ? `EBADF: duplicate replacement descriptor ${fd}`
              : `EBADF: invalid replacement descriptor ${replacement.fd}`,
          }));
        }
        targets.add(fd);
      }

      const occupiedTargets = [...targets].filter((fd) =>
        this.descriptors.has(fd)
      ).length;
      const resultingSize =
        this.descriptors.size - occupiedTargets + replacements.length;
      if (resultingSize > this.maxDescriptors) {
        yield* Effect.forEach(
          replacements,
          ({ descriptor }) => descriptor.close(),
          { concurrency: 'unbounded', discard: true }
        );
        return yield* Effect.fail(new TraceKernelDescriptorLimitError({
          code: 'EMFILE',
          maxDescriptors: this.maxDescriptors,
          message: `EMFILE: descriptor replacement exceeds process descriptor limit ${this.maxDescriptors}`,
        }));
      }

      const replaced = replacements.flatMap(({ fd }) => {
        const descriptor = this.descriptors.get(fd);
        return descriptor ? [descriptor] : [];
      });
      for (const replacement of replacements) {
        this.descriptors.set(replacement.fd, replacement.descriptor);
        if (replacement.closeOnExec) {
          this.closeOnExecDescriptors.add(replacement.fd);
        } else {
          this.closeOnExecDescriptors.delete(replacement.fd);
        }
        statusFor(replacement.descriptor).nonblocking =
          replacement.nonblocking === true;
      }
      this.resetNextFd();
      yield* Effect.forEach(
        replaced,
        (descriptor) => descriptor.close(),
        { concurrency: 'unbounded', discard: true }
      );
    });
  }

  snapshots(): readonly TraceKernelDescriptorSnapshot[] {
    return [...this.descriptors.entries()]
      .map(([fd, descriptor]) => Object.freeze({
        fd,
        kind: descriptor.kind,
        resourceId: descriptor.resourceId,
        closeOnExec: this.closeOnExecDescriptors.has(fd),
        nonblocking: statusFor(descriptor).nonblocking,
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

  getCloseOnExec(
    fd: number
  ): Effect.Effect<boolean, TraceKernelBadFileDescriptorError> {
    return this.descriptors.has(fd)
      ? Effect.succeed(this.closeOnExecDescriptors.has(fd))
      : Effect.fail(new TraceKernelBadFileDescriptorError({
          fd,
          operation: 'fcntl',
          message: `EBADF: bad file descriptor, fcntl ${fd}`,
        }));
  }

  setCloseOnExec(
    fd: number,
    closeOnExec: boolean
  ): Effect.Effect<void, TraceKernelBadFileDescriptorError> {
    if (!this.descriptors.has(fd)) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'fcntl',
        message: `EBADF: bad file descriptor, fcntl ${fd}`,
      }));
    }
    if (closeOnExec) this.closeOnExecDescriptors.add(fd);
    else this.closeOnExecDescriptors.delete(fd);
    return Effect.void;
  }

  getNonblocking(
    fd: number
  ): Effect.Effect<boolean, TraceKernelBadFileDescriptorError> {
    const descriptor = this.descriptors.get(fd);
    return descriptor
      ? Effect.succeed(statusFor(descriptor).nonblocking)
      : Effect.fail(new TraceKernelBadFileDescriptorError({
          fd,
          operation: 'fcntl',
          message: `EBADF: bad file descriptor, fcntl ${fd}`,
        }));
  }

  setNonblocking(
    fd: number,
    nonblocking: boolean
  ): Effect.Effect<void, TraceKernelBadFileDescriptorError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'fcntl',
        message: `EBADF: bad file descriptor, fcntl ${fd}`,
      }));
    }
    statusFor(descriptor).nonblocking = nonblocking;
    return Effect.void;
  }

  readiness(
    fd: number,
    events: TraceKernelPollEvents
  ): Effect.Effect<
    TraceKernelDescriptorReadiness,
    TraceKernelBadFileDescriptorError
  > {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'poll',
        message: `EBADF: bad file descriptor, poll ${fd}`,
      }));
    }
    if (descriptor.readiness) {
      return descriptor.readiness(events, this.operationContext?.()).pipe(
        Effect.mapError((error) => new TraceKernelBadFileDescriptorError({
          fd,
          operation: 'poll',
          message: error.message,
        }))
      );
    }
    return Effect.succeed(Object.freeze({
      read: events.read && descriptor.kind === 'file' && Boolean(descriptor.read),
      write: events.write && descriptor.kind === 'file' && Boolean(descriptor.write),
      hangup: false,
      error: false,
    }));
  }

  awaitReadiness(
    fd: number,
    events: TraceKernelPollEvents
  ): Effect.Effect<
    TraceKernelDescriptorReadiness,
    TraceKernelBadFileDescriptorError
  > {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'poll',
        message: `EBADF: bad file descriptor, poll ${fd}`,
      }));
    }
    if (descriptor.awaitReadiness) {
      return descriptor.awaitReadiness(events, this.operationContext?.()).pipe(
        Effect.mapError((error) => new TraceKernelBadFileDescriptorError({
          fd,
          operation: 'poll',
          message: error.message,
        }))
      );
    }
    if (descriptor.kind === 'file') return this.readiness(fd, events);
    return Effect.never;
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
    const read = statusFor(descriptor).nonblocking && descriptor.readNonblocking
      ? descriptor.readNonblocking
      : descriptor.read;
    return read(
      Math.max(0, Math.floor(maxBytes)),
      position === undefined ? undefined : Math.max(0, Math.floor(position)),
      this.operationContext?.()
    ).pipe(
      Effect.mapError((error) =>
        error instanceof TraceKernelBadFileDescriptorError ||
        error instanceof TraceKernelTerminalError ||
        error instanceof TraceKernelWouldBlockError
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
    const write = statusFor(descriptor).nonblocking && descriptor.writeNonblocking
      ? descriptor.writeNonblocking
      : descriptor.write;
    return write(
      Uint8Array.from(bytes),
      position === undefined ? undefined : Math.max(0, Math.floor(position)),
      this.operationContext?.()
    ).pipe(
      Effect.mapError((error) =>
        error instanceof TraceKernelBrokenPipeError ||
        error instanceof TraceKernelTerminalError ||
        error instanceof TraceKernelWouldBlockError
        ? error
        : new TraceKernelBadFileDescriptorError({
            fd,
            operation: 'write',
            message: error.message,
          }))
    );
  }

  seek(
    fd: number,
    offset: number,
    whence: TraceKernelSeekWhence
  ): Effect.Effect<number, TraceKernelDescriptorSeekError> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor?.seek) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: 'seek',
        message: `EBADF: descriptor ${fd} does not support seek`,
      }));
    }
    if (!Number.isSafeInteger(offset)) {
      return Effect.fail(new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'offset',
        message: `EINVAL: invalid seek offset ${offset}`,
      }));
    }
    return descriptor.seek(offset, whence).pipe(
      Effect.mapError((error) =>
        error instanceof TraceKernelInvalidArgumentError
          ? error
          : new TraceKernelBadFileDescriptorError({
              fd,
              operation: 'seek',
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
    return descriptor.truncate(
      Math.max(0, Math.floor(length)),
      this.operationContext?.()
    ).pipe(
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
      Effect.map((duplicate) => shareStatus(descriptor, duplicate)),
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
    return this.duplicateTo(fd, targetFd, false, true);
  }

  dup3(
    fd: number,
    targetFd: number,
    closeOnExec: boolean
  ): Effect.Effect<number, TraceKernelDescriptorDup3Error> {
    return this.duplicateTo(fd, targetFd, closeOnExec, false);
  }

  private duplicateTo(
    fd: number,
    targetFd: number,
    closeOnExec: boolean,
    allowSameDescriptor: true
  ): Effect.Effect<number, TraceKernelDescriptorDupError>;
  private duplicateTo(
    fd: number,
    targetFd: number,
    closeOnExec: boolean,
    allowSameDescriptor: false
  ): Effect.Effect<number, TraceKernelDescriptorDup3Error>;
  private duplicateTo(
    fd: number,
    targetFd: number,
    closeOnExec: boolean,
    allowSameDescriptor: boolean
  ): Effect.Effect<number, TraceKernelDescriptorDup3Error> {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd,
        operation: allowSameDescriptor ? 'dup2' : 'dup3',
        message: `EBADF: bad file descriptor, ${allowSameDescriptor ? 'dup2' : 'dup3'} ${fd}`,
      }));
    }
    const target = Math.floor(targetFd);
    if (!Number.isSafeInteger(targetFd) || target < 0) {
      return Effect.fail(new TraceKernelBadFileDescriptorError({
        fd: target,
        operation: allowSameDescriptor ? 'dup2' : 'dup3',
        message: `EBADF: invalid target descriptor ${targetFd}`,
      }));
    }
    if (fd === target) {
      return allowSameDescriptor
        ? Effect.succeed(target)
        : Effect.fail(new TraceKernelInvalidArgumentError({
            code: 'EINVAL',
            argument: 'targetFd',
            message: `EINVAL: dup3 source and target are both ${fd}`,
          }));
    }

    const replaced = this.descriptors.get(target);
    if (!replaced && this.descriptors.size >= this.maxDescriptors) {
      return Effect.fail(new TraceKernelDescriptorLimitError({
        code: 'EMFILE',
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: process descriptor limit ${this.maxDescriptors} reached`,
      }));
    }

    return descriptor.duplicate().pipe(
      Effect.map((duplicate) => shareStatus(descriptor, duplicate)),
      Effect.mapError((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: allowSameDescriptor ? 'dup2' : 'dup3',
        message: error.message,
      })),
      Effect.flatMap((duplicate) =>
        Effect.sync(() => {
          this.descriptors.set(target, duplicate);
          if (closeOnExec) this.closeOnExecDescriptors.add(target);
          else this.closeOnExecDescriptors.delete(target);
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
          ? [...source.descriptors.keys()]
              .filter((fd) => !source.closeOnExecDescriptors.has(fd))
              .sort((left, right) => left - right)
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
          Effect.map((duplicate) => shareStatus(descriptor, duplicate)),
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
    this.closeOnExecDescriptors.delete(fd);
    if (fd < this.nextFd) this.nextFd = fd;
    return descriptor.close();
  }

  closeAll(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const descriptors = [...this.descriptors.values()];
      this.descriptors.clear();
      this.closeOnExecDescriptors.clear();
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

export interface TraceKernelPipeOptions {
  readonly capacityChunks?: number;
  /** Install both endpoint descriptors with FD_CLOEXEC. */
  readonly closeOnExec?: boolean;
  /** Install both endpoint open descriptions with O_NONBLOCK. */
  readonly nonblocking?: boolean;
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
    private readinessChanged: Deferred.Deferred<void>,
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
      const readinessChanged = yield* Deferred.make<void>();
      const readMutex = yield* Effect.makeSemaphore(1);
      return new TraceKernelPipe(
        id,
        chunks,
        readerClosed,
        writerClosed,
        readinessChanged,
        readMutex,
        onFullyClosed
      );
    });
  }

  reader(): TraceKernelReadableDescriptor {
    return {
      kind: 'pipe-reader',
      resourceId: this.id,
      read: (maxBytes) => this.read(maxBytes).pipe(
        Effect.tap(() => this.notifyReadiness())
      ),
      readNonblocking: (maxBytes) => this.readNonblocking(maxBytes).pipe(
        Effect.tap(() => this.notifyReadiness())
      ),
      readiness: (events) => this.pipeReadiness('reader', events),
      awaitReadiness: (events) => this.awaitPipeReadiness('reader', events),
      duplicate: () => this.duplicateReader(),
      close: () => this.closeReader(),
    };
  }

  writer(): TraceKernelWritableDescriptor {
    return {
      kind: 'pipe-writer',
      resourceId: this.id,
      write: (bytes) => this.write(bytes).pipe(
        Effect.tap(() => this.notifyReadiness())
      ),
      writeNonblocking: (bytes) => this.writeNonblocking(bytes).pipe(
        Effect.tap(() => this.notifyReadiness())
      ),
      readiness: (events) => this.pipeReadiness('writer', events),
      awaitReadiness: (events) => this.awaitPipeReadiness('writer', events),
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

  private readNonblocking(
    maxBytes: number
  ): Effect.Effect<
    Uint8Array,
    TraceKernelBadFileDescriptorError | TraceKernelWouldBlockError
  > {
    if (maxBytes === 0) return Effect.succeed(new Uint8Array(0));
    return this.readMutex.withPermits(1)(
      Effect.suspend((): Effect.Effect<
        Uint8Array,
        TraceKernelBadFileDescriptorError | TraceKernelWouldBlockError
      > => {
        if (this.readerIsClosed) return this.readerClosedError();
        if (this.remainder.byteLength > 0) {
          return Effect.succeed(this.takeRemainder(maxBytes));
        }
        return Queue.poll(this.chunks).pipe(
          Effect.flatMap((available) => {
            if (Option.isSome(available)) {
              return Effect.succeed(this.takeBytes(available.value, maxBytes));
            }
            if (this.writerIsClosed) return Effect.succeed(new Uint8Array(0));
            return Effect.fail(new TraceKernelWouldBlockError({
              code: 'EAGAIN',
              operation: 'read',
              message: 'EAGAIN: nonblocking pipe read would block',
            }));
          })
        );
      })
    );
  }

  private awaitReadEvent(maxBytes: number): Effect.Effect<Uint8Array, TraceKernelBadFileDescriptorError> {
    return Effect.suspend(() => {
      const changed = this.readinessChanged;
      if (this.readerIsClosed) return this.readerClosedError();
      return Queue.poll(this.chunks).pipe(
        Effect.flatMap((available) => {
          if (Option.isSome(available)) {
            return Effect.succeed(this.takeBytes(available.value, maxBytes));
          }
          if (this.readerIsClosed) return this.readerClosedError();
          if (this.writerIsClosed) return Effect.succeed(new Uint8Array(0));
          return Deferred.await(changed).pipe(
            Effect.andThen(this.awaitReadEvent(maxBytes))
          );
        })
      );
    });
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

  private writeNonblocking(
    bytes: Uint8Array
  ): Effect.Effect<number, TraceKernelBrokenPipeError | TraceKernelWouldBlockError> {
    return Effect.suspend((): Effect.Effect<
      number,
      TraceKernelBrokenPipeError | TraceKernelWouldBlockError
    > => {
      if (this.writerIsClosed || this.readerIsClosed) return this.brokenPipeError();
      if (bytes.byteLength === 0) return Effect.succeed(0);
      return Queue.isFull(this.chunks).pipe(
        Effect.flatMap((full) => full
          ? Effect.fail(new TraceKernelWouldBlockError({
              code: 'EAGAIN',
              operation: 'write',
              message: 'EAGAIN: nonblocking pipe write would block',
            }))
          : Queue.offer(this.chunks, Uint8Array.from(bytes)).pipe(
              Effect.as(bytes.byteLength)
            ))
      );
    });
  }

  private pipeReadiness(
    endpoint: 'reader' | 'writer',
    events: TraceKernelPollEvents
  ): Effect.Effect<TraceKernelDescriptorReadiness> {
    return Effect.all({
      empty: Queue.isEmpty(this.chunks),
      full: Queue.isFull(this.chunks),
    }).pipe(
      Effect.map(({ empty, full }) => {
        const hangup = endpoint === 'reader'
          ? this.writerIsClosed
          : this.readerIsClosed;
        return Object.freeze({
          read: endpoint === 'reader' &&
            events.read &&
            (this.remainder.byteLength > 0 || !empty || this.writerIsClosed),
          write: endpoint === 'writer' &&
            events.write &&
            !this.readerIsClosed &&
            !full,
          hangup,
          error: endpoint === 'writer' && this.readerIsClosed,
        });
      })
    );
  }

  private awaitPipeReadiness(
    endpoint: 'reader' | 'writer',
    events: TraceKernelPollEvents
  ): Effect.Effect<TraceKernelDescriptorReadiness> {
    return Effect.suspend(() => {
      const changed = this.readinessChanged;
      return this.pipeReadiness(endpoint, events).pipe(
        Effect.flatMap((readiness) =>
          readiness.read ||
          readiness.write ||
          readiness.hangup ||
          readiness.error
            ? Effect.succeed(readiness)
            : Deferred.await(changed).pipe(
                Effect.andThen(this.awaitPipeReadiness(endpoint, events))
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

  private closeReader(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.readerIsClosed) return Effect.void;
      this.readerReferences -= 1;
      if (this.readerReferences > 0) return Effect.void;
      this.readerIsClosed = true;
      return Deferred.succeed(this.readerClosed, undefined).pipe(
        Effect.asVoid,
        Effect.tap(() => this.notifyReadiness()),
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
        Effect.tap(() => this.notifyReadiness()),
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
