import {
  defineCommand,
} from 'just-bash/browser';
import {
  assertRuntimeFinalDiffBudget,
  applyRuntimeCommandResultFiles,
  canCreateRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipeFromText,
  readRuntimeCommandStdinPipeBytes,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES,
  RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES,
  runtimeCommandStdinPipeClosed,
  runtimeFileChangePath,
  runtimeProjectTruncateUtf8,
  runtimeProjectUtf8Bytes,
} from '@tracecode/harness-core';
import {
  isRuntimeKernelVirtualNamespacePath,
  normalizeRuntimeProcPath,
  runtimeDeviceDirEntries,
  runtimeDeviceEntryKind,
  runtimeDeviceInputSource,
  runtimeDeviceOutputTarget,
  runtimeKernelAccessTarget,
  runtimeKernelDeviceInputRoute,
  runtimeKernelDeviceOutputRoute,
  runtimeKernelDirectoryTarget,
  runtimeKernelFileCopyTarget,
  runtimeKernelFileReadErrorCode,
  runtimeKernelFileReadFsErrorMessage,
  runtimeKernelFileReadTarget,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataErrorMessage,
  runtimeKernelMetadataErrorCode,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationErrorMessage,
  runtimeKernelMutationErrorCode,
  runtimeKernelMutationTarget,
  runtimeKernelReadErrorMessage,
  runtimeKernelReadTarget,
  runtimeKernelRenameTarget,
  runtimeKernelRemoveTarget,
  runtimeKernelStatTarget,
  runtimeKernelSymlinkTarget,
  runtimeKernelVirtualDevices,
  runtimeKernelVirtualFiles,
  runtimeKernelVirtualPaths,
  runtimeKernelWriteErrorCode,
  runtimeKernelWriteFsErrorMessage,
  runtimeKernelWriteTarget,
  publicRuntimeKernelVirtualFiles,
  publicRuntimeKernelInfo,
  readPublicRuntimeProcFile,
  readRuntimeProcFile,
  createRuntimeKernelReadonlyFileError,
  type RuntimeKernelVirtualStat,
} from '@tracecode/harness-core';
import { getLanguageRuntimeInfo } from '@tracecode/harness-core';
import type { Language } from '@tracecode/harness-core';
import type {
  CommandContext,
  FileContent,
  IFileSystem,
} from 'just-bash/browser';
import type {
  RuntimeCommandResult,
  RuntimeCommandEventStream,
  RuntimeCommandExecutionLimits,
  RuntimeCommandError,
  RuntimeKernelDevicePath,
  RuntimeFileMutationPhase,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeSymlink,
  RuntimeDirectory,
  RuntimeDirectoryChange,
  RuntimeFileEncoding,
  RuntimeKernelInfo,
  RuntimeTraceKernelConfig,
  RuntimeTraceKernelSchedulerConfig,
  RuntimeProjectSession,
  RuntimeProjectSessionCommand,
  RuntimeProjectSessionCommandDefinition,
  RuntimeProjectSessionCommandStep,
  RuntimeProjectSessionInfo,
  RuntimeProjectPatch,
  RuntimeProjectPatchBase,
  RuntimeProjectPatchChange,
  RuntimeProjectPatchFileWrite,
  RuntimeProjectSnapshot,
  RuntimeWorkspaceActor,
  RuntimeCommandEventHandler,
  RuntimeCommandOptions,
  RuntimeProjectLiveIoController,
} from '@tracecode/harness-core';
import type {
  CppProjectCommandRunner,
  CSharpProjectCommandRunner,
  CreateRuntimeWorkspaceOptions,
  JavaProjectCommandRunner,
  JavaScriptProjectCommandRunner,
  ProjectWorkspaceCommand,
  PythonProjectCommandRunner,
  RuntimePackageDependencyProvider,
  RuntimePackageInstallRequest,
  RuntimePackageManagerConfig,
  RuntimePackageManagerName,
  RuntimePackageManifest,
  NormalizedRuntimeWorkspaceStorageLimits,
  TypeScriptProjectCommandRunner,
} from './index';
import { TRACEKERNEL_BIN_PATH, TRACEKERNEL_SKILLS_ROOT } from './constants';
import { assertNoNul, dirname, isRuntimeSkillsNamespacePath, isWithinWorkspace, mapWorkspaceAlias, normalizeRuntimeProjectPath, normalizeRuntimeSkillPath, normalizeRuntimeSkillsVirtualPath, normalizeWorkspaceCwd, resolveWorkspaceCommandPath, toProjectDirectoryPath, toProjectPath, toWorkspaceEntryPath, toWorkspacePath } from './paths';
import { RuntimeFileGenerationConflictError, RuntimeFileSystemLockCoordinator, fsMutationGenerationPaths, fsMutationLockRequests, normalizeFsLockPath, type RuntimeFileSystemLockRequest, type RuntimeFileSystemMutationKind } from './locks';
import { RuntimeKernelInterruptedError } from './scheduler';
import type { RuntimeProjectWorkspace } from './index';

export interface RuntimeDynamicProcEntry {
  name: string;
  kind: 'file' | 'directory';
}

export interface RuntimeDynamicProcProvider {
  readFile(path: string, context?: RuntimeCommandExecutionContext): string | null;
  readDir(path: string, context?: RuntimeCommandExecutionContext): RuntimeDynamicProcEntry[] | null;
  entryKind(path: string, context?: RuntimeCommandExecutionContext): 'file' | 'directory' | null;
  stat(path: string, context?: RuntimeCommandExecutionContext): RuntimeKernelVirtualStat | null;
  readonlyNamespace(path: string): boolean;
}



export type RuntimeFileSystemGenerationSnapshot = ReadonlyMap<string, number>;

export interface RuntimeFileSystemCommandGenerationContext {
  readonly baseline: RuntimeFileSystemGenerationSnapshot;
  readonly mutatedPaths: Set<string>;
  readonly pid: number;
  readonly signal: AbortSignal;
  setError(error: RuntimeCommandError): void;
}


export interface RuntimeFileSystemSyscallEvent {
  type:
    | 'fs-syscall-start'
    | 'fs-syscall-commit'
    | 'fs-syscall-abort'
    | 'fs-transaction-start'
    | 'fs-transaction-commit'
    | 'fs-transaction-abort';
  pid?: number;
  detail: Record<string, unknown>;
}


export interface RuntimeCommandExecutionContext {
  readonly eventHandler?: RuntimeCommandEventHandler;
  readonly actor: RuntimeWorkspaceActor;
  readonly process: {
    readonly pid: number;
    readonly abortController?: AbortController;
    [key: string]: any;
  };
  readonly stdinPipe?: RuntimeCommandOptions['stdinPipe'];
  readonly terminal?: RuntimeCommandOptions['terminal'];
  umask: number;
  readonly onUmaskChange?: RuntimeCommandOptions['onUmaskChange'];
  readonly includeHiddenFiles?: boolean;
  readonly runtimeIo: RuntimeProjectLiveIoController;
  readonly generationBaseline: RuntimeFileSystemGenerationSnapshot;
  readonly mutatedGenerationPaths: Set<string>;
  kernelError?: RuntimeCommandError;
  executableTransformCwd?: string;
  deviceStdout: string;
  deviceStderr: string;
  outputBytes: Record<RuntimeCommandEventStream, number>;
  truncatedOutputStreams: Set<RuntimeCommandEventStream>;
  externalHttpRequestCount?: number;
  handledSignal?: string;
}


const commandContextByFs = new WeakMap<object, RuntimeCommandExecutionContext>();


export function registerCommandContext(fs: object, context: RuntimeCommandExecutionContext): void {
  commandContextByFs.set(fs, context);
}


export function commandContextForFs(fs: object): RuntimeCommandExecutionContext | undefined {
  return commandContextByFs.get(fs);
}


export function normalizeProcPath(path: string): string | null {
  assertNoNul(path, 'Kernel path');
  return normalizeRuntimeProcPath(path);
}


export function kernelWriteTarget(path: string): ReturnType<typeof runtimeKernelWriteTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelWriteTarget(path);
}


export function throwKernelWriteTargetError(path: string, target: Extract<ReturnType<typeof runtimeKernelWriteTarget>, { kind: 'error' }>): never {
  throw Object.assign(new Error(runtimeKernelWriteFsErrorMessage(path, target)), {
    code: runtimeKernelWriteErrorCode(target.reason),
  });
}


export function kernelMutationTarget(path: string): ReturnType<typeof runtimeKernelMutationTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelMutationTarget(path);
}


export function kernelLinkTarget(existingPath: string, newPath: string): ReturnType<typeof runtimeKernelLinkTarget> {
  assertNoNul(existingPath, 'Kernel path');
  assertNoNul(newPath, 'Kernel path');
  return runtimeKernelLinkTarget(existingPath, newPath);
}


export function kernelRenameTarget(sourcePath: string, destinationPath: string): ReturnType<typeof runtimeKernelRenameTarget> {
  assertNoNul(sourcePath, 'Kernel path');
  assertNoNul(destinationPath, 'Kernel path');
  return runtimeKernelRenameTarget(sourcePath, destinationPath);
}


export function kernelSymlinkTarget(linkPath: string): ReturnType<typeof runtimeKernelSymlinkTarget> {
  assertNoNul(linkPath, 'Kernel path');
  return runtimeKernelSymlinkTarget(linkPath);
}


export function kernelRemoveTarget(path: string): ReturnType<typeof runtimeKernelRemoveTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelRemoveTarget(path);
}


export function kernelMkdirTarget(path: string): ReturnType<typeof runtimeKernelMkdirTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelMkdirTarget(path);
}


export function throwKernelMutationTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelMutationTarget>, { kind: 'error' }>,
  deviceMessage = `Kernel device namespace is read-only: ${path}`
): never {
  throw Object.assign(new Error(runtimeKernelMutationErrorMessage(path, target, { deviceMessage })), {
    code: runtimeKernelMutationErrorCode(target.reason),
  });
}


export function kernelMetadataTarget(path: string): ReturnType<typeof runtimeKernelMetadataTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelMetadataTarget(path);
}


export function kernelAccessTarget(path: string): ReturnType<typeof runtimeKernelAccessTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelAccessTarget(path);
}


export function kernelReadTarget(path: string): ReturnType<typeof runtimeKernelReadTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelReadTarget(path);
}


export function kernelFileReadTarget(path: string): ReturnType<typeof runtimeKernelFileReadTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelFileReadTarget(path);
}


export function kernelFileCopyTarget(source: string, destination: string): ReturnType<typeof runtimeKernelFileCopyTarget> {
  assertNoNul(source, 'Kernel path');
  assertNoNul(destination, 'Kernel path');
  return runtimeKernelFileCopyTarget(source, destination);
}


export function kernelStatTarget(path: string, info: RuntimeKernelInfo): ReturnType<typeof runtimeKernelStatTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelStatTarget(path, info);
}


export function throwKernelReadTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelReadTarget>, { kind: 'error' }>
): never {
  throw kernelReadTargetError(path, target);
}


export function kernelReadTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelReadTarget>, { kind: 'error' }>
): Error {
  return Object.assign(new Error(runtimeKernelReadErrorMessage(path, target)), {
    code: target.reason === 'permission-denied' ? 'EBADF' : 'ENOENT',
  });
}


export function throwKernelFileReadTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelFileReadTarget>, { kind: 'error' }>
): never {
  throw Object.assign(new Error(runtimeKernelFileReadFsErrorMessage(path, target)), {
    code: runtimeKernelFileReadErrorCode(target.reason),
  });
}


export function kernelDirectoryTarget(path: string): ReturnType<typeof runtimeKernelDirectoryTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelDirectoryTarget(path);
}


export function throwKernelMetadataTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelMetadataTarget>, { kind: 'error' }>
): never {
  throw Object.assign(new Error(runtimeKernelMetadataErrorMessage(path, target)), {
    code: runtimeKernelMetadataErrorCode(target.reason),
  });
}


export function isRuntimeDirectoryChange(change: RuntimeFileChange): change is RuntimeDirectoryChange {
  return (change as RuntimeDirectoryChange).directory === true;
}

export function isRuntimeSymlinkChange(change: RuntimeFileChange): change is RuntimeSymlink {
  return (change as RuntimeSymlink).symlink === true;
}


export function runtimeFileSystemEntryKey(path: string, stat: unknown): string {
  const entry = stat as { dev?: unknown; ino?: unknown };
  if (typeof entry.dev === 'number' && typeof entry.ino === 'number') return `${entry.dev}:${entry.ino}`;
  if (typeof entry.ino === 'number') return `ino:${entry.ino}`;
  return `path:${path}`;
}


export function runtimeFileSystemEntryIsSymlink(stat: unknown): boolean {
  return (stat as { isSymbolicLink?: unknown }).isSymbolicLink === true;
}


export async function collectSnapshotFiles(
  fs: CommandContext['fs'],
  cwd: string,
  absolutePath: string,
  files: RuntimeFile[],
  directories: string[],
  symlinks: RuntimeSymlink[],
  directoryMetadata: RuntimeDirectory[] = [],
  seenDirectories = new Set<string>()
): Promise<void> {
  if (!isWithinWorkspace(cwd, absolutePath)) {
    throw new Error(`Refusing to snapshot path outside workspace: ${absolutePath}`);
  }

  const stat = await fs.lstat(absolutePath);
  if (runtimeFileSystemEntryIsSymlink(stat)) {
    symlinks.push({
      path: toProjectPath(cwd, absolutePath),
      symlink: true,
      target: await fs.readlink(absolutePath),
    });
    return;
  }
  if (stat.isFile) {
    const bytes = await fs.readFileBuffer(absolutePath);
    const text = decodeUtf8(bytes);
    files.push({
      path: toProjectPath(cwd, absolutePath),
      contents: text ?? base64FromBytes(bytes),
      encoding: text === null ? 'base64' : 'utf8',
      ...(typeof stat.mode === 'number' ? { mode: stat.mode & 0o7777 } : {}),
      ...(stat.mtime instanceof Date ? { mtimeMs: stat.mtime.getTime() } : {}),
    });
    return;
  }

  if (!stat.isDirectory) return;
  const directoryKey = runtimeFileSystemEntryKey(absolutePath, stat);
  if (seenDirectories.has(directoryKey)) return;
  seenDirectories.add(directoryKey);
  const directoryPath = toProjectDirectoryPath(cwd, absolutePath);
  if (directoryPath !== null) {
    const atime = (stat as { atime?: Date; atimeMs?: number }).atime;
    const atimeMs = atime instanceof Date ? atime.getTime() : (stat as { atimeMs?: number }).atimeMs;
    directories.push(directoryPath);
    directoryMetadata.push({
      path: directoryPath,
      ...(typeof stat.mode === 'number' ? { mode: stat.mode & 0o7777 } : {}),
      ...(typeof atimeMs === 'number' ? { atimeMs } : {}),
      ...(stat.mtime instanceof Date ? { mtimeMs: stat.mtime.getTime() } : {}),
    });
  }

  for (const entry of await fs.readdir(absolutePath)) {
    await collectSnapshotFiles(fs, cwd, `${absolutePath}/${entry}`, files, directories, symlinks, directoryMetadata, seenDirectories);
  }
}


