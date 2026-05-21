import {
  type JavaScriptExecutionStyle,
  type JavaScriptWorkerLanguage,
  type JavaScriptWorkerClient,
} from './javascript-worker-client';
import type {
  RuntimeClient,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../../harness-core/src/runtime-types';
import type { RuntimeCommandResult } from '../../harness-core/src/runtime-project';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { assertRuntimeRequestSupported } from './runtime-capability-guards';
import { getLanguageRuntimeProfile } from './runtime-profiles';
import { batchCodeResultToExecuteResult, executeRuntimeRequest, isRuntimeProjectExecuteRequest } from './runtime-execute';

class JavaScriptRuntimeClient implements RuntimeClient {
  constructor(
    private readonly runtimeLanguage: JavaScriptWorkerLanguage,
    private readonly workerClient: JavaScriptWorkerClient
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
          const projectModule = await import('../../harness-javascript/src/project-browser');
          return this.runtimeLanguage === 'typescript'
            ? projectModule.createBrowserTypeScriptProjectRunner()(projectRequest as never)
            : projectModule.createBrowserJavaScriptProjectRunner()(projectRequest);
        },
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
        executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'function';
    if (!codeRequest.trace && !codeRequest.interview && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
      const result = await this.workerClient.executeCodeBatch(
        codeRequest.code,
        codeRequest.functionName ?? '',
        codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle as JavaScriptExecutionStyle,
        this.runtimeLanguage
      );
      return batchCodeResultToExecuteResult(codeRequest, result);
    }

    return executeRuntimeRequest(codeRequest, {
      defaultExecutionStyle: 'function',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
      executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
    });
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options?: TraceExecutionOptions,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: 'trace',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeWithTracing(
      code,
      functionName,
      inputs,
      options,
      executionStyle as JavaScriptExecutionStyle,
      this.runtimeLanguage
    );
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: 'execute',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCode(
      code,
      functionName,
      inputs,
      executionStyle as JavaScriptExecutionStyle,
      this.runtimeLanguage
    );
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: 'interview',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCodeInterviewMode(
      code,
      functionName,
      inputs,
      executionStyle as JavaScriptExecutionStyle,
      this.runtimeLanguage
    );
  }
}

export function createJavaScriptRuntimeClient(
  runtimeLanguage: JavaScriptWorkerLanguage,
  workerClient: JavaScriptWorkerClient
): RuntimeClient {
  return new JavaScriptRuntimeClient(runtimeLanguage, workerClient);
}
