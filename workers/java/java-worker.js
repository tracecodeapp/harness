const DEFAULT_CHEERPJ_LOADER_URL = '/app/workers/vendor/cheerpj-loader.js';
const trustedJavaWorkerPostMessage = self.postMessage.bind(self);
const trustedJavaWorkerFetch = typeof self.fetch === 'function' ? self.fetch.bind(self) : null;
const trustedJavaIndexedDB = self.indexedDB;
const trustedJavaProviderRuntimeFetchPrefixes = Array.isArray(
  self.TraceCodeJavaProviderRuntimeFetchPrefixes
)
  ? self.TraceCodeJavaProviderRuntimeFetchPrefixes
      .filter((value) => typeof value === 'string' && value.length > 0)
      .map((value) => new URL(value, self.location.href).href)
  : [];
let HELPER_JAR_PATH = '/app/workers/vendor/java-browser-helper.jar';
let JDK17_COMPILER_JAR_PATH = '/app/workers/vendor/jdk.compiler-17.jar';
let REWRITER_JAR_PATH = '/app/workers/vendor/java-rewriter.jar';
let JAVAPARSER_JAR_PATH = '/app/workers/vendor/javaparser-core-3.25.10.jar';

const FULL_CLASSPATH = () => {
  return [
    REWRITER_JAR_PATH,
    HELPER_JAR_PATH,
    JDK17_COMPILER_JAR_PATH,
    JAVAPARSER_JAR_PATH,
  ].join(':');
};
const DEFAULT_COMPILER_DEBUG_PROFILE = 'full';
const DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE = 'none';
const DEFAULT_MAX_STORED_EVENTS = 50_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_JAVA_COMPILE_CACHE_LIMIT = 16;
const MAX_JAVA_COMPILE_CACHE_LIMIT = 64;
const JAVA_COMPILE_CACHE_VERSION = 'classic-compiled-classes-v1';
const SCRIPT_METHOD_NAME = '__tracecodeScript';
const DYNAMIC_INPUT_PREFIX = '/str/tracecode-java-input';
const PREPARED_INPUT_PROPERTY_PREFIX = 'tracecode.prepared.input.';
const JAVA_DEFAULT_IMPORTS = [
  'import java.util.*;',
  'import java.io.*;',
  'import java.math.*;',
  'import java.util.stream.*;',
  'import javafx.util.Pair;',
];
const WORKER_DEBUG = (() => {
  try {
    return typeof self !== 'undefined' && typeof self.location?.search === 'string' && self.location.search.includes('dev=');
  } catch {
    return false;
  }
})();

