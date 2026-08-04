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
      // Firefox retained materially more process RSS after .NET worker warmup
      // in the C# spike. Preserve the prewarm needed for sub-second Judge runs,
      // but let unused prepared capacity retire sooner there. Explicit caller
      // settings always win.
      const preparedIdleTimeoutMs =
        options.workerIdleTimeoutMs ??
        (isFirefoxBrowser()
          ? FIREFOX_PREPARED_WORKER_IDLE_TIMEOUT_MS
          : undefined);
      const compilerIdleTimeoutMs =
        options.compilerIdleTimeoutMs ?? preparedIdleTimeoutMs;
      const runnerIdleTimeoutMs =
        options.runnerIdleTimeoutMs ?? preparedIdleTimeoutMs;
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
      const compiler = options.preparedAuthority === false
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
      const createRunnerClient = (): CSharpWorkerClient => {
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
      let standbyRunner =
        options.preparedAuthority === false ? undefined : createRunnerClient();
      const compilerWarmup =
        compiler === worker
          ? undefined
          : compiler.warmup();
      const warmStandbyRunner = (runner: CSharpWorkerClient): void => {
        const runnerLoad = runner.warmup();
        if (!compilerWarmup) {
          void runnerLoad.catch(() => undefined);
          return;
        }
        void Promise.all([compilerWarmup, runnerLoad])
          .then(async ([compilerReady]) => {
            // A leased runner is already owned by a submission. Never append
            // background work after learner execution.
            if (standbyRunner !== runner) return;
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
          })
          .catch(() => {
            if (standbyRunner !== runner) return;
            activeRunners.delete(runner);
            runner.terminate();
            const replacement = createRunnerClient();
            standbyRunner = replacement;
            // Fail soft to runtime-only prewarm. The learner path still
            // validates its own SHA-bound artifact before execution.
            void replacement.warmup().catch(() => undefined);
          });
      };
      if (standbyRunner) warmStandbyRunner(standbyRunner);
      const preparedAuthority = options.preparedAuthority === false
        ? undefined
        : {
            compiler,
            createRunner(): CSharpWorkerClient {
              const runner = standbyRunner ?? createRunnerClient();
              standbyRunner = undefined;
              return runner;
            },
            releaseRunner(runner: CSharpWorkerClient): void {
              activeRunners.delete(runner);
              if (!standbyRunner) {
                standbyRunner = createRunnerClient();
                warmStandbyRunner(standbyRunner);
              }
            },
          };
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

      return {
        preparedProviders,
        disposeLanguage: () => {
          worker.terminate();
          if (compiler !== worker) compiler.terminate();
          for (const runner of activeRunners) runner.terminate();
          activeRunners.clear();
          standbyRunner = undefined;
        },
        dispose: () => {
          worker.terminate();
          if (compiler !== worker) compiler.terminate();
          for (const runner of activeRunners) runner.terminate();
          activeRunners.clear();
          standbyRunner = undefined;
        },
      };
    },
  };
}
