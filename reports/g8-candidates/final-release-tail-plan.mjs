import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const tailSessions = [
  { language: 'csharp', scope: 'desktop', groups: 1, originalOffset: 16,
    estimatedMinutesPerGroup: 2.73 },
  { language: 'java', scope: 'phone', groups: 4, estimatedMinutesPerGroup: 2.27 },
  { language: 'java', scope: 'desktop', groups: 13, estimatedMinutesPerGroup: 1.93 },
  { language: 'cpp', scope: 'phone', groups: 4, estimatedMinutesPerGroup: 3.04 },
  { language: 'cpp', scope: 'desktop', groups: 13, estimatedMinutesPerGroup: 2.24 },
  { language: 'typescript', scope: 'phone', groups: 4, estimatedMinutesPerGroup: 0.92 },
  { language: 'typescript', scope: 'desktop', groups: 13, estimatedMinutesPerGroup: 0.50 },
  { language: 'javascript', scope: 'phone', groups: 4, estimatedMinutesPerGroup: 0.97 },
  { language: 'javascript', scope: 'desktop', groups: 13, estimatedMinutesPerGroup: 0.42 },
];

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function optionalRecords(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function completeGroup(group, rows, groupIndex) {
  return group.versions.every((version) =>
    rows.filter((row) => row.groupIndex === groupIndex && row.version === version && row.kept)
      .length === group.target);
}

export async function buildTailPlan(session2Arg) {
  const session2 = resolve(session2Arg);
  const sessions = [];
  for (const descriptor of tailSessions) {
    const prefix = `session2-final-${descriptor.language}-${descriptor.scope}`;
    const metadata = await optionalJson(join(session2, `${prefix}-metadata.json`));
    const rows = await optionalRecords(join(session2, `${prefix}-samples.jsonl`));
    if (metadata) {
      assert.equal(metadata.schedule.length, descriptor.groups,
        `${prefix} schedule changed after preflight`);
    }
    const groups = Array.from({ length: descriptor.groups }, (_, scheduleIndex) => ({
      scheduleIndex,
      originalGroupIndex: scheduleIndex + (descriptor.originalOffset ?? 0),
    })).filter(({ scheduleIndex }) =>
      !metadata || !completeGroup(metadata.schedule[scheduleIndex], rows, scheduleIndex));
    sessions.push({ ...descriptor, prefix: `session3-final-${descriptor.language}-${descriptor.scope}`,
      groups, estimatedMinutes: groups.length * descriptor.estimatedMinutesPerGroup });
  }
  const estimatedMinutes = sessions.reduce((sum, session) => sum + session.estimatedMinutes, 0);
  return {
    schema: 'tracecode.speed-final-tail.v1',
    sourceSession: 2,
    sampleSession: 3,
    sessions,
    estimatedMinutes,
    capMinutes: Math.ceil(estimatedMinutes * 1.3 + 5),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [session2, output] = process.argv.slice(2);
  assert.ok(session2 && output,
    'Usage: final-release-tail-plan.mjs <session2-directory> <output.json>');
  const plan = await buildTailPlan(session2);
  await writeFile(resolve(output), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ estimatedMinutes: plan.estimatedMinutes,
    capMinutes: plan.capMinutes, remainingGroups: plan.sessions.reduce((n, s) => n + s.groups.length, 0) }));
}
