import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import {
  type JudgeEvaluationPlan,
  type RuntimeJudgeBinding,
} from '../src/judge';
import {
  createBrowserRuntimeJudge,
} from '../src/internal/browser-judge';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
  type BrowserRuntimeHost,
  type BrowserRuntimeProvider,
} from '../packages/runtime-browser/src';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  type CodeExecutionResult,
  type ExecutionResult,
  type RuntimeCodeCall,
  type RuntimePreparedCodeCall,
  type RuntimePreparedExecutionProvider,
  type RuntimePreparedTraceCall,
  type RuntimeProgramPreparationCall,
  type RuntimeTrace,
  type RuntimeTraceCall,
} from '@tracecode/runtime-contracts';

const RUNTIME = 'javascript';
const BROWSER_FEATURES = {
  worker: true,
  webAssembly: true,
  webCrypto: true,
  sharedArrayBuffer: true,
  crossOriginIsolated: true,
} as const;
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
  readonly prepareCalls: RuntimeProgramPreparationCall[];
  readonly codeCalls: RuntimeCodeCall[];
  readonly traceCalls: RuntimeTraceCall[];
  readonly completions: string[];
  disposals: number;
  aborts: number;
  onStart?: (input: FakeInput) => void;
}

interface PreparedProviderState {
  initCalls: number;
  readonly prepareCalls: RuntimeProgramPreparationCall[];
  readonly codeCalls: RuntimePreparedCodeCall[];
  readonly traceCalls: RuntimePreparedTraceCall[];
  readonly completions: string[];
  disposals: number;
  aborts: number;
  active: number;
  maxActive: number;
  maxConcurrency: number;
  preparationDelayMs: number;
  failPreparation: boolean;
  failDisposal: boolean;
  onPrepareStart?: () => void;
  onStart?: (input: FakeInput) => void;
}

function makeState(): FakeProviderState {
  return {
    initCalls: 0,
    prepareCalls: [],
    codeCalls: [],
    traceCalls: [],
    completions: [],
    disposals: 0,
    aborts: 0,
  };
}

