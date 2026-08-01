import * as Effect from 'effect/Effect';
import {
  constructJudgeVerdict,
  structuralJsonComparator,
  type JudgeCaseVerdict,
  type JudgeComparator,
} from './comparison';
import {
  JudgeInfrastructureError,
  type JudgePlanError,
} from './errors';
import type {
  JudgeCaseResult,
  JudgeCasePlan,
  JudgeCompileResult,
  JudgeEvaluationOptions,
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
    ...(outcome.timings
      ? { timings: Object.freeze({ ...outcome.timings }) }
      : {}),
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

function notEvaluated(
  reason: 'expected-not-provided' | 'case-did-not-complete'
): JudgeCaseVerdict {
  return Object.freeze({
    kind: 'not-evaluated',
    reason,
  });
}

function expectedFields<Input, Expected>(
  testCase: JudgeCasePlan<Input, Expected>
): { readonly expected?: Expected } {
  return Object.prototype.hasOwnProperty.call(testCase, 'expected')
    ? { expected: testCase.expected }
    : {};
}

function caseResult<Input, Expected, Result>(
  planId: string,
  testCase: JudgeCasePlan<Input, Expected>,
  outcome: JudgeKernelProcessOutcome,
  resultPolicy: 'required' | 'optional',
  comparator: JudgeComparator<Input, Expected, Result>
): JudgeCaseResult<Result, Expected> {
  const base = processResult(outcome);
  const expected = expectedFields(testCase);
  const trace = 'trace' in outcome ? { trace: outcome.trace } : {};
  if (outcome.timedOut) {
    return Object.freeze({
      ...base,
      ...expected,
      ...trace,
      caseId: testCase.id,
      status: 'timed-out',
      verdict: notEvaluated('case-did-not-complete'),
    });
  }
  if (
    outcome.termination.kind !== 'exit' ||
    outcome.termination.exitCode !== 0
  ) {
    return Object.freeze({
      ...base,
      ...expected,
      ...trace,
      caseId: testCase.id,
      status: 'runtime-error',
      verdict: notEvaluated('case-did-not-complete'),
    });
  }
  const structuredResultPublished = Object.prototype.hasOwnProperty.call(
    outcome,
    'structuredResult'
  );
  if (resultPolicy === 'required' && !structuredResultPublished) {
    return Object.freeze({
      ...base,
      ...expected,
      ...trace,
      caseId: testCase.id,
      status: 'protocol-error',
      verdict: notEvaluated('case-did-not-complete'),
      protocolError:
        'The runtime completed successfully without publishing a structured Judge result.',
    });
  }
  const expectedProvided = Object.prototype.hasOwnProperty.call(
    testCase,
    'expected'
  );
  const actual = outcome.structuredResult as Result;
  return Object.freeze({
    ...base,
    ...expected,
    ...trace,
    caseId: testCase.id,
    status: 'completed',
    verdict: expectedProvided
      ? constructJudgeVerdict(
          {
            planId,
            caseId: testCase.id,
            input: testCase.input,
            expected: testCase.expected as Expected,
            actual,
          },
          comparator
        )
      : notEvaluated('expected-not-provided'),
    ...(structuredResultPublished ? { value: actual } : {}),
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

function runCase<Snapshot, Input, Expected, Result>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan<Input, Expected>,
  snapshot: Snapshot,
  testCase: JudgeEvaluationPlan<Input, Expected>['cases'][number],
  comparator: JudgeComparator<Input, Expected, Result>
): Effect.Effect<JudgeCaseResult<Result, Expected>, JudgeInfrastructureError> {
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
      return caseResult<Input, Expected, Result>(
        plan.id,
        testCase,
        outcome,
        plan.structuredResult ?? 'required',
        comparator
      );
    })
  );
}

function runBatch<Snapshot, Input, Expected, Result>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan<Input, Expected>,
  snapshot: Snapshot,
  comparator: JudgeComparator<Input, Expected, Result>
): Effect.Effect<
  readonly JudgeCaseResult<Result, Expected>[],
  JudgeInfrastructureError
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const session = yield* port.openSession({
        cwd: plan.workspace.cwd,
        snapshot,
      }).pipe(
        Effect.mapError((error) =>
          infrastructureError('open isolated batch session', error)
        )
      );
      const outcome = yield* runProcess(
        session,
        plan.runtime,
        plan.run,
        {
          phase: 'batch',
          planId: plan.id,
          cases: Object.freeze(
            plan.cases.map((testCase) => Object.freeze({
              caseId: testCase.id,
              value: testCase.input,
            }))
          ),
        }
      );
      if (!outcome.batch) {
        return yield* Effect.fail(new JudgeInfrastructureError({
          operation: 'execute isolated batch',
          message:
            'The runtime batch process completed without publishing per-case outcomes.' +
            (outcome.stderr ? ` ${outcome.stderr.trim()}` : ''),
        }));
      }
      const byId = new Map(outcome.batch.map((item) => [item.caseId, item]));
      if (byId.size !== plan.cases.length) {
        return yield* Effect.fail(new JudgeInfrastructureError({
          operation: 'execute isolated batch',
          message:
            `The runtime batch returned ${byId.size} unique cases for ` +
            `${plan.cases.length} planned cases.`,
        }));
      }
      const omitted = plan.cases.find((testCase) => !byId.has(testCase.id));
      if (omitted) {
        return yield* Effect.fail(new JudgeInfrastructureError({
          operation: 'execute isolated batch',
          message:
            `The runtime batch omitted case ${JSON.stringify(omitted.id)}.`,
        }));
      }
      return Object.freeze(plan.cases.map((testCase) => {
        const item = byId.get(testCase.id)!;
        return caseResult<Input, Expected, Result>(
          plan.id,
          testCase,
          {
            sessionId: outcome.sessionId,
            pid: outcome.pid,
            termination: item.termination,
            stdout: item.stdout,
            stderr: item.stderr,
            diagnostics: item.diagnostics,
            timings: item.timings,
            ...(Object.prototype.hasOwnProperty.call(item, 'value')
              ? { structuredResult: item.value }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(item, 'trace')
              ? { trace: item.trace }
              : {}),
            timedOut: item.timedOut,
            startedAt: outcome.startedAt,
            endedAt: outcome.endedAt,
          },
          plan.structuredResult ?? 'required',
          comparator
        );
      }));
    })
  );
}

export function evaluateJudgePlan<
  Snapshot,
  Input = unknown,
  Result = unknown,
  Expected = unknown,
>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan<Input, Expected>,
  options: JudgeEvaluationOptions<Input, Expected, Result> = {}
): Effect.Effect<
  JudgeEvaluationResult<Result, Expected>,
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

    const comparator =
      options.comparator ??
      structuralJsonComparator as JudgeComparator<Input, Expected, Result>;
    const cases = plan.isolation?.mode === 'provider-isolated-batch'
      ? yield* runBatch<Snapshot, Input, Expected, Result>(
          port,
          plan,
          build.snapshot,
          comparator
        )
      : yield* Effect.forEach(
          plan.cases,
          (testCase) =>
            runCase<Snapshot, Input, Expected, Result>(
              port,
              plan,
              build.snapshot!,
              testCase,
              comparator
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
