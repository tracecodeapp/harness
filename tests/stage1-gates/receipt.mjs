import assert from 'node:assert/strict';

const cutCodes = new Map([
  ['step-budget', 'trace-limit'],
  ['line-budget', 'trace-limit'],
  ['single-line-budget', 'trace-limit'],
  ['stored-event-budget', 'trace-limit'],
  ['byte-budget', 'trace-byte-limit'],
  ['observer-deadline', 'trace-limit'],
  ['depth-budget', 'trace-limit'],
]);
const refusalReasons = new Set([
  'recorder-unavailable', 'unsupported-program', 'unsupported-option',
  'observer-prepare', 'observer-encode', 'observer-runtime', 'observer-protocol',
  'observer-timeout', 'uncertified-drawing', 'case-not-run',
]);

export function hasReceiptEvidence(observation) {
  return Boolean(observation.journal?.length || observation.reported?.evaluation?.cases?.some(
    (row) => Object.hasOwn(row, 'attachment')
  ));
}

export function ordinaryRow({ attachment, trace, ...ordinary }) {
  return ordinary;
}

function withoutStack({ stack, ...error }) {
  return error;
}

export function assertNoLegacyRefusal(result) {
  for (const field of ['untracedRunNeeded', 'traceUnavailable', 'traceUnavailableRun', 'providerFailure']) {
    assert(!Object.hasOwn(result, field), `Legacy refusal field ${field}`);
  }
}

export function checkPresentation(row, ordinary, traced, selected, workspaceDigest) {
  for (const result of [row, ordinary, traced]) assertNoLegacyRefusal(result);
  for (const field of ['trace', 'traceTruncated', 'executionTimeMs']) {
    assert(!Object.hasOwn(ordinary, field), `Ordinary converter returned ${field}`);
  }
  if (ordinary.rejected) {
    assert(traced.rejected, 'Trace converter hid an ordinary provider failure');
    assert.notEqual(ordinary.rejected.code, 'trace-unavailable');
    assert.deepEqual(withoutStack(traced.rejected), withoutStack(ordinary.rejected));
  }
  const attachment = row.attachment;
  assert.equal(Object.hasOwn(row, 'attachment'), selected, 'Selected attachment presence');
  if (selected) {
    assert.equal(attachment.caseId, row.caseId);
    assert.equal(attachment.workspaceDigest, workspaceDigest);
    assert(typeof attachment.evaluationId === 'string' && attachment.evaluationId.length > 0);
    assert(Number.isSafeInteger(attachment.generation) && attachment.generation > 0);
    assert(['drawn', 'truncated', 'refused'].includes(attachment.status), 'Unknown attachment status');
    if (row.status === 'not-run') {
      assert.equal(attachment.status, 'refused');
      assert.equal(attachment.reason, 'case-not-run');
    }
  }
  if (!selected || attachment.status === 'refused') {
    assert(!Object.hasOwn(row, 'trace'), 'Unexpected compatibility trace');
    if (selected) {
      assert(refusalReasons.has(attachment.reason), 'Unknown refusal reason');
      assert.equal(attachment.reason === 'case-not-run', row.status === 'not-run');
      assert(!Object.hasOwn(attachment, 'trace'));
      assert(!Object.hasOwn(attachment, 'attemptedEvents'));
    }
    if (!ordinary.rejected) assert.deepEqual(traced, row.status === 'not-run' ? ordinary : { kind: 'trace-refused' });
    return;
  }

  assert(Array.isArray(attachment.trace?.events), 'Missing recorded events');
  assert.deepEqual(row.trace, attachment.trace, 'Compatibility trace differs from attachment');
  const duration = typeof row.timings?.totalMs === 'number' ? row.timings.totalMs
    : typeof row.startedAt === 'number' && typeof row.endedAt === 'number' ? Math.max(0, row.endedAt - row.startedAt) : 0;
  const presentation = { trace: attachment.trace, executionTimeMs: duration };
  if (attachment.status === 'truncated') {
    assert(cutCodes.has(attachment.reason), 'Unknown cutoff reason');
    const retained = attachment.trace.events.length;
    assert(Number.isSafeInteger(attachment.attemptedEvents) && attachment.attemptedEvents >= retained);
    assert(retained > 0 || (attachment.reason === 'byte-budget' && attachment.attemptedEvents > 0));
    presentation.traceTruncated = cutCodes.get(attachment.reason);
  } else {
    assert(attachment.trace.events.length > 0, 'Drawing has no recorded events');
    assert(!Object.hasOwn(attachment, 'reason'));
    assert(!Object.hasOwn(attachment, 'attemptedEvents'));
  }
  if (!ordinary.rejected) assert.deepEqual(traced, { ...ordinary, ...presentation });
}

export function checkRetainedRows(observation) {
  const initial = observation.retainedEvaluation;
  const { evaluation } = observation.reported;
  assert.equal(evaluation.planId, initial.planId);
  if (evaluation.compile?.status) assert.deepEqual(evaluation.compile, initial.compile);
  for (const row of evaluation.cases) {
    const retained = initial.cases.find(({ caseId }) => caseId === row.caseId);
    assert(retained, `Missing retained row ${row.caseId}`);
    assert.deepEqual(ordinaryRow(row), ordinaryRow(retained), `Retained row changed for ${row.caseId}`);
  }
}

export function checkRedraw(observation) {
  assert.equal(observation.worker.filter(({ action }) => action === 'command').length, 0, 'Redraw dispatched a worker command');
  for (const { caseId, attachment } of observation.reported.evaluation.cases) {
    const prior = observation.drawnEvaluation.cases.find((row) => row.caseId === caseId);
    assert(attachment && prior?.attachment, `Missing cached attachment for ${caseId}`);
    assert.deepEqual(attachment, prior.attachment, `Cached attachment changed for ${caseId}`);
  }
}

