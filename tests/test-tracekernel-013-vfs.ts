#!/usr/bin/env npx tsx

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import {
  makeTraceKernelHost,
  TraceKernelFileSystem,
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

      yield* session.mkdir('image-tree');
      yield* session.writeFile('image-tree/source.txt', bytes('shared inode'));
      yield* session.fileSystem.chmod('image-tree/source.txt', 0o640);
      yield* session.fileSystem.utimes('image-tree/source.txt', 1_700_000_000_000);
      yield* session.link('image-tree/source.txt', 'image-tree/alias.txt');
      yield* session.symlink('source.txt', 'image-tree/current.txt');
      assertCondition(
        session.fileSystem.namespacePaths().includes('/workspace/image-tree/current.txt'),
        'Synchronous namespace discovery omitted a committed symbolic link.'
      );
      const image = yield* session.fileSystem.exportImage();
      const hydratedSession = yield* host.openSession({
        cwd: '/workspace/image-tree',
        fileSystemImage: image,
      });
      const hydrated = hydratedSession.fileSystem;
      assertCondition(
        text(yield* hydratedSession.readFile('current.txt')) === 'shared inode',
        'Hydration did not preserve symbolic-link resolution.'
      );
      const hydratedStat = yield* hydratedSession.stat('source.txt');
      assertCondition(
        hydratedStat.mode === 0o640 && hydratedStat.modifiedAt === 1_700_000_000_000,
        'Hydration did not preserve chmod/utimes metadata.'
      );
      yield* hydratedSession.writeFile('alias.txt', bytes('updated inode'));
      assertCondition(
        text(yield* hydratedSession.readFile('source.txt')) === 'updated inode',
        'Hydration did not preserve hard-link inode identity.'
      );
      yield* hydratedSession.unlink('source.txt');
      assertCondition(
        text(yield* hydratedSession.readFile('alias.txt')) === 'updated inode',
        'Removing one hydrated hard link removed the shared inode.'
      );
      assertCondition(
        hydrated.mutationGeneration > image.mutationGeneration,
        'A hydrated filesystem did not continue the committed generation sequence.'
      );
      const exportedFile = image.inodes.find(
        (inode) => inode.kind === 'file' && text(inode.contents) === 'shared inode'
      );
      assertCondition(exportedFile?.kind === 'file', 'Exported image omitted file inode contents.');
      if (exportedFile?.kind === 'file') exportedFile.contents[0] = '!'.charCodeAt(0);
      assertCondition(
        text(yield* session.readFile('image-tree/source.txt')) === 'shared inode',
        'Exported image bytes remained aliased to the authoritative filesystem.'
      );

      const externallyOwnedFileSystem = yield* TraceKernelFileSystem.make();
      yield* externallyOwnedFileSystem.writeFile(
        '/workspace/host.txt',
        bytes('host authority'),
        '/'
      );
      const attachedSession = yield* host.openSession({
        fileSystem: externallyOwnedFileSystem,
      });
      assertCondition(
        text(yield* attachedSession.readFile('host.txt')) === 'host authority',
        'A session did not attach to the host-owned filesystem authority.'
      );
      const duplicateAttachment = yield* Effect.exit(host.openSession({
        fileSystem: externallyOwnedFileSystem,
      }));
      assertCondition(
        Exit.isFailure(duplicateAttachment),
        'One host allowed two live sessions to claim the same filesystem.'
      );
      if (Exit.isFailure(duplicateAttachment)) {
        const failure = Cause.failureOption(duplicateAttachment.cause);
        assertCondition(
          Option.isSome(failure) &&
            failure.value instanceof TraceKernelFileSystemError &&
            failure.value.code === 'EBUSY',
          `Duplicate filesystem attachment failed incorrectly: ${Cause.pretty(
            duplicateAttachment.cause
          )}`
        );
      }
      yield* attachedSession.shutdown();
      assertCondition(
        text(yield* externallyOwnedFileSystem.readFile('/workspace/host.txt', '/')) ===
          'host authority',
        'Session shutdown cleared its host-owned filesystem.'
      );

      const quotaFileSystem = yield* TraceKernelFileSystem.make({
        quota: {
          root: '/workspace',
          maxBytes: 8,
          maxFileBytes: 6,
          maxEntries: 3,
        },
      });
      yield* quotaFileSystem.mkdir('/workspace/data', {}, '/');
      const oversizedFile = yield* Effect.exit(
        quotaFileSystem.writeFile('/workspace/oversized.txt', bytes('1234567'), '/')
      );
      assertCondition(Exit.isFailure(oversizedFile), 'TKFS accepted a file over maxFileBytes.');
      if (Exit.isFailure(oversizedFile)) {
        const failure = Cause.failureOption(oversizedFile.cause);
        assertCondition(
          Option.isSome(failure) &&
            failure.value instanceof TraceKernelFileSystemError &&
            failure.value.code === 'EFBIG',
          `Oversized TKFS file failed incorrectly: ${Cause.pretty(oversizedFile.cause)}`
        );
      }
      yield* quotaFileSystem.writeFile('/workspace/data/value.txt', bytes('1234'), '/');
      yield* quotaFileSystem.link(
        '/workspace/data/value.txt',
        '/workspace/data/alias.txt',
        '/'
      );
      const quotaOpenFile = yield* quotaFileSystem.prepareOpen(
        '/workspace/data/alias.txt',
        '/',
        { access: 'write' }
      );
      const linkedResize = yield* Effect.exit(
        quotaFileSystem.writeAt(quotaOpenFile, 4, bytes('5'), false)
      );
      assertCondition(
        Exit.isFailure(linkedResize),
        'An open-fd write bypassed aggregate hard-link quota accounting.'
      );
      if (Exit.isFailure(linkedResize)) {
        const failure = Cause.failureOption(linkedResize.cause);
        assertCondition(
          Option.isSome(failure) &&
            failure.value instanceof TraceKernelFileSystemError &&
            failure.value.code === 'ENOSPC',
          `Hard-link quota write failed incorrectly: ${Cause.pretty(linkedResize.cause)}`
        );
      }
      assertCondition(
        text(yield* quotaFileSystem.readFile('/workspace/data/value.txt', '/')) === '1234',
        'A rejected quota write partially changed the shared inode.'
      );
      const entryLimit = yield* Effect.exit(
        quotaFileSystem.mkdir('/workspace/extra', {}, '/')
      );
      assertCondition(Exit.isFailure(entryLimit), 'TKFS accepted an entry over maxEntries.');

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
    losslessImageHydration: true,
    imagePreservesHardLinks: true,
    imagePreservesSymlinks: true,
    imagePreservesMetadata: true,
    hostOwnedAuthorityAttachment: true,
    quotaPreflightsOpenFileWrites: true,
    quotaCountsHardLinks: true,
    fileDescriptionsCloseOnProcessExit: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
