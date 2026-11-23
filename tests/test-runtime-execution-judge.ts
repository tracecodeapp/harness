import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import {
  createAlgorithmJudgeBundle,
  isRuntimeProviderError,
  judgeCaseExecutionOutcome,
  judgeCompileExecutionOutcome,
  type JudgeCaseResult,
  type JudgeEvaluationPlan,
  type RuntimeJudgeBinding,
} from '../src/judge';
import {
  DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS,
  createBrowserJudgeHostFromRuntimeHost,
  createBrowserRuntimeJudge,
} from '../src/internal/browser-judge';
import type {
  BrowserRuntimeJudgeReceiptLease,
  JudgeReceiptProvider,
} from '../packages/runtime-browser/src/browser-runtime-host-internal';
import { RuntimePreparedProgramRegistry } from '../src/internal/judge-prepared-program';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
  type BrowserRuntimeHost,
  type BrowserRuntimeProvider,
  type BrowserRuntimeProviderContext,
} from '../packages/runtime-browser/src';
import {
  liftCodeOutcome,
  isTraceUnavailableError,
  liftTraceOutcome,
  RuntimeProviderError,
  TRACE_UNAVAILABLE_CODE,
  traceUnavailableOutcome,
} from '../packages/runtime-contracts/src/execution-outcome';
import { createEmptyRuntimeTrace } from '../packages/runtime-contracts/src/runtime-trace';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  type CodeExecutionResult,
  type ExecutionResult,
  type RuntimeCodeCall,
  type RuntimePreparedCodeCall,
  type RuntimePreparedCodeBatchCall,
  type RuntimePreparedTraceBatchCall,
  type RuntimePreparedExecutionProvider,
  type RuntimePreparedTraceCall,
  type RuntimeProgramPreparationCall,
  type RuntimeTrace,
  type RuntimeTraceCall,
} from '@tracecode/runtime-contracts';

import { JavaScriptWorkerClient } from '../packages/runtime-javascript/src/javascript-worker-client';
import { createJavaScriptPreparedExecutionProvider } from '../packages/runtime-javascript/src/javascript-runtime-client';
import type { BrowserWorkerLike } from '../packages/runtime-browser/src/execution-host';

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
    | 'silent-limit'
    | 'runaway'
    | 'throw'
    | 'trace-truncated'
    | 'runaway-trace-truncated'
    | 'failed-trace-truncated'
    | 'unstaged'
    | 'bogus-limit'
    | 'unknown-stage'
    | 'malformed-reply';
  readonly delayMs?: number;
  readonly consoleOutput?: readonly string[];
}

interface FakeProviderState {
  initCalls: number;
  initFailure?: 'unsuccessful' | 'throws';
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
  readonly codeBatchCalls: RuntimePreparedCodeBatchCall[];
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
  /** Labels whose traced run the runtime refuses as trace-unavailable. */
  traceRefusedLabels?: ReadonlySet<string>;
  /** Refuse without converting refused cases in a batch of its own. */
  refuseWithoutOwnBatch?: boolean;
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
    codeBatchCalls: [],
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
      if (state.initFailure === 'throws') {
        throw new Error('runtime asset fetch failed');
      }
      return {
        success: state.initFailure !== 'unsuccessful',
        loadTimeMs: 2,
      };
    },
    async prepareProgram(preparation) {
      state.prepareCalls.push(preparation);
      const capabilities = {
        profile: 'compatibility' as const,
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
              if (input.mode === 'unknown-stage') {
                return {
                  kind: 'failed',
                  error: 'bogus',
                  diagnosticStage: 'banana',
                  consoleOutput: [],
                } as unknown as CodeExecutionResult;
              }
              if (input.mode === 'malformed-reply') {
                // A worker reply that names no classification, lifted the way
                // every runtime client lifts its replies.
                return liftCodeOutcome({ success: false, error: 'no stage', consoleOutput: [] });
              }
              if (input.mode === 'bogus-limit') {
                // A malformed provider message naming a limit outside the set.
                return {
                  kind: 'limit',
                  reason: 'banana',
                  error: 'bogus',
                  consoleOutput: [],
                } as unknown as CodeExecutionResult;
              }
              if (input.mode === 'unstaged') {
                // An untyped provider breaking the contract.
                return {
                  kind: 'failed',
                  error: 'something failed',
                  consoleOutput: [],
                } as unknown as CodeExecutionResult;
              }
              if (input.mode === 'silent-limit') {
                return {
                  kind: 'limit',
                  reason: 'client-timeout',
                  error: '',
                  consoleOutput: [],
                };
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
            if (input.mode === 'runaway') {
              return {
                kind: 'limit',
                reason: 'single-line-limit',
                error: 'one line ran too many times',
                trace,
                executionTimeMs: 3,
                consoleOutput: consoleOutput(input),
              };
            }
            if (input.mode === 'runaway-trace-truncated') {
              return {
                kind: 'limit',
                reason: 'line-limit',
                error: 'the program executed too many lines',
                trace,
                executionTimeMs: 3,
                consoleOutput: consoleOutput(input),
                traceTruncated: 'trace-byte-limit',
              };
            }
            if (input.mode === 'failed-trace-truncated') {
              return {
                kind: 'failed',
                error: 'traced runtime exploded after recording stopped',
                errorLine: 2,
                trace,
                executionTimeMs: 3,
                consoleOutput: consoleOutput(input),
                diagnosticStage: 'runtime',
                traceTruncated: 'trace-limit',
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
    if (call.recordTrace !== false && state.traceRefusedLabels?.has(input.label)) {
      throw new RuntimeProviderError('TraceCode could not trace this case.', { code: TRACE_UNAVAILABLE_CODE });
    }
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
          events: call.recordTrace === false
            ? []
            : [{
                kind: 'line',
                runId: `prepared:${input.label}`,
                line: 2,
              }],
          lineEventCount: call.recordTrace === false ? 0 : 1,
          traceStepCount: call.recordTrace === false ? 0 : 1,
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
        profile: 'compatibility' as const,
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
              // Like the Java provider: a traced batch runs case by case and
              // refuses only the case the runtime could not trace.
              ...(state.traceRefusedLabels && !state.refuseWithoutOwnBatch
                ? {
                    executeBatchIsolated: async (batch: RuntimePreparedTraceBatchCall) => {
                      const results: ExecutionResult[] = [];
                      for (const [index, inputs] of batch.inputBatch.entries()) {
                        try {
                          results.push(await executeTrace({
                            inputs,
                            ...(batch.traceEnabledBatch ? { recordTrace: batch.traceEnabledBatch[index] } : {}),
                            ...(batch.signal ? { signal: batch.signal } : {}),
                            ...(batch.limits ? { limits: batch.limits } : {}),
                          }));
                        } catch (error) {
                          if (!isTraceUnavailableError(error)) throw error;
                          results.push(traceUnavailableOutcome(error as Error, 'javascript'));
                        }
                      }
                      return results;
                    },
                  }
                : {}),
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
  provider: RuntimePreparedExecutionProvider,
  bindReceiptProvider?: (context: BrowserRuntimeProviderContext) => JudgeReceiptProvider,
  assetBaseUrl?: string
): BrowserRuntimeHost {
  const browserProvider: BrowserRuntimeProvider = {
    id: 'test-runtime-execution-provider',
    languages: [RUNTIME],
    create(context): BrowserRuntimeJudgeReceiptLease {
      const receiptProvider = bindReceiptProvider?.(context);
      return {
        preparedProviders: new Map([[RUNTIME, provider]]),
        ...(receiptProvider ? { judgeReceiptProviders: new Map([[RUNTIME, receiptProvider]]) } : {}),
        disposeLanguage() {},
        dispose() {},
      };
    },
  };
  return createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([browserProvider]),
    providers: [RUNTIME],
    assetBaseUrl,
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

test('execute defaults to one clean ephemeral evaluation', async () => {
  const state = makePreparedState();
  const result = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        codeBinding()
      );
      return yield* judge.execute<FakeInput>({
        plan: makePlan([{
          id: 'clean-default',
          input: { label: 'clean-default', output: 11 },
          expected: 11,
        }]),
      });
    })
  ));

  assert.equal(result.executionId, undefined);
  assert.equal(result.evaluation.status, 'completed');
  assert.equal(result.evaluation.cases[0]?.verdict.kind, 'passed');
  assert.deepEqual(state.prepareCalls.map((call) => call.mode), ['code']);
  assert.equal(state.codeCalls.length, 1);
  assert.equal(state.traceCalls.length, 0);
  assert.equal(state.disposals, 1);
});

test('interactive execute retains one trace-capable artifact and traces explicit case tranches', async () => {
  const state = makePreparedState();

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        codeBinding({ trace: true })
      );
      const initial = yield* judge.execute<FakeInput>({
        plan: makePlan([
          { id: 'selected', input: { label: 'selected' } },
          { id: 'drain-a', input: { label: 'drain-a' } },
          { id: 'drain-b', input: { label: 'drain-b' } },
        ]),
        interactive: true,
        tracing: { caseIds: ['selected'] },
      });

      assert.ok(initial.executionId);
      assert.equal(initial.evaluation.status, 'completed');
      assert.deepEqual(
        initial.evaluation.status === 'completed'
          ? initial.evaluation.cases.map((result) =>
              (result.trace as RuntimeTrace | undefined)?.events.length ?? -1
            )
          : [],
        [1, 0, 0]
      );
      assert.equal(state.prepareCalls.length, 1);
      assert.deepEqual(
        state.traceCalls.map((call) => call.recordTrace),
        [true, false, false]
      );
      assert.equal(state.disposals, 0);

      const continuation = yield* judge.execute<FakeInput>({
        executionId: initial.executionId!,
        tracing: { caseIds: ['drain-b'] },
      });
      assert.equal(continuation.executionId, initial.executionId);
      assert.equal(continuation.evaluation.status, 'completed');
      assert.deepEqual(
        continuation.evaluation.status === 'completed'
          ? continuation.evaluation.cases.map((result) => result.caseId)
          : [],
        ['drain-b']
      );
      assert.equal(state.prepareCalls.length, 1);
      assert.equal(state.traceCalls.at(-1)?.recordTrace, true);
      assert.equal(state.disposals, 0);

      yield* judge.disposeExecution(initial.executionId!);
      yield* judge.disposeExecution(initial.executionId!);
      assert.equal(
        state.disposals,
        1,
        'explicit disposal releases the live prepared program exactly once'
      );

      const exit = yield* Effect.exit(judge.execute<FakeInput>({
        executionId: initial.executionId!,
        tracing: { caseIds: ['drain-a'] },
      }));
      assert.equal(Exit.isFailure(exit), true);
    })
  ));

  assert.equal(state.disposals, 1);
});

test('browser interactive execute prepares one trace-capable program and records only the selected case', async () => {
  const state = makePreparedState();
  const runtimeHost = browserHostFor(preparedProvider(state));
  const judgeHost = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'single-program-interactive',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      trace: true,
      cases: [
        { id: 'selected', input: { label: 'selected' }, expected: 'selected' },
        { id: 'drain-a', input: { label: 'drain-a' }, expected: 'drain-a' },
        { id: 'drain-b', input: { label: 'drain-b' }, expected: 'drain-b' },
      ],
    });

    const initial = await judgeHost.execute({
      bundle,
      interactive: true,
      tracing: { caseIds: ['selected'] },
    });

    assert.ok(initial.executionId);
    assert.equal(initial.evaluation.status, 'completed');
    assert.deepEqual(
      initial.evaluation.cases.map((result) => result.caseId),
      ['selected', 'drain-a', 'drain-b']
    );
    assert.deepEqual(
      initial.evaluation.cases.map((result) => ({
        caseId: result.caseId,
        traceEvents: (result.trace as RuntimeTrace).events.length,
      })),
      [
        { caseId: 'selected', traceEvents: 1 },
        { caseId: 'drain-a', traceEvents: 0 },
        { caseId: 'drain-b', traceEvents: 0 },
      ]
    );
    assert.deepEqual(
      state.prepareCalls.map((call) => call.mode),
      ['trace']
    );
    assert.equal(state.codeCalls.length, 0);
    assert.deepEqual(
      state.traceCalls.map((call) => ({
        label: (call.inputs as FakeInput).label,
        recordTrace: call.recordTrace,
      })),
      [
        { label: 'selected', recordTrace: true },
        { label: 'drain-a', recordTrace: false },
        { label: 'drain-b', recordTrace: false },
      ]
    );
    assert.deepEqual(
      initial.timings?.phases.map((timing) => timing.phase),
      [
        'bundle-validation',
        'judge-create',
        'initial-execute',
      ]
    );
    assert.ok((initial.timings?.totalMs ?? -1) >= 0);
    assert.ok(initial.timings?.phases.every((timing) => timing.success));

    const continuation = await judgeHost.execute({
      executionId: initial.executionId!,
      tracing: { caseIds: ['drain-b'] },
    });
    assert.deepEqual(
      continuation.evaluation.cases.map((result) => result.caseId),
      ['drain-b']
    );
    assert.deepEqual(
      state.traceCalls.map((call) => (call.inputs as FakeInput).label),
      ['selected', 'drain-a', 'drain-b', 'drain-b']
    );
    assert.deepEqual(
      continuation.timings?.phases.map((timing) => timing.phase),
      ['trace-continuation-execute']
    );
    await judgeHost.disposeExecution(initial.executionId!);
  } finally {
    judgeHost.dispose();
  }
});

