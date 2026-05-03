#!/usr/bin/env npx tsx

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface CSharpResponse {
  success: boolean;
  output?: unknown;
  error?: string;
  diagnostics?: Array<{
    file: string;
    line: number;
    column: number;
    message: string;
    severity: string;
    id: string;
  }>;
  consoleOutput?: string[];
  events?: Array<{ kind: string; line?: number; function?: string; method?: string; value?: unknown; args?: unknown[]; target?: { variable: string; path?: unknown[] } }>;
  executionTimeMs?: number;
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
}

type Execute = (requestJson: string) => string;

const __dirname = dirname(fileURLToPath(import.meta.url));
const spikeRoot = resolve(__dirname, '..');
const projectRoot = resolve(spikeRoot, 'TraceCode.CSharpHost');
const fixtureRoot = resolve(spikeRoot, 'fixtures');

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function findPublishedAssetDir(): string {
  const explicitDir = process.env.CSHARP_WASM_PUBLISH_DIR;
  const candidates = [
    explicitDir,
    join(projectRoot, 'bin', 'Release', 'net8.0', 'browser-wasm', 'AppBundle'),
    join(projectRoot, 'bin', 'Release', 'net8.0', 'browser-wasm', 'publish'),
    join(projectRoot, 'bin', 'Release', 'net8.0', 'browser-wasm', 'publish', 'wwwroot'),
  ].filter(Boolean) as string[];

  const match = candidates.find((candidate) => existsSync(join(candidate, '_framework', 'dotnet.js')));
  if (!match) {
    throw new Error(
      [
        'Unable to find published C# WASM assets.',
        'Run `pnpm run spike:csharp:publish` first, or set CSHARP_WASM_PUBLISH_DIR.',
      ].join('\n')
    );
  }
  return match;
}

async function loadExecuteExport(assetDir: string): Promise<Execute> {
  const dotnetJs = pathToFileURL(join(assetDir, '_framework', 'dotnet.js')).href;
  const { dotnet } = (await import(dotnetJs)) as {
    dotnet: {
      withApplicationArguments(...args: string[]): {
        create(): Promise<{
          getAssemblyExports(assemblyName: string): Promise<Record<string, unknown>>;
          getConfig(): { mainAssemblyName: string };
        }>;
      };
    };
  };

  const runtime = await dotnet.withApplicationArguments('tracecode-csharp-spike').create();
  const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
  const hostNamespace = exports.TraceCode as Record<string, unknown> | undefined;
  const csharpHost = hostNamespace?.CSharpHost as Record<string, unknown> | undefined;
  const compilerHost = csharpHost?.CompilerHost as Record<string, unknown> | undefined;
  const execute = compilerHost?.Execute;

  assertCondition(typeof execute === 'function', 'Unable to resolve TraceCode.CSharpHost.CompilerHost.Execute JS export');
  return execute as Execute;
}

function fixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), 'utf8');
}

function executeCase(
  execute: Execute,
  source: string,
  functionName: string,
  inputs: Record<string, unknown>,
  trace = false,
  options: { timeoutMs?: number; maxTraceSteps?: number } = {}
): CSharpResponse {
  return JSON.parse(execute(JSON.stringify({ source, functionName, inputs, trace, ...options }))) as CSharpResponse;
}

