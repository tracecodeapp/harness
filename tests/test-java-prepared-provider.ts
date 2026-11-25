#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlgorithmJudgeBundle } from '../src/judge';
import { createBrowserJudgeHostFromRuntimeHost } from '../src/internal/browser-judge';
import { createBrowserRuntimeHost } from '../packages/runtime-browser/src/browser-runtime-host';
import { createBrowserRuntimeProviderRegistry } from '../packages/runtime-browser/src/runtime-provider-registry';
import {
  createEmptyRuntimeTrace,
  isRuntimeProviderError,
  isTraceUnavailableError,
  RuntimeProviderError,
  TRACE_UNAVAILABLE_CODE,
  type RuntimeProgramPreparationCall,
} from '../packages/runtime-contracts/src/index';
import {
  ExecutionTimeoutError,
  InterruptedCodeBatchError,
  type WorkerSessionCore,
} from '../packages/runtime-browser/src/internal';
import {
  createJavaBrowserPreparedExecutionProvider,
  createJavaJudgeReceiptProvider,
  createJavaPreparedExecutionProvider,
} from '../packages/runtime-java/src/java-prepared-provider';
import {
  JavaWorkerClient,
  type JavaWorkerClientOptions,
  JavaWorkerPreparedProgramSnapshot,
  JavaWorkerPreparedProgramResult,
} from '../packages/runtime-java/src/java-worker-client';
import type {
  BrowserWorkerLike,
} from '../packages/runtime-browser/src/internal';

interface FakeClientState {
  initCalls: number;
  prepareCalls: RuntimeProgramPreparationCall[];
  restoreCalls: JavaWorkerPreparedProgramSnapshot[];
  codeCalls: Array<{ programId: string; inputs: Record<string, unknown> }>;
  traceCalls: Array<{ programId: string; inputs: Record<string, unknown> }>;
  codeBatchCalls: Array<{
    programId: string;
    inputBatch: readonly Record<string, unknown>[];
  }>;
  traceBatchCalls: Array<{
    programId: string;
    inputBatch: readonly Record<string, unknown>[];
  }>;
  disposeCalls: string[];
  terminateCalls: number;
}

function createFakeClient(options: {
  executeInit?: (
    state: FakeClientState
  ) => Promise<{ success: boolean; loadTimeMs: number }>;
  prepareResult?: JavaWorkerPreparedProgramResult;
  executePrepare?: (
    call: RuntimeProgramPreparationCall,
    state: FakeClientState
  ) => Promise<JavaWorkerPreparedProgramResult>;
  codeFailure?: Error;
  traceFailure?: Error;
  /** A per-case traced-run failure, chosen from the case's inputs. */
  traceFailureFor?: (inputs: Record<string, unknown>) => Error | undefined;
  retireAfterCodeCalls?: ReadonlySet<number>;
  executeCode?: (
    programId: string,
    call: {
      inputs: Record<string, unknown>;
      signal?: AbortSignal;
    },
    state: FakeClientState
  ) => Promise<{
    kind: 'completed';
    output: unknown;
    consoleOutput: string[];
    timings: { compileMs: number; runMs: number; totalMs: number };
    retirementRecommended: boolean;
  }>;
  onTerminate?: () => void;
  executeRestore?: (
    snapshot: JavaWorkerPreparedProgramSnapshot,
    state: FakeClientState
  ) => Promise<JavaWorkerPreparedProgramResult>;
} = {}): { client: JavaWorkerClient; state: FakeClientState } {
  let sessionGeneration = 0;
  let terminated = false;
  const state: FakeClientState = {
    initCalls: 0,
    prepareCalls: [],
    restoreCalls: [],
    codeCalls: [],
    traceCalls: [],
    codeBatchCalls: [],
    traceBatchCalls: [],
    disposeCalls: [],
    terminateCalls: 0,
  };
  const client = {
    get sessionGeneration() {
      return sessionGeneration;
    },
    async init() {
      terminated = false;
      state.initCalls += 1;
      if (options.executeInit) return options.executeInit(state);
      return { success: true, loadTimeMs: 7 };
    },
    async prepareRuntimeProgram(call: RuntimeProgramPreparationCall) {
      state.prepareCalls.push(call);
      if (options.executePrepare) {
        return options.executePrepare(call, state);
      }
      return (
        options.prepareResult ?? {
          success: true,
          programId: 'prepared-java-1',
          snapshot: {
            schema: 'tracecode.java.prepared-program-snapshot.v1',
            programId: 'prepared-java-1',
          },
          consoleOutput: [],
          timings: { compileMs: 12, totalMs: 15 },
        }
      );
    },
    async restorePreparedRuntimeProgram(
      snapshot: JavaWorkerPreparedProgramSnapshot
    ) {
      state.restoreCalls.push(snapshot);
      if (options.executeRestore) {
        return options.executeRestore(snapshot, state);
      }
      return {
        success: true,
        programId: snapshot.programId,
        snapshot,
        consoleOutput: [],
        timings: { compileMs: 0, totalMs: 0 },
      };
    },
    async executePreparedCode(
      programId: string,
      call: { inputs: Record<string, unknown>; signal?: AbortSignal }
    ) {
      state.codeCalls.push({ programId, inputs: call.inputs });
      if (options.codeFailure) throw options.codeFailure;
      if (options.executeCode) {
        return options.executeCode(programId, call, state);
      }
      return {
        kind: 'completed' as const,
        output: call.inputs.value,
        consoleOutput: [],
        timings: { compileMs: 0, runMs: 2, totalMs: 2 },
        retirementRecommended:
          options.retireAfterCodeCalls?.has(state.codeCalls.length) === true,
      };
    },
    async executePreparedCodeBatch(
      programId: string,
      call: {
        inputBatch: readonly Record<string, unknown>[];
        signal?: AbortSignal;
      }
    ) {
      state.codeBatchCalls.push({
        programId,
        inputBatch: call.inputBatch,
      });
      return Promise.all(
        call.inputBatch.map(async (inputs) => {
          state.codeCalls.push({ programId, inputs });
          if (options.codeFailure) throw options.codeFailure;
          if (options.executeCode) {
            return options.executeCode(
              programId,
              { inputs, signal: call.signal },
              state
            );
          }
          return {
            kind: 'completed' as const,
            output: inputs.value,
            consoleOutput: [],
            timings: { compileMs: 0, runMs: 2, totalMs: 2 },
            retirementRecommended: false,
          };
        })
      );
    },
    async executePreparedWithTracing(
      programId: string,
      call: { inputs: Record<string, unknown> }
    ) {
      state.traceCalls.push({ programId, inputs: call.inputs });
      if (options.traceFailure) throw options.traceFailure;
      const caseFailure = options.traceFailureFor?.(call.inputs);
      if (caseFailure) throw caseFailure;
      return {
        success: true,
        output: call.inputs.value,
        events: [],
        sourceText: 'class Solution {}',
        executionTimeMs: 2,
        consoleOutput: [],
        trace: createEmptyRuntimeTrace('java'),
        timings: { compileMs: 0, runMs: 2, totalMs: 2 },
        retirementRecommended: false,
      };
    },
    async executePreparedTraceBatch(
      programId: string,
      call: {
        inputBatch: readonly Record<string, unknown>[];
      }
    ) {
      state.traceBatchCalls.push({
        programId,
        inputBatch: call.inputBatch,
      });
      return call.inputBatch.map((inputs) => {
        const error = options.traceFailure ?? options.traceFailureFor?.(inputs);
        if (error && !isTraceUnavailableError(error)) throw error;
        return {
          success: error === undefined,
          ...(error && {
            traceUnavailable: true,
            error: error.message,
            diagnosticStage: 'runtime',
          }),
          output: inputs.value,
          events: [],
          sourceText: 'class Solution {}',
          executionTimeMs: 2,
          consoleOutput: [],
          trace: createEmptyRuntimeTrace('java'),
          timings: { compileMs: 0, runMs: 2, totalMs: 2 },
          retirementRecommended: false,
        };
      });
    },
    async disposePreparedRuntimeProgram(programId: string) {
      state.disposeCalls.push(programId);
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      state.terminateCalls += 1;
      sessionGeneration += 1;
      options.onTerminate?.();
    },
  } as unknown as JavaWorkerClient;
  return { client, state };
}

