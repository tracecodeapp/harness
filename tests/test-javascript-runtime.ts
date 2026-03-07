#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { executeTypeScriptCode } from '../packages/harness-javascript/src/javascript-executor';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

type RuntimeAccessEvent = {
  variable?: string;
  kind?: string;
  indices?: number[];
  method?: string;
  pathDepth?: number;
};

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function loadWorkerSource(): Promise<string> {
  const workerPath = join(process.cwd(), 'workers', 'javascript', 'javascript-worker.js');
  return readFile(workerPath, 'utf8');
}

function createWorkerHarness(workerSource: string) {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let ready = false;
  let nextId = 0;

  const selfObject: {
    location: { search: string };
    postMessage: (message: WorkerMessage) => void;
    onmessage: ((event: { data: WorkerMessage }) => void) | null;
    ts?: unknown;
  } = {
    location: { search: '' },
    postMessage: (message: WorkerMessage) => {
      if (message.type === 'worker-ready') {
        ready = true;
        return;
      }
      const id = message.id;
      if (!id) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (message.type === 'error') {
        const payload = message.payload as { error?: unknown } | undefined;
        entry.reject(new Error(String(payload?.error ?? 'Worker error')));
        return;
      }
      entry.resolve(message.payload);
    },
    onmessage: null,
    ts,
  };

  const context = vm.createContext({
    console,
    self: selfObject,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
  });

  vm.runInContext(workerSource, context, {
    filename: 'javascript-worker.js',
  });

  const onmessage = selfObject.onmessage;
  assertCondition(typeof onmessage === 'function', 'Worker did not register onmessage handler');
  assertCondition(ready, 'Worker did not emit worker-ready');

  async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    const responsePromise = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(new Error(`Timed out waiting for response: ${type}`));
      }, 5000);
    });

    onmessage?.({ data: { id, type, payload } });
    return responsePromise;
  }

  return { sendMessage };
}

async function main(): Promise<void> {
  const workerSource = await loadWorkerSource();
  const harness = createWorkerHarness(workerSource);

  const init = await harness.sendMessage<{ success: boolean; loadTimeMs: number }>('init');
  assertCondition(init.success === true, 'Init should succeed');
  assertCondition(typeof init.loadTimeMs === 'number', 'Init should return loadTimeMs');
  console.log('PASS: worker init');

  const execute = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    consoleOutput?: string[];
  }>('execute-code', {
    code: 'function add(a, b) { console.log("sum", a + b); return a + b; }',
    functionName: 'add',
    inputs: { a: 2, b: 3 },
    executionStyle: 'function',
  });
  assertCondition(execute.success === true, 'Function execution should succeed');
  assertCondition(execute.output === 5, 'Function execution output should equal 5');
  assertCondition(Array.isArray(execute.consoleOutput), 'Function execution should return consoleOutput');
  assertCondition(execute.consoleOutput?.[0] === 'sum 5', 'Console output capture should preserve value order');
  console.log('PASS: execute-code function style');

  const executeSanitizedRuntimeHints = await harness.sendMessage<{
    success: boolean;
    error?: string;
  }>('execute-code', {
    code: 'function fail() { throw new ReferenceError("value is not defined. Did you mean `value2`?"); }',
    functionName: 'fail',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeSanitizedRuntimeHints.success === false, 'ReferenceError case should fail');
  assertCondition(
    typeof executeSanitizedRuntimeHints.error === 'string' &&
      !executeSanitizedRuntimeHints.error.toLowerCase().includes('did you mean'),
    'Runtime error messages should strip engine suggestion hints'
  );
  console.log('PASS: execute-code runtime hint sanitization');

  const executeScriptMode = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen.has(complement)) return [seen.get(complement), i];
    seen.set(nums[i], i);
  }
  return [];
}

