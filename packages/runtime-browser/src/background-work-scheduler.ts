export interface PromotableBrowserBackgroundTask {
  /** Start immediately when still queued, then await the shared work. */
  promote(): Promise<void>;
  /** Observe completion without changing the queued task's priority. */
  wait(): Promise<void>;
  /** Cancel work that has not started. Running work needs owner teardown. */
  cancel(): void;
}

interface BrowserBackgroundScheduler {
  postTask<T>(
    callback: () => T | Promise<T>,
    options: { priority: 'background'; signal: AbortSignal }
  ): Promise<T>;
}

/**
 * Queue speculative work without making a timer part of product lifecycle.
 *
 * Browsers do not expose a portable mutable CPU priority for a running Worker.
 * This helper therefore keeps work behind requestIdleCallback (or background
 * scheduler priority), while allowing a user action to promote the exact same
 * Promise rather than starting duplicate work.
 */
export function createPromotableBrowserBackgroundTask(
  work: () => Promise<void>
): PromotableBrowserBackgroundTask {
  let permanentlyCancelled = false;
  let task: Promise<void> | null = null;
  let idleHandle: number | null = null;
  let backgroundController: AbortController | null = null;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (reason: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A disposed owner may not retain a waiter. Keep cancellation from becoming
  // an unhandled rejection while preserving it for explicit waiters.
  void completion.catch(() => undefined);

  const start = (): Promise<void> => {
    if (permanentlyCancelled) return Promise.resolve();
    if (!task) {
      task = Promise.resolve().then(work);
      task.then(resolveCompletion, rejectCompletion);
      void task.catch(() => undefined);
    }
    return task;
  };
  const cancelPendingCallback = (): void => {
    if (
      idleHandle !== null &&
      typeof globalThis.cancelIdleCallback === 'function'
    ) {
      globalThis.cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
    backgroundController?.abort();
    backgroundController = null;
  };

  if (typeof globalThis.requestIdleCallback === 'function') {
    idleHandle = globalThis.requestIdleCallback(() => {
      idleHandle = null;
      void start();
    });
  } else {
    const scheduler = (
      globalThis as typeof globalThis & {
        scheduler?: BrowserBackgroundScheduler;
      }
    ).scheduler;
    if (scheduler?.postTask) {
      backgroundController = new AbortController();
      void scheduler.postTask(
        () => {
          backgroundController = null;
          return start();
        },
        {
          priority: 'background',
          signal: backgroundController.signal,
        }
      ).catch(() => undefined);
    }
  }

  return {
    promote: () => {
      cancelPendingCallback();
      return start();
    },
    wait: () => completion,
    cancel: () => {
      if (permanentlyCancelled) return;
      permanentlyCancelled = true;
      cancelPendingCallback();
      if (!task) {
        rejectCompletion(
          new DOMException('Browser background work was cancelled.', 'AbortError')
        );
      }
    },
  };
}
