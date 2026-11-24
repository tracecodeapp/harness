import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { javaClosingPlan } from './java-closing.mjs';

const [archive, raw] = process.argv.slice(2);
assert.ok(archive && raw, 'Usage: score-java-closing.mjs <frozen baseline> <java session>');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const records = (path) => readFileSync(path, 'utf8').trim().split(/\n/u).filter(Boolean).map(JSON.parse);
for (const line of readFileSync(new URL('./baseline-results.sha256', import.meta.url), 'utf8').trim().split('\n')) {
  const [expected, file] = line.split(/\s+/, 2);
  const actual = createHash('sha256').update(readFileSync(join(archive, file))).digest('hex');
  assert.equal(actual, expected, `Frozen baseline digest differs for ${file}`);
}

const read = (folder, prefix) => ({
  metadata: json(join(folder, prefix + '-metadata.json')),
  samples: records(join(folder, prefix + '-samples.jsonl')),
});
const closing = read(raw, 'java-closing');
const desktop = read(raw, 's-java-desktop');
const frozenDesktop = read(archive, 'speed-desktop-a-with-topup');
const frozenPhone = read(archive, 'speed-phone');
assert.deepEqual(closing.metadata.schedule, javaClosingPlan);
assert.deepEqual(closing.metadata.javaClosing, {
  target: 20, lessonReference: '0.17.1', pairedCandidateControls: true,
  freshPageSpotLanguages: ['python', 'csharp'], alternatingOrderPerRound: true,
});
assert.equal(closing.metadata.complete, true);

function stats(values = []) {
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  return n ? { n, median: (ordered[Math.floor((n - 1) / 2)] + ordered[Math.floor(n / 2)]) / 2,
    p90: ordered[Math.ceil(0.9 * n) - 1] } : { n };
}
function measured(corpus, match, version, endpoint) {
  const values = corpus.samples.filter((sample) => {
    const group = corpus.metadata.schedule[sample.groupIndex];
    return sample.kept && sample.version === version && Object.entries(match).every(([key, value]) =>
      group[key] === value);
  }).map((sample) => sample.metrics[endpoint]);
  assert.ok(values.every((value) => Number.isFinite(value) && value > 0));
  return stats(values);
}
const drift = (live, reference) => ({
  medianPct: 100 * (live.median / reference.median - 1),
  p90Pct: 100 * (live.p90 / reference.p90 - 1),
});
function verdict(cell, candidate, control, reference) {
  assert.equal(candidate.n, 20, `${cell} candidate incomplete`);
  assert.equal(control.n, 20, `${cell} control incomplete`);
  assert.equal(reference.n, 20, `${cell} host reference incomplete`);
  const hostDrift = drift(control, reference);
  const controlValid = Math.abs(hostDrift.medianPct) <= 10 && Math.abs(hostDrift.p90Pct) <= 10;
  const thresholds = { median: control.median * 1.05, p90: control.p90 * 1.10 };
  const candidatePass = candidate.median <= thresholds.median && candidate.p90 <= thresholds.p90;
  return { cell, candidate, control, reference, hostDrift, controlValid, thresholds,
    candidatePass, formalPass: controlValid && candidatePass };
}

const permMatch = { language: 'java', cpu: 1, problem: 'permutations', state: 'warm', journey: 'submit' };
const permReference = { n: 20, median: 416.39999985694885, p90: 438.80000019073486 };
const rows = ['candidate-main', 'candidate-deploy'].map((policy) => verdict(
  `java/1/permutations/warm/submitVerdicts/${policy}`,
  measured(desktop, permMatch, policy, 'submitVerdicts'),
  measured(desktop, permMatch, '0.17.1', 'submitVerdicts'), permReference));

const lessonMatch = { language: 'java', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'lesson' };
const lessonReference = measured(closing, lessonMatch, '0.17.1', 'lessonContinue');
rows.push(verdict('java/1/binary-search/warm/lessonContinue/candidate-main',
  measured(desktop, lessonMatch, 'candidate-main', 'lessonContinue'),
  measured(desktop, lessonMatch, '0.17.1', 'lessonContinue'), lessonReference));

const reruns = [
  { language: 'java', cpu: 4, policy: 'candidate-main', frozen: frozenPhone },
  { language: 'csharp', cpu: 1, policy: 'candidate-main', frozen: frozenDesktop },
  { language: 'csharp', cpu: 1, policy: 'candidate-deploy', frozen: frozenDesktop },
  { language: 'python', cpu: 1, policy: 'candidate-main', frozen: frozenDesktop },
  { language: 'python', cpu: 1, policy: 'candidate-deploy', frozen: frozenDesktop },
  { language: 'cpp', cpu: 1, policy: 'candidate-deploy', frozen: frozenDesktop },
];
for (const { language, cpu, policy, frozen } of reruns) {
  const match = { language, cpu, problem: 'binary-search', state: 'warm', journey: 'run',
    pairedControlFor: policy };
  const frozenMatch = { language, cpu, problem: 'binary-search', state: 'warm', journey: 'run' };
  for (const endpoint of language === 'java' ? ['verdicts', 'firstTrace'] : ['verdicts']) {
    rows.push(verdict(`${language}/${cpu}/binary-search/warm/${endpoint}/${policy}`,
      measured(closing, match, policy, endpoint), measured(closing, match, '0.17.1', endpoint),
      measured(frozen, frozenMatch, '0.17.1', endpoint)));
  }
}

for (const row of rows) console.log(JSON.stringify({ javaClosing: row }));
console.log(JSON.stringify({ lessonReference: {
  cell: 'java/1/binary-search/warm/lessonContinue', version: '0.17.1',
  oldReference: { n: 0 }, newReference: lessonReference, date: '2026-11-24', reason: 'missing',
} }));
const pass = rows.every(({ formalPass }) => formalPass);
console.log(JSON.stringify({ summary: { pass, failed: rows.filter(({ formalPass }) => !formalPass)
  .map(({ cell }) => cell) } }));
if (!pass) process.exitCode = 1;
