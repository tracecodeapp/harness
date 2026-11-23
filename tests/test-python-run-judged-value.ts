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

// ---------------------------------------------------------------------------
// The judged serialize is Submit's own call, path for path. A case whose
// inputs are all scalars is Submit's algorithm-fast batch: the harness
// TreeNode/ListNode are the node classes (a learner's own class serializes as
// an object), the byte ceiling covers the value with the console output, and
// the case's clock is checked while serializing. A case with node inputs is
// Submit's compatibility path: the learner's namespace classes are the node
// classes. Each scenario compares a Submit batch with a Run per traced case.

const OWN_CLASSES = `class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right
`;

const SCALAR_PROGRAM = (ownClasses: boolean) => `${ownClasses ? OWN_CLASSES : ''}
class Solution:
    def solve(self, kind, n):
        if kind == 'built-list':
            head = None
            for value in range(n, 0, -1):
                head = ListNode(value, head)
            return head
        if kind == 'built-tree':
            return TreeNode(1, TreeNode(2), TreeNode(3))
        if kind == 'console':
            for _ in range(30):
                print('x' * 4096)
            return 'y' * n
        if kind == 'slow-to-serialize':
            # Built in C in a moment; serializing its n lists takes longer
            # than the case's clock.
            return list(map(list, zip(range(n))))
        return [1, 2, 3]
`;

const NODE_INPUT_PROGRAM = (ownClasses: boolean) => `${ownClasses ? OWN_CLASSES : ''}
class Solution:
    def solve(self, head: ListNode | None, root: TreeNode | None, kind: str):
        if kind == 'reversed-input':
            prev = None
            while head:
                head.next, prev, head = prev, head, head.next
            return prev
        if kind == 'unchanged-input':
            return head
        if kind == 'input-tree':
            return root
        if kind == 'built-from-input':
            out = None
            while head:
                out = ListNode(head.val, out)
                head = head.next
            return out
        return None
`;

const HEAD = { val: 1, next: { val: 2, next: { val: 3, next: null } } };
const ROOT = { val: 1, left: { val: 2, left: null, right: null }, right: { val: 3, left: null, right: null } };
const BYTES_8_MIB = 8 * 1024 * 1024;

async function prepareSource(code: string, mode: 'code' | 'trace') {
  const prepared = await runtime.prepareProgram!(deps, {
    mode,
    code,
    functionName: 'solve',
    executionStyle: 'solution-method',
    traceOptions: mode === 'trace'
      ? { maxTraceSteps: 4000, maxLineEvents: 12000, maxSingleLineHits: 1000, maxStoredEvents: 16000 }
      : {},
  });
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 500));
  return prepared.artifact;
}

async function differencesFromSubmit(
  code: string,
  cases: readonly { label: string; inputs: Record<string, unknown> }[],
  limits: Record<string, unknown> = LIMITS
): Promise<{ submit: ReturnType<typeof outcome>[]; differing: string[] }> {
  await setup();
  const inputBatch = cases.map((c) => c.inputs);
  const submitBatch = await runtime.executePreparedProgramBatch!(deps, await prepareSource(code, 'code'), inputBatch, limits);
  assert.equal(submitBatch.results?.length, cases.length, JSON.stringify(submitBatch).slice(0, 300));
  const submitResults = submitBatch.results.map(outcome);
  const traceArtifact = await prepareSource(code, 'trace');
  const differing: string[] = [];
  for (const tracedIndex of cases.keys()) {
    const runBatch = await runtime.executePreparedProgramBatch!(
      deps, traceArtifact, inputBatch, limits, cases.map((_, index) => index === tracedIndex)
    );
    assert.equal(runBatch.results?.length, cases.length, JSON.stringify(runBatch).slice(0, 300));
    const runResults = runBatch.results.map(outcome);
    for (const [index, testCase] of cases.entries()) {
      if (JSON.stringify(runResults[index]) === JSON.stringify(submitResults[index])) continue;
      differing.push(
        `${testCase.label} (${index === tracedIndex ? 'traced' : 'untraced'}): ` +
        `Run ${JSON.stringify(runResults[index]).slice(0, 140)}, Submit ${JSON.stringify(submitResults[index]).slice(0, 140)}`
      );
    }
  }
  return { submit: submitResults, differing: [...new Set(differing)] };
}

