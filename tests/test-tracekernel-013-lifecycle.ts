#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import {
  makeTraceKernelHost,
  TraceKernelProcessLimitError,
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

  const provider: TraceKernelRuntimeProvider = {
    runtime: 'test',
    initialize: Effect.sync(() => {
      initializeCount += 1;
      return {
        acquire: (process) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquireCount += 1;
              const leaseId = `lease-${acquireCount}`;
              return {
                id: leaseId,
                runtime: 'test',
                execute: () => {
                  if (process.command === 'block') return Effect.never;
                  if (process.command === 'fail') return Effect.fail(new Error('runtime failed'));
                  return Effect.sleep(5).pipe(
                    Effect.as({
                      exitCode: 0,
                      stdout: `${process.command}:${process.pid}\n`,
                      stderr: '',
                    })
                  );
                },
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
    })
  ));

  assertCondition(initializeCount === 1, 'Provider initialization should remain memoized for the host lifetime.');
  assertCondition(acquireCount === 9, `Expected nine leases, acquired ${acquireCount}.`);
  assertCondition(releaseCount === 9, `Expected nine lease releases, observed ${releaseCount}.`);
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
    parentTopologyInherited: true,
    orphanedChildrenReparented: true,
    missingParentsRejected: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
