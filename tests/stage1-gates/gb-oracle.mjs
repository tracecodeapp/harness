import { isDeepStrictEqual } from 'node:util';
import { schedulerInjection } from './gb-probe.mjs';

const healthyChecks = ['identity', 'status', 'value', 'console', 'failure', 'verdict', 'termination', 'diagnostics', 'conversion'];
const transportChecks = ['injection-ack', 'A/ordinary-start-count', 'A/worker-finish', 'A/coordinator-commit'];
const observationChecks = ['ordinary-start-count', 'ordinary-before-observer', 'observer-grade-writes'];
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
  if (row.id === 'C' && fixture.cases.some((candidate) => candidate.limitReasons) && stopRoute(route)) return 'not-run';
  if (row.limitReasons) return 'limit';
  return 'completed';
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
  const startCoverage = dispatch.length > 0 && dispatch.every(({ reportsStarts }) => reportsStarts === true);
  const observableContinuation = fixture.language === 'python';
  if (wrongStart || startCoverage || (continuation(route) &&
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
  const receipts = [];
  const seen = new Set();
  function assert(id, passed, actual) {
    if (!inventory.includes(id) || seen.has(id)) throw new Error(`Unexpected assertion ${prefix}/${id}`);
    seen.add(id);
    receipts.push({ id: `${prefix}/${id}`, status: passed ? 'passed' : 'failed', actual });
  }
  if (sample && !sample.unavailable) {
    check(fixture, route, sample, assert);
  }
  return {
    expected: inventory.map((id) => `${prefix}/${id}`),
    receipts,
    missing: inventory.filter((id) => !seen.has(id)).map((id) => `${prefix}/${id}`),
  };
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
    assert('correlation', keysValid && matchingReference && boundSelection, {
      bundleId: receipt.bundleId, workspaceDigest: receipt.workspaceDigest,
      executionId: receipt.executionId, retainedExecutionId: sample.retainedExecutionId,
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

  for (const expected of rows) {
    const row = published.find(({ caseId }) => caseId === expected.id);
    const status = desiredRow(fixture, route, expected);
    if (row) {
      checkRow(fixture, expected, row, status, published, sample.conversions?.cases?.[published.indexOf(row)], assert);
    }
    if (expected.limitReasons && row) {
      const reason = row.failure?.reason;
      const hasStart = wire.some((event) => event.kind === 'worker-started' && event.caseId === expected.id);
      const isClockProbe = fixture.noInterruptBuffer === true;
      const delivered = wire.some((event) => event.kind === 'dispatch' && event.rows.includes(expected.id));
      if (hasStart || (isClockProbe && delivered)) {
        assert(`${expected.id}/learner-guard`, row.failure?.origin === 'limit' &&
          expected.limitReasons.includes(reason) && (!sample.singletonGuard || reason === sample.singletonGuard),
        { reason, singleton: sample.singletonGuard, hasStart });
      }
    }
    if (fixture.gate === 'G4' && !continuation(route)) {
      const starts = wire.filter((event) => event.kind === 'worker-started' && event.caseId === expected.id && event.mode === 'code');
      if (starts.length && status !== 'unavailable') {
        assert(`${expected.id}/start-proof`, starts.length === (status === 'not-run' ? 0 : 1), starts);
      }
    }
  }

  if (fixture.name === 'transport' && route !== 'submit-stop') {
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
    if (route.startsWith('clock-')) {
      const omitted = sample.stimulus && sample.stimulus.bundle.execution.limits?.wallClockMs === undefined && !('stopAtFirstRunaway' in sample.stimulus);
      assert('clock/omitted-wall-budget', omitted, sample.stimulus?.bundle.execution.limits);
      const advances = wire.filter((event) => event.kind === 'advance-clock').map((event) => event.virtualTime);
      const held = wire.some((event) => event.kind === 'held-terminal' && event.due === 33000);
      const clockPassed = route === 'clock-real'
        ? isDeepStrictEqual(advances, [11000, 22000]) && held
        : isDeepStrictEqual(advances, [11000, 22000, 33000]);
      assert('clock/three-advances', clockPassed, { advances, held });
    }
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
      const cacheHit = currentEvidence.some(({ kind, phase, caseId, attemptToken }) =>
        kind === 'schedule' && phase === 'observation-cache-hit' && caseId === label &&
        typeof attemptToken === 'string');
      const evidence = cacheHit ? [...(sample.retainedEvidence ?? []), ...currentEvidence] : currentEvidence;
      const replies = evidence.filter(({ kind, caseId }) => kind === 'observer-reply' && caseId === label);
      const recorder = replies.length === 1 && bound && checkRecorder(fixture, attachment, replies[0]);
      const injection = schedulerInjection(fixture.name);
      const faultAcks = currentEvidence.filter(({ kind, phase }) => kind === 'schedule' && phase === 'injection-ack');
      const ack = faultAcks[0];
      const faultAck = faultAcks.length === 1 && injection && ack.fault === injection.fault &&
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
        const referenceReplies = wire.filter(({ kind, request, caseId }) =>
          kind === 'observer-reply' && request === `${route}:reference` && caseId === label);
        if (step && replies.length && referenceReplies.length) {
          const reference = rawAttachment(referenceRow);
          const actual = attachment.events?.map(eventProjection);
          const longer = reference.events?.map(eventProjection);
          assert(`${label}/real-prefix`, recorder && attachment.status === 'truncated' &&
            attachment.cause === reason && referenceReplies.length === 1 &&
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
        const accepted = refusedFault ? validRefusal && attachment.cause === reason
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
      if (fixture.anchor && !refusedFault) {
        const reason = refusalReasons.get('observer-encoder-fault')[attachment.modern ? 0 : 1];
        const allowedEncoderRefusal = fixture.name === 'json-element' && attachment.status === 'refused' &&
          attachment.cause === reason && attachment.events?.length === 0;
        assert(`${label}/anchor`, allowedEncoderRefusal || matchesAnchor(fixture, expected, attachment), attachment.events);
      }
      if ((fixture.anchor && !refusedFault) || (fixture.name === 'observer-encoder-fault' && refusedFault)) {
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

function checkRow(fixture, oracle, row, status, published, converted, assert) {
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
  same('console', [row.stdout, row.stderr], [oracle.stdout, '']);
  const sameLimit = row.failure?.origin === 'limit' && oracle.limitReasons?.includes(row.failure.reason);
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
