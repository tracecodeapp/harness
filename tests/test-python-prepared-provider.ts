import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPythonBrowserRuntimeProvider,
  createPythonPreparedExecutionProvider,
  createPythonRuntimeClient,
  PythonAlgorithmFastBatchUnavailableError,
  type PythonPreparedProgramArtifact,
  type PythonWorkerClient,
} from '../packages/runtime-python/src/index';
import {
  ExecutionTimeoutError,
  WorkerCrashedError,
} from '../packages/runtime-browser/src/internal';
import type {
  CodeExecutionBatchResult,
  CodeExecutionResult,
  RuntimeProgramPreparationCall,
} from '../packages/runtime-contracts/src/index';

function preparationCall(
  mode: 'code' | 'trace' = 'code'
): RuntimeProgramPreparationCall {
  return {
    mode,
    code: 'def solve(value):\n    return value',
    functionName: 'solve',
    executionStyle: 'function',
  };
}

function artifact(
  mode: 'code' | 'trace',
  tier: 'algorithm-fast' | 'judge-compatible' | 'hard-isolated' = 'hard-isolated'
): PythonPreparedProgramArtifact {
  return {
    schemaVersion: 'tracecode.python.prepared-program.v4',
    fingerprint: {
      cacheTag: 'cpython-test',
      magicNumber: 'test',
      marshalVersion: 4,
    },
    mode,
    code: 'def solve(value):\n    return value',
    functionName: 'solve',
    executionStyle: 'function',
    traceOptions: {},
    isolationProfile: {
      tier,
      reasons: tier === 'algorithm-fast' ? [] : ['test-fixture'],
    },
    ...(tier === 'algorithm-fast'
      ? { algorithmFastBatchCode: 'algorithm-fast-artifact' }
      : {}),
    userCode: 'user-artifact',
    executorCode: 'executor-artifact',
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

test('Python prepared provider compiles once and executes in owned fresh workers', async () => {
  const calls: Array<{ worker: number; method: string; value?: unknown }> = [];
  const workers: Array<{ terminated: boolean }> = [];
  const codeResult: CodeExecutionResult = {
    kind: 'completed',
    output: 42,
    consoleOutput: [],
    timings: {
      totalMs: 3,
      runMs: 3,
      compileCacheHit: true,
      artifactCacheHit: true,
    },
  };
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = workers.length;
    const state = { terminated: false };
    workers.push(state);
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare', value: call });
        return {
          success: true as const,
          artifact: artifact(call.mode),
          mode: call.mode,
          consoleOutput: ['prepared once'],
          timings: {
            totalMs: 11,
            compileMs: 11,
            compileCacheHit: false,
            artifactCacheHit: false,
          },
        };
      },
      async executePreparedCode(
        handle: { artifact: PythonPreparedProgramArtifact },
        call: { inputs: Record<string, unknown>; signal?: AbortSignal }
      ) {
        calls.push({ worker, method: 'execute-code', value: { handle, call } });
        if (call.signal?.aborted) {
          throw call.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        return codeResult;
      },
      terminate() {
        assert.equal(state.terminated, false, `Worker ${worker} terminated twice`);
        state.terminated = true;
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };

  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient,
  });
  assert.deepEqual(await provider.init(), { success: true, loadTimeMs: 1 });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (preparation.kind !== 'prepared') return;

  assert.deepEqual(preparation.consoleOutput, ['prepared once']);
  assert.equal(preparation.timings?.compileMs, 11);
  assert.deepEqual(preparation.program.capabilities, {
    profile: 'compatibility',
    caseIsolation: 'fresh-case-state',
    maxConcurrency: 1,
    // Python batches stop themselves at the first runaway case.
    stopsAtFirstRunaway: true,
  });
  assert.equal(preparation.program.mode, 'code');
  if (preparation.program.mode !== 'code') return;

  const inputs = { value: [42] };
  const result = await preparation.program.executeIsolated({ inputs });
  assert.deepEqual(result, codeResult);
  assert.deepEqual(inputs, { value: [42] });

  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(
    preparation.program.executeIsolated({
      inputs: { value: 1 },
      signal: controller.signal,
    }),
    { name: 'AbortError' }
  );

  await preparation.program.dispose();
  await preparation.program.dispose();
  provider.terminate();
  assert.equal(
    calls.filter((call) => call.method === 'prepare').length,
    1,
    'Provider must compile exactly once'
  );
  const preparationWorker = calls.find(
    (call) => call.method === 'prepare'
  )?.worker;
  const executor = calls.find((call) => call.method === 'execute-code')?.worker;
  assert.equal(
    preparationWorker,
    executor,
    'Prepared execution must consume the same disposable interpreter that prepared its artifact'
  );
  assert.equal(
    calls.filter((call) => call.method === 'execute-code').length,
    1
  );
  assert.ok(workers.every((worker) => worker.terminated));
  await assert.rejects(
    preparation.program.executeIsolated({ inputs: { value: 1 } }),
    /disposed/
  );
});

test('Python algorithm-fast provider executes a case vector in one warmed worker', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode, 'algorithm-fast'),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCodeBatch(
        _handle: unknown,
        call: { inputBatch: readonly Record<string, unknown>[] }
      ): Promise<CodeExecutionBatchResult> {
        calls.push({ worker, method: 'execute-batch' });
        return {
          results: call.inputBatch.map((inputs) => ({
            kind: 'completed' as const,
            output: inputs.value,
            consoleOutput: [],
          })),
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient,
  });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code' ||
    !preparation.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
  });

  assert.deepEqual(
    results.map((result) =>
      result.kind === 'completed' ? result.output : undefined
    ),
    [1, 2, 3]
  );
  assert.equal(
    calls.filter((call) => call.method === 'prepare').length,
    1
  );
  assert.equal(
    calls.filter((call) => call.method === 'execute-batch').length,
    1
  );
  assert.equal(
    new Set(
      calls
        .filter((call) => call.method === 'execute-batch')
        .map((call) => call.worker)
    ).size,
    1
  );
  await preparation.program.dispose();
  provider.terminate();
});

