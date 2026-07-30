import type {
  RuntimeProjectCommandRequest,
} from "@tracecode/runtime-contracts";

import {
  BrowserBuffer,
} from "../internal/encoding";

export function createReadableStdinDevice(
  readBytes: (size?: number) => Uint8Array,
  remainingBytes: () => number,
  isClosed: () => boolean = () => true,
  schedulePoll: (callback: () => void, delay: number) => unknown = (callback, delay) => setTimeout(callback, delay),
  terminal?: RuntimeProjectCommandRequest['terminal'],
  kernelIsTerminal?: boolean
) {
  let encoding: string | undefined;
  let flowScheduled = false;
  let pollScheduled = false;
  let destroyed = false;
  let ended = false;
  let readableFlowing: boolean | null = null;
  let rawMode = false;
  const dataListeners: Array<(chunk?: BrowserBuffer | string) => void> = [];
  const endListeners: Array<(chunk?: BrowserBuffer | string) => void> = [];

  const formatChunk = (chunk: BrowserBuffer): BrowserBuffer | string => (
    encoding ? chunk.toString(encoding) : chunk
  );
  const read = (size?: number): BrowserBuffer | string | null => {
    if (remainingBytes() <= 0) {
      ended = isClosed();
      return null;
    }
    const requested = typeof size === 'number' && size >= 0 ? Math.floor(size) : undefined;
    const chunk = BrowserBuffer.from(readBytes(requested));
    if (remainingBytes() <= 0) ended = isClosed();
    return formatChunk(chunk);
  };
  const scheduleFlow = (): void => {
    if (flowScheduled) return;
    if (readableFlowing === false) return;
    flowScheduled = true;
    queueMicrotask(() => {
      if (destroyed) return;
      const chunk = read();
      if (chunk !== null) {
        for (const listener of dataListeners) listener(chunk);
        if (ended) {
          for (const listener of endListeners) listener();
        } else {
          flowScheduled = false;
          scheduleFlow();
        }
        return;
      }
      if (!isClosed()) {
        flowScheduled = false;
        if (!pollScheduled) {
          pollScheduled = true;
          schedulePoll(() => {
            pollScheduled = false;
            scheduleFlow();
          }, 8);
        }
        return;
      }
      ended = true;
      for (const listener of endListeners) listener();
    });
  };
  const on = (event: string, listener: (chunk?: BrowserBuffer | string) => void) => {
    if (event === 'data') {
      dataListeners.push(listener);
      if (readableFlowing === null) readableFlowing = true;
      scheduleFlow();
    } else if (event === 'end') {
      endListeners.push(listener);
      scheduleFlow();
    }
    return stream;
  };
  const removeListener = (event: string, listener: (chunk?: BrowserBuffer | string) => void) => {
    const listeners = event === 'data' ? dataListeners : event === 'end' ? endListeners : null;
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    }
    return stream;
  };
  const stream = {
    fd: 0,
    readable: true,
    isTTY: kernelIsTerminal ?? terminal?.isTTY === true,
    get isRaw() {
      return rawMode;
    },
    setRawMode: (enabled = true) => {
      rawMode = Boolean(enabled);
      return stream;
    },
    get readableEnded() {
      return ended;
    },
    get readableEncoding() {
      return encoding ?? null;
    },
    get readableFlowing() {
      return readableFlowing;
    },
    get readableLength() {
      return Math.max(0, remainingBytes());
    },
    setEncoding: (nextEncoding: string) => {
      encoding = nextEncoding;
      return stream;
    },
    read,
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once: (event: string, listener: (chunk?: BrowserBuffer | string) => void) => {
      const wrapped = (chunk?: BrowserBuffer | string) => {
        removeListener(event, wrapped);
        listener(chunk);
      };
      return stream.on(event, wrapped);
    },
    destroy: () => {
      destroyed = true;
      return stream;
    },
    get destroyed() {
      return destroyed;
    },
    resume: () => {
      readableFlowing = true;
      scheduleFlow();
      return stream;
    },
    pause: () => {
      readableFlowing = false;
      return stream;
    },
    [Symbol.asyncIterator]: async function* () {
      const chunk = read();
      if (chunk !== null) yield chunk;
    },
  };
  return stream;
}