result = twoSum([2, 7, 11, 15], 9);`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeScriptMode.success === true, 'Script execution should succeed');
  assertCondition(Array.isArray(executeScriptMode.output), 'Script execution output should be an array');
  const scriptOutput = executeScriptMode.output as unknown[];
  assertCondition(scriptOutput[0] === 0 && scriptOutput[1] === 1, 'Script execution output should equal [0, 1]');
  console.log('PASS: execute-code script mode result assignment');

  const executeRuntimePreludeNodes = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `const head = new ListNode(1, new ListNode(2, new ListNode(3)));
const root = new TreeNode(2, new TreeNode(1), new TreeNode(3));
result = [head.val, head.next.val, root.left.val, root.right.val];`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeRuntimePreludeNodes.success === true, 'Runtime should expose ListNode/TreeNode prelude classes');
  assertCondition(Array.isArray(executeRuntimePreludeNodes.output), 'Prelude class execution output should be an array');
  const preludeOutput = executeRuntimePreludeNodes.output as unknown[];
  assertCondition(
    preludeOutput[0] === 1 && preludeOutput[1] === 2 && preludeOutput[2] === 1 && preludeOutput[3] === 3,
    'Prelude class execution should preserve ListNode/TreeNode value wiring'
  );
  console.log('PASS: execute-code runtime ListNode/TreeNode prelude support');

  const executeLinkedListCycleRefs = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `class Solution {
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
}`,
    functionName: 'hasCycle',
    executionStyle: 'solution-method',
    inputs: {
      head: {
        __id__: 'n0',
        val: 3,
        next: {
          __id__: 'n1',
          val: 2,
          next: {
            __id__: 'n2',
            val: 0,
            next: {
              __id__: 'n3',
              val: -4,
              next: { __ref__: 'n1' },
            },
          },
        },
      },
    },
  });
  assertCondition(executeLinkedListCycleRefs.success === true, 'Linked-list ref input execution should succeed');
  assertCondition(
    executeLinkedListCycleRefs.output === true,
    'Linked-list ref input should be hydrated so identity-based cycle checks pass'
  );
  console.log('PASS: execute-code linked-list ref hydration contract');

  const executeTreeAliasRefs = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function hasAliasedChildren(root) {
  return !!root && root.left === root.right;
}`,
    functionName: 'hasAliasedChildren',
    executionStyle: 'function',
    inputs: {
      root: {
        __id__: 'root',
        val: 1,
        left: { __id__: 'left', val: 2, left: null, right: null },
        right: { __ref__: 'left' },
      },
    },
  });
  assertCondition(executeTreeAliasRefs.success === true, 'Tree alias ref input execution should succeed');
  assertCondition(
    executeTreeAliasRefs.output === true,
    'Tree alias ref input should be hydrated so shared child identity is preserved'
  );
  console.log('PASS: execute-code tree ref hydration contract');

  const executeSerializedCollections = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function snapshotCollections() {
  const seen = new Map([[2, 0], [7, 1]]);
  const visited = new Set([2, 7]);
  return { seen, visited };
}`,
    functionName: 'snapshotCollections',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeSerializedCollections.success === true, 'Collection serialization execution should succeed');
  const collectionsOutput = executeSerializedCollections.output as Record<string, unknown>;
  const seenOutput = collectionsOutput?.seen as { __type__?: unknown; entries?: unknown[] } | undefined;
  const visitedOutput = collectionsOutput?.visited as { __type__?: unknown; values?: unknown[] } | undefined;
  const firstSeenEntry = Array.isArray(seenOutput?.entries) ? seenOutput.entries[0] : undefined;
  assertCondition(seenOutput?.__type__ === 'map', 'Map values should serialize with __type__ = "map"');
  assertCondition(Array.isArray(seenOutput?.entries), 'Serialized map should expose entries array');
  assertCondition(
    Array.isArray(firstSeenEntry) && firstSeenEntry[0] === 2,
    'Serialized map entries should preserve key/value tuple ordering'
  );
  assertCondition(visitedOutput?.__type__ === 'set', 'Set values should serialize with __type__ = "set"');
  assertCondition(
    Array.isArray(visitedOutput?.values) && visitedOutput.values.length === 2,
    'Serialized set should expose values array'
  );
  console.log('PASS: execute-code map/set serialization contract');

  const executeTypeScript = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: 'function typedAdd(a: number, b: number): number { return a + b; }',
    functionName: 'typedAdd',
    inputs: { a: 4, b: 6 },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(executeTypeScript.success === true, 'TypeScript execution should succeed');
  assertCondition(executeTypeScript.output === 10, 'TypeScript output should equal 10');
  console.log('PASS: execute-code typescript transpilation');

  const packageExecutorArgOrder = await executeTypeScriptCode(
    `class Solution {
  canSplitTeams(n: number, conflicts: number[][]): boolean {
    return typeof n === 'number' && Array.isArray(conflicts);
  }
}`,
    'canSplitTeams',
    {
      conflicts: [[0, 1]],
      n: 7,
    },
    'solution-method'
  );
  assertCondition(packageExecutorArgOrder.success === true, 'Package executor arg-order case should succeed');
  assertCondition(
    packageExecutorArgOrder.output === true,
    'Package executor should bind solution-method args by signature order, not object key order'
  );
  console.log('PASS: package executor solution-method arg order contract');

  const executeTypeScriptLinkedListCycleRefs = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `class Solution {
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
}`,
    functionName: 'hasCycle',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      head: {
        __id__: 'self-loop',
        val: 7,
        next: { __ref__: 'self-loop' },
      },
    },
  });
  assertCondition(
    executeTypeScriptLinkedListCycleRefs.success === true,
    'TypeScript linked-list ref execution should succeed'
  );
  assertCondition(
    executeTypeScriptLinkedListCycleRefs.output === true,
    'TypeScript linked-list ref inputs should hydrate before execution'
  );
  console.log('PASS: execute-code typescript linked-list ref hydration contract');

  const executeTypeScriptArgOrder = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `class Solution {
  canSplitTeams(n: number, conflicts: number[][]): boolean {
    return typeof n === 'number' && Array.isArray(conflicts);
  }
}`,
    functionName: 'canSplitTeams',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      conflicts: [[0, 1]],
      n: 7,
    },
  });
  assertCondition(executeTypeScriptArgOrder.success === true, 'TypeScript arg-order execution should succeed');
  assertCondition(
    executeTypeScriptArgOrder.output === true,
    'TypeScript worker should bind solution-method args by signature order'
  );
  console.log('PASS: execute-code typescript solution-method arg order contract');

  const executeTypeScriptTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    trace: Array<{ event?: string; line?: number; function?: string }>;
  }>('execute-with-tracing', {
    code: `function typedSquare(x: number): number {
  const value = x * x;
  return value;
}`,
    functionName: 'typedSquare',
    inputs: { x: 5 },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptTracing.success === true, 'TypeScript tracing should succeed');
  assertCondition(
    executeTypeScriptTracing.trace.some((step) => step.event === 'line' && step.line === 2),
    'TypeScript tracing should map line events back to source line numbers'
  );
  assertCondition(
    executeTypeScriptTracing.trace.some((step) => step.event === 'line' && step.line === 3),
    'TypeScript tracing should preserve return-line mapping from source'
  );
  console.log('PASS: execute-with-tracing typescript line mapping contract');

  const executeTypeScriptBfsLineMapping = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      line?: number;
      accesses?: RuntimeAccessEvent[];
    }>;
  }>('execute-with-tracing', {
    code: `class Solution {
  canSplitTeams(n: number, conflicts: number[][]): boolean {
    const graph: number[][] = Array.from({ length: n }, () => []);

    for (const [a, b] of conflicts) {
      graph[a].push(b);
      graph[b].push(a);
    }

    const color: number[] = new Array(n).fill(-1);

    for (let start = 0; start < n; start++) {
      if (color[start] !== -1) continue;

      const queue: number[] = [start];
      color[start] = 0;

      while (queue.length > 0) {
        const node = queue.shift()!;

        for (const nei of graph[node]) {
          if (color[nei] === -1) {
            color[nei] = 1 - color[node];
            queue.push(nei);
          } else if (color[nei] === color[node]) {
            return false;
          }
        }
      }
    }

    return true;
  }
}`,
    functionName: 'canSplitTeams',
    className: 'Solution',
    inputs: { n: 5, conflicts: [[0, 1], [1, 2], [2, 3], [3, 4]] },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptBfsLineMapping.success === true, 'TypeScript BFS tracing should succeed');
  const bfsTrace = executeTypeScriptBfsLineMapping.trace;
  const queuePushLines = bfsTrace
    .filter((step) =>
      (step.accesses ?? []).some(
        (access) => access.variable === 'queue' && access.kind === 'mutating-call' && access.method === 'push'
      )
    )
    .map((step) => step.line);
  assertCondition(
    queuePushLines.length > 0 && queuePushLines.every((line) => line !== 16 && line !== 17 && line !== 18),
    'TypeScript BFS tracing should not attach queue.push effects to stale queue setup or blank lines'
  );
  const graphReadLines = bfsTrace
    .filter((step) =>
      (step.accesses ?? []).some(
        (access) => access.variable === 'graph' && access.kind === 'indexed-read'
      )
    )
    .map((step) => step.line);
  assertCondition(
    graphReadLines.length > 0 && graphReadLines.every((line) => line !== 18 && line !== 21),
    'TypeScript BFS tracing should not attach graph neighbor reads to blank separator lines'
  );
  console.log('PASS: execute-with-tracing typescript BFS line alignment contract');

  const executeTypeScriptArgOrderTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    trace: Array<{ event?: string; function?: string; returnValue?: unknown }>;
  }>('execute-with-tracing', {
    code: `class Solution {
  canSplitTeams(n: number, conflicts: number[][]): boolean {
    return typeof n === 'number' && Array.isArray(conflicts);
  }
}`,
    functionName: 'canSplitTeams',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      conflicts: [[0, 1]],
      n: 7,
    },
  });
  assertCondition(executeTypeScriptArgOrderTracing.success === true, 'TypeScript arg-order tracing should succeed');
  assertCondition(
    executeTypeScriptArgOrderTracing.output === true,
    'TypeScript traced execution should bind solution-method args by signature order'
  );
  assertCondition(
    executeTypeScriptArgOrderTracing.trace.some(
      (step) => step.event === 'return' && step.function === 'canSplitTeams' && step.returnValue === true
    ),
    'TypeScript traced execution should preserve the successful return value for arg-order cases'
  );
  console.log('PASS: execute-with-tracing typescript solution-method arg order contract');

  const executeTypeScriptAccessTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ accesses?: RuntimeAccessEvent[] }>;
  }>('execute-with-tracing', {
    code: `function inspect(arr: number[], matrix: number[][]): number {
  const value = arr[0];
  matrix[0][1] = value;
  arr[0]--;
  matrix[0][1]++;
  return matrix[0][1] + arr[0];
}`,
    functionName: 'inspect',
    inputs: {
      arr: [3, 5],
      matrix: [
        [0, 0],
        [0, 0],
      ],
    },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptAccessTracing.success === true, 'TypeScript tracing with access metadata should succeed');
  const flatTsAccesses = executeTypeScriptAccessTracing.trace.flatMap((step) => step.accesses ?? []);
  assertCondition(
    flatTsAccesses.some(
      (access) =>
        access.variable === 'matrix' &&
        access.kind === 'cell-write' &&
        access.indices?.[0] === 0 &&
        access.indices?.[1] === 1 &&
        access.pathDepth === 2
    ),
    'TypeScript tracing should emit cell-write access events'
  );
  assertCondition(
    flatTsAccesses.some(
      (access) =>
        access.variable === 'arr' &&
        access.kind === 'indexed-read' &&
        access.indices?.[0] === 0 &&
        access.pathDepth === 1
    ) &&
      flatTsAccesses.some(
        (access) =>
          access.variable === 'arr' &&
          access.kind === 'indexed-write' &&
          access.indices?.[0] === 0 &&
          access.pathDepth === 1
      ),
    'TypeScript tracing should emit indexed read/write access events for compound assignments'
  );
  console.log('PASS: execute-with-tracing TypeScript access metadata');

  const executeTypeScriptSyntaxError = await harness.sendMessage<{
    success: boolean;
    error?: string;
    errorLine?: number;
  }>('execute-code', {
    code: 'function broken(a: number): number { return a + ; }',
    functionName: 'broken',
    inputs: { a: 1 },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptSyntaxError.success === false, 'TypeScript syntax errors should fail');
  assertCondition(
    typeof executeTypeScriptSyntaxError.error === 'string' &&
      executeTypeScriptSyntaxError.error.includes('TypeScript transpilation failed'),
    'TypeScript syntax errors should include transpilation failure context'
  );
  assertCondition(
    executeTypeScriptSyntaxError.errorLine === 1,
    'TypeScript transpilation errors should preserve source line mapping'
  );
  console.log('PASS: execute-code typescript transpilation error mapping');

  const tracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ event?: string; function?: string; returnValue?: unknown }>;
    executionTimeMs: number;
    lineEventCount?: number;
    traceStepCount?: number;
  }>('execute-with-tracing', {
    code: 'function square(x) { return x * x; }',
    functionName: 'square',
    inputs: { x: 7 },
    executionStyle: 'function',
  });
  assertCondition(tracing.success === true, 'Tracing execution should succeed');
  assertCondition(Array.isArray(tracing.trace), 'Tracing execution should return trace array');
  assertCondition(tracing.trace.length >= 3, 'Tracing execution should include call/line/return steps');
  assertCondition(tracing.trace[0]?.event === 'call', 'Tracing should start with call event');
  assertCondition(tracing.trace[1]?.event === 'line', 'Tracing should include line event');
  assertCondition(tracing.trace[2]?.event === 'return', 'Tracing should include return event');
  assertCondition(tracing.trace[0]?.function === 'square', 'Tracing should preserve function name');
  assertCondition(tracing.trace[2]?.returnValue === 49, 'Tracing should include return value');
  assertCondition(tracing.lineEventCount === 1, 'Tracing should report line event count');
  assertCondition(tracing.traceStepCount === tracing.trace.length, 'traceStepCount should match trace length');
  assertCondition(typeof tracing.executionTimeMs === 'number', 'Tracing execution should include timing');
  console.log('PASS: execute-with-tracing contract');

  const loopTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    trace: Array<{ event?: string; line?: number }>;
    lineEventCount?: number;
  }>('execute-with-tracing', {
    code: `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen.has(complement)) return [seen.get(complement), i];
    seen.set(nums[i], i);
  }
  return [];
}`,
    functionName: 'twoSum',
    inputs: { nums: [2, 7, 11, 15], target: 9 },
    executionStyle: 'function',
  });
  assertCondition(loopTracing.success === true, 'Loop tracing should succeed');
  assertCondition(Array.isArray(loopTracing.trace), 'Loop tracing should return trace array');
  assertCondition(loopTracing.trace.length > 3, 'Loop tracing should include more than synthetic 3 steps');
  assertCondition((loopTracing.lineEventCount ?? 0) > 1, 'Loop tracing should include multiple line events');
  assertCondition(loopTracing.output !== undefined, 'Loop tracing should include output');
  console.log('PASS: execute-with-tracing multi-step loop contract');

  const tracingAccesses = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ accesses?: RuntimeAccessEvent[] }>;
  }>('execute-with-tracing', {
    code: `function inspect(arr, matrix) {
  const x = arr[1];
  arr[1]++;
  matrix[1][0] = x;
  matrix[1][0]--;
  const queue = [];
  queue.push(x);
  queue.pop();
  return matrix[1][0] + arr[1];
}`,
    functionName: 'inspect',
    inputs: {
      arr: [4, 7, 9],
      matrix: [
        [0, 0],
        [0, 0],
      ],
    },
    executionStyle: 'function',
  });
  assertCondition(tracingAccesses.success === true, 'JavaScript tracing with access metadata should succeed');
  const flatAccesses = tracingAccesses.trace.flatMap((step) => step.accesses ?? []);
  assertCondition(
    flatAccesses.some(
      (access) =>
        access.variable === 'arr' &&
        access.kind === 'indexed-read' &&
        access.indices?.[0] === 1 &&
        access.pathDepth === 1
    ),
    'JavaScript tracing should emit indexed-read access events'
  );
  assertCondition(
    flatAccesses.some(
      (access) =>
        access.variable === 'arr' &&
        access.kind === 'indexed-write' &&
        access.indices?.[0] === 1 &&
        access.pathDepth === 1
    ),
    'JavaScript tracing should emit indexed-write access events for compound assignments'
  );
  assertCondition(
    flatAccesses.some(
      (access) =>
        access.variable === 'matrix' &&
        access.kind === 'cell-write' &&
        access.indices?.[0] === 1 &&
        access.indices?.[1] === 0 &&
        access.pathDepth === 2
    ),
    'JavaScript tracing should emit cell-write access events for nested element assignments'
  );
  assertCondition(
    flatAccesses.some(
      (access) =>
        access.variable === 'queue' &&
        access.kind === 'mutating-call' &&
        access.method === 'push'
    ) &&
      flatAccesses.some(
        (access) =>
          access.variable === 'queue' &&
          access.kind === 'mutating-call' &&
          access.method === 'pop'
      ),
    'JavaScript tracing should emit mutating-call access events for worklists'
  );
  console.log('PASS: execute-with-tracing JavaScript access metadata');

  const scriptTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      event?: string;
      line?: number;
      function?: string;
      variables?: Record<string, unknown>;
      visualization?: { hashMaps?: Array<{ name?: string; kind?: string; entries?: unknown[] }> };
      callStack?: Array<{ function?: string; args?: Record<string, unknown> }>;
    }>;
  }>('execute-with-tracing', {
    code: `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen.has(complement)) return [seen.get(complement), i];
    seen.set(nums[i], i);
  }
  return [];
}

