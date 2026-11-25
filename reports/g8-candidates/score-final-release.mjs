import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertExactHistoricalPackage } from './java-runner/version-preparation.mjs';

const languages = ['javascript', 'typescript', 'python', 'cpp', 'java', 'csharp'];

function quantiles(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return { n: 0 };
  return {
    n: ordered.length,
    median: (ordered[Math.floor((ordered.length - 1) / 2)] +
      ordered[Math.floor(ordered.length / 2)]) / 2,
    p90: ordered[Math.ceil(ordered.length * 0.9) - 1],
  };
}

function metricsFor(group) {
  if (group.journey === 'run') return [
    group.pythonWarmMode === 'repeat-run' || group.csharpWarmMode === 'repeat-run'
      ? 'repeatVerdicts' : 'verdicts',
    group.pythonWarmMode === 'repeat-run' || group.csharpWarmMode === 'repeat-run'
      ? 'repeatFirstTrace' : 'firstTrace',
    ...(group.continuation ? [group.pythonWarmMode === 'repeat-run' ||
      group.csharpWarmMode === 'repeat-run' ? 'repeatSecondTrace' : 'secondTrace'] : []),
  ];
  if (group.journey === 'lesson') return ['lessonContinue'];
  return [group.pythonWarmMode === 'submit-after-run' ||
    group.csharpWarmMode === 'submit-after-run'
    ? 'submitAfterRunVerdicts' : 'submitVerdicts'];
}

function cell(group, metric) {
  return [group.language, group.cpu, group.problem, group.state, metric].join('/');
}

function candidate(group) {
  const candidates = group.versions.filter((version) =>
    version.startsWith('candidate-') || version === 'final-main');
  assert.equal(candidates.length, 1);
  return candidates[0];
}

function countRows(rows, version, predicate) {
  return rows.filter((row) => row.version === version && predicate(row)).length;
}

function groupSlices(group, rows) {
  if (group.language !== 'python' || group.journey !== 'lesson') {
    return [{ mode: undefined, rows }];
  }
  let previousVersion;
  const classified = [...rows].sort((a, b) => a.sampleStarted.localeCompare(b.sampleStarted))
    .map((row) => {
      const mode = previousVersion === row.version
        ? 'straight-after-own-sample' : 'standby-ready';
      if (row.initial) previousVersion = row.version;
      return { ...row, lessonMode: mode };
    });
  return ['standby-ready', 'straight-after-own-sample'].map((mode) => ({
    mode,
    rows: classified.filter((row) => row.lessonMode === mode),
  }));
}

