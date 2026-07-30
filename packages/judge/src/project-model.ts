import type {
  JudgeDiagnostic,
  JudgeProcessPlan,
  JudgeProcessResult,
  JudgeWorkspaceFile,
} from './model';
import type { JudgeFact } from './facts';
import type {
  JudgePolicyEvaluation,
  JudgeVerdictPolicy,
} from './policy';

export const PROJECT_DEFINITION_SCHEMA =
  'tracecode.judge.project-definition.v1' as const;
export const PROJECT_ATTEMPT_SCHEMA =
  'tracecode.judge.project-attempt.v1' as const;
export const PROJECT_BUNDLE_SCHEMA =
  'tracecode.judge.project-bundle.v1' as const;
export const PROJECT_RECEIPT_SCHEMA =
  'tracecode.judge.project-receipt.v1' as const;
export const PROJECT_EXECUTION_EVIDENCE_SCHEMA =
  'tracecode.judge.project-execution-evidence.v1' as const;

export type JudgeArtifactRef =
  | {
      readonly kind: 'inline';
      readonly digest: string;
      readonly files: readonly JudgeWorkspaceFile[];
    }
  | {
      readonly kind: 'content-addressed';
      readonly digest: string;
      readonly mediaType:
        | 'application/vnd.tracecode.workspace+json'
        | 'application/vnd.tracecode.workspace+zip';
      readonly locator: string;
    };

export interface JudgeProjectWorkspaceView {
  readonly base: 'submission' | 'starter';
  readonly overlays?: readonly {
    readonly source: 'submission' | 'starter';
    readonly paths: readonly string[];
  }[];
}

export interface JudgeProjectCommandStep {
  readonly id: string;
  readonly kind: 'command';
  readonly workspace: JudgeProjectWorkspaceView;
  readonly process: JudgeProcessPlan;
}

export interface JudgeProjectServiceProbeStep {
  readonly id: string;
  readonly kind: 'service-probe';
  readonly workspace: JudgeProjectWorkspaceView;
  readonly service: JudgeProcessPlan;
  readonly probe: JudgeProcessPlan;
  /**
   * A bounded delay is intentionally the only V1 readiness primitive.
   * Protocol-aware readiness can be added as another typed operation without
   * admitting arbitrary workflow expressions into the execution layer.
   */
  readonly readinessDelayMs?: number;
  readonly shutdownSignal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
}

export type JudgeProjectStep =
  | JudgeProjectCommandStep
  | JudgeProjectServiceProbeStep;

export interface JudgeProjectEvaluatorReference {
  readonly kind: string;
  readonly version: number;
  readonly config: unknown;
}

export interface JudgeProjectDefinitionV1 {
  readonly schema: typeof PROJECT_DEFINITION_SCHEMA;
  readonly id: string;
  readonly revision: string;
  readonly workspace: {
    readonly cwd: string;
    readonly starter: JudgeArtifactRef;
    readonly privateFiles?: JudgeArtifactRef;
  };
  readonly steps: readonly JudgeProjectStep[];
  readonly evaluators?: readonly JudgeProjectEvaluatorReference[];
  readonly verdictPolicy: JudgeVerdictPolicy;
}

export type JudgeObservation =
  | {
      readonly seq: number;
      readonly kind: 'edit';
      readonly actor: string;
      readonly path: string;
      readonly observedAt?: string;
    }
  | {
      readonly seq: number;
      readonly kind: 'process';
      readonly actor: string;
      readonly stepId?: string;
      readonly command: string;
      readonly argv: string;
      readonly exitCode: number;
      readonly startedAt?: string;
      readonly completedAt?: string;
    }
  | {
      readonly seq: number;
      readonly kind: 'http';
      readonly actor: string;
      readonly stepId?: string;
      readonly method?: string;
      readonly host: string;
      readonly path: string;
      readonly status: number | null;
      readonly via: 'listener' | 'external' | 'loopback';
      readonly pid?: number;
      readonly authFingerprint?: string;
      readonly meta?: Readonly<Record<string, unknown>>;
      readonly observedAt?: string;
    };

