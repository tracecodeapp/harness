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
 * - `success: false` with a `diagnosticStage` -> `failed` (the learner's
 *   program failed at that stage).
 * - `success: false` with neither -> the worker broke the protocol: it
 *   reported a failure without saying whether the learner's program caused
 *   it. That is a provider defect, so lifting rejects with a
 *   `RuntimeProviderError` that names the omission. Workers must classify
 *   every failure; the learner-failure conformance matrix enforces it.
 */

import type {
  CodeExecutionResult,
  ExecutionDiagnosticStage,
  ExecutionLimitReason,
  ExecutionResult,
  RuntimeExecutionTimings,
} from './types';
import type { RuntimeTrace } from './runtime-trace';

/**
 * The runtime provider itself failed, for a reason the learner's program did
 * not cause: an asset or toolchain failed to load, a transport broke, a worker
 * died outside the program, or a worker broke the result protocol.
 *
 * Providers reject with this error (any rejection is treated the same way);
 * they never return a `failed` outcome for it. Judge reports a rejection as
 * the `runtime-provider-error` diagnostic.
 */
export class RuntimeProviderError extends Error {
  override readonly name = 'RuntimeProviderError';

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export function isRuntimeProviderError(error: unknown): error is RuntimeProviderError {
  return error instanceof Error && error.name === 'RuntimeProviderError';
}

function unclassifiedFailure(
  raw: RawExecutionPayload,
  fallbackError: string
): RuntimeProviderError {
  return new RuntimeProviderError(
    `${fallbackError}: the runtime reported a failure without classifying it ` +
      `as the program's or the provider's (Harness protocol violation)` +
      (raw.error ? `: ${raw.error}` : '.')
  );
}

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
  if (!raw.diagnosticStage) throw unclassifiedFailure(raw, fallbackError);
  return {
    kind: 'failed',
    error: raw.error ?? fallbackError,
    ...(raw.errorLine !== undefined ? { errorLine: raw.errorLine } : {}),
    diagnosticStage: raw.diagnosticStage,
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
  if (!raw.diagnosticStage) throw unclassifiedFailure(raw, fallbackError);
  return {
    kind: 'failed',
    error: raw.error ?? fallbackError,
    ...(raw.errorLine !== undefined ? { errorLine: raw.errorLine } : {}),
    trace,
    executionTimeMs,
    diagnosticStage: raw.diagnosticStage,
    ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
    consoleOutput,
    ...(raw.timings ? { timings: raw.timings } : {}),
  };
}
