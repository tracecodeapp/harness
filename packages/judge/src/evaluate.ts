import * as Effect from 'effect/Effect';
import {
  constructJudgeVerdict,
  structuralJsonComparator,
  type JudgeCaseVerdict,
  type JudgeComparator,
} from './comparison';
import {
  JudgeInfrastructureError,
  JudgePlanError,
} from './errors';
import type {
  JudgeCaseResult,
  JudgeCasePlan,
  JudgeCompileResult,
  JudgeDiagnostic,
  JudgeFailure,
  JudgeLimitReason,
  JudgeNotRun,
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
  JudgeRuntimeBatchCaseOutput,
  JudgeRuntimeInvocationInput,
} from './port';
import { validateJudgePlan } from './validate';
import { validateTraceSelection } from './internal/trace-selection';

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

const BACKSTOP_TIMEOUT_MESSAGE =
  'The runtime did not finish within its own deadline, so the Judge stopped it.';

/**
 * A backstop watchdog fired: the runtime did not honour its own limits. That
 * is the provider's failure; the outcome carries no time limit of its own.
 */
function backstopTimeoutOutcome(
  outcome: JudgeKernelProcessOutcome
): JudgeKernelProcessOutcome {
  return Object.freeze({
    ...outcome,
    timedOut: false,
    backstopTimedOut: true,
    diagnostics: Object.freeze([
      ...(outcome.diagnostics ?? []).filter((diagnostic) => diagnostic.severity !== 'error'),
      Object.freeze({
        severity: 'error' as const,
        code: 'runtime-provider-error',
        message: BACKSTOP_TIMEOUT_MESSAGE,
      }),
    ]),
    failure: Object.freeze({
      origin: 'provider' as const,
      reason: 'runtime-failure' as const,
      message: BACKSTOP_TIMEOUT_MESSAGE,
    }),
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
        Effect.map((outcome) =>
          outcome.timedOut && processPlan.timeoutRole === 'backstop'
            ? backstopTimeoutOutcome(outcome)
            : outcome
        ),
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

function firstErrorDiagnostic(
  outcome: JudgeKernelProcessOutcome
): JudgeDiagnostic | undefined {
  const diagnostics = outcome.diagnostics ?? [];
  return diagnostics.find((diagnostic) => diagnostic.severity === 'error') ??
    diagnostics[0];
}

/**
 * Whose failure a process that did not succeed reports.
 *
 * The runtime adapter states it on the published output, and that is
 * authoritative. A process that publishes nothing is judged by its own
 * termination: the Judge watchdog stopping it is the time limit; a process the
 * kernel could not run is the provider's; a process that ran and exited
 * unsuccessfully is the submitted program (in a Judge plan the process is the
 * learner's program).
 */
function processFailure(
  outcome: JudgeKernelProcessOutcome,
  programStage: 'compile' | 'runtime'
): JudgeFailure {
  const diagnostic = firstErrorDiagnostic(outcome);
  if (outcome.timedOut) {
    return Object.freeze({
      origin: 'limit',
      reason: 'client-timeout',
      message: WATCHDOG_TIMEOUT_DIAGNOSTIC.message,
    });
  }
  if (outcome.failure) return outcome.failure;
  if (outcome.termination.kind === 'failure') {
    return Object.freeze({
      origin: 'provider',
      reason: 'runtime-failure',
      message: outcome.termination.message,
    });
  }
  const exitDescription = outcome.termination.kind === 'signal'
    ? `The program was stopped by ${outcome.termination.signal}.`
    : `The program exited with status ${outcome.termination.exitCode}.`;
  return Object.freeze({
    origin: 'program',
    stage: programStage,
    message: diagnostic?.message || outcome.stderr.trim() || exitDescription,
    ...(diagnostic?.line === undefined ? {} : { line: diagnostic.line }),
  });
}

function compileResult(
  outcome: JudgeKernelProcessOutcome
): JudgeCompileResult {
  const base = processResult(outcome);
  if (outcome.timedOut) {
    return Object.freeze({
      ...base,
      status: 'timed-out' as const,
      failure: processFailure(outcome, 'compile'),
    });
  }
  if (outcome.termination.kind === 'exit' && outcome.termination.exitCode === 0) {
    return Object.freeze({ ...base, status: 'compiled' as const });
  }
  return Object.freeze({
    ...base,
    status: 'compile-failed' as const,
    failure: processFailure(outcome, 'compile'),
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

/**
 * The Judge's own watchdog stopped the process: the program did not finish
 * within its time limit. Reported as the limit, never as an infrastructure
 * failure, whether or not the runtime got to publish anything first.
 */
const WATCHDOG_TIMEOUT_DIAGNOSTIC = Object.freeze({
  severity: 'error' as const,
  code: 'client-timeout',
  message:
    'Execution timed out. This may indicate an infinite loop or very expensive execution.',
});

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
      ...(base.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
        ? {}
        : { diagnostics: Object.freeze([...base.diagnostics, WATCHDOG_TIMEOUT_DIAGNOSTIC]) }),
      ...expected,
      ...trace,
      caseId: testCase.id,
      status: 'timed-out',
      failure: processFailure(outcome, 'runtime'),
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
      failure: processFailure(outcome, 'runtime'),
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
      // A runtime adapter reports a learner program that ended early (exit(0)
      // and the like) as the program's failure. Reaching here means the
      // runtime itself finished without its result: the provider's.
      failure: Object.freeze({
        origin: 'provider' as const,
        reason: 'protocol' as const,
        message:
          'The runtime completed successfully without publishing a structured Judge result.',
      }),
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

export interface JudgePreparedWorkspace<Snapshot> {
  readonly snapshot?: Snapshot;
  readonly compile?: JudgeCompileResult;
}

function buildWorkspace<Snapshot>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan
): Effect.Effect<JudgePreparedWorkspace<Snapshot>, JudgeInfrastructureError> {
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

const RUNAWAY_LIMITS: ReadonlySet<string> = new Set([
  'client-timeout',
  'line-limit',
  'single-line-limit',
]);

/** The limit that stopped a case, when it was a time or line limit. */
export function runawayLimitOf(
  result: JudgeCaseResult<unknown, unknown>
): JudgeLimitReason | undefined {
  return result.failure?.origin === 'limit' && RUNAWAY_LIMITS.has(result.failure.reason)
    ? result.failure.reason
    : undefined;
}

function notRunResult<Result, Expected>(
  testCase: JudgeCasePlan<unknown, Expected>,
  notRun: JudgeNotRun,
  process: JudgeProcessResult
): JudgeCaseResult<Result, Expected> {
  return Object.freeze({
    ...process,
    ...expectedFields(testCase),
    caseId: testCase.id,
    status: 'not-run' as const,
    verdict: notEvaluated('case-did-not-complete'),
    notRun: Object.freeze({ ...notRun }),
  });
}

/** Run semantics without a provider batch: one case at a time, stopping at the first runaway. */
function runCasesUntilRunaway<Snapshot, Input, Expected, Result>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan<Input, Expected>,
  snapshot: Snapshot,
  comparator: JudgeComparator<Input, Expected, Result>
): Effect.Effect<readonly JudgeCaseResult<Result, Expected>[], JudgeInfrastructureError> {
  return Effect.gen(function* () {
    const results: JudgeCaseResult<Result, Expected>[] = [];
    let stoppedBy: { readonly caseId: string; readonly limit: JudgeLimitReason } | undefined;
    for (const testCase of plan.cases) {
      if (stoppedBy) {
        const last = results[results.length - 1]!;
        results.push(notRunResult<Result, Expected>(
          testCase as JudgeCasePlan<unknown, Expected>,
          { reason: 'run-stopped-after-limit', stoppedByCaseId: stoppedBy.caseId, limit: stoppedBy.limit },
          {
            sessionId: last.sessionId,
            pid: last.pid,
            termination: Object.freeze({ kind: 'exit' as const, exitCode: 0 }),
            stdout: '',
            stderr: '',
            diagnostics: Object.freeze([]),
            timedOut: false,
          }
        ));
        continue;
      }
      const result = yield* runCase<Snapshot, Input, Expected, Result>(
        port,
        plan,
        snapshot,
        testCase,
        comparator
      );
      results.push(result);
      const limit = runawayLimitOf(result as JudgeCaseResult<unknown, unknown>);
      if (limit) stoppedBy = { caseId: testCase.id, limit };
    }
    return results;
  });
}

function runBatch<Snapshot, Input, Expected, Result>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan<Input, Expected>,
  snapshot: Snapshot,
  comparator: JudgeComparator<Input, Expected, Result>,
  stopAtFirstRunaway = false
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
          ...(stopAtFirstRunaway ? { stopAtFirstRunaway: true } : {}),
          cases: Object.freeze(
            plan.cases.map((testCase) => Object.freeze({
              caseId: testCase.id,
              value: testCase.input,
            }))
          ),
        }
      );
      if (!outcome.batch && (
        outcome.timedOut ||
        outcome.backstopTimedOut ||
        outcome.failure?.origin === 'provider' ||
        outcome.journal !== undefined
      )) {
        // The batch ended without per-case outcomes: a watchdog stopped it,
        // the provider failed it, or it ended without its terminal reply.
        // A batch-wide clock is the service's, never a case's own time
        // limit, so no time limit is fabricated. Each finish the control
        // port accepted is published unchanged; every other case is the
        // provider's failure.
        return serviceStoppedBatch<Input, Expected, Result>(
          plan,
          outcome,
          comparator,
          stopAtFirstRunaway
        );
      }
      if (!outcome.batch) {
        // Neither per-case outcomes nor a provider failure: a malformed runtime.
        return yield* Effect.fail(new JudgeInfrastructureError({
          operation: 'execute isolated batch',
          message:
            'The runtime batch process completed without publishing per-case outcomes.' +
            (outcome.stderr ? ` ${outcome.stderr.trim()}` : ''),
        }));
      }
      const byId = new Map(outcome.batch.map((item) => [item.caseId, item]));
      const omitted = plan.cases.find((testCase) => !byId.has(testCase.id));
      const malformed = byId.size !== plan.cases.length
        ? `The runtime batch returned ${byId.size} unique cases for ` +
          `${plan.cases.length} planned cases.`
        : omitted
          ? `The runtime batch omitted case ${JSON.stringify(omitted.id)}.`
          : undefined;
      if (malformed && outcome.journal) {
        // A malformed terminal batch is the provider's protocol failure. The
        // journal's accepted progress still stands; the terminal rows do not.
        return serviceStoppedBatch<Input, Expected, Result>(
          plan,
          protocolFailureOutcome(outcome, malformed),
          comparator,
          stopAtFirstRunaway
        );
      }
      if (malformed) {
        return yield* Effect.fail(new JudgeInfrastructureError({
          operation: 'execute isolated batch',
          message: malformed,
        }));
      }
      return Object.freeze(plan.cases.map((testCase) =>
        batchItemResult<Input, Expected, Result>(
          plan,
          testCase,
          outcome,
          byId.get(testCase.id)!,
          comparator
        )
      ));
    })
  );
}

