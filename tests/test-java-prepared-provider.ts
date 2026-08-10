#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEmptyRuntimeTrace,
  type RuntimeProgramPreparationCall,
} from '../packages/runtime-contracts/src/index';
import {
  ExecutionTimeoutError,
} from '../packages/runtime-browser/src/internal';
import {
  createJavaBrowserPreparedExecutionProvider,
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
        state.traceCalls.push({ programId, inputs });
        return {
          success: true,
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
    caseIsolation: 'fresh-case-state',
    maxConcurrency: 1,
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
