import assert from 'node:assert/strict';
import { inspect, knownGood, passingStatuses } from './oracle.mjs';
import { refusedDrawing } from './producer.mjs';

export function qualifyProducerControls(witnesses, assertExit) {
  const rows = [];
  const byId = new Map(witnesses.map(w => [w.request.id, w]));
  const short = 'short-array-initializer';
  const runtime = 'producer-runtime-short-reentry';
  const lifetimes = 'climbing-stairs';
  const addRead = (receipt, request, site) => receipt.attachment.events.push({
    range: request.sites[site], invocation: 1, phase: 'after', kind: 'read',
    object: 'spurious-a', subobject: [0], observation: { state: 'value', value: 4 },
  });
  const flip = (receipt, index) => {
    const observed = receipt.attachment.events[index].observation;
    observed.value = !observed.value;
  };
  const mutations = [
    ['fabricated-unsupported', short, 'producer/unsupported-events', (r, q) => addRead(r, q, 'rhs-1')],
    ['missing-refusal', short, 'producer/refusals', r => r.attachment.refusals.pop()],
    ['supported-refusal', short, 'producer/supported-refusals', (r, q) => {
      r.attachment.events.shift();
      r.attachment.refusals.push({ range: q.sites['expr-0'], kind: 'branch', reason: 'unsupported-operation' });
    }],
    ['wrong-lifetime-phase', lifetimes, 'attachment/event-1', r => { r.attachment.events[1].phase = 'before'; }],
    ['wrong-lifetime-value', lifetimes, 'attachment/event-3', r => { r.attachment.events[3].observation.value = 3; }],
    ['skipped-rhs-read', short, 'producer/unsupported-events', (r, q) => addRead(r, q, 'rhs-0')],
    ['drawing-present', short, 'producer/no-drawing', r => { r.drawing = structuredClone(r.attachment); }],
    ['skipped-reported-reached', runtime, 'attachment/event-1', r => flip(r, 1)],
    ['reached-reported-skipped', runtime, 'attachment/event-0', r => flip(r, 0)],
    ['reentry-swapped', runtime, 'attachment/event-2', r => {
      flip(r, 2);
      flip(r, 3);
    }],
  ];
  for (const [index, witness] of witnesses.entries()) {
    const receipt = knownGood(witness);
    if (index % 2 === 1) receipt.drawing = structuredClone(refusedDrawing);
    const result = inspect(witness, receipt);
    assert.equal(result.status, 'producer-complete', JSON.stringify(result.assertions.filter(a => !a.pass)));
    rows.push({ id: witness.request.id + '/control-good', ...result,
      gateExit: assertExit(witness.request.id, receipt, 0) });
  }
  for (const [name, id, assertion, inject] of mutations) {
    const witness = byId.get(id);
    const receipt = knownGood(witness);
    const before = structuredClone(receipt);
    inject(receipt, witness.request);
    assert.notDeepEqual(receipt, before);
    const result = inspect(witness, receipt);
    const want = id + '/' + assertion;
    assert.equal(result.assertions.find(a => a.id === want)?.pass, false, name + ' missed ' + want);
    assert(!passingStatuses.has(result.status));
    assert(result.assertions.filter(a => a.id.startsWith(id + '/ordinary/')).every(a => a.pass));
    rows.push({ id: name, status: 'control-caught', mutantStatus: result.status,
      injectionHits: 1, gateExit: assertExit(id, receipt, 1), requiredFailedAssertion: want,
      assertions: result.assertions });
  }
  return rows;
}
