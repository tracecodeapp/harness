export class AsyncLocalStorage<T> {
  static readonly __tracecodeBrowserSingleFlight = true;

  private frames: Array<{ readonly token: symbol; readonly store: T }> = [];

  getStore(): T | undefined {
    return this.frames[this.frames.length - 1]?.store;
  }

  run<R>(store: T, callback: (...args: never[]) => R, ...args: never[]): R {
    const frame = { token: Symbol('tracecode-async-local-storage-frame'), store };
    this.frames.push(frame);
    const restore = (): void => {
      const index = this.frames.findIndex((candidate) => candidate.token === frame.token);
      if (index !== -1) this.frames.splice(index, 1);
    };
    try {
      const result = callback(...args);
      if (isPromiseLike(result)) {
        return result.finally(() => {
          restore();
        }) as R;
      }
      restore();
      return result;
    } catch (error) {
      restore();
      throw error;
    }
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    'finally' in value &&
    typeof (value as Promise<T>).then === 'function' &&
    typeof (value as Promise<T>).finally === 'function'
  );
}
