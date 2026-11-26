import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildTailPlan, tailSessions } from './final-release-tail-plan.mjs';

test('tail selects only groups that did not reach target on both versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g8-tail-plan-'));
  await mkdir(join(root, 'two'));
  const descriptor = tailSessions.find(({ language, scope }) =>
    language === 'java' && scope === 'phone');
  const schedule = Array.from({ length: descriptor.groups }, (_, groupIndex) => ({
    groupIndex, target: 2, versions: ['0.17.1', 'candidate-main'],
  }));
  const rows = [];
  for (const groupIndex of [0, 1]) {
    for (const version of schedule[groupIndex].versions) {
      rows.push({ groupIndex, version, kept: true }, { groupIndex, version, kept: true });
    }
  }
  rows.push({ groupIndex: 2, version: '0.17.1', kept: true });
  const prefix = 'session2-final-java-phone';
  await writeFile(join(root, 'two', `${prefix}-metadata.json`), JSON.stringify({ schedule }));
  await writeFile(join(root, 'two', `${prefix}-samples.jsonl`),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  const plan = await buildTailPlan(join(root, 'two'));
  const javaPhone = plan.sessions.find(({ language, scope }) =>
    language === 'java' && scope === 'phone');
  assert.deepEqual(javaPhone.groups, [
    { scheduleIndex: 2, originalGroupIndex: 2 },
    { scheduleIndex: 3, originalGroupIndex: 3 },
  ]);
  assert.equal(plan.sampleSession, 3);
  assert.equal(plan.capMinutes, Math.ceil(plan.estimatedMinutes * 1.3 + 5));
});

test('missing sessions select every group and C# retains original group 16', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g8-tail-empty-'));
  const plan = await buildTailPlan(root);
  const csharp = plan.sessions[0];
  assert.deepEqual(csharp.groups, [{ scheduleIndex: 0, originalGroupIndex: 16 }]);
  assert.equal(plan.sessions.reduce((sum, session) => sum + session.groups.length, 0), 69);
});
