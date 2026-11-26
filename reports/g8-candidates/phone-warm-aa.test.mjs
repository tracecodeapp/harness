import assert from 'node:assert/strict';
import test from 'node:test';

import {
  phoneWarmAaFailFast,
  phoneWarmAaPlan,
  phoneWarmAaRoundOrder,
  phoneWarmAaVersions,
} from './phone-warm-aa.mjs';

test('phone A/A covers fresh and repeat Run for both languages and problems', () => {
  assert.equal(phoneWarmAaPlan.length, 8);
  assert.deepEqual(new Set(phoneWarmAaPlan.map(({ language }) => language)),
    new Set(['python', 'csharp']));
  assert.deepEqual(new Set(phoneWarmAaPlan.map(({ problem }) => problem)),
    new Set(['binary-search', 'permutations']));
  assert.ok(phoneWarmAaPlan.every(({ cpu, state, journey, target, versions, continuation }) =>
    cpu === 4 && state === 'warm' && journey === 'run' && target === 20 &&
    !continuation && JSON.stringify(versions) === JSON.stringify(phoneWarmAaVersions)));
  for (const language of ['python', 'csharp']) {
    for (const problem of ['binary-search', 'permutations']) {
      const rows = phoneWarmAaPlan.filter((group) =>
        group.language === language && group.problem === problem);
      assert.equal(rows.length, 2);
      assert.equal(rows.filter((group) =>
        (group.pythonWarmMode ?? group.csharpWarmMode) === 'fresh-page').length, 1);
      assert.equal(rows.filter((group) =>
        (group.pythonWarmMode ?? group.csharpWarmMode) === 'repeat-run').length, 1);
    }
  }
});

test('phone A/A alternates labels and fails fast on any invalid attempt', () => {
  assert.deepEqual(phoneWarmAaRoundOrder(phoneWarmAaVersions, 1), phoneWarmAaVersions);
  assert.deepEqual(phoneWarmAaRoundOrder(phoneWarmAaVersions, 2),
    [...phoneWarmAaVersions].reverse());
  assert.equal(phoneWarmAaFailFast(phoneWarmAaPlan[0], { kept: true }), false);
  assert.equal(phoneWarmAaFailFast(phoneWarmAaPlan[7], { invalid: 'witness differs' }), true);
});
