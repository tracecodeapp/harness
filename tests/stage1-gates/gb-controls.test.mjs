import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function observedReceipt(spec, { route = 'run-first', status = 'drawn', reason, events, attemptedEvents } = {}) {
  const sample = referenceReceipt(spec);
  const binding = { evaluationId: 'evaluation-1', workspaceDigest: 'workspace-1', generation: 1 };
  const row = sample.result.evaluation.cases[0];
  const source = { kind: 'line', line: 2, file: 'solution.py', runId: 'python:run' };
  const trace = {
    schemaVersion: 'runtime-trace-2026-04-28', events: events ?? [source],
  };
  row.attachment = { ...binding, caseId: row.caseId, status, trace, reason, attemptedEvents };
  sample.stimulus = { bundle: { workspaceDigest: binding.workspaceDigest } };
  const add = (kind, fields) => sample.transcript.push({
    kind, request: route, sequence: sample.transcript.length + 1, ...fields,
  });
  const mark = (phase, caseId, fields) => add('schedule', { ...binding, phase, caseId, ...fields });
  add('ordinary-dispatch', { rows: ['A', 'B'], reportsStarts: true });
  add('ordinary-start', { caseId: 'A' });
  mark('observer-start', 'A');
  add('ordinary-start', { caseId: 'B' });
  add('observer-reply', {
    caseId: 'A', schemaVersion: trace.schemaVersion, events: structuredClone(trace.events),
    recorder: { recorderCompleted: true, cut: reason, attemptedEvents: attemptedEvents ?? trace.events.length },
  });
  mark('observer-end', 'A');
  mark('ordinary-write-attempt', 'A');
  mark('ordinary-write-attempt', 'B');
  mark('ordinary-commit');
  mark('attachment-bind', 'A');
  mark('public-resolve');
  return sample;
}

test('G5 reads typed drawing and cuts while rejecting an unknown status with a valid-looking trace', () => {
  const spec = fixture('python', 'stdout');
  requireDetected(spec, 'run-first', observedReceipt(spec), 'A/attachment-status', (sample) => {
    sample.result.evaluation.cases[0].attachment.status = 'unrecognized';
    return 1;
  });
  const cap = fixture('python', 'step-cap');
  const sample = observedReceipt(cap, { status: 'truncated', reason: 'step-budget', attemptedEvents: 2 });
  requireDetected(cap, 'run-first', sample, 'A/attachment-status', (mutant) => {
    mutant.result.evaluation.cases[0].attachment.reason = 'stored-event-budget';
    return 1;
  });
});

test('G5 compares the per-case ordinary ACK counts and rejects second ordinary work on redraw', () => {
  const spec = fixture('python', 'stdout');
  const sample = observedReceipt(spec);
  requireDetected(spec, 'run-first', sample, 'ordinary-start-count', (mutant) => {
    // The total stays the same. A starts twice and B never starts.
    mutant.transcript.find(({ kind, caseId }) => kind === 'ordinary-start' && caseId === 'B').caseId = 'A';
    return 1;
  });
  const redraw = referenceReceipt(spec);
  redraw.result.evaluation.cases = [redraw.result.evaluation.cases[1]];
  redraw.registeredReceiptPath = true;
  redraw.transcript.push({
    kind: 'schedule', phase: 'observation-cache-hit', caseId: 'B', request: 'repeat-B', attemptToken: 'cached-B',
  });
  requireDetected(spec, 'repeat-B', redraw, 'ordinary-start-count', (mutant) => {
    mutant.transcript.push({ kind: 'ordinary-start', caseId: 'B', request: 'repeat-B' });
    return 1;
  });
});

test('G5 requires ordinary commit before bind even when the recorder completes first', () => {
  const spec = fixture('python', 'stdout');
  const sample = observedReceipt(spec);
  requireDetected(spec, 'run-first', sample, 'ordinary-before-observer', (mutant) => {
    const bind = mutant.transcript.find(({ phase }) => phase === 'attachment-bind');
    bind.sequence = 2;
    return 1;
  });
  const ordered = structuredClone(sample);
  const end = ordered.transcript.find(({ phase }) => phase === 'observer-end');
  end.sequence = ordered.transcript.find(({ phase }) => phase === 'ordinary-commit').sequence + 0.5;
  assert.equal(ledgerFor(spec, 'run-first', ordered).receipts
    .find(({ id }) => id.endsWith('/ordinary-before-observer'))?.status, 'passed');
});

test('G5 detects an observer grade write even when the judged row is unchanged', () => {
  const spec = fixture('python', 'stdout');
  requireDetected(spec, 'run-first', observedReceipt(spec), 'observer-grade-writes', (sample) => {
    sample.transcript.find(({ phase }) => phase === 'ordinary-write-attempt').origin = 'observer';
    return 1;
  });
});

test('G5 detects a synthetic drawing with a retained learner anchor', () => {
  const spec = fixture('python', 'stdout');
  const events = [{
    kind: 'stdout', line: 2, file: 'solution.py', text: '7', callStack: [{ function: 'solve', args: { n: 7 } }],
  }];
  requireDetected(spec, 'run-first', observedReceipt(spec, { events }), 'A/recorder-boundary', (sample) => {
    sample.result.evaluation.cases[0].attachment.trace.events.unshift({ kind: 'line', line: 1, file: 'solution.py' });
    return 1;
  });
});

