import type { ExecutionStyle, PyodideWorkerClient } from './pyodide-worker-client';
import type {
  RuntimeClient,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../../harness-core/src/runtime-types';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { adaptPythonTraceExecutionResult } from '../../harness-core/src/trace-adapters/python';
import { assertRuntimeRequestSupported } from './runtime-capability-guards';
import { getLanguageRuntimeProfile } from './runtime-profiles';

class PythonRuntimeClient implements RuntimeClient {
  constructor(private readonly workerClient: PyodideWorkerClient) {}

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
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
      request: 'trace',
      executionStyle,
      functionName,
    });
    const rawResult = await this.workerClient.executeWithTracing(
      code,
      functionName,
      inputs,
      options,
      executionStyle as ExecutionStyle
    );
    return adaptPythonTraceExecutionResult(rawResult);
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

export function createPythonRuntimeClient(workerClient: PyodideWorkerClient): RuntimeClient {
  return new PythonRuntimeClient(workerClient);
}