function deferred<Value = void>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

test('Java prepared provider keeps one compiler worker and executes fresh process cases', async () => {
  const preparationWorker = createFakeClient();
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => preparationWorker.client,
  });

  assert.deepEqual(await provider.init(), { success: true, loadTimeMs: 7 });
  const preparation = await provider.prepareProgram({
    mode: 'code',
    code: 'class Solution { int value(int value) { return value; } }',
    functionName: 'value',
    executionStyle: 'solution-method',
  });
  assert.equal(preparation.kind, 'prepared');
  if (preparation.kind !== 'prepared' || preparation.program.mode !== 'code') {
    throw new Error('Expected a prepared Java code program.');
  }

  assert.deepEqual(preparation.program.capabilities, {
    profile: 'compatibility',
    caseIsolation: 'fresh-case-state',
    maxConcurrency: 1,
    stopsAtFirstRunaway: true,
  });
  assert.equal(
    (await preparation.program.executeIsolated({
      inputs: { value: 1 },
    })).kind,
    'completed'
  );
  assert.equal(
    (await preparation.program.executeIsolated({
      inputs: { value: 2 },
    })).kind,
    'completed'
  );

  assert.equal(preparationWorker.state.initCalls, 1);
  assert.equal(preparationWorker.state.prepareCalls.length, 1);
  assert.equal(preparationWorker.state.terminateCalls, 0);
  assert.equal(preparationWorker.state.restoreCalls.length, 0);
  assert.ok(preparationWorker.state.codeCalls.every(
    (call) => call.programId === 'prepared-java-1'
  ));
  assert.deepEqual(
    preparationWorker.state.codeCalls.map((call) => call.inputs),
    [{ value: 1 }, { value: 2 }]
  );

  await preparation.program.dispose();
  await preparation.program.dispose();
  assert.deepEqual(preparationWorker.state.disposeCalls, ['prepared-java-1']);
  assert.equal(preparationWorker.state.terminateCalls, 0);
  provider.dispose();
  assert.equal(preparationWorker.state.terminateCalls, 1);
  await assert.rejects(
    preparation.program.executeIsolated({ inputs: { value: 3 } }),
    /already disposed/
  );
});

test('Java observer compile failure cannot block or rejudge the ordinary batch', async () => {
  const ordinary = createFakeClient();
  const compilerEntered = deferred<void>();
  const compile = deferred<JavaWorkerPreparedProgramResult>();
  const observer = createFakeClient({
    executePrepare: () => {
      compilerEntered.resolve();
      return compile.promise;
    },
  });
  let workers = 0;
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => [ordinary, observer][workers++]!.client,
  });
  const registration = createJavaJudgeReceiptProvider(provider, 'test-build');
  // Each observation reply is decoded fresh from the worker's event strings.
  assert.equal(registration.capabilities.observationReplyOwnership, 'transferred');
  // Every event is JSON.parse of a worker string, then spread: plain data only.
  assert.equal(registration.capabilities.observationReplyProvenance, 'structured-clone');
  const program = {
    code: 'class Solution { int value(int value) { return value; } }',
    functionName: 'value',
    executionStyle: 'solution-method' as const,
    runtimeVersion: 'test-build',
  };
  const preparing = provider.prepareProgram({ ...program, mode: 'code' });
  const observing = registration.prepareObservation(program, new AbortController().signal);
  const prepared = await preparing;
  assert(prepared.kind === 'prepared' && prepared.program.mode === 'code');
  await compilerEntered.promise;
  try {
    const batch = await prepared.program.executeBatchIsolated!({
      inputBatch: [{ value: 7 }, { value: 11 }],
      stopAtFirstRunaway: true,
    });
    assert.deepEqual(batch.map(completedOutput), [7, 11]);
    compile.resolve({ success: false, error: 'observer wrapper would not compile' });
    assert.deepEqual(await observing, { status: 'refused', reason: 'observer-prepare' });
    assert.deepEqual(ordinary.state.prepareCalls.map(({ mode }) => mode), ['code']);
    assert.deepEqual(observer.state.prepareCalls.map(({ mode }) => mode), ['trace']);
    assert.equal(ordinary.state.codeBatchCalls.length, 1);
    assert.equal(ordinary.state.terminateCalls, 0);
    assert.equal(observer.state.terminateCalls, 1);
    assert.equal(observer.state.codeBatchCalls.length, 0);
  } finally {
    compile.resolve({ success: false });
    await prepared.program.dispose();
    provider.dispose();
  }
});

