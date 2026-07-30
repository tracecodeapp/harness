import type {
  RuntimeCommandExecutionLimits,
  RuntimeExternalHttpConfig,
  RuntimeFile,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectHiddenCommandAccess,
  RuntimeProjectSession,
  RuntimeProjectSnapshot,
  RuntimeSymlink,
  RuntimeDirectory,
  RuntimeTraceKernelConfig,
} from '@tracecode/harness-core';
import type { CustomCommand } from 'just-bash/browser';
import type { RuntimeWorkspaceStorageLimits } from './workspace-storage-policy';

export type ProjectWorkspaceCommand = CustomCommand;

export interface ProjectWorkspaceJavaScriptConfig {
  bootstrap?: string;
  invokeTool?: (path: string, argsJson: string) => Promise<string>;
}

export interface ProjectWorkspaceExecutionLimits extends RuntimeCommandExecutionLimits {}

export type RuntimePackageManagerName = 'npm';

export interface RuntimePackageManifest {
  path: string;
  directory: string;
  json: Record<string, unknown>;
}

export interface RuntimePackageInstallRequest {
  manager: RuntimePackageManagerName;
  command: 'install' | 'ci' | 'add';
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  manifest: RuntimePackageManifest;
  project: RuntimeProjectSnapshot;
  signal?: AbortSignal;
}

export interface RuntimePackageDependencyProvider {
  install(request: RuntimePackageInstallRequest): Promise<import('@tracecode/harness-core').RuntimeCommandResult>;
}

export interface RuntimePackageManagerConfig {
  managers?: readonly RuntimePackageManagerName[];
  dependencyProvider?: RuntimePackageDependencyProvider;
  autoLinkBins?: boolean;
  npmVersion?: string;
}

export type PythonProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin' | 'module'
>;

export type PythonProjectCommandRunner = RuntimeProjectCommandRunner<PythonProjectCommandRequest>;

export type JavaScriptProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin'
>;

export type JavaScriptProjectCommandRunner =
  RuntimeProjectCommandRunner<JavaScriptProjectCommandRequest>;

export type TypeScriptProjectCommandRequest = RuntimeProjectCommandRequest<'compile'>;

export type TypeScriptProjectCommandRunner =
  RuntimeProjectCommandRunner<TypeScriptProjectCommandRequest>;

export type JavaProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type JavaProjectCommandRunner = RuntimeProjectCommandRunner<JavaProjectCommandRequest>;

export type CppProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type CppProjectCommandRunner = RuntimeProjectCommandRunner<CppProjectCommandRequest>;

export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type CSharpProjectCommandRunner = RuntimeProjectCommandRunner<CSharpProjectCommandRequest>;

export interface RuntimeTraceKernelControlOptions {
  reset?: () => Promise<void> | void;
}

/**
 * Construction options for the compatibility workspace façade.
 *
 * The `Project` names in this module remain only because they are part of the
 * 0.13 public API. New internal modules use workspace, process, and runtime
 * terminology so these aliases can disappear at the 0.14 boundary.
 */
export interface CreateRuntimeWorkspaceOptions {
  projectSession?: RuntimeProjectSession;
  hiddenCommandAccess?: RuntimeProjectHiddenCommandAccess;
  files?: readonly RuntimeFile[];
  symlinks?: readonly RuntimeSymlink[];
  directories?: readonly string[];
  directoryMetadata?: readonly RuntimeDirectory[];
  skills?: readonly RuntimeFile[];
  entrypoint?: string;
  cwd?: string;
  env?: Record<string, string>;
  commands?: readonly string[];
  customCommands?: readonly ProjectWorkspaceCommand[];
  pythonRunner?: PythonProjectCommandRunner;
  nodeRunner?: JavaScriptProjectCommandRunner;
  javaRunner?: JavaProjectCommandRunner;
  typescriptRunner?: TypeScriptProjectCommandRunner;
  cppRunner?: CppProjectCommandRunner;
  csharpRunner?: CSharpProjectCommandRunner;
  packageManager?: boolean | RuntimePackageManagerConfig;
  python?: boolean;
  javascript?: boolean | ProjectWorkspaceJavaScriptConfig;
  executionLimits?: ProjectWorkspaceExecutionLimits;
  /**
   * Logical storage limits for the in-browser workspace filesystem. Limits
   * include hidden/session entries and are enforced before mutation commit.
   */
  storageLimits?: RuntimeWorkspaceStorageLimits;
  externalHttp?: RuntimeExternalHttpConfig;
  kernel?: RuntimeTraceKernelConfig;
  kernelControl?: RuntimeTraceKernelControlOptions;
}
