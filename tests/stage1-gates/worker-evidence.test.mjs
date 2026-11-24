import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestMatrix } from './requests.mjs';
import { matchesWorkerReply, replyRowCount, retainedControlTargets } from './worker-evidence.mjs';

test('streamed delivery count requires a trusted, token-matched Python batch terminal', () => {
  const command = { id: 'request', type: 'execute-prepared-program-batch', protocolToken: 'current' };
  const data = { id: command.id, protocolToken: 'current', type: 'execute-result', payload: { resultsStreamed: 2 } };
  const event = { isTrusted: true, data };
  assert.equal(replyRowCount(event, command), 2);
  for (const patch of [
    { id: 'other' }, { protocolToken: 'stale' }, { protocolToken: undefined },
  ]) {
    const forged = { ...event, data: { ...data, ...patch } };
    assert.equal(matchesWorkerReply(forged, command), false);
    assert.equal(replyRowCount(forged, command), undefined);
    assert.equal(replyRowCount({ ...forged, data: { ...forged.data, payload: { results: [{}, {}] } } }, command), undefined);
  }
  assert.equal(replyRowCount({ ...event, isTrusted: false }, command), undefined);
  assert.equal(replyRowCount({ ...event, data: { ...data, type: 'batch-case-progress' } }, command), undefined);
  assert.equal(replyRowCount({ ...event, data: { ...data, payload: { resultsStreamed: 2.5 } } }, command), undefined);
  const legacy = { ...command, protocolToken: undefined };
  assert.equal(replyRowCount(event, legacy), undefined);
  assert.equal(replyRowCount({ ...event, data: { ...data, payload: { results: [{}, {}] } } }, legacy), 2);
});

test('registered stdout mutation targets still include the retained values', () => {
  const requests = requestMatrix(['A', 'B'], { gate: 'G1', language: 'python' });
  const keys = requests.flatMap(({ id, cases }) => cases.map((caseId) => `${id}/${caseId}/value`));
  assert.equal(keys.length, 22);
  assert.deepEqual(retainedControlTargets({ seed: 'stdout-all', keys }, requests, false), []);
  assert.deepEqual(retainedControlTargets({ seed: 'stdout-all', keys }, requests, true),
    ['draw-b/B/value', 'redraw-b/B/value']);
});