test('Python judge-compatible provider retains one worker for the generic case batch', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode, 'judge-compatible'),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCodeBatch(
        _handle: unknown,
        call: { inputBatch: readonly Record<string, unknown>[] }
      ): Promise<CodeExecutionBatchResult> {
        calls.push({ worker, method: 'execute-batch' });
        return {
          results: call.inputBatch.map((inputs) => ({
            kind: 'completed' as const,
            output: inputs.value,
            consoleOutput: [],
          })),
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code' ||
    !preparation.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
  });
  assert.deepEqual(
    results.map((result) =>
      result.kind === 'completed' ? result.output : undefined
    ),
    [1, 2, 3]
  );
  assert.equal(calls.filter((call) => call.method === 'execute-batch').length, 1);
  assert.equal(calls.filter((call) => call.method === 'execute-code').length, 0);
  assert.equal(
    calls.find((call) => call.method === 'prepare')?.worker,
    calls.find((call) => call.method === 'execute-batch')?.worker
  );
  await preparation.program.dispose();
  provider.terminate();
});

test('Python algorithm-fast driver failure retries each case in a hard-isolated worker', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode, 'algorithm-fast'),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCodeBatch() {
        calls.push({ worker, method: 'execute-batch' });
        throw new PythonAlgorithmFastBatchUnavailableError();
      },
      async executePreparedCode(
        _handle: unknown,
        call: { inputs: Record<string, unknown> }
      ): Promise<CodeExecutionResult> {
        calls.push({ worker, method: 'execute-code' });
        return {
          kind: 'completed',
          output: call.inputs.value,
          consoleOutput: [],
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code' ||
    !preparation.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
  });
  assert.deepEqual(
    results.map((result) =>
      result.kind === 'completed' ? result.output : undefined
    ),
    [1, 2, 3]
  );
  const batchExecutions = calls.filter(
    (call) => call.method === 'execute-batch'
  );
  const compatibilityExecutions = calls.filter(
    (call) => call.method === 'execute-code'
  );
  assert.equal(batchExecutions.length, 1);
  assert.equal(compatibilityExecutions.length, 3);
  assert.equal(
    new Set([
      ...batchExecutions.map((call) => call.worker),
      ...compatibilityExecutions.map((call) => call.worker),
    ]).size,
    4
  );
  await preparation.program.dispose();
  provider.terminate();
});

test('Python algorithm-fast trace batch failure retries each case in a fresh worker', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode, 'algorithm-fast'),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedTraceBatch() {
        calls.push({ worker, method: 'execute-trace-batch' });
        throw new PythonAlgorithmFastBatchUnavailableError();
      },
      async executePreparedTrace(
        _handle: unknown,
        call: { inputs: Record<string, unknown> }
      ) {
        calls.push({ worker, method: 'execute-trace' });
        return {
          success: true,
          output: call.inputs.value,
          trace: { events: [] },
          executionTimeMs: 1,
          consoleOutput: [],
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall('trace'));
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'trace' ||
    !preparation.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
  });
  assert.deepEqual(
    results.map((result) =>
      result.kind === 'completed' ? result.output : undefined
    ),
    [1, 2, 3]
  );
  const batchExecutions = calls.filter(
    (call) => call.method === 'execute-trace-batch'
  );
  const compatibilityExecutions = calls.filter(
    (call) => call.method === 'execute-trace'
  );
  assert.equal(batchExecutions.length, 1);
  assert.equal(compatibilityExecutions.length, 3);
  assert.equal(
    new Set([
      ...batchExecutions.map((call) => call.worker),
      ...compatibilityExecutions.map((call) => call.worker),
    ]).size,
    4
  );
  await preparation.program.dispose();
  provider.terminate();
});

test('Python fast trace batches retain one worker and cross its boundary once', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode, 'algorithm-fast'),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedTraceBatch(
        _handle: unknown,
        call: { inputBatch: readonly Record<string, unknown>[] }
      ) {
        calls.push({ worker, method: 'execute-trace-batch' });
        return {
          results: call.inputBatch.map((inputs) => ({
            success: true,
            output: inputs.value,
            executionTimeMs: 1,
            consoleOutput: [],
          })),
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall('trace'));
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'trace' ||
    !preparation.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
  });
  assert.deepEqual(
    results.map((result) =>
      result.kind === 'completed' ? result.output : undefined
    ),
    [1, 2, 3]
  );
  assert.equal(
    calls.filter((call) => call.method === 'execute-trace-batch').length,
    1
  );
  const secondResults = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 4 }],
  });
  assert.equal(
    secondResults[0]?.kind === 'completed'
      ? secondResults[0].output
      : undefined,
    4
  );
  assert.equal(
    new Set(
      calls
        .filter((call) => call.method === 'execute-trace-batch')
        .map((call) => call.worker)
    ).size,
    1
  );
  await assert.rejects(
    preparation.program.executeBatchIsolated({
      inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
      traceEnabledBatch: [true],
    }),
    /one boolean per batch case/
  );
  await assert.rejects(
    preparation.program.executeBatchIsolated({
      inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
      traceEnabledBatch: [true, 0, false] as unknown as boolean[],
    }),
    /one boolean per batch case/
  );
  await preparation.program.dispose();
  provider.terminate();
});

