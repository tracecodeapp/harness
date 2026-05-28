export class AsyncLocalStorage<T> {
  private store: T | undefined;

  getStore(): T | undefined {
    return this.store;
  }

  run<R>(store: T, callback: (...args: never[]) => R, ...args: never[]): R {
    const previous = this.store;
    this.store = store;
    try {
      const result = callback(...args);
      const maybePromise = result as unknown as { finally?: (onFinally: () => void) => unknown };
      if (maybePromise && typeof maybePromise.finally === 'function') {
        return maybePromise.finally(() => {
          if (this.store === store) this.store = previous;
        }) as R;
      }
      this.store = previous;
      return result;
    } catch (error) {
      this.store = previous;
      throw error;
    }
  }
}
