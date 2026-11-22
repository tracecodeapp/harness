/** Runtime-neutral Judge plans, grading, comparison, and execution outcomes. */
export { evaluateJudgePlan, structuralJsonComparator } from '../packages/judge/src/index';

/**
 * Total conversions from Judge results to the execution outcomes a learner
 * sees. Consumers forward the Harness's classification instead of choosing an
 * origin; a provider failure rejects with `RuntimeProviderError`.
 */
export {
  judgeCaseExecutionOutcome,
  judgeCompileExecutionOutcome,
  type JudgeExecutionOutcomeOptions,
  type JudgeNotRunOutcome,
} from './internal/judge-execution-outcome';
export {
  isRuntimeProviderError,
  RuntimeProviderError,
} from '../packages/runtime-contracts/src/index';

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
} from '../packages/judge/src/index';

export {
  PROJECT_ATTEMPT_SCHEMA,
  PROJECT_BUNDLE_SCHEMA,
  PROJECT_DEFINITION_SCHEMA,
  PROJECT_EXECUTION_EVIDENCE_SCHEMA,
  PROJECT_RECEIPT_SCHEMA,
  behaviorProjectEvaluatorV1,
  builtInProjectEvaluators,
  debuggingProjectEvaluatorV1,
  evaluateJudgeVerdictPolicy,
  evaluateProjectJudgeBundle,
  evaluateProjectJudgeEvidenceBundle,
  evaluateProjectJudgeEvidenceBundlePromise,
  evaluateProjectJudgeEvidenceBundleSync,
  judgeFactMeetsRequirement,
  validateProjectJudgeBundle,
} from '../packages/judge/src/index';

export {
  ALGORITHM_BUNDLE_SCHEMA,
  ALGORITHM_RECEIPT_SCHEMA,
  algorithmSourcePath,
  algorithmWorkspaceDigest,
  allCasesPassPolicy,
  compareJudgeValues,
  createAlgorithmJudgeBundle,
  createAlgorithmJudgeReceipt,
  createJudgeComparator,
  runJudgeCustomValidator,
} from '../packages/judge/src/index';

export type {
  JudgeAlgorithmBundle,
  JudgeAlgorithmLanguage,
  JudgeAlgorithmSourceCase,
  JudgeAlgorithmEvaluationOptions,
  JudgeAlgorithmReceipt,
  JudgeAlgorithmVerdict,
  JudgeComparatorStrategy,
  JudgeComparatorPolicy,
  JudgeCompareMode,
  JudgeCustomValidatorId,
  CreateAlgorithmJudgeBundleOptions,
  UnboundJudgeFact,
} from '../packages/judge/src/index';

export type {
  JudgeArtifactRef,
  JudgeExecutionStatus,
  JudgeFact,
  JudgeFactRequirement,
  JudgeFactSubject,
  JudgeFactVerification,
  JudgePolicyEvaluation,
  JudgeValueExpression,
  JudgeProjectAttemptV1,
  JudgeProjectBundleV1,
  JudgeProjectClaim,
  JudgeProjectClaimStatus,
  JudgeProjectCommandStep,
  JudgeProjectCommandStepReceipt,
  JudgeProjectDefinitionV1,
  JudgeProjectEvaluationOptions,
  JudgeProjectEvaluator,
  JudgeProjectEvaluatorReference,
  JudgeProjectExecutionEvidenceV1,
  JudgeProjectReceiptV1,
  JudgeProjectResultV1,
  JudgeProjectServiceProbeStep,
  JudgeProjectServiceProbeStepReceipt,
  JudgeProjectStep,
  JudgeProjectStepReceipt,
  JudgeProjectWorkspaceView,
  JudgeWeightedScoreDimension,
  JudgeWeightedScorePolicy,
  JudgeTechnicalVerdict,
  JudgeTruth,
  JudgeVerdictPolicy,
  JudgeBooleanExpression,
  JudgeObservation,
  JudgeProcessResult,
} from '../packages/judge/src/index';
