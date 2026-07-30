import type {
  Language,
  LanguageRuntimeProfile,
  RuntimeCapabilities,
  RuntimeCompileCost,
  RuntimeExecutionIsolationBoundary,
  RuntimeExecutionIsolationPolicy,
  RuntimeExecutionIsolationSupport,
  RuntimeExecutionLimitSupport,
  RuntimeExecutionLimits,
  RuntimeExecutionPipeline,
  RuntimeExecutionStyle,
  RuntimeMaturity,
  RuntimeProjectIoCapabilityRow,
  RuntimeProjectIoEnvironment,
  RuntimeProjectIoSupport,
  RuntimeProjectIoTier,
  TraceBudget,
  TraceExecutionOptions,
} from '../packages/runtime-contracts/src/runtime-capabilities';
import {
  NODE_RUNTIME_COMPAT_VERSION,
  LANGUAGE_RUNTIME_INFOS,
  SUPPORTED_LANGUAGE_RUNTIME_INFOS,
  getLanguageRuntimeInfo,
  getSupportedLanguageRuntimeInfos,
  type LanguageRuntimeInfo,
  type RuntimeComponentInfo,
  type RuntimeLibraryInfo,
} from '../packages/runtime-contracts/src/runtime-language-info';
import {
  createBrowserRuntimeHost as createProviderBrowserRuntimeHost,
  type BrowserRuntimeHost,
  type BrowserRuntimeHostExecutionHostOptions,
} from '../packages/runtime-browser/src/browser-runtime-host';
import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  BROWSER_RUNTIME_IDS,
  resolveBrowserRuntimeAssetManifests,
  type AnyBrowserRuntimeAssetManifest,
  BrowserRuntimeAssetOverrides,
  BrowserRuntimeAssets,
  type BrowserRuntimeAssetDelivery,
  type BrowserRuntimeAssetDescriptor,
  type BrowserRuntimeAssetManifest,
  type BrowserRuntimeAssetManifestProvider,
  type BrowserRuntimeAssetManifests,
  type BrowserRuntimeAssetOriginPolicy,
  type BrowserRuntimeAssetsByRuntime,
  type BrowserRuntimeId,
  type BrowserRuntimeLoaderFormat,
  type BrowserRuntimeWorkerFormat,
  type CppCompilerIntegrityEntry,
  type CppCompilerIntegrityManifest,
} from '../packages/runtime-browser/src/runtime-assets';
import {
  createBrowserRuntimeAssetPreflight,
  type BrowserRuntimeAssetPreflight,
  type BrowserRuntimeAssetPreflightOptions,
} from '../packages/runtime-browser/src/runtime-asset-preflight';
import {
  createBrowserRuntimeEnvironment,
  BrowserRuntimeEngine,
  BrowserRuntimeEnvironment,
  BrowserRuntimeEnvironmentReport,
  type BrowserRuntimeEnvironmentOptions,
  BrowserRuntimeFeatureSupport,
  BrowserRuntimeKnownIssue,
  BrowserRuntimeReadiness,
  BrowserRuntimeReadinessStatus,
  BrowserRuntimeSurface,
} from '../packages/runtime-browser/src/runtime-environment';
import {
  BROWSER_EXECUTION_HOST_PROTOCOL,
  installBrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHostOptions,
  type BrowserWorkerFactory,
  type BrowserWorkerLike,
  type InstallBrowserExecutionWorkerHostOptions,
  type InstalledBrowserExecutionWorkerHost,
} from '../packages/runtime-browser/src/execution-host';
import {
  LANGUAGE_RUNTIME_PROFILES,
  SUPPORTED_LANGUAGES,
  getLanguageRuntimeProfile,
  getRuntimeProjectIoCapability,
  getRuntimeProjectIoCapabilityMatrix,
  getRuntimeProjectIoSupport,
  getSupportedLanguageProfiles,
  isLanguageSupported,
  isRuntimeSafeForUntrustedReuse,
} from '../packages/runtime-browser/src/runtime-profiles';
import {
  assertRuntimeRequestSupported,
} from '../packages/runtime-browser/src/runtime-capability-guards';
import { createBrowserRuntimeProviderRegistry } from '../packages/runtime-browser/src/runtime-provider-registry';
import {
  createPythonBrowserRuntimeProvider,
  type PythonBrowserRuntimeProviderOptions,
} from '../packages/runtime-python/src/browser-runtime-provider';
import {
  createJavaScriptBrowserRuntimeProvider,
} from '../packages/runtime-javascript/src/browser-runtime-provider';
import {
  createJavaBrowserRuntimeProvider,
  type JavaBrowserRuntimeProviderOptions,
} from '../packages/runtime-java/src/browser-runtime-provider';
import {
  createCSharpBrowserRuntimeProvider,
  type CSharpBrowserRuntimeProviderOptions,
} from '../packages/runtime-csharp/src/browser-runtime-provider';
import {
  createCppBrowserRuntimeProvider,
  type CppBrowserRuntimeProviderOptions,
} from '../packages/runtime-cpp/src/browser-runtime-provider';

