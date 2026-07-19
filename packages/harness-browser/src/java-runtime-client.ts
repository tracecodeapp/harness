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
import { liftTraceOutcome } from '@tracecode/harness-core';
import { assertRuntimeRequestSupported } from './runtime-capability-guards';
import { getLanguageRuntimeProfile } from './runtime-profiles';
import type { JavaWorkerClient, JavaWorkerProjectRequest } from './java-worker-client';
import { batchCodeResultToExecuteResult, executeRuntimeRequest, isRuntimeProjectExecuteRequest } from './runtime-execute';

const JAVA_DEFAULT_FILE = 'solution.java';

class JavaRuntimeClient implements RuntimeClient {
  constructor(private readonly workerClient: JavaWorkerClient) {}

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
          this.workerClient.executeProjectJava(projectRequest as unknown as JavaWorkerProjectRequest),
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'function';
    if (!codeRequest.trace && !codeRequest.limits && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile('java'), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
      const batchResult = await this.workerClient.executeCodeBatch({
        code: codeRequest.code,
        functionName: codeRequest.functionName ?? '',
        inputBatch: codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle,
        signal: codeRequest.signal,
      });
      return batchCodeResultToExecuteResult(codeRequest, batchResult);
    }

    return executeRuntimeRequest(codeRequest, {
      defaultExecutionStyle: 'function',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('java'), {
      request: 'trace',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
    });

    const rawResult = await this.workerClient.executeWithTracing(call);
    return liftTraceOutcome(rawResult, rawResult.trace, 'Java tracing failed');
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('java'), {
      request: 'execute',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
      limits: call.limits,
    });
    return this.workerClient.executeCode(call);
  }
}

export function createJavaRuntimeClient(workerClient: JavaWorkerClient): RuntimeClient {
  return new JavaRuntimeClient(workerClient);
}
