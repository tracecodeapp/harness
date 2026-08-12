#!/usr/bin/env npx tsx

import { test } from 'node:test';
import type {
  Language,
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgramCapabilities,
  RuntimeProgramPreparationResult,
} from '../packages/runtime-contracts/src';
import {
  createBrowserRuntimeEnvironment,
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
  type BrowserRuntimeProvider,
  type BrowserRuntimeProviderContext,
  type BrowserRuntimeProviderLease,
  type CreateBrowserRuntimeHostOptions,
} from '../packages/runtime-browser/src';
import {
  getBrowserRuntimeHostPreparedProvider,
} from '../packages/runtime-browser/src/browser-runtime-host-internal';
import { withPreparedProgramReuse } from '../packages/runtime-browser/src/prepared-program-reuse';
import {
  createBrowserRuntimeHost as createDefaultBrowserRuntimeHost,
} from '../src/browser';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function fakePreparedProvider(
  events: string[],
  capabilities: RuntimePreparedProgramCapabilities = {
    caseIsolation: 'fresh-case-state',
    maxConcurrency: 1,
  }
): RuntimePreparedExecutionProvider {
  return {
    async init() {
      events.push('init');
      return { success: true, loadTimeMs: 0 };
    },
    async prepareProgram(call) {
      events.push(`prepare:${call.mode}`);
      return {
        kind: 'prepared',
        consoleOutput: [],
        program: {
          mode: 'code',
          capabilities,
          async executeIsolated({ inputs }) {
            events.push('execute');
            return { kind: 'completed', output: inputs, consoleOutput: [] };
          },
          async dispose() {
            events.push('dispose-program');
          },
        },
      };
    },
  };
}

function recordingProvider(
  id: string,
  languages: readonly Language[],
  events: string[],
  preparedByLanguage = new Map(
    languages.map((language) => [
      language,
      fakePreparedProvider(events),
    ])
  ),
  contexts?: BrowserRuntimeProviderContext[]
): BrowserRuntimeProvider {
  return {
    id,
    languages,
    create(context): BrowserRuntimeProviderLease {
      contexts?.push(context);
      events.push(`create:${id}`);
      return {
        preparedProviders: preparedByLanguage,
        disposeLanguage(language) {
          events.push(`dispose-language:${language}`);
        },
        dispose() {
          events.push(`dispose:${id}`);
        },
      };
    },
  };
}

const browserFeatures = {
  worker: true,
  webAssembly: true,
  webCrypto: true,
  sharedArrayBuffer: true,
  crossOriginIsolated: true,
} as const;

