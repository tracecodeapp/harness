#!/usr/bin/env npx tsx
/**
 * A Run's cases are judged on exactly what Submit would judge. The app's Run
 * is one trace batch (one case traced, the others untraced) on a prepared
 * trace artifact; Submit is a batch on a prepared code artifact. Both run
 * here in Pyodide (the browser worker's Python) through the worker runtime's
 * own prepare and batch entry points, and every case must come back with the
 * same outcome and the same returned value:
 * - a correct n-queens for n = 9 returns all 352 boards, not a display-capped
 *   256 and a marker;
 * - a value over Submit's serializer limits (250,001 items) is the
 *   serialization-limit on Run too, not a pass;
 * - a linked list, also one whose node appears twice, serializes as Submit
 *   serializes it, without the trace snapshot's node ids and refs;
 * - a small answer and a runaway loop are unchanged.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/runtime-python/src/python-harness';

const PROGRAM = `class Solution:
    def solveNQueens(self, n):
        result = []
        board = [['.' for _ in range(n)] for _ in range(n)]

        def is_valid(row, col):
            for i in range(row):
                if board[i][col] == 'Q':
                    return False
            for i, j in zip(range(row-1, -1, -1), range(col-1, -1, -1)):
                if board[i][j] == 'Q':
                    return False
            for i, j in zip(range(row-1, -1, -1), range(col+1, n)):
                if board[i][j] == 'Q':
                    return False
            return True

        def backtrack(row):
            if row == n:
                result.append([''.join(row) for row in board])
                return
            for col in range(n):
                if is_valid(row, col):
                    board[row][col] = 'Q'
                    backtrack(row + 1)
                    board[row][col] = '.'

        backtrack(0)
        return result

    def solve(self, kind, n):
        if kind == 'queens':
            return self.solveNQueens(n)
        if kind == 'big':
            return list(range(n))
        if kind == 'linked':
            head = None
            for value in range(n, 0, -1):
                head = ListNode(value, head)
            return head
        if kind == 'shared':
            node = ListNode(7, ListNode(8))
            return [node, node]
        if kind == 'runaway':
            k = 0
            while k >= 0:
                k = (k + 1) % 10
            return k
        return [1, 2, 3]
`;

const CASES = [
  { label: 'n-queens n=9', inputs: { kind: 'queens', n: 9 } },
  { label: 'a 250,001-item list', inputs: { kind: 'big', n: 250_001 } },
  { label: 'a linked list of 20 nodes', inputs: { kind: 'linked', n: 20 } },
  { label: 'a list holding one node twice', inputs: { kind: 'shared', n: 0 } },
  { label: 'a small answer', inputs: { kind: 'small', n: 0 } },
  { label: 'a runaway loop', inputs: { kind: 'runaway', n: 0 } },
] as const;

// Keeps the runaway short; the same limits go to Submit and Run.
const LIMITS = { guest: { maxLineEvents: 2_000_000, maxSingleLineHits: 400_000, interviewGuard: true } };

type Runtime = Record<string, (...args: any[]) => Promise<any>>;

let pyodide: any;
let runtime: Runtime;
let deps: Record<string, unknown>;

async function setup(): Promise<void> {
  if (runtime) return;
  const require = createRequire(join(process.cwd(), 'package.json'));
  const { loadPyodide } = require('pyodide');
  pyodide = await loadPyodide();
  pyodide.setStdout({ batched: () => undefined });
  pyodide.setStderr({ batched: () => undefined });
  const source = await readFile(join(process.cwd(), 'workers/python/python-runtime.js'), 'utf8');
  const self: Record<string, any> = {};
  vm.runInContext(source, vm.createContext({ console, self, globalThis: {} }), { filename: 'python-runtime.js' });
  runtime = self.__TRACECODE_PYODIDE_RUNTIME__;
  deps = {
    toPythonLiteral,
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    INTERVIEW_GUARD_DEFAULTS: {
      maxLineEvents: 4_000_000,
      maxSingleLineHits: 1_500_000,
      maxCallDepth: 2000,
      maxMemoryBytes: 96 * 1024 * 1024,
      memoryCheckEvery: 200,
    },
    loadPyodideInstance: async () => {},
    getPyodide: () => pyodide,
    performanceNow: () => performance.now(),
  };
}

after(() => {
  pyodide = undefined;
});

async function prepare(mode: 'code' | 'trace') {
  const prepared = await runtime.prepareProgram!(deps, {
    mode,
    code: PROGRAM,
    functionName: 'solve',
    executionStyle: 'solution-method',
    // The app's Run budgets for a backtracking problem.
    traceOptions: mode === 'trace'
      ? { maxTraceSteps: 4000, maxLineEvents: 20000, maxSingleLineHits: 4000, maxStoredEvents: 16000 }
      : {},
  });
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 500));
  return prepared.artifact;
}

// The line guard's two reasons are one outcome here: which of them stops a
// runaway first differs between the traced and untraced tracers, and that
// is not what this test is about.
const LINE_GUARD_REASONS = new Set(['line-limit', 'single-line-limit']);

function outcome(result: Record<string, any>) {
  if (result.success === true) return { ok: true, output: JSON.stringify(result.output) };
  const reason = result.timeoutReason ?? null;
  return {
    ok: false,
    timeoutReason: LINE_GUARD_REASONS.has(reason) ? 'line guard' : reason,
    output: result.output ?? null,
  };
}

let submitted: Promise<ReturnType<typeof outcome>[]> | undefined;
function submit() {
  submitted ??= runSubmit();
  return submitted;
}

async function runSubmit() {
  const batch = await runtime.executePreparedProgramBatch!(
    deps, await prepare('code'), CASES.map((c) => c.inputs), LIMITS
  );
  return batch.results.map(outcome);
}

async function run(tracedIndex: number, stopAtFirstRunaway = false) {
  const batch = await runtime.executePreparedProgramBatch!(
    deps, await prepare('trace'), CASES.map((c) => c.inputs), LIMITS,
    CASES.map((_, index) => index === tracedIndex),
    false,
    stopAtFirstRunaway
  );
  return batch.results.map(outcome);
}

test('Submit: the expected outcome for every case', async () => {
  await setup();
  const results = await submit();
  assert.equal(JSON.parse(results[0].output).length, 352, 'n-queens n=9 has 352 boards');
  assert.deepEqual(results[1], { ok: false, timeoutReason: 'serialization-limit', output: null });
  assert.ok(!results[2].output.includes('__id__'), results[2].output);
  assert.equal(results[4].output, '[1,2,3]');
  assert.equal(results[5].ok, false);
  assert.equal(results[5].timeoutReason, 'line guard', JSON.stringify(results[5]));
});

// A non-stopping Run sends its untraced cases through the fast batch; a
// stopping one runs every case in order through the trace executor. The
// runaway is the last case, so a stopping batch still returns every case.
// n-queens n = 9 is not traced here: recording a million-line search takes
// long enough on a loaded machine to meet a clock, which is not what this
// test is about. It runs untraced in every Run.
const RUNS = [
  ...[1, 2, 3, 4, 5].map((tracedIndex) => ({ tracedIndex, stopping: false })),
  { tracedIndex: 3, stopping: true },
];

for (const { tracedIndex, stopping } of RUNS) {
  test(`${stopping ? 'Stopping Run' : 'Run'} with "${CASES[tracedIndex].label}" traced: every case judged as Submit judges it`, async () => {
    await setup();
    const expected = await submit();
    const actual = await run(tracedIndex, stopping);
    assert.equal(actual.length, expected.length);
    const differing = CASES
      .map((testCase, index) => ({ testCase, index }))
      .filter(({ index }) => JSON.stringify(actual[index]) !== JSON.stringify(expected[index]))
      .map(({ testCase, index }) =>
        `${testCase.label} (${index === tracedIndex ? 'traced' : 'untraced'}): Run ${JSON.stringify(actual[index]).slice(0, 160)}, Submit ${JSON.stringify(expected[index]).slice(0, 160)}`);
    assert.deepEqual(differing, [], 'Run cases judged differently from Submit');
  });
}