test('Python fast trace retention falls back for custom inputs and poisons on client timeout', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode, 'algorithm-fast'),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedTrace(
        _handle: unknown,
        call: { inputs: Record<string, unknown> }
      ) {
        calls.push({ worker, method: 'execute-trace' });
        if (call.inputs.timeout === true) {
          return {
            success: false,
            error: 'timed out',
            timeoutReason: 'client-timeout',
            executionTimeMs: 10,
            consoleOutput: [],
          };
        }
        return {
          success: true,
          output: call.inputs.value,
          executionTimeMs: 1,
          consoleOutput: [],
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall('trace'));
  assert.equal(preparation.kind, 'prepared');
  if (preparation.kind !== 'prepared' || preparation.program.mode !== 'trace') {
    return;
  }
  assert.equal(preparation.program.capabilities.profile, 'fast');

  await preparation.program.executeIsolated({ inputs: { value: 1 } });
  await preparation.program.executeIsolated({ inputs: { value: 2 } });
  await preparation.program.executeIsolated({
    inputs: { root: { __type__: 'TreeNode', val: 3 } },
  });
  await preparation.program.executeIsolated({ inputs: { timeout: true } });
  await preparation.program.executeIsolated({ inputs: { value: 4 } });

  const workers = calls
    .filter((call) => call.method === 'execute-trace')
    .map((call) => call.worker);
  assert.deepEqual(workers, [0, 0, 0, 1, 2]);
  assert.deepEqual(
    calls.filter((call) => call.method === 'terminate').map((call) => call.worker),
    [0, 1]
  );
  await preparation.program.dispose();
  assert.deepEqual(
    calls.filter((call) => call.method === 'terminate').map((call) => call.worker),
    [0, 1, 2]
  );
  provider.terminate();
});

test('Python hard-isolated batches retire one outer worker per case', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCode(
        _handle: unknown,
        call: { inputs: Record<string, unknown> }
      ): Promise<CodeExecutionResult> {
        calls.push({ worker, method: 'execute-code' });
        return {
          kind: 'completed',
          output: call.inputs.value,
          consoleOutput: [],
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code' ||
    !preparation.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
  });
  assert.deepEqual(
    results.map((result) =>
      result.kind === 'completed' ? result.output : undefined
    ),
    [1, 2, 3]
  );
  const executions = calls.filter((call) => call.method === 'execute-code');
  assert.equal(executions.length, 3);
  assert.equal(new Set(executions.map((call) => call.worker)).size, 3);
  assert.equal(calls.filter((call) => call.method === 'execute-batch').length, 0);
  await preparation.program.dispose();
  provider.terminate();
});

test('Python hard-isolated batches preserve per-case client timeout outcomes and continue', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCode(
        _handle: unknown,
        call: { inputs: Record<string, unknown> }
      ): Promise<CodeExecutionResult> {
        calls.push({ worker, method: 'execute-code' });
        if (call.inputs.value === 2) {
          throw new ExecutionTimeoutError({
            timeoutMs: 5,
            runtimeLabel: 'Python',
          });
        }
        return {
          kind: 'completed',
          output: call.inputs.value,
          consoleOutput: [],
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code' ||
    !preparation.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
    limits: { wallClockMs: 5 },
  });
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], {
    kind: 'completed',
    output: 1,
    consoleOutput: [],
  });
  assert.deepEqual(results[1], {
    kind: 'limit',
    reason: 'client-timeout',
    error: 'Python execution timed out after 0 seconds.',
    consoleOutput: [],
    timings: {
      totalMs: 5,
      runMs: 5,
      artifactCacheHit: true,
    },
  });
  assert.deepEqual(results[2], {
    kind: 'completed',
    output: 3,
    consoleOutput: [],
  });
  const executions = calls.filter((call) => call.method === 'execute-code');
  assert.equal(executions.length, 3);
  assert.equal(new Set(executions.map((call) => call.worker)).size, 3);
  await preparation.program.dispose();
  provider.terminate();
});

test('Python judge-compatible batch contains worker crashes in the failing case', async () => {
  const calls: Array<{ worker: number; value: unknown }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        return {
          success: true as const,
          artifact: artifact(call.mode, 'judge-compatible'),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCodeBatch(
        _handle: unknown,
        call: { inputBatch: readonly Record<string, unknown>[] }
      ): Promise<CodeExecutionBatchResult> {
        calls.push({ worker, value: call.inputBatch.map((inputs) => inputs.value) });
        return {
          results: call.inputBatch.map((inputs) =>
            inputs.value === 1
              ? {
                  kind: 'failed' as const,
                  error: 'Python worker failed while executing this case: synthetic worker crash',
                  diagnosticStage: 'runtime' as const,
                  consoleOutput: [],
                }
              : {
                  kind: 'completed' as const,
                  output: inputs.value,
                  consoleOutput: [],
                }
          ),
        };
      },
      terminate() {},
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code' ||
    !preparation.program.executeBatchIsolated
  ) return;

  const results = await preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }],
  });
  assert.deepEqual(results, [
    {
      kind: 'failed',
      error:
        'Python worker failed while executing this case: synthetic worker crash',
      diagnosticStage: 'runtime',
      consoleOutput: [],
    },
    { kind: 'completed', output: 2, consoleOutput: [] },
  ]);
  assert.deepEqual(calls, [
    { worker: 0, value: [1, 2] },
  ]);
  await preparation.program.dispose();
  provider.terminate();
});

