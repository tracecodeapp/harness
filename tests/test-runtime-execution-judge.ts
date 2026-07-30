import assert from 'node:assert/strict';
import test from 'node:test';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import {
  createProvisionalRuntimeExecutionJudge,
  type JudgeEvaluationPlan,
  type ProvisionalRuntimeExecutionJudgeBinding,
} from '../src/judge';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  type CodeExecutionResult,
  type ExecutionResult,
  type RuntimeCodeCall,
  type RuntimeExecutionProvider,
  type RuntimeTrace,
  type RuntimeTraceCall,
} from '@tracecode/harness-core';

const RUNTIME = 'fake-runtime-execution-provider';
const SOURCE = [
  'function solve(value) {',
  '  return value;',
  '}',
].join('\n');

interface FakeInput extends Record<string, unknown> {
  readonly label: string;
  readonly output?: unknown;
  readonly mode?:
    | 'failed'
    | 'hang'
    | 'limit'
    | 'throw'
    | 'trace-truncated';
  readonly delayMs?: number;
  readonly consoleOutput?: readonly string[];
}

interface FakeProviderState {
  initCalls: number;
  readonly codeCalls: RuntimeCodeCall[];
  readonly traceCalls: RuntimeTraceCall[];
  readonly completions: string[];
  aborts: number;
  onStart?: (input: FakeInput) => void;
}

function makeState(): FakeProviderState {
  return {
    initCalls: 0,
    codeCalls: [],
    traceCalls: [],
    completions: [],
    aborts: 0,
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Runtime execution was aborted.');
}

function waitForInput(
  input: FakeInput,
  signal: AbortSignal | undefined,
  state: FakeProviderState
): Promise<void> {
  state.onStart?.(input);
  if (input.mode === 'hang') {
    return new Promise((_, reject) => {
      if (!signal) return;
      const abort = () => {
        state.aborts += 1;
        reject(abortError(signal));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
  const delayMs = input.delayMs ?? 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    if (!signal) return;
    const abort = () => {
      clearTimeout(timer);
      state.aborts += 1;
      reject(abortError(signal));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function consoleOutput(input: FakeInput): string[] {
  return [...(input.consoleOutput ?? [`stdout:${input.label}`])];
}

function completedOutput(input: FakeInput): unknown {
  return Object.prototype.hasOwnProperty.call(input, 'output')
    ? input.output
    : input.label;
}

function fakeProvider(state: FakeProviderState): RuntimeExecutionProvider {
  return {
    async init() {
      state.initCalls += 1;
      return {
        success: true,
        loadTimeMs: 2,
      };
    },
    async executeCode(call): Promise<CodeExecutionResult> {
      state.codeCalls.push(call);
      const input = call.inputs as FakeInput;
      await waitForInput(input, call.signal, state);
      state.completions.push(input.label);
      if (input.mode === 'throw') {
        throw new Error('provider transport exploded');
      }
      if (input.mode === 'failed') {
        return {
          kind: 'failed',
          error: 'runtime exploded',
          errorLine: 7,
          diagnosticStage: 'runtime',
          diagnostic: {
            engine: 'fake',
          },
          consoleOutput: consoleOutput(input),
        };
      }
      if (input.mode === 'limit') {
        return {
          kind: 'limit',
          reason: 'line-limit',
          error: 'line budget reached',
          diagnostic: {
            observedLines: 11,
          },
          consoleOutput: consoleOutput(input),
        };
      }
      return {
        kind: 'completed',
        output: completedOutput(input),
        consoleOutput: consoleOutput(input),
      };
    },
    async executeWithTracing(call): Promise<ExecutionResult> {
      state.traceCalls.push(call);
      const input = call.inputs as FakeInput;
      await waitForInput(input, call.signal, state);
      state.completions.push(input.label);
      const trace: RuntimeTrace = {
        schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
        language: 'javascript' as const,
        runId: `run:${input.label}`,
        events: [{
          kind: 'line' as const,
          runId: `run:${input.label}`,
          line: 2,
        }],
        lineEventCount: 1,
        traceStepCount: 1,
      };
      if (input.mode === 'failed') {
        return {
          kind: 'failed',
          error: 'traced runtime exploded',
          errorLine: 2,
          trace,
          executionTimeMs: 3,
          consoleOutput: consoleOutput(input),
          diagnosticStage: 'runtime',
        };
      }
      if (input.mode === 'limit') {
        return {
          kind: 'limit',
          reason: 'trace-limit',
          error: 'trace budget reached',
          trace,
          executionTimeMs: 3,
          consoleOutput: consoleOutput(input),
        };
      }
      return {
        kind: 'completed',
        output: completedOutput(input),
        trace,
        executionTimeMs: 3,
        consoleOutput: consoleOutput(input),
        ...(input.mode === 'trace-truncated'
          ? { traceTruncated: 'trace-limit' as const }
          : {}),
      };
    },
  };
}

function makePlan<Expected = unknown>(
  cases: readonly {
    readonly id: string;
    readonly input: FakeInput;
    readonly expected?: Expected;
  }[],
  overrides: Partial<JudgeEvaluationPlan<FakeInput, Expected>> = {}
): JudgeEvaluationPlan<FakeInput, Expected> {
  return {
    id: 'runtime-provider-golden',
    runtime: RUNTIME,
    workspace: {
      cwd: '/workspace',
      files: [{
        path: '/workspace/solution.fake',
        contents: SOURCE,
        visibility: 'submission',
      }],
    },
    driver: {
      files: [],
    },
    run: {
      command: 'runtime-provider-case',
      timeoutMs: 1_000,
    },
    cases,
    isolation: {
      mode: 'fresh-session-per-case',
      maxConcurrency: 3,
    },
    ...overrides,
  };
}

function codeBinding(
  overrides: Partial<ProvisionalRuntimeExecutionJudgeBinding> = {}
): ProvisionalRuntimeExecutionJudgeBinding {
  return {
    sourcePath: '/workspace/solution.fake',
    functionName: 'solve',
    executionStyle: 'function',
    ...overrides,
  } as ProvisionalRuntimeExecutionJudgeBinding;
}

async function evaluate(
  state: FakeProviderState,
  plan: JudgeEvaluationPlan<FakeInput>,
  binding: ProvisionalRuntimeExecutionJudgeBinding = codeBinding()
) {
  return Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createProvisionalRuntimeExecutionJudge({
        runtime: RUNTIME,
        provider: fakeProvider(state),
        binding,
      });
      return yield* judge.evaluate<FakeInput>(plan);
    })
  ));
}

test('preserves 0.13 JSON comparison and distinguishes omitted from explicit undefined expected values', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan<unknown>([
      {
        id: 'json-match',
        input: {
          label: 'json-match',
          output: { first: 1, second: 2 },
        },
        expected: { first: 1, second: 2 },
      },
      {
        id: 'object-order-is-observable',
        input: {
          label: 'object-order-is-observable',
          output: { first: 1, second: 2 },
        },
        expected: { second: 2, first: 1 },
      },
      {
        id: 'expected-omitted',
        input: {
          label: 'expected-omitted',
          output: null,
        },
      },
      {
        id: 'explicit-undefined-mismatch',
        input: {
          label: 'explicit-undefined-mismatch',
          output: null,
        },
        expected: undefined,
      },
      {
        id: 'explicit-undefined-match',
        input: {
          label: 'explicit-undefined-match',
          output: undefined,
        },
        expected: undefined,
      },
    ])
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(
    result.cases.map((caseResult) => caseResult.verdict.kind),
    ['passed', 'failed', 'not-evaluated', 'failed', 'passed']
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.cases[2], 'expected'),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.cases[3], 'expected'),
    true
  );
  assert.equal(result.cases[3]?.expected, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.cases[4], 'value'),
    true
  );
  assert.equal(result.cases[4]?.value, undefined);
  assert.ok(
    state.codeCalls.every((call) =>
      !Object.prototype.hasOwnProperty.call(call, 'expected') &&
      !Object.prototype.hasOwnProperty.call(call, 'verdict')
    ),
    'Expected values and Judge policy must never enter RuntimeExecutionProvider calls.'
  );
});

