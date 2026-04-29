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
  assertCondition(summary.unsupported.length === 1, 'raw contract should classify array-length as unsupported');
  assertThrows(
    () => assertSupportedRawEmissions(summary, 'java:test'),
    /array-length nums=3/,
    'raw contract should reject unsupported array-length payloads'
  );
  assertThrows(
    () => javaTraceHooksEventsToV4Trace(['line=3 array-length nums=3']),
    /unsupported raw runtime payloads/,
    'java TraceHooks V4 assembly should reject unsupported raw payloads before normalization'
  );
  console.log('PASS: raw emission contract rejects unsupported Java payloads');
}

function testJavaKnownPayloads(): void {
  const summary = summarizeJavaRawEmissions([
    'line=2 call solve nums=[1,2,3]',
    'line=3 nums=[1,2,3]',
    'line=4 access nums[0]=1',
    'line=5 write-array nums[1]=4',
    'line=6 mutate out method=add',
    'line=7 keyed-call seen method=put key=1 value=true',
    'line=8 map-state seen={"name":"seen","kind":"map","entries":[]}',
    'line=9 stdout "ok"',
    'line=10 exception "boom"',
    'line=11 return solve value=1',
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
