import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import type * as Scope from 'effect/Scope';
import type {
  CodeExecutionResult,
  ExecutionResult,
  Language,
  RuntimeExecutionLimits,
  RuntimeExecutionStyle,
  RuntimePreparedExecutionProvider,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeExecutionTimings,
  TraceExecutionOptions,
} from '../packages/runtime-core/src/index';
import type { BrowserRuntimeHost } from '../packages/runtime-browser/src/browser-runtime-host';
import {
  getBrowserRuntimeHostPreparedProvider,
} from '../packages/runtime-browser/src/browser-runtime-host-internal';
import {
  makeTraceKernelHost,
  type TraceKernelFileSystemImage,
  type TraceKernelHost,
  type TraceKernelRuntimeProcessContext,
  type TraceKernelRuntimeProvider,
  type TraceKernelRuntimeResult,
} from '@tracecode/tracekernel';
import {
  evaluateJudgePlan,
  InMemoryJudgeRuntimeControl,
  structuralJsonComparator,
  type JudgeComparator,
  type JudgeDiagnostic,
  type JudgeEvaluationOptions,
  type JudgeEvaluationPlan,
  type JudgeEvaluationResult,
  JudgeInfrastructureError,
  type JudgePlanError,
  type JudgeRuntimeControlPort,
  type JudgeRuntimeInvocationInput,
  type JudgeRuntimeInvocationOutput,
  type JudgeRuntimeTimings,
} from '../packages/judge/src/index';
import {
  JUDGE_INVOCATION_ID_ENV,
  TraceKernelJudgePort,
} from '../packages/judge/src/tracekernel';
import { RuntimePreparedProgramRegistry } from './internal/judge-prepared-program';

export {
  evaluateJudgePlan,
  structuralJsonComparator,
};
export type {
  JudgeCasePlan,
  JudgeCaseResult,
  JudgeCaseVerdict,
  JudgeComparator,
  JudgeComparisonInput,
  JudgeComparisonResult,
  JudgeDiagnostic,
  JudgeEvaluationOptions,
  JudgeEvaluationPlan,
  JudgeEvaluationResult,
  JudgeProcessPlan,
  JudgeRuntimeControlPort,
  JudgeRuntimeInvocationInput,
  JudgeRuntimeInvocationOutput,
  JudgeWorkspaceFile,
} from '../packages/judge/src/index';

const PROVIDER_ERROR_CODE = 'runtime-provider-error';
const INTERNAL_PREPARE_COMMAND = 'runtime-provider-prepare';

interface RuntimeJudgeBindingBase {
  /**
   * Submission source to read with the process-bound TraceKernel syscall port.
   * Relative paths resolve against the Judge process cwd.
   */
  readonly sourcePath: string;
  readonly executionStyle?: RuntimeExecutionStyle;
  /**
   * Runtime-enforced limits. Judge's process `timeoutMs` remains the
   * authoritative outer watchdog and is intentionally configured on the plan.
   */
  readonly limits?: RuntimeExecutionLimits;
}

export interface RuntimeJudgeCodeBinding
  extends RuntimeJudgeBindingBase {
  readonly trace?: false;
  readonly functionName?: string;
}

export interface RuntimeJudgeTraceBinding
  extends RuntimeJudgeBindingBase {
  readonly trace: true;
  readonly functionName?: string | null;
  readonly traceOptions?: TraceExecutionOptions;
}

/**
 * Binding from a lowered Judge plan to the neutral
 * `RuntimePreparedExecutionProvider` call contract.
 *
 * This intentionally contains execution mechanics only. Expected values,
 * comparators, verdicts, and scoring never cross into the runtime provider.
 */
export type RuntimeJudgeBinding =
  | RuntimeJudgeCodeBinding
  | RuntimeJudgeTraceBinding;

interface RuntimeJudgeProviderOptions {
  readonly runtime: string;
  readonly provider: RuntimePreparedExecutionProvider;
  readonly runtimeControl: JudgeRuntimeControlPort;
  readonly binding: RuntimeJudgeBinding;
}