test('Python judge-compatible batch retains one worker across a healthy batch', async () => {
  const calls: Array<{ worker: number; method: string }> = [];
  let nextWorker = 0;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        calls.push({ worker, method: 'warmup' });
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        calls.push({ worker, method: 'prepare' });
        return {
          success: true as const,
          artifact: artifact(call.mode, 'judge-compatible'),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCodeBatch(
        _handle: unknown,
        call: { inputBatch: readonly Record<string, unknown>[] }
      ): Promise<CodeExecutionBatchResult> {
        calls.push({ worker, method: 'execute-batch' });
        return {
          results: call.inputBatch.map((inputs) => ({
            kind: 'completed' as const,
            output: inputs.value,
            consoleOutput: [],
          })),
        };
      },
      terminate() {
        calls.push({ worker, method: 'terminate' });
      },
    } as unknown as PythonWorkerClient;
  };
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code' ||
    !preparation.program.executeBatchIsolated
  ) {
    return;
  }

  const execution = preparation.program.executeBatchIsolated({
    inputBatch: [{ value: 1 }, { value: 2 }],
    limits: { wallClockMs: 1 },
  });
  const results = await execution;
  assert.deepEqual(
    results.map((result) =>
      result.kind === 'completed' ? result.output : undefined
    ),
    [1, 2]
  );
  assert.equal(calls.filter((call) => call.method === 'execute-batch').length, 1);
  assert.equal(
    calls.filter((call) => call.method === 'warmup').length,
    1,
    'Judge-compatible batches should retain one warm worker'
  );
  await preparation.program.dispose();
  provider.terminate();
});

test('Python prepared provider aborts active and queued work before disposal resolves', async () => {
  let started = 0;
  let active = 0;
  let maxActive = 0;
  let terminatedWhileActive = false;
  const workerExecutions: number[] = [];
  const workerTerminations: number[] = [];
  let nextWorker = 0;

  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    let terminated = false;
    return {
      async warmup() {
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        return {
          success: true as const,
          artifact: artifact(call.mode),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCode(
        _handle: unknown,
        call: { signal?: AbortSignal }
      ) {
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        workerExecutions.push(worker);
        return new Promise<CodeExecutionResult>((_resolve, reject) => {
          call.signal?.addEventListener(
            'abort',
            () => reject(call.signal?.reason ?? new Error('aborted')),
            { once: true }
          );
        }).finally(() => {
          active -= 1;
        });
      },
      terminate() {
        assert.equal(terminated, false, `Worker ${worker} terminated twice`);
        terminated = true;
        if (active > 0) terminatedWhileActive = true;
        workerTerminations.push(worker);
      },
    } as unknown as PythonWorkerClient;
  };

  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient,
  });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code'
  ) return;

  const first = preparation.program.executeIsolated({ inputs: { value: 1 } });
  const second = preparation.program.executeIsolated({ inputs: { value: 2 } });
  await waitUntil(
    () => started === 1,
    'The first prepared Python case never started'
  );
  assert.equal(active, 1);
  assert.equal(maxActive, 1);

  const disposal = preparation.program.dispose();
  await assert.rejects(
    preparation.program.executeIsolated({ inputs: { value: 3 } }),
    /disposed/
  );

  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  await disposal;
  await preparation.program.dispose();
  provider.terminate();

  assert.equal(firstResult.status, 'rejected');
  assert.equal(secondResult.status, 'rejected');
  assert.equal(started, 1, 'Queued work started after disposal began');
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(terminatedWhileActive, true);
  assert.equal(
    workerExecutions.length,
    1,
    'A queued case reached a Python worker after disposal'
  );
  assert.deepEqual(
    workerTerminations.sort((left, right) => left - right),
    [0, 1],
    'Compiler and active case worker were not retired exactly once'
  );
});

test('Python prepared provider aborts a case while its worker is still warming', async () => {
  const warming = deferred();
  let nextWorker = 0;
  let executeCalls = 0;
  const terminated: number[] = [];
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    let isTerminated = false;
    return {
      async warmup() {
        if (worker === 1) await warming.promise;
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        return {
          success: true as const,
          artifact: artifact(call.mode),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCode() {
        executeCalls += 1;
        return {
          kind: 'completed' as const,
          output: 42,
          consoleOutput: [],
        };
      },
      terminate() {
        assert.equal(isTerminated, false, `Worker ${worker} terminated twice`);
        isTerminated = true;
        terminated.push(worker);
      },
    } as unknown as PythonWorkerClient;
  };

  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient,
  });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code'
  ) return;

  const controller = new AbortController();
  await preparation.program.executeIsolated({
    inputs: { value: 0 },
  });
  const cancelled = preparation.program.executeIsolated({
    inputs: { value: 1 },
    signal: controller.signal,
  });
  await waitUntil(
    () => nextWorker === 2,
    'The prepared Python execution worker never started warming'
  );
  controller.abort(new DOMException('cancelled during warmup', 'AbortError'));
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.ok(
    terminated.includes(1),
    'Cancellation did not retire the warming execution worker'
  );
  assert.equal(executeCalls, 1);

  assert.equal(
    nextWorker,
    2,
    'A program-scoped cancellation must not create a stranded standby'
  );
  await preparation.program.dispose();
  await waitUntil(
    () => nextWorker === 3,
    'Program disposal did not replenish the provider-owned standby'
  );
  provider.terminate();
  assert.deepEqual(
    terminated.sort((left, right) => left - right),
    [0, 1, 2]
  );
});

