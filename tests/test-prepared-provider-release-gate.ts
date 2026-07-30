import assert from 'node:assert/strict';
import test from 'node:test';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import {
  createBrowserRuntimeHost as createDefaultBrowserRuntimeHost,
} from '../src/browser';
import * as judgeExports from '../src/judge';
import {
  createBrowserRuntimeJudge,
  type CreateBrowserRuntimeJudgeOptions,
  type JudgeEvaluationPlan,
} from '../src/judge';
import type {
  BrowserRuntimeHost,
} from '../packages/runtime-browser/src/browser-runtime-host';
import {
  getBrowserRuntimeHostPreparedProvider,
} from '../packages/runtime-browser/src/browser-runtime-host-internal';
import type {
  CodeExecutionResult,
  Language,
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgramCapabilities,
} from '@tracecode/runtime-core';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
  type BrowserRuntimeProvider,
} from '@tracecode/runtime-browser';

type HostExposesPreparedProvider =
  'getPreparedProvider' extends keyof BrowserRuntimeHost ? true : false;
type BrowserJudgeAcceptsInjectedProvider =
  'provider' extends keyof CreateBrowserRuntimeJudgeOptions ? true : false;

const HOST_EXPOSES_PREPARED_PROVIDER: HostExposesPreparedProvider = false;
const BROWSER_JUDGE_ACCEPTS_INJECTED_PROVIDER:
  BrowserJudgeAcceptsInjectedProvider = false;

const BROWSER_FEATURES = {
  worker: true,
  webAssembly: true,
  webCrypto: true,
  sharedArrayBuffer: true,
  crossOriginIsolated: true,
} as const;

const RUNTIME = 'javascript';
const SOURCE = [
  'function solve(input) {',
  '  return input.label;',
  '}',
].join('\n');

interface GateInput extends Record<string, unknown> {
  readonly label: string;
  readonly hang?: boolean;
}

interface ProviderState {
  preparations: number;
  disposals: number;
  aborts: number;
  active: number;
  readonly started: string[];
  readonly events: string[];
  onStart?: () => void;
}

