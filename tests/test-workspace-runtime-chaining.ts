import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineCommand } from 'just-bash/browser';
import { createBrowserProjectWorkspace } from '../packages/runtime-browser/src/project';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import type { JavaScriptProjectCommandRequest, PythonProjectCommandRequest } from '../packages/tracekernel/src/workspace/index';

test('shell runtimes own separate process leases and settle before the next invocation', async () => {
  const invocations: number[] = [];
  const releases: number[] = [];
  const runner = async (request: JavaScriptProjectCommandRequest | PythonProjectCommandRequest) => {
    const pid = request.process!.pid;
    assert.ok(!invocations.includes(pid), 'two runtime invocations shared one process');
    assert.equal(releases.length, invocations.length, 'previous sequential engine was not released');
    invocations.push(pid);
    request.engineLease!.attach({ release: () => { releases.push(pid); } });
    assert.throws(() => request.engineLease!.attach({ release: () => undefined }), /already attached/);
    request.onEvent?.({ type: 'output', stream: 'stdout', data: `${request.scriptPath}\n` });
    return { stdout: `${request.scriptPath}\n`, stderr: '', exitCode: request.scriptPath.endsWith('fail.js') ? 1 : 0 };
  };
  const workspace = await createRuntimeWorkspace({
    nodeRunner: runner, pythonRunner: runner,
    files: [...['one.js', 'two.py', 'fail.js'].map(path => ({ path, contents: '' })), { path: 'nested.sh', contents: 'node one.js && node one.js\n' }],
    kernel: { scheduler: { maxConcurrentCommands: 1 } },
  });
  try {
    for (const [command, stdout] of [
      ['node one.js && python two.py', 'one.js\ntwo.py\n'],
      ['python two.py && node one.js', 'two.py\none.js\n'],
      ['node one.js && node one.js', 'one.js\none.js\n'],
      ['node fail.js || node one.js', 'fail.js\none.js\n'],
      ['node fail.js && node one.js', 'fail.js\n'],
      ['node one.js', 'one.js\n'],
      ['bash nested.sh', 'one.js\none.js\n'],
    ]) {
      const output: string[] = [];
      const result = await workspace.runCommand(command, { onEvent: event => { if (event.type === 'output' && event.stream === 'stdout') output.push(event.data); } });
      assert.equal(output.join(''), stdout, 'live output must publish exactly once');
      assert.equal(result.stdout, stdout);
      assert.equal(result.exitCode, command.includes('fail.js &&') ? 1 : 0);
      assert.equal(result.error, undefined);
      assert.equal(releases.length, invocations.length);
    }
  } finally { await workspace.destroy(); }
  assert.equal(new Set(releases).size, invocations.length, 'leases were not released exactly once');
});


test('pipeline runtime processes have independent leases and failed runners release before recovery', async () => {
  const attached: number[] = [];
  const released: number[] = [];
  const workspace = await createRuntimeWorkspace({
    files: ['one.js', 'crash.js'].map(path => ({ path, contents: '' })),
    kernel: { scheduler: { maxConcurrentCommands: 1 } },
    nodeRunner: async request => {
      const pid = request.process!.pid;
      attached.push(pid);
      request.engineLease!.attach({ release: () => { released.push(pid); } });
      if (request.scriptPath.endsWith('crash.js')) throw new Error('fixture runtime crashed');
      return { stdout: 'done\n', stderr: '', exitCode: 0 };
    },
  });
  try {
    assert.equal((await workspace.runCommand('node one.js | node one.js')).exitCode, 0);
    assert.equal(new Set(attached).size, 2);
    assert.equal(released.length, 2);
    const failed = await workspace.runCommand('node crash.js || node one.js');
    assert.equal(failed.exitCode, 0);
    assert.equal(new Set(attached).size, 4);
    assert.equal(released.length, 4);
    assert.equal((await workspace.runCommand('node one.js')).exitCode, 0);
  } finally { await workspace.destroy(); }
  assert.deepEqual([...released].sort(), [...attached].sort());
});