test('G5 rejects a chopped prefix and an empty byte cut with no recorder attempts', () => {
  const step = fixture('python', 'step-cap');
  const events = [1, 2].map((line) => ({ kind: 'line', line, file: 'solution.py' }));
  const stepReceipt = observedReceipt(step, { status: 'truncated', reason: 'step-budget', attemptedEvents: 3, events });
  const extended = [...events, { kind: 'line', line: 3, file: 'solution.py' }];
  const reference = observedReceipt(step, { route: 'run-first:reference', events: extended });
  stepReceipt.prefixReference = { evaluation: reference.result.evaluation };
  stepReceipt.transcript.push(reference.transcript.find(({ kind }) => kind === 'observer-reply'));
  requireDetected(step, 'run-first', stepReceipt, 'A/real-prefix', (sample) => {
    sample.result.evaluation.cases[0].attachment.trace.events.shift();
    return 1;
  });
  requireDetected(step, 'run-first', stepReceipt, 'A/real-prefix', (sample) => {
    // The observer and attachment agree but both lost the first event.
    sample.result.evaluation.cases[0].attachment.trace.events.shift();
    sample.transcript.find(({ kind }) => kind === 'observer-reply').events.shift();
    return 1;
  });
  const byte = fixture('python', 'byte-cap');
  const byteReceipt = observedReceipt(byte, { status: 'truncated', reason: 'byte-budget', attemptedEvents: 1, events: [] });
  requireDetected(byte, 'run-first', byteReceipt, 'A/attempted-events', (sample) => {
    sample.transcript.find(({ kind }) => kind === 'observer-reply').recorder.attemptedEvents = 0;
    return 1;
  });
});

test('G5 leaves absent scheduler and recorder evidence missing', () => {
  const spec = fixture('python', 'stdout');
  const sample = observedReceipt(spec);
  sample.transcript = [];
  const { missing } = ledgerFor(spec, 'run-first', sample);
  for (const id of ['ordinary-before-observer', 'ordinary-start-count', 'observer-grade-writes', 'A/recorder-boundary']) {
    assert(missing.includes(`G5/python/stdout/run-first/${id}`), id);
  }
});

test('the runner refuses stale worker assets even when the old tarball was removed', async () => {
  const job = await mkdtemp(join(tmpdir(), 'gb-stale-subject-'));
  try {
    const consumer = join(job, 'gate-consumer-isolated');
    const marker = join(consumer, '.installed');
    await mkdir(consumer);
    const commit = 'a'.repeat(40);
    const sha = 'b'.repeat(64);
    for (const stale of ['', `${'c'.repeat(40)}\n${sha}\n`, `${commit}\n${'d'.repeat(64)}\n`]) {
      await writeFile(marker, stale);
      const runner = fileURLToPath(new URL('./agent-runner.sh', import.meta.url));
      const run = spawnSync('bash', [runner, 'stale-probe'], {
        cwd: job, encoding: 'utf8', env: {
          ...process.env,
          TRACECODE_STAGE1_SUBJECT: commit,
          TRACECODE_STAGE1_SUBJECT_TARBALL: join(job, 'absent.tgz'),
          TRACECODE_STAGE1_SUBJECT_SHA256: sha,
        },
      });
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /Installed consumer belongs to another or unverified subject/);
      assert.equal(await readFile(marker, 'utf8'), stale);
    }
  } finally {
    await rm(job, { recursive: true, force: true });
  }
});

test('the bridge arms only the intended observer phase, language, and route', async () => {
  const { installJudgeBridge } = await import('./gb-probe.mjs');
  const spec = fixture('javascript', 'observer-encoder-fault');
  const key = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
  const events = [];
  const bridge = installJudgeBridge(spec, { record: (kind, event) => events.push([kind, event]) });
  try {
    const { value, enumerable } = Object.getOwnPropertyDescriptor(globalThis, key);
    assert.equal(enumerable, false);
    bridge.track('run-first');
    assert.equal(value.faultAt({ language: spec.language, point: 'encode', caseId: 'A' }), 'encode');
    assert.equal(value.faultAt({ language: spec.language, point: 'encode', caseId: 'B' }), undefined);
    assert.equal(value.faultAt({ language: 'typescript', point: 'encode', caseId: 'A' }), undefined);
    assert.equal(value.faultAt({ language: spec.language, point: 'observe', caseId: 'A' }), undefined);
    assert.deepEqual(events, []);
    const ack = { phase: 'injection-ack', caseId: 'A', point: 'encode', fault: 'encode' };
    value.onEvent(ack);
    assert.deepEqual(events, [['schedule', ack]]);
    bridge.track('continue-B');
    assert.equal(value.faultAt({ language: spec.language, point: 'encode', caseId: 'A' }), undefined);
  } finally {
    bridge.restore();
  }
  assert.equal(Object.hasOwn(globalThis, key), false);
});

test('the G5 scheduler codec rejects a deadline ACK from a stale observation attempt', () => {
  const spec = { ...fixture('python', 'stdout'), name: 'observer-deadline' };
  const sample = observedReceipt(spec);
  const row = sample.result.evaluation.cases[0];
  const { evaluationId, workspaceDigest, generation, caseId } = row.attachment;
  row.attachment = { evaluationId, workspaceDigest, generation, caseId, status: 'refused', reason: 'observer-timeout' };
  sample.transcript.find(({ phase }) => phase === 'attachment-bind').attemptToken = 'attempt-a';
  sample.transcript.push({
    kind: 'schedule', phase: 'injection-ack', fault: 'deadline', point: 'observe', language: spec.language,
    evaluationId, workspaceDigest, generation, caseId, attemptToken: 'attempt-a', request: 'run-first', sequence: 6.5,
  });
  for (const assertion of ['A/injection-ack', 'A/provenance']) {
    requireDetected(spec, 'run-first', sample, assertion, (mutant) => {
      mutant.transcript.at(-1).attemptToken = 'stale-attempt';
      return 1;
    });
  }
});
