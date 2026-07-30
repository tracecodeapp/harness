/**
 * Lifts raw worker execution payloads into the discriminated outcome unions.
 *
 * The wire format deliberately keeps the legacy loose shape
 * (`success`/`error`/`timeoutReason`); workers are version-locked, and the
 * boundary between "what the worker said" and "what the API means" lives
 * here, once. Classification:
 *
 * - `success: true`  -> `completed` (for traces, `traceLimitExceeded` becomes
 *   `traceTruncated`: the run finished but the recording hit a budget).
 * - `success: false` with a `timeoutReason` -> `limit` (execution was stopped).
 * - anything else    -> `failed`.
 */

import type {
  CodeExecutionResult,
  ExecutionDiagnosticStage,
  ExecutionLimitReason,
  ExecutionResult,
  RuntimeExecutionTimings,
} from './types';
import type { RuntimeTrace } from './runtime-trace';

/** The legacy loose result shape workers emit over the wire. */
export interface RawExecutionPayload {
  success: boolean;
  output?: unknown;
  error?: string;
  errorLine?: number;
  consoleOutput?: string[];
  timeoutReason?: ExecutionLimitReason;
  diagnosticStage?: ExecutionDiagnosticStage;
  diagnostic?: unknown;
  traceLimitExceeded?: boolean;
  executionTimeMs?: number;
  timings?: RuntimeExecutionTimings;
}

export function liftCodeOutcome(
  raw: RawExecutionPayload,
  fallbackError = 'Execution failed'
): CodeExecutionResult {
  const consoleOutput = raw.consoleOutput ?? [];
  if (raw.success) {
    return {
      kind: 'completed',
      output: raw.output ?? null,
      consoleOutput,
      ...(raw.timings ? { timings: raw.timings } : {}),
    };
  }
  if (raw.timeoutReason) {
    return {
      kind: 'limit',
      reason: raw.timeoutReason,
      error: raw.error ?? fallbackError,
      ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
      consoleOutput,
      ...(raw.timings ? { timings: raw.timings } : {}),
    };
  }
  return {
    kind: 'failed',
    error: raw.error ?? fallbackError,
    ...(raw.errorLine !== undefined ? { errorLine: raw.errorLine } : {}),
    ...(raw.diagnosticStage ? { diagnosticStage: raw.diagnosticStage } : {}),
    ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
    consoleOutput,
    ...(raw.timings ? { timings: raw.timings } : {}),
  };
}

/** The legacy loose batch shape workers emit over the wire. */
export interface RawExecutionBatchPayload {
  success?: boolean;
  results?: RawExecutionPayload[];
  error?: string;
  consoleOutput?: string[];
  executionTimeMs?: number;
  timings?: RuntimeExecutionTimings;
}

export function liftCodeBatchOutcome(
  raw: RawExecutionBatchPayload,
  fallbackError = 'Execution failed'
): import('./types').CodeExecutionBatchResult {
  return {
    results: (raw.results ?? []).map((entry) => liftCodeOutcome(entry, fallbackError)),
    ...(raw.error !== undefined ? { error: raw.error } : {}),
    ...(raw.consoleOutput ? { consoleOutput: raw.consoleOutput } : {}),
    ...(raw.executionTimeMs !== undefined ? { executionTimeMs: raw.executionTimeMs } : {}),
    ...(raw.timings ? { timings: raw.timings } : {}),
  };
}

export function liftTraceOutcome(
  raw: RawExecutionPayload,
  trace: RuntimeTrace,
  fallbackError = 'Tracing failed'
): ExecutionResult {
  const consoleOutput = raw.consoleOutput ?? [];
  const executionTimeMs = raw.executionTimeMs ?? 0;
  if (raw.success) {
    return {
      kind: 'completed',
      output: raw.output,
      trace,
      executionTimeMs,
      consoleOutput,
      ...(raw.traceLimitExceeded
        ? { traceTruncated: raw.timeoutReason ?? 'trace-limit' }
        : {}),
      ...(raw.timings ? { timings: raw.timings } : {}),
    };
  }
  if (raw.timeoutReason) {
    return {
      kind: 'limit',
      reason: raw.timeoutReason,
      error: raw.error ?? fallbackError,
      trace,
      executionTimeMs,
      ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
      consoleOutput,
      ...(raw.timings ? { timings: raw.timings } : {}),
    };
  }
  return {
    kind: 'failed',
    error: raw.error ?? fallbackError,
    ...(raw.errorLine !== undefined ? { errorLine: raw.errorLine } : {}),
    trace,
    executionTimeMs,
    ...(raw.diagnosticStage ? { diagnosticStage: raw.diagnosticStage } : {}),
    ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
    consoleOutput,
    ...(raw.timings ? { timings: raw.timings } : {}),
  };
}
