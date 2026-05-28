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
} from '../../harness-javascript/src/project-browser';
import { createBrowserPythonProjectRunner } from '../../harness-python/src/project-browser';
import { CSharpWorkerClient } from './csharp-worker-client';
import { CppWorkerClient } from './cpp-worker-client';
import { JavaWorkerClient } from './java-worker-client';
import { PythonWorkerClient } from './pyodide-worker-client';
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
  const pythonWorkerClient =
    providedPythonWorkerClient ??
    new PythonWorkerClient({
      workerUrl: assets.pythonWorker,
      debug,
    });
  const javaWorkerClient =
    providedJavaWorkerClient ??
    new JavaWorkerClient({
      workerUrl: assets.javaWorker,
      debug,
      workerIdleTimeoutMs: javaWorkerIdleTimeoutMs,
    });
  const csharpWorkerClient =
    providedCSharpWorkerClient ??
    new CSharpWorkerClient({
      workerUrl: assets.csharpWorker,
      assetBaseUrl: assets.csharpAssetBaseUrl,
      debug,
      workerIdleTimeoutMs: csharpWorkerIdleTimeoutMs,
    });
  const cppWorkerClient =
    providedCppWorkerClient ??
    new CppWorkerClient({
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
    });

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
      ...nodeProject,
      applyFileChange: applyWorkerFileChange,
    }),
    typescriptRunner: createBrowserTypeScriptProjectRunner({
      compilerUrl: assets.typescriptCompiler,
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
