#!/usr/bin/env npx tsx

import { classifyCppExceptionUse } from '../workers/cpp/cpp-exceptions.js';
import { cppExceptionPositives, cppExceptionNegatives, mixedExceptionSource } from './fixtures/cpp-exception-cases';
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
).replace(/^import \{ classifyCppExceptionUse \} from '\.\/cpp-exceptions\.js';\s*/m, '');
const sandbox: Record<string, unknown> = {
  classifyCppExceptionUse,
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
  handleCompileRun,
  handleCompileRunBatch,
  handleExecuteWithTracing,
  handleExecuteTraceBatch,
  handlePrepareRuntimeProgram,
  buildBatchDriverSource,
  finalizePreparedObservation,
  buildDriverSource,
  buildOpsClassDriverSource,
  buildOpsClassBatchDriverSource,
  buildPreparedOpsClassDriverSource,
  instrumentCppSourceForTracing,
  parseCppFunctionSignatures,
};`,
  context,
  { filename: 'cpp-worker.js' }
);

const rewriter = sandbox.__tracecodeCppRewriter as {
  handleCompileRun: (call: object) => Promise<Record<string, unknown>>;
  handleExecuteWithTracing: (call: object) => Promise<Record<string, unknown>>;
  handleCompileRunBatch: (call: object) => Promise<Record<string, unknown>>;
  handleExecuteTraceBatch: (call: object) => Promise<Record<string, unknown>>;
  handlePrepareRuntimeProgram: (call: object) => Promise<Record<string, unknown>>;
  finalizePreparedObservation: (
    parsed: Record<string, unknown>, prepared: Record<string, unknown>, attemptToken: string
  ) => { trace: { events: unknown[] }; observation: { cut?: string; attemptedEvents: number } };
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
  buildOpsClassBatchDriverSource: (
    source: string,
    className: string,
    inputBatch: readonly Record<string, unknown>[],
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

for (const [source, token, line, column] of cppExceptionPositives) {
  const classification = classifyCppExceptionUse(source);
  const match = classification.usesExceptions ? classification.firstToken : undefined;
  assertCondition(
    match?.token === token && match.line === line && match.column === column,
    `C++ exception token/location for ${JSON.stringify(source)}: ${JSON.stringify(match)}`,
  );
}
for (const source of cppExceptionNegatives) {
  assertCondition(!classifyCppExceptionUse(source).usesExceptions, `False C++ exception refusal: ${source}`);
}
for (const [handler, payload] of [
  [rewriter.handlePrepareRuntimeProgram, { mode: 'code' }],
  [rewriter.handlePrepareRuntimeProgram, { mode: 'trace' }],
  [rewriter.handleCompileRun, {}],
  [rewriter.handleExecuteWithTracing, {}],
  [rewriter.handleCompileRunBatch, { inputBatch: [{}, {}] }],
  [rewriter.handleExecuteTraceBatch, { inputBatch: [{}, {}] }],
] as const) {
  const result = await handler({ ...payload, code: mixedExceptionSource, functionName: 'solve' });
  const diagnostic = result.diagnostic as { code?: string; line?: number; column?: number } | undefined;
  assertCondition(result.success === false && result.error === 'C++ exceptions are not supported yet' &&
    result.diagnosticStage === 'compile' && result.errorLine === 4 &&
    diagnostic?.code === 'cpp-exceptions-unsupported' && diagnostic.line === 4 && diagnostic.column === 16 &&
    (!('results' in result) || JSON.stringify(result.results) === '[]'),
  `C++ exception prepare result: ${JSON.stringify(result)}`);
}

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

// A one-line loop whose header declares the variable it dereferences: field
// reads must not be emitted before the loop, where the variable is not in
// scope (the traced driver failed to compile, blamed on the learner).
for (const loop of [
  'for (ListNode* node = head; node != nullptr; node = node->next) total += node->val;',
  'for (auto* node = head; node; node = node->next) total += node->val;',
  'for (const ListNode* node = head; node != nullptr; node = node->next) { total += node->val; }',
]) {
  const loopSource = [
    'class Solution {',
    'public:',
    '  int solve(ListNode* head) {',
    '    int total = 0;',
    `    ${loop}`,
    '    return total;',
    '  }',
    '};',
  ].join('\n');
  const loopInstrumented = rewriter.instrumentCppSourceForTracing(loopSource, 'solve');
  const loopLines = loopInstrumented.split('\n');
  const forIndex = loopLines.findIndex((line) => /^\s*for \(/.test(line));
  assertCondition(forIndex >= 0, `rewriter should keep the loop: ${loopInstrumented}`);
  const leaked = loopLines.slice(0, forIndex).filter((line) => /\bnode\s*->/.test(line) || /to_json\(node\)/.test(line));
  assertCondition(
    leaked.length === 0,
    `rewriter must not read a for-header variable before its loop (${loop}): ${leaked.join(' | ')}`
  );
}

// `delete` is a C++ keyword, so an ops-class learner names the method
// `deleteKey`. The prepared driver reads operation names at run time and
// dispatches `delete` to a public deleteKey method. It does no macro-based
// aliasing (text cannot tell a live macro from a dead one), so every other
// operation dispatches by exact name, and unknown operations keep falling
// through to the unresolved error.
const deleteAliasDispatch = (driver: string, method: string) =>
  new RegExp(
    `if \\(__tc_operation_name == "delete"\\) \\{\\s*__tc_operation_handled = __tc_call_${method}\\(`
  ).test(driver);
const deleteKeySource = [
  '#include <string>',
  '#include <unordered_map>',
  'class KeyValueStore {',
  '  std::unordered_map<std::string, int> store;',
  'public:',
  '  void set(std::string key, int value) { store[key] = value; }',
  '  bool deleteKey(std::string key) { return store.erase(key) > 0; }',
  '};',
].join('\n');
const macroDeleteSource = [
  '#include <string>',
  '#include <unordered_map>',
  '#define delete removeKey',
  'class KeyValueStore {',
  '  std::unordered_map<std::string, int> store;',
  'public:',
  '  bool removeKey(std::string key) { return store.erase(key) > 0; }',
  '  bool deleteKey(std::string key) { store.clear(); return false; }',
  '};',
].join('\n');
const noDeleteSource = [
  'class KeyValueStore {',
  'public:',
  '  void set(int key, int value) {}',
  '  bool remove(int key) { return false; }',
  '};',
].join('\n');
for (const tracing of [false, true]) {
  const deleteKeyDriver = rewriter.buildPreparedOpsClassDriverSource(deleteKeySource, 'KeyValueStore', { tracing });
  assertCondition(
    deleteAliasDispatch(deleteKeyDriver, 'deleteKey') &&
      /if \(__tc_operation_name == "deleteKey"\) \{\s*__tc_operation_handled = __tc_call_deleteKey\(/.test(deleteKeyDriver),
    `prepared ops-class driver (tracing ${tracing}) should dispatch "delete" to deleteKey and keep "deleteKey" by name`
  );
  const privateDeleteKeyDriver = rewriter.buildPreparedOpsClassDriverSource(
    deleteKeySource.replace('  bool deleteKey(', 'private:\n  bool deleteKey('),
    'KeyValueStore',
    { tracing }
  );
  assertCondition(
    !privateDeleteKeyDriver.includes('__tc_operation_name == "delete"'),
    `prepared ops-class driver (tracing ${tracing}) should not dispatch "delete" to a private deleteKey`
  );
  // A method the parser records as `delete` (written through a macro) is
  // dispatched by its exact name only: no alias branch is added, so the
  // operation runs exactly once.
  const deleteMethodDriver = rewriter.buildPreparedOpsClassDriverSource(
    [
      '#include <string>',
      '#define delete removeKey',
      'class KeyValueStore {',
      'public:',
      '  bool delete(std::string key) { return true; }',
      '  bool deleteKey(std::string key) { return false; }',
      '};',
    ].join('\n'),
    'KeyValueStore',
    { tracing }
  );
  assertCondition(
    deleteMethodDriver.split('__tc_operation_name == "delete"').length - 1 === 1 &&
      deleteAliasDispatch(deleteMethodDriver, 'delete') &&
      !deleteAliasDispatch(deleteMethodDriver, 'deleteKey'),
    `prepared ops-class driver (tracing ${tracing}) should dispatch a parsed "delete" method once, by name, with no deleteKey alias`
  );
  // Single-case keeps main's first-#define resolution (a known limit: it does
  // not see #undef or #if); this checks only that it is unchanged.
  const singleMacroDriver = rewriter.buildOpsClassDriverSource(
    macroDeleteSource,
    'KeyValueStore',
    { operations: ['KeyValueStore', 'delete'], arguments: [[], ['a']] },
    { tracing }
  );
  assertCondition(
    singleMacroDriver.includes('__tc_instance.removeKey(') && !singleMacroDriver.includes('__tc_instance.deleteKey('),
    `single-case ops-class driver (tracing ${tracing}) should resolve "delete" through the macro`
  );
  const noDeleteDriver = rewriter.buildPreparedOpsClassDriverSource(noDeleteSource, 'KeyValueStore', { tracing });
  assertCondition(
    !noDeleteDriver.includes('__tc_operation_name == "delete"') &&
      noDeleteDriver.includes('C++ ops-class method could not be resolved.'),
    `prepared ops-class driver (tracing ${tracing}) should not invent a "delete" dispatch without a target method`
  );
}

// A dead macro whose name is also a method (#undef, #if 0): the compiler
// calls the real method, so the prepared driver must dispatch the operation
// by its exact name. (The single-case driver's text-level macro lookup sends
// it to the macro target; that is a known limit, left as on main.)
const operationDispatch = (driver: string, operation: string, method: string) =>
  new RegExp(
    `if \\(__tc_operation_name == "${operation}"\\) \\{\\s*__tc_operation_handled = __tc_call_${method}\\(`
  ).test(driver);
const deadMacroSources = {
  undef: [
    '#define get getValue',
    '#undef get',
    'class Store {',
    'public:',
    '  int get() { return 1; }',
    '  int getValue() { return 2; }',
    '};',
  ].join('\n'),
  ifZero: [
    '#if 0',
    '#define size length',
    '#endif',
    'class Store {',
    'public:',
    '  int size() { return 1; }',
    '  int length() { return 2; }',
    '};',
  ].join('\n'),
};
for (const tracing of [false, true]) {
  for (const [name, source] of Object.entries(deadMacroSources)) {
    const [operation, target] = name === 'undef' ? ['get', 'getValue'] : ['size', 'length'];
    const prepared = rewriter.buildPreparedOpsClassDriverSource(source, 'Store', { tracing });
    assertCondition(
      operationDispatch(prepared, operation, operation) &&
        !operationDispatch(prepared, operation, target) &&
        operationDispatch(prepared, target, target),
      `prepared ops-class driver (${name}, tracing ${tracing}) should dispatch "${operation}" to the real ${operation}() past a dead macro, and "${target}" by name`
    );
  }
}

// Resolution ignores comments and string or character literals in both drivers:
// a "deleteKey(" inside a string is not a deleteKey method.
const stringMentionSource = [
  'class KeyValueStore {',
  'public:',
  '  const char* note = "call deleteKey(key) to remove";',
  "  char quote = '\"';",
  '  bool remove(int key) { return false; }',
  '};',
].join('\n');
let stringMentionError = '';
try {
  rewriter.buildOpsClassDriverSource(
    stringMentionSource,
    'KeyValueStore',
    { operations: ['KeyValueStore', 'delete'], arguments: [[], [1]] },
    {}
  );
} catch (error) {
  stringMentionError = error instanceof Error ? error.message : String(error);
}
assertCondition(
  stringMentionError !== '' && !stringMentionError.includes('deleteKey'),
  `single-case ops-class driver should not resolve "delete" through a "deleteKey(" string literal: ${stringMentionError}`
);
const stringMentionPrepared = rewriter.buildPreparedOpsClassDriverSource(stringMentionSource, 'KeyValueStore', {});
assertCondition(
  !stringMentionPrepared.includes('__tc_operation_name == "delete"'),
  'prepared ops-class driver should not resolve "delete" through a "deleteKey(" string literal'
);
// Digit separators are not character literals: deleteKey after 1'000 still counts.
const digitSeparatorSource = [
  'class KeyValueStore {',
  'public:',
  "  int limit() { return 1'000'000; }",
  '  bool deleteKey(int key) { return false; }',
  '};',
].join('\n');
const digitSeparatorSingle = rewriter.buildOpsClassDriverSource(
  digitSeparatorSource,
  'KeyValueStore',
  { operations: ['KeyValueStore', 'delete'], arguments: [[], [1]] },
  {}
);
assertCondition(
  digitSeparatorSingle.includes('__tc_instance.deleteKey(') &&
    operationDispatch(rewriter.buildPreparedOpsClassDriverSource(digitSeparatorSource, 'KeyValueStore', {}), 'delete', 'deleteKey'),
  'a digit separator must not hide a later deleteKey method from either driver'
);

// Both traced drivers record the call under the method that runs (deleteKey),
// not the operation name that selected it.
const tracedSingleDelete = rewriter.buildOpsClassDriverSource(
  deleteKeySource,
  'KeyValueStore',
  { operations: ['KeyValueStore', 'delete'], arguments: [[], ['a']] },
  { tracing: true }
);
const tracedPreparedDelete = rewriter.buildPreparedOpsClassDriverSource(deleteKeySource, 'KeyValueStore', { tracing: true });
assertCondition(
  /emit_serialized_call_event\(7, "deleteKey", __tc_args_json_1\)/.test(tracedSingleDelete) &&
    !/emit_serialized_call_event\(\d+, "delete",/.test(tracedSingleDelete) &&
    /emit_serialized_call_event\(7, "deleteKey", __tc_args_json_7_7\)/.test(tracedPreparedDelete),
  `traced ops-class drivers should record the aliased call as deleteKey in both drivers:\n${tracedSingleDelete.split('\n').filter((line) => line.includes('emit_serialized_call_event')).join('\n')}\n${tracedPreparedDelete.split('\n').filter((line) => line.includes('emit_serialized_call_event')).join('\n')}`
);

// Learner value types as arguments (GA G6 cpp-value-default and
// cpp-value-no-default): a JSON scalar reaches the type through its
// one-argument constructor on every driver, and no driver default-constructs
// a type that has no default constructor.
const valueTypeSource = (withDefault: boolean, owner: 'solution' | 'ops') => [
  '#include <string>',
  '#include <vector>',
  'struct Value {',
  '  int number;',
  '  std::string text;',
  withDefault ? '  Value() : number(0) {}' : '',
  '  Value(int n) : number(n) {}',
  '  Value(const std::string& s) : number(0), text(s) {}',
  '};',
  ...(owner === 'solution'
    ? [
        'class Solution {',
        'public:',
        '  int solve(std::vector<std::vector<Value>> operations) {',
        '    return operations[0][0].text == "add" ? operations[0][1].number : -1;',
        '  }',
        '};',
      ]
    : [
        'class Ledger {',
        '  int total = 0;',
        'public:',
        '  Ledger() = default;',
        '  int add(Value amount) {',
        '    total += amount.number;',
        '    return total;',
        '  }',
        '  std::string label(Value name) {',
        '    return name.text;',
        '  }',
        '};',
      ]),
].join('\n');
const valueOps = { operations: ['Ledger', 'add', 'label'], arguments: [[], [7], ['rent']] };
for (const withDefault of [false, true]) {
  for (const tracing of [false, true]) {
    const solution = valueTypeSource(withDefault, 'solution');
    const ops = valueTypeSource(withDefault, 'ops');
    const adapterDrivers: Record<string, string> = {
      single: rewriter.buildDriverSource(solution, 'solve', { operations: [['add', 7]] }, { tracing }),
      batch: rewriter.buildBatchDriverSource(solution, 'solve', [{ operations: [['add', 7]] }], { tracing }),
      prepared: rewriter.buildBatchDriverSource(solution, 'solve', [{}], { tracing }),
      opsBatch: rewriter.buildOpsClassBatchDriverSource(ops, 'Ledger', [valueOps], { tracing }),
      opsPrepared: rewriter.buildPreparedOpsClassDriverSource(ops, 'Ledger', { tracing }),
    };
    for (const [name, driver] of Object.entries(adapterDrivers)) {
      const label = `${name} driver (default constructor ${withDefault}, tracing ${tracing})`;
      assertCondition(
        driver.includes('struct JsonObjectAdapter<Value>') &&
          driver.includes('return __tc_self(static_cast<int>(__tc_number));') &&
          driver.includes('return __tc_self(std::string(__tc_value.string_value));'),
        `${label} should decode a JSON integer through Value(int) and a JSON string through Value(const std::string&)`
      );
      assertCondition(
        !/\bValue out\{\}/.test(driver) &&
          /if constexpr \(std::is_default_constructible_v<__tc_self>\) \{\s*__tc_self __tc_out\{\};/.test(driver),
        `${label} should default-construct Value only under a default-constructibility check`
      );
    }
    // The single-case ops-class driver decodes its literals through the same
    // adapter (review finding 2 and 4), not with its own constructor calls.
    const opsSingle = rewriter.buildOpsClassDriverSource(ops, 'Ledger', valueOps, { tracing });
    assertCondition(
      opsSingle.includes('struct JsonObjectAdapter<Value>') &&
        /tracecode::json_to<Value>\(\(\[\]\(\) -> const tracecode::JsonValue& \{ static const tracecode::JsonValue __tc_literal = tracecode::parse_json\("7"\)/.test(opsSingle) &&
        opsSingle.includes('tracecode::parse_json("\\"rent\\"")') &&
        !opsSingle.includes('Value(static_cast<int>(7))') && !/Value\{ /.test(opsSingle),
      `single-case ops-class driver (default constructor ${withDefault}, tracing ${tracing}) should decode Value literals through the adapter:\n${opsSingle.split('\n').filter((line) => line.includes('Value')).join('\n')}`
    );
  }
}
// Ambiguous constructors fail with a message naming the type, only when that
// JSON kind is decoded (review finding 5: the object arm still compiles); a
// type that no JSON value can build is refused at compile time.
const ambiguousDriver = rewriter.buildBatchDriverSource(
  'struct Wide { long n; Wide(long x) : n(x) {} Wide(short x) : n(x) {} };\nclass Solution {\npublic:\n  int solve(Wide wide) { return (int)wide.n; }\n};',
  'solve', [{}], {}
);
assertCondition(
  ambiguousDriver.includes("tracecode::json_error(\"TraceCode cannot build C++ type 'Wide' from an integer argument: its constructors taking long and short are equally good matches.\")") &&
    !/static_assert\(sizeof\(/.test(ambiguousDriver),
  'ambiguous one-argument constructors should fail at decode time for that kind only, naming the type'
);
// Review finding 3: generated names cannot hide a learner type (Json, Self).
const jsonNamedDriver = rewriter.buildBatchDriverSource(
  'struct Json { int n; Json() = default; Json(int x) : n(x) {} };\nstruct Self { int n = 0; };\nclass Solution {\npublic:\n  int solve(Json value, Self self) { return value.n + self.n; }\n};',
  'solve', [{}], {}
);
assertCondition(
  jsonNamedDriver.includes('template <typename __tc_json = JsonValue>') &&
    jsonNamedDriver.includes('static Json from(const __tc_json& __tc_value)') &&
    !/typename Json\b|using Self\b|\bSelf out\b/.test(jsonNamedDriver),
  'the adapter template parameter and locals should use the reserved __tc_ prefix'
);
const unusableDriver = rewriter.buildBatchDriverSource(
  '#include <vector>\nstruct Bag { int n; Bag(std::vector<int> v) : n(v.size()) {} };\nclass Solution {\npublic:\n  int solve(Bag bag) { return bag.n; }\n};',
  'solve', [{}], {}
);
assertCondition(
  unusableDriver.includes("static_assert(std::is_default_constructible_v<__tc_self>, \"TraceCode cannot build C++ type 'Bag' from test input"),
  'a type with neither a default nor a scalar constructor should be refused at compile time, naming the type'
);

console.log('PASS: C++ rewriter source snapshots');


const nativeBudget = rewriter.finalizePreparedObservation({
  foundResult: true,
  traceStatus: { traceLimitExceeded: true, timeoutReason: 'single-line-limit', droppedEventCount: 4 },
  events: [
    { kind: 'call', function: '__tracecode_batch_case', line: 1, args: { index: 0 } },
    { kind: 'line', line: 2 },
  ],
}, { inputMode: 'named-batch', source: '', traceOptions: { maxTraceBytes: 1 } }, 'budget-test');
assertCondition(nativeBudget.observation.cut === 'byte-budget' &&
  nativeBudget.observation.attemptedEvents === 5 && nativeBudget.trace.events.length === 0,
'Byte retention must retain an empty prefix with a positive native attempt count.');
