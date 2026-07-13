import type {
  Language,
  RuntimeDirectoryChange,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeWorkspace,
} from '@tracecode/harness-core';
import { normalizeRuntimeProjectPath } from '@tracecode/harness-core';
import type { CreateRuntimeWorkspaceOptions } from '../../harness-project/src/index';
import type {
  BrowserJavaScriptProjectRunnerOptions,
  BrowserTypeScriptProjectRunnerOptions,
} from '../../harness-javascript/src/project-browser';
import type { CSharpWorkerClient, CSharpWorkerClientOptions } from './csharp-worker-client';
import type { CppWorkerClient, CppWorkerClientOptions } from './cpp-worker-client';
import type { JavaWorkerClient, JavaWorkerClientOptions } from './java-worker-client';
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
  /** Heavy Java runtime lifecycle inside the provider-neutral host. Defaults to workspace-session. */
  javaLifecycle?: BrowserProjectJavaLifecycle;
}
export interface BrowserProjectWorkerPrewarmOptions {
  /** Ready/idle clean Python workers (0-2); active leases may coexist with their replacements. */
  python?: number;
  /** Ready/idle clean Java workers (0-2); active leases may coexist with their replacements. */
  java?: number;
  /** Ready/idle clean C# workers (0-2); active leases may coexist with their replacements. */
  csharp?: number;
}

function readonlySessionFiles(options: CreateRuntimeWorkspaceOptions): string[] {
  return [...new Set((options.projectSession?.files ?? [])
    .filter((file) => file.readonly === true || file.hidden === true)
    .map((file) => normalizeRuntimeProjectPath(file.path)))];
}

function policySessionFiles(options: CreateRuntimeWorkspaceOptions): NonNullable<CreateRuntimeWorkspaceOptions['projectSession']>['files'] {
  return (options.projectSession?.files ?? [])
    .filter((file) => file.hidden === true || file.readonly === true);
}

function isReadonlyDeletion(change: RuntimeFileChange, readonlyFiles: readonly string[]): boolean {
  if ((change as RuntimeFileDeletion | RuntimeDirectoryChange).deleted !== true) return false;
  const path = normalizeRuntimeProjectPath(change.path);
  const omittedReadonlyFiles = readonlyFiles.filter((readonlyPath) => readonlyPath.includes('/'));
  if (omittedReadonlyFiles.length === 0) return false;
  if ((change as RuntimeDirectoryChange).directory === true) {
    return omittedReadonlyFiles.some((readonlyPath) => readonlyPath === path || readonlyPath.startsWith(`${path}/`));
  }
  return omittedReadonlyFiles.includes(path);
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
  run<Result>(signal: AbortSignal | undefined, execute: (client: Client) => Promise<Result>): Promise<Result>;
  terminate(): void;
}

interface OneShotPoolEntry<Client extends PrewarmableProjectWorker> {
  client: Client;
  generation: number;
  token: number;
  state: 'warming' | 'idle' | 'leased' | 'retired';
}

interface OneShotWarmOutcome {
  success: boolean;
  error?: Error;
}

