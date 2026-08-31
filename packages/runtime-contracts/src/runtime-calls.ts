import type {
  CodeExecutionResult,
  ExecutionDiagnosticStage,
  ExecutionLimitReason,
  ExecutionResult,
  RuntimeExecutionTimings,
} from './runtime-execution';
import type {
  RuntimeExecutionLimits,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from './runtime-capabilities';

/** A single non-tracing execution call (one case). */
export interface RuntimeCodeCall {
  code: string;
  functionName: string;
  inputs: Record<string, unknown>;
  executionStyle?: RuntimeExecutionStyle;
  signal?: AbortSignal;
  limits?: RuntimeExecutionLimits;
}

/** A multi-case non-tracing execution call sharing one compiled program. */
export interface RuntimeBatchCall {
  code: string;
  functionName: string;
  inputBatch: Record<string, unknown>[];
  executionStyle?: RuntimeExecutionStyle;
  signal?: AbortSignal;
}

/** A single tracing execution call (one case). */
export interface RuntimeTraceCall {
  code: string;
  functionName: string | null;
  inputs: Record<string, unknown>;
  traceOptions?: TraceExecutionOptions;
  executionStyle?: RuntimeExecutionStyle;
  signal?: AbortSignal;
  limits?: RuntimeExecutionLimits;
}

export type RuntimePreparedProgramMode = 'code' | 'trace';

/**
 * How a prepared algorithm program provides fresh mutable state.
 *
 * - `fast` retains the initialized language runtime and discards a small,
 *   capability-restricted learner realm between cases.
 * - `compatibility` uses a disposable outer runtime generation for cases that
 *   cannot be admitted to retained execution.
 *
 * Both profiles are safe. Trace recording is orthogonal and is selected by
 * `RuntimePreparedProgramMode`.
 */
export type RuntimePreparedExecutionProfile = 'fast' | 'compatibility';

/**
 * Immutable source-level inputs used to prepare one reusable program.
 *
 * Expected values, case inputs, comparators, and Judge policy intentionally do
 * not cross this boundary. A provider may compile, transpile, rewrite, or
 * otherwise prepare immutable artifacts here.
 */
export interface RuntimeProgramPreparationCall {
  readonly mode: RuntimePreparedProgramMode;
  readonly code: string;
  readonly functionName: string | null;
  readonly executionStyle?: RuntimeExecutionStyle;
  readonly traceOptions?: TraceExecutionOptions;
  readonly signal?: AbortSignal;
}

/** One isolated non-tracing execution against a prepared program. */
export interface RuntimePreparedCodeCall {
  readonly inputs: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly limits?: RuntimeExecutionLimits;
}

/**
 * A group of non-tracing cases executed against one prepared artifact.
 *
 * Providers that implement this capability must preserve the same
 * `fresh-case-state` guarantee as `executeIsolated`. The batching boundary may
 * reuse one warmed engine, but mutable language state may not flow between
 * entries in `inputBatch`.
 */
export interface RuntimePreparedCodeBatchCall {
  readonly inputBatch: readonly Record<string, unknown>[];
  readonly signal?: AbortSignal;
  /** Applied independently to each case in the batch. */
  readonly limits?: RuntimeExecutionLimits;
}

/** One isolated tracing execution against a prepared program. */
export interface RuntimePreparedTraceCall {
  readonly inputs: Record<string, unknown>;
  /**
   * Select recording for this case from the prepared trace-capable artifact.
   * Omit to preserve the traced-execution default.
   */
  readonly recordTrace?: boolean;
  readonly signal?: AbortSignal;
  readonly limits?: RuntimeExecutionLimits;
}

/**
 * A group of tracing cases executed against one prepared artifact.
 *
 * Providers may keep the engine warm only when they restore fresh mutable
 * language state before every entry.
 */
export interface RuntimePreparedTraceBatchCall {
  readonly inputBatch: readonly Record<string, unknown>[];
  /** One recording selector per case. Omit to trace every case. */
  readonly traceEnabledBatch?: readonly boolean[];
  readonly signal?: AbortSignal;
  /** Applied independently to each case in the batch. */
  readonly limits?: RuntimeExecutionLimits;
}

export interface RuntimePreparedProgramCapabilities {
  /** The isolation implementation selected during immutable preparation. */
  readonly profile: RuntimePreparedExecutionProfile;
  /**
   * Every call receives fresh mutable language state. Immutable compiler
   * artifacts may be reused, but globals, statics, heaps, and mutated inputs
   * must not flow between calls.
   */
  readonly caseIsolation: 'fresh-case-state';
  /**
   * Maximum number of executeIsolated calls the prepared program can service
   * concurrently. The orchestration adapter must apply backpressure above
   * this limit.
   */
  readonly maxConcurrency: number;
}

interface RuntimePreparedProgramBase {
  readonly capabilities: RuntimePreparedProgramCapabilities;
  /**
   * Release every artifact and runtime resource owned by this preparation.
   * The owner calls this exactly once after the enclosing evaluation ends.
   */
  dispose(): Promise<void>;
}

export interface RuntimePreparedCodeProgram
  extends RuntimePreparedProgramBase {
  readonly mode: 'code';
  executeIsolated(
    call: RuntimePreparedCodeCall
  ): Promise<CodeExecutionResult>;
  /**
   * Optional fast path for runtimes that can isolate several cases inside one
   * warmed engine. Judge falls back to `executeIsolated` when it is absent.
   */
  executeBatchIsolated?(
    call: RuntimePreparedCodeBatchCall
  ): Promise<readonly CodeExecutionResult[]>;
}

export interface RuntimePreparedTraceProgram
  extends RuntimePreparedProgramBase {
  readonly mode: 'trace';
  executeIsolated(
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult>;
  /**
   * Optional fast path for runtimes that can trace isolated cases inside one
   * warmed engine.
   */
  executeBatchIsolated?(
    call: RuntimePreparedTraceBatchCall
  ): Promise<readonly ExecutionResult[]>;
}

/**
 * Opaque provider-owned prepared program. Orchestrators may execute isolated
 * cases and dispose it, but cannot inspect or depend on its compiled artifact.
 */
export type RuntimePreparedProgram =
  | RuntimePreparedCodeProgram
  | RuntimePreparedTraceProgram;

export type RuntimeProgramPreparationResult =
  | {
      readonly kind: 'prepared';
      readonly program: RuntimePreparedProgram;
      readonly consoleOutput: string[];
      readonly timings?: RuntimeExecutionTimings;
    }
  | {
      readonly kind: 'failed';
      readonly error: string;
      readonly errorLine?: number;
      readonly diagnosticStage?: ExecutionDiagnosticStage;
      readonly diagnostic?: unknown;
      readonly consoleOutput: string[];
      readonly timings?: RuntimeExecutionTimings;
    }
  | {
      readonly kind: 'limit';
      readonly reason: ExecutionLimitReason;
      readonly error: string;
      readonly diagnostic?: unknown;
      readonly consoleOutput: string[];
      readonly timings?: RuntimeExecutionTimings;
    };

/**
 * Prepare-once runtime capability used by Judge-backed execution.
 *
 * This is deliberately separate from RuntimeExecutionProvider: the latter is
 * the legacy single-call bridge and cannot promise compile-once semantics.
 */
export interface RuntimePreparedExecutionProvider {
  init(): Promise<{ success: boolean; loadTimeMs: number }>;
  prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult>;
}

/**
 * Minimal language execution capability used underneath workspace processes
 * and judge orchestration. It does not compare outputs or assign verdicts.
 */
export interface RuntimeExecutionProvider {
  init(): Promise<{ success: boolean; loadTimeMs: number }>;
  executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult>;
  executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult>;
}
