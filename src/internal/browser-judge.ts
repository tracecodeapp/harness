import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import type {
  CodeExecutionResult,
  ExecutionDiagnosticStage,
  ExecutionLimitReason,
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
import {
  isExecutionLimitReason,
  RuntimeProviderError,
} from '../../packages/runtime-contracts/src/execution-outcome';
import {
  InterruptedCodeBatchError,
  interruptedCodeBatchMessage,
} from '../../packages/runtime-browser/src/worker-errors';
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
  getBrowserRuntimeHostJudgeReceiptProvider,
  getBrowserRuntimeHostPreparedProvider,
  type JudgeReceiptProvider,
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
  type TraceKernelHost,
  type TraceKernelRuntimeProcessContext,
  type TraceKernelRuntimeProvider,
  type TraceKernelRuntimeResult,
} from '@tracecode/tracekernel';
import {
  ALGORITHM_BUNDLE_SCHEMA,
  algorithmWorkspaceDigest,
  allCasesPassPolicy,
  createJudgeComparator,
  evaluateJudgePlan,
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
  type JudgeAlgorithmBundle,
  type JudgeAlgorithmReceipt,
  JudgeInfrastructureError,
  JudgePlanError,
  type JudgeRuntimeCaseProgress,
  type JudgeRuntimeControlPort,
  type JudgeRuntimeProgressDisposition,
  type JudgeRuntimeInvocationInput,
  type JudgeRuntimeInvocationOutput,
  type JudgeRuntimeBatchCaseOutput,
  type JudgeRuntimeTimings,
  validateAlgorithmJudgeBundle,
  validateJudgePlan,
} from '../../packages/judge/src/index';
import {
  JUDGE_INVOCATION_ID_ENV,
  TraceKernelJudgePort,
} from '../../packages/judge/src/tracekernel';
import { validateTraceContinuation, validateTraceSelection } from '../../packages/judge/src/internal/trace-selection';
import {
  JudgeObservationSchedule,
  RuntimePreparedProgramRegistry,
  judgeAbortError,
  type OrdinaryBatchProgress,
} from './judge-prepared-program';
import {
  judgedOutputPolicyForPrepare,
  readJudgeTestBridge,
  type JudgeTestBridge,
} from './judge-test-bridge';
import type {
  JudgedOutputPolicy,
  JudgedPreparationCall,
} from '../../packages/runtime-contracts/src/judged-output-policy';
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

interface OwnedRuntimeDispatch {
  readonly binding: RuntimeJudgeCodeBinding;
  readonly acknowledgeStoppingBatchStarts: boolean;
  readonly acknowledgeNonStoppingBatchStarts: boolean;
  readonly overlapObservationWithInitialization?: true;
  recordPrepare(call: RuntimeProgramPreparationCall): void;
  admit(caseId: string): void;
  /** The evaluation's case-progress journal. */
  readonly journal: EvaluationProgressJournal;
}

/** The schedule's journal markers and its trusted service-deadline control. */
type JournalMarks = Pick<
  JudgeObservationSchedule<unknown, unknown>,
  'beginDispatch' | 'journalled' | 'journalRejected' | 'serviceDeadlineInjected' | 'serviceDeadline'
>;

/** Every ordinary batch dispatch of one evaluation, by invocation. */
class EvaluationProgressJournal {
  private readonly batches = new Map<string, BatchProgressJournal>();

  constructor(readonly marks: JournalMarks) {}

  open(
    control: JudgeRuntimeControlPort,
    invocationId: string,
    cases: readonly { readonly caseId: string }[],
    runtime: string
  ): BatchProgressJournal {
    const journal = new BatchProgressJournal(this.marks, control, invocationId, cases, runtime);
    this.batches.set(invocationId, journal);
    return journal;
  }

  /** The dispatch publishes its own result for this invocation. */
  publishing(invocationId: string): void {
    this.batches.get(invocationId)?.publishing();
  }

  /**
   * The batch process ended and the control port gave back its output. A
   * batch that never published was stopped by the service watchdog: in a
   * Judge evaluation the dispatch always publishes unless the watchdog
   * killed its process (a caller abort never reaches `take`).
   */
  taken(invocationId: string): void {
    const journal = this.batches.get(invocationId);
    this.batches.delete(invocationId);
    journal?.processEnded();
  }
}

/** Raised inside a dispatch when the injected service deadline wins. */
const SERVICE_DEADLINE = Symbol('service-deadline');

const SERVICE_DEADLINE_MESSAGE =
  'The runtime did not finish within its own deadline, so the Judge stopped it.';

/** The grade-bearing fields of two ordinary outcomes agree (timings aside). */
function sameOrdinaryOutcome(a: CodeExecutionResult, b: CodeExecutionResult): boolean {
  const fields = (outcome: CodeExecutionResult) => {
    const { timings: _timings, executionTimeMs: _elapsed, ...rest } = outcome as CodeExecutionResult & {
      readonly executionTimeMs?: unknown;
    };
    return rest;
  };
  return sameData(fields(a), fields(b));
}

/** Structural equality for plain data, keeping absent apart from undefined. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) &&
    sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * The coordinator's journal of one ordinary batch dispatch: it records each
 * start and finish a provider attests on the control port, emits the
 * journal markers, and expires the service watchdog when the trusted test
 * control asks. An accepted finish is durable: whatever ends the batch,
 * Judge publishes it unchanged, and it stands against a different terminal
 * reply. Once the batch is stopped (the injected deadline, the watchdog's
 * kill, a caller abort) or publishes, the journal is sealed.
 */
class BatchProgressJournal implements OrdinaryBatchProgress {
  readonly generation: number;
  /** Accepted finishes, as the provider streamed them. */
  private readonly accepted = new Map<number, CodeExecutionResult>();
  private readonly startedEntries = new Set<number>();
  private readonly expiry = new AbortController();
  private published = false;
  /** No further progress is accepted. */
  private sealed = false;
  /**
   * The case running when the journal was sealed: the last journalled start,
   * when its finish was not journalled. (In an in-order batch a later start
   * shows that every earlier case had finished.) A grace-prefix entry for it
   * may have been built from the abort itself, so it is never kept.
   */
  private runningAtSeal: number | undefined;
  /** `service-deadline` has been marked for this dispatch. */
  private deadlineMarked = false;
  /** Every entry's start is journalled (worker ACKs, or the coordinator sends each case). */
  private startsAcknowledged = false;
  private portFailed = false;
  /** Index translation for a dispatch that sends one entry at a time. */
  private offset = 0;

  constructor(
    private readonly marks: JournalMarks,
    private readonly control: JudgeRuntimeControlPort,
    private readonly invocationId: string,
    private readonly cases: readonly { readonly caseId: string }[],
    private readonly runtime: string
  ) {
    this.generation = marks.beginDispatch();
  }

  /**
   * Whether this dispatch keeps a journal: the control port records, and
   * records synchronously (the journal must be current before the
   * provider's next message). Otherwise the provider's own interrupted
   * prefix is published as before.
   */
  get recording(): boolean {
    return typeof this.control.record === 'function' && !this.portFailed;
  }

  get acceptedCount(): number {
    return this.accepted.size;
  }

  get expiredAlready(): boolean {
    return this.expiry.signal.aborted;
  }

  acknowledgesStarts(): void {
    this.startsAcknowledged = true;
  }

  /** The progress callbacks for a one-entry call that runs case `index`. */
  forEntry(index: number): OrdinaryBatchProgress {
    const local = (entry: number, run: () => void, progress: 'started' | 'finished') =>
      entry === 0
        ? this.withOffset(index, run)
        : this.marks.journalRejected(progress, undefined, index + entry, this.generation, 'unknown-case');
    return {
      acknowledgesStarts: () => this.acknowledgesStarts(),
      started: (entry) => local(entry, () => this.started(0), 'started'),
      finished: (entry, result) => local(entry, () => this.finished(0, result), 'finished'),
      fenced: (progress, entry) => local(entry, () => this.fenced(progress, 0), progress),
    };
  }

