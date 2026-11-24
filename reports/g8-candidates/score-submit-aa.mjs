import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stats } from './aa-score-lib.mjs';
import {
  withinAaMedianTolerance,
  withinAaP90Tolerance,
} from './python-fresh-aa.mjs';
import {
  submitAaLabelPairs,
  submitAaPlan,
  submitAaRoundOrder,
} from './submit-aa.mjs';
import { isSubmitAfterRunWarmMode, warmMetricName } from './warm-repeat-policy.mjs';

const [raw] = process.argv.slice(2);
assert.ok(raw, 'Usage: score-submit-aa.mjs <raw session directory>');
const prefix = 'submit-aa';
const metadata = JSON.parse(readFileSync(join(raw, prefix + '-metadata.json'), 'utf8'));
const samples = readFileSync(join(raw, prefix + '-samples.jsonl'), 'utf8').trim()
  .split(/\n/u).filter(Boolean).map(JSON.parse);
assert.deepEqual(metadata.submitAa, {
  sourceVersions: ['0.17.1', '0.20.1'], labelPairs: submitAaLabelPairs,
  target: 20, languages: ['python', 'csharp'], freshPagePerSample: true,
  submitAfterRun: true, alternatingOrderPerRound: true,
  tolerances: { medianRatio: 1.05, p90Ratio: 1.10 },
});
assert.deepEqual(metadata.schedule, submitAaPlan);
assert.equal(metadata.complete, true);
for (const labels of Object.values(submitAaLabelPairs)) {
  assert.deepEqual(metadata.packages[labels[0]], metadata.packages[labels[1]],
    'Submit A/A pair must use exact same package bytes');
}

const values = new Map();
const push = (key, value) => {
  assert.ok(Number.isFinite(value) && value > 0, key);
  if (!values.has(key)) values.set(key, []);
  values.get(key).push(value);
};
for (const sample of samples) {
  const group = metadata.schedule[sample.groupIndex];
  if (!sample.kept) {
    assert.ok(sample.invalid || sample.excluded || sample.refusal);
    continue;
  }
  assert.ok(!sample.invalid && !sample.excluded && !sample.refusal);
  assert.equal(sample.position,
    submitAaRoundOrder(group.versions, sample.round).indexOf(sample.version));
  const phases = group.language === 'python'
    ? sample.initial?.python?.phases : sample.initial?.csharp?.phases;
  assert.ok(phases?.length > 0, 'Missing measured worker phases');
  assert.ok(sample.cache?.initial, 'Missing measured cache receipt');
  if (isSubmitAfterRunWarmMode(group)) {
    const primePhases = group.language === 'python'
      ? sample.prime?.python?.phases : sample.prime?.csharp?.phases;
    assert.ok(primePhases?.length > 0, 'Missing Submit-after-Run primer phases');
    assert.ok(sample.primeCache, 'Missing Submit-after-Run primer cache receipt');
  } else {
    assert.equal(sample.prime, undefined, 'Fresh Submit unexpectedly primed the page');
  }
  const endpoint = warmMetricName(group, 'submitVerdicts');
  const cell = [group.language, group.problem, endpoint, group.submitAaSourceVersion].join('/');
  push(cell + '/label/' + sample.version, sample.metrics[endpoint]);
  push(cell + '/position/' + sample.position, sample.metrics[endpoint]);
  push(cell + '/label-position/' + sample.version + '/' + sample.position,
    sample.metrics[endpoint]);
}

let pass = true;
for (const group of metadata.schedule) {
  const endpoint = warmMetricName(group, 'submitVerdicts');
  const cell = [group.language, group.problem, endpoint, group.submitAaSourceVersion].join('/');
  const labels = submitAaLabelPairs[group.submitAaSourceVersion];
  const labelStats = Object.fromEntries(labels.map((label) =>
    [label, stats(values.get(cell + '/label/' + label))]));
  const positionStats = Object.fromEntries([0, 1].map((position) =>
    [position, stats(values.get(cell + '/position/' + position))]));
  const labelPositionStats = Object.fromEntries(labels.map((label) => [label,
    Object.fromEntries([0, 1].map((position) =>
      [position, stats(values.get(cell + '/label-position/' + label + '/' + position))]))]));
  assert.ok(Object.values(labelStats).every(({ n }) => n === 20));
  assert.equal(Object.values(positionStats).reduce((sum, { n }) => sum + n, 0), 40);
  assert.ok(Object.values(positionStats).every(({ n }) => n > 0));
  assert.ok(Object.values(labelPositionStats).every((positions) =>
    Object.values(positions).reduce((sum, { n }) => sum + n, 0) === 20 &&
    Object.values(positions).every(({ n }) => n > 0)));
  const checks = {
    labelMedian: withinAaMedianTolerance(labelStats[labels[0]].median, labelStats[labels[1]].median),
    labelP90: withinAaP90Tolerance(labelStats[labels[0]].p90, labelStats[labels[1]].p90),
    positionMedian: withinAaMedianTolerance(positionStats[0].median, positionStats[1].median),
    positionP90: withinAaP90Tolerance(positionStats[0].p90, positionStats[1].p90),
    perLabelPosition: labels.every((label) =>
      withinAaMedianTolerance(labelPositionStats[label][0].median,
        labelPositionStats[label][1].median) &&
      withinAaP90Tolerance(labelPositionStats[label][0].p90,
        labelPositionStats[label][1].p90)),
  };
  const cellPass = Object.values(checks).every(Boolean);
  pass &&= cellPass;
  const pooledReference = stats(labels.flatMap((label) => values.get(cell + '/label/' + label)));
  console.log(JSON.stringify({ submitAa: {
    cell, sourceVersion: group.submitAaSourceVersion, pooledReference,
    labelStats, positionStats, labelPositionStats, checks, pass: cellPass,
  } }));
}
console.log(JSON.stringify({ summary: { pass } }));
if (!pass) process.exitCode = 1;
