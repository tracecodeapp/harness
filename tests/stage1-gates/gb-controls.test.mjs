import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ledgerFor } from './gb-oracle.mjs';

const { fixtures } = JSON.parse(await readFile(new URL('./gb-fixtures.json', import.meta.url), 'utf8'));

function fixture(language, name) {
  return fixtures.find((row) => row.language === language && row.name === name);
}

function referenceReceipt(fixture) {
  return {
    result: {
      evaluation: {
        status: 'completed',
        compile: { status: 'compiled' },
        cases: fixture.cases.map((row) => ({
          caseId: row.id, expected: row.expected, value: row.actual,
          status: 'completed', verdict: { kind: 'passed' },
          stdout: row.stdout, stderr: '', diagnostics: [],
          termination: { kind: 'exit', exitCode: 0 }, timedOut: false,
        })),
      },
    },
    transcript: [],
  };
}

function requireDetected(fixture, route, sample, check, seed) {
  const state = (value) => ledgerFor(fixture, route, value).receipts.find((row) => row.id.endsWith('/' + check))?.status;
  assert.equal(state(sample), 'passed', check);
  const mutant = structuredClone(sample);
  assert.equal(seed(mutant), 1);
  assert.equal(state(mutant), 'failed', check);
}

test('G4 rejects a transport timeout that overwrites a completed prefix', () => {
  const spec = fixture('python', 'transport');
  requireDetected(spec, 'cut-keep', referenceReceipt(spec), 'A/status', (sample) => {
    const row = sample.result.evaluation.cases[0];
    row.status = 'timed-out';
    row.failure = { origin: 'limit', reason: 'client-timeout', message: 'Seeded timeout' };
    delete row.value;
    return 1;
  });
});

test('G4 rejects replay across generations when A keeps its value', () => {
  const spec = fixture('python', 'transport');
  const sample = referenceReceipt(spec);
  sample.transcript.push({ kind: 'worker-started', caseId: 'A', generation: 1 });
  requireDetected(spec, 'cut-keep', sample, 'A/ordinary-start-count', (mutant) => {
    mutant.transcript.push({ kind: 'dispatch', rows: ['A'], generation: 2 });
    assert.equal(mutant.result.evaluation.cases[0].value, 11);
    return 1;
  });
});

test('G5 rejects observer output written to the judge receipt', () => {
  const spec = fixture('javascript', 'stdout');
  requireDetected(spec, 'run-first', referenceReceipt(spec), 'A/value', (sample) => {
    sample.result.evaluation.cases[0].value = 999;
    return 1;
  });
});

test('G5 rejects an empty success substituted for a typed refusal', () => {
  const spec = fixture('javascript', 'no-recorder');
  const sample = referenceReceipt(spec);
  sample.result.evaluation.cases[0].attachment = { status: 'refused', cause: 'recorder-unavailable', events: [] };
  requireDetected(spec, 'run-first', sample, 'A/provenance', (mutant) => {
    mutant.result.evaluation.cases[0].attachment = { status: 'complete', events: [] };
    return 1;
  });
});

test('the clock fixtures omit custom limits and retain independent row oracles', () => {
  const spec = fixture('python', 'transport');
  assert(!Object.hasOwn(spec, 'limits'));
  assert.deepEqual(spec.cases.map((row) => [row.id, row.input.n, row.actual]), [
    ['A', 11, 11], ['B', 22, 22], ['C', 33, 33],
  ]);
  for (const route of ['clock-virtual', 'clock-real']) {
    assert(spec.routes.includes(route));
    const ledger = ledgerFor(spec, route);
    assert(ledger.expected.some((id) => id.endsWith('/clock/omitted-wall-budget')));
    assert(ledger.expected.some((id) => id.endsWith('/A/ordinary-start-count')));
  }
});

test('the scripted Python transport releases three healthy rows before expiring the production clock', async () => {
  const { installJournal } = await import('./gb-transport.mjs');
  const originalWorker = globalThis.Worker;
  const wire = [];
  globalThis.Worker = class FixtureWorker extends EventTarget {
    postMessage(message) { wire.push(message); }
  };
  const journal = installJournal(fixture('python', 'transport'));
  const expire = [];
  try {
    journal.track('clock-virtual', 'clock-virtual');
    setTimeout(() => expire.push(30000), 30000);
    const worker = new Worker('fixture-worker.js');
    worker.postMessage({
      id: 'batch', type: 'execute-prepared-program-batch',
      payload: {
        mode: 'code', artifact: { isolationProfile: { tier: 'algorithm-fast' } },
        inputBatch: [{ n: 11 }, { n: 22 }, { n: 33 }],
      },
    });
    for (const n of [11, 22, 33]) {
      assert.deepEqual(wire.at(-1).payload.inputBatch, [{ n }]);
      for (const phase of ['started', 'finished']) {
        worker.dispatchEvent(new MessageEvent('message', {
          data: { id: 'batch', type: 'batch-case-progress', payload: { index: 0, phase } },
        }));
      }
      worker.dispatchEvent(new MessageEvent('message', {
        data: { id: 'batch', type: 'execute-result', payload: { resultsStreamed: 1 } },
      }));
    }
    assert.deepEqual(expire, [30000]);
    const events = journal.since(0);
    assert.deepEqual(events.filter((event) => event.kind === 'worker-started').map((event) => event.caseId), ['A', 'B', 'C']);
    assert.deepEqual(events.filter((event) => event.kind === 'advance-clock').map((event) => event.virtualTime), [11000, 22000, 33000]);
  } finally {
    journal.restore();
    globalThis.Worker = originalWorker;
  }
});