interface CreateRuntimeJudgeOptions {
  readonly runtime: string;
  /** Prepare-once provider for the selected language runtime. */
  readonly provider: RuntimePreparedExecutionProvider;
  readonly binding: RuntimeJudgeBinding;
  /**
   * Override the same-realm control port. A future worker transport can supply
   * this contract without changing Judge or the runtime-provider adapter.
   */
  readonly runtimeControl?: JudgeRuntimeControlPort;
}

export interface CreateBrowserRuntimeJudgeOptions {
  /** Browser-owned prepared runtime lifecycle. */
  readonly host: BrowserRuntimeHost;
  /** Language provider selected from the host. */
  readonly language: Language;
  readonly binding: RuntimeJudgeBinding;
  /**
   * Override the same-realm control port. A future worker transport can supply
   * this contract without changing Judge or the browser runtime host.
   */
  readonly runtimeControl?: JudgeRuntimeControlPort;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validateProviderOptions(
  options: RuntimeJudgeProviderOptions
): void {
  if (options.runtime.trim().length === 0) {
    throw new Error('Prepared runtime Judge name must not be empty.');
  }
  if (options.binding.sourcePath.trim().length === 0) {
    throw new Error('Prepared runtime Judge sourcePath must not be empty.');
  }
}

function isTraceBinding(
  binding: RuntimeJudgeBinding
): binding is RuntimeJudgeTraceBinding {
  return binding.trace === true;
}

function runtimeInputs(
  invocation: JudgeRuntimeInvocationInput
): Record<string, unknown> {
  const value = invocation.value;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      'Prepared runtime Judge case input must be a record.'
    );
  }
  return value as Record<string, unknown>;
}

function readSubmissionSource(
  context: TraceKernelRuntimeProcessContext,
  path: string
): Effect.Effect<string, Error> {
  return context.syscalls.dispatch({
    op: 'readFile',
    path,
  }).pipe(
    Effect.flatMap((result) => {
      if ('error' in result) {
        return Effect.fail(
          new Error(
            `TraceKernel readFile(${JSON.stringify(path)}) failed with ` +
            `${result.error.code}: ${result.error.message}`
          )
        );
      }
      if (result.value.op !== 'readFile') {
        return Effect.fail(
          new Error(
            `TraceKernel returned ${JSON.stringify(result.value.op)} for a readFile syscall.`
          )
        );
      }
      const value = result.value;
      return Effect.try({
        try: () =>
          new TextDecoder('utf-8', { fatal: true }).decode(value.bytes),
        catch: (error) =>
          new Error(
            `Submission source ${JSON.stringify(path)} is not valid UTF-8.`,
            { cause: error }
          ),
      });
    })
  );
}

function outputText(lines: readonly string[]): string {
  return lines
    .map((line) => line.endsWith('\n') ? line : `${line}\n`)
    .join('');
}

function errorText(message: string): string {
  return message.length === 0 || message.endsWith('\n')
    ? message
    : `${message}\n`;
}

function failureDiagnostic(
  runtime: string,
  outcome: Extract<
    CodeExecutionResult | ExecutionResult | RuntimeProgramPreparationResult,
    {
    readonly kind: 'failed';
    }
  >
): JudgeDiagnostic {
  return Object.freeze({
    severity: 'error',
    message: outcome.error,
    code: outcome.diagnosticStage ?? PROVIDER_ERROR_CODE,
    source: runtime,
    ...(outcome.errorLine === undefined ? {} : { line: outcome.errorLine }),
  });
}

function limitDiagnostic(
  runtime: string,
  outcome: Extract<
    CodeExecutionResult | ExecutionResult | RuntimeProgramPreparationResult,
    {
    readonly kind: 'limit';
    }
  >
): JudgeDiagnostic {
  return Object.freeze({
    severity: 'error',
    message: outcome.error,
    code: outcome.reason,
    source: runtime,
  });
}

function traceTruncationDiagnostic(
  runtime: string,
  outcome: Extract<ExecutionResult, { readonly kind: 'completed' }>
): readonly JudgeDiagnostic[] {
  return outcome.traceTruncated
    ? Object.freeze([Object.freeze({
        severity: 'warning' as const,
        message:
          `Trace recording stopped at the ${outcome.traceTruncated} budget ` +
          'after execution completed.',
        code: outcome.traceTruncated,
        source: runtime,
      })])
    : Object.freeze([]);
}