test('Java prepared batches cross the worker boundary once for the entire runner lease', async () => {
  const preparationWorker = createFakeClient();
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => preparationWorker.client,
  });
  const preparation = await provider.prepareProgram({
    mode: 'code',
    code: 'class Solution { int value(int value) { return value; } }',
    functionName: 'value',
    executionStyle: 'solution-method',
  });
  if (preparation.kind !== 'prepared' || preparation.program.mode !== 'code') {
    throw new Error('Expected a prepared Java code program.');
  }

  const results = await preparation.program.executeBatchIsolated?.({
    inputBatch: [{ value: 3 }, { value: 5 }, { value: 8 }],
  });
  assert.ok(results);
  assert.deepEqual(results.map(completedOutput), [3, 5, 8]);
  assert.deepEqual(preparationWorker.state.codeBatchCalls, [
    {
      programId: 'prepared-java-1',
      inputBatch: [{ value: 3 }, { value: 5 }, { value: 8 }],
    },
  ]);
  assert.equal(preparationWorker.state.initCalls, 1);
  assert.equal(preparationWorker.state.prepareCalls.length, 1);
  assert.equal(preparationWorker.state.terminateCalls, 0);

  await preparation.program.dispose();
  provider.dispose();
});

test('releasing the Java standby preserves lazy restart and later preparation', async () => {
  const firstStandby = createFakeClient();
  const replacementStandby = createFakeClient();
  const clients = [
    firstStandby.client,
    replacementStandby.client,
  ];
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => {
      const client = clients.shift();
      if (!client) throw new Error('Unexpected extra Java worker.');
      return client;
    },
  });

  assert.deepEqual(await provider.init(), { success: true, loadTimeMs: 7 });
  provider.releaseStandby();
  provider.releaseStandby();
  assert.equal(firstStandby.state.terminateCalls, 1);

  assert.deepEqual(await provider.init(), { success: true, loadTimeMs: 7 });
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'class Solution { int value(int value) { return value; } }',
    functionName: 'value',
    executionStyle: 'solution-method',
  });
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') {
    throw new Error('Expected a prepared Java code program.');
  }
  assert.equal(replacementStandby.state.initCalls, 1);
  assert.equal(replacementStandby.state.prepareCalls.length, 1);
  assert.equal(replacementStandby.state.terminateCalls, 0);
  assert.equal(
    completedOutput(
      await prepared.program.executeIsolated({ inputs: { value: 9 } })
    ),
    9
  );

  await prepared.program.dispose();
  provider.dispose();
  assert.equal(replacementStandby.state.terminateCalls, 1);
  assert.throws(() => provider.releaseStandby(), /disposed/);
});

test('Java prepared program serializes concurrent case requests instead of overlapping workers', async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let activeExecutions = 0;
  let maximumActiveExecutions = 0;
  const executeCode = async (
    _programId: string,
    call: { inputs: Record<string, unknown> }
  ) => {
    activeExecutions += 1;
    maximumActiveExecutions = Math.max(
      maximumActiveExecutions,
      activeExecutions
    );
    if (call.inputs.value === 1) {
      firstEntered.resolve(undefined);
      await releaseFirst.promise;
    }
    activeExecutions -= 1;
    return {
      kind: 'completed' as const,
      output: call.inputs.value,
      consoleOutput: [],
      timings: { compileMs: 0, runMs: 1, totalMs: 1 },
      retirementRecommended: false,
    };
  };
  const preparationWorker = createFakeClient({ executeCode });
  let createdClients = 0;
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => {
      createdClients += 1;
      return preparationWorker.client;
    },
  });
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'class Solution { int value(int value) { return value; } }',
    functionName: 'value',
    executionStyle: 'solution-method',
  });
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') {
    throw new Error('Expected a prepared Java code program.');
  }

  const first = prepared.program.executeIsolated({
    inputs: { value: 1 },
  });
  await firstEntered.promise;
  const second = prepared.program.executeIsolated({
    inputs: { value: 2 },
  });
  await Promise.resolve();

  assert.equal(createdClients, 1);
  assert.equal(maximumActiveExecutions, 1);

  releaseFirst.resolve(undefined);
  assert.equal(completedOutput(await first), 1);
  assert.equal(completedOutput(await second), 2);
  assert.equal(maximumActiveExecutions, 1);
  assert.equal(createdClients, 1);

  await prepared.program.dispose();
  provider.dispose();
  assert.equal(preparationWorker.state.terminateCalls, 1);
});

test('caller cancellation interrupts the active Java process lease', async () => {
  const executionEntered = deferred();
  const preparationWorker = createFakeClient({
    executeCode: async (_programId, call) => {
      executionEntered.resolve(undefined);
      return new Promise((_, reject) => {
        call.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Process aborted', 'AbortError')),
          { once: true }
        );
      });
    },
  });
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => preparationWorker.client,
  });
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'class Solution { int value(int value) { return value; } }',
    functionName: 'value',
    executionStyle: 'solution-method',
  });
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') {
    throw new Error('Expected a prepared Java code program.');
  }

  const abortController = new AbortController();
  const execution = prepared.program.executeIsolated({
    inputs: { value: 1 },
    signal: abortController.signal,
  });
  await executionEntered.promise;
  abortController.abort();
  await assert.rejects(
    execution,
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError'
  );

  await prepared.program.dispose();
  provider.dispose();
  assert.equal(preparationWorker.state.terminateCalls, 1);
});

