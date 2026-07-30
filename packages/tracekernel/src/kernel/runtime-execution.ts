import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import type {
  TraceKernelProcessSnapshot,
  TraceKernelRuntimeLease,
  TraceKernelRuntimeLeaseReleaseDisposition,
  TraceKernelRuntimeProcessContext,
} from '../model';

import type { TraceKernelProcess } from './process';

type AcquireRuntimeLease = (
  context: TraceKernelRuntimeProcessContext
) => Effect.Effect<TraceKernelRuntimeLease, Error>;

function runtimeContext(
  process: TraceKernelProcess
): TraceKernelRuntimeProcessContext {
  const snapshot = process.snapshot();
  return Object.freeze({
    pid: snapshot.pid,
    ppid: snapshot.ppid,
    pgid: snapshot.pgid,
    sid: snapshot.sid,
    ...(snapshot.controllingTerminalId === undefined
      ? {}
      : { controllingTerminalId: snapshot.controllingTerminalId }),
    command: snapshot.command,
    args: snapshot.args,
    cwd: snapshot.cwd,
    env: snapshot.env,
  });
}

function revalidateRuntimeLease(
  lease: TraceKernelRuntimeLease,
  snapshot: TraceKernelProcessSnapshot
): Effect.Effect<TraceKernelRuntimeLeaseReleaseDisposition> {
  const termination = snapshot.termination;
  if (!termination || termination.kind === 'failure') {
    return Effect.succeed(Object.freeze({
      kind: 'destroy',
      reason: 'execution-failure',
      ...(termination?.kind === 'failure' && termination.message
        ? { message: termination.message }
        : {}),
    }));
  }
  if (termination.kind === 'signal') {
    return Effect.succeed(Object.freeze({
      kind: 'destroy',
      reason: 'signaled',
      message: termination.signal,
    }));
  }
  if (!lease.revalidate) {
    return Effect.succeed(Object.freeze({
      kind: 'destroy',
      reason: 'unvalidated',
    }));
  }
  return lease.revalidate().pipe(
    Effect.match({
      onFailure: (error): TraceKernelRuntimeLeaseReleaseDisposition =>
        Object.freeze({
          kind: 'destroy',
          reason: 'revalidation-failure',
          message: error.message,
        }),
      onSuccess: (): TraceKernelRuntimeLeaseReleaseDisposition =>
        Object.freeze({
          kind: 'reuse',
          reason: 'revalidated',
        }),
    })
  );
}

/**
 * Own the complete acquire/use/revalidate/release bracket for one process.
 *
 * Only a successfully revalidated lease may return to a provider pool. Every
 * failure, signal, interruption, or provider without validation is destroyed.
 */
export function executeProcessWithRuntimeLease(
  process: TraceKernelProcess,
  acquireLease: AcquireRuntimeLease
): Effect.Effect<TraceKernelProcessSnapshot, Error> {
  return Effect.acquireUseRelease(
    acquireLease(runtimeContext(process)),
    (lease) =>
      process.execute(lease).pipe(
        Effect.flatMap((snapshot) =>
          revalidateRuntimeLease(lease, snapshot).pipe(
            Effect.map((disposition) => ({ snapshot, disposition }))
          )
        )
      ),
    (lease, exit) =>
      lease.release(
        Exit.isSuccess(exit)
          ? exit.value.disposition
          : Object.freeze({
              kind: 'destroy',
              reason: 'interrupted',
            })
      )
  ).pipe(
    Effect.map(({ snapshot }) => snapshot)
  );
}