test('terminal shell children retain foreground group and terminal descriptors', async () => {
  const identities: Array<{ pid: number; ppid: number; pgid: number; sid: number }> = [];
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'one.js', contents: '' }],
    kernel: { maxProcesses: 3 },
    nodeRunner: async request => {
      identities.push(request.process!);
      const tty = await request.kernelSyscalls!.dispatch({ op: 'isatty', fd: 0 }) as { ok: boolean; value: { isTerminal: boolean } };
      const group = await request.kernelSyscalls!.dispatch({ op: 'tcgetpgrp', fd: 0 }) as { ok: boolean; value: { pgid: number } };
      assert.ok(tty.ok && tty.value.isTerminal);
      assert.ok(group.ok);
      assert.equal(group.value.pgid, request.process!.pgid);
      request.engineLease!.attach({ release: () => undefined });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  try {
    const result = await workspace.runCommand('node one.js && node one.js', { presentation: 'terminal', terminal: { isTTY: true, columns: 80, rows: 24, term: 'xterm-256color', colorLevel: 0 } });
    assert.equal(result.exitCode, 0);
    assert.equal(identities.length, 2);
    assert.notEqual(identities[0].pid, identities[1].pid);
    assert.equal(identities[0].ppid, identities[1].ppid);
    assert.equal(identities[0].pgid, identities[1].pgid);
    assert.equal(identities[0].sid, identities[1].sid);
  } finally { await workspace.destroy(); }
});

test('cancelling a pipeline aborts its active child and prevents downstream launch', async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const released: number[] = [];
  const aborted: number[] = [];
  let calls = 0;
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'block.js', contents: '' }, { path: 'one.js', contents: '' }],
    kernel: { scheduler: { maxConcurrentCommands: 1 } },
    nodeRunner: async request => {
      const pid = request.process!.pid;
      request.engineLease!.attach({ release: () => { released.push(pid); } });
      if (request.scriptPath.endsWith('block.js')) {
        ++calls;
        resolveStarted();
        await new Promise<void>(resolve => {
          const settle = () => { aborted.push(pid); resolve(); };
          if (request.signal!.aborted) settle();
          else request.signal!.addEventListener('abort', settle, { once: true });
        });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  try {
    const controller = new AbortController();
    const execution = workspace.runCommand('node block.js | node block.js', { signal: controller.signal });
    await started;
    controller.abort();
    const result = await execution;
    assert.equal(result.exitCode, 143);
    assert.equal(calls, 1);
    assert.equal(new Set(aborted).size, 1);
    assert.equal(new Set(released).size, 1);
    assert.equal(released.length, 1);
    assert.equal((await workspace.runCommand('node one.js')).exitCode, 0);
  } finally { await workspace.destroy(); }
  assert.equal(released.length, 2);
});

test('child file changes apply and publish once across the shell submission', async () => {
  const published: string[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'one.js', contents: '' }],
    nodeRunner: async request => {
      request.engineLease!.attach({ release: () => undefined });
      request.onEvent!({ type: 'file-change', change: { path: 'result.txt', contents: String(request.process!.pid) } });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const unsubscribe = workspace.watch(event => {
    if (event.type === 'file-change' && event.change.path === 'result.txt' && 'contents' in event.change) published.push(event.change.contents);
  });
  try {
    const result = await workspace.runCommand('node one.js && node one.js');
    assert.equal(result.exitCode, 0);
    assert.equal(result.error, undefined);
    assert.equal(published.length, 2);
    assert.equal(await workspace.readFile('result.txt'), published[1]);
  } finally { unsubscribe(); await workspace.destroy(); }
});


