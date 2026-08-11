import {
  TraceJVMCompilerWorkerClient,
  TraceJVMWorkerClient,
  type TraceJVMHostRequest,
  type TraceJVMWorkerHost,
  type TraceJVMWorkerLike,
} from '@tracecode/tracejvm';

import type {
  JavaProjectClient,
  JavaProjectClientContext,
  JavaProjectWorkerLike,
  ManagedJavaProjectClientFactory,
  JavaProjectRunRequest,
} from './java-project';
import {
  normalizeTraceJVMRuntimeAssetBaseUrl,
  resolveBuiltInTraceJVMRuntimeAssetBaseUrl,
} from './tracejvm-runtime-assets';

export { resolveBuiltInTraceJVMRuntimeAssetBaseUrl } from './tracejvm-runtime-assets';

export interface JavaProjectClientFactoryOptions {
  /**
   * Immutable browser Java runtime tree. The tree must contain the worker,
   * VM module, and supported runtime profiles expected by the Java engine.
   */
  readonly runtimeAssetBaseUrl?: string;
  /**
   * Same-origin TraceJVM Worker entrypoint. Runtime payloads may use a separate
   * immutable CDN base, but browsers do not permit constructing a Worker from
   * that cross-origin URL.
   */
  readonly workerUrl?: string;
  readonly runtimeProfile?: 'core' | 'server' | 'spring-server';
  /**
   * Worker construction seam for browser hosts and lifecycle conformance tests.
   * The factory still owns and retires the returned Worker.
   */
  readonly createWorker?: (
    workerUrl: string,
    role: 'compiler' | 'runner'
  ) => JavaProjectWorkerLike;
}

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = value ?? resolveBuiltInTraceJVMRuntimeAssetBaseUrl();
  return normalizeTraceJVMRuntimeAssetBaseUrl(baseUrl);
}

function createWorker(
  workerUrl: string,
  role: 'compiler' | 'runner'
): TraceJVMWorkerLike {
  return new Worker(workerUrl, {
    type: 'module',
    name: `tracejvm-project-${role}`,
  }) as unknown as TraceJVMWorkerLike;
}

const unavailableHost: TraceJVMWorkerHost = Object.freeze({
  dispatch(request: TraceJVMHostRequest) {
    throw Object.assign(
      new Error(
        `TraceJVM host service is unavailable: ${request.service}.${request.operation}`
      ),
      { name: 'ENOSYS' }
    );
  },
});

class TraceJVMProjectClient implements JavaProjectClient {
  private runner: TraceJVMWorkerClient | undefined;

  constructor(
    private readonly compilerHost: TraceJVMCompilerWorkerClient,
    private readonly createRunner: () => TraceJVMWorkerClient
  ) {}

  initialize(signal?: AbortSignal): Promise<{ initializeMs: number }> {
    return this.compilerHost.initialize(signal);
  }

  compile: JavaProjectClient['compile'] = async (request) => {
    const result = await this.compilerHost.compile(request);
    return {
      ...result,
      timings: {
        runtimeInitMs: result.timings.compilerInitMs,
        queueMs: result.timings.queueMs,
        compileAndRunMs: result.timings.compileMs,
        totalMs: result.timings.totalMs,
      },
      isolation: {
        status: 'not-applicable',
        restored: [],
        taintReasons: [],
        hardBoundaryRecommended: false,
      },
      retirementRecommended: false,
    };
  };

  async run(request: JavaProjectRunRequest) {
    if (this.runner) {
      throw new Error('TraceJVM project client cannot admit a second Java process.');
    }
    const runner = this.createRunner();
    this.runner = runner;
    return runner.run(request);
  }

  terminate(): void {
    this.runner?.terminate();
    this.runner = undefined;
  }
}

/**
 * Creates the process-scoped browser Java client factory used by TraceKernel.
 *
 * One factory owns one warm compiler host Worker. Each admitted `java`
 * invocation receives a disposable runner Worker and process-bound TraceKernel
 * host channel; `javac` uses only the persistent compiler. Learner VM state,
 * kernel authority, cancellation, and native failures therefore never cross a
 * process boundary, while compiler initialization is amortized across commands.
 */
export function createJavaProjectClientFactory(
  options: JavaProjectClientFactoryOptions = {}
): ManagedJavaProjectClientFactory {
  const runtimeAssetBaseUrl = normalizeBaseUrl(options.runtimeAssetBaseUrl);
  const workerUrl = normalizeTraceJVMRuntimeAssetBaseUrl(
    options.workerUrl ?? `${runtimeAssetBaseUrl}/browser-worker.js`
  );
  const workerFor = (role: 'compiler' | 'runner'): TraceJVMWorkerLike =>
    (options.createWorker?.(workerUrl, role) as
      | TraceJVMWorkerLike
      | undefined) ?? createWorker(workerUrl, role);
  const runtimeProfile = options.runtimeProfile ?? 'spring-server';
  const runtimeProfileBaseUrls = {
    core: `${runtimeAssetBaseUrl}/profiles/core`,
    server: `${runtimeAssetBaseUrl}/profiles/server`,
    'spring-server': `${runtimeAssetBaseUrl}/profiles/spring-server`,
  } as const;
  if (!(runtimeProfile in runtimeProfileBaseUrls)) {
    throw new TypeError(
      `Unsupported TraceJVM runtime profile: ${String(runtimeProfile)}`
    );
  }
  const compilerHost = new TraceJVMCompilerWorkerClient({
    compiler: {
      assets: {
        baseUrl: `${runtimeAssetBaseUrl}/compiler`,
      },
      platformArchiveUrl: `${runtimeProfileBaseUrls[runtimeProfile]}/jdk23.jar`,
      platformClasspath: [{
        path: 'tracekernel-api.jar',
        url: `${runtimeProfileBaseUrls[runtimeProfile]}/tracekernel-api.jar`,
      }],
    },
    createWorker: () => workerFor('compiler'),
  });

  return Object.assign(
    (context: JavaProjectClientContext) =>
      new TraceJVMProjectClient(
        compilerHost,
        () =>
          new TraceJVMWorkerClient({
            engine: {
              assets: {
                runtimeProfileBaseUrls,
                wasmUrl: `${runtimeAssetBaseUrl}/bjvm_main.wasm`,
              },
              workingDirectory: context.cwd,
              hostStandardDescriptors: context.hostStandardDescriptors,
              runtimeProfile,
              retirementAfterExecutions: 1,
            },
            createWorker: () => workerFor('runner'),
            host:
              (context.host as unknown as TraceJVMWorkerHost | undefined) ??
              unavailableHost,
          })
      ),
    {
      terminate() {
        compilerHost.terminate();
      },
    }
  );
}
