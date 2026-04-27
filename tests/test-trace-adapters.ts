#!/usr/bin/env npx tsx

import { adaptJavaScriptTraceExecutionResult } from '../packages/harness-core/src/trace-adapters/javascript';
import { adaptJavaTraceExecutionResult, buildJavaExecutionResult } from '../packages/harness-core/src/trace-adapters/java';
import { adaptPythonTraceExecutionResult } from '../packages/harness-core/src/trace-adapters/python';
import type { ExecutionResult } from '../packages/harness-core/src/types';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testJavaScriptHashLikeInference(): void {
  const input: ExecutionResult = {
    success: true,
    output: 2,
    trace: [
      {
        line: 4,
        event: 'line',
        function: 'solve',
        variables: {
          seen: { __type__: 'map', entries: [[2, 0]] },
          visited: { __type__: 'set', values: [2] },
        },
        accesses: [
          {
            variable: 'nums',
            kind: 'indexed-read',
            indices: [1],
            pathDepth: 1,
          },
        ],
      },
    ],
    executionTimeMs: 3,
    consoleOutput: [],
    lineEventCount: 1,
    traceStepCount: 1,
  };

  const adapted = adaptJavaScriptTraceExecutionResult('javascript', input);
  const hashMaps = adapted.trace[0]?.visualization?.hashMaps;
  assertCondition(hashMaps === undefined, 'adapter should not infer hash-like payloads from raw variables');
  assertCondition(
    adapted.trace[0]?.accesses?.[0]?.kind === 'indexed-read',
    'adapter should preserve normalized runtime access events'
  );
  assertCondition(adapted.traceStepCount === 1, 'adapter should preserve traceStepCount');
  console.log('PASS: JavaScript trace adapter does not infer runtime visualization payloads');
}

function testPythonVisualizationPreservation(): void {
  const input: ExecutionResult = {
    success: true,
    output: [0, 1],
    trace: [
      {
        line: 7,
        event: 'line',
        function: 'solve',
        variables: {
          seen: { '2': 0 },
        },
        accesses: [
          {
            variable: 'dp',
            kind: 'cell-write',
            indices: [2, 1],
            pathDepth: 2,
          },
        ],
        visualization: {
          objectKinds: {
            root: 'tree',
          },
          hashMaps: [
            {
              name: 'seen',
              kind: 'hashmap',
              entries: [{ key: '2', value: 0 }],
              highlightedKey: '2',
            },
          ],
        },
      },
    ],
    executionTimeMs: 5,
    consoleOutput: [],
    lineEventCount: 1,
    traceStepCount: 1,
  };

  const adapted = adaptPythonTraceExecutionResult(input);
  const objectKinds = adapted.trace[0]?.visualization?.objectKinds ?? {};
  const hashMaps = adapted.trace[0]?.visualization?.hashMaps ?? [];
  assertCondition(objectKinds.root === 'tree', 'adapter should preserve runtime objectKinds payload');
  assertCondition(hashMaps.length === 1, 'adapter should not duplicate existing runtime hashMaps');
  assertCondition(hashMaps[0]?.highlightedKey === '2', 'adapter should preserve highlightedKey from runtime payload');
  assertCondition(
    adapted.trace[0]?.accesses?.[0]?.kind === 'cell-write',
    'python adapter should preserve runtime access events'
  );
  console.log('PASS: Python trace adapter preserves runtime visualization payload');
}

