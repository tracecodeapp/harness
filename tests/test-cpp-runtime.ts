#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';

const smokeScript = String.raw`
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const workerSource = await readFile('workers/cpp/cpp-worker.js', 'utf8');

const readAsset = async (url) => {
  const pathname = String(url).replace('file://', '');
  const data = await readFile(pathname);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    text: async () => data.toString('utf8'),
  };
};

const sandbox = {
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
  globalThis: null,
  self: null,
  postMessage() {},
  fetch: readAsset,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
const script = new vm.Script(
  workerSource + '\nglobalThis.__tracecodeCppTest = { handleInit, handleCompileRun, handleExecuteWithTracing, handleExecuteCodeInterview };',
  {
    importModuleDynamically(specifier) {
      return import(specifier);
    },
  }
);
await script.runInContext(context);

await sandbox.__tracecodeCppTest.handleInit({
  assets: {
    compilerBundleUrl: pathToFileURL(process.cwd() + '/node_modules/@yowasp/clang/gen/bundle.js').href,
    clangWasmUrl: 'file:///missing/clang.wasm',
    lldWasmUrl: 'file:///missing/lld.wasm',
    sysrootUrl: 'file:///missing/sysroot.tar',
    runtimeHeaderUrl: 'file://' + process.cwd() + '/workers/cpp/tracecode_runtime.hpp',
  },
});

const cases = [
  {
    name: 'scalar add',
    code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
    functionName: 'add',
    inputs: { a: 2, b: 3 },
    expected: 5,
  },
  {
    name: 'stdout capture',
    code: 'class Solution { public: int add(int a, int b) { std::printf("sum %d\\n", a + b); return a + b; } };',
    functionName: 'add',
    inputs: { a: 2, b: 3 },
    expected: 5,
    expectedConsoleOutput: ['sum 5'],
  },
  {
    name: 'vector unordered_map twoSum',
    code: 'class Solution { public: vector<int> twoSum(vector<int>& nums, int target) { unordered_map<int,int> seen; for (int i=0;i<nums.size();++i){ int c=target-nums[i]; if(seen.count(c)) return {seen[c],i}; seen[nums[i]]=i;} return {}; } };',
    functionName: 'twoSum',
    inputs: { nums: [2, 7, 11, 15], target: 9 },
    expected: [0, 1],
  },
  {
    name: 'string result',
    code: 'class Solution { public: string greet(string name) { return "hi " + name; } };',
    functionName: 'greet',
    inputs: { name: 'Ada' },
    expected: 'hi Ada',
  },
  {
    name: 'nested vector result',
    code: 'class Solution { public: vector<vector<int>> grid() { return {{1, 2}, {3, 4}}; } };',
    functionName: 'grid',
    inputs: {},
    expected: [
      [1, 2],
      [3, 4],
    ],
  },
  {
    name: 'map result',
    code: 'class Solution { public: map<string, int> count(vector<string>& words) { map<string, int> out; for (auto& word : words) out[word]++; return out; } };',
    functionName: 'count',
    inputs: { words: ['a', 'b', 'a'] },
    expected: { a: 2, b: 1 },
  },
  {
    name: 'pair result',
    code: 'class Solution { public: pair<int, string> makePair() { return {7, "seven"}; } };',
    functionName: 'makePair',
    inputs: {},
    expected: [7, 'seven'],
  },
  {
    name: 'array algorithm functional result',
    code: 'class Solution { public: array<int, 3> order(array<int, 3> nums) { sort(nums.begin(), nums.end(), greater<int>()); return nums; } };',
    functionName: 'order',
    inputs: { nums: [1, 3, 2] },
    expected: [3, 2, 1],
  },
  {
    name: 'tuple result',
    code: 'class Solution { public: tuple<int, string, bool> stats() { return {4, "ok", true}; } };',
    functionName: 'stats',
    inputs: {},
    expected: [4, 'ok', true],
  },
  {
    name: 'bitset numeric limits helper',
    code: [
      'namespace detail { int clampScore(int value) { return min(value, numeric_limits<int>::max()); } }',
      'class Solution {',
      'public:',
      '  int score(int n) {',
      '    bitset<16> bits(n);',
      '    vector<int> values = {1, 2, 3};',
      '    return detail::clampScore(accumulate(values.begin(), values.end(), 0) + (int)bits.count());',
      '  }',
      '};',
    ].join('\n'),
    functionName: 'score',
    inputs: { n: 7 },
    expected: 9,
  },
  {
    name: 'c++23 ranges span concepts',
    code: [
      'template <typename T>',
      'concept Addable = requires(T a, T b) { a + b; };',
      'class Solution {',
      'public:',
      '  int modern(vector<int>& nums) {',
      '    span<int> values(nums);',
      '    auto filtered = values | views::filter([](int value) { return value > 2; });',
      '    int total = 0;',
      '    for (int value : filtered) total += value;',
      '    if constexpr (Addable<int>) return total;',
      '    return -1;',
      '  }',
      '};',
    ].join('\n'),
    functionName: 'modern',
    inputs: { nums: [1, 2, 3, 4] },
    expected: 7,
  },
  {
    name: 'no-exception helper catch lowering',
    code: [
      '#include <stdexcept>',
      'class Solution {',
      '  int risky(int value) {',
      '    if (value < 0) throw std::runtime_error("negative");',
      '    return value + 1;',
      '  }',
      'public:',
      '  int recover(int value) {',
      '    try {',
      '      return risky(value);',
      '    } catch (const std::exception&) {',
      '      return 42;',
      '    }',
      '  }',
      '};',
    ].join('\n'),
    functionName: 'recover',
    inputs: { value: -1 },
    expected: 42,
  },
];

for (const testCase of cases) {
  const result = await sandbox.__tracecodeCppTest.handleCompileRun(testCase);
  if (!result.success) {
    throw new Error(testCase.name + ' failed: ' + result.error);
  }
  if (JSON.stringify(result.output) !== JSON.stringify(testCase.expected)) {
    throw new Error(
      testCase.name + ' output mismatch: expected ' + JSON.stringify(testCase.expected) +
        ', received ' + JSON.stringify(result.output)
      );
  }
  if (testCase.expectedConsoleOutput) {
    if (JSON.stringify(result.consoleOutput) !== JSON.stringify(testCase.expectedConsoleOutput)) {
      throw new Error(
        testCase.name + ' console output mismatch: expected ' + JSON.stringify(testCase.expectedConsoleOutput) +
          ', received ' + JSON.stringify(result.consoleOutput)
      );
    }
  }
}

const listArrayResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  int sumList(ListNode* head) {',
    '    int total = 0;',
    '    while (head) { total += head->val; head = head->next; }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'sumList',
  inputs: { head: [1, 2, 3] },
});
if (!listArrayResult.success || listArrayResult.output !== 6) {
  throw new Error('C++ ListNode array materialization failed: ' + JSON.stringify(listArrayResult));
}

const listCycleResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  bool hasCycle(ListNode* head) {',
    '    ListNode* slow = head;',
    '    ListNode* fast = head;',
    '    while (fast && fast->next) {',
    '      slow = slow->next;',
    '      fast = fast->next->next;',
    '      if (slow == fast) return true;',
    '    }',
    '    return false;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'hasCycle',
  inputs: {
    head: {
      __id__: 'n0',
      val: 1,
      next: {
        __id__: 'n1',
        val: 2,
        next: { __ref__: 'n0' },
      },
    },
  },
});
if (!listCycleResult.success || listCycleResult.output !== true) {
  throw new Error('C++ ListNode ref-cycle materialization failed: ' + JSON.stringify(listCycleResult));
}

const treeArrayResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  int sumTree(TreeNode* root) {',
    '    if (!root) return 0;',
    '    return root->val + sumTree(root->left) + sumTree(root->right);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'sumTree',
  inputs: { root: [1, 2, 3, null, 4] },
});
if (!treeArrayResult.success || treeArrayResult.output !== 10) {
  throw new Error('C++ TreeNode level-order materialization failed: ' + JSON.stringify(treeArrayResult));
}

const treeAliasResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  bool hasAliasedChildren(TreeNode* root) {',
    '    return root && root->left == root->right;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'hasAliasedChildren',
  inputs: {
    root: {
      __id__: 'root',
      val: 9,
      left: { __id__: 'child', val: 3, left: null, right: null },
      right: { __ref__: 'child' },
    },
  },
});
if (!treeAliasResult.success || treeAliasResult.output !== true) {
  throw new Error('C++ TreeNode alias materialization failed: ' + JSON.stringify(treeAliasResult));
}

const treeReturnResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  TreeNode* makeTree() {',
    '    TreeNode* root = new TreeNode(1);',
    '    root->left = new TreeNode(2);',
    '    root->right = root->left;',
    '    return root;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'makeTree',
  inputs: {},
});
if (!treeReturnResult.success) {
  throw new Error('C++ TreeNode return serialization failed: ' + JSON.stringify(treeReturnResult));
}
if (
  treeReturnResult.output?.__type__ !== 'TreeNode' ||
  treeReturnResult.output?.val !== 1 ||
  treeReturnResult.output?.left?.__type__ !== 'TreeNode' ||
  treeReturnResult.output?.right?.__ref__ !== treeReturnResult.output?.left?.__id__
) {
  throw new Error('C++ TreeNode return should serialize with TraceCode ids/refs, received ' + JSON.stringify(treeReturnResult.output));
}

const listReturnResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  ListNode* makeCycle() {',
    '    ListNode* head = new ListNode(1);',
    '    head->next = new ListNode(2);',
    '    head->next->next = head;',
    '    return head;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'makeCycle',
  inputs: {},
});
if (!listReturnResult.success) {
  throw new Error('C++ ListNode return serialization failed: ' + JSON.stringify(listReturnResult));
}
if (
  listReturnResult.output?.__type__ !== 'ListNode' ||
  listReturnResult.output?.val !== 1 ||
  listReturnResult.output?.next?.val !== 2 ||
  listReturnResult.output?.next?.next?.__ref__ !== listReturnResult.output?.__id__
) {
  throw new Error('C++ ListNode return should serialize cycles with TraceCode ids/refs, received ' + JSON.stringify(listReturnResult.output));
}

const nodeTracing = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  ListNode* echo(ListNode* head) {',
    '    return head;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'echo',
  inputs: {
    head: {
      __id__: 'n0',
      val: 1,
      next: {
        __id__: 'n1',
        val: 2,
        next: { __ref__: 'n0' },
      },
    },
  },
  options: {},
});
if (!nodeTracing.success) {
  throw new Error('C++ ListNode tracing failed: ' + JSON.stringify(nodeTracing));
}
const nodeTraceSerialized = JSON.stringify(nodeTracing.trace.events);
if (!nodeTraceSerialized.includes('__ref__')) {
  throw new Error('C++ ListNode tracing should preserve opaque refs, received ' + nodeTraceSerialized);
}
for (const forbidden of ['visualization', 'objectKinds', 'hashMaps', 'graph-adjacency', 'linked-list']) {
  if (nodeTraceSerialized.includes(forbidden)) {
    throw new Error('C++ ListNode tracing leaked visualization token ' + forbidden + ': ' + nodeTraceSerialized);
  }
}
if (!nodeTracing.trace.events.some((event) => event.kind === 'call' && event.args?.head?.__type__ === 'ListNode')) {
  throw new Error('C++ ListNode tracing should include serialized call args, received ' + JSON.stringify(nodeTracing.trace.events));
}
if (!nodeTracing.trace.events.some((event) => event.kind === 'return' && event.value?.__type__ === 'ListNode')) {
  throw new Error('C++ ListNode tracing should include serialized return value, received ' + JSON.stringify(nodeTracing.trace.events));
}

const treeTracing = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  TreeNode* echo(TreeNode* root) {',
    '    return root;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'echo',
  inputs: {
    root: {
      __id__: 'root',
      val: 9,
      left: { __id__: 'child', val: 3, left: null, right: null },
      right: { __ref__: 'child' },
    },
  },
  options: {},
});
if (!treeTracing.success) {
  throw new Error('C++ TreeNode tracing failed: ' + JSON.stringify(treeTracing));
}
if (!treeTracing.trace.events.some((event) => event.kind === 'call' && event.args?.root?.right?.__ref__ === event.args?.root?.left?.__id__)) {
  throw new Error('C++ TreeNode tracing should include aliased call args, received ' + JSON.stringify(treeTracing.trace.events));
}
if (!treeTracing.trace.events.some((event) => event.kind === 'return' && event.value?.right?.__ref__ === event.value?.left?.__id__)) {
  throw new Error('C++ TreeNode tracing should include aliased return value, received ' + JSON.stringify(treeTracing.trace.events));
}

const graphSerializationResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  map<int, vector<int>> graph() {',
    '    map<int, vector<int>> out;',
    '    out[0] = {1, 2};',
    '    out[1] = {2};',
    '    out[2] = {};',
    '    return out;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'graph',
  inputs: {},
});
if (!graphSerializationResult.success || JSON.stringify(graphSerializationResult.output) !== JSON.stringify({ 0: [1, 2], 1: [2], 2: [] })) {
  throw new Error('C++ neutral graph-like map serialization failed: ' + JSON.stringify(graphSerializationResult));
}

const graphTracing = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  vector<vector<int>> graph() {',
    '    vector<vector<int>> out(3);',
    '    out[0].push_back(1);',
    '    out[1].push_back(2);',
    '    return out;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'graph',
  inputs: {},
  options: {},
});
if (!graphTracing.success) {
  throw new Error('C++ neutral graph-like tracing failed: ' + JSON.stringify(graphTracing));
}
const graphTraceSerialized = JSON.stringify(graphTracing.trace.events);
for (const forbidden of ['visualization', 'objectKinds', 'hashMaps', 'graph-adjacency', 'linked-list']) {
  if (graphTraceSerialized.includes(forbidden)) {
    throw new Error('C++ graph-like tracing leaked visualization token ' + forbidden + ': ' + graphTraceSerialized);
  }
}
if (!graphTracing.trace.events.some((event) => event.kind === 'return' && JSON.stringify(event.value) === JSON.stringify([[1], [2], []]))) {
  throw new Error('C++ graph-like tracing should return neutral adjacency data, received ' + JSON.stringify(graphTracing.trace.events));
}

const syntaxError = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  int add(int a, int b) {',
    '    return a + ;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'add',
  inputs: { a: 2, b: 3 },
});
if (syntaxError.success) {
  throw new Error('C++ syntax error unexpectedly succeeded');
}
if (syntaxError.errorLine !== 4) {
  throw new Error('C++ syntax error should map to UserCode.cpp line 4, received ' + syntaxError.errorLine);
}
if (!String(syntaxError.error || '').includes('UserCode.cpp:4')) {
  throw new Error('C++ syntax error should include UserCode.cpp diagnostics, received ' + syntaxError.error);
}

const traced = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: 'class Solution { public: int add(int a, int b) { std::printf("sum %d\\n", a + b); return a + b; } };',
  functionName: 'add',
  inputs: { a: 2, b: 3 },
  options: {},
});
if (!traced.success) {
  throw new Error('C++ tracing failed: ' + traced.error);
}
if (traced.output !== 5) {
  throw new Error('C++ tracing output mismatch: ' + JSON.stringify(traced.output));
}
const eventKinds = traced.trace.events.map((event) => event.kind);
for (const kind of ['call', 'line', 'stdout', 'return']) {
  if (!eventKinds.includes(kind)) {
    throw new Error('C++ tracing should include ' + kind + ' event, received ' + JSON.stringify(traced.trace.events));
  }
}
if (traced.trace.events[0].runId !== 'cpp:run' || traced.trace.events[0].file !== 'UserCode.cpp') {
  throw new Error('C++ tracing should annotate events with runId and file');
}
if (!traced.trace.events.some((event) => event.kind === 'return' && event.value === 5)) {
  throw new Error('C++ tracing should include serialized return value');
}
if (!traced.trace.events.some((event) => event.kind === 'line' && event.callStack?.some((frame) => frame.function === 'add'))) {
  throw new Error('C++ tracing should attach callStack frames to runtime events, received ' + JSON.stringify(traced.trace.events));
}

const exceptionTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    '#include <stdexcept>',
    'class Solution {',
    '  int risky(int value) {',
    '    if (value < 0) throw std::runtime_error("negative");',
    '    return value + 1;',
    '  }',
    'public:',
    '  int recover(int value) {',
    '    try {',
    '      return risky(value);',
    '    } catch (const std::exception&) {',
    '      return 42;',
    '    }',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'recover',
  inputs: { value: -1 },
  options: {},
});
if (!exceptionTrace.success || exceptionTrace.output !== 42) {
  throw new Error('C++ lowered exception tracing should recover successfully, received ' + JSON.stringify(exceptionTrace));
}
const exceptionEvent = exceptionTrace.trace.events.find((event) => event.kind === 'exception');
if (!exceptionEvent || exceptionEvent.line !== 4 || exceptionEvent.message !== 'negative') {
  throw new Error('C++ lowered exception tracing should emit the throw line and message, received ' + JSON.stringify(exceptionTrace.trace.events));
}
if (!exceptionEvent.callStack?.some((frame) => frame.function === 'risky')) {
  throw new Error('C++ lowered exception tracing should attach the throwing frame, received ' + JSON.stringify(exceptionTrace.trace.events));
}

const scriptResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'vector<int> nums = {2, 7, 11, 15};',
    'int target = 9;',
    'vector<int> result;',
    'unordered_map<int, int> seen;',
    'for (int i = 0; i < nums.size(); ++i) {',
    '  int complement = target - nums[i];',
    '  if (seen.count(complement)) {',
    '    result = {seen[complement], i};',
    '    break;',
    '  }',
    '  seen[nums[i]] = i;',
    '}',
  ].join('\n'),
  functionName: '',
  inputs: {},
  executionStyle: 'function',
});
if (!scriptResult.success || JSON.stringify(scriptResult.output) !== JSON.stringify([0, 1])) {
  throw new Error('C++ script execution should return the top-level result variable, received ' + JSON.stringify(scriptResult));
}

const scriptTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'vector<int> nums = {2, 7, 11, 15};',
    'int target = 9;',
    'vector<int> result;',
    'unordered_map<int, int> seen;',
    'for (int i = 0; i < nums.size(); ++i) {',
    '  int complement = target - nums[i];',
    '  if (seen.count(complement)) {',
    '    result = {seen[complement], i};',
    '    break;',
    '  }',
    '  seen[nums[i]] = i;',
    '}',
  ].join('\n'),
  functionName: '',
  inputs: {},
  executionStyle: 'function',
  options: {},
});
if (!scriptTrace.success || JSON.stringify(scriptTrace.output) !== JSON.stringify([0, 1])) {
  throw new Error('C++ script tracing should execute successfully, received ' + JSON.stringify(scriptTrace));
}
if (!scriptTrace.trace.events.some((event) => event.kind === 'call' && event.function === '<script>')) {
  throw new Error('C++ script tracing should emit a script call event, received ' + JSON.stringify(scriptTrace.trace.events));
}
if (!scriptTrace.trace.events.some((event) => event.kind === 'snapshot' && event.target?.variable === 'result')) {
  throw new Error('C++ script tracing should snapshot top-level result, received ' + JSON.stringify(scriptTrace.trace.events));
}
if (scriptTrace.trace.events.some((event) => typeof event.line === 'number' && event.line > 12)) {
  throw new Error('C++ script tracing should map wrapper lines back to user code, received ' + JSON.stringify(scriptTrace.trace.events));
}

const interviewResult = await sandbox.__tracecodeCppTest.handleExecuteCodeInterview({
  code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
  functionName: 'add',
  inputs: { a: 2, b: 3 },
  executionStyle: 'solution-method',
});
if (!interviewResult.success || interviewResult.output !== 5 || 'trace' in interviewResult) {
  throw new Error('C++ interview execution should return a non-trace execution result, received ' + JSON.stringify(interviewResult));
}

const scriptInterviewResult = await sandbox.__tracecodeCppTest.handleExecuteCodeInterview({
  code: 'int result = 7;',
  functionName: '',
  inputs: {},
  executionStyle: 'function',
});
if (!scriptInterviewResult.success || scriptInterviewResult.output !== 7) {
  throw new Error('C++ script interview execution should return result, received ' + JSON.stringify(scriptInterviewResult));
}

const interviewSyntaxError = await sandbox.__tracecodeCppTest.handleExecuteCodeInterview({
  code: [
    'class Solution {',
    'public:',
    '  int add(int a, int b) {',
    '    return a + ;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'add',
  inputs: { a: 2, b: 3 },
  executionStyle: 'solution-method',
});
if (interviewSyntaxError.success || interviewSyntaxError.errorLine !== 4) {
  throw new Error('C++ interview compile errors should map to user lines, received ' + JSON.stringify(interviewSyntaxError));
}

const interviewTimeout = await sandbox.__tracecodeCppTest.handleExecuteCodeInterview({
  code: [
    'class Solution {',
    'public:',
    '  int spin() {',
    '    int total = 0;',
    '    for (int i = 0; i < 100; ++i) {',
    '      total++;',
    '    }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'spin',
  inputs: {},
  executionStyle: 'solution-method',
  options: { maxTraceSteps: 8 },
});
if (interviewTimeout.success || interviewTimeout.error !== 'Time Limit Exceeded') {
  throw new Error('C++ interview trace-budget timeout should normalize to Time Limit Exceeded, received ' + JSON.stringify(interviewTimeout));
}
if (interviewTimeout.timeoutReason !== 'trace-limit' || interviewTimeout.diagnosticStage !== 'interview') {
  throw new Error('C++ interview trace-budget timeout should preserve timeout metadata, received ' + JSON.stringify(interviewTimeout));
}

const interviewLineTimeout = await sandbox.__tracecodeCppTest.handleExecuteCodeInterview({
  code: [
    'class Solution {',
    'public:',
    '  int spin() {',
    '    int total = 0;',
    '    for (int i = 0; i < 100; ++i) {',
    '      total += i;',
    '    }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'spin',
  inputs: {},
  executionStyle: 'solution-method',
  options: { maxLineEvents: 4, maxTraceSteps: 1000, maxStoredEvents: 1000 },
});
if (
  interviewLineTimeout.success ||
  interviewLineTimeout.error !== 'Time Limit Exceeded' ||
  interviewLineTimeout.timeoutReason !== 'line-limit'
) {
  throw new Error('C++ interview maxLineEvents should normalize with line-limit metadata, received ' + JSON.stringify(interviewLineTimeout));
}

const cappedTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
  functionName: 'add',
  inputs: { a: 2, b: 3 },
  options: { maxStoredEvents: 2 },
});
if (!cappedTrace.traceLimitExceeded || cappedTrace.timeoutReason !== 'trace-limit') {
  throw new Error('C++ tracing should report trace-limit when maxStoredEvents truncates events');
}
if (!cappedTrace.success || cappedTrace.output !== 5) {
  throw new Error('C++ maxStoredEvents should cap trace storage without failing execution, received ' + JSON.stringify(cappedTrace));
}
if (cappedTrace.trace.events.length !== 2) {
  throw new Error('C++ tracing should cap stored events to maxStoredEvents');
}
if (!Number.isFinite(cappedTrace.droppedEventCount) || cappedTrace.droppedEventCount <= 0) {
  throw new Error('C++ tracing should report dropped events when maxStoredEvents is exceeded');
}

const hugeStdoutResult = await sandbox.__tracecodeCppTest.handleCompileRun({
  code: [
    'class Solution {',
    'public:',
    '  int spam() {',
    '    for (int i = 0; i < 200; ++i) {',
    '      std::printf("line %d\\n", i);',
    '    }',
    '    return 200;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'spam',
  inputs: {},
});
if (!hugeStdoutResult.success || hugeStdoutResult.output !== 200 || hugeStdoutResult.consoleOutput?.length !== 200) {
  throw new Error('C++ execution should capture large stdout separately from result, received ' + JSON.stringify(hugeStdoutResult));
}

const compileDiagnosticStage = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int broken() {',
    '    return missingSymbol;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'broken',
  inputs: {},
  options: {},
});
if (compileDiagnosticStage.success || compileDiagnosticStage.diagnosticStage !== 'trace-driver-compile') {
  throw new Error('C++ trace compile failures should be labeled separately from runtime failures, received ' + JSON.stringify(compileDiagnosticStage));
}

const lineLimitedTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int spin() {',
    '    int total = 0;',
    '    for (int i = 0; i < 20; ++i) {',
    '      total += i;',
    '    }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'spin',
  inputs: {},
  options: { maxLineEvents: 4, maxTraceSteps: 1000, maxStoredEvents: 1000 },
});
if (lineLimitedTrace.success || !lineLimitedTrace.traceLimitExceeded || lineLimitedTrace.timeoutReason !== 'line-limit') {
  throw new Error('C++ maxLineEvents should hard-stop tracing with line-limit, received ' + JSON.stringify(lineLimitedTrace));
}
if (!lineLimitedTrace.trace.events.some((event) => event.kind === 'timeout' && event.reason === 'line-limit')) {
  throw new Error('C++ maxLineEvents should emit a line-limit timeout event, received ' + JSON.stringify(lineLimitedTrace.trace.events));
}

const singleLineLimitedTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int spin() {',
    '    int total = 0;',
    '    for (int i = 0; i < 20; ++i) {',
    '      total += i;',
    '    }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'spin',
  inputs: {},
  options: { maxSingleLineHits: 2, maxTraceSteps: 1000, maxStoredEvents: 1000 },
});
if (singleLineLimitedTrace.success || !singleLineLimitedTrace.traceLimitExceeded || singleLineLimitedTrace.timeoutReason !== 'single-line-limit') {
  throw new Error('C++ maxSingleLineHits should hard-stop tracing with single-line-limit, received ' + JSON.stringify(singleLineLimitedTrace));
}
if (!singleLineLimitedTrace.trace.events.some((event) => event.kind === 'timeout' && event.reason === 'single-line-limit')) {
  throw new Error('C++ maxSingleLineHits should emit a single-line-limit timeout event, received ' + JSON.stringify(singleLineLimitedTrace.trace.events));
}

const minimalTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int search(vector<int>& nums, int target) {',
    '    for (int i = 0; i < nums.size(); ++i) {',
    '      if (nums[i] == target) return i;',
    '    }',
    '    return -1;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'search',
  inputs: { nums: [1, 2, 3], target: 2 },
  options: { minimalTrace: true },
});
if (!minimalTrace.success || minimalTrace.output !== 1) {
  throw new Error('C++ minimalTrace should preserve execution, received ' + JSON.stringify(minimalTrace));
}
if (!minimalTrace.trace.events.some((event) => event.kind === 'line') || !minimalTrace.trace.events.some((event) => event.kind === 'return')) {
  throw new Error('C++ minimalTrace should keep control-flow events, received ' + JSON.stringify(minimalTrace.trace.events));
}
if (minimalTrace.trace.events.some((event) => ['snapshot', 'read', 'write', 'mutate', 'control'].includes(event.kind))) {
  throw new Error('C++ minimalTrace should suppress detail events, received ' + JSON.stringify(minimalTrace.trace.events));
}

const userLineTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int sumTo(int n) {',
    '    int total = 0;',
    '    for (int i = 0; i <= n; ++i) {',
    '      total += i;',
    '    }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'sumTo',
  inputs: { n: 3 },
  options: {},
});
if (!userLineTrace.success || userLineTrace.output !== 6) {
  throw new Error('C++ user-line tracing failed: ' + JSON.stringify(userLineTrace));
}
const tracedLines = userLineTrace.trace.events
  .filter((event) => event.kind === 'line')
  .map((event) => event.line);
for (const line of [3, 4, 5, 6, 8]) {
  if (!tracedLines.includes(line)) {
    throw new Error('C++ tracing should include user line ' + line + ', received ' + JSON.stringify(tracedLines));
  }
}
if (tracedLines.filter((line) => line === 6).length < 4) {
  throw new Error('C++ loop body line should emit once per iteration, received ' + JSON.stringify(tracedLines));
}
const totalSnapshots = userLineTrace.trace.events.filter(
  (event) => event.kind === 'snapshot' && event.target?.variable === 'total'
);
if (!totalSnapshots.some((event) => event.line === 4 && event.value === 0)) {
  throw new Error('C++ declaration line should expose post-line initialized state, received ' + JSON.stringify(totalSnapshots));
}
if (!totalSnapshots.some((event) => event.line === 6 && event.value === 6)) {
  throw new Error('C++ assignment line should expose post-line updated state, received ' + JSON.stringify(totalSnapshots));
}

const vectorTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int search(vector<int>& nums, int target) {',
    '    int left = 0;',
    '    int right = nums.size() - 1;',
    '    while (left <= right) {',
    '      int mid = left + (right - left) / 2;',
    '      if (nums[mid] == target) return mid;',
    '      if (nums[mid] < target) left = mid + 1;',
    '      else right = mid - 1;',
    '    }',
    '    return -1;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'search',
  inputs: { nums: [1, 3, 5, 7, 9], target: 7 },
  options: {},
});
if (!vectorTrace.success || vectorTrace.output !== 3) {
  throw new Error('C++ vector read tracing failed: ' + JSON.stringify(vectorTrace));
}
const vectorEvents = vectorTrace.trace.events;
if (!vectorEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'nums')) {
  throw new Error('C++ vector tracing should emit parameter snapshot, received ' + JSON.stringify(vectorEvents));
}
if (!vectorEvents.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && event.target.path?.length === 1)) {
  throw new Error('C++ vector tracing should emit indexed reads, received ' + JSON.stringify(vectorEvents));
}

const multilineSignatureTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int robust(',
    '    std::vector<int>& nums,',
    '    std::unordered_map<int, int>& seen',
    '  ) {',
    '    std::vector<int> out = {',
    '      nums[0],',
    '      nums[1]',
    '    };',
    '    std::map<int, int> counts = {',
    '      {1, 2},',
    '      {2, 3}',
    '    };',
    '    out.push_back(seen[7]);',
    '    counts[3] = out[2];',
    '    return out[0] + counts[3];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'robust',
  inputs: { nums: [4, 5], seen: { 7: 6 } },
  options: {},
});
if (!multilineSignatureTrace.success || multilineSignatureTrace.output !== 10) {
  throw new Error('C++ robust rewriter tracing failed: ' + JSON.stringify(multilineSignatureTrace));
}
const robustEvents = multilineSignatureTrace.trace.events;
if (!robustEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'nums')) {
  throw new Error('C++ robust rewriter should trace std::vector parameter, received ' + JSON.stringify(robustEvents));
}
if (!robustEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen')) {
  throw new Error('C++ robust rewriter should trace std::unordered_map parameter, received ' + JSON.stringify(robustEvents));
}
if (!robustEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'out' && event.method === 'push_back')) {
  throw new Error('C++ robust rewriter should trace multiline local vector mutation, received ' + JSON.stringify(robustEvents));
}
if (!robustEvents.some((event) => event.kind === 'write' && event.target?.variable === 'counts' && event.target.path?.[0] === 3 && event.value === 6)) {
  throw new Error('C++ robust rewriter should trace multiline local map write, received ' + JSON.stringify(robustEvents));
}

const aliasTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'using VI = std::vector<int>;',
    'typedef std::unordered_map<int, int> Seen;',
    'using Grid = std::vector<std::vector<int>>;',
    'class Solution {',
    'public:',
    '  int aliasOps(VI& nums, Seen& seen) {',
    '    VI out;',
    '    out.push_back(nums[0]);',
    '    Grid grid(2, std::vector<int>(2, 0));',
    '    grid[1][1] = seen[7];',
    '    return out[0] + grid[1][1];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'aliasOps',
  inputs: { nums: [4], seen: { 7: 6 } },
  options: {},
});
if (!aliasTrace.success || aliasTrace.output !== 10) {
  throw new Error('C++ alias rewriter tracing failed: ' + JSON.stringify(aliasTrace));
}
const aliasEvents = aliasTrace.trace.events;
if (!aliasEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'nums')) {
  throw new Error('C++ alias rewriter should trace aliased vector parameter, received ' + JSON.stringify(aliasEvents));
}
if (!aliasEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen')) {
  throw new Error('C++ alias rewriter should trace typedef unordered_map parameter, received ' + JSON.stringify(aliasEvents));
}
if (!aliasEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'out' && event.method === 'push_back')) {
  throw new Error('C++ alias rewriter should trace aliased local vector mutation, received ' + JSON.stringify(aliasEvents));
}
if (!aliasEvents.some((event) => event.kind === 'write' && event.target?.variable === 'grid' && event.target.path?.[0] === 1 && event.target.path?.[1] === 1 && event.value === 6)) {
  throw new Error('C++ alias rewriter should trace aliased nested vector write, received ' + JSON.stringify(aliasEvents));
}

const classScopedAliasTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    '  using VI = vector < int >;',
    '  typedef std::map<int, int> Counts;',
    'public:',
    '  int scoped(',
    '    const VI& nums,',
    '    std::vector < std::vector < int > >& grid',
    '  ) {',
    '    VI left, right;',
    '    Counts counts;',
    '    for (int value : nums) left.push_back(value);',
    '    if (!left.empty()) right.push_back(left[0]);',
    '    grid[0][1] = right[0];',
    '    counts[1] = grid[0][1];',
    '    return counts[1];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'scoped',
  inputs: { nums: [7], grid: [[0, 0]] },
  options: {},
});
if (!classScopedAliasTrace.success || classScopedAliasTrace.output !== 7) {
  throw new Error('C++ class-scoped alias robustness tracing failed: ' + JSON.stringify(classScopedAliasTrace));
}
const scopedEvents = classScopedAliasTrace.trace.events;
if (!scopedEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'nums')) {
  throw new Error('C++ scoped alias rewriter should trace const aliased vector parameter, received ' + JSON.stringify(scopedEvents));
}
if (!scopedEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'grid')) {
  throw new Error('C++ scoped alias rewriter should trace spaced nested vector parameter, received ' + JSON.stringify(scopedEvents));
}
if (!scopedEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'left')) {
  throw new Error('C++ scoped alias rewriter should trace first multiple-declared vector, received ' + JSON.stringify(scopedEvents));
}
if (!scopedEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'right')) {
  throw new Error('C++ scoped alias rewriter should trace second multiple-declared vector, received ' + JSON.stringify(scopedEvents));
}
if (!scopedEvents.some((event) => event.kind === 'write' && event.target?.variable === 'grid' && event.target.path?.[0] === 0 && event.target.path?.[1] === 1 && event.value === 7)) {
  throw new Error('C++ scoped alias rewriter should trace spaced nested vector write, received ' + JSON.stringify(scopedEvents));
}
if (!scopedEvents.some((event) => event.kind === 'write' && event.target?.variable === 'counts' && event.target.path?.[0] === 1 && event.value === 7)) {
  throw new Error('C++ scoped alias rewriter should trace typedef map write, received ' + JSON.stringify(scopedEvents));
}
if (scopedEvents.filter((event) => event.kind === 'line' && event.line === 11).length < 2) {
  throw new Error('C++ single-line for body should emit body line events per iteration, received ' + JSON.stringify(scopedEvents));
}

const vectorMutationTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  vector<int> make() {',
    '    vector<int> out;',
    '    out.push_back(1);',
    '    out[0] = 2;',
    '    return out;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'make',
  inputs: {},
  options: {},
});
if (!vectorMutationTrace.success || JSON.stringify(vectorMutationTrace.output) !== JSON.stringify([2])) {
  throw new Error('C++ vector mutation tracing failed: ' + JSON.stringify(vectorMutationTrace));
}
const mutationEvents = vectorMutationTrace.trace.events;
if (!mutationEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'out' && event.method === 'push_back')) {
  throw new Error('C++ vector tracing should emit push_back mutation, received ' + JSON.stringify(mutationEvents));
}
if (!mutationEvents.some((event) => event.kind === 'write' && event.target?.variable === 'out' && event.target.path?.[0] === 0 && event.value === 2)) {
  throw new Error('C++ vector tracing should emit indexed write, received ' + JSON.stringify(mutationEvents));
}

const vectorApiTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  vector<int> reshape() {',
    '    vector<int> out = {1, 2, 3};',
    '    int first = out.front();',
    '    int last = out.back();',
    '    out.resize(5, first + last);',
    '    out.clear();',
    '    out.assign(2, 7);',
    '    return out;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'reshape',
  inputs: {},
  options: {},
});
if (!vectorApiTrace.success || JSON.stringify(vectorApiTrace.output) !== JSON.stringify([7, 7])) {
  throw new Error('C++ vector API tracing failed: ' + JSON.stringify(vectorApiTrace));
}
const vectorApiEvents = vectorApiTrace.trace.events;
if (!vectorApiEvents.some((event) => event.kind === 'read' && event.target?.variable === 'out' && event.target.path?.[0] === 0)) {
  throw new Error('C++ vector front should emit indexed read, received ' + JSON.stringify(vectorApiEvents));
}
if (!vectorApiEvents.some((event) => event.kind === 'read' && event.target?.variable === 'out' && event.target.path?.[0] === 2)) {
  throw new Error('C++ vector back should emit indexed read, received ' + JSON.stringify(vectorApiEvents));
}
for (const method of ['resize', 'clear', 'assign']) {
  if (!vectorApiEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'out' && event.method === method)) {
    throw new Error('C++ vector tracing should emit ' + method + ' mutation, received ' + JSON.stringify(vectorApiEvents));
  }
}

const vectorSwapTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  vector<int> reorder(vector<int>& nums) {',
    '    swap(nums[0], nums[2]);',
    '    nums.insert(nums.begin() + 1, 9);',
    '    nums.erase(nums.begin() + 3);',
    '    return nums;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'reorder',
  inputs: { nums: [1, 2, 3] },
  options: {},
});
if (!vectorSwapTrace.success || JSON.stringify(vectorSwapTrace.output) !== JSON.stringify([3, 9, 2])) {
  throw new Error('C++ vector swap/insert/erase tracing failed: ' + JSON.stringify(vectorSwapTrace));
}
const vectorSwapEvents = vectorSwapTrace.trace.events;
if (!vectorSwapEvents.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 0 && event.value === 3)) {
  throw new Error('C++ vector swap should emit left indexed write, received ' + JSON.stringify(vectorSwapEvents));
}
if (!vectorSwapEvents.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 2 && event.value === 1)) {
  throw new Error('C++ vector swap should emit right indexed write, received ' + JSON.stringify(vectorSwapEvents));
}
for (const method of ['insert', 'erase']) {
  if (!vectorSwapEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'nums' && event.method === method)) {
    throw new Error('C++ vector tracing should emit ' + method + ' mutation, received ' + JSON.stringify(vectorSwapEvents));
  }
}

const unorderedMapTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  vector<int> twoSum(vector<int>& nums, int target) {',
    '    unordered_map<int, int> seen;',
    '    for (int i = 0; i < nums.size(); ++i) {',
    '      int complement = target - nums[i];',
    '      if (seen.count(complement)) return {seen[complement], i};',
    '      seen[nums[i]] = i;',
    '    }',
    '    return {};',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'twoSum',
  inputs: { nums: [2, 7, 11, 15], target: 9 },
  options: {},
});
if (!unorderedMapTrace.success || JSON.stringify(unorderedMapTrace.output) !== JSON.stringify([0, 1])) {
  throw new Error('C++ unordered_map tracing failed: ' + JSON.stringify(unorderedMapTrace));
}
const mapEvents = unorderedMapTrace.trace.events;
if (!mapEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen')) {
  throw new Error('C++ unordered_map tracing should emit map snapshot, received ' + JSON.stringify(mapEvents));
}
if (!mapEvents.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 2 && event.value === 0)) {
  throw new Error('C++ unordered_map tracing should emit keyed writes, received ' + JSON.stringify(mapEvents));
}
if (!mapEvents.some((event) => event.kind === 'read' && event.target?.variable === 'seen' && event.target.path?.[0] === 2 && event.value === 0)) {
  throw new Error('C++ unordered_map tracing should emit keyed reads, received ' + JSON.stringify(mapEvents));
}

const unorderedMapApiTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int mapOps() {',
    '    unordered_map<int, int> seen;',
    '    seen.insert({1, 2});',
    '    seen.emplace(3, 4);',
    '    seen.erase(1);',
    '    int value = seen[3];',
    '    seen.clear();',
    '    return value + seen.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'mapOps',
  inputs: {},
  options: {},
});
if (!unorderedMapApiTrace.success || unorderedMapApiTrace.output !== 4) {
  throw new Error('C++ unordered_map API tracing failed: ' + JSON.stringify(unorderedMapApiTrace));
}
const unorderedMapApiEvents = unorderedMapApiTrace.trace.events;
if (!unorderedMapApiEvents.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 1 && event.value === 2)) {
  throw new Error('C++ unordered_map insert should emit keyed write, received ' + JSON.stringify(unorderedMapApiEvents));
}
if (!unorderedMapApiEvents.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 3 && event.value === 4)) {
  throw new Error('C++ unordered_map emplace should emit keyed write, received ' + JSON.stringify(unorderedMapApiEvents));
}
for (const method of ['erase', 'clear']) {
  if (!unorderedMapApiEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'seen' && event.method === method)) {
    throw new Error('C++ unordered_map tracing should emit ' + method + ' mutation, received ' + JSON.stringify(unorderedMapApiEvents));
  }
}

const orderedMapTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int ordered(vector<int>& nums) {',
    '    map<int, int> counts;',
    '    for (int value : nums) counts[value]++;',
    '    counts.insert({4, 10});',
    '    counts.erase(1);',
    '    return counts[2] + counts.at(4);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'ordered',
  inputs: { nums: [1, 2, 2, 3] },
  options: {},
});
if (!orderedMapTrace.success || orderedMapTrace.output !== 12) {
  throw new Error('C++ map tracing failed: ' + JSON.stringify(orderedMapTrace));
}
const orderedMapEvents = orderedMapTrace.trace.events;
if (!orderedMapEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'counts')) {
  throw new Error('C++ map tracing should emit snapshot, received ' + JSON.stringify(orderedMapEvents));
}
if (!orderedMapEvents.some((event) => event.kind === 'write' && event.target?.variable === 'counts' && event.target.path?.[0] === 2 && event.value === 2)) {
  throw new Error('C++ map operator++ should emit keyed write, received ' + JSON.stringify(orderedMapEvents));
}
if (!orderedMapEvents.some((event) => event.kind === 'read' && event.target?.variable === 'counts' && event.target.path?.[0] === 4 && event.value === 10)) {
  throw new Error('C++ map at should emit keyed read, received ' + JSON.stringify(orderedMapEvents));
}
if (!orderedMapEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'counts' && event.method === 'erase')) {
  throw new Error('C++ map erase should emit mutation, received ' + JSON.stringify(orderedMapEvents));
}

const setTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  bool setOps(unordered_set<int>& banned) {',
    '    set<int> seen;',
    '    seen.insert(2);',
    '    seen.emplace(4);',
    '    bool hadTwo = seen.count(2);',
    '    bool hasBanned = banned.contains(3);',
    '    seen.erase(2);',
    '    banned.insert(5);',
    '    banned.clear();',
    '    return hadTwo && hasBanned && seen.count(4) && banned.empty();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'setOps',
  inputs: { banned: [1, 3] },
  options: {},
});
if (!setTrace.success || setTrace.output !== true) {
  throw new Error('C++ set/unordered_set tracing failed: ' + JSON.stringify(setTrace));
}
const setEvents = setTrace.trace.events;
if (!setEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen')) {
  throw new Error('C++ set tracing should emit local snapshot, received ' + JSON.stringify(setEvents));
}
if (!setEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'banned')) {
  throw new Error('C++ unordered_set parameter tracing should emit snapshot, received ' + JSON.stringify(setEvents));
}
if (!setEvents.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 2 && event.value === true)) {
  throw new Error('C++ set insert should emit membership write, received ' + JSON.stringify(setEvents));
}
if (!setEvents.some((event) => event.kind === 'read' && event.target?.variable === 'banned' && event.target.path?.[0] === 3 && event.value === true)) {
  throw new Error('C++ unordered_set contains should emit membership read, received ' + JSON.stringify(setEvents));
}
if (!setEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'banned' && event.method === 'clear')) {
  throw new Error('C++ unordered_set clear should emit mutation, received ' + JSON.stringify(setEvents));
}

const dequeQueueStackTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int containers() {',
    '    deque<int> window;',
    '    window.push_back(2);',
    '    window.push_front(1);',
    '    int left = window.front();',
    '    int right = window.back();',
    '    window[1] = 5;',
    '    queue<int> q;',
    '    q.push(left);',
    '    q.push(right);',
    '    int queued = q.front();',
    '    q.pop();',
    '    stack<int> st;',
    '    st.push(queued);',
    '    st.push(window[1]);',
    '    int top = st.top();',
    '    st.pop();',
    '    return top + q.front();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'containers',
  inputs: {},
  options: {},
});
if (!dequeQueueStackTrace.success || dequeQueueStackTrace.output !== 7) {
  throw new Error('C++ deque/queue/stack tracing failed: ' + JSON.stringify(dequeQueueStackTrace));
}
const adapterEvents = dequeQueueStackTrace.trace.events;
if (!adapterEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'window')) {
  throw new Error('C++ deque tracing should emit snapshot, received ' + JSON.stringify(adapterEvents));
}
if (!adapterEvents.some((event) => event.kind === 'write' && event.target?.variable === 'window' && event.target.path?.[0] === 1 && event.value === 5)) {
  throw new Error('C++ deque indexed write should emit write event, received ' + JSON.stringify(adapterEvents));
}
if (!adapterEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'q' && event.method === 'push')) {
  throw new Error('C++ queue push should emit mutation, received ' + JSON.stringify(adapterEvents));
}
if (!adapterEvents.some((event) => event.kind === 'read' && event.target?.variable === 'q' && event.target.path?.[0] === 'front')) {
  throw new Error('C++ queue front should emit read event, received ' + JSON.stringify(adapterEvents));
}
if (!adapterEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'st' && event.method === 'pop')) {
  throw new Error('C++ stack pop should emit mutation, received ' + JSON.stringify(adapterEvents));
}
if (!adapterEvents.some((event) => event.kind === 'read' && event.target?.variable === 'st' && event.target.path?.[0] === 'top' && event.value === 5)) {
  throw new Error('C++ stack top should emit read event, received ' + JSON.stringify(adapterEvents));
}

const priorityQueueTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int heapOps() {',
    '    priority_queue<int> heap;',
    '    heap.push(3);',
    '    heap.push(8);',
    '    heap.emplace(5);',
    '    int first = heap.top();',
    '    heap.pop();',
    '    return first + heap.top();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'heapOps',
  inputs: {},
  options: {},
});
if (!priorityQueueTrace.success || priorityQueueTrace.output !== 13) {
  throw new Error('C++ priority_queue tracing failed: ' + JSON.stringify(priorityQueueTrace));
}
const priorityQueueEvents = priorityQueueTrace.trace.events;
if (!priorityQueueEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'heap' && JSON.stringify(event.value) === JSON.stringify([8, 5, 3]))) {
  throw new Error('C++ priority_queue should emit ordered heap snapshot, received ' + JSON.stringify(priorityQueueEvents));
}
if (!priorityQueueEvents.some((event) => event.kind === 'read' && event.target?.variable === 'heap' && event.target.path?.[0] === 'top' && event.value === 8)) {
  throw new Error('C++ priority_queue top should emit read event, received ' + JSON.stringify(priorityQueueEvents));
}
for (const method of ['push', 'emplace', 'pop']) {
  if (!priorityQueueEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'heap' && event.method === method)) {
    throw new Error('C++ priority_queue tracing should emit ' + method + ' mutation, received ' + JSON.stringify(priorityQueueEvents));
  }
}

const nestedVectorTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int uniquePaths(int m, int n) {',
    '    vector<vector<int>> dp(m, vector<int>(n, 1));',
    '    for (int row = 1; row < m; ++row) {',
    '      for (int col = 1; col < n; ++col) {',
    '        dp[row][col] = dp[row - 1][col] + dp[row][col - 1];',
    '      }',
    '    }',
    '    return dp[m - 1][n - 1];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'uniquePaths',
  inputs: { m: 3, n: 4 },
  options: {},
});
if (!nestedVectorTrace.success || nestedVectorTrace.output !== 10) {
  throw new Error('C++ nested vector tracing failed: ' + JSON.stringify(nestedVectorTrace));
}
const nestedEvents = nestedVectorTrace.trace.events;
if (!nestedEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'dp')) {
  throw new Error('C++ nested vector tracing should emit dp snapshot, received ' + JSON.stringify(nestedEvents));
}
if (!nestedEvents.some((event) => event.kind === 'read' && event.target?.variable === 'dp' && event.target.path?.length === 2)) {
  throw new Error('C++ nested vector tracing should emit grid reads, received ' + JSON.stringify(nestedEvents));
}
if (!nestedEvents.some((event) => event.kind === 'write' && event.target?.variable === 'dp' && event.target.path?.[0] === 2 && event.target.path?.[1] === 3 && event.value === 10)) {
  throw new Error('C++ nested vector tracing should emit grid writes, received ' + JSON.stringify(nestedEvents));
}

const helperTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
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
  ].join('\n'),
  functionName: 'reachable',
  inputs: { graph: [[1, 2], [3], [1], []] },
  options: {},
});
if (!helperTrace.success || helperTrace.output !== 4) {
  throw new Error('C++ helper method tracing failed: ' + JSON.stringify(helperTrace));
}
const helperEvents = helperTrace.trace.events;
if (!helperEvents.some((event) => event.kind === 'line' && event.function === 'dfs')) {
  throw new Error('C++ helper method tracing should emit helper line events, received ' + JSON.stringify(helperEvents));
}
if (!helperEvents.some((event) => event.kind === 'call' && event.function === 'dfs' && event.args?.node === 0)) {
  throw new Error('C++ helper method tracing should emit helper call events, received ' + JSON.stringify(helperEvents));
}
if (!helperEvents.some((event) => event.kind === 'return' && event.function === 'dfs' && event.value === 4)) {
  throw new Error('C++ helper method tracing should emit helper return values, received ' + JSON.stringify(helperEvents));
}
if (!helperEvents.some((event) => event.kind === 'return' && event.function === 'dfs' && event.value === 0)) {
  throw new Error('C++ helper method tracing should emit one-line conditional return values, received ' + JSON.stringify(helperEvents));
}
if (!helperEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen')) {
  throw new Error('C++ helper method tracing should trace local vector passed into helper, received ' + JSON.stringify(helperEvents));
}
if (!helperEvents.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 3 && event.value === 1)) {
  throw new Error('C++ helper method tracing should emit vector writes inside helper, received ' + JSON.stringify(helperEvents));
}
if (!helperEvents.some((event) => event.kind === 'read' && event.target?.variable === 'graph' && event.target.path?.[0] === 1)) {
  throw new Error('C++ helper method tracing should emit parameter reads inside helper, received ' + JSON.stringify(helperEvents));
}

const backtrackingHelperTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    '  void backtrack(int start, vector<int>& path, vector<vector<int>>& out) {',
    '    out.push_back(path);',
    '    for (int value = start; value <= 3; ++value) {',
    '      path.push_back(value);',
    '      backtrack(value + 1, path, out);',
    '      path.pop_back();',
    '    }',
    '  }',
    'public:',
    '  vector<vector<int>> subsets() {',
    '    vector<int> path;',
    '    vector<vector<int>> out;',
    '    backtrack(1, path, out);',
    '    return out;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'subsets',
  inputs: {},
  options: {},
});
if (!backtrackingHelperTrace.success || JSON.stringify(backtrackingHelperTrace.output) !== JSON.stringify([[], [1], [1, 2], [1, 2, 3], [1, 3], [2], [2, 3], [3]])) {
  throw new Error('C++ backtracking helper tracing failed: ' + JSON.stringify(backtrackingHelperTrace));
}
const backtrackingEvents = backtrackingHelperTrace.trace.events;
if (!backtrackingEvents.some((event) => event.kind === 'line' && event.function === 'backtrack')) {
  throw new Error('C++ backtracking helper should emit helper line events, received ' + JSON.stringify(backtrackingEvents));
}
if (!backtrackingEvents.some((event) => event.kind === 'call' && event.function === 'backtrack' && event.args?.start === 1)) {
  throw new Error('C++ backtracking helper should emit helper call events, received ' + JSON.stringify(backtrackingEvents));
}
if (!backtrackingEvents.some((event) => event.kind === 'return' && event.function === 'backtrack')) {
  throw new Error('C++ backtracking helper should emit void helper return events, received ' + JSON.stringify(backtrackingEvents));
}
if (!backtrackingEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'path' && event.method === 'push_back')) {
  throw new Error('C++ backtracking helper should trace path push_back, received ' + JSON.stringify(backtrackingEvents));
}
if (!backtrackingEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'path' && event.method === 'pop_back')) {
  throw new Error('C++ backtracking helper should trace path pop_back, received ' + JSON.stringify(backtrackingEvents));
}
if (!backtrackingEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'out' && event.method === 'push_back')) {
  throw new Error('C++ backtracking helper should trace nested output push_back, received ' + JSON.stringify(backtrackingEvents));
}

const controlFormTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    '  int classify(int value) {',
    '    if (value < 0) { return -1; }',
    '    else if (value == 0) return 0;',
    '    else return 1;',
    '  }',
    'public:',
    '  int score(vector<int>& nums) {',
    '    vector<int> kept;',
    '    int total = 0;',
    '    for (int value : nums) {',
    '      if (value < 0) continue;',
    '      if (value > 5) break;',
    '      else kept.push_back(value);',
    '      total += classify(value - 2);',
    '    }',
    '    return total + kept.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'score',
  inputs: { nums: [-1, 0, 2, 7, 4] },
  options: {},
});
if (!controlFormTrace.success || controlFormTrace.output !== 1) {
  throw new Error('C++ control-form tracing failed: ' + JSON.stringify(controlFormTrace));
}
const controlFormEvents = controlFormTrace.trace.events;
if (!controlFormEvents.some((event) => event.kind === 'return' && event.function === 'classify' && event.value === -1)) {
  throw new Error('C++ braced helper return should emit return value, received ' + JSON.stringify(controlFormEvents));
}
if (!controlFormEvents.some((event) => event.kind === 'return' && event.function === 'classify' && event.value === 0)) {
  throw new Error('C++ else-if helper return should emit return value, received ' + JSON.stringify(controlFormEvents));
}
if (!controlFormEvents.some((event) => event.kind === 'control' && event.control === 'continue')) {
  throw new Error('C++ continue should emit control event, received ' + JSON.stringify(controlFormEvents));
}
if (!controlFormEvents.some((event) => event.kind === 'control' && event.control === 'break')) {
  throw new Error('C++ break should emit control event, received ' + JSON.stringify(controlFormEvents));
}
if (!controlFormEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'kept' && event.method === 'push_back')) {
  throw new Error('C++ else single-line mutation should still trace container mutation, received ' + JSON.stringify(controlFormEvents));
}

const lambdaHelperTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int lambdaReachable(vector<vector<int>>& graph) {',
    '    vector<int> seen(graph.size());',
    '    function<int(int)> dfs = [&](int node) {',
    '      if (seen[node]) return 0;',
    '      seen[node] = 1;',
    '      int total = 1;',
    '      for (int next : graph[node]) total += dfs(next);',
    '      return total;',
    '    };',
    '    return dfs(0);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'lambdaReachable',
  inputs: { graph: [[1], [2], [1]] },
  options: {},
});
if (!lambdaHelperTrace.success || lambdaHelperTrace.output !== 3) {
  throw new Error('C++ lambda helper tracing failed: ' + JSON.stringify(lambdaHelperTrace));
}
const lambdaEvents = lambdaHelperTrace.trace.events;
if (!lambdaEvents.some((event) => event.kind === 'call' && event.function === 'dfs' && event.args?.node === 0)) {
  throw new Error('C++ lambda helper should emit call events, received ' + JSON.stringify(lambdaEvents));
}
if (!lambdaEvents.some((event) => event.kind === 'return' && event.function === 'dfs' && event.value === 3)) {
  throw new Error('C++ lambda helper should emit return values, received ' + JSON.stringify(lambdaEvents));
}
if (!lambdaEvents.some((event) => event.kind === 'return' && event.function === 'dfs' && event.value === 0)) {
  throw new Error('C++ lambda helper should trace one-line early return values, received ' + JSON.stringify(lambdaEvents));
}

const selfRecursiveLambdaTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int selfLambdaReachable(vector<vector<int>>& graph) {',
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
  ].join('\n'),
  functionName: 'selfLambdaReachable',
  inputs: { graph: [[1], [2], [1]] },
  options: {},
});
if (!selfRecursiveLambdaTrace.success || selfRecursiveLambdaTrace.output !== 3) {
  throw new Error('C++ self-recursive lambda tracing failed: ' + JSON.stringify(selfRecursiveLambdaTrace));
}
const selfLambdaEvents = selfRecursiveLambdaTrace.trace.events;
if (!selfLambdaEvents.some((event) => event.kind === 'call' && event.function === 'dfs' && event.args?.node === 0 && !Object.prototype.hasOwnProperty.call(event.args, 'self'))) {
  throw new Error('C++ self-recursive lambda should emit call args without callable self, received ' + JSON.stringify(selfLambdaEvents));
}
if (!selfLambdaEvents.some((event) => event.kind === 'return' && event.function === 'dfs' && event.value === 3)) {
  throw new Error('C++ self-recursive lambda should emit return values, received ' + JSON.stringify(selfLambdaEvents));
}
if (!selfLambdaEvents.some((event) => event.kind === 'return' && event.function === 'dfs' && event.value === 0)) {
  throw new Error('C++ self-recursive lambda should trace one-line early return values, received ' + JSON.stringify(selfLambdaEvents));
}

const opsClassTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Accumulator {',
    '  int total;',
    'public:',
    '  Accumulator(int start) {',
    '    total = start;',
    '  }',
    '  void add(int delta) {',
    '    total += delta;',
    '  }',
    '  int value() {',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'Accumulator',
  inputs: {
    operations: ['Accumulator', 'add', 'add', 'value'],
    arguments: [[5], [3], [-2], []],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (!opsClassTrace.success || JSON.stringify(opsClassTrace.output) !== JSON.stringify([null, null, null, 6])) {
  throw new Error('C++ ops-class constructor args / void ops failed: ' + JSON.stringify(opsClassTrace));
}
const opsClassEvents = opsClassTrace.trace.events;
if (!opsClassEvents.some((event) => event.kind === 'call' && event.function === 'add' && event.args?.delta === 3)) {
  throw new Error('C++ ops-class should emit operation call args, received ' + JSON.stringify(opsClassEvents));
}
if (!opsClassEvents.some((event) => event.kind === 'return' && event.function === 'add')) {
  throw new Error('C++ ops-class void operation should emit return event, received ' + JSON.stringify(opsClassEvents));
}
if (!opsClassEvents.some((event) => event.kind === 'return' && event.function === 'value' && event.value === 6)) {
  throw new Error('C++ ops-class should preserve shared state across operations, received ' + JSON.stringify(opsClassEvents));
}

const opsClassBadArgCount = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Counter {',
    'public:',
    '  Counter() {}',
    '  int add(int value) { return value; }',
    '};',
  ].join('\n'),
  functionName: 'Counter',
  inputs: {
    operations: ['Counter', 'add'],
    arguments: [[], []],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (opsClassBadArgCount.success || !String(opsClassBadArgCount.error).includes('expected 1 args, received 0')) {
  throw new Error('C++ ops-class wrong arg count should fail clearly, received ' + JSON.stringify(opsClassBadArgCount));
}

const opsClassBadOperation = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Counter {',
    'public:',
    '  Counter() {}',
    '  int add(int value) { return value; }',
    '};',
  ].join('\n'),
  functionName: 'Counter',
  inputs: {
    operations: ['Counter', 'missing'],
    arguments: [[], []],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (opsClassBadOperation.success || !String(opsClassBadOperation.error).includes('Unable to find C++ Solution method "missing"')) {
  throw new Error('C++ ops-class invalid operation should fail clearly, received ' + JSON.stringify(opsClassBadOperation));
}

const opsClassDiagnostic = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Broken {',
    'public:',
    '  Broken() {}',
    '  int value() {',
    '    return missing + 1;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'Broken',
  inputs: {
    operations: ['Broken', 'value'],
    arguments: [[], []],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (opsClassDiagnostic.success) {
  throw new Error('C++ ops-class user compile diagnostic should fail');
}
if (opsClassDiagnostic.errorLine !== 5 || !String(opsClassDiagnostic.error).includes('UserCode.cpp:5')) {
  throw new Error('C++ ops-class diagnostics should map to user line 5, received ' + JSON.stringify(opsClassDiagnostic));
}

const opsClassMapFieldTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Scoreboard {',
    '  map<string, int> scores;',
    'public:',
    '  Scoreboard() {',
    '    this->scores = map<string, int>{{"seed", 2}};',
    '  }',
    '  void add(string key, int value) {',
    '    this->scores[key] += value;',
    '  }',
    '  int get(string key) {',
    '    return this->scores.count(key) ? this->scores[key] : 0;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'Scoreboard',
  inputs: {
    operations: ['Scoreboard', 'add', 'add', 'get', 'get'],
    arguments: [[], ['a', 3], ['a', 4], ['a'], ['seed']],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (!opsClassMapFieldTrace.success || JSON.stringify(opsClassMapFieldTrace.output) !== JSON.stringify([null, null, null, 7, 2])) {
  throw new Error('C++ ops-class map field persistence failed: ' + JSON.stringify(opsClassMapFieldTrace));
}
const mapFieldEvents = opsClassMapFieldTrace.trace.events;
if (!mapFieldEvents.some((event) => event.kind === 'write' && event.target?.variable === 'this' && event.target?.path?.[0] === 'scores' && event.target.path.length === 1)) {
  throw new Error('C++ map field constructor assignment should emit this.scores write, received ' + JSON.stringify(mapFieldEvents));
}
if (!mapFieldEvents.some((event) => event.kind === 'write' && event.target?.variable === 'this' && event.target?.path?.[0] === 'scores' && event.target?.path?.[1] === 'a')) {
  throw new Error('C++ map field keyed update should emit this.scores[key] write, received ' + JSON.stringify(mapFieldEvents));
}
if (!mapFieldEvents.some((event) => event.kind === 'read' && event.target?.variable === 'this' && event.target?.path?.[0] === 'scores' && event.target?.path?.[1] === 'seed')) {
  throw new Error('C++ map field keyed read should emit this.scores[key] read, received ' + JSON.stringify(mapFieldEvents));
}

const opsClassSetFieldTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Seen {',
    '  set<int> ordered;',
    '  unordered_set<string> names;',
    'public:',
    '  Seen() {',
    '    this->ordered = set<int>{1};',
    '    this->names = unordered_set<string>{"root"};',
    '  }',
    '  void add(int value, string name) {',
    '    this->ordered.insert(value);',
    '    this->names.insert(name);',
    '  }',
    '  int has(int value, string name) {',
    '    return (this->ordered.count(value) ? 10 : 0) + (this->names.count(name) ? 1 : 0);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'Seen',
  inputs: {
    operations: ['Seen', 'add', 'has', 'has'],
    arguments: [[], [3, 'leaf'], [3, 'leaf'], [1, 'root']],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (!opsClassSetFieldTrace.success || JSON.stringify(opsClassSetFieldTrace.output) !== JSON.stringify([null, null, 11, 11])) {
  throw new Error('C++ ops-class set fields failed: ' + JSON.stringify(opsClassSetFieldTrace));
}
const setFieldEvents = opsClassSetFieldTrace.trace.events;
if (!setFieldEvents.some((event) => event.kind === 'write' && event.target?.variable === 'this' && event.target?.path?.[0] === 'ordered' && event.target.path.length === 1)) {
  throw new Error('C++ set field constructor assignment should emit this.ordered write, received ' + JSON.stringify(setFieldEvents));
}
if (!setFieldEvents.some((event) => event.kind === 'write' && event.target?.variable === 'this' && event.target?.path?.[0] === 'ordered' && event.target?.path?.[1] === 3)) {
  throw new Error('C++ set field insert should emit this.ordered[value] write, received ' + JSON.stringify(setFieldEvents));
}
if (!setFieldEvents.some((event) => event.kind === 'write' && event.target?.variable === 'this' && event.target?.path?.[0] === 'names' && event.target?.path?.[1] === 'leaf')) {
  throw new Error('C++ unordered_set field insert should emit this.names[value] write, received ' + JSON.stringify(setFieldEvents));
}
if (!setFieldEvents.some((event) => event.kind === 'read' && event.target?.variable === 'this' && event.target?.path?.[0] === 'names' && event.target?.path?.[1] === 'root')) {
  throw new Error('C++ unordered_set field count should emit this.names[value] read, received ' + JSON.stringify(setFieldEvents));
}

const opsClassDequeFieldTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Window {',
    '  deque<int> values;',
    'public:',
    '  Window() {',
    '    this->values = deque<int>{2};',
    '  }',
    '  void add(int value) {',
    '    this->values.push_back(value);',
    '    this->values.push_front(value - 1);',
    '  }',
    '  int score() {',
    '    return this->values[0] + this->values.back();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'Window',
  inputs: {
    operations: ['Window', 'add', 'score'],
    arguments: [[], [5], []],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (!opsClassDequeFieldTrace.success || JSON.stringify(opsClassDequeFieldTrace.output) !== JSON.stringify([null, null, 9])) {
  throw new Error('C++ ops-class deque field failed: ' + JSON.stringify(opsClassDequeFieldTrace));
}
const dequeFieldEvents = opsClassDequeFieldTrace.trace.events;
if (!dequeFieldEvents.some((event) => event.kind === 'write' && event.target?.variable === 'this' && event.target?.path?.[0] === 'values' && event.target.path.length === 1)) {
  throw new Error('C++ deque field assignment should emit this.values write, received ' + JSON.stringify(dequeFieldEvents));
}
if (!dequeFieldEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'this' && event.target?.path?.[0] === 'values' && event.method === 'push_back')) {
  throw new Error('C++ deque field push_back should emit this.values mutate, received ' + JSON.stringify(dequeFieldEvents));
}
if (!dequeFieldEvents.some((event) => event.kind === 'read' && event.target?.variable === 'this' && event.target?.path?.[0] === 'values' && event.target?.path?.[1] === 0)) {
  throw new Error('C++ deque field indexed read should emit this.values[0] read, received ' + JSON.stringify(dequeFieldEvents));
}

const opsClassAdapterFieldTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Worklist {',
    '  queue<int> q;',
    '  stack<int> st;',
    '  priority_queue<int> pq;',
    'public:',
    '  Worklist() {}',
    '  void add(int value) {',
    '    this->q.push(value);',
    '    this->st.push(value + 1);',
    '    this->pq.push(value + 2);',
    '  }',
    '  int peek() {',
    '    return this->q.front() + this->st.top() + this->pq.top();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'Worklist',
  inputs: {
    operations: ['Worklist', 'add', 'add', 'peek'],
    arguments: [[], [3], [7], []],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (!opsClassAdapterFieldTrace.success || JSON.stringify(opsClassAdapterFieldTrace.output) !== JSON.stringify([null, null, null, 20])) {
  throw new Error('C++ ops-class adapter fields failed: ' + JSON.stringify(opsClassAdapterFieldTrace));
}
const adapterFieldEvents = opsClassAdapterFieldTrace.trace.events;
if (!adapterFieldEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'this' && event.target?.path?.[0] === 'q' && event.method === 'push')) {
  throw new Error('C++ queue field push should emit this.q mutate, received ' + JSON.stringify(adapterFieldEvents));
}
if (!adapterFieldEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'this' && event.target?.path?.[0] === 'st' && event.method === 'push')) {
  throw new Error('C++ stack field push should emit this.st mutate, received ' + JSON.stringify(adapterFieldEvents));
}
if (!adapterFieldEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'this' && event.target?.path?.[0] === 'pq' && event.method === 'push')) {
  throw new Error('C++ priority_queue field push should emit this.pq mutate, received ' + JSON.stringify(adapterFieldEvents));
}
if (!adapterFieldEvents.some((event) => event.kind === 'read' && event.target?.variable === 'this' && event.target?.path?.[0] === 'q' && event.target?.path?.[1] === 'front')) {
  throw new Error('C++ queue field front should emit this.q.front read, received ' + JSON.stringify(adapterFieldEvents));
}
if (!adapterFieldEvents.some((event) => event.kind === 'read' && event.target?.variable === 'this' && event.target?.path?.[0] === 'st' && event.target?.path?.[1] === 'top')) {
  throw new Error('C++ stack field top should emit this.st.top read, received ' + JSON.stringify(adapterFieldEvents));
}
if (!adapterFieldEvents.some((event) => event.kind === 'read' && event.target?.variable === 'this' && event.target?.path?.[0] === 'pq' && event.target?.path?.[1] === 'top')) {
  throw new Error('C++ priority_queue field top should emit this.pq.top read, received ' + JSON.stringify(adapterFieldEvents));
}

const budgetTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int spin() {',
    '    int total = 0;',
    '    while (true) {',
    '      total++;',
    '    }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'spin',
  inputs: {},
  options: { maxTraceSteps: 8 },
});
if (budgetTrace.success) {
  throw new Error('C++ trace budget should stop an infinite loop');
}
if (!budgetTrace.traceLimitExceeded || budgetTrace.timeoutReason !== 'trace-limit') {
  throw new Error('C++ trace budget should report trace-limit, received ' + JSON.stringify(budgetTrace));
}
if (!budgetTrace.trace.events.some((event) => event.kind === 'timeout')) {
  throw new Error('C++ trace budget should emit a timeout event, received ' + JSON.stringify(budgetTrace.trace.events));
}
`;

execFileSync(
  process.execPath,
  ['--experimental-vm-modules', '--input-type=module', '-e', smokeScript],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    maxBuffer: 20 * 1024 * 1024,
  }
);

console.log('PASS: C++ browser worker compiler/runtime smoke');
