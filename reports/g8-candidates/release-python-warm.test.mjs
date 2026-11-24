import assert from 'node:assert/strict';
import test from 'node:test';
import { liveRoundOrder } from './live-control.mjs';
import { releasePythonWarmPlan } from './release-python-warm.mjs';

test('selects every Python desktop warm endpoint and only adds 0.20.1 to Submit', () => {
  assert.equal(releasePythonWarmPlan.length, 4);
  assert.deepEqual(releasePythonWarmPlan.map(({ problem, journey, continuation, versions }) =>
    [problem, journey, continuation, versions]), [
    ['binary-search', 'run', true, ['0.17.1', 'release-deploy']],
    ['binary-search', 'submit', false, ['0.17.1', 'release-deploy', '0.20.1']],
    ['permutations', 'run', true, ['0.17.1', 'release-deploy']],
    ['permutations', 'submit', false, ['0.17.1', 'release-deploy', '0.20.1']],
  ]);
  assert.ok(releasePythonWarmPlan.every(({ target, state, cpu }) =>
    target === 20 && state === 'warm' && cpu === 1));
});

test('alternates release and controls within every round', () => {
  for (const group of releasePythonWarmPlan) {
    assert.equal(liveRoundOrder(group.versions, 1)[0], '0.17.1');
    assert.equal(liveRoundOrder(group.versions, 2).at(-1), '0.17.1');
  }
});