function testJavaVisualizationPreservation(): void {
  const input: ExecutionResult = {
    success: true,
    output: [1, 2, 3],
    trace: [
      {
        line: 8,
        event: 'line',
        function: 'search',
        variables: {
          nums: [1, 2, 3],
          root: { __type__: 'TreeNode', val: 3, left: null, right: null },
        },
        accesses: [
          {
            variable: 'nums',
            kind: 'indexed-read',
            indices: [1],
            pathDepth: 1,
          },
        ],
        visualization: {
          objectKinds: {
            root: 'tree',
          },
        },
      },
    ],
    executionTimeMs: 4,
    consoleOutput: [],
    lineEventCount: 1,
    traceStepCount: 1,
  };

  const adapted = adaptJavaTraceExecutionResult(input);
  assertCondition(
    adapted.trace[0]?.visualization?.objectKinds?.root === 'tree',
    'java adapter should preserve runtime objectKinds payload'
  );
  assertCondition(
    adapted.trace[0]?.accesses?.[0]?.kind === 'indexed-read',
    'java adapter should preserve runtime access events'
  );
  console.log('PASS: Java trace adapter preserves runtime visualization payload');
}

function testJavaLineOnlyAndSpacedStringParsing(): void {
  const adapted = buildJavaExecutionResult(
    true,
    [
      'line=4 call isPalindrome s=A man, a plan, a canal: Panama',
      'line=5',
      'line=5 left=0',
      'line=6',
      'line=6 right=29',
      'line=24 return isPalindrome value=true',
    ],
    7
  );

  assertCondition(adapted.trace.length === 4, 'java adapter should merge same-line scalar events into the line step');
  assertCondition(adapted.trace[0]?.event === 'call', 'java adapter should keep the call event');
  assertCondition(
    adapted.trace[0]?.variables?.s === 'A man, a plan, a canal: Panama',
    'java adapter should preserve spaced string arguments'
  );
  assertCondition(
    adapted.trace[0]?.callStack?.[0]?.args?.s === 'A man, a plan, a canal: Panama',
    'java adapter should expose call arguments on call stack frames like JS/Python'
  );
  assertCondition(adapted.trace[1]?.event === 'line' && adapted.trace[1]?.line === 5, 'java adapter should parse bare line-only events');
  assertCondition(
    !Object.prototype.hasOwnProperty.call(adapted.trace[1]?.variables ?? {}, 'line'),
    'java adapter should not materialize bare line events as a fake line variable'
  );
  assertCondition(adapted.trace[1]?.variables?.left === 0, 'java adapter should fold scalar variable updates into the line event');
  assertCondition(adapted.trace[2]?.line === 6, 'java adapter should keep subsequent bare line events at their real line');
  assertCondition(adapted.trace[2]?.variables?.right === 29, 'java adapter should preserve later scalar variable updates on the line event');
  assertCondition(
    adapted.trace[3]?.event === 'return' &&
      adapted.trace[3]?.line === 24 &&
      adapted.trace[3]?.returnValue === true,
    'java adapter should parse return events with returnValue like JS/Python'
  );
  console.log('PASS: Java trace adapter parses bare line events and merges same-line scalar updates');
}

function testJavaMatrixAccessParsing(): void {
  const adapted = buildJavaExecutionResult(
    [[2, 2], [2, 0]],
    [
      'line=12 access image[0][0]=1',
      'line=12',
      'line=21 write-array image[0][1]=2',
      'line=21',
    ],
    5
  );

  assertCondition(adapted.trace.length === 2, 'java adapter should attach matrix accesses to the following line step');
  assertCondition(
    adapted.trace[0]?.accesses?.[0]?.kind === 'cell-read' &&
      adapted.trace[0]?.accesses?.[0]?.indices?.[0] === 0 &&
      adapted.trace[0]?.accesses?.[0]?.indices?.[1] === 0,
    'java adapter should parse 2D array reads as cell-read events'
  );
  assertCondition(
    adapted.trace[1]?.accesses?.[0]?.kind === 'cell-write' &&
      adapted.trace[1]?.accesses?.[0]?.indices?.[0] === 0 &&
      adapted.trace[1]?.accesses?.[0]?.indices?.[1] === 1,
    'java adapter should parse 2D array writes as cell-write events'
  );
  console.log('PASS: Java trace adapter parses matrix access events');
}

