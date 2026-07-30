import * as Effect from 'effect/Effect';
import type { TraceKernelSyscallDispatcher } from '../syscalls';
import type { TraceKernelSyscallRequest, TraceKernelSyscallResult } from '../syscalls';
import {
  TraceKernelTransportError,
  decodeTraceKernelSyscallRequest,
  decodeTraceKernelSyscallResult,
  encodeTraceKernelSyscallRequest,
  encodeTraceKernelSyscallResult,
} from './wire';

const SHARED_HEADER_INTS = 8;
const SHARED_HEADER_BYTES = SHARED_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const STATE_INDEX = 0;
const REQUEST_LENGTH_INDEX = 1;
const RESPONSE_LENGTH_INDEX = 2;
const SEQUENCE_INDEX = 3;

const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_PROCESSING = 2;
const STATE_RESPONSE = 3;
const STATE_CLOSED = 4;
const STATE_WRITING = 5;

export interface TraceKernelSharedSyscallChannel {
  readonly buffer: SharedArrayBuffer;
  readonly byteCapacity: number;
}

export interface TraceKernelSharedSyscallChannelOptions {
  readonly byteCapacity?: number;
}

export function makeTraceKernelSharedSyscallChannel(
  options: TraceKernelSharedSyscallChannelOptions = {}
): TraceKernelSharedSyscallChannel {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
    throw new TraceKernelTransportError(
      'ENOSYS',
      'SharedArrayBuffer and Atomics are required for synchronous syscalls'
    );
  }
  const byteCapacity = Math.max(256, Math.floor(options.byteCapacity ?? 1024 * 1024));
  return Object.freeze({
    buffer: new SharedArrayBuffer(SHARED_HEADER_BYTES + byteCapacity),
    byteCapacity,
  });
}

function validateSharedChannel(
  channel: TraceKernelSharedSyscallChannel
): {
  readonly header: Int32Array;
  readonly payload: Uint8Array;
} {
  if (
    !(channel.buffer instanceof SharedArrayBuffer) ||
    channel.byteCapacity < 256 ||
    channel.buffer.byteLength !== SHARED_HEADER_BYTES + channel.byteCapacity
  ) {
    throw new TraceKernelTransportError('EPROTO', 'invalid shared syscall channel');
  }
  return {
    header: new Int32Array(channel.buffer, 0, SHARED_HEADER_INTS),
    payload: new Uint8Array(channel.buffer, SHARED_HEADER_BYTES),
  };
}

export interface TraceKernelSyncSyscallTransport {
  dispatchSync(request: TraceKernelSyscallRequest): TraceKernelSyscallResult;
}

export interface TraceKernelSharedSyscallClientOptions {
  readonly timeoutMs?: number;
}

export interface TraceKernelSyscallHandler {
  dispatch(request: TraceKernelSyscallRequest): Effect.Effect<TraceKernelSyscallResult>;
}

export function makeTraceKernelPromiseSyscallHandler(
  dispatch: (request: TraceKernelSyscallRequest) => Promise<TraceKernelSyscallResult>
): TraceKernelSyscallHandler {
  return {
    dispatch: (request) => Effect.promise(() => dispatch(request)),
  };
}

/**
 * Dedicated-worker synchronous syscall client.
 *
 * `signalHost` should post a small notification over the dedicated worker's
 * host-observable message channel. It must not depend on a transferred port
 * whose delivery can be queued behind this worker's `Atomics.wait`. Request
 * and response bodies stay in the bounded binary SharedArrayBuffer frame.
 */
export class TraceKernelSharedSyscallClient implements TraceKernelSyncSyscallTransport {
  private readonly header: Int32Array;
  private readonly payload: Uint8Array;
  private readonly timeoutMs: number;
  private closed = false;
  private callCount = 0;

