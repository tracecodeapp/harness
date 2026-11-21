#!/usr/bin/env npx tsx
/**
 * A Python stopping batch (Run semantics) must report a case that never
 * finishes within one per-case clock of that case starting: the finished
 * prefix keeps its real results, the runaway case is the time limit
 * (`client-timeout`), and no later case runs. Nothing in a Python worker can
 * interrupt a loop its own guard cannot see (a loop inside C code, or a page
 * with no interrupt buffer), so the client's clock is the only backstop.
 *
 * The real PythonWorkerClient and prepared provider run against a worker
 * double that speaks the worker protocol: each case "runs" for a few
 * milliseconds, except the runaway case, which never returns, exactly like a
 * worker stuck in learner code.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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

const CASES = 10;
const PER_CASE_MS = 1_000;
// One per-case clock, the client's headroom over the worker's own deadline,
// and scheduling slack on a loaded machine.
const VERDICT_BOUND_MS = PER_CASE_MS + 2_000;

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

interface WorkerLog {
  created: number;
  terminated: number;
  batchRequests: Array<Record<string, unknown>>;
  /** Whether the worker that received each batch request has been terminated. */
  batchWorkerTerminated: Array<() => boolean>;
  /** Batch requests that reached a worker which never received `init`. */
  unwarmedBatchRequests?: number;
}

/**
 * Where a worker stalls without running learner code: trusted setup before
 * the first case, the setup between two cases (a mixed-trace chunk), or the
 * final reply after every case streamed.
 */
type Stall =
  | { readonly kind: 'before-first-case' }
  | { readonly kind: 'after-case'; readonly index: number }
  | { readonly kind: 'withhold-reply' };

function newLog(): WorkerLog {
  return { created: 0, terminated: 0, batchRequests: [], batchWorkerTerminated: [], unwarmedBatchRequests: 0 };
}

/** A Python worker whose learner code never returns on `runawayCase`. */
class StuckCaseWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;
  private initialized = false;

  constructor(
    private readonly runawayCase: number,
    private readonly log: WorkerLog,
    /** A case whose learner code takes the worker down (a crash, not a limit). */
    private readonly crashCase = -1,
    private readonly stall?: Stall
  ) {
    log.created += 1;
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
      this.emit({ id, type: replyType, payload: replyPayload, protocolToken });
    if (type === 'init') {
      this.initialized = true;
      return queueMicrotask(() => reply('init-result', { success: true, loadTimeMs: 0 }));
    }
    if (type === 'warmup') return queueMicrotask(() => reply('warmup-result', { success: true, loadTimeMs: 0 }));
    if (type === 'prepare-program') {
      const mode = payload?.mode as 'code' | 'trace';
      return queueMicrotask(() =>
        reply('prepare-result', { success: true, artifact: artifact(mode), mode, consoleOutput: [] })
      );
    }
    if (type === 'execute-prepared-program') {
      // One case per request: the provider's per-case recovery path.
      const value = (payload?.inputs as { value: number }).value;
      if (value - 1 === this.crashCase) return queueMicrotask(() => this.crash());
      return void setTimeout(() =>
        reply('execute-result', { success: true, output: value, consoleOutput: [] }), 5);
    }
    if (type === 'execute-prepared-program-batch') {
      this.log.batchRequests.push(payload ?? {});
      this.log.batchWorkerTerminated.push(() => this.terminated);
      // In module format a worker that never received `init` has no runtime
      // asset configuration and cannot bootstrap.
      if (!this.initialized) this.log.unwarmedBatchRequests = (this.log.unwarmedBatchRequests ?? 0) + 1;
      void this.runBatch(payload ?? {}, reply, (progress) =>
        this.emit({ id, type: 'batch-case-progress', payload: progress, protocolToken })
      );
    }
  }

  /** What the worker does: cases in order, progress if asked, stop at the runaway. */
  private async runBatch(
    payload: Record<string, unknown>,
    reply: (type: string, payload: unknown) => void,
    progress: (event: Record<string, unknown>) => void
  ): Promise<void> {
    const inputBatch = payload.inputBatch as Array<{ value: number }>;
    const trace = payload.mode === 'trace';
    const report = payload.reportCaseProgress === true;
    const results: Record<string, unknown>[] = [];
    if (this.stall?.kind === 'before-first-case') return; // trusted setup never ends
    for (let index = 0; index < inputBatch.length; index += 1) {
      if (this.stall?.kind === 'after-case' && index === this.stall.index + 1) return;
      if (report) progress({ index, phase: 'started' });
      if (index === this.runawayCase) return; // learner code never returns
      if (index === this.crashCase) return this.crash();
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (this.terminated) return;
      const result = {
        success: true,
        output: inputBatch[index]!.value,
        consoleOutput: [],
        ...(trace
          ? {
              trace: {
                schemaVersion: 1,
                language: 'python',
                runId: 'python:run',
                events: [{ kind: 'line', runId: 'python:run', line: 1 }],
              },
              executionTimeMs: 5,
            }
          : {}),
        timings: { runMs: 5, algorithmFastBatch: true },
      };
      results.push(result);
      if (report) progress({ index, phase: 'finished', result });
    }
    if (this.stall?.kind === 'withhold-reply') return;
    reply('execute-result', report
      ? { success: true, resultsStreamed: results.length, consoleOutput: [] }
      : { success: true, results, consoleOutput: [] });
  }

  private crash(): void {
    if (this.terminated) return;
    this.onerror?.({ message: 'RangeError: Maximum call stack size exceeded' } as ErrorEvent);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.log.terminated += 1;
  }

  private emit(data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data } as MessageEvent);
  }
}