function testJavaArrayLengthAccessStaysIndexedState(): void {
  const adapted = buildJavaExecutionResult(
    5,
    [
      'line=3 call lowerBound nums=[1,3,3,5,8] target=4',
      'line=5',
      'line=5 nums=[1,3,3,5,8]',
      'line=5 access nums.length=5',
      'line=5 right=5',
    ],
    2
  );

  const initStep = adapted.trace.find((step) => step.event === 'line' && step.line === 5);
  assertCondition(
    JSON.stringify(initStep?.variables?.nums) === JSON.stringify([1, 3, 3, 5, 8]),
    'java adapter should keep array length reads attached to the array state'
  );
  assertCondition(
    initStep?.variables?.right === 5,
    'java adapter should preserve scalar assigned from array length'
  );
  assertCondition(
    initStep?.visualization?.objectKinds?.nums === undefined,
    'java adapter should not reinterpret array length reads as object field visualization'
  );
  console.log('PASS: Java trace adapter treats array length reads as indexed-state context');
}

function testJavaStringAccessParsing(): void {
  const adapted = buildJavaExecutionResult(
    true,
    [
      'line=3 call isPalindrome text=racecar',
      'line=4 left=0',
      'line=5 right=6',
      'line=7',
      'line=7 access text[0]="r"',
      'line=7 access text[6]="r"',
      'line=8 left=1',
    ],
    5
  );

  const compareStep = adapted.trace.find((step) => step.event === 'line' && step.line === 7);
  assertCondition(
    compareStep?.variables?.text === 'racecar',
    'java adapter should keep string inputs available on string access steps'
  );
  assertCondition(
    JSON.stringify(compareStep?.accesses) === JSON.stringify([
      {
        variable: 'text',
        kind: 'indexed-read',
        indices: [0],
        pathDepth: 1,
      },
      {
        variable: 'text',
        kind: 'indexed-read',
        indices: [6],
        pathDepth: 1,
      },
    ]),
    `java adapter should parse String.charAt runtime hooks as indexed reads, got ${JSON.stringify(compareStep?.accesses)}`
  );
  console.log('PASS: Java trace adapter parses string character access events');
}

function testJavaMapSetVisualizationAndKeyedCalls(): void {
  const adapted = buildJavaExecutionResult(
    [0, 1],
    [
      'line=4 keyed-call seen method=put key=2 value=0',
      'line=4 map-state seen={"name":"seen","kind":"map","highlightedKey":2,"entries":[{"key":2,"value":0,"highlight":true}]}',
      'line=5 keyed-call seen method=containsKey key=7',
      'line=5 map-state seen={"name":"seen","kind":"map","highlightedKey":7,"entries":[{"key":2,"value":0}]}',
      'line=6 keyed-call visited method=add key=2',
      'line=6 set-state visited={"name":"visited","kind":"set","highlightedKey":2,"entries":[{"key":2,"value":true,"highlight":true}]}',
      'line=7 keyed-call visited method=remove key=2',
      'line=7 set-state visited={"name":"visited","kind":"set","deletedKey":2,"entries":[]}',
    ],
    5
  );

  const putStep = adapted.trace.find((step) =>
    step.accesses?.some((access) =>
      access.variable === 'seen' &&
      access.kind === 'mutating-call' &&
      access.method === 'put'
    )
  );
  assertCondition(Boolean(putStep), 'java adapter should parse Map.put as a runtime access event');
  assertCondition(
    putStep?.visualization?.objectKinds?.seen === 'map',
    'java adapter should expose Map locals as objectKinds.map'
  );
  assertCondition(
    putStep?.visualization?.hashMaps?.[0]?.kind === 'map' &&
      putStep.visualization.hashMaps[0]?.highlightedKey === 2 &&
      putStep.visualization.hashMaps[0]?.entries?.[0]?.highlight === true,
    'java adapter should parse map-state visualization with highlighted keys'
  );

  const containsStep = adapted.trace.find((step) =>
    step.accesses?.some((access) => access.variable === 'seen' && access.method === 'containsKey')
  );
  assertCondition(Boolean(containsStep), 'java adapter should parse Map.containsKey as an access event');
  assertCondition(
    containsStep?.visualization?.hashMaps?.[0]?.highlightedKey === 7,
    'java adapter should preserve highlighted missing Map keys'
  );

  const addStep = adapted.trace.find((step) =>
    step.accesses?.some((access) => access.variable === 'visited' && access.method === 'add')
  );
  assertCondition(
    addStep?.visualization?.objectKinds?.visited === 'set' &&
      addStep.visualization.hashMaps?.[0]?.kind === 'set',
    'java adapter should expose Set locals as objectKinds.set and hashMaps entries'
  );

  const removeStep = adapted.trace.find((step) =>
    step.accesses?.some((access) => access.variable === 'visited' && access.method === 'remove')
  );
  assertCondition(
    removeStep?.visualization?.hashMaps?.[0]?.deletedKey === 2,
    'java adapter should preserve deleted Set keys'
  );
  console.log('PASS: Java trace adapter parses Map/Set visualization and keyed operation events');
}

