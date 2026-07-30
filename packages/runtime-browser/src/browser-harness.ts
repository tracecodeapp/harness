import type {
  Language,
  LanguageRuntimeProfile,
  RuntimeClient,
  RuntimeExecutionIsolationPolicy,
} from '@tracecode/runtime-core';
import type { LanguageRuntimeInfo } from '@tracecode/runtime-core';
import { getLanguageRuntimeInfo } from '@tracecode/runtime-core';
import {
  DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS,
  resolveBrowserHarnessAssets,
  type BrowserHarnessAssets,
  type BrowserHarnessAssetOverrides,
} from './runtime-assets';
import {
  type BrowserRuntimeEnvironment,
  type BrowserRuntimeEnvironmentReport,
  type BrowserRuntimeFeatureSupport,
  type BrowserRuntimeEngine,
  type BrowserRuntimeReadiness,
} from './runtime-environment';
import type { BrowserExecutionWorkerHostOptions } from './execution-host';
import {
  getLanguageRuntimeProfile,
} from './runtime-profiles';
import type {
  BrowserRuntimeProviderLease,
  BrowserRuntimeProviderRegistry,
} from './runtime-provider-registry';
import {
  createBrowserRuntimeExecutionHostSlot,
  createBrowserRuntimeProviderContext,
  disposeBrowserRuntimeProviderLeases,
  resolveBrowserRuntimeLifecycleContext,
  type BrowserRuntimeExecutionHostSlot,
} from './browser-runtime-lifecycle';

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

export interface BrowserHarnessExecutionHostOptions
  extends BrowserExecutionWorkerHostOptions {
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

function resolveHarnessContext(options: CreateBrowserHarnessOptions) {
  if (
    options.executionIsolation !== undefined &&
    options.executionIsolation !== 'safe' &&
    options.executionIsolation !== 'unsafe-reuse'
  ) {
    throw new TypeError('executionIsolation must be "safe" or "unsafe-reuse".');
  }
  return resolveBrowserRuntimeLifecycleContext(options, {
    optionsName: 'CreateBrowserHarnessOptions',
    ownerName: 'browser harness',
    emptySelectionMessage:
      'Browser runtime environment must select at least one provider.',
    emptyExecutionHostMessage:
      'executionHost.providers must select at least one Classic provider.',
    sharedWorkerName: 'Classic',
  });
}

class BrowserHarnessRuntime implements BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];
  readonly executionIsolation: RuntimeExecutionIsolationPolicy;

  private readonly clients = new Map<Language, RuntimeClient>();
  private readonly leases: BrowserRuntimeProviderLease[] = [];
  private readonly leaseByLanguage = new Map<Language, BrowserRuntimeProviderLease>();
  private readonly executionHostSlot: BrowserRuntimeExecutionHostSlot;
  private readonly executionHostProviders: ReadonlySet<Language>;
  private disposed = false;

  constructor(options: CreateBrowserHarnessOptions) {
    const context = resolveHarnessContext(options);
    this.environment = context.environment;
    this.assets = context.assets;
    this.supportedLanguages = context.supportedLanguages;
    this.executionIsolation = options.executionIsolation ?? 'safe';
    this.executionHostProviders = context.executionHostProviders;
    this.executionHostSlot =
      createBrowserRuntimeExecutionHostSlot(context);

    const providerContext = createBrowserRuntimeProviderContext(
      context,
      this.executionHostSlot,
      this.executionIsolation
    );

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
        disposeBrowserRuntimeProviderLeases(
          this.leases,
          this.executionHostSlot.host,
          'Browser harness disposal failed.'
        );
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
    disposeBrowserRuntimeProviderLeases(
      this.leases,
      this.executionHostSlot.host,
      'Browser harness disposal failed.'
    );
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
