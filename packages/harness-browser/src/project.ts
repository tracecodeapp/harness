import type {
  RuntimeDirectoryChange,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeWorkspace,
} from '../../harness-core/src/runtime-project';
import {
  createRuntimeWorkspace,
  normalizeRuntimeProjectPath,
  type CreateRuntimeWorkspaceOptions,
} from '../../harness-project/src/index';
import { createBrowserCSharpProjectRunner } from '../../harness-csharp/src/project-browser';
import { createBrowserCppProjectRunner } from '../../harness-cpp/src/project-browser';
import { createBrowserJavaProjectRunner } from '../../harness-java/src/project-browser';
import {
  createBrowserJavaScriptProjectRunner,
  createBrowserTypeScriptProjectRunner,
  type BrowserJavaScriptProjectRunnerOptions,
  type BrowserTypeScriptProjectRunnerOptions,
} from '../../harness-javascript/src/project-browser';
import { createBrowserPythonProjectRunner } from '../../harness-python/src/project-browser';
import { CSharpWorkerClient, type CSharpWorkerClientOptions } from './csharp-worker-client';
import { CppWorkerClient, type CppWorkerClientOptions } from './cpp-worker-client';
import { JavaWorkerClient, type JavaWorkerClientOptions } from './java-worker-client';
import { PythonWorkerClient, type PythonWorkerClientOptions } from './pyodide-worker-client';
import {
  resolveBrowserHarnessAssets,
  type BrowserHarnessAssetOverrides,
} from './runtime-assets';
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
} from '../../harness-project/src/index';

export type BrowserProjectWorkspace = RuntimeWorkspace;
export type BrowserProjectNodeOptions = Omit<BrowserJavaScriptProjectRunnerOptions, 'applyFileChange'>;
export type BrowserProjectTypeScriptOptions = BrowserTypeScriptProjectRunnerOptions;
export type BrowserProjectWorkerIsolation = 'shared' | 'per-command';

function readonlySessionFiles(options: CreateRuntimeWorkspaceOptions): string[] {
  return [...new Set((options.projectSession?.files ?? [])
    .filter((file) => file.readonly === true || file.hidden === true)
    .map((file) => normalizeRuntimeProjectPath(file.path)))];
}