function emitRuntimeDiagnostic(level, phase, message, detail) {
  if (!WORKER_DEBUG && level !== 'error') return;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  console[method]('[TraceRuntime]', {
    schema: 'tracecode.runtime-diagnostic.v1',
    source: 'harness',
    component: 'JavaWorker',
    runtime: 'java',
    phase,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

function javaWorkerHref() {
  if (typeof self !== 'undefined' && typeof self.location?.href === 'string') {
    return self.location.href;
  }
  return 'http://localhost/workers/java/java-worker.js';
}

function assertTrustedJavaAsset(name, url) {
  const value = String(url ?? '').trim();
  if (value.length === 0) {
    throw new Error(`${name} must reference a local /app/ asset path.`);
  }
  if (typeof URL !== 'function') {
    if (value.startsWith('/app/')) return value;
    throw new Error(`${name} must reference a local /app/ asset path.`);
  }
  const workerHref = javaWorkerHref();
  const workerOrigin = new URL(workerHref).origin;
  const parsed = new URL(value, workerHref);
  if (parsed.origin === workerOrigin && parsed.pathname.startsWith('/app/')) {
    return parsed.href;
  }

  throw new Error(`${name} must reference a local /app/ asset path.`);
}

function assertConfiguredJavaAsset(name, url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error(`${name} must be a non-empty URL.`);
  }
  // CheerpJ's /app namespace is a virtual filesystem path, not an ordinary
  // page-relative URL. Preserve it for JAR classpaths instead of converting it
  // to an HTTP URL that CheerpJ cannot mount.
  if (url.startsWith('/app/')) return url;
  if (typeof URL !== 'function') {
    if (/^https?:\/\//iu.test(url)) return url;
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  const parsed = new URL(url, javaWorkerHref());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  return parsed.href;
}

function resolveCheerpjLoaderUrl(payload) {
  const manifestLoaderUrl = payload?.runtimeAssets?.loaderUrl;
  if (manifestLoaderUrl !== undefined) {
    return assertConfiguredJavaAsset('Configured CheerpJ loader', manifestLoaderUrl);
  }
  const configuredUrl = payload?.cheerpjLoaderUrl;
  if (configuredUrl === undefined || configuredUrl === null || String(configuredUrl).trim().length === 0) {
    return DEFAULT_CHEERPJ_LOADER_URL;
  }
  if (typeof configuredUrl !== 'string') {
    throw new Error('Java worker init payload.cheerpjLoaderUrl must be a string when provided.');
  }
  return assertTrustedJavaAsset('CheerpJ loader', configuredUrl);
}

function javaSharedKernelPolicyUrl(workerHref = javaWorkerHref()) {
  if (typeof URL !== 'function') {
    return 'http://localhost/workers/shared/runtime-kernel-policy-classic.js';
  }
  const workerUrl = new URL(workerHref);
  const relativePolicyPath = workerUrl.pathname.endsWith('/java/java-worker.js')
    ? '../shared/runtime-kernel-policy-classic.js'
    : './shared/runtime-kernel-policy-classic.js';
  const policyUrl = new URL(relativePolicyPath, workerUrl.href);
  if (
    policyUrl.origin !== workerUrl.origin ||
    !policyUrl.pathname.endsWith('/workers/shared/runtime-kernel-policy-classic.js')
  ) {
    throw new Error('Java shared runtime kernel policy path must resolve inside the worker shared asset directory.');
  }
  return policyUrl.href;
}

if (typeof self.importScripts === 'function') {
  const scriptPath = javaSharedKernelPolicyUrl();
  try {
    self.importScripts(scriptPath);
    emitRuntimeDiagnostic('info', 'shared-kernel-policy-loaded', 'Loaded shared runtime kernel policy.', { scriptPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitRuntimeDiagnostic('warn', 'shared-kernel-policy-load-failed', 'Failed to load shared runtime kernel policy.', {
      scriptPath,
      message,
    });
  }
  self.importScripts('java-source-augmentations.js');
}

const trustedJavaUserAuthorityLockdown = self.TraceRuntimeKernelPolicy?.withRuntimeUserAuthorityLockdown;

let workerReadyPromise = null;
let idleTimer = null;
let queue = Promise.resolve();
let helperLibraryPromise = null;
let compileLibraryClassPromise = null;
let rewriteLibraryClassPromise = null;
let idleGeneration = 0;
let initLoadTimeMs = null;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
let cheerpjLoaderUrl = DEFAULT_CHEERPJ_LOADER_URL;
let configuredJavaRuntimeAssetsSignature = null;
let runWarmupPromise = null;
let allowIsolatedRuntimeStorage = false;
let cheerpjRuntimeFetchPrefixes = [];
let cheerpjRuntimeFetchExactUrls = new Set();
let activeJavaProjectIo = null;
let javaCompileIsolationCounter = 0;
let javaProjectBridgeRunCounter = 0;
let javaCompileCacheLimit = DEFAULT_JAVA_COMPILE_CACHE_LIMIT;
const javaCompileCache = new Map();
const preparedJavaRuntimePrograms = new Map();
const activeProtocolTokens = new Map();
const pendingExternalJavaCompiles = new Map();
const pendingCompilerArtifactCacheRequests = new Map();
const STDIN_PIPE_HEADER_INTS = 3;
const STDIN_PIPE_HEADER_BYTES = STDIN_PIPE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const STDIN_PIPE_READ_INDEX = 0;
const STDIN_PIPE_WRITE_INDEX = 1;
const STDIN_PIPE_CLOSED_INDEX = 2;
const JAVA_HTTP_SYNC_HEADER_BYTES = 8;
const JAVA_HTTP_SYNC_BUFFER_BYTES = 4 * 1024 * 1024;
const JAVA_HTTP_SYNC_TIMEOUT_MS = 30_000;
const JAVA_HTTP_SYNC_STATE_INDEX = 0;
const JAVA_HTTP_SYNC_LENGTH_INDEX = 1;
const JAVA_HTTP_SYNC_IDLE = 0;
const JAVA_HTTP_SYNC_REQUEST = 1;
const JAVA_HTTP_SYNC_RESPONSE = 2;
const JAVA_HTTP_SYNC_CLOSED = 3;
const PROJECT_MAX_OUTPUT_STREAM_BYTES = 1024 * 1024;
const PROJECT_MAX_LIVE_FILE_CHANGES = 1024;
const PROJECT_MAX_LIVE_FILE_CHANGE_BYTES = 4 * 1024 * 1024;
const JAVA_MAX_DIAGNOSTIC_CHARS = 64 * 1024;
const JAVA_MAX_DIAGNOSTIC_PATH_CHARS = 512;
const JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS = 2048;
const JAVA_MAX_LOOP_HEADER_SNAPSHOT_CACHE = 2048;
const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';
const TRACE_EVENT_TRANSFER_DEFAULT_CHUNK_BYTES = 64 * 1024;
const TRACE_EVENT_TRANSFER_MAX_CHUNK_BYTES = 256 * 1024;
const TRACE_EVENT_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
const TRACE_EVENT_TRANSFER_MIN_EVENTS = 128;
const javaHttpServers = new Map();
let nextJavaHttpServerId = 1;

function prepareTraceEventTransfer(result, request, path) {
  if (
    request?.schema !== TRACE_EVENT_TRANSFER_SCHEMA ||
    request?.encoding !== 'json-utf8' ||
    typeof TextEncoder === 'undefined'
  ) {
    return null;
  }
  const events = path === 'trace.events' ? result?.trace?.events : result?.events;
  const requestedMinEvents = Number(request.minEventCount);
  const minEventCount = Number.isSafeInteger(requestedMinEvents)
    ? Math.max(TRACE_EVENT_TRANSFER_MIN_EVENTS, requestedMinEvents)
    : TRACE_EVENT_TRANSFER_MIN_EVENTS;
  if (!Array.isArray(events) || events.length < minEventCount) return null;

  // NDJSON skips JSON.stringify here and JSON.parse client-side. Only flat
  // string events qualify; embedded newlines (never produced by the trace
  // hooks, which escape control characters) would corrupt the framing, so
  // any hit falls back to the JSON encoding.
  const ndjsonEligible =
    Array.isArray(request.acceptEncodings) &&
    request.acceptEncodings.includes('ndjson-utf8') &&
    path !== 'results[].trace.events' &&
    events.every(
      (event) => typeof event === 'string' && !event.includes('\n')
    );
  let encoding = 'json-utf8';
  let encoded;
  try {
    if (ndjsonEligible) {
      encoding = 'ndjson-utf8';
      encoded = new TextEncoder().encode(events.join('\n'));
    } else {
      encoded = new TextEncoder().encode(JSON.stringify(events));
    }
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
  const payload = path === 'trace.events'
    ? { ...result, trace: { ...result.trace, events: [] } }
    : { ...result, events: [] };
  payload.__traceEventTransport = {
    schema: TRACE_EVENT_TRANSFER_SCHEMA,
    encoding,
    path,
    eventCount: events.length,
    byteLength: encoded.byteLength,
    chunks,
  };
  return { payload, transfer: chunks };
}

function javaHttpEncodeUtf8(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(value ?? ''));
  const text = unescape(encodeURIComponent(String(value ?? '')));
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

function javaHttpDecodeUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  return decodeURIComponent(escape(text));
}

function projectUtf8Bytes(value) {
  return javaHttpEncodeUtf8(String(value ?? '')).byteLength;
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

function applyJavaProjectEventBudget(context, payload) {
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
        emitRuntimeDiagnostic('warn', 'project-event-budget', 'Dropped oversized Java live file-change event.', {
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

function applyJavaProjectResultOutputBudget(result, context) {
  if (!result || !context) return;
  if (context.truncatedOutputStreams.has('stdout')) {
    result.stdout = context.eventStdout.join('');
  }
  if (context.truncatedOutputStreams.has('stderr')) {
    result.stderr = context.eventStderr.join('');
  }
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

function readJavaProjectInputByte(device, block = true) {
  const context = activeJavaProjectIo;
  if (!context?.stdinPipe) return -1;
  const inputDevice = kernelDeviceInputSource(String(device || '/dev/stdin'), context.request);
  if (!inputDevice || inputDevice === '/dev/null') return -1;
  const state = context.stdinPipe;
  const capacity = state.bytes.byteLength;
  while (true) {
    const readIndex = Atomics.load(state.header, STDIN_PIPE_READ_INDEX);
    const writeIndex = Atomics.load(state.header, STDIN_PIPE_WRITE_INDEX);
    if (stdinPipeAvailable(state, readIndex, writeIndex) > 0) {
      const byte = state.bytes[readIndex];
      Atomics.store(state.header, STDIN_PIPE_READ_INDEX, (readIndex + 1) % capacity);
      return byte;
    }
    const closed = Atomics.load(state.header, STDIN_PIPE_CLOSED_INDEX) !== 0;
    if (closed || !block) return -1;
    Atomics.wait(state.header, STDIN_PIPE_WRITE_INDEX, writeIndex);
  }
}

function javaProjectInputAvailable(device) {
  const context = activeJavaProjectIo;
  if (!context?.stdinPipe) return 0;
  const inputDevice = kernelDeviceInputSource(String(device || '/dev/stdin'), context.request);
  if (!inputDevice || inputDevice === '/dev/null') return 0;
  const state = context.stdinPipe;
  const readIndex = Atomics.load(state.header, STDIN_PIPE_READ_INDEX);
  const writeIndex = Atomics.load(state.header, STDIN_PIPE_WRITE_INDEX);
  return stdinPipeAvailable(state, readIndex, writeIndex);
}

function postMessageResponse(message, options = {}) {
  const protocolToken = message?.protocolToken ?? (message?.id ? activeProtocolTokens.get(message.id) : undefined);
  const transported = prepareTraceEventTransfer(
    message?.payload,
    options.traceEventTransport,
    options.traceEventPath
  );
  trustedJavaWorkerPostMessage({
    ...message,
    ...(transported ? { payload: transported.payload } : {}),
    ...(protocolToken ? { protocolToken } : {}),
  }, transported?.transfer ?? []);
}

function javaHttpBase64FromString(value) {
  const bytes = javaHttpEncodeUtf8(String(value ?? ''));
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function javaHttpErrorManifest(message) {
  return `ERROR\n${javaHttpBase64FromString(message || 'Network request failed')}`;
}

function dispatchJavaProjectHttpSync(requestJson) {
  const context = activeJavaProjectIo;
  if (!context?.messageId) {
    return javaHttpErrorManifest('Network subsystem is unavailable');
  }
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined' || typeof Atomics.wait !== 'function') {
    return javaHttpErrorManifest('Network subsystem is unavailable');
  }
  let request;
  try {
    request = JSON.parse(String(requestJson ?? ''));
  } catch (error) {
    return javaHttpErrorManifest('Invalid network request');
  }
  const timeoutMs = Number(request?._tracekernelTimeoutMs);
  if (request && typeof request === 'object') {
    delete request._tracekernelTimeoutMs;
  }
  const buffer = new SharedArrayBuffer(JAVA_HTTP_SYNC_HEADER_BYTES + JAVA_HTTP_SYNC_BUFFER_BYTES);
  const header = new Int32Array(buffer, 0, 2);
  try {
    postMessageResponse({
      id: context.messageId,
      type: 'kernel-http-dispatch-sync',
      payload: {
        request,
        buffer,
        ...(Number.isFinite(timeoutMs) ? { timeoutMs: Math.max(1, Math.ceil(timeoutMs)) } : {}),
      },
    });
    const waitResult = Atomics.wait(header, 0, 0, JAVA_HTTP_SYNC_TIMEOUT_MS);
    if (waitResult === 'timed-out') {
      return javaHttpErrorManifest('Network request timed out');
    }
    const length = Atomics.load(header, 1);
    if (!Number.isFinite(length) || length < 0 || length > JAVA_HTTP_SYNC_BUFFER_BYTES) {
      return javaHttpErrorManifest('Invalid network response');
    }
    return javaHttpDecodeUtf8(new Uint8Array(buffer, JAVA_HTTP_SYNC_HEADER_BYTES, length));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return javaHttpErrorManifest(message || 'Network request failed');
  }
}

function registerJavaProjectHttpServerSync(host, port) {
  const context = activeJavaProjectIo;
  if (!context?.messageId) {
    return javaHttpErrorManifest('Network subsystem is unavailable');
  }
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined' || typeof Atomics.wait !== 'function') {
    return javaHttpErrorManifest('Network subsystem is unavailable');
  }
  const serverId = `java-http-${nextJavaHttpServerId++}`;
  const requestBuffer = new SharedArrayBuffer(JAVA_HTTP_SYNC_HEADER_BYTES + JAVA_HTTP_SYNC_BUFFER_BYTES);
  const controlBuffer = new SharedArrayBuffer(JAVA_HTTP_SYNC_HEADER_BYTES + 16 * 1024);
  const controlHeader = new Int32Array(controlBuffer, 0, 2);
  javaHttpServers.set(serverId, { requestBuffer, controlBuffer });
  try {
    postMessageResponse({
      id: context.messageId,
      type: 'kernel-http-listen-sync',
      payload: {
        serverId,
        options: {
          host: String(host || '127.0.0.1'),
          port: Number.isFinite(Number(port)) ? Number(port) : 0,
        },
        requestBuffer,
        controlBuffer,
      },
    });
    const waitResult = Atomics.wait(controlHeader, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_IDLE, JAVA_HTTP_SYNC_TIMEOUT_MS);
    if (waitResult === 'timed-out') {
      javaHttpServers.delete(serverId);
      return javaHttpErrorManifest('Network listener registration timed out');
    }
    const length = Atomics.load(controlHeader, JAVA_HTTP_SYNC_LENGTH_INDEX);
    const manifest = javaHttpDecodeUtf8(new Uint8Array(controlBuffer, JAVA_HTTP_SYNC_HEADER_BYTES, Math.max(0, Math.min(length, 16 * 1024))));
    if (!manifest.startsWith('OK\n')) {
      javaHttpServers.delete(serverId);
      return manifest || javaHttpErrorManifest('Network listener registration failed');
    }
    return `OK\n${serverId}`;
  } catch (error) {
    javaHttpServers.delete(serverId);
    const message = error instanceof Error ? error.message : String(error);
    return javaHttpErrorManifest(message || 'Network listener registration failed');
  }
}

function pollJavaProjectHttpServerRequest(serverId) {
  const server = javaHttpServers.get(String(serverId || ''));
  if (!server) return javaHttpErrorManifest('Network listener is closed');
  const header = new Int32Array(server.requestBuffer, 0, 2);
  while (true) {
    const state = Atomics.load(header, JAVA_HTTP_SYNC_STATE_INDEX);
    if (state === JAVA_HTTP_SYNC_REQUEST) {
      const length = Atomics.load(header, JAVA_HTTP_SYNC_LENGTH_INDEX);
      return javaHttpDecodeUtf8(new Uint8Array(server.requestBuffer, JAVA_HTTP_SYNC_HEADER_BYTES, Math.max(0, Math.min(length, JAVA_HTTP_SYNC_BUFFER_BYTES))));
    }
    if (state === JAVA_HTTP_SYNC_CLOSED) {
      return javaHttpErrorManifest('Network listener is closed');
    }
    Atomics.wait(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_IDLE, JAVA_HTTP_SYNC_TIMEOUT_MS);
  }
}

function completeJavaProjectHttpServerRequest(serverId, responseManifest) {
  const server = javaHttpServers.get(String(serverId || ''));
  if (!server) return;
  const header = new Int32Array(server.requestBuffer, 0, 2);
  const bytes = new Uint8Array(server.requestBuffer, JAVA_HTTP_SYNC_HEADER_BYTES);
  const encoded = javaHttpEncodeUtf8(String(responseManifest ?? javaHttpErrorManifest('Network listener returned an empty response')));
  bytes.set(encoded.subarray(0, bytes.byteLength));
  Atomics.store(header, JAVA_HTTP_SYNC_LENGTH_INDEX, Math.min(encoded.byteLength, bytes.byteLength));
  Atomics.store(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_RESPONSE);
  Atomics.notify(header, JAVA_HTTP_SYNC_STATE_INDEX);
}

function closeJavaProjectHttpServer(serverId) {
  const server = javaHttpServers.get(String(serverId || ''));
  if (!server) return;
  javaHttpServers.delete(String(serverId || ''));
  // Do not overwrite an unread RESPONSE: the client's in-flight dispatch
  // still has to consume it. The client finishes the close once drained.
  const header = new Int32Array(server.requestBuffer, 0, 2);
  Atomics.compareExchange(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_IDLE, JAVA_HTTP_SYNC_CLOSED);
  Atomics.compareExchange(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_REQUEST, JAVA_HTTP_SYNC_CLOSED);
  Atomics.notify(header, JAVA_HTTP_SYNC_STATE_INDEX);
  postMessageResponse({
    id: activeJavaProjectIo?.messageId,
    type: 'kernel-http-close',
    payload: {
      type: 'kernel-http-close',
      serverId: String(serverId || ''),
      requestBuffer: server.requestBuffer,
    },
  });
}

function closeAllJavaProjectHttpServers() {
  for (const serverId of Array.from(javaHttpServers.keys())) {
    closeJavaProjectHttpServer(serverId);
  }
}

function isJavaHarnessStackFrame(line) {
  const trimmed = String(line ?? '').trim();
  const candidates = [trimmed];
  if (trimmed.startsWith('at ')) {
    const target = trimmed.slice(3);
    // Java 9+ stack traces may prefix frames with a module, or with both a
    // class-loader and a module (for example java.base/java.lang.reflect...).
    // Classify the underlying frame as well as the rendered, qualified form.
    const firstSeparator = target.indexOf('/');
    if (firstSeparator >= 0) {
      const firstPrefix = target.slice(0, firstSeparator);
      const afterFirstPrefix = target.slice(firstSeparator + 1);
      if (firstPrefix.includes('.') || firstPrefix.includes('@')) {
        candidates.push(`at ${afterFirstPrefix}`);
      }
      const secondSeparator = afterFirstPrefix.indexOf('/');
      if (secondSeparator >= 0) {
        const modulePrefix = afterFirstPrefix.slice(0, secondSeparator);
        if (modulePrefix === '' || modulePrefix.includes('.') || modulePrefix.includes('@')) {
          candidates.push(`at ${afterFirstPrefix.slice(secondSeparator + 1)}`);
        }
      }
    }
  }
  return candidates.some((candidate) => (
    /^at tracecode(?:\.|\$)/.test(candidate) ||
    /^at tracecode\//.test(candidate) ||
    /^at harness(?:\.|\/)user(?:\.|\/)[^(]*(?:Exports[^.(\/]*)(?:\.|\/)/.test(candidate) ||
    /^at java(?:\.|\/)lang(?:\.|\/)invoke(?:\.|\/)/.test(candidate) ||
    /^at java(?:\.|\/)lang(?:\.|\/)reflect(?:\.|\/)Method\.invoke/.test(candidate) ||
    /^at jdk(?:\.|\/)internal(?:\.|\/)reflect(?:\.|\/)/.test(candidate) ||
    /^at jdk(?:\.|\/)internal(?:\.|\/)tracecode(?:\.|\/)/.test(candidate) ||
    candidate.startsWith('at com.leaningtech.cheerpj.CheerpJLibrary.')
  ));
}

function sanitizeJavaRuntimeStderr(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) return stderr;
  return stderr
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !isJavaHarnessStackFrame(line))
    .join('\n');
}

function sanitizeJavaCompilerDiagnostic(output) {
  if (typeof output !== 'string' || output.length === 0) return output;
  return output
    .replace(/\r\n/g, '\n')
    .replace(/(?:\/str\/|\/tracejvm\/compile-\d+\/)([^/\n]+\.java)/g, '$1');
}

function createJavaProjectBridgeRunId(requestId) {
  const cryptoSource = globalThis.crypto ?? (typeof self !== 'undefined' ? self.crypto : undefined);
  if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') {
    const values = new Uint32Array(4);
    cryptoSource.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
  }
  javaProjectBridgeRunCounter += 1;
  return `${String(requestId ?? '')}:${Date.now().toString(36)}:${javaProjectBridgeRunCounter.toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function activeJavaProjectEventContext(bridgeRunId) {
  if (
    typeof bridgeRunId !== 'string' ||
    bridgeRunId.length === 0 ||
    !activeJavaProjectIo?.messageId ||
    activeJavaProjectIo.bridgeRunId !== bridgeRunId
  ) {
    return null;
  }
  return activeJavaProjectIo;
}

function emitLiveJavaProjectOutput(bridgeRunId, stream, data, sourceDevice, outputDevice) {
  const context = activeJavaProjectEventContext(bridgeRunId);
  if (!context || typeof data !== 'string' || data.length === 0) return;
  const normalizedStream = stream === 'stderr' ? 'stderr' : 'stdout';
  const sourceDevicePath = normalizeKernelManifestDevicePath(sourceDevice);
  const requestedOutputDevice = normalizeKernelManifestDevicePath(outputDevice) || (normalizedStream === 'stderr' ? '/dev/stderr' : '/dev/stdout');
  const outputDevicePath = kernelDeviceOutputTarget(requestedOutputDevice, context.request)
    || (normalizedStream === 'stderr' ? '/dev/stderr' : '/dev/stdout');
  const eventStream = outputDevicePath === '/dev/stderr' ? 'stderr' : normalizedStream;
  const outputData = eventStream === 'stderr' ? sanitizeJavaRuntimeStderr(data) : data;
  if (outputData.length === 0) return;
  postProjectEvent(context.messageId, {
    type: 'output',
    stream: eventStream,
    device: outputDevicePath,
    ...(sourceDevicePath && sourceDevicePath !== outputDevicePath && kernelDeviceOutputTarget(sourceDevicePath, context.request) === outputDevicePath
      ? { sourceDevice: sourceDevicePath }
      : {}),
    data: outputData,
  }, { context });
}

function emitLiveJavaProjectFileSnapshot(bridgeRunId, path, contents) {
  const context = activeJavaProjectEventContext(bridgeRunId);
  if (!context || typeof path !== 'string' || path.length === 0 || typeof contents !== 'string') {
    return;
  }
  postProjectEvent(context.messageId, {
    type: 'file-change',
    phase: 'live',
    change: {
      path: normalizeProjectFilePath(path),
      contents,
      encoding: 'base64',
    },
  }, { context });
}

function emitLiveJavaProjectFileDelete(bridgeRunId, path) {
  const context = activeJavaProjectEventContext(bridgeRunId);
  if (!context || typeof path !== 'string' || path.length === 0) return;
  postProjectEvent(context.messageId, {
    type: 'file-change',
    phase: 'live',
    change: {
      path: normalizeProjectFilePath(path),
      deleted: true,
    },
  }, { context });
}

function emitLiveJavaProjectDirectoryCreate(bridgeRunId, path) {
  const context = activeJavaProjectEventContext(bridgeRunId);
  if (!context || typeof path !== 'string' || path.length === 0) return;
  postProjectEvent(context.messageId, {
    type: 'file-change',
    phase: 'live',
    change: {
      path: normalizeProjectFilePath(path),
      directory: true,
    },
  }, { context });
}

function emitLiveJavaProjectDirectoryDelete(bridgeRunId, path) {
  const context = activeJavaProjectEventContext(bridgeRunId);
  if (!context || typeof path !== 'string' || path.length === 0) return;
  postProjectEvent(context.messageId, {
    type: 'file-change',
    phase: 'live',
    change: {
      path: normalizeProjectFilePath(path),
      directory: true,
      deleted: true,
    },
  }, { context });
}

function javaProjectNativeBridge() {
  return {
    Java_tracecode_browser_ProjectEvents_emitOutputNative: (_library, bridgeRunId, stream, data, sourceDevice, outputDevice) => {
      emitLiveJavaProjectOutput(String(bridgeRunId ?? ''), String(stream ?? 'stdout'), String(data ?? ''), String(sourceDevice ?? ''), String(outputDevice ?? ''));
    },
    Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative: (_library, bridgeRunId, path, contents) => {
      emitLiveJavaProjectFileSnapshot(String(bridgeRunId ?? ''), String(path ?? ''), String(contents ?? ''));
    },
    Java_tracecode_browser_ProjectEvents_emitFileDeleteNative: (_library, bridgeRunId, path) => {
      emitLiveJavaProjectFileDelete(String(bridgeRunId ?? ''), String(path ?? ''));
    },
    Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative: (_library, bridgeRunId, path) => {
      emitLiveJavaProjectDirectoryCreate(String(bridgeRunId ?? ''), String(path ?? ''));
    },
    Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative: (_library, bridgeRunId, path) => {
      emitLiveJavaProjectDirectoryDelete(String(bridgeRunId ?? ''), String(path ?? ''));
    },
    Java_tracecode_browser_ProjectEvents_readInputNative: (_library, device) => (
      readJavaProjectInputByte(String(device ?? '/dev/stdin'), true)
    ),
    Java_tracecode_browser_ProjectEvents_readInputAvailableNative: (_library, device) => (
      readJavaProjectInputByte(String(device ?? '/dev/stdin'), false)
    ),
    Java_tracecode_browser_ProjectEvents_inputAvailableNative: (_library, device) => (
      javaProjectInputAvailable(String(device ?? '/dev/stdin'))
    ),
    Java_tracecode_browser_ProjectEvents_dispatchHttpNative: (_library, requestJson) => (
      dispatchJavaProjectHttpSync(String(requestJson ?? ''))
    ),
    Java_tracecode_browser_ProjectEvents_registerHttpServerNative: (_library, host, port) => (
      registerJavaProjectHttpServerSync(String(host ?? '127.0.0.1'), Number(port ?? 0))
    ),
    Java_tracecode_browser_ProjectEvents_pollHttpServerRequestNative: (_library, serverId) => (
      pollJavaProjectHttpServerRequest(String(serverId ?? ''))
    ),
    Java_tracecode_browser_ProjectEvents_completeHttpServerRequestNative: (_library, serverId, responseManifest) => {
      completeJavaProjectHttpServerRequest(String(serverId ?? ''), String(responseManifest ?? ''));
    },
    Java_tracecode_browser_ProjectEvents_closeHttpServerNative: (_library, serverId) => {
      closeJavaProjectHttpServer(String(serverId ?? ''));
    },
  };
}

function javaDefaultImportsBlock() {
  return JAVA_DEFAULT_IMPORTS.join('\n');
}

function addJavaDefaultImportsToPackagedSource(source) {
  const importBlock = javaDefaultImportsBlock();
  return String(source).replace(
    /^(package\s+[A-Za-z_][A-Za-z0-9_.]*\s*;\s*\n+)/,
    `$1${importBlock}\n`
  );
}

function formatWorkerErrorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (error && typeof error === 'object') {
    const directKeys = ['message', 'detail', 'reason', 'cause', 'stack', 'name', 'className'];
    for (const key of directKeys) {
      try {
        const value = error[key];
        if (typeof value === 'string' && value.length > 0) {
          return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
          return String(value);
        }
      } catch {}
    }
    try {
      const propertyNames = Object.getOwnPropertyNames(error);
      for (const key of propertyNames) {
        const value = error[key];
        if (typeof value === 'string' && value.length > 0) {
          return `${key}: ${value}`;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
          return `${key}: ${String(value)}`;
        }
      }
    } catch {}
    try {
      const tag = Object.prototype.toString.call(error);
      if (tag && tag.includes('ParseProblemException')) {
        return 'Java syntax error.';
      }
      if (tag && tag !== '[object Object]' && !tag.startsWith('[object ')) {
        return tag;
      }
    } catch {}
    try {
      if (typeof error.toString === 'function' && error.toString !== Object.prototype.toString) {
        const value = error.toString();
        if (value.includes('ParseProblemException')) {
          return 'Java syntax error.';
        }
        if (typeof value === 'string' && value.length > 0 && value !== '[object Object]') {
          return value;
        }
      }
    } catch {}
  }
  try {
    const stringified = String(error);
    if (stringified.includes('ParseProblemException')) {
      return 'Java syntax error.';
    }
    if (stringified && stringified !== '[object Object]') {
      return stringified;
    }
  } catch {}
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') {
      return json;
    }
  } catch {}
  return 'Unknown Java worker error';
}

async function formatWorkerErrorMessageAsync(error) {
  const synchronous = formatWorkerErrorMessage(error);
  if (synchronous !== 'Unknown Java worker error') return synchronous;
  if (!error || typeof error !== 'object') return synchronous;

  // CheerpJ rejects Java calls with an asynchronous Java-object proxy. Its
  // message is not an own JavaScript property, so the synchronous formatter
  // cannot see it. Resolve the Java Throwable API before crossing the worker
  // boundary; otherwise consumers only receive "Unknown Java worker error".
  try {
    if (typeof error.getMessage === 'function') {
      const message = await error.getMessage();
      if (typeof message === 'string' && message.length > 0) return message;
    }
  } catch {}
  try {
    if (typeof error.toString === 'function') {
      const message = await error.toString();
      if (typeof message === 'string' && message.length > 0 && message !== '[object Object]') {
        return message;
      }
    }
  } catch {}
  return synchronous;
}

function makeWorkerStageError(stage, error) {
  return new Error(`Java worker ${stage} failed: ${formatWorkerErrorMessage(error)}`);
}

function resetIdleTimer() {
  idleGeneration += 1;
  const generation = idleGeneration;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    if (generation !== idleGeneration) return;
    postMessageResponse({ type: 'idle-timeout' });
    self.close();
  }, idleTimeoutMs);
}

function applyWorkerOptions(payload) {
  const nextIdleTimeoutMs = Number(payload?.idleTimeoutMs);
  if (Number.isFinite(nextIdleTimeoutMs) && nextIdleTimeoutMs > 0) {
    idleTimeoutMs = Math.max(1_000, Math.floor(nextIdleTimeoutMs));
  }
  const nextCompileCacheLimit = Number(payload?.compileCacheLimit);
  if (Number.isFinite(nextCompileCacheLimit) && nextCompileCacheLimit >= 0) {
    javaCompileCacheLimit = Math.min(MAX_JAVA_COMPILE_CACHE_LIMIT, Math.floor(nextCompileCacheLimit));
  }
  if (payload?.allowIsolatedRuntimeStorage === true) {
    if (!trustedJavaIndexedDB) {
      throw new Error('Isolated Java runtime storage requires IndexedDB.');
    }
    allowIsolatedRuntimeStorage = true;
  }
  const runtimeAssets = payload?.runtimeAssets;
  if (runtimeAssets !== undefined) {
    if (!runtimeAssets || typeof runtimeAssets !== 'object' || Array.isArray(runtimeAssets)) {
      throw new Error('Java worker runtimeAssets must be an object.');
    }
    const normalized = {
      ...(runtimeAssets.loaderUrl ? {
        loaderUrl: assertConfiguredJavaAsset('Configured CheerpJ loader', runtimeAssets.loaderUrl),
      } : {}),
      ...(runtimeAssets.helperJarUrl ? {
        helperJarUrl: assertConfiguredJavaAsset('Configured Java helper jar', runtimeAssets.helperJarUrl),
      } : {}),
      ...(runtimeAssets.compilerJarUrl ? {
        compilerJarUrl: assertConfiguredJavaAsset('Configured Java compiler jar', runtimeAssets.compilerJarUrl),
      } : {}),
      ...(runtimeAssets.rewriterJarUrl ? {
        rewriterJarUrl: assertConfiguredJavaAsset('Configured Java rewriter jar', runtimeAssets.rewriterJarUrl),
      } : {}),
      ...(runtimeAssets.parserJarUrl ? {
        parserJarUrl: assertConfiguredJavaAsset('Configured Java parser jar', runtimeAssets.parserJarUrl),
      } : {}),
    };
    const signature = JSON.stringify(normalized);
    if (configuredJavaRuntimeAssetsSignature && configuredJavaRuntimeAssetsSignature !== signature) {
      throw new Error('Java runtime assets cannot be changed after the worker has been configured.');
    }
    if (helperLibraryPromise || workerReadyPromise) {
      if (!configuredJavaRuntimeAssetsSignature) {
        throw new Error('Java runtime assets must be configured before the runtime starts loading.');
      }
    }
    configuredJavaRuntimeAssetsSignature = signature;
    if (normalized.helperJarUrl) HELPER_JAR_PATH = normalized.helperJarUrl;
    if (normalized.compilerJarUrl) JDK17_COMPILER_JAR_PATH = normalized.compilerJarUrl;
    if (normalized.rewriterJarUrl) REWRITER_JAR_PATH = normalized.rewriterJarUrl;
    if (normalized.parserJarUrl) JAVAPARSER_JAR_PATH = normalized.parserJarUrl;
  }
  cheerpjLoaderUrl = resolveCheerpjLoaderUrl(payload);
  if (typeof URL === 'function') {
    const loaderUrl = new URL(cheerpjLoaderUrl, javaWorkerHref());
    cheerpjRuntimeFetchPrefixes = [
      new URL('./', loaderUrl).href,
      ...trustedJavaProviderRuntimeFetchPrefixes,
    ];
    cheerpjRuntimeFetchExactUrls = new Set(
      [HELPER_JAR_PATH, JDK17_COMPILER_JAR_PATH, REWRITER_JAR_PATH, JAVAPARSER_JAR_PATH]
        .filter((value) => typeof value === 'string' && value.startsWith('/app/'))
        .map((value) => new URL(value.slice('/app'.length), javaWorkerHref()).href)
    );
  } else {
    cheerpjRuntimeFetchPrefixes = [];
    cheerpjRuntimeFetchExactUrls = new Set();
  }
}

function assertSupportedExecutionStyle(executionStyle) {
  if (executionStyle !== 'function' && executionStyle !== 'solution-method' && executionStyle !== 'ops-class') {
    throw new Error(`Java worker does not support execution style "${executionStyle}".`);
  }
}

function isScriptRequest(payload) {
  return typeof payload?.functionName !== 'string' || payload.functionName.trim().length === 0;
}

function resolveMaxStoredEvents(options = {}) {
  const fromStored = Number(options.maxStoredEvents);
  if (Number.isFinite(fromStored) && fromStored > 0) {
    return Math.floor(fromStored);
  }
  const fromTraceSteps = Number(options.maxTraceSteps);
  if (Number.isFinite(fromTraceSteps) && fromTraceSteps > 0) {
    return Math.floor(fromTraceSteps);
  }
  return DEFAULT_MAX_STORED_EVENTS;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isListNodeShape(value) {
  if (!isRecord(value)) return false;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (typeName && typeName !== 'ListNode' && typeName !== 'object') return false;
  if (!('val' in value || 'value' in value)) return false;
  if ('next' in value) return true;
  return typeof value.__id__ === 'string' && value.__id__.startsWith('list-');
}

function isTreeNodeShape(value) {
  if (!isRecord(value)) return false;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (typeName && typeName !== 'TreeNode' && typeName !== 'object') return false;
  if (!('val' in value || 'value' in value)) return false;
  if ('left' in value || 'right' in value) return true;
  return typeof value.__id__ === 'string' && value.__id__.startsWith('tree-');
}

function detectFeatures(source, input, options = {}) {
  const values = Object.values(input ?? {});
  return {
    hasList: /\bListNode\b/.test(source) || values.some((value) => isListNodeShape(value)),
    hasTree: /\bTreeNode\b/.test(source) || values.some((value) => isTreeNodeShape(value)),
    hasCustomObject: values.some((value) => containsCustomObjectLiteral(value)),
    hasMap: values.some((value) => containsPlainObjectLiteral(value)),
    hasDynamicInputs: options.hasDynamicInputs === true,
  };
}

function containsCustomObjectLiteral(value) {
  if (Array.isArray(value)) return value.some((entry) => containsCustomObjectLiteral(entry));
  if (!isRecord(value)) return false;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (typeName && typeName !== 'TreeNode' && typeName !== 'ListNode' && typeName !== 'object') return true;
  return Object.values(value).some((entry) => containsCustomObjectLiteral(entry));
}

function containsPlainObjectLiteral(value) {
  if (Array.isArray(value)) return value.some((entry) => containsPlainObjectLiteral(entry));
  if (!isRecord(value)) return false;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (!typeName) return true;
  if (typeName !== 'TreeNode' && typeName !== 'ListNode' && typeName !== 'object') return false;
  return Object.entries(value)
    .filter(([key]) => key !== '__type__' && key !== '__class__' && key !== '__id__')
    .some(([, entry]) => containsPlainObjectLiteral(entry));
}

function toJavaScalarLiteral(value) {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error(`Unsupported scalar literal: ${JSON.stringify(value)}`);
}

function toJavaScalarLiteralForType(value, expectedType) {
  const normalized = expectedType ? stripGenericType(expectedType) : null;
  if ((normalized === 'long' || normalized === 'Long') && typeof value === 'number' && Number.isInteger(value)) {
    return `${String(value)}L`;
  }
  if ((normalized === 'double' || normalized === 'Double') && typeof value === 'number') {
    return Number.isInteger(value) ? `${String(value)}.0` : String(value);
  }
  if ((normalized === 'float' || normalized === 'Float') && typeof value === 'number') {
    return `${Number.isInteger(value) ? `${String(value)}.0` : String(value)}f`;
  }
  if (normalized === 'char' && typeof value === 'string' && value.length === 1) {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  return toJavaScalarLiteral(value);
}

function toJavaArrayLiteral(value) {
  if (value.length === 0) return 'new int[] {}';
  if (value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))) {
    return `new int[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (value.every((entry) => typeof entry === 'number')) {
    return `new double[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (value.every((entry) => typeof entry === 'string')) {
    return `new String[] { ${value.map((entry) => JSON.stringify(entry)).join(', ')} }`;
  }
  if (value.every((entry) => Array.isArray(entry))) {
    return `new int[][] { ${value.map((entry) => toJavaArrayLiteral(entry)).join(', ')} }`;
  }
  throw new Error(`Unsupported array literal: ${JSON.stringify(value)}`);
}

function stripGenericType(typeSource) {
  return typeSource.replace(/\s+/g, '');
}

function extractTypeArguments(typeSource) {
  const normalized = stripGenericType(typeSource);
  const start = normalized.indexOf('<');
  const end = normalized.lastIndexOf('>');
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }

  const body = normalized.slice(start + 1, end);
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '<') depth += 1;
    if (ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function splitTopLevelCommaList(source) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of source) {
    if (ch === '<' || ch === '(' || ch === '[') depth += 1;
    if (ch === '>' || ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function normalizedJavaInputType(typeSource) {
  return String(typeSource || 'Object')
    .replace(/\bfinal\b/g, '')
    .replace(/\s+/g, '')
    .replace(/\.\.\.$/, '[]');
}

function isDynamicJavaScalarType(typeSource, value) {
  const normalized = normalizedJavaInputType(typeSource);
  if (
    ['byte', 'Byte', 'short', 'Short', 'int', 'Integer', 'long', 'Long', 'float', 'Float', 'double', 'Double'].includes(normalized)
  ) {
    return typeof value === 'number';
  }
  if (normalized === 'boolean' || normalized === 'Boolean') {
    return typeof value === 'boolean';
  }
  if (normalized === 'String') {
    return typeof value === 'string';
  }
  if (normalized === 'char' || normalized === 'Character') {
    return typeof value === 'string' && value.length === 1;
  }
  return false;
}

function isDynamicJavaInputType(typeSource, value) {
  const normalized = normalizedJavaInputType(typeSource);
  if (normalized.endsWith('[]')) {
    if (!Array.isArray(value)) return false;
    const elementType = normalized.slice(0, -2);
    return value.every((entry) => isDynamicJavaInputType(elementType, entry));
  }
  return isDynamicJavaScalarType(normalized, value);
}

function rawJavaClassLiteral(typeSource) {
  const normalized = normalizedJavaInputType(typeSource);
  let depth = 0;
  let raw = '';
  for (const ch of normalized) {
    if (ch === '<') {
      depth += 1;
      continue;
    }
    if (ch === '>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) raw += ch;
  }
  if (!/^(?:[A-Za-z_$][A-Za-z0-9_$.]*|byte|short|int|long|float|double|boolean|char)(?:\[\])*$/.test(raw)) {
    return 'Object.class';
  }
  return `${raw}.class`;
}

function dynamicJavaInputExpression(typeSource, dynamicInput) {
  const normalized = normalizedJavaInputType(typeSource);
  const quotedLocation = JSON.stringify(
    dynamicInput.property ?? dynamicInput.path
  );
  const parameterTypes = Array.isArray(dynamicInput.parameterTypes)
    ? dynamicInput.parameterTypes
    : [];
  const reflectedType = parameterTypes.length > 0
    ? `preparedParameterType(${dynamicInput.ownerClass}.class, ${JSON.stringify(dynamicInput.methodName)}, ${dynamicInput.parameterIndex}, new Class<?>[] { ${parameterTypes.map(rawJavaClassLiteral).join(', ')} })`
    : rawJavaClassLiteral(normalized);
  const readExpression = dynamicInput.property
    ? `readJsonInputProperty(${quotedLocation}, ${reflectedType})`
    : `readJsonInput(${quotedLocation}, ${reflectedType})`;
  if (normalized.endsWith('[]')) {
    return `((${normalized}) ${readExpression})`;
  }
  if (normalized === 'byte' || normalized === 'Byte') return `((Number) ${readExpression}).byteValue()`;
  if (normalized === 'short' || normalized === 'Short') return `((Number) ${readExpression}).shortValue()`;
  if (normalized === 'int' || normalized === 'Integer') return `((Number) ${readExpression}).intValue()`;
  if (normalized === 'long' || normalized === 'Long') return `((Number) ${readExpression}).longValue()`;
  if (normalized === 'float' || normalized === 'Float') return `((Number) ${readExpression}).floatValue()`;
  if (normalized === 'double' || normalized === 'Double') return `((Number) ${readExpression}).doubleValue()`;
  if (normalized === 'boolean' || normalized === 'Boolean') return `((Boolean) ${readExpression}).booleanValue()`;
  if (normalized === 'char' || normalized === 'Character') return `((Character) ${readExpression}).charValue()`;
  return `((${normalized}) ${readExpression})`;
}

function isPrimitiveJavaScalarType(typeSource) {
  return [
    'byte',
    'Byte',
    'short',
    'Short',
    'int',
    'Integer',
    'long',
    'Long',
    'float',
    'Float',
    'double',
    'Double',
    'boolean',
    'Boolean',
    'char',
    'Character',
    'String',
    'Object',
  ].includes(normalizedJavaInputType(typeSource));
}

function isCustomJavaObjectType(typeSource) {
  const normalized = normalizedJavaInputType(typeSource);
  if (!normalized || normalized.includes('<') || normalized.endsWith('[]')) return false;
  if (isPrimitiveJavaScalarType(normalized)) return false;
  if (['ListNode', 'TreeNode', 'java.lang.String'].includes(normalized)) return false;
  if (/^(?:java\.util\.)?(?:List|ArrayList|LinkedList|Map|HashMap|LinkedHashMap|Set|HashSet|Deque|Queue)$/.test(normalized)) {
    return false;
  }
  return /^[A-Za-z_$][A-Za-z0-9_$.]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(normalized);
}

function toJavaTypedArrayLiteral(value, expectedType) {
  const normalized = stripGenericType(expectedType);
  if (!normalized.endsWith('[]')) {
    return toJavaArrayLiteral(value);
  }

  const elementType = normalized.slice(0, -2);
  if (value.every((entry) => Array.isArray(entry))) {
    return `new ${normalized} { ${value
      .map((entry) => toJavaTypedArrayLiteral(entry, elementType))
      .join(', ')} }`;
  }

  if (elementType === 'int' && value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))) {
    return `new int[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (elementType === 'double' && value.every((entry) => typeof entry === 'number')) {
    return `new double[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (elementType === 'boolean' && value.every((entry) => typeof entry === 'boolean')) {
    return `new boolean[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (elementType === 'String' && value.every((entry) => typeof entry === 'string')) {
    return `new String[] { ${value.map((entry) => JSON.stringify(entry)).join(', ')} }`;
  }
  if (elementType === 'char' && value.every((entry) => typeof entry === 'string' && entry.length === 1)) {
    return `new char[] { ${value
      .map((entry) => `'${String(entry).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
      .join(', ')} }`;
  }
  if (elementType === 'long' && value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))) {
    return `new long[] { ${value.map((entry) => `${String(entry)}L`).join(', ')} }`;
  }
  if (elementType === 'Object') {
    return `new Object[] { ${value.map((entry) => buildJavaExpression(entry)).join(', ')} }`;
  }

  return `new ${normalized} { ${value.map((entry) => buildJavaExpression(entry, elementType)).join(', ')} }`;
}

function toJavaListLiteral(value, expectedType) {
  const [elementType = 'Object'] = extractTypeArguments(expectedType);
  return `new java.util.ArrayList<${elementType}>(java.util.Arrays.asList(${value.map((entry) => buildJavaExpression(entry, elementType)).join(', ')}))`;
}

function toJavaMapLiteral(value, expectedType) {
  const [keyType = 'String', valueType = 'Object'] = extractTypeArguments(expectedType);
  const entries = Object.entries(value)
    .map(([key, child]) => `new Object[] { ${buildJavaExpression(key, keyType)}, ${buildJavaExpression(child, valueType)} }`);
  return `typedMap(new Object[][] { ${entries.join(', ')} })`;
}

function toJavaObjectExpression(value) {
  if (Array.isArray(value)) {
    return `new java.util.ArrayList<Object>(java.util.Arrays.asList(${value.map((entry) => toJavaObjectExpression(entry)).join(', ')}))`;
  }
  if (isRecord(value)) {
    return toJavaDynamicObjectExpression(value);
  }
  return toJavaScalarLiteral(value);
}

function customObjectTypeName(value) {
  if (!isRecord(value)) return null;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (!typeName || typeName === 'TreeNode' || typeName === 'ListNode' || typeName === 'object') return null;
  return typeName;
}

function toJavaObjectFieldsExpression(value) {
  const entries = Object.entries(value)
    .filter(([key]) => key !== '__type__' && key !== '__class__' && key !== '__id__')
    .map(([key, child]) => `new Object[] { ${JSON.stringify(key)}, ${toJavaDynamicObjectExpression(child)} }`);
  return `objectFields(new Object[][] { ${entries.join(', ')} })`;
}

function toJavaDynamicObjectExpression(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `new java.util.ArrayList<Object>(java.util.Arrays.asList(${value.map((entry) => toJavaDynamicObjectExpression(entry)).join(', ')}))`;
  }
  if (isRecord(value)) {
    const typeName = customObjectTypeName(value);
    if (typeName) {
      return `materializeObject(${JSON.stringify(typeName)}, ${toJavaObjectFieldsExpression(value)})`;
    }
    const entries = Object.entries(value)
      .filter(([key]) => key !== '__type__' && key !== '__class__' && key !== '__id__')
      .map(([key, child]) => `new Object[] { ${JSON.stringify(key)}, ${toJavaDynamicObjectExpression(child)} }`);
    return `objectFields(new Object[][] { ${entries.join(', ')} })`;
  }
  return toJavaScalarLiteral(value);
}

function inputValueForParameter(input, key, index) {
  if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  return Object.values(input)[index];
}

function inputArgumentsForParameters(rawArgs, parameters) {
  if (parameters.length === 0) return [];
  if (Array.isArray(rawArgs)) return rawArgs;
  if (isRecord(rawArgs) && parameters.length > 0) {
    return parameters.map((parameter, index) => inputValueForParameter(rawArgs, parameter.name, index));
  }
  return [];
}

function uniqueJavaIdentifier(baseName, usedNames) {
  let candidate = baseName;
  let suffix = 0;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}${suffix}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function listLiteral(value) {
  const rawVal = value.val ?? value.value ?? 0;
  const next = value.next;
  return `list(${toJavaScalarLiteral(rawVal)}, ${next ? listLiteral(next) : 'null'})`;
}

function listGraphExpression(head) {
  const nodes = [];
  const indexByNode = new Map();
  const indexById = new Map();
  const nextIndices = [];
  const pendingRefs = [];

  const visit = (node) => {
    if (!node) return -1;
    if (indexByNode.has(node)) return indexByNode.get(node);

    const index = nodes.length;
    nodes.push(node);
    indexByNode.set(node, index);
    nextIndices[index] = -1;

    if (typeof node.__id__ === 'string') {
      indexById.set(node.__id__, index);
    }

    const next = node.next;
    if (isRecord(next) && !Array.isArray(next)) {
      if (typeof next.__ref__ === 'string') {
        pendingRefs.push({ sourceIndex: index, targetId: next.__ref__ });
      } else {
        nextIndices[index] = visit(next);
      }
    }

    return index;
  };

  visit(head);

  for (const pendingRef of pendingRefs) {
    const targetIndex = indexById.get(pendingRef.targetId);
    if (targetIndex !== undefined) {
      nextIndices[pendingRef.sourceIndex] = targetIndex;
    }
  }

  const values = nodes.map((node) => {
    const rawVal = node.val ?? node.value ?? 0;
    return rawVal;
  });

  return `buildList(new Object[] { ${values.map((value) => toJavaScalarLiteral(value)).join(', ')} }, new int[] { ${nextIndices.join(', ')} })`;
}

function listExpression(value) {
  return listGraphExpression(value);
}

function listArrayExpression(value) {
  return `buildList(new Object[] { ${value.map((entry) => toJavaScalarLiteral(entry)).join(', ')} }, sequentialNextIndices(${value.length}))`;
}

function treeExpression(value) {
  const rawVal = value.val ?? value.value ?? 0;
  const left = value.left ? treeExpression(value.left) : 'null';
  const right = value.right ? treeExpression(value.right) : 'null';
  return `tree(${toJavaScalarLiteral(rawVal)}, ${left}, ${right})`;
}

function treeLevelOrderExpression(value) {
  if (!value.every((entry) => entry === null || (typeof entry === 'number' && Number.isInteger(entry)))) {
    throw new Error(`Unsupported tree node value: ${JSON.stringify(value.find((entry) => entry !== null && (typeof entry !== 'number' || !Number.isInteger(entry))))}`);
  }
  const values = value.map((entry) => (entry === null ? 'null' : String(entry))).join(', ');
  return `buildTree(new Integer[] { ${values} })`;
}

function buildJavaExpression(value, expectedType) {
  const normalizedType = expectedType ? stripGenericType(expectedType) : null;
  if (value === null || typeof value !== 'object') {
    return toJavaScalarLiteralForType(value, normalizedType);
  }
  if (Array.isArray(value)) {
    if (normalizedType === 'Object') {
      return toJavaObjectExpression(value);
    }
    if (normalizedType === 'ListNode') {
      return listArrayExpression(value);
    }
    if (normalizedType === 'TreeNode') {
      return treeLevelOrderExpression(value);
    }
    if (normalizedType?.startsWith('List<')) {
      return toJavaListLiteral(value, normalizedType);
    }
    if (normalizedType?.endsWith('[]')) {
      return toJavaTypedArrayLiteral(value, normalizedType);
    }
    return toJavaArrayLiteral(value);
  }
  if (isRecord(value) && normalizedType === 'ListNode') return listExpression(value);
  if (isRecord(value) && normalizedType === 'TreeNode') return treeExpression(value);
  if (isRecord(value) && normalizedType?.startsWith('Map<')) return toJavaMapLiteral(value, normalizedType);
  if (isRecord(value) && normalizedType && isCustomJavaObjectType(normalizedType)) {
    return `((${normalizedType}) materializeObject(${normalizedType}.class, ${toJavaObjectFieldsExpression(value)}))`;
  }
  if (isRecord(value) && customObjectTypeName(value)) {
    return `((${normalizedType ?? customObjectTypeName(value)}) ${toJavaDynamicObjectExpression(value)})`;
  }
  if (isListNodeShape(value)) return listExpression(value);
  if (isTreeNodeShape(value)) return treeExpression(value);
  return toJavaScalarLiteral(value);
}

function buildDynamicInputHelperMethods() {
  return `
  private static Object readJsonInputProperty(String key, java.lang.reflect.Type targetType) {
    String source = System.getProperty(key);
    if (source == null) {
      throw new RuntimeException("Missing TraceCode prepared input " + key);
    }
    return coerceJsonInput(new __TracecodeJsonParser(source).parse(), targetType);
  }

  private static Object readJsonInput(String path, java.lang.reflect.Type targetType) {
    try {
      String source = java.nio.file.Files.readString(java.nio.file.Paths.get(path), java.nio.charset.StandardCharsets.UTF_8);
      return coerceJsonInput(new __TracecodeJsonParser(source).parse(), targetType);
    } catch (java.io.IOException error) {
      throw new RuntimeException("Unable to read TraceCode input " + path, error);
    }
  }

  private static java.lang.reflect.Type preparedParameterType(
      Class<?> owner,
      String methodName,
      int parameterIndex,
      Class<?>[] parameterTypes
  ) {
    try {
      java.lang.reflect.Method method = owner.getDeclaredMethod(methodName, parameterTypes);
      return method.getGenericParameterTypes()[parameterIndex];
    } catch (ReflectiveOperationException exactFailure) {
      for (java.lang.reflect.Method method : owner.getDeclaredMethods()) {
        if (method.getName().equals(methodName) && method.getParameterCount() == parameterTypes.length) {
          return method.getGenericParameterTypes()[parameterIndex];
        }
      }
      throw new RuntimeException("Unable to resolve prepared Java parameter " + methodName, exactFailure);
    }
  }

  private static Class<?> preparedRawClass(java.lang.reflect.Type type) {
    if (type instanceof Class<?>) return (Class<?>) type;
    if (type instanceof java.lang.reflect.ParameterizedType) {
      return preparedRawClass(((java.lang.reflect.ParameterizedType) type).getRawType());
    }
    if (type instanceof java.lang.reflect.GenericArrayType) {
      Class<?> component = preparedRawClass(
          ((java.lang.reflect.GenericArrayType) type).getGenericComponentType()
      );
      return java.lang.reflect.Array.newInstance(component, 0).getClass();
    }
    return Object.class;
  }

  private static java.lang.reflect.Type preparedTypeArgument(
      java.lang.reflect.Type type,
      int index
  ) {
    if (type instanceof java.lang.reflect.ParameterizedType) {
      java.lang.reflect.Type[] arguments =
          ((java.lang.reflect.ParameterizedType) type).getActualTypeArguments();
      if (index >= 0 && index < arguments.length) return arguments[index];
    }
    return Object.class;
  }

  private static java.util.Collection<Object> preparedCollection(
      Class<?> targetType
  ) {
    try {
      if (
          targetType == java.util.Set.class ||
          targetType == java.util.HashSet.class ||
          targetType == java.util.LinkedHashSet.class
      ) {
        return new java.util.LinkedHashSet<>();
      }
      if (
          targetType == java.util.Queue.class ||
          targetType == java.util.Deque.class ||
          targetType == java.util.ArrayDeque.class
      ) {
        return new java.util.ArrayDeque<>();
      }
      if (
          targetType.isInterface() ||
          java.lang.reflect.Modifier.isAbstract(targetType.getModifiers())
      ) {
        return new java.util.ArrayList<>();
      }
      @SuppressWarnings("unchecked")
      java.util.Collection<Object> value =
          (java.util.Collection<Object>) targetType.getDeclaredConstructor().newInstance();
      return value;
    } catch (ReflectiveOperationException error) {
      throw new RuntimeException("Unable to create prepared Java collection " + targetType.getName(), error);
    }
  }

  private static java.util.Map<Object, Object> preparedMap(Class<?> targetType) {
    try {
      if (
          targetType == java.util.SortedMap.class ||
          targetType == java.util.NavigableMap.class ||
          targetType == java.util.TreeMap.class
      ) {
        return new java.util.TreeMap<>();
      }
      if (
          targetType.isInterface() ||
          java.lang.reflect.Modifier.isAbstract(targetType.getModifiers())
      ) {
        return new java.util.LinkedHashMap<>();
      }
      @SuppressWarnings("unchecked")
      java.util.Map<Object, Object> value =
          (java.util.Map<Object, Object>) targetType.getDeclaredConstructor().newInstance();
      return value;
    } catch (ReflectiveOperationException error) {
      throw new RuntimeException("Unable to create prepared Java map " + targetType.getName(), error);
    }
  }

  private static java.lang.reflect.Field preparedField(
      Class<?> targetType,
      String name
  ) {
    Class<?> current = targetType;
    while (current != null && current != Object.class) {
      try {
        return current.getDeclaredField(name);
      } catch (NoSuchFieldException ignored) {
        current = current.getSuperclass();
      }
    }
    return null;
  }

  private static void assignPreparedJsonFields(
      Class<?> targetType,
      Object instance,
      java.util.Map<?, ?> fields
  ) throws ReflectiveOperationException {
    for (java.util.Map.Entry<?, ?> entry : fields.entrySet()) {
      String name = String.valueOf(entry.getKey());
      if (name.startsWith("__")) continue;
      java.lang.reflect.Field field = preparedField(targetType, name);
      if (field == null) continue;
      field.setAccessible(true);
      field.set(instance, coerceJsonInput(entry.getValue(), field.getGenericType()));
    }
  }

  private static Object defaultJsonArgument(Class<?> parameterType) {
    if (!parameterType.isPrimitive()) return null;
    if (parameterType == boolean.class) return Boolean.FALSE;
    if (parameterType == char.class) return Character.valueOf('\\0');
    if (parameterType == byte.class) return Byte.valueOf((byte) 0);
    if (parameterType == short.class) return Short.valueOf((short) 0);
    if (parameterType == int.class) return Integer.valueOf(0);
    if (parameterType == long.class) return Long.valueOf(0L);
    if (parameterType == float.class) return Float.valueOf(0f);
    if (parameterType == double.class) return Double.valueOf(0d);
    return null;
  }

  private static Object materializePreparedJsonObject(
      java.util.Map<?, ?> fields,
      Class<?> targetType
  ) {
    java.util.ArrayList<Object> materializedValues = new java.util.ArrayList<>();
    for (java.util.Map.Entry<?, ?> entry : fields.entrySet()) {
      if (!String.valueOf(entry.getKey()).startsWith("__")) {
        materializedValues.add(entry.getValue());
      }
    }
    Object[] values = materializedValues.toArray();
    for (java.lang.reflect.Constructor<?> constructor : targetType.getDeclaredConstructors()) {
      if (constructor.getParameterCount() != values.length) continue;
      try {
        java.lang.reflect.Type[] parameterTypes = constructor.getGenericParameterTypes();
        Object[] arguments = new Object[values.length];
        for (int index = 0; index < values.length; index += 1) {
          arguments[index] = coerceJsonInput(values[index], parameterTypes[index]);
        }
        constructor.setAccessible(true);
        Object instance = constructor.newInstance(arguments);
        assignPreparedJsonFields(targetType, instance, fields);
        return instance;
      } catch (ReflectiveOperationException | IllegalArgumentException ignored) {
      }
    }
    try {
      java.lang.reflect.Constructor<?> constructor = targetType.getDeclaredConstructor();
      constructor.setAccessible(true);
      Object instance = constructor.newInstance();
      assignPreparedJsonFields(targetType, instance, fields);
      return instance;
    } catch (ReflectiveOperationException ignored) {
    }
    // Learner types often declare a single convenience constructor (the classic
    // TreeNode(int val)) and no no-arg constructor, so an interior node that
    // serializes as {val,left,right} matches no constructor arity. Construct
    // with type-default arguments and let the by-name field assignment below
    // populate the real values.
    java.lang.reflect.Constructor<?>[] declared = targetType.getDeclaredConstructors();
    java.util.Arrays.sort(declared, java.util.Comparator.comparingInt(java.lang.reflect.Constructor::getParameterCount));
    for (java.lang.reflect.Constructor<?> constructor : declared) {
      try {
        Class<?>[] parameterTypes = constructor.getParameterTypes();
        Object[] arguments = new Object[parameterTypes.length];
        for (int index = 0; index < parameterTypes.length; index += 1) {
          arguments[index] = defaultJsonArgument(parameterTypes[index]);
        }
        constructor.setAccessible(true);
        Object instance = constructor.newInstance(arguments);
        assignPreparedJsonFields(targetType, instance, fields);
        return instance;
      } catch (ReflectiveOperationException | IllegalArgumentException ignored) {
      }
    }
    throw new RuntimeException("Unable to materialize prepared Java input " + targetType.getName());
  }

  private static Object preparedLinkedNodes(
      java.util.List<?> values,
      Class<?> targetType
  ) {
    if (values.isEmpty()) return null;
    Object head = null;
    Object tail = null;
    for (Object value : values) {
      java.util.LinkedHashMap<String, Object> fields = new java.util.LinkedHashMap<>();
      fields.put("val", value);
      fields.put("next", null);
      Object node = materializePreparedJsonObject(fields, targetType);
      if (head == null) {
        head = node;
      } else {
        try {
          java.lang.reflect.Field next = preparedField(targetType, "next");
          if (next == null) throw new NoSuchFieldException("next");
          next.setAccessible(true);
          next.set(tail, node);
        } catch (ReflectiveOperationException error) {
          throw new RuntimeException("Unable to link prepared ListNode input", error);
        }
      }
      tail = node;
    }
    return head;
  }

  private static Object preparedTreeNodes(
      java.util.List<?> values,
      Class<?> targetType
  ) {
    if (values.isEmpty() || values.get(0) == null) return null;
    java.util.ArrayList<Object> nodes = new java.util.ArrayList<>();
    for (Object value : values) {
      if (value == null) {
        nodes.add(null);
        continue;
      }
      java.util.LinkedHashMap<String, Object> fields = new java.util.LinkedHashMap<>();
      fields.put("val", value);
      fields.put("left", null);
      fields.put("right", null);
      nodes.add(materializePreparedJsonObject(fields, targetType));
    }
    int child = 1;
    for (int index = 0; index < nodes.size() && child < nodes.size(); index += 1) {
      Object parent = nodes.get(index);
      if (parent == null) continue;
      try {
        java.lang.reflect.Field left = preparedField(targetType, "left");
        java.lang.reflect.Field right = preparedField(targetType, "right");
        if (left == null || right == null) throw new NoSuchFieldException("left/right");
        left.setAccessible(true);
        right.setAccessible(true);
        left.set(parent, nodes.get(child++));
        if (child < nodes.size()) right.set(parent, nodes.get(child++));
      } catch (ReflectiveOperationException error) {
        throw new RuntimeException("Unable to link prepared TreeNode input", error);
      }
    }
    return nodes.get(0);
  }

  private static Object coerceJsonInput(
      Object value,
      java.lang.reflect.Type targetType
  ) {
    if (value == null) return null;
    Class<?> rawType = preparedRawClass(targetType);
    if (rawType == Object.class) return value;
    if (rawType.isArray()) {
      java.util.List<?> list = (java.util.List<?>) value;
      Class<?> componentType = rawType.getComponentType();
      Object array = java.lang.reflect.Array.newInstance(componentType, list.size());
      for (int i = 0; i < list.size(); i++) {
        java.lang.reflect.Array.set(array, i, coerceJsonInput(list.get(i), componentType));
      }
      return array;
    }
    if ((rawType == byte.class || rawType == Byte.class) && value instanceof Number) return ((Number) value).byteValue();
    if ((rawType == short.class || rawType == Short.class) && value instanceof Number) return ((Number) value).shortValue();
    if ((rawType == int.class || rawType == Integer.class) && value instanceof Number) return ((Number) value).intValue();
    if ((rawType == long.class || rawType == Long.class) && value instanceof Number) return ((Number) value).longValue();
    if ((rawType == float.class || rawType == Float.class) && value instanceof Number) return ((Number) value).floatValue();
    if ((rawType == double.class || rawType == Double.class) && value instanceof Number) return ((Number) value).doubleValue();
    if ((rawType == boolean.class || rawType == Boolean.class) && value instanceof Boolean) return value;
    if ((rawType == char.class || rawType == Character.class) && value instanceof String && ((String) value).length() == 1) {
      return ((String) value).charAt(0);
    }
    if (rawType == String.class) return String.valueOf(value);
    if (rawType == StringBuilder.class) return new StringBuilder(String.valueOf(value));
    if (rawType.isEnum()) {
      @SuppressWarnings({"unchecked", "rawtypes"})
      Object enumValue = java.lang.Enum.valueOf(
          (Class<? extends java.lang.Enum>) rawType,
          String.valueOf(value)
      );
      return enumValue;
    }
    if (java.util.Collection.class.isAssignableFrom(rawType)) {
      java.util.Collection<Object> output = preparedCollection(rawType);
      java.lang.reflect.Type itemType = preparedTypeArgument(targetType, 0);
      for (Object item : (java.util.List<?>) value) {
        output.add(coerceJsonInput(item, itemType));
      }
      return output;
    }
    if (java.util.Map.class.isAssignableFrom(rawType)) {
      java.util.Map<Object, Object> output = preparedMap(rawType);
      java.lang.reflect.Type keyType = preparedTypeArgument(targetType, 0);
      java.lang.reflect.Type valueType = preparedTypeArgument(targetType, 1);
      for (java.util.Map.Entry<?, ?> entry : ((java.util.Map<?, ?>) value).entrySet()) {
        output.put(
            coerceJsonInput(entry.getKey(), keyType),
            coerceJsonInput(entry.getValue(), valueType)
        );
      }
      return output;
    }
    if (
        value instanceof java.util.List<?> &&
        rawType.getSimpleName().equals("ListNode")
    ) {
      return preparedLinkedNodes((java.util.List<?>) value, rawType);
    }
    if (
        value instanceof java.util.List<?> &&
        rawType.getSimpleName().equals("TreeNode")
    ) {
      return preparedTreeNodes((java.util.List<?>) value, rawType);
    }
    if (value instanceof java.util.Map<?, ?>) {
      return materializePreparedJsonObject((java.util.Map<?, ?>) value, rawType);
    }
    if (rawType.isInstance(value)) return value;
    throw new IllegalArgumentException(
        "Cannot materialize prepared Java input as " + rawType.getTypeName()
    );
  }

  private static Object[] preparedArguments(
      java.util.List<?> rawArguments,
      java.lang.reflect.Type[] parameterTypes
  ) {
    if (rawArguments.size() != parameterTypes.length) {
      throw new IllegalArgumentException("Prepared Java argument count mismatch");
    }
    Object[] arguments = new Object[parameterTypes.length];
    for (int index = 0; index < parameterTypes.length; index += 1) {
      arguments[index] = coerceJsonInput(rawArguments.get(index), parameterTypes[index]);
    }
    return arguments;
  }

  private static Object constructPreparedReceiver(
      Class<?> targetType,
      java.util.List<?> rawArguments
  ) {
    Throwable lastFailure = null;
    for (java.lang.reflect.Constructor<?> constructor : targetType.getDeclaredConstructors()) {
      if (constructor.getParameterCount() != rawArguments.size()) continue;
      try {
        Object[] arguments = preparedArguments(
            rawArguments,
            constructor.getGenericParameterTypes()
        );
        constructor.setAccessible(true);
        return constructor.newInstance(arguments);
      } catch (Throwable error) {
        lastFailure = error;
      }
    }
    throw new RuntimeException(
        "No matching prepared Java constructor for " + targetType.getName(),
        lastFailure
    );
  }

  private static java.lang.reflect.Method preparedOperationMethod(
      Class<?> targetType,
      String operation,
      java.util.List<?> rawArguments
  ) {
    for (java.lang.reflect.Method method : targetType.getDeclaredMethods()) {
      if (
          method.getName().equals(operation) &&
          method.getParameterCount() == rawArguments.size()
      ) {
        try {
          preparedArguments(rawArguments, method.getGenericParameterTypes());
          method.setAccessible(true);
          return method;
        } catch (RuntimeException ignored) {
        }
      }
    }
    throw new IllegalArgumentException(
        "No matching prepared Java operation " + targetType.getName() + "." + operation
    );
  }

  private static String runPreparedOperations(
      Class<?> targetType,
      Object rawInput
  ) {
    if (!(rawInput instanceof java.util.Map<?, ?>)) {
      throw new IllegalArgumentException("Prepared ops-class input must be an object");
    }
    java.util.Map<?, ?> input = (java.util.Map<?, ?>) rawInput;
    Object rawOperations = input.get("operations");
    Object rawArgumentLists = input.get("arguments");
    if (
        !(rawOperations instanceof java.util.List<?>) ||
        !(rawArgumentLists instanceof java.util.List<?>)
    ) {
      throw new IllegalArgumentException(
          "Prepared ops-class input requires operations and arguments arrays"
      );
    }
    java.util.List<?> operations = (java.util.List<?>) rawOperations;
    java.util.List<?> argumentLists = (java.util.List<?>) rawArgumentLists;
    if (operations.size() != argumentLists.size()) {
      throw new IllegalArgumentException(
          "Prepared ops-class operations and arguments must have equal lengths"
      );
    }

    int operationIndex = 0;
    java.util.List<?> constructorArguments = java.util.Collections.emptyList();
    if (!operations.isEmpty()) {
      String firstOperation = String.valueOf(operations.get(0));
      boolean namesConstructor =
          firstOperation.equals(targetType.getSimpleName()) ||
          firstOperation.equals("__init__") ||
          firstOperation.equals("init");
      boolean namesMethod = false;
      for (java.lang.reflect.Method method : targetType.getDeclaredMethods()) {
        if (method.getName().equals(firstOperation)) {
          namesMethod = true;
          break;
        }
      }
      if (namesConstructor || !namesMethod) {
        Object firstArguments = argumentLists.get(0);
        if (!(firstArguments instanceof java.util.List<?>)) {
          throw new IllegalArgumentException(
              "Prepared ops-class constructor arguments must be an array"
          );
        }
        constructorArguments = (java.util.List<?>) firstArguments;
        operationIndex = 1;
      }
    }

    Object receiver = constructPreparedReceiver(targetType, constructorArguments);
    java.util.ArrayList<Object> output = new java.util.ArrayList<>();
    if (operationIndex == 1) output.add(null);
    for (; operationIndex < operations.size(); operationIndex += 1) {
      String operation = String.valueOf(operations.get(operationIndex));
      Object rawArguments = argumentLists.get(operationIndex);
      if (!(rawArguments instanceof java.util.List<?>)) {
        throw new IllegalArgumentException(
            "Prepared ops-class method arguments must be arrays"
        );
      }
      java.util.List<?> methodArguments = (java.util.List<?>) rawArguments;
      java.lang.reflect.Method method = preparedOperationMethod(
          targetType,
          operation,
          methodArguments
      );
      try {
        Object result = method.invoke(
            receiver,
            preparedArguments(methodArguments, method.getGenericParameterTypes())
        );
        output.add(method.getReturnType() == void.class ? null : result);
      } catch (ReflectiveOperationException error) {
        Throwable cause = error.getCause();
        if (cause instanceof RuntimeException) throw (RuntimeException) cause;
        if (cause instanceof Error) throw (Error) cause;
        throw new RuntimeException(
            "Prepared Java operation failed: " + operation,
            cause == null ? error : cause
        );
      }
    }
    return TraceHooks.serializeOutputResult(output);
  }

  private static final class __TracecodeJsonParser {
    private final String source;
    private int index = 0;

    __TracecodeJsonParser(String source) {
      this.source = source == null || source.isEmpty() ? "null" : source;
    }

    Object parse() {
      skipWhitespace();
      Object value = parseValue();
      skipWhitespace();
      if (index != source.length()) {
        throw new IllegalArgumentException("Unexpected trailing JSON input");
      }
      return value;
    }

    private Object parseValue() {
      skipWhitespace();
      char ch = peek();
      if (ch == '"') return parseString();
      if (ch == '[') return parseArray();
      if (ch == '{') return parseObject();
      if (ch == '-' || (ch >= '0' && ch <= '9')) return parseNumber();
      if (consume("true")) return Boolean.TRUE;
      if (consume("false")) return Boolean.FALSE;
      if (consume("null")) return null;
      throw new IllegalArgumentException("Invalid JSON input");
    }

    private java.util.List<Object> parseArray() {
      expect('[');
      java.util.ArrayList<Object> values = new java.util.ArrayList<>();
      skipWhitespace();
      if (peek() == ']') {
        index++;
        return values;
      }
      while (true) {
        values.add(parseValue());
        skipWhitespace();
        char separator = take();
        if (separator == ']') return values;
        if (separator != ',') throw new IllegalArgumentException("Invalid JSON array");
      }
    }

    private java.util.LinkedHashMap<String, Object> parseObject() {
      expect('{');
      java.util.LinkedHashMap<String, Object> values = new java.util.LinkedHashMap<>();
      skipWhitespace();
      if (peek() == '}') {
        index++;
        return values;
      }
      while (true) {
        skipWhitespace();
        String key = parseString();
        skipWhitespace();
        expect(':');
        values.put(key, parseValue());
        skipWhitespace();
        char separator = take();
        if (separator == '}') return values;
        if (separator != ',') throw new IllegalArgumentException("Invalid JSON object");
      }
    }

    private String parseString() {
      expect('"');
      StringBuilder out = new StringBuilder();
      while (true) {
        char ch = take();
        if (ch == '"') return out.toString();
        if (ch != '\\\\') {
          out.append(ch);
          continue;
        }
        char escaped = take();
        switch (escaped) {
          case '"': out.append('"'); break;
          case '\\\\': out.append('\\\\'); break;
          case '/': out.append('/'); break;
          case 'b': out.append('\\b'); break;
          case 'f': out.append('\\f'); break;
          case 'n': out.append('\\n'); break;
          case 'r': out.append('\\r'); break;
          case 't': out.append('\\t'); break;
          case 'u':
            int codePoint = 0;
            for (int i = 0; i < 4; i++) {
              codePoint = (codePoint << 4) + Character.digit(take(), 16);
            }
            out.append((char) codePoint);
            break;
          default:
            throw new IllegalArgumentException("Invalid JSON string escape");
        }
      }
    }

    private Number parseNumber() {
      int start = index;
      if (peek() == '-') index++;
      while (peek() >= '0' && peek() <= '9') index++;
      boolean floating = false;
      if (peek() == '.') {
        floating = true;
        index++;
        while (peek() >= '0' && peek() <= '9') index++;
      }
      if (peek() == 'e' || peek() == 'E') {
        floating = true;
        index++;
        if (peek() == '+' || peek() == '-') index++;
        while (peek() >= '0' && peek() <= '9') index++;
      }
      String raw = source.substring(start, index);
      return floating ? Double.valueOf(raw) : Long.valueOf(raw);
    }

    private boolean consume(String literal) {
      if (!source.startsWith(literal, index)) return false;
      index += literal.length();
      return true;
    }

    private void skipWhitespace() {
      while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++;
    }

    private char peek() {
      return index < source.length() ? source.charAt(index) : '\\0';
    }

    private char take() {
      if (index >= source.length()) throw new IllegalArgumentException("Unexpected end of JSON input");
      return source.charAt(index++);
    }

    private void expect(char expected) {
      char actual = take();
      if (actual != expected) throw new IllegalArgumentException("Unexpected JSON character");
    }
  }`;
}

function buildHelperMethods(features) {
  if (features.skipInputMaterializers) {
    return '';
  }
  const members = [];
  if (features.hasDynamicInputs) {
    members.push(buildDynamicInputHelperMethods());
  }
  if (features.hasList || features.hasCustomObject) {
    members.push(`
  private static Object coerceMaterializedValue(Object value, Class<?> targetType) {
    if (value == null) {
      return null;
    }
    if (targetType.isInstance(value)) {
      return value;
    }
    if (targetType.isArray() && value instanceof java.util.List<?>) {
      java.util.List<?> list = (java.util.List<?>) value;
      Class<?> componentType = targetType.getComponentType();
      Object array = java.lang.reflect.Array.newInstance(componentType, list.size());
      for (int i = 0; i < list.size(); i++) {
        java.lang.reflect.Array.set(array, i, coerceMaterializedValue(list.get(i), componentType));
      }
      return array;
    }
    if ((targetType == int.class || targetType == Integer.class) && value instanceof Number) return ((Number) value).intValue();
    if ((targetType == long.class || targetType == Long.class) && value instanceof Number) return ((Number) value).longValue();
    if ((targetType == double.class || targetType == Double.class) && value instanceof Number) return ((Number) value).doubleValue();
    if ((targetType == float.class || targetType == Float.class) && value instanceof Number) return ((Number) value).floatValue();
    if ((targetType == short.class || targetType == Short.class) && value instanceof Number) return ((Number) value).shortValue();
    if ((targetType == byte.class || targetType == Byte.class) && value instanceof Number) return ((Number) value).byteValue();
    if ((targetType == boolean.class || targetType == Boolean.class) && value instanceof Boolean) return value;
    if ((targetType == char.class || targetType == Character.class) && value instanceof String && ((String) value).length() == 1) {
      return ((String) value).charAt(0);
    }
    if (value instanceof java.util.LinkedHashMap<?, ?> && !java.util.Map.class.isAssignableFrom(targetType)) {
      @SuppressWarnings("unchecked")
      java.util.LinkedHashMap<String, Object> fields = (java.util.LinkedHashMap<String, Object>) value;
      return materializeObject(targetType, fields);
    }
    return value;
  }`);
  }
  if (features.hasList) {
    members.push(`
  private static ListNode list(Object val, ListNode next) {
    try {
      for (java.lang.reflect.Constructor<?> ctor : ListNode.class.getDeclaredConstructors()) {
        Class<?>[] parameterTypes = ctor.getParameterTypes();
        if (parameterTypes.length == 2 && parameterTypes[1] == ListNode.class) {
          ctor.setAccessible(true);
          return (ListNode) ctor.newInstance(coerceMaterializedValue(val, parameterTypes[0]), next);
        }
      }
      for (java.lang.reflect.Constructor<?> ctor : ListNode.class.getDeclaredConstructors()) {
        Class<?>[] parameterTypes = ctor.getParameterTypes();
        if (parameterTypes.length == 1) {
          ctor.setAccessible(true);
          ListNode node = (ListNode) ctor.newInstance(coerceMaterializedValue(val, parameterTypes[0]));
          try {
            java.lang.reflect.Field nextField = ListNode.class.getDeclaredField("next");
            nextField.setAccessible(true);
            nextField.set(node, next);
          } catch (Exception ignored) {
          }
          return node;
        }
      }
      java.lang.reflect.Constructor<ListNode> ctor = ListNode.class.getDeclaredConstructor();
      ctor.setAccessible(true);
      ListNode node = ctor.newInstance();
      java.lang.reflect.Field valField = ListNode.class.getDeclaredField("val");
      valField.setAccessible(true);
      valField.set(node, coerceMaterializedValue(val, valField.getType()));
      java.lang.reflect.Field nextField = ListNode.class.getDeclaredField("next");
      nextField.setAccessible(true);
      nextField.set(node, next);
      return node;
    } catch (Exception error) {
      throw new RuntimeException("Unable to materialize ListNode", error);
    }
  }

  private static ListNode buildList(Object[] values, int[] nextIndices) {
    if (values.length == 0) {
      return null;
    }
    ListNode[] nodes = new ListNode[values.length];
    for (int i = 0; i < values.length; i++) {
      nodes[i] = list(values[i], null);
    }
    for (int i = 0; i < values.length; i++) {
      int nextIndex = nextIndices[i];
      nodes[i].next = nextIndex >= 0 ? nodes[nextIndex] : null;
    }
    return nodes[0];
  }

  private static int[] sequentialNextIndices(int length) {
    int[] indices = new int[length];
    for (int i = 0; i < length; i++) {
      indices[i] = i + 1 < length ? i + 1 : -1;
    }
    return indices;
  }`);
  }
  if (features.hasTree) {
    members.push(`
  private static TreeNode tree(int val, TreeNode left, TreeNode right) {
    TreeNode node = new TreeNode(val);
    node.left = left;
    node.right = right;
    return node;
  }

  private static TreeNode buildTree(Integer[] values) {
    if (values.length == 0 || values[0] == null) {
      return null;
    }
    TreeNode root = new TreeNode(values[0]);
    java.util.Queue<TreeNode> queue = new java.util.ArrayDeque<>();
    queue.add(root);
    int index = 1;
    while (!queue.isEmpty() && index < values.length) {
      TreeNode current = queue.remove();
      if (values[index] != null) {
        current.left = new TreeNode(values[index]);
        queue.add(current.left);
      }
      index++;
      if (index < values.length && values[index] != null) {
        current.right = new TreeNode(values[index]);
        queue.add(current.right);
      }
      index++;
    }
    return root;
  }`);
  }
  if (features.hasMap || features.hasCustomObject) {
    members.push(`
  @SuppressWarnings({"unchecked", "rawtypes"})
  private static <K, V> java.util.LinkedHashMap<K, V> typedMap(Object[][] entries) {
    java.util.LinkedHashMap<K, V> map = new java.util.LinkedHashMap<>();
    for (Object[] entry : entries) {
      map.put((K) entry[0], (V) entry[1]);
    }
    return map;
  }
`);
  }
  if (features.hasList || features.hasCustomObject) {
    members.push(`

  private static java.util.LinkedHashMap<String, Object> objectFields(Object[][] entries) {
    java.util.LinkedHashMap<String, Object> fields = new java.util.LinkedHashMap<>();
    for (Object[] entry : entries) {
      fields.put((String) entry[0], entry[1]);
    }
    return fields;
  }

  private static Class<?> resolveMaterializedClass(String typeName) throws ClassNotFoundException {
    String packageName = new Object() {}.getClass().getPackageName();
    java.util.List<String> candidates = new java.util.ArrayList<>();
    candidates.add(packageName + "." + typeName);
    if (typeName.indexOf('.') > 0) {
      candidates.add(packageName + "." + typeName.replace('.', '$'));
    } else {
      candidates.add(packageName + ".Solution$" + typeName);
    }
    ClassNotFoundException lastError = null;
    for (String candidate : candidates) {
      try {
        return Class.forName(candidate);
      } catch (ClassNotFoundException error) {
        lastError = error;
      }
    }
    throw lastError == null ? new ClassNotFoundException(typeName) : lastError;
  }

  private static Object materializeObject(String typeName, java.util.LinkedHashMap<String, Object> fields) {
    try {
      return materializeObject(resolveMaterializedClass(typeName), fields);
    } catch (Exception error) {
      throw new RuntimeException("Unable to materialize " + typeName, error);
    }
  }

  private static void assignMaterializedFields(Class<?> cls, Object instance, java.util.LinkedHashMap<String, Object> fields) {
    for (java.util.Map.Entry<String, Object> entry : fields.entrySet()) {
      try {
        java.lang.reflect.Field field = cls.getDeclaredField(entry.getKey());
        field.setAccessible(true);
        field.set(instance, coerceMaterializedValue(entry.getValue(), field.getType()));
      } catch (NoSuchFieldException ignored) {
      } catch (IllegalAccessException error) {
        throw new RuntimeException("Unable to assign field " + entry.getKey() + " on " + cls.getName(), error);
      }
    }
  }

  private static Object materializeObject(Class<?> cls, java.util.LinkedHashMap<String, Object> fields) {
    try {
      Object[] values = fields.values().toArray();
      for (java.lang.reflect.Constructor<?> ctor : cls.getDeclaredConstructors()) {
        if (ctor.getParameterCount() != values.length) {
          continue;
        }
        try {
          Class<?>[] parameterTypes = ctor.getParameterTypes();
          Object[] args = new Object[values.length];
          for (int i = 0; i < values.length; i++) {
            args[i] = coerceMaterializedValue(values[i], parameterTypes[i]);
          }
          ctor.setAccessible(true);
          Object instance = ctor.newInstance(args);
          assignMaterializedFields(cls, instance, fields);
          return instance;
        } catch (Exception ignored) {
        }
      }
      for (java.lang.reflect.Constructor<?> ctor : cls.getDeclaredConstructors()) {
        if (ctor.getParameterCount() != 1 || values.length == 0) {
          continue;
        }
        try {
          Class<?>[] parameterTypes = ctor.getParameterTypes();
          ctor.setAccessible(true);
          Object instance = ctor.newInstance(coerceMaterializedValue(values[0], parameterTypes[0]));
          assignMaterializedFields(cls, instance, fields);
          return instance;
        } catch (Exception ignored) {
        }
      }
      java.lang.reflect.Constructor<?> noArg = cls.getDeclaredConstructor();
      noArg.setAccessible(true);
      Object instance = noArg.newInstance();
      assignMaterializedFields(cls, instance, fields);
      return instance;
    } catch (Exception error) {
      throw new RuntimeException("Unable to materialize " + cls.getName(), error);
    }
  }

`);
  }
  return members.join('\n');
}

function sourceDeclaresJavaClass(source, className) {
  const escapedName = String(className).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bclass\\s+${escapedName}\\b`).test(String(source ?? ''));
}

function findJavaClassBodyRange(source, className) {
  const escapedName = String(className).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b(?:class|interface|enum|record)\\s+${escapedName}\\b`, 'g');
  let match;
  while ((match = pattern.exec(source))) {
    const openBrace = source.indexOf('{', match.index + match[0].length);
    if (openBrace < 0) continue;
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace > openBrace) {
      return { start: openBrace + 1, end: closeBrace };
    }
  }
  return null;
}

function collectJavaNestedTypes(source, ownerClassName = 'Solution') {
  const range = findJavaClassBodyRange(source, ownerClassName);
  const nested = new Set();
  if (!range) return nested;

  const body = source.slice(range.start, range.end);
  let depth = 0;
  scanJavaCode(body, 0, body.length, (index, ch) => {
    if (depth === 0) {
      const declaration = body.slice(index).match(/^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
      if (declaration?.[1]) {
        nested.add(declaration[1]);
      }
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth = Math.max(0, depth - 1);
    return undefined;
  });
  return nested;
}

function qualifyJavaNestedTypeReferences(typeSource, nestedTypeNames, ownerClassName = 'Solution') {
  let out = String(typeSource ?? 'Object');
  for (const nestedTypeName of nestedTypeNames) {
    const escaped = nestedTypeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(?<![\\w.])${escaped}(?![\\w])`, 'g'),
      `${ownerClassName}.${nestedTypeName}`
    );
  }
  return out;
}

function qualifyJavaParameters(parameters, nestedTypeNames, ownerClassName = 'Solution') {
  return parameters.map((parameter) => ({
    ...parameter,
    type: qualifyJavaNestedTypeReferences(parameter.type, nestedTypeNames, ownerClassName),
  }));
}

function buildNodePreludeSource(source, options = {}) {
  if (options.scriptMode === true) {
    return '';
  }

  const declarations = [];
  if (!sourceDeclaresJavaClass(source, 'ListNode')) {
    declarations.push(`class ListNode {
  int val;
  int value;
  ListNode next;

  ListNode() {
    this(0, null);
  }

  ListNode(int val) {
    this(val, null);
  }

  ListNode(int val, ListNode next) {
    this.val = val;
    this.value = val;
    this.next = next;
  }
}`);
  }

  if (!sourceDeclaresJavaClass(source, 'TreeNode')) {
    declarations.push(`class TreeNode {
  int val;
  int value;
  TreeNode left;
  TreeNode right;

  TreeNode() {
    this(0, null, null);
  }

  TreeNode(int val) {
    this(val, null, null);
  }

  TreeNode(int val, TreeNode left, TreeNode right) {
    this.val = val;
    this.value = val;
    this.left = left;
    this.right = right;
  }
}`);
  }

  return declarations.length > 0 ? `${declarations.join('\n\n')}\n\n` : '';
}

function extractMethodParameters(source, methodName) {
  return extractMethodParameterOverloads(source, methodName)[0] ?? [];
}

function extractMethodParameterOverloads(source, methodName) {
  const compact = source.replace(/\s+/g, ' ');
  const escapedMethod = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const overloads = [];
  const pattern = new RegExp(`\\b${escapedMethod}\\s*\\(([^)]*)\\)`, 'g');
  for (const match of compact.matchAll(pattern)) {
    const rawParameters = match[1]?.trim();
    if (!rawParameters) {
      overloads.push([]);
      continue;
    }
    overloads.push(
      splitTopLevelCommaList(rawParameters)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .map((segment) => {
          const lastSpace = segment.lastIndexOf(' ');
          if (lastSpace === -1) {
            return { type: segment, name: segment };
          }
          return {
            type: segment.slice(0, lastSpace).trim(),
            name: segment.slice(lastSpace + 1).trim(),
          };
        })
    );
  }
  return overloads;
}

function extractMethodParametersForArguments(source, methodName, rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const overloads = extractMethodParameterOverloads(source, methodName);
  return overloads.find((parameters) => parameters.length === args.length) ?? overloads[0] ?? [];
}

function extractMethodReturnType(source, methodName) {
  const compact = source.replace(/\s+/g, ' ');
  const escapedMethod = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = compact.match(
    new RegExp(`\\b(?:public|private|protected|static|final|synchronized|abstract|native|strictfp|\\s)*([A-Za-z_][A-Za-z0-9_<>,.?\\[\\]\\s]*)\\s+${escapedMethod}\\s*\\(`)
  );
  return match?.[1]?.trim() ?? null;
}

function indentBlock(source, spaces = 2) {
  const prefix = ' '.repeat(spaces);
  return source
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : `${prefix}${line}`))
    .join('\n');
}

function isJavaIdentifierPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

function scanJavaCode(source, start, end, onNormalChar) {
  let state = 'normal';
  for (let index = start; index < end; index += 1) {
    const ch = source[index];
    const next = index + 1 < end ? source[index + 1] : '';

    if (state === 'line-comment') {
      if (ch === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        index += 1;
      }
      continue;
    }
    if (state === 'string') {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === '"') state = 'normal';
      continue;
    }
    if (state === 'char') {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === "'") state = 'normal';
      continue;
    }
    if (ch === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (ch === '"') {
      state = 'string';
      continue;
    }
    if (ch === "'") {
      state = 'char';
      continue;
    }

    const result = onNormalChar(index, ch);
    if (result === false) return index;
    if (typeof result === 'number') index = result;
  }
  return end;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let closeIndex = -1;
  scanJavaCode(source, openIndex, source.length, (index, ch) => {
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        return false;
      }
    }
    return undefined;
  });
  return closeIndex;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let closeIndex = -1;
  scanJavaCode(source, openIndex, source.length, (index, ch) => {
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        return false;
      }
    }
    return undefined;
  });
  return closeIndex;
}

function findSingleStatementEnd(source, bodyStart) {
  let cursor = bodyStart;
  while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  if (startsWithJavaKeyword(source, cursor, 'if')) {
    let headerStart = cursor + 'if'.length;
    while (/\s/.test(source[headerStart] ?? '')) headerStart += 1;
    if (source[headerStart] === '(') {
      const closeParen = findMatchingParen(source, headerStart);
      if (closeParen >= 0) {
        let nestedBodyStart = closeParen + 1;
        while (/\s/.test(source[nestedBodyStart] ?? '')) nestedBodyStart += 1;
        if (source[nestedBodyStart] === '{') {
          const closeBrace = findMatchingBrace(source, nestedBodyStart);
          if (closeBrace >= 0) return closeBrace;
        }
        if (source[nestedBodyStart] && source[nestedBodyStart] !== ';') {
          return findSingleStatementEnd(source, nestedBodyStart);
        }
      }
    }
  }
  const loopKeyword = startsWithJavaKeyword(source, cursor, 'for')
    ? 'for'
    : startsWithJavaKeyword(source, cursor, 'while')
      ? 'while'
      : null;
  if (loopKeyword) {
    let headerStart = cursor + loopKeyword.length;
    while (/\s/.test(source[headerStart] ?? '')) headerStart += 1;
    if (source[headerStart] === '(') {
      const closeParen = findMatchingParen(source, headerStart);
      if (closeParen >= 0) {
        let nestedBodyStart = closeParen + 1;
        while (/\s/.test(source[nestedBodyStart] ?? '')) nestedBodyStart += 1;
        if (source[nestedBodyStart] === '{') {
          const closeBrace = findMatchingBrace(source, nestedBodyStart);
          if (closeBrace >= 0) return closeBrace;
        }
        if (source[nestedBodyStart] && source[nestedBodyStart] !== ';') {
          return findSingleStatementEnd(source, nestedBodyStart);
        }
      }
    }
  }

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let statementEnd = -1;
  scanJavaCode(source, bodyStart, source.length, (index, ch) => {
    if (ch === '(') parenDepth += 1;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (ch === '[') bracketDepth += 1;
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (ch === '{') braceDepth += 1;
    if (ch === '}') {
      if (braceDepth === 0) return false;
      braceDepth -= 1;
    }
    if (ch === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      statementEnd = index;
      return false;
    }
    return undefined;
  });
  return statementEnd;
}

function startsWithJavaKeyword(source, index, keyword) {
  if (!source.startsWith(keyword, index)) return false;
  const after = source[index + keyword.length] ?? '';
  return !after || !isJavaIdentifierPart(after);
}

function braceDeltaForLine(line) {
  let delta = 0;
  scanJavaCode(line, 0, line.length, (_index, ch) => {
    if (ch === '{') delta += 1;
    if (ch === '}') delta -= 1;
    return undefined;
  });
  return delta;
}

function isUnbracedLoopHeaderLine(line) {
  const trimmed = line.trim();
  return /^(?:for|while)\s*\(.*\)\s*$/.test(trimmed) && !trimmed.includes('{') && !trimmed.endsWith(';');
}

function startsBracedLoopLine(line) {
  const lineStart = line.search(/\S/);
  if (lineStart < 0) return false;
  const keyword = startsWithJavaKeyword(line, lineStart, 'for')
    ? 'for'
    : startsWithJavaKeyword(line, lineStart, 'while')
      ? 'while'
      : null;
  if (!keyword) return false;
  let headerStart = lineStart + keyword.length;
  while (/\s/.test(line[headerStart] ?? '')) headerStart += 1;
  if (line[headerStart] !== '(') return false;
  const closeParen = findMatchingParen(line, headerStart);
  if (closeParen < 0) return false;
  let bodyStart = closeParen + 1;
  while (/\s/.test(line[bodyStart] ?? '')) bodyStart += 1;
  if (line[bodyStart] !== '{') return false;
  const closeBrace = findMatchingBrace(line, bodyStart);
  return closeBrace < 0 || !hasJavaCodeAfter(line, closeBrace + 1);
}

function hasJavaCodeAfter(source, start) {
  let found = false;
  scanJavaCode(source, start, source.length, (_index, ch) => {
    if (!/\s/.test(ch)) {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

function wrapNestedBracedLoopBodies(source) {
  const lines = source.split(/\r?\n/);
  const output = [];
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const next = lines[index + 1] ?? '';
    if (!isUnbracedLoopHeaderLine(line) || !startsBracedLoopLine(next)) {
      output.push(line);
      continue;
    }

    changed = true;
    output.push(`${line} {`);
    index += 1;
    let depth = 0;
    for (; index < lines.length; index += 1) {
      const nestedLine = lines[index] ?? '';
      output.push(nestedLine);
      depth += braceDeltaForLine(nestedLine);
      if (depth <= 0) break;
    }
    output.push(`${line.match(/^\s*/)?.[0] ?? ''}}`);
  }
  return changed ? output.join('\n') : source;
}

function wrapSingleStatementLoopBodies(source) {
  source = wrapNestedBracedLoopBodies(source);
  const inserts = [];
  scanJavaCode(source, 0, source.length, (index) => {
    const keyword = source.startsWith('for', index)
      ? 'for'
      : source.startsWith('while', index)
        ? 'while'
        : source.startsWith('if', index)
          ? 'if'
          : null;
    if (!keyword) return undefined;

    const before = index > 0 ? source[index - 1] : '';
    const after = source[index + keyword.length] ?? '';
    if ((before && isJavaIdentifierPart(before)) || (after && isJavaIdentifierPart(after))) {
      return undefined;
    }

    let cursor = index + keyword.length;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '(') return undefined;

    const closeParen = findMatchingParen(source, cursor);
    if (closeParen < 0) return undefined;

    let bodyStart = closeParen + 1;
    while (/\s/.test(source[bodyStart] ?? '')) bodyStart += 1;
    const bodyChar = source[bodyStart];
    if (!bodyChar || bodyChar === '{' || bodyChar === ';') return closeParen;
    if (
      startsWithJavaKeyword(source, bodyStart, 'switch') ||
      startsWithJavaKeyword(source, bodyStart, 'synchronized') ||
      startsWithJavaKeyword(source, bodyStart, 'try')
    ) {
      return closeParen;
    }

    const bodyEnd = findSingleStatementEnd(source, bodyStart);
    if (bodyEnd < 0) return closeParen;

    inserts.push({ index: bodyStart, text: '{ ' });
    inserts.push({ index: bodyEnd + 1, text: ' }' });
    return bodyEnd;
  });

  if (inserts.length === 0) return source;

  const insertsByIndex = new Map();
  for (const insert of inserts) {
    insertsByIndex.set(insert.index, `${insertsByIndex.get(insert.index) ?? ''}${insert.text}`);
  }

  let output = '';
  for (let index = 0; index <= source.length; index += 1) {
    output += insertsByIndex.get(index) ?? '';
    if (index < source.length) output += source[index];
  }
  return output === source ? output : wrapSingleStatementLoopBodies(output);
}

function splitTopLevelJavaList(value) {
  const parts = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    const previous = index > 0 ? value[index - 1] : '';
    if (quote) {
      if (ch === quote && previous !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (ch === '[') bracketDepth += 1;
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (ch === '<') angleDepth += 1;
    if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (
      ch === ',' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail.length > 0) {
    parts.push(tail);
  }
  return parts;
}

function parseJavaParameters(parametersSource) {
  return splitTopLevelJavaList(parametersSource)
    .map((parameter) => parameter.replace(/@\w+(?:\([^)]*\))?/g, '').replace(/\bfinal\b/g, '').trim())
    .map((parameter) => {
      const match = parameter.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\.\.)?$/);
      const name = match?.[1] ?? '';
      return {
        name,
        isArray: parameter.includes('[]') || parameter.includes('...'),
      };
    })
    .filter((parameter) => parameter.name.length > 0);
}

function parseJavaParameterNames(parametersSource) {
  return parseJavaParameters(parametersSource).map((parameter) => parameter.name);
}

function collectJavaArrayDeclarations(line) {
  const names = [];
  const declarationPattern =
    /\b(?:boolean|byte|char|short|int|long|float|double|String|[A-Za-z_][A-Za-z0-9_<>.?]*)\s*(?:\[\s*\])+\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const match of line.matchAll(declarationPattern)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const JAVA_WORKER_LEXICAL_STATE_CACHE_LIMIT = 4096;
const javaWorkerLexicalStateCache = new Map();

function cachedJavaWorkerLineLexicalState(line) {
  const source = String(line ?? '');
  const cached = javaWorkerLexicalStateCache.get(source);
  if (cached) return cached;
  if (javaWorkerLexicalStateCache.size >= JAVA_WORKER_LEXICAL_STATE_CACHE_LIMIT) {
    javaWorkerLexicalStateCache.clear();
  }
  const state = buildJavaWorkerLineLexicalState(source);
  javaWorkerLexicalStateCache.set(source, state);
  return state;
}

function buildJavaWorkerLineLexicalState(line) {
  const insideString = new Uint8Array(line.length + 1);
  let quote = null;
  let escaped = false;

  const storeState = (offset) => {
    insideString[offset] = quote !== null ? 1 : 0;
  };

  let index = 0;
  storeState(0);
  while (index < line.length) {
    const ch = line[index];
    const next = line[index + 1] ?? '';
    if (escaped) {
      escaped = false;
      index += 1;
      storeState(index);
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        escaped = true;
        index += 1;
        storeState(index);
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      storeState(index);
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === '"' || ch === "'") quote = ch;
    index += 1;
    storeState(index);
  }

  return { insideString };
}

function isInsideJavaStringLiteral(line, offset) {
  const state = cachedJavaWorkerLineLexicalState(line);
  const safeOffset = Math.max(0, Math.min(state.insideString.length - 1, Number(offset) || 0));
  return state.insideString[safeOffset] === 1;
}

function parseNativeTraceLine(line) {
  const match = line.match(/TraceHooks\.emit(?:Line|Call|Return)AtLine\((\d+)\b/);
  if (!match) return null;
  const lineNumber = Number.parseInt(match[1], 10);
  return Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : null;
}

function augmentTraceCallArgumentSnapshots(source) {
  const lines = source.split('\n');
  const methodStack = [];
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;
  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({
        name: methodMatch[2],
        params: parseJavaParameterNames(methodMatch[3] ?? ''),
        depth: 1,
        patchedCall: false,
      });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;
    if (currentMethod && !currentMethod.patchedCall && currentMethod.params.length > 0) {
      const callPattern = new RegExp(
        `^(\\s*)TraceHooks\\.emitCallAtLine\\((\\d+),\\s*"${escapeRegExp(currentMethod.name)}",\\s*([^)]*)\\);\\s*$`
      );
      const callMatch = line.match(callPattern);
      if (callMatch) {
        const serializedArgs = currentMethod.params
          .map((paramName) => ` + " ${paramName}=" + TraceHooks.serializeResult(${paramName})`)
          .join('');
        nextLine = `${callMatch[1]}TraceHooks.emitCallAtLine(${callMatch[2]}, "${currentMethod.name}", ""${serializedArgs});`;
        currentMethod.patchedCall = true;
      }
    }

    if (currentMethod) {
      currentMethod.depth += braceDelta(nextLine);
      while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
        methodStack.pop();
      }
    }

    return nextLine;
  }).join('\n');
}

function collectJavaLocalDeclarations(line) {
  const names = [];
  const trimmedLine = String(line).trim();
  if (/^(?:return|throw|break|continue)\b/.test(trimmedLine)) {
    return names;
  }
  if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
    return names;
  }
  const declarationPattern =
    /\b(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?==)/g;
  const skippedNames = new Set(['class', 'interface', 'enum', 'record', 'return', 'new']);
  for (const match of line.matchAll(declarationPattern)) {
    const typeSource = match[1] ?? '';
    const name = match[2];
    if (name && !skippedNames.has(name) && !name.startsWith('__tracecode')) {
      names.push(name);
    }
  }
  const enhancedForMatch = line.match(
    /\bfor\s*\(\s*(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/
  );
  const enhancedForType = enhancedForMatch?.[1] ?? '';
  const enhancedForName = enhancedForMatch?.[2];
  if (enhancedForName && !skippedNames.has(enhancedForName) && !enhancedForName.startsWith('__tracecode')) {
    names.push(enhancedForName);
  }
  return names;
}

function visibleJavaLocalNames(scopeStack) {
  const names = [];
  const seen = new Set();
  for (const scope of scopeStack) {
    for (const name of scope.names) {
      if (!seen.has(name)) {
        names.push(name);
        seen.add(name);
      }
    }
  }
  return names;
}

function isUnbracedForDeclarationLine(line) {
  return /^\s*for\s*\(/.test(line) && !(line.includes('{'));
}

function isControlHeaderDeclarationLine(line) {
  return /^\s*(?:for|if|while|switch|catch)\s*\(/.test(line);
}

function traceEmitAlreadyIncludesVariable(emitExpression, name) {
  return new RegExp(`\\b${escapeRegExp(name)}=`).test(emitExpression);
}

function appendJavaLocalSnapshotsToEmitLine(line, scopeStack) {
  const visibleNames = visibleJavaLocalNames(scopeStack);
  if (visibleNames.length === 0 || !line.includes('TraceHooks.emitLineAtLine(')) {
    return line;
  }

  return line.replace(/TraceHooks\.emitLineAtLine\((\d+)(?:,\s*([^;]*?))?\);/g, (match, lineNumber, snapshotExpression) => {
    const emitExpression = snapshotExpression ?? '';
    const additions = visibleNames
      .filter((name) => !traceEmitAlreadyIncludesVariable(emitExpression, name))
      .map((name) => ` + " ${name}=" + TraceHooks.serializeResult(${name})`)
      .join('');
    if (!additions) return match;
    const prefix = emitExpression.trim().length > 0 ? emitExpression.trim() : '""';
    return `TraceHooks.emitLineAtLine(${Number.parseInt(lineNumber, 10)}, ${prefix}${additions});`;
  });
}

function appendJavaLocalSnapshotsAfterMutations(line, scopeStack) {
  const visibleNames = visibleJavaLocalNames(scopeStack);
  if (visibleNames.length === 0 || !line.includes('TraceHooks.emitMutatingCallAtLine(')) {
    return line;
  }

  return line.replace(
    /(TraceHooks\.emitMutatingCallAtLine\((\d+),[^;]+;\s*)/g,
    (match, statement, lineNumber) => {
      const additions = visibleNames
        .map((name) => ` + " ${name}=" + TraceHooks.serializeResult(${name})`)
        .join('');
      return `${statement} TraceHooks.emitLineAtLine(${lineNumber}, ""${additions});`;
    }
  );
}

function guardJavaLineEmit(line) {
  return line.replace(
    /^(\s*)TraceHooks\.emitLineAtLine\((.+)\);\s*$/,
    (_match, indent, argsSource) => `${indent}if (!TraceHooks.limitExceeded) TraceHooks.emitLineAtLine(${argsSource});`
  );
}

/**
 * After the stored-event budget trips, TraceJVM still pays for every instrumented
 * TraceHooks call even when the hook immediately returns. Rewrite call sites so
 * post-budget paths use plain Java (reads) or skip emit-only statements entirely.
 * Event shape up to the budget is unchanged.
 */
const TRACE_ARRAY_READ_HELPERS = new Set([
  'readIntArrayAtLine',
  'readLongArrayAtLine',
  'readBooleanArrayAtLine',
  'readDoubleArrayAtLine',
  'readFloatArrayAtLine',
  'readCharArrayAtLine',
  'readByteArrayAtLine',
  'readShortArrayAtLine',
  'readObjectArrayAtLine',
]);

const TRACE_MATRIX_READ_HELPERS = new Set([
  'readIntMatrixAtLine',
  'readLongMatrixAtLine',
  'readBooleanMatrixAtLine',
  'readDoubleMatrixAtLine',
  'readFloatMatrixAtLine',
  'readCharMatrixAtLine',
  'readByteMatrixAtLine',
  'readShortMatrixAtLine',
  'readObjectMatrixAtLine',
]);

const TRACE_EMIT_ONLY_HELPERS = new Set([
  'emit',
  'emitLineAtLine',
  'emitCallAtLine',
  'emitReturnAtLine',
  'emitSerializedReturnAtLine',
  'emitScalarWriteAtLine',
  'emitRuntimeSnapshotAtLine',
  'emitArrayWriteAtLine',
  'emitFieldWriteAtLine',
  'emitFieldPathWriteAtLine',
  'emitIndexedWriteAtLine',
  'emitMutatingCallAtLine',
  'emitThrowAtLine',
  'emitStdoutAtLine',
]);

function findMatchingJavaParen(source, openIndex) {
  let depth = 0;
  let inString = false;
  let inChar = false;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && (inString || inChar)) {
      escaped = true;
      continue;
    }
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (inChar) {
      if (ch === "'") inChar = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "'") {
      inChar = true;
      continue;
    }
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitJavaTopLevelArgs(argsSource) {
  const args = [];
  let start = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inString = false;
  let inChar = false;
  let escaped = false;
  for (let index = 0; index < argsSource.length; index += 1) {
    const ch = argsSource[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && (inString || inChar)) {
      escaped = true;
      continue;
    }
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (inChar) {
      if (ch === "'") inChar = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "'") {
      inChar = true;
      continue;
    }
    if (ch === '(') depthParen += 1;
    else if (ch === ')') depthParen -= 1;
    else if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket -= 1;
    else if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace -= 1;
    // No angle-bracket tracking: generated hook args never carry type
    // arguments, but learner index expressions can contain bare `<`/`>`
    // comparisons, which would desync a depth counter.
    else if (
      ch === ',' &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0
    ) {
      args.push(argsSource.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = argsSource.slice(start).trim();
  if (tail || args.length > 0) args.push(tail);
  return args;
}

function skipJavaWhitespaceAndCommentsBackward(source, index) {
  let cursor = index;
  while (cursor >= 0) {
    const ch = source[cursor];
    if (/\s/.test(ch)) {
      cursor -= 1;
      continue;
    }
    if (ch === '/' && cursor > 0 && source[cursor - 1] === '*') {
      cursor -= 2;
      while (cursor >= 1) {
        if (source[cursor - 1] === '/' && source[cursor] === '*') {
          cursor -= 2;
          break;
        }
        cursor -= 1;
      }
      continue;
    }
    break;
  }
  return cursor;
}

function isAlreadyBudgetGuardedTraceCall(source, callStart) {
  const before = skipJavaWhitespaceAndCommentsBackward(source, callStart - 1);
  if (before < 0) return false;
  const guards = [
    'if (!TraceHooks.limitExceeded)',
    'if (!TraceHooks.traceLimitExceeded())',
  ];
  for (const guard of guards) {
    if (before + 1 >= guard.length) {
      const slice = source.slice(before - guard.length + 1, before + 1);
      if (slice === guard) return true;
    }
  }
  // Already rewritten as `(TraceHooks.limitExceeded ? plain : TraceHooks.…)`
  if (source[before] === ':') {
    const window = source.slice(Math.max(0, before - 80), before + 1);
    if (window.includes('limitExceeded') || window.includes('traceLimitExceeded()')) {
      return true;
    }
  }
  return false;
}

function collectTraceHooksCalls(source) {
  const calls = [];
  let index = 0;
  let inString = false;
  let inChar = false;
  let escaped = false;
  while (index < source.length) {
    const ch = source[index];
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (ch === '\\' && (inString || inChar)) {
      escaped = true;
      index += 1;
      continue;
    }
    if (inString) {
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }
    if (inChar) {
      if (ch === "'") inChar = false;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (ch === "'") {
      inChar = true;
      index += 1;
      continue;
    }
    if (source.startsWith('TraceHooks.', index)) {
      const nameStart = index + 'TraceHooks.'.length;
      let nameEnd = nameStart;
      while (nameEnd < source.length && /[A-Za-z0-9_]/.test(source[nameEnd])) {
        nameEnd += 1;
      }
      const name = source.slice(nameStart, nameEnd);
      let open = nameEnd;
      while (open < source.length && /\s/.test(source[open])) open += 1;
      if (source[open] === '(') {
        const close = findMatchingJavaParen(source, open);
        if (close >= 0) {
          calls.push({
            start: index,
            end: close + 1,
            name,
            argsSource: source.slice(open + 1, close),
          });
          index = close + 1;
          continue;
        }
      }
      index = nameEnd;
      continue;
    }
    index += 1;
  }
  return calls;
}

function plainExprForTraceReadCall(call) {
  const args = splitJavaTopLevelArgs(call.argsSource);
  if (TRACE_ARRAY_READ_HELPERS.has(call.name)) {
    if (args.length < 4) return null;
    return `${args[2]}[${args[3]}]`;
  }
  if (TRACE_MATRIX_READ_HELPERS.has(call.name)) {
    if (args.length < 5) return null;
    return `${args[2]}[${args[3]}][${args[4]}]`;
  }
  if (call.name === 'readArrayLengthAtLine') {
    if (args.length < 3) return null;
    // 3-arg: length of the array/collection expression itself.
    // 5-arg nested form still lengths args[2].
    return `${args[2]}.length`;
  }
  if (call.name === 'readObjectFieldAtLine' || call.name === 'readFieldPathAtLine') {
    if (args.length < 4) return null;
    return args[3];
  }
  return null;
}

function isStatementLevelTraceCall(source, call) {
  let after = call.end;
  while (after < source.length && /\s/.test(source[after])) after += 1;
  if (source[after] !== ';') return false;
  const before = skipJavaWhitespaceAndCommentsBackward(source, call.start - 1);
  if (before < 0) return true;
  const ch = source[before];
  // Statement boundary, or already inside `{ …; TraceHooks…; }` / line start.
  return ch === ';' || ch === '{' || ch === '}' || ch === '\n';
}

function elideTraceHooksAfterBudget(source) {
  const calls = collectTraceHooksCalls(source);
  let next = source;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    // Rewriting proceeds by descending start offset, so a call's start never
    // moves — but its interior can: a nested hook call inside this call's
    // arguments may already have been rewritten, shifting the closing paren.
    // Recompute the span and argument text against the current string instead
    // of trusting offsets collected from the original source.
    const start = calls[index].start;
    const name = calls[index].name;
    const token = `TraceHooks.${name}`;
    if (!next.startsWith(token, start)) continue;
    let open = start + token.length;
    while (open < next.length && /\s/.test(next[open])) open += 1;
    if (next[open] !== '(') continue;
    const close = findMatchingJavaParen(next, open);
    if (close < 0) continue;
    const call = {
      start,
      end: close + 1,
      name,
      argsSource: next.slice(open + 1, close),
    };
    if (isAlreadyBudgetGuardedTraceCall(next, call.start)) continue;

    const plain = plainExprForTraceReadCall(call);
    if (plain) {
      const hooked = next.slice(call.start, call.end);
      const replacement = `(TraceHooks.limitExceeded ? ${plain} : ${hooked})`;
      next = next.slice(0, call.start) + replacement + next.slice(call.end);
      continue;
    }

    if (
      TRACE_EMIT_ONLY_HELPERS.has(call.name) &&
      isStatementLevelTraceCall(next, call)
    ) {
      let end = call.end;
      while (end < next.length && /\s/.test(next[end])) end += 1;
      if (next[end] === ';') end += 1;
      const hookedStmt = next.slice(call.start, end);
      const replacement = `if (!TraceHooks.limitExceeded) ${hookedStmt}`;
      next = next.slice(0, call.start) + replacement + next.slice(end);
    }
  }
  return next;
}

function appendJavaScalarDeclarationWrites(line, lineNumber) {
  if (line.includes('TraceHooks.emitScalarWriteAtLine(')) return line;
  if (/TraceHooks\.read[A-Za-z0-9_]*AtLine\(/.test(line)) return line;
  if (/^\s*(?:for|if|while|switch|catch)\s*\(/.test(line)) return line;
  if (!/;\s*$/.test(line)) return line;
  const declarations = collectJavaLocalDeclarations(line);
  if (declarations.length === 0) return line;
  const indent = line.match(/^(\s*)/)?.[1] ?? '';
  const writes = declarations
    .map((name) => `${indent}TraceHooks.emitScalarWriteAtLine(${lineNumber}, "${name}", ${name});`)
    .join('\n');
  return `${line}\n${writes}`;
}

function appendJavaPendingScalarDeclarationWrites(line, lineNumber, declarations) {
  if (!Array.isArray(declarations) || declarations.length === 0) return line;
  if (!/;\s*$/.test(line)) return line;
  const indent = line.match(/^(\s*)/)?.[1] ?? '';
  const writes = declarations
    .map((name) => `${indent}TraceHooks.emitScalarWriteAtLine(${lineNumber}, "${name}", ${name});`)
    .join('\n');
  return writes ? `${line}\n${writes}` : line;
}

function augmentJavaLocalSnapshots(source) {
  const lines = source.split('\n');
  const output = [];
  const scopeStack = [];
  let currentTraceLine = null;
  let pendingScalarDeclarationWrites = null;
  let methodDepth = 0;
  let generatedExportsClassDepth = null;
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;
  const generatedExportsClassPattern = /^\s*(?:(?:public|private|protected|static|final)\s+)*class\s+Exports[A-Za-z0-9_]*\s*\{/;

  for (const line of lines) {
    if (generatedExportsClassDepth !== null) {
      output.push(line);
      generatedExportsClassDepth += braceDelta(line);
      if (generatedExportsClassDepth <= 0) generatedExportsClassDepth = null;
      continue;
    }
    if (generatedExportsClassPattern.test(line)) {
      output.push(line);
      generatedExportsClassDepth = Math.max(0, braceDelta(line));
      if (generatedExportsClassDepth <= 0) generatedExportsClassDepth = null;
      continue;
    }
    if (methodDepth <= 0) {
      const methodMatch = line.match(methodStartPattern);
      if (methodMatch) {
        methodDepth = Math.max(0, braceDelta(line));
        const params = parseJavaParameterNames(methodMatch[3] ?? '');
        scopeStack.length = 0;
        scopeStack.push({ names: params });
        output.push(line);
        if (methodDepth <= 0) {
          scopeStack.length = 0;
          pendingScalarDeclarationWrites = null;
        }
        continue;
      }
      output.push(line);
      continue;
    }

    const leadingClosingCount = line.match(/^\s*}+/)?.[0].replace(/\s/g, '').length ?? 0;
    for (let index = 0; index < leadingClosingCount; index += 1) {
      if (scopeStack.length > 0) scopeStack.pop();
    }

    const transformedLine = guardJavaLineEmit(appendJavaLocalSnapshotsAfterMutations(
      appendJavaLocalSnapshotsToEmitLine(line, scopeStack),
      scopeStack
    ));
    output.push(transformedLine);
    const emittedTraceLine = parseNativeTraceLine(output[output.length - 1]);
    if (emittedTraceLine !== null) currentTraceLine = emittedTraceLine;

    const declarations = collectJavaLocalDeclarations(line);
    if (declarations.length > 0 && currentTraceLine !== null) {
      const lastIndex = output.length - 1;
      output[lastIndex] = appendJavaScalarDeclarationWrites(output[lastIndex], currentTraceLine);
      if (
        !isControlHeaderDeclarationLine(line) &&
        line.includes('=') &&
        !line.includes('->') &&
        !/;\s*$/.test(line)
      ) {
        pendingScalarDeclarationWrites = {
          lineNumber: currentTraceLine,
          declarations: [...declarations],
        };
      }
    } else if (pendingScalarDeclarationWrites && /;\s*$/.test(line)) {
      const lastIndex = output.length - 1;
      output[lastIndex] = appendJavaPendingScalarDeclarationWrites(
        output[lastIndex],
        pendingScalarDeclarationWrites.lineNumber,
        pendingScalarDeclarationWrites.declarations
      );
      pendingScalarDeclarationWrites = null;
    }
    const declarationsBelongToCurrentScope =
      declarations.length > 0 && !isControlHeaderDeclarationLine(line);
    if (declarationsBelongToCurrentScope) {
      const currentScope = scopeStack[scopeStack.length - 1];
      if (currentScope) {
        for (const name of declarations) {
          currentScope.names.push(name);
        }
      }
    }
    const braceCounts = javaBraceCounts(line);
    const openingCount = braceCounts.open;
    const closingCount = Math.max(0, braceCounts.close - leadingClosingCount);
    for (let index = 0; index < openingCount; index += 1) {
      scopeStack.push({ names: index === 0 && !declarationsBelongToCurrentScope ? declarations : [] });
    }
    if (
      openingCount === 0 &&
      declarations.length > 0 &&
      !declarationsBelongToCurrentScope &&
      !isUnbracedForDeclarationLine(line)
    ) {
      const currentScope = scopeStack[scopeStack.length - 1];
      if (currentScope) {
        for (const name of declarations) {
          currentScope.names.push(name);
        }
      }
    }
    for (let index = 0; index < closingCount; index += 1) {
      if (scopeStack.length > 0) scopeStack.pop();
    }
    methodDepth += braceCounts.delta;
    if (methodDepth <= 0) {
      methodDepth = 0;
      scopeStack.length = 0;
      pendingScalarDeclarationWrites = null;
    }
  }

  return output.join('\n');
}

function collectJavaObjectDeclarations(line) {
  const names = [];
  const declarationPattern =
    /\b([A-Z][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+\1\s*\(/g;
  for (const match of line.matchAll(declarationPattern)) {
    if (match[2]) names.push(match[2]);
  }
  return names;
}

function collectJavaDeclaredLocalNames(line) {
  const names = new Set(collectJavaLocalDeclarations(line));
  const trimmedLine = String(line).trim();
  if (
    /^(?:return|throw|break|continue)\b/.test(trimmedLine) ||
    trimmedLine.startsWith('//') ||
    trimmedLine.startsWith('/*') ||
    trimmedLine.startsWith('*')
  ) {
    return [...names];
  }

  const declarationPattern =
    /^\s*(?:final\s+)?(?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Z][A-Za-z0-9_<>]*(?:\s*<[^;=(){}:]+>)?)\s*(?:\[\s*\])*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;|,)/;
  const match = line.match(declarationPattern);
  if (match?.[1] && !match[1].startsWith('__tracecode')) names.add(match[1]);
  return [...names];
}

function collectJavaMethodParameterNames(parametersSource) {
  const names = [];
  for (const parameter of splitTopLevelCommaList(parametersSource)) {
    const match = parameter.trim().match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function collectJavaFieldNames(source) {
  const names = new Set();
  let depth = 0;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (
      depth === 1 &&
      trimmed &&
      /;\s*$/.test(trimmed)
    ) {
      const match = trimmed.match(/^(?:public|private|protected|static|final|transient|volatile|\s)+\s*([A-Za-z_][A-Za-z0-9_<>\[\], ?]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=.*)?;\s*$/)
        || trimmed.match(/^([A-Za-z_][A-Za-z0-9_<>\[\], ?]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=.*)?;\s*$/);
      if (match?.[2]) names.add(match[2]);
    }
    depth += braceDelta(line);
  }
  return names;
}

function javaStringArrayLiteral(values) {
  return `new String[] { ${values.map((value) => javaStringLiteral(value)).join(', ')} }`;
}

function tryRewriteJavaNestedFieldWrite(line, lineNumber, fieldNames, localNames) {
  const emittedFieldRootWriteMatch = line.match(
    /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?);\s*TraceHooks\.emitFieldWriteAtLine\(\s*\d+\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*[^)]*\);\s*TraceHooks\.emitRuntimeSnapshotAtLine\([^;]+\);\s*$/
  );
  if (emittedFieldRootWriteMatch) {
    const indent = emittedFieldRootWriteMatch[1] ?? '';
    const root = emittedFieldRootWriteMatch[2];
    const field = emittedFieldRootWriteMatch[3];
    const rhs = emittedFieldRootWriteMatch[4];
    const emittedRoot = emittedFieldRootWriteMatch[5];
    const emittedField = emittedFieldRootWriteMatch[6];
    if (root === emittedRoot && field === emittedField && fieldNames.has(root) && !localNames.has(root)) {
      const left = `${root}.${field}`;
      return `${indent}{ ${left} = ${rhs}; TraceHooks.emitFieldPathWriteAtLine(${lineNumber}, "this", ${javaStringArrayLiteral([root, field])}, ${left}); TraceHooks.emitRuntimeSnapshotAtLine(${lineNumber}, "this", this); }`;
    }
  }

  const tracedReceiverMatch = line.match(
    /^(\s*)TraceHooks\.readObjectFieldAtLine\(\s*\d+\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*([^)]+)\)\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+);\s*$/
  );
  if (tracedReceiverMatch) {
    const indent = tracedReceiverMatch[1] ?? '';
    const root = tracedReceiverMatch[2];
    const firstField = tracedReceiverMatch[3];
    const receiverExpression = tracedReceiverMatch[4].trim();
    const finalField = tracedReceiverMatch[5];
    const rhs = tracedReceiverMatch[6];
    let variable = root;
    let path = [firstField, finalField];
    if (fieldNames.has(root) && !localNames.has(root)) {
      variable = 'this';
      path = [root, ...path];
    }
    const leftValueExpression = `${receiverExpression}.${finalField}`;
    const snapshotExpression = variable === 'this' ? 'this' : variable;
    return `${indent}{ TraceHooks.readObjectFieldAtLine(${lineNumber}, "${root}", "${firstField}", ${receiverExpression}).${finalField} = ${rhs}; TraceHooks.emitFieldPathWriteAtLine(${lineNumber}, "${variable}", ${javaStringArrayLiteral(path)}, ${leftValueExpression}); TraceHooks.emitRuntimeSnapshotAtLine(${lineNumber}, "${variable}", ${snapshotExpression}); }`;
  }

  const match = line.match(/^(\s*)((?:this\s*\.\s*)?[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)+)\s*=\s*(.+);\s*$/);
  if (!match || line.includes('TraceHooks.')) return null;
  const indent = match[1] ?? '';
  const left = match[2].replace(/\s+/g, '');
  const rhs = match[3];
  const parts = left.split('.');
  if (parts.length < 2) return null;

  let variable = parts[0];
  let path = parts.slice(1);
  if (variable === 'this') {
    path = parts.slice(1);
  } else if (fieldNames.has(variable) && !localNames.has(variable)) {
    path = [variable, ...path];
    variable = 'this';
  } else if (path.length < 2) {
    return null;
  }

  if (path.length === 0) return null;
  const snapshotExpression = variable === 'this' ? 'this' : variable;
  return `${indent}{ ${left} = ${rhs}; TraceHooks.emitFieldPathWriteAtLine(${lineNumber}, "${variable}", ${javaStringArrayLiteral(path)}, ${left}); TraceHooks.emitRuntimeSnapshotAtLine(${lineNumber}, "${variable}", ${snapshotExpression}); }`;
}

function rewriteJavaObjectFieldReads(expression, objectNames, lineNumber) {
  let output = expression;
  for (const name of objectNames) {
    const fieldPattern = new RegExp(`\\b${escapeRegExp(name)}\\.([A-Za-z_][A-Za-z0-9_]*)\\b`, 'g');
    output = output.replace(fieldPattern, (match, field, offset, fullSource) => {
      const marker = fullSource.lastIndexOf('TraceHooks.', offset);
      const delimiter = Math.max(fullSource.lastIndexOf(';', offset), fullSource.lastIndexOf('\n', offset));
      if (marker > delimiter) return match;
      const nextChar = fullSource[offset + match.length] ?? '';
      if (nextChar === '(') return match;
      return `TraceHooks.readObjectFieldAtLine(${lineNumber}, "${name}", "${field}", ${match})`;
    });
  }
  return output;
}

function augmentJavaObjectFieldOperations(source) {
  const lines = source.split('\n');
  const fieldNames = collectJavaFieldNames(source);
  const methodStack = [];
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({
        depth: 1,
        currentTraceLine: null,
        objectNames: new Set(),
        localNames: new Set(collectJavaMethodParameterNames(methodMatch[3] ?? '')),
      });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;
    if (!currentMethod) return nextLine;

    for (const name of collectJavaObjectDeclarations(line)) {
      currentMethod.objectNames.add(name);
    }
    for (const name of collectJavaDeclaredLocalNames(line)) {
      currentMethod.localNames.add(name);
    }

    const traceLine = parseNativeTraceLine(line);
    if (traceLine !== null) currentMethod.currentTraceLine = traceLine;

    const lineNumber = currentMethod.currentTraceLine;
    if (lineNumber !== null) {
      const nestedWrite = tryRewriteJavaNestedFieldWrite(nextLine, lineNumber, fieldNames, currentMethod.localNames);
      if (nestedWrite) {
        nextLine = nestedWrite;
      }
    }
    if (lineNumber !== null && currentMethod.objectNames.size > 0) {
      for (const name of currentMethod.objectNames) {
        const writePattern = new RegExp(`^(\\s*)${escapeRegExp(name)}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+);\\s*$`);
        const writeMatch = nextLine.match(writePattern);
        if (writeMatch) {
          const indent = writeMatch[1] ?? '';
          const field = writeMatch[2];
          const rhs = writeMatch[3];
          nextLine = `${indent}{ ${name}.${field} = ${rhs}; TraceHooks.emitFieldWriteAtLine(${lineNumber}, "${name}", "${field}", ${name}.${field}); TraceHooks.emitRuntimeSnapshotAtLine(${lineNumber}, "${field}", ${name}.${field}); }`;
          break;
        }
      }

      const returnMatch = nextLine.match(/^(\s*)return\s+(.+);\s*$/);
      if (returnMatch) {
        nextLine = `${returnMatch[1]}return ${rewriteJavaObjectFieldReads(returnMatch[2], currentMethod.objectNames, lineNumber)};`;
      }
    }

    currentMethod.depth += braceDelta(nextLine);
    while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
      methodStack.pop();
    }
    return nextLine;
  }).join('\n');
}

function augmentJavaThrowEvents(source) {
  const lines = source.split('\n');
  const methodStack = [];
  let thrownIndex = 0;
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({ depth: 1, currentTraceLine: null });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;
    if (!currentMethod) return nextLine;

    const traceLine = parseNativeTraceLine(line);
    if (traceLine !== null) currentMethod.currentTraceLine = traceLine;

    const throwMatch = nextLine.match(/^(\s*)throw\s+(.+);\s*$/);
    if (throwMatch && currentMethod.currentTraceLine !== null) {
      const indent = throwMatch[1] ?? '';
      const tempName = `__tracecodeThrown${thrownIndex++}`;
      const expression = throwMatch[2];
      nextLine = `${indent}{ var ${tempName} = ${expression}; TraceHooks.emitExceptionAtLine(${currentMethod.currentTraceLine}, String.valueOf(${tempName})); throw ${tempName}; }`;
    }

    currentMethod.depth += braceDelta(nextLine);
    while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
      methodStack.pop();
    }
    return nextLine;
  }).join('\n');
}

function augmentJavaStdoutEvents(source) {
  const lines = source.split('\n');
  const methodStack = [];
  let stdoutIndex = 0;
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({ depth: 1, currentTraceLine: null });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;
    if (!currentMethod) return nextLine;

    const traceLine = parseNativeTraceLine(line);
    if (traceLine !== null) currentMethod.currentTraceLine = traceLine;

    const stdoutMatch = nextLine.match(/^(\s*)System\.out\.println\((.+)\);\s*$/);
    if (stdoutMatch && currentMethod.currentTraceLine !== null) {
      const indent = stdoutMatch[1] ?? '';
      const tempName = `__tracecodeStdout${stdoutIndex++}`;
      const expression = stdoutMatch[2];
      nextLine = `${indent}{ var ${tempName} = ${expression}; System.out.println(${tempName}); TraceHooks.emitStdoutAtLine(${currentMethod.currentTraceLine}, String.valueOf(${tempName})); }`;
    }

    currentMethod.depth += braceDelta(nextLine);
    while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
      methodStack.pop();
    }
    return nextLine;
  }).join('\n');
}

