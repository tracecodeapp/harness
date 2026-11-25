import assert from 'node:assert/strict';
import test from 'node:test';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import {
  makeTraceKernelHost,
  type TraceKernelRuntimeLeaseReleaseDisposition,
  type TraceKernelFileSystemImage,
  type TraceKernelRuntimeProcessContext,
  type TraceKernelRuntimeProvider,
  type TraceKernelRuntimeResult,
} from '@tracecode/tracekernel';
import {
  evaluateJudgePlan,
  InMemoryJudgeRuntimeControl,
  JudgePlanError,
  type JudgeComparator,
  type JudgeEvaluationPlan,
  type JudgeEvaluationResult,
  type JudgeRuntimeBatchCaseOutput,
  type JudgeRuntimeCaseProgress,
  type JudgeRuntimeInvocationInput,
  type JudgeRuntimeProgressDisposition,
} from '../src/index';
import {
  JUDGE_INVOCATION_ID_ENV,
  TraceKernelJudgePort,
} from '../src/tracekernel';

interface FakeCaseInput {
  readonly value: number;
  readonly delayMs?: number;
  readonly block?: boolean;
  readonly publish?: boolean;
  readonly exitCode?: number;
  readonly trace?: boolean;
  readonly undefinedResult?: boolean;
}

interface FakeProviderState {
  readonly acquired: TraceKernelRuntimeProcessContext[];
  readonly completedCases: string[];
  readonly releases: TraceKernelRuntimeLeaseReleaseDisposition[];
  readonly invocations: JudgeRuntimeInvocationInput[];
  readonly startedBlockingCase: Deferred.Deferred<void>;
}

function fakeProvider(
  control: InMemoryJudgeRuntimeControl,
  state: FakeProviderState
): TraceKernelRuntimeProvider {
  let nextLeaseId = 1;
  return {
    runtime: 'fake',
    initialize: Effect.succeed({
      acquire: (context) =>
        Effect.sync(() => {
          state.acquired.push(context);
          return {
            id: `fake-lease-${nextLeaseId++}`,
            runtime: 'fake',
            execute: () =>
              executeFakeProcess(control, state, context),
            release: (disposition: TraceKernelRuntimeLeaseReleaseDisposition) =>
              Effect.sync(() => {
                state.releases.push(disposition);
              }),
          };
        }),
    }),
  };
}

function executeFakeProcess(
  control: InMemoryJudgeRuntimeControl,
  state: FakeProviderState,
  context: TraceKernelRuntimeProcessContext
): Effect.Effect<TraceKernelRuntimeResult, Error> {
  const invocationId = context.env[JUDGE_INVOCATION_ID_ENV];
  if (!invocationId) {
    return Effect.fail(new Error('Fake provider did not receive a Judge invocation id.'));
  }
  return control.read(invocationId).pipe(
    Effect.flatMap((invocation) => {
      if (invocation.phase === 'compile') {
        if (context.command === 'compile-fail') {
          return control.publish(invocationId, {
            diagnostics: [{
              severity: 'error',
              message: 'expected fake compile error',
              path: '/workspace/solution.fake',
              line: 2,
            }],
          }).pipe(
            Effect.as({
              exitCode: 2,
              stdout: '',
              stderr: 'compile failed\n',
            })
          );
        }
        return control.publish(invocationId, {
          diagnostics: [{
            severity: 'info',
            message: 'compiled by fake runtime',
          }],
          timings: {
            compileMs: 7,
            compileCacheHit: false,
          },
        }).pipe(
          Effect.as({
            exitCode: 0,
            stdout: 'compile stdout\n',
            stderr: '',
          })
        );
      }
      if (invocation.phase === 'batch') {
        state.invocations.push(invocation);
        if (context.command.startsWith('journal-')) {
          return executeFakeJournalBatch(control, invocationId, invocation, context.command);
        }
        return executeFakeBatch(control, invocationId, context.command);
      }
      return executeFakeCase(control, state, invocationId, invocation);
    })
  );
}

const FAKE_PROVIDER_FAILURE = 'The fake runtime failed before it ran any case.';

/**
 * A batch process that ends without per-case outcomes: either it states
 * that the provider failed, or it publishes nothing at all.
 */
function executeFakeBatch(
  control: InMemoryJudgeRuntimeControl,
  invocationId: string,
  command: string
): Effect.Effect<TraceKernelRuntimeResult, Error> {
  const failed = { exitCode: 1, stdout: '', stderr: `${FAKE_PROVIDER_FAILURE}\n` };
  if (command === 'batch-silent-hang') return Effect.never;
  if (command === 'batch-provider-failure') {
    return control.publish(invocationId, {
      diagnostics: [{
        severity: 'error',
        code: 'runtime-provider-error',
        message: FAKE_PROVIDER_FAILURE,
        source: 'fake',
      }],
      failure: {
        origin: 'provider',
        reason: 'runtime-failure',
        message: FAKE_PROVIDER_FAILURE,
      },
    }).pipe(Effect.as(failed));
  }
  return Effect.succeed(failed);
}

/** Every batch invocation a journalling fake ran, with what each record returned. */
const journalRuns: {
  readonly invocationId: string;
  readonly dispositions: JudgeRuntimeProgressDisposition[];
}[] = [];

