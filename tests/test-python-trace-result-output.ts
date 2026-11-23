#!/usr/bin/env npx tsx
/**
 * A Run's cases must return exactly what Submit returns. The app's Run is one
 * traced request (the first case traced, the others untraced), so every case
 * of a Run, traced or not, comes back through the trace path's result
 * normalizer. That normalizer once applied its display caps (256 items, 128
 * fields, depth 32) to the returned value itself: the 352 boards of a correct
 * n-queens for n = 9 became 256 boards and a truncation marker, judged as a
 * wrong answer, while Submit, which passes the value through, accepted it.
 *
 * The real PythonWorkerClient and prepared provider run against a worker
 * double that speaks the worker protocol and returns each case's `value`
 * input as its output, so the only difference between the paths is the
 * client's handling of the result.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  createPythonPreparedExecutionProvider,
  type PythonPreparedProgramArtifact,
} from '../packages/runtime-python/src/index';
import { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';
import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedProgram,
} from '../packages/runtime-contracts/src/index';

/** Every n-queens board for n, as the reference solution returns them. */
function nQueens(n: number): string[][] {
  const boards: string[][] = [];
  const cols: number[] = [];
  const place = (row: number) => {
    if (row === n) {
      boards.push(cols.map((col) => '.'.repeat(col) + 'Q' + '.'.repeat(n - col - 1)));
      return;
    }
    for (let col = 0; col < n; col += 1) {
      if (cols.every((other, r) => other !== col && Math.abs(other - col) !== row - r)) {
        cols.push(col);
        place(row + 1);
        cols.pop();
      }
    }
  };
  place(0);
  return boards;
}

function linkedList(length: number): unknown {
  let node: unknown = null;
  for (let index = length; index >= 1; index -= 1) {
    node = { __type__: 'ListNode', __id__: `ref-${index}`, val: index, next: node };
  }
  return node;
}

const RUNAWAY = '__runaway__';

const OUTPUTS: Record<string, unknown> = {
  'n-queens n=9 (352 boards)': nQueens(9),
  'n-queens n=8 (92 boards)': nQueens(8),
  'a list of 1000 numbers': Array.from({ length: 1000 }, (_, index) => index),
  'a dict of 200 keys': Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index])),
  'a linked list of 45 nodes': linkedList(45),
  'a small answer': [1, 2, 3],
};

function artifact(mode: 'code' | 'trace'): PythonPreparedProgramArtifact {
  return {
    schemaVersion: 'tracecode.python.prepared-program.v4',
    fingerprint: { cacheTag: 'cpython-test', magicNumber: 'test', marshalVersion: 4 },
    mode,
    code: 'def solve(value):\n    return value',
    functionName: 'solve',
    executionStyle: 'function',
    traceOptions: {},
    isolationProfile: { tier: 'algorithm-fast', reasons: [] },
    algorithmFastBatchCode: 'algorithm-fast-artifact',
    userCode: 'user-artifact',
    executorCode: 'executor-artifact',
  };
}

function caseResult(value: unknown, traced: boolean): Record<string, unknown> {
  if (value === RUNAWAY) {
    return {
      success: false,
      error: 'Execution stopped: resource limit exceeded (line-limit).',
      timeoutReason: 'line-limit',
      consoleOutput: [],
      ...(traced ? { trace: { schemaVersion: 1, language: 'python', runId: 'python:run', events: [] } } : {}),
    };
  }
  return {
    success: true,
    output: value,
    consoleOutput: [],
    ...(traced
      ? {
          trace: {
            schemaVersion: 1,
            language: 'python',
            runId: 'python:run',
            events: [{ kind: 'line', runId: 'python:run', line: 1 }],
          },
          executionTimeMs: 1,
        }
      : {}),
    timings: { runMs: 1, algorithmFastBatch: true },
  };
}

/** A Python worker whose program returns its `value` input. */
class EchoWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  constructor() {
    queueMicrotask(() => this.emit({ type: 'worker-ready' }));
  }

  postMessage(message: unknown): void {
    const { id, type, payload, protocolToken } = message as {
      id?: string;
      type?: string;
      payload?: Record<string, unknown>;
      protocolToken?: string;
    };
    if (!id || !protocolToken) return;
    const reply = (replyType: string, replyPayload: unknown) =>
      queueMicrotask(() => this.emit({ id, type: replyType, payload: replyPayload, protocolToken }));
    if (type === 'init') return reply('init-result', { success: true, loadTimeMs: 0 });
    if (type === 'warmup') return reply('warmup-result', { success: true, loadTimeMs: 0 });
    if (type === 'prepare-program') {
      const mode = payload?.mode as 'code' | 'trace';
      return reply('prepare-result', { success: true, artifact: artifact(mode), mode, consoleOutput: [] });
    }
    if (type === 'execute-prepared-program') {
      const traced = payload?.mode === 'trace' && payload?.recordTrace !== false;
      return reply('execute-result', caseResult((payload?.inputs as { value: unknown }).value, traced));
    }
    if (type === 'execute-prepared-program-batch') {
      const inputBatch = payload?.inputBatch as Array<{ value: unknown }>;
      const traceEnabled = payload?.traceEnabledBatch as boolean[] | undefined;
      const results = inputBatch.map((inputs, index) =>
        caseResult(inputs.value, payload?.mode === 'trace' && traceEnabled?.[index] !== false)
      );
      return reply('execute-result', { success: true, results, consoleOutput: [] });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data } as MessageEvent);
  }
}

