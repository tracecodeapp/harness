import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyLessonModes,
  quantiles,
  scorePair,
} from './score-python-confirmation.mjs';

test('confirmation gate pins both median and p90 at exactly 1.10', () => {
  const control = quantiles(Array.from({ length: 20 }, (_, index) => 100 + index));
  const edge = { n: 20, median: control.median * 1.10, p90: control.p90 * 1.10 };
  assert.equal(scorePair(control, edge).pass, true);
  assert.equal(scorePair(control, { ...edge, median: edge.median + 0.001 }).pass, false);
  assert.equal(scorePair(control, { ...edge, p90: edge.p90 + 0.001 }).pass, false);
});

test('lesson mode follows actual same-version adjacency rather than round number', () => {
  const rows = [
    { sampleStarted: '2026-11-25T00:00:01Z', version: '0.17.1', initial: {} },
    { sampleStarted: '2026-11-25T00:00:02Z', version: 'sprime', initial: {} },
    { sampleStarted: '2026-11-25T00:00:03Z', version: 'sprime', initial: {} },
    { sampleStarted: '2026-11-25T00:00:04Z', version: '0.17.1', initial: {} },
  ];
  assert.deepEqual(classifyLessonModes(rows).map(({ lessonMode }) => lessonMode), [
    'standby-ready',
    'standby-ready',
    'straight-after-own-sample',
    'standby-ready',
  ]);
});
