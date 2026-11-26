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
  const session3 = join(root, 'three');
  const session4 = join(root, 'four');
  const merged = join(root, 'merged');
  await Promise.all([import('node:fs/promises').then(({ mkdir }) => mkdir(session1)),
    import('node:fs/promises').then(({ mkdir }) => mkdir(session2)),
    import('node:fs/promises').then(({ mkdir }) => mkdir(session3)),
    import('node:fs/promises').then(({ mkdir }) => mkdir(session4))]);
  const packageSet = { '0.17.1': { sha256: 'old' }, 'candidate-main': { sha256: 'new' } };
  const schedule = Array.from({ length: 17 }, (_, group) =>
    ({ group, target: 1, versions: ['0.17.1', 'candidate-main'] }));
  for (const scope of ['phone', 'desktop']) {
    await session(session1, `experiment-final-${scope}`, { complete: true, schedule: [] });
  }
  await session(session1, 'final-csharp-phone', { complete: true, schedule: [] });
  await session(session1, 'final-csharp-desktop',
    { complete: false, schedule, packages: packageSet }, [
      ...Array.from({ length: 16 }, (_, groupIndex) => schedule[groupIndex].versions.map((version) =>
        ({ groupIndex, version, kept: true }))).flat(),
      { groupIndex: 16, version: '0.17.1', invalid: 'old incomplete row' },
    ]);
  await session(session2, 'session2-final-csharp-desktop',
    { complete: true, schedule: [schedule[16]], packages: packageSet, end: 'later' },
    schedule[16].versions.map((version) => ({ groupIndex: 0, version, kept: true })));
  for (const language of ['javascript', 'typescript', 'cpp', 'java']) {
    for (const scope of ['phone', 'desktop']) {
      if (language === 'java' && scope === 'phone') {
        const javaSchedule = Array.from({ length: 3 }, (_, groupIndex) =>
          ({ groupIndex, target: 1, versions: ['0.17.1', 'candidate-main'] }));
        await session(session2, 'session2-final-java-phone',
          { complete: false, schedule: javaSchedule, packages: packageSet }, [
            ...javaSchedule[0].versions.map((version) =>
              ({ groupIndex: 0, version, kept: true })),
            { groupIndex: 1, version: '0.17.1', kept: true },
          ]);
        await session(session3, 'session3-final-java-phone',
          { complete: true, schedule: [{ ...javaSchedule[1], sourceGroupIndex: 1 }],
            packages: packageSet },
          javaSchedule[1].versions.map((version) => ({ groupIndex: 0, version, kept: true })));
        await session(session4, 'session4-final-java-phone',
          { complete: true, schedule: [{ ...javaSchedule[2], sourceGroupIndex: 2 }],
            packages: packageSet },
          javaSchedule[2].versions.map((version) => ({ groupIndex: 0, version, kept: true })));
        continue;
      }
      await session(session2, `session2-final-${language}-${scope}`,
        { complete: true, schedule: [], packages: packageSet });
    }
  }

  await buildMergedFinalRelease(session1, session2, merged, session3, session4);
  const metadata = JSON.parse(await readFile(
    join(merged, 'final-csharp-desktop-metadata.json'), 'utf8'));
  const rows = (await readFile(join(merged, 'final-csharp-desktop-samples.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  assert.equal(metadata.complete, true);
  assert.equal(rows.filter(({ sampleSession }) => sampleSession === 1).length, 32);
  assert.equal(rows.filter(({ groupIndex, sampleSession }) =>
    groupIndex === 16 && sampleSession === 2).length, 2);
  assert.equal(metadata.sessionProvenance.groups[16].session, 2);
  const javaRows = (await readFile(join(merged, 'final-java-phone-samples.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  assert.equal(javaRows.filter(({ groupIndex, sampleSession }) =>
    groupIndex === 0 && sampleSession === 2).length, 2);
  assert.equal(javaRows.filter(({ groupIndex, sampleSession }) =>
    groupIndex === 1 && sampleSession === 3).length, 2);
  assert.equal(javaRows.filter(({ groupIndex, sampleSession }) =>
    groupIndex === 2 && sampleSession === 4).length, 2);
});

test('merge rejects two complete sessions for the same original group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g8-merge-duplicate-'));
  const one = join(root, 'one');
  const two = join(root, 'two');
  const three = join(root, 'three');
  const merged = join(root, 'merged');
  await Promise.all([one, two, three].map((directory) =>
    import('node:fs/promises').then(({ mkdir }) => mkdir(directory))));
  const packages = { '0.17.1': { sha256: 'old' }, 'candidate-main': { sha256: 'new' } };
  const group = { target: 1, versions: ['0.17.1', 'candidate-main'] };
  for (const scope of ['phone', 'desktop']) {
    await session(one, `experiment-final-${scope}`, { complete: true, schedule: [] });
  }
  await session(one, 'final-csharp-phone', { complete: true, schedule: [] });
  const csharpSchedule = Array.from({ length: 17 }, () => group);
  await session(one, 'final-csharp-desktop',
    { complete: false, schedule: csharpSchedule, packages },
    Array.from({ length: 16 }, (_, groupIndex) => group.versions.map((version) =>
      ({ groupIndex, version, kept: true }))).flat());
  for (const [directory, prefix, sourceGroupIndex] of [
    [two, 'session2-final-csharp-desktop', undefined],
    [three, 'session3-final-csharp-desktop', 16],
  ]) {
    await session(directory, prefix,
      { complete: true, schedule: [{ ...group, ...(sourceGroupIndex !== undefined &&
        { sourceGroupIndex }) }], packages },
      group.versions.map((version) => ({ groupIndex: 0, version, kept: true })));
  }
  await assert.rejects(buildMergedFinalRelease(one, two, merged, three),
    /group 16 must have exactly one complete session/u);
});
