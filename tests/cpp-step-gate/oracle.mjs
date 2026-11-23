import { isDeepStrictEqual as equal } from 'node:util';
import { refusedDrawing } from './producer.mjs';

export function inspect(witness, receipt) {
  const { request, expected } = witness;
  const assertions = [];
  const check = (id, want, got) => assertions.push({
    id: request.id + '/' + id, expected: want, actual: got, pass: equal(want, got),
  });
  if (receipt == null) return { status: 'unexecuted', assertions };
  check('case', request.id, receipt.caseId);
  check('source', request.sourceSha256, receipt.sourceSha256);
  check('ordinary/kind', expected.ordinary.kind, receipt.ordinary?.kind);
  if (expected.ordinary.kind === 'completed') {
    check('ordinary/value', expected.ordinary.value, receipt.ordinary?.value);
    check('ordinary/console', [], receipt.ordinary?.console);
  } else {
    const { file, start, end } = expected.ordinary.diagnostic;
    const diagnostic = receipt.ordinary?.diagnostic;
    check('ordinary/diagnostic', true, Boolean(diagnostic?.file === file &&
      Number.isInteger(diagnostic.offset) && diagnostic.offset >= start && diagnostic.offset < end &&
      typeof diagnostic.message === 'string' && diagnostic.message.trim()));
  }

  const producerOnly = request.mode === 'producer-only';
  if (producerOnly) {
    const supported = Object.entries(request.supportedSites).flatMap(([site, kinds]) =>
      kinds.map(kind => ({ range: request.sites[site], kind })));
    const matchesSite = (event, site) => event?.kind === site.kind && equal(event.range, site.range);
    const { events, refusals } = receipt.attachment ?? {};
    check('producer/unsupported-events', [], Array.isArray(events)
      ? events.filter(event => !supported.some(site => matchesSite(event, site))) : undefined);
    check('producer/supported-refusals', [], Array.isArray(refusals)
      ? refusals.filter(refusal => supported.some(site => matchesSite(refusal, site))) : undefined);
    const expectedRefusals = expected.attachment.refusals;
    check('producer/refusals', true, Array.isArray(refusals) && refusals.length === expectedRefusals.length &&
      expectedRefusals.every(expected => refusals.filter(actual => equal(expected, actual)).length === 1));
    check('producer/no-drawing', true, receipt.drawing === undefined || equal(receipt.drawing, refusedDrawing));
  }
  // A renderer that changes the referent of a displayed step must fail
  // even if its own IDs are internally consistent.
  const actualIdentities = new Map();
  const expectedIdentities = new Map();
  for (const layer of producerOnly ? ['attachment'] : ['attachment', 'drawing']) {
    const actual = receipt[layer];
    const oracle = expected.attachment;
    check(layer + '/status', oracle.status, actual?.status);
    check(layer + '/reason', oracle.reason, actual?.reason);
    check(layer + '/coverage', oracle.coverage, actual?.coverage);
    check(layer + '/count', oracle.events.length, Array.isArray(actual?.events) ? actual.events.length : undefined);
    for (const [i, wanted] of oracle.events.entries()) {
      const observed = actual?.events?.[i];
      const range = request.sites[wanted.site];
      const { object: expectedObject, site, ...semantics } = wanted;
      let actualObject = observed?.object;
      const mapped = expectedIdentities.get(expectedObject);
      if (typeof actualObject === 'string' && actualObject && expectedObject !== null) {
        if (!expectedIdentities.has(expectedObject) && !actualIdentities.has(actualObject)) {
          expectedIdentities.set(expectedObject, actualObject);
          actualIdentities.set(actualObject, expectedObject);
        }
        const known = mapped ?? expectedIdentities.get(expectedObject);
        if (known === actualObject && actualIdentities.get(actualObject) === expectedObject) {
          actualObject = expectedObject;
        } else {
          actualObject = { conflictingId: actualObject };
        }
      }
      const normalized = observed && { ...observed, object: actualObject };
      check(layer + '/event-' + i, { ...semantics, range, object: expectedObject }, normalized);
    }
  }

  const { status } = receipt.attachment ?? {};
  const passed = assertions.every(a => a.pass);
  if (producerOnly && passed) return { status: 'producer-complete', assertions };
  if (passed) return { status: { complete: 'complete', prefix: 'exact-prefix', refused: 'authorized-refusal' }[status], assertions };
  if (status === 'refused' && expected.attachment.status !== 'refused' &&
      receipt.attachment?.events?.length === 0 && receipt.drawing?.events?.length === 0) {
    return { status: 'unexpected-refusal', assertions };
  }
  if (expected.attachment.events.length > 0 && status === 'complete' &&
      receipt.attachment?.events?.length === 0 && receipt.drawing?.events?.length === 0) {
    return { status: 'empty', assertions };
  }
  return { status: 'wrong', assertions };
}

export function knownGood(witness) {
  const { request, expected } = witness;
  const attachment = structuredClone({ ...expected.attachment,
    events: expected.attachment.events.map(({ site, ...event }) => ({
      ...event, range: request.sites[site],
    })),
  });
  const ordinary = expected.ordinary.kind === 'completed'
    ? { ...expected.ordinary, console: [] }
    : { kind: 'compile-error', diagnostic: {
      file: 'solution.cpp', offset: request.sites.invalid.start, message: 'Invalid compound assignment',
    } };
  return {
    caseId: request.id, sourceSha256: request.sourceSha256, ordinary,
    attachment, ...(request.mode === 'producer-only' ? {} : { drawing: structuredClone(attachment) }),
  };
}

export const passingStatuses = new Set(['complete', 'exact-prefix', 'authorized-refusal', 'producer-complete']);
