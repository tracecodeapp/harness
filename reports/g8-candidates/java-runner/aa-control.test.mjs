import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aaClosingControlPlan,
  aaClosingAllVersions,
  aaClosingVersions,
  aaControlPlan,
  aaVersions,
} from './aa-control.mjs';

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

test('closing control swaps release first and selects only the unresolved cells', () => {
  const plan = aaClosingControlPlan(fullPlan());
  assert.deepEqual(plan.map(({ language, problem, state, journey }) =>
    [language, problem, state, journey]), [
    ['python', 'binary-search', 'warm', 'submit'],
    ['python', 'permutations', 'warm', 'submit'],
    ['csharp', 'permutations', 'cold', 'run'],
    ['python', 'permutations', 'cold', 'run'],
  ]);
  for (const group of plan) assert.deepEqual(group.versions,
    group.language === 'python' && group.state === 'warm'
      ? aaClosingAllVersions : aaClosingVersions);
  assert.equal(plan.filter(({ versions }) => versions.includes('0.20.1')).length, 2);
  assert.deepEqual(aaClosingVersions, ['release-deploy', '0.17.1']);
  assert.deepEqual(aaClosingAllVersions, ['release-deploy', '0.17.1', '0.20.1']);
});

test('closing control rejects a missing unresolved cell', () => {
  const missing = fullPlan().filter((group) =>
    !(group.language === 'python' && group.problem === 'binary-search' &&
      group.state === 'warm' && group.journey === 'submit'));
  assert.throws(() => aaClosingControlPlan(missing), /Closing A\/A control/);
});
