let runtimePromise = null;
const trustedCSharpWorkerPostMessage = self.postMessage.bind(self);
let warmupPromise = null;
let executeExport = null;
let executeProjectExport = null;
let configuredAssetBaseUrl = null;
let configuredRuntimeDependenciesSignature = null;
let trustedRuntimeUserAuthorityLockdown = null;
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
const CSHARP_MAX_INPUT_DEPTH = 128;
const CSHARP_MAX_INPUT_COLLECTION_ITEMS = 200_000;
const CSHARP_MAX_INPUT_OBJECT_PROPERTIES = 50_000;
const CSHARP_MAX_INPUT_TRAVERSAL_NODES = 750_000;
const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';
const TRACE_EVENT_TRANSFER_DEFAULT_CHUNK_BYTES = 64 * 1024;
const TRACE_EVENT_TRANSFER_MAX_CHUNK_BYTES = 256 * 1024;
const TRACE_EVENT_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
const TRACE_EVENT_TRANSFER_MIN_EVENTS = 128;
const CSHARP_WARMUP_REQUEST = Object.freeze({
  source: 'public class Solution { public int Add(int a, int b) { return a + b; } }',
  functionName: 'Add',
  inputs: { a: 1, b: 2 },
  executionStyle: 'solution-method',
  trace: false,
  timeoutMs: 1_000,
});

function prepareCSharpTraceEventTransfer(result, request) {
  if (
    request?.schema !== TRACE_EVENT_TRANSFER_SCHEMA ||
    request?.encoding !== 'json-utf8' ||
    typeof TextEncoder === 'undefined'
  ) {
    return null;
  }
  const events = result?.events;
  const requestedMinEvents = Number(request.minEventCount);
  const minEventCount = Number.isSafeInteger(requestedMinEvents)
    ? Math.max(TRACE_EVENT_TRANSFER_MIN_EVENTS, requestedMinEvents)
    : TRACE_EVENT_TRANSFER_MIN_EVENTS;
  if (!Array.isArray(events) || events.length < minEventCount) return null;

  let encoded;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(events));
  } catch {
    return null;
  }
  const requestedMinBytes = Number(request.minTransferBytes);
  const minTransferBytes = Number.isSafeInteger(requestedMinBytes)
    ? Math.max(0, requestedMinBytes)
    : 64 * 1024;
  if (encoded.byteLength < minTransferBytes || encoded.byteLength > TRACE_EVENT_TRANSFER_MAX_BYTES) {
    return null;
  }

  const requestedChunkBytes = Number(request.maxChunkBytes);
  const chunkBytes = Number.isSafeInteger(requestedChunkBytes)
    ? Math.max(16 * 1024, Math.min(TRACE_EVENT_TRANSFER_MAX_CHUNK_BYTES, requestedChunkBytes))
    : TRACE_EVENT_TRANSFER_DEFAULT_CHUNK_BYTES;
  const chunks = [];
  for (let offset = 0; offset < encoded.byteLength; offset += chunkBytes) {
    chunks.push(encoded.slice(offset, Math.min(encoded.byteLength, offset + chunkBytes)).buffer);
  }
  const payload = {
    ...result,
    events: [],
    ...(result?.trace && typeof result.trace === 'object' && Array.isArray(result.trace.events)
      ? { trace: { ...result.trace, events: [] } }
      : {}),
    __traceEventTransport: {
      schema: TRACE_EVENT_TRANSFER_SCHEMA,
      encoding: 'json-utf8',
      path: 'events',
      eventCount: events.length,
      byteLength: encoded.byteLength,
      chunks,
    },
  };
  return { payload, transfer: chunks };
}

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

function enterCSharpInputNode(budget, depth) {
  if (depth > CSHARP_MAX_INPUT_DEPTH) {
    throw new Error(`C# input exceeds maximum depth of ${CSHARP_MAX_INPUT_DEPTH}.`);
  }
  budget.nodes += 1;
  if (budget.nodes > CSHARP_MAX_INPUT_TRAVERSAL_NODES) {
    throw new Error(`C# input exceeds maximum JSON value count of ${CSHARP_MAX_INPUT_TRAVERSAL_NODES}.`);
  }
}

function recordCSharpInputCollectionItem(index, label) {
  if (index >= CSHARP_MAX_INPUT_COLLECTION_ITEMS) {
    throw new Error(`${label} exceeds maximum item count of ${CSHARP_MAX_INPUT_COLLECTION_ITEMS}.`);
  }
}

function recordCSharpInputObjectProperty(index, label) {
  if (index >= CSHARP_MAX_INPUT_OBJECT_PROPERTIES) {
    throw new Error(`${label} exceeds maximum property count of ${CSHARP_MAX_INPUT_OBJECT_PROPERTIES}.`);
  }
}

function validateCSharpInputElement(value, budget, depth) {
  enterCSharpInputNode(budget, depth);
  if (value === null || typeof value !== 'object') return;
  if (budget.references.has(value)) {
    throw new Error('C# input contains a circular reference.');
  }

  budget.references.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        recordCSharpInputCollectionItem(index, 'C# input array');
        validateCSharpInputElement(value[index], budget, depth + 1);
      }
      return;
    }

    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index++) {
      recordCSharpInputObjectProperty(index, 'C# input object');
      validateCSharpInputElement(value[keys[index]], budget, depth + 1);
    }
  } finally {
    budget.references.delete(value);
  }
}

function validateCSharpInputsForJson(inputs) {
  const root = inputs && typeof inputs === 'object' ? inputs : {};
  const budget = { nodes: 0, references: new WeakSet() };
  const keys = Object.keys(root);
  for (let index = 0; index < keys.length; index++) {
    recordCSharpInputObjectProperty(index, 'C# inputs');
    validateCSharpInputElement(root[keys[index]], budget, 0);
  }
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
    const marker = `\n[${payload.stream} output truncated after ${PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
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

function formatCSharpWorkerError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const serialized = JSON.stringify(error, (_key, value) => value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value);
    if (serialized && serialized !== '{}') return serialized.slice(0, 64 * 1024);
  } catch {
    // Fall through to the platform string conversion for circular objects.
  }
  return String(error);
}

function installSharedKernelPolicy(policy, scriptPath) {
  if (typeof self === 'undefined' || self.TraceRuntimeKernelPolicy) return;
  Object.defineProperty(self, 'TraceRuntimeKernelPolicy', {
    value: Object.freeze({ ...policy }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  emitRuntimeDiagnostic('info', 'shared-kernel-policy-loaded', 'Loaded shared runtime kernel policy.', { scriptPath });
}

function csharpSharedKernelPolicyUrl(workerHref = self.location.href) {
  const workerUrl = new URL(workerHref, self.location.href);
  const scriptPath = workerUrl.pathname.endsWith('/csharp/csharp-worker.js')
    ? '../shared/runtime-kernel-policy.js'
    : './shared/runtime-kernel-policy.js';
  const policyUrl = new URL(scriptPath, workerUrl);
  if (policyUrl.origin !== workerUrl.origin || !policyUrl.pathname.endsWith('/shared/runtime-kernel-policy.js')) {
    throw new Error(`C# shared kernel policy must resolve inside the worker shared asset directory: ${policyUrl.href}`);
  }
  return policyUrl.href;
}

