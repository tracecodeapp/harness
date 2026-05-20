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
  workerSource + '\nglobalThis.__tracecodeCppTest = { handleInit, handleWarmup, handleCompileRun, handleExecuteWithTracing, handleExecuteCodeInterview, state: () => ({ hasToolchainPromise: Boolean(toolchainPromise), hasWarmupPromise: Boolean(warmupPromise), programCacheSize: programCache.size }) };',
  {
    importModuleDynamically(specifier) {
      return import(specifier);
    },
  }
);
await script.runInContext(context);

const initResult = await sandbox.__tracecodeCppTest.handleInit({
  assets: {
    compilerBundleUrl: pathToFileURL(process.cwd() + '/node_modules/@yowasp/clang/gen/bundle.js').href,
    clangWasmUrl: 'file:///missing/clang.wasm',
    lldWasmUrl: 'file:///missing/lld.wasm',
    sysrootUrl: 'file:///missing/sysroot.tar',
    runtimeHeaderUrl: 'file://' + process.cwd() + '/workers/cpp/tracecode_runtime.hpp',
  },
});
if (initResult.timings?.warmupMs !== 0 || sandbox.__tracecodeCppTest.state().hasToolchainPromise) {
  throw new Error('C++ init should not load or warm the compiler toolchain: ' + JSON.stringify(initResult));
}

const warmupResult = await sandbox.__tracecodeCppTest.handleWarmup({});
if (!warmupResult.success || warmupResult.timings?.warmupMs === 0) {
  throw new Error('C++ warmup should load and warm the compiler toolchain: ' + JSON.stringify(warmupResult));
}
if (!sandbox.__tracecodeCppTest.state().hasToolchainPromise || !sandbox.__tracecodeCppTest.state().hasWarmupPromise) {
  throw new Error('C++ warmup should retain the initialized compiler promises');
}

const describeCppPayload = (method, payload) => {
  const label = payload?.name || payload?.functionName || payload?.executionStyle || 'unknown';
  return method + ' ' + label;
};

const wrapCppTestMethod = (method) => {
  const original = sandbox.__tracecodeCppTest[method];
  sandbox.__tracecodeCppTest[method] = async (payload) => {
    const label = describeCppPayload(method, payload);
    console.log('RUN: C++ ' + label);
    const startedAt = performance.now();
    try {
      const result = await original(payload);
      const status = result?.success === false ? 'FAIL' : 'PASS';
      const elapsedMs = Math.round(performance.now() - startedAt);
      const detail = result?.success === false && result?.error ? ': ' + result.error : '';
      console.log(status + ': C++ ' + label + ' (' + elapsedMs + 'ms)' + detail);
      return result;
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      console.log('FAIL: C++ ' + label + ' (' + elapsedMs + 'ms): ' + (error?.stack || error));
      throw error;
    }
  };
};

