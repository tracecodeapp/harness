import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  await writeRecords(join(to, `${targetPrefix}-samples.jsonl`),
    (await records(join(from, `${sourcePrefix}-samples.jsonl`)))
      .map((row) => ({ ...row, sampleSession: session })));
}

async function optionalSource(directory, prefix, session) {
  if (!directory) return undefined;
  try {
    return { directory, prefix, session,
      metadata: await json(join(directory, `${prefix}-metadata.json`)),
      rows: await records(join(directory, `${prefix}-samples.jsonl`)) };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function sourceGroupIndex(source, localIndex, originalOffset = 0) {
  return source.metadata.schedule[localIndex].sourceGroupIndex ?? localIndex + originalOffset;
}

function completeSourceGroup(source, localIndex) {
  const group = source.metadata.schedule[localIndex];
  return group.versions.every((version) => source.rows.filter((row) =>
    row.groupIndex === localIndex && row.version === version && row.kept).length === group.target);
}

async function mergeGroupSessions({ sources, schedule, targetPrefix, merged, originalOffset = 0 }) {
  const packages = sources.find(Boolean)?.metadata.packages;
  for (const source of sources.filter(Boolean)) assert.deepEqual(source.metadata.packages, packages);
  const outputRows = [];
  const provenance = {};
  for (let originalGroupIndex = 0; originalGroupIndex < schedule.length; originalGroupIndex++) {
    const match = sources.filter(Boolean).map((source) => {
      const localIndex = source.metadata.schedule.findIndex((_, index) =>
        sourceGroupIndex(source, index, source.session === 1 ? 0 : originalOffset) === originalGroupIndex);
      return { source, localIndex };
    }).find(({ source, localIndex }) => localIndex >= 0 && completeSourceGroup(source, localIndex));
    assert.ok(match, `${targetPrefix} group ${originalGroupIndex} has no complete session`);
    const { source, localIndex } = match;
    provenance[originalGroupIndex] = { session: source.session, sourcePrefix: source.prefix };
    outputRows.push(...source.rows.filter((row) => row.groupIndex === localIndex)
      .map((row) => ({ ...row, groupIndex: originalGroupIndex, sampleSession: source.session })));
  }
  const latest = sources.filter(Boolean).at(-1)?.metadata;
  const metadata = { ...latest, schedule, packages, complete: true, sampleSession: 'merged',
    sessionProvenance: { groups: provenance } };
  await writeFile(join(merged, `${targetPrefix}-metadata.json`),
    JSON.stringify(metadata, null, 2) + '\n');
  await writeRecords(join(merged, `${targetPrefix}-samples.jsonl`), outputRows);
}

export async function buildMergedFinalRelease(session1Arg, session2Arg, mergedArg, session3Arg) {
  const session1 = resolve(session1Arg);
  const session2 = resolve(session2Arg);
  const session3 = session3Arg ? resolve(session3Arg) : undefined;
  const merged = resolve(mergedArg);
  await mkdir(merged, { recursive: false });
  for (const scope of ['phone', 'desktop']) {
    await copySession(session1, `experiment-final-${scope}`, merged,
      `experiment-final-${scope}`, 1);
  }
  await copySession(session1, 'final-csharp-phone', merged, 'final-csharp-phone', 1);

  const csharpOld = await optionalSource(session1, 'final-csharp-desktop', 1);
  const csharpTwo = await optionalSource(session2, 'session2-final-csharp-desktop', 2);
  const csharpThree = await optionalSource(session3, 'session3-final-csharp-desktop', 3);
  assert.equal(csharpOld.metadata.complete, false);
  await mergeGroupSessions({ sources: [csharpOld, csharpTwo, csharpThree],
    schedule: csharpOld.metadata.schedule, targetPrefix: 'final-csharp-desktop', merged,
    originalOffset: 16 });

  for (const language of laterLanguages) {
    for (const scope of ['phone', 'desktop']) {
      const two = await optionalSource(session2, `session2-final-${language}-${scope}`, 2);
      const three = await optionalSource(session3, `session3-final-${language}-${scope}`, 3);
      assert.ok(two || three, `Missing ${language}/${scope} from Sessions 2 and 3`);
      const schedule = two?.metadata.schedule ?? [...three.metadata.schedule]
        .sort((a, b) => a.sourceGroupIndex - b.sourceGroupIndex)
        .map(({ sourceGroupIndex: _, ...group }) => group);
      await mergeGroupSessions({ sources: [two, three], schedule,
        targetPrefix: `final-${language}-${scope}`, merged });
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

  const sessionMetadata = new Map();
  for (const language of ['python', 'csharp', ...laterLanguages]) {
    for (const scope of ['phone', 'desktop']) {
      const prefix = language === 'python' ? `experiment-final-${scope}` : `final-${language}-${scope}`;
      sessionMetadata.set(`${language}/${scope}`, await json(join(resolve(mergedArg),
        `${prefix}-metadata.json`)));
    }
  }
  for (const row of result.rows) {
    const metadata = sessionMetadata.get(`${row.language}/${row.scope}`);
    row.sampleSession = metadata.sampleSession === 'merged'
      ? metadata.sessionProvenance.groups[row.group].session : metadata.sampleSession;
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
      ...(result.rows.some(({ sampleSession }) => sampleSession === 3) &&
        { 3: { source: 'final-release-tail' } }),
    },
  };
  write(JSON.stringify({ summary }));
  return { rows: result.rows, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, session1, session2, merged, baseline, aaScore, session3] = process.argv.slice(2);
  assert.ok(stage && session1 && session2 && merged && baseline && aaScore,
    'Usage: score-final-release-merged.mjs <stage> <session1> <session2> <merged> <baseline> <aa-score>');
  await buildMergedFinalRelease(session1, session2, merged, session3);
  const { summary } = await scoreMergedFinalRelease(stage, merged, baseline, aaScore);
  if (!summary.pass) process.exitCode = 1;
}
