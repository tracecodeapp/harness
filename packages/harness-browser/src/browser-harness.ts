import type {
  Language,
  LanguageRuntimeProfile,
  RuntimeClient,
} from '@tracecode/harness-core';
import type { LanguageRuntimeInfo } from '@tracecode/harness-core';
import { getLanguageRuntimeInfo } from '@tracecode/harness-core';
import { JavaScriptWorkerClient } from './javascript-worker-client';
import { createJavaScriptRuntimeClient } from './javascript-runtime-client';
import { JavaWorkerClient } from './java-worker-client';
import { createJavaRuntimeClient } from './java-runtime-client';
import { CSharpWorkerClient } from './csharp-worker-client';
import { createCSharpRuntimeClient } from './csharp-runtime-client';
import { CppWorkerClient } from './cpp-worker-client';
import { createCppRuntimeClient } from './cpp-runtime-client';
import { PythonWorkerClient } from './pyodide-worker-client';
import { createPythonRuntimeClient } from './python-runtime-client';
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
} from './runtime-profiles';

export interface CreateBrowserHarnessOptions {
  assetBaseUrl?: string;
  assets?: BrowserHarnessAssetOverrides;
  /** Optional shared V2 deployment/readiness environment. */
  environment?: BrowserRuntimeEnvironment;
  /** Providers exposed by this harness. Defaults to every built-in language. */
  providers?: readonly Language[];
  engine?: BrowserRuntimeEngine;
  featureOverrides?: Partial<BrowserRuntimeFeatureSupport>;
  /** Runs every selected provider worker on a dedicated, credential-free origin. */
  executionHost?: BrowserExecutionWorkerHostOptions;
  debug?: boolean;
  java?: {
    workerIdleTimeoutMs?: number;
    compileCacheLimit?: number;
    externalCompilerUrl?: string;
    cheerpjLoaderUrl?: string;
  };
  csharp?: {
    workerIdleTimeoutMs?: number;
  };
  cpp?: {
    initTimeoutMs?: number;
    executionTimeoutMs?: number;
    tracingTimeoutMs?: number;
    interviewTimeoutMs?: number;
    workerIdleTimeoutMs?: number;
    programCacheLimit?: number;
    usePrecompiledHeader?: boolean;
    externalCompilerUrl?: string;
  };
}

export interface BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];
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