test('a traced case the runtime cannot trace is refused on its own; the other cases and later tranches are unaffected', async () => {
  const state = makePreparedState({ traceRefusedLabels: new Set(['refused']) });
  const runtimeHost = browserHostFor(preparedProvider(state));
  const judgeHost = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  const refusalMessage = 'TraceCode could not trace this case.';
  const assertRefused = (result: JudgeCaseResult | undefined) => {
    assert.ok(result);
    assert.equal(result.caseId, 'refused');
    assert.equal(result.status, 'runtime-error');
    assert.deepEqual(result.verdict, { kind: 'not-evaluated', reason: 'case-did-not-complete' });
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'value'), false);
    assert.deepEqual(result.failure, {
      origin: 'provider',
      reason: 'runtime-failure',
      message: refusalMessage,
    });
    assert.deepEqual(
      result.diagnostics.map(({ severity, code, source, message }) => ({ severity, code, source, message })),
      [{ severity: 'error', code: 'trace-unavailable', source: 'javascript', message: refusalMessage }]
    );
    assert.throws(
      () => judgeCaseExecutionOutcome(result, { language: 'javascript' }),
      (error: unknown) =>
        isRuntimeProviderError(error) &&
        error.reason === 'runtime-failure' &&
        (error as { code?: string }).code === TRACE_UNAVAILABLE_CODE
    );
  };
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'trace-unavailable-per-case',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      trace: true,
      cases: [
        { id: 'first', input: { label: 'first' }, expected: 'first' },
        { id: 'refused', input: { label: 'refused' }, expected: 'refused' },
        { id: 'drain-a', input: { label: 'drain-a' }, expected: 'drain-a' },
        { id: 'drain-b', input: { label: 'drain-b' }, expected: 'drain-b' },
      ],
    });
    const initial = await judgeHost.execute({
      bundle,
      interactive: true,
      tracing: { caseIds: ['refused'] },
    });
    assert.ok(initial.executionId, 'the execution is retained');
    assert.equal(initial.evaluation.status, 'completed');
    const byId = new Map(initial.evaluation.cases.map((result) => [result.caseId, result]));
    assertRefused(byId.get('refused'));
    for (const caseId of ['first', 'drain-a', 'drain-b']) {
      const result = byId.get(caseId);
      assert.equal(result?.status, 'completed', caseId);
      assert.equal(result?.verdict.kind, 'passed', caseId);
    }

    const other = await judgeHost.execute({
      executionId: initial.executionId!,
      tracing: { caseIds: ['drain-a'] },
    });
    assert.equal(other.evaluation.cases[0]?.status, 'completed');
    assert.equal((other.evaluation.cases[0]?.trace as RuntimeTrace).events.length, 1);

    const again = await judgeHost.execute({
      executionId: initial.executionId!,
      tracing: { caseIds: ['refused'] },
    });
    assertRefused(again.evaluation.cases[0]);
    await judgeHost.disposeExecution(initial.executionId!);
  } finally {
    judgeHost.dispose();
  }
});

test('the shared prepared registry leaves a provider\'s coded rejection a batch rejection', async () => {
  // Only a provider converts its own cases; the registry never turns another
  // provider's coded error into a per-case outcome.
  const state = makePreparedState({ traceRefusedLabels: new Set(['refused']), refuseWithoutOwnBatch: true });
  const judgeHost = createBrowserJudgeHostFromRuntimeHost(browserHostFor(preparedProvider(state)));
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'registry-leaves-coded-rejections',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      trace: true,
      cases: [
        { id: 'first', input: { label: 'first' }, expected: 'first' },
        { id: 'refused', input: { label: 'refused' }, expected: 'refused' },
      ],
    });
    const initial = await judgeHost.execute({ bundle, interactive: true, tracing: { caseIds: ['refused'] } });
    assert.deepEqual(
      initial.evaluation.cases.map((result) => [result.caseId, result.failure?.origin]),
      [['first', 'provider'], ['refused', 'provider']]
    );
    if (initial.executionId) await judgeHost.disposeExecution(initial.executionId);
  } finally {
    judgeHost.dispose();
  }
});

test('browser interactive execute validates trace selection before either program is prepared', async () => {
  const state = makePreparedState();
  const runtimeHost = browserHostFor(preparedProvider(state));
  const judgeHost = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'single-program-invalid-selection',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      trace: true,
      cases: [
        { id: 'known', input: { label: 'known' }, expected: 'known' },
      ],
    });

    await assert.rejects(
      judgeHost.execute({
        bundle,
        interactive: true,
        tracing: { caseIds: ['unknown'] },
      }),
      /unknown case id/u
    );
    assert.equal(state.prepareCalls.length, 0);
  } finally {
    judgeHost.dispose();
  }
});

test('browser interactive execute reports failure from its only prepared program', async () => {
  const state = makePreparedState({ failPreparation: true });
  const runtimeHost = browserHostFor(preparedProvider(state));
  const judgeHost = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'single-program-compile-failure',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      trace: true,
      cases: [
        { id: 'selected', input: { label: 'selected' }, expected: 'selected' },
      ],
    });

    const result = await judgeHost.execute({
      bundle,
      interactive: true,
      tracing: { caseIds: ['selected'] },
    });
    assert.equal(result.evaluation.status, 'compile-failed');
    assert.equal(result.executionId, undefined);
    assert.deepEqual(
      state.prepareCalls.map((call) => call.mode),
      ['trace']
    );
    assert.equal(state.codeCalls.length, 0);
    assert.equal(state.traceCalls.length, 0);
  } finally {
    judgeHost.dispose();
  }
});

test('interactive execute rejects invalid trace selections before preparing', async () => {
  const state = makePreparedState();

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        codeBinding({ trace: true })
      );
      const exit = yield* Effect.exit(judge.execute<FakeInput>({
        plan: makePlan([{
          id: 'known',
          input: { label: 'known' },
        }]),
        interactive: true,
        tracing: { caseIds: ['unknown'] },
      }));

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(state.prepareCalls.length, 0);
    })
  ));
});

test('interactive continuation timeout scales to only the selected tranche', async () => {
  const state = makePreparedState();
  const slowInput = { label: 'slow', delayMs: 0 };
  // A small declared lifecycle allowance keeps the backstop short: one case's
  // 25 ms plus 10 ms. Scaled to all three batched cases it would be over 30 s
  // and would not fire while the slow case runs for 200 ms.
  const provider = { ...preparedProvider(state), lifecycleAllowanceMs: 10 };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        provider,
        codeBinding({ trace: true })
      );
      const initial = yield* judge.execute<FakeInput>({
        plan: makePlan([
          { id: 'slow', input: slowInput, expected: 'slow' },
          { id: 'fast-a', input: { label: 'fast-a' }, expected: 'fast-a' },
          { id: 'fast-b', input: { label: 'fast-b' }, expected: 'fast-b' },
        ], {
          run: {
            command: 'runtime-provider-case',
            timeoutMs: 25,
          },
        }),
        interactive: true,
      });
      assert.ok(initial.executionId);

      slowInput.delayMs = 200;
      // The backstop fired: the runtime did not honour its own limit. That is
      // the provider's failure on the case, never a fabricated time limit and
      // never an infrastructure failure of the whole call.
      const continuation = yield* judge.execute<FakeInput>({
        executionId: initial.executionId!,
        tracing: { caseIds: ['slow'] },
      });
      assert.equal(continuation.evaluation.status, 'completed');
      const slow = continuation.evaluation.cases[0];
      assert.equal(slow?.status, 'runtime-error');
      assert.equal(slow?.timedOut, false);
      assert.equal(slow?.diagnostics[0]?.code, 'runtime-provider-error');
      assert.equal(slow?.failure?.origin, 'provider');
      assert.equal(state.aborts, 1);
      yield* judge.disposeExecution(initial.executionId!);
    })
  ));
});

test('browser interactive executions expire through the ordinary disposal path', async () => {
  const state = makePreparedState();
  const runtimeHost = browserHostFor(preparedProvider(state));
  const judgeHost = createBrowserJudgeHostFromRuntimeHost(runtimeHost, {
    interactiveExecutionIdleTimeoutMs: 25,
  });
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'idle-expiry',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      trace: true,
      cases: [
        { id: 'selected', input: { label: 'selected' }, expected: 'selected' },
        { id: 'drain', input: { label: 'drain' }, expected: 'drain' },
      ],
    });
    const initial = await judgeHost.execute({
      bundle,
      interactive: true,
      tracing: { caseIds: ['selected'] },
    });
    assert.ok(initial.executionId);

    await new Promise<void>((resolve) => setTimeout(resolve, 75));

    await assert.rejects(
      judgeHost.execute({
        executionId: initial.executionId!,
        tracing: { caseIds: ['drain'] },
      }),
      /Unknown or disposed interactive execution/u
    );
  } finally {
    judgeHost.dispose();
  }
});

test('interactive activity pauses and renews the idle lease', async () => {
  const state = makePreparedState();
  const runtimeHost = browserHostFor(preparedProvider(state));
  const judgeHost = createBrowserJudgeHostFromRuntimeHost(runtimeHost, {
    interactiveExecutionIdleTimeoutMs: 25,
  });
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'idle-renewal',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      trace: true,
      cases: [
        {
          id: 'slow-drain',
          input: { label: 'slow-drain', delayMs: 70 },
          expected: 'slow-drain',
        },
        {
          id: 'renewal-probe',
          input: { label: 'renewal-probe' },
          expected: 'renewal-probe',
        },
      ],
    });
    const initial = await judgeHost.execute({
      bundle,
      interactive: true,
    });
    assert.ok(initial.executionId);

    const continuation = await judgeHost.execute({
      executionId: initial.executionId!,
      tracing: { caseIds: ['slow-drain'] },
    });
    assert.equal(continuation.executionId, initial.executionId);
    assert.equal(continuation.evaluation.status, 'completed');

    const renewed = await judgeHost.execute({
      executionId: initial.executionId!,
      tracing: { caseIds: ['renewal-probe'] },
    });
    assert.equal(renewed.executionId, initial.executionId);

    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    await assert.rejects(
      judgeHost.execute({
        executionId: initial.executionId!,
        tracing: { caseIds: ['slow-drain'] },
      }),
      /Unknown or disposed interactive execution/u
    );
  } finally {
    judgeHost.dispose();
  }
});

test('interactive idle timeout has a safe default and rejects invalid configuration', () => {
  assert.equal(DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS, 300_000);
  const runtimeHost = browserHostFor(preparedProvider(makePreparedState()));
  try {
    assert.throws(
      () => createBrowserJudgeHostFromRuntimeHost(runtimeHost, {
        interactiveExecutionIdleTimeoutMs: 0,
      }),
      /must be a positive integer/u
    );
  } finally {
    runtimeHost.dispose();
  }
});

test('execute treats tracing and interactivity as independent explicit opt-ins', async () => {
  const traceOnlyState = makePreparedState();
  const interactiveOnlyState = makePreparedState();

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const traceOnlyJudge = yield* createTestRuntimeJudge(
        preparedProvider(traceOnlyState),
        codeBinding({ trace: true })
      );
      const traced = yield* traceOnlyJudge.execute<FakeInput>({
        plan: makePlan([{
          id: 'trace-now',
          input: { label: 'trace-now' },
        }]),
        tracing: { caseIds: ['trace-now'] },
      });
      assert.equal(traced.executionId, undefined);
      assert.equal(traceOnlyState.traceCalls[0]?.recordTrace, true);

      const interactiveOnlyJudge = yield* createTestRuntimeJudge(
        preparedProvider(interactiveOnlyState),
        codeBinding({ trace: true })
      );
      const retained = yield* interactiveOnlyJudge.execute<FakeInput>({
        plan: makePlan([{
          id: 'clean-now-trace-later',
          input: { label: 'clean-now-trace-later' },
        }]),
        interactive: true,
      });
      assert.ok(retained.executionId);
      assert.equal(interactiveOnlyState.traceCalls[0]?.recordTrace, false);
      yield* interactiveOnlyJudge.disposeExecution(retained.executionId!);
    })
  ));
});

test('bundle trace options remain available for explicit on-demand tracing', async () => {
  const state = makePreparedState();
  const runtimeHost = browserHostFor(preparedProvider(state));
  const judgeHost = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'on-demand-trace-options',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      traceOptions: { maxTraceSteps: 20 },
      cases: [
        { id: 'selected', input: { label: 'selected' }, expected: 'selected' },
        { id: 'plain', input: { label: 'plain' }, expected: 'plain' },
      ],
    });

    const result = await judgeHost.execute({
      bundle,
      tracing: { caseIds: ['selected'] },
    });

    assert.equal(result.evaluation.status, 'completed');
    assert.equal(state.prepareCalls.length, 1);
    assert.equal(state.prepareCalls[0]?.mode, 'trace');
    assert.deepEqual(state.prepareCalls[0]?.traceOptions, {
      maxTraceSteps: 20,
    });
    assert.deepEqual(
      state.traceCalls.map((call) => call.recordTrace),
      [true, false]
    );
  } finally {
    judgeHost.dispose();
  }
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

