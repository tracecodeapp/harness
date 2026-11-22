import type { ParityProblem } from './browser-trace-parity-entry';
import { pythonTraceSemanticsCases, pythonTraceSemanticsPositionCases } from './python-trace-semantics-cases';

const pythonPrograms: [string, string, unknown][] = [
  ['P1', `class Box:
    def get(self, key):
        return 7
b = Box()
return b.get(0)`, 7],
  ['P2', 'len = lambda x: 9; a = []; return len(a)', 9],
  ['P3', 'a = [0, 0]; i = 0; a[i] = (i := 1); return a', [0, 1]],
  ['P4', 'a = [0, 0]; i = 0; i, a[i] = 1, 7; return a', [0, 7]],
  ['P5', 'x = []; a = [x]; a[0] += [1]; return x', [1]],
  ['P6', `class Box:
    def __getitem__(self, key):
        return 7
b = Box()
return b["x"]`, 7],
  ['P7', 'd = {}; return callable(d.keys)', true],
  ['P8', `rows = [[7]]; it = iter([0])
for x in rows[next(it)]: return x`, 7],
];

const pythonCases = pythonPrograms.map(([id, body, expected]): ParityProblem => ({
  id,
  language: 'python',
  functionName: 'solve',
  executionStyle: 'function',
  code: ['def solve():', ...body.split('\n').map((line) => '    ' + line)].join('\n'),
  cases: [{ id, input: {}, expected }],
}));

const lru: ParityProblem = {
  id: 'P1-LRU',
  language: 'python',
  functionName: 'LRUCache',
  executionStyle: 'ops-class',
  code: `from collections import OrderedDict

class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.cache = OrderedDict()

    def get(self, key):
        if key not in self.cache:
            return -1
        self.cache.move_to_end(key)
        return self.cache[key]

    def put(self, key, value):
        self.cache[key] = value
        self.cache.move_to_end(key)
        if len(self.cache) > self.capacity:
            self.cache.popitem(last=False)`,
  cases: [{
    id: 'P1-LRU',
    input: {
      operations: ['LRUCache', 'put', 'put', 'get', 'put', 'get', 'put', 'get', 'get', 'get'],
      arguments: [[2], [1, 1], [2, 2], [1], [3, 3], [2], [4, 4], [1], [3], [4]],
    },
    expected: [null, null, null, 1, null, -1, null, -1, 3, 4],
  }],
};

const jsCases: [string, string, unknown, string | undefined, string][] = [
  ['J1', 'const f = []; for (let i = 0; i < 2; i++) f.push(() => i); return f[0]();', 0,
    'const f: (() => number)[] = [];', 'number'],
  ['J2', 'outer: for (const x of [1]) { continue outer; } return 1;', 1, undefined, 'number'],
  ['J3', 'const a = null; a?.push(1); return 7;', 7,
    'const a = null as number[] | null;', 'number'],
  ['J4', 'const o = {x: 1}; delete o.x; return "x" in o;', false,
    'const o: { x?: number } = {x: 1};', 'boolean'],
  ['J5', 'const a = [1]; a[0] += (a[0] = 10); return a[0];', 11,
    'const a: number[] = [1];', 'number'],
  ['J6', 'const a = ["1"]; a[0]++; return a[0];', 2,
    'const a: any[] = ["1"];', 'number'],
  ['J7', 'let x = true; while (x) { let x = false; return 1; } return 0;', 1,
    'let x: boolean = true;', 'number'],
  ['J8', 'let i = 0; const rows = [[7]]; for (const x of rows[i++]) return i;', 1,
    'let i: number = 0;', 'number | undefined'],
  ['J9', 'const m = new Map([["x", 7]]); return m["x"] === undefined;', true,
    'const m: Map<string, number> & Record<string, unknown> = new Map([["x", 7]]) as Map<string, number> & Record<string, unknown>;', 'boolean'],
  ['J10', 'const e = {toString(){throw 2}}; try {throw e} catch (x) {return x === e}', true,
    'const e: { toString(): never } = {toString(){throw 2}};', 'boolean'],
];

const direct: ParityProblem = {
  id: 'box-get',
  language: 'python',
  functionName: 'solve',
  executionStyle: 'solution-method',
  code: `class Box:
    def get(self, key): return 7

class Solution:
    def solve(self):
        return Box().get(0)`,
  cases: [{ id: 'box-get', input: {}, expected: 7 }],
};

// The Node-level semantics programs (tests/test-python-trace-semantics.ts),
// run through the browser Judge as well.
const pythonSemanticsCases = [...pythonTraceSemanticsCases, ...pythonTraceSemanticsPositionCases].map(
  ({ id, code, inputs, expected }): ParityProblem => ({
    id: 'PS-' + id,
    language: 'python',
    functionName: 'solve',
    executionStyle: 'function',
    code,
    cases: [{ id: 'PS-' + id, input: inputs ?? {}, expected: 'value' in expected ? expected.value : null }],
  }),
);

export const targetedCases: readonly ParityProblem[] = [
  direct,
  pythonCases[0],
  lru,
  ...pythonCases.slice(1),
  ...pythonSemanticsCases,
  ...(['javascript', 'typescript'] as const).flatMap((language) =>
    jsCases.map(([id, body, expected, typedDeclaration, returnType]): ParityProblem => {
      const typescript = language === 'typescript';
      const codeBody = typescript && typedDeclaration
        ? typedDeclaration + body.slice(body.indexOf(';') + 1)
        : body;
      return {
        id,
        language,
        functionName: 'solve',
        executionStyle: 'function',
        code: 'function solve()' + (typescript ? ': ' + returnType : '') + ' {\n  ' + codeBody + '\n}',
        cases: [{ id, input: {}, expected }],
      };
    }),
  ),
];
