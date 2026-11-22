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

/**
 * Which stage of the learner's program failed.
 *
 * Every stage names a failure the learner's program caused: it did not
 * compile (`compile`, and the generated-driver stages that only fail when the
 * learner's signature or types do not fit the call), or it raised, crashed, or
 * exited while running (`runtime`, `trace`). A failure of the runtime provider
 * itself has no stage: the provider rejects with a `RuntimeProviderError`
 * instead of returning a `failed` outcome.
 */
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
 * - `failed` — the learner's program failed: it did not compile, or it raised,
 *   crashed the runtime, or exited while running. `diagnosticStage` is
 *   required and says which. A program that takes its worker down with it is
 *   still `failed`; recovering the session is the provider's job.
 * - `limit` — execution was stopped by a configured or built-in limit before
 *   it could complete; `reason` says which one.
 *
 * A failure of the provider itself (assets, compiler loading, transport, a worker
 * that died independently of the program) is never an outcome: the provider
 * rejects with a `RuntimeProviderError`, and Judge reports it as
 * `runtime-provider-error`.
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
      /** Required: a `failed` outcome always says which program stage failed. */
      diagnosticStage: ExecutionDiagnosticStage;
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
 * A traced run that ran untraced: the runtime could not trace this program
 * without changing what it computes. The outcome is the untraced program's,
 * the trace is empty, and Judge reports this as a `trace-unavailable` warning
 * diagnostic on the case.
 */
export interface TraceUnavailableNotice {
  readonly code: 'trace-unavailable';
  readonly message: string;
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
      traceUnavailable?: TraceUnavailableNotice;
      timings?: RuntimeExecutionTimings;
    }
  | {
      kind: 'failed';
      error: string;
      errorLine?: number;
      trace: import('./runtime-trace').RuntimeTrace;
      executionTimeMs: number;
      consoleOutput: string[];
      /** Required: a `failed` outcome always says which program stage failed. */
      diagnosticStage: ExecutionDiagnosticStage;
      diagnostic?: unknown;
      traceUnavailable?: TraceUnavailableNotice;
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
      traceUnavailable?: TraceUnavailableNotice;
      timings?: RuntimeExecutionTimings;
    };

/** Language-level Python runtime loading state. */
export interface PythonRuntimeState {
  status: 'loading' | 'ready' | 'error';
  error?: Error;
  loadTimeMs?: number;
}
