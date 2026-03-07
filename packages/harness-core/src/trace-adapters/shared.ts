import type { Language } from '../runtime-types';
import {
  normalizeRuntimeTraceContract,
  type RuntimeTraceContractCallStackFrame,
  type RuntimeTraceContractStep,
} from '../trace-contract';
import type {
  CallStackFrame,
  ExecutionResult,
  RawTraceStep,
  RuntimeVisualizationPayload,
} from '../types';

function denormalizeCallStackFrame(frame: RuntimeTraceContractCallStackFrame): CallStackFrame {
  return {
    function: frame.function,
    line: frame.line,
    args: frame.args,
  };
}

function denormalizeTraceStep(step: RuntimeTraceContractStep): RawTraceStep {
  return {
    line: step.line,
    event: step.event,
    variables: step.variables,
    function: step.function,
    ...(step.callStack ? { callStack: step.callStack.map(denormalizeCallStackFrame) } : {}),
    ...(step.returnValue !== undefined ? { returnValue: step.returnValue } : {}),
    ...(step.stdoutLineCount !== undefined ? { stdoutLineCount: step.stdoutLineCount } : {}),
    ...(step.visualization ? { visualization: step.visualization as RuntimeVisualizationPayload } : {}),
  };
}

export function adaptTraceExecutionResult(
  language: Language,
  result: ExecutionResult
): ExecutionResult {
  const normalized = normalizeRuntimeTraceContract(language, result);
  const adaptedTrace: RawTraceStep[] = normalized.trace.map(denormalizeTraceStep);

  return {
    success: normalized.success,
    ...(Object.prototype.hasOwnProperty.call(normalized, 'output') ? { output: normalized.output } : {}),
    ...(normalized.error ? { error: normalized.error } : {}),
    ...(normalized.errorLine !== undefined ? { errorLine: normalized.errorLine } : {}),
    trace: adaptedTrace,
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
    traceStepCount: adaptedTrace.length,
  };
}
