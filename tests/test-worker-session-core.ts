import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as Effect from 'effect/Effect';
import { WorkerSessionCore } from '../packages/harness-browser/src/worker-session-core';
import { ExecutionAbortedError, WorkerTerminatedError } from '../packages/harness-browser/src/worker-errors';

function createCore(): WorkerSessionCore {
  return new WorkerSessionCore({
    runtimeLabel: 'Test',
    component: 'WorkerSessionCoreTest',
    runtime: 'test',
    debug: false,
    readyTimeoutMs: 100,
    defaultMessageTimeoutMs: 100,
    isSupported: () => false,
    createWorker: () => {
      throw new Error('The interruption classification test must not create a worker.');
    },
  });
}

test('internal fiber interruption is a worker lifecycle failure, not a caller abort', async () => {
  const core = createCore();
  await assert.rejects(
    core.runClientEffect(Effect.interrupt),
    (error: unknown) => error instanceof WorkerTerminatedError && error.name === 'WorkerTerminatedError'
  );
});

test('caller AbortSignal interruption retains the AbortError contract', async () => {
  const core = createCore();
  const controller = new AbortController();
  const execution = core.runClientEffect(Effect.never, controller.signal);
  controller.abort();
  await assert.rejects(
    execution,
    (error: unknown) => error instanceof ExecutionAbortedError && error.name === 'AbortError'
  );
});