test('caller cancellation during Java client initialization does not spawn a retry worker', async () => {
  const initPosted = deferred();
  let createdWorkers = 0;
  let terminatedWorkers = 0;
  const workerFactory: NonNullable<JavaWorkerClientOptions['workerFactory']> =
    (): BrowserWorkerLike => {
      createdWorkers += 1;
      let terminated = false;
      const worker: BrowserWorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(message) {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'init'
          ) {
            initPosted.resolve(undefined);
          }
        },
        terminate() {
          if (terminated) return;
          terminated = true;
          terminatedWorkers += 1;
        },
      };
      queueMicrotask(() => {
        worker.onmessage?.({
          data: { type: 'worker-ready' },
        } as MessageEvent);
      });
      return worker;
    };
  const client = new JavaWorkerClient({
    workerUrl: '/workers/java-worker.js',
    workerFactory,
    debug: false,
  });
  const abortController = new AbortController();
  const initialization = client.init(abortController.signal);
  await initPosted.promise;

  abortController.abort();
  await assert.rejects(
    initialization,
    (error: unknown) =>
      error instanceof Error && error.name === 'AbortError'
  );
  await Promise.resolve();

  assert.equal(createdWorkers, 1);
  assert.equal(terminatedWorkers, 1);
  client.terminate();
  assert.equal(terminatedWorkers, 1);
});

test('disposing an active Java prepared program aborts once, drains the boundary, and rejects queued work', async () => {
  const activeEntered = deferred();
  const activeExecution = deferred<never>();
  const activeWorker = createFakeClient({
    executeCode: async () => {
      activeEntered.resolve(undefined);
      return activeExecution.promise;
    },
    onTerminate: () => {
      activeExecution.reject(new DOMException('Worker terminated', 'AbortError'));
    },
  });
  let createdClients = 0;
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => {
      createdClients += 1;
      return activeWorker.client;
    },
  });
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'class Solution { int hang(int value) { return value; } }',
    functionName: 'hang',
    executionStyle: 'solution-method',
  });
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') {
    throw new Error('Expected a prepared Java code program.');
  }

  const first = prepared.program
    .executeIsolated({ inputs: { value: 1 } })
    .then(
      () => ({ status: 'completed' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );
  await activeEntered.promise;
  const queued = prepared.program
    .executeIsolated({ inputs: { value: 2 } })
    .then(
      () => ({ status: 'completed' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );

  const disposal = prepared.program.dispose();
  const [firstResult, queuedResult] = await Promise.all([first, queued]);
  await disposal;

  assert.equal(firstResult.status, 'rejected');
  assert.ok(
    firstResult.status === 'rejected' &&
      firstResult.error instanceof DOMException &&
      firstResult.error.name === 'AbortError'
  );
  assert.equal(queuedResult.status, 'rejected');
  assert.match(
    queuedResult.status === 'rejected'
      ? String(queuedResult.error)
      : '',
    /already disposed/
  );
  assert.equal(createdClients, 1);
  assert.equal(activeWorker.state.terminateCalls, 1);

  await prepared.program.dispose();
  provider.dispose();
  assert.equal(activeWorker.state.terminateCalls, 2);
});

test('Java prepared provider owns and retires a failed preparation worker', async () => {
  const fake = createFakeClient({
    prepareResult: {
      success: false,
      error: 'incompatible types',
      errorLine: 4,
      consoleOutput: ['Solution.java:4: error'],
      timings: { compileMs: 3, totalMs: 5 },
    },
  });
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => fake.client,
  });
  const result = await provider.prepareProgram({
    mode: 'code',
    code: 'class Solution {',
    functionName: 'solve',
  });

  assert.deepEqual(result, {
    kind: 'failed',
    error: 'incompatible types',
    errorLine: 4,
    diagnosticStage: 'compile',
    consoleOutput: ['Solution.java:4: error'],
    timings: { compileMs: 3, totalMs: 5 },
  });
  assert.equal(fake.state.prepareCalls.length, 1);
  assert.equal(fake.state.terminateCalls, 1);
  provider.dispose();
  assert.equal(fake.state.terminateCalls, 1);
});

test('disposing the Java provider hard-aborts an active preparation exactly once', async () => {
  const preparationEntered = deferred();
  const activePreparation = deferred<never>();
  const fake = createFakeClient({
    executePrepare: async () => {
      preparationEntered.resolve(undefined);
      return activePreparation.promise;
    },
    onTerminate: () => {
      activePreparation.reject(
        new DOMException('Preparation worker terminated', 'AbortError')
      );
    },
  });
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => fake.client,
  });
  const preparation = provider
    .prepareProgram({
      mode: 'code',
      code: 'class Solution {}',
      functionName: 'solve',
    })
    .then(
      () => ({ status: 'completed' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );
  await preparationEntered.promise;

  provider.dispose();
  const result = await preparation;

  assert.equal(result.status, 'rejected');
  assert.ok(
    result.status === 'rejected' &&
      result.error instanceof DOMException &&
      result.error.name === 'AbortError'
  );
  assert.equal(fake.state.terminateCalls, 1);
  provider.dispose();
  assert.equal(fake.state.terminateCalls, 1);
});

