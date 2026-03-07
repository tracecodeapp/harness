#!/usr/bin/env npx tsx

import { adaptJavaScriptTraceExecutionResult } from '../packages/harness-core/src/trace-adapters/javascript';
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

function main(): void {
  testJavaScriptHashLikeInference();
  testPythonVisualizationPreservation();
  console.log('\nTrace adapter tests passed.');
}

main();
