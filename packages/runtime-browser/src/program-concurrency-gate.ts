interface ConcurrencyWaiter {
  readonly signal?: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort?: () => void;
}

export function preparedRuntimeAbortError(
  signal: AbortSignal | undefined
): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Prepared runtime operation was aborted.');
}

/** Shared backpressure for every owner of one prepared runtime program. */
export class RuntimeProgramConcurrencyGate {
  private active = 0;
  private readonly waiting: ConcurrencyWaiter[] = [];

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new TypeError(
        'Prepared runtime programs require a positive integer maxConcurrency.'
      );
    }
  }

  async run<Result>(
    signal: AbortSignal | undefined,
    use: () => Promise<Result>
  ): Promise<Result> {
    const release = await this.acquire(signal);
    try {
      return await use();
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(preparedRuntimeAbortError(signal));
    }
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.releasePermit());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: ConcurrencyWaiter = {
        signal,
        resolve,
        reject,
        ...(signal
          ? {
              onAbort: () => {
                const index = this.waiting.indexOf(waiter);
                if (index >= 0) this.waiting.splice(index, 1);
                reject(preparedRuntimeAbortError(signal));
              },
            }
          : {}),
      };
      if (signal && waiter.onAbort) {
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
    });
  }

  private releasePermit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.resumeNext();
    };
  }

  private resumeNext(): void {
    while (this.active < this.maximum && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(preparedRuntimeAbortError(waiter.signal));
        continue;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      this.active += 1;
      waiter.resolve(this.releasePermit());
    }
  }
}