async function loadSharedKernelPolicy() {
  if (typeof self !== 'undefined' && self.TraceRuntimeKernelPolicy) return;
  if (typeof importScripts === 'function') {
    for (const scriptPath of SHARED_KERNEL_POLICY_PATHS) {
      try {
        importScripts(scriptPath);
        if (self.TraceRuntimeKernelPolicy) {
          emitRuntimeDiagnostic('info', 'shared-kernel-policy-loaded', 'Loaded shared runtime kernel policy.', { scriptPath });
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitRuntimeDiagnostic('warn', 'shared-kernel-policy-load-failed', 'Failed to load shared runtime kernel policy.', {
          scriptPath,
          message,
        });
      }
    }
  }

  // Module workers still expose importScripts() in some browsers even though
  // invoking it throws. Fall back to the ESM policy instead of treating the
  // mere presence of importScripts as proof that this is a classic worker.
  const scriptPath = csharpSharedKernelPolicyUrl();
  const policy = await import(scriptPath);
  installSharedKernelPolicy(policy, scriptPath);
}

const sharedKernelPolicyReady = loadSharedKernelPolicy().then(() => {
  const lockdown = self.TraceRuntimeKernelPolicy?.withRuntimeUserAuthorityLockdown;
  if (typeof lockdown !== 'function') {
    const policyKeys = self.TraceRuntimeKernelPolicy && typeof self.TraceRuntimeKernelPolicy === 'object'
      ? Object.keys(self.TraceRuntimeKernelPolicy).sort().join(',')
      : '<missing>';
    throw new Error(`C# worker failed to capture the shared runtime authority lockdown policy (keys: ${policyKeys}).`);
  }
  trustedRuntimeUserAuthorityLockdown = lockdown;
});

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function withCSharpUserAuthorityLockdown(callback, mode = 'temporary') {
  if (typeof trustedRuntimeUserAuthorityLockdown !== 'function') {
    throw new Error('C# user execution requires the captured runtime authority lockdown policy.');
  }
  if (mode !== 'temporary' && mode !== 'permanent') {
    throw new Error(`Unsupported C# user authority mode: ${String(mode)}.`);
  }
  return trustedRuntimeUserAuthorityLockdown(callback, { mode });
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
  return normalized === '/proc' ||
    normalized.startsWith('/proc/') ||
    normalized === '/tracekernel' ||
    normalized.startsWith('/tracekernel/')
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

function isDirectoryOpenFlags(flags) {
  if (typeof flags === 'string') return false;
  const numericFlags = Number(flags);
  if (!Number.isFinite(numericFlags)) return false;
  // Emscripten uses the POSIX O_DIRECTORY bit when libc/.NET opens a
  // directory descriptor before getdents/readdir.
  return Boolean(numericFlags & 65_536);
}

function projectFsRoots(request = activeProjectIo?.request) {
  const roots = ['/workspace'];
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

function sanitizeCSharpProjectInternalPaths(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.split(CSHARP_PROJECT_WORKSPACE_ROOT).join('/workspace');
}

function stripCSharpUnhandledExceptionStack(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const marker = 'Unhandled exception.';
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return value;
  const prefix = value.slice(0, markerIndex);
  const unhandled = value.slice(markerIndex).replace(/\r\n?/g, '\n');
  const lines = unhandled.split('\n');
  const sanitized = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('at ') || /^--- End of .* stack trace ---$/.test(trimmed)) continue;
    sanitized.push(line.replace(/^(\s*)--->\s+/, '$1'));
  }
  return `${prefix}${sanitized.join('\n').replace(/\n{3,}/g, '\n\n')}`;
}

function sanitizeCSharpProjectStderr(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return sanitizeCSharpProjectInternalPaths(stripCSharpUnhandledExceptionStack(value));
}

function sanitizeCSharpProjectResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (typeof result.stderr === 'string') {
    result.stderr = sanitizeCSharpProjectStderr(result.stderr);
  }
  return result;
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
    try {
      ensureRuntimeDirectory(fs, runtimeDirectoryName(filePath));
    } catch (error) {
      throw new Error(
        `Failed to prepare kernel directory ${runtimeDirectoryName(filePath)} for ${filePath}: ${formatCSharpWorkerError(error)}`
      );
    }
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
    try {
      fs.writeFile(filePath, contents);
    } catch (error) {
      throw new Error(`Failed to write kernel virtual file ${filePath}: ${formatCSharpWorkerError(error)}`);
    }
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
  trustedCSharpWorkerPostMessage({
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

function emitMissingDirectDeviceResultOutput(result, context) {
  if (!result || !context) return;
  for (const stream of ['stdout', 'stderr']) {
    if (context.truncatedOutputStreams.has(stream)) continue;
    const resultText = typeof result[stream] === 'string' ? result[stream] : '';
    if (!resultText) continue;
    const emitted = (stream === 'stderr' ? context.eventStderr : context.eventStdout).join('');
    if (resultText === emitted || emitted.includes(resultText)) continue;
    const missing = resultText.startsWith(emitted) ? resultText.slice(emitted.length) : resultText;
    emitProjectOutput(stream, missing);
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
          const readOnlyDirectoryEnumeration =
            openTarget.reason === 'is-directory' &&
            isDirectoryOpenFlags(flags) &&
            isReadableOpenFlags(flags) &&
            !isWritableOpenFlags(flags) &&
            !isCreateOrTruncateOpenFlags(flags);
          if (readOnlyDirectoryEnumeration) {
            return originalOpen.apply(this, arguments);
          }
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
    trustedCSharpWorkerPostMessage({ type: 'idle-timeout' });
    self.close();
  }, idleTimeoutMs);
}

function applyWorkerOptions(payload) {
  const requestedIdleTimeoutMs = Number(payload?.idleTimeoutMs);
  if (Number.isFinite(requestedIdleTimeoutMs) && requestedIdleTimeoutMs >= 1_000) {
    idleTimeoutMs = Math.round(requestedIdleTimeoutMs);
  }
  if (payload?.runtimeDependencies !== undefined) {
    const dependencies = payload.runtimeDependencies;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error('C# worker runtimeDependencies must be an object.');
    }
    const assetBaseUrl = payload?.assetBaseUrl;
    const normalized = {};
    for (const [pathname, value] of Object.entries(dependencies)) {
      const pathSegments = pathname.split('/');
      if (
        !pathname ||
        pathname.startsWith('/') ||
        pathname.includes('\\') ||
        pathname.includes('?') ||
        pathname.includes('#') ||
        pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
        typeof value !== 'string' ||
        !value.trim()
      ) {
        throw new Error('C# runtimeDependencies must map safe deployment-relative paths to non-empty URLs.');
      }
      const expected = new URL(resolveAssetUrl(assetBaseUrl, pathname), self.location?.href).href;
      const actual = new URL(value, self.location?.href).href;
      if (expected !== actual) {
        throw new Error(
          `C# runtime dependency ${pathname} must resolve beneath assetBaseUrl (expected ${expected}, received ${actual}).`
        );
      }
      normalized[pathname] = actual;
    }
    const signature = JSON.stringify(normalized);
    if (configuredRuntimeDependenciesSignature && configuredRuntimeDependenciesSignature !== signature) {
      throw new Error('C# runtime dependencies cannot change after worker configuration.');
    }
    configuredRuntimeDependenciesSignature = signature;
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

function csharpStringLiteral(value) {
  return JSON.stringify(String(value ?? ''));
}

function csharpIdentifier(value) {
  const text = String(value ?? '');
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : null;
}

function splitCSharpLeadingUsingSource(code) {
  const lines = String(code ?? '').split(/\r?\n/);
  const prelude = [];
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (
      trimmed === '' ||
      trimmed.startsWith('//') ||
      /^using\s+/.test(trimmed) && trimmed.endsWith(';') ||
      /^extern\s+alias\s+/.test(trimmed) && trimmed.endsWith(';')
    ) {
      prelude.push(line);
      continue;
    }
    break;
  }
  return {
    prelude: prelude.join('\n'),
    body: lines.slice(index).join('\n'),
  };
}

function indentCSharpSource(code, spaces = 4) {
  const prefix = ' '.repeat(spaces);
  return String(code ?? '')
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `${prefix}${line}` : line))
    .join('\n');
}

