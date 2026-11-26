import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateWitnessRequired,
  shouldValidateCandidateWitness,
} from './candidate-witness-policy.mjs';

test('candidate witnesses are restricted to languages with a defined witness', () => {
  for (const language of ['java', 'csharp', 'python']) {
    assert.equal(candidateWitnessRequired(language), true, language);
    assert.equal(shouldValidateCandidateWitness('candidate-main', language, language), true,
      language);
    assert.equal(shouldValidateCandidateWitness('candidate-deploy', language, language), true,
      language);
  }

  for (const language of ['javascript', 'typescript', 'cpp']) {
    assert.equal(candidateWitnessRequired(language), false, language);
    assert.equal(shouldValidateCandidateWitness('candidate-main', language, language), false,
      language);
    assert.equal(shouldValidateCandidateWitness('candidate-deploy', language, language), false,
      language);
  }
});

test('controls and non-matching language groups never use a candidate witness', () => {
  assert.equal(shouldValidateCandidateWitness('0.17.1', 'python', 'python'), false);
  assert.equal(shouldValidateCandidateWitness('candidate-main', 'python', 'java'), false);
});