function fakeFinish(
  caseId: string,
  value: number,
  overrides: Partial<JudgeRuntimeBatchCaseOutput> = {}
): JudgeRuntimeBatchCaseOutput {
  return {
    caseId,
    termination: { kind: 'exit', exitCode: 0 },
    stdout: `learner stdout ${value}\n`,
    stderr: '',
    diagnostics: [],
    timings: { runMs: value },
    value: { doubled: value * 2, caseId },
    timedOut: false,
    ...overrides,
  };
}

const FAKE_RUNAWAY_FAILURE = {
  origin: 'limit',
  reason: 'client-timeout',
  message: 'The fake case ran out of time.',
} as const;

/**
 * A batch that journals per-case progress on the control port, then stops
 * without publishing a terminal batch. Commands:
 * - `journal-hang`: A starts and finishes, B starts, then the runtime hangs.
 * - `journal-duplicate`: as hang, with a second, different finish for A.
 * - `journal-runaway`: A starts and finishes at its own time limit, then hangs.
 * - `journal-protocol`: A finishes, B starts, then the runtime publishes a
 *   protocol failure without a batch.
 */
function executeFakeJournalBatch(
  control: InMemoryJudgeRuntimeControl,
  invocationId: string,
  invocation: JudgeRuntimeInvocationInput,
  command: string
): Effect.Effect<TraceKernelRuntimeResult, Error> {
  const [a, b] = (invocation.cases ?? []).map(({ caseId }) => caseId);
  const run = { invocationId, dispositions: [] as JudgeRuntimeProgressDisposition[] };
  journalRuns.push(run);
  const record = (progress: JudgeRuntimeCaseProgress) =>
    control.record(invocationId, progress).pipe(
      Effect.tap((disposition) => Effect.sync(() => run.dispositions.push(disposition)))
    );
  return Effect.gen(function* () {
    yield* record({ kind: 'started', caseId: a! });
    if (command === 'journal-start-only') return { exitCode: 0, stdout: '', stderr: '' };
    yield* record({
      kind: 'finished',
      output: command === 'journal-runaway' || command === 'journal-after-runaway'
        ? fakeFinish(a!, 1, {
            termination: { kind: 'exit', exitCode: 1 },
            value: undefined,
            timedOut: true,
            diagnostics: [{ severity: 'error', code: 'client-timeout', message: FAKE_RUNAWAY_FAILURE.message }],
            failure: FAKE_RUNAWAY_FAILURE,
          })
        : fakeFinish(a!, 1),
    });
    if (command === 'journal-runaway') return yield* Effect.never;
    if (command === 'journal-after-runaway') {
      // C is reported after A's runaway; a stopping batch never ran it.
      const c = (invocation.cases ?? [])[2]!.caseId;
      yield* record({ kind: 'started', caseId: c });
      yield* record({ kind: 'finished', output: fakeFinish(c, 3) });
      return yield* Effect.never;
    }
    if (command === 'journal-short') {
      // A terminal batch that lists only A, beside A's accepted finish.
      yield* control.publish(invocationId, { diagnostics: [], batch: [fakeFinish(a!, 1)] });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'journal-duplicate') {
      yield* record({ kind: 'finished', output: fakeFinish(a!, 999) });
    }
    yield* record({ kind: 'started', caseId: b! });
    if (command === 'journal-teardown') {
      // While the watchdog kills it, the runtime reports a finish for B.
      return yield* Effect.never.pipe(Effect.onInterrupt(() =>
        record({ kind: 'finished', output: fakeFinish(b!, 2) }).pipe(Effect.asVoid)
      ));
    }
    if (command === 'journal-protocol') {
      yield* control.publish(invocationId, {
        diagnostics: [{ severity: 'error', code: 'runtime-provider-error', message: 'malformed reply', source: 'fake' }],
        failure: { origin: 'provider', reason: 'protocol', message: 'malformed reply' },
      });
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    return yield* Effect.never;
  });
}

function executeFakeCase(
  control: InMemoryJudgeRuntimeControl,
  state: FakeProviderState,
  invocationId: string,
  invocation: JudgeRuntimeInvocationInput
): Effect.Effect<TraceKernelRuntimeResult, Error> {
  const input = invocation.value as FakeCaseInput;
  state.invocations.push(invocation);
  if (input.block) {
    return Deferred.succeed(state.startedBlockingCase, undefined).pipe(
      Effect.andThen(Effect.never)
    );
  }
  return Effect.sleep(input.delayMs ?? 0).pipe(
    Effect.andThen(
      input.publish === false
        ? Effect.void
        : control.publish(invocationId, {
            value: input.undefinedResult
              ? undefined
              : {
                  doubled: input.value * 2,
                  caseId: invocation.caseId,
                },
            ...(input.trace
              ? {
                  trace: {
                    events: [{
                      kind: 'line',
                      line: 1,
                    }],
                  },
                }
              : {}),
            diagnostics: [{
              severity: 'info',
              message: `observed ${input.value}`,
              source: 'fake-runtime',
            }],
            timings: {
              runMs: input.value,
              artifactCacheHit: true,
            },
          })
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        state.completedCases.push(invocation.caseId ?? 'unknown');
      })
    ),
    Effect.as({
      exitCode: input.exitCode ?? 0,
      stdout: `learner stdout ${input.value}\n`,
      stderr: input.exitCode ? 'learner runtime error\n' : '',
    })
  );
}

