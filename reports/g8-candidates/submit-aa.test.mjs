import assert from 'node:assert/strict';
import test from 'node:test';
import { csharpWarmModes } from './csharp-warm-policy.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';
import {
  submitAaFailFast,
  submitAaLabelPairs,
  submitAaPlan,
  submitAaRoundOrder,
  submitAaSourceVersion,
  submitAaVersions,
} from './submit-aa.mjs';

test('Submit A/A covers fresh and Submit-after-Run with scoped 0.20.1 pairs', () => {
  assert.equal(submitAaPlan.length, 10);
  assert.deepEqual(submitAaPlan[0], {
    language: 'csharp', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'submit',
    target: 20, versions: submitAaLabelPairs['0.17.1'], continuation: false,
    csharpWarmMode: csharpWarmModes.submitAfterRun, submitAaSourceVersion: '0.17.1',
  });
  assert.equal(submitAaPlan.filter(({ language, pythonWarmMode, submitAaSourceVersion }) =>
    language === 'python' && pythonWarmMode === pythonWarmModes.fresh &&
    submitAaSourceVersion === '0.20.1').length, 2);
  assert.equal(submitAaPlan.some(({ language, submitAaSourceVersion }) =>
    language === 'csharp' && submitAaSourceVersion === '0.20.1'), false);
  assert.equal(submitAaPlan.filter(({ pythonWarmMode, csharpWarmMode }) =>
    pythonWarmMode === pythonWarmModes.submitAfterRun ||
    csharpWarmMode === csharpWarmModes.submitAfterRun).length, 4);
});

test('Submit A/A labels map to exact source versions and alternate by round', () => {
  assert.deepEqual(submitAaVersions,
    ['0.17.1-a', '0.17.1-b', '0.20.1-a', '0.20.1-b']);
  for (const [sourceVersion, labels] of Object.entries(submitAaLabelPairs)) {
    assert.ok(labels.every((label) => submitAaSourceVersion(label) === sourceVersion));
    assert.deepEqual(submitAaRoundOrder(labels, 1), labels);
    assert.deepEqual(submitAaRoundOrder(labels, 2), [...labels].reverse());
  }
  assert.throws(() => submitAaSourceVersion('release-deploy'), /Unknown Submit A\/A label/);
});

test('Submit A/A fails fast only on a rejected first-group attempt', () => {
  assert.equal(submitAaFailFast(0, { invalid: 'witness differs' }), true);
  assert.equal(submitAaFailFast(0, { refusal: 'refused' }), true);
  assert.equal(submitAaFailFast(0, { kept: true }), false);
  assert.equal(submitAaFailFast(1, { invalid: 'witness differs' }), false);
});
