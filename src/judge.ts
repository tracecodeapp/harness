import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';
import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimeExecutionLimits,
  RuntimeExecutionProvider,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../packages/harness-core/src/index';
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
  type JudgeInfrastructureError,
  type JudgePlanError,
  type JudgeRuntimeControlPort,
  type JudgeRuntimeInvocationInput,
  type JudgeRuntimeInvocationOutput,
} from '../packages/judge/src/index';
import {
  JUDGE_INVOCATION_ID_ENV,
  TraceKernelJudgePort,
} from '../packages/judge/src/tracekernel';

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
const UNSUPPORTED_COMPILE_CODE = 'runtime-provider-compile-unsupported';

interface ProvisionalRuntimeExecutionJudgeBindingBase {
  /**
   * Submission source to read with the process-bound TraceKernel syscall port.
   * Relative paths resolve against the Judge process cwd.
   */
  readonly sourcePath: string;
  readonly executionStyle?: RuntimeExecutionStyle;
}

export interface ProvisionalRuntimeExecutionJudgeCodeBinding
  extends ProvisionalRuntimeExecutionJudgeBindingBase {
  readonly trace?: false;
  readonly functionName?: string;
  /**
   * Runtime-enforced limits. Judge's process `timeoutMs` remains the
   * authoritative outer watchdog and is intentionally configured on the plan.
   */
  readonly limits?: RuntimeExecutionLimits;
}

export interface ProvisionalRuntimeExecutionJudgeTraceBinding
  extends ProvisionalRuntimeExecutionJudgeBindingBase {
  readonly trace: true;
  readonly functionName?: string | null;
  readonly traceOptions?: TraceExecutionOptions;
}

/**
 * Provisional 0.14 binding from a lowered Judge plan to the neutral
 * `RuntimeExecutionProvider` call contract.
 *
 * This intentionally contains execution mechanics only. Expected values,
 * comparators, verdicts, and scoring never cross into the runtime provider.
 */
export type ProvisionalRuntimeExecutionJudgeBinding =
  | ProvisionalRuntimeExecutionJudgeCodeBinding
  | ProvisionalRuntimeExecutionJudgeTraceBinding;

interface ProvisionalRuntimeExecutionJudgeProviderOptions {
  readonly runtime: string;
  readonly provider: RuntimeExecutionProvider;
  readonly runtimeControl: JudgeRuntimeControlPort;
  readonly binding: ProvisionalRuntimeExecutionJudgeBinding;
}

export interface CreateProvisionalRuntimeExecutionJudgeOptions {
  readonly runtime: string;
  readonly provider: RuntimeExecutionProvider;
  readonly binding: ProvisionalRuntimeExecutionJudgeBinding;
  /**
   * Override the same-realm control port. A future worker transport can supply
   * this contract without changing Judge or the runtime-provider adapter.
   */
  readonly runtimeControl?: JudgeRuntimeControlPort;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validateProviderOptions(
  options: ProvisionalRuntimeExecutionJudgeProviderOptions
): void {
  if (options.runtime.trim().length === 0) {
    throw new Error('RuntimeExecutionProvider Judge runtime name must not be empty.');
  }
  if (options.binding.sourcePath.trim().length === 0) {
    throw new Error('RuntimeExecutionProvider Judge sourcePath must not be empty.');
  }
}

function isTraceBinding(
  binding: ProvisionalRuntimeExecutionJudgeBinding
): binding is ProvisionalRuntimeExecutionJudgeTraceBinding {
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
      'RuntimeExecutionProvider Judge case input must be a record.'
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
  outcome: Extract<CodeExecutionResult | ExecutionResult, {
    readonly kind: 'failed';
  }>
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
  outcome: Extract<CodeExecutionResult | ExecutionResult, {
    readonly kind: 'limit';
  }>
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
    }),
    process: Object.freeze({
      exitCode: 1,
      stdout,
      stderr: errorText(outcome.error),
    }),
  });
}

