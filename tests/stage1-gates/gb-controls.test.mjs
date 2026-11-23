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

test('an encoder injection ACK needs a preceding anchored recorder reply for the boundary cell', () => {
  const spec = fixture('javascript', 'observer-encoder-fault');
  const events = [{
    kind: 'stdout', line: spec.anchor, file: 'solution.js', text: '7',
    callStack: [{ function: 'solve', args: { n: 7 } }],
  }];
  const sample = observedReceipt(spec, { events });
  const row = sample.result.evaluation.cases[0];
  const { evaluationId, workspaceDigest, generation, caseId } = row.attachment;
  row.attachment = { evaluationId, workspaceDigest, generation, caseId, status: 'refused', reason: 'observer-encode' };
  const workerReply = sample.transcript.find(({ kind }) => kind === 'observer-reply');
  workerReply.drawing = { status: 'drawn', trace: { schemaVersion: workerReply.schemaVersion, events } };
  sample.transcript.find(({ phase }) => phase === 'attachment-bind').attemptToken = 'attempt-a';
  sample.transcript.push({
    kind: 'schedule', phase: 'injection-ack', fault: 'encode', point: 'encode', language: spec.language,
    evaluationId, workspaceDigest, generation, caseId, attemptToken: 'attempt-a', request: 'run-first', sequence: 6.5,
  });
  requireDetected(spec, 'run-first', sample, 'A/recorder-boundary', (mutant) => {
    mutant.transcript.find(({ kind }) => kind === 'observer-reply').drawing.trace.events[0].text = 'wrong';
    return 1;
  });
  sample.transcript = sample.transcript.filter(({ kind }) => kind !== 'observer-reply');
  const report = ledgerFor(spec, 'run-first', sample);
  assert(report.missing.includes('G5/javascript/observer-encoder-fault/run-first/A/recorder-boundary'));
  assert(report.receipts.some(({ id, status }) => id.endsWith('/A/injection-ack') && status === 'passed'));
});

test('C++ collects only correlated ordinary starts and observer attempts', async () => {
  const { installJournal } = await import('./gb-transport.mjs');
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class FixtureWorker {
    addEventListener(_, listener) { this.listener = listener; }
    postMessage() {}
    reply(data, isTrusted = true) { this.listener({ data, isTrusted }); }
  };
  const journal = installJournal(fixture('cpp', 'stdout'));
  try {
    journal.track('run-all');
    const worker = new Worker('fixture-worker.js');
    const batch = {
      id: 'batch', protocolToken: 'batch-token', type: 'execute-prepared-runtime-program-batch',
      payload: { mode: 'code', reportCaseProgress: true, inputBatch: [{ n: 7 }, { n: 11 }] },
    };
    worker.postMessage(batch);
    const start = {
      id: batch.id, protocolToken: batch.protocolToken, type: 'runtime-progress',
      payload: { stage: 'ordinary-case-started', detail: { caseIndex: 0 } },
    };
    worker.reply({ ...start, protocolToken: 'wrong-token' });
    worker.reply(start, false);
    worker.reply(start);
    worker.reply({ ...start, payload: { ...start.payload, detail: { caseIndex: 1 } } });
    worker.reply({ id: batch.id, protocolToken: batch.protocolToken, type: batch.type, payload: {} });
    worker.reply(start); // A progress packet after the command is closed cannot count.
    assert.deepEqual(journal.since(0).filter(({ kind }) => kind === 'ordinary-start').map(({ caseId }) => caseId), ['A', 'B']);

    const observe = {
      id: 'draw', protocolToken: 'draw-token', type: 'execute-prepared-runtime-program',
      payload: { mode: 'trace', inputs: { n: 7 }, attemptToken: 'attempt-1' },
    };
    const reply = {
      id: observe.id, protocolToken: observe.protocolToken, type: observe.type,
      payload: {
        trace: { schemaVersion: 'runtime-trace-2026-04-28', events: [] },
        observation: { attemptToken: 'attempt-1', recorderCompleted: true, cut: 'byte-budget', attemptedEvents: 1 },
      },
    };
    worker.postMessage(observe);
    worker.reply({ ...reply, payload: { ...reply.payload, observation: { ...reply.payload.observation, attemptToken: 'wrong-attempt' } } });
    assert.equal(journal.since(0).filter(({ kind }) => kind === 'observer-reply').length, 0);
    worker.postMessage(observe);
    worker.reply(reply);
    const receipts = journal.since(0).filter(({ kind }) => kind === 'observer-reply');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].caseId, 'A');
    assert.deepEqual(receipts[0].recorder, reply.payload.observation);
    assert.deepEqual(receipts[0].events, []);
  } finally {
    journal.restore();
    globalThis.Worker = originalWorker;
  }
});

