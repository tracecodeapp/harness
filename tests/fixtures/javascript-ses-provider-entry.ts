import { createAlgorithmJudgeBundle } from '../../packages/judge/src/algorithm-bundle';
import { createBrowserRuntimeHost } from '../../packages/runtime-browser/src/browser-runtime-host';
import { createBrowserRuntimeProviderRegistry } from '../../packages/runtime-browser/src/runtime-provider-registry';
import { createJavaScriptBrowserRuntimeProvider } from '../../packages/runtime-javascript/src/browser-runtime-provider';
import { createBrowserJudgeHostFromRuntimeHost } from '../../src/internal/browser-judge';
import {
  buildRuntimeTraceParitySignature,
  type RuntimeTrace,
} from '../../packages/runtime-contracts/src/runtime-trace';

type AlgorithmCase = {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly expected: unknown;
};

function describeValueShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      length: value.length,
      indices: Array.from({ length: value.length }, (_, index) => ({
        own: Object.prototype.hasOwnProperty.call(value, index),
        undefined: value[index] === undefined,
        negativeZero: Object.is(value[index], -0),
      })),
    };
  }
  if (value !== null && typeof value === 'object') {
    return {
      kind: 'object',
      keys: Object.keys(value),
      undefinedKeys: Object.keys(value).filter(
        (key) => (value as Record<string, unknown>)[key] === undefined
      ),
    };
  }
  return { kind: typeof value, negativeZero: Object.is(value, -0) };
}

async function evaluate(
  host: ReturnType<typeof createBrowserJudgeHostFromRuntimeHost>,
  input: {
    readonly id: string;
    readonly language: 'javascript' | 'typescript';
    readonly code: string;
    readonly functionName: string;
    readonly executionStyle?: 'function' | 'solution-method' | 'ops-class';
    readonly trace?: boolean;
    readonly limits?: { readonly wallClockMs?: number };
    readonly cases: readonly AlgorithmCase[];
  }
) {
  const bundle = await createAlgorithmJudgeBundle(input);
  const startedAt = performance.now();
  const receipt = await host.evaluateAlgorithm({ bundle });
  return {
    elapsedMs: performance.now() - startedAt,
    verdict: receipt.verdict,
    passedCount: receipt.passedCount,
    totalCount: receipt.totalCount,
    evaluationStatus: receipt.evaluation.status,
    values: receipt.evaluation.status === 'completed'
      ? receipt.evaluation.cases.map((testCase) => testCase.value)
      : [],
    valueShapes: receipt.evaluation.status === 'completed'
      ? receipt.evaluation.cases.map((testCase) => describeValueShape(testCase.value))
      : [],
    stdout: receipt.evaluation.status === 'completed'
      ? receipt.evaluation.cases.map((testCase) => testCase.stdout)
      : [],
    timings: receipt.evaluation.status === 'completed'
      ? receipt.evaluation.cases.map((testCase) => testCase.timings)
      : [],
    traces: receipt.evaluation.status === 'completed'
      ? receipt.evaluation.cases.map((testCase) => testCase.trace)
      : [],
    caseVerdicts: receipt.evaluation.status === 'completed'
      ? receipt.evaluation.cases.map((testCase) => testCase.verdict.kind)
      : [],
    diagnostics: receipt.evaluation.status === 'completed'
      ? receipt.evaluation.cases.flatMap((testCase) => testCase.diagnostics)
      : receipt.evaluation.compile.diagnostics,
  };
}

