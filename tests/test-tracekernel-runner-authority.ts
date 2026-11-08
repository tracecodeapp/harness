import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import { runtimeWorkspaceActorPreset } from '../packages/runtime-contracts/src/runtime-workspace-manifest';
import { createWorkspaceRuntimeRunnerBridge } from '../packages/tracekernel/src/workspace/workspace-runtime-commands';
import { TraceKernelFileSystem } from '../packages/tracekernel/src/vfs';

// Valid WASI command bytes select the virtual-executable path after snapshot restore.
const binary = Buffer.from([
  0,97,115,109,1,0,0,0, 1,4,1,96,0,0, 3,2,1,0, 5,3,1,0,1,
  7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,
  10,4,1,2,0,11,
]).toString('base64');
const files = [
  { path: 'app', contents: binary, encoding: 'base64' as const, mode: 0o755 },
  { path: 'app.js', contents: '// runner fixture' },
  { path: 'locked', contents: 'snapshot' },
];

test('virtual executable final diffs retain process authority and writer attribution', async () => {
  const cppRunner = Object.assign(async () => ({
    stdout: '', stderr: '', exitCode: 0, files: [{ path: 'locked', contents: 'late' }],
  }), { capabilities: { kernelFileSystem: true } });
  const workspace = await createRuntimeWorkspace({ files, cppRunner });
  try {
    const grader = workspace.kernel.createProcess({ name: 'grader', actor: runtimeWorkspaceActorPreset('runtime'), workspaceAccess: 'read-only' });
    const cursor = workspace.journalWindow().nextSeq - 1;
    const result = await grader.runCommand('./app');
    assert.equal(await workspace.readFile('locked'), 'snapshot');
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /EROFS/);
    await grader.revokeAndDrain();
    assert.equal(workspace.journal(cursor).some((entry) => entry.kind === 'fs'), false);

    const actor = { ...runtimeWorkspaceActorPreset('runtime'), id: 'writer' };
    const writer = workspace.kernel.createProcess({ name: 'writer', actor });
    assert.equal((await writer.runCommand('./app')).exitCode, 0);
    await writer.revokeAndDrain();
    assert.equal(await workspace.readFile('locked'), 'late');
    const edits = workspace.journal(cursor).filter((entry) => entry.kind === 'fs');
    assert.ok(edits.length > 0);
    assert.ok(edits.every((entry) => entry.actor === 'runtime:writer' && entry.pid !== undefined), JSON.stringify(edits));
  } finally { await workspace.destroy(); }
});

for (const command of ['./app', 'node app.js']) {
  test(`no SharedArrayBuffer at bridge creation refuses ${command} before runner execution`, async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer')!;
    let invoked = false;
    const runner = Object.assign(async () => {
      invoked = true;
      return { stdout: '', stderr: '', exitCode: 0, files: [{ path: 'locked', contents: 'late' }] };
    }, { capabilities: { kernelFileSystem: true } });
    const workspace = await createRuntimeWorkspace({ files, cppRunner: runner, nodeRunner: runner });
    try {
      // Other kernel infrastructure also allocates signal buffers. Isolate the
      // real bridge availability check after that infrastructure has initialized.
      const internal = workspace as any;
      const createBridge = internal.createKernelSyscallBridge.bind(workspace);
      let unavailable = false;
      internal.createKernelSyscallBridge = (context: unknown) => {
        Object.defineProperty(globalThis, 'SharedArrayBuffer', { ...original, value: undefined });
        try {
          const bridge = createBridge(context);
          unavailable = bridge === undefined;
          return bridge;
        } finally { Object.defineProperty(globalThis, 'SharedArrayBuffer', original); }
      };
      const grader = workspace.kernel.createProcess({ name: 'grader', actor: runtimeWorkspaceActorPreset('runtime'), workspaceAccess: 'read-only' });
      const result = await grader.runCommand(command);
      await grader.revokeAndDrain();
      assert.equal(unavailable, true);
      assert.equal(invoked, false, 'a declared capability cannot replace an unavailable syscall bridge');
      assert.match(result.stderr, /ENOTSUP/);
      assert.equal(await workspace.readFile('locked'), 'snapshot');
    } finally {
      Object.defineProperty(globalThis, 'SharedArrayBuffer', original);
      await workspace.destroy();
    }
  });
}

test('unresolved runner context fails closed before bridges, input or learner execution', async () => {
  const effects: string[] = [];
  const wrap = createWorkspaceRuntimeRunnerBridge({
    resolveCommandContext: () => undefined,
    bindProcess: () => { effects.push('bind'); return {}; },
    startHostStandardInputPump: async () => { effects.push('stdin'); },
    createKernelHttpBridge: () => { effects.push('http'); return {} as never; },
    createKernelSyscallBridge: () => { effects.push('syscall'); return undefined; },
    handleRuntimeCommandEvent: () => { effects.push('event'); },
    flushRuntimeEventQueue: async () => { effects.push('flush'); },
  });
  const run = wrap(async () => { effects.push('runner'); return { stdout: '', stderr: '', exitCode: 0 }; }, { kernelSyscalls: true });
  const result = await run({ source: 'run', code: '', scriptPath: 'app.js', args: [], cwd: '/workspace', env: {}, project: { files: [] } });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /EACCES/);
  assert.deepEqual(effects, []);
});

test('runtime syscall dispatch without a command context cannot fall back to SYSTEM', async () => {
  const workspace = await createRuntimeWorkspace({ files });
  try {
    const result = await (workspace as any).dispatchRuntimeKernelSyscall({ op: 'writeFile', path: '/workspace/locked', bytes: new TextEncoder().encode('late') });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EACCES');
    assert.equal(await workspace.readFile('locked'), 'snapshot');
  } finally { await workspace.destroy(); }
});

test('read-only O_RDONLY | O_CREAT may open an existing file without mutating it', async () => {
  const fs = await Effect.runPromise(TraceKernelFileSystem.make());
  await Effect.runPromise(fs.mkdir('/workspace', { recursive: true }));
  await Effect.runPromise(fs.writeFile('/workspace/locked', new Uint8Array([1])));
  const context = { readOnlyWorkspaceRoot: '/workspace' };
  const before = await Effect.runPromise(fs.exportImage());
  await Effect.runPromise(fs.prepareOpen('/workspace/locked', '/', { access: 'read', create: true }, context));
  assert.deepEqual(await Effect.runPromise(fs.exportImage()), before);
  await assert.rejects(Effect.runPromise(fs.prepareOpen('/workspace/missing', '/', { access: 'read', create: true }, context)), /EROFS/);
  await assert.rejects(Effect.runPromise(fs.prepareOpen('/workspace/locked', '/', { access: 'read', create: true, exclusive: true }, context)), /EEXIST/);
  await assert.rejects(Effect.runPromise(fs.prepareOpen('/workspace/locked', '/', { access: 'write', create: true }, context)), /EROFS/);
});
