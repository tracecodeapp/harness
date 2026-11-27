#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedCodeCall,
  RuntimePreparedTraceCall,
  RuntimeProgramPreparationCall,
  RuntimeExecutionTimings,
} from '../packages/runtime-contracts/src/index';
import {
  createEmptyRuntimeTrace,
  isRuntimeProviderError,
  isTraceUnavailableError,
} from '../packages/runtime-contracts/src/index';
import {
  createCSharpRuntimeClient,
  type CSharpPreparedWorkerAuthority,
} from '../packages/runtime-csharp/src/csharp-runtime-client';
import { encodeTraceClrWireResult } from '../packages/runtime-csharp/src/traceclr-wire';
import {
  CSHARP_DEFAULT_OBSERVATION_MAX_TRACE_BYTES,
  CSharpWorkerClient,
  type CSharpPreparedProgramArtifact,
  type CSharpWorkerPrepareResult,
} from '../packages/runtime-csharp/src/csharp-worker-client';

const TRACE_REFUSAL_CODE = 'csharp-trace-conditional-compilation-unsupported';
const TRACE_REFUSAL_MESSAGE =
  'Tracing is not available for programs that use conditional compilation (#if/#define).';

class FakePreparedCSharpWorker {
  prepareCalls: RuntimeProgramPreparationCall[] = [];
  executeCalls: Array<{
    prepared: CSharpPreparedProgramArtifact;
    call: RuntimePreparedCodeCall;
  }> = [];
  traceExecuteCalls: Array<{
    prepared: CSharpPreparedProgramArtifact;
    call: RuntimePreparedTraceCall;
    tracingEnabled: boolean;
  }> = [];
  disposeCalls: string[] = [];
  failPreparation = false;
  /** When set, the compiler declines every traced build with this refusal code. */
  traceRefusalCode: string | undefined;
  preparationTimeoutReason: 'client-timeout' | undefined;
  preparedRunnerTier: 'algorithm-fast' | 'compatibility' = 'compatibility';
  executionResult: CodeExecutionResult | undefined;
  managedHeapBytes = 0;
  terminated = false;

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return { success: true, loadTimeMs: 2 };
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<CSharpWorkerPrepareResult> {
    this.prepareCalls.push(call);
    if (this.preparationTimeoutReason) {
      return {
        success: false,
        error: 'C# compilation timed out.',
        timeoutReason: this.preparationTimeoutReason,
        consoleOutput: [],
      };
    }
    if (this.traceRefusalCode !== undefined && call.mode === 'trace') {
      return {
        success: false,
        // The compiler reply carries only the code; the client owns the wording.
        error: this.traceRefusalCode,
        refusalCode: this.traceRefusalCode,
        consoleOutput: [],
        timings: { compileMs: 1, compileCacheHit: false },
      };
    }
    if (this.failPreparation) {
      return {
        success: false,
        error: 'synthetic compiler failure',
        diagnostics: [{
          file: 'solution.cs',
          line: 4,
          column: 3,
          message: 'synthetic compiler failure',
          severity: 'error',
        }],
        consoleOutput: [],
        timings: { compileMs: 7, compileCacheHit: false },
      };
    }
    return {
      success: true,
      compiledArtifactKey: 'artifact-key',
      compiledArtifactBase64: 'TVqQAAMAAAAEAAAA',
      compiledArtifactSha256:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      preparedRunnerTier: this.preparedRunnerTier,
      preparedRunnerReason: this.preparedRunnerTier === 'algorithm-fast'
        ? 'direct wire driver'
        : 'compatibility driver',
      ...(this.preparedRunnerTier === 'algorithm-fast'
        ? {
            traceClrWireContract: {
              parameters: [{ name: 'value', type: { wireType: 'int32' } }],
              returnType: { wireType: 'int32' },
            },
          }
        : {}),
      consoleOutput: ['compiled once'],
      timings: { compileMs: 7, compileCacheHit: false },
    };
  }

  async executePreparedCode(
    prepared: CSharpPreparedProgramArtifact,
    call: RuntimePreparedCodeCall
  ): Promise<CodeExecutionResult> {
    this.executeCalls.push({ prepared, call });
    if (call.signal) {
      await new Promise<void>((resolve, reject) => {
        if (call.signal?.aborted) {
          reject(call.signal.reason);
          return;
        }
        call.signal?.addEventListener('abort', () => reject(call.signal?.reason), {
          once: true,
        });
        if (!('wait' in call.inputs)) resolve();
      });
    }
    if (this.executionResult) return this.executionResult;
    return {
      kind: 'completed',
      output: call.inputs.value ?? null,
      consoleOutput: [],
      timings: {
        compileMs: 0,
        compileCacheHit: true,
        artifactCacheHit: true,
        ...(this.managedHeapBytes > 0
          ? { managedHeapBytes: this.managedHeapBytes }
          : {}),
      } as RuntimeExecutionTimings,
    };
  }

