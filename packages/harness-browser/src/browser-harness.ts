import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import type {
  Language,
  LanguageRuntimeProfile,
  RuntimeClient,
  RuntimeExecutionIsolationPolicy,
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
} from './runtime-profiles';
import { FreshWorkerRuntimeClient } from './runtime-client-isolation';
import { runJavaSafeStorageExclusive } from './java-storage-isolation';

export interface CreateBrowserHarnessOptions {
  assetBaseUrl?: string;
  assets?: BrowserHarnessAssetOverrides;
  /** Optional shared V2 deployment/readiness environment. */
  environment?: BrowserRuntimeEnvironment;
  /** Providers exposed by this harness. Defaults to every built-in language. */
  providers?: readonly Language[];
  engine?: BrowserRuntimeEngine;
  featureOverrides?: Partial<BrowserRuntimeFeatureSupport>;
  /** Runs selected provider workers on a dedicated, credential-free origin. */
  executionHost?: BrowserHarnessExecutionHostOptions;
  debug?: boolean;
  /**
   * Safe by default. `unsafe-reuse` keeps mutable Python, Java, and C# runtime
   * workers alive across executions and must only be used for trusted code.
   */
  executionIsolation?: RuntimeExecutionIsolationPolicy;
  /** Safe-mode latency/memory policy. A clean standby is replenished after use by default. */
  safeExecution?: {
    prewarmAfterUse?: boolean;
  };
  python?: {
    compileCacheLimit?: number;
  };
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
    workerIdleTimeoutMs?: number;
    programCacheLimit?: number;
    usePrecompiledHeader?: boolean;
    externalCompilerUrl?: string;
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

/**
 * The validated, immutable inputs every layer in the harness graph reads from.
 * Produced eagerly (and purely — no resources) so option validation still
 * throws synchronously from `createBrowserHarness`.
 */
interface ResolvedHarnessContext {
  readonly options: CreateBrowserHarnessOptions;
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

function resolveHarnessContext(options: CreateBrowserHarnessOptions): ResolvedHarnessContext {
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
    (options.assetBaseUrl !== undefined || options.assets !== undefined || options.providers !== undefined ||
      options.engine !== undefined || options.featureOverrides !== undefined)
  ) {
    throw new TypeError(
      'CreateBrowserHarnessOptions.environment cannot be combined with asset, provider, engine, or feature overrides.'
    );
  }
  const environment = options.environment ?? createBrowserRuntimeEnvironment({
    assetBaseUrl: options.assetBaseUrl,
    assets: options.assets,
    providers: options.providers,
    surface: 'classic',
    engine: options.engine,
    featureOverrides: options.featureOverrides,
  });
  const assets = environment.assets;
  const supportedLanguages = environment.providers;
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

  if (assets.runtimeManifests?.java?.assets.loader && options.java?.cheerpjLoaderUrl) {
    throw new TypeError(
      'Java runtime assets cannot combine manifest.assets.loader with java.cheerpjLoaderUrl.'
    );
  }

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
    environment,
    assets,
    supportedLanguages,
    executionHostProviders,
    preflight,
    manifestAsset,
    manifestAssetCollection,
  };
}

class HarnessContext extends Context.Tag('BrowserHarness/Context')<
  HarnessContext,
  ResolvedHarnessContext
>() {}

interface ExecutionHostSlot {
  readonly host: BrowserExecutionWorkerHost | undefined;
  readonly workerFactoryFor: (language: Language) => BrowserWorkerFactory | undefined;
}

class ExecutionHostService extends Context.Tag('BrowserHarness/ExecutionHost')<
  ExecutionHostService,
  ExecutionHostSlot
>() {}

/**
 * The execution host as a scoped resource. If anything after acquisition
 * fails (e.g. the worker-origin validation below, or any downstream client
 * layer), the layer build unwinds and the host finalizer disposes the iframe
 * and MessageChannel — the old constructor's manual try/catch, structurally.
 */
