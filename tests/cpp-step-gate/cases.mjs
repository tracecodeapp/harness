import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { legacyCases } from './legacy-cases.mjs';

export const unavailable = Object.freeze({ state: 'unavailable' });
export const value = (value) => ({ state: 'value', value });
export const step = (site, kind, observation, {
  phase = 'after', invocation = 1, object = null, subobject = [],
} = {}) => ({ site, phase, kind, invocation, object, subobject, observation });

function positions(source, anchors) {
  return Object.fromEntries(Object.entries(anchors).map(([site, text]) => {
    const start = source.indexOf(text);
    if (start < 0 || start !== source.lastIndexOf(text)) throw new Error('Missing or ambiguous site ' + site);
    return [site, { file: 'solution.cpp', start, end: start + text.length }];
  }));
}
function witness({ id, source, inputs = {}, functionName = 'solve', output, anchors, events,
  projection, status = 'complete', reason, limit = null, compileError }) {
  const sites = positions(source, anchors);
  // Dynamic order, counts and values stay private. A family with statically
  // allowed but untaken operations supplies its own projection.
  const kindsBySite = {};
  for (const { site, kind } of events) {
    (kindsBySite[site] ??= new Set()).add(kind);
  }
  const ordinary = compileError
    ? { kind: 'compile-error', diagnostic: { file: 'solution.cpp', ...sites.invalid } }
    : { kind: 'completed', value: output };
  return {
    request: {
      schema: 'tracecode.cpp-step-gate.v1', id, source, sites, functionName, inputs, limit,
      projection: projection ?? Object.fromEntries(Object.entries(kindsBySite).map(([site, kinds]) =>
        [site, [...kinds]])),
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      executionStyle: 'solution-method',
    },
    expected: { ordinary, attachment: {
      status, reason: reason ?? null, events,
      coverage: [0, events.length],
    } },
  };
}
const solve = (body, extra = '') => extra +
  'class Solution {\npublic:\n  int solve() {\n' + body + '\n  }\n};\n';
const write = (site, object, x, subobject) => step(site, 'write', value(x), { object, subobject });
const read = (site, object, x, subobject) => step(site, 'read', value(x), { object, subobject });

function shortCircuits() {
  // Evaluator for this grammar. Every RHS is touch(a[0]) and yields true.
  // Spell arrays and vectors differently without changing evaluation.
  return ['array', 'vector'].flatMap(shape =>
    ['initializer', 'return'].map(position => {
      const spec = [
        { lhs: false, op: '&&' }, { lhs: true, op: '&&' },
        { lhs: true, op: '||' }, { lhs: false, op: '||' },
      ];
      const lines = spec.map(({ lhs, op }) => lhs + ' ' + op + ' touch(a[0])');
      const evaluate = ({ lhs, op }, i) => {
        const site = 'rhs-' + i;
        const taken = op === '&&' ? lhs : !lhs;
        return [
          step('expr-' + i, 'branch', value(taken)),
          ...(taken ? [read(site, 'a#1', 4, [0]), step(site, 'call', value(4), { phase: 'before' })] : []),
        ];
      };
      const declaration = shape === 'array' ? 'int a[1] = {4};' : 'std::vector<int> a{4};';
      // Sequenced declarations fix the order of the first three terms. The
      // fourth term uses the selected expression position.
      const prefix = lines.slice(0, 3).map((text, i) => 'int b' + i + ' = ' + text + ';').join(' ');
      const last = lines[3];
      const source = solve('    ' + declaration + '\n    ' + prefix + ' ' +
        (position === 'initializer' ? 'int b3 = ' + last + ';\n    return b0 + b1 + b2 + b3;'
          : 'return b0 + b1 + b2 + (' + last + ');'),
      (shape === 'vector' ? '#include <vector>\n' : '') +
        'bool touch(int item) { return item == 4; }\n');
      const anchors = Object.fromEntries(lines.map((text, i) => ['expr-' + i, text]));
      // Disambiguate the repeated call/access with its exact RHS subrange.
      const projection = Object.fromEntries(lines.flatMap((_, i) => [
        ['expr-' + i, ['branch']], ['rhs-' + i, ['read', 'call']],
      ]));
      const f = witness({ id: 'short-' + shape + '-' + position, source, output: 3, anchors, projection,
        events: spec.flatMap(evaluate) });
      for (const i of lines.keys()) {
        const end = f.request.sites['expr-' + i].end;
        f.request.sites['rhs-' + i] = { file: 'solution.cpp', start: end - 'touch(a[0])'.length, end };
      }
      return f;
    }));
}

function aliases() {
  return witness({
    id: 'alias-overwrite',
    source: solve('    int a = 1;\n    int &r = a;\n    int copy = a;\n    r = 7; r = 1;\n    return copy + a;'),
    anchors: { bind: 'int &r = a;', copy: 'int copy = a;', seven: 'r = 7;', one: 'r = 1;' },
    output: 2,
    // The return expression's operand order is deliberately outside the projection.
    events: [
      step('bind', 'bind', unavailable, { object: 'a#1' }),
      read('copy', 'a#1', 1), write('copy', 'copy#1', 1),
      write('seven', 'a#1', 7), write('one', 'a#1', 1),
    ],
  });
}

