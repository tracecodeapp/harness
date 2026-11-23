import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkDifferential, checkObservation } from './checks.mjs';
import { runGraphControls } from './graph.mjs';
import { requestMatrix } from './requests.mjs';
import { checkPresentation, hasReceiptEvidence } from './receipt.mjs';

const scope = { evaluationId: 'evaluation-1', workspaceDigest: 'sha256:workspace', generation: 1 };
const workspaceDigest = scope.workspaceDigest;
const caseId = 'A';
const binding = { ...scope, caseId };
const attemptToken = 'attempt-1';
const trace = { events: [{ line: 3, kind: 'snapshot', target: { variable: 'n' }, value: 7 }] };
const attachment = { ...binding, status: 'drawn', trace };
const ordinary = { kind: 'completed', output: null, consoleOutput: ['seven'], timings: { totalMs: 2 } };
const traced = { ...ordinary, trace, executionTimeMs: 2 };
const row = {
  caseId, sessionId: 'session', pid: 42, expected: null, value: null, stdout: 'seven\n', stderr: '',
  status: 'completed', verdict: { kind: 'passed' }, termination: { kind: 'exit', exitCode: 0 },
  timedOut: false, diagnostics: [], timings: { totalMs: 2 }, startedAt: 1, endedAt: 3,
};
const fixture = {
  gate: 'G1', language: 'java', name: 'seed', cases: [
    { id: caseId, status: 'completed', verdict: 'passed', actual: null, expected: null, stdout: 'seven\n', stderr: '',
      diagnostics: [], anchor: 3, anchorInput: 7, instrumentedLine: 3 },
  ],
};
const initialRequest = { id: 'run-first', mode: 'initial', cases: [caseId], selected: [caseId] };
const drawRequest = { id: 'draw-b', mode: 'continuation', cases: [caseId], selected: [caseId] };
const redrawRequest = { ...drawRequest, id: 'redraw-b' };
const mark = (phase, sequence, fields = {}) => ({ phase, sequence, ...scope, ...fields });
const command = { action: 'command', type: 'execute', generation: 2, id: 'execute-1', mode: 'trace' };
const response = { ...command, action: 'response' };
const plainEvaluation = { planId: 'plan', status: 'completed', compile: { status: 'compiled', diagnostics: [] }, cases: [row] };
const selectedEvaluation = { ...plainEvaluation, cases: [{ ...row, attachment, trace }] };
const initial = {
  reported: { evaluation: selectedEvaluation, executionId: 'handle' }, workspaceDigest,
  ordinaryProjections: [ordinary], tracedProjections: [traced], projections: [traced], traceAliases: [true],
  worker: [command, response],
  journal: [
    mark('ordinary-write-attempt', 0, { caseId }),
    mark('ordinary-commit', 1),
    mark('attachment-bind', 2, { caseId }),
    mark('public-resolve', 3),
  ],
};
const draw = {
  ...initial, retainedExecutionId: 'handle', retainedEvaluation: plainEvaluation,
  retainedJournal: initial.journal.slice(0, 2),
  journal: [
    mark('observer-start', 4, { caseId, attemptToken }),
    mark('observer-end', 5, { caseId, attemptToken }),
    mark('attachment-bind', 6, { caseId }),
    mark('public-resolve', 7),
  ],
};
const redraw = {
  ...draw, worker: [], drawnEvaluation: selectedEvaluation, drawnJournal: draw.journal,
  journal: [mark('observation-cache-hit', 8, { caseId, attemptToken }), mark('public-resolve', 9)],
};

function results(request, sample, registered = true) {
  const result = new Map();
  checkObservation(fixture, request, sample, (item) => result.set(item.id.split('/').slice(-2).join('/'), item), registered);
  return result;
}

function status(request, sample, id, registered) {
  return results(request, sample, registered).get(id)?.status;
}

function seed(request, sample, id, mutate) {
  assert.equal(status(request, sample, id), 'pass', id);
  const poisoned = structuredClone(sample);
  mutate(poisoned);
  assert.equal(status(request, poisoned, id), 'fail', id);
}

