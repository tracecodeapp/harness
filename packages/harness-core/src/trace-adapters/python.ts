import type { ExecutionResult } from '../types';
import { adaptTraceExecutionResult } from './shared';

export function adaptPythonTraceExecutionResult(result: ExecutionResult): ExecutionResult {
  return adaptTraceExecutionResult('python', result);
}
