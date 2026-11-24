import assert from 'node:assert/strict';
import test from 'node:test';
import type { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';
import { createPythonPreparedExecutionProvider } from '../packages/runtime-python/src/python-runtime-client';
import { RUNTIME_TRACE_SCHEMA_VERSION } from '../packages/runtime-contracts/src/index';

const code = 'def solve(n):\n    return n + 1';
const program = { code, functionName: 'solve' };
const attempt = { program, inputs: { n: 6 }, attemptToken: 'attempt-1' };

function fixture(workerTrace: unknown) {
  const calls: Array<[number, string]> = [];
  let workerId = 0;
  const provider = createPythonPreparedExecutionProvider({
    replenishStandbyAfterUse: false,
    createWorkerClient: () => {
      const id = workerId++;
      return {
        warmup: async () => ({ success: true, loadTimeMs: 0 }),
        prepareProgram: async ({ mode }: { mode: string }) => {
          calls.push([id, `prepare:${mode}`]);
          return { success: true, mode, artifact: { mode, code, isolationProfile: { tier: 'algorithm-fast' } }, consoleOutput: [] };
        },
        executePreparedCodeBatch: async () => {
          calls.push([id, 'batch:code']);
          return { results: [{ kind: 'completed', output: 7, consoleOutput: ['ordinary'] }] };
        },
        executePreparedTrace: async () => {
          calls.push([id, 'single:trace']);
          return workerTrace;
        },
        terminate: () => calls.push([id, 'terminate']),
      } as unknown as PythonWorkerClient;
    },
  });
  return { calls, provider };
}

const trace = {
  schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
  runId: 'python:run',
  language: 'python',
  events: [{ kind: 'line', file: 'solution.py', line: 2 }],
};

test('the Python observer uses its own worker and exposes only the drawing', async () => {
  const { calls, provider } = fixture({
    output: 999,
    consoleOutput: ['observer'],
    observation: { recorderCompleted: true, attemptedEvents: 1 },
    trace,
  });
  const ordinary = await provider.prepareProgram({ ...program, mode: 'code' });
  assert.ok(ordinary.kind === 'prepared' && ordinary.program.mode === 'code');
  const drawing = await provider.observe(attempt);
  assert.equal(drawing.status, 'drawn');
  assert.deepEqual(Object.keys(drawing).sort(), ['status', 'trace']);
  assert.deepEqual(await ordinary.program.executeBatchIsolated!({ inputBatch: [attempt.inputs] }),
    [{ kind: 'completed', output: 7, consoleOutput: ['ordinary'] }]);
  await ordinary.program.dispose();
  assert.deepEqual(calls, [
    [0, 'prepare:code'],
    [1, 'prepare:trace'],
    [1, 'single:trace'],
    [1, 'terminate'],
    [0, 'batch:code'],
    [0, 'terminate'],
  ]);
});

test('a Python observer needs provenance and a byte cap can retain zero events', async () => {
  const missing = fixture({ trace });
  assert.deepEqual(await missing.provider.observe(attempt),
    { status: 'refused', reason: 'recorder-unavailable' });

  const byteCap = fixture({
    trace: { ...trace, events: [] },
    observation: { recorderCompleted: true, cut: 'byte-budget', attemptedEvents: 1 },
  });
  const drawing = await byteCap.provider.observe({ ...attempt, traceOptions: { maxTraceBytes: 1 } });
  assert.equal(drawing.status, 'truncated');
  if (drawing.status === 'truncated') {
    assert.equal(drawing.reason, 'byte-budget');
    assert.equal(drawing.attemptedEvents, 1);
    assert.deepEqual(drawing.trace.events, []);
  }
});
