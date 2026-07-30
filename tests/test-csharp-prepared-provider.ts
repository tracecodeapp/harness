#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CodeExecutionResult,
  RuntimePreparedCodeCall,
  RuntimeProgramPreparationCall,
} from '../packages/runtime-core/src/index';
import { createCSharpRuntimeClient } from '../packages/runtime-csharp/src/csharp-runtime-client';
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
  assert.strictEqual(worker.executeCalls[0]?.call.signal, controller.signal);
  await prepared.program.dispose();
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
