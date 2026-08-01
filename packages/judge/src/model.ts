import type {
  JudgeCaseVerdict,
  JudgeComparator,
} from './comparison';

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
  readonly code?: string;
  readonly source?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

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

export interface JudgeCompileResult extends JudgeProcessResult {
  readonly status: 'compiled' | 'compile-failed' | 'timed-out';
}

export interface JudgeCaseResult<Result = unknown, Expected = unknown>
  extends JudgeProcessResult {
  readonly caseId: string;
  readonly status:
    | 'completed'
    | 'runtime-error'
    | 'timed-out'
    | 'protocol-error';
  readonly value?: Result;
  readonly trace?: unknown;
  readonly expected?: Expected;
  readonly verdict: JudgeCaseVerdict;
  readonly protocolError?: string;
}

export type JudgeEvaluationResult<Result = unknown, Expected = unknown> =
  | {
      readonly planId: string;
      readonly status: 'compile-failed';
      readonly compile: JudgeCompileResult;
      readonly cases: readonly [];
    }
  | {
      readonly planId: string;
      readonly status: 'completed';
      readonly compile?: JudgeCompileResult;
      readonly cases: readonly JudgeCaseResult<Result, Expected>[];
    };
