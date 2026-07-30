import type { Language, RuntimeClient } from '@tracecode/runtime-core';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/runtime-browser';
import { FreshWorkerRuntimeClient } from '@tracecode/runtime-browser/internal';
import { createCSharpRuntimeClient } from './csharp-runtime-client';
import { CSharpWorkerClient } from './csharp-worker-client';

export interface CSharpBrowserRuntimeProviderOptions {
  workerIdleTimeoutMs?: number;
}

export function createCSharpBrowserRuntimeProvider(
  options: CSharpBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-csharp',
    languages: ['csharp'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      const workerFactory = context.workerFactoryFor('csharp');
      const dependencyDescriptors = context.manifestAssetCollection(
        'csharp',
        'dependencies'
      );
      const worker = new CSharpWorkerClient({
        workerUrl: context.assets.csharpWorker,
        ...(workerFactory ? { workerFactory } : {}),
        assetBaseUrl: context.assets.csharpAssetBaseUrl,
        debug: context.debug,
        workerIdleTimeoutMs: options.workerIdleTimeoutMs,
        assetPreflight: context.preflight('csharp', ['worker']),
        runtimeAssetPreflight: context.preflight('csharp', [
          'assetBaseUrl',
          'dependencies',
        ]),
        ...(dependencyDescriptors
          ? {
              runtimeDependencies: Object.fromEntries(
                Object.entries(dependencyDescriptors).map(([name, descriptor]) => [
                  name,
                  descriptor.url,
                ])
              ),
            }
          : {}),
      });
      const directClient = createCSharpRuntimeClient(worker);
      const safeClient = new FreshWorkerRuntimeClient(directClient, {
        retireWorker: () => worker.terminate(),
        prepareWorker: () => worker.warmup(),
        prewarmAfterUse: context.prewarmAfterUse,
      });
      const client: RuntimeClient =
        context.executionIsolation === 'safe' ? safeClient : directClient;
      const clients = new Map<Language, RuntimeClient>([['csharp', client]]);

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
