import assert from 'node:assert/strict';
import test from 'node:test';
import {
  referenceRerecordPlan,
  referenceRerecordReasons,
  referenceRoundOrder,
} from './reference-rerecord.mjs';

test('selects only the five authorized host-check streams', () => {
  assert.deepEqual(referenceRerecordPlan.map(({ language, problem, versions }) =>
    [language, problem, versions]), [
    ['python', 'binary-search', ['0.17.1', '0.20.1']],
    ['python', 'permutations', ['0.17.1', '0.20.1']],
    ['java', 'permutations', ['0.17.1']],
  ]);
  assert.ok(referenceRerecordPlan.every(({ target, state, journey }) =>
    target === 20 && state === 'warm' && journey === 'submit'));
  assert.deepEqual(Object.keys(referenceRerecordReasons).sort(), [
    'java/1/permutations/warm/submitVerdicts',
    'python/1/binary-search/warm/submitVerdicts',
    'python/1/permutations/warm/submitVerdicts',
  ]);
});

test('alternates published controls inside each Python round', () => {
  assert.deepEqual(referenceRoundOrder(['0.17.1', '0.20.1'], 1), ['0.17.1', '0.20.1']);
  assert.deepEqual(referenceRoundOrder(['0.17.1', '0.20.1'], 2), ['0.20.1', '0.17.1']);
  assert.deepEqual(referenceRoundOrder(['0.17.1'], 2), ['0.17.1']);
});