result = twoSum([2, 7, 11, 15], 9);`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(scriptTracing.success === true, 'Script tracing should succeed');
  assertCondition(scriptTracing.trace.length > 3, 'Script tracing should include multiple executable steps');
  assertCondition(scriptTracing.trace[0]?.function === '<module>', 'Script tracing should use <module> function name');
  assertCondition(
    scriptTracing.trace.some((step) => step.function === 'twoSum'),
    'Script tracing should include named function events'
  );
  const twoSumCallStep = scriptTracing.trace.find(
    (step) => step.event === 'call' && step.function === 'twoSum'
  );
  assertCondition(
    twoSumCallStep?.line === 1,
    'Script tracing should place twoSum call on function declaration line'
  );
  const twoSumCallArgs = twoSumCallStep?.callStack?.[twoSumCallStep.callStack.length - 1]?.args;
  assertCondition(
    Boolean(twoSumCallArgs && Object.prototype.hasOwnProperty.call(twoSumCallArgs, 'nums')),
    'Script tracing should include twoSum call argument "nums"'
  );
  assertCondition(
    Boolean(twoSumCallArgs && Object.prototype.hasOwnProperty.call(twoSumCallArgs, 'target')),
    'Script tracing should include twoSum call argument "target"'
  );
  assertCondition(
    scriptTracing.trace.some((step) => (step.callStack?.length ?? 0) > 1),
    'Script tracing should capture nested call stack frames'
  );
  const twoSumReturnStepIndex = scriptTracing.trace.findIndex(
    (step) => step.event === 'return' && step.function === 'twoSum'
  );
  assertCondition(
    twoSumReturnStepIndex >= 0,
    'Script tracing should emit a return event for twoSum'
  );
  let resultAssignmentStepIndex = -1;
  for (let i = scriptTracing.trace.length - 1; i >= 0; i -= 1) {
    const step = scriptTracing.trace[i];
    if (!Object.prototype.hasOwnProperty.call(step.variables ?? {}, 'result')) continue;
    const resultValue = step.variables?.result;
    if (Array.isArray(resultValue) && resultValue[0] === 0 && resultValue[1] === 1) {
      resultAssignmentStepIndex = i;
      break;
    }
  }
  assertCondition(
    resultAssignmentStepIndex > twoSumReturnStepIndex,
    'Script tracing should populate result after twoSum return event'
  );
  assertCondition(
    scriptTracing.trace[scriptTracing.trace.length - 1]?.variables?.result !== undefined,
    'Script tracing return step should include result variable'
  );
  console.log('PASS: execute-with-tracing script mode contract');

  const collectionTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      visualization?: {
        hashMaps?: Array<{ name?: string; kind?: string; entries?: unknown[] }>;
        objectKinds?: Record<string, string>;
      };
    }>;
  }>('execute-with-tracing', {
    code: `function capture() {
  const seen = new Map([[2, 0], [7, 1]]);
  const visited = new Set([2, 7]);
  return seen.size + visited.size;
}`,
    functionName: 'capture',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(collectionTracing.success === true, 'Collection tracing should succeed');
  const hasMapVisualization = collectionTracing.trace.some((step) =>
    (step.visualization?.hashMaps ?? []).some(
      (visualization) => visualization.name === 'seen' && visualization.kind === 'map'
    )
  );
  const hasSetVisualization = collectionTracing.trace.some((step) =>
    (step.visualization?.hashMaps ?? []).some(
      (visualization) => visualization.name === 'visited' && visualization.kind === 'set'
    )
  );
  assertCondition(hasMapVisualization, 'Tracing should emit map visualization payload for Map locals');
  assertCondition(hasSetVisualization, 'Tracing should emit set visualization payload for Set locals');
  console.log('PASS: execute-with-tracing runtime visualization payload contract');

  const objectHashTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      visualization?: {
        hashMaps?: Array<{ name?: string; kind?: string; entries?: unknown[] }>;
        objectKinds?: Record<string, string>;
      };
    }>;
  }>('execute-with-tracing', {
    code: `function captureObjectHash(nums, target) {
  const seen = {};
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen[complement] !== undefined) return [seen[complement], i];
    seen[nums[i]] = i;
  }
  return [];
}`,
    functionName: 'captureObjectHash',
    inputs: { nums: [2, 7, 11, 15], target: 9 },
    executionStyle: 'function',
  });
  assertCondition(objectHashTracing.success === true, 'Object-hash tracing should succeed');
  const hasObjectHashVisualization = objectHashTracing.trace.some((step) =>
    (step.visualization?.hashMaps ?? []).some(
      (visualization) => visualization.name === 'seen' && visualization.kind === 'hashmap'
    )
  );
  assertCondition(
    hasObjectHashVisualization,
    'Tracing should emit hashmap visualization payload for plain object hash locals'
  );
  const hasObjectHashKindTag = objectHashTracing.trace.some(
    (step) => step.visualization?.objectKinds?.seen === 'hashmap'
  );
  assertCondition(
    hasObjectHashKindTag,
    'Tracing should tag plain object hash locals with objectKinds.hashmap'
  );
  console.log('PASS: execute-with-tracing object-hash visualization payload contract');

  const graphKindTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      visualization?: {
        objectKinds?: Record<string, string>;
      };
    }>;
  }>('execute-with-tracing', {
    code: `function captureGraph() {
  const graph = { 0: [1], 1: [2], 2: [] };
  return graph;
}`,
    functionName: 'captureGraph',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(graphKindTracing.success === true, 'Graph-kind tracing should succeed');
  const hasGraphKindTag = graphKindTracing.trace.some(
    (step) => step.visualization?.objectKinds?.graph === 'graph-adjacency'
  );
  assertCondition(
    hasGraphKindTag,
    'Tracing should tag adjacency-list object locals with objectKinds.graph-adjacency'
  );
  console.log('PASS: execute-with-tracing graph object-kind contract');

  const indexedGraphKindTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      visualization?: {
        objectKinds?: Record<string, string>;
      };
    }>;
  }>('execute-with-tracing', {
    code: `function captureIndexedGraph() {
  const graph = [[1], [2], [0]];
  return graph.length;
}`,
    functionName: 'captureIndexedGraph',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(indexedGraphKindTracing.success === true, 'Indexed-graph tracing should succeed');
  const hasIndexedGraphKindTag = indexedGraphKindTracing.trace.some(
    (step) => step.visualization?.objectKinds?.graph === 'graph-adjacency'
  );
  assertCondition(
    hasIndexedGraphKindTag,
    'Tracing should tag indexed adjacency-list locals with objectKinds.graph-adjacency'
  );
  console.log('PASS: execute-with-tracing indexed graph object-kind contract');

  const listKindTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      visualization?: {
        objectKinds?: Record<string, string>;
      };
    }>;
  }>('execute-with-tracing', {
    code: `function captureList() {
  const head = { val: 1, next: { val: 2, next: null } };
  return head;
}`,
    functionName: 'captureList',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(listKindTracing.success === true, 'List-kind tracing should succeed');
  const hasListKindTag = listKindTracing.trace.some(
    (step) => step.visualization?.objectKinds?.head === 'linked-list'
  );
  assertCondition(
    hasListKindTag,
    'Tracing should tag linked-list locals with objectKinds.linked-list'
  );
  console.log('PASS: execute-with-tracing linked-list object-kind contract');

  const topLevelOrderingTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ event?: string; line?: number; function?: string }>;
  }>('execute-with-tracing', {
    code: `function identity(x) {
  return x;
}

