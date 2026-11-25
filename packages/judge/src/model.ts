import type {
  JudgeCaseVerdict,
  JudgeComparator,
} from './comparison';
import type { Attachment } from './internal/receipt-types';

export type JudgeFileVisibility = 'submission' | 'judge-private';

export interface JudgeWorkspaceFile {
  readonly path: string;
  readonly contents: string | Uint8Array;
  /**
   * Submission files may be shown to the learner. Judge-private files are
   * mounted only into the protected evaluation session and must never be
   * exposed by a product workspace or result payload.
   */
  readonly visibility: JudgeFileVisibility;
}

export interface JudgeProcessPlan {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /**
   * What `timeoutMs` is. `limit` (the default): for a single-case process,
   * the program's time limit; a case the watchdog stops ran out of time.
   * `backstop`: a guard behind a runtime that enforces its own per-case
   * limits; the watchdog firing means the runtime failed to honour them,
   * which is the provider's failure.
   *
   * For a provider-isolated batch the role does not matter: a batch-wide
   * clock is no case's own limit. Whichever role stops a batch, each case
   * whose finish the control port accepted keeps it, and every other case is
   * the provider's failure. No per-case limit is fabricated.
   */
  readonly timeoutRole?: 'limit' | 'backstop';
}

export interface JudgeCasePlan<Input = unknown, Expected = unknown> {
  readonly id: string;
  /**
   * Delivered over the runtime control port. Case input is not serialized into
   * learner stdin/stdout and does not need to be mounted in the workspace.
   */
  readonly input: Input;
  /**
   * Omit this property for an execution-only case. An explicitly provided
   * `undefined` remains an expected value and is compared normally.
   */
  readonly expected?: Expected;
  readonly env?: Readonly<Record<string, string>>;
}

export interface JudgeIsolationPolicy {
  /**
   * Every case starts from the post-compile filesystem image in a new
   * TraceKernel session. Process state, descriptors, environment mutations,
   * filesystem writes, and runtime leases cannot flow into another case.
   */
  readonly mode:
    | 'fresh-session-per-case'
    /**
     * Run the case vector through one provider batch invocation. This mode is
     * valid only when the runtime provider guarantees fresh mutable language
     * state for every case in the batch.
     */
    | 'provider-isolated-batch';
  readonly maxConcurrency?: number;
}

export interface JudgeEvaluationPlan<Input = unknown, Expected = unknown> {
  readonly id: string;
  readonly runtime: string;
  readonly workspace: {
    readonly cwd?: string;
    readonly files: readonly JudgeWorkspaceFile[];
  };
  readonly driver: {
    /**
     * Generated driver files live below `/.tracecode/judge/`. They are visible
     * to protected grader processes but are not part of learner workspace or
     * evaluation result APIs.
     */
    readonly files: readonly JudgeWorkspaceFile[];
  };
  readonly compile?: JudgeProcessPlan;
  readonly run: JudgeProcessPlan;
  readonly cases: readonly JudgeCasePlan<Input, Expected>[];
  readonly isolation?: JudgeIsolationPolicy;
  /**
   * Successful case processes normally must publish one structured result on
   * the private runtime control channel. Set to optional for executable
   * exercises whose observable contract is intentionally stdout-only.
   */
  readonly structuredResult?: 'required' | 'optional';
}

export interface JudgeEvaluationOptions<
  Input = unknown,
  Expected = unknown,
  Result = unknown,
> {
  /**
   * Expected-value policy. Runtime providers publish only raw results and do
   * not receive this comparator.
   */
  readonly comparator?: JudgeComparator<Input, Expected, Result>;
  /**
   * Cases to observe. Judge validates the ids but never asks a runtime to
   * record: every case is graded from its ordinary execution, and a host with
   * an observer attaches drawings to the selected rows afterwards. The browser
   * Judge's `evaluate` draws every case of a trace binding when this is
   * omitted, and none when it is an empty list.
   */
  readonly tracing?: {
    readonly caseIds: readonly string[];
  };
  /**
   * Run semantics: once one case is stopped by a time or line limit, the
   * remaining cases are not run and are reported as `not-run`. Without it
   * (Submit semantics) every case runs under its own bound.
   */
  readonly stopAtFirstRunaway?: boolean;
}

export type JudgeTermination =
  | {
      readonly kind: 'exit';
      readonly exitCode: number;
    }
  | {
      readonly kind: 'signal';
      readonly signal: string;
      readonly exitCode: number;
    }
  | {
      readonly kind: 'failure';
      readonly exitCode: number;
      readonly message: string;
    };

