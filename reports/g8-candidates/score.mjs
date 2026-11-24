import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { medianRegressionClass, scoreThresholds } from './score-thresholds.mjs';
import { liveCellScoreWithControls, liveObservationVersion } from './live-control.mjs';
import { isRepeatWarmMode, warmMetricName } from './warm-repeat-policy.mjs';

const [archive, raw, primary] = process.argv.slice(2);
const languages = ['javascript', 'typescript', 'python', 'cpp', 'java', 'csharp'];
assert.ok(archive && raw && ['java', 'csharp', 'python'].includes(primary));
const baselineReceipt = readFileSync(new URL('./baseline-results.sha256', import.meta.url), 'utf8')
  .trim().split('\n').map((line) => line.split(/\s+/, 2));
for (const [expected, file] of baselineReceipt) {
  const actual = createHash('sha256').update(readFileSync(join(archive, file))).digest('hex');
  assert.equal(actual, expected, `Frozen baseline digest differs for ${file}`);
}
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const records = file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const versions = ['0.17.1', '0.20.1'];
const key = (g, endpoint) => [g.language, g.cpu, g.problem, g.state, endpoint].join('/');
const endpoints = (g) => g.journey === 'run'
  ? ['verdicts', 'firstTrace', ...(g.continuation ? ['secondTrace'] : [])]
  : [g.journey === 'lesson' ? 'lessonContinue' : 'submitVerdicts'];