function errorMessage(run: () => unknown): string {
  try {
    run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(): Promise<void> {
  const defaultHost = createDefaultBrowserRuntimeHost({
    providers: ['javascript'],
    featureOverrides: browserFeatures,
  });
  assertCondition(
    defaultHost.supportedLanguages.join(',') === 'javascript',
    'Root browser facade must install the default language-provider registry'
  );
  assertCondition(
    !('getPreparedProvider' in defaultHost) &&
      !('getClient' in defaultHost) &&
      !('execute' in defaultHost) &&
      !('executeCode' in defaultHost) &&
      !('executeWithTracing' in defaultHost),
    'Root browser facade must expose only the prepared runtime host'
  );
  defaultHost.dispose();

  const missingRegistry = errorMessage(() =>
    createBrowserRuntimeHost({} as CreateBrowserRuntimeHostOptions)
  );
  assertCondition(
    missingRegistry.includes('providerRegistry is required'),
    `Host must require an explicit provider registry: ${missingRegistry}`
  );

  const lifecycleContexts: BrowserRuntimeProviderContext[] = [];
  const lifecycleEvents: string[] = [];
  const lifecycleRegistry = createBrowserRuntimeProviderRegistry([
    recordingProvider(
      'lifecycle-python',
      ['python'],
      lifecycleEvents,
      undefined,
      lifecycleContexts
    ),
  ]);
  const lifecycleHost = createBrowserRuntimeHost({
    providerRegistry: lifecycleRegistry,
    providers: ['python'],
    featureOverrides: browserFeatures,
    safeExecution: {
      workerLifecycle: 'retire-only',
    },
  });
  assertCondition(
    lifecycleContexts.length === 1 &&
      lifecycleContexts[0]?.workerLifecyclePolicy === 'retire-only' &&
      lifecycleContexts[0]?.prewarmAfterUse === false,
    `Host must project one named lifecycle policy to providers: ${JSON.stringify(
      lifecycleContexts
    )}`
  );
  lifecycleHost.dispose();

  const conflictingLifecycleError = errorMessage(() =>
    createBrowserRuntimeHost({
      providerRegistry: lifecycleRegistry,
      providers: ['python'],
      featureOverrides: browserFeatures,
      safeExecution: {
        workerLifecycle: 'warm-and-retire',
        prewarmAfterUse: false,
      },
    })
  );
  assertCondition(
    conflictingLifecycleError.includes('conflicts'),
    `Host must reject contradictory lifecycle policy aliases: ${conflictingLifecycleError}`
  );

  const csharpModeRegistry = createBrowserRuntimeProviderRegistry([
    recordingProvider('csharp-mode', ['csharp'], []),
  ]);
  const generalCSharpEnvironment = createBrowserRuntimeEnvironment({
    providers: ['csharp'],
    csharpPreparedAuthority: false,
    featureOverrides: { ...browserFeatures, webCrypto: false },
  });
  const omittedCSharpModeError = errorMessage(() =>
    createBrowserRuntimeHost({
      providerRegistry: csharpModeRegistry,
      environment: generalCSharpEnvironment,
    })
  );
  assertCondition(
    omittedCSharpModeError.includes(
      'environment cannot be combined with asset, provider, engine, or feature overrides'
    ),
    `A shared environment must reject an omitted provider mode that would re-enable prepared C#: ${omittedCSharpModeError}`
  );

  const malformedRegistryError = errorMessage(() =>
    createBrowserRuntimeProviderRegistry([
      {
        id: 'missing-create',
        languages: ['python'],
      } as unknown as BrowserRuntimeProvider,
    ])
  );
  assertCondition(
    malformedRegistryError.includes('create function'),
    `Registry must reject providers without construction: ${malformedRegistryError}`
  );

  const selectionEvents: string[] = [];
  const registry = createBrowserRuntimeProviderRegistry([
    recordingProvider('python-provider', ['python'], selectionEvents),
    recordingProvider(
      'javascript-provider',
      ['javascript', 'typescript'],
      selectionEvents
    ),
  ]);
  const host = createBrowserRuntimeHost({
    providerRegistry: registry,
    providers: ['python'],
    featureOverrides: browserFeatures,
  });
  assertCondition(
    selectionEvents.join(',') === 'create:python-provider',
    `Only selected providers may be acquired: ${selectionEvents.join(',')}`
  );
  assertCondition(
    host.supportedLanguages.join(',') === 'python',
    'Selected host languages must come from the provider registry'
  );
  assertCondition(
    !('getPreparedProvider' in host) &&
      !('getClient' in host) &&
      !('execute' in host) &&
      !('executeCode' in host) &&
      !('executeWithTracing' in host),
    'BrowserRuntimeHost must not expose a direct execution surface'
  );

  const provider = getBrowserRuntimeHostPreparedProvider(host, 'python');
  await provider.init();
  const preparation = await provider.prepareProgram({
    mode: 'code',
    code: 'def solve(value): return value',
    functionName: 'solve',
  });
  assertCondition(
    preparation.kind === 'prepared',
    'A valid prepared provider must remain available through the host'
  );
  if (preparation.kind === 'prepared' && preparation.program.mode === 'code') {
    const execution = await preparation.program.executeIsolated({
      inputs: { value: 7 },
    });
    assertCondition(
      execution.kind === 'completed',
      'The host must preserve the prepared program execution contract'
    );
    await preparation.program.dispose();
  }
  await host.warmLanguage('python');
  host.disposeLanguage('python');
  host.dispose();
  assertCondition(
    selectionEvents.join(',') ===
      'create:python-provider,init,prepare:code,execute,' +
        'dispose-program,dispose-language:python,dispose:python-provider',
    `Host lifecycle must be provider-owned and exactly disposed: ${selectionEvents.join(',')}`
  );
  const disposedError = errorMessage(() =>
    getBrowserRuntimeHostPreparedProvider(host, 'python')
  );
  assertCondition(
    disposedError.includes('has been disposed'),
    `Disposed hosts must reject provider acquisition: ${disposedError}`
  );

  const unavailableEvents: string[] = [];
  const unavailableHost = createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([
      recordingProvider('unavailable-python', ['python'], unavailableEvents),
    ]),
    providers: ['python'],
    featureOverrides: { ...browserFeatures, worker: false },
  });
  let warmUnavailableError = '';
  try {
    await unavailableHost.warmLanguage('python');
  } catch (error) {
    warmUnavailableError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    warmUnavailableError.includes('is unavailable') &&
      warmUnavailableError.includes('worker') &&
      !unavailableEvents.includes('init'),
    `Warmup must fail before provider initialization when readiness fails: ${warmUnavailableError}`
  );
  let prepareUnavailableError = '';
  try {
    await getBrowserRuntimeHostPreparedProvider(
      unavailableHost,
      'python'
    ).prepareProgram({
      mode: 'code',
      code: 'pass',
      functionName: 'solve',
    });
  } catch (error) {
    prepareUnavailableError =
      error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    prepareUnavailableError.includes('is unavailable') &&
      !unavailableEvents.some((event) => event.startsWith('prepare:')),
    `Lazy preparation must enforce the same readiness boundary: ${prepareUnavailableError}`
  );
  unavailableHost.dispose();

  const missingEvents: string[] = [];
  const missingPreparedRegistry = createBrowserRuntimeProviderRegistry([
    recordingProvider(
      'missing-python',
      ['python'],
      missingEvents,
      new Map()
    ),
  ]);
  const missingPreparedError = errorMessage(() =>
    createBrowserRuntimeHost({
      providerRegistry: missingPreparedRegistry,
      providers: ['python'],
      featureOverrides: browserFeatures,
    })
  );
  assertCondition(
    missingPreparedError.includes('invalid prepared provider'),
    `Host must reject incomplete prepared-provider leases: ${missingPreparedError}`
  );
  assertCondition(
    missingEvents.join(',') ===
      'create:missing-python,dispose:missing-python',
    `Rejected leases must be disposed: ${missingEvents.join(',')}`
  );

  const unownedEvents: string[] = [];
  const unownedRegistry = createBrowserRuntimeProviderRegistry([
    recordingProvider(
      'unowned-python',
      ['python'],
      unownedEvents,
      new Map([
        ['python', fakePreparedProvider(unownedEvents)],
        ['cpp', fakePreparedProvider(unownedEvents)],
      ])
    ),
  ]);
  const unownedError = errorMessage(() =>
    createBrowserRuntimeHost({
      providerRegistry: unownedRegistry,
      providers: ['python'],
      featureOverrides: browserFeatures,
    })
  );
  assertCondition(
    unownedError.includes('unowned prepared provider'),
    `Host must reject unowned prepared providers: ${unownedError}`
  );
  assertCondition(
    unownedEvents.join(',') ===
      'create:unowned-python,dispose:unowned-python',
    `Unowned-provider rejection must dispose its lease: ${unownedEvents.join(',')}`
  );

  const unsafeEvents: string[] = [];
  const unsafeCapabilities = {
    caseIsolation: 'unsafe-reuse',
    maxConcurrency: 1,
  } as unknown as RuntimePreparedProgramCapabilities;
  const unsafeRegistry = createBrowserRuntimeProviderRegistry([
    recordingProvider(
      'unsafe-python',
      ['python'],
      unsafeEvents,
      new Map([
        ['python', fakePreparedProvider(unsafeEvents, unsafeCapabilities)],
      ])
    ),
  ]);
  const unsafeHost = createBrowserRuntimeHost({
    providerRegistry: unsafeRegistry,
    providers: ['python'],
    featureOverrides: browserFeatures,
  });
  let unsafeError = '';
  try {
    await getBrowserRuntimeHostPreparedProvider(
      unsafeHost,
      'python'
    ).prepareProgram({
      mode: 'code',
      code: 'pass',
      functionName: 'solve',
    });
  } catch (error) {
    unsafeError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    unsafeError.includes('fresh-case-state isolation'),
    `Host must fail closed on unsafe prepared programs: ${unsafeError}`
  );
  assertCondition(
    unsafeEvents.includes('dispose-program'),
    'Host must dispose a prepared artifact rejected for unsafe isolation'
  );
  unsafeHost.dispose();

  console.log(
    'PASS: browser runtime host owns selected safe prepared providers without direct execution'
  );
}

