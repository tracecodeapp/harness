import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pythonFreshAaPlan,
  pythonFreshAaRoundOrder,
  pythonFreshAaVersions,
  withinFivePercent,
} from './python-fresh-aa.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';

test('A/A proof contains fresh and repeat Run cells for both problems', () => {
  assert.deepEqual(pythonFreshAaPlan.map(({ problem, journey, pythonWarmMode, target, versions }) =>
    ({ problem, journey, pythonWarmMode, target, versions })), [
    { problem: 'binary-search', journey: 'run', pythonWarmMode: pythonWarmModes.fresh,
      target: 20, versions: pythonFreshAaVersions },
    { problem: 'binary-search', journey: 'run', pythonWarmMode: pythonWarmModes.repeatRun,
      target: 20, versions: pythonFreshAaVersions },
    { problem: 'permutations', journey: 'run', pythonWarmMode: pythonWarmModes.fresh,
      target: 20, versions: pythonFreshAaVersions },
    { problem: 'permutations', journey: 'run', pythonWarmMode: pythonWarmModes.repeatRun,
      target: 20, versions: pythonFreshAaVersions },
  ]);
});

test('A/A labels alternate first position every round', () => {
  assert.deepEqual(pythonFreshAaRoundOrder(pythonFreshAaVersions, 1), ['0.17.1-a', '0.17.1-b']);
  assert.deepEqual(pythonFreshAaRoundOrder(pythonFreshAaVersions, 2), ['0.17.1-b', '0.17.1-a']);
  assert.deepEqual(pythonFreshAaRoundOrder(pythonFreshAaVersions, 3), ['0.17.1-a', '0.17.1-b']);
});

test('A/A tolerance accepts exactly five percent and rejects more', () => {
  assert.equal(withinFivePercent(100, 105), true);
  assert.equal(withinFivePercent(105, 100), true);
  assert.equal(withinFivePercent(100, 105.01), false);
});
