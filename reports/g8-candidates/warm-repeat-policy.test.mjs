import assert from 'node:assert/strict';
import test from 'node:test';
import { csharpWarmModes } from './csharp-warm-policy.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';
import {
  isSubmitAfterRunWarmMode,
  pairRepeatGroups,
  prioritizeSubmitAfterRunPreflights,
  submitAfterRunPreflightAction,
  warmMetricName,
} from './warm-repeat-policy.mjs';

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

test('puts one uncaptured Submit-after-Run shape per language first', () => {
  const groups = [
    { language: 'python', problem: 'binary-search', pythonWarmMode: 'fresh-page' },
    { language: 'csharp', problem: 'binary-search', csharpWarmMode: 'submit-after-run' },
    { language: 'python', problem: 'permutations', pythonWarmMode: 'submit-after-run' },
    { language: 'python', problem: 'binary-search', pythonWarmMode: 'submit-after-run' },
  ];
  const ordered = prioritizeSubmitAfterRunPreflights(groups, ['python', 'csharp']);
  assert.equal(ordered[0], groups[3]);
  assert.equal(ordered[1], groups[1]);
  assert.equal(isSubmitAfterRunWarmMode(ordered[0]), true);
  assert.equal(isSubmitAfterRunWarmMode(ordered[2]), false);
  assert.deepEqual(new Set(ordered), new Set(groups));
});

test('fails fast until each language has one kept Submit-after-Run attempt', () => {
  const captured = new Set();
  const group = { language: 'python', pythonWarmMode: pythonWarmModes.submitAfterRun };
  assert.equal(submitAfterRunPreflightAction(captured, group, { excluded: 'load' }), 'wait');
  assert.equal(submitAfterRunPreflightAction(captured, group, { invalid: 'witness' }), 'reject');
  assert.equal(submitAfterRunPreflightAction(captured, group, { kept: true }), 'capture');
  captured.add('python');
  assert.equal(submitAfterRunPreflightAction(captured, group, { invalid: 'later' }), 'none');
});
