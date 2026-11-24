import assert from 'node:assert/strict';
import { expandWarmRepeatGroups } from './warm-repeat-policy.mjs';

export const pythonFreshAaVersions = Object.freeze(['0.17.1-a', '0.17.1-b']);

const expandedPlan = expandWarmRepeatGroups(
  ['python', 'csharp'].flatMap((language) =>
    ['binary-search', 'permutations'].map((problem) => ({
      language, cpu: 1, problem, state: 'warm', journey: 'run', target: 20,
      versions: [...pythonFreshAaVersions], continuation: true,
    }))),
);

export const pythonFreshAaPlan = Object.freeze([
  ...expandedPlan.filter(({ language, problem, csharpWarmMode }) =>
    language === 'csharp' && problem === 'binary-search' && csharpWarmMode === 'repeat-run'),
  ...expandedPlan.filter(({ language, problem, csharpWarmMode }) =>
    !(language === 'csharp' && problem === 'binary-search' && csharpWarmMode === 'repeat-run')),
]);

export function pythonFreshAaFailFast(groupIndex, group, sample) {
  return groupIndex === 0 && group.language === 'csharp' &&
    group.csharpWarmMode === 'repeat-run' && Boolean(sample.invalid || sample.refusal);
}

export function pythonFreshAaRoundOrder(versions, round) {
  assert.deepEqual(versions, pythonFreshAaVersions);
  assert.ok(Number.isSafeInteger(round) && round > 0);
  return round % 2 === 1 ? versions : [...versions].reverse();
}

export function withinFivePercent(left, right) {
  assert.ok(Number.isFinite(left) && left > 0 && Number.isFinite(right) && right > 0);
  return Math.max(left, right) / Math.min(left, right) <= 1.05;
}
