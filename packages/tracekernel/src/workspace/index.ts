/**
 * TraceKernel's stateful workspace implementation.
 *
 * Runtime-neutral contracts remain owned by `@tracecode/harness-core`; this
 * entrypoint exports only the implementation and configuration that
 * TraceKernel owns.
 */
export {
  RuntimeProjectWorkspace,
  createRuntimeWorkspace,
  JustBashRuntimeWorkspace,
} from './runtime-project-workspace';
export { RuntimeProjectWorkspaceTerminalSession } from './terminal-session';
export { createPackageManagerProjectCommands } from './package-manager';
export {
  syntheticIp,
  syntheticLatency,
  type HostResolution,
} from './http-state';
export {
  RUNTIME_WORKSPACE_DEFAULT_MAX_BYTES,
  RUNTIME_WORKSPACE_DEFAULT_MAX_ENTRY_COUNT,
  RUNTIME_WORKSPACE_DEFAULT_MAX_FILE_BYTES,
  normalizeRuntimeWorkspaceStorageLimits,
  type NormalizedRuntimeWorkspaceStorageLimits,
  type RuntimeWorkspaceStorageLimits,
} from './workspace-storage-policy';
export type {
  CppProjectCommandRequest,
  CppProjectCommandRunner,
  CreateRuntimeWorkspaceOptions,
  CSharpProjectCommandRequest,
  CSharpProjectCommandRunner,
  JavaProjectCommandRequest,
  JavaProjectCommandRunner,
  JavaScriptProjectCommandRequest,
  JavaScriptProjectCommandRunner,
  ProjectWorkspaceCommand,
  ProjectWorkspaceExecutionLimits,
  ProjectWorkspaceJavaScriptConfig,
  PythonProjectCommandRequest,
  PythonProjectCommandRunner,
  RuntimePackageDependencyProvider,
  RuntimePackageInstallRequest,
  RuntimePackageManagerConfig,
  RuntimePackageManagerName,
  RuntimePackageManifest,
  RuntimeTraceKernelControlOptions,
  TypeScriptProjectCommandRequest,
  TypeScriptProjectCommandRunner,
} from './workspace-options';
export {
  createPythonProjectCommands,
  createNodeProjectCommands,
  createTypeScriptProjectCommands,
  createJavaProjectCommands,
  createCppProjectCommands,
  createCSharpProjectCommands,
} from './language-commands';