const executionHostLayer = Layer.scoped(
  ExecutionHostService,
  Effect.gen(function* () {
    const ctx = yield* HarnessContext;
    if (!ctx.options.executionHost || ctx.executionHostProviders.size === 0) {
      return { host: undefined, workerFactoryFor: () => undefined };
    }

    const host = yield* Effect.acquireRelease(
      Effect.sync(() => createBrowserExecutionWorkerHost(ctx.options.executionHost!)),
      (acquired) => Effect.sync(() => acquired.dispose())
    );

    const workerUrls = new Map<Language, string>([
      ['python', ctx.assets.pythonWorker],
      ['javascript', ctx.assets.javascriptWorker],
      ['typescript', ctx.assets.javascriptWorker],
      ['java', ctx.assets.javaWorker],
      ['csharp', ctx.assets.csharpWorker],
      ['cpp', ctx.assets.cppWorker],
    ]);
    for (const language of ctx.executionHostProviders) {
      const workerUrl = new URL(workerUrls.get(language)!, `${host.origin}/`);
      if (workerUrl.origin !== host.origin) {
        return yield* Effect.fail(
          new Error(
            `${language} worker origin ${JSON.stringify(workerUrl.origin)} must match executionHost origin ${JSON.stringify(host.origin)}.`
          )
        );
      }
    }

    return {
      host,
      workerFactoryFor: (language: Language) =>
        ctx.executionHostProviders.has(language) ? host.workerFactory : undefined,
    };
  })
);

class PythonWorkerClientService extends Context.Tag('BrowserHarness/PythonWorkerClient')<
  PythonWorkerClientService,
  PythonWorkerClient
>() {}

class JavaScriptWorkerClientService extends Context.Tag('BrowserHarness/JavaScriptWorkerClient')<
  JavaScriptWorkerClientService,
  JavaScriptWorkerClient
>() {}

class JavaWorkerClientService extends Context.Tag('BrowserHarness/JavaWorkerClient')<
  JavaWorkerClientService,
  JavaWorkerClient
>() {}

class CSharpWorkerClientService extends Context.Tag('BrowserHarness/CSharpWorkerClient')<
  CSharpWorkerClientService,
  CSharpWorkerClient
>() {}

class CppWorkerClientService extends Context.Tag('BrowserHarness/CppWorkerClient')<
  CppWorkerClientService,
  CppWorkerClient
>() {}

/** Construct a worker client as a scoped resource whose finalizer terminates it. */
const scopedWorkerClient = <Client extends { terminate(): void }>(
  construct: (ctx: ResolvedHarnessContext, hostSlot: ExecutionHostSlot) => Client
) =>
  Effect.gen(function* () {
    const ctx = yield* HarnessContext;
    const hostSlot = yield* ExecutionHostService;
    return yield* Effect.acquireRelease(
      Effect.sync(() => construct(ctx, hostSlot)),
      (client) => Effect.sync(() => client.terminate())
    );
  });

