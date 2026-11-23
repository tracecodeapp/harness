import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreThresholds } from './score-thresholds.mjs';

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
