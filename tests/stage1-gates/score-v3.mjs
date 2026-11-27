import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = JSON.parse(readFileSync(new URL('./v3-cpp-known-gaps.json', import.meta.url), 'utf8'));
const known = new Set(baseline.ids);
assert.equal(known.size, 377);
assert(baseline.ids.every((id) => !id.includes('/deferred/')));

export function scoreV3(cell, exitCode, report) {
  assert.match(cell, /^(ga|gb)-(cpp|csharp|java|javascript|python|typescript)$/u);
  assert([0, 1].includes(exitCode), 'Cell must finish with a gate exit code');
  const ga = cell.startsWith('ga-');
  const failed = ga ? report.failed : report.phases.flatMap(({ receipts }) =>
    receipts.filter(({ status }) => status === 'failed').map(({ id }) => id));
  const otherFailures = ga ? report.missing.length + report.controlFailures.length :
    report.checks.missing + report.notes.filter(({ error }) => error).length +
      report.controls.filter(({ status }) => status !== 'caught').length;
  assert.equal(new Set(failed).size, failed.length, 'Repeated failure ID');
  if (!ga) assert.equal(failed.length, report.checks.failed, 'GB failures disagree with its ledger');
  const eligible = cell.endsWith('-cpp') ? known : new Set();
  const accepted = failed.filter((id) => eligible.has(id));
  const unexpectedFailures = failed.filter((id) => !eligible.has(id));
  const inventoryErrors = report.unexpected.length + report.repeated.length + otherFailures;
  const clean = failed.length === 0 && inventoryErrors === 0;
  const pass = inventoryErrors === 0 && unexpectedFailures.length === 0 && (exitCode === 0) === clean;
  return { pass, accepted, unexpectedFailures, inventoryErrors };
}

function main([path, rawExit]) {
  const load = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const { cell } = load(join(path, 'input.json'));
  const jobId = readFileSync(join(path, 'job-id'), 'utf8').trim();
  const receipts = join(path, 'receipts');
  const reports = cell.id.startsWith('ga-') ? ['summary.json'] :
    readdirSync(receipts).filter((name) => /^gb-[a-f0-9-]+\.json$/u.test(name));
  assert.equal(reports.length, 1);
  const score = scoreV3(cell.id, Number(rawExit), load(join(receipts, reports[0])));
  console.log(JSON.stringify({ cell: cell.id, jobId, ...score }));
  process.exitCode = score.pass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