function makePreparedState(
  overrides: Partial<PreparedProviderState> = {}
): PreparedProviderState {
  return {
    initCalls: 0,
    prepareCalls: [],
    codeCalls: [],
    traceCalls: [],
    completions: [],
    disposals: 0,
    aborts: 0,
    active: 0,
    maxActive: 0,
    maxConcurrency: 2,
    preparationDelayMs: 0,
    failPreparation: false,
    failDisposal: false,
    ...overrides,
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

function fakeProvider(
  state: FakeProviderState
): RuntimePreparedExecutionProvider {
  return {
    async init() {
      state.initCalls += 1;
      return {
        success: true,
        loadTimeMs: 2,
      };
    },
    async prepareProgram(preparation) {
      state.prepareCalls.push(preparation);
      const capabilities = {
        caseIsolation: 'fresh-case-state' as const,
        maxConcurrency: 3,
      };
      const dispose = async () => {
        state.disposals += 1;
      };
      if (preparation.mode === 'code') {
        return {
          kind: 'prepared',
          consoleOutput: [],
          program: {
            mode: 'code',
            capabilities,
            async executeIsolated(call): Promise<CodeExecutionResult> {
              const providerCall: RuntimeCodeCall = {
                code: preparation.code,
                functionName:
                  typeof preparation.functionName === 'string'
                    ? preparation.functionName
                    : '',
                inputs: call.inputs,
                executionStyle: preparation.executionStyle,
                signal: call.signal,
                limits: call.limits,
              };
              state.codeCalls.push(providerCall);
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
            dispose,
          },
        };
      }

      return {
        kind: 'prepared',
        consoleOutput: [],
        program: {
          mode: 'trace',
          capabilities,
          async executeIsolated(call): Promise<ExecutionResult> {
            const providerCall: RuntimeTraceCall = {
              code: preparation.code,
              functionName: preparation.functionName,
              inputs: call.inputs,
              executionStyle: preparation.executionStyle,
              traceOptions: preparation.traceOptions,
              signal: call.signal,
              limits: call.limits,
            };
            state.traceCalls.push(providerCall);
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
          dispose,
        },
      };
    },
  };
}

function preparedProvider(
  state: PreparedProviderState
): RuntimePreparedExecutionProvider {
  const dispose = async () => {
    state.disposals += 1;
    if (state.failDisposal) {
      throw new Error('prepared program teardown exploded');
    }
  };
  const executeCode = async (
    call: RuntimePreparedCodeCall
  ): Promise<CodeExecutionResult> => {
    state.codeCalls.push(call);
    const input = call.inputs as FakeInput;
    state.onStart?.(input);
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      await waitForPreparedInput(input, call.signal, state);
      state.completions.push(input.label);
      return {
        kind: 'completed',
        output: completedOutput(input),
        consoleOutput: consoleOutput(input),
        timings: {
          runMs: input.delayMs ?? 0,
          artifactCacheHit: true,
        },
      };
    } finally {
      state.active -= 1;
    }
  };
  const executeTrace = async (
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult> => {
    state.traceCalls.push(call);
    const input = call.inputs as FakeInput;
    state.onStart?.(input);
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      await waitForPreparedInput(input, call.signal, state);
      state.completions.push(input.label);
      return {
        kind: 'completed',
        output: completedOutput(input),
        trace: {
          schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
          language: 'javascript',
          runId: `prepared:${input.label}`,
          events: [{
            kind: 'line',
            runId: `prepared:${input.label}`,
            line: 2,
          }],
          lineEventCount: 1,
          traceStepCount: 1,
        },
        executionTimeMs: input.delayMs ?? 0,
        consoleOutput: consoleOutput(input),
        timings: {
          runMs: input.delayMs ?? 0,
          artifactCacheHit: true,
        },
      };
    } finally {
      state.active -= 1;
    }
  };

  return {
    async init() {
      state.initCalls += 1;
      return {
        success: true,
        loadTimeMs: 2,
      };
    },
    async prepareProgram(call) {
      state.prepareCalls.push(call);
      state.onPrepareStart?.();
      if (state.preparationDelayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, state.preparationDelayMs);
        });
      }
      if (state.failPreparation) {
        return {
          kind: 'failed',
          error: 'prepared compilation exploded',
          errorLine: 4,
          diagnosticStage: 'compile',
          consoleOutput: ['compiler output'],
          timings: {
            compileMs: 11,
            compileCacheHit: false,
          },
        };
      }
      const capabilities = {
        caseIsolation: 'fresh-case-state' as const,
        maxConcurrency: state.maxConcurrency,
      };
      return call.mode === 'trace'
        ? {
            kind: 'prepared' as const,
            program: {
              mode: 'trace' as const,
              capabilities,
              executeIsolated: executeTrace,
              dispose,
            },
            consoleOutput: ['prepared once'],
            timings: {
              compileMs: 11,
              compileCacheHit: false,
            },
          }
        : {
            kind: 'prepared' as const,
            program: {
              mode: 'code' as const,
              capabilities,
              executeIsolated: executeCode,
              dispose,
            },
            consoleOutput: ['prepared once'],
            timings: {
              compileMs: 11,
              compileCacheHit: false,
            },
          };
    },
  };
}

function waitForPreparedInput(
  input: FakeInput,
  signal: AbortSignal | undefined,
  state: PreparedProviderState
): Promise<void> {
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
  overrides: Partial<RuntimeJudgeBinding> = {}
): RuntimeJudgeBinding {
  return {
    sourcePath: '/workspace/solution.fake',
    functionName: 'solve',
    executionStyle: 'function',
    ...overrides,
  } as RuntimeJudgeBinding;
}

