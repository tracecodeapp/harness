import type {
  Language,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeProjectEngineLeaseController,
  RuntimeProjectCommandRequest,
  RuntimeProjectProcessInfo,
  RuntimeWorkspace,
} from '@tracecode/runtime-contracts';
import type { CreateRuntimeWorkspaceOptions } from '@tracecode/tracekernel/workspace';
import type { CSharpWorkerClient, CSharpWorkerClientOptions } from '../../runtime-csharp/src/csharp-worker-client';
import type { CppWorkerClient, CppWorkerClientOptions } from '../../runtime-cpp/src/cpp-worker-client';
import type { JavaWorkerClient } from '../../runtime-java/src/java-worker-client';
import type { PythonWorkerClient, PythonWorkerClientOptions } from '../../runtime-python/src/python-worker-client';
import {
  resolveBrowserRuntimeAssets,
  type BrowserRuntimeAssetDescriptor,
  type BrowserRuntimeAssetOverrides,
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
} from '@tracecode/runtime-contracts';
export {
  BROWSER_EXECUTION_HOST_PROTOCOL,
  createBrowserExecutionWorkerHost,
  installBrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHost,
  type BrowserExecutionWorkerHostOptions,
  type InstallBrowserExecutionWorkerHostOptions,
} from './execution-host';

export type BrowserProjectWorkspace = RuntimeWorkspace;
export interface BrowserProjectNodeOptions {
  allowDynamicEval?: boolean;
  allowMainThreadExecution?: boolean;
  hardened?: boolean;
  trustedMainThreadExecution?: boolean;
  workerFactory?: BrowserExecutionWorkerHost['workerFactory'];
  workerUrl?: string;
}
export interface BrowserProjectTypeScriptOptions {
  allowDomCompilerScript?: boolean;
  allowExternalDomCompilerScript?: boolean;
  compilerUrl?: string;
}
export type BrowserProjectWorkerIsolation = 'shared' | 'per-command';
export type BrowserProjectProvider = Language;
export type BrowserProjectInjectedProvider =
  | 'python'
  | 'java'
  | 'csharp'
  | 'cpp';

export interface BrowserProjectRuntimeProviderExecution {
  readonly timeoutMs?: number;
  readonly onEvent?: RuntimeCommandEventHandler;
  readonly signal?: AbortSignal;
  readonly engineLease?: RuntimeProjectEngineLeaseController;
}

/**
 * Caller-owned command boundary for a Project runtime that replaces a built-in
 * provider.
 *
 * The workspace never warms, resets, or terminates an injected provider. Its
 * owner must keep it active until every workspace command has settled, and
 * must dispose it only after the workspace itself has been destroyed.
 */
export interface BrowserProjectRuntimeProvider {
  execute(
    request: RuntimeProjectCommandRequest<string>,
    execution: BrowserProjectRuntimeProviderExecution
  ): Promise<RuntimeCommandResult>;
}

export type BrowserProjectRuntimeProviders = Partial<
  Readonly<Record<BrowserProjectInjectedProvider, BrowserProjectRuntimeProvider>>
>;

export interface BrowserProjectJavaBinaryFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export interface BrowserProjectJavaSourceFile {
  readonly path: string;
  readonly content: string;
}

export interface BrowserProjectJavaIsolationReport {
  readonly status: 'not-applicable' | 'clean' | 'tainted';
  readonly restored: readonly string[];
  readonly taintReasons: readonly string[];
  readonly hardBoundaryRecommended: boolean;
}

export interface BrowserProjectJavaExecutionResult {
  readonly status:
    | 'completed'
    | 'compile-error'
    | 'runtime-error'
    | 'cancelled';
  readonly exitCode: number;
  readonly value?: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timings: {
    readonly runtimeInitMs: number;
    readonly queueMs: number;
    readonly compileAndRunMs: number;
    readonly totalMs: number;
  };
  readonly isolation: BrowserProjectJavaIsolationReport;
  readonly retirementRecommended: boolean;
  readonly diagnostics?: unknown;
}