test('rejects unsupported prepared controls before provider initialization or preparation', async () => {
  const executionState = makePreparedState();
  await assert.rejects(
    Effect.runPromise(Effect.scoped(
      createTestRuntimeJudge(
        preparedProvider(executionState),
        codeBinding({ limits: { maxMemoryBytes: 1024 } })
      )
    )),
    /does not support the "maxMemoryBytes" execution limit/
  );
  assert.equal(executionState.initCalls, 0);
  assert.equal(executionState.prepareCalls.length, 0);

  const traceState = makePreparedState();
  await assert.rejects(
    Effect.runPromise(Effect.scoped(
      createTestRuntimeJudge(
        preparedProvider(traceState),
        codeBinding({
          trace: true,
          traceOptions: { maxTraceBytes: 1024 },
        })
      )
    )),
    /does not support the "maxTraceBytes" tracing option/
  );
  assert.equal(traceState.initCalls, 0);
  assert.equal(traceState.prepareCalls.length, 0);
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
  // The diagnostic code is the contract consumers read; the termination is
  // its consequence (only a provider rejection ends in a `failure`).
  assert.deepEqual(result.cases[3]?.termination, {
    kind: 'failure',
    exitCode: 1,
    message: 'provider transport exploded',
  });
  assert.deepEqual(result.cases[1]?.termination, { kind: 'exit', exitCode: 1 });
  assert.ok(state.codeCalls.every((call) =>
    call.limits?.wallClockMs === 900
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

test('a provider that hangs past its own deadline is stopped by the backstop and reported as the provider failure', async () => {
  const state = makeState();
  // The backstop waits for the case's own 25 ms plus the provider's declared
  // lifecycle allowance (10 ms here; 30 s by default).
  const provider = { ...fakeProvider(state), lifecycleAllowanceMs: 10 };
  const startedAt = performance.now();
  const result = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(provider, codeBinding());
      return yield* judge.evaluate<FakeInput>(makePlan([{
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
      }));
    })
  ));
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 30, 'the backstop does not undercut the provider allowance');
  assert.ok(elapsedMs < 5_000, `the declared allowance, not the 30 s default, sizes the backstop (${Math.round(elapsedMs)} ms)`);

  assert.equal(result.status, 'completed');
  const hung = result.cases[0]!;
  assert.equal(hung.status, 'runtime-error');
  assert.equal(hung.timedOut, false, 'no time limit is fabricated');
  assert.deepEqual(hung.termination, {
    kind: 'signal',
    signal: 'SIGKILL',
    exitCode: 137,
  });
  assert.equal(hung.failure?.origin, 'provider');
  assert.equal(hung.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.code, 'runtime-provider-error');
  assert.throws(
    () => judgeCaseExecutionOutcome(hung, { language: 'javascript' }),
    (error: unknown) => isRuntimeProviderError(error)
  );
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

test('algorithm evaluation prepares once and executes all cases through one isolated provider batch', async () => {
  const state = makePreparedState();
  const provider = preparedProvider(state);
  const originalPrepare = provider.prepareProgram.bind(provider);
  const batchProvider: RuntimePreparedExecutionProvider = {
    ...provider,
    async prepareProgram(call) {
      const result = await originalPrepare(call);
      if (result.kind !== 'prepared' || result.program.mode !== 'code') {
        return result;
      }
      return {
        ...result,
        program: {
          ...result.program,
          async executeBatchIsolated(
            batchCall: RuntimePreparedCodeBatchCall
          ) {
            state.codeBatchCalls.push(batchCall);
            await new Promise<void>((resolve) => setTimeout(resolve, 40));
            return batchCall.inputBatch.map((inputs: Record<string, unknown>) => ({
              kind: 'completed' as const,
              output: completedOutput(inputs as FakeInput),
              consoleOutput: consoleOutput(inputs as FakeInput),
              timings: {
                artifactCacheHit: true,
              },
            }));
          },
        },
      };
    },
  };
  const bundle = await createAlgorithmJudgeBundle({
    id: 'prepared-batch',
    language: 'javascript',
    code: SOURCE,
    functionName: 'solve',
    limits: { wallClockMs: 25 },
    cases: [
      {
        id: 'first',
        input: { label: 'first' },
        expected: 'first',
      },
      {
        id: 'second',
        input: { label: 'second' },
        expected: 'second',
      },
      {
        id: 'third',
        input: { label: 'third' },
        expected: 'third',
      },
    ],
  });

  const receipt = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        batchProvider,
        codeBinding({
          sourcePath: bundle.execution.sourcePath,
          limits: bundle.execution.limits,
        })
      );
      return yield* judge.evaluateAlgorithm(bundle);
    })
  ));

  assert.equal(receipt.verdict, 'passed');
  assert.equal(state.prepareCalls.length, 1);
  assert.equal(state.codeBatchCalls.length, 1);
  assert.deepEqual(
    state.codeBatchCalls[0]?.inputBatch.map((inputs) => inputs.label),
    ['first', 'second', 'third']
  );
  assert.equal(state.codeBatchCalls[0]?.limits?.wallClockMs, 25);
  assert.equal(state.codeCalls.length, 0);
  assert.equal(
    new Set(
      receipt.evaluation.status === 'completed'
        ? receipt.evaluation.cases.map((caseResult) => caseResult.sessionId)
        : []
    ).size,
    1
  );
  assert.equal(state.disposals, 1);
});

test('algorithm batch orchestration preserves provider-required fresh workers without recompiling', async () => {
  const state = makePreparedState();
  const bundle = await createAlgorithmJudgeBundle({
    id: 'prepared-batch-fallback',
    language: 'javascript',
    code: SOURCE,
    functionName: 'solve',
    cases: [
      { id: 'first', input: { label: 'first' }, expected: 'first' },
      { id: 'second', input: { label: 'second' }, expected: 'second' },
      { id: 'third', input: { label: 'third' }, expected: 'third' },
    ],
  });

  const receipt = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        preparedProvider(state),
        codeBinding({
          sourcePath: bundle.execution.sourcePath,
        })
      );
      return yield* judge.evaluateAlgorithm(bundle);
    })
  ));

  assert.equal(receipt.verdict, 'passed');
  assert.equal(state.prepareCalls.length, 1);
  assert.equal(state.codeBatchCalls.length, 0);
  assert.deepEqual(
    state.codeCalls.map((call) => call.inputs.label),
    ['first', 'second', 'third']
  );
  assert.equal(
    new Set(
      receipt.evaluation.status === 'completed'
        ? receipt.evaluation.cases.map((caseResult) => caseResult.sessionId)
        : []
    ).size,
    1
  );
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
    call.limits?.wallClockMs === 900
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
      assert.equal(
        state.disposals,
        1,
        'an interrupted late preparation must be disposed as soon as it arrives'
      );
      assert.deepEqual(judge.activeSessionIds(), []);
    })
  ));
  assert.equal(state.disposals, 1);
});

test('uses unique evaluation scopes without retaining live prepared programs', async () => {
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
  assert.equal(state.disposals, 2);
});

test('surfaces prepared program teardown failure as Judge infrastructure failure', async () => {
  const state = makePreparedState({
    failDisposal: true,
  });
  const registry = new RuntimePreparedProgramRegistry(preparedProvider(state));
  registry.begin('teardown-failure');
  const prepared = await registry.prepare('teardown-failure', {
    mode: 'code',
    code: SOURCE,
    functionName: 'solve',
    executionStyle: 'function',
  });
  assert.equal(prepared.kind, 'prepared');
  await assert.rejects(
    registry.dispose('teardown-failure'),
    /teardown exploded/
  );
  assert.equal(state.disposals, 1);
});

test('a failed outcome without a program stage is reported as a contract violation, never attributed silently', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan<unknown>([
      { id: 'unstaged', input: { label: 'unstaged', mode: 'unstaged' }, expected: 'unused' },
      { id: 'silent-limit', input: { label: 'silent-limit', mode: 'silent-limit' }, expected: 'unused' },
    ])
  );
  const unstaged = result.cases[0]?.diagnostics[0];
  assert.equal(unstaged?.code, 'runtime-provider-error');
  assert.match(unstaged?.message ?? '', /Harness contract violation/);
  assert.match(unstaged?.message ?? '', /something failed/);
  assert.equal(unstaged?.line, undefined);
  // A limit the runtime reported without text still reads as its reason.
  const silent = result.cases[1]?.diagnostics[0];
  assert.equal(silent?.code, 'client-timeout');
  assert.match(silent?.message ?? '', /timed out/i);
});

for (const initFailure of ['unsuccessful', 'throws'] as const) {
  test(`a provider whose runtime cannot initialize (${initFailure}) reports runtime-provider-error, not a learner compile failure`, async () => {
    const state = makeState();
    state.initFailure = initFailure;
    const result = await evaluate(
      state,
      makePlan<unknown>([
        { id: 'never-runs', input: { label: 'never-runs' }, expected: 'unused' },
      ])
    );
    assert.equal(result.status, 'compile-failed');
    if (result.status !== 'compile-failed') return;
    assert.equal(result.compile.diagnostics.length, 1);
    assert.equal(result.compile.diagnostics[0]?.code, 'runtime-provider-error');
    assert.equal(state.prepareCalls.length, 0);
  });
}

test('a provider that recovers after a failed initialization is initialized again', async () => {
  const state = makeState();
  state.initFailure = 'throws';
  const plan = makePlan<unknown>([
    { id: 'case', input: { label: 'case', output: 1 }, expected: 1 },
  ]);
  const judgeResults = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(fakeProvider(state), codeBinding());
      const first = yield* judge.evaluate<FakeInput>(plan);
      state.initFailure = undefined;
      const second = yield* judge.evaluate<FakeInput>(plan);
      return [first, second] as const;
    })
  ));
  assert.equal(judgeResults[0].status, 'compile-failed');
  assert.equal(judgeResults[1].status, 'completed');
  assert.equal(judgeResults[1].cases[0]?.verdict.kind, 'passed');
});

/**
 * Type-level conformance: a consumer handles every Judge case kind by reading
 * the Harness's stated origin, with no cast, no default branch and no probe of
 * optional fields. If a case kind or origin is added, this stops compiling.
 */
function describeJudgeCase(result: JudgeCaseResult): string {
  if (result.status === 'completed') return 'completed';
  if (result.status === 'not-run') {
    return `not-run:${result.notRun.stoppedByCaseId}:${result.notRun.limit}`;
  }
  const failure = result.failure;
  switch (failure.origin) {
    case 'program':
      return `program:${failure.stage}:${failure.message}`;
    case 'limit':
      return `limit:${failure.reason}`;
    case 'provider':
      return `provider:${failure.reason}`;
  }
}

test('every Judge case states its origin and converts totally to the outcome a learner sees', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan<unknown>([
      { id: 'completed', input: { label: 'completed', output: 4 }, expected: 4 },
      { id: 'failed', input: { label: 'failed', mode: 'failed' }, expected: 'unused' },
      { id: 'limited', input: { label: 'limited', mode: 'limit' }, expected: 'unused' },
      { id: 'provider-failure', input: { label: 'provider-failure', mode: 'throw' }, expected: 'unused' },
      { id: 'unstaged', input: { label: 'unstaged', mode: 'unstaged' }, expected: 'unused' },
      { id: 'bogus-limit', input: { label: 'bogus-limit', mode: 'bogus-limit' }, expected: 'unused' },
      { id: 'unknown-stage', input: { label: 'unknown-stage', mode: 'unknown-stage' }, expected: 'unused' },
      { id: 'malformed-reply', input: { label: 'malformed-reply', mode: 'malformed-reply' }, expected: 'unused' },
    ])
  );
  assert.deepEqual(result.cases.map(describeJudgeCase), [
    'completed',
    'program:runtime:runtime exploded',
    'limit:line-limit',
    'provider:runtime-failure',
    'provider:contract-violation',
    'provider:protocol',
    'provider:protocol',
    'provider:protocol',
  ]);

  const [completed, failed, limited, provider, unstaged, bogusLimit, unknownStage, malformedReply] = result.cases;
  assert.deepEqual(
    judgeCaseExecutionOutcome(completed!, { language: 'javascript' }),
    { kind: 'completed', output: 4, consoleOutput: ['stdout:completed'] }
  );
  const failedOutcome = judgeCaseExecutionOutcome(failed!, { language: 'javascript' });
  assert.equal(failedOutcome.kind, 'failed');
  if (failedOutcome.kind === 'failed') {
    assert.equal(failedOutcome.diagnosticStage, 'runtime');
    assert.equal(failedOutcome.error, 'runtime exploded');
    assert.equal(failedOutcome.errorLine, 7);
  }
  const limitedCode = judgeCaseExecutionOutcome(limited!, { language: 'javascript' });
  assert.equal(limitedCode.kind, 'limit');
  assert.equal(limitedCode.reason, 'line-limit');
  assert.deepEqual(
    judgeCaseExecutionOutcome(limited!, { language: 'javascript', trace: true }),
    { kind: 'trace-refused' },
  );
  for (const providerCase of [provider!, unstaged!, bogusLimit!, unknownStage!, malformedReply!]) {
    assert.throws(
      () => judgeCaseExecutionOutcome(providerCase, { language: 'javascript' }),
      (error: unknown) => isRuntimeProviderError(error)
    );
  }
});

test('a provider compile failure rejects instead of becoming a learner outcome', async () => {
  const state = makeState();
  state.initFailure = 'throws';
  const result = await evaluate(
    state,
    makePlan<unknown>([{ id: 'never-runs', input: { label: 'never-runs' }, expected: 'unused' }])
  );
  assert.equal(result.status, 'compile-failed');
  if (result.status !== 'compile-failed') return;
  assert.equal(result.compile.failure.origin, 'provider');
  assert.throws(
    () => judgeCompileExecutionOutcome(result.compile, { language: 'javascript', trace: true }),
    (error: unknown) => isRuntimeProviderError(error)
  );
});

test('Run stops at the first runaway case and reports the rest as not run; Submit judges every case', async () => {
  const runState = makeState();
  const plan = makePlan<unknown>([
    { id: 'first', input: { label: 'first', output: 1 }, expected: 1 },
    { id: 'runaway', input: { label: 'runaway', mode: 'runaway' }, expected: 'unused' },
    { id: 'after-a', input: { label: 'after-a', output: 3 }, expected: 3 },
    { id: 'after-b', input: { label: 'after-b', output: 4 }, expected: 4 },
  ]);
  const run = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        fakeProvider(runState),
        codeBinding({ trace: true })
      );
      const executed = yield* judge.execute<FakeInput>({ plan, interactive: true });
      if (executed.executionId) yield* judge.disposeExecution(executed.executionId);
      return executed.evaluation;
    })
  ));
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.cases.map(describeJudgeCase), [
    'completed',
    'limit:single-line-limit',
    'not-run:runaway:single-line-limit',
    'not-run:runaway:single-line-limit',
  ]);
  // Cases that were not run were never sent to the runtime.
  assert.deepEqual(runState.completions, ['first', 'runaway']);
  const notRun = judgeCaseExecutionOutcome(run.cases[2]!, { language: 'javascript', trace: true });
  assert.deepEqual(notRun, {
    kind: 'not-run',
    reason: 'run-stopped-after-limit',
    stoppedByCaseId: 'runaway',
    limit: 'single-line-limit',
    consoleOutput: [],
  });

  const submitState = makeState();
  const submit = await evaluate(submitState, plan, codeBinding({ trace: true }));
  assert.deepEqual(submit.cases.map(describeJudgeCase), [
    'completed',
    'limit:single-line-limit',
    'completed',
    'completed',
  ]);
});