test('Python prepared program disposal does not wait for standby warmup', async () => {
  const warming = deferred();
  let nextWorker = 0;
  const terminated: number[] = [];
  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient: () => {
      const worker = nextWorker++;
      return {
        async warmup() {
          if (worker === 1) await warming.promise;
          return { success: true, loadTimeMs: 1 };
        },
        async prepareProgram(call: RuntimeProgramPreparationCall) {
          return {
            success: true as const,
            artifact: artifact(call.mode),
            mode: call.mode,
            consoleOutput: [],
          };
        },
        async executePreparedCode() {
          return {
            kind: 'completed' as const,
            output: 42,
            consoleOutput: [],
          };
        },
        terminate() {
          terminated.push(worker);
        },
      } as unknown as PythonWorkerClient;
    },
  });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (preparation.kind !== 'prepared' || preparation.program.mode !== 'code') return;
  await preparation.program.executeIsolated({ inputs: { value: 1 } });
  await preparation.program.dispose();
  await waitUntil(
    () => nextWorker === 2,
    'The provider-owned replacement standby never started warming'
  );

  await Promise.race([
    preparation.program.dispose(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error('Program disposal waited for standby warmup')),
        100
      );
    }),
  ]);
  provider.terminate();
  assert.deepEqual(
    terminated.sort((left, right) => left - right),
    [0, 1]
  );
});

test('Python prepared provider retires an actively cancelled worker before recovery', async () => {
  let nextWorker = 0;
  let activeWorker: number | undefined;
  const executedBy: number[] = [];
  const terminated: number[] = [];
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    let isTerminated = false;
    return {
      async warmup() {
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        return {
          success: true as const,
          artifact: artifact(call.mode),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCode(
        _handle: unknown,
        call: { signal?: AbortSignal }
      ) {
        executedBy.push(worker);
        if (executedBy.length > 1) {
          return {
            kind: 'completed' as const,
            output: 42,
            consoleOutput: [],
          };
        }
        activeWorker = worker;
        return new Promise<CodeExecutionResult>((_resolve, reject) => {
          call.signal?.addEventListener(
            'abort',
            () => reject(call.signal?.reason ?? new Error('aborted')),
            { once: true }
          );
        });
      },
      terminate() {
        assert.equal(isTerminated, false, `Worker ${worker} terminated twice`);
        isTerminated = true;
        terminated.push(worker);
      },
    } as unknown as PythonWorkerClient;
  };

  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient,
  });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (
    preparation.kind !== 'prepared' ||
    preparation.program.mode !== 'code'
  ) return;

  const controller = new AbortController();
  const cancelled = preparation.program.executeIsolated({
    inputs: { value: 1 },
    signal: controller.signal,
  });
  await waitUntil(
    () => activeWorker !== undefined,
    'The cancellable Python case never started'
  );
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.ok(
    activeWorker !== undefined && terminated.includes(activeWorker),
    'The cancelled Python worker was not retired'
  );

  const recovered = await preparation.program.executeIsolated({
    inputs: { value: 2 },
  });
  assert.equal(recovered.kind, 'completed');
  if (recovered.kind !== 'completed') return;
  assert.equal(recovered.output, 42);
  assert.equal(new Set(executedBy).size, 2);
  await preparation.program.dispose();
  provider.terminate();
});

test('Python prepared provider cannot publish a program after termination races compilation', async () => {
  const compilation = deferred();
  let compilationStarted = false;
  let createdWorkers = 0;
  let terminatedWorkers = 0;
  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient: () => {
      createdWorkers += 1;
      return {
        async warmup() {
          return { success: true, loadTimeMs: 1 };
        },
        async prepareProgram(call: RuntimeProgramPreparationCall) {
          compilationStarted = true;
          await compilation.promise;
          return {
            success: true as const,
            artifact: artifact(call.mode),
            mode: call.mode,
            consoleOutput: [],
          };
        },
        terminate() {
          terminatedWorkers += 1;
        },
      } as unknown as PythonWorkerClient;
    },
  });

  const preparing = provider.prepareProgram(preparationCall());
  await waitUntil(
    () => compilationStarted,
    'The Python preparation request never started'
  );
  provider.terminate();
  compilation.resolve();

  await assert.rejects(preparing, {
    name: 'AbortError',
    message: 'Prepared Python execution provider was terminated.',
  });
  assert.equal(
    createdWorkers,
    1,
    'Termination race created a post-shutdown execution worker'
  );
  assert.equal(terminatedWorkers, 1);
});

test('Python prepared provider cannot publish a program after caller cancellation races compilation', async () => {
  const compilation = deferred();
  let compilationStarted = false;
  let createdWorkers = 0;
  let terminatedWorkers = 0;
  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient: () => {
      createdWorkers += 1;
      return {
        async warmup() {
          return { success: true, loadTimeMs: 1 };
        },
        async prepareProgram(call: RuntimeProgramPreparationCall) {
          compilationStarted = true;
          await compilation.promise;
          return {
            success: true as const,
            artifact: artifact(call.mode),
            mode: call.mode,
            consoleOutput: [],
          };
        },
        terminate() {
          terminatedWorkers += 1;
        },
      } as unknown as PythonWorkerClient;
    },
  });

  const controller = new AbortController();
  const preparing = provider.prepareProgram({
    ...preparationCall(),
    signal: controller.signal,
  });
  await waitUntil(
    () => compilationStarted,
    'The cancellable Python preparation request never started'
  );
  controller.abort(new DOMException('cancelled compilation', 'AbortError'));
  await assert.rejects(preparing, { name: 'AbortError' });
  compilation.resolve();
  await waitUntil(
    () => terminatedWorkers === 1,
    'The cancelled Python preparation worker was not retired'
  );
  await waitUntil(
    () => createdWorkers === 2,
    'Caller cancellation did not replenish the provider-owned standby'
  );

  assert.equal(
    createdWorkers,
    2,
    'Caller cancellation must create exactly one replacement standby'
  );
  provider.terminate();
  assert.equal(terminatedWorkers, 2);
});

