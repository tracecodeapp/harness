import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPythonPreparedExecutionProvider,
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

test('Python prepared provider exposes serial fresh-state execution and disposes once', async () => {
  const calls: Array<{ method: string; value?: unknown }> = [];
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
  const fakeWorker = {
    async init() {
      calls.push({ method: 'init' });
      return { success: true, loadTimeMs: 1 };
    },
    async prepareProgram(call: RuntimeProgramPreparationCall) {
      calls.push({ method: 'prepare', value: call });
      return {
        success: true as const,
        programId: 'python-prepared-test',
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
      handle: { programId: string },
      call: { inputs: Record<string, unknown>; signal?: AbortSignal }
    ) {
      calls.push({ method: 'execute-code', value: { handle, call } });
      if (call.signal?.aborted) {
        throw call.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      return codeResult;
    },
    async disposePreparedProgram(programId: string) {
      calls.push({ method: 'dispose', value: programId });
    },
  } as unknown as PythonWorkerClient;

  const provider = createPythonPreparedExecutionProvider(fakeWorker);
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
  assert.equal(
    calls.filter((call) => call.method === 'prepare').length,
    1,
    'Provider must prepare only once'
  );
  assert.equal(
    calls.filter((call) => call.method === 'dispose').length,
    1,
    'Provider must dispose its worker artifact exactly once'
  );
  await assert.rejects(
    preparation.program.executeIsolated({ inputs: { value: 1 } }),
    /disposed/
  );
});

test('Python prepared provider maps compilation failures and normalizes trace timings', async () => {
  const fakeWorker = {
    async init() {
      return { success: true, loadTimeMs: 1 };
    },
    async prepareProgram(call: RuntimeProgramPreparationCall) {
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
        programId: 'python-trace-test',
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
    async disposePreparedProgram() {},
  } as unknown as PythonWorkerClient;

  const provider = createPythonPreparedExecutionProvider(fakeWorker);
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
  await tracePreparation.program.dispose();
});