/** One per-case batch outcome as a case result. */
function batchItemResult<Input, Expected, Result>(
  plan: JudgeEvaluationPlan<Input, Expected>,
  testCase: JudgeEvaluationPlan<Input, Expected>['cases'][number],
  outcome: JudgeKernelProcessOutcome,
  item: JudgeRuntimeBatchCaseOutput,
  comparator: JudgeComparator<Input, Expected, Result>
): JudgeCaseResult<Result, Expected> {
  if (item.notRun) {
    return notRunResult<Result, Expected>(testCase, item.notRun, {
      sessionId: outcome.sessionId,
      pid: outcome.pid,
      termination: item.termination,
      stdout: item.stdout,
      stderr: item.stderr,
      diagnostics: Object.freeze([...(item.diagnostics ?? [])]),
      timedOut: false,
      ...(outcome.startedAt === undefined ? {} : { startedAt: outcome.startedAt }),
      ...(outcome.endedAt === undefined ? {} : { endedAt: outcome.endedAt }),
    });
  }
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
      ...(item.failure ? { failure: item.failure } : {}),
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
    },
    plan.structuredResult ?? 'required',
    comparator
  );
}

const COMPLETION_UNCERTAIN =
  'The case had started, and its completion is uncertain.';

/** The journal knows only that no start was accepted for the case. */
const NOT_STARTED = 'As far as the runtime reported, the case had not started.';

