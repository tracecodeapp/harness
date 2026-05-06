#!/usr/bin/env npx tsx

import { createCSharpRuntimeClient } from '../packages/harness-browser/src/csharp-runtime-client';
import {
  CSharpWorkerClient,
  type CSharpDiagnostic,
  type CSharpExecutionStyle,
} from '../packages/harness-browser/src/csharp-worker-client';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  type RuntimeTraceEvent,
} from '../packages/harness-core/src/runtime-trace';
import type { RuntimeExecutionStyle } from '../packages/harness-core/src/runtime-types';
import type { ExecutionResult } from '../packages/harness-core/src/types';

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

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

interface MockCSharpWorkerRawResult {
  success: boolean;
  output?: unknown;
  error?: string;
  diagnostics?: CSharpDiagnostic[];
  consoleOutput?: string[];
  events?: RuntimeTraceEvent[];
  executionTimeMs?: number;
  traceLimitExceeded?: boolean;
  timeoutReason?: ExecutionResult['timeoutReason'];
}

class MockCSharpWorker {
  static responses: MockCSharpWorkerRawResult[] = [];
  static received: WorkerMessage[] = [];
  static instances: MockCSharpWorker[] = [];
  static hangingMessageTypes = new Set<string>();
  static erroringMessageTypes = new Set<string>();

  public onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public terminated = false;

