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
  assert.equal(executeCalls, 0);

  await waitUntil(
    () => nextWorker === 3,
    'Cancellation did not replenish the clean standby worker'
  );
  await preparation.program.dispose();
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
        terminate() {
          terminated.push(worker);
        },
      } as unknown as PythonWorkerClient;
    },
  });
  const preparation = await provider.prepareProgram(preparationCall());
  assert.equal(preparation.kind, 'prepared');
  if (preparation.kind !== 'prepared') return;
  await waitUntil(
    () => nextWorker === 2,
    'The prepared Python standby worker never started warming'
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
    'The cancellable Python compiler request never started'
  );
  controller.abort(new DOMException('cancelled compilation', 'AbortError'));
  await assert.rejects(preparing, { name: 'AbortError' });
  compilation.resolve();
  await waitUntil(
    () => terminatedWorkers === 1,
    'The cancelled Python compiler worker was not retired'
  );
  await Promise.resolve();

  assert.equal(
    createdWorkers,
    1,
    'Caller cancellation published a prepared program and execution standby'
  );
  provider.terminate();
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
        if (worker === 1) {
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
  assert.equal(
    nextWorker,
    2,
    'Reset allowed an aborted program to replenish a standby worker'
  );
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
  assert.equal(result.output, 3);
  await second.program.dispose();
  provider.terminate();

  assert.deepEqual(executions, [3]);
  assert.equal(nextWorker, 5);
  assert.deepEqual(
    [...terminations.entries()].sort(([left], [right]) => left - right),
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
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