export interface JudgeProjectAttemptV1 {
  readonly schema: typeof PROJECT_ATTEMPT_SCHEMA;
  readonly attemptId: string;
  readonly submittedWorkspace: JudgeArtifactRef;
  readonly evidence?: readonly JudgeObservation[];
  readonly facts?: readonly JudgeFact[];
  /**
   * A product may execute the definition's steps in its already-running
   * TraceKernel session and submit the resulting technical receipt. Judge
   * still owns claim evaluation and the verdict policy. A mux or another
   * trusted host can omit this field and execute the same steps itself.
   */
  readonly executionEvidence?: JudgeProjectExecutionEvidenceV1;
}

export interface JudgeProjectBundleV1 {
  readonly schema: typeof PROJECT_BUNDLE_SCHEMA;
  readonly definition: JudgeProjectDefinitionV1;
  readonly attempt: JudgeProjectAttemptV1;
}

export interface JudgeProjectCommandStepReceipt {
  readonly id: string;
  readonly kind: 'command';
  readonly process: JudgeProcessResult;
  readonly observations: readonly JudgeObservation[];
}

export interface JudgeProjectServiceProbeStepReceipt {
  readonly id: string;
  readonly kind: 'service-probe';
  readonly service: JudgeProcessResult;
  readonly probe: JudgeProcessResult;
  readonly observations: readonly JudgeObservation[];
}

export type JudgeProjectStepReceipt =
  | JudgeProjectCommandStepReceipt
  | JudgeProjectServiceProbeStepReceipt;

export interface JudgeProjectExecutionEvidenceV1 {
  readonly schema: typeof PROJECT_EXECUTION_EVIDENCE_SCHEMA;
  readonly verification: 'browser-asserted' | 'mux-computed' | 'signed';
  readonly steps: readonly JudgeProjectStepReceipt[];
}

export type JudgeProjectClaimStatus =
  | 'proven'
  | 'contradicted'
  | 'not-demonstrated'
  | 'insufficient';

export interface JudgeProjectClaim {
  readonly id: string;
  readonly label: string;
  readonly status: JudgeProjectClaimStatus;
  readonly summary: string;
  readonly scored: boolean;
  readonly evidence: readonly {
    readonly observationSeq?: number;
    readonly stepId?: string;
    readonly artifactPath?: string;
    readonly actor?: string;
    readonly note: string;
  }[];
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface JudgeProjectReceiptV1 {
  readonly schema: typeof PROJECT_RECEIPT_SCHEMA;
  readonly definition: {
    readonly id: string;
    readonly revision: string;
  };
  readonly attemptId: string;
  readonly artifacts: {
    readonly submission: string;
    readonly starter: string;
    readonly privateFiles?: string;
  };
  readonly changes: readonly {
    readonly path: string;
    readonly kind: 'added' | 'modified' | 'deleted';
  }[];
  readonly changedPaths: readonly string[];
  readonly executionVerification:
    | 'judge-executed'
    | JudgeProjectExecutionEvidenceV1['verification'];
  readonly steps: readonly JudgeProjectStepReceipt[];
  readonly observations: readonly JudgeObservation[];
  readonly facts: readonly JudgeFact[];
}

export type JudgeExecutionStatus =
  | 'completed'
  | 'infrastructure-failed'
  | 'cancelled';

export type JudgeTechnicalVerdict =
  | 'passed'
  | 'failed'
  | 'not-evaluated';

export interface JudgeProjectResultV1 {
  readonly execution: JudgeExecutionStatus;
  readonly verdict: JudgeTechnicalVerdict;
  readonly score?: number;
  readonly receipt?: JudgeProjectReceiptV1;
  readonly claims: readonly JudgeProjectClaim[];
  readonly policy?: JudgePolicyEvaluation;
  readonly diagnostics: readonly JudgeDiagnostic[];
}
