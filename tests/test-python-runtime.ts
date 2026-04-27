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
  indices?: number[];
  method?: string;
};

type TraceStep = {
  line: number;
  event: string;
  accesses?: TraceAccess[];
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
    'result': _serialize(_result),
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
    'result': _serialize(_result),
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

async function main(): Promise<void> {
  await assertAccessAttributionUsesExecutedLine();
  await assertIndexedReceiverMutationsAreRecordedAsMutations();
  console.log('\nPython runtime checks passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
