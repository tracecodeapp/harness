import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import { runtimeWorkspaceActorPreset } from '../packages/runtime-contracts/src/runtime-workspace-manifest';

const failures: string[] = [];
for (const operation of ['rename', 'link', 'cp'] as const) {
  for (const [source, destination, expected] of [
    ['/tmp/input', '/workspace/output', ['output']],
    ['/workspace/input', '/tmp/output', ['input']],
    ['/workspace/input', '/workspace/output', ['input', 'output']],
  ] as const) {
    for (const native of operation === 'cp' ? [false] : [true, false]) {
      const workspace = await createRuntimeWorkspace({ files: [{ path: 'input', contents: 'locked' }] });
      try {
        await workspace.runCommand('echo scratch > /tmp/input');
        const actor = workspace.kernel.createProcess({ name: 'actor', actor: runtimeWorkspaceActorPreset('runtime') });
        const since = workspace.journal().at(-1)?.seq ?? 0;
        if (native) {
          const internal = workspace as any;
          const process = internal.processState.executionHandles.get(actor.pid).kernelProcess;
          await Effect.runPromise(internal.traceKernelAuthority.session.fileSystem[operation](source, destination, '/', { origin: process.fileSystemMutationOrigin }));
        } else {
          const command = operation === 'rename' ? 'mv' : operation === 'link' ? 'ln' : 'cp';
          assert.equal((await actor.runCommand(`${command} ${source} ${destination}`)).exitCode, 0);
        }
        const paths = workspace.journal(since).filter((r) => r.kind === 'fs').map((r) => r.path);
        for (const path of expected) if (!paths.includes(path)) failures.push(`${native ? 'native' : 'shell'} ${operation} ${source} -> ${destination}: missing ${path}`);
        await actor.revokeAndDrain();
      } finally { await workspace.destroy(); }
    }
  }
}
assert.deepEqual(failures, [], 'journal must cover both workspace endpoints');
console.log('PASS native/shell rename/link and shell copy: inbound, outbound, within workspace');

const workspace = await createRuntimeWorkspace();
try {
  const cursor = workspace.journal().at(-1)?.seq ?? 0;
  await workspace.writeFile('evicted-edit', 'evidence');
  for (let i = 0; i < 140; i++) {
    const actor = workspace.kernel.createProcess({ name: 'noise', actor: runtimeWorkspaceActorPreset('runtime') });
    await actor.revokeAndDrain();
  }
  assert.equal(workspace.journal(cursor).some((r) => r.kind === 'fs' && r.path === 'evicted-edit'), false);
  const window = workspace.journalWindow(cursor);
  assert.equal(window.gap, true, 'process traffic must not hide evicted evidence');
  assert.equal(window.records.length, 256);
  assert.equal(window.records[0]?.seq, window.firstAvailableSeq);
  assert.equal(window.records.at(-1)?.seq, window.nextSeq - 1);
  assert.equal(workspace.journalWindow(window.firstAvailableSeq - 1).gap, false);
  assert.deepEqual(workspace.journalWindow(window.nextSeq - 1).records, []);
  assert.throws(() => workspace.journalWindow(window.nextSeq), RangeError);
  assert.throws(() => workspace.journalWindow(-1), RangeError);
  assert.throws(() => workspace.journalWindow(NaN), RangeError);
  assert.deepEqual(workspace.journal(), window.records, 'legacy bounded array API remains unchanged');
  console.log('PASS bounded journal reports evicted edit after process flood; valid cursors remain complete');
} finally { await workspace.destroy(); }
