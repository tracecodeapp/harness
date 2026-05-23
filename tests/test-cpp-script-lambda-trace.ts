#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

type RuntimeTraceEvent = {
  kind?: string;
  function?: string;
  target?: {
    variable?: string;
    path?: unknown[];
  };
  value?: unknown;
};

async function createCppWorkerHarness() {
  const sharedKernelPolicySource = (await readFile('workers/shared/runtime-kernel-policy.js', 'utf8'))
    .replace(/\bexport\s+/g, '');
  const workerSource = (await readFile('workers/cpp/cpp-worker.js', 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/,
    ''
  );
  const compilerBundle = await import(pathToFileURL(`${process.cwd()}/node_modules/@yowasp/clang/gen/bundle.js`).href);
  const readAsset = async (url: string) => {
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
    postMessage: () => {},
    fetch: readAsset,
    crypto: globalThis.crypto,
    __tracecodeCppCompilerBundle: compilerBundle,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const script = new vm.Script(
    sharedKernelPolicySource + '\n' +
      'const isRuntimeDeviceDirectory = isRuntimeKernelDeviceDirectory;\n' +
      'const isRuntimeDeviceNamespacePath = isRuntimeKernelDeviceNamespacePath;\n' +
      'const isRuntimeProcPath = isRuntimeKernelProcPath;\n' +
      workerSource +
      '\nglobalThis.__tracecodeCppScriptLambdaTest = { handleInit, handleExecuteWithTracing };',
    {
      importModuleDynamically(specifier) {
        return import(String(specifier));
      },
    }
  );
  await script.runInContext(context);

  const bridge = sandbox.__tracecodeCppScriptLambdaTest as {
    handleInit: (payload: unknown) => Promise<{ success: boolean; error?: string }>;
    handleExecuteWithTracing: (payload: unknown) => Promise<{
      success: boolean;
      error?: string;
      output?: unknown;
      trace?: { events?: RuntimeTraceEvent[] };
    }>;
  };
  assert.ok(bridge, 'C++ worker bridge did not initialize');

  const init = await bridge.handleInit({
    assets: {
      compilerBundleUrl: pathToFileURL(`${process.cwd()}/node_modules/@yowasp/clang/gen/bundle.js`).href,
      clangWasmUrl: 'file:///missing/clang.wasm',
      lldWasmUrl: 'file:///missing/lld.wasm',
      sysrootUrl: 'file:///missing/sysroot.tar',
      runtimeHeaderUrl: pathToFileURL(`${process.cwd()}/workers/cpp/tracecode_runtime.hpp`).href,
    },
  });
  assert.equal(init.success, true, `C++ worker init failed: ${init.error ?? 'unknown error'}`);

  return bridge;
}

const code = [
  'function<bool(vector<string>)> two_pointers_converging;',
  'two_pointers_converging = [&]( vector<string> arr ) -> bool {',
  '    if (arr.empty()) {',
  '        return true;',
  '    }',
  '    int left = 0;',
  '    int right = arr.size() - 1;',
  '',
  '    while (left < right) {',
  '        if (arr[left] != arr[right]) {',
  '            return false;',
  '        }',
  '        left++;',
  '        right--;',
  '    }',
  '    return true;',
  '};',
  'auto result = two_pointers_converging(vector<string>{"r", "a", "c", "e", "c", "a", "r"});',
].join('\n');

const harness = await createCppWorkerHarness();
const result = await harness.handleExecuteWithTracing({
  code,
  functionName: '',
  inputs: {},
  executionStyle: 'function',
  options: { maxTraceSteps: 1000, maxLineEvents: 2000 },
});

assert.equal(result.success, true, `C++ script lambda trace failed: ${result.error ?? 'unknown error'}`);
assert.equal(result.output, true, 'C++ script lambda should return true');

const events = result.trace?.events ?? [];
assert.ok(events.some((event) => event.kind === 'line'), 'C++ script lambda should emit line events');
assert.ok(events.some((event) => event.kind === 'call' && String(event.function || '').startsWith('<lambda:')), 'C++ script lambda should emit a lambda call event');

const snapshots = events.filter((event) => event.kind === 'snapshot');
const snapshotValues = (sourceEvents: RuntimeTraceEvent[], name: string) =>
  sourceEvents
    .filter((event) => event.kind === 'snapshot')
    .filter((event) => event.target?.variable === name && !event.target.path?.length)
    .map((event) => event.value);

assert.ok(
  snapshotValues(events, 'arr').some((value) => JSON.stringify(value) === JSON.stringify(['r', 'a', 'c', 'e', 'c', 'a', 'r'])),
  `C++ script lambda should snapshot the vector parameter, received ${JSON.stringify(snapshots)}`
);
assert.ok(
  snapshotValues(events, 'left').some((value) => value === 0),
  `C++ script lambda should snapshot local variable left, received ${JSON.stringify(snapshots)}`
);
assert.ok(
  snapshotValues(events, 'right').some((value) => value === 6),
  `C++ script lambda should snapshot local variable right, received ${JSON.stringify(snapshots)}`
);

const maxSumCode = [
  'function<int(vector<int>, int)> maxSumSubarray;',
  'maxSumSubarray = [&]( vector<int> nums, int k ) -> int {',
  '    int window_sum = accumulate(nums.begin(), nums.begin() + k, 0);',
  '    auto max_sum = window_sum;',
  '',
  '    for (int i = k; i < nums.size(); i++) {',
  '        window_sum += nums[i] - nums[i - k];',
  '        max_sum = max(max_sum, window_sum);',
  '    }',
  '    return max_sum;',
  '};',
  'auto result = maxSumSubarray(vector<int>{2, 1, 5, 1, 3, 2}, 3);',
].join('\n');

const maxSumResult = await harness.handleExecuteWithTracing({
  code: maxSumCode,
  functionName: '',
  inputs: {},
  executionStyle: 'function',
  options: { maxTraceSteps: 1000, maxLineEvents: 2000 },
});

assert.equal(maxSumResult.success, true, `C++ max-sum script lambda trace failed: ${maxSumResult.error ?? 'unknown error'}`);
assert.equal(maxSumResult.output, 9, 'C++ max-sum script lambda should return 9');

const maxSumEvents = maxSumResult.trace?.events ?? [];
const maxSumSnapshots = maxSumEvents.filter((event) => event.kind === 'snapshot');
assert.ok(
  snapshotValues(maxSumEvents, 'window_sum').some((value) => value === 9),
  `C++ max-sum script lambda should snapshot window_sum updates, received ${JSON.stringify(maxSumSnapshots)}`
);
assert.ok(
  snapshotValues(maxSumEvents, 'max_sum').some((value) => value === 9),
  `C++ max-sum script lambda should snapshot inferred auto local max_sum, received ${JSON.stringify(maxSumSnapshots)}`
);
assert.ok(
  maxSumEvents.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && event.target.path?.[0] === 4 && event.value === 3),
  `C++ max-sum script lambda should emit indexed nums reads, received ${JSON.stringify(maxSumEvents)}`
);

const vectorSumScript = [
  '#include <vector>',
  'vector<int> nums = {1, 2, 3, 4};',
  'int sum = 0;',
  'for (int num : nums) {',
  '    sum += num;',
  '}',
  'int result = sum;',
].join('\n');

const vectorSumResult = await harness.handleExecuteWithTracing({
  code: vectorSumScript,
  functionName: '',
  inputs: {},
  executionStyle: 'function',
  options: { maxTraceSteps: 1000, maxLineEvents: 2000 },
});

assert.equal(vectorSumResult.success, true, `C++ vector-sum script trace failed: ${vectorSumResult.error ?? 'unknown error'}`);
assert.equal(vectorSumResult.output, 10, 'C++ vector-sum script should return 10');

const vectorSumEvents = vectorSumResult.trace?.events ?? [];
assert.ok(
  snapshotValues(vectorSumEvents, 'nums').some((value) => JSON.stringify(value) === JSON.stringify([1, 2, 3, 4])),
  `C++ vector-sum script should snapshot nums, received ${JSON.stringify(vectorSumEvents)}`
);
assert.ok(
  snapshotValues(vectorSumEvents, 'sum').some((value) => value === 10),
  `C++ vector-sum script should snapshot final sum, received ${JSON.stringify(vectorSumEvents)}`
);
assert.ok(
  snapshotValues(vectorSumEvents, 'result').some((value) => value === 10),
  `C++ vector-sum script should snapshot result, received ${JSON.stringify(vectorSumEvents)}`
);

const scriptStructCode = [
  'struct Box {',
  '    vector<int> values;',
  '    Box() {',
  '        values = vector<int>{1, 2, 3};',
  '    }',
  '    int setAndGet(int index, int value) {',
  '        this->values[index] = value;',
  '        return this->values[index];',
  '    }',
  '};',
  'Box box;',
  'int result = box.setAndGet(1, 5);',
].join('\n');

const scriptStructResult = await harness.handleExecuteWithTracing({
  code: scriptStructCode,
  functionName: '',
  inputs: {},
  executionStyle: 'function',
  options: { maxTraceSteps: 1000, maxLineEvents: 2000 },
});

assert.equal(scriptStructResult.success, true, `C++ script struct trace failed: ${scriptStructResult.error ?? 'unknown error'}`);
assert.equal(scriptStructResult.output, 5, 'C++ script struct should return method result');

const scriptStructEvents = scriptStructResult.trace?.events ?? [];
assert.ok(
  scriptStructEvents.some((event) => event.kind === 'call' && event.function === 'setAndGet'),
  `C++ script struct should emit method calls, received ${JSON.stringify(scriptStructEvents)}`
);
assert.ok(
  scriptStructEvents.some((event) => event.kind === 'write' && event.target?.variable === 'this' && event.target.path?.includes('values')),
  `C++ script struct should emit member writes inside methods, received ${JSON.stringify(scriptStructEvents)}`
);
assert.ok(
  scriptStructEvents.some((event) => event.kind === 'read' && event.target?.variable === 'this' && event.target.path?.includes('values') && event.value === 5),
  `C++ script struct should emit member reads inside methods, received ${JSON.stringify(scriptStructEvents)}`
);

const helperScriptCode = [
  'auto tracecodeIntRangeWhere = [](int start, int end, auto predicate) {',
  '    vector<int> values;',
  '    for (int value = start; value < end; value++) if (predicate(value)) values.push_back(value);',
  '    return values;',
  '};',
  'vector<int> nums = vector<int>{0, 1, 2, 3};',
  'vector<int> result = tracecodeIntRangeWhere(0, nums.size(), [&](int i) { return nums[i] % 2 == 0; });',
].join('\n');

const helperScriptResult = await harness.handleExecuteWithTracing({
  code: helperScriptCode,
  functionName: '',
  inputs: {},
  executionStyle: 'function',
  options: { maxTraceSteps: 1000, maxLineEvents: 2000 },
});

assert.equal(helperScriptResult.success, true, `C++ helper script trace failed: ${helperScriptResult.error ?? 'unknown error'}`);
assert.deepEqual(helperScriptResult.output, [0, 2], 'C++ helper script should return filtered values');

const helperScriptEvents = helperScriptResult.trace?.events ?? [];
assert.ok(
  helperScriptEvents.every((event) => event.function !== 'tracecodeIntRangeWhere'),
  `C++ generated helper function should be hidden, received ${JSON.stringify(helperScriptEvents)}`
);
assert.ok(
  helperScriptEvents.every((event) => !event.callStack?.some((frame) => frame.function === 'tracecodeIntRangeWhere')),
  `C++ generated helper call-stack frame should be hidden, received ${JSON.stringify(helperScriptEvents)}`
);

console.log('PASS: C++ script lambda trace snapshots');
