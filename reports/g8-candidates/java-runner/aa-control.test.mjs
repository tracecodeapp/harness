import assert from 'node:assert/strict';
import test from 'node:test';
import { aaControlPlan, aaVersions } from './aa-control.mjs';

const problems = ['binary-search', 'permutations'];
const states = ['warm', 'cold', 'switched'];
const journeys = ['run', 'submit'];

function fullPlan() {
  return ['csharp', 'python'].flatMap((language) => problems.flatMap((problem) =>
    states.flatMap((state) => journeys.map((journey) => ({
    language,
    cpu: 1,
    problem,
    state,
    journey,
    target: 20,
    versions: ['release-deploy'],
    continuation: journey === 'run',
  })))));
}

test('selects the requested warm cells and cold Run controls only', () => {
  const plan = aaControlPlan(fullPlan());
  assert.deepEqual(plan.map(({ language, problem, state, journey }) => [language, problem, state, journey]), [
    ['csharp', 'binary-search', 'warm', 'run'],
    ['python', 'binary-search', 'warm', 'run'],
    ['csharp', 'permutations', 'warm', 'run'],
    ['python', 'permutations', 'warm', 'run'],
    ['csharp', 'binary-search', 'warm', 'submit'],
    ['python', 'binary-search', 'warm', 'submit'],
    ['csharp', 'permutations', 'warm', 'submit'],
    ['python', 'permutations', 'warm', 'submit'],
    ['csharp', 'binary-search', 'cold', 'run'],
    ['python', 'binary-search', 'cold', 'run'],
    ['csharp', 'permutations', 'cold', 'run'],
    ['python', 'permutations', 'cold', 'run'],
  ]);
});

test('interleaves the two pinned release policies within every group', () => {
  for (const group of aaControlPlan(fullPlan())) {
    assert.deepEqual(group.versions, aaVersions);
    assert.equal(group.target, 20);
    assert.equal(group.cpu, 1);
  }
});

test('rejects an incomplete source plan instead of silently dropping a control', () => {
  const missingCold = fullPlan().filter((group) =>
    !(group.language === 'python' && group.problem === 'permutations' &&
      group.state === 'cold' && group.journey === 'run'));
  assert.throws(() => aaControlPlan(missingCold), /six groups per language/);
});
