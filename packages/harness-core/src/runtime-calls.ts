import type { CodeExecutionResult, ExecutionResult } from './runtime-execution';
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
