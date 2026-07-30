#!/usr/bin/env npx tsx

import { test } from 'node:test';
import type {
  Language,
  RuntimePreparedExecutionProvider,
} from '../packages/runtime-contracts/src';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
  type BrowserRuntimeProvider,
  type CreateBrowserRuntimeHostOptions,
} from '../packages/runtime-browser/src';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recordingProvider(
  id: string,
  languages: readonly Language[],
  events: string[]
): BrowserRuntimeProvider {
  const preparedProviders = new Map<
    Language,
    RuntimePreparedExecutionProvider
  >(
    languages.map((language) => [
      language,
      {
        async init() {
          events.push(`init:${id}:${language}`);
          return { success: true, loadTimeMs: 0 };
        },
        async prepareProgram() {
          throw new Error('not used');
        },
      },
    ])
  );
  return {
    id,
    languages,
    create() {
      events.push(`create:${id}`);
      return {
        preparedProviders,
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
    createBrowserRuntimeHost({} as CreateBrowserRuntimeHostOptions);
  } catch (error) {
    missingRegistryError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    missingRegistryError.includes('providerRegistry is required'),
    `Browser host composition must require provider injection: ${missingRegistryError}`
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
          preparedProviders: new Map(),
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
    createBrowserRuntimeHost({
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
    malformedProviderError =
      error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    malformedProviderError.includes('invalid prepared provider'),
    `Host must reject providers missing an owned prepared provider: ${malformedProviderError}`
  );
  assertCondition(
    malformedEvents.join(',') === 'create,dispose',
    `Rejected provider leases must still be released: ${malformedEvents.join(',')}`
  );

  const events: string[] = [];
  const registry = createBrowserRuntimeProviderRegistry([
    recordingProvider('python-provider', ['python'], events),
    recordingProvider(
      'javascript-provider',
      ['javascript', 'typescript'],
      events
    ),
  ]);
  const host = createBrowserRuntimeHost({
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
    host.supportedLanguages.join(',') === 'python',
    'Host language exposure must come from the selected registry entries'
  );
  await host.warmLanguage('python');
  host.disposeLanguage('python');
  host.dispose();
  assertCondition(
    events.join(',') ===
      'create:python-provider,init:python-provider:python,' +
        'dispose-language:python-provider:python,dispose:python-provider',
    `Prepared providers must own warmup while leases own teardown: ${events.join(',')}`
  );

  console.log(
    'PASS: browser provider registry injects prepared-provider ownership and lifecycle'
  );
}

test('browser provider registry', main);
