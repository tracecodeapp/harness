#!/usr/bin/env npx tsx

import { javaTraceHooksEventsToV4Trace } from '../packages/harness-core/src/trace-adapters/java';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertRuntimeTrace(label: string, result: { trace: unknown }): void {
  const trace = result.trace as { events?: unknown[]; schemaVersion?: unknown };
  assertCondition(!Array.isArray(result.trace), `${label} must not expose trace step arrays`);
  assertCondition(Array.isArray(trace.events), `${label} must expose trace.events`);
  assertCondition(trace.schemaVersion === 'v4-draft-2026-04-28', `${label} must expose the runtime trace schema version`);
}

function testJavaTraceHooksBoundaryReturnsTrace(): void {
  const trace = javaTraceHooksEventsToV4Trace([
    `v4:${JSON.stringify({ kind: 'call', line: 4, function: 'solve', args: { nums: [1, 2] } })}`,
    `v4:${JSON.stringify({ kind: 'snapshot', line: 4, target: { variable: 'nums' }, value: [1, 2] })}`,
    `v4:${JSON.stringify({ kind: 'line', line: 5, function: 'solve' })}`,
    `v4:${JSON.stringify({ kind: 'snapshot', line: 5, target: { variable: 'nums' }, value: [1, 2] })}`,
    `v4:${JSON.stringify({ kind: 'read', line: 5, target: { variable: 'nums', path: [1] }, value: 2 })}`,
    `v4:${JSON.stringify({ kind: 'return', line: 6, function: 'solve', value: 2 })}`,
  ], undefined, { runId: 'java:test', file: 'Solution.java' });
  const result = { trace };

  assertRuntimeTrace('java TraceHooks boundary', result);
  assertCondition(
    result.trace.events.some((event) => event.kind === 'read' && event.line === 5),
    'java TraceHooks boundary should expose Java access events as read events'
  );
  console.log('PASS: Java TraceHooks boundary returns runtime trace events');
}

function main(): void {
  testJavaTraceHooksBoundaryReturnsTrace();
  console.log('\nTrace boundary tests passed.');
}

main();
