import type { Language, RuntimeClient } from '@tracecode/runtime-core';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/runtime-browser';
import { createCppPreparedExecutionProvider } from './cpp-prepared-provider';
import { createCppRuntimeClient } from './cpp-runtime-client';
import { CppWorkerClient } from './cpp-worker-client';

export interface CppBrowserRuntimeProviderOptions {
  initTimeoutMs?: number;
  executionTimeoutMs?: number;
  tracingTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  programCacheLimit?: number;
  usePrecompiledHeader?: boolean;
  externalCompilerUrl?: string;
}

export function createCppBrowserRuntimeProvider(
  options: CppBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-cpp',
    languages: ['cpp'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      const workerFactory = context.workerFactoryFor('cpp');
      const workerOptions = {
        workerUrl: context.assets.cppWorker,
        ...(workerFactory ? { workerFactory } : {}),
        assetPreflight: context.preflight('cpp', ['worker']),
        runtimeAssetPreflight: context.preflight('cpp', [
          'compilerFrame',
          'compilerWorker',
          'runtimeHeader',
          'compilerBundle',
          'compilerWasm',
          'linkerWasm',
          'sysroot',
          'compilerResources',
        ]),
        compilerFrameUrl: context.assets.cppCompilerFrame,
        compilerWorkerUrl: context.assets.cppCompilerWorker,
        compilerWasmUrl: context.assets.cppCompilerWasm,
        linkerWasmUrl: context.assets.cppLinkerWasm,
        sysrootUrl: context.assets.cppSysroot,
        runtimeHeaderUrl: context.assets.cppRuntimeHeader,
        compilerBundleUrl: context.assets.cppCompilerBundle,
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
      const createWorkerClient = () => new CppWorkerClient(workerOptions);
      const worker = createWorkerClient();
      const client = createCppRuntimeClient(worker);
      const preparedProvider = createCppPreparedExecutionProvider({
        createWorkerClient,
      });
      const clients = new Map<Language, RuntimeClient>([['cpp', client]]);
      const preparedProviders = new Map([['cpp', preparedProvider]]);
      return {
        clients,
        preparedProviders,
        warm: () => worker.warmup(),
        disposeLanguage: () => worker.terminate(),
        dispose: () => worker.terminate(),
      };
    },
  };
}
