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
import type { RuntimeTrace } from './runtime-trace';

/** Reasons stamped at the observation boundary when recording is cut short. */
export type Cut =
  | 'step-budget'
  | 'line-budget'
  | 'single-line-budget'
  | 'stored-event-budget'
  | 'byte-budget'
  | 'observer-deadline'
  | 'depth-budget';

/** A refusal is an observation outcome, separate from execution. */
export type Refusal =
  | 'recorder-unavailable'
  | 'unsupported-program'
  | 'unsupported-option'
  | 'observer-prepare'
  | 'observer-encode'
  | 'observer-runtime'
  | 'observer-protocol'
  | 'observer-deadline'
  | 'uncertified-drawing'
  | 'case-not-run';

/** The trusted adapter certifies the trace before returning a drawing. */
export type Drawing =
  | { status: 'drawn'; trace: RuntimeTrace }
  | { status: 'truncated'; reason: Cut; trace: RuntimeTrace; attemptedEvents: number }
  | { status: 'refused'; reason: Refusal };

/** @internal The observer receives its own materialized input and cancellation. */
export interface RuntimeObservationCall {
  readonly program: Readonly<
    Pick<RuntimeProgramPreparationCall, 'code' | 'functionName' | 'executionStyle'>
  >;
  readonly inputs: Record<string, unknown>;
  readonly traceOptions?: Readonly<TraceExecutionOptions>;
  readonly attemptToken: string;
  readonly signal?: AbortSignal;
}

/** @internal Observation runs on a separate lease from ordinary execution. */
export interface RuntimeObservationProvider {
  observe(call: RuntimeObservationCall): Promise<Drawing>;
}

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
  /**
   * Stop after the first case a time or line limit stopped (`client-timeout`,
   * `line-limit`, `single-line-limit`). The result is then a prefix of the
   * batch ending with that case. Honoured only by programs whose
   * capabilities declare `stopsAtFirstRunaway`.
   */
  readonly stopAtFirstRunaway?: boolean;
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
  /** As on `RuntimePreparedCodeBatchCall`. */
  readonly stopAtFirstRunaway?: boolean;
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
  /**
   * `executeBatchIsolated` honours `stopAtFirstRunaway`: it stops after the
   * first case a time or line limit stopped and returns the prefix, so a
   * stopping evaluation needs no request per case.
   */
  readonly stopsAtFirstRunaway?: true;
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
      /** Required: the learner's program failed to prepare (compile). */
      readonly diagnosticStage: ExecutionDiagnosticStage;
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
  /**
   * Time this provider may spend outside a case's own deadline on runtime
   * lifecycle (starting, restoring or replacing a worker or VM) in one run.
   * Judge's backstop watchdog waits this long beyond the per-case deadlines
   * before it treats the provider as hung. Default: 30 seconds.
   */
  readonly lifecycleAllowanceMs?: number;
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
