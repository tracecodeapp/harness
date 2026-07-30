import type {
  RuntimeClient,
  RuntimeCodeCall,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimeTraceCall,
} from '@tracecode/harness-core';
import type { RuntimeCommandResult } from '@tracecode/harness-core';
import type { CodeExecutionResult, ExecutionResult } from '@tracecode/harness-core';
import { assertRuntimeRequestSupported } from '@tracecode/harness-browser/internal';
import { getLanguageRuntimeProfile } from '@tracecode/harness-browser/internal';
import type { CSharpExecutionStyle, CSharpProjectCommandRequest, CSharpWorkerClient } from './csharp-worker-client';
import {
  batchCodeResultToExecuteResult,
  executeRuntimeRequest,
  isRuntimeProjectExecuteRequest,
} from '@tracecode/harness-browser/internal';

class CSharpRuntimeClient implements RuntimeClient {
  constructor(private readonly workerClient: CSharpWorkerClient) {}

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
          this.workerClient.executeProjectCSharp(projectRequest as unknown as CSharpProjectCommandRequest),
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'solution-method';
    if (!codeRequest.trace && !codeRequest.limits && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
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
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: 'trace',
      executionStyle: call.executionStyle ?? 'solution-method',
      functionName: call.functionName,
    });

    return this.workerClient.executeWithTracing(call);
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: 'execute',
      executionStyle: call.executionStyle ?? 'solution-method',
      functionName: call.functionName,
      limits: call.limits,
    });
    return this.workerClient.executeCode(call);
  }

}

export function createCSharpRuntimeClient(workerClient: CSharpWorkerClient): RuntimeClient {
  return new CSharpRuntimeClient(workerClient);
}
