#!/usr/bin/env npx tsx

import { javaTraceHooksEventsToV4Trace } from '../packages/harness-core/src/trace-adapters/java';
import {
  assertSupportedRawEmissions,
  compareRawEmissionParity,
  summarizeJavaRawEmissions,
  summarizeRawTraceEmissions,
} from '../packages/harness-core/src/runtime-raw-emission-contract';
import type { RawTraceStep } from '../packages/harness-core/src/types';

function assertCondition(condition: boolean, message: string): void {
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

function testJavaUnknownPayloadRejection(): void {
  const summary = summarizeJavaRawEmissions([
    'line=2 call solve nums=[1,2,3]',
    'line=3 array-length nums=3',
  ]);
  assertCondition(summary.unsupported.length === 2, 'raw contract should reject legacy Java line payloads');
  assertThrows(
    () => assertSupportedRawEmissions(summary, 'java:test'),
    /line=2 call solve/,
    'raw contract should reject legacy Java payloads'
  );
  assertThrows(
    () => javaTraceHooksEventsToV4Trace(['line=3 array-length nums=3']),
    /unsupported raw runtime payloads/,
    'java TraceHooks V4 assembly should reject legacy raw payloads'
  );
  console.log('PASS: raw emission contract rejects unsupported Java payloads');
}

function testJavaKnownPayloads(): void {
  const summary = summarizeJavaRawEmissions([
    `v4:${JSON.stringify({ kind: 'call', line: 2, function: 'solve', args: { nums: [1, 2, 3] } })}`,
    `v4:${JSON.stringify({ kind: 'line', line: 3, function: 'solve' })}`,
    `v4:${JSON.stringify({ kind: 'snapshot', line: 3, target: { variable: 'nums' }, value: [1, 2, 3] })}`,
    `v4:${JSON.stringify({ kind: 'read', line: 4, target: { variable: 'nums', path: [0] }, value: 1 })}`,
    `v4:${JSON.stringify({ kind: 'write', line: 5, target: { variable: 'nums', path: [1] }, value: 4 })}`,
    `v4:${JSON.stringify({ kind: 'mutate', line: 6, target: { variable: 'out' }, method: 'append' })}`,
    `v4:${JSON.stringify({ kind: 'stdout', line: 9, text: 'ok' })}`,
    `v4:${JSON.stringify({ kind: 'exception', line: 10, message: 'boom' })}`,
    `v4:${JSON.stringify({ kind: 'return', line: 11, function: 'solve', value: 1 })}`,
  ]);
  assertSupportedRawEmissions(summary, 'java:known');
  assertCondition(summary.unsupported.length === 0, 'known Java payloads should be supported');
  console.log('PASS: raw emission contract accepts known Java payloads');
}

function testRawParityComparison(): void {
  const pythonTrace: RawTraceStep[] = [{
    line: 1,
    event: 'line',
    function: 'solve',
    variables: { nums: [1, 2, 3] },
    accesses: [{ variable: 'nums', kind: 'indexed-read', indices: [0], pathDepth: 1 }],
  }];
  const jsTrace: RawTraceStep[] = [{
    line: 1,
    event: 'line',
    function: 'solve',
    variables: { nums: [1, 2, 3] },
  }];
  const mismatches = compareRawEmissionParity(
    summarizeRawTraceEmissions('python', pythonTrace),
    [summarizeRawTraceEmissions('python', pythonTrace), summarizeRawTraceEmissions('javascript', jsTrace)]
  );
  assertCondition(
    mismatches.length === 1 && mismatches[0]?.language === 'javascript' && mismatches[0]?.missing.includes('read'),
    'raw parity comparison should report missing V4-relevant emission categories'
  );
  console.log('PASS: raw emission parity comparison reports category mismatches');
}

testJavaUnknownPayloadRejection();
testJavaKnownPayloads();
testRawParityComparison();

console.log('\nRuntime raw emission contract tests passed.');
