import type {
  RuntimeCommandEventStream,
  RuntimeFile,
  RuntimeKernelDeviceInfo,
  RuntimeKernelDevicePath,
  RuntimeKernelInfo,
} from './runtime-project';

export type RuntimeKernelProcEntryKind = 'file' | 'directory';
export type RuntimeKernelDeviceEntryKind = 'file' | 'directory';
export interface RuntimeKernelVirtualStat {
  isFile: boolean;
  isDirectory: boolean;
  isCharacterDevice: boolean;
  mode: number;
  size: number;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
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
  | { kind: 'device-directory'; path: '/dev' | RuntimeKernelDevicePath }
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
  | { kind: 'device-destination'; device: RuntimeKernelDevicePath; outputDevice: RuntimeKernelDevicePath; source: RuntimeKernelFileReadTarget }
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
export type RuntimeKernelRenameTarget =
  | { kind: 'workspace' }
  | {
      kind: 'error';
      side: 'source' | 'destination';
      reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason'];
      path: string;
    };
export type RuntimeKernelSymlinkTarget =
  | { kind: 'workspace' }
  | {
      kind: 'error';
      reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason'];
      path: string;
    };
export type RuntimeKernelRemoveTarget =
  | { kind: 'workspace' }
  | {
      kind: 'error';
      reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason'];
      path: string;
    };
export type RuntimeKernelMkdirTarget =
  | { kind: 'workspace' }
  | {
      kind: 'error';
      reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason'];
      path: string;
    };
export type RuntimeKernelTruncateTarget =
  | { kind: 'workspace' }
  | {
      kind: 'error';
      reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason'];
      path: string;
    };
export type RuntimeKernelErrorCode = 'EBADF' | 'EISDIR' | 'ENOENT' | 'ENOTDIR' | 'EROFS';
export type RuntimeKernelVirtualPath =
  | { kind: 'proc'; path: string }
  | { kind: 'identity'; path: string }
  | { kind: 'device'; path: RuntimeKernelDevicePath }
  | { kind: 'device-directory'; path: '/dev' }
  | { kind: 'device-namespace'; path: string };
export interface RuntimeKernelDeviceOutputRoute {
  outputDevice: RuntimeKernelDevicePath;
  stream: RuntimeCommandEventStream;
  sourceDevice?: RuntimeKernelDevicePath;
}
export interface RuntimeKernelDeviceInputRoute {
  inputDevice: RuntimeKernelDevicePath;
  sourceDevice?: RuntimeKernelDevicePath;
}
export const RUNTIME_KERNEL_DEVICE_ENTRIES = ['fd/0', 'fd/1', 'fd/2', 'null', 'stderr', 'stdin', 'stdout', 'tty'] as const;

export function runtimeKernelReadonlyFileErrorMessage(path: string, operation: string): string {
  return `EROFS: readonly project file, ${operation} '${path}'`;
}

export function createRuntimeKernelReadonlyFileError(path: string, operation: string): Error & { code: 'EROFS' } {
  return Object.assign(new Error(runtimeKernelReadonlyFileErrorMessage(path, operation)), { code: 'EROFS' as const });
}

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
    normalized === '/dev/fd/0' ||
    normalized === '/dev/fd/1' ||
    normalized === '/dev/fd/2' ||
    normalized === '/dev/null' ||
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

export function normalizeRuntimeKernelManifestDevicePath(path: string): RuntimeKernelDevicePath | null {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null || normalized === '/dev' || !normalized.startsWith('/dev/')) return null;
  return normalized.slice('/dev/'.length).length > 0 ? normalized as RuntimeKernelDevicePath : null;
}

export function isRuntimeDeviceNamespacePath(path: string): boolean {
  const normalized = normalizeRuntimeAbsolutePath(path);
  return normalized === '/dev' || normalized?.startsWith('/dev/') === true;
}

const RUNTIME_KERNEL_IDENTITY_FILE_NAMES = [
  'group',
  'hostname',
  'hosts',
  'nsswitch.conf',
  'os-release',
  'passwd',
  'shells',
] as const;

export function isRuntimeKernelIdentityNamespacePath(path: string): boolean {
  const normalized = normalizeRuntimeAbsolutePath(path);
  return normalized === '/etc' || normalized?.startsWith('/etc/') === true;
}

export function runtimeKernelIdentityDirEntries(path: string): string[] | null {
  return normalizeRuntimeAbsolutePath(path) === '/etc'
    ? [...RUNTIME_KERNEL_IDENTITY_FILE_NAMES]
    : null;
}