  started(index: number): void {
    this.record('started', index);
  }

  finished(index: number, result: CodeExecutionResult): void {
    this.record('finished', index, result);
  }

  /** Progress that arrived once its batch call was stopped or settled. */
  fenced(progress: 'started' | 'finished', localIndex: number): void {
    const index = localIndex + this.offset;
    this.marks.journalRejected(progress, this.cases[index]?.caseId, index, this.generation,
      this.cases[index] ? 'fenced' : 'unknown-case');
  }

  hasFinished(index: number): boolean {
    return this.accepted.has(index);
  }

  /** The batch call was stopped: take no further progress. */
  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    const lastStart = Math.max(-1, ...this.startedEntries);
    this.runningAtSeal = lastStart >= 0 && !this.accepted.has(lastStart) ? lastStart : undefined;
  }

  /** Resolves when the trusted control expires the service watchdog. */
  expiredPromise(): Promise<void> {
    return new Promise((resolve) => {
      if (this.expiry.signal.aborted) resolve();
      else this.expiry.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /**
   * Bring a provider's interrupted prefix into the journal before
   * publishing. A prefix entry is the provider's authenticated finish.
   * - Before any stop (a worker loss), it also evidences its own start.
   * - After a watchdog stop (the injected deadline or the real kill), the
   *   one keep rule applies: the entry stands only if, where this dispatch
   *   records starts, the journal recorded that case's start, and the case
   *   was not the one running at the stop (the last journalled start
   *   without a journalled finish, or the entry the provider names as
   *   interrupted). A provider can build the running case's entry from the
   *   abort itself, so that case keeps only a finish journalled before the
   *   seal. Any other entry is fenced. The dispatch calls this only within
   *   its grace.
   * An entry for a case already accepted never replaces it.
   */
  reconcile(error: InterruptedCodeBatchError, offset = 0): void {
    this.withOffset(offset, () => {
      error.prefix.forEach((result, local) => {
        const index = local + offset;
        if (this.accepted.has(index)) return;
        const startKnown = !this.startsAcknowledged || this.startedEntries.has(index);
        const runningAtStop = this.runningAtSeal === index || error.interruptedIndex === local;
        if (this.sealed && (!startKnown || runningAtStop)) {
          this.fenced('finished', local);
          return;
        }
        if (!startKnown) this.record('started', local, undefined, true);
        this.record('finished', local, result, true);
      });
    });
  }

  /**
   * The terminal reply, with each streamed finish kept where the reply
   * disagrees on a grade-bearing field. Each disagreement is marked as a
   * rejected duplicate finish.
   */
  settle(outcomes: readonly CodeExecutionResult[], offset = 0): readonly CodeExecutionResult[] {
    return outcomes.map((outcome, local) => {
      const index = local + offset;
      const streamed = this.accepted.get(index);
      if (!streamed || sameOrdinaryOutcome(streamed, outcome)) return outcome;
      this.marks.journalRejected('finished', this.cases[index]?.caseId, index, this.generation, 'duplicate');
      return streamed;
    });
  }

  /** The provider failure a stopped dispatch publishes; the journal supplies the prefix. */
  serviceStopped(): MappedRuntimeOutcome {
    return providerFailure(this.runtime, SERVICE_DEADLINE_MESSAGE);
  }

  /** The dispatch is about to publish its own result. */
  publishing(): void {
    this.published = true;
    this.seal();
  }

  processEnded(): void {
    this.seal();
    if (this.published || this.deadlineMarked) return;
    this.deadlineMarked = true;
    this.marks.serviceDeadline(this.generation, 'backstop', this.accepted.size);
  }

  private withOffset(index: number, run: () => void): void {
    const previous = this.offset;
    this.offset = index;
    try { run(); } finally { this.offset = previous; }
  }

  private expire(): void {
    this.seal();
    this.deadlineMarked = true;
    this.marks.serviceDeadline(this.generation, 'injected', this.accepted.size);
    this.expiry.abort();
  }

  private record(
    progress: 'started' | 'finished',
    localIndex: number,
    result?: CodeExecutionResult,
    reconciling = false
  ): void {
    if (!this.recording) return;
    const index = localIndex + this.offset;
    const caseId = Number.isSafeInteger(index) && index >= 0 ? this.cases[index]?.caseId : undefined;
    if (caseId === undefined) {
      this.marks.journalRejected(progress, undefined, index, this.generation, 'unknown-case');
      return;
    }
    if (this.sealed && !reconciling) {
      this.marks.journalRejected(progress, caseId, index, this.generation, 'fenced');
      return;
    }
    if (progress === 'finished' && this.startsAcknowledged && !this.startedEntries.has(index)) {
      this.marks.journalRejected(progress, caseId, index, this.generation, 'out-of-order');
      return;
    }
    const entry = progress === 'started'
      ? { kind: 'started' as const, caseId }
      : {
          kind: 'finished' as const,
          output: batchCaseOutput(caseId, mappedCodeOutcome(this.runtime, result!)),
          // A reconciled finish is the provider's interrupted prefix, which
          // the port admits after its process was stopped.
          ...(reconciling ? { prefix: true as const } : {}),
        };
    const recorded = Effect.runSyncExit(this.control.record!(this.invocationId, entry));
    if (Exit.isFailure(recorded)) {
      // An asynchronous (or failing) port keeps no journal for this dispatch.
      this.portFailed = true;
      return;
    }
    const disposition = recorded.value;
    if (disposition !== 'accepted') {
      this.marks.journalRejected(progress, caseId, index, this.generation, disposition);
      return;
    }
    if (progress === 'started') this.startedEntries.add(index);
    else this.accepted.set(index, result!);
    this.marks.journalled(progress, caseId, index, this.generation);
    if (!reconciling && this.marks.serviceDeadlineInjected(progress, caseId, index, this.generation)) {
      this.expire();
    }
  }
}

interface RuntimeJudgeProviderOptions {
  readonly runtime: string;
  readonly provider: RuntimePreparedExecutionProvider;
  readonly runtimeControl: JudgeRuntimeControlPort;
  /** The judged-output policy for one evaluation's ordinary prepare. */
  readonly judgedOutputPolicy?: (evaluationId: string) => JudgedOutputPolicy | undefined;
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
  readonly receiptProvider?: JudgeReceiptProvider;
  readonly receiptHostLifetime?: AbortSignal;
  readonly testBridge?: JudgeTestBridge;
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

function disposedExecutionError(executionId: string): JudgePlanError {
  return new JudgePlanError({
    message: `Unknown or disposed interactive execution ${JSON.stringify(executionId)}.`,
  });
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isTraceBinding(
  binding: RuntimeJudgeBinding
): binding is RuntimeJudgeTraceBinding {
  return binding.trace === true;
}

/** The ordinary request is the only one a runtime profile checks; observation never reaches it. */
function assertRuntimeJudgeBindingSupported(
  language: Language,
  binding: RuntimeJudgeCodeBinding
): void {
  assertRuntimeRequestSupported(getLanguageRuntimeProfile(language), {
    request: 'execute',
    executionStyle: judgeExecutionStyle(language, binding),
    functionName: binding.functionName,
    limits: binding.limits,
  });
}

function judgeExecutionStyle(runtime: string, binding: RuntimeJudgeBinding): RuntimeExecutionStyle {
  return binding.executionStyle ?? (
    runtime === 'csharp' || runtime === 'cpp' ? 'solution-method' : 'function'
  );
}

function ordinaryBinding(runtime: string, binding: RuntimeJudgeBinding): RuntimeJudgeCodeBinding {
  return {
    sourcePath: binding.sourcePath,
    functionName: binding.functionName?.trim() ? binding.functionName : '',
    executionStyle: judgeExecutionStyle(runtime, binding),
    limits: binding.limits,
  };
}

const OBSERVATION_OPTIONS = {
  minimalTrace: true,
  traceProfile: true,
  maxPathDepth: true,
  maxTraceSteps: true,
  maxLineEvents: true,
  maxSingleLineHits: true,
  maxStoredEvents: true,
  maxTraceBytes: true,
} satisfies Record<keyof TraceExecutionOptions, true>;

function assertObservationOptions(language: Language, options?: TraceExecutionOptions): void {
  if (!options) return;
  for (const option of Object.keys(options)) {
    if (!Object.hasOwn(OBSERVATION_OPTIONS, option)) {
      throw new Error(`Runtime "${language}" does not recognize the "${option}" tracing option.`);
    }
  }
}


/** An algorithm bundle's binding: its observation options select drawings only. */
function algorithmRuntimeBinding(
  execution: JudgeAlgorithmBundle['execution']
): RuntimeJudgeBinding {
  return {
    sourcePath: execution.sourcePath,
    trace: true,
    functionName: execution.functionName,
    executionStyle: execution.executionStyle,
    traceOptions: execution.traceOptions,
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
 * stage is the default diagnostic code. Provider failures never arrive here: they
 * reject and are reported by `providerFailure`. An outcome that arrives
 * without a valid stage (an untyped provider that broke the contract) is not
 * silently attributed to anyone: the diagnostic names the contract violation.
 */
function failureDiagnostic(
  runtime: string,
  outcome: Extract<
    CodeExecutionResult | RuntimeProgramPreparationResult,
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
  const detail = outcome.diagnostic;
  if (runtime === 'cpp' && stage === 'compile' && detail && typeof detail === 'object' &&
      'code' in detail && (detail.code === 'cpp-exceptions-unsupported' || detail.code === 'cpp-macro-operation-unsupported') &&
      'file' in detail && typeof detail.file === 'string' &&
      'line' in detail && typeof detail.line === 'number' &&
      'column' in detail && typeof detail.column === 'number') {
    return Object.freeze({
      severity: 'error',
      message: outcome.error,
      code: detail.code,
      source: runtime,
      path: detail.file,
      line: detail.line,
      column: detail.column,
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
    CodeExecutionResult | RuntimeProgramPreparationResult,
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
    CodeExecutionResult | RuntimeProgramPreparationResult,
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
    stage: outcome.diagnosticStage as JudgeProgramStage,
    message: diagnostic.message,
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
  });
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

/**
 * One Judge evaluation's ordinary dispatch. Every evaluation has one: the
 * composition registers it before any process starts, and the provider bridge
 * refuses an invocation without it. There is no traced dispatch.
 */
interface RuntimeJudgeDispatch extends RuntimeJudgeProviderOptions {
  readonly binding: RuntimeJudgeCodeBinding;
  readonly owned: OwnedRuntimeDispatch;
}

function prepareProviderProgram(
  options: RuntimeJudgeDispatch,
  programs: RuntimePreparedProgramRegistry,
  context: TraceKernelRuntimeProcessContext,
  invocation: JudgeRuntimeInvocationInput,
  concurrentInitialization?: Effect.Effect<void, Error>
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const binding = options.binding;
    const code = yield* readSubmissionSource(context, binding.sourcePath);
    // Only the composition sets the judged-output policy, on the ordinary
    // prepare. The call is assembled field by field, so nothing in the
    // binding or the request can supply or raise it.
    const judgedOutputPolicy = invocation.evaluationId
      ? options.judgedOutputPolicy?.(invocation.evaluationId)
      : undefined;
    const prepareCall: Omit<JudgedPreparationCall, 'signal'> = {
      mode: 'code',
      code,
      functionName: binding.functionName ?? '',
      executionStyle: binding.executionStyle,
      ...(judgedOutputPolicy ? { judgedOutputPolicy } : {}),
    };
    if (concurrentInitialization) {
      const ordinaryReady = yield* Effect.fork(concurrentInitialization);
      // Let the ordinary readiness request start before opening the observer.
      yield* Effect.yieldNow();
      options.owned.recordPrepare(prepareCall);
      yield* Fiber.join(ordinaryReady);
    }
    const outcome = yield* Effect.tryPromise({
      try: (signal) => {
        const call = { ...prepareCall, signal };
        const prepared = programs.prepare(evaluationId(invocation), call);
        if (!concurrentInitialization) options.owned.recordPrepare(call);
        return prepared;
      },
      catch: errorFromUnknown,
    });
    return mappedPreparationOutcome(options.runtime, outcome);
  });
}

function executePreparedProviderCase(
  options: RuntimeJudgeDispatch,
  programs: RuntimePreparedProgramRegistry,
  invocation: JudgeRuntimeInvocationInput
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const inputs = yield* Effect.try({
      try: () => runtimeInputs(invocation),
      catch: errorFromUnknown,
    });
    const outcome = yield* Effect.tryPromise({
      try: (signal) =>
        programs.executeCode(evaluationId(invocation), {
          inputs: structuredClone(inputs),
          signal,
          limits: options.binding.limits,
        }, () => options.owned.admit(invocation.caseId!)),
      catch: errorFromUnknown,
    });
    return mappedCodeOutcome(options.runtime, outcome);
  });
}

/** Each case's own copy of its input, so a provider cannot alias the plan. */
function runtimeBatchCases(
  invocation: JudgeRuntimeInvocationInput
): readonly {
  readonly caseId: string;
  readonly inputs: Record<string, unknown>;
}[] {
  if (!invocation.cases || invocation.cases.length === 0) {
    throw new TypeError(
      'Prepared runtime Judge batch requires at least one case.'
    );
  }
  return invocation.cases.map((testCase) => ({
    caseId: testCase.caseId,
    inputs: runtimeInputs({
      ...invocation,
      value: structuredClone(testCase.value),
    }),
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
    ...(mapped.output.failure ? { failure: mapped.output.failure } : {}),
    timedOut:
      termination.kind === 'signal' ||
      mapped.output.diagnostics?.some(
        (diagnostic) => diagnostic.code === 'client-timeout'
      ) === true,
  });
}

function interruptedCodeBatchOutcome(
  runtime: string,
  cases: ReturnType<typeof runtimeBatchCases>,
  error: InterruptedCodeBatchError
): Effect.Effect<MappedRuntimeOutcome, Error> {
  if (error.prefix.length > cases.length) {
    return Effect.fail(new RuntimeProviderError('Prepared runtime returned too many batch outcomes.', {
      reason: 'protocol',
    }));
  }
  const unavailable = interruptedFailure(runtime, error);
  const batch = Object.freeze(cases.map(({ caseId }, index) => {
    const outcome = error.prefix[index];
    if (outcome) return batchCaseOutput(caseId, mappedCodeOutcome(runtime, outcome));
    // Transport diagnostics belong to the provider failure. Learner stderr is empty.
    return Object.freeze({ ...batchCaseOutput(caseId, unavailable), stderr: '' });
  }));
  return Effect.succeed(Object.freeze({
    output: Object.freeze({ batch }),
    process: Object.freeze({ exitCode: 0, stdout: '', stderr: '' }),
  }));
}

/**
 * The provider failure for the cases an interrupted batch did not finish. It
 * keeps the interruption's own reason: a malformed reply is `protocol`.
 */
function interruptedFailure(runtime: string, error: InterruptedCodeBatchError): MappedRuntimeOutcome {
  return providerFailure(
    runtime,
    interruptedCodeBatchMessage(error),
    PROVIDER_ERROR_CODE,
    error.reason === 'protocol' ? 'protocol' : 'runtime-failure'
  );
}

function keepInterruptedPrefix(
  error: Error
): Effect.Effect<InterruptedCodeBatchError, Error> {
  return error instanceof InterruptedCodeBatchError ? Effect.succeed(error) : Effect.fail(error);
}

type JournalledBatchReply =
  | readonly CodeExecutionResult[]
  | InterruptedCodeBatchError
  | typeof SERVICE_DEADLINE;

/**
 * How long a provider stopped by a watchdog (the injected deadline or the
 * real kill) may take to surface the authenticated prefix it already holds.
 */
const SERVICE_DEADLINE_SETTLE_MS = 2_000;

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

/**
 * One provider batch call under the batch's journal.
 * - The journal's seal is the first abort listener on the provider's
 *   signal, so once the call is stopped (the injected deadline, the
 *   watchdog's kill, a caller abort) no provider abort handler can report
 *   progress into it.
 * - The trusted service deadline can win the race; the real watchdog's
 *   kill interrupts the call. Either way the aborted provider gets the same
 *   short grace to surface its authenticated prefix, which is reconciled
 *   under the one keep rule (see `BatchProgressJournal.reconcile`).
 * `offset` is the case index of entry 0 (one-case calls).
 */
function journalledBatchCall(
  journal: BatchProgressJournal,
  call: (signal: AbortSignal) => Promise<readonly CodeExecutionResult[]>,
  offset = 0
): Effect.Effect<JournalledBatchReply, Error> {
  if (!journal.recording) {
    return Effect.tryPromise({ try: call, catch: errorFromUnknown }).pipe(
      Effect.catchAll(keepInterruptedPrefix)
    );
  }
  return Effect.suspend(() => {
    let pending: Promise<Settled<readonly CodeExecutionResult[]>> | undefined;
    let graced: Promise<void> | undefined;
    // After a watchdog stop (the injected deadline, or the real kill that
    // interrupts this call), the aborted provider gets the same grace to
    // surface the authenticated prefix it holds. TraceKernel awaits this
    // call's interruption before the process ends, so the grace completes
    // before the batch is taken.
    const grace = () => graced ??= (async () => {
      if (!pending) return;
      let timer: number | ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => { timer = setTimeout(resolve, SERVICE_DEADLINE_SETTLE_MS); }),
      ]);
      clearTimeout(timer);
      // `in` narrowing, which the package's declaration build (not strict) accepts.
      if (late && 'error' in late && late.error instanceof InterruptedCodeBatchError) {
        journal.reconcile(late.error, offset);
      }
    })();
    return Effect.tryPromise({
      try: async (signal): Promise<JournalledBatchReply> => {
        if (journal.expiredAlready) return SERVICE_DEADLINE;
        const local = new AbortController();
        const linked = AbortSignal.any([signal, local.signal]);
        linked.addEventListener('abort', () => journal.seal(), { once: true });
        pending = settled(call(linked));
        const expired = journal.expiredPromise().then((): typeof SERVICE_DEADLINE => SERVICE_DEADLINE);
        const first = await Promise.race([pending, expired]);
        if (first !== SERVICE_DEADLINE) {
          if ('value' in first) return first.value;
          throw first.error;
        }
        local.abort(new DOMException('The service deadline expired.', 'TimeoutError'));
        await grace();
        return SERVICE_DEADLINE;
      },
      catch: errorFromUnknown,
    }).pipe(
      Effect.onInterrupt(() => Effect.promise(grace)),
      Effect.catchAll(keepInterruptedPrefix)
    );
  });
}

/**
 * A batch the service deadline stopped, or a provider interrupted, is
 * published as the provider's failure; the control port's journal supplies
 * its accepted prefix to Judge. Without a journal, the provider's own prefix
 * is published as rows.
 */
function stoppedBatchOutcome(
  runtime: string,
  journal: BatchProgressJournal,
  cases: ReturnType<typeof runtimeBatchCases>,
  reply: InterruptedCodeBatchError | typeof SERVICE_DEADLINE
): Effect.Effect<MappedRuntimeOutcome, Error> {
  if (reply === SERVICE_DEADLINE) return Effect.succeed(journal.serviceStopped());
  if (!journal.recording) return interruptedCodeBatchOutcome(runtime, cases, reply);
  if (reply.prefix.length > cases.length) {
    return Effect.fail(new RuntimeProviderError('Prepared runtime returned too many batch outcomes.', {
      reason: 'protocol',
    }));
  }
  journal.reconcile(reply);
  // A control port that cannot record keeps no journal: publish the prefix itself.
  if (!journal.recording) return interruptedCodeBatchOutcome(runtime, cases, reply);
  return Effect.succeed(interruptedFailure(runtime, reply));
}

function executePreparedProviderBatch(
  options: RuntimeJudgeDispatch,
  programs: RuntimePreparedProgramRegistry,
  invocation: JudgeRuntimeInvocationInput,
  invocationId: string
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const cases = yield* Effect.try({
      try: () => runtimeBatchCases(invocation),
      catch: errorFromUnknown,
    });
    const journal = options.owned.journal.open(options.runtimeControl, invocationId, cases, options.runtime);
    if (invocation.stopAtFirstRunaway === true) {
      return programs.stopsAtFirstRunaway(evaluationId(invocation))
        ? yield* executeProviderStoppingBatch(options, programs, invocation, cases, journal)
        : yield* executeProviderBatchUntilRunaway(options, programs, invocation, cases, journal);
    }
    const reply = yield* journalledBatchCall(journal, (signal) =>
      programs.executeCodeBatch(evaluationId(invocation), {
        inputBatch: cases.map((testCase) => testCase.inputs),
        signal,
        limits: options.binding.limits,
      }, (index) => options.owned.admit(cases[index]!.caseId),
        options.owned.acknowledgeNonStoppingBatchStarts, journal));
    if (reply === SERVICE_DEADLINE || reply instanceof InterruptedCodeBatchError) {
      return yield* stoppedBatchOutcome(options.runtime, journal, cases, reply);
    }
    const outcomes = journal.settle(reply);
    if (outcomes.length !== cases.length) {
      return yield* Effect.fail(
        new Error(
          `Prepared runtime returned ${outcomes.length} batch outcomes for ` +
          `${cases.length} cases.`
        )
      );
    }
    const batch = Object.freeze(outcomes.map((outcome, index) =>
      batchCaseOutput(cases[index]!.caseId, mappedCodeOutcome(options.runtime, outcome))
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
  options: RuntimeJudgeDispatch,
  programs: RuntimePreparedProgramRegistry,
  invocation: JudgeRuntimeInvocationInput,
  cases: ReturnType<typeof runtimeBatchCases>,
  journal: BatchProgressJournal
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const reply = yield* journalledBatchCall(journal, (signal) =>
      programs.executeCodeBatch(evaluationId(invocation), {
        inputBatch: cases.map((testCase) => testCase.inputs),
        signal,
        limits: options.binding.limits,
        stopAtFirstRunaway: true,
      }, (index) => options.owned.admit(cases[index]!.caseId),
        options.owned.acknowledgeStoppingBatchStarts, journal));
    if (reply === SERVICE_DEADLINE || reply instanceof InterruptedCodeBatchError) {
      return yield* stoppedBatchOutcome(options.runtime, journal, cases, reply);
    }
    const outcomes = journal.settle(reply);
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
    // Without admission ACKs the native stopping batch attests only its
    // delivered prefix. A stopped suffix is never speculatively observed.
    for (let index = 0; index < outcomes.length; index++) {
      options.owned.admit(cases[index]!.caseId);
    }
    const batch: JudgeRuntimeBatchCaseOutput[] = outcomes.map((outcome, index) =>
      batchCaseOutput(cases[index]!.caseId, mappedCodeOutcome(options.runtime, outcome))
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
  options: RuntimeJudgeDispatch,
  programs: RuntimePreparedProgramRegistry,
  invocation: JudgeRuntimeInvocationInput,
  cases: ReturnType<typeof runtimeBatchCases>,
  journal: BatchProgressJournal
): Effect.Effect<MappedRuntimeOutcome, Error> {
  return Effect.gen(function* () {
    const batch: JudgeRuntimeBatchCaseOutput[] = [];
    let stoppedBy: { readonly caseId: string; readonly limit: ExecutionLimitReason } | undefined;
    // The coordinator sends each case itself, so it journals every start.
    journal.acknowledgesStarts();
    for (const [index, testCase] of cases.entries()) {
      if (stoppedBy) {
        batch.push(notRunCaseOutput(testCase.caseId, stoppedBy));
        continue;
      }
      // Each case runs as a one-case provider batch, so it gets exactly the
      // bounds it gets in a whole batch (Python's guest guard, per-case
      // deadlines), and the provider replaces a worker that hit one. The
      // coordinator dispatched it, so it journals the start itself.
      const entry = journal.forEntry(index);
      if (journal.expiredAlready) return journal.serviceStopped();
      entry.started(0);
      const reply = yield* journalledBatchCall(journal, (signal) =>
        programs.executeCodeBatch(evaluationId(invocation), {
          inputBatch: [testCase.inputs],
          signal,
          limits: options.binding.limits,
        }, () => options.owned.admit(testCase.caseId), false, {
          acknowledgesStarts: () => undefined,
          started: () => undefined,
          finished: entry.finished,
          fenced: entry.fenced,
        }), index);
      if (reply === SERVICE_DEADLINE) return journal.serviceStopped();
      if (reply instanceof InterruptedCodeBatchError) {
        // Earlier cases are journalled; this call's prefix is this case.
        if (!journal.recording) return yield* Effect.fail(reply);
        const finished = reply.prefix[0];
        if (reply.prefix.length > 1) {
          return yield* Effect.fail(new RuntimeProviderError(
            'Prepared runtime returned too many batch outcomes.', { reason: 'protocol' }
          ));
        }
        if (finished) journal.reconcile(reply, index);
        return interruptedFailure(options.runtime, reply);
      }
      const outcomes = journal.settle(reply, index);
      const outcome = outcomes[0];
      if (outcomes.length !== 1 || !outcome) {
        return yield* Effect.fail(
          new Error(`Prepared runtime returned ${outcomes.length} batch outcomes for 1 case.`)
        );
      }
      if (!journal.hasFinished(index)) entry.finished(0, outcome);
      batch.push(batchCaseOutput(testCase.caseId, mappedCodeOutcome(options.runtime, outcome)));
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
  initialize: Effect.Effect<void, Error>,
  ownedDispatches: ReadonlyMap<string, OwnedRuntimeDispatch>
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
      const owned = invocation.evaluationId ? ownedDispatches.get(invocation.evaluationId) : undefined;
      if (!owned) {
        // Every evaluation registers its ordinary owner before any process
        // starts. Without one there is nothing that may grade this process.
        const unowned = providerFailure(
          options.runtime,
          'Prepared runtime Judge invocation has no ordinary owner.',
          PROVIDER_ERROR_CODE,
          'protocol'
        );
        return options.runtimeControl.publish(invocationId, unowned.output).pipe(Effect.as(unowned.process));
      }
      const dispatch: RuntimeJudgeDispatch = { ...options, owned, binding: owned.binding };
      const overlap = invocation.phase === 'compile' && owned.overlapObservationWithInitialization;
      // Initialization and preparation errors belong to the provider that
      // needed the runtime. They use the same publication path as case errors.
      const execute = invocation.phase === 'compile'
        ? prepareProviderProgram(dispatch, programs, context, invocation, overlap ? initialize : undefined)
        : invocation.phase === 'batch'
          ? executePreparedProviderBatch(dispatch, programs, invocation, invocationId)
          : executePreparedProviderCase(dispatch, programs, invocation);
      const readiness = overlap ? Effect.void : initialize;
      return readiness.pipe(
        Effect.andThen(execute),
        Effect.catchAll((error) => Effect.succeed(providerFailure(
          dispatch.runtime,
          error.message,
          PROVIDER_ERROR_CODE,
          providerFailureReason(error)
        ))),
        Effect.flatMap((mapped) => {
          owned.journal.publishing(invocationId);
          return options.runtimeControl.publish(invocationId, mapped.output).pipe(Effect.as(mapped.process));
        })
      );
    })
  );
}

interface RuntimeJudgeProviderBridge {
  readonly runtimeProvider: TraceKernelRuntimeProvider;
  beginEvaluation(evaluationId: string, owned: OwnedRuntimeDispatch): void;
  disposeEvaluation(evaluationId: string): Effect.Effect<void, Error>;
}

/**
 * Low-level bridge for callers that already own a TraceKernel
 * host. Each provider gets a plan-scoped prepared-program registry.
 */
function makeRuntimeJudgeProvider(
  options: RuntimeJudgeProviderOptions
): RuntimeJudgeProviderBridge {
  if (options.runtime.trim().length === 0) {
    throw new Error('Prepared runtime Judge name must not be empty.');
  }
  const providerOptions: RuntimeJudgeProviderOptions = Object.freeze({ ...options });
  const programs = new RuntimePreparedProgramRegistry(
    providerOptions.provider
  );
  const ownedDispatches = new Map<string, OwnedRuntimeDispatch>();
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
            ensureInitialized,
            ownedDispatches
          ),
        release: () => Effect.void,
      }),
    }),
  });
  return Object.freeze({
    runtimeProvider,
    beginEvaluation: (evaluationId: string, owned: OwnedRuntimeDispatch) => {
      programs.begin(evaluationId);
      ownedDispatches.set(evaluationId, owned);
    },
    disposeEvaluation: (evaluationId: string) =>
      Effect.tryPromise({
        try: () => {
          ownedDispatches.delete(evaluationId);
          return programs.dispose(evaluationId);
        },
        catch: errorFromUnknown,
      }),
  });
}

