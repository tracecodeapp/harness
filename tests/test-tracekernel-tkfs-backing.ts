#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import { TraceKernelFileSystem } from '@tracecode/tracekernel';
import { createRuntimeWorkspace } from '../packages/harness-project/src/index';
import { TraceKernelBackingFileSystem } from '../packages/harness-project/src/tkfs-backing-filesystem';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function main(): Promise<void> {
  const tkfs = await Effect.runPromise(TraceKernelFileSystem.make());
  const fs = new TraceKernelBackingFileSystem(tkfs);
  const externalMutations: Array<{
    operation: string;
    paths: readonly string[];
  }> = [];
  const stopWatchingExternalMutations = fs.watchExternalMutations((mutation) => {
    externalMutations.push({
      operation: mutation.operation,
      paths: mutation.paths,
    });
  });

  await fs.mkdir('/workspace/tree/nested', { recursive: true });
  await fs.writeFile('/workspace/tree/nested/data.txt', '68656c6c6f', 'hex');
  await fs.appendFile('/workspace/tree/nested/data.txt', ' world');
  assertCondition(
    await fs.readFile('/workspace/tree/nested/data.txt') === 'hello world',
    'The shell filesystem adapter did not preserve encoded write and append behavior.'
  );

  await Effect.runPromise(
    tkfs.writeFile('/workspace/from-kernel.txt', new TextEncoder().encode('kernel'), '/')
  );
  assertCondition(
    await fs.readFile('/workspace/from-kernel.txt') === 'kernel',
    'A direct TKFS write was not immediately visible through the shell adapter.'
  );
  assertCondition(
    externalMutations.length === 1 &&
      externalMutations[0]?.operation === 'write' &&
      externalMutations[0]?.paths.includes('/workspace/from-kernel.txt') === true,
    'The shell adapter did not distinguish a direct kernel mutation from its own writes.'
  );
  await fs.writeFile('/workspace/from-shell.txt', 'shell');
  assertCondition(
    text(await Effect.runPromise(tkfs.readFile('/workspace/from-shell.txt', '/'))) === 'shell',
    'A shell adapter write was not immediately visible through TKFS.'
  );

  await fs.link(
    '/workspace/tree/nested/data.txt',
    '/workspace/tree/nested/alias.txt'
  );
  await fs.writeFile('/workspace/tree/nested/alias.txt', 'shared');
  assertCondition(
    await fs.readFile('/workspace/tree/nested/data.txt') === 'shared',
    'The shell adapter lost TKFS hard-link identity.'
  );
  await fs.symlink('nested/data.txt', '/workspace/tree/current.txt');
  assertCondition(
    await fs.readFile('/workspace/tree/current.txt') === 'shared',
    'The shell adapter did not follow TKFS symbolic links.'
  );

  await fs.chmod('/workspace/tree/nested/data.txt', 0o640);
  const modifiedAt = new Date(1_700_000_000_000);
  await fs.utimes('/workspace/tree/nested/data.txt', modifiedAt, modifiedAt);
  const stat = await fs.stat('/workspace/tree/nested/data.txt');
  assertCondition(
    stat.mode === 0o640 && stat.mtime.getTime() === modifiedAt.getTime(),
    'The shell adapter did not expose TKFS metadata.'
  );

  await fs.cp('/workspace/tree', '/workspace/copied', { recursive: true });
  assertCondition(
    await fs.readFile('/workspace/copied/current.txt') === 'shared',
    'Recursive copy through the shell adapter did not preserve the copied tree.'
  );
  await fs.mv('/workspace/from-shell.txt', '/workspace/moved.txt');
  assertCondition(
    !(await fs.exists('/workspace/from-shell.txt')) &&
      await fs.readFile('/workspace/moved.txt') === 'shell',
    'Rename through the shell adapter did not update the TKFS namespace.'
  );
  await fs.rm('/workspace/copied', { recursive: true });
  assertCondition(
    !(await fs.exists('/workspace/copied')),
    'Recursive removal through the shell adapter left namespace entries behind.'
  );
  assertCondition(
    fs.getAllPaths().includes('/workspace/tree/nested/alias.txt'),
    'Shell namespace enumeration did not use TKFS.'
  );
  assertCondition(
    externalMutations.length === 1,
    'Host adapter mutations were incorrectly reported as external kernel commits.'
  );
  stopWatchingExternalMutations();
  fs.dispose();

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'src/main.txt', contents: 'workspace authority\n' }],
  });
  const cachedWorkspaceSnapshot = await workspace.snapshot();
  const workspaceTkfs = (
    workspace as unknown as {
      traceKernelFileSystem: TraceKernelFileSystem;
    }
  ).traceKernelFileSystem;
  await Effect.runPromise(
    workspaceTkfs.writeFile(
      '/workspace/src/process.txt',
      new TextEncoder().encode('direct'),
      '/'
    )
  );
  const externallyMutatedSnapshot = await workspace.snapshot();
  assertCondition(
    externallyMutatedSnapshot.files.some(
      (file) => file.path === 'src/process.txt' && file.contents === 'direct'
    ),
    'A direct TKFS commit did not invalidate the product snapshot cache.'
  );
  if (!cachedWorkspaceSnapshot.storage || !externallyMutatedSnapshot.storage) {
    throw new Error('Product snapshots did not expose storage accounting.');
  }
  assertCondition(
    externallyMutatedSnapshot.storage.usedBytes ===
      cachedWorkspaceSnapshot.storage.usedBytes + 6 &&
      externallyMutatedSnapshot.storage.usedEntries ===
        cachedWorkspaceSnapshot.storage.usedEntries + 1,
    'A direct TKFS commit did not invalidate product storage accounting.'
  );
  await workspace.runCommand('ln src/main.txt src/alias.txt');
  const workspaceImage = await workspace.exportTraceKernelFileSystemImage();
  const checkpoint = await Effect.runPromise(
    TraceKernelFileSystem.fromImage(workspaceImage)
  );
  await Effect.runPromise(
    checkpoint.writeFile(
      '/workspace/src/alias.txt',
      new TextEncoder().encode('checkpoint inode\n'),
      '/'
    )
  );
  assertCondition(
    text(await Effect.runPromise(checkpoint.readFile('/workspace/src/main.txt', '/'))) ===
      'checkpoint inode\n',
    'The product workspace checkpoint did not preserve authoritative inode state.'
  );
  workspace.dispose();

  console.log(JSON.stringify({
    schema: 'tracekernel-tkfs-backing-v1',
    oneBackingStore: true,
    encodedIo: true,
    recursiveOperations: true,
    hardLinks: true,
    symlinks: true,
    metadata: true,
    mutationOrigins: true,
    externalMutationReconciliation: true,
    productWorkspaceCheckpoint: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
