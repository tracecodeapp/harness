import type { Language } from '../runtime-types';
import type { ExecutionResult } from '../types';
import { adaptTraceExecutionResult } from './shared';

export function adaptJavaScriptTraceExecutionResult(
  language: Extract<Language, 'javascript' | 'typescript'>,
  result: ExecutionResult
): ExecutionResult {
  return adaptTraceExecutionResult(language, result);
}
