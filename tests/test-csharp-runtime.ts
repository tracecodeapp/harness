#!/usr/bin/env npx tsx

import { createCSharpRuntimeClient } from '../packages/harness-browser/src/csharp-runtime-client';
import type { CSharpExecutionStyle, CSharpWorkerClient } from '../packages/harness-browser/src/csharp-worker-client';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  type RuntimeTraceEvent,
} from '../packages/harness-core/src/runtime-trace';
import type { RuntimeExecutionStyle } from '../packages/harness-core/src/runtime-types';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectRejects(
  fn: () => Promise<unknown>,
  expectedMessage: string
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }

  assertCondition(thrown instanceof Error, `Expected error containing "${expectedMessage}"`);
  assertCondition(
    String((thrown as Error).message).includes(expectedMessage),
    `Expected error containing "${expectedMessage}", received "${String((thrown as Error).message)}"`
  );
}

async function main(): Promise<void> {
  const calls: Array<{ method: string; executionStyle?: CSharpExecutionStyle }> = [];
  const traceEvents: RuntimeTraceEvent[] = [
    { kind: 'line', runId: 'csharp:run', file: 'UserCode.cs', line: 3 },
    {
      kind: 'return',
      runId: 'csharp:run',
      file: 'UserCode.cs',
      function: 'Add',
      line: 4,
      value: 5,
    },
  ];

  const workerClient = {
    init: async () => ({ success: true, loadTimeMs: 1 }),
    executeCode: async (
      _code: string,
      functionName: string,
      _inputs: Record<string, unknown>,
      executionStyle: CSharpExecutionStyle
    ) => {
      calls.push({ method: 'executeCode', executionStyle });
      return {
        success: true,
        output: executionStyle === 'ops-class' ? [null, 3, 6] : `${functionName}:ok`,
        consoleOutput: [],
      };
    },
    executeWithTracing: async (
      _code: string,
      _functionName: string,
      _inputs: Record<string, unknown>,
      _options: unknown,
      executionStyle: CSharpExecutionStyle
    ) => {
      calls.push({ method: 'executeWithTracing', executionStyle });
      return {
        success: true,
        output: 5,
        trace: {
          schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
          language: 'csharp',
          runId: 'csharp:run',
          events: traceEvents,
          lineEventCount: 1,
          traceStepCount: 2,
        },
        executionTimeMs: 2,
        consoleOutput: [],
        lineEventCount: 1,
        traceStepCount: 2,
      };
    },
  };

  const client = createCSharpRuntimeClient(workerClient as unknown as CSharpWorkerClient);
  const init = await client.init();
  assertCondition(init.success && init.loadTimeMs === 1, 'C# runtime client should expose init result');

  const solutionResult = await client.executeCode(
    'public class Solution { public int Add(int a, int b) => a + b; }',
    'Add',
    { a: 2, b: 3 },
    'solution-method'
  );
  assertCondition(solutionResult.success, 'C# solution-method executeCode should succeed');
  assertCondition(solutionResult.output === 'Add:ok', 'C# solution-method executeCode should preserve output');

  const traceResult = await client.executeWithTracing(
    'public class Solution { public int Add(int a, int b) { return a + b; } }',
    'Add',
    { a: 2, b: 3 },
    { maxTraceSteps: 20 },
    'solution-method'
  );
  assertCondition(traceResult.success, 'C# executeWithTracing should succeed');
  assertCondition(traceResult.trace.language === 'csharp', 'C# executeWithTracing should return a C# runtime trace');
  assertCondition(traceResult.lineEventCount === 1, 'C# executeWithTracing should preserve line event counts');
  assertCondition(traceResult.traceStepCount === 2, 'C# executeWithTracing should preserve trace step counts');

  const opsResult = await client.executeCode(
    'public class Counter { public Counter(int start) {} public int Inc(int delta) => delta; }',
    'Counter',
    { operations: ['Counter', 'Inc', 'Inc'], arguments: [[1], [3], [6]] },
    'ops-class'
  );
  assertCondition(opsResult.success, 'C# ops-class executeCode should succeed');
  assertCondition(
    JSON.stringify(opsResult.output) === JSON.stringify([null, 3, 6]),
    `C# ops-class executeCode should preserve the operation-output array, received ${JSON.stringify(opsResult.output)}`
  );

  await expectRejects(
    () => client.executeCode('int Add(int a, int b) => a + b;', 'Add', { a: 2, b: 3 }, 'function'),
    'does not support execution style "function"'
  );
  await expectRejects(
    () => client.executeWithTracing('result = 1;', null, {}, undefined, 'function'),
    'does not support execution style "function"'
  );
  await expectRejects(
    () => client.executeCodeInterviewMode('', 'Add', {}, 'solution-method' as RuntimeExecutionStyle),
    'does not support interview execution'
  );

  assertCondition(
    calls.some((call) => call.method === 'executeCode' && call.executionStyle === 'solution-method'),
    'C# runtime client should route solution-method executeCode'
  );
  assertCondition(
    calls.some((call) => call.method === 'executeWithTracing' && call.executionStyle === 'solution-method'),
    'C# runtime client should route solution-method executeWithTracing'
  );
  assertCondition(
    calls.some((call) => call.method === 'executeCode' && call.executionStyle === 'ops-class'),
    'C# runtime client should route ops-class executeCode'
  );

  console.log('PASS: C# runtime client API contract');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
