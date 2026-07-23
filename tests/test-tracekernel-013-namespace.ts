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

function assertFileSystemError(
  exit: Exit.Exit<unknown, Error>,
  expectedCode: TraceKernelFileSystemError['code']
): void {
  assertCondition(Exit.isFailure(exit), `Expected ${expectedCode}, but operation succeeded.`);
  if (Exit.isSuccess(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  assertCondition(
    Option.isSome(failure) &&
      failure.value instanceof TraceKernelFileSystemError &&
      failure.value.code === expectedCode,
    `Expected ${expectedCode}, received ${Cause.pretty(exit.cause)}`
  );
}

async function main(): Promise<void> {
  const provider: TraceKernelRuntimeProvider = {
    runtime: 'namespace-test',
    initialize: Effect.succeed({
      acquire: (process) =>
        Effect.acquireRelease(
          Effect.succeed({
            id: `namespace-lease-${process.pid}`,
            runtime: 'namespace-test',
            execute: () => Effect.never,
          }),
          () => Effect.void
        ),
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession({ cwd: '/workspace' });
      const process = yield* session.spawn({
        runtime: 'namespace-test',
        command: 'namespace-client',
        owner: { id: 'namespace-client', kind: 'user' },
      });
      yield* process.awaitStarted();

      const root = yield* session.stat('/');
      const workspace = yield* session.stat('.');
      assertCondition(root.kind === 'directory', 'TKFS root is not a directory.');
      assertCondition(workspace.kind === 'directory', 'Session cwd is not a directory.');
      assertCondition(root.inode !== workspace.inode, 'Root and workspace share an inode.');

      yield* session.mkdir('projects/demo', { recursive: true, mode: 0o750 });
      yield* session.writeFile('projects/demo/source.txt', bytes('source-bytes'));
      yield* session.writeFile('projects/demo/destination.txt', bytes('old-destination'));
      const sourceBeforeRename = yield* session.stat('projects/demo/source.txt');
      const destinationBeforeRename = yield* session.stat('projects/demo/destination.txt');

      const sourceFd = yield* session.openFile(process, 'projects/demo/source.txt', {
        access: 'read',
      });
      const replacedDestinationFd = yield* session.openFile(
        process,
        'projects/demo/destination.txt',
        { access: 'read' }
      );

      const generationBeforeRename = session.fileSystemGeneration;
      yield* session.rename(
        'projects/demo/source.txt',
        'projects/demo/destination.txt'
      );
      const destinationAfterRename = yield* session.stat('projects/demo/destination.txt');
      assertCondition(
        destinationAfterRename.inode === sourceBeforeRename.inode,
        'rename() changed the source inode instead of moving its namespace binding.'
      );
      assertCondition(
        destinationAfterRename.inode !== destinationBeforeRename.inode,
        'rename() did not replace the destination namespace binding.'
      );
      assertCondition(
        session.fileSystemGeneration > generationBeforeRename,
        'rename() did not advance the namespace generation.'
      );
      assertCondition(
        text(yield* process.read(sourceFd, 64)) === 'source-bytes',
        'An open source descriptor stopped referring to its inode after rename().'
      );
      assertCondition(
        text(yield* process.read(replacedDestinationFd, 64)) === 'old-destination',
        'Replacing a destination redirected its existing descriptor to the source inode.'
      );
      assertFileSystemError(
        yield* Effect.exit(session.stat('projects/demo/source.txt')),
        'ENOENT'
      );

      const demoEntries = yield* session.readdir('projects/demo');
      assertCondition(
        demoEntries.length === 1 &&
          demoEntries[0]?.name === 'destination.txt' &&
          demoEntries[0]?.kind === 'file',
        `readdir() returned the wrong immediate children: ${JSON.stringify(demoEntries)}`
      );

      yield* session.mkdir('tree/nested', { recursive: true });
      yield* session.writeFile('tree/nested/data.bin', bytes('tree-data'));
      const nestedBeforeRename = yield* session.stat('tree/nested/data.bin');
      yield* session.rename('tree', 'moved-tree');
      const nestedAfterRename = yield* session.stat('moved-tree/nested/data.bin');
      assertCondition(
        nestedAfterRename.inode === nestedBeforeRename.inode,
        'Directory rename did not preserve descendant inode identity.'
      );
      assertCondition(
        text(yield* session.readFile('moved-tree/nested/data.bin')) === 'tree-data',
        'Directory rename did not atomically move descendant bindings.'
      );
      assertFileSystemError(
        yield* Effect.exit(session.rename('moved-tree', 'moved-tree/nested/loop')),
        'EINVAL'
      );
      assertFileSystemError(
        yield* Effect.exit(session.rmdir('moved-tree')),
        'ENOTEMPTY'
      );
      assertFileSystemError(
        yield* Effect.exit(session.unlink('moved-tree')),
        'EISDIR'
      );

      yield* session.mkdir('empty');
      yield* session.rmdir('empty');
      assertFileSystemError(yield* Effect.exit(session.stat('empty')), 'ENOENT');

      const workspaceEntries = yield* session.readdir('.');
      assertCondition(
        workspaceEntries.map((entry) => entry.name).join(',') ===
          'moved-tree,projects',
        `Directory entries are not deterministic and sorted: ${JSON.stringify(workspaceEntries)}`
      );

      yield* session.writeFile('hard-source.txt', bytes('hard-before'));
      const hardDescriptor = yield* session.openFile(process, 'hard-source.txt', {
        access: 'read',
      });
      yield* session.link('hard-source.txt', 'hard-alias.txt');
      const hardSourceStat = yield* session.stat('hard-source.txt');
      const hardAliasStat = yield* session.stat('hard-alias.txt');
      assertCondition(
        hardSourceStat.inode === hardAliasStat.inode &&
          hardSourceStat.nlink === 2 &&
          hardAliasStat.nlink === 2,
        'Hard-link bindings did not share an inode and link count.'
      );
      yield* session.writeFile('hard-alias.txt', bytes('hard-after'));
      assertCondition(
        text(yield* session.readFile('hard-source.txt')) === 'hard-after',
        'Writing through a hard-link alias did not update the shared node.'
      );
      yield* session.unlink('hard-source.txt');
      assertCondition(
        (yield* session.stat('hard-alias.txt')).nlink === 1,
        'Removing one hard-link binding did not decrement the live link count.'
      );
      assertCondition(
        text(yield* process.read(hardDescriptor, 64)) === 'hard-after',
        'An open description lost the shared hard-link node after unlink.'
      );
      assertFileSystemError(
        yield* Effect.exit(session.link('moved-tree', 'directory-hard-link')),
        'EPERM'
      );

      yield* session.symlink('projects/demo/destination.txt', 'destination-link');
      assertCondition(
        (yield* session.readlink('destination-link')) === 'projects/demo/destination.txt',
        'readlink() did not preserve the literal relative target.'
      );
      const linkStat = yield* session.lstat('destination-link');
      const followedLinkStat = yield* session.stat('destination-link');
      assertCondition(
        linkStat.kind === 'symlink' &&
          linkStat.nlink === 1 &&
          followedLinkStat.inode === destinationAfterRename.inode,
        'lstat() and stat() did not distinguish a symlink from its target.'
      );
      assertCondition(
        (yield* session.realpath('destination-link')) ===
          '/workspace/projects/demo/destination.txt',
        'realpath() did not resolve a relative symlink target.'
      );
      yield* session.writeFile('destination-link', bytes('through-link'));
      assertCondition(
        text(yield* session.readFile('projects/demo/destination.txt')) === 'through-link',
        'Writing through a symlink did not mutate its target.'
      );

      yield* session.symlink('projects', 'projects-link');
      assertCondition(
        text(yield* session.readFile('projects-link/demo/destination.txt')) === 'through-link',
        'A symbolic-link parent component was not traversed.'
      );
      yield* session.symlink('missing-target', 'dangling-link');
      assertCondition(
        (yield* session.lstat('dangling-link')).kind === 'symlink',
        'lstat() did not preserve a dangling symlink entry.'
      );
      assertFileSystemError(
        yield* Effect.exit(session.stat('dangling-link')),
        'ENOENT'
      );
      yield* session.symlink('loop-b', 'loop-a');
      yield* session.symlink('loop-a', 'loop-b');
      assertFileSystemError(yield* Effect.exit(session.stat('loop-a')), 'ELOOP');
      yield* session.unlink('destination-link');
      assertCondition(
        text(yield* session.readFile('projects/demo/destination.txt')) === 'through-link',
        'unlink() followed a symlink and removed its target.'
      );

      yield* process.close(hardDescriptor);
      yield* process.close(sourceFd);
      yield* process.close(replacedDestinationFd);
      yield* process.signal('SIGTERM');
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-013-namespace-v1',
    rootAndWorkspaceDirectories: true,
    recursiveMkdirAndSortedReaddir: true,
    stableInodesAcrossRename: true,
    atomicDestinationReplacement: true,
    openDescriptorsSurviveNamespaceChanges: true,
    directorySubtreesMoveAtomically: true,
    hardLinksShareInodesAndData: true,
    symlinkTraversalAndEntryOperations: true,
    danglingAndLoopErrors: true,
    posixNamespaceErrors: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
