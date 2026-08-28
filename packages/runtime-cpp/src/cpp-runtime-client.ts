import type {
  RuntimeClient,
  RuntimeCodeCall,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimeTraceCall,
} from '@tracecode/runtime-contracts';
import type { RuntimeCommandResult } from '@tracecode/runtime-contracts';
import type { CodeExecutionResult, ExecutionResult } from '@tracecode/runtime-contracts';
import { createEmptyRuntimeTrace } from '@tracecode/runtime-contracts';
import { assertRuntimeRequestSupported } from '@tracecode/runtime-browser/internal';
import { getLanguageRuntimeProfile } from '@tracecode/runtime-browser/internal';
import type { CppProjectCommandRequest, CppWorkerClient } from './cpp-worker-client';
import {
  batchCodeResultToExecuteResult,
  batchTraceResultToExecuteResult,
  executeRuntimeRequest,
  isRuntimeProjectExecuteRequest,
} from '@tracecode/runtime-browser/internal';

class CppRuntimeClient implements RuntimeClient {
  constructor(private readonly workerClient: CppWorkerClient) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.workerClient.init();
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    if (isRuntimeProjectExecuteRequest(request)) {
      return executeRuntimeRequest(request, {
        defaultExecutionStyle: 'solution-method',
        executeProject: (projectRequest) =>
          this.workerClient.executeProjectCpp(projectRequest as unknown as CppProjectCommandRequest),
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'solution-method';
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('cpp'), {
      request: codeRequest.trace ? 'trace' : 'execute',
      executionStyle,
      functionName: codeRequest.functionName ?? '',
      limits: codeRequest.limits,
      traceOptions: codeRequest.traceOptions,
    });
    if (codeRequest.trace && !codeRequest.limits && codeRequest.cases.length > 1) {
      const result = await this.workerClient.executeTraceBatch({
        code: codeRequest.code,
        functionName: codeRequest.functionName ?? '',
        inputBatch: codeRequest.cases.map((testCase) => testCase.inputs),
        traceOptions: codeRequest.traceOptions,
        executionStyle,
        signal: codeRequest.signal,
      });
      return batchTraceResultToExecuteResult(codeRequest, result, (error) => ({
        kind: 'failed',
        error,
        trace: createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: 'solution.cpp' }),
        executionTimeMs: 0,
        consoleOutput: [],
      }));
    }

    if (!codeRequest.trace && !codeRequest.limits && codeRequest.cases.length > 1) {
      const result = await this.workerClient.executeCodeBatch({
        code: codeRequest.code,
        functionName: codeRequest.functionName ?? '',
        inputBatch: codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle,
        signal: codeRequest.signal,
      });
      return batchCodeResultToExecuteResult(codeRequest, result);
    }

    return executeRuntimeRequest(codeRequest, {
      defaultExecutionStyle: 'solution-method',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('cpp'), {
      request: 'trace',
      executionStyle: call.executionStyle ?? 'solution-method',
      functionName: call.functionName,
      limits: call.limits,
      traceOptions: call.traceOptions,
    });
    return this.workerClient.executeWithTracing(call);
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('cpp'), {
      request: 'execute',
      executionStyle: call.executionStyle ?? 'solution-method',
      functionName: call.functionName,
      limits: call.limits,
    });
    return this.workerClient.executeCode(call);
  }

}

export function createCppRuntimeClient(workerClient: CppWorkerClient): RuntimeClient {
  return new CppRuntimeClient(workerClient);
}
