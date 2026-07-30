import type {
  RuntimeFile,
  RuntimeKernelDeviceInfo,
  RuntimeKernelDevicePath,
  RuntimeKernelInfo,
} from './runtime-project';
import {
  RUNTIME_KERNEL_DEVICE_ENTRIES,
  readRuntimeKernelIdentityFile,
  runtimeDeviceInputSource,
  runtimeDeviceOutputTarget,
  runtimeKernelIdentityDirEntries,
  runtimeKernelIdentityEntryKind,
  runtimeKernelVirtualPaths,
  type RuntimeKernelProcEntryKind,
  type RuntimeKernelVirtualStat,
} from './runtime-kernel-paths';

export function runtimeProcInfoJson(info: RuntimeKernelInfo): string {
  return `${JSON.stringify(info, null, 2)}\n`;
}

export function publicRuntimeKernelInfo(info: RuntimeKernelInfo): RuntimeKernelInfo {
  const workspaceRoot = '/workspace';
  const home = '/home/user';
  const workspaceName = 'workspace';
  return {
    name: info.name,
    version: info.version,
    user: {
      id: 'user',
      username: 'user',
      home,
    },
    host: {
      hostname: 'tracevm',
      osName: 'tracekernel',
    },
    workspace: {
      id: workspaceName,
      name: workspaceName,
      root: workspaceRoot,
      startedAt: '1970-01-01T00:00:00.000Z',
    },
    home,
    cwd: workspaceRoot,
    workspaceRoot,
  };
}

export function runtimeMountInfoField(value: string): string {
  return value.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011').replace(/\n/g, '\\012');
}

export interface RuntimeKernelMount {
  id: number;
  parentId: number;
  device: string;
  root: string;
  target: string;
  type: string;
  source: string;
  options: readonly string[];
  superOptions: readonly string[];
  optionalFields?: readonly string[];
}

export function runtimeKernelMounts(info: RuntimeKernelInfo): RuntimeKernelMount[] {
  const workspaceName = `name=${info.workspace.name}`;
  const mounts: RuntimeKernelMount[] = [
    {
      id: 20,
      parentId: 0,
      device: '0:0',
      root: '/',
      target: '/',
      type: 'tracefs',
      source: 'tracekernel:system',
      options: ['ro', 'relatime'],
      superOptions: ['ro'],
    },
    {
      id: 21,
      parentId: 20,
      device: '0:6',
      root: '/',
      target: '/tmp',
      type: 'tracefs',
      source: 'tracekernel:tmp',
      options: ['rw', 'nosuid', 'nodev'],
      superOptions: ['rw', 'mode=1777'],
    },
    {
      id: 22,
      parentId: 20,
      device: '0:7',
      root: '/',
      target: '/var/tmp',
      type: 'tracefs',
      source: 'tracekernel:var-tmp',
      options: ['rw', 'nosuid', 'nodev'],
      superOptions: ['rw', 'mode=1777'],
    },
    {
      id: 24,
      parentId: 20,
      device: '0:1',
      root: '/',
      target: info.workspaceRoot,
      type: 'tracefs',
      source: 'tracekernel:workspace',
      options: ['rw', 'relatime'],
      superOptions: ['rw', workspaceName],
    },
    {
      id: 25,
      parentId: 20,
      device: '0:2',
      root: '/',
      target: '/dev',
      type: 'tracefs',
      source: 'tracekernel:dev',
      options: ['rw', 'nosuid'],
      superOptions: ['rw', 'mode=755'],
    },
    {
      id: 26,
      parentId: 20,
      device: '0:3',
      root: '/',
      target: '/proc',
      type: 'traceproc',
      source: 'tracekernel:proc',
      options: ['ro', 'nosuid', 'nodev', 'noexec'],
      superOptions: ['ro'],
    },
    {
      id: 28,
      parentId: 20,
      device: '0:4',
      root: '/',
      target: '/tracekernel',
      type: 'tracefs',
      source: 'tracekernel:control',
      options: ['ro', 'nosuid', 'nodev', 'noexec'],
      superOptions: ['ro'],
    },
    {
      id: 29,
      parentId: 20,
      device: '0:5',
      root: '/',
      target: '/skills',
      type: 'tracefs',
      source: 'tracekernel:skills',
      options: ['ro', 'nosuid', 'nodev', 'noexec'],
      superOptions: ['ro'],
    },
  ];
  if (info.workspaceAlias && info.workspaceAlias !== info.workspaceRoot) {
    mounts.splice(1, 0, {
      id: 27,
      parentId: 20,
      device: '0:1',
      root: '/',
      target: info.workspaceAlias,
      type: 'tracefs',
      source: 'tracekernel:workspace',
      options: ['rw', 'relatime'],
      superOptions: ['rw', workspaceName],
      optionalFields: [`alias=${info.workspaceRoot}`],
    });
  }
  return mounts;
}

