import type { RuntimeFile, RuntimeKernelDeviceInfo, RuntimeKernelDevicePath, RuntimeKernelInfo } from './runtime-project';

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
export interface RuntimeKernelOpenRequest {
  readable?: boolean;
  writable?: boolean;
  create?: boolean;
  truncate?: boolean;
  exclusive?: boolean;
}
export type RuntimeKernelAccessTarget =
  | { kind: 'workspace' }
  | { kind: 'allowed'; path: string }
  | { kind: 'denied'; reason: 'not-found' | 'permission-denied'; path: string };
export type RuntimeKernelOpenTarget =
  | { kind: 'workspace' }
  | { kind: 'device'; device: RuntimeKernelDevicePath; readable: boolean; writable: boolean }
  | { kind: 'proc-file'; path: string; readable: true; writable: false }
  | { kind: 'error'; reason: 'not-found' | 'is-directory' | 'read-only'; path: string };
export type RuntimeKernelReadTarget =
  | { kind: 'workspace' }
  | { kind: 'proc-file'; path: string }
  | { kind: 'proc-directory'; path: string }
  | { kind: 'device-file'; path: RuntimeKernelDevicePath }
  | { kind: 'device-directory'; path: '/dev' }
  | { kind: 'error'; reason: 'not-found' | 'permission-denied'; path: string };
export type RuntimeKernelFileReadTarget =
  | { kind: 'workspace' }
  | { kind: 'proc-file'; path: string }
  | { kind: 'device-file'; path: RuntimeKernelDevicePath }
  | { kind: 'error'; reason: 'is-directory' | 'not-found' | 'permission-denied'; path: string };
export type RuntimeKernelStatTarget =
  | { kind: 'workspace' }
  | { kind: 'stat'; path: string; stat: RuntimeKernelVirtualStat }
  | { kind: 'error'; reason: 'not-found'; path: string };
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
export type RuntimeKernelFileCopyTarget =
  | { kind: 'workspace' }
  | { kind: 'virtual-source'; source: Extract<RuntimeKernelFileReadTarget, { kind: 'device-file' | 'proc-file' }> }
  | { kind: 'device-destination'; outputDevice: RuntimeKernelDevicePath; source: RuntimeKernelFileReadTarget }
  | {
      kind: 'error';
      side: 'source';
      reason: Extract<RuntimeKernelFileReadTarget, { kind: 'error' }>['reason'];
      path: string;
    }
  | {
      kind: 'error';
      side: 'destination';
      reason: Extract<RuntimeKernelWriteTarget, { kind: 'error' }>['reason'];
      path: string;
    };
export type RuntimeKernelLinkTarget =
  | { kind: 'workspace' }
  | {
      kind: 'error';
      side: 'source' | 'destination';
      reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason'];
      path: string;
    };
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

export function normalizeRuntimeKernelDeviceReference(path: string): RuntimeKernelDevicePath | null {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null || normalized === '/dev' || !normalized.startsWith('/dev/')) return null;
  const deviceName = normalized.slice('/dev/'.length);
  return deviceName.length > 0 && !deviceName.includes('/') ? normalized as RuntimeKernelDevicePath : null;
}

export function isRuntimeDeviceNamespacePath(path: string): boolean {
  const normalized = normalizeRuntimeAbsolutePath(path);
  return normalized === '/dev' || normalized?.startsWith('/dev/') === true;
}

export function isRuntimeKernelVirtualNamespacePath(path: string): boolean {
  return isRuntimeProcNamespacePath(path) || isRuntimeDeviceNamespacePath(path);
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

export function runtimeKernelDeviceInfo(
  devices: readonly RuntimeKernelDeviceInfo[] | undefined,
  device: RuntimeKernelDevicePath
): RuntimeKernelDeviceInfo | null {
  const entries = devices ?? runtimeKernelVirtualDevices();
  return entries.find((entry) => normalizeRuntimeKernelDeviceReference(entry.path) === device) ?? null;
}

function normalizeDeviceReference(value: RuntimeKernelDevicePath | undefined): RuntimeKernelDevicePath | null {
  if (!value) return null;
  return normalizeRuntimeKernelDeviceReference(value);
}

export function runtimeKernelDeviceInputSource(
  devices: readonly RuntimeKernelDeviceInfo[] | undefined,
  device: RuntimeKernelDevicePath
): RuntimeKernelDevicePath | null {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.readable) return null;
  return normalizeDeviceReference(info.inputDevice) ?? device;
}