test('differential compares grade and presence across paths, including legacy replay', () => {
  const first = { request: 'submit-default-A', reported: { evaluation: plainEvaluation } };
  const second = { request: 'run-first', ...initial };
  function compare(current, registered) {
    const observations = [];
    checkDifferential(fixture, [first, current], (item) => observations.push(item), registered);
    assert.equal(observations.length, 1);
    return observations[0].status;
  }
  assert.equal(compare(second, true), 'pass');
  assert.equal(compare(second, false), 'fail');
  for (const mutate of [
    (target) => delete target.value,
    (target) => { target.value = 999; },
    (target) => { target.stdout = 'forged\n'; },
    (target) => { target.stderr = 'forged\n'; },
    (target) => { target.expected = 999; },
    (target) => { target.failure = { origin: 'provider' }; },
    (target) => { target.verdict.kind = 'failed'; },
    (target) => { target.diagnostics.push({ kind: 'trace-truncated' }); },
  ]) {
    const poisoned = structuredClone(second);
    mutate(poisoned.reported.evaluation.cases[0]);
    assert.equal(compare(poisoned, true), 'fail');
  }
});

test('redraw rejects any worker command and a changed or missing attachment', () => {
  seed(redrawRequest, redraw, '@request/worker-ack', (sample) => { sample.worker.push(command); });
  seed(redrawRequest, redraw, '@request/worker-ack', (sample) => {
    sample.worker.push({ ...command, type: 'prepare-runtime-program' });
  });
  seed(redrawRequest, redraw, '@request/worker-ack', (sample) => {
    sample.reported.evaluation.cases[0].attachment.trace.events[0].value = 8;
    // Use a distinct wire record for the earlier draw.
    sample.drawnEvaluation = selectedEvaluation;
  });
  seed(redrawRequest, redraw, '@request/worker-ack', (sample) => { delete sample.drawnEvaluation; });
  assert.equal(status(redrawRequest, redraw, '@request/worker-ack', false), 'fail');
  assert.equal(status(redrawRequest, { ...redraw, worker: [command, response] }, '@request/worker-ack', false), 'pass');
});

test('cold draw needs an observation acknowledgement or a typed pre-dispatch refusal', () => {
  seed(drawRequest, draw, '@request/worker-ack', (sample) => { sample.worker.pop(); });
  seed(drawRequest, draw, '@request/worker-ack', (sample) => { sample.worker[0].mode = 'code'; });
  seed(drawRequest, draw, '@request/correlation', (sample) => { delete sample.reported.executionId; });
  seed(drawRequest, draw, '@request/correlation', (sample) => { sample.retainedEvaluation.cases[0].timings = { totalMs: 1 }; });
  seed(drawRequest, draw, '@request/correlation', (sample) => { sample.reported.evaluation.compile = { status: 'compiled', diagnostic: 'different' }; });
  const refused = structuredClone(draw);
  refused.worker = [];
  refused.reported.evaluation.cases[0].attachment = { ...binding, status: 'refused', reason: 'observer-prepare' };
  delete refused.reported.evaluation.cases[0].trace;
  refused.tracedProjections = [{ kind: 'trace-refused' }];
  assert.equal(status(drawRequest, refused, '@request/worker-ack'), 'pass');
  assert.equal(status(drawRequest, refused, 'A/status'), 'pass');
  assert.equal(status(drawRequest, refused, 'A/value'), 'pass');
  assert.equal(status(drawRequest, refused, 'A/console'), 'pass');
  for (const id of ['source-event', 'case-binding', 'instrumented-line']) {
    assert.equal(status(drawRequest, refused, `A/${id}`), 'fail', id);
  }
  refused.ordinaryProjections[0].consoleOutput = [];
  assert.equal(status(drawRequest, refused, 'A/console'), 'fail');
});

test('JS and TS cold continuations acknowledge their distinct observer commands', () => {
  const observer = { ...command, type: 'observe-execution', worker: 'javascript-worker.js', mode: undefined };
  const reply = { ...observer, type: 'execute-result', action: 'response' };
  const result = (language, route, worker) => {
    const assertions = [];
    checkObservation({ ...fixture, language }, { ...drawRequest, route }, { ...draw, worker },
      (item) => assertions.push(item), true);
    return assertions.find(({ id }) => id.endsWith('/worker-ack')).status;
  };
  for (const language of ['javascript', 'typescript']) {
    for (const route of [undefined, 'ses-compartment-pool', 'disposable-worker']) {
      assert.equal(result(language, route, [observer, reply]), 'pass');
      assert.equal(result(language, route, [observer, { ...reply, generation: 3 }]), 'fail');
      assert.equal(result(language, route, [observer, reply, command, response]), 'fail');
    }
  }
});

