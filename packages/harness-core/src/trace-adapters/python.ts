import type { ExecutionResult, LegacyTraceExecutionResult } from '../types';
import { adaptTraceExecutionResult } from './shared';

export function adaptPythonTraceExecutionResult(result: LegacyTraceExecutionResult): ExecutionResult {
  return adaptTraceExecutionResult('python', result, {
    runId: 'python:run',
    file: 'solution.py',
  });
}