function makePlan<Expected = unknown>(
  cases: readonly FakeCaseInput[],
  overrides: Partial<JudgeEvaluationPlan<FakeCaseInput, Expected>> = {}
): JudgeEvaluationPlan<FakeCaseInput, Expected> {
  return {
    id: 'fake-evaluation',
    runtime: 'fake',
    workspace: {
      cwd: '/workspace',
      files: [{
        path: '/workspace/solution.fake',
        contents: 'learner source',
        visibility: 'submission',
      }],
    },
    driver: {
      files: [{
        path: '/.tracecode/judge/driver.fake',
        contents: 'private generated driver',
        visibility: 'judge-private',
      }],
    },
    compile: {
      command: 'compile',
      args: ['/.tracecode/judge/driver.fake'],
    },
    run: {
      command: 'run',
      timeoutMs: 1_000,
    },
    cases: cases.map((input, index) => ({
      id: `case-${index + 1}`,
      input,
    })),
    isolation: {
      mode: 'fresh-session-per-case',
      maxConcurrency: 3,
    },
    ...overrides,
  };
}

function makeState(): Effect.Effect<FakeProviderState> {
  return Deferred.make<void>().pipe(
    Effect.map((startedBlockingCase) => ({
      acquired: [],
      completedCases: [],
      releases: [],
      invocations: [],
      startedBlockingCase,
    }))
  );
}

test('runs compile and cases as protected TraceKernel processes with ordered isolated results', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });

      const result = yield* evaluateJudgePlan<
        TraceKernelFileSystemImage,
        FakeCaseInput,
        { readonly doubled: number; readonly caseId: string }
      >(
        port,
        makePlan([
          { value: 1, delayMs: 35 },
          { value: 2, delayMs: 5 },
          { value: 3, delayMs: 15 },
        ])
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.compile?.status, 'compiled');
      assert.deepEqual(result.compile?.timings, {
        compileMs: 7,
        compileCacheHit: false,
      });
      assert.deepEqual(
        result.cases.map((caseResult) => caseResult.caseId),
        ['case-1', 'case-2', 'case-3'],
        'Concurrent completion must not reorder case results.'
      );
      assert.deepEqual(
        result.cases.map((caseResult) => caseResult.value?.doubled),
        [2, 4, 6]
      );
      assert.notDeepEqual(
        state.completedCases,
        ['case-1', 'case-2', 'case-3'],
        'The fixture must actually complete out of order.'
      );
      assert.ok(
        result.cases.every((caseResult) =>
          caseResult.stdout.startsWith('learner stdout')
        ),
        'Learner stdout must remain learner output.'
      );
      assert.ok(
        result.cases.every((caseResult) =>
          caseResult.diagnostics[0]?.source === 'fake-runtime'
        ),
        'Structured diagnostics must arrive on the control port.'
      );
      assert.deepEqual(
        result.cases.map((caseResult) => caseResult.timings),
        [
          { runMs: 1, artifactCacheHit: true },
          { runMs: 2, artifactCacheHit: true },
          { runMs: 3, artifactCacheHit: true },
        ],
        'Provider timing metadata must survive Judge orchestration.'
      );

      const caseSessionIds = result.cases.map((caseResult) =>
        caseResult.sessionId
      );
      assert.equal(
        new Set(caseSessionIds).size,
        result.cases.length,
        'Every case must run in a fresh TraceKernel session.'
      );
      assert.ok(
        !caseSessionIds.includes(result.compile!.sessionId),
        'Cases must not reuse the mutable compile session.'
      );
      assert.equal(state.acquired.length, 4);
      assert.ok(
        state.acquired.every(
          (context) => context.runtimeSyscalls.profile === 'algorithm'
        ),
        'Every Judge runtime lease must be told that it has algorithm-only authority.'
      );
      const deniedRuntimeProcessList = yield* state.acquired[0]!.syscalls.dispatch({
        op: 'processList',
      });
      assert.deepEqual(
        deniedRuntimeProcessList,
        {
          ok: false,
          error: {
            code: 'EOPNOTSUPP',
            message:
              'EOPNOTSUPP: TraceKernel algorithm profile does not expose the processList syscall',
          },
        },
        'Judge must supervise through host APIs without giving the runtime process authority.'
      );
      assert.equal(state.releases.length, 4);
      assert.ok(
        state.releases.every((release) =>
          release.kind === 'destroy' &&
          release.reason === 'unvalidated'
        ),
        'Ephemeral fake runtime leases must be destroyed after every process.'
      );
      assert.equal(control.activeInvocationCount(), 0);
      assert.deepEqual(host.sessionIds(), []);
    })
  ));
});

test('mounts submission and private driver files into the kernel snapshot without exposing them in results', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const image = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* port.openSession();
          yield* session.mount(makePlan([{ value: 1 }]).workspace.files);
          yield* session.mount(makePlan([{ value: 1 }]).driver.files);
          return yield* session.snapshot();
        })
      );
      const paths = image.entries.map((entry) => entry.path);
      assert.ok(paths.includes('/workspace/solution.fake'));
      assert.ok(paths.includes('/.tracecode/judge/driver.fake'));

      const result = yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1 }])
      );
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes('private generated driver'));
      assert.ok(!serialized.includes('/.tracecode/judge/driver.fake'));
      assert.deepEqual(host.sessionIds(), []);
    })
  ));
});

