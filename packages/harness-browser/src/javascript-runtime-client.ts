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
        this.runtimeLanguage,
        codeRequest.signal
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
    executionStyle: RuntimeExecutionStyle = 'function',
    signal?: AbortSignal
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
      this.runtimeLanguage,
      signal
    );
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function',
    signal?: AbortSignal
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
      this.runtimeLanguage,
      signal
    );
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function',
    signal?: AbortSignal
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
      this.runtimeLanguage,
      signal
    );
  }
}

export function createJavaScriptRuntimeClient(
  runtimeLanguage: JavaScriptWorkerLanguage,
  workerClient: JavaScriptWorkerClient,
  options: JavaScriptRuntimeClientOptions = {}
): RuntimeClient {
  return new JavaScriptRuntimeClient(runtimeLanguage, workerClient, options);
}