interface MappedRuntimeOutcome {
  readonly output: JudgeRuntimeInvocationOutput;
  readonly process: TraceKernelRuntimeResult;
}

function mappedTimings(
  timings: RuntimeExecutionTimings | undefined
): { readonly timings?: JudgeRuntimeTimings } {
  return timings
    ? {
        timings: Object.freeze({
          ...timings,
        }) as JudgeRuntimeTimings,
      }
    : {};
}

function mappedCodeOutcome(
  runtime: string,
  outcome: CodeExecutionResult
): MappedRuntimeOutcome {
  const stdout = outputText(outcome.consoleOutput);
  if (outcome.kind === 'completed') {
    return Object.freeze({
      output: Object.freeze({
        value: outcome.output,
        diagnostics: Object.freeze([]),
        ...mappedTimings(outcome.timings),
      }),
      process: Object.freeze({
        exitCode: 0,
        stdout,
        stderr: '',
      }),
    });
  }
  const diagnostic = outcome.kind === 'failed'
    ? failureDiagnostic(runtime, outcome)
    : limitDiagnostic(runtime, outcome);
  return Object.freeze({
    output: Object.freeze({
      diagnostics: Object.freeze([diagnostic]),
      ...mappedTimings(outcome.timings),
    }),
    process: Object.freeze({
      exitCode: 1,
      stdout,
      stderr: errorText(outcome.error),
    }),
  });
}

function mappedTraceOutcome(
  runtime: string,
  outcome: ExecutionResult
): MappedRuntimeOutcome {
  const stdout = outputText(outcome.consoleOutput);
  if (outcome.kind === 'completed') {
    return Object.freeze({
      output: Object.freeze({
        value: outcome.output,
        trace: outcome.trace,
        diagnostics: traceTruncationDiagnostic(runtime, outcome),
        ...mappedTimings(outcome.timings),
      }),
      process: Object.freeze({
        exitCode: 0,
        stdout,
        stderr: '',
      }),
    });
  }
  const diagnostic = outcome.kind === 'failed'
    ? failureDiagnostic(runtime, outcome)
    : limitDiagnostic(runtime, outcome);
  return Object.freeze({
    output: Object.freeze({
      trace: outcome.trace,
      diagnostics: Object.freeze([diagnostic]),
      ...mappedTimings(outcome.timings),
    }),
    process: Object.freeze({
      exitCode: 1,
      stdout,
      stderr: errorText(outcome.error),
    }),
  });
}

function mappedPreparationOutcome(
  runtime: string,
  outcome: RuntimeProgramPreparationResult
): MappedRuntimeOutcome {
  const stdout = outputText(outcome.consoleOutput);
  if (outcome.kind === 'prepared') {
    return Object.freeze({
      output: Object.freeze({
        diagnostics: Object.freeze([]),
        ...mappedTimings(outcome.timings),
      }),
      process: Object.freeze({
        exitCode: 0,
        stdout,
        stderr: '',
      }),
    });
  }
  const diagnostic = outcome.kind === 'failed'
    ? failureDiagnostic(runtime, outcome)
    : limitDiagnostic(runtime, outcome);
  return Object.freeze({
    output: Object.freeze({
      diagnostics: Object.freeze([diagnostic]),
      ...mappedTimings(outcome.timings),
    }),
    process: Object.freeze({
      exitCode: 1,
      stdout,
      stderr: errorText(outcome.error),
    }),
  });
}

function evaluationId(
  invocation: JudgeRuntimeInvocationInput
): string {
  if (!invocation.evaluationId) {
    throw new Error(
      'Prepared runtime Judge invocation is missing an evaluationId.'
    );
  }
  return invocation.evaluationId;
}

