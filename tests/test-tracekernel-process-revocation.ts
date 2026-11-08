import assert from 'node:assert/strict';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import { runtimeWorkspaceActorPreset } from '../packages/runtime-contracts/src/runtime-workspace-manifest';

// Port of the published-runtime submission-fence reproduction. Intercept only
// the existence lookup so the write is admitted before disposal, but not committed.
const workspace = await createRuntimeWorkspace({ files: [{ path: 'example.txt', contents: 'before' }] });
try {
  const actor = workspace.kernel.createProcess({
    name: 'tracebot', actor: runtimeWorkspaceActorPreset('runtime', { id: 'tracebot' }),
    signalPolicy: 'system-only',
  });
  await actor.writeFile('example.txt', 'first edit');
  const fs = (workspace as any).fileApi.options.fileSystem;
  const exists = fs.exists.bind(fs);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  fs.exists = async (path: string) => { await barrier; return exists(path); };
  const pending = actor.writeFile('example.txt', 'late repeated edit');
  const outcome = pending.then(() => 'committed', () => 'refused');
  actor.dispose();
  assert.equal(await workspace.readFile('example.txt'), 'first edit');
  release();
  assert.equal(await outcome, 'refused', 'revoked pending write must be refused');
  assert.equal(await workspace.readFile('example.txt'), 'first edit');
  await actor.revokeAndDrain();
  const records = workspace.journal().filter((record) => 'pid' in record && record.pid === actor.pid);
  const exit = records.findIndex((record) => record.kind === 'process' && record.op === 'exit');
  assert.equal(exit, records.length - 1, 'exit must be the final record for this pid');
  console.log('PASS process revocation at exists boundary');
} finally {
  await workspace.destroy({ clearStorage: true });
}

for (const command of [
  'echo late > example.txt', 'echo late >> example.txt', 'rm example.txt',
  'mv example.txt moved.txt', 'cp example.txt copied.txt',
  'ln example.txt hard.txt', 'ln -s example.txt soft.txt',
  'mkdir created', 'rmdir empty', 'chmod 600 example.txt',
]) {
  const workspace = await createRuntimeWorkspace({ files: [{ path: 'example.txt', contents: 'before' }] });
  try {
    await workspace.mkdir('empty');
    const sharedActor = runtimeWorkspaceActorPreset('runtime', { id: 'learner' });
    const actor = workspace.kernel.createProcess({ name: 'learner', actor: sharedActor });
    const submission = workspace.kernel.createProcess({ name: 'submission', actor: sharedActor });
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const stop = (workspace as any).fs.watchBeforeMutations(async () => { entered(); await barrier; });
    const pending = actor.runCommand(command);
    const settled = pending.then(() => undefined, () => undefined);
    await Promise.race([waiting, settled.then(() => { throw new Error(`No mutation barrier: ${command}`); })]);
    const drain = actor.revokeAndDrain();
    let drained = false;
    void drain.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false, 'drain must wait for admitted work');
    stop();
    release();
    await settled;
    await drain;
    assert.equal(await workspace.readFile('example.txt'), 'before', command);
    assert.equal(await workspace.exists('created'), false, command);
    assert.equal(await workspace.exists('empty'), true, command);
    for (const path of ['moved.txt', 'copied.txt', 'hard.txt', 'soft.txt']) {
      assert.equal(await workspace.exists(path), false, `${command}: ${path}`);
    }
    await submission.writeFile('grade.txt', 'allowed');
    assert.equal(await workspace.readFile('grade.txt'), 'allowed');
    const exited = new Set<number>();
    for (const record of workspace.journal()) {
      if (!('pid' in record) || record.pid === undefined) continue;
      assert.equal(exited.has(record.pid), false, `${command}: record after exit`);
      if (record.kind === 'process' && record.op === 'exit') exited.add(record.pid);
    }
    await submission.revokeAndDrain();
    console.log(`PASS revocation at mutation observer: ${command}`);
  } finally {
    await workspace.destroy({ clearStorage: true });
  }
}

