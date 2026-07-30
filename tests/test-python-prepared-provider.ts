import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPythonPreparedExecutionProvider,
  type PythonPreparedProgramArtifact,
  type PythonWorkerClient,
} from '../packages/runtime-python/src/index';
import type {
  CodeExecutionResult,
  RuntimeProgramPreparationCall,
} from '../packages/runtime-core/src/index';

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

function artifact(mode: 'code' | 'trace'): PythonPreparedProgramArtifact {
  return {
    schemaVersion: 'tracecode.python.prepared-program.v1',
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
    caseIsolation: 'fresh-case-state',
    maxConcurrency: 1,
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
  const compiler = calls.find((call) => call.method === 'prepare')?.worker;
  const executor = calls.find((call) => call.method === 'execute-code')?.worker;
  assert.notEqual(
    compiler,
    executor,
    'Prepared execution reused the compiler interpreter'
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

test('Python prepared provider serializes cases and drains active work before disposal', async () => {
  const gates = [deferred(), deferred()];
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
      async executePreparedCode() {
        const execution = started;
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        workerExecutions.push(worker);
        try {
          await gates[execution]?.promise;
          return {
            kind: 'completed' as const,
            output: execution + 1,
            consoleOutput: [],
          };
        } finally {
          active -= 1;
        }
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

  gates[0]?.resolve();
  await waitUntil(
    () => started === 2,
    'The second prepared Python case never started after the first completed'
  );
  assert.equal(active, 1);
  assert.equal(maxActive, 1, 'Provider exceeded its advertised maxConcurrency');

  gates[1]?.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  await disposal;
  await preparation.program.dispose();
  provider.terminate();

  assert.deepEqual(
    [firstResult.output, secondResult.output],
    [1, 2],
    'Accepted cases did not complete before disposal'
  );
  assert.equal(maxActive, 1);
  assert.equal(terminatedWhileActive, false);
  assert.equal(
    new Set(workerExecutions).size,
    2,
    'Two isolated cases shared one Python worker generation'
  );
  assert.deepEqual(
    workerTerminations.sort((left, right) => left - right),
    [0, 1, 2],
    'Compiler and both case workers were not retired'
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
    'The Python compiler request never started'
  );
  provider.terminate();
  compilation.resolve();

  await assert.rejects(preparing, /provider has been terminated/);
  assert.equal(
    createdWorkers,
    1,
    'Termination race created a post-shutdown execution worker'
  );
  assert.equal(terminatedWorkers, 1);
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