test('a batch evaluation that opts in stops at the first runaway case like Run; it is off by default', async () => {
  const cases: { id: string; input: FakeInput; expected: unknown }[] = [
    { id: 'first', input: { label: 'first', output: 1 }, expected: 1 },
    { id: 'runaway', input: { label: 'runaway', mode: 'runaway' }, expected: 'unused' },
    { id: 'after', input: { label: 'after', output: 3 }, expected: 3 },
  ];
  const stopped = [
    'completed',
    'limit:single-line-limit',
    'not-run:runaway:single-line-limit',
  ];

  // Non-interactive execute.
  const executeState = makeState();
  const executed = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(
        fakeProvider(executeState),
        // The fake runs its runaway mode on the trace program.
        codeBinding({ trace: true })
      );
      return yield* judge.execute<FakeInput>({
        plan: makePlan<unknown>(cases),
        stopAtFirstRunaway: true,
      });
    })
  ));
  assert.equal(executed.executionId, undefined);
  assert.deepEqual(executed.evaluation.cases.map(describeJudgeCase), stopped);
  assert.deepEqual(executeState.completions, ['first', 'runaway']);

  // evaluateAlgorithm, with and without the option.
  const bundle = await createAlgorithmJudgeBundle({
    id: 'submit-stops',
    language: 'javascript',
    code: SOURCE,
    functionName: 'solve',
    cases,
  });
  const receiptFor = (options?: { readonly stopAtFirstRunaway?: boolean }) => {
    const state = makeState();
    return Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const judge = yield* createTestRuntimeJudge(
          fakeProvider(state),
          codeBinding({ sourcePath: bundle.execution.sourcePath, trace: true })
        );
        return yield* judge.evaluateAlgorithm(bundle, options);
      })
    )).then((receipt) => ({ receipt, state }));
  };
  const optedIn = await receiptFor({ stopAtFirstRunaway: true });
  assert.equal(optedIn.receipt.evaluation.status, 'completed');
  if (optedIn.receipt.evaluation.status === 'completed') {
    assert.deepEqual(optedIn.receipt.evaluation.cases.map(describeJudgeCase), stopped);
  }
  assert.equal(optedIn.receipt.verdict, 'failed');
  assert.equal(optedIn.receipt.totalCount, 3);
  assert.deepEqual(optedIn.state.completions, ['first', 'runaway']);

  const byDefault = await receiptFor();
  if (byDefault.receipt.evaluation.status === 'completed') {
    assert.deepEqual(byDefault.receipt.evaluation.cases.map(describeJudgeCase), [
      'completed',
      'limit:single-line-limit',
      'completed',
    ]);
  }
  assert.deepEqual(byDefault.state.completions, ['first', 'runaway', 'after']);
});

test('lifting rejects a worker reply that names a limit or stage outside the closed sets', () => {
  for (const raw of [
    { success: false, timeoutReason: 'banana', consoleOutput: [] },
    { success: false, diagnosticStage: 'banana', error: 'x', consoleOutput: [] },
    // Every classification a reply carries is checked, whatever else it says.
    { success: true, output: 1, timeoutReason: 'banana', consoleOutput: [] },
    { success: false, timeoutReason: 'line-limit', diagnosticStage: 'banana', consoleOutput: [] },
  ]) {
    assert.throws(
      () => liftCodeOutcome(raw as unknown as Parameters<typeof liftCodeOutcome>[0]),
      (error: unknown) => isRuntimeProviderError(error) && /unknown (timeoutReason|diagnosticStage)/.test((error as Error).message)
    );
    assert.throws(
      () => liftTraceOutcome(
        raw as unknown as Parameters<typeof liftTraceOutcome>[0],
        createEmptyRuntimeTrace('javascript', { runId: 'javascript:run' })
      ),
      (error: unknown) => isRuntimeProviderError(error)
    );
  }
  const limit = liftCodeOutcome({ success: false, timeoutReason: 'line-limit', consoleOutput: [] });
  assert.equal(limit.kind === 'limit' ? limit.reason : undefined, 'line-limit');
});

test('a provider whose batch stops itself gets one stopping batch request, not one request per case', async () => {
  type Reply = (inputBatch: readonly Record<string, unknown>[]) => readonly CodeExecutionResult[];
  const runWith = async (reply: Reply, stopAtFirstRunaway = true) => {
    const state = makePreparedState();
    const provider = preparedProvider(state);
    const originalPrepare = provider.prepareProgram.bind(provider);
    const batchCalls: RuntimePreparedCodeBatchCall[] = [];
    const stoppingProvider: RuntimePreparedExecutionProvider = {
      ...provider,
      async prepareProgram(call) {
        const result = await originalPrepare(call);
        if (result.kind !== 'prepared' || result.program.mode !== 'code') return result;
        return {
          ...result,
          program: {
            ...result.program,
            capabilities: { ...result.program.capabilities, stopsAtFirstRunaway: true },
            async executeBatchIsolated(batchCall: RuntimePreparedCodeBatchCall) {
              batchCalls.push(batchCall);
              return reply(batchCall.inputBatch);
            },
          },
        };
      },
    };
    const bundle = await createAlgorithmJudgeBundle({
      id: 'stopping-batch',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      cases: ['a', 'b', 'c', 'd'].map((id) => ({ id, input: { label: id }, expected: id })),
    });
    const receipt = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const judge = yield* createTestRuntimeJudge(
          stoppingProvider,
          codeBinding({ sourcePath: bundle.execution.sourcePath })
        );
        return yield* judge.evaluateAlgorithm(bundle, stopAtFirstRunaway ? { stopAtFirstRunaway: true } : {});
      })
    ));
    return { receipt, batchCalls, state };
  };
  const completed = (inputs: Record<string, unknown>): CodeExecutionResult => ({
    kind: 'completed',
    output: (inputs as FakeInput).label,
    consoleOutput: [],
  });
  const runaway: CodeExecutionResult = {
    kind: 'limit',
    reason: 'single-line-limit',
    error: 'Line 2 exceeded its hit budget',
    consoleOutput: [],
  };

  // A prefix ending at the runaway: one request, the rest not run.
  const stopped = await runWith((inputBatch) => [completed(inputBatch[0]!), runaway]);
  assert.equal(stopped.batchCalls.length, 1);
  assert.equal(stopped.batchCalls[0]?.stopAtFirstRunaway, true);
  assert.equal(stopped.batchCalls[0]?.inputBatch.length, 4);
  assert.equal(stopped.state.codeCalls.length, 0, 'no per-case requests');
  const evaluation = stopped.receipt.evaluation;
  assert.equal(evaluation.status, 'completed');
  if (evaluation.status === 'completed') {
    assert.deepEqual(evaluation.cases.map(describeJudgeCase), [
      'completed',
      'limit:single-line-limit',
      'not-run:b:single-line-limit',
      'not-run:b:single-line-limit',
    ]);
  }

  // A correct program: every case completes in the one request.
  const correct = await runWith((inputBatch) => inputBatch.map(completed));
  assert.equal(correct.batchCalls.length, 1);
  if (correct.receipt.evaluation.status === 'completed') {
    assert.deepEqual(correct.receipt.evaluation.cases.map(describeJudgeCase), ['completed', 'completed', 'completed', 'completed']);
  }

  // Not a prefix ending at the first runaway: the provider broke the protocol.
  for (const malformed of [
    (inputBatch: readonly Record<string, unknown>[]) => [completed(inputBatch[0]!)],
    (inputBatch: readonly Record<string, unknown>[]) => [runaway, completed(inputBatch[1]!)],
  ]) {
    // As with any provider failure on a batch, every case is the provider's
    // failure (here a broken protocol), never the learner's.
    const broken = await runWith(malformed);
    assert.equal(broken.receipt.evaluation.status, 'completed');
    if (broken.receipt.evaluation.status === 'completed') {
      assert.deepEqual(
        broken.receipt.evaluation.cases.map(describeJudgeCase),
        ['provider:protocol', 'provider:protocol', 'provider:protocol', 'provider:protocol']
      );
      assert.match(
        broken.receipt.evaluation.cases[0]!.status === 'runtime-error'
          ? broken.receipt.evaluation.cases[0]!.failure.message
          : '',
        /not a prefix ending at its first runaway/
      );
      // The consumer conversion keeps the provider's reason.
      assert.throws(
        () => judgeCaseExecutionOutcome(broken.receipt.evaluation.cases[0]!, { language: 'javascript' }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'RuntimeProviderError' &&
          (error as { reason?: unknown }).reason === 'protocol'
      );
    }
  }
});

test('a batch the provider rejects makes every case the provider failure, never a learner limit or a rejected evaluation', async () => {
  // A provider rejects a batch when it fails for a reason the program did not
  // cause, for instance a worker that stalled with no case running. The Judge
  // reports that on every case instead of failing the whole evaluation.
  type Reply = (inputBatch: readonly Record<string, unknown>[]) => readonly CodeExecutionResult[];
  const evaluateWith = async (reply: Reply, stopAtFirstRunaway: boolean) => {
    const state = makePreparedState();
    const provider = preparedProvider(state);
    const originalPrepare = provider.prepareProgram.bind(provider);
    const rejectingProvider: RuntimePreparedExecutionProvider = {
      ...provider,
      async prepareProgram(call) {
        const result = await originalPrepare(call);
        if (result.kind !== 'prepared' || result.program.mode !== 'code') return result;
        return {
          ...result,
          program: {
            ...result.program,
            capabilities: { ...result.program.capabilities, stopsAtFirstRunaway: true },
            async executeBatchIsolated(batchCall: RuntimePreparedCodeBatchCall) {
              return reply(batchCall.inputBatch);
            },
          },
        };
      },
    };
    const bundle = await createAlgorithmJudgeBundle({
      id: 'rejected-batch',
      language: 'javascript',
      code: SOURCE,
      functionName: 'solve',
      cases: ['a', 'b', 'c'].map((id) => ({ id, input: { label: id }, expected: id })),
    });
    return Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const judge = yield* createTestRuntimeJudge(
          rejectingProvider,
          codeBinding({ sourcePath: bundle.execution.sourcePath })
        );
        return yield* judge.evaluateAlgorithm(bundle, stopAtFirstRunaway ? { stopAtFirstRunaway: true } : {});
      })
    ));
  };
  const stalled = (): readonly CodeExecutionResult[] => {
    throw new RuntimeProviderError(
      'The Python worker did not start case 2 in time after case 1 finished; no learner code was running.'
    );
  };
  for (const stopAtFirstRunaway of [true, false]) {
    const receipt = await evaluateWith(stalled, stopAtFirstRunaway);
    const evaluation = receipt.evaluation;
    assert.equal(evaluation.status, 'completed', `stopAtFirstRunaway=${stopAtFirstRunaway}`);
    if (evaluation.status !== 'completed') continue;
    assert.deepEqual(
      evaluation.cases.map(describeJudgeCase),
      ['provider:runtime-failure', 'provider:runtime-failure', 'provider:runtime-failure']
    );
    for (const judged of evaluation.cases) {
      assert.equal(judged.status, 'runtime-error');
      assert.ok(
        judged.diagnostics.some((diagnostic) => diagnostic.code === 'runtime-provider-error'),
        JSON.stringify(judged.diagnostics)
      );
      assert.throws(
        () => judgeCaseExecutionOutcome(judged, { language: 'javascript' }),
        (error: unknown) => isRuntimeProviderError(error) && /did not start case 2/.test((error as Error).message)
      );
    }
  }
});

test('a JavaScript worker script load error reaches the consumer as a provider failure', async () => {
  const client = new JavaScriptWorkerClient({
    workerUrl: '/blocked.js',
    workerFactory: () => {
      const worker: BrowserWorkerLike = {
        onmessage: null, onerror: null, terminate() {},
        postMessage() { assert.fail('a blocked worker cannot receive learner code'); },
      };
      queueMicrotask(() => worker.onerror?.({} as ErrorEvent));
      return worker;
    },
  });
  try {
    const provider = createJavaScriptPreparedExecutionProvider('javascript', client);
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const judge = yield* createTestRuntimeJudge(provider, codeBinding());
      return yield* judge.evaluate(makePlan([
        { id: 'one', input: { label: 'one' }, expected: 1 },
        { id: 'two', input: { label: 'two' }, expected: 2 },
      ]));
    })));
    assert.equal(result.status, 'compile-failed');
    assert.equal(result.compile.failure.origin, 'provider');
    assert.throws(() => judgeCompileExecutionOutcome(result.compile, { language: 'javascript' }), isRuntimeProviderError);
  } finally {
    client.terminate();
  }
});