class BrowserHarnessRuntime implements BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];

  private readonly pythonWorkerClient: PythonWorkerClient;
  private readonly javaScriptWorkerClient: JavaScriptWorkerClient;
  private readonly javaWorkerClient: JavaWorkerClient;
  private readonly csharpWorkerClient: CSharpWorkerClient;
  private readonly cppWorkerClient: CppWorkerClient;
  private readonly executionHost?: BrowserExecutionWorkerHost;
  private readonly clients: Record<Language, RuntimeClient>;

  constructor(options: CreateBrowserHarnessOptions = {}) {
    if (
      options.environment &&
      (options.assetBaseUrl !== undefined || options.assets !== undefined || options.providers !== undefined ||
        options.engine !== undefined || options.featureOverrides !== undefined)
    ) {
      throw new TypeError(
        'CreateBrowserHarnessOptions.environment cannot be combined with asset, provider, engine, or feature overrides.'
      );
    }
    this.environment = options.environment ?? createBrowserRuntimeEnvironment({
      assetBaseUrl: options.assetBaseUrl,
      assets: options.assets,
      providers: options.providers,
      surface: 'classic',
      engine: options.engine,
      featureOverrides: options.featureOverrides,
    });
    this.assets = this.environment.assets;
    this.supportedLanguages = this.environment.providers;
    const assetPreflight = createBrowserRuntimeAssetPreflight(this.assets.runtimeManifests);
    const preflight = (runtime: BrowserRuntimeId, assetNames: readonly string[]) =>
      () => assetPreflight.preflight(runtime, assetNames);
    const manifestAsset = (
      runtime: BrowserRuntimeId,
      name: string
    ): BrowserRuntimeAssetDescriptor | undefined => {
      const manifest = this.assets.runtimeManifests?.[runtime];
      const value = (manifest?.assets as Record<string, unknown> | undefined)?.[name];
      return value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string'
        ? value as BrowserRuntimeAssetDescriptor
        : undefined;
    };
    const manifestAssetCollection = (
      runtime: BrowserRuntimeId,
      name: string
    ): Readonly<Record<string, BrowserRuntimeAssetDescriptor>> | undefined => {
      const manifest = this.assets.runtimeManifests?.[runtime];
      const value = (manifest?.assets as Record<string, unknown> | undefined)?.[name];
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, BrowserRuntimeAssetDescriptor>>
        : undefined;
    };
    const pythonPackageDescriptors = manifestAssetCollection('python', 'packages');
    const javaManifest = this.assets.runtimeManifests?.java;
    const csharpDependencyDescriptors = manifestAssetCollection('csharp', 'dependencies');
    if (javaManifest?.assets.loader && options.java?.cheerpjLoaderUrl) {
      throw new TypeError(
        'Java runtime assets cannot combine manifest.assets.loader with java.cheerpjLoaderUrl.'
      );
    }
    this.executionHost = options.executionHost
      ? createBrowserExecutionWorkerHost(options.executionHost)
      : undefined;
    const workerFactory = this.executionHost?.workerFactory;
    if (this.executionHost) {
      const workerUrls = new Map<Language, string>([
        ['python', this.assets.pythonWorker],
        ['javascript', this.assets.javascriptWorker],
        ['typescript', this.assets.javascriptWorker],
        ['java', this.assets.javaWorker],
        ['csharp', this.assets.csharpWorker],
        ['cpp', this.assets.cppWorker],
      ]);
      for (const language of this.supportedLanguages) {
        const workerUrl = new URL(workerUrls.get(language)!, `${this.executionHost.origin}/`);
        if (workerUrl.origin !== this.executionHost.origin) {
          this.executionHost.dispose();
          throw new Error(
            `${language} worker origin ${JSON.stringify(workerUrl.origin)} must match executionHost origin ${JSON.stringify(this.executionHost.origin)}.`
          );
        }
      }
    }
    try {
      this.pythonWorkerClient = new PythonWorkerClient({
      workerUrl: this.assets.pythonWorker,
      ...(workerFactory ? { workerFactory } : {}),
      ...(this.assets.runtimeManifests?.python?.workerFormat
        ? { workerFormat: this.assets.runtimeManifests.python.workerFormat }
        : {}),
      debug: options.debug,
      assetPreflight: preflight('python', ['worker', 'snippets']),
      runtimeAssetPreflight: preflight('python', [
        'runtimeCore',
        'runtimeLoader',
        'runtimeIndex',
        'distribution',
        'packages',
      ]),
      runtimeAssets: {
        runtimeCoreUrl: this.assets.pythonRuntimeCore,
        snippetsUrl: this.assets.pythonSnippets,
        ...(manifestAsset('python', 'runtimeLoader')?.url
          ? { loaderUrl: manifestAsset('python', 'runtimeLoader')?.url }
          : {}),
        ...(manifestAsset('python', 'runtimeIndex')?.url
          ? { indexUrl: manifestAsset('python', 'runtimeIndex')?.url }
          : {}),
        ...(this.assets.runtimeManifests?.python?.loaderFormat
          ? { loaderFormat: this.assets.runtimeManifests.python.loaderFormat }
          : {}),
        ...(pythonPackageDescriptors
          ? {
              packageUrls: Object.fromEntries(
                Object.entries(pythonPackageDescriptors).map(([name, descriptor]) => [name, descriptor.url])
              ),
            }
          : {}),
      },
    });
    this.javaScriptWorkerClient = new JavaScriptWorkerClient({
      workerUrl: this.assets.javascriptWorker,
      ...(workerFactory ? { workerFactory } : {}),
      debug: options.debug,
      assetPreflight: preflight('javascript', ['worker']),
      runtimeAssetPreflight: preflight('javascript', ['libraries']),
      ...(manifestAsset('javascript', 'libraries')?.url
        ? { javascriptLibrariesUrl: manifestAsset('javascript', 'libraries')?.url }
        : {}),
      typescriptCompilerUrl: this.assets.typescriptCompiler,
      typescriptCompilerPreflight: preflight('typescript', ['compiler']),
    });
    this.javaWorkerClient = new JavaWorkerClient({
      workerUrl: this.assets.javaWorker,
      ...(workerFactory ? { workerFactory, isolatedRuntimeStorage: true } : {}),
      debug: options.debug,
      workerIdleTimeoutMs: options.java?.workerIdleTimeoutMs,
      compileCacheLimit: options.java?.compileCacheLimit,
      externalCompilerUrl: options.java?.externalCompilerUrl,
      cheerpjLoaderUrl: options.java?.cheerpjLoaderUrl,
      assetPreflight: preflight('java', ['worker']),
      runtimeAssetPreflight: preflight('java', [
        'loader',
        'helperJar',
        'compilerJar',
        'rewriterJar',
        'parserJar',
      ]),
      ...(javaManifest
        ? {
            runtimeAssets: {
              ...(manifestAsset('java', 'loader')?.url
                ? { loaderUrl: manifestAsset('java', 'loader')?.url }
                : {}),
              ...(manifestAsset('java', 'helperJar')?.url
                ? { helperJarUrl: manifestAsset('java', 'helperJar')?.runtimePath ?? manifestAsset('java', 'helperJar')?.url }
                : {}),
              ...(manifestAsset('java', 'compilerJar')?.url
                ? { compilerJarUrl: manifestAsset('java', 'compilerJar')?.runtimePath ?? manifestAsset('java', 'compilerJar')?.url }
                : {}),
              ...(manifestAsset('java', 'rewriterJar')?.url
                ? { rewriterJarUrl: manifestAsset('java', 'rewriterJar')?.runtimePath ?? manifestAsset('java', 'rewriterJar')?.url }
                : {}),
              ...(manifestAsset('java', 'parserJar')?.url
                ? { parserJarUrl: manifestAsset('java', 'parserJar')?.runtimePath ?? manifestAsset('java', 'parserJar')?.url }
                : {}),
            },
          }
        : {}),
    });
    this.csharpWorkerClient = new CSharpWorkerClient({
      workerUrl: this.assets.csharpWorker,
      ...(workerFactory ? { workerFactory } : {}),
      assetBaseUrl: this.assets.csharpAssetBaseUrl,
      debug: options.debug,
      workerIdleTimeoutMs: options.csharp?.workerIdleTimeoutMs,
      assetPreflight: preflight('csharp', ['worker']),
      runtimeAssetPreflight: preflight('csharp', ['assetBaseUrl', 'dependencies']),
      ...(csharpDependencyDescriptors
        ? {
            runtimeDependencies: Object.fromEntries(
              Object.entries(csharpDependencyDescriptors).map(([name, descriptor]) => [name, descriptor.url])
            ),
          }
        : {}),
    });
    this.cppWorkerClient = new CppWorkerClient({
      workerUrl: this.assets.cppWorker,
      ...(workerFactory ? { workerFactory } : {}),
      assetPreflight: preflight('cpp', ['worker']),
      runtimeAssetPreflight: preflight('cpp', [
        'compilerFrame',
        'compilerWorker',
        'runtimeHeader',
        'compilerBundle',
        'clangWasm',
        'lldWasm',
        'sysroot',
        'toolchain',
      ]),
      compilerFrameUrl: this.assets.cppCompilerFrame,
      compilerWorkerUrl: this.assets.cppCompilerWorker,
      clangWasmUrl: this.assets.cppClangWasm,
      lldWasmUrl: this.assets.cppLldWasm,
      sysrootUrl: this.assets.cppSysroot,
      runtimeHeaderUrl: this.assets.cppRuntimeHeader,
      compilerBundleUrl: this.assets.cppCompilerBundle,
      toolchainIntegrity: this.assets.cppToolchainIntegrity,
      debug: options.debug,
      initTimeoutMs: options.cpp?.initTimeoutMs,
      executionTimeoutMs: options.cpp?.executionTimeoutMs,
      tracingTimeoutMs: options.cpp?.tracingTimeoutMs,
      interviewTimeoutMs: options.cpp?.interviewTimeoutMs,
      workerIdleTimeoutMs: options.cpp?.workerIdleTimeoutMs,
      programCacheLimit: options.cpp?.programCacheLimit,
      usePrecompiledHeader: options.cpp?.usePrecompiledHeader,
      externalCompilerUrl: options.cpp?.externalCompilerUrl,
    });
      this.clients = {
        python: createPythonRuntimeClient(this.pythonWorkerClient),
        javascript: createJavaScriptRuntimeClient('javascript', this.javaScriptWorkerClient),
        typescript: createJavaScriptRuntimeClient('typescript', this.javaScriptWorkerClient),
        java: createJavaRuntimeClient(this.javaWorkerClient),
        csharp: createCSharpRuntimeClient(this.csharpWorkerClient),
        cpp: createCppRuntimeClient(this.cppWorkerClient),
      };
    } catch (error) {
      this.executionHost?.dispose();
      throw error;
    }
  }

  getClient(language: Language): RuntimeClient {
    if (!this.supportedLanguages.includes(language)) {
      throw new Error(`Runtime for language "${language}" is not selected in this browser environment.`);
    }
    const client = this.clients[language];
    if (!client) {
      throw new Error(`Runtime for language "${language}" is not implemented yet.`);
    }
    return client;
  }

  getProfile(language: Language): LanguageRuntimeProfile {
    return getLanguageRuntimeProfile(language);
  }

  getSupportedLanguageProfiles(): readonly LanguageRuntimeProfile[] {
    return this.supportedLanguages.map((language) => getLanguageRuntimeProfile(language));
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
      this.executionHost?.ready() ?? Promise.resolve(),
    ]).then(([readiness]) => readiness);
  }

  preflight(): Promise<BrowserRuntimeEnvironmentReport> {
    return Promise.all([
      this.environment.preflightAll(),
      this.executionHost?.ready() ?? Promise.resolve(),
    ]).then(([report]) => report);
  }

  warmLanguage(language: Language): Promise<{ success: boolean; loadTimeMs: number }> {
    if (!this.supportedLanguages.includes(language)) {
      return Promise.reject(new Error(`Runtime for language "${language}" is not selected in this browser environment.`));
    }
    if (language === 'python') {
      return this.pythonWorkerClient.warmup();
    }
    if (language === 'java') {
      return this.javaWorkerClient.warmup();
    }
    if (language === 'cpp') {
      return this.cppWorkerClient.warmup();
    }
    if (language === 'csharp') {
      return this.csharpWorkerClient.warmup();
    }
    if (language === 'typescript') {
      return this.javaScriptWorkerClient.warmup('typescript');
    }
    return this.getClient(language).init();
  }

  disposeLanguage(language: Language): void {
    if (!this.supportedLanguages.includes(language)) return;
    if (language === 'python') {
      this.pythonWorkerClient.terminate();
      return;
    }
    if (language === 'java') {
      this.javaWorkerClient.terminate();
      return;
    }
    if (language === 'csharp') {
      this.csharpWorkerClient.terminate();
      return;
    }
    if (language === 'cpp') {
      this.cppWorkerClient.terminate();
      return;
    }
    this.javaScriptWorkerClient.terminate();
  }

  dispose(): void {
    this.pythonWorkerClient.terminate();
    this.javaScriptWorkerClient.terminate();
    this.javaWorkerClient.terminate();
    this.csharpWorkerClient.terminate();
    this.cppWorkerClient.terminate();
    this.executionHost?.dispose();
  }
}

export function createBrowserHarness(options: CreateBrowserHarnessOptions = {}): BrowserHarness {
  return new BrowserHarnessRuntime(options);
}

export {
  DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS,
  resolveBrowserHarnessAssets,
  type BrowserHarnessAssets,
  type BrowserHarnessAssetOverrides,
};
export type {
  CppToolchainIntegrityEntry,
  CppToolchainIntegrityManifest,
} from './cpp-worker-client';