test('maps raw values, diagnostics, limits, stdout, stderr, and provider failures without assigning runtime verdicts', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan<unknown>([
      {
        id: 'completed',
        input: {
          label: 'completed',
          output: 4,
          consoleOutput: ['first line', 'already terminated\n'],
        },
        expected: 4,
      },
      {
        id: 'failed',
        input: {
          label: 'failed',
          mode: 'failed',
          consoleOutput: ['before failure'],
        },
        expected: 'unused',
      },
      {
        id: 'limited',
        input: {
          label: 'limited',
          mode: 'limit',
          consoleOutput: ['before limit'],
        },
        expected: 'unused',
      },
      {
        id: 'provider-failure',
        input: {
          label: 'provider-failure',
          mode: 'throw',
        },
        expected: 'unused',
      },
    ]),
    codeBinding({
      limits: {
        wallClockMs: 900,
        maxLineEvents: 10,
      },
    })
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.cases[0]?.status, 'completed');
  assert.equal(result.cases[0]?.value, 4);
  assert.equal(result.cases[0]?.stdout, 'first line\nalready terminated\n');
  assert.equal(result.cases[0]?.stderr, '');
  assert.equal(result.cases[0]?.verdict.kind, 'passed');

  assert.equal(result.cases[1]?.status, 'runtime-error');
  assert.equal(result.cases[1]?.stdout, 'before failure\n');
  assert.equal(result.cases[1]?.stderr, 'runtime exploded\n');
  assert.deepEqual(result.cases[1]?.diagnostics, [{
    severity: 'error',
    message: 'runtime exploded',
    code: 'runtime',
    source: RUNTIME,
    line: 7,
  }]);
  assert.deepEqual(result.cases[1]?.verdict, {
    kind: 'not-evaluated',
    reason: 'case-did-not-complete',
  });

  assert.equal(result.cases[2]?.status, 'runtime-error');
  assert.equal(result.cases[2]?.stderr, 'line budget reached\n');
  assert.equal(result.cases[2]?.diagnostics[0]?.code, 'line-limit');
  assert.deepEqual(result.cases[2]?.termination, {
    kind: 'exit',
    exitCode: 1,
  });

  assert.equal(result.cases[3]?.status, 'runtime-error');
  assert.equal(result.cases[3]?.stderr, 'provider transport exploded\n');
  assert.equal(
    result.cases[3]?.diagnostics[0]?.code,
    'runtime-provider-error'
  );
  assert.ok(state.codeCalls.every((call) =>
    call.limits?.wallClockMs === 900 &&
    call.limits.maxLineEvents === 10
  ));
});