function hiddenSessionFiles(options: CreateRuntimeWorkspaceOptions): NonNullable<CreateRuntimeWorkspaceOptions['projectSession']>['files'] {
  return (options.projectSession?.files ?? []).filter((file) => file.hidden === true);
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

function createPerCommandPythonWorkerClient(options: PythonWorkerClientOptions): Pick<PythonWorkerClient, 'executeProjectPython' | 'terminate'> {
  const active = new Set<PythonWorkerClient>();
  return {
    async executeProjectPython(request, timeoutMs, onEvent, signal) {
      const client = new PythonWorkerClient(options);
      active.add(client);
      try {
        return await client.executeProjectPython(request, timeoutMs, onEvent, signal);
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

function createPerCommandJavaWorkerClient(options: JavaWorkerClientOptions): Pick<JavaWorkerClient, 'executeProjectJava' | 'terminate'> {
  const active = new Set<JavaWorkerClient>();
  return {
    async executeProjectJava(request, timeoutMs, onEvent, signal) {
      const client = new JavaWorkerClient(options);
      active.add(client);
      try {
        return await client.executeProjectJava(request, timeoutMs, onEvent, signal);
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

function createPerCommandCSharpWorkerClient(options: CSharpWorkerClientOptions): Pick<CSharpWorkerClient, 'executeProjectCSharp' | 'terminate'> {
  const active = new Set<CSharpWorkerClient>();
  return {
    async executeProjectCSharp(request, timeoutMs, onEvent, signal) {
      const client = new CSharpWorkerClient(options);
      active.add(client);
      try {
        return await client.executeProjectCSharp(request, timeoutMs, onEvent, signal);
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

function createPerCommandCppWorkerClient(options: CppWorkerClientOptions): Pick<CppWorkerClient, 'executeProjectCpp' | 'terminate'> {
  const active = new Set<CppWorkerClient>();
  return {
    async executeProjectCpp(request, timeoutMs, onEvent, signal) {
      const client = new CppWorkerClient(options);
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
  debug?: boolean;
  pythonWorkerClient?: Pick<PythonWorkerClient, 'executeProjectPython' | 'terminate'>;
  javaWorkerClient?: Pick<JavaWorkerClient, 'executeProjectJava' | 'terminate'>;
  csharpWorkerClient?: Pick<CSharpWorkerClient, 'executeProjectCSharp' | 'terminate'>;
  cppWorkerClient?: Pick<CppWorkerClient, 'executeProjectCpp' | 'terminate'>;
  nodeProject?: BrowserProjectNodeOptions;
  typescriptProject?: BrowserProjectTypeScriptOptions;
  projectWorkerIsolation?: BrowserProjectWorkerIsolation;
  nodeProjectTimeoutMs?: number;
  pythonProjectTimeoutMs?: number;
  javaProjectTimeoutMs?: number;
  csharpProjectTimeoutMs?: number;
  cppProjectTimeoutMs?: number;
  javaWorkerIdleTimeoutMs?: number;
  csharpWorkerIdleTimeoutMs?: number;
  cppWorkerIdleTimeoutMs?: number;
  kernelStorage?: BrowserKernelStorage;
}

export async function createBrowserProjectWorkspace(
  options: CreateBrowserProjectWorkspaceOptions = {}
): Promise<BrowserProjectWorkspace> {
  const assets = resolveBrowserHarnessAssets(options);
  const {
    assetBaseUrl: _assetBaseUrl,
    assets: _assets,
    debug,
    pythonWorkerClient: providedPythonWorkerClient,
    javaWorkerClient: providedJavaWorkerClient,
    csharpWorkerClient: providedCSharpWorkerClient,
    cppWorkerClient: providedCppWorkerClient,
    nodeProject,
    typescriptProject,
    projectWorkerIsolation = 'per-command',
    nodeProjectTimeoutMs,
    pythonProjectTimeoutMs,
    javaProjectTimeoutMs,
    csharpProjectTimeoutMs,
    cppProjectTimeoutMs,
    javaWorkerIdleTimeoutMs,
    csharpWorkerIdleTimeoutMs,
    cppWorkerIdleTimeoutMs,
    kernelStorage,
    ...workspaceOptions
  } = options;
  const ownedWorkers: Array<{ terminate(): void }> = [];
  const pythonWorkerOptions: PythonWorkerClientOptions = {
    workerUrl: assets.pythonWorker,
    debug,
  };
  const javaWorkerOptions: JavaWorkerClientOptions = {
    workerUrl: assets.javaWorker,
    debug,
    workerIdleTimeoutMs: javaWorkerIdleTimeoutMs,
  };
  const csharpWorkerOptions: CSharpWorkerClientOptions = {
    workerUrl: assets.csharpWorker,
    assetBaseUrl: assets.csharpAssetBaseUrl,
    debug,
    workerIdleTimeoutMs: csharpWorkerIdleTimeoutMs,
  };
  const cppWorkerOptions: CppWorkerClientOptions = {
    workerUrl: assets.cppWorker,
    compilerFrameUrl: assets.cppCompilerFrame,
    compilerWorkerUrl: assets.cppCompilerWorker,
    clangWasmUrl: assets.cppClangWasm,
    lldWasmUrl: assets.cppLldWasm,
    sysrootUrl: assets.cppSysroot,
    runtimeHeaderUrl: assets.cppRuntimeHeader,
    compilerBundleUrl: assets.cppCompilerBundle,
    debug,
    workerIdleTimeoutMs: cppWorkerIdleTimeoutMs,
  };
  const pythonWorkerClient =
    providedPythonWorkerClient ??
    (projectWorkerIsolation === 'per-command'
      ? createPerCommandPythonWorkerClient(pythonWorkerOptions)
      : new PythonWorkerClient(pythonWorkerOptions));
  const javaWorkerClient =
    providedJavaWorkerClient ??
    (projectWorkerIsolation === 'per-command'
      ? createPerCommandJavaWorkerClient(javaWorkerOptions)
      : new JavaWorkerClient(javaWorkerOptions));
  const csharpWorkerClient =
    providedCSharpWorkerClient ??
    (projectWorkerIsolation === 'per-command'
      ? createPerCommandCSharpWorkerClient(csharpWorkerOptions)
      : new CSharpWorkerClient(csharpWorkerOptions));
  const cppWorkerClient =
    providedCppWorkerClient ??
    (projectWorkerIsolation === 'per-command'
      ? createPerCommandCppWorkerClient(cppWorkerOptions)
      : new CppWorkerClient(cppWorkerOptions));

  if (!providedPythonWorkerClient) ownedWorkers.push(pythonWorkerClient);
  if (!providedJavaWorkerClient) ownedWorkers.push(javaWorkerClient);
  if (!providedCSharpWorkerClient) ownedWorkers.push(csharpWorkerClient);
  if (!providedCppWorkerClient) ownedWorkers.push(cppWorkerClient);

  let workspace: BrowserProjectWorkspace;
  let storageBinding: BrowserKernelStorageBinding | undefined;
  const sessionReadonlyFiles = readonlySessionFiles(workspaceOptions);
  const applyWorkerFileChange: NonNullable<Parameters<typeof createBrowserPythonProjectRunner>[1]>['applyFileChange'] =
    async (change, phase) => {
      await workspace.kernel.applyFileChange(change, undefined, phase);
      return false;
    };
  const applyCSharpWorkerFileChange: NonNullable<Parameters<typeof createBrowserCSharpProjectRunner>[1]>['applyFileChange'] =
    async (change, phase) => {
      if (isReadonlyDeletion(change, sessionReadonlyFiles)) return false;
      await workspace.kernel.applyFileChange(change, undefined, phase);
      return false;
    };

  const storedSnapshot = await hydrateBrowserKernelStorage(kernelStorage);
  const hasStoredWorkspace = storedSnapshot && (
    storedSnapshot.files.length > 0 ||
    (storedSnapshot.directories?.length ?? 0) > 0
  );
  const hiddenFiles = hiddenSessionFiles(workspaceOptions);
  const projectSession = hasStoredWorkspace && workspaceOptions.projectSession
    ? {
        ...workspaceOptions.projectSession,
        files: hiddenFiles,
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
    pythonRunner: createBrowserPythonProjectRunner(pythonWorkerClient, {
      timeoutMs: pythonProjectTimeoutMs,
      applyFileChange: applyWorkerFileChange,
    }),
    nodeRunner: createBrowserJavaScriptProjectRunner({
      timeoutMs: nodeProjectTimeoutMs,
      workerUrl: assets.javascriptProjectWorker,
      workerIsolation: projectWorkerIsolation,
      ...nodeProject,
      applyFileChange: applyWorkerFileChange,
    }),
    typescriptRunner: createBrowserTypeScriptProjectRunner({
      compilerUrl: assets.typescriptCompiler,
      ...typescriptProject,
    }),
    javaRunner: createBrowserJavaProjectRunner(javaWorkerClient, {
      timeoutMs: javaProjectTimeoutMs,
      applyFileChange: applyWorkerFileChange,
    }),
    csharpRunner: createBrowserCSharpProjectRunner(csharpWorkerClient, {
      timeoutMs: csharpProjectTimeoutMs,
      applyFileChange: applyCSharpWorkerFileChange,
    }),
    cppRunner: createBrowserCppProjectRunner(cppWorkerClient, {
      timeoutMs: cppProjectTimeoutMs,
      applyFileChange: applyWorkerFileChange,
    }),
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

  storageBinding = bindBrowserKernelStorage(workspace, kernelStorage);
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
      void storageBinding?.flush();
      disposeWorkspace();
      for (const worker of ownedWorkers) {
        worker.terminate();
      }
    },
  });
}
