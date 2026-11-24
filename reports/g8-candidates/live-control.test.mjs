import assert from 'node:assert/strict';
import test from 'node:test';
import {
  liveCellScore,
  liveCellScoreWithControls,
  liveControlPairGroups,
  liveLessonVersions,
  liveControlVersions,
  liveObservationVersion,
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

test('lesson keeps the live control and preview candidate only', () => {
  assert.deepEqual(liveLessonVersions(['candidate-main', 'candidate-deploy']),
    ['0.17.1', 'candidate-main']);
});

test('pairs each candidate with an independent production control group', () => {
  const groups = liveControlPairGroups([
    { language: 'java', problem: 'binary-search', versions: ['ignored'] },
  ], ['candidate-main', 'candidate-deploy']);
  assert.deepEqual(groups, [
    { language: 'java', problem: 'binary-search',
      versions: ['0.17.1', 'candidate-main'], pairedControlFor: 'candidate-main' },
    { language: 'java', problem: 'binary-search',
      versions: ['0.17.1', 'candidate-deploy'], pairedControlFor: 'candidate-deploy' },
  ]);
  assert.deepEqual(liveRoundOrder(groups[0].versions, 1), ['0.17.1', 'candidate-main']);
  assert.deepEqual(liveRoundOrder(groups[0].versions, 2), ['candidate-main', '0.17.1']);
  assert.deepEqual(liveRoundOrder(groups[1].versions, 1), ['0.17.1', 'candidate-deploy']);
  assert.deepEqual(liveRoundOrder(groups[1].versions, 2), ['candidate-deploy', '0.17.1']);
});

test('keeps paired production observations separate for scoring', () => {
  assert.equal(liveObservationVersion('0.17.1', 'candidate-main'),
    '0.17.1:for:candidate-main');
  assert.equal(liveObservationVersion('0.17.1', 'candidate-deploy'),
    '0.17.1:for:candidate-deploy');
  assert.equal(liveObservationVersion('candidate-main', 'candidate-main'),
    'candidate-main');
  assert.equal(liveObservationVersion('0.17.1'), '0.17.1');
});

test('scores candidate against same-window control at five and ten percent', () => {
  const score = liveCellScore(
    { n: 20, median: 104.9, p90: 219.9 },
    { n: 20, median: 100, p90: 200 },
    { n: 20, median: 101, p90: 198 },
  );
  assert.equal(score.controls[0].valid, true);
  assert.deepEqual(score.thresholds, { median: 105, p90: 220.00000000000003 });
  assert.equal(score.pass, true);
});

test('invalidates a cell when the live control drifts over ten percent', () => {
  const score = liveCellScore(
    { n: 20, median: 90, p90: 190 },
    { n: 20, median: 111, p90: 200 },
    { n: 20, median: 100, p90: 200 },
  );
  assert.equal(score.controls[0].valid, false);
  assert.equal(score.pass, false);
});

test('invalidates rather than crashing when a frozen host-check reference is unavailable', () => {
  const score = liveCellScore(
    { n: 20, median: 90, p90: 190 },
    { n: 20, median: 100, p90: 200 },
    { n: 0 },
  );
  assert.equal(score.controls[0].valid, false);
  assert.equal(score.controls[0].invalidReason, 'Frozen host-check reference unavailable');
  assert.deepEqual(score.comparator, { median: 100, p90: 200 });
  assert.deepEqual(score.thresholds, { median: 105, p90: 220.00000000000003 });
  assert.equal(score.pass, false);
});

test('uses the better live control on the two Python warm Submit cells', () => {
  const score = liveCellScoreWithControls(
    { n: 20, median: 100, p90: 200 },
    [
      { version: '0.17.1', result: { n: 20, median: 102, p90: 205 },
        frozen: { n: 20, median: 100, p90: 200 } },
      { version: '0.20.1', result: { n: 20, median: 95, p90: 190 },
        frozen: { n: 20, median: 96, p90: 192 } },
    ],
  );
  assert.deepEqual(score.comparator, { median: 95, p90: 190 });
  assert.deepEqual(score.thresholds, { median: 99.75, p90: 209.00000000000003 });
  assert.equal(score.pass, false);
});