function browserHostFor(
  provider: RuntimePreparedExecutionProvider
): BrowserRuntimeHost {
  const browserProvider: BrowserRuntimeProvider = {
    id: 'test-runtime-execution-provider',
    languages: [RUNTIME],
    create() {
      return {
        preparedProviders: new Map([[RUNTIME, provider]]),
        disposeLanguage() {},
        dispose() {},
      };
    },
  };
  return createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([browserProvider]),
    providers: [RUNTIME],
    featureOverrides: BROWSER_FEATURES,
  });
}

function createTestRuntimeJudge(
  provider: RuntimePreparedExecutionProvider,
  binding: RuntimeJudgeBinding
) {
  return Effect.acquireRelease(
    Effect.sync(() => browserHostFor(provider)),
    (host) => Effect.sync(() => host.dispose())
  ).pipe(
    Effect.flatMap((host) =>
      createBrowserRuntimeJudge({
        host,
        language: RUNTIME,
        binding,
      })
    )
  );
}

async function evaluate(
  state: FakeProviderState,
  plan: JudgeEvaluationPlan<FakeInput>,
  binding: RuntimeJudgeBinding = codeBinding()
) {
  return Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        fakeProvider(state),
        binding
      );
      return yield* judge.evaluate<FakeInput>(plan);
    })
  ));
}

async function evaluatePrepared(
  state: PreparedProviderState,
  plan: JudgeEvaluationPlan<FakeInput>,
  binding: RuntimeJudgeBinding = codeBinding()
) {
  return Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        binding
      );
      return yield* judge.evaluate<FakeInput>(plan);
    })
  ));
}

test('composes a genuine browser runtime host into Judge without direct execution', async () => {
  const state = makePreparedState();
  const provider = preparedProvider(state);

  const result = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(provider, codeBinding());
      assert.equal(judge.runtime, RUNTIME);
      return yield* judge.evaluate<FakeInput>(
        makePlan(
          [{
            id: 'browser-host-case',
            input: {
              label: 'browser-host-case',
              output: 19,
            },
            expected: 19,
          }],
          { runtime: RUNTIME }
        )
      );
    })
  ));

  assert.equal(result.cases[0]?.verdict.kind, 'passed');
  assert.equal(state.prepareCalls.length, 1);
  assert.equal(state.codeCalls.length, 1);
  assert.equal(state.disposals, 1);
});

test('rejects provider injection through a structurally compatible fake host', () => {
  const state = makePreparedState();
  const injectedProvider = preparedProvider(state);
  const fakeHost = {
    getPreparedProvider() {
      return injectedProvider;
    },
  } as unknown as BrowserRuntimeHost;

  assert.throws(
    () =>
      createBrowserRuntimeJudge({
        host: fakeHost,
        language: RUNTIME,
        binding: codeBinding(),
      }),
    /requires a genuine BrowserRuntimeHost/
  );
  assert.equal(state.initCalls, 0);
  assert.equal(state.prepareCalls.length, 0);
});

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
    'Expected values and Judge policy must never enter prepared runtime calls.'
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
      const judge = yield* createTestRuntimeJudge(
        fakeProvider(state),
        codeBinding()
      );
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

test('uses an explicit compile phase as the prepare-once boundary', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan([{
      id: 'prepared-run',
      input: {
        label: 'prepared-run',
      },
      expected: 'prepared-run',
    }], {
      compile: {
        command: 'compile',
      },
    })
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.compile?.status, 'compiled');
  assert.equal(result.cases[0]?.verdict.kind, 'passed');
  assert.equal(state.prepareCalls.length, 1);
  assert.equal(state.codeCalls.length, 1);
  assert.equal(state.traceCalls.length, 0);
  assert.equal(state.disposals, 1);
});

