import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCsharpAcknowledgement as check } from './csharp-evidence.mjs';
import { matchesWorkerReply } from './worker-evidence.mjs';

const dispatch = { action: 'command', type: 'execute-prepared-code', mode: 'code', id: 'req', generation: 1,
  reportsStarts: true };
const progress = { action: 'ordinary-start', id: 'req', generation: 1, caseIndex: 0 };
const terminal = { action: 'response', id: 'req', generation: 1, csharpTerminal: true, startedCaseIndexes: [0] };

test('C# ordinary replies need a trusted request token and matching progress', () => {
  const command = { ...dispatch, protocolToken: 'scope-token' };
  const event = { isTrusted: true, data: { id: command.id, protocolToken: command.protocolToken } };
  assert(matchesWorkerReply(event, command));
  assert(!matchesWorkerReply({ ...event, isTrusted: false }, command));
  assert(!matchesWorkerReply({ ...event, data: { ...event.data, protocolToken: 'stale' } }, command));
  assert(!matchesWorkerReply({ ...event, data: { ...event.data, id: 'foreign' } }, command));
  assert(check({ worker: [dispatch, progress, terminal] }, false, 1));
  assert(!check({ worker: [dispatch, progress] }, false, 1));
  assert(!check({ worker: [dispatch, terminal] }, false, 1));
  assert(!check({ worker: [dispatch, progress, { ...terminal, generation: 2 }] }, false, 1));
  assert.throws(() => check({ worker: [dispatch, progress, progress, terminal] }, false, 1));
  assert.throws(() => check({ worker: [dispatch, terminal, progress] }, false, 1));
  assert.throws(() => check({ worker: [dispatch, { ...terminal, startedCaseIndexes: [] }] }, false, 1));
});

test('C# cold draw needs a bound observer terminal and rejects ordinary work', () => {
  const draw = { ...dispatch, type: 'execute-prepared-trace', mode: 'trace', attemptToken: 'attempt', csharpProtocol: true };
  const reply = { ...terminal, startedCaseIndexes: undefined, recorderToken: 'attempt' };
  const attachment = { status: 'drawn', evaluationId: 'eval', workspaceDigest: 'digest', generation: 1 };
  const reported = { evaluation: { cases: [{ caseId: 'A', attachment }] } };
  const journal = ['observer-start', 'observer-end', 'attachment-bind'].map((phase, sequence) => ({
    ...attachment, caseId: 'A', phase, sequence, attemptToken: 'attempt',
  }));
  const sample = { reported, journal, worker: [draw, reply] };
  assert(check(sample, true, 0));
  assert(!check({ ...sample, journal: undefined }, true, 0));
  assert(!check({ ...sample, worker: [draw, { ...reply, recorderToken: 'stale' }] }, true, 0));
  assert(!check({ ...sample, journal: journal.map((event) => ({ ...event, caseId: 'other' })) }, true, 0));
  assert.throws(() => check({ ...sample, worker: [dispatch, draw, reply] }, true, 0));
  assert.throws(() => check({ ...sample, worker: [draw, progress, reply] }, true, 0));
});