async function preparedProgram(
  mode: 'code' | 'trace',
  runawayCase: number,
  log: WorkerLog,
  crashCase = -1,
  stall?: Stall
) {
  const provider = createPythonPreparedExecutionProvider({
    createWorkerClient: () =>
      new PythonWorkerClient({
        workerUrl: 'python-worker.js',
        debug: false,
        workerFactory: () => new StuckCaseWorker(runawayCase, log, crashCase, stall) as never,
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

/** Fails fast instead of waiting out the old whole-batch clock. */
async function withinBound<T>(operation: Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No verdict within ${VERDICT_BOUND_MS} ms of the runaway case starting`)),
      VERDICT_BOUND_MS + 1_000
    );
  });
  try {
    const value = await Promise.race([operation, bound]);
    return { value, elapsedMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}

function assertStoppedAt(
  results: readonly (CodeExecutionResult | ExecutionResult)[],
  runawayCase: number
): void {
  assert.equal(results.length, runawayCase + 1, 'A stopping batch returns the prefix ending at the runaway case');
  for (let index = 0; index < runawayCase; index += 1) {
    const result = results[index]!;
    assert.equal(result.kind, 'completed', `case ${index + 1} keeps its real result`);
    if (result.kind === 'completed') assert.equal(result.output, index + 1);
  }
  const runaway = results[runawayCase]!;
  assert.equal(runaway.kind, 'limit');
  if (runaway.kind === 'limit') assert.equal(runaway.reason, 'client-timeout');
}

for (const mode of ['code', 'trace'] as const) {
  for (const runawayCase of [0, 4]) {
    test(`Python ${mode === 'trace' ? 'traced' : 'untraced'} stopping batch reports case ${runawayCase + 1} of ${CASES} within one per-case clock`, async () => {
      const log: WorkerLog = { created: 0, terminated: 0, batchRequests: [], batchWorkerTerminated: [] };
      const { provider, program } = await preparedProgram(mode, runawayCase, log);
      const inputBatch = Array.from({ length: CASES }, (_, index) => ({ value: index + 1 }));
      const call = {
        inputBatch,
        limits: { wallClockMs: PER_CASE_MS },
        stopAtFirstRunaway: true,
        ...(mode === 'trace' ? { traceEnabledBatch: inputBatch.map(() => true) } : {}),
      };
      const { value: results, elapsedMs } = await withinBound(
        program.executeBatchIsolated!(call as never) as Promise<readonly (CodeExecutionResult | ExecutionResult)[]>
      );
      console.log(`  ${mode} runaway case ${runawayCase + 1}: verdict in ${Math.round(elapsedMs)} ms`);
      assertStoppedAt(results, runawayCase);
      assert.ok(elapsedMs < VERDICT_BOUND_MS, `verdict took ${Math.round(elapsedMs)} ms`);
      assert.equal(log.batchRequests.length, 1, 'One batch request, no re-run of the cases');
      assert.equal(log.batchRequests[0]!.stopAtFirstRunaway, true);
      // The worker stuck in learner code is terminated (and replaced lazily).
      assert.equal(log.batchWorkerTerminated[0]!(), true, 'The stuck batch worker is terminated');
      await program.dispose();
      provider.terminate();
      assert.equal(log.terminated, log.created, 'Every worker is terminated');
    });
  }
}

test('Python non-stopping batch keeps one request and its whole-batch results', async () => {
  const log: WorkerLog = { created: 0, terminated: 0, batchRequests: [], batchWorkerTerminated: [] };
  const { provider, program } = await preparedProgram('code', -1, log);
  const results = await program.executeBatchIsolated!({
    inputBatch: Array.from({ length: CASES }, (_, index) => ({ value: index + 1 })),
    limits: { wallClockMs: PER_CASE_MS },
  } as never) as readonly CodeExecutionResult[];
  assert.equal(results.length, CASES);
  assert.ok(results.every((result, index) => result.kind === 'completed' && result.output === index + 1));
  assert.equal(log.batchRequests.length, 1);
  assert.equal(log.batchRequests[0]!.reportCaseProgress, undefined, 'Submit does not ask for case progress');
  await program.dispose();
  provider.terminate();
});

test('Python stopping batch whose cases all finish returns every streamed result', async () => {
  for (const mode of ['code', 'trace'] as const) {
    const log: WorkerLog = { created: 0, terminated: 0, batchRequests: [], batchWorkerTerminated: [] };
    const { provider, program } = await preparedProgram(mode, -1, log);
    const inputBatch = Array.from({ length: CASES }, (_, index) => ({ value: index + 1 }));
    const results = await program.executeBatchIsolated!({
      inputBatch,
      limits: { wallClockMs: PER_CASE_MS },
      stopAtFirstRunaway: true,
      ...(mode === 'trace' ? { traceEnabledBatch: inputBatch.map(() => true) } : {}),
    } as never) as readonly (CodeExecutionResult | ExecutionResult)[];
    assert.equal(results.length, CASES, mode);
    assert.ok(results.every((result, index) => result.kind === 'completed' && result.output === index + 1), mode);
    await program.dispose();
    provider.terminate();
  }
});

test('Python stopping batch whose worker dies mid-batch reports a crash, not a time limit', async () => {
  const log: WorkerLog = { created: 0, terminated: 0, batchRequests: [], batchWorkerTerminated: [] };
  const { provider, program } = await preparedProgram('code', -1, log, 2);
  const results = await program.executeBatchIsolated!({
    inputBatch: Array.from({ length: CASES }, (_, index) => ({ value: index + 1 })),
    limits: { wallClockMs: PER_CASE_MS },
    stopAtFirstRunaway: true,
  } as never) as readonly CodeExecutionResult[];
  // As before: each case re-runs in a fresh worker so it gets its own outcome.
  assert.equal(results.length, CASES);
  assert.ok(results.every((result) => result.kind !== 'limit'), 'A crash is never a time limit');
  assert.equal(results[2]!.kind, 'failed');
  assert.ok(results.every((result, index) => index === 2 || result.kind === 'completed'));
  await program.dispose();
  provider.terminate();
  assert.equal(log.terminated, log.created, 'Every worker is terminated');
});

test('Python stopping batch aborted while a case runs ends at once and terminates the worker', async () => {
  const log: WorkerLog = { created: 0, terminated: 0, batchRequests: [], batchWorkerTerminated: [] };
  const { provider, program } = await preparedProgram('trace', 4, log);
  const controller = new AbortController();
  const inputBatch = Array.from({ length: CASES }, (_, index) => ({ value: index + 1 }));
  const running = program.executeBatchIsolated!({
    inputBatch,
    traceEnabledBatch: inputBatch.map(() => true),
    limits: { wallClockMs: 30_000 },
    stopAtFirstRunaway: true,
    signal: controller.signal,
  } as never);
  setTimeout(() => controller.abort(), 100);
  const startedAt = performance.now();
  await assert.rejects(running, { name: 'AbortError' });
  assert.ok(performance.now() - startedAt < 1_000, 'An abort does not wait for any clock');
  assert.equal(log.batchWorkerTerminated[0]!(), true, 'The aborted batch worker is terminated');
  await program.dispose();
  provider.terminate();
});

// A learner time limit belongs only to a case that started and never
// finished. A clock that runs out while no case is running is the provider's
// failure: no learner code was running, so no case may take the blame.
for (const mode of ['code', 'trace'] as const) {
  const label = mode === 'trace' ? 'traced' : 'untraced';

  test(`Python ${label} stopping batch whose worker stalls before its first case is a provider error, not a time limit on case 1`, async () => {
    const log = newLog();
    const { provider, program } = await preparedProgram(mode, -1, log, -1, { kind: 'before-first-case' });
    const inputBatch = [{ value: 1 }, { value: 2 }];
    await assert.rejects(
      program.executeBatchIsolated!({
        inputBatch,
        limits: { wallClockMs: 200 },
        stopAtFirstRunaway: true,
        ...(mode === 'trace' ? { traceEnabledBatch: inputBatch.map(() => true) } : {}),
      } as never),
      (error: Error) => {
        assert.equal(error.name, 'RuntimeProviderError', `${error.name}: ${error.message}`);
        assert.match(error.message, /first case/);
        return true;
      }
    );
    assert.equal(log.batchRequests.length, 1, 'No re-run of the cases');
    assert.equal(log.batchWorkerTerminated[0]!(), true, 'The stalled worker is terminated');
    await program.dispose();
    provider.terminate();
  });

  test(`Python ${label} stopping batch whose worker stalls between two cases is a provider error, not a time limit on a case that never started`, async () => {
    const log = newLog();
    const { provider, program } = await preparedProgram(mode, -1, log, -1, { kind: 'after-case', index: 0 });
    const inputBatch = [{ value: 1 }, { value: 2 }, { value: 3 }];
    await assert.rejects(
      program.executeBatchIsolated!({
        inputBatch,
        limits: { wallClockMs: 200 },
        stopAtFirstRunaway: true,
        ...(mode === 'trace' ? { traceEnabledBatch: inputBatch.map(() => true) } : {}),
      } as never),
      (error: Error) => {
        assert.equal(error.name, 'RuntimeProviderError', `${error.name}: ${error.message}`);
        assert.match(error.message, /case 2/);
        return true;
      }
    );
    assert.equal(log.batchWorkerTerminated[0]!(), true, 'The stalled worker is terminated');
    await program.dispose();
    provider.terminate();
  });
}
