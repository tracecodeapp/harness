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
 * not cause: an asset or compiler failed to load, a transport broke, a worker
 * died outside the program, or a worker broke the result protocol.
 *
 * Providers reject with this error (any rejection is treated the same way);
 * they never return a `failed` outcome for it. Judge reports a rejection as
 * the `runtime-provider-error` diagnostic.
 */
export class RuntimeProviderError extends Error {
  override readonly name = 'RuntimeProviderError';
  /**
   * `protocol` when a worker's reply broke the result protocol (a missing or
   * unknown classification); otherwise the provider itself failed.
   */
  readonly reason: 'runtime-failure' | 'protocol';

  constructor(
    message: string,
    options?: { readonly cause?: unknown; readonly reason?: 'runtime-failure' | 'protocol' }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.reason = options?.reason ?? 'runtime-failure';
  }
}

export function isRuntimeProviderError(error: unknown): error is RuntimeProviderError {
  return error instanceof Error && error.name === 'RuntimeProviderError';
}

const EXECUTION_LIMIT_REASONS: ReadonlySet<string> = new Set<ExecutionLimitReason>([
  'trace-limit',
  'trace-byte-limit',
  'line-limit',
  'single-line-limit',
  'recursion-limit',
  'memory-limit',
  'serialization-limit',
  'client-timeout',
]);

const EXECUTION_DIAGNOSTIC_STAGES: ReadonlySet<string> = new Set<ExecutionDiagnosticStage>([
  'compile',
  'runtime',
  'trace',
  'driver-compile',
  'trace-driver-compile',
  'driver-link',
]);

/** Whether a value names one of the closed set of execution limits. */
export function isExecutionLimitReason(value: unknown): value is ExecutionLimitReason {
  return typeof value === 'string' && EXECUTION_LIMIT_REASONS.has(value);
}

/** Whether a value names one of the closed set of program stages. */
export function isExecutionDiagnosticStage(value: unknown): value is ExecutionDiagnosticStage {
  return typeof value === 'string' && EXECUTION_DIAGNOSTIC_STAGES.has(value);
}

/**
 * A worker that names a limit or stage outside the closed sets has broken the
 * protocol: it is the provider's failure, never a learner limit or failure.
 */
function malformedClassification(
  field: 'timeoutReason' | 'diagnosticStage',
  value: unknown,
  fallbackError: string
): RuntimeProviderError {
  return new RuntimeProviderError(
    `${fallbackError}: the runtime reported an unknown ${field} ` +
      `${JSON.stringify(String(value)).slice(0, 80)} (Harness protocol violation).`,
    { reason: 'protocol' }
  );
}

function checkedLimitReason(
  raw: RawExecutionPayload,
  fallbackError: string
): ExecutionLimitReason | undefined {
  const value: unknown = raw.timeoutReason;
  if (value === undefined || value === null || value === '') return undefined;
  if (!isExecutionLimitReason(value)) {
    throw malformedClassification('timeoutReason', value, fallbackError);
  }
  return value;
}

/**
 * Every classification a reply carries must be in its closed set, whatever
 * else the reply says: a completed reply with an unknown limit, or a limit
 * with an unknown stage, is as malformed as a failure with one.
 */
function assertClassificationFields(raw: RawExecutionPayload, fallbackError: string): void {
  checkedLimitReason(raw, fallbackError);
  const stage: unknown = raw.diagnosticStage;
  if (stage !== undefined && stage !== null && stage !== '' && !isExecutionDiagnosticStage(stage)) {
    throw malformedClassification('diagnosticStage', stage, fallbackError);
  }
}

function checkedStage(
  raw: RawExecutionPayload,
  fallbackError: string
): ExecutionDiagnosticStage {
  const value: unknown = raw.diagnosticStage;
  if (value === undefined || value === null || value === '') {
    throw unclassifiedFailure(raw, fallbackError);
  }
  if (!isExecutionDiagnosticStage(value)) {
    throw malformedClassification('diagnosticStage', value, fallbackError);
  }
  return value;
}

function unclassifiedFailure(
  raw: RawExecutionPayload,
  fallbackError: string
): RuntimeProviderError {
  return new RuntimeProviderError(
    `${fallbackError}: the runtime reported a failure without classifying it ` +
      `as the program's or the provider's (Harness protocol violation)` +
      (raw.error ? `: ${raw.error}` : '.'),
    { reason: 'protocol' }
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
  assertClassificationFields(raw, fallbackError);
  const consoleOutput = raw.consoleOutput ?? [];
  if (raw.success) {
    return {
      kind: 'completed',
      output: raw.output ?? null,
      consoleOutput,
      ...(raw.timings ? { timings: raw.timings } : {}),
    };
  }
  const reason = checkedLimitReason(raw, fallbackError);
  if (reason) {
    return {
      kind: 'limit',
      reason,
      error: raw.error ?? fallbackError,
      ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
      consoleOutput,
      ...(raw.timings ? { timings: raw.timings } : {}),
    };
  }
  const diagnosticStage = checkedStage(raw, fallbackError);
  return {
    kind: 'failed',
    error: raw.error ?? fallbackError,
    ...(raw.errorLine !== undefined ? { errorLine: raw.errorLine } : {}),
    diagnosticStage,
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
  assertClassificationFields(raw, fallbackError);
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
        ? { traceTruncated: checkedLimitReason(raw, fallbackError) ?? 'trace-limit' }
        : {}),
      ...(raw.timings ? { timings: raw.timings } : {}),
    };
  }
  const reason = checkedLimitReason(raw, fallbackError);
  if (reason) {
    return {
      kind: 'limit',
      reason,
      error: raw.error ?? fallbackError,
      trace,
      executionTimeMs,
      ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
      consoleOutput,
      ...(raw.timings ? { timings: raw.timings } : {}),
    };
  }
  const diagnosticStage = checkedStage(raw, fallbackError);
  return {
    kind: 'failed',
    error: raw.error ?? fallbackError,
    ...(raw.errorLine !== undefined ? { errorLine: raw.errorLine } : {}),
    trace,
    executionTimeMs,
    diagnosticStage,
    ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
    consoleOutput,
    ...(raw.timings ? { timings: raw.timings } : {}),
  };
}