function augmentArrayLengthReads(source) {
  const lines = source.split('\n');
  const methodStack = [];
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      const parameters = parseJavaParameters(methodMatch[3] ?? '');
      methodStack.push({
        depth: 1,
        currentTraceLine: null,
        hasTraceEmit: false,
        arrayNames: new Set(parameters.filter((parameter) => parameter.isArray).map((parameter) => parameter.name)),
      });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;

    if (currentMethod) {
      for (const name of collectJavaArrayDeclarations(line)) {
        currentMethod.arrayNames.add(name);
      }

      const traceLine = parseNativeTraceLine(line);
      if (traceLine !== null) {
        currentMethod.currentTraceLine = traceLine;
        currentMethod.hasTraceEmit = true;
      }

      if (
        currentMethod.hasTraceEmit &&
        currentMethod.currentTraceLine !== null &&
        !line.includes('TraceHooks.readArrayLengthAtLine')
      ) {
        for (const arrayName of currentMethod.arrayNames) {
          const lengthPattern = new RegExp(`\\b${escapeRegExp(arrayName)}\\.length\\b`, 'g');
          nextLine = nextLine.replace(lengthPattern, (match, offset) => {
            if (isInsideJavaStringLiteral(nextLine, offset)) return match;
            return `TraceHooks.readArrayLengthAtLine(${currentMethod.currentTraceLine}, "${arrayName}", ${arrayName})`;
          });
        }
      }

      currentMethod.depth += braceDelta(nextLine);
      while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
        methodStack.pop();
      }
    }

    return nextLine;
  }).join('\n');
}