function prepareProviderProgram(
  options: RuntimeJudgeProviderOptions,
  programs: RuntimePreparedProgramRegistry,
  context: TraceKernelRuntimeProcessContext,
  invocation: JudgeRuntimeInvocationInput
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const binding = options.binding;
    const code = yield* readSubmissionSource(context, binding.sourcePath);
    const prepareCall: Omit<RuntimeProgramPreparationCall, 'signal'> = {
      mode: isTraceBinding(binding) ? 'trace' : 'code',
      code,
      functionName: isTraceBinding(binding)
        ? binding.functionName ?? null
        : binding.functionName ?? '',
      executionStyle: binding.executionStyle,
      ...(isTraceBinding(binding) && binding.traceOptions
        ? { traceOptions: binding.traceOptions }
        : {}),
    };
    const outcome = yield* Effect.tryPromise({
      try: (signal) =>
        programs.prepare(evaluationId(invocation), {
          ...prepareCall,
          signal,
        }),
      catch: errorFromUnknown,
    });
    return mappedPreparationOutcome(options.runtime, outcome);
  });
}

function executePreparedProviderCase(
  options: RuntimeJudgeProviderOptions,
  programs: RuntimePreparedProgramRegistry,
  invocation: JudgeRuntimeInvocationInput
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const binding = options.binding;
    const inputs = yield* Effect.try({
      try: () => runtimeInputs(invocation),
      catch: errorFromUnknown,
    });
    if (isTraceBinding(binding)) {
      const outcome = yield* Effect.tryPromise({
        try: (signal) =>
          programs.executeTrace(evaluationId(invocation), {
            inputs,
            signal,
            limits: binding.limits,
          }),
        catch: errorFromUnknown,
      });
      return mappedTraceOutcome(options.runtime, outcome);
    }
    const outcome = yield* Effect.tryPromise({
      try: (signal) =>
        programs.executeCode(evaluationId(invocation), {
          inputs,
          signal,
          limits: binding.limits,
        }),
      catch: errorFromUnknown,
    });
    return mappedCodeOutcome(options.runtime, outcome);
  });
}

function providerFailure(
  runtime: string,
  message: string,
  code = PROVIDER_ERROR_CODE
): MappedRuntimeOutcome {
  return Object.freeze({
    output: Object.freeze({
      diagnostics: Object.freeze([Object.freeze({
        severity: 'error' as const,
        message,
        code,
        source: runtime,
      })]),
    }),
    process: Object.freeze({
      exitCode: 1,
      stdout: '',
      stderr: errorText(message),
      termination: Object.freeze({
        kind: 'failure' as const,
        exitCode: 1,
        message,
      }),
    }),
  });
}

function executeProviderProcess(
  options: RuntimeJudgeProviderOptions,
  programs: RuntimePreparedProgramRegistry,
  context: TraceKernelRuntimeProcessContext
): Effect.Effect<TraceKernelRuntimeResult, Error> {
  const invocationId = context.env[JUDGE_INVOCATION_ID_ENV];
  if (!invocationId) {
    return Effect.fail(
      new Error(
        `Prepared runtime Judge process is missing ${JUDGE_INVOCATION_ID_ENV}.`
      )
    );
  }
  return options.runtimeControl.read(invocationId).pipe(
    Effect.flatMap((invocation) => {
      if (invocation.phase === 'compile') {
        return prepareProviderProgram(
          options,
          programs,
          context,
          invocation
        ).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const mapped = providerFailure(
                options.runtime,
                error.message
              );
              return options.runtimeControl.publish(
                invocationId,
                mapped.output
              ).pipe(Effect.as(mapped.process));
            },
            onSuccess: (mapped) =>
              options.runtimeControl.publish(
                invocationId,
                mapped.output
              ).pipe(Effect.as(mapped.process)),
          })
        );
      }
      return executePreparedProviderCase(
        options,
        programs,
        invocation
      ).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            const mapped = providerFailure(options.runtime, error.message);
            return options.runtimeControl.publish(
              invocationId,
              mapped.output
            ).pipe(Effect.as(mapped.process));
          },
          onSuccess: (mapped) =>
            options.runtimeControl.publish(
              invocationId,
              mapped.output
            ).pipe(Effect.as(mapped.process)),
        })
      );
    })
  );
}

