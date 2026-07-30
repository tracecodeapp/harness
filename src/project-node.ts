export {
  createRuntimeWorkspace,
  RuntimeProjectWorkspace,
  JustBashRuntimeWorkspace,
} from '@tracecode/tracekernel/workspace';

export {
  createRuntimeProjectHiddenCommandAccess,
  normalizeRuntimeProjectPath,
  runtimeHttpBodyBytes,
  runtimeHttpBodyFromBytes,
  runtimeHttpBodyFromText,
  runtimeHttpBodyText,
  runtimeHttpRequestBytes,
  runtimeHttpRequestText,
  runtimeHttpResponseBytes,
  runtimeHttpResponseText,
} from '@tracecode/harness-core';

export type {
  CreateRuntimeWorkspaceOptions,
  ProjectWorkspaceCommand,
  ProjectWorkspaceJavaScriptConfig,
  ProjectWorkspaceExecutionLimits,
  RuntimeTraceKernelControlOptions,
  RuntimePackageManagerName,
  RuntimePackageManifest,
  RuntimePackageInstallRequest,
  RuntimePackageDependencyProvider,
  RuntimePackageManagerConfig,
  PythonProjectCommandRequest,
  PythonProjectCommandRunner,
  JavaScriptProjectCommandRequest,
  JavaScriptProjectCommandRunner,
  TypeScriptProjectCommandRequest,
  TypeScriptProjectCommandRunner,
  JavaProjectCommandRequest,
  JavaProjectCommandRunner,
  CppProjectCommandRequest,
  CppProjectCommandRunner,
  CSharpProjectCommandRequest,
  CSharpProjectCommandRunner,
} from '@tracecode/tracekernel/workspace';

export type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandEventStream,
  RuntimeCommandFileChangeEvent,
  RuntimeCommandOutputEvent,
  RuntimeCommandStatusEvent,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeKernelHostConfig,
  RuntimeKernelHostInfo,
  RuntimeKernelInfo,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpBodyInit,
  RuntimeKernelHttpBodyPayload,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpListenerInfo,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeKernelUserConfig,
  RuntimeKernelUserInfo,
  RuntimeKernelWorkspaceConfig,
  RuntimeKernelWorkspaceInfo,
  RuntimeTraceKernelSchedulerConfig,
  RuntimeKernelDevicePath,
  RuntimeFileMutationPhase,
  RuntimeTraceKernelConfig,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectTerminalPrompt,
  RuntimeProjectTerminalEvent,
  RuntimeProjectTerminalEventHandler,
  RuntimeProjectTerminalInputState,
  RuntimeProjectTerminalInputStateReason,
  RuntimeProjectTerminalRunOptions,
  RuntimeProjectTerminalSession,
  RuntimeProjectTerminalSessionOptions,
  RuntimeProjectSession,
  RuntimeProjectSessionCommand,
  RuntimeProjectSessionCommandDefinition,
  RuntimeProjectSessionFile,
  RuntimeProjectSessionInfo,
  RuntimeProjectIoBridge,
  RuntimeProjectPatch,
  RuntimeProjectPatchBase,
  RuntimeProjectPatchChange,
  RuntimeProjectPatchDirectoryCreate,
  RuntimeProjectPatchDirectoryDelete,
  RuntimeProjectPatchFileDelete,
  RuntimeProjectPatchFileWrite,
  RuntimeProjectPatchOptions,
  RuntimeProjectLiveIoControllerOptions,
  RuntimeProjectWorkerBridgeOptions,
  RuntimeProjectSnapshot,
  RuntimeWorkspace,
  RuntimeWorkspaceActor,
  RuntimeWorkspaceActorKind,
  RuntimeWorkspaceCapabilities,
  RuntimeWorkspaceEvent,
  RuntimeWorkspaceEventHandler,
  RuntimeWorkspaceHttpClient,
  RuntimeWorkspaceHttpJsonRequestOptions,
  RuntimeWorkspaceHttpJsonResponse,
  RuntimeWorkspaceHttpRequestOptions,
  RuntimeWorkspaceKernel,
  RuntimeWorkspaceRemoveOptions,
  RuntimeWorkspaceStat,
  RuntimeWorkspaceUnsubscribe,
} from '@tracecode/harness-core';

import {
  createRuntimeWorkspace,
  type CreateRuntimeWorkspaceOptions,
  type RuntimeProjectWorkspace,
} from '@tracecode/tracekernel/workspace';
import { createNativeCppProjectRunner } from '../packages/harness-cpp/src/project-node';
import { createNativeCSharpProjectRunner } from '../packages/harness-csharp/src/project-node';
import { createNativeJavaProjectRunner } from '../packages/harness-java/src/project-node';
import { createNativeJavaScriptProjectRunner, createTypeScriptProjectRunner } from '../packages/harness-javascript/src/project-node';
import { createNativePythonProjectRunner } from '../packages/harness-python/src/project-node';

export interface CreateNativeProjectWorkspaceOptions
  extends Omit<
    CreateRuntimeWorkspaceOptions,
    'pythonRunner' | 'nodeRunner' | 'typescriptRunner' | 'javaRunner' | 'cppRunner' | 'csharpRunner'
  > {
  pythonCommand?: string;
  nodeCommand?: string;
  javacCommand?: string;
  javaCommand?: string;
  cppCompilerCommand?: string;
  runtimeCommand?: string;
  pythonProjectTimeoutMs?: number;
  nodeProjectTimeoutMs?: number;
  javaProjectTimeoutMs?: number;
  cppProjectTimeoutMs?: number;
  csharpProjectTimeoutMs?: number;
  keepNativeTempDirs?: boolean;
}

export async function createNativeProjectWorkspace(
  options: CreateNativeProjectWorkspaceOptions = {}
): Promise<RuntimeProjectWorkspace> {
  const {
    pythonCommand,
    nodeCommand,
    javacCommand,
    javaCommand,
    cppCompilerCommand,
    runtimeCommand,
    pythonProjectTimeoutMs,
    nodeProjectTimeoutMs,
    javaProjectTimeoutMs,
    cppProjectTimeoutMs,
    csharpProjectTimeoutMs,
    keepNativeTempDirs,
    ...workspaceOptions
  } = options;

  return createRuntimeWorkspace({
    ...workspaceOptions,
    pythonRunner: createNativePythonProjectRunner({
      pythonCommand,
      timeoutMs: pythonProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
    nodeRunner: createNativeJavaScriptProjectRunner({
      nodeCommand,
      timeoutMs: nodeProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
    typescriptRunner: createTypeScriptProjectRunner(),
    javaRunner: createNativeJavaProjectRunner({
      javacCommand,
      javaCommand,
      timeoutMs: javaProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
    cppRunner: createNativeCppProjectRunner({
      compilerCommand: cppCompilerCommand,
      timeoutMs: cppProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
    csharpRunner: createNativeCSharpProjectRunner({
      runtimeCommand,
      timeoutMs: csharpProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
  });
}
