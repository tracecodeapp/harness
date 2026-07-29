import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import {
  TraceKernelTerminalError,
  TraceKernelWouldBlockError,
} from './errors';
import type {
  TraceKernelDescriptor,
  TraceKernelDescriptorOperationContext,
  TraceKernelDescriptorReadiness,
  TraceKernelPollEvents,
} from './descriptors';

export type TraceKernelTerminalAccess = 'read' | 'write' | 'read-write';

export interface TraceKernelTerminalOptions {
  readonly name?: string;
  readonly columns?: number;
  readonly rows?: number;
}

export interface TraceKernelTerminalSnapshot {
  readonly id: string;
  readonly name: string;
  readonly sessionId: number;
  readonly foregroundProcessGroupId: number;
  readonly columns: number;
  readonly rows: number;
  readonly closed: boolean;
}

interface TerminalByteStream {
  chunks: Uint8Array[];
  remainder: Uint8Array;
  eofPending: number;
  changed: Deferred.Deferred<void>;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

/**
 * Session-owned controlling terminal.
 *
 * The terminal is the shared open resource; descriptor duplicates only retain
 * access mode and refer back to it. Input is written by the host and read by
 * processes, while process writes are read by the host from the output side.
 * Foreground process-group policy remains in TraceKernelSession because it
 * requires live process topology and signal delivery.
 */
export class TraceKernelTerminal {
  private closed = false;

  private constructor(
    readonly id: string,
    readonly name: string,
    readonly sessionId: number,
    private foregroundProcessGroupId: number,
    private columns: number,
    private rows: number,
    private readonly input: TerminalByteStream,
    private readonly output: TerminalByteStream
  ) {}

  static make(
    id: string,
    sessionId: number,
    foregroundProcessGroupId: number,
    options: TraceKernelTerminalOptions = {}
  ): Effect.Effect<TraceKernelTerminal> {
    return Effect.gen(function* () {
      const inputChanged = yield* Deferred.make<void>();
      const outputChanged = yield* Deferred.make<void>();
      return new TraceKernelTerminal(
        id,
        options.name?.trim() || `/dev/${id}`,
        sessionId,
        foregroundProcessGroupId,
        normalizeDimension(options.columns, 80),
        normalizeDimension(options.rows, 24),
        {
          chunks: [],
          remainder: new Uint8Array(0),
          eofPending: 0,
          changed: inputChanged,
        },
        {
          chunks: [],
          remainder: new Uint8Array(0),
          eofPending: 0,
          changed: outputChanged,
        }
      );
    });
  }

  snapshot(): TraceKernelTerminalSnapshot {
    return Object.freeze({
      id: this.id,
      name: this.name,
      sessionId: this.sessionId,
      foregroundProcessGroupId: this.foregroundProcessGroupId,
      columns: this.columns,
      rows: this.rows,
      closed: this.closed,
    });
  }

  setForegroundProcessGroup(processGroupId: number): void {
    this.foregroundProcessGroupId = processGroupId;
  }

  resize(columns: number, rows: number): void {
    this.columns = normalizeDimension(columns, this.columns);
    this.rows = normalizeDimension(rows, this.rows);
  }

  descriptor(access: TraceKernelTerminalAccess): TraceKernelDescriptor {
    const readable = access !== 'write';
    const writable = access !== 'read';
    return {
      kind: 'terminal',
      resourceId: this.id,
      resource: this,
      ...(readable
        ? {
            read: (
              maxBytes: number,
              _position?: number,
              context?: TraceKernelDescriptorOperationContext
            ) => this.readInput(maxBytes, false, context),
            readNonblocking: (
              maxBytes: number,
              _position?: number,
              context?: TraceKernelDescriptorOperationContext
            ) => this.readInput(maxBytes, true, context),
          }
        : {}),
      ...(writable
        ? {
            write: (
              bytes: Uint8Array,
              _position?: number,
              context?: TraceKernelDescriptorOperationContext
            ) => this.writeOutput(bytes, context),
            writeNonblocking: (
              bytes: Uint8Array,
              _position?: number,
              context?: TraceKernelDescriptorOperationContext
            ) => this.writeOutput(bytes, context),
          }
        : {}),
      readiness: (events, context) =>
        this.descriptorReadiness(events, readable, writable, context),
      awaitReadiness: (events, context) =>
        this.awaitDescriptorReadiness(events, readable, writable, context),
      duplicate: () => Effect.succeed(this.descriptor(access)),
      close: () => Effect.void,
    };
  }

  writeInput(bytes: Uint8Array): Effect.Effect<number, TraceKernelTerminalError> {
    return this.writeStream(this.input, bytes);
  }

