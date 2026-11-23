import { createHash } from 'node:crypto';

// These sites are fixed by the gate. General loop conditions are not RHS decisions.
const acceptance = [
  'short-array-initializer', 'short-array-return', 'short-vector-initializer', 'short-vector-return',
  'producer-runtime-short-reentry', 'climbing-stairs', 'binary-search',
];
const rhsSites = ['expr-0', 'expr-1', 'expr-2', 'expr-3'];
const lifetimeNames = { 'climbing-stairs': 'cur', 'binary-search': 'mid' };

function runtimeWitness() {
  const source = [
    'bool touch(int value) { return value == 4; }',
    'class Solution {',
    'public:',
    '  int solve(bool first, bool second) {',
    '    int a[1] = {4};',
    '    int total = 0;',
    '    for (int i = 0; i < 2; ++i) {',
    '      bool lhs = i == 0 ? first : second;',
    '      bool andValue = lhs && touch(a[0]);',
    '      bool orValue = lhs || touch(a[0]);',
    '      total += int(andValue) + int(orValue);',
    '    }',
    '    return total;',
    '  }',
    '};',
    '',
  ].join('\n');
  const inputs = { first: true, second: false };
  const sites = {};
  const projection = {};
  for (const [site, op] of [['and', '&&'], ['or', '||']]) {
    const expression = 'lhs ' + op + ' touch(a[0])';
    const start = source.indexOf(expression);
    const end = start + expression.length;
    sites[site] = { file: 'solution.cpp', start, end };
    sites[site + '-rhs'] = { file: 'solution.cpp', start: end - 'touch(a[0])'.length, end };
    projection[site] = ['branch'];
    projection[site + '-rhs'] = ['read', 'call'];
  }
  // With lhs=true, && visits its RHS and || skips. With lhs=false on
  // re-entry, && skips and || visits. The body contributes 2 then 1.
  const events = [['and', true], ['or', false], ['and', false], ['or', true]].map(([site, value]) => ({
    site, invocation: 1, phase: 'after', kind: 'branch', object: null, subobject: [],
    observation: { state: 'value', value },
  }));
  return {
    request: {
      schema: 'tracecode.cpp-step-gate.v1', id: 'producer-runtime-short-reentry',
      source, sourceSha256: createHash('sha256').update(source).digest('hex'),
      functionName: 'solve', executionStyle: 'solution-method', inputs, sites, projection, limit: null,
    },
    expected: { ordinary: { kind: 'completed', value: 3 }, attachment: {
      status: 'complete', reason: null, coverage: [0, events.length], events,
    } },
  };
}

export function producerWitnesses(witnesses) {
  const runtime = runtimeWitness();
  return acceptance.map(id => {
    const { request, expected } = id === runtime.request.id ? runtime :
      witnesses.find(witness => witness.request.id === id);
    const name = lifetimeNames[id];
    let sites = request.sites;
    let projection = request.projection;
    let events;
    let supportedSites;
    if (name) {
      // The existing next-line value supplies the independently enumerated
      // initializer result, never evidence that the next statement executed.
      const declare = request.sites.declare;
      const offset = declare.start + `int `.length;
      if (request.source.slice(offset, offset + name.length) !== name) {
        throw new Error('Unexpected local identifier for ' + id);
      }
      sites = { declare: { ...declare, start: offset, end: offset + name.length } };
      projection = supportedSites = { declare: ['availability'] };
      events = expected.attachment.events.map(event => event.site === 'next'
        ? { ...event, site: 'declare', phase: 'after' } : event);
    } else {
      const branchSites = id === runtime.request.id ? ['and', 'or'] : rhsSites;
      supportedSites = Object.fromEntries(branchSites.map(site => [site, ['branch']]));
      events = expected.attachment.events.filter(event => supportedSites[event.site]?.includes(event.kind));
    }
    const refusals = Object.entries(projection).flatMap(([site, kinds]) =>
      kinds.filter(kind => !supportedSites[site]?.includes(kind))
        .map(kind => ({ range: sites[site], kind, reason: 'unsupported-operation' })));
    return {
      request: {
        ...request, mode: 'producer-only', sites, projection, supportedSites,
        supportedKinds: [name ? 'availability' : 'branch'], stdin: JSON.stringify(request.inputs),
      },
      expected: { ...expected, attachment: { ...expected.attachment, events, coverage: [0, events.length], refusals } },
    };
  });
}

export const refusedDrawing = {
  status: 'refused', reason: 'renderer-not-qualified', coverage: [0, 0], events: [],
};
