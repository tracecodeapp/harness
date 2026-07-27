import type {
  Language,
  RuntimeProjectEngineLeaseController,
  RuntimeWorkspace,
} from '@tracecode/harness-core';
import type { CreateRuntimeWorkspaceOptions } from '../../harness-project/src/index';
import type {
  BrowserJavaScriptProjectRunnerOptions,
  BrowserTypeScriptProjectRunnerOptions,
} from '../../harness-javascript/src/project-browser';
import type { CSharpWorkerClient, CSharpWorkerClientOptions } from './csharp-worker-client';
import type { CppWorkerClient, CppWorkerClientOptions } from './cpp-worker-client';
import type { JavaWorkerClient, JavaWorkerClientOptions } from './java-worker-client';
import type { TraceJVMProjectRunnerOptions } from '../../harness-java/src/tracejvm-project';
import { runJavaSafeStorageExclusive } from './java-storage-isolation';
import type { PythonWorkerClient, PythonWorkerClientOptions } from './pyodide-worker-client';
import {
  resolveBrowserHarnessAssets,
  type BrowserRuntimeAssetDescriptor,
  type BrowserHarnessAssetOverrides,
} from './runtime-assets';
import { createBrowserRuntimeAssetPreflight } from './runtime-asset-preflight';
import {
  createBrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHostOptions,
} from './execution-host';
import {
  bindBrowserKernelStorage,
  hydrateBrowserKernelStorage,
  persistInitialBrowserKernelSnapshot,
  type BrowserKernelStorage,
  type BrowserKernelStorageBinding,
} from './kernel-storage';

export {
  createIndexedDbKernelStorage,
  type BrowserKernelStorage,
  type BrowserKernelStorageBinding,
  type BrowserKernelStorageSnapshot,
  type IndexedDbKernelStorageOptions,
} from './kernel-storage';
export {
  runtimeHttpBodyBytes,
  runtimeHttpBodyFromBytes,
  runtimeHttpBodyFromText,
  runtimeHttpBodyText,
  runtimeHttpRequestBytes,
  runtimeHttpRequestText,
  runtimeHttpResponseBytes,
  runtimeHttpResponseText,
} from '@tracecode/harness-core';
export {
  BROWSER_EXECUTION_HOST_PROTOCOL,
  createBrowserExecutionWorkerHost,
  installBrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHostOptions,
  type InstallBrowserExecutionWorkerHostOptions,
} from './execution-host';

export type BrowserProjectWorkspace = RuntimeWorkspace;
export type BrowserProjectNodeOptions = Omit<BrowserJavaScriptProjectRunnerOptions, 'applyFileChange'>;
export type BrowserProjectTypeScriptOptions = BrowserTypeScriptProjectRunnerOptions;
export type BrowserProjectWorkerIsolation = 'shared' | 'per-command';
export type BrowserProjectJavaLifecycle = 'workspace-session' | 'per-command';
export type BrowserProjectProvider = Language;
export interface BrowserProjectExecutionHostOptions extends BrowserExecutionWorkerHostOptions {
  /** Providers routed through this host. Defaults to Java for compatibility with the 0.10 contract. */
  providers?: readonly BrowserProjectProvider[];
  /** Heavy Java runtime lifecycle inside the provider-neutral host. Defaults to workspace-session. */
  javaLifecycle?: BrowserProjectJavaLifecycle;
}
export interface BrowserProjectWorkerPrewarmOptions {
  /** Ready/idle clean Python workers (0-2); active leases may coexist with their replacements. */
  python?: number;
  /** One clean JavaScript project worker prepared for the next command (0-1). */
  javascript?: number;
  /** Trusted TypeScript compiler loaded in the background (0-1). */
  typescript?: number;
  /** Ready/idle clean Java workers (0-2); active leases may coexist with their replacements. */
  java?: number;
  /** Ready/idle clean C# workers (0-2); active leases may coexist with their replacements. */
  csharp?: number;
  /** Ready/idle clean C++ workers (0-2); active leases may coexist with their replacements. */
  cpp?: number;
}

function policySessionFiles(options: CreateRuntimeWorkspaceOptions): NonNullable<CreateRuntimeWorkspaceOptions['projectSession']>['files'] {
  return (options.projectSession?.files ?? [])
    .filter((file) => file.hidden === true || file.readonly === true);
}

function browserAssetUrlsEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const documentBase = globalThis.location?.href;
  if (!documentBase) return false;
  try {
    return new URL(left, documentBase).href === new URL(right, documentBase).href;
  } catch {
    return false;
  }
}

function assertManifestBoundProjectAsset(
  runtime: 'javascript' | 'typescript',
  optionName: string,
  override: string | undefined,
  manifestUrl: string,
  hasManifest: boolean
): void {
  if (!hasManifest || override === undefined || browserAssetUrlsEqual(override, manifestUrl)) return;
  throw new TypeError(
    `Browser project runtime "${runtime}" cannot override ${optionName} while its runtime manifest is active ` +
      `(manifest: ${JSON.stringify(manifestUrl)}, override: ${JSON.stringify(override)}).`
  );
}

interface PrewarmableProjectWorker {
  warmup(): Promise<unknown>;
  terminate(): void;
}

interface OneShotPrewarmedWorkerPool<Client extends PrewarmableProjectWorker> {
  run<Result>(
    signal: AbortSignal | undefined,
    engineLease: RuntimeProjectEngineLeaseController | undefined,
    execute: (client: Client) => Promise<Result>
  ): Promise<Result>;
  terminate(): void;
}

interface OneShotPoolEntry<Client extends PrewarmableProjectWorker> {
  client: Client;
  generation: number;
  token: number;
  state: 'warming' | 'idle' | 'leased' | 'retired';
}

interface KernelRetainedPoolBinding<Client extends PrewarmableProjectWorker> {
  readonly ready: Promise<OneShotPoolEntry<Client>>;
  tail: Promise<void>;
  released: boolean;
}

interface OneShotWarmOutcome {
  success: boolean;
  error?: Error;
}

const MAX_PROJECT_PREWARM_DEPTH_PER_LANGUAGE = 2;
const MAX_PROJECT_PREWARM_DEPTH_TOTAL = 6;
const PROJECT_PREWARM_RETRY_LIMIT = 2;
const BROWSER_PROJECT_PROVIDERS: readonly BrowserProjectProvider[] = Object.freeze([
  'python',
  'javascript',
  'typescript',
  'java',
  'csharp',
  'cpp',
]);

