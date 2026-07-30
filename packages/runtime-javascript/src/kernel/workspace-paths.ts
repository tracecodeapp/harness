import type {
  RuntimeFile,
  RuntimeKernelDeviceInfo,
  RuntimeKernelInfo,
  RuntimeProjectSnapshot,
} from "@tracecode/runtime-contracts";

import {
  TRACECODE_HARNESS_VERSION,
} from "@tracecode/runtime-contracts";

import {
  runtimeKernelAccessTarget,
  runtimeKernelCopyTarget,
  runtimeKernelDirectoryErrorCode,
  runtimeKernelDirectoryTarget,
  runtimeKernelFileCopyTarget,
  runtimeKernelFileReadTarget,
  runtimeKernelFileReadErrorCode,
  runtimeKernelLinkErrorCode,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirErrorCode,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataErrorCode,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationErrorCode,
  runtimeKernelMutationTarget,
  runtimeKernelOpenTarget,
  runtimeKernelReadTarget,
  runtimeKernelRenameErrorCode,
  runtimeKernelRenameTarget,
  runtimeKernelRemoveErrorCode,
  runtimeKernelRemoveTarget,
  runtimeKernelStatTarget,
  runtimeKernelSymlinkErrorCode,
  runtimeKernelSymlinkTarget,
  runtimeKernelTruncateErrorCode,
  runtimeKernelTruncateTarget,
  runtimeKernelWriteErrorCode,
  runtimeKernelWriteTarget,
  readPublicRuntimeProcFile as readPublicProcFile,
  type RuntimeKernelDirectoryEntry,
} from "@tracecode/runtime-contracts";

import {
  JavaScriptProjectCommandRequest,
} from "../browser/contracts";

import {
  textEncoder,
} from "../internal/encoding";

import {
  dirname,
  normalizeProjectPath,
} from "./path-normalization";

import {
  processArgvForRequest,
} from "./process-control";

export interface BrowserProcSnapshot {
  readonly files: ReadonlyMap<string, string>;
  readonly directories: ReadonlyMap<string, readonly RuntimeKernelDirectoryEntry[]>;
}

export interface WorkspacePathContext {
  root: string;
  alias?: string;
}

export function workspacePathInputToString(path: unknown): string {
  if (path instanceof URL) {
    if (path.protocol !== 'file:') {
      throw new TypeError('The URL must be of scheme file');
    }
    return decodeURIComponent(path.pathname);
  }
  return String(path);
}

export function runtimeWriteTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelWriteTarget> | null {
  if (typeof path === 'number') return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'proc-read-only', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelWriteTarget(raw, devices);
}

export function runtimeMutationTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelMutationTarget> | null {
  if (typeof path === 'number') return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'proc-read-only', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelMutationTarget(raw, devices);
}

export function runtimeMetadataTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelMetadataTarget> | null {
  if (typeof path === 'number') return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'proc-read-only', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelMetadataTarget(raw, devices);
}

export function runtimeAccessTarget(
  path: unknown,
  mode: number,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelAccessTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    return (mode & 2) !== 0
      ? { kind: 'denied', reason: 'permission-denied', path: procPath }
      : { kind: 'allowed', path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) {
    return (mode & 2) !== 0
      ? { kind: 'denied', reason: 'permission-denied', path: readonlyPath }
      : { kind: 'denied', reason: 'not-found', path: readonlyPath };
  }
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelAccessTarget(raw, {
    read: (mode & 4) !== 0,
    write: (mode & 2) !== 0,
    execute: (mode & 1) !== 0,
  }, devices);
}

export function runtimeOpenTarget(
  path: unknown,
  request: Parameters<typeof runtimeKernelOpenTarget>[1],
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelOpenTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    if (procKind === 'directory') return { kind: 'error', reason: 'is-directory', path: procPath };
    if (request?.writable || request?.create || request?.truncate || request?.exclusive) {
      return { kind: 'error', reason: 'read-only', path: procPath };
    }
    return { kind: 'proc-file', path: procPath, readable: true, writable: false };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) {
    return request?.writable || request?.create || request?.truncate || request?.exclusive
      ? { kind: 'error', reason: 'read-only', path: readonlyPath }
      : { kind: 'error', reason: 'not-found', path: readonlyPath };
  }
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelOpenTarget(raw, request, devices);
}

export function runtimeReadTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelReadTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    return procKind === 'file'
      ? { kind: 'proc-file', path: procPath }
      : { kind: 'proc-directory', path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'not-found', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelReadTarget(raw, devices);
}

