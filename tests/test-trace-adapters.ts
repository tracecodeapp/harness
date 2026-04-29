#!/usr/bin/env npx tsx

import { adaptJavaScriptTraceExecutionResult } from '../packages/harness-core/src/trace-adapters/javascript';
import { javaTraceHooksEventsToV4Trace } from '../packages/harness-core/src/trace-adapters/java';
import { adaptPythonTraceExecutionResult } from '../packages/harness-core/src/trace-adapters/python';
import type { LegacyTraceExecutionResult } from '../packages/harness-core/src/types';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPublicV4Trace(label: string, result: { trace: unknown }): void {
  const trace = result.trace as { events?: unknown[]; schemaVersion?: unknown };
  assertCondition(!Array.isArray(result.trace), `${label} must not expose legacy trace step arrays`);
  assertCondition(Array.isArray(trace.events), `${label} must expose RuntimeV4Trace.events`);
  assertCondition(trace.schemaVersion === 'v4-draft-2026-04-28', `${label} must expose the V4 schema version`);
}

function makeLegacyTraceResult(trace: LegacyTraceExecutionResult['trace']): LegacyTraceExecutionResult {
  return {
    success: true,
    output: null,
    trace,
    executionTimeMs: 0,
    consoleOutput: [],
    lineEventCount: trace.filter((step) => step.event === 'line').length,
    traceStepCount: trace.length,
  };
}

function testJavaScriptBoundaryReturnsV4(): void {
  const result = adaptJavaScriptTraceExecutionResult('javascript', makeLegacyTraceResult([
    {
      line: 4,
      event: 'line',
      function: 'solve',
      variables: { nums: [1, 2], seen: { __type__: 'map', entries: [[2, 0]] } },
      accesses: [{ variable: 'nums', kind: 'indexed-read', indices: [1], pathDepth: 1 }],
    },
  ]));

  assertPublicV4Trace('javascript adapter boundary', result);
  assertCondition(
    result.trace.events.some((event) => event.kind === 'read' && event.line === 4),
    'javascript boundary should expose indexed reads as V4 read events'
  );
  assertCondition(
    !JSON.stringify(result.trace.events).includes('visualization'),
    'javascript V4 trace must not leak legacy visualization payloads'
  );
  console.log('PASS: JavaScript adapter boundary returns V4 only');
}

function testPythonBoundaryReturnsV4(): void {
  const result = adaptPythonTraceExecutionResult(makeLegacyTraceResult([
    {
      line: 7,
      event: 'line',
      function: 'solve',
      variables: { dp: [[0, 1]] },
      accesses: [{ variable: 'dp', kind: 'cell-write', indices: [0, 1], pathDepth: 2 }],
    },
  ]));

  assertPublicV4Trace('python adapter boundary', result);
  assertCondition(
    result.trace.events.some((event) => event.kind === 'write' && event.line === 7),
    'python boundary should expose cell writes as V4 write events'
  );
  console.log('PASS: Python adapter boundary returns V4 only');
}

function testJavaBoundaryReturnsV4(): void {
  const trace = javaTraceHooksEventsToV4Trace([
    `v4:${JSON.stringify({ kind: 'call', line: 4, function: 'solve', args: { nums: [1, 2] } })}`,
    `v4:${JSON.stringify({ kind: 'snapshot', line: 4, target: { variable: 'nums' }, value: [1, 2] })}`,
    `v4:${JSON.stringify({ kind: 'line', line: 5, function: 'solve' })}`,
    `v4:${JSON.stringify({ kind: 'snapshot', line: 5, target: { variable: 'nums' }, value: [1, 2] })}`,
    `v4:${JSON.stringify({ kind: 'read', line: 5, target: { variable: 'nums', path: [1] }, value: 2 })}`,
    `v4:${JSON.stringify({ kind: 'return', line: 6, function: 'solve', value: 2 })}`,
  ], undefined, { runId: 'java:test', file: 'Solution.java' });
  const result = { trace };

  assertPublicV4Trace('java TraceHooks boundary', result);
  assertCondition(
    result.trace.events.some((event) => event.kind === 'read' && event.line === 5),
    'java TraceHooks boundary should expose Java access events as V4 read events'
  );
  console.log('PASS: Java TraceHooks boundary returns V4 only');
}

function main(): void {
  testJavaScriptBoundaryReturnsV4();
  testPythonBoundaryReturnsV4();
  testJavaBoundaryReturnsV4();
  console.log('\nTrace adapter boundary tests passed.');
}

main();
