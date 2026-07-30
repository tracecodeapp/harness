import {
  BrowserJavaScriptProjectExecutionState,
} from "../browser/contracts";

export function createBrowserEventLoopApi(executionState: BrowserJavaScriptProjectExecutionState) {
  type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
  type TimerCallback = (...args: unknown[]) => unknown;
  type TimerEntry = {
    handle: TimerHandle;
    interval: boolean;
  };

  const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
  const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const hostQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
  let nextTimerId = 1;
  let pendingTimerWork: Promise<void> = Promise.resolve();
  let timerError: unknown;
  let pendingExternalWork = 0;
  const timers = new Map<number, TimerEntry>();

  const recordTimerWork = (work: Promise<void>): void => {
    pendingTimerWork = Promise.allSettled([pendingTimerWork, work]).then(() => undefined);
  };
  const runTimerCallback = (callback: TimerCallback, args: unknown[]): void => {
    const work = Promise.resolve()
      .then(() => callback(...args))
      .then(
        () => undefined,
        (error) => {
          timerError ??= error;
        }
      );
    recordTimerWork(work);
  };
  const setTrackedTimeout = (callback: TimerCallback, delay?: number, ...args: unknown[]): number => {
    const id = nextTimerId++;
    const handle = hostSetTimeout(() => {
      timers.delete(id);
      if (executionState.cancelled) return;
      runTimerCallback(callback, args);
    }, Math.max(0, Number(delay) || 0));
    timers.set(id, { handle, interval: false });
    return id;
  };
  const clearTrackedTimeout = (id: unknown): void => {
    if (typeof id !== 'number') return;
    const timer = timers.get(id);
    if (!timer) return;
    hostClearTimeout(timer.handle);
    timers.delete(id);
  };
  const setTrackedInterval = (callback: TimerCallback, delay?: number, ...args: unknown[]): number => {
    const id = nextTimerId++;
    const run = (): void => {
      if (!timers.has(id) || executionState.cancelled) return;
      runTimerCallback(callback, args);
      const timer = timers.get(id);
      if (!timer) return;
      timer.handle = hostSetTimeout(run, Math.max(0, Number(delay) || 0));
    };
    const handle = hostSetTimeout(run, Math.max(0, Number(delay) || 0));
    timers.set(id, { handle, interval: true });
    return id;
  };
  const setTrackedImmediate = (callback: TimerCallback, ...args: unknown[]): number => setTrackedTimeout(callback, 0, ...args);
  const drain = async (): Promise<void> => {
    // Node performs a microtask checkpoint before deciding that a process has no
    // work left. A CommonJS entrypoint can start an async function without
    // returning its promise, so awaiting module evaluation alone is not enough:
    // a multi-step promise chain may still be producing output, timers, or HTTP
    // handles. Yield through one host task so the browser drains that promise
    // queue to quiescence before we inspect the tracked event-loop resources.
    await new Promise((resolve) => hostSetTimeout(resolve, 0));
    while (
      !executionState.cancelled &&
      (timers.size > 0 || pendingExternalWork > 0)
    ) {
      await new Promise((resolve) => hostSetTimeout(resolve, 0));
      await pendingTimerWork;
      if (timerError !== undefined) throw timerError;
      if ([...timers.values()].some((timer) => timer.interval)) {
        await new Promise((resolve) => hostSetTimeout(resolve, 0));
      }
    }
    if (!executionState.cancelled) await pendingTimerWork;
    if (timerError !== undefined) throw timerError;
  };
  const clearAll = (): void => {
    for (const timer of timers.values()) {
      hostClearTimeout(timer.handle);
    }
    timers.clear();
    pendingExternalWork = 0;
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    pendingExternalWork += 1;
    return work.finally(() => {
      pendingExternalWork = Math.max(0, pendingExternalWork - 1);
    });
  };
  const trackRefable = <T>(work: Promise<T>) => {
    let referenced = true;
    let settled = false;
    pendingExternalWork += 1;
    const completion = work.finally(() => {
      settled = true;
      if (referenced) {
        pendingExternalWork = Math.max(0, pendingExternalWork - 1);
      }
    });
    return {
      completion,
      ref(): void {
        if (settled || referenced) return;
        referenced = true;
        pendingExternalWork += 1;
      },
      unref(): void {
        if (settled || !referenced) return;
        referenced = false;
        pendingExternalWork = Math.max(0, pendingExternalWork - 1);
      },
    };
  };

  return {
    setTimeout: setTrackedTimeout,
    clearTimeout: clearTrackedTimeout,
    setInterval: setTrackedInterval,
    clearInterval: clearTrackedTimeout,
    setImmediate: setTrackedImmediate,
    clearImmediate: clearTrackedTimeout,
    queueMicrotask: hostQueueMicrotask,
    track,
    trackRefable,
    drain,
    clearAll,
  };
}
