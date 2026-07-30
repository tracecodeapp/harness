import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import { TraceKernelInvalidArgumentError } from '../errors';
import type {
  TraceKernelWatchdogSignal,
  TraceKernelWatchdogSnapshot,
} from '../model';

import type { TraceKernelProcess } from './process';

interface TraceKernelProcessWatchdog {
  readonly process: TraceKernelProcess;
  readonly token: symbol;
  readonly timeoutMs: number;
  readonly signal: TraceKernelWatchdogSignal;
  readonly deadlineAt: number;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
}

/**
 * Process-owned watchdog timers and their lifecycle.
 *
 * Ownership checks remain in the session/process table. Once authorized, this
 * controller owns arming, petting, disarming, expiry, and snapshot cleanup.
 */
export class TraceKernelProcessWatchdogs {
  private readonly watchdogs = new Map<number, TraceKernelProcessWatchdog>();

  constructor(private readonly scope: Scope.CloseableScope) {}

  configure(
    process: TraceKernelProcess,
    action: 'arm' | 'pet' | 'disarm' | 'status',
    options: {
      readonly timeoutMs?: number;
      readonly signal?: TraceKernelWatchdogSignal;
    } = {}
  ): Effect.Effect<TraceKernelWatchdogSnapshot | undefined, Error> {
    return Effect.gen(this, function* () {
      const current = this.watchdogs.get(process.pid);
      if (action === 'status') {
        return current
          ? Object.freeze({
              timeoutMs: current.timeoutMs,
              signal: current.signal,
              deadlineAt: current.deadlineAt,
            })
          : undefined;
      }
      if (action === 'disarm') {
        yield* this.clear(process);
        return undefined;
      }
      const timeoutMs = action === 'pet'
        ? current?.timeoutMs
        : options.timeoutMs;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs === undefined ||
        timeoutMs <= 0
      ) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: action === 'pet' ? 'watchdog' : 'timeoutMs',
          message: action === 'pet'
            ? 'EINVAL: cannot pet a disarmed watchdog'
            : 'EINVAL: watchdog timeout must be a positive integer',
        }));
      }
      const signal = action === 'pet'
        ? current?.signal
        : options.signal ?? 'SIGTERM';
      if (!signal) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: 'watchdog',
          message: 'EINVAL: cannot pet a disarmed watchdog',
        }));
      }
      yield* this.clear(process);
      const token = Symbol(`watchdog-${process.pid}`);
      const deadlineAt = Date.now() + timeoutMs;
      const fiber = yield* Effect.forkIn(
        Effect.sleep(timeoutMs).pipe(
          Effect.andThen(Effect.suspend(() => {
            if (this.watchdogs.get(process.pid)?.token !== token) {
              return Effect.void;
            }
            this.watchdogs.delete(process.pid);
            process.setWatchdog(undefined);
            return process.signal(signal);
          })),
          Effect.ensuring(Effect.sync(() => {
            if (this.watchdogs.get(process.pid)?.token === token) {
              this.watchdogs.delete(process.pid);
              process.setWatchdog(undefined);
            }
          }))
        ),
        this.scope
      );
      const snapshot = Object.freeze({ timeoutMs, signal, deadlineAt });
      this.watchdogs.set(process.pid, {
        process,
        token,
        timeoutMs,
        signal,
        deadlineAt,
        fiber,
      });
      process.setWatchdog(snapshot);
      return snapshot;
    });
  }

  clear(process: TraceKernelProcess): Effect.Effect<void> {
    const watchdog = this.watchdogs.get(process.pid);
    this.watchdogs.delete(process.pid);
    process.setWatchdog(undefined);
    return watchdog
      ? Fiber.interrupt(watchdog.fiber).pipe(Effect.asVoid)
      : Effect.void;
  }

  clearAll(): void {
    for (const watchdog of this.watchdogs.values()) {
      watchdog.process.setWatchdog(undefined);
    }
    this.watchdogs.clear();
  }
}