test('structured child runtime outcomes reach the shell and recovery replaces stale errors', async () => {
  const error = { code: 'EIO', message: 'fixture infrastructure failure', errno: 5 };
  const workspace = await createRuntimeWorkspace({
    files: ['error.js', 'errorzero.js', 'one.js'].map(path => ({ path, contents: '' })),
    nodeRunner: async request => ({ stdout: '', stderr: '', exitCode: request.scriptPath.endsWith('error.js') ? 1 : 0,
      ...(request.scriptPath.includes('error') ? { error } : {}) }),
  });
  try {
    assert.deepEqual((await workspace.runCommand('node one.js && node errorzero.js')).error, error);
    assert.deepEqual((await workspace.runCommand('node error.js && node one.js')).error, error);
    const recovered = await workspace.runCommand('node error.js || node one.js');
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.error, undefined);
  } finally { await workspace.destroy(); }
});


test('successful runtime children preserve an earlier authoritative shell storage failure', async () => {
  let calls = 0;
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'one.js', contents: '' }],
    storageLimits: { maxWorkspaceBytes: 100, maxFileBytes: 2, maxEntryCount: 20 },
    customCommands: [defineCommand('quota-write', async (_args, context) => {
      try { await context.fs.writeFile('/workspace/too-large.txt', 'oversized'); }
      catch { return { stdout: '', stderr: '', exitCode: 1 }; }
      throw new Error('quota fixture unexpectedly succeeded');
    })],
    nodeRunner: async () => { calls++; return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  try {
    const result = await workspace.runCommand("quota-write; node one.js");
    assert.equal(calls, 1);
    assert.equal(result.error?.code, 'EFBIG');
  } finally { await workspace.destroy(); }
});

test('the shell can delete its child output while unrelated later writes remain conflicting', async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let block = false;
  let notifyCommitted: (() => void) | undefined;
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'write.js', contents: '' }],
    nodeRunner: async request => {
      await new Promise<void>(resolve => {
        notifyCommitted = resolve;
        request.onEvent!({ type: 'file-change', change: { path: 'result.txt', contents: 'child' } });
      });
      if (block) { started(); await released; }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const unsubscribe = workspace.watch(event => {
    if (event.type === 'file-change' && event.change.path === 'result.txt') notifyCommitted?.();
  });
  try {
    const own = await workspace.runCommand('node write.js && rm result.txt');
    assert.equal(own.exitCode, 0);
    assert.equal(own.error, undefined);
    assert.equal(await workspace.exists('result.txt'), false);
    block = true;
    const pending = workspace.runCommand('node write.js && rm result.txt');
    await startedPromise;
    await workspace.writeFile('result.txt', 'unrelated writer');
    release();
    const conflicting = await pending;
    assert.equal(conflicting.error?.code, 'ESTALE');
    assert.equal(await workspace.readFile('result.txt'), 'unrelated writer');
  } finally { release(); unsubscribe(); await workspace.destroy(); }
});

