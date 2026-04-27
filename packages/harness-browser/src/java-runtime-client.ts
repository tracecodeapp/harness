import type {
  RuntimeClient,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../../harness-core/src/runtime-types';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { buildJavaExecutionResult } from '../../harness-core/src/trace-adapters/java';
import { adaptJavaTraceExecutionResult } from '../../harness-core/src/trace-adapters/java';
import { assertRuntimeRequestSupported } from './runtime-capability-guards';
import { getLanguageRuntimeProfile } from './runtime-profiles';
import type { JavaExecutionStyle, JavaWorkerClient } from './java-worker-client';

class JavaRuntimeClient implements RuntimeClient {
  constructor(private readonly workerClient: JavaWorkerClient) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.workerClient.init();
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options?: TraceExecutionOptions,
    executionStyle: RuntimeExecutionStyle = 'function'
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
      executionStyle as JavaExecutionStyle
    );

    if (!rawResult.success) {
      return {
        success: false,
        error: rawResult.error ?? 'Java tracing failed',
        ...(rawResult.errorLine !== undefined ? { errorLine: rawResult.errorLine } : {}),
        trace: [],
        executionTimeMs: rawResult.executionTimeMs,
        consoleOutput: rawResult.consoleOutput,
        ...(rawResult.traceLimitExceeded !== undefined
          ? { traceLimitExceeded: rawResult.traceLimitExceeded }
          : {}),
        ...(rawResult.timeoutReason ? { timeoutReason: rawResult.timeoutReason } : {}),
        lineEventCount: 0,
        traceStepCount: 0,
      };
    }

    const adapted = adaptJavaTraceExecutionResult(
      buildJavaExecutionResult(
        rawResult.output,
        rawResult.events,
        rawResult.executionTimeMs,
        rawResult.traceLimitExceeded,
        rawResult.timeoutReason,
        undefined,
        rawResult.sourceText,
        { outputIsSerialized: false }
      )
    );
    return {
      ...adapted,
      consoleOutput: rawResult.consoleOutput,
      executionTimeMs: rawResult.executionTimeMs,
    };
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
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
      executionStyle as JavaExecutionStyle
    );
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
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
      executionStyle as JavaExecutionStyle
    );
  }
}

export function createJavaRuntimeClient(workerClient: JavaWorkerClient): RuntimeClient {
  return new JavaRuntimeClient(workerClient);
}
