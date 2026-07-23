#!/usr/bin/env npx tsx

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import {
  makeTraceKernelHost,
  TraceKernelBadFileDescriptorError,
  type TraceKernelRuntimeProvider,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function main(): Promise<void> {
  let leaseAcquireCount = 0;
  let leaseReleaseCount = 0;

  const provider: TraceKernelRuntimeProvider = {
    runtime: 'blocking-test',
    initialize: Effect.succeed({
      acquire: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const id = `blocking-lease-${++leaseAcquireCount}`;
            return {
              id,
              runtime: 'blocking-test',
              execute: () => Effect.never,
            };
          }),
          () => Effect.sync(() => {
            leaseReleaseCount += 1;
          })
        ),
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession();
      const reader = yield* session.spawn({
        runtime: 'blocking-test',
        command: 'reader',
        owner: { id: 'reader-owner', kind: 'user' },
      });
      const writer = yield* session.spawn({
        runtime: 'blocking-test',
        command: 'writer',
        owner: { id: 'writer-owner', kind: 'agent' },
      });
      yield* Effect.all([reader.awaitStarted(), writer.awaitStarted()], {
        concurrency: 'unbounded',
        discard: true,
      });

      const firstPipe = yield* session.createPipe(reader, writer, { capacityChunks: 1 });
      assertCondition(
        reader.snapshot().descriptors.some((descriptor) =>
          descriptor.fd === firstPipe.readFd && descriptor.kind === 'pipe-reader'
        ),
        'Reader process did not own the read descriptor.'
      );
      assertCondition(
        writer.snapshot().descriptors.some((descriptor) =>
          descriptor.fd === firstPipe.writeFd && descriptor.kind === 'pipe-writer'
        ),
        'Writer process did not own the write descriptor.'
      );

      yield* writer.write(firstPipe.writeFd, encoder.encode('abcdef'));
      const firstFragment = yield* reader.read(firstPipe.readFd, 2);
      const secondFragment = yield* reader.read(firstPipe.readFd, 8);
      assertCondition(decoder.decode(firstFragment) === 'ab', 'Pipe did not fragment the first read.');
      assertCondition(decoder.decode(secondFragment) === 'cdef', 'Pipe did not preserve the unread remainder.');

      yield* writer.write(firstPipe.writeFd, encoder.encode('one'));
      const backpressuredWrite = yield* Effect.fork(
        writer.write(firstPipe.writeFd, encoder.encode('two'))
      );
      yield* Effect.yieldNow();
      const pendingWrite = yield* Fiber.poll(backpressuredWrite);
      assertCondition(Option.isNone(pendingWrite), 'Bounded pipe did not apply writer backpressure.');

      const firstQueuedChunk = yield* reader.read(firstPipe.readFd, 16);
      assertCondition(decoder.decode(firstQueuedChunk) === 'one', 'Pipe returned the wrong queued chunk.');
      const secondWriteCount = yield* Fiber.join(backpressuredWrite);
      assertCondition(secondWriteCount === 3, 'Backpressured write returned the wrong byte count.');
      const secondQueuedChunk = yield* reader.read(firstPipe.readFd, 16);
      assertCondition(decoder.decode(secondQueuedChunk) === 'two', 'Released writer data was not preserved.');

      const eofRead = yield* Effect.fork(reader.read(firstPipe.readFd, 16));
      yield* Effect.yieldNow();
      assertCondition(Option.isNone(yield* Fiber.poll(eofRead)), 'Empty pipe read did not block.');
      yield* writer.close(firstPipe.writeFd);
      const eof = yield* Fiber.join(eofRead);
      assertCondition(eof.byteLength === 0, 'Closing the final writer did not produce EOF.');
      yield* reader.close(firstPipe.readFd);
      assertCondition(session.resourceIds().length === 0, 'Fully closed pipe remained in the resource registry.');

      const teardownPipe = yield* session.createPipe(reader, writer, { capacityChunks: 1 });
      const blockedRead = yield* Effect.fork(reader.read(teardownPipe.readFd, 16));
      yield* Effect.yieldNow();
      assertCondition(Option.isNone(yield* Fiber.poll(blockedRead)), 'Teardown read did not block.');

      yield* reader.signal('SIGTERM');
      const blockedReadExit = yield* Fiber.await(blockedRead);
      assertCondition(Exit.isFailure(blockedReadExit), 'Closing the reader process did not fail its blocked read.');
      if (Exit.isFailure(blockedReadExit)) {
        const failure = Cause.failureOption(blockedReadExit.cause);
        assertCondition(
          Option.isSome(failure) && failure.value instanceof TraceKernelBadFileDescriptorError,
          `Blocked read failed with the wrong cause: ${Cause.pretty(blockedReadExit.cause)}`
        );
      }
      assertCondition(reader.snapshot().descriptors.length === 0, 'Process exit did not close reader descriptors.');
      assertCondition(leaseReleaseCount === 1, 'Reader runtime lease was not released on process exit.');

      yield* writer.signal('SIGTERM');
      assertCondition(writer.snapshot().descriptors.length === 0, 'Process exit did not close writer descriptors.');
      assertCondition(leaseReleaseCount === 2, 'Writer runtime lease was not released on process exit.');
      assertCondition(session.resourceIds().length === 0, 'Process teardown stranded a pipe resource.');
      assertCondition(session.processSnapshots().length === 0, 'Terminated pipe processes remained registered.');
    })
  ));

  assertCondition(leaseAcquireCount === 2, `Expected two runtime leases, acquired ${leaseAcquireCount}.`);
  assertCondition(leaseReleaseCount === 2, `Expected two runtime lease releases, observed ${leaseReleaseCount}.`);

  console.log(JSON.stringify({
    schema: 'tracekernel-013-descriptors-v1',
    processOwnedDescriptors: true,
    fragmentedReads: true,
    boundedBackpressure: true,
    writerCloseProducesEof: true,
    blockedReadInterruptedOnProcessExit: true,
    resourcesReleasedOnFinalDescriptorClose: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