function testJavaGraphAdjacencyAndIndexedReceiverMutationParsing(): void {
  const adapted = buildJavaExecutionResult(
    [0, 1, 2],
    [
      'line=4 graph=[[],[],[]]',
      'line=4 state graph-adjacency graph=[[],[],[]]',
      'line=5 access graph[0]=[]',
      'line=5 mutate-indexed graph[0] method=add',
      'line=5 graph=[[1],[],[]]',
      'line=6 access graph[1]=[]',
      'line=6 mutate-indexed graph[1] method=add',
      'line=6 graph=[[1],[2],[]]',
      'line=10 access graph[1]=[2]',
      'line=10',
    ],
    5
  );

  const graphStateStep = adapted.trace.find((step) => step.visualization?.objectKinds?.graph === 'graph-adjacency');
  assertCondition(Boolean(graphStateStep), 'java adapter should expose emitted graph adjacency objectKinds');
  assertCondition(
    JSON.stringify(graphStateStep?.variables?.graph) === JSON.stringify([[], [], []]),
    'java adapter should preserve graph adjacency list state values'
  );

  const addZeroStep = adapted.trace.find((step) =>
    step.accesses?.some((access) =>
      access.variable === 'graph' &&
      access.kind === 'mutating-call' &&
      access.method === 'add' &&
      JSON.stringify(access.indices) === JSON.stringify([0])
    )
  );
  assertCondition(Boolean(addZeroStep), 'java adapter should preserve indexed receiver mutation indices');
  assertCondition(
    addZeroStep?.accesses?.some((access) =>
      access.variable === 'graph' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([0])
    ) === true,
    'java adapter should keep graph.get(u) indexed reads with adjacency mutations'
  );

  const traversalStep = adapted.trace.find((step) =>
    step.accesses?.some((access) =>
      access.variable === 'graph' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([1])
    )
  );
  assertCondition(Boolean(traversalStep), 'java adapter should preserve adjacency traversal indexed reads');
  console.log('PASS: Java trace adapter parses graph adjacency state and indexed receiver mutations');
}

function testJavaBlankLineRemapping(): void {
  const sourceText = `class Solution {
  int search(int[] nums, int target) {
    int left = 0;
    int right = nums.length - 1;

    while (left <= right) {
      int mid = left + (right - left) / 2;
      if (nums[mid] == target) return mid;
    }

    return -1;
  }
}`;

  const adapted = buildJavaExecutionResult(
    4,
    [
      'line=3 call search nums=[1,2,3] target=3',
      'line=4 left=0',
      'line=5 right=2',
      'line=6',
      'line=7 mid=1',
      'line=11 return search',
    ],
    5,
    undefined,
    undefined,
    undefined,
    sourceText
  );

  const lineSteps = adapted.trace.filter((step) => step.event === 'line').map((step) => step.line);
  assertCondition(
    JSON.stringify(lineSteps) === JSON.stringify([4, 6, 7]),
    `java adapter should remap blank/comment-only stops to executable lines, got ${JSON.stringify(lineSteps)}`
  );
  console.log('PASS: Java trace adapter remaps blank-line stops to executable lines');
}