export async function collectKernelProcSnapshotFiles(
  fs: CommandContext['fs'],
  path: string,
  files: RuntimeFile[],
  seen = new Set<string>()
): Promise<void> {
  if (seen.has(path)) return;
  seen.add(path);
  const stat = await fs.stat(path).catch(() => null);
  if (!stat) return;
  if (stat.isFile) {
    files.push({ path, contents: await fs.readFile(path) });
    return;
  }
  if (!stat.isDirectory) return;
  const entries = await fs.readdir(path).catch(() => []);
  for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
    await collectKernelProcSnapshotFiles(fs, `${path}/${entry}`, files, seen);
  }
}


export async function snapshotRuntimeKernelVirtualFiles(
  fs: CommandContext['fs'],
  info: RuntimeKernelInfo,
  options: { publicView?: boolean } = {}
): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = [];
  await collectKernelProcSnapshotFiles(fs, '/proc', files);
  await collectKernelProcSnapshotFiles(fs, TRACEKERNEL_SKILLS_ROOT, files);
  // /proc/self and numeric PID trees describe the shell process that produced
  // this snapshot. They are neither portable nor authoritative inside a fresh
  // language worker, whose runtime owns its own process and descriptor view.
  // Forwarding entries such as /proc/self/fd/0 can also collide with runtime
  // symlinks (for example Emscripten's /proc/self/fd). Keep only the stable
  // mount description from /proc/self; TraceKernel control files and skills
  // remain part of the worker handoff.
  const portableFiles = files.filter((file) => {
    if (file.path === '/proc/self/mountinfo') return true;
    if (file.path.startsWith('/proc/self/')) return false;
    if (/^\/proc\/[1-9][0-9]*(?:\/|$)/u.test(file.path)) return false;
    return true;
  });
  const virtualFiles = options.publicView === false
    ? runtimeKernelVirtualFiles(info)
    : publicRuntimeKernelVirtualFiles(info);
  if (portableFiles.length === 0) return virtualFiles;
  const byPath = new Map(portableFiles.map((file) => [file.path, file]));
  for (const file of virtualFiles) byPath.set(file.path, file);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}


export async function snapshotCommandContext(
  ctx: CommandContext,
  workspaceRoot: string,
  entrypoint?: string,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles = false
): Promise<RuntimeProjectSnapshot> {
  const files: RuntimeFile[] = [];
  const directories: string[] = [];
  const symlinks: RuntimeSymlink[] = [];
  const directoryMetadata: RuntimeDirectory[] = [];
  await collectSnapshotFiles(ctx.fs, workspaceRoot, workspaceRoot, files, directories, symlinks, directoryMetadata);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.localeCompare(right));
  symlinks.sort((left, right) => left.path.localeCompare(right.path));
  directoryMetadata.sort((left, right) => left.path.localeCompare(right.path));
  const publicKernel = kernel ? publicRuntimeKernelInfo(kernel) : undefined;
  const kernelFiles = kernel ? await snapshotRuntimeKernelVirtualFiles(ctx.fs, kernel) : undefined;
  const snapshot: RuntimeProjectSnapshot = {
    cwd: workspaceRoot,
    workspaceRoot,
    ...(workspaceAlias ? { workspaceAlias } : {}),
    ...(publicKernel ? { kernel: publicKernel } : {}),
    ...(kernel ? { kernelDevices: runtimeKernelVirtualDevices() } : {}),
    ...(kernelFiles ? { kernelFiles } : {}),
    files,
    ...(symlinks.length > 0 ? { symlinks } : {}),
    ...(directories.length > 0 ? { directories } : {}),
    ...(directoryMetadata.length > 0 ? { directoryMetadata } : {}),
    ...(readonlyFiles && readonlyFiles.length > 0 ? { readonlyFiles: [...readonlyFiles] } : {}),
    ...(includeHiddenFiles && hiddenFiles && hiddenFiles.length > 0 ? { hiddenFiles: [...hiddenFiles] } : {}),
    ...(entrypoint ? { entrypoint } : {}),
  };
  return includeHiddenFiles ? snapshot : filterHiddenSnapshotFiles(snapshot, hiddenFiles);
}


export function filterReadonlySnapshotFiles(
  snapshot: RuntimeProjectSnapshot,
  readonlyFiles?: readonly string[],
  keepFiles?: readonly string[]
): RuntimeProjectSnapshot {
  if (!readonlyFiles || readonlyFiles.length === 0) return snapshot;
  const keep = new Set((keepFiles ?? []).map((path) => normalizeRuntimeProjectPath(path)));
  const readonly = new Set(readonlyFiles
    .map((path) => normalizeRuntimeProjectPath(path))
    .filter((path) => path.includes('/') && !keep.has(path)));
  if (readonly.size === 0) return snapshot;
  const files = snapshot.files.filter((file) => !readonly.has(normalizeRuntimeProjectPath(file.path)));
  const symlinks = snapshot.symlinks?.filter((symlink) => !readonly.has(normalizeRuntimeProjectPath(symlink.path)));
  return files.length === snapshot.files.length && symlinks?.length === snapshot.symlinks?.length
    ? snapshot
    : { ...snapshot, files, ...(symlinks && symlinks.length > 0 ? { symlinks } : { symlinks: undefined }) };
}


export function filterHiddenSnapshotFiles(
  snapshot: RuntimeProjectSnapshot,
  hiddenFiles?: readonly string[]
): RuntimeProjectSnapshot {
  if (!hiddenFiles || hiddenFiles.length === 0) return snapshot;
  const hidden = new Set(hiddenFiles.map((path) => normalizeRuntimeProjectPath(path)));
  if (hidden.size === 0) return snapshot;
  const files = snapshot.files.filter((file) => !hidden.has(normalizeRuntimeProjectPath(file.path)));
  const symlinks = snapshot.symlinks?.filter((symlink) => !hidden.has(normalizeRuntimeProjectPath(symlink.path)));
  const directories = snapshot.directories?.filter((directory) => {
    const normalized = normalizeRuntimeProjectPath(directory);
    return ![...hidden].some((hiddenPath) => hiddenPath === normalized || hiddenPath.startsWith(`${normalized}/`));
  });
  const directoryMetadata = snapshot.directoryMetadata?.filter((directory) => {
    const normalized = normalizeRuntimeProjectPath(directory.path);
    return ![...hidden].some((hiddenPath) => hiddenPath === normalized || hiddenPath.startsWith(`${normalized}/`));
  });
  const { directories: _directories, directoryMetadata: _directoryMetadata, symlinks: _symlinks, hiddenFiles: _hiddenFiles, ...rest } = snapshot;
  return {
    ...rest,
    files,
    ...(symlinks && symlinks.length > 0 ? { symlinks } : {}),
    ...(directories && directories.length > 0 ? { directories } : {}),
    ...(directoryMetadata && directoryMetadata.length > 0 ? { directoryMetadata } : {}),
  };
}


export function filterReadonlySnapshotDeletions(
  result: RuntimeCommandResult,
  readonlyFiles?: readonly string[]
): RuntimeCommandResult {
  if (!result.files?.length || !readonlyFiles || readonlyFiles.length === 0) return result;
  const readonly = new Set(readonlyFiles
    .map((path) => normalizeRuntimeProjectPath(path))
    .filter((path) => path.includes('/')));
  if (readonly.size === 0) return result;
  const files = result.files.filter((change) => {
    if ((change as RuntimeFileDeletion | RuntimeDirectoryChange).deleted !== true) return true;
    const path = normalizeRuntimeProjectPath(change.path);
    if (isRuntimeDirectoryChange(change)) {
      return ![...readonly].some((readonlyPath) => readonlyPath === path || readonlyPath.startsWith(`${path}/`));
    }
    return !readonly.has(path);
  });
  if (files.length === result.files.length) return result;
  if (files.length > 0) return { ...result, files };
  const { files: _files, ...rest } = result;
  return rest;
}


export type RuntimeFileChangeObserver = (
  change: RuntimeFileChange,
  phase: RuntimeFileMutationPhase,
  context?: RuntimeCommandExecutionContext
) => void;

export interface RuntimeFileSystemBeforeMutation {
  readonly paths: readonly string[];
  readonly kind: RuntimeFileSystemMutationKind;
  readFile(path: string): Promise<Uint8Array>;
}

export type RuntimeFileSystemBeforeMutationObserver = (
  mutation: RuntimeFileSystemBeforeMutation
) => Promise<void> | void;


export interface RuntimeFinalDiffPreparedChange {
  change: RuntimeFileChange;
  absolutePath: string;
  kind: RuntimeFileSystemMutationKind;
  apply(base: IFileSystem): Promise<void>;
}


export type RuntimeFileSystemRollbackEntry =
  | { kind: 'missing'; path: string }
  | { kind: 'file'; path: string; contents: Uint8Array }
  | { kind: 'symlink'; path: string; target: string }
  | {
      kind: 'directory';
      path: string;
      directories: string[];
      files: Array<{ path: string; contents: Uint8Array }>;
      symlinks: Array<{ path: string; target: string }>;
    };


export interface RuntimeFileSystemRollbackState {
  entries: RuntimeFileSystemRollbackEntry[];
  createdAncestors: string[];
}


export function isKernelReadonlyError(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EROFS'
    && error instanceof Error
    && error.message.startsWith('EROFS: readonly project ');
}

export function isKernelVirtualFilesystemError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === 'EBADF' ||
    code === 'EISDIR' ||
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EROFS'
  ) && (
    error.message.startsWith('Kernel ') ||
    /^[A-Z]+: /u.test(error.message)
  );
}


export function kernelCommandFailure(error: unknown): RuntimeCommandResult {
  const message = error instanceof Error ? error.message : String(error);
  const commandError = runtimeCommandError(error);
  return {
    stdout: '',
    stderr: message ? `${message}\n` : 'EIO: input/output error\n',
    exitCode: commandError?.errno ?? 1,
    ...(commandError ? { error: commandError } : {}),
  };
}


export function isRuntimeFileGenerationConflict(error: unknown): boolean {
  return error instanceof RuntimeFileGenerationConflictError || (error as { code?: unknown }).code === 'ESTALE';
}


export function isRuntimeWorkspaceStorageLimitError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EFBIG' || code === 'ENOSPC';
}


export function runtimeCommandError(error: unknown): RuntimeCommandError | undefined {
  if (error instanceof RuntimeFileGenerationConflictError) return error.toCommandError();
  if (error instanceof RuntimeKernelInterruptedError) {
    return {
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      path: error.path,
      message: error.message,
    };
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const errno = (error as { errno?: unknown }).errno;
  const syscall = (error as { syscall?: unknown }).syscall;
  const path = (error as { path?: unknown }).path;
  return {
    code,
    message,
    ...(typeof errno === 'number' ? { errno } : {}),
    ...(typeof syscall === 'string' ? { syscall } : {}),
    ...(typeof path === 'string' ? { path } : {}),
  };
}


export async function applyCommandResultFiles(
  ctx: CommandContext,
  workspaceRoot: string,
  result: RuntimeCommandResult,
  onFileChange?: RuntimeFileChangeObserver
): Promise<RuntimeCommandResult> {
  try {
    assertRuntimeFinalDiffBudget(result.files);
    const commandContext = commandContextForFs(ctx.fs);
    const observedFs = ctx.fs instanceof KernelObservedFileSystem || ctx.fs instanceof CommandBoundFileSystem
      ? ctx.fs
      : undefined;
    if (observedFs && result.files?.length) {
      const committed = await observedFs.applyFinalDiffTransaction(result.files, (file) =>
        prepareFinalDiffChange(workspaceRoot, file)
      );
      for (const file of committed) {
        onFileChange?.(file, 'final-diff', commandContext);
      }
      const { files: _files, ...commandResult } = result;
      return commandResult;
    }
    return await applyRuntimeCommandResultFiles(result, async (file, phase) => {
      await withSuspendedFsNotifications(ctx.fs, async () => {
        if (observedFs) {
          observedFs.assertFileChangeGenerationFresh(file, phase);
        }
        const absolutePath = toWorkspacePath(workspaceRoot, file.path);
        if (isRuntimeDirectoryChange(file)) {
          if (file.deleted === true) {
            await ctx.fs.rm(absolutePath, { force: true, recursive: true });
          } else {
            await ctx.fs.mkdir(absolutePath, { recursive: true });
            await applyRuntimeEntryMetadata(ctx.fs, absolutePath, file);
          }
          onFileChange?.(file, phase, commandContext);
          return;
        }
        if ((file as { deleted?: boolean }).deleted === true) {
          await ctx.fs.rm(absolutePath, { force: true });
          onFileChange?.(file, phase, commandContext);
          return;
        }
        if (isRuntimeSymlinkChange(file)) {
          await ctx.fs.mkdir(dirname(absolutePath), { recursive: true });
          await ctx.fs.rm(absolutePath, { force: true, recursive: true });
          await ctx.fs.symlink(file.target, absolutePath);
          onFileChange?.(file, phase, commandContext);
          return;
        }
        const changedFile = file as RuntimeFile;
        await ctx.fs.mkdir(dirname(absolutePath), { recursive: true });
        if ((changedFile.encoding ?? 'utf8') === 'base64') {
          await ctx.fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
        } else {
          await ctx.fs.writeFile(absolutePath, changedFile.contents);
        }
        await applyRuntimeEntryMetadata(ctx.fs, absolutePath, changedFile);
        onFileChange?.(changedFile, phase, commandContext);
      });
    });
  } catch (error) {
    if (
      isKernelReadonlyError(error) ||
      isKernelVirtualFilesystemError(error) ||
      isRuntimeFileGenerationConflict(error) ||
      isRuntimeWorkspaceStorageLimitError(error)
    ) {
      const observedFs = ctx.fs instanceof KernelObservedFileSystem || ctx.fs instanceof CommandBoundFileSystem
        ? ctx.fs
        : undefined;
      observedFs?.recordCommandError(error);
      return kernelCommandFailure(error);
    }
    throw error;
  }
}


export function prepareFinalDiffChange(workspaceRoot: string, file: RuntimeFileChange): RuntimeFinalDiffPreparedChange {
  const absolutePath = isRuntimeDirectoryChange(file)
    ? toWorkspaceEntryPath(workspaceRoot, file.path)
    : (file as RuntimeFileDeletion).deleted === true
      ? toWorkspacePath(workspaceRoot, file.path)
      : toWorkspacePath(workspaceRoot, file.path);
  const kind: RuntimeFileSystemMutationKind = isRuntimeDirectoryChange(file)
    ? file.deleted === true ? 'recursive-delete' : 'directory-create'
    : (file as RuntimeFileDeletion).deleted === true
      ? 'delete'
      : 'file-write';
  return {
    change: file,
    absolutePath,
    kind,
    apply: async (fs) => {
      if (isRuntimeDirectoryChange(file)) {
        if (file.deleted === true) {
          await fs.rm(absolutePath, { force: true, recursive: true });
        } else {
          await fs.mkdir(absolutePath, { recursive: true });
          await applyRuntimeEntryMetadata(fs, absolutePath, file);
        }
        return;
      }
      if ((file as RuntimeFileDeletion).deleted === true) {
        await fs.rm(absolutePath, { force: true });
        return;
      }
      if (isRuntimeSymlinkChange(file)) {
        await fs.mkdir(dirname(absolutePath), { recursive: true });
        await fs.rm(absolutePath, { force: true, recursive: true });
        await fs.symlink(file.target, absolutePath);
        return;
      }
      const changedFile = file as RuntimeFile;
      if ((changedFile.encoding ?? 'utf8') === 'base64') {
        await fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
      } else {
        await fs.writeFile(absolutePath, changedFile.contents);
      }
      await applyRuntimeEntryMetadata(fs, absolutePath, changedFile);
    },
  };
}

async function applyRuntimeEntryMetadata(
  fs: CommandContext['fs'],
  path: string,
  file: RuntimeFile | RuntimeDirectoryChange
): Promise<void> {
  if (file.mode !== undefined) await fs.chmod(path, file.mode);
  if (file.atimeMs === undefined && file.mtimeMs === undefined) return;
  const stat = await fs.stat(path);
  const currentMtime = stat.mtime instanceof Date ? stat.mtime.getTime() : 0;
  await fs.utimes(
    path,
    new Date(file.atimeMs ?? currentMtime),
    new Date(file.mtimeMs ?? currentMtime)
  );
}


export async function withSuspendedFsNotifications<T>(fs: CommandContext['fs'], fn: () => Promise<T>): Promise<T> {
  if (fs instanceof KernelObservedFileSystem) {
    return fs.suspendNotifications(fn);
  }
  return fn();
}


export async function applyWorkspaceCommandResultFiles(
  workspace: RuntimeProjectWorkspace,
  result: RuntimeCommandResult
): Promise<RuntimeCommandResult> {
  return workspace.applyFinalDiffResultFiles(result);
}


export function assertSupportedEncoding(encoding: RuntimeFileEncoding | undefined): RuntimeFileEncoding {
  return encoding ?? 'utf8';
}


export function normalizeRuntimeFileEncoding(encoding: RuntimeFileEncoding | undefined, label: string): RuntimeFileEncoding {
  if (encoding === undefined || encoding === 'utf8') return 'utf8';
  if (encoding === 'base64') return 'base64';
  throw new Error(`${label}.encoding must be "utf8" or "base64".`);
}


export function bytesFromBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64');
  }

  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}


