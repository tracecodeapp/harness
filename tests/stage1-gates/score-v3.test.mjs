import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreV3 } from './score-v3.mjs';

const gaGap = 'G1/cpp/end-character/default/run-first/A/instrumented-line';
const gbGap = 'G5/cpp/stdout/run-first/A/anchor';
const deferred = 'G1/cpp/stdout/deferred/draw-first-deferred/@request/observer-start-count';
const gaReport = (failed, extra) => ({ failed, missing: [], controlFailures: [], unexpected: [], repeated: [], ...extra });
const gbReport = {
  checks: { failed: 1, missing: 0 },
  phases: [{ receipts: [{ id: gbGap, status: 'failed' }] }],
  notes: [], controls: [], unexpected: [], repeated: [],
};

test('the V3 baseline accepts the exact recorded C++ failure IDs', () => {
  assert.deepEqual(scoreV3('ga-cpp', 1, gaReport([gaGap])), {
    pass: true, accepted: [gaGap], unexpectedFailures: [], inventoryErrors: 0,
  });
  assert.equal(scoreV3('gb-cpp', 1, gbReport).pass, true);
  assert.equal(scoreV3('ga-java', 1, gaReport([gaGap])).pass, false);
});

test('new failures, missing assertions and failed controls stay red', () => {
  assert.equal(scoreV3('ga-cpp', 1, gaReport([gaGap, deferred])).pass, false);
  assert.equal(scoreV3('ga-cpp', 1, gaReport([gaGap], { missing: [gaGap] })).pass, false);
  assert.equal(scoreV3('ga-cpp', 1, gaReport([gaGap], { controlFailures: ['replay'] })).pass, false);
  assert.equal(scoreV3('ga-cpp', 1, gaReport([])).pass, false);
  assert.equal(scoreV3('gb-cpp', 1, { ...gbReport, notes: [{ error: 'browser crashed' }] }).pass, false);
});