const MAX_PROJECT_PREWARM_DEPTH_PER_LANGUAGE = 2;
const MAX_PROJECT_PREWARM_DEPTH_TOTAL = 4;
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
    java: value?.java ?? 0,
    csharp: value?.csharp ?? 0,
  };
  for (const [language, depth] of Object.entries(normalized)) {
    if (!Number.isInteger(depth) || depth < 0 || depth > MAX_PROJECT_PREWARM_DEPTH_PER_LANGUAGE) {
      throw new TypeError(
        `projectWorkerPrewarm.${language} must be an integer from 0 to ${MAX_PROJECT_PREWARM_DEPTH_PER_LANGUAGE}.`
      );
    }
  }
  const total = normalized.python + normalized.java + normalized.csharp;
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
  createClient: () => Client
): OneShotPrewarmedWorkerPool<Client> {
  let generation = 1;
  let nextToken = 0;
  let refillEnabled = true;
  const entries = new Map<number, OneShotPoolEntry<Client>>();
  const idle: Array<OneShotPoolEntry<Client>> = [];
  const warming = new Map<number, Promise<OneShotWarmOutcome>>();
  const active = new Map<number, OneShotPoolEntry<Client>>();

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

  const warmNewClient = (): Promise<OneShotWarmOutcome> => {
    const entry: OneShotPoolEntry<Client> = {
      client: createClient(),
      generation,
      token: ++nextToken,
      state: 'warming',
    };
    entries.set(entry.token, entry);
    const promise = (async (): Promise<OneShotWarmOutcome> => {
      try {
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
      const outcome = await warmNewClient();
      if (!outcome.success) lastWarmError = outcome.error;
    }
  };

  refill();

  return {
    async run<Result>(signal: AbortSignal | undefined, execute: (client: Client) => Promise<Result>): Promise<Result> {
      refillEnabled = true;
      refill();
      const leaseGeneration = generation;
      const entry = await acquire(leaseGeneration, signal);
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
        retire(entry);
        refill();
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
    async executeProjectPython(request, timeoutMs, onEvent, signal) {
      return pool.run(signal, (client) => client.executeProjectPython(request, timeoutMs, onEvent, signal));
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
      return pool.run(signal, (client) => client.executeProjectJava(request, timeoutMs, onEvent, signal));
    },
    terminate() {
      pool.terminate();
    },
  };
}

function createPerCommandCSharpWorkerClient(
  prewarmDepth: number,
  createClient: () => CSharpWorkerClient
): Pick<CSharpWorkerClient, 'executeProjectCSharp' | 'terminate'> {
  const pool = createOneShotPrewarmedWorkerPool('C#', prewarmDepth, createClient);
  return {
    async executeProjectCSharp(request, timeoutMs, onEvent, signal) {
      return pool.run(signal, (client) => client.executeProjectCSharp(request, timeoutMs, onEvent, signal));
    },
    terminate() {
      pool.terminate();
    },
  };
}

function createPerCommandCppWorkerClient(
  createClient: () => CppWorkerClient
): Pick<CppWorkerClient, 'executeProjectCpp' | 'terminate'> {
  const active = new Set<CppWorkerClient>();
  return {
    async executeProjectCpp(request, timeoutMs, onEvent, signal) {
      const client = createClient();
      active.add(client);
      try {
        return await client.executeProjectCpp(request, timeoutMs, onEvent, signal);
      } finally {
        active.delete(client);
        client.terminate();
      }
    },
    terminate() {
      for (const client of active) client.terminate();
      active.clear();
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
  csharpWorkerClient?: Pick<CSharpWorkerClient, 'executeProjectCSharp' | 'terminate'>;
  cppWorkerClient?: Pick<CppWorkerClient, 'executeProjectCpp' | 'terminate'>;
  /** Runs every built-in project worker on a dedicated, credential-free origin. */
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
    csharpWorkerIdleTimeoutMs,
    cppWorkerIdleTimeoutMs,
    kernelStorage,
    onKernelStorageError,
    ...workspaceOptions
  } = options;
  if (
    executionHostOptions &&
    (providedPythonWorkerClient || providedJavaWorkerClient || providedCSharpWorkerClient || providedCppWorkerClient)
  ) {
    throw new Error('executionHost cannot be combined with provided language worker clients.');
  }
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
  for (const provider of ['python', 'java', 'csharp'] as const) {
    if (projectPrewarm[provider] > 0 && !hasProvider(provider)) {
      throw new Error(`projectWorkerPrewarm.${provider} requires providers to include ${JSON.stringify(provider)}.`);
    }
  }
  if (
    projectWorkerIsolation !== 'per-command' &&
    (projectPrewarm.python > 0 || projectPrewarm.java > 0 || projectPrewarm.csharp > 0)
  ) {
    throw new Error('projectWorkerPrewarm is only supported with per-command project worker isolation.');
  }
  if (providedPythonWorkerClient && projectPrewarm.python > 0) {
    throw new Error('projectWorkerPrewarm.python cannot be used with a provided pythonWorkerClient.');
  }
  if (providedJavaWorkerClient && projectPrewarm.java > 0) {
    throw new Error('projectWorkerPrewarm.java cannot be used with a provided javaWorkerClient.');
  }
  if (!providedJavaWorkerClient && projectPrewarm.java > 0) {
    assertProjectJavaRuntimeAssets();
  }
  if (providedCSharpWorkerClient && projectPrewarm.csharp > 0) {
    throw new Error('projectWorkerPrewarm.csharp cannot be used with a provided csharpWorkerClient.');
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
  if (executionHostOptions) {
    executionHost = createBrowserExecutionWorkerHost(executionHostOptions);
    try {
      await executionHost.ready();
      if (hasProvider('java')) {
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
        if (!hasProvider(runtime)) continue;
        const hostedWorkerUrl = new URL(configuredUrl, `${executionHost.origin}/`);
        if (hostedWorkerUrl.origin !== executionHost.origin) {
          throw new Error(
            `${runtime} worker origin ${JSON.stringify(hostedWorkerUrl.origin)} must match executionHost origin ${JSON.stringify(executionHost.origin)}.`
          );
        }
      }
    } catch (error) {
      executionHost.dispose();
      throw error;
    }
  }
  const ownedWorkers: Array<{ terminate(): void }> = [];
  try {
    const pythonWorkerOptions: PythonWorkerClientOptions = {
      workerUrl: assets.pythonWorker,
      ...(executionHost ? { workerFactory: executionHost.workerFactory } : {}),
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
      ...(projectWorkerIsolation === 'per-command' && !executionHost
        ? { projectUserAuthorityMode: 'permanent' as const }
        : {}),
      ...(executionHost
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
      ...(executionHost ? { workerFactory: executionHost.workerFactory } : {}),
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
      ...(executionHost ? { workerFactory: executionHost.workerFactory } : {}),
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
    const javaWorkerClient = hasProvider('java')
      ? providedJavaWorkerClient ?? (
          projectWorkerIsolation === 'per-command' && (!executionHost || javaExecutionLifecycle === 'per-command')
            ? createPerCommandJavaWorkerClient(
                projectPrewarm.java,
                () => new JavaWorkerClientConstructor!(javaWorkerOptions),
                assertProjectJavaRuntimeAssets
              )
            : new JavaWorkerClientConstructor!(javaWorkerOptions)
        )
      : undefined;
    if (javaWorkerClient && !providedJavaWorkerClient) ownedWorkers.push(javaWorkerClient);
    if (executionHost && javaExecutionLifecycle === 'workspace-session' && projectPrewarm.java > 0) {
      if (projectPrewarm.java !== 1) {
        executionHost.dispose();
        throw new Error('executionHost workspace-session Java prewarm depth must be 0 or 1.');
      }
      await (javaWorkerClient as JavaWorkerClient).warmup();
    }
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
            ? createPerCommandCppWorkerClient(() => new CppWorkerClientConstructor!(cppWorkerOptions))
            : new CppWorkerClientConstructor!(cppWorkerOptions)
        )
      : undefined;
    if (cppWorkerClient && !providedCppWorkerClient) ownedWorkers.push(cppWorkerClient);

    if (executionHost) ownedWorkers.push({ terminate: () => executionHost?.dispose() });

    let workspace: BrowserProjectWorkspace;
    let storageBinding: BrowserKernelStorageBinding | undefined;
    const sessionReadonlyFiles = readonlySessionFiles(workspaceOptions);
    const applyWorkerFileChange: NonNullable<BrowserJavaScriptProjectRunnerOptions['applyFileChange']> =
      async (change, phase, options) => {
        if (options?.signal?.aborted) return false;
        await workspace.kernel.applyFileChange(change, undefined, phase);
        if (options?.signal?.aborted) return false;
        return false;
      };
    const applyCSharpWorkerFileChange: NonNullable<BrowserJavaScriptProjectRunnerOptions['applyFileChange']> =
      async (change, phase, options) => {
        if (options?.signal?.aborted) return false;
        if (isReadonlyDeletion(change, sessionReadonlyFiles)) return false;
        await workspace.kernel.applyFileChange(change, undefined, phase);
        if (options?.signal?.aborted) return false;
        return false;
    };

    const storedSnapshot = await hydrateBrowserKernelStorage(kernelStorage);
    // An intentionally empty persisted workspace is still authoritative. Treating
    // it as "no snapshot" resurrects deleted seed/session files on the next load.
    const hasStoredWorkspace = storedSnapshot !== null;
    const policyFiles = policySessionFiles(workspaceOptions);
    const projectSession = hasStoredWorkspace && workspaceOptions.projectSession
      ? {
          ...workspaceOptions.projectSession,
          files: policyFiles,
          directories: [],
        }
      : workspaceOptions.projectSession;

    workspace = await createRuntimeWorkspace({
      ...workspaceOptions,
      projectSession,
      ...(hasStoredWorkspace
        ? {
            files: storedSnapshot.files,
            directories: storedSnapshot.directories,
            entrypoint: storedSnapshot.entrypoint ?? workspaceOptions.entrypoint,
          }
        : {}),
      ...(pythonWorkerClient && pythonProvider
        ? {
            pythonRunner: pythonProvider[0].createBrowserPythonProjectRunner(pythonWorkerClient, {
              timeoutMs: pythonProjectTimeoutMs,
              applyFileChange: applyWorkerFileChange,
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
              ...(executionHost ? { workerFactory: executionHost.workerFactory } : {}),
              assetPreflight: () => runtimeAssetPreflight.preflight('javascript', ['projectWorker']),
              ...(projectWorkerIsolation === 'shared' ? { trustedReusableWorker: true } : {}),
              applyFileChange: applyWorkerFileChange,
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
            }),
          }
        : {}),
      ...(javaWorkerClient && javaProvider
        ? {
            javaRunner: javaProvider[0].createBrowserJavaProjectRunner(javaWorkerClient, {
              timeoutMs: javaProjectTimeoutMs,
              applyFileChange: applyWorkerFileChange,
            }),
          }
        : {}),
      ...(csharpWorkerClient && csharpProvider
        ? {
            csharpRunner: csharpProvider[0].createBrowserCSharpProjectRunner(csharpWorkerClient, {
              timeoutMs: csharpProjectTimeoutMs,
              applyFileChange: applyCSharpWorkerFileChange,
            }),
          }
        : {}),
      ...(cppWorkerClient && cppProvider
        ? {
            cppRunner: cppProvider[0].createBrowserCppProjectRunner(cppWorkerClient, {
              timeoutMs: cppProjectTimeoutMs,
              applyFileChange: applyWorkerFileChange,
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