export function runtimeKernelDeviceOutputTarget(
  devices: readonly RuntimeKernelDeviceInfo[] | undefined,
  device: RuntimeKernelDevicePath
): RuntimeKernelDevicePath | null {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.writable) return null;
  return normalizeDeviceReference(info.outputDevice) ?? device;
}

export function runtimeDeviceDirEntries(
  path: '/dev' | RuntimeKernelDevicePath,
  devices?: readonly RuntimeKernelDeviceInfo[]
): string[] | null {
  if (path !== '/dev') return null;
  const entries = devices ?? runtimeKernelVirtualDevices();
  return Array.from(new Set(entries
    .map((entry) => normalizeRuntimeKernelDeviceReference(entry.path))
    .filter((entry): entry is RuntimeKernelDevicePath => entry !== null)
    .map((entry) => entry.slice('/dev/'.length))))
    .sort();
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

export function runtimeKernelWriteTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelWriteTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-directory') {
    return { kind: 'error', reason: 'device-directory', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelDeviceReference(virtualPath.path);
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
    }
    const outputDevice = runtimeKernelDeviceOutputTarget(devices, device);
    if (!outputDevice) {
      return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
    }
    return { kind: 'device', device, outputDevice };
  }
  const outputDevice = devices
    ? runtimeKernelDeviceOutputTarget(devices, virtualPath.path)
    : runtimeDeviceOutputTarget(virtualPath.path);
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

export function runtimeKernelMutationTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelMutationTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelDeviceReference(virtualPath.path);
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
    }
    return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device' && devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
    return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
  }
  return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
}

export function runtimeKernelMutationErrorCode(
  reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'device-not-found' ? 'ENOENT' : 'EROFS';
}

export function runtimeKernelMetadataTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelMetadataTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelDeviceReference(virtualPath.path);
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
    }
    return { kind: 'ignored-device', path: device };
  }
  if (virtualPath.kind === 'device' && devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
    return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
  }
  return { kind: 'ignored-device', path: virtualPath.path };
}

export function runtimeKernelMetadataErrorCode(
  reason: Extract<RuntimeKernelMetadataTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'proc-read-only' ? 'EROFS' : 'ENOENT';
}

