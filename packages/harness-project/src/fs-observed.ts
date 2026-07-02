import { AsyncLocalStorage } from 'node:async_hooks';
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
} from '../../harness-core/src/runtime-project';
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
  runtimeKernelFileReadErrorMessage,
  runtimeKernelFileReadTarget,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataErrorMessage,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationErrorMessage,
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
  runtimeKernelWriteErrorMessage,
  runtimeKernelWriteTarget,
  publicRuntimeKernelVirtualFiles,
  publicRuntimeKernelInfo,
  readPublicRuntimeProcFile,
  readRuntimeProcFile,
  createRuntimeKernelReadonlyFileError,
  type RuntimeKernelVirtualStat,
} from '../../harness-core/src/runtime-kernel';
import { getLanguageRuntimeInfo } from '../../harness-core/src/runtime-language-info';
import type { Language } from '../../harness-core/src/runtime-types';
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
} from '../../harness-core/src/runtime-project';
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
  TypeScriptProjectCommandRunner,
} from './index';
import { TRACEKERNEL_BIN_PATH, TRACEKERNEL_SKILLS_ROOT } from './constants';
import { assertNoNul, dirname, isRuntimeSkillsNamespacePath, isWithinWorkspace, mapWorkspaceAlias, normalizeRuntimeProjectPath, normalizeRuntimeSkillPath, normalizeRuntimeSkillsVirtualPath, normalizeWorkspaceCwd, resolveWorkspaceCommandPath, toProjectDirectoryPath, toProjectPath, toWorkspaceEntryPath, toWorkspacePath } from './paths';
import { RuntimeFileGenerationConflictError, RuntimeFileSystemLockCoordinator, fsMutationGenerationPaths, fsMutationLockRequests, normalizeFsLockPath, type RuntimeFileSystemLockRequest, type RuntimeFileSystemMutationKind } from './locks';
import { RuntimeKernelInterruptedError } from './scheduler';
import type { JustBashRuntimeWorkspace } from './index';

export interface RuntimeDynamicProcEntry {
  name: string;
  kind: 'file' | 'directory';
}

export interface RuntimeDynamicProcProvider {
  readFile(path: string): string | null;
  readDir(path: string): RuntimeDynamicProcEntry[] | null;
  entryKind(path: string): 'file' | 'directory' | null;
  stat(path: string): RuntimeKernelVirtualStat | null;
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


export function normalizeProcPath(path: string): string | null {
  assertNoNul(path, 'Kernel path');
  return normalizeRuntimeProcPath(path);
}


export function kernelWriteTarget(path: string): ReturnType<typeof runtimeKernelWriteTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelWriteTarget(path);
}


export function throwKernelWriteTargetError(path: string, target: Extract<ReturnType<typeof runtimeKernelWriteTarget>, { kind: 'error' }>): never {
  throw new Error(runtimeKernelWriteErrorMessage(path, target));
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
  throw new Error(runtimeKernelMutationErrorMessage(path, target, { deviceMessage }));
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
  return new Error(runtimeKernelReadErrorMessage(path, target));
}


export function throwKernelFileReadTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelFileReadTarget>, { kind: 'error' }>
): never {
  throw new Error(runtimeKernelFileReadErrorMessage(path, target));
}


export function kernelDirectoryTarget(path: string): ReturnType<typeof runtimeKernelDirectoryTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelDirectoryTarget(path);
}


export function throwKernelMetadataTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelMetadataTarget>, { kind: 'error' }>
): never {
  throw new Error(runtimeKernelMetadataErrorMessage(path, target));
}


export function isRuntimeDirectoryChange(change: RuntimeFileChange): change is RuntimeDirectoryChange {
  return (change as RuntimeDirectoryChange).directory === true;
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
  seenDirectories = new Set<string>()
): Promise<void> {
  if (!isWithinWorkspace(cwd, absolutePath)) {
    throw new Error(`Refusing to snapshot path outside workspace: ${absolutePath}`);
  }

  const stat = await fs.lstat(absolutePath);
  if (runtimeFileSystemEntryIsSymlink(stat)) return;
  if (stat.isFile) {
    const bytes = await fs.readFileBuffer(absolutePath);
    const text = decodeUtf8(bytes);
    files.push({
      path: toProjectPath(cwd, absolutePath),
      contents: text ?? base64FromBytes(bytes),
      encoding: text === null ? 'base64' : 'utf8',
    });
    return;
  }

  if (!stat.isDirectory) return;
  const directoryKey = runtimeFileSystemEntryKey(absolutePath, stat);
  if (seenDirectories.has(directoryKey)) return;
  seenDirectories.add(directoryKey);
  const directoryPath = toProjectDirectoryPath(cwd, absolutePath);
  if (directoryPath !== null) directories.push(directoryPath);

  for (const entry of await fs.readdir(absolutePath)) {
    await collectSnapshotFiles(fs, cwd, `${absolutePath}/${entry}`, files, directories, seenDirectories);
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
  const virtualFiles = options.publicView === false
    ? runtimeKernelVirtualFiles(info)
    : publicRuntimeKernelVirtualFiles(info);
  if (files.length === 0) return virtualFiles;
  const byPath = new Map(files.map((file) => [file.path, file]));
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
  await collectSnapshotFiles(ctx.fs, workspaceRoot, workspaceRoot, files, directories);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.localeCompare(right));
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
    ...(directories.length > 0 ? { directories } : {}),
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
  return files.length === snapshot.files.length ? snapshot : { ...snapshot, files };
}