export async function runJavaScriptSesProvider(assetBaseUrl: string) {
  const runtimeHost = createBrowserRuntimeHost({
    assetBaseUrl,
    providers: ['javascript', 'typescript'],
    providerRegistry: createBrowserRuntimeProviderRegistry([
      createJavaScriptBrowserRuntimeProvider(),
    ]),
    safeExecution: { workerLifecycle: 'retire-only' },
  });
  const host = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  try {
    const isolation = await evaluate(host, {
      id: 'ses-provider-isolation',
      language: 'javascript',
      code: `function solve(value) {
  const previous = globalThis.__tracecodeGlobalLeak ?? null;
  globalThis.__tracecodeGlobalLeak = value;
  return previous;
}`,
      functionName: 'solve',
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `isolation-${index}`,
        input: { value: index + 1 },
        expected: null,
      })),
    });
    const typescript = await evaluate(host, {
      id: 'ses-provider-typescript',
      language: 'typescript',
      code: 'function solve(value: number): number { return value + 1; }',
      functionName: 'solve',
      cases: Array.from({ length: 100 }, (_, index) => ({
        id: `typescript-${index}`,
        input: { value: index },
        expected: index + 1,
      })),
    });
    const ordering = await evaluate(host, {
      id: 'ses-provider-ordering',
      language: 'javascript',
      code: 'function solve(second, first, ...tail) { return [first, second, ...tail]; }',
      functionName: 'solve',
      cases: [{
        id: 'ordering',
        input: { first: 1, second: 2, tail: [3, 4] },
        expected: [1, 2, 3, 4],
      }],
    });
    const nullRest = await evaluate(host, {
      id: 'ses-provider-null-rest',
      language: 'javascript',
      code: 'function solve(first, ...tail) { return [first, ...tail]; }',
      functionName: 'solve',
      cases: [{
        id: 'null-rest',
        input: { first: 1, tail: null },
        expected: [1],
      }],
    });
    const safeGlobals = await evaluate(host, {
      id: 'ses-provider-safe-globals',
      language: 'javascript',
      code: `function solve() {
  const values = new Float64Array([1.5, 2.5]);
  const cloned = structuredClone({ value: values[0] + values[1] });
  const url = new URL('/judge?mode=ses', 'https://tracecode.app');
  return [cloned.value, url.pathname, url.searchParams.get('mode'), atob(btoa('trace'))];
}`,
      functionName: 'solve',
      cases: [{
        id: 'safe-globals',
        input: {},
        expected: [4, '/judge', 'ses', 'trace'],
      }],
    });
    const deterministicTasks = await evaluate(host, {
      id: 'ses-provider-deterministic-tasks',
      language: 'javascript',
      code: `async function solve(value) {
  const order = [];
  await new Promise((resolve) => {
    setTimeout(() => { order.push('slow'); resolve(); }, 10);
    setTimeout(() => order.push('fast'), 0);
  });
  return [value + 1, order[0]];
}`,
      functionName: 'solve',
      cases: Array.from({ length: 4 }, (_, index) => ({
        id: `deterministic-tasks-${index}`,
        input: { value: index },
        expected: [index + 1, 'fast'],
      })),
    });
    const legacyTimerFallback = await evaluate(host, {
      id: 'ses-provider-legacy-timer-fallback',
      language: 'javascript',
      code: `async function solve(value) {
  return new Promise((resolve) => {
    const id = setInterval(() => { clearInterval(id); resolve(value + 1); }, 0);
  });
}`,
      functionName: 'solve',
      cases: [{ id: 'legacy-timer-fallback', input: { value: 4 }, expected: 5 }],
    });
    const listMaterializer = await evaluate(host, {
      id: 'ses-provider-list-materializer',
      language: 'typescript',
      code: `function solve(head: ListNode | null): number {
  let sum = 0;
  while (head) { sum += head.val; head = head.next; }
  return sum;
}`,
      functionName: 'solve',
      cases: [{ id: 'list', input: { head: [1, 2, 3] }, expected: 6 }],
    });
    const javascriptFallbackMaterializers = await evaluate(host, {
      id: 'ses-provider-javascript-fallback-materializers',
      language: 'javascript',
      code: `function solve(root, head) {
  return [root.val, root.right.value, head.val, head.next.value];
}`,
      functionName: 'solve',
      cases: [{
        id: 'fallback-materializers',
        input: { root: [1, null, 3], head: [4, 5] },
        expected: [1, 3, 4, 5],
      }],
    });
    const referenceHydration = await evaluate(host, {
      id: 'ses-provider-reference-hydration',
      language: 'javascript',
      code: 'function solve(root) { return root.left === root.right; }',
      functionName: 'solve',
      cases: [{
        id: 'reference-hydration',
        input: {
          root: {
            __id__: 'root',
            val: 1,
            left: { __id__: 'child', val: 2, left: null, right: null },
            right: { __ref__: 'child' },
          },
        },
        expected: true,
      }],
    });
    const customMaterializer = await evaluate(host, {
      id: 'ses-provider-custom-materializer',
      language: 'typescript',
      code: `class Campaign {
  constructor(public cap: number, public bid: number) {}
}
function solve(campaigns: Record<string, Campaign>): number {
  return campaigns.a instanceof Campaign ? campaigns.a.cap + campaigns.a.bid : -1;
}`,
      functionName: 'solve',
      cases: [{
        id: 'custom-materializer',
        input: { campaigns: { a: { bid: 5, cap: 7 } } },
        expected: 12,
      }],
    });
    const customClassCycle = await evaluate(host, {
      id: 'ses-provider-custom-class-cycle',
      language: 'javascript',
      code: `class CycleNode {
  constructor() { this.self = this; }
}
function solve() { return new CycleNode(); }`,
      functionName: 'solve',
      cases: [1, 2].map((index) => ({
        id: `custom-class-cycle-${index}`,
        input: {},
        expected: {
          __type__: 'CycleNode',
          __class__: 'CycleNode',
          __id__: 'ref-1',
          self: { __ref__: 'ref-1' },
        },
      })),
    });
    const solutionMethod = await evaluate(host, {
      id: 'ses-provider-solution-method',
      language: 'javascript',
      code: 'class Solution { add(left, right) { return left + right; } }',
      functionName: 'add',
      executionStyle: 'solution-method',
      cases: [{ id: 'method', input: { left: 2, right: 3 }, expected: 5 }],
    });
    const staticSolutionMethod = await evaluate(host, {
      id: 'ses-provider-static-solution-method',
      language: 'javascript',
      code: `class Solution {
  constructor() { throw new Error('must not construct'); }
  static add(left, right) { return left + right; }
}`,
      functionName: 'add',
      executionStyle: 'solution-method',
      cases: [{ id: 'static-method', input: { left: 2, right: 3 }, expected: 5 }],
    });
    const opsClass = await evaluate(host, {
      id: 'ses-provider-ops-class',
      language: 'javascript',
      code: `class Counter {
  constructor(value) { this.value = value; }
  add(value) { this.value += value; return this.value; }
  read() { return this.value; }
}`,
      functionName: 'Counter',
      executionStyle: 'ops-class',
      cases: [{
        id: 'ops',
        input: {
          operations: ['Counter', 'add', 'add'],
          arguments: [[1], [2], [3]],
        },
        expected: [null, 3, 6],
      }],
    });
    const opsClassScalarArguments = await evaluate(host, {
      id: 'ses-provider-ops-class-scalar-arguments',
      language: 'javascript',
      code: `class Counter {
  constructor(value) { this.value = value; }
  add(value) { this.value += value; return this.value; }
  read() { return this.value; }
}`,
      functionName: 'Counter',
      executionStyle: 'ops-class',
      cases: [{
        id: 'ops-scalar',
        input: {
          operations: ['Counter', 'add', 'read'],
          arguments: [[1], 2, null],
        },
        expected: [null, 3, 3],
      }],
    });
    const library = await evaluate(host, {
      id: 'ses-provider-library',
      language: 'javascript',
      code: `const { MinPriorityQueue } = require('@datastructures-js/priority-queue');
function solve(values) {
  const queue = new MinPriorityQueue();
  for (const value of values) queue.enqueue(value);
  return queue.dequeue();
}`,
      functionName: 'solve',
      cases: Array.from({ length: 100 }, (_, index) => ({
        id: `library-${index}`,
        input: { values: [index + 4, index + 1, index + 3] },
        expected: index + 1,
      })),
    });
    const libraryIsolation = await evaluate(host, {
      id: 'ses-provider-library-isolation',
      language: 'javascript',
      code: `const { Queue } = require('@datastructures-js/queue');
function solve(value) {
  const previous = Queue.__tracecodeLeak ?? null;
  try { Queue.__tracecodeLeak = value; } catch {}
  return previous;
}`,
      functionName: 'solve',
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `library-isolation-${index}`,
        input: { value: index + 1 },
        expected: null,
      })),
    });
    const libraryClosureIsolation = await evaluate(host, {
      id: 'ses-provider-library-closure-isolation',
      language: 'javascript',
      code: `const _ = require('lodash');
function solve() { return _.uniqueId(); }`,
      functionName: 'solve',
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `library-closure-isolation-${index}`,
        input: {},
        expected: '1',
      })),
    });
    const lodashTemplateIsolation = await evaluate(host, {
      id: 'ses-provider-lodash-template-isolation',
      language: 'javascript',
      code: `const _ = require('lodash');
function solve(value) {
  const read = _.template('<%= typeof module.exports.__tracecodeLodashLeak === "undefined" ? "clean" : module.exports.__tracecodeLodashLeak %>', { variable: 'data' });
  const write = _.template('<% module.exports.__tracecodeLodashLeak = data.value %>', { variable: 'data' });
  const previous = read({});
  try { write({ value }); } catch {}
  return previous;
}`,
      functionName: 'solve',
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `lodash-template-isolation-${index}`,
        input: { value: index + 1 },
        expected: 'clean',
      })),
    });
    const lodashRandomIsolation = await evaluate(host, {
      id: 'ses-provider-lodash-random-isolation',
      language: 'javascript',
      code: `const _ = require('lodash');
function solve() { return _.sample([3]); }`,
      functionName: 'solve',
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `lodash-random-isolation-${index}`,
        input: {},
        expected: 3,
      })),
    });
    const lodashRunInContextFallback = await evaluate(host, {
      id: 'ses-provider-lodash-run-in-context-fallback',
      language: 'javascript',
      code: `const _ = require('lodash');
function solve() { return typeof _.runInContext === 'function'; }`,
      functionName: 'solve',
      cases: [{ id: 'lodash-run-in-context-fallback', input: {}, expected: true }],
    });
    const lodashBareIdentifier = await evaluate(host, {
      id: 'ses-provider-lodash-bare-identifier',
      language: 'javascript',
      code: `function solve(values) {
  const { chunk } = _;
  return chunk(values, 2);
}`,
      functionName: 'solve',
      cases: [{ id: 'lodash-bare-identifier', input: { values: [1, 2, 3] }, expected: [[1, 2], [3]] }],
    });
    const lodashMutableCaseState = await evaluate(host, {
      id: 'ses-provider-lodash-mutable-case-state',
      language: 'javascript',
      code: `const _ = require('lodash');
function solve() {
  _.mixin({ twice: (value) => value * 2 });
  _.templateSettings.variable = 'data';
  _.memoize.Cache = Map;
  return [_.twice(3), _.templateSettings.variable, _.memoize.Cache === Map];
}`,
      functionName: 'solve',
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `lodash-mutable-case-state-${index}`,
        input: {},
        expected: [6, 'data', true],
      })),
    });
    const nonJsonInputFallback = await evaluate(host, {
      id: 'ses-provider-non-json-input-fallback',
      language: 'javascript',
      code: `function solve(a, b) {
  const text = (value) => Object.is(value, -0) ? '-0' : String(value);
  return [typeof a, text(a), typeof b, text(b)];
}`,
      functionName: 'solve',
      cases: [
        {
          id: 'undefined-input',
          input: { a: undefined, b: 2 },
          expected: ['undefined', 'undefined', 'number', '2'],
        },
        {
          id: 'non-finite-input',
          input: { a: Infinity, b: NaN },
          expected: ['number', 'Infinity', 'number', 'NaN'],
        },
        {
          id: 'negative-zero-input',
          input: { a: -0, b: 0 },
          expected: ['number', '-0', 'number', '0'],
        },
      ],
    });
    const sharedValue = { marker: 7 };
    const sharedInputFallback = await evaluate(host, {
      id: 'ses-provider-shared-input-fallback',
      language: 'javascript',
      code: 'function solve(a, b) { return a === b; }',
      functionName: 'solve',
      cases: [{
        id: 'shared-input',
        input: { a: sharedValue, b: sharedValue },
        expected: true,
      }],
    });
    const underscoreParameter = await evaluate(host, {
      id: 'ses-provider-underscore-parameter',
      language: 'javascript',
      code: 'function solve(_) { return _[0]; }',
      functionName: 'solve',
      cases: [{ id: 'underscore-parameter', input: { _: [7] }, expected: 7 }],
    });
    const htmlOperatorFallback = await evaluate(host, {
      id: 'ses-provider-html-operator-fallback',
      language: 'javascript',
      code: `function solve(n) {
  let count = 0;
  while (n --> 0) count += 1;
  return count;
}`,
      functionName: 'solve',
      cases: [{ id: 'html-operator-fallback', input: { n: 4 }, expected: 4 }],
    });
    const strictExecution = await evaluate(host, {
      id: 'ses-provider-strict-execution',
      language: 'javascript',
      code: `function solve() {
  try { __tracecodeUndeclared = 1; return false; } catch { return true; }
}`,
      functionName: 'solve',
      cases: [{ id: 'strict', input: {}, expected: true }],
    });
    const consoleDebug = await evaluate(host, {
      id: 'ses-provider-console-debug',
      language: 'javascript',
      code: 'function solve(value) { console.debug({ value }); return value; }',
      functionName: 'solve',
      cases: [{ id: 'console-debug', input: { value: 7 }, expected: 7 }],
    });
    const consoleBlankSource = `function solve(value) {
  console.log('a'); console.log(''); console.log('b');
  return Object.is(value, -0) ? 'negative-zero' : 'regular';
}`;
    const consoleBlankSes = await evaluate(host, {
      id: 'ses-provider-console-blank-ses',
      language: 'javascript',
      code: consoleBlankSource,
      functionName: 'solve',
      cases: [1, 2].map((value) => ({
        id: `console-blank-ses-${value}`,
        input: { value },
        expected: 'regular',
      })),
    });
    const consoleBlankLegacy = await evaluate(host, {
      id: 'ses-provider-console-blank-legacy',
      language: 'javascript',
      code: consoleBlankSource,
      functionName: 'solve',
      cases: [{
        id: 'console-blank-legacy',
        input: { value: -0 },
        expected: 'negative-zero',
      }],
    });
    const consoleCapSource = `function solve(value) {
  for (let index = 0; index < 105; index += 1) console.log('line-' + index);
  return Object.is(value, -0) ? 'negative-zero' : 'regular';
}`;
    const consoleCapSes = await evaluate(host, {
      id: 'ses-provider-console-cap-ses',
      language: 'javascript',
      code: consoleCapSource,
      functionName: 'solve',
      cases: [1, 2].map((value) => ({
        id: `console-cap-ses-${value}`,
        input: { value },
        expected: 'regular',
      })),
    });
    const consoleCapLegacy = await evaluate(host, {
      id: 'ses-provider-console-cap-legacy',
      language: 'javascript',
      code: consoleCapSource,
      functionName: 'solve',
      cases: [{ id: 'console-cap-legacy', input: { value: -0 }, expected: 'negative-zero' }],
    });
    const traceConsoleCap = await evaluate(host, {
      id: 'ses-provider-trace-console-cap',
      language: 'javascript',
      code: consoleCapSource,
      functionName: 'solve',
      trace: true,
      cases: [1, 2].map((value) => ({
        id: `trace-console-cap-${value}`,
        input: { value },
        expected: 'regular',
      })),
    });
    const accessorOutput = await evaluate(host, {
      id: 'ses-provider-accessor-output',
      language: 'javascript',
      code: `function solve() {
  return {
    safe: 1,
    get danger() { return 2; },
  };
}`,
      functionName: 'solve',
      cases: [1, 2].map((index) => ({
        id: `accessor-${index}`,
        input: {},
        expected: { safe: 1, danger: '<accessor>' },
      })),
    });
    const specialOutput = await evaluate(host, {
      id: 'ses-provider-special-output',
      language: 'javascript',
      code: 'function solve() { return [NaN, Infinity, -Infinity, 9007199254740993n]; }',
      functionName: 'solve',
      cases: [{
        id: 'special',
        input: {},
        expected: ['NaN', 'Infinity', '-Infinity', '9007199254740993'],
      }, {
        id: 'special-second',
        input: {},
        expected: ['NaN', 'Infinity', '-Infinity', '9007199254740993'],
      }],
    });
    const outputTransportParity = await evaluate(host, {
      id: 'ses-provider-output-transport-parity',
      language: 'javascript',
      code: `function solve(mode) {
  if (mode === 'object') return { missing: undefined, keep: 1 };
  if (mode === 'array') return [undefined, 1];
  if (mode === 'negative-zero') return [-0];
  if (mode === 'symbol') return [Symbol('tracecode')];
  const sparse = new Array(2);
  sparse[1] = 3;
  return sparse;
}`,
      functionName: 'solve',
      cases: [
        {
          id: 'output-transport-object-undefined',
          input: { mode: 'object' },
          expected: { keep: 1 },
        },
        {
          id: 'output-transport-array-undefined',
          input: { mode: 'array' },
          expected: [null, 1],
        },
        {
          id: 'output-transport-negative-zero',
          input: { mode: 'negative-zero' },
          expected: [0],
        },
        {
          id: 'output-transport-symbol',
          input: { mode: 'symbol' },
          expected: ['Symbol(tracecode)'],
        },
        {
          id: 'output-transport-sparse-array',
          input: { mode: 'sparse' },
          expected: [null, 3],
        },
      ],
    });
    const nodeReferenceParity = await evaluate(host, {
      id: 'ses-provider-node-reference-parity',
      language: 'javascript',
      code: `function solve() {
  const tail = { val: 2, next: null };
  return { val: 1, next: tail, mirror: tail };
}`,
      functionName: 'solve',
      cases: [1, 2].map((index) => ({
        id: `node-reference-parity-${index}`,
        input: {},
        expected: {
          __type__: 'ListNode',
          __id__: 'ListNode:1',
          val: 1,
          next: {
            __type__: 'ListNode',
            __id__: 'ListNode:2',
            val: 2,
            next: null,
          },
          mirror: { __ref__: 'ListNode:2' },
        },
      })),
    });
    const forcedNodeLeafParity = await evaluate(host, {
      id: 'ses-provider-forced-node-leaf-parity',
      language: 'javascript',
      code: `function solve() {
  const leaf = { val: 2, next: null };
  return { val: 1, left: leaf, right: null, other: leaf };
}`,
      functionName: 'solve',
      cases: [1, 2].map((index) => ({
        id: `forced-node-leaf-parity-${index}`,
        input: {},
        expected: {
          __type__: 'TreeNode',
          __id__: 'TreeNode:1',
          val: 1,
          left: {
            __type__: 'TreeNode',
            __id__: 'TreeNode:2',
            val: 2,
            left: null,
            right: null,
            next: null,
          },
          right: null,
          other: { __ref__: 'TreeNode:2' },
        },
      })),
    });
    const sharedReferenceParity = await evaluate(host, {
      id: 'ses-provider-shared-reference-parity',
      language: 'javascript',
      code: `function solve() {
  const row = [1, 2];
  const object = { x: 1 };
  const set = new Set([3]);
  return [[row, row], [object, object], new Array(3).fill([]), [set, set]];
}`,
      functionName: 'solve',
      cases: [1, 2].map((index) => ({
        id: `shared-reference-parity-${index}`,
        input: {},
        expected: [
          [[1, 2], '<cycle>'],
          [{ x: 1 }, '<cycle>'],
          [[], '<cycle>', '<cycle>'],
          [
            { __type__: 'set', values: [3] },
            '<cycle>',
          ],
        ],
      })),
    });
    const binaryOutputParity = await evaluate(host, {
      id: 'ses-provider-binary-output-parity',
      language: 'javascript',
      code: `function solve() {
  const buffer = new ArrayBuffer(3);
  new Uint8Array(buffer).set([1, 2, 3]);
  return [new Int32Array([4, 5]), new DataView(buffer), buffer];
}`,
      functionName: 'solve',
      cases: [1, 2].map((index) => ({
        id: `binary-output-parity-${index}`,
        input: {},
        expected: [
          [4, 5],
          [1, 2, 3],
          [1, 2, 3],
        ],
      })),
    });
    let nestedMapExpected: unknown = 'leaf';
    for (let depth = 0; depth < 25; depth += 1) {
      nestedMapExpected = { __type__: 'map', entries: [[depth, nestedMapExpected]] };
    }
    const deepMapOutput = await evaluate(host, {
      id: 'ses-provider-deep-map-output',
      language: 'javascript',
      code: `function solve() {
  let value = 'leaf';
  for (let depth = 0; depth < 25; depth += 1) value = new Map([[depth, value]]);
  return value;
}`,
      functionName: 'solve',
      cases: [1, 2].map((index) => ({
        id: `deep-map-output-${index}`,
        input: {},
        expected: nestedMapExpected,
      })),
    });
    const asyncOpsClassParity = await evaluate(host, {
      id: 'ses-provider-async-ops-class-parity',
      language: 'javascript',
      code: `class AsyncCounter {
  constructor(value) { this.value = value; }
  async read() { return this.value; }
}`,
      functionName: 'AsyncCounter',
      executionStyle: 'ops-class',
      cases: [1, 2].map((index) => ({
        id: `async-ops-class-parity-${index}`,
        input: { operations: ['AsyncCounter', 'read'], arguments: [[7], []] },
        expected: [null, { __type__: 'Promise', __class__: 'Promise', __id__: 'ref-1' }],
      })),
    });
    const plainObjectMaterializerParity = await evaluate(host, {
      id: 'ses-provider-plain-object-materializer-parity',
      language: 'javascript',
      code: `function solve(root) { return [Object.keys(root), 'value' in root]; }`,
      functionName: 'solve',
      cases: [1, 2].map((index) => ({
        id: `plain-object-materializer-parity-${index}`,
        input: { root: { __id__: 'plain-1', val: 1, left: { val: 2 }, right: null } },
        expected: [['__id__', 'val', 'left', 'right'], false],
      })),
    });
    const libraryPrototypeFallback = await evaluate(host, {
      id: 'ses-provider-library-prototype-fallback',
      language: 'javascript',
      code: `const { MinPriorityQueue } = require('@datastructures-js/priority-queue');
MinPriorityQueue.prototype.tracecodeIsEmpty = function () { return this.size() === 0; };
function solve() { return new MinPriorityQueue().tracecodeIsEmpty(); }`,
      functionName: 'solve',
      cases: [{ id: 'library-prototype-fallback', input: {}, expected: true }],
    });
    const largeOutput = await evaluate(host, {
      id: 'ses-provider-large-output',
      language: 'javascript',
      code: `function solve() {
  return Array.from({ length: 5000 }, (_, index) => ({ index }));
}`,
      functionName: 'solve',
      cases: [{
        id: 'large-output',
        input: {},
        expected: Array.from({ length: 5000 }, (_, index) => ({ index })),
      }],
    });
    const authorities = await evaluate(host, {
      id: 'ses-provider-authorities',
      language: 'javascript',
      code: `function solve() {
  return [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof Worker,
    typeof SharedWorker, typeof indexedDB, typeof caches, typeof postMessage,
    typeof WebAssembly];
}`,
      functionName: 'solve',
      cases: [{
        id: 'authorities-1',
        input: {},
        expected: Array.from({ length: 9 }, () => 'undefined'),
      }, {
        id: 'authorities-2',
        input: {},
        expected: Array.from({ length: 9 }, () => 'undefined'),
      }],
    });
    const ambientBindingParity = await evaluate(host, {
      id: 'ses-provider-ambient-binding-parity',
      language: 'javascript',
      code: `function solve(value) {
  global.cache ??= value;
  return [global.cache, self === undefined, window === undefined,
    document === undefined, postMessage === undefined,
    importScripts === undefined, Worker === undefined,
    SharedWorker === undefined, WebAssembly === undefined,
    process === undefined];
}`,
      functionName: 'solve',
      cases: [3, 5].map((value) => ({
        id: `ambient-binding-parity-${value}`,
        input: { value },
        expected: [value, true, true, true, true, true, true, true, true, true],
      })),
    });
    const dynamicEvaluatorParity = await evaluate(host, {
      id: 'ses-provider-dynamic-evaluator-parity',
      language: 'javascript',
      code: `function solve() {
  const attempt = (operation) => { try { operation(); return 'open'; } catch { return 'blocked'; } };
  return [attempt(() => Function('return 4')()), attempt(() => new Compartment())];
}`,
      functionName: 'solve',
      cases: [1, 2].map((value) => ({
        id: `dynamic-evaluator-parity-${value}`,
        input: { value },
        expected: ['blocked', 'blocked'],
      })),
    });
    const undefinedTargetFallback = await evaluate(host, {
      id: 'ses-provider-undefined-target-fallback',
      language: 'javascript',
      code: 'const starter = true;',
      functionName: 'solve',
      cases: [1, 2].map((value) => ({
        id: `undefined-target-${value}`,
        input: { value },
        expected: null,
      })),
    });
    const asyncContextFallback = await evaluate(host, {
      id: 'ses-provider-async-context-fallback',
      language: 'javascript',
      code: 'function solve() { let await = 1; return await; }',
      functionName: 'solve',
      cases: [1, 2].map((value) => ({
        id: `async-context-fallback-${value}`,
        input: { value },
        expected: 1,
      })),
    });
    const topLevelReturnFallback = await evaluate(host, {
      id: 'ses-provider-top-level-return-fallback',
      language: 'javascript',
      code: 'function solve(value) { return value + 1; } return 0;',
      functionName: 'solve',
      cases: [1, 2].map((value) => ({
        id: `top-level-return-fallback-${value}`,
        input: { value },
        expected: 0,
      })),
    });
    const forAwaitFallback = await evaluate(host, {
      id: 'ses-provider-for-await-fallback',
      language: 'javascript',
      code: 'function solve() { return 1; } for await (const value of []) {}',
      functionName: 'solve',
      cases: [{ id: 'for-await-fallback', input: {}, expected: 1 }],
    });
    const awaitUsingFallback = await evaluate(host, {
      id: 'ses-provider-await-using-fallback',
      language: 'javascript',
      code: 'function solve() { return 1; } { await using value = null; }',
      functionName: 'solve',
      cases: [{ id: 'await-using-fallback', input: {}, expected: 1 }],
    });
    const typescriptForAwaitFallback = await evaluate(host, {
      id: 'ses-provider-typescript-for-await-fallback',
      language: 'typescript',
      code: 'function solve(): number { return 1; } for await (const value of []) {}',
      functionName: 'solve',
      cases: [{ id: 'typescript-for-await-fallback', input: {}, expected: 1 }],
    });
    const constructorEscape = await evaluate(host, {
      id: 'ses-provider-constructor-escape',
      language: 'javascript',
      code: `async function solve() {
  const attempt = async (operation) => {
    try { return await operation(); } catch { return 'blocked'; }
  };
  return [
    await attempt(() => (() => {}).constructor('return typeof fetch')()),
    await attempt(() => (async () => {}).constructor('return typeof postMessage')()),
    await attempt(() => (function* () {}).constructor('return typeof fetch')().next().value),
    await attempt(() => (0, eval)('typeof fetch')),
  ];
}`,
      functionName: 'solve',
      cases: [{
        id: 'constructor-escape-json-safe',
        input: {},
        expected: ['blocked', 'blocked', 'blocked', 'undefined'],
      }, {
        id: 'constructor-escape-non-json',
        input: { value: -0 },
        expected: ['blocked', 'blocked', 'blocked', 'undefined'],
      }],
    });
    const deterministic = await evaluate(host, {
      id: 'ses-provider-deterministic',
      language: 'javascript',
      code: 'function solve() { return [typeof Math.random(), Number.isFinite(Date.now())]; }',
      functionName: 'solve',
      cases: Array.from({ length: 4 }, (_, index) => ({
        id: `deterministic-${index}`,
        input: {},
        expected: ['number', true],
      })),
    });
    const prototypeExtensionFallback = await evaluate(host, {
      id: 'ses-provider-prototype-extension-fallback',
      language: 'javascript',
      code: `Array.prototype.last = function () { return this[this.length - 1]; };
function solve(values) { return values.last(); }`,
      functionName: 'solve',
      cases: [3, 5].map((value) => ({
        id: `prototype-extension-${value}`,
        input: { values: [1, 2, value] },
        expected: value,
      })),
    });
    const runtimeErrorLine = await evaluate(host, {
      id: 'ses-provider-runtime-error-line',
      language: 'javascript',
      code: `function solve() {
  const value = 1;
      throw new Error('line probe ' + value);
}`,
      functionName: 'solve',
      cases: [1, 2].map((value) => ({
        id: `runtime-error-line-${value}`,
        input: {},
        expected: null,
      })),
    });
    const traceFast = await evaluate(host, {
      id: 'ses-provider-trace-fast',
      language: 'javascript',
      code: `function solve(value) {
  const previous = globalThis.__tracecodeTraceLeak ?? null;
  globalThis.__tracecodeTraceLeak = value;
  return [previous, value * 2];
}`,
      functionName: 'solve',
      trace: true,
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `trace-${index}`,
        input: { value: index + 1 },
        expected: [null, (index + 1) * 2],
      })),
    });
    const traceDetachedTaskIsolation = await evaluate(host, {
      id: 'ses-provider-trace-detached-task-isolation',
      language: 'javascript',
      code: `async function solve(value) {
  const previous = globalThis.__tracecodeDetachedTraceLeak ?? null;
  Promise.resolve().then(() => {
    globalThis.__tracecodeDetachedTraceLeak = value;
  });
  return previous;
}`,
      functionName: 'solve',
      trace: true,
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `trace-detached-${index}`,
        input: { value: index + 1 },
        expected: null,
      })),
    });
    const typescriptTraceFast = await evaluate(host, {
      id: 'ses-provider-typescript-trace-fast',
      language: 'typescript',
      code: `function solve(values: number[]): number {
  let total: number = 0;
  for (const value of values) total += value;
  return total;
}`,
      functionName: 'solve',
      trace: true,
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `typescript-trace-${index}`,
        input: { values: [index, index + 1] },
        expected: index * 2 + 1,
      })),
    });
    const traceTimeoutRecovery = await evaluate(host, {
      id: 'ses-provider-trace-timeout-recovery',
      language: 'javascript',
      code: `function solve(value) {
  if (value === 0) return /^(a+)+$/.test('a'.repeat(30) + '!');
  return value;
}`,
      functionName: 'solve',
      trace: true,
      limits: { wallClockMs: 40 },
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `trace-timeout-${index}`,
        input: { value: index },
        expected: index,
      })),
    });
    const timeoutRecovery = await evaluate(host, {
      id: 'ses-provider-timeout-recovery',
      language: 'javascript',
      code: 'function solve(value) { if (value === 0) while (true) {} return value; }',
      functionName: 'solve',
      limits: { wallClockMs: 40 },
      cases: Array.from({ length: 8 }, (_, index) => ({
        id: `timeout-${index}`,
        input: { value: index },
        expected: index,
      })),
    });
    return {
      isolation,
      typescript,
      ordering,
      nullRest,
      safeGlobals,
      deterministicTasks,
      legacyTimerFallback,
      listMaterializer,
      javascriptFallbackMaterializers,
      referenceHydration,
      customMaterializer,
      customClassCycle,
      solutionMethod,
      staticSolutionMethod,
      opsClass,
      opsClassScalarArguments,
      library,
      libraryIsolation,
      libraryClosureIsolation,
      lodashTemplateIsolation,
      lodashRandomIsolation,
      lodashRunInContextFallback,
      lodashBareIdentifier,
      lodashMutableCaseState,
      nonJsonInputFallback,
      sharedInputFallback,
      underscoreParameter,
      htmlOperatorFallback,
      strictExecution,
      consoleDebug,
      consoleBlankSes,
      consoleBlankLegacy,
      consoleCapSes,
      consoleCapLegacy,
      traceConsoleCap,
      accessorOutput,
      specialOutput,
      outputTransportParity,
      nodeReferenceParity,
      forcedNodeLeafParity,
      sharedReferenceParity,
      binaryOutputParity,
      deepMapOutput,
      asyncOpsClassParity,
      plainObjectMaterializerParity,
      libraryPrototypeFallback,
      largeOutput,
      authorities,
      ambientBindingParity,
      dynamicEvaluatorParity,
      undefinedTargetFallback,
      asyncContextFallback,
      topLevelReturnFallback,
      forAwaitFallback,
      awaitUsingFallback,
      typescriptForAwaitFallback,
      constructorEscape,
      deterministic,
      prototypeExtensionFallback,
      timeoutRecovery,
      runtimeErrorLine,
      traceFast,
      traceDetachedTaskIsolation,
      typescriptTraceFast,
      traceTimeoutRecovery,
    };
  } finally {
    host.dispose();
  }
}

