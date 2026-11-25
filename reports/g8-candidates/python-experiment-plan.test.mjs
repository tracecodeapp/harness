import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pythonExperimentPlan,
  pythonExperimentShapeInventory,
  pythonExperimentWitnessVersion,
} from './python-experiment-plan.mjs';
import { capturedShapeKeys } from './shape-captures.mjs';

test('E1 is the pre-registered phone fresh-page attribution cell', () => {
  const plan = pythonExperimentPlan('e1');
  assert.equal(plan.scope, 'phone');
  assert.equal(plan.collectReceiptSnapshotMs, true);
  assert.deepEqual(plan.candidates, ['concurrent-e1']);
  assert.deepEqual(plan.groups.map(({ problem, state, pythonWarmMode, target, versions }) =>
    ({ problem, state, pythonWarmMode, target, versions })), [{
    problem: 'permutations',
    state: 'warm',
    pythonWarmMode: 'fresh-page',
    target: 10,
    versions: ['0.17.1', 'concurrent-e1'],
  }]);
});

test('E2 compares base, F1 and F1 plus D1 sequential policies on four phone cells', () => {
  const plan = pythonExperimentPlan('e2');
  assert.equal(plan.scope, 'phone');
  assert.deepEqual(plan.candidates, ['sequential', 'sequential-f1', 'sequential-f1-d1']);
  assert.deepEqual(plan.groups.map(({ problem, state, pythonWarmMode = 'standard', target }) =>
    [problem, state, pythonWarmMode, target]), [
    ['permutations', 'warm', 'repeat-run', 20],
    ['permutations', 'warm', 'fresh-page', 20],
    ['permutations', 'cold', 'standard', 20],
    ['binary-search', 'warm', 'fresh-page', 20],
  ]);
  assert.ok(plan.groups.every((entry) =>
    entry.versions.join(',') === '0.17.1,sequential,sequential-f1,sequential-f1-d1'));
});

test('E-D1 compares concurrent base with F1 plus D1 on desktop repeat cells', () => {
  const plan = pythonExperimentPlan('ed1');
  assert.equal(plan.scope, 'desktop');
  assert.deepEqual(plan.candidates, ['concurrent-base', 'concurrent-f1-d1']);
  assert.deepEqual(plan.groups.map(({ problem, cpu, state, pythonWarmMode, target }) =>
    [problem, cpu, state, pythonWarmMode, target]), [
    ['binary-search', 1, 'warm', 'repeat-run', 10],
    ['permutations', 1, 'warm', 'repeat-run', 10],
  ]);
  assert.ok(plan.groups.every((entry) => entry.continuation));
});

test('S-prime confirmation pins the ruled phone and desktop matrices', () => {
  const phone = pythonExperimentPlan('sprime-phone');
  assert.equal(phone.scope, 'phone');
  assert.deepEqual(phone.candidates, ['sprime']);
  assert.deepEqual(phone.groups.map(({ problem, state, pythonWarmMode = 'standard', target }) =>
    [problem, state, pythonWarmMode, target]), [
    ['permutations', 'warm', 'fresh-page', 20],
    ['permutations', 'cold', 'standard', 20],
    ['permutations', 'warm', 'repeat-run', 20],
    ['binary-search', 'warm', 'fresh-page', 20],
    ['binary-search', 'cold', 'standard', 20],
    ['binary-search', 'warm', 'repeat-run', 20],
  ]);
  assert.ok(phone.groups.every(({ cpu, versions }) =>
    cpu === 4 && versions.join(',') === '0.17.1,sprime'));

  const desktop = pythonExperimentPlan('sprime-desktop');
  assert.equal(desktop.scope, 'desktop');
  assert.deepEqual(desktop.candidates, ['sprime']);
  assert.deepEqual(desktop.groups.map(({ problem, state, journey, continuation,
    pythonWarmMode = 'standard', target }) =>
    [problem, state, journey, continuation, pythonWarmMode, target]), [
    ['binary-search', 'warm', 'run', false, 'fresh-page', 20],
    ['permutations', 'warm', 'run', false, 'fresh-page', 20],
    ['binary-search', 'cold', 'run', false, 'standard', 20],
    ['binary-search', 'warm', 'run', true, 'repeat-run', 20],
    ['permutations', 'warm', 'run', true, 'repeat-run', 20],
    ['binary-search', 'warm', 'lesson', false, 'standard', 20],
  ]);
  assert.ok(desktop.groups.every(({ cpu, versions }) =>
    cpu === 1 && versions.join(',') === '0.17.1,sprime'));
});

test('historical experiment labels use captured witnesses without hiding new shapes', () => {
  for (const name of ['e1', 'e2', 'ed1']) {
    const inventory = pythonExperimentShapeInventory(
      pythonExperimentPlan(name), capturedShapeKeys);
    assert.ok(inventory.length > 0);
    assert.ok(inventory.every((entry) => entry.captured),
      JSON.stringify(inventory.filter((entry) => !entry.captured), null, 2));
  }
  assert.equal(pythonExperimentWitnessVersion(
    pythonExperimentPlan('e1'), 'concurrent-e1'), 'concurrent');
  assert.equal(pythonExperimentWitnessVersion(
    pythonExperimentPlan('e2'), 'sequential-f1'), 'sequential');
  assert.equal(pythonExperimentWitnessVersion(
    pythonExperimentPlan('e2'), 'sequential-f1-d1'), 'sequential');
  assert.equal(pythonExperimentWitnessVersion(
    pythonExperimentPlan('ed1'), 'concurrent-f1-d1'), 'concurrent');
  assert.equal(pythonExperimentWitnessVersion(
    pythonExperimentPlan('sprime-phone'), 'sprime'), 'sequential');
  assert.equal(pythonExperimentWitnessVersion(
    pythonExperimentPlan('sprime-desktop'), 'sprime'), 'sequential');
});

test('unknown experiment names fail before a browser can launch', () => {
  assert.throws(() => pythonExperimentPlan('e3'), /Unknown Python speed experiment/);
});