function normalizeBrowserProjectProviders(
  providers: readonly BrowserProjectProvider[] | undefined
): readonly BrowserProjectProvider[] {
  const normalized: BrowserProjectProvider[] = [];
  for (const provider of providers ?? BROWSER_PROJECT_PROVIDERS) {
    if (!BROWSER_PROJECT_PROVIDERS.includes(provider)) {
      throw new TypeError(`Browser project provider ${JSON.stringify(provider)} is not supported.`);
    }
    if (!normalized.includes(provider)) normalized.push(provider);
  }
  return Object.freeze(normalized);
}

function normalizeProjectWorkerPrewarm(
  value: BrowserProjectWorkerPrewarmOptions | undefined
): Required<BrowserProjectWorkerPrewarmOptions> {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new TypeError('projectWorkerPrewarm must be an object when provided.');
  }
  const normalized = {
    python: value?.python ?? 0,
    javascript: value?.javascript ?? 0,
    typescript: value?.typescript ?? 0,
    java: value?.java ?? 0,
    csharp: value?.csharp ?? 0,
    cpp: value?.cpp ?? 0,
  };
  for (const [language, depth] of Object.entries(normalized)) {
    const maxDepth = language === 'javascript' || language === 'typescript'
      ? 1
      : MAX_PROJECT_PREWARM_DEPTH_PER_LANGUAGE;
    if (!Number.isInteger(depth) || depth < 0 || depth > maxDepth) {
      throw new TypeError(
        `projectWorkerPrewarm.${language} must be an integer from 0 to ${maxDepth}.`
      );
    }
  }
  const total = Object.values(normalized).reduce((sum, depth) => sum + depth, 0);
  if (total > MAX_PROJECT_PREWARM_DEPTH_TOTAL) {
    throw new TypeError(
      `projectWorkerPrewarm total depth must not exceed ${MAX_PROJECT_PREWARM_DEPTH_TOTAL}; received ${total}.`
    );
  }
  return normalized;
}

function projectPoolAbortError(): Error {
  return Object.assign(new Error('Project worker lease was aborted.'), { name: 'AbortError' });
}

