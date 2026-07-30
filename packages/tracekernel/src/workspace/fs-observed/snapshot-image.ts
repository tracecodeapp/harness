import {
  publicRuntimeKernelInfo,
  publicRuntimeKernelVirtualFiles,
  runtimeKernelVirtualDevices,
  runtimeKernelVirtualFiles,
} from '@tracecode/runtime-core';
import type {
  RuntimeCommandResult,
  RuntimeDirectory,
  RuntimeDirectoryChange,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeKernelInfo,
  RuntimeProjectSnapshot,
  RuntimeSymlink,
} from '@tracecode/runtime-core';
import type {
  CommandContext,
  IFileSystem,
} from 'just-bash/browser';
import { TRACEKERNEL_SKILLS_ROOT } from '../constants';
import {
  base64FromBytes,
  bytesFromBase64,
  decodeUtf8,
} from '../file-content';
import {
  dirname,
  isWithinWorkspace,
  normalizeRuntimeProjectPath,
  toProjectDirectoryPath,
  toProjectPath,
  toWorkspaceEntryPath,
  toWorkspacePath,
} from '../paths';
import type { RuntimeFileSystemMutationKind } from '../locks';

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

export interface RuntimeFinalDiffPreparedChange {
  change: RuntimeFileChange;
  absolutePath: string;
  kind: RuntimeFileSystemMutationKind;
  apply(base: IFileSystem): Promise<void>;
}

export function prepareFinalDiffChange(workspaceRoot: string, file: RuntimeFileChange): RuntimeFinalDiffPreparedChange {
  const absolutePath = isRuntimeDirectoryChange(file)
    ? toWorkspaceEntryPath(workspaceRoot, file.path)
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

export async function applyRuntimeEntryMetadata(
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
