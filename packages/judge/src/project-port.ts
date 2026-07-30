import type * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';
import type {
  JudgeKernelProcess,
  JudgeKernelProcessOutcome,
  JudgeKernelSignal,
} from './port';
import type {
  JudgeProcessPlan,
  JudgeWorkspaceFile,
} from './model';
import type { JudgeObservation } from './project-model';

export interface JudgeProjectProcess extends JudgeKernelProcess {}

export interface JudgeProjectWorkspace<Snapshot> {
  readonly id: string;
  mount(files: readonly JudgeWorkspaceFile[]): Effect.Effect<void, Error>;
  snapshot(): Effect.Effect<Snapshot, Error>;
  run(
    process: JudgeProcessPlan
  ): Effect.Effect<JudgeProjectProcess, Error>;
  observations(): Effect.Effect<readonly JudgeObservation[], Error>;
}

export interface JudgeProjectPort<Snapshot> {
  openWorkspace(options?: {
    readonly cwd?: string;
    readonly snapshot?: Snapshot;
  }): Effect.Effect<JudgeProjectWorkspace<Snapshot>, Error, Scope.Scope>;
}

export interface JudgeProjectArtifactResolver {
  resolve(
    artifact: import('./project-model').JudgeArtifactRef
  ): Effect.Effect<readonly JudgeWorkspaceFile[], Error>;
}

export interface JudgeProjectEvaluator {
  readonly kind: string;
  readonly version: number;
  evaluate(input: {
    readonly config: unknown;
    readonly receipt: import('./project-model').JudgeProjectReceiptV1;
  }): Effect.Effect<
    readonly import('./project-model').JudgeProjectClaim[],
    Error
  >;
}

export interface JudgeProjectEvaluationOptions {
  readonly artifactResolver?: JudgeProjectArtifactResolver;
  readonly evaluators?: readonly JudgeProjectEvaluator[];
}

export type {
  JudgeKernelProcessOutcome,
  JudgeKernelSignal,
};