function createOneShotPrewarmedWorkerPool<Client extends PrewarmableProjectWorker>(
  label: string,
  depth: number,
  createClient: () => Client,
  options: {
    /**
     * Keeps the trusted outer client attached to one kernel PID across repeated
     * provider invocations. The client remains process-owned and is retired by
     * the kernel lease; only clients that provide their own disposable user-code
     * execution boundary may opt in.
     */
    retainClientForKernelLease?: boolean;
  } = {}
): OneShotPrewarmedWorkerPool<Client> {
  let generation = 1;
  let nextToken = 0;
  let refillEnabled = true;
  const entries = new Map<number, OneShotPoolEntry<Client>>();
  const idle: Array<OneShotPoolEntry<Client>> = [];
  const warming = new Map<number, Promise<OneShotWarmOutcome>>();
  const active = new Map<number, OneShotPoolEntry<Client>>();
  const kernelBindings = new WeakMap<
    RuntimeProjectEngineLeaseController,
    KernelRetainedPoolBinding<Client>
  >();

  const retire = (entry: OneShotPoolEntry<Client>) => {
    if (entry.state === 'retired') return;
    entry.state = 'retired';
    entries.delete(entry.token);
    active.delete(entry.token);
    try {
      entry.client.terminate();
    } catch {
      // Retirement is best-effort after the client has already failed.
    }
  };

  const warmNewClient = (signal?: AbortSignal): Promise<OneShotWarmOutcome> => {
    const entry: OneShotPoolEntry<Client> = {
      client: createClient(),
      generation,
      token: ++nextToken,
      state: 'warming',
    };
    entries.set(entry.token, entry);
    const promise = (async (): Promise<OneShotWarmOutcome> => {
      const onAbort = () => retire(entry);
      try {
        if (signal?.aborted) {
          retire(entry);
          return { success: false, error: projectPoolAbortError() };
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        await entry.client.warmup();
        if (!refillEnabled || entry.generation !== generation || entry.state !== 'warming') {
          retire(entry);
          return { success: false, error: new Error(`${label} prewarmed worker was retired before lease.`) };
        }
        entry.state = 'idle';
        idle.push(entry);
        return { success: true };
      } catch (error) {
        const warmError = error instanceof Error ? error : new Error(String(error));
        retire(entry);
        return { success: false, error: warmError };
      } finally {
        signal?.removeEventListener('abort', onAbort);
        warming.delete(entry.token);
      }
    })();
    warming.set(entry.token, promise);
    return promise;
  };

  const idleCount = () => idle.reduce(
    (count, entry) => count + (entry.state === 'idle' && entry.generation === generation ? 1 : 0),
    0
  );

  const refill = () => {
    if (!refillEnabled || depth === 0) return;
    while (idleCount() + warming.size < depth) {
      void warmNewClient();
    }
  };

  const waitForWarmup = async (signal?: AbortSignal): Promise<OneShotWarmOutcome> => {
    const nextWarmup = Promise.race(Array.from(warming.values()));
    if (!signal) return nextWarmup;
    if (signal.aborted) throw projectPoolAbortError();
    return new Promise<OneShotWarmOutcome>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(projectPoolAbortError());
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      nextWarmup.then(
        (outcome) => {
          cleanup();
          resolve(outcome);
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
    });
  };

  const acquire = async (
    expectedGeneration: number,
    signal?: AbortSignal
  ): Promise<OneShotPoolEntry<Client>> => {
    let lastWarmError: Error | undefined;
    let directWarmAttempts = 0;
    for (;;) {
      if (expectedGeneration !== generation) {
        throw new Error(`${label} project worker acquisition was retired before lease.`);
      }
      if (signal?.aborted) throw projectPoolAbortError();
      let entry = idle.shift();
      while (entry && (entry.state !== 'idle' || entry.generation !== generation)) {
        if (entry.state !== 'retired') retire(entry);
        entry = idle.shift();
      }
      if (entry) {
        entry.state = 'leased';
        active.set(entry.token, entry);
        refill();
        return entry;
      }
      if (warming.size > 0) {
        const outcome = await waitForWarmup(signal);
        if (!outcome.success) lastWarmError = outcome.error;
        continue;
      }
      if (directWarmAttempts >= PROJECT_PREWARM_RETRY_LIMIT) {
        throw new Error(
          `${label} project worker failed to warm after ${PROJECT_PREWARM_RETRY_LIMIT} fresh attempts.`,
          lastWarmError ? { cause: lastWarmError } : undefined
        );
      }
      directWarmAttempts += 1;
      const outcome = await warmNewClient(signal);
      if (!outcome.success) lastWarmError = outcome.error;
    }
  };

  refill();

  const executeWithEntry = async <Result>(
    entry: OneShotPoolEntry<Client>,
    leaseGeneration: number,
    signal: AbortSignal | undefined,
    execute: (client: Client) => Promise<Result>
  ): Promise<Result> => {
    const onAbort = () => retire(entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) {
        retire(entry);
        throw projectPoolAbortError();
      }
      const result = await execute(entry.client);
      if (
        leaseGeneration !== generation ||
        entry.state !== 'leased' ||
        active.get(entry.token) !== entry
      ) {
        throw new Error(`${label} project worker lease was retired before its result settled.`);
      }
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const runWithKernelRetainedClient = async <Result>(
    signal: AbortSignal | undefined,
    engineLease: RuntimeProjectEngineLeaseController,
    execute: (client: Client) => Promise<Result>
  ): Promise<Result> => {
    let binding = kernelBindings.get(engineLease);
    if (!binding) {
      const leaseGeneration = generation;
      let resolveReady!: (entry: OneShotPoolEntry<Client>) => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<OneShotPoolEntry<Client>>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      binding = {
        ready,
        tail: Promise.resolve(),
        released: false,
      };
      kernelBindings.set(engineLease, binding);
      const createdBinding = binding;
      void (async () => {
        let entry: OneShotPoolEntry<Client> | undefined;
        try {
          entry = await acquire(leaseGeneration, signal);
          if (createdBinding.released) {
            retire(entry);
            throw new Error(`${label} project worker lease was released before attachment.`);
          }
          engineLease.attach({
            release: () => {
              createdBinding.released = true;
              if (kernelBindings.get(engineLease) === createdBinding) {
                kernelBindings.delete(engineLease);
              }
              retire(entry!);
              refill();
            },
          });
          resolveReady(entry);
        } catch (error) {
          createdBinding.released = true;
          if (kernelBindings.get(engineLease) === createdBinding) {
            kernelBindings.delete(engineLease);
          }
          if (entry) retire(entry);
          rejectReady(error);
        }
      })();
    }

    const retainedBinding = binding;
    const leaseGeneration = generation;
    const run = retainedBinding.tail.then(async () => {
      const entry = await retainedBinding.ready;
      if (retainedBinding.released) {
        throw new Error(`${label} project worker lease was released before execution.`);
      }
      return executeWithEntry(entry, leaseGeneration, signal, execute);
    });
    retainedBinding.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  return {
    async run<Result>(
      signal: AbortSignal | undefined,
      engineLease: RuntimeProjectEngineLeaseController | undefined,
      execute: (client: Client) => Promise<Result>
    ): Promise<Result> {
      refillEnabled = true;
      refill();
      if (engineLease && options.retainClientForKernelLease) {
        return runWithKernelRetainedClient(signal, engineLease, execute);
      }
      const leaseGeneration = generation;
      const entry = await acquire(leaseGeneration, signal);
      let attachedToKernel = false;
      try {
        if (engineLease) {
          engineLease.attach({
            release: () => {
              retire(entry);
              refill();
            },
          });
          attachedToKernel = true;
        }
        return await executeWithEntry(entry, leaseGeneration, signal, execute);
      } finally {
        if (!attachedToKernel) {
          retire(entry);
          refill();
        }
      }
    },
    terminate() {
      refillEnabled = false;
      generation += 1;
      for (const entry of Array.from(entries.values())) retire(entry);
      idle.length = 0;
      warming.clear();
      active.clear();
    },
  };
}

function createPerCommandPythonWorkerClient(
  prewarmDepth: number,
  createClient: () => PythonWorkerClient
): Pick<PythonWorkerClient, 'executeProjectPython' | 'terminate'> {
  const pool = createOneShotPrewarmedWorkerPool('Python', prewarmDepth, createClient);
  return {
    async executeProjectPython(request, timeoutMs, onEvent, signal, engineLease) {
      return pool.run(signal, engineLease, (client) =>
        client.executeProjectPython(request, timeoutMs, onEvent, signal)
      );
    },
    terminate() {
      pool.terminate();
    },
  };
}

function createPerCommandJavaWorkerClient(
  prewarmDepth: number,
  createClient: () => JavaWorkerClient,
  validateRuntimeAssets?: () => void
): Pick<JavaWorkerClient, 'executeProjectJava' | 'terminate'> {
  const pool = createOneShotPrewarmedWorkerPool('Java', prewarmDepth, createClient);
  return {
    async executeProjectJava(request, timeoutMs, onEvent, signal) {
      validateRuntimeAssets?.();
      return runJavaSafeStorageExclusive(() =>
        pool.run(signal, undefined, async (client) => {
          await client.resetPersistentStorage();
          return client.executeProjectJava(request, timeoutMs, onEvent, signal);
        })
      );
    },
    terminate() {
      pool.terminate();
    },
  };
}

function waitForProjectWarmup(
  warmup: Promise<unknown>,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) return warmup.then(() => undefined);
  if (signal.aborted) return Promise.reject(projectPoolAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(projectPoolAbortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    warmup.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

/**
 * Starts the expensive hosted Java runtime in the background while preserving one
 * readiness promise for commands that arrive before it is ready. A failed warmup is
 * evicted so the next command can make one fresh attempt through JavaWorkerClient's
 * existing reset/retry path.
 */
function createBackgroundPrewarmedJavaWorkerClient(
  client: JavaWorkerClient,
  beforeWarmup: () => Promise<void>
): Pick<JavaWorkerClient, 'executeProjectJava' | 'terminate'> {
  let disposed = false;
  let warmupPromise: Promise<unknown> | null = null;
  const warm = (): Promise<unknown> => {
    if (disposed) return Promise.reject(new Error('Java project worker was terminated.'));
    if (warmupPromise) return warmupPromise;
    const attempt = beforeWarmup().then(() => client.warmup());
    const observedAttempt = attempt.catch((error) => {
      if (warmupPromise === observedAttempt) warmupPromise = null;
      throw error;
    });
    warmupPromise = observedAttempt;
    // Background rejection is intentionally observed here. A command awaiting the
    // same promise still receives the failure, and a later command may retry.
    void warmupPromise.catch(() => undefined);
    return warmupPromise;
  };

  warm();

  return {
    async executeProjectJava(request, timeoutMs, onEvent, signal) {
      await waitForProjectWarmup(warm(), signal);
      return client.executeProjectJava(request, timeoutMs, onEvent, signal);
    },
    terminate() {
      disposed = true;
      client.terminate();
    },
  };
}

function createPerCommandCSharpWorkerClient(
  prewarmDepth: number,
  createClient: () => CSharpWorkerClient
): Pick<CSharpWorkerClient, 'executeProjectCSharp' | 'terminate'> {
  const pool = createOneShotPrewarmedWorkerPool('C#', prewarmDepth, createClient);
  return {
    async executeProjectCSharp(request, timeoutMs, onEvent, signal, engineLease) {
      return pool.run(signal, engineLease, (client) =>
        client.executeProjectCSharp(request, timeoutMs, onEvent, signal)
      );
    },
    terminate() {
      pool.terminate();
    },
  };
}

function createPerCommandCppWorkerClient(
  prewarmDepth: number,
  createClient: () => CppWorkerClient
): Pick<CppWorkerClient, 'executeProjectCpp' | 'terminate'> {
  const pool = createOneShotPrewarmedWorkerPool('C++', prewarmDepth, createClient, {
    retainClientForKernelLease: true,
  });
  return {
    async executeProjectCpp(request, timeoutMs, onEvent, signal, engineLease) {
      return pool.run(signal, engineLease, (client) =>
        client.executeProjectCpp(request, timeoutMs, onEvent, signal)
      );
    },
    terminate() {
      pool.terminate();
    },
  };
}

export interface CreateBrowserProjectWorkspaceOptions
  extends Omit<CreateRuntimeWorkspaceOptions, 'pythonRunner' | 'nodeRunner' | 'javaRunner' | 'csharpRunner' | 'cppRunner'> {
  assetBaseUrl?: string;
  assets?: BrowserHarnessAssetOverrides;
  /** Runtime providers assembled into this workspace. Defaults to every browser provider. */
  providers?: readonly BrowserProjectProvider[];
  debug?: boolean;
  pythonWorkerClient?: Pick<PythonWorkerClient, 'executeProjectPython' | 'terminate'>;
  javaWorkerClient?: Pick<JavaWorkerClient, 'executeProjectJava' | 'terminate'>;
  /**
   * Default-off Java 23 provider. Each factory result is admitted to exactly
   * one javac/java invocation and hard-retired by the TraceKernel adapter.
   */
  traceJVM?: Omit<TraceJVMProjectRunnerOptions, 'applyFileChange'>;
  csharpWorkerClient?: Pick<CSharpWorkerClient, 'executeProjectCSharp' | 'terminate'>;
  cppWorkerClient?: Pick<CppWorkerClient, 'executeProjectCpp' | 'terminate'>;
  /** Runs selected project workers on a dedicated, credential-free origin. */
  executionHost?: BrowserProjectExecutionHostOptions;
  nodeProject?: BrowserProjectNodeOptions;
  typescriptProject?: BrowserProjectTypeScriptOptions;
  projectWorkerIsolation?: BrowserProjectWorkerIsolation;
  /** Required when reusing any language worker across untrusted project commands. */
  trustedSharedWorkerReuse?: true;
  /** Opt-in clean one-shot worker depth; disabled for every language by default. */
  projectWorkerPrewarm?: BrowserProjectWorkerPrewarmOptions;
  nodeProjectTimeoutMs?: number;
  pythonProjectTimeoutMs?: number;
  javaProjectTimeoutMs?: number;
  csharpProjectTimeoutMs?: number;
  cppProjectTimeoutMs?: number;
  javaWorkerIdleTimeoutMs?: number;
  javaCompileCacheLimit?: number;
  csharpWorkerIdleTimeoutMs?: number;
  cppWorkerIdleTimeoutMs?: number;
  kernelStorage?: BrowserKernelStorage;
  onKernelStorageError?: (error: Error) => void;
}

export async function createBrowserProjectWorkspace(
  options: CreateBrowserProjectWorkspaceOptions = {}
): Promise<BrowserProjectWorkspace> {
  const projectRuntimePromise = import('../../harness-project/src/index');
  const providers = normalizeBrowserProjectProviders(options.providers);
  const hasProvider = (provider: BrowserProjectProvider) => providers.includes(provider);
  const [pythonProvider, javascriptProvider, javaProvider, csharpProvider, cppProvider] = await Promise.all([
    hasProvider('python')
      ? Promise.all([
          import('../../harness-python/src/project-browser'),
          import('./pyodide-worker-client'),
        ])
      : undefined,
    hasProvider('javascript') || hasProvider('typescript')
      ? import('../../harness-javascript/src/project-browser')
      : undefined,
    hasProvider('java')
      ? Promise.all([
          import('../../harness-java/src/project-browser'),
          import('./java-worker-client'),
          import('../../harness-java/src/tracejvm-project'),
        ])
      : undefined,
    hasProvider('csharp')
      ? Promise.all([
          import('../../harness-csharp/src/project-browser'),
          import('./csharp-worker-client'),
        ])
      : undefined,
    hasProvider('cpp')
      ? Promise.all([
          import('../../harness-cpp/src/project-browser'),
          import('./cpp-worker-client'),
        ])
      : undefined,
  ]);
  const { createRuntimeWorkspace } = await projectRuntimePromise;
  const assets = resolveBrowserHarnessAssets(options);
  const runtimeAssetPreflight = createBrowserRuntimeAssetPreflight(assets.runtimeManifests);
  const pythonManifest = assets.runtimeManifests?.python;
  const pythonAsset = (name: string): BrowserRuntimeAssetDescriptor | undefined => {
    const value = (pythonManifest?.assets as Record<string, unknown> | undefined)?.[name];
    return value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string'
      ? value as BrowserRuntimeAssetDescriptor
      : undefined;
  };
  const pythonPackageDescriptors = (() => {
    const value = (pythonManifest?.assets as Record<string, unknown> | undefined)?.packages;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Readonly<Record<string, BrowserRuntimeAssetDescriptor>>
      : undefined;
  })();
  const manifestAsset = (
    runtime: 'javascript' | 'typescript' | 'java' | 'csharp',
    name: string
  ): BrowserRuntimeAssetDescriptor | undefined => {
    const manifest = assets.runtimeManifests?.[runtime];
    const value = (manifest?.assets as Record<string, unknown> | undefined)?.[name];
    return value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string'
      ? value as BrowserRuntimeAssetDescriptor
      : undefined;
  };
  const manifestAssetCollection = (
    runtime: 'csharp',
    name: string
  ): Readonly<Record<string, BrowserRuntimeAssetDescriptor>> | undefined => {
    const manifest = assets.runtimeManifests?.[runtime];
    const value = (manifest?.assets as Record<string, unknown> | undefined)?.[name];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Readonly<Record<string, BrowserRuntimeAssetDescriptor>>
      : undefined;
  };
  const javaManifest = assets.runtimeManifests?.java;
  const assertProjectJavaRuntimeAssets = (): void => {
    const requiredAssets = ['worker', 'loader', 'helperJar', 'compilerJar', 'rewriterJar', 'parserJar'] as const;
    const missingAssets = requiredAssets.filter((name) => {
      if (name === 'worker') {
        const value = (javaManifest?.assets as Record<string, unknown> | undefined)?.worker;
        return !(value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string');
      }
      return !manifestAsset('java', name);
    });
    if (missingAssets.length === 0) return;
    throw new Error(
      'Browser project Java is unavailable because CheerpJ is not vendored. ' +
        'Configure assets.runtimeManifests.java with worker, loader, helperJar, compilerJar, rewriterJar, and parserJar, ' +
        `or provide javaWorkerClient. Missing: ${missingAssets.join(', ')}.`
    );
  };
  const csharpDependencyDescriptors = manifestAssetCollection('csharp', 'dependencies');
  const {
    assetBaseUrl: _assetBaseUrl,
    assets: _assets,
    providers: _providers,
    debug,
    pythonWorkerClient: providedPythonWorkerClient,
    javaWorkerClient: providedJavaWorkerClient,
    traceJVM,
    csharpWorkerClient: providedCSharpWorkerClient,
    cppWorkerClient: providedCppWorkerClient,
    executionHost: executionHostOptions,
    nodeProject,
    typescriptProject,
    projectWorkerIsolation = 'per-command',
    trustedSharedWorkerReuse,
    projectWorkerPrewarm,
    nodeProjectTimeoutMs,
    pythonProjectTimeoutMs,
    javaProjectTimeoutMs,
    csharpProjectTimeoutMs,
    cppProjectTimeoutMs,
    javaWorkerIdleTimeoutMs,
    javaCompileCacheLimit,
    csharpWorkerIdleTimeoutMs,
    cppWorkerIdleTimeoutMs,
    kernelStorage,
    onKernelStorageError,
    ...workspaceOptions
  } = options;
  const requestedExecutionHostProviders = executionHostOptions
    ? normalizeBrowserProjectProviders(
        executionHostOptions.providers ?? (hasProvider('java') ? ['java'] : [])
      )
    : [];
  if (executionHostOptions && requestedExecutionHostProviders.length === 0) {
    throw new TypeError(
      'executionHost.providers must select at least one project provider when Java is not selected.'
    );
  }
  for (const provider of requestedExecutionHostProviders) {
    if (!hasProvider(provider)) {
      throw new TypeError(
        `executionHost provider ${JSON.stringify(provider)} is not selected by this browser project workspace.`
      );
    }
  }
  const executionHostProviders = new Set<BrowserProjectProvider>(requestedExecutionHostProviders);
  // TypeScript project commands compile in the trusted page and execute through
  // the JavaScript project worker. Treat TypeScript as an alias for that physical
  // worker so the routing contract describes where user code actually runs.
  if (executionHostProviders.delete('typescript')) {
    if (!hasProvider('javascript')) {
      throw new TypeError(
        'executionHost provider "typescript" requires the "javascript" project provider that executes compiled output.'
      );
    }
    executionHostProviders.add('javascript');
  }
  const isExecutionHosted = (provider: BrowserProjectProvider): boolean =>
    executionHostProviders.has(provider);
  const providedClientSelections = [
    ['python', providedPythonWorkerClient],
    ['java', providedJavaWorkerClient],
    ['csharp', providedCSharpWorkerClient],
    ['cpp', providedCppWorkerClient],
  ] as const;
  for (const [provider, client] of providedClientSelections) {
    if (client && !hasProvider(provider)) {
      throw new Error(`${provider}WorkerClient requires providers to include ${JSON.stringify(provider)}.`);
    }
    if (client && isExecutionHosted(provider)) {
      throw new Error(
        `executionHost.providers cannot include ${JSON.stringify(provider)} when ${provider}WorkerClient is provided.`
      );
    }
  }
  if (traceJVM && !hasProvider('java')) {
    throw new Error('traceJVM requires providers to include "java".');
  }
  if (traceJVM && providedJavaWorkerClient) {
    throw new Error('traceJVM cannot be combined with javaWorkerClient.');
  }
  if (traceJVM && isExecutionHosted('java')) {
    throw new Error(
      'traceJVM cannot use the legacy Java executionHost route; createClient must own its Worker boundary.'
    );
  }
  const javaExecutionLifecycle = executionHostOptions?.javaLifecycle ?? 'workspace-session';
  if (javaExecutionLifecycle !== 'workspace-session' && javaExecutionLifecycle !== 'per-command') {
    throw new TypeError('executionHost.javaLifecycle must be "workspace-session" or "per-command".');
  }
  if (projectWorkerIsolation !== 'per-command' && projectWorkerIsolation !== 'shared') {
    throw new TypeError(
      `Invalid browser project worker isolation "${String(projectWorkerIsolation)}"; expected "per-command" or "shared".`
    );
  }
  if (projectWorkerIsolation === 'shared' && trustedSharedWorkerReuse !== true) {
    throw new Error(
      'Browser project shared worker reuse is trusted-only and requires trustedSharedWorkerReuse: true.'
    );
  }
  const projectPrewarm = normalizeProjectWorkerPrewarm(projectWorkerPrewarm);
  for (const provider of BROWSER_PROJECT_PROVIDERS) {
    if (projectPrewarm[provider] > 0 && !hasProvider(provider)) {
      throw new Error(`projectWorkerPrewarm.${provider} requires providers to include ${JSON.stringify(provider)}.`);
    }
  }
  if (
    projectWorkerIsolation !== 'per-command' &&
    Object.values(projectPrewarm).some((depth) => depth > 0)
  ) {
    throw new Error('projectWorkerPrewarm is only supported with per-command project worker isolation.');
  }
  if (providedPythonWorkerClient && projectPrewarm.python > 0) {
    throw new Error('projectWorkerPrewarm.python cannot be used with a provided pythonWorkerClient.');
  }
  if (providedJavaWorkerClient && projectPrewarm.java > 0) {
    throw new Error('projectWorkerPrewarm.java cannot be used with a provided javaWorkerClient.');
  }
  if (traceJVM && projectPrewarm.java > 0) {
    throw new Error(
      'projectWorkerPrewarm.java cannot be used with traceJVM; supply fresh prepared clients through traceJVM.createClient.'
    );
  }
  if (!providedJavaWorkerClient && !traceJVM && projectPrewarm.java > 0) {
    assertProjectJavaRuntimeAssets();
  }
  if (providedCSharpWorkerClient && projectPrewarm.csharp > 0) {
    throw new Error('projectWorkerPrewarm.csharp cannot be used with a provided csharpWorkerClient.');
  }
  if (providedCppWorkerClient && projectPrewarm.cpp > 0) {
    throw new Error('projectWorkerPrewarm.cpp cannot be used with a provided cppWorkerClient.');
  }
  if (
    executionHostOptions &&
    isExecutionHosted('java') &&
    javaExecutionLifecycle === 'workspace-session' &&
    projectPrewarm.java > 1
  ) {
    throw new Error('executionHost workspace-session Java prewarm depth must be 0 or 1.');
  }
  if (hasProvider('javascript')) {
    assertManifestBoundProjectAsset(
      'javascript',
      'nodeProject.workerUrl',
      nodeProject?.workerUrl,
      assets.javascriptProjectWorker,
      assets.runtimeManifests?.javascript !== undefined
    );
  }
  if (hasProvider('typescript')) {
    assertManifestBoundProjectAsset(
      'typescript',
      'typescriptProject.compilerUrl',
      typescriptProject?.compilerUrl,
      assets.typescriptCompiler,
      assets.runtimeManifests?.typescript !== undefined
    );
  }
  let executionHost: BrowserExecutionWorkerHost | undefined;
  let executionHostReady: Promise<void> | undefined;
  if (executionHostOptions) {
    executionHost = createBrowserExecutionWorkerHost(executionHostOptions);
    try {
      if (isExecutionHosted('java')) {
        const javaWorkerAsset = javaManifest?.assets.worker;
        if (!javaWorkerAsset) {
          throw new Error('executionHost requires a complete Java runtime manifest when Java is selected.');
        }
        const workerUrl = new URL(javaWorkerAsset.url, `${executionHost.origin}/`);
        if (workerUrl.origin !== executionHost.origin) {
          throw new Error(
            `Java manifest worker origin ${JSON.stringify(workerUrl.origin)} must match executionHost origin ${JSON.stringify(executionHost.origin)}.`
          );
        }
      }
      const hostedWorkerUrls = [
        ['python', assets.pythonWorker],
        ['javascript', assets.javascriptProjectWorker],
        ['csharp', assets.csharpWorker],
        ['cpp', assets.cppWorker],
      ] as const;
      for (const [runtime, configuredUrl] of hostedWorkerUrls) {
        if (!isExecutionHosted(runtime)) continue;
        const hostedWorkerUrl = new URL(configuredUrl, `${executionHost.origin}/`);
        if (hostedWorkerUrl.origin !== executionHost.origin) {
          throw new Error(
            `${runtime} worker origin ${JSON.stringify(hostedWorkerUrl.origin)} must match executionHost origin ${JSON.stringify(executionHost.origin)}.`
          );
        }
      }
      executionHostReady = executionHost.ready();
      void executionHostReady.catch(() => undefined);
    } catch (error) {
      executionHost.dispose();
      throw error;
    }
  }
  const ownedWorkers: Array<{ terminate(): void }> = [];
  try {
    const pythonWorkerOptions: PythonWorkerClientOptions = {
      workerUrl: assets.pythonWorker,
      ...(executionHost && isExecutionHosted('python') ? { workerFactory: executionHost.workerFactory } : {}),
      ...(projectWorkerIsolation === 'per-command'
        ? { projectUserAuthorityMode: 'permanent' as const }
        : {}),
      ...(pythonManifest?.workerFormat ? { workerFormat: pythonManifest.workerFormat } : {}),
      debug,
      assetPreflight: () => runtimeAssetPreflight.preflight('python', ['worker', 'snippets']),
      runtimeAssetPreflight: () => runtimeAssetPreflight.preflight('python', [
        'runtimeCore',
        'runtimeLoader',
        'runtimeIndex',
        'distribution',
        'packages',
      ]),
      runtimeAssets: {
        runtimeCoreUrl: assets.pythonRuntimeCore,
        snippetsUrl: assets.pythonSnippets,
        ...(pythonAsset('runtimeLoader')?.url ? { loaderUrl: pythonAsset('runtimeLoader')?.url } : {}),
        ...(pythonAsset('runtimeIndex')?.url ? { indexUrl: pythonAsset('runtimeIndex')?.url } : {}),
        ...(pythonManifest?.loaderFormat ? { loaderFormat: pythonManifest.loaderFormat } : {}),
        ...(pythonPackageDescriptors
          ? {
              packageUrls: Object.fromEntries(
                Object.entries(pythonPackageDescriptors).map(([name, descriptor]) => [name, descriptor.url])
              ),
            }
          : {}),
      },
    };
    const javaWorkerOptions: JavaWorkerClientOptions = {
      workerUrl: assets.javaWorker,
      ...(projectWorkerIsolation === 'per-command' && !isExecutionHosted('java')
        ? { projectUserAuthorityMode: 'permanent' as const }
        : {}),
      ...(executionHost && isExecutionHosted('java')
        ? {
            workerFactory: executionHost.workerFactory,
            isolatedRuntimeStorage: true,
            ...(javaExecutionLifecycle === 'per-command'
              ? { projectUserAuthorityMode: 'permanent' as const }
              : { projectUserAuthorityMode: 'isolated-origin' as const }),
          }
        : {}),
      debug,
      workerIdleTimeoutMs: javaWorkerIdleTimeoutMs,
      compileCacheLimit: javaCompileCacheLimit,
      assetPreflight: async () => {
        assertProjectJavaRuntimeAssets();
        await runtimeAssetPreflight.preflight('java', ['worker']);
      },
      runtimeAssetPreflight: () => runtimeAssetPreflight.preflight('java', [
        'loader',
        'helperJar',
        'compilerJar',
        'rewriterJar',
        'parserJar',
      ]),
      ...(javaManifest
        ? {
            runtimeAssets: {
              ...(manifestAsset('java', 'loader')?.url
                ? { loaderUrl: manifestAsset('java', 'loader')?.url }
                : {}),
              ...(manifestAsset('java', 'helperJar')?.url
                ? { helperJarUrl: manifestAsset('java', 'helperJar')?.runtimePath ?? manifestAsset('java', 'helperJar')?.url }
                : {}),
              ...(manifestAsset('java', 'compilerJar')?.url
                ? { compilerJarUrl: manifestAsset('java', 'compilerJar')?.runtimePath ?? manifestAsset('java', 'compilerJar')?.url }
                : {}),
              ...(manifestAsset('java', 'rewriterJar')?.url
                ? { rewriterJarUrl: manifestAsset('java', 'rewriterJar')?.runtimePath ?? manifestAsset('java', 'rewriterJar')?.url }
                : {}),
              ...(manifestAsset('java', 'parserJar')?.url
                ? { parserJarUrl: manifestAsset('java', 'parserJar')?.runtimePath ?? manifestAsset('java', 'parserJar')?.url }
                : {}),
            },
          }
        : {}),
    };
    const csharpWorkerOptions: CSharpWorkerClientOptions = {
      workerUrl: assets.csharpWorker,
      ...(executionHost && isExecutionHosted('csharp') ? { workerFactory: executionHost.workerFactory } : {}),
      assetBaseUrl: assets.csharpAssetBaseUrl,
      ...(projectWorkerIsolation === 'per-command'
        ? { projectUserAuthorityMode: 'permanent' as const }
        : {}),
      debug,
      workerIdleTimeoutMs: csharpWorkerIdleTimeoutMs,
      assetPreflight: () => runtimeAssetPreflight.preflight('csharp', ['worker']),
      runtimeAssetPreflight: () => runtimeAssetPreflight.preflight('csharp', [
        'assetBaseUrl',
        'dependencies',
      ]),
      ...(csharpDependencyDescriptors
        ? {
            runtimeDependencies: Object.fromEntries(
              Object.entries(csharpDependencyDescriptors).map(([name, descriptor]) => [name, descriptor.url])
            ),
          }
        : {}),
    };
    const cppWorkerOptions: CppWorkerClientOptions = {
      workerUrl: assets.cppWorker,
      ...(executionHost && isExecutionHosted('cpp') ? { workerFactory: executionHost.workerFactory } : {}),
      assetPreflight: () => runtimeAssetPreflight.preflight('cpp', ['worker']),
      runtimeAssetPreflight: () => runtimeAssetPreflight.preflight('cpp', [
        'compilerFrame',
        'compilerWorker',
        'runtimeHeader',
        'compilerBundle',
        'clangWasm',
        'lldWasm',
        'sysroot',
        'toolchain',
      ]),
      compilerFrameUrl: assets.cppCompilerFrame,
      compilerWorkerUrl: assets.cppCompilerWorker,
      clangWasmUrl: assets.cppClangWasm,
      lldWasmUrl: assets.cppLldWasm,
      sysrootUrl: assets.cppSysroot,
      runtimeHeaderUrl: assets.cppRuntimeHeader,
      compilerBundleUrl: assets.cppCompilerBundle,
      toolchainIntegrity: assets.cppToolchainIntegrity,
      debug,
      workerIdleTimeoutMs: cppWorkerIdleTimeoutMs,
    };
    const PythonWorkerClientConstructor = pythonProvider?.[1].PythonWorkerClient;
    const pythonWorkerClient = hasProvider('python')
      ? providedPythonWorkerClient ?? (
          projectWorkerIsolation === 'per-command'
            ? createPerCommandPythonWorkerClient(
                projectPrewarm.python,
                () => new PythonWorkerClientConstructor!(pythonWorkerOptions)
              )
            : new PythonWorkerClientConstructor!(pythonWorkerOptions)
        )
      : undefined;
    if (pythonWorkerClient && !providedPythonWorkerClient) ownedWorkers.push(pythonWorkerClient);
    const JavaWorkerClientConstructor = javaProvider?.[1].JavaWorkerClient;
    const createdJavaWorkerClient = hasProvider('java') && !traceJVM
      ? providedJavaWorkerClient ?? (
          projectWorkerIsolation === 'per-command' && (!isExecutionHosted('java') || javaExecutionLifecycle === 'per-command')
            ? createPerCommandJavaWorkerClient(
                projectPrewarm.java,
                () => new JavaWorkerClientConstructor!(javaWorkerOptions),
                assertProjectJavaRuntimeAssets
              )
            : new JavaWorkerClientConstructor!(javaWorkerOptions)
        )
      : undefined;
    const javaWorkerClient =
      createdJavaWorkerClient &&
      !providedJavaWorkerClient &&
      executionHost &&
      executionHostReady &&
      isExecutionHosted('java') &&
      javaExecutionLifecycle === 'workspace-session' &&
      projectPrewarm.java > 0
        ? createBackgroundPrewarmedJavaWorkerClient(
            createdJavaWorkerClient as JavaWorkerClient,
            () => executionHostReady!
          )
        : createdJavaWorkerClient;
    if (javaWorkerClient && !providedJavaWorkerClient) ownedWorkers.push(javaWorkerClient);
    const CSharpWorkerClientConstructor = csharpProvider?.[1].CSharpWorkerClient;
    const csharpWorkerClient = hasProvider('csharp')
      ? providedCSharpWorkerClient ?? (
          projectWorkerIsolation === 'per-command'
            ? createPerCommandCSharpWorkerClient(
                projectPrewarm.csharp,
                () => new CSharpWorkerClientConstructor!(csharpWorkerOptions)
              )
            : new CSharpWorkerClientConstructor!(csharpWorkerOptions)
        )
      : undefined;
    if (csharpWorkerClient && !providedCSharpWorkerClient) ownedWorkers.push(csharpWorkerClient);
    const CppWorkerClientConstructor = cppProvider?.[1].CppWorkerClient;
    const cppWorkerClient = hasProvider('cpp')
      ? providedCppWorkerClient ?? (
          projectWorkerIsolation === 'per-command'
            ? createPerCommandCppWorkerClient(
                projectPrewarm.cpp,
                () => new CppWorkerClientConstructor!(cppWorkerOptions)
              )
            : new CppWorkerClientConstructor!(cppWorkerOptions)
        )
      : undefined;
    if (cppWorkerClient && !providedCppWorkerClient) ownedWorkers.push(cppWorkerClient);

    if (executionHost) ownedWorkers.push({ terminate: () => executionHost?.dispose() });

    let workspace: BrowserProjectWorkspace;
    let storageBinding: BrowserKernelStorageBinding | undefined;
    const storedSnapshot = await hydrateBrowserKernelStorage(kernelStorage);
    // An intentionally empty persisted workspace is still authoritative. Treating
    // it as "no snapshot" resurrects deleted seed/session files on the next load.
    const hasStoredWorkspace = storedSnapshot !== null;
    const policyFiles = policySessionFiles(workspaceOptions);
    const projectSession = hasStoredWorkspace && workspaceOptions.projectSession
      ? {
          ...workspaceOptions.projectSession,
          files: policyFiles,
          symlinks: [],
          directories: [],
          directoryMetadata: [],
        }
      : workspaceOptions.projectSession;

    workspace = await createRuntimeWorkspace({
      ...workspaceOptions,
      projectSession,
      ...(hasStoredWorkspace
        ? {
            files: storedSnapshot.files,
            symlinks: storedSnapshot.symlinks,
            directories: storedSnapshot.directories,
            directoryMetadata: storedSnapshot.directoryMetadata,
            entrypoint: storedSnapshot.entrypoint ?? workspaceOptions.entrypoint,
          }
        : {}),
      ...(pythonWorkerClient && pythonProvider
        ? {
            pythonRunner: pythonProvider[0].createBrowserPythonProjectRunner(pythonWorkerClient, {
              timeoutMs: pythonProjectTimeoutMs,
            }),
          }
        : {}),
      ...(hasProvider('javascript') && javascriptProvider
        ? {
            nodeRunner: javascriptProvider.createBrowserJavaScriptProjectRunner({
              timeoutMs: nodeProjectTimeoutMs,
              workerIsolation: projectWorkerIsolation,
              ...nodeProject,
              workerUrl: assets.runtimeManifests?.javascript
                ? assets.javascriptProjectWorker
                : nodeProject?.workerUrl ?? assets.javascriptProjectWorker,
              ...(executionHost && isExecutionHosted('javascript')
                ? { workerFactory: executionHost.workerFactory }
                : {}),
              assetPreflight: () => runtimeAssetPreflight.preflight('javascript', ['projectWorker']),
              ...(projectWorkerIsolation === 'shared' ? { trustedReusableWorker: true } : {}),
              prewarm: projectPrewarm.javascript > 0,
              registerPrewarmCleanup: (cleanup) => ownedWorkers.push({ terminate: cleanup }),
            }),
          }
        : {}),
      ...(hasProvider('typescript') && javascriptProvider
        ? {
            typescriptRunner: javascriptProvider.createBrowserTypeScriptProjectRunner({
              ...typescriptProject,
              // This factory owns and preflights the compiler URL, so its same-document
              // script is trusted compiler infrastructure rather than user code. A
              // runtime manifest is the explicit consumer trust decision for an
              // external compiler CDN.
              allowDomCompilerScript: typescriptProject?.allowDomCompilerScript ?? true,
              allowExternalDomCompilerScript: assets.runtimeManifests?.typescript
                ? true
                : typescriptProject?.allowExternalDomCompilerScript,
              compilerUrl: assets.runtimeManifests?.typescript
                ? assets.typescriptCompiler
                : typescriptProject?.compilerUrl ?? assets.typescriptCompiler,
              compilerPreflight: () => runtimeAssetPreflight.preflight('typescript', ['compiler']),
              prewarmCompiler: projectPrewarm.typescript > 0,
            }),
          }
        : {}),
      ...(traceJVM && javaProvider
        ? {
            javaRunner: javaProvider[2].createTraceJVMProjectRunner({
              ...traceJVM,
              timeoutMs: javaProjectTimeoutMs ?? traceJVM.timeoutMs,
            }),
          }
        : javaWorkerClient && javaProvider
        ? {
            javaRunner: javaProvider[0].createBrowserJavaProjectRunner(javaWorkerClient, {
              timeoutMs: javaProjectTimeoutMs,
            }),
          }
        : {}),
      ...(csharpWorkerClient && csharpProvider
        ? {
            csharpRunner: csharpProvider[0].createBrowserCSharpProjectRunner(csharpWorkerClient, {
              timeoutMs: csharpProjectTimeoutMs,
            }),
          }
        : {}),
      ...(cppWorkerClient && cppProvider
        ? {
            cppRunner: cppProvider[0].createBrowserCppProjectRunner(cppWorkerClient, {
              timeoutMs: cppProjectTimeoutMs,
            }),
          }
        : {}),
      kernelControl: {
        async reset() {
          storageBinding?.dispose();
          await storageBinding?.flush();
          await kernelStorage?.clear?.();
          for (const worker of ownedWorkers) {
            worker.terminate();
          }
        },
      },
    });

    storageBinding = bindBrowserKernelStorage(workspace, kernelStorage, {
      onError: onKernelStorageError,
    });
    await persistInitialBrowserKernelSnapshot(workspace, kernelStorage);
    const disposeWorkspace = workspace.dispose.bind(workspace);
    const destroyWorkspace = workspace.destroy.bind(workspace);

    return Object.assign(workspace, {
      async destroy(options?: { reason?: string; clearStorage?: boolean }) {
        storageBinding?.dispose();
        await storageBinding?.flush();
        if (options?.clearStorage) {
          await kernelStorage?.clear?.();
        }
        await destroyWorkspace(options);
        for (const worker of ownedWorkers) {
          worker.terminate();
        }
      },
      dispose() {
        storageBinding?.dispose();
        void storageBinding?.flush().catch(() => undefined);
        disposeWorkspace();
        for (const worker of ownedWorkers) {
          worker.terminate();
        }
      },
    });
  } catch (error) {
    for (const worker of ownedWorkers) {
      worker.terminate();
    }
    executionHost?.dispose();
    throw error;
  }
}
