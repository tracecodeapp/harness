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

export async function buildTailPlan(session2Arg, session3Arg) {
  const session2 = resolve(session2Arg);
  const session3 = session3Arg ? resolve(session3Arg) : undefined;
  const sourceSessions = [
    { directory: session2, session: 2 },
    ...(session3 ? [{ directory: session3, session: 3 }] : []),
  ];
  const sampleSession = session3 ? 4 : 3;
  const sessions = [];
  for (const descriptor of tailSessions) {
    const sources = await Promise.all(sourceSessions.map(async ({ directory, session }) => {
      const prefix = `session${session}-final-${descriptor.language}-${descriptor.scope}`;
      const metadata = await optionalJson(join(directory, `${prefix}-metadata.json`));
      const rows = await optionalRecords(join(directory, `${prefix}-samples.jsonl`));
      return { session, prefix, metadata, rows };
    }));
    for (const { prefix, metadata } of sources) {
      if (metadata) assert.ok(metadata.schedule.length <= descriptor.groups,
        `${prefix} schedule exceeds the accepted design`);
    }
    const groups = Array.from({ length: descriptor.groups }, (_, scheduleIndex) => ({
      scheduleIndex,
      originalGroupIndex: scheduleIndex + (descriptor.originalOffset ?? 0),
    })).filter(({ originalGroupIndex }) => {
      const complete = sources.filter(({ session, metadata, rows }) => {
        if (!metadata) return false;
        const localIndex = metadata.schedule.findIndex((group, index) =>
          (group.sourceGroupIndex ?? index + (session === 2 ? descriptor.originalOffset ?? 0 : 0)) ===
            originalGroupIndex);
        return localIndex >= 0 && completeGroup(metadata.schedule[localIndex], rows, localIndex);
      });
      assert.ok(complete.length <= 1,
        `${descriptor.language}/${descriptor.scope}/${originalGroupIndex} has duplicate complete sources`);
      return complete.length === 0;
    });
    sessions.push({ ...descriptor,
      prefix: `session${sampleSession}-final-${descriptor.language}-${descriptor.scope}`,
      groups, estimatedMinutes: groups.length * descriptor.estimatedMinutesPerGroup });
  }
  const estimatedMinutes = sessions.reduce((sum, session) => sum + session.estimatedMinutes, 0);
  return {
    schema: 'tracecode.speed-final-tail.v1',
    sourceSessions: sourceSessions.map(({ session }) => session),
    sampleSession,
    sessions,
    estimatedMinutes,
    capMinutes: Math.ceil(estimatedMinutes * 1.3 + 5),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [session2, output, session3] = process.argv.slice(2);
  assert.ok(session2 && output,
    'Usage: final-release-tail-plan.mjs <session2-directory> <output.json> [session3-directory]');
  const plan = await buildTailPlan(session2, session3);
  await writeFile(resolve(output), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ estimatedMinutes: plan.estimatedMinutes,
    capMinutes: plan.capMinutes, remainingGroups: plan.sessions.reduce((n, s) => n + s.groups.length, 0) }));
}
