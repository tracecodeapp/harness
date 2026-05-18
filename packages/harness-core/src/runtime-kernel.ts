import type { RuntimeKernelDevicePath, RuntimeKernelInfo } from './runtime-project';

export type RuntimeKernelProcEntryKind = 'file' | 'directory';
export type RuntimeKernelDeviceEntryKind = 'file' | 'directory';
export interface RuntimeKernelVirtualStat {
  isFile: boolean;
  isDirectory: boolean;
  isCharacterDevice: boolean;
  mode: number;
  size: number;
}
export type RuntimeKernelWriteTarget =
  | { kind: 'workspace' }
  | { kind: 'device'; device: RuntimeKernelDevicePath; outputDevice: RuntimeKernelDevicePath }
  | { kind: 'error'; reason: 'proc-read-only' | 'device-directory' | 'device-read-only' | 'device-not-found'; path: string };
export type RuntimeKernelMutationTarget =
  | { kind: 'workspace' }
  | { kind: 'error'; reason: 'proc-read-only' | 'device-read-only' | 'device-not-found'; path: string };
export type RuntimeKernelMetadataTarget =
  | { kind: 'workspace' }
  | { kind: 'ignored-device'; path: '/dev' | RuntimeKernelDevicePath }
  | { kind: 'error'; reason: 'proc-read-only' | 'device-not-found'; path: string };
export interface RuntimeKernelAccessRequest {
  read?: boolean;
  write?: boolean;
  execute?: boolean;
}
export type RuntimeKernelAccessTarget =
  | { kind: 'workspace' }
  | { kind: 'allowed'; path: string }
  | { kind: 'denied'; reason: 'not-found' | 'permission-denied'; path: string };
export type RuntimeKernelReadTarget =
  | { kind: 'workspace' }
  | { kind: 'proc-file'; path: string }
  | { kind: 'proc-directory'; path: string }
  | { kind: 'device-file'; path: RuntimeKernelDevicePath }
  | { kind: 'device-directory'; path: '/dev' }
  | { kind: 'error'; reason: 'not-found'; path: string };
export type RuntimeKernelFileReadTarget =
  | { kind: 'workspace' }
  | { kind: 'proc-file'; path: string }
  | { kind: 'device-file'; path: RuntimeKernelDevicePath }
  | { kind: 'error'; reason: 'is-directory' | 'not-found'; path: string };
export interface RuntimeKernelDirectoryEntry {
  name: string;
  kind: RuntimeKernelProcEntryKind | RuntimeKernelDeviceEntryKind;
}
export type RuntimeKernelDirectoryTarget =
  | { kind: 'workspace' }
  | { kind: 'directory'; path: string; entries: RuntimeKernelDirectoryEntry[] }
  | { kind: 'error'; reason: 'not-directory' | 'not-found'; path: string };
export type RuntimeKernelCopyTarget =
  | { kind: 'workspace' }
  | { kind: 'file-copy' }
  | { kind: 'error'; reason: 'source-directory' | 'source-not-found'; path: string };
export type RuntimeKernelErrorCode = 'EBADF' | 'EISDIR' | 'ENOENT' | 'ENOTDIR' | 'EROFS';
export type RuntimeKernelVirtualPath =
  | { kind: 'proc'; path: string }
  | { kind: 'device'; path: RuntimeKernelDevicePath }
  | { kind: 'device-directory'; path: '/dev' }
  | { kind: 'device-namespace'; path: string };
export const RUNTIME_KERNEL_DEVICE_ENTRIES = ['stderr', 'stdin', 'stdout', 'tty'] as const;

