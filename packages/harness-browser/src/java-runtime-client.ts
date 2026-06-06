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
import { createEmptyRuntimeTrace } from '../../harness-core/src/runtime-trace';
import { assertRuntimeRequestSupported } from './runtime-capability-guards';
import { getLanguageRuntimeProfile } from './runtime-profiles';
import type { JavaExecutionStyle, JavaWorkerClient, JavaWorkerProjectRequest } from './java-worker-client';
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
        executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'function';
    if (!codeRequest.trace && !codeRequest.interview && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile('java'), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
      const batchResult = await this.workerClient.executeCodeBatch(
        codeRequest.code,
        codeRequest.functionName ?? '',
        codeRequest.cases.map((testCase) => testCase.inputs),
        undefined,
        executionStyle as JavaExecutionStyle,
        codeRequest.signal
      );
      return batchCodeResultToExecuteResult(codeRequest, batchResult);
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
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('java'), {
      request: 'trace',
      executionStyle,
      functionName,
    });

    const rawResult = await this.workerClient.executeWithTracing(
      code,
      functionName ?? '',
      inputs,
      options,
      executionStyle as JavaExecutionStyle,
      signal
    );

    if (!rawResult.success) {
      return {
        success: false,
        error: rawResult.error ?? 'Java tracing failed',
        ...(rawResult.errorLine !== undefined ? { errorLine: rawResult.errorLine } : {}),
        trace: createEmptyRuntimeTrace('java', { runId: 'java:run', file: JAVA_DEFAULT_FILE }),
        executionTimeMs: rawResult.executionTimeMs,
        consoleOutput: rawResult.consoleOutput,
        ...(rawResult.traceLimitExceeded !== undefined
          ? { traceLimitExceeded: rawResult.traceLimitExceeded }
          : {}),
        ...(rawResult.timeoutReason ? { timeoutReason: rawResult.timeoutReason } : {}),
        lineEventCount: 0,
        traceStepCount: 0,
        timings: rawResult.timings,
      };
    }

    return {
      success: true,
      output: rawResult.output,
      trace: rawResult.trace,
      consoleOutput: rawResult.consoleOutput,
      executionTimeMs: rawResult.executionTimeMs,
      ...(rawResult.traceLimitExceeded !== undefined
        ? { traceLimitExceeded: rawResult.traceLimitExceeded }
        : {}),
      ...(rawResult.timeoutReason ? { timeoutReason: rawResult.timeoutReason } : {}),
      lineEventCount: rawResult.trace.lineEventCount,
      traceStepCount: rawResult.trace.traceStepCount,
      timings: rawResult.timings,
    };
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function',
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('java'), {
      request: 'execute',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCode(
      code,
      functionName,
      inputs,
      undefined,
      executionStyle as JavaExecutionStyle,
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
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('java'), {
      request: 'interview',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCodeInterviewMode(
      code,
      functionName,
      inputs,
      undefined,
      executionStyle as JavaExecutionStyle,
      signal
    );
  }
}

export function createJavaRuntimeClient(workerClient: JavaWorkerClient): RuntimeClient {
  return new JavaRuntimeClient(workerClient);
}