test('Python prepared provider reset releases resources and permits later reuse', async () => {
  let nextWorker = 0;
  const terminations = new Map<number, number>();
  const executions: number[] = [];
  let firstExecutionStarted = false;
  const createWorkerClient = (): PythonWorkerClient => {
    const worker = nextWorker++;
    return {
      async warmup() {
        return { success: true, loadTimeMs: 1 };
      },
      async prepareProgram(call: RuntimeProgramPreparationCall) {
        return {
          success: true as const,
          artifact: artifact(call.mode),
          mode: call.mode,
          consoleOutput: [],
        };
      },
      async executePreparedCode(
        _handle: unknown,
        call: { signal?: AbortSignal }
      ) {
        if (worker === 0) {
          firstExecutionStarted = true;
          return new Promise<CodeExecutionResult>((_resolve, reject) => {
            call.signal?.addEventListener(
              'abort',
              () => reject(call.signal?.reason ?? new Error('aborted')),
              { once: true }
            );
          });
        }
        executions.push(worker);
        return {
          kind: 'completed' as const,
          output: worker,
          consoleOutput: [],
        };
      },
      terminate() {
        terminations.set(worker, (terminations.get(worker) ?? 0) + 1);
      },
    } as unknown as PythonWorkerClient;
  };

  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient,
  });
  await provider.init();
  const first = await provider.prepareProgram(preparationCall());
  assert.equal(first.kind, 'prepared');
  if (first.kind !== 'prepared' || first.program.mode !== 'code') return;

  const active = first.program.executeIsolated({
    inputs: { value: 1 },
  });
  await waitUntil(
    () => firstExecutionStarted,
    'The pre-reset Python execution never started'
  );
  provider.reset();
  await assert.rejects(active, {
    name: 'AbortError',
    message: 'Prepared Python execution provider was reset.',
  });
  await Promise.resolve();
  assert.equal(nextWorker, 1, 'Reset allowed an aborted program to replenish a standby worker');
  await assert.rejects(
    first.program.executeIsolated({ inputs: { value: 1 } }),
    /disposed/
  );

  assert.deepEqual(await provider.init(), { success: true, loadTimeMs: 1 });
  const second = await provider.prepareProgram(preparationCall());
  assert.equal(second.kind, 'prepared');
  if (second.kind !== 'prepared' || second.program.mode !== 'code') return;
  const result = await second.program.executeIsolated({
    inputs: { value: 2 },
  });
  assert.equal(result.kind, 'completed');
  if (result.kind !== 'completed') return;
  assert.equal(result.output, 1);
  await second.program.dispose();
  provider.terminate();

  assert.deepEqual(executions, [1]);
  assert.equal(nextWorker, 3);
  assert.deepEqual(
    [...terminations.entries()].sort(([left], [right]) => left - right),
    [
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    'Reset/reuse did not retire every owned worker exactly once'
  );
});

test('Python prepared provider maps compilation failures and normalizes trace timings', async () => {
  let preparationCount = 0;
  const createWorkerClient = (): PythonWorkerClient => ({
    async warmup() {
      return { success: true, loadTimeMs: 1 };
    },
    async prepareProgram(call: RuntimeProgramPreparationCall) {
      preparationCount += 1;
      if (call.mode === 'code') {
        return {
          success: false as const,
          error: 'invalid syntax',
          errorLine: 1,
          consoleOutput: [],
          timings: { totalMs: 2, compileMs: 2 },
        };
      }
      return {
        success: true as const,
        artifact: artifact('trace'),
        mode: 'trace' as const,
        consoleOutput: [],
        timings: { totalMs: 5, compileMs: 5 },
      };
    },
    async executePreparedTrace() {
      return {
        success: true,
        output: 1,
        trace: {
          schemaVersion: 1,
          language: 'python',
          runId: 'python:run',
          events: [{ kind: 'line', runId: 'python:run', line: 1 }],
        },
        executionTimeMs: 4,
        consoleOutput: [],
        timings: {
          totalMs: 4,
          runMs: 4,
          compileCacheHit: true,
          artifactCacheHit: true,
        },
      };
    },
    terminate() {},
  } as unknown as PythonWorkerClient);

  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient,
  });
  const failed = await provider.prepareProgram(preparationCall('code'));
  assert.deepEqual(failed, {
    kind: 'failed',
    error: 'invalid syntax',
    errorLine: 1,
    diagnosticStage: 'compile',
    consoleOutput: [],
    timings: { totalMs: 2, compileMs: 2 },
  });

  const tracePreparation = await provider.prepareProgram(preparationCall('trace'));
  assert.equal(tracePreparation.kind, 'prepared');
  if (
    tracePreparation.kind !== 'prepared' ||
    tracePreparation.program.mode !== 'trace'
  ) return;
  const result = await tracePreparation.program.executeIsolated({
    inputs: { value: 1 },
  });
  assert.equal(result.kind, 'completed');
  if (result.kind !== 'completed') return;
  assert.equal(result.output, 1);
  assert.equal(result.trace.events.length, 1);
  assert.equal(result.timings?.runMs, 4);
  assert.equal(result.timings?.artifactCacheHit, true);
  assert.equal(preparationCount, 2);
  await tracePreparation.program.dispose();
  provider.terminate();
});

