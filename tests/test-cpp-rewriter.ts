#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const workerSource = await readFile('workers/cpp/cpp-worker.js', 'utf8');
const sandbox: Record<string, unknown> = {
  console,
  TextEncoder,
  TextDecoder,
  WebAssembly,
  Date,
  performance,
  Uint8Array,
  BigInt,
  Map,
  Set,
  Error,
  JSON,
  Object,
  String,
  Number,
  Math,
  RegExp,
  Promise,
  postMessage() {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
vm.runInContext(
  `${workerSource}
globalThis.__tracecodeCppRewriter = {
  buildDriverSource,
  instrumentCppSourceForTracing,
  parseCppFunctionSignatures,
};`,
  context,
  { filename: 'cpp-worker.js' }
);

const rewriter = sandbox.__tracecodeCppRewriter as {
  buildDriverSource: (
    source: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => string;
  instrumentCppSourceForTracing: (source: string, functionName: string) => string;
  parseCppFunctionSignatures: (source: string) => Array<{ name: string; line: number }>;
};

const source = [
  'class Solution {',
  '  int dfs(int node, vector<vector<int>>& graph, vector<int>& seen) {',
  '    if (seen[node]) return 0;',
  '    seen[node] = 1;',
  '    int total = 1;',
  '    for (int next : graph[node]) {',
  '      total += dfs(next, graph, seen);',
  '    }',
  '    return total;',
  '  }',
  'public:',
  '  int reachable(vector<vector<int>>& graph) {',
  '    vector<int> seen(graph.size());',
  '    return dfs(0, graph, seen);',
  '  }',
  '};',
].join('\n');

const instrumented = rewriter.instrumentCppSourceForTracing(source, 'reachable');
assertCondition(
  instrumented.includes('tracecode::Vector<vector<int>>& graph'),
  'rewriter should trace-wrap nested vector helper parameters'
);
assertCondition(
  instrumented.includes('tracecode::Vector<int>& seen'),
  'rewriter should trace-wrap vector helper parameters'
);
assertCondition(
  instrumented.includes('\\"function\\":\\"dfs\\"') && instrumented.includes('\\"kind\\":\\"call\\"'),
  'rewriter should emit helper call instrumentation'
);
assertCondition(
  instrumented.includes('tracecode::TraceHooks::setCurrentLine') &&
    instrumented.includes('tracecode::TraceHooks::emitPostLineFrame'),
  'rewriter should use TraceHooks current-line and post-line frame instrumentation'
);
assertCondition(
  instrumented.includes('__tc_return_3') && instrumented.includes('\\"kind\\":\\"return\\"'),
  'rewriter should instrument one-line conditional helper returns'
);
assertCondition(
  !instrumented.includes('RawTraceStep') && !instrumented.includes('visualization'),
  'rewriter output must stay native runtime trace, not visualizer-shaped'
);

const lambdaSource = [
  'class Solution {',
  'public:',
  '  int reachable(vector<vector<int>>& graph) {',
  '    vector<int> seen(graph.size());',
  '    auto dfs = [&](auto&& self, int node) -> int {',
  '      if (seen[node]) return 0;',
  '      seen[node] = 1;',
  '      int total = 1;',
  '      for (int next : graph[node]) total += self(self, next);',
  '      return total;',
  '    };',
  '    return dfs(dfs, 0);',
  '  }',
  '};',
].join('\n');
const lambdaDriver = rewriter.buildDriverSource(lambdaSource, 'reachable', { graph: [[1], [0]] }, { tracing: true });
assertCondition(lambdaDriver.includes('\\"node\\":'), 'self-recursive lambda tracing should keep data arguments');
assertCondition(!lambdaDriver.includes('\\"self\\":'), 'self-recursive lambda tracing should not serialize callable self');
assertCondition(lambdaDriver.includes('tracecode::Vector<int> seen'), 'driver should trace-wrap local vector declarations');

const controlSource = [
  'class Solution {',
  'public:',
  '  int score(vector<int>& nums) {',
  '    int total = 0;',
  '    for (int value : nums) {',
  '      if (value < 0) continue;',
  '      if (value > 5) break;',
  '      total += value;',
  '    }',
  '    return total;',
  '  }',
  '};',
].join('\n');
const controlDriver = rewriter.buildDriverSource(controlSource, 'score', { nums: [1] }, { tracing: true });
assertCondition(controlDriver.includes('\\"kind\\":\\"control\\"'), 'control transfers should emit native control events');
assertCondition(controlDriver.includes('\\"control\\":\\"continue\\"'), 'continue should be captured as a control event');
assertCondition(controlDriver.includes('\\"control\\":\\"break\\"'), 'break should be captured as a control event');

const exceptionSource = [
  'class Solution {',
  'public:',
  '  int safe(int value) {',
  '    if (value < 0) throw std::runtime_error("negative");',
  '    return value;',
  '  }',
  '};',
].join('\n');
const exceptionDriver = rewriter.buildDriverSource(exceptionSource, 'safe', { value: -1 }, { tracing: true });
const nonTracingExceptionDriver = rewriter.buildDriverSource(exceptionSource, 'safe', { value: -1 });
assertCondition(exceptionDriver.includes('\\"kind\\":\\"exception\\"'), 'lowered throw should emit native exception events when tracing');
assertCondition(exceptionDriver.includes('\\"message\\":\\"negative\\"'), 'lowered throw should preserve common literal exception messages');
assertCondition(!nonTracingExceptionDriver.includes('\\"kind\\":\\"exception\\"'), 'non-tracing lowered throws should not emit trace markers');

const fieldSource = [
  'struct Node { unordered_map<string, int> children; };',
  'class Solution {',
  'public:',
  '  int solve(string key) {',
  '    Node node;',
  '    node.children[key] = 1;',
  '    return node.children[key];',
  '  }',
  '};',
].join('\n');
const fieldDriver = rewriter.buildDriverSource(fieldSource, 'solve', { key: 'a' }, { tracing: true });
assertCondition(fieldDriver.includes('\\"kind\\":\\"write\\"'), 'field assignment should emit a native write event');
assertCondition(fieldDriver.includes('\\"kind\\":\\"read\\"'), 'field return should emit a native read event');
assertCondition(fieldDriver.includes('\\"path\\":[\\"children\\"'), 'field access targets should include field paths');
assertCondition(fieldDriver.includes('\\"variable\\":\\"node\\"'), 'field access should target the object variable');
assertCondition(!fieldDriver.includes('RawTraceStep') && !fieldDriver.includes('visualization'), 'field tracing must stay v4-native');

const classFieldSource = [
  'class Solution {',
  '  vector<vector<int>> graph;',
  'public:',
  '  vector<vector<int>> solve(int n) {',
  '    this->graph = vector<vector<int>>(n);',
  '    this->graph[0].push_back(1);',
  '    return this->graph;',
  '  }',
  '};',
].join('\n');
const classFieldDriver = rewriter.buildDriverSource(classFieldSource, 'solve', { n: 2 }, { tracing: true });
assertCondition(
  classFieldDriver.includes('tracecode::Vector<vector<int>> graph{"this", "graph"'),
  'class vector fields should be trace-wrapped with a this.field target'
);
assertCondition(classFieldDriver.includes('this->graph[0].push_back(1);'), 'class field mutation should stay on the traced member wrapper');

console.log('PASS: C++ rewriter source snapshots');