function augmentTraceReturnValueSnapshots(source) {
  const lines = source.split('\n');
  const output = [];
  const methodStack = [];
  let returnValueIndex = 0;
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*([A-Za-z_][A-Za-z0-9_<>\[\], ?]*(?:\[\])?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({
        name: methodMatch[3],
        returnType: (methodMatch[2] ?? '').trim(),
        depth: 1,
      });
      output.push(line);
      continue;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    if (currentMethod && currentMethod.returnType !== 'void') {
      const returnEmitMatch = line.match(
        /^(\s*)TraceHooks\.emitReturnAtLine\((\d+),\s*"([A-Za-z_][A-Za-z0-9_]*)"\);\s*$/
      );
      const nextLine = lines[index + 1] ?? '';
      const returnMatch = nextLine.match(/^(\s*)return\s+(.+);\s*$/);
      if (returnEmitMatch && returnMatch && returnEmitMatch[3] === currentMethod.name) {
        const tempName = `__tracecodeReturnValue${returnValueIndex++}`;
        const indent = returnEmitMatch[1] ?? returnMatch[1] ?? '';
        const returnExpression = returnMatch[2].trim();
        output.push(`${indent}${currentMethod.returnType} ${tempName} = ${returnExpression};`);
        output.push(
          `${indent}TraceHooks.emitSerializedReturnAtLine(${returnEmitMatch[2]}, "${currentMethod.name}", TraceHooks.serializeResult(${tempName}));`
        );
        output.push(`${returnMatch[1] ?? indent}return ${tempName};`);
        currentMethod.depth += braceDelta(line) + braceDelta(nextLine);
        index += 1;
        while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
          methodStack.pop();
        }
        continue;
      }
    }

    output.push(line);
    if (currentMethod) {
      currentMethod.depth += braceDelta(line);
      while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
        methodStack.pop();
      }
    }
  }

  return output.join('\n');
}

function splitImportPrelude(source) {
  const lines = source.split('\n');
  const importLines = [];
  const bodyLines = [];
  let inImportPrelude = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inImportPrelude && (trimmed === '' || trimmed.startsWith('import '))) {
      importLines.push(line);
      continue;
    }
    inImportPrelude = false;
    bodyLines.push(line);
  }

  return { importLines, bodyLines };
}

function splitImportPreludeEntries(source) {
  const lines = source.split('\n');
  const importEntries = [];
  const bodyEntries = [];
  let inImportPrelude = true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const entry = { line, sourceLine: index + 1 };
    const trimmed = line.trim();
    if (inImportPrelude && (trimmed === '' || trimmed.startsWith('import '))) {
      importEntries.push(entry);
      continue;
    }
    inImportPrelude = false;
    bodyEntries.push(entry);
  }

  return { importEntries, bodyEntries };
}

function trimBlankEntries(entries) {
  let start = 0;
  let end = entries.length;
  while (start < end && entries[start].line.trim().length === 0) start += 1;
  while (end > start && entries[end - 1].line.trim().length === 0) end -= 1;
  return entries.slice(start, end);
}

function isTopLevelMethodStart(line) {
  const trimmed = line.trim();
  return /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:[\w<>\[\], ?]+\s+)+[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*\)\s*\{/.test(trimmed);
}

function isTopLevelTypeStart(line) {
  const trimmed = line.trim();
  return /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(trimmed);
}

function isTopLevelMemberStart(line) {
  return isTopLevelMethodStart(line) || isTopLevelTypeStart(line);
}

function javaBraceCounts(line) {
  let open = 0;
  let close = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    const next = line[index + 1] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === '/' && next === '*') {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') open += 1;
    if (ch === '}') close += 1;
  }
  return { open, close, delta: open - close };
}

function braceDelta(line) {
  return javaBraceCounts(line).delta;
}

function splitScriptMembersAndStatements(lines) {
  const memberLines = [];
  const statementLines = [];
  let statementDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const entry = lines[index];
    const line = typeof entry === 'string' ? entry : entry.line;
    if (statementDepth !== 0 || !isTopLevelMemberStart(line)) {
      statementLines.push(entry);
      statementDepth += braceDelta(line);
      if (statementDepth < 0) statementDepth = 0;
      continue;
    }

    let depth = 0;
    do {
      const current = lines[index] ?? '';
      const currentLine = typeof current === 'string' ? current : current.line;
      memberLines.push(current);
      depth += braceDelta(currentLine);
      index += 1;
    } while (index < lines.length && depth > 0);
    index -= 1;
  }
  return {
    memberLines,
    statementLines,
    memberEntries: memberLines,
    statementEntries: statementLines,
  };
}

function normalizeFunctionSource(source) {
  if (/\bpackage\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/.test(source)) {
    throw new Error('Java function style should not declare a package; the harness manages package isolation.');
  }

  if (/\bclass\s+Solution\b/.test(source)) {
    return wrapSingleStatementLoopBodies(source);
  }

  if (/\b(class|interface|enum|record)\b/.test(source)) {
    throw new Error(
      'Java function style currently expects a bare method fragment or a class named Solution containing the target method.'
    );
  }

  const { importLines, bodyLines } = splitImportPrelude(source);

  const importBlock = importLines.join('\n').trim();
  const body = bodyLines.join('\n').trim();
  if (!body) {
    throw new Error('Java function style requires a method fragment.');
  }

  return wrapSingleStatementLoopBodies(`${importBlock ? `${importBlock}\n\n` : ''}class Solution {\n${indentBlock(body, 2)}\n}`);
}

function normalizeScriptSource(source) {
  return normalizeScriptSourceWithLineMap(source).code;
}

function normalizeScriptSourceWithLineMap(source) {
  if (/\bpackage\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/.test(source)) {
    throw new Error('Java script style should not declare a package; the harness manages package isolation.');
  }

  const { importEntries, bodyEntries } = splitImportPreludeEntries(source);
  const { memberEntries, statementEntries } = splitScriptMembersAndStatements(bodyEntries);
  const trimmedMemberEntries = trimBlankEntries(memberEntries);
  const trimmedStatementEntries = trimBlankEntries(statementEntries);
  if (trimmedStatementEntries.length === 0) {
    throw new Error('Java script style requires executable statements and a result assignment.');
  }

  const outputLines = [];
  const lineMap = {};
  const firstStatementLine = trimmedStatementEntries[0]?.sourceLine;
  const lastStatementLine = trimmedStatementEntries[trimmedStatementEntries.length - 1]?.sourceLine;
  const declaresResult = trimmedStatementEntries.some((entry) =>
    /^(?:final\s+)?[\w<>\[\], ?]+\s+result\s*(?:=|;)/.test(entry.line.trim())
  );
  const pushLine = (line, sourceLine) => {
    outputLines.push(line);
    if (Number.isFinite(sourceLine) && sourceLine > 0) {
      lineMap[outputLines.length] = sourceLine;
    }
  };

  for (const entry of importEntries) {
    pushLine(entry.line, entry.sourceLine);
  }
  pushLine('class Solution {');
  for (const entry of trimmedMemberEntries) {
    pushLine(entry.line.trim().length === 0 ? '' : `  ${entry.line}`, entry.sourceLine);
  }
  pushLine(`  Object ${SCRIPT_METHOD_NAME}() {`, firstStatementLine);
  if (!declaresResult) {
    pushLine('    Object result = null;', firstStatementLine);
  }
  for (const entry of trimmedStatementEntries) {
    pushLine(entry.line.trim().length === 0 ? '' : `    ${entry.line}`, entry.sourceLine);
  }
  pushLine('    return result;', lastStatementLine);
  pushLine('  }');
  pushLine('}');

  return {
    code: wrapSingleStatementLoopBodies(outputLines.join('\n')),
    lineMap,
  };
}

function normalizeJavaRequest(payload) {
  if (isScriptRequest(payload)) {
    if (payload.executionStyle !== 'function') {
      throw new Error('Java script-mode execution only supports executionStyle="function".');
    }

    const normalizedScript = normalizeScriptSourceWithLineMap(payload.code);
    return {
      ...payload,
      code: normalizedScript.code,
      executionStyle: 'solution-method',
      functionName: SCRIPT_METHOD_NAME,
      sourceText: payload.code,
      sourceLineMap: normalizedScript.lineMap,
      userCodeLineCount: payload.code.split(/\r?\n/).length,
      scriptMode: true,
    };
  }

  if (payload.executionStyle === 'solution-method') {
    return {
      ...payload,
      sourceText: payload.code,
      code: wrapSingleStatementLoopBodies(payload.code),
    };
  }

  if (payload.executionStyle === 'ops-class') {
    return {
      ...payload,
      sourceText: payload.code,
      code: wrapSingleStatementLoopBodies(payload.code),
    };
  }

  if (payload.executionStyle !== 'function') {
    return payload;
  }

  return {
    ...payload,
    sourceText: payload.code,
    code: normalizeFunctionSource(payload.code),
    executionStyle: 'solution-method',
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  const source = typeof value === 'string' ? value : stableJson(value);
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    hashA ^= code;
    hashA = Math.imul(hashA, 0x01000193) >>> 0;
    hashB ^= code + index;
    hashB = Math.imul(hashB, 0x85ebca6b) >>> 0;
  }
  return `${hashA.toString(36)}${hashB.toString(36)}`;
}