test('a traced Python case a guard stopped after its trace stopped recording keeps the trace budget', async () => {
  const wire = (fields: Record<string, unknown>) => ({
    output: null,
    trace: { events: [] },
    executionTimeMs: 1,
    consoleOutput: [],
    traceLimitExceeded: true,
    ...fields,
  });
  const replies = [
    wire({
      success: false,
      error: 'Execution stopped on line 4: the program executed too many lines.',
      timeoutReason: 'line-limit',
      traceLimitReason: 'trace-byte-limit',
    }),
    wire({ success: true, output: 4, timeoutReason: 'trace-byte-limit', traceLimitReason: 'trace-byte-limit' }),
    // A worker that does not report the budget: lifted as before.
    wire({ success: false, error: 'stopped', timeoutReason: 'line-limit' }),
  ];
  const client = createPythonRuntimeClient({
    executeWithTracing: async () => replies.shift(),
  } as unknown as Parameters<typeof createPythonRuntimeClient>[0]);
  const call = { code: 'def solve():\n    return 4', functionName: 'solve', inputs: {}, executionStyle: 'function' as const };
  const stopped = await client.executeWithTracing(call);
  assert.equal(stopped.kind, 'limit');
  assert.equal(stopped.kind === 'limit' ? stopped.reason : undefined, 'line-limit');
  assert.equal(stopped.kind === 'limit' ? stopped.traceTruncated : undefined, 'trace-byte-limit');
  const completed = await client.executeWithTracing(call);
  assert.equal(completed.kind === 'completed' ? completed.traceTruncated : undefined, 'trace-byte-limit');
  const legacy = await client.executeWithTracing(call);
  assert.equal(legacy.kind, 'limit');
  assert.equal('traceTruncated' in legacy, false);
});

test('the Python trace client leaves an unknown traceLimitReason to the outcome contract, which rejects it', async () => {
  const client = createPythonRuntimeClient({
    executeWithTracing: async () => ({
      success: false,
      output: null,
      error: 'stopped',
      trace: { events: [] },
      executionTimeMs: 1,
      consoleOutput: [],
      timeoutReason: 'line-limit',
      traceLimitExceeded: true,
      traceLimitReason: 'banana',
    }),
  } as unknown as Parameters<typeof createPythonRuntimeClient>[0]);
  await assert.rejects(
    client.executeWithTracing({ code: 'def solve():\n    return 4', functionName: 'solve', inputs: {}, executionStyle: 'function' }),
    (error: unknown) => error instanceof Error && /unknown traceLimitReason/.test(error.message)
  );
});

/**
 * A worker lost while it ran the learner's case (the host terminated it, its
 * `error` event fired) failed for a reason the program did not cause. The
 * provider rejects, as every other runtime does; it never reports the case as
 * the program's runtime failure.
 */
function lostWorkerClientFactory(
  tier: 'algorithm-fast' | 'judge-compatible' | 'hard-isolated',
  calls: string[]
): () => PythonWorkerClient {
  const lost = (method: string) => {
    calls.push(method);
    return Promise.reject(new WorkerCrashedError({
      workerMessage: 'injected: worker lost after dispatch',
      filename: undefined,
      lineno: undefined,
      colno: undefined,
    }));
  };
  return () => ({
    async warmup() {
      return { success: true, loadTimeMs: 1 };
    },
    async prepareProgram(call: RuntimeProgramPreparationCall) {
      return {
        success: true as const,
        artifact: artifact(call.mode, tier),
        mode: call.mode,
        consoleOutput: [],
      };
    },
    executePreparedCode: () => lost('execute-code'),
    executePreparedTrace: () => lost('execute-trace'),
    executePreparedCodeBatch: () => lost('execute-code-batch'),
    executePreparedTraceBatch: () => lost('execute-trace-batch'),
    terminate() {},
  }) as unknown as PythonWorkerClient;
}

for (const tier of ['algorithm-fast', 'judge-compatible', 'hard-isolated'] as const) {
  for (const mode of ['code', 'trace'] as const) {
    test(`Python ${tier} ${mode}: a worker lost mid-case rejects as the provider's failure`, async () => {
      const calls: string[] = [];
      const provider = createPythonPreparedExecutionProvider({
        createWorkerClient: lostWorkerClientFactory(tier, calls),
      });
      const preparation = await provider.prepareProgram(preparationCall(mode));
      assert.equal(preparation.kind, 'prepared');
      if (preparation.kind !== 'prepared') return;
      const program = preparation.program;
      const lostWorker = (error: unknown) =>
        error instanceof Error &&
        (error as { _tag?: unknown })._tag === 'WorkerCrashedError' &&
        error.message === 'injected: worker lost after dispatch';

      await assert.rejects(
        program.executeIsolated({ inputs: { value: 1 } }) as Promise<unknown>,
        lostWorker,
        'single case'
      );
      assert.ok(program.executeBatchIsolated);
      await assert.rejects(
        program.executeBatchIsolated!({
          inputBatch: [{ value: 1 }, { value: 2 }],
        }) as Promise<unknown>,
        lostWorker,
        'batch'
      );
      assert.ok(calls.length > 0, 'the fake worker was never asked to run a case');
      await program.dispose();
      provider.terminate();
    });
  }
}

