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
      'line=24 return isPalindrome',
    ],
    7
  );

  assertCondition(adapted.trace.length === 4, 'java adapter should merge same-line scalar events into the line step');
  assertCondition(adapted.trace[0]?.event === 'call', 'java adapter should keep the call event');
  assertCondition(
    adapted.trace[0]?.variables?.s === 'A man, a plan, a canal: Panama',
    'java adapter should preserve spaced string arguments'
  );
  assertCondition(adapted.trace[1]?.event === 'line' && adapted.trace[1]?.line === 5, 'java adapter should parse bare line-only events');
  assertCondition(
    !Object.prototype.hasOwnProperty.call(adapted.trace[1]?.variables ?? {}, 'line'),
    'java adapter should not materialize bare line events as a fake line variable'
  );
  assertCondition(adapted.trace[1]?.variables?.left === 0, 'java adapter should fold scalar variable updates into the line event');
  assertCondition(adapted.trace[2]?.line === 6, 'java adapter should keep subsequent bare line events at their real line');
  assertCondition(adapted.trace[2]?.variables?.right === 29, 'java adapter should preserve later scalar variable updates on the line event');
  assertCondition(adapted.trace[3]?.event === 'return' && adapted.trace[3]?.line === 24, 'java adapter should parse return events normally');
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
  testJavaBlankLineRemapping();
  testJavaDoesNotMergeAcrossDistinctVisits();
  testJavaSkipsMethodDeclarationLineEvents();
  console.log('\nTrace adapter tests passed.');
}

main();
