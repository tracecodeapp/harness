import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricEndpoints, relative, stats } from './aa-score-lib.mjs';
import { liveCellScoreWithControls } from './live-control.mjs';
import {
  referenceRerecordDate,
  referenceRerecordPlan,
  referenceRerecordReasons,
  referenceRoundOrder,
} from './reference-rerecord.mjs';

const [archive, raw] = process.argv.slice(2);
assert.ok(archive && raw);
const baselineReceipt = readFileSync(new URL('./baseline-results.sha256', import.meta.url), 'utf8')
  .trim().split('\n').map((line) => line.split(/\s+/, 2));
for (const [expected, file] of baselineReceipt) {
  const actual = createHash('sha256').update(readFileSync(join(archive, file))).digest('hex');
  assert.equal(actual, expected, `Frozen baseline digest differs for ${file}`);
}

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
      const name = key(group, endpoint) + '/' + sample.version;
      if (!values.has(name)) values.set(name, []);
      values.get(name).push(sample.metrics[endpoint]);
    }
  }
  return { metadata, samples, values };
}

const desktopA = collect(archive, 'speed-desktop-a-with-topup');
const desktopB = collect(archive, 'speed-desktop-b');
const observed = collect(raw, 'reference-rerecord');
assert.deepEqual(observed.metadata.referenceRerecord, {
  date: referenceRerecordDate,
  target: 20,
  interleavedPerRound: true,
  alternatingOrderPerRound: true,
});
assert.deepEqual(observed.metadata.schedule, referenceRerecordPlan);
assert.equal(observed.metadata.complete, true);
for (const sample of observed.samples) {
  const group = observed.metadata.schedule[sample.groupIndex];
  assert.equal(sample.position, referenceRoundOrder(group.versions, sample.round).indexOf(sample.version));
}
for (const field of ['host', 'browser', 'fixtures', 'appRefs']) {
  assert.deepEqual(observed.metadata[field], desktopA.metadata[field], field);
}
assert.deepEqual(observed.metadata.packages['0.17.1'].dependencies,
  desktopA.metadata.packages['0.17.1'].dependencies);
assert.deepEqual(observed.metadata.packages['0.20.1'].dependencies,
  desktopA.metadata.packages['0.20.1'].dependencies);

const referenceRows = [];
const newReferences = new Map();
for (const group of referenceRerecordPlan) {
  const cell = key(group, 'submitVerdicts');
  const frozenCapture = group.language === 'python' ? desktopB : desktopA;
  for (const version of group.versions) {
    const oldReference = stats(frozenCapture.values.get(cell + '/' + version));
    const newReference = stats(observed.values.get(cell + '/' + version));
    assert.equal(newReference.n, 20, `${cell}/${version} did not keep 20 samples`);
    const row = {
      cell,
      version,
      oldReference,
      newReference,
      date: referenceRerecordDate,
      reason: referenceRerecordReasons[cell],
      newVsOld: relative(newReference, oldReference),
    };
    referenceRows.push(row);
    newReferences.set(cell + '/' + version, newReference);
    console.log(JSON.stringify({ reference: row }));
  }
}

const closing = collect(raw, 'aa-release-closing');
const rescored = [];
for (const problem of ['binary-search', 'permutations']) {
  const cell = `python/1/${problem}/warm/submitVerdicts`;
  const release = stats(closing.values.get(cell + '/release-deploy'));
  const controls = ['0.17.1', '0.20.1'].map((version) => ({
    version,
    result: stats(closing.values.get(cell + '/' + version)),
    frozen: newReferences.get(cell + '/' + version),
  }));
  assert.equal(release.n, 20);
  assert.ok(controls.every(({ result, frozen }) => result.n === 20 && frozen?.n === 20));
  const sameWindow = liveCellScoreWithControls(release, controls);
  const row = { cell, release, sameWindow };
  rescored.push(row);
  console.log(JSON.stringify({ closingRescore: row }));
}

console.log(JSON.stringify({ referenceFile: {
  schema: 'tracecode.speed-host-check-references.v1',
  date: referenceRerecordDate,
  rows: referenceRows,
}, closingRescore: rescored }));
if (rescored.some(({ sameWindow }) =>
  sameWindow.controls.some(({ valid }) => !valid) || !sameWindow.pass)) process.exitCode = 1;
