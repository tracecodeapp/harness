import type { RuntimeKernelInfo } from './runtime-project';

export type RuntimeKernelProcEntryKind = 'file' | 'directory';

export function normalizeRuntimeProcPath(path: string): string | null {
  const raw = path.replace(/\\/g, '/');
  if (!raw.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const normalized = `/${parts.join('/')}`.replace(/\/+$/, '') || '/';
  return normalized === '/proc' || normalized.startsWith('/proc/') ? normalized : null;
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
