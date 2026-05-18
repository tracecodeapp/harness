let runtimePromise = null;
let warmupPromise = null;
let executeExport = null;
let executeProjectExport = null;
let configuredAssetBaseUrl = null;
let runtimeModule = null;
let runtimeFsHooksInstalled = false;
let activeProjectIo = null;
const WORKER_DEBUG = (() => {
  try {
    return typeof self !== 'undefined' && typeof self.location?.search === 'string' && self.location.search.includes('dev=');
  } catch {
    return false;
  }
})();
const CSHARP_DEFAULT_FILE = 'solution.cs';
const CSHARP_LEGACY_USER_FILE = 'UserCode.cs';
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const CSHARP_WARMUP_REQUEST = Object.freeze({
  source: 'public class Solution { public int Add(int a, int b) { return a + b; } }',
  functionName: 'Add',
  inputs: { a: 1, b: 2 },
  executionStyle: 'solution-method',
  trace: false,
  timeoutMs: 1_000,
});

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

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(now() - startedAt));
}

function normalizeKernelDevicePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  return normalized === '/dev/stdin' ||
    normalized === '/dev/stdout' ||
    normalized === '/dev/stderr' ||
    normalized === '/dev/tty'
    ? normalized
    : null;
}

function kernelDeviceEntries(request = activeProjectIo?.request) {
  const devices = request?.project?.kernelDevices;
  return Array.isArray(devices) ? devices : [];
}

function kernelDeviceInfo(path, request = activeProjectIo?.request) {
  const devicePath = normalizeKernelDevicePath(path);
  if (!devicePath) return null;
  for (const device of kernelDeviceEntries(request)) {
    if (normalizeKernelDevicePath(device?.path) === devicePath) return device;
  }
  return null;
}

function kernelDeviceInputSource(path, request = activeProjectIo?.request) {
  const device = kernelDeviceInfo(path, request);
  if (!device?.readable) return null;
  return normalizeKernelDevicePath(device.inputDevice) || normalizeKernelDevicePath(device.path);
}

function kernelDeviceOutputTarget(path, request = activeProjectIo?.request) {
  const device = kernelDeviceInfo(path, request);
  if (!device?.writable) return null;
  return normalizeKernelDevicePath(device.outputDevice) || normalizeKernelDevicePath(device.path);
}

function kernelDeviceStream(path) {
  return normalizeKernelDevicePath(path) === '/dev/stderr' ? 'stderr' : 'stdout';
}

function normalizeKernelVirtualManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
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

function isCreateOrTruncateOpenFlags(flags) {
  if (typeof flags === 'string') {
    return flags.includes('w') || flags.includes('a');
  }
  const numericFlags = Number(flags);
  if (!Number.isFinite(numericFlags)) return false;
  return Boolean(numericFlags & 64) || Boolean(numericFlags & 512);
}

