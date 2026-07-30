import type { Language, RuntimeClient } from '@tracecode/harness-core';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/harness-browser';
import { FreshWorkerRuntimeClient } from '@tracecode/harness-browser/internal';
import { createJavaRuntimeClient } from './java-runtime-client';
import { runJavaSafeStorageExclusive } from './java-storage-isolation';
import { JavaWorkerClient } from './java-worker-client';

export interface JavaBrowserRuntimeProviderOptions {
  workerIdleTimeoutMs?: number;
  compileCacheLimit?: number;
  externalCompilerUrl?: string;
  cheerpjLoaderUrl?: string;
}

export function createJavaBrowserRuntimeProvider(
  options: JavaBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/harness-java',
    languages: ['java'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      if (
        context.assets.runtimeManifests?.java?.assets.loader &&
        options.cheerpjLoaderUrl
      ) {
        throw new TypeError(
          'Java runtime assets cannot combine manifest.assets.loader with java.cheerpjLoaderUrl.'
        );
      }

      const workerFactory = context.workerFactoryFor('java');
      const javaManifest = context.assets.runtimeManifests?.java;
      const worker = new JavaWorkerClient({
        workerUrl: context.assets.javaWorker,
        ...(workerFactory
          ? { workerFactory, isolatedRuntimeStorage: true }
          : {}),
        debug: context.debug,
        workerIdleTimeoutMs: options.workerIdleTimeoutMs,
        compileCacheLimit: options.compileCacheLimit,
        externalCompilerUrl: options.externalCompilerUrl,
        cheerpjLoaderUrl: options.cheerpjLoaderUrl,
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
      });
      const directClient = createJavaRuntimeClient(worker);
      const safeClient = new FreshWorkerRuntimeClient(directClient, {
        retireWorker: () => worker.terminate(),
        prepareWorker: () => worker.warmup(),
        prewarmAfterUse: context.prewarmAfterUse,
        beforeExecution: () => worker.resetPersistentStorage(),
        runExclusive: runJavaSafeStorageExclusive,
      });
      const client: RuntimeClient =
        context.executionIsolation === 'safe' ? safeClient : directClient;
      const clients = new Map<Language, RuntimeClient>([['java', client]]);

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