function dynamicInputEntriesForPayload(payload, compileId) {
  if (payload.executionStyle === 'ops-class') return [];
  const parameters = extractMethodParameters(payload.code, payload.functionName);
  const invocationKeys = parameters.length > 0 ? parameters.map((parameter) => parameter.name) : Object.keys(payload.inputs ?? {});
  const entries = [];
  for (let index = 0; index < invocationKeys.length; index += 1) {
    const key = invocationKeys[index];
    const parameter = parameters[index];
    if (!parameter) continue;
    const value = inputValueForParameter(payload.inputs ?? {}, key, index);
    if (!isDynamicJavaInputType(parameter.type, value)) continue;
    const safeName = String(key).replace(/[^A-Za-z0-9_$-]/g, '_');
    entries.push({
      key,
      index,
      type: parameter.type,
      value,
      path: `${DYNAMIC_INPUT_PREFIX}-${compileId}-${index}-${safeName}.json`,
    });
  }
  return entries;
}

function preparedDynamicInputEntriesForPayload(payload, compileId) {
  if (payload.executionStyle === 'ops-class') {
    return [{
      key: '__ops__',
      index: 0,
      type: 'Object',
      path: `${DYNAMIC_INPUT_PREFIX}-${compileId}-ops.json`,
      property: `${PREPARED_INPUT_PROPERTY_PREFIX}${compileId}.ops`,
    }];
  }
  const parameters = extractMethodParameters(payload.code, payload.functionName);
  return parameters.map((parameter, index) => ({
    key: parameter.name,
    index,
    type: parameter.type,
    path: `${DYNAMIC_INPUT_PREFIX}-${compileId}-${index}-${String(parameter.name).replace(/[^A-Za-z0-9_$-]/g, '_')}.json`,
    property: `${PREPARED_INPUT_PROPERTY_PREFIX}${compileId}.${index}`,
  }));
}

function buildJavaCompileSeed(payload, compileMode = 'trace') {
  if (payload.executionStyle === 'ops-class') {
    return {
      compileMode,
      code: payload.code,
      functionName: payload.functionName,
      executionStyle: payload.executionStyle,
      inputs: payload.inputs ?? {},
    };
  }

  const parameters = extractMethodParameters(payload.code, payload.functionName);
  const invocationKeys = parameters.length > 0 ? parameters.map((parameter) => parameter.name) : Object.keys(payload.inputs ?? {});
  const inputs = {};
  for (let index = 0; index < invocationKeys.length; index += 1) {
    const key = invocationKeys[index];
    const parameter = parameters[index];
    const value = inputValueForParameter(payload.inputs ?? {}, key, index);
    inputs[key] = parameter && isDynamicJavaInputType(parameter.type, value)
      ? { mode: 'dynamic-json-file', type: normalizedJavaInputType(parameter.type) }
      : { mode: 'literal', value };
  }

  return {
    compileMode,
    code: payload.code,
    functionName: payload.functionName,
    executionStyle: payload.executionStyle,
    scriptMode: payload.scriptMode === true,
    inputs,
  };
}

function buildJavaCompileId(payload, compileMode = 'trace') {
  return stableHash(buildJavaCompileSeed(payload, compileMode));
}

function buildJavaBatchCompileId(payload, inputBatch) {
  return stableHash({
    compileMode: 'execute-batch',
    cases: inputBatch.map((inputs) => buildJavaCompileSeed({ ...payload, inputs }, 'execute-batch-case')),
  });
}

function javaWorkerRandomHex(words = 2) {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const values = new Uint32Array(Math.max(1, words));
      crypto.getRandomValues(values);
      return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
    }
  } catch {
    // Fall back below. The fallback still stays inside the JS worker and is not exposed to user Java code.
  }
  return stableHash({
    fallbackRandom: typeof Math !== 'undefined' && typeof Math.random === 'function' ? Math.random() : '',
    now: typeof Date !== 'undefined' && typeof Date.now === 'function' ? Date.now() : '',
    perf: typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : '',
    counter: javaCompileIsolationCounter,
  });
}

function isolateJavaCompileId(stableCompileId, requestId = '') {
  javaCompileIsolationCounter += 1;
  return stableHash({
    stableCompileId,
    requestId: String(requestId ?? ''),
    counter: javaCompileIsolationCounter,
    nonce: javaWorkerRandomHex(),
  });
}

async function writeDynamicInputFiles(dynamicInputs) {
  for (const input of dynamicInputs) {
    await self.cheerpOSAddStringFile(input.path, JSON.stringify(input.value));
  }
}

function dynamicInputByKey(dynamicInputs) {
  const out = new Map();
  for (const input of dynamicInputs) out.set(input.key, input);
  return out;
}

function buildExportsSource(source, functionName, executionStyle, input, options = {}) {
  const nestedTypeOwner = executionStyle === 'ops-class' ? functionName : 'Solution';
  const nestedTypeNames = collectJavaNestedTypes(source, nestedTypeOwner);
  const features = {
    ...detectFeatures(source, input, options),
    hasCustomObject: detectFeatures(source, input, options).hasCustomObject ||
      (containsPlainObjectLiteral(input) && nestedTypeNames.size > 0),
    skipInputMaterializers: options.scriptMode === true,
  };
  const helperMethods = buildHelperMethods(features);
  const nodePreludeSource = options.skipNodePrelude === true ? '' : buildNodePreludeSource(source, options);
  const dynamicInputsByKey = dynamicInputByKey(options.dynamicInputs ?? []);

  if (executionStyle === 'ops-class') {
    const preparedOpsInput = dynamicInputsByKey.get('__ops__');
    if (preparedOpsInput) {
      return `${nodePreludeSource}public class Exports {
${helperMethods}

  public static String run() {
    Object input = readJsonInputProperty(${JSON.stringify(preparedOpsInput.property)}, Object.class);
    return runPreparedOperations(${functionName}.class, input);
  }
}
`;
    }
    const operations = Array.isArray(input.operations) ? input.operations : [];
    const argumentsList = Array.isArray(input.arguments) ? input.arguments : [];
    const lines = ['    java.util.List<Object> out = new java.util.ArrayList<>();'];
    const firstOperation = operations.length > 0 ? String(operations[0]) : null;
    const hasConstructorOperation =
      firstOperation === functionName ||
      firstOperation === '__init__' ||
      firstOperation === 'init' ||
      (firstOperation !== null && extractMethodReturnType(source, firstOperation) === null);
    const constructorParameters = qualifyJavaParameters(
      extractMethodParametersForArguments(source, functionName, argumentsList[0]),
      nestedTypeNames,
      nestedTypeOwner
    );
    const constructorArgs = hasConstructorOperation
      ? inputArgumentsForParameters(argumentsList[0], constructorParameters)
      : [];
    const constructorInvocationArgs = constructorArgs
      .map((arg, argIndex) => buildJavaExpression(arg, constructorParameters[argIndex]?.type))
      .join(', ');
    lines.push(`    ${functionName} instance = new ${functionName}(${constructorInvocationArgs});`);
    if (hasConstructorOperation) {
      lines.push('    out.add(null);');
    }

    operations.forEach((operation, index) => {
      if (hasConstructorOperation && index === 0) {
        return;
      }
      const operationName = String(operation);
      const parameters = qualifyJavaParameters(
        extractMethodParametersForArguments(source, operationName, argumentsList[index]),
        nestedTypeNames,
        nestedTypeOwner
      );
      const args = inputArgumentsForParameters(argumentsList[index], parameters);
      const invocationArgs = args.map((arg, argIndex) => buildJavaExpression(arg, parameters[argIndex]?.type)).join(', ');
      const returnType = extractMethodReturnType(source, operationName);
      if (returnType === 'void') {
        lines.push(`    instance.${operationName}(${invocationArgs});`);
        lines.push('    out.add(null);');
      } else {
        lines.push(`    out.add(instance.${operationName}(${invocationArgs}));`);
      }
    });

    return `${nodePreludeSource}public class Exports {
${helperMethods}

  public static String run() {
${lines.join('\n')}
    return TraceHooks.serializeOutputResult(out);
  }
}
`;
  }

  const parameters = qualifyJavaParameters(extractMethodParameters(source, functionName), nestedTypeNames, nestedTypeOwner);
  const returnType = qualifyJavaNestedTypeReferences(extractMethodReturnType(source, functionName), nestedTypeNames, nestedTypeOwner);
  const invocationKeys = parameters.length > 0 ? parameters.map((parameter) => parameter.name) : Object.keys(input);
  const usedLocalNames = new Set(['solution', ...invocationKeys]);
  const resultLocalName = uniqueJavaIdentifier('__tracecode_result', usedLocalNames);
  const materializedArgs = [];
  for (let index = 0; index < invocationKeys.length; index += 1) {
    const key = invocationKeys[index];
    const parameter = parameters[index];
    const type = parameter ? parameter.type : 'Object';
    const value = inputValueForParameter(input, key, index);
    const dynamicInput = dynamicInputsByKey.get(key);
    const expression = dynamicInput
      ? dynamicJavaInputExpression(type, {
          ...dynamicInput,
          ownerClass: nestedTypeOwner,
          methodName: functionName,
          parameterIndex: index,
          parameterTypes: parameters.map((entry) => entry.type),
        })
      : buildJavaExpression(value, type);
    if (dynamicInput && !expression) {
      throw new Error(`Unsupported dynamic Java input type: ${type}`);
    }
    materializedArgs.push(`    ${type} ${key} = ${expression};`);
  }
  const invocationArgs = invocationKeys.join(', ');
  const invocationLine = returnType === 'void'
    ? `    solution.${functionName}(${invocationArgs});\n    return TraceHooks.serializeOutputResult(null);`
    : `    ${returnType || 'Object'} ${resultLocalName} = solution.${functionName}(${invocationArgs});\n    return TraceHooks.serializeOutputResult(${resultLocalName});`;

  return `${nodePreludeSource}public class Exports {
${helperMethods}

  public static String run() {
    Solution solution = new Solution();
${materializedArgs.join('\n')}
${invocationLine}
  }
}
`;
}

function buildPackageName(messageId) {
  return `harness.user.job${String(messageId).replace(/[^A-Za-z0-9]/g, '')}`;
}

function buildExportsClassName(messageId) {
  return `Exports${String(messageId).replace(/[^A-Za-z0-9]/g, '')}`;
}

function normalizeJavaSerializedOutput(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJavaSerializedOutput(item));
  }
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__class__') continue;
    if (value.__type__ === 'NestedInteger' && key === 'value' && child == null) continue;
    output[key] = normalizeJavaSerializedOutput(child);
  }
  return output;
}

async function ensureReady() {
  if (!workerReadyPromise) {
    workerReadyPromise = (async () => {
      const startedAt = performance.now();
      if (typeof self.cheerpjInit !== 'function') {
        self.importScripts(cheerpjLoaderUrl);
      }
      if (typeof self.cheerpjInit !== 'function') {
        throw new Error('CheerpJ loader did not expose cheerpjInit');
      }
      await self.cheerpjInit({ version: 17, status: 'none', natives: javaProjectNativeBridge() });
      if (
        typeof self.cheerpjRunLibrary !== 'function' ||
        typeof self.cheerpOSAddStringFile !== 'function'
      ) {
        throw new Error('CheerpJ runtime APIs are unavailable in the worker');
      }
      initLoadTimeMs = performance.now() - startedAt;
    })();
  }
  await workerReadyPromise;
}

function withJavaUserAuthorityLockdown(callback, mode = 'temporary') {
  if (typeof trustedJavaUserAuthorityLockdown !== 'function') {
    throw new Error('Java user execution requires the captured runtime authority lockdown policy.');
  }
  if (mode === 'isolated-origin') {
    if (!allowIsolatedRuntimeStorage) {
      throw new Error('Java isolated-origin authority requires an explicit execution-origin host.');
    }
    // The credential-free, cross-origin host is the application-authority
    // boundary. CheerpJ keeps its live runtime globals intact so a single VM
    // can serve the owning workspace session without reloading the JDK.
    return callback();
  }
  if (mode !== 'temporary' && mode !== 'permanent') {
    throw new Error(`Unsupported Java user authority mode: ${String(mode)}.`);
  }
  return trustedJavaUserAuthorityLockdown(callback, {
    mode,
    // User Java receives no general JavaScript object bridge. Avoid replacing
    // Object/Reflect intrinsics that CheerpJ's JIT and project VFS use heavily;
    // ambient browser capabilities themselves remain replaced and guarded.
    authorityOverrides: {
      fetch: guardedCheerpjRuntimeFetch,
      ...(allowIsolatedRuntimeStorage ? { indexedDB: trustedJavaIndexedDB } : {}),
    },
  });
}

function guardedCheerpjRuntimeFetch(input, init) {
  if (!trustedJavaWorkerFetch) {
    throw new Error('CheerpJ runtime fetch is unavailable.');
  }
  const requestUrl = new URL(
    typeof input === 'string' || input instanceof URL ? String(input) : input?.url,
    javaWorkerHref()
  );
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  if (!isAllowedCheerpjRuntimeRequest(method, requestUrl.href)) {
    throw new Error(`CheerpJ runtime fetch denied: ${method} ${requestUrl.href}`);
  }
  return trustedJavaWorkerFetch(input, {
    ...(init ?? {}),
    credentials: 'omit',
    redirect: 'error',
  });
}

function isAllowedCheerpjRuntimeRequest(method, href) {
  return (
    (method === 'GET' || method === 'HEAD') &&
    (
      cheerpjRuntimeFetchExactUrls.has(href) ||
      cheerpjRuntimeFetchPrefixes.some((prefix) => href.startsWith(prefix))
    )
  );
}


async function getHelperLibrary() {
  if (!helperLibraryPromise) {
    helperLibraryPromise = self.cheerpjRunLibrary(FULL_CLASSPATH());
  }
  return helperLibraryPromise;
}

async function getCompileLibraryClass() {
  if (!compileLibraryClassPromise) {
    compileLibraryClassPromise = (async () => {
      const library = await getHelperLibrary();
      return library.tracecode.browser.BrowserCompileAndTraceLibrary;
    })();
  }
  return compileLibraryClassPromise;
}

async function deleteJavaRuntimeRequestTree(compileLibraryClass, compileId) {
  if (typeof compileLibraryClass?.deleteRuntimeRequestTree !== 'function') {
    throw new Error('Java helper does not expose request-scoped runtime storage cleanup.');
  }
  await compileLibraryClass.deleteRuntimeRequestTree(`/files/java-worker/${compileId}`);
}

function classicJavaCompileCacheKey(mode, stableCompileId) {
  return stableHash({
    version: JAVA_COMPILE_CACHE_VERSION,
    mode,
    stableCompileId,
    helperJar: HELPER_JAR_PATH,
    compilerJar: JDK17_COMPILER_JAR_PATH,
  });
}

function classicJavaCompileCacheRoot(cacheKey) {
  return `/files/java-worker/compile-cache-${cacheKey}`;
}

async function trimClassicJavaCompileCache(compileLibraryClass) {
  while (javaCompileCache.size > javaCompileCacheLimit) {
    const oldest = javaCompileCache.keys().next().value;
    if (oldest === undefined) return;
    javaCompileCache.delete(oldest);
    await compileLibraryClass.deleteRuntimeRequestTree(classicJavaCompileCacheRoot(oldest));
  }
}

async function restoreClassicJavaCompileCache(compileLibraryClass, cacheKey, classesDir) {
  if (
    javaCompileCacheLimit <= 0 ||
    typeof compileLibraryClass?.restoreCompileCache !== 'function'
  ) {
    return false;
  }
  const restoredValue = await compileLibraryClass.restoreCompileCache(
    classicJavaCompileCacheRoot(cacheKey),
    classesDir
  );
  const restored = restoredValue === true || restoredValue === 1;
  if (restored) {
    javaCompileCache.delete(cacheKey);
    javaCompileCache.set(cacheKey, true);
    await trimClassicJavaCompileCache(compileLibraryClass);
  }
  return restored;
}

async function restoreHostJavaCompileArtifact(cacheKey, commandId) {
  if (javaCompileCacheLimit <= 0) return null;
  const response = await requestCompilerArtifactCache('get', cacheKey, commandId);
  return response?.hit === true && typeof response.value === 'string' && response.value.length > 0
    ? response.value
    : null;
}

async function storeHostJavaCompileArtifact(compileLibraryClass, cacheKey, classesDir, commandId) {
  if (javaCompileCacheLimit <= 0 || typeof compileLibraryClass?.exportCompiledClassManifest !== 'function') return;
  const manifest = await compileLibraryClass.exportCompiledClassManifest(classesDir);
  if (typeof manifest === 'string' && manifest.length > 0) {
    await requestCompilerArtifactCache('put', cacheKey, commandId, manifest);
  }
}

async function finalizeClassicJavaCompileCache(compileLibraryClass, cacheKey, classesDir, compileId, artifactCacheHit) {
  try {
    if (
      !artifactCacheHit &&
      javaCompileCacheLimit > 0 &&
      typeof compileLibraryClass?.commitCompileCache === 'function'
    ) {
      const committedValue = await compileLibraryClass.commitCompileCache(
        classesDir,
        classicJavaCompileCacheRoot(cacheKey)
      );
      const committed = committedValue === true || committedValue === 1;
      if (committed) {
        javaCompileCache.delete(cacheKey);
        javaCompileCache.set(cacheKey, true);
        await trimClassicJavaCompileCache(compileLibraryClass);
      }
    }
  } finally {
    await deleteJavaRuntimeRequestTree(compileLibraryClass, compileId);
  }
}

async function getRewriteLibraryClass() {
  if (!rewriteLibraryClassPromise) {
    rewriteLibraryClassPromise = (async () => {
      const library = await getHelperLibrary();
      return library.harness.browser.JavaRewriteLibrary;
    })();
  }
  return rewriteLibraryClassPromise;
}

async function warmRunHost() {
  if (!runWarmupPromise) {
    runWarmupPromise = (async () => {
      const totalStart = performance.now();
      const libraryClass = await getCompileLibraryClass();
      const runSourcePath = '/str/ExportsTracecodeRunWarmup.java';
      const runClassesDir = '/files/java-worker/__warm_run__/classes';
      const runWarmupSource = `
package harness.user.warmup;

import tracecode.user.TraceHooks;

class Solution {
  int add(int a, int b) {
    return a + b;
  }
}

public class ExportsTracecodeRunWarmup {
  public static String run() {
    Solution solution = new Solution();
    int a = 1;
    int b = 2;
    int result = solution.add(a, b);
    return TraceHooks.serializeOutputResult(result);
  }
}
`;
      await self.cheerpOSAddStringFile(runSourcePath, runWarmupSource);
      const hostCallStart = performance.now();
      const reportText = await libraryClass.compileAndRun(
        runSourcePath,
        runClassesDir,
        'harness.user.warmup.ExportsTracecodeRunWarmup',
        HELPER_JAR_PATH,
        DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
      );
      const hostCallEnd = performance.now();
      const report = JSON.parse(reportText);
      const totalEnd = performance.now();
      if (report.success !== true) {
        throw new Error(report.runtimeError || report.compilerStderr || report.compilerStdout || 'Java warmup failed');
      }
      return {
        success: true,
        loadTimeMs: Math.round(totalEnd - totalStart),
        timings: {
          totalMs: totalEnd - totalStart,
          hostCallMs: hostCallEnd - hostCallStart,
          compileMs: report.compileTimeMs ?? 0,
          classLoadMs: report.classLoadTimeMs ?? 0,
          runMs: report.runTimeMs ?? 0,
          compileCacheHit: report.compileCacheHit ?? false,
        },
      };
    })();
  }
  try {
    return await runWarmupPromise;
  } catch (error) {
    runWarmupPromise = null;
    throw error;
  }
}

async function rewriteSource(payload, compileId, dynamicInputs) {
  const rewriteLibraryClass = await getRewriteLibraryClass();
  const exportsClassName = buildExportsClassName(compileId);
  const packageName = buildPackageName(compileId);
  const exportsSource = buildExportsSource(
    payload.code,
    payload.functionName,
    payload.executionStyle,
    payload.inputs ?? {},
    {
      dynamicInputs,
      hasDynamicInputs: dynamicInputs.length > 0,
      scriptMode: payload.scriptMode === true,
    }
  );
  const rewrittenSource = await rewriteLibraryClass.rewriteSource(
    payload.code,
    payload.executionStyle,
    payload.functionName,
    exportsSource,
    exportsClassName,
    packageName
  );
  return addJavaDefaultImportsToPackagedSource(rewrittenSource);
}

function normalizePublicClassDeclarations(source) {
  return String(source).replace(/^([ \t]*)public\s+class\s+/gm, '$1class ');
}

function buildPlainRunnableSource(payload, compileId, dynamicInputs) {
  const exportsClassName = buildExportsClassName(compileId);
  const packageName = buildPackageName(compileId);
  const exportsSource = buildExportsSource(
    payload.code,
    payload.functionName,
    payload.executionStyle,
    payload.inputs ?? {},
    {
      dynamicInputs,
      hasDynamicInputs: dynamicInputs.length > 0,
      scriptMode: payload.scriptMode === true,
    }
  ).replaceAll(/\bpublic class Exports\b/g, `public class ${exportsClassName}`);

  return [
    `package ${packageName};`,
    '',
    'import tracecode.user.TraceHooks;',
    javaDefaultImportsBlock(),
    '',
    normalizePublicClassDeclarations(payload.code).trim(),
    '',
    exportsSource.trim(),
    '',
  ].join('\n');
}

function buildBatchRunnableSource(payload, compileId, inputBatch, dynamicInputBatch) {
  const exportsClassName = buildExportsClassName(compileId);
  const packageName = buildPackageName(compileId);
  const entryClasses = [];
  const sourceParts = [
    `package ${packageName};`,
    '',
    'import tracecode.user.TraceHooks;',
    javaDefaultImportsBlock(),
    '',
    normalizePublicClassDeclarations(payload.code).trim(),
    '',
  ];

  for (let index = 0; index < inputBatch.length; index += 1) {
    const className = index === 0 ? exportsClassName : `${exportsClassName}Case${index}`;
    const dynamicInputs = dynamicInputBatch[index] ?? [];
    const exportsSource = buildExportsSource(
      payload.code,
      payload.functionName,
      payload.executionStyle,
      inputBatch[index] ?? {},
      {
        dynamicInputs,
        hasDynamicInputs: dynamicInputs.length > 0,
        scriptMode: payload.scriptMode === true,
        skipNodePrelude: index > 0,
      }
    ).replaceAll(
      /\bpublic class Exports\b/g,
      `${index === 0 ? 'public class' : 'class'} ${className}`
    );
    entryClasses.push(`${packageName}.${className}`);
    sourceParts.push(exportsSource.trim(), '');
  }

  return {
    source: sourceParts.join('\n'),
    entryClasses,
  };
}

function buildCompileProbeSource(payload, requestId, probeClassName, probePackageName) {
  const exportsSource = buildExportsSource(
    payload.code,
    payload.functionName,
    payload.executionStyle,
    payload.inputs ?? {},
    {
      scriptMode: payload.scriptMode === true,
    }
  ).replaceAll(/\bpublic class Exports\b/g, `public class ${probeClassName}`);
  return [
    `package ${probePackageName};`,
    '',
    'import tracecode.user.TraceHooks;',
    javaDefaultImportsBlock(),
    '',
    normalizePublicClassDeclarations(payload.code).trim(),
    '',
    exportsSource.trim(),
    '',
  ].join('\n');
}

async function collectCompileProbeDiagnostics(payload, requestId, options) {
  const probeClassName = buildExportsClassName(`${requestId}RewriteProbe`);
  const probePackageName = buildPackageName(`${requestId}RewriteProbe`);
  const sourcePath = `/str/${probeClassName}.java`;
  const classesDir = `/files/java-worker/${requestId}/rewrite-probe/classes`;

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    return {
      consoleOutput: [],
      error: null,
      hostCallMs: 0,
      diagnosticError: formatWorkerErrorMessage(error),
    };
  }

  try {
    await self.cheerpOSAddStringFile(
      sourcePath,
      buildCompileProbeSource(payload, requestId, probeClassName, probePackageName)
    );
  } catch (error) {
    return {
      consoleOutput: [],
      error: null,
      hostCallMs: 0,
      diagnosticError: formatWorkerErrorMessage(error),
    };
  }

  const startedAt = performance.now();
  let reportText;
  try {
    reportText = await compileLibraryClass.compileAndTrace(
      sourcePath,
      classesDir,
      `${probePackageName}.${probeClassName}`,
      HELPER_JAR_PATH,
      DEFAULT_COMPILER_DEBUG_PROFILE,
      String(resolveMaxStoredEvents(options))
    );
  } catch (error) {
    return {
      consoleOutput: [],
      error: null,
      hostCallMs: performance.now() - startedAt,
      diagnosticError: formatWorkerErrorMessage(error),
    };
  }

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    return {
      consoleOutput: [],
      error: null,
      hostCallMs: performance.now() - startedAt,
      diagnosticError: `Invalid compile probe report: ${formatWorkerErrorMessage(error)}`,
    };
  }

  const consoleOutput = [report.compilerStdout, report.compilerStderr].filter(
    (entry) => typeof entry === 'string' && entry.trim().length > 0
  );
  const surfacedError =
    report.runtimeError ||
    report.compilerStderr ||
    report.compilerStdout ||
    null;

  return {
    consoleOutput,
    error: surfacedError,
    hostCallMs: performance.now() - startedAt,
    diagnosticError: null,
  };
}

function normalizeScriptTraceEvents(events, scriptMode, userCodeLineCount, sourceLineMap) {
  if (!scriptMode || !Array.isArray(events)) return events;
  return events.map((event) => {
    if (String(event).startsWith('trace:')) {
      try {
        const parsed = JSON.parse(String(event).slice('trace:'.length));
        if (parsed.function === SCRIPT_METHOD_NAME) parsed.function = '<module>';
        if (parsed.kind === 'call' && parsed.function === SCRIPT_METHOD_NAME) parsed.function = '<module>';
        if (parsed.kind === 'return' && parsed.function === SCRIPT_METHOD_NAME) parsed.function = '<module>';
        if (
          typeof parsed.line === 'number' &&
          sourceLineMap &&
          Object.prototype.hasOwnProperty.call(sourceLineMap, String(parsed.line))
        ) {
          const mappedLine = Number(sourceLineMap[String(parsed.line)]);
          if (Number.isFinite(mappedLine) && mappedLine > 0) parsed.line = mappedLine;
        }
        if (
          parsed.kind === 'return' &&
          parsed.function === '<module>' &&
          Number.isFinite(userCodeLineCount) &&
          userCodeLineCount > 0 &&
          parsed.line > userCodeLineCount
        ) {
          parsed.line = userCodeLineCount;
        }
        return `trace:${JSON.stringify(parsed)}`;
      } catch {
        return event;
      }
    }
    return event;
  });
}

