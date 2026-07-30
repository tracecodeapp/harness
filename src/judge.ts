/**
 * Public browser Judge authority.
 *
 * Runtime provider registration and the browser runtime host are implementation
 * details. Consumers own one BrowserJudgeHost, optionally warm a selected
 * language, and create scoped Judge evaluations through that authority.
 */
export {
  createBrowserJudgeHost,
  evaluateJudgePlan,
  structuralJsonComparator,
} from './internal/browser-judge';

export type {
  BrowserJudgeCppOptions,
  BrowserJudgeCSharpOptions,
  BrowserJudgeExecutionHostOptions,
  BrowserJudgeHost,
  BrowserJudgeJavaOptions,
  BrowserJudgePythonOptions,
  CreateBrowserJudgeHostOptions,
  CreateBrowserJudgeOptions,
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
  RuntimeJudge,
  RuntimeJudgeBinding,
  RuntimeJudgeCodeBinding,
  RuntimeJudgeTraceBinding,
} from './internal/browser-judge';