  async executePreparedTrace(
    prepared: CSharpPreparedProgramArtifact,
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult> {
    const tracingEnabled = call.recordTrace ?? true;
    this.traceExecuteCalls.push({ prepared, call, tracingEnabled });
    const trace = createEmptyRuntimeTrace('csharp');
    if (tracingEnabled) {
      trace.events.push({
        runId: trace.runId,
        kind: 'return',
        line: 1,
        file: 'solution.cs',
        value: call.inputs.value,
      });
      trace.traceStepCount = 1;
    }
    return {
      kind: 'completed',
      output: call.inputs.value ?? null,
      trace,
      executionTimeMs: 1,
      consoleOutput: [],
      timings: { compileCacheHit: true, artifactCacheHit: true },
    };
  }

  async disposePreparedProgram(
    prepared: Pick<CSharpPreparedProgramArtifact, 'compiledArtifactKey'>
  ): Promise<void> {
    this.disposeCalls.push(prepared.compiledArtifactKey);
  }

  terminate(): void {
    this.terminated = true;
  }
}

test('C# runtime client owns one opaque prepared artifact through exact disposal', async () => {
  const worker = new FakePreparedCSharpWorker();
  const provider = createCSharpRuntimeClient(worker as unknown as CSharpWorkerClient);
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Echo(int value) => value; }',
    functionName: 'Echo',
    executionStyle: 'solution-method',
  });

  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') return;
  assert.deepEqual(prepared.consoleOutput, ['compiled once']);
  assert.equal(prepared.program.capabilities.profile, 'compatibility');
  assert.equal(prepared.program.capabilities.caseIsolation, 'fresh-case-state');
  assert.equal(prepared.program.capabilities.maxConcurrency, 1);
  assert.equal(worker.prepareCalls.length, 1);

  assert.equal(prepared.program.mode, 'code');
  if (prepared.program.mode !== 'code') return;
  const first = await prepared.program.executeIsolated({ inputs: { value: 3 } });
  const second = await prepared.program.executeIsolated({ inputs: { value: 5 } });
  assert.equal(first.kind, 'completed');
  assert.equal(second.kind, 'completed');
  assert.equal(worker.executeCalls.length, 2);
  assert.strictEqual(
    worker.executeCalls[0]?.prepared,
    worker.executeCalls[1]?.prepared,
    'all cases must execute the same immutable prepared artifact'
  );
  assert.equal(worker.executeCalls[0]?.prepared.compiledArtifactKey, 'artifact-key');

  await prepared.program.dispose();
  await prepared.program.dispose();
  assert.deepEqual(worker.disposeCalls, ['artifact-key']);
  await assert.rejects(
    prepared.program.executeIsolated({ inputs: { value: 8 } }),
    /disposed/
  );
});

test('C# prepared provider reports compile diagnostics before it creates a program', async () => {
  const worker = new FakePreparedCSharpWorker();
  worker.failPreparation = true;
  const provider = createCSharpRuntimeClient(worker as unknown as CSharpWorkerClient);
  const result = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution {',
    functionName: 'Broken',
  });

  assert.equal(result.kind, 'failed');
  if (result.kind !== 'failed') return;
  assert.equal(result.diagnosticStage, 'compile');
  assert.equal(result.errorLine, 4);
  assert.equal(worker.executeCalls.length, 0);
  assert.equal(worker.disposeCalls.length, 0);
});

test('C# compile that hits a deadline is the provider failure, never a learner limit', async () => {
  const worker = new FakePreparedCSharpWorker();
  worker.preparationTimeoutReason = 'client-timeout';
  const provider = createCSharpRuntimeClient(worker as unknown as CSharpWorkerClient);
  await assert.rejects(
    provider.prepareProgram({
      mode: 'code',
      code: 'public class Solution { public int Solve(int n) => n; }',
      functionName: 'Solve',
    }),
    (error: unknown) => isRuntimeProviderError(error) && /deadline/.test((error as Error).message)
  );
});

test('C# prepared execution forwards cancellation into the active worker request', async () => {
  const worker = new FakePreparedCSharpWorker();
  const provider = createCSharpRuntimeClient(worker as unknown as CSharpWorkerClient);
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Wait() { while (true) {} } }',
    functionName: 'Wait',
  });
  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') return;

  const controller = new AbortController();
  const execution = prepared.program.executeIsolated({
    inputs: { wait: true },
    signal: controller.signal,
  });
  const reason = new Error('cancel prepared C#');
  controller.abort(reason);
  await assert.rejects(execution, reason);
  assert.notStrictEqual(worker.executeCalls[0]?.call.signal, controller.signal);
  assert.equal(worker.executeCalls[0]?.call.signal?.aborted, true);
  assert.strictEqual(worker.executeCalls[0]?.call.signal?.reason, reason);
  await prepared.program.dispose();
});

test('C# prepared disposal aborts and drains active execution before releasing its artifact', async () => {
  const worker = new FakePreparedCSharpWorker();
  const provider = createCSharpRuntimeClient(worker as unknown as CSharpWorkerClient);
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Wait() { while (true) {} } }',
    functionName: 'Wait',
  });
  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') return;

  const execution = prepared.program.executeIsolated({
    inputs: { wait: true },
  });
  const disposal = prepared.program.dispose();
  assert.deepEqual(
    worker.disposeCalls,
    [],
    'artifact disposal must wait for the active case to settle'
  );
  await assert.rejects(execution, /disposed during active execution/);
  await disposal;
  assert.equal(worker.executeCalls[0]?.call.signal?.aborted, true);
  assert.deepEqual(worker.disposeCalls, ['artifact-key']);
  await assert.rejects(
    prepared.program.executeIsolated({ inputs: {} }),
    /disposed/
  );
});