for (const ownClasses of [true, false]) {
  const who = ownClasses ? 'the learner\'s own ListNode/TreeNode' : 'the harness ListNode/TreeNode';
  test(`nodes built from scalar inputs with ${who}: Run judges them as Submit does`, async () => {
    const { differing } = await differencesFromSubmit(SCALAR_PROGRAM(ownClasses), [
      { label: 'a built list', inputs: { kind: 'built-list', n: 4 } },
      { label: 'a built tree', inputs: { kind: 'built-tree', n: 0 } },
      { label: 'a small answer', inputs: { kind: 'small', n: 0 } },
    ]);
    assert.deepEqual(differing, []);
  });

  test(`node inputs with ${who}: Run judges them as Submit does`, async () => {
    const { differing } = await differencesFromSubmit(NODE_INPUT_PROGRAM(ownClasses), [
      { label: 'the input list reversed', inputs: { head: HEAD, root: null, kind: 'reversed-input' } },
      { label: 'the input list unchanged', inputs: { head: HEAD, root: null, kind: 'unchanged-input' } },
      { label: 'the input tree', inputs: { head: null, root: ROOT, kind: 'input-tree' } },
      { label: 'a list built from the input', inputs: { head: HEAD, root: null, kind: 'built-from-input' } },
    ]);
    assert.deepEqual(differing, []);
  });
}

test('a value under 8 MiB that goes over it with the console output: serialization-limit on Run as on Submit', async () => {
  const consoleBytes = 30 * 4096;
  const { submit: submitted, differing } = await differencesFromSubmit(SCALAR_PROGRAM(false), [
    // The value alone fits; with the console it does not.
    { label: 'value + console over the ceiling', inputs: { kind: 'console', n: BYTES_8_MIB - consoleBytes / 2 } },
    // Value and console fit together.
    { label: 'value + console under the ceiling', inputs: { kind: 'console', n: BYTES_8_MIB - consoleBytes * 2 } },
  ]);
  assert.equal(submitted[0]!.timeoutReason, 'serialization-limit', JSON.stringify(submitted[0]).slice(0, 200));
  assert.equal(submitted[1]!.ok, true, JSON.stringify(submitted[1]).slice(0, 200));
  assert.deepEqual(differing, []);
});

test('the case clock runs out while the value is serialized: client-timeout on Run as on Submit', async () => {
  const { submit: submitted, differing } = await differencesFromSubmit(SCALAR_PROGRAM(false), [
    { label: 'a value slower to serialize than its clock', inputs: { kind: 'slow-to-serialize', n: 240_000 } },
    { label: 'a small answer', inputs: { kind: 'small', n: 0 } },
  ], { guest: { ...LIMITS.guest, wallClockMs: 150 } });
  assert.equal(submitted[0]!.timeoutReason, 'client-timeout', JSON.stringify(submitted[0]));
  assert.equal(submitted[1]!.ok, true);
  assert.deepEqual(differing, []);
});

// ---------------------------------------------------------------------------
// A learner who defines their own ListNode/TreeNode (LeetCode's commented
// definition, uncommented) and returns the input nodes gets the same judged
// value as a learner who does not: the inputs are harness nodes, and the
// harness classes stay node classes next to the learner's. Learner objects
// keep the serialization they had: their own class is the node class on the
// compatibility path, and an object on the algorithm-fast path.

async function submitOutcomes(
  code: string,
  cases: readonly Record<string, unknown>[]
): Promise<ReturnType<typeof outcome>[]> {
  await setup();
  const batch = await runtime.executePreparedProgramBatch!(deps, await prepareSource(code, 'code'), cases, LIMITS);
  assert.equal(batch.results?.length, cases.length, JSON.stringify(batch).slice(0, 300));
  return JSON.parse(JSON.stringify(batch.results.map(outcome)));
}

test('returning the input nodes with an own ListNode/TreeNode: Submit judges the same value as without one', async () => {
  const cases = [
    { head: HEAD, root: null, kind: 'reversed-input' },
    { head: HEAD, root: null, kind: 'unchanged-input' },
    { head: null, root: ROOT, kind: 'input-tree' },
  ];
  const own = await submitOutcomes(NODE_INPUT_PROGRAM(true), cases);
  const harness = await submitOutcomes(NODE_INPUT_PROGRAM(false), cases);
  assert.deepEqual(own, harness);
  assert.ok(own.every((result) => result.ok && !result.output.includes('"value"')), JSON.stringify(own));
});

