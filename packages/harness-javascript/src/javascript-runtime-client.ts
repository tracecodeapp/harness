import {
  type JavaScriptWorkerLanguage,
  type JavaScriptWorkerClient,
} from './javascript-worker-client';
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
import {
  batchCodeResultToExecuteResult,
  executeRuntimeRequest,
  isRuntimeProjectExecuteRequest,
} from '@tracecode/harness-browser/internal';

export interface JavaScriptRuntimeClientOptions {
  executeProject?: (request: RuntimeExecuteProjectRequest) => Promise<RuntimeCommandResult>;
}

class JavaScriptRuntimeClient implements RuntimeClient {
  constructor(
    private readonly runtimeLanguage: JavaScriptWorkerLanguage,
    private readonly workerClient: JavaScriptWorkerClient,
    private readonly options: JavaScriptRuntimeClientOptions = {}
  ) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.workerClient.init();
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    if (isRuntimeProjectExecuteRequest(request)) {
      return executeRuntimeRequest(request, {
        defaultExecutionStyle: 'function',
        executeProject: async (projectRequest) => {
          if (!this.options.executeProject) {
            throw new Error(`${this.runtimeLanguage} project execution requires an explicit worker-backed project runner.`);
          }
          return this.options.executeProject(projectRequest);
        },
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'function';
    if (!codeRequest.trace && !codeRequest.limits && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
      const result = await this.workerClient.executeCodeBatch({
        code: codeRequest.code,
        functionName: codeRequest.functionName ?? '',
        inputBatch: codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle,
        language: this.runtimeLanguage,
        signal: codeRequest.signal,
      });
      return batchCodeResultToExecuteResult(codeRequest, result);
    }

    return executeRuntimeRequest(codeRequest, {
      defaultExecutionStyle: 'function',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: 'trace',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
    });
    return this.workerClient.executeWithTracing({ ...call, language: this.runtimeLanguage });
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: 'execute',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
      limits: call.limits,
    });
    return this.workerClient.executeCode({ ...call, language: this.runtimeLanguage });
  }
}

export function createJavaScriptRuntimeClient(
  runtimeLanguage: JavaScriptWorkerLanguage,
  workerClient: JavaScriptWorkerClient,
  options: JavaScriptRuntimeClientOptions = {}
): RuntimeClient {
  return new JavaScriptRuntimeClient(runtimeLanguage, workerClient, options);
}
