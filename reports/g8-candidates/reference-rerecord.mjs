import assert from 'node:assert/strict';

export const referenceRerecordDate = '2026-11-24';

export const referenceRerecordPlan = [
  { language: 'python', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'submit',
    target: 20, versions: ['0.17.1', '0.20.1'], continuation: false },
  { language: 'python', cpu: 1, problem: 'permutations', state: 'warm', journey: 'submit',
    target: 20, versions: ['0.17.1', '0.20.1'], continuation: false },
  { language: 'java', cpu: 1, problem: 'permutations', state: 'warm', journey: 'submit',
    target: 20, versions: ['0.17.1'], continuation: false },
];

export const referenceRerecordReasons = {
  'python/1/binary-search/warm/submitVerdicts':
    'The frozen Python warm Submit cell is bimodal and position-dependent.',
  'python/1/permutations/warm/submitVerdicts':
    'The frozen Python warm Submit cell is bimodal and position-dependent.',
  'java/1/permutations/warm/submitVerdicts':
    'Same-window 0.17.1 p90 drifted -15.9% from the frozen reference on 2026-11-24.',
};

export function referenceRoundOrder(versions, round) {
  assert.ok(Number.isSafeInteger(round) && round > 0);
  assert.ok(versions.length === 1 || versions.length === 2);
  return round % 2 === 1 ? [...versions] : [...versions].reverse();
}