function phase(events, name) {
  return events.filter(({ phase }) => phase === name);
}

function sameScope(left, right) {
  return left.evaluationId === right.evaluationId && left.workspaceDigest === right.workspaceDigest &&
    left.generation === right.generation;
}

export function checkPublication(request, observation) {
  const { journal, retainedJournal, workspaceDigest } = observation;
  const continuation = request.mode === 'continuation';
  const commits = phase(continuation ? retainedJournal : journal, 'ordinary-commit');
  const resolutions = phase(journal, 'public-resolve');
  assert.equal(commits.length, 1);
  assert.equal(resolutions.length, 1);
  if (continuation) assert.equal(phase(journal, 'ordinary-commit').length, 0);
  const [commit] = commits;
  const [resolve] = resolutions;
  assert.equal(commit.workspaceDigest, workspaceDigest);
  assert(journal.every((event) => sameScope(event, commit)), 'Journal evaluation scope changed');
  assert(commit.sequence < resolve.sequence, 'Public resolution preceded ordinary commit');

  const rows = observation.reported.evaluation.cases;
  const writes = phase(journal, 'ordinary-write-attempt');
  assert.deepEqual(writes.map(({ caseId }) => caseId).sort(), continuation ? [] : rows.map(({ caseId }) => caseId).sort());
  assert(writes.every((event) => event.sequence < commit.sequence), 'Ordinary write after commit');

  const binds = phase(journal, 'attachment-bind');
  const selected = rows.filter(({ caseId }) => request.selected.includes(caseId));
  const redraw = request.id === 'redraw-b';
  assert.deepEqual(binds.map(({ caseId }) => caseId).sort(), redraw ? [] : selected.map(({ caseId }) => caseId).sort());
  for (const bind of binds) {
    const attachment = selected.find(({ caseId }) => caseId === bind.caseId)?.attachment;
    assert(attachment && sameScope(attachment, bind));
    assert(commit.sequence < bind.sequence && bind.sequence < resolve.sequence, 'Attachment bound outside the committed evaluation');
  }
}

export function checkCacheHit(request, observation) {
  const { drawnJournal, journal } = observation;
  const hits = phase(journal, 'observation-cache-hit');
  const resolutions = phase(journal, 'public-resolve');
  assert.deepEqual(hits.map(({ caseId }) => caseId).sort(), [...request.selected].sort());
  assert.equal(resolutions.length, 1);
  assert.equal(phase(journal, 'observer-start').length, 0);
  assert.equal(phase(journal, 'observer-end').length, 0);
  const priorResolutions = phase(drawnJournal, 'public-resolve');
  const priorBinds = phase(drawnJournal, 'attachment-bind');
  const priorAttempts = phase(drawnJournal, 'observer-end');
  assert.equal(priorResolutions.length, 1);
  for (const hit of hits) {
    const { attachment } = observation.reported.evaluation.cases.find(({ caseId }) => caseId === hit.caseId);
    assert(sameScope(hit, attachment));
    assert(hit.sequence < resolutions[0].sequence);
    assert(typeof hit.attemptToken === 'string' && hit.attemptToken.length > 0);
    const binds = priorBinds.filter(({ caseId }) => caseId === hit.caseId);
    assert.equal(binds.length, 1);
    assert(sameScope(hit, binds[0]));
    assert(binds[0].sequence < priorResolutions[0].sequence && priorResolutions[0].sequence < hit.sequence);
    // A refusal can settle before an observer starts.
    for (const attempt of priorAttempts.filter(({ caseId }) => caseId === hit.caseId)) {
      assert(sameScope(hit, attempt));
      assert.equal(hit.attemptToken, attempt.attemptToken);
    }
  }
}

export function receiptEvidenceIds(fixture, request) {
  const prefix = `${fixture.gate}/${fixture.language}/${fixture.name}/${request.route ?? 'default'}/${request.id}/@request`;
  return [`${prefix}/receipt-publication`, ...(request.id === 'redraw-b' ? [`${prefix}/cache-hit`] : [])];
}


export function checkCppStarts(worker, admittedInputs) {
  const commands = worker.filter(({ action, cppProtocol, reportsStarts }) =>
    action === 'command' && cppProtocol && reportsStarts);
  if (!commands.length) return;
  const startedInputs = [];
  const starts = worker.filter(({ action }) => action === 'ordinary-start');
  for (const command of commands) {
    const matches = ({ id, generation }) => id === command.id && generation === command.generation;
    const reply = worker.findIndex((event) => event.action === 'response' && event.cppTerminal && matches(event));
    assert(reply >= 0, 'No correlated C++ terminal response');
    const inputs = Array.isArray(command.inputs) ? command.inputs : [command.inputs];
    const scopedStarts = starts.filter(matches);
    const indexes = scopedStarts.map(({ caseIndex }) => caseIndex);
    assert.deepEqual(indexes, inputs.slice(0, indexes.length).map((_, index) => index), 'Ordinary C++ case start indexes');
    for (const start of scopedStarts) {
      assert(worker.indexOf(start) < reply, 'C++ case start followed its terminal response');
      startedInputs.push(inputs[start.caseIndex]);
    }
  }
  assert.equal(starts.length, startedInputs.length, 'Unmatched C++ ordinary start event');
  assert.deepEqual(startedInputs, admittedInputs, 'C++ ordinary starts differ from admitted inputs');
}
