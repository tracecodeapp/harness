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
    language === 'csharp' && problem === 'permutations' && csharpWarmMode === 'repeat-run'),
  ...expandedPlan.filter(({ language, problem, csharpWarmMode }) =>
    language === 'python'),
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

function withinRatio(left, right, ratio) {
  assert.ok(Number.isFinite(left) && left > 0 && Number.isFinite(right) && right > 0);
  return Math.max(left, right) / Math.min(left, right) <= ratio;
}

// The A/A proof must be capable of resolving the production G8 gate. Medians
// therefore use the gate's 5% tolerance and p90s use its 10% tolerance. These
// checks apply to labels, pooled positions and each label's two positions.
export function withinAaMedianTolerance(left, right) {
  return withinRatio(left, right, 1.05);
}

export function withinAaP90Tolerance(left, right) {
  return withinRatio(left, right, 1.10);
}
