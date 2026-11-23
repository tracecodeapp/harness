// Mutations use only independent oracle data. Each named mutation must hit one
// witness and fail its predetermined assertion while preserving the endpoint.
function insert(stream, i, event) {
  stream.events.splice(i, 0, event);
}
function lose(stream, i) {
  stream.events.splice(i, 1);
}
const copy = (stream, i, fields = {}) => ({ ...structuredClone(stream.events[i]), ...fields });
const early = { state: 'value', value: 3 };
export const controls = [
  ['skipped-rhs', 'short-array-initializer', 'event-1',
    (s, r) => insert(s, 1, copy(s, 2, { range: r.sites['rhs-0'] }))],
  ['lost-rhs', 'short-array-initializer', 'event-2', s => lose(s, 2)],
  ['skipped-or-rhs', 'short-vector-return', 'event-5',
    (s, r) => insert(s, 5, copy(s, 6, { range: r.sites['rhs-2'] }))],
  ['lost-reached-call', 'short-vector-return', 'event-3', s => lose(s, 3)],
  ['wrong-referent', 'alias-overwrite', 'event-3', s => { s.events[3].object = s.events[2].object; }],
  ['lost-overwritten-write', 'alias-overwrite', 'event-3', s => lose(s, 3)],
  ['duplicate-entry', 'loop-two', 'event-2', s => insert(s, 2, copy(s, 1))],
  ['write-after-break', 'loop-break', 'count', s => s.events.push(copy(s, 4))],
  ['lost-failed-check', 'loop-two', 'count', s => lose(s, s.events.length - 1)],
  ['lost-same-line-write', 'loop-two', 'event-3', s => lose(s, 3)],
  ['stale-cur', 'climbing-stairs', 'event-2', s => { s.events[2].observation = early; }],
  ['stale-mid', 'binary-search', 'event-2', s => { s.events[2].observation = { state: 'value', value: 1 }; }],
  ['merged-lifetimes', 'climbing-stairs', 'event-2', s => { s.events[2].object = s.events[0].object; }],
  ['lost-initialized-value', 'climbing-stairs', 'event-1', s => lose(s, 1)],
  ['uninitialized-scalar', 'uninitialized-shadowed-aggregate', 'event-1', s => { s.events[1].observation = early; }],
  ['nonzero-implicit-initializer', 'uninitialized-shadowed-aggregate', 'event-3',
    s => { s.events[3].observation = early; }],
  ['lost-scope-exit', 'uninitialized-shadowed-aggregate', 'event-8', s => lose(s, 8)],
  ['stale-reused-storage', 'reused-storage', 'event-3', s => { s.events[3].observation = early; }],
  ['event-in-refusal', 'unsupported-location', 'count', (s, r, byId) =>
    s.events.push(copy(byId.get('alias-overwrite').attachment, 0))],
  ['short-complete', 'bounded-prefix', 'status', s => { s.status = 'complete'; }],
  ['lost-refusal-boundary', 'unsupported-location', 'reason', s => { delete s.reason; }],
  ['lost-prefix-boundary', 'bounded-prefix', 'coverage', s => { delete s.coverage; }],
  ['false-refusal', 'alias-overwrite', 'status', s => {
    Object.assign(s, { status: 'refused', reason: 'unsupported-location', coverage: [0, 0], events: [] });
  }],
  ['reorder', 'alias-overwrite', 'event-3', s => { [s.events[3], s.events[4]] = [s.events[4], s.events[3]]; }],
  ['stale-invocation', 'alias-overwrite', 'event-3', s => { s.events[3].invocation = 2; }],
  ['wrong-phase', 'alias-overwrite', 'event-3', s => { s.events[3].phase = 'before'; }],
  ['wrong-same-line-range', 'alias-overwrite', 'event-3', (s, r) => { s.events[3].range = r.sites.one; }],
];