function normalizeRuntimeAbsolutePath(path: string): string | null {
  const raw = path.replace(/\\/g, '/');
  if (!raw.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`.replace(/\/+$/, '') || '/';
}

export function normalizeRuntimeProcPath(path: string): string | null {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null) return null;
  return normalized === '/proc' || normalized.startsWith('/proc/') ? normalized : null;
}

export function isRuntimeProcNamespacePath(path: string): boolean {
  return normalizeRuntimeProcPath(path) !== null;
}

export function normalizeRuntimeDevicePath(path: string): '/dev' | RuntimeKernelDevicePath | null {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null) return null;
  if (normalized === '/dev') return '/dev';
  if (
    normalized === '/dev/stdin' ||
    normalized === '/dev/stdout' ||
    normalized === '/dev/stderr' ||
    normalized === '/dev/tty'
  ) {
    return normalized;
  }
  return null;
}

export function isRuntimeDeviceNamespacePath(path: string): boolean {
  const normalized = normalizeRuntimeAbsolutePath(path);
  return normalized === '/dev' || normalized?.startsWith('/dev/') === true;
}

export function classifyRuntimeKernelVirtualPath(path: string): RuntimeKernelVirtualPath | null {
  const procPath = normalizeRuntimeProcPath(path);
  if (procPath !== null) return { kind: 'proc', path: procPath };
  const devicePath = normalizeRuntimeDevicePath(path);
  if (devicePath === '/dev') return { kind: 'device-directory', path: devicePath };
  if (devicePath !== null) return { kind: 'device', path: devicePath };
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized?.startsWith('/dev/') === true) return { kind: 'device-namespace', path: normalized };
  return null;
}

export function runtimeProcCanMutate(path: string): boolean {
  return !isRuntimeProcNamespacePath(path);
}

export function runtimeDeviceCanRead(device: RuntimeKernelDevicePath): boolean {
  return device === '/dev/stdin' || device === '/dev/tty';
}

export function runtimeDeviceCanWrite(device: RuntimeKernelDevicePath): boolean {
  return device === '/dev/stdout' || device === '/dev/stderr' || device === '/dev/tty';
}

export function runtimeDeviceInputSource(device: RuntimeKernelDevicePath): RuntimeKernelDevicePath | null {
  return runtimeDeviceCanRead(device) ? '/dev/stdin' : null;
}

export function runtimeDeviceOutputTarget(device: RuntimeKernelDevicePath): RuntimeKernelDevicePath | null {
  if (!runtimeDeviceCanWrite(device)) return null;
  return device === '/dev/tty' ? '/dev/stdout' : device;
}

export function runtimeDeviceDirEntries(path: '/dev' | RuntimeKernelDevicePath): string[] | null {
  return path === '/dev' ? [...RUNTIME_KERNEL_DEVICE_ENTRIES] : null;
}

export function runtimeDeviceEntryKind(path: '/dev' | RuntimeKernelDevicePath): RuntimeKernelDeviceEntryKind {
  return path === '/dev' ? 'directory' : 'file';
}

export function runtimeDeviceStat(path: '/dev' | RuntimeKernelDevicePath): RuntimeKernelVirtualStat {
  const kind = runtimeDeviceEntryKind(path);
  const isDirectory = kind === 'directory';
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: !isDirectory,
    mode: isDirectory ? 0o755 : 0o666,
    size: 0,
  };
}

export function runtimeKernelWriteTarget(path: string): RuntimeKernelWriteTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-directory') {
    return { kind: 'error', reason: 'device-directory', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
  }
  const outputDevice = runtimeDeviceOutputTarget(virtualPath.path);
  if (!outputDevice) {
    return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
  }
  return { kind: 'device', device: virtualPath.path, outputDevice };
}

export function runtimeKernelWriteErrorCode(
  reason: Extract<RuntimeKernelWriteTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  if (reason === 'proc-read-only') return 'EROFS';
  if (reason === 'device-directory') return 'EISDIR';
  if (reason === 'device-read-only') return 'EBADF';
  return 'ENOENT';
}

export function runtimeKernelMutationTarget(path: string): RuntimeKernelMutationTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
  }
  return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
}

export function runtimeKernelMutationErrorCode(
  reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'device-not-found' ? 'ENOENT' : 'EROFS';
}

export function runtimeKernelMetadataTarget(path: string): RuntimeKernelMetadataTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
  }
  return { kind: 'ignored-device', path: virtualPath.path };
}

export function runtimeKernelMetadataErrorCode(
  reason: Extract<RuntimeKernelMetadataTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'proc-read-only' ? 'EROFS' : 'ENOENT';
}

export function runtimeKernelAccessTarget(path: string, request: RuntimeKernelAccessRequest = {}): RuntimeKernelAccessTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-namespace') {
    return { kind: 'denied', reason: 'not-found', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-directory') {
    return request.write || request.execute
      ? { kind: 'denied', reason: 'permission-denied', path: virtualPath.path }
      : { kind: 'allowed', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device') {
    const readable = runtimeDeviceCanRead(virtualPath.path);
    const writable = runtimeDeviceCanWrite(virtualPath.path);
    return (request.read && !readable) || (request.write && !writable) || request.execute
      ? { kind: 'denied', reason: 'permission-denied', path: virtualPath.path }
      : { kind: 'allowed', path: virtualPath.path };
  }
  if (!runtimeProcEntryKind(virtualPath.path)) {
    return { kind: 'denied', reason: 'not-found', path: virtualPath.path };
  }
  return request.write || request.execute
    ? { kind: 'denied', reason: 'permission-denied', path: virtualPath.path }
    : { kind: 'allowed', path: virtualPath.path };
}

export function runtimeKernelReadTarget(path: string): RuntimeKernelReadTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-namespace') {
    return { kind: 'error', reason: 'not-found', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-directory') return virtualPath;
  if (virtualPath.kind === 'device') return { kind: 'device-file', path: virtualPath.path };
  const kind = runtimeProcEntryKind(virtualPath.path);
  if (kind === 'file') return { kind: 'proc-file', path: virtualPath.path };
  if (kind === 'directory') return { kind: 'proc-directory', path: virtualPath.path };
  return { kind: 'error', reason: 'not-found', path: virtualPath.path };
}

export function runtimeKernelFileReadTarget(path: string): RuntimeKernelFileReadTarget {
  const readTarget = runtimeKernelReadTarget(path);
  if (readTarget.kind === 'device-file' || readTarget.kind === 'proc-file' || readTarget.kind === 'workspace') {
    return readTarget;
  }
  if (readTarget.kind === 'device-directory' || readTarget.kind === 'proc-directory') {
    return { kind: 'error', reason: 'is-directory', path: readTarget.path };
  }
  return readTarget;
}

export function runtimeKernelFileReadErrorCode(
  reason: Extract<RuntimeKernelFileReadTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'is-directory' ? 'EISDIR' : 'ENOENT';
}

export function runtimeKernelDirectoryTarget(path: string): RuntimeKernelDirectoryTarget {
  const readTarget = runtimeKernelReadTarget(path);
  if (readTarget.kind === 'workspace') return readTarget;
  if (readTarget.kind === 'device-directory') {
    return {
      kind: 'directory',
      path: readTarget.path,
      entries: (runtimeDeviceDirEntries(readTarget.path) ?? []).map((name) => ({
        name,
        kind: runtimeDeviceEntryKind(`/dev/${name}` as RuntimeKernelDevicePath),
      })),
    };
  }
  if (readTarget.kind === 'proc-directory') {
    return {
      kind: 'directory',
      path: readTarget.path,
      entries: (runtimeProcDirEntries(readTarget.path) ?? []).map((name) => ({
        name,
        kind: runtimeProcEntryKind(`${readTarget.path}/${name}`) ?? 'file',
      })),
    };
  }
  if (readTarget.kind === 'device-file' || readTarget.kind === 'proc-file') {
    return { kind: 'error', reason: 'not-directory', path: readTarget.path };
  }
  return readTarget;
}

export function runtimeKernelDirectoryErrorCode(
  reason: Extract<RuntimeKernelDirectoryTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'not-directory' ? 'ENOTDIR' : 'ENOENT';
}

export function runtimeKernelCopyTarget(source: string, destination: string): RuntimeKernelCopyTarget {
  const sourceTarget = runtimeKernelReadTarget(source);
  const writeTarget = runtimeKernelWriteTarget(destination);
  if (
    sourceTarget.kind === 'device-file' ||
    sourceTarget.kind === 'proc-file' ||
    writeTarget.kind === 'device' ||
    writeTarget.kind === 'error'
  ) {
    return { kind: 'file-copy' };
  }
  if (sourceTarget.kind === 'device-directory' || sourceTarget.kind === 'proc-directory') {
    return { kind: 'error', reason: 'source-directory', path: sourceTarget.path };
  }
  if (sourceTarget.kind === 'error') {
    return { kind: 'error', reason: 'source-not-found', path: sourceTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeProcInfoJson(info: RuntimeKernelInfo): string {
  return `${JSON.stringify(info, null, 2)}\n`;
}

export function runtimeMountInfoField(value: string): string {
  return value.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011').replace(/\n/g, '\\012');
}

export function runtimeProcMountInfo(info: RuntimeKernelInfo): string {
  const workspaceRoot = runtimeMountInfoField(info.workspaceRoot);
  const workspaceName = runtimeMountInfoField(info.workspace.name);
  const aliasLine = info.workspaceAlias
    ? `27 24 0:1 / ${runtimeMountInfoField(info.workspaceAlias)} rw,relatime alias=${workspaceRoot} - tracefs tracekernel:workspace rw,name=${workspaceName}`
    : null;
  return [
    `24 0 0:1 / ${workspaceRoot} rw,relatime - tracefs tracekernel:workspace rw,name=${workspaceName}`,
    aliasLine,
    '25 0 0:2 / /dev rw,nosuid - tracefs tracekernel:dev rw,mode=755',
    '26 0 0:3 / /proc rw,nosuid,nodev,noexec - tracefs tracekernel:proc rw',
  ].filter((line): line is string => Boolean(line)).join('\n') + '\n';
}

export function runtimeProcDirEntries(path: string): string[] | null {
  if (path === '/proc') return ['kernel', 'self'];
  if (path === '/proc/kernel') return ['info'];
  if (path === '/proc/self') return ['mountinfo'];
  return null;
}

export function runtimeProcEntryKind(path: string): RuntimeKernelProcEntryKind | null {
  if (runtimeProcDirEntries(path)) return 'directory';
  if (path === '/proc/kernel/info' || path === '/proc/self/mountinfo') return 'file';
  return null;
}

export function readRuntimeProcFile(path: string, info: RuntimeKernelInfo): string {
  if (path === '/proc/kernel/info') return runtimeProcInfoJson(info);
  if (path === '/proc/self/mountinfo') return runtimeProcMountInfo(info);
  if (runtimeProcDirEntries(path)) {
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: 'EISDIR' });
  }
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

export function runtimeProcStat(path: string, info: RuntimeKernelInfo): RuntimeKernelVirtualStat | null {
  const kind = runtimeProcEntryKind(path);
  if (!kind) return null;
  const isDirectory = kind === 'directory';
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: false,
    mode: isDirectory ? 0o555 : 0o444,
    size: isDirectory ? 0 : new TextEncoder().encode(readRuntimeProcFile(path, info)).byteLength,
  };
}
