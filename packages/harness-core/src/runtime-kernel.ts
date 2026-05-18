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
