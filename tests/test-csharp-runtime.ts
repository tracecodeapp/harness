#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createCSharpRuntimeClient } from '../packages/runtime-csharp/src/csharp-runtime-client';
import {
  CSharpWorkerClient,
  type CSharpDiagnostic,
  type CSharpExecutionStyle,
} from '../packages/runtime-csharp/src/csharp-worker-client';
import { getLanguageRuntimeProfile } from '../packages/runtime-browser/src/runtime-profiles';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  type RuntimeTraceEvent,
} from '../packages/runtime-contracts/src/runtime-trace';
import type { RuntimeExecutionStyle } from '../packages/runtime-contracts/src/runtime-types';
import type { ExecutionLimitReason } from '../packages/runtime-contracts/src/types';

function assertCondition(condition: unknown, message: string): asserts condition {
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
  protocolToken?: string;
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
  timeoutReason?: ExecutionLimitReason;
  compiledArtifactKey?: string;
  compiledArtifactBase64?: string;
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
          data: { id, type, payload: { success: true, loadTimeMs: 1 }, protocolToken: message.protocolToken },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (MockCSharpWorker.hangingMessageTypes.has(type)) {
        return;
      }

      if (type === 'warmup') {
        this.onmessage?.({
          data: {
            id,
            type,
            payload: { success: true, loadTimeMs: 2, timings: { totalMs: 2, initMs: 0, warmupMs: 2 } },
            protocolToken: message.protocolToken,
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (MockCSharpWorker.erroringMessageTypes.has(type)) {
        this.onerror?.({ message: `mock ${type} worker error` } as ErrorEvent);
        return;
      }

      const payload = MockCSharpWorker.responses.shift();
      if (!payload) {
        this.onmessage?.({
          data: {
            id,
            type: 'error',
            payload: { error: `No mock response for ${type}` },
            protocolToken: message.protocolToken,
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      this.onmessage?.({
        data: { id, type, payload, protocolToken: message.protocolToken },
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
    {
      kind: 'line',
      runId: 'csharp:run',
      file: 'solution.cs',
      line: 3,
      callStack: [{ function: 'Add', line: 2, args: [2, 3] as unknown as Record<string, unknown> }],
    },
    {
      kind: 'return',
      runId: 'csharp:run',
      file: 'solution.cs',
      function: 'Add',
      line: 4,
      value: 5,
      callStack: [{ function: 'Add', line: 2, args: [2, 3] as unknown as Record<string, unknown> }],
    },
  ];

  const workerClient = {
    init: async () => ({ success: true, loadTimeMs: 1 }),
    executeCode: async (call: { functionName: string; executionStyle?: CSharpExecutionStyle }) => {
      const executionStyle = call.executionStyle ?? 'solution-method';
      calls.push({ method: 'executeCode', executionStyle });
      return {
        kind: 'completed' as const,
        output: executionStyle === 'ops-class' ? [null, 3, 6] : `${call.functionName}:ok`,
        consoleOutput: [],
      };
    },
    executeWithTracing: async (call: { executionStyle?: CSharpExecutionStyle }) => {
      calls.push({ method: 'executeWithTracing', executionStyle: call.executionStyle ?? 'solution-method' });
      return {
        kind: 'completed' as const,
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
      };
    },
  };

  const client = createCSharpRuntimeClient(workerClient as unknown as CSharpWorkerClient);
  const init = await client.init();
  assertCondition(init.success && init.loadTimeMs === 1, 'C# runtime client should expose init result');
  const profile = getLanguageRuntimeProfile('csharp');
  assertCondition(profile.capabilities.execution.styles.function, 'C# profile should expose named function-style execution');
  assertCondition(profile.capabilities.execution.styles.script, 'C# profile should expose script-style execution');
  assertCondition(profile.capabilities.execution.limits.wallClock, 'C# profile should honor wall-clock execution limits');

  const solutionResult = await client.executeCode({ code: 'public class Solution { public int Add(int a, int b) => a + b; }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' });
  assertCondition(solutionResult.kind === 'completed', 'C# solution-method executeCode should succeed');
  assertCondition(solutionResult.output === 'Add:ok', 'C# solution-method executeCode should preserve output');

  const functionResult = await client.executeCode({ code: 'public class Solution { public int Add(int a, int b) => a + b; }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'function' });
  assertCondition(functionResult.kind === 'completed', 'C# named function-style executeCode should succeed');
  assertCondition(functionResult.output === 'Add:ok', 'C# named function-style executeCode should preserve output');

  const traceResult = await client.executeWithTracing({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, traceOptions: { maxTraceSteps: 20 }, executionStyle: 'solution-method' });
  assertCondition(traceResult.kind === 'completed', 'C# executeWithTracing should succeed');
  assertCondition(traceResult.trace.language === 'csharp', 'C# executeWithTracing should return a C# runtime trace');
  assertCondition(traceResult.trace.lineEventCount === 1, 'C# executeWithTracing should preserve line event counts');
  assertCondition(traceResult.trace.traceStepCount === 2, 'C# executeWithTracing should preserve trace step counts');
  assertCondition(
    traceResult.trace.events.some((event) => event.kind === 'line' && event.callStack?.some((frame) => frame.function === 'Add')),
    'C# executeWithTracing should preserve call-stack frames'
  );

  const functionTraceResult = await client.executeWithTracing({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, traceOptions: { maxTraceSteps: 20 }, executionStyle: 'function' });
  assertCondition(functionTraceResult.kind === 'completed', 'C# named function-style executeWithTracing should succeed');
  assertCondition(functionTraceResult.trace.language === 'csharp', 'C# named function-style tracing should return a C# trace');

  const scriptResult = await client.executeCode({ code: 'int result = 7;', functionName: '', inputs: {}, executionStyle: 'function' });
  assertCondition(scriptResult.kind === 'completed', 'C# script-style executeCode should succeed');
  assertCondition(scriptResult.output === ':ok', 'C# script-style executeCode should route empty function name to worker');

  const scriptTraceResult = await client.executeWithTracing({ code: 'int result = 7;', functionName: null, inputs: {}, traceOptions: { maxTraceSteps: 20 }, executionStyle: 'function' });
  assertCondition(scriptTraceResult.kind === 'completed', 'C# script-style executeWithTracing should succeed');
  assertCondition(scriptTraceResult.trace.language === 'csharp', 'C# script-style tracing should return a C# trace');

  const opsResult = await client.executeCode({ code: 'public class Counter { public Counter(int start) {} public int Inc(int delta) => delta; }', functionName: 'Counter', inputs: { operations: ['Counter', 'Inc', 'Inc'], arguments: [[1], [3], [6]] }, executionStyle: 'ops-class' });
  assertCondition(opsResult.kind === 'completed', 'C# ops-class executeCode should succeed');
  assertCondition(
    JSON.stringify(opsResult.output) === JSON.stringify([null, 3, 6]),
    `C# ops-class executeCode should preserve the operation-output array, received ${JSON.stringify(opsResult.output)}`
  );

  assertCondition(
    calls.some((call) => call.method === 'executeCode' && call.executionStyle === 'solution-method'),
    'C# runtime client should route solution-method executeCode'
  );
  assertCondition(
    calls.some((call) => call.method === 'executeCode' && call.executionStyle === 'function'),
    'C# runtime client should route named function-style executeCode'
  );
  assertCondition(
    calls.some((call) => call.method === 'executeWithTracing' && call.executionStyle === 'solution-method'),
    'C# runtime client should route solution-method executeWithTracing'
  );
  assertCondition(
    calls.some((call) => call.method === 'executeWithTracing' && call.executionStyle === 'function'),
    'C# runtime client should route named function-style executeWithTracing'
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

    const initResult = await workerClient.init();
    assertCondition(initResult.success && initResult.loadTimeMs === 1, 'C# worker client init should stay light');
    const warmupResult = await workerClient.warmup();
    assertCondition(warmupResult.success && warmupResult.loadTimeMs === 2, 'C# worker client warmup should use warmup route');
    assertCondition(
      MockCSharpWorker.received.some((message) => message.type === 'warmup'),
      'C# worker client warmup should send a warmup worker request'
    );

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
          file: 'solution.cs',
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

    const compileFailure = await workerClient.executeCode({ code: 'public class Solution { public int Add(int a, int b) { return "nope"; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' });
    assertCondition(compileFailure.kind === 'failed', 'C# executeCode compile failure should return a failed result');
    assertCondition(compileFailure.kind === 'failed' && compileFailure.errorLine === 4, 'C# executeCode should map solution.cs diagnostics to errorLine');
    assertCondition(
      compileFailure.consoleOutput?.[0] === 'before compile failure',
      'C# executeCode should preserve stdout on compile failure'
    );

    MockCSharpWorker.responses.push({
      success: false,
      error: 'Object reference not set to an instance of an object.',
      diagnostics: [
        {
          file: 'solution.cs',
          line: 6,
          column: 10,
          message: 'runtime mapped diagnostic',
          severity: 'error',
          id: 'TRACE',
        },
      ],
      consoleOutput: ['before runtime failure'],
      events: [
        { kind: 'line', runId: 'csharp:run', file: 'solution.cs', line: 6 },
        {
          kind: 'exception',
          runId: 'csharp:run',
          file: 'solution.cs',
          line: 6,
          message: 'Object reference not set to an instance of an object.',
        },
      ],
      executionTimeMs: 11,
    });

    const tracedFailure = await workerClient.executeWithTracing({ code: 'public class Solution { public int Crash() { throw new System.Exception(); } }', functionName: 'Crash', inputs: {}, traceOptions: { maxTraceSteps: 20 }, executionStyle: 'solution-method' });
    assertCondition(tracedFailure.kind === 'failed', 'C# traced runtime failure should return a failed result');
    assertCondition(tracedFailure.kind === 'failed' && tracedFailure.errorLine === 6, 'C# traced failures should map solution.cs diagnostics to errorLine');
    assertCondition(tracedFailure.trace.language === 'csharp', 'C# traced failures should return a C# runtime trace');
    assertCondition(tracedFailure.trace.lineEventCount === 1, 'C# traced failures should preserve line event count');
    assertCondition(
      tracedFailure.trace.events.some((event) => event.kind === 'stdout' && event.text === 'before runtime failure'),
      'C# traced failures should append stdout events to the runtime trace'
    );

    MockCSharpWorker.responses.push({
      success: true,
      output: 5,
      consoleOutput: [],
      events: [{
        kind: 'line',
        runId: 'csharp:run',
        file: 'solution.cs',
        line: 3,
        callStack: [{ function: 'Add', line: 2, args: [2, 3] as unknown as Record<string, unknown> }],
      }],
      executionTimeMs: 13,
      traceLimitExceeded: true,
      timeoutReason: 'trace-limit',
    });

    const traceLimited = await workerClient.executeWithTracing({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, traceOptions: { maxTraceSteps: 1, maxLineEvents: 2, maxSingleLineHits: 1, maxStoredEvents: 4, minimalTrace: true }, executionStyle: 'solution-method' });
    assertCondition(traceLimited.kind === 'completed', 'C# trace-limited execution should stay a completed outcome');
    assertCondition(traceLimited.kind === 'completed' && traceLimited.output === 5, 'C# trace-limited execution should preserve output');
    assertCondition(
      traceLimited.kind === 'completed' && traceLimited.traceTruncated === 'trace-limit',
      'C# trace-limited execution should mark the trace as truncated by trace-limit'
    );
    assertCondition(
      traceLimited.trace.events.some((event) => event.kind === 'line' && event.callStack?.some((frame) => frame.function === 'Add')),
      'C# worker client should preserve C# call-stack frames'
    );

    MockCSharpWorker.responses.push({
      success: true,
      output: 5,
      consoleOutput: [],
      executionTimeMs: 5,
    });
    const functionStyle = await workerClient.executeCode({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'function' });
    assertCondition(functionStyle.kind === 'completed', 'C# worker client should execute named function-style requests');
    assertCondition(functionStyle.kind === 'completed' && functionStyle.output === 5, 'C# worker client should preserve named function-style output');

    MockCSharpWorker.responses.push({
      success: true,
      output: { sum: 10 },
      consoleOutput: [],
      events: [{ kind: 'return', runId: 'csharp:run', file: 'solution.cs', line: 6, function: 'Run', value: { sum: 10 } }],
      executionTimeMs: 6,
    });
    const scriptTrace = await workerClient.executeWithTracing({ code: [
        'int[] nums = new int[] { 1, 2, 3, 4 };',
        'int sum = 0;',
        'foreach (int value in nums) {',
        '  sum += value;',
        '}',
        'object result = new { sum = sum };',
      ].join('\n'), functionName: '', inputs: {}, traceOptions: { maxTraceSteps: 200 }, executionStyle: 'function' });
    assertCondition(scriptTrace.kind === 'completed', 'C# worker client should execute script-style tracing requests');
    assertCondition(
      MockCSharpWorker.received.some((message) =>
        message.type === 'execute-with-tracing'
        && (message.payload as { executionStyle?: string; functionName?: string; timeoutMs?: number } | undefined)?.executionStyle === 'function'
        && (message.payload as { functionName?: string } | undefined)?.functionName === ''
        && (message.payload as { timeoutMs?: number } | undefined)?.timeoutMs === 19_000),
      'C# script-style tracing should preserve the configured worker deadline'
    );

    assertCondition(
      MockCSharpWorker.received.some((message) =>
        message.type === 'execute-with-tracing'
        && (message.payload as {
          maxTraceSteps?: number;
          maxLineEvents?: number;
          maxSingleLineHits?: number;
          maxStoredEvents?: number;
          minimalTrace?: boolean;
        } | undefined)?.maxTraceSteps === 1
        && (message.payload as { maxLineEvents?: number } | undefined)?.maxLineEvents === 2
        && (message.payload as { maxSingleLineHits?: number } | undefined)?.maxSingleLineHits === 1
        && (message.payload as { maxStoredEvents?: number } | undefined)?.maxStoredEvents === 4
        && (message.payload as { minimalTrace?: boolean } | undefined)?.minimalTrace === true),
      'C# worker client should pass trace budget controls to the worker'
    );
    assertCondition(
      MockCSharpWorker.received.some((message) =>
        message.type === 'execute-code'
        && (message.payload as { executionStyle?: string } | undefined)?.executionStyle === 'function'),
      'C# worker client should pass function executionStyle to the worker'
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

    const timeoutResult = await workerClient.executeWithTracing({ code: 'public class Solution { public int Hang() { while (true) {} } }', functionName: 'Hang', inputs: {}, traceOptions: { maxTraceSteps: 20 }, executionStyle: 'solution-method' });
    assertCondition(
      timeoutResult.kind === 'limit' && timeoutResult.reason === 'client-timeout',
      'C# client timeout should return a client-timeout limit outcome'
    );
    assertCondition(timeoutResult.trace.events.some((event) => event.kind === 'timeout'), 'C# client timeout should emit a timeout trace event');
    assertCondition(firstWorker.terminated, 'C# client timeout should terminate the stuck worker');

    globalThis.setTimeout = originalSetTimeout;
    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    MockCSharpWorker.responses.push({
      success: true,
      output: 5,
      consoleOutput: [],
      events: [{ kind: 'return', runId: 'csharp:run', file: 'solution.cs', line: 1, function: 'Add', value: 5 }],
      executionTimeMs: 3,
    });

    const recovered = await workerClient.executeWithTracing({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, traceOptions: { maxTraceSteps: 20 }, executionStyle: 'solution-method' });
    assertCondition(recovered.kind === 'completed', 'C# worker client should recover after timeout by creating a new worker');
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

async function testWarmupTimeoutReset(): Promise<void> {
  const originalWorker = globalThis.Worker;
  MockCSharpWorker.responses = [];
  MockCSharpWorker.received = [];
  MockCSharpWorker.instances = [];
  MockCSharpWorker.hangingMessageTypes = new Set<string>(['warmup']);
  MockCSharpWorker.erroringMessageTypes = new Set<string>();
  // @ts-expect-error test stub
  globalThis.Worker = MockCSharpWorker;

  const workerClient = new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    assetBaseUrl: '/workers/vendor/csharp',
    executionTimeoutMs: 5,
    initTimeoutMs: 5,
  });

  try {
    await workerClient.init();
    const firstWorker = MockCSharpWorker.instances[0];
    assertCondition(Boolean(firstWorker), 'C# warmup timeout test should create an initial worker');

    await expectRejects(
      () =>
        workerClient.executeCode({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' }),
      'Worker request timed out: warmup'
    );
    assertCondition(
      MockCSharpWorker.received.some((message) => message.type === 'warmup'),
      'C# execution should attempt warmup before timing out'
    );
    assertCondition(firstWorker.terminated, 'C# warmup timeout should terminate the stuck worker');

    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    MockCSharpWorker.responses.push({
      success: true,
      output: 5,
      consoleOutput: ['recovered'],
      executionTimeMs: 2,
    });

    const recovered = await workerClient.executeCode({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' });
    assertCondition(recovered.kind === 'completed', 'C# worker client should recover after warmup timeout');
    assertCondition(MockCSharpWorker.instances.length >= 2, 'C# worker client should replace a warmup-timeout worker');
  } finally {
    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    workerClient.terminate();
    globalThis.Worker = originalWorker;
  }

  console.log('PASS: C# worker client warmup timeout reset contract');
}

async function testWallClockLimitClientTimeout(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalSetTimeout = globalThis.setTimeout;
  MockCSharpWorker.responses = [];
  MockCSharpWorker.received = [];
  MockCSharpWorker.instances = [];
  MockCSharpWorker.hangingMessageTypes = new Set<string>(['execute-code']);
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
    assertCondition(Boolean(firstWorker), 'C# wall-clock timeout test should create an initial worker');

    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 5_000) {
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

    let wallClockError: unknown;
    try {
      await workerClient.executeCode({ code: 'public class Solution { public int Hang() { while (true) {} } }', functionName: 'Hang', inputs: {}, executionStyle: 'solution-method', limits: { wallClockMs: 5_000 } });
    } catch (error) {
      wallClockError = error;
    }
    assertCondition(
      wallClockError instanceof Error && wallClockError.message.includes('C# execution timed out'),
      `C# wall-clock limit trip should reject with the tagged timeout error, received ${String(wallClockError)}`
    );
    assertCondition(firstWorker.terminated, 'C# wall-clock limit trip should terminate the stuck worker');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    workerClient.terminate();
    globalThis.Worker = originalWorker;
  }

  console.log('PASS: C# worker client wall-clock limit timeout contract');
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
        workerClient.executeCode({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' }),
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

    const recovered = await workerClient.executeCode({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' });
    assertCondition(recovered.kind === 'completed', 'C# worker client should recover after worker error');
    assertCondition(recovered.kind === 'completed' && recovered.output === 5, 'C# worker client should preserve output after worker-error recovery');
    assertCondition(MockCSharpWorker.instances.length >= 2, 'C# worker client should create a replacement worker after worker error');
  } finally {
    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    workerClient.terminate();
    globalThis.Worker = originalWorker;
  }

  console.log('PASS: C# worker client error reset contract');
}

async function testPreparedWorkerGenerationAuthority(): Promise<void> {
  const originalWorker = globalThis.Worker;
  MockCSharpWorker.responses = [];
  MockCSharpWorker.received = [];
  MockCSharpWorker.instances = [];
  MockCSharpWorker.hangingMessageTypes = new Set<string>();
  MockCSharpWorker.erroringMessageTypes = new Set<string>();
  // @ts-expect-error test stub
  globalThis.Worker = MockCSharpWorker;

  const workerClient = new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    assetBaseUrl: '/workers/vendor/csharp',
  });
  const provider = createCSharpRuntimeClient(workerClient);

  try {
    MockCSharpWorker.responses.push(
      {
        success: true,
        compiledArtifactKey: 'prepared-a',
        compiledArtifactBase64: 'TVqQAAMAAAAEAAAA',
        consoleOutput: [],
      },
      {
        success: true,
        compiledArtifactKey: 'prepared-b',
        compiledArtifactBase64: 'TVqQAAMAAAAEAAAB',
        consoleOutput: [],
      }
    );
    const preparedA = await provider.prepareProgram({
      mode: 'code',
      code: 'public class Solution { public int Echo(int value) => value; }',
      functionName: 'Echo',
    });
    const preparedB = await provider.prepareProgram({
      mode: 'code',
      code: 'public class Solution { public int Echo(int value) => value; }',
      functionName: 'Echo',
    });
    assertCondition(
      preparedA.kind === 'prepared' &&
        preparedA.program.mode === 'code' &&
        preparedB.kind === 'prepared' &&
        preparedB.program.mode === 'code',
      'C# prepared authority test requires two prepared code handles'
    );
    if (
      preparedA.kind !== 'prepared' ||
      preparedA.program.mode !== 'code' ||
      preparedB.kind !== 'prepared' ||
      preparedB.program.mode !== 'code'
    ) {
      return;
    }
    assertCondition(
      MockCSharpWorker.instances.every((worker) => worker.terminated),
      'C# preparation must retire its compiler worker before exposing a fresh-case-state handle'
    );

    MockCSharpWorker.hangingMessageTypes = new Set<string>(['execute-prepared-code']);
    const firstExecution = preparedA.program.executeIsolated({
      inputs: { value: 1 },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const secondExecution = preparedB.program.executeIsolated({
      inputs: { value: 2 },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const firstMessage = MockCSharpWorker.received.find(
      (message) => message.type === 'execute-prepared-code'
    );
    assertCondition(Boolean(firstMessage?.id), 'First prepared C# execution should reach its worker');
    assertCondition(
      MockCSharpWorker.received.filter(
        (message) => message.type === 'execute-prepared-code'
      ).length === 1,
      'prepared handles sharing one C# client must serialize through one authority'
    );
    const activeWorker = MockCSharpWorker.instances.find((worker) => !worker.terminated);
    assertCondition(Boolean(activeWorker), 'First prepared C# execution should own one active worker generation');

    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    MockCSharpWorker.responses.push({
      success: true,
      output: 2,
      consoleOutput: [],
      executionTimeMs: 1,
    });
    activeWorker!.onmessage?.({
      data: {
        id: firstMessage!.id,
        type: firstMessage!.type,
        protocolToken: firstMessage!.protocolToken,
        payload: {
          success: true,
          output: 1,
          consoleOutput: [],
          executionTimeMs: 1,
        },
      },
    } as MessageEvent<WorkerMessage>);

    const [firstResult, secondResult] = await Promise.all([
      firstExecution,
      secondExecution,
    ]);
    assertCondition(
      firstResult.kind === 'completed' && firstResult.output === 1,
      'First prepared C# execution should complete through its owned worker generation'
    );
    assertCondition(
      secondResult.kind === 'completed' && secondResult.output === 2,
      'Second prepared C# handle should execute only after the shared authority releases'
    );
    assertCondition(
      MockCSharpWorker.received.filter(
        (message) => message.type === 'execute-prepared-code'
      ).length === 2,
      'Both serialized prepared C# executions should eventually reach a worker'
    );
    assertCondition(
      MockCSharpWorker.instances.every((worker) => worker.terminated),
      'every prepared C# case must retire its outer worker generation'
    );

    await preparedA.program.dispose();
    await preparedB.program.dispose();
  } finally {
    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    workerClient.terminate();
    globalThis.Worker = originalWorker;
  }

  console.log('PASS: C# prepared handles share one fresh-worker execution authority');
}

function testTraceRewriterTargetTypedFieldWritesDoNotReadAssignedMembers(): void {
  const source = readFileSync('runtimes/csharp/TraceCode.CSharpHost/TraceRewriter.cs', 'utf8');
  assertCondition(
    source.includes('FieldWrite({Literal("this")}, {implicitThisPathExpression}, null, {line})'),
    'C# TraceRewriter target-typed implicit-this field writes should record without reading the assigned member'
  );
  assertCondition(
    source.includes('FieldWrite({Literal(variable)}, {pathExpression}, null, {line})'),
    'C# TraceRewriter target-typed member writes should record without reading the assigned member'
  );
  assertCondition(
    !source.includes('FieldWrite({Literal("this")}, {implicitThisPathExpression}, {left}, {line})') &&
      !source.includes('FieldWrite({Literal(variable)}, {pathExpression}, {memberLeft}, {line})'),
    'C# TraceRewriter target-typed field writes must not read the assigned target for trace value capture'
  );
  console.log('PASS: C# TraceRewriter target-typed field writes avoid read-after-write instrumentation');
}

function testTraceRewriterIndexedAssignmentsDoNotReadAssignedIndexers(): void {
  const source = readFileSync('runtimes/csharp/TraceCode.CSharpHost/TraceRewriter.cs', 'utf8');
  assertCondition(
    source.includes('var {valueTempName} = ({arrayExpression}[{indexTempName}] = {assignment.Right});'),
    'C# TraceRewriter indexed assignments should capture the assignment expression result'
  );
  assertCondition(
    !source.includes('var {valueTempName} = {arrayExpression}[{indexTempName}];'),
    'C# TraceRewriter indexed assignments must not read the assigned indexer after assignment'
  );
  console.log('PASS: C# TraceRewriter indexed assignments avoid post-assignment getter reads');
}

async function main(): Promise<void> {
  await testRuntimeAdapterContract();
  await testWorkerResultMapping();
  await testClientTimeoutReset();
  await testWarmupTimeoutReset();
  await testWallClockLimitClientTimeout();
  await testWorkerErrorReset();
  await testPreparedWorkerGenerationAuthority();
  testTraceRewriterTargetTypedFieldWritesDoNotReadAssignedMembers();
  testTraceRewriterIndexedAssignmentsDoNotReadAssignedIndexers();
}

test('csharp runtime', main);