export function runtimeProcMountInfo(info: RuntimeKernelInfo): string {
  return runtimeKernelMounts(info).map((mount) => [
    mount.id,
    mount.parentId,
    mount.device,
    runtimeMountInfoField(mount.root),
    runtimeMountInfoField(mount.target),
    mount.options.join(','),
    ...(mount.optionalFields ?? []).map(runtimeMountInfoField),
    '-',
    mount.type,
    runtimeMountInfoField(mount.source),
    mount.superOptions.map(runtimeMountInfoField).join(','),
  ].join(' ')).join('\n') + '\n';
}

export function runtimeProcMounts(info: RuntimeKernelInfo): string {
  return runtimeKernelMounts(info).map((mount) => [
    runtimeMountInfoField(mount.source),
    runtimeMountInfoField(mount.target),
    mount.type,
    mount.options.map(runtimeMountInfoField).join(','),
    '0',
    '0',
  ].join(' ')).join('\n') + '\n';
}

export function runtimeProcKernelVersion(info: RuntimeKernelInfo): string {
  return `${info.name} ${info.version}\n`;
}

export function runtimeProcDirEntries(path: string): string[] | null {
  if (path === '/proc') return ['kernel', 'mounts', 'self'];
  if (path === '/proc/kernel') return ['info', 'version'];
  if (path === '/proc/self') return ['mountinfo'];
  return null;
}

export function runtimeProcEntryKind(path: string): RuntimeKernelProcEntryKind | null {
  if (runtimeProcDirEntries(path)) return 'directory';
  if (path === '/proc/kernel/info' || path === '/proc/kernel/version' || path === '/proc/mounts' || path === '/proc/self/mountinfo') return 'file';
  return null;
}

export function runtimeKernelVirtualFiles(info: RuntimeKernelInfo): RuntimeFile[] {
  return [
    ...(runtimeKernelIdentityDirEntries('/etc') ?? []).map((name) => ({
      path: `/etc/${name}`,
      contents: readRuntimeKernelIdentityFile(`/etc/${name}`, info),
    })),
    { path: '/proc/kernel/info', contents: readRuntimeProcFile('/proc/kernel/info', info) },
    { path: '/proc/kernel/version', contents: readRuntimeProcFile('/proc/kernel/version', info) },
    { path: '/proc/mounts', contents: readRuntimeProcFile('/proc/mounts', info) },
    { path: '/proc/self/mountinfo', contents: readRuntimeProcFile('/proc/self/mountinfo', info) },
  ];
}

export function runtimeKernelIdentityStat(path: string, info: RuntimeKernelInfo): RuntimeKernelVirtualStat | null {
  const kind = runtimeKernelIdentityEntryKind(path);
  if (!kind) return null;
  const isDirectory = kind === 'directory';
  const content = isDirectory ? '' : readRuntimeKernelIdentityFile(path, info);
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: false,
    mode: isDirectory ? 0o755 : 0o644,
    size: new TextEncoder().encode(content).byteLength,
    uid: 0,
    gid: 0,
    owner: 'root',
    group: 'root',
  };
}

export function publicRuntimeKernelVirtualFiles(info: RuntimeKernelInfo): RuntimeFile[] {
  return runtimeKernelVirtualFiles(publicRuntimeKernelInfo(info));
}

export function readRuntimeProcFile(path: string, info: RuntimeKernelInfo): string {
  if (path === '/proc/kernel/info') return runtimeProcInfoJson(info);
  if (path === '/proc/kernel/version') return runtimeProcKernelVersion(info);
  if (path === '/proc/mounts') return runtimeProcMounts(info);
  if (path === '/proc/self/mountinfo') return runtimeProcMountInfo(info);
  if (runtimeProcDirEntries(path)) {
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: 'EISDIR' });
  }
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

export function readPublicRuntimeProcFile(path: string, info: RuntimeKernelInfo): string {
  return readRuntimeProcFile(path, publicRuntimeKernelInfo(info));
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
    uid: 0,
    gid: 0,
    owner: 'root',
    group: 'root',
  };
}
