import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { metricEndpoints, stats } from './aa-score-lib.mjs';
import {
  phoneWarmAaPlan,
  phoneWarmAaRoundOrder,
  phoneWarmAaSampleDisposition,
  phoneWarmAaVersions,
} from './phone-warm-aa.mjs';
import {
  withinAaMedianTolerance,
  withinAaP90Tolerance,
} from './python-fresh-aa.mjs';
import { historicalPackageSha256 } from './java-runner/version-preparation.mjs';
import { isRepeatWarmMode, warmMetricName } from './warm-repeat-policy.mjs';

const [raw, prefix = 'session2-phone-warm-aa'] = process.argv.slice(2)
  .filter((arg) => arg !== '--preflight');
const preflight = process.argv.includes('--preflight');
assert.ok(raw, 'Usage: score-phone-warm-aa.mjs <raw directory> [prefix] [--preflight]');

const metadata = JSON.parse(readFileSync(join(raw, prefix + '-metadata.json'), 'utf8'));
const samples = readFileSync(join(raw, prefix + '-samples.jsonl'), 'utf8').trim()
  .split(/\n/u).filter(Boolean).map(JSON.parse);
assert.deepEqual(metadata.phoneWarmAa, {
  sourceVersion: '0.17.1', labels: phoneWarmAaVersions, target: 20,
  languages: ['python', 'csharp'], cpu: 4, freshPagePerSample: true,
  repeatRun: true, alternatingOrderPerRound: true,
  tolerances: { medianRatio: 1.05, p90Ratio: 1.10 },
});
assert.equal(metadata.complete, true);
assert.deepEqual(metadata.packages[phoneWarmAaVersions[0]],
  metadata.packages[phoneWarmAaVersions[1]], 'A/A labels must use identical package bytes');
assert.equal(metadata.packages[phoneWarmAaVersions[0]].sha256,
  historicalPackageSha256['0.17.1']);
const expectedSchedule = preflight
  ? phoneWarmAaPlan.map((group) => ({ ...group, target: 1 })) : phoneWarmAaPlan;
assert.deepEqual(metadata.schedule, expectedSchedule);

const values = new Map();
const push = (key, value) => {
  assert.ok(Number.isFinite(value) && value > 0, key);
  if (!values.has(key)) values.set(key, []);
  values.get(key).push(value);
};
for (const sample of samples) {
  const group = metadata.schedule[sample.groupIndex];
  if (phoneWarmAaSampleDisposition(sample) === 'excluded') continue;
  const expectedOrder = phoneWarmAaRoundOrder(group.versions, sample.round);
  assert.equal(sample.position, expectedOrder.indexOf(sample.version));
  assert.ok(sample.cache?.initial, 'Missing measured cache receipt');
  if (isRepeatWarmMode(group)) {
    assert.ok(sample.prime, 'Missing repeat primer');
    assert.ok(sample.primeCache, 'Missing repeat primer receipt');
  } else {
    assert.equal(sample.prime, undefined, 'Fresh cell unexpectedly has a primer');
  }
  for (const endpoint of metricEndpoints(group)) {
    const metric = warmMetricName(group, endpoint);
    const cell = [group.language, 4, group.problem, 'warm', metric].join('/');
    push(`${cell}/label/${sample.version}`, sample.metrics[metric]);
    push(`${cell}/position/${sample.position}`, sample.metrics[metric]);
    push(`${cell}/label-position/${sample.version}/${sample.position}`, sample.metrics[metric]);
  }
}

let pass = true;
const references = [];
for (const group of metadata.schedule) {
  for (const endpoint of metricEndpoints(group)) {
    const metric = warmMetricName(group, endpoint);
    const cell = [group.language, 4, group.problem, 'warm', metric].join('/');
    const labelStats = Object.fromEntries(phoneWarmAaVersions.map((label) =>
      [label, stats(values.get(`${cell}/label/${label}`))]));
    const positionStats = Object.fromEntries([0, 1].map((position) =>
      [position, stats(values.get(`${cell}/position/${position}`) ?? [])]));
    const pooled = stats(phoneWarmAaVersions.flatMap((label) =>
      values.get(`${cell}/label/${label}`) ?? []));
    let checks = { structural: true };
    if (!preflight) {
      const labelPositionStats = Object.fromEntries(phoneWarmAaVersions.map((label) => [label,
        Object.fromEntries([0, 1].map((position) => [position,
          stats(values.get(`${cell}/label-position/${label}/${position}`) ?? [])]))]));
      assert.ok(Object.values(labelStats).every(({ n }) => n === 20));
      checks = {
        labelMedian: withinAaMedianTolerance(
          labelStats[phoneWarmAaVersions[0]].median, labelStats[phoneWarmAaVersions[1]].median),
        labelP90: withinAaP90Tolerance(
          labelStats[phoneWarmAaVersions[0]].p90, labelStats[phoneWarmAaVersions[1]].p90),
        positionMedian: withinAaMedianTolerance(positionStats[0].median, positionStats[1].median),
        positionP90: withinAaP90Tolerance(positionStats[0].p90, positionStats[1].p90),
        perLabelPosition: phoneWarmAaVersions.every((label) =>
          withinAaMedianTolerance(labelPositionStats[label][0].median,
            labelPositionStats[label][1].median) &&
          withinAaP90Tolerance(labelPositionStats[label][0].p90,
            labelPositionStats[label][1].p90)),
      };
    } else {
      assert.ok(Object.values(labelStats).every(({ n }) => n === 1));
    }
    const cellPass = Object.values(checks).every(Boolean);
    pass &&= cellPass;
    references.push({ cell, version: '0.17.1', reference: pooled,
      sourceSession: 2, source: 'phone-warm-aa' });
    console.log(JSON.stringify({ cell, labelStats, positionStats, pooled, checks,
      pass: cellPass }));
  }
}
console.log(JSON.stringify({ summary: { pass, preflight, references } }));
if (!pass) process.exitCode = 1;