/** Join two sentences, giving the first its full stop when it lacks one. */
function joinSentences(first: string, second: string): string {
  const head = first.trimEnd();
  if (head === '') return second;
  return /[.!?]$/u.test(head) ? `${head} ${second}` : `${head}. ${second}`;
}

function protocolFailureOutcome(
  outcome: JudgeKernelProcessOutcome,
  message: string
): JudgeKernelProcessOutcome {
  const { batch: _batch, ...process } = outcome;
  return Object.freeze({
    ...process,
    diagnostics: Object.freeze([Object.freeze({
      severity: 'error' as const,
      code: 'runtime-provider-error',
      message,
    })]),
    failure: Object.freeze({ origin: 'provider' as const, reason: 'protocol' as const, message }),
  });
}

const UNFINISHED_BATCH_MESSAGE =
  'The runtime batch ended without its result.';

/**
 * The provider's failure for an unpublished batch: the failure it
 * published, the watchdog that stopped it, or a batch that ended without
 * its terminal reply.
 */
function unfinishedBatchFailure(outcome: JudgeKernelProcessOutcome): JudgeKernelProcessOutcome {
  if (outcome.failure?.origin === 'provider') return outcome;
  if (outcome.timedOut || outcome.backstopTimedOut) return backstopTimeoutOutcome(outcome);
  return protocolFailureOutcome(outcome, UNFINISHED_BATCH_MESSAGE);
}