export function filterHiddenSnapshotFiles(
  snapshot: RuntimeProjectSnapshot,
  hiddenFiles?: readonly string[]
): RuntimeProjectSnapshot {
  if (!hiddenFiles || hiddenFiles.length === 0) return snapshot;
  const hidden = new Set(hiddenFiles.map((path) => normalizeRuntimeProjectPath(path)));
  if (hidden.size === 0) return snapshot;
  const files = snapshot.files.filter((file) => !hidden.has(normalizeRuntimeProjectPath(file.path)));
  const directories = snapshot.directories?.filter((directory) => {
    const normalized = normalizeRuntimeProjectPath(directory);
    return ![...hidden].some((hiddenPath) => hiddenPath === normalized || hiddenPath.startsWith(`${normalized}/`));
  });
  const { directories: _directories, hiddenFiles: _hiddenFiles, ...rest } = snapshot;
  return {
    ...rest,
    files,
    ...(directories && directories.length > 0 ? { directories } : {}),
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


export type RuntimeFileChangeObserver = (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => void;


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
    if (ctx.fs instanceof KernelObservedFileSystem && result.files?.length) {
      const committed = await ctx.fs.applyFinalDiffTransaction(result.files, (file) =>
        prepareFinalDiffChange(workspaceRoot, file)
      );
      for (const file of committed) {
        onFileChange?.(file, 'final-diff');
      }
      const { files: _files, ...commandResult } = result;
      return commandResult;
    }
    return await applyRuntimeCommandResultFiles(result, async (file, phase) => {
      await withSuspendedFsNotifications(ctx.fs, async () => {
        if (ctx.fs instanceof KernelObservedFileSystem) {
          ctx.fs.assertFileChangeGenerationFresh(file, phase);
        }
        const absolutePath = toWorkspacePath(workspaceRoot, file.path);
        if (isRuntimeDirectoryChange(file)) {
          if (file.deleted === true) {
            await ctx.fs.rm(absolutePath, { force: true, recursive: true });
          } else {
            await ctx.fs.mkdir(absolutePath, { recursive: true });
          }
          onFileChange?.(file, phase);
          return;
        }
        if ((file as { deleted?: boolean }).deleted === true) {
          await ctx.fs.rm(absolutePath, { force: true });
          onFileChange?.(file, phase);
          return;
        }
        const changedFile = file as RuntimeFile;
        await ctx.fs.mkdir(dirname(absolutePath), { recursive: true });
        if ((changedFile.encoding ?? 'utf8') === 'base64') {
          await ctx.fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
        } else {
          await ctx.fs.writeFile(absolutePath, changedFile.contents);
        }
        onFileChange?.(changedFile, phase);
      });
    });
  } catch (error) {
    if (isKernelReadonlyError(error) || isRuntimeFileGenerationConflict(error)) {
      if (ctx.fs instanceof KernelObservedFileSystem) ctx.fs.recordCommandError(error);
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
      : toWorkspacePath(workspaceRoot, (file as RuntimeFile).path);
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
        }
        return;
      }
      if ((file as RuntimeFileDeletion).deleted === true) {
        await fs.rm(absolutePath, { force: true });
        return;
      }
      const changedFile = file as RuntimeFile;
      await fs.mkdir(dirname(absolutePath), { recursive: true });
      if ((changedFile.encoding ?? 'utf8') === 'base64') {
        await fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
      } else {
        await fs.writeFile(absolutePath, changedFile.contents);
      }
    },
  };
}


export async function withSuspendedFsNotifications<T>(fs: CommandContext['fs'], fn: () => Promise<T>): Promise<T> {
  if (fs instanceof KernelObservedFileSystem) {
    return fs.suspendNotifications(fn);
  }
  return fn();
}


