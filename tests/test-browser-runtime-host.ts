#!/usr/bin/env npx tsx

import { test } from 'node:test';
import type {
  Language,
  RuntimeClient,
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgramCapabilities,
} from '../packages/runtime-core/src';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
  type BrowserRuntimeProvider,
  type BrowserRuntimeProviderLease,
  type CreateBrowserRuntimeHostOptions,
} from '../packages/runtime-browser/src';
import {
  getBrowserRuntimeHostPreparedProvider,
} from '../packages/runtime-browser/src/browser-runtime-host-internal';
import {
  createBrowserRuntimeHost as createDefaultBrowserRuntimeHost,
} from '../src/browser';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function fakeClient(): RuntimeClient {
  return {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    async execute() {
      throw new Error('direct execution must not be used');
    },
    async executeWithTracing() {
      throw new Error('direct execution must not be used');
    },
    async executeCode() {
      throw new Error('direct execution must not be used');
    },
  };
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
  )
): BrowserRuntimeProvider {
  return {
    id,
    languages,
    create(): BrowserRuntimeProviderLease {
      events.push(`create:${id}`);
      return {
        clients: new Map(
          languages.map((language) => [language, fakeClient()])
        ),
        preparedProviders: preparedByLanguage,
        async warm(language) {
          events.push(`warm:${language}`);
          return { success: true, loadTimeMs: 0 };
        },
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
      'create:python-provider,init,prepare:code,execute,dispose-program,' +
        'init,dispose-language:python,dispose:python-provider',
    `Host lifecycle must be provider-owned and exactly disposed: ${selectionEvents.join(',')}`
  );
  const disposedError = errorMessage(() =>
    getBrowserRuntimeHostPreparedProvider(host, 'python')
  );
  assertCondition(
    disposedError.includes('has been disposed'),
    `Disposed hosts must reject provider acquisition: ${disposedError}`
  );

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
