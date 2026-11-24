import assert from 'node:assert/strict';
import { expandPythonWarmGroups } from './python-warm-policy.mjs';

export const pythonFreshAaVersions = Object.freeze(['0.17.1-a', '0.17.1-b']);

export const pythonFreshAaPlan = Object.freeze(expandPythonWarmGroups(
  ['binary-search', 'permutations'].map((problem) => ({
    language: 'python', cpu: 1, problem, state: 'warm', journey: 'run', target: 20,
    versions: [...pythonFreshAaVersions], continuation: true,
  }))));

export function pythonFreshAaRoundOrder(versions, round) {
  assert.deepEqual(versions, pythonFreshAaVersions);
  assert.ok(Number.isSafeInteger(round) && round > 0);
  return round % 2 === 1 ? versions : [...versions].reverse();
}

export function withinFivePercent(left, right) {
  assert.ok(Number.isFinite(left) && left > 0 && Number.isFinite(right) && right > 0);
  return Math.max(left, right) / Math.min(left, right) <= 1.05;
}
