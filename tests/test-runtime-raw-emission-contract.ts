#!/usr/bin/env npx tsx

import { javaTraceHooksEventsToRuntimeTrace } from '../packages/runtime-contracts/src/trace-adapters/java';
import {
  assertNoSameLineMicroFrames,
  assertSupportedRawEmissions,
  compareRawEmissionParity,
  summarizeJavaRawEmissions,
  summarizeRuntimeTraceEmissions,
} from '../packages/runtime-contracts/src/runtime-raw-emission-contract';
import { RUNTIME_TRACE_SCHEMA_VERSION, type RuntimeTrace } from '../packages/runtime-contracts/src/runtime-trace';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => unknown, pattern: RegExp, message: string): void {
  try {
    fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assertCondition(pattern.test(text), `${message}: unexpected error ${text}`);
    return;
  }
  throw new Error(`${message}: expected throw`);
}

function trace(language: RuntimeTrace['language'], events: RuntimeTrace['events']): RuntimeTrace {
  return {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language,
    runId: `${language}:test`,
    events,
    lineEventCount: events.filter((event) => event.kind === 'line').length,
    traceStepCount: events.length,
  };
}

function testJavaUnknownPayloadRejection(): void {
  const summary = summarizeJavaRawEmissions([
    'line=2 call solve nums=[1,2,3]',
    'line=3 array-length nums=3',
  ]);
  assertCondition(summary.unsupported.length === 2, 'raw contract should reject unsupported Java line payloads');
  assertThrows(
    () => assertSupportedRawEmissions(summary, 'java:test'),
    /line=2 call solve/,
    'raw contract should reject unsupported Java payloads'
  );
  assertThrows(
    () => javaTraceHooksEventsToRuntimeTrace(['line=3 array-length nums=3']),
    /unsupported raw runtime payloads/,
    'java TraceHooks assembly should reject unsupported raw payloads'
  );
  console.log('PASS: raw emission contract rejects unsupported Java payloads');
}

function testJavaKnownPayloads(): void {
  const summary = summarizeJavaRawEmissions([
    `trace:${JSON.stringify({ kind: 'call', line: 2, function: 'solve', args: { nums: [1, 2, 3] } })}`,
    `trace:${JSON.stringify({ kind: 'line', line: 3, function: 'solve' })}`,
    `trace:${JSON.stringify({ kind: 'snapshot', line: 3, target: { variable: 'nums' }, value: [1, 2, 3] })}`,
    `trace:${JSON.stringify({ kind: 'read', line: 4, target: { variable: 'nums', path: [0] }, value: 1 })}`,
    `trace:${JSON.stringify({ kind: 'write', line: 5, target: { variable: 'nums', path: [1] }, value: 4 })}`,
    `trace:${JSON.stringify({ kind: 'mutate', line: 6, target: { variable: 'out' }, method: 'append' })}`,
    `trace:${JSON.stringify({ kind: 'stdout', line: 9, text: 'ok' })}`,
    `trace:${JSON.stringify({ kind: 'exception', line: 10, message: 'boom' })}`,
    `trace:${JSON.stringify({ kind: 'timeout', line: 10, message: 'budget exceeded' })}`,
    `trace:${JSON.stringify({ kind: 'return', line: 11, function: 'solve', value: 1 })}`,
  ]);
  assertSupportedRawEmissions(summary, 'java:known');
  assertCondition(summary.unsupported.length === 0, 'known Java payloads should be supported');
  console.log('PASS: raw emission contract accepts known Java payloads');
}