test('prepares once, preserves timings, throttles provider concurrency, and disposes exactly once', async () => {
  const state = makePreparedState({
    maxConcurrency: 2,
  });
  const result = await evaluatePrepared(
    state,
    makePlan([
      {
        id: 'slow',
        input: {
          label: 'slow',
          delayMs: 35,
        },
        expected: 'slow',
      },
      {
        id: 'fast',
        input: {
          label: 'fast',
          delayMs: 2,
        },
        expected: 'fast',
      },
      {
        id: 'middle',
        input: {
          label: 'middle',
          delayMs: 15,
        },
        expected: 'middle',
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
  assert.equal(result.compile?.status, 'compiled');
  assert.equal(result.compile?.stdout, 'prepared once\n');
  assert.deepEqual(result.compile?.timings, {
    compileMs: 11,
    compileCacheHit: false,
  });
  assert.deepEqual(
    result.cases.map((caseResult) => caseResult.caseId),
    ['slow', 'fast', 'middle']
  );
  assert.deepEqual(
    result.cases.map((caseResult) => caseResult.timings),
    [
      { runMs: 35, artifactCacheHit: true },
      { runMs: 2, artifactCacheHit: true },
      { runMs: 15, artifactCacheHit: true },
    ]
  );
  assert.equal(state.prepareCalls.length, 1);
  assert.equal(state.prepareCalls[0]?.code, SOURCE);
  assert.equal(state.prepareCalls[0]?.mode, 'code');
  assert.equal(state.prepareCalls[0]?.functionName, 'solve');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(state.prepareCalls[0], 'inputs') &&
    !Object.prototype.hasOwnProperty.call(state.prepareCalls[0], 'expected')
  );
  assert.equal(state.codeCalls.length, 3);
  assert.ok(state.codeCalls.every((call) =>
    call.limits?.wallClockMs === 900 &&
    call.limits.maxLineEvents === 10
  ));
  assert.equal(state.maxActive, 2);
  assert.equal(state.disposals, 1);
  assert.equal(
    new Set(result.cases.map((caseResult) => caseResult.sessionId)).size,
    3
  );
  assert.ok(
    result.cases.every((caseResult) =>
      caseResult.sessionId !== result.compile?.sessionId
    ),
    'Prepared artifacts must not collapse Judge-owned per-case sessions.'
  );
});

test('reports a prepared compilation error once and never starts a case', async () => {
  const state = makePreparedState({
    failPreparation: true,
  });
  const result = await evaluatePrepared(
    state,
    makePlan([
      {
        id: 'first',
        input: {
          label: 'first',
        },
      },
      {
        id: 'second',
        input: {
          label: 'second',
        },
      },
    ])
  );

  assert.equal(result.status, 'compile-failed');
  assert.equal(result.compile.status, 'compile-failed');
  assert.equal(result.compile.stderr, 'prepared compilation exploded\n');
  assert.equal(result.compile.stdout, 'compiler output\n');
  assert.equal(result.compile.diagnostics.length, 1);
  assert.equal(result.compile.diagnostics[0]?.code, 'compile');
  assert.deepEqual(result.compile.timings, {
    compileMs: 11,
    compileCacheHit: false,
  });
  assert.deepEqual(result.cases, []);
  assert.equal(state.prepareCalls.length, 1);
  assert.equal(state.codeCalls.length, 0);
  assert.equal(state.disposals, 0);
});

test('prepares tracing once and keeps tracing policy out of individual cases', async () => {
  const state = makePreparedState();
  const result = await evaluatePrepared(
    state,
    makePlan([{
      id: 'traced',
      input: {
        label: 'traced',
        output: 7,
      },
      expected: 7,
    }]),
    codeBinding({
      trace: true,
      traceOptions: {
        maxTraceSteps: 20,
        minimalTrace: true,
      },
      limits: {
        wallClockMs: 700,
        maxLineEvents: 12,
      },
    })
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.cases[0]?.verdict.kind, 'passed');
  assert.equal(state.prepareCalls.length, 1);
  assert.equal(state.prepareCalls[0]?.mode, 'trace');
  assert.deepEqual(state.prepareCalls[0]?.traceOptions, {
    maxTraceSteps: 20,
    minimalTrace: true,
  });
  assert.equal(state.traceCalls.length, 1);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(
      state.traceCalls[0],
      'traceOptions'
    )
  );
  assert.deepEqual(state.traceCalls[0]?.limits, {
    wallClockMs: 700,
    maxLineEvents: 12,
  });
  assert.equal(state.disposals, 1);
});

test('interrupting prepared execution aborts active work, clears queued work, and disposes once', async () => {
  const state = makePreparedState({
    maxConcurrency: 1,
  });
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  state.onStart = () => started();

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        codeBinding()
      );
      const fiber = yield* Effect.fork(
        judge.evaluate(
          makePlan([
            {
              id: 'active',
              input: {
                label: 'active',
                mode: 'hang',
              },
            },
            {
              id: 'queued',
              input: {
                label: 'queued',
                mode: 'hang',
              },
            },
          ], {
            run: {
              command: 'runtime-provider-case',
            },
          })
        )
      );
      yield* Effect.promise(() => didStart);
      yield* Fiber.interrupt(fiber);

      assert.equal(state.prepareCalls.length, 1);
      assert.equal(state.codeCalls.length, 1);
      assert.equal(state.aborts, 1);
      assert.equal(state.disposals, 1);
      assert.deepEqual(judge.activeSessionIds(), []);
    })
  ));
});