test('C# prepared execution preserves per-case limits and limit results', async () => {
  const worker = new FakePreparedCSharpWorker();
  worker.executionResult = {
    kind: 'limit',
    reason: 'client-timeout',
    error: 'synthetic prepared timeout',
    consoleOutput: [],
    timings: {
      totalMs: 25,
      compileCacheHit: true,
      artifactCacheHit: true,
    },
  };
  const provider = createCSharpRuntimeClient(worker as unknown as CSharpWorkerClient);
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Slow() => 1; }',
    functionName: 'Slow',
  });
  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') return;

  const result = await prepared.program.executeIsolated({
    inputs: {},
    limits: { wallClockMs: 25 },
  });
  assert.equal(result.kind, 'limit');
  assert.equal(worker.executeCalls[0]?.call.limits?.wallClockMs, 25);
  assert.equal(result.timings?.compileCacheHit, true);
  assert.equal(result.timings?.artifactCacheHit, true);
  await prepared.program.dispose();
});

test('C# prepared batches lease one disposable outer runner per case', async () => {
  const compiler = new FakePreparedCSharpWorker();
  const runners: FakePreparedCSharpWorker[] = [];
  const released: FakePreparedCSharpWorker[] = [];
  const authority: CSharpPreparedWorkerAuthority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 3,
    warmup: () => compiler.init(),
    createRunner() {
      const runner = new FakePreparedCSharpWorker();
      runners.push(runner);
      return runner as unknown as CSharpWorkerClient;
    },
    releaseRunner(runner) {
      released.push(runner as unknown as FakePreparedCSharpWorker);
    },
  };
  const provider = createCSharpRuntimeClient(
    compiler as unknown as CSharpWorkerClient,
    authority
  );
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Echo(int value) => value; }',
    functionName: 'Echo',
  });
  assert.equal(prepared.kind, 'prepared');
  if (
    prepared.kind !== 'prepared' ||
    prepared.program.mode !== 'code' ||
    !prepared.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await prepared.program.executeBatchIsolated({
    inputBatch: [{ value: 3 }, { value: 5 }, { value: 7 }],
    limits: { wallClockMs: 2_000 },
  });
  assert.deepEqual(
    results.map((result) => result.kind === 'completed' ? result.output : null),
    [3, 5, 7]
  );
  assert.equal(runners.length, 3);
  assert.equal(released.length, 3);
  assert.equal(compiler.executeCalls.length, 0);
  for (const runner of runners) {
    assert.equal(runner.executeCalls.length, 1);
    assert.equal(runner.executeCalls[0]?.call.limits?.wallClockMs, 2_000);
    assert.equal(runner.terminated, true);
    assert.strictEqual(
      runner.executeCalls[0]?.prepared,
      runners[0]?.executeCalls[0]?.prepared
    );
  }
  await prepared.program.dispose();
});

test('C# algorithm-fast batches retain one outer runner with managed per-case isolation', async () => {
  const compiler = new FakePreparedCSharpWorker();
  compiler.preparedRunnerTier = 'algorithm-fast';
  const runners: FakePreparedCSharpWorker[] = [];
  const released: FakePreparedCSharpWorker[] = [];
  const authority: CSharpPreparedWorkerAuthority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 4,
    warmup: () => compiler.init(),
    createRunner() {
      const runner = new FakePreparedCSharpWorker();
      runners.push(runner);
      return runner as unknown as CSharpWorkerClient;
    },
    releaseRunner(runner) {
      released.push(runner as unknown as FakePreparedCSharpWorker);
    },
  };
  const provider = createCSharpRuntimeClient(
    compiler as unknown as CSharpWorkerClient,
    authority
  );
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Echo(int value) => value; }',
    functionName: 'Echo',
  });
  assert.equal(prepared.kind, 'prepared');
  if (
    prepared.kind !== 'prepared' ||
    prepared.program.mode !== 'code' ||
    !prepared.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await prepared.program.executeBatchIsolated({
    inputBatch: [{ value: 3 }, { value: 5 }, { value: 7 }],
    limits: { wallClockMs: 2_000 },
  });
  assert.deepEqual(
    results.map((result) => result.kind === 'completed' ? result.output : null),
    [3, 5, 7]
  );
  const fourth = await prepared.program.executeIsolated({
    inputs: { value: 11 },
    limits: { wallClockMs: 2_000 },
  });
  const fifth = await prepared.program.executeIsolated({
    inputs: { value: 13 },
    limits: { wallClockMs: 2_000 },
  });
  assert.equal(fourth.kind === 'completed' ? fourth.output : null, 11);
  assert.equal(fifth.kind === 'completed' ? fifth.output : null, 13);
  assert.equal(runners.length, 1);
  assert.equal(released.length, 0);
  assert.equal(runners[0]?.executeCalls.length, 5);
  assert.equal(runners[0]?.terminated, false);
  assert.ok(runners[0]?.executeCalls.every(
    (call) => call.call.limits?.wallClockMs === 2_000
  ));
  await prepared.program.dispose();
  assert.equal(released.length, 1);
  assert.equal(runners[0]?.terminated, true);
});

