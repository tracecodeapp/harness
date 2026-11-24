import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pythonProductionControlOutcome,
  pythonProductionControlWorker,
} from './python-production-control-witness.mjs';

function journal(worker = 1, cases = 10) {
  return [
    { worker, role: 'ordinary', phase: 'send', type: 'prepare-program', mode: 'code' },
    { worker, role: 'ordinary', phase: 'send', type: 'execute-prepared-program-batch',
      mode: 'code', cases, tier: 'algorithm-fast' },
    { worker, role: 'observer', phase: 'send', type: 'prepare-program',
      mode: 'trace', observation: true },
    { worker, role: 'observer', phase: 'send', type: 'execute-prepared-program',
      mode: 'trace', observation: true, tier: 'algorithm-fast' },
  ];
}

test('accepts the published one-worker ordinary and observer path', () => {
  assert.equal(pythonProductionControlOutcome({ workerJournal: journal() }, 'run', 10), undefined);
  const submit = journal().filter(({ role }) => role !== 'observer');
  assert.equal(pythonProductionControlOutcome({ workerJournal: submit }, 'submit', 10), undefined);
  const click = journal().filter(({ role, type }) =>
    role === 'observer' && type === 'execute-prepared-program');
  assert.equal(pythonProductionControlOutcome({ workerJournal: click }, 'click', 1), undefined);
});

test('rejects per-case restart, split observer and missing stopping batch', () => {
  const restarted = journal();
  restarted.splice(1, 1, ...Array.from({ length: 10 }, (_, index) => ({
    worker: index + 1, role: 'ordinary', phase: 'send',
    type: 'execute-prepared-program', mode: 'code', tier: 'algorithm-fast',
  })));
  assert.equal(pythonProductionControlOutcome({ workerJournal: restarted }, 'run', 10),
    'Published Python single-worker witness differs');

  const split = journal();
  split[3].worker = 2;
  assert.equal(pythonProductionControlOutcome({ workerJournal: split }, 'run', 10),
    'Published Python single-worker witness differs');

  const noCases = journal();
  delete noCases[1].cases;
  assert.equal(pythonProductionControlOutcome({ workerJournal: noCases }, 'run', 10),
    'Published Python single-worker witness differs');
});

test('accepts the published legacy trace batch and rejects legacy per-case restart', () => {
  const prepared = { worker: 7, role: 'legacy-trace', type: 'prepare-program',
    mode: 'trace', tier: 'algorithm-fast', received: 10 };
  const batch = { worker: 7, role: 'legacy-trace', type: 'execute-prepared-program-batch',
    mode: 'trace', tier: 'algorithm-fast', cases: 10, received: 20 };
  assert.equal(pythonProductionControlOutcome([prepared, batch], 'run', 10), undefined);

  const restarted = [prepared,
    { ...batch, worker: 8, type: 'execute-prepared-program', cases: undefined },
    { ...batch, worker: 9, type: 'execute-prepared-program', cases: undefined }];
  assert.equal(pythonProductionControlOutcome(restarted, 'run', 10),
    'Published Python single-worker witness differs');
});

test('accepts published legacy single and batch continuations on the original worker', () => {
  const click = { worker: 7, role: 'legacy-trace', type: 'execute-prepared-program',
    mode: 'trace', tier: 'algorithm-fast', received: 20 };
  const batch = { ...click, type: 'execute-prepared-program-batch', cases: 1 };
  assert.equal(pythonProductionControlOutcome([click], 'click', 1, 7), undefined);
  assert.equal(pythonProductionControlOutcome([batch], 'click', 1, 7), undefined);
  assert.equal(pythonProductionControlOutcome([{ ...batch, worker: 8 }], 'click', 1, 7),
    'Published Python single-worker witness differs');
  assert.equal(pythonProductionControlOutcome([click, { ...click, worker: 8 }], 'click', 1, 7),
    'Published Python single-worker witness differs');
});

test('extracts one positive production worker and rejects ambiguous identities', () => {
  const command = { worker: 7, role: 'legacy-trace', type: 'prepare-program', received: 10 };
  assert.equal(pythonProductionControlWorker([command]), 7);
  assert.equal(pythonProductionControlWorker([command, { ...command, worker: 8 }]), undefined);
});
