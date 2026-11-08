import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import { runtimeWorkspaceActorPreset } from '../packages/runtime-contracts/src/runtime-workspace-manifest';
import { createTypeScriptProjectRunner } from '../packages/runtime-javascript/src/typescript-project';

const cases = ['echo late > file', 'rm file', 'mv /tmp/input file', 'cp /tmp/input file', 'ln /tmp/input hard', 'ln -s /tmp/input soft', 'mkdir created', 'rmdir empty', 'chmod 600 file', 'touch file'];
const failures: string[] = [];
for (const command of cases) {
  const workspace = await createRuntimeWorkspace({ files: [{ path: 'file', contents: 'locked' }] });
  try {
    await workspace.mkdir('empty');
    await workspace.runCommand('echo scratch > /tmp/input');
    const actor = workspace.kernel.createProcess({ name: 'grader', actor: runtimeWorkspaceActorPreset('runtime'), workspaceAccess: 'read-only' });
    const result = await actor.runCommand(command);
    try { assert.notEqual(result.exitCode, 0, `read-only denial: ${command}`); } catch { failures.push(command); }
    assert.equal(await workspace.readFile('file'), 'locked', command);
    await actor.revokeAndDrain();
  } finally { await workspace.destroy(); }
}
for (const [source, destination, expected] of [['/tmp/input','/workspace/file','file'], ['/workspace/file','/tmp/output','file']] as const) {
  const workspace = await createRuntimeWorkspace({ files: [{ path: 'file', contents: 'locked' }] });
  try {
    const actor = workspace.kernel.createProcess({ name: 'native', actor: runtimeWorkspaceActorPreset('runtime') });
    const internal = workspace as any;
    const process = internal.processState.executionHandles.get(actor.pid).kernelProcess;
    const fs = internal.traceKernelAuthority.session.fileSystem;
    await Effect.runPromise(fs.writeFile('/tmp/input', new TextEncoder().encode('scratch')));
    const since = workspace.journal().at(-1)?.seq ?? 0;
    await Effect.runPromise(fs.rename(source, destination, '/', { origin: process.fileSystemMutationOrigin }));
    if (!workspace.journal(since).some((r) => r.kind === 'fs' && r.path === expected)) failures.push(`journal ${source} -> ${destination}`);
    await actor.revokeAndDrain();
  } finally { await workspace.destroy(); }
}
assert.deepEqual(failures, [], 'workspace authority/journal regressions');
console.log('PASS workspace authority mutation matrix and cross-boundary rename journal');

{
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'check.ts', contents: 'const value: number = 1;' }],
    typescriptRunner: createTypeScriptProjectRunner(),
  });
  try {
    const actor = workspace.kernel.createProcess({ name: 'grader', actor: runtimeWorkspaceActorPreset('runtime'), workspaceAccess: 'read-only' });
    const checked = await actor.runCommand('tsc --noEmit check.ts');
    assert.equal(checked.exitCode, 0, checked.stderr);
    const emitted = await actor.runCommand('tsc check.ts');
    assert.notEqual(emitted.exitCode, 0, 'compiler output cannot publish to a locked workspace');
    assert.deepEqual((await workspace.snapshot()).files.map((f) => f.path), ['check.ts']);
    await actor.revokeAndDrain();
    console.log('PASS trusted TypeScript snapshot compiler permits noEmit and refuses output publication');
  } finally { await workspace.destroy(); }
}

{
  const workspace = await createRuntimeWorkspace({ files: [{ path: 'locked', contents: 'snapshot' }] });
  try {
    const actor = runtimeWorkspaceActorPreset('runtime');
    const grader = workspace.kernel.createProcess({ name: 'grader', actor, workspaceAccess: 'read-only' });
    const editor = workspace.kernel.createProcess({ name: 'editor', actor });
    for (const operation of [
      () => grader.writeFile('locked', 'late'),
      () => grader.deleteFile('locked'),
      () => grader.writeFile('new', 'late'),
    ]) await assert.rejects(operation, /EROFS/);
    assert.equal((await grader.runCommand('sh -c "echo late > locked"')).exitCode !== 0, true);
    assert.equal((await grader.runCommand('echo scratch > /tmp/result')).exitCode, 0);
    assert.equal(await workspace.readFile('locked'), 'snapshot');
    await editor.writeFile('locked', 'authorized');
    assert.equal(await workspace.readFile('locked'), 'authorized');
    await grader.revokeAndDrain();
    await editor.revokeAndDrain();
    console.log('PASS direct API, nested shell, scratch and independent writable actor');
  } finally { await workspace.destroy(); }
}

{
  let invoked = false;
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'run.py', contents: 'print(1)' }],
    pythonRunner: async () => { invoked = true; return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  try {
    const actor = workspace.kernel.createProcess({ name: 'grader', actor: runtimeWorkspaceActorPreset('runtime'), workspaceAccess: 'read-only' });
    const result = await actor.runCommand('python3 run.py');
    assert.equal(invoked, false, 'snapshot-only runners must be refused before running learner code');
    assert.match(result.stderr, /ENOTSUP/);
    await actor.revokeAndDrain();
  } finally { await workspace.destroy(); }
}

{
  const visited: number[] = [];
  let reached!: () => void;
  let release!: () => void;
  const leafStarted = new Promise<void>((resolve) => { reached = resolve; });
  const workerResult = new Promise<void>((resolve) => { release = resolve; });
  const workspace = await createRuntimeWorkspace({
    files: ['parent.js', 'child.js', 'leaf.js'].map((path) => ({ path, contents: '// fixture' })).concat([{ path: 'locked', contents: 'snapshot' }]),
    nodeRunner: Object.assign(async (request: import('../packages/tracekernel/src/workspace/workspace-options').JavaScriptProjectCommandRequest) => {
      visited.push(request.process!.pid);
      if (!request.scriptPath.endsWith('leaf.js')) {
        const child = request.scriptPath.endsWith('parent.js') ? 'child.js' : 'leaf.js';
        const spawned = await request.kernelSyscalls!.dispatch({ op: 'spawn', runtime: 'javascript', command: 'node', args: [child] }) as { ok: boolean };
        assert.equal(spawned.ok, true);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      reached();
      await workerResult;
      // An adapter bug returning an unsolicited final diff must still fail
      // closed, even after both ancestor program invocations have returned.
      return { stdout: '', stderr: '', exitCode: 0, files: [{ path: 'locked', contents: 'stale worker diff' }] };
    }, { capabilities: { kernelFileSystem: true } }),
  });
  try {
    const actor = workspace.kernel.createProcess({ name: 'grader', actor: runtimeWorkspaceActorPreset('runtime'), workspaceAccess: 'read-only' });
    await actor.runCommand('node parent.js');
    await leafStarted;
    release();
    // Wait for admitted descendants without revoking: readonly alone must fence the diff.
    const authority = (workspace as any).processState.table.get(actor.pid).authority;
    await authority.drain();
    await actor.revokeAndDrain();
    assert.equal(visited.length, 3);
    assert.equal(await workspace.readFile('locked'), 'snapshot');
    assert.equal(workspace.journal().some((r) => r.kind === 'fs' && r.path === 'locked' && visited.includes(r.pid!)), false);
    console.log('PASS three-generation runtime tree and stale worker diff cannot publish');
  } finally { await workspace.destroy(); }
}
