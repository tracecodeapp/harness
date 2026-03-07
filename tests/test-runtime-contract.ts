#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { SUPPORTED_LANGUAGES, getRuntimeClient } from '../packages/harness-browser/src/runtime-client';
import { executeJavaScriptCode, executeTypeScriptCode } from '../packages/harness-javascript/src/javascript-executor';
import { generateSolutionScript } from '../packages/harness-python/src/python-harness';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(obj[key])).join(',') + '}';
}

function runPythonCase(
  solutionCode: string,
  functionName: string,
  inputs: Record<string, unknown>
): { success: boolean; output?: unknown; error?: string } {
  const script = generateSolutionScript(solutionCode, functionName, inputs);
  const run = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (run.error) {
    throw new Error(`python3 execution failed: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`python3 exited with code ${run.status}: ${run.stderr || run.stdout}`);
  }

  const lines = String(run.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) {
    throw new Error('No JSON output from python process');
  }

  const parsed = JSON.parse(last) as { success: boolean; output?: unknown; error?: string };
  return parsed;
}

async function main(): Promise<void> {
  assertCondition(SUPPORTED_LANGUAGES.includes('python'), 'SUPPORTED_LANGUAGES should include python');
  assertCondition(SUPPORTED_LANGUAGES.includes('javascript'), 'SUPPORTED_LANGUAGES should include javascript');
  assertCondition(SUPPORTED_LANGUAGES.includes('typescript'), 'SUPPORTED_LANGUAGES should include typescript');
  console.log('PASS: runtime language registry');

  const pythonClient = getRuntimeClient('python');
  const javascriptClient = getRuntimeClient('javascript');
  const typescriptClient = getRuntimeClient('typescript');
  for (const [name, client] of [
    ['python', pythonClient],
    ['javascript', javascriptClient],
    ['typescript', typescriptClient],
  ] as const) {
    assertCondition(
      typeof client.getCapabilities === 'function',
      `${name} client should implement getCapabilities`
    );
    assertCondition(typeof client.init === 'function', `${name} client should implement init`);
    assertCondition(typeof client.executeCode === 'function', `${name} client should implement executeCode`);
    assertCondition(
      typeof client.executeWithTracing === 'function',
      `${name} client should implement executeWithTracing`
    );
    assertCondition(
      typeof client.executeCodeInterviewMode === 'function',
      `${name} client should implement executeCodeInterviewMode`
    );
  }
  console.log('PASS: runtime adapter surface contract');

  const pythonCapabilities = pythonClient.getCapabilities();
  const javascriptCapabilities = javascriptClient.getCapabilities();
  const typescriptCapabilities = typescriptClient.getCapabilities();
  assertCondition(pythonCapabilities.supportsTracing === true, 'Python should support tracing');
  assertCondition(
    pythonCapabilities.supportsStepVisualization === true,
    'Python should support step visualization'
  );
  assertCondition(javascriptCapabilities.supportsTracing === true, 'JavaScript tracing should be enabled');
  assertCondition(
    javascriptCapabilities.supportsStepVisualization === true,
    'JavaScript step visualization should be enabled'
  );
  assertCondition(typescriptCapabilities.supportsTracing === true, 'TypeScript tracing should be enabled');
  assertCondition(
    typescriptCapabilities.supportsStepVisualization === true,
    'TypeScript step visualization should be enabled'
  );
  assertCondition(javascriptCapabilities.supportsScriptMode === true, 'JavaScript should support script mode');
  assertCondition(typescriptCapabilities.supportsScriptMode === true, 'TypeScript should support script mode');
  console.log('PASS: runtime capability matrix');

  const functionCase = {
    functionName: 'compute',
    inputs: { nums: [3, 1, 4], delta: 2 },
    pythonCode: `
def compute(nums, delta):
    return [n + delta for n in nums]
`,
    javascriptCode: `
function compute(nums, delta) {
  return nums.map((n) => n + delta);
}
`,
  };

  const pythonSuccess = runPythonCase(
    functionCase.pythonCode,
    functionCase.functionName,
    functionCase.inputs
  );
  assertCondition(pythonSuccess.success === true, 'Python function case should succeed');

  const javascriptSuccess = await executeJavaScriptCode(
    functionCase.javascriptCode,
    functionCase.functionName,
    functionCase.inputs,
    'function'
  );
  assertCondition(javascriptSuccess.success === true, 'JavaScript function case should succeed');
  assertCondition(
    stableStringify(javascriptSuccess.output) === stableStringify(pythonSuccess.output),
    `Cross-runtime output mismatch.\npython=${stableStringify(pythonSuccess.output)}\njavascript=${stableStringify(javascriptSuccess.output)}`
  );
  console.log('PASS: cross-runtime function-style output parity');

  const typescriptSuccess = await executeTypeScriptCode(
    `
function compute(nums: number[], delta: number): number[] {
  return nums.map((n) => n + delta);
}
`,
    functionCase.functionName,
    functionCase.inputs,
    'function'
  );
  assertCondition(typescriptSuccess.success === true, 'TypeScript function case should succeed');
  assertCondition(
    stableStringify(typescriptSuccess.output) === stableStringify(pythonSuccess.output),
    `Cross-runtime output mismatch.\npython=${stableStringify(pythonSuccess.output)}\ntypescript=${stableStringify(typescriptSuccess.output)}`
  );
  console.log('PASS: cross-runtime TypeScript parity');

  const pythonError = runPythonCase('def other():\n    return 1\n', 'missing_function', {});
  const javascriptError = await executeJavaScriptCode(
    'function other() { return 1; }',
    'missing_function',
    {},
    'function'
  );
  assertCondition(pythonError.success === false, 'Python missing function case should fail');
  assertCondition(javascriptError.success === false, 'JavaScript missing function case should fail');
  assertCondition(
    typeof pythonError.error === 'string' && pythonError.error.length > 0,
    'Python missing function case should include error'
  );
  assertCondition(
    typeof javascriptError.error === 'string' && javascriptError.error.length > 0,
    'JavaScript missing function case should include error'
  );
  console.log('PASS: cross-runtime error contract');

  const opsClassCode = `
class Counter {
  constructor(start) {
    this.v = start;
  }
  inc(delta) {
    this.v += delta;
    return this.v;
  }
  get() {
    return this.v;
  }
}
`;
  const opsClassInputs = {
    operations: ['Counter', 'inc', 'inc', 'get'],
    arguments: [[1], [2], [3], []],
  };
  const jsOpsClass = await executeJavaScriptCode(
    opsClassCode,
    'Counter',
    opsClassInputs,
    'ops-class'
  );
  assertCondition(jsOpsClass.success === true, 'JavaScript ops-class case should succeed');
  assertCondition(
    stableStringify(jsOpsClass.output) === stableStringify([null, 3, 6, 6]),
    `JavaScript ops-class output mismatch: ${stableStringify(jsOpsClass.output)}`
  );
  const tsOpsClass = await executeTypeScriptCode(
    opsClassCode,
    'Counter',
    opsClassInputs,
    'ops-class'
  );
  assertCondition(tsOpsClass.success === true, 'TypeScript ops-class case should succeed');
  assertCondition(
    stableStringify(tsOpsClass.output) === stableStringify([null, 3, 6, 6]),
    `TypeScript ops-class output mismatch: ${stableStringify(tsOpsClass.output)}`
  );
  console.log('PASS: runtime ops-class capability contract');

  const linkedListCycleRefInput = {
    head: {
      __id__: 'n0',
      val: 1,
      next: {
        __id__: 'n1',
        val: 2,
        next: {
          __ref__: 'n0',
        },
      },
    },
  };
  const linkedListCycleCode = `
class Solution {
  hasCycle(head) {
    let slow = head;
    let fast = head;
    while (fast && fast.next) {
      slow = slow.next;
      fast = fast.next.next;
      if (slow === fast) return true;
    }
    return false;
  }
}
`;

  const jsLinkedListCycle = await executeJavaScriptCode(
    linkedListCycleCode,
    'hasCycle',
    linkedListCycleRefInput,
    'solution-method'
  );
  assertCondition(jsLinkedListCycle.success === true, 'JavaScript linked-list ref cycle should execute successfully');
  assertCondition(jsLinkedListCycle.output === true, 'JavaScript linked-list ref cycle should resolve object identity');

  const tsLinkedListCycle = await executeTypeScriptCode(
    linkedListCycleCode,
    'hasCycle',
    linkedListCycleRefInput,
    'solution-method'
  );
  assertCondition(tsLinkedListCycle.success === true, 'TypeScript linked-list ref cycle should execute successfully');
  assertCondition(tsLinkedListCycle.output === true, 'TypeScript linked-list ref cycle should resolve object identity');
  console.log('PASS: runtime linked-list ref hydration contract');

  const treeAliasRefInput = {
    root: {
      __id__: 'root',
      val: 9,
      left: {
        __id__: 'child',
        val: 3,
        left: null,
        right: null,
      },
      right: {
        __ref__: 'child',
      },
    },
  };
  const treeAliasCode = `
function hasAliasedChildren(root) {
  return !!root && root.left === root.right;
}
`;
  const jsTreeAlias = await executeJavaScriptCode(
    treeAliasCode,
    'hasAliasedChildren',
    treeAliasRefInput,
    'function'
  );
  assertCondition(jsTreeAlias.success === true, 'JavaScript tree alias refs should execute successfully');
  assertCondition(jsTreeAlias.output === true, 'JavaScript tree alias refs should preserve shared identity');
  const tsTreeAlias = await executeTypeScriptCode(
    treeAliasCode,
    'hasAliasedChildren',
    treeAliasRefInput,
    'function'
  );
  assertCondition(tsTreeAlias.success === true, 'TypeScript tree alias refs should execute successfully');
  assertCondition(tsTreeAlias.output === true, 'TypeScript tree alias refs should preserve shared identity');
  console.log('PASS: runtime tree ref hydration contract');

  console.log('\nRuntime contract tests passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
