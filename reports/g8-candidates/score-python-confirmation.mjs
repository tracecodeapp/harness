import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function quantiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
  };
}

export function classifyLessonModes(samples) {
  let previousVersion;
  return [...samples].sort((a, b) => a.sampleStarted.localeCompare(b.sampleStarted))
    .map((sample) => {
      const lessonMode = previousVersion === sample.version
        ? 'straight-after-own-sample' : 'standby-ready';
      if (sample.initial) previousVersion = sample.version;
      return { ...sample, lessonMode };
    });
}

export function scorePair(control, candidate) {
  if (!control || !candidate) return { complete: false, pass: false };
  const medianLimit = control.median * 1.10;
  const p90Limit = control.p90 * 1.10;
  return {
    complete: true,
    medianLimit,
    p90Limit,
    medianRatio: candidate.median / control.median,
    p90Ratio: candidate.p90 / control.p90,
    pass: candidate.median <= medianLimit && candidate.p90 <= p90Limit,
  };
}

function metricRows(samples, group, groupIndex) {
  const rows = samples.filter((sample) => sample.groupIndex === groupIndex);
  if (group.journey !== 'lesson') return [{ mode: undefined, rows }];
  const classified = classifyLessonModes(rows);
  return ['standby-ready', 'straight-after-own-sample'].map((mode) => ({
    mode,
    rows: classified.filter((row) => row.lessonMode === mode),
  }));
}

function invalidCount(rows, version) {
  return rows.filter((sample) => sample.version === version &&
    (sample.invalid || sample.refusal)).length;
}

function excludedCount(rows, version) {
  return rows.filter((sample) => sample.version === version && sample.excluded).length;
}

export async function scoreConfirmation(outArg, write = console.log) {
  const out = resolve(outArg);
  const results = [];
  let failed = false;
  for (const experiment of ['sprime-phone', 'sprime-desktop']) {
    const metadata = JSON.parse(await readFile(join(out, `experiment-${experiment}-metadata.json`)));
    const text = await readFile(join(out, `experiment-${experiment}-samples.jsonl`), 'utf8');
    const samples = text.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(metadata.packages.sprime.candidate.commit,
      '2ddacad971e8def9c41668ccfc5d070870c98681');
    if (!metadata.complete) failed = true;
    for (const [groupIndex, group] of metadata.schedule.entries()) {
      for (const { mode, rows } of metricRows(samples, group, groupIndex)) {
        const metricNames = [...new Set(rows.flatMap((sample) =>
          Object.keys(sample.metrics ?? {})))].sort();
        for (const metric of metricNames) {
          const control = quantiles(rows.filter((sample) =>
            sample.version === '0.17.1' && sample.kept)
            .map((sample) => sample.metrics?.[metric]));
          const candidate = quantiles(rows.filter((sample) =>
            sample.version === 'sprime' && sample.kept)
            .map((sample) => sample.metrics?.[metric]));
          const scored = scorePair(control, candidate);
          const expected = mode ? undefined : group.target;
          const complete = scored.complete && (mode
            ? control.n > 0 && candidate.n > 0
            : control.n === expected && candidate.n === expected);
          const candidateRows = rows.filter((sample) =>
            sample.version === 'sprime' && sample.kept);
          const journalValid = candidateRows.every((sample) => {
            const receipt = sample.sequentialJournal;
            return receipt && receipt.verdictWorker === receipt.ordinaryPrepareWorker &&
              receipt.verdictWorker === receipt.observerPrepareWorker &&
              receipt.verdictWorker === receipt.observerExecuteWorker &&
              receipt.finishedCases > 0;
          });
          const row = {
            experiment,
            scope: experiment.endsWith('phone') ? 'phone' : 'desktop',
            group: groupIndex,
            problem: group.problem,
            state: group.state,
            journey: group.journey,
            mode: mode ?? group.pythonWarmMode ?? 'standard',
            metric,
            complete,
            control,
            candidate,
            ...scored,
            journalValid,
            invalid: {
              control: invalidCount(rows, '0.17.1'),
              candidate: invalidCount(rows, 'sprime'),
            },
            excluded: {
              control: excludedCount(rows, '0.17.1'),
              candidate: excludedCount(rows, 'sprime'),
            },
          };
          row.pass = complete && scored.pass && journalValid;
          if (!row.pass) failed = true;
          results.push(row);
          write(JSON.stringify(row));
        }
      }
    }
  }
  write(JSON.stringify({ summary: {
    pass: !failed,
    rows: results.length,
    passed: results.filter(({ pass }) => pass).length,
    failed: results.filter(({ pass }) => !pass).length,
  } }));
  return { failed, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out] = process.argv.slice(2);
  assert.ok(out, 'Usage: score-python-confirmation.mjs <staged output>');
  const { failed } = await scoreConfirmation(out);
  if (failed) process.exitCode = 1;
}