/**
 * Rows for a batch that ended without per-case outcomes. Every accepted
 * finish stands as delivered. In a stopping batch, the cases after an
 * accepted runaway were never going to run, so they stay not-run. Every
 * other case is the provider's failure, never a limit or a verdict; one
 * whose start was accepted says its completion is uncertain, and in a batch
 * that acknowledges starts, one that never started says so.
 */
function serviceStoppedBatch<Input, Expected, Result>(
  plan: JudgeEvaluationPlan<Input, Expected>,
  outcome: JudgeKernelProcessOutcome,
  comparator: JudgeComparator<Input, Expected, Result>,
  stopAtFirstRunaway: boolean
): readonly JudgeCaseResult<Result, Expected>[] {
  const failed = unfinishedBatchFailure(outcome);
  const failure = failed.failure as Extract<JudgeFailure, { origin: 'provider' }>;
  const finished = new Map(
    (outcome.journal?.finished ?? []).map((item) => [item.caseId, item])
  );
  const started = new Set(outcome.journal?.started ?? []);
  const rows: JudgeCaseResult<Result, Expected>[] = [];
  let stoppedBy: Omit<JudgeNotRun, 'reason'> | undefined;
  for (const testCase of plan.cases) {
    const item = finished.get(testCase.id);
    // After an accepted runaway a stopping batch runs nothing more, so a
    // later finish cannot be graded either.
    if (stoppedBy) {
      rows.push(notRunResult<Result, Expected>(
        testCase as JudgeCasePlan<unknown, Expected>,
        { reason: 'run-stopped-after-limit', ...stoppedBy },
        {
          sessionId: outcome.sessionId,
          pid: outcome.pid,
          termination: Object.freeze({ kind: 'exit' as const, exitCode: 0 }),
          stdout: '',
          stderr: '',
          diagnostics: Object.freeze([]),
          timedOut: false,
        }
      ));
      continue;
    }
    if (item) {
      const row = batchItemResult<Input, Expected, Result>(plan, testCase, outcome, item, comparator);
      rows.push(row);
      const limit = runawayLimitOf(row as JudgeCaseResult<unknown, unknown>);
      if (stopAtFirstRunaway && limit && !stoppedBy) stoppedBy = { stoppedByCaseId: testCase.id, limit };
      continue;
    }
    // A batch that acknowledges starts tells a case that started and never
    // finished apart from one that never started. Without start
    // acknowledgements nothing is claimed about which.
    const message = started.has(testCase.id)
      ? joinSentences(failure.message, COMPLETION_UNCERTAIN)
      : started.size > 0
        ? joinSentences(failure.message, NOT_STARTED)
        : failure.message;
    const errorDiagnostic = (failed.diagnostics ?? []).find((diagnostic) => diagnostic.severity === 'error');
    const {
      structuredResult: _value,
      trace: _trace,
      batch: _batch,
      journal: _journal,
      ...process
    } = failed;
    rows.push(caseResult<Input, Expected, Result>(
      plan.id,
      testCase,
      {
        ...process,
        // A case that did not finish ran no learner verdict, whatever exit
        // status the process reported.
        termination: process.termination.kind === 'exit' && process.termination.exitCode === 0
          ? Object.freeze({ kind: 'failure' as const, exitCode: 1, message })
          : process.termination,
        // Only what the case published belongs to it. A case without an
        // accepted finish published nothing.
        ...(finished.size > 0 ? { stdout: '', stderr: '' } : {}),
        timedOut: false,
        diagnostics: Object.freeze([
          ...(failed.diagnostics ?? []).filter((diagnostic) => diagnostic.severity !== 'error'),
          Object.freeze({
            ...(errorDiagnostic ?? { severity: 'error' as const, code: 'runtime-provider-error' }),
            message,
          }),
        ]),
        failure: Object.freeze({ ...failure, message }),
      },
      plan.structuredResult ?? 'required',
      comparator
    ));
  }
  return Object.freeze(rows);
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
    yield* validateTraceSelection(plan, options.tracing);
    const build = yield* prepareJudgePlan(port, plan);
    return yield* evaluatePreparedJudgePlan(port, plan, build, options);
  });
}

