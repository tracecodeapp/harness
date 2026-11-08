import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { createRuntimeCommandStdinPipe, revokeRuntimeCommandStdinPipe, writeRuntimeCommandStdinPipeBytes } from '../packages/runtime-contracts/src/runtime-command';

// Exercise the actual reader bodies without booting a compiler/runtime. State
// 1 is ordinary EOF (buffer remains readable); state 2 is irrevocable refusal.
const readers = [
  ['python', 'workers/python/python-worker.js', ['stdinPipeAvailable', 'readStdinPipeByte'], 'readStdinPipeByte(state)'],
  ['csharp', 'workers/csharp/csharp-worker.js', ['stdinPipeAvailable', 'readStdinPipeByte'], 'readStdinPipeByte(state)'],
  ['java', 'workers/java/java-worker.js', ['stdinPipeAvailable', 'readJavaProjectInputByte'], 'readJavaProjectInputByte("/dev/stdin", false)'],
  ['cpp', 'workers/cpp/cpp-worker.js', ['stdinPipeAvailable', 'readStdinPipeBytes'], 'readStdinPipeBytes.call({ stdinPipe: state }, 32, false)'],
  ['javascript', 'workers/javascript/javascript-project-worker.js', ['runtimeCommandStdinPipeState', 'runtimeCommandStdinPipeAvailable', 'readRuntimeCommandStdinPipeBytes'], 'readRuntimeCommandStdinPipeBytes(pipe, 32)'],
  ['native', 'packages/runtime-contracts/src/runtime-command.ts', ['runtimeCommandStdinPipeState', 'runtimeCommandStdinPipeAvailable', 'readRuntimeCommandStdinPipeBytes'], 'readRuntimeCommandStdinPipeBytes(pipe, 32)'],
] as const;
for (const [name, path, names, call] of readers) {
  const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const definitions: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && (names as readonly string[]).includes(node.name.getText(source))) {
      const text = node.getText(source).replace(/^export /, '');
      definitions.push(ts.isMethodDeclaration(node) ? `const ${node.name.getText(source)} = ({ ${text} }).${node.name.getText(source)};` : text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(definitions.length, names.length, `${name}: all reader definitions found`);
  const code = ts.transpile(definitions.join('\n'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
  for (const schedule of ['eof', 'already-revoked', 'revoke-after-copy', 'revoke-before-wait'] as const) {
    if (schedule === 'revoke-before-wait' && (name === 'javascript' || name === 'native')) continue;
    const pipe = createRuntimeCommandStdinPipe();
    if (schedule !== 'revoke-before-wait') { pipe.write('x'); pipe.close(); }
    const header = new Int32Array(pipe.buffer, 0, 3);
    if (schedule === 'already-revoked') Atomics.store(header, 2, 2);
    const atomics = Object.create(Atomics);
    atomics.store = (array: Int32Array, index: number, value: number) => {
      const result = Atomics.store(array, index, value);
      if (schedule === 'revoke-after-copy' && index === 0) Atomics.store(header, 2, 2);
      return result;
    };
    atomics.wait = (array: Int32Array, index: number, value: number) => {
      revokeRuntimeCommandStdinPipe(pipe);
      assert.equal(Atomics.wait(array, index, value, 0), 'not-equal', `${name}: no lost revocation wakeup`);
    };
    const context = vm.createContext({
      Atomics: atomics, Uint8Array, Int32Array, state: { header, bytes: new Uint8Array(pipe.buffer, 12) }, pipe,
      activeJavaProjectIo: { stdinPipe: { header, bytes: new Uint8Array(pipe.buffer, 12) }, request: {} },
      kernelDeviceInputSource: () => '/dev/stdin',
      STDIN_PIPE_READ_INDEX: 0, STDIN_PIPE_WRITE_INDEX: 1, STDIN_PIPE_CLOSED_INDEX: 2, STDIN_PIPE_REVOKED: 2,
      RUNTIME_STDIN_PIPE_READ_INDEX: 0, RUNTIME_STDIN_PIPE_WRITE_INDEX: 1, RUNTIME_STDIN_PIPE_CLOSED_INDEX: 2,
      RUNTIME_STDIN_PIPE_REVOKED: 2, RUNTIME_STDIN_PIPE_HEADER_INTS: 3, RUNTIME_STDIN_PIPE_HEADER_BYTES: 12,
    });
    const result = vm.runInContext(`${code}\n${schedule === 'revoke-before-wait' ? call.replace(', false)', ', true)') : call}`, context);
    const delivered = typeof result === 'number' ? result >= 0 : result !== null && result.byteLength > 0;
    assert.equal(delivered, schedule === 'eof', `${name}: ${schedule} delivery`);
  }
  console.log(`PASS ${name}: EOF preserves bytes; revoked and mid-read revocation refuse bytes`);
}

const pipe = createRuntimeCommandStdinPipe(2);
pipe.write('x');
const pending = writeRuntimeCommandStdinPipeBytes(pipe, new Uint8Array([1]));
const refusal = assert.rejects(pending, /closed/);
pipe.close();
await refusal;
console.log('PASS close wakes backpressured stdin writer for refusal');

const waitingPipe = createRuntimeCommandStdinPipe(2);
waitingPipe.write('x');
const waitAsync = Atomics.waitAsync;
try {
  Atomics.waitAsync = (array, index, value, timeout) => {
    revokeRuntimeCommandStdinPipe(waitingPipe);
    const result = waitAsync(array as Int32Array, index, value as number, timeout);
    assert.equal(result.value, 'not-equal');
    return result;
  };
  await assert.rejects(writeRuntimeCommandStdinPipeBytes(waitingPipe, new Uint8Array([1])), /closed/);
  waitingPipe.close();
  assert.equal(new Int32Array(waitingPipe.buffer, 0, 3)[2], 2, 'EOF cannot undo revocation');
} finally { Atomics.waitAsync = waitAsync; }
console.log('PASS revocation before writer wait cannot lose its wakeup or be undone by EOF');
