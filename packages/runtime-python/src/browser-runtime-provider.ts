import type { Language, RuntimeClient } from '@tracecode/runtime-core';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/runtime-browser';
import { FreshWorkerRuntimeClient } from '@tracecode/runtime-browser/internal';
import { createPythonRuntimeClient } from './python-runtime-client';
import { PythonWorkerClient } from './python-worker-client';

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
      const worker = new PythonWorkerClient({
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
      });
      const directClient = createPythonRuntimeClient(worker);
      const safeClient = new FreshWorkerRuntimeClient(directClient, {
        retireWorker: () => worker.terminate(),
        prepareWorker: () => worker.warmup(),
        prewarmAfterUse: context.prewarmAfterUse,
      });
      const client: RuntimeClient =
        context.executionIsolation === 'safe' ? safeClient : directClient;
      const clients = new Map<Language, RuntimeClient>([['python', client]]);

      return {
        clients,
        warm: () =>
          context.executionIsolation === 'safe'
            ? safeClient.prepare()
            : worker.warmup(),
        disposeLanguage: () => {
          if (context.executionIsolation === 'safe') safeClient.reset();
          else worker.terminate();
        },
        dispose: () => {
          if (context.executionIsolation === 'safe') safeClient.reset();
          worker.terminate();
        },
      };
    },
  };
}
