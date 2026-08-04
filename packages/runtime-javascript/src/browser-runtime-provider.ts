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
      const resetSharedRuntime = (): void => {
        // JavaScript and TypeScript share one coordinator/executor pool.
        // A language-scoped reset retires both sides of that shared generation
        // so its sibling can acquire fresh workers on its next call.
        worker.reset();
      };

      return {
        preparedProviders,
        disposeLanguage: resetSharedRuntime,
        dispose: () => worker.terminate(),
      };
    },
  };
}
