import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pythonFreshAaPlan,
  pythonFreshAaFailFast,
  pythonFreshAaRoundOrder,
  pythonFreshAaVersions,
  withinAaMedianTolerance,
  withinAaP90Tolerance,
} from './python-fresh-aa.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';
import { csharpWarmModes } from './csharp-warm-policy.mjs';

test('A/A proof contains fresh and repeat Run cells for both languages and problems', () => {
  assert.deepEqual(pythonFreshAaPlan.map(({ language, problem, journey, pythonWarmMode,
    csharpWarmMode, target, versions }) =>
    ({ language, problem, journey, mode: pythonWarmMode ?? csharpWarmMode, target, versions })), [
    { language: 'csharp', problem: 'binary-search', journey: 'run', mode: csharpWarmModes.repeatRun,
      target: 20, versions: pythonFreshAaVersions },
    { language: 'python', problem: 'binary-search', journey: 'run', mode: pythonWarmModes.fresh,
      target: 20, versions: pythonFreshAaVersions },
    { language: 'python', problem: 'binary-search', journey: 'run', mode: pythonWarmModes.repeatRun,
      target: 20, versions: pythonFreshAaVersions },
    { language: 'python', problem: 'permutations', journey: 'run', mode: pythonWarmModes.fresh,
      target: 20, versions: pythonFreshAaVersions },
    { language: 'python', problem: 'permutations', journey: 'run', mode: pythonWarmModes.repeatRun,
      target: 20, versions: pythonFreshAaVersions },
    { language: 'csharp', problem: 'binary-search', journey: 'run', mode: csharpWarmModes.fresh,
      target: 20, versions: pythonFreshAaVersions },
    { language: 'csharp', problem: 'permutations', journey: 'run', mode: csharpWarmModes.fresh,
      target: 20, versions: pythonFreshAaVersions },
    { language: 'csharp', problem: 'permutations', journey: 'run', mode: csharpWarmModes.repeatRun,
      target: 20, versions: pythonFreshAaVersions },
  ]);
});

test('fails fast only when the first uncaptured C# repeat attempt is rejected', () => {
  const first = pythonFreshAaPlan[0];
  assert.equal(pythonFreshAaFailFast(0, first, { invalid: 'witness differs' }), true);
  assert.equal(pythonFreshAaFailFast(0, first, { refusal: 'refused' }), true);
  assert.equal(pythonFreshAaFailFast(0, first, { kept: true }), false);
  assert.equal(pythonFreshAaFailFast(1, first, { invalid: 'witness differs' }), false);
  assert.equal(pythonFreshAaFailFast(0, pythonFreshAaPlan[1], { invalid: 'witness differs' }), false);
});

test('A/A labels alternate first position every round', () => {
  assert.deepEqual(pythonFreshAaRoundOrder(pythonFreshAaVersions, 1), ['0.17.1-a', '0.17.1-b']);
  assert.deepEqual(pythonFreshAaRoundOrder(pythonFreshAaVersions, 2), ['0.17.1-b', '0.17.1-a']);
  assert.deepEqual(pythonFreshAaRoundOrder(pythonFreshAaVersions, 3), ['0.17.1-a', '0.17.1-b']);
});

test('A/A criterion pre-registers five percent median and ten percent p90 tolerances', () => {
  assert.equal(withinAaMedianTolerance(100, 105), true);
  assert.equal(withinAaMedianTolerance(105, 100), true);
  assert.equal(withinAaMedianTolerance(100, 105.01), false);
  assert.equal(withinAaP90Tolerance(100, 110), true);
  assert.equal(withinAaP90Tolerance(110, 100), true);
  assert.equal(withinAaP90Tolerance(100, 110.01), false);
});