function splitCSharpParameterList(source) {
  const parameters = [];
  let current = '';
  let genericDepth = 0;
  let bracketDepth = 0;
  for (const char of String(source ?? '')) {
    if (char === '<') genericDepth += 1;
    else if (char === '>') genericDepth = Math.max(0, genericDepth - 1);
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === ',' && genericDepth === 0 && bracketDepth === 0) {
      parameters.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parameters.push(current.trim());
  return parameters;
}

function parseCSharpBatchParameter(source, index) {
  let withoutDefault = String(source ?? '').replace(/=.*/, '').trim();
  while (/^\s*\[[^\]]+\]\s*/.test(withoutDefault)) {
    withoutDefault = withoutDefault.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
  }
  if (!withoutDefault) return null;
  const parts = withoutDefault.split(/\s+/).filter(Boolean);
  let modifier = '';
  while (parts.length > 0 && ['this', 'params', 'ref', 'out', 'in'].includes(parts[0])) {
    const next = parts.shift();
    if (next === 'ref' || next === 'out' || next === 'in') modifier = next;
  }
  const name = csharpIdentifier(parts.pop());
  const type = parts.join(' ').trim();
  if (!name || !type) return null;
  return { name, type, modifier, index };
}

function parseCSharpBatchCallableSignature(code, functionName) {
  const requestedMethodName = csharpIdentifier(functionName);
  if (!requestedMethodName) return null;
  const escapedName = requestedMethodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `((?:(?:public|private|protected|internal|static|virtual|override|sealed|new|async|extern|partial)\\s+)*)` +
      `([A-Za-z_][A-Za-z0-9_<>.,?\\[\\]\\s]*?)\\s+(${escapedName})\\s*\\(([^)]*)\\)`,
    'im'
  );
  const match = pattern.exec(String(code ?? ''));
  if (!match) return null;
  const methodName = csharpIdentifier(match[3]) ?? requestedMethodName;
  const parameters = splitCSharpParameterList(match[4])
    .map((parameter, index) => parseCSharpBatchParameter(parameter, index));
  if (parameters.some((parameter) => !parameter)) return null;
  return {
    methodName,
    returnType: match[2].trim(),
    isStatic: /\bstatic\b/.test(match[1] || ''),
    parameters,
  };
}