async function main(): Promise<void> {
  const assetDir = findPublishedAssetDir();
  const execute = await loadExecuteExport(assetDir);

  const add = executeCase(execute, fixture('add.cs'), 'Add', { a: 2, b: 3 });
  assertCondition(add.success, `Add should succeed: ${add.error ?? 'unknown error'}`);
  assertCondition(add.output === 5, `Add should return 5, received ${JSON.stringify(add.output)}`);
  assertCondition(
    add.consoleOutput?.includes('adding 2 and 3') === true,
    `Add should capture Console.WriteLine output, received ${JSON.stringify(add.consoleOutput)}`
  );
  console.log(`PASS: C# Add compiled, loaded, invoked, and returned ${add.output}`);

  const tracedAdd = executeCase(
    execute,
    'public class Solution { public int Add(int a, int b) { int sum = a + b; return sum; } }',
    'Add',
    { a: 2, b: 3 },
    true
  );
  assertCondition(tracedAdd.success, `Traced Add should succeed: ${tracedAdd.error ?? 'unknown error'}`);
  assertCondition(
    tracedAdd.events?.some((event) => event.kind === 'call' && event.function === 'Add') === true,
    `Traced Add should include call event, received ${JSON.stringify(tracedAdd.events)}`
  );
  assertCondition(
    tracedAdd.events?.some((event) => event.kind === 'write' && event.target?.variable === 'sum') === true,
    `Traced Add should include local write event, received ${JSON.stringify(tracedAdd.events)}`
  );
  assertCondition(
    tracedAdd.events?.some((event) => event.kind === 'line') === true,
    `Traced Add should include line events, received ${JSON.stringify(tracedAdd.events)}`
  );
  assertCondition(
    tracedAdd.events?.some((event) => event.kind === 'return' && event.function === 'Add' && event.value === 5) === true,
    `Traced Add should include return event with value 5, received ${JSON.stringify(tracedAdd.events)}`
  );
  console.log('PASS: C# tracing returned call, write, line, and return-value events');

  const tracedExpressionBody = executeCase(
    execute,
    'public class Solution { public int Add(int a, int b) => a + b; }',
    'Add',
    { a: 2, b: 3 },
    true
  );
  assertCondition(
    tracedExpressionBody.success,
    `Traced expression-bodied Add should succeed: ${tracedExpressionBody.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedExpressionBody.output === 5,
    `Traced expression-bodied Add should return 5, received ${JSON.stringify(tracedExpressionBody.output)}`
  );
  assertCondition(
    tracedExpressionBody.events?.some((event) => event.kind === 'return' && event.function === 'Add' && event.value === 5) === true,
    `Traced expression-bodied Add should include return value 5, received ${JSON.stringify(tracedExpressionBody.events)}`
  );
  console.log('PASS: C# tracing returned expression-bodied method return-value events');

  const tracedVoidExpressionBody = executeCase(
    execute,
    'using System; public class Solution { public void Log(int value) => Console.WriteLine(value); }',
    'Log',
    { value: 7 },
    true
  );
  assertCondition(
    tracedVoidExpressionBody.success,
    `Traced expression-bodied void method should succeed: ${tracedVoidExpressionBody.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedVoidExpressionBody.output === null,
    `Traced expression-bodied void method should return null output, received ${JSON.stringify(tracedVoidExpressionBody.output)}`
  );
  assertCondition(
    tracedVoidExpressionBody.consoleOutput?.includes('7') === true,
    `Traced expression-bodied void method should capture stdout, received ${JSON.stringify(tracedVoidExpressionBody.consoleOutput)}`
  );
  assertCondition(
    tracedVoidExpressionBody.events?.some((event) => event.kind === 'return' && event.function === 'Log') === true,
    `Traced expression-bodied void method should include return event, received ${JSON.stringify(tracedVoidExpressionBody.events)}`
  );
  console.log('PASS: C# tracing supports expression-bodied void methods');

  const traceLimited = executeCase(
    execute,
    'public class Solution { public int Add(int a, int b) { int sum = a + b; return sum; } }',
    'Add',
    { a: 2, b: 3 },
    true,
    { maxTraceSteps: 2 }
  );
  assertCondition(!traceLimited.success, 'Trace-limited Add should fail');
  assertCondition(traceLimited.traceLimitExceeded === true, 'Trace-limited Add should set traceLimitExceeded');
  assertCondition(traceLimited.timeoutReason === 'trace-limit', 'Trace-limited Add should use trace-limit reason');
  console.log('PASS: C# trace budget stops traced execution');

  const timedOut = executeCase(
    execute,
    'public class Solution { public int Add(int a, int b) { while (true) { a++; } return a + b; } }',
    'Add',
    { a: 2, b: 3 },
    false,
    { timeoutMs: 100 }
  );
  assertCondition(!timedOut.success, 'Infinite loop should fail');
  assertCondition(timedOut.timeoutReason === 'client-timeout', 'Infinite loop should use client-timeout reason');
  console.log('PASS: C# loop timeout checks stop runaway execution');

  const tracedArray = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int AddFirstTwo(int[] nums) {',
      '    int first = nums[0];',
      '    nums[1] = first + nums[1];',
      '    return nums[1];',
      '  }',
      '}',
    ].join('\n'),
    'AddFirstTwo',
    { nums: [2, 3] },
    true
  );
  assertCondition(tracedArray.success, `Traced array case should succeed: ${tracedArray.error ?? 'unknown error'}`);
  assertCondition(tracedArray.output === 5, `Traced array case should return 5, received ${JSON.stringify(tracedArray.output)}`);
  assertCondition(
    tracedArray.events?.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && event.target.path?.[0] === 0) === true,
    `Traced array case should include nums[0] read, received ${JSON.stringify(tracedArray.events)}`
  );
  assertCondition(
    tracedArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 1) === true,
    `Traced array case should include nums[1] write, received ${JSON.stringify(tracedArray.events)}`
  );
  console.log('PASS: C# tracing returned array indexed read/write events');

  const tracedCompoundArray = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int Mutate(int[] nums) {',
      '    nums[0] += 2;',
      '    nums[1]++;',
      '    --nums[1];',
      '    return nums[0] + nums[1];',
      '  }',
      '}',
    ].join('\n'),
    'Mutate',
    { nums: [3, 4] },
    true
  );
  assertCondition(
    tracedCompoundArray.success,
    `Traced compound array case should succeed: ${tracedCompoundArray.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedCompoundArray.output === 9,
    `Traced compound array case should return 9, received ${JSON.stringify(tracedCompoundArray.output)}`
  );
  assertCondition(
    tracedCompoundArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 0 && event.value === 5) === true,
    `Traced compound array case should include nums[0] compound write, received ${JSON.stringify(tracedCompoundArray.events)}`
  );
  assertCondition(
    tracedCompoundArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 1 && event.value === 5) === true,
    `Traced compound array case should include nums[1] increment write, received ${JSON.stringify(tracedCompoundArray.events)}`
  );
  console.log('PASS: C# tracing returned compound array indexed write events');

  const tracedCollections = executeCase(
    execute,
    [
      'using System.Collections.Generic;',
      'public class Solution {',
      '  public int UseCollections(int value) {',
      '    var list = new List<int>();',
      '    list.Add(value);',
      '    list[0] = list[0] + 1;',
      '    var seen = new Dictionary<int, int>();',
      '    seen[value] = list[0];',
      '    return seen[value];',
      '  }',
      '}',
    ].join('\n'),
    'UseCollections',
    { value: 4 },
    true
  );
  assertCondition(tracedCollections.success, `Traced collections case should succeed: ${tracedCollections.error ?? 'unknown error'}`);
  assertCondition(
    tracedCollections.output === 5,
    `Traced collections case should return 5, received ${JSON.stringify(tracedCollections.output)}`
  );
  assertCondition(
    tracedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'list') === true,
    `Traced collections case should include list mutate, received ${JSON.stringify(tracedCollections.events)}`
  );
  assertCondition(
    tracedCollections.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'list') === true,
    `Traced collections case should include list snapshot, received ${JSON.stringify(tracedCollections.events)}`
  );
  assertCondition(
    tracedCollections.events?.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 4) === true,
    `Traced collections case should include dictionary keyed write, received ${JSON.stringify(tracedCollections.events)}`
  );
  console.log('PASS: C# tracing returned List and Dictionary wrapper events');

  const tracedExplicitCollections = executeCase(
    execute,
    [
      'using System.Collections.Generic;',
      'public class Solution {',
      '  public int UseCollections(int value) {',
      '    List<int> list = new List<int>();',
      '    list.Add(value);',
      '    Dictionary<int, int> seen = new Dictionary<int, int>();',
      '    seen[value] = list[0] + 1;',
      '    return seen[value];',
      '  }',
      '}',
    ].join('\n'),
    'UseCollections',
    { value: 4 },
    true
  );
  assertCondition(
    tracedExplicitCollections.success,
    `Traced explicit collections case should succeed: ${tracedExplicitCollections.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedExplicitCollections.output === 5,
    `Traced explicit collections case should return 5, received ${JSON.stringify(tracedExplicitCollections.output)}`
  );
  assertCondition(
    tracedExplicitCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'list') === true,
    `Traced explicit collections case should include list mutate, received ${JSON.stringify(tracedExplicitCollections.events)}`
  );
  assertCondition(
    tracedExplicitCollections.events?.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 4) === true,
    `Traced explicit collections case should include dictionary keyed write, received ${JSON.stringify(tracedExplicitCollections.events)}`
  );
  console.log('PASS: C# tracing returned explicit List and Dictionary declaration wrapper events');

  const tracedInterviewCollections = executeCase(
    execute,
    [
      'using System.Collections.Generic;',
      'public class Solution {',
      '  public int UseMoreCollections(int value) {',
      '    HashSet<int> set = new HashSet<int>();',
      '    set.Add(value);',
      '    var queue = new Queue<int>();',
      '    queue.Enqueue(value + 1);',
      '    int front = queue.Dequeue();',
      '    Stack<int> stack = new Stack<int>();',
      '    stack.Push(front + (set.Contains(value) ? 1 : 0));',
      '    return stack.Pop();',
      '  }',
      '}',
    ].join('\n'),
    'UseMoreCollections',
    { value: 4 },
    true
  );
  assertCondition(
    tracedInterviewCollections.success,
    `Traced interview collections case should succeed: ${tracedInterviewCollections.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedInterviewCollections.output === 6,
    `Traced interview collections case should return 6, received ${JSON.stringify(tracedInterviewCollections.output)}`
  );
  assertCondition(
    tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add') === true,
    `Traced interview collections case should include HashSet Add, received ${JSON.stringify(tracedInterviewCollections.events)}`
  );
  assertCondition(
    tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'queue' && event.method === 'Dequeue') === true,
    `Traced interview collections case should include Queue Dequeue, received ${JSON.stringify(tracedInterviewCollections.events)}`
  );
  assertCondition(
    tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'stack' && event.method === 'Pop') === true,
    `Traced interview collections case should include Stack Pop, received ${JSON.stringify(tracedInterviewCollections.events)}`
  );
  console.log('PASS: C# tracing returned HashSet, Queue, and Stack wrapper events');

  const tracedCollectionInitializers = executeCase(
    execute,
    [
      'using System.Collections.Generic;',
      'public class Solution {',
      '  public int UseInitializers(int value) {',
      '    List<int> list = new List<int> { value, value + 1 };',
      '    var seen = new Dictionary<int, int> { { value, list[0] }, { value + 1, list[1] } };',
      '    var set = new HashSet<int> { value, value + 2 };',
      '    return seen[value] + seen[value + 1] + (set.Contains(value + 2) ? 1 : 0);',
      '  }',
      '}',
    ].join('\n'),
    'UseInitializers',
    { value: 4 },
    true
  );
  assertCondition(
    tracedCollectionInitializers.success,
    `Traced collection initializers case should succeed: ${tracedCollectionInitializers.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedCollectionInitializers.output === 10,
    `Traced collection initializers case should return 10, received ${JSON.stringify(tracedCollectionInitializers.output)}`
  );
  assertCondition(
    tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'list' && event.method === 'Add').length === 2,
    `Traced collection initializers case should include two list Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
  );
  assertCondition(
    tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'seen' && event.method === 'Add').length === 2,
    `Traced collection initializers case should include two dictionary Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
  );
  assertCondition(
    tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add').length === 2,
    `Traced collection initializers case should include two HashSet Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
  );
  console.log('PASS: C# tracing returned collection initializer wrapper events');

  const tracedTargetTypedCollections = executeCase(
    execute,
    [
      'using System.Collections.Generic;',
      'public class Solution {',
      '  public int UseTargetTyped(int value) {',
      '    List<int> list = new() { value, value + 1 };',
      '    Dictionary<int, int> seen = new() { { value, list[0] }, { value + 1, list[1] } };',
      '    HashSet<int> set = new() { value + 2 };',
      '    Queue<int> queue = new();',
      '    queue.Enqueue(seen[value]);',
      '    Stack<int> stack = new();',
      '    stack.Push(queue.Dequeue() + seen[value + 1] + (set.Contains(value + 2) ? 1 : 0));',
      '    return stack.Pop();',
      '  }',
      '}',
    ].join('\n'),
    'UseTargetTyped',
    { value: 4 },
    true
  );
  assertCondition(
    tracedTargetTypedCollections.success,
    `Traced target-typed collections case should succeed: ${tracedTargetTypedCollections.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedTargetTypedCollections.output === 10,
    `Traced target-typed collections case should return 10, received ${JSON.stringify(tracedTargetTypedCollections.output)}`
  );
  assertCondition(
    tracedTargetTypedCollections.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'list' && event.method === 'Add').length === 2,
    `Traced target-typed collections case should include two list Add events, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
  );
  assertCondition(
    tracedTargetTypedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'queue' && event.method === 'Enqueue') === true,
    `Traced target-typed collections case should include Queue Enqueue, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
  );
  assertCondition(
    tracedTargetTypedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'stack' && event.method === 'Pop') === true,
    `Traced target-typed collections case should include Stack Pop, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
  );
  console.log('PASS: C# tracing returned target-typed collection wrapper events');

  const tracedCollectionConstructors = executeCase(
    execute,
    [
      'using System.Collections.Generic;',
      'public class Solution {',
      '  public int UseConstructors(int[] nums) {',
      '    List<int> list = new List<int>(nums);',
      '    Dictionary<int, int> original = new Dictionary<int, int> { { nums[0], nums[1] } };',
      '    Dictionary<int, int> seen = new Dictionary<int, int>(original);',
      '    HashSet<int> set = new HashSet<int>(list);',
      '    Queue<int> queue = new Queue<int>(list);',
      '    Stack<int> stack = new Stack<int>(list);',
      '    List<int> capacityList = new List<int>(4);',
      '    capacityList.Add(stack.Pop());',
      '    return seen[nums[0]] + (set.Contains(nums[1]) ? 1 : 0) + queue.Dequeue() + capacityList[0];',
      '  }',
      '}',
    ].join('\n'),
    'UseConstructors',
    { nums: [2, 3] },
    true
  );
  assertCondition(
    tracedCollectionConstructors.success,
    `Traced collection constructors case should succeed: ${tracedCollectionConstructors.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedCollectionConstructors.output === 9,
    `Traced collection constructors case should return 9, received ${JSON.stringify(tracedCollectionConstructors.output)}`
  );
  assertCondition(
    tracedCollectionConstructors.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'list') === true,
    `Traced collection constructors case should include list constructor snapshot, received ${JSON.stringify(tracedCollectionConstructors.events)}`
  );
  assertCondition(
    tracedCollectionConstructors.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen') === true,
    `Traced collection constructors case should include dictionary copy snapshot, received ${JSON.stringify(tracedCollectionConstructors.events)}`
  );
  assertCondition(
    tracedCollectionConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'capacityList' && event.method === 'Add') === true,
    `Traced collection constructors case should include capacity list Add, received ${JSON.stringify(tracedCollectionConstructors.events)}`
  );
  console.log('PASS: C# tracing returned collection constructor wrapper events');

  const tracedComparerConstructors = executeCase(
    execute,
    [
      'using System;',
      'using System.Collections.Generic;',
      'public class Solution {',
      '  public int UseComparers(string key) {',
      '    Dictionary<string, int> seen = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) { { "Hello", 4 } };',
      '    HashSet<string> set = new HashSet<string>(2, StringComparer.OrdinalIgnoreCase);',
      '    set.Add("World");',
      '    Dictionary<string, int> copy = new Dictionary<string, int>(seen, StringComparer.OrdinalIgnoreCase);',
      '    HashSet<string> setCopy = new HashSet<string>(set, StringComparer.OrdinalIgnoreCase);',
      '    return copy[key] + (setCopy.Contains("world") ? 1 : 0);',
      '  }',
      '}',
    ].join('\n'),
    'UseComparers',
    { key: 'hello' },
    true
  );
  assertCondition(
    tracedComparerConstructors.success,
    `Traced comparer constructors case should succeed: ${tracedComparerConstructors.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedComparerConstructors.output === 5,
    `Traced comparer constructors case should return 5, received ${JSON.stringify(tracedComparerConstructors.output)}`
  );
  assertCondition(
    tracedComparerConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'seen' && event.method === 'Add') === true,
    `Traced comparer constructors case should include dictionary initializer Add, received ${JSON.stringify(tracedComparerConstructors.events)}`
  );
  assertCondition(
    tracedComparerConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add') === true,
    `Traced comparer constructors case should include HashSet Add, received ${JSON.stringify(tracedComparerConstructors.events)}`
  );
  console.log('PASS: C# tracing returned comparer constructor wrapper events');

  const twoSum = executeCase(execute, fixture('two-sum.cs'), 'TwoSum', {
    nums: [2, 7, 11, 15],
    target: 9,
  });
  assertCondition(twoSum.success, `TwoSum should succeed: ${twoSum.error ?? 'unknown error'}`);
  assertCondition(
    JSON.stringify(twoSum.output) === JSON.stringify([0, 1]),
    `TwoSum should return [0,1], received ${JSON.stringify(twoSum.output)}`
  );
  console.log('PASS: C# TwoSum compiled and returned [0,1]');

  const listNodeInput = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int SumList(ListNode head) {',
      '    int total = 0;',
      '    while (head != null) {',
      '      total += head.val;',
      '      head = head.next;',
      '    }',
      '    return total;',
      '  }',
      '}',
    ].join('\n'),
    'SumList',
    { head: [1, 2, 3, 4] }
  );
  assertCondition(listNodeInput.success, `ListNode input case should succeed: ${listNodeInput.error ?? 'unknown error'}`);
  assertCondition(listNodeInput.output === 10, `ListNode input case should return 10, received ${JSON.stringify(listNodeInput.output)}`);
  console.log('PASS: C# generated driver hydrates ListNode array inputs');

  const nullableListNodeInput = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int HasList(ListNode? head) {',
      '    return head == null ? 0 : head.val;',
      '  }',
      '}',
    ].join('\n'),
    'HasList',
    { head: null }
  );
  assertCondition(
    nullableListNodeInput.success,
    `Nullable ListNode input case should succeed: ${nullableListNodeInput.error ?? 'unknown error'}`
  );
  assertCondition(
    nullableListNodeInput.output === 0,
    `Nullable ListNode input case should return 0, received ${JSON.stringify(nullableListNodeInput.output)}`
  );
  console.log('PASS: C# generated driver hydrates nullable ListNode inputs');

  const treeNodeInput = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int SumTree(TreeNode root) {',
      '    if (root == null) return 0;',
      '    return root.val + SumTree(root.left) + SumTree(root.right);',
      '  }',
      '}',
    ].join('\n'),
    'SumTree',
    { root: [1, 2, 3, null, 4] }
  );
  assertCondition(treeNodeInput.success, `TreeNode input case should succeed: ${treeNodeInput.error ?? 'unknown error'}`);
  assertCondition(treeNodeInput.output === 10, `TreeNode input case should return 10, received ${JSON.stringify(treeNodeInput.output)}`);
  console.log('PASS: C# generated driver hydrates TreeNode level-order inputs');

  const nullableTreeNodeInput = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int HasTree(TreeNode? root) {',
      '    return root == null ? 0 : root.val;',
      '  }',
      '}',
    ].join('\n'),
    'HasTree',
    { root: null }
  );
  assertCondition(
    nullableTreeNodeInput.success,
    `Nullable TreeNode input case should succeed: ${nullableTreeNodeInput.error ?? 'unknown error'}`
  );
  assertCondition(
    nullableTreeNodeInput.output === 0,
    `Nullable TreeNode input case should return 0, received ${JSON.stringify(nullableTreeNodeInput.output)}`
  );
  console.log('PASS: C# generated driver hydrates nullable TreeNode inputs');

  const objectNodeInput = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int SumBoth(ListNode head, TreeNode root) {',
      '    return head.val + head.next.val + root.val + root.left.val;',
      '  }',
      '}',
    ].join('\n'),
    'SumBoth',
    {
      head: { val: 5, next: { value: 6, next: null } },
      root: { value: 7, left: { val: 8 }, right: null },
    }
  );
  assertCondition(objectNodeInput.success, `Object node input case should succeed: ${objectNodeInput.error ?? 'unknown error'}`);
  assertCondition(objectNodeInput.output === 26, `Object node input case should return 26, received ${JSON.stringify(objectNodeInput.output)}`);
  console.log('PASS: C# generated driver hydrates object-shaped ListNode and TreeNode inputs');

  const listNodeOutput = executeCase(
    execute,
    [
      'public class Solution {',
      '  public ListNode BuildList(int value) {',
      '    return new ListNode(value, new ListNode(value + 1));',
      '  }',
      '}',
    ].join('\n'),
    'BuildList',
    { value: 4 }
  );
  assertCondition(listNodeOutput.success, `ListNode output case should succeed: ${listNodeOutput.error ?? 'unknown error'}`);
  assertCondition(
    JSON.stringify(listNodeOutput.output) === JSON.stringify({ val: 4, next: { val: 5, next: null } }),
    `ListNode output case should serialize node fields, received ${JSON.stringify(listNodeOutput.output)}`
  );
  console.log('PASS: C# generated driver serializes ListNode outputs');

  const treeNodeOutput = executeCase(
    execute,
    [
      'public class Solution {',
      '  public TreeNode BuildTree(int value) {',
      '    return new TreeNode(value, new TreeNode(value + 1), new TreeNode(value + 2));',
      '  }',
      '}',
    ].join('\n'),
    'BuildTree',
    { value: 4 }
  );
  assertCondition(treeNodeOutput.success, `TreeNode output case should succeed: ${treeNodeOutput.error ?? 'unknown error'}`);
  assertCondition(
    JSON.stringify(treeNodeOutput.output) === JSON.stringify({
      val: 4,
      left: { val: 5, left: null, right: null },
      right: { val: 6, left: null, right: null },
    }),
    `TreeNode output case should serialize node fields, received ${JSON.stringify(treeNodeOutput.output)}`
  );
  console.log('PASS: C# generated driver serializes TreeNode outputs');

  const tracedListNodeValues = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int HeadValue(ListNode head) {',
      '    ListNode curr = head;',
      '    return curr.val;',
      '  }',
      '}',
    ].join('\n'),
    'HeadValue',
    { head: [7, 8] },
    true
  );
  assertCondition(
    tracedListNodeValues.success,
    `Traced ListNode values case should succeed: ${tracedListNodeValues.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedListNodeValues.events?.some((event) =>
      event.kind === 'write'
      && event.target?.variable === 'curr'
      && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode'
      && (event.value as { val?: number } | undefined)?.val === 7) === true,
    `Traced ListNode values case should include normalized ListNode write, received ${JSON.stringify(tracedListNodeValues.events)}`
  );
  assertCondition(
    tracedListNodeValues.events?.some((event) =>
      event.kind === 'call'
      && event.function === 'HeadValue'
      && Array.isArray(event.args)
      && (event.args[0] as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode') === true,
    `Traced ListNode values case should include normalized call args, received ${JSON.stringify(tracedListNodeValues.events)}`
  );
  assertCondition(
    tracedListNodeValues.events?.some((event) =>
      event.kind === 'read'
      && event.target?.variable === 'curr'
      && event.target.path?.[0] === 'val'
      && event.value === 7) === true,
    `Traced ListNode values case should include curr.val read, received ${JSON.stringify(tracedListNodeValues.events)}`
  );
  console.log('PASS: C# tracing normalizes ListNode writes, reads, and call args');

  const tracedListNodeFieldWrites = executeCase(
    execute,
    [
      'public class Solution {',
      '  public ListNode Reverse(ListNode head) {',
      '    ListNode prev = null;',
      '    ListNode curr = head;',
      '    while (curr != null) {',
      '      ListNode next = curr.next;',
      '      curr.next = prev;',
      '      prev = curr;',
      '      curr = next;',
      '    }',
      '    return prev;',
      '  }',
      '}',
    ].join('\n'),
    'Reverse',
    { head: [1, 2] },
    true
  );
  assertCondition(
    tracedListNodeFieldWrites.success,
    `Traced ListNode field writes case should succeed: ${tracedListNodeFieldWrites.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedListNodeFieldWrites.events?.some((event) =>
      event.kind === 'read'
      && event.target?.variable === 'curr'
      && event.target.path?.[0] === 'next'
      && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode'
      && (event.value as { val?: number } | undefined)?.val === 2) === true,
    `Traced ListNode field writes case should include curr.next read, received ${JSON.stringify(tracedListNodeFieldWrites.events)}`
  );
  assertCondition(
    tracedListNodeFieldWrites.events?.some((event) =>
      event.kind === 'write'
      && event.target?.variable === 'curr'
      && event.target.path?.[0] === 'next') === true,
    `Traced ListNode field writes case should include curr.next write, received ${JSON.stringify(tracedListNodeFieldWrites.events)}`
  );
  console.log('PASS: C# tracing emits ListNode next read/write events');

  const tracedTreeNodeValues = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int SumTree(TreeNode root) {',
      '    if (root == null) return 0;',
      '    return root.val + SumTree(root.left) + SumTree(root.right);',
      '  }',
      '}',
    ].join('\n'),
    'SumTree',
    { root: [1, 2, 3] },
    true
  );
  assertCondition(
    tracedTreeNodeValues.success,
    `Traced TreeNode values case should succeed: ${tracedTreeNodeValues.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedTreeNodeValues.events?.some((event) =>
      event.kind === 'call'
      && event.function === 'SumTree'
      && Array.isArray(event.args)
      && (event.args[0] as { __type__?: string; val?: number } | undefined)?.__type__ === 'TreeNode'
      && (event.args[0] as { val?: number } | undefined)?.val === 1) === true,
    `Traced TreeNode values case should include normalized recursive call args, received ${JSON.stringify(tracedTreeNodeValues.events)}`
  );
  assertCondition(
    tracedTreeNodeValues.events?.some((event) =>
      event.kind === 'return'
      && event.function === 'SumTree'
      && event.value === 6) === true,
    `Traced TreeNode values case should include final return value, received ${JSON.stringify(tracedTreeNodeValues.events)}`
  );
  assertCondition(
    tracedTreeNodeValues.events?.some((event) =>
      event.kind === 'read'
      && event.target?.variable === 'root'
      && event.target.path?.[0] === 'left'
      && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'TreeNode'
      && (event.value as { val?: number } | undefined)?.val === 2) === true,
    `Traced TreeNode values case should include root.left read, received ${JSON.stringify(tracedTreeNodeValues.events)}`
  );
  assertCondition(
    tracedTreeNodeValues.events?.some((event) =>
      event.kind === 'read'
      && event.target?.variable === 'root'
      && event.target.path?.[0] === 'val'
      && event.value === 1) === true,
    `Traced TreeNode values case should include root.val read, received ${JSON.stringify(tracedTreeNodeValues.events)}`
  );
  console.log('PASS: C# tracing normalizes TreeNode call args and field reads during recursion');

  const tracedNestedTreeNodeFields = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int LeftValue(TreeNode root) {',
      '    return root.left.val;',
      '  }',
      '}',
    ].join('\n'),
    'LeftValue',
    { root: [1, 9, 3] },
    true
  );
  assertCondition(
    tracedNestedTreeNodeFields.success,
    `Traced nested TreeNode field case should succeed: ${tracedNestedTreeNodeFields.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedNestedTreeNodeFields.events?.some((event) =>
      event.kind === 'read'
      && event.target?.variable === 'root'
      && event.target.path?.[0] === 'left'
      && event.target.path?.[1] === 'val'
      && event.value === 9) === true,
    `Traced nested TreeNode field case should include root.left.val read, received ${JSON.stringify(tracedNestedTreeNodeFields.events)}`
  );
  console.log('PASS: C# tracing emits nested TreeNode field paths');

  const tracedNestedTreeNodeFieldWrites = executeCase(
    execute,
    [
      'public class Solution {',
      '  public int SetLeftValue(TreeNode root, int value) {',
      '    root.left.val = value;',
      '    return root.left.val;',
      '  }',
      '}',
    ].join('\n'),
    'SetLeftValue',
    { root: [1, 2, 3], value: 11 },
    true
  );
  assertCondition(
    tracedNestedTreeNodeFieldWrites.success,
    `Traced nested TreeNode field write case should succeed: ${tracedNestedTreeNodeFieldWrites.error ?? 'unknown error'}`
  );
  assertCondition(
    tracedNestedTreeNodeFieldWrites.output === 11,
    `Traced nested TreeNode field write case should return 11, received ${JSON.stringify(tracedNestedTreeNodeFieldWrites.output)}`
  );
  assertCondition(
    tracedNestedTreeNodeFieldWrites.events?.some((event) =>
      event.kind === 'write'
      && event.target?.variable === 'root'
      && event.target.path?.[0] === 'left'
      && event.target.path?.[1] === 'val'
      && event.value === 11) === true,
    `Traced nested TreeNode field write case should include root.left.val write, received ${JSON.stringify(tracedNestedTreeNodeFieldWrites.events)}`
  );
  console.log('PASS: C# tracing emits nested TreeNode field write paths');

  const renamedParams = executeCase(
    execute,
    'public class Solution { public int Add(int left, int right) { return left + right; } }',
    'Add',
    { a: 2, b: 3 }
  );
  assertCondition(renamedParams.success, `Renamed-parameter Add should succeed: ${renamedParams.error ?? 'unknown error'}`);
  assertCondition(
    renamedParams.output === 5,
    `Renamed-parameter Add should use input order fallback and return 5, received ${JSON.stringify(renamedParams.output)}`
  );
  console.log('PASS: C# generated driver maps renamed parameters by input order');

  const compileError = executeCase(execute, fixture('compile-error.cs'), 'Add', { a: 2, b: 3 });
  assertCondition(!compileError.success, 'Compile-error fixture should fail');
  assertCondition(
    compileError.diagnostics?.some((diagnostic) => diagnostic.file.endsWith('UserCode.cs') && diagnostic.line === 5) === true,
    `Compile diagnostics should map to UserCode.cs line 5, received ${JSON.stringify(compileError.diagnostics)}`
  );
  console.log(`PASS: C# compile error returned mapped diagnostic "${compileError.error}"`);

  const voidReturn = executeCase(execute, fixture('void-return.cs'), 'Add', { a: 2, b: 3 });
  assertCondition(voidReturn.success, `Void-return fixture should succeed: ${voidReturn.error ?? 'unknown error'}`);
  assertCondition(
    voidReturn.output === null,
    `Void-return fixture should return null output, received ${JSON.stringify(voidReturn.output)}`
  );
  console.log('PASS: C# generated driver supports void Solution methods');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
