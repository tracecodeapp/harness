import type {
  RuntimeKernelInfo,
} from "@tracecode/runtime-contracts";

import {
  dirname,
} from "../kernel/path-normalization";

export function createPathApi(getCwd: () => string, workspaceRoot: string) {
  const normalizePath = (value: string): string => {
    const raw = String(value).replace(/\\/g, '/');
    const isAbsolute = raw.startsWith('/');
    const parts: string[] = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        const previous = parts[parts.length - 1];
        if (previous && previous !== '..') {
          parts.pop();
        } else if (!isAbsolute) {
          parts.push('..');
        }
      } else {
        parts.push(part);
      }
    }
    const normalized = parts.join('/');
    if (isAbsolute) return normalized ? `/${normalized}` : '/';
    return normalized || '.';
  };
  const cwdAbsolutePath = (): string => {
    const cwd = getCwd();
    return cwd ? `${workspaceRoot}/${cwd}` : workspaceRoot;
  };
  const isAbsolute = (path: string): boolean => String(path).startsWith('/');
  const normalize = (path: string): string => normalizePath(path);
  const join = (...parts: string[]): string => normalizePath(parts.filter((part) => String(part).length > 0).join('/'));
  const resolve = (...parts: string[]): string => {
    const rawParts = parts.map((part) => String(part)).filter((part) => part.length > 0);
    let resolved = '';
    for (let index = rawParts.length - 1; index >= 0; index -= 1) {
      resolved = resolved ? `${rawParts[index]}/${resolved}` : rawParts[index] ?? '';
      if (resolved.startsWith('/')) return normalizePath(resolved);
    }
    return normalizePath(`${cwdAbsolutePath()}/${resolved}`);
  };
  const dirnameApi = (path: string): string => {
    const normalized = normalizePath(path);
    if (normalized === '/') return '/';
    const withoutTrailingSlash = normalized.replace(/\/+$/, '');
    const index = withoutTrailingSlash.lastIndexOf('/');
    if (index === -1) return '.';
    if (index === 0) return '/';
    return withoutTrailingSlash.slice(0, index);
  };
  const basename = (path: string, suffix?: string): string => {
    const normalized = normalizePath(path).replace(/\/+$/, '');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  };
  const extname = (path: string): string => {
    const base = basename(path);
    const index = base.lastIndexOf('.');
    if (index <= 0) return '';
    return base.slice(index);
  };
  const relative = (from: string, to: string): string => {
    const fromParts = resolve(from).split('/').filter(Boolean);
    const toParts = resolve(to).split('/').filter(Boolean);
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
      common += 1;
    }
    return [
      ...fromParts.slice(common).map(() => '..'),
      ...toParts.slice(common),
    ].join('/') || '';
  };
  const parse = (path: string) => {
    const normalized = normalizePath(path);
    const root = normalized.startsWith('/') ? '/' : '';
    const dir = dirnameApi(normalized);
    const base = basename(normalized);
    const ext = extname(base);
    const name = ext ? base.slice(0, -ext.length) : base;
    return {
      root,
      dir: dir === '.' ? '' : dir,
      base,
      ext,
      name,
    };
  };
  const format = (pathObject: { root?: string; dir?: string; base?: string; name?: string; ext?: string }) => {
    const dir = pathObject.dir || pathObject.root || '';
    const base = pathObject.base ?? `${pathObject.name ?? ''}${pathObject.ext ?? ''}`;
    if (!dir) return base;
    if (dir === '/') return `/${base}`;
    return `${dir}/${base}`;
  };
  const api = {
    sep: '/',
    delimiter: ':',
    normalize,
    join,
    resolve,
    dirname: dirnameApi,
    basename,
    extname,
    isAbsolute,
    relative,
    parse,
    format,
  };
  return { ...api, posix: api };
}

export function inferWorkspaceHome(workspaceRoot: string): string {
  const parts = workspaceRoot.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'home') {
    return `/${parts.slice(0, 2).join('/')}`;
  }
  const parent = dirname(workspaceRoot);
  return parent || workspaceRoot;
}

export function workspaceUsername(workspaceHome: string): string {
  const parts = workspaceHome.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'browser';
}

export function createOsApi(workspaceRoot: string, kernelInfo: RuntimeKernelInfo) {
  const home = inferWorkspaceHome(workspaceRoot);
  const cpuCount = Math.max(1, Math.min(8, Math.floor(globalThis.navigator?.hardwareConcurrency ?? 2)));
  const cpu = () => ({
    model: 'Virtual CPU',
    speed: 2400,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  });
  return {
    EOL: '\n',
    devNull: '/dev/null',
    arch: () => 'x64',
    availableParallelism: () => cpuCount,
    cpus: () => Array.from({ length: cpuCount }, cpu),
    endianness: () => 'LE',
    freemem: () => 6 * 1024 * 1024 * 1024,
    homedir: () => home,
    hostname: () => kernelInfo.host.hostname,
    loadavg: () => [0, 0, 0],
    machine: () => 'x86_64',
    networkInterfaces: () => ({}),
    platform: () => 'tracekernel',
    release: () => kernelInfo.version,
    tmpdir: () => '/tmp',
    totalmem: () => 8 * 1024 * 1024 * 1024,
    type: () => 'tracekernel',
    uptime: () => 0,
    version: () => kernelInfo.version,
    userInfo: () => ({
      username: workspaceUsername(home),
      uid: 1000,
      gid: 1000,
      shell: '/bin/bash',
      homedir: home,
    }),
  };
}
