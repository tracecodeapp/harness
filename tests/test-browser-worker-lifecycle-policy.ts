import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BROWSER_WORKER_LIFECYCLE_POLICIES,
  resolveBrowserWorkerLifecyclePolicy,
} from '../packages/runtime-browser/src/worker-lifecycle-policy';
import {
  createPromotableBrowserBackgroundTask,
} from '../packages/runtime-browser/src/background-work-scheduler';

test('Warm-and-Retire is the named default browser worker policy', () => {
  assert.deepEqual(BROWSER_WORKER_LIFECYCLE_POLICIES, [
    'warm-and-retire',
    'retire-only',
  ]);
  assert.deepEqual(resolveBrowserWorkerLifecyclePolicy(undefined), {
    workerLifecycle: 'warm-and-retire',
    prewarmAfterUse: true,
  });
});

test('named lifecycle policies resolve to their provider projection', () => {
  assert.deepEqual(
    resolveBrowserWorkerLifecyclePolicy({
      workerLifecycle: 'warm-and-retire',
    }),
    {
      workerLifecycle: 'warm-and-retire',
      prewarmAfterUse: true,
    }
  );
  assert.deepEqual(
    resolveBrowserWorkerLifecyclePolicy({
      workerLifecycle: 'retire-only',
    }),
    {
      workerLifecycle: 'retire-only',
      prewarmAfterUse: false,
    }
  );
});

test('the legacy prewarm boolean maps to one named policy', () => {
  assert.equal(
    resolveBrowserWorkerLifecyclePolicy({ prewarmAfterUse: true })
      .workerLifecycle,
    'warm-and-retire'
  );
  assert.equal(
    resolveBrowserWorkerLifecyclePolicy({ prewarmAfterUse: false })
      .workerLifecycle,
    'retire-only'
  );
});

test('conflicting or unknown lifecycle configuration fails closed', () => {
  assert.throws(
    () =>
      resolveBrowserWorkerLifecyclePolicy({
        workerLifecycle: 'warm-and-retire',
        prewarmAfterUse: false,
      }),
    /conflicts/
  );
  assert.throws(
    () =>
      resolveBrowserWorkerLifecyclePolicy({
        workerLifecycle: 'replace-in-place',
      } as never),
    /must be one of/
  );
  assert.throws(
    () =>
      resolveBrowserWorkerLifecyclePolicy({
        prewarmAfterUse: 'yes',
      } as never),
    /must be a boolean/
  );
});

test('browser background work stays idle until promoted and runs once', async () => {
  const originalRequestIdleCallback = globalThis.requestIdleCallback;
  const originalCancelIdleCallback = globalThis.cancelIdleCallback;
  let idleCallback: IdleRequestCallback | null = null;
  const cancelled: number[] = [];
  let runs = 0;
  globalThis.requestIdleCallback = (callback) => {
    idleCallback = callback;
    return 7;
  };
  globalThis.cancelIdleCallback = (handle) => {
    cancelled.push(handle);
  };
  try {
    const task = createPromotableBrowserBackgroundTask(async () => {
      runs += 1;
    });
    assert.equal(runs, 0);
    await task.promote();
    assert.deepEqual(cancelled, [7]);
    assert.equal(runs, 1);
    (idleCallback as unknown as IdleRequestCallback)({
      didTimeout: false,
      timeRemaining: () => 50,
    });
    await Promise.resolve();
    assert.equal(runs, 1);
  } finally {
    globalThis.requestIdleCallback = originalRequestIdleCallback;
    globalThis.cancelIdleCallback = originalCancelIdleCallback;
  }
});

test('cancelling browser background work prevents a queued start', async () => {
  const originalRequestIdleCallback = globalThis.requestIdleCallback;
  const originalCancelIdleCallback = globalThis.cancelIdleCallback;
  let idleCallback: IdleRequestCallback | null = null;
  let runs = 0;
  globalThis.requestIdleCallback = (callback) => {
    idleCallback = callback;
    return 9;
  };
  globalThis.cancelIdleCallback = () => undefined;
  try {
    const task = createPromotableBrowserBackgroundTask(async () => {
      runs += 1;
    });
    task.cancel();
    (idleCallback as unknown as IdleRequestCallback)({
      didTimeout: false,
      timeRemaining: () => 50,
    });
    await task.promote();
    assert.equal(runs, 0);
  } finally {
    globalThis.requestIdleCallback = originalRequestIdleCallback;
    globalThis.cancelIdleCallback = originalCancelIdleCallback;
  }
});
