#!/usr/bin/env npx tsx

import { test } from 'node:test';
import type { Language, RuntimeClient } from '../packages/runtime-core/src';
import {
  createBrowserHarness,
  createBrowserRuntimeProviderRegistry,
  type BrowserRuntimeProvider,
  type CreateBrowserHarnessOptions,
} from '../packages/runtime-browser/src';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fakeClient(): RuntimeClient {
  return {
    async init() {
      return { success: true, loadTimeMs: 0 };
    },
    async execute() {
      throw new Error('not used');
    },
    async executeWithTracing() {
      throw new Error('not used');
    },
    async executeCode() {
      throw new Error('not used');
    },
  };
}

function recordingProvider(
  id: string,
  languages: readonly Language[],
  events: string[]
): BrowserRuntimeProvider {
  return {
    id,
    languages,
    create() {
      events.push(`create:${id}`);
      return {
        clients: new Map(languages.map((language) => [language, fakeClient()])),
        preparedProviders: new Map(),
        async warm(language) {
          events.push(`warm:${id}:${language}`);
          return { success: true, loadTimeMs: 0 };
        },
        disposeLanguage(language) {
          events.push(`dispose-language:${id}:${language}`);
        },
        dispose() {
          events.push(`dispose:${id}`);
        },
      };
    },
  };
}

async function main(): Promise<void> {
  let missingRegistryError = '';
  try {
    createBrowserHarness({} as CreateBrowserHarnessOptions);
  } catch (error) {
    missingRegistryError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    missingRegistryError.includes('providerRegistry is required'),
    `Standalone browser composition must require provider injection: ${missingRegistryError}`
  );

  const duplicateEvents: string[] = [];
  let duplicateOwnerError = '';
  try {
    createBrowserRuntimeProviderRegistry([
      recordingProvider('first', ['python'], duplicateEvents),
      recordingProvider('second', ['python'], duplicateEvents),
    ]);
  } catch (error) {
    duplicateOwnerError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    duplicateOwnerError.includes('owned by both'),
    `Provider registry must reject ambiguous language ownership: ${duplicateOwnerError}`
  );

  const malformedEvents: string[] = [];
  const malformedRegistry = createBrowserRuntimeProviderRegistry([
    {
      id: 'malformed-python-provider',
      languages: ['python'],
      create() {
        malformedEvents.push('create');
        return {
          clients: new Map(),
          preparedProviders: new Map(),
          async warm() {
            return { success: true, loadTimeMs: 0 };
          },
          disposeLanguage() {},
          dispose() {
            malformedEvents.push('dispose');
          },
        };
      },
    },
  ]);
  let malformedProviderError = '';
  try {
    createBrowserHarness({
      providerRegistry: malformedRegistry,
      featureOverrides: {
        worker: true,
        webAssembly: true,
        webCrypto: true,
        sharedArrayBuffer: true,
        crossOriginIsolated: true,
      },
    });
  } catch (error) {
    malformedProviderError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    malformedProviderError.includes('did not create its selected'),
    `Harness must reject providers missing an owned client: ${malformedProviderError}`
  );
  assertCondition(
    malformedEvents.join(',') === 'create,dispose',
    `Rejected provider leases must still be released: ${malformedEvents.join(',')}`
  );

  const events: string[] = [];
  const registry = createBrowserRuntimeProviderRegistry([
    recordingProvider('python-provider', ['python'], events),
    recordingProvider('javascript-provider', ['javascript', 'typescript'], events),
  ]);
  const harness = createBrowserHarness({
    providerRegistry: registry,
    providers: ['python'],
    featureOverrides: {
      worker: true,
      webAssembly: true,
      webCrypto: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
    },
  });
  assertCondition(
    events.join(',') === 'create:python-provider',
    `Only selected providers may be acquired: ${events.join(',')}`
  );
  assertCondition(
    harness.supportedLanguages.join(',') === 'python',
    'Harness language exposure must come from the selected registry entries'
  );
  await harness.warmLanguage('python');
  harness.disposeLanguage('python');
  harness.dispose();
  assertCondition(
    events.join(',') ===
      'create:python-provider,warm:python-provider:python,' +
        'dispose-language:python-provider:python,dispose:python-provider',
    `Provider leases must own warmup and teardown: ${events.join(',')}`
  );

  console.log('PASS: browser provider registry injects selected language ownership and lifecycle');
}

test('browser provider registry', main);