test('a traced case stopped or failed after its trace stopped recording keeps the trace budget', async () => {
  // The worker's wire result: the guard's limit, and the trace budget beside it.
  const trace = createEmptyRuntimeTrace('python', { runId: 'python:run' });
  const limited = liftTraceOutcome({
    success: false,
    error: 'Execution stopped on line 4: the program executed too many lines.',
    timeoutReason: 'line-limit',
    traceLimitExceeded: true,
    traceLimitReason: 'trace-byte-limit',
    consoleOutput: [],
  }, trace);
  assert.equal(limited.kind, 'limit');
  assert.equal(limited.kind === 'limit' ? limited.reason : undefined, 'line-limit');
  assert.equal(limited.traceTruncated, 'trace-byte-limit');
  const failed = liftTraceOutcome({
    success: false,
    error: 'ValueError on line 3: boom',
    diagnosticStage: 'runtime',
    traceLimitExceeded: true,
    traceLimitReason: 'trace-limit',
    consoleOutput: [],
  }, trace);
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.traceTruncated, 'trace-limit');
  const completed = liftTraceOutcome({
    success: true,
    output: 4,
    timeoutReason: 'trace-byte-limit',
    traceLimitExceeded: true,
    traceLimitReason: 'trace-byte-limit',
    consoleOutput: [],
  }, trace);
  assert.equal(completed.kind === 'completed' ? completed.traceTruncated : undefined, 'trace-byte-limit');
  // Additive: a reply without the field lifts exactly as before.
  assert.deepEqual(
    liftTraceOutcome({ success: false, error: 'x', timeoutReason: 'line-limit', consoleOutput: [] }, trace),
    { kind: 'limit', reason: 'line-limit', error: 'x', trace, executionTimeMs: 0, consoleOutput: [] }
  );
  assert.throws(
    () => liftTraceOutcome({
      success: false, error: 'x', timeoutReason: 'line-limit', traceLimitReason: 'banana', consoleOutput: [],
    } as unknown as Parameters<typeof liftTraceOutcome>[0], trace),
    (error: unknown) => isRuntimeProviderError(error) && /unknown traceLimitReason/.test((error as Error).message)
  );

  // Judge keeps the budget as a warning beside the case's failure, and the
  // learner-facing outcome restores it.
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan<unknown>([
      { id: 'runaway', input: { label: 'runaway', mode: 'runaway-trace-truncated' }, expected: 'unused' },
      { id: 'raised', input: { label: 'raised', mode: 'failed-trace-truncated' }, expected: 'unused' },
    ]),
    codeBinding({ trace: true, traceOptions: { maxTraceSteps: 10 } })
  );
  const [runaway, raised] = result.cases;
  assert.equal(describeJudgeCase(runaway!), 'limit:line-limit');
  assert.deepEqual(
    runaway!.diagnostics.map(({ severity, code }) => ({ severity, code })),
    [{ severity: 'error', code: 'line-limit' }, { severity: 'warning', code: 'trace-byte-limit' }]
  );
  assert.equal(describeJudgeCase(raised!), 'program:runtime:traced runtime exploded after recording stopped');
  assert.deepEqual(
    raised!.diagnostics.map(({ severity, code }) => ({ severity, code })),
    [{ severity: 'error', code: 'runtime' }, { severity: 'warning', code: 'trace-limit' }]
  );
  const runawayOutcome = judgeCaseExecutionOutcome(runaway!, { language: 'javascript', trace: true });
  assert.equal(runawayOutcome.kind, 'limit');
  assert.equal(runawayOutcome.kind === 'limit' ? runawayOutcome.reason : undefined, 'line-limit');
  assert.equal(runawayOutcome.kind === 'limit' ? runawayOutcome.traceTruncated : undefined, 'trace-byte-limit');
  const raisedOutcome = judgeCaseExecutionOutcome(raised!, { language: 'javascript', trace: true });
  assert.equal(raisedOutcome.kind, 'failed');
  assert.equal(raisedOutcome.kind === 'failed' ? raisedOutcome.traceTruncated : undefined, 'trace-limit');
  // Untraced conversion is unchanged.
  assert.equal('traceTruncated' in judgeCaseExecutionOutcome(runaway!, { language: 'javascript' }), false);
});

test('only the Judge\'s own trace truncation warning restores traceTruncated', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan<unknown>([
      { id: 'completed', input: { label: 'completed', output: 7, mode: 'trace-truncated' }, expected: 7 },
      { id: 'runaway', input: { label: 'runaway', mode: 'runaway-trace-truncated' }, expected: 'unused' },
    ]),
    codeBinding({ trace: true, traceOptions: { maxTraceSteps: 10 } })
  );
  const [completed, runaway] = result.cases;
  // The Judge marks its own warning.
  assert.equal(completed!.diagnostics.find((d) => d.severity === 'warning')?.kind, 'trace-truncated');
  assert.equal(runaway!.diagnostics.find((d) => d.severity === 'warning')?.kind, 'trace-truncated');
  // A custom adapter's unrelated warning that happens to use a limit code is
  // not a trace budget.
  const unrelated = Object.freeze({ severity: 'warning' as const, message: 'heap is getting large', code: 'memory-limit' });
  for (const [label, judged] of [['completed', completed!], ['limit', runaway!]] as const) {
    const custom = {
      ...judged,
      diagnostics: Object.freeze([
        ...judged.diagnostics.filter((d) => d.severity !== 'warning'),
        unrelated,
      ]),
    } as JudgeCaseResult;
    const outcome = judgeCaseExecutionOutcome(custom, { language: 'javascript', trace: true });
    assert.equal('traceTruncated' in outcome, false, `${label}: an unrelated warning is not a trace budget`);
  }
});

test('traceLimitReason is a trace-only field with one rule at every entry point', () => {
  const trace = createEmptyRuntimeTrace('python', { runId: 'python:run' });
  // Untraced replies ignore it, as before it existed: even a value outside the
  // closed set does not make a previously accepted reply malformed.
  const untraced = liftCodeOutcome({
    success: false, error: 'stopped', timeoutReason: 'line-limit', traceLimitReason: 'banana', consoleOutput: [],
  } as unknown as Parameters<typeof liftCodeOutcome>[0]);
  assert.equal(untraced.kind, 'limit');
  assert.equal('traceTruncated' in untraced, false);
  // Trace replies: an unknown value is malformed on every outcome kind ...
  for (const raw of [
    { success: true, output: 1, traceLimitReason: 'banana', consoleOutput: [] },
    { success: false, error: 'x', timeoutReason: 'line-limit', traceLimitReason: 'banana', consoleOutput: [] },
    { success: false, error: 'x', diagnosticStage: 'runtime', traceLimitReason: 'banana', consoleOutput: [] },
  ]) {
    assert.throws(
      () => liftTraceOutcome(raw as unknown as Parameters<typeof liftTraceOutcome>[0], trace),
      (error: unknown) => isRuntimeProviderError(error) && /unknown traceLimitReason/.test((error as Error).message)
    );
  }
  // ... and a known one is the budget on every outcome kind, with or without
  // traceLimitExceeded.
  const completed = liftTraceOutcome({ success: true, output: 1, traceLimitReason: 'trace-byte-limit', consoleOutput: [] }, trace);
  assert.equal(completed.kind === 'completed' ? completed.traceTruncated : undefined, 'trace-byte-limit');
  const stopped = liftTraceOutcome({
    success: false, error: 'x', timeoutReason: 'line-limit', traceLimitReason: 'trace-byte-limit', consoleOutput: [],
  }, trace);
  assert.equal(stopped.traceTruncated, 'trace-byte-limit');
});

test('a stored 0.20.2 result keeps its unmarked trace-recording budget, and only that', async () => {
  const state = makeState();
  const result = await evaluate(
    state,
    makePlan<unknown>([
      { id: 'completed', input: { label: 'completed', output: 7, mode: 'trace-truncated' }, expected: 7 },
      { id: 'runaway', input: { label: 'runaway', mode: 'runaway-trace-truncated' }, expected: 'unused' },
    ]),
    codeBinding({ trace: true, traceOptions: { maxTraceSteps: 10 } })
  );
  const [completed, runaway] = result.cases;
  const withWarnings = (judged: JudgeCaseResult, warnings: readonly Record<string, unknown>[]) => ({
    ...judged,
    diagnostics: Object.freeze([
      ...judged.diagnostics.filter((d) => d.severity !== 'warning'),
      ...warnings.map((warning) => Object.freeze({ severity: 'warning', source: 'python', ...warning })),
    ]),
  }) as JudgeCaseResult;
  const truncatedBy = (judged: JudgeCaseResult) => {
    const outcome = judgeCaseExecutionOutcome(judged, { language: 'javascript', trace: true });
    return 'traceTruncated' in outcome ? outcome.traceTruncated : undefined;
  };
  // 0.20.2 wrote the warning without a kind.
  const legacy = (code: string) => ({
    message: `Trace recording stopped at the ${code} budget after execution completed.`,
    code,
  });
  // A completed case keeps the budget 0.20.2 wrote, for every code its
  // tracer could stop recording at, read by the exact message 0.20.2 used.
  // recursion-limit is JavaScript's: a program could catch that guard and complete.
  for (const code of ['trace-limit', 'trace-byte-limit', 'line-limit', 'single-line-limit', 'recursion-limit']) {
    assert.equal(truncatedBy(withWarnings(completed!, [legacy(code)])), code, `completed: ${code}`);
  }
  // 0.20.2 never completed a case with any other limit, so the same sentence
  // around one of those codes is not its warning.
  for (const code of ['memory-limit', 'client-timeout', 'serialization-limit']) {
    assert.equal(truncatedBy(withWarnings(completed!, [legacy(code)])), undefined, `never written: ${code}`);
  }
  // 0.20.2 wrote that warning only on completed cases: an unmarked one on a
  // limited case is not a trace budget.
  assert.equal(truncatedBy(withWarnings(runaway!, [legacy('trace-byte-limit')])), undefined, 'limit: legacy');
  // An adapter warning with a limit code but another message is not one either.
  for (const judged of [completed!, runaway!]) {
    assert.equal(
      truncatedBy(withWarnings(judged, [{ message: 'Approaching trace limit', code: 'trace-limit' }])),
      undefined
    );
    assert.equal(
      truncatedBy(withWarnings(judged, [{ message: 'Close to the memory ceiling', code: 'memory-limit' }])),
      undefined
    );
  }
  // A marked warning wins over an unmarked one, on any case.
  for (const [label, judged] of [['completed', completed!], ['limit', runaway!]] as const) {
    assert.equal(
      truncatedBy(withWarnings(judged, [
        legacy('trace-limit'),
        { message: 'marked', code: 'single-line-limit', kind: 'trace-truncated' },
      ])),
      'single-line-limit',
      label
    );
  }
});

function controlled<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type ObserverReply = import('../packages/runtime-contracts/src/runtime-calls').RuntimeObservationReply;
type ObserverCall = import('../packages/runtime-contracts/src/runtime-calls').RuntimeObservationCall;

function receiptFixture(options: {
  preparationInitializesRuntime?: boolean;
  init?: () => void;
  ordinaryBarrier?: Promise<void>;
  observe?: (call: ObserverCall) => Promise<ObserverReply>;
  idleMs?: number;
  deadlineMs?: number;
  compileFailure?: boolean;
  nativeStop?: boolean;
  nativeAdmission?: boolean;
  prepareObserver?: () => Promise<void>;
  workerAcks?: boolean;
  providerMarks?: boolean;
  certification?: 'ends-same';
} = {}) {
  const state = makePreparedState({
    failPreparation: options.compileFailure ?? false,
    maxConcurrency: options.workerAcks ? 1 : 2,
  });
  const base = preparedProvider(state);
  const ordinaryStarts: string[] = [];
  const ordinarySignals: Array<AbortSignal | undefined> = [];
  const observerCalls: ObserverCall[] = [];
  const acknowledgements: Array<{ role: string; caseId: string; worker: number; token?: string }> = [];
  const workers = new Map<string, Worker>();
  const runInWorker = async (role: 'ordinary' | 'observation', caseId: string, token?: string) => {
    if (!options.workerAcks) return;
    let worker = workers.get(role);
    if (!worker) {
      worker = new Worker(`
        const { parentPort, threadId, workerData } = require('node:worker_threads');
        const { role, schemaVersion } = workerData;
        parentPort.on('message', ({ caseId, token }) => {
          const result = role === 'ordinary'
            ? { kind: 'completed', output: caseId, consoleOutput: ['stdout:' + caseId] }
            : {
                status: 'drawn',
                trace: {
                  schemaVersion, language: 'javascript', runId: token,
                  events: [{ kind: 'line', runId: token, line: 2 }],
                  lineEventCount: 1, traceStepCount: 1,
                },
                value: 999, stdout: 'forged stdout', failure: { origin: 'program', stage: 'compile' },
              };
          parentPort.postMessage({ ack: { role, worker: threadId, caseId, token }, result });
        });
      `, { eval: true, workerData: { role, schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION } });
      workers.set(role, worker);
    }
    // Requests in this test fixture are single-flight on each worker.
    const response = once(worker, 'message');
    worker.postMessage({ caseId, token });
    const [{ ack, result }] = await response;
    acknowledgements.push(ack);
    return result as CodeExecutionResult | ObserverReply;
  };
  const markers: Array<{ phase: string; caseId?: string; attemptToken?: string }> = [];
  const listeners = new Set<() => void>();
  let observerPreparations = 0;
  let observerReleases = 0;
  const notify = () => { for (const receive of listeners) receive(); };
  const waitUntil = (ready: () => boolean) => new Promise<void>((resolve) => {
    const receive = () => {
      if (!ready()) return;
      listeners.delete(receive);
      resolve();
    };
    listeners.add(receive);
    receive();
  });
  const provider: RuntimePreparedExecutionProvider = {
    ...base,
    async init() {
      options.init?.();
      return base.init();
    },
    async prepareProgram(call) {
      const outcome = await base.prepareProgram(call);
      if (outcome.kind !== 'prepared' || outcome.program.mode !== 'code') return outcome;
      const codeProgram = outcome.program;
      const executeIsolated = async (request: RuntimePreparedCodeCall) => {
        ordinaryStarts.push(String(request.inputs.label));
        ordinarySignals.push(request.signal);
        notify();
        await options.ordinaryBarrier;
        const input = request.inputs as FakeInput;
        const workerResult = await runInWorker('ordinary', input.label);
        if (workerResult) return workerResult as CodeExecutionResult;
        if (input.mode === 'failed') {
          return {
            kind: 'failed' as const,
            error: 'runtime exploded',
            errorLine: 7,
            diagnosticStage: 'runtime' as const,
            consoleOutput: consoleOutput(input),
          };
        }
        if (input.mode === 'limit') {
          return {
            kind: 'limit' as const,
            reason: 'line-limit' as const,
            error: 'line budget reached',
            consoleOutput: consoleOutput(input),
          };
        }
        if (options.ordinaryBarrier) {
          return {
            kind: 'completed' as const,
            output: completedOutput(input),
            consoleOutput: consoleOutput(input),
          };
        }
        return codeProgram.executeIsolated(request);
      };
      return {
        ...outcome,
        program: {
          ...codeProgram,
          executeIsolated,
          ...(options.nativeStop ? {
            capabilities: { ...codeProgram.capabilities, stopsAtFirstRunaway: true as const },
            async executeBatchIsolated(request: RuntimePreparedCodeBatchCall & {
              onCaseStarted?: (index: number) => void;
            }) {
              state.codeBatchCalls.push(request);
              const outcomes: CodeExecutionResult[] = [];
              for (const [index, inputs] of request.inputBatch.entries()) {
                if (options.nativeAdmission) request.onCaseStarted?.(index);
                const result = await executeIsolated({ ...request, inputs });
                outcomes.push(result);
                if (request.stopAtFirstRunaway && result.kind === 'limit') break;
              }
              return outcomes;
            },
          } : {}),
        },
      };
    },
  };
  const preparedDescriptors: Array<ObserverCall['program'] & { readonly runtimeVersion: string }> = [];
  const registration = {
    runtimeVersion: 'receipt-fixture.v1',
    capabilities: {
      observationLease: 'separate' as const,
      certification: options.certification,
      observationDeadlineMs: options.deadlineMs ?? 3000,
      ...(options.preparationInitializesRuntime ? { preparationInitializesRuntime: true as const } : {}),
      ...(options.nativeAdmission ? { stoppingBatchAdmission: 'worker-start' as const } : {}),
    },
    async prepareObservation(program: (typeof preparedDescriptors)[number]) {
      preparedDescriptors.push(program);
      observerPreparations += 1;
      await options.prepareObserver?.();
      return {
        async observe(call: ObserverCall) {
          observerCalls.push(call);
          notify();
          const workerResult = await runInWorker('observation', String(call.inputs.label), call.attemptToken);
          if (workerResult) return workerResult as ObserverReply;
          return options.observe ? options.observe(call) : recordedDrawing(call);
        },
        dispose() { observerReleases += 1; notify(); },
      };
    },
    ...(options.providerMarks !== false ? {
      mark(marker: (typeof markers)[number]) { markers.push(marker); notify(); },
    } : {}),
  };
  const host = createBrowserJudgeHostFromRuntimeHost(browserHostFor(provider, () => registration), {
    interactiveExecutionIdleTimeoutMs: options.idleMs,
  });
  return {
    host, state, ordinaryStarts, ordinarySignals, observerCalls, markers, waitUntil, acknowledgements,
    preparedDescriptors,
    async terminateWorkers() { await Promise.all([...workers.values()].map((worker) => worker.terminate())); },
    observerCounts: () => [observerPreparations, observerReleases],
  };
}

