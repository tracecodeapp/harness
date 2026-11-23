import * as Effect from 'effect/Effect';
import { JudgePlanError } from '../errors';
import type { JudgeEvaluationPlan } from '../model';

export function validateTraceSelection(
  plan: JudgeEvaluationPlan,
  tracing: { readonly caseIds: readonly string[] } | undefined,
  label = 'Judge tracing'
): Effect.Effect<ReadonlySet<string> | undefined, JudgePlanError> {
  if (tracing === undefined) return Effect.succeed(undefined);
  const known = new Set(plan.cases.map((testCase) => testCase.id));
  const selected = new Set<string>();
  for (const caseId of tracing.caseIds) {
    if (selected.has(caseId)) {
      return Effect.fail(new JudgePlanError({
        message: `${label} contains duplicate case id ${JSON.stringify(caseId)}.`,
      }));
    }
    if (!known.has(caseId)) {
      return Effect.fail(new JudgePlanError({
        message: `${label} references unknown case id ${JSON.stringify(caseId)}.`,
      }));
    }
    selected.add(caseId);
  }
  return Effect.succeed(selected);
}

export function validateTraceContinuation(
  plan: JudgeEvaluationPlan,
  tracing: { readonly caseIds: readonly string[] }
): Effect.Effect<readonly string[], JudgePlanError> {
  const caseIds = [...tracing.caseIds];
  if (caseIds.length === 0) {
    return Effect.fail(new JudgePlanError({
      message: 'Interactive tracing requires at least one retained case id.',
    }));
  }
  return validateTraceSelection(plan, { caseIds }, 'Interactive tracing').pipe(Effect.as(caseIds));
}
