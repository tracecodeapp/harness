import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { appFixtureName, appSpec, cppDirectRoutes, jsRouteRequests, muxRequests, requestMatrix } from './requests.mjs';

const candidate = 'b025fdb8220694cdfe96b136a0b8bb82843f7371';
const languages = { js: 'javascript', ts: 'typescript', py: 'python', java: 'java', cs: 'csharp', cpp: 'cpp' };
const read = (path, rev = candidate) => execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8' });
const parity = (name, file) => read(`fixtures/runtime-parity/${name}/${file}`);
const python = read('tests/test-python-run-judged-value.ts');
const pythonOwn = read('tests/test-python-run-judged-value.ts', 'fa0c9bd7');
const literal = (text, name) => {
  const match = text.match(new RegExp('const ' + name + ' = `([^]*?)`' + ';'));
  if (!match) throw new Error(`Missing pinned literal ${name}`);
  return match[1];
};
const rows = (inputs, actuals, targets = actuals) => [
  { id: 'A', input: inputs[0], actual: actuals[0], expected: targets[0] },
  { id: 'B', input: inputs[1], actual: actuals[1], expected: targets[1] },
];
const traceOptions = { maxTraceSteps: 4000, maxLineEvents: 12000, maxSingleLineHits: 1000, maxStoredEvents: 16000 };
const fixtures = [];
function add(gate, name, ext, code, cases, options = {}) {
  fixtures.push({
    gate, name, language: languages[ext], code, functionName: 'solve',
    executionStyle: 'function', limits: { wallClockMs: 10000 }, traceOptions,
    cases: cases.map((row) => ({
      status: 'completed', verdict: 'passed', stdout: '', stderr: '',
      ...row, diagnostics: row.diagnostics ?? [],
    })),
    ...options,
  });
}

function queens(n) {
  const boards = [];
  function visit(columns, used = new Set(), rising = new Set(), falling = new Set()) {
    const row = columns.length;
    if (row === n) {
      boards.push(columns.map((column) => '.'.repeat(column) + 'Q' + '.'.repeat(n - column - 1)));
      return;
    }
    for (let column = 0; column < n; column += 1) {
      if (used.has(column) || rising.has(row + column) || falling.has(row - column)) continue;
      visit([...columns, column], new Set([...used, column]), new Set([...rising, row + column]), new Set([...falling, row - column]));
    }
  }
  visit([]);
  return boards;
}

const program = literal(python, 'PROGRAM');
const queensCases = rows([{ kind: 'queens', n: 9 }, { kind: 'queens', n: 4 }], [queens(9), queens(4)]);
if (queensCases[0].actual.length !== 352 || queensCases[1].actual.length !== 2) throw new Error('Queens oracle counts');
const queensOptions = { executionStyle: 'solution-method', limits: { wallClockMs: 30000, maxLineEvents: 2000000, maxSingleLineHits: 400000 } };
add('G1', 'queens', 'py', program, queensCases, queensOptions);
add('G1', 'queens-legacy-budget', 'py', program, queensCases, {
  ...queensOptions, limits: { ...queensOptions.limits, maxLineEvents: 1000000 },
});
add('G1', 'end-character', 'cpp', '#include <string>\nclass Solution { public: int solve(std::string s) { return int(s[s.size()]); } };', rows([{ s: 'cat' }, { s: '' }], [0, 0]));
const invalid = 'function solve() {\n  return 7;';
add('G1', 'missing-closer', 'js', invalid, rows([{}, {}], [undefined, undefined], [7, 7]).map((row) => ({
  ...row, status: 'runtime-error', verdict: 'not-evaluated', failure: { origin: 'program', stage: 'compile' },
})), { syntax: true });
add('G1', 'valid-printer', 'js', invalid + '\n}', rows([{}, {}], [7, 7]));
const ownClasses = literal(pythonOwn, 'OWN_CLASSES');
const listIdentity = 'class Solution:\n    def solve(self, head):\n        return head\n';
function list(values, typed = false) {
  return values.reduceRight((next, val) => typed ? { __type__: 'ListNode', val, next } : { val, next }, null);
}
const ownRows = rows([{ head: list([1, 2, 3]) }, { head: null }], [list([1, 2, 3], true), null]);
add('G1', 'own-class', 'py', ownClasses + '\n' + listIdentity, ownRows, { executionStyle: 'solution-method', graph: true, alsoGate: 'G6' });
add('G1', 'builtin-class', 'py', listIdentity, ownRows, { executionStyle: 'solution-method', graph: true, alsoGate: 'G6' });
const plainObject = { __type__: 'ListNode', __class__: 'ListNode', x: 7, extra: 'kept' };
add('G6', 'not-a-node', 'py', literal(pythonOwn, 'NOT_A_NODE') + '\nclass Solution:\n    def solve(self, kind, n):\n        return ListNode(n)\n',
  rows([{ kind: 'not-a-node', n: 7 }, { kind: 'not-a-node', n: 7 }], [plainObject, plainObject]), { executionStyle: 'solution-method' });