test('constructs positive, negative, and missing-expected verdicts from raw runtime values', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const result = yield* evaluateJudgePlan<
        TraceKernelFileSystemImage,
        FakeCaseInput,
        { readonly doubled: number; readonly caseId: string },
        { readonly doubled: number; readonly caseId: string }
      >(
        port,
        makePlan(
          [
            { value: 2 },
            { value: 3 },
            { value: 4 },
          ],
          {
            compile: undefined,
            cases: [
              {
                id: 'matching',
                input: { value: 2 },
                expected: {
                  doubled: 4,
                  caseId: 'matching',
                },
              },
              {
                id: 'mismatching',
                input: { value: 3 },
                expected: {
                  doubled: 999,
                  caseId: 'mismatching',
                },
              },
              {
                id: 'execution-only',
                input: { value: 4 },
              },
            ],
          }
        )
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.cases[0]?.status, 'completed');
      assert.equal(result.cases[0]?.verdict.kind, 'passed');
      assert.equal(
        result.cases[0]?.verdict.kind === 'passed'
          ? result.cases[0].verdict.comparatorId
          : undefined,
        'structural-json'
      );
      assert.equal(result.cases[1]?.status, 'completed');
      assert.equal(result.cases[1]?.verdict.kind, 'failed');
      assert.equal(result.cases[2]?.status, 'completed');
      assert.deepEqual(result.cases[2]?.verdict, {
        kind: 'not-evaluated',
        reason: 'expected-not-provided',
      });
      assert.ok(
        state.invocations.every((invocation) =>
          !Object.prototype.hasOwnProperty.call(invocation, 'expected') &&
          !Object.prototype.hasOwnProperty.call(invocation, 'verdict')
        ),
        'Runtime providers must receive only invocation inputs, never Judge policy.'
      );
    })
  ));
});

test('preserves traced and non-traced raw outcomes while constructing identical verdicts', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const result = yield* evaluateJudgePlan<
        TraceKernelFileSystemImage,
        FakeCaseInput,
        { readonly doubled: number; readonly caseId: string },
        { readonly doubled: number; readonly caseId: string }
      >(
        port,
        makePlan([], {
          compile: undefined,
          cases: [
            {
              id: 'plain',
              input: { value: 5 },
              expected: {
                doubled: 10,
                caseId: 'plain',
              },
            },
            {
              id: 'traced',
              input: { value: 5, trace: true },
              expected: {
                doubled: 10,
                caseId: 'traced',
              },
            },
          ],
        })
      );

      assert.equal(result.status, 'completed');
      assert.deepEqual(
        result.cases.map((caseResult) => caseResult.verdict.kind),
        ['passed', 'passed']
      );
      assert.equal(result.cases[0] && 'trace' in result.cases[0], false);
      assert.deepEqual(result.cases[1]?.trace, {
        events: [{
          kind: 'line',
          line: 1,
        }],
      });
    })
  ));
});

test('accepts a product comparator without exposing it to the runtime provider', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const comparator: JudgeComparator<
        FakeCaseInput,
        { readonly doubled: number },
        { readonly doubled: number; readonly caseId: string }
      > = {
        id: 'doubled-value',
        compare: ({ actual, expected }) => ({
          matched: actual.doubled === expected.doubled,
        }),
      };
      const result = yield* evaluateJudgePlan<
        TraceKernelFileSystemImage,
        FakeCaseInput,
        { readonly doubled: number; readonly caseId: string },
        { readonly doubled: number }
      >(
        port,
        makePlan([], {
          compile: undefined,
          cases: [{
            id: 'custom',
            input: { value: 6 },
            expected: {
              doubled: 12,
            },
          }],
        }),
        { comparator }
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.cases[0]?.verdict.kind, 'passed');
      assert.equal(
        result.cases[0]?.verdict.kind === 'passed'
          ? result.cases[0].verdict.comparatorId
          : undefined,
        'doubled-value'
      );
      assert.ok(
        state.invocations.every((invocation) =>
          !Object.prototype.hasOwnProperty.call(invocation, 'comparator')
        )
      );
    })
  ));
});

test('stops before cases and preserves structured diagnostics when compilation fails', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const result = yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1 }], {
          compile: {
            command: 'compile-fail',
          },
        })
      );

      assert.equal(result.status, 'compile-failed');
      assert.equal(result.compile.status, 'compile-failed');
      assert.equal(result.compile.termination.kind, 'exit');
      assert.equal(result.compile.diagnostics[0]?.message, 'expected fake compile error');
      // A compile process that ran and failed without publishing an origin is
      // the submitted program's compile stage.
      assert.equal(result.compile.failure.origin, 'program');
      assert.equal(
        result.compile.failure.origin === 'program' ? result.compile.failure.stage : undefined,
        'compile'
      );
      assert.deepEqual(result.cases, []);
      assert.equal(state.acquired.length, 1);
      assert.equal(control.activeInvocationCount(), 0);
      assert.deepEqual(host.sessionIds(), []);
    })
  ));
});

test('reports a protocol error when a successful runtime omits its structured result', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const result = yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1, publish: false }], {
          compile: undefined,
        })
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.cases[0]?.status, 'protocol-error');
      assert.match(
        result.cases[0]?.protocolError ?? '',
        /without publishing a structured Judge result/
      );
      // The runtime finished without its result: the provider's protocol
      // failure, stated explicitly rather than left to optional fields.
      assert.deepEqual(result.cases[0]?.failure, {
        origin: 'provider',
        reason: 'protocol',
        message:
          'The runtime completed successfully without publishing a structured Judge result.',
      });
      assert.equal(control.activeInvocationCount(), 0);
    })
  ));
});

