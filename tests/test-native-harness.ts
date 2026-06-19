#!/usr/bin/env npx tsx

import { createNativeHarness } from '../src/native';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const harness = createNativeHarness();

  const javascript = harness.getClient('javascript');
  await javascript.init();
  const jsBatch = await javascript.execute({
    kind: 'code',
    code: 'function solve(nums) { return nums.reduce((sum, value) => sum + value, 0); }',
    functionName: 'solve',
    cases: [
      { id: 'small', inputs: { nums: [1, 2, 3] }, expected: 6 },
      { id: 'empty', inputs: { nums: [] }, expected: 0 },
    ],
  });
  assertCondition(jsBatch.success === true, `native JavaScript batch should succeed: ${JSON.stringify(jsBatch)}`);
  assertCondition(
    jsBatch.cases.every((testCase) => testCase.passed === true),
    `native JavaScript batch cases should pass: ${JSON.stringify(jsBatch)}`
  );

  const typescript = harness.getClient('typescript');
  await typescript.init();
  const tsResult = await typescript.executeCode(
    'function solve(nums: number[]): number { return nums.length; }',
    'solve',
    { nums: [4, 5, 6] },
    'function'
  );
  assertCondition(tsResult.success === true && tsResult.output === 3, `native TypeScript should execute: ${JSON.stringify(tsResult)}`);

  const python = harness.getClient('python');
  await python.init();
  const pyBatch = await python.execute({
    kind: 'code',
    code: 'def solve(nums):\n    return sum(nums)\n',
    functionName: 'solve',
    cases: [
      { id: 'py-small', inputs: { nums: [3, 4] }, expected: 7 },
      { id: 'py-empty', inputs: { nums: [] }, expected: 0 },
    ],
  });
  assertCondition(pyBatch.success === true, `native Python batch should succeed: ${JSON.stringify(pyBatch)}`);
  assertCondition(
    pyBatch.cases.every((testCase) => testCase.passed === true),
    `native Python batch cases should pass: ${JSON.stringify(pyBatch)}`
  );

  const pyTrace = await python.executeWithTracing(
    [
      'def solve(nums):',
      '    total = 0',
      '    for value in nums:',
      '        total += value',
      '    return total',
      '',
    ].join('\n'),
    'solve',
    { nums: [2, 3, 5] },
    { maxTraceSteps: 200 },
    'function'
  );
  assertCondition(
    pyTrace.success === true && pyTrace.output === 10 && pyTrace.trace.events.length > 0,
    `native Python tracing should execute: ${JSON.stringify({ success: pyTrace.success, output: pyTrace.output, error: pyTrace.error, events: pyTrace.trace.events.length })}`
  );

  const supports = harness.getNativeLanguageSupport();
  assertCondition(
    supports.some((support) => support.language === 'python' && support.code.supported && support.code.batching),
    'native support matrix should advertise Python code batching'
  );
  assertCondition(
    harness.isNativeCodeLanguageSupported('java') && harness.getNativeLanguageSupport('java').code.batching,
    'native support matrix should advertise Java code-client batching'
  );

  const java = harness.getClient('java');
  const javaBatch = await java.execute({
    kind: 'code',
    code: 'class Solution { public int add(int a, int b) { return a + b; } }',
    functionName: 'add',
    executionStyle: 'solution-method',
    cases: [
      { id: 'java-a', inputs: { a: 2, b: 3 }, expected: 5 },
      { id: 'java-b', inputs: { a: 4, b: 6 }, expected: 10 },
    ],
  });
  assertCondition(javaBatch.success === true, `native Java batch should succeed: ${JSON.stringify(javaBatch)}`);
  assertCondition(javaBatch.cases.every((testCase) => testCase.passed === true), `native Java cases should pass: ${JSON.stringify(javaBatch)}`);

  const csharp = harness.getClient('csharp');
  const csharpBatch = await csharp.execute({
    kind: 'code',
    code: 'public class Solution { public int Add(int a, int b) { return a + b; } }',
    functionName: 'Add',
    executionStyle: 'solution-method',
    cases: [
      { id: 'csharp-a', inputs: { a: 2, b: 3 }, expected: 5 },
      { id: 'csharp-b', inputs: { a: 4, b: 6 }, expected: 10 },
    ],
  });
  assertCondition(csharpBatch.success === true, `native C# batch should succeed: ${JSON.stringify(csharpBatch)}`);
  assertCondition(csharpBatch.cases.every((testCase) => testCase.passed === true), `native C# cases should pass: ${JSON.stringify(csharpBatch)}`);

  const csharpDictionaryInput = await csharp.executeCode(
    [
      'using System.Collections.Generic;',
      'public class Solution {',
      '  public string ReadDictionaries(Dictionary<string, string> labels, IDictionary<string, int> scores) {',
      '    return labels["chosen"] + ":" + scores["alice"];',
      '  }',
      '}',
    ].join('\n'),
    'ReadDictionaries',
    {
      labels: { chosen: 'variant_b' },
      scores: { alice: 2 },
    },
    'solution-method'
  );
  assertCondition(
    csharpDictionaryInput.success === true && csharpDictionaryInput.output === 'variant_b:2',
    `native C# dictionary inputs should hydrate as dictionary types: ${JSON.stringify(csharpDictionaryInput)}`
  );

  const cpp = harness.getClient('cpp');
  const cppBatch = await cpp.execute({
    kind: 'code',
    code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
    functionName: 'add',
    executionStyle: 'solution-method',
    cases: [
      { id: 'cpp-a', inputs: { a: 2, b: 3 }, expected: 5 },
      { id: 'cpp-b', inputs: { a: 4, b: 6 }, expected: 10 },
    ],
  });
  assertCondition(cppBatch.success === true, `native C++ batch should succeed: ${JSON.stringify(cppBatch)}`);
  assertCondition(cppBatch.cases.every((testCase) => testCase.passed === true), `native C++ cases should pass: ${JSON.stringify(cppBatch)}`);
  const cppOpsBatch = await cpp.execute({
    kind: 'code',
    code: [
      'class Counter {',
      '  int value;',
      'public:',
      '  Counter(int start) : value(start) {}',
      '  void add(int delta) { value += delta; }',
      '  int get() { return value; }',
      '};',
    ].join('\n'),
    functionName: 'Counter',
    executionStyle: 'ops-class',
    cases: [
      {
        id: 'cpp-ops-a',
        inputs: { operations: ['Counter', 'add', 'get', 'add', 'get'], arguments: [[1], [2], [], [-1], []] },
        expected: [null, null, 3, null, 2],
      },
      {
        id: 'cpp-ops-b',
        inputs: { operations: ['Counter', 'add', 'get', 'add', 'get'], arguments: [[10], [5], [], [7], []] },
        expected: [null, null, 15, null, 22],
      },
    ],
  });
  assertCondition(cppOpsBatch.success === true, `native C++ ops-class batch should succeed: ${JSON.stringify(cppOpsBatch)}`);
  assertCondition(cppOpsBatch.cases.every((testCase) => testCase.passed === true), `native C++ ops-class cases should pass: ${JSON.stringify(cppOpsBatch)}`);
  const cppTrace = await cpp.executeWithTracing(
    'class Solution { public: int add(int a, int b) { int total = a + b; return total; } };',
    'add',
    { a: 8, b: 13 },
    { maxTraceSteps: 200 },
    'solution-method'
  );
  assertCondition(
    cppTrace.success === true && cppTrace.output === 21 && cppTrace.trace.events.length > 0,
    `native C++ tracing should execute: ${JSON.stringify({ success: cppTrace.success, output: cppTrace.output, error: cppTrace.error, events: cppTrace.trace.events.length })}`
  );

  const queued = await harness.runJobs(
    [
      {
        id: 'queue-js',
        language: 'javascript',
        request: {
          kind: 'code',
          code: 'function solve(value) { return value * 2; }',
          functionName: 'solve',
          cases: [{ inputs: { value: 5 }, expected: 10 }],
        },
      },
      {
        id: 'queue-ts',
        language: 'typescript',
        request: {
          kind: 'code',
          code: 'function solve(value: number): number { return value + 1; }',
          functionName: 'solve',
          cases: [{ inputs: { value: 5 }, expected: 6 }],
        },
      },
      {
        id: 'queue-py',
        language: 'python',
        request: {
          kind: 'code',
          code: 'def solve(value):\n    return value - 1\n',
          functionName: 'solve',
          cases: [{ inputs: { value: 5 }, expected: 4 }],
        },
      },
    ],
    { workers: 2 }
  );
  assertCondition(queued.length === 3, `native queue should return every job: ${JSON.stringify(queued)}`);
  assertCondition(
    queued.every((job) => job.success && job.result?.success),
    `native queue should execute mixed supported languages: ${JSON.stringify(queued)}`
  );
  const streamedIds: string[] = [];
  await harness.runJobsEach(
    queued.map((job) => ({
      id: `stream-${job.id}`,
      language: 'javascript' as const,
      request: {
        kind: 'code' as const,
        code: 'function solve(value) { return value; }',
        functionName: 'solve',
        cases: [{ inputs: { value: job.id }, expected: job.id }],
      },
    })),
    (result) => {
      streamedIds.push(result.id ?? '');
    },
    { workers: 2 }
  );
  assertCondition(streamedIds.length === queued.length, `native streaming queue should report every job: ${JSON.stringify(streamedIds)}`);

  const queue = harness.createQueue({ workers: 2 });
  const dynamicA = queue.enqueue({
    id: 'dynamic-a',
    language: 'javascript',
    request: {
      kind: 'code',
      code: 'function solve(value) { return value; }',
      functionName: 'solve',
      cases: [{ inputs: { value: 'a' }, expected: 'a' }],
    },
  });
  const dynamicB = queue.enqueue({
    id: 'dynamic-java',
    language: 'java',
    request: {
      kind: 'code',
      code: 'class Solution { public int solve(int value) { return value; } }',
      functionName: 'solve',
      executionStyle: 'solution-method',
      cases: [{ inputs: { value: 1 }, expected: 1 }],
    },
  });
  await queue.drain();
  const dynamicResults = await Promise.all([dynamicA, dynamicB]);
  assertCondition(dynamicResults[0]?.success === true, `native queue should resolve successful enqueued jobs: ${JSON.stringify(dynamicResults)}`);
  assertCondition(
    dynamicResults[1]?.success === true && dynamicResults[1]?.result?.success === true,
    `native queue should execute Java enqueued jobs: ${JSON.stringify(dynamicResults)}`
  );
  queue.dispose();

  harness.dispose();
  console.log('Native harness smoke tests passed.');
}

await main();
