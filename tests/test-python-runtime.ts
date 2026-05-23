#!/usr/bin/env npx tsx

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/harness-python/src/python-harness';

const RUNTIME_CORE_PATH = join(process.cwd(), 'workers', 'python', 'runtime-core.js');

type TraceAccess = {
  variable?: string;
  kind?: string;
  indices?: unknown[];
  indexSources?: Array<string | null>;
  method?: string;
  binding?: unknown;
  value?: unknown;
  args?: unknown[];
};

type TraceStep = {
  line: number;
  event: string;
  function?: string;
  accesses?: TraceAccess[];
  variables?: Record<string, unknown>;
};

type RuntimeTraceEvent = {
  kind?: string;
  line?: number;
  function?: string;
  target?: {
    variable?: string;
    path?: unknown[];
    indexSources?: Array<string | null>;
  };
  binding?: {
    kind?: string;
    variable?: string;
  };
  value?: unknown;
  args?: unknown[];
  callStack?: Array<{ function?: string; args?: Record<string, unknown> }>;
};

type RuntimeCore = {
  generateTracingCode: (
    deps: RuntimeDeps,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ) => { code: string; userCodeStartLine: number };
};

type RuntimeDeps = {
  PYTHON_CLASS_DEFINITIONS_SNIPPET: string;
  PYTHON_CONVERSION_HELPERS_SNIPPET: string;
  PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: string;
  PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: string;
  toPythonLiteral: (value: unknown) => string;
};

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function loadRuntimeCore(): Promise<RuntimeCore> {
  const source = await readFile(RUNTIME_CORE_PATH, 'utf8');
  const selfObject: Record<string, unknown> = {};
  const context = vm.createContext({
    console,
    self: selfObject,
    globalThis: {},
  });

  vm.runInContext(source, context, { filename: 'runtime-core.js' });

  const runtime = selfObject.__TRACECODE_PYODIDE_RUNTIME__;
  assertCondition(
    typeof runtime === 'object' && runtime !== null,
    'Unable to load runtime core exports'
  );

  return runtime as RuntimeCore;
}

async function runPythonScript(script: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-python-runtime-'));
  const scriptPath = join(tempDir, 'trace.py');
  await writeFile(scriptPath, script, 'utf8');

  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', [scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(`python3 exited with ${code}\n${stderr}`));
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function userLineNumber(source: string, needle: string): number {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  assertCondition(index >= 0, `Unable to find source line containing: ${needle}`);
  return index + 1;
}

function findTraceStep(trace: TraceStep[], rawLine: number): TraceStep {
  const step = trace.find((entry) => entry.event === 'line' && entry.line === rawLine);
  assertCondition(Boolean(step), `Unable to find trace line ${rawLine}`);
  return step as TraceStep;
}

function accessVariables(step: TraceStep): Set<string> {
  return new Set((step.accesses ?? []).map((access) => access.variable).filter(Boolean) as string[]);
}

function assertNoSemanticRefIds(value: unknown, label: string): void {
  if (typeof value === 'string') {
    assertCondition(!/^node-\d+$/.test(value), `${label} should not expose node-prefixed trace refs`);
    assertCondition(!/^object-\d+$/.test(value), `${label} should not expose object-prefixed trace refs`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSemanticRefIds(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assertNoSemanticRefIds(nested, `${label}.${key}`);
    }
  }
}

async function assertAccessAttributionUsesExecutedLine(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class Solution:
    def minDistance(self, word1: str, word2: str) -> int:
        m = len(word1)
        n = len(word2)

        dp = [[0] * (n + 1) for _ in range(m + 1)]

        for i in range(m + 1):
            dp[i][0] = i
        for j in range(n + 1):
            dp[0][j] = j

        for i in range(1, m + 1):
            for j in range(1, n + 1):
                if word1[i - 1] == word2[j - 1]:
                    dp[i][j] = dp[i - 1][j - 1]
                else:
                    dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])

        return dp[m][n]
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'minDistance',
    { word1: 'horse', word2: 'ros' },
    'solution-method',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result),
    'console': _console_output,
    'userCodeStartLine': ${tracingPayload.userCodeStartLine},
    'traceLimitExceeded': _trace_limit_exceeded,
    'timeoutReason': _timeout_reason,
    'lineEventCount': _total_line_events,
    'traceStepCount': len(_trace_data)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[] };
  const ifStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'if word1') - 1
  );
  const writeStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'dp[i][j] = 1 + min') - 1
  );
  const initStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'dp[i][0] = i') - 1
  );

  const initVariables = accessVariables(initStep);
  assertCondition(initVariables.has('dp'), 'DP initialization line should carry dp write access');
  assertCondition(!initVariables.has('word1'), 'DP initialization line should not inherit word1 access');
  assertCondition(!initVariables.has('word2'), 'DP initialization line should not inherit word2 access');

  const ifVariables = accessVariables(ifStep);
  assertCondition(ifVariables.has('word1'), 'Condition line should carry word1 indexed read');
  assertCondition(ifVariables.has('word2'), 'Condition line should carry word2 indexed read');

  const writeVariables = accessVariables(writeStep);
  assertCondition(writeVariables.has('dp'), 'DP write line should carry dp accesses');
  assertCondition(!writeVariables.has('word1'), 'DP write line should not inherit word1 read from condition');
  assertCondition(!writeVariables.has('word2'), 'DP write line should not inherit word2 read from condition');

  console.log('PASS: Python runtime access attribution uses the executed line');
}

async function assertIndexedReceiverMutationsAreRecordedAsMutations(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def build_graph(edges, n):
    graph = []
    for _ in range(n):
        graph.append([])

    for u, v in edges:
        graph[u].append(v)

    return graph
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'build_graph',
    { edges: [[1, 0], [2, 0]], n: 3 },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result),
    'console': _console_output,
    'userCodeStartLine': ${tracingPayload.userCodeStartLine},
    'traceLimitExceeded': _trace_limit_exceeded,
    'timeoutReason': _timeout_reason,
    'lineEventCount': _total_line_events,
    'traceStepCount': len(_trace_data)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[] };
  const appendStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'graph[u].append(v)') - 1
  );
  const mutation = (appendStep.accesses ?? []).find((access) => (
    access.variable === 'graph' &&
    access.kind === 'mutating-call' &&
    access.method === 'append'
  ));

  assertCondition(Boolean(mutation), 'Indexed receiver append should be recorded as a mutating-call');
  assertCondition(
    Array.isArray(mutation?.indices) && mutation.indices.length === 1,
    'Indexed receiver mutation should retain the receiver index'
  );

  console.log('PASS: Python runtime records indexed receiver mutations');
}

async function assertIndexSourceProvenanceIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def inspect(nums, grid):
    i = 1
    row = 0
    col = 1
    nums[i] = grid[row][col]
    return nums[i]
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'inspect',
    { nums: [0, 0, 0], grid: [[4, 5], [6, 7]] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[] };
  const writeStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'nums[i] = grid[row][col]') - 1
  );
  assertCondition(
    (writeStep.accesses ?? []).some((access) =>
      access.variable === 'grid' &&
      access.kind === 'cell-read' &&
      JSON.stringify(access.indexSources) === JSON.stringify(['row', 'col'])
    ),
    `Python runtime should record indexSources for grid[row][col], received ${JSON.stringify(writeStep.accesses)}`
  );
  assertCondition(
    (writeStep.accesses ?? []).some((access) =>
      access.variable === 'nums' &&
      access.kind === 'indexed-write' &&
      JSON.stringify(access.indexSources) === JSON.stringify(['i'])
    ),
    `Python runtime should record indexSources for nums[i], received ${JSON.stringify(writeStep.accesses)}`
  );

  console.log('PASS: Python runtime records indexed source provenance');
}

async function assertEnumerateLoopBindingIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def inspect(words):
    for idx, word in enumerate(words):
        n = len(word)
        return n
    return 0
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'inspect',
    { words: ['apple'] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 5, 'Python enumerate binding fixture should execute successfully');
  const loopStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'for idx, word in enumerate(words):') - 1
  );
  assertCondition(
    (loopStep.accesses ?? []).some((access) => (
      access.variable === 'words' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([0]) &&
      JSON.stringify(access.indexSources) === JSON.stringify(['idx']) &&
      JSON.stringify(access.binding) === JSON.stringify({ kind: 'iteration', variable: 'word' })
    )),
    `Python enumerate loop should bind the iterated value to word, received ${JSON.stringify(loopStep.accesses)}`
  );
  assertCondition(
    (loopStep.accesses ?? []).some((access) => (
      access.variable === 'idx' &&
      access.kind === 'indexed-write' &&
      access.value === 0
    )),
    `Python enumerate loop should write the produced index binding, received ${JSON.stringify(loopStep.accesses)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some((event) => (
      event.kind === 'read' &&
      event.line === tracingPayload.userCodeStartLine + userLineNumber(source, 'for idx, word in enumerate(words):') - 1 &&
      event.target?.variable === 'words' &&
      JSON.stringify(event.target.path) === JSON.stringify([0]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify(['idx']) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'word' &&
      event.value === 'apple'
    )),
    `Python enumerate V4 runtime trace should emit indexed value binding provenance, received ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python runtime records enumerate value binding');
}

async function assertEnumerateExpressionLoopBindingIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def largest_rectangle_area(heights):
    total = 0
    for i, h in enumerate(heights + [0]):
        total += i + h
    return total
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'largest_rectangle_area',
    { heights: [2, 1] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 6, `Python enumerate expression fixture should execute successfully, received ${JSON.stringify(parsed.result)}`);
  const loopLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'for i, h in enumerate(heights + [0]):') - 1;
  const loopAccesses = parsed.trace
    .filter((step) => step.event === 'line' && step.line === loopLine)
    .flatMap((step) => step.accesses ?? []);
  assertCondition(
    loopAccesses.some((access) => (
      access.variable === 'heights + [0]' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([1]) &&
      JSON.stringify(access.indexSources) === JSON.stringify(['i']) &&
      JSON.stringify(access.binding) === JSON.stringify({ kind: 'iteration', variable: 'h' }) &&
      access.value === 1
    )),
    `Python enumerate expression loop should bind values to their expression source, received ${JSON.stringify(loopAccesses)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some((event) => (
      event.kind === 'read' &&
      event.line === loopLine &&
      event.target?.variable === 'heights + [0]' &&
      JSON.stringify(event.target.path) === JSON.stringify([2]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify(['i']) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'h' &&
      event.value === 0
    )),
    `Python V4 runtime trace should emit enumerate expression sentinel provenance, received ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python runtime records enumerate expression value binding');
}

async function assertTupleForLoopBindingIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def relax(edges):
    total = 0
    for u, v, w in edges:
        total += u + v + w
    return total
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'relax',
    { edges: [[0, 1, 5], [1, 2, 7]] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 16, 'Python tuple for-loop binding fixture should execute successfully');
  const loopStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'for u, v, w in edges:') - 1
  );
  assertCondition(
    (loopStep.accesses ?? []).some((access) => (
      access.variable === 'edges' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([0]) &&
      JSON.stringify(access.indexSources) === JSON.stringify([null]) &&
      JSON.stringify(access.binding) === JSON.stringify({ kind: 'iteration', variable: 'u,v,w' }) &&
      JSON.stringify(access.value) === JSON.stringify([0, 1, 5])
    )),
    `Python tuple for-loop should bind the produced source element, received ${JSON.stringify(loopStep.accesses)}`
  );
  assertCondition(
    (loopStep.accesses ?? []).some((access) => (
      access.variable === 'edges' &&
      access.kind === 'cell-read' &&
      JSON.stringify(access.indices) === JSON.stringify([0, 2]) &&
      JSON.stringify(access.indexSources) === JSON.stringify([null, null]) &&
      JSON.stringify(access.binding) === JSON.stringify({ kind: 'iteration', variable: 'w' }) &&
      access.value === 5
    )),
    `Python tuple for-loop should bind destructured components to concrete source cells, received ${JSON.stringify(loopStep.accesses)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some((event) => (
      event.kind === 'read' &&
      event.line === tracingPayload.userCodeStartLine + userLineNumber(source, 'for u, v, w in edges:') - 1 &&
      event.target?.variable === 'edges' &&
      JSON.stringify(event.target.path) === JSON.stringify([0, 2]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify([null, null]) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'w' &&
      event.value === 5
    )),
    `Python V4 runtime trace should emit destructured tuple iteration cell provenance, received ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python runtime records tuple for-loop binding provenance');
}

async function assertListForLoopBindingSourcesAreRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def longest_common_prefix(strs):
    prefix = strs[0]
    for word in strs:
        while not word.startswith(prefix):
            prefix = prefix[:-1]
    return prefix
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'longest_common_prefix',
    { strs: ['flower', 'flow', 'flight'] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 'fl', 'Python longest common prefix fixture should execute successfully');

  const loopLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'for word in strs:') - 1;
  const loopAccesses = parsed.trace
    .filter((step) => step.event === 'line' && step.line === loopLine)
    .flatMap((step) => step.accesses ?? []);
  assertCondition(
    loopAccesses.some((access) => (
      access.variable === 'strs' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([1]) &&
      JSON.stringify(access.indexSources) === JSON.stringify([null]) &&
      JSON.stringify(access.binding) === JSON.stringify({ kind: 'iteration', variable: 'word' }) &&
      access.value === 'flow'
    )),
    `Python list for-loop should record implicit index source provenance, received ${JSON.stringify(loopAccesses)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some((event) => (
      event.kind === 'read' &&
      event.line === loopLine &&
      event.target?.variable === 'strs' &&
      JSON.stringify(event.target.path) === JSON.stringify([1]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify([null]) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'word' &&
      event.value === 'flow'
    )),
    `Python V4 runtime trace should emit list iteration binding provenance, received ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python runtime records list for-loop index source provenance');
}

