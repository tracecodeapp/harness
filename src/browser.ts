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
  LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS,
  getLanguageRuntimeOpenSourceInfo,
  getSupportedLanguageRuntimeOpenSourceInfos,
  resolveRuntimeOpenSourceResourceHref,
  type LanguageRuntimeOpenSourceInfo,
  type ResolvedLanguageRuntimeOpenSourceInfo,
  type ResolvedRuntimeOpenSourceComponentInfo,
  type ResolvedRuntimeOpenSourceResource,
  type RuntimeOpenSourceAssetResource,
  type RuntimeOpenSourceComponentInfo,
  type RuntimeOpenSourceInfoOptions,
  type RuntimeOpenSourceResource,
  type RuntimeOpenSourceResourceKind,
  type RuntimeOpenSourceUrlResource,
} from '../packages/runtime-contracts/src/runtime-open-source-info';
import {
  createBrowserRuntimeHost as createProviderBrowserRuntimeHost,
  type BrowserRuntimeHost,
  type BrowserRuntimeHostExecutionHostOptions,
} from '../packages/runtime-browser/src/browser-runtime-host';
import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
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
  type PythonRuntimeImageAssetDescriptor,
} from '../packages/runtime-browser/src/runtime-assets';
import {
  createBrowserRuntimeAssetPreflight,
  type BrowserRuntimeAssetPreflight,
  type BrowserRuntimeAssetPreflightOptions,
} from '../packages/runtime-browser/src/runtime-asset-preflight';
import {
  createBrowserRuntimeEnvironment as createProviderBrowserRuntimeEnvironment,
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
import {
  BROWSER_WORKER_LIFECYCLE_POLICIES,
  type BrowserSafeExecutionOptions,
  type BrowserWorkerLifecyclePolicy,
} from '../packages/runtime-browser/src/worker-lifecycle-policy';
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
  resolveBuiltInTraceJVMRuntimeAssetBaseUrl,
} from '../packages/runtime-java/src/tracejvm-runtime-assets';
import {
  createCSharpBrowserRuntimeProvider,
  type CSharpBrowserRuntimeProviderOptions,
} from '../packages/runtime-csharp/src/browser-runtime-provider';
import {
  createCppBrowserRuntimeProvider,
  type CppBrowserRuntimeProviderOptions,
} from '../packages/runtime-cpp/src/browser-runtime-provider';
import {
  resolveBuiltInTraceCCRuntimeManifest,
} from '../packages/runtime-cpp/src/tracecc-runtime-assets';

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
  BrowserSafeExecutionOptions,
  BrowserWorkerLifecyclePolicy,
  BrowserWorkerFactory,
  BrowserWorkerLike,
  CppCompilerIntegrityEntry,
  CppCompilerIntegrityManifest,
  PythonRuntimeImageAssetDescriptor,
  InstallBrowserExecutionWorkerHostOptions,
  InstalledBrowserExecutionWorkerHost,
  Language,
  LanguageRuntimeInfo,
  LanguageRuntimeOpenSourceInfo,
  LanguageRuntimeProfile,
  ResolvedLanguageRuntimeOpenSourceInfo,
  ResolvedRuntimeOpenSourceComponentInfo,
  ResolvedRuntimeOpenSourceResource,
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
  RuntimeOpenSourceAssetResource,
  RuntimeOpenSourceComponentInfo,
  RuntimeOpenSourceInfoOptions,
  RuntimeOpenSourceResource,
  RuntimeOpenSourceResourceKind,
  RuntimeOpenSourceUrlResource,
  RuntimeProjectIoCapabilityRow,
  RuntimeProjectIoEnvironment,
  RuntimeProjectIoSupport,
  RuntimeProjectIoTier,
  TraceBudget,
  TraceExecutionOptions,
};

