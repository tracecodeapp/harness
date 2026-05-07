#!/usr/bin/env npx tsx

import { javaTraceHooksEventsToRuntimeTrace } from '../packages/harness-core/src/trace-adapters/java';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  buildRuntimeTraceParitySignature,
  type RuntimeTraceEvent,
  type RuntimeTraceParitySignature,
  type RuntimeTrace,
} from '../packages/harness-core/src/runtime-trace';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',') + '}';
}

function trace(language: RuntimeTrace['language'], events: Array<Omit<RuntimeTraceEvent, 'runId'>>): RuntimeTrace {
  const runId = `${language}:test`;
  return {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language,
    runId,
    events: events.map((event) => ({ ...event, runId, file: `solution.${language === 'python' ? 'py' : language === 'java' ? 'java' : 'js'}` })),
    lineEventCount: events.filter((event) => event.kind === 'line').length,
    traceStepCount: events.length,
  };
}

function nativeJavaEvent(event: Omit<RuntimeTraceEvent, 'runId'>): string {
  return `trace:${JSON.stringify(event)}`;
}

function javaTrace(events: Array<Omit<RuntimeTraceEvent, 'runId'>>, sourceText?: string): RuntimeTrace {
  return javaTraceHooksEventsToRuntimeTrace(events.map(nativeJavaEvent), sourceText, { runId: 'java:test', file: 'solution.java' });
}

function assertParity(name: string, traces: Record<string, RuntimeTrace>, expected: RuntimeTraceParitySignature): void {
  const expectedString = stableStringify(expected);
  for (const [language, runtimeTrace] of Object.entries(traces)) {
    const signature = buildRuntimeTraceParitySignature(runtimeTrace);
    assertCondition(
      stableStringify(signature) === expectedString,
      `${name}: ${language} trace signature drifted.\nExpected: ${expectedString}\nReceived: ${stableStringify(signature)}`
    );
    const serializedEvents = stableStringify(runtimeTrace.events);
    assertCondition(
      !serializedEvents.includes('visualization') &&
        !serializedEvents.includes('objectKinds') &&
        !serializedEvents.includes('hashMaps') &&
        !serializedEvents.includes('graph-adjacency') &&
        !serializedEvents.includes('linked-list'),
      `${name}: ${language} trace events should not expose visualization classification`
    );
  }
}

function runIndexedReadParity(): void {
  const events: Array<Omit<RuntimeTraceEvent, 'runId'>> = [
    { kind: 'line', line: 2, function: 'solve' },
    { kind: 'snapshot', line: 2, target: { variable: 'nums' }, value: [1, 2] },
    { kind: 'snapshot', line: 2, target: { variable: 'i' }, value: 0 },
    { kind: 'read', line: 2, target: { variable: 'nums', path: [0] }, value: 1 },
  ];
  assertParity('indexed-read', { python: trace('python', events), javascript: trace('javascript', events), typescript: trace('typescript', events), java: javaTrace(events) }, {
    lineSequence: [2],
    eventKindsByLine: { 2: ['line', 'read', 'snapshot'] },
    variableSnapshotsByLine: { 2: ['i', 'nums'] },
    accessTargetsByLine: { 2: [{ kind: 'read', variable: 'nums', pathDepth: 1 }] },
    callReturnShape: [],
  });
}

function runMatrixWriteParity(): void {
  const events: Array<Omit<RuntimeTraceEvent, 'runId'>> = [
    { kind: 'line', line: 4, function: 'solve' },
    { kind: 'snapshot', line: 4, target: { variable: 'grid' }, value: [[0, 1]] },
    { kind: 'snapshot', line: 4, target: { variable: 'row' }, value: 0 },
    { kind: 'snapshot', line: 4, target: { variable: 'col' }, value: 1 },
    { kind: 'write', line: 4, target: { variable: 'grid', path: [0, 1] }, value: 1 },
  ];
  assertParity('matrix-write', { python: trace('python', events), javascript: trace('javascript', events), typescript: trace('typescript', events), java: javaTrace(events) }, {
    lineSequence: [4],
    eventKindsByLine: { 4: ['line', 'snapshot', 'write'] },
    variableSnapshotsByLine: { 4: ['col', 'grid', 'row'] },
    accessTargetsByLine: { 4: [{ kind: 'write', variable: 'grid', pathDepth: 2 }] },
    callReturnShape: [],
  });
}

