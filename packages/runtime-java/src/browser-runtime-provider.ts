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
  createJavaBrowserPreparedExecutionProvider,
} from './java-prepared-provider';
import {
  type JavaWorkerClientOptions,
} from './java-worker-client';

export interface JavaBrowserRuntimeProviderOptions {
  workerIdleTimeoutMs?: number;
  compileCacheLimit?: number;
  externalCompilerUrl?: string;
  loaderUrl?: string;
}

export function createJavaBrowserRuntimeProvider(
  options: JavaBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-java',
    languages: ['java'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      if (
        context.assets.runtimeManifests?.java?.assets.loader &&
        options.loaderUrl
      ) {
        throw new TypeError(
          'Java runtime assets cannot combine manifest.assets.loader with java.loaderUrl.'
        );
      }

      const workerFactory = context.workerFactoryFor('java');
      const javaManifest = context.assets.runtimeManifests?.java;
      const workerOptions: JavaWorkerClientOptions = {
        workerUrl: context.assets.javaWorker,
        ...(workerFactory
          ? { workerFactory, isolatedRuntimeStorage: true }
          : {}),
        debug: context.debug,
        workerIdleTimeoutMs: options.workerIdleTimeoutMs,
        compileCacheLimit: options.compileCacheLimit,
        externalCompilerUrl: options.externalCompilerUrl,
        loaderUrl: options.loaderUrl,
        assetPreflight: context.preflight('java', ['worker']),
        runtimeAssetPreflight: context.preflight('java', [
          'loader',
          'helperJar',
          'compilerJar',
          'rewriterJar',
          'parserJar',
        ]),
        ...(javaManifest
          ? {
              runtimeAssets: {
                ...(context.manifestAsset('java', 'loader')?.url
                  ? {
                      loaderUrl:
                        context.manifestAsset('java', 'loader')?.url,
                    }
                  : {}),
                ...(context.manifestAsset('java', 'helperJar')?.url
                  ? {
                      helperJarUrl:
                        context.manifestAsset('java', 'helperJar')?.runtimePath ??
                        context.manifestAsset('java', 'helperJar')?.url,
                    }
                  : {}),
                ...(context.manifestAsset('java', 'compilerJar')?.url
                  ? {
                      compilerJarUrl:
                        context.manifestAsset('java', 'compilerJar')?.runtimePath ??
                        context.manifestAsset('java', 'compilerJar')?.url,
                    }
                  : {}),
                ...(context.manifestAsset('java', 'rewriterJar')?.url
                  ? {
                      rewriterJarUrl:
                        context.manifestAsset('java', 'rewriterJar')?.runtimePath ??
                        context.manifestAsset('java', 'rewriterJar')?.url,
                    }
                  : {}),
                ...(context.manifestAsset('java', 'parserJar')?.url
                  ? {
                      parserJarUrl:
                        context.manifestAsset('java', 'parserJar')?.runtimePath ??
                        context.manifestAsset('java', 'parserJar')?.url,
                    }
                  : {}),
              },
            }
          : {}),
      };
      const preparedProvider =
        createJavaBrowserPreparedExecutionProvider(workerOptions);
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([['java', preparedProvider]]);

      return {
        preparedProviders,
        disposeLanguage: () => preparedProvider.releaseStandby(),
        dispose: () => preparedProvider.dispose(),
      };
    },
  };
}