test('ordinary grade and trace presentation are checked independently', () => {
  for (const key of ['untracedRunNeeded', 'traceUnavailable', 'traceUnavailableRun', 'providerFailure']) {
    seed(initialRequest, initial, 'A/status', (sample) => { sample.reported.evaluation.cases[0][key] = undefined; });
    seed(initialRequest, initial, 'A/status', (sample) => {
      sample.ordinaryProjections[0][key] = false;
      sample.tracedProjections[0][key] = false;
    });
    seed(initialRequest, initial, '@request/compile-footprint', (sample) => { sample.reported.evaluation[key] = undefined; });
  }
  seed(initialRequest, initial, 'A/status', (sample) => { delete sample.reported.evaluation.cases[0].attachment; });
  seed(initialRequest, initial, 'A/status', (sample) => { sample.reported.evaluation.cases[0].attachment.caseId = 'B'; });
  seed(initialRequest, initial, 'A/status', (sample) => { sample.tracedProjections[0].output = 999; });
  seed(initialRequest, initial, 'A/status', (sample) => { sample.traceAliases[0] = false; });
  seed(initialRequest, initial, 'A/status', (sample) => { sample.ordinaryProjections[0].trace = trace; });
  seed(initialRequest, initial, 'A/status', (sample) => { sample.tracedProjections[0].executionTimeMs = 999; });
  seed(initialRequest, initial, 'A/value', (sample) => { delete sample.ordinaryProjections[0].output; });
  for (const diagnostic of [{ kind: 'trace-truncated' }, { code: 'trace-unavailable' }]) {
    seed(initialRequest, initial, 'A/diagnostics', (sample) => { sample.reported.evaluation.cases[0].diagnostics.push(diagnostic); });
  }
  for (const id of ['source-event', 'case-binding', 'instrumented-line']) {
    seed(initialRequest, initial, `A/${id}`, (sample) => { sample.reported.evaluation.cases[0].attachment.trace = { events: [] }; });
  }
});

test('trace outcomes enforce exact Cut mapping, legitimate empty byte prefix and not-run precedence', () => {
  for (const reason of ['step-budget', 'line-budget', 'single-line-budget', 'stored-event-budget',
    'byte-budget', 'observer-deadline', 'depth-budget']) {
    const cut = { ...attachment, status: 'truncated', reason, attemptedEvents: 2 };
    const outcome = { ...traced, traceTruncated: reason === 'byte-budget' ? 'trace-byte-limit' : 'trace-limit' };
    checkPresentation({ ...row, attachment: cut, trace }, ordinary, outcome, true, workspaceDigest);
    assert.throws(() => checkPresentation({ ...row, attachment: cut, trace }, ordinary,
      { ...outcome, traceTruncated: 'client-timeout' }, true, workspaceDigest));
  }
  const empty = { events: [] };
  const bounded = { ...attachment, status: 'truncated', reason: 'byte-budget', attemptedEvents: 1, trace: empty };
  checkPresentation({ ...row, attachment: bounded, trace: empty }, ordinary,
    { ...traced, trace: empty, traceTruncated: 'trace-byte-limit' }, true, workspaceDigest);
  assert.throws(() => checkPresentation({ ...row, attachment: { ...bounded, attemptedEvents: 0 }, trace: empty }, ordinary,
    { ...traced, trace: empty, traceTruncated: 'trace-byte-limit' }, true, workspaceDigest));

  const refusal = { ...binding, status: 'refused', reason: 'observer-encode' };
  const marker = { kind: 'trace-refused' };
  checkPresentation({ ...row, attachment: refusal }, ordinary, marker, true, workspaceDigest);
  assert.throws(() => checkPresentation({ ...row, attachment: { ...refusal, reason: 'unknown' } }, ordinary, marker, true, workspaceDigest));
  assert.throws(() => checkPresentation({ ...row, attachment: { ...refusal, trace: empty } }, ordinary, marker, true, workspaceDigest));
  assert.throws(() => checkPresentation({ ...row, attachment: refusal, trace: empty }, ordinary, marker, true, workspaceDigest));
  assert.throws(() => checkPresentation({ ...row, attachment: refusal }, ordinary, { ...marker, output: null }, true, workspaceDigest));
  const skipped = { kind: 'not-run', stoppedByCaseId: 'B', consoleOutput: [] };
  const skippedRow = { ...row, status: 'not-run', attachment: { ...refusal, reason: 'case-not-run' } };
  checkPresentation(skippedRow, skipped, skipped, true, workspaceDigest);
  assert.throws(() => checkPresentation(skippedRow, skipped, marker, true, workspaceDigest));
  checkPresentation(row, ordinary, marker, false, workspaceDigest);
  assert.throws(() => checkPresentation({ ...row, attachment: undefined }, ordinary, marker, false, workspaceDigest));
  assert.throws(() => checkPresentation(row, ordinary, { ...marker, trace: empty }, false, workspaceDigest));
});

