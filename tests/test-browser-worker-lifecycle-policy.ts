import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BROWSER_WORKER_LIFECYCLE_POLICIES,
  resolveBrowserWorkerLifecyclePolicy,
} from '../packages/runtime-browser/src/worker-lifecycle-policy';

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
