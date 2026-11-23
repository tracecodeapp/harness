import type { Cut, Drawing, Refusal } from '../../../runtime-contracts/src/runtime-calls';
import type { JudgeAlgorithmReceipt } from '../algorithm-model';
import type { JudgeCaseResult, JudgeEvaluationResult } from '../model';

export type { Cut, Drawing, Refusal };

export type Frozen<T> = T extends object
  ? { readonly [K in keyof T]: Frozen<T[K]> }
  : T;

export type OrdinaryRow<T> = T extends unknown ? Omit<T, 'trace' | 'attachment'> : never;

export type Row<Result = unknown, Expected = unknown> =
  Frozen<OrdinaryRow<JudgeCaseResult<Result, Expected>>>;

export type Binding = Readonly<{
  evaluationId: string;
  workspaceDigest: string;
  caseId: string;
  generation: number;
}>;

export type VerdictReceipt<Result = unknown, Expected = unknown> = Frozen<
  Omit<JudgeAlgorithmReceipt<Result, Expected>, 'evaluation'> & {
    evaluation:
      | Extract<JudgeEvaluationResult<Result, Expected>, { status: 'compile-failed' }>
      | (Omit<
          Extract<JudgeEvaluationResult<Result, Expected>, { status: 'completed' }>,
          'cases'
        > & { cases: readonly Row<Result, Expected>[] });
  }
>;

export type Attachment = Frozen<Binding & Drawing>;
