#!/usr/bin/env npx tsx

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import {
  makeTraceKernelHost,
  TraceKernelFileSystemError,
  type TraceKernelRuntimeProvider,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const text = (value: Uint8Array): string => decoder.decode(value);

async function main(): Promise<void> {
  let leaseReleaseCount = 0;
  const provider: TraceKernelRuntimeProvider = {
    runtime: 'vfs-test',
    initialize: Effect.succeed({
      acquire: (process) =>
        Effect.acquireRelease(
          Effect.succeed({
            id: `vfs-lease-${process.pid}`,
            runtime: 'vfs-test',
            execute: () => Effect.never,
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
      const session = yield* host.openSession({ cwd: '/workspace' });
      const reader = yield* session.spawn({
        runtime: 'vfs-test',
        command: 'reader',
        owner: { id: 'reader', kind: 'user' },
      });
      const writer = yield* session.spawn({
        runtime: 'vfs-test',
        command: 'writer',
        owner: { id: 'writer', kind: 'agent' },
      });
      yield* Effect.all([reader.awaitStarted(), writer.awaitStarted()], {
        concurrency: 'unbounded',
        discard: true,
      });

      yield* session.writeFile('shared.txt', bytes('before'));
      const generationAfterSeed = session.fileSystemGeneration;
      const liveReadFd = yield* session.openFile(reader, 'shared.txt', { access: 'read' });
      const liveWriteFd = yield* session.openFile(writer, 'shared.txt', {
        access: 'write',
        truncate: true,
      });
      yield* writer.write(liveWriteFd, bytes('after'));
      assertCondition(
        text(yield* reader.read(liveReadFd, 64)) === 'after',
        'A descriptor opened before another process write did not observe authoritative file contents.'
      );
      assertCondition(
        session.fileSystemGeneration > generationAfterSeed,
        'Authoritative writes did not advance the filesystem generation.'
      );

      yield* session.writeFile('offsets.txt', bytes('abcdef'));
      const independentA = yield* session.openFile(reader, 'offsets.txt', { access: 'read' });
      const independentB = yield* session.openFile(reader, 'offsets.txt', { access: 'read' });
      assertCondition(text(yield* reader.read(independentA, 2)) === 'ab', 'First independent open read incorrectly.');
      assertCondition(text(yield* reader.read(independentB, 2)) === 'ab', 'Independent opens shared an offset.');

      const sharedOffsetFd = yield* session.openFile(reader, 'offsets.txt', { access: 'read' });
      const duplicateFd = yield* reader.dup(sharedOffsetFd);
      assertCondition(text(yield* reader.read(sharedOffsetFd, 2)) === 'ab', 'Original descriptor read incorrectly.');
      assertCondition(
        text(yield* reader.read(sharedOffsetFd, 2, 4)) === 'ef',
        'Positioned read returned the wrong bytes.'
      );
      assertCondition(text(yield* reader.read(duplicateFd, 2)) === 'cd', 'dup() did not share the open-file offset.');
      yield* reader.close(sharedOffsetFd);
      assertCondition(text(yield* reader.read(duplicateFd, 2)) === 'ef', 'Closing one dup invalidated the shared description.');
      yield* reader.close(duplicateFd);

      yield* session.writeFile('inode.txt', bytes('old-inode'));
      const oldInodeFd = yield* session.openFile(reader, 'inode.txt', { access: 'read' });
      yield* session.unlink('inode.txt');
      yield* session.writeFile('inode.txt', bytes('new-inode'));
      const newInodeFd = yield* session.openFile(reader, 'inode.txt', { access: 'read' });
      assertCondition(
        text(yield* reader.read(oldInodeFd, 64)) === 'old-inode',
        'Unlink/recreate redirected an existing descriptor to the new pathname entry.'
      );
      assertCondition(
        text(yield* reader.read(newInodeFd, 64)) === 'new-inode',
        'Recreated pathname did not resolve to the new file node.'
      );

      yield* session.writeFile('append.log', new Uint8Array(0));
      const appendA = yield* session.openFile(reader, 'append.log', {
        access: 'write',
        append: true,
      });
      const appendB = yield* session.openFile(writer, 'append.log', {
        access: 'write',
        append: true,
      });
      yield* Effect.all([
        reader.write(appendA, bytes('A')),
        writer.write(appendB, bytes('B')),
      ], { concurrency: 'unbounded', discard: true });
      const appendResult = text(yield* session.readFile('append.log'));
      assertCondition(
        appendResult === 'AB' || appendResult === 'BA',
        `Concurrent append was not atomically serialized: ${JSON.stringify(appendResult)}`
      );

      const exclusive = yield* Effect.exit(session.openFile(writer, 'append.log', {
        access: 'write',
        create: true,
        exclusive: true,
      }));
      assertCondition(Exit.isFailure(exclusive), 'Exclusive create unexpectedly opened an existing file.');
      if (Exit.isFailure(exclusive)) {
        const failure = Cause.failureOption(exclusive.cause);
        assertCondition(
          Option.isSome(failure) &&
            failure.value instanceof TraceKernelFileSystemError &&
            failure.value.code === 'EEXIST',
          `Exclusive create failed with the wrong cause: ${Cause.pretty(exclusive.cause)}`
        );
      }

      yield* Effect.forEach(
        reader.snapshot().descriptors,
        (descriptor) => reader.close(descriptor.fd),
        { discard: true }
      );
      yield* Effect.forEach(
        writer.snapshot().descriptors,
        (descriptor) => writer.close(descriptor.fd),
        { discard: true }
      );
      assertCondition(session.resourceIds().length === 0, 'Closed file descriptions remained in the resource registry.');

      yield* Effect.all([
        reader.signal('SIGTERM'),
        writer.signal('SIGTERM'),
      ], { concurrency: 'unbounded', discard: true });
      assertCondition(session.processSnapshots().length === 0, 'VFS processes remained after termination.');
    })
  ));

  assertCondition(leaseReleaseCount === 2, `Expected two released runtime leases, observed ${leaseReleaseCount}.`);

  console.log(JSON.stringify({
    schema: 'tracekernel-013-vfs-v1',
    authoritativeCrossProcessReads: true,
    independentOpenOffsets: true,
    dupSharesOffset: true,
    unlinkPreservesOpenNode: true,
    atomicAppend: true,
    generationAdvancesOnMutation: true,
    fileDescriptionsCloseOnProcessExit: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
