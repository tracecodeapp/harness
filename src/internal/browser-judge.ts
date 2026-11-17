import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import type {
  CodeExecutionResult,
  ExecutionDiagnosticStage,
  ExecutionLimitReason,
  ExecutionResult,
  Language,
  RuntimeExecutionLimits,
  RuntimeExecutionStyle,
  RuntimePreparedExecutionProvider,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeExecutionTimings,
  TraceExecutionOptions,
} from '../../packages/runtime-contracts/src/index';
import type {
  BrowserRuntimeHost,
} from '../../packages/runtime-browser/src/browser-runtime-host';
import { isExecutionLimitReason, RuntimeProviderError } from '../../packages/runtime-contracts/src/execution-outcome';
import { assertRuntimeRequestSupported } from '../../packages/runtime-browser/src/runtime-capability-guards';
import { getLanguageRuntimeProfile } from '../../packages/runtime-browser/src/runtime-profiles';
import type {
  BrowserRuntimeEnvironment,
  BrowserRuntimeEnvironmentReport,
  BrowserRuntimeReadiness,
} from '../../packages/runtime-browser/src/runtime-environment';
import type {
  BrowserRuntimeAssets,
} from '../../packages/runtime-browser/src/runtime-assets';
import {
  getBrowserRuntimeHostPreparedProvider,
} from '../../packages/runtime-browser/src/browser-runtime-host-internal';
import {
  createBrowserRuntimeHost,
} from '../browser';
import type {
  BrowserExecutionWorkerHostOptions,
} from '../../packages/runtime-browser/src/execution-host';
import type {
  BrowserRuntimeAssetOverrides,
} from '../../packages/runtime-browser/src/runtime-assets';
import type {
  BrowserRuntimeEngine,
  BrowserRuntimeFeatureSupport,
} from '../../packages/runtime-browser/src/runtime-environment';
import type {
  BrowserSafeExecutionOptions,
} from '../../packages/runtime-browser/src/worker-lifecycle-policy';
export {
  BROWSER_WORKER_LIFECYCLE_POLICIES,
} from '../../packages/runtime-browser/src/worker-lifecycle-policy';
export type {
  BrowserSafeExecutionOptions,
  BrowserWorkerLifecyclePolicy,
} from '../../packages/runtime-browser/src/worker-lifecycle-policy';
import {
  makeTraceKernelHost,
  type TraceKernelFileSystemImage,
  type TraceKernelHost,
  type TraceKernelRuntimeProcessContext,
  type TraceKernelRuntimeProvider,
  type TraceKernelRuntimeResult,
} from '@tracecode/tracekernel';
import {
  createAlgorithmJudgeReceipt,
  createJudgeComparator,
  evaluateJudgePlan,
  evaluatePreparedJudgePlan,
  prepareJudgePlan,
  InMemoryJudgeRuntimeControl,
  structuralJsonComparator,
  type JudgeComparator,
  type JudgeDiagnostic,
  type JudgeFailure,
  type JudgeLimitReason,
  type JudgeProgramStage,
  type JudgeEvaluationOptions,
  type JudgeEvaluationPlan,
  type JudgeEvaluationResult,
  type JudgePreparedWorkspace,
  type JudgeAlgorithmBundle,
  type JudgeAlgorithmReceipt,
  JudgeInfrastructureError,
  JudgePlanError,
  type JudgeRuntimeControlPort,
  type JudgeRuntimeInvocationInput,
  type JudgeRuntimeInvocationOutput,
  type JudgeRuntimeBatchCaseOutput,
  type JudgeRuntimeTimings,
  validateAlgorithmJudgeBundle,
} from '../../packages/judge/src/index';
import {
  JUDGE_INVOCATION_ID_ENV,
  TraceKernelJudgePort,
} from '../../packages/judge/src/tracekernel';
import { validateTraceSelection } from '../../packages/judge/src/internal/trace-selection';
import { RuntimePreparedProgramRegistry } from './judge-prepared-program';
import {
  createBrowserProjectJudge,
  type BrowserProjectJudge,
  type BrowserProjectJudgeWorkspaceOptions,
  type CreateBrowserProjectJudgeOptions,
} from './browser-project-judge';

export {
  evaluateJudgePlan,
  structuralJsonComparator,
};
export type {
  JudgeCasePlan,
  JudgeCaseResult,
  JudgeCompileResult,
  JudgeFailure,
  JudgeLimitReason,
  JudgeNotRun,
  JudgeProgramStage,
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
} from '../../packages/judge/src/index';

const PROVIDER_ERROR_CODE = 'runtime-provider-error';

/**
 * Run a Judge effect under the caller's signal. An abort interrupts the
 * evaluation (providers terminate their busy workers) and rejects with the
 * caller's own abort reason, an `AbortError`, never an opaque fiber failure,
 * so a consumer can tell "stopped" from "failed".
 */
function runAbortable<A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined
): Promise<A> {
  if (!signal) return Effect.runPromise(effect);
  return Effect.runPromise(effect, { signal }).catch((error: unknown) => {
    if (!signal.aborted) throw error;
    const reason: unknown = signal.reason;
    throw reason instanceof Error && reason.name === 'AbortError'
      ? reason
      : new DOMException('The run was aborted.', 'AbortError');
  });
}
const INTERNAL_PREPARE_COMMAND = 'runtime-provider-prepare';
export const DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

export interface CreateBrowserJudgeOptions {
  /** Language selected from the Judge host. */
  readonly language: Language;
  readonly binding: RuntimeJudgeBinding;
  /**
   * Override the same-realm control port. A future worker transport can supply
   * this contract without changing Judge or the browser runtime host.
   */
  readonly runtimeControl?: JudgeRuntimeControlPort;
}

/** @internal Low-level bridge used by browser-host conformance tests. */
export interface CreateBrowserRuntimeJudgeOptions
  extends CreateBrowserJudgeOptions {
  readonly host: BrowserRuntimeHost;
}

export interface BrowserJudgeExecutionHostOptions
  extends BrowserExecutionWorkerHostOptions {
  /** Languages routed through the credential-free execution origin. */
  readonly providers?: readonly Language[];
}

export interface BrowserJudgePythonOptions {
  readonly compileCacheLimit?: number;
}

export interface BrowserJudgeJavaOptions {
  readonly workerIdleTimeoutMs?: number;
  readonly compileCacheLimit?: number;
  /** Same-origin trusted Java compiler endpoint. */
  readonly externalCompilerUrl?: string;
  /** Immutable TraceJVM asset tree used by the Java worker. */
  readonly runtimeAssetBaseUrl?: string;
}

export interface BrowserJudgeCSharpOptions {
  /** Idle timeout for the trusted Roslyn compiler authority. */
  readonly compilerIdleTimeoutMs?: number;
  /** Idle timeout for an unused prewarmed disposable Judge runner. */
  readonly runnerIdleTimeoutMs?: number;
  /** Maximum disposable runner leases executing one eager Judge batch concurrently. */
  readonly preparedBatchConcurrency?: number;
}

export interface BrowserJudgeCppOptions {
  readonly initTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
  readonly tracingTimeoutMs?: number;
  readonly workerIdleTimeoutMs?: number;
  readonly programCacheLimit?: number;
  readonly usePrecompiledHeader?: boolean;
  readonly externalCompilerUrl?: string;
}

