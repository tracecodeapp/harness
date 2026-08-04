import type { Language } from '@tracecode/runtime-contracts';
import {
  resolveBrowserRuntimeAssets,
  type AnyBrowserRuntimeAssetManifest,
  type BrowserRuntimeAssets,
  type BrowserRuntimeAssetOverrides,
  type BrowserRuntimeId,
} from './runtime-assets';
import { createBrowserRuntimeAssetPreflight } from './runtime-asset-preflight';
import { SUPPORTED_LANGUAGES } from './runtime-profiles';

export type BrowserRuntimeEngine = 'chromium' | 'firefox' | 'webkit' | 'unknown';
export type BrowserRuntimeSurface = 'classic' | 'project';
export type BrowserRuntimeReadinessStatus = 'ready' | 'degraded' | 'unavailable';

export interface BrowserRuntimeFeatureSupport {
  worker: boolean;
  webAssembly: boolean;
  webCrypto: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
}

export interface BrowserRuntimeKnownIssue {
  id: string;
  summary: string;
}

export interface BrowserRuntimeReadiness {
  language: Language;
  runtime: BrowserRuntimeId;
  surface: BrowserRuntimeSurface;
  engine: BrowserRuntimeEngine;
  selected: boolean;
  configured: boolean;
  status: BrowserRuntimeReadinessStatus;
  missingFeatures: readonly (keyof BrowserRuntimeFeatureSupport)[];
  knownIssues: readonly BrowserRuntimeKnownIssue[];
  error?: string;
}

export interface BrowserRuntimeEnvironmentReport {
  engine: BrowserRuntimeEngine;
  surface: BrowserRuntimeSurface;
  features: Readonly<BrowserRuntimeFeatureSupport>;
  runtimes: readonly BrowserRuntimeReadiness[];
}

export interface BrowserRuntimeEnvironmentOptions {
  assetBaseUrl?: string;
  assets?: BrowserRuntimeAssetOverrides;
  providers?: readonly Language[];
  surface?: BrowserRuntimeSurface;
  engine?: BrowserRuntimeEngine;
  featureOverrides?: Partial<BrowserRuntimeFeatureSupport>;
  /** Whether the classic C# surface uses packed compiler/runner role workers. */
  csharpPreparedAuthority?: boolean;
}

export interface BrowserRuntimeEnvironment {
  readonly assets: BrowserRuntimeAssets;
  readonly providers: readonly Language[];
  readonly engine: BrowserRuntimeEngine;
  readonly surface: BrowserRuntimeSurface;
  readonly features: Readonly<BrowserRuntimeFeatureSupport>;
  readonly csharpPreparedAuthority?: boolean;
  preflight(language: Language): Promise<BrowserRuntimeReadiness>;
  preflightAll(): Promise<BrowserRuntimeEnvironmentReport>;
}

function preflightAssets(
  language: Language,
  surface: BrowserRuntimeSurface,
  csharpPreparedAuthority: boolean
): readonly string[] {
  switch (language) {
    case 'python':
      return ['worker', 'runtimeCore', 'snippets', 'runtimeLoader', 'runtimeIndex', 'distribution', 'packages'];
    case 'javascript':
      return surface === 'project' ? ['projectWorker', 'libraries'] : ['worker', 'libraries'];
    case 'typescript':
      return surface === 'project' ? ['projectWorker', 'libraries', 'compiler'] : ['worker', 'libraries', 'compiler'];
    case 'java':
      return ['worker'];
    case 'csharp':
      if (surface === 'project' || !csharpPreparedAuthority) {
        return ['worker', 'assetBaseUrl', 'dependencies'];
      }
      return [
        'worker',
        'assetBaseUrl',
        'compilerAssetBaseUrl',
        'runnerAssetBaseUrl',
        'dependencies',
        'compilerDependencies',
        'runnerDependencies',
      ];
    case 'cpp':
      return [
        'worker',
        'compilerFrame',
        'compilerWorker',
        'runtimeHeader',
        'compilerBundle',
        'compilerWasm',
        'linkerWasm',
        'sysroot',
        'compilerResources',
      ];
  }
}

