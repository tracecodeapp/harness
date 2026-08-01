import type {
  RuntimeClient,
  RuntimeCodeCall,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgram,
  RuntimePreparedTraceBatchCall,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeTraceCall,
} from '@tracecode/runtime-contracts';
import type { RuntimeCommandResult } from '@tracecode/runtime-contracts';
import type { CodeExecutionResult, ExecutionResult } from '@tracecode/runtime-contracts';
import { assertRuntimeRequestSupported } from '@tracecode/runtime-browser/internal';
import { getLanguageRuntimeProfile } from '@tracecode/runtime-browser/internal';
import type {
  CSharpExecutionStyle,
  CSharpPreparedProgramArtifact,
  CSharpProjectCommandRequest,
  CSharpWorkerClient,
} from './csharp-worker-client';
import {
  batchCodeResultToExecuteResult,
  executeRuntimeRequest,
  isRuntimeProjectExecuteRequest,
} from '@tracecode/runtime-browser/internal';

class CSharpRuntimeClient implements RuntimeClient, RuntimePreparedExecutionProvider {
  constructor(private readonly workerClient: CSharpWorkerClient) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.workerClient.init();
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    if (isRuntimeProjectExecuteRequest(request)) {
      return executeRuntimeRequest(request, {
        defaultExecutionStyle: 'solution-method',
        executeProject: (projectRequest) =>
          this.workerClient.executeProjectCSharp(projectRequest as unknown as CSharpProjectCommandRequest),
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
      });
    }

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'solution-method';
    if (!codeRequest.trace && !codeRequest.limits && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
      const result = await this.workerClient.executeCodeBatch({
        code: codeRequest.code,
        functionName: codeRequest.functionName ?? '',
        inputBatch: codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle,
        signal: codeRequest.signal,
      });
      return batchCodeResultToExecuteResult(codeRequest, result);
    }

    return executeRuntimeRequest(codeRequest, {
      defaultExecutionStyle: 'solution-method',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: 'trace',
      executionStyle: call.executionStyle ?? 'solution-method',
      functionName: call.functionName,
    });

