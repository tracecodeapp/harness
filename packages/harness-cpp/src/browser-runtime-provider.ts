import type { Language, RuntimeClient } from '@tracecode/harness-core';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/harness-browser';
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
    id: '@tracecode/harness-cpp',
    languages: ['cpp'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      const workerFactory = context.workerFactoryFor('cpp');
      const worker = new CppWorkerClient({
        workerUrl: context.assets.cppWorker,
        ...(workerFactory ? { workerFactory } : {}),
        assetPreflight: context.preflight('cpp', ['worker']),
        runtimeAssetPreflight: context.preflight('cpp', [
          'compilerFrame',
          'compilerWorker',
          'runtimeHeader',
          'compilerBundle',
          'clangWasm',
          'lldWasm',
          'sysroot',
          'toolchain',
        ]),
        compilerFrameUrl: context.assets.cppCompilerFrame,
        compilerWorkerUrl: context.assets.cppCompilerWorker,
        clangWasmUrl: context.assets.cppClangWasm,
        lldWasmUrl: context.assets.cppLldWasm,
        sysrootUrl: context.assets.cppSysroot,
        runtimeHeaderUrl: context.assets.cppRuntimeHeader,
        compilerBundleUrl: context.assets.cppCompilerBundle,
        toolchainIntegrity: context.assets.cppToolchainIntegrity,
        debug: context.debug,
        initTimeoutMs: options.initTimeoutMs,
        executionTimeoutMs: options.executionTimeoutMs,
        tracingTimeoutMs: options.tracingTimeoutMs,
        workerIdleTimeoutMs: options.workerIdleTimeoutMs,
        programCacheLimit: options.programCacheLimit,
        usePrecompiledHeader: options.usePrecompiledHeader,
        externalCompilerUrl: options.externalCompilerUrl,
      });
      const client = createCppRuntimeClient(worker);
      const clients = new Map<Language, RuntimeClient>([['cpp', client]]);
      return {
        clients,
        warm: () => worker.warmup(),
        disposeLanguage: () => worker.terminate(),
        dispose: () => worker.terminate(),
      };
    },
  };
}