for (const method of ['handleCompileRun', 'handleExecuteWithTracing', 'handleExecuteCodeInterview']) {
  wrapCppTestMethod(method);
}

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
    name: 'ordered map lower_bound',
    code: 'class Solution { public: int nextStart(vector<int>& starts, int target) { map<int, int> bookings; for (int start : starts) bookings[start] = start + 10; auto it = bookings.lower_bound(target); if (it == bookings.end()) return -1; return it->first; } };',
    functionName: 'nextStart',
    inputs: { starts: [10, 30, 50], target: 25 },
    expected: 30,
  },
  {
    name: 'nested ordered map proxy lookup',
    code: 'class Solution { public: int cap(map<string, map<string, int>>& campaigns, string id) { return campaigns[id].count("cap") ? campaigns[id]["cap"] : 0; } };',
    functionName: 'cap',
    inputs: { campaigns: { a: { cap: 7 } }, id: 'a' },
    expected: 7,
  },
  {
    name: 'nested vector proxy comparison',
    code: 'class Solution { public: bool differs(vector<vector<int>>& intervals) { return intervals[0][0] != intervals[1][0]; } };',
    functionName: 'differs',
    inputs: { intervals: [[1, 4], [2, 5]] },
    expected: true,
  },
  {
    name: 'variant result serialization',
    code: 'class Solution { public: vector<vector<variant<string, int>>> rows() { return { { string("A"), 1 }, { string("B"), 2 } }; } };',
    functionName: 'rows',
    inputs: {},
    expected: [['A', 1], ['B', 2]],
  },
  {
    name: 'rewritten container STL parity',
    code: [
      'class Solution {',
      'public:',
      '  int parity(vector<int>& input) {',
      '    vector<int> values = input;',
      '    values.emplace(values.begin() + 1, 7);',
      '    values.insert(values.end(), {8, 9});',
      '    values.shrink_to_fit();',
      '    deque<int> dq;',
      '    dq.emplace_back(values.front());',
      '    dq.emplace_front(values.back());',
      '    dq.insert(dq.end(), 3);',
      '    unordered_map<int, int> seen;',
      '    seen.try_emplace(1, 10);',
      '    seen.insert_or_assign(1, 11);',
      '    seen.rehash(16);',
      '    map<int, int> ordered;',
      '    ordered.insert_or_assign(2, 20);',
      '    ordered.emplace_hint(ordered.end(), 3, 30);',
      '    set<int> sorted;',
      '    sorted.emplace_hint(sorted.end(), 4);',
      '    sorted.insert(6);',
      '    auto lb = sorted.lower_bound(5);',
      '    unordered_set<int> flags;',
      '    flags.reserve(8);',
      '    flags.max_load_factor(0.7f);',
      '    flags.insert(5);',
      '    flags.rehash(16);',
      '    queue<int> q;',
      '    q.emplace(12);',
      '    q.push(13);',
      '    stack<int> st;',
      '    st.emplace(14);',
      '    st.push(15);',
      '    priority_queue<int> pq;',
      '    pq.emplace(16);',
      '    pq.push(17);',
      '    return values[1] + dq.front() + seen.at(1) + ordered.rbegin()->second + *lb +',
      '      (flags.count(5) ? 1 : 0) + q.front() + st.top() + pq.top();',
      '  }',
      '};',
    ].join('\n'),
    functionName: 'parity',
    inputs: { input: [1, 2, 3] },
    expected: 108,
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
    name: 'default standard headers',
    code: [
      'class Solution {',
      'public:',
      '  vector<int> defaultHeaders(string s) {',
      '    regex word("[a-z]+");',
      '    unordered_set<string> seen;',
      '    list<int> values = {1, 2};',
      '    forward_list<int> more = {3, 4};',
      '    optional<int> maybe = 5;',
      '    variant<int, string> box = 7;',
      '    string_view view(s);',
      '    mt19937 rng(1);',
      '    uniform_int_distribution<int> dist(0, 0);',
      '    auto epoch = chrono::system_clock::time_point{};',
      '    return {',
      '      regex_match(s, word) ? 1 : 0,',
      '      (int)seen.size(),',
      '      values.front(),',
      '      more.front(),',
      '      maybe.value(),',
      '      get<int>(box),',
      '      (int)view.size(),',
      '      dist(rng),',
      '      (int)chrono::system_clock::to_time_t(epoch)',
      '    };',
      '  }',
      '};',
    ].join('\n'),
    functionName: 'defaultHeaders',
    inputs: { s: 'abc' },
    expected: [1, 0, 1, 3, 5, 7, 3, 0, 0],
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
  {
    name: 'no-exception static helper catch lowering',
    code: [
      '#include <any>',
      '#include <stdexcept>',
      'static long long anyToLL(const std::any& value) {',
      '  if (value.type() == typeid(int)) return std::any_cast<int>(value);',
      '  throw std::bad_any_cast{};',
      '}',
      'class Solution {',
      'public:',
      '  long long recover(int value) {',
      '    try {',
      '      return anyToLL(std::any(value));',
      '    } catch (const std::exception&) {',
      '      return 42;',
      '    }',
      '  }',
      '};',
    ].join('\n'),
    functionName: 'recover',
    inputs: { value: 7 },
    expected: 7,
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

const runtimeCrashDiagnostics = await sandbox.__tracecodeCppTest.handleCompileRun({
  name: 'runtime crash diagnostics',
  code: [
    'class Solution {',
    'public:',
    '  int fail() {',
    '    std::printf("before crash\\n");',
    '    std::fprintf(stderr, "fatal detail\\n");',
    '    std::fflush(stdout);',
    '    std::fflush(stderr);',
    '    std::exit(5);',
    '    return 0;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'fail',
  inputs: {},
});
if (runtimeCrashDiagnostics.success) {
  throw new Error('C++ runtime crash diagnostics case should fail');
}
if (!String(runtimeCrashDiagnostics.error || '').includes('fatal detail') || !runtimeCrashDiagnostics.consoleOutput?.includes('before crash')) {
  throw new Error('C++ runtime crash diagnostics should preserve stderr/stdout, received ' + JSON.stringify(runtimeCrashDiagnostics));
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

const nodeFieldReadTracing = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int sumPair(ListNode* head) {',
    '    int first = head ? head->val : 0;',
    '    ListNode* next = head ? head->next : nullptr;',
    '    int second = next ? next->val : 0;',
    '    return first + second;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'sumPair',
  inputs: { head: [4, 9] },
  options: {},
});
if (!nodeFieldReadTracing.success || nodeFieldReadTracing.output !== 13) {
  throw new Error('C++ ListNode field-read tracing failed: ' + JSON.stringify(nodeFieldReadTracing));
}
const nodeFieldReadEvents = nodeFieldReadTracing.trace.events;
if (!nodeFieldReadEvents.some((event) => event.kind === 'read' && event.target?.variable === 'head' && event.target?.path?.[0] === 'val' && event.value === 4)) {
  throw new Error('C++ ListNode head->val should emit field read, received ' + JSON.stringify(nodeFieldReadEvents));
}
if (!nodeFieldReadEvents.some((event) => event.kind === 'read' && event.target?.variable === 'head' && event.target?.path?.[0] === 'next' && event.value?.__type__ === 'ListNode')) {
  throw new Error('C++ ListNode head->next should emit field read, received ' + JSON.stringify(nodeFieldReadEvents));
}
if (!nodeFieldReadEvents.some((event) => event.kind === 'read' && event.target?.variable === 'next' && event.target?.path?.[0] === 'val' && event.value === 9)) {
  throw new Error('C++ ListNode next->val should emit field read, received ' + JSON.stringify(nodeFieldReadEvents));
}

const stackNodeDeclarationTracing = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'struct ListNode {',
    '  int val;',
    '  ListNode* next;',
    '  ListNode() : val(0), next(nullptr) {}',
    '  ListNode(int x) : val(x), next(nullptr) {}',
    '};',
    'class Solution {',
    'public:',
    '  int makeDummy() {',
    '    ListNode dummy(0);',
    '    return dummy.val;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'makeDummy',
  inputs: {},
  options: {},
});
if (!stackNodeDeclarationTracing.success || stackNodeDeclarationTracing.output !== 0) {
  throw new Error('C++ stack ListNode declaration tracing failed: ' + JSON.stringify(stackNodeDeclarationTracing));
}
const stackNodeEvents = stackNodeDeclarationTracing.trace.events;
const stackNodeWrite = stackNodeEvents.find((event) =>
  event.kind === 'write' &&
  event.line === 10 &&
  event.target?.variable === 'dummy'
);
if (stackNodeWrite?.value?.__type__ !== 'ListNode' || stackNodeWrite.value.val !== 0) {
  throw new Error('C++ stack ListNode declaration should emit object write, received ' + JSON.stringify(stackNodeEvents));
}

const nodeIdentityTracing = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  ListNode* reverseList(ListNode* head) {',
    '    ListNode* prev = nullptr;',
    '    ListNode* curr = head;',
    '    while (curr) {',
    '      ListNode* next = curr->next;',
    '      curr->next = prev;',
    '      prev = curr;',
    '      curr = next;',
    '    }',
    '    return prev;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'reverseList',
  inputs: { head: [1, 2, 3] },
  options: {},
});
if (!nodeIdentityTracing.success) {
  throw new Error('C++ ListNode identity tracing failed: ' + JSON.stringify(nodeIdentityTracing));
}
const nodeIdentityEvents = nodeIdentityTracing.trace.events;
const firstMoveHead = nodeIdentityEvents.find((event) => event.kind === 'snapshot' && event.line === 10 && event.target?.variable === 'head')?.value;
const firstMoveCurr = nodeIdentityEvents.find((event) => event.kind === 'snapshot' && event.line === 10 && event.target?.variable === 'curr' && event.value?.val === 2)?.value;
if (!firstMoveHead?.__id__ || !firstMoveCurr?.__id__ || firstMoveHead.__id__ === firstMoveCurr.__id__) {
  throw new Error('C++ ListNode snapshots should keep distinct object ids across variables in one frame, received ' + JSON.stringify(nodeIdentityEvents));
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

const treeStringLiteralMutationTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  TreeNode* runCodec(TreeNode* root) {',
    '    vector<string> vals;',
    '    vals.push_back(to_string(root->val));',
    '    vals.push_back("null");',
    '    if (vals[1] != "null") return new TreeNode(stoi(vals[1]));',
    '    return new TreeNode(stoi(vals[0]));',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'runCodec',
  inputs: { root: { val: 7 } },
  options: {},
});
if (!treeStringLiteralMutationTrace.success || treeStringLiteralMutationTrace.output?.val !== 7) {
  throw new Error('C++ tracing should preserve string literal mutation args for tree codecs, received ' + JSON.stringify(treeStringLiteralMutationTrace));
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
  throw new Error('C++ syntax error should map to solution.cpp line 4, received ' + syntaxError.errorLine);
}
if (!String(syntaxError.error || '').includes('solution.cpp:4')) {
  throw new Error('C++ syntax error should include solution.cpp diagnostics, received ' + syntaxError.error);
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
if (traced.trace.events[0].runId !== 'cpp:run' || traced.trace.events[0].file !== 'solution.cpp') {
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
  throw new Error('C++ minimalTrace should keep line/return events, received ' + JSON.stringify(minimalTrace.trace.events));
}
if (minimalTrace.trace.events.some((event) => ['snapshot', 'read', 'write', 'mutate'].includes(event.kind))) {
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
if (!vectorEvents.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && JSON.stringify(event.target.indexSources) === JSON.stringify(['mid']))) {
  throw new Error('C++ vector tracing should emit indexSources for nums[mid], received ' + JSON.stringify(vectorEvents));
}
if (!vectorEvents.some((event) => event.kind === 'write' && event.line === 9 && event.target?.variable === 'left' && event.value === 3)) {
  throw new Error('C++ inline conditional scalar assignment should emit left write on line 9, received ' + JSON.stringify(vectorEvents));
}

const vectorBoolTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  bool visit() {',
    '    vector<bool> visited(3, false);',
    '    int nodeIdx = 1;',
    '    visited[nodeIdx] = true;',
    '    int neighborIdx = 1;',
    '    if (!visited[neighborIdx]) return false;',
    '    return visited[1];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'visit',
  inputs: {},
  options: {},
});
if (!vectorBoolTrace.success || vectorBoolTrace.output !== true) {
  throw new Error('C++ vector<bool> tracing failed: ' + JSON.stringify(vectorBoolTrace));
}
const vectorBoolEvents = vectorBoolTrace.trace.events;
if (!vectorBoolEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'visited' && JSON.stringify(event.value) === JSON.stringify([false, false, false]))) {
  throw new Error('C++ vector<bool> should snapshot boolean vectors, received ' + JSON.stringify(vectorBoolEvents));
}
if (!vectorBoolEvents.some((event) => event.kind === 'write' && event.line === 6 && event.target?.variable === 'visited' && JSON.stringify(event.target.path) === JSON.stringify([1]) && event.value === true && JSON.stringify(event.target.indexSources) === JSON.stringify(['nodeIdx']))) {
  throw new Error('C++ vector<bool> indexed assignment should emit write indexSources, received ' + JSON.stringify(vectorBoolEvents));
}
if (!vectorBoolEvents.some((event) => event.kind === 'read' && event.line === 8 && event.target?.variable === 'visited' && JSON.stringify(event.target.path) === JSON.stringify([1]) && event.value === true && JSON.stringify(event.target.indexSources) === JSON.stringify(['neighborIdx']))) {
  throw new Error('C++ vector<bool> indexed condition should emit read indexSources, received ' + JSON.stringify(vectorBoolEvents));
}

const vectorUnaryWriteTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int bump(vector<int>& values, int index) {',
    '    values[index]++;',
    '    values[index]--;',
    '    return values[index];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'bump',
  inputs: { values: [2, 4], index: 1 },
  options: {},
});
if (!vectorUnaryWriteTrace.success || vectorUnaryWriteTrace.output !== 4) {
  throw new Error('C++ vector unary write tracing failed: ' + JSON.stringify(vectorUnaryWriteTrace));
}
const vectorUnaryEvents = vectorUnaryWriteTrace.trace.events;
if (!vectorUnaryEvents.some((event) => event.kind === 'read' && event.line === 4 && event.target?.variable === 'values' && JSON.stringify(event.target.indexSources) === JSON.stringify(['index']))) {
  throw new Error('C++ vector unary increment should emit read indexSources, received ' + JSON.stringify(vectorUnaryEvents));
}
if (!vectorUnaryEvents.some((event) => event.kind === 'write' && event.line === 4 && event.target?.variable === 'values' && event.value === 5 && JSON.stringify(event.target.indexSources) === JSON.stringify(['index']))) {
  throw new Error('C++ vector unary increment should emit write indexSources, received ' + JSON.stringify(vectorUnaryEvents));
}
if (!vectorUnaryEvents.some((event) => event.kind === 'write' && event.line === 5 && event.target?.variable === 'values' && event.value === 4 && JSON.stringify(event.target.indexSources) === JSON.stringify(['index']))) {
  throw new Error('C++ vector unary decrement should emit write indexSources, received ' + JSON.stringify(vectorUnaryEvents));
}

const slidingWindowConditionTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  vector<int> maxSlidingWindow(vector<int>& nums, int k) {',
    '    vector<int> out;',
    '    deque<int> q;',
    '    for (int i = 0; i < nums.size(); i++) {',
    '      int num = nums[i];',
    '      while (!q.empty() && nums[q.back()] < num) {',
    '        q.pop_back();',
    '      }',
    '      q.push_back(i);',
    '      if (i >= k - 1) out.push_back(nums[q.front()]);',
    '    }',
    '    return out;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'maxSlidingWindow',
  inputs: { nums: [1, 3, 2, 5], k: 2 },
  options: {},
});
if (!slidingWindowConditionTrace.success || JSON.stringify(slidingWindowConditionTrace.output) !== JSON.stringify([3, 3, 5])) {
  throw new Error('C++ sliding-window trace failed: ' + JSON.stringify(slidingWindowConditionTrace));
}
const slidingWindowEvents = slidingWindowConditionTrace.trace.events;
if (!slidingWindowEvents.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && event.line === 8)) {
  throw new Error('C++ while-condition indexed read should carry condition line 8, received ' + JSON.stringify(slidingWindowEvents));
}
if (slidingWindowEvents.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && event.line === 9)) {
  throw new Error('C++ while-condition indexed read leaked body line 9, received ' + JSON.stringify(slidingWindowEvents));
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

const nativeNestedVectorTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int dpMin() {',
    '    std::vector<std::vector<int>> dp(2, std::vector<int>(2, 0));',
    '    dp[0][1] = 4;',
    '    dp[1][0] = 5;',
    '    dp[1][1] = 1 + std::min({dp[0][1], dp[1][0], dp[0][0]});',
    '    return dp[1][1];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'dpMin',
  inputs: {},
  options: {},
});
if (!nativeNestedVectorTrace.success || nativeNestedVectorTrace.output !== 1) {
  throw new Error('C++ native nested vector tracing should compile around std::min initializer lists: ' + JSON.stringify(nativeNestedVectorTrace));
}
const nativeNestedVectorEvents = nativeNestedVectorTrace.trace.events;
if (!nativeNestedVectorEvents.some((event) => event.kind === 'write' && event.target?.variable === 'dp' && event.target.path?.[0] === 1 && event.target.path?.[1] === 1 && event.value === 1)) {
  throw new Error('C++ native nested vector writes should emit V4 write events, received ' + JSON.stringify(nativeNestedVectorEvents));
}
if (!nativeNestedVectorEvents.some((event) => event.kind === 'read' && event.target?.variable === 'dp' && event.target.path?.[0] === 0 && event.target.path?.[1] === 1)) {
  throw new Error('C++ native nested vector reads should emit V4 read events, received ' + JSON.stringify(nativeNestedVectorEvents));
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

const compactPlainVectorMutationTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int collect() {',
    '    vector<string> ineligible;',
    '    string c = "x";',
    '    if (c.size()) ineligible.push_back(c);',
    '    return ineligible.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'collect',
  inputs: {},
  options: {},
});
if (!compactPlainVectorMutationTrace.success || compactPlainVectorMutationTrace.output !== 1) {
  throw new Error('C++ compact plain vector mutation tracing failed: ' + JSON.stringify(compactPlainVectorMutationTrace));
}
const compactPlainVectorMutationEvents = compactPlainVectorMutationTrace.trace.events;
if (!compactPlainVectorMutationEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 6 &&
  event.target?.variable === 'ineligible' &&
  event.method === 'push_back' &&
  JSON.stringify(event.args) === JSON.stringify(['x'])
)) {
  throw new Error('C++ compact if push_back should emit mutation, received ' + JSON.stringify(compactPlainVectorMutationEvents));
}

const plainStringVectorMutationTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int collect() {',
    '    map<string, string> emailToName;',
    '    emailToName["a"] = "Ann";',
    '    string email = "a";',
    '    vector<string> names;',
    '    names.push_back(emailToName[email]);',
    '    return names.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'collect',
  inputs: {},
  options: {},
});
if (!plainStringVectorMutationTrace.success || plainStringVectorMutationTrace.output !== 1) {
  throw new Error('C++ plain string vector mutation tracing failed: ' + JSON.stringify(plainStringVectorMutationTrace));
}
const plainStringVectorEvents = plainStringVectorMutationTrace.trace.events;
if (!plainStringVectorEvents.some((event) => event.kind === 'read' && event.line === 8 && event.target?.variable === 'emailToName' && event.target.path?.[0] === 'a')) {
  throw new Error('C++ plain vector push_back argument should preserve keyed read, received ' + JSON.stringify(plainStringVectorEvents));
}
if (!plainStringVectorEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 8 &&
  event.target?.variable === 'names' &&
  event.method === 'push_back' &&
  JSON.stringify(event.args) === JSON.stringify(['Ann'])
)) {
  throw new Error('C++ plain string vector push_back should emit mutation args, received ' + JSON.stringify(plainStringVectorEvents));
}

const plainSetInsertMutationTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int visit() {',
    '    unordered_set<int> visited;',
    '    int v = 7;',
    '    visited.insert(v);',
    '    return visited.count(7);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'visit',
  inputs: {},
  options: {},
});
if (!plainSetInsertMutationTrace.success || plainSetInsertMutationTrace.output !== 1) {
  throw new Error('C++ plain set insert tracing failed: ' + JSON.stringify(plainSetInsertMutationTrace));
}
const plainSetInsertEvents = plainSetInsertMutationTrace.trace.events;
if (!plainSetInsertEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 6 &&
  event.target?.variable === 'visited' &&
  event.method === 'insert' &&
  JSON.stringify(event.args) === JSON.stringify([7])
)) {
  throw new Error('C++ plain set insert should emit mutation args, received ' + JSON.stringify(plainSetInsertEvents));
}

const nativeSetReferenceInsertMutationTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int visit() {',
    '    function<void(int, std::unordered_set<int>&)> dfs = [&](int v, std::unordered_set<int>& visited) {',
    '      visited.insert(v);',
    '    };',
    '    unordered_set<int> visited;',
    '    dfs(7, visited);',
    '    return visited.count(7);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'visit',
  inputs: {},
  options: {},
});
if (!nativeSetReferenceInsertMutationTrace.success || nativeSetReferenceInsertMutationTrace.output !== 1) {
  throw new Error('C++ native set reference insert tracing failed: ' + JSON.stringify(nativeSetReferenceInsertMutationTrace));
}
const nativeSetReferenceInsertEvents = nativeSetReferenceInsertMutationTrace.trace.events;
if (!nativeSetReferenceInsertEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 5 &&
  event.target?.variable === 'visited' &&
  event.method === 'insert' &&
  JSON.stringify(event.args) === JSON.stringify([7])
)) {
  throw new Error('C++ native set reference insert should emit mutation args, received ' + JSON.stringify(nativeSetReferenceInsertEvents));
}

const trailingCommentDeclarationTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int writeKey() {',
    '    unordered_map<int, int> rightIndex; // key -> index',
    '    int key = 51;',
    '    int idx = 1;',
    '    rightIndex[key] = idx;',
    '    return rightIndex[key];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'writeKey',
  inputs: {},
  options: {},
});
if (!trailingCommentDeclarationTrace.success || trailingCommentDeclarationTrace.output !== 1) {
  throw new Error('C++ trailing-comment declaration tracing failed: ' + JSON.stringify(trailingCommentDeclarationTrace));
}
const trailingCommentDeclarationEvents = trailingCommentDeclarationTrace.trace.events;
if (!trailingCommentDeclarationEvents.some((event) =>
  event.kind === 'write' &&
  event.line === 7 &&
  event.target?.variable === 'rightIndex' &&
  event.target.path?.[0] === 51 &&
  event.value === 1
)) {
  throw new Error('C++ declarations with trailing comments should stay traceable, received ' + JSON.stringify(trailingCommentDeclarationEvents));
}

const blankLineContainerDeclarationTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int build() {',
    '    int n = 2;',
    '',
    '    vector<int> dist(n, 7);',
    '    return dist[0];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'build',
  inputs: {},
  options: {},
});
if (!blankLineContainerDeclarationTrace.success || blankLineContainerDeclarationTrace.output !== 7) {
  throw new Error('C++ blank-line container declaration tracing failed: ' + JSON.stringify(blankLineContainerDeclarationTrace));
}
const blankLineContainerDeclarationEvents = blankLineContainerDeclarationTrace.trace.events;
if (blankLineContainerDeclarationEvents.some((event) => event.kind !== 'line' && event.line === 5)) {
  throw new Error('C++ blank line before container declaration should not receive state events, received ' + JSON.stringify(blankLineContainerDeclarationEvents));
}
if (!blankLineContainerDeclarationEvents.some((event) =>
  event.kind === 'write' &&
  event.line === 6 &&
  event.target?.variable === 'dist' &&
  JSON.stringify(event.value) === JSON.stringify([7, 7])
)) {
  throw new Error('C++ container declaration after blank line should write on declaration line, received ' + JSON.stringify(blankLineContainerDeclarationEvents));
}

const stringReferenceIndexedConditionTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  bool differs(vector<string>& words) {',
    '    int i = 0;',
    '    const string& w1 = words[i];',
    '    const string& w2 = words[i + 1];',
    '    int j = 0;',
    '    if (w1[j] != w2[j]) return true;',
    '    return false;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'differs',
  inputs: { words: ['za', 'xb'] },
  options: {},
});
if (!stringReferenceIndexedConditionTrace.success || stringReferenceIndexedConditionTrace.output !== true) {
  throw new Error('C++ string reference indexed condition tracing failed: ' + JSON.stringify(stringReferenceIndexedConditionTrace));
}
const stringReferenceEvents = stringReferenceIndexedConditionTrace.trace.events;
if (!stringReferenceEvents.some((event) => event.kind === 'read' && event.line === 8 && event.target?.variable === 'w1' && event.target.path?.[0] === 0 && event.value === 'z' && JSON.stringify(event.target.indexSources) === JSON.stringify(['j']))) {
  throw new Error('C++ string reference condition should read w1[j], received ' + JSON.stringify(stringReferenceEvents));
}
if (!stringReferenceEvents.some((event) => event.kind === 'read' && event.line === 8 && event.target?.variable === 'w2' && event.target.path?.[0] === 0 && event.value === 'x' && JSON.stringify(event.target.indexSources) === JSON.stringify(['j']))) {
  throw new Error('C++ string reference condition should read w2[j], received ' + JSON.stringify(stringReferenceEvents));
}

const plainArrayTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int plainArrays(string s) {',
    '    array<int, 3> counts{};',
    '    counts.fill(0);',
    "    counts[s[0] - 'a']++;",
    '    string key = "tea";',
    '    sort(key.begin(), key.end());',
    '    int dr[] = {1, -1, 0, 0};',
    '    return counts[0] + dr[0] + (int)key.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'plainArrays',
  inputs: { s: 'a' },
  options: {},
});
if (!plainArrayTrace.success || plainArrayTrace.output !== 5) {
  throw new Error('C++ plain array tracing failed: ' + JSON.stringify(plainArrayTrace));
}
const plainArrayEvents = plainArrayTrace.trace.events;
if (!plainArrayEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'counts' && event.method === 'fill' && JSON.stringify(event.args) === JSON.stringify([0]))) {
  throw new Error('C++ std::array fill should emit mutation args, received ' + JSON.stringify(plainArrayEvents));
}
if (!plainArrayEvents.some((event) => event.kind === 'write' && event.target?.variable === 'counts' && event.target.path?.[0] === 0 && event.value === 1)) {
  throw new Error('C++ std::array indexed update should emit write evidence, received ' + JSON.stringify(plainArrayEvents));
}
if (!plainArrayEvents.some((event) => event.kind === 'read' && event.target?.variable === 'counts' && JSON.stringify(event.target.indexSources) === JSON.stringify(["s[0] - 'a'"]))) {
  throw new Error('C++ std::array indexed update should preserve char-derived read indexSources, received ' + JSON.stringify(plainArrayEvents));
}
if (!plainArrayEvents.some((event) => event.kind === 'write' && event.target?.variable === 'counts' && JSON.stringify(event.target.indexSources) === JSON.stringify(["s[0] - 'a'"]))) {
  throw new Error('C++ std::array indexed update should preserve char-derived write indexSources, received ' + JSON.stringify(plainArrayEvents));
}
if (!plainArrayEvents.some((event) => event.kind === 'mutate' && event.target?.variable === 'key' && event.method === 'sort')) {
  throw new Error('C++ std::sort should emit receiver mutation evidence, received ' + JSON.stringify(plainArrayEvents));
}
if (!plainArrayEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'key' && event.value === 'aet')) {
  throw new Error('C++ std::sort should snapshot sorted receiver value, received ' + JSON.stringify(plainArrayEvents));
}
if (!plainArrayEvents.some((event) => event.kind === 'snapshot' && event.target?.variable === 'dr' && JSON.stringify(event.value) === JSON.stringify([1, -1, 0, 0]))) {
  throw new Error('C++ raw C arrays should snapshot as indexed values, received ' + JSON.stringify(plainArrayEvents));
}
if (!plainArrayEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 10 &&
  event.target?.variable === 'dr' &&
  JSON.stringify(event.target.path) === JSON.stringify([0]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify([null]) &&
  event.value === 1
)) {
  throw new Error('C++ raw C array literal-index reads should emit indexed read evidence, received ' + JSON.stringify(plainArrayEvents));
}

const rawArrayVariableIndexTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int rawArrayIndexedRead(int base) {',
    '    int dr[] = {1, -1, 0, 0};',
    '    int d = 2;',
    '    int nr = base + dr[d];',
    '    return nr;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'rawArrayIndexedRead',
  inputs: { base: 5 },
  options: {},
});
if (!rawArrayVariableIndexTrace.success || rawArrayVariableIndexTrace.output !== 5) {
  throw new Error('C++ raw C array variable-index tracing failed: ' + JSON.stringify(rawArrayVariableIndexTrace));
}
const rawArrayVariableIndexEvents = rawArrayVariableIndexTrace.trace.events;
if (!rawArrayVariableIndexEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 6 &&
  event.target?.variable === 'dr' &&
  JSON.stringify(event.target.path) === JSON.stringify([2]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['d']) &&
  event.value === 0
)) {
  throw new Error('C++ raw C array variable-index reads should emit indexed read evidence with indexSources, received ' + JSON.stringify(rawArrayVariableIndexEvents));
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

const constNestedVectorIndexTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int maxAssignments(vector<vector<int>>& canDo) {',
    '    const auto& matrix = canDo;',
    '    if (matrix.empty()) return 0;',
    '    int m = static_cast<int>(matrix.size());',
    '    int n = static_cast<int>(matrix[0].size());',
    '    vector<vector<int>> adj(m);',
    '    for (int i = 0; i < m; i++) {',
    '      for (int j = 0; j < n; j++) {',
    '        if (matrix[i][j] == 1) adj[i].push_back(j);',
    '      }',
    '    }',
    '    return static_cast<int>(adj.size());',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'maxAssignments',
  inputs: { canDo: [[1, 1, 0], [0, 1, 1], [1, 0, 0]] },
  options: {},
});
if (!constNestedVectorIndexTrace.success || constNestedVectorIndexTrace.output !== 3) {
  throw new Error('C++ const nested vector indexed member access should compile and trace, received ' + JSON.stringify(constNestedVectorIndexTrace));
}

const functionIndexSourceAdjacencyTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int connect() {',
    '    vector<vector<int>> adjacency(9);',
    '    auto cellId = [&](int r, int c) { return r * 3 + c; };',
    '    int r = 1;',
    '    int c = 1;',
    '    adjacency[cellId(r, c)].push_back(cellId(r, c + 1));',
    '    return adjacency[4][0];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'connect',
  inputs: {},
  options: {},
});
if (!functionIndexSourceAdjacencyTrace.success || functionIndexSourceAdjacencyTrace.output !== 5) {
  throw new Error('C++ function-call indexed adjacency tracing failed: ' + JSON.stringify(functionIndexSourceAdjacencyTrace));
}
const functionIndexSourceAdjacencyEvents = functionIndexSourceAdjacencyTrace.trace.events;
if (!functionIndexSourceAdjacencyEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 8 &&
  event.target?.variable === 'adjacency' &&
  JSON.stringify(event.target.path) === JSON.stringify([4]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['cellId(r, c)']) &&
  event.method === 'push_back' &&
  JSON.stringify(event.args) === JSON.stringify([5])
)) {
  throw new Error('C++ adjacency[cellId(...)] push_back should preserve function-call index provenance and args, received ' + JSON.stringify(functionIndexSourceAdjacencyEvents));
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

const unorderedMapVectorTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int build() {',
    '    unordered_map<int, vector<int>> graph;',
    '    int from = 2;',
    '    int to = 7;',
    '    graph[from].push_back(to);',
    '    return graph[from][0];',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'build',
  inputs: {},
  options: {},
});
if (!unorderedMapVectorTrace.success || unorderedMapVectorTrace.output !== 7) {
  throw new Error('C++ unordered_map<vector> tracing failed: ' + JSON.stringify(unorderedMapVectorTrace));
}
const unorderedMapVectorEvents = unorderedMapVectorTrace.trace.events;
if (!unorderedMapVectorEvents.some((event) =>
  event.kind === 'mutate' &&
  event.target?.variable === 'graph' &&
  event.target.path?.[0] === 2 &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['from']) &&
  event.method === 'push_back' &&
  JSON.stringify(event.args) === JSON.stringify([7])
)) {
  throw new Error('C++ unordered_map<vector> push_back should emit mutation args and key provenance, received ' + JSON.stringify(unorderedMapVectorEvents));
}

const unorderedMapIteratorSecondTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int clearPattern() {',
    '    unordered_map<string, vector<string>> adjacency;',
    '    string pattern = "h*t";',
    '    adjacency[pattern].push_back("hit");',
    '    auto it = adjacency.find(pattern);',
    '    it->second.clear();',
    '    return adjacency[pattern].size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'clearPattern',
  inputs: {},
  options: {},
});
if (!unorderedMapIteratorSecondTrace.success || unorderedMapIteratorSecondTrace.output !== 0) {
  throw new Error('C++ unordered_map iterator second clear tracing failed: ' + JSON.stringify(unorderedMapIteratorSecondTrace));
}
const unorderedMapIteratorSecondEvents = unorderedMapIteratorSecondTrace.trace.events;
if (!unorderedMapIteratorSecondEvents.some((event) =>
  event.kind === 'mutate' &&
  event.target?.variable === 'adjacency' &&
  JSON.stringify(event.target.path) === JSON.stringify(['h*t']) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['pattern']) &&
  event.method === 'clear' &&
  JSON.stringify(event.args) === JSON.stringify([])
)) {
  throw new Error('C++ unordered_map iterator second clear should emit keyed mutate args and provenance, received ' + JSON.stringify(unorderedMapIteratorSecondEvents));
}

const unorderedMapStringVectorTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  vector<vector<string>> group(vector<string>& strs) {',
    '    unordered_map<string, vector<string>> groups;',
    '    for (const std::string& s : strs) {',
    '      string key = s;',
    '      sort(key.begin(), key.end());',
    '      groups[key].push_back(s);',
    '    }',
    '    vector<vector<string>> out;',
    '    for (auto& [key, values] : groups) out.push_back(values);',
    '    return out;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'group',
  inputs: { strs: ['eat'] },
  options: {},
});
if (!unorderedMapStringVectorTrace.success || JSON.stringify(unorderedMapStringVectorTrace.output) !== JSON.stringify([['eat']])) {
  throw new Error('C++ unordered_map<string, vector<string>> tracing failed: ' + JSON.stringify(unorderedMapStringVectorTrace));
}
const unorderedMapStringVectorEvents = unorderedMapStringVectorTrace.trace.events;
if (!unorderedMapStringVectorEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 8 &&
  event.target?.variable === 'groups' &&
  event.target.path?.[0] === 'aet' &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['key']) &&
  event.method === 'push_back' &&
  JSON.stringify(event.args) === JSON.stringify(['eat'])
)) {
  throw new Error('C++ groups[key].push_back(s) should emit keyed mutation args and key provenance, received ' + JSON.stringify(unorderedMapStringVectorEvents));
}
if (!unorderedMapStringVectorEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 5 &&
  event.target?.variable === 'strs' &&
  JSON.stringify(event.target.path) === JSON.stringify([0]) &&
  event.binding?.kind === 'iteration' &&
  event.binding?.variable === 's' &&
  event.value === 'eat'
)) {
  throw new Error('C++ const string reference range-for should emit source element binding provenance, received ' + JSON.stringify(unorderedMapStringVectorEvents));
}

const auditAggregatePushBackTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    '  struct Edge { int u; int v; double w; };',
    'public:',
    '  int build() {',
    '    unordered_map<string, int> ids;',
    '    ids["USD"] = 0;',
    '    ids["EUR"] = 1;',
    '    auto itU = ids.find("USD");',
    '    auto itV = ids.find("EUR");',
    '    double rate = 2.0;',
    '    vector<Edge> edges;',
    '    edges.push_back({itU->second, itV->second, -std::log(rate)});',
    '    return edges.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'build',
  inputs: {},
  options: {},
});
if (!auditAggregatePushBackTrace.success || auditAggregatePushBackTrace.output !== 1) {
  throw new Error('C++ aggregate push_back tracing failed: ' + JSON.stringify(auditAggregatePushBackTrace));
}
const auditAggregatePushBackEvents = auditAggregatePushBackTrace.trace.events;
const auditAggregatePushBackMutate = auditAggregatePushBackEvents.find((event) =>
  event.kind === 'mutate' &&
  event.line === 12 &&
  event.target?.variable === 'edges' &&
  event.method === 'push_back'
);
if (
  !auditAggregatePushBackMutate ||
  auditAggregatePushBackMutate.args?.[0] !== 0 ||
  auditAggregatePushBackMutate.args?.[1] !== 1 ||
  Math.abs(auditAggregatePushBackMutate.args?.[2] + Math.log(2)) > 0.00001
) {
  throw new Error('C++ aggregate push_back should emit evaluated aggregate args, received ' + JSON.stringify(auditAggregatePushBackEvents));
}

const auditStructuredVectorRangeTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int sumEdges() {',
    '    vector<tuple<int, int, int>> edges;',
    '    edges.push_back({1, 2, 3});',
    '    int total = 0;',
    '    for (auto& [u, v, w] : edges) {',
    '      total += u + v + w;',
    '    }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'sumEdges',
  inputs: {},
  options: {},
});
if (!auditStructuredVectorRangeTrace.success || auditStructuredVectorRangeTrace.output !== 6) {
  throw new Error('C++ structured vector range tracing failed: ' + JSON.stringify(auditStructuredVectorRangeTrace));
}
const auditStructuredVectorRangeEvents = auditStructuredVectorRangeTrace.trace.events;
if (!auditStructuredVectorRangeEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 7 &&
  event.target?.variable === 'edges' &&
  JSON.stringify(event.target.path) === JSON.stringify([0]) &&
  event.binding?.kind === 'iteration' &&
  event.binding?.variable === 'u,v,w' &&
  JSON.stringify(event.value) === JSON.stringify([1, 2, 3])
)) {
  throw new Error('C++ structured vector range-for should emit source element binding provenance, received ' + JSON.stringify(auditStructuredVectorRangeEvents));
}

const auditStringPointerIndexedTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  string shortestAt(vector<string>& strs, int i) {',
    '    const string* shortest = nullptr;',
    '    for (const auto& s : strs) {',
    '      if (!shortest || s.size() < shortest->size()) shortest = &s;',
    '    }',
    '    return string(1, (*shortest)[i]);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'shortestAt',
  inputs: { strs: ['pear', 'plum', 'fig'], i: 1 },
  options: {},
});
if (!auditStringPointerIndexedTrace.success || auditStringPointerIndexedTrace.output !== 'i') {
  throw new Error('C++ string pointer indexed tracing failed: ' + JSON.stringify(auditStringPointerIndexedTrace));
}
const auditStringPointerIndexedEvents = auditStringPointerIndexedTrace.trace.events;
if (!auditStringPointerIndexedEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 8 &&
  event.target?.variable === 'shortest' &&
  JSON.stringify(event.target.path) === JSON.stringify([1]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['i']) &&
  event.value === 'i'
)) {
  throw new Error('C++ (*stringPointer)[i] should emit indexed read provenance, received ' + JSON.stringify(auditStringPointerIndexedEvents));
}

const unorderedMapSetTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int build() {',
    '    unordered_map<char, unordered_set<char>> graph;',
    '    char from = \'a\';',
    '    char to = \'b\';',
    '    graph[from].insert(to);',
    '    return graph[from].count(to);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'build',
  inputs: {},
  options: {},
});
if (!unorderedMapSetTrace.success || unorderedMapSetTrace.output !== 1) {
  throw new Error('C++ unordered_map<unordered_set> tracing failed: ' + JSON.stringify(unorderedMapSetTrace));
}
const unorderedMapSetEvents = unorderedMapSetTrace.trace.events;
if (!unorderedMapSetEvents.some((event) =>
  event.kind === 'mutate' &&
  event.target?.variable === 'graph' &&
  event.target.path?.[0] === 'a' &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['from']) &&
  event.method === 'insert' &&
  JSON.stringify(event.args) === JSON.stringify(['b'])
)) {
  throw new Error('C++ unordered_map<unordered_set> insert should emit mutation args, received ' + JSON.stringify(unorderedMapSetEvents));
}

const unorderedMapSetIndexedKeyTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int build(vector<string>& words) {',
    '    unordered_map<char, unordered_set<char>> graph;',
    '    int i = 0;',
    '    int j = 1;',
    '    string w1 = words[i];',
    '    string w2 = words[i + 1];',
    '    graph[w1[j]].insert(w2[j]);',
    '    return graph[w1[j]].count(w2[j]);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'build',
  inputs: { words: ['ab', 'ac'] },
  options: {},
});
if (!unorderedMapSetIndexedKeyTrace.success || unorderedMapSetIndexedKeyTrace.output !== 1) {
  throw new Error('C++ unordered_map<unordered_set> indexed key tracing failed: ' + JSON.stringify(unorderedMapSetIndexedKeyTrace));
}
const unorderedMapSetIndexedKeyEvents = unorderedMapSetIndexedKeyTrace.trace.events;
if (!unorderedMapSetIndexedKeyEvents.some((event) =>
  event.kind === 'mutate' &&
  event.target?.variable === 'graph' &&
  event.target.path?.[0] === 'b' &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['w1[j]']) &&
  event.method === 'insert' &&
  JSON.stringify(event.args) === JSON.stringify(['c'])
)) {
  throw new Error('C++ unordered_map<unordered_set> insert should preserve indexed key provenance, received ' + JSON.stringify(unorderedMapSetIndexedKeyEvents));
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

const keyedMutationContractTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int count(string text) {',
    '    unordered_map<char, int> need;',
    "    char ch = text[0];",
    '    need[ch]++;',
    '    need[ch]--;',
    '    need.erase(ch);',
    '    return (int)need.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'count',
  inputs: { text: 'ab' },
  options: {},
});
if (!keyedMutationContractTrace.success || keyedMutationContractTrace.output !== 0) {
  throw new Error('C++ keyed mutation contract tracing failed: ' + JSON.stringify(keyedMutationContractTrace));
}
const keyedMutationContractEvents = keyedMutationContractTrace.trace.events;
for (const [line, method] of [[6, 'increment'], [7, 'decrement']]) {
  if (!keyedMutationContractEvents.some((event) =>
    event.kind === 'mutate' &&
    event.line === line &&
    event.target?.variable === 'need' &&
    event.target.path?.[0] === 'a' &&
    JSON.stringify(event.target.indexSources) === JSON.stringify(['ch']) &&
    event.method === method &&
    JSON.stringify(event.args) === JSON.stringify([])
  )) {
    throw new Error('C++ unordered_map ' + method + ' should emit keyed target, indexSources, and empty args, received ' + JSON.stringify(keyedMutationContractEvents));
  }
}
if (!keyedMutationContractEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 8 &&
  event.target?.variable === 'need' &&
  event.target.path?.[0] === 'a' &&
  event.method === 'erase' &&
  JSON.stringify(event.args) === JSON.stringify(['a'])
)) {
  throw new Error('C++ unordered_map erase should emit keyed target and evaluated args, received ' + JSON.stringify(keyedMutationContractEvents));
}

const triePointerFieldReadTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    '  struct TrieNode { unordered_map<char, TrieNode*> children; };',
    'public:',
    '  int walk(string word) {',
    '    TrieNode* root = new TrieNode();',
    '    TrieNode* child = new TrieNode();',
    '    char ch = word[0];',
    '    root->children[ch] = child;',
    '    TrieNode* node = root;',
    '    node = node->children[ch];',
    '    return node == child ? 1 : 0;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'walk',
  inputs: { word: 'a' },
  options: {},
});
if (!triePointerFieldReadTrace.success || triePointerFieldReadTrace.output !== 1) {
  throw new Error('C++ trie pointer field read tracing failed: ' + JSON.stringify(triePointerFieldReadTrace));
}
const triePointerFieldReadEvents = triePointerFieldReadTrace.trace.events;
if (!triePointerFieldReadEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 10 &&
  event.target?.variable === 'node' &&
  JSON.stringify(event.target.path) === JSON.stringify(['children', 'a']) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify([null, 'ch'])
)) {
  throw new Error('C++ pointer field keyed read assignment should emit concrete read target and indexSources, received ' + JSON.stringify(triePointerFieldReadEvents));
}
if (!triePointerFieldReadEvents.some((event) =>
  event.kind === 'write' &&
  event.line === 10 &&
  event.target?.variable === 'node'
)) {
  throw new Error('C++ pointer field keyed read assignment should emit scalar pointer write, received ' + JSON.stringify(triePointerFieldReadEvents));
}
if (!triePointerFieldReadEvents.some((event) =>
  event.kind === 'snapshot' &&
  event.line === 9 &&
  event.target?.variable === 'node' &&
  event.value?.__type__ === 'TrieNode'
)) {
  throw new Error('C++ TrieNode pointer aliases should emit object snapshots, received ' + JSON.stringify(triePointerFieldReadEvents));
}

const orderedMapBoundsTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  bool book(vector<vector<int>>& requests) {',
    '    map<int, int> bookings;',
    '    for (auto& request : requests) {',
    '      int start = request[0];',
    '      int end = request[1];',
    '      auto next = bookings.lower_bound(start);',
    '      if (next != bookings.end() && next->first < end) return false;',
    '      if (next != bookings.begin()) {',
    '        auto prevIt = next;',
    '        --prevIt;',
    '        if (prevIt->second > start) return false;',
    '      }',
    '      bookings[start] = end;',
    '    }',
    '    return true;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'book',
  inputs: { requests: [[10, 20], [20, 30], [15, 25]] },
  options: {},
});
if (!orderedMapBoundsTrace.success || orderedMapBoundsTrace.output !== false) {
  throw new Error('C++ map lower_bound tracing failed: ' + JSON.stringify(orderedMapBoundsTrace));
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
if (!nestedEvents.some((event) => event.kind === 'read' && event.target?.variable === 'dp' && JSON.stringify(event.target.indexSources) === JSON.stringify(['row - 1', 'col']))) {
  throw new Error('C++ nested vector reads should emit nested indexSources, received ' + JSON.stringify(nestedEvents));
}
if (!nestedEvents.some((event) => event.kind === 'write' && event.target?.variable === 'dp' && JSON.stringify(event.target.indexSources) === JSON.stringify(['row', 'col']))) {
  throw new Error('C++ nested vector writes should emit nested indexSources, received ' + JSON.stringify(nestedEvents));
}

const expressionIndexSourceTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int best(vector<int>& dp, int a, int coin) {',
    '    return dp[a - coin] + 1;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'best',
  inputs: { dp: [0, 4, 8, 15], a: 3, coin: 1 },
  options: {},
});
if (!expressionIndexSourceTrace.success || expressionIndexSourceTrace.output !== 9) {
  throw new Error('C++ expression index-source tracing failed: ' + JSON.stringify(expressionIndexSourceTrace));
}
const expressionIndexSourceEvents = expressionIndexSourceTrace.trace.events;
if (!expressionIndexSourceEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 4 &&
  event.target?.variable === 'dp' &&
  JSON.stringify(event.target.path) === JSON.stringify([2]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['a - coin']) &&
  event.value === 8
)) {
  throw new Error('C++ expression index reads should emit source expression provenance, received ' + JSON.stringify(expressionIndexSourceEvents));
}

const conditionExpressionIndexSourceTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  bool canUse(vector<int>& dp, int a, int coin) {',
    '    if (coin <= a && dp[a - coin] != 999) {',
    '      return true;',
    '    }',
    '    return false;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'canUse',
  inputs: { dp: [0, 4, 8, 15], a: 3, coin: 1 },
  options: {},
});
if (!conditionExpressionIndexSourceTrace.success || conditionExpressionIndexSourceTrace.output !== true) {
  throw new Error('C++ condition expression index-source tracing failed: ' + JSON.stringify(conditionExpressionIndexSourceTrace));
}
const conditionExpressionIndexSourceEvents = conditionExpressionIndexSourceTrace.trace.events;
if (!conditionExpressionIndexSourceEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 4 &&
  event.target?.variable === 'dp' &&
  JSON.stringify(event.target.path) === JSON.stringify([2]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['a - coin']) &&
  event.value === 8
)) {
  throw new Error('C++ condition expression index reads should emit source expression provenance, received ' + JSON.stringify(conditionExpressionIndexSourceEvents));
}

const lambdaNestedVectorTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int flood(vector<vector<char>>& grid) {',
    '    int rows = grid.size();',
    '    int cols = grid[0].size();',
    '    auto dfs = [&](auto& self, int r, int c) -> void {',
    "      if (r < 0 || r >= rows || c < 0 || c >= cols || grid[r][c] != '1') return;",
    "      grid[r][c] = '0';",
    '    };',
    '    dfs(dfs, 0, 0);',
    "    return grid[0][0] == '0' ? 1 : 0;",
    '  }',
    '};',
  ].join('\n'),
  functionName: 'flood',
  inputs: { grid: [['1']] },
  options: {},
});
if (!lambdaNestedVectorTrace.success || lambdaNestedVectorTrace.output !== 1) {
  throw new Error('C++ lambda nested vector tracing failed: ' + JSON.stringify(lambdaNestedVectorTrace));
}
const lambdaNestedEvents = lambdaNestedVectorTrace.trace.events;
if (!lambdaNestedEvents.some((event) => event.kind === 'read' && event.line === 7 && event.target?.variable === 'grid' && JSON.stringify(event.target.indexSources) === JSON.stringify(['r', 'c']))) {
  throw new Error('C++ lambda captured nested vector read should emit indexSources, received ' + JSON.stringify(lambdaNestedEvents));
}
if (!lambdaNestedEvents.some((event) => event.kind === 'write' && event.line === 8 && event.target?.variable === 'grid' && JSON.stringify(event.target.indexSources) === JSON.stringify(['r', 'c']))) {
  throw new Error('C++ lambda captured nested vector write should emit indexSources, received ' + JSON.stringify(lambdaNestedEvents));
}

const indexedRangeForTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int sumNext(vector<vector<int>>& graph, int node) {',
    '    int total = 0;',
    '    for (int next : graph[node]) {',
    '      total += next;',
    '    }',
    '    return total;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'sumNext',
  inputs: { graph: [[1], [2, 3]], node: 1 },
  options: {},
});
if (!indexedRangeForTrace.success || indexedRangeForTrace.output !== 5) {
  throw new Error('C++ indexed range-for tracing failed: ' + JSON.stringify(indexedRangeForTrace));
}
const indexedRangeForEvents = indexedRangeForTrace.trace.events;
if (!indexedRangeForEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 5 &&
  event.target?.variable === 'graph' &&
  JSON.stringify(event.target.path) === JSON.stringify([1, 0]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['node', null]) &&
  event.binding?.kind === 'iteration' &&
  event.binding?.variable === 'next' &&
  event.value === 2
)) {
  throw new Error('C++ indexed range-for should emit first element binding provenance, received ' + JSON.stringify(indexedRangeForEvents));
}

const structuredMapRangeForTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int init() {',
    '    unordered_map<char, int> adj;',
    "    adj['z'] = 3;",
    '    unordered_map<char, int> inDegree;',
    '    for (const auto& [ch, _] : adj) {',
    '      inDegree[ch] = 0;',
    '    }',
    "    return inDegree['z'];",
    '  }',
    '};',
  ].join('\n'),
  functionName: 'init',
  inputs: {},
  options: {},
});
if (!structuredMapRangeForTrace.success || structuredMapRangeForTrace.output !== 0) {
  throw new Error('C++ structured map range-for tracing failed: ' + JSON.stringify(structuredMapRangeForTrace));
}
const structuredMapRangeForEvents = structuredMapRangeForTrace.trace.events;
if (!structuredMapRangeForEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 7 &&
  event.target?.variable === 'adj' &&
  event.target.path?.[0] === 'z' &&
  event.binding?.kind === 'iteration' &&
  event.binding?.variable === 'ch' &&
  event.value === 3
)) {
  throw new Error('C++ structured map range-for should emit key binding provenance, received ' + JSON.stringify(structuredMapRangeForEvents));
}
if (structuredMapRangeForEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 7 &&
  event.binding?.kind === 'iteration' &&
  event.binding?.variable === '_'
)) {
  throw new Error('C++ structured map range-for should not emit underscore binding provenance, received ' + JSON.stringify(structuredMapRangeForEvents));
}

const structuredMapValueBindingTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int init() {',
    '    unordered_map<char, unordered_set<char>> adj;',
    "    adj['a'].insert('b');",
    '    unordered_map<char, int> inDegree;',
    '    for (const auto& [ch, neighbors] : adj) {',
    '      inDegree[ch] = 0;',
    '      for (char neighbor : neighbors) inDegree[neighbor]++;',
    '    }',
    "    return inDegree['a'] + inDegree['b'];",
    '  }',
    '};',
  ].join('\n'),
  functionName: 'init',
  inputs: {},
  options: {},
});
if (!structuredMapValueBindingTrace.success || structuredMapValueBindingTrace.output !== 1) {
  throw new Error('C++ structured map value binding tracing failed: ' + JSON.stringify(structuredMapValueBindingTrace));
}
const structuredMapValueBindingEvents = structuredMapValueBindingTrace.trace.events;
if (!structuredMapValueBindingEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 7 &&
  event.target?.variable === 'adj' &&
  event.target.path?.[0] === 'a' &&
  event.binding?.kind === 'iteration' &&
  event.binding?.variable === 'neighbors' &&
  JSON.stringify(event.value) === JSON.stringify(['b'])
)) {
  throw new Error('C++ structured map range-for should emit value binding provenance, received ' + JSON.stringify(structuredMapValueBindingEvents));
}
if (!structuredMapValueBindingEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 8 &&
  event.target?.variable === 'inDegree' &&
  event.target.path?.[0] === 'a' &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['ch']) &&
  event.method === 'set'
)) {
  throw new Error('C++ map assignment should emit keyed set mutation, received ' + JSON.stringify(structuredMapValueBindingEvents));
}
if (!structuredMapValueBindingEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 9 &&
  event.target?.variable === 'inDegree' &&
  event.target.path?.[0] === 'b' &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['neighbor']) &&
  event.method === 'increment'
)) {
  throw new Error('C++ map increment should emit keyed increment mutation, received ' + JSON.stringify(structuredMapValueBindingEvents));
}

const orderedStructuredMapGroupingTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    '  map<string, int> parent;',
    'public:',
    '  int group() {',
    '    parent["alice@mail.com"] = 0;',
    '    parent["bob@mail.com"] = 0;',
    '    map<string, set<string>> groups;',
    '    string root = "team";',
    '    for (auto& [email, _] : parent) {',
    '      groups[root].insert(email);',
    '    }',
    '    return (int)groups[root].size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'group',
  inputs: {},
  options: {},
});
if (!orderedStructuredMapGroupingTrace.success || orderedStructuredMapGroupingTrace.output !== 2) {
  throw new Error('C++ ordered structured map grouping failed: ' + JSON.stringify(orderedStructuredMapGroupingTrace));
}
const orderedStructuredMapGroupingEvents = orderedStructuredMapGroupingTrace.trace.events;
if (!orderedStructuredMapGroupingEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 9 &&
  event.target?.variable === 'this' &&
  event.target.path?.[0] === 'parent' &&
  event.target.path?.[1] === 'alice@mail.com' &&
  event.binding?.kind === 'iteration' &&
  event.binding?.variable === 'email' &&
  event.value === 0
)) {
  throw new Error('C++ ordered structured map range-for should emit key binding provenance, received ' + JSON.stringify(orderedStructuredMapGroupingEvents));
}
if (!orderedStructuredMapGroupingEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 10 &&
  event.target?.variable === 'groups' &&
  event.target.path?.[0] === 'team' &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['root']) &&
  event.method === 'insert' &&
  JSON.stringify(event.args) === JSON.stringify(['alice@mail.com'])
)) {
  throw new Error('C++ map<set> insert should emit keyed mutation args for grouped email, received ' + JSON.stringify(orderedStructuredMapGroupingEvents));
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
if (!controlFormEvents.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && event.target.path?.[0] === 0)) {
  throw new Error('C++ range-for over vector should emit indexed reads for the source vector, received ' + JSON.stringify(controlFormEvents));
}
if (!controlFormEvents.some((event) => event.kind === 'return' && event.function === 'classify' && event.value === -1)) {
  throw new Error('C++ braced helper return should emit return value, received ' + JSON.stringify(controlFormEvents));
}
if (!controlFormEvents.some((event) => event.kind === 'return' && event.function === 'classify' && event.value === 0)) {
  throw new Error('C++ else-if helper return should emit return value, received ' + JSON.stringify(controlFormEvents));
}
if (controlFormEvents.some((event) => event.kind === 'control')) {
  throw new Error('C++ should not emit language-specific control events, received ' + JSON.stringify(controlFormEvents));
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

const voidLambdaTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  vector<vector<int>> cloneGraph(vector<vector<int>>& adjList) {',
    '    int n = adjList.size();',
    '    vector<vector<int>> cloned(n);',
    '    vector<bool> visited(n, false);',
    '    function<void(int)> dfs = [&](int nodeIdx) {',
    '      if (visited[nodeIdx]) {',
    '        return;',
    '      }',
    '      visited[nodeIdx] = true;',
    '      for (int neighborVal : adjList[nodeIdx]) {',
    '        cloned[nodeIdx].push_back(neighborVal);',
    '        int neighborIdx = neighborVal - 1;',
    '        if (!visited[neighborIdx]) {',
    '          dfs(neighborIdx);',
    '        }',
    '      }',
    '    };',
    '    dfs(0);',
    '    return cloned;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'cloneGraph',
  inputs: { adjList: [[2], [1]] },
  options: {},
});
if (!voidLambdaTrace.success || JSON.stringify(voidLambdaTrace.output) !== JSON.stringify([[2], [1]])) {
  throw new Error('C++ void lambda tracing failed: ' + JSON.stringify(voidLambdaTrace));
}
const voidLambdaEvents = voidLambdaTrace.trace.events;
if (!voidLambdaEvents.some((event) => event.kind === 'return' && event.function === 'dfs')) {
  throw new Error('C++ std::function<void(...)> lambda should emit normal-exit return events, received ' + JSON.stringify(voidLambdaEvents));
}
if (!voidLambdaEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 12 &&
  event.target?.variable === 'adjList' &&
  JSON.stringify(event.target.path) === JSON.stringify([0]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['nodeIdx'])
)) {
  throw new Error('C++ nested range-for should emit the outer indexed source read, received ' + JSON.stringify(voidLambdaEvents));
}
if (voidLambdaEvents.some((event) =>
  event.kind === 'line' &&
  event.line === 12 &&
  !event.function
)) {
  throw new Error('C++ range-for synthetic line events should inherit the active function, received ' + JSON.stringify(voidLambdaEvents));
}
const cloneReturnEvent = voidLambdaEvents.find((event) => event.kind === 'return' && event.function === 'cloneGraph' && event.line === 21);
if (!cloneReturnEvent || cloneReturnEvent.callStack?.some((frame) => frame.function === 'dfs')) {
  throw new Error('C++ caller return should not retain completed lambda frames, received ' + JSON.stringify(voidLambdaEvents));
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

const opsClassTrieTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class TrieNode {',
    'public:',
    '  vector<TrieNode*> children;',
    '  bool isEnd;',
    '  TrieNode() : children(26, nullptr), isEnd(false) {}',
    '};',
    'class Trie {',
    '  TrieNode* root;',
    'public:',
    '  Trie() {',
    '    root = new TrieNode();',
    '  }',
    '  void insert(string word) {',
    '    TrieNode* node = root;',
    '    for (char ch : word) {',
    "      int idx = ch - 'a';",
    '      if (node->children[idx] == nullptr) node->children[idx] = new TrieNode();',
    '      node = node->children[idx];',
    '    }',
    '    node->isEnd = true;',
    '  }',
    '  bool search(string word) {',
    '    TrieNode* node = root;',
    '    for (char ch : word) {',
    "      int idx = ch - 'a';",
    '      if (node->children[idx] == nullptr) return false;',
    '      node = node->children[idx];',
    '    }',
    '    return node->isEnd;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'Trie',
  inputs: {
    operations: ['Trie', 'insert', 'search'],
    arguments: [[], ['app'], ['app']],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (!opsClassTrieTrace.success || JSON.stringify(opsClassTrieTrace.output) !== JSON.stringify([null, null, true])) {
  throw new Error('C++ implement-trie ops-class output shape failed: ' + JSON.stringify(opsClassTrieTrace));
}
const opsClassTrieEvents = opsClassTrieTrace.trace.events;
if (!opsClassTrieEvents.some((event) => event.kind === 'call' && event.function === 'insert' && event.args?.word === 'app')) {
  throw new Error('C++ implement-trie ops-class should emit insert call args, received ' + JSON.stringify(opsClassTrieEvents));
}
if (!opsClassTrieEvents.some((event) =>
  event.kind === 'write' &&
  event.line === 11 &&
  event.target?.variable === 'this' &&
  JSON.stringify(event.target.path) === JSON.stringify(['root']) &&
  event.value?.__type__ === 'TrieNode'
)) {
  throw new Error('C++ implement-trie constructor should emit implicit member field write for root, received ' + JSON.stringify(opsClassTrieEvents));
}
if (!opsClassTrieEvents.some((event) =>
  event.kind === 'snapshot' &&
  event.line === 14 &&
  event.target?.variable === 'node' &&
  event.value?.__type__ === 'TrieNode'
)) {
  throw new Error('C++ implement-trie should snapshot TrieNode pointer aliases, received ' + JSON.stringify(opsClassTrieEvents));
}
if (!opsClassTrieEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 14 &&
  event.target?.variable === 'this' &&
  JSON.stringify(event.target.path) === JSON.stringify(['root']) &&
  event.value?.__type__ === 'TrieNode'
)) {
  throw new Error('C++ implement-trie local root alias should emit member read provenance, received ' + JSON.stringify(opsClassTrieEvents));
}
if (!opsClassTrieEvents.some((event) =>
  event.kind === 'write' &&
  event.line === 17 &&
  event.target?.variable === 'node' &&
  JSON.stringify(event.target.path) === JSON.stringify(['children', 0]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify([null, 'idx']) &&
  event.value?.__type__ === 'TrieNode'
)) {
  throw new Error('C++ implement-trie inline child allocation should emit pointer-field write provenance, received ' + JSON.stringify(opsClassTrieEvents));
}

const opsClassLeadingBlockCommentTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    '/**',
    ' * Leading scaffold comment should not shift function signature lines.',
    ' */',
    'class Parser {',
    'public:',
    '  Parser() {}',
    '  int parse(int value) {',
    '    current = value;',
    '    return helper();',
    '  }',
    'private:',
    '  int current = 0;',
    '  int helper() {',
    '    return current;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'Parser',
  inputs: {
    operations: ['Parser', 'parse'],
    arguments: [[], [9]],
  },
  executionStyle: 'ops-class',
  options: {},
});
if (
  !opsClassLeadingBlockCommentTrace.success ||
  JSON.stringify(opsClassLeadingBlockCommentTrace.output) !== JSON.stringify([null, 9])
) {
  throw new Error('C++ ops-class leading block comment tracing failed: ' + JSON.stringify(opsClassLeadingBlockCommentTrace));
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
if (opsClassDiagnostic.errorLine !== 5 || !String(opsClassDiagnostic.error).includes('solution.cpp:5')) {
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

const existingAggregatePushBackTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'struct Edge {',
    '  int u;',
    '  int v;',
    '  double w;',
    '};',
    'class Solution {',
    'public:',
    '  int build() {',
    '    vector<Edge> edges;',
    '    int u = 1;',
    '    int v = 2;',
    '    double rate = 4.0;',
    '    edges.push_back({u, v, -std::log(rate)});',
    '    return edges.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'build',
  inputs: {},
  options: {},
});
if (!existingAggregatePushBackTrace.success || existingAggregatePushBackTrace.output !== 1) {
  throw new Error('C++ aggregate push_back tracing failed: ' + JSON.stringify(existingAggregatePushBackTrace));
}
const existingAggregatePushBackEvents = existingAggregatePushBackTrace.trace.events;
const existingAggregatePushBackMutate = existingAggregatePushBackEvents.find((event) =>
  event.kind === 'mutate' &&
  event.line === 13 &&
  event.target?.variable === 'edges' &&
  event.method === 'push_back'
);
if (!existingAggregatePushBackMutate || existingAggregatePushBackMutate.args?.[0] !== 1 || existingAggregatePushBackMutate.args?.[1] !== 2 || Math.abs(existingAggregatePushBackMutate.args?.[2] + Math.log(4)) > 1e-9) {
  throw new Error('C++ aggregate push_back should emit evaluated mutation args, received ' + JSON.stringify(existingAggregatePushBackEvents));
}

const pointerFieldIndexedConditionTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'struct TrieNode {',
    '  vector<TrieNode*> children;',
    '  TrieNode() : children(26, nullptr) {}',
    '};',
    'class Solution {',
    'public:',
    '  bool check() {',
    '    TrieNode* node = new TrieNode();',
    '    int idx = 2;',
    '    if (node->children[idx] == nullptr) return true;',
    '    return false;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'check',
  inputs: {},
  options: {},
});
if (!pointerFieldIndexedConditionTrace.success || pointerFieldIndexedConditionTrace.output !== true) {
  throw new Error('C++ pointer field indexed condition tracing failed: ' + JSON.stringify(pointerFieldIndexedConditionTrace));
}
const pointerFieldEvents = pointerFieldIndexedConditionTrace.trace.events;
if (!pointerFieldEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 10 &&
  event.target?.variable === 'node' &&
  JSON.stringify(event.target.path) === JSON.stringify(['children', 2]) &&
  JSON.stringify(event.target.indexSources) === JSON.stringify([null, 'idx'])
)) {
  throw new Error('C++ pointer field indexed condition should emit children[idx] read, received ' + JSON.stringify(pointerFieldEvents));
}

const addressOfIndexedReadTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int lcp(vector<string>& strs) {',
    '    string* first = &strs[0];',
    '    int shortest = first->size();',
    '    if (strs[1].size() < shortest) shortest = strs[1].size();',
    '    return shortest;',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'lcp',
  inputs: { strs: ['flower', 'flow'] },
  options: {},
});
if (!addressOfIndexedReadTrace.success || addressOfIndexedReadTrace.output !== 4) {
  throw new Error('C++ address-of indexed read tracing failed: ' + JSON.stringify(addressOfIndexedReadTrace));
}
const addressOfEvents = addressOfIndexedReadTrace.trace.events;
if (!addressOfEvents.some((event) => event.kind === 'read' && event.line === 4 && event.target?.variable === 'strs' && event.target.path?.[0] === 0)) {
  throw new Error('C++ &strs[0] should emit indexed read, received ' + JSON.stringify(addressOfEvents));
}
if (!addressOfEvents.some((event) => event.kind === 'write' && event.line === 6 && event.target?.variable === 'shortest' && event.value === 4)) {
  throw new Error('C++ shortest scalar update should emit write, received ' + JSON.stringify(addressOfEvents));
}

const setEraseArgsTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int solve() {',
    '    unordered_set<int> cols;',
    '    int col = 3;',
    '    cols.insert(col);',
    '    cols.erase(col);',
    '    return cols.size();',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'solve',
  inputs: {},
  options: {},
});
if (!setEraseArgsTrace.success || setEraseArgsTrace.output !== 0) {
  throw new Error('C++ set erase tracing failed: ' + JSON.stringify(setEraseArgsTrace));
}
const setEraseEvents = setEraseArgsTrace.trace.events;
if (!setEraseEvents.some((event) =>
  event.kind === 'mutate' &&
  event.line === 7 &&
  event.target?.variable === 'cols' &&
  event.method === 'erase' &&
  JSON.stringify(event.args) === JSON.stringify([3])
)) {
  throw new Error('C++ set erase should emit key args, received ' + JSON.stringify(setEraseEvents));
}

const nativeSetFindGuardTrace = await sandbox.__tracecodeCppTest.handleExecuteWithTracing({
  code: [
    'class Solution {',
    'public:',
    '  int visit() {',
    '    function<int(int, std::unordered_set<int>&)> dfs = [&](int v, std::unordered_set<int>& visited) {',
    '      if (visited.find(v) != visited.end()) return 1;',
    '      visited.insert(v);',
    '      return 0;',
    '    };',
    '    unordered_set<int> visited;',
    '    visited.insert(7);',
    '    return dfs(7, visited);',
    '  }',
    '};',
  ].join('\n'),
  functionName: 'visit',
  inputs: {},
  options: {},
});
if (!nativeSetFindGuardTrace.success || nativeSetFindGuardTrace.output !== 1) {
  throw new Error('C++ native set find guard tracing failed: ' + JSON.stringify(nativeSetFindGuardTrace));
}
const nativeSetFindEvents = nativeSetFindGuardTrace.trace.events;
if (!nativeSetFindEvents.some((event) =>
  event.kind === 'read' &&
  event.line === 5 &&
  event.target?.variable === 'visited' &&
  event.target.path?.[0] === 7 &&
  event.value === true &&
  JSON.stringify(event.target.indexSources) === JSON.stringify(['v'])
)) {
  throw new Error('C++ native set find guard should emit lookup read, received ' + JSON.stringify(nativeSetFindEvents));
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