/**
 * Configuration for the browser Judge authority.
 *
 * Runtime providers are assembled internally. Callers select languages and
 * deployment assets without receiving a provider registry or runtime client.
 */
export interface CreateBrowserJudgeHostOptions {
  readonly assetBaseUrl?: string;
  readonly assets?: BrowserRuntimeAssetOverrides;
  readonly environment?: BrowserRuntimeEnvironment;
  readonly providers?: readonly Language[];
  readonly engine?: BrowserRuntimeEngine;
  readonly featureOverrides?: Partial<BrowserRuntimeFeatureSupport>;
  readonly executionHost?: BrowserJudgeExecutionHostOptions;
  readonly debug?: boolean;
  readonly safeExecution?: BrowserSafeExecutionOptions;
  readonly python?: BrowserJudgePythonOptions;
  readonly java?: BrowserJudgeJavaOptions;
  readonly csharp?: BrowserJudgeCSharpOptions;
  readonly cpp?: BrowserJudgeCppOptions;
  /**
   * Idle lease for retained interactive executions. Continuation work
   * pauses the lease, and completing that work renews it. Defaults to five
   * minutes. Explicit disposal remains the preferred lifecycle path.
   */
  readonly interactiveExecutionIdleTimeoutMs?: number;
  /**
   * Browser TraceKernel configuration used by project evaluations.
   *
   * The Judge owns evaluation policy; this object configures only the
   * execution substrate shared by client-side and mux browser slots.
   */
  readonly project?: BrowserProjectJudgeWorkspaceOptions;
}

/**
 * Long-lived browser authority for judged execution.
 *
 * The host owns runtime assets, warm capacity, and teardown. Each call to
 * `createJudge` returns a scoped TraceKernel/Judge composition for one
 * submission binding.
 */
export interface BrowserJudgeHost {
  readonly assets: BrowserRuntimeAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];
  isLanguageSupported(language: Language): boolean;
  preflightLanguage(language: Language): Promise<BrowserRuntimeReadiness>;
  preflight(): Promise<BrowserRuntimeEnvironmentReport>;
  prewarmLanguage(
    language: Language
  ): Promise<{ success: boolean; loadTimeMs: number }>;
  warmLanguage(
    language: Language
  ): Promise<{ success: boolean; loadTimeMs: number }>;
  disposeLanguage(language: Language): void;
  createJudge(
    options: CreateBrowserJudgeOptions
  ): Effect.Effect<RuntimeJudge, never, Scope.Scope>;
  /**
   * Execute an algorithm bundle. Omitted `interactive` and `tracing` produce
   * one clean, ephemeral evaluation. Supplying `executionId` continues a
   * retained execution without resending code or cases.
   */
  execute<
    Input extends Record<string, unknown> = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    request: BrowserJudgeExecuteRequest<Input, Expected, Result>
  ): Promise<RuntimeJudgeExecuteResult<Result, Expected>>;
  disposeExecution(executionId: string): Promise<void>;
  evaluateAlgorithm<
    Input extends Record<string, unknown> = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    options: {
      readonly bundle: JudgeAlgorithmBundle<Input, Expected, Result>;
      readonly signal?: AbortSignal;
      /**
       * Stop at the first case a time or line limit stopped and report the
       * remaining cases as `not-run`, as Run does. Default off: every case
       * runs under its own bound.
       */
      readonly stopAtFirstRunaway?: boolean;
    }
  ): Promise<JudgeAlgorithmReceipt<Result, Expected>>;
  createProjectJudge(
    options?: Omit<CreateBrowserProjectJudgeOptions, 'workspace'>
  ): BrowserProjectJudge;
  dispose(): void;
}

export interface BrowserJudgeInitialExecuteRequest<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Expected = unknown,
  Result = unknown,
> {
  readonly bundle: JudgeAlgorithmBundle<Input, Expected, Result>;
  readonly interactive?: boolean;
  readonly tracing?: RuntimeJudgeTraceSelection;
  readonly signal?: AbortSignal;
  /**
   * Stop at the first case a time or line limit stopped and report the
   * remaining cases as `not-run`, as Run does. Default off: every case runs
   * under its own bound. Interactive executions always stop.
   */
  readonly stopAtFirstRunaway?: boolean;
}

export interface BrowserJudgeContinueExecuteRequest {
  readonly executionId: string;
  readonly tracing: RuntimeJudgeTraceSelection;
  readonly signal?: AbortSignal;
}

export type BrowserJudgeExecuteRequest<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Expected = unknown,
  Result = unknown,
> =
  | BrowserJudgeInitialExecuteRequest<Input, Expected, Result>
  | BrowserJudgeContinueExecuteRequest;

export type RuntimeJudgeExecutionPhase =
  | 'bundle-validation'
  | 'judge-create'
  | 'initial-execute'
  | 'trace-continuation-execute';

export interface RuntimeJudgeExecutionPhaseTiming {
  readonly phase: RuntimeJudgeExecutionPhase;
  readonly durationMs: number;
  readonly success: boolean;
}

