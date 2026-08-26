/**
 * Implementation-neutral execution lifecycle and outcome contracts.
 *
 * These contracts describe what a language runtime did. They intentionally do
 * not encode test-case verdicts or workspace policy.
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

export interface RuntimeExecutionTimings {
  totalMs?: number;
  initMs?: number;
  warmupMs?: number;
  compilerLoadMs?: number;
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
  algorithmFastBatch?: boolean;
}

/** Why an execution (or its trace recording) was stopped by a limit. */
export type ExecutionLimitReason =
  | 'trace-limit'
  | 'trace-byte-limit'
  | 'line-limit'
  | 'single-line-limit'
  | 'recursion-limit'
  | 'memory-limit'
  | 'serialization-limit'
  | 'client-timeout';

/** Which pipeline stage produced a failure diagnostic. */
export type ExecutionDiagnosticStage =
  | 'compile'
  | 'runtime'
  | 'trace'
  | 'driver-compile'
  | 'trace-driver-compile'
  | 'driver-link';

export interface RuntimeExceptionFrame {
  /** Learner-facing function name, with generated package identities removed. */
  function: string;
  file?: string;
  line?: number;
}

/**
 * Stable, language-neutral diagnostic for an exception thrown by learner code.
 *
 * `stack` is sanitized for display and support capture. Runtime and harness
 * implementation frames must not cross this boundary.
 */
export interface RuntimeExceptionDiagnostic {
  schema: 'tracecode.runtime-exception.v1';
  language: string;
  name: string;
  qualifiedName?: string;
  message?: string;
  frames: RuntimeExceptionFrame[];
  stack?: string;
}

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

/** Language-level Python runtime loading state. */
export interface PythonRuntimeState {
  status: 'loading' | 'ready' | 'error';
  error?: Error;
  loadTimeMs?: number;
}