test('G4 B console preserves the ordinary limit line and same-guard singleton text', () => {
  const spec = fixture('javascript', 'three-rows');
  const sample = referenceReceipt(spec);
  const row = sample.result.evaluation.cases[1];
  const message = 'SES algorithm execution exceeded 4000ms.';
  const reason = 'client-timeout';
  row.status = 'timed-out';
  row.failure = { origin: 'limit', reason };
  row.stderr = message + '\n';
  row.diagnostics = [{ severity: 'error', code: reason, message }];
  sample.singletonGuard = reason;
  sample.singletonStderr = row.stderr;

  requireDetected(spec, 'submit-omitted', sample, 'B/console', (mutant) => {
    mutant.result.evaluation.cases[1].stderr = '';
    return 1;
  });
  requireDetected(spec, 'submit-omitted', sample, 'B/console', (mutant) => {
    const other = mutant.result.evaluation.cases[1];
    other.diagnostics[0].message = 'A different timeout message.';
    other.stderr = other.diagnostics[0].message + '\n';
    return 1;
  });
  requireDetected(spec, 'submit-omitted', sample, 'B/console', (mutant) => {
    mutant.result.evaluation.cases[1].stdout = 'Unexpected learner output\n';
    return 1;
  });
  requireDetected(spec, 'submit-omitted', sample, 'B/console', (mutant) => {
    mutant.result.evaluation.cases[1].diagnostics[0].code = 'single-line-limit';
    return 1;
  });
  requireDetected(spec, 'submit-omitted', sample, 'B/console', (mutant) => {
    const other = mutant.result.evaluation.cases[1];
    other.diagnostics[0].message += '\nUnexpected second line.';
    other.stderr = other.diagnostics[0].message + '\n';
    mutant.singletonStderr = other.stderr;
    return 1;
  });
});

test('G4 rejects a matching singleton guard without its stderr', () => {
  const spec = fixture('python', 'three-rows-single-line');
  const sample = referenceReceipt(spec);
  const row = sample.result.evaluation.cases[1];
  const reason = 'single-line-limit';
  const message = 'Execution stopped: resource limit exceeded (single-line-limit).';
  row.status = 'runtime-error';
  row.failure = { origin: 'limit', reason };
  row.stderr = message + '\n';
  row.diagnostics = [{ severity: 'error', code: reason, message }];
  sample.singletonGuard = reason;
  sample.singletonStderr = row.stderr;
  sample.transcript.push({ kind: 'worker-started', caseId: 'B', mode: 'code' });

  requireDetected(spec, 'submit-omitted', sample, 'B/console', (mutant) => {
    delete mutant.singletonStderr;
    return 1;
  });
  requireDetected(spec, 'submit-omitted', sample, 'B/learner-guard', (mutant) => {
    delete mutant.singletonGuard;
    return 1;
  });
});

