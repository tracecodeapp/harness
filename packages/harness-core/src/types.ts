/**
 * Execution types for browser runtime contracts.
 */

export type ExecutionStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'running'
  | 'stepping'
  | 'paused'
  | 'completed'
  | 'error';

// Test case execution result
export interface TestResult {
  id: string;
  passed: boolean;
  input: Record<string, unknown>;
  expected: unknown;
  actual: unknown;
  error?: string;
  warning?: string;
  executionTimeMs?: number;
}

export interface RuntimeExecutionTimings {
  totalMs?: number;
  initMs?: number;
  warmupMs?: number;
  toolchainLoadMs?: number;
  rewriteMs?: number;
  driverBuildMs?: number;
  compileMs?: number;
  pchMs?: number;
  pchCacheHit?: boolean;
  pchFallback?: boolean;
  linkMs?: number;
  wasmCompileMs?: number;
  classLoadMs?: number;
  runMs?: number;
  hostCallMs?: number;
  compileCacheHit?: boolean;
  artifactCacheHit?: boolean;
}

/** Why an execution (or its trace recording) was stopped by a limit. */
export type ExecutionLimitReason =
  | 'trace-limit'
  | 'line-limit'
  | 'single-line-limit'
  | 'recursion-limit'
  | 'memory-limit'
  | 'client-timeout';

/** Which pipeline stage produced a failure diagnostic. */
export type ExecutionDiagnosticStage =
  | 'compile'
  | 'runtime'
  | 'trace'
  | 'driver-compile'
  | 'trace-driver-compile'
  | 'driver-link';

/**
 * Non-tracing code execution outcome.
 *
 * - `completed` — the user program ran to completion and produced output.
 * - `failed` — the user program (or its compilation) failed.
 * - `limit` — execution was stopped by a configured or built-in limit before
 *   it could complete; `reason` says which one.
 */
export type CodeExecutionResult =
  | {
      kind: 'completed';
      output: unknown;
      consoleOutput: string[];
      timings?: RuntimeExecutionTimings;
    }
  | {
      kind: 'failed';
      error: string;
      errorLine?: number;
      diagnosticStage?: ExecutionDiagnosticStage;
      diagnostic?: unknown;
      consoleOutput: string[];
      timings?: RuntimeExecutionTimings;
    }
  | {
      kind: 'limit';
      reason: ExecutionLimitReason;
      error: string;
      diagnostic?: unknown;
      consoleOutput: string[];
      timings?: RuntimeExecutionTimings;
    };

export interface CodeExecutionBatchResult {
  results: CodeExecutionResult[];
  error?: string;
  consoleOutput?: string[];
  executionTimeMs?: number;
  timings?: RuntimeExecutionTimings;
}

/**
 * Tracing execution outcome. Every variant carries the trace: a failed run
 * keeps its compile/exception trace, and a limit-stopped run keeps the
 * partial trace recorded before the limit tripped.
 *
 * `limit` means execution itself was stopped. A run that completed while its
 * trace *recording* hit a budget is `completed` with `traceTruncated` set.
 */
export type ExecutionResult =
  | {
      kind: 'completed';
      output: unknown;
      trace: import('./runtime-trace').RuntimeTrace;
      executionTimeMs: number;
      consoleOutput: string[];
      traceTruncated?: ExecutionLimitReason;
      timings?: RuntimeExecutionTimings;
    }
  | {
      kind: 'failed';
      error: string;
      errorLine?: number;
      trace: import('./runtime-trace').RuntimeTrace;
      executionTimeMs: number;
      consoleOutput: string[];
      diagnosticStage?: ExecutionDiagnosticStage;
      diagnostic?: unknown;
      timings?: RuntimeExecutionTimings;
    }
  | {
      kind: 'limit';
      reason: ExecutionLimitReason;
      error: string;
      trace: import('./runtime-trace').RuntimeTrace;
      executionTimeMs: number;
      consoleOutput: string[];
      diagnostic?: unknown;
      timings?: RuntimeExecutionTimings;
    };

// Pyodide loading state
export interface PyodideState {
  status: 'loading' | 'ready' | 'error';
  error?: Error;
  loadTimeMs?: number;
}
