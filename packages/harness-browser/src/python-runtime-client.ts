import {
  getPyodideWorkerClient,
  type ExecutionStyle,
} from './pyodide-worker-client';
import type {
  RuntimeCapabilities,
  RuntimeClient,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../../harness-core/src/runtime-types';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { adaptPythonTraceExecutionResult } from '../../harness-core/src/trace-adapters/python';

const PYTHON_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  supportsTracing: true,
  supportsStepVisualization: true,
  supportsScriptMode: true,
};

class PythonRuntimeClient implements RuntimeClient {
  private getClient() {
    return getPyodideWorkerClient();
  }

  getCapabilities(): RuntimeCapabilities {
    return PYTHON_RUNTIME_CAPABILITIES;
  }

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.getClient().init();
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options?: TraceExecutionOptions,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<ExecutionResult> {
    const rawResult = await this.getClient().executeWithTracing(
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
    return this.getClient().executeCode(
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
    return this.getClient().executeCodeInterviewMode(
      code,
      functionName,
      inputs,
      executionStyle as ExecutionStyle
    );
  }
}

let pythonRuntimeClient: RuntimeClient | null = null;

export function getPythonRuntimeClient(): RuntimeClient {
  if (!pythonRuntimeClient) {
    pythonRuntimeClient = new PythonRuntimeClient();
  }
  return pythonRuntimeClient;
}
