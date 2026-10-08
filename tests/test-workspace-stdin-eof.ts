import assert from 'node:assert/strict';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import { createRuntimeCommandStdinPipe, createRuntimeCommandStdinPipeFromText } from '../packages/runtime-contracts/src/index';
import type { JavaScriptProjectCommandRunner } from '../packages/tracekernel/src/workspace/index';
import type { TraceKernelSyscallRequest, TraceKernelSyscallResult } from '../packages/tracekernel/src/index';

let runtimeStarted: (() => void) | undefined;
let observedInput = '';
const runner: JavaScriptProjectCommandRunner = Object.assign(async (request: Parameters<JavaScriptProjectCommandRunner>[0]) => {
  assert.ok(request.kernelSyscalls);
  runtimeStarted?.();
  const dispatch = (requestBody: TraceKernelSyscallRequest) => request.kernelSyscalls!.dispatch(requestBody) as Promise<TraceKernelSyscallResult>;
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await dispatch({ op: 'read', fd: 0, maxBytes: 2 });
    assert.ok(result.ok && result.value.op === 'read');
    if (!result.ok || result.value.op !== 'read') throw new Error('read failed');
    if (!result.value.bytes.length) break;
    chunks.push(result.value.bytes);
  }
  const input = Buffer.concat(chunks).toString();
  observedInput = input;
  for (const [fd, data] of [[1, `out:${input}`], [2, `err:${input}`]] as const) {
    const result = await dispatch({ op: 'write', fd, bytes: new TextEncoder().encode(data) });
    assert.ok(result.ok);
  }
  // EOF stays observable across repeated reads.
  const eof = await dispatch({ op: 'read', fd: 0, maxBytes: 1 });
  assert.ok(eof.ok && eof.value.op === 'read' && eof.value.bytes.length === 0);
  return { stdout: '', stderr: '', exitCode: 0 };
}, { capabilities: { descriptorStdio: true } });

const workspace = await createRuntimeWorkspace({ nodeRunner: runner, files: [
  { path: 'input.js', contents: '' }, { path: 'input.txt', contents: 'file\n' }, { path: 'empty.txt', contents: '' },
] });
try {
  for (const input of ['hello\n', '']) {
    const result = await workspace.runCommand('node input.js', {
      presentation: 'terminal', stdinPipe: createRuntimeCommandStdinPipeFromText(input),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `out:${input}`);
    assert.equal(result.stderr, `err:${input}`);
  }
  for (const [command, input] of [["printf 'pipe\\n' | node input.js", 'pipe\n'], ['node input.js < input.txt', 'file\n'], ['node input.js < empty.txt', ''], ["printf '' | node input.js", ''], ["cmd=node; printf '' | $cmd input.js", ''], ["printf '' | (node input.js)", '']] as const) {
    const result = await workspace.runCommand(command, { presentation: 'terminal' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `out:${input}`);
    assert.equal(result.stderr, `err:${input}`);
  }
  const live = createRuntimeCommandStdinPipe();
  let ready = new Promise<void>(resolve => { runtimeStarted = resolve; });
  const liveRun = workspace.runCommand('node input.js', { presentation: 'terminal', stdinPipe: live });
  await ready;
  live.write('live\n');
  live.close();
  assert.equal((await liveRun).stdout, 'out:live\n');

  const controller = new AbortController();
  ready = new Promise<void>(resolve => { runtimeStarted = resolve; });
  const interrupted = workspace.runCommand('node input.js', {
    presentation: 'terminal', stdinPipe: createRuntimeCommandStdinPipe(), signal: controller.signal,
  });
  await ready;
  controller.abort();
  assert.notEqual((await interrupted).exitCode, 0);
  runtimeStarted = undefined;
  const recovered = await workspace.runCommand('node input.js', {
    presentation: 'terminal', stdinPipe: createRuntimeCommandStdinPipeFromText('recovered\n'),
  });
  assert.equal(recovered.stdout, 'out:recovered\n');
  const unicode = 'café 東京 😀\n';
  await workspace.runCommand('node input.js', {
    presentation: 'terminal', stdinPipe: createRuntimeCommandStdinPipeFromText(unicode),
  });
  assert.equal(observedInput, unicode, 'UTF-8 bytes must survive partial reads');
  console.log('workspace stdin, empty/partial EOF, live input, cancellation, recovery and output separation passed');
} finally { workspace.dispose(); }
