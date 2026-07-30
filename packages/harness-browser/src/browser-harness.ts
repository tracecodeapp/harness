import type {
  Language,
  LanguageRuntimeProfile,
  RuntimeClient,
  RuntimeExecutionIsolationPolicy,
} from '@tracecode/harness-core';
import type { LanguageRuntimeInfo } from '@tracecode/harness-core';
import { getLanguageRuntimeInfo } from '@tracecode/harness-core';
import {
  DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS,
  resolveBrowserHarnessAssets,
  type BrowserHarnessAssets,
  type BrowserHarnessAssetOverrides,
  type BrowserRuntimeAssetDescriptor,
  type BrowserRuntimeId,
} from './runtime-assets';
import { createBrowserRuntimeAssetPreflight } from './runtime-asset-preflight';
import {
  createBrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHostOptions,
  type BrowserWorkerFactory,
} from './execution-host';
import {
  createBrowserRuntimeEnvironment,
  type BrowserRuntimeEnvironment,
  type BrowserRuntimeEnvironmentReport,
  type BrowserRuntimeFeatureSupport,
  type BrowserRuntimeEngine,
  type BrowserRuntimeReadiness,
} from './runtime-environment';
import {
  getLanguageRuntimeProfile,
  SUPPORTED_LANGUAGES,
} from './runtime-profiles';
import type {
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
  BrowserRuntimeProviderRegistry,
} from './runtime-provider-registry';

export interface CreateBrowserHarnessOptions {
  /**
   * Runtime providers supplied by installed language packages.
   *
   * The standalone browser package deliberately has no built-in language
   * imports. The umbrella package injects its complete registry for backwards
   * compatibility.
   */
  providerRegistry: BrowserRuntimeProviderRegistry;
  assetBaseUrl?: string;
  assets?: BrowserHarnessAssetOverrides;
  /** Optional shared V2 deployment/readiness environment. */
  environment?: BrowserRuntimeEnvironment;
  /** Providers exposed by this harness. Defaults to every registered language. */
  providers?: readonly Language[];
  engine?: BrowserRuntimeEngine;
  featureOverrides?: Partial<BrowserRuntimeFeatureSupport>;
  /** Runs selected provider workers on a dedicated, credential-free origin. */
  executionHost?: BrowserHarnessExecutionHostOptions;
  debug?: boolean;
  /**
   * Safe by default. `unsafe-reuse` keeps provider-owned mutable runtime
   * workers alive across executions and must only be used for trusted code.
   */
  executionIsolation?: RuntimeExecutionIsolationPolicy;
  /** Safe-mode latency/memory policy. */
  safeExecution?: {
    prewarmAfterUse?: boolean;
  };
}

export interface BrowserHarnessExecutionHostOptions extends BrowserExecutionWorkerHostOptions {
  /** Providers routed through this host. Defaults to every provider selected by the harness. */
  providers?: readonly Language[];
}

export interface BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];
  readonly executionIsolation: RuntimeExecutionIsolationPolicy;
  getClient(language: Language): RuntimeClient;
  getProfile(language: Language): LanguageRuntimeProfile;
  getSupportedLanguageProfiles(): readonly LanguageRuntimeProfile[];
  getLanguageInfo(language: Language): LanguageRuntimeInfo;
  getSupportedLanguageInfos(): readonly LanguageRuntimeInfo[];
  isLanguageSupported(language: Language): boolean;
  preflightLanguage(language: Language): Promise<BrowserRuntimeReadiness>;
  preflight(): Promise<BrowserRuntimeEnvironmentReport>;
  warmLanguage(language: Language): Promise<{ success: boolean; loadTimeMs: number }>;
  disposeLanguage(language: Language): void;
  dispose(): void;
}

interface ResolvedHarnessContext {
  readonly options: CreateBrowserHarnessOptions;
  readonly providerRegistry: BrowserRuntimeProviderRegistry;
  readonly environment: BrowserRuntimeEnvironment;
  readonly assets: BrowserHarnessAssets;
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

function assertRegisteredProviders(
  registry: BrowserRuntimeProviderRegistry,
  languages: readonly Language[]
): void {
  for (const language of languages) {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      throw new TypeError(`Browser runtime provider ${JSON.stringify(language)} is not supported.`);
    }
    if (!registry.get(language)) {
      throw new TypeError(
        `Browser runtime provider ${JSON.stringify(language)} is selected but not registered.`
      );
    }
  }
}