export {
  BROWSER_EXECUTION_HOST_PROTOCOL,
  BROWSER_WORKER_LIFECYCLE_POLICIES,
  NODE_RUNTIME_COMPAT_VERSION,
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
  BROWSER_RUNTIME_IDS,
  LANGUAGE_RUNTIME_INFOS,
  LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS,
  LANGUAGE_RUNTIME_PROFILES,
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_RUNTIME_INFOS,
  assertRuntimeRequestSupported,
  createBrowserRuntimeAssetPreflight,
  getLanguageRuntimeInfo,
  getLanguageRuntimeOpenSourceInfo,
  getLanguageRuntimeProfile,
  getRuntimeProjectIoCapability,
  getRuntimeProjectIoCapabilityMatrix,
  getRuntimeProjectIoSupport,
  getSupportedLanguageProfiles,
  getSupportedLanguageRuntimeInfos,
  getSupportedLanguageRuntimeOpenSourceInfos,
  installBrowserExecutionWorkerHost,
  isLanguageSupported,
  isRuntimeSafeForUntrustedReuse,
  resolveBrowserRuntimeAssetManifests,
  resolveRuntimeOpenSourceResourceHref,
};

export {
  createTraceCCRuntimeManifest,
  resolveBuiltInTraceCCRuntimeManifest,
  TRACECC_RUNTIME_ASSET_RELATIVE_PATH,
  TRACECC_RUNTIME_CONTENT_HASH,
  TRACECC_RUNTIME_MANIFEST,
} from '../packages/runtime-cpp/src/tracecc-runtime-assets';

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
  safeExecution?: BrowserSafeExecutionOptions;
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

const CPP_LEGACY_ASSET_KEYS = Object.freeze([
  'cppWorker',
  'cppCompilerWasm',
  'cppLinkerWasm',
  'cppSysroot',
  'cppRuntimeHeader',
  'cppCompilerIntegrity',
] as const);

function withBuiltInRuntimeAssets(
  assetBaseUrl: string | undefined,
  assets: BrowserRuntimeAssetOverrides | undefined
): BrowserRuntimeAssetOverrides {
  const configured = assets ?? {};
  const hasLegacyCppOverride = CPP_LEGACY_ASSET_KEYS.some(
    (key) => configured[key] !== undefined
  );
  if (configured.runtimeManifests?.cpp || hasLegacyCppOverride) {
    return configured;
  }
  const provided = configured.runtimeAssetProvider;
  return {
    ...configured,
    runtimeAssetProvider(runtime) {
      return (
        provided?.(runtime) ??
        (runtime === 'cpp'
          ? resolveBuiltInTraceCCRuntimeManifest(assetBaseUrl ?? '/workers')
          : undefined)
      );
    },
  };
}

/**
 * Creates a reusable deployment environment with the same Harness-owned
 * runtime defaults as {@link createBrowserRuntimeHost}.
 */
export function createBrowserRuntimeEnvironment(
  options: BrowserRuntimeEnvironmentOptions = {}
): BrowserRuntimeEnvironment {
  return createProviderBrowserRuntimeEnvironment({
    ...options,
    assets: withBuiltInRuntimeAssets(options.assetBaseUrl, options.assets),
  });
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
  const csharpPreparedAuthority =
    csharp?.preparedAuthority ??
    hostOptions.environment?.csharpPreparedAuthority;
  const effectiveCSharp =
    csharpPreparedAuthority === undefined
      ? csharp
      : { ...csharp, preparedAuthority: csharpPreparedAuthority };
  const effectiveJava =
    java?.runtimeAssetBaseUrl !== undefined || hostOptions.environment
      ? java
      : {
          ...java,
          runtimeAssetBaseUrl: resolveBuiltInTraceJVMRuntimeAssetBaseUrl(
            hostOptions.assetBaseUrl ?? '/workers'
          ),
        };
  return createProviderBrowserRuntimeHost({
    ...hostOptions,
    ...(!hostOptions.environment
      ? {
          assets: withBuiltInRuntimeAssets(
            hostOptions.assetBaseUrl,
            hostOptions.assets
          ),
        }
      : {}),
    csharpPreparedAuthority,
    providerRegistry: createDefaultBrowserRuntimeProviderRegistry({
      python,
      java: effectiveJava,
      csharp: effectiveCSharp,
      cpp,
    }),
  });
}