test('C# algorithm-fast batches rotate retained runners at the context bound', async () => {
  const compiler = new FakePreparedCSharpWorker();
  compiler.preparedRunnerTier = 'algorithm-fast';
  const runners: FakePreparedCSharpWorker[] = [];
  const released: FakePreparedCSharpWorker[] = [];
  const authority: CSharpPreparedWorkerAuthority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 4,
    warmup: () => compiler.init(),
    createRunner() {
      const runner = new FakePreparedCSharpWorker();
      runners.push(runner);
      return runner as unknown as CSharpWorkerClient;
    },
    releaseRunner(runner) {
      released.push(runner as unknown as FakePreparedCSharpWorker);
    },
  };
  const provider = createCSharpRuntimeClient(
    compiler as unknown as CSharpWorkerClient,
    authority
  );
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Echo(int value) => value; }',
    functionName: 'Echo',
  });
  assert.equal(prepared.kind, 'prepared');
  if (
    prepared.kind !== 'prepared' ||
    prepared.program.mode !== 'code' ||
    !prepared.program.executeBatchIsolated
  ) {
    return;
  }

  const inputBatch = Array.from({ length: 65 }, (_, value) => ({ value }));
  const results = await prepared.program.executeBatchIsolated({ inputBatch });
  assert.deepEqual(
    results.map((result) => result.kind === 'completed' ? result.output : null),
    inputBatch.map(({ value }) => value)
  );
  assert.equal(runners.length, 2);
  assert.equal(released.length, 1);
  assert.deepEqual(
    runners.map((runner) => runner.executeCalls.length),
    [64, 1]
  );
  assert.equal(runners[0]?.terminated, true);
  assert.equal(runners[1]?.terminated, false);
  await prepared.program.dispose();
  assert.equal(released.length, 2);
  assert.ok(runners.every((runner) => runner.terminated));
});

test('C# algorithm-fast batches rotate retained runners at the managed-heap bound', async () => {
  const compiler = new FakePreparedCSharpWorker();
  compiler.preparedRunnerTier = 'algorithm-fast';
  const runners: FakePreparedCSharpWorker[] = [];
  const authority: CSharpPreparedWorkerAuthority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 4,
    warmup: () => compiler.init(),
    createRunner() {
      const runner = new FakePreparedCSharpWorker();
      runner.managedHeapBytes = 64 * 1024 * 1024;
      runners.push(runner);
      return runner as unknown as CSharpWorkerClient;
    },
    releaseRunner() {},
  };
  const provider = createCSharpRuntimeClient(
    compiler as unknown as CSharpWorkerClient,
    authority
  );
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Echo(int value) => value; }',
    functionName: 'Echo',
  });
  assert.equal(prepared.kind, 'prepared');
  if (
    prepared.kind !== 'prepared' ||
    prepared.program.mode !== 'code' ||
    !prepared.program.executeBatchIsolated
  ) {
    return;
  }

  const results = await prepared.program.executeBatchIsolated({
    inputBatch: [{ value: 3 }, { value: 5 }, { value: 7 }],
  });
  assert.deepEqual(
    results.map((result) => result.kind === 'completed' ? result.output : null),
    [3, 5, 7]
  );
  assert.equal(runners.length, 3);
  assert.ok(runners.every(
    (runner) => runner.executeCalls.length === 1 && runner.terminated
  ));
  await prepared.program.dispose();
});

test('C# prepared runner tier is selected before execution and never degrades after learner failure', async () => {
  const compiler = new FakePreparedCSharpWorker();
  compiler.preparedRunnerTier = 'algorithm-fast';
  const selectedTiers: Array<'algorithm-fast' | 'compatibility'> = [];
  const runner = new FakePreparedCSharpWorker();
  runner.executionResult = {
    kind: 'failed',
    error: 'synthetic learner failure',
    diagnosticStage: 'runtime',
    consoleOutput: [],
  };
  const authority: CSharpPreparedWorkerAuthority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 1,
    warmup: () => compiler.init(),
    createRunner(tier) {
      selectedTiers.push(tier);
      return runner as unknown as CSharpWorkerClient;
    },
    releaseRunner() {},
  };
  const provider = createCSharpRuntimeClient(
    compiler as unknown as CSharpWorkerClient,
    authority
  );
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Echo(int value) => value; }',
    functionName: 'Echo',
    executionStyle: 'solution-method',
  });
  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') return;
  assert.equal(prepared.program.capabilities.profile, 'fast');

  const result = await prepared.program.executeIsolated({ inputs: { value: 3 } });
  assert.equal(result.kind, 'failed');
  assert.deepEqual(selectedTiers, ['algorithm-fast']);
  assert.equal(runner.executeCalls.length, 1);
  await prepared.program.dispose();
});

