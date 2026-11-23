import assert from 'node:assert/strict';

export const aaVersions = ['0.17.1', 'release-deploy'];
export const aaClosingVersions = ['release-deploy', '0.17.1'];
export const aaLanguages = ['csharp', 'python'];

export function aaControlPlan(groups) {
  const selected = groups.filter(({ cpu, state, journey }) =>
    cpu === 1 && (
      state === 'warm' && (journey === 'run' || journey === 'submit') ||
      state === 'cold' && journey === 'run'
    ));

  assert.equal(selected.length, aaLanguages.length * 6, 'A/A control must contain six groups per language');
  assert.deepEqual(new Set(selected.map(({ language }) => language)), new Set(aaLanguages));
  assert.deepEqual(new Set(selected.map(({ problem }) => problem)), new Set(['binary-search', 'permutations']));
  for (const language of aaLanguages) {
    assert.equal(selected.filter((group) => group.language === language).length, 6,
      `A/A control must contain six ${language} groups`);
  }

  return selected
    .map((group) => ({ ...group, versions: [...aaVersions] }))
    .sort((a, b) => {
      const stateOrder = { warm: 0, cold: 1 };
      const journeyOrder = { run: 0, submit: 1 };
      return stateOrder[a.state] - stateOrder[b.state] ||
        journeyOrder[a.journey] - journeyOrder[b.journey] ||
        a.problem.localeCompare(b.problem) ||
        a.language.localeCompare(b.language);
    });
}

export function aaClosingControlPlan(groups) {
  const selected = groups.filter(({ language, cpu, problem, state, journey }) =>
    cpu === 1 && (
      language === 'python' && state === 'warm' && journey === 'submit' ||
      ['csharp', 'python'].includes(language) && problem === 'permutations' &&
        state === 'cold' && journey === 'run'
    ));

  assert.equal(selected.length, 4,
    'Closing A/A control must contain two Python Submit and two cold Permutations groups');
  assert.equal(selected.filter(({ language }) => language === 'python').length, 3);
  assert.equal(selected.filter(({ language }) => language === 'csharp').length, 1);

  return selected
    .map((group) => ({ ...group, versions: [...aaClosingVersions] }))
    .sort((a, b) => {
      const stateOrder = { warm: 0, cold: 1 };
      return stateOrder[a.state] - stateOrder[b.state] ||
        a.problem.localeCompare(b.problem) || a.language.localeCompare(b.language);
    });
}
