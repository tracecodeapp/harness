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

/**
 * Runs Exports.run() once per entry of `cases` in one JVM, each case's
 * arguments given in parameter order. Returns each run's output, or the
 * exception message when a run throws.
 */
function runPrepared(
  code: string,
  functionName: string,
  cases: unknown[][],
  executionStyle = 'solution-method'
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
    try {
      System.out.println("case" + index + ":" + Exports.run());
    } catch (Throwable error) {
      Throwable root = error;
      while (root.getCause() != null && root.getCause() != root) root = root.getCause();
      System.out.println("case" + index + ":error:" + root.getMessage());
    }
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
      timeout: 60_000,
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
    StringBuilder out = new StringBuilder();
    ListNode node = head;
    for (int index = 0; index < 4; index += 1, node = node.next) {
      out.append(node.initialValue).append(index < 3 ? "," : "");
    }
    return out + ":" + (node == head.next);
  }
}`;
  assert.deepEqual(runPrepared(recordingNode, 'shape', [[cycleToIndexOne]]), ['"3,2,0,-4:true"']);
  console.log('PASS: list nodes, cyclic or not, are constructed with their own values');
}

function testSharedAcyclicNodeIsBuiltWithItsValues(): void {
  const code = `class TreeNode {
  final int initialValue;
  int val;
  TreeNode left;
  TreeNode right;
  TreeNode(int val) {
    if (val == 0) throw new IllegalArgumentException("a node value of 0 is not allowed here");
    this.val = val;
    this.initialValue = val;
  }
}
class Solution {
  public String shape(TreeNode root) {
    return (root.left == root.right) + ":" + root.left.initialValue + ":" + root.initialValue;
  }
}`;
  const input = {
    val: 1,
    left: { __id__: 'shared', val: 5, left: null, right: null },
    right: { __ref__: 'shared' },
  };
  assert.deepEqual(runPrepared(code, 'shape', [[input]]), ['"true:5:1"']);
  console.log('PASS: a node two branches share is built once with its own values');
}

function testUnbuildableNodeReportsWhy(): void {
  const code = `class ListNode {
  int val;
  ListNode next;
  ListNode(String label, boolean strict) {
    if (label == null) throw new IllegalArgumentException("label is required");
  }
}
class Solution {
  public int first(ListNode head) {
    return head.val;
  }
}`;
  const [output] = runPrepared(code, 'first', [[{ __id__: 'n0', val: 1, next: { __ref__: 'n0' } }]]);
  assert.match(output ?? '', /^error:TraceCode could not construct prepared input ListNode/, String(output));
  console.log('PASS: a node no constructor can build fails with a clear message');
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

function testContainersAreBuiltOnce(): void {
  const code = `class Box {
  List<Integer> items;
  List<Integer> original;
  int[] values;
  int[] originalValues;
  Box(List<Integer> items, int[] values) {
    this.items = items;
    this.original = items;
    this.values = values;
    this.originalValues = values;
  }
}
class Solution {
  public String shape(Box box) {
    return (box.items == box.original) + ":" + (box.values == box.originalValues) + ":" + box.items;
  }
}`;
  assert.deepEqual(
    runPrepared(code, 'shape', [[{ items: [1, 2, 3], values: [4, 5] }]]),
    ['"true:true:[1, 2, 3]"']
  );
  console.log('PASS: a container a constructor received is not replaced by a second copy');
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
  testSharedAcyclicNodeIsBuiltWithItsValues,
  testUnbuildableNodeReportsWhy,
  testObjectTypedReferencesResolve,
  testContainersAreBuiltOnce,
  testOpsClassReferencesAcrossOperations,
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
