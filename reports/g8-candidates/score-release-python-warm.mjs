import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricEndpoints, relative, stats } from './aa-score-lib.mjs';
import { liveCellScoreWithControls, liveRoundOrder } from './live-control.mjs';
import { releasePythonWarmPlan } from './release-python-warm.mjs';
import {
  expandPythonWarmGroups,
  pythonWarmMetricName,
  pythonWarmModes,
} from './python-warm-policy.mjs';

const [archive, raw] = process.argv.slice(2);
assert.ok(archive && raw);
const baselineReceipt = readFileSync(new URL('./baseline-results.sha256', import.meta.url), 'utf8')
  .trim().split('\n').map((line) => line.split(/\s+/, 2));
for (const [expected, file] of baselineReceipt) {
  const actual = createHash('sha256').update(readFileSync(join(archive, file))).digest('hex');
  assert.equal(actual, expected, `Frozen baseline digest differs for ${file}`);
}
const hostReferences = JSON.parse(readFileSync(new URL('./host-check-references.json', import.meta.url)));
const hostReference = new Map(hostReferences.rows.map((row) =>
  [`${row.cell}/${row.version}`, row]));
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const records = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const key = (group, endpoint) => [group.language, group.cpu, group.problem, group.state, endpoint].join('/');

function collect(folder, prefix) {
  const metadata = json(join(folder, prefix + '-metadata.json'));
  const samples = records(join(folder, prefix + '-samples.jsonl'));
  const values = new Map();
  for (const sample of samples) {
    const group = metadata.schedule[sample.groupIndex];
    assert.ok(group?.versions.includes(sample.version));
    if (!sample.kept) continue;
    assert.ok(!sample.invalid && !sample.refusal && !sample.excluded);
    for (const endpoint of metricEndpoints(group)) {
      const measuredEndpoint = pythonWarmMetricName(group, endpoint);
      const name = key(group, measuredEndpoint) + '/' + sample.version;
      if (!values.has(name)) values.set(name, []);
      values.get(name).push(sample.metrics[measuredEndpoint]);
    }
  }
  return { metadata, samples, values };
}

const frozen = collect(archive, 'speed-desktop-b');
const observed = collect(raw, 'release-python-warm');
assert.deepEqual(observed.metadata.releasePythonWarm, {
  release: '0.17.3', target: 20, alternatingOrderPerRound: true,
  pythonWarmSubmitControl: '0.20.1',
});
const expectedPlan = expandPythonWarmGroups(
  releasePythonWarmPlan, { submitAfterRun: true });
assert.deepEqual(observed.metadata.schedule, expectedPlan);
assert.equal(observed.metadata.complete, true);
for (const sample of observed.samples) {
  const group = observed.metadata.schedule[sample.groupIndex];
  assert.equal(sample.position, liveRoundOrder(group.versions, sample.round).indexOf(sample.version));
}
for (const field of ['host', 'browser', 'fixtures', 'appRefs']) {
  assert.deepEqual(observed.metadata[field], frozen.metadata[field], field);
}

const otherWarm = [];
for (const group of expectedPlan.filter(({ journey }) => journey === 'run')) {
  for (const endpoint of metricEndpoints(group)) {
    const measuredEndpoint = pythonWarmMetricName(group, endpoint);
    const cell = key(group, measuredEndpoint);
    const liveControl = stats(observed.values.get(cell + '/0.17.1'));
    const release = stats(observed.values.get(cell + '/release-deploy'));
    assert.equal(liveControl.n, 20);
    assert.equal(release.n, 20);
    const repeat = group.pythonWarmMode === pythonWarmModes.repeatRun;
    const frozenCell = key(group, endpoint);
    const frozenControl = repeat ? undefined : stats(frozen.values.get(frozenCell + '/0.17.1'));
    const drift = repeat ? undefined : relative(liveControl, frozenControl);
    const valid = repeat || Math.abs(drift.medianPct) <= 10 && Math.abs(drift.p90Pct) <= 10;
    const thresholds = { median: liveControl.median * 1.05, p90: liveControl.p90 * 1.10 };
    const pass = release.median <= thresholds.median && release.p90 <= thresholds.p90;
    const row = { cell, repeat, frozenControl, liveControl, drift, valid, release, thresholds, pass };
    otherWarm.push(row);
    console.log(JSON.stringify({ otherWarm: row }));
  }
}
const fallbackHealthy = otherWarm.filter(({ repeat }) => !repeat).every(({ valid }) => valid);

const submitWarm = [];
for (const group of expectedPlan.filter(({ journey, pythonWarmMode }) =>
  journey === 'submit' && pythonWarmMode === pythonWarmModes.fresh)) {
  const cell = key(group, 'submitVerdicts');
  const release = stats(observed.values.get(cell + '/release-deploy'));
  const controls = ['0.17.1', '0.20.1'].map((version) => {
    const result = stats(observed.values.get(cell + '/' + version));
    const reference = hostReference.get(cell + '/' + version);
    assert.ok(reference);
    return {
      version,
      result,
      oldReference: reference.oldReference,
      newReference: reference.newReference,
      driftOld: relative(result, reference.oldReference),
      driftNew: relative(result, reference.newReference),
    };
  });
  assert.equal(release.n, 20);
  assert.ok(controls.every(({ result }) => result.n === 20));
  const scored = liveCellScoreWithControls(release, controls.map(({ version, result, newReference }) =>
    ({ version, result, frozen: newReference })));
  const numericalPass = release.median <= scored.thresholds.median && release.p90 <= scored.thresholds.p90;
  const row = {
    cell, release, controls, comparator: scored.comparator, thresholds: scored.thresholds,
    numericalPass, fallbackHealthy, formalPass: fallbackHealthy && numericalPass,
  };
  submitWarm.push(row);
  console.log(JSON.stringify({ submitWarm: row }));
}

const submitAfterRun = [];
for (const group of expectedPlan.filter(({ pythonWarmMode }) =>
  pythonWarmMode === pythonWarmModes.submitAfterRun)) {
  const cell = key(group, 'submitAfterRunVerdicts');
  const release = stats(observed.values.get(cell + '/release-deploy'));
  const control = stats(observed.values.get(cell + '/0.17.1'));
  assert.equal(release.n, 20);
  assert.equal(control.n, 20);
  const thresholds = { median: control.median * 1.05, p90: control.p90 * 1.10 };
  const pass = release.median <= thresholds.median && release.p90 <= thresholds.p90;
  const row = { cell, release, control, thresholds, pass };
  submitAfterRun.push(row);
  console.log(JSON.stringify({ submitAfterRun: row }));
}

console.log(JSON.stringify({ summary: {
  fallbackHealthy,
  otherWarmInvalid: otherWarm.filter(({ valid }) => !valid).map(({ cell }) => cell),
  otherWarmFailed: otherWarm.filter(({ pass }) => !pass).map(({ cell }) => cell),
  submitFailed: submitWarm.filter(({ formalPass }) => !formalPass).map(({ cell }) => cell),
  submitAfterRunFailed: submitAfterRun.filter(({ pass }) => !pass).map(({ cell }) => cell),
} }));
if (!fallbackHealthy || otherWarm.some(({ pass }) => !pass) ||
    submitWarm.some(({ formalPass }) => !formalPass) ||
    submitAfterRun.some(({ pass }) => !pass)) process.exitCode = 1;