test('C# portable trace selection records only selected cases from one assembly', async () => {
  const compiler = new FakePreparedCSharpWorker();
  compiler.preparedRunnerTier = 'algorithm-fast';
  const runners: FakePreparedCSharpWorker[] = [];
  const selectedTiers: Array<'algorithm-fast' | 'compatibility'> = [];
  const authority: CSharpPreparedWorkerAuthority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 3,
    warmup: () => compiler.init(),
    createRunner(tier) {
      selectedTiers.push(tier);
      const runner = new FakePreparedCSharpWorker();
      runners.push(runner);
      return runner as unknown as CSharpWorkerClient;
    },
    releaseRunner() {},
  };
  const provider = createCSharpRuntimeClient(
    compiler as unknown as CSharpWorkerClient,
    authority
  );
  const prepared = await provider.prepareProgram({
    mode: 'trace',
    code: 'public class Solution { public int Echo(int value) => value; }',
    functionName: 'Echo',
    executionStyle: 'solution-method',
  });
  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared' || prepared.program.mode !== 'trace') return;

  const results = await prepared.program.executeBatchIsolated!({
    inputBatch: [{ value: 3 }, { value: 5 }, { value: 7 }],
    traceEnabledBatch: [true, false, true],
  });
  assert.deepEqual(
    results.map((result) => result.kind === 'completed' ? result.output : null),
    [3, 5, 7]
  );
  assert.deepEqual(
    results.map((result) => result.trace.events.length),
    [1, 0, 1]
  );
  assert.deepEqual(
    runners[0]?.traceExecuteCalls.map((call) => call.tracingEnabled),
    [true, false, true]
  );
  assert.deepEqual(
    selectedTiers,
    ['algorithm-fast'],
    'trace selection must retain one compiler-selected fast runner for the guarded batch'
  );
  assert.ok(
    runners[0]?.traceExecuteCalls.every(
      (call) =>
        call.prepared.compiledArtifactKey ===
        'artifact-key'
    ),
    'every selected case must retain the same trace-capable assembly identity'
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      prepared.program.executeBatchIsolated!({
        inputBatch: [{ value: 1 }],
        traceEnabledBatch: [true, false],
      })
    ),
    /one boolean per batch case/
  );
  await prepared.program.dispose();
  await assert.rejects(
    Promise.resolve().then(() =>
      prepared.program.executeBatchIsolated!({
        inputBatch: [{ value: 1 }],
        traceEnabledBatch: [false],
      })
    ),
    /disposed/
  );
});

test('C# prepared batch failure drains every active runner before rejection', async () => {
  const compiler = new FakePreparedCSharpWorker();
  const failedRunner = new FakePreparedCSharpWorker();
  const slowRunner = new FakePreparedCSharpWorker();
  const failure = new Error('synthetic runner failure');
  failedRunner.executePreparedCode = async () => {
    throw failure;
  };
  let releaseSlow!: () => void;
  let markSlowStarted!: () => void;
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  slowRunner.executePreparedCode = async (_prepared, call) => {
    markSlowStarted();
    await slowGate;
    return {
      kind: 'completed',
      output: call.inputs.value,
      consoleOutput: [],
    };
  };
  const available = [failedRunner, slowRunner];
  const released: FakePreparedCSharpWorker[] = [];
  let runnerLeaseCount = 0;
  const authority: CSharpPreparedWorkerAuthority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 2,
    warmup: () => compiler.init(),
    createRunner() {
      runnerLeaseCount += 1;
      const runner = available.shift();
      assert.ok(runner);
      return runner as unknown as CSharpWorkerClient;
    },
    releaseRunner(runner) {
      released.push(runner as unknown as FakePreparedCSharpWorker);
    },
  };
  const provider = createCSharpRuntimeClient(
    compiler as unknown as CSharpWorkerClient,
    authority
  );
  const prepared = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Echo(int value) => value; }',
    functionName: 'Echo',
  });
  assert.equal(prepared.kind, 'prepared');
  if (
    prepared.kind !== 'prepared' ||
    prepared.program.mode !== 'code' ||
    !prepared.program.executeBatchIsolated
  ) {
    return;
  }

  const batch = prepared.program.executeBatchIsolated({
    inputBatch: [
      { value: 1 },
      { value: 2 },
      { value: 3 },
      { value: 4 },
    ],
  });
  await slowStarted;
  let rejected = false;
  void batch.catch(() => {
    rejected = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(
    rejected,
    false,
    'batch rejection must wait for every active runner to settle'
  );
  releaseSlow();
  await assert.rejects(batch, /synthetic runner failure/);
  assert.equal(failedRunner.terminated, true);
  assert.equal(slowRunner.terminated, true);
  assert.equal(released.length, 2);
  assert.equal(
    runnerLeaseCount,
    2,
    'only the two already-active runners should have been leased'
  );
  await prepared.program.dispose();
});

