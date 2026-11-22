#!/usr/bin/env npx tsx

// Prepared Java inputs arrive as JSON. A node that appears more than once in
// the input graph is written once with "__id__" and then as {"__ref__": id}.
// These cases compile the Exports source the worker generates for prepared
// inputs and run it on the host JDK, so they check the real coercion code.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

interface PreparedInputEntry {
  key: string;
  index: number;
  type: string;
  path: string;
  property: string;
}

interface JavaWorkerFunctions {
  preparedDynamicInputEntriesForPayload(
    payload: { code: string; functionName: string; executionStyle: string },
    compileId: string
  ): PreparedInputEntry[];
  buildExportsSource(
    source: string,
    functionName: string,
    executionStyle: string,
    input: Record<string, unknown>,
    options: { dynamicInputs: PreparedInputEntry[]; hasDynamicInputs: boolean }
  ): string;
}

const helperJar = join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar');

function loadJavaWorker(): JavaWorkerFunctions {
  const workerSource = readFileSync(join(process.cwd(), 'workers', 'java', 'java-worker.js'), 'utf8');
  const context = vm.createContext({
    self: { postMessage() {}, addEventListener() {}, importScripts() {} },
    console,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    TextEncoder,
    queueMicrotask,
  });
  vm.runInContext(workerSource, context, { filename: 'java-worker.js' });
  return context as unknown as JavaWorkerFunctions;
}

const worker = loadJavaWorker();

type RunnerState = 'submit' | 'companion' | 'recording' | 'one-event';

const RUNNER_BEGIN_RUN: Record<RunnerState, string> = {
  submit: 'TraceHooks.beginRun(1, false, true, true)',
  companion: 'TraceHooks.beginRun(1, false, true, false)',
  recording: 'TraceHooks.beginRun(100000, false, true, true)',
  'one-event': 'TraceHooks.beginRun(1, false, true, true)',
};

/**
 * Runs Exports.run() once per entry of `cases` in one JVM, each case's
 * arguments given in parameter order. Returns each run's output, or the
 * exception message when a run throws.
 */