export type {
  AnyBrowserRuntimeAssetManifest,
  BrowserRuntimeAssetOverrides,
  BrowserRuntimeAssets,
  BrowserExecutionWorkerHostOptions,
  BrowserRuntimeAssetDelivery,
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeAssetManifest,
  BrowserRuntimeAssetManifestProvider,
  BrowserRuntimeAssetManifests,
  BrowserRuntimeAssetOriginPolicy,
  BrowserRuntimeAssetPreflight,
  BrowserRuntimeAssetPreflightOptions,
  BrowserRuntimeAssetsByRuntime,
  BrowserRuntimeEngine,
  BrowserRuntimeEnvironment,
  BrowserRuntimeEnvironmentOptions,
  BrowserRuntimeEnvironmentReport,
  BrowserRuntimeFeatureSupport,
  BrowserRuntimeHost,
  BrowserRuntimeHostExecutionHostOptions,
  BrowserRuntimeId,
  BrowserRuntimeKnownIssue,
  BrowserRuntimeLoaderFormat,
  BrowserRuntimeReadiness,
  BrowserRuntimeReadinessStatus,
  BrowserRuntimeSurface,
  BrowserRuntimeWorkerFormat,
  BrowserWorkerFactory,
  BrowserWorkerLike,
  CppCompilerIntegrityEntry,
  CppCompilerIntegrityManifest,
  InstallBrowserExecutionWorkerHostOptions,
  InstalledBrowserExecutionWorkerHost,
  Language,
  LanguageRuntimeInfo,
  LanguageRuntimeProfile,
  RuntimeCapabilities,
  RuntimeCompileCost,
  RuntimeComponentInfo,
  RuntimeExecutionIsolationBoundary,
  RuntimeExecutionIsolationPolicy,
  RuntimeExecutionIsolationSupport,
  RuntimeExecutionLimitSupport,
  RuntimeExecutionLimits,
  RuntimeExecutionPipeline,
  RuntimeExecutionStyle,
  RuntimeLibraryInfo,
  RuntimeMaturity,
  RuntimeProjectIoCapabilityRow,
  RuntimeProjectIoEnvironment,
  RuntimeProjectIoSupport,
  RuntimeProjectIoTier,
  TraceBudget,
  TraceExecutionOptions,
};

export {
  BROWSER_EXECUTION_HOST_PROTOCOL,
  NODE_RUNTIME_COMPAT_VERSION,
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  BROWSER_RUNTIME_IDS,
  LANGUAGE_RUNTIME_INFOS,
  LANGUAGE_RUNTIME_PROFILES,
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_RUNTIME_INFOS,
  assertRuntimeRequestSupported,
  createBrowserRuntimeAssetPreflight,
  createBrowserRuntimeEnvironment,
  getLanguageRuntimeInfo,
  getLanguageRuntimeProfile,
  getRuntimeProjectIoCapability,
  getRuntimeProjectIoCapabilityMatrix,
  getRuntimeProjectIoSupport,
  getSupportedLanguageProfiles,
  getSupportedLanguageRuntimeInfos,
  installBrowserExecutionWorkerHost,
  isLanguageSupported,
  isRuntimeSafeForUntrustedReuse,
  resolveBrowserRuntimeAssetManifests,
};

/**
 * Language-specific tuning for the default providers installed behind the
 * browser runtime host. Provider objects and registries are intentionally not
 * part of the public package surface.
 */
export interface DefaultBrowserRuntimeProviderOptions {
  python?: PythonBrowserRuntimeProviderOptions;
  java?: JavaBrowserRuntimeProviderOptions;
  csharp?: CSharpBrowserRuntimeProviderOptions;
  cpp?: CppBrowserRuntimeProviderOptions;
}

/**
 * Supported public configuration for the browser-owned runtime lifecycle.
 *
 * The provider registry is assembled privately so callers cannot bypass the
 * host/Judge boundary with a direct runtime client or prepared provider.
 */
export interface CreateBrowserRuntimeHostOptions
  extends DefaultBrowserRuntimeProviderOptions {
  assetBaseUrl?: string;
  assets?: BrowserRuntimeAssetOverrides;
  /** Optional shared deployment/readiness environment. */
  environment?: BrowserRuntimeEnvironment;
  /** Languages exposed by this host. Defaults to every installed language. */
  providers?: readonly Language[];
  engine?: BrowserRuntimeEngine;
  featureOverrides?: Partial<BrowserRuntimeFeatureSupport>;
  /** Runs selected provider workers on a dedicated, credential-free origin. */
  executionHost?: BrowserRuntimeHostExecutionHostOptions;
  debug?: boolean;
  safeExecution?: {
    prewarmAfterUse?: boolean;
  };
}

function createDefaultBrowserRuntimeProviderRegistry(
  options: DefaultBrowserRuntimeProviderOptions
) {
  return createBrowserRuntimeProviderRegistry([
    createPythonBrowserRuntimeProvider(options.python),
    createJavaScriptBrowserRuntimeProvider(),
    createJavaBrowserRuntimeProvider(options.java),
    createCSharpBrowserRuntimeProvider(options.csharp),
    createCppBrowserRuntimeProvider(options.cpp),
  ]);
}

/**
 * Creates the browser-owned lifecycle used by Judge-backed execution.
 *
 * Direct runtime clients, provider registries, and prepared providers remain
 * private implementation details.
 */
export function createBrowserRuntimeHost(
  options: CreateBrowserRuntimeHostOptions = {}
): BrowserRuntimeHost {
  const {
    python,
    java,
    csharp,
    cpp,
    ...hostOptions
  } = options;
  return createProviderBrowserRuntimeHost({
    ...hostOptions,
    providerRegistry: createDefaultBrowserRuntimeProviderRegistry({
      python,
      java,
      csharp,
      cpp,
    }),
  });
}
