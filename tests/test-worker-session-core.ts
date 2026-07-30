import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as Effect from 'effect/Effect';
import { WorkerSessionCore } from '../packages/runtime-browser/src/worker-session-core';
import { ExecutionAbortedError, WorkerTerminatedError } from '../packages/runtime-browser/src/worker-errors';
import type {
  RuntimeProjectEngineLeaseAttachment,
  RuntimeProjectEngineLeaseController,
} from '../packages/runtime-contracts/src/runtime-project';

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

test('reusable worker leases serialize until kernel release and destroy through the session scope', async () => {
  let terminateCount = 0;
  const core = new WorkerSessionCore({
    runtimeLabel: 'Test',
    component: 'WorkerSessionCoreTest',
    runtime: 'test',
    debug: false,
    readyTimeoutMs: 100,
    defaultMessageTimeoutMs: 100,
    isSupported: () => true,
    createWorker: () => {
      const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        postMessage() {},
        terminate() {
          terminateCount += 1;
        },
      };
      queueMicrotask(() => {
        worker.onmessage?.({
          data: { type: 'worker-ready' },
        } as MessageEvent);
      });
      return worker;
    },
  });
  const session = core.getOrCreateSession();
  await session.ready.promise;

  let firstAttachment: RuntimeProjectEngineLeaseAttachment | undefined;
  let secondAttachment: RuntimeProjectEngineLeaseAttachment | undefined;
  const firstController: RuntimeProjectEngineLeaseController = {
    attach(attachment) {
      firstAttachment = attachment;
    },
  };
  const secondController: RuntimeProjectEngineLeaseController = {
    attach(attachment) {
      secondAttachment = attachment;
    },
  };

  await core.acquireReusableEngineLease(firstController);
  let secondAcquired = false;
  const secondAcquire = core.acquireReusableEngineLease(secondController).then(() => {
    secondAcquired = true;
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false, 'a second PID must wait for the prior kernel lease release');

  await firstAttachment?.revalidate?.();
  await firstAttachment?.release({ kind: 'reuse', reason: 'revalidated' });
  await secondAcquire;
  assert.equal(secondAcquired, true);
  assert.equal(terminateCount, 0, 'a revalidated lease should retain the same worker generation');

  await secondAttachment?.revalidate?.();
  await secondAttachment?.release({ kind: 'destroy', reason: 'signaled', message: 'SIGTERM' });
  assert.equal(terminateCount, 1, 'a destroy disposition must close the real worker session');
  assert.equal(core.isWorkerRunning, false);
});
