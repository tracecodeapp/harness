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
  type JudgeEvaluationPlan,
  type JudgeRuntimeInvocationInput,
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
}

interface FakeProviderState {
  readonly acquired: TraceKernelRuntimeProcessContext[];
  readonly completedCases: string[];
  readonly releases: TraceKernelRuntimeLeaseReleaseDisposition[];
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
        }).pipe(
          Effect.as({
            exitCode: 0,
            stdout: 'compile stdout\n',
            stderr: '',
          })
        );
      }
      return executeFakeCase(control, state, invocationId, invocation);
    })
  );
}

function executeFakeCase(
  control: InMemoryJudgeRuntimeControl,
  state: FakeProviderState,
  invocationId: string,
  invocation: JudgeRuntimeInvocationInput
): Effect.Effect<TraceKernelRuntimeResult, Error> {
  const input = invocation.value as FakeCaseInput;
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
            value: {
              doubled: input.value * 2,
              caseId: invocation.caseId,
            },
            diagnostics: [{
              severity: 'info',
              message: `observed ${input.value}`,
              source: 'fake-runtime',
            }],
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

function makePlan(
  cases: readonly FakeCaseInput[],
  overrides: Partial<JudgeEvaluationPlan<FakeCaseInput>> = {}
): JudgeEvaluationPlan<FakeCaseInput> {
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
      assert.equal(control.activeInvocationCount(), 0);
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
