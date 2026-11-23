import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [candidateDir, baselineDir] = process.argv.slice(2);
assert.ok(candidateDir && baselineDir,
  'Usage: score-java-candidate.mjs <candidate reports> <archived baseline reports>');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const raw = async (path) => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const key = (group, endpoint) => [group.language, group.cpu, group.problem, group.state, endpoint].join('/');
const endpoints = (group) => group.journey === 'lesson' ? ['lessonContinue'] :
  group.journey === 'submit' ? ['submitVerdicts'] :
    ['verdicts', 'firstTrace', ...(group.continuation ? ['secondTrace'] : [])];
const versions = ['0.17.1', '0.20.1'];
const policies = ['candidate-main', 'candidate-deploy'];
const scopes = ['desktop', 'phone', 'spot'];
const fixtureNames = ['binary-search', 'permutations'];
const otherLanguages = ['javascript', 'typescript', 'python', 'cpp', 'csharp'];
const required = new Map(scopes.map((scope) => [scope, new Set()]));
for (const problem of fixtureNames) {
  for (const state of ['warm', 'cold', 'switched']) {
    for (const endpoint of ['verdicts', 'firstTrace', 'secondTrace', 'submitVerdicts']) {
      required.get('desktop').add(key({ language: 'java', cpu: 1, problem, state }, endpoint));
    }
    if (state !== 'switched') {
      for (const endpoint of ['verdicts', 'firstTrace']) {
        required.get('phone').add(key({ language: 'java', cpu: 4, problem, state }, endpoint));
      }
    }
  }
}
required.get('desktop').add('java/1/binary-search/warm/lessonContinue');
for (const language of otherLanguages) {
  for (const endpoint of ['verdicts', 'submitVerdicts']) {
    required.get('spot').add(key({ language, cpu: 1, problem: 'binary-search', state: 'warm' }, endpoint));
  }
}

function collect(meta, rows) {
  const values = new Map();
  const attempts = new Set();
  for (const row of rows) {
    const group = meta.schedule[row.groupIndex];
    assert.ok(group?.versions.includes(row.version));
    for (const field of ['language', 'cpu', 'problem', 'state', 'journey', 'target', 'continuation']) {
      assert.equal(row[field], group[field]);
    }
    const attempt = [row.groupIndex, row.version, row.round].join('/');
    assert.ok(!attempts.has(attempt), 'Duplicate attempt ' + attempt);
    attempts.add(attempt);
    if (!row.kept) continue;
    assert.ok(!row.invalid && !row.excluded && !row.refusal);
    assert.ok(row.beforeInitial?.oneMinute >= 0 && row.beforeInitial.oneMinute <= 2);
    if (group.continuation) assert.ok(row.beforeSecond?.oneMinute >= 0 && row.beforeSecond.oneMinute <= 2);
    for (const endpoint of endpoints(group)) {
      const value = row.metrics[endpoint];
      assert.ok(Number.isFinite(value) && value > 0);
      const k = key(group, endpoint) + '/' + row.version;
      if (!values.has(k)) values.set(k, []);
      values.get(k).push(value);
    }
  }
  return values;
}

function stats(values = []) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n === 0 ? { n } : {
    n,
    median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    p90: sorted[Math.ceil(n * 0.9) - 1],
  };
}

const frozen = new Map();
const origins = new Map();
for (const name of ['desktop-a-with-topup', 'desktop-b', 'phone']) {
  const prefix = join(baselineDir, 'speed-' + name);
  const meta = await json(prefix + '-metadata.json');
  assert.equal(meta.schema, 'tracecode.speed-baseline.v1');
  assert.equal(meta.mode, 'run');
  assert.equal(meta.browser.crossOriginIsolated, false);
  origins.set(name, meta);
  for (const [k, values] of collect(meta, await raw(prefix + '-samples.jsonl'))) frozen.set(k, values);
}

