import { TRACECODE_HARNESS_VERSION } from '@tracecode/runtime-contracts';
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
import {
  createJavaScriptPreparedExecutionProvider,
} from './javascript-runtime-client';
import { JavaScriptWorkerClient } from './javascript-worker-client';

export interface JavaScriptBrowserRuntimeProviderOptions {
  /**
   * Function-style correctness and trace execution use the retained SES
   * compartment pool by default. Set `disposable-worker` only for
   * compatibility diagnostics. Script-mode execution remains disposable.
   */
  readonly algorithmExecution?:
    | 'disposable-worker'
    | 'ses-compartment-pool';
}

export function createJavaScriptBrowserRuntimeProvider(
  options: JavaScriptBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-javascript',
    languages: ['javascript', 'typescript'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeJudgeReceiptLease {
      const workerFactory =
        context.workerFactoryFor('javascript') ??
        context.workerFactoryFor('typescript');
      const manifestLibrariesAsset =
        context.manifestAsset('javascript', 'libraries');
      const manifestLibrariesUrl = manifestLibrariesAsset?.url;
      const worker = new JavaScriptWorkerClient({
        workerUrl: context.assets.javascriptWorker,
        ...(workerFactory ? { workerFactory } : {}),
        debug: context.debug,
        assetPreflight: context.preflight('javascript', ['worker']),
        runtimeAssetPreflight: context.preflight('javascript', ['libraries']),
        ...(manifestLibrariesUrl
          ? { javascriptLibrariesUrl: manifestLibrariesUrl }
          : {}),
        typescriptCompilerUrl: context.assets.typescriptCompiler,
        typescriptCompilerPreflight: context.preflight('typescript', ['compiler']),
        replenishStandbyAfterUse:
          context.workerLifecyclePolicy === 'warm-and-retire',
        algorithmExecution:
          options.algorithmExecution ?? 'ses-compartment-pool',
        ...(options.algorithmExecution !== 'disposable-worker'
          ? {
              algorithmWorkerUrl: context.assets.javascriptAlgorithmWorker,
              algorithmWorkerPreflight: context.preflight(
                'javascript',
                ['algorithmWorker']
              ),
              ...(manifestLibrariesUrl
                ? { algorithmJavascriptLibrariesUrl: manifestLibrariesUrl }
                : {}),
              ...(manifestLibrariesAsset?.integrity
                ? {
                    algorithmJavascriptLibrariesIntegrity:
                      manifestLibrariesAsset.integrity,
                  }
                : {}),
            }
          : {}),
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
      const observation: JudgeReceiptProvider = {
        runtimeVersion: TRACECODE_HARNESS_VERSION,
        capabilities: {
          algorithmBundlesOnly: true,
          observationLease: 'separate',
          observationDeadlineMs: 20_000,
        },
        prepareObservation: (_program, signal, options, key) =>
          worker.prepareObservation(key, options, signal),
      };
      return {
        preparedProviders,
        judgeReceiptProviders: new Map([['javascript', observation], ['typescript', observation]]),
        // JavaScript and TypeScript share one coordinator/executor generation.
        disposeLanguage: () => worker.reset(),
        dispose: () => worker.terminate(),
      };
    },
  };
}