function executeProviderCase(
  options: ProvisionalRuntimeExecutionJudgeProviderOptions,
  context: TraceKernelRuntimeProcessContext,
  invocation: JudgeRuntimeInvocationInput
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const binding = options.binding;
    const code = yield* readSubmissionSource(
      context,
      binding.sourcePath
    );
    const inputs = yield* Effect.try({
      try: () => runtimeInputs(invocation),
      catch: errorFromUnknown,
    });
    if (isTraceBinding(binding)) {
      const outcome = yield* Effect.tryPromise({
        try: (signal) =>
          options.provider.executeWithTracing({
            code,
            functionName: binding.functionName ?? null,
            inputs,
            traceOptions: binding.traceOptions,
            executionStyle: binding.executionStyle,
            signal,
          }),
        catch: errorFromUnknown,
      });
      return mappedTraceOutcome(options.runtime, outcome);
    }
    const outcome = yield* Effect.tryPromise({
      try: (signal) =>
        options.provider.executeCode({
          code,
          functionName: binding.functionName ?? '',
          inputs,
          executionStyle: binding.executionStyle,
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
  options: ProvisionalRuntimeExecutionJudgeProviderOptions,
  context: TraceKernelRuntimeProcessContext
): Effect.Effect<TraceKernelRuntimeResult, Error> {
  const invocationId = context.env[JUDGE_INVOCATION_ID_ENV];
  if (!invocationId) {
    return Effect.fail(
      new Error(
        `RuntimeExecutionProvider Judge process is missing ${JUDGE_INVOCATION_ID_ENV}.`
      )
    );
  }
  return options.runtimeControl.read(invocationId).pipe(
    Effect.flatMap((invocation) => {
      if (invocation.phase === 'compile') {
        const mapped = providerFailure(
          options.runtime,
          'RuntimeExecutionProvider performs compilation as part of each code call; ' +
            'this provisional Judge adapter does not implement a separate compile phase.',
          UNSUPPORTED_COMPILE_CODE
        );
        return options.runtimeControl.publish(invocationId, mapped.output).pipe(
          Effect.as(mapped.process)
        );
      }
      return executeProviderCase(options, context, invocation).pipe(
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

/**
 * Low-level provisional bridge for callers that already own a TraceKernel
 * host. The returned provider consumes `RuntimeExecutionProvider`, never the
 * legacy `RuntimeClient`.
 */
function makeProvisionalRuntimeExecutionJudgeProvider(
  options: ProvisionalRuntimeExecutionJudgeProviderOptions
): TraceKernelRuntimeProvider {
  validateProviderOptions(options);
  const binding: ProvisionalRuntimeExecutionJudgeBinding =
    isTraceBinding(options.binding)
      ? Object.freeze({
          ...options.binding,
          ...(options.binding.traceOptions
            ? { traceOptions: Object.freeze({ ...options.binding.traceOptions }) }
            : {}),
        })
      : Object.freeze({
          ...options.binding,
          ...(options.binding.limits
            ? { limits: Object.freeze({ ...options.binding.limits }) }
            : {}),
        });
  const providerOptions: ProvisionalRuntimeExecutionJudgeProviderOptions =
    Object.freeze({
      ...options,
      binding,
    });
  let nextLeaseId = 1;
  return Object.freeze({
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
                  executeProviderProcess(providerOptions, context),
                release: () => Effect.void,
              }),
            })
          : Effect.fail(
              new Error(
                `RuntimeExecutionProvider ${JSON.stringify(providerOptions.runtime)} ` +
                'reported unsuccessful initialization.'
              )
            )
      )
    ),
  });
}

/**
 * Root-package composition for the first executable 0.14 migration slice.
 *
 * The factory deliberately remains provisional: language-specific driver
 * generation, compile artifact policy, and worker-backed control transport
 * are still outside this slice.
 */
export interface ProvisionalRuntimeExecutionJudge {
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

class ProvisionalRuntimeExecutionJudgeComposition
  implements ProvisionalRuntimeExecutionJudge {
  constructor(
    readonly runtime: string,
    readonly runtimeControl: JudgeRuntimeControlPort,
    private readonly host: TraceKernelHost,
    private readonly port: TraceKernelJudgePort
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
    return evaluateJudgePlan<
      TraceKernelFileSystemImage,
      Input,
      Result,
      Expected
    >(this.port, plan, options);
  }
}

export function createProvisionalRuntimeExecutionJudge(
  options: CreateProvisionalRuntimeExecutionJudgeOptions
): Effect.Effect<
  ProvisionalRuntimeExecutionJudge,
  never,
  Scope.Scope
> {
  const runtimeControl =
    options.runtimeControl ?? new InMemoryJudgeRuntimeControl();
  const runtimeProvider = makeProvisionalRuntimeExecutionJudgeProvider({
    runtime: options.runtime,
    provider: options.provider,
    runtimeControl,
    binding: options.binding,
  });
  return makeTraceKernelHost({
    providers: [runtimeProvider],
  }).pipe(
    Effect.map((host) =>
      new ProvisionalRuntimeExecutionJudgeComposition(
        options.runtime,
        runtimeControl,
        host,
        new TraceKernelJudgePort({
          host,
          runtimeControl,
        })
      )
    )
  );
}
