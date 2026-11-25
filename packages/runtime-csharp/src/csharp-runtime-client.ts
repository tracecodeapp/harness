import type {
  RuntimeClient,
  RuntimeCodeCall,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  Drawing,
  RuntimeObservationCall,
  RuntimeObservationProvider,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgram,
  RuntimePreparedTraceBatchCall,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeTraceCall,
  TraceExecutionOptions,
} from '@tracecode/runtime-contracts';
import type { RuntimeCommandResult } from '@tracecode/runtime-contracts';
import type { CodeExecutionResult, ExecutionResult } from '@tracecode/runtime-contracts';
import { RuntimeProviderError } from '@tracecode/runtime-contracts';
import { assertRuntimeRequestSupported } from '@tracecode/runtime-browser/internal';
import { getLanguageRuntimeProfile } from '@tracecode/runtime-browser/internal';
import type { JudgedPreparationCall } from '../../runtime-contracts/src/judged-output-policy';
import type {
  CSharpExecutionStyle,
  CSharpPreparedProgramArtifact,
  CSharpPreparedRunnerTier,
  CSharpProjectCommandRequest,
  CSharpWorkerClient,
} from './csharp-worker-client';
import {
  batchCodeResultToExecuteResult,
  executeRuntimeRequest,
  isRuntimeProjectExecuteRequest,
} from '@tracecode/runtime-browser/internal';
import {
  CSHARP_ALGORITHM_FAST_MAX_CASES_PER_RUNNER,
  CSHARP_ALGORITHM_FAST_MAX_MANAGED_HEAP_BYTES,
} from './csharp-fast-runner-policy';

function managedHeapBytes(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const timings = (result as { timings?: unknown }).timings;
  if (!timings || typeof timings !== 'object') return 0;
  const value = (timings as Record<string, unknown>).managedHeapBytes;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function completedPreparedCase(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === 'object' &&
      (result as { kind?: unknown }).kind === 'completed'
  );
}

const CSHARP_PREPARATION_PROVIDER_ERRORS = new Set([
  'Invalid C# preparation request.',
  'C# preparation did not produce a reusable compiled artifact.',
]);

/**
 * An observer runner started when its observation lease is prepared. It has
 * run nothing but the trusted prime, and only this lease can take it.
 */
export interface CSharpPrestartedRunner {
  /** Settles, never rejecting, once the runner is primed or has been retired. */
  readonly ready: Promise<void>;
  /**
   * After `ready`: the primed runner, if it is still live provider capacity.
   * Ownership moves to the caller, who releases it like a created observer
   * runner. Otherwise the runner is retired and this returns undefined.
   */
  take(): CSharpWorkerClient | undefined;
  /** Retire the runner if it was never taken. */
  cancel(): void;
}

export interface CSharpPreparedWorkerAuthority {
  readonly compiler: CSharpWorkerClient;
  readonly batchConcurrency: number;
  warmup(): Promise<{ success: boolean; loadTimeMs: number }>;
  createRunner(tier: CSharpPreparedRunnerTier): CSharpWorkerClient;
  releaseRunner(runner: CSharpWorkerClient): void;
  createObserverRunner?(): CSharpWorkerClient;
  prestartObserverRunner?(): CSharpPrestartedRunner;
  releaseObserverRunner?(runner: CSharpWorkerClient): void;
}

/** Wait for a promise that never rejects, or reject with the signal's reason. */
function untilSettledOrAborted(
  promise: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
  });
}

export class CSharpRuntimeClient implements RuntimeClient, RuntimePreparedExecutionProvider {
  /** Runner leases boot the C# runtime outside each case's own clock. */
  readonly lifecycleAllowanceMs = 45_000;

  constructor(
    private readonly workerClient: CSharpWorkerClient,
    private readonly preparedAuthority?: CSharpPreparedWorkerAuthority
  ) {}

  private get preparedCompiler(): CSharpWorkerClient {
    return this.preparedAuthority?.compiler ?? this.workerClient;
  }