test('scheduler cells reject wrong ordering, repeated writes, stale tokens and redispatch', () => {
  seed(initialRequest, initial, '@request/receipt-publication', (sample) => { sample.journal[2].sequence = 0; });
  seed(initialRequest, initial, '@request/receipt-publication', (sample) => { sample.journal.push(sample.journal[0]); });
  seed(initialRequest, initial, '@request/receipt-publication', (sample) => { sample.journal[2].evaluationId = 'another'; });
  seed(drawRequest, draw, '@request/receipt-publication', (sample) => { sample.journal.push(initial.journal[0]); });
  seed(redrawRequest, redraw, '@request/receipt-publication', (sample) => { sample.journal.push(draw.journal[2]); });
  seed(redrawRequest, redraw, '@request/cache-hit', (sample) => { sample.journal.shift(); });
  seed(redrawRequest, redraw, '@request/cache-hit', (sample) => { sample.journal[0].attemptToken = 'stale'; });
  seed(redrawRequest, redraw, '@request/cache-hit', (sample) => { sample.journal.push(mark('observer-start', 8, { caseId })); });
  const noBridge = { ...redraw, journal: [], retainedJournal: [], drawnJournal: [] };
  assert.equal(status(redrawRequest, noBridge, '@request/worker-ack'), 'pass');
  assert.equal(status(redrawRequest, noBridge, '@request/receipt-publication'), undefined);
  assert.equal(status(redrawRequest, noBridge, '@request/cache-hit'), undefined);
  assert(hasReceiptEvidence(noBridge));
  assert(!hasReceiptEvidence({ reported: { evaluation: plainEvaluation }, journal: [] }));
});

