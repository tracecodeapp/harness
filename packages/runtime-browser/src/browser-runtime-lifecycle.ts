import type {
  Language,
} from '@tracecode/runtime-contracts';
import { createBrowserRuntimeAssetPreflight } from './runtime-asset-preflight';
import type {
  BrowserRuntimeAssetOverrides,
  BrowserRuntimeAssets,
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeId,
} from './runtime-assets';
import {
  createBrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHostOptions,
  type BrowserWorkerFactory,
} from './execution-host';
import {
  createBrowserRuntimeEnvironment,
  type BrowserRuntimeEngine,
  type BrowserRuntimeEnvironment,
  type BrowserRuntimeFeatureSupport,
} from './runtime-environment';
import { SUPPORTED_LANGUAGES } from './runtime-profiles';
import type {
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
  BrowserRuntimeProviderRegistry,
} from './runtime-provider-registry';

export interface BrowserRuntimeLifecycleExecutionHostOptions
  extends BrowserExecutionWorkerHostOptions {
  providers?: readonly Language[];
}

export interface BrowserRuntimeLifecycleOptions {
  providerRegistry: BrowserRuntimeProviderRegistry;
  assetBaseUrl?: string;
  assets?: BrowserRuntimeAssetOverrides;
  environment?: BrowserRuntimeEnvironment;
  providers?: readonly Language[];
  engine?: BrowserRuntimeEngine;
  featureOverrides?: Partial<BrowserRuntimeFeatureSupport>;
  executionHost?: BrowserRuntimeLifecycleExecutionHostOptions;
  debug?: boolean;
  safeExecution?: {
    prewarmAfterUse?: boolean;
  };
}

export interface BrowserRuntimeLifecycleLabels {
  readonly optionsName: string;
  readonly ownerName: string;
  readonly emptySelectionMessage: string;
  readonly emptyExecutionHostMessage: string;
  readonly sharedWorkerName: string;
}

export interface ResolvedBrowserRuntimeLifecycleContext {
  readonly options: BrowserRuntimeLifecycleOptions;
  readonly providerRegistry: BrowserRuntimeProviderRegistry;
  readonly environment: BrowserRuntimeEnvironment;
  readonly assets: BrowserRuntimeAssets;
  readonly supportedLanguages: readonly Language[];
  readonly executionHostProviders: ReadonlySet<Language>;
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

export interface BrowserRuntimeExecutionHostSlot {
  readonly host: BrowserExecutionWorkerHost | undefined;
  readonly workerFactoryFor: (
    language: Language
  ) => BrowserWorkerFactory | undefined;
}

function assertProviderRegistry(
  registry: BrowserRuntimeProviderRegistry | undefined,
  optionsName: string
): asserts registry is BrowserRuntimeProviderRegistry {
  if (
    !registry ||
    typeof registry !== 'object' ||
    !Array.isArray(registry.providers) ||
    !Array.isArray(registry.languages) ||
    typeof registry.get !== 'function'
  ) {
    throw new TypeError(
      `${optionsName}.providerRegistry is required. ` +
        'Register providers from the language packages installed by this application.'
    );
  }
}

function assertRegisteredLanguages(
  registry: BrowserRuntimeProviderRegistry,
  languages: readonly Language[],
  emptySelectionMessage: string
): void {
  if (languages.length === 0) {
    throw new TypeError(emptySelectionMessage);
  }
  for (const language of languages) {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      throw new TypeError(
        `Browser runtime provider ${JSON.stringify(language)} is not supported.`
      );
    }
    if (!registry.get(language)) {
      throw new TypeError(
        `Browser runtime provider ${JSON.stringify(language)} is selected but not registered.`
      );
    }
  }
}

