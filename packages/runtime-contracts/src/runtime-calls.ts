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

/** One isolated tracing execution against a prepared program. */
export interface RuntimePreparedTraceCall {
  readonly inputs: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly limits?: RuntimeExecutionLimits;
}

export interface RuntimePreparedProgramCapabilities {
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
}

export interface RuntimePreparedTraceProgram
  extends RuntimePreparedProgramBase {
  readonly mode: 'trace';
  executeIsolated(
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult>;
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