async function prepared(mode: 'code' | 'trace') {
  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient: () =>
      new PythonWorkerClient({
        workerUrl: 'python-worker.js',
        debug: false,
        workerFactory: () => new EchoWorker() as never,
      }),
  });
  const preparation = await provider.prepareProgram({
    mode,
    code: 'def solve(value):\n    return value',
    functionName: 'solve',
    executionStyle: 'function',
  });
  assert.equal(preparation.kind, 'prepared');
  if (preparation.kind !== 'prepared') throw new Error('unreachable');
  return { provider, program: preparation.program as RuntimePreparedProgram };
}

type AnyResult = CodeExecutionResult | ExecutionResult;

const VALUES = [...Object.values(OUTPUTS), RUNAWAY];

async function submitResults(): Promise<readonly AnyResult[]> {
  const { provider, program } = await prepared('code');
  try {
    return await program.executeBatchIsolated!({
      inputBatch: VALUES.map((value) => ({ value })),
    } as never) as readonly AnyResult[];
  } finally {
    await program.dispose();
    provider.terminate();
  }
}

/** A Run as the app sends it: one trace batch, only `tracedIndex` traced. */
async function runResults(tracedIndex: number): Promise<readonly AnyResult[]> {
  const { provider, program } = await prepared('trace');
  try {
    return await program.executeBatchIsolated!({
      inputBatch: VALUES.map((value) => ({ value })),
      traceEnabledBatch: VALUES.map((_, index) => index === tracedIndex),
    } as never) as readonly AnyResult[];
  } finally {
    await program.dispose();
    provider.terminate();
  }
}

/** A single traced case, as a Run of one case or a later case's trace. */
async function tracedCase(value: unknown): Promise<AnyResult> {
  const { provider, program } = await prepared('trace');
  try {
    return await program.executeIsolated!({ inputs: { value } } as never) as AnyResult;
  } finally {
    await program.dispose();
    provider.terminate();
  }
}

function outcome(result: AnyResult | undefined) {
  if (!result) return undefined;
  // Compared as JSON: the trace path hands back null-prototype objects.
  if (result.kind === 'completed') return { kind: result.kind, output: JSON.parse(JSON.stringify(result.output)) };
  return { kind: result.kind, reason: (result as { reason?: string }).reason };
}

const labels = [...Object.keys(OUTPUTS), 'a runaway loop'];

test('Submit returns each output unchanged and the runaway as the line limit', async () => {
  const submit = await submitResults();
  assert.equal(submit.length, VALUES.length);
  for (const [index, label] of labels.entries()) {
    if (VALUES[index] === RUNAWAY) {
      assert.deepEqual(outcome(submit[index]), { kind: 'limit', reason: 'line-limit' }, label);
    } else {
      assert.deepEqual(outcome(submit[index]), { kind: 'completed', output: VALUES[index] }, label);
    }
  }
});

for (const tracedIndex of [0, 5]) {
  test(`a Run with case ${tracedIndex + 1} traced returns Submit's result for every case`, async () => {
    const submit = await submitResults();
    const run = await runResults(tracedIndex);
    assert.equal(run.length, submit.length);
    const differing = labels.filter((_, index) =>
      !isDeepStrictEqual(outcome(run[index]), outcome(submit[index]))
    ).map((label) => `${label} (${label === labels[tracedIndex] ? 'traced' : 'untraced'} in the Run)`);
    assert.deepEqual(differing, [], 'Run cases whose result differs from Submit');
  });
}

test('a single traced case returns Submit\'s result', async () => {
  const submit = await submitResults();
  const differing: string[] = [];
  for (const [index, label] of labels.entries()) {
    if (!isDeepStrictEqual(outcome(await tracedCase(VALUES[index])), outcome(submit[index]))) differing.push(label);
  }
  assert.deepEqual(differing, [], 'Traced cases whose result differs from Submit');
});
