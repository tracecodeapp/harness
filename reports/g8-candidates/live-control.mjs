import assert from 'node:assert/strict';

export const liveControlVersion = '0.17.1';

export function liveControlVersions(candidateVersions) {
  assert.ok(candidateVersions.length > 0);
  assert.ok(!candidateVersions.includes(liveControlVersion));
  assert.equal(new Set(candidateVersions).size, candidateVersions.length);
  return [liveControlVersion, ...candidateVersions];
}

export function liveRoundOrder(versions, round) {
  assert.equal(versions[0], liveControlVersion);
  assert.ok(Number.isSafeInteger(round) && round > 0);
  const candidates = versions.slice(1);
  return round % 2 === 1
    ? [liveControlVersion, ...candidates]
    : [...candidates].reverse().concat(liveControlVersion);
}

function relative(actual, reference) {
  return (actual - reference) / reference;
}

export function liveCellScore(candidate, control, frozenControl) {
  for (const row of [candidate, control, frozenControl]) {
    assert.ok(row.n > 0 && Number.isFinite(row.median) && Number.isFinite(row.p90));
  }
  const drift = {
    median: relative(control.median, frozenControl.median),
    p90: relative(control.p90, frozenControl.p90),
  };
  const controlValid = Math.abs(drift.median) <= 0.10 && Math.abs(drift.p90) <= 0.10;
  const thresholds = { median: control.median * 1.05, p90: control.p90 * 1.10 };
  return {
    control: { result: control, frozen: frozenControl, drift, valid: controlValid },
    thresholds,
    pass: controlValid && candidate.median <= thresholds.median && candidate.p90 <= thresholds.p90,
  };
}