  private async withPreparedRunner<TResult>(
    tier: CSharpPreparedRunnerTier,
    execute: (runner: CSharpWorkerClient) => Promise<TResult>
  ): Promise<TResult> {
    if (!this.preparedAuthority) return execute(this.workerClient);
    const runner = this.preparedAuthority.createRunner(tier);
    try {
      return await execute(runner);
    } finally {
      runner.terminate();
      this.preparedAuthority.releaseRunner(runner);
    }
  }

  private async withFreshPreparedRunners<TResult>(
    tier: CSharpPreparedRunnerTier,
    inputBatch: readonly Record<string, unknown>[],
    execute: (
      runner: CSharpWorkerClient,
      inputs: Record<string, unknown>,
      index: number
    ) => Promise<TResult>,
    signal?: AbortSignal
  ): Promise<readonly TResult[]> {
    const concurrency = Math.min(
      inputBatch.length,
      this.preparedAuthority?.batchConcurrency ?? 1
    );
    const results: TResult[] = new Array(inputBatch.length);
    let nextIndex = 0;
    let terminalFailure: { reason: unknown } | undefined;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (
          terminalFailure === undefined &&
          nextIndex < inputBatch.length
        ) {
          if (signal?.aborted) {
            terminalFailure = {
              reason:
                signal.reason ??
                new Error('Prepared C# batch was aborted.'),
            };
            break;
          }
          const index = nextIndex;
          nextIndex += 1;
          const inputs = inputBatch[index]!;
          try {
            results[index] = await this.withPreparedRunner(tier, (runner) =>
              execute(runner, inputs, index)
            );
          } catch (reason) {
            terminalFailure ??= { reason };
          }
        }
      })
    );
    if (terminalFailure) throw terminalFailure.reason;
    return results;
  }

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.preparedAuthority?.warmup() ?? this.workerClient.init();
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
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
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
      limits: call.limits,
      traceOptions: call.traceOptions,
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

  async prepareObservation(
    program: RuntimeObservationCall['program'],
    signal?: AbortSignal,
    traceOptions?: Readonly<TraceExecutionOptions>
  ): Promise<(RuntimeObservationProvider & { dispose(): Promise<void> }) | Extract<Drawing, { status: 'refused' }>> {
    const authority = this.preparedAuthority;
    const { maxTraceBytes, traceProfile, ...compilerOptions } = traceOptions ?? {};
    if (traceProfile !== undefined ||
        (maxTraceBytes !== undefined && (!Number.isSafeInteger(maxTraceBytes) || maxTraceBytes < 0))) {
      return { status: 'refused', reason: 'unsupported-option' };
    }
    signal?.throwIfAborted();
    const create = authority?.createObserverRunner?.bind(authority);
    if (!create) return { status: 'refused', reason: 'recorder-unavailable' };

    const compiler = this.preparedCompiler;
    const lifetime = new AbortController();
    let artifact: CSharpPreparedProgramArtifact | undefined;
    let retainedRunner: CSharpWorkerClient | undefined;
    let retainedCases = 0;
    let tail = Promise.resolve();
    let disposal: Promise<void> | undefined;
    const release = (runner: CSharpWorkerClient): void => {
      if (retainedRunner === runner) {
        retainedRunner = undefined;
        retainedCases = 0;
      }
      runner.terminate();
      authority?.releaseObserverRunner?.(runner);
    };
    // Boot and prime this lease's own runner now, so .NET has loaded by the
    // time the companion compile returns. The first observe() takes it.
    let prestarted = authority?.prestartObserverRunner?.();
    const takePrestarted = async (
      signal: AbortSignal
    ): Promise<CSharpWorkerClient | undefined> => {
      const start = prestarted;
      prestarted = undefined;
      if (!start) return undefined;
      try {
        await untilSettledOrAborted(start.ready, signal);
      } catch (error) {
        start.cancel();
        throw error;
      }
      return start.take();
    };

    // The façade can acquire this lease before Roslyn has started on a cold
    // host. Submit the companion to the shared compiler only after Judge
    // admits a case from the successfully prepared ordinary assembly.
    const prepareCompanion = async () => {
      const prepared = await this.prepareArtifact({
        ...program,
        mode: 'trace',
        traceOptions: compilerOptions,
        signal: lifetime.signal,
      });
      return prepared.kind === 'artifact' ? prepared.artifact : undefined;
    };
    let companion: ReturnType<typeof prepareCompanion> | undefined;
    const observe = async (call: RuntimeObservationCall): Promise<Drawing> => {
      const signal = call.signal
        ? AbortSignal.any([call.signal, lifetime.signal])
        : lifetime.signal;
      signal.throwIfAborted();
      try {
        artifact = await (companion ??= prepareCompanion());
      } catch {
        signal.throwIfAborted();
        prestarted?.cancel();
        prestarted = undefined;
        return { status: 'refused', reason: 'observer-prepare' };
      }
      signal.throwIfAborted();
      if (!artifact) {
        prestarted?.cancel();
        prestarted = undefined;
        return { status: 'refused', reason: 'observer-prepare' };
      }

      const fast = artifact.preparedRunnerTier === 'algorithm-fast';
      const runner = retainedRunner ?? await takePrestarted(signal) ?? create();
      try {
        const drawing = await runner.observePrepared(artifact, {
          ...call,
          traceOptions: traceOptions ?? call.traceOptions,
          signal,
        });
        signal.throwIfAborted();
        if (fast && drawing.status !== 'refused' &&
            ++retainedCases < CSHARP_ALGORITHM_FAST_MAX_CASES_PER_RUNNER) {
          retainedRunner = runner;
        } else {
          release(runner);
        }
        return drawing;
      } catch (error) {
        release(runner);
        throw error;
      }
    };

    return {
      observe(call): Promise<Drawing> {
        if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason);
        const execution = tail.then(() => observe(call));
        tail = execution.then(() => undefined, () => undefined);
        return execution;
      },
      dispose() {
        if (disposal) return disposal;
        prestarted?.cancel();
        prestarted = undefined;
        lifetime.abort();
        disposal = tail.then(async () => {
          if (retainedRunner) release(retainedRunner);
          if (artifact) await compiler.disposePreparedProgram(artifact);
        });
        return disposal;
      },
    };
  }

  private async prepareArtifact(
    call: RuntimeProgramPreparationCall
  ) {
    const executionStyle = call.executionStyle ?? 'solution-method';
    const functionName = call.functionName ?? '';
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('csharp'), {
      request: call.mode === 'trace' ? 'trace' : 'execute',
      executionStyle,
      functionName,
      traceOptions: call.traceOptions,
    });

    const result = await this.preparedCompiler.prepareProgram(call);
    if (!result.success) {
      if (result.timeoutReason) {
        // Compilation runs no learner code; a compile that hit a deadline is
        // the provider's failure, never the learner's limit.
        throw new RuntimeProviderError(
          `C# compilation stopped by its deadline (${result.timeoutReason}): ${result.error ?? 'no detail'}`
        );
      }

      const diagnostic = result.diagnostics?.find((candidate) =>
        candidate.file.endsWith('solution.cs') || candidate.file.endsWith('UserCode.cs')
      );
      // The compiler host analyzes and compiles the learner's source; its
      // failures (Roslyn errors, a denied API, a missing Solution method) are
      // the learner's compile stage. Only its own precondition failures are
      // the provider's.
      if (CSHARP_PREPARATION_PROVIDER_ERRORS.has(String(result.error ?? '').trim())) {
        throw new RuntimeProviderError(String(result.error));
      }
      return {
        kind: 'failed' as const,
        error: result.error ?? 'C# preparation failed',
        ...(diagnostic ? { errorLine: diagnostic.line, diagnostic } : {}),
        diagnosticStage: 'compile' as const,
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }

    if (
      typeof result.compiledArtifactKey !== 'string' ||
      !result.compiledArtifactKey ||
      typeof result.compiledArtifactBase64 !== 'string' ||
      !result.compiledArtifactBase64 ||
      typeof result.compiledArtifactSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(result.compiledArtifactSha256)
    ) {
      throw new RuntimeProviderError(
        'C# preparation completed without a reusable compiled artifact.'
      );
    }

    const preparedRunnerTier = result.preparedRunnerTier;
    const preparedRunnerReason = result.preparedRunnerReason;
    if (
      (preparedRunnerTier !== 'algorithm-fast' &&
        preparedRunnerTier !== 'compatibility') ||
      typeof preparedRunnerReason !== 'string' ||
      !preparedRunnerReason ||
      (preparedRunnerTier === 'algorithm-fast' &&
        !result.traceClrWireContract)
    ) {
      throw new RuntimeProviderError(
        'C# preparation completed without a valid runner-tier descriptor.'
      );
    }

    const artifact: CSharpPreparedProgramArtifact = Object.freeze({
      mode: call.mode,
      code: call.code,
      functionName,
      executionStyle: executionStyle as CSharpExecutionStyle,
      ...(call.traceOptions
        ? { traceOptions: Object.freeze({ ...call.traceOptions }) }
        : {}),
      compiledArtifactKey: result.compiledArtifactKey,
      compiledArtifactBase64: result.compiledArtifactBase64,
      compiledArtifactSha256: result.compiledArtifactSha256,
      preparedRunnerTier,
      preparedRunnerReason,
      ...(result.traceClrWireContract
        ? {
            traceClrWireContract: Object.freeze({
              parameters: Object.freeze(
                result.traceClrWireContract.parameters.map((parameter) =>
                  Object.freeze({
                    name: parameter.name,
                    type: Object.freeze({ ...parameter.type }),
                  })
                )
              ),
              returnType: Object.freeze({
                ...result.traceClrWireContract.returnType,
              }),
            }),
          }
        : {}),
    });
    return {
      kind: 'artifact' as const,
      artifact,
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

  async prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    const maxJudgedOutputBytes = call.mode === 'code'
      ? (call as JudgedPreparationCall).judgedOutputPolicy?.maxBytes
      : undefined;
    const preparation = await this.prepareArtifact(call);
    if (preparation.kind === 'failed') return preparation;
    let artifact: CSharpPreparedProgramArtifact | undefined = preparation.artifact;
    const { preparedRunnerTier } = artifact;
    let disposed = false;
    let disposePromise: Promise<void> | undefined;
    const activeExecutions = new Set<{
      readonly controller: AbortController;
      readonly settled: Promise<unknown>;
    }>();
    let retainedFastRunner: CSharpWorkerClient | undefined;
    let retainedFastRunnerCases = 0;
    let retainedFastRunnerTail = Promise.resolve();
    const releaseRetainedFastRunner = (): void => {
      const runner = retainedFastRunner;
      retainedFastRunner = undefined;
      retainedFastRunnerCases = 0;
      if (!runner) return;
      runner.terminate();
      this.preparedAuthority?.releaseRunner(runner);
    };
    const withOwnedPreparedRunner = <TResult>(
      tier: CSharpPreparedRunnerTier,
      execute: (runner: CSharpWorkerClient) => Promise<TResult>
    ): Promise<TResult> => {
      if (tier !== 'algorithm-fast' || !this.preparedAuthority) {
        return this.withPreparedRunner(tier, execute);
      }
      const run = retainedFastRunnerTail.then(async () => {
        if (disposed) {
          throw new Error('Prepared C# program has been disposed.');
        }
        const runner = retainedFastRunner ??=
          this.preparedAuthority!.createRunner('algorithm-fast');
        try {
          const result = await execute(runner);
          retainedFastRunnerCases += 1;
          if (
            !completedPreparedCase(result) ||
            retainedFastRunnerCases >=
              CSHARP_ALGORITHM_FAST_MAX_CASES_PER_RUNNER ||
            managedHeapBytes(result) >=
              CSHARP_ALGORITHM_FAST_MAX_MANAGED_HEAP_BYTES
          ) {
            releaseRetainedFastRunner();
          }
          return result;
        } catch (error) {
          releaseRetainedFastRunner();
          throw error;
        }
      });
      retainedFastRunnerTail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    };
    const withOwnedPreparedBatchRunners = async <TResult>(
      tier: CSharpPreparedRunnerTier,
      inputBatch: readonly Record<string, unknown>[],
      execute: (
        runner: CSharpWorkerClient,
        inputs: Record<string, unknown>,
        index: number
      ) => Promise<TResult>,
      signal?: AbortSignal
    ): Promise<readonly TResult[]> => {
      if (tier !== 'algorithm-fast') {
        return this.withFreshPreparedRunners(
          tier,
          inputBatch,
          execute,
          signal
        );
      }
      const results: TResult[] = [];
      for (const [index, inputs] of inputBatch.entries()) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error('Prepared C# batch was aborted.');
        }
        results.push(await withOwnedPreparedRunner(tier, (runner) =>
          execute(runner, inputs, index)
        ));
      }
      return results;
    };
    const capabilities = Object.freeze({
      profile:
        preparedRunnerTier === 'algorithm-fast'
          ? 'fast' as const
          : 'compatibility' as const,
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
          await this.preparedCompiler.disposePreparedProgram(ownedArtifact);
        }
        await retainedFastRunnerTail;
        releaseRetainedFastRunner();
      })();
      return disposePromise;
    };

    let program: RuntimePreparedProgram;
    program = call.mode === 'trace'
      ? {
          mode: 'trace',
          capabilities,
          executeIsolated: (preparedCall) =>
            executeOwned(preparedCall, (preparedArtifact, forwardedCall) =>
              withOwnedPreparedRunner(preparedArtifact.preparedRunnerTier, (runner) =>
                runner.executePreparedTrace(
                  preparedArtifact,
                  forwardedCall
                )
              )
            ),
          executeBatchIsolated: (
            preparedCall: RuntimePreparedTraceBatchCall
          ) => {
            if (
              preparedCall.traceEnabledBatch !== undefined &&
              (
                preparedCall.traceEnabledBatch.length !==
                  preparedCall.inputBatch.length ||
                preparedCall.traceEnabledBatch.some(
                  (enabled) => typeof enabled !== 'boolean'
                )
              )
            ) {
              return Promise.reject(new TypeError(
                'C# trace selection must contain one boolean per batch case.'
              ));
            }
            return executeOwned(preparedCall, (preparedArtifact, forwardedCall) =>
              withOwnedPreparedBatchRunners(
                preparedArtifact.preparedRunnerTier,
                forwardedCall.inputBatch,
                (runner, inputs, index) =>
                  runner.executePreparedTrace(
                    preparedArtifact,
                    {
                      inputs,
                      ...(forwardedCall.traceEnabledBatch === undefined
                        ? {}
                        : {
                            recordTrace:
                              forwardedCall.traceEnabledBatch[index],
                          }),
                      signal: forwardedCall.signal,
                      limits: forwardedCall.limits,
                    }
                  ),
                forwardedCall.signal
              )
            );
          },
          dispose,
        }
      : {
          mode: 'code',
          capabilities,
          executeIsolated: (preparedCall) =>
            executeOwned(preparedCall, (preparedArtifact, forwardedCall) =>
              withOwnedPreparedRunner(preparedArtifact.preparedRunnerTier, (runner) =>
                runner.executePreparedCode(preparedArtifact, forwardedCall, maxJudgedOutputBytes)
              )
            ),
          executeBatchIsolated: (
            preparedCall: RuntimePreparedCodeBatchCall
          ) =>
            executeOwned(preparedCall, (preparedArtifact, forwardedCall) =>
              withOwnedPreparedBatchRunners(
                preparedArtifact.preparedRunnerTier,
                forwardedCall.inputBatch,
                (runner, inputs) =>
                  runner.executePreparedCode(preparedArtifact, {
                    inputs,
                    signal: forwardedCall.signal,
                    limits: forwardedCall.limits,
                  }, maxJudgedOutputBytes),
                forwardedCall.signal
              )
            ),
          dispose,
        };

    return {
      kind: 'prepared',
      program: Object.freeze(program),
      consoleOutput: preparation.consoleOutput,
      timings: preparation.timings,
    };
  }

}

export function createCSharpRuntimeClient(
  workerClient: CSharpWorkerClient,
  preparedAuthority?: CSharpPreparedWorkerAuthority
): CSharpRuntimeClient {
  return new CSharpRuntimeClient(workerClient, preparedAuthority);
}