test('Java prepared provider maps caller wall-clock limits without masking cancellation', async () => {
  const timeout = new ExecutionTimeoutError({
    runtimeLabel: 'Java',
    timeoutMs: 25,
  });
  const codeFake = createFakeClient({ codeFailure: timeout });
  const codeProvider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => codeFake.client,
  });
  const codePreparation = await codeProvider.prepareProgram({
    mode: 'code',
    code: 'class Solution {}',
    functionName: 'hang',
  });
  assert.equal(codePreparation.kind, 'prepared');
  if (
    codePreparation.kind !== 'prepared' ||
    codePreparation.program.mode !== 'code'
  ) {
    throw new Error('Expected a prepared Java code program.');
  }
  assert.deepEqual(
    await codePreparation.program.executeIsolated({
      inputs: {},
      limits: { wallClockMs: 25 },
    }),
    {
      kind: 'limit',
      reason: 'client-timeout',
      error: 'Java execution timed out after 0 seconds.',
      consoleOutput: [],
    }
  );
  // The runtime's default deadline is the learner's time limit too; it is
  // never reported as a provider failure.
  assert.deepEqual(
    await codePreparation.program.executeIsolated({ inputs: {} }),
    {
      kind: 'limit',
      reason: 'client-timeout',
      error: 'Java execution timed out after 0 seconds.',
      consoleOutput: [],
    }
  );
  await codePreparation.program.dispose();
  codeProvider.dispose();

  const traceFake = createFakeClient({ traceFailure: timeout });
  const traceProvider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => traceFake.client,
  });
  const tracePreparation = await traceProvider.prepareProgram({
    mode: 'trace',
    code: 'class Solution {}',
    functionName: 'hang',
  });
  assert.equal(tracePreparation.kind, 'prepared');
  if (
    tracePreparation.kind !== 'prepared' ||
    tracePreparation.program.mode !== 'trace'
  ) {
    throw new Error('Expected a prepared Java trace program.');
  }
  const traceResult = await tracePreparation.program.executeIsolated({
    inputs: {},
    limits: { wallClockMs: 25 },
  });
  assert.equal(traceResult.kind, 'limit');
  assert.equal(
    traceResult.kind === 'limit' ? traceResult.reason : undefined,
    'client-timeout'
  );
  assert.equal(traceResult.trace.language, 'java');
  await tracePreparation.program.dispose();
  traceProvider.dispose();

  const abort = new DOMException('Aborted by caller', 'AbortError');
  const abortFake = createFakeClient({ codeFailure: abort });
  const abortProvider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => abortFake.client,
  });
  const abortPreparation = await abortProvider.prepareProgram({
    mode: 'code',
    code: 'class Solution {}',
    functionName: 'hang',
  });
  if (
    abortPreparation.kind !== 'prepared' ||
    abortPreparation.program.mode !== 'code'
  ) {
    throw new Error('Expected a prepared Java code program.');
  }
  await assert.rejects(
    abortPreparation.program.executeIsolated({
      inputs: {},
      limits: { wallClockMs: 25 },
    }),
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError'
  );
  await abortPreparation.program.dispose();
  abortProvider.dispose();
});

test('runner retirement does not retire the warm Java compiler worker', async () => {
  const preparation = createFakeClient({
    retireAfterCodeCalls: new Set([1]),
  });
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => preparation.client,
  });
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'class Solution { int value(int value) { return value; } }',
    functionName: 'value',
    executionStyle: 'solution-method',
  });
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') {
    throw new Error('Expected a prepared Java code program.');
  }

  assert.equal(
    completedOutput(
      await prepared.program.executeIsolated({
        inputs: { value: 1 },
      })
    ),
    1
  );
  assert.equal(preparation.state.terminateCalls, 0);
  assert.equal(preparation.state.prepareCalls.length, 1);

  assert.equal(
    completedOutput(
      await prepared.program.executeIsolated({
        inputs: { value: 2 },
      })
    ),
    2
  );
  assert.equal(preparation.state.initCalls, 1);
  assert.equal(preparation.state.restoreCalls.length, 0);

  await prepared.program.dispose();
  provider.dispose();
  assert.equal(preparation.state.terminateCalls, 1);
  assert.deepEqual(preparation.state.disposeCalls, ['prepared-java-1']);
});

test('browser prepared construction requires an explicit worker and has no legacy fallback', () => {
  assert.throws(
    () =>
      createJavaBrowserPreparedExecutionProvider({
        workerUrl: '',
      }),
    /explicit workerUrl/
  );
});

test('Java batch trace selection requires one boolean per case', async () => {
  const client = new JavaWorkerClient({
    workerUrl: '/workers/java-worker.js',
    debug: false,
  });
  try {
    await assert.rejects(
      client.executePreparedTraceBatch(
        'prepared-java-1',
        { inputBatch: [{ value: 1 }], traceEnabledBatch: [] }
      ),
      /one boolean per batch case/
    );
    await assert.rejects(
      client.executePreparedTraceBatch(
        'prepared-java-1',
        {
          inputBatch: [{ value: 1 }],
          traceEnabledBatch: ['yes'] as unknown as readonly boolean[],
        }
      ),
      /one boolean per batch case/
    );
    assert.deepEqual(
      await client.executePreparedTraceBatch(
        'prepared-java-1',
        { inputBatch: [], traceEnabledBatch: [] }
      ),
      []
    );
  } finally {
    client.terminate();
  }
});

function completedOutput(
  result: { kind: string; output?: unknown; error?: string }
): unknown {
  if (result.kind !== 'completed') {
    throw new Error(result.error ?? `Expected completion, received ${result.kind}`);
  }
  return result.output;
}


test('a Java traced batch refuses only the case the tracer cannot trace', async () => {
  const refusal = new RuntimeProviderError('TraceCode could not trace this case.', { code: TRACE_UNAVAILABLE_CODE });
  const fake = createFakeClient({
    traceFailureFor: (inputs) => (inputs.value === 5 ? refusal : undefined),
  });
  const provider = createJavaPreparedExecutionProvider({
    createWorkerClient: () => fake.client,
  });
  const preparation = await provider.prepareProgram({
    mode: 'trace',
    code: 'class Solution { int value(int value) { return value; } }',
    functionName: 'value',
    executionStyle: 'solution-method',
  });
  if (preparation.kind !== 'prepared' || preparation.program.mode !== 'trace') {
    throw new Error('Expected a prepared Java trace program.');
  }
  const results = await preparation.program.executeBatchIsolated!({
    inputBatch: [{ value: 3 }, { value: 5 }, { value: 8 }],
    traceEnabledBatch: [false, true, false],
  });
  assert.deepEqual(results.map((result) => result.kind), ['completed', 'failed', 'completed']);
  assert.equal(fake.state.traceBatchCalls.length, 1);
  assert.deepEqual(fake.state.traceCalls, []);
  const refused = results[1]!;
  assert.deepEqual(
    refused.kind === 'failed' ? refused.providerFailure : undefined,
    { code: 'trace-unavailable', message: refusal.message }
  );
  assert.equal(refused.trace.events.length, 0);
  // The program keeps running cases: the next traced case is traced normally.
  const next = await preparation.program.executeIsolated({ inputs: { value: 8 } });
  assert.equal(next.kind, 'completed');
  assert.equal(fake.state.terminateCalls, 0);
  await preparation.program.dispose();
  provider.dispose();
});