function addCertifiedStarts(sample, request, rows = ['A', 'B'], terminal = {}) {
  const command = { request, commandId: 'batch', generation: 4 };
  sample.transcript.push(
    { ...command, kind: 'ordinary-dispatch', rows, reportsStarts: true },
    { ...command, kind: 'ordinary-start', caseId: 'A', index: 0 },
    { ...command, kind: 'ordinary-start', caseId: 'B', index: 1 },
    { ...command, kind: 'ordinary-terminal', ...terminal },
  );
}

test('G4 leaves C missing when dispatched and a plain terminal only follows A and B starts', () => {
  const spec = fixture('javascript', 'three-rows');
  const route = 'submit-stop';
  const sample = referenceReceipt(spec);
  addCertifiedStarts(sample, route, ['A', 'B', 'C']);
  const id = 'G4/javascript/three-rows/submit-stop/C/start-proof';
  assert(ledgerFor(spec, route, sample).missing.includes(id));
  const terminal = sample.transcript.pop();
  sample.transcript.push({ ...terminal, kind: 'ordinary-start', caseId: 'C', index: 2 }, terminal);
  assert.equal(ledgerFor(spec, route, sample).receipts.find((row) => row.id === id)?.status, 'failed');
});

test('G4 proves skipped C from a dispatch containing only A and B', () => {
  const spec = fixture('javascript', 'three-rows');
  const route = 'submit-stop';
  const sample = referenceReceipt(spec);
  addCertifiedStarts(sample, route);
  sample.transcript.pop(); // An observed start need not have a terminal reply.
  const id = 'G4/javascript/three-rows/submit-stop/C/start-proof';
  assert.equal(ledgerFor(spec, route, sample).receipts.find((row) => row.id === id)?.status, 'passed');
  for (const remove of ['ordinary-dispatch', 'ordinary-start']) {
    const partial = structuredClone(sample);
    const index = partial.transcript.findIndex(({ kind }) => kind === remove);
    partial.transcript.splice(index, 1);
    assert(ledgerFor(spec, route, partial).missing.includes(id));
  }
  for (const mode of ['code', 'trace']) {
    const partial = structuredClone(sample);
    partial.transcript.push({ request: route, kind: 'dispatch', generation: 8, mode, rows: ['C'] });
    assert(ledgerFor(spec, route, partial).missing.includes(id));
  }
});

test('G4 proves dispatched C was skipped from the same command’s authoritative started set', () => {
  const spec = fixture('python', 'three-rows-single-line');
  const route = 'submit-stop';
  const sample = referenceReceipt(spec);
  addCertifiedStarts(sample, route, ['A', 'B', 'C'], { startedCaseIndices: [0, 1] });
  const id = 'G4/python/three-rows-single-line/submit-stop/C/start-proof';
  assert.equal(ledgerFor(spec, route, sample).receipts.find((row) => row.id === id)?.status, 'passed');
  for (const fields of [
    { commandId: 'other-batch' }, { generation: 8 }, { retired: true }, { startedCaseIndices: [0, 1, 1] },
    { startedCaseIndices: [0, 1, 2] }, { startedCaseIndices: [0, 1, 3] },
    { startedCaseIndices: undefined, resultsStreamed: 2 },
  ]) {
    const partial = structuredClone(sample);
    Object.assign(partial.transcript.at(-1), fields);
    assert(ledgerFor(spec, route, partial).missing.includes(id));
  }
});