function buildCSharpDirectBatchScriptSource(payload) {
  const code = String(payload?.code ?? '');
  const executionStyle = payload?.executionStyle ?? 'solution-method';
  const functionName = String(payload?.functionName ?? '');
  if (!functionName.trim() || executionStyle === 'ops-class') return null;
  const signature = parseCSharpBatchCallableSignature(code, functionName);
  if (!signature) return null;
  const declarations = [];
  const argumentsList = [];
  for (const parameter of signature.parameters) {
    const localName = `__tracecodeArg${parameter.index}`;
    if (parameter.modifier === 'out') {
      declarations.push(`    ${parameter.type} ${localName} = default!;`);
    } else {
      declarations.push(`    var ${localName} = TraceCode.Internal.TraceCodeJsonInput.Read<${parameter.type}>(${csharpStringLiteral(parameter.name)}, ${parameter.index});`);
    }
    argumentsList.push(`${parameter.modifier ? `${parameter.modifier} ` : ''}${localName}`);
  }
  const receiver = executionStyle === 'function'
    ? ''
    : signature.isStatic
      ? 'Solution.'
      : '__tracecodeSolution.';
  const solutionDeclaration = executionStyle === 'function' || signature.isStatic
    ? ''
    : '    var __tracecodeSolution = new Solution();\n';
  const callExpression = `${receiver}${signature.methodName}(${argumentsList.join(', ')})`;
  const returnsVoid = signature.returnType === 'void';
  const invocation = returnsVoid
    ? `    ${callExpression};\n    return ${signature.parameters.length > 0 ? '__tracecodeArg0' : 'null'};`
    : `    return ${callExpression};`;

  return `${code}

object? result;
{
    var __tracecodeBatchCases = TraceCode.Internal.TraceCodeJsonInput.Read<System.Text.Json.JsonElement[]>("__tracecodeBatchInputs", 0) ?? System.Array.Empty<System.Text.Json.JsonElement>();
    var __tracecodeBatchResults = new System.Collections.Generic.List<object?>();

    foreach (var __tracecodeBatchCase in __tracecodeBatchCases)
    {
        var __tracecodeBatchClock = System.Diagnostics.Stopwatch.StartNew();
        var __tracecodeOriginalOut = System.Console.Out;
        using var __tracecodeCaseOut = new System.IO.StringWriter();
        try
        {
            System.Console.SetOut(__tracecodeCaseOut);
            __TraceCodeSetCurrentInputsJson(__tracecodeBatchCase.GetRawText());
            object? __tracecodeOutput = __TraceCodeRunBatchCase();
            __tracecodeBatchClock.Stop();
            __tracecodeBatchResults.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["success"] = true,
                ["output"] = __tracecodeOutput,
                ["consoleOutput"] = __TraceCodeSplitConsole(__tracecodeCaseOut.ToString()),
                ["timings"] = new System.Collections.Generic.Dictionary<string, object?> { ["runMs"] = __tracecodeBatchClock.Elapsed.TotalMilliseconds },
            });
        }
        catch (System.Exception __tracecodeError)
        {
            __tracecodeBatchClock.Stop();
            __tracecodeBatchResults.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["success"] = false,
                ["error"] = __tracecodeError.GetBaseException().Message,
                ["output"] = null,
                ["consoleOutput"] = __TraceCodeSplitConsole(__tracecodeCaseOut.ToString()),
                ["timings"] = new System.Collections.Generic.Dictionary<string, object?> { ["runMs"] = __tracecodeBatchClock.Elapsed.TotalMilliseconds },
            });
        }
        finally
        {
            System.Console.SetOut(__tracecodeOriginalOut);
        }
    }

    result = __tracecodeBatchResults;
}

object? __TraceCodeRunBatchCase()
{
${solutionDeclaration}${declarations.join('\n')}
${invocation}
}

void __TraceCodeSetCurrentInputsJson(string __tracecodeInputsJson)
{
    var __tracecodeField = typeof(TraceCode.CSharpHost.CompilerHost).GetField(
        "currentInputsJson",
        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
    __tracecodeField?.SetValue(null, __tracecodeInputsJson);
}

string[] __TraceCodeSplitConsole(string __tracecodeText) =>
    __tracecodeText.Replace("\\r\\n", "\\n", System.StringComparison.Ordinal).Split('\\n', System.StringSplitOptions.RemoveEmptyEntries);
`;
}

