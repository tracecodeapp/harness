#!/usr/bin/env npx tsx
/**
 * A stopping batch's `started` progress message restarts the client's
 * per-case clock, so the JS per-case loop must post it just before the
 * learner's code runs: after the trusted conversion of the case's inputs to a
 * Python literal, as the algorithm-fast driver does. Posted earlier, trusted
 * conversion time counts against the learner's clock.
 *
 * The worker runtime runs under Node with a stand-in for Pyodide's execution
 * guard; it records when inputs are converted and when the compiled program
 * (the learner's code) runs.
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

async function runBatch(
  mode: 'code' | 'trace' = 'trace',
  stopAtFirstRunaway = true
): Promise<{ events: string[]; batch: any }> {
  const runtime = loadRuntime();
  const events: string[] = [];
  const guard = {
    begin() {},
    begin_algorithm() {},
    set_compiled_limit() {},
    run: () => JSON.stringify({ output: 1, console: [] }),
    restore() {},
    artifact_fingerprint: () => proxy(FINGERPRINT),
    classify_algorithm_source: () => proxy({ tier: 'algorithm-fast', reasons: [] }),
    deserialize_code: (encoded: string) => encoded,
    run_compiled(_code: unknown, _namespace: unknown, _resultName: string) {
      events.push('learner-code');
      return JSON.stringify({
        success: true,
        output: 1,
        trace: { schemaVersion: 1, language: 'python', runId: 'python:run', events: [] },
        consoleOutput: [],
      });
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
    toPythonLiteral(value: unknown) {
      if (value && typeof value === 'object' && 'value' in value) {
        events.push(`convert-inputs:${(value as { value: number }).value}`);
      }
      return toPythonLiteral(value);
    },
    loadPyodideInstance: async () => {},
    getPyodide: () => pyodide,
    performanceNow: () => ++now,
  };
  const artifact = {
    schemaVersion: 'tracecode.python.prepared-program.v4',
    fingerprint: FINGERPRINT,
    mode,
    code: 'def solve(value):\n    return value',
    functionName: 'solve',
    executionStyle: 'function',
    traceOptions: {},
    isolationProfile: { tier: 'algorithm-fast', reasons: [] },
    algorithmFastBatchCode: 'algorithm-fast-artifact',
    userCode: 'user-artifact',
    executorCode: 'executor-artifact',
  };
  // Force the JS per-case loop for the code artifact too.
  const batch = await runtime.executePreparedProgramBatch(
    deps,
    artifact,
    [{ value: 1 }, { value: 2 }],
    { guest: { wallClockMs: 1000 } },
    undefined,
    true,
    stopAtFirstRunaway,
    {
      started: (index: number) => events.push(`started:${index}`),
      ...(stopAtFirstRunaway ? { finished: (index: number) => events.push(`finished:${index}`) } : {}),
    }
  );
  return { events, batch };
}

test('the JS per-case loop posts started after input conversion and just before learner code runs', async () => {
  const { events, batch } = await runBatch();
  assert.equal(batch.results?.length, 2, JSON.stringify(batch).slice(0, 400));
  assert.deepEqual(events, [
    'convert-inputs:1',
    'started:0',
    'learner-code',
    'finished:0',
    'convert-inputs:2',
    'started:1',
    'learner-code',
    'finished:1',
  ]);
});

test('a non-stopping code batch acknowledges each start before learner code and returns its whole results', async () => {
  const { events, batch } = await runBatch('code', false);
  assert.deepEqual(Array.from(batch.results, ({ output }: { output: unknown }) => output), [1, 1]);
  assert.deepEqual(events, [
    'convert-inputs:1',
    'started:0',
    'learner-code',
    'convert-inputs:2',
    'started:1',
    'learner-code',
  ]);
});