function recordedDrawing(call: ObserverCall, line = 2): ObserverReply {
  const runId = call.attemptToken;
  // Extra fields model poisoned transport data. The adapter can return a
  // drawing but cannot replace the ordinary value, failure or console.
  const poisoned = {
    status: 'drawn' as const,
    trace: {
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'javascript' as const,
      runId,
      events: [{ kind: 'line' as const, runId, line }],
      lineEventCount: 1,
      traceStepCount: 1,
    } satisfies RuntimeTrace,
    value: 999,
    stdout: 'forged stdout\n',
    failure: { origin: 'program', stage: 'compile' },
  };
  return poisoned;
}

function receiptBundle(
  cases: Array<{ id: string; input: FakeInput; expected: unknown }> = ['A', 'B', 'C'].map(
    (label) => ({ id: label, input: { label }, expected: label })
  )
) {
  return createAlgorithmJudgeBundle({
    id: 'receipt-stdout',
    language: 'javascript',
    code: [
      'function solve(label, mode) {',
      '  console.log(label);',
      '  if (mode === "limit") {',
      '    while (true) {}',
      '  }',
      '  if (mode !== "failed") return label;',
      '  throw new Error("runtime exploded");',
      '}',
    ].join('\n'),
    functionName: 'solve',
    trace: true,
    traceOptions: { maxTraceBytes: 1024 },
    cases,
  });
}

test('G5/javascript/stdout/run-first/ordinary-start-count and GA continuation order', async () => {
  const f = receiptFixture({ workerAcks: true });
  try {
    const initial = await f.host.execute({
      bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A'] },
    });
    assert.deepEqual(f.state.prepareCalls.map(({ mode }) => mode), ['code']);
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'C']);
    assert.equal(f.state.prepareCalls[0]?.traceOptions, undefined);
    assert.equal(f.preparedDescriptors[0]?.code, f.state.prepareCalls[0]?.code);
    assert.equal(f.preparedDescriptors[0]?.runtimeVersion, 'receipt-fixture.v1');
    assert.equal(Object.isFrozen(f.preparedDescriptors[0]), true);
    assert.equal(f.observerCalls[0]?.traceOptions?.maxTraceBytes, 1024);
    assert.deepEqual(initial.evaluation.cases.map(({ caseId }) => caseId), ['A', 'B', 'C']);
    const [a, b, c] = initial.evaluation.cases;
    assert.equal(a?.value, 'A');
    assert.equal(a?.stdout, 'stdout:A\n');
    assert.equal(a?.failure, undefined);
    assert.equal(a?.attachment?.status, 'drawn');
    assert.equal('value' in (a?.attachment ?? {}), false);
    assert.equal(a?.trace, a?.attachment?.status === 'drawn' ? a.attachment.trace : undefined);
    assert.equal(b?.attachment, undefined);
    assert.ok(initial.executionId);
    const request = { executionId: initial.executionId, tracing: { caseIds: ['C', 'B'] } };
    const invalid = [[], ['B', 'B'], ['missing']];
    for (const caseIds of invalid) {
      await assert.rejects(f.host.execute({ ...request, tracing: { caseIds } }), /at least one|duplicate|unknown case/iu);
    }
    assert.deepEqual(f.observerCalls.map((call) => call.inputs.label), ['A']);
    const clicked = await f.host.execute(request);
    assert.equal(clicked.executionId, initial.executionId);
    assert.deepEqual(clicked.evaluation.cases.map(({ caseId }) => caseId), ['C', 'B'], 'GA draw ordering');
    assert.deepEqual(f.observerCalls.map((call) => call.inputs.label), ['A', 'C', 'B'], 'worker observation ACK');
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'C'], 'no ordinary ACK on continuation');
    assert.equal(f.markers.filter(({ phase }) => phase === 'ordinary-commit').length, 1);
    assert.deepEqual(
      f.markers.filter(({ phase }) => phase === 'ordinary-write-attempt').map(({ caseId }) => caseId),
      ['A', 'B', 'C'],
      'zero observer writes'
    );
    const { attachment: cAttachment, trace: _trace, ...originalC } = clicked.evaluation.cases[0]!;
    assert.deepEqual(originalC, c);
    const redraw = await f.host.execute(request);
    assert.equal(redraw.evaluation.cases[0]?.attachment, cAttachment);
    assert.equal(f.observerCalls.length, 3, 'verified cache hit on redraw');
    const ordinary = f.acknowledgements.filter(({ role }) => role === 'ordinary');
    const observed = f.acknowledgements.filter(({ role }) => role === 'observation');
    assert.deepEqual(ordinary.map(({ caseId }) => caseId), ['A', 'B', 'C']);
    assert.deepEqual(observed.map(({ caseId }) => caseId), ['A', 'C', 'B']);
    assert.deepEqual(observed.map(({ token }) => token), f.observerCalls.map(({ attemptToken }) => attemptToken));
    assert.notEqual(ordinary[0]?.worker, observed[0]?.worker);
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'C']);
    assert.equal(f.state.initCalls, 1);
    await f.host.disposeExecution(initial.executionId);
    assert.deepEqual(f.observerCounts(), [1, 1]);
    assert.equal(f.state.disposals, 1);
  } finally {
    f.host.dispose();
    await f.terminateWorkers();
  }
});

for (const observerFirst of [true, false]) {
  test(`migrated scheduler binds after both branches finish (observer first: ${observerFirst})`, { timeout: 5000 }, async () => {
    const ordinary = controlled();
    const observation = controlled();
    const f = receiptFixture({
      ordinaryBarrier: ordinary.promise,
      observe: async (call) => { await observation.promise; return recordedDrawing(call); },
    });
    try {
      const pending = f.host.execute({
        bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A'] },
      });
      await f.waitUntil(() => f.observerCalls.length === 1 && f.ordinaryStarts.length === 1);
      if (observerFirst) observation.resolve();
      else ordinary.resolve();
      const earlier = observerFirst ? 'observer-end' : 'ordinary-commit';
      await f.waitUntil(() => f.markers.some(({ phase }) => phase === earlier));
      assert.equal(f.markers.some(({ phase }) => phase === 'attachment-bind' || phase === 'public-resolve'), false);
      ordinary.resolve();
      observation.resolve();
      await pending;
      assert.deepEqual(
        f.markers.filter(({ phase }) => phase !== 'ordinary-write-attempt').map(({ phase }) => phase),
        ['observer-start', earlier, observerFirst ? 'ordinary-commit' : 'observer-end', 'attachment-bind', 'public-resolve']
      );
    } finally {
      ordinary.resolve();
      observation.resolve();
      f.host.dispose();
    }
  });
}

test('migrated one-shot trace uses ordinary policy, including a drawn runtime exception', async () => {
  const f = receiptFixture({ observe: async (call) => recordedDrawing(call, 7) });
  try {
    const bundle = await receiptBundle([
      { id: 'A', input: { label: 'A' }, expected: 'A' },
      { id: 'B', input: { label: 'B', mode: 'failed' }, expected: 'B' },
    ]);
    const plain = await f.host.evaluateAlgorithm({ bundle: { ...bundle, execution: { ...bundle.execution, trace: false } } });
    assert.deepEqual(f.observerCounts(), [0, 0]);
    const traced = await f.host.evaluateAlgorithm({ bundle });
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'A', 'B']);
    assert.deepEqual(f.observerCalls.map((call) => call.inputs.label), ['A', 'B']);
    assert.deepEqual(traced.policy, plain.policy);
    assert.equal(traced.verdict, plain.verdict);
    assert.equal(traced.passedCount, 1);
    assert.equal(traced.totalCount, 2);
    const failure = traced.evaluation.cases[1]!;
    const ordinaryFailure = plain.evaluation.cases[1]!;
    assert.deepEqual(failure.failure, ordinaryFailure.failure);
    assert.deepEqual(failure.diagnostics, ordinaryFailure.diagnostics);
    assert.equal(failure.diagnostics[0]?.line, 7);
    assert.equal(failure.stdout, 'stdout:B\n');
    assert.equal(failure.attachment?.status, 'drawn');
    assert.equal(failure.attachment?.status === 'drawn' ? failure.attachment.trace.events.at(-1)?.line : undefined, 7);
    assert.deepEqual(f.observerCounts(), [1, 1]);

    const direct = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const judge = yield* f.host.createJudge({
        language: 'javascript', binding: codeBinding({ sourcePath: bundle.execution.sourcePath }),
      });
      return yield* judge.evaluateAlgorithm(bundle);
    })));
    assert.deepEqual(direct.policy, plain.policy);
    assert.deepEqual(direct.evaluation.cases.map(({ attachment }) => attachment?.status), ['drawn', 'drawn']);
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'A', 'B', 'A', 'B']);
    const directExecute = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const judge = yield* f.host.createJudge({
        language: 'javascript',
        binding: codeBinding({ trace: true, sourcePath: bundle.execution.sourcePath }),
      });
      return yield* judge.execute({ plan: bundle.plan, tracing: { caseIds: ['B'] } });
    })));
    assert.equal(directExecute.executionId, undefined);
    assert.equal(directExecute.evaluation.cases[0]?.attachment, undefined);
    assert.equal(directExecute.evaluation.cases[1]?.attachment?.status, 'drawn');
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
  } finally {
    f.host.dispose();
  }
});

test('migrated empty selection retains a handle but compile failure retains none', async () => {
  const f = receiptFixture();
  const failing = receiptFixture({ compileFailure: true });
  try {
    const bundle = await receiptBundle();
    await assert.rejects(
      f.host.execute({ bundle, interactive: true, tracing: { caseIds: ['missing'] } }),
      /unknown case id/u
    );
    assert.equal(f.state.initCalls, 0);
    assert.deepEqual(f.observerCounts(), [0, 0]);
    const empty = await f.host.execute({ bundle, interactive: true, tracing: { caseIds: [] } });
    assert.ok(empty.executionId);
    await assert.rejects(
      failing.host.execute({ executionId: empty.executionId, tracing: { caseIds: ['A'] } }),
      /Unknown or disposed interactive execution/u
    );
    assert.deepEqual(f.observerCounts(), [0, 0]);
    assert.deepEqual(empty.evaluation.cases.map(({ attachment }) => attachment), [undefined, undefined, undefined]);
    const selected = await f.host.execute({ executionId: empty.executionId, tracing: { caseIds: ['B'] } });
    assert.equal(selected.evaluation.cases[0]?.attachment?.status, 'drawn');
    const plain = await failing.host.evaluateAlgorithm({ bundle: { ...bundle, execution: { ...bundle.execution, trace: false } } });
    const failed = await failing.host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } });
    assert.equal(failed.evaluation.status, 'compile-failed');
    assert.equal(failed.executionId, undefined);
    assert.equal(failed.evaluation.cases.length, 0);
    assert.deepEqual(failed.evaluation.compile?.diagnostics, plain.evaluation.compile?.diagnostics);
    if (failed.evaluation.status !== 'compile-failed') assert.fail('compile failure required');
    const compile = failed.evaluation.compile;
    const codeOutcome = judgeCompileExecutionOutcome(compile, { language: RUNTIME });
    const traceOutcome = judgeCompileExecutionOutcome(compile, { language: RUNTIME, trace: true });
    const { trace, executionTimeMs, ...ordinaryFields } = traceOutcome;
    assert.deepEqual(ordinaryFields, codeOutcome);
    assert.equal(trace.runId, 'javascript:compile');
    assert.deepEqual(trace.events, []);
    assert.equal(executionTimeMs, 0);
    assert.deepEqual(failing.ordinaryStarts, []);
    assert.equal(failing.observerCalls.length, 0);
  } finally {
    f.host.dispose();
    failing.host.dispose();
  }
});

