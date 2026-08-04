import type {
  Language,
  RuntimePreparedExecutionProvider,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '@tracecode/runtime-contracts';
import type {
  BrowserRuntimeAssetOverrides,
  BrowserRuntimeAssets,
} from './runtime-assets';
import {
  type BrowserRuntimeEngine,
  type BrowserRuntimeEnvironment,
  type BrowserRuntimeEnvironmentReport,
  type BrowserRuntimeFeatureSupport,
  type BrowserRuntimeReadiness,
} from './runtime-environment';
import type { BrowserExecutionWorkerHostOptions } from './execution-host';
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
import {
  registerBrowserRuntimeHostPreparedProviderResolver,
} from './browser-runtime-host-internal';
import type {
  BrowserSafeExecutionOptions,
} from './worker-lifecycle-policy';

export interface BrowserRuntimeHostExecutionHostOptions
  extends BrowserExecutionWorkerHostOptions {
  /** Languages routed through the credential-free execution origin. */
  providers?: readonly Language[];
}

export interface CreateBrowserRuntimeHostOptions {
  /** Installed language providers available to this host. */
  providerRegistry: BrowserRuntimeProviderRegistry;
  assetBaseUrl?: string;
  assets?: BrowserRuntimeAssetOverrides;
  /** Optional shared V2 deployment/readiness environment. */
  environment?: BrowserRuntimeEnvironment;
  /** Languages exposed by this host. Defaults to every registered language. */
  providers?: readonly Language[];
  engine?: BrowserRuntimeEngine;
  featureOverrides?: Partial<BrowserRuntimeFeatureSupport>;
  /** Must match the C# provider's prepared-authority mode. */
  csharpPreparedAuthority?: boolean;
  /** Runs selected provider workers on a dedicated, credential-free origin. */
  executionHost?: BrowserRuntimeHostExecutionHostOptions;
  debug?: boolean;
  safeExecution?: BrowserSafeExecutionOptions;
}

/**
 * Browser-owned runtime lifecycle for Judge-backed execution.
 *
 * This host deliberately has no direct execution surface. It owns deployment
 * assets, readiness, provider acquisition, warmup, and teardown, then exposes
 * only lifecycle operations. Judge obtains its prepare-once provider through a
 * package-internal capability whose case-isolation contract is checked at the
 * point a program is prepared.
 */
export interface BrowserRuntimeHost {
  readonly assets: BrowserRuntimeAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];
  isLanguageSupported(language: Language): boolean;
  preflightLanguage(language: Language): Promise<BrowserRuntimeReadiness>;
  preflight(): Promise<BrowserRuntimeEnvironmentReport>;
  warmLanguage(
    language: Language
  ): Promise<{ success: boolean; loadTimeMs: number }>;
  disposeLanguage(language: Language): void;
  dispose(): void;
}

function resolveHostContext(
  options: CreateBrowserRuntimeHostOptions
) {
  return resolveBrowserRuntimeLifecycleContext(options, {
    optionsName: 'CreateBrowserRuntimeHostOptions',
    ownerName: 'browser runtime host',
    emptySelectionMessage:
      'Browser runtime host must select at least one provider.',
    emptyExecutionHostMessage:
      'executionHost.providers must select at least one runtime provider.',
    sharedWorkerName: 'shared',
  });
}

function assertLeaseShape(
  providerId: string,
  lease: BrowserRuntimeProviderLease
): void {
  if (!lease || typeof lease !== 'object') {
    throw new Error(
      `Browser runtime provider ${JSON.stringify(providerId)} did not return a lease.`
    );
  }
  if (
    !lease.preparedProviders ||
    typeof lease.preparedProviders.get !== 'function' ||
    typeof lease.preparedProviders[Symbol.iterator] !== 'function'
  ) {
    throw new Error(
      `Browser runtime provider ${JSON.stringify(providerId)} did not return a prepared provider map.`
    );
  }
  if (
    (
      lease.preflightLanguage !== undefined &&
      typeof lease.preflightLanguage !== 'function'
    ) ||
    typeof lease.disposeLanguage !== 'function' ||
    typeof lease.dispose !== 'function'
  ) {
    throw new Error(
      `Browser runtime provider ${JSON.stringify(providerId)} returned an incomplete lifecycle lease.`
    );
  }
}

