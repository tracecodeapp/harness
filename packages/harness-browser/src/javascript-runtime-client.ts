import {
  type JavaScriptExecutionStyle,
  type JavaScriptWorkerLanguage,
  type JavaScriptWorkerClient,
} from './javascript-worker-client';
import type {
  RuntimeClient,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../../harness-core/src/runtime-types';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { adaptJavaScriptTraceExecutionResult } from '../../harness-core/src/trace-adapters/javascript';
import { assertRuntimeRequestSupported } from './runtime-capability-guards';
import { getLanguageRuntimeProfile } from './runtime-profiles';

class JavaScriptRuntimeClient implements RuntimeClient {
  constructor(
    private readonly runtimeLanguage: JavaScriptWorkerLanguage,
    private readonly workerClient: JavaScriptWorkerClient
  ) {}

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
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: 'trace',
      executionStyle,
      functionName,
    });
    const rawResult = await this.workerClient.executeWithTracing(
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
      this.runtimeLanguage
    );
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
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
      this.runtimeLanguage
    );
  }
}

export function createJavaScriptRuntimeClient(
  runtimeLanguage: JavaScriptWorkerLanguage,
  workerClient: JavaScriptWorkerClient
): RuntimeClient {
  return new JavaScriptRuntimeClient(runtimeLanguage, workerClient);
}
