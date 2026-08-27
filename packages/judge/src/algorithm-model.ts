import type { JudgeComparatorPolicy } from './comparator-strategy';
import type { JudgeFact } from './facts';
import type {
  JudgeEvaluationOptions,
  JudgeEvaluationPlan,
  JudgeEvaluationResult,
} from './model';
import type {
  JudgePolicyEvaluation,
  JudgeVerdictPolicy,
} from './policy';

export const ALGORITHM_BUNDLE_SCHEMA =
  'tracecode.judge.algorithm-bundle.v1' as const;
export const ALGORITHM_RECEIPT_SCHEMA =
  'tracecode.judge.algorithm-receipt.v1' as const;

export interface JudgeAlgorithmExecution {
  readonly sourcePath: string;
  readonly functionName?: string | null;
  readonly executionStyle?: 'function' | 'solution-method' | 'ops-class';
  readonly trace?: boolean;
  /**
   * Trace-program controls. These may be supplied without `trace: true` when
   * Browser Judge `execute` will select traced cases on demand.
   */
  readonly traceOptions?: {
    /** Trace-capture budget. This does not interrupt ordinary execution. */
    readonly maxTraceSteps?: number;
    /** Trace-capture budget. This does not act as an execution line limit. */
    readonly maxLineEvents?: number;
    /** Trace-capture budget. This does not act as an execution hit limit. */
    readonly maxSingleLineHits?: number;
    readonly maxStoredEvents?: number;
    /**
     * Maximum UTF-8 bytes retained for normalized trace events. Runtime hard
     * ceilings still apply when a portable bundle requests a larger value.
     */
    readonly maxTraceBytes?: number;
  };
  readonly limits?: {
    readonly wallClockMs?: number;
    /** Runtime interruption limit, distinct from traceOptions.maxLineEvents. */
    readonly maxLineEvents?: number;
    /** Runtime interruption limit, distinct from traceOptions.maxSingleLineHits. */
    readonly maxSingleLineHits?: number;
    readonly maxCallDepth?: number;
    readonly maxMemoryBytes?: number;
    /**
     * @deprecated Never enforced here. Use traceOptions.maxTraceSteps.
     * Bundles that set this legacy field are rejected instead of ignoring it.
     */
    readonly maxTraceSteps?: number;
    /**
     * @deprecated Never enforced here. Use traceOptions.maxStoredEvents.
     * Bundles that set this legacy field are rejected instead of ignoring it.
     */
    readonly maxStoredEvents?: number;
    /**
     * @deprecated Algorithm execution has no output-byte runtime limit.
     * Bundles that set this legacy field are rejected instead of ignoring it.
     */
    readonly maxOutputBytes?: number;
  };
}

export interface JudgeAlgorithmBundle<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Expected = unknown,
  Result = unknown,
> {
  readonly schema: typeof ALGORITHM_BUNDLE_SCHEMA;
  readonly id: string;
  /**
   * Digest of the exact learner submission and any judge-visible source files.
   * Semantic facts must name this digest or Judge treats them as unavailable.
   */
  readonly workspaceDigest: string;
  /**
   * Runtime-provider entrypoint needed to execute this manifest. It is data,
   * not an executable adapter, so the same bundle crosses browser/mux
   * authorities unchanged.
   */
  readonly execution: JudgeAlgorithmExecution;
  readonly plan: JudgeEvaluationPlan<Input, Expected>;
  readonly policy: JudgeVerdictPolicy;
  readonly facts?: readonly JudgeFact[];
  /**
   * Serializable comparison policy. Judge materializes the executable
   * comparator inside the current authority and never forwards it to a
   * language runtime.
   */
  readonly comparison?: JudgeComparatorPolicy;
}

export type JudgeAlgorithmVerdict =
  | 'passed'
  | 'failed'
  | 'indeterminate';

export interface JudgeAlgorithmReceipt<
  Result = unknown,
  Expected = unknown,
> {
  readonly schema: typeof ALGORITHM_RECEIPT_SCHEMA;
  readonly bundleId: string;
  readonly workspaceDigest: string;
  readonly evaluation: JudgeEvaluationResult<Result, Expected>;
  readonly policy: JudgePolicyEvaluation;
  readonly verdict: JudgeAlgorithmVerdict;
  readonly passedCount: number;
  readonly totalCount: number;
  readonly evaluatedAt: string;
}

export interface JudgeAlgorithmEvaluationOptions<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Expected = unknown,
  Result = unknown,
> extends JudgeEvaluationOptions<Input, Expected, Result> {
  readonly evaluatedAt?: string;
}
