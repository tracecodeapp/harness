const JAVA_SAFE_STORAGE_LOCK = 'tracecode:harness:java-persistent-storage:v1';

let javaSafeStorageTail: Promise<void> = Promise.resolve();

/**
 * Serialize access to CheerpJ's origin-scoped writable `/files` mount.
 *
 * A fresh worker creates a fresh JVM, but CheerpJ intentionally persists
 * `/files` in IndexedDB. Safe executions must therefore reset and use that
 * mount while holding one cross-context lock until the dirty JVM is retired.
 */
export function runJavaSafeStorageExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const lockManager = (globalThis.navigator as Navigator & {
    locks?: {
      request<Result>(
        name: string,
        callback: () => Result | PromiseLike<Result>
      ): Promise<Result>;
    };
  } | undefined)?.locks;
  if (lockManager) return lockManager.request<T>(JAVA_SAFE_STORAGE_LOCK, operation);

  // Browsers without Web Locks still get process-wide serialization within
  // this JavaScript realm. Consumers that need cross-tab safety should expose
  // navigator.locks rather than opting into shared mutable Java workers.
  const result = javaSafeStorageTail.then(operation);
  javaSafeStorageTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
