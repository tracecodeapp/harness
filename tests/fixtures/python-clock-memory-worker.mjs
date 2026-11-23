// Adapt the classic worker to Node while keeping its message handler and
// using the bundled Pyodide loader, Wasm, stdlib, and authority policy.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInThisContext } from 'node:vm';
import { parentPort } from 'node:worker_threads';

const workers = resolve('workers');
const python = join(workers, 'python');
const index = join(python, 'pyodide-0.29.3');
const loaderPath = join(index, 'pyodide.js');
globalThis.require = createRequire(pathToFileURL(loaderPath));
globalThis.__dirname = index;
const loader = globalThis.require(loaderPath);
const loadPyodide = loader.loadPyodide ?? globalThis.loadPyodide;

function addBodyTimings(source) {
  function insert(anchor, replacement) {
    if (source.split(anchor).length !== 2) throw new Error('Missing unique timing anchor: ' + anchor);
    source = source.replace(anchor, replacement);
  }
  // Capture the return boundary before either driver's serialization.
  insert(
    '        output = _tracecode_call_target(',
    '        _probe_start = _tracecode_batch_time.perf_counter()\n        output = _tracecode_call_target(',
  );
  insert(
    '        if output is None:\n            for _tracecode_inplace_name in (',
    '        _tracecode_case_console.append(str(_tracecode_batch_time.perf_counter() - _probe_start))\n        if output is None:\n            for _tracecode_inplace_name in (',
  );
  const call = '${executionCallInNestedTry}';
  insert(
    call,
    '        _probe_start = _interview_time.perf_counter()\n' + call +
    '\n        _console_output.append(str(_interview_time.perf_counter() - _probe_start))',
  );
  return source;
}

const workerPath = join(python, 'python-worker.js');
Object.assign(globalThis, {
  self: globalThis,
  location: pathToFileURL(workerPath),
  postMessage: (message) => parentPort.postMessage(message),
  importScripts: (...paths) => {
    for (const specifier of paths) {
      const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;
      const candidates = isAbsolute(path) ? [path] : [resolve(python, path), resolve(workers, path)];
      const filename = candidates.find(existsSync);
      if (!filename) throw new Error('Missing worker script: ' + specifier);
      const source = readFileSync(filename, 'utf8');
      runInThisContext(filename.endsWith('/python-runtime.js') ? addBodyTimings(source) : source, { filename });
    }
  },
  loadPyodide: async (options) => {
    const runtime = await loadPyodide({ ...options, stdout: () => {}, stderr: console.error });
    // Let the Harness's default call-depth guard decide the recursion witness.
    runtime.runPython("__import__('sys').setrecursionlimit(5000)");
    return runtime;
  },
});
runInThisContext(readFileSync(workerPath, 'utf8'), { filename: workerPath });
parentPort.on('message', (data) => globalThis.onmessage({ data }));
