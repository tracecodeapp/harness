import assert from 'node:assert/strict';
import test from 'node:test';
import { csharpMeasurementPlan } from './csharp-measurement-plan.mjs';
import { measurementShapeKey } from './measurement-shapes.mjs';

function keys(scope) {
  return csharpMeasurementPlan(scope).flatMap((group) =>
    group.versions.map((version) => measurementShapeKey(scope, group, version)));
}

test('full S(C#) inventory has 100 exact unique combinations', () => {
  const inventory = ['desktop', 'phone', 'spot'].flatMap(keys);
  assert.equal(inventory.length, 100);
  assert.equal(new Set(inventory).size, 100);
  assert.equal(keys('desktop').length, 56);
  assert.equal(keys('phone').length, 24);
  assert.equal(keys('spot').length, 20);
});

test('fresh desktop Submit alone carries the formal 0.20.1 control', () => {
  const groups = csharpMeasurementPlan('desktop');
  const withSubmitControl = groups.filter(({ versions }) => versions.includes('0.20.1'));
  assert.equal(withSubmitControl.length, 2);
  assert.ok(withSubmitControl.every((group) =>
    group.language === 'csharp' && group.state === 'warm' && group.journey === 'submit' &&
      group.csharpWarmMode === 'fresh-page'));
  assert.ok(groups.filter(({ csharpWarmMode }) => csharpWarmMode === 'submit-after-run')
    .every(({ versions }) => !versions.includes('0.20.1')));
});

test('each repeat policy and every phone or spot policy has its own control', () => {
  for (const group of csharpMeasurementPlan('desktop').filter(({ csharpWarmMode }) =>
    ['repeat-run', 'submit-after-run'].includes(csharpWarmMode))) {
    assert.deepEqual(group.versions, ['0.17.1', group.pairedControlFor]);
  }
  for (const scope of ['phone', 'spot']) {
    for (const group of csharpMeasurementPlan(scope)) {
      assert.deepEqual(group.versions, ['0.17.1', group.pairedControlFor]);
    }
  }
});

test('C# Submit-after-Run is the fail-fast preflight group', () => {
  const first = csharpMeasurementPlan('desktop')[0];
  assert.equal(first.language, 'csharp');
  assert.equal(first.problem, 'binary-search');
  assert.equal(first.journey, 'submit');
  assert.equal(first.csharpWarmMode, 'submit-after-run');
});
