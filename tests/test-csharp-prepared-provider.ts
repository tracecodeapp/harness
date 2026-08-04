#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type {
  CodeExecutionResult,
  RuntimePreparedCodeCall,
  RuntimeProgramPreparationCall,
} from '../packages/runtime-contracts/src/index';
import {
  createCSharpRuntimeClient,
  type CSharpPreparedWorkerAuthority,
} from '../packages/runtime-csharp/src/csharp-runtime-client';
import type {
  CSharpPreparedProgramArtifact,
  CSharpWorkerClient,
  CSharpWorkerPrepareResult,
} from '../packages/runtime-csharp/src/csharp-worker-client';

class FakePreparedCSharpWorker {
  prepareCalls: RuntimeProgramPreparationCall[] = [];
  executeCalls: Array<{
    prepared: CSharpPreparedProgramArtifact;
    call: RuntimePreparedCodeCall;
  }> = [];
  disposeCalls: string[] = [];
  failPreparation = false;
  executionResult: CodeExecutionResult | undefined;
  terminated = false;

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return { success: true, loadTimeMs: 2 };
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<CSharpWorkerPrepareResult> {
    this.prepareCalls.push(call);
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
      timings: { compileMs: 0, compileCacheHit: true, artifactCacheHit: true },
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
  const authority: CSharpPreparedWorkerAuthority = {
    compiler: compiler as unknown as CSharpWorkerClient,
    batchConcurrency: 2,
    createRunner() {
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
    inputBatch: [{ value: 1 }, { value: 2 }],
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
    /finally\s*\{\s*\/\/ This is the lifecycle boundary[\s\S]*?JudgeRuntimeContext\.Reset\(\);\s*Console\.SetOut\(originalOut\);/,
    'prepared inputs and trace state must reset even when execution fails before assembly loading'
  );
});
