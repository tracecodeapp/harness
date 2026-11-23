import type {
  Language,
  RuntimePreparedExecutionProvider,
} from '@tracecode/runtime-contracts';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
} from '@tracecode/runtime-browser';
import type {
  BrowserRuntimeJudgeReceiptLease,
  JudgeReceiptProvider,
} from '../../runtime-browser/src/browser-runtime-host-internal';
import { TRACECODE_HARNESS_VERSION } from '@tracecode/runtime-contracts';
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
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeJudgeReceiptLease {
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
          'TraceCode Python 0.16 requires runtimeImage in a custom Python runtime manifest. ' +
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
          workerUrl: context.assets.pythonWorker,
          ...(workerFactory ? { workerFactory } : {}),
          ...(pythonManifest?.workerFormat
            ? { workerFormat: pythonManifest.workerFormat }
            : {}),
        });
      let runtimeImageFactory = createRuntimeImageFactory();
      const runtimeImageWorkerPreflight = context.preflight('python', [
        'worker',
      ]);
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
          'runtime',
          'runtimeLoader',
          'runtimeIndex',
          'distribution',
          'packages',
        ]),
        runtimeImageFactory,
        runtimeAssets: {
          runtimeUrl: context.assets.pythonRuntime,
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
        replenishStandbyAfterUse:
          context.workerLifecyclePolicy === 'warm-and-retire',
      });
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([['python', preparedProvider]]);

      const receiptProvider: JudgeReceiptProvider = {
        runtimeVersion: JSON.stringify({
          harness: TRACECODE_HARNESS_VERSION,
          worker: context.assets.pythonWorker,
          runtime: context.assets.pythonRuntime,
          snapshot: runtimeImageDescriptor.snapshot.integrity,
          wasm: runtimeImageDescriptor.wasm.integrity,
        }),
        capabilities: {
          observationLease: 'separate',
          observationDeadlineMs: 15_000,
          observationPrepareDeadlineMs: 30_000,
          stoppingBatchAdmission: 'worker-start',
          nonStoppingBatchAdmission: 'worker-start',
        },
        prepareObservation: (program, signal, traceOptions) =>
          preparedProvider.prepareObservation(program, signal, traceOptions),
      };

      const lease: BrowserRuntimeJudgeReceiptLease & {
        readonly preparedProviders: ReadonlyMap<
          Language,
          RuntimePreparedExecutionProvider
        >;
      } = {
        preparedProviders,
        judgeReceiptProviders: new Map([['python', receiptProvider]]),
        preflightLanguage: async () => {
          // The page verifies only the small bootstrap program. Its Worker
          // owns the CPython Wasm/snapshot fetch, integrity check, and compile.
          await runtimeImageWorkerPreflight();
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