export async function runJavaScriptLegacyPageRelativeProvider() {
  const runtimeHost = createBrowserRuntimeHost({
    assetBaseUrl: 'workers',
    providers: ['javascript'],
    providerRegistry: createBrowserRuntimeProviderRegistry([
      createJavaScriptBrowserRuntimeProvider({
        algorithmExecution: 'disposable-worker',
      }),
    ]),
    safeExecution: { workerLifecycle: 'retire-only' },
  });
  const host = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  try {
    return await evaluate(host, {
      id: 'legacy-page-relative-library',
      language: 'javascript',
      code: `const { MinPriorityQueue } = require('@datastructures-js/priority-queue');
function solve(values) {
  const queue = new MinPriorityQueue();
  for (const value of values) queue.enqueue(value);
  return queue.dequeue();
}`,
      functionName: 'solve',
      cases: [{ id: 'legacy-relative', input: { values: [4, 1, 3] }, expected: 1 }],
    });
  } finally {
    host.dispose();
  }
}

export async function runJavaScriptSerializerParity(assetBaseUrl: string) {
  const providers = (algorithmExecution: 'ses-compartment-pool' | 'disposable-worker') =>
    createBrowserRuntimeHost({
      assetBaseUrl,
      providers: ['javascript'],
      providerRegistry: createBrowserRuntimeProviderRegistry([
        createJavaScriptBrowserRuntimeProvider({ algorithmExecution }),
      ]),
      safeExecution: { workerLifecycle: 'retire-only' },
    });
  const sesRuntimeHost = providers('ses-compartment-pool');
  const legacyRuntimeHost = providers('disposable-worker');
  const sesHost = createBrowserJudgeHostFromRuntimeHost(sesRuntimeHost);
  const legacyHost = createBrowserJudgeHostFromRuntimeHost(legacyRuntimeHost);
  const input = {
    id: 'javascript-browser-serializer-parity',
    language: 'javascript' as const,
    code: `function solve(mode, root) {
  if (mode === 'shared') {
    const row = [1, 2];
    const object = { x: 1 };
    const set = new Set([3]);
    return [[row, row], [object, object], new Array(3).fill([]), [set, set]];
  }
  if (mode === 'binary') {
    const buffer = new ArrayBuffer(3);
    new Uint8Array(buffer).set([1, 2, 3]);
    return [new Int32Array([4, 5]), new DataView(buffer), buffer];
  }
  if (mode === 'accessor') return { safe: 1, get danger() { return 2; } };
  if (mode === 'special') return [NaN, Infinity, -Infinity, 9007199254740993n];
  return [Object.keys(root), 'value' in root];
}`,
    functionName: 'solve',
    cases: [
      {
        id: 'shared',
        input: { mode: 'shared', root: null },
        expected: [
          [[1, 2], '<cycle>'],
          [{ x: 1 }, '<cycle>'],
          [[], '<cycle>', '<cycle>'],
          [{ __type__: 'set', values: [3] }, '<cycle>'],
        ],
      },
      {
        id: 'binary',
        input: { mode: 'binary', root: null },
        expected: [[4, 5], [1, 2, 3], [1, 2, 3]],
      },
      {
        id: 'accessor',
        input: { mode: 'accessor', root: null },
        expected: { safe: 1, danger: '<accessor>' },
      },
      {
        id: 'special',
        input: { mode: 'special', root: null },
        expected: ['NaN', 'Infinity', '-Infinity', '9007199254740993'],
      },
      {
        id: 'plain-id',
        input: {
          mode: 'plain-id',
          root: { __id__: 'plain-1', val: 1, left: { val: 2 }, right: null },
        },
        expected: [['__id__', 'val', 'left', 'right'], false],
      },
    ],
  };
  try {
    const [ses, legacy] = await Promise.all([
      evaluate(sesHost, input),
      evaluate(legacyHost, input),
    ]);
    return { ses, legacy };
  } finally {
    sesHost.dispose();
    legacyHost.dispose();
  }
}