test('G5 requires correlated initial starts and a bound observer or cache hit to prove no ordinary continuation work', () => {
  for (const language of ['javascript', 'typescript', 'java']) {
    const spec = fixture(language, 'stdout');
    const parent = observedReceipt(spec);
    parent.transcript = parent.transcript.filter(({ kind }) => !kind.startsWith('ordinary-'));
    addCertifiedStarts(parent, 'run-first');
    const binding = { evaluationId: 'evaluation-1', workspaceDigest: 'workspace-1', generation: 1 };
    const attemptToken = 'observe-b';
    const b = parent.result.evaluation.cases[1];
    b.attachment = { ...binding, caseId: 'B', status: 'drawn', trace: { events: [] } };
    const reply = { kind: 'observer-reply', caseId: 'B', attemptToken, request: 'continue-B', sequence: 20 };
    const bind = { ...binding, kind: 'schedule', phase: 'attachment-bind', caseId: 'B', attemptToken,
      request: 'continue-B', sequence: 21 };
    for (const route of ['continue-B', 'repeat-B']) {
      const sample = referenceReceipt(spec);
      sample.result.evaluation.cases = [b];
      sample.registeredReceiptPath = true;
      sample.retainedWorkspaceDigest = binding.workspaceDigest;
      sample.retainedEvidence = [
        ...parent.transcript,
        ...(route === 'repeat-B' ? [reply, bind] : []),
      ];
      const hit = { ...bind, phase: 'observation-cache-hit', request: route, sequence: 22 };
      sample.transcript.push(...(route === 'continue-B' ? [reply, bind] : [hit]), {
        ...binding, kind: 'schedule', phase: 'public-resolve', request: route, sequence: 24,
      });
      if (language === 'java' && route === 'continue-B') {
        sample.transcript.unshift({ request: route, kind: 'dispatch', mode: 'trace', observationOnly: true });
      }
      requireDetected(spec, route, sample, 'ordinary-start-count', (mutant) => {
        addCertifiedStarts(mutant, route);
        return 1;
      });
      const id = `G5/${language}/stdout/${route}/ordinary-start-count`;
      const withoutInitial = structuredClone(sample);
      withoutInitial.retainedEvidence = withoutInitial.retainedEvidence.filter(({ kind }) => kind !== 'ordinary-start');
      assert(ledgerFor(spec, route, withoutInitial).missing.includes(id));
      const unwitnessedDispatch = structuredClone(sample);
      unwitnessedDispatch.transcript.push({ request: route, kind: 'dispatch', generation: 8, type: 'execute-code', rows: ['B'] });
      assert(ledgerFor(spec, route, unwitnessedDispatch).missing.includes(id));
      const wrongAttempt = structuredClone(sample);
      wrongAttempt.transcript.find((event) =>
        event.kind === 'observer-reply' || event.phase === 'observation-cache-hit').attemptToken = 'foreign-attempt';
      assert(ledgerFor(spec, route, wrongAttempt).missing.includes(id));
    }
  }
});