if (1 === 1) {
  console.log('A');
}

result = identity(42);`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(topLevelOrderingTracing.success === true, 'Top-level ordering tracing should succeed');
  assertCondition(topLevelOrderingTracing.trace.length > 0, 'Top-level ordering tracing should include steps');
  assertCondition(
    topLevelOrderingTracing.trace[0]?.event === 'line' &&
      topLevelOrderingTracing.trace[0]?.function === '<module>' &&
      topLevelOrderingTracing.trace[0]?.line === 5,
    'Script tracing should start at first executable top-level statement line'
  );
  console.log('PASS: execute-with-tracing top-level start line contract');

  const opsClassStyle = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-code', {
    code: `class Counter {
  constructor(start) { this.v = start; }
  inc(delta) { this.v += delta; return this.v; }
  get() { return this.v; }
}`,
    functionName: 'Counter',
    inputs: {
      operations: ['Counter', 'inc', 'inc', 'get'],
      arguments: [[1], [2], [3], []],
    },
    executionStyle: 'ops-class',
  });
  assertCondition(opsClassStyle.success === true, 'ops-class execution should succeed');
  assertCondition(
    Array.isArray(opsClassStyle.output) &&
      opsClassStyle.output[0] === null &&
      opsClassStyle.output[1] === 3 &&
      opsClassStyle.output[2] === 6 &&
      opsClassStyle.output[3] === 6,
    'ops-class execution should match Python-style operation replay output'
  );
  console.log('PASS: execute-code ops-class style');

  const interviewResult = await harness.sendMessage<{
    success: boolean;
    error?: string;
  }>('execute-code-interview', {
    code: 'function boom() { throw new Error("kaboom"); }',
    functionName: 'boom',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(interviewResult.success === false, 'Interview execution should surface errors');
  assertCondition(
    String(interviewResult.error ?? '').toLowerCase().includes('kaboom'),
    'Interview execution should preserve non-timeout errors'
  );
  console.log('PASS: interview execution contract');

  const interviewTimeout = await harness.sendMessage<{
    success: boolean;
    error?: string;
  }>('execute-code-interview', {
    code: `function spin() { let x = 0; while (true) { x += 1; } }`,
    functionName: 'spin',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(interviewTimeout.success === false, 'Interview timeout case should fail');
  assertCondition(
    String(interviewTimeout.error ?? '') === 'Time Limit Exceeded',
    'Interview timeout should normalize to Time Limit Exceeded'
  );
  console.log('PASS: interview timeout normalization contract');

  console.log('\nJavaScript runtime worker tests passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
