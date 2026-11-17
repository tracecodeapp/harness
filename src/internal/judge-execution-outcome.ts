import type {
  CodeExecutionResult,
  ExecutionLimitReason,
  ExecutionResult,
  Language,
  RuntimeExecutionTimings,
} from '../../packages/runtime-contracts/src/index';
import {
  createEmptyRuntimeTrace,
  RuntimeProviderError,
} from '../../packages/runtime-contracts/src/index';
import type { RuntimeTrace } from '../../packages/runtime-contracts/src/runtime-trace';
import type {
  JudgeCaseResult,
  JudgeCompileResult,
  JudgeDiagnostic,
  JudgeFailure,
  JudgeProcessResult,
  JudgeRuntimeTimings,
} from '../../packages/judge/src/index';

export interface JudgeExecutionOutcomeOptions {
  /** Language of the evaluated submission (labels empty traces). */
  readonly language: Language;
}

const LIMIT_REASONS: ReadonlySet<string> = new Set<ExecutionLimitReason>([
  'trace-limit',
  'trace-byte-limit',
  'line-limit',
  'single-line-limit',
  'recursion-limit',
  'memory-limit',
  'serialization-limit',
  'client-timeout',
]);

function consoleLines(stdout: string): string[] {
  if (!stdout) return [];
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function durationMs(result: JudgeProcessResult): number {
  const totalMs = result.timings?.totalMs;
  if (typeof totalMs === 'number') return totalMs;
  if (typeof result.startedAt === 'number' && typeof result.endedAt === 'number') {
    return Math.max(0, result.endedAt - result.startedAt);
  }
  return 0;
}

function executionTimings(
  timings: JudgeRuntimeTimings | undefined
): { readonly timings?: RuntimeExecutionTimings } {
  if (!timings) return {};
  const copied: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(timings)) {
    if (typeof value === 'number' || typeof value === 'boolean') copied[key] = value;
  }
  return { timings: copied as RuntimeExecutionTimings };
}

function errorDiagnostic(
  result: JudgeProcessResult
): JudgeDiagnostic | undefined {
  return result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
}

function traceOf(result: JudgeProcessResult & { readonly trace?: unknown }, language: Language): RuntimeTrace {
  return (result.trace as RuntimeTrace | undefined) ??
    createEmptyRuntimeTrace(language, { runId: `${language}:run` });
}

type FailureOutcome =
  | {
      readonly kind: 'failed';
      readonly error: string;
      readonly errorLine?: number;
      readonly diagnosticStage: Extract<JudgeFailure, { origin: 'program' }>['stage'];
      readonly diagnostic?: unknown;
    }
  | {
      readonly kind: 'limit';
      readonly reason: ExecutionLimitReason;
      readonly error: string;
    };

/**
 * The one mapping from a Judge failure to an execution outcome. A provider
 * failure is not an outcome: it rejects with `RuntimeProviderError`.
 */
function failureOutcome(
  failure: JudgeFailure,
  result: JudgeProcessResult
): FailureOutcome {
  switch (failure.origin) {
    case 'program':
      return {
        kind: 'failed',
        error: failure.message,
        ...(failure.line === undefined ? {} : { errorLine: failure.line }),
        diagnosticStage: failure.stage,
        ...(errorDiagnostic(result) ? { diagnostic: errorDiagnostic(result) } : {}),
      };
    case 'limit':
      return { kind: 'limit', reason: failure.reason, error: failure.message };
    case 'provider':
      throw new RuntimeProviderError(failure.message, { cause: failure });
  }
}

function traceTruncated(
  result: JudgeProcessResult
): { readonly traceTruncated?: ExecutionLimitReason } {
  const warning = result.diagnostics.find((diagnostic) =>
    diagnostic.severity === 'warning' &&
    diagnostic.code !== undefined &&
    LIMIT_REASONS.has(diagnostic.code)
  );
  return warning ? { traceTruncated: warning.code as ExecutionLimitReason } : {};
}

/**
 * Converts a Judge case result into the execution outcome a learner sees,
 * totally: completed, the learner's failure (with its stage, message and line)
 * or a limit (with its reason). A case whose failure is the provider's rejects
 * with `RuntimeProviderError`; consumers never choose an origin.
 */
export function judgeCaseExecutionOutcome(
  result: JudgeCaseResult,
  options: JudgeExecutionOutcomeOptions & { readonly trace: true }
): ExecutionResult;
export function judgeCaseExecutionOutcome(
  result: JudgeCaseResult,
  options: JudgeExecutionOutcomeOptions & { readonly trace?: false }
): CodeExecutionResult;
export function judgeCaseExecutionOutcome(
  result: JudgeCaseResult,
  options: JudgeExecutionOutcomeOptions & { readonly trace?: boolean }
): CodeExecutionResult | ExecutionResult {
  const consoleOutput = consoleLines(result.stdout);
  const timings = executionTimings(result.timings);
  if (result.status === 'completed') {
    return options.trace
      ? {
          kind: 'completed',
          output: result.value,
          trace: traceOf(result, options.language),
          executionTimeMs: durationMs(result),
          consoleOutput,
          ...traceTruncated(result),
          ...timings,
        }
      : {
          kind: 'completed',
          output: result.value,
          consoleOutput,
          ...timings,
        };
  }
  const outcome = failureOutcome(result.failure, result);
  return options.trace
    ? {
        ...outcome,
        trace: traceOf(result, options.language),
        executionTimeMs: durationMs(result),
        consoleOutput,
        ...timings,
      }
    : { ...outcome, consoleOutput, ...timings };
}

/**
 * Converts a failed or timed-out Judge compile into the execution outcome
 * every case of that evaluation shows. A successful compile has no failure
 * outcome; a provider failure rejects with `RuntimeProviderError`.
 */
export function judgeCompileExecutionOutcome(
  compile: Exclude<JudgeCompileResult, { readonly status: 'compiled' }>,
  options: JudgeExecutionOutcomeOptions & { readonly trace: true }
): ExecutionResult;
export function judgeCompileExecutionOutcome(
  compile: Exclude<JudgeCompileResult, { readonly status: 'compiled' }>,
  options: JudgeExecutionOutcomeOptions & { readonly trace?: false }
): CodeExecutionResult;
export function judgeCompileExecutionOutcome(
  compile: Exclude<JudgeCompileResult, { readonly status: 'compiled' }>,
  options: JudgeExecutionOutcomeOptions & { readonly trace?: boolean }
): CodeExecutionResult | ExecutionResult {
  const outcome = failureOutcome(compile.failure, compile);
  const consoleOutput = consoleLines(compile.stdout);
  const timings = executionTimings(compile.timings);
  return options.trace
    ? {
        ...outcome,
        trace: createEmptyRuntimeTrace(options.language, { runId: `${options.language}:compile` }),
        executionTimeMs: 0,
        consoleOutput,
        ...timings,
      }
    : { ...outcome, consoleOutput, ...timings };
}
