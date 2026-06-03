export class AsyncLocalStorage<T> {
  private store: T | undefined;
  private queue: Promise<void> = Promise.resolve();

  getStore(): T | undefined {
    return this.store;
  }

  run<R>(store: T, callback: (...args: never[]) => R, ...args: never[]): R {
    const execute = async (): Promise<R> => {
      const previous = this.store;
      this.store = store;
      try {
        return await callback(...args);
      } finally {
        if (this.store === store) this.store = previous;
      }
    };
    const queued = this.queue.then(execute, execute);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued as R;
  }
}
