#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Language } from '../packages/runtime-core/src/runtime-types';

const FIXTURES_DIR = join(process.cwd(), 'fixtures', 'runtime-parity');

interface FixtureCase {
  id: string;
  knownGaps?: Partial<Record<Language, Record<string, string>>>;
}

interface KnownGapRecord {
  fixture: string;
  language: Language;
  role: string;
  reason: string;
}

async function readKnownGaps(): Promise<KnownGapRecord[]> {
  const fixtureNames = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const gaps: KnownGapRecord[] = [];

  for (const fixtureName of fixtureNames) {
    const fixture = JSON.parse(
      await readFile(join(FIXTURES_DIR, fixtureName, 'case.json'), 'utf8')
    ) as FixtureCase;

    for (const [language, gapsByRole] of Object.entries(fixture.knownGaps ?? {})) {
      for (const [role, reason] of Object.entries(gapsByRole ?? {})) {
        gaps.push({
          fixture: fixture.id,
          language: language as Language,
          role,
          reason,
        });
      }
    }
  }

  return gaps;
}

async function readFixtureCount(): Promise<number> {
  return (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .length;
}

function groupByLanguage(gaps: KnownGapRecord[]): Map<Language, KnownGapRecord[]> {
  const grouped = new Map<Language, KnownGapRecord[]>();
  for (const gap of gaps) {
    grouped.set(gap.language, [...(grouped.get(gap.language) ?? []), gap]);
  }
  return grouped;
}

function gapCategory(gap: KnownGapRecord): string {
  const reason = gap.reason.toLowerCase();
  if (reason.includes('loop index') || reason.includes('loop element')) {
    return 'java-local-snapshot-completeness';
  }
  if (reason.includes('stdout') || reason.includes('console output')) {
    return 'stdout-line-events';
  }
  if (reason.includes('exception') || reason.includes('throw')) {
    return 'caught-exception-events';
  }
  if (reason.includes('object field') || reason.includes('field read') || reason.includes('field write')) {
    return 'object-field-access-events';
  }
  if (
    reason.includes('map.') ||
    reason.includes('dict ') ||
    reason.includes('set.') ||
    reason.includes('set membership') ||
    reason.includes('keyed')
  ) {
    return 'keyed-container-access-events';
  }
  if (reason.includes('indexed') || reason.includes('nested array') || reason.includes('cell write')) {
    return 'indexed-access-events';
  }
  if (reason.includes('mutation') || reason.includes('mutate') || reason.includes('immutable input')) {
    return 'collection-mutation-events';
  }
  if (reason.includes('caller locals')) {
    return 'call-frame-snapshot-isolation';
  }
  return 'other';
}

function groupByCategory(gaps: KnownGapRecord[]): Map<string, KnownGapRecord[]> {
  const grouped = new Map<string, KnownGapRecord[]>();
  for (const gap of gaps) {
    const category = gapCategory(gap);
    grouped.set(category, [...(grouped.get(category) ?? []), gap]);
  }
  return grouped;
}

async function main(): Promise<void> {
  const gaps = await readKnownGaps();
  const fixtureCount = await readFixtureCount();
  console.log(`runtime trace fixture corpus: ${fixtureCount}`);
  console.log(`runtime trace known gaps: ${gaps.length}`);

  const grouped = groupByLanguage(gaps);
  for (const language of [...grouped.keys()].sort()) {
    const records = grouped.get(language) ?? [];
    console.log(`\n${language}: ${records.length}`);
    for (const record of records) {
      console.log(`- ${record.fixture}/${record.role}: ${record.reason}`);
    }
  }

  const byCategory = groupByCategory(gaps);
  console.log('\nGap clusters:');
  for (const category of [...byCategory.keys()].sort()) {
    const records = byCategory.get(category) ?? [];
    console.log(`- ${category}: ${records.length}`);
  }
}

test('report runtime trace known gaps', main);
