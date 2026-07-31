import {
  TraceJVMWorkerClient,
  type TraceJVMWorkerHost,
  type TraceJVMWorkerLike,
} from '@tracecode/tracejvm';

import type {
  JavaProjectClientFactory,
} from './java-project';

export interface JavaProjectClientFactoryOptions {
  /**
   * Immutable browser Java runtime tree. The tree must contain the worker,
   * VM module, and supported runtime profiles expected by the Java engine.
   */
  readonly runtimeAssetBaseUrl?: string;
  readonly runtimeProfile?: 'core' | 'server' | 'spring-server';
}

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim() || '/tracejvm';
  return baseUrl.replace(/\/+$/u, '');
}

function createWorker(workerUrl: string): TraceJVMWorkerLike {
  return new Worker(workerUrl, {
    type: 'module',
    name: 'tracejvm-project-process',
  }) as unknown as TraceJVMWorkerLike;
}

/**
 * Creates the process-scoped browser Java client factory used by TraceKernel.
 *
 * The factory deliberately creates a fresh Worker client for every admitted
 * javac/java invocation. Runtime artifacts remain browser-cacheable, while VM
 * state and learner authority never cross a process boundary.
 */
export function createJavaProjectClientFactory(
  options: JavaProjectClientFactoryOptions = {}
): JavaProjectClientFactory {
  const runtimeAssetBaseUrl = normalizeBaseUrl(options.runtimeAssetBaseUrl);
  const workerUrl = `${runtimeAssetBaseUrl}/browser-worker.js`;

  return (context) =>
    new TraceJVMWorkerClient({
      engine: {
        assets: {
          runtimeProfileBaseUrls: {
            core: `${runtimeAssetBaseUrl}/profiles/core`,
            server: `${runtimeAssetBaseUrl}/profiles/server`,
            'spring-server': `${runtimeAssetBaseUrl}/profiles/spring-server`,
          },
          wasmUrl: `${runtimeAssetBaseUrl}/bjvm_main.wasm`,
        },
        workingDirectory: context.cwd,
        hostStandardDescriptors: context.hostStandardDescriptors,
        runtimeProfile: options.runtimeProfile ?? 'spring-server',
        retirementAfterExecutions: 1,
      },
      createWorker: () => createWorker(workerUrl),
      ...(context.host
        ? { host: context.host as unknown as TraceJVMWorkerHost }
        : {}),
    });
}