export interface RuntimeJudgeExecutionTimings {
  readonly totalMs: number;
  readonly phases: readonly RuntimeJudgeExecutionPhaseTiming[];
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

function assertRuntimeJudgeBindingSupported(
  language: Language,
  binding: RuntimeJudgeBinding
): void {
  const tracing = isTraceBinding(binding);
  assertRuntimeRequestSupported(getLanguageRuntimeProfile(language), {
    request: tracing ? 'trace' : 'execute',
    executionStyle: binding.executionStyle ?? (
      language === 'csharp' || language === 'cpp'
        ? 'solution-method'
        : 'function'
    ),
    functionName: binding.functionName,
    limits: binding.limits,
    ...(tracing && binding.traceOptions
      ? { traceOptions: binding.traceOptions }
      : {}),
  });
}

function algorithmRuntimeBinding(
  execution: JudgeAlgorithmBundle['execution'],
  traceCapable: boolean
): RuntimeJudgeBinding {
  return traceCapable
    ? {
        sourcePath: execution.sourcePath,
        trace: true,
        functionName: execution.functionName,
        executionStyle: execution.executionStyle,
        traceOptions: execution.traceOptions,
        limits: execution.limits,
      }
    : {
        sourcePath: execution.sourcePath,
        functionName: execution.functionName ?? undefined,
        executionStyle: execution.executionStyle,
        limits: execution.limits,
      };
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

const PROGRAM_FAILURE_STAGES: ReadonlySet<string> = new Set<
  ExecutionDiagnosticStage
>([
  'compile',
  'runtime',
  'trace',
  'driver-compile',
  'trace-driver-compile',
  'driver-link',
]);

/**
 * A `failed` outcome is the learner's program failing at a named stage; the
 * stage is the diagnostic code. Provider failures never arrive here: they
 * reject and are reported by `providerFailure`. An outcome that arrives
 * without a valid stage (an untyped provider that broke the contract) is not
 * silently attributed to anyone: the diagnostic names the contract violation.
 */
function failureDiagnostic(
  runtime: string,
  outcome: Extract<
    CodeExecutionResult | ExecutionResult | RuntimeProgramPreparationResult,
    {
    readonly kind: 'failed';
    }
  >
): JudgeDiagnostic {
  const stage: unknown = outcome.diagnosticStage;
  if (typeof stage !== 'string' || !PROGRAM_FAILURE_STAGES.has(stage)) {
    return Object.freeze({
      severity: 'error',
      message: stage === undefined || stage === null || stage === ''
        ? `The ${runtime} runtime returned a failed outcome without a program ` +
          `stage (Harness contract violation): ${String(outcome.error ?? '')}`
        : `The ${runtime} runtime returned a failed outcome with an unknown program ` +
          `stage ${JSON.stringify(String(stage)).slice(0, 80)} (Harness protocol violation): ` +
          String(outcome.error ?? ''),
      code: PROVIDER_ERROR_CODE,
      source: runtime,
    });
  }
  return Object.freeze({
    severity: 'error',
    message: String(outcome.error ?? '').trim() || 'The program failed without an error message.',
    code: stage,
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
  const reason: unknown = outcome.reason;
  if (!isExecutionLimitReason(reason)) {
    // A limit outside the closed set is a malformed provider message, never
    // a learner limit.
    return Object.freeze({
      severity: 'error',
      message:
        `The ${runtime} runtime reported an unknown limit ` +
        `${JSON.stringify(String(reason)).slice(0, 80)} (Harness protocol violation).`,
      code: PROVIDER_ERROR_CODE,
      source: runtime,
    });
  }
  return Object.freeze({
    severity: 'error',
    message: String(outcome.error ?? '').trim() ||
      LIMIT_MESSAGES[reason] ||
      `Execution stopped by a limit (${reason}).`,
    code: reason,
    source: runtime,
  });
}

/** What a learner reads when a runtime stopped the program without a message. */
const LIMIT_MESSAGES: Readonly<Record<ExecutionLimitReason, string>> = {
  'client-timeout':
    'Execution timed out. This may indicate an infinite loop or very expensive execution.',
  'trace-limit':
    'Execution stopped: the trace step budget was exhausted before the program finished.',
  'trace-byte-limit':
    'Execution stopped: the trace size budget was exhausted before the program finished.',
  'line-limit':
    'Execution stopped: the program executed too many lines. This may indicate an infinite loop.',
  'single-line-limit':
    'Execution stopped: one line ran too many times. This may indicate an infinite loop.',
  'recursion-limit':
    'Execution stopped: maximum recursion depth exceeded.',
  'memory-limit':
    'Execution stopped: the program exceeded its memory limit.',
  'serialization-limit':
    'Execution stopped: the result was too large to return.',
};

/**
 * The typed origin published with every unsuccessful outcome. It restates the
 * diagnostic the adapter just built from a typed outcome, so consumers read
 * the origin instead of inferring it from codes or optional fields.
 */
function outcomeFailure(
  outcome: Extract<
    CodeExecutionResult | ExecutionResult | RuntimeProgramPreparationResult,
    { readonly kind: 'failed' | 'limit' }
  >,
  diagnostic: JudgeDiagnostic
): JudgeFailure {
  if (outcome.kind === 'limit') {
    if (diagnostic.code === PROVIDER_ERROR_CODE) {
      return Object.freeze({
        origin: 'provider',
        reason: 'protocol',
        message: diagnostic.message,
      });
    }
    return Object.freeze({
      origin: 'limit',
      reason: outcome.reason,
      message: diagnostic.message,
    });
  }
  if (diagnostic.code === PROVIDER_ERROR_CODE) {
    const stage: unknown = outcome.diagnosticStage;
    return Object.freeze({
      origin: 'provider',
      // A stage outside the closed set is a malformed message; no stage at
      // all is an untyped provider breaking the outcome contract.
      reason: stage === undefined || stage === null || stage === ''
        ? 'contract-violation'
        : 'protocol',
      message: diagnostic.message,
    });
  }
  return Object.freeze({
    origin: 'program',
    stage: diagnostic.code as JudgeProgramStage,
    message: diagnostic.message,
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
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
      failure: outcomeFailure(outcome, diagnostic),
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
      failure: outcomeFailure(outcome, diagnostic),
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
      failure: outcomeFailure(outcome, diagnostic),
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
            ...(invocation.recordTrace === undefined
              ? {}
              : { recordTrace: invocation.recordTrace }),
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

function runtimeBatchCases(
  invocation: JudgeRuntimeInvocationInput
): readonly {
  readonly caseId: string;
  readonly inputs: Record<string, unknown>;
  readonly recordTrace?: boolean;
}[] {
  if (!invocation.cases || invocation.cases.length === 0) {
    throw new TypeError(
      'Prepared runtime Judge batch requires at least one case.'
    );
  }
  return invocation.cases.map((testCase) => ({
    caseId: testCase.caseId,
    inputs: runtimeInputs({ ...invocation, value: testCase.value }),
    ...(testCase.recordTrace === undefined
      ? {}
      : { recordTrace: testCase.recordTrace }),
  }));
}

function batchCaseOutput(
  caseId: string,
  mapped: MappedRuntimeOutcome
): JudgeRuntimeBatchCaseOutput {
  const process = mapped.process;
  const termination = process.termination ?? Object.freeze({
    kind: 'exit' as const,
    exitCode: process.exitCode,
  });
  return Object.freeze({
    caseId,
    termination,
    stdout: process.stdout ?? '',
    stderr: process.stderr ?? '',
    diagnostics: mapped.output.diagnostics,
    timings: mapped.output.timings,
    ...(Object.prototype.hasOwnProperty.call(mapped.output, 'value')
      ? { value: mapped.output.value }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(mapped.output, 'trace')
      ? { trace: mapped.output.trace }
      : {}),
    ...(mapped.output.failure ? { failure: mapped.output.failure } : {}),
    timedOut:
      termination.kind === 'signal' ||
      mapped.output.diagnostics?.some(
        (diagnostic) => diagnostic.code === 'client-timeout'
      ) === true,
  });
}

function executePreparedProviderBatch(
  options: RuntimeJudgeProviderOptions,
  programs: RuntimePreparedProgramRegistry,
  invocation: JudgeRuntimeInvocationInput
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const cases = yield* Effect.try({
      try: () => runtimeBatchCases(invocation),
      catch: errorFromUnknown,
    });
    if (invocation.stopAtFirstRunaway === true) {
      return programs.stopsAtFirstRunaway(evaluationId(invocation))
        ? yield* executeProviderStoppingBatch(options, programs, invocation, cases)
        : yield* executeProviderBatchUntilRunaway(options, programs, invocation, cases);
    }
    const outcomes = yield* Effect.tryPromise({
      try: (signal) =>
        isTraceBinding(options.binding)
          ? programs.executeTraceBatch(evaluationId(invocation), {
              inputBatch: cases.map((testCase) => testCase.inputs),
              ...(cases.some((testCase) => testCase.recordTrace !== undefined)
                ? {
                    traceEnabledBatch: cases.map(
                      (testCase) => testCase.recordTrace ?? true
                    ),
                  }
                : {}),
              signal,
              limits: options.binding.limits,
            })
          : programs.executeCodeBatch(evaluationId(invocation), {
              inputBatch: cases.map((testCase) => testCase.inputs),
              signal,
              limits: options.binding.limits,
            }),
      catch: errorFromUnknown,
    });
    if (outcomes.length !== cases.length) {
      return yield* Effect.fail(
        new Error(
          `Prepared runtime returned ${outcomes.length} batch outcomes for ` +
          `${cases.length} cases.`
        )
      );
    }
    const batch = Object.freeze(outcomes.map((outcome, index) =>
      batchCaseOutput(
        cases[index]!.caseId,
        isTraceBinding(options.binding)
          ? mappedTraceOutcome(options.runtime, outcome as ExecutionResult)
          : mappedCodeOutcome(options.runtime, outcome as CodeExecutionResult)
      )
    ));
    return Object.freeze({
      output: Object.freeze({ batch }),
      process: Object.freeze({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
    });
  });
}

const RUNAWAY_LIMIT_REASONS: ReadonlySet<string> = new Set([
  'client-timeout',
  'line-limit',
  'single-line-limit',
]);

function notRunCaseOutput(
  caseId: string,
  stoppedBy: { readonly caseId: string; readonly limit: ExecutionLimitReason }
): JudgeRuntimeBatchCaseOutput {
  return Object.freeze({
    caseId,
    termination: Object.freeze({ kind: 'exit' as const, exitCode: 0 }),
    stdout: '',
    stderr: '',
    diagnostics: Object.freeze([]),
    timedOut: false,
    notRun: Object.freeze({
      reason: 'run-stopped-after-limit' as const,
      stoppedByCaseId: stoppedBy.caseId,
      limit: stoppedBy.limit as JudgeLimitReason,
    }),
  });
}

/**
 * Run semantics for a provider whose batch stops itself: one batch request
 * with `stopAtFirstRunaway`, returning a prefix that ends with the first case
 * a time or line limit stopped; every later case is not run. A result that is
 * not such a prefix breaks the protocol.
 */
function executeProviderStoppingBatch(
  options: RuntimeJudgeProviderOptions,
  programs: RuntimePreparedProgramRegistry,
  invocation: JudgeRuntimeInvocationInput,
  cases: ReturnType<typeof runtimeBatchCases>
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const outcomes: readonly (CodeExecutionResult | ExecutionResult)[] = yield* Effect.tryPromise({
      try: (signal) =>
        isTraceBinding(options.binding)
          ? programs.executeTraceBatch(evaluationId(invocation), {
              inputBatch: cases.map((testCase) => testCase.inputs),
              traceEnabledBatch: cases.map((testCase) => testCase.recordTrace ?? true),
              signal,
              limits: options.binding.limits,
              stopAtFirstRunaway: true,
            })
          : programs.executeCodeBatch(evaluationId(invocation), {
              inputBatch: cases.map((testCase) => testCase.inputs),
              signal,
              limits: options.binding.limits,
              stopAtFirstRunaway: true,
            }),
      catch: errorFromUnknown,
    });
    const runawayIndex = outcomes.findIndex((outcome) =>
      outcome.kind === 'limit' && RUNAWAY_LIMIT_REASONS.has(outcome.reason)
    );
    const wellFormed =
      outcomes.length > 0 &&
      outcomes.length <= cases.length &&
      (runawayIndex === -1
        ? outcomes.length === cases.length
        : runawayIndex === outcomes.length - 1);
    if (!wellFormed) {
      return yield* Effect.fail(new RuntimeProviderError(
        `Prepared runtime returned ${outcomes.length} outcomes for a stopping batch of ` +
          `${cases.length} cases that is not a prefix ending at its first runaway.`,
        { reason: 'protocol' }
      ));
    }
    const batch: JudgeRuntimeBatchCaseOutput[] = outcomes.map((outcome, index) =>
      batchCaseOutput(
        cases[index]!.caseId,
        isTraceBinding(options.binding)
          ? mappedTraceOutcome(options.runtime, outcome as ExecutionResult)
          : mappedCodeOutcome(options.runtime, outcome as CodeExecutionResult)
      )
    );
    if (runawayIndex !== -1) {
      const stopper = outcomes[runawayIndex] as Extract<CodeExecutionResult, { kind: 'limit' }>;
      const stoppedBy = { caseId: cases[runawayIndex]!.caseId, limit: stopper.reason };
      for (const testCase of cases.slice(outcomes.length)) {
        batch.push(notRunCaseOutput(testCase.caseId, stoppedBy));
      }
    }
    return Object.freeze({
      output: Object.freeze({ batch: Object.freeze(batch) }),
      process: Object.freeze({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
    });
  });
}

/**
 * Run semantics: cases run one at a time, and the first case stopped by a time
 * or line limit stops the run. Every later case is reported as not run, with
 * the case and limit that stopped it, never as a limit of its own.
 */
function executeProviderBatchUntilRunaway(
  options: RuntimeJudgeProviderOptions,
  programs: RuntimePreparedProgramRegistry,
  invocation: JudgeRuntimeInvocationInput,
  cases: ReturnType<typeof runtimeBatchCases>
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const batch: JudgeRuntimeBatchCaseOutput[] = [];
    let stoppedBy: { readonly caseId: string; readonly limit: ExecutionLimitReason } | undefined;
    for (const testCase of cases) {
      if (stoppedBy) {
        batch.push(Object.freeze({
          caseId: testCase.caseId,
          termination: Object.freeze({ kind: 'exit' as const, exitCode: 0 }),
          stdout: '',
          stderr: '',
          diagnostics: Object.freeze([]),
          timedOut: false,
          notRun: Object.freeze({
            reason: 'run-stopped-after-limit' as const,
            stoppedByCaseId: stoppedBy.caseId,
            limit: stoppedBy.limit as JudgeLimitReason,
          }),
        }));
        continue;
      }
      // Each case runs as a one-case provider batch, so it gets exactly the
      // bounds it gets in a whole batch (Python's guest guard, per-case
      // deadlines), and the provider replaces a worker that hit one.
      const outcomes: readonly (CodeExecutionResult | ExecutionResult)[] = yield* Effect.tryPromise({
        try: (signal) =>
          isTraceBinding(options.binding)
            ? programs.executeTraceBatch(evaluationId(invocation), {
                inputBatch: [testCase.inputs],
                traceEnabledBatch: [testCase.recordTrace ?? true],
                signal,
                limits: options.binding.limits,
              })
            : programs.executeCodeBatch(evaluationId(invocation), {
                inputBatch: [testCase.inputs],
                signal,
                limits: options.binding.limits,
              }),
        catch: errorFromUnknown,
      });
      const outcome = outcomes[0];
      if (outcomes.length !== 1 || !outcome) {
        return yield* Effect.fail(
          new Error(`Prepared runtime returned ${outcomes.length} batch outcomes for 1 case.`)
        );
      }
      batch.push(batchCaseOutput(
        testCase.caseId,
        isTraceBinding(options.binding)
          ? mappedTraceOutcome(options.runtime, outcome as ExecutionResult)
          : mappedCodeOutcome(options.runtime, outcome as CodeExecutionResult)
      ));
      if (outcome.kind === 'limit' && RUNAWAY_LIMIT_REASONS.has(outcome.reason)) {
        stoppedBy = { caseId: testCase.caseId, limit: outcome.reason };
      }
    }
    return Object.freeze({
      output: Object.freeze({ batch: Object.freeze(batch) }),
      process: Object.freeze({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
    });
  });
}

/** A broken result protocol is reported as such; anything else as the provider failing. */
function providerFailureReason(error: unknown): 'runtime-failure' | 'protocol' {
  return error instanceof Error &&
    error.name === 'RuntimeProviderError' &&
    (error as { reason?: unknown }).reason === 'protocol'
    ? 'protocol'
    : 'runtime-failure';
}

function providerFailure(
  runtime: string,
  message: string,
  code = PROVIDER_ERROR_CODE,
  reason: 'runtime-failure' | 'protocol' = 'runtime-failure'
): MappedRuntimeOutcome {
  return Object.freeze({
    output: Object.freeze({
      diagnostics: Object.freeze([Object.freeze({
        severity: 'error' as const,
        message,
        code,
        source: runtime,
      })]),
      failure: Object.freeze({
        origin: 'provider' as const,
        reason,
        message,
      }),
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
  context: TraceKernelRuntimeProcessContext,
  initialize: Effect.Effect<void, Error>
): Effect.Effect<TraceKernelRuntimeResult, Error> {
  const invocationId = context.env[JUDGE_INVOCATION_ID_ENV];
  if (!invocationId) {
    return Effect.fail(
      new Error(
        `Prepared runtime Judge process is missing ${JUDGE_INVOCATION_ID_ENV}.`
      )
    );
  }
  // Runtime initialization (asset, toolchain, and worker load) belongs to the
  // provider. Its failure is published as a provider diagnostic on the process
  // that needed the runtime, never as a process that silently failed to start
  // (which a consumer would read as the learner's compile failure).
  return initialize.pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const mapped = providerFailure(
          options.runtime,
          error.message,
          PROVIDER_ERROR_CODE,
          providerFailureReason(error)
        );
        return options.runtimeControl.publish(
          invocationId,
          mapped.output
        ).pipe(Effect.as(mapped.process));
      },
      onSuccess: () =>
        executeInitializedProviderProcess(
          options,
          programs,
          context,
          invocationId
        ),
    })
  );
}

function executeInitializedProviderProcess(
  options: RuntimeJudgeProviderOptions,
  programs: RuntimePreparedProgramRegistry,
  context: TraceKernelRuntimeProcessContext,
  invocationId: string
): Effect.Effect<TraceKernelRuntimeResult, Error> {
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
                error.message,
                PROVIDER_ERROR_CODE,
                providerFailureReason(error)
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
      if (invocation.phase === 'batch') {
        return executePreparedProviderBatch(
          options,
          programs,
          invocation
        ).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const mapped = providerFailure(
          options.runtime,
          error.message,
          PROVIDER_ERROR_CODE,
          providerFailureReason(error)
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
            const mapped = providerFailure(
          options.runtime,
          error.message,
          PROVIDER_ERROR_CODE,
          providerFailureReason(error)
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
  // Successful initialization is memoized; a failed one is retried by the
  // next process so a repaired deployment recovers without a new host.
  let initialized: Promise<void> | undefined;
  const ensureInitialized = Effect.tryPromise({
    try: () => {
      initialized ??= providerOptions.provider.init().then((result) => {
        if (!result.success) {
          throw new Error(
            `Prepared runtime provider ${JSON.stringify(providerOptions.runtime)} ` +
            'reported unsuccessful initialization.'
          );
        }
      });
      const attempt = initialized;
      attempt.catch(() => {
        if (initialized === attempt) initialized = undefined;
      });
      return attempt;
    },
    catch: errorFromUnknown,
  });
  const runtimeProvider: TraceKernelRuntimeProvider = Object.freeze({
    runtime: providerOptions.runtime,
    initialize: Effect.succeed({
      acquire: (
        context: TraceKernelRuntimeProcessContext
      ) => Effect.succeed({
        id: `${providerOptions.runtime}-judge-${nextLeaseId++}`,
        runtime: providerOptions.runtime,
        execute: () =>
          executeProviderProcess(
            providerOptions,
            programs,
            context,
            ensureInitialized
          ),
        release: () => Effect.void,
      }),
    }),
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
  plan: JudgeEvaluationPlan<Input, Expected>,
  useProviderBatch: boolean
): JudgeEvaluationPlan<Input, Expected> {
  const batched = useProviderBatch && plan.cases.length > 1;
  const timeoutMs = preparedRunTimeoutMs(
    plan.run.timeoutMs,
    plan.cases.length,
    batched
  );
  return Object.freeze({
    ...plan,
    ...(plan.compile
      ? {}
      : {
          compile: Object.freeze({
            command: INTERNAL_PREPARE_COMMAND,
          }),
        }),
    run: Object.freeze({
      ...plan.run,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    ...(batched
      ? {
          isolation: Object.freeze({
            mode: 'provider-isolated-batch' as const,
            maxConcurrency: 1,
          }),
        }
      : {}),
  });
}

/**
 * The Judge watchdog is a backstop behind the provider's own per-case limit,
 * which reports the reason and the line. Without grace the two race at the
 * same instant and the watchdog can win, losing that information (and, in a
 * Run, which cases never started).
 */
const BATCH_RECOVERY_ALLOWANCE_MS = 10_000;

function watchdogGraceMs(perCaseTimeoutMs: number): number {
  return Math.min(5_000, Math.floor(perCaseTimeoutMs / 2));
}

function preparedRunTimeoutMs(
  perCaseTimeoutMs: number | undefined,
  caseCount: number,
  batched: boolean
): number | undefined {
  if (perCaseTimeoutMs === undefined) return undefined;
  if (!batched) return perCaseTimeoutMs + watchdogGraceMs(perCaseTimeoutMs);
  // A batch process also pays per-case runtime recovery (a replacement worker
  // or VM after a case that hit its limit) outside the provider's per-case
  // clock, so its backstop grants a fixed recovery allowance per case.
  return Math.min(
    2_147_483_647,
    (perCaseTimeoutMs + BATCH_RECOVERY_ALLOWANCE_MS) * caseCount
  );
}

function traceTranchePlan<Input, Expected>(
  plan: JudgeEvaluationPlan<Input, Expected>,
  caseIds: readonly string[],
  perCaseTimeoutMs: number | undefined
): JudgeEvaluationPlan<Input, Expected> {
  const casesById = new Map(
    plan.cases.map((testCase) => [testCase.id, testCase])
  );
  return Object.freeze({
    ...plan,
    run: Object.freeze({
      ...plan.run,
      ...(perCaseTimeoutMs === undefined
        ? {}
        : {
            timeoutMs: preparedRunTimeoutMs(
              perCaseTimeoutMs,
              caseIds.length,
              caseIds.length > 1
            ),
          }),
    }),
    cases: Object.freeze(caseIds.map((caseId) => casesById.get(caseId)!)),
  });
}

/**
 * Public runtime-judge facade for 0.14.
 *
 * This is the stable root surface for Judge-backed execution. It keeps the
 * Judge -> TraceKernel -> prepared runtime provider boundary public while the
 * lower-level engine packages remain internal implementation details.
 */
export interface RuntimeJudgeAlgorithmOptions {
  /**
   * Stop at the first case a time or line limit stopped and report the
   * remaining cases as `not-run`, as Run does. Default off: every case runs
   * under its own bound.
   */
  readonly stopAtFirstRunaway?: boolean;
}

export interface RuntimeJudge {
  readonly runtime: string;
  readonly runtimeControl: JudgeRuntimeControlPort;
  activeSessionIds(): readonly string[];

  execute<
    Input = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    request: RuntimeJudgeExecuteRequest<Input, Expected, Result>
  ): Effect.Effect<
    RuntimeJudgeExecuteResult<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  >;

  /** Idempotently closes a retained interactive execution. */
  disposeExecution(
    executionId: string
  ): Effect.Effect<void, JudgeInfrastructureError>;

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

  evaluateAlgorithm<
    Input extends Record<string, unknown> = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    bundle: JudgeAlgorithmBundle<Input, Expected, Result>,
    options?: RuntimeJudgeAlgorithmOptions
  ): Effect.Effect<
    JudgeAlgorithmReceipt<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  >;
}

export interface RuntimeJudgeTraceSelection {
  readonly caseIds: readonly string[];
}

export interface RuntimeJudgeInitialExecuteRequest<
  Input = Record<string, unknown>,
  Expected = unknown,
  Result = unknown,
> {
  readonly plan: JudgeEvaluationPlan<Input, Expected>;
  /** Omit for an ephemeral execution that is disposed before returning. */
  readonly interactive?: boolean;
  /** Omit for no recorded cases. */
  readonly tracing?: RuntimeJudgeTraceSelection;
  readonly comparator?: JudgeComparator<Input, Expected, Result>;
  /**
   * Stop at the first case a time or line limit stopped and report the
   * remaining cases as `not-run`, as Run does. Default off: every case runs
   * under its own bound. Interactive executions always stop.
   */
  readonly stopAtFirstRunaway?: boolean;
}

export interface RuntimeJudgeContinueExecuteRequest {
  readonly executionId: string;
  /** Continuations are explicit trace tranches over retained case ids. */
  readonly tracing: RuntimeJudgeTraceSelection;
}

export type RuntimeJudgeExecuteRequest<
  Input = Record<string, unknown>,
  Expected = unknown,
  Result = unknown,
> =
  | RuntimeJudgeInitialExecuteRequest<Input, Expected, Result>
  | RuntimeJudgeContinueExecuteRequest;

export interface RuntimeJudgeExecuteResult<Result = unknown, Expected = unknown> {
  readonly executionId?: string;
  readonly evaluation: JudgeEvaluationResult<Result, Expected>;
  /** Wall-clock lifecycle phases measured by the browser Judge authority. */
  readonly timings?: RuntimeJudgeExecutionTimings;
}

interface RetainedJudgeExecution {
  readonly executionId: string;
  readonly evaluationId: string;
  readonly plan: JudgeEvaluationPlan;
  readonly perCaseTimeoutMs: number | undefined;
  readonly build: JudgePreparedWorkspace<TraceKernelFileSystemImage>;
  readonly port: TraceKernelJudgePort;
  readonly comparator?: JudgeComparator<unknown, unknown, unknown>;
}

class RuntimeJudgeComposition
  implements RuntimeJudge {
  private nextEvaluationId = 1;
  private readonly executions = new Map<string, RetainedJudgeExecution>();

  constructor(
    readonly runtime: string,
    readonly runtimeControl: JudgeRuntimeControlPort,
    private readonly host: TraceKernelHost,
    private readonly bridge: RuntimeJudgeProviderBridge,
    private readonly traceCapable: boolean,
    private readonly sourcePath: string
  ) {}

  activeSessionIds(): readonly string[] {
    return this.host.sessionIds();
  }

  execute<
    Input = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    request: RuntimeJudgeExecuteRequest<Input, Expected, Result>
  ): Effect.Effect<
    RuntimeJudgeExecuteResult<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  > {
    return 'executionId' in request
      ? this.continueExecution<Input, Result, Expected>(request)
      : this.startExecution(request);
  }

  disposeExecution(
    executionId: string
  ): Effect.Effect<void, JudgeInfrastructureError> {
    return Effect.suspend(() => {
      const retained = this.executions.get(executionId);
      if (!retained) return Effect.void;
      this.executions.delete(executionId);
      return this.disposeEvaluation(retained.evaluationId);
    });
  }

  disposeRetainedExecutions(): Effect.Effect<void> {
    return Effect.forEach(
      [...this.executions.keys()],
      (executionId) => this.disposeExecution(executionId).pipe(
        Effect.catchAll(() => Effect.void)
      ),
      { concurrency: 1, discard: true }
    );
  }

  private startExecution<
    Input,
    Result,
    Expected,
  >(
    request: RuntimeJudgeInitialExecuteRequest<Input, Expected, Result>
  ): Effect.Effect<
    RuntimeJudgeExecuteResult<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  > {
    if (
      !this.traceCapable &&
      (request.interactive === true || request.tracing !== undefined)
    ) {
      return Effect.fail(new JudgePlanError({
        message:
          'Interactive or traced execute requires a trace-capable Judge binding.',
      }));
    }
    return Effect.suspend(() => {
      const evaluationId = this.nextOpaqueExecutionId('evaluation');
      const executionId = this.nextOpaqueExecutionId('execution');
      this.bridge.beginEvaluation(evaluationId);
      const port = new TraceKernelJudgePort({
        host: this.host,
        runtimeControl: new EvaluationJudgeRuntimeControl(
          this.runtimeControl,
          evaluationId
        ),
        readableFiles: [this.sourcePath],
      });
      const plan = preparedEvaluationPlan(request.plan, true);
      let retained = false;
      const operation = Effect.gen(this, function* () {
        yield* validateTraceSelection(plan, request.tracing);
        const build = yield* prepareJudgePlan(port, plan);
        const evaluation = yield* evaluatePreparedJudgePlan<
          TraceKernelFileSystemImage,
          Input,
          Result,
          Expected
        >(port, plan, build, {
          comparator: request.comparator,
          // Run semantics: an interactive execution stops at the first case a
          // time or line limit stopped; the rest are reported as not run. A
          // batch evaluation opts in.
          ...(request.interactive === true || request.stopAtFirstRunaway === true
            ? { stopAtFirstRunaway: true }
            : {}),
          ...(this.traceCapable
            ? {
                tracing: request.tracing ?? { caseIds: Object.freeze([]) },
              }
            : {}),
        });
        if (
          request.interactive === true &&
          evaluation.status === 'completed'
        ) {
          this.executions.set(executionId, {
            executionId,
            evaluationId,
            plan: plan as JudgeEvaluationPlan,
            perCaseTimeoutMs: request.plan.run.timeoutMs,
            build,
            port,
            comparator: request.comparator as
              | JudgeComparator<unknown, unknown, unknown>
              | undefined,
          });
          retained = true;
        }
        return Object.freeze({
          ...(retained ? { executionId } : {}),
          evaluation,
        });
      });
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(this, function* () {
          const executionExit = yield* Effect.exit(restore(operation));
          if (!retained) {
            const disposeExit = yield* Effect.exit(
              this.disposeEvaluation(evaluationId)
            );
            if (Exit.isFailure(disposeExit)) {
              return yield* Effect.failCause(disposeExit.cause);
            }
          }
          if (Exit.isFailure(executionExit)) {
            return yield* Effect.failCause(executionExit.cause);
          }
          return executionExit.value;
        })
      );
    });
  }

  private continueExecution<Input, Result, Expected>(
    request: RuntimeJudgeContinueExecuteRequest
  ): Effect.Effect<
    RuntimeJudgeExecuteResult<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  > {
    return Effect.suspend(() => {
      const retained = this.executions.get(request.executionId);
      if (!retained) {
        return Effect.fail(new JudgePlanError({
          message:
            `Unknown or disposed interactive execution ${JSON.stringify(request.executionId)}.`,
        }));
      }
      const selected = new Set<string>();
      const casesById = new Map(
        retained.plan.cases.map((testCase) => [testCase.id, testCase])
      );
      for (const caseId of request.tracing.caseIds) {
        if (selected.has(caseId)) {
          return Effect.fail(new JudgePlanError({
            message:
              `Interactive tracing contains duplicate case id ${JSON.stringify(caseId)}.`,
          }));
        }
        if (!casesById.has(caseId)) {
          return Effect.fail(new JudgePlanError({
            message:
              `Interactive tracing references unknown case id ${JSON.stringify(caseId)}.`,
          }));
        }
        selected.add(caseId);
      }
      if (selected.size === 0) {
        return Effect.fail(new JudgePlanError({
          message: 'Interactive tracing requires at least one retained case id.',
        }));
      }
      const plan = traceTranchePlan(
        retained.plan as JudgeEvaluationPlan<Input, Expected>,
        request.tracing.caseIds,
        retained.perCaseTimeoutMs
      );
      return evaluatePreparedJudgePlan<
        TraceKernelFileSystemImage,
        Input,
        Result,
        Expected
      >(
        retained.port,
        plan,
        retained.build,
        {
          comparator: retained.comparator as
            | JudgeComparator<Input, Expected, Result>
            | undefined,
          tracing: request.tracing,
        }
      ).pipe(
        Effect.map((evaluation) => Object.freeze({
          executionId: retained.executionId,
          evaluation,
        }))
      );
    });
  }

  private disposeEvaluation(
    evaluationId: string
  ): Effect.Effect<void, JudgeInfrastructureError> {
    return this.bridge.disposeEvaluation(evaluationId).pipe(
      Effect.mapError((error) => new JudgeInfrastructureError({
        operation: 'dispose interactive prepared runtime program',
        message: error.message,
        cause: error,
      }))
    );
  }

  private nextOpaqueExecutionId(kind: 'evaluation' | 'execution'): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid
      ? `${this.runtime}-${kind}-${uuid}`
      : `${this.runtime}-${kind}-${this.nextEvaluationId++}`;
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
    return this.evaluatePlan(plan, options, false);
  }

  private evaluatePlan<
    Input = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    plan: JudgeEvaluationPlan<Input, Expected>,
    options: JudgeEvaluationOptions<Input, Expected, Result>,
    useProviderBatch: boolean
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
        readableFiles: [this.sourcePath],
      });
      const effectivePlan = preparedEvaluationPlan(
        plan,
        useProviderBatch
      );
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

  evaluateAlgorithm<
    Input extends Record<string, unknown> = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    bundle: JudgeAlgorithmBundle<Input, Expected, Result>,
    options: RuntimeJudgeAlgorithmOptions = {}
  ): Effect.Effect<
    JudgeAlgorithmReceipt<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  > {
    return validateAlgorithmJudgeBundle(bundle).pipe(
      Effect.flatMap(() =>
        this.evaluatePlan<Input, Result, Expected>(
          bundle.plan,
          {
            comparator: bundle.comparison
              ? createJudgeComparator<Input>(bundle.comparison)
              : undefined,
            ...(options.stopAtFirstRunaway === true
              ? { stopAtFirstRunaway: true }
              : {}),
          },
          true
        )
      ),
      Effect.map((evaluation) =>
        createAlgorithmJudgeReceipt(bundle, evaluation)
      )
    );
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
    Effect.flatMap((host) => {
      const judge = new RuntimeJudgeComposition(
        options.runtime,
        runtimeControl,
        host,
        bridge,
        isTraceBinding(options.binding),
        options.binding.sourcePath
      );
      return Effect.addFinalizer(() =>
        judge.disposeRetainedExecutions()
      ).pipe(Effect.as(judge));
    })
  );
}

export function createBrowserRuntimeJudge(
  options: CreateBrowserRuntimeJudgeOptions
): Effect.Effect<
  RuntimeJudge,
  never,
  Scope.Scope
> {
  // This is the last shared boundary that sees both the selected runtime
  // profile and every requested execution/tracing control. Validate before
  // acquiring or preparing a provider so unsupported controls cannot vanish.
  assertRuntimeJudgeBindingSupported(options.language, options.binding);
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

/**
 * Creates the single public browser authority for judged execution.
 *
 * Provider registration and prepared-runtime access remain private. The
 * returned host can be warmed and reused across scoped Judge evaluations, then
 * disposed once by its owning application.
 */
export function createBrowserJudgeHost(
  options: CreateBrowserJudgeHostOptions = {}
): BrowserJudgeHost {
  const interactiveExecutionIdleTimeoutMs =
    resolveInteractiveExecutionIdleTimeoutMs(
      options.interactiveExecutionIdleTimeoutMs
    );
  const host = createBrowserRuntimeHost(options);
  return createBrowserJudgeHostFromRuntimeHost(host, {
    interactiveExecutionIdleTimeoutMs,
    project: options.project,
  });
}

interface RetainedBrowserJudgeExecution {
  readonly judge: RuntimeJudge;
  readonly scope: Scope.CloseableScope;
  activeContinuations: number;
  idleTimer?: ReturnType<typeof globalThis.setTimeout>;
}

function judgeTimingNow(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

async function measureJudgeExecutionPhase<Result>(
  phases: RuntimeJudgeExecutionPhaseTiming[],
  phase: RuntimeJudgeExecutionPhase,
  operation: () => Promise<Result>
): Promise<Result> {
  const startedAt = judgeTimingNow();
  let success = false;
  try {
    const result = await operation();
    success = true;
    return result;
  } finally {
    phases.push(Object.freeze({
      phase,
      durationMs: Math.max(0, judgeTimingNow() - startedAt),
      success,
    }));
  }
}

function withJudgeExecutionTimings<Result, Expected>(
  result: RuntimeJudgeExecuteResult<Result, Expected>,
  startedAt: number,
  phases: readonly RuntimeJudgeExecutionPhaseTiming[]
): RuntimeJudgeExecuteResult<Result, Expected> {
  return Object.freeze({
    ...result,
    timings: Object.freeze({
      totalMs: Math.max(0, judgeTimingNow() - startedAt),
      phases: Object.freeze([...phases]),
    }),
  });
}

/** @internal Browser-host seam used by lifecycle conformance tests. */
export function createBrowserJudgeHostFromRuntimeHost(
  host: BrowserRuntimeHost,
  options: Pick<
    CreateBrowserJudgeHostOptions,
    'interactiveExecutionIdleTimeoutMs' | 'project'
  > = {}
): BrowserJudgeHost {
  const interactiveExecutionIdleTimeoutMs =
    resolveInteractiveExecutionIdleTimeoutMs(
      options.interactiveExecutionIdleTimeoutMs
    );
  const retainedExecutions = new Map<string, RetainedBrowserJudgeExecution>();

  const clearIdleTimer = (retained: RetainedBrowserJudgeExecution): void => {
    if (retained.idleTimer === undefined) return;
    globalThis.clearTimeout(retained.idleTimer);
    retained.idleTimer = undefined;
  };

  const armIdleTimer = (
    executionId: string,
    retained: RetainedBrowserJudgeExecution
  ): void => {
    clearIdleTimer(retained);
    if (
      retained.activeContinuations > 0 ||
      retainedExecutions.get(executionId) !== retained
    ) {
      return;
    }
    const timer = globalThis.setTimeout(() => {
      retained.idleTimer = undefined;
      if (
        retained.activeContinuations > 0 ||
        retainedExecutions.get(executionId) !== retained
      ) {
        return;
      }
      void disposeExecution(executionId).catch(() => undefined);
    }, interactiveExecutionIdleTimeoutMs);
    retained.idleTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  async function disposeExecution(executionId: string): Promise<void> {
    const retained = retainedExecutions.get(executionId);
    if (!retained) return;
    retainedExecutions.delete(executionId);
    clearIdleTimer(retained);
    try {
      await Effect.runPromise(retained.judge.disposeExecution(executionId));
    } finally {
      await Effect.runPromise(Scope.close(retained.scope, Exit.void));
    }
  }

  const execute = async <
    Input extends Record<string, unknown> = Record<string, unknown>,
    Result = unknown,
    Expected = unknown,
  >(
    request: BrowserJudgeExecuteRequest<Input, Expected, Result>
  ): Promise<RuntimeJudgeExecuteResult<Result, Expected>> => {
    const requestStartedAt = judgeTimingNow();
    const phases: RuntimeJudgeExecutionPhaseTiming[] = [];
    if ('executionId' in request) {
      const retained = retainedExecutions.get(request.executionId);
      if (!retained) {
        throw new JudgePlanError({
          message:
            `Unknown or disposed interactive execution ${JSON.stringify(request.executionId)}.`,
        });
      }
      clearIdleTimer(retained);
      retained.activeContinuations += 1;
      let result: RuntimeJudgeExecuteResult<Result, Expected>;
      try {
        result = await measureJudgeExecutionPhase(
          phases,
          'trace-continuation-execute',
          () => runAbortable(
            retained.judge.execute<Input, Result, Expected>({
              executionId: request.executionId,
              tracing: request.tracing,
            }),
            request.signal
          )
        );
      } finally {
        retained.activeContinuations -= 1;
        armIdleTimer(request.executionId, retained);
      }
      return withJudgeExecutionTimings(result, requestStartedAt, phases);
    }

    const { bundle } = request;
    await measureJudgeExecutionPhase(
      phases,
      'bundle-validation',
      () => Effect.runPromise(validateAlgorithmJudgeBundle(bundle))
    );
    const language = bundle.plan.runtime as Language;
    if (!host.isLanguageSupported(language)) {
      throw new Error(
        `Judge runtime ${JSON.stringify(bundle.plan.runtime)} is not supported by this browser authority.`
      );
    }
    const execution = bundle.execution;
    const comparator = bundle.comparison
      ? createJudgeComparator<Input>(bundle.comparison)
      : undefined;

    const traceCapable =
      request.interactive === true || request.tracing !== undefined;
    const binding = algorithmRuntimeBinding(execution, traceCapable);
    const scope = Effect.runSync(Scope.make());
    let judge: RuntimeJudge | undefined;
    try {
      judge = await measureJudgeExecutionPhase(
        phases,
        'judge-create',
        () => Effect.runPromise(
          Scope.extend(
            createBrowserRuntimeJudge({ host, language, binding }),
            scope
          )
        )
      );
      const result = await measureJudgeExecutionPhase(
        phases,
        'initial-execute',
        () => runAbortable(
          judge!.execute<Input, Result, Expected>({
            plan: bundle.plan,
            interactive: request.interactive,
            tracing: request.tracing,
            comparator,
            ...(request.stopAtFirstRunaway === true
              ? { stopAtFirstRunaway: true }
              : {}),
          }),
          request.signal
        )
      );
      if (result.executionId) {
        const retained: RetainedBrowserJudgeExecution = {
          judge,
          scope,
          activeContinuations: 0,
        };
        retainedExecutions.set(result.executionId, retained);
        armIdleTimer(result.executionId, retained);
      } else {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
      return withJudgeExecutionTimings(result, requestStartedAt, phases);
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.fail(error))).catch(
        () => undefined
      );
      throw error;
    }
  };

  return Object.freeze({
    assets: host.assets,
    environment: host.environment,
    supportedLanguages: host.supportedLanguages,
    isLanguageSupported: host.isLanguageSupported.bind(host),
    preflightLanguage: host.preflightLanguage.bind(host),
    preflight: host.preflight.bind(host),
    prewarmLanguage: host.prewarmLanguage.bind(host),
    warmLanguage: host.warmLanguage.bind(host),
    disposeLanguage: host.disposeLanguage.bind(host),
    createJudge: (judgeOptions: CreateBrowserJudgeOptions) =>
      createBrowserRuntimeJudge({
        host,
        ...judgeOptions,
      }),
    execute,
    disposeExecution,
    evaluateAlgorithm: <
      Input extends Record<string, unknown> = Record<string, unknown>,
      Result = unknown,
      Expected = unknown,
    >(
      judgeOptions: {
        readonly bundle: JudgeAlgorithmBundle<Input, Expected, Result>;
        readonly signal?: AbortSignal;
        readonly stopAtFirstRunaway?: boolean;
      }
    ) => {
      const { bundle, signal, stopAtFirstRunaway } = judgeOptions;
      const tracing = bundle.execution.trace === true
        ? {
            caseIds: Object.freeze(
              bundle.plan.cases.map((testCase) => testCase.id)
            ),
          }
        : undefined;
      return execute({
        bundle,
        ...(tracing ? { tracing } : {}),
        ...(signal ? { signal } : {}),
        ...(stopAtFirstRunaway === true ? { stopAtFirstRunaway: true } : {}),
      }).then(({ evaluation }) =>
        createAlgorithmJudgeReceipt(bundle, evaluation)
      );
    },
    createProjectJudge: (projectOptions = {}) =>
      createBrowserProjectJudge({
        ...projectOptions,
        workspace: options.project,
      }),
    dispose: () => {
      for (const executionId of [...retainedExecutions.keys()]) {
        void disposeExecution(executionId).catch(() => undefined);
      }
      host.dispose();
    },
  });
}

function resolveInteractiveExecutionIdleTimeoutMs(
  configured: number | undefined
): number {
  const timeoutMs =
    configured ?? DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      'interactiveExecutionIdleTimeoutMs must be a positive integer no greater than 2147483647.'
    );
  }
  return timeoutMs;
}

export {
  createBrowserProjectJudge,
};
export type {
  BrowserProjectJudge,
  BrowserProjectJudgeWorkspaceOptions,
  CreateBrowserProjectJudgeOptions,
};
