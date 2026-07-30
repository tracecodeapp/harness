import {
  BrowserBuffer,
} from "../internal/encoding";

import {
  BrowserEventEmitter,
} from "./events-util";

export const streamInternalCloseListeners = new WeakMap<object, Set<() => void>>();

export function setStreamInternalCloseListeners(stream: object, listeners: Set<() => void>): void {
  streamInternalCloseListeners.set(stream, listeners);
}

export function addStreamInternalCloseListener(stream: unknown, listener: () => void): void {
  if ((typeof stream !== 'object' && typeof stream !== 'function') || stream === null) return;
  streamInternalCloseListeners.get(stream)?.add(listener);
}

export function createStreamApi() {
  class PassThrough extends BrowserEventEmitter {
    ended = false;

    write(chunk: unknown): boolean {
      if (this.ended) throw new Error('write after end');
      this.emit('data', BrowserBuffer.isBuffer(chunk) ? chunk : BrowserBuffer.from(chunk as never));
      return true;
    }

    end(chunk?: unknown): this {
      if (chunk !== undefined) this.write(chunk);
      this.ended = true;
      this.emit('end');
      this.emit('finish');
      return this;
    }

    pipe(destination: { write(chunk: unknown): unknown; end?: () => unknown }): typeof destination {
      this.on('data', (chunk) => destination.write(chunk));
      this.on('end', () => destination.end?.());
      return destination;
    }
  }
  return {
    Stream: BrowserEventEmitter,
    Readable: PassThrough,
    Writable: PassThrough,
    Duplex: PassThrough,
    Transform: PassThrough,
    PassThrough,
  };
}