function resolveHarnessContext(options: CreateBrowserHarnessOptions): ResolvedHarnessContext {
  if (!options.providerRegistry || typeof options.providerRegistry.get !== 'function') {
    throw new TypeError(
      'CreateBrowserHarnessOptions.providerRegistry is required. ' +
        'Register providers from the language packages installed by this application.'
    );
  }
  if (
    options.executionIsolation !== undefined &&
    options.executionIsolation !== 'safe' &&
    options.executionIsolation !== 'unsafe-reuse'
  ) {
    throw new TypeError('executionIsolation must be "safe" or "unsafe-reuse".');
  }
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
      'CreateBrowserHarnessOptions.environment cannot be combined with asset, provider, engine, or feature overrides.'
    );
  }

  const selectedLanguages = options.environment
    ? options.environment.providers
    : options.providers ?? options.providerRegistry.languages;
  assertRegisteredProviders(options.providerRegistry, selectedLanguages);
  const environment = options.environment ?? createBrowserRuntimeEnvironment({
    assetBaseUrl: options.assetBaseUrl,
    assets: options.assets,
    providers: selectedLanguages,
    surface: 'classic',
    engine: options.engine,
    featureOverrides: options.featureOverrides,
  });
  const assets = environment.assets;
  const supportedLanguages = environment.providers;
  assertRegisteredProviders(options.providerRegistry, supportedLanguages);

  const assetPreflight = createBrowserRuntimeAssetPreflight(assets.runtimeManifests);
  const preflight = (runtime: BrowserRuntimeId, assetNames: readonly string[]) =>
    () => assetPreflight.preflight(runtime, assetNames);
  const manifestAsset = (
    runtime: BrowserRuntimeId,
    name: string
  ): BrowserRuntimeAssetDescriptor | undefined => {
    const manifest = assets.runtimeManifests?.[runtime];
    const value = (manifest?.assets as Record<string, unknown> | undefined)?.[name];
    return value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string'
      ? value as BrowserRuntimeAssetDescriptor
      : undefined;
  };
  const manifestAssetCollection = (
    runtime: BrowserRuntimeId,
    name: string
  ): Readonly<Record<string, BrowserRuntimeAssetDescriptor>> | undefined => {
    const manifest = assets.runtimeManifests?.[runtime];
    const value = (manifest?.assets as Record<string, unknown> | undefined)?.[name];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Readonly<Record<string, BrowserRuntimeAssetDescriptor>>
      : undefined;
  };

  const executionHostProviders = new Set<Language>();
  for (const language of options.executionHost
    ? options.executionHost.providers ?? supportedLanguages
    : []) {
    if (!supportedLanguages.includes(language)) {
      throw new TypeError(
        `executionHost provider ${JSON.stringify(language)} is not selected by this browser harness.`
      );
    }
    executionHostProviders.add(language);
  }
  if (options.executionHost && executionHostProviders.size === 0) {
    throw new TypeError('executionHost.providers must select at least one Classic provider.');
  }
  if (
    supportedLanguages.includes('javascript') &&
    supportedLanguages.includes('typescript') &&
    executionHostProviders.has('javascript') !== executionHostProviders.has('typescript')
  ) {
    throw new TypeError(
      'JavaScript and TypeScript share one Classic worker and must be routed through executionHost together.'
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

interface ExecutionHostSlot {
  readonly host: BrowserExecutionWorkerHost | undefined;
  readonly workerFactoryFor: (language: Language) => BrowserWorkerFactory | undefined;
}

function createExecutionHostSlot(context: ResolvedHarnessContext): ExecutionHostSlot {
  if (!context.options.executionHost || context.executionHostProviders.size === 0) {
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
        context.executionHostProviders.has(language) ? host.workerFactory : undefined,
    };
  } catch (error) {
    host.dispose();
    throw error;
  }
}

function disposeProviderLeases(
  leases: readonly BrowserRuntimeProviderLease[],
  executionHost: BrowserExecutionWorkerHost | undefined
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
    throw new AggregateError(errors, 'Browser harness disposal failed.');
  }
}

