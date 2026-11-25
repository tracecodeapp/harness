import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finalReleaseCandidate,
  finalReleaseLanguages,
  finalReleasePlan,
  finalRuntimeLanguages,
} from './final-release-plan.mjs';
import { pythonExperimentPlan } from './python-experiment-plan.mjs';
import { isSubmitAfterRunWarmMode, warmMode } from './warm-repeat-policy.mjs';

test('final release covers both scopes for every runtime language', () => {
  for (const language of finalRuntimeLanguages) {
    const desktop = finalReleasePlan(language, 'desktop');
    const phone = finalReleasePlan(language, 'phone');
    assert.equal(desktop.some((group) => group.journey === 'lesson'), true);
    assert.deepEqual(new Set(desktop.map((group) => group.state)),
      new Set(['warm', 'cold', 'switched']));
    assert.deepEqual(new Set(phone.map((group) => group.state)), new Set(['warm', 'cold']));
    assert.ok([...desktop, ...phone].every((group) => group.target === 20));
  }
  assert.deepEqual(finalReleaseLanguages,
    ['javascript', 'typescript', 'python', 'cpp', 'java', 'csharp']);
  assert.equal(pythonExperimentPlan('final-phone').groups.length, 6);
  assert.equal(pythonExperimentPlan('final-desktop').groups.length, 6);
});

test('shipping Run and Submit policies are measured once per cell', () => {
  for (const language of finalRuntimeLanguages) {
    for (const scope of ['desktop', 'phone']) {
      for (const group of finalReleasePlan(language, scope)) {
        const candidate = finalReleaseCandidate(group);
        assert.equal(candidate, group.journey === 'submit' ? 'candidate-deploy' : 'candidate-main');
        assert.equal(group.versions.filter((version) => version.startsWith('candidate-')).length, 1);
        assert.equal(group.versions[0], '0.17.1');
      }
    }
  }
});

test('every final runtime cell uses only the live 0.17.1 comparator', () => {
  const all = finalRuntimeLanguages.flatMap((language) => ['desktop', 'phone']
    .flatMap((scope) => finalReleasePlan(language, scope)));
  assert.ok(all.every((group) => group.versions[0] === '0.17.1' &&
    !group.versions.includes('0.20.1')));
});

test('C# warm cells use fresh pages and explicit repeats', () => {
  for (const language of ['csharp']) {
    for (const scope of ['desktop', 'phone']) {
      const warm = finalReleasePlan(language, scope).filter((group) => group.state === 'warm');
      for (const problem of ['binary-search', 'permutations']) {
        const run = warm.filter((group) => group.problem === problem && group.journey === 'run');
        assert.deepEqual(new Set(run.map(warmMode)), new Set(['fresh-page', 'repeat-run']));
        if (scope === 'desktop') {
          const submit = warm.filter((group) => group.problem === problem && group.journey === 'submit');
          assert.deepEqual(new Set(submit.map(warmMode)),
            new Set(['fresh-page', 'submit-after-run']));
        }
      }
    }
  }
});

test('Submit-after-Run is first for fail-fast capture', () => {
  for (const language of ['csharp']) {
    const groups = finalReleasePlan(language, 'desktop');
    assert.equal(isSubmitAfterRunWarmMode(groups[0]), true);
    assert.equal(groups[0].problem, 'binary-search');
  }
});