function drift(actual, reference) {
  if (!reference?.n || !actual?.n) return undefined;
  const median = actual.median / reference.median - 1;
  const p90 = actual.p90 / reference.p90 - 1;
  return { median, p90, valid: Math.abs(median) <= 0.10 && Math.abs(p90) <= 0.10 };
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function records(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function baselineReferences(archive) {
  const receipt = (await readFile(new URL('./baseline-results.sha256', import.meta.url), 'utf8'))
    .trim().split('\n').map((line) => line.trim().split(/\s+/, 2));
  for (const [expected, file] of receipt) {
    const actual = createHash('sha256').update(await readFile(join(archive, file))).digest('hex');
    assert.equal(actual, expected, `Frozen baseline digest differs for ${file}`);
  }
  const references = new Map();
  for (const prefix of ['speed-desktop-a-with-topup', 'speed-desktop-b', 'speed-phone']) {
    const metadata = await json(join(archive, `${prefix}-metadata.json`));
    const samples = await records(join(archive, `${prefix}-samples.jsonl`));
    for (const [groupIndex, group] of metadata.schedule.entries()) {
      for (const metric of metricsFor(group)) {
        for (const version of group.versions) {
          const values = samples.filter((row) => row.groupIndex === groupIndex &&
            row.version === version && row.kept).map((row) => row.metrics?.[metric]);
          if (values.length) references.set(`${cell(group, metric)}/${version}`, quantiles(values));
        }
      }
    }
  }
  return references;
}

async function extraReferences(stage, references) {
  const newDesign = await json(new URL('./new-design-host-check-references.json', import.meta.url));
  for (const row of newDesign.rows) references.set(`${row.cell}/${row.version}`, row.reference);
  const rerecorded = await json(new URL('./host-check-references.json', import.meta.url));
  for (const row of rerecorded.rows) references.set(`${row.cell}/${row.version}`, row.newReference);

  for (const [directory, prefix] of [
    ['python-fresh-aa', 'python-fresh-aa'],
    ['submit-aa', 'submit-aa'],
  ]) {
    let metadata;
    let samples;
    try {
      metadata = await json(join(stage, directory, `${prefix}-metadata.json`));
      samples = await records(join(stage, directory, `${prefix}-samples.jsonl`));
    } catch {
      continue;
    }
    const pooled = new Map();
    for (const sample of samples.filter((row) => row.kept)) {
      const group = metadata.schedule[sample.groupIndex];
      const source = group.submitAaSourceVersion ?? '0.17.1';
      for (const [metric, value] of Object.entries(sample.metrics ?? {})) {
        const key = `${cell(group, metric)}/${source}`;
        if (!pooled.has(key)) pooled.set(key, []);
        pooled.get(key).push(value);
      }
    }
    for (const [key, values] of pooled) references.set(key, quantiles(values));
  }
}

async function loadSession(out, language, scope) {
  const prefix = language === 'python'
    ? `experiment-final-${scope}` : `final-${language}-${scope}`;
  const metadata = await json(join(out, `${prefix}-metadata.json`));
  const samples = await records(join(out, `${prefix}-samples.jsonl`));
  assert.equal(metadata.complete, true, `${prefix} did not complete`);
  assert.equal(metadata.seed, 212026);
  assert.equal(metadata.loadThreshold, 2);
  if (language === 'python') {
    assert.equal(metadata.liveControl.control, '0.17.1');
    assert.deepEqual(metadata.liveControl.candidateVersions, ['final-main']);
  } else {
    assert.equal(metadata.finalRelease.medianRatioLimit, 1.10);
    assert.equal(metadata.finalRelease.p90Gate, false);
  }
  assertExactHistoricalPackage('0.17.1', metadata.packages['0.17.1']);
  if (metadata.packages['0.20.1']) {
    assertExactHistoricalPackage('0.20.1', metadata.packages['0.20.1']);
  }
  return { metadata, samples, prefix };
}

export async function scoreFinalRelease(stageArg, outArg, archiveArg, write = console.log) {
  const stage = resolve(stageArg);
  const out = resolve(outArg);
  const archive = resolve(archiveArg);
  const references = await baselineReferences(archive);
  await extraReferences(stage, references);
  const rows = [];
  let candidateIdentity;

  for (const language of languages) {
    for (const scope of ['phone', 'desktop']) {
      const session = await loadSession(out, language, scope);
      const candidatePackages = Object.entries(session.metadata.packages)
        .filter(([version]) => version.startsWith('candidate-') || version === 'final-main')
        .map(([, pkg]) => ({ commit: pkg.commit ?? pkg.candidate?.commit, sha256: pkg.sha256 }));
      for (const identity of candidatePackages) {
        candidateIdentity ??= identity;
        assert.deepEqual(identity, candidateIdentity, 'Final candidate identity differs between cells');
      }
      for (const [groupIndex, group] of session.metadata.schedule.entries()) {
        const groupRows = session.samples.filter((row) => row.groupIndex === groupIndex);
        const candidateVersion = candidate(group);
        for (const { mode, rows: measuredRows } of groupSlices(group, groupRows)) {
        for (const metric of metricsFor(group)) {
          const values = (version) => quantiles(measuredRows.filter((row) =>
            row.version === version && row.kept).map((row) => row.metrics?.[metric]));
          const candidateStats = values(candidateVersion);
          const controls = group.versions.filter((version) =>
            ['0.17.1', '0.20.1'].includes(version)).map((version) => {
              const result = values(version);
              const reference = mode ? undefined :
                references.get(`${cell(group, metric)}/${version}`);
              return { version, result, reference, drift: drift(result, reference) };
            });
          const comparator = controls.reduce((best, control) =>
            !best || control.result.median < best.result.median ? control : best, undefined);
          const complete = mode
            ? candidateStats.n > 0 && controls.every(({ result }) => result.n > 0)
            : candidateStats.n === group.target && controls.every(({ result }) =>
              result.n === group.target);
          const unstablePythonSubmit = language === 'python' && scope === 'desktop' &&
            group.state === 'warm' && group.journey === 'submit' &&
            !group.pythonWarmMode?.includes('after');
          const directHostValid = controls.every(({ drift: row }) => row?.valid === true);
          const result = {
            language, scope, group: groupIndex,
            cell: cell(group, metric) + (mode ? `/${mode}` : ''), metric,
            ...(mode && { mode }),
            candidateVersion, candidate: candidateStats, controls,
            comparator: comparator?.result,
            medianLimit: comparator?.result?.median * 1.10,
            p90Ratio: comparator?.result?.p90
              ? candidateStats.p90 / comparator.result.p90 : undefined,
            complete,
            hostCheck: unstablePythonSubmit
              ? { mode: 'other-python-warm-cells', valid: undefined }
              : directHostValid
                ? { mode: 'direct', valid: true }
                : controls.some(({ reference }) => reference)
                  ? { mode: 'direct', valid: false }
                  : { mode: 'same-session-sibling', valid: undefined },
            invalid: Object.fromEntries(group.versions.map((version) => [version,
              countRows(measuredRows, version, (row) => Boolean(row.invalid || row.refusal))])),
            excluded: Object.fromEntries(group.versions.map((version) => [version,
              countRows(measuredRows, version, (row) => Boolean(row.excluded))])),
          };
          result.medianPass = complete && candidateStats.median <= result.medianLimit;
          rows.push(result);
        }
        }
      }
    }
  }

  const siblingHealth = new Map();
  for (const language of languages) {
    for (const scope of ['phone', 'desktop']) {
      const direct = rows.filter((row) => row.language === language && row.scope === scope &&
        row.hostCheck.mode === 'direct');
      siblingHealth.set(`${language}/${scope}`,
        direct.length > 0 && direct.every((row) => row.hostCheck.valid));
    }
  }
  for (const row of rows) {
    if (row.hostCheck.valid === undefined) {
      row.hostCheck.valid = siblingHealth.get(`${row.language}/${row.scope}`) === true;
    }
    row.pass = row.complete && row.hostCheck.valid && row.medianPass;
    write(JSON.stringify(row));
  }
  const summary = {
    pass: rows.every((row) => row.pass),
    candidate: candidateIdentity,
    rows: rows.length,
    passed: rows.filter((row) => row.pass).length,
    medianFailed: rows.filter((row) => row.complete && row.hostCheck.valid && !row.medianPass)
      .map((row) => row.cell),
    controlInvalid: rows.filter((row) => !row.hostCheck.valid).map((row) => row.cell),
    incomplete: rows.filter((row) => !row.complete).map((row) => row.cell),
  };
  write(JSON.stringify({ summary }));
  return { rows, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, out, archive] = process.argv.slice(2);
  assert.ok(stage && out && archive,
    'Usage: score-final-release.mjs <stage> <output> <frozen baseline>');
  const { summary } = await scoreFinalRelease(stage, out, archive);
  if (!summary.pass) process.exitCode = 1;
}