function testForbiddenRuntimeTracePayloadRejection(): void {
  const traceWithVisualization = trace('python', [
    {
      kind: 'snapshot',
      runId: 'python:test',
      line: 1,
      target: { variable: 'state' },
      value: { visualization: { objectKinds: { state: 'tree' }, hashMaps: [] } },
    },
  ]);
  const traceSummary = summarizeRuntimeTraceEmissions(traceWithVisualization);
  assertCondition(
    traceSummary.unsupported.length === 1 &&
      traceSummary.unsupported[0]?.includes('visualization') &&
      traceSummary.unsupported[0]?.includes('objectKinds') &&
      traceSummary.unsupported[0]?.includes('hashMaps'),
    'runtime trace summary should reject visualizer/semantic payload tokens'
  );
  assertThrows(
    () => assertSupportedRawEmissions(traceSummary, 'python:semantic-leak'),
    /forbidden runtime trace token.*visualization.*objectKinds.*hashMaps/s,
    'raw contract should reject runtime trace visualizer payloads'
  );

  const javaSummary = summarizeJavaRawEmissions([
    `trace:${JSON.stringify({
      kind: 'snapshot',
      line: 2,
      target: { variable: 'graph' },
      value: { kind: 'graph-adjacency', next: 'linked-list' },
    })}`,
  ]);
  assertCondition(
    javaSummary.unsupported.length === 1 &&
      javaSummary.unsupported[0]?.includes('graph-adjacency') &&
      javaSummary.unsupported[0]?.includes('linked-list'),
    'Java raw summary should reject forbidden semantic payload tokens inside native trace events'
  );
  assertThrows(
    () => javaTraceHooksEventsToRuntimeTrace([
      `trace:${JSON.stringify({
        kind: 'snapshot',
        line: 2,
        target: { variable: 'graph' },
        value: { kind: 'graph-adjacency' },
      })}`,
    ]),
    /forbidden runtime trace token.*graph-adjacency/s,
    'java TraceHooks assembly should reject semantic payload tokens inside native trace events'
  );
  const userTargetSummary = summarizeJavaRawEmissions([
    `trace:${JSON.stringify({
      kind: 'read',
      line: 3,
      target: { variable: 'tree', path: ['tree'] },
      value: 1,
    })}`,
  ]);
  assertCondition(
    userTargetSummary.unsupported.length === 0,
    'raw contract should not reject user target names that match semantic tokens'
  );
  const userFunctionSummary = summarizeJavaRawEmissions([
    `trace:${JSON.stringify({
      kind: 'call',
      line: 4,
      function: 'tree',
      args: {},
    })}`,
  ]);
  assertCondition(
    userFunctionSummary.unsupported.length === 0,
    'raw contract should not reject user function names that match semantic tokens'
  );
  const userValueSummary = summarizeJavaRawEmissions([
    `trace:${JSON.stringify({
      kind: 'snapshot',
      line: 5,
      target: { variable: 'words' },
      value: ['tree', 'linked-list', 'graph-adjacency'],
    })}`,
  ]);
  assertCondition(
    userValueSummary.unsupported.length === 0,
    'raw contract should not reject ordinary user string values that match semantic tokens'
  );
  const userTreeFieldSummary = summarizeJavaRawEmissions([
    `trace:${JSON.stringify({
      kind: 'snapshot',
      line: 5,
      target: { variable: 'segmentTree' },
      value: { tree: [1, 2, 3], size: 3 },
    })}`,
  ]);
  assertCondition(
    userTreeFieldSummary.unsupported.length === 0,
    'raw contract should not reject ordinary user object fields named tree'
  );
  const userArgSummary = summarizeJavaRawEmissions([
    `trace:${JSON.stringify({
      kind: 'call',
      line: 6,
      function: 'solve',
      args: { tree: [1, 2], 'linked-list': 'value' },
    })}`,
  ]);
  assertCondition(
    userArgSummary.unsupported.length === 0,
    'raw contract should not reject user argument names that match semantic tokens'
  );
  console.log('PASS: raw emission contract rejects visualizer and semantic runtime payload leaks');
}

function testCppKnownRuntimeTracePayloads(): void {
  const cppTrace = trace('cpp', [
    {
      kind: 'call',
      runId: 'cpp:test',
      line: 3,
      function: 'solve',
      args: {
        head: {
          __type__: 'ListNode',
          __id__: 'ref-0',
          val: 1,
          next: { __ref__: 'ref-0' },
        },
      },
    },
    { kind: 'line', runId: 'cpp:test', line: 4, function: 'solve' },
    {
      kind: 'snapshot',
      runId: 'cpp:test',
      line: 5,
      target: { variable: 'adjacency' },
      value: [[1, 2], [2], []],
    },
    { kind: 'read', runId: 'cpp:test', line: 6, target: { variable: 'adjacency', path: [0], indexSources: ['node'] }, value: [1, 2] },
    { kind: 'mutate', runId: 'cpp:test', line: 7, target: { variable: 'adjacency', path: [1], indexSources: [null] }, method: 'push_back' },
    { kind: 'write', runId: 'cpp:test', line: 8, target: { variable: 'distance', path: [2], indexSources: ['neighbor'] }, value: 3 },
    { kind: 'stdout', runId: 'cpp:test', text: 'ok' },
    {
      kind: 'return',
      runId: 'cpp:test',
      line: 9,
      function: 'solve',
      value: {
        __type__: 'TreeNode',
        __id__: 'ref-0',
        val: 1,
        left: { __type__: 'TreeNode', __id__: 'ref-1', val: 2, left: null, right: null },
        right: { __ref__: 'ref-1' },
      },
    },
    { kind: 'timeout', runId: 'cpp:test', message: 'C++ trace budget exceeded' },
  ]);

  const summary = summarizeRuntimeTraceEmissions(cppTrace);
  assertSupportedRawEmissions(summary, 'cpp:known');
  assertCondition(summary.unsupported.length === 0, 'known C++ runtime trace payloads should be supported');
  for (const kind of ['call', 'line', 'snapshot', 'read', 'write', 'mutate', 'stdout', 'return', 'timeout'] as const) {
    assertCondition(summary.kinds.includes(kind), `C++ raw summary should include ${kind}`);
  }
  console.log('PASS: raw emission contract accepts C++ generic runtime trace payloads');
}