{
  let reached!: () => void;
  let release!: () => void;
  const leafStarted = new Promise<void>((resolve) => { reached = resolve; });
  const workerResult = new Promise<void>((resolve) => { release = resolve; });
  const pids = new Set<number>();
  const workspace = await createRuntimeWorkspace({
    files: ['parent.js', 'child.js', 'leaf.js'].map((path) => ({ path, contents: '// fixture' })),
    nodeRunner: async (request) => {
      pids.add(request.process!.pid);
      if (!request.scriptPath.endsWith('leaf.js')) {
        const child = request.scriptPath.endsWith('parent.js') ? 'child.js' : 'leaf.js';
        const result = await request.kernelSyscalls!.dispatch({ op: 'spawn', runtime: 'javascript', command: 'node', args: [child] }) as { ok: boolean };
        assert.equal(result.ok, true);
        return { stdout: '', stderr: '', exitCode: 0 };
      } else reached();
      // Deliberately ignore abort. A provider's stale final diff must be fenced.
      await workerResult;
      return { stdout: '', stderr: '', exitCode: 0, files: [{ path: 'late.txt', contents: 'escaped' }] };
    },
  });
  try {
    const actor = workspace.kernel.createProcess({ name: 'learner', actor: runtimeWorkspaceActorPreset('runtime') });
    const pending = actor.runCommand('node parent.js').catch(() => undefined);
    await leafStarted;
    await pending;
    assert.equal(pids.size, 3);
    const drain = actor.revokeAndDrain();
    release();
    await drain;
    await pending;
    assert.equal(await workspace.exists('late.txt'), false);
    const journal = workspace.journal();
    for (const pid of [actor.pid, ...pids]) {
      const records = journal.filter((record) => 'pid' in record && record.pid === pid);
      assert.equal(records.at(-1)?.kind, 'process');
      assert.equal((records.at(-1) as { op: string }).op, 'exit');
      assert.equal(records.filter((record) => record.kind === 'process' && record.op === 'exit').length, 1);
    }
    console.log('PASS descendant tree and stale worker final diffs');
  } finally {
    release();
    await workspace.destroy({ clearStorage: true });
  }
}

// Every TKFS mutation checks authority after acquiring its commit lock.
{
  const { Effect } = await import('effect');
  const { TraceKernelFileSystem } = await import('../packages/tracekernel/src/vfs');
  const operations = [
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.writeFile('/workspace/file', new Uint8Array([2]), '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.unlink('/workspace/file', '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.rename('/workspace/file', '/workspace/moved', '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.link('/workspace/file', '/workspace/hard', '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.symlink('file', '/workspace/soft', '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.mkdir('/workspace/new', {}, '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.rmdir('/workspace/empty', '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.chmod('/workspace/file', 0o600, '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.utimes('/workspace/file', 1, '/', context),
    (fs: import('../packages/tracekernel/src/vfs').TraceKernelFileSystem, context: any) => fs.prepareOpen('/workspace/file', '/', { access: 'write', truncate: true }, context),
  ];
  for (const operation of operations) {
    const fs = await Effect.runPromise(TraceKernelFileSystem.make());
    await Effect.runPromise(fs.mkdir('/workspace/empty', { recursive: true }, '/'));
    await Effect.runPromise(fs.writeFile('/workspace/file', new Uint8Array([1]), '/'));
    const before = await Effect.runPromise(fs.exportImage());
    let active = true;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<void>((resolve) => { entered = resolve; });
    const lock = Effect.runPromise((fs as any).mutex.withPermits(1)(Effect.promise(() => { entered(); return barrier; })));
    await held;
    const pending = Effect.runPromise(operation(fs, { assertActive: () => { if (!active) throw new Error('revoked'); } }));
    const refused = assert.rejects(pending, /revoked/);
    active = false;
    release();
    await lock;
    await refused;
    assert.deepEqual(await Effect.runPromise(fs.exportImage()), before);
  }
  console.log('PASS all ten TKFS mutation families at commit lock');
}
