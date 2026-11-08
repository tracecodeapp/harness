import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { TraceKernelFileSystem } from '../packages/tracekernel/src/vfs';
import type { TraceKernelFileSystemMutationContext } from '../packages/tracekernel/src/watch';

type Mutation = (fs: TraceKernelFileSystem, context: TraceKernelFileSystemMutationContext) => Effect.Effect<unknown, unknown>;
const mutations: Record<string, Mutation> = {
  write: (fs, c) => fs.writeFile('/workspace/file', new Uint8Array([2]), '/', c),
  delete: (fs, c) => fs.unlink('/workspace/file', '/', c),
  renameIn: (fs, c) => fs.rename('/tmp/input', '/workspace/file', '/', c),
  renameOut: (fs, c) => fs.rename('/workspace/file', '/tmp/output', '/', c),
  renameWithin: (fs, c) => fs.rename('/workspace/file', '/workspace/moved', '/', c),
  linkIn: (fs, c) => fs.link('/tmp/input', '/workspace/hard', '/', c),
  linkOut: (fs, c) => fs.link('/workspace/file', '/tmp/out-hard', '/', c),
  symlink: (fs, c) => fs.symlink('/tmp/input', '/workspace/soft', '/', c),
  mkdir: (fs, c) => fs.mkdir('/workspace/new', {}, '/', c),
  rmdir: (fs, c) => fs.rmdir('/workspace/empty', '/', c),
  chmod: (fs, c) => fs.chmod('/workspace/file', 0o600, '/', c),
  utimes: (fs, c) => fs.utimes('/workspace/file', 1, '/', c),
  create: (fs, c) => fs.prepareOpen('/workspace/new', '/', { access: 'write', create: true }, c),
  createReadOnlyDescriptor: (fs, c) => fs.prepareOpen('/workspace/new', '/', { access: 'read', create: true }, c),
  truncate: (fs, c) => fs.prepareOpen('/workspace/file', '/', { access: 'write', truncate: true }, c),
  symlinkAlias: (fs, c) => fs.writeFile('/tmp/soft', new Uint8Array([2]), '/', c),
  hardlinkAlias: (fs, c) => fs.writeFile('/tmp/hard', new Uint8Array([2]), '/', c),
  hardlinkMode: (fs, c) => fs.chmod('/tmp/hard', 0o600, '/', c),
  ancestor: (fs, c) => fs.rename('/workspace', '/tmp/moved', '/', c),
};

const failures: string[] = [];
for (const name of [...Object.keys(mutations), 'descriptorWrite', 'descriptorTruncate', 'descriptorMode', 'descriptorTimes', 'publication', 'restore']) {
  const fs = await Effect.runPromise(TraceKernelFileSystem.make());
  await Effect.runPromise(fs.mkdir('/workspace/empty', { recursive: true }, '/'));
  await Effect.runPromise(fs.mkdir('/tmp', { recursive: true }, '/'));
  for (const path of ['/workspace/file', '/tmp/input']) await Effect.runPromise(fs.writeFile(path, new Uint8Array([1]), '/'));
  await Effect.runPromise(fs.link('/workspace/file', '/tmp/hard', '/'));
  await Effect.runPromise(fs.symlink('/workspace/file', '/tmp/soft', '/'));
  // Descriptors opened with write access before the restriction still recheck
  // the current caller at the write/truncate commit, including inode aliases.
  const opened = await Effect.runPromise(fs.prepareOpen('/tmp/hard', '/', { access: 'write' }));
  const fork = await Effect.runPromise(fs.forkForTransaction());
  const stagedMutations: import('../packages/tracekernel/src/watch').TraceKernelFileSystemMutation[] = [];
  fork.fileSystem.watchMutations((mutation) => stagedMutations.push(mutation));
  await Effect.runPromise(fork.fileSystem.writeFile('/workspace/file', new Uint8Array([2]), '/'));
  const image = await Effect.runPromise(fork.fileSystem.exportImage());
  const operation: Mutation = name === 'descriptorWrite' ? (fs, c) => fs.writeAt(opened, 0, new Uint8Array([2]), false, c)
    : name === 'descriptorTruncate' ? (fs, c) => fs.truncateOpen(opened, 0, c)
    : name === 'descriptorMode' ? (fs, c) => fs.setMetadataOpen(opened, { mode: 0o600 }, c)
    : name === 'descriptorTimes' ? (fs, c) => fs.setMetadataOpen(opened, { modifiedAt: 1 }, c)
    : name === 'publication' ? (fs, c) => fs.publishTransaction(image, fork.generation, fork.fileSystem, stagedMutations, c)
    : name === 'restore' ? (fs, c) => fs.restoreQuiescentImage(image, c)
    : mutations[name]!;
  const before = await Effect.runPromise(fs.exportImage());
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const held = new Promise<void>((resolve) => { entered = resolve; });
  const lock = Effect.runPromise((fs as any).mutex.withPermits(1)(Effect.promise(() => { entered(); return barrier; })));
  await held;
  let protectedRoot: string | undefined;
  const context = { origin: { get readOnlyWorkspaceRoot() { return protectedRoot; } } };
  const pending = Effect.runPromise(operation(fs, context)).then(() => 'committed', (error) => String(error));
  // Installed after admission: the check must happen under the commit lock.
  protectedRoot = '/workspace';
  release();
  await lock;
  const outcome = await pending;
  if (!outcome.includes('EROFS')) failures.push(`${name}: ${outcome}`);
  else assert.deepEqual(await Effect.runPromise(fs.exportImage()), before, name);
}
assert.deepEqual(failures, [], 'every commit must enforce workspace authority');
console.log('PASS read-only commit lock: 25 mutation, alias, descriptor and publication cases');

{
  const fs = await Effect.runPromise(TraceKernelFileSystem.make());
  await Effect.runPromise(fs.mkdir('/workspace-other', { recursive: true }, '/'));
  await Effect.runPromise(fs.writeFile('/workspace-other/file', new Uint8Array([1]), '/', { readOnlyWorkspaceRoot: '/workspace' }));
  await assert.rejects(Effect.runPromise(fs.writeFile('/workspace-other/file', new Uint8Array([2]), '/', { readOnlyWorkspaceRoot: '/' })), /EROFS/);
  const before = await Effect.runPromise(fs.exportImage());
  assert.throws(() => fs.clear({ readOnlyWorkspaceRoot: '/workspace' }), /EROFS/);
  assert.deepEqual(await Effect.runPromise(fs.exportImage()), before);
  console.log('PASS root workspace, sibling-prefix scratch and synchronous clear fence');
}