for (const nativeStop of [false, true]) {
  test(`migrated stopping scheduler never observes a stopped suffix (native: ${nativeStop})`, async () => {
    const f = receiptFixture({ nativeStop });
    try {
      const bundle = await receiptBundle([
        { id: 'A', input: { label: 'A' }, expected: 'A' },
        { id: 'B', input: { label: 'B', mode: 'limit' }, expected: 'B' },
        { id: 'C', input: { label: 'C' }, expected: 'C' },
      ]);
      const initial = await f.host.execute({ bundle, interactive: true, tracing: { caseIds: ['A', 'B', 'C'] } });
      assert.deepEqual(f.ordinaryStarts, ['A', 'B']);
      assert.deepEqual(f.observerCalls.map((call) => call.inputs.label), ['A', 'B']);
      const suffix = initial.evaluation.cases[2]!;
      assert.equal(suffix.status, 'not-run');
      assert.equal(suffix.attachment?.status, 'refused');
      assert.equal(suffix.attachment?.status === 'refused' && suffix.attachment.reason, 'case-not-run');
      assert.deepEqual(
        judgeCaseExecutionOutcome(suffix, { language: RUNTIME, trace: true }),
        judgeCaseExecutionOutcome(suffix, { language: RUNTIME })
      );
      const clicked = await f.host.execute({ executionId: initial.executionId!, tracing: { caseIds: ['C'] } });
      assert.equal(clicked.evaluation.cases[0]?.attachment, suffix.attachment);
      assert.equal(f.observerCalls.length, 2);
      assert.equal(f.state.codeBatchCalls.length, nativeStop ? 1 : 0);
      await f.host.evaluateAlgorithm({ bundle, stopAtFirstRunaway: false });
      assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'A', 'B', 'C']);
      await f.host.evaluateAlgorithm({ bundle, stopAtFirstRunaway: true });
      assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'A', 'B', 'C', 'A', 'B']);
    } finally {
      f.host.dispose();
    }
  });
}

test('migrated continuation coalesces overlapping clicks and fences a disposed evaluation', { timeout: 5000 }, async () => {
  const replies = [controlled<ObserverReply>(), controlled<ObserverReply>(), controlled<ObserverReply>()];
  let replyIndex = 0;
  const f = receiptFixture({ observe: () => replies[replyIndex++]!.promise });
  try {
    const bundle = await receiptBundle();
    const initial = await f.host.execute({ bundle, interactive: true });
    const request = { executionId: initial.executionId!, tracing: { caseIds: ['A'] } };
    const controller = new AbortController();
    const first = f.host.execute({ ...request, signal: controller.signal });
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    await f.waitUntil(() => f.observerCalls.length === 1);
    const second = f.host.execute(request);
    const disjoint = assert.rejects(
      f.host.execute({ ...request, tracing: { caseIds: ['B'] } }),
      /Unknown or disposed interactive execution/u
    );
    controller.abort();
    await cancelled;
    const a = f.observerCalls[0]!;
    assert.equal(a.signal?.aborted, false);
    replies[0]!.resolve(recordedDrawing(a));
    await second;
    await f.waitUntil(() => f.observerCalls.length === 2);
    assert.equal(f.observerCalls[1]?.inputs.label, 'B');

    // A last waiter leaves while the callback still holds its old token.
    await f.host.disposeExecution(initial.executionId!);
    await disjoint;
    assert.equal(f.observerCalls[1]?.signal?.aborted, true);
    await assert.rejects(f.host.execute(request), /Unknown or disposed/u);
    assert.equal(f.observerCounts()[1], 1);
    const replacement = await f.host.execute({ bundle, interactive: true });
    assert.notEqual(initial.executionId, replacement.executionId);
    const clicked = f.host.execute({ executionId: replacement.executionId!, tracing: { caseIds: ['B'] } });
    await f.waitUntil(() => f.observerCalls.length === 3);
    replies[1]!.resolve(recordedDrawing(f.observerCalls[1]!, 99));
    replies[2]!.resolve(recordedDrawing(f.observerCalls[2]!, 2));
    const attachment = (await clicked).evaluation.cases[0]?.attachment;
    assert.equal(attachment?.status === 'drawn' && attachment.trace.events[0]?.line, 2);
    assert.notEqual(f.observerCalls[1]?.attemptToken, f.observerCalls[2]?.attemptToken);
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'C', 'A', 'B', 'C']);
  } finally {
    f.host.dispose();
  }
});

test('migrated retry discards a late answer after the last waiter aborts', { timeout: 5000 }, async () => {
  const old = controlled<ObserverReply>();
  const fresh = controlled<ObserverReply>();
  let index = 0;
  const f = receiptFixture({ observe: () => (++index === 1 ? old : fresh).promise });
  try {
    const initial = await f.host.execute({ bundle: await receiptBundle(), interactive: true });
    const request = { executionId: initial.executionId!, tracing: { caseIds: ['A'] } };
    const controller = new AbortController();
    const cancelled = assert.rejects(f.host.execute({ ...request, signal: controller.signal }), { name: 'AbortError' });
    await f.waitUntil(() => f.observerCalls.length === 1);
    controller.abort();
    await cancelled;
    const retry = f.host.execute(request);
    await f.waitUntil(() => f.observerCalls.length === 2);
    assert.equal(f.observerCalls[0]?.signal?.aborted, true);
    assert.notEqual(f.observerCalls[0]?.attemptToken, f.observerCalls[1]?.attemptToken);
    old.resolve(recordedDrawing(f.observerCalls[0]!, 99));
    fresh.resolve(recordedDrawing(f.observerCalls[1]!, 2));
    for (const result of [await retry, await f.host.execute(request)]) {
      const attachment = result.evaluation.cases[0]?.attachment;
      assert.equal(attachment?.status === 'drawn' && attachment.trace.events[0]?.line, 2);
    }
    assert.equal(f.observerCalls.length, 2);
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'C']);
  } finally {
    f.host.dispose();
  }
});

for (const disposeHost of [false, true]) {
  test(`migrated initial cancellation fences a delayed observer (host dispose: ${disposeHost})`, { timeout: 5000 }, async () => {
    const late = controlled<ObserverReply>();
    const ordinary = controlled();
    const f = receiptFixture({ observe: () => late.promise, ordinaryBarrier: ordinary.promise });
    try {
      const controller = new AbortController();
      const rejected = assert.rejects(f.host.execute({
        bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A'] }, signal: controller.signal,
      }), { name: 'AbortError' });
      await f.waitUntil(() => f.observerCalls.length === 1);
      if (disposeHost) f.host.dispose();
      else controller.abort();
      await rejected;
      assert.equal(f.observerCalls[0]?.signal?.aborted, true);
      assert.equal(f.ordinarySignals[0]?.aborted, true);
      assert.notEqual(f.ordinarySignals[0], f.observerCalls[0]?.signal);
      late.resolve(recordedDrawing(f.observerCalls[0]!));
      assert.deepEqual(f.observerCounts(), [1, 1]);
      assert.equal(f.markers.some(({ phase }) => phase === 'attachment-bind' || phase === 'public-resolve'), false);
    } finally {
      ordinary.resolve();
      f.host.dispose();
    }
  });
}

test('migrated observer timeout leaves the ordinary lease active and renews idle on publish', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = controlled<ObserverReply>();
  const ordinary = controlled();
  const f = receiptFixture({
    ordinaryBarrier: ordinary.promise,
    observe: () => late.promise,
    idleMs: 25,
    deadlineMs: 70,
  });
  try {
    const pending = f.host.execute({
      bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A'] },
    });
    await f.waitUntil(() => f.observerCalls.length === 1);
    t.mock.timers.tick(70);
    await f.waitUntil(() => f.markers.some(({ phase }) => phase === 'observer-end'));
    assert.equal(f.observerCalls[0]?.signal?.aborted, true);
    assert.equal(f.ordinarySignals[0]?.aborted, false);
    ordinary.resolve();

    const initial = await pending;
    assert.ok(initial.executionId, 'initial observation is active time');
    const request = { executionId: initial.executionId, tracing: { caseIds: ['A'] } };
    const [row] = initial.evaluation.cases;
    const attachment = row?.attachment;
    assert.equal(row?.status, 'completed');
    assert.equal(row?.value, 'A');
    assert.equal(attachment?.status === 'refused' && attachment.reason, 'observer-timeout');
    late.resolve(recordedDrawing(f.observerCalls[0]!));
    assert.equal((await f.host.execute(request)).evaluation.cases[0]?.attachment, attachment);
    assert.equal(f.observerCalls.length, 1);
    t.mock.timers.tick(25);
    await f.waitUntil(() => f.observerCounts()[1] === 1);
    await assert.rejects(f.host.execute(request), /Unknown or disposed/u);
  } finally {
    ordinary.resolve();
    f.host.dispose();
  }
});

test('migrated observer deadline prefix redraw preserves the ordinary runtime failure', async () => {
  const f = receiptFixture({
    observe: async (call) => {
      const drawn = recordedDrawing(call, 6);
      assert.equal(drawn.status, 'drawn');
      return { status: 'truncated', reason: 'observer-deadline', trace: drawn.trace, attemptedEvents: 2 };
    },
  });
  try {
    const bundle = await receiptBundle([{ id: 'A', input: { label: 'A', mode: 'failed' }, expected: 'A' }]);
    const initial = await f.host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } });
    const [row] = initial.evaluation.cases;
    assert.equal(row?.status, 'runtime-error');
    assert.equal(row?.failure?.origin, 'program');
    assert.equal(row?.diagnostics[0]?.line, 7);
    assert.equal(row?.stdout, 'stdout:A\n');
    assert.equal(row?.attachment?.status === 'truncated' && row.attachment.reason, 'observer-deadline');
    const read = judgeCaseExecutionOutcome(row!, { language: RUNTIME, trace: true });
    assert.equal(read.kind, 'failed');
    assert.equal(read.kind === 'failed' && read.traceTruncated, 'trace-limit');
    const redraw = await f.host.execute({ executionId: initial.executionId!, tracing: { caseIds: ['A'] } });
    assert.equal(redraw.evaluation.cases[0]?.attachment, row?.attachment);
    assert.equal(f.observerCalls.length, 1);
    assert.deepEqual(f.ordinaryStarts, ['A']);
  } finally {
    f.host.dispose();
  }
});

test('migrated whole-program trace unavailability publishes only bound refusals', async () => {
  const f = receiptFixture({
    prepareObserver: async () => {
      throw new RuntimeProviderError('instrumentation unavailable', { code: TRACE_UNAVAILABLE_CODE });
    },
  });
  try {
    const result = await f.host.execute({ bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A'] } });
    assert.equal(result.evaluation.status, 'completed');
    assert.ok(result.executionId);
    const continued = await f.host.execute({ executionId: result.executionId, tracing: { caseIds: ['B'] } });
    for (const execution of [result, continued]) {
      const row = execution.evaluation.cases[0]!;
      assert.equal(row.status, 'completed');
      assert.equal(row.attachment?.status, 'refused');
      assert.equal(row.attachment?.status === 'refused' && row.attachment.reason, 'unsupported-program');
      const outcome = judgeCaseExecutionOutcome(row, { language: RUNTIME, trace: true });
      for (const object of [execution, execution.evaluation, row, row.attachment, outcome]) {
        assert.equal(Object.hasOwn(object!, 'untracedRunNeeded'), false);
        assert.equal(Object.hasOwn(object!, 'traceUnavailable'), false);
        assert.equal(Object.hasOwn(object!, 'traceUnavailableRun'), false);
      }
      assert.equal(row.diagnostics.some(({ code }) => code === TRACE_UNAVAILABLE_CODE), false);
      assert.equal(row.failure, undefined);
      assert.equal(Object.hasOwn(row, 'providerFailure'), false);
      assert.equal(execution.evaluation.compile?.diagnostics.some(({ code }) => code === TRACE_UNAVAILABLE_CODE), false);
      assert.equal(Object.hasOwn(row, 'trace'), false);
    }
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'C']);
    assert.equal(f.observerCalls.length, 0);
    assert.deepEqual(f.observerCounts(), [1, 0]);
  } finally {
    f.host.dispose();
  }
});

test('migrated preparation neither blocks ordinary work nor gates the compile decision', { timeout: 5000 }, async () => {
  const artifact = controlled();
  const f = receiptFixture({ prepareObserver: () => artifact.promise });
  const failing = receiptFixture({ prepareObserver: () => artifact.promise, compileFailure: true });
  try {
    const bundle = await receiptBundle();
    const request = { bundle, interactive: true, tracing: { caseIds: ['A'] } };
    const pending = f.host.execute(request);
    await f.waitUntil(() => f.markers.some(({ phase }) => phase === 'ordinary-commit'));
    assert.deepEqual(f.ordinaryStarts, ['A', 'B', 'C']);
    assert.equal(f.observerCalls.length, 0);

    const failure = await failing.host.execute(request);
    assert.equal(failure.evaluation.status, 'compile-failed');
    assert.equal(failure.executionId, undefined);
    artifact.resolve();
    await pending;
    await failing.waitUntil(() => failing.observerCounts()[1] === 1);
    assert.deepEqual(failing.observerCounts(), [1, 1], 'late speculative artifact disposed once');
  } finally {
    artifact.resolve();
    f.host.dispose();
    failing.host.dispose();
  }
});