interface RuntimeJudgeProviderBridge {
  readonly runtimeProvider: TraceKernelRuntimeProvider;
  beginEvaluation(evaluationId: string): void;
  disposeEvaluation(evaluationId: string): Effect.Effect<void, Error>;
}

/**
 * Low-level bridge for callers that already own a TraceKernel
 * host. Each provider gets a plan-scoped prepared-program registry.
 */
function makeRuntimeJudgeProvider(
  options: RuntimeJudgeProviderOptions
): RuntimeJudgeProviderBridge {
  validateProviderOptions(options);
  const binding: RuntimeJudgeBinding =
    isTraceBinding(options.binding)
      ? Object.freeze({
          ...options.binding,
          ...(options.binding.traceOptions
            ? { traceOptions: Object.freeze({ ...options.binding.traceOptions }) }
            : {}),
          ...(options.binding.limits
            ? { limits: Object.freeze({ ...options.binding.limits }) }
            : {}),
        })
      : Object.freeze({
          ...options.binding,
          ...(options.binding.limits
            ? { limits: Object.freeze({ ...options.binding.limits }) }
            : {}),
        });
  const providerOptions: RuntimeJudgeProviderOptions =
    Object.freeze({
      ...options,
      binding,
    });
  const programs = new RuntimePreparedProgramRegistry(
    providerOptions.provider
  );
  let nextLeaseId = 1;
  const runtimeProvider: TraceKernelRuntimeProvider = Object.freeze({
    runtime: providerOptions.runtime,
    initialize: Effect.tryPromise({
      try: () => providerOptions.provider.init(),
      catch: errorFromUnknown,
    }).pipe(
      Effect.flatMap((result) =>
        result.success
          ? Effect.succeed({
              acquire: (
                context: TraceKernelRuntimeProcessContext
              ) => Effect.succeed({
                id: `${providerOptions.runtime}-judge-${nextLeaseId++}`,
                runtime: providerOptions.runtime,
                execute: () =>
                  executeProviderProcess(
                    providerOptions,
                    programs,
                    context
                  ),
                release: () => Effect.void,
              }),
            })
          : Effect.fail(
              new Error(
                `Prepared runtime provider ${JSON.stringify(providerOptions.runtime)} ` +
                'reported unsuccessful initialization.'
              )
            )
      )
    ),
  });
  return Object.freeze({
    runtimeProvider,
    beginEvaluation: (evaluationId: string) => {
      programs.begin(evaluationId);
    },
    disposeEvaluation: (evaluationId: string) =>
      Effect.tryPromise({
        try: () => programs.dispose(evaluationId),
        catch: errorFromUnknown,
      }),
  });
}

class EvaluationJudgeRuntimeControl
  implements JudgeRuntimeControlPort {
  constructor(
    private readonly delegate: JudgeRuntimeControlPort,
    private readonly evaluationId: string
  ) {}

  begin(
    input: JudgeRuntimeInvocationInput
  ): Effect.Effect<string, Error> {
    return this.delegate.begin({
      ...input,
      evaluationId: this.evaluationId,
    });
  }

  read(
    invocationId: string
  ): Effect.Effect<JudgeRuntimeInvocationInput, Error> {
    return this.delegate.read(invocationId);
  }

  publish(
    invocationId: string,
    output: JudgeRuntimeInvocationOutput
  ): Effect.Effect<void, Error> {
    return this.delegate.publish(invocationId, output);
  }

  take(
    invocationId: string
  ): Effect.Effect<JudgeRuntimeInvocationOutput | undefined, Error> {
    return this.delegate.take(invocationId);
  }

  discard(invocationId: string): Effect.Effect<void> {
    return this.delegate.discard(invocationId);
  }
}

function preparedEvaluationPlan<Input, Expected>(
  plan: JudgeEvaluationPlan<Input, Expected>
): JudgeEvaluationPlan<Input, Expected> {
  if (plan.compile) return plan;
  return Object.freeze({
    ...plan,
    compile: Object.freeze({
      command: INTERNAL_PREPARE_COMMAND,
    }),
  });
}