function loop(mode) {
  const source = solve([
    '    int sum = 0;',
    '    for (int i = 0; i < n; ++i) {',
    '      if (mode == 1 && i == 0) continue;',
    '      if (mode == 2 && i == 1) break;',
    '      sum += i; sum += 3;',
    '    }',
    '    return sum;',
  ].join('\n')).replace('int solve()', 'int solve(int n, int mode)');
  const n = mode === 3 ? 0 : 2;
  const events = [];
  let sum = 0;
  for (let i = 0; ; i++) {
    events.push(step('test', 'branch', value(i < n)));
    if (i >= n) break;
    events.push(step('body', 'entry', value(i), { phase: 'before' }));
    if (mode === 2 && i === 1) {
      events.push(step('break', 'break', unavailable));
      break;
    }
    if (mode === 1 && i === 0) events.push(step('continue', 'continue', unavailable));
    else {
      events.push(write('add-i', 'sum#1', sum += i), write('add-three', 'sum#1', sum += 3));
    }
    events.push(write('increment', 'i#1', i + 1));
  }
  return witness({
    id: ['loop-two', 'loop-continue', 'loop-break', 'loop-zero'][mode], source,
    inputs: { n, mode }, output: sum, events,
    projection: { test: ['branch'], body: ['entry'], break: ['break'], continue: ['continue'],
      'add-i': ['write'], 'add-three': ['write'], increment: ['write'] },
    anchors: { test: 'i < n', increment: '++i', body: '++i) {', continue: 'continue;', break: 'break;',
      'add-i': 'sum += i;', 'add-three': 'sum += 3;' },
  });
}

const availability = (site, object, observation, phase = 'before', subobject = []) =>
  step(site, 'availability', observation, { object, phase, subobject });

function lifetimes() {
  return [
    witness({
      id: 'uninitialized-shadowed-aggregate',
      source: solve([
        '    int x = 6;',
        '    {',
        '      int x;',
        '      int a[2] = {7};',
        '      x = a[0];',
        '      a[1] = x;',
        '    } // inner scope ends',
        '    return x;',
      ].join('\n')),
      anchors: { outer: 'int x = 6;', inner: 'int x;', aggregate: 'int a[2] = {7};',
        assign: 'x = a[0];', index: 'a[1] = x;', exit: '} // inner scope ends', ret: 'return x;' },
      output: 6,
      events: [
        write('outer', 'outer-x#1', 6), availability('inner', 'inner-x#1', unavailable),
        write('aggregate', 'a#1', 7, [0]), write('aggregate', 'a#1', 0, [1]),
        read('assign', 'a#1', 7, [0]), write('assign', 'inner-x#1', 7),
        read('index', 'inner-x#1', 7), write('index', 'a#1', 7, [1]),
        step('exit', 'lifetime-end', unavailable, { object: 'a#1' }),
        step('exit', 'lifetime-end', unavailable, { object: 'inner-x#1' }),
        read('ret', 'outer-x#1', 6),
      ],
    }),
    witness({
      id: 'reused-storage',
      source: solve([
        '    alignas(int) unsigned char slot[sizeof(int)];',
        '    int* first = new (slot) int(3);',
        '    int got = *first;',
        '    int* second = new (slot) int;',
        '    *second = 5;',
        '    return got + *second;',
      ].join('\n'), '#include <new>\n'),
      anchors: { first: 'new (slot) int(3)', read: 'int got = *first;',
        reuse: 'new (slot) int;', assign: '*second = 5;', ret: '*second;' },
      output: 8,
      events: [
        write('first', 'slot#1', 3), read('read', 'slot#1', 3),
        step('reuse', 'lifetime-end', unavailable, { object: 'slot#1', phase: 'before' }),
        availability('reuse', 'slot#2', unavailable), write('assign', 'slot#2', 5),
        read('ret', 'slot#2', 5),
      ],
    }),
  ];
}

export const catalogSpecs = [
  {
    id: 'climbing-stairs', functionName: 'climbStairs', inputs: { n: 5 }, output: 8, name: 'cur',
    anchors: { declare: 'int cur = prev1 + prev2;', next: 'prev2 = prev1;' }, initialized: [3, 5, 8],
  },
  {
    id: 'binary-search', functionName: 'search', inputs: { nums: [1, 4, 8, 10], target: 8 }, output: 2, name: 'mid',
    anchors: { declare: 'int mid = (left + right) / 2;', next: 'if (nums[mid] == target) return mid;' }, initialized: [1, 2],
  },
];
export function catalogWitnesses(root) {
  return catalogSpecs.map(spec => witness({
    ...spec, source: readFileSync(join(root, 'practice', spec.id + '.cpp'), 'utf8'),
    events: spec.initialized.flatMap((x, i) => {
      const object = spec.name + '#' + (i + 1);
      return [availability('declare', object, unavailable), availability('next', object, value(x))];
    }),
  }));
}
function boundaryCases() {
  const good = aliases();
  return [
    witness({
      id: 'unsupported-location', source: good.request.source, output: 2, anchors: {}, events: [],
      limit: { forceUnsupportedLocation: true }, status: 'refused', reason: 'unsupported-location',
    }),
    {
      request: { ...good.request, id: 'bounded-prefix', limit: { maxEvents: 3 } },
      expected: { ...good.expected, attachment: {
        status: 'prefix', reason: 'event-budget', coverage: [0, 3],
        events: good.expected.attachment.events.slice(0, 3),
      } },
    },
    witness({
      id: 'invalid-vector-bool-or', source: legacyCases.find(c => c.invalid).code,
      anchors: { invalid: 'flags[0] |= true;' }, inputs: { seed: 1 },
      status: 'refused', reason: 'compile-error', events: [], compileError: true,
    }),
  ];
}

export const syntheticWitnesses = [
  ...shortCircuits(), aliases(), ...[0, 1, 2, 3].map(loop), ...lifetimes(), ...boundaryCases(),
];