test('a Java trace the client cannot read back refuses only that recorded case, without retiring the worker', async () => {
  // An event that refers to a call stack the trace never recorded.
  const unreadable = ['trace:{"kind":"line","line":2,"callStackRef":29}'];
  const replies: unknown[] = [
    { success: true, output: 1, executionTimeMs: 1, consoleOutput: [], sourceText: 'class Solution {}', events: unreadable },
    { success: true, output: 2, executionTimeMs: 1, consoleOutput: [], sourceText: 'class Solution {}', events: unreadable },
    { success: true, output: 3, executionTimeMs: 1, consoleOutput: [], sourceText: 'class Solution {}', events: [] },
  ];
  const batchReply = {
    success: true,
    results: [
      { success: true, output: 1, trace: { events: [] }, sourceText: '' },
      { success: true, output: 2, trace: { events: unreadable }, sourceText: '' },
      { success: true, output: 3, trace: { events: [] }, sourceText: '' },
    ],
  };
  let terminations = 0;
  const client = new JavaWorkerClient({
    workerUrl: '/workers/java-worker.js',
    debug: false,
    workerFactory: () => {
      const worker: BrowserWorkerLike = {
        onmessage: null,
        onerror: null,
        terminate() { terminations += 1; },
        postMessage(message) {
          const request = message as { id: string; type: string; protocolToken: string };
          const payload = request.type === 'execute-prepared-runtime-program'
            ? replies.shift()
            : request.type === 'execute-prepared-runtime-program-batch'
              ? batchReply
              : { success: true, loadTimeMs: 0 };
          queueMicrotask(() => worker.onmessage?.({ data: {
            id: request.id, protocolToken: request.protocolToken, type: 'result', payload,
          } } as MessageEvent));
        },
      };
      queueMicrotask(() => worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
      return worker;
    },
  });
  try {
    await assert.rejects(
      client.executePreparedWithTracing('prepared', { inputs: {} }),
      (error: unknown) => {
        assert.ok(isTraceUnavailableError(error), String(error));
        assert.equal((error as Error).message, 'TraceCode could not trace this case.');
        return true;
      }
    );
    // A case that did not record a trace is never refused as untraceable.
    await assert.rejects(
      client.executePreparedWithTracing('prepared', { inputs: {}, recordTrace: false }),
      (error: unknown) => !isTraceUnavailableError(error)
    );
    const traced = await client.executePreparedWithTracing('prepared', { inputs: {} });
    assert.equal(traced.output, 3);
    // The direct batch client refuses only the entry it cannot read back.
    const batch = await client.executePreparedTraceBatch('prepared', { inputBatch: [{}, {}, {}] });
    assert.deepEqual(
      batch.map((entry) => ({ success: entry.success, traceUnavailable: entry.traceUnavailable === true, error: entry.error })),
      [
        { success: true, traceUnavailable: false, error: undefined },
        { success: false, traceUnavailable: true, error: 'TraceCode could not trace this case.' },
        { success: true, traceUnavailable: false, error: undefined },
      ]
    );
    assert.equal(terminations, 0);
  } finally {
    client.terminate();
  }
});

test('a malformed Java trace reply is a provider protocol failure, never trace-unavailable', async (t) => {
  const malformed = {
    'missing events': {},
    'null events': { events: null },
    'string events': { events: 'trace:{}' },
    'object events': { events: { length: 0 } },
    'non-string event': { events: [{ kind: 'line', line: 1 }] },
  };
  const calls = {
    'direct trace': (client: JavaWorkerClient) =>
      client.executeWithTracing({ code: 'class Solution {}', functionName: 'f', inputs: {} }),
    'prepared trace': (client: JavaWorkerClient) =>
      client.executePreparedWithTracing('prepared', { inputs: {} }),
    'prepared case that recorded nothing': (client: JavaWorkerClient) =>
      client.executePreparedWithTracing('prepared', { inputs: {}, recordTrace: false }),
    'direct batch': (client: JavaWorkerClient) =>
      client.executePreparedTraceBatch('prepared', { inputBatch: [{}] }),
    'direct batch without a trace object': (client: JavaWorkerClient) =>
      client.executePreparedTraceBatch('missing-trace', { inputBatch: [{}] }),
  };
  for (const [shape, envelope] of Object.entries(malformed)) {
    for (const [path, call] of Object.entries(calls)) {
      await t.test(`${path}: ${shape}`, async () => {
        const result = { success: true, output: 1, executionTimeMs: 1, consoleOutput: [], sourceText: '' };
        const client = new JavaWorkerClient({
          workerUrl: '/workers/java-worker.js',
          debug: false,
          workerFactory: () => {
            const worker: BrowserWorkerLike = {
              onmessage: null,
              onerror: null,
              terminate() {},
              postMessage(message) {
                const request = message as { id: string; type: string; protocolToken: string; payload?: { programId?: string } };
                const payload = request.type === 'execute-prepared-runtime-program-batch'
                  ? {
                      success: true,
                      results: [request.payload?.programId === 'missing-trace'
                        ? result
                        : { ...result, trace: { ...envelope } }],
                    }
                  : request.type === 'execute-with-tracing' || request.type === 'execute-prepared-runtime-program'
                    ? { ...result, ...envelope }
                    : { success: true, loadTimeMs: 0 };
                queueMicrotask(() => worker.onmessage?.({ data: {
                  id: request.id, protocolToken: request.protocolToken, type: 'result', payload,
                } } as MessageEvent));
              },
            };
            queueMicrotask(() => worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
            return worker;
          },
        });
        try {
          await assert.rejects(call(client), (error: unknown) => {
            assert.ok(!isTraceUnavailableError(error), String(error));
            assert.ok(isRuntimeProviderError(error), String(error));
            assert.equal(error.reason, 'protocol');
            return true;
          });
        } finally {
          client.terminate();
        }
      });
    }
  }
});

test('Java code and trace batches preserve guest limits and reserve transport time for JVM recovery', async () => {
  const guestLimits: number[] = [];
  const deadlines: number[] = [];
  const client = new JavaWorkerClient({
    workerUrl: '/workers/java-worker.js',
    debug: false,
    workerFactory: () => {
      const worker: BrowserWorkerLike = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(message) {
          const request = message as { id: string; type: string; protocolToken: string; payload: { perCaseWallClockMs: number } };
          const batch = request.type === 'execute-prepared-runtime-program-batch';
          if (batch) guestLimits.push(request.payload.perCaseWallClockMs);
          const results = [
            { success: false, error: 'guest timed out', timeoutReason: 'client-timeout', trace: { events: [] }, sourceText: '' },
            { success: true, output: 1, trace: { events: [] }, sourceText: '' },
          ];
          const admissionId = (request.payload as { admissionId?: number }).admissionId;
          if (batch && admissionId !== undefined) queueMicrotask(() => {
            for (const [caseIndex, result] of results.entries()) {
              for (const stage of ['ordinary-case-started', 'ordinary-case-finished']) {
                worker.onmessage?.({ data: {
                  id: request.id, protocolToken: request.protocolToken, type: 'runtime-progress',
                  payload: { stage, detail: { admissionId, caseIndex, result } },
                } } as MessageEvent);
              }
            }
          });
          queueMicrotask(() => worker.onmessage?.({ data: {
            id: request.id, protocolToken: request.protocolToken, type: 'result',
            payload: batch ? {
              success: true,
              results,
            } : { success: true, loadTimeMs: 0 },
          } } as MessageEvent));
        },
      };
      queueMicrotask(() => worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
      return worker;
    },
  });
  // Observe the transport boundary while retaining its real Effect watchdog.
  const core = (client as unknown as { core: WorkerSessionCore }).core;
  const withDeadline = core.withExecutionDeadline.bind(core);
  core.withExecutionDeadline = (effect, timeoutMs) => {
    deadlines.push(timeoutMs);
    return withDeadline(effect, timeoutMs);
  };
  try {
    const call = { inputBatch: [{ value: 0 }, { value: 1 }], limits: { wallClockMs: 1_200 } };
    const code = await client.executePreparedCodeBatch('prepared', call);
    assert.deepEqual(code.map(result => result.kind), ['limit', 'completed']);
    const trace = await client.executePreparedTraceBatch('prepared', call);
    assert.equal(trace[0]?.timeoutReason, 'client-timeout');
    assert.equal(trace[1]?.output, 1);
    assert.deepEqual(guestLimits, [1_200, 1_200]);
    assert.equal(deadlines.length, 2);
    for (const deadline of deadlines) {
      // A 1.2s guest timeout plus 1.5s process replacement must leave the
      // following case its full guest budget, without an unbounded watchdog.
      assert.ok(deadline >= 1_200 + 1_500 + 1_200);
      assert.ok(deadline <= 120_000 + 2 * 1_200);
    }
  } finally {
    client.terminate();
  }
});

type ScriptedBatch = {
  start(index: number): void;
  finish(index: number, result: object, admissionId?: number): void;
  terminal(payload: object): void;
  crash(): void;
};

function scriptedJavaBatch() {
  const commands: ReturnType<typeof deferred<ScriptedBatch>>[] = [];
  const client = new JavaWorkerClient({
    workerUrl: '/workers/java-worker.js',
    debug: false,
    workerFactory: () => {
      const worker: BrowserWorkerLike = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(message) {
          const { id, type, protocolToken, payload } = message as {
            id: string; type: string; protocolToken: string; payload: { admissionId: number };
          };
          // Retain the listeners to model events already queued at teardown.
          const onmessage = worker.onmessage;
          const onerror = worker.onerror;
          const post = (type: string, payload: object) => onmessage?.({ data: {
            id, type, protocolToken, payload,
          } } as MessageEvent);
          if (type === 'execute-prepared-runtime-program-batch') {
            const progress = (stage: string, detail: object) => post('runtime-progress', { stage, detail });
            commands.shift()!.resolve({
              start: (caseIndex) => progress('ordinary-case-started', { caseIndex, admissionId: payload.admissionId }),
              finish: (caseIndex, result, admissionId = payload.admissionId) =>
                progress('ordinary-case-finished', { caseIndex, admissionId, result }),
              terminal: (payload) => post(type, payload),
              crash: () => onerror?.({ message: 'service loss, completion uncertain' } as ErrorEvent),
            });
          } else {
            queueMicrotask(() => post(type, type === 'prepare-runtime-program' ? {
              success: true,
              programId: 'prepared',
              snapshot: { schema: 'tracecode.java.prepared-program-snapshot.v1', programId: 'prepared' },
            } : { success: true, loadTimeMs: 0 }));
          }
        },
      };
      queueMicrotask(() => worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
      return worker;
    },
  });
  const begin = (stopAtFirstRunaway = false) => {
    const command = deferred<ScriptedBatch>();
    const starts: number[] = [];
    commands.push(command);
    const outcome = client.executePreparedCodeBatch('prepared', {
      inputBatch: [{}, {}, {}], stopAtFirstRunaway,
    }, (index) => starts.push(index));
    // The test attaches its assertion after it has sent the scripted messages.
    void outcome.catch(() => undefined);
    return { command: command.promise, outcome, starts };
  };
  const waitForBatch = () => {
    const command = deferred<ScriptedBatch>();
    commands.push(command);
    return command.promise;
  };
  return { client, begin, waitForBatch };
}

const finishedA = { success: true, output: { answer: 7 }, consoleOutput: ['A printed'] };
const finishedB = { success: true, output: 8, consoleOutput: [] };
const runaway = { success: false, error: 'guest ran out of time', timeoutReason: 'client-timeout', consoleOutput: [] };

for (const failure of ['deadline', 'crash', 'failed-terminal'] as const) {
  test(`Java ordinary batch keeps A after ${failure} during B`, { timeout: 5_000 }, async (t) => {
    const { client, begin } = scriptedJavaBatch();
    t.after(() => client.terminate());
    if (failure === 'deadline') {
      const core = (client as unknown as { core: WorkerSessionCore }).core;
      const withDeadline = core.withExecutionDeadline.bind(core);
      core.withExecutionDeadline = (effect) => withDeadline(effect, 75);
    }
    const first = begin();
    const old = await first.command;
    old.start(0);
    old.finish(0, finishedA);
    old.start(1);
    if (failure === 'crash') old.crash();
    if (failure === 'failed-terminal') {
      old.terminal({ success: false, results: [], error: 'service loss, completion uncertain' });
    }
    let prefix: InterruptedCodeBatchError['prefix'] | undefined;
    await assert.rejects(first.outcome, (error) => {
      assert(error instanceof InterruptedCodeBatchError);
      assert.match(error.message, failure === 'deadline' ? /transport deadline/ : /service loss, completion uncertain/);
      prefix = error.prefix;
      assert.deepEqual(prefix.map((row) => [row.kind, completedOutput(row), row.consoleOutput]),
        [['completed', { answer: 7 }, ['A printed']]]);
      return true;
    });
    assert.deepEqual(first.starts, [0, 1]);
    if (failure !== 'failed-terminal') {
      const next = begin(true);
      const current = await next.command;
      old.finish(1, finishedB);
      old.finish(0, finishedA);
      old.terminal({ success: true, results: [finishedA, finishedB, finishedB] });
      assert.equal(prefix?.length, 1);
      current.start(0);
      current.finish(0, runaway);
      current.terminal({ success: false, resultsStreamed: 1 });
      assert.deepEqual((await next.outcome).map((row) => row.kind), ['limit']);
      assert.deepEqual(next.starts, [0]);
    }
  });
}

test('Java stopping batch keeps its guest runaway even if the terminal is lost', async (t) => {
  const { client, begin } = scriptedJavaBatch();
  t.after(() => client.terminate());
  const { command, outcome, starts } = begin(true);
  const worker = await command;
  worker.start(0);
  worker.finish(0, finishedA);
  worker.start(1);
  worker.finish(1, runaway);
  worker.crash();
  const results = await outcome;
  assert.deepEqual(results.map((row) => row.kind), ['completed', 'limit']);
  assert.deepEqual(starts, [0, 1]);
});

for (const invalid of ['changed result', 'count', 'out of order', 'duplicate', 'wrong admission', 'unadmitted'] as const) {
  test(`Java batch rejects ${invalid} as a protocol error`, async (t) => {
    const { client, begin } = scriptedJavaBatch();
    t.after(() => client.terminate());
    const { command, outcome } = begin(true);
    const worker = await command;
    if (invalid !== 'unadmitted') worker.start(0);
    worker.finish(invalid === 'out of order' ? 1 : 0, runaway, invalid === 'wrong admission' ? 12345 : undefined);
    if (invalid === 'duplicate') worker.finish(0, runaway);
    worker.terminal(invalid === 'count'
      ? { success: false, resultsStreamed: 2 }
      : { success: false, results: [invalid === 'changed result' ? { ...runaway, error: 'changed' } : runaway] });
    await assert.rejects(outcome, { name: 'RuntimeProviderError', reason: 'protocol' });
  });
}

test('Java batch waits for the terminal and accepts an exactly matching result', async (t) => {
  const { client, begin } = scriptedJavaBatch();
  t.after(() => client.terminate());
  const { command, outcome } = begin(true);
  const worker = await command;
  let settled = false;
  void outcome.then(() => { settled = true; }, () => { settled = true; });
  worker.start(0);
  worker.finish(0, runaway);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  worker.terminal({ success: false, results: [{ ...runaway }] });
  assert.deepEqual((await outcome).map((row) => row.kind), ['limit']);
});

for (const failure of ['deadline', 'crash'] as const) {
  test(`Java Judge publishes A and attributes unfinished rows to the provider after ${failure}`, {
    timeout: 5_000,
  }, async (t) => {
    const { client, waitForBatch } = scriptedJavaBatch();
    if (failure === 'deadline') {
      const core = (client as unknown as { core: WorkerSessionCore }).core;
      const withDeadline = core.withExecutionDeadline.bind(core);
      core.withExecutionDeadline = (effect) => withDeadline(effect, 75);
    }
    const provider = createJavaPreparedExecutionProvider({ createWorkerClient: () => client });
    const registration = createJavaJudgeReceiptProvider(provider, 'test-build');
    const host = createBrowserJudgeHostFromRuntimeHost(createBrowserRuntimeHost({
      providers: ['java'],
      featureOverrides: { worker: true, webAssembly: true, webCrypto: true, sharedArrayBuffer: true },
      providerRegistry: createBrowserRuntimeProviderRegistry([{
        id: 'scripted-java',
        languages: ['java'],
        create: () => ({
          preparedProviders: new Map([['java', provider]]),
          judgeReceiptProviders: new Map([['java', registration]]),
          disposeLanguage() {},
          dispose: () => provider.dispose(),
        }),
      }]),
    }));
    t.after(() => host.dispose());
    const bundle = await createAlgorithmJudgeBundle({
      id: 'java-submit-transport-loss',
      language: 'java',
      code: 'class Solution { public int solve(int n) { return n; } }',
      functionName: 'solve',
      executionStyle: 'solution-method',
      cases: ['A', 'B', 'C'].map((id, n) => ({ id, input: { n }, expected: { answer: 7 } })),
    });
    const command = waitForBatch();
    const reply = host.evaluateAlgorithm({ bundle });
    const worker = await command;
    worker.start(0);
    worker.finish(0, finishedA);
    worker.start(1);
    if (failure === 'crash') worker.crash();
    const { evaluation, passedCount } = await reply;
    const [a, b, c] = evaluation.cases;
    assert.equal(passedCount, 1);
    assert.equal(a?.caseId, 'A');
    assert.deepEqual(a.value, { answer: 7 });
    assert.equal(a.stdout, 'A printed\n');
    assert.equal(a.failure, undefined);
    assert.deepEqual([b?.caseId, c?.caseId], ['B', 'C']);
    for (const row of [b!, c!]) {
      assert.equal(row.failure?.origin, 'provider');
      assert.equal(row.failure.reason, 'runtime-failure');
      assert.match(row.failure.message ?? '', failure === 'deadline' ? /transport deadline/ : /service loss, completion uncertain/);
      assert.equal(row.timedOut, false);
      assert.equal(row.stdout, '');
      assert.equal(row.stderr, '');
    }
  });
}
