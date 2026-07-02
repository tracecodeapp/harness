import type {
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '@tracecode/harness-core';
import type { RuntimeCommandResult } from '@tracecode/harness-core';
import type { CodeExecutionBatchResult, CodeExecutionResult, ExecutionResult } from '@tracecode/harness-core';

type RuntimeExecuteHandlers = {
  defaultExecutionStyle: RuntimeExecutionStyle;
  executeProject?(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: RuntimeExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult>;
  executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options?: TraceExecutionOptions,
    executionStyle?: RuntimeExecutionStyle,
    signal?: AbortSignal
  ): Promise<ExecutionResult>;
  executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: RuntimeExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult>;
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
  result: CodeExecutionResult
): RuntimeExecuteResult['cases'][number] {
  const hasExpected = Object.prototype.hasOwnProperty.call(testCase, 'expected');
  return {
    id: testCase.id,
    success: result.success,
    output: result.output,
    expected: testCase.expected,
    passed: hasExpected ? result.success && runtimeDeepEqual(result.output, testCase.expected) : undefined,
    error: result.error,
    errorLine: result.errorLine,
    consoleOutput: result.consoleOutput,
    timeoutReason: result.timeoutReason,
    diagnosticStage: result.diagnosticStage,
    diagnostic: result.diagnostic,
    timings: result.timings,
  };
}

export function traceResultToExecuteCase(
  testCase: RuntimeExecuteCodeRequest['cases'][number],
  result: ExecutionResult
): RuntimeExecuteResult['cases'][number] {
  const hasExpected = Object.prototype.hasOwnProperty.call(testCase, 'expected');
  return {
    id: testCase.id,
    success: result.success,
    output: result.output,
    expected: testCase.expected,
    passed: hasExpected ? result.success && runtimeDeepEqual(result.output, testCase.expected) : undefined,
    error: result.error,
    errorLine: result.errorLine,
    consoleOutput: result.consoleOutput,
    trace: result.trace,
    traceLimitExceeded: result.traceLimitExceeded,
    timeoutReason: result.timeoutReason,
    diagnostic: result.diagnostic,
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
        success: false,
        output: null,
        error: result.error ?? 'Batch execution did not return a result for this case',
        consoleOutput: result.consoleOutput,
      }
    )
  );
  return {
    success: result.success && cases.every((testCase) => testCase.success),
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

  if (codeRequest.trace && codeRequest.interview) {
    throw new Error('Runtime execute request cannot enable both trace and interview modes.');
  }
  if (!Array.isArray(codeRequest.cases) || codeRequest.cases.length === 0) {
    throw new Error('Runtime execute request requires at least one case.');
  }

  const functionName = codeRequest.functionName ?? '';
  const executionStyle = codeRequest.executionStyle ?? handlers.defaultExecutionStyle;
  const cases = [];
  for (const testCase of codeRequest.cases) {
    if (codeRequest.trace) {
      const result = await handlers.executeWithTracing(
        codeRequest.code,
        codeRequest.functionName ?? null,
        testCase.inputs,
        codeRequest.traceOptions,
        executionStyle,
        codeRequest.signal
      );
      cases.push(traceResultToExecuteCase(testCase, result));
    } else if (codeRequest.interview) {
      const result = await handlers.executeCodeInterviewMode(
        codeRequest.code,
        functionName,
        testCase.inputs,
        executionStyle,
        codeRequest.signal
      );
      cases.push(codeResultToExecuteCase(testCase, result));
    } else {
      const result = await handlers.executeCode(
        codeRequest.code,
        functionName,
        testCase.inputs,
        executionStyle,
        codeRequest.signal
      );
      cases.push(codeResultToExecuteCase(testCase, result));
    }
  }

  return {
    success: cases.every((testCase) => testCase.success),
    cases,
  };
}