function providerState(): ProviderState {
  return {
    preparations: 0,
    disposals: 0,
    aborts: 0,
    active: 0,
    started: [],
    events: [],
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Prepared release-gate execution was aborted.');
}

function controlledPreparedProvider(
  state: ProviderState,
  maxConcurrency = 2
): RuntimePreparedExecutionProvider {
  return {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    async prepareProgram(call) {
      state.preparations += 1;
      if (call.mode !== 'code') {
        return {
          kind: 'failed',
          error: 'The release-gate provider supports code mode only.',
          diagnosticStage: 'compile',
          consoleOutput: [],
        };
      }
      const capabilities: RuntimePreparedProgramCapabilities = {
        caseIsolation: 'fresh-case-state',
        maxConcurrency,
      };
      return {
        kind: 'prepared',
        consoleOutput: [],
        program: {
          mode: 'code',
          capabilities,
          async executeIsolated(execution): Promise<CodeExecutionResult> {
            const input = execution.inputs as GateInput;
            state.started.push(input.label);
            state.events.push(`start:${input.label}`);
            state.active += 1;
            state.onStart?.();

            if (!input.hang) {
              state.active -= 1;
              state.events.push(`complete:${input.label}`);
              return {
                kind: 'completed',
                output: input.label,
                consoleOutput: [],
              };
            }

            const signal = execution.signal;
            if (!signal) {
              state.active -= 1;
              throw new Error(
                'Judge did not attach an abort signal to prepared execution.'
              );
            }
            return new Promise<CodeExecutionResult>((_, reject) => {
              const abort = () => {
                state.aborts += 1;
                state.active -= 1;
                state.events.push(`abort:${input.label}`);
                reject(abortReason(signal));
              };
              if (signal.aborted) abort();
              else signal.addEventListener('abort', abort, { once: true });
            });
          },
          async dispose() {
            state.disposals += 1;
            state.events.push('dispose');
          },
        },
      };
    },
  };
}

function plan(
  cases: readonly GateInput[],
  maxConcurrency = 2
): JudgeEvaluationPlan<GateInput, string> {
  return {
    id: 'prepared-provider-release-gate',
    runtime: RUNTIME,
    workspace: {
      cwd: '/workspace',
      files: [{
        path: '/workspace/solution.js',
        contents: SOURCE,
        visibility: 'submission',
      }],
    },
    driver: {
      files: [],
    },
    run: {
      command: 'prepared-provider-case',
      timeoutMs: 1_000,
    },
    cases: cases.map((input) => ({
      id: input.label,
      input,
      expected: input.label,
    })),
    isolation: {
      mode: 'fresh-session-per-case',
      maxConcurrency,
    },
  };
}

function capabilityProvider(
  capabilities: RuntimePreparedProgramCapabilities,
  onDispose: () => void
): BrowserRuntimeProvider {
  const preparedProvider: RuntimePreparedExecutionProvider = {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    async prepareProgram(call) {
      if (call.mode !== 'code') {
        return {
          kind: 'failed',
          error: 'The capability gate supports code mode only.',
          diagnosticStage: 'compile',
          consoleOutput: [],
        };
      }
      return {
        kind: 'prepared',
        consoleOutput: [],
        program: {
          mode: 'code',
          capabilities,
          async executeIsolated() {
            return {
              kind: 'completed',
              output: null,
              consoleOutput: [],
            };
          },
          async dispose() {
            onDispose();
          },
        },
      };
    },
  };
  return {
    id: 'capability-provider',
    languages: ['python'],
    create() {
      return {
        preparedProviders: new Map([['python', preparedProvider]]),
        disposeLanguage() {},
        dispose() {},
      };
    },
  };
}

function browserHostFor(
  provider: RuntimePreparedExecutionProvider
): BrowserRuntimeHost {
  return createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([{
      id: 'prepared-release-gate-provider',
      languages: [RUNTIME],
      create() {
        return {
          preparedProviders: new Map([[RUNTIME, provider]]),
          disposeLanguage() {},
          dispose() {},
        };
      },
    }]),
    providers: [RUNTIME],
    featureOverrides: BROWSER_FEATURES,
  });
}

function createGateJudge(
  provider: RuntimePreparedExecutionProvider
) {
  return Effect.acquireRelease(
    Effect.sync(() => browserHostFor(provider)),
    (host) => Effect.sync(() => host.dispose())
  ).pipe(
    Effect.flatMap((host) =>
      createBrowserRuntimeJudge({
        host,
        language: RUNTIME,
        binding: {
          sourcePath: '/workspace/solution.js',
          functionName: 'solve',
          executionStyle: 'function',
        },
      })
    )
  );
}

test('default browser host exposes every runtime family without provider capabilities', () => {
  assert.equal(HOST_EXPOSES_PREPARED_PROVIDER, false);
  assert.equal(BROWSER_JUDGE_ACCEPTS_INJECTED_PROVIDER, false);
  assert.equal('createRuntimeJudge' in judgeExports, false);

  const expectedLanguages: readonly Language[] = [
    'python',
    'javascript',
    'typescript',
    'java',
    'csharp',
    'cpp',
  ];
  const host = createDefaultBrowserRuntimeHost({
    featureOverrides: BROWSER_FEATURES,
  });
  try {
    assert.deepEqual(host.supportedLanguages, expectedLanguages);
    assert.equal('getPreparedProvider' in host, false);
    assert.equal('execute' in host, false);
    assert.equal('executeCode' in host, false);
    assert.equal('executeWithTracing' in host, false);
    assert.equal('getClient' in host, false);
  } finally {
    host.dispose();
  }
});

