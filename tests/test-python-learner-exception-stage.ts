#!/usr/bin/env npx tsx

/**
 * A learner's own exception must reach the Judge as a runtime-stage failure.
 *
 * A `failed` outcome must name the program stage that failed; Python used to
 * report learner exceptions without one, and they surfaced as
 * `runtime-provider-error` (see docs/learner-failure-classification.md).
 *
 * The traced path is exercised end to end through host CPython: the runtime's
 * generated tracing program runs exactly as Pyodide would run it.
 */

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/runtime-python/src/python-harness';

const PYTHON_RUNTIME_PATH = join(process.cwd(), 'workers', 'python', 'python-runtime.js');

interface TraceResult {
  readonly success: boolean;
  readonly error?: string;
  readonly errorLine?: number;
  readonly diagnosticStage?: string;
  readonly timeoutReason?: string;
}

interface PythonRuntime {
  executeWithTracing(
    deps: Record<string, unknown>,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ): Promise<TraceResult>;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function loadPythonRuntime(): Promise<PythonRuntime> {
  const source = await readFile(PYTHON_RUNTIME_PATH, 'utf8');
  const selfObject: Record<string, unknown> = {};
  vm.runInContext(source, vm.createContext({ console, self: selfObject, globalThis: {} }), {
    filename: 'python-runtime.js',
  });
  const runtime = selfObject.__TRACECODE_PYODIDE_RUNTIME__;
  assertCondition(typeof runtime === 'object' && runtime !== null, 'Unable to load Python runtime exports');
  return runtime as PythonRuntime;
}

function runTracingProgramLikePyodide(code: string): string {
  // Pyodide returns the value of the named result binding; host CPython prints it.
  // The program goes in on stdin: as one argument it can pass Linux's 128 KiB
  // limit on a single argument (MAX_ARG_STRLEN) and fail with E2BIG.
  return execFileSync(
    'python3',
    ['-'],
    {
      input: `${code.trimEnd()}\nprint(__tracecode_execution_result_json)\n`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  ).trimEnd();
}

function tracingDeps(): Record<string, unknown> {
  let now = 0;
  return {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
    loadPyodideInstance: async () => {},
    getPyodide: () => ({
      runPythonAsync: async (code: string) => runTracingProgramLikePyodide(code),
    }),
    performanceNow: () => ++now,
  };
}

const firstBadVersion = (call: string, helper = 'return version >= bad') => `class Solution:
    def isBadVersion(self, version: int, bad: int) -> bool:
        ${helper}

    def firstBadVersion(self, n: int, bad: int) -> int:
        left = 1
        right = n
        while left < right:
            mid = (right + left) // 2
            if ${call}:
                right = mid
            else:
                left = mid + 1
        return left`;

const LEARNER_EXCEPTIONS: ReadonlyArray<{
  readonly name: string;
  readonly code: string;
  readonly line: number;
  readonly error: RegExp;
}> = [
  {
    name: 'NameError from a helper called as a bare function',
    code: firstBadVersion('isBadVersion(mid)'),
    line: 10,
    error: /^NameError on line 10: name 'isBadVersion' is not defined$/,
  },
  {
    name: 'TypeError from a missing argument',
    code: firstBadVersion('self.isBadVersion(mid)'),
    line: 10,
    error: /^TypeError on line 10: .*missing 1 required positional argument: 'bad'$/,
  },
  {
    name: 'ZeroDivisionError raised inside a helper method',
    code: firstBadVersion('self.isBadVersion(mid, bad)', 'return version >= bad // 0'),
    line: 3,
    error: /^ZeroDivisionError on line 3: /,
  },
  {
    name: 'IndexError from a subscript',
    code: `class Solution:
    def isBadVersion(self, version: int, bad: int) -> bool:
        return version >= bad

    def firstBadVersion(self, n: int, bad: int) -> int:
        versions = []
        return versions[n]`,
    line: 7,
    error: /^IndexError on line 7: list index out of range$/,
  },
];

async function assertTracedLearnerExceptionsCarryRuntimeStage(): Promise<void> {
  const runtime = await loadPythonRuntime();
  for (const scenario of LEARNER_EXCEPTIONS) {
    const result = await runtime.executeWithTracing(
      tracingDeps(),
      scenario.code,
      'firstBadVersion',
      { n: 5, bad: 4 },
      'solution-method'
    );
    assertCondition(result.success === false, `${scenario.name}: the run should fail`);
    assertCondition(
      scenario.error.test(result.error ?? ''),
      `${scenario.name}: unexpected error ${JSON.stringify(result.error)}`
    );
    assertCondition(
      result.errorLine === scenario.line,
      `${scenario.name}: expected line ${scenario.line}, received ${String(result.errorLine)}`
    );
    assertCondition(
      result.diagnosticStage === 'runtime',
      `${scenario.name}: expected the runtime stage, received ${String(result.diagnosticStage)}`
    );
    assertCondition(result.timeoutReason === undefined, `${scenario.name}: no limit should be reported`);
    console.log(`PASS: traced ${scenario.name} is a runtime-stage failure on line ${scenario.line}`);
  }
}

async function assertCompletedTracedRunsCarryNoStage(): Promise<void> {
  const runtime = await loadPythonRuntime();
  const result = await runtime.executeWithTracing(
    tracingDeps(),
    firstBadVersion('self.isBadVersion(mid, bad)'),
    'firstBadVersion',
    { n: 5, bad: 4 },
    'solution-method'
  );
  assertCondition(result.success === true, `a correct program should complete: ${JSON.stringify(result.error)}`);
  assertCondition(result.diagnosticStage === undefined, 'a completed run carries no diagnostic stage');
  console.log('PASS: a completed traced run carries no diagnostic stage');
}

async function assertTracedProgramFailuresOutliveTheRecordingBudget(): Promise<void> {
  const runtime = await loadPythonRuntime();
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly code: string;
    readonly line: number;
    readonly error: RegExp;
  }> = [
    {
      // The trace byte budget stops recording long before the recursion limit;
      // the RecursionError must still be the outcome, not a completed run.
      name: 'unbounded recursion after the trace budget stopped recording',
      code: 'def solve(n):\n    return solve(n + 1) + 1',
      line: 2,
      error: /^RecursionError on line 2: maximum recursion depth exceeded/,
    },
    {
      name: 'sys.exit',
      code: 'import sys\ndef solve(n):\n    sys.exit(3)',
      line: 3,
      error: /^SystemExit on line 3: the program exited with status 3$/,
    },
  ];
  for (const scenario of scenarios) {
    const result = await runtime.executeWithTracing(
      tracingDeps(),
      scenario.code,
      'solve',
      { n: 3 },
      'function'
    );
    assertCondition(result.success === false, `${scenario.name}: the run should fail`);
    assertCondition(
      scenario.error.test(result.error ?? ''),
      `${scenario.name}: unexpected error ${JSON.stringify(result.error)}`
    );
    assertCondition(result.errorLine === scenario.line, `${scenario.name}: expected line ${scenario.line}, received ${String(result.errorLine)}`);
    assertCondition(result.diagnosticStage === 'runtime', `${scenario.name}: expected the runtime stage`);
    assertCondition(result.timeoutReason === undefined, `${scenario.name}: a program failure is not a limit`);
    console.log(`PASS: traced ${scenario.name} is a runtime-stage failure on line ${scenario.line}`);
  }
}

await assertTracedLearnerExceptionsCarryRuntimeStage();
await assertCompletedTracedRunsCarryNoStage();
await assertTracedProgramFailuresOutliveTheRecordingBudget();