function assertPreparedProviderShape(
  providerId: string,
  language: Language,
  provider: RuntimePreparedExecutionProvider | undefined
): asserts provider is RuntimePreparedExecutionProvider {
  if (
    !provider ||
    typeof provider !== 'object' ||
    typeof provider.init !== 'function' ||
    typeof provider.prepareProgram !== 'function'
  ) {
    throw new Error(
      `Browser runtime provider ${JSON.stringify(providerId)} returned an invalid ` +
        `prepared provider for ${JSON.stringify(language)}.`
    );
  }
}

async function rejectUnsafePreparedProgram(
  language: Language,
  result: RuntimeProgramPreparationResult
): Promise<RuntimeProgramPreparationResult> {
  if (result.kind !== 'prepared') return result;

  const { program } = result;
  const capabilities = program?.capabilities;
  const valid =
    program &&
    (program.mode === 'code' || program.mode === 'trace') &&
    typeof program.dispose === 'function' &&
    typeof program.executeIsolated === 'function' &&
    capabilities?.caseIsolation === 'fresh-case-state' &&
    Number.isInteger(capabilities.maxConcurrency) &&
    capabilities.maxConcurrency > 0;
  if (valid) return result;

  let disposalError: unknown;
  try {
    if (program && typeof program.dispose === 'function') {
      await program.dispose();
    }
  } catch (error) {
    disposalError = error;
  }
  const contractError = new Error(
    `Prepared browser runtime for ${JSON.stringify(language)} must provide ` +
      'fresh-case-state isolation and a positive integer maxConcurrency.'
  );
  if (disposalError !== undefined) {
    throw new AggregateError(
      [contractError, disposalError],
      `Unsafe prepared browser runtime for ${JSON.stringify(language)} also failed disposal.`
    );
  }
  throw contractError;
}

function safePreparedProvider(
  language: Language,
  delegate: RuntimePreparedExecutionProvider,
  assertActive: () => void
): RuntimePreparedExecutionProvider {
  return Object.freeze({
    async init(): Promise<{ success: boolean; loadTimeMs: number }> {
      assertActive();
      return delegate.init();
    },
    async prepareProgram(
      call: RuntimeProgramPreparationCall
    ): Promise<RuntimeProgramPreparationResult> {
      assertActive();
      const result = await delegate.prepareProgram(call);
      const checked = await rejectUnsafePreparedProgram(language, result);
      if (checked.kind === 'prepared' && checked.program.mode !== call.mode) {
        await checked.program.dispose();
        throw new Error(
          `Prepared browser runtime for ${JSON.stringify(language)} returned a ` +
            `${JSON.stringify(checked.program.mode)} program for a ${JSON.stringify(call.mode)} preparation.`
        );
      }
      return checked;
    },
  });
}

