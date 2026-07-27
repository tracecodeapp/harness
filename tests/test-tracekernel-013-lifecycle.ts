#!/usr/bin/env npx tsx

import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import {
  makeTraceKernelHost,
  TraceKernelProcessLimitError,
  TraceKernelProcessPermissionError,
  type TraceKernelProcess,
  type TraceKernelProcessSnapshot,
  type TraceKernelRuntimeProvider,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  let initializeCount = 0;
  let acquireCount = 0;
  let releaseCount = 0;
  const releasedLeaseIds: string[] = [];
  const deliveredSignals: Array<{ pid: number; signal: string }> = [];

  const provider: TraceKernelRuntimeProvider = {
    runtime: 'test',
    initialize: Effect.sync(() => {
      initializeCount += 1;
      return {
        acquire: (process) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              acquireCount += 1;
              const leaseId = `lease-${acquireCount}`;
              const gracefulExit = yield* Deferred.make<void>();
              const supportsSignals =
                process.command === 'graceful' ||
                process.command === 'stubborn' ||
                process.command === 'kill-hook';
              return {
                id: leaseId,
                runtime: 'test',
                execute: () => {
                  if (process.command === 'block') return Effect.never;
                  if (process.command === 'stubborn') return Effect.never;
                  if (process.command === 'graceful' || process.command === 'kill-hook') {
                    return Deferred.await(gracefulExit).pipe(
                      Effect.as({
                        exitCode: 0,
                        stdout: `${process.command}:clean-exit\n`,
                        stderr: '',
                      })
                    );
                  }
                  if (process.command === 'fail') return Effect.fail(new Error('runtime failed'));
                  return Effect.sleep(5).pipe(
                    Effect.as({
                      exitCode: 0,
                      stdout: `${process.command}:${process.pid}\n`,
                      stderr: '',
                    })
                  );
                },
                ...(supportsSignals ? {
                  signal: (signal: 'SIGHUP' | 'SIGINT' | 'SIGQUIT' | 'SIGTERM') =>
                    Effect.sync(() => {
                      deliveredSignals.push({ pid: process.pid, signal });
                    }).pipe(
                      Effect.andThen(
                        process.command === 'stubborn'
                          ? Effect.void
                          : Deferred.succeed(gracefulExit, undefined)
                      )
                    ),
                } : {}),
              };
            }),
            (lease) =>
              Effect.sync(() => {
                releaseCount += 1;
                releasedLeaseIds.push(lease.id);
              })
          ),
      };
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      assertCondition(initializeCount === 0, 'Constructing a host must not initialize runtime providers.');

      const session = yield* host.openSession({
        cwd: '/workspace',
        env: { SESSION_VALUE: 'shared-default' },
      });
      assertCondition(initializeCount === 0, 'Opening a session must not initialize runtime providers.');

      const [first, second] = yield* Effect.all([
        session.execute({
          runtime: 'test',
          command: 'first',
          owner: { id: 'learner-1', kind: 'user' },
        }),
        session.execute({
          runtime: 'test',
          command: 'second',
          env: { PROCESS_VALUE: 'isolated' },
          owner: { id: 'agent-1', kind: 'agent' },
        }),
      ], { concurrency: 'unbounded' });

      assertCondition(initializeCount === 1, 'Concurrent first use must share one lazy provider initialization.');
      assertCondition(first.termination?.kind === 'exit' && first.termination.exitCode === 0, 'First process did not exit normally.');
      assertCondition(second.termination?.kind === 'exit' && second.termination.exitCode === 0, 'Second process did not exit normally.');
      assertCondition(first.stdout.startsWith('first:'), `Unexpected first stdout: ${JSON.stringify(first.stdout)}`);
      assertCondition(second.stdout.startsWith('second:'), `Unexpected second stdout: ${JSON.stringify(second.stdout)}`);
      assertCondition(first.env.SESSION_VALUE === 'shared-default', 'Session environment default was not inherited.');
      assertCondition(first.env.PROCESS_VALUE === undefined, 'Process environment leaked between processes.');
      assertCondition(second.env.PROCESS_VALUE === 'isolated', 'Process environment override was not applied.');
      assertCondition(session.processSnapshots().length === 0, 'Completed execute() processes must leave the process table.');
      assertCondition(releaseCount === 2, 'execute() must release each runtime lease when its process scope closes.');

      const interrupted = yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* session.spawn({
            runtime: 'test',
            command: 'block',
            owner: { id: 'learner-1', kind: 'user' },
          });
          yield* process.awaitStarted();
          yield* process.signal('SIGINT');
          return yield* process.wait();
        })
      );

      assertCondition(
        interrupted.termination?.kind === 'signal' &&
          interrupted.termination.signal === 'SIGINT' &&
          interrupted.termination.exitCode === 130,
        `Interrupted process reported the wrong termination: ${JSON.stringify(interrupted.termination)}`
      );
      assertCondition(releaseCount === 3, 'Interrupted process lease was not released exactly once.');
      assertCondition(session.processSnapshots().length === 0, 'Interrupted process remained in the process table.');

      const failed = yield* session.execute({
        runtime: 'test',
        command: 'fail',
        owner: { id: 'grader-1', kind: 'grader' },
        protected: true,
        visible: false,
      });
      assertCondition(
        failed.termination?.kind === 'failure' &&
          failed.termination.message === 'runtime failed',
        `Runtime failure was not translated into process state: ${JSON.stringify(failed)}`
      );
      assertCondition(failed.stderr === 'runtime failed\n', 'Runtime failure did not produce process stderr.');
      assertCondition(releaseCount === 4, 'Failed process lease was not released exactly once.');

      const unavailable = yield* session.execute({
        runtime: 'missing',
        command: 'missing-runtime',
        owner: { id: 'learner-1', kind: 'user' },
      });
      assertCondition(
        unavailable.termination?.kind === 'failure' &&
          unavailable.termination.exitCode === 126 &&
          unavailable.stderr.includes('is not registered'),
        `Runtime startup failure leaked outside process semantics: ${JSON.stringify(unavailable)}`
      );
      assertCondition(
        session.processSnapshots().length === 0,
        'Runtime startup failure remained in the process table.'
      );

      let teardownProcess: TraceKernelProcess | undefined;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const teardownSession = yield* host.openSession();
          teardownProcess = yield* teardownSession.spawn({
            runtime: 'test',
            command: 'block',
            owner: { id: 'system-service', kind: 'system' },
            protected: true,
          });
        })
      );

      const teardownSnapshot: TraceKernelProcessSnapshot | undefined = teardownProcess?.snapshot();
      assertCondition(
        teardownSnapshot?.phase === 'exited' && teardownSnapshot.termination?.kind === 'signal',
        `Session teardown did not terminate its process: ${JSON.stringify(teardownSnapshot)}`
      );
      assertCondition(releaseCount === 5, 'Session teardown did not release the process lease exactly once.');
      assertCondition(host.sessionIds().length === 1, 'Closed child session remained registered with the host.');

      const limitedSession = yield* host.openSession({ maxProcesses: 1 });
      const admitted = yield* limitedSession.spawn({
        runtime: 'test',
        command: 'block',
      });
      yield* admitted.awaitStarted();
      assertCondition(
        admitted.snapshot().schedulingState === 'running',
        'A started process did not enter the kernel running state.'
      );
      yield* limitedSession.setProcessSchedulingState(admitted, 'blocked');
      assertCondition(
        admitted.snapshot().schedulingState === 'blocked',
        'The host could not publish a blocked scheduling state.'
      );
      yield* limitedSession.setProcessSchedulingState(admitted, 'running');
      const rejected = yield* Effect.flip(limitedSession.spawn({
        runtime: 'test',
        command: 'block',
      }));
      assertCondition(
        rejected instanceof TraceKernelProcessLimitError &&
          rejected.code === 'EAGAIN' &&
          rejected.maxProcesses === 1,
        `Process admission did not retain typed EAGAIN: ${String(rejected)}`
      );
      assertCondition(
        limitedSession.processSnapshots().length === 1,
        'Rejected process admission mutated the process table.'
      );
      yield* admitted.signal('SIGTERM');
      const replacement = yield* limitedSession.spawn({
        runtime: 'test',
        command: 'block',
      });
      yield* replacement.awaitStarted();
      yield* replacement.signal('SIGTERM');
      assertCondition(
        limitedSession.processSnapshots().length === 0,
        'Process capacity was not released after termination.'
      );

      const initWaitSession = yield* host.openSession({ maxProcesses: 1 });
      const retainedTopLevel = yield* initWaitSession.spawn({
        runtime: 'test',
        command: 'retained-top-level',
        retainOnExit: true,
      });
      const retainedTopLevelExit = yield* retainedTopLevel.wait();
      assertCondition(
        retainedTopLevelExit.termination?.kind === 'exit',
        'The retained top-level process did not exit normally.'
      );
      assertCondition(
        initWaitSession.processSnapshots().every(
          (snapshot) => snapshot.pid !== retainedTopLevel.pid
        ) &&
          initWaitSession.processTableSnapshots().some(
            (snapshot) =>
              snapshot.pid === retainedTopLevel.pid &&
              snapshot.phase === 'exited'
          ),
        'The authoritative process table did not expose the retained zombie separately from the live set.'
      );
      const retainedCapacity = yield* Effect.flip(initWaitSession.spawn({
        runtime: 'test',
        command: 'blocked-by-zombie',
      }));
      assertCondition(
        retainedCapacity instanceof TraceKernelProcessLimitError &&
          retainedCapacity.code === 'EAGAIN',
        `A retained PID 1 child did not occupy process capacity: ${String(
          retainedCapacity
        )}`
      );
      const initReaped = yield* initWaitSession.waitInitChild(-1);
      assertCondition(
        initReaped?.pid === retainedTopLevel.pid &&
          initReaped.termination?.kind === 'exit' &&
          initWaitSession.processTableSnapshots().every(
            (snapshot) => snapshot.pid !== retainedTopLevel.pid
          ),
        `Logical PID 1 did not reap its retained child: ${JSON.stringify(
          initReaped
        )}`
      );
      const afterInitReap = yield* initWaitSession.execute({
        runtime: 'test',
        command: 'after-init-reap',
      });
      assertCondition(
        afterInitReap.termination?.kind === 'exit',
        'PID 1 wait did not release process capacity.'
      );

      const treeSession = yield* host.openSession();
      const parent = yield* treeSession.spawn({
        runtime: 'test',
        command: 'block',
      });
      yield* parent.awaitStarted();
      const child = yield* treeSession.spawn({
        runtime: 'test',
        command: 'block',
        parentPid: parent.pid,
      });
      yield* child.awaitStarted();
      const parentSnapshot = parent.snapshot();
      const childSnapshot = child.snapshot();
      assertCondition(
        childSnapshot.ppid === parent.pid &&
          childSnapshot.pgid === parentSnapshot.pgid &&
          childSnapshot.sid === parentSnapshot.sid,
        `Child did not inherit its parent process topology: ${JSON.stringify(childSnapshot)}`
      );
      yield* parent.signal('SIGTERM');
      assertCondition(
        child.snapshot().ppid === 1 &&
          treeSession.processSnapshots().some(
            (snapshot) => snapshot.pid === child.pid
          ),
        'A surviving child was not reparented to session init.'
      );
      const missingParent = yield* Effect.flip(treeSession.spawn({
        runtime: 'test',
        command: 'block',
        parentPid: 999_999,
      }));
      assertCondition(
        missingParent instanceof Error &&
          missingParent.message.startsWith('ESRCH: parent process'),
        `A missing parent was accepted or misclassified: ${String(missingParent)}`
      );
      yield* child.signal('SIGTERM');

      const protectedProcess = yield* treeSession.spawn({
        runtime: 'test',
        command: 'block',
        owner: { id: 'grader-owner', kind: 'grader' },
        protected: true,
        visible: false,
      });
      yield* protectedProcess.awaitStarted();
      const learner = { id: 'learner-owner', kind: 'user' } as const;
      const grader = { id: 'grader-owner', kind: 'grader' } as const;
      assertCondition(
        treeSession.processSnapshots(learner).every(
          (snapshot) => snapshot.pid !== protectedProcess.pid
        ) &&
          treeSession.processSnapshots(grader).some(
            (snapshot) => snapshot.pid === protectedProcess.pid
          ),
        'Actor-aware process inspection exposed a hidden foreign process.'
      );
      const deniedSignal = yield* Effect.flip(
        treeSession.signalProcess(
          learner,
          protectedProcess.pid,
          'SIGTERM'
        )
      );
      assertCondition(
        deniedSignal instanceof TraceKernelProcessPermissionError &&
          deniedSignal.code === 'EACCES' &&
          protectedProcess.snapshot().phase === 'running',
        `Protected process signal was not denied cleanly: ${String(deniedSignal)}`
      );
      yield* treeSession.signalProcess(
        grader,
        protectedProcess.pid,
        'SIGTERM'
      );

      const signalSession = yield* host.openSession({
        signalGracePeriodMs: 20,
      });
      const graceful = yield* signalSession.spawn({
        runtime: 'test',
        command: 'graceful',
      });
      yield* graceful.awaitStarted();
      yield* graceful.signal('SIGTERM');
      const gracefulSnapshot = yield* graceful.wait();
      assertCondition(
        gracefulSnapshot.termination?.kind === 'exit' &&
          gracefulSnapshot.termination.exitCode === 0 &&
          gracefulSnapshot.stdout === 'graceful:clean-exit\n',
        `A runtime-handled signal lost the graceful process result: ${JSON.stringify(gracefulSnapshot)}`
      );

      const stubborn = yield* signalSession.spawn({
        runtime: 'test',
        command: 'stubborn',
      });
      yield* stubborn.awaitStarted();
      yield* stubborn.signal('SIGINT');
      const stubbornSnapshot = yield* stubborn.wait();
      assertCondition(
        stubbornSnapshot.termination?.kind === 'signal' &&
          stubbornSnapshot.termination.signal === 'SIGINT' &&
          stubbornSnapshot.termination.exitCode === 130,
        `A process surviving the grace deadline was not force-interrupted: ${JSON.stringify(stubbornSnapshot)}`
      );

      const killHook = yield* signalSession.spawn({
        runtime: 'test',
        command: 'kill-hook',
      });
      yield* killHook.awaitStarted();
      const deliveriesBeforeKill = deliveredSignals.length;
      yield* killHook.signal('SIGKILL');
      const killedSnapshot = yield* killHook.wait();
      assertCondition(
        killedSnapshot.termination?.kind === 'signal' &&
          killedSnapshot.termination.signal === 'SIGKILL' &&
          killedSnapshot.termination.exitCode === 137 &&
          deliveredSignals.length === deliveriesBeforeKill,
        `SIGKILL was delivered as a catchable runtime signal: ${JSON.stringify(killedSnapshot)}`
      );

      const hungUp = yield* signalSession.spawn({
        runtime: 'test',
        command: 'block',
      });
      yield* hungUp.awaitStarted();
      yield* hungUp.signal('SIGHUP');
      const hungUpSnapshot = yield* hungUp.wait();
      assertCondition(
        hungUpSnapshot.termination?.kind === 'signal' &&
          hungUpSnapshot.termination.signal === 'SIGHUP' &&
          hungUpSnapshot.termination.exitCode === 129,
        `SIGHUP did not use POSIX signal exit status: ${JSON.stringify(hungUpSnapshot)}`
      );

      const quit = yield* signalSession.spawn({
        runtime: 'test',
        command: 'block',
      });
      yield* quit.awaitStarted();
      yield* quit.signal('SIGQUIT');
      const quitSnapshot = yield* quit.wait();
      assertCondition(
        quitSnapshot.termination?.kind === 'signal' &&
          quitSnapshot.termination.signal === 'SIGQUIT' &&
          quitSnapshot.termination.exitCode === 131,
        `SIGQUIT did not use POSIX signal exit status: ${JSON.stringify(quitSnapshot)}`
      );
      assertCondition(
        deliveredSignals.some((delivery) =>
          delivery.pid === graceful.pid && delivery.signal === 'SIGTERM'
        ) &&
          deliveredSignals.some((delivery) =>
            delivery.pid === stubborn.pid && delivery.signal === 'SIGINT'
          ),
        `Catchable signals were not delivered exactly to their runtime leases: ${JSON.stringify(deliveredSignals)}`
      );
    })
  ));

  assertCondition(initializeCount === 1, 'Provider initialization should remain memoized for the host lifetime.');
  assertCondition(acquireCount === 17, `Expected seventeen leases, acquired ${acquireCount}.`);
  assertCondition(releaseCount === 17, `Expected seventeen lease releases, observed ${releaseCount}.`);
  assertCondition(new Set(releasedLeaseIds).size === releasedLeaseIds.length, 'A runtime lease was released more than once.');

  console.log(JSON.stringify({
    schema: 'tracekernel-013-lifecycle-v1',
    initializeCount,
    acquireCount,
    releaseCount,
    exactlyOnceLeaseRelease: true,
    concurrentInitializationDeduplicated: true,
    signalInterruptionMappedToProcessExit: true,
    sessionTeardownTerminatedDescendants: true,
    processCeilingReturnsEagain: true,
    processCapacityReleasedOnExit: true,
    kernelOwnedSchedulingState: true,
    logicalInitOwnsRetainedTopLevelWaits: true,
    authoritativeProcessTableIncludesUnreapedZombies: true,
    parentTopologyInherited: true,
    orphanedChildrenReparented: true,
    missingParentsRejected: true,
    protectedSignalsEnforced: true,
    actorAwareInspection: true,
    gracefulSignalDelivery: true,
    signalGraceDeadlineForcesExit: true,
    sigkillBypassesRuntimeHooks: true,
    posixTerminationSignals: ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGTERM'],
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