class BrowserHarnessRuntime implements BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];
  readonly executionIsolation: RuntimeExecutionIsolationPolicy;

  private readonly clients = new Map<Language, RuntimeClient>();
  private readonly leases: BrowserRuntimeProviderLease[] = [];
  private readonly leaseByLanguage = new Map<Language, BrowserRuntimeProviderLease>();
  private readonly executionHostSlot: ExecutionHostSlot;
  private readonly executionHostProviders: ReadonlySet<Language>;
  private disposed = false;

  constructor(options: CreateBrowserHarnessOptions) {
    const context = resolveHarnessContext(options);
    this.environment = context.environment;
    this.assets = context.assets;
    this.supportedLanguages = context.supportedLanguages;
    this.executionIsolation = options.executionIsolation ?? 'safe';
    this.executionHostProviders = context.executionHostProviders;
    this.executionHostSlot = createExecutionHostSlot(context);

    const providerContext: BrowserRuntimeProviderContext = Object.freeze({
      assets: context.assets,
      debug: options.debug ?? false,
      executionIsolation: this.executionIsolation,
      prewarmAfterUse: options.safeExecution?.prewarmAfterUse ?? true,
      workerFactoryFor: this.executionHostSlot.workerFactoryFor,
      preflight: context.preflight,
      manifestAsset: context.manifestAsset,
      manifestAssetCollection: context.manifestAssetCollection,
    });

    try {
      for (const provider of context.providerRegistry.providers) {
        const selectedLanguages = provider.languages.filter((language) =>
          this.supportedLanguages.includes(language)
        );
        if (selectedLanguages.length === 0) continue;

        const lease = provider.create(providerContext);
        // Track the lease before validating its clients so a malformed provider
        // cannot leak resources when construction fails partway through.
        this.leases.push(lease);
        for (const [language] of lease.clients) {
          if (!provider.languages.includes(language)) {
            throw new Error(
              `Browser runtime provider ${JSON.stringify(provider.id)} returned an unowned ` +
                `client for ${JSON.stringify(language)}.`
            );
          }
        }
        for (const language of selectedLanguages) {
          const client = lease.clients.get(language);
          if (!client) {
            throw new Error(
              `Browser runtime provider ${JSON.stringify(provider.id)} did not create its selected ` +
                `${JSON.stringify(language)} client.`
            );
          }
          this.clients.set(language, client);
          this.leaseByLanguage.set(language, lease);
        }
      }
    } catch (error) {
      try {
        disposeProviderLeases(this.leases, this.executionHostSlot.host);
      } catch {
        // Preserve the provider construction failure; acquired resources were
        // still given a best-effort full cleanup above.
      }
      throw error;
    }
  }

  getClient(language: Language): RuntimeClient {
    if (!this.supportedLanguages.includes(language)) {
      throw new Error(`Runtime for language "${language}" is not selected in this browser environment.`);
    }
    const client = this.clients.get(language);
    if (!client) {
      throw new Error(`Runtime for language "${language}" is not registered.`);
    }
    return client;
  }

  getProfile(language: Language): LanguageRuntimeProfile {
    return this.profileForConfiguredIsolation(language);
  }

  getSupportedLanguageProfiles(): readonly LanguageRuntimeProfile[] {
    return this.supportedLanguages.map((language) => this.profileForConfiguredIsolation(language));
  }

  private profileForConfiguredIsolation(language: Language): LanguageRuntimeProfile {
    const profile = getLanguageRuntimeProfile(language);
    const isolation = profile.capabilities.execution.isolation;
    if (this.executionIsolation !== 'unsafe-reuse' || !isolation.unsafeReuseBoundary) return profile;
    return {
      ...profile,
      capabilities: {
        ...profile.capabilities,
        execution: {
          ...profile.capabilities.execution,
          isolation: {
            safeForUntrustedReuse: false,
            boundary: isolation.unsafeReuseBoundary,
            unsafeReuseBoundary: isolation.unsafeReuseBoundary,
          },
        },
      },
    };
  }

  getLanguageInfo(language: Language): LanguageRuntimeInfo {
    return getLanguageRuntimeInfo(language);
  }

  getSupportedLanguageInfos(): readonly LanguageRuntimeInfo[] {
    return this.supportedLanguages.map((language) => getLanguageRuntimeInfo(language));
  }

  isLanguageSupported(language: Language): boolean {
    return this.supportedLanguages.includes(language);
  }

  preflightLanguage(language: Language): Promise<BrowserRuntimeReadiness> {
    return Promise.all([
      this.environment.preflight(language),
      this.executionHostProviders.has(language)
        ? this.executionHostSlot.host?.ready() ?? Promise.resolve()
        : Promise.resolve(),
    ]).then(([readiness]) => readiness);
  }

  preflight(): Promise<BrowserRuntimeEnvironmentReport> {
    return Promise.all([
      this.environment.preflightAll(),
      this.executionHostSlot.host?.ready() ?? Promise.resolve(),
    ]).then(([report]) => report);
  }

  warmLanguage(language: Language): Promise<{ success: boolean; loadTimeMs: number }> {
    if (!this.supportedLanguages.includes(language)) {
      return Promise.reject(
        new Error(`Runtime for language "${language}" is not selected in this browser environment.`)
      );
    }
    return this.leaseByLanguage.get(language)!.warm(language);
  }

  disposeLanguage(language: Language): void {
    if (!this.supportedLanguages.includes(language)) return;
    this.leaseByLanguage.get(language)?.disposeLanguage(language);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeProviderLeases(this.leases, this.executionHostSlot.host);
  }
}

export function createBrowserHarness(options: CreateBrowserHarnessOptions): BrowserHarness {
  return new BrowserHarnessRuntime(options);
}

export {
  DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS,
  resolveBrowserHarnessAssets,
  type BrowserHarnessAssets,
  type BrowserHarnessAssetOverrides,
};