export interface BrowserProjectJavaCompileRequest {
  readonly sources: readonly BrowserProjectJavaSourceFile[];
  readonly classpath?: readonly BrowserProjectJavaBinaryFile[];
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface BrowserProjectJavaCompileResult
  extends BrowserProjectJavaExecutionResult {
  readonly program?: {
    readonly files: readonly BrowserProjectJavaBinaryFile[];
  };
}

export interface BrowserProjectJavaRunRequest {
  readonly program: {
    readonly files: readonly BrowserProjectJavaBinaryFile[];
  };
  readonly classpath?: readonly BrowserProjectJavaBinaryFile[];
  readonly mainClass: string;
  readonly args?: readonly string[];
  readonly systemProperties?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface BrowserProjectJavaRuntimeClient {
  initialize?(signal?: AbortSignal): Promise<{ initializeMs: number }>;
  compile(
    request: BrowserProjectJavaCompileRequest
  ): Promise<BrowserProjectJavaCompileResult>;
  run(
    request: BrowserProjectJavaRunRequest
  ): Promise<BrowserProjectJavaExecutionResult>;
  terminate(): void;
}

export interface BrowserProjectJavaHostRequest<Payload = unknown> {
  readonly service: string;
  readonly operation: string;
  readonly payload?: Payload;
}

export interface BrowserProjectJavaHost {
  dispatch(
    request: BrowserProjectJavaHostRequest
  ): Promise<unknown> | unknown;
}

export interface BrowserProjectJavaRuntimeContext {
  readonly cwd: string;
  readonly process?: RuntimeProjectProcessInfo;
  readonly host?: BrowserProjectJavaHost;
  readonly hostStandardDescriptors: boolean;
}

export interface BrowserProjectJavaRuntimeOptions {
  /**
   * Returns a fresh, unleased runtime client. The workspace admits the result
   * to exactly one javac/java invocation and always terminates it.
   */
  createClient(
    context: BrowserProjectJavaRuntimeContext
  ):
    | BrowserProjectJavaRuntimeClient
    | Promise<BrowserProjectJavaRuntimeClient>;
  timeoutMs?: number;
  onExecutionReport?: (report: {
    readonly pid?: number;
    readonly source: 'compile' | 'run';
    readonly result: BrowserProjectJavaExecutionResult;
  }) => void;
}
export interface BrowserProjectExecutionHostOptions extends BrowserExecutionWorkerHostOptions {
  /**
   * Providers routed through this host. Java is excluded because its project
   * provider owns the Worker boundary supplied by java.createClient.
   */
  providers?: readonly BrowserProjectProvider[];
}
export interface BrowserProjectWorkerPrewarmOptions {
  /** Ready/idle clean Python workers (0-2); active leases may coexist with their replacements. */
  python?: number;
  /** One clean JavaScript project worker prepared for the next command (0-1). */
  javascript?: number;
  /** Trusted TypeScript compiler loaded in the background (0-1). */
  typescript?: number;
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
const DEFAULT_BROWSER_PROJECT_PROVIDERS: readonly BrowserProjectProvider[] = Object.freeze([
  'python',
  'javascript',
  'typescript',
  'java',
  'csharp',
  'cpp',
]);
const BROWSER_PROJECT_PREWARM_PROVIDERS = Object.freeze([
  'python',
  'javascript',
  'typescript',
  'csharp',
  'cpp',
] as const);
const BROWSER_PROJECT_INJECTED_PROVIDERS: readonly BrowserProjectInjectedProvider[] =
  Object.freeze(['python', 'java', 'csharp', 'cpp']);

function normalizeBrowserProjectProviders(
  providers: readonly BrowserProjectProvider[] | undefined
): readonly BrowserProjectProvider[] {
  const normalized: BrowserProjectProvider[] = [];
  for (const provider of providers ?? DEFAULT_BROWSER_PROJECT_PROVIDERS) {
    if (!BROWSER_PROJECT_PROVIDERS.includes(provider)) {
      throw new TypeError(`Browser project provider ${JSON.stringify(provider)} is not supported.`);
    }
    if (!normalized.includes(provider)) normalized.push(provider);
  }
  return Object.freeze(normalized);
}

function normalizeBrowserProjectRuntimeProviders(
  value: BrowserProjectRuntimeProviders | undefined
): BrowserProjectRuntimeProviders {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('runtimeProviders must be an object when provided.');
  }
  for (const key of Object.keys(value)) {
    if (
      !BROWSER_PROJECT_INJECTED_PROVIDERS.includes(
        key as BrowserProjectInjectedProvider
      )
    ) {
      throw new TypeError(
        `Browser project runtime provider ${JSON.stringify(key)} is not supported.`
      );
    }
  }
  const normalized: Partial<
    Record<BrowserProjectInjectedProvider, BrowserProjectRuntimeProvider>
  > = {};
  for (const provider of BROWSER_PROJECT_INJECTED_PROVIDERS) {
    const runtimeProvider = value[provider];
    if (runtimeProvider === undefined) continue;
    if (
      !runtimeProvider ||
      typeof runtimeProvider !== 'object' ||
      typeof runtimeProvider.execute !== 'function'
    ) {
      throw new TypeError(
        `runtimeProviders.${provider} must define an execute function.`
      );
    }
    normalized[provider] = runtimeProvider;
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
      let rejectAbort: ((error: Error) => void) | undefined;
      const onAbort = () => {
        retire(entry);
        rejectAbort?.(projectPoolAbortError());
      };
      try {
        if (signal?.aborted) {
          retire(entry);
          return { success: false, error: projectPoolAbortError() };
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        const warmupAttempt = Promise.resolve().then(() => entry.client.warmup());
        // Termination can happen before a runtime preflight has created its
        // worker session. Keep observing that abandoned warmup and retire the
        // client again after it settles so a late session cannot escape.
        void warmupAttempt.finally(() => {
          if (entry.state !== 'retired') return;
          try {
            entry.client.terminate();
          } catch {
            // The entry is already fenced out of the pool; cleanup is best-effort.
          }
        }).catch(() => undefined);
        if (signal) {
          const abort = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
          });
          await Promise.race([warmupAttempt, abort]);
        } else {
          await warmupAttempt;
        }
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
  const activeCompileClients = new Set<CppWorkerClient>();
  return {
    async executeProjectCpp(request, timeoutMs, onEvent, signal, engineLease) {
      // A trusted TraceCC compile is service-owned and must not pay for an
      // execution worker. With no requested prewarm depth, a fresh client also
      // already supplies C++'s one-command disposable runner boundary, so a
      // separate generic pool warmup would only duplicate startup work.
      if (request.source === 'compile' || prewarmDepth === 0) {
        const client = createClient();
        activeCompileClients.add(client);
        try {
          return await client.executeProjectCpp(
            request,
            timeoutMs,
            onEvent,
            signal,
            engineLease
          );
        } finally {
          activeCompileClients.delete(client);
          client.terminate();
        }
      }
      return pool.run(signal, engineLease, (client) =>
        client.executeProjectCpp(request, timeoutMs, onEvent, signal)
      );
    },
    terminate() {
      pool.terminate();
      for (const client of activeCompileClients) {
        client.terminate();
      }
      activeCompileClients.clear();
    },
  };
}

function createInjectedPythonWorkerClient(
  provider: BrowserProjectRuntimeProvider
): Pick<PythonWorkerClient, 'executeProjectPython' | 'terminate'> {
  return {
    executeProjectPython(
      request,
      timeoutMs,
      onEvent,
      signal,
      engineLease
    ) {
      return provider.execute(request, {
        timeoutMs,
        onEvent,
        signal,
        engineLease,
      });
    },
    // Injected providers are caller-owned. This compatibility client is never
    // registered in ownedWorkers, and its termination hook must remain inert.
    terminate() {},
  };
}

function createInjectedJavaWorkerClient(
  provider: BrowserProjectRuntimeProvider
): Pick<JavaWorkerClient, 'executeProjectJava' | 'terminate'> {
  return {
    executeProjectJava(request, timeoutMs, onEvent, signal) {
      return provider.execute(request, {
        timeoutMs,
        onEvent,
        signal,
      });
    },
    terminate() {},
  };
}

function createInjectedCSharpWorkerClient(
  provider: BrowserProjectRuntimeProvider
): Pick<CSharpWorkerClient, 'executeProjectCSharp' | 'terminate'> {
  return {
    executeProjectCSharp(
      request,
      timeoutMs,
      onEvent,
      signal,
      engineLease
    ) {
      return provider.execute(request, {
        timeoutMs,
        onEvent,
        signal,
        engineLease,
      });
    },
    terminate() {},
  };
}

function createInjectedCppWorkerClient(
  provider: BrowserProjectRuntimeProvider
): Pick<CppWorkerClient, 'executeProjectCpp' | 'terminate'> {
  return {
    executeProjectCpp(
      request,
      timeoutMs,
      onEvent,
      signal,
      engineLease
    ) {
      return provider.execute(request, {
        timeoutMs,
        onEvent,
        signal,
        engineLease,
      });
    },
    terminate() {},
  };
}

export interface CreateBrowserProjectWorkspaceOptions
  extends Omit<CreateRuntimeWorkspaceOptions, 'pythonRunner' | 'nodeRunner' | 'javaRunner' | 'csharpRunner' | 'cppRunner'> {
  assetBaseUrl?: string;
  assets?: BrowserRuntimeAssetOverrides;
  /**
   * Runtime providers assembled into this workspace. Defaults to providers
   * that do not require an independently installed runtime factory. Supplying
   * `java` or `runtimeProviders.java` selects Java when this list is omitted;
   * an explicit list remains authoritative.
   */
  providers?: readonly BrowserProjectProvider[];
  debug?: boolean;
  /**
   * Caller-owned command providers that replace the workspace's built-in
   * provider for the corresponding language.
   *
   * These providers are not eligible for workspace prewarming or execution
   * host routing, and the workspace never terminates them.
   */
  runtimeProviders?: BrowserProjectRuntimeProviders;
  /**
   * Java 23 project provider. Each factory result is admitted to exactly one
   * javac/java invocation and hard-retired by the TraceKernel adapter.
   */
  java?: BrowserProjectJavaRuntimeOptions;
  /** Immutable Java runtime tree used by the built-in provider. */
  javaRuntimeAssetBaseUrl?: string;
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
  csharpWorkerIdleTimeoutMs?: number;
  cppWorkerIdleTimeoutMs?: number;
  kernelStorage?: BrowserKernelStorage;
  onKernelStorageError?: (error: Error) => void;
}

export async function createBrowserProjectWorkspace(
  options: CreateBrowserProjectWorkspaceOptions = {}
): Promise<BrowserProjectWorkspace> {
  const runtimeProviders = normalizeBrowserProjectRuntimeProviders(
    options.runtimeProviders
  );
  const projectRuntimePromise = import(
    '@tracecode/tracekernel/workspace'
  );
  const providers = normalizeBrowserProjectProviders(options.providers);
  const hasProvider = (provider: BrowserProjectProvider) => providers.includes(provider);
  const [pythonProvider, javascriptProvider, javaProvider, csharpProvider, cppProvider] = await Promise.all([
    hasProvider('python')
      ? Promise.all([
          import('../../runtime-python/src/project-browser'),
          import('../../runtime-python/src/python-worker-client'),
        ])
      : undefined,
    hasProvider('javascript') || hasProvider('typescript')
      ? import('../../runtime-javascript/src/project-browser')
      : undefined,
    hasProvider('java')
      ? Promise.all([
          import('../../runtime-java/src/project-browser'),
          import('../../runtime-java/src/java-project'),
          import('../../runtime-java/src/java-project-client'),
        ])
      : undefined,
    hasProvider('csharp')
      ? Promise.all([
          import('../../runtime-csharp/src/project-browser'),
          import('../../runtime-csharp/src/csharp-worker-client'),
        ])
      : undefined,
    hasProvider('cpp')
      ? Promise.all([
          import('../../runtime-cpp/src/project-browser'),
          import('../../runtime-cpp/src/cpp-worker-client'),
          import('../../runtime-cpp/src/browser-runtime-provider'),
        ])
      : undefined,
  ]);
  const { createRuntimeWorkspace } = await projectRuntimePromise;
  const assets = resolveBrowserRuntimeAssets(options);
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
  const csharpDependencyDescriptors = manifestAssetCollection('csharp', 'dependencies');
  const {
    assetBaseUrl: _assetBaseUrl,
    assets: _assets,
    providers: _providers,
    debug,
    runtimeProviders: _runtimeProviders,
    java,
    javaRuntimeAssetBaseUrl,
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
    csharpWorkerIdleTimeoutMs,
    cppWorkerIdleTimeoutMs,
    kernelStorage,
    onKernelStorageError,
    ...workspaceOptions
  } = options;
  const {
    python: injectedPythonProvider,
    java: injectedJavaProvider,
    csharp: injectedCSharpProvider,
    cpp: injectedCppProvider,
  } = runtimeProviders;
  const requestedExecutionHostProviders = executionHostOptions
    ? normalizeBrowserProjectProviders(
        executionHostOptions.providers ??
          providers.filter((provider) => provider !== 'java')
      )
    : [];
  if (executionHostOptions && requestedExecutionHostProviders.length === 0) {
    throw new TypeError(
      'executionHost.providers must select at least one non-Java project provider.'
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
  const injectedProviderSelections = [
    ['python', injectedPythonProvider],
    ['java', injectedJavaProvider],
    ['csharp', injectedCSharpProvider],
    ['cpp', injectedCppProvider],
  ] as const;
  for (const [provider, runtimeProvider] of injectedProviderSelections) {
    if (runtimeProvider && !hasProvider(provider)) {
      throw new Error(
        `runtimeProviders.${provider} requires providers to include ${JSON.stringify(provider)}.`
      );
    }
    if (runtimeProvider && typeof runtimeProvider.execute !== 'function') {
      throw new TypeError(
        `runtimeProviders.${provider} must define an execute function.`
      );
    }
    if (runtimeProvider && isExecutionHosted(provider)) {
      throw new Error(
        `executionHost.providers cannot include ${JSON.stringify(provider)} ` +
          `when runtimeProviders.${provider} is provided.`
      );
    }
  }
  if (java && !hasProvider('java')) {
    throw new Error('java requires providers to include "java".');
  }
  const builtInJavaAvailable =
    javaProvider !== undefined &&
    typeof Worker !== 'undefined';
  if (
    hasProvider('java') &&
    options.providers !== undefined &&
    !java &&
    !injectedJavaProvider &&
    !builtInJavaAvailable
  ) {
    throw new Error(
      'Browser project Java requires a Java 23 project provider. ' +
        'Provide java.createClient, runtimeProviders.java, or make the built-in TraceJVM provider available.'
    );
  }
  if (java && injectedJavaProvider) {
    throw new Error(
      'java and runtimeProviders.java are alternative Java project providers and cannot be combined.'
    );
  }
  if (isExecutionHosted('java')) {
    throw new Error(
      'Browser project Java providers own their Worker boundary; remove "java" from executionHost.providers.'
    );
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
  for (const provider of BROWSER_PROJECT_PREWARM_PROVIDERS) {
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
  if (injectedPythonProvider && projectPrewarm.python > 0) {
    throw new Error('projectWorkerPrewarm.python cannot be used with runtimeProviders.python.');
  }
  if (injectedCSharpProvider && projectPrewarm.csharp > 0) {
    throw new Error('projectWorkerPrewarm.csharp cannot be used with runtimeProviders.csharp.');
  }
  if (injectedCppProvider && projectPrewarm.cpp > 0) {
    throw new Error('projectWorkerPrewarm.cpp cannot be used with runtimeProviders.cpp.');
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
      const executionHostReady = executionHost.ready();
      void executionHostReady.catch(() => undefined);
    } catch (error) {
      executionHost.dispose();
      throw error;
    }
  }
  const ownedWorkers: Array<{ terminate(): void }> = [];
  try {
    const builtInJavaFactory =
      hasProvider('java') &&
      !java &&
      !injectedJavaProvider &&
      builtInJavaAvailable &&
      javaProvider
        ? javaProvider[2].createJavaProjectClientFactory({
            runtimeAssetBaseUrl: javaRuntimeAssetBaseUrl,
          })
        : undefined;
    if (builtInJavaFactory) ownedWorkers.push(builtInJavaFactory);
    const builtInJava: BrowserProjectJavaRuntimeOptions | undefined =
      builtInJavaFactory
        ? {
            createClient: builtInJavaFactory,
          }
        : undefined;
    const selectedJava = java ?? builtInJava;
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
    const cppCompilerWorkerFactory =
      executionHost && isExecutionHosted('cpp')
        ? executionHost.workerFactory
        : undefined;
    const cppRuntimeAssetPreflight =
      () => runtimeAssetPreflight.preflight('cpp', [
        'runtimeHeader',
        'compilerWasm',
        'linkerWasm',
        'sysroot',
      ]);
    const traceccCompilerService =
      cppProvider && !injectedCppProvider
      ? cppProvider[2].createTraceCCBrowserCompilerService({}, {
          assets,
          ...(cppCompilerWorkerFactory
            ? { workerFactory: cppCompilerWorkerFactory }
            : {}),
          preflight: (assetNames) =>
            runtimeAssetPreflight.preflight('cpp', assetNames),
        })
      : undefined;
    const cppWorkerOptions: CppWorkerClientOptions = {
      workerUrl: assets.cppWorker,
      ...(cppCompilerWorkerFactory
        ? { workerFactory: cppCompilerWorkerFactory }
        : {}),
      assetPreflight: () => runtimeAssetPreflight.preflight('cpp', ['worker']),
      runtimeAssetPreflight: cppRuntimeAssetPreflight,
      compilerWasmUrl: assets.cppCompilerWasm,
      linkerWasmUrl: assets.cppLinkerWasm,
      sysrootUrl: assets.cppSysroot,
      runtimeHeaderUrl: assets.cppRuntimeHeader,
      compilerIntegrity: assets.cppCompilerIntegrity,
      debug,
      workerIdleTimeoutMs: cppWorkerIdleTimeoutMs,
      ...(traceccCompilerService
        ? { trustedCompilerService: traceccCompilerService }
        : {}),
    };
    const PythonWorkerClientConstructor = pythonProvider?.[1].PythonWorkerClient;
    const pythonWorkerClient = hasProvider('python')
      ? injectedPythonProvider
        ? createInjectedPythonWorkerClient(injectedPythonProvider)
        : projectWorkerIsolation === 'per-command'
          ? createPerCommandPythonWorkerClient(
              projectPrewarm.python,
              () => new PythonWorkerClientConstructor!(pythonWorkerOptions)
            )
          : new PythonWorkerClientConstructor!(pythonWorkerOptions)
      : undefined;
    if (pythonWorkerClient && !injectedPythonProvider) {
      ownedWorkers.push(pythonWorkerClient);
    }
    const CSharpWorkerClientConstructor = csharpProvider?.[1].CSharpWorkerClient;
    const csharpWorkerClient = hasProvider('csharp')
      ? injectedCSharpProvider
        ? createInjectedCSharpWorkerClient(injectedCSharpProvider)
        : projectWorkerIsolation === 'per-command'
          ? createPerCommandCSharpWorkerClient(
              projectPrewarm.csharp,
              () => new CSharpWorkerClientConstructor!(csharpWorkerOptions)
            )
          : new CSharpWorkerClientConstructor!(csharpWorkerOptions)
      : undefined;
    if (csharpWorkerClient && !injectedCSharpProvider) {
      ownedWorkers.push(csharpWorkerClient);
    }
    const CppWorkerClientConstructor = cppProvider?.[1].CppWorkerClient;
    const cppWorkerClient = hasProvider('cpp')
      ? injectedCppProvider
        ? createInjectedCppWorkerClient(injectedCppProvider)
        : projectWorkerIsolation === 'per-command'
          ? createPerCommandCppWorkerClient(
              projectPrewarm.cpp,
              () => new CppWorkerClientConstructor!(cppWorkerOptions)
            )
          : new CppWorkerClientConstructor!(cppWorkerOptions)
      : undefined;
    if (cppWorkerClient && !injectedCppProvider) {
      ownedWorkers.push(cppWorkerClient);
    }
    if (traceccCompilerService) {
      ownedWorkers.push(traceccCompilerService);
    }

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
      ...(selectedJava && javaProvider
        ? {
            javaRunner: javaProvider[1].createJavaProjectRunner({
              ...selectedJava,
              timeoutMs: javaProjectTimeoutMs ?? selectedJava.timeoutMs,
            }),
          }
        : injectedJavaProvider && javaProvider
        ? {
            javaRunner: javaProvider[0].createBrowserJavaProjectRunner(
              createInjectedJavaWorkerClient(injectedJavaProvider),
              {
                timeoutMs: javaProjectTimeoutMs,
              }
            ),
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