test('accepts an explicitly published undefined result under the required policy', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const result = yield* evaluateJudgePlan<
        TraceKernelFileSystemImage,
        FakeCaseInput,
        undefined,
        undefined
      >(
        port,
        makePlan<undefined>([], {
          compile: undefined,
          cases: [{
            id: 'undefined-result',
            input: {
              value: 1,
              undefinedResult: true,
            },
            expected: undefined,
          }],
        })
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.cases[0]?.status, 'completed');
      assert.equal(result.cases[0]?.verdict.kind, 'passed');
      assert.equal(
        Object.prototype.hasOwnProperty.call(result.cases[0], 'value'),
        true
      );
      assert.equal(result.cases[0]?.value, undefined);
      assert.equal(control.activeInvocationCount(), 0);
    })
  ));
});

test('a backstop watchdog is the provider failure, never a time limit', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const result = yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1, block: true }], {
          compile: undefined,
          run: {
            command: 'run',
            timeoutMs: 20,
            timeoutRole: 'backstop',
          },
        })
      );

      assert.equal(result.status, 'completed');
      const stopped = result.cases[0]!;
      assert.equal(stopped.status, 'runtime-error');
      assert.equal(stopped.timedOut, false);
      assert.equal(stopped.termination.kind, 'signal');
      assert.equal(stopped.failure?.origin, 'provider');
      assert.equal(
        stopped.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.code,
        'runtime-provider-error'
      );
      assert.equal(control.activeInvocationCount(), 0);
      assert.deepEqual(host.sessionIds(), []);
    })
  ));
});

test('reports TraceKernel watchdog termination as a timed-out case', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const result = yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1, block: true }], {
          compile: undefined,
          run: {
            command: 'run',
            timeoutMs: 20,
          },
        })
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.cases[0]?.status, 'timed-out');
      assert.equal(result.cases[0]?.timedOut, true);
      assert.equal(result.cases[0]?.termination.kind, 'signal');
      assert.equal(result.cases[0]?.failure?.origin, 'limit');
      assert.equal(
        result.cases[0]?.failure?.origin === 'limit' ? result.cases[0].failure.reason : undefined,
        'client-timeout'
      );
      assert.equal(state.releases.length, 1);
      assert.deepEqual(state.releases[0], {
        kind: 'destroy',
        reason: 'interrupted',
      });
      assert.equal(control.activeInvocationCount(), 0);
      assert.deepEqual(host.sessionIds(), []);
    })
  ));
});

test('interrupting evaluation kills the active kernel process and cleans its lease and session', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      const fiber = yield* Effect.fork(
        evaluateJudgePlan(
          port,
          makePlan([{ value: 1, block: true }], {
            compile: undefined,
          })
        )
      );
      yield* Deferred.await(state.startedBlockingCase);
      yield* Fiber.interrupt(fiber);

      assert.equal(state.releases.length, 1);
      assert.deepEqual(state.releases[0], {
        kind: 'destroy',
        reason: 'interrupted',
      });
      assert.equal(control.activeInvocationCount(), 0);
      assert.deepEqual(host.sessionIds(), []);
    })
  ));
});

test('rejects private driver files outside the reserved Judge namespace', async () => {
  const control = new InMemoryJudgeRuntimeControl();
  const exit = await Effect.runPromiseExit(Effect.scoped(
    Effect.gen(function* () {
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      return yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1 }], {
          driver: {
            files: [{
              path: '/workspace/visible-driver.fake',
              contents: 'not private',
              visibility: 'judge-private',
            }],
          },
        })
      );
    })
  ));
  assert.equal(exit._tag, 'Failure');
  if (exit._tag === 'Failure') {
    const error = exit.cause.toString();
    assert.match(error, /must live below/);
    assert.match(error, new RegExp(JudgePlanError.name));
  }
});

test('rejects invalid trace selections before compiling the workspace', async () => {
  const control = new InMemoryJudgeRuntimeControl();
  const state = await Effect.runPromise(makeState());
  const exit = await Effect.runPromiseExit(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      return yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1 }]),
        { tracing: { caseIds: ['missing-case'] } }
      );
    })
  ));

  assert.equal(exit._tag, 'Failure');
  if (exit._tag === 'Failure') {
    assert.match(exit.cause.toString(), /unknown case id "missing-case"/);
  }
  assert.equal(state.invocations.length, 0, 'invalid tracing must not compile');
  assert.equal(state.acquired.length, 0, 'invalid tracing must not acquire a runtime');
});

test('rejects non-canonical file aliases before duplicate and namespace checks', async () => {
  const control = new InMemoryJudgeRuntimeControl();
  const exit = await Effect.runPromiseExit(Effect.scoped(
    Effect.gen(function* () {
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      return yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1 }], {
          workspace: {
            cwd: '/workspace',
            files: [
              {
                path: '/workspace/solution.fake',
                contents: 'canonical',
                visibility: 'submission',
              },
              {
                path: '/workspace/./solution.fake',
                contents: 'alias',
                visibility: 'submission',
              },
            ],
          },
        })
      );
    })
  ));
  assert.equal(exit._tag, 'Failure');
  if (exit._tag === 'Failure') {
    assert.match(exit.cause.toString(), /canonical absolute file path/);
  }
});

