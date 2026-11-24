#!/usr/bin/env npx tsx
/**
 * Which execution scope a prepared Python execution runs in.
 *
 * The scope (`guard.begin_algorithm()` or `guard.begin()`) is chosen only
 * from the program's classification and the case's inputs:
 *
 * - an `algorithm-fast` program whose inputs need no custom materialization
 *   runs in the algorithm scope, whether it is an ordinary execution, a
 *   traced execution, or an observer's drawing. The observer's retained
 *   worker relies on the same classification the ordinary fast batch does;
 * - every other program (judge-compatible, hard-isolated) and every input
 *   that needs custom materialization runs in the compatibility scope,
 *   which also restores every loaded module's state.
 *
 * The worker runtime runs under Node with a stand-in for Pyodide's execution
 * guard that records which scope each execution opened and closed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/runtime-python/src/python-harness';

const FINGERPRINT = { cacheTag: 'cpython-test', magicNumber: 'test', marshalVersion: 4 };

type Tier = 'algorithm-fast' | 'judge-compatible' | 'hard-isolated';

function loadRuntime(): Record<string, any> {
  const source = readFileSync(join(process.cwd(), 'workers', 'python', 'python-runtime.js'), 'utf8');
  const self: Record<string, any> = {};
  vm.runInContext(source, vm.createContext({ console, self, globalThis: {} }), {
    filename: 'python-runtime.js',
  });
  return self.__TRACECODE_PYODIDE_RUNTIME__;
}

function proxy(value: unknown) {
  return { toJs: () => value, destroy() {} };
}

/** One worker interpreter: a runtime and a guard that records its scopes. */
function interpreter() {
  const runtime = loadRuntime();
  const scopes: string[] = [];
  // The scope that was open each time the prepared executor (the learner's
  // code) ran. Ordinary code executions also open a trusted finalizer scope.
  const learnerScopes: Array<string | null> = [];
  let open: string | null = null;
  const enter = (scope: string) => {
    // The real guard refuses a nested scope.
    assert.equal(open, null, `nested ${scope} inside ${open}`);
    open = scope;
    scopes.push(scope);
  };
  const guard = {
    begin: () => enter('begin'),
    begin_algorithm: () => enter('begin_algorithm'),
    restore() {
      assert.notEqual(open, null, 'restore without an open scope');
      scopes.push(`restore:${open}`);
      open = null;
    },
    set_compiled_limit() {},
    run: () => JSON.stringify({ output: 1, console: [] }),
    artifact_fingerprint: () => proxy(FINGERPRINT),
    classify_algorithm_source: () => proxy({ tier: 'algorithm-fast', reasons: [] }),
    deserialize_code: (encoded: string) => encoded,
    run_compiled(_code: unknown, _namespace: unknown, resultName: string) {
      learnerScopes.push(open);
      if (resultName === '__tracecode_execution_result_json') {
        return JSON.stringify({
          success: true,
          result: null,
          console: [],
          runtimeTrace: {
            schemaVersion: 'runtime-trace-2026-04-28',
            language: 'python',
            runId: 'python:run',
            events: [],
          },
          observation: { recorderCompleted: true, encodeFailed: false, attemptedEvents: 0 },
          lineEventCount: 0,
          traceStepCount: 0,
        });
      }
      return JSON.stringify({ success: true, output: 1, consoleOutput: [] });
    },
  };
  const pyodide = {
    FS: {},
    runPython: () => guard,
    toPy: () => ({ set() {}, destroy() {} }),
    globals: { delete() {} },
  };
  let now = 0;
  const deps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    INTERVIEW_GUARD_DEFAULTS: {
      maxLineEvents: 400000,
      maxSingleLineHits: 150000,
      maxCallDepth: 2000,
      maxMemoryBytes: 96 * 1024 * 1024,
      memoryCheckEvery: 200,
    },
    toPythonLiteral,
    loadPyodideInstance: async () => {},
    getPyodide: () => pyodide,
    performanceNow: () => ++now,
  };
  return {
    scopes,
    /** The scopes one execution opened and closed on this interpreter. */
    async execute(artifact: Record<string, unknown>, inputs: Record<string, unknown>) {
      const before = scopes.length;
      const learnerBefore = learnerScopes.length;
      const result = await runtime.executePreparedProgram(deps, artifact, inputs, {
        guest: { wallClockMs: 1000 },
      });
      assert.equal(open, null, 'the execution left its scope open');
      return {
        result,
        scopes: scopes.slice(before),
        learnerScopes: learnerScopes.slice(learnerBefore),
      };
    },
  };
}

