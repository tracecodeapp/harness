import assert from 'node:assert/strict';
import test from 'node:test';
import {
  liveCellScore,
  liveControlVersions,
  liveRoundOrder,
} from './live-control.mjs';

test('alternates the production control from first to last every round', () => {
  const versions = liveControlVersions(['candidate-main', 'candidate-deploy']);
  assert.deepEqual(versions, ['0.17.1', 'candidate-main', 'candidate-deploy']);
  assert.deepEqual(liveRoundOrder(versions, 1),
    ['0.17.1', 'candidate-main', 'candidate-deploy']);
  assert.deepEqual(liveRoundOrder(versions, 2),
    ['candidate-deploy', 'candidate-main', '0.17.1']);
});

test('scores candidate against same-window control at five and ten percent', () => {
  const score = liveCellScore(
    { n: 20, median: 104.9, p90: 219.9 },
    { n: 20, median: 100, p90: 200 },
    { n: 20, median: 101, p90: 198 },
  );
  assert.equal(score.control.valid, true);
  assert.deepEqual(score.thresholds, { median: 105, p90: 220.00000000000003 });
  assert.equal(score.pass, true);
});

test('invalidates a cell when the live control drifts over ten percent', () => {
  const score = liveCellScore(
    { n: 20, median: 90, p90: 190 },
    { n: 20, median: 111, p90: 200 },
    { n: 20, median: 100, p90: 200 },
  );
  assert.equal(score.control.valid, false);
  assert.equal(score.pass, false);
});
