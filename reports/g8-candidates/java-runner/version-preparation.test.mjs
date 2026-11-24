import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExactHistoricalPackage,
  candidatePreparationSourceVersion,
  historicalPackageSha256,
} from './version-preparation.mjs';

test('aliases only candidate-deploy to candidate-main', () => {
  assert.equal(candidatePreparationSourceVersion('candidate-main', true), 'candidate-main');
  assert.equal(candidatePreparationSourceVersion('candidate-deploy', true), 'candidate-main');
  assert.equal(candidatePreparationSourceVersion('0.17.1', true), '0.17.1');
  assert.equal(candidatePreparationSourceVersion('0.20.1', true), '0.20.1');
  assert.equal(candidatePreparationSourceVersion('candidate-deploy', false), 'candidate-deploy');
});

test('rejects a candidate package substituted for either historical control', () => {
  const candidate = { sha256: 'df77f21302e861cdfcdd3d7ebb970cbc79639fc49a6a4d8772a72d6178b8d9a7' };
  assert.throws(() => assertExactHistoricalPackage('0.17.1', candidate),
    /pinned release bytes/);
  assert.throws(() => assertExactHistoricalPackage('0.20.1', candidate),
    /pinned release bytes/);
  assert.doesNotThrow(() => assertExactHistoricalPackage('0.17.1', {
    sha256: historicalPackageSha256['0.17.1'],
  }));
  assert.doesNotThrow(() => assertExactHistoricalPackage('0.20.1', {
    sha256: historicalPackageSha256['0.20.1'],
  }));
  assert.doesNotThrow(() => assertExactHistoricalPackage('candidate-main', candidate));
});