function parseTraceLineNumber(event) {
  if (String(event).startsWith('trace:')) {
    try {
      const parsed = JSON.parse(String(event).slice('trace:'.length));
      const line = Number(parsed.line);
      return Number.isFinite(line) && line > 0 ? line : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isBareTraceLineEvent(event) {
  if (String(event).startsWith('trace:')) {
    try {
      const parsed = JSON.parse(String(event).slice('trace:'.length));
      return parsed.kind === 'line';
    } catch {
      return false;
    }
  }
  return false;
}

function buildBareTraceLineEvent(line, templateEvent) {
  if (String(templateEvent).startsWith('trace:')) {
    return `trace:${JSON.stringify({ kind: 'line', line })}`;
  }
  return `trace:${JSON.stringify({ kind: 'line', line })}`;
}

function cloneNativeSnapshotEventAtLine(event, line) {
  if (!String(event).startsWith('trace:')) return null;
  try {
    const parsed = JSON.parse(String(event).slice('trace:'.length));
    if (parsed.kind !== 'snapshot') return null;
    return `trace:${JSON.stringify({ ...parsed, line })}`;
  } catch {
    return null;
  }
}

function parseNativeSnapshotVariable(event) {
  if (!String(event).startsWith('trace:')) return null;
  try {
    const parsed = JSON.parse(String(event).slice('trace:'.length));
    if (parsed.kind !== 'snapshot') return null;
    const variable = parsed.target && typeof parsed.target.variable === 'string'
      ? parsed.target.variable
      : null;
    return variable;
  } catch {
    return null;
  }
}

function collectJavaLineDeclarationsForHeaderExpansion(line) {
  const names = [];
  const declarationPattern =
    /\b(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?==)/g;
  const skippedNames = new Set(['class', 'interface', 'enum', 'record', 'return', 'new']);
  for (const match of line.matchAll(declarationPattern)) {
    const typeSource = match[1] ?? '';
    const name = match[2];
    if (!name || skippedNames.has(name) || name.startsWith('__tracecode')) continue;
    if (typeSource.includes('[')) continue;
    names.push(name);
  }
  return names;
}

function collectJavaControlHeaderDeclarations(line) {
  const forMatch = /\bfor\s*\(\s*(?:final\s+)?(?:[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^;=(){}:]+>)?|\w+(?:\s*\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)/.exec(line);
  return forMatch?.[1] ? [forMatch[1]] : [];
}

function buildControlHeaderInfo(sourceText) {
  if (typeof sourceText !== 'string' || sourceText.length === 0) return null;
  const lines = sourceText.split(/\r?\n/);
  const loopBodyLineToHeader = new Map();
  const headerLineToExcludedVariables = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isLoopHeader = /\b(?:for|while)\s*\(/.test(line);
    const isControlHeader = /\b(?:for|while|if|else\s+if)\s*\(/.test(line);
    if (!isControlHeader || !line.includes('{')) continue;

    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const trimmed = lines[bodyIndex].trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('}')) break;
      const headerInfo = {
        line: index + 1,
        excludedVariables: new Set(collectJavaLineDeclarationsForHeaderExpansion(lines[bodyIndex])),
        headerVariables: new Set(collectJavaControlHeaderDeclarations(line)),
      };
      if (isLoopHeader) loopBodyLineToHeader.set(bodyIndex + 1, headerInfo);
      headerLineToExcludedVariables.set(index + 1, headerInfo.excludedVariables);
      break;
    }
  }

  if (loopBodyLineToHeader.size === 0 && headerLineToExcludedVariables.size === 0) return null;
  return { loopBodyLineToHeader, headerLineToExcludedVariables };
}

function expandLoopHeaderTraceEvents(events, sourceText) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const controlHeaderInfo = buildControlHeaderInfo(sourceText);
  if (!controlHeaderInfo) return events;
  const { loopBodyLineToHeader, headerLineToExcludedVariables } = controlHeaderInfo;

  const expanded = [];
  const latestSnapshotByVariable = new Map();
  let syntheticHeaderEventCount = 0;
  let sameLineHeaderSnapshotCache = null;
  const pushSyntheticHeaderEvent = (event) => {
    if (syntheticHeaderEventCount >= JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS) return false;
    expanded.push(event);
    syntheticHeaderEventCount += 1;
    return true;
  };
  const sameLineHeaderSnapshots = (startIndex, line, headerInfo) => {
    if (
      sameLineHeaderSnapshotCache &&
      sameLineHeaderSnapshotCache.line === line &&
      startIndex < sameLineHeaderSnapshotCache.end
    ) {
      return sameLineHeaderSnapshotCache.snapshots;
    }

    const snapshots = [];
    let end = startIndex + 1;
    for (; end < events.length; end += 1) {
      if (parseTraceLineNumber(events[end]) !== line) break;
      const variable = parseNativeSnapshotVariable(events[end]);
      if (!variable || !headerInfo.headerVariables.has(variable)) continue;
      snapshots.push(events[end]);
      if (snapshots.length >= JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS) break;
    }
    sameLineHeaderSnapshotCache = { line, end, snapshots };
    return snapshots;
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const line = parseTraceLineNumber(event);
    const snapshotVariable = parseNativeSnapshotVariable(event);
    if (
      line !== null &&
      snapshotVariable &&
      headerLineToExcludedVariables.get(line)?.has(snapshotVariable)
    ) {
      continue;
    }
    const headerInfo = line === null ? undefined : loopBodyLineToHeader.get(line);
    const headerLine = headerInfo?.line;
    const previousLine = expanded.length > 0 ? parseTraceLineNumber(expanded[expanded.length - 1]) : null;
    if (headerLine !== undefined && isBareTraceLineEvent(event) && previousLine !== headerLine) {
      pushSyntheticHeaderEvent(buildBareTraceLineEvent(headerLine, event));
      for (const [variable, snapshotEvent] of latestSnapshotByVariable) {
        if (syntheticHeaderEventCount >= JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS) break;
        if (headerInfo.excludedVariables.has(variable)) continue;
        const clonedSnapshot = cloneNativeSnapshotEventAtLine(snapshotEvent, headerLine);
        if (clonedSnapshot) pushSyntheticHeaderEvent(clonedSnapshot);
      }
    }
    if (
      headerLine !== undefined &&
      isBareTraceLineEvent(event) &&
      syntheticHeaderEventCount < JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS
    ) {
      for (const snapshotEvent of sameLineHeaderSnapshots(index, line, headerInfo)) {
        if (syntheticHeaderEventCount >= JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS) break;
        const clonedSnapshot = cloneNativeSnapshotEventAtLine(snapshotEvent, headerLine);
        if (clonedSnapshot) pushSyntheticHeaderEvent(clonedSnapshot);
      }
    }
    expanded.push(event);
    if (snapshotVariable) {
      if (latestSnapshotByVariable.has(snapshotVariable) || latestSnapshotByVariable.size < JAVA_MAX_LOOP_HEADER_SNAPSHOT_CACHE) {
        latestSnapshotByVariable.set(snapshotVariable, event);
      }
    }
  }
  return expanded;
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

function runtimeTraceSourceOwnership(lineNumber, functionName, statementSourceMap) {
  if (!(statementSourceMap instanceof Map) || typeof lineNumber !== 'number') return {};
  const span = statementSourceMap.get(Math.floor(lineNumber));
  if (!span) return {};
  const normalizedFunction = typeof functionName === 'string' && functionName.length > 0 ? functionName : undefined;
  return {
    statementId: normalizedFunction ? `${normalizedFunction}:${span.statementId}` : span.statementId,
    sourceSpan: {
      startLine: span.startLine,
      startColumn: span.startColumn,
      endLine: span.endLine,
      endColumn: span.endColumn,
    },
  };
}

function annotateJavaNativeTraceEventsWithSourceSpans(events, sourceText) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const statementSourceMap = buildRuntimeStatementSourceMap(sourceText);
  if (statementSourceMap.size === 0) return events;
  return events.map((event) => {
    if (!String(event).startsWith('trace:')) return event;
    try {
      const parsed = JSON.parse(String(event).slice('trace:'.length));
      return `trace:${JSON.stringify({
        ...parsed,
        ...runtimeTraceSourceOwnership(parsed.line, parsed.function, statementSourceMap),
      })}`;
    } catch {
      return event;
    }
  });
}

function normalizeJavaTraceEvents(events, normalizedPayload) {
  return annotateJavaNativeTraceEventsWithSourceSpans(
    expandLoopHeaderTraceEvents(
      normalizeScriptTraceEvents(
        Array.isArray(events) ? events : [],
        normalizedPayload.scriptMode,
        normalizedPayload.userCodeLineCount,
        normalizedPayload.sourceLineMap
      ),
      normalizedPayload.sourceText
    ),
    normalizedPayload.sourceText
  );
}

function normalizeJavaExecutionPayload(payload) {
  assertSupportedExecutionStyle(payload.executionStyle);
  if (typeof payload.code !== 'string') {
    throw new Error('`code` must be a string');
  }
  const scriptRequest = isScriptRequest(payload);
  if (!scriptRequest && (typeof payload.functionName !== 'string' || payload.functionName.trim().length === 0)) {
    throw new Error('Java execution requires a non-empty functionName or class entry name.');
  }

  try {
    return normalizeJavaRequest(payload);
  } catch (error) {
    throw makeWorkerStageError('request normalization', error);
  }
}

function javaReportConsoleOutput(report, options = {}) {
  if (report?.success === true && options.includeSuccessfulDiagnostics === false) {
    return [];
  }
  return [report.compilerStdout, report.compilerStderr].filter(
    (entry) => typeof entry === 'string' && entry.trim().length > 0
  );
}

function externalJavaCompilerEnabled(payload) {
  return payload?.externalCompilerEnabled === true;
}

function externalJavaCompilerAvailable(payload, compileLibraryClass, methodName) {
  return externalJavaCompilerEnabled(payload) && typeof compileLibraryClass?.[methodName] === 'function';
}

function normalizeExternalJavaCompileResult(value) {
  const result = value && typeof value === 'object' ? value : {};
  return {
    success: result.success === true,
    error: typeof result.error === 'string' ? result.error : '',
    stdout: typeof result.stdout === 'string'
      ? result.stdout
      : typeof result.compilerStdout === 'string'
        ? result.compilerStdout
        : '',
    stderr: typeof result.stderr === 'string'
      ? result.stderr
      : typeof result.compilerStderr === 'string'
        ? result.compilerStderr
        : '',
    compileMs: Number.isFinite(Number(result.compileMs))
      ? Math.max(0, Math.round(Number(result.compileMs)))
      : Number.isFinite(Number(result.compileTimeMs))
        ? Math.max(0, Math.round(Number(result.compileTimeMs)))
        : 0,
    compileCacheHit: result.compileCacheHit === true,
    classes: Array.isArray(result.classes)
      ? result.classes
      : Array.isArray(result.classFiles)
        ? result.classFiles
        : Array.isArray(result.files)
          ? result.files
          : [],
  };
}

function externalJavaClassManifest(result) {
  const lines = [];
  for (const entry of result.classes) {
    if (!entry || typeof entry !== 'object') continue;
    const path = typeof entry.path === 'string' ? entry.path : '';
    const contents = typeof entry.bytesBase64 === 'string'
      ? entry.bytesBase64
      : typeof entry.contents === 'string' && (entry.encoding === 'base64' || entry.encoding === undefined)
        ? entry.contents
        : '';
    if (!path || !contents) continue;
    lines.push(`${path}\t${contents}`);
  }
  if (lines.length === 0) {
    throw new Error('Java external compiler did not return any class files.');
  }
  return lines.join('\n');
}

function externalJavaCompileFailureReport(result, fallback = 'Java external compilation failed') {
  const message = result.error || result.stderr || result.stdout || fallback;
  return {
    success: false,
    compilerStdout: result.stdout,
    compilerStderr: result.stderr || message,
    compileTimeMs: result.compileMs,
    classLoadTimeMs: 0,
    runTimeMs: 0,
    compileCacheHit: result.compileCacheHit,
    runtimeError: null,
  };
}

async function compileJavaOutsideBrowser(payload, commandId) {
  const protocolToken = activeProtocolTokens.get(commandId);
  if (!protocolToken) {
    throw new Error('Java external compile requires an active command token.');
  }
  const requestId = `java-compile-${stableHash({ commandId, payload, nonce: javaWorkerRandomHex(1) })}`;
  const startedAt = performance.now();
  const result = await new Promise((resolve, reject) => {
    pendingExternalJavaCompiles.set(requestId, { resolve, reject, protocolToken });
    trustedJavaWorkerPostMessage({
      type: 'java-compile-request',
      requestId,
      protocolToken,
      payload,
    });
  });
  const normalized = normalizeExternalJavaCompileResult(result);
  if (!Number.isFinite(normalized.compileMs) || normalized.compileMs <= 0) {
    normalized.compileMs = Math.max(0, Math.round(performance.now() - startedAt));
  }
  return normalized;
}

async function requestCompilerArtifactCache(operation, key, commandId, value) {
  const protocolToken = activeProtocolTokens.get(commandId);
  if (!protocolToken) return { hit: false, stored: false };
  const requestId = `java-artifact-${stableHash({ operation, key, commandId, nonce: javaWorkerRandomHex(1) })}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCompilerArtifactCacheRequests.delete(requestId);
      resolve({ hit: false, stored: false });
    }, 250);
    pendingCompilerArtifactCacheRequests.set(requestId, { resolve, reject, protocolToken, timeout });
    trustedJavaWorkerPostMessage({
      type: 'compiler-artifact-cache-request',
      requestId,
      protocolToken,
      payload: { operation, key, ...(value === undefined ? {} : { value }) },
    });
  });
}

function truncateJavaWorkerDiagnostic(value, maxLength = 6000) {
  const text = typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : JSON.stringify(value, null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n... <truncated ${text.length - maxLength} chars>` : text;
}

function truncateJavaProjectDiagnostic(value) {
  return truncateJavaWorkerDiagnostic(value, JAVA_MAX_DIAGNOSTIC_CHARS);
}

function boundedJavaDiagnosticPath(value, fallback = '.') {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return fallback;
  return normalized.length > JAVA_MAX_DIAGNOSTIC_PATH_CHARS
    ? `${normalized.slice(0, JAVA_MAX_DIAGNOSTIC_PATH_CHARS)}...`
    : normalized;
}

function javaReportFailureMessage(report, fallback = 'Java execution failed') {
  const parts = [];
  const compilerStdout = typeof report?.compilerStdout === 'string'
    ? sanitizeJavaCompilerDiagnostic(report.compilerStdout).trim()
    : '';
  const compilerStderr = typeof report?.compilerStderr === 'string'
    ? sanitizeJavaCompilerDiagnostic(report.compilerStderr).trim()
    : '';
  const runtimeError = typeof report?.runtimeError === 'string'
    ? truncateJavaProjectDiagnostic(sanitizeJavaRuntimeStderr(report.runtimeError)).trim()
    : '';
  if (compilerStdout) parts.push(`compilerStdout:\n${truncateJavaWorkerDiagnostic(compilerStdout)}`);
  if (compilerStderr) parts.push(`compilerStderr:\n${truncateJavaWorkerDiagnostic(compilerStderr)}`);
  if (runtimeError && !compilerStdout.includes(runtimeError) && !compilerStderr.includes(runtimeError)) {
    parts.push(`runtimeError:\n${truncateJavaWorkerDiagnostic(runtimeError)}`);
  }
  if (Array.isArray(report?.results)) {
    const failedResults = report.results
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry?.success !== true);
    if (failedResults.length > 0) {
      parts.push(`failedResultIndices: ${failedResults.map(({ index }) => index).join(', ')}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : fallback;
}

function javaRuntimeExceptionDiagnostic(report) {
  const rawRuntimeError = typeof report?.runtimeError === 'string'
    ? report.runtimeError
    : '';
  const sanitizedStack = truncateJavaProjectDiagnostic(
    sanitizeJavaRuntimeStderr(rawRuntimeError)
  ).trim();
  if (!sanitizedStack) return undefined;

  const lines = sanitizedStack
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = lines.find((line) => !line.startsWith('at '));
  if (!summary) return undefined;

  const normalizedSummary = summary.replace(
    /^Exception in thread "[^"]+"\s+/,
    ''
  );
  const separator = normalizedSummary.indexOf(':');
  const qualifiedName = (
    separator >= 0
      ? normalizedSummary.slice(0, separator)
      : normalizedSummary
  ).trim();
  if (!qualifiedName || /\s/.test(qualifiedName)) return undefined;

  const name = qualifiedName.split('.').pop() || qualifiedName;
  const message = separator >= 0
    ? normalizedSummary.slice(separator + 1).trim()
    : '';
  const frames = lines
    .filter((line) => line.startsWith('at '))
    .map((line) => line.slice(3).trim())
    .map((frame) => {
      const match = /^(.*?)(?:\(([^():]+)(?::(\d+))?\))?$/.exec(frame);
      if (!match) return undefined;
      const rawFunction = match[1];
      const userClassMatch = /(?:^|\.)harness\.user\.[^.]+\.(.+)$/.exec(rawFunction);
      const publicFunction = /^[A-Z][\w$]*(?:\.[\w$<>]+)+$/.test(rawFunction)
        ? rawFunction
        : undefined;
      if (!userClassMatch && !publicFunction) return undefined;
      const normalizedFunction = (
        userClassMatch?.[1] ?? publicFunction
      ).replace(/\$[^.]+/g, '');
      const file = match[2] && match[2] !== 'Unknown Source'
        ? match[2]
        : undefined;
      const line = match[3] ? Number(match[3]) : undefined;
      return {
        function: normalizedFunction,
        ...(file ? { file } : {}),
        ...(Number.isFinite(line) ? { line } : {}),
      };
    })
    .filter(Boolean);

  const publicStack = [
    [name, message].filter(Boolean).join(': '),
    ...frames.map((frame) => {
      const location = frame.file
        ? `${frame.file}${frame.line ? `:${frame.line}` : ''}`
        : '';
      return `at ${frame.function}${location ? ` (${location})` : ''}`;
    }),
  ].join('\n');

  return {
    schema: 'tracecode.runtime-exception.v1',
    language: 'java',
    name,
    ...(qualifiedName !== name ? { qualifiedName } : {}),
    ...(message ? { message } : {}),
    frames,
    stack: publicStack,
  };
}

function javaReportFailure(report, fallback = 'Java execution failed') {
  const diagnostic = javaRuntimeExceptionDiagnostic(report);
  return {
    error: diagnostic?.stack || javaReportFailureMessage(report, fallback),
    ...(diagnostic
      ? { diagnosticStage: 'runtime', diagnostic }
      : {}),
  };
}

function javaNormalizeProjectCompilerOutput(output, sourceRoot, projectRoot = '') {
  const root = String(sourceRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return truncateJavaProjectDiagnostic(output);
  const diagnostic = truncateJavaProjectDiagnostic(output);
  const replacementRoot = boundedJavaDiagnosticPath(projectRoot, '.');
  const escapedRoot = escapeRegExp(root);
  return truncateJavaProjectDiagnostic(diagnostic
    .replace(new RegExp(`${escapedRoot}/`, 'g'), () => `${replacementRoot}/`)
    .replace(new RegExp(escapedRoot, 'g'), () => replacementRoot));
}

function javaProjectFailureStderr(report, sourceRoot, projectRoot) {
  const compilerOutput = javaNormalizeProjectCompilerOutput(
    javaReportConsoleOutput(report).join('\n').trim(),
    sourceRoot,
    projectRoot
  );
  const runtimeError = typeof report?.runtimeError === 'string' ? sanitizeJavaRuntimeStderr(report.runtimeError).trim() : '';
  if (compilerOutput.length > 0) {
    if (!runtimeError || runtimeError === 'Java compilation failed' || compilerOutput.includes(runtimeError)) {
      return compilerOutput;
    }
    return truncateJavaProjectDiagnostic(`${compilerOutput}\n${runtimeError}`);
  }
  return truncateJavaProjectDiagnostic(runtimeError || 'Java execution failed');
}

function parseJavaReportOutput(output) {
  return output ? normalizeJavaSerializedOutput(JSON.parse(output)) : undefined;
}

function normalizeProjectFilePath(path) {
  const normalized = String(path ?? '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project file path must be relative: ${path}`);
  }

  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error(`Project file path must not escape the workspace: ${path}`);
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new Error(`Project file path must point to a file: ${path}`);
  }
  return parts.join('/');
}

function normalizeProjectPathWithinWorkspace(path, allowEmpty = false) {
  const normalized = String(path ?? '').replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project path must be relative: ${path}`);
  }

  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error(`Project path must not escape the workspace: ${path}`);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    if (allowEmpty) return '';
    throw new Error(`Project path must point to a file: ${path}`);
  }
  return parts.join('/');
}

function normalizeProjectDirectoryPath(path) {
  return normalizeProjectPathWithinWorkspace(path, true);
}

function normalizeProjectRoot(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw || !raw.startsWith('/')) return '';
  return raw || '/';
}

function projectVirtualRoot(project) {
  return normalizeProjectRoot(project?.workspaceRoot || project?.cwd || '/workspace') || '/workspace';
}

function projectVirtualRoots(project, fallbackProjectCwd = '/workspace') {
  const roots = [];
  for (const value of [project?.workspaceRoot, project?.cwd, fallbackProjectCwd, project?.workspaceAlias, '/workspace']) {
    const root = normalizeProjectRoot(value);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function stripProjectVirtualPrefix(value, project, fallbackProjectCwd = '/workspace') {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  for (const root of projectVirtualRoots(project, fallbackProjectCwd)) {
    if (normalized === root) return '';
    if (root !== '/' && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  return null;
}

function projectRelativeCwd(payload) {
  const projectCwd = projectVirtualRoot(payload?.project);
  const requestCwd = String(payload?.cwd || projectCwd).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const stripped = stripProjectVirtualPrefix(requestCwd, payload?.project, projectCwd);
  if (stripped !== null) {
    return normalizeProjectDirectoryPath(stripped);
  }
  throw new Error(`Project cwd must stay inside the workspace: ${requestCwd}`);
}

function resolveProjectCommandPath(path, relativeCwd, projectCwd = '/workspace', allowEmpty = false, project) {
  const raw = String(path ?? '').replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    const stripped = stripProjectVirtualPrefix(raw, project, projectCwd);
    if (stripped !== null) {
      const resolved = normalizeProjectPathWithinWorkspace(stripped, allowEmpty);
      return resolved || (allowEmpty ? '' : '.');
    }
    throw new Error(`Project path must stay within the workspace: ${path}`);
  }
  const joined = relativeCwd ? `${relativeCwd}/${raw}` : raw;
  const resolved = normalizeProjectPathWithinWorkspace(joined, allowEmpty);
  return resolved || (allowEmpty ? '' : '.');
}

function javaStringLiteral(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function base64Utf8(value) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64');
  }

  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function projectJavaFiles(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  return files
    .map((file) => ({
      path: normalizeProjectFilePath(file?.path),
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    }))
    .filter((file) => file.path.endsWith('.java'))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function projectJavaClasspathFiles(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  return files
    .map((file) => ({
      path: normalizeProjectFilePath(file?.path),
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    }))
    .filter((file) => file.path.endsWith('.class') || file.path.endsWith('.jar'))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function projectJavaWorkspaceFiles(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  return files
    .map((file) => ({
      path: normalizeProjectFilePath(file?.path),
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeKernelAbsolutePath(path) {
  const raw = String(path ?? '').replace(/\\/g, '/');
  if (!raw.startsWith('/')) return null;
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`.replace(/\/+$/, '') || '/';
}

function normalizeKernelManifestDevicePath(path) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.normalizeRuntimeKernelManifestDevicePath === 'function') {
    return policy.normalizeRuntimeKernelManifestDevicePath(path) || null;
  }
  const normalized = normalizeKernelAbsolutePath(path);
  return normalized !== null && normalized !== '/dev' && normalized.startsWith('/dev/') ? normalized : null;
}

function normalizeKernelDeviceReference(path) {
  return normalizeKernelManifestDevicePath(path);
}

function kernelDeviceOutputTarget(path, request) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelDeviceOutputTarget === 'function') {
    return policy.runtimeKernelDeviceOutputTarget(Array.isArray(request?.project?.kernelDevices) ? request.project.kernelDevices : [], path) || null;
  }
  const normalized = normalizeKernelDeviceReference(path);
  const devices = Array.isArray(request?.project?.kernelDevices) ? request.project.kernelDevices : [];
  for (const device of devices) {
    if (normalizeKernelDeviceReference(device?.path) !== normalized || device?.writable !== true) continue;
    return normalizeKernelDeviceReference(device?.outputDevice) || normalized;
  }
  return null;
}

function kernelDeviceInputSource(path, request) {
  const policy = self.TraceRuntimeKernelPolicy;
  if (typeof policy?.runtimeKernelDeviceInputSource === 'function') {
    return policy.runtimeKernelDeviceInputSource(Array.isArray(request?.project?.kernelDevices) ? request.project.kernelDevices : [], path) || null;
  }
  const normalized = normalizeKernelDeviceReference(path);
  const devices = Array.isArray(request?.project?.kernelDevices) ? request.project.kernelDevices : [];
  for (const device of devices) {
    if (normalizeKernelDeviceReference(device?.path) !== normalized || device?.readable !== true) continue;
    return normalizeKernelDeviceReference(device?.inputDevice) || normalized;
  }
  return null;
}

function normalizeKernelVirtualFilePath(path) {
  const policy = self.TraceRuntimeKernelPolicy;
  const normalized = typeof policy?.normalizeRuntimeKernelPath === 'function'
    ? policy.normalizeRuntimeKernelPath(path)
    : normalizeKernelAbsolutePath(path);
  const isDeviceNamespace = typeof policy?.isRuntimeKernelDeviceNamespacePath === 'function'
    ? policy.isRuntimeKernelDeviceNamespacePath(normalized)
    : normalized === '/dev' || normalized?.startsWith('/dev/') === true;
  if (normalized !== null && normalized.startsWith('/') && !isDeviceNamespace) return normalized;
  throw new Error(`Unsupported Java kernel virtual file path: ${path}`);
}

