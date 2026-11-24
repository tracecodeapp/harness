import assert from 'node:assert/strict';
import test from 'node:test';
import { medianRegressionClass, scoreThresholds } from './score-thresholds.mjs';

test('seeded control derives identical unrounded thresholds for equivalent frozen cells', () => {
  const history = [
    { n: 12, median: 830.45, p90: 858.3 },
    { n: 12, median: 11_228.8, p90: 11_807.6 },
  ];
  const verdicts = scoreThresholds('desktop', history);
  const firstTrace = scoreThresholds('desktop', history);
  assert.deepEqual(verdicts, firstTrace);
  assert.deepEqual(verdicts, { median: 830.45, p90: 944.13 });
});

test('background speed classification opens fix-forward only above ten percent median', () => {
  assert.deepEqual(medianRegressionClass(105, 100),
    { classification: 'within-five-percent', ratio: 1.05 });
  assert.deepEqual(medianRegressionClass(110, 100),
    { classification: 'record', ratio: 1.1 });
  assert.equal(medianRegressionClass(110.01, 100).classification, 'fix-forward');
});
