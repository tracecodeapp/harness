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
import {
  CSharpWorkerClient,
  type CSharpPreparedRunnerTier,
} from './csharp-worker-client';

export interface CSharpBrowserRuntimeProviderOptions {
  /** Idle timeout for the trusted compiler authority. */
  compilerIdleTimeoutMs?: number;
  /** Idle timeout for a prewarmed, unused disposable Judge runner. */
  runnerIdleTimeoutMs?: number;
  /** Maximum disposable runner leases executing one eager Judge batch concurrently. */
  preparedBatchConcurrency?: number;
}

const FIREFOX_PREPARED_WORKER_IDLE_TIMEOUT_MS = 20_000;
const STANDBY_RETRY_INITIAL_DELAY_MS = 250;
const STANDBY_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_PREPARED_BATCH_CONCURRENCY = 4;
const MAX_PREPARED_BATCH_CONCURRENCY = 32;

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
      const preparedBatchConcurrency =
        options.preparedBatchConcurrency ?? DEFAULT_PREPARED_BATCH_CONCURRENCY;
      if (
        !Number.isSafeInteger(preparedBatchConcurrency) ||
        preparedBatchConcurrency < 1 ||
        preparedBatchConcurrency > MAX_PREPARED_BATCH_CONCURRENCY
      ) {
        throw new TypeError(
          `C# preparedBatchConcurrency must be an integer from 1 to ${MAX_PREPARED_BATCH_CONCURRENCY}.`
        );
      }
      const workerFactory = context.workerFactoryFor('csharp');
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
      if (generalManifestAsset && !manifestPublishesPreparedRoles) {
        throw new TypeError(
          'C# Judge requires compiler and runner assets in the runtime manifest.'
        );
      }
      // Firefox retained materially more process RSS after .NET worker warmup
      // in the C# spike. Preserve the prewarm needed for sub-second Judge runs,
      // but let unused prepared capacity retire sooner there. Explicit caller
      // settings always win.
      const firefoxPreparedIdleTimeoutMs = isFirefoxBrowser()
        ? FIREFOX_PREPARED_WORKER_IDLE_TIMEOUT_MS
        : undefined;
      const compilerIdleTimeoutMs =
        options.compilerIdleTimeoutMs ?? firefoxPreparedIdleTimeoutMs;
      const runnerIdleTimeoutMs =
        options.runnerIdleTimeoutMs ??
        firefoxPreparedIdleTimeoutMs;
      const dependencyUrls = (
        collection: 'compilerDependencies' | 'runnerDependencies'
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
      const compiler = new CSharpWorkerClient({
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
      const runnerEpochs = new WeakMap<CSharpWorkerClient, number>();
      let disposed = false;
      let capacityEpoch = 0;
      let standbyRetryDelayMs = STANDBY_RETRY_INITIAL_DELAY_MS;
      let standbyRetryTimer: ReturnType<typeof setTimeout> | undefined;
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
        runnerEpochs.set(runner, capacityEpoch);
        return runner;
      };
      let standbyRunner: CSharpWorkerClient | undefined;
      let warmingRunner: CSharpWorkerClient | undefined;
      let standbyWarmup: Promise<void> | undefined;
      let ensureStandbyRunner: () => Promise<void>;
      const clearStandbyRetry = (): void => {
        if (standbyRetryTimer !== undefined) {
          clearTimeout(standbyRetryTimer);
          standbyRetryTimer = undefined;
        }
      };
      const scheduleStandbyRetry = (epoch: number): void => {
        if (
          disposed ||
          epoch !== capacityEpoch ||
          standbyRetryTimer !== undefined
        ) {
          return;
        }
        const delayMs = standbyRetryDelayMs;
        standbyRetryDelayMs = Math.min(
          standbyRetryDelayMs * 2,
          STANDBY_RETRY_MAX_DELAY_MS
        );
        standbyRetryTimer = setTimeout(() => {
          standbyRetryTimer = undefined;
          if (!disposed && epoch === capacityEpoch) {
            void ensureStandbyRunner().catch(() => undefined);
          }
        }, delayMs);
      };
      const publishWarmedRunner = (runner: CSharpWorkerClient): void => {
        if (disposed || warmingRunner !== runner) return;
        warmingRunner = undefined;
        standbyRunner = runner;
        clearStandbyRetry();
        standbyRetryDelayMs = STANDBY_RETRY_INITIAL_DELAY_MS;
      };
      const retireWarmingRunner = (
        runner: CSharpWorkerClient,
        epoch: number
      ): void => {
        if (warmingRunner === runner) warmingRunner = undefined;
        activeRunners.delete(runner);
        runner.terminate();
        scheduleStandbyRetry(epoch);
      };
      const warmStandbyRunner = async (
        runner: CSharpWorkerClient,
        epoch: number
      ): Promise<void> => {
        await runner.warmup();
        // Ask the compiler client for its current warmup promise for every
        // replacement. CSharpWorkerClient clears a failed memo, so a transient
        // compiler failure must not remain sticky for the whole provider.
        const compilerReady = await compiler.warmup().then(
          (ready) => ready,
          () => undefined
        );
        if (!compilerReady) {
          // Compiler priming is an optimization for background replacement.
          // Explicit authority warmup separately awaits and reports compiler
          // failure, while this runtime-warm runner remains safe to lease.
          publishWarmedRunner(runner);
          return;
        }
        if (
          disposed ||
          epoch !== capacityEpoch ||
          warmingRunner !== runner
        ) {
          return;
        }
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
      };
      ensureStandbyRunner = (): Promise<void> => {
        if (disposed) {
          return Promise.reject(
            new Error('C# browser runtime provider has been disposed.')
          );
        }
        if (standbyRunner) {
          return Promise.resolve();
        }
        if (standbyWarmup) return standbyWarmup;
        const runner = createRunnerClient();
        const epoch = capacityEpoch;
        warmingRunner = runner;
        let warmup: Promise<void>;
        warmup = warmStandbyRunner(runner, epoch)
          .catch((error) => {
            // A runner that attempted and failed trusted priming is never
            // learner-bearing. Retire it and retry with bounded backoff.
            retireWarmingRunner(runner, epoch);
            throw error;
          })
          .finally(() => {
            if (standbyWarmup === warmup) standbyWarmup = undefined;
          });
        standbyWarmup = warmup;
        return warmup;
      };
      const preparedAuthority = {
        compiler,
        batchConcurrency: preparedBatchConcurrency,
        async warmup(): Promise<{
          success: boolean;
          loadTimeMs: number;
        }> {
          const startedAt = performance.now();
          const [compilerReady] = await Promise.all([
            compiler.warmup(),
            ensureStandbyRunner(),
          ]);
          return {
            success: compilerReady.success,
            loadTimeMs: performance.now() - startedAt,
          };
        },
        createRunner(_tier: CSharpPreparedRunnerTier): CSharpWorkerClient {
          if (disposed) {
            throw new Error('C# browser runtime provider has been disposed.');
          }
          const runner = standbyRunner ?? createRunnerClient();
          if (runner === standbyRunner) standbyRunner = undefined;
          return runner;
        },
        releaseRunner(runner: CSharpWorkerClient): void {
          activeRunners.delete(runner);
          if (
            context.workerLifecyclePolicy === 'warm-and-retire' &&
            runnerEpochs.get(runner) === capacityEpoch
          ) {
            void ensureStandbyRunner().catch(() => undefined);
          }
        },
      };
      // The C# adapter is also its prepared provider. It remains private to
      // this lease; no direct-client capability crosses the host boundary.
      const preparedProvider = createCSharpRuntimeClient(
        compiler,
        preparedAuthority
      );
      const preparedProviders = new Map<
        Language,
        RuntimePreparedExecutionProvider
      >([['csharp', preparedProvider]]);
      const retireCapacity = (): void => {
        capacityEpoch += 1;
        clearStandbyRetry();
        standbyRetryDelayMs = STANDBY_RETRY_INITIAL_DELAY_MS;
        standbyRunner = undefined;
        warmingRunner = undefined;
        standbyWarmup = undefined;
        compiler.terminate();
        for (const runner of activeRunners) runner.terminate();
        activeRunners.clear();
      };
      const disposeLanguage = (): void => {
        if (disposed) return;
        retireCapacity();
      };
      const disposeLease = (): void => {
        if (disposed) return;
        // Set terminal state before terminating workers so in-flight
        // release/failure continuations cannot create replacement capacity.
        disposed = true;
        retireCapacity();
      };

      return {
        preparedProviders,
        disposeLanguage,
        dispose: disposeLease,
      };
    },
  };
}