class EvaluationJudgeRuntimeControl
  implements JudgeRuntimeControlPort {
  constructor(
    private readonly delegate: JudgeRuntimeControlPort,
    private readonly evaluationId: string,
    private readonly journal: EvaluationProgressJournal
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

  record(
    invocationId: string,
    progress: JudgeRuntimeCaseProgress
  ): Effect.Effect<JudgeRuntimeProgressDisposition> {
    return this.delegate.record
      ? this.delegate.record(invocationId, progress)
      : Effect.succeed('unknown-case' as const);
  }

  sealWhen(invocationId: string, stopped: () => boolean): Effect.Effect<void> {
    return this.delegate.sealWhen ? this.delegate.sealWhen(invocationId, stopped) : Effect.void;
  }

  take(
    invocationId: string
  ): Effect.Effect<JudgeRuntimeInvocationOutput | undefined, Error> {
    return this.delegate.take(invocationId).pipe(
      Effect.tap(() => Effect.sync(() => this.journal.taken(invocationId)))
    );
  }

  discard(invocationId: string): Effect.Effect<void> {
    return this.delegate.discard(invocationId);
  }
}

function preparedEvaluationPlan<Input, Expected>(
  plan: JudgeEvaluationPlan<Input, Expected>,
  useProviderBatch: boolean,
  lifecycleAllowanceMs: number = DEFAULT_LIFECYCLE_ALLOWANCE_MS,
  includeSingleton = false
): JudgeEvaluationPlan<Input, Expected> {
  const batched = useProviderBatch && plan.cases.length >= (includeSingleton ? 1 : 2);
  const timeoutMs = preparedRunTimeoutMs(
    plan.run.timeoutMs,
    plan.cases.length,
    batched,
    lifecycleAllowanceMs
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
      ...(timeoutMs === undefined ? {} : { timeoutMs, timeoutRole: 'backstop' as const }),
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
 * The Judge watchdog is only a backstop behind the provider's own per-case
 * limits, which report the reason and the line. It never undercuts the
 * provider: it waits for every case's own deadline plus the provider's
 * declared lifecycle allowance (starting, restoring or replacing a worker or
 * VM) and a recovery allowance per batched case. If it still fires, the
 * provider failed to honour its own limits: the plan marks it a backstop, and
 * Judge reports the provider's failure instead of fabricating time limits.
 */
const DEFAULT_LIFECYCLE_ALLOWANCE_MS = 30_000;
const BATCH_RECOVERY_ALLOWANCE_MS = 10_000;

function preparedRunTimeoutMs(
  perCaseTimeoutMs: number | undefined,
  caseCount: number,
  batched: boolean,
  lifecycleAllowanceMs: number = DEFAULT_LIFECYCLE_ALLOWANCE_MS
): number | undefined {
  if (perCaseTimeoutMs === undefined) return undefined;
  const cases = batched ? caseCount : 1;
  return Math.min(
    2_147_483_647,
    perCaseTimeoutMs * cases +
      lifecycleAllowanceMs +
      (batched ? BATCH_RECOVERY_ALLOWANCE_MS * caseCount : 0)
  );
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

interface RetainedReceiptExecution {
  readonly manifest: JudgeAlgorithmBundle;
  readonly schedule: JudgeObservationSchedule<unknown, unknown>;
}

let nextOpaqueId = 1;

/**
 * A host that registers no observer for a language still grades through the
 * ordinary owner. Each requested drawing is refused; nothing is traced.
 */
function unobservedReceiptProvider(): JudgeReceiptProvider {
  return Object.freeze({
    runtimeVersion: 'unobserved',
    capabilities: Object.freeze({
      observationLease: 'separate' as const,
      observationDeadlineMs: DEFAULT_LIFECYCLE_ALLOWANCE_MS,
    }),
    prepareObservation: async () => ({ status: 'refused' as const, reason: 'recorder-unavailable' as const }),
  });
}

/**
 * The one grade path for every Judge entry: `execute` (one-shot and
 * interactive), continuation, `evaluate` and `evaluateAlgorithm`. Each grades
 * from one ordinary preparation and one ordinary batch; a trace binding only
 * selects which committed rows a separate observer draws.
 */
class RuntimeJudgeComposition
  implements RuntimeJudge {
  private readonly receiptExecutions = new Map<string, RetainedReceiptExecution>();

  constructor(
    readonly runtime: string,
    readonly runtimeControl: JudgeRuntimeControlPort,
    private readonly host: TraceKernelHost,
    private readonly bridge: RuntimeJudgeProviderBridge,
    private readonly binding: RuntimeJudgeBinding,
    private readonly lifecycleAllowanceMs: number,
    private readonly receiptProvider: JudgeReceiptProvider,
    private readonly receiptHostLifetime?: AbortSignal,
    private readonly testBridge?: JudgeTestBridge
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
    if ('executionId' in request) {
      return this.continueExecution<Input, Result, Expected>(request);
    }
    return this.startDirectExecution(request).pipe(Effect.map(({ result }) => result));
  }

  disposeExecution(
    executionId: string
  ): Effect.Effect<void, JudgeInfrastructureError> {
    return Effect.suspend(() => {
      const owned = this.receiptExecutions.get(executionId);
      if (!owned) return Effect.void;
      this.receiptExecutions.delete(executionId);
      return this.disposeSchedule(owned.schedule, disposedExecutionError(executionId));
    });
  }

  disposeRetainedExecutions(): Effect.Effect<void> {
    return Effect.forEach(
      [...this.receiptExecutions.keys()],
      (executionId) => this.disposeExecution(executionId).pipe(
        Effect.catchAll(() => Effect.void)
      ),
      { concurrency: 1, discard: true }
    );
  }

  private untilHostDisposal<A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
    const lifetime = this.receiptHostLifetime;
    if (!lifetime) return operation;
    return Effect.suspend(() => {
      if (lifetime.aborted) return Effect.interrupt;
      return Effect.raceFirst(operation, Effect.async<never>((resume) => {
        const stop = () => resume(Effect.interrupt);
        lifetime.addEventListener('abort', stop, { once: true });
        return Effect.sync(() => lifetime.removeEventListener('abort', stop));
      }));
    });
  }

  startBundleExecution<Input extends Record<string, unknown>, Result, Expected>(
    bundle: JudgeAlgorithmBundle<Input, Expected, Result>,
    request: Pick<RuntimeJudgeInitialExecuteRequest<Input, Expected, Result>,
      'interactive' | 'tracing' | 'stopAtFirstRunaway'>
  ) {
    return this.startReceiptExecution<Input, Result, Expected>(
      bundle,
      {
        ...request,
        plan: bundle.plan,
        comparator: bundle.comparison ? createJudgeComparator<Input>(bundle.comparison) : undefined,
      },
      algorithmRuntimeBinding(bundle.execution)
    );
  }

  /**
   * A plan without an algorithm policy (low-level `execute` and `evaluate`)
   * is graded by the same owner with the standard policy and a digest of its
   * workspace.
   */
  private startDirectExecution<Input, Result, Expected>(
    request: RuntimeJudgeInitialExecuteRequest<Input, Expected, Result>
  ): Effect.Effect<{
    result: RuntimeJudgeExecuteResult<Result, Expected>;
    receipt: JudgeAlgorithmReceipt<Result, Expected>;
  }, JudgePlanError | JudgeInfrastructureError> {
    if (!isTraceBinding(this.binding) && (request.interactive === true || request.tracing !== undefined)) {
      return Effect.fail(new JudgePlanError({
        message: 'Interactive or traced execute requires a trace-capable Judge binding.',
      }));
    }
    return Effect.gen(this, function* () {
      const plan = structuredClone(request.plan);
      const tracing = request.tracing && { caseIds: [...request.tracing.caseIds] };
      const language = this.runtime as Language;
      const cwd = plan.compile?.cwd ?? plan.workspace.cwd ?? '/';
      const path = this.binding.sourcePath.startsWith('/')
        ? this.binding.sourcePath
        : `${cwd.replace(/\/$/u, '')}/${this.binding.sourcePath}`;
      const workspaceDigest = yield* Effect.promise(() => algorithmWorkspaceDigest({
        language,
        sourcePath: path,
        code: JSON.stringify([plan.workspace.files, plan.driver.files]),
      }));
      const bundle: JudgeAlgorithmBundle<Record<string, unknown>, Expected, Result> = {
        schema: ALGORITHM_BUNDLE_SCHEMA,
        id: plan.id,
        workspaceDigest,
        execution: { sourcePath: path },
        plan: plan as JudgeEvaluationPlan<Record<string, unknown>, Expected>,
        policy: allCasesPassPolicy(),
      };
      return yield* this.startReceiptExecution<Input, Result, Expected>(
        bundle, { ...request, plan, tracing }, this.binding
      );
    });
  }

  private startReceiptExecution<Input, Result, Expected>(
    bundle: JudgeAlgorithmBundle<Record<string, unknown>, Expected, Result>,
    request: RuntimeJudgeInitialExecuteRequest<Input, Expected, Result>,
    binding: RuntimeJudgeBinding
  ): Effect.Effect<{
    result: RuntimeJudgeExecuteResult<Result, Expected>;
    receipt: JudgeAlgorithmReceipt<Result, Expected>;
  }, JudgePlanError | JudgeInfrastructureError> {
    return this.untilHostDisposal(Effect.gen(this, function* () {
      const selected = yield* validateTraceSelection(request.plan, request.tracing);
      yield* validateJudgePlan(request.plan);
      const codeBinding = ordinaryBinding(this.runtime, binding);
      const traceOptions = isTraceBinding(binding) ? binding.traceOptions : undefined;
      yield* Effect.try({
        try: () => {
          const language = this.runtime as Language;
          assertRuntimeJudgeBindingSupported(language, codeBinding);
          assertObservationOptions(language, traceOptions);
        },
        catch: (error) => new JudgePlanError({ message: errorFromUnknown(error).message }),
      });

      const evaluationId = this.nextOpaqueExecutionId('evaluation');
      const schedule = new JudgeObservationSchedule(
        evaluationId, bundle, this.receiptProvider, selected ?? new Set(),
        traceOptions && Object.freeze({ ...traceOptions }),
        this.testBridge, this.runtime as Language
      );
      const plan = preparedEvaluationPlan(request.plan, true, this.lifecycleAllowanceMs, true);
      const journal = new EvaluationProgressJournal(schedule);
      const port = new TraceKernelJudgePort({
        host: this.host,
        runtimeControl: new EvaluationJudgeRuntimeControl(this.runtimeControl, evaluationId, journal),
        readableFiles: [codeBinding.sourcePath],
      });
      const operation = Effect.gen(function* () {
        const evaluation = yield* evaluateJudgePlan(port, plan, {
          comparator: request.comparator,
          stopAtFirstRunaway: request.interactive === true || request.stopAtFirstRunaway === true,
        });
        schedule.commit(evaluation);
        return yield* Effect.tryPromise({
          try: (signal) => schedule.initial(signal),
          catch: (cause) => new JudgeInfrastructureError({
            operation: 'join Judge observation',
            message: errorFromUnknown(cause).message,
            cause,
          }),
        });
      });
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(this, function* () {
        this.bridge.beginEvaluation(evaluationId, {
          binding: codeBinding,
          acknowledgeStoppingBatchStarts: this.receiptProvider.capabilities.stoppingBatchAdmission === 'worker-start',
          acknowledgeNonStoppingBatchStarts: this.receiptProvider.capabilities.nonStoppingBatchAdmission === 'worker-start',
          overlapObservationWithInitialization: this.receiptProvider.capabilities.overlapObservationWithInitialization,
          recordPrepare: (call) => schedule.recordPrepare(call),
          admit: (caseId) => schedule.admit(caseId),
          journal,
        });
        const outcome = yield* Effect.exit(restore(operation));
        if (Exit.isFailure(outcome)) {
          yield* Effect.all([
            this.disposeSchedule(schedule).pipe(Effect.catchAll(() => Effect.void)),
            this.disposeEvaluation(evaluationId),
          ], { concurrency: 2 });
          return yield* Effect.failCause(outcome.cause);
        }
        const release = yield* Effect.exit(this.disposeEvaluation(evaluationId));
        if (Exit.isFailure(release)) {
          yield* this.disposeSchedule(schedule).pipe(Effect.catchAll(() => Effect.void));
          return yield* Effect.failCause(release.cause);
        }
        const receipt = outcome.value;
        let executionId: string | undefined;
        if (request.interactive === true && receipt.evaluation.status === 'completed') {
          executionId = this.nextOpaqueExecutionId('execution');
          this.receiptExecutions.set(executionId, { manifest: bundle, schedule });
        } else {
          // A lease release fault is independent of an already joined receipt.
          yield* this.disposeSchedule(schedule).pipe(Effect.catchAll(() => Effect.void));
        }
        schedule.mark('public-resolve');
        return {
          receipt,
          result: Object.freeze({
            ...(executionId ? { executionId } : {}),
            evaluation: receipt.evaluation,
          }),
        };
      }));
    }));
  }

  private disposeSchedule(
    schedule: JudgeObservationSchedule<unknown, unknown>,
    reason?: Error
  ): Effect.Effect<void, JudgeInfrastructureError> {
    return Effect.tryPromise({
      try: () => schedule.dispose(reason),
      catch: (cause) => new JudgeInfrastructureError({
        operation: 'dispose Judge observation',
        message: errorFromUnknown(cause).message,
        cause,
      }),
    });
  }

  private continueExecution<Input, Result, Expected>(
    request: RuntimeJudgeContinueExecuteRequest
  ): Effect.Effect<
    RuntimeJudgeExecuteResult<Result, Expected>,
    JudgePlanError | JudgeInfrastructureError
  > {
    return Effect.suspend(() => {
      const owned = this.receiptExecutions.get(request.executionId);
      if (!owned) return Effect.fail(disposedExecutionError(request.executionId));
      return validateTraceContinuation(owned.manifest.plan, request.tracing).pipe(
        Effect.flatMap((caseIds) => Effect.tryPromise({
          try: (signal) => owned.schedule.continue(caseIds, signal),
          catch: (cause) => cause instanceof JudgePlanError ? cause : new JudgeInfrastructureError({
            operation: 'continue Judge observation',
            message: errorFromUnknown(cause).message,
            cause,
          }),
        })),
        Effect.flatMap((evaluation) => {
          if (this.receiptExecutions.get(request.executionId) !== owned) {
            return Effect.fail(disposedExecutionError(request.executionId));
          }
          owned.schedule.mark('public-resolve');
          return Effect.succeed(Object.freeze({
            executionId: request.executionId,
            evaluation: evaluation as JudgeEvaluationResult<Result, Expected>,
          }));
        })
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
      : `${this.runtime}-${kind}-${nextOpaqueId++}`;
  }

  /**
   * One-shot evaluation of a plan through the ordinary owner. With a trace
   * binding, `tracing` selects the cases to draw; omitting it draws every
   * case, as this entry always has. A code binding draws none.
   */
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
    return Effect.gen(this, function* () {
      yield* validateTraceSelection(plan, options.tracing);
      const tracing = !isTraceBinding(this.binding)
        ? undefined
        : options.tracing ?? { caseIds: plan.cases.map(({ id }) => id) };
      const { result } = yield* this.startDirectExecution<Input, Result, Expected>({
        plan,
        ...(tracing ? { tracing } : {}),
        ...(options.comparator ? { comparator: options.comparator } : {}),
        ...(options.stopAtFirstRunaway === true ? { stopAtFirstRunaway: true } : {}),
      });
      return result.evaluation;
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
    return Effect.gen(this, function* () {
      const snapshot = structuredClone(bundle);
      yield* validateAlgorithmJudgeBundle(snapshot);
      const caseIds = snapshot.execution.trace === true ? snapshot.plan.cases.map(({ id }) => id) : undefined;
      const { receipt } = yield* this.startBundleExecution<Input, Result, Expected>(snapshot, {
        stopAtFirstRunaway: options.stopAtFirstRunaway,
        ...(caseIds ? { tracing: { caseIds } } : {}),
      });
      return receipt;
    });
  }
}

function createRuntimeJudge(
  options: CreateRuntimeJudgeOptions
): Effect.Effect<
  RuntimeJudgeComposition,
  never,
  Scope.Scope
> {
  if (options.binding.sourcePath.trim().length === 0) {
    throw new Error('Prepared runtime Judge sourcePath must not be empty.');
  }
  const runtimeControl =
    options.runtimeControl ?? new InMemoryJudgeRuntimeControl();
  const testBridge = options.testBridge;
  const bridge = makeRuntimeJudgeProvider({
    runtime: options.runtime,
    provider: options.provider,
    runtimeControl,
    judgedOutputPolicy: (evaluationId) =>
      judgedOutputPolicyForPrepare(options.runtime as Language, evaluationId, testBridge),
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
        structuredClone(options.binding),
        options.provider.lifecycleAllowanceMs ?? DEFAULT_LIFECYCLE_ALLOWANCE_MS,
        options.receiptProvider ?? unobservedReceiptProvider(),
        options.receiptHostLifetime,
        options.testBridge
      );
      const lifetime = options.receiptHostLifetime;
      const dispose = () => { Effect.runFork(judge.disposeRetainedExecutions()); };
      lifetime?.addEventListener('abort', dispose, { once: true });
      return Effect.addFinalizer(() => {
        lifetime?.removeEventListener('abort', dispose);
        return judge.disposeRetainedExecutions();
      }).pipe(Effect.as(judge));
    })
  );
}

/**
 * A scoped Judge's binding is checked when the Judge is created, before any
 * provider is initialized or prepared: its ordinary controls against the
 * runtime profile, and its observation options by name. Whether the runtime's
 * observer supports an option is decided at the observation boundary.
 */
function assertDirectBindingSupported(language: Language, binding: RuntimeJudgeBinding): void {
  assertRuntimeJudgeBindingSupported(language, ordinaryBinding(language, binding));
  assertObservationOptions(language, isTraceBinding(binding) ? binding.traceOptions : undefined);
}

export function createBrowserRuntimeJudge(
  options: CreateBrowserRuntimeJudgeOptions
): Effect.Effect<
  RuntimeJudge,
  never,
  Scope.Scope
> {
  assertDirectBindingSupported(options.language, options.binding);
  return composeBrowserRuntimeJudge(
    options,
    getBrowserRuntimeHostJudgeReceiptProvider(options.host, options.language),
    undefined,
    readJudgeTestBridge()
  );
}

function composeBrowserRuntimeJudge(
  options: CreateBrowserRuntimeJudgeOptions,
  receiptProvider: JudgeReceiptProvider | undefined,
  receiptHostLifetime?: AbortSignal,
  testBridge?: JudgeTestBridge
) {
  // Every request is validated by the ordinary owner before any provider is
  // initialized or prepared, so unsupported controls cannot vanish.
  return createRuntimeJudge({
    runtime: options.language,
    provider: getBrowserRuntimeHostPreparedProvider(
      options.host,
      options.language
    ),
    binding: options.binding,
    runtimeControl: options.runtimeControl,
    receiptProvider,
    receiptHostLifetime,
    testBridge,
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
  readonly abort: AbortController;
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
  const lifetime = new AbortController();
  const testBridge = readJudgeTestBridge();

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
    retained.abort?.abort(disposedExecutionError(executionId));
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
    if (!('executionId' in request)) return (await executeInitial(request)).result;
    const requestStartedAt = judgeTimingNow();
    const phases: RuntimeJudgeExecutionPhaseTiming[] = [];
    const retained = retainedExecutions.get(request.executionId);
    if (!retained) throw disposedExecutionError(request.executionId);
    clearIdleTimer(retained);
    retained.activeContinuations += 1;
    const signal = AbortSignal.any(request.signal ? [retained.abort.signal, request.signal] : [retained.abort.signal]);
    try {
      const tracing = { caseIds: [...request.tracing.caseIds] };
      const result = await measureJudgeExecutionPhase(
        phases,
        'trace-continuation-execute',
        () => runAbortable(
          retained.judge.execute<Input, Result, Expected>({
            executionId: request.executionId,
            tracing,
          }),
          signal
        )
      );
      if (signal.aborted) throw judgeAbortError();
      return withJudgeExecutionTimings(result, requestStartedAt, phases);
    } catch (cause) {
      if (retained.abort.signal.aborted && signal.reason === retained.abort.signal.reason) {
        throw retained.abort.signal.reason;
      }
      throw cause;
    } finally {
      retained.activeContinuations -= 1;
      armIdleTimer(request.executionId, retained);
    }
  };

  async function executeInitial<Input extends Record<string, unknown>, Result, Expected>(
    request: BrowserJudgeInitialExecuteRequest<Input, Expected, Result>
  ): Promise<{
    result: RuntimeJudgeExecuteResult<Result, Expected>;
    receipt: JudgeAlgorithmReceipt<Result, Expected>;
  }> {
    const requestStartedAt = judgeTimingNow();
    const phases: RuntimeJudgeExecutionPhaseTiming[] = [];
    const language = request.bundle.plan.runtime as Language;
    const registration = getBrowserRuntimeHostJudgeReceiptProvider(host, language);
    const bundle = structuredClone(request.bundle);
    const tracing = request.tracing && { caseIds: [...request.tracing.caseIds] };
    const signal = AbortSignal.any(request.signal ? [lifetime.signal, request.signal] : [lifetime.signal]);
    await measureJudgeExecutionPhase(
      phases,
      'bundle-validation',
      () => Effect.runPromise(validateAlgorithmJudgeBundle(bundle))
    );
    if (signal.aborted) throw judgeAbortError();
    if (!host.isLanguageSupported(language)) {
      throw new Error(
        `Judge runtime ${JSON.stringify(bundle.plan.runtime)} is not supported by this browser authority.`
      );
    }
    const binding = algorithmRuntimeBinding(bundle.execution);
    const scope = Effect.runSync(Scope.make());
    try {
      const judge = await measureJudgeExecutionPhase(
        phases,
        'judge-create',
        () => Effect.runPromise(
          Scope.extend(
            composeBrowserRuntimeJudge({ host, language, binding }, registration, undefined, testBridge),
            scope
          )
        )
      );
      const controls = {
        interactive: request.interactive,
        tracing,
        stopAtFirstRunaway: request.stopAtFirstRunaway,
      };
      const { result, receipt } = await measureJudgeExecutionPhase(
        phases,
        'initial-execute',
        () => runAbortable(judge.startBundleExecution<Input, Result, Expected>(bundle, controls), signal)
      );
      if (signal.aborted) throw judgeAbortError();
      if (result.executionId) {
        const retained: RetainedBrowserJudgeExecution = {
          judge,
          scope,
          activeContinuations: 0,
          abort: new AbortController(),
        };
        retainedExecutions.set(result.executionId, retained);
        armIdleTimer(result.executionId, retained);
      } else {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
      return { result: withJudgeExecutionTimings(result, requestStartedAt, phases), receipt };
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.fail(error))).catch(
        () => undefined
      );
      throw error;
    }
  }

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
    createJudge: (judgeOptions: CreateBrowserJudgeOptions) => {
      assertDirectBindingSupported(judgeOptions.language, judgeOptions.binding);
      return composeBrowserRuntimeJudge(
        { host, ...judgeOptions },
        getBrowserRuntimeHostJudgeReceiptProvider(host, judgeOptions.language),
        lifetime.signal,
        testBridge
      );
    },
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
      return executeInitial({
        bundle,
        ...(tracing ? { tracing } : {}),
        ...(signal ? { signal } : {}),
        ...(stopAtFirstRunaway === true ? { stopAtFirstRunaway: true } : {}),
      }).then(({ receipt }) => receipt);
    },
    createProjectJudge: (projectOptions = {}) =>
      createBrowserProjectJudge({
        ...projectOptions,
        workspace: options.project,
      }),
    dispose: () => {
      lifetime.abort(judgeAbortError());
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