  constructor(
    readonly channel: TraceKernelSharedSyscallChannel,
    private readonly signalHost: () => void,
    options: TraceKernelSharedSyscallClientOptions = {}
  ) {
    const views = validateSharedChannel(channel);
    this.header = views.header;
    this.payload = views.payload;
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 20_000));
  }

  get calls(): number {
    return this.callCount;
  }

  dispatchSync(request: TraceKernelSyscallRequest): TraceKernelSyscallResult {
    if (this.closed) {
      throw new TraceKernelTransportError('ECLOSED', 'shared syscall channel is closed');
    }
    const frame = encodeTraceKernelSyscallRequest(request);
    if (frame.byteLength > this.payload.byteLength) {
      throw new TraceKernelTransportError(
        'E2BIG',
        `request frame requires ${frame.byteLength} bytes; capacity is ${this.payload.byteLength}`
      );
    }
    if (
      Atomics.compareExchange(
        this.header,
        STATE_INDEX,
        STATE_IDLE,
        STATE_WRITING
      ) !== STATE_IDLE
    ) {
      if (Atomics.load(this.header, STATE_INDEX) === STATE_CLOSED) {
        this.closed = true;
        throw new TraceKernelTransportError('ECLOSED', 'shared syscall channel is closed');
      }
      throw new TraceKernelTransportError('EBUSY', 'shared syscall channel already has an active call');
    }

    this.payload.set(frame);
    Atomics.store(this.header, REQUEST_LENGTH_INDEX, frame.byteLength);
    Atomics.store(this.header, RESPONSE_LENGTH_INDEX, 0);
    Atomics.add(this.header, SEQUENCE_INDEX, 1);
    Atomics.store(this.header, STATE_INDEX, STATE_REQUEST);
    this.callCount += 1;
    try {
      this.signalHost();
    } catch (error) {
      Atomics.store(this.header, STATE_INDEX, STATE_IDLE);
      throw error;
    }

    const startedAt = Date.now();
    while (true) {
      const state = Atomics.load(this.header, STATE_INDEX);
      if (state === STATE_RESPONSE) break;
      if (state === STATE_CLOSED) {
        this.closed = true;
        throw new TraceKernelTransportError('ECLOSED', 'shared syscall channel closed while waiting');
      }
      const remaining = this.timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        this.close();
        throw new TraceKernelTransportError('ETIMEDOUT', 'synchronous syscall timed out');
      }
      try {
        Atomics.wait(this.header, STATE_INDEX, state, remaining);
      } catch {
        this.close();
        throw new TraceKernelTransportError(
          'ENOSYS',
          'synchronous Atomics.wait is only available in a dedicated worker'
        );
      }
    }

    const responseLength = Atomics.load(this.header, RESPONSE_LENGTH_INDEX);
    if (responseLength < 0 || responseLength > this.payload.byteLength) {
      this.close();
      throw new TraceKernelTransportError('EPROTO', 'host returned an invalid response length');
    }
    const responseFrame = this.payload.slice(0, responseLength);
    Atomics.store(this.header, REQUEST_LENGTH_INDEX, 0);
    Atomics.store(this.header, RESPONSE_LENGTH_INDEX, 0);
    Atomics.store(this.header, STATE_INDEX, STATE_IDLE);
    Atomics.notify(this.header, STATE_INDEX);
    return decodeTraceKernelSyscallResult(responseFrame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    Atomics.store(this.header, STATE_INDEX, STATE_CLOSED);
    Atomics.notify(this.header, STATE_INDEX);
  }
}
/**
 * Host-side channel service. The embedding worker bridge invokes `service`
 * after receiving the client's lightweight request notification.
 */
export class TraceKernelSharedSyscallServer {
  private readonly header: Int32Array;
  private readonly payload: Uint8Array;

  constructor(
    readonly channel: TraceKernelSharedSyscallChannel,
    private readonly dispatcher: TraceKernelSyscallHandler | TraceKernelSyscallDispatcher
  ) {
    const views = validateSharedChannel(channel);
    this.header = views.header;
    this.payload = views.payload;
  }

  service(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (
        Atomics.compareExchange(
          this.header,
          STATE_INDEX,
          STATE_REQUEST,
          STATE_PROCESSING
        ) !== STATE_REQUEST
      ) {
        return Effect.void;
      }
      const requestLength = Atomics.load(this.header, REQUEST_LENGTH_INDEX);
      if (requestLength < 0 || requestLength > this.payload.byteLength) {
        return Effect.sync(() => this.complete(this.protocolFailure(
          'EPROTO',
          'worker supplied an invalid request length'
        )));
      }

      let request: TraceKernelSyscallRequest;
      try {
        request = decodeTraceKernelSyscallRequest(
          this.payload.slice(0, requestLength)
        );
      } catch (error) {
        return Effect.sync(() => this.complete(this.protocolFailure(
          'EPROTO',
          error instanceof Error ? error.message : String(error)
        )));
      }
      return this.dispatcher.dispatch(request).pipe(
        Effect.tap((result) => Effect.sync(() => this.complete(result))),
        Effect.asVoid
      );
    });
  }

  servicePromise(): Promise<void> {
    return Effect.runPromise(this.service());
  }

  close(): void {
    Atomics.store(this.header, STATE_INDEX, STATE_CLOSED);
    Atomics.notify(this.header, STATE_INDEX);
  }

  private complete(result: TraceKernelSyscallResult): void {
    let frame = encodeTraceKernelSyscallResult(result);
    if (frame.byteLength > this.payload.byteLength) {
      frame = encodeTraceKernelSyscallResult(this.protocolFailure(
        'E2BIG',
        `syscall response exceeds channel capacity ${this.payload.byteLength}`
      ));
    }
    if (Atomics.load(this.header, STATE_INDEX) !== STATE_PROCESSING) return;
    this.payload.set(frame);
    Atomics.store(this.header, RESPONSE_LENGTH_INDEX, frame.byteLength);
    if (
      Atomics.compareExchange(
        this.header,
        STATE_INDEX,
        STATE_PROCESSING,
        STATE_RESPONSE
      ) === STATE_PROCESSING
    ) {
      Atomics.notify(this.header, STATE_INDEX);
    }
  }

  private protocolFailure(
    code: 'E2BIG' | 'EPROTO',
    message: string
  ): TraceKernelSyscallResult {
    return {
      ok: false,
      error: { code, message: `${code}: ${message}` },
    };
  }
}
