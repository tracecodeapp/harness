import { isDeepStrictEqual } from 'node:util';
import { schedulerInjection } from './gb-probe.mjs';
import { pythonClockRoute } from './gb-python-clock.mjs';

const healthyChecks = ['identity', 'status', 'value', 'console', 'failure', 'verdict', 'termination', 'diagnostics', 'conversion'];
const transportChecks = ['injection-ack', 'A/ordinary-start-count', 'A/worker-finish', 'A/coordinator-commit'];
const observationChecks = ['ordinary-start-count', 'ordinary-before-observer', 'observer-grade-writes'];
const singleLineFixture = 'three-rows-single-line';
const stopRoute = (route) => route.startsWith('run-') || route === 'submit-stop';
const continuation = (route) => route.startsWith('continue-') || route.startsWith('repeat-');
const faultNames = ['no-recorder', 'observer-compile-fault', 'observer-encoder-fault', 'observer-deadline'];

export function selectedRows(fixture, route) {
  return /-[ABC]$/u.test(route) ? fixture.cases.filter((row) => row.id === route.at(-1)) : fixture.cases;
}

function drawingRows(fixture, route) {
  if (route === 'run-first') return fixture.cases.slice(0, 1);
  if (continuation(route)) return selectedRows(fixture, route);
  return route === 'run-all' || route === 'submit-traced' ? fixture.cases : [];
}

function serviceCut(fixture, route) {
  return fixture.name === 'transport' && /^(?:cut|deadline|during)-/u.test(route);
}

function required(fixture, route) {
  const ids = ['compile', 'order', 'correlation'];
  if (!route.startsWith('run-') && !continuation(route)) ids.push('aggregate', 'counts');
  if (fixture.noInterruptBuffer) ids.push('interrupt-unavailable');
  for (const row of selectedRows(fixture, route)) {
    ids.push(...healthyChecks.map((check) => `${row.id}/${check}`));
    if (row.limitReasons) ids.push(`${row.id}/learner-guard`);
    if (fixture.gate === 'G4' && !continuation(route)) ids.push(`${row.id}/start-proof`);
  }
  if (fixture.name === 'transport' && route !== 'submit-stop') {
    ids.push(...transportChecks);
    if (route.startsWith('clock-')) ids.push('clock/omitted-wall-budget', 'clock/three-advances');
    if (serviceCut(fixture, route)) ids.push('suffix/storage', 'generation-fence');
  }
  if (route === 'mux-shape') ids.push('mux/stored-receipt');
  if (fixture.gate === 'G5') {
    if (route.startsWith('run-') || continuation(route) || route === 'submit-traced') ids.push(...observationChecks);
    for (const row of drawingRows(fixture, route)) {
      ids.push(`${row.id}/attachment-status`);
      const faultingObserver = faultNames.includes(fixture.name) && row.id === 'A';
      if (fixture.anchor && !faultingObserver) ids.push(`${row.id}/anchor`, `${row.id}/recorder-boundary`);
      if (fixture.name === 'observer-encoder-fault' && faultingObserver) ids.push('A/recorder-boundary');
      if (fixture.name === 'step-cap') ids.push(`${row.id}/real-prefix`);
      if (fixture.name === 'byte-cap') ids.push(`${row.id}/attempted-events`);
      if (faultNames.includes(fixture.name) && row.id === 'A') ids.push('A/injection-ack', 'A/provenance');
    }
  }
  return ids;
}

function desiredRow(fixture, route, row) {
  if (serviceCut(fixture, route) && row.id !== 'A') return 'unavailable';
  if (pythonTransportClock(fixture, route) && route === 'timeout-fanout' && row.id === 'B') return 'limit';
  if (row.id === 'C' && fixture.cases.some((candidate) => candidate.limitReasons) && stopRoute(route)) return 'not-run';
  if (row.limitReasons) return 'limit';
  return 'completed';
}

function pythonTransportClock(fixture, route) {
  return fixture.language === 'python' && fixture.name === 'transport' && pythonClockRoute(route);
}

const processProjection = (row) => Object.fromEntries(Object.entries(row ?? {}).filter(([key]) =>
  !['sessionId', 'pid', 'timings', 'startedAt', 'endedAt', 'trace', 'attachment'].includes(key)
));

const traceSchema = 'runtime-trace-2026-04-28';
const refusalReasons = new Map([
  ['no-recorder', ['recorder-unavailable', 'recorder-unavailable']],
  ['observer-compile-fault', ['observer-prepare', 'observer-prepare-failed']],
  ['observer-encoder-fault', ['observer-encode', 'observer-encode-failed']],
  ['observer-deadline', ['observer-timeout', 'observer-timeout']],
]);

function rawAttachment(row) {
  const named = row?.attachment;
  if (named !== undefined) {
    if (named && (named.status === 'drawn' || Object.hasOwn(named, 'reason') ||
        Object.hasOwn(named, 'evaluationId'))) {
      return {
        modern: true,
        status: named.status === 'drawn' ? 'complete'
          : ['truncated', 'refused'].includes(named.status) ? named.status : 'unknown',
        cause: named.reason,
        events: named.status === 'refused' ? (Object.hasOwn(named, 'trace') ? undefined : []) : named.trace?.events,
        attemptedEventCount: named.attemptedEvents,
        binding: {
          evaluationId: named.evaluationId, workspaceDigest: named.workspaceDigest,
          generation: named.generation, caseId: named.caseId,
        },
      };
    }
    return named ?? { status: 'unknown' };
  }
  const budget = row?.diagnostics?.find(({ kind }) => kind === 'trace-truncated')?.code;
  const refuses = row?.diagnostics?.find(({ code }) => code === 'trace-unavailable');
  if (budget) return { status: 'truncated', cause: budget, events: row.trace?.events };
  if (refuses) return { status: 'refused', cause: refuses.cause, events: row.trace?.events };
  if (row?.trace?.events?.length) return { status: 'complete', events: row.trace.events };
  return { status: 'unknown', events: row?.trace?.events };
}

function scopeMatches(left, right) {
  return left.evaluationId === right.evaluationId && left.workspaceDigest === right.workspaceDigest &&
    left.generation === right.generation;
}

function validBinding(attachment, row, sample) {
  if (!attachment.modern) return true;
  const { evaluationId, workspaceDigest, generation, caseId } = attachment.binding;
  const expectedDigest = sample.stimulus?.bundle?.workspaceDigest ?? sample.retainedWorkspaceDigest;
  return typeof evaluationId === 'string' && evaluationId.length > 0 &&
    typeof workspaceDigest === 'string' && workspaceDigest.length > 0 &&
    (expectedDigest === undefined || workspaceDigest === expectedDigest) &&
    Number.isSafeInteger(generation) && generation > 0 && caseId === row.caseId;
}

