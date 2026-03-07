import {
  getJavaScriptWorkerClient,
  type JavaScriptExecutionStyle,
  type JavaScriptWorkerLanguage,
} from './javascript-worker-client';
import type {
  RuntimeCapabilities,
  RuntimeClient,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../../harness-core/src/runtime-types';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { adaptJavaScriptTraceExecutionResult } from '../../harness-core/src/trace-adapters/javascript';

const JAVASCRIPT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  supportsTracing: true,
  supportsStepVisualization: true,
  supportsScriptMode: true,
};

class JavaScriptRuntimeClient implements RuntimeClient {
  constructor(private readonly runtimeLanguage: JavaScriptWorkerLanguage) {}

  private getClient() {
    return getJavaScriptWorkerClient();
  }

  getCapabilities(): RuntimeCapabilities {
    return JAVASCRIPT_RUNTIME_CAPABILITIES;
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
      executionStyle as JavaScriptExecutionStyle,
      this.runtimeLanguage
    );
    return adaptJavaScriptTraceExecutionResult(this.runtimeLanguage, rawResult);
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
    return this.getClient().executeCodeInterviewMode(
      code,
      functionName,
      inputs,
      executionStyle as JavaScriptExecutionStyle,
      this.runtimeLanguage
    );
  }
}

let javascriptRuntimeClient: RuntimeClient | null = null;
let typescriptRuntimeClient: RuntimeClient | null = null;

export function getJavaScriptRuntimeClient(): RuntimeClient {
  if (!javascriptRuntimeClient) {
    javascriptRuntimeClient = new JavaScriptRuntimeClient('javascript');
  }
  return javascriptRuntimeClient;
}

export function getTypeScriptRuntimeClient(): RuntimeClient {
  if (!typescriptRuntimeClient) {
    typescriptRuntimeClient = new JavaScriptRuntimeClient('typescript');
  }
  return typescriptRuntimeClient;
}