test('browser runtime host', main);

test('browser runtime prewarm stays idle and foreground warm promotes it', async () => {
  const originalRequestIdleCallback = globalThis.requestIdleCallback;
  const originalCancelIdleCallback = globalThis.cancelIdleCallback;
  let idleCallback: IdleRequestCallback | null = null;
  const events: string[] = [];
  globalThis.requestIdleCallback = (callback) => {
    idleCallback = callback;
    return 41;
  };
  globalThis.cancelIdleCallback = () => undefined;
  const host = createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([
      recordingProvider('idle-javascript', ['javascript'], events),
    ]),
    providers: ['javascript'],
    featureOverrides: browserFeatures,
  });
  try {
    const background = host.prewarmLanguage('javascript');
    await Promise.resolve();
    assertCondition(
      !events.includes('init'),
      `background runtime prewarm must not initialize before browser idle: ${events}`
    );
    const foreground = host.warmLanguage('javascript');
    const [backgroundResult, foregroundResult] = await Promise.all([
      background,
      foreground,
    ]);
    assertCondition(
      backgroundResult.success && foregroundResult.success,
      'background and promoted warm callers should observe one successful result'
    );
    assertCondition(
      events.filter((event) => event === 'init').length === 1,
      `foreground promotion must initialize the runtime exactly once: ${events}`
    );
    (idleCallback as unknown as IdleRequestCallback)({
      didTimeout: false,
      timeRemaining: () => 50,
    });
    await Promise.resolve();
    assertCondition(
      events.filter((event) => event === 'init').length === 1,
      `a stale idle callback must not duplicate promoted initialization: ${events}`
    );
  } finally {
    host.dispose();
    globalThis.requestIdleCallback = originalRequestIdleCallback;
    globalThis.cancelIdleCallback = originalCancelIdleCallback;
  }
});

