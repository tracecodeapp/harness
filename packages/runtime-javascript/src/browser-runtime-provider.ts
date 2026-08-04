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
      const javascriptLibrariesUrl =
        context.manifestAsset('javascript', 'libraries')?.url;
      const worker = new JavaScriptWorkerClient({
        workerUrl: context.assets.javascriptWorker,
        ...(workerFactory ? { workerFactory } : {}),
        debug: context.debug,
        assetPreflight: context.preflight('javascript', ['worker']),
        runtimeAssetPreflight: context.preflight('javascript', ['libraries']),
        ...(javascriptLibrariesUrl ? { javascriptLibrariesUrl } : {}),
        typescriptCompilerUrl: context.assets.typescriptCompiler,
        typescriptCompilerPreflight: context.preflight('typescript', ['compiler']),
        prewarmAfterUse: context.prewarmAfterUse,
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
        // JavaScript and TypeScript share one coordinator/executor generation.
        disposeLanguage: () => worker.reset(),
        dispose: () => worker.terminate(),
      };
    },
  };
}
