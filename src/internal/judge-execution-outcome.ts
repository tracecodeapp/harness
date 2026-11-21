import type {
  CodeExecutionResult,
  ExecutionLimitReason,
  ExecutionResult,
  Language,
  RuntimeExecutionTimings,
} from '../../packages/runtime-contracts/src/index';
import {
  createEmptyRuntimeTrace,
  isExecutionDiagnosticStage,
  isExecutionLimitReason,
  RuntimeProviderError,
} from '../../packages/runtime-contracts/src/index';
import type { RuntimeTrace } from '../../packages/runtime-contracts/src/runtime-trace';
import type {
  JudgeCaseResult,
  JudgeCompileResult,
  JudgeDiagnostic,
  JudgeFailure,
  JudgeNotRun,
  JudgeProcessResult,
  JudgeRuntimeTimings,
} from '../../packages/judge/src/index';

/**
 * A case Run did not execute because an earlier case was stopped by a limit.
 * It has no result, failure or limit of its own; render it as not run, naming
 * the case that stopped the run.
 */
export interface JudgeNotRunOutcome {
  readonly kind: 'not-run';
  readonly reason: JudgeNotRun['reason'];
  readonly stoppedByCaseId: string;
  readonly limit: JudgeNotRun['limit'];
  readonly consoleOutput: string[];
}

export interface JudgeExecutionOutcomeOptions {
  /** Language of the evaluated submission (labels empty traces). */
  readonly language: Language;
}

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
      // A result outside the closed sets cannot be the learner's: it is a
      // malformed provider message, so it is not an outcome either.
      if (!isExecutionDiagnosticStage(failure.stage)) {
        throw new RuntimeProviderError(
          `Judge result names an unknown program stage ${JSON.stringify(String(failure.stage)).slice(0, 80)}.`,
          { cause: failure }
        );
      }
      return {
        kind: 'failed',
        error: failure.message,
        ...(failure.line === undefined ? {} : { errorLine: failure.line }),
        diagnosticStage: failure.stage,
        ...(errorDiagnostic(result) ? { diagnostic: errorDiagnostic(result) } : {}),
      };
    case 'limit':
      if (!isExecutionLimitReason(failure.reason)) {
        throw new RuntimeProviderError(
          `Judge result names an unknown limit ${JSON.stringify(String(failure.reason)).slice(0, 80)}.`,
          { cause: failure }
        );
      }
      return { kind: 'limit', reason: failure.reason, error: failure.message };
    case 'provider':
      throw new RuntimeProviderError(failure.message, {
        cause: failure,
        ...(failure.reason === 'protocol' ? { reason: 'protocol' as const } : {}),
      });
  }
}

function traceTruncated(
  result: JudgeProcessResult
): { readonly traceTruncated?: ExecutionLimitReason } {
  const warning = result.diagnostics.find((diagnostic) =>
    diagnostic.severity === 'warning' &&
    diagnostic.code !== undefined &&
    isExecutionLimitReason(diagnostic.code)
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
): ExecutionResult | JudgeNotRunOutcome;
export function judgeCaseExecutionOutcome(
  result: JudgeCaseResult,
  options: JudgeExecutionOutcomeOptions & { readonly trace?: false }
): CodeExecutionResult | JudgeNotRunOutcome;
export function judgeCaseExecutionOutcome(
  result: JudgeCaseResult,
  options: JudgeExecutionOutcomeOptions & { readonly trace?: boolean }
): CodeExecutionResult | ExecutionResult | JudgeNotRunOutcome {
  const consoleOutput = consoleLines(result.stdout);
  if (result.status === 'not-run') {
    return {
      kind: 'not-run',
      reason: result.notRun.reason,
      stoppedByCaseId: result.notRun.stoppedByCaseId,
      limit: result.notRun.limit,
      consoleOutput,
    };
  }
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