function recorderEvidence(event) {
  if (Object.hasOwn(event, 'drawing')) {
    const drawing = event.drawing;
    return {
      completed: drawing?.status === 'drawn' || drawing?.status === 'truncated',
      refusal: drawing?.status === 'refused' ? drawing.reason : undefined,
      cut: drawing?.status === 'truncated' ? drawing.reason : undefined,
      attemptedEvents: drawing?.attemptedEvents,
      schemaVersion: drawing?.trace?.schemaVersion,
      events: drawing?.trace?.events,
    };
  }
  return {
    completed: event.recorder?.recorderCompleted === true,
    refusal: event.recorder?.encodeFailed === true ? 'observer-encode' : undefined,
    cut: event.recorder?.cut,
    attemptedEvents: event.recorder?.attemptedEvents,
    schemaVersion: event.schemaVersion,
    events: event.events,
  };
}

// Python normalizes trace payloads at the adapter. Compare stable source
// coordinates and event content across that boundary, in the original order.
function eventProjection(event) {
  return [event?.kind, event?.file, event?.line, event?.sourceSpan?.startLine,
    event?.sourceSpan?.startColumn, event?.sourceSpan?.endLine, event?.sourceSpan?.endColumn,
    event?.function, event?.frameId, event?.statementId, event?.text,
    event?.target?.variable, event?.target?.objectId, event?.value, event?.args,
    Array.isArray(event?.callStack)
      ? event.callStack.map((frame) => [frame?.function, frame?.line, frame?.args])
      : event?.callStack];
}

function checkRecorder(fixture, attachment, witness) {
  const evidence = recorderEvidence(witness);
  if (attachment.status === 'refused') {
    return evidence.refusal === attachment.cause && attachment.events?.length === 0;
  }
  if (!evidence.completed || evidence.refusal || evidence.schemaVersion !== traceSchema ||
      !Array.isArray(evidence.events) || !Array.isArray(attachment.events)) return false;
  const exactEvents = fixture.language === 'python'
    ? isDeepStrictEqual(evidence.events.map(eventProjection), attachment.events.map(eventProjection))
    : isDeepStrictEqual(evidence.events, attachment.events);
  if (!exactEvents) return false;
  const sourceLines = fixture.code.trimEnd().split('\n').length;
  const sourceEvent = attachment.events.some((event) => {
    const line = event?.sourceSpan?.startLine ?? event?.line;
    return event?.kind !== 'timeout' && typeof event?.file === 'string' &&
      Number.isSafeInteger(line) && line > 0 && line <= sourceLines;
  });
  if (attachment.status === 'complete') return evidence.cut === undefined && sourceEvent;
  return attachment.status === 'truncated' && evidence.cut === attachment.cause &&
    Number.isSafeInteger(evidence.attemptedEvents) && evidence.attemptedEvents >= attachment.events.length &&
    evidence.attemptedEvents === attachment.attemptedEventCount &&
    (sourceEvent || (attachment.cause === 'byte-budget' && attachment.events.length === 0 && evidence.attemptedEvents > 0));
}

function completeOrdinaryStarts(events) {
  const dispatch = events.filter(({ kind }) => kind === 'ordinary-dispatch');
  const starts = events.filter(({ kind }) => kind === 'ordinary-start');
  const terminals = events.filter(({ kind }) => kind === 'ordinary-terminal');
  const sameCommand = (left, right) => left.request === right.request &&
    left.commandId === right.commandId && left.generation === right.generation;
  // The generic dispatch entry immediately follows its classified entry in
  // the transport journal. An unclassified code dispatch leaves a gap.
  const unclassified = events.filter((event) => event.kind === 'dispatch' && event.mode !== 'trace' &&
    !dispatch.some((command) => event.sequence === command.sequence + 1 &&
      event.request === command.request && event.generation === command.generation &&
      isDeepStrictEqual(event.rows, command.rows)));
  const complete = dispatch.length > 0 && unclassified.length === 0 &&
    dispatch.every((command) => command.reportsStarts === true &&
      command.commandId !== undefined && Number.isSafeInteger(command.generation) &&
      Array.isArray(command.rows) && command.rows.length && command.rows.every(Boolean) &&
      dispatch.filter((event) => sameCommand(event, command)).length === 1 &&
      coversCommandStarts(command, starts.filter((start) => sameCommand(start, command)),
        terminals.filter((terminal) => sameCommand(terminal, command)))) &&
    starts.every((start) => dispatch.some((command) =>
      sameCommand(start, command) && command.rows[start.index] === start.caseId));
  return { complete, starts, dispatch };
}

function coversCommandStarts(command, starts, terminals) {
  // A plain terminal says nothing about a missing start. A worker can
  // explicitly attest the complete started set on its authenticated reply.
  const reports = terminals.filter((event) => !event.retired && event.startedCaseIndices !== undefined);
  if (reports.length > 1) return false;
  const expected = reports.length ? reports[0].startedCaseIndices : command.rows.map((_, index) => index);
  if (!Array.isArray(expected) || new Set(expected).size !== expected.length ||
      !expected.every((index) => Number.isSafeInteger(index) && index >= 0 && index < command.rows.length)) {
    return false;
  }
  return isDeepStrictEqual(starts.map(({ index }) => index).sort(), [...expected].sort());
}

function sharedPreparationAck(fixture, prior, binding, bind) {
  if (fixture.name !== 'observer-compile-fault' || !binding || !bind ||
      !scopeMatches(bind, binding)) return;
  const acks = prior.filter((event) => event.kind === 'schedule' && event.phase === 'injection-ack' &&
    event.language === fixture.language && event.point === 'prepare' && event.fault === 'prepare' &&
    event.caseId === undefined && event.attemptToken === undefined && scopeMatches(event, binding) &&
    event.sequence < bind.sequence);
  if (acks.length === 1) return acks[0];
}

function checkCorrelatedContinuation(fixture, route, sample, published, wire, assert) {
  const prior = sample.retainedEvidence ?? [];
  const initial = prior.filter(({ request }) => request === 'run-first');
  const initialOrdinary = completeOrdinaryStarts(initial);
  const expectedInitial = fixture.cases.filter((row) => desiredRow(fixture, 'run-first', row) !== 'not-run');
  if (!initialOrdinary.complete || !isDeepStrictEqual(
    initialOrdinary.starts.map(({ caseId }) => caseId).sort(), expectedInitial.map(({ id }) => id).sort(),
  )) return;

  const selected = drawingRows(fixture, route);
  if (selected.length !== 1 || published.length !== 1) return;
  const row = published[0];
  const attachment = rawAttachment(row);
  const commit = initial.find(({ kind, phase }) => kind === 'schedule' && phase === 'ordinary-commit');
  if (row.caseId !== selected[0].id || !attachment.modern || !validBinding(attachment, row, sample) ||
      !commit || !scopeMatches(attachment.binding, commit)) return;

  const resolves = wire.filter(({ kind, phase }) => kind === 'schedule' && phase === 'public-resolve');
  if (resolves.length !== 1 || !scopeMatches(resolves[0], commit)) return;
  const redraw = route.startsWith('repeat-');
  const observation = redraw ? prior : wire;
  const binds = observation.filter(({ kind, phase, caseId }) =>
    kind === 'schedule' && phase === 'attachment-bind' && caseId === row.caseId);
  if (binds.length !== 1) return;
  const [bind] = binds;
  if (!scopeMatches(bind, commit) || typeof bind.attemptToken !== 'string' || !bind.attemptToken ||
      !(commit.sequence < bind.sequence && bind.sequence < resolves[0].sequence)) return;
  const replies = observation.filter(({ kind, attemptToken, caseId, request, sequence }) =>
    kind === 'observer-reply' && caseId === row.caseId && request === bind.request &&
    attemptToken === bind.attemptToken && sequence < bind.sequence);
  const preparationAck = attachment.status === 'refused' && attachment.cause === 'observer-prepare' &&
    sharedPreparationAck(fixture, prior, attachment.binding, bind);
  if (preparationAck ? replies.length !== 0 : replies.length !== 1) return;
  const hits = wire.filter((event) => event.kind === 'schedule' && event.phase === 'observation-cache-hit' &&
    event.caseId === row.caseId && event.attemptToken === bind.attemptToken && scopeMatches(event, commit) &&
    bind.sequence < event.sequence && event.sequence < resolves[0].sequence);
  if (redraw && hits.length !== 1) return;

  const { complete, starts, dispatch } = completeOrdinaryStarts(wire);
  // Outbound dispatches are recorded before any worker progress. A command
  // with no start ACK still prevents a zero-start proof.
  const hasDispatch = dispatch.length > 0 || wire.some(({ kind, observationOnly }) =>
    kind === 'dispatch' && !(fixture.language === 'java' && observationOnly === true));
  if (hasDispatch && !starts.length && !complete) return;
  assert('ordinary-start-count', starts.length === 0 && !hasDispatch,
    { expectedStarts: [], starts, dispatch, observerReply: replies[0], cacheHit: hits[0], preparationAck });
}