test('disposes a prepared artifact that arrives after its evaluation was interrupted', async () => {
  const state = makePreparedState({
    preparationDelayMs: 20,
  });
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  state.onPrepareStart = () => started();

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        codeBinding()
      );
      const fiber = yield* Effect.fork(
        judge.evaluate(
          makePlan([{
            id: 'never-executed',
            input: {
              label: 'never-executed',
            },
          }])
        )
      );
      yield* Effect.promise(() => didStart);
      yield* Fiber.interrupt(fiber);
      assert.equal(state.prepareCalls.length, 1);
      assert.equal(state.codeCalls.length, 0);
      assert.equal(state.disposals, 0);
      assert.deepEqual(judge.activeSessionIds(), []);

      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 35))
      );
      assert.equal(state.disposals, 1);
      assert.deepEqual(judge.activeSessionIds(), []);
    })
  ));
});

test('uses unique preparation scopes when one judge evaluates the same semantic plan twice', async () => {
  const state = makePreparedState();

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        codeBinding()
      );
      const plan = makePlan([{
        id: 'same',
        input: {
          label: 'same',
        },
        expected: 'same',
      }]);
      const evaluation = judge.evaluate(plan);
      assert.equal(
        state.prepareCalls.length,
        0,
        'Constructing an Effect must not eagerly register or prepare an evaluation.'
      );
      const first = yield* evaluation;
      const second = yield* evaluation;

      assert.equal(first.status, 'completed');
      assert.equal(second.status, 'completed');
      assert.equal(state.prepareCalls.length, 2);
      assert.equal(state.codeCalls.length, 2);
      assert.equal(state.disposals, 2);
      assert.deepEqual(judge.activeSessionIds(), []);
    })
  ));
});

test('surfaces prepared program teardown failure as Judge infrastructure failure', async () => {
  const state = makePreparedState({
    failDisposal: true,
  });
  let judgeSessions = (): readonly string[] => ['not-evaluated'];

  const exit = await Effect.runPromiseExit(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        codeBinding()
      );
      judgeSessions = () => judge.activeSessionIds();
      return yield* judge.evaluate(
        makePlan([{
          id: 'completed-before-teardown',
          input: {
            label: 'completed-before-teardown',
          },
        }])
      );
    })
  ));
  assert.equal(exit._tag, 'Failure');
  if (exit._tag === 'Failure') {
    const failure = Cause.failureOption(exit.cause);
    assert.equal(Option.isSome(failure), true);
    if (Option.isSome(failure)) {
      assert.equal(
        (failure.value as { readonly _tag?: string })._tag,
        'JudgeInfrastructureError'
      );
      assert.equal(
        (failure.value as { readonly operation?: string }).operation,
        'dispose prepared runtime program'
      );
      assert.match(
        (failure.value as { readonly message?: string }).message ?? '',
        /teardown exploded/
      );
    }
  }
  assert.equal(state.disposals, 1);
  assert.deepEqual(judgeSessions(), []);
});
