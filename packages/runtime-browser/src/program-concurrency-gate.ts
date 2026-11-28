interface ConcurrencyWaiter {
  readonly signal?: AbortSignal;
  readonly start: () => Promise<void>;
  readonly reject: (error: Error) => void;
  readonly onAbort?: () => void;
}

type ProgramPriority = 'foreground' | 'foreground-cleanup' | 'background';

export function preparedRuntimeAbortError(
  signal: AbortSignal | undefined
): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Prepared runtime operation was aborted.');
}

/** Stop waiting on a request whose owner must finish it after cancellation. */
export function detachPreparedRuntimeRequest<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(preparedRuntimeAbortError(signal));
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Shared backpressure for every owner of one prepared runtime program. */
export class RuntimeProgramConcurrencyGate {
  private active = 0;
  private readonly waiting: ConcurrencyWaiter[] = [];
  private readonly cleanup: ConcurrencyWaiter[] = [];
  private readonly background: ConcurrencyWaiter[] = [];

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new TypeError(
        'Prepared runtime programs require a positive integer maxConcurrency.'
      );
    }
  }

  run<Result>(
    signal: AbortSignal | undefined,
    use: () => Promise<Result>,
    priority: ProgramPriority = 'foreground'
  ): Promise<Result> {
    if (signal?.aborted) {
      return Promise.reject(preparedRuntimeAbortError(signal));
    }
    const waiting = priority === 'foreground' ? this.waiting
      : priority === 'foreground-cleanup' ? this.cleanup : this.background;
    return new Promise<Result>((resolve, reject) => {
      const waiter: ConcurrencyWaiter = {
        signal,
        start: async () => {
          try {
            resolve(await use());
          } catch (error) {
            reject(error);
          } finally {
            this.active -= 1;
            this.resumeNext();
          }
        },
        reject,
        ...(signal
          ? {
              onAbort: () => {
                const index = waiting.indexOf(waiter);
                if (index >= 0) waiting.splice(index, 1);
                reject(preparedRuntimeAbortError(signal));
              },
            }
          : {}),
      };
      if (signal && waiter.onAbort) {
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiting.push(waiter);
      this.resumeNext();
    });
  }

  private resumeNext(): void {
    while (this.active < this.maximum) {
      const waiter = this.waiting.shift() ?? this.cleanup.shift() ?? this.background.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        waiter.reject(preparedRuntimeAbortError(waiter.signal));
        continue;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      this.active += 1;
      // Start in the same turn as selection so a newly ready foreground
      // request cannot arrive between selecting background work and posting it.
      void waiter.start();
    }
  }
}