function collect(folder, prefix) {
  const metadata = json(join(folder, prefix + '-metadata.json'));
  const samples = records(join(folder, prefix + '-samples.jsonl'));
  const values = new Map(), cacheReceipts = new Map(), seen = new Set();
  assert.equal(metadata.seed, 212026);
  assert.equal(metadata.loadThreshold, 2);
  for (const sample of samples) {
    const group = metadata.schedule[sample.groupIndex];
    assert.ok(group?.versions.includes(sample.version));
    for (const field of ['language', 'cpu', 'problem', 'state', 'journey', 'target', 'continuation'])
      assert.equal(sample[field], group[field]);
    const attempt = [sample.groupIndex, sample.version, sample.round].join('/');
    assert.ok(!seen.has(attempt));
    seen.add(attempt);
    if (!sample.kept) continue;
    assert.ok(!sample.invalid && !sample.refusal && !sample.excluded);
    for (const pressure of [sample.beforeInitial, ...(group.continuation ? [sample.beforeSecond] : [])])
      assert.ok(pressure?.oneMinute >= 0 && pressure.oneMinute <= 2);
    for (const endpoint of endpoints(group)) {
      const measuredEndpoint = warmMetricName(group, endpoint);
      const measured = sample.metrics[measuredEndpoint];
      assert.ok(Number.isFinite(measured) && measured > 0);
      const observationVersion = liveObservationVersion(sample.version, group.pairedControlFor);
      const name = key(group, measuredEndpoint) + '/' + observationVersion;
      if (!values.has(name)) values.set(name, []);
      values.get(name).push(measured);
      if (['java', 'csharp', 'python'].includes(sample.language)) {
        if (!cacheReceipts.has(name)) cacheReceipts.set(name, []);
        cacheReceipts.get(name).push(sample.cache);
      }
    }
  }
  return { metadata, samples, values, cacheReceipts };
}
function stats(values = []) {
  const ordered = [...values].sort((a,b) => a-b);
  const n = ordered.length;
  return n ? { n, median: (ordered[Math.floor((n-1)/2)] + ordered[Math.floor(n/2)])/2,
    p90: ordered[Math.ceil(.9*n)-1] } : { n };
}
function collectAaReferences(folder, prefix) {
  const metadata = json(join(folder, prefix + '-metadata.json'));
  const samples = records(join(folder, prefix + '-samples.jsonl'));
  const values = new Map();
  for (const sample of samples.filter(({ kept }) => kept)) {
    const group = metadata.schedule[sample.groupIndex];
    const sourceVersion = group.submitAaSourceVersion ?? '0.17.1';
    for (const [endpoint, value] of Object.entries(sample.metrics)) {
      const name = key(group, endpoint) + '/' + sourceVersion;
      if (!values.has(name)) values.set(name, []);
      values.get(name).push(value);
    }
  }
  return new Map([...values].map(([name, rows]) => [name, stats(rows)]));
}
function cacheStats(receipts = [], roles = ['ordinary', 'observer']) {
  const roleStats = (role) => {
    const rows = receipts.map((receipt) => receipt?.initial?.[role] ?? []);
    return {
      samples: rows.length,
      compileMisses: rows.filter((prepares) => prepares.some((row) => row.compileCacheHit === false)).length,
      artifactMisses: rows.filter((prepares) => prepares.some((row) => row.artifactCacheHit === false)).length,
      missing: rows.filter((prepares) => prepares.length === 0 || prepares.some((row) =>
        typeof row.compileCacheHit !== 'boolean' || typeof row.artifactCacheHit !== 'boolean')).length,
    };
  };
  const prepares = receipts.map((receipt) => roles.flatMap((role) => receipt?.initial?.[role] ?? []));
  return {
    samples: receipts.length,
    compileMisses: prepares.filter((rows) => rows.some((row) => row.compileCacheHit === false)).length,
    artifactMisses: prepares.filter((rows) => rows.some((row) => row.artifactCacheHit === false)).length,
    missing: prepares.filter((rows) => rows.length === 0 || rows.some((row) =>
      typeof row.compileCacheHit !== 'boolean' || typeof row.artifactCacheHit !== 'boolean')).length,
    roles: Object.fromEntries(roles.map((role) => [role, roleStats(role)])),
  };
}
const capture = ['desktop-a-with-topup', 'desktop-b', 'phone'].map(w => collect(archive, 'speed-' + w));
const archived = new Map(capture.flatMap(receipt => [...receipt.values]));
const newDesignReferences = new Map();
if (['python', 'csharp'].includes(primary)) {
  const fresh = collectAaReferences(join(raw, '..', 'python-fresh-aa'), 'python-fresh-aa');
  const submit = collectAaReferences(join(raw, '..', 'submit-aa'), 'submit-aa');
  for (const [name, row] of [...fresh, ...submit]) newDesignReferences.set(name, row);
}
function required(scope) {
  if (scope === 'spot') return languages.filter(l => l !== primary).map(l => l + '/1/binary-search/warm/verdicts');
  const cpu = scope === 'phone' ? 4 : 1;
  const states = scope === 'phone' ? ['warm', 'cold'] : ['warm', 'cold', 'switched'];
  const base = [
    ...['binary-search', 'permutations'].flatMap(problem => states.flatMap(state =>
      (scope === 'phone' ? ['verdicts', 'firstTrace'] : ['verdicts', 'firstTrace', 'secondTrace', 'submitVerdicts'])
        .map(endpoint => key({language: primary, cpu, problem, state}, endpoint)))),
    ...(scope === 'desktop' ? [primary + '/1/binary-search/warm/lessonContinue'] : []),
  ];
  if (!['python', 'csharp'].includes(primary)) return base;
  return [
    ...base,
    ...['binary-search', 'permutations'].flatMap((problem) => [
      `${primary}/${cpu}/${problem}/warm/repeatVerdicts`,
      `${primary}/${cpu}/${problem}/warm/repeatFirstTrace`,
      ...(scope === 'desktop' ? [`${primary}/${cpu}/${problem}/warm/repeatSecondTrace`] : []),
      ...(scope === 'desktop' ? [`${primary}/${cpu}/${problem}/warm/submitAfterRunVerdicts`] : []),
    ]),
  ];
}
function policyFor(scope, cell) {
  if (scope === 'spot') return ['candidate-main', 'candidate-deploy'];
  if (primary === 'python') return scope === 'phone' ? ['concurrent', 'sequential']
    : cell.endsWith('/lessonContinue') ? ['concurrent'] : ['concurrent', 'concurrent-deploy'];
  return cell.endsWith('/lessonContinue') ? ['candidate-main'] : ['candidate-main', 'candidate-deploy'];
}
let liveControl;
const summary = { incomplete: [], frozenFailed: [], frozenEscalations: [], pythonPhoneFrozen: {},
  noComparator: [], sameWindowFailed: [], controlInvalid: [], unstable: [],
  fixForward: [], recordedFiveToTen: [] };