function testJavaDoesNotMergeAcrossDistinctVisits(): void {
  const adapted = buildJavaExecutionResult(
    0,
    [
      'line=10',
      'line=10 access nums[0]=1',
      'line=11',
      'line=10',
      'line=10 access nums[1]=2',
    ],
    2
  );

  const line10Steps = adapted.trace.filter((step) => step.event === 'line' && step.line === 10);
  assertCondition(
    line10Steps.length === 2,
    `java adapter should not merge non-consecutive same-line visits, got ${line10Steps.length}`
  );
  assertCondition(
    (line10Steps[0]?.accesses?.length ?? 0) === 1 && (line10Steps[1]?.accesses?.length ?? 0) === 1,
    'java adapter should keep access payloads attached to the correct line visit'
  );
  console.log('PASS: Java trace adapter keeps distinct same-line visits separate');
}

function testJavaDoesNotMergeConsecutiveSameLineVisits(): void {
  const adapted = buildJavaExecutionResult(
    0,
    [
      'line=6',
      'line=6 dp=[[1,0]]',
      'line=6',
      'line=6 dp=[[1,1]]',
    ],
    2
  );

  const line6Steps = adapted.trace.filter((step) => step.event === 'line' && step.line === 6);
  assertCondition(
    line6Steps.length === 2,
    `java adapter should keep consecutive same-line loop visits separate, got ${line6Steps.length}`
  );
  assertCondition(
    JSON.stringify(line6Steps[0]?.variables?.dp) === JSON.stringify([[1, 0]]) &&
      JSON.stringify(line6Steps[1]?.variables?.dp) === JSON.stringify([[1, 1]]),
    'java adapter should attach same-line state updates to their own loop visit'
  );
  console.log('PASS: Java trace adapter keeps consecutive same-line loop visits separate');
}

function testJavaSkipsMethodDeclarationLineEvents(): void {
  const sourceText = `class Solution {
  int run(int x) {
    return helper(x);
  }

  int helper(int x) {
    return x + 1;
  }
}`;

  const adapted = buildJavaExecutionResult(
    2,
    [
      'line=2 call run x=1',
      'line=3',
      'line=6 call helper x=1',
      'line=6 x=1',
      'line=7',
      'line=6 return helper',
      'line=3 return run',
    ],
    2,
    undefined,
    undefined,
    undefined,
    sourceText
  );

  const lineSteps = adapted.trace.filter((step) => step.event === 'line').map((step) => step.line);
  assertCondition(
    JSON.stringify(lineSteps) === JSON.stringify([3, 7]),
    `java adapter should skip method declaration line events, got ${JSON.stringify(lineSteps)}`
  );
  console.log('PASS: Java trace adapter skips method declaration line events');
}

function main(): void {
  testJavaScriptHashLikeInference();
  testPythonVisualizationPreservation();
  testJavaVisualizationPreservation();
  testJavaLineOnlyAndSpacedStringParsing();
  testJavaMatrixAccessParsing();
  testJavaArrayLengthAccessStaysIndexedState();
  testJavaStringAccessParsing();
  testJavaMapSetVisualizationAndKeyedCalls();
  testJavaGraphAdjacencyAndIndexedReceiverMutationParsing();
  testJavaBlankLineRemapping();
  testJavaDoesNotMergeAcrossDistinctVisits();
  testJavaDoesNotMergeConsecutiveSameLineVisits();
  testJavaSkipsMethodDeclarationLineEvents();
  console.log('\nTrace adapter tests passed.');
}

main();
