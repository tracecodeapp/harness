import type * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';
import type {
  JudgeDiagnostic,
  JudgeFailure,
  JudgeNotRun,
  JudgeProcessPlan,
  JudgeRuntimeTimings,
  JudgeTermination,
  JudgeWorkspaceFile,
} from './model';

export type JudgeKernelSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export interface JudgeRuntimeInvocationInput<Input = unknown> {
  readonly phase: 'compile' | 'case' | 'batch';
  readonly planId: string;
  /**
   * Opaque lifecycle key shared by every process in one evaluation. Runtime
   * adapters may use it to own plan-scoped prepared artifacts without treating
   * the semantic plan id as a globally unique execution id.
   */
  readonly evaluationId?: string;
  readonly caseId?: string;
  readonly value?: Input;
  readonly recordTrace?: boolean;
  /** Batch only: stop at the first case stopped by a time or line limit. */
  readonly stopAtFirstRunaway?: boolean;
  readonly cases?: readonly {
    readonly caseId: string;
    readonly value: Input;
    readonly recordTrace?: boolean;
  }[];
}

export interface JudgeRuntimeBatchCaseOutput<Result = unknown> {
  readonly caseId: string;
  readonly termination: JudgeTermination;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics?: readonly JudgeDiagnostic[];
  readonly timings?: JudgeRuntimeTimings;
  readonly value?: Result;
  readonly trace?: unknown;
  readonly timedOut: boolean;
  /** Required by the runtime adapter on every case that did not complete. */
  readonly failure?: JudgeFailure;
  /** Set instead of a result when the case was not run (Run stopped early). */
  readonly notRun?: JudgeNotRun;
}

export interface JudgeRuntimeInvocationOutput<Result = unknown> {
  readonly value?: Result;
  /**
   * Optional raw trace metadata. Judge preserves it but never includes it in
   * expected-value comparison.
   */
  readonly trace?: unknown;
  readonly diagnostics?: readonly JudgeDiagnostic[];
  readonly timings?: JudgeRuntimeTimings;
  readonly batch?: readonly JudgeRuntimeBatchCaseOutput<Result>[];
  /**
   * Whose failure it was, when the invocation did not succeed. A runtime
   * adapter that knows sets it; Judge falls back to the process termination
   * only for processes that publish nothing (see `processFailure`).
   */
  readonly failure?: JudgeFailure;
}

export interface JudgeRuntimeControlPort {
  begin(
    input: JudgeRuntimeInvocationInput
  ): Effect.Effect<string, Error>;
  read(
    invocationId: string
  ): Effect.Effect<JudgeRuntimeInvocationInput, Error>;
  publish(
    invocationId: string,
    output: JudgeRuntimeInvocationOutput
  ): Effect.Effect<void, Error>;
  take(
    invocationId: string
  ): Effect.Effect<JudgeRuntimeInvocationOutput | undefined, Error>;
  discard(invocationId: string): Effect.Effect<void>;
}

export interface JudgeKernelProcessOutcome {
  readonly sessionId: string;
  readonly pid: number;
  readonly termination: JudgeTermination;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics?: readonly JudgeDiagnostic[];
  readonly timings?: JudgeRuntimeTimings;
  readonly structuredResult?: unknown;
  readonly trace?: unknown;
  readonly batch?: readonly JudgeRuntimeBatchCaseOutput[];
  readonly failure?: JudgeFailure;
  readonly timedOut: boolean;
  /**
   * A backstop watchdog (`timeoutRole: 'backstop'`) stopped the process: the
   * runtime did not honour its own limits. Set instead of `timedOut`.
   */
  readonly backstopTimedOut?: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface JudgeKernelProcess {
  readonly sessionId: string;
  readonly pid: number;
  wait(): Effect.Effect<JudgeKernelProcessOutcome, Error>;
  signal(signal: JudgeKernelSignal): Effect.Effect<void, Error>;
}

export interface JudgeKernelSpawnRequest {
  readonly runtime: string;
  readonly process: JudgeProcessPlan;
  readonly invocation: JudgeRuntimeInvocationInput;
}

export interface JudgeKernelSession<Snapshot> {
  readonly id: string;
  mount(files: readonly JudgeWorkspaceFile[]): Effect.Effect<void, Error>;
  snapshot(): Effect.Effect<Snapshot, Error>;
  spawn(
    request: JudgeKernelSpawnRequest
  ): Effect.Effect<JudgeKernelProcess, Error>;
}

/**
 * The sole platform boundary consumed by Judge.
 *
 * Browser runtimes and TraceKernel adapters implement this port. Judge never
 * calls a direct language RuntimeClient and never owns worker lifecycle.
 */
export interface JudgeKernelPort<Snapshot> {
  openSession(options?: {
    readonly cwd?: string;
    readonly snapshot?: Snapshot;
  }): Effect.Effect<JudgeKernelSession<Snapshot>, Error, Scope.Scope>;
}
