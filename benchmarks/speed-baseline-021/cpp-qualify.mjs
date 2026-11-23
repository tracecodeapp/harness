// Compare S(C++) and the other-language spot cells with the pinned raw windows.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [baselinePaths, candidatePaths] = process.argv.slice(2);
assert.ok(baselinePaths && candidatePaths, [
  'Usage: node cpp-qualify.mjs <baseline metadata,samples,...> <candidate metadata,samples,...>',
  'Include desktop-a, desktop-b and phone pairs in both arguments.',
].join('\n'));

async function readWindows(paths) {
  const files = paths.split(',');
  assert.equal(files.length, 6);
  const windows = new Map();
  for (let i = 0; i < files.length; i += 2) {
    const metadata = JSON.parse(await readFile(files[i], 'utf8'));
    assert.equal(metadata.schema, 'tracecode.speed-baseline.v1');
    assert.equal(metadata.mode, 'run');
    assert.ok(['desktop-a', 'desktop-b', 'phone'].includes(metadata.window));
    assert.ok(!windows.has(metadata.window), 'Duplicate window ' + metadata.window);
    assert.equal(metadata.cpu, metadata.window === 'phone' ? 4 : 1);
    const samples = (await readFile(files[i + 1], 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    windows.set(metadata.window, { metadata, samples });
  }
  return windows;
}

const baseline = await readWindows(baselinePaths);
const candidate = await readWindows(candidatePaths);
let identity;
for (const [window, { metadata }] of candidate) {
  const reference = baseline.get(window).metadata;
  assert.match(metadata.candidate.head, /^[0-9a-f]{40}$/);
  assert.ok(['concurrent', 'sequential'].includes(metadata.candidate.policy));
  assert.equal(metadata.candidate.tier, window === 'desktop-a' ? 'spot' : 'cpp');
  for (const field of ['appRefs', 'browser', 'host', 'fixtures']) {
    assert.deepEqual(metadata[field], reference[field], `${window} ${field} differs from the baseline`);
  }
  assert.match(metadata.browser.version, /^145\./);
  assert.equal(metadata.browser.crossOriginIsolated, false);
  const artifact = metadata.packages['0.21-candidate'];
  for (const key of ['sha256', 'dependencyLockSha256', 'dependenciesSha256']) {
    assert.match(artifact[key], /^[0-9a-f]{64}$/);
  }
  const current = { head: metadata.candidate.head, artifact };
  if (identity) assert.deepEqual(current, identity, 'Candidate artifact changed between windows');
  else identity = current;
}

const problems = ['binary-search', 'permutations'];
const desktopStates = ['warm', 'cold', 'switched'];
const cells = [];
for (const problem of problems) {
  for (const state of desktopStates) {
    for (const endpoint of ['verdicts', 'firstTrace', 'secondTrace', 'submitVerdicts']) {
      cells.push({ window: 'desktop-b', language: 'cpp', problem, state, endpoint, target: 20 });
    }
  }
  for (const state of ['warm', 'cold']) {
    for (const endpoint of ['verdicts', 'firstTrace']) {
      cells.push({ window: 'phone', language: 'cpp', problem, state, endpoint, target: 12 });
    }
  }
}
cells.push({ window: 'desktop-b', language: 'cpp', problem: 'binary-search', state: 'warm', endpoint: 'lessonContinue', target: 20 });
for (const language of ['python', 'javascript', 'typescript', 'java', 'csharp']) {
  for (const endpoint of ['verdicts', 'submitVerdicts']) {
    cells.push({ window: 'desktop-a', language, problem: 'binary-search', state: 'warm', endpoint, target: language === 'java' ? 12 : 20 });
  }
}

function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    p90: n ? sorted[Math.ceil(n * 0.9) - 1] : null,
  };
}