// observationReplyProvenance: 'structured-clone' says every object of a Python
// observation reply is plain data the adapter built. certifyPythonDrawing
// rebuilds the drawing with literals, spreads, array methods and
// sanitizeJsonValue's null-prototype records, so that holds even for a raw
// worker reply that no structured clone could produce.
function launderingWorkerClient(raw: unknown, made: Set<object>): () => PythonWorkerClient {
  return () => ({
    async warmup() {
      return { success: true, loadTimeMs: 1 };
    },
    async prepareProgram(call: RuntimeProgramPreparationCall) {
      return {
        success: true as const,
        artifact: artifact(call.mode),
        mode: call.mode,
        consoleOutput: [],
      };
    },
    async executePreparedTrace() {
      void made;
      return raw;
    },
    terminate() {},
  }) as unknown as PythonWorkerClient;
}

function adversarialPythonTraceReply(made: Set<object>) {
  const track = <T extends object>(value: T): T => {
    made.add(value);
    return value;
  };
  class Box {
    inner = track({ n: 1 });
    get computed() { return track({ computed: true }); }
  }
  const withAccessors = track({} as Record<string | symbol, unknown>);
  Object.defineProperty(withAccessors, 'line', { enumerable: true, get: () => 1 });
  Object.defineProperty(withAccessors, 'hidden', { enumerable: false, value: track({ hidden: true }) });
  withAccessors[Symbol('s')] = track({ symbol: true });
  const named = track([1, , 3]) as unknown[] & Record<string, unknown>;
  named.extra = track({ named: true });
  const proxied = new Proxy(track({ p: track([1, 2]) }), {});
  made.add(proxied);
  const events = track([
    track({
      kind: 'line', file: 'solution.py', get line() { return 1; }, frameId: 'f1',
      sourceSpan: track({ file: 'solution.py', startLine: 1 }),
      callStack: track([track({ function: 'solve', line: 1, args: track(new Box()) })]),
      [Symbol('event')]: track({}),
    }),
    track({
      kind: 'write', file: 'solution.py', line: 2,
      target: track({ variable: 'value', path: track([0]), indexSources: track(['i']) }),
      value: track({ box: track(new Box()), map: track(new Map([[1, 2]])), date: track(new Date(0)), named, withAccessors }),
    }),
    track({ kind: 'call', file: 'solution.py', line: 1, function: 'solve', args: proxied }),
    track({ kind: 'return', file: 'solution.py', line: 2, value: track([withAccessors, proxied]) }),
  ]);
  return track({
    success: true,
    output: 1,
    consoleOutput: track([]),
    observation: track({ recorderCompleted: true, attemptedEvents: 4 }),
    trace: track({
      schemaVersion: 'runtime-trace-2026-04-28',
      language: 'python',
      runId: 'python:run',
      events,
      lineEventCount: 1,
      traceStepCount: 4,
    }),
  });
}

test('Python observation drawings are plain data the adapter built, whatever the worker reply holds', async () => {
  const made = new Set<object>();
  const raw = adversarialPythonTraceReply(made);
  const provider = createPythonPreparedExecutionProvider({ createWorkerClient: launderingWorkerClient(raw, made) });
  try {
    const drawing = await provider.observe({
      program: { code: 'def solve(value):\n    return value', functionName: 'solve', executionStyle: 'function' },
      inputs: { value: 1 },
      attemptToken: 'attempt-1',
    } as Parameters<typeof provider.observe>[0]);
    assert.equal(drawing.status, 'drawn');
    if (drawing.status !== 'drawn') return;
    assert.equal(drawing.trace.events.length, 4);
    const stack: unknown[] = [drawing.trace];
    const seen = new Set<object>();
    while (stack.length) {
      const node = stack.pop();
      if (node === null || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      assert.equal(made.has(node), false, 'a node of the worker reply reached the drawing');
      const prototype = Object.getPrototypeOf(node);
      assert.ok(prototype === null || prototype === Object.prototype || prototype === Array.prototype);
      const keys = Reflect.ownKeys(node);
      const enumerable = Object.keys(node);
      const expected = Array.isArray(node) ? [...enumerable, 'length'] : enumerable;
      assert.deepEqual(keys, expected, 'only enumerable string keys (and an array length)');
      for (const key of enumerable) {
        const descriptor = Reflect.getOwnPropertyDescriptor(node, key)!;
        assert.ok('value' in descriptor, `${key} is a data property`);
        assert.notEqual(typeof descriptor.value, 'function');
        assert.notEqual(typeof descriptor.value, 'symbol');
        stack.push(descriptor.value);
      }
    }
    assert.ok(seen.size > 20, `walked ${seen.size} objects`);
  } finally {
    provider.terminate();
  }
});

test('the Python receipt provider transfers its replies with structured-clone provenance', () => {
  const context = {
    engine: 'chromium',
    debug: false,
    workerLifecyclePolicy: 'warm-and-retire',
    workerFactoryFor: () => undefined,
    manifestAssetCollection: () => undefined,
    manifestAsset: (_language: string, key: string) => ({ url: `${key}.js` }),
    preflight: () => async () => {},
    assets: {
      pythonWorker: 'python-worker.js',
      pythonRuntime: 'python-runtime.js',
      pythonSnippets: 'python-snippets.js',
      runtimeManifests: {
        python: { assets: { runtimeImage: { engine: 'chromium', snapshot: { integrity: 's' }, wasm: { integrity: 'w' } } } },
      },
    },
  };
  const lease = createPythonBrowserRuntimeProvider().create(context as never) as {
    judgeReceiptProviders?: ReadonlyMap<string, { capabilities: Record<string, unknown> }>;
    dispose(): void;
  };
  try {
    const capabilities = lease.judgeReceiptProviders?.get('python')?.capabilities;
    assert.equal(capabilities?.observationReplyOwnership, 'transferred');
    assert.equal(capabilities?.observationReplyProvenance, 'structured-clone');
  } finally {
    lease.dispose();
  }
});
