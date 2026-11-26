import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { scoreFinalRelease } from './score-final-release.mjs';

const laterLanguages = ['javascript', 'typescript', 'cpp', 'java'];

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function records(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function writeRecords(path, rows) {
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

async function copySession(from, sourcePrefix, to, targetPrefix, session) {
  const metadata = await json(join(from, `${sourcePrefix}-metadata.json`));
  metadata.sampleSession = session;
  await writeFile(join(to, `${targetPrefix}-metadata.json`), JSON.stringify(metadata, null, 2) + '\n');
  await copyFile(join(from, `${sourcePrefix}-samples.jsonl`),
    join(to, `${targetPrefix}-samples.jsonl`));
}

export async function buildMergedFinalRelease(session1Arg, session2Arg, mergedArg) {
  const session1 = resolve(session1Arg);
  const session2 = resolve(session2Arg);
  const merged = resolve(mergedArg);
  await mkdir(merged, { recursive: false });
  for (const scope of ['phone', 'desktop']) {
    await copySession(session1, `experiment-final-${scope}`, merged,
      `experiment-final-${scope}`, 1);
  }
  await copySession(session1, 'final-csharp-phone', merged, 'final-csharp-phone', 1);

  const oldMetadata = await json(join(session1, 'final-csharp-desktop-metadata.json'));
  const newMetadata = await json(join(session2, 'session2-final-csharp-desktop-metadata.json'));
  assert.equal(oldMetadata.complete, false);
  assert.equal(newMetadata.complete, true);
  assert.equal(newMetadata.schedule.length, 1);
  assert.deepEqual(newMetadata.schedule[0], oldMetadata.schedule[16]);
  assert.deepEqual(newMetadata.packages, oldMetadata.packages);
  const oldRows = (await records(join(session1, 'final-csharp-desktop-samples.jsonl')))
    .filter(({ groupIndex }) => groupIndex < 16);
  const newRows = (await records(join(session2,
    'session2-final-csharp-desktop-samples.jsonl')))
    .map((row) => ({ ...row, groupIndex: 16, sampleSession: 2 }));
  const csharpMetadata = {
    ...oldMetadata,
    complete: true,
    end: newMetadata.end,
    sampleSession: 'merged',
    sessionProvenance: {
      groups0Through15: { session: 1, ended: '2026-11-26T07:49:55Z' },
      group16: { session: 2, sourcePrefix: 'session2-final-csharp-desktop' },
    },
  };
  await writeFile(join(merged, 'final-csharp-desktop-metadata.json'),
    JSON.stringify(csharpMetadata, null, 2) + '\n');
  await writeRecords(join(merged, 'final-csharp-desktop-samples.jsonl'),
    [...oldRows.map((row) => ({ ...row, sampleSession: 1 })), ...newRows]);

  for (const language of laterLanguages) {
    for (const scope of ['phone', 'desktop']) {
      await copySession(session2, `session2-final-${language}-${scope}`, merged,
        `final-${language}-${scope}`, 2);
    }
  }
  return merged;
}

function drift(actual, reference) {
  return {
    median: actual.median / reference.median - 1,
    p90: actual.p90 / reference.p90 - 1,
  };
}

export async function scoreMergedFinalRelease(stageArg, mergedArg, baselineArg, aaScoreArg,
  write = console.log) {
  const collected = [];
  const result = await scoreFinalRelease(stageArg, mergedArg, baselineArg,
    (line) => collected.push(JSON.parse(line)));
  const aaLines = (await readFile(resolve(aaScoreArg), 'utf8')).trim().split('\n')
    .filter(Boolean).map(JSON.parse);
  const aaSummary = aaLines.find(({ summary }) => summary)?.summary;
  assert.equal(aaSummary?.pass, true, 'Session 2 phone A/A did not produce a valid reference');
  const references = new Map(aaSummary.references.map((row) => [row.cell, row]));

  for (const row of result.rows) {
    row.sampleSession = row.language === 'csharp' && row.scope === 'desktop' && row.group === 16 ||
      laterLanguages.includes(row.language) ? 2 : 1;
    if (row.scope === 'phone' && row.cell.includes('/warm/') &&
        ['python', 'csharp'].includes(row.language)) {
      const source = references.get(row.cell);
      assert.ok(source, `Missing session 2 phone reference for ${row.cell}`);
      const control = row.controls.find(({ version }) => version === '0.17.1');
      const controlDrift = drift(control.result, source.reference);
      const valid = Math.abs(controlDrift.median) <= 0.10 && Math.abs(controlDrift.p90) <= 0.10;
      control.reference = source.reference;
      control.drift = { ...controlDrift, valid };
      row.hostCheck = { mode: 'session2-phone-aa', valid, referenceSession: 2,
        drift: controlDrift };
      row.referenceSession = 2;
      row.pass = row.complete && valid && row.medianPass;
    } else {
      row.referenceSession = 'frozen-or-preregistered';
    }
    write(JSON.stringify(row));
  }
  const summary = {
    pass: result.rows.every(({ pass }) => pass),
    candidate: result.summary.candidate,
    rows: result.rows.length,
    passed: result.rows.filter(({ pass }) => pass).length,
    medianFailed: result.rows.filter((row) =>
      row.complete && row.hostCheck.valid && !row.medianPass).map(({ cell }) => cell),
    controlInvalid: result.rows.filter((row) => !row.hostCheck.valid).map(({ cell }) => cell),
    incomplete: result.rows.filter((row) => !row.complete).map(({ cell }) => cell),
    sessions: {
      1: { ended: '2026-11-26T07:49:55Z' },
      2: { includesReference: 'phone-warm-aa' },
    },
  };
  write(JSON.stringify({ summary }));
  return { rows: result.rows, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, session1, session2, merged, baseline, aaScore] = process.argv.slice(2);
  assert.ok(stage && session1 && session2 && merged && baseline && aaScore,
    'Usage: score-final-release-merged.mjs <stage> <session1> <session2> <merged> <baseline> <aa-score>');
  await buildMergedFinalRelease(session1, session2, merged);
  const { summary } = await scoreMergedFinalRelease(stage, merged, baseline, aaScore);
  if (!summary.pass) process.exitCode = 1;
}