export function runtimeFileReadTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelFileReadTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    return procKind === 'file'
      ? { kind: 'proc-file', path: procPath }
      : { kind: 'error', reason: 'is-directory', path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'not-found', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelFileReadTarget(raw, devices);
}

export function runtimeCopyTarget(
  source: unknown,
  destination: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelCopyTarget> | null {
  if (typeof source === 'number' || typeof destination === 'number') return null;
  const sourceKind = browserProcEntryKind(procSnapshot, source);
  const destinationReadonlyPath = browserReadonlyKernelNamespacePath(destination);
  if (sourceKind === 'file' || destinationReadonlyPath) return { kind: 'file-copy' };
  if (sourceKind === 'directory') return { kind: 'error', reason: 'source-directory', path: normalizeBrowserProcPath(source) ?? String(source) };
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelCopyTarget(sourceRaw, destinationRaw, devices);
}

export function runtimeFileCopyTarget(
  source: unknown,
  destination: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelFileCopyTarget> | null {
  if (typeof source === 'number' || typeof destination === 'number') return null;
  const destinationReadonlyPath = browserReadonlyKernelNamespacePath(destination);
  if (destinationReadonlyPath) {
    return { kind: 'error', side: 'destination', reason: 'proc-read-only', path: destinationReadonlyPath };
  }
  const sourceKind = browserProcEntryKind(procSnapshot, source);
  if (sourceKind) {
    const sourcePath = normalizeBrowserProcPath(source) ?? String(source);
    if (sourceKind === 'directory') {
      return { kind: 'error', side: 'source', reason: 'is-directory', path: sourcePath };
    }
    const writeTarget = runtimeWriteTarget(destination, devices);
    if (writeTarget?.kind === 'error') {
      return { kind: 'error', side: 'destination', reason: writeTarget.reason, path: writeTarget.path };
    }
    if (writeTarget?.kind === 'device') {
      return {
        kind: 'device-destination',
        device: writeTarget.device,
        outputDevice: writeTarget.outputDevice,
        source: { kind: 'proc-file', path: sourcePath },
      };
    }
    return { kind: 'virtual-source', source: { kind: 'proc-file', path: sourcePath } };
  }
  const sourceReadonlyPath = browserReadonlyKernelNamespacePath(source);
  if (sourceReadonlyPath) {
    return { kind: 'error', side: 'source', reason: 'not-found', path: sourceReadonlyPath };
  }
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelFileCopyTarget(sourceRaw, destinationRaw, devices);
}

export function runtimeLinkTarget(
  source: unknown,
  destination: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelLinkTarget> | null {
  if (typeof source === 'number' || typeof destination === 'number') return null;
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelLinkTarget(sourceRaw, destinationRaw, devices);
}

export function runtimeRenameTarget(
  source: unknown,
  destination: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelRenameTarget> | null {
  if (typeof source === 'number' || typeof destination === 'number') return null;
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelRenameTarget(sourceRaw, destinationRaw, devices);
}

export function runtimeSymlinkTarget(
  linkPath: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelSymlinkTarget> | null {
  if (typeof linkPath === 'number') return null;
  const raw = workspacePathInputToString(linkPath).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelSymlinkTarget(raw, devices);
}

export function runtimeRemoveTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelRemoveTarget> | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelRemoveTarget(raw, devices);
}

export function runtimeMkdirTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelMkdirTarget> | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelMkdirTarget(raw, devices);
}

export function runtimeTruncateTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelTruncateTarget> | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelTruncateTarget(raw, devices);
}

export function runtimeDirectoryTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelDirectoryTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    return procKind === 'directory'
      ? { kind: 'directory', path: procPath, entries: [...(procSnapshot?.directories.get(procPath) ?? [])] }
      : { kind: 'error', reason: 'not-directory', path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'not-found', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelDirectoryTarget(raw, devices);
}

export function runtimeStatTarget(
  path: unknown,
  info: RuntimeKernelInfo,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelStatTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    const contents = procKind === 'file' ? browserProcFileContents(procSnapshot, procPath, info) : '';
    return {
      kind: 'stat',
      path: procPath,
      stat: {
        isFile: procKind === 'file',
        isDirectory: procKind === 'directory',
        isCharacterDevice: false,
        mode: procKind === 'directory' ? 0o555 : 0o444,
        size: textEncoder.encode(contents).byteLength,
      },
    };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'not-found', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelStatTarget(raw, info, devices);
}

export function throwRuntimeWriteTargetError(
  target: Extract<ReturnType<typeof runtimeKernelWriteTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelWriteErrorCode(target.reason) });
}

