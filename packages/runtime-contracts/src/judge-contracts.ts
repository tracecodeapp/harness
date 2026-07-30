import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimeExecutionTimings,
} from './runtime-execution';
import type {
  RuntimeExecutionLimits,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from './runtime-capabilities';

/**
 * A test-case verdict produced after comparing a runtime outcome with an
 * expected value. The runtime itself does not own this policy.
 */
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

export interface RuntimeExecuteCase {
  id?: string;
  inputs: Record<string, unknown>;
  expected?: unknown;
}

export interface RuntimeExecuteCodeRequest {
  kind?: 'code';
  code: string;
  functionName?: string | null;
  executionStyle?: RuntimeExecutionStyle;
  cases: RuntimeExecuteCase[];
  trace?: boolean;
  limits?: RuntimeExecutionLimits;
  traceOptions?: TraceExecutionOptions;
  signal?: AbortSignal;
}

export interface RuntimeExecuteCaseResult {
  id?: string;
  expected?: unknown;
  /** Present when `expected` was provided: true iff the case completed with a deep-equal output. */
  passed?: boolean;
  /** Tracing requests produce `ExecutionResult` outcomes; plain runs produce `CodeExecutionResult`. */
  outcome: CodeExecutionResult | ExecutionResult;
}

export interface RuntimeExecuteResult {
  /** Aggregate summary: true iff every case outcome completed. */
  success: boolean;
  cases: RuntimeExecuteCaseResult[];
  timings?: RuntimeExecutionTimings;
}
