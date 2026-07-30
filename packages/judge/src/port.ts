import type * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';
import type {
  JudgeDiagnostic,
  JudgeProcessPlan,
  JudgeRuntimeTimings,
  JudgeTermination,
  JudgeWorkspaceFile,
} from './model';

export type JudgeKernelSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export interface JudgeRuntimeInvocationInput<Input = unknown> {
  readonly phase: 'compile' | 'case';
  readonly planId: string;
  /**
   * Opaque lifecycle key shared by every process in one evaluation. Runtime
   * adapters may use it to own plan-scoped prepared artifacts without treating
   * the semantic plan id as a globally unique execution id.
   */
  readonly evaluationId?: string;
  readonly caseId?: string;
  readonly value?: Input;
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
  readonly timedOut: boolean;
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
