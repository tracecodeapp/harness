#!/usr/bin/env npx tsx

import type { Language } from '../packages/harness-core/src/runtime-types';
import type { LegacyTraceExecutionResult, RawTraceStep } from '../packages/harness-core/src/types';
import { javaTraceHooksEventsToV4Trace } from '../packages/harness-core/src/trace-adapters/java';
import { normalizeRuntimeTraceContract } from '../packages/harness-core/src/trace-contract';
import {
  buildRuntimeV4ParitySignature,
  runtimeTraceContractToV4Events,
  type RuntimeV4Event,
  type RuntimeV4ParitySignature,
  type RuntimeV4Trace,
} from '../packages/harness-core/src/trace-v4';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',') + '}';
}

function makeExecutionResult(trace: RawTraceStep[]): LegacyTraceExecutionResult {
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

function traceFor(language: Language, trace: RawTraceStep[]): RuntimeV4Trace {
  return runtimeTraceContractToV4Events(
    normalizeRuntimeTraceContract(language, makeExecutionResult(trace)),
    { runId: `${language}:test`, file: `solution.${language === 'python' ? 'py' : language === 'java' ? 'java' : 'js'}` }
  );
}

function nativeJavaEvent(event: Omit<RuntimeV4Event, 'runId'>): string {
  return `v4:${JSON.stringify(event)}`;
}

function javaTrace(events: Array<Omit<RuntimeV4Event, 'runId'>>, sourceText?: string): RuntimeV4Trace {
  return javaTraceHooksEventsToV4Trace(
    events.map(nativeJavaEvent),
    sourceText,
    { runId: 'java:test', file: 'Solution.java' }
  );
}

function assertParity(
  name: string,
  traces: Record<string, RuntimeV4Trace>,
  expected: RuntimeV4ParitySignature
): void {
  const expectedString = stableStringify(expected);

  for (const [language, trace] of Object.entries(traces)) {
    const signature = buildRuntimeV4ParitySignature(trace);
    assertCondition(
      stableStringify(signature) === expectedString,
      `${name}: ${language} V4 signature drifted.\nExpected: ${expectedString}\nReceived: ${stableStringify(signature)}`
    );

    const serializedEvents = stableStringify(trace.events);
    assertCondition(
      !serializedEvents.includes('visualization') &&
        !serializedEvents.includes('objectKinds') &&
        !serializedEvents.includes('hashMaps') &&
        !serializedEvents.includes('graph-adjacency') &&
        !serializedEvents.includes('linked-list'),
      `${name}: ${language} V4 events should not expose legacy visualization classification`
    );
  }
}

function runIndexedReadParity(): void {
  const pyTrace: RawTraceStep[] = [
    {
      line: 2,
      event: 'line',
      function: 'solve',
      variables: { nums: [1, 2], i: 0 },
      accesses: [{ variable: 'nums', kind: 'indexed-read', indices: [0], pathDepth: 1 }],
    },
  ];

  assertParity(
    'indexed-read',
    {
      python: traceFor('python', pyTrace),
      javascript: traceFor('javascript', pyTrace),
      typescript: traceFor('typescript', pyTrace),
      java: javaTrace([
        { kind: 'line', line: 2, function: 'solve' },
        { kind: 'snapshot', line: 2, target: { variable: 'nums' }, value: [1, 2] },
        { kind: 'snapshot', line: 2, target: { variable: 'i' }, value: 0 },
        { kind: 'read', line: 2, target: { variable: 'nums', path: [0] }, value: 1 },
      ]),
    },
    {
      lineSequence: [2],
      eventKindsByLine: { 2: ['line', 'read', 'snapshot'] },
      variableSnapshotsByLine: { 2: ['i', 'nums'] },
      accessTargetsByLine: { 2: [{ kind: 'read', variable: 'nums', pathDepth: 1 }] },
      callReturnShape: [],
    }
  );
}

function runMatrixWriteParity(): void {
  const trace: RawTraceStep[] = [
    {
      line: 4,
      event: 'line',
      function: 'solve',
      variables: { grid: [[0, 1]], row: 0, col: 1 },
      accesses: [{ variable: 'grid', kind: 'cell-write', indices: [0, 1], pathDepth: 2 }],
    },
  ];

  assertParity(
    'matrix-write',
    {
      python: traceFor('python', trace),
      javascript: traceFor('javascript', trace),
      typescript: traceFor('typescript', trace),
      java: javaTrace([
        { kind: 'line', line: 4, function: 'solve' },
        { kind: 'snapshot', line: 4, target: { variable: 'grid' }, value: [[0, 1]] },
        { kind: 'snapshot', line: 4, target: { variable: 'row' }, value: 0 },
        { kind: 'snapshot', line: 4, target: { variable: 'col' }, value: 1 },
        { kind: 'write', line: 4, target: { variable: 'grid', path: [0, 1] }, value: 1 },
      ]),
    },
    {
      lineSequence: [4],
      eventKindsByLine: { 4: ['line', 'snapshot', 'write'] },
      variableSnapshotsByLine: { 4: ['col', 'grid', 'row'] },
      accessTargetsByLine: { 4: [{ kind: 'write', variable: 'grid', pathDepth: 2 }] },
      callReturnShape: [],
    }
  );
}

function runListAppendParity(): void {
  const pythonTrace: RawTraceStep[] = [
    {
      line: 3,
      event: 'line',
      function: 'solve',
      variables: { out: [1] },
      accesses: [{ variable: 'out', kind: 'mutating-call', method: 'append', pathDepth: 1 }],
    },
  ];
  const jsTrace: RawTraceStep[] = [
    {
      ...pythonTrace[0],
      accesses: [{ variable: 'out', kind: 'mutating-call', method: 'push', pathDepth: 1 }],
    },
  ];

  assertParity(
    'list-append',
    {
      python: traceFor('python', pythonTrace),
      javascript: traceFor('javascript', jsTrace),
      typescript: traceFor('typescript', jsTrace),
      java: javaTrace([
        { kind: 'line', line: 3, function: 'solve' },
        { kind: 'snapshot', line: 3, target: { variable: 'out' }, value: [] },
        { kind: 'mutate', line: 3, target: { variable: 'out' }, method: 'append' },
        { kind: 'snapshot', line: 3, target: { variable: 'out' }, value: [1] },
      ]),
    },
    {
      lineSequence: [3],
      eventKindsByLine: { 3: ['line', 'mutate', 'snapshot'] },
      variableSnapshotsByLine: { 3: ['out'] },
      accessTargetsByLine: { 3: [{ kind: 'mutate', variable: 'out', pathDepth: undefined, method: 'append' }] },
      callReturnShape: [],
    }
  );
}

function runMapSetParity(): void {
  const pythonTrace: RawTraceStep[] = [
    {
      line: 5,
      event: 'line',
      function: 'solve',
      variables: { seen: { __type__: 'map', entries: [[2, true]] } },
      accesses: [{ variable: 'seen', kind: 'mutating-call', method: 'set', pathDepth: 1 }],
    },
  ];

  assertParity(
    'map-set',
    {
      python: traceFor('python', pythonTrace),
      javascript: traceFor('javascript', pythonTrace),
      typescript: traceFor('typescript', pythonTrace),
      java: javaTrace([
        { kind: 'line', line: 5, function: 'solve' },
        { kind: 'mutate', line: 5, target: { variable: 'seen' }, method: 'set' },
        { kind: 'snapshot', line: 5, target: { variable: 'seen' }, value: { __type__: 'map', entries: [[2, true]] } },
      ]),
    },
    {
      lineSequence: [5],
      eventKindsByLine: { 5: ['line', 'mutate', 'snapshot'] },
      variableSnapshotsByLine: { 5: ['seen'] },
      accessTargetsByLine: { 5: [{ kind: 'mutate', variable: 'seen', pathDepth: undefined, method: 'set' }] },
      callReturnShape: [],
    }
  );
}

function runEarlyReturnParity(): void {
  const trace: RawTraceStep[] = [
    {
      line: 1,
      event: 'call',
      function: 'solve',
      variables: { n: 0 },
      callStack: [{ function: 'solve', line: 1, args: { n: 0 } }],
    },
    {
      line: 2,
      event: 'line',
      function: 'solve',
      variables: { n: 0 },
      callStack: [{ function: 'solve', line: 1, args: { n: 0 } }],
    },
    {
      line: 2,
      event: 'return',
      function: 'solve',
      variables: { n: 0 },
      callStack: [{ function: 'solve', line: 1, args: { n: 0 } }],
      returnValue: 0,
    },
  ];

  assertParity(
    'early-return',
    {
      python: traceFor('python', trace),
      javascript: traceFor('javascript', trace),
      typescript: traceFor('typescript', trace),
      java: javaTrace([
        { kind: 'call', line: 1, function: 'solve', args: { n: 0 } },
        { kind: 'snapshot', line: 1, target: { variable: 'n' }, value: 0 },
        { kind: 'line', line: 2, function: 'solve' },
        { kind: 'snapshot', line: 2, target: { variable: 'n' }, value: 0 },
        { kind: 'return', line: 2, function: 'solve', value: 0 },
      ]),
    },
    {
      lineSequence: [2],
      eventKindsByLine: { 1: ['call', 'snapshot'], 2: ['line', 'return', 'snapshot'] },
      variableSnapshotsByLine: { 1: ['n'], 2: ['n'] },
      accessTargetsByLine: {},
      callReturnShape: ['call', 'return'],
    }
  );
}

function main(): void {
  runIndexedReadParity();
  runMatrixWriteParity();
  runListAppendParity();
  runMapSetParity();
  runEarlyReturnParity();
  console.log('PASS: Runtime V4 parity gate draft');
}

main();