test('registered syntax failure checks compile-only receipts and the pinned mux projection', () => {
  const syntax = { ...fixture, syntax: true, language: 'javascript', cases: [{ ...fixture.cases[0], expected: 7 }] };
  const failure = { origin: 'program', stage: 'compile', message: 'Unexpected end of input' };
  const compile = {
    sessionId: 'compile-session', pid: 0, status: 'compile-failed', timedOut: false, stdout: '',
    stderr: failure.message, diagnostics: [{ severity: 'error', source: 'javascript', message: failure.message, line: 2 }],
    termination: { kind: 'exit', exitCode: 1 }, failure,
  };
  const compileProjection = { kind: 'failed', diagnosticStage: 'compile', error: failure.message, consoleOutput: [] };
  const sample = {
    reported: { evaluation: { status: 'compile-failed', compile, cases: [] } },
    workspaceDigest, compileProjection,
    tracedCompileProjection: { ...compileProjection, executionTimeMs: 0, trace: { language: 'javascript', runId: 'javascript:compile', events: [] } },
    worker: [], journal: [mark('ordinary-commit', 1), mark('public-resolve', 2)],
  };
  function seen(request, observation, registered = true) {
    const result = new Map();
    checkObservation(syntax, request, observation, (item) => result.set(item.id.split('/').at(-1), item.status), registered);
    return result;
  }
  for (const id of ['order', 'compile', 'compile-footprint', 'correlation', 'worker-ack', 'receipt-publication']) {
    assert.equal(seen(initialRequest, sample).get(id), 'pass', id);
  }
  for (const id of ['order', 'compile', 'correlation']) {
    assert.equal(seen(initialRequest, sample, false).get(id), 'fail', id);
  }
  for (const [id, mutate] of [
    ['order', (target) => { target.reported.evaluation.cases = [row]; }],
    ['compile', (target) => { target.reported.evaluation.compile.failure.stage = 'runtime'; }],
    ['compile', (target) => { target.reported.evaluation.compile.failure.origin = 'provider'; }],
    ['compile-footprint', (target) => { target.reported.evaluation.compile.attachment = attachment; }],
    ['compile-footprint', (target) => { target.reported.evaluation.compile.diagnostics.push({ code: 'trace-unavailable' }); }],
    ['compile-footprint', (target) => { target.tracedCompileProjection.executionTimeMs = 2; }],
    ['compile-footprint', (target) => { target.tracedCompileProjection.trace.events = trace.events; }],
    ['correlation', (target) => { target.reported.executionId = 'fake-handle'; }],
    ['worker-ack', (target) => { target.worker = [command, response]; }],
  ]) {
    const poisoned = structuredClone(sample);
    mutate(poisoned);
    assert.equal(seen(initialRequest, poisoned).get(id), 'fail', id);
  }

  const muxRequest = { id: 'legacy-trace', mode: 'submit', route: 'mux', cases: [caseId], selected: [caseId] };
  const mux = {
    ...sample, submitted: { id: 'id', workspaceDigest },
    reported: { ...sample.reported, schema: 'tracecode.judge.algorithm-receipt.v1', workspaceDigest, bundleId: 'id',
      totalCount: 0, passedCount: 0, verdict: 'failed', policy: { result: false, missingFacts: [] } },
    legacy: { requestId: 'id', compile: { status: 'compile-failed' }, results: [
      { caseId, expected: 7, success: false, passed: false, error: failure.message, errorLine: 2, consoleOutput: [] },
    ] },
  };
  assert.equal(seen(muxRequest, mux).get('aggregate'), 'pass');
  assert.equal(seen(muxRequest, mux).get('legacy-projection'), 'pass');
  const fabricatedCount = structuredClone(mux);
  fabricatedCount.reported.totalCount = 1;
  assert.equal(seen(muxRequest, fabricatedCount).get('aggregate'), 'fail');
  const bogusOutput = structuredClone(mux);
  bogusOutput.legacy.results[0].output = undefined;
  assert.equal(seen(muxRequest, bogusOutput).get('legacy-projection'), 'fail');
  const legacyRetry = structuredClone(mux);
  legacyRetry.legacy.results[0].untracedRunNeeded = false;
  assert.equal(seen(muxRequest, legacyRetry).get('legacy-projection'), 'fail');

  const observations = requestMatrix([caseId], syntax).map(({ id }) => ({ request: id, ...structuredClone(sample) }));
  const compare = () => {
    const result = [];
    checkDifferential(syntax, observations, (item) => result.push(item.status), true);
    return result;
  };
  assert.deepEqual(compare(), ['pass']);
  observations.at(-1).reported.evaluation.compile.diagnostics[0].line = 3;
  assert.deepEqual(compare(), ['fail']);
});

test('graph oracle accepts renamed opaque IDs while a product misgrade stays red', () => {
  assert.equal(runGraphControls()[0].observed, 'pass');
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8'));
  for (const language of ['javascript', 'typescript']) {
    const graph = manifest.fixtures.find((item) => item.language === language && item.name === 'graph-output');
    const [expected] = graph.cases;
    const value = structuredClone(expected.actual);
    value.__id__ = 'TreeNode:1';
    value.left.__id__ = 'TreeNode:2';
    value.left.left.__ref__ = 'TreeNode:1';
    value.right.__ref__ = 'TreeNode:2';
    const request = { ...initialRequest, selected: [] };
    const sample = {
      ...initial, journal: [], traceAliases: [true],
      reported: { ...initial.reported, evaluation: { ...plainEvaluation, cases: [
        { ...row, stdout: '', expected: expected.expected, value, verdict: { kind: 'failed' } },
      ] } },
      ordinaryProjections: [{ kind: 'completed', output: value, consoleOutput: [] }],
      tracedProjections: [{ kind: 'trace-refused' }],
    };
    const result = [];
    checkObservation(graph, request, sample, (item) => result.push(item), true);
    assert.equal(result.find(({ id }) => id.endsWith('/A/value')).status, 'pass');
    assert.equal(result.find(({ id }) => id.endsWith('/A/verdict')).status, 'fail');
  }
});
