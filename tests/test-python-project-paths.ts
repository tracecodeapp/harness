#!/usr/bin/env npx tsx
/**
 * Python project commands print the learner's paths, the way CPython does.
 *
 * Runs the shipped project runner (workers/python/python-worker.js) on a real
 * Pyodide interpreter in this process, without the TraceKernel mount; the
 * kernel-mounted terminal path is covered in test-tracekernel-python-browser.ts.
 * Cases run in order on one interpreter, as the browser worker reuses one.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  PYTHON_PROJECT_INTERNAL_MOUNT,
  PYTHON_PROJECT_PATH_CASES,
  pyodideExpected,
  type PythonProjectPathCase,
} from './fixtures/python-project-paths';

const WORKSPACE_ROOT = '/home/guest/playground';

interface ProjectResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function loadProjectRunner(): Promise<{
  pyodide: any;
  run(request: Record<string, unknown>): Promise<ProjectResult>;
}> {
  const require = createRequire(join(process.cwd(), 'package.json'));
  const pyodide = await require('pyodide').loadPyodide();
  pyodide.setStdout({ batched: () => undefined });
  pyodide.setStderr({ batched: () => undefined });
  const self: Record<string, unknown> = { postMessage: () => undefined };
  // The runner reads its callbacks through `from js import self`.
  (globalThis as { self?: unknown }).self = self;
  const context = vm.createContext({
    console,
    self,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Int32Array,
    SharedArrayBuffer,
    Atomics,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
    __pyodide: pyodide,
  });
  vm.runInContext(await readFile(join(process.cwd(), 'workers/python/python-worker.js'), 'utf8'), context, {
    filename: 'python-worker.js',
  });
  vm.runInContext('pyodide = __pyodide;', context);
  return {
    pyodide,
    async run(request) {
      (context as { __request?: unknown }).__request = request;
      return vm.runInContext(
        'executeProjectPythonUserCall(__request, "project-paths", "project-paths-token", null, null)',
        context
      ) as Promise<ProjectResult>;
    },
  };
}

function requestFor(entry: PythonProjectPathCase): Record<string, unknown> {
  const cwd = entry.cwd ? `${WORKSPACE_ROOT}/${entry.cwd}` : WORKSPACE_ROOT;
  return {
    source: entry.source,
    scriptPath: entry.scriptPath,
    args: [...entry.args],
    cwd,
    env: {},
    code: '',
    project: { workspaceRoot: WORKSPACE_ROOT, cwd: WORKSPACE_ROOT, files: entry.files.map((file) => ({ ...file })) },
  };
}

const runnerPromise = loadProjectRunner();

// Interpreter state a project command patches while it runs. Algorithm-mode
// work shares this interpreter, so each command must put it back.
const INTERPRETER_STATE = [
  'import _io, io, linecache, sys, tokenize',
  'repr((id(_io.open_code), id(io.open_code), id(tokenize.open), [id(hook) for hook in sys.path_hooks], sys.path[:],',
  '      sorted(key for key in sys.path_importer_cache if isinstance(key, str) and key.startswith(("/home/guest", "/tracecode_project"))),',
  '      sorted(key for key in linecache.cache if key.startswith(("/home/guest", "/tracecode_project")))))',
].join('\n');

let stateBefore: string | undefined;

test('capture interpreter state before any project command', async () => {
  const { pyodide } = await runnerPromise;
  stateBefore = pyodide.runPython(INTERPRETER_STATE);
});

for (const entry of PYTHON_PROJECT_PATH_CASES) {
  test(`${entry.name} (${entry.command})`, async () => {
    const { run } = await runnerPromise;
    const result = await run(requestFor(entry));
    const actual = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    assert.deepEqual(actual, pyodideExpected(entry, WORKSPACE_ROOT));
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes(PYTHON_PROJECT_INTERNAL_MOUNT),
      `the internal mount leaked: ${JSON.stringify(actual)}`
    );
  });
}

test('the internal mount never shows in sys.path or module paths', async () => {
  const { run } = await runnerPromise;
  const result = await run(requestFor({
    name: 'mount probe',
    files: [
      {
        path: 'main.py',
        contents: [
          'import os, sys, helper, pkg',
          'print(repr(sys.path))',
          'print(helper.__spec__.origin, helper.__cached__)',
          'print(list(pkg.__path__))',
          'print(os.path.realpath(__file__))',
          '',
        ].join('\n'),
      },
      { path: 'helper.py', contents: '' },
      { path: 'pkg/__init__.py', contents: '' },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: { stdout: '', stderr: '', exitCode: 0 },
  }));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(!result.stdout.includes(PYTHON_PROJECT_INTERNAL_MOUNT), result.stdout);
  assert.ok(result.stdout.includes(`${WORKSPACE_ROOT}/helper.py`), result.stdout);
  assert.ok(result.stdout.includes(`['${WORKSPACE_ROOT}/pkg']`), result.stdout);
});

test('project commands put the interpreter state back', async () => {
  const { pyodide } = await runnerPromise;
  assert.equal(pyodide.runPython(INTERPRETER_STATE), stateBefore);
});
