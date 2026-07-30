export interface JudgeComparisonInput<
  Input = unknown,
  Expected = unknown,
  Actual = unknown,
> {
  readonly planId: string;
  readonly caseId: string;
  readonly input: Input;
  readonly expected: Expected;
  readonly actual: Actual;
}

export interface JudgeComparisonResult {
  readonly matched: boolean;
  readonly message?: string;
  /**
   * Comparator-owned, presentation-neutral information that a product may use
   * to explain a mismatch. Judge does not interpret this value.
   */
  readonly details?: unknown;
}

/**
 * Pure expected-value policy.
 *
 * Runtime providers never receive a comparator and never publish a verdict.
 * They publish raw values; Judge invokes this contract after a case process
 * completes successfully.
 */
export interface JudgeComparator<
  Input = unknown,
  Expected = unknown,
  Actual = unknown,
> {
  readonly id: string;
  compare(
    input: JudgeComparisonInput<Input, Expected, Actual>
  ): JudgeComparisonResult;
}

function serializeStructuralJson(
  value: unknown,
  label: string
): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not serialize ${label} as structural JSON: ${message}`, {
      cause: error,
    });
  }
}

/**
 * Compatibility comparator for the 0.13 browser and native judge behavior.
 *
 * Equality is intentionally defined by JSON serialization. This preserves the
 * existing array order, object insertion-order, and JSON coercion semantics
 * while the direct runners migrate behind Judge.
 */
export const structuralJsonComparator: JudgeComparator =
  Object.freeze({
    id: 'structural-json',
    compare(input: JudgeComparisonInput): JudgeComparisonResult {
      const actual = serializeStructuralJson(input.actual, 'actual output');
      const expected = serializeStructuralJson(input.expected, 'expected output');
      const matched = actual === expected;
      return Object.freeze({
        matched,
        ...(matched
          ? {}
          : {
              message:
                'The runtime output did not structurally match the expected output.',
            }),
      });
    },
  });

export type JudgeComparedVerdict =
  | {
      readonly kind: 'passed';
      readonly comparatorId: string;
      readonly comparison: JudgeComparisonResult & { readonly matched: true };
    }
  | {
      readonly kind: 'failed';
      readonly comparatorId: string;
      readonly comparison: JudgeComparisonResult & { readonly matched: false };
    }
  | {
      readonly kind: 'comparison-error';
      readonly comparatorId: string;
      readonly message: string;
    };

export type JudgeCaseVerdict =
  | JudgeComparedVerdict
  | {
      readonly kind: 'not-evaluated';
      readonly reason: 'expected-not-provided' | 'case-did-not-complete';
    };

function comparisonErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies a comparator and constructs Judge's value verdict.
 *
 * A comparator defect is represented independently from the runtime outcome:
 * a successfully completed program remains completed even if comparison
 * policy cannot classify its raw value.
 */
export function constructJudgeVerdict<
  Input = unknown,
  Expected = unknown,
  Actual = unknown,
>(
  input: JudgeComparisonInput<Input, Expected, Actual>,
  comparator: JudgeComparator<Input, Expected, Actual> =
    structuralJsonComparator as JudgeComparator<Input, Expected, Actual>
): JudgeComparedVerdict {
  const comparatorId =
    typeof comparator.id === 'string' && comparator.id.trim().length > 0
      ? comparator.id.trim()
      : 'anonymous-comparator';
  try {
    const comparison = comparator.compare(Object.freeze({ ...input }));
    if (!comparison || typeof comparison.matched !== 'boolean') {
      throw new TypeError(
        `Judge comparator ${JSON.stringify(comparatorId)} returned an invalid comparison.`
      );
    }
    const frozenComparison = Object.freeze({ ...comparison });
    return comparison.matched
      ? Object.freeze({
          kind: 'passed',
          comparatorId,
          comparison: frozenComparison as JudgeComparisonResult & {
            readonly matched: true;
          },
        })
      : Object.freeze({
          kind: 'failed',
          comparatorId,
          comparison: frozenComparison as JudgeComparisonResult & {
            readonly matched: false;
          },
        });
  } catch (error) {
    return Object.freeze({
      kind: 'comparison-error',
      comparatorId,
      message: comparisonErrorMessage(error),
    });
  }
}
