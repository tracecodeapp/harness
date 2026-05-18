import type {
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeKernelDevicePath,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import { createRuntimeProjectIoBridge } from '../../harness-core/src/runtime-project';
import * as fflateModule from 'fflate/browser';

export type JavaScriptProjectFileEncoding = RuntimeFileEncoding;
export type JavaScriptProjectFile = RuntimeFile;
export type JavaScriptProjectSnapshot = RuntimeProjectSnapshot;
export type JavaScriptProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin'
>;
export type JavaScriptProjectCommandResult = RuntimeCommandResult;
export type JavaScriptProjectCommandRunner = RuntimeProjectCommandRunner<JavaScriptProjectCommandRequest>;
export type BrowserJavaScriptProjectCommandRunner = JavaScriptProjectCommandRunner;

export interface BrowserJavaScriptProjectRunnerOptions {
  allowDynamicEval?: boolean;
  timeoutMs?: number;
}

type ModuleRecord = {
  exports: unknown;
  id?: string;
  filename?: string;
  loaded?: boolean;
  parent?: ModuleRecord | null;
  children?: ModuleRecord[];
  path?: string;
  paths?: string[];
  require?: ((specifier: string) => unknown) & {
    cache: Record<string, ModuleRecord>;
    main?: ModuleRecord;
    resolve: (specifier: string) => string;
  };
};

const DEFAULT_TIMEOUT_MS = 20_000;
const AsyncFunction = Object.getPrototypeOf(async function noop() {
  // Intentionally empty.
}).constructor as typeof Function;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function moduleDefault(value: unknown): unknown {
  return (value as Record<string, unknown>).default;
}

const fflateRecord = fflateModule as unknown as Record<string, unknown>;
const fflate = (
  typeof fflateRecord.gzipSync === 'function'
    ? fflateModule
    : moduleDefault(fflateModule)
) as typeof fflateModule;

interface PackageMetadata {
  type?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
}

type PackageResolutionCondition = 'require' | 'import';

interface WorkspacePathContext {
  root: string;
  alias?: string;
}

function normalizeProjectPath(path: string): string {
  const cleaned = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/workspace\//, '');
  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function workspacePathInputToString(path: unknown): string {
  if (path instanceof URL) {
    if (path.protocol !== 'file:') {
      throw new TypeError('The URL must be of scheme file');
    }
    return decodeURIComponent(path.pathname);
  }
  return String(path);
}

function normalizeRuntimeDevicePath(path: unknown): RuntimeKernelDevicePath | null {
  if (path === 0) return '/dev/stdin';
  if (path === 1) return '/dev/stdout';
  if (path === 2) return '/dev/stderr';
  const raw = workspacePathInputToString(path).replace(/\\/g, '/');
  if (raw === '/dev/stdin' || raw === '/dev/stdout' || raw === '/dev/stderr' || raw === '/dev/tty') {
    return raw;
  }
  if (raw.startsWith('/dev/')) {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${raw}'`), { code: 'ENOENT' });
  }
  return null;
}

function normalizeAbsoluteWorkspaceRoot(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}

function createWorkspacePathContext(project: RuntimeProjectSnapshot): WorkspacePathContext {
  return {
    root: normalizeAbsoluteWorkspaceRoot(project.workspaceRoot ?? project.cwd ?? '/workspace'),
    ...(project.workspaceAlias ? { alias: normalizeAbsoluteWorkspaceRoot(project.workspaceAlias) } : {}),
  };
}

function workspaceRelativeFromAbsolutePath(rawPath: string, workspace: WorkspacePathContext): string | null {
  const raw = normalizeAbsoluteWorkspaceRoot(rawPath);
  if (raw === workspace.root) return '';
  if (raw.startsWith(`${workspace.root}/`)) return raw.slice(workspace.root.length + 1);
  if (workspace.alias && raw === workspace.alias) return '';
  if (workspace.alias && raw.startsWith(`${workspace.alias}/`)) return raw.slice(workspace.alias.length + 1);
  return null;
}

function normalizeWorkspaceEntryPath(
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

function assertSafeWorkspaceFilePath(
  path: unknown,
  basePath = '',
  workspace: WorkspacePathContext = { root: '/workspace' }
): string {
  return normalizeWorkspaceEntryPath(path, basePath, false, workspace);
}

function utf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(value: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value).toString('base64');
  }

  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

function fileBytes(file: JavaScriptProjectFile): Uint8Array {
  return file.encoding === 'base64' ? base64ToBytes(file.contents) : utf8Bytes(file.contents);
}

function byteEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (!left || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesToRuntimeFile(path: string, contents: Uint8Array): JavaScriptProjectFile {
  const text = textDecoder.decode(contents);
  if (byteEqual(utf8Bytes(text), contents)) {
    return { path, contents: text };
  }
  return { path, contents: bytesToBase64(contents), encoding: 'base64' };
}

function bytesFromNodeValue(value: unknown): Uint8Array {
  if (typeof value === 'string') return utf8Bytes(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value)) return new Uint8Array(value.map((item) => Number(item) & 0xff));
  return utf8Bytes(String(value));
}

function requestedEncodingFromOptions(options?: string | { encoding?: string | null } | null): string | undefined {
  if (typeof options === 'string') return options;
  return typeof options?.encoding === 'string' ? options.encoding : undefined;
}

function bytesFromFsWriteValue(value: unknown, options?: string | { encoding?: string | null } | null): Uint8Array {
  const encoding = requestedEncodingFromOptions(options);
  if (typeof value === 'string' && typeof encoding === 'string') {
    return BrowserBuffer.from(value, encoding);
  }
  return bytesFromNodeValue(value);
}

function browserBufferFromBytes(value: Uint8Array): BrowserBuffer {
  return BrowserBuffer.from(value);
}

function textFromBytes(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim();
  const bytes = new Uint8Array(Math.ceil(normalized.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2).padEnd(2, '0'), 16) & 0xff;
  }
  return bytes;
}

class BrowserBuffer extends Uint8Array {
  static from(arrayLike: ArrayLike<number>): BrowserBuffer;
  static from<T>(arrayLike: ArrayLike<T>, mapfn: (value: T, index: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(elements: Iterable<number>): BrowserBuffer;
  static from<T>(elements: Iterable<T>, mapfn?: (value: T, index: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(value: string, encoding?: string): BrowserBuffer;
  static from(value: unknown, encodingOrMapfn?: string | ((value: unknown, index: number) => number), thisArg?: unknown): BrowserBuffer {
    if (typeof value === 'string') {
      const encoding = typeof encodingOrMapfn === 'string' ? encodingOrMapfn : undefined;
      if (encoding === 'base64') return new BrowserBuffer(base64ToBytes(value));
      if (encoding === 'hex') return new BrowserBuffer(hexToBytes(value));
      if (encoding === 'latin1' || encoding === 'binary') {
        return new BrowserBuffer(Array.from(value, (char) => char.charCodeAt(0) & 0xff));
      }
      return new BrowserBuffer(utf8Bytes(value));
    }
    if (typeof encodingOrMapfn === 'function' && value != null) {
      return new BrowserBuffer(Array.from(value as Iterable<unknown>, encodingOrMapfn, thisArg));
    }
    return new BrowserBuffer(bytesFromNodeValue(value));
  }

  static alloc(size: number, fill = 0): BrowserBuffer {
    const bytes = new BrowserBuffer(Math.max(0, Number(size) || 0));
    bytes.fill(Number(fill) & 0xff);
    return bytes;
  }

  static isBuffer(value: unknown): value is BrowserBuffer {
    return value instanceof BrowserBuffer;
  }

  static concat(values: readonly Uint8Array[]): BrowserBuffer {
    const totalLength = values.reduce((sum, value) => sum + value.byteLength, 0);
    const bytes = new BrowserBuffer(totalLength);
    let offset = 0;
    for (const value of values) {
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return bytes;
  }

  static byteLength(value: unknown, encoding?: string): number {
    if (typeof value === 'string') return BrowserBuffer.from(value, encoding).byteLength;
    return bytesFromNodeValue(value).byteLength;
  }

  toString(encoding = 'utf8'): string {
    if (encoding === 'base64') return bytesToBase64(this);
    if (encoding === 'hex') return bytesToHex(this);
    if (encoding === 'latin1' || encoding === 'binary') {
      return Array.from(this, (byte) => String.fromCharCode(byte)).join('');
    }
    return textFromBytes(this);
  }
}

function createZlibApi() {
  return {
    gzipSync: (input: unknown) => browserBufferFromBytes(fflate.gzipSync(bytesFromNodeValue(input))),
    gunzipSync: (input: unknown) => browserBufferFromBytes(fflate.gunzipSync(bytesFromNodeValue(input))),
    deflateSync: (input: unknown) => browserBufferFromBytes(fflate.deflateSync(bytesFromNodeValue(input))),
    inflateSync: (input: unknown) => browserBufferFromBytes(fflate.inflateSync(bytesFromNodeValue(input))),
  };
}

function createReadableStdinDevice(input: string) {
  const bytes = BrowserBuffer.from(input);
  let offset = 0;
  let encoding: string | undefined;
  let flowScheduled = false;
  const dataListeners: Array<(chunk: BrowserBuffer | string) => void> = [];
  const endListeners: Array<() => void> = [];

  const formatChunk = (chunk: BrowserBuffer): BrowserBuffer | string => (
    encoding ? chunk.toString(encoding) : chunk
  );
  const read = (size?: number): BrowserBuffer | string | null => {
    if (offset >= bytes.byteLength) return null;
    const requested = typeof size === 'number' && size >= 0 ? Math.floor(size) : bytes.byteLength - offset;
    const end = Math.min(bytes.byteLength, offset + requested);
    const chunk = BrowserBuffer.from(bytes.slice(offset, end));
    offset = end;
    return formatChunk(chunk);
  };
  const scheduleFlow = (): void => {
    if (flowScheduled) return;
    flowScheduled = true;
    queueMicrotask(() => {
      const chunk = read();
      if (chunk !== null) {
        for (const listener of dataListeners) listener(chunk);
      }
      for (const listener of endListeners) listener();
    });
  };
  const stream = {
    fd: 0,
    readable: true,
    isTTY: false,
    setEncoding: (nextEncoding: string) => {
      encoding = nextEncoding;
      return stream;
    },
    read,
    on: (event: string, listener: (chunk?: BrowserBuffer | string) => void) => {
      if (event === 'data') {
        dataListeners.push((chunk) => listener(chunk));
        scheduleFlow();
      } else if (event === 'end') {
        endListeners.push(() => listener());
        scheduleFlow();
      }
      return stream;
    },
    once: (event: string, listener: (chunk?: BrowserBuffer | string) => void) => stream.on(event, listener),
    resume: () => stream,
    pause: () => stream,
    [Symbol.asyncIterator]: async function* () {
      const chunk = read();
      if (chunk !== null) yield chunk;
    },
  };
  return stream;
}

function createPathApi(getCwd: () => string, workspaceRoot: string) {
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

function inferWorkspaceHome(workspaceRoot: string): string {
  const parts = workspaceRoot.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'home') {
    return `/${parts.slice(0, 2).join('/')}`;
  }
  const parent = dirname(workspaceRoot);
  return parent || workspaceRoot;
}

function workspaceUsername(workspaceHome: string): string {
  const parts = workspaceHome.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'browser';
}

function createOsApi(workspaceRoot: string) {
  const home = inferWorkspaceHome(workspaceRoot);
  return {
    EOL: '\n',
    arch: () => 'wasm32',
    cpus: () => [],
    endianness: () => 'LE',
    homedir: () => home,
    hostname: () => 'tracevm',
    platform: () => 'browser',
    release: () => '',
    tmpdir: () => '/tmp',
    type: () => 'tracekernel',
    userInfo: () => ({
      username: workspaceUsername(home),
      uid: -1,
      gid: -1,
      shell: null,
      homedir: home,
    }),
  };
}

function createUrlApi() {
  return {
    URL,
    URLSearchParams,
    domainToASCII: (domain: string) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return '';
      }
    },
    domainToUnicode: (domain: string) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return '';
      }
    },
    fileURLToPath: (value: string | URL) => {
      const url = value instanceof URL ? value : new URL(value);
      if (url.protocol !== 'file:') {
        throw new TypeError('The URL must be of scheme file');
      }
      return decodeURIComponent(url.pathname);
    },
    pathToFileURL: (path: string) => new URL(`file://${path.startsWith('/') ? path : `/${path}`}`),
  };
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function workspaceFilename(path: string, workspaceRoot = '/workspace'): string {
  const normalized = normalizeProjectPath(path);
  return normalized ? `${workspaceRoot}/${normalized}` : workspaceRoot;
}

function workspaceFileUrl(path: string, workspaceRoot = '/workspace'): string {
  return `file://${workspaceFilename(path, workspaceRoot).split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function workspaceDirname(path: string, workspaceRoot = '/workspace'): string {
  const normalizedDir = dirname(normalizeProjectPath(path));
  return normalizedDir ? `${workspaceRoot}/${normalizedDir}` : workspaceRoot;
}

function joinModulePath(parentPath: string, specifier: string): string {
  const parentDir = dirname(parentPath);
  const joined = `${parentDir}/${specifier}`.replace(/^\//, '');
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function workspaceCwdPath(request: JavaScriptProjectCommandRequest): string {
  const projectCwd = request.project.cwd ?? '/workspace';
  if (request.cwd === projectCwd) return '';
  if (request.cwd.startsWith(`${projectCwd}/`)) {
    return normalizeProjectPath(request.cwd.slice(projectCwd.length + 1));
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function moduleFileCandidates(path: string): string[] {
  const normalized = normalizeProjectPath(path);
  const candidates = [normalized];
  if (!/\.(?:cjs|js|json|mjs)$/.test(normalized)) {
    candidates.push(`${normalized}.js`, `${normalized}.json`, `${normalized}.mjs`, `${normalized}.cjs`);
  }
  return candidates;
}

function parsePackageJson(modules: Map<string, string>, path: string): PackageMetadata | null {
  const packageJson = modules.get(`${normalizeProjectPath(path)}/package.json`);
  if (!packageJson) return null;

  try {
    return JSON.parse(packageJson) as PackageMetadata;
  } catch {
    return null;
  }
}

function packageExportTarget(value: unknown, condition: PackageResolutionCondition): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  return packageExportTarget(record[condition], condition)
    ?? packageExportTarget(record.node, condition)
    ?? packageExportTarget(record.default, condition)
    ?? packageExportTarget(condition === 'require' ? record.import : record.require, condition);
}

function packageMainCandidates(
  modules: Map<string, string>,
  path: string,
  condition: PackageResolutionCondition
): string[] {
  const normalized = normalizeProjectPath(path);
  const parsed = parsePackageJson(modules, normalized);
  if (!parsed) return [];

  const candidates: string[] = [];
  const exportsTarget = packageExportTarget(parsed.exports, condition);
  if (exportsTarget) {
    candidates.push(...moduleFileCandidates(`${normalized}/${exportsTarget}`));
  }
  if (parsed.exports && typeof parsed.exports === 'object' && !Array.isArray(parsed.exports)) {
    const dotTarget = packageExportTarget((parsed.exports as Record<string, unknown>)['.'], condition);
    if (dotTarget) {
      candidates.push(...moduleFileCandidates(`${normalized}/${dotTarget}`));
    }
  }
  if (typeof parsed.module === 'string' && parsed.module.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.module}`));
  }
  if (typeof parsed.main === 'string' && parsed.main.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.main}`));
  }

  return candidates;
}

function packageSpecifierParts(specifier: string): { packageName: string; subpath: string } | null {
  const parts = normalizeProjectPath(specifier).split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0]?.startsWith('@')) {
    if (parts.length < 2) return null;
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.',
    };
  }
  return {
    packageName: parts[0] ?? '',
    subpath: parts.length > 1 ? `./${parts.slice(1).join('/')}` : '.',
  };
}

function packageExportCandidates(
  modules: Map<string, string>,
  specifier: string,
  condition: PackageResolutionCondition
): string[] {
  const parsedSpecifier = packageLocationForSpecifier(specifier);
  if (!parsedSpecifier) return [];

  const packageRoot = parsedSpecifier.packageRoot;
  const parsed = parsePackageJson(modules, packageRoot);
  if (!parsed?.exports) return [];

  const exportTarget = parsedSpecifier.subpath === '.'
    ? packageExportTarget(parsed.exports, condition)
    : typeof parsed.exports === 'object' && !Array.isArray(parsed.exports)
      ? packageExportTarget((parsed.exports as Record<string, unknown>)[parsedSpecifier.subpath], condition)
      : null;

  if (!exportTarget) {
    return [];
  }

  return moduleFileCandidates(`${packageRoot}/${exportTarget}`);
}

function packageLocationForSpecifier(specifier: string): { packageRoot: string; subpath: string } | null {
  const normalized = normalizeProjectPath(specifier);
  const parts = normalized.split('/').filter(Boolean);
  const nodeModulesIndex = parts.lastIndexOf('node_modules');
  if (nodeModulesIndex !== -1) {
    const packageStart = nodeModulesIndex + 1;
    const first = parts[packageStart];
    if (!first) return null;
    const packageLength = first.startsWith('@') ? 2 : 1;
    const packageParts = parts.slice(packageStart, packageStart + packageLength);
    if (packageParts.length !== packageLength || packageParts.some((part) => !part)) return null;
    const packageRoot = parts.slice(0, packageStart + packageLength).join('/');
    const subpathParts = parts.slice(packageStart + packageLength);
    return {
      packageRoot,
      subpath: subpathParts.length > 0 ? `./${subpathParts.join('/')}` : '.',
    };
  }

  const parsedSpecifier = packageSpecifierParts(normalized);
  if (!parsedSpecifier) return null;
  return {
    packageRoot: `node_modules/${parsedSpecifier.packageName}`,
    subpath: parsedSpecifier.subpath,
  };
}

function moduleCandidates(
  modules: Map<string, string>,
  path: string,
  condition: PackageResolutionCondition
): string[] {
  const normalized = normalizeProjectPath(path);
  return [
    ...packageExportCandidates(modules, normalized, condition),
    ...moduleFileCandidates(normalized),
    ...packageMainCandidates(modules, normalized, condition),
    `${normalized}/index.js`,
    `${normalized}/index.json`,
  ];
}

function nodePathEntries(
  request: JavaScriptProjectCommandRequest,
  cwdPath: string,
  workspace: WorkspacePathContext
): string[] {
  const rawNodePath = request.env.NODE_PATH;
  if (typeof rawNodePath !== 'string' || rawNodePath.trim().length === 0) {
    return [];
  }

  return rawNodePath
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalizeWorkspaceEntryPath(entry, cwdPath, true, workspace))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function packageTypeForPath(modules: Map<string, string>, path: string): string | null {
  const normalized = normalizeProjectPath(path);
  const parts = normalized.split('/');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join('/');
    const parsed = parsePackageJson(modules, directory);
    if (typeof parsed?.type === 'string') return parsed.type;
  }
  return null;
}

function isEsmModule(modules: Map<string, string>, path: string): boolean {
  const normalized = normalizeProjectPath(path);
  if (normalized.endsWith('.mjs')) return true;
  if (normalized.endsWith('.cjs') || normalized.endsWith('.json')) return false;
  return normalized.endsWith('.js') && packageTypeForPath(modules, normalized) === 'module';
}

function toRequireBinding(specifier: string): string {
  return `require(${JSON.stringify(specifier)})`;
}

function toDynamicImportBinding(specifier: string): string {
  return `__import(${JSON.stringify(specifier)})`;
}

function transformDynamicImports(code: string): string {
  return code.replace(
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    (_match, _quote: string, specifier: string) => toDynamicImportBinding(specifier)
  );
}

function defaultImportBinding(name: string, specifier: string, index: number): string {
  const moduleName = `__tracecode_esm_default_${index}`;
  return [
    `const ${moduleName} = ${toRequireBinding(specifier)};`,
    `const ${name} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`,
  ].join(' ');
}

function transformNamedBindings(bindings: string): string {
  return bindings
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [importedName, localName] = part.split(/\s+as\s+/).map((value) => value.trim());
      return localName ? `${importedName}: ${localName}` : importedName;
    })
    .join(', ');
}

function namedExportAssignments(bindings: string, moduleName?: string): string {
  return bindings
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [localName, exportedName] = part.split(/\s+as\s+/).map((value) => value.trim());
      const targetName = exportedName ?? localName;
      const source = moduleName ? `${moduleName}.${localName}` : localName;
      return `exports.${targetName} = ${source};`;
    })
    .join(' ');
}

function transformStaticEsmToCommonJs(code: string, importMetaUrl?: string): string {
  let defaultImportIndex = 0;
  let reExportIndex = 0;
  return transformDynamicImports(code)
    .replace(
      /\bimport\.meta\.url\b/g,
      JSON.stringify(importMetaUrl ?? 'file:///workspace/[eval]')
    )
    .replace(
      /^\s*export\s+\*\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
      (_match, _quote: string, specifier: string) => {
        const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
        return `const ${moduleName} = ${toRequireBinding(specifier)}; for (const __tracecode_key of Object.keys(${moduleName})) { if (__tracecode_key !== "default") exports[__tracecode_key] = ${moduleName}[__tracecode_key]; }`;
      }
    )
    .replace(
      /^\s*export\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
      (_match, namedExports: string, _quote: string, specifier: string) => {
        const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
        return `const ${moduleName} = ${toRequireBinding(specifier)}; ${namedExportAssignments(namedExports, moduleName)}`;
      }
    )
    .replace(
      /^\s*import\s+([\w$]+)\s*,\s*\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/gm,
      (_match, defaultName: string, namespaceName: string, _quote: string, specifier: string) => {
        const required = toRequireBinding(specifier);
        const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
        return `const ${namespaceName} = ${required}; const ${moduleName} = ${namespaceName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
      }
    )
    .replace(
      /^\s*import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/gm,
      (_match, defaultName: string, namedImports: string, _quote: string, specifier: string) => {
        const required = toRequireBinding(specifier);
        const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
        return `const ${moduleName} = ${required}; const { ${transformNamedBindings(namedImports)} } = ${moduleName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
      }
    )
    .replace(
      /^\s*import\s+\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
      (_match, namespaceName: string, _quote: string, specifier: string) =>
        `const ${namespaceName} = ${toRequireBinding(specifier)};`
    )
    .replace(
      /\bimport\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?/g,
      (_match, namedImports: string, _quote: string, specifier: string) =>
        `const { ${transformNamedBindings(namedImports)} } = ${toRequireBinding(specifier)};`
    )
    .replace(
      /^\s*import\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
      (_match, defaultName: string, _quote: string, specifier: string) =>
        defaultImportBinding(defaultName, specifier, defaultImportIndex++)
    )
    .replace(
      /^\s*import\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
      (_match, _quote: string, specifier: string) => `${toRequireBinding(specifier)};`
    )
    .replace(
      /^\s*export\s+function\s+([\w$]+)\s*\(/gm,
      (_match, name: string) => `exports.${name} = function ${name}(`
    )
    .replace(
      /^\s*export\s+class\s+([\w$]+)\s*/gm,
      (_match, name: string) => `exports.${name} = class ${name} `
    )
    .replace(
      /^\s*export\s+(const|let|var)\s+([\w$]+)\s*=/gm,
      (_match, declaration: string, name: string) => `${declaration} ${name} = exports.${name} =`
    )
    .replace(
      /^\s*export\s+default\s+/gm,
      'exports.default = '
    )
    .replace(
      /^\s*export\s+\{([^}]+)\}\s*;?\s*$/gm,
      (_match, namedExports: string) => namedExportAssignments(namedExports)
    );
}

function resolveModulePath(
  modules: Map<string, string>,
  specifier: string,
  parentPath: string,
  nodePathSearchEntries: readonly string[] = [],
  condition: PackageResolutionCondition = 'require'
): string {
  const basePaths = specifier.startsWith('.')
    ? [joinModulePath(parentPath, specifier)]
    : [
        ...nodeModulesSearchPaths(parentPath, specifier),
        specifier,
        ...nodePathSearchEntries.map((entry) => entry ? `${entry}/${specifier}` : specifier),
      ];

  for (const basePath of basePaths) {
    for (const candidate of moduleCandidates(modules, basePath, condition)) {
      if (modules.has(candidate)) return candidate;
    }
  }

  throw new Error(`Cannot find module '${specifier}'`);
}

function nodeModulesSearchPaths(parentPath: string, specifier: string): string[] {
  const parentDirectory = dirname(normalizeProjectPath(parentPath));
  const parts = parentDirectory ? parentDirectory.split('/').filter(Boolean) : [];
  const paths: string[] = [];

  for (let index = parts.length; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join('/');
    paths.push(directory ? `${directory}/node_modules/${specifier}` : `node_modules/${specifier}`);
  }

  return paths;
}

function moduleSearchPaths(parentPath: string, workspaceRoot = '/workspace'): string[] {
  return nodeModulesSearchPaths(parentPath, '').map((path) => workspaceFilename(path.replace(/\/$/, ''), workspaceRoot));
}

function formatConsoleValues(values: unknown[]): string {
  return values
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack ?? value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

function processArgvForRequest(request: JavaScriptProjectCommandRequest): string[] {
  if (request.source === 'argument') {
    return ['node', ...request.args];
  }

  if (request.source === 'stdin') {
    return ['node', '-', ...request.args];
  }

  return ['node', request.scriptPath, ...request.args];
}

function requireModulesForRequest(request: JavaScriptProjectCommandRequest): string[] {
  return Array.isArray(request.options?.require)
    ? request.options.require.filter((item): item is string => typeof item === 'string')
    : [];
}

export function createBrowserJavaScriptProjectRunner(
  options: BrowserJavaScriptProjectRunnerOptions = {}
): JavaScriptProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (request) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const execution = runBrowserJavaScriptProjectRequest(request, options).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
    const timeout = new Promise<RuntimeCommandResult>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({
          stdout: '',
          stderr: `node: execution timed out after ${timeoutMs}ms\n`,
          exitCode: 124,
        });
      }, timeoutMs);
    });
    return Promise.race([execution, timeout]);
  };
}

async function runBrowserJavaScriptProjectRequest(
  request: JavaScriptProjectCommandRequest,
  options: BrowserJavaScriptProjectRunnerOptions
): Promise<RuntimeCommandResult> {
    if (options.allowDynamicEval === false) {
      return {
        stdout: '',
        stderr: 'node: browser JavaScript project runner requires dynamic evaluation\n',
        exitCode: 1,
      };
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = createRuntimeProjectIoBridge(request.onEvent);
    const workspacePathContext = createWorkspacePathContext(request.project);
    const workspaceRoot = workspacePathContext.root;
    const cwdPath = workspaceCwdPath(request);
    const fileStore = new Map(
      request.project.files.map((file) => [assertSafeWorkspaceFilePath(file.path, '', workspacePathContext), fileBytes(file)])
    );
    const directoryStore = new Set<string>(['']);
    for (const filePath of fileStore.keys()) {
      const parts = filePath.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        directoryStore.add(parts.slice(0, index).join('/'));
      }
    }
    for (const directory of request.project.directories ?? []) {
      const directoryPath = normalizeWorkspaceEntryPath(directory, '', true, workspacePathContext);
      if (!directoryPath) continue;
      const parts = directoryPath.split('/');
      for (let index = 1; index <= parts.length; index += 1) {
        directoryStore.add(parts.slice(0, index).join('/'));
      }
    }
    type BrowserEntryMetadata = {
      atimeMs: number;
      birthtimeMs: number;
      ctimeMs: number;
      gid: number;
      mode?: number;
      mtimeMs: number;
      uid: number;
    };
    let fsTimestampMs = 1;
    const createEntryMetadata = (mode?: number): BrowserEntryMetadata => ({
      atimeMs: fsTimestampMs,
      birthtimeMs: fsTimestampMs,
      ctimeMs: fsTimestampMs,
      gid: 0,
      mode,
      mtimeMs: fsTimestampMs,
      uid: 0,
    });
    const entryMetadata = new Map<string, BrowserEntryMetadata>(
      Array.from(fileStore.keys()).map((filePath) => [filePath, createEntryMetadata(0o100644)])
    );
    for (const directoryPath of directoryStore) {
      if (!entryMetadata.has(directoryPath)) {
        entryMetadata.set(directoryPath, createEntryMetadata(0o40755));
      }
    }
    const touchEntryMetadata = (path: string): void => {
      fsTimestampMs += 1;
      const previous = entryMetadata.get(path);
      entryMetadata.set(path, {
        atimeMs: previous?.atimeMs ?? fsTimestampMs,
        birthtimeMs: previous?.birthtimeMs ?? fsTimestampMs,
        ctimeMs: fsTimestampMs,
        gid: previous?.gid ?? 0,
        mode: previous?.mode,
        mtimeMs: fsTimestampMs,
        uid: previous?.uid ?? 0,
      });
    };
    const updateEntryMetadata = (path: string, update: Partial<BrowserEntryMetadata>): void => {
      fsTimestampMs += 1;
      const previous = entryMetadata.get(path) ?? createEntryMetadata();
      entryMetadata.set(path, {
        ...previous,
        ...update,
        ctimeMs: fsTimestampMs,
      });
    };
    const deleteEntryMetadata = (path: string): void => {
      fsTimestampMs += 1;
      entryMetadata.delete(path);
    };
    const originalFiles = new Map(fileStore);
    const modules = new Map(
      request.project.files
        .filter((file) => file.encoding !== 'base64')
        .map((file) => [assertSafeWorkspaceFilePath(file.path, '', workspacePathContext), file.contents])
    );
    const cache = new Map<string, ModuleRecord>();
    const requireCache: Record<string, ModuleRecord> = {};
    let mainModule: ModuleRecord | undefined;

    const emitOutput = (stream: 'stdout' | 'stderr', data: string, device?: RuntimeKernelDevicePath): void => {
      if (stream === 'stdout') {
        stdout.push(data);
      } else {
        stderr.push(data);
      }
      io.output(stream, data, device);
    };

    const writeDevice = (device: RuntimeKernelDevicePath, data: string): void => {
      if (device === '/dev/stdin') {
        throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
      }
      const outputDevice = device === '/dev/tty' ? '/dev/stdout' : device;
      emitOutput(outputDevice === '/dev/stderr' ? 'stderr' : 'stdout', data, outputDevice);
    };

    const readDevice = (device: RuntimeKernelDevicePath): string => {
      if (device === '/dev/stdin' || device === '/dev/tty') return request.stdin;
      return '';
    };

    const consoleApi = {
      log: (...values: unknown[]) => {
        emitOutput('stdout', `${formatConsoleValues(values)}\n`);
      },
      error: (...values: unknown[]) => {
        emitOutput('stderr', `${formatConsoleValues(values)}\n`);
      },
    };

    const createWritableDevice = (device: RuntimeKernelDevicePath, fd: number) => ({
      fd,
      writable: true,
      isTTY: false,
      write: (value: unknown, encoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
        const data = textFromBytes(bytesFromFsWriteValue(value, typeof encoding === 'string' ? encoding : undefined));
        writeDevice(device, data);
        const done = typeof encoding === 'function' ? encoding : callback;
        done?.(null);
        return true;
      },
    });

    const stdinDevice = createReadableStdinDevice(request.stdin);
    const processApi = {
      argv: processArgvForRequest(request),
      env: request.env,
      cwd: () => request.cwd,
      stdin: stdinDevice,
      stdout: createWritableDevice('/dev/stdout', 1),
      stderr: createWritableDevice('/dev/stderr', 2),
      exit: (code = 0) => {
        throw Object.assign(new Error(`process.exit(${code})`), {
          exitCode: Number(code) || 0,
          suppressStderr: true,
        });
      },
    };
    const nodePathSearchEntries = nodePathEntries(request, cwdPath, workspacePathContext);
    const syncTextModule = (path: string, bytes: Uint8Array): void => {
      const text = textFromBytes(bytes);
      if (byteEqual(utf8Bytes(text), bytes)) {
        modules.set(path, text);
      } else {
        modules.delete(path);
      }
    };
    type BrowserFsWatcher = {
      path: string;
      recursive: boolean;
      closed: boolean;
      listeners: Map<string, Array<(...args: unknown[]) => void>>;
    };
    type BrowserFileStat = {
      atime: Date;
      atimeMs: number;
      birthtime: Date;
      birthtimeMs: number;
      blksize: number;
      blocks: number;
      ctime: Date;
      ctimeMs: number;
      dev: number;
      gid: number;
      ino: number;
      mode: number;
      mtime: Date;
      mtimeMs: number;
      nlink: number;
      rdev: number;
      size: number;
      uid: number;
      isBlockDevice: () => boolean;
      isCharacterDevice: () => boolean;
      isFIFO: () => boolean;
      isFile: () => boolean;
      isDirectory: () => boolean;
      isSocket: () => boolean;
      isSymbolicLink: () => boolean;
    };
    type BrowserFileWatcher = {
      path: string;
      listener: (curr: BrowserFileStat, prev: BrowserFileStat) => void;
      previous: BrowserFileStat;
    };
    const fsWatchers = new Set<BrowserFsWatcher>();
    const fsFileWatchers = new Set<BrowserFileWatcher>();
    const inodeForPath = (path: string): number => {
      let hash = 2166136261;
      for (let index = 0; index < path.length; index += 1) {
        hash ^= path.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0) || 1;
    };
    const statForNormalizedPath = (normalized: string): BrowserFileStat | null => {
      const isFile = fileStore.has(normalized);
      const prefix = normalized ? `${normalized}/` : '';
      const isDirectory = !isFile && (
        directoryStore.has(normalized) ||
        Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix))
      );
      if (!isFile && !isDirectory) return null;
      const metadata = entryMetadata.get(normalized) ?? createEntryMetadata(isDirectory ? 0o40755 : 0o100644);
      const size = isFile ? fileStore.get(normalized)?.byteLength ?? 0 : 0;
      const mode = metadata.mode ?? (isDirectory ? 0o40755 : 0o100644);
      return {
        atimeMs: metadata.atimeMs,
        birthtimeMs: metadata.birthtimeMs,
        blksize: 4096,
        blocks: Math.ceil(size / 512),
        ctimeMs: metadata.ctimeMs,
        dev: 1,
        gid: metadata.gid,
        ino: inodeForPath(normalized),
        mode,
        mtimeMs: metadata.mtimeMs,
        nlink: isDirectory ? 2 : 1,
        rdev: 0,
        size,
        uid: metadata.uid,
        atime: new Date(metadata.atimeMs),
        birthtime: new Date(metadata.birthtimeMs),
        ctime: new Date(metadata.ctimeMs),
        mtime: new Date(metadata.mtimeMs),
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isFile: () => isFile,
        isDirectory: () => isDirectory,
        isSocket: () => false,
        isSymbolicLink: () => false,
      };
    };
    const missingFileStat = (): BrowserFileStat => ({
      atime: new Date(0),
      atimeMs: 0,
      birthtime: new Date(0),
      birthtimeMs: 0,
      blksize: 4096,
      blocks: 0,
      ctime: new Date(0),
      ctimeMs: 0,
      dev: 1,
      gid: 0,
      ino: 0,
      mode: 0,
      mtime: new Date(0),
      mtimeMs: 0,
      nlink: 0,
      rdev: 0,
      size: 0,
      uid: 0,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isFile: () => false,
      isDirectory: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
    });
    const watchedFilename = (watcher: BrowserFsWatcher, changedPath: string): string | null => {
      if (changedPath === watcher.path) return changedPath.split('/').pop() ?? changedPath;
      const prefix = watcher.path ? `${watcher.path}/` : '';
      if (!changedPath.startsWith(prefix)) return null;
      const relative = changedPath.slice(prefix.length);
      if (!watcher.recursive && relative.includes('/')) return null;
      return relative;
    };
    const emitFsWatch = (watcher: BrowserFsWatcher, eventType: 'change' | 'rename', filename: string): void => {
      if (watcher.closed) return;
      for (const listener of watcher.listeners.get('change') ?? []) listener(eventType, filename);
    };
    const notifyFsWatchers = (eventType: 'change' | 'rename', path: string): void => {
      for (const watcher of fsWatchers) {
        const filename = watchedFilename(watcher, path);
        if (filename !== null) queueMicrotask(() => emitFsWatch(watcher, eventType, filename));
      }
    };
    const notifyWatchFileWatchers = (path: string): void => {
      for (const watcher of fsFileWatchers) {
        if (watcher.path !== path) continue;
        const previous = watcher.previous;
        const current = statForNormalizedPath(path) ?? missingFileStat();
        watcher.previous = current;
        queueMicrotask(() => watcher.listener(current, previous));
      }
    };
    const notifyDirectoryMutation = (path: string): void => {
      notifyFsWatchers('rename', path);
      notifyWatchFileWatchers(path);
    };
    const setFileBytes = (path: string, bytes: Uint8Array): void => {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join('/');
        directoryStore.add(directoryPath);
        if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
      }
      fileStore.set(path, bytes);
      touchEntryMetadata(path);
      syncTextModule(path, bytes);
      cache.delete(path);
      io.fileChange(bytesToRuntimeFile(path, bytes), 'live');
      notifyFsWatchers('change', path);
      notifyWatchFileWatchers(path);
    };
    const createEventTarget = () => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const on = (event: string, listener: (...args: unknown[]) => void): void => {
        const next = listeners.get(event) ?? [];
        next.push(listener);
        listeners.set(event, next);
      };
      return {
        emit: (event: string, ...args: unknown[]) => {
          for (const listener of listeners.get(event) ?? []) listener(...args);
        },
        on,
        once: (event: string, listener: (...args: unknown[]) => void) => {
          const wrapped = (...args: unknown[]) => {
            const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped);
            listeners.set(event, next);
            listener(...args);
          };
          on(event, wrapped);
        },
      };
    };
    const createReadableStream = (bytes: Uint8Array, encoding?: string) => {
      const events = createEventTarget();
      let started = false;
      const formatChunk = (chunk: Uint8Array): BrowserBuffer | string => {
        const buffer = BrowserBuffer.from(chunk);
        return encoding ? buffer.toString(encoding) : buffer;
      };
      const scheduleRead = (): void => {
        if (started) return;
        started = true;
        queueMicrotask(() => {
          if (bytes.byteLength > 0) events.emit('data', formatChunk(bytes));
          events.emit('end');
          events.emit('close');
        });
      };
      const stream = {
        readable: true,
        on: (event: string, listener: (...args: unknown[]) => void) => {
          events.on(event, listener);
          if (event === 'data' || event === 'end') scheduleRead();
          return stream;
        },
        once: (event: string, listener: (...args: unknown[]) => void) => {
          events.once(event, listener);
          if (event === 'data' || event === 'end') scheduleRead();
          return stream;
        },
        pipe: (destination: { write?: (chunk: BrowserBuffer | string) => unknown; end?: () => unknown }) => {
          stream.on('data', (chunk) => destination.write?.(chunk as BrowserBuffer | string));
          stream.on('end', () => destination.end?.());
          return destination;
        },
      };
      return stream;
    };
    const createWritableStream = (
      path: unknown,
      options?: string | { encoding?: string | null; flags?: string } | null
    ) => {
      const events = createEventTarget();
      const device = normalizeRuntimeDevicePath(path);
      const encoding = requestedEncodingFromOptions(options);
      const flags = typeof options === 'object' && typeof options?.flags === 'string' ? options.flags : 'w';
      const normalized = device ? null : assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      if (normalized !== null && !flags.includes('a')) {
        setFileBytes(normalized, new Uint8Array());
      }
      const writeBytes = (value: unknown, writeEncoding?: string): void => {
        const bytes = bytesFromFsWriteValue(value, writeEncoding ?? encoding);
        if (device) {
          writeDevice(device, textFromBytes(bytes));
          return;
        }
        const previous = fileStore.get(normalized ?? '') ?? new Uint8Array();
        const combined = new Uint8Array(previous.byteLength + bytes.byteLength);
        combined.set(previous, 0);
        combined.set(bytes, previous.byteLength);
        setFileBytes(normalized ?? '', combined);
      };
      let closed = false;
      const stream = {
        writable: true,
        on: (event: string, listener: (...args: unknown[]) => void) => {
          events.on(event, listener);
          return stream;
        },
        once: (event: string, listener: (...args: unknown[]) => void) => {
          events.once(event, listener);
          return stream;
        },
        write: (value: unknown, writeEncoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
          writeBytes(value, typeof writeEncoding === 'string' ? writeEncoding : undefined);
          const done = typeof writeEncoding === 'function' ? writeEncoding : callback;
          done?.(null);
          return true;
        },
        end: (value?: unknown, writeEncoding?: string | (() => void), callback?: () => void) => {
          if (value !== undefined && value !== null) {
            writeBytes(value, typeof writeEncoding === 'string' ? writeEncoding : undefined);
          }
          const done = typeof writeEncoding === 'function' ? writeEncoding : callback;
          if (!closed) {
            closed = true;
            queueMicrotask(() => {
              done?.();
              events.emit('finish');
              events.emit('close');
            });
          }
          return stream;
        },
      };
      return stream;
    };
    const deleteFile = (path: unknown): void => {
      const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      if (!fileStore.delete(normalized)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${path}'`), { code: 'ENOENT' });
      }
      modules.delete(normalized);
      cache.delete(normalized);
      deleteEntryMetadata(normalized);
      io.fileChange({ path: normalized, deleted: true }, 'live');
      notifyFsWatchers('rename', normalized);
      notifyWatchFileWatchers(normalized);
    };
    const fsConstants = {
      F_OK: 0,
      R_OK: 4,
      W_OK: 2,
      X_OK: 1,
      COPYFILE_EXCL: 1,
      COPYFILE_FICLONE: 2,
      COPYFILE_FICLONE_FORCE: 4,
    } as const;
    let mkdtempCounter = 0;
    const fileSystemEntryExists = (path: unknown): boolean => {
      const device = normalizeRuntimeDevicePath(path);
      if (device) return true;
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      const prefix = normalized ? `${normalized}/` : '';
      return fileStore.has(normalized)
        || directoryStore.has(normalized)
        || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
    };
    const assertFileSystemAccess = (path: unknown, mode: number = fsConstants.F_OK): void => {
      const device = normalizeRuntimeDevicePath(path);
      if (device) {
        const requested = Number(mode) || fsConstants.F_OK;
        const readable = device === '/dev/stdin' || device === '/dev/tty';
        const writable = device === '/dev/stdout' || device === '/dev/stderr' || device === '/dev/tty';
        if (((requested & fsConstants.R_OK) !== 0 && !readable) || ((requested & fsConstants.W_OK) !== 0 && !writable)) {
          throw Object.assign(new Error(`EACCES: permission denied, access '${path}'`), { code: 'EACCES' });
        }
        return;
      }
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      const stats = statForNormalizedPath(normalized);
      if (!stats) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: 'ENOENT' });
      }
      const requested = Number(mode) || fsConstants.F_OK;
      const permissionMode = stats.mode & 0o777;
      const readable = (permissionMode & 0o444) !== 0;
      const writable = (permissionMode & 0o222) !== 0;
      const executable = (permissionMode & 0o111) !== 0;
      if (
        ((requested & fsConstants.R_OK) !== 0 && !readable) ||
        ((requested & fsConstants.W_OK) !== 0 && !writable) ||
        ((requested & fsConstants.X_OK) !== 0 && !executable)
      ) {
        throw Object.assign(new Error(`EACCES: permission denied, access '${path}'`), { code: 'EACCES' });
      }
    };
    const notifyMetadataMutation = (path: string): void => {
      notifyFsWatchers('change', path);
      notifyWatchFileWatchers(path);
    };
    const metadataPathForEntry = (path: unknown): string | null => {
      if (normalizeRuntimeDevicePath(path)) return null;
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
      }
      return normalized;
    };
    const timeToMs = (value: unknown): number => {
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'number') return Math.max(0, value * 1000);
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, parsed * 1000) : fsTimestampMs;
    };
    type BrowserFileDescriptor = {
      kind: 'file' | 'device';
      path?: string;
      device?: RuntimeKernelDevicePath;
      offset: number;
      readable: boolean;
      writable: boolean;
      append: boolean;
    };
    const fileDescriptors = new Map<number, BrowserFileDescriptor>([
      [0, { kind: 'device', device: '/dev/stdin', offset: 0, readable: true, writable: false, append: false }],
      [1, { kind: 'device', device: '/dev/stdout', offset: 0, readable: false, writable: true, append: true }],
      [2, { kind: 'device', device: '/dev/stderr', offset: 0, readable: false, writable: true, append: true }],
    ]);
    let nextFd = 3;
    const parseOpenFlags = (flags: unknown = 'r') => {
      const text = typeof flags === 'number' ? (flags === 0 ? 'r' : flags === 1 ? 'w' : flags === 2 ? 'r+' : 'r') : String(flags);
      return {
        readable: text.includes('+') || text.startsWith('r'),
        writable: text.includes('+') || text.startsWith('w') || text.startsWith('a'),
        append: text.startsWith('a'),
        truncate: text.startsWith('w'),
        create: text.startsWith('w') || text.startsWith('a'),
      };
    };
    const fileDescriptor = (fd: number): BrowserFileDescriptor => {
      const entry = fileDescriptors.get(Number(fd));
      if (!entry) throw Object.assign(new Error(`EBADF: bad file descriptor, fd ${fd}`), { code: 'EBADF' });
      return entry;
    };
    const descriptorBytes = (entry: BrowserFileDescriptor): Uint8Array => {
      if (entry.kind === 'device') return utf8Bytes(readDevice(entry.device ?? '/dev/stdin'));
      return fileStore.get(entry.path ?? '') ?? new Uint8Array();
    };
    const writeDescriptorBytes = (entry: BrowserFileDescriptor, bytes: Uint8Array, position?: number | null): void => {
      if (!entry.writable) throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
      if (entry.kind === 'device') {
        writeDevice(entry.device ?? '/dev/stdout', textFromBytes(bytes));
        return;
      }
      const previous = fileStore.get(entry.path ?? '') ?? new Uint8Array();
      const start = entry.append ? previous.byteLength : typeof position === 'number' ? Math.max(0, position) : entry.offset;
      const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
      next.set(previous, 0);
      next.set(bytes, start);
      setFileBytes(entry.path ?? '', next);
      if (position === undefined || position === null) entry.offset = start + bytes.byteLength;
    };
    const truncateFileBytes = (path: string, length = 0): void => {
      const previous = fileStore.get(path);
      if (!previous) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, truncate '${path}'`), { code: 'ENOENT' });
      }
      const size = Math.max(0, Number(length) || 0);
      const next = new Uint8Array(size);
      next.set(previous.slice(0, Math.min(previous.byteLength, size)));
      setFileBytes(path, next);
    };
    const realpathForEntry = (path: unknown): string => {
      const device = normalizeRuntimeDevicePath(path);
      if (device) return device;
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
      }
      return workspaceFilename(normalized, workspaceRoot);
    };
    const copyEntrySync = (
      source: unknown,
      destination: unknown,
      options: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean } = {}
    ): void => {
      const sourceDevice = normalizeRuntimeDevicePath(source);
      const destinationDevice = normalizeRuntimeDevicePath(destination);
      if (sourceDevice || destinationDevice) {
        fsApi.copyFileSync(source, destination);
        return;
      }

      const normalizedSource = normalizeWorkspaceEntryPath(source, cwdPath, true, workspacePathContext);
      const normalizedDestination = normalizeWorkspaceEntryPath(destination, cwdPath, true, workspacePathContext);
      const sourcePath = workspaceFilename(normalizedSource, workspaceRoot);
      const destinationPath = workspaceFilename(normalizedDestination, workspaceRoot);
      if (options.filter && !options.filter(sourcePath, destinationPath)) return;

      const destinationExists = fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination);
      if (destinationExists && options.force === false) {
        if (options.errorOnExist) {
          throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: 'EEXIST' });
        }
        return;
      }

      const sourceBytes = fileStore.get(normalizedSource);
      if (sourceBytes) {
        setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
        return;
      }

      const sourcePrefix = normalizedSource ? `${normalizedSource}/` : '';
      const descendantFiles = Array.from(fileStore.entries()).filter(([filePath]) => filePath.startsWith(sourcePrefix));
      const descendantDirectories = Array.from(directoryStore).filter((directoryPath) =>
        directoryPath === normalizedSource || directoryPath.startsWith(sourcePrefix)
      );
      if (!directoryStore.has(normalizedSource) && descendantFiles.length === 0 && descendantDirectories.length === 0) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, cp '${source}' -> '${destination}'`), { code: 'ENOENT' });
      }
      if (!options.recursive) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, cp '${source}'`), { code: 'EISDIR' });
      }

      directoryStore.add(normalizedDestination);
      for (const directoryPath of descendantDirectories) {
        const relative = directoryPath === normalizedSource ? '' : directoryPath.slice(sourcePrefix.length);
        const nextDirectory = relative ? `${normalizedDestination}/${relative}` : normalizedDestination;
        if (options.filter && !options.filter(workspaceFilename(directoryPath, workspaceRoot), workspaceFilename(nextDirectory, workspaceRoot))) {
          continue;
        }
        directoryStore.add(nextDirectory);
      }
      for (const [filePath, bytes] of descendantFiles) {
        const relative = filePath.slice(sourcePrefix.length);
        const nextPath = normalizedDestination ? `${normalizedDestination}/${relative}` : relative;
        if (options.filter && !options.filter(workspaceFilename(filePath, workspaceRoot), workspaceFilename(nextPath, workspaceRoot))) {
          continue;
        }
        setFileBytes(nextPath, new Uint8Array(bytes));
      }
    };
    const fsApi = {
      constants: fsConstants,
      F_OK: fsConstants.F_OK,
      R_OK: fsConstants.R_OK,
      W_OK: fsConstants.W_OK,
      X_OK: fsConstants.X_OK,
      COPYFILE_EXCL: fsConstants.COPYFILE_EXCL,
      COPYFILE_FICLONE: fsConstants.COPYFILE_FICLONE,
      COPYFILE_FICLONE_FORCE: fsConstants.COPYFILE_FICLONE_FORCE,
      accessSync: (path: unknown, mode = fsConstants.F_OK) => {
        assertFileSystemAccess(path, mode);
      },
      access: (path: unknown, mode?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof mode === 'function' ? mode : callback;
        try {
          assertFileSystemAccess(path, typeof mode === 'number' ? mode : fsConstants.F_OK);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      chmodSync: (path: unknown, mode: unknown) => {
        const normalized = metadataPathForEntry(path);
        if (normalized !== null) {
          const stats = statForNormalizedPath(normalized);
          const typeMode = stats?.isDirectory() ? 0o40000 : 0o100000;
          updateEntryMetadata(normalized, { mode: typeMode | (Number(mode) & 0o7777) });
          notifyMetadataMutation(normalized);
        }
        return undefined;
      },
      chmod: (path: unknown, mode: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.chmodSync(path, mode);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      chownSync: (path: unknown, uid: unknown, gid: unknown) => {
        const normalized = metadataPathForEntry(path);
        if (normalized !== null) {
          updateEntryMetadata(normalized, { uid: Number(uid) || 0, gid: Number(gid) || 0 });
          notifyMetadataMutation(normalized);
        }
        return undefined;
      },
      chown: (path: unknown, uid: unknown, gid: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.chownSync(path, uid, gid);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      utimesSync: (path: unknown, atime: unknown, mtime: unknown) => {
        const normalized = metadataPathForEntry(path);
        if (normalized !== null) {
          updateEntryMetadata(normalized, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
          notifyMetadataMutation(normalized);
        }
        return undefined;
      },
      utimes: (path: unknown, atime: unknown, mtime: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.utimesSync(path, atime, mtime);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      watch: (
        path: unknown,
        optionsOrListener?: { recursive?: boolean } | string | ((eventType: string, filename: string) => void),
        listener?: (eventType: string, filename: string) => void
      ) => {
        assertFileSystemAccess(path);
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        const on = (event: string, callback: (...args: unknown[]) => void): void => {
          const next = listeners.get(event) ?? [];
          next.push(callback);
          listeners.set(event, next);
        };
        const watcher: BrowserFsWatcher = {
          path: normalized,
          recursive: typeof optionsOrListener === 'object' && optionsOrListener?.recursive === true,
          closed: false,
          listeners,
        };
        const initialListener = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
        if (initialListener) on('change', initialListener as (...args: unknown[]) => void);
        fsWatchers.add(watcher);
        const api = {
          on: (event: string, callback: (...args: unknown[]) => void) => {
            on(event, callback);
            return api;
          },
          once: (event: string, callback: (...args: unknown[]) => void) => {
            const wrapped = (...args: unknown[]) => {
              const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped);
              listeners.set(event, next);
              callback(...args);
            };
            on(event, wrapped);
            return api;
          },
          close: () => {
            watcher.closed = true;
            fsWatchers.delete(watcher);
            for (const closeListener of listeners.get('close') ?? []) closeListener();
          },
        };
        return api;
      },
      watchFile: (
        path: unknown,
        optionsOrListener?: { interval?: number; persistent?: boolean } | ((curr: BrowserFileStat, prev: BrowserFileStat) => void),
        listener?: (curr: BrowserFileStat, prev: BrowserFileStat) => void
      ) => {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        const changeListener = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
        if (!changeListener) {
          throw new TypeError('The "listener" argument must be of type function');
        }
        const watcher: BrowserFileWatcher = {
          path: normalized,
          listener: changeListener,
          previous: statForNormalizedPath(normalized) ?? missingFileStat(),
        };
        fsFileWatchers.add(watcher);
        const api = {
          ref: () => api,
          unref: () => api,
          close: () => {
            fsFileWatchers.delete(watcher);
          },
          on: (_event: string, nextListener: (curr: BrowserFileStat, prev: BrowserFileStat) => void) => {
            if (typeof nextListener === 'function') watcher.listener = nextListener;
            return api;
          },
          addListener: (_event: string, nextListener: (curr: BrowserFileStat, prev: BrowserFileStat) => void) => {
            if (typeof nextListener === 'function') watcher.listener = nextListener;
            return api;
          },
          removeListener: () => api,
        };
        return api;
      },
      unwatchFile: (
        path: unknown,
        listener?: (curr: BrowserFileStat, prev: BrowserFileStat) => void
      ) => {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        for (const watcher of Array.from(fsFileWatchers)) {
          if (watcher.path === normalized && (!listener || watcher.listener === listener)) {
            fsFileWatchers.delete(watcher);
          }
        }
      },
      openSync: (path: unknown, flags: unknown = 'r') => {
        const device = normalizeRuntimeDevicePath(path);
        const parsed = parseOpenFlags(flags);
        const fd = nextFd++;
        if (device) {
          fileDescriptors.set(fd, {
            kind: 'device',
            device,
            offset: 0,
            readable: device === '/dev/stdin' || device === '/dev/tty' || parsed.readable,
            writable: device !== '/dev/stdin' && parsed.writable,
            append: true,
          });
          return fd;
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        if (!fileStore.has(normalized)) {
          if (!parsed.create) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
          }
          setFileBytes(normalized, new Uint8Array());
        } else if (parsed.truncate) {
          setFileBytes(normalized, new Uint8Array());
        }
        fileDescriptors.set(fd, {
          kind: 'file',
          path: normalized,
          offset: parsed.append ? fileStore.get(normalized)?.byteLength ?? 0 : 0,
          readable: parsed.readable,
          writable: parsed.writable,
          append: parsed.append,
        });
        return fd;
      },
      open: (path: unknown, flags?: unknown, modeOrCallback?: unknown, callback?: (error: Error | null, fd?: number) => void) => {
        const done = typeof flags === 'function'
          ? flags as (error: Error | null, fd?: number) => void
          : typeof modeOrCallback === 'function'
            ? modeOrCallback as (error: Error | null, fd?: number) => void
            : callback;
        const openFlags = typeof flags === 'function' || flags === undefined ? 'r' : flags;
        try {
          const fd = fsApi.openSync(path, openFlags);
          queueMicrotask(() => done?.(null, fd));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      closeSync: (fd: number) => {
        if (Number(fd) < 3) return undefined;
        if (!fileDescriptors.delete(Number(fd))) {
          throw Object.assign(new Error(`EBADF: bad file descriptor, close`), { code: 'EBADF' });
        }
        return undefined;
      },
      close: (fd: number, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.closeSync(fd);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      readSync: (fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position?: number | null) => {
        const entry = fileDescriptor(fd);
        if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
        const source = descriptorBytes(entry);
        const start = typeof position === 'number' ? Math.max(0, position) : entry.offset;
        const count = Math.max(0, Math.min(length, source.byteLength - start, buffer.byteLength - offset));
        buffer.set(source.slice(start, start + count), offset);
        if (position === undefined || position === null) entry.offset = start + count;
        return count;
      },
      read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: (error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void) => {
        try {
          const bytesRead = fsApi.readSync(fd, buffer, offset, length, position);
          queueMicrotask(() => callback(null, bytesRead, buffer));
        } catch (error) {
          queueMicrotask(() => callback(error as Error, undefined, buffer));
        }
      },
      readvSync: (fd: number, buffers: Uint8Array[], position?: number | null) => {
        let bytesRead = 0;
        let nextPosition = typeof position === 'number' ? Math.max(0, position) : position;
        for (const buffer of buffers) {
          const count = fsApi.readSync(fd, buffer, 0, buffer.byteLength, nextPosition);
          bytesRead += count;
          if (typeof nextPosition === 'number') nextPosition += count;
          if (count === 0) break;
        }
        return bytesRead;
      },
      readv: (
        fd: number,
        buffers: Uint8Array[],
        positionOrCallback?: number | null | ((error: Error | null, bytesRead?: number, buffers?: Uint8Array[]) => void),
        callback?: (error: Error | null, bytesRead?: number, buffers?: Uint8Array[]) => void
      ) => {
        const done = typeof positionOrCallback === 'function' ? positionOrCallback : callback;
        const position = typeof positionOrCallback === 'function' ? undefined : positionOrCallback;
        try {
          const bytesRead = fsApi.readvSync(fd, buffers, position);
          queueMicrotask(() => done?.(null, bytesRead, buffers));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error, undefined, buffers));
        }
      },
      writeSync: (fd: number, value: unknown, offsetOrPosition?: number, lengthOrEncoding?: number | string, position?: number | null) => {
        let bytes: Uint8Array;
        let writePosition: number | null | undefined = position;
        if (typeof value === 'string') {
          bytes = BrowserBuffer.from(value, typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined);
          writePosition = typeof offsetOrPosition === 'number' ? offsetOrPosition : undefined;
        } else {
          const source = bytesFromNodeValue(value);
          const offset = typeof offsetOrPosition === 'number' ? offsetOrPosition : 0;
          const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : source.byteLength - offset;
          bytes = source.slice(offset, offset + length);
        }
        writeDescriptorBytes(fileDescriptor(fd), bytes, writePosition);
        return bytes.byteLength;
      },
      write: (
        fd: number,
        value: unknown,
        offsetOrPosition?: number | ((error: Error | null, written?: number, value?: unknown) => void),
        lengthOrEncoding?: number | string | ((error: Error | null, written?: number, value?: unknown) => void),
        positionOrCallback?: number | null | ((error: Error | null, written?: number, value?: unknown) => void),
        callback?: (error: Error | null, written?: number, value?: unknown) => void
      ) => {
        const done = typeof offsetOrPosition === 'function'
          ? offsetOrPosition
          : typeof lengthOrEncoding === 'function'
            ? lengthOrEncoding
            : typeof positionOrCallback === 'function'
              ? positionOrCallback
              : callback;
        let writePosition: number | null | undefined;
        if (typeof positionOrCallback === 'number') {
          writePosition = positionOrCallback;
        } else if (positionOrCallback === null) {
          writePosition = null;
        }
        try {
          const written = fsApi.writeSync(
            fd,
            value,
            typeof offsetOrPosition === 'number' ? offsetOrPosition : undefined,
            typeof lengthOrEncoding === 'number' || typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined,
            writePosition
          );
          queueMicrotask(() => done?.(null, written, value));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error, undefined, value));
        }
      },
      writevSync: (fd: number, buffers: Uint8Array[], position?: number | null) => {
        let bytesWritten = 0;
        let nextPosition = typeof position === 'number' ? Math.max(0, position) : position;
        for (const buffer of buffers) {
          const written = fsApi.writeSync(fd, buffer, 0, buffer.byteLength, nextPosition);
          bytesWritten += written;
          if (typeof nextPosition === 'number') nextPosition += written;
        }
        return bytesWritten;
      },
      writev: (
        fd: number,
        buffers: Uint8Array[],
        positionOrCallback?: number | null | ((error: Error | null, bytesWritten?: number, buffers?: Uint8Array[]) => void),
        callback?: (error: Error | null, bytesWritten?: number, buffers?: Uint8Array[]) => void
      ) => {
        const done = typeof positionOrCallback === 'function' ? positionOrCallback : callback;
        const position = typeof positionOrCallback === 'function' ? undefined : positionOrCallback;
        try {
          const bytesWritten = fsApi.writevSync(fd, buffers, position);
          queueMicrotask(() => done?.(null, bytesWritten, buffers));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error, undefined, buffers));
        }
      },
      fstatSync: (fd: number) => {
        const entry = fileDescriptor(fd);
        if (entry.kind === 'device') {
          return {
            ...missingFileStat(),
            isFile: () => true,
          };
        }
        return statForNormalizedPath(entry.path ?? '') ?? missingFileStat();
      },
      fstat: (fd: number, callback: (error: Error | null, stats?: { size: number; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void) => {
        try {
          const stats = fsApi.fstatSync(fd);
          queueMicrotask(() => callback(null, stats));
        } catch (error) {
          queueMicrotask(() => callback(error as Error));
        }
      },
      fchmodSync: (fd: number, mode: unknown) => {
        const entry = fileDescriptor(fd);
        if (entry.kind === 'file') {
          const stats = statForNormalizedPath(entry.path ?? '');
          const typeMode = stats?.isDirectory() ? 0o40000 : 0o100000;
          updateEntryMetadata(entry.path ?? '', { mode: typeMode | (Number(mode) & 0o7777) });
          notifyMetadataMutation(entry.path ?? '');
        }
        return undefined;
      },
      fchmod: (fd: number, mode: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.fchmodSync(fd, mode);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      fchownSync: (fd: number, uid: unknown, gid: unknown) => {
        const entry = fileDescriptor(fd);
        if (entry.kind === 'file') {
          updateEntryMetadata(entry.path ?? '', { uid: Number(uid) || 0, gid: Number(gid) || 0 });
          notifyMetadataMutation(entry.path ?? '');
        }
        return undefined;
      },
      fchown: (fd: number, uid: unknown, gid: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.fchownSync(fd, uid, gid);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      futimesSync: (fd: number, atime: unknown, mtime: unknown) => {
        const entry = fileDescriptor(fd);
        if (entry.kind === 'file') {
          updateEntryMetadata(entry.path ?? '', { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
          notifyMetadataMutation(entry.path ?? '');
        }
        return undefined;
      },
      futimes: (fd: number, atime: unknown, mtime: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.futimesSync(fd, atime, mtime);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      ftruncateSync: (fd: number, length = 0) => {
        const entry = fileDescriptor(fd);
        if (!entry.writable) throw Object.assign(new Error('EBADF: bad file descriptor, ftruncate'), { code: 'EBADF' });
        if (entry.kind === 'device') throw Object.assign(new Error('EINVAL: invalid argument, ftruncate'), { code: 'EINVAL' });
        truncateFileBytes(entry.path ?? '', length);
        if (entry.offset > length) entry.offset = length;
        return undefined;
      },
      ftruncate: (fd: number, lengthOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof lengthOrCallback === 'function' ? lengthOrCallback : callback;
        try {
          fsApi.ftruncateSync(fd, typeof lengthOrCallback === 'number' ? lengthOrCallback : 0);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      fsyncSync: (fd: number) => {
        fileDescriptor(fd);
        return undefined;
      },
      fsync: (fd: number, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.fsyncSync(fd);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      fdatasyncSync: (fd: number) => {
        fileDescriptor(fd);
        return undefined;
      },
      fdatasync: (fd: number, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.fdatasyncSync(fd);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      createReadStream: (path: unknown, options?: string | { encoding?: string; start?: number; end?: number } | null) => {
        const device = normalizeRuntimeDevicePath(path);
        const requestedEncoding = typeof options === 'string' ? options : options?.encoding;
        const sourceBytes = device
          ? utf8Bytes(readDevice(device))
          : fileStore.get(assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext));
        if (!sourceBytes) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
        }
        const start = typeof options === 'object' && typeof options?.start === 'number' ? Math.max(0, options.start) : 0;
        const endInclusive = typeof options === 'object' && typeof options?.end === 'number' ? options.end : sourceBytes.byteLength - 1;
        return createReadableStream(sourceBytes.slice(start, Math.max(start, endInclusive + 1)), requestedEncoding);
      },
      createWriteStream: createWritableStream,
      readFileSync: (path: unknown, encoding?: string | { encoding?: string }) => {
        const device = normalizeRuntimeDevicePath(path);
        if (device) {
          const requestedEncoding = typeof encoding === 'string' ? encoding : encoding?.encoding;
          const contents = readDevice(device);
          if (typeof requestedEncoding === 'string') return BrowserBuffer.from(contents).toString(requestedEncoding);
          return BrowserBuffer.from(contents);
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        const bytes = fileStore.get(normalized);
        if (!bytes) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
        }
        const requestedEncoding = typeof encoding === 'string' ? encoding : encoding?.encoding;
        if (typeof requestedEncoding === 'string') {
          return BrowserBuffer.from(bytes).toString(requestedEncoding);
        }
        return BrowserBuffer.from(bytes);
      },
      readFile: (path: unknown, encodingOrCallback?: string | { encoding?: string } | ((error: Error | null, data?: unknown) => void), callback?: (error: Error | null, data?: unknown) => void) => {
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        try {
          const data = fsApi.readFileSync(path, typeof encodingOrCallback === 'function' ? undefined : encodingOrCallback);
          queueMicrotask(() => done?.(null, data));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      writeFileSync: (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
        const device = normalizeRuntimeDevicePath(path);
        if (device) {
          writeDevice(device, textFromBytes(bytesFromFsWriteValue(value, options)));
          return;
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        setFileBytes(normalized, bytesFromFsWriteValue(value, options));
      },
      writeFile: (path: unknown, value: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.writeFileSync(path, value, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      appendFileSync: (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
        const device = normalizeRuntimeDevicePath(path);
        if (device) {
          writeDevice(device, textFromBytes(bytesFromFsWriteValue(value, options)));
          return;
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        const previous = fileStore.get(normalized) ?? new Uint8Array();
        const next = bytesFromFsWriteValue(value, options);
        const combined = new Uint8Array(previous.byteLength + next.byteLength);
        combined.set(previous, 0);
        combined.set(next, previous.byteLength);
        setFileBytes(normalized, combined);
      },
      appendFile: (path: unknown, value: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.appendFileSync(path, value, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      copyFileSync: (source: unknown, destination: unknown, mode = 0) => {
        const sourceDevice = normalizeRuntimeDevicePath(source);
        const destinationDevice = normalizeRuntimeDevicePath(destination);
        const sourceBytes = sourceDevice
          ? utf8Bytes(readDevice(sourceDevice))
          : fileStore.get(assertSafeWorkspaceFilePath(source, cwdPath, workspacePathContext));
        if (!sourceBytes) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`), { code: 'ENOENT' });
        }
        if (destinationDevice) {
          writeDevice(destinationDevice, textFromBytes(sourceBytes));
          return;
        }
        const normalizedDestination = assertSafeWorkspaceFilePath(destination, cwdPath, workspacePathContext);
        if ((Number(mode) & fsConstants.COPYFILE_EXCL) !== 0 && fileSystemEntryExists(workspaceFilename(normalizedDestination, workspaceRoot))) {
          throw Object.assign(new Error(`EEXIST: file already exists, copyfile '${source}' -> '${destination}'`), { code: 'EEXIST' });
        }
        setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
      },
      copyFile: (source: unknown, destination: unknown, modeOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof modeOrCallback === 'function' ? modeOrCallback : callback;
        try {
          fsApi.copyFileSync(source, destination, typeof modeOrCallback === 'number' ? modeOrCallback : 0);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      cpSync: (source: unknown, destination: unknown, options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean }) => {
        copyEntrySync(source, destination, options);
        return undefined;
      },
      cp: (source: unknown, destination: unknown, optionsOrCallback?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean } | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.cpSync(source, destination, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      renameSync: (oldPath: unknown, newPath: unknown) => {
        const normalizedOldPath = assertSafeWorkspaceFilePath(oldPath, cwdPath, workspacePathContext);
        const normalizedNewPath = assertSafeWorkspaceFilePath(newPath, cwdPath, workspacePathContext);
        const bytes = fileStore.get(normalizedOldPath);
        if (!bytes) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: 'ENOENT' });
        }
        fileStore.delete(normalizedOldPath);
        modules.delete(normalizedOldPath);
        cache.delete(normalizedOldPath);
        deleteEntryMetadata(normalizedOldPath);
        io.fileChange({ path: normalizedOldPath, deleted: true }, 'live');
        notifyFsWatchers('rename', normalizedOldPath);
        notifyWatchFileWatchers(normalizedOldPath);
        setFileBytes(normalizedNewPath, bytes);
        notifyFsWatchers('rename', normalizedNewPath);
      },
      rename: (oldPath: unknown, newPath: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.renameSync(oldPath, newPath);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      unlinkSync: deleteFile,
      unlink: (path: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.unlinkSync(path);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      rmSync: (path: unknown, options?: { force?: boolean; recursive?: boolean }) => {
        try {
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          if (fileStore.has(normalized)) {
            deleteFile(path);
            return;
          }
          const prefix = normalized ? `${normalized}/` : '';
          const descendants = Array.from(fileStore.keys()).filter((filePath) => filePath.startsWith(prefix));
          if (descendants.length > 0) {
            if (!options?.recursive) {
              throw Object.assign(new Error(`EISDIR: illegal operation on a directory, rm '${path}'`), { code: 'EISDIR' });
            }
            for (const filePath of descendants) {
              fileStore.delete(filePath);
              modules.delete(filePath);
              cache.delete(filePath);
              deleteEntryMetadata(filePath);
              io.fileChange({ path: filePath, deleted: true }, 'live');
              notifyFsWatchers('rename', filePath);
              notifyWatchFileWatchers(filePath);
            }
            for (const directoryPath of Array.from(directoryStore)) {
              if (directoryPath === normalized || directoryPath.startsWith(prefix)) {
                directoryStore.delete(directoryPath);
                deleteEntryMetadata(directoryPath);
                notifyDirectoryMutation(directoryPath);
              }
            }
            return;
          }
          if (directoryStore.has(normalized)) {
            directoryStore.delete(normalized);
            deleteEntryMetadata(normalized);
            notifyDirectoryMutation(normalized);
            return;
          }
          if (!options?.force) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${path}'`), { code: 'ENOENT' });
          }
        } catch (error) {
          if (options?.force) return;
          throw error;
        }
      },
      rm: (path: unknown, optionsOrCallback?: { force?: boolean; recursive?: boolean } | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.rmSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      existsSync: (path: unknown) => {
        try {
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          const prefix = normalized ? `${normalized}/` : '';
          return fileStore.has(normalized)
            || directoryStore.has(normalized)
            || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
        } catch {
          return false;
        }
      },
      exists: (path: unknown, callback?: (exists: boolean) => void) => {
        queueMicrotask(() => callback?.(fsApi.existsSync(path)));
      },
      readdirSync: (path: unknown, options?: { withFileTypes?: boolean; recursive?: boolean } | string | null) => {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        const prefix = normalized ? `${normalized}/` : '';
        const withFileTypes = typeof options === 'object' && options?.withFileTypes === true;
        const recursive = typeof options === 'object' && options?.recursive === true;
        const makeDirent = (name: string, type: 'file' | 'directory', parentPath = normalized) => ({
          name,
          path: workspaceFilename(parentPath, workspaceRoot),
          parentPath: workspaceFilename(parentPath, workspaceRoot),
          isFile: () => type === 'file',
          isDirectory: () => type === 'directory',
          isSymbolicLink: () => false,
        });
        if (recursive) {
          const entries = new Map<string, 'file' | 'directory'>();
          for (const directoryPath of directoryStore) {
            if (directoryPath === normalized || !directoryPath.startsWith(prefix)) continue;
            const rest = directoryPath.slice(prefix.length);
            if (rest) entries.set(rest, 'directory');
          }
          for (const filePath of fileStore.keys()) {
            if (!filePath.startsWith(prefix)) continue;
            const rest = filePath.slice(prefix.length);
            if (rest) entries.set(rest, 'file');
          }
          if (entries.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' });
          }
          const sortedEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
          if (!withFileTypes) return sortedEntries.map(([name]) => name);
          return sortedEntries.map(([relativePath, type]) => {
            const parts = relativePath.split('/');
            const name = parts.pop() ?? relativePath;
            const parentPath = parts.length === 0
              ? normalized
              : normalized
                ? `${normalized}/${parts.join('/')}`
                : parts.join('/');
            return makeDirent(name, type, parentPath);
          });
        }
        const entries = new Map<string, 'file' | 'directory'>();
        for (const filePath of fileStore.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          if (!rest) continue;
          const [name, ...remaining] = rest.split('/');
          if (!name) continue;
          entries.set(name, remaining.length > 0 ? 'directory' : 'file');
        }
        for (const directoryPath of directoryStore) {
          if (!directoryPath.startsWith(prefix)) continue;
          const rest = directoryPath.slice(prefix.length);
          if (!rest) continue;
          const name = rest.split('/')[0] ?? rest;
          if (!entries.has(name)) entries.set(name, 'directory');
        }
        if (entries.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' });
        }
        const sortedEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
        if (!withFileTypes) return sortedEntries.map(([name]) => name);
        return sortedEntries.map(([name, type]) => makeDirent(name, type));
      },
      readdir: (path: unknown, optionsOrCallback?: { withFileTypes?: boolean; recursive?: boolean } | string | null | ((error: Error | null, files?: unknown) => void), callback?: (error: Error | null, files?: unknown) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const entries = fsApi.readdirSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null, entries));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      opendirSync: (path: unknown) => {
        const entries = fsApi.readdirSync(path, { withFileTypes: true }) as Array<{
          name: string;
          isFile: () => boolean;
          isDirectory: () => boolean;
          isSymbolicLink: () => boolean;
        }>;
        let index = 0;
        let closed = false;
        const assertOpen = (): void => {
          if (closed) throw Object.assign(new Error('ERR_DIR_CLOSED: Directory handle was closed'), { code: 'ERR_DIR_CLOSED' });
        };
        const dir = {
          path: fsApi.realpathSync(path),
          readSync: () => {
            assertOpen();
            return entries[index++] ?? null;
          },
          read: (callback?: (error: Error | null, dirent?: unknown) => void) => {
            try {
              const entry = dir.readSync();
              queueMicrotask(() => callback?.(null, entry));
            } catch (error) {
              queueMicrotask(() => callback?.(error as Error));
            }
          },
          closeSync: () => {
            closed = true;
          },
          close: (callback?: (error?: Error | null) => void) => {
            closed = true;
            queueMicrotask(() => callback?.(null));
          },
          async *[Symbol.asyncIterator]() {
            while (true) {
              const entry = dir.readSync();
              if (entry === null) break;
              yield entry;
            }
          },
        };
        return dir;
      },
      opendir: (path: unknown, optionsOrCallback?: unknown, callback?: (error: Error | null, dir?: unknown) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback as (error: Error | null, dir?: unknown) => void : callback;
        try {
          const dir = fsApi.opendirSync(path);
          queueMicrotask(() => done?.(null, dir));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      statSync: (path: unknown) => {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        const stats = statForNormalizedPath(normalized);
        if (!stats) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
        }
        return stats;
      },
      lstatSync: (path: unknown) => fsApi.statSync(path),
      stat: (path: unknown, callback: (error: Error | null, stats?: { size: number; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void) => {
        try {
          const stats = fsApi.statSync(path);
          queueMicrotask(() => callback(null, stats));
        } catch (error) {
          queueMicrotask(() => callback(error as Error));
        }
      },
      lstat: (path: unknown, callback: (error: Error | null, stats?: { size: number; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void) => {
        fsApi.stat(path, callback);
      },
      realpathSync: (path: unknown, options?: string | { encoding?: string | null } | null) => {
        const resolved = realpathForEntry(path);
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return encoding === 'buffer' ? BrowserBuffer.from(resolved) : resolved;
      },
      realpath: (path: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error: Error | null, resolvedPath?: unknown) => void), callback?: (error: Error | null, resolvedPath?: unknown) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const resolved = fsApi.realpathSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null, resolved));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      truncateSync: (path: unknown, length = 0) => {
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        truncateFileBytes(normalized, length);
        return undefined;
      },
      truncate: (path: unknown, lengthOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof lengthOrCallback === 'function' ? lengthOrCallback : callback;
        try {
          fsApi.truncateSync(path, typeof lengthOrCallback === 'number' ? lengthOrCallback : 0);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      mkdirSync: (path: unknown, options?: { recursive?: boolean }) => {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        if (!normalized) return undefined;
        const parent = dirname(normalized);
        const parentPath = parent === '' ? '' : parent;
        if (!options?.recursive && parentPath && !directoryStore.has(parentPath)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${path}'`), { code: 'ENOENT' });
        }
        const parts = normalized.split('/');
        const start = options?.recursive ? 1 : parts.length;
        for (let index = start; index <= parts.length; index += 1) {
          const directoryPath = parts.slice(0, index).join('/');
          const existed = directoryStore.has(directoryPath);
          directoryStore.add(directoryPath);
          if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
          if (!existed) notifyDirectoryMutation(directoryPath);
        }
        return undefined;
      },
      mkdir: (path: unknown, optionsOrCallback?: { recursive?: boolean } | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.mkdirSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      mkdtempSync: (prefix: unknown, options?: string | { encoding?: string | null } | null) => {
        const rawPrefix = workspacePathInputToString(prefix);
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          mkdtempCounter += 1;
          const suffix = mkdtempCounter.toString(36).padStart(6, '0').slice(-6);
          const candidate = `${rawPrefix}${suffix}`;
          const normalized = normalizeWorkspaceEntryPath(candidate, cwdPath, false, workspacePathContext);
          if (fileStore.has(normalized) || directoryStore.has(normalized)) continue;
          fsApi.mkdirSync(candidate);
          const encoding = typeof options === 'string' ? options : options?.encoding;
          const result = rawPrefix.startsWith('/') ? workspaceFilename(normalized, workspaceRoot) : candidate;
          return encoding === 'buffer' ? BrowserBuffer.from(result) : result;
        }
        throw Object.assign(new Error(`EEXIST: file already exists, mkdtemp '${prefix}'`), { code: 'EEXIST' });
      },
      mkdtemp: (
        prefix: unknown,
        optionsOrCallback?: string | { encoding?: string | null } | null | ((error: Error | null, directory?: unknown) => void),
        callback?: (error: Error | null, directory?: unknown) => void
      ) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const directory = fsApi.mkdtempSync(prefix, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null, directory));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      rmdirSync: (path: unknown) => {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        const prefix = normalized ? `${normalized}/` : '';
        const hasChildren = Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix))
          || Array.from(directoryStore).some((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
        if (hasChildren) {
          throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), { code: 'ENOTEMPTY' });
        }
        if (!directoryStore.delete(normalized)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, rmdir '${path}'`), { code: 'ENOENT' });
        }
        deleteEntryMetadata(normalized);
        notifyDirectoryMutation(normalized);
      },
      rmdir: (path: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.rmdirSync(path);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
    };
    const fsPromisesApi = {
      constants: fsConstants,
      access: async (path: unknown, mode = fsConstants.F_OK) => {
        fsApi.accessSync(path, mode);
      },
      open: async (path: unknown, flags: unknown = 'r') => {
        const fd = fsApi.openSync(path, flags);
        const readFileFromHandle = (encoding?: string | { encoding?: string | null } | null): BrowserBuffer | string => {
          const entry = fileDescriptor(fd);
          const source = descriptorBytes(entry);
          const start = entry.kind === 'device' ? 0 : entry.offset;
          const bytes = BrowserBuffer.from(source.slice(start));
          if (entry.kind !== 'device') entry.offset = source.byteLength;
          const requestedEncoding = typeof encoding === 'string' ? encoding : encoding?.encoding;
          return typeof requestedEncoding === 'string' ? bytes.toString(requestedEncoding) : bytes;
        };
        const writeFileToHandle = (value: unknown, options?: string | { encoding?: string | null } | null): number => {
          const bytes = bytesFromFsWriteValue(value, options);
          return fsApi.writeSync(fd, bytes, 0, bytes.byteLength, null);
        };
        const appendFileToHandle = (value: unknown, options?: string | { encoding?: string | null } | null): number => {
          const entry = fileDescriptor(fd);
          const bytes = bytesFromFsWriteValue(value, options);
          const position = entry.kind === 'device' ? null : descriptorBytes(entry).byteLength;
          return fsApi.writeSync(fd, bytes, 0, bytes.byteLength, position);
        };
        return {
          fd,
          read: async (buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position?: number | null) => {
            const bytesRead = fsApi.readSync(fd, buffer, offset, length, position);
            return { bytesRead, buffer };
          },
          readFile: async (encoding?: string | { encoding?: string | null } | null) => readFileFromHandle(encoding),
          readv: async (buffers: Uint8Array[], position?: number | null) => {
            const bytesRead = fsApi.readvSync(fd, buffers, position);
            return { bytesRead, buffers };
          },
          write: async (value: unknown, offsetOrPosition?: number, lengthOrEncoding?: number | string, position?: number | null) => {
            const bytesWritten = fsApi.writeSync(fd, value, offsetOrPosition, lengthOrEncoding, position);
            return {
              bytesWritten,
              buffer: value,
            };
          },
          writeFile: async (value: unknown, options?: string | { encoding?: string | null } | null) => {
            writeFileToHandle(value, options);
          },
          appendFile: async (value: unknown, options?: string | { encoding?: string | null } | null) => {
            appendFileToHandle(value, options);
          },
          writev: async (buffers: Uint8Array[], position?: number | null) => {
            const bytesWritten = fsApi.writevSync(fd, buffers, position);
            return { bytesWritten, buffers };
          },
          stat: async () => fsApi.fstatSync(fd),
          chmod: async (mode: unknown) => {
            fsApi.fchmodSync(fd, mode);
          },
          chown: async (uid: unknown, gid: unknown) => {
            fsApi.fchownSync(fd, uid, gid);
          },
          utimes: async (atime: unknown, mtime: unknown) => {
            fsApi.futimesSync(fd, atime, mtime);
          },
          truncate: async (length = 0) => {
            fsApi.ftruncateSync(fd, length);
          },
          sync: async () => {
            fsApi.fsyncSync(fd);
          },
          datasync: async () => {
            fsApi.fdatasyncSync(fd);
          },
          close: async () => {
            fsApi.closeSync(fd);
          },
        };
      },
      readFile: async (path: unknown, encoding?: string | { encoding?: string }) => fsApi.readFileSync(path, encoding),
      writeFile: async (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
        fsApi.writeFileSync(path, value, options);
      },
      appendFile: async (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
        fsApi.appendFileSync(path, value, options);
      },
      copyFile: async (source: unknown, destination: unknown, mode = 0) => {
        fsApi.copyFileSync(source, destination, mode);
      },
      cp: async (source: unknown, destination: unknown, options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean }) => {
        fsApi.cpSync(source, destination, options);
      },
      chmod: async (path: unknown, mode: unknown) => {
        fsApi.chmodSync(path, mode);
      },
      chown: async (path: unknown, uid: unknown, gid: unknown) => {
        fsApi.chownSync(path, uid, gid);
      },
      utimes: async (path: unknown, atime: unknown, mtime: unknown) => {
        fsApi.utimesSync(path, atime, mtime);
      },
      rename: async (oldPath: unknown, newPath: unknown) => {
        fsApi.renameSync(oldPath, newPath);
      },
      unlink: async (path: unknown) => {
        fsApi.unlinkSync(path);
      },
      truncate: async (path: unknown, length = 0) => {
        fsApi.truncateSync(path, length);
      },
      rm: async (path: unknown, options?: { force?: boolean; recursive?: boolean }) => {
        fsApi.rmSync(path, options);
      },
      readdir: async (path: unknown, options?: { withFileTypes?: boolean; recursive?: boolean } | string | null) => fsApi.readdirSync(path, options),
      opendir: async (path: unknown) => fsApi.opendirSync(path),
      watch: (path: unknown, options?: { recursive?: boolean; signal?: AbortSignal } | string | null) => {
        type WatchEntry = { eventType: string; filename: string };
        const entries: WatchEntry[] = [];
        const waiters: Array<(result: IteratorResult<WatchEntry>) => void> = [];
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          watcher.close();
          entries.length = 0;
          while (waiters.length > 0) {
            waiters.shift()?.({ done: true, value: undefined });
          }
        };
        const watcher = fsApi.watch(path, typeof options === 'string' ? undefined : options ?? undefined, (eventType, filename) => {
          const entry = { eventType, filename };
          const waiter = waiters.shift();
          if (waiter) {
            waiter({ done: false, value: entry });
            return;
          }
          entries.push(entry);
        });
        if (typeof options === 'object' && options?.signal) {
          if (options.signal.aborted) {
            close();
          } else {
            options.signal.addEventListener('abort', close, { once: true });
          }
        }
        const iterator = {
          [Symbol.asyncIterator]() {
            return iterator;
          },
          next: (): Promise<IteratorResult<WatchEntry>> => {
            if (entries.length > 0) return Promise.resolve({ done: false, value: entries.shift() as WatchEntry });
            if (closed) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => {
              waiters.push(resolve);
            });
          },
          return: (): Promise<IteratorResult<WatchEntry>> => {
            close();
            return Promise.resolve({ done: true, value: undefined });
          },
        };
        return iterator;
      },
      stat: async (path: unknown) => fsApi.statSync(path),
      lstat: async (path: unknown) => fsApi.lstatSync(path),
      realpath: async (path: unknown, options?: string | { encoding?: string | null } | null) => fsApi.realpathSync(path, options),
      mkdir: async (path: unknown, options?: { recursive?: boolean }) => fsApi.mkdirSync(path, options),
      mkdtemp: async (prefix: unknown, options?: string | { encoding?: string | null } | null) => fsApi.mkdtempSync(prefix, options),
      rmdir: async (path: unknown) => {
        fsApi.rmdirSync(path);
      },
    };
    (fsApi.realpath as unknown as { native: typeof fsApi.realpath }).native = fsApi.realpath;
    (fsApi.realpathSync as unknown as { native: typeof fsApi.realpathSync }).native = fsApi.realpathSync;
    Object.assign(fsApi, { promises: fsPromisesApi });
    const zlibApi = createZlibApi();
    const builtins = new Map<string, unknown>([
      ['fs', fsApi],
      ['node:fs', fsApi],
      ['fs/promises', fsPromisesApi],
      ['node:fs/promises', fsPromisesApi],
      ['path', createPathApi(() => cwdPath, workspaceRoot)],
      ['node:path', createPathApi(() => cwdPath, workspaceRoot)],
      ['os', createOsApi(workspaceRoot)],
      ['node:os', createOsApi(workspaceRoot)],
      ['url', createUrlApi()],
      ['node:url', createUrlApi()],
      ['buffer', { Buffer: BrowserBuffer }],
      ['node:buffer', { Buffer: BrowserBuffer }],
      ['zlib', zlibApi],
      ['node:zlib', zlibApi],
    ]);
    const normalizeModuleSpecifier = (specifier: string): string => (
      specifier.startsWith('/')
        ? normalizeWorkspaceEntryPath(specifier, '', false, workspacePathContext)
        : specifier
    );
    const requireModule = (specifier: string, parentPath: string, parentModule: ModuleRecord | null = null) => {
      if (builtins.has(specifier)) return builtins.get(specifier);
      const normalizedSpecifier = normalizeModuleSpecifier(specifier);
      return executeModule(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, 'require'), parentModule);
    };
    const resolveRequireModule = (specifier: string, parentPath: string): string => {
      if (builtins.has(specifier)) return specifier;
      const normalizedSpecifier = normalizeModuleSpecifier(specifier);
      return workspaceFilename(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, 'require'), workspaceRoot);
    };
    const createWorkspaceRequire = (
      parentPath: string,
      parentModule: ModuleRecord | null = null
    ): ((specifier: string) => unknown) & {
      cache: Record<string, ModuleRecord>;
      main?: ModuleRecord;
      resolve: (specifier: string) => string;
    } => {
      const localRequire = ((specifier: string) => requireModule(specifier, parentPath, parentModule)) as ((specifier: string) => unknown) & {
        cache: Record<string, ModuleRecord>;
        resolve: (specifier: string) => string;
        main?: ModuleRecord;
      };
      localRequire.cache = requireCache;
      localRequire.resolve = (specifier: string) => resolveRequireModule(specifier, parentPath);
      Object.defineProperty(localRequire, 'main', {
        configurable: true,
        enumerable: true,
        get: () => mainModule,
      });
      return localRequire;
    };
    const importModule = (specifier: string, parentPath: string) => (
      builtins.has(specifier)
        ? Promise.resolve(builtins.get(specifier))
        : Promise.resolve(executeModule(resolveModulePath(modules, normalizeModuleSpecifier(specifier), parentPath, nodePathSearchEntries, 'import')))
    );
    const preloadParentPath = cwdPath ? `${cwdPath}/repl.js` : 'repl.js';

    const createModuleRecord = (normalizedPath: string, parent: ModuleRecord | null): ModuleRecord => ({
      exports: {},
      id: workspaceFilename(normalizedPath, workspaceRoot),
      filename: workspaceFilename(normalizedPath, workspaceRoot),
      loaded: false,
      parent,
      children: [],
      path: workspaceDirname(normalizedPath, workspaceRoot),
      paths: moduleSearchPaths(normalizedPath, workspaceRoot),
    });

    const executeModule = (modulePath: string, parent: ModuleRecord | null = null, isMain = false): unknown => {
      const normalizedPath = moduleCandidates(modules, modulePath, 'require').find((candidate) => modules.has(candidate));
      if (!normalizedPath) {
        throw new Error(`Cannot find module '${modulePath}'`);
      }
      const cacheKey = workspaceFilename(normalizedPath, workspaceRoot);

      const cached = cache.get(normalizedPath);
      if (cached && requireCache[cacheKey]) {
        if (parent?.children && !parent.children.includes(cached)) parent.children.push(cached);
        return cached.exports;
      } else if (cached) {
        cache.delete(normalizedPath);
      }

      const code = modules.get(normalizedPath);
      if (code === undefined) {
        throw new Error(`Cannot find module '${modulePath}'`);
      }

      if (normalizedPath.endsWith('.json')) {
        const parsed = JSON.parse(code) as unknown;
        const jsonModule = createModuleRecord(normalizedPath, parent);
        jsonModule.exports = parsed;
        jsonModule.loaded = true;
        cache.set(normalizedPath, jsonModule);
        requireCache[cacheKey] = jsonModule;
        if (parent?.children) parent.children.push(jsonModule);
        return parsed;
      }

      const module = createModuleRecord(normalizedPath, parent);
      if (isMain) {
        module.id = '.';
        mainModule = module;
      }
      cache.set(normalizedPath, module);
      requireCache[cacheKey] = module;
      if (parent?.children) parent.children.push(module);
      const localRequire = createWorkspaceRequire(normalizedPath, module);
      module.require = localRequire;
      const localImport = (specifier: string) => importModule(specifier, normalizedPath);
      const executableCode = isEsmModule(modules, normalizedPath)
        ? transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot))
        : code;
      const fn = new Function('require', '__import', 'module', 'exports', 'console', 'process', 'Buffer', '__filename', '__dirname', executableCode);
      fn(
        localRequire,
        localImport,
        module,
        module.exports,
        consoleApi,
        processApi,
        BrowserBuffer,
        workspaceFilename(normalizedPath, workspaceRoot),
        workspaceDirname(normalizedPath, workspaceRoot)
      );
      module.loaded = true;
      return module.exports;
    };

    const executeEntrypoint = async (modulePath: string): Promise<void> => {
      const normalizedPath = moduleCandidates(modules, modulePath, 'import').find((candidate) => modules.has(candidate));
      if (!normalizedPath) {
        throw new Error(`Cannot find module '${modulePath}'`);
      }

      if (!isEsmModule(modules, normalizedPath)) {
        executeModule(normalizedPath, null, true);
        await Promise.resolve();
        return;
      }

      const cached = cache.get(normalizedPath);
      if (cached) return;

      const code = modules.get(normalizedPath);
      if (code === undefined) {
        throw new Error(`Cannot find module '${modulePath}'`);
      }

      const module = createModuleRecord(normalizedPath, null);
      module.id = '.';
      mainModule = module;
      cache.set(normalizedPath, module);
      requireCache[workspaceFilename(normalizedPath, workspaceRoot)] = module;
      const localRequire = createWorkspaceRequire(normalizedPath, module);
      module.require = localRequire;
      const localImport = (specifier: string) => importModule(specifier, normalizedPath);
      const executableCode = transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot));
      const fn = new AsyncFunction('require', '__import', 'module', 'exports', 'console', 'process', 'Buffer', '__filename', '__dirname', executableCode);
      await fn(
        localRequire,
        localImport,
        module,
        module.exports,
        consoleApi,
        processApi,
        BrowserBuffer,
        workspaceFilename(normalizedPath, workspaceRoot),
        workspaceDirname(normalizedPath, workspaceRoot)
      );
      module.loaded = true;
      await Promise.resolve();
    };

    try {
      for (const moduleName of requireModulesForRequest(request)) {
        requireModule(moduleName, preloadParentPath);
      }

      if (request.source === 'file') {
        let entryPath: string | null = null;
        try {
          const workspaceRelativePath = assertSafeWorkspaceFilePath(request.scriptPath, '', workspacePathContext);
          if (modules.has(workspaceRelativePath)) {
            entryPath = workspaceRelativePath;
          }
        } catch {
          // Fall back to cwd-relative resolution below.
        }
        await executeEntrypoint(entryPath ?? normalizeWorkspaceEntryPath(request.scriptPath, cwdPath, false, workspacePathContext));
      } else {
        const module: ModuleRecord = { exports: {} };
        const replPath = preloadParentPath;
        const requireFromRoot = createWorkspaceRequire(replPath);
        const importFromRoot = (specifier: string) => importModule(specifier, replPath);
        const evalCode = request.options?.inputType === 'module'
          ? transformStaticEsmToCommonJs(request.code, workspaceFileUrl('[eval]', workspaceRoot))
          : request.code;
        const fn = new AsyncFunction('require', '__import', 'module', 'exports', 'console', 'process', 'Buffer', '__filename', '__dirname', transformDynamicImports(evalCode));
        await fn(
          requireFromRoot,
          importFromRoot,
          module,
          module.exports,
          consoleApi,
          processApi,
          BrowserBuffer,
          `${workspaceRoot}/[eval]`,
          cwdPath ? `${workspaceRoot}/${cwdPath}` : workspaceRoot
        );
        await Promise.resolve();
      }

      return {
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode: 0,
        files: [
          ...Array.from(fileStore.entries())
          .filter(([path, contents]) => !byteEqual(originalFiles.get(path), contents))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, contents]) => bytesToRuntimeFile(path, contents)),
          ...Array.from(originalFiles.keys())
            .filter((path) => !fileStore.has(path))
            .sort((left, right) => left.localeCompare(right))
            .map((path): RuntimeFileChange => ({ path, deleted: true })),
        ].sort((left, right) => left.path.localeCompare(right.path)),
      };
    } catch (error) {
      const exitCode = typeof (error as { exitCode?: unknown }).exitCode === 'number'
        ? (error as { exitCode: number }).exitCode
        : 1;
      const stderrSuffix = (error as { suppressStderr?: unknown }).suppressStderr
        ? ''
        : error instanceof Error
          ? `${error.message}\n`
          : `${String(error)}\n`;
      return {
        stdout: stdout.join(''),
        stderr: stderr.join('') + stderrSuffix,
        exitCode,
      };
    }
}
