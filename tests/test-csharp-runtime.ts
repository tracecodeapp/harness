#!/usr/bin/env npx tsx

import { createCSharpRuntimeClient } from '../packages/harness-browser/src/csharp-runtime-client';
import {
  CSharpWorkerClient,
  type CSharpDiagnostic,
  type CSharpExecutionStyle,
} from '../packages/harness-browser/src/csharp-worker-client';
import { getLanguageRuntimeProfile } from '../packages/harness-browser/src/runtime-profiles';
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

      if (type === 'warmup') {
        this.onmessage?.({
          data: { id, type, payload: { success: true, loadTimeMs: 2, timings: { totalMs: 2, initMs: 0, warmupMs: 2 } } },
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
    {
      kind: 'line',
      runId: 'csharp:run',
      file: 'solution.cs',
      line: 3,
      callStack: [{ function: 'Add', line: 2, args: [2, 3] }],
    },
    {
      kind: 'return',
      runId: 'csharp:run',
      file: 'solution.cs',
      function: 'Add',
      line: 4,
      value: 5,
      callStack: [{ function: 'Add', line: 2, args: [2, 3] }],
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
    executeCodeInterviewMode: async (
      _code: string,
      functionName: string,
      _inputs: Record<string, unknown>,
      executionStyle: CSharpExecutionStyle
    ) => {
      calls.push({ method: 'executeCodeInterviewMode', executionStyle });
      return {
        success: true,
        output: `${functionName}:interview`,
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
  const profile = getLanguageRuntimeProfile('csharp');
  assertCondition(profile.capabilities.execution.styles.function, 'C# profile should expose named function-style execution');
  assertCondition(profile.capabilities.execution.styles.script, 'C# profile should expose script-style execution');
  assertCondition(profile.capabilities.execution.styles.interviewMode, 'C# profile should expose interview-mode execution');

  const solutionResult = await client.executeCode(
    'public class Solution { public int Add(int a, int b) => a + b; }',
    'Add',
    { a: 2, b: 3 },
    'solution-method'
  );
  assertCondition(solutionResult.success, 'C# solution-method executeCode should succeed');
  assertCondition(solutionResult.output === 'Add:ok', 'C# solution-method executeCode should preserve output');

  const functionResult = await client.executeCode(
    'public class Solution { public int Add(int a, int b) => a + b; }',
    'Add',
    { a: 2, b: 3 },
    'function'
  );
  assertCondition(functionResult.success, 'C# named function-style executeCode should succeed');
  assertCondition(functionResult.output === 'Add:ok', 'C# named function-style executeCode should preserve output');

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
  assertCondition(
    traceResult.trace.events.some((event) => event.kind === 'line' && event.callStack?.some((frame) => frame.function === 'Add')),
    'C# executeWithTracing should preserve call-stack frames'
  );

  const functionTraceResult = await client.executeWithTracing(
    'public class Solution { public int Add(int a, int b) { return a + b; } }',
    'Add',
    { a: 2, b: 3 },
    { maxTraceSteps: 20 },
    'function'
  );
  assertCondition(functionTraceResult.success, 'C# named function-style executeWithTracing should succeed');
  assertCondition(functionTraceResult.trace.language === 'csharp', 'C# named function-style tracing should return a C# trace');

  const scriptResult = await client.executeCode(
    'int result = 7;',
    '',
    {},
    'function'
  );
  assertCondition(scriptResult.success, 'C# script-style executeCode should succeed');
  assertCondition(scriptResult.output === ':ok', 'C# script-style executeCode should route empty function name to worker');

  const scriptTraceResult = await client.executeWithTracing(
    'int result = 7;',
    null,
    {},
    { maxTraceSteps: 20 },
    'function'
  );
  assertCondition(scriptTraceResult.success, 'C# script-style executeWithTracing should succeed');
  assertCondition(scriptTraceResult.trace.language === 'csharp', 'C# script-style tracing should return a C# trace');

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

  const interviewResult = await client.executeCodeInterviewMode(
    'public class Solution { public int Add(int a, int b) => a + b; }',
    'Add',
    { a: 2, b: 3 },
    'solution-method' as RuntimeExecutionStyle
  );
  assertCondition(interviewResult.success, 'C# interview-mode executeCode should succeed');
  assertCondition(
    interviewResult.output === 'Add:interview',
    'C# interview-mode executeCode should preserve worker output'
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
  assertCondition(
    calls.some((call) => call.method === 'executeCodeInterviewMode' && call.executionStyle === 'solution-method'),
    'C# runtime client should route interview-mode executeCode'
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

    const compileFailure = await workerClient.executeCode(
      'public class Solution { public int Add(int a, int b) { return "nope"; } }',
      'Add',
      { a: 2, b: 3 },
      'solution-method'
    );
    assertCondition(!compileFailure.success, 'C# executeCode compile failure should return a failed result');
    assertCondition(compileFailure.errorLine === 4, 'C# executeCode should map solution.cs diagnostics to errorLine');
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

    const tracedFailure = await workerClient.executeWithTracing(
      'public class Solution { public int Crash() { throw new System.Exception(); } }',
      'Crash',
      {},
      { maxTraceSteps: 20 },
      'solution-method'
    );
    assertCondition(!tracedFailure.success, 'C# traced runtime failure should return a failed result');
    assertCondition(tracedFailure.errorLine === 6, 'C# traced failures should map solution.cs diagnostics to errorLine');
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
      events: [{
        kind: 'line',
        runId: 'csharp:run',
        file: 'solution.cs',
        line: 3,
        callStack: [{ function: 'Add', line: 2, args: [2, 3] }],
      }],
      executionTimeMs: 13,
      traceLimitExceeded: true,
      timeoutReason: 'trace-limit',
    });

    const traceLimited = await workerClient.executeWithTracing(
      'public class Solution { public int Add(int a, int b) { return a + b; } }',
      'Add',
      { a: 2, b: 3 },
      { maxTraceSteps: 1, maxLineEvents: 2, maxSingleLineHits: 1, maxStoredEvents: 4, minimalTrace: true },
      'solution-method'
    );
    assertCondition(traceLimited.success, 'C# trace-limited execution should preserve success');
    assertCondition(traceLimited.output === 5, 'C# trace-limited execution should preserve output');
    assertCondition(traceLimited.traceLimitExceeded === true, 'C# trace-limited execution should set traceLimitExceeded');
    assertCondition(traceLimited.timeoutReason === 'trace-limit', 'C# trace-limited execution should preserve timeoutReason');
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
    const functionStyle = await workerClient.executeCode(
      'public class Solution { public int Add(int a, int b) { return a + b; } }',
      'Add',
      { a: 2, b: 3 },
      'function'
    );
    assertCondition(functionStyle.success, 'C# worker client should execute named function-style requests');
    assertCondition(functionStyle.output === 5, 'C# worker client should preserve named function-style output');

    MockCSharpWorker.responses.push({
      success: true,
      output: { sum: 10 },
      consoleOutput: [],
      events: [{ kind: 'return', runId: 'csharp:run', file: 'solution.cs', line: 6, function: 'Run', value: { sum: 10 } }],
      executionTimeMs: 6,
    });
    const scriptTrace = await workerClient.executeWithTracing(
      [
        'int[] nums = new int[] { 1, 2, 3, 4 };',
        'int sum = 0;',
        'foreach (int value in nums) {',
        '  sum += value;',
        '}',
        'object result = new { sum = sum };',
      ].join('\n'),
      '',
      {},
      { maxTraceSteps: 200 },
      'function'
    );
    assertCondition(scriptTrace.success, 'C# worker client should execute script-style tracing requests');
    assertCondition(
      MockCSharpWorker.received.some((message) =>
        message.type === 'execute-with-tracing'
        && (message.payload as { executionStyle?: string; functionName?: string; timeoutMs?: number } | undefined)?.executionStyle === 'function'
        && (message.payload as { functionName?: string } | undefined)?.functionName === ''
        && (message.payload as { timeoutMs?: number } | undefined)?.timeoutMs === 59_000),
      'C# script-style tracing should get an extended outer worker deadline for cold playground runs'
    );

    MockCSharpWorker.responses.push({
      success: true,
      output: 5,
      consoleOutput: ['interview'],
      executionTimeMs: 4,
    });
    const interviewStyle = await workerClient.executeCodeInterviewMode(
      'public class Solution { public int Add(int a, int b) { return a + b; } }',
      'Add',
      { a: 2, b: 3 },
      'solution-method'
    );
    assertCondition(interviewStyle.success, 'C# worker client should execute interview-mode requests');
    assertCondition(interviewStyle.output === 5, 'C# worker client should preserve interview-mode output');
    assertCondition(!('trace' in interviewStyle), 'C# interview-mode execution should return a non-trace result');

    MockCSharpWorker.responses.push({
      success: false,
      error: 'C# execution timed out.',
      timeoutReason: 'client-timeout',
      consoleOutput: ['before timeout'],
      executionTimeMs: 5_000,
    });
    const interviewTimeout = await workerClient.executeCodeInterviewMode(
      'public class Solution { public int Hang() { while (true) {} } }',
      'Hang',
      {},
      'solution-method'
    );
    assertCondition(!interviewTimeout.success, 'C# interview-mode timeout-like worker result should fail');
    assertCondition(
      interviewTimeout.error === 'Time Limit Exceeded',
      `C# interview-mode timeout-like worker result should be sanitized, received ${interviewTimeout.error}`
    );
    assertCondition(
      interviewTimeout.timeoutReason === 'client-timeout',
      'C# interview-mode timeout-like worker result should preserve timeout metadata'
    );
    assertCondition(
      interviewTimeout.diagnosticStage === 'interview',
      'C# interview-mode timeout-like worker result should be labeled as interview stage'
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
    assertCondition(
      MockCSharpWorker.received.some((message) =>
        message.type === 'execute-code-interview'
        && (message.payload as { executionStyle?: string } | undefined)?.executionStyle === 'solution-method'),
      'C# worker client should send interview-mode requests through the interview worker route'
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
      events: [{ kind: 'return', runId: 'csharp:run', file: 'solution.cs', line: 1, function: 'Add', value: 5 }],
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

async function testInterviewClientTimeout(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalSetTimeout = globalThis.setTimeout;
  MockCSharpWorker.responses = [];
  MockCSharpWorker.received = [];
  MockCSharpWorker.instances = [];
  MockCSharpWorker.hangingMessageTypes = new Set<string>(['execute-code-interview']);
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
    assertCondition(Boolean(firstWorker), 'C# interview timeout test should create an initial worker');

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

    const timeoutResult = await workerClient.executeCodeInterviewMode(
      'public class Solution { public int Hang() { while (true) {} } }',
      'Hang',
      {},
      'solution-method'
    );
    assertCondition(!timeoutResult.success, 'C# interview client timeout should return a failed result');
    assertCondition(timeoutResult.error === 'Time Limit Exceeded', 'C# interview client timeout should be sanitized');
    assertCondition(
      timeoutResult.timeoutReason === 'client-timeout',
      'C# interview client timeout should set client-timeout'
    );
    assertCondition(
      timeoutResult.diagnosticStage === 'interview',
      'C# interview client timeout should be labeled as interview stage'
    );
    assertCondition(firstWorker.terminated, 'C# interview client timeout should terminate the stuck worker');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    MockCSharpWorker.hangingMessageTypes = new Set<string>();
    MockCSharpWorker.erroringMessageTypes = new Set<string>();
    workerClient.terminate();
    globalThis.Worker = originalWorker;
  }

  console.log('PASS: C# worker client interview timeout contract');
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
  await testInterviewClientTimeout();
  await testWorkerErrorReset();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
