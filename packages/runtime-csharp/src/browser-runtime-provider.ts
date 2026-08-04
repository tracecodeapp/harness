import type {
  Language,
  RuntimePreparedExecutionProvider,
} from '@tracecode/runtime-contracts';
import type {
  BrowserRuntimeProvider,
  BrowserRuntimeProviderContext,
  BrowserRuntimeProviderLease,
} from '@tracecode/runtime-browser';
import { createCSharpRuntimeClient } from './csharp-runtime-client';
import { CSharpWorkerClient } from './csharp-worker-client';

export interface CSharpBrowserRuntimeProviderOptions {
  /** Idle timeout for the general Project/terminal/server-capable worker. */
  workerIdleTimeoutMs?: number;
  /** Idle timeout for the trusted Roslyn authority. */
  compilerIdleTimeoutMs?: number;
  /** Idle timeout for a prewarmed, unused disposable Judge runner. */
  runnerIdleTimeoutMs?: number;
  /** Disable only for deployments that have not published the role bundles yet. */
  preparedAuthority?: boolean;
}

const FIREFOX_PREPARED_WORKER_IDLE_TIMEOUT_MS = 20_000;

function isFirefoxBrowser(): boolean {
  return typeof navigator !== 'undefined' &&
    /\bFirefox\//u.test(navigator.userAgent);
}