test('Java starts require the command token and admission ID, and nested observations require the attempt token', async () => {
  const { installJournal } = await import('./gb-transport.mjs');
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class FixtureWorker {
    addEventListener(_, listener) { this.listener = listener; }
    postMessage() {}
    reply(data, isTrusted = true) { this.listener({ data, isTrusted }); }
  };
  const spec = fixture('java', 'stdout');
  const decoded = { drawing: { status: 'truncated', reason: 'byte-budget', attemptedEvents: 1,
    trace: { schemaVersion: 'runtime-trace-2026-04-28', events: [] } }, javaEvents: [] };
  const journal = installJournal(spec, { decodeJavaObservation: () => decoded });
  try {
    journal.track('run-first');
    const worker = new Worker('java-worker.js');
    const batch = 'execute-prepared-runtime-program-batch';
    worker.postMessage({
      id: 'ordinary', type: batch, protocolToken: 'ordinary-token',
      payload: { inputBatch: spec.cases.map(({ input }) => input), admissionId: 3 },
    });
    const start = { id: 'ordinary', type: 'runtime-progress', protocolToken: 'ordinary-token',
      payload: { stage: 'ordinary-case-started', detail: { caseIndex: 0, admissionId: 3 } } };
    worker.reply(start, false);
    worker.reply({ ...start, protocolToken: 'stale' });
    worker.reply({ ...start, payload: { ...start.payload, detail: { caseIndex: 0, admissionId: 7 } } });
    worker.reply(start);
    worker.reply({ id: 'ordinary', type: batch, protocolToken: 'ordinary-token', payload: { results: [] } });
    worker.reply(start);
    assert.deepEqual(journal.since(0).filter(({ kind }) => kind === 'ordinary-start').map(({ caseId }) => caseId), ['A']);
    assert.equal(journal.since(0).find(({ kind }) => kind === 'ordinary-dispatch')?.reportsStarts, true);
    const observe = { id: 'observer', type: batch, protocolToken: 'worker-token',
      payload: { inputBatch: [spec.cases[0].input], attemptToken: 'observer-attempt' } };
    const reply = (attemptToken, protocolToken) => ({
      id: observe.id, type: batch, protocolToken, payload: { results: [{ observation: { attemptToken } }] },
    });
    worker.postMessage(observe);
    worker.reply(reply('observer-attempt', 'worker-token'), false);
    worker.reply(reply('observer-attempt', 'stale'));
    worker.reply(reply('stale', 'worker-token'));
    assert.equal(journal.since(0).filter(({ kind }) => kind === 'observer-reply').length, 0);
    worker.postMessage(observe);
    worker.reply(reply('observer-attempt', 'worker-token'));
    const witnesses = journal.since(0).filter(({ kind }) => kind === 'observer-reply');
    assert.equal(witnesses.length, 1);
    assert.deepEqual(witnesses[0].drawing, decoded.drawing);
    assert.equal(witnesses[0].attemptToken, 'observer-attempt');
    assert.equal(journal.since(0).filter(({ kind }) => kind === 'ordinary-dispatch').length, 1);
  } finally {
    journal.restore();
    globalThis.Worker = originalWorker;
  }
});

test('Java step-cap proof uses the bound recorder reply and the raw worker prefix', () => {
  const spec = fixture('java', 'step-cap');
  const frames = [
    { kind: 'line', file: 'solution.java', line: 2 },
    { kind: 'line', file: 'solution.java', line: 3 },
  ];
  const bindReply = (sample, token, javaEvents) => {
    const { trace, reason, attemptedEvents } = sample.result.evaluation.cases[0].attachment;
    const reply = sample.transcript.find(({ kind }) => kind === 'observer-reply');
    reply.attemptToken = token;
    reply.javaEvents = javaEvents;
    reply.drawing = reason ? { status: 'truncated', trace, reason, attemptedEvents } : { status: 'drawn', trace };
    sample.transcript.find(({ phase }) => phase === 'attachment-bind').attemptToken = token;
  };
  const sample = observedReceipt(spec, { status: 'truncated', reason: 'step-budget', events: frames.slice(0, 1), attemptedEvents: 2 });
  bindReply(sample, 'short', ['first']);
  const reference = observedReceipt(spec, { route: 'run-first:reference', events: frames });
  reference.result.evaluation.cases[0].attachment.evaluationId = 'reference-evaluation';
  reference.transcript.find(({ phase }) => phase === 'attachment-bind').evaluationId = 'reference-evaluation';
  bindReply(reference, 'long', ['first', 'second']);
  sample.prefixReference = { evaluation: reference.result.evaluation };
  sample.transcript.push(...reference.transcript.filter(({ kind, phase }) => kind === 'observer-reply' || phase === 'attachment-bind'));
  requireDetected(spec, 'run-first', sample, 'A/real-prefix', (mutant) => {
    mutant.transcript.find(({ attemptToken, kind }) => attemptToken === 'short' && kind === 'observer-reply').javaEvents[0] = 'foreign';
    return 1;
  });
  sample.transcript.find(({ kind }) => kind === 'observer-reply').attemptToken = 'foreign-attempt';
  assert(ledgerFor(spec, 'run-first', sample).missing.includes('G5/java/step-cap/run-first/A/real-prefix'));
});

