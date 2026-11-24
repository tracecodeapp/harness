import assert from 'node:assert/strict';
import test from 'node:test';
import { csharpWarmModes } from './csharp-warm-policy.mjs';
import { javaClosingPlan } from './java-closing.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';

test('Java closing records the missing lesson reference and only the ruled reruns', () => {
  assert.equal(javaClosingPlan.length, 7);
  assert.deepEqual(javaClosingPlan[0], {
    language: 'java', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'lesson',
    target: 20, versions: ['0.17.1'], continuation: false,
  });
  const pairs = javaClosingPlan.slice(1);
  assert.deepEqual(pairs.map(({ language, cpu, pairedControlFor }) =>
    [language, cpu, pairedControlFor]), [
    ['java', 4, 'candidate-main'],
    ['csharp', 1, 'candidate-main'],
    ['csharp', 1, 'candidate-deploy'],
    ['python', 1, 'candidate-main'],
    ['python', 1, 'candidate-deploy'],
    ['cpp', 1, 'candidate-deploy'],
  ]);
  assert.ok(pairs.every(({ versions, pairedControlFor }) =>
    versions[0] === '0.17.1' && versions[1] === pairedControlFor));
});

test('penalty-bearing spot languages use an independent fresh page per attempt', () => {
  const csharp = javaClosingPlan.filter(({ language }) => language === 'csharp');
  const python = javaClosingPlan.filter(({ language }) => language === 'python');
  assert.ok(csharp.every(({ csharpWarmMode }) => csharpWarmMode === csharpWarmModes.fresh));
  assert.ok(python.every(({ pythonWarmMode }) => pythonWarmMode === pythonWarmModes.fresh));
});
