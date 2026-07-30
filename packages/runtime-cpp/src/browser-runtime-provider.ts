import type {
  Language,
  RuntimePreparedExecutionProvider,
} from '@tracecode/runtime-contracts';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/runtime-browser';
import { createCppPreparedExecutionProvider } from './cpp-prepared-provider';
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
      const preparedProvider = createCppPreparedExecutionProvider({
        createWorkerClient,
      });
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([['cpp', preparedProvider]]);
      return {
        preparedProviders,
        disposeLanguage: () => preparedProvider.reset(),
        dispose: () => preparedProvider.terminate(),
      };
    },
  };
}