test('G4 checks the pinned mux portable request and reserves the stored receipt for step 8', () => {
  for (const spec of fixtures.filter(({ routes }) => routes.includes('mux-shape'))) {
    const route = 'mux-shape';
    const prefix = [spec.gate, spec.language, spec.name, route].join('/');
    const sample = referenceReceipt(spec);
    const bundle = { id: 'gb-mux', workspaceDigest: 'workspace-for-mux' };
    sample.stimulus = { bundle };
    sample.result = {
      ...sample.result, schema: 'tracecode.judge.algorithm-receipt.v1',
      bundleId: bundle.id, workspaceDigest: bundle.workspaceDigest,
    };
    for (const row of sample.result.evaluation.cases) {
      row.sessionId = 'test-session';
      row.pid = 100;
    }
    const unadapted = ledgerFor(spec, route, sample);
    assert(unadapted.missing.includes(prefix + '/correlation'));
    sample.muxAdapter = {
      muxPin: '82888fb7bc95272e43477ab5ae62b95cc28e9008',
      request: { requestId: bundle.id, bundle: structuredClone(bundle) },
      response: { requestId: bundle.id, status: 'completed', result: structuredClone(sample.result) },
    };
    requireDetected(spec, route, sample, 'correlation', (mutant) => {
      mutant.muxAdapter.request.bundle.workspaceDigest = 'a-different-bundle';
      return 1;
    });
    const ledger = ledgerFor(spec, route, sample);
    assert.deepEqual(ledger.step8Owned, [prefix + '/mux/stored-receipt']);
    assert(!ledger.missing.includes(prefix + '/mux/stored-receipt'));
    assert(!ledger.receipts.some(({ id }) => id.endsWith('/mux/stored-receipt')));
  }
});

test('G4 stopping-clock keeps exactly the same typed diagnostic and rejects missing singleton stderr', () => {
  const spec = fixture('python', 'stopping-clock');
  const sample = referenceReceipt(spec);
  const row = sample.result.evaluation.cases[1];
  const reason = 'client-timeout';
  const message = 'Execution timed out after 4 seconds.';
  row.status = 'timed-out';
  row.failure = { origin: 'limit', reason };
  row.stderr = message + '\n';
  row.diagnostics = [{ severity: 'error', code: reason, message }];
  sample.singletonGuard = reason;
  sample.singletonStderr = row.stderr;
  requireDetected(spec, 'submit-stop', sample, 'B/console', (mutant) => {
    delete mutant.singletonStderr;
    return 1;
  });
});

test('JS recorder-disable ACK needs the authenticated worker confirmation', () => {
  const spec = fixture('javascript', 'no-recorder');
  const sample = observedReceipt(spec, { status: 'refused', reason: 'recorder-unavailable' });
  const [row] = sample.result.evaluation.cases;
  delete row.attachment.trace;
  const { evaluationId, workspaceDigest, generation, caseId } = row.attachment;
  const attemptToken = 'disabled-attempt';
  const reply = sample.transcript.find(({ kind }) => kind === 'observer-reply');
  Object.assign(reply, {
    attemptToken, recorderDisabled: true, drawing: { status: 'refused', reason: 'recorder-unavailable' },
  });
  const bind = sample.transcript.find(({ phase }) => phase === 'attachment-bind');
  bind.attemptToken = attemptToken;
  sample.transcript.push({
    kind: 'schedule', phase: 'injection-ack', point: 'observe', fault: 'no-recorder',
    language: 'javascript', evaluationId, workspaceDigest, generation, caseId, attemptToken,
    request: 'run-first', sequence: reply.sequence + 0.5,
  });
  requireDetected(spec, 'run-first', sample, 'A/injection-ack', (mutant) => {
    delete mutant.transcript.find(({ kind }) => kind === 'observer-reply').recorderDisabled;
    return 1;
  });
});