    return this.workerClient.executeWithTracing(call);
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: 'execute',
      executionStyle: call.executionStyle ?? 'solution-method',
      functionName: call.functionName,
      limits: call.limits,
    });
    return this.workerClient.executeCode(call);
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    const executionStyle = call.executionStyle ?? 'solution-method';
    const functionName = call.functionName ?? '';
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: call.mode === 'trace' ? 'trace' : 'execute',
      executionStyle,
      functionName,
    });

    const result = await this.workerClient.prepareProgram(call);
    if (!result.success) {
      if (result.timeoutReason) {
        return {
          kind: 'limit',
          reason: result.timeoutReason,
          error: result.error ?? 'C# preparation failed',
          consoleOutput: result.consoleOutput ?? [],
          timings: result.timings,
        };
      }

      const diagnostic = result.diagnostics?.find((candidate) =>
        candidate.file.endsWith('solution.cs') || candidate.file.endsWith('UserCode.cs')
      );
      return {
        kind: 'failed',
        error: result.error ?? 'C# preparation failed',
        ...(diagnostic ? { errorLine: diagnostic.line, diagnostic } : {}),
        diagnosticStage: 'compile',
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }

    if (
      typeof result.compiledArtifactKey !== 'string' ||
      !result.compiledArtifactKey ||
      typeof result.compiledArtifactBase64 !== 'string' ||
      !result.compiledArtifactBase64
    ) {
      return {
        kind: 'failed',
        error: 'C# preparation completed without a reusable compiled artifact.',
        diagnosticStage: 'compile',
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }

    let artifact: CSharpPreparedProgramArtifact | undefined = Object.freeze({
      mode: call.mode,
      code: call.code,
      functionName,
      executionStyle: executionStyle as CSharpExecutionStyle,
      ...(call.traceOptions
        ? { traceOptions: Object.freeze({ ...call.traceOptions }) }
        : {}),
      compiledArtifactKey: result.compiledArtifactKey,
      compiledArtifactBase64: result.compiledArtifactBase64,
    });
    let disposed = false;
    let disposePromise: Promise<void> | undefined;
    const activeExecutions = new Set<{
      readonly controller: AbortController;
      readonly settled: Promise<unknown>;
    }>();
    const capabilities = Object.freeze({
      caseIsolation: 'fresh-case-state' as const,
      maxConcurrency: 1,
    });
    const requireArtifact = (): CSharpPreparedProgramArtifact => {
      if (disposed || !artifact) {
        throw new Error('Prepared C# program has been disposed.');
      }
      return artifact;
    };
    const executeOwned = async <
      TCall extends { readonly signal?: AbortSignal },
      TResult,
    >(
      preparedCall: TCall,
      execute: (
        preparedArtifact: CSharpPreparedProgramArtifact,
        forwardedCall: TCall
      ) => Promise<TResult>
    ): Promise<TResult> => {
      const ownedArtifact = requireArtifact();
      const controller = new AbortController();
      const relayCallerAbort = (): void => {
        controller.abort(preparedCall.signal?.reason);
      };
      if (preparedCall.signal?.aborted) {
        relayCallerAbort();
      } else {
        preparedCall.signal?.addEventListener('abort', relayCallerAbort, {
          once: true,
        });
      }

      const forwardedCall = {
        ...preparedCall,
        signal: controller.signal,
      } as TCall;
      let activeExecution!: {
        readonly controller: AbortController;
        readonly settled: Promise<unknown>;
      };
      const settled = Promise.resolve()
        .then(() => execute(ownedArtifact, forwardedCall))
        .finally(() => {
          preparedCall.signal?.removeEventListener('abort', relayCallerAbort);
          activeExecutions.delete(activeExecution);
        });
      activeExecution = { controller, settled };
      activeExecutions.add(activeExecution);
      return settled;
    };
    const dispose = (): Promise<void> => {
      if (disposePromise) return disposePromise;
      disposed = true;
      const ownedArtifact = artifact;
      const executionsToDrain = [...activeExecutions];
      disposePromise = (async () => {
        const reason = new Error(
          'Prepared C# program was disposed during active execution.'
        );
        for (const execution of executionsToDrain) {
          execution.controller.abort(reason);
        }
        await Promise.allSettled(
          executionsToDrain.map((execution) => execution.settled)
        );

        // Keep ownership of the descriptor until every execution that captured
        // it has settled. The host artifact may only be released afterwards.
        artifact = undefined;
        if (ownedArtifact) {
          await this.workerClient.disposePreparedProgram(ownedArtifact);
        }
      })();
      return disposePromise;
    };

    const program: RuntimePreparedProgram = call.mode === 'trace'
      ? {
          mode: 'trace',
          capabilities,
          executeIsolated: (preparedCall) =>
            executeOwned(preparedCall, (preparedArtifact, forwardedCall) =>
              this.workerClient.executePreparedTrace(
                preparedArtifact,
                forwardedCall
              )
            ),
          executeBatchIsolated: (
            preparedCall: RuntimePreparedTraceBatchCall
          ) =>
            executeOwned(preparedCall, (preparedArtifact, forwardedCall) =>
              this.workerClient.executePreparedTraceBatch(
                preparedArtifact,
                forwardedCall
              )
            ),
          dispose,
        }
      : {
          mode: 'code',
          capabilities,
          executeIsolated: (preparedCall) =>
            executeOwned(preparedCall, (preparedArtifact, forwardedCall) =>
              this.workerClient.executePreparedCode(
                preparedArtifact,
                forwardedCall
              )
            ),
          executeBatchIsolated: (
            preparedCall: RuntimePreparedCodeBatchCall
          ) =>
            executeOwned(preparedCall, (preparedArtifact, forwardedCall) =>
              this.workerClient.executePreparedCodeBatch(
                preparedArtifact,
                forwardedCall
              )
            ),
          dispose,
        };

    return {
      kind: 'prepared',
      program: Object.freeze(program),
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

}

export function createCSharpRuntimeClient(
  workerClient: CSharpWorkerClient
): RuntimeClient & RuntimePreparedExecutionProvider {
  return new CSharpRuntimeClient(workerClient);
}