export function runtimeKernelAccessTarget(
  path: string,
  request: RuntimeKernelAccessRequest = {},
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelAccessTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelDeviceReference(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (!device || !info) return { kind: 'denied', reason: 'not-found', path: virtualPath.path };
    return (request.read && !info.readable) || (request.write && !info.writable) || request.execute
      ? { kind: 'denied', reason: 'permission-denied', path: device }
      : { kind: 'allowed', path: device };
  }
  if (virtualPath.kind === 'device-directory') {
    return request.write || request.execute
      ? { kind: 'denied', reason: 'permission-denied', path: virtualPath.path }
      : { kind: 'allowed', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device') {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: 'denied', reason: 'not-found', path: virtualPath.path };
    const readable = info ? info.readable : runtimeDeviceCanRead(virtualPath.path);
    const writable = info ? info.writable : runtimeDeviceCanWrite(virtualPath.path);
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

export function runtimeKernelOpenTarget(
  path: string,
  request: RuntimeKernelOpenRequest = {},
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelOpenTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelDeviceReference(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (!device || !info) return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    return {
      kind: 'device',
      device,
      readable: info.readable && request.readable === true,
      writable: info.writable && request.writable === true,
    };
  }
  if (virtualPath.kind === 'device-directory') {
    return { kind: 'error', reason: 'is-directory', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device') {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    return {
      kind: 'device',
      device: virtualPath.path,
      readable: info ? info.readable && request.readable === true : runtimeDeviceCanRead(virtualPath.path) && request.readable === true,
      writable: info ? info.writable && request.writable === true : runtimeDeviceCanWrite(virtualPath.path) && request.writable === true,
    };
  }

  const entryKind = runtimeProcEntryKind(virtualPath.path);
  if (!entryKind) {
    return { kind: 'error', reason: 'not-found', path: virtualPath.path };
  }
  if (entryKind === 'directory') {
    return { kind: 'error', reason: 'is-directory', path: virtualPath.path };
  }
  if (request.writable || request.create || request.truncate || request.exclusive) {
    return { kind: 'error', reason: 'read-only', path: virtualPath.path };
  }
  return { kind: 'proc-file', path: virtualPath.path, readable: true, writable: false };
}

export function runtimeKernelOpenErrorCode(
  reason: Extract<RuntimeKernelOpenTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  if (reason === 'is-directory') return 'EISDIR';
  if (reason === 'read-only') return 'EROFS';
  return 'ENOENT';
}

export function runtimeKernelReadTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelReadTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelDeviceReference(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (!device || !info) return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    return info.readable
      ? { kind: 'device-file', path: device }
      : { kind: 'error', reason: 'permission-denied', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-directory') return virtualPath;
  if (virtualPath.kind === 'device') {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    const readable = info ? info.readable : runtimeDeviceCanRead(virtualPath.path);
    return readable
      ? { kind: 'device-file', path: virtualPath.path }
      : { kind: 'error', reason: 'permission-denied', path: virtualPath.path };
  }
  const kind = runtimeProcEntryKind(virtualPath.path);
  if (kind === 'file') return { kind: 'proc-file', path: virtualPath.path };
  if (kind === 'directory') return { kind: 'proc-directory', path: virtualPath.path };
  return { kind: 'error', reason: 'not-found', path: virtualPath.path };
}

export function runtimeKernelFileReadTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelFileReadTarget {
  const readTarget = runtimeKernelReadTarget(path, devices);
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
  if (reason === 'permission-denied') return 'EBADF';
  return reason === 'is-directory' ? 'EISDIR' : 'ENOENT';
}

export function runtimeKernelStatTarget(
  path: string,
  info: RuntimeKernelInfo,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelStatTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-directory') {
    return { kind: 'stat', path: virtualPath.path, stat: runtimeDeviceStat(virtualPath.path) };
  }
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelDeviceReference(virtualPath.path);
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    }
    return { kind: 'stat', path: device, stat: runtimeDeviceStat(device) };
  }
  if (virtualPath.kind === 'device') {
    if (devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
      return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    }
    return { kind: 'stat', path: virtualPath.path, stat: runtimeDeviceStat(virtualPath.path) };
  }
  const stat = runtimeProcStat(virtualPath.path, info);
  return stat
    ? { kind: 'stat', path: virtualPath.path, stat }
    : { kind: 'error', reason: 'not-found', path: virtualPath.path };
}

export function runtimeKernelStatErrorCode(
  _reason: Extract<RuntimeKernelStatTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return 'ENOENT';
}

export function runtimeKernelDirectoryTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelDirectoryTarget {
  const readTarget = runtimeKernelReadTarget(path, devices);
  if (readTarget.kind === 'workspace') return readTarget;
  if (readTarget.kind === 'device-directory') {
    return {
      kind: 'directory',
      path: readTarget.path,
      entries: (runtimeDeviceDirEntries(readTarget.path, devices) ?? []).map((name) => ({
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
  if (readTarget.reason === 'permission-denied') {
    return { kind: 'error', reason: 'not-directory', path: readTarget.path };
  }
  return { kind: 'error', reason: 'not-found', path: readTarget.path };
}

export function runtimeKernelDirectoryErrorCode(
  reason: Extract<RuntimeKernelDirectoryTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'not-directory' ? 'ENOTDIR' : 'ENOENT';
}

export function runtimeKernelCopyTarget(
  source: string,
  destination: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelCopyTarget {
  const sourceTarget = runtimeKernelReadTarget(source, devices);
  const writeTarget = runtimeKernelWriteTarget(destination, devices);
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

export function runtimeKernelFileCopyTarget(
  source: string,
  destination: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelFileCopyTarget {
  const writeTarget = runtimeKernelWriteTarget(destination, devices);
  if (writeTarget.kind === 'error') {
    return { kind: 'error', side: 'destination', reason: writeTarget.reason, path: writeTarget.path };
  }

  const sourceTarget = runtimeKernelFileReadTarget(source, devices);
  if (sourceTarget.kind === 'error') {
    return { kind: 'error', side: 'source', reason: sourceTarget.reason, path: sourceTarget.path };
  }

  if (writeTarget.kind === 'device') {
    return { kind: 'device-destination', outputDevice: writeTarget.outputDevice, source: sourceTarget };
  }

  if (sourceTarget.kind === 'device-file' || sourceTarget.kind === 'proc-file') {
    return { kind: 'virtual-source', source: sourceTarget };
  }

  return { kind: 'workspace' };
}

export function runtimeKernelLinkTarget(
  source: string,
  destination: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelLinkTarget {
  const sourceTarget = runtimeKernelMutationTarget(source, devices);
  if (sourceTarget.kind === 'error') {
    return { kind: 'error', side: 'source', reason: sourceTarget.reason, path: sourceTarget.path };
  }
  const destinationTarget = runtimeKernelMutationTarget(destination, devices);
  if (destinationTarget.kind === 'error') {
    return { kind: 'error', side: 'destination', reason: destinationTarget.reason, path: destinationTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeKernelLinkErrorCode(
  reason: Extract<RuntimeKernelLinkTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return runtimeKernelMutationErrorCode(reason);
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

export function runtimeProcKernelVersion(info: RuntimeKernelInfo): string {
  return `${info.name} ${info.version}\n`;
}

export function runtimeProcDirEntries(path: string): string[] | null {
  if (path === '/proc') return ['kernel', 'self'];
  if (path === '/proc/kernel') return ['info', 'version'];
  if (path === '/proc/self') return ['mountinfo'];
  return null;
}

export function runtimeProcEntryKind(path: string): RuntimeKernelProcEntryKind | null {
  if (runtimeProcDirEntries(path)) return 'directory';
  if (path === '/proc/kernel/info' || path === '/proc/kernel/version' || path === '/proc/self/mountinfo') return 'file';
  return null;
}

export function runtimeKernelVirtualPaths(): string[] {
  const devicePaths = ['/dev', ...RUNTIME_KERNEL_DEVICE_ENTRIES.map((name) => `/dev/${name}`)];
  const procPaths = ['/proc', '/proc/kernel', '/proc/kernel/info', '/proc/kernel/version', '/proc/self', '/proc/self/mountinfo'];
  return [...devicePaths, ...procPaths];
}

export function runtimeKernelVirtualDevices(): RuntimeKernelDeviceInfo[] {
  return RUNTIME_KERNEL_DEVICE_ENTRIES.map((name) => {
    const path = `/dev/${name}` as RuntimeKernelDevicePath;
    const inputDevice = runtimeDeviceInputSource(path) ?? undefined;
    const outputDevice = runtimeDeviceOutputTarget(path) ?? undefined;
    return {
      path,
      readable: inputDevice !== undefined,
      writable: outputDevice !== undefined,
      ...(inputDevice ? { inputDevice } : {}),
      ...(outputDevice ? { outputDevice } : {}),
    };
  });
}

export function runtimeKernelVirtualFiles(info: RuntimeKernelInfo): RuntimeFile[] {
  return [
    { path: '/proc/kernel/info', contents: readRuntimeProcFile('/proc/kernel/info', info) },
    { path: '/proc/kernel/version', contents: readRuntimeProcFile('/proc/kernel/version', info) },
    { path: '/proc/self/mountinfo', contents: readRuntimeProcFile('/proc/self/mountinfo', info) },
  ];
}

export function readRuntimeProcFile(path: string, info: RuntimeKernelInfo): string {
  if (path === '/proc/kernel/info') return runtimeProcInfoJson(info);
  if (path === '/proc/kernel/version') return runtimeProcKernelVersion(info);
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