export function runtimeKernelIdentityEntryKind(path: string): RuntimeKernelProcEntryKind | null {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === '/etc') return 'directory';
  return normalized && RUNTIME_KERNEL_IDENTITY_FILE_NAMES.some((name) => normalized === '/etc/' + name)
    ? 'file'
    : null;
}

function quoteOsReleaseValue(value: string): string {
  return '"' + value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"') + '"';
}

export function readRuntimeKernelIdentityFile(path: string, info: RuntimeKernelInfo): string {
  const normalized = normalizeRuntimeAbsolutePath(path);
  const username = info.user.username;
  const hostname = info.host.hostname;
  if (normalized === '/etc/os-release') {
    return [
      'NAME="TraceKernel"',
      'ID=tracekernel',
      'VERSION_ID=' + quoteOsReleaseValue(info.version),
      'PRETTY_NAME=' + quoteOsReleaseValue('TraceKernel ' + info.version),
      '',
    ].join('\n');
  }
  if (normalized === '/etc/passwd') {
    return [
      'root:x:0:0:root:/root:/bin/sh',
      username + ':x:1000:1000:TraceKernel ' + username + ':' + info.home + ':/bin/bash',
      '',
    ].join('\n');
  }
  if (normalized === '/etc/group') {
    return [
      'root:x:0:',
      username + ':x:1000:' + username,
      '',
    ].join('\n');
  }
  if (normalized === '/etc/hostname') return hostname + '\n';
  if (normalized === '/etc/hosts') {
    return '127.0.0.1 localhost ' + hostname + '\n::1 localhost ' + hostname + '\n';
  }
  if (normalized === '/etc/nsswitch.conf') {
    return 'passwd: files\ngroup: files\nhosts: files dns\n';
  }
  if (normalized === '/etc/shells') return '/bin/sh\n/bin/bash\n';
  if (normalized === '/etc') {
    throw Object.assign(new Error("EISDIR: illegal operation on a directory, read '" + path + "'"), { code: 'EISDIR' });
  }
  throw Object.assign(new Error("ENOENT: no such file or directory, open '" + path + "'"), { code: 'ENOENT' });
}

export function isRuntimeKernelVirtualNamespacePath(path: string): boolean {
  return isRuntimeProcNamespacePath(path) ||
    isRuntimeDeviceNamespacePath(path) ||
    isRuntimeKernelIdentityNamespacePath(path);
}

export function classifyRuntimeKernelVirtualPath(path: string): RuntimeKernelVirtualPath | null {
  const procPath = normalizeRuntimeProcPath(path);
  if (procPath !== null) return { kind: 'proc', path: procPath };
  const identityPath = normalizeRuntimeAbsolutePath(path);
  if (identityPath && isRuntimeKernelIdentityNamespacePath(identityPath)) {
    return { kind: 'identity', path: identityPath };
  }
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
  return device === '/dev/stdin' || device === '/dev/fd/0' || device === '/dev/tty' || device === '/dev/null';
}

export function runtimeDeviceCanWrite(device: RuntimeKernelDevicePath): boolean {
  return device === '/dev/stdout' || device === '/dev/fd/1' || device === '/dev/stderr' || device === '/dev/fd/2' || device === '/dev/tty' || device === '/dev/null';
}

export function runtimeDeviceInputSource(device: RuntimeKernelDevicePath): RuntimeKernelDevicePath | null {
  if (!runtimeDeviceCanRead(device)) return null;
  return device === '/dev/null' ? '/dev/null' : '/dev/stdin';
}

export function runtimeDeviceOutputTarget(device: RuntimeKernelDevicePath): RuntimeKernelDevicePath | null {
  if (!runtimeDeviceCanWrite(device)) return null;
  if (device === '/dev/null') return '/dev/null';
  if (device === '/dev/fd/1') return '/dev/stdout';
  if (device === '/dev/fd/2') return '/dev/stderr';
  return device === '/dev/tty' ? '/dev/stdout' : device;
}

export function runtimeKernelDeviceInfo(
  devices: readonly RuntimeKernelDeviceInfo[] | undefined,
  device: RuntimeKernelDevicePath
): RuntimeKernelDeviceInfo | null {
  const entries = devices ?? runtimeKernelVirtualDevices();
  return entries.find((entry) => normalizeRuntimeKernelManifestDevicePath(entry.path) === device) ?? null;
}

