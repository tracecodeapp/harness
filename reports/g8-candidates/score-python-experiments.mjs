import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [outArg] = process.argv.slice(2);
assert.ok(outArg, 'Usage: score-python-experiments.mjs <staged output>');
const out = resolve(outArg);

function quantiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
  };
}

let failed = false;
for (const experiment of ['e1', 'e2', 'ed1']) {
  const metadata = JSON.parse(await readFile(join(out, `experiment-${experiment}-metadata.json`)));
  const samples = (await readFile(join(out, `experiment-${experiment}-samples.jsonl`), 'utf8'))
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  if (!metadata.complete) failed = true;
  for (const [groupIndex, group] of metadata.schedule.entries()) {
    const rows = samples.filter((sample) => sample.groupIndex === groupIndex);
    const metricNames = [...new Set(rows.flatMap((sample) => Object.keys(sample.metrics ?? {})))].sort();
    for (const metric of metricNames) {
      const results = Object.fromEntries(group.versions.map((version) => [version, quantiles(rows
        .filter((sample) => sample.version === version && sample.kept)
        .map((sample) => sample.metrics?.[metric]))]));
      const control = results['0.17.1'];
      for (const version of group.versions.filter((value) => value !== '0.17.1')) {
        const candidate = results[version];
        const complete = candidate?.n === group.target &&
          (metric === 'receiptSnapshot' || control?.n === group.target);
        if (!complete) failed = true;
        console.log(JSON.stringify({
          experiment,
          group: groupIndex,
          problem: group.problem,
          state: group.state,
          mode: group.pythonWarmMode ?? 'standard',
          metric,
          version,
          complete,
          control,
          candidate,
          ...(control && candidate && {
            medianPct: (candidate.median / control.median - 1) * 100,
            p90Pct: (candidate.p90 / control.p90 - 1) * 100,
          }),
          invalid: rows.filter((sample) => sample.version === version &&
            (sample.invalid || sample.refusal)).length,
          excluded: rows.filter((sample) => sample.version === version && sample.excluded).length,
        }));
      }
    }
  }
}
if (failed) process.exitCode = 1;
