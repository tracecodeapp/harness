#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import {
  makeTraceKernelHost,
  TraceKernelSyscallDispatcher,
  type TraceKernelRuntimeProvider,
  type TraceKernelSyscallResult,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function success(result: TraceKernelSyscallResult): asserts result is Extract<
  TraceKernelSyscallResult,
  { readonly ok: true }
> {
  assertCondition(result.ok, `Syscall failed: ${JSON.stringify(result)}`);
}

async function main(): Promise<void> {
  const provider: TraceKernelRuntimeProvider = {
    runtime: 'watchdog-test',
    initialize: Effect.succeed({
      acquire: (process) =>
        Effect.succeed({
          id: `watchdog-lease-${process.pid}`,
          runtime: 'watchdog-test',
          execute: () => Effect.never,
          release: () => Effect.void,
        }),
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession();

      const expiring = yield* session.spawn({
        runtime: 'watchdog-test',
        command: 'expire',
      });
      yield* expiring.awaitStarted();
      const expiringSyscalls = new TraceKernelSyscallDispatcher(
        session,
        expiring
      );
      const armed = yield* expiringSyscalls.dispatch({
        op: 'watchdog',
        action: 'arm',
        timeoutMs: 40,
        signal: 'SIGKILL',
      });
      success(armed);
      assertCondition(
        armed.value.op === 'watchdog' &&
          armed.value.armed &&
          armed.value.timeoutMs === 40 &&
          armed.value.signal === 'SIGKILL' &&
          typeof armed.value.deadlineAt === 'number',
        `Watchdog arm returned the wrong state: ${JSON.stringify(armed)}`
      );
      assertCondition(
        expiring.snapshot().watchdog?.signal === 'SIGKILL',
        `Armed watchdog was absent from the process snapshot: ${JSON.stringify(expiring.snapshot())}`
      );
      const expired = yield* expiring.wait();
      assertCondition(
        expired.termination?.kind === 'signal' &&
          expired.termination.signal === 'SIGKILL' &&
          expired.termination.exitCode === 137 &&
          expired.watchdog === undefined,
        `Expired watchdog did not enforce SIGKILL and clear itself: ${JSON.stringify(expired)}`
      );

      const controlled = yield* session.spawn({
        runtime: 'watchdog-test',
        command: 'pet-and-disarm',
      });
      yield* controlled.awaitStarted();
      const controlledSyscalls = new TraceKernelSyscallDispatcher(
        session,
        controlled
      );
      const firstArm = yield* controlledSyscalls.dispatch({
        op: 'watchdog',
        action: 'arm',
        timeoutMs: 100,
        signal: 'SIGKILL',
      });
      success(firstArm);
      if (
        firstArm.value.op !== 'watchdog' ||
        firstArm.value.deadlineAt === undefined
      ) {
        throw new Error(`Watchdog arm returned the wrong variant: ${JSON.stringify(firstArm)}`);
      }
      yield* Effect.sleep(60);
      const petted = yield* controlledSyscalls.dispatch({
        op: 'watchdog',
        action: 'pet',
      });
      success(petted);
      assertCondition(
        petted.value.op === 'watchdog' &&
          petted.value.armed &&
          petted.value.deadlineAt !== undefined &&
          petted.value.deadlineAt > firstArm.value.deadlineAt,
        `Pet did not renew the existing deadline: ${JSON.stringify(petted)}`
      );
      yield* Effect.sleep(60);
      assertCondition(
        controlled.snapshot().phase === 'running',
        'The replaced watchdog timer signaled the process after pet.'
      );
      const disarmed = yield* controlledSyscalls.dispatch({
        op: 'watchdog',
        action: 'disarm',
      });
      success(disarmed);
      assertCondition(
        disarmed.value.op === 'watchdog' &&
          !disarmed.value.armed &&
          controlled.snapshot().watchdog === undefined,
        `Disarm left watchdog state behind: ${JSON.stringify(disarmed)}`
      );
      yield* Effect.sleep(110);
      assertCondition(
        controlled.snapshot().phase === 'running',
        'A disarmed watchdog retained a live timer.'
      );

      const unarmedPet = yield* controlledSyscalls.dispatch({
        op: 'watchdog',
        action: 'pet',
      });
      assertCondition(
        !unarmedPet.ok && unarmedPet.error.code === 'EINVAL',
        `Petting a disarmed watchdog did not return EINVAL: ${JSON.stringify(unarmedPet)}`
      );
      yield* controlled.signal('SIGKILL');
      yield* controlled.wait();

      assertCondition(
        session.processSnapshots().length === 0,
        'Watchdog processes or timers remained owned after exit.'
      );

      console.log(JSON.stringify({
        schema: 'tracekernel-013-watchdog-conformance-v1',
        expirySignal: 'SIGKILL',
        petRenewsDeadline: true,
        disarmCancelsTimer: true,
        processOwnedCleanup: true,
      }));
    })
  ));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