test('rejects per-case environment overrides in provider-isolated batches', async () => {
  const control = new InMemoryJudgeRuntimeControl();
  const exit = await Effect.runPromiseExit(Effect.scoped(
    Effect.gen(function* () {
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({
        host,
        runtimeControl: control,
      });
      return yield* evaluateJudgePlan(
        port,
        makePlan([], {
          compile: undefined,
          cases: [{
            id: 'environment-dependent',
            input: { value: 1 },
            env: { CASE_SEED: 'one' },
          }],
          isolation: {
            mode: 'provider-isolated-batch',
          },
        })
      );
    })
  ));
  assert.equal(exit._tag, 'Failure');
  if (exit._tag === 'Failure') {
    assert.match(
      exit.cause.toString(),
      /must not define per-case environment variables/
    );
    assert.match(exit.cause.toString(), new RegExp(JudgePlanError.name));
  }
});

test('a batch the provider failed before publishing any case makes every case the provider failure', async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({ host, runtimeControl: control });
      const result = yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1 }, { value: 2 }], {
          compile: undefined,
          run: { command: 'batch-provider-failure', timeoutMs: 1_000 },
          isolation: { mode: 'provider-isolated-batch' },
        })
      );
      assert.equal(result.status, 'completed');
      if (result.status !== 'completed') return;
      assert.equal(result.cases.length, 2);
      for (const judged of result.cases) {
        assert.equal(judged.status, 'runtime-error');
        assert.equal(judged.timedOut, false);
        assert.deepEqual(judged.failure, {
          origin: 'provider',
          reason: 'runtime-failure',
          message: FAKE_PROVIDER_FAILURE,
        });
      }
    })
  ));
});

test('a batch that publishes neither cases nor a provider failure is still a malformed runtime', async () => {
  const exit = await Effect.runPromiseExit(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({
        providers: [fakeProvider(control, state)],
      });
      const port = new TraceKernelJudgePort({ host, runtimeControl: control });
      return yield* evaluateJudgePlan(
        port,
        makePlan([{ value: 1 }, { value: 2 }], {
          compile: undefined,
          run: { command: 'batch-silent', timeoutMs: 1_000 },
          isolation: { mode: 'provider-isolated-batch' },
        })
      );
    })
  ));
  assert.equal(exit._tag, 'Failure');
  if (exit._tag === 'Failure') {
    assert.match(exit.cause.toString(), /JudgeInfrastructureError/);
    assert.match(exit.cause.toString(), /without publishing per-case outcomes/);
  }
});

test('B8 ledger: the core Judge validates a trace selection but never asks a runtime to record', async () => {
  for (const variant of [
    { label: 'per-case', overrides: {}, stopAtFirstRunaway: false },
    { label: 'per-case stopping', overrides: {}, stopAtFirstRunaway: true },
    {
      label: 'provider batch',
      overrides: {
        compile: undefined,
        run: { command: 'batch-provider-failure', timeoutMs: 1_000 },
        isolation: { mode: 'provider-isolated-batch' as const },
      },
      stopAtFirstRunaway: false,
    },
  ]) {
    const state = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const control = new InMemoryJudgeRuntimeControl();
        const state = yield* makeState();
        const host = yield* makeTraceKernelHost({ providers: [fakeProvider(control, state)] });
        const port = new TraceKernelJudgePort({ host, runtimeControl: control });
        yield* evaluateJudgePlan(port, makePlan([{ value: 1 }, { value: 2 }], variant.overrides), {
          tracing: { caseIds: ['case-1'] },
          stopAtFirstRunaway: variant.stopAtFirstRunaway,
        });
        return state;
      })
    ));
    assert.ok(state.invocations.length > 0, `${variant.label}: the runtime was invoked`);
    for (const invocation of state.invocations) {
      assert.equal(Object.hasOwn(invocation, 'recordTrace'), false, `${variant.label}: no recordTrace on ${invocation.phase}`);
      for (const entry of invocation.cases ?? []) {
        assert.equal(Object.hasOwn(entry, 'recordTrace'), false, `${variant.label}: no recordTrace on batch case`);
      }
    }
  }
});

function journalPlan(command: string, run: Partial<JudgeEvaluationPlan['run']> = {}) {
  return makePlan([{ value: 1 }, { value: 2 }, { value: 3 }], {
    compile: undefined,
    run: { command, timeoutMs: 60, timeoutRole: 'backstop', ...run },
    isolation: { mode: 'provider-isolated-batch' },
  });
}

function evaluateJournalled(
  plan: JudgeEvaluationPlan<FakeCaseInput>,
  stopAtFirstRunaway = false
) {
  return Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const control = new InMemoryJudgeRuntimeControl();
      const state = yield* makeState();
      const host = yield* makeTraceKernelHost({ providers: [fakeProvider(control, state)] });
      const port = new TraceKernelJudgePort({ host, runtimeControl: control });
      const result = yield* evaluateJudgePlan(port, plan, { stopAtFirstRunaway });
      assert.equal(control.activeInvocationCount(), 0);
      const run = journalRuns.at(-1)!;
      return { result, control, run };
    })
  ));
}

