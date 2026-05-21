import type { ExecutionStyle, PythonProjectCommandRequest, PythonWorkerClient } from './pyodide-worker-client';
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

class PythonRuntimeClient implements RuntimeClient {
  constructor(private readonly workerClient: PythonWorkerClient) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.workerClient.init();
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    if (isRuntimeProjectExecuteRequest(request)) {
      return executeRuntimeRequest(request, {
        defaultExecutionStyle: 'function',
        executeProject: (projectRequest) =>
          this.workerClient.executeProjectPython(projectRequest as PythonProjectCommandRequest),
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
        executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'function';
    if (!codeRequest.trace && !codeRequest.interview && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
      const result = await this.workerClient.executeCodeBatch(
        codeRequest.code,
        codeRequest.functionName ?? '',
        codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle as ExecutionStyle
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
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
      request: 'trace',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeWithTracing(
      code,
      functionName,
      inputs,
      options,
      executionStyle as ExecutionStyle
    );
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
      request: 'execute',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCode(
      code,
      functionName,
      inputs,
      executionStyle as ExecutionStyle
    );
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
      request: 'interview',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCodeInterviewMode(
      code,
      functionName,
      inputs,
      executionStyle as ExecutionStyle
    );
  }
}

export function createPythonRuntimeClient(workerClient: PythonWorkerClient): RuntimeClient {
  return new PythonRuntimeClient(workerClient);
}
