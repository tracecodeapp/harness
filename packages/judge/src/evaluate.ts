import * as Effect from 'effect/Effect';
import {
  JudgeInfrastructureError,
  type JudgePlanError,
} from './errors';
import type {
  JudgeCaseResult,
  JudgeCompileResult,
  JudgeEvaluationPlan,
  JudgeEvaluationResult,
  JudgeProcessResult,
} from './model';
import type {
  JudgeKernelPort,
  JudgeKernelProcess,
  JudgeKernelProcessOutcome,
  JudgeKernelSession,
  JudgeRuntimeInvocationInput,
} from './port';
import { validateJudgePlan } from './validate';

function infrastructureError(
  operation: string,
  error: unknown
): JudgeInfrastructureError {
  return new JudgeInfrastructureError({
    operation,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

function runProcess<Snapshot>(
  session: JudgeKernelSession<Snapshot>,
  runtime: string,
  processPlan: JudgeEvaluationPlan['run'],
  invocation: JudgeRuntimeInvocationInput
): Effect.Effect<JudgeKernelProcessOutcome, JudgeInfrastructureError> {
  return session.spawn({
    runtime,
    process: processPlan,
    invocation,
  }).pipe(
    Effect.mapError((error) => infrastructureError('spawn process', error)),
    Effect.flatMap((process: JudgeKernelProcess) =>
      process.wait().pipe(
        Effect.mapError((error) => infrastructureError('wait for process', error)),
        Effect.onInterrupt(() =>
          process.signal('SIGKILL').pipe(
            Effect.catchAll(() => Effect.void)
          )
        )
      )
    )
  );
}

function processResult(
  outcome: JudgeKernelProcessOutcome
): JudgeProcessResult {
  return Object.freeze({
    sessionId: outcome.sessionId,
    pid: outcome.pid,
    termination: outcome.termination,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    diagnostics: Object.freeze([...(outcome.diagnostics ?? [])]),
    timedOut: outcome.timedOut,
    ...(outcome.startedAt === undefined ? {} : { startedAt: outcome.startedAt }),
    ...(outcome.endedAt === undefined ? {} : { endedAt: outcome.endedAt }),
  });
}

function compileResult(
  outcome: JudgeKernelProcessOutcome
): JudgeCompileResult {
  const base = processResult(outcome);
  return Object.freeze({
    ...base,
    status: outcome.timedOut
      ? 'timed-out'
      : (
          outcome.termination.kind === 'exit' &&
          outcome.termination.exitCode === 0
        )
        ? 'compiled'
        : 'compile-failed',
  });
}

function caseResult<Result>(
  caseId: string,
  outcome: JudgeKernelProcessOutcome,
  resultPolicy: 'required' | 'optional'
): JudgeCaseResult<Result> {
  const base = processResult(outcome);
  if (outcome.timedOut) {
    return Object.freeze({
      ...base,
      caseId,
      status: 'timed-out',
    });
  }
  if (
    outcome.termination.kind !== 'exit' ||
    outcome.termination.exitCode !== 0
  ) {
    return Object.freeze({
      ...base,
      caseId,
      status: 'runtime-error',
    });
  }
  if (
    resultPolicy === 'required' &&
    outcome.structuredResult === undefined
  ) {
    return Object.freeze({
      ...base,
      caseId,
      status: 'protocol-error',
      protocolError:
        'The runtime completed successfully without publishing a structured Judge result.',
    });
  }
  return Object.freeze({
    ...base,
    caseId,
    status: 'completed',
    ...(outcome.structuredResult === undefined
      ? {}
      : { value: outcome.structuredResult as Result }),
  });
}

interface BuildWorkspaceResult<Snapshot> {
  readonly snapshot?: Snapshot;
  readonly compile?: JudgeCompileResult;
}

function buildWorkspace<Snapshot>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan
): Effect.Effect<BuildWorkspaceResult<Snapshot>, JudgeInfrastructureError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const session = yield* port.openSession({
        cwd: plan.workspace.cwd,
      }).pipe(
        Effect.mapError((error) => infrastructureError('open build session', error))
      );
      yield* session.mount([
        ...plan.workspace.files,
        ...plan.driver.files,
      ]).pipe(
        Effect.mapError((error) => infrastructureError('mount evaluation workspace', error))
      );

      let compile: JudgeCompileResult | undefined;
      if (plan.compile) {
        const outcome = yield* runProcess(
          session,
          plan.runtime,
          plan.compile,
          {
            phase: 'compile',
            planId: plan.id,
          }
        );
        compile = compileResult(outcome);
        if (compile.status !== 'compiled') {
          return Object.freeze({ compile });
        }
      }

      const snapshot = yield* session.snapshot().pipe(
        Effect.mapError((error) => infrastructureError('snapshot compiled workspace', error))
      );
      return Object.freeze({
        snapshot,
        ...(compile ? { compile } : {}),
      });
    })
  );
}

function runCase<Snapshot, Input, Result>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan<Input>,
  snapshot: Snapshot,
  testCase: JudgeEvaluationPlan<Input>['cases'][number]
): Effect.Effect<JudgeCaseResult<Result>, JudgeInfrastructureError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const session = yield* port.openSession({
        cwd: plan.workspace.cwd,
        snapshot,
      }).pipe(
        Effect.mapError((error) =>
          infrastructureError(`open isolated session for case ${testCase.id}`, error)
        )
      );
      const outcome = yield* runProcess(
        session,
        plan.runtime,
        {
          ...plan.run,
          env: Object.freeze({
            ...(plan.run.env ?? {}),
            ...(testCase.env ?? {}),
          }),
        },
        {
          phase: 'case',
          planId: plan.id,
          caseId: testCase.id,
          value: testCase.input,
        }
      );
      return caseResult<Result>(
        testCase.id,
        outcome,
        plan.structuredResult ?? 'required'
      );
    })
  );
}

export function evaluateJudgePlan<Snapshot, Input = unknown, Result = unknown>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan<Input>
): Effect.Effect<
  JudgeEvaluationResult<Result>,
  JudgePlanError | JudgeInfrastructureError
> {
  return Effect.gen(function* () {
    yield* validateJudgePlan(plan);
    const build = yield* buildWorkspace(port, plan);
    if (build.compile && build.compile.status !== 'compiled') {
      return Object.freeze({
        planId: plan.id,
        status: 'compile-failed' as const,
        compile: build.compile,
        cases: Object.freeze([]) as readonly [],
      });
    }
    if (build.snapshot === undefined) {
      return yield* Effect.fail(new JudgeInfrastructureError({
        operation: 'build workspace',
        message: 'Judge build completed without a reusable workspace snapshot.',
      }));
    }

    const cases = yield* Effect.forEach(
      plan.cases,
      (testCase) =>
        runCase<Snapshot, Input, Result>(
          port,
          plan,
          build.snapshot!,
          testCase
        ),
      {
        concurrency: plan.isolation?.maxConcurrency ?? 1,
      }
    );
    return Object.freeze({
      planId: plan.id,
      status: 'completed' as const,
      ...(build.compile ? { compile: build.compile } : {}),
      cases: Object.freeze(cases),
    });
  });
}