for (const ext of ['js', 'ts']) {
  add('G1', 'ses-constructor-key', ext,
    'class Solution { detectDrift(snapshot) { return Object.keys(Object.assign({}, snapshot)).length; } }',
    rows([{ snapshot: JSON.parse('{"constructor":"example-only"}') }, { snapshot: { ordinary: 'example-only' } }], [1, 1]),
    { functionName: 'detectDrift', executionStyle: 'solution-method' });
}
const treeA = { __id__: 'r', val: 1, left: { __id__: 'c', val: 2, left: { __ref__: 'r' }, right: null }, right: { __ref__: 'c' } };
const leaf = { val: 2, left: null, right: null };
const treeB = { __id__: 'r', val: 1, left: { __id__: 'c', ...leaf }, right: leaf };
function typedTree(tree) {
  if (tree === null || Object.hasOwn(tree, '__ref__')) return tree;
  return { __type__: 'TreeNode', ...tree, left: typedTree(tree.left), right: typedTree(tree.right) };
}

const expectedLists = [[...Array.from({ length: 20 }, (_, i) => i + 1)], [-7]];
const wide = Array.from({ length: 257 }, (_, i) => i);
const wideLast = [...wide.slice(0, -1), -13];
const wideSources = {
  js: 'function solve(nums){return nums;}',
  ts: 'function solve(nums: number[]): number[] {return nums;}',
  py: 'def solve(nums): return nums\n',
  java: 'class Solution { public int[] solve(int[] nums) { return nums; } }',
  cs: 'public class Solution { public int[] solve(int[] nums) { return nums; } }',
  cpp: '#include <vector>\nclass Solution { public: std::vector<int> solve(std::vector<int> nums) { return nums; } };',
};
for (const ext of Object.keys(languages)) {
  const stdout = parity('stdout', `solution.${ext}`);
  const delta = ext === 'cpp' ? 1 : 0;
  const print = JSON.parse(parity('stdout', 'case.json')).anchors.print[languages[ext]];
  const anchor = stdout.split('\n').findIndex((line) => line.includes(print)) + 1;
  if (anchor === 0) throw new Error(`Print anchor: ${ext}`);
  add('G1', 'stdout', ext, stdout, rows([{ n: 7 }, { n: 11 }], [7 + delta, 11 + delta], [7 + delta, 999]).map((row, index) => ({
    ...row, stdout: `${row.input.n}\n`, verdict: index === 0 ? 'passed' : 'failed', anchor, anchorInput: row.input.n,
  })));

  const treeSource = parity('binary-node-input-snapshot', `solution.${ext}`);
  const typedReturn = (source, type, argument) => source.replace(/\bint solve\(/, `${type} solve(`).replace(/: number \{/, `: ${type} | null {`).replace(new RegExp(`return ${argument}(?:->|\\.)val`), `return ${argument}`);
  const graphOracles = ext === 'py'
    ? '100*int(root.left is root.right) + 10*int(root.left.left is root) + root.left.val'
    : ext === 'cpp'
      ? '(root->left == root->right ? 100 : 0) + (root->left->left == root ? 10 : 0) + root->left->val'
      : ext === 'cs'
        ? '(object.ReferenceEquals(root.left, root.right) ? 100 : 0) + (object.ReferenceEquals(root.left.left, root) ? 10 : 0) + root.left.val'
        : `(root.left ${ext === 'java' ? '==' : '==='} root.right ? 100 : 0) + (root.left.left ${ext === 'java' ? '==' : '==='} root ? 10 : 0) + root.left.val`;
  const treeInputs = [{ root: treeA }, { root: treeB }];
  add('G6', 'graph-input', ext, treeSource.replace(/return root(?:->|\.)val/, `return ${graphOracles}`), rows(treeInputs, [112, 2]));
  add('G6', 'graph-output', ext, typedReturn(treeSource, ext === 'cpp' ? 'TreeNode*' : 'TreeNode', 'root'),
    rows(treeInputs, [typedTree(treeA), typedTree(treeB)]), { graph: true });

  add('G6', 'wide', ext, wideSources[ext], rows([{ nums: wide }, { nums: wideLast }], [wide, wideLast]));
  const listSource = parity('list-node-input-snapshot', `solution.${ext}`);
  add('G6', 'deep', ext, typedReturn(listSource, ext === 'cpp' ? 'ListNode*' : 'ListNode', 'head'),
    rows(expectedLists.map((values) => ({ head: list(values) })), expectedLists.map((values) => list(values, true))), { graph: true });
}

const java = read('tests/test-java-prepared-input-references.ts');
for (const [name, code, functionName, head, answer] of [
  ['constructor-count', literal(java.split('function testNodesAreBuiltOnce()')[1], 'code'), 'count', list(Array.from({ length: 16 }, (_, i) => i + 1)), '16:16'],
  ['constructor-cycle', literal(java, 'strictNode'), 'shape', { __id__: 's', val: 7, next: { __ref__: 's' } }, '7:7:true'],
]) {
  add('G6', name, 'java', code, rows([{ head }, { head }], [answer, answer]), { functionName, executionStyle: 'solution-method' });
}

const cpp = read('tests/test-cpp-ops-class-delete-alias-browser.ts', '2d488f14');
function cppLines(name) {
  const source = cpp.match(new RegExp('const ' + name + ' = \\[([^]*?)\\]\\.join'))?.[1];
  if (!source) throw new Error(`Missing ${name}`);
  return [...source.matchAll(/^  '([^\r\n]*)',\r?$/gm)].map((match) => match[1]).join('\n');
}
function ops(operations, args) {
  return { operations: ['KeyValueStore', ...operations], arguments: [[], ...args] };
}
const kv1 = ops(['set', 'get', 'delete', 'get', 'delete'], [['a', 1], ['a'], ['a'], ['a'], ['a']]);
const kv2 = ops(['set', 'get', 'delete', 'get', 'delete'], [['b', 7], ['b'], ['c'], ['b'], ['b']]);
const macro = ops(['set', 'set', 'delete', 'size', 'delete'], [['a', 1], ['b', 2], ['a'], [], ['z']]);
const cppOpts = { functionName: 'KeyValueStore', executionStyle: 'ops-class' };
add('G6', 'cpp-delete-alias', 'cpp', cppLines('KV_SOURCE'), rows([kv1, kv2], [[null, null, 1, true, null, false], [null, null, 7, false, 7, true]]), cppOpts);
add('G6', 'cpp-delete-macro', 'cpp', cppLines('MACRO_SOURCE'), rows([macro, macro], [[null, null, null, true, 1, false], [null, null, null, true, 1, false]]), cppOpts);

for (const hasDefault of [false, true]) {
  const code = `#include <string>
#include <vector>
struct Value {
  int number;
  std::string text;
  ${hasDefault ? 'Value() : number(0) {}' : ''}
  Value(int n) : number(n) {}
  Value(const std::string& s) : number(0), text(s) {}
};
class Solution {
public:
  int solve(std::vector<std::vector<Value>> operations) {
    return operations[0][0].text == "add" ? operations[0][1].number : -1;
  }
};`;
  add('G6', hasDefault ? 'cpp-value-default' : 'cpp-value-no-default', 'cpp', code,
    rows([{ operations: [['add', 7]] }, { operations: [['add', 11]] }], [7, 11]), { executionStyle: 'solution-method' });
}

const scriptSources = {
  js: 'console.log(7);',
  ts: 'const n: number = 7; console.log(n);',
  py: 'print(7)\n',
  java: 'class Main { public static void main(String[] args) { System.out.println(7); } }',
  cs: 'System.Console.WriteLine(7);',
  cpp: '#include <cstdio>\nint main() { std::printf("7\\n"); }',
};
const methodSources = {
  ...wideSources,
  js: 'class Solution { solve(nums) { return nums; } }',
  ts: 'class Solution { solve(nums: number[]): number[] { return nums; } }',
  py: 'class Solution:\n    def solve(self, nums): return nums\n',
};
const opsSources = {
  js: 'class Counter { add(n) { return n + 1; } }',
  ts: 'class Counter { add(n: number): number { return n + 1; } }',
  py: 'class Counter:\n    def add(self, n): return n + 1\n',
  java: 'class Counter { public int add(int n) { return n + 1; } }',
  cs: 'public class Counter { public int add(int n) { return n + 1; } }',
  cpp: 'class Counter { public: int add(int n) { return n + 1; } };',
};
for (const ext of Object.keys(languages)) {
  add('G6', 'invocation-script', ext, scriptSources[ext], rows([{}, {}], [null, null]).map((row) => ({ ...row, stdout: '7\n' })),
    { functionName: undefined, executionStyle: undefined, untracedOnly: true });
  add('G6', 'invocation-method', ext, methodSources[ext], rows([{ nums: [7] }, { nums: [11] }], [[7], [11]]),
    { executionStyle: 'solution-method', untracedOnly: true });
  const inputs = [7, 11].map((n) => ({ operations: ['Counter', 'add'], arguments: [[], [n]] }));
  add('G6', 'invocation-ops', ext, opsSources[ext], rows(inputs, [[null, 8], [null, 12]]),
    { functionName: 'Counter', executionStyle: 'ops-class', untracedOnly: true });
}

add('G6', 'over-ceiling', 'py', program, [
  { id: 'A', input: { kind: 'big', n: 250001 }, status: 'runtime-error', verdict: 'not-evaluated', failure: { origin: 'limit', reason: 'serialization-limit' } },
  { id: 'B', input: { kind: 'small', n: 0 }, actual: [1, 2, 3], expected: [1, 2, 3] },
], queensOptions);

const requests = requestMatrix(['A', 'B']);
const rowChecks = ['identity', 'status', 'value', 'console', 'failure', 'verdict', 'termination', 'diagnostics'];
const requiredAppFixtures = appSpec.map((spec) => ({
  gate: 'G6', language: 'cpp', name: appFixtureName(spec), cases: spec.cases.map((id) => ({ id })),
}));
const inventory = [...fixtures, ...requiredAppFixtures].flatMap((fixture) => [
  ...requestMatrix(fixture.cases.map(({ id }) => id), fixture), ...muxRequests(fixture),
  ...jsRouteRequests(fixture).flatMap(({ requests }) => requests),
].flatMap((request) => {
  const prefix = `${fixture.gate}/${fixture.language}/${fixture.name}/${request.route ?? 'default'}/${request.id}`;
  return [
    ...['order', 'compile', 'compile-footprint', 'correlation', ...(request.mode === 'submit' ? ['aggregate'] : []), ...(request.id.startsWith('legacy-') ? ['legacy-projection'] : []), ...(request.route !== 'mux' ? ['worker-ack'] : [])].map((id) => `${prefix}/@request/${id}`),
    ...request.cases.flatMap((caseId) => [
      ...rowChecks,
      ...(fixture.name === 'stdout' && request.selected.includes(caseId) ? ['source-event', 'case-binding'] : []),
    ].map((id) => `${prefix}/${caseId}/${id}`)),
  ];
}));
for (const fixture of fixtures) {
  for (const route of cppDirectRoutes(fixture)) {
    const prefix = `${fixture.gate}/cpp/${fixture.name}/${route}/code`;
    inventory.push(`${prefix}/@request/worker-ack`, `${prefix}/@request/cardinality`);
    for (const { id } of fixture.cases) {
      inventory.push(...['status', 'value', 'console'].map((check) => `${prefix}/${id}/${check}`));
    }
  }
}
const baselineCaps = Object.values(languages).filter((language) => language !== 'python').map((language) => ({
  language, id: `G6/${language}/judged-byte-limit/provider/policy/@request/limit`, status: 'required-baseline-failure',
  reason: 'no explicit judge limit: no serialization-limit possible',
}));
inventory.push(...baselineCaps.map(({ id }) => id));
for (const fixture of fixtures.filter(({ untracedOnly }) => !untracedOnly)) {
  for (const row of fixture.cases) {
    inventory.push(`${fixture.gate}/${fixture.language}/${fixture.name}/default/path-differential/${row.id}/receipt`);
  }
}
const controls = [
  { seed: 'stdout-b', fixture: 'G1/python/stdout', requests: ['run-first'], keys: ['run-first/B/value'], unchanged: ['run-first/B/verdict'], hits: 1 },
  { seed: 'stdout-all', fixture: 'G1/python/stdout', requests: requests.map(({ id }) => id), keys: requests.flatMap((request) => request.cases.map((id) => `${request.id}/${id}/value`)), hits: 18 },
  { seed: 'split-second-edge', fixture: 'G6/python/graph-input', requests: ['submit-default-A'], keys: ['submit-default-A/A/value'], hits: 1 },
  { seed: 'list-field', fixture: 'G1/python/builtin-class', requests: ['submit-default-A'], keys: ['submit-default-A/A/value'], hits: 1 },
];
if (new Set(inventory).size !== inventory.length) throw new Error('Repeated assertion IDs');
const path = new URL('manifest.json', import.meta.url);
writeFileSync(path, '{\n'
  + Object.entries({ candidate, traceOptions, fixtures, requests, rowChecks, baselineCaps, controls, inventory })
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${Array.isArray(value) ? '[\n' + value.map((item) => '    ' + JSON.stringify(item)).join(',\n') + '\n  ]' : JSON.stringify(value)}`)
    .join(',\n')
  + '\n}\n');
