import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { installAppTraceArchive } from './app-trace-archive.mjs';
import { createAppTraceCapture } from './app-trace-wire.mjs';
import { appFixtureAssertionIds, appFixtureName, appSpec } from './requests.mjs';
import { checkPresentation } from './receipt.mjs';

test('app trace evidence streams shared events byte-for-byte outside grade fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ga-app-trace-'));
  let archive;
  const close = await installAppTraceArchive({
    exposeFunction: async (name, callback) => {
      assert.equal(name, 'recordGateTraceChunk');
      archive = callback;
    },
  }, directory);
  try {
    const events = [{ text: 'x'.repeat(256 * 1024 - 10) + '🌱\n' }, { line: 1 }, { text: 'y'.repeat(256 * 1024) }];
    const trace = Object.freeze({ events });
    const ordinary = { kind: 'completed', output: [7], consoleOutput: [] };
    const attachment = { caseId: 's1', workspaceDigest: 'source', evaluationId: '1', generation: 1, status: 'drawn', trace };
    const row = { caseId: 's1', status: 'completed', value: [7], attachment, trace };
    const traced = { ...ordinary, trace, executionTimeMs: 0 };
    const captured = await createAppTraceCapture(JSON.stringify, archive)({
      reported: { evaluation: { cases: [row] } },
      drawnEvaluation: { cases: [row] },
      ordinaryProjections: [ordinary], tracedProjections: [traced], projections: [traced],
    });
    const capturedRow = captured.reported.evaluation.cases[0];
    const count = capturedRow.attachment.trace.events;
    const bytes = events.map((event) => JSON.stringify(event) + '\n').join('');
    assert.equal(count.count, 3);
    assert.equal(count.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(gunzipSync(await readFile(join(directory, 'app-traces', `${count.sha256}.jsonl.gz`))).toString(), bytes);
    assert.equal((await readFile(join(directory, 'app-traces.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.deepEqual(capturedRow.value, [7]);
    assert.deepEqual(capturedRow, captured.drawnEvaluation.cases[0]);
    checkPresentation(capturedRow, ordinary, captured.tracedProjections[0], true, 'source', true);
    assert.throws(() => checkPresentation(capturedRow, ordinary, captured.tracedProjections[0], true, 'source'), /Missing recorded events/);
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsealed or wrong-length trace streams are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ga-app-trace-'));
  let archive;
  const close = await installAppTraceArchive({
    exposeFunction: async (_name, callback) => { archive = callback; },
  }, directory);
  try {
    await archive(1, '{"line":3}\n');
    await assert.rejects(archive(1, null, 2), /event count/i);
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('dynamic app inventory preserves all IDs for the original case sets', async () => {
  const { inventory } = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'));
  for (const spec of appSpec) {
    const name = appFixtureName(spec);
    const fixture = { gate: 'G6', language: 'cpp', name, cases: spec.cases.map((id) => ({ id })) };
    const prefix = `G6/cpp/${name}/`;
    assert.deepEqual(appFixtureAssertionIds(fixture).sort(), inventory.filter((id) => id.startsWith(prefix)).sort());
  }
});