  constructor(public readonly url: string | URL) {
    MockCSharpWorker.instances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent<WorkerMessage>);
    });
  }

  postMessage(message: WorkerMessage): void {
    MockCSharpWorker.received.push(message);
    queueMicrotask(() => {
      const { id, type } = message;
      if (type === 'init') {
        this.onmessage?.({
          data: { id, type, payload: { success: true, loadTimeMs: 1 } },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (MockCSharpWorker.hangingMessageTypes.has(type)) {
        return;
      }

      if (MockCSharpWorker.erroringMessageTypes.has(type)) {
        this.onerror?.({ message: `mock ${type} worker error` } as ErrorEvent);
        return;
      }

      const payload = MockCSharpWorker.responses.shift();
      if (!payload) {
        this.onmessage?.({
          data: { id, type: 'error', payload: { error: `No mock response for ${type}` } },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      this.onmessage?.({
        data: { id, type, payload },
      } as MessageEvent<WorkerMessage>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function testRuntimeAdapterContract(): Promise<void> {
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

async function testWorkerResultMapping(): Promise<void> {
  const originalWorker = globalThis.Worker;
  MockCSharpWorker.responses = [];
  MockCSharpWorker.received = [];
  MockCSharpWorker.instances = [];
  MockCSharpWorker.hangingMessageTypes = new Set<string>();
  MockCSharpWorker.erroringMessageTypes = new Set<string>();
  // @ts-expect-error test stub
  globalThis.Worker = MockCSharpWorker;

  try {
    const workerClient = new CSharpWorkerClient({
      workerUrl: '/workers/csharp-worker.js',
      assetBaseUrl: '/workers/vendor/csharp',
    });

    MockCSharpWorker.responses.push({
      success: false,
      error: "Cannot implicitly convert type 'string' to 'int'",
      diagnostics: [
        {
          file: 'TraceCodeDriver.cs',
          line: 8,
          column: 12,
          message: 'Internal driver error',
          severity: 'error',
          id: 'CS0000',
        },
        {
          file: 'UserCode.cs',
          line: 4,
          column: 16,
          message: "Cannot implicitly convert type 'string' to 'int'",
          severity: 'error',
          id: 'CS0029',
        },
      ],
      consoleOutput: ['before compile failure'],
      executionTimeMs: 7,
    });

    const compileFailure = await workerClient.executeCode(
      'public class Solution { public int Add(int a, int b) { return "nope"; } }',
      'Add',
      { a: 2, b: 3 },
      'solution-method'
    );
    assertCondition(!compileFailure.success, 'C# executeCode compile failure should return a failed result');
    assertCondition(compileFailure.errorLine === 4, 'C# executeCode should map UserCode.cs diagnostics to errorLine');
    assertCondition(
      compileFailure.consoleOutput?.[0] === 'before compile failure',
      'C# executeCode should preserve stdout on compile failure'
    );

    MockCSharpWorker.responses.push({
      success: false,
      error: 'Object reference not set to an instance of an object.',
      diagnostics: [
        {
          file: 'UserCode.cs',
          line: 6,
          column: 10,
          message: 'runtime mapped diagnostic',
          severity: 'error',
          id: 'TRACE',
        },
      ],
      consoleOutput: ['before runtime failure'],
      events: [
        { kind: 'line', runId: 'csharp:run', file: 'UserCode.cs', line: 6 },
        {
          kind: 'exception',
          runId: 'csharp:run',
          file: 'UserCode.cs',
          line: 6,
          message: 'Object reference not set to an instance of an object.',
        },
      ],
      executionTimeMs: 11,
    });

    const tracedFailure = await workerClient.executeWithTracing(
      'public class Solution { public int Crash() { throw new System.Exception(); } }',
      'Crash',
      {},
      { maxTraceSteps: 20 },
      'solution-method'
    );
    assertCondition(!tracedFailure.success, 'C# traced runtime failure should return a failed result');
    assertCondition(tracedFailure.errorLine === 6, 'C# traced failures should map UserCode.cs diagnostics to errorLine');
    assertCondition(tracedFailure.trace.language === 'csharp', 'C# traced failures should return a C# runtime trace');
    assertCondition(tracedFailure.lineEventCount === 1, 'C# traced failures should preserve line event count');
    assertCondition(
      tracedFailure.trace.events.some((event) => event.kind === 'stdout' && event.text === 'before runtime failure'),
      'C# traced failures should append stdout events to the runtime trace'
    );

    MockCSharpWorker.responses.push({
      success: true,
      output: 5,
      consoleOutput: [],
      events: [{ kind: 'line', runId: 'csharp:run', file: 'UserCode.cs', line: 3 }],
      executionTimeMs: 13,
      traceLimitExceeded: true,
      timeoutReason: 'trace-limit',
    });

    const traceLimited = await workerClient.executeWithTracing(
      'public class Solution { public int Add(int a, int b) { return a + b; } }',
      'Add',
      { a: 2, b: 3 },
      { maxTraceSteps: 1 },
      'solution-method'
    );
    assertCondition(traceLimited.success, 'C# trace-limited execution should preserve success');
    assertCondition(traceLimited.output === 5, 'C# trace-limited execution should preserve output');
    assertCondition(traceLimited.traceLimitExceeded === true, 'C# trace-limited execution should set traceLimitExceeded');
    assertCondition(traceLimited.timeoutReason === 'trace-limit', 'C# trace-limited execution should preserve timeoutReason');

    assertCondition(
      MockCSharpWorker.received.some((message) =>
        message.type === 'execute-with-tracing'
        && (message.payload as { maxTraceSteps?: number } | undefined)?.maxTraceSteps === 1),
      'C# worker client should pass maxTraceSteps to the worker'
    );

    workerClient.terminate();
  } finally {
    globalThis.Worker = originalWorker;
  }

  console.log('PASS: C# worker client result mapping contract');
}

async function testClientTimeoutReset(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalSetTimeout = globalThis.setTimeout;
  MockCSharpWorker.responses = [];
  MockCSharpWorker.received = [];
  MockCSharpWorker.instances = [];
  MockCSharpWorker.hangingMessageTypes = new Set<string>(['execute-with-tracing']);
  MockCSharpWorker.erroringMessageTypes = new Set<string>();
  // @ts-expect-error test stub
  globalThis.Worker = MockCSharpWorker;

  const workerClient = new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    assetBaseUrl: '/workers/vendor/csharp',
  });

  try {
    await workerClient.init();
    const firstWorker = MockCSharpWorker.instances[0];
    assertCondition(Boolean(firstWorker), 'C# timeout test should create an initial worker');

    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 20_000) {
        return originalSetTimeout(() => {
          if (typeof handler === 'function') {
            handler(...args);
          } else {
            // eslint-disable-next-line no-eval
            eval(String(handler));
          }
        }, 0);
      }

      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;

    const timeoutResult = await workerClient.executeWithTracing(
      'public class Solution { public int Hang() { while (true) {} } }',
      'Hang',
      {},
      { maxTraceSteps: 20 },
      'solution-method'
    );
    assertCondition(!timeoutResult.success, 'C# client timeout should return a failed tracing result');
    assertCondition(timeoutResult.timeoutReason === 'client-timeout', 'C# client timeout should set client-timeout');
    assertCondition(timeoutResult.trace.events.some((event) => event.kind === 'timeout'), 'C# client timeout should emit a timeout trace event');
    assertCondition(firstWorker.terminated, 'C# client timeout should terminate the stuck worker');

    globalThis.setTimeout = originalSetTimeout;
    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    MockCSharpWorker.responses.push({
      success: true,
      output: 5,
      consoleOutput: [],
      events: [{ kind: 'return', runId: 'csharp:run', file: 'UserCode.cs', line: 1, function: 'Add', value: 5 }],
      executionTimeMs: 3,
    });

    const recovered = await workerClient.executeWithTracing(
      'public class Solution { public int Add(int a, int b) { return a + b; } }',
      'Add',
      { a: 2, b: 3 },
      { maxTraceSteps: 20 },
      'solution-method'
    );
    assertCondition(recovered.success, 'C# worker client should recover after timeout by creating a new worker');
    assertCondition(MockCSharpWorker.instances.length >= 2, 'C# worker client should create a replacement worker after timeout');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    workerClient.terminate();
    globalThis.Worker = originalWorker;
  }

  console.log('PASS: C# worker client timeout reset contract');
}

async function testWorkerErrorReset(): Promise<void> {
  const originalWorker = globalThis.Worker;
  MockCSharpWorker.responses = [];
  MockCSharpWorker.received = [];
  MockCSharpWorker.instances = [];
  MockCSharpWorker.hangingMessageTypes = new Set<string>();
  MockCSharpWorker.erroringMessageTypes = new Set<string>(['execute-code']);
  // @ts-expect-error test stub
  globalThis.Worker = MockCSharpWorker;

  const workerClient = new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    assetBaseUrl: '/workers/vendor/csharp',
  });

  try {
    await workerClient.init();
    const firstWorker = MockCSharpWorker.instances[0];
    assertCondition(Boolean(firstWorker), 'C# worker-error test should create an initial worker');

    await expectRejects(
      () =>
        workerClient.executeCode(
          'public class Solution { public int Add(int a, int b) { return a + b; } }',
          'Add',
          { a: 2, b: 3 },
          'solution-method'
        ),
      'mock execute-code worker error'
    );
    assertCondition(firstWorker.terminated, 'C# worker error should terminate the failed worker');

    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    MockCSharpWorker.responses.push({
      success: true,
      output: 5,
      consoleOutput: ['recovered'],
      executionTimeMs: 2,
    });

    const recovered = await workerClient.executeCode(
      'public class Solution { public int Add(int a, int b) { return a + b; } }',
      'Add',
      { a: 2, b: 3 },
      'solution-method'
    );
    assertCondition(recovered.success, 'C# worker client should recover after worker error');
    assertCondition(recovered.output === 5, 'C# worker client should preserve output after worker-error recovery');
    assertCondition(MockCSharpWorker.instances.length >= 2, 'C# worker client should create a replacement worker after worker error');
  } finally {
    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    workerClient.terminate();
    globalThis.Worker = originalWorker;
  }

  console.log('PASS: C# worker client error reset contract');
}

async function main(): Promise<void> {
  await testRuntimeAdapterContract();
  await testWorkerResultMapping();
  await testClientTimeoutReset();
  await testWorkerErrorReset();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