  signalInputEof(): Effect.Effect<void, TraceKernelTerminalError> {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(new TraceKernelTerminalError({
          code: 'EIO',
          message: `EIO: terminal ${this.name} is closed`,
        }));
      }
      this.input.eofPending += 1;
      this.wake(this.input);
      return Effect.void;
    });
  }

  readOutput(
    maxBytes: number,
    nonblocking = false
  ): Effect.Effect<Uint8Array, TraceKernelTerminalError | TraceKernelWouldBlockError> {
    return this.readStream(this.output, maxBytes, nonblocking);
  }

  discardInput(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.input.chunks.length = 0;
      this.input.remainder = new Uint8Array(0);
      this.input.eofPending = 0;
      this.wake(this.input);
    });
  }

  dispose(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.closed) return;
      this.closed = true;
      this.wake(this.input);
      this.wake(this.output);
    });
  }

  private readInput(
    maxBytes: number,
    nonblocking = false,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<Uint8Array, TraceKernelTerminalError | TraceKernelWouldBlockError> {
    const accessError = this.processAccessError(context, 'read');
    if (accessError) return Effect.fail(accessError);
    return this.readStream(this.input, maxBytes, nonblocking, true);
  }

  private writeOutput(
    bytes: Uint8Array,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<number, TraceKernelTerminalError> {
    const accessError = this.processAccessError(context, 'write');
    if (accessError) return Effect.fail(accessError);
    return this.writeStream(this.output, bytes);
  }

  private writeStream(
    stream: TerminalByteStream,
    bytes: Uint8Array
  ): Effect.Effect<number, TraceKernelTerminalError> {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(new TraceKernelTerminalError({
          code: 'EIO',
          message: `EIO: terminal ${this.name} is closed`,
        }));
      }
      const copy = Uint8Array.from(bytes);
      if (copy.byteLength === 0) return Effect.succeed(0);
      stream.chunks.push(copy);
      this.wake(stream);
      return Effect.succeed(copy.byteLength);
    });
  }

  private readStream(
    stream: TerminalByteStream,
    maxBytes: number,
    nonblocking: boolean,
    consumeEof = false
  ): Effect.Effect<Uint8Array, TraceKernelTerminalError | TraceKernelWouldBlockError> {
    const requested = Math.max(0, Math.floor(maxBytes));
    if (requested === 0) return Effect.succeed(new Uint8Array(0));
    return Effect.suspend(() => {
      const available = this.takeBytes(stream, requested);
      if (available) return Effect.succeed(available);
      if (consumeEof && stream.eofPending > 0) {
        stream.eofPending -= 1;
        return Effect.succeed(new Uint8Array(0));
      }
      if (this.closed) return Effect.succeed(new Uint8Array(0));
      if (nonblocking) {
        return Effect.fail(new TraceKernelWouldBlockError({
          code: 'EAGAIN',
          operation: 'read',
          message: `EAGAIN: terminal ${this.name} has no readable bytes`,
        }));
      }
      const changed = stream.changed;
      return Deferred.await(changed).pipe(
        Effect.andThen(
          this.readStream(stream, requested, false, consumeEof)
        )
      );
    });
  }

  private takeBytes(
    stream: TerminalByteStream,
    maxBytes: number
  ): Uint8Array | undefined {
    let current = stream.remainder;
    if (current.byteLength === 0) {
      current = stream.chunks.shift() ?? current;
    }
    if (current.byteLength === 0) return undefined;
    const length = Math.min(maxBytes, current.byteLength);
    const result = current.slice(0, length);
    stream.remainder = current.slice(length);
    return result;
  }

  private descriptorReadiness(
    events: TraceKernelPollEvents,
    readable: boolean,
    writable: boolean,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<TraceKernelDescriptorReadiness> {
    return Effect.sync(() => {
      const readableByProcess = !this.processAccessError(context, 'read');
      const writableByProcess = !this.processAccessError(context, 'write');
      return Object.freeze({
      read: events.read && readable && readableByProcess && (
        this.closed ||
        this.input.eofPending > 0 ||
        this.input.remainder.byteLength > 0 ||
        this.input.chunks.length > 0
      ),
      write: events.write && writable && writableByProcess && !this.closed,
      hangup: this.closed,
      error:
        (events.read && readable && !readableByProcess) ||
        (events.write && writable && !writableByProcess),
    });
    });
  }

  private awaitDescriptorReadiness(
    events: TraceKernelPollEvents,
    readable: boolean,
    writable: boolean,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<TraceKernelDescriptorReadiness> {
    return this.descriptorReadiness(events, readable, writable, context).pipe(
      Effect.flatMap((readiness) =>
        readiness.read || readiness.write || readiness.hangup || readiness.error
          ? Effect.succeed(readiness)
          : Deferred.await(this.input.changed).pipe(
              Effect.andThen(
                this.awaitDescriptorReadiness(
                  events,
                  readable,
                  writable,
                  context
                )
              )
            )
      )
    );
  }

  private wake(stream: TerminalByteStream): void {
    const changed = stream.changed;
    stream.changed = Effect.runSync(Deferred.make<void>());
    Effect.runSync(Deferred.succeed(changed, undefined));
  }

  private processAccessError(
    context: TraceKernelDescriptorOperationContext | undefined,
    operation: 'read' | 'write'
  ): TraceKernelTerminalError | undefined {
    if (!context || context.sid !== this.sessionId) {
      return new TraceKernelTerminalError({
        code: 'EIO',
        message: `EIO: process has no controlling terminal ${this.name}`,
      });
    }
    if (
      operation === 'read' &&
      context.pgid !== this.foregroundProcessGroupId
    ) {
      return new TraceKernelTerminalError({
        code: 'EIO',
        message: `EIO: background process group ${context.pgid} cannot read terminal ${this.name}`,
      });
    }
    return undefined;
  }
}
