import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const { cases } = JSON.parse(await readFile(
  new URL('./fixtures/cpp-project-diagnostics.json', import.meta.url), 'utf8'
));
const fileIdentity = JSON.parse(await readFile(
  new URL('./fixtures/cpp-project-file-identity.json', import.meta.url), 'utf8'
));
const worker = (await readFile(
  new URL('../workers/cpp/cpp-worker.js', import.meta.url), 'utf8'
)).replace(/^import [\s\S]*? from ['"][^'"]+['"];\n/gm, '');

for (const fixture of cases) {
  test(`C++ Project diagnostic paths match Clang: ${fixture.name}`, async () => {
    const context = vm.createContext({
      self: { location: new URL('https://example.test/workers/cpp-worker.js'), postMessage() {} },
      URL,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      performance,
      fixture,
    });
    const result = await vm.runInContext(`
      ${worker}
      // Run the trusted Project handler and real compile plan against captured
      // stderr. Substitute only the WASI tool invocation and asset loading.
      loadTraceccCompiler = async () => ({ fsTemplate: new InMemoryFileSystem() });
      loadTraceccReactor = async () => ({});
      let commandIndex = 0;
      runWasiReactor = async (_reactor, args, fs) => {
        const hasDiagnostic = commandIndex++ === fixture.traceccCommandIndex;
        if (hasDiagnostic) {
          if (!args[1].endsWith('/source-' + fixture.traceccCommandIndex + '.cpp')) {
            throw new Error('diagnostic fixture did not reach its source wrapper');
          }
        }
        const exitCode = hasDiagnostic ? fixture.exitCode : 0;
        if (args[0] === 'wasm-ld') fs.addFile(args.at(-1), new Uint8Array([0]));
        return { reactorReusable: true, exitCode, stdout: '', stderr: hasDiagnostic ? fixture.before : '' };
      };
      handleTrustedTraceccCompile({
        source: 'tracecc-project-compile-v1',
        projectRequest: {
          source: 'compile',
          args: fixture.args,
          cwd: fixture.cwd,
          project: {
            workspaceRoot: '/home/guest/playground',
            files: Object.entries(fixture.files).map(([path, contents]) => ({ path, contents })),
          },
        },
      });
    `, context, { filename: 'cpp-worker.js' });
    assert.equal(fixture.expectedStderr, fixture.matchingClangStderr ?? fixture.clangStderr);
    assert.equal(result.success, fixture.exitCode === 0);
    assert.equal(result.stderr, fixture.expectedStderr);
  });
}

for (const fixture of fileIdentity.cases) {
  test(`C++ Project mounts the learner's original bytes at the visible path: ${fixture.name}`, async () => {
    const context = vm.createContext({
      self: { location: new URL('https://example.test/workers/cpp-worker.js'), postMessage() {} },
      URL,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      performance,
      fixture,
      program: fileIdentity.embedSource,
    });
    const input = await vm.runInContext(`
      ${worker}
      loadTraceccCompiler = async () => ({ fsTemplate: new InMemoryFileSystem() });
      loadTraceccReactor = async () => ({});
      let compiledInput;
      runWasiReactor = async (_reactor, args, fs) => {
        const wrapper = decodeUtf8(fs.readFile(args[1]));
        const input = wrapper.trimEnd().split(String.fromCharCode(10)).at(-1).match(/^#include (.+)$/);
        const path = JSON.parse(input[1]);
        compiledInput = { path, source: decodeUtf8(fs.readFile(path)) };
        return { reactorReusable: true, exitCode: 1, stdout: '', stderr: '' };
      };
      handleTrustedTraceccCompile({
        source: 'tracecc-project-compile-v1',
        projectRequest: {
          source: 'compile',
          args: [fixture.operand],
          cwd: fixture.cwd,
          project: {
            workspaceRoot: '/home/guest/playground',
            files: [{ path: fixture.path, contents: program }],
          },
        },
      }).then(() => compiledInput);
    `, context, { filename: 'cpp-worker.js' });
    assert.equal(input.path, fixture.traceccFile, `Native Clang spells this input ${fixture.clangFile}`);
    assert.equal(input.source, fileIdentity.embedSource);
  });
}