async function assertLiteralTupleUnpackingForLoopBindingIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def offsets():
    total = 0
    for di, dj in [(0, 1), (1, 0), (0, -1), (-1, 0)]:
        total += di + dj
    return total
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'offsets',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 0, 'Python literal tuple-unpacking for-loop fixture should execute successfully');

  const loopLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'for di, dj in [(0, 1)') - 1;
  const loopStep = findTraceStep(parsed.trace, loopLine);
  assertCondition(
    (loopStep.accesses ?? []).some((access) => (
      access.variable === 'di,dj' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([0]) &&
      JSON.stringify(access.binding) === JSON.stringify({ kind: 'iteration', variable: 'di,dj' }) &&
      JSON.stringify(access.value) === JSON.stringify([0, 1])
    )),
    `Python literal tuple-unpacking for-loop should bind the produced literal element, received ${JSON.stringify(loopStep.accesses)}`
  );

  assertCondition(
    parsed.runtimeTrace.events.some((event) => (
      event.kind === 'read' &&
      event.line === loopLine &&
      event.target?.variable === 'di,dj' &&
      JSON.stringify(event.target?.path) === JSON.stringify([0]) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'di,dj' &&
      JSON.stringify(event.value) === JSON.stringify([0, 1])
    )),
    `Python V4 runtime trace should emit an iteration read for literal tuple-unpacking, received ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python runtime records literal tuple-unpacking for-loop V4 binding provenance');
}

async function assertTupleAssignmentScalarWritesAreRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def dimensions(grid):
    rows, cols = len(grid), len(grid[0])
    return rows * cols
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'dimensions',
    { grid: [[1, 2, 3], [4, 5, 6]] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 6, 'Python tuple assignment fixture should execute successfully');
  const assignmentLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'rows, cols =') - 1;
  const assignmentStep = findTraceStep(
    parsed.trace,
    assignmentLine
  );
  const writes = (assignmentStep.accesses ?? []).filter((access) => access.kind === 'indexed-write');
  assertCondition(
    writes.some((access) => access.variable === 'rows' && access.value === 2) &&
      writes.some((access) => access.variable === 'cols' && access.value === 3),
    `Python tuple assignment should emit scalar writes for rows and cols, received ${JSON.stringify(assignmentStep.accesses)}`
  );
  const runtimeWrites = parsed.runtimeTrace.events.filter((event) => (
    event.kind === 'write' &&
    event.line === assignmentLine &&
    (event.target?.variable === 'rows' || event.target?.variable === 'cols')
  ));
  assertCondition(
    runtimeWrites.some((event) => event.target?.variable === 'rows' && event.value === 2) &&
      runtimeWrites.some((event) => event.target?.variable === 'cols' && event.value === 3),
    `Python tuple assignment should emit V4 write events for rows and cols, received ${JSON.stringify(runtimeWrites)}`
  );

  console.log('PASS: Python runtime records tuple assignment scalar writes');
}

async function assertChainedAssignmentScalarWritesAreRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def solve(nums):
    mid = len(nums) // 2
    i = j = mid + 1
    return i + j
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'solve',
    { nums: [1, 2, 3, 4] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 6, 'Python chained assignment fixture should execute successfully');
  const assignmentLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'i = j = mid + 1') - 1;
  const assignmentStep = findTraceStep(parsed.trace, assignmentLine);
  const writes = (assignmentStep.accesses ?? []).filter((access) => access.kind === 'indexed-write');
  assertCondition(
    writes.some((access) => access.variable === 'i' && access.value === 3) &&
      writes.some((access) => access.variable === 'j' && access.value === 3),
    `Python chained assignment should emit legacy scalar writes for i and j, received ${JSON.stringify(assignmentStep.accesses)}`
  );

  const runtimeWrites = parsed.runtimeTrace.events.filter((event) => (
    event.kind === 'write' &&
    event.line === assignmentLine &&
    (event.target?.variable === 'i' || event.target?.variable === 'j')
  ));
  assertCondition(
    runtimeWrites.some((event) => event.target?.variable === 'i' && event.value === 3) &&
      runtimeWrites.some((event) => event.target?.variable === 'j' && event.value === 3),
    `Python chained assignment should emit V4 write events for i and j, received ${JSON.stringify(runtimeWrites)}`
  );

  console.log('PASS: Python runtime records chained assignment scalar writes');
}

async function assertListComprehensionAssignmentEmitsSingleWriteFrame(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def clone(adjList):
    n = len(adjList)
    cloned = [[] for _ in range(n)]
    return cloned
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'clone',
    { adjList: [[2], [1], [], []] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  assertCondition(
    JSON.stringify(parsed.result) === JSON.stringify([[], [], [], []]),
    'Python list-comprehension assignment fixture should execute successfully'
  );
  const assignmentLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'cloned =') - 1;
  const assignmentSteps = parsed.trace.filter((entry) => entry.event === 'line' && entry.line === assignmentLine);
  assertCondition(
    assignmentSteps.length === 1,
    `Python list-comprehension assignment should emit one public line frame, received ${JSON.stringify(assignmentSteps)}`
  );
  assertCondition(
    (assignmentSteps[0].accesses ?? []).some((access) =>
      access.variable === 'cloned' &&
      access.kind === 'indexed-write' &&
      JSON.stringify(access.value) === JSON.stringify([[], [], [], []])
    ),
    `Python list-comprehension assignment should emit cloned write on the assignment frame, received ${JSON.stringify(assignmentSteps[0].accesses)}`
  );

  console.log('PASS: Python runtime compacts list-comprehension assignment writes');
}

async function assertInPlaceSortMutationIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def earliest(intervals):
    intervals.sort(key=lambda x: x[0])
    return intervals[0][0]
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'earliest',
    { intervals: [[5, 10], [0, 30], [15, 20]] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  assertCondition(parsed.result === 0, 'Python in-place sort fixture should execute successfully');
  const sortStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'intervals.sort') - 1
  );
  assertCondition(
    (sortStep.accesses ?? []).some((access) => (
      access.variable === 'intervals' &&
      access.kind === 'mutating-call' &&
      access.method === 'sort' &&
      JSON.stringify(access.args) === JSON.stringify(['key=<lambda>'])
    )),
    `Python list.sort should emit a receiver mutation with lambda-safe key args, received ${JSON.stringify(sortStep.accesses)}`
  );

  console.log('PASS: Python runtime records in-place sort mutation provenance');
}

async function assertTupleKeyDictProvenanceIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def inspect():
    right_id = {}
    nr = 1
    nc = 2
    missing = (nr, nc) not in right_id
    right_id[(nr, nc)] = 7
    value = right_id[(nr, nc)]
    return value + (1 if missing else 0)
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'inspect',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; runtimeTrace: { events: RuntimeTraceEvent[] }; result: unknown };
  assertCondition(parsed.result === 8, 'Python tuple-key dict fixture should execute successfully');

  const membershipLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'missing = (nr, nc) not in right_id') - 1;
  const writeLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'right_id[(nr, nc)] = 7') - 1;
  const readLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'value = right_id[(nr, nc)]') - 1;
  const membershipStep = findTraceStep(parsed.trace, membershipLine);
  const writeStep = findTraceStep(parsed.trace, writeLine);
  const readStep = findTraceStep(parsed.trace, readLine);

  assertCondition(
    (membershipStep.accesses ?? []).some((access) => (
      access.variable === 'right_id' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([[1, 2]]) &&
      JSON.stringify(access.indexSources) === JSON.stringify(['(nr, nc)']) &&
      access.value === false
    )),
    `Python tuple-key dict membership should carry concrete key and source, received ${JSON.stringify(membershipStep.accesses)}`
  );
  assertCondition(
    (writeStep.accesses ?? []).some((access) => (
      access.variable === 'right_id' &&
      access.kind === 'indexed-write' &&
      JSON.stringify(access.indices) === JSON.stringify([[1, 2]]) &&
      JSON.stringify(access.indexSources) === JSON.stringify(['(nr, nc)']) &&
      access.value === 7
    )),
    `Python tuple-key dict write should carry concrete key and source, received ${JSON.stringify(writeStep.accesses)}`
  );
  assertCondition(
    (readStep.accesses ?? []).some((access) => (
      access.variable === 'right_id' &&
      access.kind === 'indexed-read' &&
      JSON.stringify(access.indices) === JSON.stringify([[1, 2]]) &&
      JSON.stringify(access.indexSources) === JSON.stringify(['(nr, nc)']) &&
      access.value === 7
    )),
    `Python tuple-key dict read should carry concrete key and source, received ${JSON.stringify(readStep.accesses)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some((event) => (
      event.kind === 'read' &&
      event.line === readLine &&
      event.target?.variable === 'right_id' &&
      JSON.stringify(event.target.path) === JSON.stringify([[1, 2]]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify(['(nr, nc)']) &&
      event.value === 7
    )),
    `Python V4 runtime trace should emit tuple-key read target provenance, received ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python runtime records tuple-key dict provenance');
}

async function assertObjectMemberDictMembershipProvenanceIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class TrieNode:
    def __init__(self):
        self.children = {}

def inspect(char):
    node = TrieNode()
    if char not in node.children:
        node.children[char] = TrieNode()
    return len(node.children)
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'inspect',
    { char: 'a' },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; runtimeTrace: { events: RuntimeTraceEvent[] }; result: unknown };
  assertCondition(parsed.result === 1, 'Python object-member dict membership fixture should execute successfully');

  const membershipLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'if char not in node.children') - 1;
  const membershipStep = findTraceStep(parsed.trace, membershipLine);
  assertCondition(
    (membershipStep.accesses ?? []).some((access) => (
      access.variable === 'node' &&
      access.kind === 'cell-read' &&
      JSON.stringify(access.indices) === JSON.stringify(['children', 'a']) &&
      JSON.stringify(access.indexSources) === JSON.stringify([null, 'char']) &&
      access.value === false
    )),
    `Python object-member dict membership should carry child key provenance, received ${JSON.stringify(membershipStep.accesses)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some((event) => (
      event.kind === 'read' &&
      event.line === membershipLine &&
      event.target?.variable === 'node' &&
      JSON.stringify(event.target.path) === JSON.stringify(['children', 'a']) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify([null, 'char']) &&
      event.value === false
    )),
    `Python V4 runtime trace should emit object-member membership provenance, received ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python runtime records object-member dict membership provenance');
}

async function assertComputedDeleteMutationArgsAreRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class Node:
    def __init__(self, key):
        self.key = key

class Cache:
    def __init__(self):
        self.cache = {1: Node(1)}
        self.tail = Node(1)

    def evict(self):
        lru = self.tail
        del self.cache[lru.key]
        return len(self.cache)

def run():
    cache = Cache()
    return cache.evict()
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'run',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 0, 'Python computed delete fixture should execute successfully');

  const deleteLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'del self.cache[lru.key]') - 1;
  const deleteStep = findTraceStep(parsed.trace, deleteLine);
  assertCondition(
    (deleteStep.accesses ?? []).some((access) => (
      access.variable === 'self' &&
      access.kind === 'mutating-call' &&
      access.method === 'remove' &&
      JSON.stringify(access.indices) === JSON.stringify(['cache', 1]) &&
      JSON.stringify(access.indexSources) === JSON.stringify([null, 'lru.key']) &&
      JSON.stringify(access.args) === JSON.stringify([1])
    )),
    `Python computed del should emit remove args on legacy accesses, received ${JSON.stringify(deleteStep.accesses)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some((event) => (
      event.kind === 'mutate' &&
      event.line === deleteLine &&
      event.target?.variable === 'self' &&
      JSON.stringify(event.target.path) === JSON.stringify(['cache', 1]) &&
      JSON.stringify(event.args) === JSON.stringify([1])
    )),
    `Python V4 runtime trace should emit delete mutation args, received ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python runtime records computed delete mutation args');
}

async function assertTraceReferenceIdsAreNeutral(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class Box:
    def __init__(self, value):
        self.value = value

def make_cycle():
    first = ListNode(1)
    second = ListNode(2)
    first.next = second
    second.next = first
    box = Box(first)
    return box.value.val
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'make_cycle',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events,
        'lineEventCount': len([event for event in _trace_events if event.get('kind') == 'line']),
        'traceStepCount': len(_trace_events)
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; runtimeTrace: { events: unknown[] } };

  assertNoSemanticRefIds(parsed.trace, 'python trace steps');
  assertNoSemanticRefIds(parsed.runtimeTrace.events, 'python runtime trace events');

  const serialized = JSON.stringify({ trace: parsed.trace, events: parsed.runtimeTrace.events });
  assertCondition(serialized.includes('"__id__":"r'), 'Trace should still emit opaque ids for cycle-safe refs');
  assertCondition(serialized.includes('"__ref__":"r'), 'Trace should still emit opaque refs for cycles');

  console.log('PASS: Python runtime trace reference ids are neutral');
}

async function assertCustomObjectLocalAliasesMaterializePayloads(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class TrieNode:
    def __init__(self):
        self.children = {}
        self.index = -1

class WordFilter:
    def __init__(self, words):
        self.root = TrieNode()
        for idx, word in enumerate(words):
            node = self.root
            node.children["a"] = TrieNode()
            node = node.children["a"]
            node.index = idx

def build(words):
    wf = WordFilter(words)
    return wf.root.children["a"].index
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'build',
    { words: ['apple'] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  assertCondition(parsed.result === 0, 'Python trie alias fixture should execute successfully');

  const rootAliasStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'node.children["a"] = TrieNode()') - 1
  );
  const rootNode = rootAliasStep.variables?.node as Record<string, unknown> | undefined;
  assertCondition(
    Boolean(rootNode) &&
      rootNode?.__class__ === 'TrieNode' &&
      rootNode?.__id__ === ((rootAliasStep.variables?.self as Record<string, unknown> | undefined)?.root as Record<string, unknown> | undefined)?.__id__,
    `Python custom object alias should materialize root TrieNode payload, received ${JSON.stringify(rootAliasStep.variables?.node)}`
  );

  const childAliasStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'node.index = idx') - 1
  );
  const childNode = childAliasStep.variables?.node as Record<string, unknown> | undefined;
  assertCondition(
    Boolean(childNode) &&
      childNode?.__class__ === 'TrieNode' &&
      childNode?.index === 0 &&
      typeof childNode?.__id__ === 'string',
    `Python custom object alias should materialize child TrieNode payload, received ${JSON.stringify(childAliasStep.variables?.node)}`
  );

  console.log('PASS: Python runtime materializes custom object local aliases');
}

async function assertCustomObjectIdsAreStableAcrossFrames(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class TrieNode:
    def __init__(self):
        self.children = {}

class Holder:
    def __init__(self):
        self.root = TrieNode()
        node = self.root
        node.children["a"] = TrieNode()

def build():
    holder = Holder()
    return len(holder.root.children)
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'build',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  assertCondition(parsed.result === 1, 'Python stable object id fixture should execute successfully');

  const holderRootStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'node.children["a"] = TrieNode()') - 1
  );
  const holderSelf = holderRootStep.variables?.self as Record<string, unknown> | undefined;
  const rootFromSelf = holderSelf?.root as Record<string, unknown> | undefined;
  const rootFromNode = holderRootStep.variables?.node as Record<string, unknown> | undefined;
  assertCondition(
    typeof holderSelf?.__id__ === 'string' &&
      typeof rootFromSelf?.__id__ === 'string' &&
      rootFromSelf.__id__ === rootFromNode?.__id__ &&
      holderSelf.__id__ !== rootFromSelf.__id__,
    `Python custom object ids should be globally stable and non-colliding, received ${JSON.stringify(holderRootStep.variables)}`
  );

  const constructorStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'self.children = {}') - 1
  );
  const constructorSelf = constructorStep.variables?.self as Record<string, unknown> | undefined;
  assertCondition(
    constructorSelf?.__id__ === rootFromSelf?.__id__ || constructorSelf?.__id__ === 'ref-2',
    `Constructor self should use the constructed object id, not collide with Holder self; received ${JSON.stringify(constructorSelf)}`
  );

  console.log('PASS: Python runtime keeps custom object ids stable across frames');
}

async function assertObjectFieldSubscriptReadCarriesValue(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class TrieNode:
    def __init__(self):
        self.children = {}
        self.index = -1

def inspect():
    root = TrieNode()
    root.children["a"] = TrieNode()
    key = "a"
    node = root.children[key]
    return node.index
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'inspect',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; runtimeTrace: { events: Array<Record<string, unknown>> }; result: unknown };
  assertCondition(parsed.result === -1, 'Python object field subscript fixture should execute successfully');

  const readStep = findTraceStep(
    parsed.trace,
    tracingPayload.userCodeStartLine + userLineNumber(source, 'node = root.children[key]') - 1
  );
  const readAccess = (readStep.accesses ?? []).find((access) => access.variable === 'root' && access.kind === 'cell-read');
  assertCondition(
    Boolean(readAccess) &&
      JSON.stringify(readAccess?.indices) === JSON.stringify(['children', 'a']) &&
      JSON.stringify(readAccess?.indexSources) === JSON.stringify([null, 'key']) &&
      (readAccess?.value as Record<string, unknown> | undefined)?.__class__ === 'TrieNode',
    `Python object field subscript read should carry path and read value, received ${JSON.stringify(readStep.accesses)}`
  );

  const runtimeRead = parsed.runtimeTrace.events.find((event) => (
    event.kind === 'read' &&
    JSON.stringify(event.target) === JSON.stringify({ variable: 'root', path: ['children', 'a'], indexSources: [null, 'key'] })
  ));
  assertCondition(
    (runtimeRead?.value as Record<string, unknown> | undefined)?.__class__ === 'TrieNode',
    `Python runtime read event should preserve the access value before assignment changes locals, received ${JSON.stringify(runtimeRead)}`
  );

  console.log('PASS: Python runtime records object-field subscript read values');
}

async function assertAttributeReadCarriesPreMutationValue(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def inspect():
    head = ListNode(1, ListNode(2))
    curr = head
    next_temp = curr.next
    curr.next = None
    return next_temp.val
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'inspect',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; runtimeTrace: { events: Array<Record<string, unknown>> }; result: unknown };
  assertCondition(parsed.result === 2, 'Python linked-list attribute fixture should execute successfully');

  const readLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'next_temp = curr.next') - 1;
  const readStep = findTraceStep(parsed.trace, readLine);
  const readAccess = (readStep.accesses ?? []).find((access) => (
    access.variable === 'curr' &&
    access.kind === 'indexed-read' &&
    JSON.stringify(access.indices) === JSON.stringify(['next'])
  ));
  assertCondition(
    (readAccess?.value as Record<string, unknown> | undefined)?.val === 2,
    `Python attribute read should carry the pre-mutation next node value, received ${JSON.stringify(readStep.accesses)}`
  );

  const runtimeRead = parsed.runtimeTrace.events.find((event) => (
    event.kind === 'read' &&
    event.line === readLine &&
    JSON.stringify(event.target) === JSON.stringify({ variable: 'curr', path: ['next'] })
  ));
  assertCondition(
    (runtimeRead?.value as Record<string, unknown> | undefined)?.val === 2,
    `Python runtime attribute read should not fall back to post-line curr.next, received ${JSON.stringify(runtimeRead)}`
  );

  console.log('PASS: Python runtime records attribute read values before later mutations');
}

async function assertTraceCaptureLimitPreservesOutput(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def sum_to(n):
    total = 0
    for i in range(n):
        total += i
    return total
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'sum_to',
    { n: 200 },
    'function',
    { maxTraceSteps: 5, maxStoredEvents: 20, maxLineEvents: 1000, maxSingleLineHits: 1000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events,
        'lineEventCount': len([event for event in _trace_events if event.get('kind') == 'line']),
        'traceStepCount': len(_trace_events)
    },
    'result': _serialize_output(_result),
    'traceLimitExceeded': _trace_limit_exceeded,
    'timeoutReason': _timeout_reason,
    'traceStepCount': len(_trace_data)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: unknown[] };
    result: unknown;
    traceLimitExceeded?: boolean;
    timeoutReason?: string;
  };

  assertCondition(parsed.result === 19900, 'Trace capture limit should preserve Python output');
  assertCondition(parsed.traceLimitExceeded === true, 'Trace capture limit should set Python traceLimitExceeded');
  assertCondition(parsed.timeoutReason === 'trace-limit', 'Trace capture limit should use Python trace-limit reason');
  assertCondition(parsed.runtimeTrace.events.length <= 20, 'Trace capture limit should bound Python runtime events');

  console.log('PASS: Python runtime trace capture limit preserves output');
}

async function assertDefaultStoredRuntimeEventBudgetAllowsScriptReturns(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def find_order(num_courses, prerequisites):
    graph = []
    for _ in range(num_courses):
        graph.append([])
    in_degree = [0] * num_courses

    for course, prereq in prerequisites:
        graph[prereq].append(course)
        in_degree[course] += 1

    queue = [i for i in range(num_courses) if in_degree[i] == 0]
    order = []

    while queue:
        node = queue.pop(0)
        order.append(node)

        for neighbor in graph[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    return order if len(order) == num_courses else []

result = find_order(4, [[1, 0], [2, 0], [3, 1], [3, 2]])
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    '',
    {},
    'function',
    { maxTraceSteps: 4000, maxLineEvents: 20000, maxSingleLineHits: 4000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result),
    'traceLimitExceeded': _trace_limit_exceeded,
    'timeoutReason': _timeout_reason
}))
`);
  const parsed = JSON.parse(stdout) as {
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
    traceLimitExceeded?: boolean;
    timeoutReason?: string;
  };

  assertCondition(
    JSON.stringify(parsed.result) === JSON.stringify([0, 1, 2, 3]),
    `Python script-mode topological sort should return expected output, got ${JSON.stringify(parsed.result)}`
  );
  assertCondition(
    parsed.traceLimitExceeded !== true,
    `Default Python runtime event budget should not truncate this script, reason=${parsed.timeoutReason ?? 'none'}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some((event) => event.kind === 'return' && event.function === 'find_order'),
    `Default Python runtime event budget should preserve function returns, got ${JSON.stringify(parsed.runtimeTrace.events.slice(-20))}`
  );

  console.log('PASS: Python default runtime event budget preserves script returns');
}

async function assertRuntimeValueSerializationCap(): Promise<void> {
  const stdout = await runPythonScript(`import builtins as _builtins
import json
import math
${PYTHON_CLASS_DEFINITIONS}
${PYTHON_TRACE_SERIALIZE_FUNCTION}
values = list(range(70))
mapping = {str(value): value for value in values}
visited = set(values)
print(json.dumps({
    'values': _serialize(values),
    'outputValues': _serialize_output(values),
    'mapping': _serialize(mapping),
    'visited': _serialize(visited),
}))
`);
  const parsed = JSON.parse(stdout) as {
    values: unknown[];
    outputValues: unknown[];
    mapping: Record<string, unknown>;
    visited: { values?: unknown[]; __truncated__?: unknown; remaining?: unknown };
  };

  assertCondition(
    Array.isArray(parsed.values) &&
      parsed.values.length === 65 &&
      JSON.stringify(parsed.values[64]) === JSON.stringify({ __truncated__: true, remaining: 6 }),
    'Python large lists should serialize first 64 items plus truncation marker'
  );
  assertCondition(
    Array.isArray(parsed.outputValues) && parsed.outputValues.length === 70 && parsed.outputValues[69] === 69,
    'Python final output serializer should not use the trace snapshot item cap'
  );
  assertCondition(
    parsed.mapping.__truncated__ === true && parsed.mapping.remaining === 6,
    'Python large dicts should serialize truncation fields'
  );
  assertCondition(
    Array.isArray(parsed.visited.values) &&
      parsed.visited.values.length === 64 &&
      parsed.visited.__truncated__ === true &&
      parsed.visited.remaining === 6,
    'Python large sets should serialize first 64 values plus truncation fields'
  );

  console.log('PASS: Python runtime value serialization cap');
}

async function assertDefaultPreludeImportsAreAvailable(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def solve(nums):
    q = deque(nums)
    index = bisect_left(sorted(nums), 2)
    heappush(nums, 0)
    pattern = re.compile("a+")
    return [
        q.popleft(),
        index,
        heappop(nums),
        list(islice(count(5), 2)),
        itemgetter(1)(("x", "y")),
        string.ascii_lowercase[:3],
        pattern.fullmatch("aaa") is not None,
    ]
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'solve',
    { nums: [3, 1, 2] },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { result: unknown };
  assertCondition(
    JSON.stringify(parsed.result) === JSON.stringify([3, 1, 0, [5, 6], 'y', 'abc', true]),
    `Python default prelude imports should be available without user imports, got ${JSON.stringify(parsed.result)}`
  );

  console.log('PASS: Python runtime default convenience imports');
}

async function assertScriptModePreservesResultSerializer(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `nums = [2, 7, 11, 15]
target = 9
seen = {}
result = None
for i, value in enumerate(nums):
    need = target - value
    if need in seen:
        result = [seen[need], i]
        break
    seen[value] = i
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    '',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  const errorStep = parsed.trace.find((step) => step.event === 'exception');

  assertCondition(
    JSON.stringify(parsed.result) === JSON.stringify([0, 1]),
    `Python script mode should serialize the result, got ${JSON.stringify(parsed.result)}`
  );
  assertCondition(
    !errorStep,
    `Python script mode should not lose harness serializer globals, got ${JSON.stringify(errorStep)}`
  );

  console.log('PASS: Python script mode preserves result serialization helpers');
}

async function assertIndexedAugAssignAndLoopBindingUseConcreteValues(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def solve():
    graph = [[1], []]
    in_degree = [0, 0]
    course = 1
    in_degree[course] += 1
    course = 0
    for next_course in graph[course]:
        in_degree[next_course] -= 1
    return in_degree
`;

  const deps: RuntimeDeps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'solve',
    {},
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  assertCondition(JSON.stringify(parsed.result) === JSON.stringify([0, 0]), 'Python indexed augassign fixture should execute');

  const incrementLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'in_degree[course] += 1') - 1;
  const decrementLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'in_degree[next_course] -= 1') - 1;
  const loopLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'for next_course in graph[course]') - 1;
  const incrementStep = findTraceStep(parsed.trace, incrementLine);
  const decrementStep = findTraceStep(parsed.trace, decrementLine);
  const loopStep = findTraceStep(parsed.trace, loopLine);

  const incrementRead = incrementStep.accesses?.find((access) => access.variable === 'in_degree' && access.kind === 'indexed-read');
  const incrementWrite = incrementStep.accesses?.find((access) => access.variable === 'in_degree' && access.kind === 'indexed-write');
  assertCondition(incrementRead?.value === 0 && incrementWrite?.value === 1, 'Python += indexed trace should record pre/post values');
  assertCondition(
    JSON.stringify(incrementWrite.indexSources) === JSON.stringify(['course']),
    'Python += indexed trace should preserve index source'
  );

  const bindingRead = loopStep.accesses?.find(
    (access) =>
      access.variable === 'graph' &&
      access.kind === 'cell-read' &&
      JSON.stringify(access.indices) === JSON.stringify([0, 0]) &&
      JSON.stringify(access.indexSources) === JSON.stringify(['course', null]) &&
      JSON.stringify(access.binding) === JSON.stringify({ kind: 'iteration', variable: 'next_course' })
  );
  assertCondition(Boolean(bindingRead), 'Python for x in graph[course] should record indexed iteration binding provenance');

  const decrementRead = decrementStep.accesses?.find((access) => access.variable === 'in_degree' && access.kind === 'indexed-read');
  const decrementWrite = decrementStep.accesses?.find((access) => access.variable === 'in_degree' && access.kind === 'indexed-write');
  assertCondition(decrementRead?.value === 1 && decrementWrite?.value === 0, 'Python -= indexed trace should record pre/post values');

  console.log('PASS: Python indexed augmented assignment and subscript for-loop binding provenance');
}

async function assertSliceForLoopBindingIsRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `
def solve(account):
    seen = []
    for email in account[1:]:
        seen.append(email)
    return seen
`;
  const deps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'solve',
    { account: ['John', 'john@example.com', 'johnny@example.com'] },
    'function',
    { maxTraceSteps: 1000, maxLineEvents: 10000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  assertCondition(
    JSON.stringify(parsed.result) === JSON.stringify(['john@example.com', 'johnny@example.com']),
    'Python slice for-loop binding fixture should execute'
  );

  const bindingRead = parsed.trace
    .flatMap((step) => step.accesses ?? [])
    .find(
      (access) =>
        access.variable === 'account' &&
        access.kind === 'indexed-read' &&
        JSON.stringify(access.indices) === JSON.stringify([1]) &&
        JSON.stringify(access.binding) === JSON.stringify({ kind: 'iteration', variable: 'email' }) &&
        access.value === 'john@example.com'
    );
  assertCondition(
    Boolean(bindingRead),
    `Python for x in account[1:] should record slice iteration binding provenance, received ${JSON.stringify(parsed.trace)}`
  );

  console.log('PASS: Python slice for-loop binding provenance');
}

async function assertBooleanIndexedAssignmentReadsAndWrites(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `
def solve(nums, target):
    dp = [False] * (target + 1)
    dp[0] = True
    for num in nums:
        for j in range(target, num - 1, -1):
            dp[j] = dp[j] or dp[j - num]
    return dp[target]
`;
  const deps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'solve',
    { nums: [2], target: 4 },
    'function',
    { maxTraceSteps: 1000, maxLineEvents: 10000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  assertCondition(parsed.result === false, 'Python boolean indexed assignment fixture should execute');

  const assignmentStep = parsed.trace.find((step) =>
    (step.accesses ?? []).some((access) =>
      access.variable === 'dp'
      && access.kind === 'indexed-read'
      && JSON.stringify(access.indices) === JSON.stringify([4])
      && JSON.stringify(access.indexSources) === JSON.stringify(['j']))
    && (step.accesses ?? []).some((access) =>
      access.variable === 'dp'
      && access.kind === 'indexed-read'
      && JSON.stringify(access.indices) === JSON.stringify([2])
      && JSON.stringify(access.indexSources) === JSON.stringify(['j - num']))
    && (step.accesses ?? []).some((access) =>
      access.variable === 'dp'
      && access.kind === 'indexed-write'
      && JSON.stringify(access.indices) === JSON.stringify([4])
      && JSON.stringify(access.indexSources) === JSON.stringify(['j']))
  );
  assertCondition(Boolean(assignmentStep), `Python boolean indexed assignment step should exist, received ${JSON.stringify(parsed.trace)}`);
  assertCondition(
    assignmentStep?.accesses?.some((access) =>
      access.variable === 'dp'
      && access.kind === 'indexed-read'
      && JSON.stringify(access.indices) === JSON.stringify([4])
      && JSON.stringify(access.indexSources) === JSON.stringify(['j'])
      && access.value === false) === true,
    `Python dp[j] boolean assignment should emit left indexed read, received ${JSON.stringify(assignmentStep.accesses)}`
  );
  assertCondition(
    assignmentStep?.accesses?.some((access) =>
      access.variable === 'dp'
      && access.kind === 'indexed-read'
      && JSON.stringify(access.indices) === JSON.stringify([2])
      && JSON.stringify(access.indexSources) === JSON.stringify(['j - num'])
      && access.value === false) === true,
    `Python dp[j] boolean assignment should emit right indexed read, received ${JSON.stringify(assignmentStep.accesses)}`
  );
  assertCondition(
    assignmentStep?.accesses?.some((access) =>
      access.variable === 'dp'
      && access.kind === 'indexed-write'
      && JSON.stringify(access.indices) === JSON.stringify([4])
      && JSON.stringify(access.indexSources) === JSON.stringify(['j'])
      && access.value === false) === true,
    `Python dp[j] boolean assignment should emit indexed write, received ${JSON.stringify(assignmentStep.accesses)}`
  );

  console.log('PASS: Python boolean indexed assignment emits indexed reads and writes');
}

async function assertRecursiveCallActivationRuntimeEventsAreRecorded(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class Solution:
    def combinationSum(self, candidates, target):
        result = []
        path = []
        def backtrack(start, remaining):
            if remaining == 0:
                result.append(path[:])
                return
            if remaining < 0:
                return
            for i in range(start, len(candidates)):
                path.append(candidates[i])
                backtrack(i, remaining - candidates[i])
                path.pop()
        backtrack(0, target)
        return result
`;

  const deps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'combinationSum',
    { candidates: [2, 3], target: 4 },
    'solution-method',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };

  assertCondition(
    JSON.stringify(parsed.result) === JSON.stringify([[2, 2]]),
    `Python recursive call activation fixture should execute, got ${JSON.stringify(parsed.result)}`
  );

  const recursiveCallLine =
    tracingPayload.userCodeStartLine + userLineNumber(source, 'backtrack(i, remaining - candidates[i])') - 1;
  const recursiveLineStep = parsed.trace.find(
    (step) => step.event === 'line' && step.line === recursiveCallLine && step.function === 'backtrack'
  );
  assertCondition(Boolean(recursiveLineStep), 'Python recursive invocation line step should exist');
  assertCondition(
    recursiveLineStep?.accesses?.some(
      (access) =>
        access.variable === 'candidates' &&
        access.kind === 'indexed-read' &&
        JSON.stringify(access.indexSources) === JSON.stringify(['i'])
    ) === true,
    `Python recursive invocation line should keep argument read evidence, got ${JSON.stringify(recursiveLineStep?.accesses)}`
  );

  const activationCalls = parsed.runtimeTrace.events.filter(
    (event) => event.kind === 'call' && event.function === 'backtrack'
  );
  const recursiveActivationIndex = parsed.runtimeTrace.events.findIndex(
    (event) =>
      event.kind === 'call' &&
      event.function === 'backtrack' &&
      event.args &&
      !Array.isArray(event.args) &&
      event.args.start === 0 &&
      event.args.remaining === 2
  );
  const parentCallsiteLineIndex = parsed.runtimeTrace.events.findIndex(
    (event, index) =>
      index < recursiveActivationIndex &&
      event.kind === 'line' &&
      event.line === recursiveCallLine &&
      event.function === 'backtrack' &&
      event.callStack?.at(-1)?.args?.remaining === 4
  );
  const firstChildLineIndex = parsed.runtimeTrace.events.findIndex(
    (event, index) =>
      index > recursiveActivationIndex &&
      event.kind === 'line' &&
      event.function === 'backtrack' &&
      event.callStack?.at(-1)?.args?.remaining === 2
  );
  assertCondition(
    recursiveActivationIndex >= 0,
    `Python recursive activation should be present, got ${JSON.stringify(parsed.runtimeTrace.events)}`
  );
  assertCondition(
    parentCallsiteLineIndex >= 0 && parentCallsiteLineIndex < recursiveActivationIndex,
    `Python recursive call-site line should precede child activation. callsite=${parentCallsiteLineIndex}, call=${recursiveActivationIndex}, events=${JSON.stringify(parsed.runtimeTrace.events)}`
  );
  assertCondition(
    firstChildLineIndex > recursiveActivationIndex,
    `Python recursive child work should begin after child activation. call=${recursiveActivationIndex}, childLine=${firstChildLineIndex}, events=${JSON.stringify(parsed.runtimeTrace.events)}`
  );
  assertCondition(
    activationCalls.some(
      (event) =>
        event.args &&
        !Array.isArray(event.args) &&
        event.args.start === 0 &&
        event.args.remaining === 4 &&
        event.callStack?.at(-1)?.function === 'backtrack' &&
        event.callStack?.at(-1)?.args?.remaining === 4
    ),
    `Python should emit top-level backtrack activation with named args and stack, got ${JSON.stringify(activationCalls)}`
  );
  assertCondition(
    activationCalls.some(
      (event) =>
        event.args &&
        !Array.isArray(event.args) &&
        event.args.start === 0 &&
        event.args.remaining === 2 &&
        event.callStack?.at(-1)?.function === 'backtrack' &&
        event.callStack?.at(-1)?.args?.remaining === 2 &&
        (event.callStack?.filter((frame) => frame.function === 'backtrack').length ?? 0) >= 2
    ),
    `Python should emit recursive backtrack activation with named args and stack, got ${JSON.stringify(activationCalls)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some(
      (event) => event.kind === 'return' && event.function === 'backtrack' && (event.callStack?.length ?? 0) > 0
    ),
    `Python recursive activations should emit returns with call stack context, got ${JSON.stringify(parsed.runtimeTrace.events)}`
  );

  console.log('PASS: Python recursive activations emit named call/return events');
}

async function assertBuiltinSumRecordsConsumedCollectionReads(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `def solve(nums, stones):
    total = sum(nums)
    weight = sum(stones)
    return total + weight
`;

  const deps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'solve',
    { nums: [4, 5], stones: [2, 7, 1] },
    'function',
    { maxTraceSteps: 1000, maxLineEvents: 10000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'runtimeTrace': {
        'events': _trace_events
    },
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as {
    trace: TraceStep[];
    runtimeTrace: { events: RuntimeTraceEvent[] };
    result: unknown;
  };
  assertCondition(parsed.result === 19, 'Python builtin sum fixture should execute');

  const numsSumLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'total = sum(nums)') - 1;
  const stonesSumLine = tracingPayload.userCodeStartLine + userLineNumber(source, 'weight = sum(stones)') - 1;
  const numsStep = findTraceStep(parsed.trace, numsSumLine);
  const stonesStep = findTraceStep(parsed.trace, stonesSumLine);

  assertCondition(
    numsStep.accesses?.some(
      (access) =>
        access.variable === 'nums' &&
        access.kind === 'indexed-read' &&
        JSON.stringify(access.indices) === JSON.stringify([0]) &&
        access.value === 4
    ) === true &&
      numsStep.accesses?.some(
        (access) =>
          access.variable === 'nums' &&
          access.kind === 'indexed-read' &&
          JSON.stringify(access.indices) === JSON.stringify([1]) &&
          access.value === 5
      ) === true,
    `Python sum(nums) should emit consumed nums reads, got ${JSON.stringify(numsStep.accesses)}`
  );
  assertCondition(
    stonesStep.accesses?.some(
      (access) =>
        access.variable === 'stones' &&
        access.kind === 'indexed-read' &&
        JSON.stringify(access.indices) === JSON.stringify([2]) &&
        access.value === 1
    ) === true,
    `Python sum(stones) should emit consumed stones reads, got ${JSON.stringify(stonesStep.accesses)}`
  );
  assertCondition(
    parsed.runtimeTrace.events.some(
      (event) =>
        event.kind === 'read' &&
        event.line === numsSumLine &&
        JSON.stringify(event.target) === JSON.stringify({ variable: 'nums', path: [0] }) &&
        event.value === 4
    ),
    'Python runtime trace should include a read event for sum(nums)'
  );
  assertCondition(
    parsed.runtimeTrace.events.some(
      (event) =>
        event.kind === 'read' &&
        event.line === stonesSumLine &&
        JSON.stringify(event.target) === JSON.stringify({ variable: 'stones', path: [2] }) &&
        event.value === 1
    ),
    'Python runtime trace should include a read event for sum(stones)'
  );

  console.log('PASS: Python builtin sum records consumed collection reads');
}

async function assertFunctionStyleFallsBackToSolutionMethod(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const source = `class Solution:
    def findTargetSumWays(self, nums: list[int], target: int) -> int:
        total = sum(nums)
        if abs(target) > total or (total + target) % 2 != 0:
            return 0

        subset_target = (total + target) // 2
        dp = [0] * (subset_target + 1)
        dp[0] = 1

        for num in nums:
            for j in range(subset_target, num - 1, -1):
                dp[j] += dp[j - num]

        return dp[subset_target]
`;

  const deps = {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };

  const tracingPayload = runtime.generateTracingCode(
    deps,
    source,
    'findTargetSumWays',
    { nums: [1, 1, 1, 1, 1], target: 3 },
    'function',
    { maxTraceSteps: 5000, maxLineEvents: 20000 }
  );

  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'trace': _trace_data,
    'result': _serialize_output(_result)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: TraceStep[]; result: unknown };
  assertCondition(parsed.result === 5, 'Python function-style execution should fall back to Solution.method when no top-level function exists');
  assertCondition(
    !parsed.trace.some((step) => step.event === 'exception'),
    `Python function-style Solution fallback should not emit exception frames, received ${JSON.stringify(parsed.trace)}`
  );
  assertCondition(
    parsed.trace.some((step) => (step.accesses ?? []).some((access) => access.variable === 'dp' && access.kind === 'indexed-write')),
    'Python function-style Solution fallback should produce normal traced DP writes'
  );

  console.log('PASS: Python function-style execution falls back to Solution.method');
}

async function main(): Promise<void> {
  await assertAccessAttributionUsesExecutedLine();
  await assertIndexedReceiverMutationsAreRecordedAsMutations();
  await assertIndexSourceProvenanceIsRecorded();
  await assertEnumerateLoopBindingIsRecorded();
  await assertEnumerateExpressionLoopBindingIsRecorded();
  await assertTupleForLoopBindingIsRecorded();
  await assertListForLoopBindingSourcesAreRecorded();
  await assertLiteralTupleUnpackingForLoopBindingIsRecorded();
  await assertTupleAssignmentScalarWritesAreRecorded();
  await assertChainedAssignmentScalarWritesAreRecorded();
  await assertListComprehensionAssignmentEmitsSingleWriteFrame();
  await assertInPlaceSortMutationIsRecorded();
  await assertTupleKeyDictProvenanceIsRecorded();
  await assertObjectMemberDictMembershipProvenanceIsRecorded();
  await assertComputedDeleteMutationArgsAreRecorded();
  await assertTraceReferenceIdsAreNeutral();
  await assertCustomObjectLocalAliasesMaterializePayloads();
  await assertCustomObjectIdsAreStableAcrossFrames();
  await assertObjectFieldSubscriptReadCarriesValue();
  await assertAttributeReadCarriesPreMutationValue();
  await assertTraceCaptureLimitPreservesOutput();
  await assertDefaultStoredRuntimeEventBudgetAllowsScriptReturns();
  await assertRuntimeValueSerializationCap();
  await assertDefaultPreludeImportsAreAvailable();
  await assertScriptModePreservesResultSerializer();
  await assertIndexedAugAssignAndLoopBindingUseConcreteValues();
  await assertSliceForLoopBindingIsRecorded();
  await assertBooleanIndexedAssignmentReadsAndWrites();
  await assertRecursiveCallActivationRuntimeEventsAreRecorded();
  await assertBuiltinSumRecordsConsumedCollectionReads();
  await assertFunctionStyleFallsBackToSolutionMethod();
  console.log('\nPython runtime checks passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