function testRuntimeTraceIndexSourceProvenancePayloads(): void {
  const provenanceTrace = trace('python', [
    { kind: 'line', runId: 'python:test', line: 1, function: 'solve' },
    {
      kind: 'read',
      runId: 'python:test',
      line: 1,
      target: { variable: 'grid', path: [2, 3], indexSources: ['row', 'col'] },
      value: 7,
    },
    {
      kind: 'read',
      runId: 'python:test',
      line: 2,
      target: { variable: 'dp', path: [4], indexSources: [null] },
      value: 5,
    },
  ]);
  const summary = summarizeRuntimeTraceEmissions(provenanceTrace);
  assertSupportedRawEmissions(summary, 'python:index-sources');
  assertCondition(summary.unsupported.length === 0, 'runtime trace contract should accept indexSources provenance');

  const javaSummary = summarizeJavaRawEmissions([
    `trace:${JSON.stringify({
      kind: 'read',
      line: 3,
      target: { variable: 'nums', path: [1], indexSources: ['i'] },
      value: 2,
    })}`,
  ]);
  assertSupportedRawEmissions(javaSummary, 'java:index-sources');
  assertCondition(javaSummary.unsupported.length === 0, 'Java raw contract should accept target indexSources provenance');
  console.log('PASS: raw emission contract accepts indexed source provenance');
}

function testUnsupportedRuntimeTraceKindRejection(): void {
  const summary = summarizeRuntimeTraceEmissions(trace('cpp', [
    { kind: 'line', runId: 'cpp:test', line: 1 },
    { kind: 'control', runId: 'cpp:test', line: 2, control: 'continue' } as unknown as RuntimeTrace['events'][number],
  ]));
  assertCondition(
    summary.unsupported.length === 1 && summary.unsupported[0]?.includes('unsupported kind "control"'),
    'raw contract should reject unsupported runtime trace event kinds'
  );
  assertThrows(
    () => assertSupportedRawEmissions(summary, 'cpp:unsupported-kind'),
    /unsupported kind "control"/,
    'raw contract should reject C++ control events'
  );
  console.log('PASS: raw emission contract rejects unsupported runtime trace kinds');
}

function testRawParityComparison(): void {
  const pythonTrace = trace('python', [
    { kind: 'line', runId: 'python:test', line: 1, function: 'solve' },
    { kind: 'snapshot', runId: 'python:test', line: 1, target: { variable: 'nums' }, value: [1, 2, 3] },
    { kind: 'read', runId: 'python:test', line: 1, target: { variable: 'nums', path: [0] }, value: 1 },
  ]);
  const jsTrace = trace('javascript', [
    { kind: 'line', runId: 'javascript:test', line: 1, function: 'solve' },
    { kind: 'snapshot', runId: 'javascript:test', line: 1, target: { variable: 'nums' }, value: [1, 2, 3] },
  ]);
  const mismatches = compareRawEmissionParity(
    summarizeRuntimeTraceEmissions(pythonTrace),
    [summarizeRuntimeTraceEmissions(pythonTrace), summarizeRuntimeTraceEmissions(jsTrace)]
  );
  assertCondition(
    mismatches.length === 1 && mismatches[0]?.language === 'javascript' && mismatches[0]?.missing.includes('read'),
    'raw parity comparison should report missing trace emission categories'
  );
  console.log('PASS: raw emission parity comparison reports category mismatches');
}

function testSameLineMicroFrameRejection(): void {
  const splitFrameTrace = trace('csharp', [
    { kind: 'line', runId: 'csharp:test', file: 'solution.cs', line: 4, function: 'Solve' },
    { kind: 'line', runId: 'csharp:test', file: 'solution.cs', line: 4, function: 'Solve' },
    { kind: 'read', runId: 'csharp:test', file: 'solution.cs', line: 4, target: { variable: 'nums', path: [0] }, value: 1 },
  ]);
  assertThrows(
    () => assertNoSameLineMicroFrames(splitFrameTrace, 'csharp:split-frame'),
    /same-line microframe.*line 4 at events 0->1/s,
    'raw contract should reject line-only same-line microframes'
  );

  const repeatedVisitTrace = trace('csharp', [
    { kind: 'line', runId: 'csharp:test', file: 'solution.cs', line: 4, function: 'Solve' },
    { kind: 'read', runId: 'csharp:test', file: 'solution.cs', line: 4, target: { variable: 'nums', path: [0] }, value: 1 },
    { kind: 'line', runId: 'csharp:test', file: 'solution.cs', line: 4, function: 'Solve' },
    { kind: 'read', runId: 'csharp:test', file: 'solution.cs', line: 4, target: { variable: 'nums', path: [1] }, value: 2 },
  ]);
  assertNoSameLineMicroFrames(repeatedVisitTrace, 'csharp:repeated-visit');
  console.log('PASS: raw emission contract rejects same-line microframes without rejecting repeated line visits');
}

testJavaUnknownPayloadRejection();
testJavaKnownPayloads();
testForbiddenRuntimeTracePayloadRejection();
testCppKnownRuntimeTracePayloads();
testRuntimeTraceIndexSourceProvenancePayloads();
testUnsupportedRuntimeTraceKindRejection();
testRawParityComparison();
testSameLineMicroFrameRejection();

console.log('\nRuntime raw emission contract tests passed.');
