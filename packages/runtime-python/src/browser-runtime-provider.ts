import type {
  Language,
  RuntimePreparedExecutionProvider,
} from '@tracecode/runtime-contracts';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/runtime-browser';
import {
  createPythonPreparedExecutionProvider,
} from './python-runtime-client';
import {
  PythonWorkerClient,
  type PythonWorkerClientOptions,
} from './python-worker-client';

export interface PythonBrowserRuntimeProviderOptions {
  compileCacheLimit?: number;
}

export function createPythonBrowserRuntimeProvider(
  options: PythonBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-python',
    languages: ['python'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      const workerFactory = context.workerFactoryFor('python');
      const pythonPackageDescriptors = context.manifestAssetCollection('python', 'packages');
      const pythonManifest = context.assets.runtimeManifests?.python;
      const workerOptions: PythonWorkerClientOptions = {
        workerUrl: context.assets.pythonWorker,
        ...(workerFactory ? { workerFactory } : {}),
        compileCacheLimit: options.compileCacheLimit,
        ...(pythonManifest?.workerFormat
          ? { workerFormat: pythonManifest.workerFormat }
          : {}),
        debug: context.debug,
        assetPreflight: context.preflight('python', ['worker', 'snippets']),
        runtimeAssetPreflight: context.preflight('python', [
          'runtimeCore',
          'runtimeLoader',
          'runtimeIndex',
          'distribution',
          'packages',
        ]),
        runtimeAssets: {
          runtimeCoreUrl: context.assets.pythonRuntimeCore,
          snippetsUrl: context.assets.pythonSnippets,
          ...(context.manifestAsset('python', 'runtimeLoader')?.url
            ? { loaderUrl: context.manifestAsset('python', 'runtimeLoader')?.url }
            : {}),
          ...(context.manifestAsset('python', 'runtimeIndex')?.url
            ? { indexUrl: context.manifestAsset('python', 'runtimeIndex')?.url }
            : {}),
          ...(pythonManifest?.loaderFormat
            ? { loaderFormat: pythonManifest.loaderFormat }
            : {}),
          ...(pythonPackageDescriptors
            ? {
                packageUrls: Object.fromEntries(
                  Object.entries(pythonPackageDescriptors).map(([name, descriptor]) => [
                    name,
                    descriptor.url,
                  ])
                ),
              }
            : {}),
        },
      };
      const createWorkerClient = () => new PythonWorkerClient(workerOptions);
      const preparedProvider = createPythonPreparedExecutionProvider({
        createWorkerClient,
        prewarmAfterUse: context.prewarmAfterUse,
      });
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([['python', preparedProvider]]);

      const lease: BrowserRuntimeProviderLease & {
        readonly preparedProviders: ReadonlyMap<
          Language,
          RuntimePreparedExecutionProvider
        >;
      } = {
        preparedProviders,
        disposeLanguage: () => preparedProvider.reset(),
        dispose: () => preparedProvider.terminate(),
      };
      return lease;
    },
  };
}
