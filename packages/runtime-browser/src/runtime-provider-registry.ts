import type {
  Language,
  RuntimeClient,
  RuntimeExecutionIsolationPolicy,
  RuntimePreparedExecutionProvider,
} from '@tracecode/runtime-core';
import type {
  BrowserHarnessAssets,
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeId,
} from './runtime-assets';
import type { BrowserWorkerFactory } from './execution-host';

export interface BrowserRuntimeProviderContext {
  readonly assets: BrowserHarnessAssets;
  readonly debug: boolean;
  readonly executionIsolation: RuntimeExecutionIsolationPolicy;
  readonly prewarmAfterUse: boolean;
  readonly workerFactoryFor: (language: Language) => BrowserWorkerFactory | undefined;
  readonly preflight: (
    runtime: BrowserRuntimeId,
    assetNames: readonly string[]
  ) => () => Promise<void>;
  readonly manifestAsset: (
    runtime: BrowserRuntimeId,
    name: string
  ) => BrowserRuntimeAssetDescriptor | undefined;
  readonly manifestAssetCollection: (
    runtime: BrowserRuntimeId,
    name: string
  ) => Readonly<Record<string, BrowserRuntimeAssetDescriptor>> | undefined;
}

export interface BrowserRuntimeProviderLease {
  /**
   * Legacy direct clients retained only while BrowserHarness remains available
   * to existing workspace integrations.
   */
  readonly clients: ReadonlyMap<Language, RuntimeClient>;
  /**
   * Prepare-once providers consumed by BrowserRuntimeHost and Judge.
   *
   * A lease must expose every selected language it owns here. The host rejects
   * incomplete, unowned, or unsafe prepared providers before they can become a
   * public execution capability.
   */
  readonly preparedProviders: ReadonlyMap<
    Language,
    RuntimePreparedExecutionProvider
  >;
  warm(language: Language): Promise<{ success: boolean; loadTimeMs: number }>;
  disposeLanguage(language: Language): void;
  dispose(): void;
}

/**
 * A language package's browser runtime contribution.
 *
 * Providers own their worker/runtime clients and their language-specific
 * lifecycle policy. The browser host owns only shared transport, assets, and
 * execution-host plumbing supplied through the context.
 */
export interface BrowserRuntimeProvider {
  readonly id: string;
  readonly languages: readonly Language[];
  create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease;
}

export interface BrowserRuntimeProviderRegistry {
  readonly providers: readonly BrowserRuntimeProvider[];
  readonly languages: readonly Language[];
  get(language: Language): BrowserRuntimeProvider | undefined;
}

export function createBrowserRuntimeProviderRegistry(
  providers: readonly BrowserRuntimeProvider[]
): BrowserRuntimeProviderRegistry {
  const normalizedProviders: BrowserRuntimeProvider[] = [];
  const languages: Language[] = [];
  const byLanguage = new Map<Language, BrowserRuntimeProvider>();
  const providerIds = new Set<string>();

  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') {
      throw new TypeError('Browser runtime providers must be objects.');
    }
    if (typeof provider.id !== 'string' || provider.id.trim() === '') {
      throw new TypeError('Browser runtime providers must declare a non-empty id.');
    }
    if (providerIds.has(provider.id)) {
      throw new TypeError(`Browser runtime provider id ${JSON.stringify(provider.id)} is registered more than once.`);
    }
    if (!Array.isArray(provider.languages) || provider.languages.length === 0) {
      throw new TypeError(`Browser runtime provider ${JSON.stringify(provider.id)} must own at least one language.`);
    }
    if (typeof provider.create !== 'function') {
      throw new TypeError(
        `Browser runtime provider ${JSON.stringify(provider.id)} must declare a create function.`
      );
    }

    const providerLanguages: Language[] = [];
    for (const language of provider.languages) {
      if (byLanguage.has(language)) {
        throw new TypeError(
          `Browser runtime language ${JSON.stringify(language)} is owned by both ` +
            `${JSON.stringify(byLanguage.get(language)!.id)} and ${JSON.stringify(provider.id)}.`
        );
      }
      if (!providerLanguages.includes(language)) providerLanguages.push(language);
    }

    const normalizedProvider: BrowserRuntimeProvider = Object.freeze({
      id: provider.id,
      languages: Object.freeze(providerLanguages),
      create: provider.create.bind(provider),
    });
    providerIds.add(normalizedProvider.id);
    normalizedProviders.push(normalizedProvider);
    for (const language of providerLanguages) {
      byLanguage.set(language, normalizedProvider);
      languages.push(language);
    }
  }

  const frozenProviders = Object.freeze(normalizedProviders);
  const frozenLanguages = Object.freeze(languages);
  return Object.freeze({
    providers: frozenProviders,
    languages: frozenLanguages,
    get(language: Language): BrowserRuntimeProvider | undefined {
      return byLanguage.get(language);
    },
  });
}