function projectJavaKernelFiles(project) {
  const files = Array.isArray(project?.kernelFiles) ? project.kernelFiles : [];
  return files
    .map((file) => ({
      path: normalizeKernelVirtualFilePath(file?.path),
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function projectJavaWorkspaceDirectories(project) {
  const directories = Array.isArray(project?.directories) ? project.directories : [];
  return Array.from(new Set(
    directories
      .map((directory) => normalizeProjectDirectoryPath(directory))
      .filter(Boolean)
  )).sort((left, right) => left.localeCompare(right));
}

function projectFileMap(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  const map = new Map();
  for (const file of files) {
    map.set(normalizeProjectFilePath(file?.path), {
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    });
  }
  return map;
}

function projectFileManifestEntry(file) {
  const contents = file.encoding === 'base64' ? file.contents : base64Utf8(file.contents);
  return `${file.path}\t${contents}`;
}

function projectDirectoryManifestEntry(directory) {
  return `\tdir\t${directory}`;
}

function projectWorkspaceManifest(project) {
  return [
    ...projectJavaWorkspaceDirectories(project).map(projectDirectoryManifestEntry),
    ...projectJavaWorkspaceFiles(project).map(projectFileManifestEntry),
    ...projectJavaKernelFiles(project).map(projectFileManifestEntry),
  ].join('\n');
}

function projectWorkspaceCwd(payload, workspaceRoot) {
  const relativeCwd = projectRelativeCwd(payload);
  return relativeCwd ? `${workspaceRoot}/${relativeCwd}` : workspaceRoot;
}

function assertProjectJavaSource(file) {
  if (file.encoding !== 'utf8') {
    throw new Error(`Browser Java project runner only supports utf8 Java source files: ${file.path}`);
  }
}

function assertProjectJavaClasspathFile(file) {
  if (file.encoding !== 'base64') {
    throw new Error(`Browser Java project runner only supports base64 Java classpath files: ${file.path}`);
  }
}

function assertProjectMainClass(value) {
  const mainClass = String(value ?? '').trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(mainClass)) {
    throw new Error(`Browser Java project runner requires a Java class name: ${value}`);
  }
  return mainClass;
}

function projectJarMainClass(payload) {
  const mainClass = payload?.options?.jarMainClass;
  if (typeof mainClass === 'string' && mainClass.trim().length > 0) {
    return assertProjectMainClass(mainClass);
  }
  throw new Error('Browser Java -jar execution requires a manifest Main-Class.');
}

function javaProjectBasename(path) {
  return path.split('/').at(-1);
}

function javaProjectSourcePath(file) {
  return file.path;
}

function augmentJavaProjectFileMutations(source) {
  return String(source ?? '')
    .replace(/\bjava\.nio\.file\.Files\.createTempFile\s*\(/g, 'tracecode.browser.ProjectEvents.createTempPath(')
    .replace(/(?<![\w.])Files\.createTempFile\s*\(/g, 'tracecode.browser.ProjectEvents.createTempPath(')
    .replace(/\bjava\.nio\.file\.Files\.(readString|readAllBytes|readAllLines|lines|list|newDirectoryStream|newInputStream|newBufferedReader|exists|notExists|isDirectory|isRegularFile|isReadable|isWritable|size|writeString|write|createFile|createDirectory|createDirectories|createTempDirectory|setLastModifiedTime|setAttribute|newOutputStream|newBufferedWriter|newByteChannel|deleteIfExists|delete|copy|move)\s*\(/g, 'tracecode.browser.ProjectEvents.$1(')
    .replace(/(?<![\w.])Files\.(readString|readAllBytes|readAllLines|lines|list|newDirectoryStream|newInputStream|newBufferedReader|exists|notExists|isDirectory|isRegularFile|isReadable|isWritable|size|writeString|write|createFile|createDirectory|createDirectories|createTempDirectory|setLastModifiedTime|setAttribute|newOutputStream|newBufferedWriter|newByteChannel|deleteIfExists|delete|copy|move)\s*\(/g, 'tracecode.browser.ProjectEvents.$1(')
    .replace(/\bjava\.io\.File\.createTempFile\s*\(/g, 'tracecode.browser.ProjectEvents.createTempFile(')
    .replace(/(?<![\w.])File\.createTempFile\s*\(/g, 'tracecode.browser.ProjectEvents.createTempFile(')
    .replace(/\bjava\.lang\.System\.getenv\s*\(/g, 'tracecode.browser.ProjectEvents.getenv(')
    .replace(/\bSystem\.getenv\s*\(/g, 'tracecode.browser.ProjectEvents.getenv(')
    .replace(/\bjava\.lang\.System\.in\b/g, 'tracecode.browser.ProjectEvents.inputStream()')
    .replace(/\bSystem\.in\b/g, 'tracecode.browser.ProjectEvents.inputStream()')
    .replace(/\bjava\.net\.http\.HttpClient\.newHttpClient\s*\(/g, 'tracecode.browser.ProjectEvents.httpClient(')
    .replace(/(?<![\w.])HttpClient\.newHttpClient\s*\(/g, 'tracecode.browser.ProjectEvents.httpClient(')
    .replace(/\bjava\.net\.http\.HttpClient\.newBuilder\s*\(/g, 'tracecode.browser.ProjectEvents.httpClientBuilder(')
    .replace(/(?<![\w.])HttpClient\.newBuilder\s*\(/g, 'tracecode.browser.ProjectEvents.httpClientBuilder(')
    .replace(/\bcom\.sun\.net\.httpserver\.HttpServer\.create\s*\(/g, 'tracecode.browser.ProjectEvents.httpServer(')
    .replace(/(?<![\w.])HttpServer\.create\s*\(/g, 'tracecode.browser.ProjectEvents.httpServer(')
    .replace(/\bnew\s+java\.io\.FileWriter\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileWriter(')
    .replace(/(?<![\w.])new\s+FileWriter\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileWriter(')
    .replace(/\bnew\s+java\.io\.FileInputStream\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileInputStream(')
    .replace(/(?<![\w.])new\s+FileInputStream\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileInputStream(')
    .replace(/\bnew\s+java\.io\.FileReader\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileReader(')
    .replace(/(?<![\w.])new\s+FileReader\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileReader(')
    .replace(/\bnew\s+java\.io\.FileOutputStream\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileOutputStream(')
    .replace(/(?<![\w.])new\s+FileOutputStream\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileOutputStream(')
    .replace(/\bnew\s+java\.io\.File\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFile(')
    .replace(/(?<![\w.])new\s+File\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFile(')
    .replace(/\bnew\s+java\.io\.RandomAccessFile\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectRandomAccessFile(')
    .replace(/(?<![\w.])new\s+RandomAccessFile\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectRandomAccessFile(')
    .replace(/\bnew\s+java\.io\.PrintStream\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectPrintStream(')
    .replace(/(?<![\w.])new\s+PrintStream\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectPrintStream(')
    .replace(/\bnew\s+java\.io\.PrintWriter\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectPrintWriter(')
    .replace(/(?<![\w.])new\s+PrintWriter\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectPrintWriter(');
}

function javaProjectSystemProperties(payload) {
  const project = payload?.project;
  const kernel = project?.kernel && typeof project.kernel === 'object' ? project.kernel : undefined;
  const username = typeof kernel?.user?.username === 'string' && kernel.user.username.length > 0
    ? kernel.user.username
    : 'user';
  const home = typeof kernel?.home === 'string' && kernel.home.length > 0
    ? kernel.home
    : typeof kernel?.user?.home === 'string' && kernel.user.home.length > 0
      ? kernel.user.home
      : `/home/${username}`;
  const virtualRoot = projectVirtualRoot(project);
  const relativeCwd = projectRelativeCwd(payload);
  const virtualCwd = relativeCwd ? `${virtualRoot}/${relativeCwd}` : virtualRoot;
  const defaults = [
    ['user.dir', virtualCwd],
    ['user.home', home],
    ['user.name', username],
    ['os.name', typeof kernel?.name === 'string' && kernel.name.length > 0 ? kernel.name : 'tracekernel'],
    ['os.version', typeof kernel?.version === 'string' && kernel.version.length > 0 ? kernel.version : '1.0'],
  ];
  const properties = payload?.options?.systemProperties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return defaults;
  }
  const explicit = Object.entries(properties)
    .filter(([key]) => typeof key === 'string' && key.length > 0 && !key.includes('=') && !key.includes('\0'))
    .map(([key, value]) => [key, String(value ?? '')]);
  const merged = new Map(defaults);
  for (const [key, value] of explicit) {
    merged.set(key, value);
  }
  return Array.from(merged.entries());
}

function javaProjectEnvClasspath(payload) {
  return typeof payload?.env?.CLASSPATH === 'string' && payload.env.CLASSPATH.trim().length > 0
    ? payload.env.CLASSPATH
    : null;
}

function javaProjectEffectiveClasspath(payload) {
  return typeof payload?.options?.classpath === 'string'
    ? payload.options.classpath
    : javaProjectEnvClasspath(payload);
}

function projectKernelDeviceManifest(project) {
  const devices = Array.isArray(project?.kernelDevices) ? project.kernelDevices : [];
  return devices
    .map((device) => {
      const path = normalizeKernelDeviceReference(device?.path);
      if (path === null) return null;
      const readable = device?.readable === true ? '1' : '0';
      const writable = device?.writable === true ? '1' : '0';
      const inputDevice = typeof device?.inputDevice === 'string' ? normalizeKernelDeviceReference(device.inputDevice) ?? '' : '';
      const outputDevice = typeof device?.outputDevice === 'string' ? normalizeKernelDeviceReference(device.outputDevice) ?? '' : '';
      return [path, readable, writable, inputDevice, outputDevice].map((part) => base64Utf8(part)).join('\t');
    })
    .filter(Boolean)
    .sort()
    .join('\n');
}

function projectKernelFileManifest(project) {
  return projectJavaKernelFiles(project)
    .map((file) => {
      const contents = file.encoding === 'base64' ? file.contents : base64Utf8(file.contents);
      return `${base64Utf8(file.path)}\t${contents}`;
    })
    .join('\n');
}

function projectEnvironmentManifest(payload) {
  const env = payload?.env && typeof payload.env === 'object' ? payload.env : {};
  return Object.entries(env)
    .filter(([key]) => typeof key === 'string' && key.length > 0 && !key.includes('=') && !key.includes('\0'))
    .map(([key, value]) => [base64Utf8(key), base64Utf8(String(value ?? ''))].join('\t'))
    .join('\n');
}

function buildProjectJavaAdapterSource(exportsClassName, mainClassName, args, compileOnly, systemProperties = [], kernelDeviceManifest = '', kernelFileManifest = '', envManifest = '', virtualWorkspaceRoot = '/workspace', workspaceAlias = '/workspace', internalWorkspaceRoot = '', reflectiveMain = false, bridgeRunId = '') {
  const argsSource = args.map((arg) => javaStringLiteral(arg)).join(', ');
  const mainClassSource = javaStringLiteral(mainClassName);
  const kernelDeviceManifestSource = javaStringLiteral(kernelDeviceManifest);
  const kernelFileManifestSource = javaStringLiteral(kernelFileManifest);
  const envManifestSource = javaStringLiteral(envManifest);
  const virtualWorkspaceRootSource = javaStringLiteral(virtualWorkspaceRoot);
  const workspaceAliasSource = javaStringLiteral(workspaceAlias);
  const internalWorkspaceRootSource = javaStringLiteral(internalWorkspaceRoot);
  const bridgeRunIdSource = javaStringLiteral(bridgeRunId);
  const propertyKeysSource = systemProperties.map(([key]) => javaStringLiteral(key)).join(', ');
  const propertyValuesSource = systemProperties.map(([, value]) => javaStringLiteral(value)).join(', ');
  const invocation = compileOnly
    ? ''
    : reflectiveMain
      ? `      try {
        Class<?> __tracecodeMainClass = Class.forName(${mainClassSource});
        java.lang.reflect.Method __tracecodeMain = __tracecodeMainClass.getMethod("main", String[].class);
        __tracecodeMain.invoke(null, (Object) new String[] { ${argsSource} });
      } catch (java.lang.reflect.InvocationTargetException error) {
        Throwable cause = error.getCause();
        if (cause instanceof RuntimeException) throw (RuntimeException) cause;
        if (cause instanceof Error) throw (Error) cause;
        throw new RuntimeException(cause);
      }`
      : `      ${mainClassName}.main(new String[] { ${argsSource} });`;

  return `
import tracecode.user.TraceHooks;
import tracecode.browser.ProjectEvents;
import java.io.*;

public class ${exportsClassName} {
  private static String __tracecodeJsonString(String value) {
    if (value == null) return "null";
    StringBuilder out = new StringBuilder();
    out.append('"');
    for (int index = 0; index < value.length(); index += 1) {
      char ch = value.charAt(index);
      switch (ch) {
        case '"': out.append("\\\\\\""); break;
        case '\\\\': out.append("\\\\\\\\"); break;
        case '\\b': out.append("\\\\b"); break;
        case '\\f': out.append("\\\\f"); break;
        case '\\n': out.append("\\\\n"); break;
        case '\\r': out.append("\\\\r"); break;
        case '\\t': out.append("\\\\t"); break;
        default:
          if (ch < 0x20) {
            String hex = Integer.toHexString(ch);
            out.append("\\\\u");
            for (int pad = hex.length(); pad < 4; pad += 1) out.append('0');
            out.append(hex);
          } else {
            out.append(ch);
          }
      }
    }
    out.append('"');
    return out.toString();
  }

  private static String __tracecodeProjectResult(String stdout, String stderr, int exitCode) {
    return "{\\"stdout\\":" + __tracecodeJsonString(stdout)
      + ",\\"stderr\\":" + __tracecodeJsonString(stderr)
      + ",\\"exitCode\\":" + exitCode + "}";
  }

  public static String run() {
    java.io.PrintStream previousOut = System.out;
    java.io.PrintStream previousErr = System.err;
    java.io.InputStream previousIn = System.in;
    java.nio.file.Path tracecodeWorkspaceRoot = java.nio.file.Paths.get(${internalWorkspaceRootSource}).toAbsolutePath().normalize();
    String[] propertyKeys = new String[] { ${propertyKeysSource} };
    String[] propertyValues = new String[] { ${propertyValuesSource} };
    java.util.Properties previousProperties = new java.util.Properties();
    java.io.ByteArrayOutputStream stdoutBytes = new java.io.ByteArrayOutputStream();
    java.io.ByteArrayOutputStream stderrBytes = new java.io.ByteArrayOutputStream();
    int tracecodeProjectRunToken = 0;
    int exitCode = 0;
    try {
      for (String key : propertyKeys) {
        String previousValue = System.getProperty(key);
        if (previousValue != null) previousProperties.setProperty(key, previousValue);
      }
      for (int index = 0; index < propertyKeys.length; index += 1) {
        System.setProperty(propertyKeys[index], propertyValues[index]);
      }
      tracecodeProjectRunToken = ProjectEvents.beginProjectRun(${bridgeRunIdSource});
      ProjectEvents.setProjectWorkspaceRoot(tracecodeWorkspaceRoot);
      ProjectEvents.setProjectVirtualWorkspaceRoot(${virtualWorkspaceRootSource}, ${workspaceAliasSource});
      ProjectEvents.setKernelDevices(${kernelDeviceManifestSource});
      ProjectEvents.setKernelFiles(${kernelFileManifestSource});
      ProjectEvents.setEnvironment(${envManifestSource});
      ProjectEvents.installHttpUrlHandler();
      System.setOut(new java.io.PrintStream(ProjectEvents.streamingOutput(stdoutBytes, "stdout"), true, "UTF-8"));
      System.setErr(new java.io.PrintStream(ProjectEvents.streamingOutput(stderrBytes, "stderr"), true, "UTF-8"));
      System.setIn(ProjectEvents.inputStream());
${invocation}
    } catch (Throwable error) {
      exitCode = 1;
      error.printStackTrace();
    } finally {
      System.out.flush();
      System.err.flush();
      System.setOut(previousOut);
      System.setErr(previousErr);
      System.setIn(previousIn);
      ProjectEvents.setProjectWorkspaceRoot(null);
      ProjectEvents.clearKernelDevices();
      ProjectEvents.endProjectRun(tracecodeProjectRunToken);
      for (String key : propertyKeys) {
        if (previousProperties.containsKey(key)) {
          System.setProperty(key, previousProperties.getProperty(key));
        } else {
          System.clearProperty(key);
        }
      }
    }
    try {
      return TraceHooks.serializeOutputResult(__tracecodeProjectResult(
        stdoutBytes.toString("UTF-8"),
        stderrBytes.toString("UTF-8"),
        exitCode
      ));
    } catch (java.io.UnsupportedEncodingException error) {
      return TraceHooks.serializeOutputResult(__tracecodeProjectResult("", error.toString(), 1));
    }
  }
}
`;
}

function buildProjectJavaRunnableSource(payload, compileId, bridgeRunId = '') {
  const files = projectJavaFiles(payload.project);
  if (files.length === 0) {
    throw new Error('Java project execution requires at least one .java file.');
  }

  files.forEach(assertProjectJavaSource);
  const classpathFiles = projectJavaClasspathFiles(payload.project);
  classpathFiles.forEach(assertProjectJavaClasspathFile);
  const exportsClassName = buildExportsClassName(compileId);
  const compileOnly = payload.source === 'compile';
  const relativeCwd = projectRelativeCwd(payload);
  const projectCwd = projectVirtualRoot(payload?.project);
  const workspaceAlias = typeof payload?.project?.workspaceAlias === 'string' && payload.project.workspaceAlias.length > 0
    ? payload.project.workspaceAlias
    : '/workspace';
  const workspaceRoot = `/files/java-worker/${compileId}/workspace`;
  if (compileOnly) {
    assertBrowserProjectJavacOptionsSupported(payload.args, payload.project, relativeCwd, projectCwd);
  }
  const mainClassName = compileOnly ? javaProjectBasename(files[0].path).replace(/\.java$/, '') : assertProjectMainClass(payload.scriptPath);
  const projectFiles = files.map((file) => ({
    path: javaProjectSourcePath(file),
    source: augmentJavaProjectFileMutations(file.contents),
  }));
  const adapter = compileOnly
    ? null
    : {
        path: `${exportsClassName}.java`,
        source: buildProjectJavaAdapterSource(
          exportsClassName,
          mainClassName,
          Array.isArray(payload.args) ? payload.args : [],
          false,
          javaProjectSystemProperties(payload),
          projectKernelDeviceManifest(payload.project),
          projectKernelFileManifest(payload.project),
          projectEnvironmentManifest(payload),
          projectCwd,
          workspaceAlias,
          workspaceRoot,
          false,
          bridgeRunId
        ).trim(),
      };

  const classpathRoot = `/files/java-worker/${compileId}/classpath`;
  const sourceEntries = adapter === null ? projectFiles : [...projectFiles, adapter];
  return {
    classpathManifest: classpathFiles
      .map((file) => `${file.path}\t${file.contents}`)
      .join('\n'),
    classpathRoot,
    compileClasspath: javaProjectClasspath(
      javaCompileClasspath(payload.args, payload.project, relativeCwd, projectCwd) ?? javaProjectEnvClasspath(payload),
      classpathRoot,
      HELPER_JAR_PATH,
      relativeCwd,
      projectCwd,
      payload.project
    ),
    compileSourcePaths: javaCompileEffectiveSourcePaths(payload.args, payload.project, relativeCwd, projectCwd).join('\n'),
    compileSourceRootPaths: javaCompileEffectiveSourceRootPaths(payload.args, payload.project, relativeCwd, projectCwd).join('\n'),
    workspaceManifest: projectWorkspaceManifest(payload.project),
    workspaceRoot,
    workspaceCwd: projectWorkspaceCwd(payload, workspaceRoot),
    sourceManifest: sourceEntries
      .map((file) => `${file.path}\t${base64Utf8(file.source)}`)
      .join('\n'),
    sourceRoot: `/files/java-worker/${compileId}/sources`,
    classesDir: `/files/java-worker/${compileId}/classes`,
    mainClassName: exportsClassName,
  };
}

function buildProjectJavaClassRunnableSource(payload, compileId, bridgeRunId = '') {
  const classpathFiles = projectJavaClasspathFiles(payload.project);
  if (classpathFiles.length === 0) {
    throw new Error('Java classpath execution requires persisted .class or .jar files.');
  }

  classpathFiles.forEach(assertProjectJavaClasspathFile);
  const exportsClassName = buildExportsClassName(compileId);
  const mainClassName = typeof payload?.options?.jarPath === 'string'
    ? projectJarMainClass(payload)
    : assertProjectMainClass(payload.scriptPath);
  const relativeCwd = projectRelativeCwd(payload);
  const projectCwd = projectVirtualRoot(payload?.project);
  const workspaceAlias = typeof payload?.project?.workspaceAlias === 'string' && payload.project.workspaceAlias.length > 0
    ? payload.project.workspaceAlias
    : '/workspace';
  const classRoot = `/files/java-worker/${compileId}/classpath`;
  const workspaceRoot = `/files/java-worker/${compileId}/workspace`;
  const adapter = {
    path: `${exportsClassName}.java`,
    source: buildProjectJavaAdapterSource(
      exportsClassName,
      mainClassName,
      Array.isArray(payload.args) ? payload.args : [],
      false,
      javaProjectSystemProperties(payload),
      projectKernelDeviceManifest(payload.project),
      projectKernelFileManifest(payload.project),
      projectEnvironmentManifest(payload),
      projectCwd,
      workspaceAlias,
      workspaceRoot,
      true,
      bridgeRunId
    ).trim(),
  };

  return {
    classManifest: classpathFiles
      .map((file) => `${file.path}\t${file.contents}`)
      .join('\n'),
    sourceManifest: `${adapter.path}\t${base64Utf8(adapter.source)}`,
    sourceRoot: `/files/java-worker/${compileId}/sources`,
    classesDir: `/files/java-worker/${compileId}/classes`,
    classRoot,
    workspaceManifest: projectWorkspaceManifest(payload.project),
    workspaceRoot,
    workspaceCwd: projectWorkspaceCwd(payload, workspaceRoot),
    runtimeClasspath: javaProjectClasspath(javaProjectEffectiveClasspath(payload), classRoot, HELPER_JAR_PATH, relativeCwd, projectCwd, payload.project),
    mainClassName: exportsClassName,
  };
}

function javaExpandedCompilerArgs(args, project, relativeCwd = '', projectCwd = '/workspace') {
  if (!Array.isArray(args)) return [];
  const files = projectFileMap(project);
  const expand = (items, seen) => {
    const out = [];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      if (!item.startsWith('@') || item === '@') {
        out.push(item);
        continue;
      }

      const argPath = resolveProjectCommandPath(item.slice(1), relativeCwd, projectCwd, false, project);
      if (seen.has(argPath)) {
        throw new Error(`Recursive Java argfile reference: ${argPath}`);
      }
      const file = files.get(argPath);
      if (!file) {
        throw new Error(`Java argfile not found: ${argPath}`);
      }
      if (file.encoding !== 'utf8') {
        throw new Error(`Java argfile must be utf8: ${argPath}`);
      }
      seen.add(argPath);
      out.push(...expand(parseJavaArgFile(file.contents), seen));
      seen.delete(argPath);
    }
    return out;
  };
  return expand(args, new Set());
}

function assertBrowserProjectJavacOptionsSupported(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  if (expandedArgs.includes('--enable-preview')) {
    throw new Error('javac: --enable-preview is not supported by this runtime');
  }
}

function parseJavaArgFile(contents) {
  const args = [];
  let current = '';
  let quote = null;
  let escaping = false;
  for (const ch of String(contents ?? '')) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current.length > 0) args.push(current);
  return args;
}

function javaCompileClasspath(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  let classpath = null;
  for (let index = 0; index < expandedArgs.length; index += 1) {
    const arg = expandedArgs[index];
    if (arg === '-cp' || arg === '-classpath' || arg === '--class-path') {
      classpath = typeof expandedArgs[index + 1] === 'string' ? expandedArgs[index + 1] : null;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--class-path=')) {
      classpath = arg.slice('--class-path='.length);
    }
  }
  return classpath;
}

const JAVAC_OPTIONS_WITH_OPERAND = new Set([
  '-bootclasspath',
  '-classpath',
  '-cp',
  '-d',
  '-encoding',
  '-endorseddirs',
  '-extdirs',
  '-h',
  '-module',
  '-modulepath',
  '-processor',
  '-processorpath',
  '-profile',
  '-s',
  '-source',
  '-sourcepath',
  '-target',
  '--add-exports',
  '--add-modules',
  '--add-reads',
  '--boot-class-path',
  '--class-path',
  '--default-module-for-created-files',
  '--limit-modules',
  '--module',
  '--module-path',
  '--module-source-path',
  '--processor',
  '--processor-module-path',
  '--processor-path',
  '--release',
  '--source',
  '--source-path',
  '--system',
  '--target',
  '--upgrade-module-path',
]);

function javacOptionConsumesNext(arg) {
  if (typeof arg !== 'string') return false;
  if (JAVAC_OPTIONS_WITH_OPERAND.has(arg)) return true;
  if (/^-A[^=].+/.test(arg)) return false;
  return false;
}

function javaCompileSourcePaths(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  const sources = [];
  for (let index = 0; index < expandedArgs.length; index += 1) {
    const arg = expandedArgs[index];
    if (javacOptionConsumesNext(arg)) {
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--') && arg.includes('=')) {
      continue;
    }
    if (typeof arg === 'string' && arg.endsWith('.java')) {
      sources.push(resolveProjectCommandPath(arg, relativeCwd, projectCwd, false, project));
    }
  }
  return sources;
}

function javaSourceClassName(path) {
  return String(path ?? '').split('/').pop()?.replace(/\.java$/i, '') || '';
}

function javaCompileEffectiveSourcePaths(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const selected = new Set(javaCompileSourcePaths(args, project, relativeCwd, projectCwd));
  const files = projectFileMap(project);
  const javaFiles = projectJavaFiles(project);
  let changed = true;
  while (changed) {
    changed = false;
    const selectedContents = [...selected]
      .map((path) => files.get(path)?.contents ?? '')
      .join('\n');
    for (const file of javaFiles) {
      if (selected.has(file.path)) continue;
      const className = javaSourceClassName(file.path);
      if (!className) continue;
      if (new RegExp(`\\b${escapeRegExp(className)}\\b`).test(selectedContents)) {
        selected.add(file.path);
        changed = true;
      }
    }
  }
  return [...selected];
}

function javaCompileSourceRootPaths(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  const roots = [];
  for (let index = 0; index < expandedArgs.length; index += 1) {
    const arg = expandedArgs[index];
    if (arg === '-sourcepath' || arg === '--source-path') {
      const sourcepath = expandedArgs[index + 1];
      if (typeof sourcepath === 'string') {
        roots.push(...sourcepath
          .split(':')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => resolveProjectCommandPath(entry, relativeCwd, projectCwd, true, project)));
      }
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--source-path=')) {
      roots.push(...arg.slice('--source-path='.length)
        .split(':')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => resolveProjectCommandPath(entry, relativeCwd, projectCwd, true, project)));
    }
  }
  return roots;
}

function projectPathDirname(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function javaPackageRootForSource(sourcePath, contents) {
  const parent = projectPathDirname(sourcePath);
  const packageMatch = String(contents ?? '').match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m);
  if (!packageMatch) return parent;
  const parentParts = parent ? parent.split('/') : [];
  const packageParts = packageMatch[1].split('.');
  if (parentParts.length < packageParts.length) return parent;
  const tail = parentParts.slice(parentParts.length - packageParts.length);
  if (tail.join('/') !== packageParts.join('/')) return parent;
  return parentParts.slice(0, parentParts.length - packageParts.length).join('/');
}

function javaCompileEffectiveSourceRootPaths(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const explicitRoots = javaCompileSourceRootPaths(args, project, relativeCwd, projectCwd);
  if (explicitRoots.length > 0) return explicitRoots;

  const files = projectFileMap(project);
  const roots = new Set(['']);
  if (relativeCwd) roots.add(relativeCwd);
  for (const sourcePath of javaCompileEffectiveSourcePaths(args, project, relativeCwd, projectCwd)) {
    const file = files.get(sourcePath);
    roots.add(projectPathDirname(sourcePath));
    if (file) roots.add(javaPackageRootForSource(sourcePath, file.contents));
  }
  return [...roots];
}

function javaProjectClasspath(rawClasspath, classRoot, extraEntry, relativeCwd = '', projectCwd = '/workspace', project) {
  const entries = [];
  if (typeof rawClasspath !== 'string' || rawClasspath.trim().length === 0) {
    entries.push(relativeCwd ? `${classRoot}/${relativeCwd}` : classRoot);
  } else {
    entries.push(...rawClasspath
      .split(':')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const resolved = resolveProjectCommandPath(entry, relativeCwd, projectCwd, true, project);
        return resolved ? `${classRoot}/${resolved}` : classRoot;
      }));
  }

  if (typeof extraEntry === 'string' && extraEntry.length > 0) {
    entries.push(extraEntry);
  }
  return entries.join(':');
}

function javaJavacVerboseRequested(args, project, relativeCwd = '', projectCwd = '/workspace') {
  return javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd)
    .some((arg) => arg === '-verbose' || arg === '--verbose');
}

function javaSyntheticJavacVerboseOutput(payload, outputDir) {
  const relativeCwd = projectRelativeCwd(payload);
  const projectCwd = projectVirtualRoot(payload?.project);
  const sourcePaths = javaCompileEffectiveSourcePaths(payload.args, payload.project, relativeCwd, projectCwd);
  const sourceRoots = javaCompileEffectiveSourceRootPaths(payload.args, payload.project, relativeCwd, projectCwd);
  const classpath = javaCompileClasspath(payload.args, payload.project, relativeCwd, projectCwd);
  const classOutputDir = normalizeJavaOutputDir(outputDir);
  const lines = [
    '[parsing started SimpleFileObject[/workspace]]',
  ];
  for (const sourcePath of sourcePaths) {
    lines.push(`[parsing started DirectoryFileObject[${sourcePath}]]`);
    lines.push('[parsing completed 1ms]');
  }
  lines.push(`[search path for source files: ${sourceRoots.length > 0 ? sourceRoots.join(',') : '.'}]`);
  lines.push(`[search path for class files: ${classpath || '.'}]`);
  for (const sourcePath of sourcePaths) {
    lines.push(`[checking ${javaSyntheticClassNameForSource(sourcePath)}]`);
  }
  for (const sourcePath of sourcePaths) {
    lines.push(`[wrote ${javaSyntheticClassOutputPath(sourcePath, classOutputDir, projectCwd)}]`);
  }
  return `${lines.join('\n')}\n`;
}

function javaSyntheticClassNameForSource(sourcePath) {
  const fileName = String(sourcePath).split('/').pop() || 'Main.java';
  return fileName.replace(/\.java$/i, '');
}

function javaSyntheticClassOutputPath(sourcePath, outputDir, projectCwd = '/workspace') {
  const withoutExtension = String(sourcePath).replace(/\.java$/i, '.class');
  const relativeOutput = outputDir === '.' ? withoutExtension : `${outputDir}/${withoutExtension}`;
  return `${projectCwd.replace(/\/+$/, '') || '/workspace'}/${relativeOutput}`;
}

function postProjectEvent(id, payload, options = {}) {
  if (!id) return;
  const context = options.context ?? (activeJavaProjectIo?.messageId === id ? activeJavaProjectIo : null);
  const budgetedPayload = applyJavaProjectEventBudget(context, payload);
  if (!budgetedPayload) return;
  if (context && budgetedPayload?.type === 'output' && typeof budgetedPayload.data === 'string') {
    const outputBuffer = budgetedPayload.stream === 'stderr' ? context.eventStderr : context.eventStdout;
    outputBuffer.push(budgetedPayload.data);
    if (budgetedPayload.stream === 'stderr') {
      context.stderrEmitted = true;
    } else {
      context.stdoutEmitted = true;
    }
  }
  postMessageResponse({ id, type: 'project-event', payload: budgetedPayload });
}

function emitJavaProjectResultEvents(id, result, options = {}) {
  if (!id || !result) return;
  const skipStdout = options.skipStdout === true;
  const skipStderr = options.skipStderr === true;
  const context = options.context ?? null;
  if (!skipStdout && typeof result.stdout === 'string' && result.stdout.length > 0) {
    postProjectEvent(id, {
      type: 'output',
      stream: 'stdout',
      device: '/dev/stdout',
      data: result.stdout,
    }, { context });
  }
  if (!skipStderr && typeof result.stderr === 'string' && result.stderr.length > 0) {
    postProjectEvent(id, {
      type: 'output',
      stream: 'stderr',
      device: '/dev/stderr',
      data: result.stderr,
    }, { context });
  }
  applyJavaProjectResultOutputBudget(result, context);
  if (Array.isArray(result.files)) {
    for (const change of result.files) {
      postProjectEvent(id, {
        type: 'file-change',
        phase: 'final-diff',
        change,
      }, { context });
    }
  }
}

function commandResultFromJavaProjectReport(report, totalEnd, totalStart, libraryCallEnd, libraryCallStart, outputDir, payload, sourceRoot) {
  const projectRoot = projectVirtualRoot(payload?.project);
  let compilerOutput = javaNormalizeProjectCompilerOutput(javaReportConsoleOutput(report).join('\n'), sourceRoot, projectRoot);
  if (
    report.success === true &&
    payload?.source === 'compile' &&
    compilerOutput.length === 0 &&
    javaJavacVerboseRequested(
      payload.args,
      payload.project,
      projectRelativeCwd(payload),
      projectVirtualRoot(payload?.project)
    )
  ) {
    compilerOutput = javaSyntheticJavacVerboseOutput(payload, outputDir);
  }
  if (report.success !== true) {
    return {
      stdout: '',
      stderr: javaProjectFailureStderr(report, sourceRoot, projectRoot),
      exitCode: 1,
      timings: {
        hostCallMs: libraryCallEnd - libraryCallStart,
        totalMs: totalEnd - totalStart,
        compileMs: report.compileTimeMs ?? 0,
        classLoadMs: report.classLoadTimeMs ?? 0,
        runMs: report.runTimeMs ?? 0,
        compileCacheHit: report.compileCacheHit ?? false,
      },
    };
  }

  let parsedPayload;
  try {
    const serialized = parseJavaReportOutput(report.output);
    parsedPayload = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  } catch (error) {
    parsedPayload = {
      stdout: '',
      stderr: `Java project result parse failed: ${formatWorkerErrorMessage(error)}`,
      exitCode: 1,
    };
  }

  return {
    stdout: typeof parsedPayload?.stdout === 'string' ? parsedPayload.stdout : '',
    stderr: `${compilerOutput}${sanitizeJavaRuntimeStderr(typeof parsedPayload?.stderr === 'string' ? parsedPayload.stderr : '')}`,
    exitCode: Number.isInteger(parsedPayload?.exitCode) ? parsedPayload.exitCode : 1,
    files: [
      ...projectCompiledFiles(report, outputDir),
      ...projectChangedFiles(report),
    ],
    timings: {
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: totalEnd - totalStart,
      compileMs: report.compileTimeMs ?? 0,
      classLoadMs: report.classLoadTimeMs ?? 0,
      runMs: report.runTimeMs ?? 0,
      compileCacheHit: report.compileCacheHit ?? false,
    },
  };
}

function javaCompileOutputDir(args, project, relativeCwd = '', projectCwd = '/workspace') {
  if (!Array.isArray(args)) return '.';
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  for (let index = 0; index < expandedArgs.length; index += 1) {
    const arg = expandedArgs[index];
    if (arg === '-d') {
      return typeof expandedArgs[index + 1] === 'string' && expandedArgs[index + 1].length > 0
        ? resolveProjectCommandPath(expandedArgs[index + 1], relativeCwd, projectCwd, true, project) || '.'
        : '.';
    }
  }
  const sourcePaths = javaCompileEffectiveSourcePaths(args, project, relativeCwd, projectCwd);
  const firstSourcePath = sourcePaths[0];
  const file = firstSourcePath ? projectFileMap(project).get(firstSourcePath) : null;
  return firstSourcePath && file ? javaPackageRootForSource(firstSourcePath, file.contents) || '.' : relativeCwd || '.';
}

function normalizeJavaOutputDir(path) {
  const raw = String(path ?? '.').trim();
  if (!raw || raw === '.') return '.';
  return normalizeProjectFilePath(raw);
}

function projectCompiledFiles(report, outputDir) {
  if (outputDir == null) return [];
  if (!Array.isArray(report?.compiledFiles)) return [];
  const normalizedOutputDir = normalizeJavaOutputDir(outputDir);
  return report.compiledFiles
    .filter((file) => file && typeof file.path === 'string' && typeof file.contents === 'string')
    .map((file) => ({
      path: normalizedOutputDir === '.'
        ? normalizeProjectFilePath(file.path)
        : normalizeProjectFilePath(`${normalizedOutputDir}/${file.path}`),
      contents: file.contents,
      encoding: file.encoding === 'base64' ? 'base64' : 'utf8',
    }));
}

function projectChangedFiles(report) {
  if (!Array.isArray(report?.changedFiles)) return [];
  return report.changedFiles
    .filter((file) => file && typeof file.path === 'string' && (file.deleted === true || typeof file.contents === 'string'))
    .map((file) => file.deleted === true
      ? { path: normalizeProjectFilePath(file.path), deleted: true }
      : {
          path: normalizeProjectFilePath(file.path),
          contents: file.contents,
          encoding: file.encoding === 'base64' ? 'base64' : 'utf8',
        });
}

async function buildJavaTraceRunnableSource(
  normalizedPayload,
  stableCompileId,
  dynamicInputs
) {
  let rewrittenSource = await rewriteSource(
    normalizedPayload,
    stableCompileId,
    dynamicInputs
  );
  const applyRewriteStage = (stage, transform) => {
    try {
      rewrittenSource = transform(rewrittenSource);
    } catch (error) {
      throw makeWorkerStageError(`trace source ${stage}`, error);
    }
  };
  applyRewriteStage('call argument snapshots', augmentTraceCallArgumentSnapshots);
  applyRewriteStage('array length reads', augmentArrayLengthReads);
  applyRewriteStage('collection operations', (source) =>
    self.TraceCodeJavaSourceAugmentations.augmentJavaCollectionOperations(
      source,
      normalizedPayload.sourceText
    )
  );
  applyRewriteStage('object field operations', augmentJavaObjectFieldOperations);
  applyRewriteStage('stdout events', augmentJavaStdoutEvents);
  applyRewriteStage('throw events', augmentJavaThrowEvents);
  applyRewriteStage('local snapshots', augmentJavaLocalSnapshots);
  applyRewriteStage('return value snapshots', augmentTraceReturnValueSnapshots);
  applyRewriteStage('budget call-site elision', elideTraceHooksAfterBudget);
  return rewrittenSource;
}

async function runJavaTraceRequest(payload, requestId) {
  const totalStart = performance.now();
  const rewriteStart = performance.now();
  const normalizedPayload = normalizeJavaExecutionPayload(payload);

  const stableCompileId = buildJavaCompileId(normalizedPayload, 'trace');
  const compileId = isolateJavaCompileId(buildJavaCompileId(normalizedPayload, 'trace'), requestId);
  const compileCacheKey = classicJavaCompileCacheKey('trace', stableCompileId);
  const dynamicInputs = normalizedPayload.inputTransport === 'inline-source'
    ? []
    : dynamicInputEntriesForPayload(normalizedPayload, stableCompileId);

  let rewrittenSource;
  try {
    rewrittenSource = await buildJavaTraceRunnableSource(
      normalizedPayload,
      stableCompileId,
      dynamicInputs
    );
  } catch (error) {
    const rewriteError = formatWorkerErrorMessage(error);
    const skipDiagnosticProbe =
      rewriteError.includes('unsupported legacy line= TraceHooks hooks') ||
      rewriteError.startsWith('TraceJVM rewrite ') ||
      rewriteError.startsWith('Java worker trace source ');
    const diagnosticProbe = skipDiagnosticProbe
      ? { consoleOutput: [], error: null, hostCallMs: 0, diagnosticError: null }
      : await collectCompileProbeDiagnostics(
          normalizedPayload,
          requestId,
          payload.options
        );
    const totalEnd = performance.now();
    const surfacedError =
      (skipDiagnosticProbe ? null : diagnosticProbe.error) ??
      (rewriteError === 'Java syntax error.'
        ? 'Java syntax error. Check Code Assist for parser details.'
        : `Java source rewrite failed: ${rewriteError}`);
    return {
      success: false,
      events: [],
      ...(normalizedPayload.sourceText ? { sourceText: normalizedPayload.sourceText } : {}),
      executionTimeMs: totalEnd - totalStart,
      consoleOutput: diagnosticProbe.consoleOutput,
      error: surfacedError,
      timings: {
        rewriteMs: totalEnd - rewriteStart,
        hostCallMs: diagnosticProbe.hostCallMs,
        totalMs: totalEnd - totalStart,
      },
    };
  }
  const rewriteEnd = performance.now();

  const exportsClassName = buildExportsClassName(stableCompileId);
  const packageName = buildPackageName(stableCompileId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const classesDir = `/files/java-worker/${compileId}/classes`;

  try {
    await writeDynamicInputFiles(dynamicInputs);
  } catch (error) {
    throw makeWorkerStageError('dynamic input write', error);
  }

  try {
    await self.cheerpOSAddStringFile(sourcePath, rewrittenSource);
  } catch (error) {
    throw makeWorkerStageError('source file write', error);
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    throw makeWorkerStageError('compiler bridge load', error);
  }
  const localArtifactCacheHit = await restoreClassicJavaCompileCache(compileLibraryClass, compileCacheKey, classesDir);
  const hostArtifactManifest = localArtifactCacheHit
    ? null
    : await restoreHostJavaCompileArtifact(compileCacheKey, requestId);
  const artifactCacheHit = localArtifactCacheHit || hostArtifactManifest !== null;
  const libraryCallStart = performance.now();
  let reportText;
  try {
    if (localArtifactCacheHit && typeof compileLibraryClass?.traceCachedClasses === 'function') {
      reportText = await compileLibraryClass.traceCachedClasses(
        classesDir,
        `${packageName}.${exportsClassName}`,
        HELPER_JAR_PATH,
        DEFAULT_COMPILER_DEBUG_PROFILE,
        String(resolveMaxStoredEvents(payload.options))
      );
    } else if (hostArtifactManifest !== null && typeof compileLibraryClass?.traceCompiledClassManifest === 'function') {
      reportText = await compileLibraryClass.traceCompiledClassManifest(
        hostArtifactManifest,
        classesDir,
        `${packageName}.${exportsClassName}`,
        HELPER_JAR_PATH,
        DEFAULT_COMPILER_DEBUG_PROFILE,
        '0',
        '',
        '',
        'true',
        String(resolveMaxStoredEvents(payload.options))
      );
    } else if (externalJavaCompilerAvailable(payload, compileLibraryClass, 'traceCompiledClassManifest')) {
      const externalCompile = await compileJavaOutsideBrowser({
        schema: 'tracecode.java.external-compile.v1',
        mode: 'trace',
        source: rewrittenSource,
        sourcePath,
        entryClasses: [`${packageName}.${exportsClassName}`],
        compileClasspath: HELPER_JAR_PATH,
        compilerProfile: DEFAULT_COMPILER_DEBUG_PROFILE,
      }, requestId);
      if (externalCompile.success !== true) {
        reportText = JSON.stringify({
          ...externalJavaCompileFailureReport(externalCompile),
          events: [],
          traceLimitExceeded: false,
          droppedEventCount: 0,
          compilerDebugProfile: DEFAULT_COMPILER_DEBUG_PROFILE,
        });
      } else {
        reportText = await compileLibraryClass.traceCompiledClassManifest(
          externalJavaClassManifest(externalCompile),
          classesDir,
          `${packageName}.${exportsClassName}`,
          HELPER_JAR_PATH,
          DEFAULT_COMPILER_DEBUG_PROFILE,
          String(externalCompile.compileMs),
          externalCompile.stdout,
          externalCompile.stderr,
          String(externalCompile.compileCacheHit),
          String(resolveMaxStoredEvents(payload.options))
        );
      }
    } else {
      reportText = await compileLibraryClass.compileAndTrace(
        sourcePath,
        classesDir,
        `${packageName}.${exportsClassName}`,
        HELPER_JAR_PATH,
        DEFAULT_COMPILER_DEBUG_PROFILE,
        String(resolveMaxStoredEvents(payload.options))
      );
    }
  } catch (error) {
    await deleteJavaRuntimeRequestTree(compileLibraryClass, compileId).catch(() => undefined);
    throw makeWorkerStageError('compile and trace', error);
  }
  const libraryCallEnd = performance.now();

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    await deleteJavaRuntimeRequestTree(compileLibraryClass, compileId).catch(() => undefined);
    throw makeWorkerStageError('trace report parse', error);
  }
  if (report.success === true && !artifactCacheHit) {
    await storeHostJavaCompileArtifact(compileLibraryClass, compileCacheKey, classesDir, requestId);
  }
  await finalizeClassicJavaCompileCache(
    compileLibraryClass,
    compileCacheKey,
    classesDir,
    compileId,
    artifactCacheHit
  );
  const totalEnd = performance.now();
  const consoleOutput = javaReportConsoleOutput(report, { includeSuccessfulDiagnostics: false });

  if (report.success !== true) {
    return {
      success: false,
      events: normalizeJavaTraceEvents(report.events, normalizedPayload),
      ...(normalizedPayload.sourceText ? { sourceText: normalizedPayload.sourceText } : {}),
      executionTimeMs: totalEnd - totalStart,
      consoleOutput,
      error: javaReportFailureMessage(report, 'Java trace failed without compiler/runtime diagnostics'),
      ...(report.traceLimitExceeded !== undefined
        ? {
            traceLimitExceeded: Boolean(report.traceLimitExceeded),
            timeoutReason: report.traceLimitExceeded ? 'trace-limit' : undefined,
            droppedEventCount: report.droppedEventCount ?? 0,
          }
        : {}),
      ...(report.bytecodeProfile ? { bytecodeProfile: report.bytecodeProfile } : {}),
      ...(report.diagnosticError ? { diagnosticError: report.diagnosticError } : {}),
      timings: {
        rewriteMs: rewriteEnd - rewriteStart,
        hostCallMs: libraryCallEnd - libraryCallStart,
        totalMs: totalEnd - totalStart,
      },
    };
  }

  return {
    success: true,
    output: parseJavaReportOutput(report.output),
    events: normalizeJavaTraceEvents(report.events, normalizedPayload),
    ...(normalizedPayload.sourceText ? { sourceText: normalizedPayload.sourceText } : {}),
    executionTimeMs: totalEnd - totalStart,
    consoleOutput,
    ...(report.traceLimitExceeded !== undefined
      ? {
          traceLimitExceeded: Boolean(report.traceLimitExceeded),
          timeoutReason: report.traceLimitExceeded ? 'trace-limit' : undefined,
          droppedEventCount: report.droppedEventCount ?? 0,
        }
      : {}),
    ...(report.bytecodeProfile ? { bytecodeProfile: report.bytecodeProfile } : {}),
    ...(report.diagnosticError ? { diagnosticError: report.diagnosticError } : {}),
    timings: {
      rewriteMs: rewriteEnd - rewriteStart,
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: totalEnd - totalStart,
      compileMs: report.compileTimeMs ?? 0,
      classLoadMs: report.classLoadTimeMs ?? 0,
      runMs: report.runTimeMs ?? 0,
      compileCacheHit: report.compileCacheHit ?? false,
      artifactCacheHit,
    },
  };
}

async function runJavaCodeRequest(payload, requestId) {
  const totalStart = performance.now();
  const normalizedPayload = normalizeJavaExecutionPayload(payload);
  const stableCompileId = buildJavaCompileId(normalizedPayload, 'execute');
  const compileId = isolateJavaCompileId(buildJavaCompileId(normalizedPayload, 'execute'), requestId);
  const compileCacheKey = classicJavaCompileCacheKey('execute', stableCompileId);
  const dynamicInputs = dynamicInputEntriesForPayload(normalizedPayload, stableCompileId);
  const exportsClassName = buildExportsClassName(stableCompileId);
  const packageName = buildPackageName(stableCompileId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const classesDir = `/files/java-worker/${compileId}/classes`;

  let runnableSource;
  try {
    runnableSource = buildPlainRunnableSource(normalizedPayload, stableCompileId, dynamicInputs);
  } catch (error) {
    throw makeWorkerStageError('source generation', error);
  }

  try {
    await writeDynamicInputFiles(dynamicInputs);
  } catch (error) {
    throw makeWorkerStageError('dynamic input write', error);
  }

  try {
    await self.cheerpOSAddStringFile(sourcePath, runnableSource);
  } catch (error) {
    throw makeWorkerStageError('source file write', error);
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    throw makeWorkerStageError('compiler bridge load', error);
  }
  const localArtifactCacheHit = await restoreClassicJavaCompileCache(compileLibraryClass, compileCacheKey, classesDir);
  const hostArtifactManifest = localArtifactCacheHit
    ? null
    : await restoreHostJavaCompileArtifact(compileCacheKey, requestId);
  const artifactCacheHit = localArtifactCacheHit || hostArtifactManifest !== null;

  const libraryCallStart = performance.now();
  let reportText;
  try {
    if (localArtifactCacheHit && typeof compileLibraryClass?.runCachedClasses === 'function') {
      reportText = await compileLibraryClass.runCachedClasses(
        classesDir,
        `${packageName}.${exportsClassName}`,
        HELPER_JAR_PATH,
        DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
      );
    } else if (hostArtifactManifest !== null && typeof compileLibraryClass?.runCompiledClassManifest === 'function') {
      reportText = await compileLibraryClass.runCompiledClassManifest(
        hostArtifactManifest,
        classesDir,
        `${packageName}.${exportsClassName}`,
        HELPER_JAR_PATH,
        DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE,
        '0',
        '',
        '',
        'true'
      );
    } else if (externalJavaCompilerAvailable(payload, compileLibraryClass, 'runCompiledClassManifest')) {
      const externalCompile = await compileJavaOutsideBrowser({
        schema: 'tracecode.java.external-compile.v1',
        mode: 'execute',
        source: runnableSource,
        sourcePath,
        entryClasses: [`${packageName}.${exportsClassName}`],
        compileClasspath: HELPER_JAR_PATH,
        compilerProfile: DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE,
      }, requestId);
      if (externalCompile.success !== true) {
        reportText = JSON.stringify({
          ...externalJavaCompileFailureReport(externalCompile),
          compilerDebugProfile: DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE,
        });
      } else {
        reportText = await compileLibraryClass.runCompiledClassManifest(
          externalJavaClassManifest(externalCompile),
          classesDir,
          `${packageName}.${exportsClassName}`,
          HELPER_JAR_PATH,
          DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE,
          String(externalCompile.compileMs),
          externalCompile.stdout,
          externalCompile.stderr,
          String(externalCompile.compileCacheHit)
        );
      }
    } else {
      reportText = await compileLibraryClass.compileAndRun(
        sourcePath,
        classesDir,
        `${packageName}.${exportsClassName}`,
        HELPER_JAR_PATH,
        DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
      );
    }
  } catch (error) {
    await deleteJavaRuntimeRequestTree(compileLibraryClass, compileId).catch(() => undefined);
    throw makeWorkerStageError('compile and run', error);
  }
  const libraryCallEnd = performance.now();

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    await deleteJavaRuntimeRequestTree(compileLibraryClass, compileId).catch(() => undefined);
    throw makeWorkerStageError('execution report parse', error);
  }
  if (report.success === true && !artifactCacheHit) {
    await storeHostJavaCompileArtifact(compileLibraryClass, compileCacheKey, classesDir, requestId);
  }
  await finalizeClassicJavaCompileCache(
    compileLibraryClass,
    compileCacheKey,
    classesDir,
    compileId,
    artifactCacheHit
  );

  const totalEnd = performance.now();
  const consoleOutput = javaReportConsoleOutput(report, { includeSuccessfulDiagnostics: false });
  const timings = {
    hostCallMs: libraryCallEnd - libraryCallStart,
    totalMs: totalEnd - totalStart,
    compileMs: report.compileTimeMs ?? 0,
    classLoadMs: report.classLoadTimeMs ?? 0,
    runMs: report.runTimeMs ?? 0,
    compileCacheHit: report.compileCacheHit ?? false,
    artifactCacheHit,
  };

  if (report.success !== true) {
    return {
      success: false,
      output: null,
      executionTimeMs: totalEnd - totalStart,
      consoleOutput,
      error: javaReportFailureMessage(report, 'Java execution failed without compiler/runtime diagnostics'),
      timings,
    };
  }

  return {
    success: true,
    output: parseJavaReportOutput(report.output),
    executionTimeMs: totalEnd - totalStart,
    consoleOutput,
    timings,
  };
}

async function runJavaProjectRequest(payload, requestId) {
  const totalStart = performance.now();
  if (payload?.options?.enablePreview === true) {
    return {
      stdout: '',
      stderr: 'java: --enable-preview is not supported by this runtime\n',
      exitCode: 2,
    };
  }
  const explicitClasspath = payload.source === 'run' && typeof javaProjectEffectiveClasspath(payload) === 'string';
  const compileId = isolateJavaCompileId(stableHash({
    compileMode: 'project',
    request: {
      files: explicitClasspath
        ? projectJavaClasspathFiles(payload.project).map((file) => [file.path, file.contents])
        : [
            ...projectJavaFiles(payload.project).map((file) => [file.path, file.contents]),
            ...projectJavaClasspathFiles(payload.project).map((file) => [file.path, file.contents]),
          ],
      source: payload.source,
      scriptPath: payload.scriptPath,
      args: Array.isArray(payload.args) ? payload.args : [],
      classpath: javaProjectEffectiveClasspath(payload) ?? '',
    },
  }), requestId);
  const bridgeRunId = createJavaProjectBridgeRunId(requestId);

  let runnableSource;
  try {
    runnableSource = explicitClasspath
      ? buildProjectJavaClassRunnableSource(payload, compileId, bridgeRunId)
      : buildProjectJavaRunnableSource(payload, compileId, bridgeRunId);
  } catch (error) {
    return {
      stdout: '',
      stderr: `${formatWorkerErrorMessage(error)}\n`,
      exitCode: 1,
    };
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    throw makeWorkerStageError('compiler bridge load', error);
  }

  const libraryCallStart = performance.now();
  const projectIo = {
    messageId: requestId,
    bridgeRunId,
    request: payload,
    stdinPipe: stdinPipeState(payload?.stdinPipe),
    stdoutEmitted: false,
    stderrEmitted: false,
    eventStdout: [],
    eventStderr: [],
    outputBytes: { stdout: 0, stderr: 0 },
    truncatedOutputStreams: new Set(),
    liveFileChangeCount: 0,
    liveFileChangeBytes: 0,
    warnedLiveFileBudget: false,
    kernelDevicePaths: new Set(
      (Array.isArray(payload?.project?.kernelDevices) ? payload.project.kernelDevices : [])
        .map((device) => normalizeKernelDeviceReference(device?.path))
        .filter((path) => path !== null)
    ),
  };
  let reportText;
  let projectExecutionError;
  let storageCleanupError;
  try {
    activeJavaProjectIo = projectIo;
    reportText = explicitClasspath
      ? typeof compileLibraryClass.compileAndRunProjectClassFilesWithWorkspace === 'function'
        ? await compileLibraryClass.compileAndRunProjectClassFilesWithWorkspace(
          runnableSource.classManifest,
          runnableSource.classRoot,
          runnableSource.sourceManifest,
          runnableSource.sourceRoot,
          runnableSource.workspaceManifest,
          runnableSource.workspaceRoot,
          runnableSource.workspaceCwd,
          runnableSource.classesDir,
          runnableSource.mainClassName,
          runnableSource.runtimeClasspath,
          HELPER_JAR_PATH,
          DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
        )
        : await compileLibraryClass.compileAndRunProjectClassFiles(
          runnableSource.classManifest,
          runnableSource.classRoot,
          runnableSource.sourceManifest,
          runnableSource.sourceRoot,
          runnableSource.classesDir,
          runnableSource.mainClassName,
          runnableSource.runtimeClasspath,
          HELPER_JAR_PATH,
          DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
        )
      : payload.source === 'compile' && typeof compileLibraryClass.compileProjectSourcesWithResources === 'function'
        ? await compileLibraryClass.compileProjectSourcesWithResources(
            runnableSource.sourceManifest,
            runnableSource.sourceRoot,
            runnableSource.classpathManifest,
            runnableSource.classpathRoot,
            runnableSource.compileSourcePaths,
            runnableSource.compileSourceRootPaths,
            runnableSource.classesDir,
            runnableSource.compileClasspath,
            DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
          )
      : typeof compileLibraryClass.compileAndRunProjectSourcesWithWorkspace === 'function'
        ? await compileLibraryClass.compileAndRunProjectSourcesWithWorkspace(
            runnableSource.sourceManifest,
            runnableSource.sourceRoot,
            runnableSource.classpathManifest,
            runnableSource.classpathRoot,
            runnableSource.workspaceManifest,
            runnableSource.workspaceRoot,
            runnableSource.workspaceCwd,
            runnableSource.classesDir,
            runnableSource.mainClassName,
            runnableSource.compileClasspath,
            DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
          )
        : typeof compileLibraryClass.compileAndRunProjectSourcesWithResources === 'function'
          ? await compileLibraryClass.compileAndRunProjectSourcesWithResources(
            runnableSource.sourceManifest,
            runnableSource.sourceRoot,
            runnableSource.classpathManifest,
            runnableSource.classpathRoot,
            runnableSource.classesDir,
            runnableSource.mainClassName,
            runnableSource.compileClasspath,
            DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
          )
          : await compileLibraryClass.compileAndRunProjectSources(
            runnableSource.sourceManifest,
            runnableSource.sourceRoot,
            runnableSource.classesDir,
            runnableSource.mainClassName,
            runnableSource.compileClasspath,
            DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
          );
  } catch (error) {
    projectExecutionError = error;
  } finally {
    closeAllJavaProjectHttpServers();
    activeJavaProjectIo = null;
    try {
      await deleteJavaRuntimeRequestTree(compileLibraryClass, compileId);
    } catch (error) {
      storageCleanupError = error;
    }
  }
  if (storageCleanupError) {
    throw makeWorkerStageError('project runtime storage cleanup', storageCleanupError);
  }
  if (projectExecutionError) {
    throw makeWorkerStageError('project compile and run', projectExecutionError);
  }
  const libraryCallEnd = performance.now();

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    throw makeWorkerStageError('project execution report parse', error);
  }

  const totalEnd = performance.now();
  const result = commandResultFromJavaProjectReport(
    report,
    totalEnd,
    totalStart,
    libraryCallEnd,
    libraryCallStart,
    payload.source === 'compile'
      ? javaCompileOutputDir(
          payload.args,
          payload.project,
          projectRelativeCwd(payload),
          projectVirtualRoot(payload?.project)
        )
      : null,
    payload,
    runnableSource.sourceRoot
  );
  emitJavaProjectResultEvents(requestId, result, {
    skipStdout: projectIo.stdoutEmitted,
    skipStderr: projectIo.stderrEmitted,
    context: projectIo,
  });
  return result;
}

async function runJavaCodeBatchRequest(payload, requestId) {
  const totalStart = performance.now();
  const inputBatch = Array.isArray(payload.inputBatch)
    ? payload.inputBatch.map((inputs) => inputs && typeof inputs === 'object' ? inputs : {})
    : [];
  if (inputBatch.length === 0) {
    throw new Error('Java batch execution requires a non-empty inputBatch array.');
  }

  const normalizedPayload = normalizeJavaExecutionPayload({
    ...payload,
    inputs: inputBatch[0] ?? {},
  });
  const stableCompileId = buildJavaBatchCompileId(normalizedPayload, inputBatch);
  const compileId = isolateJavaCompileId(buildJavaBatchCompileId(normalizedPayload, inputBatch), requestId);
  const compileCacheKey = classicJavaCompileCacheKey('execute-batch', stableCompileId);
  const dynamicInputBatch = inputBatch.map((inputs, index) =>
    dynamicInputEntriesForPayload(
      { ...normalizedPayload, inputs },
      `${stableCompileId}-${index}`
    )
  );
  const dynamicInputs = dynamicInputBatch.flat();
  const exportsClassName = buildExportsClassName(stableCompileId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const classesDir = `/files/java-worker/${compileId}/classes`;

  let runnableSource;
  let entryClasses;
  try {
    const batchSource = buildBatchRunnableSource(normalizedPayload, stableCompileId, inputBatch, dynamicInputBatch);
    runnableSource = batchSource.source;
    entryClasses = batchSource.entryClasses;
  } catch (error) {
    throw makeWorkerStageError('batch source generation', error);
  }

  try {
    await writeDynamicInputFiles(dynamicInputs);
  } catch (error) {
    throw makeWorkerStageError('dynamic input write', error);
  }

  try {
    await self.cheerpOSAddStringFile(sourcePath, runnableSource);
  } catch (error) {
    throw makeWorkerStageError('source file write', error);
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    throw makeWorkerStageError('compiler bridge load', error);
  }
  const localArtifactCacheHit = await restoreClassicJavaCompileCache(compileLibraryClass, compileCacheKey, classesDir);
  const hostArtifactManifest = localArtifactCacheHit
    ? null
    : await restoreHostJavaCompileArtifact(compileCacheKey, requestId);
  const artifactCacheHit = localArtifactCacheHit || hostArtifactManifest !== null;

  const libraryCallStart = performance.now();
  let reportText;
  try {
    if (localArtifactCacheHit && typeof compileLibraryClass?.runCachedClassesBatch === 'function') {
      reportText = await compileLibraryClass.runCachedClassesBatch(
        classesDir,
        entryClasses.join('\n'),
        HELPER_JAR_PATH,
        DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
      );
    } else if (hostArtifactManifest !== null && typeof compileLibraryClass?.runCompiledClassManifestBatch === 'function') {
      reportText = await compileLibraryClass.runCompiledClassManifestBatch(
        hostArtifactManifest,
        classesDir,
        entryClasses.join('\n'),
        HELPER_JAR_PATH,
        DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE,
        '0',
        '',
        '',
        'true'
      );
    } else if (externalJavaCompilerAvailable(payload, compileLibraryClass, 'runCompiledClassManifestBatch')) {
      const externalCompile = await compileJavaOutsideBrowser({
        schema: 'tracecode.java.external-compile.v1',
        mode: 'execute-batch',
        source: runnableSource,
        sourcePath,
        entryClasses,
        compileClasspath: HELPER_JAR_PATH,
        compilerProfile: DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE,
      }, requestId);
      if (externalCompile.success !== true) {
        reportText = JSON.stringify({
          ...externalJavaCompileFailureReport(externalCompile),
          results: [],
          compilerDebugProfile: DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE,
        });
      } else {
        reportText = await compileLibraryClass.runCompiledClassManifestBatch(
          externalJavaClassManifest(externalCompile),
          classesDir,
          entryClasses.join('\n'),
          HELPER_JAR_PATH,
          DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE,
          String(externalCompile.compileMs),
          externalCompile.stdout,
          externalCompile.stderr,
          String(externalCompile.compileCacheHit)
        );
      }
    } else {
      reportText = await compileLibraryClass.compileAndRunBatch(
        sourcePath,
        classesDir,
        entryClasses.join('\n'),
        HELPER_JAR_PATH,
        DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
      );
    }
  } catch (error) {
    await deleteJavaRuntimeRequestTree(compileLibraryClass, compileId).catch(() => undefined);
    throw makeWorkerStageError('compile and run batch', error);
  }
  const libraryCallEnd = performance.now();

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    await deleteJavaRuntimeRequestTree(compileLibraryClass, compileId).catch(() => undefined);
    throw makeWorkerStageError('batch execution report parse', error);
  }
  if (report.success === true && !artifactCacheHit) {
    await storeHostJavaCompileArtifact(compileLibraryClass, compileCacheKey, classesDir, requestId);
  }
  await finalizeClassicJavaCompileCache(
    compileLibraryClass,
    compileCacheKey,
    classesDir,
    compileId,
    artifactCacheHit
  );

  const totalEnd = performance.now();
  const consoleOutput = javaReportConsoleOutput(report, { includeSuccessfulDiagnostics: false });
  const compileMs = report.compileTimeMs ?? 0;
  const compileCacheHit = report.compileCacheHit ?? false;
  const rawResults = Array.isArray(report.results) ? report.results : [];
  const results = rawResults.map((entry) => {
    const success = entry?.success === true;
    const classLoadMs = entry?.classLoadTimeMs ?? 0;
    const runMs = entry?.runTimeMs ?? 0;
    return {
      success,
      output: success ? parseJavaReportOutput(entry.output) : null,
      consoleOutput,
      ...(success ? {} : { error: javaReportFailureMessage({ ...report, ...entry }, 'Java batch item failed without compiler/runtime diagnostics') }),
      timings: {
        compileMs: 0,
        classLoadMs,
        runMs,
        hostCallMs: 0,
        totalMs: classLoadMs + runMs,
        compileCacheHit,
        artifactCacheHit,
      },
    };
  });

  if (results.length > 0) {
    results[0].timings = {
      ...results[0].timings,
      compileMs,
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: totalEnd - totalStart,
    };
  }

  return {
    success: report.success === true,
    results,
    executionTimeMs: totalEnd - totalStart,
    consoleOutput,
    ...(report.success === true ? {} : { error: javaReportFailureMessage(report, 'Java batch execution failed without compiler/runtime diagnostics') }),
    timings: {
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: totalEnd - totalStart,
      compileMs,
      classLoadMs: rawResults.reduce((sum, entry) => sum + (entry?.classLoadTimeMs ?? 0), 0),
      runMs: rawResults.reduce((sum, entry) => sum + (entry?.runTimeMs ?? 0), 0),
      compileCacheHit,
      artifactCacheHit,
    },
  };
}

async function prepareJavaRuntimeProgram(payload, requestId) {
  const totalStart = performance.now();
  const mode = payload?.mode;
  if (mode !== 'code' && mode !== 'trace') {
    return {
      success: false,
      error: `Unsupported Java prepared program mode: ${String(mode)}`,
      consoleOutput: [],
      timings: { totalMs: performance.now() - totalStart },
    };
  }

  let normalizedPayload;
  let dynamicInputs;
  let source;
  let stableCompileId;
  let rewriteMs = 0;
  try {
    normalizedPayload = normalizeJavaExecutionPayload({
      ...payload,
      inputs: {},
      options: payload.options ?? {},
    });
    stableCompileId = stableHash({
      compileMode: `prepared-${mode}`,
      code: normalizedPayload.code,
      functionName: normalizedPayload.functionName,
      executionStyle: normalizedPayload.executionStyle,
      scriptMode: normalizedPayload.scriptMode === true,
      options: mode === 'trace' ? normalizedPayload.options ?? {} : {},
    });
    dynamicInputs = preparedDynamicInputEntriesForPayload(
      normalizedPayload,
      stableCompileId
    );
    const sourceStart = performance.now();
    source = mode === 'trace'
      ? await buildJavaTraceRunnableSource(
          normalizedPayload,
          stableCompileId,
          dynamicInputs
        )
      : buildPlainRunnableSource(
          normalizedPayload,
          stableCompileId,
          dynamicInputs
        );
    rewriteMs = performance.now() - sourceStart;
  } catch (error) {
    return {
      success: false,
      error: formatWorkerErrorMessage(error),
      consoleOutput: [],
      timings: {
        rewriteMs,
        totalMs: performance.now() - totalStart,
      },
    };
  }

  const programId = isolateJavaCompileId(stableCompileId, requestId);
  const exportsClassName = buildExportsClassName(stableCompileId);
  const packageName = buildPackageName(stableCompileId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const entryClass = `${packageName}.${exportsClassName}`;

  try {
    await self.cheerpOSAddStringFile(sourcePath, source);
  } catch (error) {
    return {
      success: false,
      error: `Java prepared source file write failed: ${formatWorkerErrorMessage(error)}`,
      consoleOutput: [],
      timings: {
        rewriteMs,
        totalMs: performance.now() - totalStart,
      },
    };
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
    if (typeof compileLibraryClass?.prepareRuntimeProgram !== 'function') {
      throw new Error(
        'The selected Java runtime does not support prepared program execution.'
      );
    }
  } catch (error) {
    return {
      success: false,
      error: formatWorkerErrorMessage(error),
      consoleOutput: [],
      timings: {
        rewriteMs,
        totalMs: performance.now() - totalStart,
      },
    };
  }

  const libraryCallStart = performance.now();
  let report;
  try {
    const reportText = await compileLibraryClass.prepareRuntimeProgram(
      programId,
      sourcePath,
      mode === 'trace'
        ? DEFAULT_COMPILER_DEBUG_PROFILE
        : DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
    );
    report = JSON.parse(reportText);
  } catch (error) {
    return {
      success: false,
      error: `Java prepared compilation failed: ${formatWorkerErrorMessage(error)}`,
      consoleOutput: [],
      timings: {
        rewriteMs,
        hostCallMs: performance.now() - libraryCallStart,
        totalMs: performance.now() - totalStart,
      },
    };
  }
  const libraryCallEnd = performance.now();
  const consoleOutput = javaReportConsoleOutput(report, {
    includeSuccessfulDiagnostics: false,
  });
  const timings = {
    rewriteMs,
    compileMs: report.compileTimeMs ?? 0,
    classLoadMs: 0,
    runMs: 0,
    hostCallMs: libraryCallEnd - libraryCallStart,
    totalMs: performance.now() - totalStart,
    compileCacheHit: report.compileCacheHit ?? false,
    artifactCacheHit: false,
  };

  if (report.success !== true) {
    return {
      success: false,
      error: javaReportFailureMessage(
        report,
        'Java prepared compilation failed without compiler diagnostics'
      ),
      consoleOutput,
      timings,
    };
  }

  const preparedState = {
    mode,
    entryClass,
    learnerFrame:
      normalizedPayload.executionStyle === 'solution-method' &&
      typeof normalizedPayload.functionName === 'string' &&
      normalizedPayload.functionName
        ? `Solution.${normalizedPayload.functionName}`
        : '',
    dynamicInputs,
    normalizedPayload: {
      sourceText: normalizedPayload.sourceText,
      scriptMode: normalizedPayload.scriptMode === true,
      userCodeLineCount: normalizedPayload.userCodeLineCount,
      sourceLineMap: normalizedPayload.sourceLineMap,
    },
    traceOptions: payload.options ?? {},
  };
  preparedJavaRuntimePrograms.set(programId, preparedState);
  return {
    success: true,
    programId,
    snapshot: {
      schema: 'tracecode.java.prepared-program-snapshot.v1',
      programId,
      ...preparedState,
      runtimeArtifact: report.preparedArtifact,
    },
    consoleOutput,
    timings,
  };
}

function assertPreparedJavaRuntimeSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.schema !== 'tracecode.java.prepared-program-snapshot.v1' ||
    typeof snapshot.programId !== 'string' ||
    !snapshot.programId ||
    (snapshot.mode !== 'code' && snapshot.mode !== 'trace') ||
    typeof snapshot.entryClass !== 'string' ||
    !snapshot.entryClass ||
    (snapshot.learnerFrame !== undefined &&
      typeof snapshot.learnerFrame !== 'string') ||
    !Array.isArray(snapshot.dynamicInputs) ||
    !snapshot.normalizedPayload ||
    typeof snapshot.normalizedPayload !== 'object' ||
    !snapshot.runtimeArtifact ||
    typeof snapshot.runtimeArtifact !== 'object'
  ) {
    throw new TypeError('Invalid Java prepared program snapshot.');
  }
}

async function restorePreparedJavaRuntimeProgram(payload) {
  const snapshot = payload?.snapshot;
  assertPreparedJavaRuntimeSnapshot(snapshot);
  if (preparedJavaRuntimePrograms.has(snapshot.programId)) {
    throw new Error(
      `Java prepared program already exists: ${snapshot.programId}`
    );
  }

  const compileLibraryClass = await getCompileLibraryClass();
  if (typeof compileLibraryClass?.restoreRuntimeProgram !== 'function') {
    throw new Error(
      'The selected Java runtime cannot restore a prepared program.'
    );
  }
  await compileLibraryClass.restoreRuntimeProgram(
    snapshot.programId,
    JSON.stringify(snapshot.runtimeArtifact),
    snapshot.mode === 'trace'
      ? DEFAULT_COMPILER_DEBUG_PROFILE
      : DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
  );
  preparedJavaRuntimePrograms.set(snapshot.programId, {
    mode: snapshot.mode,
    entryClass: snapshot.entryClass,
    learnerFrame:
      typeof snapshot.learnerFrame === 'string'
        ? snapshot.learnerFrame
        : '',
    dynamicInputs: snapshot.dynamicInputs,
    normalizedPayload: snapshot.normalizedPayload,
    traceOptions: snapshot.traceOptions ?? {},
  });
  return {
    success: true,
    programId: snapshot.programId,
    consoleOutput: [],
    timings: {
      compileMs: 0,
      classLoadMs: 0,
      runMs: 0,
      totalMs: 0,
      compileCacheHit: true,
      artifactCacheHit: true,
    },
  };
}

function preparedJavaInputValue(program, inputs, dynamicInput) {
  if (dynamicInput.key === '__ops__') return inputs;
  if (Object.prototype.hasOwnProperty.call(inputs, dynamicInput.key)) {
    return inputs[dynamicInput.key];
  }
  const values = Object.values(inputs);
  if (dynamicInput.index < values.length) return values[dynamicInput.index];
  throw new Error(
    `Java prepared execution is missing input "${dynamicInput.key}".`
  );
}

function preparedJavaInputProperties(program, inputs) {
  return Object.fromEntries(
    program.dynamicInputs.map((dynamicInput) => [
      dynamicInput.property,
      JSON.stringify(preparedJavaInputValue(program, inputs, dynamicInput)),
    ])
  );
}

function preparedJavaResultFromReport(
  program,
  report,
  executionTimeMs,
  hostCallMs
) {
  const consoleOutput = [
    ...javaReportConsoleOutput(report, {
      includeSuccessfulDiagnostics: false,
    }),
    ...(report.traceProfile
      ? [
          `__TRACECODE_TRACE_PROFILE_JSON__:${JSON.stringify(report.traceProfile)}`,
        ]
      : []),
  ];
  const timings = {
    compileMs: 0,
    classLoadMs: report.classLoadTimeMs ?? 0,
    runMs: report.runTimeMs ?? 0,
    hostCallMs,
    totalMs: executionTimeMs,
    compileCacheHit: true,
    artifactCacheHit: true,
  };

  if (program.mode === 'trace') {
    const events = normalizeJavaTraceEvents(
      report.events,
      program.normalizedPayload
    );
    return {
      success: report.success === true,
      ...(report.success === true
        ? { output: parseJavaReportOutput(report.output) }
        : javaReportFailure(
            report,
            'Java prepared trace failed without compiler/runtime diagnostics'
          )),
      events,
      ...(program.normalizedPayload.sourceText
        ? { sourceText: program.normalizedPayload.sourceText }
        : {}),
      executionTimeMs,
      consoleOutput,
      ...(report.traceLimitExceeded !== undefined
        ? {
            traceLimitExceeded: Boolean(report.traceLimitExceeded),
            timeoutReason: report.traceLimitExceeded
              ? 'trace-limit'
              : undefined,
            droppedEventCount: report.droppedEventCount ?? 0,
          }
        : {}),
      ...(report.traceProfile ? { traceProfile: report.traceProfile } : {}),
      ...(report.bytecodeProfile
        ? { bytecodeProfile: report.bytecodeProfile }
        : {}),
      ...(report.diagnosticError
        ? { diagnosticError: report.diagnosticError }
        : {}),
      runtimeIsolation: report.isolation,
      retirementRecommended: report.retirementRecommended === true,
      timings,
    };
  }

  if (report.success !== true) {
    return {
      success: false,
      output: null,
      ...javaReportFailure(
        report,
        'Java prepared execution failed without compiler/runtime diagnostics'
      ),
      consoleOutput,
      executionTimeMs,
      runtimeIsolation: report.isolation,
      retirementRecommended: report.retirementRecommended === true,
      timings,
    };
  }
  return {
    success: true,
    output: parseJavaReportOutput(report.output),
    consoleOutput,
    executionTimeMs,
    runtimeIsolation: report.isolation,
    retirementRecommended: report.retirementRecommended === true,
    timings,
  };
}

async function executePreparedJavaRuntimeProgram(payload) {
  const totalStart = performance.now();
  const programId = String(payload?.programId ?? '');
  const program = preparedJavaRuntimePrograms.get(programId);
  if (!program) {
    return {
      success: false,
      output: null,
      events: [],
      error: `Unknown Java prepared program: ${programId}`,
      consoleOutput: [],
      executionTimeMs: performance.now() - totalStart,
      timings: { totalMs: performance.now() - totalStart },
    };
  }
  const inputs =
    payload?.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs)
      ? payload.inputs
      : {};

  let preparedInputProperties;
  try {
    preparedInputProperties = preparedJavaInputProperties(program, inputs);
  } catch (error) {
    return {
      success: false,
      output: null,
      events: [],
      error: `Java prepared input materialization failed: ${formatWorkerErrorMessage(error)}`,
      consoleOutput: [],
      executionTimeMs: performance.now() - totalStart,
      ...(program.normalizedPayload.sourceText
        ? { sourceText: program.normalizedPayload.sourceText }
        : {}),
      timings: { totalMs: performance.now() - totalStart },
    };
  }

  let compileLibraryClass;
  const libraryCallStart = performance.now();
  let report;
  try {
    compileLibraryClass = await getCompileLibraryClass();
    if (typeof compileLibraryClass?.runPreparedRuntimeProgram !== 'function') {
      throw new Error(
        'The selected Java runtime does not support prepared program execution.'
      );
    }
    const reportText = await compileLibraryClass.runPreparedRuntimeProgram(
      programId,
      program.entryClass,
      String(
        program.mode === 'trace'
          ? resolveMaxStoredEvents(program.traceOptions)
          : 1
      ),
      JSON.stringify(preparedInputProperties),
      program.learnerFrame,
      String(program.mode === 'trace' && program.traceOptions?.traceProfile === true)
    );
    report = JSON.parse(reportText);
  } catch (error) {
    return {
      success: false,
      output: null,
      events: [],
      error: `Java prepared execution failed: ${formatWorkerErrorMessage(error)}`,
      consoleOutput: [],
      executionTimeMs: performance.now() - totalStart,
      ...(program.normalizedPayload.sourceText
        ? { sourceText: program.normalizedPayload.sourceText }
        : {}),
      timings: {
        hostCallMs: performance.now() - libraryCallStart,
        totalMs: performance.now() - totalStart,
      },
    };
  }
  const libraryCallEnd = performance.now();
  const totalEnd = performance.now();
  return preparedJavaResultFromReport(
    program,
    report,
    totalEnd - totalStart,
    libraryCallEnd - libraryCallStart
  );
}

async function executePreparedJavaRuntimeProgramBatch(payload) {
  const totalStart = performance.now();
  const programId = String(payload?.programId ?? '');
  const program = preparedJavaRuntimePrograms.get(programId);
  const inputBatch = Array.isArray(payload?.inputBatch)
    ? payload.inputBatch.map((inputs) =>
        inputs && typeof inputs === 'object' && !Array.isArray(inputs)
          ? inputs
          : {}
      )
    : [];
  if (!program) {
    return {
      success: false,
      results: [],
      error: `Unknown Java prepared program: ${programId}`,
      executionTimeMs: performance.now() - totalStart,
    };
  }
  if (inputBatch.length === 0) {
    return {
      success: false,
      results: [],
      error: 'Java prepared batch execution requires a non-empty inputBatch.',
      executionTimeMs: performance.now() - totalStart,
    };
  }

  let preparedInputPropertiesBatch;
  try {
    preparedInputPropertiesBatch = inputBatch.map((inputs) =>
      preparedJavaInputProperties(program, inputs)
    );
  } catch (error) {
    return {
      success: false,
      results: [],
      error: `Java prepared batch input materialization failed: ${formatWorkerErrorMessage(error)}`,
      executionTimeMs: performance.now() - totalStart,
    };
  }

  const libraryCallStart = performance.now();
  let report;
  try {
    const compileLibraryClass = await getCompileLibraryClass();
    if (
      typeof compileLibraryClass?.runPreparedRuntimeProgramBatch !==
      'function'
    ) {
      throw new Error(
        'The selected Java runtime does not support prepared batch execution.'
      );
    }
    const reportText =
      await compileLibraryClass.runPreparedRuntimeProgramBatch(
        programId,
        program.entryClass,
        String(
          program.mode === 'trace'
            ? resolveMaxStoredEvents(program.traceOptions)
            : 1
        ),
        JSON.stringify(preparedInputPropertiesBatch),
        String(
          Number.isFinite(payload?.perCaseWallClockMs)
            ? Math.max(1, Math.floor(payload.perCaseWallClockMs))
            : 0
        ),
        program.learnerFrame,
        String(program.mode === 'trace' && program.traceOptions?.traceProfile === true)
      );
    report = JSON.parse(reportText);
  } catch (error) {
    return {
      success: false,
      results: [],
      error: `Java prepared batch execution failed: ${formatWorkerErrorMessage(error)}`,
      executionTimeMs: performance.now() - totalStart,
    };
  }
  const libraryCallEnd = performance.now();
  const rawResults = Array.isArray(report.results) ? report.results : [];
  const results = rawResults.map((entry) => {
    const executionTimeMs =
      (entry.classLoadTimeMs ?? 0) + (entry.runTimeMs ?? 0);
    const result = preparedJavaResultFromReport(
      program,
      entry,
      executionTimeMs,
      0
    );
    return program.mode === 'trace'
      ? {
          ...result,
          trace: { events: result.events ?? [] },
          events: undefined,
        }
      : result;
  });
  if (results[0]?.timings) {
    results[0].timings.runnerProcessCount =
      report.runnerProcessCount ?? 0;
  }
  return {
    success:
      report.success === true && results.length === inputBatch.length,
    results,
    executionTimeMs: performance.now() - totalStart,
    timings: {
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: performance.now() - totalStart,
      compileMs: 0,
      classLoadMs: rawResults.reduce(
        (sum, entry) => sum + (entry.classLoadTimeMs ?? 0),
        0
      ),
      runMs: rawResults.reduce(
        (sum, entry) => sum + (entry.runTimeMs ?? 0),
        0
      ),
      compileCacheHit: true,
      artifactCacheHit: true,
    },
  };
}

async function disposePreparedJavaRuntimeProgram(payload) {
  const programId = String(payload?.programId ?? '');
  const existed = preparedJavaRuntimePrograms.delete(programId);
  const compileLibraryClass = await getCompileLibraryClass();
  if (typeof compileLibraryClass?.disposeRuntimeProgram === 'function') {
    await compileLibraryClass.disposeRuntimeProgram(programId);
  }
  return { success: true, disposed: existed };
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }

  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  idleGeneration += 1;

  if (message.type === 'terminate') {
    preparedJavaRuntimePrograms.clear();
    for (const [, pending] of pendingExternalJavaCompiles) {
      pending.reject(new Error('Java worker terminated during external compile.'));
    }
    pendingExternalJavaCompiles.clear();
    for (const [, pending] of pendingCompilerArtifactCacheRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Java worker terminated during compiler artifact cache request.'));
    }
    pendingCompilerArtifactCacheRequests.clear();
    self.close();
    return;
  }

  if (message.type === 'java-compile-response') {
    const pending = pendingExternalJavaCompiles.get(message.requestId);
    if (!pending) return;
    if (message.protocolToken !== pending.protocolToken) return;
    pendingExternalJavaCompiles.delete(message.requestId);
    if (message.payload?.success === false && typeof message.payload?.error === 'string' && !message.payload?.classes) {
      pending.resolve(message.payload);
      return;
    }
    pending.resolve(message.payload);
    return;
  }

  if (message.type === 'compiler-artifact-cache-response') {
    const pending = pendingCompilerArtifactCacheRequests.get(message.requestId);
    if (!pending || message.protocolToken !== pending.protocolToken) return;
    pendingCompilerArtifactCacheRequests.delete(message.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(message.payload ?? {});
    return;
  }

  if (message.id && typeof message.protocolToken !== 'string') {
    postMessageResponse({
      id: message.id,
      type: 'error',
      payload: { error: 'Missing Java worker protocol token.' },
    });
    return;
  }
  if (message.id) activeProtocolTokens.set(message.id, message.protocolToken);

  if (message.type === 'init') {
    queue = queue.then(async () => {
      try {
        applyWorkerOptions(message.payload);
        const startedAt = performance.now();
        await ensureReady();
        const totalMs = performance.now() - startedAt;
        postMessageResponse({
          id: message.id,
          type: 'init',
          payload: {
            success: true,
            loadTimeMs: Math.round(totalMs),
            timings: {
              totalMs,
              initMs: initLoadTimeMs ?? 0,
              warmupMs: 0,
            },
          },
        });
      } catch (error) {
        const errorMessage = await formatWorkerErrorMessageAsync(error);
        emitRuntimeDiagnostic('error', 'worker-request-failed', 'Java worker init request failed.', {
          type: message.type,
          message: errorMessage,
        });
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: errorMessage },
        });
      } finally {
        activeProtocolTokens.delete(message.id);
        resetIdleTimer();
      }
    });
    return;
  }

  if (message.type === 'warmup') {
    queue = queue.then(async () => {
      try {
        applyWorkerOptions(message.payload);
        await ensureReady();
        const result = await warmRunHost();
        postMessageResponse({
          id: message.id,
          type: 'warmup',
          payload: result,
        });
      } catch (error) {
        const errorMessage = await formatWorkerErrorMessageAsync(error);
        emitRuntimeDiagnostic('error', 'worker-request-failed', 'Java worker warmup request failed.', {
          type: message.type,
          message: errorMessage,
        });
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: errorMessage },
        });
      } finally {
        activeProtocolTokens.delete(message.id);
        resetIdleTimer();
      }
    });
    return;
  }

  if (message.type === 'reset-persistent-storage') {
    queue = queue.then(async () => {
      try {
        await ensureReady();
        const compileLibraryClass = await getCompileLibraryClass();
        await compileLibraryClass.resetPersistentRuntimeStorage();
        javaCompileCache.clear();
        postMessageResponse({
          id: message.id,
          type: 'reset-persistent-storage',
          payload: { success: true },
        });
      } catch (error) {
        const errorMessage = await formatWorkerErrorMessageAsync(error);
        emitRuntimeDiagnostic('error', 'worker-request-failed', 'Java storage reset failed.', {
          type: message.type,
          message: errorMessage,
        });
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: errorMessage },
        });
      } finally {
        activeProtocolTokens.delete(message.id);
        resetIdleTimer();
      }
    });
    return;
  }

  if (
    message.type === 'execute-with-tracing' ||
    message.type === 'execute-code' ||
    message.type === 'execute-code-batch' ||
    message.type === 'execute-project-java' ||
    message.type === 'prepare-runtime-program' ||
    message.type === 'restore-prepared-runtime-program' ||
    message.type === 'execute-prepared-runtime-program' ||
    message.type === 'execute-prepared-runtime-program-batch' ||
    message.type === 'dispose-prepared-runtime-program'
  ) {
    queue = queue.then(async () => {
      try {
        applyWorkerOptions(message.payload);
        await ensureReady();
        // Complete trusted compiler/runtime loading before ambient browser
        // authority is removed for the user-controlled invocation.
        await warmRunHost();
        const requestedAuthorityMode = message.type === 'execute-project-java'
          ? message.payload?.projectUserAuthorityMode ?? 'temporary'
          : 'temporary';
        const preparedProgramMode =
          (
            message.type === 'execute-prepared-runtime-program' ||
            message.type === 'execute-prepared-runtime-program-batch'
          )
            ? preparedJavaRuntimePrograms.get(
                String(message.payload?.programId ?? '')
              )?.mode
            : undefined;
        const executeUserRequest = () =>
          message.type === 'execute-with-tracing'
            ? runJavaTraceRequest(message.payload, message.id)
            : message.type === 'execute-code-batch'
              ? runJavaCodeBatchRequest(message.payload, message.id)
              : message.type === 'execute-project-java'
                ? runJavaProjectRequest(message.payload, message.id)
                : message.type === 'prepare-runtime-program'
                  ? prepareJavaRuntimeProgram(message.payload, message.id)
                  : message.type === 'restore-prepared-runtime-program'
                    ? restorePreparedJavaRuntimeProgram(message.payload)
                  : message.type === 'execute-prepared-runtime-program'
                    ? executePreparedJavaRuntimeProgram(message.payload)
                    : message.type ===
                        'execute-prepared-runtime-program-batch'
                      ? executePreparedJavaRuntimeProgramBatch(message.payload)
                    : message.type === 'dispose-prepared-runtime-program'
                      ? disposePreparedJavaRuntimeProgram(message.payload)
                      : runJavaCodeRequest(message.payload, message.id);
        const postExecutionResult = (result) => postMessageResponse(
          { id: message.id, type: message.type, payload: result },
          message.type === 'execute-with-tracing' ||
          (
            message.type === 'execute-prepared-runtime-program' &&
            preparedProgramMode === 'trace'
          )
            ? {
                traceEventTransport: message.payload?.traceEventTransport,
                traceEventPath: 'events',
              }
            : (
                message.type ===
                  'execute-prepared-runtime-program-batch' &&
                preparedProgramMode === 'trace'
              )
              ? {
                  traceEventTransport:
                    message.payload?.traceEventTransport,
                  traceEventPath: 'results[].trace.events',
                }
            : undefined
        );
        self.TraceCodeActiveKernelRequestId = message.id;
        let result;
        try {
          result = await withJavaUserAuthorityLockdown(
            executeUserRequest,
            requestedAuthorityMode
          );
        } finally {
          if (self.TraceCodeActiveKernelRequestId === message.id) {
            self.TraceCodeActiveKernelRequestId = undefined;
          }
        }
        postExecutionResult(result);
      } catch (error) {
        const errorMessage = await formatWorkerErrorMessageAsync(error);
        if (WORKER_DEBUG) console.error(`[TraceRuntime Java request failed] ${errorMessage}`);
        emitRuntimeDiagnostic('error', 'worker-request-failed', 'Java worker execution request failed.', {
          type: message.type,
          message: errorMessage,
        });
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: errorMessage },
        });
      } finally {
        self.TraceCodeReleaseKernelRequest?.(
          message.id,
          message.payload?.programId
        );
        activeProtocolTokens.delete(message.id);
        resetIdleTimer();
      }
    });
    return;
  }
};

queueMicrotask(() => {
  emitRuntimeDiagnostic('info', 'worker-ready', 'Java worker is ready.');
  postMessageResponse({ type: 'worker-ready' });
});
