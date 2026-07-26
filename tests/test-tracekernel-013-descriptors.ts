#!/usr/bin/env npx tsx

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import {
  makeTraceKernelHost,
  TraceKernelBadFileDescriptorError,
  TraceKernelDescriptorLimitError,
  TraceKernelWouldBlockError,
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

      const firstPipe = yield* session.createPipe(reader, writer, {
        capacityChunks: 1,
        closeOnExec: true,
      });
      assertCondition(
        reader.snapshot().descriptors.some((descriptor) =>
          descriptor.fd === firstPipe.readFd &&
          descriptor.kind === 'pipe-reader' &&
          descriptor.closeOnExec
        ),
        'pipe2-style creation did not install a close-on-exec reader.'
      );
      assertCondition(
        writer.snapshot().descriptors.some((descriptor) =>
          descriptor.fd === firstPipe.writeFd &&
          descriptor.kind === 'pipe-writer' &&
          descriptor.closeOnExec
        ),
        'pipe2-style creation did not install a close-on-exec writer.'
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

      const nonblockingPipe = yield* session.createPipe(reader, writer, {
        capacityChunks: 1,
        nonblocking: true,
      });
      assertCondition(
        reader.snapshot().descriptors.find(
          ({ fd }) => fd === nonblockingPipe.readFd
        )?.nonblocking === true &&
          writer.snapshot().descriptors.find(
            ({ fd }) => fd === nonblockingPipe.writeFd
          )?.nonblocking === true,
        'pipe2-style O_NONBLOCK state was not installed on both open descriptions.'
      );
      const emptyNonblockingRead = yield* Effect.exit(
        reader.read(nonblockingPipe.readFd, 16)
      );
      const emptyReadFailure = Exit.isFailure(emptyNonblockingRead)
        ? Cause.failureOption(emptyNonblockingRead.cause)
        : Option.none();
      assertCondition(
        Exit.isFailure(emptyNonblockingRead) &&
          Option.isSome(emptyReadFailure) &&
          emptyReadFailure.value instanceof TraceKernelWouldBlockError,
        'An empty nonblocking pipe read did not return EAGAIN.'
      );
      yield* writer.write(nonblockingPipe.writeFd, encoder.encode('queued'));
      const fullNonblockingWrite = yield* Effect.exit(
        writer.write(nonblockingPipe.writeFd, encoder.encode('blocked'))
      );
      const fullWriteFailure = Exit.isFailure(fullNonblockingWrite)
        ? Cause.failureOption(fullNonblockingWrite.cause)
        : Option.none();
      assertCondition(
        Exit.isFailure(fullNonblockingWrite) &&
          Option.isSome(fullWriteFailure) &&
          fullWriteFailure.value instanceof TraceKernelWouldBlockError,
        'A full nonblocking pipe write did not return EAGAIN.'
      );
      const duplicateReader = yield* reader.dup(nonblockingPipe.readFd);
      yield* reader.descriptors.setNonblocking(duplicateReader, false);
      assertCondition(
        !(yield* reader.descriptors.getNonblocking(nonblockingPipe.readFd)),
        'Changing O_NONBLOCK through dup did not update the shared open description.'
      );
      yield* reader.descriptors.setNonblocking(nonblockingPipe.readFd, true);
      yield* reader.close(duplicateReader);
      assertCondition(
        decoder.decode(yield* reader.read(nonblockingPipe.readFd, 16)) === 'queued',
        'A ready nonblocking pipe read lost queued data.'
      );
      yield* writer.close(nonblockingPipe.writeFd);
      assertCondition(
        (yield* reader.read(nonblockingPipe.readFd, 16)).byteLength === 0,
        'A nonblocking pipe did not report EOF after final writer close.'
      );
      yield* reader.close(nonblockingPipe.readFd);

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

      const limitedSession = yield* host.openSession({
        maxDescriptorsPerProcess: 2,
      });
      const limited = yield* limitedSession.spawn({
        runtime: 'blocking-test',
        command: 'descriptor-limit',
      });
      yield* limited.awaitStarted();
      const firstSocket = yield* limitedSession.createTcpSocket(limited);
      const secondSocket = yield* limitedSession.createTcpSocket(limited);
      const overflow = yield* Effect.exit(
        limitedSession.createTcpSocket(limited)
      );
      assertCondition(
        Exit.isFailure(overflow),
        'Opening beyond the process descriptor ceiling unexpectedly succeeded.'
      );
      if (Exit.isFailure(overflow)) {
        const failure = Cause.failureOption(overflow.cause);
        assertCondition(
          Option.isSome(failure) &&
            failure.value instanceof TraceKernelDescriptorLimitError &&
            failure.value.code === 'EMFILE',
          `Descriptor exhaustion did not return EMFILE: ${Cause.pretty(overflow.cause)}`
        );
      }
      assertCondition(
        limited.snapshot().descriptors.length === 2 &&
          limitedSession.resourceIds().length === 2,
        'A rejected socket install leaked a descriptor or network resource.'
      );

      yield* limited.close(firstSocket);
      const reusedSocket = yield* limitedSession.createTcpSocket(limited);
      assertCondition(
        reusedSocket === firstSocket,
        `The descriptor table did not reuse its lowest available FD: ${reusedSocket}`
      );
      const duplicateOverflow = yield* Effect.exit(limited.dup(secondSocket));
      assertCondition(
        Exit.isFailure(duplicateOverflow),
        'dup() bypassed the process descriptor ceiling.'
      );
      if (Exit.isFailure(duplicateOverflow)) {
        const failure = Cause.failureOption(duplicateOverflow.cause);
        assertCondition(
          Option.isSome(failure) &&
            failure.value instanceof TraceKernelDescriptorLimitError,
          `dup() exhaustion did not retain EMFILE: ${Cause.pretty(duplicateOverflow.cause)}`
        );
      }
      assertCondition(
        limited.snapshot().descriptors.length === 2 &&
          limitedSession.resourceIds().length === 2,
        'A rejected dup() leaked a descriptor reference.'
      );
      const sourceResource = limited.snapshot().descriptors.find(
        (descriptor) => descriptor.fd === secondSocket
      )?.resourceId;
      assertCondition(
        (yield* limited.dup2(secondSocket, secondSocket)) === secondSocket &&
          limitedSession.resourceIds().length === 2,
        'dup2(fd, fd) was not a validated no-op.'
      );
      assertCondition(
        (yield* limited.dup2(secondSocket, reusedSocket)) === reusedSocket,
        'dup2() did not preserve the requested target descriptor number.'
      );
      assertCondition(
        (yield* limited.dup3(secondSocket, reusedSocket, true)) === reusedSocket &&
          (yield* limited.descriptors.getCloseOnExec(reusedSocket)),
        'dup3(O_CLOEXEC) did not atomically replace and flag its target.'
      );
      const invalidDup3 = yield* Effect.exit(
        limited.dup3(secondSocket, secondSocket, true)
      );
      assertCondition(
        Exit.isFailure(invalidDup3),
        'dup3(fd, fd) did not reject identical descriptors.'
      );
      yield* limited.dup2(secondSocket, reusedSocket);
      assertCondition(
        !(yield* limited.descriptors.getCloseOnExec(reusedSocket)),
        'dup2() did not clear a displaced target descriptor flag.'
      );
      assertCondition(
        limited.snapshot().descriptors.length === 2 &&
          limited.snapshot().descriptors.every(
            (descriptor) => descriptor.resourceId === sourceResource
          ) &&
          limitedSession.resourceIds().length === 1,
        'dup2() did not atomically replace and close the occupied target at the descriptor ceiling.'
      );
      const invalidDup2 = yield* Effect.exit(limited.dup2(999_999, reusedSocket));
      assertCondition(
        Exit.isFailure(invalidDup2) &&
          limited.snapshot().descriptors.find(
            (descriptor) => descriptor.fd === reusedSocket
          )?.resourceId === sourceResource,
        'A failed dup2() changed the existing target descriptor.'
      );
      yield* limited.close(secondSocket);
      yield* limited.close(reusedSocket);
      const pipeLimitBlocker = yield* limitedSession.createTcpSocket(limited);
      const pipeOverflow = yield* Effect.exit(
        limitedSession.createPipe(limited, limited)
      );
      assertCondition(
        Exit.isFailure(pipeOverflow) &&
          limited.snapshot().descriptors.length === 1 &&
          limitedSession.resourceIds().length === 1,
        'A partially installed pipe survived an EMFILE rollback.'
      );
      yield* limited.close(pipeLimitBlocker);
      yield* limited.signal('SIGTERM');
      assertCondition(
        limitedSession.resourceIds().length === 0,
        'Limited process teardown stranded socket resources.'
      );

      const inheritanceSession = yield* host.openSession();
      const parent = yield* inheritanceSession.spawn({
        runtime: 'blocking-test',
        command: 'descriptor-parent',
      });
      yield* parent.awaitStarted();
      yield* inheritanceSession.writeFile('/not-inherited.txt', encoder.encode('private'));
      yield* inheritanceSession.writeFile('/inherited.txt', new Uint8Array(0));
      const privateFd = yield* inheritanceSession.openFile(parent, '/not-inherited.txt', {
        access: 'read',
      });
      const sharedFd = yield* inheritanceSession.openFile(parent, '/inherited.txt', {
        access: 'read-write',
      });
      yield* parent.write(sharedFd, encoder.encode('parent-'));
      yield* parent.descriptors.setCloseOnExec(privateFd, true);
      assertCondition(
        (yield* parent.descriptors.getCloseOnExec(privateFd)) &&
          parent.snapshot().descriptors.find(({ fd }) => fd === privateFd)?.closeOnExec === true,
        'Kernel descriptor flags did not preserve FD_CLOEXEC state.'
      );

      const execStyleChild = yield* inheritanceSession.spawn({
        runtime: 'blocking-test',
        command: 'descriptor-exec-style-child',
        parentPid: parent.pid,
        inheritDescriptors: 'all',
      });
      yield* execStyleChild.awaitStarted();
      assertCondition(
        !execStyleChild.snapshot().descriptors.some(({ fd }) => fd === privateFd) &&
          execStyleChild.snapshot().descriptors.some(({ fd }) => fd === sharedFd),
        `inherit-all copied a close-on-exec descriptor: ${JSON.stringify(
          execStyleChild.snapshot().descriptors
        )}`
      );
      yield* execStyleChild.close(sharedFd);
      yield* execStyleChild.signal('SIGTERM');
      yield* inheritanceSession.waitChild(parent, execStyleChild.pid);

      const isolatedChild = yield* inheritanceSession.spawn({
        runtime: 'blocking-test',
        command: 'descriptor-isolated-child',
        parentPid: parent.pid,
      });
      yield* isolatedChild.awaitStarted();
      assertCondition(
        isolatedChild.snapshot().descriptors.length === 0,
        `Default child spawn leaked parent descriptors: ${JSON.stringify(
          isolatedChild.snapshot().descriptors
        )}`
      );
      const isolatedRead = yield* Effect.exit(isolatedChild.read(privateFd, 32));
      assertCondition(
        Exit.isFailure(isolatedRead),
        'A child read a parent descriptor that was not explicitly inherited.'
      );
      if (Exit.isFailure(isolatedRead)) {
        const failure = Cause.failureOption(isolatedRead.cause);
        assertCondition(
          Option.isSome(failure) &&
            failure.value instanceof TraceKernelBadFileDescriptorError,
          `Non-inherited descriptor access did not return EBADF: ${Cause.pretty(
            isolatedRead.cause
          )}`
        );
      }
      const parentPrivate = yield* parent.read(privateFd, 32, 0);
      assertCondition(
        decoder.decode(parentPrivate) === 'private',
        'Rejected child descriptor access changed the parent descriptor state.'
      );

      const child = yield* inheritanceSession.spawn({
        runtime: 'blocking-test',
        command: 'descriptor-child',
        parentPid: parent.pid,
        descriptorMappings: [{ parentFd: sharedFd, childFd: 41 }],
        descriptorActions: [
          { op: 'dup2', fd: 41, targetFd: 42 },
          { op: 'close', fd: 41 },
        ],
      });
      yield* child.awaitStarted();
      assertCondition(
        child.snapshot().descriptors.length === 1 &&
          child.snapshot().descriptors[0]?.fd === 42 &&
          child.snapshot().descriptors[0]?.resourceId ===
            parent.snapshot().descriptors.find((descriptor) => descriptor.fd === sharedFd)?.resourceId,
        `Child descriptor actions did not preserve open-description identity at the remapped fd: ${JSON.stringify(child.snapshot().descriptors)}`
      );

      yield* parent.close(sharedFd);
      yield* child.write(42, encoder.encode('child'));
      assertCondition(
        decoder.decode(yield* inheritanceSession.readFile('/inherited.txt')) === 'parent-child',
        'Inherited file descriptor did not retain the shared offset after parent close.'
      );
      const childSocket = yield* inheritanceSession.createTcpSocket(child);
      assertCondition(
        childSocket === privateFd,
        `Selective inheritance did not preserve the lowest free fd hole: ${childSocket}`
      );

      const invalidInheritance = yield* Effect.exit(inheritanceSession.spawn({
        runtime: 'blocking-test',
        command: 'invalid-inheritance',
        parentPid: parent.pid,
        inheritDescriptors: [999_999],
      }));
      assertCondition(
        Exit.isFailure(invalidInheritance),
        'A child inherited a descriptor that was absent from its parent.'
      );
      if (Exit.isFailure(invalidInheritance)) {
        const failure = Cause.failureOption(invalidInheritance.cause);
        assertCondition(
          Option.isSome(failure) &&
            failure.value instanceof TraceKernelBadFileDescriptorError &&
            inheritanceSession.processSnapshots().length === 3,
          `Failed inheritance was not rolled back atomically: ${Cause.pretty(invalidInheritance.cause)}`
        );
      }

      yield* child.close(42);
      yield* child.close(childSocket);
      yield* parent.close(privateFd);
      yield* Effect.all([
        parent.signal('SIGTERM'),
        child.signal('SIGTERM'),
        isolatedChild.signal('SIGTERM'),
      ], { concurrency: 'unbounded', discard: true });
      assertCondition(
        inheritanceSession.resourceIds().length === 0,
        'Inherited descriptor references stranded session resources after teardown.'
      );
    })
  ));

  assertCondition(leaseAcquireCount === 7, `Expected seven runtime leases, acquired ${leaseAcquireCount}.`);
  assertCondition(leaseReleaseCount === 7, `Expected seven runtime lease releases, observed ${leaseReleaseCount}.`);

  console.log(JSON.stringify({
    schema: 'tracekernel-013-descriptors-v1',
    processOwnedDescriptors: true,
    fragmentedReads: true,
    boundedBackpressure: true,
    nonblockingPipeEagain: true,
    openDescriptionFlagsSharedAcrossDup: true,
    writerCloseProducesEof: true,
    blockedReadInterruptedOnProcessExit: true,
    resourcesReleasedOnFinalDescriptorClose: true,
    descriptorCeilingReturnsEmfile: true,
    lowestAvailableFdReused: true,
    atomicDup2Replacement: true,
    atomicDup3CloseOnExec: true,
    closeOnExecPipeCreation: true,
    failedInstallsReleaseResources: true,
    defaultDescriptorNonInheritance: true,
    closeOnExecDescriptorFiltering: true,
    selectiveDescriptorInheritance: true,
    atomicCrossIdentityDescriptorMapping: true,
    orderedSpawnDescriptorActions: true,
    inheritedOpenDescriptionShared: true,
    failedInheritanceRollsBack: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