test('publishes tracing as an observation without changing comparison', async () => {
  const plainState = makeState();
  const tracedState = makeState();
  const plan = makePlan([{
    id: 'same-value',
    input: {
      label: 'same-value',
      output: 7,
      mode: 'trace-truncated',
    },
    expected: 7,
  }]);

  const [plain, traced] = await Promise.all([
    evaluate(plainState, plan),
    evaluate(
      tracedState,
      plan,
      codeBinding({
        trace: true,
        traceOptions: {
          maxTraceSteps: 10,
        },
      })
    ),
  ]);

  assert.equal(plain.cases[0]?.verdict.kind, 'passed');
  assert.equal(traced.cases[0]?.verdict.kind, 'passed');
  assert.equal(plain.cases[0] && 'trace' in plain.cases[0], false);
  assert.deepEqual(
    traced.cases[0]?.trace,
    tracedState.traceCalls.length === 1
      ? {
          schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
          language: 'javascript',
          runId: 'run:same-value',
          events: [{
            kind: 'line',
            runId: 'run:same-value',
            line: 2,
          }],
          lineEventCount: 1,
          traceStepCount: 1,
        }
      : undefined
  );
  assert.equal(traced.cases[0]?.diagnostics[0]?.severity, 'warning');
  assert.equal(traced.cases[0]?.diagnostics[0]?.code, 'trace-limit');
  assert.equal(plainState.codeCalls.length, 1);
  assert.equal(tracedState.traceCalls.length, 1);
});

test('uses TraceKernel watchdog termination and aborts the provider on timeout', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan([{
      id: 'timeout',
      input: {
        label: 'timeout',
        mode: 'hang',
      },
      expected: 'never',
    }], {
      run: {
        command: 'runtime-provider-case',
        timeoutMs: 25,
      },
    })
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.cases[0]?.status, 'timed-out');
  assert.equal(result.cases[0]?.timedOut, true);
  assert.deepEqual(result.cases[0]?.termination, {
    kind: 'signal',
    signal: 'SIGKILL',
    exitCode: 137,
  });
  assert.equal(state.aborts, 1);
});

test('interrupting evaluation cancels the provider call and releases all sessions', async () => {
  const state = makeState();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  state.onStart = () => started();

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createProvisionalRuntimeExecutionJudge({
        runtime: RUNTIME,
        provider: fakeProvider(state),
        binding: codeBinding(),
      });
      const fiber = yield* Effect.fork(
        judge.evaluate(
          makePlan([{
            id: 'cancelled',
            input: {
              label: 'cancelled',
              mode: 'hang',
            },
          }], {
            run: {
              command: 'runtime-provider-case',
            },
          })
        )
      );
      yield* Effect.promise(() => didStart);
      yield* Fiber.interrupt(fiber);

      assert.equal(state.aborts, 1);
      assert.deepEqual(judge.activeSessionIds(), []);
    })
  ));
});

test('preserves case order under concurrency and opens an isolated TraceKernel session per case', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan([
      {
        id: 'slow',
        input: {
          label: 'slow',
          output: 'slow',
          delayMs: 35,
        },
        expected: 'slow',
      },
      {
        id: 'fast',
        input: {
          label: 'fast',
          output: 'fast',
          delayMs: 2,
        },
        expected: 'fast',
      },
      {
        id: 'middle',
        input: {
          label: 'middle',
          output: 'middle',
          delayMs: 15,
        },
        expected: 'middle',
      },
    ])
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(
    result.cases.map((caseResult) => caseResult.caseId),
    ['slow', 'fast', 'middle']
  );
  assert.notDeepEqual(state.completions, ['slow', 'fast', 'middle']);
  assert.equal(
    new Set(result.cases.map((caseResult) => caseResult.sessionId)).size,
    3
  );
  assert.equal(
    new Set(state.codeCalls.map((call) => call.inputs)).size,
    3
  );
  assert.ok(state.codeCalls.every((call) => call.code === SOURCE));
  assert.equal(state.initCalls, 1);
});

test('fails a separate compile phase explicitly instead of pretending to compile', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan([{
      id: 'not-run',
      input: {
        label: 'not-run',
      },
    }], {
      compile: {
        command: 'compile',
      },
    })
  );

  assert.equal(result.status, 'compile-failed');
  assert.equal(result.compile.status, 'compile-failed');
  assert.equal(
    result.compile.diagnostics[0]?.code,
    'runtime-provider-compile-unsupported'
  );
  assert.equal(state.codeCalls.length, 0);
  assert.equal(state.traceCalls.length, 0);
});
