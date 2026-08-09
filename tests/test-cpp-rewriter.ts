#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sharedKernelPolicySource = (await readFile('workers/shared/runtime-kernel-policy.js', 'utf8'))
  .replace(/\bexport\s+/g, '');
const workerSource = (await readFile('workers/cpp/cpp-worker.js', 'utf8')).replace(
  /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/,
  ''
);
const sandbox: Record<string, unknown> = {
  console,
  TextEncoder,
  TextDecoder,
  URL,
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
  `${sharedKernelPolicySource}
const isRuntimeDeviceDirectory = isRuntimeKernelDeviceDirectory;
const isRuntimeDeviceNamespacePath = isRuntimeKernelDeviceNamespacePath;
const isRuntimeProcPath = isRuntimeKernelProcPath;
${workerSource}
globalThis.__tracecodeCppRewriter = {
  buildBatchDriverSource,
  buildDriverSource,
  buildOpsClassDriverSource,
  buildPreparedOpsClassDriverSource,
  instrumentCppSourceForTracing,
  parseCppFunctionSignatures,
};`,
  context,
  { filename: 'cpp-worker.js' }
);

const rewriter = sandbox.__tracecodeCppRewriter as {
  buildBatchDriverSource: (
    source: string,
    functionName: string,
    inputBatch: readonly Record<string, unknown>[],
    options?: Record<string, unknown>
  ) => string;
  buildDriverSource: (
    source: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => string;
  buildOpsClassDriverSource: (
    source: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => string;
  buildPreparedOpsClassDriverSource: (
    source: string,
    className: string,
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
  instrumented.includes('tracecode::emit_serialized_call_event(__tc_call_line_2, "dfs"'),
  'rewriter should emit helper call instrumentation'
);
assertCondition(
  instrumented.includes('tracecode::TraceHooks::setCurrentLine') &&
    instrumented.includes('tracecode::TraceHooks::emitPostLineFrame'),
  'rewriter should use TraceHooks current-line and post-line frame instrumentation'
);
assertCondition(
  instrumented.includes('__tc_return_3') && instrumented.includes('tracecode::emit_serialized_return_event(3, "dfs"'),
  'rewriter should instrument one-line conditional helper returns'
);

const selectedTraceBatchDriver = rewriter.buildBatchDriverSource(
  source,
  'reachable',
  [{ graph: [[1], [0]] }, { graph: [[]] }],
  { tracing: true }
);
assertCondition(
  selectedTraceBatchDriver.includes('int main(int argc, char** argv)') &&
    selectedTraceBatchDriver.includes('tracecode::parse_json(argv[1])'),
  'tracing batch driver should accept one runtime trace-selection vector'
);
assertCondition(
  selectedTraceBatchDriver.includes(
    'tracecode::set_tracing_enabled(__tc_trace_enabled_for_case(__tc_case_index))'
  ),
  'tracing batch driver should switch recording per case without recompiling'
);
assertCondition(
  selectedTraceBatchDriver.includes('tracecode::configure_trace_budget(') &&
    selectedTraceBatchDriver.includes(', true);'),
  'tracing batch driver should reset each case budget with recording enabled for its marker'
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

const scriptFunctionLambdaSource = [
  'auto __tracecode_script_main() {',
  '  function<int(unordered_map<string, vector<string>>, string)> bfs;',
  '  bfs = [&](unordered_map<string, vector<string>> graph, string start) -> int {',
  '    for (string neighbor : graph[start]) {',
  '      return 1;',
  '    }',
  '    return 0;',
  '  };',
  '  unordered_map<string, vector<string>> graph;',
  '  graph["A"] = vector<string>{"B"};',
  '  return bfs(graph, "A");',
  '}',
].join('\n');
const scriptFunctionLambdaDriver = rewriter.instrumentCppSourceForTracing(
  scriptFunctionLambdaSource,
  '__tracecode_script_main'
);
assertCondition(
  scriptFunctionLambdaDriver.includes('function<int(tracecode::UnorderedMap<string, vector<string>>, string)> bfs'),
  'script std::function declarations should trace-wrap container arguments'
);
assertCondition(
  scriptFunctionLambdaDriver.includes('tracecode::UnorderedMap<string, vector<string>> graph'),
  'script lambda parameters should stay trace-wrapped after local declaration rewriting'
);
assertCondition(
  scriptFunctionLambdaDriver.includes('graph.with_index_source(start, "start"'),
  'script lambda map index reads should target the traced wrapper receiver'
);

const opsLambdaMapSource = [
  'class Tracker {',
  '  unordered_map<string, vector<int>> groups;',
  'public:',
  '  Tracker() {}',
  '  void add(string key, vector<int> nums) {',
  '    function<void(vector<int>&)> helper;',
  '    helper = [&](vector<int>& xs) -> void {',
  '      groups[key].push_back(xs[0]);',
  '    };',
  '    helper(nums);',
  '  }',
  '  int count(string key) {',
  '    return groups[key].size();',
  '  }',
  '};',
].join('\n');
const opsLambdaMapDriver = rewriter.buildOpsClassDriverSource(
  opsLambdaMapSource,
  'Tracker',
  {
    operations: ['Tracker', 'add', 'count'],
    arguments: [[], ['a', [3, 4]], ['a']],
  },
  { tracing: true }
);
const preparedOpsLambdaMapDriver = rewriter.buildPreparedOpsClassDriverSource(
  opsLambdaMapSource,
  'Tracker',
  { tracing: true }
);
assertCondition(
  preparedOpsLambdaMapDriver.includes('int main(int argc, char** argv)') &&
    preparedOpsLambdaMapDriver.includes(
      'tracecode::set_tracing_enabled(__tc_trace_enabled_for_case(__tc_case_index))'
    ),
  'prepared ops-class tracing should select recording independently per case'
);
assertCondition(
  preparedOpsLambdaMapDriver.includes(
    'if (tracecode::trace_event_admissible(false, 4)) {'
  ) &&
    preparedOpsLambdaMapDriver.includes(
      'if (tracecode::trace_event_admissible(false, 5)) {'
    ),
  'prepared ops-class call argument serialization should be skipped when recording is disabled'
);
assertCondition(
  opsLambdaMapDriver.includes('function<void(tracecode::Vector<int>&)> helper'),
  'ops-class std::function declarations should preserve reference-wrapped container arguments'
);
assertCondition(
  opsLambdaMapDriver.includes('helper = [&](tracecode::Vector<int>& xs) -> void'),
  'ops-class lambda parameters should preserve reference-wrapped container arguments'
);
assertCondition(
  opsLambdaMapDriver.includes('groups.with_index_source(key, "key", 8).push_back'),
  'map values that are vectors should keep proxy method calls for nested write tracing'
);
assertCondition(
  !opsLambdaMapDriver.includes('groups.with_index_source(key, "key", 8)->push_back'),
  'map vector proxy method calls should not be rewritten to raw pointer access'
);

const multilineNoCaptureLambdaSource = [
  'struct ListNode { int val; ListNode* next; };',
  'class Solution {',
  'public:',
  '  ListNode* solve(ListNode* head, int k) {',
  '    auto reverseK = [](ListNode* groupHead, int count)',
  '      -> tuple<ListNode*, ListNode*> {',
  '      ListNode* curr = groupHead;',
  '      ListNode* nxt = curr->next;',
  '      curr->next = nullptr;',
  '      return {curr, nxt};',
  '    };',
  '    auto [first, rest] = reverseK(head, k);',
  '    return first;',
  '  }',
  '};',
].join('\n');
const multilineNoCaptureLambdaDriver = rewriter.buildDriverSource(
  multilineNoCaptureLambdaSource,
  'solve',
  { head: [1, 2], k: 2 },
  { tracing: true }
);
const lambdaBodyStart = multilineNoCaptureLambdaDriver.indexOf('ListNode* curr = groupHead;');
const lambdaBodyEnd = multilineNoCaptureLambdaDriver.indexOf('auto [first, rest] = reverseK(head, k);');
const lambdaBodyInstrumentation = multilineNoCaptureLambdaDriver.slice(lambdaBodyStart, lambdaBodyEnd);
assertCondition(lambdaBodyStart >= 0 && lambdaBodyEnd > lambdaBodyStart, 'multiline no-capture lambda body should remain in rewritten driver');
assertCondition(
  multilineNoCaptureLambdaDriver.includes('tracecode::emit_serialized_call_event(') &&
    multilineNoCaptureLambdaDriver.includes('"reverseK"'),
  'multiline no-capture lambda should be traced as its own lambda frame'
);
assertCondition(
  !lambdaBodyInstrumentation.includes('emit_snapshot_value("head", head') &&
    !lambdaBodyInstrumentation.includes('emit_snapshot_value("k", k'),
  'multiline no-capture lambda body must not snapshot outer method parameters'
);

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
assertCondition(!controlDriver.includes('\\"kind\\":\\"control\\"'), 'control transfers should not emit language-specific control events');
assertCondition(controlDriver.includes('continue;'), 'continue should remain source-equivalent after instrumentation');
assertCondition(controlDriver.includes('break;'), 'break should remain source-equivalent after instrumentation');
assertCondition(
  controlDriver.includes('tracecode::with_trace_line(6') && controlDriver.includes('tracecode::with_trace_line(7'),
  'control conditions should evaluate under the control header source line'
);

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
assertCondition(exceptionDriver.includes('tracecode::emit_serialized_exception_event('), 'lowered throw should emit native exception events when tracing');
assertCondition(exceptionDriver.includes('"negative"'), 'lowered throw should preserve common literal exception messages');
assertCondition(!nonTracingExceptionDriver.includes('tracecode::emit_serialized_exception_event('), 'non-tracing lowered throws should not emit trace markers');

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
assertCondition(fieldDriver.includes('tracecode::emit_serialized_value_event("write"'), 'field assignment should emit a native write event');
assertCondition(fieldDriver.includes('tracecode::emit_serialized_value_event("read"'), 'field return should emit a native read event');
assertCondition(
  fieldDriver.includes(String.raw`"{\"variable\":\"node\",\"path\":[`) &&
    fieldDriver.includes(String.raw`+ "\"children\"" +`),
  'field access targets should include field paths'
);
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
assertCondition(
  classFieldDriver.includes('this->graph.with_index_source(0, nullptr).push_back(1);'),
  'class field mutation should preserve indexed receiver provenance on the traced member wrapper'
);

const classMapFieldSource = [
  'class Solution {',
  '  unordered_map<string, string> parent;',
  'public:',
  '  void solve(string email) {',
  '    if (parent.find(email) == parent.end()) {',
  '      parent[email] = email;',
  '    }',
  '  }',
  '};',
].join('\n');
const classMapFieldDriver = rewriter.buildDriverSource(classMapFieldSource, 'solve', { email: 'a' }, { tracing: true });
assertCondition(
  classMapFieldDriver.includes('parent.find_with_index_source(email, "email")'),
  'class map field find should preserve key provenance'
);
assertCondition(
  classMapFieldDriver.includes('parent.with_index_source(email, "email", 6) = email;'),
  'class map field keyed write should preserve key provenance'
);

const pairQueueSource = [
  'class Solution {',
  'public:',
  '  int traverse() {',
  '    queue<pair<int, int>> q;',
  '    q.push({0, 1});',
  '    auto [row, col] = q.front();',
  '    q.pop();',
  '    return row + col;',
  '  }',
  '};',
].join('\n');
const pairQueueDriver = rewriter.buildDriverSource(pairQueueSource, 'traverse', {}, { tracing: true });
assertCondition(
  pairQueueDriver.includes('tracecode::Queue<pair<int, int>> q'),
  'pair-backed C++ queues should be trace-wrapped as indexed frontier state'
);
assertCondition(
  pairQueueDriver.includes('tracecode::with_scoped_trace_line(5') &&
    pairQueueDriver.includes('q.push({0, 1});') &&
    pairQueueDriver.includes('tracecode::with_scoped_trace_line(7') &&
    pairQueueDriver.includes('q.pop();'),
  'pair-backed C++ queue mutations should execute through traced queue wrappers on the source line'
);
assertCondition(
  !pairQueueDriver.includes('RawTraceStep') && !pairQueueDriver.includes('visualization'),
  'pair-backed C++ queue tracing must stay v4-native'
);

const priorityQueueSource = [
  'class Solution {',
  'public:',
  '  int kthSmallest(vector<vector<int>>& matrix) {',
  '    using Entry = array<int, 3>;',
  '    auto compare = [](const Entry& a, const Entry& b) { return a[0] > b[0]; };',
  '    priority_queue<Entry, vector<Entry>, decltype(compare)> heap(compare);',
  '    heap.push({matrix[0][0], 0, 0});',
  '    heap.pop();',
  '    return 0;',
  '  }',
  '};',
].join('\n');
const priorityQueueDriver = rewriter.buildDriverSource(priorityQueueSource, 'kthSmallest', { matrix: [[1]] }, { tracing: true });
assertCondition(
  priorityQueueDriver.includes('tracecode::PriorityQueue<Entry, vector<Entry>, decltype(compare)> heap(compare, "heap"'),
  'C++ priority_queue locals with comparator constructor args should be trace-wrapped'
);
assertCondition(
  priorityQueueDriver.includes('tracecode::with_scoped_trace_line(7') &&
    priorityQueueDriver.includes('heap.push({') &&
    priorityQueueDriver.includes('tracecode::with_scoped_trace_line(8') &&
    priorityQueueDriver.includes('heap.pop();'),
  'C++ priority_queue push/pop should execute through traced wrappers on the source line'
);

const stringIndexedWriteSource = [
  'class Solution {',
  'public:',
  '  string swapOne(string s) {',
  '    int right = 1;',
  '    char temp = s[right];',
  '    s[right] = temp;',
  '    return s;',
  '  }',
  '};',
].join('\n');
const stringIndexedWriteDriver = rewriter.buildDriverSource(stringIndexedWriteSource, 'swapOne', { s: 'ab' }, { tracing: true });
assertCondition(
  stringIndexedWriteDriver.includes('tracecode::emit_index_write_value("s", s, __tc_index_6, 6, "right");'),
  'C++ string indexed assignment should emit indexed write instrumentation'
);

const setRangeSource = [
  'class Solution {',
  'public:',
  '  int sumSet(set<int>& values) {',
  '    int total = 0;',
  '    for (int value : values) total += value;',
  '    return total;',
  '  }',
  '};',
].join('\n');
const setRangeDriver = rewriter.buildDriverSource(setRangeSource, 'sumSet', { values: [1, 2] }, { tracing: true });
assertCondition(
  setRangeDriver.includes('tracecode::set_range_readable(values, 5, "value", "values")'),
  'C++ set range-for should emit member reads through set_range_readable'
);

console.log('PASS: C++ rewriter source snapshots');