test('prepared program reuse shares concurrency across caller facades', async () => {
  let active = 0;
  let maximumActive = 0;
  let starts = 0;
  let releaseFirst!: () => void;
  const firstExecution = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let disposals = 0;
  const provider: RuntimePreparedExecutionProvider = {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    async prepareProgram() {
      return {
        kind: 'prepared',
        consoleOutput: [],
        program: {
          mode: 'code',
          capabilities: {
            caseIsolation: 'fresh-case-state',
            maxConcurrency: 1,
          },
          async executeIsolated({ inputs }) {
            starts += 1;
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (starts === 1) await firstExecution;
            active -= 1;
            return { kind: 'completed', output: inputs, consoleOutput: [] };
          },
          async dispose() {
            disposals += 1;
          },
        },
      };
    },
  };
  const reusable = withPreparedProgramReuse(provider, { idleTtlMs: 10_000 });
  const call = {
    mode: 'code' as const,
    code: 'return input',
    functionName: 'solve',
  };
  const [left, right] = await Promise.all([
    reusable.prepareProgram(call),
    reusable.prepareProgram(call),
  ]);
  assertCondition(left.kind === 'prepared' && right.kind === 'prepared', 'shared preparation must succeed');
  assertCondition(left.program.mode === 'code' && right.program.mode === 'code', 'shared preparation must retain code mode');
  const leftExecution = left.program.executeIsolated({ inputs: { side: 'left' } });
  await Promise.resolve();
  const rightExecution = right.program.executeIsolated({ inputs: { side: 'right' } });
  await Promise.resolve();
  assertCondition(starts === 1, 'the second facade must wait on the shared execution gate');
  releaseFirst();
  await Promise.all([leftExecution, rightExecution]);
  assertCondition(maximumActive === 1, 'reused facades must honor one shared maxConcurrency bound');
  await left.program.dispose();
  await right.program.dispose();
  reusable.flushPreparedProgramCache();
  await Promise.resolve();
  assertCondition(disposals === 1, 'the shared program must be disposed exactly once');
});