function runPrepared(
  code: string,
  functionName: string,
  cases: unknown[][],
  executionStyle = 'solution-method',
  options: {
    readonly showErrorType?: boolean;
    readonly timeoutMs?: number;
    /**
     * Run each case inside the TraceHooks run TraceExecutionRunner starts:
     * - submit: a plain program, which the worker still runs with recording
     *   on and a budget of one event (a plain program has no hooks to spend it);
     * - companion: a traced preparation's case run with recording off;
     * - recording: a traced case with budget to spare;
     * - one-event: a traced case whose second event trips the budget.
     */
    readonly runner?: RunnerState;
  } = {}
): string[] {
  const entries = worker.preparedDynamicInputEntriesForPayload(
    { code, functionName, executionStyle },
    'refs'
  );
  const exportsSource = worker.buildExportsSource(code, functionName, executionStyle, {}, {
    dynamicInputs: entries,
    hasDynamicInputs: true,
  });
  const setters = cases.map((args, caseIndex) => entries.map((entry, index) =>
    `      System.setProperty(${JSON.stringify(entry.property)}, ${JSON.stringify(JSON.stringify(args[index]))});`
  ).join('\n') + `\n      runCase(${caseIndex});`).join('\n');
  const source = `import java.util.*;
import tracecode.user.TraceHooks;
${code}
${exportsSource}
final class PreparedMain {
  static void runCase(int index) {
    ${options.runner ? `int token = ${RUNNER_BEGIN_RUN[options.runner]};` : ''}
    try {
      System.out.println("case" + index + ":" + Exports.run());
    } catch (Throwable error) {
      Throwable root = error;
      // Bounded: a learner exception may have a cause cycle.
      for (int depth = 0; depth < 16 && root.getCause() != null && root.getCause() != root; depth += 1) {
        root = root.getCause();
      }
      System.out.println("case" + index + ":error:" + ${options.showErrorType ? '(error.getClass().getSimpleName() + ":") + ' : ''}root.getMessage());
    }${options.runner ? ' finally {\n      TraceHooks.endRun(token);\n    }' : ''}
  }

  public static void main(String[] args) {
${setters}
  }
}
`;
  const root = mkdtempSync(join(tmpdir(), 'tracecode-java-prepared-refs-'));
  try {
    const classes = join(root, 'classes');
    mkdirSync(classes);
    const sourcePath = join(root, 'Exports.java');
    writeFileSync(sourcePath, source, 'utf8');
    execFileSync('javac', ['-nowarn', '-cp', helperJar, '-d', classes, sourcePath], { stdio: 'pipe' });
    const stdout = execFileSync('java', ['-cp', [classes, helperJar].join(':'), 'PreparedMain'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: options.timeoutMs ?? 60_000,
    });
    return stdout.split('\n').filter((line) => line.startsWith('case')).map((line) => line.replace(/^case\d+:/, ''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const learnerListNode = `class ListNode {
  int val;
  ListNode next;
  ListNode(int val) { this.val = val; }
}`;

const cycleToIndexOne = {
  __id__: 'n0', val: 3, next: {
    __id__: 'n1', val: 2, next: {
      __id__: 'n2', val: 0, next: { __id__: 'n3', val: -4, next: { __ref__: 'n1' } },
    },
  },
};

function testListCycleKeepsTheBackReference(): void {
  const code = `${learnerListNode}
class Solution {
  public boolean hasCycle(ListNode head) {
    ListNode slow = head;
    ListNode fast = head;
    while (fast != null && fast.next != null) {
      slow = slow.next;
      fast = fast.next.next;
      if (slow == fast) return true;
    }
    return false;
  }
}`;
  const outputs = runPrepared(code, 'hasCycle', [
    [cycleToIndexOne],
    [{ __id__: 'self', val: 7, next: { __ref__: 'self' } }],
    [{ __id__: 'n0', val: 1, next: { __id__: 'n1', val: 2, next: null } }],
    [null],
  ]);
  assert.deepEqual(outputs, ['true', 'true', 'false', 'false']);
  console.log('PASS: a list whose tail points back into it keeps its cycle');
}

function testListBackReferenceIsTheSameNode(): void {
  const code = `${learnerListNode}
class Solution {
  public String shape(ListNode head) {
    ListNode tail = head.next.next.next;
    return tail.val + ":" + (tail.next == head.next) + ":" + head.next.val;
  }
}`;
  assert.deepEqual(runPrepared(code, 'shape', [[cycleToIndexOne]]), ['"-4:true:2"']);
  console.log('PASS: the back-reference is the node it names, not a copy');
}

function testTreeSharedChildAndAncestorReference(): void {
  const code = `class Solution {
  public String shape(TreeNode root) {
    return (root.left == root.right) + ":" + root.left.val + ":" + (root.left.left == root);
  }
}`;
  const input = {
    __id__: 'r', val: 1,
    left: { __id__: 'c', val: 2, left: { __ref__: 'r' }, right: null },
    right: { __ref__: 'c' },
  };
  assert.deepEqual(runPrepared(code, 'shape', [[input]]), ['"true:2:true"']);
  console.log('PASS: tree inputs keep shared children and references to ancestors');
}

function testObjectGraphCycle(): void {
  const code = `class Node {
  public int val;
  public List<Node> neighbors;
  public Node(int val) {
    this.val = val;
    this.neighbors = new ArrayList<>();
  }
}
class Solution {
  public String shape(Node node) {
    Node other = node.neighbors.get(0);
    return other.val + ":" + (other.neighbors.get(0) == node) + ":" + node.neighbors.size();
  }
}`;
  const input = {
    __id__: 'a', val: 1,
    neighbors: [{ __id__: 'b', val: 2, neighbors: [{ __ref__: 'a' }] }],
  };
  assert.deepEqual(runPrepared(code, 'shape', [[input]]), ['"2:true:1"']);
  console.log('PASS: a custom object graph keeps its cycle');
}

function testReferenceAcrossParameters(): void {
  const code = `${learnerListNode}
class Solution {
  public boolean meet(ListNode a, ListNode b) {
    return a.next == b.next && a.next.val == 8;
  }
}`;
  const a = { val: 1, next: { __id__: 'shared', val: 8, next: null } };
  const b = { val: 5, next: { __ref__: 'shared' } };
  assert.deepEqual(runPrepared(code, 'meet', [[a, b]]), ['true']);
  console.log('PASS: a later parameter can share a node defined by an earlier one');
}

function testReferencesDoNotLeakBetweenCases(): void {
  const code = `${learnerListNode}
class Solution {
  public int first(ListNode head) {
    return head.next.val;
  }
}`;
  const outputs = runPrepared(code, 'first', [
    [{ __id__: 'n0', val: 1, next: { __id__: 'n1', val: 2, next: null } }],
    [{ val: 9, next: { __ref__: 'n1' } }],
  ]);
  assert.equal(outputs[0], '2');
  assert.match(outputs[1] ?? '', /^error:.*n1/, `an unknown reference must fail, not reuse a node from an earlier case: ${outputs[1]}`);
  console.log('PASS: references resolve only within their own case');
}

function testOpsClassArguments(): void {
  const code = `${learnerListNode}
class CycleChecker {
  private final ListNode head;
  public CycleChecker(ListNode head) { this.head = head; }
  public boolean closesOnSecond() { return head.next.next.next.next == head.next; }
}`;
  const outputs = runPrepared(code, 'CycleChecker', [[{
    operations: ['CycleChecker', 'closesOnSecond'],
    arguments: [[cycleToIndexOne], []],
  }]], 'ops-class');
  assert.deepEqual(outputs, ['[null,true]']);
  console.log('PASS: ops-class arguments keep their references');
}

function testNodesAreBuiltOnce(): void {
  // A class whose constructor takes every field must not have each subtree
  // built again by the by-name field assignment that follows construction.
  const code = `class ListNode {
  static int built = 0;
  int val;
  ListNode next;
  ListNode() { built++; }
  ListNode(int val) { this.val = val; built++; }
  ListNode(int val, ListNode next) { this.val = val; this.next = next; built++; }
}
class Solution {
  public String count(ListNode head) {
    int length = 0;
    for (ListNode node = head; node != null; node = node.next) length++;
    return length + ":" + ListNode.built;
  }
}`;
  let input: unknown = null;
  for (let value = 16; value >= 1; value -= 1) input = { val: value, next: input };
  assert.deepEqual(runPrepared(code, 'count', [[input]]), ['"16:16"']);
  console.log('PASS: each prepared node is constructed once');
}

function testReferencedNodeGetsItsRealConstructorValues(): void {
  // A node that its own input points back to is built before its links, but
  // its constructor still receives the input's values, never invented ones.
  const strictNode = `class ListNode {
  final int initialValue;
  int val;
  ListNode next;
  ListNode(int val) {
    if (val == 0) throw new IllegalArgumentException("a node value of 0 is not allowed here");
    this.val = val;
    this.initialValue = val;
  }
}
class Solution {
  public String shape(ListNode head) {
    return head.initialValue + ":" + head.val + ":" + (head.next == head);
  }
}`;
  assert.deepEqual(
    runPrepared(strictNode, 'shape', [[{ __id__: 'self-loop', val: 7, next: { __ref__: 'self-loop' } }]]),
    ['"7:7:true"']
  );
  const recordingNode = `class ListNode {
  final int initialValue;
  int val;
  ListNode next;
  ListNode(int val) {
    this.val = val;
    this.initialValue = val;
  }
}
class Solution {
  public String shape(ListNode head) {
    return head.next.initialValue + ":" + head.next.val + ":" + (head.next.next.next.next == head.next);
  }
}`;
  // n1 is the node the tail points back to, so it is built before its links.
  assert.deepEqual(runPrepared(recordingNode, 'shape', [[cycleToIndexOne]]), ['"2:2:true"']);
  console.log('PASS: a node its input points back to is constructed with its own values');
}

function testSharedAcyclicNodeIsOneNode(): void {
  const code = `class TreeNode {
  int val;
  TreeNode left;
  TreeNode right;
  TreeNode(int val) { this.val = val; }
}
class Solution {
  public String shape(TreeNode root) {
    return (root.left == root.right) + ":" + root.left.val + ":" + root.val;
  }
}`;
  const input = {
    val: 1,
    left: { __id__: 'shared', val: 5, left: null, right: null },
    right: { __ref__: 'shared' },
  };
  assert.deepEqual(runPrepared(code, 'shape', [[input]]), ['"true:5:1"']);
  console.log('PASS: a node two branches share is one node');
}

function testObjectTypedReferencesResolve(): void {
  const code = `class Holder {
  int val;
  Object link;
  Object raw;
  List<Object> items;
  Map<String, Object> named;
}
class Solution {
  public String shape(Holder holder) {
    return (holder.link == holder) + ":" + (((List<?>) holder.raw).get(0) == holder) + ":" +
        (holder.items.get(0) == holder) + ":" + (holder.named.get("me") == holder);
  }
}`;
  const input = {
    __id__: 'h', val: 1,
    link: { __ref__: 'h' },
    raw: [{ __ref__: 'h' }],
    items: [{ __ref__: 'h' }],
    named: { me: { __ref__: 'h' } },
  };
  assert.deepEqual(runPrepared(code, 'shape', [[input]]), ['"true:true:true:true"']);
  console.log('PASS: references reached through Object-typed fields and containers resolve');
}

function testOpsClassReferencesAcrossOperations(): void {
  const code = `${learnerListNode}
class Keeper {
  private final ListNode first;
  private ListNode kept;
  public Keeper(ListNode first) { this.first = first; }
  public void keep(ListNode node) { this.kept = node; }
  public boolean isFirst(ListNode node) { return node == first; }
  public boolean isKept(ListNode node) { return node == kept && node.next == first; }
}`;
  const outputs = runPrepared(code, 'Keeper', [[{
    operations: ['Keeper', 'keep', 'isFirst', 'isKept'],
    arguments: [
      [{ __id__: 'a', val: 1, next: null }],
      [{ __id__: 'b', val: 2, next: { __ref__: 'a' } }],
      [{ __ref__: 'a' }],
      [{ __ref__: 'b' }],
    ],
  }]], 'ops-class');
  assert.deepEqual(outputs, ['[null,null,true,true]']);
  console.log('PASS: a later operation can refer to an object an earlier one received');
}

function testRawSelfCycleUnderObject(): void {
  const code = `class Box {
  Object raw;
  Box(Object raw) { this.raw = raw; }
}
class Solution {
  public boolean selfLoop(Box box) {
    return ((Map<?, ?>) box.raw).get("self") == box.raw;
  }
}`;
  const outputs = runPrepared(code, 'selfLoop', [[{ raw: { __id__: 'r', self: { __ref__: 'r' } } }]]);
  assert.equal(outputs[0], 'true', `a raw object that refers to itself: ${outputs[0]}`);
  console.log('PASS: a raw Object input that refers to itself resolves once');
}

function testEarlyNodeUsesItsFullConstructor(): void {
  const code = `class ListNode {
  final int initialValue;
  int val;
  ListNode next;
  ListNode(int val, ListNode next) {
    this.initialValue = val;
    this.val = val;
    this.next = next;
  }
}
class Solution {
  public String shape(ListNode head) {
    return head.initialValue + ":" + (head.next == head);
  }
}`;
  assert.deepEqual(
    runPrepared(code, 'shape', [[{ __id__: 'self-loop', val: 7, next: { __ref__: 'self-loop' } }]]),
    ['"7:true"']
  );
  console.log('PASS: a node built before its links still gets its value from its full constructor');
}

function testReversedChildrenConstructorKeepsChildrenByName(): void {
  // The constructor declares right before left; the by-name field assignment
  // after it puts each child where the input says, as it always has.
  const code = `class TreeNode {
  int val;
  TreeNode left;
  TreeNode right;
  TreeNode(int val) { this.val = val; }
  TreeNode(int val, TreeNode right, TreeNode left) {
    this.val = val;
    this.right = right;
    this.left = left;
  }
}
class Solution {
  public String shape(TreeNode root) {
    return root.val + ":" + root.left.val + ":" + root.right.val + ":" + root.left.left.val;
  }
}`;
  const input = {
    val: 1,
    left: { val: 2, left: { val: 4, left: null, right: null }, right: null },
    right: { val: 3, left: null, right: null },
  };
  assert.deepEqual(runPrepared(code, 'shape', [[input]]), ['"1:2:3:4"']);
  console.log('PASS: a constructor with reversed child parameters still gets each child by name');
}

function testEarlyNodeConstructorGetsBuiltReferences(): void {
  // Only the fields that lead back to the node being built are null in its
  // constructor; a reference to a node that already exists is passed.
  const code = `class Node {
  int val;
  Node peer;
  Node self;
  boolean hadPeer;
  Node(int val) { this.val = val; }
  Node(int val, Node peer, Node self) {
    this.val = val;
    this.peer = peer;
    this.self = self;
    this.hadPeer = peer != null;
  }
}
class Solution {
  public String shape(Node a, Node b) {
    return b.hadPeer + ":" + (b.peer == a) + ":" + (b.self == b);
  }
}`;
  const a = { __id__: 'a', val: 1, peer: null, self: null };
  const b = { __id__: 'b', val: 2, peer: { __ref__: 'a' }, self: { __ref__: 'b' } };
  assert.deepEqual(runPrepared(code, 'shape', [[a, b]]), ['"true:true:true"']);
  console.log('PASS: a node built before its links gets references that already resolve');
}

function testOpsTypedReferenceToObjectArgument(): void {
  // An earlier operation took the node as Object; a later one asks for it
  // typed, and gets it built as that type.
  const code = `${learnerListNode}
class Keeper {
  Object raw;
  public Keeper() {}
  public void keepRaw(Object value) { this.raw = value; }
  public boolean single(ListNode node) { return node.val == 1 && node.next == null; }
  public boolean loop(ListNode node) { return node.val == 5 && node.next == node; }
}`;
  const outputs = runPrepared(code, 'Keeper', [
    [{ operations: ['Keeper', 'keepRaw', 'single'], arguments: [[], [{ __id__: 'a', val: 1, next: null }], [{ __ref__: 'a' }]] }],
    [{ operations: ['Keeper', 'keepRaw', 'loop'], arguments: [[], [{ __id__: 'r', val: 5, next: { __ref__: 'r' } }], [{ __ref__: 'r' }]] }],
  ], 'ops-class');
  assert.deepEqual(outputs, ['[null,null,true]', '[null,null,true]']);
  console.log('PASS: a typed operation argument can refer to a node an earlier operation took as Object');
}

const cyclicCause = `static RuntimeException cyclicFailure() {
    RuntimeException first = new RuntimeException("learner constructor failed");
    RuntimeException second = new RuntimeException("second", first);
    first.initCause(second);
    return first;
  }`;

function testCyclicCauseInInputConstructorDoesNotHang(): void {
  // A learner exception whose causes form a cycle must not loop the
  // Harness's search for a trace budget error (untraced runs included).
  const code = `class ListNode {
  int val;
  ListNode next;
  ${cyclicCause}
  ListNode(int val) {
    if (val <= 0) throw cyclicFailure();
    this.val = val;
  }
}
class Solution {
  public int first(ListNode head) { return head.val; }
}`;
  const [output] = runPrepared(code, 'first', [[{ val: -1, next: null }]], 'solution-method', { timeoutMs: 20_000 });
  assert.match(output ?? '', /^error:/, String(output));
  console.log('PASS: an input constructor throwing a cyclic cause chain fails promptly');
}

function testCyclicCauseInReceiverConstructorDoesNotHang(): void {
  const code = `class Keeper {
  ${cyclicCause}
  public Keeper(int limit) { throw cyclicFailure(); }
  public int get() { return 1; }
}`;
  const [output] = runPrepared(code, 'Keeper', [[{ operations: ['Keeper', 'get'], arguments: [[1], []] }]], 'ops-class', { timeoutMs: 20_000 });
  assert.match(output ?? '', /^error:/, String(output));
  console.log('PASS: a receiver constructor throwing a cyclic cause chain fails promptly');
}

// Two events into a one-event run: the second trips the trace budget.
const tripBudget = 'TraceHooks.emitLineAtLine(1); TraceHooks.emitLineAtLine(2);';
// The same, with the budget error caught by the learner.
const tripBudgetAndCatch = `try { ${tripBudget} } catch (RuntimeException caught) { }`;

function testBudgetTripInConstructorsReachesTheRunner(): void {
  // The runner turns a trace budget error from run() into its trace-limit
  // result (steps kept, case completed). A constructor the Harness calls
  // while building a receiver or an operation's argument must let that
  // error through unchanged, not treat it as a constructor that did not fit.
  const receiver = `class Keeper {
  public Keeper(int limit) { ${tripBudget} }
  public int get() { return 1; }
}`;
  const argument = `class ListNode {
  int val;
  ListNode next;
  ListNode(int val) { ${tripBudget} }
}
class Keeper {
  public Keeper() {}
  public int keep(ListNode node) { return 1; }
}`;
  for (const [code, operations, args] of [
    [receiver, ['Keeper', 'get'], [[1], []]],
    [argument, ['Keeper', 'keep'], [[], [{ val: 1, next: null }]]],
  ] as const) {
    assert.deepEqual(
      runPrepared(code, 'Keeper', [[{ operations, arguments: args }]], 'ops-class', { showErrorType: true, runner: 'one-event' }),
      ['error:TraceBudgetExceededError:Trace event storage budget exceeded']
    );
  }
  console.log('PASS: a trace budget error in a receiver or argument constructor reaches the runner unchanged');
}

function testBudgetTripInsideGetCauseReachesTheRunner(): void {
  // The search for a budget error calls the learner's getCause(), which is
  // traced: a trip inside it is the budget error, not a getCause() that threw.
  const code = `class Weird extends RuntimeException {
  @Override
  public synchronized Throwable getCause() { ${tripBudget} return null; }
}
class ListNode {
  int val;
  ListNode next;
  ListNode(int val) { throw new Weird(); }
}
class Solution {
  public int first(ListNode head) { return head.val; }
}`;
  assert.deepEqual(
    runPrepared(code, 'first', [[{ val: 1, next: null }]], 'solution-method', { showErrorType: true, runner: 'one-event' }),
    ['error:TraceBudgetExceededError:Trace event storage budget exceeded']
  );
  console.log('PASS: a trace budget error raised inside getCause() reaches the runner unchanged');
}

function testCyclicCauseAfterBudgetTripDoesNotHang(): void {
  // Only after a trip is a receiver failure's cause chain searched.
  const code = `class Keeper {
  ${cyclicCause}
  public Keeper(int limit) { ${tripBudgetAndCatch} throw cyclicFailure(); }
  public int get() { return 1; }
}`;
  const [output] = runPrepared(code, 'Keeper', [[{ operations: ['Keeper', 'get'], arguments: [[1], []] }]], 'ops-class', { runner: 'one-event', timeoutMs: 20_000 });
  assert.match(output ?? '', /^error:/, String(output));
  console.log('PASS: a cyclic cause chain after a budget trip fails promptly');
}

// Reflection does not order overloads, so each program below fails whichever
// overload is tried first and succeeds on the next one.
const throwingGetCause = `class Weird extends RuntimeException {
  @Override
  public synchronized Throwable getCause() { throw new IllegalStateException("getCause is broken"); }
}`;

function assertFallbackInEveryRunnerState(program: (beforeThrow: string) => string, input: unknown): void {
  for (const runner of ['submit', 'companion', 'recording', 'one-event'] as const) {
    const code = program(runner === 'one-event' ? tripBudgetAndCatch : '');
    assert.deepEqual(runPrepared(code, 'Keeper', [[input]], 'ops-class', { runner }), ['[null,"fallback"]'], runner);
  }
}

function testThrowingGetCauseKeepsReceiverFallback(): void {
  // Until the budget trips, the Harness never inspects the learner's
  // exception; after a trip, a getCause() that throws is not a budget error.
  assertFallbackInEveryRunnerState((beforeThrow) => `${throwingGetCause}
class Keeper {
  static int attempts;
  private final String chosen;
  static String attempt() {
    if (attempts++ == 0) { ${beforeThrow} throw new Weird(); }
    return "fallback";
  }
  public Keeper(int limit) { this.chosen = attempt(); }
  public Keeper(String label) { this.chosen = attempt(); }
  public String chosen() { return chosen; }
}`, { operations: ['Keeper', 'chosen'], arguments: [[1], []] });
  console.log('PASS: a throwing getCause() keeps the receiver overload fallback in every runner state');
}

function testThrowingGetCauseKeepsArgumentFallback(): void {
  // Filling a set calls the learner's hashCode(), so its exception reaches
  // the operation probe as it was thrown.
  assertFallbackInEveryRunnerState((beforeThrow) => `${throwingGetCause}
class Key {
  static int attempts;
  int val;
  @Override
  public int hashCode() {
    if (attempts++ == 0) { ${beforeThrow} throw new Weird(); }
    return 1;
  }
}
class Keeper {
  public Keeper() {}
  public String keep(Set<Key> keys) { return "fallback"; }
  public String keep(HashSet<Key> keys) { return "fallback"; }
}`, { operations: ['Keeper', 'keep'], arguments: [[], [[{ val: 1 }]]] });
  console.log('PASS: a throwing getCause() keeps the argument overload fallback in every runner state');
}

const tests = [
  testListCycleKeepsTheBackReference,
  testListBackReferenceIsTheSameNode,
  testTreeSharedChildAndAncestorReference,
  testObjectGraphCycle,
  testReferenceAcrossParameters,
  testReferencesDoNotLeakBetweenCases,
  testOpsClassArguments,
  testNodesAreBuiltOnce,
  testReferencedNodeGetsItsRealConstructorValues,
  testSharedAcyclicNodeIsOneNode,
  testObjectTypedReferencesResolve,
  testOpsClassReferencesAcrossOperations,
  testRawSelfCycleUnderObject,
  testEarlyNodeUsesItsFullConstructor,
  testReversedChildrenConstructorKeepsChildrenByName,
  testEarlyNodeConstructorGetsBuiltReferences,
  testOpsTypedReferenceToObjectArgument,
  testCyclicCauseInInputConstructorDoesNotHang,
  testCyclicCauseInReceiverConstructorDoesNotHang,
  testBudgetTripInConstructorsReachesTheRunner,
  testBudgetTripInsideGetCauseReachesTheRunner,
  testCyclicCauseAfterBudgetTripDoesNotHang,
  testThrowingGetCauseKeepsReceiverFallback,
  testThrowingGetCauseKeepsArgumentFallback,
];
let failures = 0;
for (const test of tests) {
  try {
    test();
  } catch (error) {
    failures += 1;
    console.log(`FAIL: ${test.name}: ${error instanceof Error ? error.message.split('\n').slice(0, 6).join(' ') : String(error)}`);
  }
}
if (failures > 0) {
  console.log(`${failures} of ${tests.length} prepared-reference checks failed`);
  process.exitCode = 1;
}
