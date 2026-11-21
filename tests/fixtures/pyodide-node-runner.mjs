// Runs Python programs in Pyodide (the Python the browser worker runs) in a
// Node worker thread. Each message is a program whose last expression is the
// reply. The parent terminates the thread if a program never returns.
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(`${workerData.root}/package.json`);
const { loadPyodide } = require('pyodide');
const pyodide = await loadPyodide();
pyodide.setStdout({ batched: () => undefined });
pyodide.setStderr({ batched: () => undefined });
parentPort.postMessage({ ready: true, version: pyodide.runPython('import sys; sys.version.split()[0]') });
parentPort.on('message', async ({ id, code }) => {
  try {
    parentPort.postMessage({ id, value: String(await pyodide.runPythonAsync(code)) });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