export function throwRuntimeMutationTargetError(
  target: Extract<ReturnType<typeof runtimeKernelMutationTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelMutationErrorCode(target.reason) });
}

export function throwRuntimeMetadataTargetError(
  target: Extract<ReturnType<typeof runtimeKernelMetadataTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelMetadataErrorCode(target.reason) });
}

export function throwRuntimeReadTargetError(
  target: Extract<ReturnType<typeof runtimeKernelFileReadTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelFileReadErrorCode(target.reason) });
}

export function throwRuntimeLinkTargetError(
  target: Extract<ReturnType<typeof runtimeKernelLinkTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelLinkErrorCode(target.reason) });
}

export function throwRuntimeRenameTargetError(
  target: Extract<ReturnType<typeof runtimeKernelRenameTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelRenameErrorCode(target.reason) });
}

export function throwRuntimeSymlinkTargetError(
  target: Extract<ReturnType<typeof runtimeKernelSymlinkTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelSymlinkErrorCode(target.reason) });
}

export function throwRuntimeRemoveTargetError(
  target: Extract<ReturnType<typeof runtimeKernelRemoveTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelRemoveErrorCode(target.reason) });
}

export function throwRuntimeMkdirTargetError(
  target: Extract<ReturnType<typeof runtimeKernelMkdirTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelMkdirErrorCode(target.reason) });
}

export function throwRuntimeTruncateTargetError(
  target: Extract<ReturnType<typeof runtimeKernelTruncateTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelTruncateErrorCode(target.reason) });
}

export function throwRuntimeDirectoryTargetError(
  target: Extract<ReturnType<typeof runtimeKernelDirectoryTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelDirectoryErrorCode(target.reason) });
}

export function normalizeAbsoluteWorkspaceRoot(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}

export function createWorkspacePathContext(project: RuntimeProjectSnapshot): WorkspacePathContext {
  return {
    root: normalizeAbsoluteWorkspaceRoot(project.workspaceRoot ?? project.cwd ?? '/workspace'),
    ...(project.workspaceAlias ? { alias: normalizeAbsoluteWorkspaceRoot(project.workspaceAlias) } : {}),
  };
}

export function fallbackKernelInfo(project: RuntimeProjectSnapshot, workspace: WorkspacePathContext): RuntimeKernelInfo {
  const root = workspace.root;
  const parts = root.split('/').filter(Boolean);
  const workspaceName = parts.at(-1) ?? 'workspace';
  const username = parts.length >= 2 && parts[0] === 'home' ? parts[1] ?? 'user' : 'user';
  const home = parts.length >= 2 && parts[0] === 'home' ? `/${parts.slice(0, 2).join('/')}` : dirname(root) || root;
  const startedAt = new Date(0).toISOString();
  return {
    name: 'tracekernel',
    version: TRACECODE_HARNESS_VERSION,
    user: {
      id: username,
      username,
      home,
    },
    host: {
      hostname: 'tracevm',
      osName: 'tracekernel',
    },
    workspace: {
      id: `${workspaceName}-${startedAt.replace(/[:.]/g, '-')}`,
      name: workspaceName,
      root,
      startedAt,
    },
    home,
    cwd: project.cwd ?? root,
    workspaceRoot: root,
    ...(workspace.alias ? { workspaceAlias: workspace.alias } : {}),
  };
}

export function normalizeBrowserProcPath(path: unknown): string | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return raw === '/proc' ||
    raw.startsWith('/proc/') ||
    raw === '/skills' ||
    raw.startsWith('/skills/') ||
    raw === '/etc' ||
    raw.startsWith('/etc/')
    ? raw
    : null;
}

export function browserReadonlyKernelNamespacePath(path: unknown): string | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return raw === '/skills' ||
    raw.startsWith('/skills/') ||
    raw === '/etc' ||
    raw.startsWith('/etc/')
    ? raw
    : null;
}