function buildCSharpBatchScriptSource(payload) {
  const code = String(payload?.code ?? '');
  const executionStyle = payload?.executionStyle ?? 'solution-method';
  const functionName = String(payload?.functionName ?? '');
  const functionNameLiteral = csharpStringLiteral(functionName);
  const directBatchSource = buildCSharpDirectBatchScriptSource(payload);
  if (directBatchSource) return directBatchSource;

  if (executionStyle === 'ops-class') {
    const className = csharpIdentifier(functionName);
    if (!className) {
      throw new Error('C# ops-class batch execution requires a simple class name.');
    }
    return `${code}

object? result;
{
    var __tracecodeBatchCases = TraceCode.Internal.TraceCodeJsonInput.Read<System.Text.Json.JsonElement[]>("__tracecodeBatchInputs", 0) ?? System.Array.Empty<System.Text.Json.JsonElement>();
    var __tracecodeBatchResults = new System.Collections.Generic.List<object?>();

    foreach (var __tracecodeBatchCase in __tracecodeBatchCases)
    {
        var __tracecodeBatchClock = System.Diagnostics.Stopwatch.StartNew();
        var __tracecodeOriginalOut = System.Console.Out;
        using var __tracecodeCaseOut = new System.IO.StringWriter();
        try
        {
            System.Console.SetOut(__tracecodeCaseOut);
            object? __tracecodeOutput = __TraceCodeRunOpsCase(__tracecodeBatchCase);
            __tracecodeBatchClock.Stop();
            __tracecodeBatchResults.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["success"] = true,
                ["output"] = __tracecodeOutput,
                ["consoleOutput"] = __TraceCodeSplitConsole(__tracecodeCaseOut.ToString()),
                ["timings"] = new System.Collections.Generic.Dictionary<string, object?> { ["runMs"] = __tracecodeBatchClock.Elapsed.TotalMilliseconds },
            });
        }
        catch (System.Exception __tracecodeError)
        {
            __tracecodeBatchClock.Stop();
            __tracecodeBatchResults.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["success"] = false,
                ["error"] = __tracecodeError.GetBaseException().Message,
                ["output"] = null,
                ["consoleOutput"] = __TraceCodeSplitConsole(__tracecodeCaseOut.ToString()),
                ["timings"] = new System.Collections.Generic.Dictionary<string, object?> { ["runMs"] = __tracecodeBatchClock.Elapsed.TotalMilliseconds },
            });
        }
        finally
        {
            System.Console.SetOut(__tracecodeOriginalOut);
        }
    }

    result = __tracecodeBatchResults;
}

object? __TraceCodeRunOpsCase(System.Text.Json.JsonElement __tracecodeRawCase)
{
    string[] __tracecodeOperations = __TraceCodeReadCaseValue<string[]>(__tracecodeRawCase, "operations", 0) ?? System.Array.Empty<string>();
    System.Text.Json.JsonElement[][] __tracecodeArguments = __TraceCodeReadCaseValue<System.Text.Json.JsonElement[][]>(__tracecodeRawCase, "arguments", 1) ?? System.Array.Empty<System.Text.Json.JsonElement[]>();
    if (__tracecodeOperations.Length != __tracecodeArguments.Length)
    {
        throw new System.InvalidOperationException("operations and arguments must have the same length");
    }

    System.Type __tracecodeTargetType = typeof(${className});
    object? __tracecodeInstance = null;
    var __tracecodeOutput = new System.Collections.Generic.List<object?>();
    for (int __tracecodeIndex = 0; __tracecodeIndex < __tracecodeOperations.Length; __tracecodeIndex++)
    {
        string __tracecodeOperation = __tracecodeOperations[__tracecodeIndex];
        System.Text.Json.JsonElement[] __tracecodeRawArgs = __tracecodeIndex < __tracecodeArguments.Length ? __tracecodeArguments[__tracecodeIndex] : System.Array.Empty<System.Text.Json.JsonElement>();
        if (__tracecodeInstance is null && (__tracecodeIndex == 0
            || string.Equals(__tracecodeOperation, ${csharpStringLiteral(className)}, System.StringComparison.OrdinalIgnoreCase)
            || string.Equals(__tracecodeOperation, "__init__", System.StringComparison.OrdinalIgnoreCase)))
        {
            var __tracecodeConstructor = __tracecodeTargetType
                .GetConstructors(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
                .FirstOrDefault(__tracecodeCandidate => __tracecodeCandidate.GetParameters().Length == __tracecodeRawArgs.Length)
                ?? throw new System.InvalidOperationException($"No constructor with {__tracecodeRawArgs.Length} arguments.");
            __tracecodeInstance = __tracecodeConstructor.Invoke(__TraceCodeConvertArgs(__tracecodeRawArgs, __tracecodeConstructor.GetParameters()));
            __tracecodeOutput.Add(null);
            continue;
        }

        if (__tracecodeInstance is null)
        {
            throw new System.InvalidOperationException("Ops-class operation invoked before constructor.");
        }

        var __tracecodeMethod = __tracecodeTargetType
            .GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
            .FirstOrDefault(__tracecodeCandidate =>
                string.Equals(__tracecodeCandidate.Name, __tracecodeOperation, System.StringComparison.OrdinalIgnoreCase)
                && __tracecodeCandidate.GetParameters().Length == __tracecodeRawArgs.Length)
            ?? throw new System.InvalidOperationException($"No method {__tracecodeOperation} with {__tracecodeRawArgs.Length} arguments.");
        object?[] __tracecodeArgs = __TraceCodeConvertArgs(__tracecodeRawArgs, __tracecodeMethod.GetParameters());
        object? __tracecodeResult = __tracecodeMethod.Invoke(__tracecodeInstance, __tracecodeArgs);
        __tracecodeOutput.Add(__tracecodeMethod.ReturnType == typeof(void) ? null : __tracecodeResult);
    }
    return __tracecodeOutput;
}

object?[] __TraceCodeConvertArgs(System.Text.Json.JsonElement[] __tracecodeRawArgs, System.Reflection.ParameterInfo[] __tracecodeParameters)
{
    object?[] __tracecodeConverted = new object?[__tracecodeParameters.Length];
    for (int __tracecodeIndex = 0; __tracecodeIndex < __tracecodeParameters.Length; __tracecodeIndex++)
    {
        System.Type __tracecodeTargetType = __tracecodeParameters[__tracecodeIndex].ParameterType;
        if (__tracecodeTargetType.IsByRef)
        {
            __tracecodeTargetType = __tracecodeTargetType.GetElementType() ?? typeof(object);
        }
        __tracecodeConverted[__tracecodeIndex] = TraceCode.Internal.TraceCodeJsonInput.Convert(__tracecodeRawArgs[__tracecodeIndex], __tracecodeTargetType);
    }
    return __tracecodeConverted;
}

T? __TraceCodeReadCaseValue<T>(System.Text.Json.JsonElement __tracecodeRawCase, string __tracecodeName, int __tracecodeIndex)
{
    if (__TraceCodeTryGetCaseValue(__tracecodeRawCase, __tracecodeName, __tracecodeIndex, out var __tracecodeValue))
    {
        return (T?)TraceCode.Internal.TraceCodeJsonInput.Convert(__tracecodeValue, typeof(T));
    }
    return default;
}

bool __TraceCodeTryGetCaseValue(System.Text.Json.JsonElement __tracecodeRawCase, string __tracecodeName, int __tracecodeIndex, out System.Text.Json.JsonElement __tracecodeValue)
{
    if (__tracecodeRawCase.ValueKind == System.Text.Json.JsonValueKind.Object)
    {
        if (__tracecodeRawCase.TryGetProperty(__tracecodeName, out __tracecodeValue))
        {
            return true;
        }
        int __tracecodePropertyIndex = 0;
        foreach (var __tracecodeProperty in __tracecodeRawCase.EnumerateObject())
        {
            if (__tracecodePropertyIndex == __tracecodeIndex)
            {
                __tracecodeValue = __tracecodeProperty.Value;
                return true;
            }
            __tracecodePropertyIndex++;
        }
    }
    __tracecodeValue = default;
    return false;
}

string[] __TraceCodeSplitConsole(string __tracecodeText) =>
    __tracecodeText.Replace("\\r\\n", "\\n", System.StringComparison.Ordinal).Split('\\n', System.StringSplitOptions.RemoveEmptyEntries);
`;
  }

  if (executionStyle === 'function' && functionName.trim() === '') {
    const scriptSource = splitCSharpLeadingUsingSource(code);
    return `${scriptSource.prelude}

object? __TraceCodeUserScriptRun()
{
${indentCSharpSource(scriptSource.body)}
    return result;
}

object? result;
{
    var __tracecodeBatchCases = TraceCode.Internal.TraceCodeJsonInput.Read<System.Text.Json.JsonElement[]>("__tracecodeBatchInputs", 0) ?? System.Array.Empty<System.Text.Json.JsonElement>();
    var __tracecodeBatchResults = new System.Collections.Generic.List<object?>();

    foreach (var __tracecodeBatchCase in __tracecodeBatchCases)
    {
        var __tracecodeBatchClock = System.Diagnostics.Stopwatch.StartNew();
        var __tracecodeOriginalOut = System.Console.Out;
        using var __tracecodeCaseOut = new System.IO.StringWriter();
        try
        {
            System.Console.SetOut(__tracecodeCaseOut);
            __TraceCodeSetCurrentInputsJson(__tracecodeBatchCase.GetRawText());
            object? __tracecodeOutput = __TraceCodeUserScriptRun();
            __tracecodeBatchClock.Stop();
            __tracecodeBatchResults.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["success"] = true,
                ["output"] = __tracecodeOutput,
                ["consoleOutput"] = __TraceCodeSplitConsole(__tracecodeCaseOut.ToString()),
                ["timings"] = new System.Collections.Generic.Dictionary<string, object?> { ["runMs"] = __tracecodeBatchClock.Elapsed.TotalMilliseconds },
            });
        }
        catch (System.Exception __tracecodeError)
        {
            __tracecodeBatchClock.Stop();
            __tracecodeBatchResults.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["success"] = false,
                ["error"] = __tracecodeError.GetBaseException().Message,
                ["output"] = null,
                ["consoleOutput"] = __TraceCodeSplitConsole(__tracecodeCaseOut.ToString()),
                ["timings"] = new System.Collections.Generic.Dictionary<string, object?> { ["runMs"] = __tracecodeBatchClock.Elapsed.TotalMilliseconds },
            });
        }
        finally
        {
            System.Console.SetOut(__tracecodeOriginalOut);
        }
    }

    result = __tracecodeBatchResults;
}

void __TraceCodeSetCurrentInputsJson(string __tracecodeInputsJson)
{
    var __tracecodeField = typeof(TraceCode.CSharpHost.CompilerHost).GetField(
        "currentInputsJson",
        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
    __tracecodeField?.SetValue(null, __tracecodeInputsJson);
}

string[] __TraceCodeSplitConsole(string __tracecodeText) =>
    __tracecodeText.Replace("\\r\\n", "\\n", System.StringComparison.Ordinal).Split('\\n', System.StringSplitOptions.RemoveEmptyEntries);
`;
  }

  return `${code}

object? result;
{
    var __tracecodeBatchCases = TraceCode.Internal.TraceCodeJsonInput.Read<System.Text.Json.JsonElement[]>("__tracecodeBatchInputs", 0) ?? System.Array.Empty<System.Text.Json.JsonElement>();
    var __tracecodeBatchResults = new System.Collections.Generic.List<object?>();

    foreach (var __tracecodeBatchCase in __tracecodeBatchCases)
    {
        var __tracecodeBatchClock = System.Diagnostics.Stopwatch.StartNew();
        var __tracecodeOriginalOut = System.Console.Out;
        using var __tracecodeCaseOut = new System.IO.StringWriter();
        try
        {
            System.Console.SetOut(__tracecodeCaseOut);
            object? __tracecodeOutput = __TraceCodeRunSolutionCase(__tracecodeBatchCase);
            __tracecodeBatchClock.Stop();
            __tracecodeBatchResults.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["success"] = true,
                ["output"] = __tracecodeOutput,
                ["consoleOutput"] = __TraceCodeSplitConsole(__tracecodeCaseOut.ToString()),
                ["timings"] = new System.Collections.Generic.Dictionary<string, object?> { ["runMs"] = __tracecodeBatchClock.Elapsed.TotalMilliseconds },
            });
        }
        catch (System.Exception __tracecodeError)
        {
            __tracecodeBatchClock.Stop();
            __tracecodeBatchResults.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["success"] = false,
                ["error"] = __tracecodeError.GetBaseException().Message,
                ["output"] = null,
                ["consoleOutput"] = __TraceCodeSplitConsole(__tracecodeCaseOut.ToString()),
                ["timings"] = new System.Collections.Generic.Dictionary<string, object?> { ["runMs"] = __tracecodeBatchClock.Elapsed.TotalMilliseconds },
            });
        }
        finally
        {
            System.Console.SetOut(__tracecodeOriginalOut);
        }
    }

    result = __tracecodeBatchResults;
}

object? __TraceCodeRunSolutionCase(System.Text.Json.JsonElement __tracecodeRawCase)
{
    var __tracecodeMethod = __TraceCodeSelectSolutionMethod(__tracecodeRawCase);
    var __tracecodeParameters = __tracecodeMethod.GetParameters();
    object?[] __tracecodeArgs = new object?[__tracecodeParameters.Length];
    for (int __tracecodeIndex = 0; __tracecodeIndex < __tracecodeParameters.Length; __tracecodeIndex++)
    {
        var __tracecodeParameter = __tracecodeParameters[__tracecodeIndex];
        System.Type __tracecodeTargetType = __TraceCodeParameterType(__tracecodeParameter);
        if (__tracecodeParameter.IsOut)
        {
            __tracecodeArgs[__tracecodeIndex] = __TraceCodeDefaultValue(__tracecodeTargetType);
            continue;
        }
        if (__TraceCodeTryGetCaseValue(__tracecodeRawCase, __tracecodeParameter.Name ?? string.Empty, __tracecodeIndex, out var __tracecodeValue))
        {
            __tracecodeArgs[__tracecodeIndex] = TraceCode.Internal.TraceCodeJsonInput.Convert(__tracecodeValue, __tracecodeTargetType);
            continue;
        }
        if (__tracecodeParameter.HasDefaultValue)
        {
            __tracecodeArgs[__tracecodeIndex] = __tracecodeParameter.DefaultValue;
            continue;
        }
        throw new System.InvalidOperationException($"Missing input value for parameter \\"{__tracecodeParameter.Name}\\".");
    }

    object? __tracecodeInstance = __tracecodeMethod.IsStatic ? null : System.Activator.CreateInstance(__tracecodeMethod.DeclaringType!);
    object? __tracecodeOutput = __tracecodeMethod.Invoke(__tracecodeInstance, __tracecodeArgs);
    if (__tracecodeMethod.ReturnType == typeof(void))
    {
        return __TraceCodeShouldReturnFirstVoidArgument(__tracecodeParameters) ? __tracecodeArgs[0] : null;
    }
    return __tracecodeOutput;
}

System.Reflection.MethodInfo __TraceCodeSelectSolutionMethod(System.Text.Json.JsonElement __tracecodeRawCase)
{
    var __tracecodeMethods = typeof(Solution)
        .GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Instance)
        .Where(__tracecodeMethod => string.Equals(__tracecodeMethod.Name, ${functionNameLiteral}, System.StringComparison.Ordinal))
        .ToArray();
    if (__tracecodeMethods.Length == 0)
    {
        __tracecodeMethods = typeof(Solution)
            .GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Instance)
            .Where(__tracecodeMethod => string.Equals(__tracecodeMethod.Name, ${functionNameLiteral}, System.StringComparison.OrdinalIgnoreCase))
            .ToArray();
    }
    if (__tracecodeMethods.Length == 0)
    {
        throw new System.InvalidOperationException($"Expected public method Solution.${functionName}.");
    }

    var __tracecodeCompatible = __tracecodeMethods
        .Select(__tracecodeMethod => new { Method = __tracecodeMethod, Score = __TraceCodeScoreMethod(__tracecodeMethod, __tracecodeRawCase) })
        .Where(__tracecodeCandidate => __tracecodeCandidate.Score > int.MinValue)
        .OrderByDescending(__tracecodeCandidate => __tracecodeCandidate.Method.IsPublic)
        .ThenByDescending(__tracecodeCandidate => __tracecodeCandidate.Score)
        .Select(__tracecodeCandidate => __tracecodeCandidate.Method)
        .FirstOrDefault();
    return __tracecodeCompatible ?? __tracecodeMethods.FirstOrDefault(__tracecodeMethod => __tracecodeMethod.IsPublic) ?? __tracecodeMethods[0];
}

int __TraceCodeScoreMethod(System.Reflection.MethodInfo __tracecodeMethod, System.Text.Json.JsonElement __tracecodeRawCase)
{
    int __tracecodeScore = 0;
    var __tracecodeParameters = __tracecodeMethod.GetParameters();
    for (int __tracecodeIndex = 0; __tracecodeIndex < __tracecodeParameters.Length; __tracecodeIndex++)
    {
        var __tracecodeParameter = __tracecodeParameters[__tracecodeIndex];
        if (__tracecodeParameter.IsOut)
        {
            __tracecodeScore += 1;
            continue;
        }
        if (!__TraceCodeTryGetCaseValue(__tracecodeRawCase, __tracecodeParameter.Name ?? string.Empty, __tracecodeIndex, out var __tracecodeValue))
        {
            if (__tracecodeParameter.HasDefaultValue)
            {
                continue;
            }
            return int.MinValue;
        }
        try
        {
            _ = TraceCode.Internal.TraceCodeJsonInput.Convert(__tracecodeValue, __TraceCodeParameterType(__tracecodeParameter));
            __tracecodeScore += 4;
        }
        catch
        {
            return int.MinValue;
        }
    }
    return __tracecodeScore;
}

System.Type __TraceCodeParameterType(System.Reflection.ParameterInfo __tracecodeParameter)
{
    System.Type __tracecodeType = __tracecodeParameter.ParameterType;
    return __tracecodeType.IsByRef ? __tracecodeType.GetElementType() ?? typeof(object) : __tracecodeType;
}

object? __TraceCodeDefaultValue(System.Type __tracecodeType) =>
    __tracecodeType.IsValueType && System.Nullable.GetUnderlyingType(__tracecodeType) is null
        ? System.Activator.CreateInstance(__tracecodeType)
        : null;

bool __TraceCodeShouldReturnFirstVoidArgument(System.Reflection.ParameterInfo[] __tracecodeParameters)
{
    if (__tracecodeParameters.Length == 0)
    {
        return false;
    }
    var __tracecodeType = __TraceCodeParameterType(__tracecodeParameters[0]);
    return __tracecodeParameters[0].ParameterType.IsByRef
        || __tracecodeType.IsArray
        || (!__tracecodeType.IsPrimitive
            && __tracecodeType != typeof(string)
            && __tracecodeType != typeof(decimal)
            && __tracecodeType != typeof(System.DateTime));
}

bool __TraceCodeTryGetCaseValue(System.Text.Json.JsonElement __tracecodeRawCase, string __tracecodeName, int __tracecodeIndex, out System.Text.Json.JsonElement __tracecodeValue)
{
    if (__tracecodeRawCase.ValueKind == System.Text.Json.JsonValueKind.Object)
    {
        if (__tracecodeRawCase.TryGetProperty(__tracecodeName, out __tracecodeValue))
        {
            return true;
        }
        int __tracecodePropertyIndex = 0;
        foreach (var __tracecodeProperty in __tracecodeRawCase.EnumerateObject())
        {
            if (__tracecodePropertyIndex == __tracecodeIndex)
            {
                __tracecodeValue = __tracecodeProperty.Value;
                return true;
            }
            __tracecodePropertyIndex++;
        }
    }
    __tracecodeValue = default;
    return false;
}

string[] __TraceCodeSplitConsole(string __tracecodeText) =>
    __tracecodeText.Replace("\\r\\n", "\\n", System.StringComparison.Ordinal).Split('\\n', System.StringSplitOptions.RemoveEmptyEntries);
`;
}

