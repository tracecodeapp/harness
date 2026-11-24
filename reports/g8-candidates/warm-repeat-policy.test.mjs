import assert from 'node:assert/strict';
import test from 'node:test';
import { csharpWarmModes } from './csharp-warm-policy.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';
import { pairRepeatGroups, warmMetricName } from './warm-repeat-policy.mjs';

test('each repeat candidate gets its own 0.17.1 rotation', () => {
  const groups = pairRepeatGroups([{
    language: 'csharp', state: 'warm', journey: 'run',
    csharpWarmMode: csharpWarmModes.repeatRun,
    versions: ['0.17.1', 'candidate-main', 'candidate-deploy'],
  }], ['candidate-main', 'candidate-deploy']);
  assert.deepEqual(groups.map(({ versions, pairedControlFor }) => ({ versions, pairedControlFor })), [
    { versions: ['0.17.1', 'candidate-main'], pairedControlFor: 'candidate-main' },
    { versions: ['0.17.1', 'candidate-deploy'], pairedControlFor: 'candidate-deploy' },
  ]);
});

test('already paired and release repeat groups are not rewritten', () => {
  const paired = {
    language: 'python', state: 'warm', journey: 'run',
    pythonWarmMode: pythonWarmModes.repeatRun,
    versions: ['0.17.1', 'candidate-main'], pairedControlFor: 'candidate-main',
  };
  const release = { ...paired, versions: ['0.17.1', 'release-deploy'], pairedControlFor: undefined };
  assert.deepEqual(pairRepeatGroups([paired, release], ['candidate-main', 'candidate-deploy']), [paired, release]);
});

test('metric names dispatch by language', () => {
  assert.equal(warmMetricName({ language: 'python', pythonWarmMode: pythonWarmModes.repeatRun }, 'verdicts'),
    'repeatVerdicts');
  assert.equal(warmMetricName({ language: 'csharp', csharpWarmMode: csharpWarmModes.submitAfterRun },
    'submitVerdicts'), 'submitAfterRunVerdicts');
  assert.equal(warmMetricName({ language: 'java' }, 'verdicts'), 'verdicts');
});
