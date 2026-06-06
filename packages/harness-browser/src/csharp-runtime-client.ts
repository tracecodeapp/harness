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
import type { CSharpExecutionStyle, CSharpProjectCommandRequest, CSharpWorkerClient } from './csharp-worker-client';
import { batchCodeResultToExecuteResult, executeRuntimeRequest, isRuntimeProjectExecuteRequest } from './runtime-execute';

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
        executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'solution-method';
    if (!codeRequest.trace && !codeRequest.interview && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
      const result = await this.workerClient.executeCodeBatch(
        codeRequest.code,
        codeRequest.functionName ?? '',
        codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle as CSharpExecutionStyle,
        codeRequest.signal
      );
      return batchCodeResultToExecuteResult(codeRequest, result);
    }

    return executeRuntimeRequest(codeRequest, {
      defaultExecutionStyle: 'solution-method',
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
    executionStyle: RuntimeExecutionStyle = 'solution-method',
    signal?: AbortSignal
  ): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: 'trace',
      executionStyle,
      functionName,
    });

    return this.workerClient.executeWithTracing(
      code,
      functionName ?? '',
      inputs,
      options,
      executionStyle as CSharpExecutionStyle,
      signal
    );
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'solution-method',
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: 'execute',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCode(
      code,
      functionName,
      inputs,
      executionStyle as CSharpExecutionStyle,
      signal
    );
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'solution-method',
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: 'interview',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCodeInterviewMode(
      code,
      functionName,
      inputs,
      executionStyle as CSharpExecutionStyle,
      signal
    );
  }
}

export function createCSharpRuntimeClient(workerClient: CSharpWorkerClient): RuntimeClient {
  return new CSharpRuntimeClient(workerClient);
}