export async function runJavaScriptTraceParity(assetBaseUrl: string) {
  const createHost = (
    algorithmExecution: 'ses-compartment-pool' | 'disposable-worker'
  ) => {
    const runtimeHost = createBrowserRuntimeHost({
      assetBaseUrl,
      providers: ['javascript'],
      providerRegistry: createBrowserRuntimeProviderRegistry([
        createJavaScriptBrowserRuntimeProvider({ algorithmExecution }),
      ]),
      safeExecution: { workerLifecycle: 'retire-only' },
    });
    return {
      runtimeHost,
      host: createBrowserJudgeHostFromRuntimeHost(runtimeHost),
    };
  };
  const ses = createHost('ses-compartment-pool');
  const compatibility = createHost('disposable-worker');
  const input = {
    id: 'javascript-browser-trace-parity',
    language: 'javascript' as const,
    code: `function solve(values) {
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    values[index] += 1;
    total += values[index];
  }
  return total;
}`,
    functionName: 'solve',
    trace: true,
    cases: [
      { id: 'first', input: { values: [1, 2, 3] }, expected: 9 },
      { id: 'second', input: { values: [4, 5] }, expected: 11 },
    ],
  };
  try {
    const [fast, general] = await Promise.all([
      evaluate(ses.host, input),
      evaluate(compatibility.host, input),
    ]);
    const signatures = (traces: unknown[]) => traces.map((trace) =>
      buildRuntimeTraceParitySignature(trace as RuntimeTrace)
    );
    return {
      fast,
      general,
      fastSignatures: signatures(fast.traces),
      generalSignatures: signatures(general.traces),
    };
  } finally {
    ses.runtimeHost.dispose();
    compatibility.runtimeHost.dispose();
  }
}

export async function runJavaScriptSesUnavailableFallback(assetBaseUrl: string) {
  const runtimeHost = createBrowserRuntimeHost({
    assetBaseUrl,
    assets: {
      javascriptAlgorithmWorker: `${assetBaseUrl}/missing-ses-algorithm-worker.js`,
    },
    providers: ['javascript'],
    providerRegistry: createBrowserRuntimeProviderRegistry([
      createJavaScriptBrowserRuntimeProvider({
        algorithmExecution: 'ses-compartment-pool',
      }),
    ]),
    safeExecution: { workerLifecycle: 'retire-only' },
  });
  const host = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  try {
    const code = await evaluate(host, {
      id: 'ses-unavailable-code-fallback',
      language: 'javascript',
      code: 'function solve(value) { return value + 1; }',
      functionName: 'solve',
      cases: [{ id: 'code', input: { value: 4 }, expected: 5 }],
    });
    const trace = await evaluate(host, {
      id: 'ses-unavailable-trace-fallback',
      language: 'javascript',
      code: 'function solve(value) { return value + 1; }',
      functionName: 'solve',
      trace: true,
      cases: [{ id: 'trace', input: { value: 7 }, expected: 8 }],
    });
    return { code, trace };
  } finally {
    host.dispose();
  }
}