function javaBoundObserverReplies(attachment, evidence, route) {
  if (!attachment.modern) return [];
  const { caseId } = attachment.binding;
  const binds = evidence.filter((event) => event.kind === 'schedule' && event.phase === 'attachment-bind' &&
    event.caseId === caseId && typeof event.attemptToken === 'string' && scopeMatches(event, attachment.binding));
  if (binds.length !== 1) return [];
  const [bind] = binds;
  if (bind.request !== route && !evidence.some((event) =>
    event.kind === 'schedule' && event.phase === 'observation-cache-hit' && event.request === route &&
    event.caseId === caseId && event.attemptToken === bind.attemptToken &&
    event.sequence > bind.sequence && scopeMatches(event, attachment.binding))) return [];
  return evidence.filter((event) => event.kind === 'observer-reply' && event.request === bind.request &&
    event.caseId === caseId && event.attemptToken === bind.attemptToken && event.sequence < bind.sequence);
}

function checkObservation(fixture, route, sample, rows, published, assert) {
  if (!route.startsWith('run-') && !continuation(route) && route !== 'submit-traced') return;
  const wire = (sample.transcript ?? []).filter((event) => event.request === route);
  const prior = sample.retainedEvidence ?? [];
  const marks = wire.filter((event) => event.kind === 'schedule');
  const selected = drawingRows(fixture, route);
  const modern = sample.registeredReceiptPath || published.some((row) => rawAttachment(row).modern) || marks.length > 0;
  if (!modern) return;

  const starts = wire.filter((event) => event.kind === 'ordinary-start');
  const dispatch = wire.filter((event) => event.kind === 'ordinary-dispatch');
  const expectedStarts = continuation(route) ? []
    : rows.filter((row) => desiredRow(fixture, route, row) !== 'not-run').map((row) => row.id);
  const cacheHit = marks.some(({ phase, caseId }) => phase === 'observation-cache-hit' &&
    selected.some(({ id }) => id === caseId));
  const observerReply = wire.some(({ kind, caseId }) => kind === 'observer-reply' &&
    selected.some(({ id }) => id === caseId));
  const wrongStart = starts.some((event) => !expectedStarts.includes(event.caseId)) ||
    new Set(starts.map(({ caseId }) => caseId)).size !== starts.length;
  const startCoverage = fixture.language === 'java' ? completeOrdinaryStarts(wire).complete
    : dispatch.length > 0 && dispatch.every(({ reportsStarts }) => reportsStarts === true);
  const observableContinuation = fixture.language === 'python' ||
    (fixture.language === 'cpp' && (observerReply || prior.some(({ kind }) => kind === 'observer-reply')));
  if (continuation(route) && ['javascript', 'typescript', 'java'].includes(fixture.language)) {
    checkCorrelatedContinuation(fixture, route, sample, published, wire, assert);
  } else if (wrongStart || startCoverage || (continuation(route) &&
      (dispatch.length > 0 || (observableContinuation && (observerReply || cacheHit))))) {
    assert('ordinary-start-count', !wrongStart && (!continuation(route) || dispatch.length === 0) &&
      isDeepStrictEqual(starts.map(({ caseId }) => caseId).sort(), [...expectedStarts].sort()),
    { expectedStarts, starts, dispatch, observerReply, cacheHit });
  }

  if (!marks.length) return;
  const resolve = marks.filter(({ phase }) => phase === 'public-resolve');
  const commits = marks.filter(({ phase }) => phase === 'ordinary-commit');
  const retainedCommits = prior.filter(({ kind, phase }) => kind === 'schedule' && phase === 'ordinary-commit');
  const commit = continuation(route) ? retainedCommits[0] : commits[0];
  const writes = marks.filter(({ phase }) => phase === 'ordinary-write-attempt');
  const expectedWrites = continuation(route) ? [] : published.map(({ caseId }) => caseId);
  const sameScope = !!commit && marks.every((marker) => scopeMatches(marker, commit));
  const noObserverWrites = !marks.some(({ phase, origin }) =>
    phase === 'observer-write-attempt' || (phase === 'ordinary-write-attempt' && origin === 'observer'));
  assert('observer-grade-writes', sameScope && resolve.length === 1 && noObserverWrites &&
    isDeepStrictEqual(writes.map(({ caseId }) => caseId).sort(), [...expectedWrites].sort()) &&
    writes.every((event) => event.sequence < commit.sequence),
  { expectedWrites, writes, marks });

  const binds = [...prior, ...wire].filter(({ kind, phase }) => kind === 'schedule' && phase === 'attachment-bind');
  const selectedIds = selected.map(({ id }) => id);
  const currentBinds = marks.filter(({ phase }) => phase === 'attachment-bind');
  const matchesSelected = sameScope && resolve.length === 1 && selectedIds.every((caseId) => {
    const row = published.find((entry) => entry.caseId === caseId);
    const attachment = rawAttachment(row);
    const caseBinds = binds.filter((event) => event.caseId === caseId);
    return attachment.modern && validBinding(attachment, row, sample) &&
      scopeMatches(attachment.binding, commit) && caseBinds.length === 1 &&
      scopeMatches(caseBinds[0], commit) && commit.sequence < caseBinds[0].sequence &&
      caseBinds[0].sequence < resolve[0].sequence;
  });
  assert('ordinary-before-observer', sameScope && resolve.length === 1 &&
    commits.length === (continuation(route) ? 0 : 1) &&
    (!continuation(route) || retainedCommits.length === 1) &&
    commit.sequence < resolve[0].sequence && currentBinds.every(({ caseId }) => selectedIds.includes(caseId)) &&
    matchesSelected, { commit, marks });
}

