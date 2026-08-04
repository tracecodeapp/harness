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
} from './python-worker-client';
import { createPythonRuntimeImageFactory } from './python-runtime-image';
import { resolveBuiltInPythonRuntimeAssets } from './python-runtime-assets';

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
      const builtInRuntime = pythonManifest
        ? undefined
        : resolveBuiltInPythonRuntimeAssets(context.assets, context.engine);
      const runtimeImageDescriptor =
        pythonManifest?.assets.runtimeImage ?? builtInRuntime?.image;
      if (!runtimeImageDescriptor) {
        throw new Error(
          'TraceCode Python 0.15 requires runtimeImage in a custom Python runtime manifest. ' +
            'Remove the custom manifest to use the image assets shipped by the Harness, or ' +
            'publish an engine-matched immutable image with the custom runtime.'
        );
      }
      if (runtimeImageDescriptor.engine !== context.engine) {
        throw new Error(
          `Python runtime image targets ${JSON.stringify(runtimeImageDescriptor.engine)}, ` +
            `but the selected browser engine is ${JSON.stringify(context.engine)}.`
        );
      }
      const loaderUrl =
        context.manifestAsset('python', 'runtimeLoader')?.url ??
        builtInRuntime?.loaderUrl;
      const indexUrl =
        context.manifestAsset('python', 'runtimeIndex')?.url ??
        builtInRuntime?.indexUrl;
      if (!loaderUrl || !indexUrl) {
        throw new Error(
          'TraceCode Python requires runtimeLoader and runtimeIndex in a custom ' +
            'Python runtime manifest.'
        );
      }
      const createRuntimeImageFactory = () =>
        createPythonRuntimeImageFactory({
          descriptor: runtimeImageDescriptor,
        });
      let runtimeImageFactory = createRuntimeImageFactory();
      const workerOptions = () => ({
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
        runtimeImageFactory,
        runtimeAssets: {
          runtimeCoreUrl: context.assets.pythonRuntimeCore,
          snippetsUrl: context.assets.pythonSnippets,
          loaderUrl,
          indexUrl,
          ...(pythonManifest?.loaderFormat
            ? { loaderFormat: pythonManifest.loaderFormat }
            : builtInRuntime
              ? { loaderFormat: 'classic-script' as const }
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
      const createWorkerClient = () => new PythonWorkerClient(workerOptions());
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
        preflightLanguage: async () => {
          await runtimeImageFactory.acquire();
        },
        disposeLanguage: () => {
          preparedProvider.reset();
          runtimeImageFactory.dispose();
          runtimeImageFactory = createRuntimeImageFactory();
        },
        dispose: () => {
          preparedProvider.terminate();
          runtimeImageFactory.dispose();
        },
      };
      return lease;
    },
  };
}
