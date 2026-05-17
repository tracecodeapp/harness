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

export type BrowserProjectWorkspace = RuntimeWorkspace;

export interface CreateBrowserProjectWorkspaceOptions
  extends Omit<CreateRuntimeWorkspaceOptions, 'pythonRunner' | 'nodeRunner' | 'javaRunner' | 'csharpRunner' | 'cppRunner'> {
  assetBaseUrl?: string;
  assets?: BrowserHarnessAssetOverrides;
  debug?: boolean;
  pythonWorkerClient?: Pick<PythonWorkerClient, 'executeProjectPython' | 'terminate'>;
  javaWorkerClient?: Pick<JavaWorkerClient, 'executeProjectJava' | 'terminate'>;
  csharpWorkerClient?: Pick<CSharpWorkerClient, 'executeProjectCSharp' | 'terminate'>;
  cppWorkerClient?: Pick<CppWorkerClient, 'executeProjectCpp' | 'terminate'>;
  nodeProject?: BrowserJavaScriptProjectRunnerOptions;
  nodeProjectTimeoutMs?: number;
  pythonProjectTimeoutMs?: number;
  javaProjectTimeoutMs?: number;
  csharpProjectTimeoutMs?: number;
  cppProjectTimeoutMs?: number;
  javaWorkerIdleTimeoutMs?: number;
  csharpWorkerIdleTimeoutMs?: number;
  cppWorkerIdleTimeoutMs?: number;
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

  const workspace = await createRuntimeWorkspace({
    ...workspaceOptions,
    pythonRunner: createBrowserPythonProjectRunner(pythonWorkerClient, {
      timeoutMs: pythonProjectTimeoutMs,
    }),
    nodeRunner: createBrowserJavaScriptProjectRunner({
      timeoutMs: nodeProjectTimeoutMs,
      ...nodeProject,
    }),
    javaRunner: createBrowserJavaProjectRunner(javaWorkerClient, {
      timeoutMs: javaProjectTimeoutMs,
    }),
    csharpRunner: createBrowserCSharpProjectRunner(csharpWorkerClient, {
      timeoutMs: csharpProjectTimeoutMs,
    }),
    cppRunner: createBrowserCppProjectRunner(cppWorkerClient, {
      timeoutMs: cppProjectTimeoutMs,
    }),
  });

  return Object.assign(workspace, {
    dispose() {
      for (const worker of ownedWorkers) {
        worker.terminate();
      }
    },
  });
}
