import type {
  Language,
  RuntimePreparedExecutionProvider,
} from '@tracecode/runtime-contracts';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '../../runtime-browser/src/runtime-provider-registry';
import {
  createPromotableBrowserBackgroundTask,
} from '@tracecode/runtime-browser/internal';
import { createCppPreparedExecutionProvider } from './cpp-prepared-provider';
import { CppWorkerClient } from './cpp-worker-client';
import {
  TraceCCCompilerService,
  type TraceCCCompilerShardAssets,
} from './tracecc-compiler-service';
import type { BrowserWorkerFactory } from '../../runtime-browser/src/execution-host';
import type {
  BrowserRuntimeAssets,
} from '../../runtime-browser/src/runtime-assets';

export interface TraceCCCompilerOptions {
  /** Independently bounds the trusted compiler Worker lifetime. */
  maxCompilesPerWorker?: number;
  /** Stable keys in the C++ manifest's compilerResources collection. */
  resourceNames?: Readonly<Record<
    'narrowPch' | 'narrowPchSource' | 'narrowRuntimeObject' |
    'broadPch' | 'broadPchSource' | 'broadRuntimeObject' |
    'mapPch' | 'mapPchSource' | 'mapRuntimeObject',
    string
  >>;
}

export interface CppBrowserRuntimeProviderOptions {
  initTimeoutMs?: number;
  executionTimeoutMs?: number;
  tracingTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  programCacheLimit?: number;
  usePrecompiledHeader?: boolean;
  /** Same-origin trusted C++ compiler endpoint. */
  externalCompilerUrl?: string;
  compiler?: TraceCCCompilerOptions;
}

const DEFAULT_TRACECC_RESOURCE_NAMES = Object.freeze({
  narrowPch: 'tracecc-narrow-pch',
  narrowPchSource: 'tracecc-narrow-pch-source',
  narrowRuntimeObject: 'tracecc-narrow-runtime-object',
  broadPch: 'tracecc-broad-pch',
  broadPchSource: 'tracecc-broad-pch-source',
  broadRuntimeObject: 'tracecc-broad-runtime-object',
  mapPch: 'tracecc-map-pch',
  mapPchSource: 'tracecc-map-pch-source',
  mapRuntimeObject: 'tracecc-map-runtime-object',
});

export interface TraceCCBrowserCompilerContext {
  readonly assets: Pick<
    BrowserRuntimeAssets,
    | 'cppWorker'
    | 'cppCompilerWasm'
    | 'cppSysroot'
    | 'cppRuntimeHeader'
    | 'cppCompilerIntegrity'
    | 'runtimeManifests'
  >;
  readonly workerFactory?: BrowserWorkerFactory;
}

function traceccShardAssets(
  resources: Readonly<Record<string, { url: string }>> | undefined,
  names: typeof DEFAULT_TRACECC_RESOURCE_NAMES,
  shard: 'narrow' | 'broad' | 'map'
): TraceCCCompilerShardAssets {
  const prefix = shard === 'map' ? 'map' : shard;
  const pch = resources?.[names[`${prefix}Pch`]];
  const pchSource = resources?.[names[`${prefix}PchSource`]];
  const runtimeObject = resources?.[names[`${prefix}RuntimeObject`]];
  if (!pch || !pchSource || !runtimeObject) {
    throw new Error(
      `TraceCC ${shard} compiler resources are missing from the C++ runtime manifest.`
    );
  }
  return {
    pchUrl: pch.url,
    pchSourceUrl: pchSource.url,
    runtimeObjectUrl: runtimeObject.url,
  };
}

export function createTraceCCBrowserCompilerService(
  compiler: TraceCCCompilerOptions,
  context: TraceCCBrowserCompilerContext
): TraceCCCompilerService {
  const traceccResources =
    context.assets.runtimeManifests?.cpp?.assets.compilerResources;
  const resourceNames = {
    ...DEFAULT_TRACECC_RESOURCE_NAMES,
    ...(compiler.resourceNames ?? {}),
  } as typeof DEFAULT_TRACECC_RESOURCE_NAMES;
  const compilerIntegrity = context.assets.cppCompilerIntegrity;
  if (!compilerIntegrity) {
    throw new Error(
      'TraceCC requires exact compiler integrity entries from a C++ runtime manifest.'
    );
  }
  return new TraceCCCompilerService({
    workerUrl: context.assets.cppWorker,
    compilerUrl: context.assets.cppCompilerWasm,
    resourcesUrl: context.assets.cppSysroot,
    runtimeHeaderUrl: context.assets.cppRuntimeHeader,
    compilerIntegrity,
    shards: {
      narrow: traceccShardAssets(
        traceccResources,
        resourceNames,
        'narrow'
      ),
      broad: traceccShardAssets(
        traceccResources,
        resourceNames,
        'broad'
      ),
      map: traceccShardAssets(
        traceccResources,
        resourceNames,
        'map'
      ),
    },
    ...(context.workerFactory
      ? { workerFactory: context.workerFactory }
      : {}),
    maxCompilesPerWorker: compiler.maxCompilesPerWorker ?? 64,
  });
}

export function createCppBrowserRuntimeProvider(
  options: CppBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-cpp',
    languages: ['cpp'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      const workerFactory = context.workerFactoryFor('cpp');
      const compiler = options.compiler ?? {};
      const workerOptions = {
        workerUrl: context.assets.cppWorker,
        ...(workerFactory ? { workerFactory } : {}),
        compilerWasmUrl: context.assets.cppCompilerWasm,
        linkerWasmUrl: context.assets.cppLinkerWasm,
        sysrootUrl: context.assets.cppSysroot,
        runtimeHeaderUrl: context.assets.cppRuntimeHeader,
        compilerIntegrity: context.assets.cppCompilerIntegrity,
        debug: context.debug,
        initTimeoutMs: options.initTimeoutMs,
        executionTimeoutMs: options.executionTimeoutMs,
        tracingTimeoutMs: options.tracingTimeoutMs,
        workerIdleTimeoutMs: options.workerIdleTimeoutMs,
        programCacheLimit: options.programCacheLimit,
        usePrecompiledHeader: options.usePrecompiledHeader,
        externalCompilerUrl: options.externalCompilerUrl,
      };
      const compilerService = options.externalCompilerUrl
        ? undefined
        : createTraceCCBrowserCompilerService(compiler, {
            assets: context.assets,
            ...(workerFactory ? { workerFactory } : {}),
          });
      const createWorkerClient = () => new CppWorkerClient({
        ...workerOptions,
        ...(compilerService ? { trustedCompilerService: compilerService } : {}),
      });
      const preparedProvider = createCppPreparedExecutionProvider({
        createWorkerClient,
        warmCompilerOnInit: false,
        prewarmCompiler: () => compilerService?.prewarmAssets() ?? Promise.resolve(),
        scheduleCompilerPrewarm: createPromotableBrowserBackgroundTask,
      });
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([['cpp', preparedProvider]]);
      const terminateCompiler = () => {
        compilerService?.terminate();
      };
      return {
        preparedProviders,
        disposeLanguage: () => {
          preparedProvider.reset();
          terminateCompiler();
        },
        dispose: () => {
          preparedProvider.terminate();
          terminateCompiler();
        },
      };
    },
  };
}
