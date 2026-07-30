import * as Effect from 'effect/Effect';
import type {
  JudgeInfrastructureError,
  JudgePlanError,
} from './errors';
import { evaluateJudgePlan } from './evaluate';
import type {
  JudgeAlgorithmBundle,
  JudgeAlgorithmEvaluationOptions,
  JudgeAlgorithmReceipt,
  JudgeAlgorithmVerdict,
} from './algorithm-model';
import { ALGORITHM_RECEIPT_SCHEMA } from './algorithm-model';
import type { JudgeKernelPort } from './port';
import { evaluateJudgeVerdictPolicy } from './policy';
import { createJudgeComparator } from './comparator-strategy';
import { validateAlgorithmJudgeBundle } from './algorithm-validate';

export function algorithmJudgePolicyValues(
  evaluation: JudgeAlgorithmReceipt['evaluation']
): Readonly<Record<string, unknown>> {
  const cases = evaluation.cases.map((testCase) =>
    Object.freeze({
      id: testCase.caseId,
      status: testCase.status,
      passed: testCase.verdict.kind === 'passed',
      verdict: testCase.verdict.kind,
      timedOut: testCase.timedOut,
    })
  );
  const compileSucceeded =
    evaluation.status !== 'compile-failed' &&
    (evaluation.compile === undefined || evaluation.compile.status === 'compiled');
  const passedCount = cases.filter((testCase) => testCase.passed).length;
  return Object.freeze({
    status: evaluation.status,
    compileSucceeded,
    cases: Object.freeze(cases),
    allCasesPassed:
      compileSucceeded &&
      cases.length > 0 &&
      passedCount === cases.length,
    passedCount,
    totalCount: cases.length,
  });
}

function verdictFromPolicy(
  result: true | false | 'unknown'
): JudgeAlgorithmVerdict {
  return result === true
    ? 'passed'
    : result === false
      ? 'failed'
      : 'indeterminate';
}

export function evaluateAlgorithmJudgeBundle<
  Snapshot,
  Input extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
  Expected = unknown,
>(
  port: JudgeKernelPort<Snapshot>,
  bundle: JudgeAlgorithmBundle<Input, Expected, Result>,
  options: JudgeAlgorithmEvaluationOptions<Input, Expected, Result> = {}
): Effect.Effect<
  JudgeAlgorithmReceipt<Result, Expected>,
  JudgePlanError | JudgeInfrastructureError
> {
  return Effect.gen(function* () {
    yield* validateAlgorithmJudgeBundle(bundle);
    const evaluation = yield* evaluateJudgePlan<
      Snapshot,
      Input,
      Result,
      Expected
    >(
      port,
      bundle.plan,
      {
        comparator:
          options.comparator ??
          (
            bundle.comparison
              ? createJudgeComparator(bundle.comparison)
              : undefined
          ),
      }
    );
    return createAlgorithmJudgeReceipt(
      bundle,
      evaluation,
      options.evaluatedAt
    );
  });
}

export function createAlgorithmJudgeReceipt<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
  Expected = unknown,
>(
  bundle: JudgeAlgorithmBundle<Input, Expected, Result>,
  evaluation: JudgeAlgorithmReceipt<Result, Expected>['evaluation'],
  evaluatedAt = new Date().toISOString()
): JudgeAlgorithmReceipt<Result, Expected> {
  const values = algorithmJudgePolicyValues(evaluation);
  const policy = evaluateJudgeVerdictPolicy(
    bundle.policy,
    {
      workspaceDigest: bundle.workspaceDigest,
      facts: bundle.facts,
      values,
    }
  );
  return Object.freeze({
    schema: ALGORITHM_RECEIPT_SCHEMA,
    bundleId: bundle.id,
    workspaceDigest: bundle.workspaceDigest,
    evaluation,
    policy,
    verdict: verdictFromPolicy(policy.result),
    passedCount: values.passedCount as number,
    totalCount: values.totalCount as number,
    evaluatedAt,
  });
}

export function allCasesPassPolicy(): JudgeAlgorithmBundle['policy'] {
  return Object.freeze({
    schema: 'tracecode.judge.verdict-policy.v1',
    passWhen: Object.freeze({
      op: 'eq',
      left: Object.freeze({ op: 'ref', path: 'allCasesPassed' }),
      right: Object.freeze({ op: 'literal', value: true }),
    }),
  });
}