let installed;
let runnerCommit;
let accepted = true;
let spotExcursion = false;
for (const scope of scopes) {
  const prefix = join(candidateDir, 's-java-' + scope);
  try {
    const meta = await json(prefix + '-metadata.json');
    assert.equal(meta.schema, 'tracecode.speed-baseline.v1');
    assert.equal(meta.mode, 'run');
    assert.equal(meta.candidateScope, scope);
    assert.equal(meta.window, scope === 'phone' ? 'phone' : 'desktop-a');
    assert.equal(meta.loadThreshold, 2);
    assert.equal(meta.complete, true);
    const archived = origins.get(scope === 'phone' ? 'phone' : 'desktop-a-with-topup');
    assert.deepEqual(meta.appRefs, archived.appRefs);
    assert.deepEqual(meta.host, archived.host);
    assert.deepEqual(meta.browser, archived.browser);
    assert.deepEqual(meta.fixtures, archived.fixtures);
    installed ??= meta.packages['candidate-main'];
    runnerCommit ??= meta.runnerCommit;
    for (const policy of policies) assert.deepEqual(meta.packages[policy], installed);
    assert.equal(meta.runnerCommit, runnerCommit);
    assert.match(installed.commit, /^[0-9a-f]{40}$/);
    assert.match(installed.sha256, /^[0-9a-f]{64}$/);
    const tree = structuredClone(installed.dependencies);
    tree.version = '0.20.1';
    assert.deepEqual(tree, archived.packages['0.20.1'].dependencies);
    const rows = await raw(prefix + '-samples.jsonl');
    const values = collect(meta, rows);
    const schedule = new Set();
    for (const group of meta.schedule) {
      assert.equal(group.target, 20);
      assert.deepEqual(group.versions, group.journey === 'lesson' ? [policies[0]] : policies);
      for (const endpoint of endpoints(group)) {
        if (scope === 'spot' && endpoint === 'firstTrace') continue;
        const k = key(group, endpoint);
        assert.ok(!schedule.has(k), 'Duplicate candidate cell ' + k);
        schedule.add(k);
      }
    }
    assert.deepEqual(schedule, required.get(scope));
    console.log(JSON.stringify({
      scope, candidate: installed.commit, tarball: installed.sha256,
      invalid: rows.filter(({ invalid, refusal }) => invalid || refusal).length,
      refused: rows.filter(({ refusal }) => refusal).length,
      loadRetakes: rows.filter(({ excluded }) => excluded).length,
    }));
    for (const k of schedule) {
      const appPolicies = k.endsWith('/lessonContinue') ? [policies[0]] : policies;
      const observed = Object.fromEntries(appPolicies.map((policy) => [policy, stats(values.get(k + '/' + policy))]));
      const history = Object.fromEntries(versions.map((version) => [version, stats(frozen.get(k + '/' + version))]));
      const csharpAdvisory = k === 'csharp/1/binary-search/warm/submitVerdicts';
      const requiredBaseline = k.endsWith('/lessonContinue') || csharpAdvisory ? ['0.20.1'] : versions;
      const old = requiredBaseline.map((version) => history[version]);
      const minimum = k.startsWith('java/') ? 12 : 20;
      const missing = Object.values(observed).some(({ n }) => n !== 20) || old.some(({ n }) => n < minimum);
      const baselineMedian = Math.min(...old.map(({ median }) => median ?? Infinity));
      const baselineP90 = Math.min(...old.map(({ p90 }) => p90 ?? Infinity));
      const pass = !missing && Object.values(observed).every(({ median, p90 }) =>
        median <= baselineMedian && p90 <= 1.10 * baselineP90);
      const escalate = scope === 'spot' && !missing && Object.values(observed).some(({ median, p90 }) =>
        median > 1.05 * baselineMedian || p90 > 1.10 * baselineP90);
      if ((scope !== 'spot' && !pass) || missing) accepted = false;
      if (escalate) spotExcursion = true;
      console.log(JSON.stringify({
        key: k, observed, history, baselineMedian, baselineP90, missing, pass,
        ...(csharpAdvisory && { advisory: '0.17.1' }),
        ...(scope === 'spot' && { escalate }),
      }));
    }
  } catch (error) {
    accepted = false;
    console.error(JSON.stringify({ scope, error: error.message }));
  }
}
console.log(JSON.stringify({ javaPass: accepted, spotRequiresFullMatrix: spotExcursion }));
if (!accepted || spotExcursion) process.exitCode = 1;