class BrowserRuntimeHostImplementation implements BrowserRuntimeHost {
  readonly assets: BrowserRuntimeAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];

  readonly #preparedProviders = new Map<
    Language,
    RuntimePreparedExecutionProvider
  >();
  readonly #leases: BrowserRuntimeProviderLease[] = [];
  readonly #leaseByLanguage = new Map<
    Language,
    BrowserRuntimeProviderLease
  >();
  readonly #executionHostSlot: BrowserRuntimeExecutionHostSlot;
  readonly #executionHostProviders: ReadonlySet<Language>;
  #disposed = false;

  constructor(options: CreateBrowserRuntimeHostOptions) {
    const context = resolveHostContext(options);
    this.environment = context.environment;
    this.assets = context.assets;
    this.supportedLanguages = context.supportedLanguages;
    this.#executionHostProviders = context.executionHostProviders;
    this.#executionHostSlot =
      createBrowserRuntimeExecutionHostSlot(context);

    const providerContext = createBrowserRuntimeProviderContext(
      context,
      this.#executionHostSlot
    );

    try {
      for (const provider of context.providerRegistry.providers) {
        const selectedLanguages = provider.languages.filter((language) =>
          this.supportedLanguages.includes(language)
        );
        if (selectedLanguages.length === 0) continue;

        const lease = provider.create(providerContext);
        // Track first so malformed providers cannot leak partially acquired
        // runtime resources.
        this.#leases.push(lease);
        assertLeaseShape(provider.id, lease);

        for (const [language, preparedProvider] of lease.preparedProviders) {
          if (!provider.languages.includes(language)) {
            throw new Error(
              `Browser runtime provider ${JSON.stringify(provider.id)} returned an unowned ` +
                `prepared provider for ${JSON.stringify(language)}.`
            );
          }
          assertPreparedProviderShape(provider.id, language, preparedProvider);
        }

        for (const language of selectedLanguages) {
          const preparedProvider = lease.preparedProviders.get(language);
          assertPreparedProviderShape(
            provider.id,
            language,
            preparedProvider
          );
          this.#preparedProviders.set(
            language,
            safePreparedProvider(
              language,
              preparedProvider,
              () => this.#assertActive()
            )
          );
          this.#leaseByLanguage.set(language, lease);
        }
      }
      for (const language of this.supportedLanguages) {
        if (!this.#preparedProviders.has(language)) {
          throw new Error(
            `Browser runtime host did not acquire a prepared provider for selected ` +
              `language ${JSON.stringify(language)}.`
          );
        }
      }
      registerBrowserRuntimeHostPreparedProviderResolver(
        this,
        (language) => {
          this.#assertActive();
          if (!this.supportedLanguages.includes(language)) {
            throw new Error(
              `Runtime for language "${language}" is not selected in this browser environment.`
            );
          }
          const provider = this.#preparedProviders.get(language);
          if (!provider) {
            throw new Error(
              `Prepared runtime for language "${language}" is not registered.`
            );
          }
          return provider;
        }
      );
    } catch (error) {
      try {
        disposeBrowserRuntimeProviderLeases(
          this.#leases,
          this.#executionHostSlot.host,
          'Browser runtime host disposal failed.'
        );
      } catch {
        // Preserve the provider construction failure after best-effort cleanup.
      }
      throw error;
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('Browser runtime host has been disposed.');
    }
  }

  isLanguageSupported(language: Language): boolean {
    return this.supportedLanguages.includes(language);
  }

  async #applyProviderReadiness(
    readiness: BrowserRuntimeReadiness,
    executionHostReady: Promise<void>
  ): Promise<BrowserRuntimeReadiness> {
    try {
      await Promise.all([
        executionHostReady,
        this.#leaseByLanguage
          .get(readiness.language)
          ?.preflightLanguage?.(readiness.language) ?? Promise.resolve(),
      ]);
      return readiness;
    } catch (error) {
      return Object.freeze({
        ...readiness,
        status: 'unavailable' as const,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async preflightLanguage(
    language: Language
  ): Promise<BrowserRuntimeReadiness> {
    this.#assertActive();
    const readiness = await this.environment.preflight(language);
    return this.#applyProviderReadiness(
      readiness,
      this.#executionHostProviders.has(language)
        ? this.#executionHostSlot.host?.ready() ?? Promise.resolve()
        : Promise.resolve()
    );
  }

  async preflight(): Promise<BrowserRuntimeEnvironmentReport> {
    this.#assertActive();
    const report = await this.environment.preflightAll();
    const executionHostReady =
      this.#executionHostSlot.host?.ready() ?? Promise.resolve();
    const runtimes = await Promise.all(
      report.runtimes.map((readiness) => {
        if (!readiness.selected) return readiness;
        return this.#applyProviderReadiness(
          readiness,
          this.#executionHostProviders.has(readiness.language)
            ? executionHostReady
            : Promise.resolve()
        );
      })
    );
    return Object.freeze({
      ...report,
      runtimes: Object.freeze(runtimes),
    });
  }

  warmLanguage(
    language: Language
  ): Promise<{ success: boolean; loadTimeMs: number }> {
    this.#assertActive();
    if (!this.supportedLanguages.includes(language)) {
      return Promise.reject(
        new Error(
          `Runtime for language "${language}" is not selected in this browser environment.`
        )
      );
    }
    return this.#preparedProviders.get(language)!.init();
  }

  disposeLanguage(language: Language): void {
    if (this.#disposed || !this.supportedLanguages.includes(language)) return;
    this.#leaseByLanguage.get(language)?.disposeLanguage(language);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    disposeBrowserRuntimeProviderLeases(
      this.#leases,
      this.#executionHostSlot.host,
      'Browser runtime host disposal failed.'
    );
  }
}

export function createBrowserRuntimeHost(
  options: CreateBrowserRuntimeHostOptions
): BrowserRuntimeHost {
  return new BrowserRuntimeHostImplementation(options);
}
