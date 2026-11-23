import { isDeepStrictEqual } from 'node:util';

const healthyChecks = ['identity', 'status', 'value', 'console', 'failure', 'verdict', 'termination', 'diagnostics', 'conversion'];
const transportChecks = ['injection-ack', 'A/ordinary-start-count', 'A/worker-finish', 'A/coordinator-commit'];
const observationChecks = ['ordinary-start-count', 'ordinary-before-observer', 'observer-grade-writes'];
const stopRoute = (route) => route.startsWith('run-') || route === 'submit-stop';
const continuation = (route) => route.startsWith('continue-') || route.startsWith('repeat-');
const faultNames = ['no-recorder', 'observer-compile-fault', 'observer-encoder-fault'];

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
      if (fixture.anchor) ids.push(`${row.id}/anchor`, `${row.id}/recorder-boundary`);
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
  !['sessionId', 'pid', 'timings', 'startedAt', 'endedAt', 'trace'].includes(key)
));

function rawAttachment(row) {
  const budget = row?.diagnostics?.find(({ kind }) => kind === 'trace-truncated')?.code;
  const refuses = row?.diagnostics?.find(({ code }) => code === 'trace-unavailable');
  const named = row?.attachment;
  if (named) return named;
  if (budget) return { status: 'truncated', cause: budget, events: row.trace?.events };
  if (refuses) return { status: 'refused', cause: refuses.cause, events: row.trace?.events };
  if (row?.trace?.events?.length) return { status: 'complete', events: row.trace.events };
  return { status: 'unknown', events: row?.trace?.events };
}

function matchesAnchor(fixture, target, attachment) {
  const n = target.input.n;
  return attachment.events?.some((event) => {
    const line = event.sourceSpan?.startLine ?? event.line;
    if (line !== fixture.anchor) return false;
    if (fixture.name === 'json-element') {
      return event.target?.variable === 'element' || event.locals?.element !== undefined;
    }
    return event.kind === 'stdout' && event.callStack?.at(-1)?.args?.n === n &&
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
    assert('correlation', keysValid && matchingReference, {
      bundleId: receipt.bundleId, workspaceDigest: receipt.workspaceDigest,
      executionId: receipt.executionId, retainedExecutionId: sample.retainedExecutionId,
    });
  }
  if (!route.startsWith('run-') && !continuation(route)) {
    const passed = rows.filter((row) => desiredRow(fixture, route, row) === 'completed').length;
    const verdict = serviceCut(fixture, route) ? 'indeterminate' : passed === rows.length ? 'passed' : 'failed';
    const ok = verdict === 'indeterminate' ? undefined : verdict === 'passed';
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
    for (const expected of drawingRows(fixture, route)) {
      const row = published.find(({ caseId }) => caseId === expected.id);
      if (!row) continue;
      const attachment = rawAttachment(row);
      const label = expected.id;
      const refusedFault = faultNames.includes(fixture.name) && label === 'A';
      if (fixture.name === 'step-cap' || fixture.name === 'byte-cap') {
        const reason = fixture.name === 'step-cap' ? 'trace-limit' : 'trace-byte-limit';
        assert(`${label}/attachment-status`, attachment.status === 'truncated' && attachment.cause === reason, attachment);
        if (fixture.name === 'byte-cap' && attachment.attemptedEventCount !== undefined) {
          assert(`${label}/attempted-events`, attachment.attemptedEventCount > 0 && attachment.events?.length === 0, attachment);
        }
      } else {
        const reason = {
          'no-recorder': 'recorder-unavailable', 'observer-compile-fault': 'observer-prepare-failed',
          'observer-encoder-fault': 'observer-encode-failed',
        }[fixture.name];
        const complete = attachment.status === 'complete' && (attachment.events?.length ?? 0) > 0;
        const validRefusal = attachment.status === 'refused' && attachment.events?.length === 0;
        const accepted = refusedFault
          ? validRefusal && attachment.cause === reason
          : complete || (fixture.name === 'json-element' && validRefusal && attachment.cause === 'observer-encode-failed');
        assert(`${label}/attachment-status`, accepted, attachment);
        if (refusedFault) assert('A/provenance', validRefusal && attachment.cause === reason, attachment);
      }
      if (fixture.anchor) {
        const expectsAnchor = !refusedFault && (fixture.name !== 'json-element' || attachment.status === 'complete');
        if (expectsAnchor) assert(`${label}/anchor`, matchesAnchor(fixture, expected, attachment), attachment.events);
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
  const allowedWarning = fixture.name === 'step-cap' || fixture.name === 'byte-cap';
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
