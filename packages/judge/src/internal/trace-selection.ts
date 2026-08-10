import * as Effect from 'effect/Effect';
import { JudgePlanError } from '../errors';
import type { JudgeEvaluationPlan } from '../model';

export function validateTraceSelection(
  plan: JudgeEvaluationPlan,
  tracing: { readonly caseIds: readonly string[] } | undefined
): Effect.Effect<ReadonlySet<string> | undefined, JudgePlanError> {
  if (tracing === undefined) return Effect.succeed(undefined);
  const known = new Set(plan.cases.map((testCase) => testCase.id));
  const selected = new Set<string>();
  for (const caseId of tracing.caseIds) {
    if (selected.has(caseId)) {
      return Effect.fail(new JudgePlanError({
        message: `Judge tracing contains duplicate case id ${JSON.stringify(caseId)}.`,
      }));
    }
    if (!known.has(caseId)) {
      return Effect.fail(new JudgePlanError({
        message: `Judge tracing references unknown case id ${JSON.stringify(caseId)}.`,
      }));
    }
    selected.add(caseId);
  }
  return Effect.succeed(selected);
}