function samplesFor({ metadata, samples }, cell, version) {
  const { language, problem, state, endpoint } = cell;
  const journey = endpoint === 'lessonContinue' ? 'lesson' : endpoint === 'submitVerdicts' ? 'submit' : 'run';
  const groupIndex = metadata.schedule.findIndex((group) =>
    group.language === language && group.problem === problem && group.state === state && group.journey === journey);
  const group = metadata.schedule[groupIndex];
  if (!group?.versions.includes(version)) return { ...stats([]), invalid: 0, refusals: 0, excluded: 0 };
  const attempts = samples.filter((sample) => sample.groupIndex === groupIndex && sample.version === version);
  const rounds = new Set();
  const values = [];
  for (const sample of attempts) {
    for (const key of ['language', 'cpu', 'problem', 'state', 'journey', 'target', 'continuation']) {
      assert.equal(sample[key], group[key]);
    }
    assert.ok(Number.isInteger(sample.round) && sample.round > 0 && !rounds.has(sample.round));
    rounds.add(sample.round);
    if (!sample.kept) continue;
    assert.ok(!sample.invalid && !sample.excluded && !sample.refusal);
    assert.ok(Number.isFinite(sample.beforeInitial?.oneMinute) && sample.beforeInitial.oneMinute <= 2);
    if (group.continuation) assert.ok(Number.isFinite(sample.beforeSecond?.oneMinute) && sample.beforeSecond.oneMinute <= 2);
    const ms = sample.metrics?.[endpoint];
    assert.ok(Number.isFinite(ms) && ms > 0);
    if (endpoint === 'firstTrace' || (journey === 'run' && endpoint === 'verdicts')) {
      assert.equal(sample.initial?.firstTraceMs, sample.initial?.elapsedMs, 'Run and first trace must use the same joined response');
      assert.ok(sample.initial.evaluation.cases[0]?.traceEvents > 0);
    }
    if (endpoint === 'secondTrace') assert.ok(sample.second?.evaluation.cases[0]?.traceEvents > 0);
    values.push(ms);
  }
  return {
    ...stats(values),
    invalid: attempts.filter((s) => s.invalid).length,
    refusals: attempts.filter((s) => s.refusal).length,
    excluded: attempts.filter((s) => s.excluded).length,
  };
}

const results = cells.map((cell) => {
  const { window, language, endpoint, target } = cell;
  const versions = endpoint === 'lessonContinue' ? ['0.20.1'] : ['0.17.1', '0.20.1'];
  const referenceWindow = window === 'desktop-a' && !['java', 'csharp'].includes(language)
    ? 'desktop-b'
    : window;
  const csharpAdvisory = language === 'csharp' && endpoint === 'submitVerdicts';
  const references = versions.map((version) => ({
    version,
    advisory: csharpAdvisory && version === '0.17.1',
    ...samplesFor(baseline.get(referenceWindow), cell, version),
  }));
  const actual = samplesFor(candidate.get(window), cell, '0.21-candidate');
  const applicable = references.filter(({ advisory }) => !advisory);
  assert.ok(applicable.every(({ n }) => n >= target), 'Missing frozen baseline for ' + JSON.stringify(cell));
  const medianRatio = actual.median === null ? null : actual.median / Math.min(...applicable.map((v) => v.median));
  const p90Ratio = actual.p90 === null ? null : actual.p90 / Math.min(...applicable.map((v) => v.p90));
  const status = actual.n < target
    ? 'missing'
    : medianRatio <= (window === 'desktop-a' ? 1.05 : 1) && p90Ratio <= 1.10
      ? 'pass'
      : window === 'desktop-a' ? 'full-matrix-required' : 'fail';
  return { ...cell, references, actual, medianRatio, p90Ratio, status };
});

console.log(JSON.stringify({
  candidate: identity,
  windows: [...candidate.values()].map(({ metadata }) => ({
    window: metadata.window, policy: metadata.candidate.policy, complete: metadata.complete,
  })),
  results,
}, null, 2));
if (results.some(({ status }) => status !== 'pass')) process.exitCode = 1;