function matchesAnchor(fixture, target, attachment) {
  const n = target.input.n;
  return Array.isArray(attachment.events) && attachment.events.some((event) => {
    const line = event?.sourceSpan?.startLine ?? event?.line;
    if (line !== fixture.anchor) return false;
    if (fixture.name === 'json-element') {
      return event.target?.variable === 'element' || event.locals?.element !== undefined;
    }
    return event.kind === 'stdout' && Array.isArray(event.callStack) && event.callStack.at(-1)?.args?.n === n &&
      (event.text === String(n) || event.text === target.stdout);
  });
}

export function ledgerFor(fixture, route, sample) {
  const prefix = [fixture.gate, fixture.language, fixture.name, route].join('/');
  const inventory = required(fixture, route);
  const step8 = 'mux/stored-receipt';
  const step8Owned = inventory.includes(step8) ? [`${prefix}/${step8}`] : [];
  const receipts = [];
  const seen = new Set();
  function assert(id, passed, actual) {
    if (!inventory.includes(id) || seen.has(id)) throw new Error(`Unexpected assertion ${prefix}/${id}`);
    seen.add(id);
    receipts.push({ id: `${prefix}/${id}`, status: passed ? 'passed' : 'failed', actual });
  }
  if (sample && !sample.unavailable && (route !== 'mux-shape' || sample.muxAdapter)) {
    check(fixture, route, sample, assert);
  }
  return {
    expected: inventory.map((id) => `${prefix}/${id}`),
    receipts,
    missing: inventory.filter((id) => id !== step8 && !seen.has(id)).map((id) => `${prefix}/${id}`),
    step8Owned,
  };
}

function checkJavaTransport(fixture, route, sample, published, wire, assert) {
  const releases = wire.filter(({ kind }) => kind === 'java-release');
  const command = releases[0];
  const sameCommand = (event) => command.commandId === event.commandId &&
    command.generation === event.generation && command.admissionId === event.admissionId;
  const starts = wire.filter(({ kind }) => kind === 'ordinary-start');
  const finishes = wire.filter(({ kind }) => kind === 'ordinary-finish');
  const forwarded = wire.filter(({ kind }) => kind === 'forwarded-progress');
  const hits = wire.filter(({ kind, fault }) => kind === 'injection' && fault === route);
  const hit = hits[0];
  const ids = fixture.cases.map(({ id }) => id);
  const timeout = route === 'timeout-fanout';
  const expectedStarts = timeout ? ids : route.startsWith('during-') ? ids.slice(0, 2) : ids.slice(0, 1);
  const expectedFinishes = timeout ? ids : ids.slice(0, 1);
  const idsOf = (events) => events.map(({ caseId }) => caseId);
  const beforeFault = (event) => hit && sameCommand(event) && event.sequence < hit.sequence;
  const validRelease = Number.isSafeInteger(command.admissionId) && command.admissionId > 0 &&
    releases.every(beforeFault) && isDeepStrictEqual(
    releases.map(({ rows }) => rows), timeout ? [ids] : expectedStarts.map((id) => [id]),
  );
  const validProgress = (event, phase) => beforeFault(event) &&
    ids[event.index] === event.caseId && releases.some((release) =>
      release.rows.includes(event.caseId) && release.sequence < event.sequence) &&
    forwarded.filter((delivery) => beforeFault(delivery) && delivery.phase === phase &&
      delivery.caseId === event.caseId && delivery.index === event.index &&
      delivery.sequence > event.sequence).length === 1;
  const orderedFinishes = finishes.every((finish, index) =>
    starts[index]?.caseId === finish.caseId && starts[index].sequence < finish.sequence &&
    (!starts[index + 1] || forwarded.some((delivery) => delivery.caseId === finish.caseId &&
      delivery.phase === 'finished' && delivery.sequence < starts[index + 1].sequence)));
  const witnessedProgress = validRelease && isDeepStrictEqual(idsOf(starts), expectedStarts) &&
    starts.every((event) => validProgress(event, 'started')) &&
    isDeepStrictEqual(idsOf(finishes), expectedFinishes) &&
    finishes.every((event) => validProgress(event, 'finished')) && orderedFinishes &&
    forwarded.length === starts.length + finishes.length;
  if (hit || wire.some(({ kind }) => kind === 'test-transport-failure')) {
    const triggeredDeadline = !timeout || wire.some(({ kind, delays, sequence }) =>
      kind === 'production-timers-fired' && sequence > hit?.sequence && isDeepStrictEqual(delays, [132000]));
    const terminal = wire.find(({ kind }) => kind === 'worker-reply');
    const wholeBatch = !timeout || (terminal && beforeFault(terminal) &&
      (terminal.payload?.resultsStreamed === finishes.length || isDeepStrictEqual(
        terminal.payload?.results, finishes.map(({ result }) => result),
      )));
    assert('injection-ack', hits.length === 1 && sameCommand(hit) && witnessedProgress &&
      wholeBatch && triggeredDeadline && !wire.some(({ kind }) => kind === 'test-transport-failure'),
    { releases, starts, finishes, forwarded, hits, terminal, triggeredDeadline });
  }
  if (validRelease) {
    for (const id of ids) {
      const entries = starts.filter(({ caseId }) => caseId === id);
      assert(`${id}/start-proof`, entries.length === Number(expectedStarts.includes(id)) &&
        entries.every((event) => validProgress(event, 'started')), { releases, entries });
    }
  }
  const dispatch = wire.filter(({ kind }) => kind === 'ordinary-dispatch');
  const oneCommand = dispatch.length === 1 && dispatch[0].commandId === command.commandId &&
    dispatch[0].generation === command.generation && dispatch[0].reportsStarts === true &&
    isDeepStrictEqual(dispatch[0].rows, ids);
  const aStarts = starts.filter(({ caseId }) => caseId === 'A');
  if (aStarts.length) {
    assert('A/ordinary-start-count', oneCommand && aStarts.length === 1 &&
      validProgress(aStarts[0], 'started'), { dispatch, starts: aStarts });
  }
  const aFinishes = finishes.filter(({ caseId }) => caseId === 'A');
  const aFinish = aFinishes[0];
  if (aFinish) {
    assert('A/worker-finish', aFinishes.length === 1 && validProgress(aFinish, 'finished') &&
      aFinish.result.success === true && isDeepStrictEqual(aFinish.result.output, fixture.cases[0].actual) &&
      aStarts[0]?.sequence < aFinish.sequence, aFinishes);
  }

  if (hit && validRelease && serviceCut(fixture, route)) {
    assert('generation-fence', oneCommand && witnessedProgress &&
      forwarded.every(beforeFault), { dispatch, starts, finishes, forwarded });
  }
  const marks = wire.filter(({ kind, language }) => kind === 'schedule' && language === 'java');
  const commits = marks.filter(({ phase }) => phase === 'ordinary-commit');
  const writes = marks.filter(({ phase }) => phase === 'ordinary-write-attempt');
  const resolves = marks.filter(({ phase }) => phase === 'public-resolve');
  if (!marks.length || !aFinish || !hit) return;
  // Delivery happened before loss; the Judge journal witnesses the later seal.
  const commit = commits[0];
  const stored = commits.length === 1 && hit.sequence < commit.sequence &&
    resolves.length === 1 && commit.sequence < resolves[0].sequence &&
    commit.workspaceDigest === sample.result?.workspaceDigest &&
    marks.every((event) => scopeMatches(event, commit)) &&
    isDeepStrictEqual(idsOf(writes), ids) &&
    writes.every(({ sequence, origin }) => hit.sequence < sequence &&
      sequence < commit.sequence && origin !== 'observer');
  const a = published.find(({ caseId }) => caseId === 'A');
  const retained = a?.status === 'completed' && isDeepStrictEqual(a.value, aFinish.result.output) &&
    a.verdict?.kind === fixture.cases[0].grade && a.stdout === fixture.cases[0].stdout &&
    a.stderr === '' && a.termination?.kind === 'exit' && a.termination.exitCode === 0 &&
    validProgress(aFinish, 'finished');
  assert('A/coordinator-commit', stored && retained, { commit, writes, resolves, a, aFinish });
  if (serviceCut(fixture, route)) {
    const suffix = ids.slice(1).map((id) => published.find(({ caseId }) => caseId === id));
    const conversions = sample.conversions?.cases;
    if (conversions) {
      assert('suffix/storage', stored && suffix.every((row) => row?.failure?.origin === 'provider' &&
        row.verdict?.kind === 'not-evaluated' && row.timedOut === false &&
        row.notRun === undefined && !Object.hasOwn(row, 'value') &&
        conversions[published.indexOf(row)]?.rejected?.name === 'RuntimeProviderError'), { suffix, commits, writes });
    }
  }
}