test('JS continuation inherits the bound preparation refusal without a recorder attempt', () => {
  const spec = fixture('javascript', 'observer-compile-fault');
  const route = 'continue-B';
  const sample = referenceReceipt(spec);
  const b = sample.result.evaluation.cases[1];
  const binding = { evaluationId: 'failed-prepare', workspaceDigest: 'workspace-1', generation: 1 };
  b.attachment = { ...binding, caseId: 'B', status: 'refused', reason: 'observer-prepare' };
  sample.result.evaluation.cases = [b];
  sample.retainedWorkspaceDigest = binding.workspaceDigest;
  sample.retainedEvidence = [{
    ...binding, kind: 'schedule', phase: 'injection-ack', point: 'prepare',
    fault: 'prepare', language: 'javascript', request: 'run-first', sequence: 1,
  }];
  sample.transcript.push({
    ...binding, kind: 'schedule', phase: 'attachment-bind', caseId: 'B',
    attemptToken: 'refused-B', request: route, sequence: 2,
  });
  requireDetected(spec, route, sample, 'B/anchor', (mutant) => {
    mutant.result.evaluation.cases[0].attachment.trace = { events: [{ kind: 'line' }] };
    return 1;
  });
  requireDetected(spec, route, sample, 'B/recorder-boundary', (mutant) => {
    mutant.transcript.push({ kind: 'observer-reply', request: route, caseId: 'B' });
    return 1;
  });
  sample.retainedEvidence[0].evaluationId = 'foreign-prepare';
  assert(ledgerFor(spec, route, sample).missing.includes('G5/javascript/observer-compile-fault/continue-B/B/recorder-boundary'));
});

test('Worker terminals close SES commands and carry started sets only with trusted protocol tokens', async () => {
  const { installJournal } = await import('./gb-transport.mjs');
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class FixtureWorker {
    addEventListener(_, listener) { this.listener = listener; }
    postMessage() {}
    reply(data, isTrusted = true) { this.listener({ data, isTrusted }); }
    terminate() {}
  };
  const journal = installJournal(fixture('javascript', 'stdout'));
  try {
    journal.track('run-first');
    const worker = new Worker('ses-worker.js');
    worker.postMessage({
      id: 12, type: 'execute-batch', protocolToken: 'start-12', reportCaseProgress: true, inputBatch: [{ n: 7 }],
    });
    const start = {
      id: 12, type: 'runtime-progress', protocolToken: 'start-12',
      payload: { stage: 'ordinary-case-started', detail: { caseIndex: 0 } },
    };
    worker.reply({ ...start, protocolToken: 'old' });
    worker.reply(start, false);
    worker.reply(start);
    worker.reply({ id: 12, ok: true, value: [], payload: { startedCaseIndices: [0] } });
    worker.reply(start);
    const evidence = journal.since(0).filter(({ kind }) => kind.startsWith('ordinary-'));
    assert.deepEqual(evidence.map(({ kind, commandId }) => [kind, commandId]), [
      ['ordinary-dispatch', 12], ['ordinary-start', 12], ['ordinary-terminal', 12],
    ]);
    assert.equal(evidence[1].caseId, 'A');
    assert(!Object.hasOwn(evidence[2], 'startedCaseIndices'));

    worker.postMessage({
      id: 'code', type: 'execute-code', protocolToken: 'code-token', payload: { inputs: { n: 7 } },
    });
    const terminal = { id: 'code', type: 'execute-result', payload: { startedCaseIndexes: [] } };
    worker.reply({ ...terminal, protocolToken: 'wrong-token' });
    worker.reply({ ...terminal, protocolToken: 'code-token' }, false);
    assert.equal(journal.since(0).filter(({ kind }) => kind === 'ordinary-terminal').length, 1);
    worker.reply({ ...terminal, protocolToken: 'code-token' });
    const startedSet = journal.since(0).find(({ kind, commandId }) => kind === 'ordinary-terminal' && commandId === 'code');
    assert.deepEqual(startedSet?.startedCaseIndices, []);
  } finally {
    journal.restore();
    globalThis.Worker = originalWorker;
  }
});