for (const scope of ['desktop', 'phone', 'spot']) {
  const prefix = primary === 'python' && scope !== 'spot'
    ? (scope === 'phone' ? 'speed-phone' : 'speed-desktop-b') : 's-' + primary + '-' + scope;
  let observed;
  let pairedCandidateControls = false;
  try {
    observed = collect(raw, prefix);
    const scopeLiveControl = observed.metadata.liveControl !== undefined;
    if (liveControl !== undefined && liveControl !== scopeLiveControl) {
      throw new Error('Live-control metadata differs between scopes');
    }
    liveControl = scopeLiveControl;
    const expectedCandidateVersions = primary === 'python' && scope !== 'spot'
      ? scope === 'phone' ? ['concurrent', 'sequential'] : ['concurrent', 'concurrent-deploy']
      : ['candidate-main', 'candidate-deploy'];
    if (scopeLiveControl) {
      pairedCandidateControls = observed.metadata.liveControl.pairedCandidateControls === true;
      const pairedRepeatControls = observed.metadata.liveControl.pairedRepeatControls === true;
      assert.deepEqual(observed.metadata.liveControl, {
        control: '0.17.1', candidateVersions: expectedCandidateVersions,
        alternatingOrderPerRound: true,
        ...(pairedCandidateControls && { pairedCandidateControls: true }),
        ...(pairedRepeatControls && { pairedRepeatControls: true }),
        ...(primary === 'python' && scope !== 'spot' && { pythonWarmSubmitControl: '0.20.1' }),
      });
      if (pairedCandidateControls) {
        assert.ok(scope === 'phone' || scope === 'spot');
        for (const group of observed.metadata.schedule) {
          assert.ok(expectedCandidateVersions.includes(group.pairedControlFor));
          assert.deepEqual(group.versions, ['0.17.1', group.pairedControlFor]);
        }
      }
      if (pairedRepeatControls) {
        assert.equal(scope, 'desktop');
        for (const group of observed.metadata.schedule.filter(isRepeatWarmMode)) {
          assert.ok(expectedCandidateVersions.includes(group.pairedControlFor));
          assert.deepEqual(group.versions, ['0.17.1', group.pairedControlFor]);
        }
      }
    }
    const reference = capture[scope === 'phone' ? 2 : 0].metadata;
    for (const field of ['host', 'browser', 'fixtures', 'appRefs'])
      assert.deepEqual(observed.metadata[field], reference[field], field);
    const liveVersions = observed.metadata.schedule.flatMap(({ versions: groupVersions }) => groupVersions)
      .filter((version) => ['0.17.1', '0.20.1'].includes(version));
    const policyNames = [...new Set([
      ...liveVersions,
      ...required(scope).flatMap(cell => policyFor(scope, cell)),
    ])];
    for (const policy of policyNames) {
      const pkg = observed.metadata.packages[policy];
      const tree = structuredClone(pkg.dependencies);
      const referencePolicy = versions.includes(policy) ? policy : '0.20.1';
      tree.version = referencePolicy;
      assert.deepEqual(tree, reference.packages[referencePolicy].dependencies);
    }
  } catch (error) {
    console.log(JSON.stringify({ scope, unavailable: error.message }));
    summary.incomplete.push(...required(scope));
    continue;
  }
  console.log(JSON.stringify({ scope, packages: Object.fromEntries(Object.entries(observed.metadata.packages)
    .map(([policy, p]) => [policy, { commit: p.commit ?? p.candidate?.commit, sha256: p.sha256 }])),
    refused: observed.samples.filter(row => row.refusal).length,
    invalid: observed.samples.filter(row => row.invalid || row.refusal).length,
    excluded: observed.samples.filter(row => row.excluded).length }));
  for (const cell of required(scope)) {
    const repeatCell = /^(python|csharp)\/(1|4)\/(binary-search|permutations)\/warm\/(repeat|submitAfterRun)/.test(cell);
    const warmCsharp = /^csharp\/1\/(binary-search|permutations)\/warm\/submitVerdicts$/.test(cell);
    const history = Object.fromEntries(versions.map(version => [version, stats(archived.get(cell + '/' + version))]));
    const requiredHistory = repeatCell ? [] : warmCsharp || cell.endsWith('/lessonContinue')
      ? [history['0.20.1']] : Object.values(history);
    assert.ok(repeatCell || requiredHistory.every(row =>
      row.n >= (cell.startsWith('java/') || scope === 'phone' ? 12 : 20)), cell);
    const thresholds = repeatCell ? undefined : scoreThresholds(scope, requiredHistory);
    for (const policy of policyFor(scope, cell)) {
      const result = stats(observed.values.get(cell + '/' + policy));
      const cache = ['java', 'csharp', 'python'].includes(primary)
        ? cacheStats(observed.cacheReceipts.get(cell + '/' + policy),
            cell.endsWith('/submitVerdicts') ? ['ordinary'] : ['ordinary', 'observer'])
        : undefined;
      const complete = result.n === 20;
      const pass = repeatCell ? undefined
        : complete && result.median <= thresholds.median && result.p90 <= thresholds.p90;
      const pythonWarmSubmit = /^python\/1\/(binary-search|permutations)\/warm\/submitVerdicts$/.test(cell);
      const unstablePythonSubmit = primary === 'python' && pythonWarmSubmit;
      const controlVersions = pythonWarmSubmit ? ['0.17.1', '0.20.1'] : ['0.17.1'];
      const controls = controlVersions.map((version) => ({
        version,
        result: stats(observed.values.get(cell + '/' +
          liveObservationVersion(version, pairedCandidateControls || repeatCell ? policy : undefined))),
        frozen: newDesignReferences.get(cell + '/' + version) ?? history[version],
      }));
      const sameWindowComplete = liveControl === true && controls.every(({ result: row }) => row.n === 20);
      const sameWindow = complete && sameWindowComplete
        ? unstablePythonSubmit
          ? (() => {
              const comparator = {
                median: Math.min(...controls.map(({ result: row }) => row.median)),
                p90: Math.min(...controls.map(({ result: row }) => row.p90)),
              };
              const thresholds = { median: comparator.median * 1.05, p90: comparator.p90 * 1.10 };
              return { unstable: true, controls, comparator, thresholds,
                numericalPass: result.median <= thresholds.median && result.p90 <= thresholds.p90 };
            })()
          : liveCellScoreWithControls(result, controls)
        : undefined;
      const id = cell + '/' + policy;
      if (!complete) summary.incomplete.push(id);
      else if (!repeatCell && !pass && scope === 'spot') summary.frozenEscalations.push(id);
      else if (!repeatCell && !pass && primary === 'python' && scope === 'phone') {
        (summary.pythonPhoneFrozen[policy] ??= []).push(id);
      } else if (!repeatCell && !pass) summary.frozenFailed.push(id);
      if (unstablePythonSubmit && complete && sameWindowComplete) summary.unstable.push(id);
      else if (!sameWindowComplete) summary.noComparator.push(id);
      else if (sameWindow && sameWindow.controls.some(({ valid }) => !valid)) summary.controlInvalid.push(id);
      else if (sameWindow && !sameWindow.pass) summary.sameWindowFailed.push(id);
      if (!unstablePythonSubmit && sameWindow?.controls.every(({ valid }) => valid)) {
        const regression = medianRegressionClass(result.median, sameWindow.comparator.median);
        if (regression.classification === 'fix-forward') {
          summary.fixForward.push({ id, medianRatio: regression.ratio });
        } else if (regression.classification === 'record') {
          summary.recordedFiveToTen.push({ id, medianRatio: regression.ratio });
        }
      }
      console.log(JSON.stringify({ scope, cell, policy, result, cache, history,
        frozenTable: repeatCell ? { notApplicable: true, complete } : { thresholds, complete, pass },
        sameWindow: sameWindow ?? { complete: false, controls },
        ...(warmCsharp && { advisory: '0.17.1' }) }));
    }
  }
}
console.log(JSON.stringify({ summary }));
if (summary.incomplete.length || summary.noComparator.length || summary.sameWindowFailed.length ||
  summary.controlInvalid.length) process.exitCode = 1;