function checkPythonClock(fixture, route, sample, published, wire, assert) {
  const ofKind = (kind) => wire.filter((event) => event.kind === kind);
  const timeout = route === 'timeout-fanout';
  if (!timeout) {
    const limits = sample.stimulus?.bundle.execution.limits;
    assert('clock/omitted-wall-budget', !!sample.stimulus && limits?.wallClockMs === undefined &&
      !('stopAtFirstRunaway' in sample.stimulus), limits);
  }
  const commands = ofKind('python-clock-command');
  if (!commands.length) return;
  const [initial, resumed] = commands;
  const starts = ofKind('python-clock-start');
  const finishes = ofKind('python-clock-finish');
  const terminals = ofKind('python-clock-terminal');
  const armed = ofKind('python-case-timer-armed');
  const cleared = ofKind('python-case-timer-cleared');
  const fired = ofKind('python-case-timer-fired');
  const hits = ofKind('injection');
  const [hit] = hits;
  const ids = fixture.cases.map(({ id }) => id);
  const idsOf = (events) => events.map(({ caseId }) => caseId);
  const sameCommand = (command, event) => command && command.commandId === event.commandId &&
    command.generation === event.generation;
  const exactlyDispatched = commands.every(({ reportsProgress }) => reportsProgress) &&
    isDeepStrictEqual(commands.map(({ rows }) => rows), timeout ? [ids, ['C']] : [ids]) &&
    ofKind('ordinary-dispatch').length === commands.length;
  const startsInOrder = isDeepStrictEqual(idsOf(starts), ids) && starts.every((event, index) => {
    const resumedC = timeout && event.caseId === 'C';
    return sameCommand(resumedC ? resumed : initial, event) && event.index === (resumedC ? 0 : index);
  });
  const finishedIds = timeout ? ['A', 'C'] : ids;
  const finishedInOrder = isDeepStrictEqual(idsOf(finishes), finishedIds) && finishes.every((finish) => {
    const index = ids.indexOf(finish.caseId);
    const start = starts[index];
    return start && sameCommand(start, finish) && start.index === finish.index &&
      start.sequence < finish.sequence && (!starts[index + 1] || finish.sequence < starts[index + 1].sequence) &&
      finish.result?.success === true && isDeepStrictEqual(finish.result.output, fixture.cases[index].actual);
  });
  const [terminal] = terminals;
  const streamed = terminals.length === 1 && sameCommand(timeout ? resumed : initial, terminal) &&
    terminal.type === 'execute-result' && terminal.hasResults === false &&
    terminal.resultsStreamed === (timeout ? 1 : ids.length) && finishes.at(-1)?.sequence < terminal.sequence;
  const caseTimers = isDeepStrictEqual(idsOf(armed), ids) && armed.every((timer, index) =>
    sameCommand(starts[index], timer) && starts[index].sequence < timer.sequence &&
    timer.delay === (index === 2 && timeout ? resumed?.expectedDelay : initial.expectedDelay));
  const clearedFinishes = isDeepStrictEqual(idsOf(cleared), finishedIds) && finishedIds.every((id, index) =>
    sameCommand(finishes[index], cleared[index]) && cleared[index].sequence > finishes[index].sequence);

  let clockWitness;
  if (timeout) {
    const [bTimer] = fired;
    const retired = ofKind('python-clock-worker-retired').find((event) => sameCommand(initial, event));
    clockWitness = fired.length === 1 && bTimer.caseId === 'B' && bTimer.delay === 5000 &&
      sameCommand(initial, bTimer) && !!resumed && resumed.generation > initial.generation &&
      hit?.caseId === 'B' && sameCommand(initial, hit) && armed[1]?.sequence < hit.sequence &&
      hit.sequence < bTimer.sequence && bTimer.sequence < retired?.sequence && retired.sequence < resumed.sequence;
  } else {
    const advances = ofKind('advance-clock');
    clockWitness = fired.length === 0 && isDeepStrictEqual(idsOf(advances), ids) &&
      isDeepStrictEqual(advances.map(({ virtualTime }) => virtualTime), [11000, 22000, 33000]) &&
      advances.every((advance, index) => sameCommand(initial, advance) && advance.delta === 11000 &&
        armed[index]?.delay > advance.delta && armed[index].sequence < advance.sequence &&
        advance.sequence < finishes[index]?.sequence);
    assert('clock/three-advances', caseTimers && clearedFinishes && clockWitness && streamed,
      { advances, armed, cleared, fired, terminals });
  }
  assert('injection-ack', exactlyDispatched && hits.length === 1 && hit.fault === route &&
    startsInOrder && finishedInOrder && streamed && caseTimers && clearedFinishes && clockWitness &&
    !ofKind('test-transport-failure').length,
  { commands, starts, finishes, terminals, hits, armed, cleared, fired });
  for (const [index, id] of ids.entries()) {
    const matches = starts.filter(({ caseId }) => caseId === id);
    if (matches.length) {
      const expectedCommand = timeout && id === 'C' ? resumed : initial;
      assert(`${id}/start-proof`, matches.length === 1 && sameCommand(expectedCommand, matches[0]) &&
        matches[0].index === (expectedCommand === resumed ? 0 : index), matches);
    }
  }
  const aStarts = starts.filter(({ caseId }) => caseId === 'A');
  if (aStarts.length) {
    assert('A/ordinary-start-count', exactlyDispatched && aStarts.length === 1 && sameCommand(initial, aStarts[0]),
      { commands, starts });
  }
  const aFinishes = finishes.filter(({ caseId }) => caseId === 'A');
  const [aFinish] = aFinishes;
  if (!aFinish) return;
  const aFinished = aFinishes.length === 1 && sameCommand(initial, aFinish) &&
    aStarts[0]?.sequence < aFinish.sequence && aFinish.result?.success === true &&
    isDeepStrictEqual(aFinish.result.output, fixture.cases[0].actual);
  assert('A/worker-finish', aFinished, aFinishes);
  const marks = ofKind('schedule').filter(({ language }) => language === 'python');
  if (!marks.length) return;
  const commits = marks.filter(({ phase }) => phase === 'ordinary-commit');
  const resolves = marks.filter(({ phase }) => phase === 'public-resolve');
  const writes = marks.filter(({ phase }) => phase === 'ordinary-write-attempt');
  const [commit] = commits;
  const a = published.find(({ caseId }) => caseId === 'A');
  assert('A/coordinator-commit', aFinished && a?.status === 'completed' &&
    isDeepStrictEqual(a.value, aFinish.result.output) && a.verdict?.kind === fixture.cases[0].grade &&
    a.stdout === fixture.cases[0].stdout && a.stderr === '' &&
    commits.length === 1 && resolves.length === 1 && aFinish.sequence < commit.sequence &&
    commit.sequence < resolves[0].sequence && commit.workspaceDigest === sample.result?.workspaceDigest &&
    marks.every((event) => scopeMatches(event, commit)) && isDeepStrictEqual(idsOf(writes), ids),
  { a, aFinish, commits, writes, resolves });
}