function artifact(
  mode: 'code' | 'trace',
  tier: Tier,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 'tracecode.python.prepared-program.v4',
    fingerprint: FINGERPRINT,
    mode,
    code: 'def solve(value):\n    return value',
    functionName: 'solve',
    executionStyle: 'function',
    traceOptions: {},
    isolationProfile: { tier, reasons: tier === 'algorithm-fast' ? [] : ['test-reason'] },
    ...(mode === 'code' && tier === 'algorithm-fast'
      ? { algorithmFastBatchCode: 'algorithm-fast-artifact' }
      : {}),
    userCode: 'user-artifact',
    executorCode: 'executor-artifact',
    ...extra,
  };
}

const observer = (tier: Tier) => artifact('trace', tier, { observationOnly: true });
const plainInputs = { value: 3 };
// A tree node is rebuilt by the tracer's custom materializer.
const treeInputs = { value: { __type__: 'TreeNode', __id__: 'tree-1', val: 1, left: null, right: null } };

test('an algorithm-fast observer draws in the algorithm scope', async () => {
  const { scopes, learnerScopes, result } = await interpreter().execute(observer('algorithm-fast'), plainInputs);
  assert.equal(result.observation?.recorderCompleted, true, JSON.stringify(result).slice(0, 400));
  assert.deepEqual(learnerScopes, ['begin_algorithm']);
  assert.deepEqual(scopes, ['begin_algorithm', 'restore:begin_algorithm']);
});

test('a retained algorithm-fast observer opens one algorithm scope per drawing and closes it', async () => {
  const worker = interpreter();
  const program = observer('algorithm-fast');
  for (const value of [1, 2, 3]) {
    const { scopes } = await worker.execute(program, { value });
    assert.deepEqual(scopes, ['begin_algorithm', 'restore:begin_algorithm'], `drawing ${value}`);
  }
});

test('compatibility-classified observers stay in the compatibility scope', async () => {
  for (const tier of ['judge-compatible', 'hard-isolated'] as const) {
    const { scopes } = await interpreter().execute(observer(tier), plainInputs);
    assert.deepEqual(scopes, ['begin', 'restore:begin'], tier);
  }
});

test('an algorithm-fast observer whose inputs need custom materialization stays in the compatibility scope', async () => {
  const { scopes } = await interpreter().execute(observer('algorithm-fast'), treeInputs);
  assert.deepEqual(scopes, ['begin', 'restore:begin']);
});

test('ordinary prepared executions keep their scopes', async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ['algorithm-fast code', artifact('code', 'algorithm-fast'), plainInputs, 'begin_algorithm'],
    ['judge-compatible code', artifact('code', 'judge-compatible'), plainInputs, 'begin'],
    ['hard-isolated code', artifact('code', 'hard-isolated'), plainInputs, 'begin'],
    ['algorithm-fast code, tree input', artifact('code', 'algorithm-fast'), treeInputs, 'begin'],
    ['algorithm-fast trace', artifact('trace', 'algorithm-fast'), plainInputs, 'begin_algorithm'],
    ['judge-compatible trace', artifact('trace', 'judge-compatible'), plainInputs, 'begin'],
    ['algorithm-fast trace, tree input', artifact('trace', 'algorithm-fast'), treeInputs, 'begin'],
  ];
  for (const [label, program, inputs, scope] of cases) {
    const { learnerScopes } = await interpreter().execute(program, inputs);
    assert.deepEqual(learnerScopes, [scope], label);
  }
});
