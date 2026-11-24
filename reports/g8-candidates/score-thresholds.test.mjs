import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedLiveControlMetadata,
  medianRegressionClass,
  scoreThresholds,
} from './score-thresholds.mjs';

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

test('Python 0.20.1 Submit control is desktop-only', () => {
  const versions = ['concurrent', 'sequential'];
  assert.deepEqual(expectedLiveControlMetadata('python', 'phone', versions), {
    control: '0.17.1',
    candidateVersions: versions,
    alternatingOrderPerRound: true,
  });
  assert.equal(expectedLiveControlMetadata('python', 'desktop', versions)
    .pythonWarmSubmitControl, '0.20.1');
  assert.equal(expectedLiveControlMetadata('python', 'spot', versions)
    .pythonWarmSubmitControl, undefined);
});