test('C# host prepared entry point cannot fall through to the compiling execution path', () => {
  const source = readFileSync(
    'packages/runtime-csharp/dotnet/TraceCode.CSharpHost/CompilerHost.cs',
    'utf8'
  );
  const preparedEntryPoint = source.slice(
    source.indexOf('public static string ExecutePrepared(string requestJson)'),
    source.indexOf('public static bool DisposePreparedArtifact(string artifactKey)')
  );

  assert.match(
    preparedEntryPoint,
    /Invalid prepared C# execution request\./
  );
  assert.doesNotMatch(
    preparedEntryPoint,
    /return Execute\(requestJson\);/,
    'invalid prepared requests must not regain access to Roslyn through Execute'
  );
  assert.match(
    preparedEntryPoint,
    /finally\s*\{\s*\/\/ This is the lifecycle boundary[\s\S]*?RuntimeTraceSink\.Reset\(\);\s*Console\.SetOut\(originalOut\);/,
    'prepared trace state must reset even when execution fails before assembly loading'
  );
});

test('C# tracing-disabled execution branches above rewritten learner bodies', () => {
  const rewriterSource = readFileSync(
    'packages/runtime-csharp/dotnet/TraceCode.CSharpHost/TraceRewriter.cs',
    'utf8'
  );
  const executionModeBody = rewriterSource.slice(
    rewriterSource.indexOf('private BlockSyntax CreateExecutionModeBody('),
    rewriterSource.indexOf('private sealed class DisabledPathCompatibilityRewriter')
  );

  assert.match(
    executionModeBody,
    /SyntaxKind\.LogicalNotExpression[\s\S]*"TraceCode\.CSharpHost\.RuntimeTraceSink\.RecordingEnabled"/
  );
  assert.match(
    executionModeBody,
    /compatibleOriginalBody[\s\S]*SyntaxFactory\.ElseClause\([\s\S]*instrumentedBody/,
    'the off branch must select the original learner body before tracing helpers execute'
  );

  const runtimeSource = readFileSync(
    'packages/runtime-csharp/dotnet/TraceCode.CSharpJudgeRuntime/JudgeRuntimeSupport.cs',
    'utf8'
  );
  assert.match(
    runtimeSource,
    /base\.Add\(item\);\s*if \(!TraceCode\.CSharpHost\.RuntimeTraceSink\.RecordingEnabled\) return;/,
    'trace-aware member collections must stop before mutation argument allocation when tracing is off'
  );
});

test('C# observation prepares a companion and uses a dedicated runner during ordinary execution', async () => {
  const compiler = new FakePreparedCSharpWorker();
  const ordinaryRunner = new FakePreparedCSharpWorker();
  const observerRunner = new FakePreparedCSharpWorker();
  compiler.preparedRunnerTier = 'algorithm-fast';
  const observationCalls: Array<{ prepared: CSharpPreparedProgramArtifact; inputs: Record<string, unknown> }> = [];
  const ordinaryStarted = Promise.withResolvers<void>();
  const releaseOrdinary = Promise.withResolvers<void>();
  const executeCode = ordinaryRunner.executePreparedCode.bind(ordinaryRunner);
  ordinaryRunner.executePreparedCode = async (prepared, call) => {
    ordinaryStarted.resolve();
    await releaseOrdinary.promise;
    return executeCode(prepared, call);
  };
  Object.assign(observerRunner, {
    async observePrepared(prepared: CSharpPreparedProgramArtifact, call: { inputs: Record<string, unknown> }) {
      observationCalls.push({ prepared, inputs: call.inputs });
      return { status: 'refused', reason: 'observer-encode' };
    },
  });
  const authority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 1,
    warmup: () => compiler.init(),
    createRunner: () => ordinaryRunner as unknown as CSharpWorkerClient,
    createObserverRunner: () => observerRunner as unknown as CSharpWorkerClient,
    releaseRunner() {},
    releaseObserverRunner() {},
  };
  const provider = createCSharpRuntimeClient(authority.compiler, authority);
  const program = {
    code: 'public class Solution { public int Solve(int value) => value; }',
    functionName: 'Solve',
    executionStyle: 'solution-method' as const,
  };
  const ordinary = await provider.prepareProgram({ ...program, mode: 'code' });
  assert.ok(ordinary.kind === 'prepared' && ordinary.program.mode === 'code');
  const codeProgram = ordinary.program;
  const batch = codeProgram.executeBatchIsolated!({ inputBatch: [{ value: 7 }, { value: 11 }] });
  await ordinaryStarted.promise;
  try {
    const observer = await provider.prepareObservation(program, undefined, { maxTraceBytes: 1 });
    assert.ok(!('status' in observer));
    assert.deepEqual(compiler.prepareCalls.map(({ mode }) => mode), ['code'], 'ordinary compilation has priority');
    try {
      const drawing = await observer.observe({
        program, inputs: { value: 7 }, attemptToken: 'observation-attempt',
        traceOptions: { maxTraceBytes: 1 },
      });
      assert.deepEqual(drawing, { status: 'refused', reason: 'observer-encode' });
      assert.deepEqual(compiler.prepareCalls.map(({ mode }) => mode), ['code', 'trace']);
      assert.equal(compiler.prepareCalls[0]?.traceOptions, undefined);
      assert.equal(observationCalls.length, 1);
      assert.equal(observationCalls[0]?.prepared.mode, 'trace');
      assert.deepEqual(observationCalls[0]?.inputs, { value: 7 });
      assert.equal(observerRunner.terminated, true);
    } finally {
      await observer.dispose();
    }
  } finally {
    releaseOrdinary.resolve();
    try {
      const results = await batch;
      assert.deepEqual(results.map((row) => row.kind === 'completed' && row.output), [7, 11]);
      assert.deepEqual(ordinaryRunner.executeCalls.map(({ prepared }) => prepared.mode), ['code', 'code']);
      assert.equal(ordinaryRunner.terminated, false);
    } finally {
      await codeProgram.dispose();
    }
  }
});

test('C# refuses unsupported observer options at preparation without entering Roslyn', async () => {
  const compiler = new FakePreparedCSharpWorker();
  const provider = createCSharpRuntimeClient(compiler as unknown as CSharpWorkerClient);
  const result = await provider.prepareObservation({
    code: 'public class Solution { public int Solve(int value) => value; }',
    functionName: 'Solve',
  }, undefined, { traceProfile: true });
  assert.deepEqual(result, { status: 'refused', reason: 'unsupported-option' });
  assert.equal(compiler.prepareCalls.length, 0);
});


test('a valid oversized TraceCLR collection is a case limit, and malformed replies are protocol errors', async () => {
  const traceClrWireContract = {
    parameters: [],
    returnType: { wireType: 'array<int32>' },
  };
  function payload(length: number, items: number) {
    const header = encodeTraceClrWireResult(traceClrWireContract, []);
    const bytes = new Uint8Array(header.length + items * 4);
    bytes.set(header);
    new DataView(bytes.buffer).setInt32(4, length, true);
    return bytes;
  }

  let outputBytes = payload(1_000_001, 1_000_001);
  const client = new CSharpWorkerClient({
    workerUrl: '/csharp.js',
    assetBaseUrl: '/workers/vendor/csharp-runner',
    runtimeRole: 'runner',
    debug: false,
    workerFactory() {
      const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null,
        postMessage(message: { id: string; protocolToken: string; type: string }) {
          queueMicrotask(() => worker.onmessage?.({
            data: {
              ...message,
              payload: message.type === 'execute-prepared-code'
                ? { success: true, outputBytes }
                : { success: true, loadTimeMs: 0 },
            },
          } as MessageEvent));
        },
        terminate() {},
      };
      queueMicrotask(() => worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
      return worker;
    },
  });
  const artifact: CSharpPreparedProgramArtifact = {
    mode: 'code',
    code: '',
    functionName: 'solve',
    executionStyle: 'solution-method',
    compiledArtifactKey: '0'.repeat(64),
    compiledArtifactBase64: 'TVqQAAMAAAAEAAAA',
    compiledArtifactSha256: '0'.repeat(64),
    preparedRunnerTier: 'algorithm-fast',
    preparedRunnerReason: 'test',
    traceClrWireContract,
  };
  const execute = () => client.executePreparedCode(artifact, { inputs: {} });
  try {
    const limited = await execute();
    assert.equal(limited.kind, 'limit');
    if (limited.kind === 'limit') assert.equal(limited.reason, 'serialization-limit');
    assert.equal(Object.hasOwn(limited, 'output'), false);

    for (const malformed of [payload(-2, 0), payload(1_000_001, 0), payload(1_000_001, 1_000_002)]) {
      outputBytes = malformed;
      await assert.rejects(execute, (error) => isRuntimeProviderError(error) && error.reason === 'protocol');
    }
    outputBytes = payload(2, 2);
    const normal = await execute();
    assert.equal(normal.kind, 'completed');
    if (normal.kind === 'completed') assert.deepEqual(normal.output, [0, 0]);
  } finally {
    client.terminate();
  }
});

test('C# observation reports a declined traced build as a typed drawing refusal', async () => {
  const compiler = new FakePreparedCSharpWorker();
  compiler.traceRefusalCode = TRACE_REFUSAL_CODE;
  let observerRunners = 0;
  const authority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 1,
    warmup: () => compiler.init(),
    createRunner: () => new FakePreparedCSharpWorker() as unknown as CSharpWorkerClient,
    createObserverRunner: () => {
      observerRunners += 1;
      return new FakePreparedCSharpWorker() as unknown as CSharpWorkerClient;
    },
    releaseRunner() {},
    releaseObserverRunner() {},
  };
  const provider = createCSharpRuntimeClient(authority.compiler, authority);
  const program = {
    code: 'public class Solution { public int Solve(int value) => value; }',
    functionName: 'Solve',
    executionStyle: 'solution-method' as const,
  };
  const observer = await provider.prepareObservation(program);
  assert.ok(!('status' in observer));
  try {
    for (const attemptToken of ['first', 'second']) {
      const drawing = await observer.observe({ program, inputs: { value: 7 }, attemptToken });
      assert.deepEqual(drawing, { status: 'refused', reason: TRACE_REFUSAL_CODE });
    }
    assert.deepEqual(compiler.prepareCalls.map(({ mode }) => mode), ['trace'], 'the traced build is attempted once');
    assert.equal(observerRunners, 0, 'no observer runner starts for a declined traced build');
  } finally {
    await observer.dispose();
  }
  assert.deepEqual(compiler.disposeCalls, []);
});

