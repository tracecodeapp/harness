import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricEndpoints, relative, stats } from './aa-score-lib.mjs';

const [archive, raw] = process.argv.slice(2);
assert.ok(archive && raw);
const versions = ['0.17.1', 'release-deploy'];

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
  const seen = new Set();
  assert.equal(metadata.seed, 212026);
  assert.equal(metadata.loadThreshold, 2);
  for (const sample of samples) {
    const group = metadata.schedule[sample.groupIndex];
    assert.ok(group?.versions.includes(sample.version));
    for (const field of ['language', 'cpu', 'problem', 'state', 'journey', 'target', 'continuation']) {
      assert.equal(sample[field], group[field]);
    }
    const attempt = [sample.groupIndex, sample.version, sample.round].join('/');
    assert.ok(!seen.has(attempt));
    seen.add(attempt);
    if (!sample.kept) continue;
    assert.ok(!sample.invalid && !sample.refusal && !sample.excluded);
    for (const pressure of [sample.beforeInitial, ...(group.continuation ? [sample.beforeSecond] : [])]) {
      assert.ok(pressure?.oneMinute >= 0 && pressure.oneMinute <= 2);
    }
    for (const endpoint of metricEndpoints(group)) {
      const measured = sample.metrics[endpoint];
      assert.ok(Number.isFinite(measured) && measured > 0);
      const name = key(group, endpoint) + '/' + sample.version;
      if (!values.has(name)) values.set(name, []);
      values.get(name).push(measured);
    }
  }
  return { metadata, samples, values };
}

const desktopA = collect(archive, 'speed-desktop-a-with-topup');
const desktopB = collect(archive, 'speed-desktop-b');
const summary = { incomplete: [] };

const observed = collect(raw, 'aa-release');
assert.deepEqual(observed.metadata.aaControl, {
  languages: ['csharp', 'python'], versions, interleavedPerRound: true,
});
assert.equal(observed.metadata.releaseVersion, '0.17.3');
assert.deepEqual(Object.keys(observed.metadata.packages), versions);
assert.deepEqual(observed.metadata.packages['0.17.1'].dependencies,
  desktopA.metadata.packages['0.17.1'].dependencies);
const releaseTree = structuredClone(observed.metadata.packages['release-deploy'].dependencies);
releaseTree.version = '0.17.1';
assert.deepEqual(releaseTree, desktopA.metadata.packages['0.17.1'].dependencies);

for (const language of ['csharp', 'python']) {
  const frozenCapture = language === 'csharp' ? desktopA : desktopB;
  for (const field of ['host', 'browser', 'fixtures', 'appRefs']) {
    assert.deepEqual(observed.metadata[field], frozenCapture.metadata[field], field);
  }
  console.log(JSON.stringify({
    language,
    packages: Object.fromEntries(Object.entries(observed.metadata.packages)
      .map(([name, pkg]) => [name, { commit: pkg.commit, sha256: pkg.sha256 }])),
    invalid: Object.fromEntries(versions.map((version) => [version,
      observed.samples.filter((row) => row.version === version && (row.invalid || row.refusal)).length])),
    excluded: Object.fromEntries(versions.map((version) => [version,
      observed.samples.filter((row) => row.version === version && row.excluded).length])),
  }));

  for (const group of observed.metadata.schedule.filter((group) => group.language === language)) {
    for (const endpoint of metricEndpoints(group)) {
      const cell = key(group, endpoint);
      const frozen = stats(frozenCapture.values.get(cell + '/0.17.1'));
      const today = stats(observed.values.get(cell + '/0.17.1'));
      const release = stats(observed.values.get(cell + '/release-deploy'));
      const complete = today.n === 20 && release.n === 20;
      if (!complete) summary.incomplete.push(cell);
      console.log(JSON.stringify({
        language,
        cell,
        frozen,
        today,
        release,
        todayVsFrozen: relative(today, frozen),
        releaseVsToday: relative(release, today),
        complete,
      }));
    }
  }
}

console.log(JSON.stringify({ summary }));
if (summary.incomplete.length) process.exitCode = 1;