function check(fixture, route, sample, assert) {
  const rows = selectedRows(fixture, route);
  const receipt = sample.result;
  const evaluation = receipt?.evaluation;
  const published = evaluation?.cases ?? [];
  const wire = sample.transcript ?? [];
  const compile = evaluation?.compile ?? sample.retainedCompile;
  assert('compile', compile?.status === 'compiled' && evaluation?.status === 'completed', compile ?? sample.rejection);
  assert('order', isDeepStrictEqual(published.map((row) => row.caseId), rows.map((row) => row.id)), published.map((row) => row.caseId));
  if (evaluation) {
    const keysValid = published.every((row) => typeof row.sessionId === 'string' && Number.isInteger(row.pid));
    const bundle = sample.stimulus?.bundle;
    const matchingReference = continuation(route)
      ? typeof sample.retainedExecutionId === 'string' &&
        (receipt.executionId === undefined || receipt.executionId === sample.retainedExecutionId)
      : route.startsWith('run-')
        ? evaluation.status === 'compile-failed' ? receipt.executionId === undefined : typeof receipt.executionId === 'string'
        : receipt.bundleId === bundle?.id && receipt.workspaceDigest === bundle?.workspaceDigest;
    const selected = new Set(drawingRows(fixture, route).map(({ id }) => id));
    const onReceiptPath = sample.registeredReceiptPath || published.some((row) => rawAttachment(row).modern);
    const attachments = published.filter((row) => Object.hasOwn(row, 'attachment'));
    const binding = rawAttachment(attachments[0]).binding;
    const boundSelection = fixture.gate !== 'G5' || !onReceiptPath ||
      (attachments.length === selected.size && attachments.every((row) => {
        const attachment = rawAttachment(row);
        return attachment.modern && selected.has(row.caseId) && validBinding(attachment, row, sample) &&
          scopeMatches(attachment.binding, binding);
      }));
    const mux = sample.muxAdapter;
    const muxCorrelated = route !== 'mux-shape' || /^[0-9a-f]{40}$/u.test(mux.muxPin) &&
      mux.response?.status === 'completed' && mux.response?.requestId === bundle?.id &&
      isDeepStrictEqual(mux.request, { requestId: bundle?.id, bundle }) &&
      isDeepStrictEqual(mux.response.result, receipt) &&
      receipt.schema === 'tracecode.judge.algorithm-receipt.v1';
    assert('correlation', keysValid && matchingReference && boundSelection && muxCorrelated, {
      bundleId: receipt.bundleId, workspaceDigest: receipt.workspaceDigest,
      executionId: receipt.executionId, retainedExecutionId: sample.retainedExecutionId,
      ...(mux ? { muxPin: mux.muxPin, muxRequestId: mux.response?.requestId } : {}),
    });
  }
  if (!route.startsWith('run-') && !continuation(route)) {
    const passed = rows.filter((row) => desiredRow(fixture, route, row) === 'completed').length;
    const verdict = serviceCut(fixture, route) ? 'indeterminate' : passed === rows.length ? 'passed' : 'failed';
    const ok = verdict === 'indeterminate' ? 'unknown' : verdict === 'passed';
    assert('aggregate', receipt?.verdict === verdict && receipt?.policy?.result === ok, [receipt?.verdict, receipt?.policy]);
    assert('counts', receipt?.passedCount === passed && receipt?.totalCount === rows.length, [receipt?.passedCount, receipt?.totalCount]);
  }
  if (fixture.noInterruptBuffer) {
    assert('interrupt-unavailable', sample.crossOriginIsolated === false, sample.crossOriginIsolated);
  }

  const javaTransport = fixture.language === 'java' && fixture.name === 'transport' &&
    wire.some(({ kind, request }) => kind === 'java-release' && request === route);
  const pythonClock = pythonTransportClock(fixture, route);
  const ordinary = fixture.gate === 'G4' && !continuation(route) && !javaTransport && !pythonClock
    ? completeOrdinaryStarts(wire.filter(({ request }) => request === route)) : undefined;
  for (const expected of rows) {
    const row = published.find(({ caseId }) => caseId === expected.id);
    const status = desiredRow(fixture, route, expected);
    if (row) {
      const rowOracle = pythonClock && status === 'limit'
        ? { ...expected, limitReasons: ['client-timeout'] } : expected;
      checkRow(fixture, rowOracle, row, status, published, sample.conversions?.cases?.[published.indexOf(row)], assert, sample);
    }
    if (expected.limitReasons && row) {
      const reason = row.failure?.reason;
      const hasStart = ordinary?.starts.some((event) => event.caseId === expected.id) ||
        wire.some((event) => event.kind === 'worker-started' && event.caseId === expected.id);
      const isClockProbe = fixture.noInterruptBuffer === true;
      const delivered = wire.some((event) => event.kind === 'dispatch' && event.rows.includes(expected.id));
      if (hasStart || (isClockProbe && delivered)) {
        const matchesSingleton = reason === sample.singletonGuard ||
          (fixture.name !== singleLineFixture && !sample.singletonGuard);
        assert(`${expected.id}/learner-guard`, row.failure?.origin === 'limit' &&
          expected.limitReasons.includes(reason) && matchesSingleton,
        { reason, singleton: sample.singletonGuard, hasStart });
      }
    }
    if (ordinary) {
      if (status === 'not-run') {
        const admitted = rows.filter((candidate) => desiredRow(fixture, route, candidate) !== 'not-run');
        const started = ordinary.starts.some(({ caseId }) => caseId === expected.id);
        const traceDispatched = wire.some((event) => event.request === route && event.kind === 'dispatch' &&
          event.mode === 'trace' && event.rows.includes(expected.id));
        const covered = evaluation?.status === 'completed' && ordinary.complete && !traceDispatched &&
          admitted.every(({ id }) => ordinary.starts.some(({ caseId }) => caseId === id));
        if (started || covered) {
          assert(`${expected.id}/start-proof`, !started, ordinary);
        }
      } else if (status !== 'unavailable') {
        const correlated = ordinary.starts.filter(({ caseId }) => caseId === expected.id);
        const starts = correlated.length ? correlated : wire.filter((event) =>
          event.kind === 'worker-started' && event.caseId === expected.id && event.mode === 'code');
        if (starts.length) assert(`${expected.id}/start-proof`, starts.length === 1, starts);
      }
    }
  }

  if (pythonClock) {
    checkPythonClock(fixture, route, sample, published, wire.filter(({ request }) => request === route), assert);
  } else if (javaTransport) {
    checkJavaTransport(fixture, route, sample, published, wire.filter(({ request }) => request === route), assert);
  } else if (fixture.name === 'transport' && route !== 'submit-stop') {
    const hit = wire.filter((event) => event.kind === 'injection' && event.fault === route);
    const starts = wire.filter((event) => event.caseId === 'A' && event.kind === 'worker-started');
    const replay = wire.filter((event) => event.kind === 'dispatch' && event.rows.includes('A') && event.generation > (starts[0]?.generation ?? -1));
    const aFinish = wire.filter((event) => event.caseId === 'A' && event.kind === 'subbatch-reply');
    if (hit.length || wire.some((event) => event.kind === 'test-transport-failure')) {
      assert('injection-ack', hit.length === 1 && aFinish.length === 1 &&
        !wire.some((event) => event.kind === 'test-transport-failure'), hit);
    }
    if (starts.length) assert('A/ordinary-start-count', starts.length + replay.length === 1, { starts, replay });
    if (aFinish.length) assert('A/worker-finish', aFinish.length === 1, aFinish);
  }

  if (fixture.gate === 'G5') {
    checkObservation(fixture, route, sample, rows, published, assert);
    for (const expected of drawingRows(fixture, route)) {
      const row = published.find(({ caseId }) => caseId === expected.id);
      if (!row) continue;
      const attachment = rawAttachment(row);
      const label = expected.id;
      const bound = validBinding(attachment, row, sample);
      const refusedFault = refusalReasons.has(fixture.name) && label === 'A';
      const currentEvidence = wire.filter((event) => event.request === route);
      const sharedPreparation = fixture.name === 'observer-compile-fault' && continuation(route);
      const cacheHit = currentEvidence.some(({ kind, phase, caseId, attemptToken }) =>
        kind === 'schedule' && phase === 'observation-cache-hit' && caseId === label &&
        typeof attemptToken === 'string');
      const evidence = cacheHit ? [...(sample.retainedEvidence ?? []), ...currentEvidence] : currentEvidence;
      const java = fixture.language === 'java';
      const replies = java ? javaBoundObserverReplies(attachment, evidence, route)
        : evidence.filter(({ kind, caseId }) => kind === 'observer-reply' && caseId === label);
      const recorder = replies.length === 1 && bound && checkRecorder(fixture, attachment, replies[0]);
      const injection = schedulerInjection(fixture.name);
      const faultAcks = currentEvidence.filter(({ kind, phase }) => kind === 'schedule' && phase === 'injection-ack');
      const ack = faultAcks[0];
      const recorderDisableWitness = injection?.fault !== 'no-recorder' || (replies.length === 1 &&
        replies[0].recorderDisabled === true && replies[0].drawing?.status === 'refused' &&
        replies[0].drawing.reason === 'recorder-unavailable' && replies[0].attemptToken === ack?.attemptToken &&
        replies[0].sequence < ack?.sequence);
      const faultAck = faultAcks.length === 1 && injection && recorderDisableWitness && ack.fault === injection.fault &&
        ack.point === injection.point && ack.language === fixture.language &&
        !!attachment.binding && scopeMatches(ack, attachment.binding) &&
        (ack.point === 'prepare' ? ack.caseId === undefined && ack.attemptToken === undefined
          : ack.caseId === label && typeof ack.attemptToken === 'string' && currentEvidence.some((event) =>
            event.kind === 'schedule' && event.phase === 'attachment-bind' && event.caseId === label &&
            event.attemptToken === ack.attemptToken && scopeMatches(event, ack) && event.sequence > ack.sequence));
      if (fixture.name === 'step-cap' || fixture.name === 'byte-cap') {
        const step = fixture.name === 'step-cap';
        const reason = attachment.modern ? (step ? 'step-budget' : 'byte-budget')
          : (step ? 'trace-limit' : 'trace-byte-limit');
        assert(`${label}/attachment-status`, bound && attachment.status === 'truncated' &&
          attachment.cause === reason, attachment);
        const referenceRow = sample.prefixReference?.evaluation?.cases?.find(({ caseId }) => caseId === label);
        const reference = rawAttachment(referenceRow);
        const referenceRoute = `${route}:reference`;
        const referenceReplies = java ? javaBoundObserverReplies(reference, wire, referenceRoute)
          : wire.filter(({ kind, request, caseId }) =>
            kind === 'observer-reply' && request === referenceRoute && caseId === label);
        if (step && replies.length && referenceReplies.length) {
          const actual = attachment.events?.map(eventProjection);
          const longer = reference.events?.map(eventProjection);
          const rawPrefix = replies[0].javaEvents;
          const rawReference = referenceReplies[0].javaEvents;
          const rawPrefixMatches = !java || (Array.isArray(rawPrefix) && Array.isArray(rawReference) &&
            rawPrefix.length > 0 && rawReference.length > rawPrefix.length &&
            isDeepStrictEqual(rawPrefix, rawReference.slice(0, rawPrefix.length)));
          assert(`${label}/real-prefix`, recorder && attachment.status === 'truncated' &&
            attachment.cause === reason && referenceReplies.length === 1 && rawPrefixMatches &&
            reference.modern && validBinding(reference, referenceRow, {
              retainedWorkspaceDigest: sample.prefixReference?.bundleDigest,
            }) && checkRecorder(fixture, reference, referenceReplies[0]) &&
            actual.length > 0 && longer.length > actual.length &&
            attachment.attemptedEventCount > actual.length &&
            isDeepStrictEqual(actual, longer.slice(0, actual.length)), { attachment, reference, replies, referenceReplies });
        }
        if (!step && (replies.length || (!attachment.modern && attachment.attemptedEventCount !== undefined))) {
          assert(`${label}/attempted-events`, (!attachment.modern || recorder) &&
            Number.isSafeInteger(attachment.attemptedEventCount) && attachment.attemptedEventCount > 0 &&
            attachment.events?.length === 0, { attachment, replies });
        }
      } else {
        const reasonIndex = attachment.modern ? 0 : 1;
        const reason = refusalReasons.get(fixture.name)?.[reasonIndex];
        const complete = attachment.status === 'complete' && Array.isArray(attachment.events) && attachment.events.length > 0;
        const validRefusal = attachment.status === 'refused' && attachment.events?.length === 0;
        const realWitnessCause = fixture.name === 'json-element' ? refusalReasons.get('observer-encoder-fault')[reasonIndex]
          : fixture.name === 'trace-compile' ? refusalReasons.get('observer-compile-fault')[reasonIndex]
          : undefined;
        const accepted = refusedFault || sharedPreparation ? validRefusal && attachment.cause === reason
          : attachment.modern && row.status === 'not-run' ? validRefusal && attachment.cause === 'case-not-run'
          : complete || (!!realWitnessCause && validRefusal && attachment.cause === realWitnessCause);
        assert(`${label}/attachment-status`, bound && accepted, attachment);
        if (refusedFault && (faultAcks.length || !attachment.modern)) {
          assert('A/provenance', bound && validRefusal && attachment.cause === reason &&
            (!attachment.modern || faultAck), { attachment, faultAcks });
        }
        if (refusedFault && faultAcks.length) {
          assert('A/injection-ack', faultAck, faultAcks);
        }
      }
      if (sharedPreparation && fixture.anchor) {
        const refused = bound && attachment.status === 'refused' && attachment.cause === 'observer-prepare' &&
          attachment.events?.length === 0;
        assert(`${label}/anchor`, refused, attachment);
        const bind = currentEvidence.find((event) => event.kind === 'schedule' && event.phase === 'attachment-bind' &&
          event.caseId === label && typeof event.attemptToken === 'string');
        const prepareAck = sharedPreparationAck(fixture, sample.retainedEvidence ?? [], attachment.binding, bind);
        if (prepareAck) {
          assert(`${label}/recorder-boundary`, refused && !replies.length && !currentEvidence.some((event) =>
            event.kind === 'schedule' && event.phase === 'observer-start' && event.caseId === label),
          { attachment, prepareAck, bind, replies });
        }
      } else if (fixture.anchor && !refusedFault) {
        const reason = refusalReasons.get('observer-encoder-fault')[attachment.modern ? 0 : 1];
        const allowedEncoderRefusal = fixture.name === 'json-element' && attachment.status === 'refused' &&
          attachment.cause === reason && attachment.events?.length === 0;
        assert(`${label}/anchor`, allowedEncoderRefusal || matchesAnchor(fixture, expected, attachment), attachment.events);
      }
      if (!sharedPreparation && ((fixture.anchor && !refusedFault) ||
          (fixture.name === 'observer-encoder-fault' && refusedFault))) {
        const injectedEncoder = refusedFault && injection?.fault === 'encode' && faultAcks.length > 0;
        if (replies.length) {
          const beforeEncode = recorderEvidence(replies[0]);
          // The scheduler ACK certifies injection at the return boundary.
          // The authenticated worker reply supplies the learner event.
          assert(`${label}/recorder-boundary`, injectedEncoder
            ? faultAck && bound && attachment.status === 'refused' && attachment.cause === injection.reason &&
              attachment.events?.length === 0 && replies.length === 1 && replies[0].sequence < ack.sequence &&
              beforeEncode.completed && beforeEncode.schemaVersion === traceSchema &&
              matchesAnchor(fixture, expected, beforeEncode)
            : recorder, { attachment, replies, faultAcks });
        }
      }
    }
  }
}