function runListAppendParity(): void {
  const common = [
    { kind: 'line', line: 3, function: 'solve' },
    { kind: 'snapshot', line: 3, target: { variable: 'out' }, value: [1] },
    { kind: 'mutate', line: 3, target: { variable: 'out' }, method: 'append' },
  ] satisfies Array<Omit<RuntimeTraceEvent, 'runId'>>;
  const javaEvents = [
    { kind: 'line', line: 3, function: 'solve' },
    { kind: 'snapshot', line: 3, target: { variable: 'out' }, value: [] },
    { kind: 'mutate', line: 3, target: { variable: 'out' }, method: 'append' },
    { kind: 'snapshot', line: 3, target: { variable: 'out' }, value: [1] },
  ] satisfies Array<Omit<RuntimeTraceEvent, 'runId'>>;
  assertParity('list-append', { python: trace('python', common), javascript: trace('javascript', common), typescript: trace('typescript', common), java: javaTrace(javaEvents) }, {
    lineSequence: [3],
    eventKindsByLine: { 3: ['line', 'mutate', 'snapshot'] },
    variableSnapshotsByLine: { 3: ['out'] },
    accessTargetsByLine: { 3: [{ kind: 'mutate', variable: 'out', pathDepth: undefined }] },
    callReturnShape: [],
  });
}

function runMapSetParity(): void {
  const events: Array<Omit<RuntimeTraceEvent, 'runId'>> = [
    { kind: 'line', line: 5, function: 'solve' },
    { kind: 'mutate', line: 5, target: { variable: 'seen' }, method: 'set' },
    { kind: 'snapshot', line: 5, target: { variable: 'seen' }, value: { __type__: 'map', entries: [[2, true]] } },
  ];
  assertParity('map-set', { python: trace('python', events), javascript: trace('javascript', events), typescript: trace('typescript', events), java: javaTrace(events) }, {
    lineSequence: [5],
    eventKindsByLine: { 5: ['line', 'mutate', 'snapshot'] },
    variableSnapshotsByLine: { 5: ['seen'] },
    accessTargetsByLine: { 5: [{ kind: 'mutate', variable: 'seen', pathDepth: undefined }] },
    callReturnShape: [],
  });
}

function runEarlyReturnParity(): void {
  const events: Array<Omit<RuntimeTraceEvent, 'runId'>> = [
    { kind: 'call', line: 1, function: 'solve', args: { n: 0 } },
    { kind: 'snapshot', line: 1, target: { variable: 'n' }, value: 0 },
    { kind: 'line', line: 2, function: 'solve' },
    { kind: 'snapshot', line: 2, target: { variable: 'n' }, value: 0 },
    { kind: 'return', line: 2, function: 'solve', value: 0 },
  ];
  assertParity('early-return', { python: trace('python', events), javascript: trace('javascript', events), typescript: trace('typescript', events), java: javaTrace(events) }, {
    lineSequence: [2],
    eventKindsByLine: { 1: ['call', 'snapshot'], 2: ['line', 'return', 'snapshot'] },
    variableSnapshotsByLine: { 1: ['n'], 2: ['n'] },
    accessTargetsByLine: {},
    callReturnShape: ['call', 'return'],
  });
}

function main(): void {
  runIndexedReadParity();
  runMatrixWriteParity();
  runListAppendParity();
  runMapSetParity();
  runEarlyReturnParity();
  console.log('PASS: Runtime trace parity gate');
}

main();
