import * as Effect from 'effect/Effect';

/** Host-only authority carried with deferred kernel operations. */
export interface TraceKernelOperationAuthority {
  readonly assertActive?: () => void;
  readonly signal?: AbortSignal;
}

export function withOperationAuthority<A, E>(
  authority: TraceKernelOperationAuthority | undefined,
  operation: Effect.Effect<A, E>
): Effect.Effect<A, E | Error> {
  if (!authority) return operation;
  const check = Effect.try({
    try: () => authority.assertActive?.(),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
  const guarded = check.pipe(Effect.zipRight(operation), Effect.tap(() => check));
  const signal = authority.signal;
  if (!signal) return guarded;
  const revoked = Effect.async<never, Error>((resume) => {
    const abort = () => resume(Effect.fail(Object.assign(new Error('Process authority has been revoked'), { code: 'ESRCH' })));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', abort));
  });
  // raceFirst waits for interruption of the losing operation, including its
  // finalizers, before the caller's drain can observe settlement.
  return Effect.raceFirst(guarded, revoked);
}