test('C# prepared trace program reports a declined traced build as trace-unavailable', async () => {
  const worker = new FakePreparedCSharpWorker();
  worker.traceRefusalCode = TRACE_REFUSAL_CODE;
  const provider = createCSharpRuntimeClient(worker as unknown as CSharpWorkerClient);
  await assert.rejects(
    provider.prepareProgram({
      mode: 'trace',
      code: 'public class Solution { public int Solve(int n) => n; }',
      functionName: 'Solve',
    }),
    (error: unknown) => isRuntimeProviderError(error) && isTraceUnavailableError(error) &&
      (error as Error).message === TRACE_REFUSAL_MESSAGE
  );
  const ordinary = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Solve(int n) => n; }',
    functionName: 'Solve',
  });
  assert.equal(ordinary.kind, 'prepared', 'the ordinary build of the same program is unaffected');
  if (ordinary.kind === 'prepared') await ordinary.program.dispose();
});

test('C# ordinary preparation never reads a refusal code as a trace refusal', async () => {
  const worker = new FakePreparedCSharpWorker();
  worker.prepareProgram = async (call) => {
    worker.prepareCalls.push(call);
    return {
      success: false,
      error: 'synthetic compiler failure',
      refusalCode: TRACE_REFUSAL_CODE,
      consoleOutput: [],
    };
  };
  const provider = createCSharpRuntimeClient(worker as unknown as CSharpWorkerClient);
  const result = await provider.prepareProgram({
    mode: 'code',
    code: 'public class Solution { public int Solve(int n) => n; }',
    functionName: 'Solve',
  });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.diagnosticStage, 'compile');
});

