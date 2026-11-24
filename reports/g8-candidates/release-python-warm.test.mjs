import assert from 'node:assert/strict';
import test from 'node:test';
import { liveRoundOrder } from './live-control.mjs';
import { releasePythonWarmPlan } from './release-python-warm.mjs';
import { expandWarmRepeatGroups, isRepeatWarmMode } from './warm-repeat-policy.mjs';

test('selects every Python and C# desktop warm endpoint and scopes 0.20.1 to Python Submit', () => {
  assert.equal(releasePythonWarmPlan.length, 8);
  assert.deepEqual(releasePythonWarmPlan.map(({ language, problem, journey, continuation, versions }) =>
    [language, problem, journey, continuation, versions]), [
    ['python', 'binary-search', 'run', true, ['0.17.1', 'release-deploy']],
    ['python', 'binary-search', 'submit', false, ['0.17.1', 'release-deploy', '0.20.1']],
    ['python', 'permutations', 'run', true, ['0.17.1', 'release-deploy']],
    ['python', 'permutations', 'submit', false, ['0.17.1', 'release-deploy', '0.20.1']],
    ['csharp', 'binary-search', 'run', true, ['0.17.1', 'release-deploy']],
    ['csharp', 'binary-search', 'submit', false, ['0.17.1', 'release-deploy']],
    ['csharp', 'permutations', 'run', true, ['0.17.1', 'release-deploy']],
    ['csharp', 'permutations', 'submit', false, ['0.17.1', 'release-deploy']],
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

test('fixed-design release plan gives both languages fresh and explicit repeat cells', () => {
  const expanded = expandWarmRepeatGroups(releasePythonWarmPlan, { submitAfterRun: true });
  assert.equal(expanded.length, 16);
  for (const language of ['python', 'csharp']) {
    const languageGroups = expanded.filter((group) => group.language === language);
    assert.equal(languageGroups.length, 8);
    assert.equal(languageGroups.filter(isRepeatWarmMode).length, 4);
    assert.equal(languageGroups.filter((group) => !isRepeatWarmMode(group)).length, 4);
    assert.ok(languageGroups.filter(isRepeatWarmMode).every(({ versions }) =>
      !versions.includes('0.20.1')));
  }
});
