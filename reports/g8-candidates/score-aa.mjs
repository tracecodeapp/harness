import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricEndpoints, relative, sampleCounts, stats } from './aa-score-lib.mjs';
import { liveCellScoreWithControls } from './live-control.mjs';

const [archive, raw, mode = 'full'] = process.argv.slice(2);
assert.ok(archive && raw);
assert.ok(['full', 'closing'].includes(mode));
const closing = mode === 'closing';
const versions = closing
  ? ['release-deploy', '0.17.1', '0.20.1']
  : ['0.17.1', 'release-deploy'];

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
const summary = { incomplete: [], noComparator: [], controlInvalid: [], sameWindowFailed: [],
  frozenFailed: [] };

const observed = collect(raw, closing ? 'aa-release-closing' : 'aa-release');
if (closing) {
  assert.deepEqual(observed.metadata.aaClosing, {
    languages: ['csharp', 'python'], versions, fixedOrderPerRound: true,
    pythonWarmSubmitControl: '0.20.1',
  });
  assert.ok(observed.samples.every(({ position, version }) =>
    position === versions.indexOf(version)), 'Closing order must stay fixed in every round');
} else {
  assert.deepEqual(observed.metadata.aaControl, {
    languages: ['csharp', 'python'], versions, interleavedPerRound: true,
  });
}
assert.equal(observed.metadata.releaseVersion, '0.17.3');
assert.deepEqual(Object.keys(observed.metadata.packages), versions);
assert.deepEqual(observed.metadata.packages['0.17.1'].dependencies,
  desktopA.metadata.packages['0.17.1'].dependencies);
if (closing) assert.deepEqual(observed.metadata.packages['0.20.1'].dependencies,
  desktopA.metadata.packages['0.20.1'].dependencies);
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
    counts: Object.fromEntries(versions.map((version) => [version,
      sampleCounts(observed.samples, language, version)])),
  }));

  for (const group of observed.metadata.schedule.filter((group) => group.language === language)) {
    for (const endpoint of metricEndpoints(group)) {
      const cell = key(group, endpoint);
      const frozen = stats(frozenCapture.values.get(cell + '/0.17.1'));
      const today = stats(observed.values.get(cell + '/0.17.1'));
      const today20 = stats(observed.values.get(cell + '/0.20.1'));
      const release = stats(observed.values.get(cell + '/release-deploy'));
      const pythonWarmSubmit = closing && language === 'python' && group.state === 'warm' &&
        group.journey === 'submit';
      const controls = [
        { version: '0.17.1', result: today, frozen },
        ...(pythonWarmSubmit ? [{
          version: '0.20.1', result: today20,
          frozen: stats(frozenCapture.values.get(cell + '/0.20.1')),
        }] : []),
      ];
      const complete = release.n === 20;
      const comparatorComplete = controls.every(({ result }) => result.n === 20);
      const sameWindow = complete && comparatorComplete
        ? liveCellScoreWithControls(release, controls) : undefined;
      const frozenTable = {
        thresholds: { median: frozen.median, p90: frozen.p90 * 1.10 },
        pass: complete && release.median <= frozen.median && release.p90 <= frozen.p90 * 1.10,
      };
      if (!complete) summary.incomplete.push(cell);
      if (!comparatorComplete) summary.noComparator.push(cell);
      else if (sameWindow.controls.some(({ valid }) => !valid)) summary.controlInvalid.push(cell);
      else if (!sameWindow.pass) summary.sameWindowFailed.push(cell);
      if (!frozenTable.pass) summary.frozenFailed.push(cell);
      console.log(JSON.stringify({
        language,
        cell,
        frozen,
        today,
        ...(pythonWarmSubmit && { today20 }),
        release,
        todayVsFrozen: relative(today, frozen),
        releaseVsToday: relative(release, today),
        ...(closing && { distribution: Object.fromEntries(group.versions.map((version) => [version,
          observed.samples.filter((sample) => sample.groupIndex ===
            observed.metadata.schedule.indexOf(group) && sample.version === version && sample.kept)
            .map((sample) => ({
              round: sample.round,
              position: sample.position,
              value: sample.metrics[endpoint],
              compileCacheHit: sample.initial?.evaluation?.compile?.compileCacheHit,
              artifactCacheHit: sample.initial?.evaluation?.compile?.artifactCacheHit,
            }))])) }),
        sameWindow: sameWindow ?? { complete: false, controls },
        frozenTable,
      }));
    }
  }
}

console.log(JSON.stringify({ summary }));
if (summary.incomplete.length || summary.noComparator.length || summary.controlInvalid.length ||
  summary.sameWindowFailed.length) process.exitCode = 1;