export function createCSharpBrowserRuntimeProvider(
  options: CSharpBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProvider {
  return {
    id: '@tracecode/runtime-csharp',
    languages: ['csharp'],
    create(context: BrowserRuntimeProviderContext): BrowserRuntimeProviderLease {
      const workerFactory = context.workerFactoryFor('csharp');
      const dependencyDescriptors = context.manifestAssetCollection(
        'csharp',
        'dependencies'
      );
      const generalManifestAsset = context.manifestAsset(
        'csharp',
        'assetBaseUrl'
      );
      const compilerManifestAsset = context.manifestAsset(
        'csharp',
        'compilerAssetBaseUrl'
      );
      const runnerManifestAsset = context.manifestAsset(
        'csharp',
        'runnerAssetBaseUrl'
      );
      if (Boolean(compilerManifestAsset) !== Boolean(runnerManifestAsset)) {
        throw new TypeError(
          'C# runtime manifests must publish compilerAssetBaseUrl and runnerAssetBaseUrl together.'
        );
      }
      const manifestPublishesPreparedRoles =
        Boolean(compilerManifestAsset) && Boolean(runnerManifestAsset);
      if (
        options.preparedAuthority === true &&
        generalManifestAsset &&
        !manifestPublishesPreparedRoles
      ) {
        throw new TypeError(
          'C# preparedAuthority requires compiler and runner assets in the runtime manifest.'
        );
      }
      // A pre-role-split manifest is a valid deployment contract. Keep it on
      // the general worker rather than silently resolving role URLs from the
      // package defaults, which may point at an unrelated origin.
      const preparedAuthorityEnabled =
        options.preparedAuthority !== false &&
        (!generalManifestAsset || manifestPublishesPreparedRoles);
      // Firefox retained materially more process RSS after .NET worker warmup
      // in the C# spike. Preserve the prewarm needed for sub-second Judge runs,
      // but let unused prepared capacity retire sooner there. Explicit caller
      // settings always win.
      const firefoxPreparedIdleTimeoutMs = isFirefoxBrowser()
        ? FIREFOX_PREPARED_WORKER_IDLE_TIMEOUT_MS
        : undefined;
      // The general worker's idle budget should not silently retire the much
      // more expensive persistent compiler authority. Firefox retains its
      // measured memory-specific policy unless the caller configures the
      // compiler explicitly.
      const compilerIdleTimeoutMs =
        options.compilerIdleTimeoutMs ?? firefoxPreparedIdleTimeoutMs;
      const runnerIdleTimeoutMs =
        options.runnerIdleTimeoutMs ??
        options.workerIdleTimeoutMs ??
        firefoxPreparedIdleTimeoutMs;
      const dependencyUrls = (
        collection: 'dependencies' | 'compilerDependencies' | 'runnerDependencies'
      ): Readonly<Record<string, string>> | undefined => {
        const descriptors = context.manifestAssetCollection('csharp', collection);
        return descriptors
          ? Object.fromEntries(
              Object.entries(descriptors).map(([name, descriptor]) => [
                name,
                descriptor.url,
              ])
            )
          : undefined;
      };
      const worker = new CSharpWorkerClient({
        workerUrl: context.assets.csharpWorker,
        ...(workerFactory ? { workerFactory } : {}),
        assetBaseUrl: context.assets.csharpAssetBaseUrl,
        debug: context.debug,
        workerIdleTimeoutMs: options.workerIdleTimeoutMs,
        assetPreflight: context.preflight('csharp', ['worker']),
        runtimeAssetPreflight: context.preflight('csharp', [
          'assetBaseUrl',
          'dependencies',
        ]),
        ...(dependencyDescriptors
          ? {
              runtimeDependencies: dependencyUrls('dependencies'),
            }
          : {}),
      });
      const compiler = !preparedAuthorityEnabled
        ? worker
        : new CSharpWorkerClient({
            workerUrl: context.assets.csharpWorker,
            ...(workerFactory ? { workerFactory } : {}),
            assetBaseUrl: context.assets.csharpCompilerAssetBaseUrl,
            debug: context.debug,
            workerIdleTimeoutMs: compilerIdleTimeoutMs,
            runtimeRole: 'compiler',
            assetPreflight: context.preflight('csharp', ['worker']),
            runtimeAssetPreflight: context.preflight('csharp', [
              'compilerAssetBaseUrl',
              'compilerDependencies',
            ]),
            ...(dependencyUrls('compilerDependencies')
              ? {
                  runtimeDependencies: dependencyUrls('compilerDependencies'),
                }
              : {}),
          });
      const activeRunners = new Set<CSharpWorkerClient>();
      let disposed = false;
      const createRunnerClient = (): CSharpWorkerClient => {
        if (disposed) {
          throw new Error('C# browser runtime provider has been disposed.');
        }
        const runner = new CSharpWorkerClient({
          workerUrl: context.assets.csharpWorker,
          ...(workerFactory ? { workerFactory } : {}),
          assetBaseUrl: context.assets.csharpRunnerAssetBaseUrl,
          debug: context.debug,
          workerIdleTimeoutMs: runnerIdleTimeoutMs,
          runtimeRole: 'runner',
          assetPreflight: context.preflight('csharp', ['worker']),
          runtimeAssetPreflight: context.preflight('csharp', [
            'runnerAssetBaseUrl',
            'runnerDependencies',
          ]),
          ...(dependencyUrls('runnerDependencies')
            ? {
                runtimeDependencies: dependencyUrls('runnerDependencies'),
              }
            : {}),
        });
        activeRunners.add(runner);
        return runner;
      };
      let standbyRunner: CSharpWorkerClient | undefined;
      let warmingRunner: CSharpWorkerClient | undefined;
      const publishWarmedRunner = (runner: CSharpWorkerClient): void => {
        if (disposed || warmingRunner !== runner) return;
        warmingRunner = undefined;
        standbyRunner = runner;
      };
      const retireWarmingRunner = (runner: CSharpWorkerClient): void => {
        if (warmingRunner === runner) warmingRunner = undefined;
        activeRunners.delete(runner);
        runner.terminate();
      };
      const warmStandbyRunner = (runner: CSharpWorkerClient): void => {
        const runnerLoad = runner.warmup();
        if (compiler === worker) {
          void runnerLoad
            .then(() => publishWarmedRunner(runner))
            .catch(() => retireWarmingRunner(runner));
          return;
        }
        // Ask the compiler client for its current warmup promise for every
        // replacement. CSharpWorkerClient clears a failed memo, so a transient
        // compiler failure must not remain sticky for the whole provider.
        const compilerLoad = compiler.warmup().then(
          (ready) => ready,
          () => undefined
        );
        void runnerLoad
          .then(async () => {
            const compilerReady = await compilerLoad;
            if (!compilerReady) {
              // Compiler priming is an optimization. A runtime-warm runner is
              // still safe to lease; the next replacement retries the compiler.
              publishWarmedRunner(runner);
              return;
            }
            if (disposed || warmingRunner !== runner) return;
            const artifact = compilerReady.trustedPreparedArtifact;
            if (!artifact) {
              throw new Error(
                'C# compiler warmup did not return its trusted prepared artifact.'
              );
            }
            const result = await runner.executePreparedCode(artifact, {
              inputs: { a: 1, b: 2 },
            });
            if (result.kind !== 'completed' || result.output !== 3) {
              throw new Error('C# standby runner trusted prime failed.');
            }
            publishWarmedRunner(runner);
          })
          .catch(() => {
            // A runner that attempted and failed trusted priming is never
            // learner-bearing. Retire it and fail soft to the next lease.
            retireWarmingRunner(runner);
          });
      };
      const ensureStandbyRunner = (): void => {
        if (
          disposed ||
          !preparedAuthorityEnabled ||
          standbyRunner ||
          warmingRunner
        ) {
          return;
        }
        const runner = createRunnerClient();
        warmingRunner = runner;
        warmStandbyRunner(runner);
      };
      ensureStandbyRunner();
      const preparedAuthority = preparedAuthorityEnabled
        ? {
            compiler,
            createRunner(): CSharpWorkerClient {
              if (disposed) {
                throw new Error('C# browser runtime provider has been disposed.');
              }
              const runner = standbyRunner ?? createRunnerClient();
              if (runner === standbyRunner) standbyRunner = undefined;
              return runner;
            },
            releaseRunner(runner: CSharpWorkerClient): void {
              activeRunners.delete(runner);
              ensureStandbyRunner();
            },
          }
        : undefined;
      // The C# adapter is also its prepared provider. It remains private to
      // this lease; no direct-client capability crosses the host boundary.
      const preparedProvider = createCSharpRuntimeClient(
        worker,
        preparedAuthority
      );
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([['csharp', preparedProvider]]);
      const disposeLease = (): void => {
        if (disposed) return;
        // Set the terminal state before terminating workers so in-flight
        // release/failure continuations cannot create replacement capacity.
        disposed = true;
        standbyRunner = undefined;
        warmingRunner = undefined;
        worker.terminate();
        if (compiler !== worker) compiler.terminate();
        for (const runner of activeRunners) runner.terminate();
        activeRunners.clear();
      };

      return {
        preparedProviders,
        disposeLanguage: disposeLease,
        dispose: disposeLease,
      };
    },
  };
}