export function createBrowserProcSnapshot(
  kernelFiles?: readonly RuntimeFile[],
  request?: JavaScriptProjectCommandRequest
): BrowserProcSnapshot {
  const files = new Map<string, string>();
  const directoryEntries = new Map<string, Map<string, RuntimeKernelDirectoryEntry>>();
  const ensureDirectory = (path: string): void => {
    if (!directoryEntries.has(path)) directoryEntries.set(path, new Map());
    if (path === '/') return;
    const parent = dirname(path);
    if (parent && parent !== path) {
      ensureDirectory(parent);
      const name = path.slice(parent === '/' ? 1 : parent.length + 1);
      directoryEntries.get(parent)?.set(name, { name, kind: 'directory' });
    }
  };
  const addFile = (path: string, contents: string): void => {
    const normalized = normalizeBrowserProcPath(path);
    if (!normalized) return;
    files.set(normalized, contents);
    const parent = dirname(normalized);
    ensureDirectory(parent);
    const name = normalized.slice(parent === '/' ? 1 : parent.length + 1);
    directoryEntries.get(parent)?.set(name, { name, kind: 'file' });
  };
  ensureDirectory('/skills');
  for (const file of kernelFiles ?? []) addFile(file.path, file.contents);
  if (request?.process) {
    const argv = processArgvForRequest(request);
    const command = argv.join(' ');
    const status = [
      `Name:\t${(request.scriptPath || 'node').split('/').at(-1) || 'node'}`,
      'State:\tR (running)',
      `Pid:\t${request.process.pid}`,
      `PPid:\t${request.process.ppid}`,
      `PGid:\t${request.process.pgid}`,
      `Sid:\t${request.process.sid}`,
      'FDSize:\t3',
      'Uid:\t1000\t1000\t1000\t1000',
      'Gid:\t1000\t1000\t1000\t1000',
      `Command:\t${command}`,
      '',
    ].join('\n');
    const cmdline = `${argv.join('\0')}\0`;
    for (const root of ['/proc/self', `/proc/${request.process.pid}`]) {
      addFile(`${root}/status`, status);
      addFile(`${root}/cmdline`, cmdline);
    }
  }
  const directories = new Map<string, readonly RuntimeKernelDirectoryEntry[]>();
  for (const [path, entries] of directoryEntries) {
    if (path === '/' || !(
      path === '/proc' ||
      path.startsWith('/proc/') ||
      path === '/skills' ||
      path.startsWith('/skills/') ||
      path === '/etc' ||
      path.startsWith('/etc/')
    )) continue;
    directories.set(path, [...entries.values()].sort((left, right) => left.name.localeCompare(right.name)));
  }
  return { files, directories };
}

export function browserProcEntryKind(snapshot: BrowserProcSnapshot | undefined, path: unknown): 'file' | 'directory' | null {
  const normalized = normalizeBrowserProcPath(path);
  if (!normalized || !snapshot) return null;
  if (snapshot.files.has(normalized)) return 'file';
  if (snapshot.directories.has(normalized)) return 'directory';
  return null;
}

export function browserProcFileContents(snapshot: BrowserProcSnapshot | undefined, path: string, info: RuntimeKernelInfo): string {
  const contents = snapshot?.files.get(path);
  return contents !== undefined ? contents : readPublicProcFile(path, info);
}

export function workspaceRelativeFromAbsolutePath(rawPath: string, workspace: WorkspacePathContext): string | null {
  const raw = normalizeAbsoluteWorkspaceRoot(rawPath);
  if (raw === workspace.root) return '';
  if (raw.startsWith(`${workspace.root}/`)) return raw.slice(workspace.root.length + 1);
  if (workspace.alias && raw === workspace.alias) return '';
  if (workspace.alias && raw.startsWith(`${workspace.alias}/`)) return raw.slice(workspace.alias.length + 1);
  return null;
}

export function normalizeWorkspaceEntryPath(
  path: unknown,
  basePath = '',
  allowRoot = false,
  workspace: WorkspacePathContext = { root: '/workspace' }
): string {
  const rawInput = workspacePathInputToString(path);
  const raw = rawInput.replace(/\\/g, '/');
  const workspaceRelative = raw.startsWith('/') ? workspaceRelativeFromAbsolutePath(raw, workspace) : null;
  const withBase = workspaceRelative !== null
    ? workspaceRelative
    : raw.startsWith('/')
      ? raw
      : basePath
        ? `${basePath}/${raw}`
        : raw;
  const cleaned = withBase
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (cleaned.startsWith('/') || /^[A-Za-z]:\//.test(cleaned)) {
    throw new Error(`Path must be inside workspace: ${rawInput}`);
  }

  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error(`Path must not escape workspace: ${rawInput}`);
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  if (parts.length === 0) {
    if (allowRoot) return '';
    throw new Error(`Path must point to a file: ${rawInput}`);
  }
  return parts.join('/');
}

export function assertSafeWorkspaceFilePath(
  path: unknown,
  basePath = '',
  workspace: WorkspacePathContext = { root: '/workspace' }
): string {
  return normalizeWorkspaceEntryPath(path, basePath, false, workspace);
}
