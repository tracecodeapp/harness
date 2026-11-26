import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildMergedFinalRelease } from './score-final-release-merged.mjs';

async function session(root, prefix, metadata, rows = []) {
  await writeFile(join(root, `${prefix}-metadata.json`), JSON.stringify(metadata));
  await writeFile(join(root, `${prefix}-samples.jsonl`),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test('merge preserves session 1 cells and replaces only incomplete C# group 16', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g8-merge-'));
  const session1 = join(root, 'one');
  const session2 = join(root, 'two');
  const merged = join(root, 'merged');
  await Promise.all([import('node:fs/promises').then(({ mkdir }) => mkdir(session1)),
    import('node:fs/promises').then(({ mkdir }) => mkdir(session2))]);
  const packageSet = { '0.17.1': { sha256: 'old' }, 'candidate-main': { sha256: 'new' } };
  const schedule = Array.from({ length: 17 }, (_, group) => ({ group, target: 20 }));
  for (const scope of ['phone', 'desktop']) {
    await session(session1, `experiment-final-${scope}`, { complete: true, schedule: [] });
  }
  await session(session1, 'final-csharp-phone', { complete: true, schedule: [] });
  await session(session1, 'final-csharp-desktop',
    { complete: false, schedule, packages: packageSet }, [
      { groupIndex: 0, kept: true },
      { groupIndex: 15, kept: true },
      { groupIndex: 16, invalid: 'old incomplete row' },
    ]);
  await session(session2, 'session2-final-csharp-desktop',
    { complete: true, schedule: [schedule[16]], packages: packageSet, end: 'later' },
    [{ groupIndex: 0, kept: true }]);
  for (const language of ['javascript', 'typescript', 'cpp', 'java']) {
    for (const scope of ['phone', 'desktop']) {
      await session(session2, `session2-final-${language}-${scope}`,
        { complete: true, schedule: [] });
    }
  }

  await buildMergedFinalRelease(session1, session2, merged);
  const metadata = JSON.parse(await readFile(
    join(merged, 'final-csharp-desktop-metadata.json'), 'utf8'));
  const rows = (await readFile(join(merged, 'final-csharp-desktop-samples.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  assert.equal(metadata.complete, true);
  assert.deepEqual(rows.map(({ groupIndex, sampleSession }) => ({ groupIndex, sampleSession })), [
    { groupIndex: 0, sampleSession: 1 },
    { groupIndex: 15, sampleSession: 1 },
    { groupIndex: 16, sampleSession: 2 },
  ]);
});
