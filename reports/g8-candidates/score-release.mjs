import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreThresholds } from './score-thresholds.mjs';

const [archive, raw] = process.argv.slice(2);
assert.ok(archive && raw);
const release = '0.17.3';
const policy = 'release-deploy';
const primaryLanguages = ['csharp', 'python'];
const spotLanguages = ['javascript', 'typescript', 'cpp', 'java'];

const baselineReceipt = readFileSync(new URL('./baseline-results.sha256', import.meta.url), 'utf8')
  .trim().split('\n').map((line) => line.split(/\s+/, 2));
for (const [expected, file] of baselineReceipt) {
  const actual = createHash('sha256').update(readFileSync(join(archive, file))).digest('hex');
  assert.equal(actual, expected, `Frozen baseline digest differs for ${file}`);
}

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const records = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const key = (group, endpoint) => [group.language, group.cpu, group.problem, group.state, endpoint].join('/');
const endpoints = (group) => group.journey === 'run'
  ? ['verdicts', 'firstTrace', ...(group.continuation ? ['secondTrace'] : [])]
  : [group.journey === 'lesson' ? 'lessonContinue' : 'submitVerdicts'];

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
    for (const endpoint of endpoints(group)) {
      const measured = sample.metrics[endpoint];
      assert.ok(Number.isFinite(measured) && measured > 0);
      const name = key(group, endpoint) + '/' + sample.version;
      if (!values.has(name)) values.set(name, []);
      values.get(name).push(measured);
    }
  }
  return { metadata, samples, values };
}

function stats(values = []) {
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  return n ? {
    n,
    median: (ordered[Math.floor((n - 1) / 2)] + ordered[Math.floor(n / 2)]) / 2,
    p90: ordered[Math.ceil(0.9 * n) - 1],
  } : { n };
}

const baselineCaptures = {
  desktopA: collect(archive, 'speed-desktop-a-with-topup'),
  desktopB: collect(archive, 'speed-desktop-b'),
  phone: collect(archive, 'speed-phone'),
};
const archived = new Map(Object.values(baselineCaptures).flatMap((capture) => [...capture.values]));

function required(language, scope) {
  if (scope === 'spot') {
    return spotLanguages.map((spotLanguage) =>
      spotLanguage + '/1/binary-search/warm/verdicts');
  }
  const cpu = scope === 'phone' ? 4 : 1;
  const states = scope === 'phone' ? ['warm', 'cold'] : ['warm', 'cold', 'switched'];
  return ['binary-search', 'permutations'].flatMap((problem) => states.flatMap((state) =>
    (scope === 'phone' ? ['verdicts', 'firstTrace'] :
      ['verdicts', 'firstTrace', 'secondTrace', 'submitVerdicts'])
      .map((endpoint) => key({ language, cpu, problem, state }, endpoint))));
}

function referenceFor(language, scope) {
  if (scope === 'phone') return baselineCaptures.phone;
  return ['csharp', 'java'].includes(language) ? baselineCaptures.desktopA : baselineCaptures.desktopB;
}

function historyMinimum(cell, scope) {
  if (/^csharp\/1\/(binary-search|permutations)\/warm\/submitVerdicts$/u.test(cell)) return 7;
  if (scope === 'phone' || cell.startsWith('java/')) return 12;
  return 20;
}

const summary = { incomplete: [], failed: [], escalations: [] };
const scopes = [
  ...primaryLanguages.flatMap((language) => ['desktop', 'phone'].map((scope) => ({ language, scope }))),
  { language: 'csharp', scope: 'spot' },
];

for (const { language, scope } of scopes) {
  const prefix = scope === 'spot' ? `r-${release}-spot` : `r-${release}-${language}-${scope}`;
  let observed;
  try {
    observed = collect(raw, prefix);
    const reference = referenceFor(language, scope);
    for (const field of ['host', 'browser', 'fixtures', 'appRefs']) {
      assert.deepEqual(observed.metadata[field], reference.metadata[field], field);
    }
    assert.equal(observed.metadata.releaseVersion, release);
    const pkg = observed.metadata.packages[policy];
    const tree = structuredClone(pkg.dependencies);
    tree.version = '0.17.1';
    // The frozen Desktop A receipt is the canonical npm tree encoding. Desktop
    // B used an older npm serialization for the same lock and package set.
    assert.deepEqual(tree, baselineCaptures.desktopA.metadata.packages['0.17.1'].dependencies);
  } catch (error) {
    console.log(JSON.stringify({ language, scope, unavailable: error.message }));
    summary.incomplete.push(...required(language, scope).map((cell) => cell + '/' + policy));
    continue;
  }

  console.log(JSON.stringify({
    language,
    scope,
    packages: Object.fromEntries(Object.entries(observed.metadata.packages)
      .map(([name, pkg]) => [name, { commit: pkg.commit, sha256: pkg.sha256 }])),
    refused: observed.samples.filter((row) => row.refusal).length,
    invalid: observed.samples.filter((row) => row.invalid || row.refusal).length,
    excluded: observed.samples.filter((row) => row.excluded).length,
  }));

  for (const cell of required(language, scope)) {
    const history = stats(archived.get(cell + '/0.17.1'));
    assert.ok(history.n >= historyMinimum(cell, scope), cell);
    const thresholds = scoreThresholds(scope, [history]);
    const result = stats(observed.values.get(cell + '/' + policy));
    const complete = result.n === 20;
    const pass = complete && result.median <= thresholds.median && result.p90 <= thresholds.p90;
    const id = cell + '/' + policy;
    if (!complete) summary.incomplete.push(id);
    else if (!pass && scope === 'spot') summary.escalations.push(id);
    else if (!pass) summary.failed.push(id);
    console.log(JSON.stringify({
      language: cell.split('/')[0], scope, cell, policy, result,
      history: { '0.17.1': history }, thresholds, complete, pass,
    }));
  }
}

console.log(JSON.stringify({ summary }));
if (summary.incomplete.length || summary.failed.length || summary.escalations.length) {
  process.exitCode = 1;
}
