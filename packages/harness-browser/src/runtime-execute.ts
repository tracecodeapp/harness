import type {
  RuntimeCodeCall,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimeExecutionStyle,
  RuntimeTraceCall,
} from '@tracecode/harness-core';
import type { RuntimeCommandResult } from '@tracecode/harness-core';
import type { CodeExecutionBatchResult, CodeExecutionResult, ExecutionResult } from '@tracecode/harness-core';
import { ExecutionTimeoutError } from './worker-errors';

type RuntimeExecuteHandlers = {
  defaultExecutionStyle: RuntimeExecutionStyle;
  executeProject?(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult>;
  executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult>;
};

export function isRuntimeProjectExecuteRequest(
  request: RuntimeExecuteRequest
): request is RuntimeExecuteProjectRequest {
  return request.kind === 'project';
}

export function isRuntimeCodeExecuteRequest(
  request: RuntimeExecuteRequest
): request is RuntimeExecuteCodeRequest {
  return request.kind !== 'project';
}

export function runtimeDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function codeResultToExecuteCase(
  testCase: RuntimeExecuteCodeRequest['cases'][number],
  outcome: CodeExecutionResult
): RuntimeExecuteResult['cases'][number] {
  const hasExpected = Object.prototype.hasOwnProperty.call(testCase, 'expected');
  return {
    id: testCase.id,
    expected: testCase.expected,
    passed: hasExpected
      ? outcome.kind === 'completed' && runtimeDeepEqual(outcome.output, testCase.expected)
      : undefined,
    outcome,
  };
}

export function traceResultToExecuteCase(
  testCase: RuntimeExecuteCodeRequest['cases'][number],
  outcome: ExecutionResult
): RuntimeExecuteResult['cases'][number] {
  const hasExpected = Object.prototype.hasOwnProperty.call(testCase, 'expected');
  return {
    id: testCase.id,
    expected: testCase.expected,
    passed: hasExpected
      ? outcome.kind === 'completed' && runtimeDeepEqual(outcome.output, testCase.expected)
      : undefined,
    outcome,
  };
}

export function batchTraceResultToExecuteResult(
  request: RuntimeExecuteCodeRequest,
  result: { results: readonly ExecutionResult[]; timings?: RuntimeExecuteResult['timings']; error?: string },
  makeMissingOutcome: (error: string) => ExecutionResult
): RuntimeExecuteResult {
  const cases = request.cases.map((testCase, index) =>
    traceResultToExecuteCase(
      testCase,
      result.results[index] ??
        makeMissingOutcome(result.error ?? 'Batch trace execution did not return a result for this case')
    )
  );
  return {
    success: cases.every((testCase) => testCase.outcome.kind === 'completed'),
    cases,
    timings: result.timings,
  };
}

export function batchCodeResultToExecuteResult(
  request: RuntimeExecuteCodeRequest,
  result: CodeExecutionBatchResult
): RuntimeExecuteResult {
  const cases = request.cases.map((testCase, index) =>
    codeResultToExecuteCase(
      testCase,
      result.results[index] ?? {
        kind: 'failed',
        error: result.error ?? 'Batch execution did not return a result for this case',
        consoleOutput: result.consoleOutput ?? [],
      }
    )
  );
  return {
    success: cases.every((testCase) => testCase.outcome.kind === 'completed'),
    cases,
    timings: result.timings,
  };
}

export async function executeRuntimeRequest(
  request: RuntimeExecuteRequest,
  handlers: RuntimeExecuteHandlers
): Promise<RuntimeExecuteResponse> {
  if (isRuntimeProjectExecuteRequest(request)) {
    if (!handlers.executeProject) {
      throw new Error('Runtime execute project request is not supported by this client.');
    }
    return handlers.executeProject(request);
  }

  const codeRequest: RuntimeExecuteCodeRequest = request;

  if (codeRequest.limits && codeRequest.trace) {
    throw new Error('Runtime execute request cannot combine limits with tracing; use traceOptions budgets.');
  }
  if (!Array.isArray(codeRequest.cases) || codeRequest.cases.length === 0) {
    throw new Error('Runtime execute request requires at least one case.');
  }

  const functionName = codeRequest.functionName ?? '';
  const executionStyle = codeRequest.executionStyle ?? handlers.defaultExecutionStyle;
  const cases = [];
  for (const testCase of codeRequest.cases) {
    if (codeRequest.trace) {
      const result = await handlers.executeWithTracing({
        code: codeRequest.code,
        functionName: codeRequest.functionName ?? null,
        inputs: testCase.inputs,
        traceOptions: codeRequest.traceOptions,
        executionStyle,
        signal: codeRequest.signal,
      });
      cases.push(traceResultToExecuteCase(testCase, result));
    } else {
      let result: CodeExecutionResult;
      try {
        result = await handlers.executeCode({
          code: codeRequest.code,
          functionName,
          inputs: testCase.inputs,
          executionStyle,
          signal: codeRequest.signal,
          limits: codeRequest.limits,
        });
      } catch (error) {
        // A caller-configured wall-clock limit tripping is an expected outcome of
        // the caller's own policy, not an infrastructure failure — report it as a
        // structured case result. Timeouts under the harness's default deadline
        // (no wallClockMs set) still reject like any other transport error.
        if (codeRequest.limits?.wallClockMs !== undefined && error instanceof ExecutionTimeoutError) {
          result = {
            kind: 'limit',
            reason: 'client-timeout',
            error: error.message,
            consoleOutput: [],
          };
        } else {
          throw error;
        }
      }
      cases.push(codeResultToExecuteCase(testCase, result));
    }
  }

  return {
    success: cases.every((testCase) => testCase.outcome.kind === 'completed'),
    cases,
  };
}
