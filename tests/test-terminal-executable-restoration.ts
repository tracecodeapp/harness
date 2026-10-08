import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import { isWasiCommandExecutable } from '../packages/tracekernel/src/workspace/executable-format';

// A valid no-op WASI command: exported linear memory and _start, no host imports.
const command = Uint8Array.from([
  0,97,115,109,1,0,0,0,
  1,4,1,96,0,0, 3,2,1,0, 5,3,1,0,1,
  7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,
  10,4,1,2,0,11,
]);
const binary = Buffer.from(command).toString('base64');
const cppRunner = async (request: { source: string; scriptPath: string }) => request.source === 'compile'
  ? { stdout: '', stderr: '', exitCode: 0, files: [{ path: 'app', contents: binary, encoding: 'base64' as const }] }
  : { stdout: `ran:${request.scriptPath}\n`, stderr: '', exitCode: 0 };

test('format recognition validates a command ABI without instantiating guest code', () => {
  assert.equal(isWasiCommandExecutable(command), true);
  assert.equal(isWasiCommandExecutable(command.subarray(0, 8)), false);
  assert.equal(isWasiCommandExecutable(command.subarray(0, 12)), false);
  const wrongImport = Uint8Array.from([
    ...command.subarray(0, 14),
    2,9,1,3,101,110,118,1,120,0,0,
    ...command.subarray(14),
  ]);
  assert.equal(isWasiCommandExecutable(wrongImport), false);
});

test('snapshot JSON roundtrip restores executable scripts, exact bytes and metadata', async () => {
  const workspace = await createRuntimeWorkspace({ files: [{ path: 'script.sh', contents: '#!/bin/bash\necho restored\n', mode: 0o755, mtimeMs: 456000 }] });
  let restored;
  try {
    const snapshot = JSON.parse(JSON.stringify(await workspace.snapshot()));
    const file = snapshot.files.find((entry: { path: string }) => entry.path === 'script.sh');
    assert.equal(file.mode, 0o755);
    assert.equal(file.mtimeMs, 456000);
    restored = await createRuntimeWorkspace(snapshot);
    const after = (await restored.snapshot()).files.find(entry => entry.path === 'script.sh');
    assert.deepEqual(after, file);
    assert.equal((await restored.runCommand('./script.sh')).stdout, 'restored\n');
  } finally { restored?.dispose(); workspace.dispose(); }
});

test('fresh compile survives a new workspace; chmod -x blocks before and after restore', async () => {
  const workspace = await createRuntimeWorkspace({ cppRunner, files: [{ path: 'main.c', contents: 'int main() {}' }] });
  let restored;
  let denied;
  try {
    const outputChanges: { mode?: number }[] = [];
    assert.equal((await workspace.runCommand('clang main.c -o app', {
      onEvent: event => {
        if (event.type === 'file-change' && event.change.path === 'app' && 'contents' in event.change) outputChanges.push(event.change);
      },
    })).exitCode, 0);
    assert.equal(outputChanges.at(-1)?.mode, 0o755, 'event consumers must receive the final executable permissions');
    assert.equal((await workspace.runCommand('./app')).stdout, 'ran:app\n');
    const snapshot = JSON.parse(JSON.stringify(await workspace.snapshot()));
    assert.equal(snapshot.files.find((entry: { path: string }) => entry.path === 'app').mode, 0o755);
    restored = await createRuntimeWorkspace({ ...snapshot, cppRunner });
    assert.equal((await restored.runCommand('./app')).stdout, 'ran:app\n');
    assert.equal(await restored.readFile('app', 'base64'), binary);
    await workspace.runCommand('chmod -x app');
    assert.equal((await workspace.runCommand('./app')).exitCode, 126);
    denied = await createRuntimeWorkspace({ ...JSON.parse(JSON.stringify(await workspace.snapshot())), cppRunner });
    assert.equal((await denied.runCommand('./app')).exitCode, 126);
    await denied.runCommand('chmod +x app');
    assert.equal((await denied.runCommand('./app')).stdout, 'ran:app\n');
  } finally { denied?.dispose(); restored?.dispose(); workspace.dispose(); }
});

test('legacy non-executable command bytes require chmod and metadata-less snapshots still load', async () => {
  const workspace = await createRuntimeWorkspace({ cppRunner, files: [
    { path: 'old', contents: binary, encoding: 'base64', mode: 0o666 },
    { path: 'plain', contents: 'legacy text' },
  ] });
  try {
    assert.equal((await workspace.runCommand('./old')).exitCode, 126);
    await workspace.runCommand('chmod +x old');
    assert.equal((await workspace.runCommand('./old')).stdout, 'ran:old\n');
    assert.equal(await workspace.readFile('plain'), 'legacy text');
  } finally { workspace.dispose(); }
});

test('compile-only outputs remain ordinary files and unrecognized binaries never dispatch', async () => {
  let runs = 0;
  const workspace = await createRuntimeWorkspace({
    cppRunner: async request => request.source === 'compile'
      ? { stdout: '', stderr: '', exitCode: 0, files: [{ path: 'object', contents: '#!/bin/bash\necho ordinary\n' }] }
      : (++runs, { stdout: 'runner\n', stderr: '', exitCode: 0 }),
    files: [{ path: 'bad', contents: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]).toString('base64'), encoding: 'base64', mode: 0o755 }],
  });
  try {
    assert.equal((await workspace.runCommand('clang -c main.c -o object')).exitCode, 0);
    const mode = (await workspace.snapshot()).files.find(file => file.path === 'object')?.mode;
    assert.equal((mode ?? 0) & 0o111, 0);
    await workspace.runCommand('chmod +x object');
    assert.equal((await workspace.runCommand('./object')).stdout, 'ordinary\n');
    assert.notEqual((await workspace.runCommand('./bad')).exitCode, 0);
    assert.equal(runs, 0);
  } finally { workspace.dispose(); }
});

test('live-only compiler output emits its durable executable metadata', async () => {
  const modes: (number | undefined)[] = [];
  const workspace = await createRuntimeWorkspace({
    cppRunner: async request => {
      if (request.source === 'compile') request.onEvent?.({
        type: 'file-change', phase: 'live',
        change: { path: 'live-app', contents: binary, encoding: 'base64' },
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  try {
    const result = await workspace.runCommand('clang main.c -o live-app', {
      onEvent: event => {
        if (event.type === 'file-change' && event.change.path === 'live-app' && 'contents' in event.change) modes.push(event.change.mode);
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(modes.at(-1), 0o755);
    assert.equal((await workspace.snapshot()).files.find(file => file.path === 'live-app')?.mode, 0o755);
  } finally { workspace.dispose(); }
});