test('prepared program reuse isolates caller cancellation and flushes pending work', async () => {
  let resolvePreparation!: (
    value: Awaited<ReturnType<RuntimePreparedExecutionProvider['prepareProgram']>>
  ) => void;
  let disposals = 0;
  let preparations = 0;
  const deferredPreparation = new Promise<
    Awaited<ReturnType<RuntimePreparedExecutionProvider['prepareProgram']>>
  >((resolve) => {
    resolvePreparation = resolve;
  });
  const provider: RuntimePreparedExecutionProvider = {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    async prepareProgram() {
      preparations += 1;
      return deferredPreparation;
    },
  };
  const reusable = withPreparedProgramReuse(provider);
  const call = {
    mode: 'code' as const,
    code: 'return input',
    functionName: 'solve',
  };
  const owner = reusable.prepareProgram(call);
  const controller = new AbortController();
  const waiter = reusable.prepareProgram({ ...call, signal: controller.signal });
  controller.abort(new Error('waiter cancelled'));
  await assertRejects(waiter, /waiter cancelled/u);
  assertCondition(preparations === 1, 'a cancelled waiter must not cancel or duplicate shared preparation');

  reusable.flushPreparedProgramCache();
  resolvePreparation({
    kind: 'prepared',
    consoleOutput: [],
    program: {
      mode: 'code',
      capabilities: {
        caseIsolation: 'fresh-case-state',
        maxConcurrency: 1,
      },
      async executeIsolated({ inputs }) {
        return { kind: 'completed', output: inputs, consoleOutput: [] };
      },
      async dispose() {
        disposals += 1;
      },
    },
  });
  await assertRejects(owner, /flushed while preparation was in flight/u);
  assertCondition(disposals === 1, 'a late preparation result must be disposed after flush');
});

test('prepared program reuse aborts preparation after its final claimant cancels', async () => {
  let delegateSignal: AbortSignal | undefined;
  const provider: RuntimePreparedExecutionProvider = {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    prepareProgram(call) {
      delegateSignal = call.signal;
      return new Promise<RuntimeProgramPreparationResult>((_resolve, reject) => {
        call.signal?.addEventListener(
          'abort',
          () => reject(call.signal?.reason),
          { once: true }
        );
      });
    },
  };
  const reusable = withPreparedProgramReuse(provider);
  const isDelegateAborted = () => delegateSignal?.aborted === true;
  const call = {
    mode: 'code' as const,
    code: 'return input',
    functionName: 'solve',
  };
  const ownerController = new AbortController();
  const waiterController = new AbortController();
  const owner = reusable.prepareProgram({
    ...call,
    signal: ownerController.signal,
  });
  const waiter = reusable.prepareProgram({
    ...call,
    signal: waiterController.signal,
  });
  waiterController.abort(new Error('waiter cancelled'));
  await assertRejects(waiter, /waiter cancelled/u);
  assertCondition(
    !isDelegateAborted(),
    'one cancelled waiter must not abort preparation while an owner remains'
  );
  ownerController.abort(new Error('owner cancelled'));
  await assertRejects(owner, /owner cancelled/u);
  assertCondition(
    isDelegateAborted(),
    'the final cancelled claimant must abort the unowned preparation'
  );
});

