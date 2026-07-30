import type { Language, RuntimeClient } from '@tracecode/harness-core';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/harness-browser';
import { createJavaScriptRuntimeClient } from './javascript-runtime-client';
import { JavaScriptWorkerClient } from './javascript-worker-client';

export function createJavaScriptBrowserRuntimeProvider(): BrowserRuntimeProvider {
  return {
    id: '@tracecode/harness-javascript',
    languages: ['javascript', 'typescript'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      const workerFactory =
        context.workerFactoryFor('javascript') ??
        context.workerFactoryFor('typescript');
      const worker = new JavaScriptWorkerClient({
        workerUrl: context.assets.javascriptWorker,
        ...(workerFactory ? { workerFactory } : {}),
        debug: context.debug,
        assetPreflight: context.preflight('javascript', ['worker']),
        runtimeAssetPreflight: context.preflight('javascript', ['libraries']),
        ...(context.manifestAsset('javascript', 'libraries')?.url
          ? {
              javascriptLibrariesUrl:
                context.manifestAsset('javascript', 'libraries')?.url,
            }
          : {}),
        typescriptCompilerUrl: context.assets.typescriptCompiler,
        typescriptCompilerPreflight: context.preflight('typescript', ['compiler']),
      });
      const javascript = createJavaScriptRuntimeClient('javascript', worker);
      const typescript = createJavaScriptRuntimeClient('typescript', worker);
      const clients = new Map<Language, RuntimeClient>([
        ['javascript', javascript],
        ['typescript', typescript],
      ]);

      return {
        clients,
        warm: (language) =>
          language === 'typescript'
            ? worker.warmup('typescript')
            : javascript.init(),
        disposeLanguage: () => worker.terminate(),
        dispose: () => worker.terminate(),
      };
    },
  };
}
