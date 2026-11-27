import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { releases } from './inputs.mjs';
import { informationalM1 } from './window.mjs';

const versions = ['0.21.0', '0.20.1', '0.17.1'];
const profiles = ['desktop', 'phone'];
const caseKeys = ['n-queens/h5', 'open-the-lock/3', 'open-the-lock/h6', 'p0c-heavy'];
const min = 20;

function median(values) {
  assert.ok(values.length && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const m2Regression = (current, control) => current - control >= 50 && current > 1.1 * control;

function m1Cell(rows, canary, language) {
  const { probe, problem, n } = informationalM1;
  const cell = rows.filter((row) => row.probe === probe && row.language === language &&
    row.problem === problem && row.n === n && row.admissible === true);
  for (const row of cell) {
    assert.ok(row.pair.pass && row.before <= 2 && !row.warmup);
    assert.equal(row.first, row.index % 2 ? 'singleton' : 'batch');
    assert.ok(row.index >= 3);
  }
  assert.equal(cell.length, new Set(cell.map((row) => row.index)).size);
  if (!canary || cell.length < min) return { count: cell.length };
  const batch = median(cell.map((row) => row.pair.batch.elapsedMs));
  const overhead = median(cell.map((row) => (row.pair.singleton.elapsedMs - row.pair.batch.elapsedMs) / n));
  const singleton = median(cell.map((row) => row.pair.singleton.elapsedMs / n));
  return { count: cell.length, batch, overhead, singleton };
}

function m2Cell(rows, profile, key) {
  const byVersion = Object.fromEntries(versions.map((version) => {
    const trials = rows.filter((row) => row.probe === 'm2' && row.profile === profile &&
      row.key === key && row.version === version && row.admissible === true);
    for (const row of trials) assert.ok(row.result.pass && row.before <= 2 && !row.warmup);
    assert.equal(trials.length, new Set(trials.map((row) => row.round)).size);
    const phases = ['totalMs', 'compileMs', 'caseMs', 'outsideMs'];
    return [version, {
      count: trials.length,
      ...(trials.length >= min && Object.fromEntries(phases.map((phase) => [
        phase, trials.every((row) => Number.isFinite(row.result[phase]))
          ? median(trials.map((row) => row.result[phase])) : undefined,
      ]))),
    }];
  }));
  const current = byVersion['0.21.0'];
  const control = byVersion['0.20.1'];
  const enough = versions.every((version) => byVersion[version].count >= min);
  return {
    byVersion,
    decision: !enough ? 'undecided' : m2Regression(current.totalMs, control.totalMs) ? 'regression' : 'within bound',
  };
}

const ms = (value) => value === undefined ? '—' : value.toFixed(2);

export function score(rows) {
  const provenance = rows[0];
  assert.equal(provenance.probe, 'window');
  assert.deepEqual(provenance.tarballs, Object.fromEntries(Object.entries(releases).map(([version, { sha256 }]) => [version, sha256])));
  assert.deepEqual(provenance.informationalM1, informationalM1);
  for (const language of informationalM1.languages) assert.equal(typeof provenance.canaries[language], 'boolean');
  const lines = [
    '# M2 and informational M1 window results', '',
    `Probe \`${provenance.probeCommit}\`, P0-C rig \`${provenance.rigCommit}\`, Chromium ${provenance.browser}.`,
    `Browser assets and dry-run receipt from \`${provenance.dryProbeCommit}\`.`,
    rows.at(-1).probe === 'window-end' ? '' : 'The journal ended before the sampler finished.',
    '', '## M2', '',
    '| Case | Profile | Version | Admissible | Median total (ms) | Compile (ms) | Case (ms) | Outside (ms) | Cell decision |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  let regressions = 0;
  const backlog = [];
  for (const profile of profiles) {
    for (const key of caseKeys) {
      const { byVersion, decision } = m2Cell(rows, profile, key);
      if (decision === 'regression') {
        regressions++;
        const candidate = byVersion['0.21.0'];
        const control = byVersion['0.20.1'];
        const phases = ['caseMs', 'outsideMs', 'compileMs'];
        const deltas = phases.map((phase) => candidate[phase] - control[phase]);
        const location = deltas.every(Number.isFinite) && deltas[0] > 0 &&
          deltas[0] >= Math.max(deltas[1], deltas[2])
          ? 'The case phase gained the most time. Investigate the per-case clock and line guard first.'
          : 'The receipt does not support assigning the extra time to the case clock or line guard.';
        backlog.push(`- ${key}, ${profile}. ${location}`);
      }
      for (const version of versions) {
        const row = byVersion[version];
        lines.push(`| ${key} | ${profile} | ${version} | ${row.count} | ${ms(row.totalMs)} | ${ms(row.compileMs)} | ${ms(row.caseMs)} | ${ms(row.outsideMs)} | ${decision} |`);
      }
    }
  }
  if (regressions) {
    lines.push('', `${regressions} cells meet the Python vertical backlog rule.`, '',
      ...backlog, '', 'The dry-run tracemalloc witness returned false, and the measured request uses plain Judge with drawing disabled.');
  }
  lines.push('', '## Informational M1', '',
    'Binary Search, N = 10. These measurements inform the estimate for K0. The recorded design uses kernel-owned case start, finish and deadline events, with worker-owned batch loops.', '',
    '| Language | Admissible pairs | Median batch (ms) | Median paired overhead (ms/case) | Median singleton (ms/case) |',
    '| --- | --- | --- | --- | --- |');
  for (const language of informationalM1.languages) {
    const { count, batch, overhead, singleton } = m1Cell(rows, provenance.canaries[language], language);
    lines.push(`| ${language} | ${count} | ${ms(batch)} | ${ms(overhead)} | ${ms(singleton)} |`);
  }
  lines.push('', 'Medians require 20 admissible pairs. C# overhead measures dispatch and transport. Both arms use a fresh load context per case.');
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, 'score.mjs samples.jsonl M2-INFORMATIONAL-M1-RESULTS.md');
  const rows = (await readFile(input, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  await writeFile(output, score(rows), { flag: 'wx' });
}