/**
 * Public runtime-judge facade for 0.14.
 *
 * This is the stable root surface for Judge-backed execution. It keeps the
 * Judge -> TraceKernel -> prepared runtime provider boundary public while the
 * lower-level engine packages remain internal implementation details.
 */
export interface RuntimeJudge {
  readonly runtime: string;
  readonly runtimeControl: JudgeRuntimeControlPort;
  activeSessionIds(): readonly string[];

  evaluate<
    Input = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    plan: JudgeEvaluationPlan<Input, Expected>,
    options?: JudgeEvaluationOptions<Input, Expected, Result>
  ): Effect.Effect<
    JudgeEvaluationResult<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  >;
}

class RuntimeJudgeComposition
  implements RuntimeJudge {
  private nextEvaluationId = 1;

  constructor(
    readonly runtime: string,
    readonly runtimeControl: JudgeRuntimeControlPort,
    private readonly host: TraceKernelHost,
    private readonly bridge: RuntimeJudgeProviderBridge
  ) {}

  activeSessionIds(): readonly string[] {
    return this.host.sessionIds();
  }

  evaluate<
    Input = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    plan: JudgeEvaluationPlan<Input, Expected>,
    options: JudgeEvaluationOptions<Input, Expected, Result> = {}
  ): Effect.Effect<
    JudgeEvaluationResult<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  > {
    return Effect.suspend(() => {
      const evaluationId =
        `${this.runtime}-judge-evaluation-${this.nextEvaluationId++}`;
      this.bridge.beginEvaluation(evaluationId);
      const evaluationControl = new EvaluationJudgeRuntimeControl(
        this.runtimeControl,
        evaluationId
      );
      const port = new TraceKernelJudgePort({
        host: this.host,
        runtimeControl: evaluationControl,
      });
      const effectivePlan = preparedEvaluationPlan(plan);
      const evaluation = evaluateJudgePlan<
        TraceKernelFileSystemImage,
        Input,
        Result,
        Expected
      >(port, effectivePlan, options);

      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(this, function* () {
          const evaluationExit = yield* Effect.exit(restore(evaluation));
          const disposeExit = yield* Effect.exit(
            this.bridge.disposeEvaluation(evaluationId)
          );
          if (Exit.isFailure(disposeExit)) {
            const cause = Cause.squash(disposeExit.cause);
            return yield* Effect.fail(new JudgeInfrastructureError({
              operation: 'dispose prepared runtime program',
              message: errorFromUnknown(cause).message,
              cause,
            }));
          }
          if (Exit.isFailure(evaluationExit)) {
            return yield* Effect.failCause(evaluationExit.cause);
          }
          return evaluationExit.value;
        })
      );
    });
  }
}

function createRuntimeJudge(
  options: CreateRuntimeJudgeOptions
): Effect.Effect<
  RuntimeJudge,
  never,
  Scope.Scope
> {
  const runtimeControl =
    options.runtimeControl ?? new InMemoryJudgeRuntimeControl();
  const bridge = makeRuntimeJudgeProvider({
    runtime: options.runtime,
    provider: options.provider,
    runtimeControl,
    binding: options.binding,
  });
  return makeTraceKernelHost({
    providers: [bridge.runtimeProvider],
  }).pipe(
    Effect.map((host) =>
      new RuntimeJudgeComposition(
        options.runtime,
        runtimeControl,
        host,
        bridge
      )
    )
  );
}

/**
 * Composes a browser-owned prepared provider with the TraceKernel-backed Judge.
 *
 * BrowserRuntimeHost remains the authority for assets, worker readiness, and
 * provider teardown. Judge remains the authority for evaluation sessions,
 * per-case processes, comparison policy, and results.
 */
export function createBrowserRuntimeJudge(
  options: CreateBrowserRuntimeJudgeOptions
): Effect.Effect<
  RuntimeJudge,
  never,
  Scope.Scope
> {
  return createRuntimeJudge({
    runtime: options.language,
    provider: getBrowserRuntimeHostPreparedProvider(
      options.host,
      options.language
    ),
    binding: options.binding,
    runtimeControl: options.runtimeControl,
  });
}