function normalizeProjectFsPath(path, request = activeProjectIo?.request) {
  if (typeof path !== 'string' || !path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized === '/dev/stdout' || normalized === '/dev/stderr' || isKernelVirtualFsPath(normalized, request)) return null;

  const roots = ['/workspace'];
  const project = request?.project;
  if (typeof project?.cwd === 'string' && project.cwd) roots.push(project.cwd);
  if (typeof project?.workspaceRoot === 'string' && project.workspaceRoot) roots.push(project.workspaceRoot);
  if (typeof project?.workspaceAlias === 'string' && project.workspaceAlias) roots.push(project.workspaceAlias);

  for (const root of roots.sort((left, right) => right.length - left.length)) {
    const cleanRoot = root.replace(/\/+$/, '') || '/';
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

function materializeKernelVirtualFiles(request) {
  const fs = runtimeModule?.FS;
  const files = request?.project?.kernelFiles;
  if (!fs || !Array.isArray(files)) return;
  const kernelDirectories = new Set();
  for (const file of files) {
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
}

function materializeKernelDevices(request) {
  const fs = runtimeModule?.FS;
  if (!fs || typeof fs.createDevice !== 'function') return;
  ensureRuntimeDirectory(fs, '/dev');
  for (const device of kernelDeviceEntries(request)) {
    const devicePath = normalizeKernelDevicePath(device?.path);
    if (!devicePath) continue;
    const name = devicePath.slice('/dev/'.length);
    try {
      fs.unlink(devicePath);
    } catch {
      // The runtime may not have created this device yet.
    }
    fs.createDevice(
      '/dev',
      name,
      device.readable
        ? () => {
            if (!kernelDeviceInputSource(devicePath, request)) return undefined;
            return readProjectInputByte();
          }
        : undefined,
      device.writable
        ? (value) => {
            writeProjectDeviceByte(devicePath, value);
          }
        : undefined
    );
  }
}

function projectRuntimeStdin(request) {
  return kernelDeviceInputSource('/dev/stdin', request) ? String(request?.stdin || '') : '';
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
    stdin: projectRuntimeStdin(request),
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

function emitProjectEvent(payload) {
  if (!activeProjectIo?.messageId) return;
  if (payload?.type === 'output' && typeof payload.data === 'string') {
    const outputBuffer = payload.stream === 'stderr' ? activeProjectIo.eventStderr : activeProjectIo.eventStdout;
    outputBuffer.push(payload.data);
  }
  self.postMessage({ id: activeProjectIo.messageId, type: 'project-event', payload });
}

function routeProjectOutputEvent(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'output') return payload;
  const requestedDevice = normalizeKernelDevicePath(payload.device) || (payload.stream === 'stderr' ? '/dev/stderr' : '/dev/stdout');
  const outputDevice = kernelDeviceOutputTarget(requestedDevice);
  if (!outputDevice) return null;
  const stream = kernelDeviceStream(outputDevice);
  return {
    ...payload,
    stream,
    device: outputDevice,
    ...(requestedDevice !== outputDevice ? { sourceDevice: requestedDevice } : {}),
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
    ...(sourceDevice ? { sourceDevice } : {}),
    data,
  });
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
  const stream = kernelDeviceStream(outputDevice);
  const buffer = stream === 'stdout' ? context.stdoutBytes : context.stderrBytes;
  if (stream === 'stdout') {
    context.stdoutDevice = outputDevice;
    context.stdoutSourceDevice = device !== outputDevice ? device : undefined;
  } else {
    context.stderrDevice = outputDevice;
    context.stderrSourceDevice = device !== outputDevice ? device : undefined;
  }
  const byte = value & 0xff;
  buffer.push(byte);
  if (options.recordResult) context.directDeviceOutput = true;
  if (value === 10) flushProjectOutput(stream);
}

function readProjectInputByte() {
  const context = activeProjectIo;
  if (!context) return null;
  if (!kernelDeviceInputSource('/dev/stdin', context.request)) return null;
  if (context.stdinIndex >= context.stdinBytes.length) return null;
  return context.stdinBytes[context.stdinIndex++];
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
    fs.writeFile = function writeFileWithProjectEvents(path) {
      if (activeProjectIo && isKernelVirtualFsPath(path)) {
        throw Object.assign(new Error(`EROFS: read-only file system, write '${path}'`), { code: 'EROFS' });
      }
      const result = originalWriteFile.apply(this, arguments);
      if (activeProjectIo) emitProjectFileSnapshot(path);
      return result;
    };
  }

  const originalOpen = fs.open;
  if (typeof originalOpen === 'function') {
    fs.open = function openWithProjectEvents(path, flags) {
      const shouldEmitCreateSnapshot = Boolean(activeProjectIo) && isCreateOrTruncateOpenFlags(flags);
      const stream = originalOpen.apply(this, arguments);
      if (shouldEmitCreateSnapshot && stream?.path) emitProjectFileSnapshot(stream.path);
      return stream;
    };
  }

  const originalTruncate = fs.truncate;
  if (typeof originalTruncate === 'function') {
    fs.truncate = function truncateWithProjectEvents(path) {
      const result = originalTruncate.apply(this, arguments);
      if (activeProjectIo) emitProjectFileSnapshot(path);
      return result;
    };
  }

  const originalFtruncate = fs.ftruncate;
  if (typeof originalFtruncate === 'function') {
    fs.ftruncate = function ftruncateWithProjectEvents(fd) {
      const stream = typeof fs.getStream === 'function' ? fs.getStream(fd) : null;
      const result = originalFtruncate.apply(this, arguments);
      if (activeProjectIo && stream?.path) emitProjectFileSnapshot(stream.path);
      return result;
    };
  }

  const originalUnlink = fs.unlink;
  if (typeof originalUnlink === 'function') {
    fs.unlink = function unlinkWithProjectEvents(path) {
      const result = originalUnlink.apply(this, arguments);
      if (activeProjectIo) emitProjectFileDelete(path);
      return result;
    };
  }

  const originalRmdir = fs.rmdir;
  if (typeof originalRmdir === 'function') {
    fs.rmdir = function rmdirWithProjectEvents(path) {
      const result = originalRmdir.apply(this, arguments);
      if (activeProjectIo) emitProjectFileDelete(path);
      return result;
    };
  }

  const originalRename = fs.rename;
  if (typeof originalRename === 'function') {
    fs.rename = function renameWithProjectEvents(oldPath, newPath) {
      const result = originalRename.apply(this, arguments);
      if (activeProjectIo) {
        emitProjectFileDelete(oldPath);
        emitProjectFileSnapshot(newPath);
      }
      return result;
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

function normalizeCSharpResult(result) {
  if (!result || typeof result !== 'object') return result;
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
    ...(Array.isArray(result.events)
      ? {
          events: result.events.map((event) => {
            const normalizedFile = normalizeCSharpFile(event.file);
            return normalizedFile === undefined ? { ...event } : { ...event, file: normalizedFile };
          }),
        }
      : {}),
  };
}

async function handleMessage(message) {
  if (message.type === 'init') {
    return handleInit(message.payload?.assetBaseUrl);
  }

  if (message.type === 'warmup') {
    return warmRuntime(message.payload?.assetBaseUrl);
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
      minimalTrace: message.payload?.minimalTrace,
    };
    const hostCallStartedAt = now();
    const result = normalizeCSharpResult(JSON.parse(executeExport(JSON.stringify(request))));
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
    activeProjectIo = {
      messageId: message.id,
      request,
      stdinBytes: encodeUtf8(projectRuntimeStdin(request)),
      stdinIndex: 0,
      stdoutBytes: [],
      stderrBytes: [],
      eventStdout: [],
      eventStderr: [],
      directDeviceOutput: false,
      stdoutDevice: '/dev/stdout',
      stderrDevice: '/dev/stderr',
      stdoutSourceDevice: undefined,
      stderrSourceDevice: undefined,
    };
    let result;
    try {
      materializeKernelDevices(request);
      result = JSON.parse(executeProjectExport(JSON.stringify(projectRuntimeRequest(request))));
      flushProjectOutput('stdout');
      flushProjectOutput('stderr');
      if (activeProjectIo.directDeviceOutput) {
        result.stdout = activeProjectIo.eventStdout.join('');
        result.stderr = activeProjectIo.eventStderr.join('');
      }
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
  const { id, type, payload } = event.data || {};
  if (!id) return;
  clearIdleTimer();
  applyWorkerOptions(payload);
  queuedTasks += 1;

  queue = queue
    .catch(() => {})
    .then(async () => {
      const result = await handleMessage({ id, type, payload });
      self.postMessage({ id, type, payload: result });
    })
    .catch((error) => {
      emitRuntimeDiagnostic('error', 'worker-request-failed', 'C# worker request failed.', {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
      self.postMessage({
        id,
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    })
    .finally(() => {
      queuedTasks = Math.max(0, queuedTasks - 1);
      if (queuedTasks === 0) resetIdleTimer();
    });
});

emitRuntimeDiagnostic('info', 'worker-ready', 'C# worker is ready.');
self.postMessage({ type: 'worker-ready' });