test('prepared program reuse lets concurrent preparations claim entries before capacity eviction', async () => {
  const resolvers = new Map<string, (result: RuntimeProgramPreparationResult) => void>();
  let disposals = 0;
  const provider: RuntimePreparedExecutionProvider = {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    prepareProgram(call) {
      return new Promise<RuntimeProgramPreparationResult>((resolve) => {
        resolvers.set(call.code, resolve);
      });
    },
  };
  const reusable = withPreparedProgramReuse(provider, {
    maxEntries: 2,
    idleTtlMs: 10_000,
  });
  const calls = ['first', 'second', 'third'].map((code) =>
    reusable.prepareProgram({ mode: 'code', code, functionName: 'solve' })
  );
  await Promise.resolve();
  for (const code of ['first', 'second', 'third']) {
    resolvers.get(code)?.({
      kind: 'prepared',
      consoleOutput: [],
      program: {
        mode: 'code',
        capabilities: {
          caseIsolation: 'fresh-case-state',
          maxConcurrency: 1,
        },
        async executeIsolated({ inputs }) {
          return { kind: 'completed', output: inputs, consoleOutput: [] };
        },
        async dispose() {
          disposals += 1;
        },
      },
    });
  }
  const prepared = await Promise.all(calls);
  assertCondition(
    prepared.every((result) => result.kind === 'prepared'),
    'every concurrent preparation must claim its prepared entry before capacity eviction'
  );
  for (const result of prepared) {
    if (result.kind === 'prepared') await result.program.dispose();
  }
  reusable.flushPreparedProgramCache();
  await Promise.resolve();
  assertCondition(disposals === 3, 'all concurrently claimed programs must dispose exactly once');
});

test('prepared program reuse disposes an evicted entry after its final facade releases', async () => {
  let disposals = 0;
  const disposalCount = () => disposals;
  const provider: RuntimePreparedExecutionProvider = {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    async prepareProgram() {
      return {
        kind: 'prepared' as const,
        consoleOutput: [],
        program: {
          mode: 'code' as const,
          capabilities: {
            caseIsolation: 'fresh-case-state' as const,
            maxConcurrency: 1,
          },
          async executeIsolated() {
            throw new Error('execution failed');
          },
          async dispose() {
            disposals += 1;
          },
        },
      };
    },
  };
  const reusable = withPreparedProgramReuse(provider);
  const prepared = await reusable.prepareProgram({
    mode: 'code',
    code: 'throw new Error()',
    functionName: 'solve',
  });
  assertCondition(prepared.kind === 'prepared', 'test provider must prepare a program');
  if (prepared.kind !== 'prepared') return;
  await assertRejects(
    prepared.program.executeIsolated({ inputs: {} }),
    /execution failed/u
  );
  assertCondition(disposalCount() === 0, 'an evicted referenced program must remain alive');
  await prepared.program.dispose();
  await Promise.resolve();
  assertCondition(disposalCount() === 1, 'the final facade must dispose its evicted program');
  reusable.flushPreparedProgramCache();
  await Promise.resolve();
  assertCondition(disposalCount() === 1, 'cache flush must not dispose the program twice');
});

async function assertRejects(
  promise: Promise<unknown>,
  expected: RegExp
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertCondition(expected.test(message), `Expected ${expected}, received ${message}`);
    return;
  }
  throw new Error(`Expected rejection matching ${expected}.`);
}
