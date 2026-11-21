#!/usr/bin/env npx tsx
/**
 * The algorithm-fast batch driver decides whether a stopping batch (Run) ends
 * from the result it actually recorded for a case, not from the result the
 * case produced. Recording can replace a result: encoding it can pass the
 * case's deadline (the time limit) or its byte ceiling (the serialization
 * limit). A stop decided from the replaced-away result either runs cases
 * after a recorded time limit, which the Judge rejects as a protocol error,
 * or stops after a recorded serialization limit, which is not a prefix the
 * worker accepts.
 *
 * The driver runs in host CPython exactly as Pyodide would run it, with the
 * same bindings the worker passes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/runtime-python/src/python-harness';

interface CaseResult {
  readonly success: boolean;
  readonly output?: unknown;
  readonly timeoutReason?: string;
}

function driverSource(): string {
  // The source builder is internal to the worker runtime; expose it to this
  // test only.
  const source = readFileSync(join(process.cwd(), 'workers', 'python', 'python-runtime.js'), 'utf8')
    .replace(
      'globalScope.__TRACECODE_PYODIDE_RUNTIME__ = {',
      'globalScope.__TRACECODE_PYODIDE_RUNTIME__ = { buildPythonAlgorithmFastBatchSource,'
    );
  const self: Record<string, any> = {};
  vm.runInContext(source, vm.createContext({ console, self, globalThis: {} }), {
    filename: 'python-runtime.js',
  });
  return self.__TRACECODE_PYODIDE_RUNTIME__.buildPythonAlgorithmFastBatchSource(
    {
      toPythonLiteral,
      PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
      INTERVIEW_GUARD_DEFAULTS: {
        maxLineEvents: 400000,
        maxSingleLineHits: 150000,
        maxCallDepth: 2000,
        maxMemoryBytes: 96 * 1024 * 1024,
        memoryCheckEvery: 200,
      },
    },
    'solve',
    'function'
  );
}

/** Runs one stopping batch of `values` through the driver and returns what it recorded. */
function runStoppingBatch(
  learnerCode: string,
  values: readonly number[],
  limits: Record<string, unknown>,
  prelude = ''
): CaseResult[] {
  const program = [
    prelude,
    `__tracecode_prepared_user_source = ${toPythonLiteral(learnerCode)}`,
    `__tracecode_input_batch_literal = ${toPythonLiteral(toPythonLiteral(values.map((value) => ({ value }))))}`,
    `__tracecode_limits_literal = ${toPythonLiteral(toPythonLiteral({ ...limits, stopAtFirstRunaway: true }))}`,
    driverSource(),
    'print(_json_out)',
  ].join('\n');
  const stdout = execFileSync('python3', ['-I', '-c', program], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout.trimEnd()) as CaseResult[];
}

test('a case whose recorded result became a time limit while it was encoded ends the stopping batch', () => {
  // The deadline passes while case 1's (successful) result is encoded: the
  // clock reads far in the future only inside the driver's result recorder.
  const prelude = [
    'import sys as _test_sys, time as _test_time',
    '_test_real_perf_counter = _test_time.perf_counter',
    'def _test_perf_counter():',
    '    frame = _test_sys._getframe(1)',
    '    while frame is not None:',
    "        if frame.f_code.co_name == '_tracecode_batch_append_result' and frame.f_globals.get('_tracecode_batch_case_index') == 0:",
    '            return _test_real_perf_counter() + 1e6',
    '        frame = frame.f_back',
    '    return _test_real_perf_counter()',
    '_test_time.perf_counter = _test_perf_counter',
  ].join('\n');
  const results = runStoppingBatch(
    'def solve(value):\n    return "v" + str(value)',
    [1, 2, 3],
    { wallClockMs: 30_000 },
    prelude
  );
  assert.equal(results[0]?.success, false);
  assert.equal(results[0]?.timeoutReason, 'client-timeout');
  assert.equal(results.length, 1, `No case may run after a recorded time limit: ${JSON.stringify(results)}`);
});

test('a case whose time-limit result was recorded as a serialization limit does not end the stopping batch', () => {
  // Case 1 prints more than the result envelope may carry, then loops into
  // the line limit. Its recorded result is the serialization limit, which
  // does not stop a Run, so the remaining cases still run.
  const results = runStoppingBatch(
    [
      'def solve(value):',
      '    if value == 1:',
      "        print('x' * (9 * 1024 * 1024))",
      '        while True:',
      '            pass',
      '    return value',
    ].join('\n'),
    [1, 2, 3],
    { interviewGuard: true, maxLineEvents: 10_000 }
  );
  assert.equal(results[0]?.timeoutReason, 'serialization-limit', JSON.stringify(results[0]));
  assert.deepEqual(
    results.map((result) => result.output ?? null),
    [null, 2, 3],
    'A recorded serialization limit must not stop the batch'
  );
});
