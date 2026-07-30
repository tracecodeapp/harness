import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../../packages/runtime-python/src/python-harness';

export interface PythonConformanceFixture {
  id: string;
  title: string;
  entryStyle: string;
  methodName: string;
  source: string;
  input: Record<string, unknown>;
  expectedReturn: unknown;
  expectedMutations: Record<string, unknown>;
  expectedHarnessOutput?: unknown;
  coverage: string[];
  notes: string;
}

export interface PythonExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  errorLine?: number;
  consoleOutput?: string[];
  trace?: { events?: unknown[] };
  lineEventCount?: number;
  traceStepCount?: number;
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
}

export interface PythonConformanceRunResult {
  success: boolean;
  expectedOutput: unknown;
  untraced?: PythonExecutionResult;
  traced?: PythonExecutionResult;
  phase?: 'untraced' | 'traced';
  error?: string;
}

interface RuntimeDeps {
  PYTHON_CLASS_DEFINITIONS_SNIPPET: string;
  PYTHON_CONVERSION_HELPERS_SNIPPET: string;
  PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: string;
  PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: string;
  toPythonLiteral: (value: unknown) => string;
  performanceNow: () => number;
  INTERVIEW_GUARD_DEFAULTS: {
    maxLineEvents: number;
    maxSingleLineHits: number;
    maxCallDepth: number;
    maxMemoryBytes: number;
    memoryCheckEvery: number;
  };
  loadPyodideInstance: () => Promise<void>;
  getPyodide: () => { runPythonAsync: (code: string) => Promise<string> };
}

interface RuntimeCore {
  executeCode: (
    deps: RuntimeDeps,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ) => Promise<PythonExecutionResult>;
  executeWithTracing: (
    deps: RuntimeDeps,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ) => Promise<PythonExecutionResult>;
}

const INPLACE_OUTPUT_ARGUMENTS = ['nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid'];

function normalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeForJson(child)])
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function runPythonAsyncLikePyodide(code: string): string {
  let script = code.trimEnd();
  script = script.replace(
    /\njson\.dumps\(\{\n([\s\S]*)\n\}\)\s*$/,
    '\n__tracecode_pyodide_result = json.dumps({\n$1\n})\nprint(__tracecode_pyodide_result)'
  );
  script = script.replace(/\n(_json_out)\s*$/, '\nprint($1)');
  return execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trimEnd();
}

function buildRuntimeDeps(): RuntimeDeps {
  return {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
    performanceNow: () => Date.now(),
    INTERVIEW_GUARD_DEFAULTS: {
      maxLineEvents: 10000,
      maxSingleLineHits: 1000,
      maxCallDepth: 100,
      maxMemoryBytes: 8 * 1024 * 1024,
      memoryCheckEvery: 10,
    },
    loadPyodideInstance: async () => {},
    getPyodide: () => ({
      runPythonAsync: async (code: string) => runPythonAsyncLikePyodide(code),
    }),
  };
}

export async function loadPythonRuntimeCore(): Promise<RuntimeCore> {
  const source = await readFile(join(process.cwd(), 'workers', 'python', 'runtime-core.js'), 'utf8');
  const selfObject: Record<string, unknown> = {};
  const context = vm.createContext({
    console,
    self: selfObject,
    globalThis: {},
  });

  vm.runInContext(source, context, { filename: 'runtime-core.js' });
  const runtime = selfObject.__TRACECODE_PYODIDE_RUNTIME__;
  if (!runtime || typeof runtime !== 'object') throw new Error('Unable to load Python runtime core exports.');
  return runtime as RuntimeCore;
}

export function pythonExecutionStyleFor(entryStyle: string): 'function' | 'solution-method' {
  return entryStyle === 'top_level_function' ? 'function' : 'solution-method';
}

function expectedOutputForFixture(fixture: PythonConformanceFixture): unknown {
  if (fixture.expectedHarnessOutput !== undefined) return fixture.expectedHarnessOutput;
  if (fixture.expectedReturn === null) {
    for (const key of INPLACE_OUTPUT_ARGUMENTS) {
      if (Object.prototype.hasOwnProperty.call(fixture.expectedMutations, key)) {
        return fixture.expectedMutations[key];
      }
    }
  }
  return fixture.expectedReturn;
}

export async function runPythonConformanceFixture(
  runtime: RuntimeCore,
  fixture: PythonConformanceFixture
): Promise<PythonConformanceRunResult> {
  const deps = buildRuntimeDeps();
  const executionStyle = pythonExecutionStyleFor(fixture.entryStyle);
  const expectedOutput = expectedOutputForFixture(fixture);

  const untraced = await runtime.executeCode(deps, fixture.source, fixture.methodName, fixture.input, executionStyle);
  let phase: PythonConformanceRunResult['phase'];
  let error: string | undefined;
  if (!untraced.success) {
    phase = 'untraced';
    error = `${fixture.id}: untraced execution failed: ${untraced.error || JSON.stringify(untraced)}`;
  } else if (!jsonEqual(untraced.output, expectedOutput)) {
    phase = 'untraced';
    error = `${fixture.id}: untraced output mismatch\nExpected: ${stableStringify(expectedOutput)}\nReceived: ${stableStringify(untraced.output)}`;
  }

  const traced = await runtime.executeWithTracing(deps, fixture.source, fixture.methodName, fixture.input, executionStyle);
  if (!error) {
    if (!traced.success) {
      phase = 'traced';
      error = `${fixture.id}: traced execution failed: ${traced.error || JSON.stringify(traced)}`;
    } else if (!jsonEqual(traced.output, untraced.output)) {
      phase = 'traced';
      error = `${fixture.id}: traced output drifted from untraced output\nUntraced: ${stableStringify(untraced.output)}\nTraced: ${stableStringify(traced.output)}`;
    } else if (!jsonEqual(traced.output, expectedOutput)) {
      phase = 'traced';
      error = `${fixture.id}: traced output mismatch\nExpected: ${stableStringify(expectedOutput)}\nReceived: ${stableStringify(traced.output)}`;
    }
  }

  return {
    success: !error,
    expectedOutput,
    untraced,
    traced,
    ...(phase ? { phase } : {}),
    ...(error ? { error } : {}),
  };
}