function assertServiceFailure(
  row: JudgeEvaluationResult['cases'][number] | undefined,
  reason: 'runtime-failure' | 'protocol',
  uncertain: boolean,
  notStarted = !uncertain
) {
  assert.ok(row);
  assert.equal(row.status, 'runtime-error', `${row.caseId}: status`);
  assert.equal(row.timedOut, false, `${row.caseId}: no time limit`);
  assert.equal(row.verdict.kind, 'not-evaluated', `${row.caseId}: no learner verdict`);
  assert.equal(row.failure?.origin, 'provider', `${row.caseId}: provider origin`);
  assert.equal(row.failure?.origin === 'provider' ? row.failure.reason : undefined, reason);
  assert.equal(Object.hasOwn(row, 'value'), false, `${row.caseId}: no value`);
  assert.equal(row.notRun, undefined);
  assert.equal(
    /completion is uncertain/u.test(row.failure?.message ?? ''),
    uncertain,
    `${row.caseId}: completion uncertainty is stated only for a started case`
  );
  assert.equal(
    /As far as the runtime reported, the case had not started\./u.test(row.failure?.message ?? ''),
    notStarted,
    `${row.caseId}: a case whose start was never accepted says so, in a batch that acknowledges starts`
  );
  const error = row.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  assert.equal(error?.message, row.failure?.message, `${row.caseId}: the diagnostic states the same failure`);
  assert.equal(error?.code, 'runtime-provider-error');
  assert.ok(
    !row.diagnostics.some((diagnostic) => diagnostic.code === 'client-timeout'),
    `${row.caseId}: no client-timeout diagnostic`
  );
}

test('D-WATCH: a batch watchdog with no published outcomes is the provider failure, never client-timeout on every case', async () => {
  for (const timeoutRole of ['limit', 'backstop'] as const) {
    const { result } = await evaluateJournalled(makePlan([{ value: 1, block: true }, { value: 2 }], {
      compile: undefined,
      run: { command: 'batch-silent-hang', timeoutMs: 40, timeoutRole },
      isolation: { mode: 'provider-isolated-batch' },
    }));
    assert.equal(result.status, 'completed');
    assert.equal(result.cases.length, 2);
    for (const row of result.cases) {
      assert.equal(row.status, 'runtime-error', `${timeoutRole} ${row.caseId}: status`);
      assert.equal(row.timedOut, false, `${timeoutRole} ${row.caseId}: timedOut`);
      assert.equal(row.failure?.origin, 'provider', `${timeoutRole} ${row.caseId}: origin`);
      assert.ok(!row.diagnostics.some((diagnostic) => diagnostic.code === 'client-timeout'));
    }
  }
});

test('D-WATCH: a backstop after A\'s accepted finish publishes A unchanged and the rest as provider failures', async () => {
  const { result, run } = await evaluateJournalled(journalPlan('journal-hang'));
  assert.deepEqual(run.dispositions, ['accepted', 'accepted', 'accepted']);
  assert.equal(result.status, 'completed');
  const [a, b, c] = result.cases;
  assert.equal(a?.caseId, 'case-1');
  assert.equal(a?.status, 'completed');
  assert.deepEqual(a?.value, { doubled: 2, caseId: 'case-1' });
  assert.equal(a?.stdout, 'learner stdout 1\n');
  assert.deepEqual(a?.timings, { runMs: 1 });
  assertServiceFailure(b, 'runtime-failure', true);
  assertServiceFailure(c, 'runtime-failure', false);
  assert.match(b!.failure!.message, /did not finish within its own deadline/u);
});

test('D-WATCH: a late finish from the killed generation is fenced and changes nothing', async () => {
  const { result, control, run } = await evaluateJournalled(journalPlan('journal-hang'));
  const late = await Effect.runPromise(control.record(run.invocationId, {
    kind: 'finished',
    output: fakeFinish('case-1', 999),
  }));
  assert.equal(late, 'fenced');
  const lateB = await Effect.runPromise(control.record(run.invocationId, {
    kind: 'finished',
    output: fakeFinish('case-2', 2),
  }));
  assert.equal(lateB, 'fenced');
  assert.deepEqual(result.cases[0]?.value, { doubled: 2, caseId: 'case-1' });
  assert.equal(result.cases[1]?.status, 'runtime-error');
});

test('D-WATCH: a duplicate finish is rejected and the first accepted finish stands', async () => {
  const { result, run } = await evaluateJournalled(journalPlan('journal-duplicate'));
  assert.deepEqual(run.dispositions, ['accepted', 'accepted', 'duplicate', 'accepted']);
  assert.deepEqual(result.cases[0]?.value, { doubled: 2, caseId: 'case-1' });
  assertServiceFailure(result.cases[1], 'runtime-failure', true);
});

test('D-WATCH: a runtime may not forge a journal through publish', async () => {
  const control = new InMemoryJudgeRuntimeControl();
  const id = await Effect.runPromise(control.begin({
    phase: 'batch', planId: 'p', cases: [{ caseId: 'case-1', value: 1 }],
  }));
  await Effect.runPromise(control.publish(id, {
    diagnostics: [],
    journal: { started: ['case-1'], finished: [fakeFinish('case-1', 7)] },
  } as never));
  const output = await Effect.runPromise(control.take(id));
  assert.equal(output?.journal, undefined);
});

