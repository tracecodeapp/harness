import type { Language } from '../runtime-types';
import type { ExecutionResult, LegacyTraceExecutionResult } from '../types';
import { adaptTraceExecutionResult } from './shared';

export function adaptJavaScriptTraceExecutionResult(
  language: Extract<Language, 'javascript' | 'typescript'>,
  result: LegacyTraceExecutionResult
): ExecutionResult {
  return adaptTraceExecutionResult(language, result, {
    runId: `${language}:run`,
    file: language === 'typescript' ? 'solution.ts' : 'solution.js',
  });
}
