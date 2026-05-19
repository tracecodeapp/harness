import type { RuntimeWorkspace } from '../../harness-core/src/runtime-project';
import {
  createRuntimeWorkspace,
  type CreateRuntimeWorkspaceOptions,
} from '../../harness-project/src/index';
import { createBrowserCSharpProjectRunner } from '../../harness-csharp/src/project-browser';
import { createBrowserCppProjectRunner } from '../../harness-cpp/src/project-browser';
import { createBrowserJavaProjectRunner } from '../../harness-java/src/project-browser';
import {
  createBrowserJavaScriptProjectRunner,
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
} from './kernel-storage';

export {
  createIndexedDbKernelStorage,
  type BrowserKernelStorage,
  type BrowserKernelStorageBinding,
  type BrowserKernelStorageSnapshot,
  type IndexedDbKernelStorageOptions,
} from './kernel-storage';

export type BrowserProjectWorkspace = RuntimeWorkspace;
export type BrowserProjectNodeOptions = Omit<BrowserJavaScriptProjectRunnerOptions, 'applyFileChange'>;

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
  const applyWorkerFileChange: NonNullable<Parameters<typeof createBrowserPythonProjectRunner>[1]>['applyFileChange'] =
    async (change, phase) => {
      await workspace.kernel.applyFileChange(change, undefined, phase);
      return false;
    };

  const storedSnapshot = await hydrateBrowserKernelStorage(kernelStorage);
  const hasStoredWorkspace = storedSnapshot && (
    storedSnapshot.files.length > 0 ||
    (storedSnapshot.directories?.length ?? 0) > 0
  );
  const projectSession = hasStoredWorkspace && workspaceOptions.projectSession
    ? {
        ...workspaceOptions.projectSession,
        files: [],
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
      ...nodeProject,
      applyFileChange: applyWorkerFileChange,
    }),
    javaRunner: createBrowserJavaProjectRunner(javaWorkerClient, {
      timeoutMs: javaProjectTimeoutMs,
      applyFileChange: applyWorkerFileChange,
    }),
    csharpRunner: createBrowserCSharpProjectRunner(csharpWorkerClient, {
      timeoutMs: csharpProjectTimeoutMs,
      applyFileChange: applyWorkerFileChange,
    }),
    cppRunner: createBrowserCppProjectRunner(cppWorkerClient, {
      timeoutMs: cppProjectTimeoutMs,
      applyFileChange: applyWorkerFileChange,
    }),
  });

  const storageBinding = bindBrowserKernelStorage(workspace, kernelStorage);
  await persistInitialBrowserKernelSnapshot(workspace, kernelStorage);
  const disposeWorkspace = workspace.dispose.bind(workspace);

  return Object.assign(workspace, {
    dispose() {
      storageBinding.dispose();
      void storageBinding.flush();
      disposeWorkspace();
      for (const worker of ownedWorkers) {
        worker.terminate();
      }
    },
  });
}