test('D-WATCH: progress is checked against the batch it belongs to', async () => {
  const control = new InMemoryJudgeRuntimeControl();
  const id = await Effect.runPromise(control.begin({
    phase: 'batch', planId: 'p', cases: [{ caseId: 'A', value: 1 }, { caseId: 'B', value: 2 }],
  }));
  const record = (progress: JudgeRuntimeCaseProgress) => Effect.runPromise(control.record(id, progress));
  assert.equal(await record({ kind: 'started', caseId: 'Z' }), 'unknown-case');
  assert.equal(await record({ kind: 'started', caseId: 'A' }), 'accepted');
  assert.equal(await record({ kind: 'started', caseId: 'A' }), 'duplicate');
  assert.equal(await record({ kind: 'finished', output: fakeFinish('B', 2) }), 'out-of-order');
  assert.equal(await record({ kind: 'finished', output: fakeFinish('A', 1) }), 'accepted');
  assert.equal(await record({ kind: 'started', caseId: 'A' }), 'duplicate');
  const caseId = await Effect.runPromise(control.begin({ phase: 'case', planId: 'p', caseId: 'A', value: 1 }));
  assert.equal(
    await Effect.runPromise(control.record(caseId, { kind: 'started', caseId: 'A' })),
    'unknown-case',
    'only batch invocations keep a journal'
  );
  await Effect.runPromise(control.publish(id, { diagnostics: [] }));
  assert.equal(await record({ kind: 'started', caseId: 'B' }), 'fenced', 'publication seals the journal');
});

test('D-WATCH: a stopping batch whose accepted prefix ends at a runaway keeps its not-run suffix when the backstop fires', async () => {
  const { result } = await evaluateJournalled(journalPlan('journal-runaway'), true);
  const [a, b, c] = result.cases;
  assert.equal(a?.status, 'timed-out');
  assert.equal(a?.failure?.origin, 'limit');
  for (const row of [b, c]) {
    assert.equal(row?.status, 'not-run');
    assert.deepEqual(row?.notRun, {
      reason: 'run-stopped-after-limit',
      stoppedByCaseId: 'case-1',
      limit: 'client-timeout',
    });
  }
});

test('D-WATCH: without stopping, a runaway in the accepted prefix does not excuse the suffix', async () => {
  const { result } = await evaluateJournalled(journalPlan('journal-runaway'), false);
  assert.equal(result.cases[0]?.failure?.origin, 'limit');
  assertServiceFailure(result.cases[1], 'runtime-failure', false);
  assertServiceFailure(result.cases[2], 'runtime-failure', false);
});

test('D-WATCH: a provider failure published after an accepted finish keeps the prefix and its own reason', async () => {
  const { result } = await evaluateJournalled(journalPlan('journal-protocol', { timeoutMs: 1_000 }));
  assert.equal(result.cases[0]?.status, 'completed');
  assert.deepEqual(result.cases[0]?.value, { doubled: 2, caseId: 'case-1' });
  assertServiceFailure(result.cases[1], 'protocol', true);
  assertServiceFailure(result.cases[2], 'protocol', false);
  // Joined sentences keep their full stops.
  assert.equal(result.cases[1]?.failure?.message,
    'malformed reply. The case had started, and its completion is uncertain.');
  assert.equal(result.cases[2]?.failure?.message,
    'malformed reply. As far as the runtime reported, the case had not started.');
});

test('D-WATCH: a short terminal batch beside an accepted finish keeps that finish and fails the rest as protocol', async () => {
  const { result } = await evaluateJournalled(journalPlan('journal-short', { timeoutMs: 1_000 }));
  assert.equal(result.status, 'completed');
  assert.equal(result.cases[0]?.status, 'completed');
  assert.deepEqual(result.cases[0]?.value, { doubled: 2, caseId: 'case-1' });
  assertServiceFailure(result.cases[1], 'protocol', false);
  assertServiceFailure(result.cases[2], 'protocol', false);
  assert.match(result.cases[1]!.failure!.message, /returned 1 unique cases for 3 planned cases/u);
});

test('D-WATCH: a batch that exits after an accepted start and no reply is the provider failure, not a malformed runtime', async () => {
  const { result } = await evaluateJournalled(journalPlan('journal-start-only', { timeoutMs: 1_000 }));
  assert.equal(result.status, 'completed');
  assertServiceFailure(result.cases[0], 'protocol', true);
  assertServiceFailure(result.cases[1], 'protocol', false);
});

test('D-WATCH: in a stopping batch, a finish accepted after the runaway stays not-run', async () => {
  const { result } = await evaluateJournalled(journalPlan('journal-after-runaway'), true);
  assert.equal(result.cases[0]?.failure?.origin, 'limit');
  for (const row of result.cases.slice(1)) {
    assert.equal(row.status, 'not-run', `${row.caseId}: after the runaway`);
    assert.equal(Object.hasOwn(row, 'value'), false);
  }
});

test('D-WATCH: a finish recorded while the watchdog kills the batch is not graded', async () => {
  const { result, run } = await evaluateJournalled(journalPlan('journal-teardown'));
  assert.deepEqual(result.cases[0]?.value, { doubled: 2, caseId: 'case-1' });
  assertServiceFailure(result.cases[1], 'runtime-failure', true);
  assert.equal(run.dispositions.at(-1), 'fenced', 'the teardown finish was refused');
});
