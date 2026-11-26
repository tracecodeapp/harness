import assert from 'node:assert/strict';

import { expandWarmRepeatGroups } from './warm-repeat-policy.mjs';

export const phoneWarmAaVersions = Object.freeze(['0.17.1-phone-a', '0.17.1-phone-b']);

const base = ['python', 'csharp'].flatMap((language) =>
  ['binary-search', 'permutations'].map((problem) => ({
    language,
    cpu: 4,
    problem,
    state: 'warm',
    journey: 'run',
    target: 20,
    versions: [...phoneWarmAaVersions],
    continuation: false,
  })));

const expanded = expandWarmRepeatGroups(base);

export const phoneWarmAaPlan = Object.freeze([
  ...expanded.filter(({ language, csharpWarmMode }) =>
    language === 'csharp' && csharpWarmMode === 'repeat-run'),
  ...expanded.filter(({ language, csharpWarmMode }) =>
    language !== 'csharp' || csharpWarmMode !== 'repeat-run'),
]);

export function phoneWarmAaRoundOrder(versions, round) {
  assert.deepEqual(versions, phoneWarmAaVersions);
  assert.ok(Number.isSafeInteger(round) && round > 0);
  return round % 2 === 1 ? versions : [...versions].reverse();
}

export function phoneWarmAaFailFast(group, sample) {
  assert.ok(['python', 'csharp'].includes(group.language));
  return Boolean(sample.invalid || sample.refusal);
}

export function phoneWarmAaSampleDisposition(sample) {
  assert.ok(!sample.invalid && !sample.refusal,
    sample.invalid ?? sample.refusal ?? 'A/A sample rejected');
  if (sample.excluded) {
    assert.equal(sample.kept, false, 'A load-excluded A/A sample cannot be kept');
    return 'excluded';
  }
  assert.equal(sample.kept, true);
  return 'kept';
}
