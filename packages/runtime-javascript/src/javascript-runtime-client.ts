import {
  type JavaScriptWorkerLanguage,
  type JavaScriptWorkerClient,
} from './javascript-worker-client';
import type {
  RuntimeClient,
  RuntimeCodeCall,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimePreparedExecutionProvider,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeTraceCall,
} from '@tracecode/runtime-contracts';
import type { RuntimeCommandResult } from '@tracecode/runtime-contracts';
import type { CodeExecutionResult, ExecutionResult } from '@tracecode/runtime-contracts';
import { assertRuntimeRequestSupported } from '@tracecode/runtime-browser/internal';
import { getLanguageRuntimeProfile } from '@tracecode/runtime-browser/internal';
import {
  batchCodeResultToExecuteResult,
  executeRuntimeRequest,
  isRuntimeProjectExecuteRequest,
} from '@tracecode/runtime-browser/internal';

export interface JavaScriptRuntimeClientOptions {
  executeProject?: (request: RuntimeExecuteProjectRequest) => Promise<RuntimeCommandResult>;
}

export interface JavaScriptRuntimeClient
  extends RuntimeClient,
    RuntimePreparedExecutionProvider {}

class JavaScriptPreparedExecutionProviderImplementation
  implements RuntimePreparedExecutionProvider {
  constructor(
    private readonly runtimeLanguage: JavaScriptWorkerLanguage,
    private readonly workerClient: JavaScriptWorkerClient
  ) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    const result = this.runtimeLanguage === 'typescript'
      ? await this.workerClient.warmup('typescript')
      : await this.workerClient.init();
    return {
      success: result.success,
      loadTimeMs: result.loadTimeMs,
    };
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    assertRuntimeRequestSupported(
      getLanguageRuntimeProfile(this.runtimeLanguage),
      {
        request: call.mode === 'trace' ? 'trace' : 'execute',
        executionStyle: call.executionStyle ?? 'function',
        functionName: call.functionName ?? '',
        traceOptions: call.traceOptions,
      }
    );
    return this.workerClient.prepareProgram(call, this.runtimeLanguage);
  }
}

class JavaScriptRuntimeClientImplementation
  implements JavaScriptRuntimeClient {
  constructor(
    private readonly runtimeLanguage: JavaScriptWorkerLanguage,
    private readonly workerClient: JavaScriptWorkerClient,
    private readonly options: JavaScriptRuntimeClientOptions = {}
  ) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.workerClient.init();
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    assertRuntimeRequestSupported(
      getLanguageRuntimeProfile(this.runtimeLanguage),
      {
        request: call.mode === 'trace' ? 'trace' : 'execute',
        executionStyle: call.executionStyle ?? 'function',
        functionName: call.functionName ?? '',
        traceOptions: call.traceOptions,
      }
    );
    return this.workerClient.prepareProgram(call, this.runtimeLanguage);
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    if (isRuntimeProjectExecuteRequest(request)) {
      return executeRuntimeRequest(request, {
        defaultExecutionStyle: 'function',
        executeProject: async (projectRequest) => {
          if (!this.options.executeProject) {
            throw new Error(`${this.runtimeLanguage} project execution requires an explicit worker-backed project runner.`);
          }
          return this.options.executeProject(projectRequest);
        },
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'function';
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: codeRequest.trace ? 'trace' : 'execute',
      executionStyle,
      functionName: codeRequest.functionName ?? '',
      limits: codeRequest.limits,
      traceOptions: codeRequest.traceOptions,
    });
    if (!codeRequest.trace && !codeRequest.limits && codeRequest.cases.length > 1) {
      const result = await this.workerClient.executeCodeBatch({
        code: codeRequest.code,
        functionName: codeRequest.functionName ?? '',
        inputBatch: codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle,
        language: this.runtimeLanguage,
        signal: codeRequest.signal,
      });
      return batchCodeResultToExecuteResult(codeRequest, result);
    }

    return executeRuntimeRequest(codeRequest, {
      defaultExecutionStyle: 'function',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: 'trace',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
      limits: call.limits,
      traceOptions: call.traceOptions,
    });
    return this.workerClient.executeWithTracing({ ...call, language: this.runtimeLanguage });
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile(this.runtimeLanguage), {
      request: 'execute',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
      limits: call.limits,
    });
    return this.workerClient.executeCode({ ...call, language: this.runtimeLanguage });
  }
}

export function createJavaScriptRuntimeClient(
  runtimeLanguage: JavaScriptWorkerLanguage,
  workerClient: JavaScriptWorkerClient,
  options: JavaScriptRuntimeClientOptions = {}
): JavaScriptRuntimeClient {
  return new JavaScriptRuntimeClientImplementation(
    runtimeLanguage,
    workerClient,
    options
  );
}

export function createJavaScriptPreparedExecutionProvider(
  runtimeLanguage: JavaScriptWorkerLanguage,
  workerClient: JavaScriptWorkerClient
): RuntimePreparedExecutionProvider {
  return new JavaScriptPreparedExecutionProviderImplementation(
    runtimeLanguage,
    workerClient
  );
}