function detectEngine(userAgent = globalThis.navigator?.userAgent ?? ''): BrowserRuntimeEngine {
  if (
    /applewebkit\//iu.test(userAgent) &&
    /(?:crios|fxios|edgios|opios)\//iu.test(userAgent)
  ) {
    return 'webkit';
  }
  if (/firefox\//iu.test(userAgent)) return 'firefox';
  if (/applewebkit\//iu.test(userAgent) && !/(?:chrome|chromium|crios|edg)\//iu.test(userAgent)) return 'webkit';
  if (/(?:chrome|chromium|crios|edg)\//iu.test(userAgent)) return 'chromium';
  return 'unknown';
}

function detectFeatures(overrides: Partial<BrowserRuntimeFeatureSupport> = {}): Readonly<BrowserRuntimeFeatureSupport> {
  return Object.freeze({
    worker: typeof globalThis.Worker !== 'undefined',
    webAssembly: typeof globalThis.WebAssembly !== 'undefined',
    webCrypto: typeof globalThis.crypto?.subtle !== 'undefined',
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    ...overrides,
  });
}

function requiredFeatures(
  language: Language,
  surface: BrowserRuntimeSurface,
  manifest: AnyBrowserRuntimeAssetManifest | undefined,
  csharpPreparedAuthority: boolean
): readonly (keyof BrowserRuntimeFeatureSupport)[] {
  const required: Array<keyof BrowserRuntimeFeatureSupport> = ['worker'];
  if (language === 'python' || language === 'java' || language === 'csharp' || language === 'cpp') {
    required.push('webAssembly');
  }
  if (language === 'java' && surface === 'project') {
    required.push('sharedArrayBuffer', 'crossOriginIsolated');
  }
  const csharpPreparedRolesEnabled =
    csharpPreparedAuthority &&
    language === 'csharp' &&
    surface === 'classic' &&
    (
      !manifest ||
      (
        manifest.runtime === 'csharp' &&
        Boolean(manifest.assets.compilerAssetBaseUrl) &&
        Boolean(manifest.assets.runnerAssetBaseUrl)
      )
    );
  if (csharpPreparedRolesEnabled) required.push('webCrypto');
  return required;
}

function knownIssues(engine: BrowserRuntimeEngine, language: Language): readonly BrowserRuntimeKnownIssue[] {
  if (engine === 'webkit' && language === 'cpp') {
    return Object.freeze([{
      id: 'webkit-cpp-wasm-null-reference',
      summary: 'Hosted WebKit soak testing has observed an intermittent internal null-reference while entering compiled C++ WebAssembly.',
    }]);
  }
  return Object.freeze([]);
}

function normalizeProviders(providers: readonly Language[] | undefined): readonly Language[] {
  const selected = providers ?? SUPPORTED_LANGUAGES;
  const normalized: Language[] = [];
  for (const language of selected) {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      throw new TypeError(`Browser runtime environment provider ${JSON.stringify(language)} is not supported.`);
    }
    if (!normalized.includes(language)) normalized.push(language);
  }
  if (normalized.length === 0) throw new TypeError('Browser runtime environment must select at least one provider.');
  return Object.freeze(normalized);
}

export function createBrowserRuntimeEnvironment(
  options: BrowserRuntimeEnvironmentOptions = {}
): BrowserRuntimeEnvironment {
  const assets = resolveBrowserRuntimeAssets(options);
  const providers = normalizeProviders(options.providers);
  const engine = options.engine ?? detectEngine();
  const surface = options.surface ?? 'classic';
  const features = detectFeatures(options.featureOverrides);
  const csharpPreparedAuthority = options.csharpPreparedAuthority !== false;
  const assetPreflight = createBrowserRuntimeAssetPreflight(assets.runtimeManifests);

  const preflight = async (language: Language): Promise<BrowserRuntimeReadiness> => {
    const selected = providers.includes(language);
    const manifest = assets.runtimeManifests?.[language];
    const configured = true;
    const missingFeatures = requiredFeatures(
      language,
      surface,
      manifest,
      csharpPreparedAuthority
    ).filter((feature) => !features[feature]);
    const issues = knownIssues(engine, language);
    let error: string | undefined;
    if (selected && configured && missingFeatures.length === 0) {
      try {
        await assetPreflight.preflight(
          language,
          preflightAssets(language, surface, csharpPreparedAuthority)
        );
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    const unavailable = !selected || !configured || missingFeatures.length > 0 || error !== undefined;
    return Object.freeze({
      language,
      runtime: language,
      surface,
      engine,
      selected,
      configured,
      status: unavailable ? 'unavailable' : issues.length > 0 ? 'degraded' : 'ready',
      missingFeatures: Object.freeze(missingFeatures),
      knownIssues: issues,
      ...(error ? { error } : {}),
    });
  };

  return Object.freeze({
    assets,
    providers,
    engine,
    surface,
    features,
    csharpPreparedAuthority,
    preflight,
    async preflightAll(): Promise<BrowserRuntimeEnvironmentReport> {
      const runtimes = await Promise.all(SUPPORTED_LANGUAGES.map(preflight));
      return Object.freeze({ engine, surface, features, runtimes: Object.freeze(runtimes) });
    },
  });
}
