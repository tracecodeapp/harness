

export class BrowserEventEmitter {
  readonly listeners = new Map<string | symbol, Array<(...args: unknown[]) => void>>();

  on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const entries = this.listeners.get(eventName) ?? [];
    entries.push(listener);
    this.listeners.set(eventName, entries);
    return this;
  }

  addListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.on(eventName, listener);
  }

  once(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.off(eventName, wrapped);
      listener(...args);
    };
    return this.on(eventName, wrapped);
  }

  off(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const entries = this.listeners.get(eventName);
    if (!entries) return this;
    const index = entries.indexOf(listener);
    if (index !== -1) entries.splice(index, 1);
    if (entries.length === 0) this.listeners.delete(eventName);
    return this;
  }

  removeListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.off(eventName, listener);
  }

  emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const entries = [...(this.listeners.get(eventName) ?? [])];
    if (entries.length === 0) {
      if (eventName === 'error') throw args[0] instanceof Error ? args[0] : new Error(String(args[0] ?? 'Unhandled error'));
      return false;
    }
    for (const listener of entries) listener(...args);
    return true;
  }

  listenerCount(eventName: string | symbol): number {
    return this.listeners.get(eventName)?.length ?? 0;
  }

  removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) this.listeners.clear();
    else this.listeners.delete(eventName);
    return this;
  }
}

export function createEventsApi() {
  return {
    EventEmitter: BrowserEventEmitter,
    once: (emitter: BrowserEventEmitter, eventName: string | symbol) => new Promise<unknown[]>((resolve, reject) => {
      emitter.once(eventName, (...args) => resolve(args));
      if (eventName !== 'error') emitter.once('error', reject);
    }),
  };
}

export function createUtilApi() {
  const inspect = (value: unknown): string => {
    if (typeof value === 'string') return `'${value}'`;
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const promisify = (fn: (...args: unknown[]) => void) => (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      fn(...args, (error: unknown, value: unknown) => {
        if (error) reject(error);
        else resolve(value);
      });
    });
  const callbackify = (fn: (...args: unknown[]) => Promise<unknown>) => (...args: unknown[]) => {
    const callback = args.pop();
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    fn(...args).then((value) => callback(null, value), (error) => callback(error));
  };
  return {
    inspect,
    format: (...args: unknown[]) => args.map((arg) => typeof arg === 'string' ? arg : inspect(arg)).join(' '),
    promisify,
    callbackify,
    TextEncoder,
    TextDecoder,
    types: {
      isDate: (value: unknown): value is Date => value instanceof Date,
      isMap: (value: unknown): value is Map<unknown, unknown> => value instanceof Map,
      isSet: (value: unknown): value is Set<unknown> => value instanceof Set,
      isRegExp: (value: unknown): value is RegExp => value instanceof RegExp,
      isUint8Array: (value: unknown): value is Uint8Array => value instanceof Uint8Array,
    },
  };
}