test('browser host enforces prepared-program isolation capabilities', async () => {
  let validDisposals = 0;
  const validHost = createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([
      capabilityProvider(
        {
          caseIsolation: 'fresh-case-state',
          maxConcurrency: 2,
        },
        () => {
          validDisposals += 1;
        }
      ),
    ]),
    providers: ['python'],
    featureOverrides: BROWSER_FEATURES,
  });
  try {
    const result = await getBrowserRuntimeHostPreparedProvider(
      validHost,
      'python'
    ).prepareProgram({
      mode: 'code',
      code: SOURCE,
      functionName: 'solve',
    });
    assert.equal(result.kind, 'prepared');
    if (result.kind === 'prepared') {
      assert.equal(
        result.program.capabilities.caseIsolation,
        'fresh-case-state'
      );
      assert.ok(result.program.capabilities.maxConcurrency > 0);
      await result.program.dispose();
    }
    assert.equal(validDisposals, 1);
  } finally {
    validHost.dispose();
  }

  for (const capabilities of [
    {
      caseIsolation: 'shared-state',
      maxConcurrency: 1,
    },
    {
      caseIsolation: 'fresh-case-state',
      maxConcurrency: 0,
    },
  ] as const) {
    let rejectedDisposals = 0;
    const host = createBrowserRuntimeHost({
      providerRegistry: createBrowserRuntimeProviderRegistry([
        capabilityProvider(
          capabilities as unknown as RuntimePreparedProgramCapabilities,
          () => {
            rejectedDisposals += 1;
          }
        ),
      ]),
      providers: ['python'],
      featureOverrides: BROWSER_FEATURES,
    });
    try {
      await assert.rejects(
        getBrowserRuntimeHostPreparedProvider(
          host,
          'python'
        ).prepareProgram({
          mode: 'code',
          code: SOURCE,
          functionName: 'solve',
        }),
        /fresh-case-state isolation and a positive integer maxConcurrency/
      );
      assert.equal(
        rejectedDisposals,
        1,
        'The host must dispose a prepared artifact rejected by the contract.'
      );
    } finally {
      host.dispose();
    }
  }
});

test('Judge gives every case a fresh TraceKernel session', async () => {
  const state = providerState();
  const result = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createGateJudge(
        controlledPreparedProvider(state)
      );
      return yield* judge.evaluate<GateInput, string, string>(
        plan([
          { label: 'first' },
          { label: 'second' },
          { label: 'third' },
        ])
      );
    })
  ));

  assert.equal(result.status, 'completed');
  assert.equal(state.preparations, 1);
  assert.equal(state.disposals, 1);
  assert.deepEqual(
    result.cases.map((caseResult) => caseResult.verdict.kind),
    ['passed', 'passed', 'passed']
  );
  assert.equal(
    new Set(result.cases.map((caseResult) => caseResult.sessionId)).size,
    3
  );
  assert.ok(
    result.cases.every(
      (caseResult) => caseResult.sessionId !== result.compile?.sessionId
    ),
    'No case may reuse the preparation session.'
  );
});

test('interrupting Judge aborts active work, drains queued work, and disposes once', async () => {
  const state = providerState();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  state.onStart = notifyStarted;

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const judge = yield* createGateJudge(
        controlledPreparedProvider(state, 1)
      );
      const fiber = yield* Effect.fork(
        judge.evaluate(
          plan(
            [
              { label: 'active', hang: true },
              { label: 'queued', hang: true },
            ],
            2
          )
        )
      );

      yield* Effect.promise(() => started);
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10))
      );
      yield* Fiber.interrupt(fiber);

      assert.equal(state.started.length, 1);
      assert.equal(state.aborts, 1);
      assert.equal(state.active, 0);
      assert.equal(state.disposals, 1);
      assert.ok(state.events.indexOf('dispose') > state.events.indexOf('abort:active'));
      assert.deepEqual(judge.activeSessionIds(), []);
    })
  ));
});
