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
  return liveCellScoreWithControls(candidate, [
    { version: liveControlVersion, result: control, frozen: frozenControl },
  ]);
}

export function liveCellScoreWithControls(candidate, controls) {
  assert.ok(controls.length > 0);
  for (const row of [candidate, ...controls.flatMap(({ result, frozen }) => [result, frozen])]) {
    assert.ok(row.n > 0 && Number.isFinite(row.median) && Number.isFinite(row.p90));
  }
  const controlRows = controls.map(({ version, result, frozen }) => {
    const drift = {
      median: relative(result.median, frozen.median),
      p90: relative(result.p90, frozen.p90),
    };
    return {
      version, result, frozen, drift,
      valid: Math.abs(drift.median) <= 0.10 && Math.abs(drift.p90) <= 0.10,
    };
  });
  const comparator = {
    median: Math.min(...controlRows.map(({ result }) => result.median)),
    p90: Math.min(...controlRows.map(({ result }) => result.p90)),
  };
  const thresholds = { median: comparator.median * 1.05, p90: comparator.p90 * 1.10 };
  const controlValid = controlRows.every(({ valid }) => valid);
  return {
    controls: controlRows,
    comparator,
    thresholds,
    pass: controlValid && candidate.median <= thresholds.median && candidate.p90 <= thresholds.p90,
  };
}
