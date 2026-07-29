#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import {
  makeTraceKernelHost,
  TraceKernelSyscallDispatcher,
  type TraceKernelRuntimeProvider,
} from '@tracecode/tracekernel';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function positiveInteger(name: string, fallback: number): number {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

const rounds = positiveInteger(
  'TRACECODE_TRACEKERNEL_ADVERSARIAL_ROUNDS',
  12
);
const processesPerRound = positiveInteger(
  'TRACECODE_TRACEKERNEL_ADVERSARIAL_PROCESSES',
  5
);
let leaseReleases = 0;

const provider: TraceKernelRuntimeProvider = {
  runtime: 'adversarial-teardown',
  initialize: Effect.succeed({
    acquire: (process) =>
      Effect.succeed({
        id: `adversarial-teardown-${process.pid}`,
        runtime: 'adversarial-teardown',
        execute: () => Effect.never,
        release: () =>
          Effect.sync(() => {
            leaseReleases += 1;
          }),
      }),
  }),
};

await Effect.runPromise(Effect.scoped(
  Effect.gen(function* () {
    const host = yield* makeTraceKernelHost({ providers: [provider] });

    for (let round = 0; round < rounds; round += 1) {
      const releasesBeforeRound = leaseReleases;
      yield* Effect.scoped(Effect.gen(function* () {
        const session = yield* host.openSession({
          maxProcesses: processesPerRound,
          signalGracePeriodMs: 0,
        });
        const pipeProcess = yield* session.spawn({
          runtime: 'adversarial-teardown',
          command: `pipe-reader-${round}`,
        });
        const socketProcess = yield* session.spawn({
          runtime: 'adversarial-teardown',
          command: `socket-listener-${round}`,
        });
        const watchProcess = yield* session.spawn({
          runtime: 'adversarial-teardown',
          command: `watch-reader-${round}`,
        });
        const parent = yield* session.spawn({
          runtime: 'adversarial-teardown',
          command: `wait-parent-${round}`,
        });
        const child = yield* session.spawnChild(parent, {
          runtime: 'adversarial-teardown',
          command: `wait-child-${round}`,
        });
        yield* Effect.all(
          [
            pipeProcess.awaitStarted(),
            socketProcess.awaitStarted(),
            watchProcess.awaitStarted(),
            parent.awaitStarted(),
            child.awaitStarted(),
          ],
          { concurrency: 'unbounded', discard: true }
        );

        const pipe = yield* session.createPipe(
          pipeProcess,
          pipeProcess,
          { capacityChunks: 1 }
        );
        const blockedPipeRead = yield* Effect.fork(
          pipeProcess.read(pipe.readFd, 16)
        );

        const listenerFd = yield* session.createTcpSocket(socketProcess);
        yield* session.bindTcp(socketProcess, listenerFd, {
          host: '127.0.0.1',
          port: 0,
        });
        yield* session.listenTcp(socketProcess, listenerFd);
        const blockedAccept = yield* Effect.fork(
          session.acceptTcp(socketProcess, listenerFd)
        );

        const watchSyscalls = new TraceKernelSyscallDispatcher(
          session,
          watchProcess
        );
        const watched = yield* watchSyscalls.dispatch({
          op: 'watch',
          path: '/workspace',
          options: { recursive: true, capacityEvents: 2 },
        });
        assertCondition(
          watched.ok && watched.value.op === 'watch',
          `Round ${round}: failed to create a watch descriptor.`
        );
        const blockedWatchRead = yield* Effect.fork(
          watchSyscalls.dispatch({
            op: 'read',
            fd: watched.value.fd,
            maxBytes: 256,
          })
        );

        const blockedChildWait = yield* Effect.fork(
          session.waitChild(parent, child.pid)
        );
        yield* Effect.yieldNow();
        assertCondition(
          Option.isNone(yield* Fiber.poll(blockedPipeRead)),
          `Round ${round}: pipe read did not block before teardown.`
        );
        assertCondition(
          Option.isNone(yield* Fiber.poll(blockedAccept)),
          `Round ${round}: TCP accept did not block before teardown.`
        );
        assertCondition(
          Option.isNone(yield* Fiber.poll(blockedWatchRead)),
          `Round ${round}: watch read did not block before teardown.`
        );
        assertCondition(
          Option.isNone(yield* Fiber.poll(blockedChildWait)),
          `Round ${round}: child wait did not block before teardown.`
        );
        assertCondition(
          session.processSnapshots().length === processesPerRound,
          `Round ${round}: process table changed before teardown.`
        );
        assertCondition(
          session.resourceIds().length >= 2,
          `Round ${round}: descriptor resources were not registered.`
        );

        yield* session.shutdown();

        const pipeExit = yield* Fiber.await(blockedPipeRead);
        const acceptExit = yield* Fiber.await(blockedAccept);
        const watchExit = yield* Fiber.await(blockedWatchRead);
        const waitExit = yield* Fiber.await(blockedChildWait);
        assertCondition(
          Exit.isFailure(pipeExit) ||
            (
              Exit.isSuccess(pipeExit) &&
              pipeExit.value.byteLength === 0
            ),
          `Round ${round}: pipe read survived teardown with data.`
        );
        assertCondition(
          Exit.isFailure(acceptExit),
          `Round ${round}: TCP accept survived listener teardown.`
        );
        assertCondition(
          Exit.isFailure(watchExit) ||
            (Exit.isSuccess(watchExit) && !watchExit.value.ok),
          `Round ${round}: watch read survived descriptor teardown.`
        );
        assertCondition(
          Exit.isFailure(waitExit) || Exit.isSuccess(waitExit),
          `Round ${round}: child wait did not settle.`
        );
        assertCondition(
          session.processTableSnapshots().length === 0,
          `Round ${round}: processes or zombies leaked after teardown.`
        );
        assertCondition(
          session.resourceIds().length === 0,
          `Round ${round}: descriptors, watches, or sockets leaked after teardown.`
        );
        assertCondition(
          session.terminalSnapshots().length === 0,
          `Round ${round}: terminal resources leaked after teardown.`
        );
        assertCondition(
          leaseReleases - releasesBeforeRound === processesPerRound,
          `Round ${round}: runtime leases were not released exactly once.`
        );

        yield* session.shutdown();
        assertCondition(
          leaseReleases - releasesBeforeRound === processesPerRound,
          `Round ${round}: repeated shutdown released a lease twice.`
        );
      }));
      assertCondition(
        host.sessionIds().length === 0,
        `Round ${round}: the closed session remained registered with its host.`
      );
    }
  })
));

console.log(JSON.stringify({
  schema: 'tracekernel-013-adversarial-teardown-v1',
  rounds,
  blockedOperationsPerRound: 4,
  totalProcesses: rounds * processesPerRound,
  exactlyOnceLeaseReleases: leaseReleases,
  repeatedShutdownIsIdempotent: true,
  leakedProcesses: 0,
  leakedResources: 0,
}));
