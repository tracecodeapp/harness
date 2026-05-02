import type {
  RuntimeClient,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../../harness-core/src/runtime-types';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { assertRuntimeRequestSupported } from './runtime-capability-guards';
import { getLanguageRuntimeProfile } from './runtime-profiles';
import type { CppExecutionStyle, CppWorkerClient } from './cpp-worker-client';

class CppRuntimeClient implements RuntimeClient {
  constructor(private readonly workerClient: CppWorkerClient) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.workerClient.init();
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options?: TraceExecutionOptions,
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('cpp'), {
      request: 'trace',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeWithTracing(
      code,
      functionName ?? '',
      inputs,
      options,
      executionStyle as CppExecutionStyle
    );
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('cpp'), {
      request: 'execute',
      executionStyle,
      functionName,
    });
    return this.workerClient.executeCode(
      code,
      functionName,
      inputs,
      executionStyle as CppExecutionStyle
    );
  }

  async executeCodeInterviewMode(
    _code: string,
    functionName: string,
    _inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('cpp'), {
      request: 'interview',
      executionStyle,
      functionName,
    });
    throw new Error('C++ interview execution is not implemented yet.');
  }
}

export function createCppRuntimeClient(workerClient: CppWorkerClient): RuntimeClient {
  return new CppRuntimeClient(workerClient);
}