const pythonWorkerClientLayer = Layer.scoped(
  PythonWorkerClientService,
  scopedWorkerClient((ctx, hostSlot) => {
    const workerFactory = hostSlot.workerFactoryFor('python');
    const pythonPackageDescriptors = ctx.manifestAssetCollection('python', 'packages');
    return new PythonWorkerClient({
      workerUrl: ctx.assets.pythonWorker,
      ...(workerFactory ? { workerFactory } : {}),
      compileCacheLimit: ctx.options.python?.compileCacheLimit,
      ...(ctx.assets.runtimeManifests?.python?.workerFormat
        ? { workerFormat: ctx.assets.runtimeManifests.python.workerFormat }
        : {}),
      debug: ctx.options.debug,
      assetPreflight: ctx.preflight('python', ['worker', 'snippets']),
      runtimeAssetPreflight: ctx.preflight('python', [
        'runtimeCore',
        'runtimeLoader',
        'runtimeIndex',
        'distribution',
        'packages',
      ]),
      runtimeAssets: {
        runtimeCoreUrl: ctx.assets.pythonRuntimeCore,
        snippetsUrl: ctx.assets.pythonSnippets,
        ...(ctx.manifestAsset('python', 'runtimeLoader')?.url
          ? { loaderUrl: ctx.manifestAsset('python', 'runtimeLoader')?.url }
          : {}),
        ...(ctx.manifestAsset('python', 'runtimeIndex')?.url
          ? { indexUrl: ctx.manifestAsset('python', 'runtimeIndex')?.url }
          : {}),
        ...(ctx.assets.runtimeManifests?.python?.loaderFormat
          ? { loaderFormat: ctx.assets.runtimeManifests.python.loaderFormat }
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
  })
);

const javaScriptWorkerClientLayer = Layer.scoped(
  JavaScriptWorkerClientService,
  scopedWorkerClient((ctx, hostSlot) => {
    const workerFactory = hostSlot.workerFactoryFor('javascript') ?? hostSlot.workerFactoryFor('typescript');
    return new JavaScriptWorkerClient({
      workerUrl: ctx.assets.javascriptWorker,
      ...(workerFactory ? { workerFactory } : {}),
      debug: ctx.options.debug,
      assetPreflight: ctx.preflight('javascript', ['worker']),
      runtimeAssetPreflight: ctx.preflight('javascript', ['libraries']),
      ...(ctx.manifestAsset('javascript', 'libraries')?.url
        ? { javascriptLibrariesUrl: ctx.manifestAsset('javascript', 'libraries')?.url }
        : {}),
      typescriptCompilerUrl: ctx.assets.typescriptCompiler,
      typescriptCompilerPreflight: ctx.preflight('typescript', ['compiler']),
    });
  })
);

const javaWorkerClientLayer = Layer.scoped(
  JavaWorkerClientService,
  scopedWorkerClient((ctx, hostSlot) => {
    const workerFactory = hostSlot.workerFactoryFor('java');
    const javaManifest = ctx.assets.runtimeManifests?.java;
    return new JavaWorkerClient({
      workerUrl: ctx.assets.javaWorker,
      ...(workerFactory ? { workerFactory, isolatedRuntimeStorage: true } : {}),
      debug: ctx.options.debug,
      workerIdleTimeoutMs: ctx.options.java?.workerIdleTimeoutMs,
      compileCacheLimit: ctx.options.java?.compileCacheLimit,
      externalCompilerUrl: ctx.options.java?.externalCompilerUrl,
      cheerpjLoaderUrl: ctx.options.java?.cheerpjLoaderUrl,
      assetPreflight: ctx.preflight('java', ['worker']),
      runtimeAssetPreflight: ctx.preflight('java', [
        'loader',
        'helperJar',
        'compilerJar',
        'rewriterJar',
        'parserJar',
      ]),
      ...(javaManifest
        ? {
            runtimeAssets: {
              ...(ctx.manifestAsset('java', 'loader')?.url
                ? { loaderUrl: ctx.manifestAsset('java', 'loader')?.url }
                : {}),
              ...(ctx.manifestAsset('java', 'helperJar')?.url
                ? { helperJarUrl: ctx.manifestAsset('java', 'helperJar')?.runtimePath ?? ctx.manifestAsset('java', 'helperJar')?.url }
                : {}),
              ...(ctx.manifestAsset('java', 'compilerJar')?.url
                ? { compilerJarUrl: ctx.manifestAsset('java', 'compilerJar')?.runtimePath ?? ctx.manifestAsset('java', 'compilerJar')?.url }
                : {}),
              ...(ctx.manifestAsset('java', 'rewriterJar')?.url
                ? { rewriterJarUrl: ctx.manifestAsset('java', 'rewriterJar')?.runtimePath ?? ctx.manifestAsset('java', 'rewriterJar')?.url }
                : {}),
              ...(ctx.manifestAsset('java', 'parserJar')?.url
                ? { parserJarUrl: ctx.manifestAsset('java', 'parserJar')?.runtimePath ?? ctx.manifestAsset('java', 'parserJar')?.url }
                : {}),
            },
          }
        : {}),
    });
  })
);

const csharpWorkerClientLayer = Layer.scoped(
  CSharpWorkerClientService,
  scopedWorkerClient((ctx, hostSlot) => {
    const workerFactory = hostSlot.workerFactoryFor('csharp');
    const csharpDependencyDescriptors = ctx.manifestAssetCollection('csharp', 'dependencies');
    return new CSharpWorkerClient({
      workerUrl: ctx.assets.csharpWorker,
      ...(workerFactory ? { workerFactory } : {}),
      assetBaseUrl: ctx.assets.csharpAssetBaseUrl,
      debug: ctx.options.debug,
      workerIdleTimeoutMs: ctx.options.csharp?.workerIdleTimeoutMs,
      assetPreflight: ctx.preflight('csharp', ['worker']),
      runtimeAssetPreflight: ctx.preflight('csharp', ['assetBaseUrl', 'dependencies']),
      ...(csharpDependencyDescriptors
        ? {
            runtimeDependencies: Object.fromEntries(
              Object.entries(csharpDependencyDescriptors).map(([name, descriptor]) => [name, descriptor.url])
            ),
          }
        : {}),
    });
  })
);

const cppWorkerClientLayer = Layer.scoped(
  CppWorkerClientService,
  scopedWorkerClient((ctx, hostSlot) => {
    const workerFactory = hostSlot.workerFactoryFor('cpp');
    return new CppWorkerClient({
      workerUrl: ctx.assets.cppWorker,
      ...(workerFactory ? { workerFactory } : {}),
      assetPreflight: ctx.preflight('cpp', ['worker']),
      runtimeAssetPreflight: ctx.preflight('cpp', [
        'compilerFrame',
        'compilerWorker',
        'runtimeHeader',
        'compilerBundle',
        'clangWasm',
        'lldWasm',
        'sysroot',
        'toolchain',
      ]),
      compilerFrameUrl: ctx.assets.cppCompilerFrame,
      compilerWorkerUrl: ctx.assets.cppCompilerWorker,
      clangWasmUrl: ctx.assets.cppClangWasm,
      lldWasmUrl: ctx.assets.cppLldWasm,
      sysrootUrl: ctx.assets.cppSysroot,
      runtimeHeaderUrl: ctx.assets.cppRuntimeHeader,
      compilerBundleUrl: ctx.assets.cppCompilerBundle,
      toolchainIntegrity: ctx.assets.cppToolchainIntegrity,
      debug: ctx.options.debug,
      initTimeoutMs: ctx.options.cpp?.initTimeoutMs,
      executionTimeoutMs: ctx.options.cpp?.executionTimeoutMs,
      tracingTimeoutMs: ctx.options.cpp?.tracingTimeoutMs,
      workerIdleTimeoutMs: ctx.options.cpp?.workerIdleTimeoutMs,
      programCacheLimit: ctx.options.cpp?.programCacheLimit,
      usePrecompiledHeader: ctx.options.cpp?.usePrecompiledHeader,
      externalCompilerUrl: ctx.options.cpp?.externalCompilerUrl,
    });
  })
);

class RuntimeClientsService extends Context.Tag('BrowserHarness/RuntimeClients')<
  RuntimeClientsService,
  Readonly<Record<Language, RuntimeClient>>
>() {}

const runtimeClientsLayer = Layer.effect(
  RuntimeClientsService,
  Effect.gen(function* () {
    const ctx = yield* HarnessContext;
    const python = yield* PythonWorkerClientService;
    const javascript = yield* JavaScriptWorkerClientService;
    const java = yield* JavaWorkerClientService;
    const csharp = yield* CSharpWorkerClientService;
    const cpp = yield* CppWorkerClientService;
    const clients: Record<Language, RuntimeClient> = {
      python: createPythonRuntimeClient(python),
      javascript: createJavaScriptRuntimeClient('javascript', javascript),
      typescript: createJavaScriptRuntimeClient('typescript', javascript),
      java: createJavaRuntimeClient(java),
      csharp: createCSharpRuntimeClient(csharp),
      cpp: createCppRuntimeClient(cpp),
    };
    if ((ctx.options.executionIsolation ?? 'safe') === 'unsafe-reuse') return clients;
    return {
      ...clients,
      python: new FreshWorkerRuntimeClient(
        clients.python,
        {
          retireWorker: () => python.terminate(),
          prepareWorker: () => python.warmup(),
          prewarmAfterUse: ctx.options.safeExecution?.prewarmAfterUse ?? true,
        }
      ),
      java: new FreshWorkerRuntimeClient(
        clients.java,
        {
          retireWorker: () => java.terminate(),
          prepareWorker: () => java.warmup(),
          prewarmAfterUse: ctx.options.safeExecution?.prewarmAfterUse ?? true,
          beforeExecution: () => java.resetPersistentStorage(),
          runExclusive: runJavaSafeStorageExclusive,
        }
      ),
      csharp: new FreshWorkerRuntimeClient(
        clients.csharp,
        {
          retireWorker: () => csharp.terminate(),
          prepareWorker: () => csharp.warmup(),
          prewarmAfterUse: ctx.options.safeExecution?.prewarmAfterUse ?? true,
        }
      ),
    };
  })
);

interface HarnessWorkerClients {
  readonly python: PythonWorkerClient;
  readonly javascript: JavaScriptWorkerClient;
  readonly java: JavaWorkerClient;
  readonly csharp: CSharpWorkerClient;
  readonly cpp: CppWorkerClient;
}

type HarnessServices =
  | HarnessContext
  | ExecutionHostService
  | PythonWorkerClientService
  | JavaScriptWorkerClientService
  | JavaWorkerClientService
  | CSharpWorkerClientService
  | CppWorkerClientService
  | RuntimeClientsService;

class BrowserHarnessRuntime implements BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly environment: BrowserRuntimeEnvironment;
  readonly supportedLanguages: readonly Language[];
  readonly executionIsolation: RuntimeExecutionIsolationPolicy;

  private readonly managed: ManagedRuntime.ManagedRuntime<HarnessServices, Error>;
  private readonly clients: Readonly<Record<Language, RuntimeClient>>;
  private readonly workerClients: HarnessWorkerClients;
  private readonly executionHostSlot: ExecutionHostSlot;
  private readonly executionHostProviders: ReadonlySet<Language>;

  constructor(options: CreateBrowserHarnessOptions = {}) {
    // Pure option validation runs before any layer exists, keeping
    // construction-time TypeErrors synchronous and resource-free.
    const context = resolveHarnessContext(options);
    this.environment = context.environment;
    this.assets = context.assets;
    this.supportedLanguages = context.supportedLanguages;
    this.executionIsolation = options.executionIsolation ?? 'safe';
    this.executionHostProviders = context.executionHostProviders;

    const workerClientLayers = Layer.mergeAll(
      pythonWorkerClientLayer,
      javaScriptWorkerClientLayer,
      javaWorkerClientLayer,
      csharpWorkerClientLayer,
      cppWorkerClientLayer
    );
    const harnessLayer = runtimeClientsLayer.pipe(
      Layer.provideMerge(workerClientLayers),
      Layer.provideMerge(executionHostLayer),
      Layer.provideMerge(Layer.succeed(HarnessContext, context))
    );
    this.managed = ManagedRuntime.make(harnessLayer);

    // Force the graph eagerly: the previous constructor built everything
    // up front, and construction failures must keep surfacing here. A build
    // failure unwinds already-acquired finalizers (host disposal) on its own.
    this.clients = this.runHarnessSync(RuntimeClientsService);
    this.workerClients = this.runHarnessSync(
      Effect.all({
        python: PythonWorkerClientService,
        javascript: JavaScriptWorkerClientService,
        java: JavaWorkerClientService,
        csharp: CSharpWorkerClientService,
        cpp: CppWorkerClientService,
      })
    );
    this.executionHostSlot = this.runHarnessSync(ExecutionHostService);
  }

  /** Run against the harness runtime, rethrowing failures/defects unwrapped. */
  private runHarnessSync<A>(effect: Effect.Effect<A, Error, HarnessServices>): A {
    const exit = this.managed.runSyncExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
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
      return Promise.reject(new Error(`Runtime for language "${language}" is not selected in this browser environment.`));
    }
    if (language === 'python') {
      return this.executionIsolation === 'safe'
        ? (this.getClient(language) as FreshWorkerRuntimeClient).prepare()
        : this.workerClients.python.warmup();
    }
    if (language === 'java') {
      return this.executionIsolation === 'safe'
        ? (this.getClient(language) as FreshWorkerRuntimeClient).prepare()
        : this.workerClients.java.warmup();
    }
    if (language === 'cpp') {
      return this.workerClients.cpp.warmup();
    }
    if (language === 'csharp') {
      return this.executionIsolation === 'safe'
        ? (this.getClient(language) as FreshWorkerRuntimeClient).prepare()
        : this.workerClients.csharp.warmup();
    }
    if (language === 'typescript') {
      return this.workerClients.javascript.warmup('typescript');
    }
    return this.getClient(language).init();
  }

  disposeLanguage(language: Language): void {
    if (!this.supportedLanguages.includes(language)) return;
    const client = this.clients[language];
    if (client instanceof FreshWorkerRuntimeClient) {
      client.reset();
      return;
    }
    if (language === 'python') {
      this.workerClients.python.terminate();
      return;
    }
    if (language === 'java') {
      this.workerClients.java.terminate();
      return;
    }
    if (language === 'csharp') {
      this.workerClients.csharp.terminate();
      return;
    }
    if (language === 'cpp') {
      this.workerClients.cpp.terminate();
      return;
    }
    this.workerClients.javascript.terminate();
  }

  dispose(): void {
    for (const client of Object.values(this.clients)) {
      if (client instanceof FreshWorkerRuntimeClient) client.reset();
    }
    // Close the runtime's scope: every worker client finalizer runs first,
    // then the execution host's — reverse acquisition order, by construction.
    const exit = Effect.runSyncExit(this.managed.disposeEffect);
    if (Exit.isFailure(exit)) {
      throw Cause.squash(exit.cause);
    }
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