/** Compile and snapshot a Judge plan without executing any cases. */
export function prepareJudgePlan<Snapshot>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan
): Effect.Effect<
  JudgePreparedWorkspace<Snapshot>,
  JudgePlanError | JudgeInfrastructureError
> {
  return validateJudgePlan(plan).pipe(
    Effect.andThen(buildWorkspace(port, plan))
  );
}

/** Execute cases from an already compiled Judge workspace. */
export function evaluatePreparedJudgePlan<
  Snapshot,
  Input = unknown,
  Result = unknown,
  Expected = unknown,
>(
  port: JudgeKernelPort<Snapshot>,
  plan: JudgeEvaluationPlan<Input, Expected>,
  build: JudgePreparedWorkspace<Snapshot>,
  options: JudgeEvaluationOptions<Input, Expected, Result> = {}
): Effect.Effect<
  JudgeEvaluationResult<Result, Expected>,
  JudgePlanError | JudgeInfrastructureError
> {
  return Effect.gen(function* () {
    yield* validateJudgePlan(plan);
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
    // A selection is validated, never sent: runtimes grade, they do not
    // record. Drawings come from a separate observer bound to these rows.
    yield* validateTraceSelection(plan, options.tracing);
    const cases = plan.isolation?.mode === 'provider-isolated-batch'
      ? yield* runBatch<Snapshot, Input, Expected, Result>(
          port,
          plan,
          build.snapshot,
          comparator,
          options.stopAtFirstRunaway === true
        )
      : options.stopAtFirstRunaway === true
        ? yield* runCasesUntilRunaway<Snapshot, Input, Expected, Result>(
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
