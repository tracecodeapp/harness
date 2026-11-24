import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricEndpoints, stats } from './aa-score-lib.mjs';
import {
  pythonWarmMetricName,
  pythonWarmModes,
} from './python-warm-policy.mjs';
import {
  pythonFreshAaPlan,
  pythonFreshAaRoundOrder,
  pythonFreshAaVersions,
  withinFivePercent,
} from './python-fresh-aa.mjs';

const [raw] = process.argv.slice(2);
assert.ok(raw, 'Usage: score-python-fresh-aa.mjs <raw session directory>');
const prefix = 'python-fresh-aa';
const metadata = JSON.parse(readFileSync(join(raw, prefix + '-metadata.json'), 'utf8'));
const samples = readFileSync(join(raw, prefix + '-samples.jsonl'), 'utf8').trim()
  .split(/\n/u).filter(Boolean).map(JSON.parse);
const labels = pythonFreshAaVersions;
assert.deepEqual(metadata.pythonFreshAa, {
  sourceVersion: '0.17.1', labels, target: 20,
  freshPagePerSample: true, repeatRun: true, alternatingOrderPerRound: true,
});
assert.deepEqual(metadata.schedule, pythonFreshAaPlan);
assert.equal(metadata.complete, true);
assert.deepEqual(metadata.packages[labels[0]], metadata.packages[labels[1]],
  'A/A labels must use exact same package bytes');

const values = new Map();
const push = (key, value) => {
  assert.ok(Number.isFinite(value) && value > 0, key);
  if (!values.has(key)) values.set(key, []);
  values.get(key).push(value);
};
for (const sample of samples) {
  const group = metadata.schedule[sample.groupIndex];
  assert.ok(sample.kept && !sample.invalid && !sample.excluded && !sample.refusal);
  const expectedOrder = pythonFreshAaRoundOrder(group.versions, sample.round);
  assert.equal(sample.position, expectedOrder.indexOf(sample.version));
  assert.ok(sample.initial?.python?.phases?.length > 0, 'Missing measured worker phases');
  assert.ok(sample.cache?.initial, 'Missing measured cache receipt');
  if (group.pythonWarmMode === pythonWarmModes.repeatRun) {
    assert.ok(sample.prime?.python?.phases?.length > 0, 'Missing primer worker phases');
    assert.ok(sample.primeCache, 'Missing primer cache receipt');
  } else {
    assert.equal(sample.prime, undefined, 'Fresh cell unexpectedly primed the page');
  }
  for (const endpoint of metricEndpoints(group)) {
    const measuredEndpoint = pythonWarmMetricName(group, endpoint);
    const value = sample.metrics[measuredEndpoint];
    const cell = [group.problem, measuredEndpoint].join('/');
    push(cell + '/label/' + sample.version, value);
    push(cell + '/position/' + sample.position, value);
    push(cell + '/label-position/' + sample.version + '/' + sample.position, value);
  }
}

let pass = true;
for (const group of metadata.schedule) {
  for (const endpoint of metricEndpoints(group)) {
    const measuredEndpoint = pythonWarmMetricName(group, endpoint);
    const cell = [group.problem, measuredEndpoint].join('/');
    const labelStats = Object.fromEntries(labels.map((label) =>
      [label, stats(values.get(cell + '/label/' + label))]));
    const positionStats = Object.fromEntries([0, 1].map((position) =>
      [position, stats(values.get(cell + '/position/' + position))]));
    const labelPositionStats = Object.fromEntries(labels.map((label) => [label,
      Object.fromEntries([0, 1].map((position) =>
        [position, stats(values.get(cell + '/label-position/' + label + '/' + position))]))]));
    assert.ok(Object.values(labelStats).every(({ n }) => n === 20));
    assert.ok(Object.values(positionStats).every(({ n }) => n === 20));
    assert.ok(Object.values(labelPositionStats).flatMap(Object.values).every(({ n }) => n === 10));
    const checks = {
      labelMedian: withinFivePercent(labelStats[labels[0]].median, labelStats[labels[1]].median),
      labelP90: withinFivePercent(labelStats[labels[0]].p90, labelStats[labels[1]].p90),
      positionMedian: withinFivePercent(positionStats[0].median, positionStats[1].median),
      positionP90: withinFivePercent(positionStats[0].p90, positionStats[1].p90),
      perLabelPosition: labels.every((label) =>
        withinFivePercent(labelPositionStats[label][0].median, labelPositionStats[label][1].median) &&
        withinFivePercent(labelPositionStats[label][0].p90, labelPositionStats[label][1].p90)),
    };
    const cellPass = Object.values(checks).every(Boolean);
    pass &&= cellPass;
    console.log(JSON.stringify({ cell, labelStats, positionStats, labelPositionStats, checks, pass: cellPass }));
  }
}
console.log(JSON.stringify({ summary: { pass } }));
if (!pass) process.exitCode = 1;
