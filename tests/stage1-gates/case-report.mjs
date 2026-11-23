import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('Usage: case-report.mjs EVIDENCE_DIRECTORY');
const normal = (value) => value?.['$gate.undefined'] ? undefined : value;

function summarizeValue(value) {
  if (!Array.isArray(value)) return value;
  if (value.length <= 20) return value;
  return { kind: 'array', length: value.length, first: value[0], last: value.at(-1) };
}

const rows = [];
for await (const line of createInterface({ input: createReadStream(join(directory, 'observations.jsonl')), crlfDelay: Infinity })) {
  const observation = JSON.parse(line);
  const { fixture, route, request, control, wallMs } = observation;
  if (!fixture || !request) continue;
  const evaluation = normal(observation.reported)?.evaluation;
  rows.push({
    fixture, route: route ?? 'default', request, control, wallMs,
    skip: normal(observation.skip), error: normal(observation.error)?.message,
    evaluation: evaluation?.status,
    compile: evaluation?.compile && {
      status: evaluation.compile.status,
      failure: normal(evaluation.compile.failure),
      diagnostics: evaluation.compile.diagnostics,
    },
    cases: evaluation?.cases.map((row) => ({
      id: row.caseId,
      status: row.status,
      verdict: row.verdict.kind,
      valuePresent: Object.hasOwn(row, 'value') && normal(row.value) !== undefined,
      value: summarizeValue(normal(row.value)),
      failure: normal(row.failure),
      notRun: normal(row.notRun),
      diagnostics: row.diagnostics,
      traceEvents: normal(row.trace)?.events?.length,
    })),
  });
}
await writeFile(join(directory, 'case-report.json'), JSON.stringify(rows, null, 2) + '\n');
