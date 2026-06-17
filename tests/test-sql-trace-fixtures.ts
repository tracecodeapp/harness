#!/usr/bin/env npx tsx

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { assertValidSqlTrace, type SqlTrace } from '../packages/harness-sql/src/index';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sql-traces');

const EXPECTED_EVENT_KINDS: Record<string, string[]> = {
  'api-transaction-rollback.json': ['transaction', 'statement', 'error', 'transaction'],
  'exec-batch.json': ['batch', 'statement', 'statement'],
  'exec-failure.json': ['batch', 'error'],
  'explain-estimate-plan.json': ['statement', 'result', 'plan'],
  'explicit-sql-transaction.json': ['batch', 'statement', 'transaction', 'statement', 'transaction'],
  'privacy-none.json': ['statement', 'result'],
  'query.json': ['statement', 'result'],
};

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const files = (await readdir(FIXTURE_DIR)).filter((file) => file.endsWith('.json')).sort();
  assertCondition(files.length === Object.keys(EXPECTED_EVENT_KINDS).length, 'SQL fixture corpus should match expected fixture list');

  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(FIXTURE_DIR, file), 'utf8')) as SqlTrace;
    assertValidSqlTrace(fixture, file);
    const kinds = fixture.events.map((event) => event.kind);
    const expectedKinds = EXPECTED_EVENT_KINDS[file];
    assertCondition(Boolean(expectedKinds), `Unexpected SQL fixture ${file}`);
    assertCondition(
      kinds.join(',') === expectedKinds.join(','),
      `${file} event kinds should be ${expectedKinds.join(',')}, received ${kinds.join(',')}`
    );
  }

  console.log(`PASS: ${files.length} SQL trace fixtures validate against the public contract`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