export function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}


export function textToByteString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let byteString = '';
  for (const byte of bytes) {
    byteString += String.fromCharCode(byte);
  }
  return byteString;
}


export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}


export function contentToText(content: FileContent): string {
  if (typeof content === 'string') return content;
  return decodeUtf8(content) ?? Array.from(content, (byte) => String.fromCharCode(byte)).join('');
}


export function contentToBytes(content: FileContent): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}


export function contentToBytesForRuntimeFile(file: RuntimeFile): Uint8Array {
  return (file.encoding ?? 'utf8') === 'base64'
    ? bytesFromBase64(file.contents)
    : new TextEncoder().encode(file.contents);
}


export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}


export type FsReadFileOptions = Parameters<IFileSystem['readFile']>[1];

export type FsWriteFileOptions = Parameters<IFileSystem['writeFile']>[2];

export type FsMkdirOptions = Parameters<IFileSystem['mkdir']>[1];

export type FsRmOptions = Parameters<IFileSystem['rm']>[1];

export type FsCpOptions = Parameters<IFileSystem['cp']>[2];


export class CommandBoundFileSystem implements IFileSystem {
  constructor(
    private readonly inner: KernelObservedFileSystem,
    private readonly context: RuntimeCommandExecutionContext
  ) {}

  suspendNotifications<T>(fn: () => Promise<T>): Promise<T> {
    return this.inner.suspendNotifications(fn);
  }

  snapshotGenerations(): RuntimeFileSystemGenerationSnapshot {
    return this.inner.snapshotGenerations();
  }

  get mutationVersion(): number {
    return this.inner.mutationVersion;
  }

  inodeForPath(path: string): number {
    return this.inner.inodeForPath(path);
  }

  moveInode(source: string, destination: string): void {
    this.inner.moveInode(source, destination);
  }

  bindInode(existingPath: string, newPath: string): void {
    this.inner.bindInode(existingPath, newPath);
  }

  forgetInodePath(path: string): void {
    this.inner.forgetInodePath(path);
  }

  renderInodes(): string {
    return this.inner.renderInodes();
  }

  assertFileChangeGenerationFresh(change: RuntimeFileChange, phase: RuntimeFileMutationPhase): void {
    return this.inner.assertFileChangeGenerationFreshWithContext(this.context, change, phase);
  }

  applyFinalDiffTransaction(
    changes: readonly RuntimeFileChange[],
    prepare: (change: RuntimeFileChange) => RuntimeFinalDiffPreparedChange
  ): Promise<RuntimeFileChange[]> {
    return this.inner.applyFinalDiffTransactionWithContext(this.context, changes, prepare);
  }

  recordCommandError(error: unknown): void {
    this.inner.recordCommandErrorWithContext(this.context, error);
  }

  withBaseMutation<T>(
    paths: readonly string[],
    fn: (base: IFileSystem) => Promise<T>,
    kind: RuntimeFileSystemMutationKind = 'file-write'
  ): Promise<T> {
    return this.inner.withBaseMutationWithContext(this.context, paths, fn, kind);
  }

  readFile(path: string, options?: FsReadFileOptions): Promise<string> {
    return this.inner.readFileWithContext(this.context, path, options);
  }

  readFileBytes?(path: string): Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never> {
    return this.inner.readFileBytesWithContext(this.context, path);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBufferWithContext(this.context, path);
  }

  writeFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    return this.inner.writeFileWithContext(this.context, path, content, options);
  }

  appendFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    return this.inner.appendFileWithContext(this.context, path, content, options);
  }

  exists(path: string): Promise<boolean> {
    return this.inner.existsWithContext(this.context, path);
  }

  stat(path: string): Promise<Awaited<ReturnType<IFileSystem['stat']>>> {
    return this.inner.statWithContext(this.context, path);
  }

  mkdir(path: string, options?: FsMkdirOptions): Promise<void> {
    return this.inner.mkdirWithContext(this.context, path, options);
  }

  readdir(path: string): Promise<string[]> {
    return this.inner.readdirWithContext(this.context, path);
  }

  readdirWithFileTypes?(path: string): Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>> {
    return this.inner.readdirWithFileTypesWithContext(this.context, path);
  }

  rm(path: string, options?: FsRmOptions): Promise<void> {
    return this.inner.rmWithContext(this.context, path, options);
  }

  cp(src: string, dest: string, options?: FsCpOptions): Promise<void> {
    return this.inner.cpWithContext(this.context, src, dest, options);
  }

  mv(src: string, dest: string): Promise<void> {
    return this.inner.mvWithContext(this.context, src, dest);
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePathWithContext(this.context, base, path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPathsWithContext(this.context);
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.inner.chmodWithContext(this.context, path, mode);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    return this.inner.symlinkWithContext(this.context, target, linkPath);
  }

  link(existingPath: string, newPath: string): Promise<void> {
    return this.inner.linkWithContext(this.context, existingPath, newPath);
  }

  readlink(path: string): Promise<string> {
    return this.inner.readlinkWithContext(this.context, path);
  }

  lstat(path: string): Promise<Awaited<ReturnType<IFileSystem['lstat']>>> {
    return this.inner.lstatWithContext(this.context, path);
  }

  realpath(path: string): Promise<string> {
    return this.inner.realpathWithContext(this.context, path);
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.inner.utimesWithContext(this.context, path, atime, mtime);
  }
}


type RuntimeWorkspaceQuotaEntryKind = 'file' | 'directory' | 'symlink';

interface RuntimeWorkspaceQuotaEntry {
  kind: RuntimeWorkspaceQuotaEntryKind;
  size: number;
}

type RuntimeWorkspaceQuotaChanges = Map<string, RuntimeWorkspaceQuotaEntry | null>;

export interface RuntimeWorkspaceStorageUsage {
  usedBytes: number;
  capacityBytes: number;
  availableBytes: number;
  usedEntries: number;
  capacityEntries: number;
  availableEntries: number;
}


/**
 * A metadata-only quota boundary around the backing filesystem.
 *
 * The ledger stores sizes and entry kinds, never file contents. Hot writes
 * project only the target and any missing ancestors. Tree copies/moves and
 * final-diff transactions clone metadata because their cost is already
 * proportional to the affected tree.
 */