export function resolveBrowserRuntimeLifecycleContext(
  options: BrowserRuntimeLifecycleOptions,
  labels: BrowserRuntimeLifecycleLabels
): ResolvedBrowserRuntimeLifecycleContext {
  assertProviderRegistry(options.providerRegistry, labels.optionsName);
  if (
    options.safeExecution?.prewarmAfterUse !== undefined &&
    typeof options.safeExecution.prewarmAfterUse !== 'boolean'
  ) {
    throw new TypeError('safeExecution.prewarmAfterUse must be a boolean.');
  }
  if (
    options.environment &&
    (
      options.assetBaseUrl !== undefined ||
      options.assets !== undefined ||
      options.providers !== undefined ||
      options.engine !== undefined ||
      options.featureOverrides !== undefined
    )
  ) {
    throw new TypeError(
      `${labels.optionsName}.environment cannot be combined with asset, provider, engine, or feature overrides.`
    );
  }

  const selectedLanguages = options.environment
    ? options.environment.providers
    : options.providers ?? options.providerRegistry.languages;
  assertRegisteredLanguages(
    options.providerRegistry,
    selectedLanguages,
    labels.emptySelectionMessage
  );
  const environment =
    options.environment ??
    createBrowserRuntimeEnvironment({
      assetBaseUrl: options.assetBaseUrl,
      assets: options.assets,
      providers: selectedLanguages,
      surface: 'classic',
      engine: options.engine,
      featureOverrides: options.featureOverrides,
    });
  const assets = environment.assets;
  const supportedLanguages = environment.providers;
  assertRegisteredLanguages(
    options.providerRegistry,
    supportedLanguages,
    labels.emptySelectionMessage
  );

  const assetPreflight = createBrowserRuntimeAssetPreflight(
    assets.runtimeManifests
  );
  const preflight = (runtime: BrowserRuntimeId, assetNames: readonly string[]) =>
    () => assetPreflight.preflight(runtime, assetNames);
  const manifestAsset = (
    runtime: BrowserRuntimeId,
    name: string
  ): BrowserRuntimeAssetDescriptor | undefined => {
    const manifest = assets.runtimeManifests?.[runtime];
    const value = (manifest?.assets as Record<string, unknown> | undefined)?.[
      name
    ];
    return value &&
      typeof value === 'object' &&
      typeof (value as { url?: unknown }).url === 'string'
      ? (value as BrowserRuntimeAssetDescriptor)
      : undefined;
  };
  const manifestAssetCollection = (
    runtime: BrowserRuntimeId,
    name: string
  ): Readonly<Record<string, BrowserRuntimeAssetDescriptor>> | undefined => {
    const manifest = assets.runtimeManifests?.[runtime];
    const value = (manifest?.assets as Record<string, unknown> | undefined)?.[
      name
    ];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Readonly<Record<string, BrowserRuntimeAssetDescriptor>>)
      : undefined;
  };

  const executionHostProviders = new Set<Language>();
  for (const language of options.executionHost
    ? options.executionHost.providers ?? supportedLanguages
    : []) {
    if (!supportedLanguages.includes(language)) {
      throw new TypeError(
        `executionHost provider ${JSON.stringify(language)} is not selected by this ${labels.ownerName}.`
      );
    }
    executionHostProviders.add(language);
  }
  if (options.executionHost && executionHostProviders.size === 0) {
    throw new TypeError(labels.emptyExecutionHostMessage);
  }
  if (
    supportedLanguages.includes('javascript') &&
    supportedLanguages.includes('typescript') &&
    executionHostProviders.has('javascript') !==
      executionHostProviders.has('typescript')
  ) {
    throw new TypeError(
      `JavaScript and TypeScript share one ${labels.sharedWorkerName} worker and ` +
        'must be routed through executionHost together.'
    );
  }

  return {
    options,
    providerRegistry: options.providerRegistry,
    environment,
    assets,
    supportedLanguages,
    executionHostProviders,
    preflight,
    manifestAsset,
    manifestAssetCollection,
  };
}

export function createBrowserRuntimeExecutionHostSlot(
  context: ResolvedBrowserRuntimeLifecycleContext
): BrowserRuntimeExecutionHostSlot {
  if (
    !context.options.executionHost ||
    context.executionHostProviders.size === 0
  ) {
    return { host: undefined, workerFactoryFor: () => undefined };
  }

  const host = createBrowserExecutionWorkerHost(context.options.executionHost);
  try {
    const workerUrls = new Map<Language, string>([
      ['python', context.assets.pythonWorker],
      ['javascript', context.assets.javascriptWorker],
      ['typescript', context.assets.javascriptWorker],
      ['java', context.assets.javaWorker],
      ['csharp', context.assets.csharpWorker],
      ['cpp', context.assets.cppWorker],
    ]);
    for (const language of context.executionHostProviders) {
      const workerUrl = new URL(workerUrls.get(language)!, `${host.origin}/`);
      if (workerUrl.origin !== host.origin) {
        throw new Error(
          `${language} worker origin ${JSON.stringify(workerUrl.origin)} must match ` +
            `executionHost origin ${JSON.stringify(host.origin)}.`
        );
      }
    }
    return {
      host,
      workerFactoryFor: (language: Language) =>
        context.executionHostProviders.has(language)
          ? host.workerFactory
          : undefined,
    };
  } catch (error) {
    host.dispose();
    throw error;
  }
}

export function createBrowserRuntimeProviderContext(
  context: ResolvedBrowserRuntimeLifecycleContext,
  executionHostSlot: BrowserRuntimeExecutionHostSlot
): BrowserRuntimeProviderContext {
  return Object.freeze({
    assets: context.assets,
    debug: context.options.debug ?? false,
    prewarmAfterUse:
      context.options.safeExecution?.prewarmAfterUse ?? true,
    workerFactoryFor: executionHostSlot.workerFactoryFor,
    preflight: context.preflight,
    manifestAsset: context.manifestAsset,
    manifestAssetCollection: context.manifestAssetCollection,
  });
}

export function disposeBrowserRuntimeProviderLeases(
  leases: readonly BrowserRuntimeProviderLease[],
  executionHost: BrowserExecutionWorkerHost | undefined,
  disposalMessage: string
): void {
  const errors: unknown[] = [];
  for (const lease of [...leases].reverse()) {
    try {
      lease.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    executionHost?.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, disposalMessage);
  }
}