test('C# compiler declines conditional compilation only for traced builds, before any trace rewrite', () => {
  const source = readFileSync(
    'packages/runtime-csharp/dotnet/TraceCode.CSharpHost/CompilerHost.cs',
    'utf8'
  );
  const plan = source.slice(
    source.indexOf('private static PreparedCompilationPlan CreateCompilationPlan('),
    source.indexOf('private static string GeneratePreparedArtifactMetadataSource(')
  );
  const guard = plan.indexOf('if (request.Trace)');
  assert.ok(guard > 0, 'the traced build checks its source');
  assert.match(plan.slice(guard), /^if \(request\.Trace\)\s*\{?\s*RefuseUntraceableDirectives\(originalUserTree\);/);
  assert.ok(guard < plan.indexOf('TraceRewriter.Instrument('), 'the check runs before the trace rewrite');

  const execute = source.slice(
    source.indexOf('public static string Execute(string requestJson)'),
    source.indexOf('public static string ExecuteProject(string requestJson)')
  );
  const executeGuard = execute.indexOf('RefuseUntraceableDirectives(');
  assert.ok(executeGuard > 0, 'single-call traced execution checks its source');
  assert.ok(
    executeGuard < execute.indexOf('TryGetCompiledArtifact('),
    'the check runs before any cached artifact is reused'
  );

  const check = source.slice(
    source.indexOf('private static void RefuseUntraceableDirectives('),
    source.indexOf('private static void ValidateUserSourcePolicy(')
  );
  const refused = [...check.matchAll(/SyntaxKind\.(\w+)DirectiveTrivia/g)].map((match) => match[1]).sort();
  assert.deepEqual(refused, ['Define', 'Elif', 'Else', 'EndIf', 'If', 'Undef']);
  assert.match(check, /descendIntoTrivia: true/);
  assert.doesNotMatch(source, /conditional compilation \(#if/, 'the learner-facing wording lives in the client, not the compiler');
});

test('a C# drawing has a finite byte budget when the caller sets none', async () => {
  assert.ok(Number.isSafeInteger(CSHARP_DEFAULT_OBSERVATION_MAX_TRACE_BYTES));
  assert.ok(CSHARP_DEFAULT_OBSERVATION_MAX_TRACE_BYTES > 0 && CSHARP_DEFAULT_OBSERVATION_MAX_TRACE_BYTES <= 0x7fff_ffff);
  const sent: Array<{ maxTraceBytes?: unknown }> = [];
  const client = new CSharpWorkerClient({
    workerUrl: '/csharp.js',
    assetBaseUrl: '/workers/vendor/csharp-runner',
    runtimeRole: 'runner',
    debug: false,
    workerFactory() {
      const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null,
        postMessage(message: { id: string; protocolToken: string; type: string; payload?: any }) {
          const observation = message.payload?.observation;
          if (message.type === 'execute-prepared-trace') sent.push({ ...observation });
          queueMicrotask(() => worker.onmessage?.({
            data: {
              ...message,
              payload: message.type === 'execute-prepared-trace'
                ? {
                    observationStatus: 'truncated',
                    reason: 'byte-budget',
                    events: [],
                    attemptedEvents: 1,
                    observation: { attemptToken: observation.attemptToken },
                  }
                : { success: true, loadTimeMs: 0 },
            },
          } as MessageEvent));
        },
        terminate() {},
      };
      queueMicrotask(() => worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
      return worker;
    },
  });
  const artifact: CSharpPreparedProgramArtifact = {
    mode: 'trace',
    code: '',
    functionName: 'solve',
    executionStyle: 'solution-method',
    compiledArtifactKey: '0'.repeat(64),
    compiledArtifactBase64: 'TVqQAAMAAAAEAAAA',
    compiledArtifactSha256: '0'.repeat(64),
    preparedRunnerTier: 'compatibility',
    preparedRunnerReason: 'test',
  };
  const program = { code: '', functionName: 'solve', executionStyle: 'solution-method' as const };
  try {
    for (const [traceOptions, expected] of [
      [undefined, CSHARP_DEFAULT_OBSERVATION_MAX_TRACE_BYTES],
      [{}, CSHARP_DEFAULT_OBSERVATION_MAX_TRACE_BYTES],
      [{ maxTraceBytes: 4096 }, 4096],
      [{ maxTraceBytes: 0 }, 1],
    ] as const) {
      const drawing = await client.observePrepared(artifact, {
        program, inputs: {}, attemptToken: `attempt-${sent.length}`,
        ...(traceOptions ? { traceOptions } : {}),
      });
      assert.equal(drawing.status, 'truncated', JSON.stringify(drawing));
      assert.equal(sent.at(-1)?.maxTraceBytes, expected, JSON.stringify(traceOptions));
    }
  } finally {
    client.terminate();
  }
});
