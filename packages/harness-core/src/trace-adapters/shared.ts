import type { Language } from '../runtime-types';
import { normalizeRuntimeTraceContract } from '../trace-contract';
import type { ExecutionResult, LegacyTraceExecutionResult } from '../types';
import { runtimeTraceContractToV4Events, type RuntimeV4TraceOptions } from '../trace-v4';

export function adaptTraceExecutionResult(
  language: Language,
  result: LegacyTraceExecutionResult,
  options: RuntimeV4TraceOptions = {}
): ExecutionResult {
  const normalized = normalizeRuntimeTraceContract(language, result);

  return {
    success: normalized.success,
    ...(Object.prototype.hasOwnProperty.call(normalized, 'output') ? { output: normalized.output } : {}),
    ...(normalized.error ? { error: normalized.error } : {}),
    ...(normalized.errorLine !== undefined ? { errorLine: normalized.errorLine } : {}),
    trace: runtimeTraceContractToV4Events(normalized, options),
    executionTimeMs:
      typeof result.executionTimeMs === 'number' && Number.isFinite(result.executionTimeMs)
        ? result.executionTimeMs
        : 0,
    consoleOutput: normalized.consoleOutput,
    ...(normalized.traceLimitExceeded !== undefined ? { traceLimitExceeded: normalized.traceLimitExceeded } : {}),
    ...(normalized.timeoutReason
      ? { timeoutReason: normalized.timeoutReason as ExecutionResult['timeoutReason'] }
      : {}),
    lineEventCount: normalized.lineEventCount,
    traceStepCount: normalized.trace.length,
  };
}
