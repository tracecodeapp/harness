import type {
  Language,
  RuntimePreparedExecutionProvider,
} from '@tracecode/runtime-core';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/runtime-browser';
import {
  createJavaScriptPreparedExecutionProvider,
} from './javascript-runtime-client';
import { JavaScriptWorkerClient } from './javascript-worker-client';

export function createJavaScriptBrowserRuntimeProvider(): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-javascript',
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
      const javascript =
        createJavaScriptPreparedExecutionProvider('javascript', worker);
      const typescript =
        createJavaScriptPreparedExecutionProvider('typescript', worker);
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([
        ['javascript', javascript],
        ['typescript', typescript],
      ]);

      return {
        preparedProviders,
        disposeLanguage: () => worker.terminate(),
        dispose: () => worker.terminate(),
      };
    },
  };
}