function normalizeCSharpBatchEntry(entry, timings = {}) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const success = source.success === true;
  return {
    success,
    output: success ? (source.output ?? null) : null,
    ...(success ? {} : { error: source.error ?? 'C# batch item failed without runtime diagnostics' }),
    consoleOutput: Array.isArray(source.consoleOutput) ? source.consoleOutput : [],
    timings: {
      ...(source.timings && typeof source.timings === 'object' ? source.timings : {}),
      ...timings,
    },
  };
}

function csharpBatchIsolationReason(payload) {
  if (payload?.executionStyle === 'ops-class') {
    return 'ops-class-reflection';
  }
  const code = String(payload?.code ?? '');
  if (/\bstatic\b/.test(code)) {
    return 'static-storage';
  }
  return '';
}

async function executeCSharpCodePayload(payload, messageType = 'execute-code') {
  const startedAt = now();
  const request = {
    source: payload?.code ?? '',
    functionName: payload?.functionName ?? '',
    inputs: payload?.inputs ?? {},
    executionStyle: payload?.executionStyle ?? 'solution-method',
    trace: messageType === 'execute-with-tracing',
    timeoutMs: payload?.timeoutMs,
    maxTraceSteps: payload?.maxTraceSteps,
    maxLineEvents: payload?.maxLineEvents,
    maxSingleLineHits: payload?.maxSingleLineHits,
    maxStoredEvents: payload?.maxStoredEvents,
    maxPathDepth: payload?.maxPathDepth,
    minimalTrace: payload?.minimalTrace,
  };
  try {
    validateCSharpInputsForJson(request.inputs);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      timings: { totalMs: elapsedMs(startedAt) },
    };
  }
  const runtimeStartedAt = now();
  const runtimeResult = await loadRuntime(payload?.assetBaseUrl);
  const initMs = elapsedMs(runtimeStartedAt) || runtimeResult.timings?.initMs || 0;
  const hostCallStartedAt = now();
  const result = await withCSharpUserAuthorityLockdown(() =>
    normalizeCSharpResult(JSON.parse(executeExport(JSON.stringify(request))), request)
  );
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

