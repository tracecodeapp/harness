import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { languages, releases } from './inputs.mjs';

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

export const m1Bound = (overhead, batch) => overhead <= 5 && 10 * overhead <= 0.1 * batch;
export const m2Regression = (current, control) => current - control >= 50 && current > 1.1 * control;

function m1Cell(rows, canary, language, problem, n) {
  const cell = rows.filter((row) => row.probe === 'm1' && row.language === language &&
    row.problem === problem && row.n === n && row.admissible === true);
  for (const row of cell) {
    assert.ok(row.pair.pass && row.before <= 2 && !row.warmup);
    assert.equal(row.first, row.index % 2 ? 'singleton' : 'batch');
    assert.ok(row.index >= 3);
  }
  assert.equal(cell.length, new Set(cell.map((row) => row.index)).size);
  const enough = canary && cell.length >= min;
  if (!enough) return { count: cell.length, meets: false, complete: false };
  const batch = median(cell.map((row) => row.pair.batch.elapsedMs));
  const overhead = median(cell.map((row) => (row.pair.singleton.elapsedMs - row.pair.batch.elapsedMs) / n));
  const singleton = median(cell.map((row) => row.pair.singleton.elapsedMs / n));
  return { count: cell.length, batch, overhead, singleton, meets: m1Bound(overhead, batch), complete: true };
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
  for (const language of languages) assert.equal(typeof provenance.canaries[language], 'boolean');
  const deciding = languages.map((language) => m1Cell(rows, provenance.canaries[language], language, 'binary-search', 10));
  const fork = deciding.every((cell) => cell.meets)
    ? 'The kernel dispatches each case.'
    : 'The kernel owns case start, finish and deadline as events. The worker keeps its batch loop.';
  const lines = [
    '# M1 and M2 results', '',
    `Probe \`${provenance.probeCommit}\`, P0-C rig \`${provenance.rigCommit}\`, Chromium ${provenance.browser}.`,
    rows.at(-1).probe === 'window-end' ? '' : 'The journal ended before the sampler finished.',
    '', '## M1', '', fork, '',
    '| Cases | N | Language | Pairs | Median batch (ms) | Median paired overhead (ms/case) | Median singleton (ms/case) | Bound |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [problem, n] of [['binary-search', 10], ['binary-search', 100], ['heavy', 10], ['heavy', 100]]) {
    for (const [index, language] of languages.entries()) {
      const cell = problem === 'binary-search' && n === 10 ? deciding[index]
        : m1Cell(rows, provenance.canaries[language], language, problem, n);
      const bound = problem === 'binary-search' && n === 10
        ? (cell.meets ? 'met' : 'not met') : 'information only';
      lines.push(`| ${problem} | ${n} | ${language} | ${cell.count} | ${ms(cell.batch)} | ${ms(cell.overhead)} | ${ms(cell.singleton)} | ${bound} |`);
    }
  }
  lines.push('', 'C# overhead measures dispatch and transport. Both arms use a fresh load context per case.');
  const controls = rows.find((row) => row.probe === 'm1-controls' && row.echoRoundTripMs);
  if (controls) {
    lines.push('', `Desktop worker echo ${ms(median(controls.echoRoundTripMs))} ms per null-payload round trip. Timer arm and cancel ${ms(median(controls.timerArmCancelMs))} ms per timer.`);
  }
  lines.push('', 'The published receipts do not isolate a fresh-state reset from the managed or worker execution. A reset-only cost is unavailable.');
  lines.push('', '## M2', '',
    '| Case | Profile | Version | Admissible | Median total (ms) | Compile (ms) | Case (ms) | Outside (ms) | Cell decision |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
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
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, 'score.mjs samples.jsonl M1-M2-RESULTS.md');
  const rows = (await readFile(input, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  await writeFile(output, score(rows), { flag: 'wx' });
}
