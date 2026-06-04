let runtimePromise = null;
let warmupPromise = null;
let executeExport = null;
let executeProjectExport = null;
let configuredAssetBaseUrl = null;
let runtimeModule = null;
let runtimeFsHooksInstalled = false;
let activeProjectIo = null;
const activeProtocolTokens = new Map();
let materializedKernelVirtualFilePaths = new Set();
let materializedKernelVirtualDirectoryPaths = new Set();
let hiddenKernelVirtualFilePaths = new Set();
let hiddenKernelVirtualDirectoryPaths = new Set();
let materializedKernelDevicePaths = new Set();
const SHARED_KERNEL_POLICY_PATHS = [
  '../shared/runtime-kernel-policy-classic.js',
  './shared/runtime-kernel-policy-classic.js',
];
const WORKER_DEBUG = (() => {
  try {
    return typeof self !== 'undefined' && typeof self.location?.search === 'string' && self.location.search.includes('dev=');
  } catch {
    return false;
  }
})();
const CSHARP_DEFAULT_FILE = 'solution.cs';
const CSHARP_LEGACY_USER_FILE = 'UserCode.cs';
const CSHARP_PROJECT_WORKSPACE_ROOT = '/tmp/tracecode-csharp-project';
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const STDIN_PIPE_HEADER_INTS = 3;
const STDIN_PIPE_HEADER_BYTES = STDIN_PIPE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const STDIN_PIPE_READ_INDEX = 0;
const STDIN_PIPE_WRITE_INDEX = 1;
const STDIN_PIPE_CLOSED_INDEX = 2;
const PROJECT_MAX_OUTPUT_STREAM_BYTES = 1024 * 1024;
const PROJECT_MAX_LIVE_FILE_CHANGES = 1024;
const PROJECT_MAX_LIVE_FILE_CHANGE_BYTES = 4 * 1024 * 1024;
const CSHARP_WARMUP_REQUEST = Object.freeze({
  source: 'public class Solution { public int Add(int a, int b) { return a + b; } }',
  functionName: 'Add',
  inputs: { a: 1, b: 2 },
  executionStyle: 'solution-method',
  trace: false,
  timeoutMs: 1_000,
});

function stdinPipeState(pipe) {
  const buffer = pipe?.buffer;
  if (
    typeof SharedArrayBuffer === 'undefined' ||
    !(buffer instanceof SharedArrayBuffer) ||
    buffer.byteLength <= STDIN_PIPE_HEADER_BYTES
  ) {
    return null;
  }
  return {
    header: new Int32Array(buffer, 0, STDIN_PIPE_HEADER_INTS),
    bytes: new Uint8Array(buffer, STDIN_PIPE_HEADER_BYTES),
  };
}

function stdinPipeAvailable(state, readIndex, writeIndex) {
  const capacity = state.bytes.byteLength;
  return readIndex <= writeIndex
    ? writeIndex - readIndex
    : capacity - readIndex + writeIndex;
}

function readStdinPipeByte(state) {
  if (!state) return null;
  const capacity = state.bytes.byteLength;
  while (true) {
    const readIndex = Atomics.load(state.header, STDIN_PIPE_READ_INDEX);
    const writeIndex = Atomics.load(state.header, STDIN_PIPE_WRITE_INDEX);
    if (stdinPipeAvailable(state, readIndex, writeIndex) > 0) {
      const byte = state.bytes[readIndex];
      Atomics.store(state.header, STDIN_PIPE_READ_INDEX, (readIndex + 1) % capacity);
      return byte;
    }
    if (Atomics.load(state.header, STDIN_PIPE_CLOSED_INDEX) !== 0) return null;
    Atomics.wait(state.header, STDIN_PIPE_WRITE_INDEX, writeIndex);
  }
}

let queue = Promise.resolve();
let idleTimer = null;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
let queuedTasks = 0;

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value, options) {
  return new TextDecoder('utf-8', options).decode(value);
}

function projectUtf8Bytes(value) {
  return encodeUtf8(String(value ?? '')).byteLength;
}

function projectTruncateUtf8(value, maxBytes) {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let output = '';
  for (const char of String(value ?? '')) {
    const nextBytes = projectUtf8Bytes(char);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    output += char;
  }
  return output;
}

function projectFileChangeByteSize(change) {
  if (!change || typeof change !== 'object') return 0;
  let size = projectUtf8Bytes(change.path ?? '');
  if (typeof change.contents === 'string') {
    size += change.encoding === 'base64'
      ? Math.ceil(change.contents.length * 3 / 4)
      : projectUtf8Bytes(change.contents);
  }
  return size;
}