export async function applyWorkspaceCommandResultFiles(
  workspace: JustBashRuntimeWorkspace,
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


export class KernelObservedFileSystem implements IFileSystem {
  private suspendDepth = 0;
  private nextGeneration = 1;
  private nextInode = 10_000;
  private readonly generations = new Map<string, number>();
  private readonly inodes = new Map<string, number>();
  private liveFileChangeBudgetPid: number | undefined;
  private liveFileChangeCount = 0;
  private liveFileChangeBytes = 0;

  constructor(
    private readonly base: IFileSystem,
    private readonly locks: RuntimeFileSystemLockCoordinator,
    private readonly workspaceRoot: () => string,
    private readonly workspaceAlias: () => string | undefined,
    private readonly kernelInfo: () => RuntimeKernelInfo,
    private readonly assertWritable: (absolutePath: string, operation: string) => void,
    private readonly assertSubtreeWritable: (absolutePath: string, operation: string) => void,
    private readonly generationBaseline: () => RuntimeFileSystemGenerationSnapshot | undefined,
    private readonly commandGenerationContext: () => RuntimeFileSystemCommandGenerationContext | undefined,
    private readonly onSyscallEvent: (event: RuntimeFileSystemSyscallEvent) => void,
    private readonly dynamicProc: RuntimeDynamicProcProvider,
    private readonly onFileChange: (change: RuntimeFileChange) => void,
    private readonly readDevice: (device: RuntimeKernelDevicePath) => string,
    private readonly writeDevice: (device: RuntimeKernelDevicePath, data: string) => void
  ) {}

  suspendNotifications<T>(fn: () => Promise<T>): Promise<T> {
    this.suspendDepth += 1;
    return fn().finally(() => {
      this.suspendDepth -= 1;
    });
  }

  snapshotGenerations(): RuntimeFileSystemGenerationSnapshot {
    return new Map(this.generations);
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

  assertFileChangeGenerationFresh(change: RuntimeFileChange, phase: RuntimeFileMutationPhase): void {
    if (phase !== 'final-diff') return;
    const baseline = this.generationBaseline();
    if (!baseline) return;
    const path = this.mapPath(runtimeFileChangePath(change));
    const kind = this.finalDiffMutationKind(change, path);
    this.assertCommandMutationFresh([path], kind);
  }

  async applyFinalDiffTransaction(
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
    const generationContext = this.commandGenerationContext();
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
            this.assertCommandMutationFresh([change.absolutePath], change.kind);
            await this.validateFinalDiffPreparedChange(change);
          }
          await this.validateFinalDiffDirectoryDeletes(prepared);
          const rollback = await this.snapshotRollbackState(prepared.map((change) => change.absolutePath));
          const committed: RuntimeFileChange[] = [];
          try {
            await this.suspendNotifications(async () => {
              for (const change of prepared) {
                await change.apply(this.base);
                committed.push(change.change);
              }
            });
          } catch (error) {
            await this.restoreRollbackState(rollback);
            rolledBack = true;
            throw error;
          }
          await this.recordFinalDiffInodeMutations(prepared, rollback);
          for (const change of prepared) {
            this.recordMutation([change.absolutePath], change.kind);
          }
          this.onSyscallEvent({ type: 'fs-transaction-commit', pid: generationContext?.pid, detail });
          return committed;
        },
        generationContext?.signal
      );
    } catch (error) {
      const commandError = runtimeCommandError(error);
      this.recordCommandError(error);
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
    const commandError = runtimeCommandError(error);
    if (commandError) this.commandGenerationContext()?.setError(commandError);
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

  private async restoreRollbackState(state: RuntimeFileSystemRollbackState): Promise<void> {
    for (const entry of state.entries) {
      await this.removeRollbackPath(entry.path);
      if (entry.kind === 'missing') continue;
      if (entry.kind === 'file') {
        await this.base.mkdir(dirname(entry.path), { recursive: true });
        await this.base.writeFile(entry.path, entry.contents);
        continue;
      }
      if (entry.kind === 'symlink') {
        await this.base.mkdir(dirname(entry.path), { recursive: true });
        await this.base.symlink(entry.target, entry.path);
        continue;
      }
      await this.base.mkdir(entry.path, { recursive: true });
      for (const directoryPath of [...entry.directories].sort((left, right) => left.length - right.length)) {
        await this.base.mkdir(directoryPath, { recursive: true });
      }
      for (const file of entry.files) {
        await this.base.mkdir(dirname(file.path), { recursive: true });
        await this.base.writeFile(file.path, file.contents);
      }
      for (const symlink of entry.symlinks) {
        await this.base.mkdir(dirname(symlink.path), { recursive: true });
        await this.base.symlink(symlink.target, symlink.path);
      }
    }
    for (const directoryPath of state.createdAncestors) {
      await this.removeDirectoryIfEmpty(directoryPath);
    }
  }

  private async removeRollbackPath(path: string): Promise<void> {
    if (path === this.workspaceRoot()) {
      for (const entry of await this.base.readdir(path).catch(() => [])) {
        await this.base.rm(`${path}/${entry}`, { force: true, recursive: true });
      }
      return;
    }
    await this.base.rm(path, { force: true, recursive: true });
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

  private async removeDirectoryIfEmpty(path: string): Promise<void> {
    if (path === this.workspaceRoot() || !(await this.base.exists(path))) return;
    const stat = await this.base.stat(path);
    if (!stat.isDirectory) return;
    if ((await this.base.readdir(path)).length > 0) return;
    await this.base.rm(path, { force: true, recursive: true });
  }

  private withReadLocks<T>(paths: readonly string[], reason: string, fn: () => Promise<T>): Promise<T> {
    const generationContext = this.commandGenerationContext();
    return this.locks.withLocks(
      paths.map((path) => ({ path: normalizeFsLockPath(path), mode: 'shared', reason })),
      fn,
      generationContext?.signal
    ).catch((error) => {
      this.recordCommandError(error);
      throw error;
    });
  }

  private withMutationLocks<T>(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind,
    fn: () => Promise<T>
  ): Promise<T> {
    const generationContext = this.commandGenerationContext();
    const normalizedPaths = paths.map((path) => normalizeFsLockPath(path));
    const detail = {
      kind,
      paths: normalizedPaths.map((path) => isWithinWorkspace(this.workspaceRoot(), path) ? toProjectPath(this.workspaceRoot(), path) : path),
      absolutePaths: normalizedPaths,
    };
    this.onSyscallEvent({ type: 'fs-syscall-start', pid: generationContext?.pid, detail });
    return this.locks.withLocks(this.mutationLockRequests(paths, kind), async () => {
      this.assertCommandMutationFresh(paths, kind);
      return fn();
    }, generationContext?.signal).then((result) => {
      this.onSyscallEvent({ type: 'fs-syscall-commit', pid: generationContext?.pid, detail });
      return result;
    }).catch((error) => {
      const commandError = runtimeCommandError(error);
      this.recordCommandError(error);
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
    return this.withMutationLocks(paths, kind, async () => {
      const result = await fn(this.base);
      this.recordMutation(paths, kind);
      return result;
    });
  }

  private currentGeneration(path: string): number {
    return this.generations.get(normalizeFsLockPath(path)) ?? 0;
  }

  private recordMutation(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind = 'file-write'
  ): void {
    const generationPaths = [...new Set(this.mutationGenerationPaths(paths, kind))];
    if (generationPaths.length === 0) return;
    const generation = this.nextGeneration++;
    for (const path of generationPaths) {
      this.generations.set(path, generation);
    }
    this.recordCommandMutation(generationPaths);
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
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind
  ): void {
    const generationContext = this.commandGenerationContext();
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

  private recordCommandMutation(paths: readonly string[]): void {
    const generationContext = this.commandGenerationContext();
    if (!generationContext) return;
    for (const path of paths) {
      generationContext.mutatedPaths.add(normalizeFsLockPath(path));
    }
  }

  private readDynamicVirtualFile(path: string, options?: FsReadFileOptions): string | null {
    const content = this.dynamicProc.readFile(this.mapPath(path));
    if (content === null) return null;
    if ((options as { encoding?: unknown } | undefined)?.encoding === 'base64') {
      throw new Error(`Kernel virtual path does not support base64 reads: ${path}`);
    }
    return content;
  }

  private assertDynamicVirtualWritable(path: string, operation: string): void {
    if (!this.dynamicProc.readonlyNamespace(this.mapPath(path))) return;
    throw Object.assign(
      new Error(`EROFS: kernel virtual path is read-only, ${operation} '${path}'`),
      { code: 'EROFS' }
    );
  }

  readFile(path: string, options?: FsReadFileOptions): Promise<string> {
    const dynamicProcFile = this.readDynamicVirtualFile(path, options);
    if (dynamicProcFile !== null) return Promise.resolve(dynamicProcFile);
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') return Promise.resolve(this.readDeviceFile(readTarget.path, options));
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') return Promise.resolve(this.readProcFile(readTarget.path, options));
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(kernelReadTargetError(path, readTarget));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'read-file', () => this.base.readFile(mappedPath, options));
  }

  readFileBytes?(path: string): Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never> {
    const dynamicProcFile = this.readDynamicVirtualFile(path);
    if (dynamicProcFile !== null) {
      return Promise.resolve(textToByteString(dynamicProcFile)) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') {
      return Promise.resolve(textToByteString(this.readDeviceFile(readTarget.path))) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') {
      return Promise.resolve(textToByteString(this.readProcFile(readTarget.path))) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(kernelReadTargetError(path, readTarget));
    if (!this.base.readFileBytes) return Promise.reject(new Error('readFileBytes is not supported by this filesystem.'));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'read-file', () =>
      this.base.readFileBytes!(mappedPath) as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>
    );
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    const dynamicProcFile = this.readDynamicVirtualFile(path);
    if (dynamicProcFile !== null) return Promise.resolve(new TextEncoder().encode(dynamicProcFile));
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') return Promise.resolve(new TextEncoder().encode(this.readDeviceFile(readTarget.path)));
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') return Promise.resolve(new TextEncoder().encode(this.readProcFile(readTarget.path)));
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(kernelReadTargetError(path, readTarget));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'read-file', () => this.base.readFileBuffer(mappedPath));
  }

  async writeFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'write');
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, contentToText(content));
      return;
    }
    const mappedPath = this.mapPath(path);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedPath) ? 'file-write' : 'file-create';
    await this.withMutationLocks([mappedPath], mutationKind, async () => {
      try {
        this.assertWritable(mappedPath, 'write');
      } catch (error) {
        if ((error as { code?: unknown }).code === 'EROFS' && await this.fileContentEquals(mappedPath, content)) return;
        throw error;
      }
      await this.base.writeFile(mappedPath, content, options);
      this.inodeForPath(mappedPath);
      this.recordMutation([mappedPath], mutationKind);
      await this.emitFileWrite(mappedPath);
    });
  }

  async appendFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'append');
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, contentToText(content));
      return;
    }
    const mappedPath = this.mapPath(path);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedPath) ? 'file-write' : 'file-create';
    await this.withMutationLocks([mappedPath], mutationKind, async () => {
      this.assertWritable(mappedPath, 'append');
      await this.base.appendFile(mappedPath, content, options);
      this.inodeForPath(mappedPath);
      this.recordMutation([mappedPath], mutationKind);
      await this.emitFileWrite(mappedPath);
    });
  }

  exists(path: string): Promise<boolean> {
    if (this.dynamicProc.entryKind(this.mapPath(path)) !== null) return Promise.resolve(true);
    const accessTarget = kernelAccessTarget(path);
    if (accessTarget.kind === 'allowed') return Promise.resolve(true);
    if (accessTarget.kind === 'denied') return Promise.resolve(false);
    return this.base.exists(this.mapPath(path));
  }

  stat(path: string): Promise<Awaited<ReturnType<IFileSystem['stat']>>> {
    const dynamicStat = this.dynamicProc.stat(this.mapPath(path));
    if (dynamicStat) return Promise.resolve(this.virtualStat(dynamicStat));
    const statTarget = kernelStatTarget(path, this.kernelInfo());
    if (statTarget.kind === 'stat') return Promise.resolve(this.virtualStat(statTarget.stat));
    if (statTarget.kind === 'error') return Promise.reject(new Error(`Kernel virtual path not found: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'stat', () => this.base.stat(mappedPath)).then((stat) => {
      if (isWithinWorkspace(this.workspaceRoot(), mappedPath)) this.inodeForPath(mappedPath);
      return stat;
    });
  }

  async mkdir(path: string, options?: FsMkdirOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'mkdir');
    const mkdirTarget = kernelMkdirTarget(path);
    if (mkdirTarget.kind === 'error') return Promise.reject(new Error(
      mkdirTarget.reason === 'proc-read-only'
        ? `Kernel proc path is read-only: ${path}`
        : `Kernel device namespace is read-only: ${path}`
    ));
    const mappedPath = this.mapPath(path);
    await this.withMutationLocks([mappedPath], 'directory-create', async () => {
      const createdDirectories = await this.collectMissingDirectories(mappedPath);
      this.assertWritable(mappedPath, 'mkdir');
      await this.base.mkdir(mappedPath, options);
      for (const directoryPath of createdDirectories) {
        this.inodeForPath(directoryPath);
      }
      if (createdDirectories.length > 0) this.recordMutation(createdDirectories, 'directory-create');
      for (const directoryPath of createdDirectories) {
        this.emitDirectoryCreate(directoryPath);
      }
    });
  }

  readdir(path: string): Promise<string[]> {
    const dynamicEntries = this.dynamicProc.readDir(this.mapPath(path));
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
    return this.withReadLocks([mappedPath], 'readdir', () => this.base.readdir(mappedPath));
  }

  readdirWithFileTypes?(path: string): Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>> {
    const dynamicEntries = this.dynamicProc.readDir(this.mapPath(path));
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
    return this.withReadLocks([mappedPath], 'readdir', () => this.base.readdirWithFileTypes!(mappedPath));
  }

  async rm(path: string, options?: FsRmOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, options?.recursive ? 'recursive-delete' : 'delete');
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    const mappedPath = this.mapPath(path);
    await this.withMutationLocks([mappedPath], options?.recursive ? 'recursive-delete' : 'delete', async () => {
      const deletedFiles = await this.collectExistingFiles(mappedPath);
      const deletedDirectories = await this.collectExistingDirectories(mappedPath);
      this.assertWritable(mappedPath, 'remove');
      this.assertWritableFiles(deletedFiles, 'remove');
      await this.base.rm(mappedPath, options);
      this.forgetInodes([mappedPath, ...deletedFiles, ...deletedDirectories]);
      this.recordMutation([mappedPath, ...deletedFiles, ...deletedDirectories], options?.recursive ? 'recursive-delete' : 'delete');
      for (const deletedPath of deletedFiles) {
        this.emitFileDelete(deletedPath);
      }
      for (const deletedPath of deletedDirectories) {
        this.emitDirectoryDelete(deletedPath);
      }
    });
  }

  async cp(src: string, dest: string, options?: FsCpOptions): Promise<void> {
    this.assertDynamicVirtualWritable(dest, 'copy');
    const dynamicSourceFile = this.readDynamicVirtualFile(src);
    if (dynamicSourceFile !== null) {
      await this.copyDynamicVirtualFile(dest, dynamicSourceFile);
      return;
    }
    const copyTarget = kernelFileCopyTarget(src, dest);
    if (copyTarget.kind === 'virtual-source' || copyTarget.kind === 'device-destination') {
      await this.copyFileLike(src, dest, copyTarget);
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
    await this.withMutationLocks([mappedSource, mappedDestination], 'copy', async () => {
      this.assertWritable(mappedDestination, 'copy');
      await this.base.cp(mappedSource, mappedDestination, options);
      this.inodeForPath(mappedDestination);
      this.recordMutation([mappedSource, mappedDestination], 'copy');
      await this.emitExistingDirectories(mappedDestination);
      await this.emitExistingFiles(mappedDestination);
    });
  }

  private async copyFileLike(
    src: string,
    dest: string,
    copyTarget: Exclude<ReturnType<typeof runtimeKernelFileCopyTarget>, { kind: 'workspace' | 'error' }>
  ): Promise<void> {
    const sourceBytes = await this.readKernelCopySource(src, copyTarget.source);
    if (copyTarget.kind === 'device-destination') {
      this.writeDevice(copyTarget.device, contentToText(sourceBytes));
      return;
    }
    const mappedDestination = this.mapPath(dest);
    await this.withMutationLocks([mappedDestination], 'file-create', async () => {
      this.assertWritable(mappedDestination, 'copy');
      await this.base.writeFile(mappedDestination, sourceBytes);
      this.inodeForPath(mappedDestination);
      this.recordMutation([mappedDestination], 'file-create');
      await this.emitFileWrite(mappedDestination);
    });
  }

  private async readKernelCopySource(
    path: string,
    sourceTarget: ReturnType<typeof runtimeKernelFileReadTarget> = kernelFileReadTarget(path)
  ): Promise<FileContent> {
    if (sourceTarget.kind === 'device-file') return this.readDeviceFile(sourceTarget.path);
    if (sourceTarget.kind === 'proc-file') return readPublicRuntimeProcFile(sourceTarget.path, this.kernelInfo());
    if (sourceTarget.kind === 'error') throwKernelFileReadTargetError(path, sourceTarget);
    return this.base.readFileBuffer(this.mapPath(path));
  }

  private async copyDynamicVirtualFile(dest: string, content: string): Promise<void> {
    const writeTarget = kernelWriteTarget(dest);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(dest, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, content);
      return;
    }
    const mappedDestination = this.mapPath(dest);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedDestination) ? 'file-write' : 'file-create';
    await this.withMutationLocks([mappedDestination], mutationKind, async () => {
      this.assertWritable(mappedDestination, 'copy');
      await this.base.writeFile(mappedDestination, content);
      this.inodeForPath(mappedDestination);
      this.recordMutation([mappedDestination], mutationKind);
      await this.emitFileWrite(mappedDestination);
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
    this.assertDynamicVirtualWritable(src, 'move');
    this.assertDynamicVirtualWritable(dest, 'move');
    const sourceMutationTarget = kernelMutationTarget(src);
    if (sourceMutationTarget.kind === 'error') throwKernelMutationTargetError(src, sourceMutationTarget, 'Kernel device namespace is read-only.');
    const destinationMutationTarget = kernelMutationTarget(dest);
    if (destinationMutationTarget.kind === 'error') throwKernelMutationTargetError(dest, destinationMutationTarget, 'Kernel device namespace is read-only.');
    const mappedSource = this.mapPath(src);
    const mappedDestination = this.mapPath(dest);
    await this.withMutationLocks([mappedSource, mappedDestination], 'rename', async () => {
      const deletedFiles = await this.collectExistingFiles(mappedSource);
      const deletedDirectories = await this.collectExistingDirectories(mappedSource);
      const movedPaths = [...deletedDirectories, ...deletedFiles];
      this.assertWritableFiles(deletedFiles, 'move');
      this.assertWritable(mappedDestination, 'move');
      this.assertSubtreeWritable(mappedDestination, 'move');
      await this.base.mv(mappedSource, mappedDestination);
      this.moveInodeSubtree(mappedSource, mappedDestination, movedPaths.length > 0 ? movedPaths : [mappedSource]);
      this.recordMutation([mappedSource, mappedDestination], 'rename');
      if (deletedFiles.length > 0 || deletedDirectories.length > 0) {
        this.recordMutation([...deletedFiles, ...deletedDirectories], 'recursive-delete');
      }
      await this.emitExistingDirectories(mappedDestination);
      await this.emitExistingFiles(mappedDestination);
      for (const deletedPath of deletedFiles) {
        this.emitFileDelete(deletedPath);
      }
      for (const deletedPath of deletedDirectories) {
        this.emitDirectoryDelete(deletedPath);
      }
    });
  }

  resolvePath(base: string, path: string): string {
    if (isRuntimeKernelVirtualNamespacePath(path) || isRuntimeKernelVirtualNamespacePath(base)) {
      return this.base.resolvePath(base, path);
    }
    return this.mapPath(this.base.resolvePath(this.mapPath(base), path));
  }

  getAllPaths(): string[] {
    const paths = this.base.getAllPaths();
    const alias = this.workspaceAlias();
    const root = this.workspaceRoot();
    const aliasPaths = !alias || alias === root
      ? paths
      : paths.flatMap((path) => {
          if (path === root) return [path, alias];
          if (path.startsWith(`${root}/`)) return [path, `${alias}${path.slice(root.length)}`];
          return [path];
        });
    const traceKernelBinPaths = (this.dynamicProc.readDir(TRACEKERNEL_BIN_PATH) ?? [])
      .map((entry) => `${TRACEKERNEL_BIN_PATH}/${entry.name}`);
    const skillPaths = this.dynamicProc.readDir(TRACEKERNEL_SKILLS_ROOT) === null
      ? []
      : this.dynamicVirtualPaths(TRACEKERNEL_SKILLS_ROOT);
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
    this.assertDynamicVirtualWritable(path, 'chmod');
    const metadataTarget = kernelMetadataTarget(path);
    if (metadataTarget.kind === 'ignored-device') return Promise.resolve();
    if (metadataTarget.kind === 'error') throwKernelMetadataTargetError(path, metadataTarget);
    const mappedPath = this.mapPath(path);
    return this.withMutationLocks([mappedPath], 'file-write', async () => {
      this.assertWritable(mappedPath, 'chmod');
      await this.base.chmod(mappedPath, mode);
      this.recordMutation([mappedPath], 'file-write');
    });
  }

  symlink(target: string, linkPath: string): Promise<void> {
    this.assertDynamicVirtualWritable(linkPath, 'symlink');
    const symlinkTarget = kernelSymlinkTarget(linkPath);
    if (symlinkTarget.kind === 'error') throwKernelMutationTargetError(linkPath, symlinkTarget);
    const mappedPath = this.mapPath(linkPath);
    return this.withMutationLocks([mappedPath], 'file-create', async () => {
      this.assertWritable(mappedPath, 'symlink');
      await this.base.symlink(target, mappedPath);
      this.recordMutation([mappedPath], 'file-create');
    });
  }

  link(existingPath: string, newPath: string): Promise<void> {
    this.assertDynamicVirtualWritable(existingPath, 'link');
    this.assertDynamicVirtualWritable(newPath, 'link');
    const linkTarget = kernelLinkTarget(existingPath, newPath);
    if (linkTarget.kind === 'error') throwKernelMutationTargetError(linkTarget.side === 'source' ? existingPath : newPath, linkTarget);
    const mappedNewPath = this.mapPath(newPath);
    const mappedExistingPath = this.mapPath(existingPath);
    return this.withMutationLocks([mappedExistingPath, mappedNewPath], 'copy', async () => {
      this.assertWritable(mappedNewPath, 'link');
      await this.base.link(mappedExistingPath, mappedNewPath);
      this.recordMutation([mappedExistingPath, mappedNewPath], 'copy');
    });
  }

  readlink(path: string): Promise<string> {
    if (this.dynamicProc.entryKind(this.mapPath(path)) !== null) {
      return Promise.reject(new Error(`Kernel virtual path is not a symbolic link: ${path}`));
    }
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind !== 'workspace') return Promise.reject(new Error(`Kernel virtual path is not a symbolic link: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'readlink', () => this.base.readlink(mappedPath));
  }

  lstat(path: string): Promise<Awaited<ReturnType<IFileSystem['lstat']>>> {
    const dynamicStat = this.dynamicProc.stat(this.mapPath(path));
    if (dynamicStat) return Promise.resolve(this.virtualStat(dynamicStat));
    const statTarget = kernelStatTarget(path, this.kernelInfo());
    if (statTarget.kind === 'stat') return Promise.resolve(this.virtualStat(statTarget.stat));
    if (statTarget.kind === 'error') return Promise.reject(new Error(`Kernel virtual path not found: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'stat', () => this.base.lstat(mappedPath));
  }

  realpath(path: string): Promise<string> {
    assertNoNul(path, 'Kernel path');
    if (this.dynamicProc.entryKind(this.mapPath(path)) !== null) return Promise.resolve(this.mapPath(path));
    if (isRuntimeKernelVirtualNamespacePath(path)) return Promise.resolve(path);
    return this.base.realpath(this.mapPath(path));
  }

  private dynamicVirtualPaths(path: string, seen = new Set<string>()): string[] {
    if (seen.has(path)) return [];
    seen.add(path);
    const kind = this.dynamicProc.entryKind(path);
    if (!kind) return [];
    if (kind === 'file') return [path];
    const entries = this.dynamicProc.readDir(path) ?? [];
    return [
      path,
      ...entries.flatMap((entry) => this.dynamicVirtualPaths(`${path}/${entry.name}`, seen)),
    ];
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'utimes');
    const metadataTarget = kernelMetadataTarget(path);
    if (metadataTarget.kind === 'ignored-device') return Promise.resolve();
    if (metadataTarget.kind === 'error') throwKernelMetadataTargetError(path, metadataTarget);
    const mappedPath = this.mapPath(path);
    return this.withMutationLocks([mappedPath], 'file-write', async () => {
      await this.base.utimes(mappedPath, atime, mtime);
      this.recordMutation([mappedPath], 'file-write');
    });
  }

  private mapPath(path: string): string {
    if (!path.startsWith('/')) return path;
    return mapWorkspaceAlias(this.workspaceRoot(), this.workspaceAlias(), path);
  }

  private async emitExistingFiles(path: string): Promise<void> {
    for (const filePath of await this.collectExistingFiles(path)) {
      await this.emitFileWrite(filePath);
    }
  }

  private async emitExistingDirectories(path: string): Promise<void> {
    for (const directoryPath of await this.collectExistingDirectories(path)) {
      this.emitDirectoryCreate(directoryPath);
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

  private tryReserveLiveFileChange(relativePath: string, contentBytes = 0): boolean {
    const context = this.commandGenerationContext();
    if (!context) return false;
    this.resetLiveFileChangeBudgetFor(context.pid);
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

  private async emitFileWrite(path: string): Promise<void> {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    const stat = await this.base.stat(path).catch(() => null);
    if (!stat?.isFile) return;
    const contentBytes = this.liveFileChangeContentBytes(stat);
    if (contentBytes === null || !this.tryReserveLiveFileChange(projectPath, contentBytes)) return;
    const bytes = await this.base.readFileBuffer(path);
    const text = decodeUtf8(bytes);
    this.onFileChange({
      path: projectPath,
      contents: text ?? base64FromBytes(bytes),
      ...(text === null ? { encoding: 'base64' as const } : {}),
    });
  }

  private emitFileDelete(path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserveLiveFileChange(projectPath)) return;
    this.onFileChange({ path: projectPath, deleted: true });
  }

  private emitDirectoryCreate(path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path) || path === this.workspaceRoot()) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserveLiveFileChange(projectPath)) return;
    this.onFileChange({ path: projectPath, directory: true });
  }

  private emitDirectoryDelete(path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path) || path === this.workspaceRoot()) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserveLiveFileChange(projectPath)) return;
    this.onFileChange({ path: projectPath, directory: true, deleted: true });
  }

  private readDeviceFile(device: '/dev' | RuntimeKernelDevicePath, options?: FsReadFileOptions): string {
    if (device === '/dev') throw new Error('Kernel device path is a directory: /dev');
    const inputDevice = runtimeDeviceInputSource(device);
    if (!inputDevice) throw new Error(`Kernel device is not readable: ${device}`);
    const content = this.readDevice(inputDevice);
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
    this.writeDevice(device, contentToText(content));
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