class RuntimeWorkspaceQuotaFileSystem implements IFileSystem {
  private entries = new Map<string, RuntimeWorkspaceQuotaEntry>();
  private totalWorkspaceBytes = 0;
  private totalWorkspaceEntries = 0;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: IFileSystem,
    private readonly workspaceRoot: () => string,
    private readonly limits: NormalizedRuntimeWorkspaceStorageLimits
  ) {}

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.ensureInitialized();
      return await fn();
    } finally {
      release();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rebuildLedger();
    this.initialized = true;
  }

  async storageUsage(): Promise<RuntimeWorkspaceStorageUsage> {
    await this.ensureInitialized();
    return {
      usedBytes: this.totalWorkspaceBytes,
      capacityBytes: this.limits.maxWorkspaceBytes,
      availableBytes: Math.max(0, this.limits.maxWorkspaceBytes - this.totalWorkspaceBytes),
      usedEntries: this.totalWorkspaceEntries,
      capacityEntries: this.limits.maxEntryCount,
      availableEntries: Math.max(0, this.limits.maxEntryCount - this.totalWorkspaceEntries),
    };
  }

  private async rebuildLedger(): Promise<void> {
    const entries = new Map<string, RuntimeWorkspaceQuotaEntry>();
    for (const rawPath of this.inner.getAllPaths()) {
      const path = normalizeFsLockPath(rawPath);
      const stat = await this.inner.lstat(path);
      if (stat.isSymbolicLink) {
        entries.set(path, {
          kind: 'symlink',
          size: new TextEncoder().encode(await this.inner.readlink(path)).byteLength,
        });
      } else if (stat.isFile) {
        entries.set(path, { kind: 'file', size: stat.size });
      } else if (stat.isDirectory) {
        entries.set(path, { kind: 'directory', size: 0 });
      }
    }
    this.commitSnapshot(entries);
  }

  private isCounted(path: string): boolean {
    const root = normalizeFsLockPath(this.workspaceRoot());
    return path !== root && isWithinWorkspace(root, path);
  }

  private displayPath(path: string): string {
    const root = normalizeFsLockPath(this.workspaceRoot());
    return isWithinWorkspace(root, path) ? toProjectPath(root, path) : path;
  }

  private storageError(
    code: 'EFBIG' | 'ENOSPC',
    message: string,
    path: string,
    syscall: string
  ): Error {
    const displayPath = this.displayPath(path);
    return Object.assign(
      new Error(`${code}: ${message}, ${syscall} '${displayPath}'`),
      {
        code,
        errno: code === 'EFBIG' ? 27 : 28,
        syscall,
        path: displayPath,
      }
    );
  }

  private assertSnapshotWithinLimits(entries: ReadonlyMap<string, RuntimeWorkspaceQuotaEntry>, path: string, syscall: string): void {
    let totalBytes = 0;
    let totalEntries = 0;
    for (const [entryPath, entry] of entries) {
      if (!this.isCounted(entryPath)) continue;
      if (entry.kind === 'file' && entry.size > this.limits.maxFileBytes) {
        throw this.storageError(
          'EFBIG',
          `workspace file exceeds ${this.limits.maxFileBytes} bytes`,
          entryPath,
          syscall
        );
      }
      totalBytes += entry.size;
      totalEntries += 1;
    }
    if (totalBytes > this.limits.maxWorkspaceBytes) {
      throw this.storageError(
        'ENOSPC',
        `workspace exceeds ${this.limits.maxWorkspaceBytes} logical bytes`,
        path,
        syscall
      );
    }
    if (totalEntries > this.limits.maxEntryCount) {
      throw this.storageError(
        'ENOSPC',
        `workspace exceeds ${this.limits.maxEntryCount} entries`,
        path,
        syscall
      );
    }
  }

  private assertChangesWithinLimits(changes: RuntimeWorkspaceQuotaChanges, path: string, syscall: string): void {
    let totalBytes = this.totalWorkspaceBytes;
    let totalEntries = this.totalWorkspaceEntries;
    for (const [entryPath, next] of changes) {
      if (!this.isCounted(entryPath)) continue;
      const previous = this.entries.get(entryPath);
      if (previous) {
        totalBytes -= previous.size;
        totalEntries -= 1;
      }
      if (next) {
        if (next.kind === 'file' && next.size > this.limits.maxFileBytes) {
          throw this.storageError(
            'EFBIG',
            `workspace file exceeds ${this.limits.maxFileBytes} bytes`,
            entryPath,
            syscall
          );
        }
        totalBytes += next.size;
        totalEntries += 1;
      }
    }
    if (totalBytes > this.limits.maxWorkspaceBytes) {
      throw this.storageError(
        'ENOSPC',
        `workspace exceeds ${this.limits.maxWorkspaceBytes} logical bytes`,
        path,
        syscall
      );
    }
    if (totalEntries > this.limits.maxEntryCount) {
      throw this.storageError(
        'ENOSPC',
        `workspace exceeds ${this.limits.maxEntryCount} entries`,
        path,
        syscall
      );
    }
  }

  private commitChanges(changes: RuntimeWorkspaceQuotaChanges): void {
    for (const [path, next] of changes) {
      const previous = this.entries.get(path);
      if (this.isCounted(path) && previous) {
        this.totalWorkspaceBytes -= previous.size;
        this.totalWorkspaceEntries -= 1;
      }
      if (next) {
        this.entries.set(path, next);
        if (this.isCounted(path)) {
          this.totalWorkspaceBytes += next.size;
          this.totalWorkspaceEntries += 1;
        }
      } else {
        this.entries.delete(path);
      }
    }
  }

  private commitSnapshot(entries: Map<string, RuntimeWorkspaceQuotaEntry>): void {
    this.entries = entries;
    this.totalWorkspaceBytes = 0;
    this.totalWorkspaceEntries = 0;
    for (const [path, entry] of entries) {
      if (!this.isCounted(path)) continue;
      this.totalWorkspaceBytes += entry.size;
      this.totalWorkspaceEntries += 1;
    }
  }

  private currentEntry(path: string, changes?: RuntimeWorkspaceQuotaChanges): RuntimeWorkspaceQuotaEntry | undefined {
    const normalizedPath = normalizeFsLockPath(path);
    if (changes?.has(normalizedPath)) return changes.get(normalizedPath) ?? undefined;
    return this.entries.get(normalizedPath);
  }

  private addMissingParents(path: string, changes: RuntimeWorkspaceQuotaChanges): void {
    let current = dirname(normalizeFsLockPath(path));
    const missing: string[] = [];
    while (current !== '/') {
      if (this.currentEntry(current, changes)) break;
      missing.push(current);
      current = dirname(current);
    }
    for (const directoryPath of missing.reverse()) {
      changes.set(directoryPath, { kind: 'directory', size: 0 });
    }
  }

  private writeSize(content: FileContent, options?: FsWriteFileOptions): number {
    if (typeof content !== 'string') return content.byteLength;
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding === 'base64') return bytesFromBase64(content).byteLength;
    if (encoding === 'hex') return Math.floor(content.length / 2);
    if (encoding === 'ascii' || encoding === 'binary' || encoding === 'latin1') return content.length;
    return new TextEncoder().encode(content).byteLength;
  }

  private removeSubtreeFromChanges(path: string, changes: RuntimeWorkspaceQuotaChanges): void {
    const normalizedPath = normalizeFsLockPath(path);
    for (const candidate of this.entries.keys()) {
      if (candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)) {
        changes.set(candidate, null);
      }
    }
    for (const candidate of [...changes.keys()]) {
      if (candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)) {
        changes.set(candidate, null);
      }
    }
  }

  private ensureSnapshotParents(entries: Map<string, RuntimeWorkspaceQuotaEntry>, path: string): void {
    let current = dirname(normalizeFsLockPath(path));
    const missing: string[] = [];
    while (current !== '/') {
      if (entries.has(current)) break;
      missing.push(current);
      current = dirname(current);
    }
    for (const directoryPath of missing.reverse()) {
      entries.set(directoryPath, { kind: 'directory', size: 0 });
    }
  }

  private removeSnapshotSubtree(entries: Map<string, RuntimeWorkspaceQuotaEntry>, path: string): void {
    const normalizedPath = normalizeFsLockPath(path);
    for (const candidate of [...entries.keys()]) {
      if (candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)) {
        entries.delete(candidate);
      }
    }
  }

  private copySnapshotTree(
    entries: Map<string, RuntimeWorkspaceQuotaEntry>,
    sourceSnapshot: ReadonlyMap<string, RuntimeWorkspaceQuotaEntry>,
    source: string,
    destination: string,
    recursive: boolean
  ): void {
    const normalizedSource = normalizeFsLockPath(source);
    const normalizedDestination = normalizeFsLockPath(destination);
    const sourceEntry = sourceSnapshot.get(normalizedSource);
    if (!sourceEntry) return;
    this.ensureSnapshotParents(entries, normalizedDestination);
    if (sourceEntry.kind !== 'directory') {
      entries.set(normalizedDestination, { ...sourceEntry });
      return;
    }
    if (!recursive) return;
    entries.set(normalizedDestination, { kind: 'directory', size: 0 });
    const sourcePaths = [...sourceSnapshot.keys()]
      .filter((path) => path.startsWith(`${normalizedSource}/`))
      .sort((left, right) => left.length - right.length || left.localeCompare(right));
    for (const sourcePath of sourcePaths) {
      const entry = sourceSnapshot.get(sourcePath)!;
      entries.set(`${normalizedDestination}${sourcePath.slice(normalizedSource.length)}`, { ...entry });
    }
  }

  async runFinalDiffTransaction<T>(
    changes: readonly RuntimeFinalDiffPreparedChange[],
    mutate: (rawFileSystem: IFileSystem) => Promise<T>
  ): Promise<T> {
    return this.withMutationLock(async () => {
      const projected = new Map(this.entries);
      for (const prepared of changes) {
        const path = normalizeFsLockPath(prepared.absolutePath);
        const change = prepared.change;
        if (isRuntimeDirectoryChange(change)) {
          if (change.deleted === true) {
            this.removeSnapshotSubtree(projected, path);
          } else {
            this.ensureSnapshotParents(projected, path);
            if (!projected.has(path)) projected.set(path, { kind: 'directory', size: 0 });
          }
        } else if ((change as RuntimeFileDeletion).deleted === true) {
          projected.delete(path);
        } else if (isRuntimeSymlinkChange(change)) {
          this.ensureSnapshotParents(projected, path);
          projected.set(path, {
            kind: 'symlink',
            size: new TextEncoder().encode(change.target).byteLength,
          });
        } else {
          this.ensureSnapshotParents(projected, path);
          projected.set(path, {
            kind: 'file',
            size: contentToBytesForRuntimeFile(change as RuntimeFile).byteLength,
          });
        }
        // Preflight every prefix, not just the final projection. This keeps
        // transient write order from exceeding the same bound while still
        // validating the complete transaction before its first mutation.
        this.assertSnapshotWithinLimits(projected, path, 'write');
      }
      const diagnosticPath = normalizeFsLockPath(changes[0]?.absolutePath ?? this.workspaceRoot());
      this.assertSnapshotWithinLimits(projected, diagnosticPath, 'write');
      try {
        const result = await mutate(this.inner);
        this.commitSnapshot(projected);
        return result;
      } catch (error) {
        // The caller owns rollback for the filesystem transaction. Rebuild the
        // metadata ledger from the resulting state so even a rollback failure
        // cannot desynchronize later quota decisions.
        await this.rebuildLedger();
        throw error;
      }
    });
  }

  readFile(path: string, options?: FsReadFileOptions): Promise<string> {
    return this.inner.readFile(path, options);
  }

  readFileBytes?(path: string): Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never> {
    if (!this.inner.readFileBytes) return Promise.reject(new Error('readFileBytes is not supported by this filesystem.'));
    return this.inner.readFileBytes(path) as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBuffer(path);
  }

  writeFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(path);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      this.addMissingParents(normalizedPath, changes);
      changes.set(normalizedPath, { kind: 'file', size: this.writeSize(content, options) });
      this.assertChangesWithinLimits(changes, normalizedPath, 'write');
      await this.inner.writeFile(path, content, options);
      this.commitChanges(changes);
    });
  }

  appendFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(path);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      this.addMissingParents(normalizedPath, changes);
      const current = this.currentEntry(normalizedPath, changes);
      const previousBytes = current?.kind === 'file' ? current.size : 0;
      changes.set(normalizedPath, { kind: 'file', size: previousBytes + this.writeSize(content, options) });
      this.assertChangesWithinLimits(changes, normalizedPath, 'write');
      await this.inner.appendFile(path, content, options);
      this.commitChanges(changes);
    });
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  stat(path: string): Promise<Awaited<ReturnType<IFileSystem['stat']>>> {
    return this.inner.stat(path);
  }

  mkdir(path: string, options?: FsMkdirOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(path);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      if (options?.recursive) this.addMissingParents(normalizedPath, changes);
      if (!this.currentEntry(normalizedPath, changes)) {
        changes.set(normalizedPath, { kind: 'directory', size: 0 });
      }
      this.assertChangesWithinLimits(changes, normalizedPath, 'mkdir');
      await this.inner.mkdir(path, options);
      this.commitChanges(changes);
    });
  }

  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }

  readdirWithFileTypes?(path: string): Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>> {
    if (!this.inner.readdirWithFileTypes) return Promise.reject(new Error('readdirWithFileTypes is not supported by this filesystem.'));
    return this.inner.readdirWithFileTypes(path) as Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>>;
  }

  rm(path: string, options?: FsRmOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(path);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      if (options?.recursive) this.removeSubtreeFromChanges(normalizedPath, changes);
      else changes.set(normalizedPath, null);
      await this.inner.rm(path, options);
      this.commitChanges(changes);
    });
  }

  cp(src: string, dest: string, options?: FsCpOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedSource = normalizeFsLockPath(src);
      const normalizedDestination = normalizeFsLockPath(dest);
      const sourceEntry = this.entries.get(normalizedSource);
      if (sourceEntry && sourceEntry.kind !== 'directory') {
        const changes: RuntimeWorkspaceQuotaChanges = new Map();
        this.addMissingParents(normalizedDestination, changes);
        changes.set(normalizedDestination, { ...sourceEntry });
        this.assertChangesWithinLimits(changes, normalizedDestination, 'copy');
        await this.inner.cp(src, dest, options);
        this.commitChanges(changes);
        return;
      }
      const projected = new Map(this.entries);
      this.copySnapshotTree(projected, this.entries, src, dest, options?.recursive === true);
      this.assertSnapshotWithinLimits(projected, normalizedDestination, 'copy');
      await this.inner.cp(src, dest, options);
      this.commitSnapshot(projected);
    });
  }

  mv(src: string, dest: string): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedSource = normalizeFsLockPath(src);
      const normalizedDestination = normalizeFsLockPath(dest);
      const sourceEntry = this.entries.get(normalizedSource);
      if (sourceEntry && sourceEntry.kind !== 'directory') {
        const changes: RuntimeWorkspaceQuotaChanges = new Map();
        this.addMissingParents(normalizedDestination, changes);
        changes.set(normalizedDestination, { ...sourceEntry });
        changes.set(normalizedSource, null);
        this.assertChangesWithinLimits(changes, normalizedDestination, 'rename');
        await this.inner.mv(src, dest);
        this.commitChanges(changes);
        return;
      }
      const sourceSnapshot = new Map(this.entries);
      const projected = new Map(this.entries);
      this.copySnapshotTree(projected, sourceSnapshot, src, dest, true);
      this.removeSnapshotSubtree(projected, src);
      this.assertSnapshotWithinLimits(projected, normalizedDestination, 'rename');
      await this.inner.mv(src, dest);
      this.commitSnapshot(projected);
    });
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.inner.chmod(path, mode);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(linkPath);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      this.addMissingParents(normalizedPath, changes);
      changes.set(normalizedPath, {
        kind: 'symlink',
        size: new TextEncoder().encode(target).byteLength,
      });
      this.assertChangesWithinLimits(changes, normalizedPath, 'symlink');
      await this.inner.symlink(target, linkPath);
      this.commitChanges(changes);
    });
  }

  link(existingPath: string, newPath: string): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedExistingPath = normalizeFsLockPath(existingPath);
      const normalizedNewPath = normalizeFsLockPath(newPath);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      this.addMissingParents(normalizedNewPath, changes);
      const existing = this.entries.get(normalizedExistingPath);
      if (existing?.kind === 'file') {
        changes.set(normalizedNewPath, { ...existing });
      }
      this.assertChangesWithinLimits(changes, normalizedNewPath, 'link');
      await this.inner.link(existingPath, newPath);
      this.commitChanges(changes);
    });
  }

  readlink(path: string): Promise<string> {
    return this.inner.readlink(path);
  }

  lstat(path: string): Promise<Awaited<ReturnType<IFileSystem['lstat']>>> {
    return this.inner.lstat(path);
  }

  realpath(path: string): Promise<string> {
    return this.inner.realpath(path);
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.inner.utimes(path, atime, mtime);
  }
}


export class KernelObservedFileSystem implements IFileSystem {
  private readonly base: IFileSystem;
  private readonly quotaFileSystem: RuntimeWorkspaceQuotaFileSystem;
  private suspendDepth = 0;
  private nextGeneration = 1;
  private mutationCounter = 0;
  private nextInode = 10_000;
  private readonly generations = new Map<string, number>();
  private readonly inodes = new Map<string, number>();
  private readonly mutationWatchers = new Set<(revision: number) => void>();
  private readonly beforeMutationObservers =
    new Set<RuntimeFileSystemBeforeMutationObserver>();
  private liveFileChangeBudgetPid: number | undefined;
  private liveFileChangeCount = 0;
  private liveFileChangeBytes = 0;

  constructor(
    base: IFileSystem,
    private readonly locks: RuntimeFileSystemLockCoordinator,
    private readonly workspaceRoot: () => string,
    private readonly workspaceAlias: () => string | undefined,
    private readonly kernelInfo: () => RuntimeKernelInfo,
    private readonly assertWritable: (absolutePath: string, operation: string) => void,
    private readonly assertSubtreeWritable: (absolutePath: string, operation: string) => void,
    private readonly isHidden: (absolutePath: string) => boolean,
    private readonly onSyscallEvent: (event: RuntimeFileSystemSyscallEvent) => void,
    private readonly dynamicProc: RuntimeDynamicProcProvider,
    private readonly onFileChange: (context: RuntimeCommandExecutionContext | undefined, change: RuntimeFileChange) => void,
    private readonly readDevice: (context: RuntimeCommandExecutionContext | undefined, device: RuntimeKernelDevicePath) => string,
    private readonly writeDevice: (context: RuntimeCommandExecutionContext | undefined, device: RuntimeKernelDevicePath, data: string) => void,
    storageLimits: NormalizedRuntimeWorkspaceStorageLimits
  ) {
    this.quotaFileSystem = new RuntimeWorkspaceQuotaFileSystem(base, workspaceRoot, storageLimits);
    this.base = this.quotaFileSystem;
  }

  suspendNotifications<T>(fn: () => Promise<T>): Promise<T> {
    this.suspendDepth += 1;
    return fn().finally(() => {
      this.suspendDepth -= 1;
    });
  }

  snapshotGenerations(): RuntimeFileSystemGenerationSnapshot {
    return new Map(this.generations);
  }

  storageUsage(): Promise<RuntimeWorkspaceStorageUsage> {
    return this.quotaFileSystem.storageUsage();
  }

  get mutationVersion(): number {
    return this.mutationCounter;
  }

  watchMutations(listener: (revision: number) => void): () => void {
    this.mutationWatchers.add(listener);
    return () => {
      this.mutationWatchers.delete(listener);
    };
  }

  watchBeforeMutations(listener: RuntimeFileSystemBeforeMutationObserver): () => void {
    this.beforeMutationObservers.add(listener);
    return () => {
      this.beforeMutationObservers.delete(listener);
    };
  }

  inodeForPath(path: string): number {
    const normalizedPath = normalizeFsLockPath(this.mapPath(path));
    const existing = this.inodes.get(normalizedPath);
    if (existing !== undefined) return existing;
    const inode = this.nextInode++;
    this.inodes.set(normalizedPath, inode);
    return inode;
  }

  moveInode(source: string, destination: string): void {
    const normalizedSource = normalizeFsLockPath(this.mapPath(source));
    const normalizedDestination = normalizeFsLockPath(this.mapPath(destination));
    const inode = this.inodes.get(normalizedSource) ?? this.inodeForPath(normalizedSource);
    this.inodes.delete(normalizedSource);
    this.inodes.set(normalizedDestination, inode);
  }

  bindInode(existingPath: string, newPath: string): void {
    const normalizedExisting = normalizeFsLockPath(this.mapPath(existingPath));
    const normalizedNew = normalizeFsLockPath(this.mapPath(newPath));
    const inode = this.inodes.get(normalizedExisting) ?? this.inodeForPath(normalizedExisting);
    this.inodes.set(normalizedNew, inode);
  }

  pathForInode(inode: number): string | undefined {
    for (const [path, candidate] of this.inodes) {
      if (candidate === inode) return path;
    }
    return undefined;
  }

  inodeLinkCount(path: string): number {
    const inode = this.inodeForPath(path);
    let count = 0;
    for (const candidate of this.inodes.values()) {
      if (candidate === inode) count += 1;
    }
    return count;
  }