const NOT_A_NODE = `class ListNode:
    def __init__(self, x):
        self.x = x
        self.extra = 'kept'

class TreeNode:
    def __init__(self, val, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right
        self.color = 'red'
`;

test('a learner class named ListNode that is not a node, and a learner node with extra fields: serialized as before', async () => {
  // Algorithm-fast (scalar inputs): the learner's classes are objects, every
  // public field kept.
  const fast = await submitOutcomes(`${NOT_A_NODE}
class Solution:
    def solve(self, kind, n):
        if kind == 'not-a-node':
            return ListNode(n)
        return TreeNode(n, TreeNode(n + 1))
`, [
    { kind: 'not-a-node', n: 7 },
    { kind: 'tree', n: 1 },
  ]);
  assert.deepEqual(fast, [
    { ok: true, output: '{"__type__":"ListNode","__class__":"ListNode","x":7,"extra":"kept"}' },
    {
      ok: true,
      output: '{"__type__":"TreeNode","__class__":"TreeNode","val":1,"left":{"__type__":"TreeNode","__class__":"TreeNode","val":2,"left":null,"right":null,"color":"red"},"right":null,"color":"red"}',
    },
  ]);
  // Compatibility (node inputs): the learner's TreeNode is the node class
  // (val/left/right only), and the input list is still the harness list.
  const compat = await submitOutcomes(`${NOT_A_NODE}
class Solution:
    def solve(self, head, root, kind):
        if kind == 'own-tree':
            return TreeNode(5, TreeNode(6))
        return head
`, [
    { head: HEAD, root: null, kind: 'own-tree' },
    { head: HEAD, root: null, kind: 'input-list' },
  ]);
  assert.deepEqual(compat[0], {
    ok: true,
    output: '{"__type__":"TreeNode","val":5,"left":{"__type__":"TreeNode","val":6,"left":null,"right":null},"right":null}',
  });
  assert.equal(compat[1]!.ok, true, JSON.stringify(compat[1]));
});

test('a node-input case whose clock runs out while its value is serialized: client-timeout on Run as on Submit', async () => {
  // Node inputs put the case on the compatibility path, where Submit
  // serializes under its interview guard's clock.
  const { submit: submitted, differing } = await differencesFromSubmit(`
class Solution:
    def solve(self, head: ListNode | None, kind: str):
        if kind == 'slow-to-serialize':
            return list(map(list, zip(range(240000))))
        return head
`, [
    { label: 'a value slower to serialize than its clock', inputs: { head: HEAD, kind: 'slow-to-serialize' } },
    { label: 'the input list', inputs: { head: HEAD, kind: 'input' } },
  ], { guest: { ...LIMITS.guest, wallClockMs: 150 } });
  assert.equal(submitted[0]!.timeoutReason, 'client-timeout', JSON.stringify(submitted[0]).slice(0, 200));
  assert.equal(submitted[1]!.ok, true, JSON.stringify(submitted[1]).slice(0, 200));
  assert.deepEqual(differing, []);
});

test('learner code that assigns the harness-class names cannot change how the unguarded executeCode path serializes', async () => {
  await setup();
  // The inputs are converted to harness nodes before the call; the learner
  // then defines its own ListNode under that name, and has replaced the
  // globals the harness classes were once kept in.
  const own = `
__tracecode_harness_tree_node = None
__tracecode_harness_list_node = None

class Solution:
    def solve(self, head):
        global ListNode
        class ListNode:
            def __init__(self, val=0, next=None):
                self.val = val
                self.next = next
        return head
`;
  const control = `
class Solution:
    def solve(self, head):
        return head
`;
  // No limits and no preparation: the inlined, unguarded executeCode path.
  const run = async (code: string) =>
    outcome(await runtime.executeCode!(deps, code, 'solve', { head: HEAD }, 'solution-method', {}));
  const [ownResult, controlResult] = [await run(own), await run(control)];
  assert.equal(controlResult.ok, true, JSON.stringify(controlResult));
  assert.deepEqual(JSON.parse(JSON.stringify(ownResult)), JSON.parse(JSON.stringify(controlResult)));
});