test('migrated execute owns one snapshot of invocation, inputs and selection', async () => {
  const shared = { n: 7 };
  type Value = { n: number };
  const ids = ['A'];
  const f = receiptFixture({
    observe: async (call) => {
      assert.equal(call.inputs.left, call.inputs.right);
      assert.notEqual(call.inputs.left, shared);
      assert.equal((call.inputs.left as Value).n, 7);
      (call.inputs.left as Value).n = 999;
      return recordedDrawing(call);
    },
  });
  try {
    const bundle = await receiptBundle([
      { id: 'A', input: { label: 'A', output: shared, left: shared, right: shared }, expected: shared },
    ]);
    const request = f.host.execute({ bundle, tracing: { caseIds: ids } });
    ids.push('missing');
    shared.n = -1;
    const { evaluation, executionId } = await request;
    const row = evaluation.cases[0]!;
    assert.deepEqual(row.expected, { n: 7 });
    assert.deepEqual(row.value, { n: 7 });
    assert.equal((row.expected as Value).n, 7);
    assert.equal(shared.n, -1);
    assert.equal(executionId, undefined);
    assert.equal(row.attachment?.status, 'drawn');
    assert.deepEqual(f.ordinaryStarts, ['A']);

    for (const execution of [
      { functionName: null, executionStyle: 'function' as const },
      { functionName: 'Solution.solve', executionStyle: 'solution-method' as const },
      { functionName: 'Solver', executionStyle: 'ops-class' as const },
    ]) {
      const ordinaryOnly = { ...bundle, execution: { ...bundle.execution, ...execution } };
      const result = await f.host.execute({ bundle: ordinaryOnly });
      assert.equal(result.evaluation.cases[0]?.attachment, undefined, 'execute requires explicit selection');
      assert.equal(f.state.prepareCalls.at(-1)?.functionName, execution.functionName ?? '');
      assert.equal(f.state.prepareCalls.at(-1)?.executionStyle, execution.executionStyle);
      assert.equal(f.state.prepareCalls.at(-1)?.mode, 'code');
    }
  } finally {
    f.host.dispose();
  }
});

test('owned preparation can initialize its leases without a separate Judge init barrier', async () => {
  let initCalls = 0;
  const f = receiptFixture({ preparationInitializesRuntime: true, init: () => { initCalls++; } });
  try {
    const result = await f.host.execute({
      bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A'] },
    });
    assert.equal(result.evaluation.cases[0]?.attachment?.status, 'drawn');
    assert.equal(initCalls, 0);
  } finally {
    f.host.dispose();
  }
});

test('migrated native stopping batch starts observation on its worker admission signal', { timeout: 5000 }, async () => {
  const ordinary = controlled();
  const f = receiptFixture({ nativeStop: true, nativeAdmission: true, ordinaryBarrier: ordinary.promise });
  try {
    const pending = f.host.execute({
      bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A'] },
    });
    await f.waitUntil(() => f.observerCalls.length === 1);
    assert.deepEqual(f.ordinaryStarts, ['A']);
    assert.equal(f.markers.some(({ phase }) => phase === 'ordinary-commit'), false);
    ordinary.resolve();
    await pending;
    assert.equal(f.state.codeBatchCalls.length, 1);
  } finally {
    ordinary.resolve();
    f.host.dispose();
  }
});

test('migrated initial join holds the idle lease after ordinary commit', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const drawing = controlled<ObserverReply>();
  const f = receiptFixture({ ordinaryBarrier: Promise.resolve(), idleMs: 25, observe: () => drawing.promise });
  try {
    const pending = f.host.execute({
      bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A'] },
    });
    await f.waitUntil(() => f.observerCalls.length === 1 && f.markers.some(({ phase }) => phase === 'ordinary-commit'));
    t.mock.timers.tick(100);
    const call = f.observerCalls[0]!;
    assert.equal(call.signal?.aborted, false);
    assert.equal(f.markers.some(({ phase }) => phase === 'public-resolve'), false);
    drawing.resolve(recordedDrawing(call));
    const initial = await pending;
    assert.ok(initial.executionId);
    assert.equal(initial.evaluation.cases[0]?.attachment?.status, 'drawn');
    t.mock.timers.tick(25);
    await f.waitUntil(() => f.observerCounts()[1] === 1);
    await assert.rejects(f.host.execute({
      executionId: initial.executionId, tracing: { caseIds: ['A'] },
    }), /Unknown or disposed/u);
  } finally {
    f.host.dispose();
  }
});

test('Judge observation adapters bind once to each runtime host and its selected assets', async () => {
  const bindings: BrowserRuntimeProviderContext[] = [];
  const preparations: string[] = [];
  const bind = (context: BrowserRuntimeProviderContext): JudgeReceiptProvider => {
    bindings.push(context);
    return {
      runtimeVersion: context.assets.javascriptWorker,
      capabilities: { observationLease: 'separate', observationDeadlineMs: 3000 },
      async prepareObservation(program) {
        preparations.push(program.runtimeVersion);
        return {
          observe: async (call) => recordedDrawing(call),
          dispose() {},
        };
      },
    };
  };
  const first = createBrowserJudgeHostFromRuntimeHost(browserHostFor(
    preparedProvider(makePreparedState()), bind, 'https://first.example/workers/'
  ));
  const second = createBrowserJudgeHostFromRuntimeHost(browserHostFor(
    preparedProvider(makePreparedState()), bind, 'https://second.example/workers/'
  ));
  try {
    assert.equal(bindings.length, 2);
    assert.equal(bindings[0]?.assets, first.assets);
    assert.equal(bindings[1]?.assets, second.assets);
    const bundle = await receiptBundle();
    for (const host of [first, second, first]) {
      const result = await host.execute({ bundle, tracing: { caseIds: ['A'] } });
      assert.equal(result.evaluation.cases[0]?.attachment?.status, 'drawn');
    }
    assert.deepEqual(preparations, [
      first.assets.javascriptWorker, second.assets.javascriptWorker, first.assets.javascriptWorker,
    ]);
    assert.equal(bindings.length, 2, 'evaluation reuses the host-owned adapter');
  } finally {
    first.dispose();
    second.dispose();
  }
});

const judgeTestBridgeSymbol = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
type TestBridge = import('../src/internal/judge-test-bridge').JudgeTestBridge;
type TestBridgeEvent = Parameters<TestBridge['onEvent']>[0];

function installJudgeTestGlobals(t: import('node:test').TestContext, windowRealm = true) {
  const properties: PropertyKey[] = ['window', 'document', judgeTestBridgeSymbol];
  for (const key of properties) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  if (windowRealm) {
    Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: { defaultView: globalThis }, configurable: true });
  }
  return (bridge: TestBridge, enumerable = false) => {
    Object.defineProperty(globalThis, judgeTestBridgeSymbol, {
      value: bridge, configurable: true, enumerable,
    });
  };
}

test('trusted Judge bridge observes the complete journal with no provider mark callback', async (t) => {
  const install = installJudgeTestGlobals(t);
  const baseline = receiptFixture({ providerMarks: false });
  t.after(() => baseline.host.dispose());
  const events: TestBridgeEvent[] = [];
  install({ onEvent: (event) => events.push(event) });
  const observed = receiptFixture({ providerMarks: false });
  t.after(() => observed.host.dispose());
  const bundle = await receiptBundle();

  function receiptBytes(result: Awaited<ReturnType<typeof baseline.host.evaluateAlgorithm>>) {
    // The two genuine runs have distinct IDs and clock values. Preserve every
    // other field byte-for-byte, including the verdict and trace payload.
    return JSON.stringify(result, (key, value: unknown) =>
      ['evaluationId', 'sessionId', 'pid', 'runId', 'startedAt', 'endedAt', 'evaluatedAt'].includes(key)
        ? undefined
        : value);
  }
  const ordinary = await baseline.host.evaluateAlgorithm({ bundle });
  assert.equal(events.length, 0);
  assert.equal(receiptBytes(await observed.host.evaluateAlgorithm({ bundle })), receiptBytes(ordinary));

  events.length = 0;
  const initial = await observed.host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } });
  assert.ok(initial.executionId);
  const request = { executionId: initial.executionId, tracing: { caseIds: ['A'] } };
  const cached = await observed.host.execute(request);
  assert.equal(cached.evaluation.cases[0]?.attachment, initial.evaluation.cases[0]?.attachment);
  assert.deepEqual(new Set(events.map(({ phase }) => phase)), new Set([
    'ordinary-write-attempt', 'ordinary-commit', 'observer-start', 'observer-end',
    'attachment-bind', 'public-resolve', 'observation-cache-hit',
  ]));
  const phase = (name: string) => events.findIndex(({ phase }) => phase === name);
  assert.ok(phase('observer-start') < phase('observer-end'));
  assert.ok(phase('ordinary-write-attempt') < phase('ordinary-commit'));
  assert.ok(phase('ordinary-commit') < phase('attachment-bind'));
  assert.ok(phase('attachment-bind') < phase('public-resolve'));
  assert.ok(phase('public-resolve') < phase('observation-cache-hit'));
  assert.deepEqual(events.filter(({ phase }) => phase === 'ordinary-write-attempt').map(({ caseId }) => caseId), ['A', 'B', 'C']);
  assert.equal(events.filter(({ phase }) => phase === 'attachment-bind').length, 1);
  const token = events[phase('observer-start')]?.attemptToken;
  assert.ok(token);
  for (const event of events) {
    assert.equal(event.workspaceDigest, bundle.workspaceDigest);
    assert.equal(event.evaluationId, events[0]?.evaluationId);
    assert.equal(event.generation, 1);
    if (['observer-end', 'attachment-bind', 'observation-cache-hit'].includes(event.phase)) {
      assert.equal(event.caseId, 'A');
      assert.equal(event.attemptToken, token);
    }
  }
});

test('trusted Judge bridge ACKs only faults applied at the observation boundary', async (t) => {
  const install = installJudgeTestGlobals(t);
  const bundle = await receiptBundle();
  for (const [point, fault, reason, preparations, observations] of [
    ['prepare', 'prepare', 'observer-prepare', 0, 0],
    ['observe', 'runtime', 'observer-runtime', 1, 0],
    ['observe', 'deadline', 'observer-timeout', 1, 1],
    ['encode', 'encode', 'observer-encode', 1, 1],
  ] as const) {
    const events: TestBridgeEvent[] = [];
    install({
      onEvent: (event) => events.push(event),
      faultAt: (context) => context.point === point ? fault : undefined,
    });
    const f = receiptFixture({ providerMarks: false });
    try {
      const result = await f.host.execute({ bundle, tracing: { caseIds: ['A'] } });
      assert.equal(f.observerCounts()[0], preparations);
      assert.equal(f.observerCalls.length, observations);
      const row = result.evaluation.cases[0]!;
      assert.equal(row.status, 'completed');
      assert.equal(row.value, 'A');
      assert.equal(row.attachment?.status === 'refused' && row.attachment.reason, reason);
      const acks = events.filter((event) => event.phase === 'injection-ack');
      assert.equal(acks.length, 1);
      assert.deepEqual(acks[0], {
        phase: 'injection-ack', point, fault, language: 'javascript',
        evaluationId: row.attachment?.evaluationId, workspaceDigest: bundle.workspaceDigest,
        generation: 1, caseId: point === 'prepare' ? undefined : 'A',
        attemptToken: f.observerCalls[0]?.attemptToken ??
          events.find(({ phase }) => phase === 'observer-start')?.attemptToken, at: acks[0]?.at,
      });
      assert.ok(events.indexOf(acks[0]!) < events.findIndex(({ phase }) => phase === 'attachment-bind'));
      if (fault === 'deadline') assert.equal(f.observerCalls[0]?.signal?.reason?.name, 'TimeoutError');
    } finally {
      f.host.dispose();
    }
  }
});

test('a Judge host ignores a bridge installed after host creation or on an enumerable property', async (t) => {
  const install = installJudgeTestGlobals(t);
  let touched = false;
  const bridge: TestBridge = {
    onEvent: () => { touched = true; },
    faultAt: () => { touched = true; return 'prepare'; },
  };
  const earlier = receiptFixture();
  t.after(() => earlier.host.dispose());
  install(bridge, true);
  const enumerable = receiptFixture();
  t.after(() => enumerable.host.dispose());
  install(bridge);
  for (const fixture of [earlier, enumerable]) {
    const result = await fixture.host.execute({ bundle: await receiptBundle(), tracing: { caseIds: ['A'] } });
    assert.equal(result.evaluation.cases[0]?.attachment?.status, 'drawn');
  }
  assert.equal(touched, false);
});

test('a Judge host outside a Window ignores even a non-enumerable injection bridge', async (t) => {
  const install = installJudgeTestGlobals(t, false);
  let touched = false;
  install({
    onEvent: () => { touched = true; },
    faultAt: () => { touched = true; return 'prepare'; },
  });
  const f = receiptFixture();
  t.after(() => f.host.dispose());
  const result = await f.host.execute({ bundle: await receiptBundle(), tracing: { caseIds: ['A'] } });
  assert.equal(result.evaluation.cases[0]?.attachment?.status, 'drawn');
  assert.equal(touched, false);
});

test('Judge scheduler certifies a registered producer before binding and caches the refusal', async (t) => {
  const fixture = receiptFixture({
    certification: 'ends-same',
    async observe(call) {
      const label = call.inputs.label;
      return {
        ...recordedDrawing(call),
        finalState: {
          status: 'completed',
          value: { present: true, value: label === 'A' ? 'A' : 999 },
          console: `stdout:${label}\n`,
        },
      };
    },
  });
  t.after(() => fixture.host.dispose());
  const response = await fixture.host.execute({
    bundle: await receiptBundle(), interactive: true, tracing: { caseIds: ['A', 'B'] },
  });
  const [drawnRow, refusedRow] = response.evaluation.cases;
  assert.ok(response.executionId);
  assert.equal(drawnRow?.attachment?.status, 'drawn');
  const refused = refusedRow?.attachment;
  assert.equal(refused?.status === 'refused' && refused.reason, 'uncertified-drawing');
  assert.equal(refusedRow?.value, 'B');
  assert.equal(refusedRow?.verdict.kind, 'passed');
  const cached = await fixture.host.execute({
    executionId: response.executionId, tracing: { caseIds: ['B'] },
  });
  assert.equal(cached.evaluation.cases[0]?.attachment, refused);
  assert.deepEqual(fixture.ordinaryStarts, ['A', 'B', 'C']);
  assert.equal(fixture.observerCalls.length, 2);
});