export interface JudgeDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  /**
   * Set only on the warning the Judge adds when a traced case's recording
   * stopped at a budget (`code` names the budget). The trace ends there.
   */
  readonly kind?: 'trace-truncated';
  readonly code?: string;
  readonly source?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * Diagnostic codes of the compile-stage refusals a runtime raises before
 * compiling source that uses a construct it does not support yet. The
 * diagnostic carries the code with `path`, `line` and `column`; the program's
 * failure is `compile`, never a wrong answer, a limit or a runtime error.
 */
export type JudgeSourceRefusalCode =
  | 'cpp-exceptions-unsupported'
  | 'cpp-macro-operation-unsupported';

export interface JudgeRuntimeTimings {
  readonly [name: string]: number | boolean | undefined;
}

export interface JudgeProcessResult {
  readonly sessionId: string;
  readonly pid: number;
  readonly termination: JudgeTermination;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics: readonly JudgeDiagnostic[];
  readonly timings?: JudgeRuntimeTimings;
  readonly timedOut: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

/** Which stage of the learner's program failed. */
export type JudgeProgramStage =
  | 'compile'
  | 'runtime'
  | 'trace'
  | 'driver-compile'
  | 'trace-driver-compile'
  | 'driver-link';

/** Which limit stopped the learner's program. */
export type JudgeLimitReason =
  | 'client-timeout'
  | 'trace-limit'
  | 'trace-byte-limit'
  | 'line-limit'
  | 'single-line-limit'
  | 'recursion-limit'
  | 'memory-limit'
  | 'serialization-limit';

/**
 * Where a failure came from, stated by the Harness so a consumer never has to
 * infer it.
 *
 * - `program`: the learner's program failed at `stage`.
 * - `limit`: a limit stopped the learner's program; `reason` names it.
 * - `provider`: the runtime provider failed for a reason the program did not
 *   cause. `runtime-failure`: the runtime could not run the program (assets,
 *   transport, a worker that died outside the program). `protocol`: the
 *   runtime finished without the structured result Judge requires.
 *   `contract-violation`: the runtime reported a failure without saying whose
 *   it was.
 */
export type JudgeFailure =
  | {
      readonly origin: 'program';
      readonly stage: JudgeProgramStage;
      readonly message: string;
      readonly line?: number;
    }
  | {
      readonly origin: 'limit';
      readonly reason: JudgeLimitReason;
      readonly message: string;
    }
  | {
      readonly origin: 'provider';
      readonly reason: 'runtime-failure' | 'protocol' | 'contract-violation';
      readonly message: string;
    };

/**
 * Why a case was not run. `run-stopped-after-limit`: an earlier case of the
 * same Run (`stoppedByCaseId`) was stopped by `limit`, and Run stops at the
 * first runaway case. A case that was not run never reports a failure or a
 * limit of its own.
 */
export interface JudgeNotRun {
  readonly reason: 'run-stopped-after-limit';
  readonly stoppedByCaseId: string;
  readonly limit: JudgeLimitReason;
}

/**
 * A compile result. Every compile that did not succeed carries `failure`;
 * a successful one never does.
 */
export type JudgeCompileResult = JudgeProcessResult & (
  | {
      readonly status: 'compiled';
      readonly failure?: undefined;
    }
  | {
      readonly status: 'compile-failed' | 'timed-out';
      readonly failure: JudgeFailure;
    }
);

interface JudgeCaseResultFields<Result, Expected>
  extends JudgeProcessResult {
  readonly caseId: string;
  readonly value?: Result;
  readonly trace?: unknown;
  /** Observation for this case, when explicitly selected. */
  readonly attachment?: Attachment;
  readonly expected?: Expected;
  readonly verdict: JudgeCaseVerdict;
  readonly protocolError?: string;
}

/**
 * A case result. Every case that did not complete carries `failure`, which
 * says whose failure it was; a completed case never does.
 */
export type JudgeCaseResult<Result = unknown, Expected = unknown> =
  JudgeCaseResultFields<Result, Expected> & (
    | {
        readonly status: 'completed';
        readonly failure?: undefined;
        readonly notRun?: undefined;
      }
    | {
        readonly status: 'runtime-error' | 'timed-out' | 'protocol-error';
        readonly failure: JudgeFailure;
        readonly notRun?: undefined;
      }
    | {
        readonly status: 'not-run';
        readonly failure?: undefined;
        readonly notRun: JudgeNotRun;
      }
  );

export type JudgeEvaluationResult<Result = unknown, Expected = unknown> =
  | {
      readonly planId: string;
      readonly status: 'compile-failed';
      readonly compile: Exclude<JudgeCompileResult, { readonly status: 'compiled' }>;
      readonly cases: readonly [];
    }
  | {
      readonly planId: string;
      readonly status: 'completed';
      readonly compile?: JudgeCompileResult;
      readonly cases: readonly JudgeCaseResult<Result, Expected>[];
    };
