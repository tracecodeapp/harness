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
  createJavaBrowserPreparedExecutionProvider,
} from './java-prepared-provider';
import {
  type JavaWorkerClientOptions,
} from './java-worker-client';
import {
  preflightBuiltInTraceJVMRuntimeAssets,
  resolveBuiltInTraceJVMRuntimeAssetBaseUrl,
} from './tracejvm-runtime-assets';

export interface JavaBrowserRuntimeProviderOptions {
  workerIdleTimeoutMs?: number;
  compileCacheLimit?: number;
  /**
   * Base URL of the immutable Java runtime asset tree used by the bridge
   * worker. The tree contains the engine module, WebAssembly binary, and
   * runtime profile.
   */
  runtimeAssetBaseUrl?: string;
}

function configureJavaRuntimeAssetBaseUrl(
  workerUrl: string,
  runtimeAssetBaseUrl: string | undefined
): string {
  if (runtimeAssetBaseUrl === undefined) return workerUrl;
  if (!runtimeAssetBaseUrl.trim()) {
    throw new TypeError('Java runtimeAssetBaseUrl must not be empty.');
  }
  if (/[?#]/u.test(runtimeAssetBaseUrl)) {
    throw new TypeError(
      'Java runtimeAssetBaseUrl must be a directory URL without a query or fragment.'
    );
  }

  const hashIndex = workerUrl.indexOf('#');
  const beforeHash =
    hashIndex === -1 ? workerUrl : workerUrl.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : workerUrl.slice(hashIndex);
  if (/(?:^|[?&])tracejvmBaseUrl=/.test(beforeHash)) {
    throw new TypeError(
      'Java worker URL and java.runtimeAssetBaseUrl cannot both configure the runtime asset base.'
    );
  }

  const separator = beforeHash.includes('?') ? '&' : '?';
  return (
    `${beforeHash}${separator}tracejvmBaseUrl=` +
    `${encodeURIComponent(runtimeAssetBaseUrl)}${hash}`
  );
}

function workerAssetRoot(workerUrl: string): string {
  const withoutFragment = workerUrl.split('#', 1)[0]!;
  const withoutQuery = withoutFragment.split('?', 1)[0]!;
  const separator = withoutQuery.lastIndexOf('/');
  return separator < 0 ? '.' : withoutQuery.slice(0, separator);
}

export function createJavaBrowserRuntimeProvider(
  options: JavaBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-java',
    languages: ['java'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      const workerFactory = context.workerFactoryFor('java');
      const runtimeAssetBaseUrl =
        options.runtimeAssetBaseUrl ??
        resolveBuiltInTraceJVMRuntimeAssetBaseUrl(
          workerAssetRoot(context.assets.javaWorker)
        );
      const workerOptions: JavaWorkerClientOptions = {
        workerUrl: configureJavaRuntimeAssetBaseUrl(
          context.assets.javaWorker,
          runtimeAssetBaseUrl
        ),
        ...(workerFactory
          ? { workerFactory, isolatedRuntimeStorage: true }
          : {}),
        debug: context.debug,
        workerIdleTimeoutMs: options.workerIdleTimeoutMs,
        compileCacheLimit: options.compileCacheLimit,
        assetPreflight: context.preflight('java', ['worker']),
      };
      const preparedProvider =
        createJavaBrowserPreparedExecutionProvider(workerOptions);
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([['java', preparedProvider]]);

      return {
        preparedProviders,
        preflightLanguage: () =>
          preflightBuiltInTraceJVMRuntimeAssets(runtimeAssetBaseUrl),
        disposeLanguage: () => preparedProvider.releaseStandby(),
        dispose: () => preparedProvider.dispose(),
      };
    },
  };
}