function checkRow(fixture, oracle, row, status, published, converted, assert, { singletonGuard, singletonStderr }) {
  const same = (attribute, actual, expected) => assert(`${oracle.id}/${attribute}`, isDeepStrictEqual(actual, expected), actual);
  const complete = status === 'completed';
  const limit = status === 'limit';
  const stopped = status === 'not-run';
  const service = status === 'unavailable';
  same('identity', [row.caseId, row.expected], [oracle.id, oracle.expected]);
  assert(`${oracle.id}/status`, limit
    ? (row.status === 'timed-out' || row.status === 'runtime-error') && row.failure?.origin === 'limit'
    : service ? row.status === 'unavailable' || row.status === 'runtime-error' || row.status === 'protocol-error'
    : row.status === status, row.status);
  same('value', [Object.hasOwn(row, 'value'), row.value], [complete, complete ? oracle.actual : undefined]);
  const sameLimit = row.failure?.origin === 'limit' && oracle.limitReasons?.includes(row.failure.reason);
  const limitConsoleFixture = ['three-rows', singleLineFixture, 'stopping-clock'].includes(fixture.name) ||
    (fixture.language === 'python' && fixture.name === 'transport');
  if (fixture.gate === 'G4' && limitConsoleFixture && limit) {
    const diagnostics = Array.isArray(row.diagnostics) ? row.diagnostics : [];
    const messages = diagnostics.filter(({ code, severity }) =>
      code === row.failure?.reason && severity === 'error');
    const message = messages[0]?.message;
    const text = typeof message === 'string' ? message.replace(/\n$/u, '') : '';
    const limitLine = messages.length === 1 && text.trim() && !/[\r\n]/u.test(text) ? text + '\n' : undefined;
    const matchesSingleton = singletonGuard !== row.failure?.reason ||
      row.stderr === singletonStderr;
    assert(`${oracle.id}/console`, sameLimit && row.stdout === oracle.stdout &&
      limitLine !== undefined && row.stderr === limitLine && matchesSingleton, [row.stdout, row.stderr]);
  } else {
    same('console', [row.stdout, row.stderr], [oracle.stdout, '']);
  }
  const stoppedBy = published.find((candidate) => candidate.caseId === 'B');
  const notRun = { reason: 'run-stopped-after-limit', stoppedByCaseId: 'B', limit: stoppedBy?.failure?.reason };
  assert(`${oracle.id}/failure`, limit ? sameLimit && row.notRun === undefined
    : stopped ? row.failure === undefined && !!notRun.limit && isDeepStrictEqual(row.notRun, notRun)
    : service ? row.failure?.origin === 'provider' && row.notRun === undefined
    : row.failure === undefined && row.notRun === undefined, [row.failure, row.notRun]);
  same('verdict', row.verdict?.kind, complete ? oracle.grade : 'not-evaluated');
  assert(`${oracle.id}/termination`, complete
    ? row.termination?.kind === 'exit' && row.termination?.exitCode === 0 && !row.timedOut
    : service || stopped ? row.timedOut === false : sameLimit && row.timedOut === (row.failure.reason === 'client-timeout'),
  [row.termination, row.timedOut]);
  const allowedWarning = !rawAttachment(row).modern && (fixture.name === 'step-cap' || fixture.name === 'byte-cap');
  assert(`${oracle.id}/diagnostics`, complete ? Array.isArray(row.diagnostics) &&
    row.diagnostics.every((diagnostic) => allowedWarning && diagnostic.kind === 'trace-truncated' && diagnostic.severity === 'warning')
    : Array.isArray(row.diagnostics), row.diagnostics);
  if (converted) {
    assert(`${oracle.id}/conversion`, service ? converted.rejected?.name === 'RuntimeProviderError'
      : complete ? converted.kind === 'completed' && isDeepStrictEqual(converted.output, oracle.actual)
      : stopped ? converted.kind === 'not-run' && converted.stoppedByCaseId === 'B'
      : converted.kind === 'limit' && converted.reason === row.failure?.reason, converted.kind ?? converted.rejected);
  }
}

export function ordinaryProjection(evaluation) {
  return { compile: processProjection(evaluation.compile), cases: evaluation.cases.map(processProjection) };
}