function applyProjectEventBudget(context, payload) {
  if (!context || !payload || typeof payload !== 'object') return payload;

  if (
    payload.type === 'output' &&
    (payload.stream === 'stdout' || payload.stream === 'stderr') &&
    typeof payload.data === 'string'
  ) {
    if (context.truncatedOutputStreams.has(payload.stream)) return null;
    const used = context.outputBytes[payload.stream] ?? 0;
    const remaining = PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
    const bytes = projectUtf8Bytes(payload.data);
    if (bytes <= remaining) {
      context.outputBytes[payload.stream] = used + bytes;
      return payload;
    }

    context.truncatedOutputStreams.add(payload.stream);
    const marker = `\n[tracekernel: ${payload.stream} output truncated after ${PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
    const data = `${projectTruncateUtf8(payload.data, Math.max(0, remaining))}${marker}`;
    context.outputBytes[payload.stream] = PROJECT_MAX_OUTPUT_STREAM_BYTES + projectUtf8Bytes(marker);
    return data ? { ...payload, data } : null;
  }

  if (payload.type === 'file-change' && (payload.phase ?? 'live') === 'live') {
    context.liveFileChangeCount += 1;
    const size = projectFileChangeByteSize(payload.change);
    const overBudget =
      context.liveFileChangeCount > PROJECT_MAX_LIVE_FILE_CHANGES ||
      size > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES ||
      context.liveFileChangeBytes + size > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES;
    if (overBudget) {
      if (!context.warnedLiveFileBudget) {
        context.warnedLiveFileBudget = true;
        emitRuntimeDiagnostic('warn', 'project-event-budget', 'Dropped oversized C# live file-change event.', {
          count: context.liveFileChangeCount,
          bytes: context.liveFileChangeBytes,
          eventBytes: size,
        });
      }
      return null;
    }
    context.liveFileChangeBytes += size;
  }

  return payload;
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function emitRuntimeDiagnostic(level, phase, message, detail) {
  if (!WORKER_DEBUG && level !== 'error') return;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  console[method]('[TraceRuntime]', {
    schema: 'tracecode.runtime-diagnostic.v1',
    source: 'harness',
    component: 'CSharpWorker',
    runtime: 'csharp',
    phase,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

if (typeof importScripts === 'function') {
  for (const scriptPath of SHARED_KERNEL_POLICY_PATHS) {
    try {
      importScripts(scriptPath);
      emitRuntimeDiagnostic('info', 'shared-kernel-policy-loaded', 'Loaded shared runtime kernel policy.', { scriptPath });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitRuntimeDiagnostic('warn', 'shared-kernel-policy-load-failed', 'Failed to load shared runtime kernel policy.', {
        scriptPath,
        message,
      });
    }
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(now() - startedAt));
}

function normalizeRuntimeAbsolutePath(value, options = {}) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const raw = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!raw.startsWith('/')) return null;
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (options.rejectParentTraversal) return null;
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function normalizeRawKernelDevicePath(value) {
  const normalized = normalizeRuntimeAbsolutePath(value, { rejectParentTraversal: true });
  if (!normalized) return null;
  return normalized.startsWith('/dev/') && normalized.length > '/dev/'.length ? normalized : null;
}

function normalizeKernelDevicePath(value, request = activeProjectIo?.request) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelVirtualPathTarget === 'function') {
    const target = policy.runtimeKernelVirtualPathTarget(value, { devices: kernelDeviceEntries(request) });
    if (target?.kind === 'device-file') return target.path;
  }
  return normalizeRawKernelDevicePath(value);
}

function isKernelDeviceNamespacePath(value) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.isRuntimeKernelDeviceNamespacePath === 'function') {
    return policy.isRuntimeKernelDeviceNamespacePath(value);
  }
  const normalized = normalizeRuntimeAbsolutePath(value, { rejectParentTraversal: true });
  if (!normalized) return false;
  return normalized === '/dev' || normalized.startsWith('/dev/');
}

function isKernelDeviceDirectoryPath(value) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.isRuntimeKernelDeviceDirectory === 'function') {
    return policy.isRuntimeKernelDeviceDirectory(value);
  }
  return normalizeRuntimeAbsolutePath(value, { rejectParentTraversal: true }) === '/dev';
}

function kernelDeviceEntries(request = activeProjectIo?.request) {
  const devices = request?.project?.kernelDevices;
  return Array.isArray(devices) ? devices : [];
}

function kernelDeviceInfo(path, request = activeProjectIo?.request) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelDeviceInfo === 'function') {
    return policy.runtimeKernelDeviceInfo(kernelDeviceEntries(request), path);
  }
  const devicePath = normalizeKernelDevicePath(path, request);
  if (!devicePath) return null;
  for (const device of kernelDeviceEntries(request)) {
    if (normalizeKernelDevicePath(device?.path, request) === devicePath) return device;
  }
  return null;
}

function kernelDeviceInputSource(path, request = activeProjectIo?.request) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelDeviceInputSource === 'function') {
    return policy.runtimeKernelDeviceInputSource(kernelDeviceEntries(request), path) || null;
  }
  const device = kernelDeviceInfo(path, request);
  if (!device?.readable) return null;
  return normalizeKernelDevicePath(device.inputDevice, request) || normalizeKernelDevicePath(device.path, request);
}

function kernelDeviceOutputTarget(path, request = activeProjectIo?.request) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelDeviceOutputTarget === 'function') {
    return policy.runtimeKernelDeviceOutputTarget(kernelDeviceEntries(request), path) || null;
  }
  const device = kernelDeviceInfo(path, request);
  if (!device?.writable) return null;
  return normalizeKernelDevicePath(device.outputDevice, request) || normalizeKernelDevicePath(device.path, request);
}

function kernelDeviceStream(path) {
  return normalizeKernelDevicePath(path) === '/dev/stderr' ? 'stderr' : 'stdout';
}

function normalizeKernelVirtualManifestPath(value) {
  const normalized = normalizeRuntimeAbsolutePath(value, { rejectParentTraversal: true });
  if (!normalized) return null;
  return normalized.startsWith('/') && normalized !== '/dev' && !normalized.startsWith('/dev/')
    ? normalized
    : null;
}

function kernelVirtualManifestPaths(request = activeProjectIo?.request) {
  const files = request?.project?.kernelFiles;
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => normalizeKernelVirtualManifestPath(file?.path))
    .filter(Boolean);
}

function isKernelVirtualFsPath(path, request = activeProjectIo?.request) {
  const normalized = normalizeKernelVirtualManifestPath(path);
  if (!normalized) return false;
  for (const filePath of kernelVirtualManifestPaths(request)) {
    if (normalized === filePath) return true;
    for (const directory of runtimeAncestorDirectories(filePath)) {
      if (normalized === directory) return true;
    }
  }
  return false;
}

function kernelVirtualProcEntryKind(path, request = activeProjectIo?.request) {
  const normalized = normalizeKernelVirtualManifestPath(path);
  if (!normalized || (normalized !== '/proc' && !normalized.startsWith('/proc/'))) return undefined;
  let hasProcEntry = false;
  for (const filePath of kernelVirtualManifestPaths(request)) {
    if (filePath !== '/proc' && !filePath.startsWith('/proc/')) continue;
    hasProcEntry = true;
    if (normalized === filePath) return 'file';
    for (const directory of runtimeAncestorDirectories(filePath)) {
      if (normalized === directory) return 'directory';
    }
  }
  return hasProcEntry && normalized === '/proc' ? 'directory' : undefined;
}

function runtimeKernelVirtualPathTarget(path, request = activeProjectIo?.request) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelVirtualPathTarget === 'function') {
    return policy.runtimeKernelVirtualPathTarget(path, {
      devices: kernelDeviceEntries(request),
      readOnlyPaths: kernelVirtualManifestPaths(request),
    });
  }
  if (isKernelDeviceDirectoryPath(path)) return { kind: 'device-directory', path: '/dev' };
  if (isKernelDeviceNamespacePath(path)) {
    const device = normalizeRawKernelDevicePath(path);
    return device && kernelDeviceInfo(device, request)
      ? { kind: 'device-file', path: device }
      : { kind: 'device-not-found', path };
  }
  return { kind: 'workspace', path };
}

function runtimeKernelVirtualMutationTarget(path, request = activeProjectIo?.request) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelVirtualMutationTarget === 'function') {
    return policy.runtimeKernelVirtualMutationTarget(path, {
      devices: kernelDeviceEntries(request),
      readOnlyPaths: kernelVirtualManifestPaths(request),
    });
  }
  if (isKernelDeviceNamespacePath(path)) {
    return kernelDeviceInfo(path, request)
      ? { kind: 'error', reason: 'device-read-only', path }
      : { kind: 'error', reason: 'device-not-found', path };
  }
  if (isKernelVirtualFsPath(path, request)) {
    return { kind: 'error', reason: 'kernel-read-only', path };
  }
  return { kind: 'workspace', path };
}

function runtimeKernelVirtualOpenTarget(path, flags, request = activeProjectIo?.request) {
  const openRequest = {
    readable: isReadableOpenFlags(flags),
    writable: isWritableOpenFlags(flags),
    create: isCreateOrTruncateOpenFlags(flags),
    truncate: isCreateOrTruncateOpenFlags(flags),
  };
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelVirtualOpenTarget === 'function') {
    return policy.runtimeKernelVirtualOpenTarget(path, openRequest, {
      devices: kernelDeviceEntries(request),
      procEntryKind: kernelVirtualProcEntryKind(path, request),
    });
  }
  const target = runtimeKernelVirtualPathTarget(path, request);
  if (target.kind === 'workspace') return target;
  if (target.kind === 'device-directory') return { kind: 'error', reason: 'is-directory', path: target.path };
  if (target.kind === 'device-not-found') return { kind: 'error', reason: 'not-found', path: target.path };
  if (target.kind === 'device-file') {
    const info = kernelDeviceInfo(target.path, request);
    return info
      ? { kind: 'device', device: target.path, readable: Boolean(info.readable && openRequest.readable), writable: Boolean(info.writable && openRequest.writable) }
      : { kind: 'error', reason: 'not-found', path: target.path };
  }
  return { kind: 'error', reason: 'read-only', path: target.path };
}

function isHiddenKernelVirtualFsPath(path) {
  const normalized = normalizeKernelVirtualManifestPath(path);
  if (!normalized) return false;
  return hiddenKernelVirtualFilePaths.has(normalized) || hiddenKernelVirtualDirectoryPaths.has(normalized);
}

function isCreateOrTruncateOpenFlags(flags) {
  if (typeof flags === 'string') {
    return flags.includes('w') || flags.includes('a');
  }
  const numericFlags = Number(flags);
  if (!Number.isFinite(numericFlags)) return false;
  return Boolean(numericFlags & 64) || Boolean(numericFlags & 512);
}

function isWritableOpenFlags(flags) {
  if (typeof flags === 'string') {
    return flags.includes('w') || flags.includes('a') || flags.includes('+');
  }
  const numericFlags = Number(flags);
  if (!Number.isFinite(numericFlags)) return false;
  return Boolean(numericFlags & 1) || Boolean(numericFlags & 2) || Boolean(numericFlags & 64) || Boolean(numericFlags & 512);
}

function isReadableOpenFlags(flags) {
  if (typeof flags === 'string') {
    return flags.includes('r') || flags.includes('+');
  }
  const numericFlags = Number(flags);
  if (!Number.isFinite(numericFlags)) return false;
  const accessMode = numericFlags & 3;
  return accessMode === 0 || accessMode === 2;
}

function projectFsRoots(request = activeProjectIo?.request) {
  const roots = ['/workspace', CSHARP_PROJECT_WORKSPACE_ROOT];
  const project = request?.project;
  if (typeof project?.cwd === 'string' && project.cwd) roots.push(project.cwd);
  if (typeof project?.workspaceRoot === 'string' && project.workspaceRoot) roots.push(project.workspaceRoot);
  if (typeof project?.workspaceAlias === 'string' && project.workspaceAlias) roots.push(project.workspaceAlias);
  return Array.from(new Set(
    roots
      .map((root) => normalizeRuntimeAbsolutePath(root))
      .filter(Boolean)
  )).sort((left, right) => right.length - left.length);
}

function isRuntimePathUnderRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function isProjectWorkspaceEscapingPath(path, request = activeProjectIo?.request) {
  if (typeof path !== 'string' || !path) return false;
  const raw = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  if (!raw.startsWith('/')) return false;
  const resolved = normalizeRuntimeAbsolutePath(raw);
  if (!resolved) return false;
  let matchedRawRoot = false;
  for (const root of projectFsRoots(request)) {
    if (isRuntimePathUnderRoot(raw, root)) matchedRawRoot = true;
    if (isRuntimePathUnderRoot(resolved, root)) return false;
  }
  return matchedRawRoot;
}

function throwProjectWorkspaceEscapingMutationError(path, operation) {
  if (!isProjectWorkspaceEscapingPath(path)) return;
  throwKernelFsError(path, operation, 'EACCES', 'permission denied');
}

function normalizeProjectFsPath(path, request = activeProjectIo?.request) {
  if (typeof path !== 'string' || !path) return null;
  const raw = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  const normalized = raw.startsWith('/') ? normalizeRuntimeAbsolutePath(raw) : raw;
  if (!normalized) return null;
  if (normalized === '/dev/stdout' || normalized === '/dev/stderr' || isKernelVirtualFsPath(normalized, request)) return null;

  const roots = projectFsRoots(request);
  const rawMatchedRoot = raw.startsWith('/') && roots.some((root) => isRuntimePathUnderRoot(raw, root));
  const normalizedMatchedRoot = raw.startsWith('/') && roots.some((root) => isRuntimePathUnderRoot(normalized, root));
  if (rawMatchedRoot && !normalizedMatchedRoot) return null;

  for (const cleanRoot of roots) {
    if (normalized === cleanRoot) return null;
    if (normalized.startsWith(`${cleanRoot}/`)) {
      const relative = normalized.slice(cleanRoot.length + 1);
      return relative && !relative.startsWith('../') && relative !== '..' ? relative : null;
    }
  }

  if (!normalized.startsWith('/') && normalized !== '.' && !normalized.startsWith('../') && normalized !== '..') {
    return normalized;
  }
  return null;
}

function projectRuntimeRoots(request) {
  const project = request?.project;
  const roots = [];
  for (const value of [project?.cwd, project?.workspaceRoot, project?.workspaceAlias, '/workspace']) {
    if (typeof value !== 'string' || !value) continue;
    const root = value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    if (root.startsWith('/') && !roots.includes(root)) roots.push(root);
  }
  return roots.sort((left, right) => right.length - left.length);
}

function mapProjectRuntimePath(value, request) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const normalized = value.replace(/\\/g, '/');
  for (const root of projectRuntimeRoots(request)) {
    if (normalized === root) return '/workspace';
    if (root !== '/' && normalized.startsWith(`${root}/`)) {
      return `/workspace/${normalized.slice(root.length + 1)}`;
    }
  }
  return value;
}

function mapProjectRuntimePathList(value, request) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .split(/([:;])/)
    .map((entry) => entry === ':' || entry === ';' ? entry : mapProjectRuntimePath(entry, request))
    .join('');
}

function ensureRuntimeDirectory(fs, path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  if (normalized === '/') return;
  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      const stat = fs.stat(current);
      if (stat && fs.isDir(stat.mode)) continue;
    } catch {
      // Directory does not exist yet.
    }
    fs.mkdir(current);
  }
}

function runtimeAncestorDirectories(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const parts = normalized.split('/').filter(Boolean);
  const directories = [];
  let current = '';
  for (const part of parts.slice(0, -1)) {
    current += `/${part}`;
    directories.push(current);
  }
  return directories;
}

function runtimeDirectoryName(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function removeMaterializedKernelVirtualFile(fs, path) {
  if (typeof fs.chmod === 'function') {
    for (const directory of runtimeAncestorDirectories(path)) {
      try {
        fs.chmod(directory, 0o755);
      } catch {
        // The directory may already be gone.
      }
    }
  }
  try {
    fs.unlink(path);
  } catch {
    // The runtime may already have removed this virtual file.
  }
}

function removeEmptyMaterializedKernelVirtualDirectories(fs, nextDirectories) {
  for (const directory of Array.from(materializedKernelVirtualDirectoryPaths).sort((left, right) => right.length - left.length)) {
    if (nextDirectories.has(directory)) continue;
    try {
      const entries = fs.readdir(directory).filter((entry) => entry !== '.' && entry !== '..');
      if (entries.length > 0) continue;
      if (typeof fs.chmod === 'function') fs.chmod(directory, 0o755);
      fs.rmdir(directory);
    } catch {
      // Leave non-empty or runtime-owned directories alone.
    }
  }
}

function materializeKernelVirtualFiles(request) {
  const fs = runtimeModule?.FS;
  const files = request?.project?.kernelFiles;
  if (!fs) return;
  const manifestFiles = Array.isArray(files) ? files : [];
  const nextFilePaths = new Set(
    manifestFiles
      .map((file) => normalizeKernelVirtualManifestPath(file?.path))
      .filter(Boolean)
  );
  const nextDirectoryPaths = new Set();
  for (const filePath of nextFilePaths) {
    for (const directory of runtimeAncestorDirectories(filePath)) {
      nextDirectoryPaths.add(directory);
    }
  }
  for (const staleFilePath of materializedKernelVirtualFilePaths) {
    if (nextFilePaths.has(staleFilePath)) continue;
    hiddenKernelVirtualFilePaths.add(staleFilePath);
    removeMaterializedKernelVirtualFile(fs, staleFilePath);
  }
  removeEmptyMaterializedKernelVirtualDirectories(fs, nextDirectoryPaths);
  for (const directory of materializedKernelVirtualDirectoryPaths) {
    if (!nextDirectoryPaths.has(directory)) hiddenKernelVirtualDirectoryPaths.add(directory);
  }
  for (const filePath of nextFilePaths) {
    hiddenKernelVirtualFilePaths.delete(filePath);
  }
  for (const directory of nextDirectoryPaths) {
    hiddenKernelVirtualDirectoryPaths.delete(directory);
  }
  const kernelDirectories = new Set();
  for (const file of manifestFiles) {
    const filePath = normalizeKernelVirtualManifestPath(file?.path);
    if (!filePath) continue;
    ensureRuntimeDirectory(fs, runtimeDirectoryName(filePath));
    const ancestors = runtimeAncestorDirectories(filePath);
    if (typeof fs.chmod === 'function') {
      for (const directory of ancestors) {
        try {
          fs.chmod(directory, 0o755);
        } catch {
          // The directory may not exist yet.
        }
      }
    }
    for (const directory of ancestors) {
      kernelDirectories.add(directory);
    }
    try {
      fs.unlink(filePath);
    } catch {
      // The kernel virtual file may not exist yet.
    }
    const contents = file.encoding === 'base64'
      ? Uint8Array.from(atob(String(file.contents || '')), (char) => char.charCodeAt(0))
      : String(file.contents ?? '');
    fs.writeFile(filePath, contents);
    if (typeof fs.chmod === 'function') {
      fs.chmod(filePath, 0o444);
    }
  }
  if (typeof fs.chmod === 'function') {
    for (const directory of Array.from(kernelDirectories).sort((left, right) => right.length - left.length)) {
      fs.chmod(directory, 0o555);
    }
  }
  materializedKernelVirtualFilePaths = nextFilePaths;
  materializedKernelVirtualDirectoryPaths = nextDirectoryPaths;
}

function materializeKernelDevices(request) {
  const fs = runtimeModule?.FS;
  if (!fs || typeof fs.createDevice !== 'function') return;
  ensureRuntimeDirectory(fs, '/dev');
  const nextDevicePaths = new Set(
    kernelDeviceEntries(request)
      .map((device) => normalizeKernelDevicePath(device?.path, request))
      .filter(Boolean)
  );
  for (const staleDevicePath of materializedKernelDevicePaths) {
    if (nextDevicePaths.has(staleDevicePath)) continue;
    try {
      fs.unlink(staleDevicePath);
    } catch {
      // The runtime may already have removed this device.
    }
  }
  materializedKernelDevicePaths = new Set();
  for (const device of kernelDeviceEntries(request)) {
    const devicePath = normalizeKernelDevicePath(device?.path, request);
    if (!devicePath) continue;
    const name = devicePath.slice(devicePath.lastIndexOf('/') + 1);
    try {
      fs.unlink(devicePath);
    } catch {
      // The runtime may not have created this device yet.
    }
    const deviceDirectory = runtimeDirectoryName(devicePath);
    ensureRuntimeDirectory(fs, deviceDirectory);
    fs.createDevice(
      deviceDirectory,
      name,
      device.readable
        ? () => {
            if (!kernelDeviceInputSource(devicePath, request)) return undefined;
            return readProjectInputByte(devicePath);
          }
        : undefined,
      device.writable
        ? (value) => {
            writeProjectDeviceByte(devicePath, value);
          }
        : undefined
    );
    materializedKernelDevicePaths.add(devicePath);
  }
}

function projectRuntimeRequest(request) {
  const project = request?.project && typeof request.project === 'object'
    ? {
        ...request.project,
        cwd: '/workspace',
        workspaceRoot: '/workspace',
        workspaceAlias: request.project.workspaceAlias || '/workspace',
      }
    : request?.project;
  const env = request?.env && typeof request.env === 'object'
    ? Object.fromEntries(Object.entries(request.env).map(([key, value]) => [
        key,
        typeof value === 'string' ? mapProjectRuntimePathList(value, request) : value,
      ]))
    : request?.env;
  return {
    ...request,
    cwd: mapProjectRuntimePath(request?.cwd, request),
    scriptPath: mapProjectRuntimePath(request?.scriptPath, request),
    args: Array.isArray(request?.args)
      ? request.args.map((arg) => mapProjectRuntimePath(String(arg), request))
      : request?.args,
    env,
    project,
  };
}

function encodeRuntimeFileChange(path, bytes) {
  try {
    const text = decodeUtf8(bytes, { fatal: true });
    if (arraysEqual(encodeUtf8(text), bytes)) {
      return { path, contents: text };
    }
  } catch {
    // Binary or invalid UTF-8 content is sent as base64.
  }
  return { path, contents: encodeBase64(bytes), encoding: 'base64' };
}

function runtimeWriteFileBytes(data) {
  if (typeof data === 'string') return encodeUtf8(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  return encodeUtf8(String(data ?? ''));
}

function kernelErrno(code) {
  if (code === 'EBADF') return 8;
  if (code === 'EINVAL') return 28;
  if (code === 'EISDIR') return 31;
  if (code === 'ENOENT') return 44;
  if (code === 'ENOTSUP') return 58;
  if (code === 'EROFS') return 69;
  return 29;
}

function throwKernelFsError(path, operation, code, reason) {
  const fs = runtimeModule?.FS;
  if (typeof fs?.ErrnoError === 'function') {
    throw new fs.ErrnoError(kernelErrno(code));
  }
  throw Object.assign(new Error(`${code}: ${reason}, ${operation} '${path}'`), { code, errno: kernelErrno(code) });
}

function throwKernelDevicePathError(path, operation, code = 'ENOENT') {
  if (isKernelDeviceDirectoryPath(path)) {
    throwKernelFsError(path, operation, 'EROFS', 'read-only file system');
  }
  const devicePath = normalizeKernelDevicePath(path);
  const device = kernelDeviceInfo(devicePath);
  if (!device) {
    throwKernelFsError(path, operation, 'ENOENT', 'no such file or directory');
  }
  throwKernelFsError(path, operation, code, code === 'EBADF' ? 'bad file descriptor' : 'read-only file system');
}

function throwKernelVirtualMutationError(path, operation) {
  throwProjectWorkspaceEscapingMutationError(path, operation);
  const target = runtimeKernelVirtualMutationTarget(path);
  if (target.kind === 'workspace') return;
  if (target.reason === 'device-not-found') {
    throwKernelFsError(path, operation, 'ENOENT', 'no such file or directory');
  }
  throwKernelFsError(path, operation, 'EROFS', 'read-only file system');
}

function emitProjectEvent(payload) {
  if (!activeProjectIo?.messageId) return;
  const budgetedPayload = applyProjectEventBudget(activeProjectIo, payload);
  if (!budgetedPayload) return;
  if (budgetedPayload?.type === 'output' && typeof budgetedPayload.data === 'string') {
    const outputBuffer = budgetedPayload.stream === 'stderr' ? activeProjectIo.eventStderr : activeProjectIo.eventStdout;
    outputBuffer.push(budgetedPayload.data);
  }
  self.postMessage({
    id: activeProjectIo.messageId,
    type: 'project-event',
    payload: budgetedPayload,
    protocolToken: activeProjectIo.protocolToken,
  });
}

function routeProjectOutputEvent(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'output') return payload;
  const requestedDevice = normalizeKernelDevicePath(payload.device) || (payload.stream === 'stderr' ? '/dev/stderr' : '/dev/stdout');
  const outputDevice = kernelDeviceOutputTarget(requestedDevice);
  if (!outputDevice) return null;
  const stream = kernelDeviceStream(outputDevice);
  const payloadSourceDevice = normalizeKernelDevicePath(payload.sourceDevice);
  const sourceDevice = payloadSourceDevice && kernelDeviceOutputTarget(payloadSourceDevice) === outputDevice
    ? payloadSourceDevice
    : requestedDevice !== outputDevice
      ? requestedDevice
      : undefined;
  const { sourceDevice: _sourceDevice, ...event } = payload;
  return {
    ...event,
    stream,
    device: outputDevice,
    ...(sourceDevice ? { sourceDevice } : {}),
  };
}

function emitProjectEventJson(payloadJson) {
  if (!activeProjectIo?.messageId || typeof payloadJson !== 'string') return;
  try {
    const payload = routeProjectOutputEvent(JSON.parse(payloadJson));
    if (payload) emitProjectEvent(payload);
  } catch (error) {
    emitRuntimeDiagnostic('warn', 'project-event', 'C# host emitted an invalid project event payload.', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function emitProjectOutput(stream, data, device = stream === 'stdout' ? '/dev/stdout' : '/dev/stderr', sourceDevice) {
  if (!data) return;
  emitProjectEvent({
    type: 'output',
    stream,
    device,
    ...(sourceDevice && sourceDevice !== device ? { sourceDevice } : {}),
    data,
  });
}

function emitMissingProjectResultOutput(result) {
  const context = activeProjectIo;
  if (!context || !result) return;
  if (context.request?.source !== 'compile') return;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (stdout && !context.truncatedOutputStreams.has('stdout') && context.eventStdout.join('') !== stdout) {
    emitProjectOutput('stdout', stdout);
  }
  if (stderr && !context.truncatedOutputStreams.has('stderr') && context.eventStderr.join('') !== stderr) {
    emitProjectOutput('stderr', stderr);
  }
}

function applyProjectResultOutputBudget(result, context) {
  if (!result || !context) return;
  if (context.truncatedOutputStreams.has('stdout')) {
    result.stdout = context.eventStdout.join('');
  }
  if (context.truncatedOutputStreams.has('stderr')) {
    result.stderr = context.eventStderr.join('');
  }
}

function flushProjectOutput(stream) {
  const context = activeProjectIo;
  if (!context) return;
  const buffer = stream === 'stdout' ? context.stdoutBytes : context.stderrBytes;
  if (!buffer.length) return;
  const bytes = new Uint8Array(buffer);
  buffer.length = 0;
  emitProjectOutput(
    stream,
    decodeUtf8(bytes),
    stream === 'stdout' ? context.stdoutDevice : context.stderrDevice,
    stream === 'stdout' ? context.stdoutSourceDevice : context.stderrSourceDevice
  );
}

function writeProjectDeviceByte(device, value, options = {}) {
  const context = activeProjectIo;
  if (!context || typeof value !== 'number' || value < 0) return;
  const outputDevice = kernelDeviceOutputTarget(device, context.request);
  if (!outputDevice) return;
  if (outputDevice === '/dev/null') return;
  const stream = kernelDeviceStream(outputDevice);
  const buffer = stream === 'stdout' ? context.stdoutBytes : context.stderrBytes;
  const currentDevice = stream === 'stdout' ? context.stdoutDevice : context.stderrDevice;
  const currentSourceDevice = stream === 'stdout' ? context.stdoutSourceDevice : context.stderrSourceDevice;
  const nextSourceDevice = device !== outputDevice ? device : undefined;
  if (buffer.length > 0 && (currentDevice !== outputDevice || currentSourceDevice !== nextSourceDevice)) {
    flushProjectOutput(stream);
  }
  if (stream === 'stdout') {
    context.stdoutDevice = outputDevice;
    context.stdoutSourceDevice = nextSourceDevice;
  } else {
    context.stderrDevice = outputDevice;
    context.stderrSourceDevice = nextSourceDevice;
  }
  const byte = value & 0xff;
  buffer.push(byte);
  if (options.recordResult) context.directDeviceOutput = true;
  if (value === 10) flushProjectOutput(stream);
}

function readProjectInputByte(devicePath = '/dev/stdin') {
  const context = activeProjectIo;
  if (!context) return null;
  const inputDevice = kernelDeviceInputSource(devicePath, context.request);
  if (!inputDevice || inputDevice === '/dev/null') return null;
  if (context.stdinPipe) return readStdinPipeByte(context.stdinPipe);
  return null;
}

function emitProjectFileSnapshot(path) {
  const context = activeProjectIo;
  const fs = runtimeModule?.FS;
  const relativePath = normalizeProjectFsPath(path, context?.request);
  if (!context || !fs || !relativePath) return;
  try {
    const stat = fs.stat(path);
    if (!stat || !fs.isFile(stat.mode)) return;
    const bytes = fs.readFile(path, { encoding: 'binary' });
    emitProjectEvent({ type: 'file-change', phase: 'live', change: encodeRuntimeFileChange(relativePath, bytes) });
  } catch {
    // The file may have been deleted or may be a special device.
  }
}

function emitProjectFileDelete(path) {
  const relativePath = normalizeProjectFsPath(path);
  if (!relativePath) return;
  emitProjectEvent({ type: 'file-change', phase: 'live', change: { path: relativePath, deleted: true } });
}

function emitProjectDirectoryCreate(path) {
  const relativePath = normalizeProjectFsPath(path);
  if (!relativePath) return;
  emitProjectEvent({ type: 'file-change', phase: 'live', change: { path: relativePath, directory: true } });
}

function emitProjectDirectoryDelete(path) {
  const relativePath = normalizeProjectFsPath(path);
  if (!relativePath) return;
  emitProjectEvent({ type: 'file-change', phase: 'live', change: { path: relativePath, directory: true, deleted: true } });
}

function runtimeFsIsDirectory(fs, path) {
  try {
    const stat = fs.stat(path);
    return Boolean(stat && fs.isDir(stat.mode));
  } catch {
    return false;
  }
}

function runtimeFsPath(value) {
  if (typeof value === 'string') return value;
  const fs = runtimeModule?.FS;
  if (fs && typeof fs.getPath === 'function' && value && typeof value === 'object') {
    try {
      return fs.getPath(value);
    } catch {
      // Some provider FS calls pass detached node-like values.
    }
  }
  if (typeof value?.path === 'string') return value.path;
  return null;
}

function runtimeFsPathCandidates(value) {
  const paths = [];
  const addPath = (path) => {
    if (typeof path === 'string' && path && !paths.includes(path)) paths.push(path);
  };
  if (typeof value === 'string') addPath(value);
  if (typeof value?.path === 'string') addPath(value.path);
  const fs = runtimeModule?.FS;
  if (fs && typeof fs.getPath === 'function' && value && typeof value === 'object') {
    try {
      addPath(fs.getPath(value));
    } catch {
      // Some provider FS calls pass detached node-like values.
    }
  }
  return paths;
}

function throwKernelVirtualMutationErrorForRuntimePath(value, operation) {
  for (const path of runtimeFsPathCandidates(value)) {
    throwKernelVirtualMutationError(path, operation);
  }
}

function emitProjectPathSnapshot(path) {
  const fs = runtimeModule?.FS;
  if (!activeProjectIo || !fs) return;
  try {
    const stat = fs.stat(path);
    if (stat && fs.isFile(stat.mode)) {
      emitProjectFileSnapshot(path);
      return;
    }
    if (!stat || !fs.isDir(stat.mode)) return;
    emitProjectDirectoryCreate(path);
    for (const entry of fs.readdir(path)) {
      if (entry === '.' || entry === '..') continue;
      emitProjectPathSnapshot(`${String(path).replace(/\/+$/, '')}/${entry}`);
    }
  } catch {
    // The path may have been deleted or may be a special device.
  }
}

function installRuntimeFsHooks(runtime) {
  const module = runtime?.Module;
  const fs = module?.FS;
  if (!module || !fs || runtimeFsHooksInstalled) return;
  runtimeModule = module;
  runtimeFsHooksInstalled = true;

  const originalWrite = fs.write;
  if (typeof originalWrite === 'function') {
    fs.write = function writeWithProjectEvents(stream, buffer, offset, length, position, canOwn) {
      const devicePath = normalizeKernelDevicePath(stream?.path);
      if (activeProjectIo && devicePath && kernelDeviceOutputTarget(devicePath)) {
        for (let index = 0; index < length; index += 1) {
          writeProjectDeviceByte(devicePath, buffer[offset + index], { recordResult: true });
        }
        return length;
      }
      const result = originalWrite.apply(this, arguments);
      if (activeProjectIo && stream?.path) emitProjectFileSnapshot(stream.path);
      return result;
    };
  }

  const originalWriteFile = fs.writeFile;
  if (typeof originalWriteFile === 'function') {
    fs.writeFile = function writeFileWithProjectEvents(path, data) {
      const devicePath = normalizeKernelDevicePath(path);
      if (activeProjectIo && devicePath && kernelDeviceOutputTarget(devicePath)) {
        for (const byte of runtimeWriteFileBytes(data)) {
          writeProjectDeviceByte(devicePath, byte, { recordResult: true });
        }
        return undefined;
      }
      if (activeProjectIo && isKernelDeviceNamespacePath(path)) {
        throwKernelDevicePathError(path, 'write', 'EROFS');
      }
      if (activeProjectIo && isKernelVirtualFsPath(path)) {
        throwKernelFsError(path, 'write', 'EROFS', 'read-only file system');
      }
      if (activeProjectIo) {
        throwProjectWorkspaceEscapingMutationError(path, 'write');
      }
      const result = originalWriteFile.apply(this, arguments);
      if (activeProjectIo) emitProjectFileSnapshot(path);
      return result;
    };
  }

  const originalReadFile = fs.readFile;
  if (typeof originalReadFile === 'function') {
    fs.readFile = function readFileWithProjectKernelGuards(path) {
      if (activeProjectIo && isHiddenKernelVirtualFsPath(path)) {
        throwKernelFsError(path, 'read', 'ENOENT', 'no such file or directory');
      }
      return originalReadFile.apply(this, arguments);
    };
  }

  const originalStat = fs.stat;
  if (typeof originalStat === 'function') {
    fs.stat = function statWithProjectKernelGuards(path) {
      if (activeProjectIo && isHiddenKernelVirtualFsPath(path)) {
        throwKernelFsError(path, 'stat', 'ENOENT', 'no such file or directory');
      }
      return originalStat.apply(this, arguments);
    };
  }

  const originalReaddir = fs.readdir;
  if (typeof originalReaddir === 'function') {
    fs.readdir = function readdirWithProjectKernelGuards(path) {
      if (activeProjectIo && isHiddenKernelVirtualFsPath(path)) {
        throwKernelFsError(path, 'readdir', 'ENOENT', 'no such file or directory');
      }
      return originalReaddir.apply(this, arguments);
    };
  }

  const originalOpen = fs.open;
  if (typeof originalOpen === 'function') {
    fs.open = function openWithProjectEvents(path, flags) {
      if (activeProjectIo && isHiddenKernelVirtualFsPath(path)) {
        throwKernelFsError(path, 'open', 'ENOENT', 'no such file or directory');
      }
      if (activeProjectIo) {
        throwProjectWorkspaceEscapingMutationError(path, 'open');
        const openTarget = runtimeKernelVirtualOpenTarget(path, flags);
        if (openTarget.kind === 'error') {
          const code = openTarget.reason === 'not-found' ? 'ENOENT' : openTarget.reason === 'is-directory' ? 'EISDIR' : 'EROFS';
          const reason = code === 'ENOENT' ? 'no such file or directory' : code === 'EISDIR' ? 'is a directory' : 'read-only file system';
          throwKernelFsError(path, 'open', code, reason);
        }
        if (openTarget.kind === 'device') {
          if (isReadableOpenFlags(flags) && !openTarget.readable) {
            throwKernelFsError(path, 'open', 'EROFS', 'read-only file system');
          }
          if (isWritableOpenFlags(flags) && !openTarget.writable) {
            throwKernelFsError(path, 'open', 'EROFS', 'read-only file system');
          }
        }
        if (openTarget.kind === 'workspace' && isKernelVirtualFsPath(path) && (isWritableOpenFlags(flags) || isCreateOrTruncateOpenFlags(flags))) {
          throwKernelFsError(path, 'open', 'EROFS', 'read-only file system');
        }
      }
      const shouldEmitCreateSnapshot = Boolean(activeProjectIo) && isCreateOrTruncateOpenFlags(flags);
      const stream = originalOpen.apply(this, arguments);
      if (shouldEmitCreateSnapshot && stream?.path) emitProjectFileSnapshot(stream.path);
      return stream;
    };
  }

  const originalTruncate = fs.truncate;
  if (typeof originalTruncate === 'function') {
    fs.truncate = function truncateWithProjectEvents(path) {
      if (activeProjectIo) throwKernelVirtualMutationError(path, 'truncate');
      const result = originalTruncate.apply(this, arguments);
      if (activeProjectIo) emitProjectFileSnapshot(path);
      return result;
    };
  }

  const originalFtruncate = fs.ftruncate;
  if (typeof originalFtruncate === 'function') {
    fs.ftruncate = function ftruncateWithProjectEvents(fd) {
      const stream = typeof fs.getStream === 'function' ? fs.getStream(fd) : null;
      if (activeProjectIo && stream?.path) throwKernelVirtualMutationError(stream.path, 'ftruncate');
      const result = originalFtruncate.apply(this, arguments);
      if (activeProjectIo && stream?.path) emitProjectFileSnapshot(stream.path);
      return result;
    };
  }

  const originalChmod = fs.chmod;
  if (typeof originalChmod === 'function') {
    fs.chmod = function chmodWithProjectEvents(path) {
      if (activeProjectIo) throwKernelVirtualMutationErrorForRuntimePath(path, 'chmod');
      const result = originalChmod.apply(this, arguments);
      if (activeProjectIo) emitProjectPathSnapshot(runtimeFsPath(path) || path);
      return result;
    };
  }

  const originalFchmod = fs.fchmod;
  if (typeof originalFchmod === 'function') {
    fs.fchmod = function fchmodWithProjectEvents(fd) {
      const stream = typeof fs.getStream === 'function' ? fs.getStream(fd) : null;
      if (activeProjectIo && stream) throwKernelVirtualMutationErrorForRuntimePath(stream, 'fchmod');
      const result = originalFchmod.apply(this, arguments);
      if (activeProjectIo && stream?.path) emitProjectPathSnapshot(stream.path);
      return result;
    };
  }

  const originalChown = fs.chown;
  if (typeof originalChown === 'function') {
    fs.chown = function chownWithProjectEvents(path) {
      if (activeProjectIo) throwKernelVirtualMutationErrorForRuntimePath(path, 'chown');
      const result = originalChown.apply(this, arguments);
      if (activeProjectIo) emitProjectPathSnapshot(runtimeFsPath(path) || path);
      return result;
    };
  }

  const originalFchown = fs.fchown;
  if (typeof originalFchown === 'function') {
    fs.fchown = function fchownWithProjectEvents(fd) {
      const stream = typeof fs.getStream === 'function' ? fs.getStream(fd) : null;
      if (activeProjectIo && stream) throwKernelVirtualMutationErrorForRuntimePath(stream, 'fchown');
      const result = originalFchown.apply(this, arguments);
      if (activeProjectIo && stream?.path) emitProjectPathSnapshot(stream.path);
      return result;
    };
  }

  const originalUtime = fs.utime;
  if (typeof originalUtime === 'function') {
    fs.utime = function utimeWithProjectEvents(path) {
      if (activeProjectIo) throwKernelVirtualMutationErrorForRuntimePath(path, 'utime');
      const result = originalUtime.apply(this, arguments);
      if (activeProjectIo) emitProjectPathSnapshot(runtimeFsPath(path) || path);
      return result;
    };
  }

  const originalUnlink = fs.unlink;
  if (typeof originalUnlink === 'function') {
    fs.unlink = function unlinkWithProjectEvents(path) {
      if (activeProjectIo) throwKernelVirtualMutationError(path, 'unlink');
      const result = originalUnlink.apply(this, arguments);
      if (activeProjectIo) emitProjectFileDelete(path);
      return result;
    };
  }

  const originalMkdir = fs.mkdir;
  if (typeof originalMkdir === 'function') {
    fs.mkdir = function mkdirWithProjectEvents(path) {
      if (activeProjectIo) throwKernelVirtualMutationError(path, 'mkdir');
      const result = originalMkdir.apply(this, arguments);
      if (activeProjectIo) emitProjectDirectoryCreate(path);
      return result;
    };
  }

  const originalRmdir = fs.rmdir;
  if (typeof originalRmdir === 'function') {
    fs.rmdir = function rmdirWithProjectEvents(path) {
      if (activeProjectIo) throwKernelVirtualMutationError(path, 'rmdir');
      const wasDirectory = activeProjectIo && runtimeFsIsDirectory(fs, path);
      const result = originalRmdir.apply(this, arguments);
      if (wasDirectory) emitProjectDirectoryDelete(path);
      return result;
    };
  }

  const originalRename = fs.rename;
  if (typeof originalRename === 'function') {
    fs.rename = function renameWithProjectEvents(oldPath, newPath) {
      if (activeProjectIo) {
        throwKernelVirtualMutationError(oldPath, 'rename');
        throwKernelVirtualMutationError(newPath, 'rename');
      }
      const wasDirectory = activeProjectIo && runtimeFsIsDirectory(fs, oldPath);
      const result = originalRename.apply(this, arguments);
      if (activeProjectIo) {
        if (wasDirectory) {
          emitProjectDirectoryDelete(oldPath);
          emitProjectPathSnapshot(newPath);
        } else {
          emitProjectFileDelete(oldPath);
          emitProjectFileSnapshot(newPath);
        }
      }
      return result;
    };
  }

  const originalSymlink = fs.symlink;
  if (typeof originalSymlink === 'function') {
    fs.symlink = function symlinkWithProjectEvents(oldPath, newPath) {
      if (activeProjectIo) {
        throwKernelVirtualMutationError(newPath, 'symlink');
        throwKernelFsError(newPath, 'symlink', 'ENOTSUP', 'symbolic links are not supported by the project file manifest');
      }
      return originalSymlink.apply(this, arguments);
    };
  }

  const originalLink = fs.link;
  if (typeof originalLink === 'function') {
    fs.link = function linkWithProjectEvents(oldPath, newPath) {
      if (activeProjectIo) {
        throwKernelVirtualMutationError(oldPath, 'link');
        throwKernelVirtualMutationError(newPath, 'link');
        throwKernelFsError(newPath, 'link', 'ENOTSUP', 'hard links are not supported by the project file manifest');
      }
      return originalLink.apply(this, arguments);
    };
  }

  const originalReadlink = fs.readlink;
  if (typeof originalReadlink === 'function') {
    fs.readlink = function readlinkWithProjectEvents(path) {
      if (activeProjectIo) {
        throwKernelFsError(path, 'readlink', 'EINVAL', 'invalid argument');
      }
      return originalReadlink.apply(this, arguments);
    };
  }
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    self.postMessage({ type: 'idle-timeout' });
    self.close();
  }, idleTimeoutMs);
}

function applyWorkerOptions(payload) {
  const requestedIdleTimeoutMs = Number(payload?.idleTimeoutMs);
  if (Number.isFinite(requestedIdleTimeoutMs) && requestedIdleTimeoutMs >= 1_000) {
    idleTimeoutMs = Math.round(requestedIdleTimeoutMs);
  }
}

function resolveAssetUrl(assetBaseUrl, pathname) {
  const normalizedBase = String(assetBaseUrl || '').replace(/\/+$/, '');
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

function configureAssetBaseUrl(assetBaseUrl) {
  if (typeof assetBaseUrl === 'string' && assetBaseUrl.trim()) {
    if (!configuredAssetBaseUrl || (!executeExport && !executeProjectExport && !runtimePromise)) {
      configuredAssetBaseUrl = assetBaseUrl;
    }
  }
  return configuredAssetBaseUrl || assetBaseUrl;
}

function runWarmup() {
  const startedAt = now();
  const result = JSON.parse(executeExport(JSON.stringify(CSHARP_WARMUP_REQUEST)));
  if (!result?.success) {
    throw new Error(result?.error || 'C# runtime warmup failed.');
  }
  return elapsedMs(startedAt);
}

async function loadRuntime(assetBaseUrl) {
  const resolvedAssetBaseUrl = configureAssetBaseUrl(assetBaseUrl);
  if (executeExport && executeProjectExport) {
    return {
      success: true,
      loadTimeMs: 0,
      timings: { totalMs: 0, initMs: 0, warmupMs: 0 },
    };
  }

  if (!runtimePromise) {
    runtimePromise = (async () => {
      const startedAt = now();
      const { dotnet } = await import(resolveAssetUrl(resolvedAssetBaseUrl, '_framework/dotnet.js'));
      const runtimeBuilder = dotnet
        .withModuleConfig({
          stdin: readProjectInputByte,
          stdout: (value) => writeProjectDeviceByte('/dev/stdout', value),
          stderr: (value) => writeProjectDeviceByte('/dev/stderr', value),
        })
        .withApplicationArguments('tracecode-csharp-worker');
      const runtime = await runtimeBuilder.create();
      runtimeModule = runtime?.Module ?? null;
      installRuntimeFsHooks(runtime);
      runtime.setModuleImports('tracecode', {
        emitProjectEvent: emitProjectEventJson,
        readProjectInputByte: () => readProjectInputByte('/dev/stdin') ?? -1,
      });
      const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
      executeExport = exports?.TraceCode?.CSharpHost?.CompilerHost?.Execute;
      executeProjectExport = exports?.TraceCode?.CSharpHost?.CompilerHost?.ExecuteProject;
      if (typeof executeExport !== 'function') {
        throw new Error('Unable to resolve TraceCode.CSharpHost.CompilerHost.Execute JS export');
      }
      if (typeof executeProjectExport !== 'function') {
        throw new Error('Unable to resolve TraceCode.CSharpHost.CompilerHost.ExecuteProject JS export');
      }
      const initMs = elapsedMs(startedAt);
      const totalMs = elapsedMs(startedAt);
      return {
        success: true,
        loadTimeMs: totalMs,
        timings: { totalMs, initMs, warmupMs: 0 },
      };
    })();
    runtimePromise.catch(() => {
      runtimePromise = null;
      executeExport = null;
      executeProjectExport = null;
    });
  }

  return runtimePromise;
}

function handleInit(assetBaseUrl) {
  const startedAt = now();
  configureAssetBaseUrl(assetBaseUrl);
  const totalMs = elapsedMs(startedAt);
  return {
    success: true,
    loadTimeMs: totalMs,
    timings: { totalMs, initMs: 0, warmupMs: 0 },
  };
}

async function warmRuntime(assetBaseUrl) {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      const startedAt = now();
      const runtimeStartedAt = now();
      const runtimeResult = await loadRuntime(assetBaseUrl);
      const initMs = elapsedMs(runtimeStartedAt);
      const warmupMs = runWarmup();
      const totalMs = elapsedMs(startedAt);
      return {
        success: true,
        loadTimeMs: totalMs,
        timings: {
          totalMs,
          initMs: initMs || runtimeResult.timings?.initMs || 0,
          warmupMs,
        },
      };
    })();
    warmupPromise.catch(() => {
      warmupPromise = null;
    });
  }

  return warmupPromise;
}

function normalizeCSharpFile(file) {
  if (typeof file !== 'string') return file;
  return file.endsWith(CSHARP_LEGACY_USER_FILE)
    ? file.slice(0, -CSHARP_LEGACY_USER_FILE.length) + CSHARP_DEFAULT_FILE
    : file;
}

function normalizeMaxPathDepth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(8, Math.max(1, Math.floor(value)));
}

function traceLineParenDelta(line) {
  let delta = 0;
  let quote = null;
  let escaped = false;
  for (const char of String(line ?? '')) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') delta += 1;
    else if (char === ')') delta -= 1;
  }
  return delta;
}

function buildRuntimeStatementSourceMap(code) {
  const lines = String(code ?? '').split(/\r?\n/);
  const spans = new Map();
  let startLine = 0;
  let startColumn = 0;
  let balance = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index] ?? '';
    const delta = traceLineParenDelta(line);
    if (startLine === 0) {
      if (delta > 0) {
        startLine = lineNumber;
        startColumn = /\S/.exec(line)?.index ?? 0;
        balance = delta;
      }
      continue;
    }
    balance += delta;
    if (balance <= 0) {
      const span = {
        statementId: `stmt:${startLine}:${lineNumber}:${startColumn}`,
        startLine,
        startColumn,
        endLine: lineNumber,
        endColumn: line.length,
      };
      for (let mappedLine = startLine; mappedLine <= lineNumber; mappedLine += 1) {
        spans.set(mappedLine, span);
      }
      startLine = 0;
      startColumn = 0;
      balance = 0;
    }
  }
  return spans;
}

function csharpRuntimeTraceSourceOwnership(event, statementSourceMap) {
  if (!(statementSourceMap instanceof Map) || typeof event?.line !== 'number') return {};
  const span = statementSourceMap.get(Math.floor(event.line));
  if (!span) return {};
  const functionName = typeof event.function === 'string' && event.function.length > 0 ? event.function : undefined;
  return {
    statementId: functionName ? `${functionName}:${span.statementId}` : span.statementId,
    sourceSpan: {
      startLine: span.startLine,
      startColumn: span.startColumn,
      endLine: span.endLine,
      endColumn: span.endColumn,
    },
  };
}

function normalizeCSharpTraceEvent(event, maxPathDepth, statementSourceMap) {
  const normalizedFile = normalizeCSharpFile(event.file);
  const next = {
    ...(normalizedFile === undefined ? { ...event } : { ...event, file: normalizedFile }),
    ...csharpRuntimeTraceSourceOwnership(event, statementSourceMap),
  };
  const target = next.target;
  if (
    maxPathDepth !== undefined &&
    target &&
    typeof target === 'object' &&
    Array.isArray(target.path) &&
    target.path.length > maxPathDepth
  ) {
    const nextTarget = { ...target };
    delete nextTarget.path;
    delete nextTarget.indexSources;
    return { ...next, target: nextTarget };
  }
  return next;
}

function normalizeCSharpResult(result, options = {}) {
  if (!result || typeof result !== 'object') return result;
  const maxPathDepth = normalizeMaxPathDepth(options.maxPathDepth);
  const statementSourceMap = typeof options.source === 'string'
    ? buildRuntimeStatementSourceMap(options.source)
    : new Map();
  const normalizedEvents = Array.isArray(result.events)
    ? result.events.map((event) => normalizeCSharpTraceEvent(event, maxPathDepth, statementSourceMap))
    : null;
  const normalizedTrace =
    result.trace && typeof result.trace === 'object' && Array.isArray(result.trace.events)
      ? {
          ...result.trace,
          events: result.trace.events.map((event) => normalizeCSharpTraceEvent(event, maxPathDepth, statementSourceMap)),
        }
      : normalizedEvents
        ? {
            schemaVersion: result.schemaVersion,
            language: 'csharp',
            events: normalizedEvents,
            lineEventCount: result.lineEventCount,
            traceStepCount: result.traceStepCount,
          }
        : null;
  return {
    ...result,
    ...(Array.isArray(result.diagnostics)
      ? {
          diagnostics: result.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            file: normalizeCSharpFile(diagnostic.file),
          })),
        }
      : {}),
    ...(normalizedEvents ? { events: normalizedEvents } : {}),
    ...(normalizedTrace ? { trace: normalizedTrace } : {}),
  };
}

async function handleMessage(message) {
  if (message.type === 'init') {
    return handleInit(message.payload?.assetBaseUrl);
  }

  if (message.type === 'warmup') {
    return warmRuntime(message.payload?.assetBaseUrl);
  }

  if (message.type === 'execute-code-batch') {
    const startedAt = now();
    const inputBatch = Array.isArray(message.payload?.inputBatch)
      ? message.payload.inputBatch.map((inputs) => (inputs && typeof inputs === 'object' ? inputs : {}))
      : [];
    if (inputBatch.length === 0) {
      return {
        success: false,
        results: [],
        error: 'C# batch execution requires a non-empty inputBatch array.',
        consoleOutput: [],
        timings: { totalMs: elapsedMs(startedAt) },
      };
    }

    const results = [];
    for (const inputs of inputBatch) {
      results.push(await handleMessage({
        type: 'execute-code',
        payload: { ...message.payload, inputs },
      }));
    }
    return {
      success: results.every((result) => result.success === true),
      results,
      consoleOutput: results.flatMap((result) => result.consoleOutput ?? []),
      timings: { totalMs: elapsedMs(startedAt) },
    };
  }

  if (
    message.type === 'execute-code' ||
    message.type === 'execute-code-interview' ||
    message.type === 'execute-with-tracing'
  ) {
    const startedAt = now();
    const runtimeStartedAt = now();
    const runtimeResult = await loadRuntime(message.payload?.assetBaseUrl);
    const initMs = elapsedMs(runtimeStartedAt) || runtimeResult.timings?.initMs || 0;
    const request = {
      source: message.payload?.code ?? '',
      functionName: message.payload?.functionName ?? '',
      inputs: message.payload?.inputs ?? {},
      executionStyle: message.payload?.executionStyle ?? 'solution-method',
      trace: message.type === 'execute-with-tracing',
      timeoutMs: message.payload?.timeoutMs,
      maxTraceSteps: message.payload?.maxTraceSteps,
      maxLineEvents: message.payload?.maxLineEvents,
      maxSingleLineHits: message.payload?.maxSingleLineHits,
      maxStoredEvents: message.payload?.maxStoredEvents,
      maxPathDepth: message.payload?.maxPathDepth,
      minimalTrace: message.payload?.minimalTrace,
    };
    const hostCallStartedAt = now();
    const result = normalizeCSharpResult(JSON.parse(executeExport(JSON.stringify(request))), request);
    const hostCallMs = elapsedMs(hostCallStartedAt);
    return {
      ...result,
      timings: {
        ...(result?.timings && typeof result.timings === 'object' ? result.timings : {}),
        initMs,
        hostCallMs,
        totalMs: elapsedMs(startedAt),
      },
    };
  }

  if (message.type === 'execute-project-csharp') {
    const startedAt = now();
    const runtimeStartedAt = now();
    const runtimeResult = await loadRuntime(message.payload?.assetBaseUrl);
    const initMs = elapsedMs(runtimeStartedAt) || runtimeResult.timings?.initMs || 0;
    const { assetBaseUrl, idleTimeoutMs, timeoutMs, ...request } = message.payload ?? {};
    const hostCallStartedAt = now();
    materializeKernelVirtualFiles(request);
    const projectIo = {
      messageId: message.id,
      request,
      protocolToken: message.protocolToken,
      stdinPipe: stdinPipeState(request?.stdinPipe),
      stdoutBytes: [],
      stderrBytes: [],
      eventStdout: [],
      eventStderr: [],
      outputBytes: { stdout: 0, stderr: 0 },
      truncatedOutputStreams: new Set(),
      liveFileChangeCount: 0,
      liveFileChangeBytes: 0,
      warnedLiveFileBudget: false,
      directDeviceOutput: false,
      stdoutDevice: '/dev/stdout',
      stderrDevice: '/dev/stderr',
      stdoutSourceDevice: undefined,
      stderrSourceDevice: undefined,
    };
    let result;
    try {
      materializeKernelDevices(request);
      activeProjectIo = projectIo;
      result = JSON.parse(executeProjectExport(JSON.stringify(projectRuntimeRequest(request))));
      flushProjectOutput('stdout');
      flushProjectOutput('stderr');
      if (activeProjectIo.directDeviceOutput) {
        result.stdout = activeProjectIo.eventStdout.join('');
        result.stderr = activeProjectIo.eventStderr.join('');
      }
      emitMissingProjectResultOutput(result);
      applyProjectResultOutputBudget(result, activeProjectIo);
    } finally {
      flushProjectOutput('stdout');
      flushProjectOutput('stderr');
      activeProjectIo = null;
    }
    const hostCallMs = elapsedMs(hostCallStartedAt);
    return {
      ...result,
      timings: {
        ...(result?.timings && typeof result.timings === 'object' ? result.timings : {}),
        initMs,
        hostCallMs,
        totalMs: elapsedMs(startedAt),
      },
    };
  }

  throw new Error(`Unsupported C# worker message type "${message.type}"`);
}

// Keep globalThis.onmessage unset before dotnet.js loads; newer .NET worker bootstraps
// use that signal to enable sidecar mode.
self.addEventListener('message', (event) => {
  const { id, type, payload, protocolToken } = event.data || {};
  if (!id) return;
  if (typeof protocolToken !== 'string') {
    self.postMessage({
      id,
      type: 'error',
      payload: { error: 'Missing C# worker protocol token.' },
    });
    return;
  }
  activeProtocolTokens.set(id, protocolToken);
  clearIdleTimer();
  applyWorkerOptions(payload);
  queuedTasks += 1;

  queue = queue
    .catch(() => {})
    .then(async () => {
      const result = await handleMessage({ id, type, payload, protocolToken });
      self.postMessage({ id, type, payload: result, protocolToken });
    })
    .catch((error) => {
      emitRuntimeDiagnostic('error', 'worker-request-failed', 'C# worker request failed.', {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
      self.postMessage({
        id,
        type: 'error',
        protocolToken,
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    })
    .finally(() => {
      activeProtocolTokens.delete(id);
      queuedTasks = Math.max(0, queuedTasks - 1);
      if (queuedTasks === 0) resetIdleTimer();
    });
});

emitRuntimeDiagnostic('info', 'worker-ready', 'C# worker is ready.');
self.postMessage({ type: 'worker-ready' });