async function executeCSharpCodeBatch(message) {
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

  try {
    for (const inputs of inputBatch) {
      validateCSharpInputsForJson(inputs);
    }
  } catch (error) {
    return {
      success: false,
      results: [],
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      timings: { totalMs: elapsedMs(startedAt) },
    };
  }

  const isolationReason = csharpBatchIsolationReason(message.payload ?? {});
  if (isolationReason) {
    const results = [];
    for (const inputs of inputBatch) {
      const result = await executeCSharpCodePayload({ ...message.payload, inputs }, 'execute-code');
      results.push(normalizeCSharpBatchEntry(result, result.timings));
    }
    const consoleOutput = results.flatMap((entry) => entry.consoleOutput ?? []);
    const success = results.every((entry) => entry.success === true);
    return {
      success,
      results,
      consoleOutput,
      ...(success ? {} : { error: results.find((entry) => entry.success !== true)?.error ?? 'C# batch execution failed.' }),
      timings: {
        totalMs: elapsedMs(startedAt),
        batchMode: 'per-case-fallback',
        batchCaseCount: inputBatch.length,
        batchFallbackReason: isolationReason,
        runMs: results.reduce((sum, entry) => sum + (entry.timings?.runMs ?? 0), 0),
      },
    };
  }

  let batchSource;
  try {
    batchSource = buildCSharpBatchScriptSource(message.payload ?? {});
  } catch (error) {
    return {
      success: false,
      results: [],
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      timings: { totalMs: elapsedMs(startedAt) },
    };
  }

  const result = await executeCSharpCodePayload({
    ...message.payload,
    code: batchSource,
    functionName: '',
    executionStyle: 'function',
    inputs: { __tracecodeBatchInputs: inputBatch },
  }, 'execute-code');
  const batchEntries = Array.isArray(result?.output) ? result.output : [];
  const results = batchEntries.map((entry) => normalizeCSharpBatchEntry(entry));
  const consoleOutput = results.flatMap((entry) => entry.consoleOutput ?? []);
  const success = results.length === inputBatch.length && results.every((entry) => entry.success === true);
  return {
    success,
    results,
    consoleOutput,
    ...(success ? {} : { error: result?.error ?? results.find((entry) => entry.success !== true)?.error ?? 'C# batch execution failed.' }),
    timings: {
      ...(result?.timings && typeof result.timings === 'object' ? result.timings : {}),
      totalMs: elapsedMs(startedAt),
      batchMode: 'compile-once',
      batchCaseCount: inputBatch.length,
      runMs: results.reduce((sum, entry) => sum + (entry.timings?.runMs ?? 0), 0),
    },
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
    return executeCSharpCodeBatch(message);
  }

  if (
    message.type === 'execute-code' ||
    message.type === 'execute-code-interview' ||
    message.type === 'execute-with-tracing'
  ) {
    return executeCSharpCodePayload(message.payload, message.type);
  }

  if (message.type === 'execute-project-csharp') {
    const startedAt = now();
    const runtimeStartedAt = now();
    const runtimeResult = await loadRuntime(message.payload?.assetBaseUrl);
    const initMs = elapsedMs(runtimeStartedAt) || runtimeResult.timings?.initMs || 0;
    const {
      assetBaseUrl,
      idleTimeoutMs,
      timeoutMs,
      projectUserAuthorityMode = 'temporary',
      ...request
    } = message.payload ?? {};
    const hostCallStartedAt = now();
    try {
      materializeKernelVirtualFiles(request);
    } catch (error) {
      throw new Error(`C# project virtual-file setup failed: ${formatCSharpWorkerError(error)}`);
    }
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
      try {
        materializeKernelDevices(request);
      } catch (error) {
        throw new Error(`C# project device setup failed: ${formatCSharpWorkerError(error)}`);
      }
      activeProjectIo = projectIo;
      try {
        result = await withCSharpUserAuthorityLockdown(
          () => JSON.parse(executeProjectExport(JSON.stringify(projectRuntimeRequest(request)))),
          projectUserAuthorityMode
        );
      } catch (error) {
        throw new Error(`C# project host call failed: ${formatCSharpWorkerError(error)}`);
      }
      flushProjectOutput('stdout');
      flushProjectOutput('stderr');
      if (activeProjectIo.directDeviceOutput) {
        emitMissingDirectDeviceResultOutput(result, activeProjectIo);
        result.stdout = activeProjectIo.eventStdout.join('');
        result.stderr = activeProjectIo.eventStderr.join('');
      }
      sanitizeCSharpProjectResult(result);
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
    trustedCSharpWorkerPostMessage({
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
      await sharedKernelPolicyReady;
      const result = await handleMessage({ id, type, payload, protocolToken });
      const transported = type === 'execute-with-tracing'
        ? prepareCSharpTraceEventTransfer(result, payload?.traceEventTransport)
        : null;
      trustedCSharpWorkerPostMessage(
        { id, type, payload: transported?.payload ?? result, protocolToken },
        transported?.transfer ?? []
      );
    })
    .catch((error) => {
      const errorMessage = formatCSharpWorkerError(error);
      emitRuntimeDiagnostic('error', 'worker-request-failed', 'C# worker request failed.', {
        type,
        message: errorMessage,
      });
      trustedCSharpWorkerPostMessage({
        id,
        type: 'error',
        protocolToken,
        payload: { error: errorMessage },
      });
    })
    .finally(() => {
      activeProtocolTokens.delete(id);
      queuedTasks = Math.max(0, queuedTasks - 1);
      if (queuedTasks === 0) resetIdleTimer();
    });
});

sharedKernelPolicyReady
  .then(() => {
    emitRuntimeDiagnostic('info', 'worker-ready', 'C# worker is ready.');
    trustedCSharpWorkerPostMessage({ type: 'worker-ready' });
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    emitRuntimeDiagnostic('error', 'shared-kernel-policy-load-failed', 'Failed to load shared runtime kernel policy.', {
      message,
    });
    trustedCSharpWorkerPostMessage({
      type: 'worker-error',
      payload: { error: message },
    });
  });
