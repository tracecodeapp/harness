import assert from 'node:assert/strict';
import test from 'node:test';
import { metricEndpoints, relative, sampleCounts, stats } from './aa-score-lib.mjs';

test('uses the frozen scorer median and nearest-rank p90 formulas', () => {
  assert.deepEqual(stats([10, 1, 4, 3, 2]), { n: 5, median: 3, p90: 10 });
  assert.deepEqual(stats([4, 1, 3, 2]), { n: 4, median: 2.5, p90: 4 });
});

test('reports directional percentage spreads', () => {
  const spread = relative(
    { n: 20, median: 150, p90: 90 },
    { n: 20, median: 100, p90: 100 },
  );
  assert.equal(spread.medianPct, 50);
  assert.ok(Math.abs(spread.p90Pct + 10) < Number.EPSILON * 10);
});

test('maps every baseline journey to its recorded metric names', () => {
  assert.deepEqual(metricEndpoints({ journey: 'run', continuation: true }),
    ['verdicts', 'firstTrace', 'secondTrace']);
  assert.deepEqual(metricEndpoints({ journey: 'run', continuation: false }),
    ['verdicts', 'firstTrace']);
  assert.deepEqual(metricEndpoints({ journey: 'submit' }), ['submitVerdicts']);
  assert.deepEqual(metricEndpoints({ journey: 'lesson' }), ['lessonContinue']);
});

test('counts attempts within one language and version only', () => {
  const samples = [
    { language: 'csharp', version: '0.17.1', kept: true },
    { language: 'csharp', version: '0.17.1', invalid: 'failed' },
    { language: 'csharp', version: '0.17.1', excluded: 'load' },
    { language: 'python', version: '0.17.1', kept: true },
    { language: 'csharp', version: 'release-deploy', kept: true },
  ];
  assert.deepEqual(sampleCounts(samples, 'csharp', '0.17.1'), {
    attempts: 3, kept: 1, invalid: 1, excluded: 1,
  });
});