function normalizeDeviceReference(value: RuntimeKernelDevicePath | undefined): RuntimeKernelDevicePath | null {
  if (!value) return null;
  return normalizeRuntimeKernelManifestDevicePath(value);
}

export function runtimeKernelDeviceInputSource(
  devices: readonly RuntimeKernelDeviceInfo[] | undefined,
  device: RuntimeKernelDevicePath
): RuntimeKernelDevicePath | null {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.readable) return null;
  return normalizeDeviceReference(info.inputDevice) ?? device;
}

export function runtimeKernelDeviceInputRoute(
  devices: readonly RuntimeKernelDeviceInfo[] | undefined,
  device: RuntimeKernelDevicePath
): RuntimeKernelDeviceInputRoute | null {
  const inputDevice = devices
    ? runtimeKernelDeviceInputSource(devices, device)
    : runtimeDeviceInputSource(device);
  if (!inputDevice || inputDevice === '/dev/null') return null;
  return {
    inputDevice,
    ...(device !== inputDevice ? { sourceDevice: device } : {}),
  };
}

export function runtimeKernelDeviceOutputTarget(
  devices: readonly RuntimeKernelDeviceInfo[] | undefined,
  device: RuntimeKernelDevicePath
): RuntimeKernelDevicePath | null {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.writable) return null;
  return normalizeDeviceReference(info.outputDevice) ?? device;
}

export function runtimeKernelDeviceOutputRoute(
  devices: readonly RuntimeKernelDeviceInfo[] | undefined,
  device: RuntimeKernelDevicePath
): RuntimeKernelDeviceOutputRoute | null {
  const outputDevice = devices
    ? runtimeKernelDeviceOutputTarget(devices, device)
    : runtimeDeviceOutputTarget(device);
  if (!outputDevice || outputDevice === '/dev/null') return null;
  return {
    outputDevice,
    stream: outputDevice === '/dev/stderr' ? 'stderr' : 'stdout',
    ...(device !== outputDevice ? { sourceDevice: device } : {}),
  };
}

export function runtimeDeviceDirEntries(
  path: '/dev' | RuntimeKernelDevicePath,
  devices?: readonly RuntimeKernelDeviceInfo[]
): string[] | null {
  const directoryPath = path === '/dev' ? '/dev' : normalizeRuntimeKernelManifestDevicePath(path);
  if (!directoryPath) return null;
  const entries = devices ?? runtimeKernelVirtualDevices();
  const prefix = directoryPath === '/dev' ? '/dev/' : `${directoryPath}/`;
  const names = new Set<string>();
  for (const entry of entries) {
    const devicePath = normalizeRuntimeKernelManifestDevicePath(entry.path);
    if (!devicePath?.startsWith(prefix)) continue;
    const remainder = devicePath.slice(prefix.length);
    const [name] = remainder.split('/');
    if (name) names.add(name);
  }
  if (directoryPath !== '/dev' && names.size === 0) return null;
  return Array.from(names).sort();
}

export function runtimeDeviceEntryKind(
  path: '/dev' | RuntimeKernelDevicePath,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelDeviceEntryKind {
  if (path === '/dev') return 'directory';
  const devicePath = normalizeRuntimeKernelManifestDevicePath(path);
  if (devicePath && devices && runtimeKernelDeviceInfo(devices, devicePath)) return 'file';
  if (devicePath && runtimeDeviceDirEntries(devicePath, devices)) return 'directory';
  return 'file';
}

export function runtimeDeviceStat(
  path: '/dev' | RuntimeKernelDevicePath,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelVirtualStat {
  const kind = runtimeDeviceEntryKind(path, devices);
  const isDirectory = kind === 'directory';
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: !isDirectory,
    mode: isDirectory ? 0o755 : 0o666,
    size: 0,
    uid: 0,
    gid: 0,
    owner: 'root',
    group: 'root',
  };
}

export function runtimeKernelVirtualPaths(): string[] {
  const devicePaths = [
    '/dev',
    '/dev/fd',
    ...RUNTIME_KERNEL_DEVICE_ENTRIES.map((name) => `/dev/${name}`),
  ];
  const procPaths = [
    '/proc',
    '/proc/kernel',
    '/proc/kernel/info',
    '/proc/kernel/version',
    '/proc/mounts',
    '/proc/self',
    '/proc/self/mountinfo',
  ];
  const identityPaths = [
    '/etc',
    ...(runtimeKernelIdentityDirEntries('/etc') ?? []).map((name) => `/etc/${name}`),
  ];
  return [...devicePaths, ...identityPaths, ...procPaths];
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
