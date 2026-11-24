// Report only the endpoints the frozen runner actually observed. Exit
// unsuccessfully for missing samples or a threshold miss in a required cell.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [metadataPath, samplesPath, policy] = process.argv.slice(2);
assert.ok(metadataPath && samplesPath && ['concurrent', 'sequential'].includes(policy));
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const samples = (await readFile(samplesPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const quantiles = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
  };
};

let missed = !metadata.complete;
for (const [index, group] of metadata.schedule.entries()) {
  if (!group.versions.includes(policy)) continue;
  const endpoints = group.journey === 'run'
    ? ['verdicts', 'firstTrace', ...(group.continuation ? ['secondTrace'] : [])]
    : [group.journey === 'lesson' ? 'lessonContinue' : 'submitVerdicts'];
  const rows = samples.filter((sample) => sample.groupIndex === index);
  for (const endpoint of endpoints) {
    const results = Object.fromEntries(group.versions.map((version) => [version, quantiles(rows
      .filter((sample) => sample.version === version && sample.kept && sample.beforeInitial?.oneMinute <= 2)
      .map((sample) => sample.metrics[endpoint])
      .filter((value) => Number.isFinite(value) && value >= 0))]));
    const candidate = results[policy];
    const baselines = group.versions
      .filter((version) => version === '0.17.1' || version === '0.20.1')
      .map((version) => results[version]);
    const enough = candidate?.n === group.target && baselines.length > 0 &&
      baselines.every((baseline) => baseline?.n === group.target);
    const thresholds = enough
      ? { median: Math.min(...baselines.map((row) => row.median)), p90: 1.10 * Math.min(...baselines.map((row) => row.p90)) }
      : null;
    const pass = enough && candidate.median <= thresholds.median && candidate.p90 <= thresholds.p90;
    if (!pass) missed = true;
    console.log(JSON.stringify({
      group: index, language: group.language, cpu: group.cpu, problem: group.problem,
      state: group.state, endpoint, pass, thresholds, results,
      invalid: rows.filter((sample) => sample.invalid || sample.refusal).length,
      excluded: rows.filter((sample) => sample.excluded).length,
      workerOverlap: rows.filter((sample) => sample.kept && sample.workerOverlap).length,
    }));
  }
}
if (missed) process.exitCode = 1;