test('terminal shell child capacity failures preserve structured fork errors', async () => {
  let calls = 0;
  const workspace = await createRuntimeWorkspace({
    kernel: { maxProcesses: 2 },
    files: [{ path: 'one.js', contents: '' }],
    nodeRunner: async () => { calls++; return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  try {
    const result = await workspace.runCommand('node one.js && node one.js', { presentation: 'terminal' });
    assert.equal(calls, 0);
    assert.equal(result.exitCode, 11);
    assert.equal(result.error?.code, 'EAGAIN');
    assert.equal(result.error?.errno, 11);
    assert.equal(result.error?.syscall, 'fork');
    assert.equal(result.error?.path, 'node one.js');
    assert.equal((await workspace.runCommand('node one.js')).exitCode, 0, 'rejected child admission leaked capacity');
  } finally { await workspace.destroy(); }
});


test('executable script dispatch publishes nested runtime output once', async () => {
  const workspace = await createBrowserProjectWorkspace({
    providers: ['javascript'],
    nodeProject: { allowMainThreadExecution: true, trustedMainThreadExecution: true },
    files: [{ path: 'node-tool', contents: '#!/usr/bin/env node\nconsole.log("hello")' }],
  });
  const terminal = workspace.createTerminalSession();
  try {
    const result = await terminal.run('chmod +x node-tool; ./node-tool');
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stdout, 'hello\n', JSON.stringify(result));
  } finally { terminal.close(); workspace.dispose(); }
});

test('kernel syscall child writes also advance only their owning shell generations', async () => {
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'write.js', contents: '' }],
    nodeRunner: async request => {
      const result = await request.kernelSyscalls!.dispatch({ op: 'writeFile', path: 'result.txt', bytes: new TextEncoder().encode('child') }) as { ok: boolean };
      assert.equal(result.ok, true);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  try {
    const result = await workspace.runCommand('node write.js && rm result.txt');
    assert.equal(result.exitCode, 0);
    assert.equal(result.error, undefined);
    assert.equal(await workspace.exists('result.txt'), false);
  } finally { await workspace.destroy(); }
});


test('restored WASI composition uses independent leases and preserves executable checks', async () => {
  const binary = Buffer.from([
    0,97,115,109,1,0,0,0,
    1,4,1,96,0,0, 3,2,1,0, 5,3,1,0,1,
    7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,
    10,4,1,2,0,11,
  ]).toString('base64');
  const original = await createRuntimeWorkspace({ files: [
    { path: 'app', contents: binary, encoding: 'base64', mode: 0o755 },
    { path: 'bad', contents: Buffer.from([0,97,115,109,1,0,0,0]).toString('base64'), encoding: 'base64', mode: 0o755 },
  ] });
  const pids: number[] = [];
  const released: number[] = [];
  const restored = await createRuntimeWorkspace({
    ...JSON.parse(JSON.stringify(await original.snapshot())),
    kernel: { scheduler: { maxConcurrentCommands: 1 } },
    cppRunner: async request => {
      const pid = request.process!.pid;
      pids.push(pid);
      request.engineLease!.attach({ release: () => { released.push(pid); } });
      return { stdout: 'ran\n', stderr: '', exitCode: 0 };
    },
  });
  try {
    const result = await restored.runCommand('./app && ./app', { presentation: 'terminal' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ran\nran\n');
    assert.equal(new Set(pids).size, 2);
    assert.equal(released.length, 2);
    const wildcard = await restored.runCommand("true; tracekernel-exec './a*'; tracekernel-exec './a*'");
    assert.equal(wildcard.exitCode, 0);
    assert.equal(wildcard.stdout, 'ran\nran\n');
    assert.equal(new Set(pids).size, 4);
    assert.equal(released.length, 4);
    await restored.runCommand('chmod -x app');
    assert.equal((await restored.runCommand('./app && ./app')).exitCode, 126);
    assert.equal(pids.length, 4, 'non-executable WASI bytes dispatched to the runner');
    assert.notEqual((await restored.runCommand('./bad && ./bad')).exitCode, 0);
    assert.equal(pids.length, 4, 'malformed bytes dispatched to the runner');
  } finally { await restored.destroy(); await original.destroy(); }
});


test('registered virtual executable wildcard invocations also own independent leases', async () => {
  const pids: number[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'main.c', contents: '' }],
    cppRunner: async request => {
      if (request.source === 'compile') return { stdout: '', stderr: '', exitCode: 0,
        files: [{ path: 'app-1', contents: 'fixture registered executable' }] };
      pids.push(request.process!.pid);
      request.engineLease!.attach({ release: () => undefined });
      return { stdout: 'registered\n', stderr: '', exitCode: 0 };
    },
  });
  try {
    assert.equal((await workspace.runCommand('clang main.c -o app-1')).exitCode, 0);
    const result = await workspace.runCommand("true; tracekernel-exec './app-*'; tracekernel-exec './app-*'");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'registered\nregistered\n');
    assert.equal(new Set(pids).size, 2);
  } finally { await workspace.destroy(); }
});