  async inodeIdentityPathWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    path: string
  ): Promise<string> {
    const mappedPath = normalizeFsLockPath(this.mapPath(path));
    if (!(await this.base.exists(mappedPath).catch(() => false))) return mappedPath;
    const realPath = normalizeFsLockPath(
      await this.realpathWithContext(context, mappedPath)
    );
    this.assertCommandPathVisible(context, realPath, 'stat');
    return realPath;
  }

  forgetInodePath(path: string): void {
    this.inodes.delete(normalizeFsLockPath(this.mapPath(path)));
  }

  renderInodes(): string {
    const rows = [...this.inodes.entries()]
      .filter(([path]) => isWithinWorkspace(this.workspaceRoot(), path))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, inode]) => `${inode}\t${toProjectPath(this.workspaceRoot(), path)}`);
    return ['ino\tpath', ...rows].join('\n') + '\n';
  }

  private commandGenerationContextFor(
    context: RuntimeCommandExecutionContext | undefined
  ): RuntimeFileSystemCommandGenerationContext | undefined {
    return context
      ? {
          baseline: context.generationBaseline,
          mutatedPaths: context.mutatedGenerationPaths,
          pid: context.process.pid,
          signal: context.process.abortController!.signal,
          setError: (error) => {
            context.kernelError = error;
          },
        }
      : undefined;
  }

  assertFileChangeGenerationFresh(change: RuntimeFileChange, phase: RuntimeFileMutationPhase): void {
    return this.assertFileChangeGenerationFreshWithContext(undefined, change, phase);
  }

  assertFileChangeGenerationFreshWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase
  ): void {
    if (phase !== 'final-diff') return;
    const baseline = context?.generationBaseline;
    if (!baseline) return;
    const path = this.mapPath(runtimeFileChangePath(change));
    const kind = this.finalDiffMutationKind(change, path);
    this.assertCommandMutationFresh(context, [path], kind);
  }

  async applyFinalDiffTransaction(
    changes: readonly RuntimeFileChange[],
    prepare: (change: RuntimeFileChange) => RuntimeFinalDiffPreparedChange
  ): Promise<RuntimeFileChange[]> {
    return this.applyFinalDiffTransactionWithContext(undefined, changes, prepare);
  }

  async applyFinalDiffTransactionWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    changes: readonly RuntimeFileChange[],
    prepare: (change: RuntimeFileChange) => RuntimeFinalDiffPreparedChange
  ): Promise<RuntimeFileChange[]> {
    if (changes.length === 0) return [];
    const prepared = changes.map((change) => {
      const preparedChange = prepare(change);
      return {
        ...preparedChange,
        kind: this.finalDiffMutationKind(preparedChange.change, preparedChange.absolutePath),
      };
    });
    const generationContext = this.commandGenerationContextFor(context);
    const normalizedPaths = prepared.map((change) => normalizeFsLockPath(change.absolutePath));
    const detail = {
      kind: 'final-diff-transaction',
      paths: normalizedPaths.map((path) => isWithinWorkspace(this.workspaceRoot(), path) ? toProjectPath(this.workspaceRoot(), path) : path),
      absolutePaths: normalizedPaths,
      changes: prepared.length,
    };
    let rolledBack = false;
    this.onSyscallEvent({ type: 'fs-transaction-start', pid: generationContext?.pid, detail });
    try {
      return await this.locks.withLocks(
        prepared.flatMap((change) => this.mutationLockRequests([change.absolutePath], change.kind)),
        async () => {
          for (const change of prepared) {
            this.assertCommandMutationFresh(context, [change.absolutePath], change.kind);
            await this.validateFinalDiffPreparedChange(change);
          }
          await this.validateFinalDiffDirectoryDeletes(prepared);
          let rollback!: RuntimeFileSystemRollbackState;
          const committed = await this.quotaFileSystem.runFinalDiffTransaction(prepared, async (rawFileSystem) => {
            rollback = await this.snapshotRollbackState(prepared.map((change) => change.absolutePath));
            const transactionChanges: RuntimeFileChange[] = [];
            try {
              await this.suspendNotifications(async () => {
                for (const change of prepared) {
                  await change.apply(rawFileSystem);
                  transactionChanges.push(change.change);
                }
              });
            } catch (error) {
              await this.restoreRollbackState(rollback, rawFileSystem);
              rolledBack = true;
              throw error;
            }
            return transactionChanges;
          });
          await this.recordFinalDiffInodeMutations(prepared, rollback);
          for (const change of prepared) {
            this.recordMutation(context, [change.absolutePath], change.kind);
          }
          this.onSyscallEvent({ type: 'fs-transaction-commit', pid: generationContext?.pid, detail });
          return committed;
        },
        generationContext?.signal
      );
    } catch (error) {
      const commandError = runtimeCommandError(error);
      this.recordCommandErrorWithContext(context, error);
      this.onSyscallEvent({
        type: 'fs-transaction-abort',
        pid: generationContext?.pid,
        detail: {
          ...detail,
          rolledBack,
          ...(commandError
            ? { error: { code: commandError.code, message: commandError.message, ...(commandError.errno !== undefined ? { errno: commandError.errno } : {}), ...(commandError.syscall ? { syscall: commandError.syscall } : {}), ...(commandError.path ? { path: commandError.path } : {}) } }
            : { error: { message: error instanceof Error ? error.message : String(error) } }),
        },
      });
      throw error;
    }
  }

  recordCommandError(error: unknown): void {
    this.recordCommandErrorWithContext(undefined, error);
  }

  recordCommandErrorWithContext(context: RuntimeCommandExecutionContext | undefined, error: unknown): void {
    const commandError = runtimeCommandError(error);
    if (commandError) this.commandGenerationContextFor(context)?.setError(commandError);
  }

  private mutationGenerationPaths(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind
  ): string[] {
    return fsMutationGenerationPaths(this.workspaceRoot(), paths, kind);
  }

  private mutationLockRequests(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind
  ): RuntimeFileSystemLockRequest[] {
    return fsMutationLockRequests(this.workspaceRoot(), paths.map((path) => normalizeFsLockPath(path)), kind);
  }

  private finalDiffMutationKind(change: RuntimeFileChange, absolutePath: string): RuntimeFileSystemMutationKind {
    if (isRuntimeDirectoryChange(change)) return change.deleted === true ? 'recursive-delete' : 'directory-create';
    if ((change as RuntimeFileDeletion).deleted === true) return 'delete';
    return this.currentGeneration(absolutePath) > 0 ? 'file-write' : 'file-create';
  }

  private async validateFinalDiffPreparedChange(change: RuntimeFinalDiffPreparedChange): Promise<void> {
    if (isRuntimeDirectoryChange(change.change)) {
      if (change.change.deleted === true) {
        this.assertSubtreeWritable(change.absolutePath, 'delete');
      } else {
        this.assertWritable(change.absolutePath, 'mkdir');
      }
      return;
    }
    if ((change.change as RuntimeFileDeletion).deleted === true) {
      this.assertWritable(change.absolutePath, 'delete');
      return;
    }
    if (isRuntimeSymlinkChange(change.change)) {
      this.assertWritable(change.absolutePath, 'symlink');
      return;
    }
    try {
      this.assertWritable(change.absolutePath, 'write');
    } catch (error) {
      const changedFile = change.change as RuntimeFile;
      if ((error as { code?: unknown }).code === 'EROFS' && await this.fileContentEquals(change.absolutePath, contentToBytesForRuntimeFile(changedFile))) {
        return;
      }
      throw error;
    }
  }

  private async validateFinalDiffDirectoryDeletes(changes: readonly RuntimeFinalDiffPreparedChange[]): Promise<void> {
    const deletedPaths = new Set(
      changes
        .filter((change) => isRuntimeDirectoryChange(change.change) ? change.change.deleted === true : (change.change as RuntimeFileDeletion).deleted === true)
        .map((change) => normalizeFsLockPath(change.absolutePath))
    );
    for (const change of changes) {
      if (!isRuntimeDirectoryChange(change.change) || change.change.deleted !== true) continue;
      await this.assertFinalDiffDirectoryDeleteIsExplicit(change.absolutePath, deletedPaths);
    }
  }

  private async assertFinalDiffDirectoryDeleteIsExplicit(path: string, deletedPaths: ReadonlySet<string>): Promise<void> {
    const normalizedPath = normalizeFsLockPath(path);
    const stat = await this.base.lstat(normalizedPath).catch(() => null);
    if (!stat || (stat as { isSymbolicLink?: boolean }).isSymbolicLink || !stat.isDirectory) return;
    for (const entry of await this.base.readdir(normalizedPath)) {
      const childPath = normalizeFsLockPath(`${normalizedPath}/${entry}`);
      const childStat = await this.base.lstat(childPath).catch(() => null);
      if (!childStat) continue;
      if (childStat.isDirectory && !(childStat as { isSymbolicLink?: boolean }).isSymbolicLink) {
        await this.assertFinalDiffDirectoryDeleteIsExplicit(childPath, deletedPaths);
      }
      if (!deletedPaths.has(childPath)) {
        this.throwFinalDiffDirectoryDeleteConflict(childPath);
      }
    }
  }

  private throwFinalDiffDirectoryDeleteConflict(path: string): never {
    const displayPath = isWithinWorkspace(this.workspaceRoot(), path) ? toProjectPath(this.workspaceRoot(), path) : path;
    throw Object.assign(
      new Error(`ESTALE: final-diff directory delete omitted descendant '${displayPath}'`),
      {
        code: 'ESTALE',
        errno: 116,
        syscall: 'write',
        path: displayPath,
      }
    );
  }

  private async snapshotRollbackState(paths: readonly string[]): Promise<RuntimeFileSystemRollbackState> {
    const workspaceRoot = this.workspaceRoot();
    const normalizedPaths = [...new Set(paths.map((path) => normalizeFsLockPath(path)))]
      .filter((path) => isWithinWorkspace(workspaceRoot, path))
      .sort((left, right) => left.localeCompare(right));
    const targetPaths = normalizedPaths.filter((path, index) =>
      !normalizedPaths.slice(0, index).some((candidate) => path.startsWith(`${candidate}/`))
    );
    const entries: RuntimeFileSystemRollbackEntry[] = [];
    const createdAncestors = new Set<string>();
    for (const path of targetPaths) {
      entries.push(await this.snapshotRollbackEntry(path));
      for (const directoryPath of await this.collectMissingDirectories(dirname(path))) {
        createdAncestors.add(directoryPath);
      }
    }
    return {
      entries,
      createdAncestors: [...createdAncestors].sort((left, right) => right.length - left.length),
    };
  }

  private async snapshotRollbackEntry(path: string): Promise<RuntimeFileSystemRollbackEntry> {
    if (!(await this.base.exists(path))) return { kind: 'missing', path };
    const stat = await this.base.lstat(path);
    if ((stat as { isSymbolicLink?: boolean }).isSymbolicLink) {
      return { kind: 'symlink', path, target: await this.base.readlink(path) };
    }
    if (stat.isFile) {
      return { kind: 'file', path, contents: new Uint8Array(await this.base.readFileBuffer(path)) };
    }
    if (!stat.isDirectory) return { kind: 'missing', path };
    const directories: string[] = [];
    const files: Array<{ path: string; contents: Uint8Array }> = [];
    const symlinks: Array<{ path: string; target: string }> = [];
    await this.collectRollbackDirectory(path, directories, files, symlinks);
    return { kind: 'directory', path, directories, files, symlinks };
  }

  private async collectRollbackDirectory(
    path: string,
    directories: string[],
    files: Array<{ path: string; contents: Uint8Array }>,
    symlinks: Array<{ path: string; target: string }>
  ): Promise<void> {
    const stat = await this.base.lstat(path);
    if ((stat as { isSymbolicLink?: boolean }).isSymbolicLink) {
      symlinks.push({ path, target: await this.base.readlink(path) });
      return;
    }
    if (stat.isFile) {
      files.push({ path, contents: new Uint8Array(await this.base.readFileBuffer(path)) });
      return;
    }
    if (!stat.isDirectory) return;
    if (path !== this.workspaceRoot()) directories.push(path);
    for (const entry of await this.base.readdir(path)) {
      await this.collectRollbackDirectory(`${path}/${entry}`, directories, files, symlinks);
    }
  }

  private async restoreRollbackState(state: RuntimeFileSystemRollbackState, fs: IFileSystem = this.base): Promise<void> {
    for (const entry of state.entries) {
      await this.removeRollbackPath(entry.path, fs);
      if (entry.kind === 'missing') continue;
      if (entry.kind === 'file') {
        await fs.mkdir(dirname(entry.path), { recursive: true });
        await fs.writeFile(entry.path, entry.contents);
        continue;
      }
      if (entry.kind === 'symlink') {
        await fs.mkdir(dirname(entry.path), { recursive: true });
        await fs.symlink(entry.target, entry.path);
        continue;
      }
      await fs.mkdir(entry.path, { recursive: true });
      for (const directoryPath of [...entry.directories].sort((left, right) => left.length - right.length)) {
        await fs.mkdir(directoryPath, { recursive: true });
      }
      for (const file of entry.files) {
        await fs.mkdir(dirname(file.path), { recursive: true });
        await fs.writeFile(file.path, file.contents);
      }
      for (const symlink of entry.symlinks) {
        await fs.mkdir(dirname(symlink.path), { recursive: true });
        await fs.symlink(symlink.target, symlink.path);
      }
    }
    for (const directoryPath of state.createdAncestors) {
      await this.removeDirectoryIfEmpty(directoryPath, fs);
    }
  }

  private async removeRollbackPath(path: string, fs: IFileSystem = this.base): Promise<void> {
    if (path === this.workspaceRoot()) {
      for (const entry of await fs.readdir(path).catch(() => [])) {
        await fs.rm(`${path}/${entry}`, { force: true, recursive: true });
      }
      return;
    }
    await fs.rm(path, { force: true, recursive: true });
  }

  private async recordFinalDiffInodeMutations(
    changes: readonly RuntimeFinalDiffPreparedChange[],
    rollback: RuntimeFileSystemRollbackState
  ): Promise<void> {
    const deletedPaths = new Set<string>();
    for (const directoryPath of rollback.createdAncestors) {
      if (await this.base.exists(directoryPath).catch(() => false)) this.inodeForPath(directoryPath);
    }
    for (const change of changes) {
      if (isRuntimeDirectoryChange(change.change)) {
        if (change.change.deleted === true) {
          for (const path of this.rollbackSnapshotPathsFor(change.absolutePath, rollback)) {
            deletedPaths.add(path);
          }
        } else {
          for (const directoryPath of await this.collectExistingDirectories(change.absolutePath)) {
            this.inodeForPath(directoryPath);
          }
        }
        continue;
      }
      if ((change.change as RuntimeFileDeletion).deleted === true) {
        for (const path of this.rollbackSnapshotPathsFor(change.absolutePath, rollback)) {
          deletedPaths.add(path);
        }
        continue;
      }
      this.inodeForPath(change.absolutePath);
    }
    if (deletedPaths.size > 0) this.forgetInodes([...deletedPaths]);
  }

  private rollbackSnapshotPathsFor(path: string, rollback: RuntimeFileSystemRollbackState): string[] {
    const normalizedPath = normalizeFsLockPath(path);
    const entry = rollback.entries.find((candidate) =>
      normalizedPath === candidate.path || normalizedPath.startsWith(`${candidate.path}/`)
    );
    if (!entry || entry.kind === 'missing') return [normalizedPath];
    if (entry.kind === 'file' || entry.kind === 'symlink') {
      return normalizedPath === entry.path ? [entry.path] : [normalizedPath];
    }
    const paths = [
      entry.path,
      ...entry.directories,
      ...entry.files.map((file) => file.path),
      ...entry.symlinks.map((symlink) => symlink.path),
    ];
    return paths.filter((candidate) =>
      candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)
    );
  }

  private async removeDirectoryIfEmpty(path: string, fs: IFileSystem = this.base): Promise<void> {
    if (path === this.workspaceRoot() || !(await fs.exists(path))) return;
    const stat = await fs.stat(path);
    if (!stat.isDirectory) return;
    if ((await fs.readdir(path)).length > 0) return;
    await fs.rm(path, { force: true, recursive: true });
  }

  private withReadLocks<T>(
    context: RuntimeCommandExecutionContext | undefined,
    paths: readonly string[],
    reason: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const generationContext = this.commandGenerationContextFor(context);
    return this.locks.withLocks(
      paths.map((path) => ({ path: normalizeFsLockPath(path), mode: 'shared', reason })),
      fn,
      generationContext?.signal
    ).catch((error) => {
      this.recordCommandErrorWithContext(context, error);
      throw error;
    });
  }

  private withMutationLocks<T>(
    context: RuntimeCommandExecutionContext | undefined,
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind,
    fn: () => Promise<T>,
    freshnessKind: RuntimeFileSystemMutationKind = kind
  ): Promise<T> {
    const generationContext = this.commandGenerationContextFor(context);
    const normalizedPaths = paths.map((path) => normalizeFsLockPath(path));
    const detail = {
      kind,
      paths: normalizedPaths.map((path) => isWithinWorkspace(this.workspaceRoot(), path) ? toProjectPath(this.workspaceRoot(), path) : path),
      absolutePaths: normalizedPaths,
    };
    this.onSyscallEvent({ type: 'fs-syscall-start', pid: generationContext?.pid, detail });
    return this.locks.withLocks(this.mutationLockRequests(paths, kind), async () => {
      this.assertCommandMutationFresh(context, paths, freshnessKind);
      if (this.beforeMutationObservers.size > 0) {
        const mutation = Object.freeze({
          paths: Object.freeze([...normalizedPaths]),
          kind,
          readFile: (path: string) => this.base.readFileBuffer(path),
        });
        for (const observer of this.beforeMutationObservers) {
          await observer(mutation);
        }
      }
      return fn();
    }, generationContext?.signal).then((result) => {
      this.onSyscallEvent({ type: 'fs-syscall-commit', pid: generationContext?.pid, detail });
      return result;
    }).catch((error) => {
      const commandError = runtimeCommandError(error);
      this.recordCommandErrorWithContext(context, error);
      this.onSyscallEvent({
        type: 'fs-syscall-abort',
        pid: generationContext?.pid,
        detail: {
          ...detail,
          ...(commandError
            ? { error: { code: commandError.code, message: commandError.message, ...(commandError.errno !== undefined ? { errno: commandError.errno } : {}), ...(commandError.syscall ? { syscall: commandError.syscall } : {}), ...(commandError.path ? { path: commandError.path } : {}) } }
            : { error: { message: error instanceof Error ? error.message : String(error) } }),
        },
      });
      throw error;
    });
  }

  withBaseMutation<T>(
    paths: readonly string[],
    fn: (base: IFileSystem) => Promise<T>,
    kind: RuntimeFileSystemMutationKind = 'file-write'
  ): Promise<T> {
    return this.withBaseMutationWithContext(undefined, paths, fn, kind);
  }

  withBaseMutationWithContext<T>(
    context: RuntimeCommandExecutionContext | undefined,
    paths: readonly string[],
    fn: (base: IFileSystem) => Promise<T>,
    kind: RuntimeFileSystemMutationKind = 'file-write',
    freshnessKind: RuntimeFileSystemMutationKind = kind
  ): Promise<T> {
    return this.withMutationLocks(context, paths, kind, async () => {
      const result = await fn(this.base);
      if (kind === 'delete' || kind === 'recursive-delete') {
        const deletedRoots = paths.map((path) => normalizeFsLockPath(this.mapPath(path)));
        const deletedInodePaths = [...this.inodes.keys()].filter((candidate) =>
          deletedRoots.some((root) =>
            candidate === root ||
            (kind === 'recursive-delete' && candidate.startsWith(`${root}/`))
          )
        );
        for (const inodePath of deletedInodePaths) {
          if (!(await this.base.exists(inodePath).catch(() => false))) {
            this.inodes.delete(inodePath);
          }
        }
      }
      this.recordMutation(context, paths, kind);
      return result;
    }, freshnessKind);
  }

  private currentGeneration(path: string): number {
    return this.generations.get(normalizeFsLockPath(path)) ?? 0;
  }

  private recordMutation(
    context: RuntimeCommandExecutionContext | undefined,
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind = 'file-write'
  ): void {
    const generationPaths = [...new Set(this.mutationGenerationPaths(paths, kind))];
    if (generationPaths.length === 0) return;
    this.mutationCounter += 1;
    const generation = this.nextGeneration++;
    for (const path of generationPaths) {
      this.generations.set(path, generation);
    }
    this.recordCommandMutation(context, generationPaths);
    for (const watcher of this.mutationWatchers) {
      try {
        watcher(this.mutationCounter);
      } catch {
        // Mutation observers are diagnostic/durability hooks and must not roll
        // back an already committed filesystem operation.
      }
    }
  }

  private forgetInodes(paths: readonly string[]): void {
    for (const path of paths) {
      this.inodes.delete(normalizeFsLockPath(path));
    }
  }

  private moveInodeSubtree(source: string, destination: string, paths: readonly string[]): void {
    const existingInodes = new Map<number, number>();
    for (const path of paths) {
      const inode = this.inodes.get(normalizeFsLockPath(path)) ?? this.inodeForPath(path);
      existingInodes.set(paths.indexOf(path), inode);
    }
    for (const [index, inode] of existingInodes) {
      const oldPath = paths[index]!;
      const newPath = oldPath === source ? destination : `${destination}/${oldPath.slice(source.length + 1)}`;
      this.inodes.delete(normalizeFsLockPath(oldPath));
      this.inodes.set(normalizeFsLockPath(newPath), inode);
    }
  }

  private assertCommandMutationFresh(
    context: RuntimeCommandExecutionContext | undefined,
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind
  ): void {
    const generationContext = this.commandGenerationContextFor(context);
    if (!generationContext) return;
    const generationPaths = [...new Set(this.mutationGenerationPaths(paths, kind))];
    for (const path of generationPaths.map(normalizeFsLockPath)) {
      if (generationContext.mutatedPaths.has(path)) continue;
      const expectedGeneration = generationContext.baseline.get(path) ?? 0;
      const actualGeneration = this.currentGeneration(path);
      if (actualGeneration !== expectedGeneration) {
        const displayPath = path === normalizeFsLockPath(this.workspaceRoot()) && paths[0]
          ? normalizeFsLockPath(paths[0])
          : path;
        throw new RuntimeFileGenerationConflictError(
          isWithinWorkspace(this.workspaceRoot(), displayPath) ? toProjectPath(this.workspaceRoot(), displayPath) : displayPath,
          expectedGeneration,
          actualGeneration
        );
      }
    }
  }

  private recordCommandMutation(context: RuntimeCommandExecutionContext | undefined, paths: readonly string[]): void {
    const generationContext = this.commandGenerationContextFor(context);
    if (!generationContext) return;
    for (const path of paths) {
      generationContext.mutatedPaths.add(normalizeFsLockPath(path));
    }
  }

  private readDynamicVirtualFile(
    context: RuntimeCommandExecutionContext | undefined,
    path: string,
    options?: FsReadFileOptions
  ): string | null {
    const content = this.dynamicProc.readFile(this.mapPath(path), context);
    if (content === null) return null;
    if ((options as { encoding?: unknown } | undefined)?.encoding === 'base64') {
      throw new Error(`Kernel virtual path does not support base64 reads: ${path}`);
    }
    return content;
  }

  private assertDynamicVirtualWritable(path: string, operation: string): void {
    if (!this.dynamicProc.readonlyNamespace(this.mapPath(path))) return;
    throw Object.assign(
      new Error(`EROFS: read-only file system, ${operation} '${path}'`),
      { code: 'EROFS' }
    );
  }

  private hidesProjectFiles(context: RuntimeCommandExecutionContext | undefined): context is RuntimeCommandExecutionContext {
    return context !== undefined && context.includeHiddenFiles !== true;
  }

  private assertCommandPathVisible(
    context: RuntimeCommandExecutionContext | undefined,
    absolutePath: string,
    operation: string
  ): void {
    if (!this.hidesProjectFiles(context) || !this.isHidden(absolutePath)) return;
    this.throwCommandPathHidden(absolutePath, operation);
  }

  private throwCommandPathHidden(absolutePath: string, operation: string): never {
    const displayPath = isWithinWorkspace(this.workspaceRoot(), absolutePath)
      ? toProjectPath(this.workspaceRoot(), absolutePath)
      : absolutePath;
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, ${operation} '${displayPath}'`),
      { code: 'ENOENT' }
    );
  }

  private async assertCommandReadTargetVisible(
    context: RuntimeCommandExecutionContext | undefined,
    absolutePath: string,
    operation: string
  ): Promise<void> {
    this.assertCommandPathVisible(context, absolutePath, operation);
    if (!this.hidesProjectFiles(context)) return;
    const realPath = await this.base.realpath(absolutePath).catch(() => absolutePath);
    this.assertCommandPathVisible(context, realPath, operation);
  }

  private async assertCommandCopySourceVisible(
    context: RuntimeCommandExecutionContext | undefined,
    absolutePath: string
  ): Promise<void> {
    await this.assertCommandReadTargetVisible(context, absolutePath, 'open');
    if (!this.hidesProjectFiles(context)) return;
    const stat = await this.base.stat(absolutePath).catch(() => null);
    if (!stat?.isDirectory) return;
    const containsHiddenPath = this.base.getAllPaths().some((candidate) =>
      candidate !== absolutePath &&
      isWithinWorkspace(absolutePath, candidate) &&
      this.isHidden(candidate)
    );
    if (containsHiddenPath) this.throwCommandPathHidden(absolutePath, 'open');
  }

  private filterCommandDirectoryEntries<T extends { name: string } | string>(
    context: RuntimeCommandExecutionContext | undefined,
    absoluteDirectoryPath: string,
    entries: T[]
  ): T[] {
    if (!this.hidesProjectFiles(context)) return entries;
    return entries.filter((entry) => {
      const name = typeof entry === 'string' ? entry : entry.name;
      return !this.isHidden(normalizeFsLockPath(`${absoluteDirectoryPath}/${name}`));
    });
  }

  readFile(path: string, options?: FsReadFileOptions): Promise<string> {
    return this.readFileWithContext(undefined, path, options);
  }

  readFileWithContext(context: RuntimeCommandExecutionContext | undefined, path: string, options?: FsReadFileOptions): Promise<string> {
    const dynamicProcFile = this.readDynamicVirtualFile(context, path, options);
    if (dynamicProcFile !== null) return Promise.resolve(dynamicProcFile);
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') return Promise.resolve(this.readDeviceFile(context, readTarget.path, options));
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') return Promise.resolve(this.readProcFile(readTarget.path, options));
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(kernelReadTargetError(path, readTarget));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks(context, [mappedPath], 'read-file', async () => {
      await this.assertCommandReadTargetVisible(context, mappedPath, 'open');
      return this.base.readFile(mappedPath, options);
    });
  }

  readFileBytes?(path: string): Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never> {
    return this.readFileBytesWithContext(undefined, path);
  }

  readFileBytesWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    path: string
  ): Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never> {
    const dynamicProcFile = this.readDynamicVirtualFile(context, path);
    if (dynamicProcFile !== null) {
      return Promise.resolve(textToByteString(dynamicProcFile)) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') {
      return Promise.resolve(textToByteString(this.readDeviceFile(context, readTarget.path))) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') {
      return Promise.resolve(textToByteString(this.readProcFile(readTarget.path))) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(kernelReadTargetError(path, readTarget));
    if (!this.base.readFileBytes) return Promise.reject(new Error('readFileBytes is not supported by this filesystem.'));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks(context, [mappedPath], 'read-file', async () => {
      await this.assertCommandReadTargetVisible(context, mappedPath, 'open');
      return this.base.readFileBytes!(mappedPath) as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    });
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.readFileBufferWithContext(undefined, path);
  }

  readFileBufferWithContext(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<Uint8Array> {
    const dynamicProcFile = this.readDynamicVirtualFile(context, path);
    if (dynamicProcFile !== null) return Promise.resolve(new TextEncoder().encode(dynamicProcFile));
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') return Promise.resolve(new TextEncoder().encode(this.readDeviceFile(context, readTarget.path)));
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') return Promise.resolve(new TextEncoder().encode(this.readProcFile(readTarget.path)));
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(kernelReadTargetError(path, readTarget));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks(context, [mappedPath], 'read-file', async () => {
      await this.assertCommandReadTargetVisible(context, mappedPath, 'open');
      return this.base.readFileBuffer(mappedPath);
    });
  }

  async writeFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    return this.writeFileWithContext(undefined, path, content, options);
  }

  async writeFileWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    path: string,
    content: FileContent,
    options?: FsWriteFileOptions
  ): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'write');
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(context, writeTarget.device, contentToText(content));
      return;
    }
    const mappedPath = this.mapPath(path);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedPath) ? 'file-write' : 'file-create';
    await this.withMutationLocks(context, [mappedPath], mutationKind, async () => {
      try {
        this.assertWritable(mappedPath, 'write');
      } catch (error) {
        if ((error as { code?: unknown }).code === 'EROFS' && await this.fileContentEquals(mappedPath, content)) return;
        throw error;
      }
      await this.base.writeFile(mappedPath, content, options);
      if (mutationKind === 'file-create' && context) {
        await this.base.chmod(mappedPath, 0o666 & ~context.umask);
      }
      this.inodeForPath(mappedPath);
      this.recordMutation(context, [mappedPath], mutationKind);
      await this.emitFileWrite(context, mappedPath);
    });
  }

  /**
   * Transitional TKFS write path.
   *
   * The 0.12 in-memory filesystem intentionally gives hard-link paths
   * copy-on-write behavior. TraceKernel requires POSIX inode behavior, so its
   * adapter updates every live pathname bound to the inode as one locked,
   * rollback-capable operation. This disappears when workspace storage moves
   * fully behind TKFS.
   */
  async writeFileByInodeWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    path: string,
    content: FileContent,
    options?: FsWriteFileOptions
  ): Promise<void> {
    const mappedPath = normalizeFsLockPath(this.mapPath(path));
    const identityPath = await this.inodeIdentityPathWithContext(context, mappedPath);
    if (!(await this.base.exists(identityPath).catch(() => false))) {
      return this.writeFileWithContext(context, mappedPath, content, options);
    }

    const inode = this.inodes.get(mappedPath)
      ?? this.inodes.get(identityPath)
      ?? this.inodeForPath(identityPath);
    if (mappedPath === identityPath) this.inodes.set(mappedPath, inode);
    const linkedPaths = [...this.inodes.entries()]
      .filter(([, candidate]) => candidate === inode)
      .map(([candidate]) => candidate)
      .filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);
    if (!linkedPaths.includes(identityPath)) linkedPaths.push(identityPath);

    await this.withMutationLocks(context, [mappedPath, ...linkedPaths], 'file-write', async () => {
      this.assertWritable(mappedPath, 'write');
      const previous = new Map<string, Uint8Array>();
      const written: string[] = [];
      for (const linkedPath of linkedPaths) {
        previous.set(linkedPath, Uint8Array.from(await this.base.readFileBuffer(linkedPath)));
      }
      try {
        for (const linkedPath of linkedPaths) {
          await this.base.writeFile(linkedPath, content, options);
          written.push(linkedPath);
        }
      } catch (error) {
        for (const linkedPath of written.reverse()) {
          const oldBytes = previous.get(linkedPath);
          if (oldBytes) await this.base.writeFile(linkedPath, oldBytes).catch(() => undefined);
        }
        throw error;
      }
      this.recordMutation(context, linkedPaths, 'file-write');
      for (const linkedPath of linkedPaths) {
        await this.emitFileWrite(context, linkedPath);
      }
    });
  }

  async appendFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    return this.appendFileWithContext(undefined, path, content, options);
  }

  async appendFileWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    path: string,
    content: FileContent,
    options?: FsWriteFileOptions
  ): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'append');
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(context, writeTarget.device, contentToText(content));
      return;
    }
    const mappedPath = this.mapPath(path);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedPath) ? 'file-write' : 'file-create';
    await this.withMutationLocks(context, [mappedPath], mutationKind, async () => {
      this.assertWritable(mappedPath, 'append');
      await this.base.appendFile(mappedPath, content, options);
      if (mutationKind === 'file-create' && context) {
        await this.base.chmod(mappedPath, 0o666 & ~context.umask);
      }
      this.inodeForPath(mappedPath);
      this.recordMutation(context, [mappedPath], mutationKind);
      await this.emitFileWrite(context, mappedPath);
    });
  }

  exists(path: string): Promise<boolean> {
    return this.existsWithContext(undefined, path);
  }

  async existsWithContext(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<boolean> {
    if (this.dynamicProc.entryKind(this.mapPath(path), context) !== null) return Promise.resolve(true);
    const accessTarget = kernelAccessTarget(path);
    if (accessTarget.kind === 'allowed') return Promise.resolve(true);
    if (accessTarget.kind === 'denied') return Promise.resolve(false);
    const mappedPath = this.mapPath(path);
    if (this.hidesProjectFiles(context) && this.isHidden(mappedPath)) return false;
    if (!(await this.base.exists(mappedPath))) return false;
    if (!this.hidesProjectFiles(context)) return true;
    const realPath = await this.base.realpath(mappedPath).catch(() => mappedPath);
    return !this.isHidden(realPath);
  }

  stat(path: string): Promise<Awaited<ReturnType<IFileSystem['stat']>>> {
    return this.statWithContext(undefined, path);
  }

  statWithContext(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<Awaited<ReturnType<IFileSystem['stat']>>> {
    const dynamicStat = this.dynamicProc.stat(this.mapPath(path), context);
    if (dynamicStat) return Promise.resolve(this.virtualStat(dynamicStat));
    const statTarget = kernelStatTarget(path, this.kernelInfo());
    if (statTarget.kind === 'stat') return Promise.resolve(this.virtualStat(statTarget.stat));
    if (statTarget.kind === 'error') return Promise.reject(new Error(`Kernel virtual path not found: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks(context, [mappedPath], 'stat', async () => {
      await this.assertCommandReadTargetVisible(context, mappedPath, 'stat');
      return this.base.stat(mappedPath);
    }).then((stat) => {
      if (isWithinWorkspace(this.workspaceRoot(), mappedPath)) this.inodeForPath(mappedPath);
      return stat;
    });
  }

  async mkdir(path: string, options?: FsMkdirOptions): Promise<void> {
    return this.mkdirWithContext(undefined, path, options);
  }

  async mkdirWithContext(context: RuntimeCommandExecutionContext | undefined, path: string, options?: FsMkdirOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'mkdir');
    const mkdirTarget = kernelMkdirTarget(path);
    if (mkdirTarget.kind === 'error') return Promise.reject(new Error(
      mkdirTarget.reason === 'proc-read-only'
        ? `Kernel proc path is read-only: ${path}`
        : `Kernel device namespace is read-only: ${path}`
    ));
    const mappedPath = this.mapPath(path);
    await this.withMutationLocks(context, [mappedPath], 'directory-create', async () => {
      const createdDirectories = await this.collectMissingDirectories(mappedPath);
      this.assertWritable(mappedPath, 'mkdir');
      await this.base.mkdir(mappedPath, options);
      for (const directoryPath of createdDirectories) {
        this.inodeForPath(directoryPath);
        if (context) await this.base.chmod(directoryPath, 0o777 & ~context.umask);
      }
      if (createdDirectories.length > 0) this.recordMutation(context, createdDirectories, 'directory-create');
      for (const directoryPath of createdDirectories) {
        this.emitDirectoryCreate(context, directoryPath);
      }
    });
  }

  readdir(path: string): Promise<string[]> {
    return this.readdirWithContext(undefined, path);
  }

  readdirWithContext(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<string[]> {
    const dynamicEntries = this.dynamicProc.readDir(this.mapPath(path), context);
    if (dynamicEntries) return Promise.resolve(dynamicEntries.map((entry) => entry.name));
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') return Promise.resolve(directoryTarget.entries.map((entry) => entry.name));
    if (directoryTarget.kind === 'error') {
      return Promise.reject(new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      ));
    }
    const mappedPath = this.mapPath(path);
    return this.withReadLocks(context, [mappedPath], 'readdir', async () => {
      await this.assertCommandReadTargetVisible(context, mappedPath, 'scandir');
      return this.filterCommandDirectoryEntries(context, mappedPath, await this.base.readdir(mappedPath));
    });
  }

  readdirWithFileTypes?(path: string): Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>> {
    return this.readdirWithFileTypesWithContext(undefined, path);
  }

  readdirWithFileTypesWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    path: string
  ): Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>> {
    const dynamicEntries = this.dynamicProc.readDir(this.mapPath(path), context);
    if (dynamicEntries) {
      return Promise.resolve(dynamicEntries.map((entry) => ({
        name: entry.name,
        isFile: entry.kind === 'file',
        isDirectory: entry.kind === 'directory',
        isSymbolicLink: false,
      }))) as Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>>;
    }
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') {
      return Promise.resolve(directoryTarget.entries.map((entry) => ({
        name: entry.name,
        isFile: entry.kind === 'file',
        isDirectory: entry.kind === 'directory',
        isSymbolicLink: false,
      })));
    }
    if (directoryTarget.kind === 'error') {
      return Promise.reject(new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      ));
    }
    if (!this.base.readdirWithFileTypes) return Promise.reject(new Error('readdirWithFileTypes is not supported by this filesystem.'));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks(context, [mappedPath], 'readdir', async () => {
      await this.assertCommandReadTargetVisible(context, mappedPath, 'scandir');
      return this.filterCommandDirectoryEntries(context, mappedPath, await this.base.readdirWithFileTypes!(mappedPath));
    });
  }

  async rm(path: string, options?: FsRmOptions): Promise<void> {
    return this.rmWithContext(undefined, path, options);
  }

  async rmWithContext(context: RuntimeCommandExecutionContext | undefined, path: string, options?: FsRmOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, options?.recursive ? 'recursive-delete' : 'delete');
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    const mappedPath = this.mapPath(path);
    await this.withMutationLocks(context, [mappedPath], options?.recursive ? 'recursive-delete' : 'delete', async () => {
      const deletedFiles = await this.collectExistingFiles(mappedPath);
      const deletedDirectories = await this.collectExistingDirectories(mappedPath);
      this.assertWritable(mappedPath, 'remove');
      this.assertWritableFiles(deletedFiles, 'remove');
      await this.base.rm(mappedPath, options);
      this.forgetInodes([mappedPath, ...deletedFiles, ...deletedDirectories]);
      this.recordMutation(context, [mappedPath, ...deletedFiles, ...deletedDirectories], options?.recursive ? 'recursive-delete' : 'delete');
      for (const deletedPath of deletedFiles) {
        this.emitFileDelete(context, deletedPath);
      }
      for (const deletedPath of deletedDirectories) {
        this.emitDirectoryDelete(context, deletedPath);
      }
    });
  }

  async cp(src: string, dest: string, options?: FsCpOptions): Promise<void> {
    return this.cpWithContext(undefined, src, dest, options);
  }

  async cpWithContext(context: RuntimeCommandExecutionContext | undefined, src: string, dest: string, options?: FsCpOptions): Promise<void> {
    this.assertDynamicVirtualWritable(dest, 'copy');
    const dynamicSourceFile = this.readDynamicVirtualFile(context, src);
    if (dynamicSourceFile !== null) {
      await this.copyDynamicVirtualFile(context, dest, dynamicSourceFile);
      return;
    }
    const copyTarget = kernelFileCopyTarget(src, dest);
    if (copyTarget.kind === 'virtual-source' || copyTarget.kind === 'device-destination') {
      await this.copyFileLike(context, src, dest, copyTarget);
      return;
    }
    if (copyTarget.kind === 'error') {
      throw new Error(
        copyTarget.reason === 'is-directory'
          ? `Kernel virtual path is a directory: ${src}`
          : copyTarget.side === 'destination'
            ? `Kernel virtual destination is not writable: ${dest}`
            : `Kernel virtual path not found: ${src}`
      );
    }
    const mappedSource = this.mapPath(src);
    const mappedDestination = this.mapPath(dest);
    await this.withMutationLocks(context, [mappedSource, mappedDestination], 'copy', async () => {
      await this.assertCommandCopySourceVisible(context, mappedSource);
      this.assertWritable(mappedDestination, 'copy');
      await this.base.cp(mappedSource, mappedDestination, options);
      this.inodeForPath(mappedDestination);
      this.recordMutation(context, [mappedSource, mappedDestination], 'copy');
      await this.emitExistingDirectories(context, mappedDestination);
      await this.emitExistingFiles(context, mappedDestination);
    });
  }

  private async copyFileLike(
    context: RuntimeCommandExecutionContext | undefined,
    src: string,
    dest: string,
    copyTarget: Exclude<ReturnType<typeof runtimeKernelFileCopyTarget>, { kind: 'workspace' | 'error' }>
  ): Promise<void> {
    const sourceBytes = await this.readKernelCopySource(context, src, copyTarget.source);
    if (copyTarget.kind === 'device-destination') {
      this.writeDevice(context, copyTarget.device, contentToText(sourceBytes));
      return;
    }
    const mappedDestination = this.mapPath(dest);
    await this.withMutationLocks(context, [mappedDestination], 'file-create', async () => {
      this.assertWritable(mappedDestination, 'copy');
      await this.base.writeFile(mappedDestination, sourceBytes);
      this.inodeForPath(mappedDestination);
      this.recordMutation(context, [mappedDestination], 'file-create');
      await this.emitFileWrite(context, mappedDestination);
    });
  }

  private async readKernelCopySource(
    context: RuntimeCommandExecutionContext | undefined,
    path: string,
    sourceTarget: ReturnType<typeof runtimeKernelFileReadTarget> = kernelFileReadTarget(path)
  ): Promise<FileContent> {
    if (sourceTarget.kind === 'device-file') return this.readDeviceFile(context, sourceTarget.path);
    if (sourceTarget.kind === 'proc-file') return readPublicRuntimeProcFile(sourceTarget.path, this.kernelInfo());
    if (sourceTarget.kind === 'error') throwKernelFileReadTargetError(path, sourceTarget);
    const mappedPath = this.mapPath(path);
    await this.assertCommandReadTargetVisible(context, mappedPath, 'open');
    return this.base.readFileBuffer(mappedPath);
  }

  private async copyDynamicVirtualFile(
    context: RuntimeCommandExecutionContext | undefined,
    dest: string,
    content: string
  ): Promise<void> {
    const writeTarget = kernelWriteTarget(dest);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(dest, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(context, writeTarget.device, content);
      return;
    }
    const mappedDestination = this.mapPath(dest);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedDestination) ? 'file-write' : 'file-create';
    await this.withMutationLocks(context, [mappedDestination], mutationKind, async () => {
      this.assertWritable(mappedDestination, 'copy');
      await this.base.writeFile(mappedDestination, content);
      this.inodeForPath(mappedDestination);
      this.recordMutation(context, [mappedDestination], mutationKind);
      await this.emitFileWrite(context, mappedDestination);
    });
  }

  private assertWritableFiles(paths: readonly string[], operation: string): void {
    for (const path of paths) {
      this.assertWritable(path, operation);
    }
  }

  private async fileContentEquals(path: string, content: FileContent): Promise<boolean> {
    try {
      return bytesEqual(await this.base.readFileBuffer(path), contentToBytes(content));
    } catch {
      return false;
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    return this.mvWithContext(undefined, src, dest);
  }

  async mvWithContext(context: RuntimeCommandExecutionContext | undefined, src: string, dest: string): Promise<void> {
    this.assertDynamicVirtualWritable(src, 'move');
    this.assertDynamicVirtualWritable(dest, 'move');
    const sourceMutationTarget = kernelMutationTarget(src);
    if (sourceMutationTarget.kind === 'error') throwKernelMutationTargetError(src, sourceMutationTarget, 'Kernel device namespace is read-only.');
    const destinationMutationTarget = kernelMutationTarget(dest);
    if (destinationMutationTarget.kind === 'error') throwKernelMutationTargetError(dest, destinationMutationTarget, 'Kernel device namespace is read-only.');
    const mappedSource = this.mapPath(src);
    const mappedDestination = this.mapPath(dest);
    await this.withMutationLocks(context, [mappedSource, mappedDestination], 'rename', async () => {
      const deletedFiles = await this.collectExistingFiles(mappedSource);
      const deletedDirectories = await this.collectExistingDirectories(mappedSource);
      const movedPaths = [...deletedDirectories, ...deletedFiles];
      this.assertWritableFiles(deletedFiles, 'move');
      this.assertWritable(mappedDestination, 'move');
      this.assertSubtreeWritable(mappedDestination, 'move');
      await this.base.mv(mappedSource, mappedDestination);
      this.moveInodeSubtree(mappedSource, mappedDestination, movedPaths.length > 0 ? movedPaths : [mappedSource]);
      this.recordMutation(context, [mappedSource, mappedDestination], 'rename');
      if (deletedFiles.length > 0 || deletedDirectories.length > 0) {
        this.recordMutation(context, [...deletedFiles, ...deletedDirectories], 'recursive-delete');
      }
      await this.emitExistingDirectories(context, mappedDestination);
      await this.emitExistingFiles(context, mappedDestination);
      for (const deletedPath of deletedFiles) {
        this.emitFileDelete(context, deletedPath);
      }
      for (const deletedPath of deletedDirectories) {
        this.emitDirectoryDelete(context, deletedPath);
      }
    });
  }

  resolvePath(base: string, path: string): string {
    return this.resolvePathWithContext(undefined, base, path);
  }

  resolvePathWithContext(_context: RuntimeCommandExecutionContext | undefined, base: string, path: string): string {
    if (isRuntimeKernelVirtualNamespacePath(path) || isRuntimeKernelVirtualNamespacePath(base)) {
      return this.base.resolvePath(base, path);
    }
    return this.mapPath(this.base.resolvePath(this.mapPath(base), path));
  }

  getAllPaths(): string[] {
    return this.getAllPathsWithContext(undefined);
  }

  getAllPathsWithContext(context: RuntimeCommandExecutionContext | undefined): string[] {
    const paths = this.hidesProjectFiles(context)
      ? this.base.getAllPaths().filter((path) => !this.isHidden(path))
      : this.base.getAllPaths();
    const alias = this.workspaceAlias();
    const root = this.workspaceRoot();
    const aliasPaths = !alias || alias === root
      ? paths
      : paths.flatMap((path) => {
          if (path === root) return [path, alias];
          if (path.startsWith(`${root}/`)) return [path, `${alias}${path.slice(root.length)}`];
          return [path];
        });
    const traceKernelBinPaths = (this.dynamicProc.readDir(TRACEKERNEL_BIN_PATH, context) ?? [])
      .map((entry) => `${TRACEKERNEL_BIN_PATH}/${entry.name}`);
    const skillPaths = this.dynamicProc.readDir(TRACEKERNEL_SKILLS_ROOT, context) === null
      ? []
      : this.dynamicVirtualPaths(TRACEKERNEL_SKILLS_ROOT, context);
    return Array.from(new Set([
      ...aliasPaths,
      ...runtimeKernelVirtualPaths(),
      '/tracekernel',
      TRACEKERNEL_BIN_PATH,
      ...traceKernelBinPaths,
      TRACEKERNEL_SKILLS_ROOT,
      ...skillPaths,
    ])).sort((left, right) => left.localeCompare(right));
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.chmodWithContext(undefined, path, mode);
  }

  chmodWithContext(context: RuntimeCommandExecutionContext | undefined, path: string, mode: number): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'chmod');
    const metadataTarget = kernelMetadataTarget(path);
    if (metadataTarget.kind === 'ignored-device') return Promise.resolve();
    if (metadataTarget.kind === 'error') throwKernelMetadataTargetError(path, metadataTarget);
    const mappedPath = this.mapPath(path);
    return this.withMutationLocks(context, [mappedPath], 'file-write', async () => {
      this.assertWritable(mappedPath, 'chmod');
      await this.base.chmod(mappedPath, mode);
      this.recordMutation(context, [mappedPath], 'file-write');
    });
  }

  symlink(target: string, linkPath: string): Promise<void> {
    return this.symlinkWithContext(undefined, target, linkPath);
  }

  symlinkWithContext(context: RuntimeCommandExecutionContext | undefined, target: string, linkPath: string): Promise<void> {
    this.assertDynamicVirtualWritable(linkPath, 'symlink');
    const symlinkTarget = kernelSymlinkTarget(linkPath);
    if (symlinkTarget.kind === 'error') throwKernelMutationTargetError(linkPath, symlinkTarget);
    const mappedPath = this.mapPath(linkPath);
    return this.withMutationLocks(context, [mappedPath], 'file-create', async () => {
      this.assertWritable(mappedPath, 'symlink');
      await this.base.symlink(target, mappedPath);
      this.recordMutation(context, [mappedPath], 'file-create');
      this.emitSymlinkCreate(context, mappedPath, target);
    });
  }

  link(existingPath: string, newPath: string): Promise<void> {
    return this.linkWithContext(undefined, existingPath, newPath);
  }

  linkWithContext(context: RuntimeCommandExecutionContext | undefined, existingPath: string, newPath: string): Promise<void> {
    this.assertDynamicVirtualWritable(existingPath, 'link');
    this.assertDynamicVirtualWritable(newPath, 'link');
    const linkTarget = kernelLinkTarget(existingPath, newPath);
    if (linkTarget.kind === 'error') throwKernelMutationTargetError(linkTarget.side === 'source' ? existingPath : newPath, linkTarget);
    const mappedNewPath = this.mapPath(newPath);
    const mappedExistingPath = this.mapPath(existingPath);
    return this.withMutationLocks(context, [mappedExistingPath, mappedNewPath], 'copy', async () => {
      await this.assertCommandReadTargetVisible(context, mappedExistingPath, 'link');
      this.assertWritable(mappedNewPath, 'link');
      await this.base.link(mappedExistingPath, mappedNewPath);
      this.bindInode(mappedExistingPath, mappedNewPath);
      this.recordMutation(context, [mappedExistingPath, mappedNewPath], 'copy');
    });
  }

  readlink(path: string): Promise<string> {
    return this.readlinkWithContext(undefined, path);
  }

  readlinkWithContext(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<string> {
    if (this.dynamicProc.entryKind(this.mapPath(path), context) !== null) {
      return Promise.reject(new Error(`Kernel virtual path is not a symbolic link: ${path}`));
    }
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind !== 'workspace') return Promise.reject(new Error(`Kernel virtual path is not a symbolic link: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks(context, [mappedPath], 'readlink', async () => {
      this.assertCommandPathVisible(context, mappedPath, 'readlink');
      const target = await this.base.readlink(mappedPath);
      if (this.hidesProjectFiles(context)) {
        const absoluteTarget = target.startsWith('/')
          ? this.mapPath(target)
          : normalizeFsLockPath(`${dirname(mappedPath)}/${target}`);
        this.assertCommandPathVisible(context, absoluteTarget, 'readlink');
      }
      return target;
    });
  }

  lstat(path: string): Promise<Awaited<ReturnType<IFileSystem['lstat']>>> {
    return this.lstatWithContext(undefined, path);
  }

  lstatWithContext(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<Awaited<ReturnType<IFileSystem['lstat']>>> {
    const dynamicStat = this.dynamicProc.stat(this.mapPath(path), context);
    if (dynamicStat) return Promise.resolve(this.virtualStat(dynamicStat));
    const statTarget = kernelStatTarget(path, this.kernelInfo());
    if (statTarget.kind === 'stat') return Promise.resolve(this.virtualStat(statTarget.stat));
    if (statTarget.kind === 'error') return Promise.reject(new Error(`Kernel virtual path not found: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks(context, [mappedPath], 'stat', async () => {
      this.assertCommandPathVisible(context, mappedPath, 'lstat');
      return this.base.lstat(mappedPath);
    });
  }

  realpath(path: string): Promise<string> {
    return this.realpathWithContext(undefined, path);
  }

  async realpathWithContext(_context: RuntimeCommandExecutionContext | undefined, path: string): Promise<string> {
    assertNoNul(path, 'Kernel path');
    if (this.dynamicProc.entryKind(this.mapPath(path), _context) !== null) return Promise.resolve(this.mapPath(path));
    if (isRuntimeKernelVirtualNamespacePath(path)) return Promise.resolve(path);
    let current = normalizeFsLockPath(this.mapPath(path));
    let followedLinks = 0;

    resolveAgain: while (true) {
      this.assertCommandPathVisible(_context, current, 'realpath');
      const parts = current.split('/').filter(Boolean);
      for (let index = 0; index < parts.length; index += 1) {
        const candidate = `/${parts.slice(0, index + 1).join('/')}`;
        this.assertCommandPathVisible(_context, candidate, 'realpath');
        const stat = await this.lstatWithContext(_context, candidate);
        if (runtimeFileSystemEntryIsSymlink(stat)) {
          followedLinks += 1;
          if (followedLinks > 40) {
            throw Object.assign(
              new Error(`ELOOP: too many symbolic links, realpath '${path}'`),
              { code: 'ELOOP' }
            );
          }
          const target = await this.readlinkWithContext(_context, candidate);
          const targetPath = target.startsWith('/')
            ? normalizeFsLockPath(this.mapPath(target))
            : normalizeFsLockPath(`${dirname(candidate)}/${target}`);
          const remaining = parts.slice(index + 1).join('/');
          current = remaining
            ? normalizeFsLockPath(`${targetPath}/${remaining}`)
            : targetPath;
          continue resolveAgain;
        }
        if (index < parts.length - 1 && !stat.isDirectory) {
          throw Object.assign(
            new Error(`ENOTDIR: path component is not a directory, realpath '${candidate}'`),
            { code: 'ENOTDIR' }
          );
        }
      }
      return current;
    }
  }

  private dynamicVirtualPaths(
    path: string,
    context: RuntimeCommandExecutionContext | undefined,
    seen = new Set<string>()
  ): string[] {
    if (seen.has(path)) return [];
    seen.add(path);
    const kind = this.dynamicProc.entryKind(path, context);
    if (!kind) return [];
    if (kind === 'file') return [path];
    const entries = this.dynamicProc.readDir(path, context) ?? [];
    return [
      path,
      ...entries.flatMap((entry) => this.dynamicVirtualPaths(`${path}/${entry.name}`, context, seen)),
    ];
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.utimesWithContext(undefined, path, atime, mtime);
  }

  utimesWithContext(
    context: RuntimeCommandExecutionContext | undefined,
    path: string,
    atime: Date,
    mtime: Date
  ): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'utimes');
    const metadataTarget = kernelMetadataTarget(path);
    if (metadataTarget.kind === 'ignored-device') return Promise.resolve();
    if (metadataTarget.kind === 'error') throwKernelMetadataTargetError(path, metadataTarget);
    const mappedPath = this.mapPath(path);
    return this.withMutationLocks(context, [mappedPath], 'file-write', async () => {
      await this.base.utimes(mappedPath, atime, mtime);
      this.recordMutation(context, [mappedPath], 'file-write');
    });
  }

  private mapPath(path: string): string {
    if (!path.startsWith('/')) return path;
    return mapWorkspaceAlias(this.workspaceRoot(), this.workspaceAlias(), path);
  }

  private async emitExistingFiles(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<void> {
    for (const filePath of await this.collectExistingFiles(path)) {
      await this.emitFileWrite(context, filePath);
    }
  }

  private async emitExistingDirectories(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<void> {
    for (const directoryPath of await this.collectExistingDirectories(path)) {
      this.emitDirectoryCreate(context, directoryPath);
    }
  }

  private resetLiveFileChangeBudgetFor(pid: number): void {
    if (this.liveFileChangeBudgetPid === pid) return;
    this.liveFileChangeBudgetPid = pid;
    this.liveFileChangeCount = 0;
    this.liveFileChangeBytes = 0;
  }

  private liveFileChangeContentBytes(stat: Awaited<ReturnType<IFileSystem['stat']>>): number | null {
    const size = (stat as { size?: unknown }).size;
    if (typeof size === 'number') return Number.isFinite(size) && size >= 0 ? Math.floor(size) : null;
    if (typeof size === 'bigint') {
      if (size < BigInt(0) || size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return Number(size);
    }
    return null;
  }

  private tryReserveLiveFileChange(
    context: RuntimeCommandExecutionContext | undefined,
    relativePath: string,
    contentBytes = 0
  ): boolean {
    if (!context) return false;
    this.resetLiveFileChangeBudgetFor(context.process.pid);
    const eventBytes = runtimeProjectUtf8Bytes(relativePath) + contentBytes;
    if (this.liveFileChangeCount + 1 > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES) return false;
    if (eventBytes > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) return false;
    if (this.liveFileChangeBytes + eventBytes > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) return false;
    this.liveFileChangeCount += 1;
    this.liveFileChangeBytes += eventBytes;
    return true;
  }

  private async collectMissingDirectories(path: string): Promise<string[]> {
    const root = this.workspaceRoot();
    if (!isWithinWorkspace(root, path)) return [];
    if (path === root) return [];
    const relativeParts = toProjectPath(root, path).split('/').filter(Boolean);
    const missing: string[] = [];
    let current = root;
    for (const part of relativeParts) {
      current = `${current}/${part}`;
      if (!(await this.base.exists(current))) missing.push(current);
    }
    return missing;
  }

  private async collectExistingFiles(path: string): Promise<string[]> {
    if (!isWithinWorkspace(this.workspaceRoot(), path) || !(await this.base.exists(path))) return [];
    const stat = await this.base.stat(path);
    if (stat.isFile) return [path];
    if (!stat.isDirectory) return [];
    const files: string[] = [];
    for (const entry of await this.base.readdir(path)) {
      files.push(...await this.collectExistingFiles(`${path}/${entry}`));
    }
    return files;
  }

  private async collectExistingDirectories(path: string): Promise<string[]> {
    if (!isWithinWorkspace(this.workspaceRoot(), path) || !(await this.base.exists(path))) return [];
    const stat = await this.base.stat(path);
    if (!stat.isDirectory) return [];
    const directories: string[] = [];
    for (const entry of await this.base.readdir(path)) {
      directories.push(...await this.collectExistingDirectories(`${path}/${entry}`));
    }
    directories.push(path);
    return directories.filter((directoryPath) => directoryPath !== this.workspaceRoot());
  }

  private async emitFileWrite(context: RuntimeCommandExecutionContext | undefined, path: string): Promise<void> {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    const stat = await this.base.stat(path).catch(() => null);
    if (!stat?.isFile) return;
    const contentBytes = this.liveFileChangeContentBytes(stat);
    if (contentBytes === null || !this.tryReserveLiveFileChange(context, projectPath, contentBytes)) return;
    const bytes = await this.base.readFileBuffer(path);
    const text = decodeUtf8(bytes);
    this.onFileChange(context, {
      path: projectPath,
      contents: text ?? base64FromBytes(bytes),
      ...(text === null ? { encoding: 'base64' as const } : {}),
    });
  }

  private emitFileDelete(context: RuntimeCommandExecutionContext | undefined, path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserveLiveFileChange(context, projectPath)) return;
    this.onFileChange(context, { path: projectPath, deleted: true });
  }

  private emitSymlinkCreate(context: RuntimeCommandExecutionContext | undefined, path: string, target: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserveLiveFileChange(context, projectPath, runtimeProjectUtf8Bytes(target))) return;
    this.onFileChange(context, { path: projectPath, symlink: true, target });
  }

  private emitDirectoryCreate(context: RuntimeCommandExecutionContext | undefined, path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path) || path === this.workspaceRoot()) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserveLiveFileChange(context, projectPath)) return;
    this.onFileChange(context, { path: projectPath, directory: true });
  }

  private emitDirectoryDelete(context: RuntimeCommandExecutionContext | undefined, path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path) || path === this.workspaceRoot()) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserveLiveFileChange(context, projectPath)) return;
    this.onFileChange(context, { path: projectPath, directory: true, deleted: true });
  }

  private readDeviceFile(
    context: RuntimeCommandExecutionContext | undefined,
    device: '/dev' | RuntimeKernelDevicePath,
    options?: FsReadFileOptions
  ): string {
    if (device === '/dev') throw new Error('Kernel device path is a directory: /dev');
    const inputDevice = runtimeDeviceInputSource(device);
    if (!inputDevice) throw new Error(`Kernel device is not readable: ${device}`);
    const content = this.readDevice(context, inputDevice);
    if (options === 'base64' || (typeof options === 'object' && options?.encoding === 'base64')) {
      return base64FromBytes(new TextEncoder().encode(content));
    }
    return content;
  }

  private readProcFile(path: string, options?: FsReadFileOptions): string {
    const content = readPublicRuntimeProcFile(path, this.kernelInfo());
    if (options === 'base64' || (typeof options === 'object' && options?.encoding === 'base64')) {
      return base64FromBytes(new TextEncoder().encode(content));
    }
    return content;
  }

  private writeDeviceFile(device: '/dev' | RuntimeKernelDevicePath, content: FileContent): void {
    if (device === '/dev') throw new Error('Kernel device path is a directory: /dev');
    const outputDevice = runtimeDeviceOutputTarget(device);
    if (!outputDevice) throw new Error(`Kernel device is read-only: ${device}`);
    this.writeDevice(undefined, outputDevice, contentToText(content));
  }

  private virtualStat(stat: RuntimeKernelVirtualStat): Awaited<ReturnType<IFileSystem['stat']>> {
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymbolicLink: false,
      mode: stat.mode,
      size: stat.size,
      mtime: new Date(0),
      ...(stat.uid !== undefined ? { uid: stat.uid } : {}),
      ...(stat.gid !== undefined ? { gid: stat.gid } : {}),
      ...(stat.owner !== undefined ? { owner: stat.owner } : {}),
      ...(stat.group !== undefined ? { group: stat.group } : {}),
      ...(stat.isCharacterDevice ? { isCharacterDevice: true } : {}),
    };
  }
}
