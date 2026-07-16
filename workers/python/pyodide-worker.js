/**
 * Python Web Worker
 * 
 * Runs Python code execution in a separate thread to avoid blocking the UI.
 * This worker handles loading the Python runtime, executing code, and returning traces.
 * 
 * This is the canonical worker implementation for the browser Python runtime.
 * The legacy lib/execution/pyodide.ts path is deprecated and should not be used.
 * 
 * IMPORTANT: Shared harness snippets are defined in:
 * - packages/harness-python/src/python-harness-template.ts
 * and generated into:
 * - packages/harness-python/src/generated/python-harness-snippets.ts
 * - workers/python/generated-python-harness-snippets.js
 *
 * Runtime trace/execute builders now live in:
 * - workers/python/runtime-core.js
 *
 * Keep worker/runtime-core split aligned with generated shared snippets and
 * validate with:
 *   pnpm test:python-regression-gate
 * 
 * Version: 4 (raises exception to abort infinite loops)
 */

// Worker version: 4

const trustedPythonWorkerPostMessage = self.postMessage.bind(self);

// Pyodide index URLs in fallback order
const PYODIDE_INDEX_URLS = [
  'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/',
  'https://unpkg.com/pyodide@0.29.0/',
];
const DECLARED_PYTHON_WORKER_FORMAT = (() => {
  try {
    const search = typeof self.location?.search === 'string' ? self.location.search : '';
    return new URLSearchParams(search).get('tracecodePythonWorkerFormat') === 'module'
      ? 'module'
      : 'classic';
  } catch {
    return 'classic';
  }
})();
const CONFIGURED_PYTHON_SNIPPETS_BOOTSTRAP_URL = (() => {
  try {
    const search = typeof self.location?.search === 'string' ? self.location.search : '';
    const value = new URLSearchParams(search).get('tracecodePythonSnippets');
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
})();
const GENERATED_HARNESS_SNIPPETS_PATHS = CONFIGURED_PYTHON_SNIPPETS_BOOTSTRAP_URL
  ? [CONFIGURED_PYTHON_SNIPPETS_BOOTSTRAP_URL]
  : ['./generated-python-harness-snippets.js'];
const SHARED_KERNEL_POLICY_CLASSIC_PATHS = [
  './shared/runtime-kernel-policy-classic.js',
  '../shared/runtime-kernel-policy-classic.js',
];
const SHARED_KERNEL_POLICY_MODULE_PATHS = [
  './shared/runtime-kernel-policy.js',
  '../shared/runtime-kernel-policy.js',
];
const DEFAULT_PYTHON_COMPILE_CACHE_LIMIT = 4;
const MAX_PYTHON_COMPILE_CACHE_LIMIT = 16;

let configuredPythonRuntimeAssets = null;
let configuredPythonRuntimeAssetsSignature = null;
let configuredPythonSnippetsLoaded = false;
let pythonModuleBootstrapPromise = null;
let moduleLoadPyodide = null;
let trustedPythonUserAuthorityLockdown = null;
let pythonCompileCacheLimit = DEFAULT_PYTHON_COMPILE_CACHE_LIMIT;

function configurePythonWorkerOptions(payload) {
  if (payload?.compileCacheLimit === undefined) return;
  const value = Number(payload.compileCacheLimit);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PYTHON_COMPILE_CACHE_LIMIT) {
    throw new Error(
      `Python worker compileCacheLimit must be an integer from 0 to ${MAX_PYTHON_COMPILE_CACHE_LIMIT}.`
    );
  }
  pythonCompileCacheLimit = value;
}

function configurePythonRuntimeAssets(value) {
  if (value === undefined || value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Python worker runtimeAssets must be an object.');
  }
  const loaderFormat = value.loaderFormat ?? 'classic-script';
  if (loaderFormat !== 'classic-script' && loaderFormat !== 'module') {
    throw new Error('Python worker runtimeAssets.loaderFormat must be "classic-script" or "module".');
  }
  const coherentFormatPair =
    (DECLARED_PYTHON_WORKER_FORMAT === 'classic' && loaderFormat === 'classic-script') ||
    (DECLARED_PYTHON_WORKER_FORMAT === 'module' && loaderFormat === 'module');
  if (!coherentFormatPair) {
    throw new Error(
      `Python worker format "${DECLARED_PYTHON_WORKER_FORMAT}" is incompatible with loader format "${loaderFormat}".`
    );
  }
  const normalized = {
    loaderFormat,
    ...(typeof value.loaderUrl === 'string' && value.loaderUrl.trim() ? { loaderUrl: value.loaderUrl } : {}),
    ...(typeof value.indexUrl === 'string' && value.indexUrl.trim() ? { indexUrl: value.indexUrl } : {}),
    ...(typeof value.runtimeCoreUrl === 'string' && value.runtimeCoreUrl.trim()
      ? { runtimeCoreUrl: value.runtimeCoreUrl }
      : {}),
    ...(typeof value.snippetsUrl === 'string' && value.snippetsUrl.trim() ? { snippetsUrl: value.snippetsUrl } : {}),
    ...(value.packageUrls && typeof value.packageUrls === 'object' && !Array.isArray(value.packageUrls)
      ? {
          packageUrls: Object.fromEntries(
            Object.entries(value.packageUrls).map(([name, url]) => {
              if (!name.trim() || typeof url !== 'string' || !url.trim()) {
                throw new Error('Python worker runtimeAssets.packageUrls must contain non-empty names and URLs.');
              }
              return [name, url];
            })
          ),
        }
      : {}),
  };
  if (normalized.loaderUrl && !normalized.indexUrl) {
    throw new Error('Python worker runtimeAssets.indexUrl is required when loaderUrl is configured.');
  }
  if (
    loaderFormat === 'module' &&
    (!normalized.loaderUrl || !normalized.indexUrl || !normalized.runtimeCoreUrl || !normalized.snippetsUrl)
  ) {
    throw new Error(
      'Module Python workers require consumer-supplied loaderUrl, indexUrl, runtimeCoreUrl, and snippetsUrl assets.'
    );
  }
  const signature = JSON.stringify(normalized);
  if (configuredPythonRuntimeAssetsSignature && configuredPythonRuntimeAssetsSignature !== signature) {
    throw new Error('Python runtime assets cannot be changed after the worker has been configured.');
  }
  configuredPythonRuntimeAssets = normalized;
  configuredPythonRuntimeAssetsSignature = signature;

  if (
    loaderFormat === 'classic-script' &&
    normalized.snippetsUrl &&
    !configuredPythonSnippetsLoaded &&
    typeof importScripts === 'function'
  ) {
    importScripts(normalized.snippetsUrl);
    configuredPythonSnippetsLoaded = true;
  }
}

let pyodide = null;
let isLoading = false;
let loadPromise = null;
let pythonPackageLoadPromise = null;
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
    component: 'PythonWorker',
    runtime: 'python',
    phase,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

// Interview mode runtime guard defaults. These are intentionally coarse
// safeguards to stop runaway executions without exposing internals.
const INTERVIEW_GUARD_DEFAULTS = Object.freeze({
  maxLineEvents: 400000,
  maxSingleLineHits: 150000,
  maxCallDepth: 2000,
  maxMemoryBytes: 96 * 1024 * 1024, // 96 MB
  memoryCheckEvery: 200,
});
const PROJECT_MAX_OUTPUT_STREAM_BYTES = 1024 * 1024;
const PROJECT_MAX_LIVE_FILE_CHANGES = 1024;
const PROJECT_MAX_LIVE_FILE_CHANGE_BYTES = 4 * 1024 * 1024;
const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';
const TRACE_EVENT_TRANSFER_DEFAULT_CHUNK_BYTES = 64 * 1024;
const TRACE_EVENT_TRANSFER_MAX_CHUNK_BYTES = 256 * 1024;
const TRACE_EVENT_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
const TRACE_EVENT_TRANSFER_MIN_EVENTS = 128;

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
  const payload = path === 'trace.events'
    ? { ...result, trace: { ...result.trace, events: [] } }
    : { ...result, events: [] };
  payload.__traceEventTransport = {
    schema: TRACE_EVENT_TRANSFER_SCHEMA,
    encoding: 'json-utf8',
    path,
    eventCount: events.length,
    byteLength: encoded.byteLength,
    chunks,
  };
  return { payload, transfer: chunks };
}

function postTraceResultMessage(id, protocolToken, result, request, path) {
  const transported = prepareTraceEventTransfer(result, request, path);
  if (!transported) {
    trustedPythonWorkerPostMessage({ id, type: 'execute-result', payload: result, protocolToken });
    return;
  }
  trustedPythonWorkerPostMessage(
    { id, type: 'execute-result', payload: transported.payload, protocolToken },
    transported.transfer
  );
}

function projectUtf8Bytes(value) {
  let bytes = 0;
  for (const char of String(value ?? '')) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
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

function createProjectEventBudget() {
  const outputBytes = { stdout: 0, stderr: 0 };
  const truncatedOutputStreams = new Set();
  let liveFileChangeCount = 0;
  let liveFileChangeBytes = 0;
  let warnedLiveFileBudget = false;

  return {
    apply(event) {
      if (!event || typeof event !== 'object') return event;

      if (
        event.type === 'output' &&
        (event.stream === 'stdout' || event.stream === 'stderr') &&
        typeof event.data === 'string'
      ) {
        if (truncatedOutputStreams.has(event.stream)) return null;
        const used = outputBytes[event.stream];
        const remaining = PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
        const bytes = projectUtf8Bytes(event.data);
        if (bytes <= remaining) {
          outputBytes[event.stream] = used + bytes;
          return event;
        }

        truncatedOutputStreams.add(event.stream);
        const marker = `\n[${event.stream} output truncated after ${PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
        const data = `${projectTruncateUtf8(event.data, Math.max(0, remaining))}${marker}`;
        outputBytes[event.stream] = PROJECT_MAX_OUTPUT_STREAM_BYTES + projectUtf8Bytes(marker);
        return data ? { ...event, data } : null;
      }

      if (event.type === 'file-change' && (event.phase ?? 'live') === 'live') {
        liveFileChangeCount += 1;
        const size = projectFileChangeByteSize(event.change);
        const overBudget =
          liveFileChangeCount > PROJECT_MAX_LIVE_FILE_CHANGES ||
          size > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES ||
          liveFileChangeBytes + size > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES;
        if (overBudget) {
          if (!warnedLiveFileBudget) {
            warnedLiveFileBudget = true;
            emitRuntimeDiagnostic('warn', 'project-event-budget', 'Dropped oversized Python live file-change event.', {
              count: liveFileChangeCount,
              bytes: liveFileChangeBytes,
              eventBytes: size,
            });
          }
          return null;
        }
        liveFileChangeBytes += size;
      }

      return event;
    },
  };
}

async function ensurePythonLibraryPackages(runtime) {
  if (!runtime || typeof runtime.loadPackage !== 'function') return;
  if (!pythonPackageLoadPromise) {
    const configuredPackages = configuredPythonRuntimeAssets?.packageUrls
      ? Object.values(configuredPythonRuntimeAssets.packageUrls)
      : [];
    if (configuredPackages.length === 0) return;
    pythonPackageLoadPromise = (async () => {
      const loadedPackageData = await runtime.loadPackage(configuredPackages);
      // Pyodide intentionally logs individual download/install failures instead
      // of rejecting loadPackage(). A consumer-declared package list is an
      // authoritative startup contract, so verify that every requested wheel
      // was actually installed before declaring the worker healthy.
      const normalizeChannel = (value) => {
        try {
          return new URL(String(value), self.location?.href).href;
        } catch {
          return String(value);
        }
      };
      const loadedChannels = new Set(
        Object.values(runtime.loadedPackages ?? {}).map((value) => normalizeChannel(value))
      );
      const loadedFileNames = new Set(
        (Array.isArray(loadedPackageData) ? loadedPackageData : [])
          .map((entry) => entry?.fileName ?? entry?.file_name)
          .filter((value) => typeof value === 'string' && value.length > 0)
      );
      const missingPackages = configuredPackages.filter((packageUrl) => {
        const normalizedUrl = normalizeChannel(packageUrl);
        if (loadedChannels.has(normalizedUrl)) return false;
        try {
          const fileName = decodeURIComponent(new URL(normalizedUrl).pathname.split('/').pop() ?? '');
          return !loadedFileNames.has(fileName);
        } catch {
          return true;
        }
      });
      if (missingPackages.length > 0) {
        throw new Error(`Failed to preload configured Python packages: ${missingPackages.join(', ')}`);
      }
    })().catch((error) => {
      pythonPackageLoadPromise = null;
      const message = error instanceof Error ? error.message : String(error);
      emitRuntimeDiagnostic('error', 'package-preload-failed', 'Failed to preload configured Python packages.', {
        message,
      });
      throw error;
    });
  }
  await pythonPackageLoadPromise;
}

// Load generated shared harness snippets when available. Keep worker startup
// resilient by falling back to embedded implementations if this import fails.
if (DECLARED_PYTHON_WORKER_FORMAT === 'classic' && typeof importScripts === 'function') {
  for (const scriptPath of SHARED_KERNEL_POLICY_CLASSIC_PATHS) {
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

  for (const scriptPath of GENERATED_HARNESS_SNIPPETS_PATHS) {
    try {
      importScripts(scriptPath);
      if (CONFIGURED_PYTHON_SNIPPETS_BOOTSTRAP_URL) configuredPythonSnippetsLoaded = true;
      emitRuntimeDiagnostic('info', 'generated-snippets-loaded', 'Loaded generated harness snippets.', { scriptPath });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (CONFIGURED_PYTHON_SNIPPETS_BOOTSTRAP_URL) {
        throw new Error(`Configured Python harness snippets failed to load: ${message}`);
      }
      emitRuntimeDiagnostic('warn', 'generated-snippets-load-failed', 'Failed to load generated harness snippets.', {
        scriptPath,
        message,
      });
    }
  }

  capturePythonUserAuthorityLockdown();
}

/**
 * Convert a JavaScript value to a Python literal string.
 * Prefer the generated shared implementation when available.
 */
function fallbackToPythonLiteral(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return 'None';
    seen.add(value);
    try {
      return '[' + value.map((item) => fallbackToPythonLiteral(item, seen)).join(', ') + ']';
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return 'None';
    seen.add(value);
    try {
      const entries = Object.entries(value)
        .map(([k, v]) => `${JSON.stringify(k)}: ${fallbackToPythonLiteral(v, seen)}`)
        .join(', ');
      return '{' + entries + '}';
    } finally {
      seen.delete(value);
    }
  }
  return JSON.stringify(value);
}

function toPythonLiteral(value) {
  const configuredImplementation =
    typeof self !== 'undefined' && typeof self.__TRACECODE_toPythonLiteral === 'function'
      ? self.__TRACECODE_toPythonLiteral
      : fallbackToPythonLiteral;
  return configuredImplementation(value);
}

function resolveSharedPythonSnippet(key, fallback) {
  const sharedHarnessSnippets =
    typeof self !== 'undefined' &&
    self.__TRACECODE_PYTHON_HARNESS__ &&
    typeof self.__TRACECODE_PYTHON_HARNESS__ === 'object'
      ? self.__TRACECODE_PYTHON_HARNESS__
      : null;
  if (!sharedHarnessSnippets) return fallback;
  const candidate = sharedHarnessSnippets[key];
  return typeof candidate === 'string' ? candidate : fallback;
}

const PYTHON_CLASS_DEFINITIONS_SNIPPET = resolveSharedPythonSnippet(
  'PYTHON_CLASS_DEFINITIONS',
  `
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.value = val
        self.left = left
        self.right = right
    def __getitem__(self, key):
        if key == 'val': return getattr(self, 'val', getattr(self, 'value', None))
        if key == 'value': return getattr(self, 'value', getattr(self, 'val', None))
        if key == 'left': return self.left
        if key == 'right': return self.right
        raise KeyError(key)
    def get(self, key, default=None):
        if key == 'val': return getattr(self, 'val', getattr(self, 'value', default))
        if key == 'value': return getattr(self, 'value', getattr(self, 'val', default))
        if key == 'left': return self.left
        if key == 'right': return self.right
        return default
    def __repr__(self):
        return f"TreeNode({getattr(self, 'val', getattr(self, 'value', None))})"

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.value = val
        self.next = next
    def __getitem__(self, key):
        if key == 'val': return getattr(self, 'val', getattr(self, 'value', None))
        if key == 'value': return getattr(self, 'value', getattr(self, 'val', None))
        if key == 'next': return self.next
        raise KeyError(key)
    def get(self, key, default=None):
        if key == 'val': return getattr(self, 'val', getattr(self, 'value', default))
        if key == 'value': return getattr(self, 'value', getattr(self, 'val', default))
        if key == 'next': return self.next
        return default
    def __repr__(self):
        return f"ListNode({getattr(self, 'val', getattr(self, 'value', None))})"
`
);

const PYTHON_CONVERSION_HELPERS_SNIPPET = resolveSharedPythonSnippet(
  'PYTHON_CONVERSION_HELPERS',
  `
def _ensure_node_value_aliases(node):
    if node is None:
        return node
    try:
        has_val = hasattr(node, 'val')
        has_value = hasattr(node, 'value')
        if has_value and not has_val:
            try:
                setattr(node, 'val', getattr(node, 'value'))
            except Exception:
                pass
        elif has_val and not has_value:
            try:
                setattr(node, 'value', getattr(node, 'val'))
            except Exception:
                pass
    except Exception:
        pass
    return node

def _dict_to_tree(d):
    if d is None:
        return None
    if not isinstance(d, _builtins.dict):
        return d
    if 'val' not in d and 'value' not in d:
        return d
    node = TreeNode(d.get('val', d.get('value', 0)))
    _ensure_node_value_aliases(node)
    node.left = _dict_to_tree(d.get('left'))
    node.right = _dict_to_tree(d.get('right'))
    return node

def _dict_to_list(d, _refs=None):
    if _refs is None:
        _refs = {}
    if d is None:
        return None
    if not isinstance(d, _builtins.dict):
        return d
    if '__ref__' in d:
        return _refs.get(d.get('__ref__'))
    if 'val' not in d and 'value' not in d:
        return d
    node = ListNode(d.get('val', d.get('value', 0)))
    _ensure_node_value_aliases(node)
    node_id = d.get('__id__')
    if isinstance(node_id, _builtins.str) and node_id:
        _refs[node_id] = node
    node.next = _dict_to_list(d.get('next'), _refs)
    return node
`
);

const PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET = resolveSharedPythonSnippet(
  'PYTHON_TRACE_SERIALIZE_FUNCTION',
  `
# Sentinel to mark skipped values (functions, etc.) - distinct from None
_SKIP_SENTINEL = "__TRACECODE_SKIP__"
_MAX_SERIALIZE_DEPTH = 48
_MAX_SERIALIZED_ITEMS = 64
_MAX_OBJECT_FIELDS = 32
_tracecode_global_object_refs = {}
_tracecode_next_object_ref_id = 0

def _tracecode_ref_id(obj_ref, node_refs):
    global _tracecode_next_object_ref_id
    if obj_ref in node_refs:
        return node_refs[obj_ref]
    if obj_ref in _tracecode_global_object_refs:
        node_id = _tracecode_global_object_refs[obj_ref]
    else:
        node_id = f"ref-{_tracecode_next_object_ref_id}"
        _tracecode_global_object_refs[obj_ref] = node_id
        _tracecode_next_object_ref_id += 1
    node_refs[obj_ref] = node_id
    return node_id

def _truncation_marker(total, emitted):
    return {"__truncated__": True, "remaining": max(0, total - emitted)}

def _serialize_repr_fallback(obj, node_refs=None):
    obj_type = getattr(obj, '__class__', None)
    class_name = getattr(obj_type, '__name__', 'object')
    if getattr(obj_type, '__module__', '') == 'builtins':
        try:
            repr_str = repr(obj)
        except Exception:
            return _SKIP_SENTINEL
        if repr_str.startswith('<') and repr_str.endswith('>'):
            return _SKIP_SENTINEL
        return repr_str
    if node_refs is None:
        return {"__type__": class_name, "__class__": class_name}
    obj_ref = _builtins.id(obj)
    if obj_ref in node_refs:
        return {"__ref__": node_refs[obj_ref]}
    node_id = _tracecode_ref_id(obj_ref, node_refs)
    return {"__type__": class_name, "__class__": class_name, "__id__": node_id}

def _serialize_sequence(values, depth, node_refs):
    values_list = _builtins.list(values)
    emitted = min(len(values_list), _MAX_SERIALIZED_ITEMS)
    result = [_serialize(x, depth + 1, node_refs) for x in values_list[:emitted]]
    if emitted < len(values_list):
        result.append(_truncation_marker(len(values_list), emitted))
    return result

def _serialize(obj, depth=0, node_refs=None):
    if node_refs is None:
        node_refs = {}
    if isinstance(obj, (bool, int, str, type(None))):
        return obj
    elif isinstance(obj, float):
        if not math.isfinite(obj):
            if math.isnan(obj):
                return "NaN"
            return "Infinity" if obj > 0 else "-Infinity"
        return obj
    if depth > _MAX_SERIALIZE_DEPTH:
        return "<max depth>"
    elif isinstance(obj, (_builtins.list, _builtins.tuple)):
        return _serialize_sequence(obj, depth, node_refs)
    elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':
        return _serialize_sequence(obj, depth, node_refs)
    elif isinstance(obj, _builtins.dict):
        items = _builtins.list(obj.items())
        emitted = min(len(items), _MAX_SERIALIZED_ITEMS)
        result = {str(k): _serialize(v, depth + 1, node_refs) for k, v in items[:emitted]}
        if emitted < len(items):
            result["__truncated__"] = True
            result["remaining"] = len(items) - emitted
        return result
    elif isinstance(obj, set):
        # Use try/except for sorting to handle heterogeneous sets
        values = _builtins.list(obj)
        emitted = min(len(values), _MAX_SERIALIZED_ITEMS)
        try:
            sorted_vals = sorted([_serialize(x, depth + 1, node_refs) for x in values[:emitted]])
        except TypeError:
            sorted_vals = [_serialize(x, depth + 1, node_refs) for x in values[:emitted]]
        result = {"__type__": "set", "values": sorted_vals}
        if emitted < len(values):
            result["__truncated__"] = True
            result["remaining"] = len(values) - emitted
        return result
    elif isinstance(obj, TreeNode):
        obj_ref = _builtins.id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = _tracecode_ref_id(obj_ref, node_refs)
        result = {
            "__type__": "TreeNode",
            "__id__": node_id,
            "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1, node_refs),
        }
        if hasattr(obj, 'left'):
            result["left"] = _serialize(obj.left, depth + 1, node_refs)
        if hasattr(obj, 'right'):
            result["right"] = _serialize(obj.right, depth + 1, node_refs)
        return result
    elif isinstance(obj, ListNode):
        obj_ref = _builtins.id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = _tracecode_ref_id(obj_ref, node_refs)
        result = {
            "__type__": "ListNode",
            "__id__": node_id,
            "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1, node_refs),
        }
        result["next"] = _serialize(obj.next, depth + 1, node_refs)
        return result
    elif callable(obj):
        # Skip functions entirely - return sentinel
        return _SKIP_SENTINEL
    elif hasattr(obj, '__dict__'):
        obj_ref = _builtins.id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = _tracecode_ref_id(obj_ref, node_refs)
        class_name = getattr(getattr(obj, '__class__', None), '__name__', 'object')
        result = {
            "__type__": class_name,
            "__class__": class_name,
            "__id__": node_id,
        }
        try:
            raw_fields = getattr(obj, '__dict__', None)
        except Exception:
            raw_fields = None
        if isinstance(raw_fields, _builtins.dict):
            fields = []
            for key, value in raw_fields.items():
                key_str = str(key)
                if key_str.startswith('_'):
                    continue
                if callable(value):
                    continue
                fields.append((key_str, value))
            for key_str, value in fields[:_MAX_OBJECT_FIELDS]:
                result[key_str] = _serialize(value, depth + 1, node_refs)
            if len(fields) > _MAX_OBJECT_FIELDS:
                result["__truncated__"] = True
                result["remaining"] = len(fields) - _MAX_OBJECT_FIELDS
        return result
    else:
        return _serialize_repr_fallback(obj, node_refs)

def _serialize_output(obj, depth=0, node_refs=None):
    if node_refs is None:
        node_refs = {}
    if isinstance(obj, (bool, int, str, type(None))):
        return obj
    elif isinstance(obj, float):
        if not math.isfinite(obj):
            if math.isnan(obj):
                return "NaN"
            return "Infinity" if obj > 0 else "-Infinity"
        return obj
    if depth > _MAX_SERIALIZE_DEPTH:
        return "<max depth>"
    elif isinstance(obj, (_builtins.list, _builtins.tuple)):
        return [_serialize_output(x, depth + 1, node_refs) for x in obj]
    elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':
        return [_serialize_output(x, depth + 1, node_refs) for x in obj]
    elif isinstance(obj, _builtins.dict):
        return {str(k): _serialize_output(v, depth + 1, node_refs) for k, v in obj.items()}
    elif isinstance(obj, set):
        try:
            sorted_vals = sorted([_serialize_output(x, depth + 1, node_refs) for x in obj])
        except TypeError:
            sorted_vals = [_serialize_output(x, depth + 1, node_refs) for x in obj]
        return {"__type__": "set", "values": sorted_vals}
    elif isinstance(obj, TreeNode):
        obj_ref = _builtins.id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = _tracecode_ref_id(obj_ref, node_refs)
        result = {
            "__type__": "TreeNode",
            "__id__": node_id,
            "val": _serialize_output(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1, node_refs),
        }
        if hasattr(obj, 'left'):
            result["left"] = _serialize_output(obj.left, depth + 1, node_refs)
        if hasattr(obj, 'right'):
            result["right"] = _serialize_output(obj.right, depth + 1, node_refs)
        return result
    elif isinstance(obj, ListNode):
        obj_ref = _builtins.id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = _tracecode_ref_id(obj_ref, node_refs)
        result = {
            "__type__": "ListNode",
            "__id__": node_id,
            "val": _serialize_output(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1, node_refs),
        }
        result["next"] = _serialize_output(obj.next, depth + 1, node_refs)
        return result
    elif callable(obj):
        return _SKIP_SENTINEL
    elif hasattr(obj, '__dict__'):
        obj_ref = _builtins.id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = _tracecode_ref_id(obj_ref, node_refs)
        class_name = getattr(getattr(obj, '__class__', None), '__name__', 'object')
        result = {
            "__type__": class_name,
            "__class__": class_name,
            "__id__": node_id,
        }
        try:
            raw_fields = getattr(obj, '__dict__', None)
        except Exception:
            raw_fields = None
        if isinstance(raw_fields, _builtins.dict):
            for key, value in raw_fields.items():
                key_str = str(key)
                if key_str.startswith('_') or callable(value):
                    continue
                result[key_str] = _serialize_output(value, depth + 1, node_refs)
        return result
    else:
        return _serialize_repr_fallback(obj, node_refs)
`
);

const PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET = resolveSharedPythonSnippet(
  'PYTHON_EXECUTE_SERIALIZE_FUNCTION',
  `
_MAX_SERIALIZE_DEPTH = 48

def _serialize_repr_fallback(obj):
    obj_type = getattr(obj, '__class__', None)
    class_name = getattr(obj_type, '__name__', 'object')
    if getattr(obj_type, '__module__', '') == 'builtins':
        try:
            repr_str = repr(obj)
        except Exception:
            return None
        if repr_str.startswith('<') and repr_str.endswith('>'):
            return None
        return repr_str
    return {"__type__": class_name, "__class__": class_name}

def _serialize(obj, depth=0):
    if isinstance(obj, (bool, int, str, type(None))):
        return obj
    elif isinstance(obj, float):
        if not math.isfinite(obj):
            if math.isnan(obj):
                return "NaN"
            return "Infinity" if obj > 0 else "-Infinity"
        return obj
    if depth > _MAX_SERIALIZE_DEPTH:
        return "<max depth>"
    elif isinstance(obj, (_builtins.list, _builtins.tuple)):
        return [_serialize(x, depth + 1) for x in obj]
    elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':
        return [_serialize(x, depth + 1) for x in obj]
    elif isinstance(obj, _builtins.dict):
        return {str(k): _serialize(v, depth + 1) for k, v in obj.items()}
    elif isinstance(obj, set):
        try:
            return {"__type__": "set", "values": sorted([_serialize(x, depth + 1) for x in obj])}
        except TypeError:
            return {"__type__": "set", "values": [_serialize(x, depth + 1) for x in obj]}
    elif isinstance(obj, TreeNode):
        result = {"__type__": "TreeNode", "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1)}
        if hasattr(obj, 'left'):
            result["left"] = _serialize(obj.left, depth + 1)
        if hasattr(obj, 'right'):
            result["right"] = _serialize(obj.right, depth + 1)
        return result
    elif isinstance(obj, ListNode):
        result = {"__type__": "ListNode", "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1)}
        result["next"] = _serialize(obj.next, depth + 1)
        return result
    elif callable(obj):
        return None
    elif hasattr(obj, '__dict__'):
        class_name = getattr(getattr(obj, '__class__', None), '__name__', 'object')
        result = {"__type__": class_name, "__class__": class_name}
        try:
            raw_fields = getattr(obj, '__dict__', None)
        except Exception:
            raw_fields = None
        if isinstance(raw_fields, _builtins.dict):
            for key, value in raw_fields.items():
                key_str = str(key)
                if key_str.startswith('_') or callable(value):
                    continue
                result[key_str] = _serialize(value, depth + 1)
        return result
    else:
        return _serialize_repr_fallback(obj)
`
);

function resolvePythonWorkerAssetUrl(value) {
  return new URL(value, self.location.href).href;
}

async function importPythonWorkerModule(url, label) {
  try {
    return await import(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to import Python ${label} module from ${url}: ${message}`);
  }
}

async function importPythonWorkerModuleCandidates(paths, label) {
  const errors = [];
  for (const path of paths) {
    const url = resolvePythonWorkerAssetUrl(path);
    try {
      return { module: await import(url), url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${url} (${message})`);
    }
  }
  throw new Error(`Failed to import Python ${label} module. Tried: ${errors.join(' | ')}`);
}

function installPythonSharedKernelPolicy(policy, scriptPath) {
  if (!self.TraceRuntimeKernelPolicy) {
    Object.defineProperty(self, 'TraceRuntimeKernelPolicy', {
      configurable: false,
      value: Object.freeze({ ...policy }),
    });
  }
  if (typeof self.TraceRuntimeKernelPolicy?.withRuntimeUserAuthorityLockdown !== 'function') {
    throw new Error(`Python shared kernel policy ${scriptPath} does not export the user authority lockdown.`);
  }
  capturePythonUserAuthorityLockdown();
}

/**
 * Load the module-worker bootstrap graph after the consumer manifest has been
 * received. Keeping this behind the ordered init message lets the same worker
 * source remain valid for the legacy classic worker path.
 */
async function ensurePythonModuleBootstrap() {
  if (DECLARED_PYTHON_WORKER_FORMAT !== 'module') return;
  if (pythonModuleBootstrapPromise) return pythonModuleBootstrapPromise;

  pythonModuleBootstrapPromise = (async () => {
    const assets = configuredPythonRuntimeAssets;
    if (!assets || assets.loaderFormat !== 'module') {
      throw new Error('Module Python worker bootstrap requires a module runtime asset configuration.');
    }

    const loaderUrl = resolvePythonWorkerAssetUrl(assets.loaderUrl);
    const runtimeCoreUrl = resolvePythonWorkerAssetUrl(assets.runtimeCoreUrl);
    const snippetsUrl = resolvePythonWorkerAssetUrl(assets.snippetsUrl);
    const [loaderModule, , , sharedPolicyModule] = await Promise.all([
      importPythonWorkerModule(loaderUrl, 'runtime loader'),
      importPythonWorkerModule(runtimeCoreUrl, 'runtime core'),
      importPythonWorkerModule(snippetsUrl, 'harness snippets'),
      importPythonWorkerModuleCandidates(SHARED_KERNEL_POLICY_MODULE_PATHS, 'shared kernel policy'),
    ]);
    const sharedPolicyUrl = sharedPolicyModule.url;
    installPythonSharedKernelPolicy(sharedPolicyModule.module, sharedPolicyUrl);

    const loadPyodideExport =
      typeof loaderModule?.loadPyodide === 'function'
        ? loaderModule.loadPyodide
        : typeof loaderModule?.default?.loadPyodide === 'function'
          ? loaderModule.default.loadPyodide
          : null;
    if (!loadPyodideExport) {
      throw new Error(`Python runtime loader module ${loaderUrl} does not export loadPyodide().`);
    }
    if (!self.__TRACECODE_PYODIDE_RUNTIME__ || typeof self.__TRACECODE_PYODIDE_RUNTIME__ !== 'object') {
      throw new Error(`Python runtime core module ${runtimeCoreUrl} did not register its runtime API.`);
    }
    if (!self.__TRACECODE_PYTHON_HARNESS__ || typeof self.__TRACECODE_PYTHON_HARNESS__ !== 'object') {
      throw new Error(`Python harness snippets module ${snippetsUrl} did not register its snippet API.`);
    }
    if (!self.TraceRuntimeKernelPolicy || typeof self.TraceRuntimeKernelPolicy !== 'object') {
      throw new Error(`Python shared kernel policy module ${sharedPolicyUrl} did not register its policy API.`);
    }

    moduleLoadPyodide = loadPyodideExport;
    configuredPythonSnippetsLoaded = true;
    emitRuntimeDiagnostic('info', 'module-bootstrap-loaded', 'Loaded Python module-worker bootstrap graph.', {
      loaderUrl,
      runtimeCoreUrl,
      snippetsUrl,
      sharedPolicyUrl,
    });
  })().catch((error) => {
    pythonModuleBootstrapPromise = null;
    throw error;
  });

  return pythonModuleBootstrapPromise;
}

/**
 * Load Pyodide
 */
async function loadPyodideInstance() {
  if (pyodide) {
    await ensurePythonLibraryPackages(pyodide);
    return pyodide;
  }
  if (loadPromise) return loadPromise;

  isLoading = true;

  loadPromise = (async () => {
    try {
      if (DECLARED_PYTHON_WORKER_FORMAT === 'module') {
        await ensurePythonModuleBootstrap();
        if (typeof moduleLoadPyodide !== 'function') {
          throw new Error('Python module runtime loader is unavailable after bootstrap.');
        }
        const indexURL = configuredPythonRuntimeAssets.indexUrl;
        pyodide = await moduleLoadPyodide({ indexURL });
        await ensurePythonLibraryPackages(pyodide);
        emitRuntimeDiagnostic('info', 'runtime-initialized', 'Initialized Python module runtime.', { indexURL });
        return pyodide;
      }

      const bootstrapErrors = [];

      const configuredLoaderUrl = configuredPythonRuntimeAssets?.loaderUrl;
      const configuredIndexUrl = configuredPythonRuntimeAssets?.indexUrl;
      const runtimeCandidates = configuredLoaderUrl && configuredIndexUrl
        ? [{ loaderUrl: configuredLoaderUrl, indexURL: configuredIndexUrl }]
        : PYODIDE_INDEX_URLS.map((indexURL) => ({ loaderUrl: `${indexURL}pyodide.js`, indexURL }));

      if (typeof self.loadPyodide !== 'function') {
        let loadedBootstrap = false;

        for (const candidate of runtimeCandidates) {
          try {
            importScripts(candidate.loaderUrl);
            loadedBootstrap = true;
            emitRuntimeDiagnostic('info', 'bootstrap-loaded', 'Loaded Python runtime bootstrap script.', candidate);
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            bootstrapErrors.push(`${candidate.loaderUrl} (${message})`);
          }
        }

        if (!loadedBootstrap || typeof self.loadPyodide !== 'function') {
          throw new Error(
            `Unable to load Pyodide bootstrap script. Tried: ${bootstrapErrors.join(' | ')}`
          );
        }
      }

      const initErrors = [];
      for (const { indexURL } of runtimeCandidates) {
        try {
          pyodide = await self.loadPyodide({ indexURL });
          await ensurePythonLibraryPackages(pyodide);
          emitRuntimeDiagnostic('info', 'runtime-initialized', 'Initialized Python runtime.', { indexURL });
          return pyodide;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          initErrors.push(`${indexURL} (${message})`);
        }
      }

      throw new Error(`Unable to initialize Pyodide runtime. Tried: ${initErrors.join(' | ')}`);
    } catch (error) {
      // A partially initialized interpreter must never turn a failed explicit
      // package contract into a healthy retry. The client can retire this
      // worker and create a clean runtime after correcting its manifest.
      pyodide = null;
      pythonPackageLoadPromise = null;
      loadPromise = null;
      throw error;
    } finally {
      isLoading = false;
    }
  })();

  return loadPromise;
}


const PYODIDE_RUNTIME_CORE_PATHS = [
  './pyodide/runtime-core.js',
];

let pyodideRuntimeCore = null;
let pyodideRuntimeCoreLoadAttempted = false;

function loadPyodideRuntimeCore() {
  if (pyodideRuntimeCore) return pyodideRuntimeCore;

  if (!pyodideRuntimeCoreLoadAttempted) {
    pyodideRuntimeCoreLoadAttempted = true;

    if (DECLARED_PYTHON_WORKER_FORMAT === 'classic' && typeof importScripts === 'function') {
      const runtimeCorePaths = configuredPythonRuntimeAssets?.runtimeCoreUrl
        ? [configuredPythonRuntimeAssets.runtimeCoreUrl]
        : PYODIDE_RUNTIME_CORE_PATHS;
      for (const scriptPath of runtimeCorePaths) {
        try {
          importScripts(scriptPath);
          emitRuntimeDiagnostic('info', 'runtime-core-loaded', 'Loaded Python runtime core.', { scriptPath });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitRuntimeDiagnostic('warn', 'runtime-core-load-failed', 'Failed to load Python runtime core.', {
            scriptPath,
            message,
          });
        }
      }
    }
  }

  const runtime =
    typeof self !== 'undefined' &&
    self.__TRACECODE_PYODIDE_RUNTIME__ &&
    typeof self.__TRACECODE_PYODIDE_RUNTIME__ === 'object'
      ? self.__TRACECODE_PYODIDE_RUNTIME__
      : null;

  if (!runtime) {
    throw new Error('Pyodide runtime core failed to load');
  }

  pyodideRuntimeCore = runtime;
  return pyodideRuntimeCore;
}

function capturePythonUserAuthorityLockdown() {
  if (trustedPythonUserAuthorityLockdown) return;
  const lockdown = self.TraceRuntimeKernelPolicy?.withRuntimeUserAuthorityLockdown;
  if (typeof lockdown !== 'function') {
    throw new Error('Python user execution requires the shared runtime authority lockdown policy.');
  }
  trustedPythonUserAuthorityLockdown = lockdown;
}

function withPythonUserAuthorityLockdown(callback, mode = 'temporary') {
  if (typeof trustedPythonUserAuthorityLockdown !== 'function') {
    throw new Error('Python user execution requires the captured runtime authority lockdown policy.');
  }
  if (mode !== 'temporary' && mode !== 'permanent') {
    throw new Error(`Unsupported Python user authority mode: ${String(mode)}.`);
  }
  return trustedPythonUserAuthorityLockdown(callback, { scope: self, mode });
}

function buildRuntimeDeps() {
  return {
    toPythonLiteral,
    PYTHON_CLASS_DEFINITIONS_SNIPPET: resolveSharedPythonSnippet(
      'PYTHON_CLASS_DEFINITIONS',
      PYTHON_CLASS_DEFINITIONS_SNIPPET
    ),
    PYTHON_CONVERSION_HELPERS_SNIPPET: resolveSharedPythonSnippet(
      'PYTHON_CONVERSION_HELPERS',
      PYTHON_CONVERSION_HELPERS_SNIPPET
    ),
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: resolveSharedPythonSnippet(
      'PYTHON_TRACE_SERIALIZE_FUNCTION',
      PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET
    ),
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: resolveSharedPythonSnippet(
      'PYTHON_EXECUTE_SERIALIZE_FUNCTION',
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET
    ),
    INTERVIEW_GUARD_DEFAULTS,
    pythonCompileCacheLimit,
    loadPyodideInstance,
    getPyodide: () => pyodide,
    performanceNow: () => performance.now(),
  };
}

/**
 * Generate the tracing wrapper code for step-by-step execution.
 * Delegates to the runtime core module.
 */
function generateTracingCode(userCode, functionName, inputs, executionStyle = 'function', options = {}) {
  return loadPyodideRuntimeCore().generateTracingCode(
    buildRuntimeDeps(),
    userCode,
    functionName,
    inputs,
    executionStyle,
    options
  );
}

/**
 * Parse Python error message.
 * Delegates to the runtime core module.
 */
function parsePythonError(rawError, userCodeStartLine, userCodeLineCount) {
  return loadPyodideRuntimeCore().parsePythonError(rawError, userCodeStartLine, userCodeLineCount);
}

/**
 * Execute Python code with tracing.
 * Delegates to the runtime core module.
 */
async function executeWithTracing(code, functionName, inputs, executionStyle = 'function', options = {}) {
  await loadPyodideInstance();
  const runtimeCore = loadPyodideRuntimeCore();
  return withPythonUserAuthorityLockdown(() =>
    runtimeCore.executeWithTracing(
      buildRuntimeDeps(),
      code,
      functionName,
      inputs,
      executionStyle,
      options
    )
  );
}

/**
 * Execute Python code without tracing (for running tests).
 * Delegates to the runtime core module.
 */
async function executeCode(code, functionName, inputs, executionStyle = 'function', options = {}) {
  await loadPyodideInstance();
  const runtimeCore = loadPyodideRuntimeCore();
  return withPythonUserAuthorityLockdown(() =>
    runtimeCore.executeCode(
      buildRuntimeDeps(),
      code,
      functionName,
      inputs,
      executionStyle,
      options
    )
  );
}

function normalizePyodideFsProjectPath(path) {
  if (typeof path !== 'string' || !path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function normalizePyodideFsAbsolutePath(path, basePath = '/') {
  if (typeof path !== 'string' || !path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  const normalizedBase = typeof basePath === 'string' && basePath
    ? basePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
    : '';
  const absolutePath = normalized.startsWith('/')
    ? normalized
    : `${normalizedBase || ''}/${normalized}`;
  const parts = [];
  for (const part of absolutePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function installPyodideProjectFsMutationEvents(projectRoot, kernelDevices) {
  const fs = pyodide?.FS;
  const normalizedRoot = normalizePyodideFsAbsolutePath(projectRoot);
  if (!fs || !normalizedRoot || typeof self.__tracecodeProjectEvent !== 'function') {
    return () => {};
  }

  const patched = [];
  const textDecoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;
  const textDecoderLossy = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
  const devices = normalizeProjectKernelDevices(kernelDevices);
  const kernelPolicy = self.TraceRuntimeKernelPolicy;

  const fallbackKernelVirtualPathTarget = (path) => {
    const normalized = normalizePyodideFsAbsolutePath(path);
    if (!normalized) return { kind: 'workspace', path: '/' };
    if (normalized === '/proc' || normalized.startsWith('/proc/')) return { kind: 'proc', path: normalized };
    if (normalized === '/dev') return { kind: 'device-directory', path: normalized };
    if (normalized.startsWith('/dev/')) {
      return devices[normalized] ? { kind: 'device-file', path: normalized } : { kind: 'device-not-found', path: normalized };
    }
    return { kind: 'workspace', path: normalized };
  };

  const kernelVirtualPathTarget = (path) => {
    if (kernelPolicy && typeof kernelPolicy.runtimeKernelVirtualPathTarget === 'function') {
      return kernelPolicy.runtimeKernelVirtualPathTarget(path, { devices });
    }
    return fallbackKernelVirtualPathTarget(path);
  };

  const fallbackKernelVirtualMutationTarget = (path) => {
    const target = fallbackKernelVirtualPathTarget(path);
    if (target.kind === 'workspace') return target;
    if (target.kind === 'device-not-found') {
      return { kind: 'error', reason: 'device-not-found', path: target.path };
    }
    if (target.kind === 'proc') {
      return { kind: 'error', reason: 'proc-read-only', path: target.path };
    }
    return { kind: 'error', reason: 'device-read-only', path: target.path };
  };

  const kernelVirtualMutationTarget = (path) => {
    if (kernelPolicy && typeof kernelPolicy.runtimeKernelVirtualMutationTarget === 'function') {
      return kernelPolicy.runtimeKernelVirtualMutationTarget(path, { devices });
    }
    return fallbackKernelVirtualMutationTarget(path);
  };

  const kernelDeviceOutputTarget = (path) => {
    const target = kernelVirtualPathTarget(path);
    if (target.kind !== 'device-file') return null;
    const outputDevice = kernelPolicy && typeof kernelPolicy.runtimeKernelDeviceOutputTarget === 'function'
      ? String(kernelPolicy.runtimeKernelDeviceOutputTarget(devices, target.path) || '')
      : String(devices[target.path]?.outputDevice || '');
    return outputDevice ? { device: target.path, outputDevice } : null;
  };

  const isCreateOrTruncateOpenFlags = (flags) => {
    if (typeof flags === 'string') {
      return flags.includes('w') || flags.includes('a');
    }
    const numericFlags = Number(flags);
    if (!Number.isFinite(numericFlags)) return false;
    return Boolean(numericFlags & 64) || Boolean(numericFlags & 512);
  };

  const isWritableOpenFlags = (flags) => {
    if (typeof flags === 'string') {
      return flags.includes('w') || flags.includes('a') || flags.includes('+');
    }
    const numericFlags = Number(flags);
    if (!Number.isFinite(numericFlags)) return false;
    return Boolean(numericFlags & 1) || Boolean(numericFlags & 2) || isCreateOrTruncateOpenFlags(numericFlags);
  };

  const currentFsCwd = () => {
    if (typeof fs.cwd !== 'function') return '/';
    try {
      return normalizePyodideFsAbsolutePath(String(fs.cwd() || '/')) || '/';
    } catch {
      return '/';
    }
  };

  const resolveFsMutationPath = (path) => {
    if (typeof path === 'string') {
      const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
      const raw = normalized.startsWith('/')
        ? normalized
        : `${currentFsCwd().replace(/\/+$/, '')}/${normalized}`;
      return { raw, resolved: normalizePyodideFsAbsolutePath(raw) };
    }
    if (path && typeof fs.getPath === 'function') {
      const node = path.node || path;
      try {
        const resolved = normalizePyodideFsAbsolutePath(String(fs.getPath(node) || ''));
        return resolved ? { raw: resolved, resolved } : null;
      } catch {
        return null;
      }
    }
    return null;
  };

  const rejectKernelVirtualMutation = (candidate, operation) => {
    const path = candidate?.resolved;
    if (!path) return;
    const target = kernelVirtualMutationTarget(path);
    if (target.kind !== 'error') return;
    const error = new Error(`Kernel virtual namespace is not a provider FS mutation target: ${target.path}`);
    error.code = target.reason === 'proc-read-only' || target.reason === 'kernel-read-only' ? 'EROFS' : 'EACCES';
    error.operation = operation;
    error.path = target.path;
    throw error;
  };

  const rejectWorkspaceEscapingMutation = (path, candidate, operation) => {
    const rawPath = candidate?.raw;
    if (!rawPath || (rawPath !== normalizedRoot && !rawPath.startsWith(`${normalizedRoot}/`))) return;
    const resolvedPath = candidate?.resolved;
    if (resolvedPath === normalizedRoot || resolvedPath?.startsWith(`${normalizedRoot}/`)) return;
    const error = new Error(`Project path must stay within the workspace: ${path}`);
    error.code = 'EACCES';
    error.operation = operation;
    error.path = path;
    throw error;
  };

  const rejectProjectMutation = (path, operation) => {
    const candidate = resolveFsMutationPath(path);
    rejectWorkspaceEscapingMutation(path, candidate, operation);
    rejectKernelVirtualMutation(candidate, operation);
  };

  const relativePath = (path) => {
    const normalized = resolveFsMutationPath(path)?.resolved ?? normalizePyodideFsAbsolutePath(path);
    if (!normalized || normalized === normalizedRoot || !normalized.startsWith(`${normalizedRoot}/`)) {
      return null;
    }
    return normalized.slice(normalizedRoot.length + 1);
  };

  const emitProjectEvent = (event) => {
    try {
      self.__tracecodeProjectEvent(event);
    } catch {
      // Live mutation events are best-effort; final file diff remains authoritative.
    }
  };

  const projectOutputText = (value) => {
    if (typeof value === 'string') return value;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return textDecoderLossy ? textDecoderLossy.decode(bytes) : String.fromCharCode(...bytes);
  };

  const emitKernelDeviceWrite = (path, value) => {
    const target = kernelDeviceOutputTarget(path);
    if (!target) return false;
    const data = projectOutputText(value);
    if (target.outputDevice === '/dev/null') return true;
    if (data) {
      emitProjectEvent({
        type: 'output',
        stream: target.outputDevice === '/dev/stderr' ? 'stderr' : 'stdout',
        device: target.outputDevice,
        ...(target.device !== target.outputDevice ? { sourceDevice: target.device } : {}),
        data,
      });
    }
    return true;
  };

  const bytesToBase64 = (bytes) => {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      const chunk = bytes.subarray(index, index + 0x8000);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  };

  const pathStat = (path, follow = true) => {
    const statFn = !follow && typeof fs.lstat === 'function' ? fs.lstat : fs.stat;
    if (typeof statFn !== 'function') return null;
    try {
      return statFn.call(fs, path);
    } catch {
      return null;
    }
  };

  const isSymlinkStat = (stat) => Boolean(stat && typeof fs.isLink === 'function' && fs.isLink(stat.mode));

  const runtimeFileChange = (path) => {
    const relative = relativePath(path);
    if (!relative || typeof fs.readFile !== 'function') return null;
    try {
      const linkStat = pathStat(path, false);
      if (isSymlinkStat(linkStat)) return null;
      const stat = pathStat(path, true);
      if (stat && typeof stat.size === 'number' && stat.size > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) {
        return null;
      }
      const rawContents = fs.readFile(path, { encoding: 'binary' });
      const contents = rawContents instanceof Uint8Array ? rawContents : new Uint8Array(rawContents);
      if (contents.byteLength > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) return null;
      if (textDecoder) {
        try {
          return { path: relative, contents: textDecoder.decode(contents) };
        } catch {
          // Fall through to base64 for non-UTF-8 bytes.
        }
      }
      return { path: relative, contents: bytesToBase64(contents), encoding: 'base64' };
    } catch {
      return null;
    }
  };

  const emitFileChange = (path) => {
    const change = runtimeFileChange(path);
    if (change) {
      emitProjectEvent({ type: 'file-change', phase: 'live', change });
    }
  };

  const emitFileDelete = (path) => {
    const relative = relativePath(path);
    if (relative) {
      emitProjectEvent({ type: 'file-change', phase: 'live', change: { path: relative, deleted: true } });
    }
  };

  const emitDirectoryCreate = (path) => {
    const relative = relativePath(path);
    if (relative) {
      emitProjectEvent({ type: 'file-change', phase: 'live', change: { path: relative, directory: true } });
    }
  };

  const emitDirectoryDelete = (path) => {
    const relative = relativePath(path);
    if (relative) {
      emitProjectEvent({ type: 'file-change', phase: 'live', change: { path: relative, directory: true, deleted: true } });
    }
  };

  const isDirectoryPath = (path) => {
    if (!path || typeof fs.stat !== 'function' || typeof fs.isDir !== 'function') return false;
    try {
      return fs.isDir(fs.stat(path).mode);
    } catch {
      return false;
    }
  };

  const emitPathSnapshot = (path, budget = { count: 0 }) => {
    if (
      !path ||
      budget.count >= PROJECT_MAX_LIVE_FILE_CHANGES ||
      typeof fs.isDir !== 'function' ||
      typeof fs.isFile !== 'function'
    ) {
      return;
    }
    budget.count += 1;
    const stat = pathStat(path, false);
    if (!stat) return;
    if (isSymlinkStat(stat)) return;
    if (fs.isFile(stat.mode)) {
      emitFileChange(path);
      return;
    }
    if (!fs.isDir(stat.mode)) return;
    emitDirectoryCreate(path);
    if (typeof fs.readdir !== 'function') return;
    let entries;
    try {
      entries = fs.readdir(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === '.' || entry === '..') continue;
      emitPathSnapshot(`${String(path).replace(/\/+$/, '')}/${entry}`, budget);
      if (budget.count >= PROJECT_MAX_LIVE_FILE_CHANGES) return;
    }
  };

  const streamPath = (stream) => {
    if (!stream) return null;
    if (typeof stream.path === 'string') return stream.path;
    if (stream.node && typeof fs.getPath === 'function') {
      try {
        return fs.getPath(stream.node);
      } catch {
        return null;
      }
    }
    return null;
  };

  const patch = (name, replacement) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = replacement(original);
    patched.push([name, original]);
  };

  patch('open', (original) => function patchedOpen(path, flags, ...args) {
    const shouldEmitCreateSnapshot = isCreateOrTruncateOpenFlags(flags);
    if (isWritableOpenFlags(flags)) {
      rejectProjectMutation(path, 'open');
    }
    const stream = original.call(this, path, flags, ...args);
    if (shouldEmitCreateSnapshot) {
      emitFileChange(streamPath(stream));
    }
    return stream;
  });

  patch('write', (original) => function patchedWrite(stream, ...args) {
    const path = streamPath(stream);
    rejectProjectMutation(path, 'write');
    const result = original.call(this, stream, ...args);
    emitFileChange(path);
    return result;
  });

  patch('writeFile', (original) => function patchedWriteFile(path, ...args) {
    if (emitKernelDeviceWrite(path, args[0])) {
      return undefined;
    }
    rejectProjectMutation(path, 'writeFile');
    const result = original.call(this, path, ...args);
    emitFileChange(path);
    return result;
  });

  patch('createDataFile', (original) => function patchedCreateDataFile(parent, name, ...args) {
    const basePath = normalizePyodideFsProjectPath(parent);
    const targetPath = name === null || name === undefined || String(name) === ''
      ? basePath
      : `${String(basePath || '').replace(/\/+$/, '')}/${String(name).replace(/^\/+/, '')}`;
    rejectProjectMutation(parent, 'createDataFile');
    rejectProjectMutation(targetPath, 'createDataFile');
    const result = original.call(this, parent, name, ...args);
    emitFileChange(targetPath);
    return result;
  });

  patch('create', (original) => function patchedCreate(path, ...args) {
    rejectProjectMutation(path, 'create');
    const result = original.call(this, path, ...args);
    emitFileChange(path);
    return result;
  });

  patch('createPath', (original) => function patchedCreatePath(parent, path, ...args) {
    const basePath = normalizePyodideFsProjectPath(parent);
    const targetPath = path === null || path === undefined || String(path) === ''
      ? basePath
      : `${String(basePath || '').replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
    rejectProjectMutation(parent, 'createPath');
    rejectProjectMutation(targetPath, 'createPath');
    const result = original.call(this, parent, path, ...args);
    emitPathSnapshot(targetPath);
    return result;
  });

  patch('truncate', (original) => function patchedTruncate(path, ...args) {
    rejectProjectMutation(path, 'truncate');
    const result = original.call(this, path, ...args);
    emitFileChange(path);
    return result;
  });

  patch('ftruncate', (original) => function patchedFtruncate(fd, ...args) {
    let path = null;
    try {
      path = streamPath(fs.getStreamChecked(fd));
    } catch {
      path = null;
    }
    rejectProjectMutation(path, 'ftruncate');
    const result = original.call(this, fd, ...args);
    emitFileChange(path);
    return result;
  });

  for (const name of ['chmod', 'chown', 'utime']) {
    patch(name, (original) => function patchedPathMetadataMutation(path, ...args) {
      rejectProjectMutation(path, name);
      const result = original.call(this, path, ...args);
      emitPathSnapshot(path);
      return result;
    });
  }

  patch('unlink', (original) => function patchedUnlink(path, ...args) {
    rejectProjectMutation(path, 'unlink');
    const result = original.call(this, path, ...args);
    emitFileDelete(path);
    return result;
  });

  patch('mkdir', (original) => function patchedMkdir(path, ...args) {
    rejectProjectMutation(path, 'mkdir');
    const result = original.call(this, path, ...args);
    emitDirectoryCreate(path);
    return result;
  });

  patch('rmdir', (original) => function patchedRmdir(path, ...args) {
    rejectProjectMutation(path, 'rmdir');
    const result = original.call(this, path, ...args);
    emitDirectoryDelete(path);
    return result;
  });

  patch('rename', (original) => function patchedRename(oldPath, newPath, ...args) {
    rejectProjectMutation(oldPath, 'rename');
    rejectProjectMutation(newPath, 'rename');
    const oldIsDirectory = isDirectoryPath(oldPath);
    const result = original.call(this, oldPath, newPath, ...args);
    if (oldIsDirectory) {
      emitDirectoryDelete(oldPath);
      emitPathSnapshot(newPath);
    } else {
      emitFileDelete(oldPath);
      emitFileChange(newPath);
    }
    return result;
  });

  patch('symlink', (original) => function patchedSymlink(oldPath, newPath, ...args) {
    rejectProjectMutation(oldPath, 'symlink');
    rejectProjectMutation(newPath, 'symlink');
    if (relativePath(newPath)) {
      const error = new Error('Symbolic links are not supported by the project file manifest');
      error.code = 'ENOSYS';
      throw error;
    }
    return original.call(this, oldPath, newPath, ...args);
  });

  return () => {
    for (const [name, original] of patched.reverse()) {
      fs[name] = original;
    }
  };
}

function normalizeProjectKernelDevices(value) {
  let entries = value;
  if (typeof entries === 'string') {
    try {
      entries = JSON.parse(entries);
    } catch {
      entries = [];
    }
  }
  if (!Array.isArray(entries)) return {};

  const devices = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const path = String(entry.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!path.startsWith('/dev/')) continue;
    devices[path] = {
      readable: Boolean(entry.readable),
      writable: Boolean(entry.writable),
      inputDevice: String(entry.inputDevice || ''),
      outputDevice: String(entry.outputDevice || ''),
    };
  }
  return devices;
}

function fallbackRuntimeKernelVirtualPathTarget(path, devices = {}) {
  const normalized = normalizePyodideFsAbsolutePath(path);
  if (!normalized) return { kind: 'error', reason: 'not-found', path: '' };
  if (normalized === '/proc' || normalized.startsWith('/proc/')) return { kind: 'proc', path: normalized };
  if (normalized === '/dev') return { kind: 'device-directory', path: normalized };
  if (normalized.startsWith('/dev/')) {
    return devices[normalized] ? { kind: 'device-file', path: normalized } : { kind: 'device-not-found', path: normalized };
  }
  return { kind: 'workspace', path: normalized };
}

function fallbackRuntimeKernelVirtualMutationTarget(path, devices = {}) {
  const target = fallbackRuntimeKernelVirtualPathTarget(path, devices);
  if (target.kind === 'workspace') return target;
  if (target.kind === 'device-not-found') return { kind: 'error', reason: 'device-not-found', path: target.path };
  if (target.kind === 'proc') return { kind: 'error', reason: 'proc-read-only', path: target.path };
  return { kind: 'error', reason: 'device-read-only', path: target.path };
}

function fallbackRuntimeKernelVirtualOpenTarget(path, request = {}, options = {}) {
  const devices = options.devices || {};
  const target = fallbackRuntimeKernelVirtualPathTarget(path, devices);
  if (target.kind === 'workspace') return target;
  if (target.kind === 'device-directory') return { kind: 'error', reason: 'is-directory', path: target.path };
  if (target.kind === 'device-not-found') return { kind: 'error', reason: 'not-found', path: target.path };
  if (target.kind === 'device-file') {
    const info = devices[target.path];
    return {
      kind: 'device',
      device: target.path,
      readable: Boolean(info?.readable && request.readable === true),
      writable: Boolean(info?.writable && request.writable === true),
    };
  }
  if (target.kind === 'proc') {
    if (options.procEntryKind === 'directory') return { kind: 'error', reason: 'is-directory', path: target.path };
    if (options.procEntryKind !== 'file') return { kind: 'error', reason: 'not-found', path: target.path };
    if (request.writable || request.create || request.truncate || request.exclusive) {
      return { kind: 'error', reason: 'read-only', path: target.path };
    }
    return { kind: 'proc-file', path: target.path, readable: true, writable: false };
  }
  return { kind: 'error', reason: 'read-only', path: target.path };
}

const STDIN_PIPE_HEADER_INTS = 3;
const STDIN_PIPE_HEADER_BYTES = STDIN_PIPE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const STDIN_PIPE_READ_INDEX = 0;
const STDIN_PIPE_WRITE_INDEX = 1;
const STDIN_PIPE_CLOSED_INDEX = 2;

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
  if (!state) return -1;
  const capacity = state.bytes.byteLength;
  while (true) {
    const readIndex = Atomics.load(state.header, STDIN_PIPE_READ_INDEX);
    const writeIndex = Atomics.load(state.header, STDIN_PIPE_WRITE_INDEX);
    if (stdinPipeAvailable(state, readIndex, writeIndex) > 0) {
      const byte = state.bytes[readIndex];
      Atomics.store(state.header, STDIN_PIPE_READ_INDEX, (readIndex + 1) % capacity);
      return byte;
    }
    if (Atomics.load(state.header, STDIN_PIPE_CLOSED_INDEX) !== 0) return -1;
    Atomics.wait(state.header, STDIN_PIPE_WRITE_INDEX, writeIndex);
  }
}

function installPyodideProjectStdioBridge(kernelDevices, stdinPipe) {
  if (!pyodide) return () => {};

  const devices = normalizeProjectKernelDevices(kernelDevices);
  const kernelPolicy = self.TraceRuntimeKernelPolicy;
  const stdinPipeReader = stdinPipeState(stdinPipe);
  const previousReadProjectStdinByte = self.__tracecodeReadProjectStdinByte;
  delete self.__tracecodeProjectProviderOutput;
  const deviceInputSource = (device) => (
    kernelPolicy && typeof kernelPolicy.runtimeKernelDeviceInputSource === 'function'
      ? String(kernelPolicy.runtimeKernelDeviceInputSource(devices, device) || '')
      : String(devices[String(device)]?.inputDevice || (devices[String(device)]?.readable ? device : ''))
  );
  const readProjectStdinByte = (device = '/dev/stdin') => {
    const inputDevice = deviceInputSource(device);
    if (!inputDevice || inputDevice === '/dev/null') return -1;
    if (stdinPipeReader) return readStdinPipeByte(stdinPipeReader);
    return -1;
  };
  self.__tracecodeReadProjectStdinByte = readProjectStdinByte;

  const restoreFns = [];
  if (typeof pyodide.setStdin === 'function' && devices['/dev/stdin']?.readable) {
    pyodide.setStdin({
      read: (buffer) => {
        let count = 0;
        while (count < buffer.byteLength) {
          const value = readProjectStdinByte('/dev/stdin');
          if (value < 0) break;
          buffer[count] = value;
          count += 1;
        }
        return count;
      },
      isatty: false,
    });
    restoreFns.push(() => pyodide.setStdin({}));
  }
  // Do not replace Pyodide's provider-level stdout/stderr callbacks while the
  // user authority boundary is active. Re-entering the browser worker from a
  // low-level WASM stream callback can deadlock the interpreter. The project
  // wrapper below binds both sys.stdout/sys.stderr and their __stdout__/
  // __stderr__ escape hatches to bounded TraceKernel streams instead.

  return () => {
    delete self.__tracecodeProjectProviderOutput;
    if (previousReadProjectStdinByte === undefined) {
      delete self.__tracecodeReadProjectStdinByte;
    } else {
      self.__tracecodeReadProjectStdinByte = previousReadProjectStdinByte;
    }
    for (const restore of restoreFns.reverse()) {
      try {
        restore();
      } catch {
        // Restoring Pyodide stream defaults is best-effort.
      }
    }
  };
}

class TraceKernelHttpBridge {
  constructor(messageId, protocolToken) {
    this.messageId = messageId;
    this.protocolToken = protocolToken;
    this.nextListenerId = 1;
    this.nextRequestId = 1;
    this.listeners = new Map();
    this.listenerInfo = new Map();
    this.listenerReady = new Set();
    this.listenerFailures = new Map();
    this.dispatchRequests = new Map();
  }

  listen(optionsJson, handler) {
    const options = typeof optionsJson === 'string' ? JSON.parse(optionsJson) : optionsJson || {};
    const listenerId = `python-http-${this.nextListenerId++}`;
    this.listeners.set(listenerId, handler);
    this.listenerInfo.set(listenerId, {
      id: listenerId,
      pid: 0,
      host: options.host || '127.0.0.1',
      port: Number(options.port),
      protocol: options.protocol || 'http',
      startedAt: new Date().toISOString(),
    });
    trustedPythonWorkerPostMessage({
      id: this.messageId,
      type: 'kernel-http-listen',
      protocolToken: this.protocolToken,
      payload: {
        type: 'kernel-http-listen',
        listenerId,
        options,
      },
    });
    const bridge = this;
    return {
      id: listenerId,
      get info() {
        return bridge.listenerInfo.get(listenerId) || null;
      },
      get ready() {
        return bridge.listenerReady.has(listenerId);
      },
      get error() {
        return bridge.listenerFailures.get(listenerId) || null;
      },
      close: () => {
        this.listeners.delete(listenerId);
        this.listenerInfo.delete(listenerId);
        this.listenerReady.delete(listenerId);
        this.listenerFailures.delete(listenerId);
        trustedPythonWorkerPostMessage({
          id: this.messageId,
          type: 'kernel-http-close',
          protocolToken: this.protocolToken,
          payload: { type: 'kernel-http-close', listenerId },
        });
      },
    };
  }

  dispatch(requestJson, optionsJson) {
    const request = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson || {};
    const options = typeof optionsJson === 'string' && optionsJson
      ? JSON.parse(optionsJson)
      : optionsJson || {};
    const requestId = `python-dispatch-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      this.dispatchRequests.set(requestId, { resolve, reject });
      trustedPythonWorkerPostMessage({
        id: this.messageId,
        type: 'kernel-http-dispatch',
        protocolToken: this.protocolToken,
        payload: {
          type: 'kernel-http-dispatch',
          requestId,
          request,
          ...(Number.isFinite(Number(options.timeoutMs)) ? { timeoutMs: Math.max(1, Math.ceil(Number(options.timeoutMs))) } : {}),
        },
      });
    });
  }

  resolveDispatch(requestId, response) {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.resolve(JSON.stringify(response));
  }

  rejectDispatch(requestId, error) {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.reject(new Error(error));
  }

  updateListenerInfo(listenerId, info) {
    this.listenerInfo.set(listenerId, info);
    this.listenerReady.add(listenerId);
    this.listenerFailures.delete(listenerId);
  }

  failListener(listenerId, error) {
    this.listeners.delete(listenerId);
    this.listenerInfo.delete(listenerId);
    this.listenerReady.delete(listenerId);
    this.listenerFailures.set(listenerId, error || 'Network listener registration failed');
  }

  abortRequest(_requestId) {
    // Python's synchronous http.server shims cannot preempt a running handler,
    // but the host still sends aborts so future async handlers have a protocol hook.
  }

  async handleRequest(listenerId, requestId, request) {
    const handler = this.listeners.get(listenerId);
    if (!handler) {
      trustedPythonWorkerPostMessage({
        id: this.messageId,
        type: 'kernel-http-error',
        protocolToken: this.protocolToken,
        payload: {
          type: 'kernel-http-error',
          requestId,
          listenerId,
          error: `Network listener not found: ${listenerId}`,
        },
      });
      return;
    }
    try {
      const rawResponse = await handler(JSON.stringify(request));
      const response = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
      trustedPythonWorkerPostMessage({
        id: this.messageId,
        type: 'kernel-http-response',
        protocolToken: this.protocolToken,
        payload: {
          type: 'kernel-http-response',
          requestId,
          response,
        },
      });
    } catch (error) {
      trustedPythonWorkerPostMessage({
        id: this.messageId,
        type: 'kernel-http-error',
        protocolToken: this.protocolToken,
        payload: {
          type: 'kernel-http-error',
          requestId,
          listenerId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

const activeProjectHttpBridges = new Map();

async function executeProjectPythonUserCall(request, messageId, protocolToken) {
  const requestJson = JSON.stringify(request ?? {});
  const httpBridge = new TraceKernelHttpBridge(messageId, protocolToken);
  activeProjectHttpBridges.set(messageId, httpBridge);
  const projectEventBudget = createProjectEventBudget();
  const projectOutputEvents = [];
  self.__tracecodeProjectEvent = (event) => {
    const payload = typeof event === 'string' ? JSON.parse(event) : event;
    const budgetedPayload = projectEventBudget.apply(payload);
    if (!budgetedPayload) return;
    if (budgetedPayload?.type === 'output' && (budgetedPayload.stream === 'stdout' || budgetedPayload.stream === 'stderr')) {
      projectOutputEvents.push(budgetedPayload);
    }
    trustedPythonWorkerPostMessage({ id: messageId, type: 'project-event', payload: budgetedPayload, protocolToken });
  };
  self.__tracecodeRuntimeKernelOpenTarget = (payload) => {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const policy = self.TraceRuntimeKernelPolicy;
    const openTarget = policy && typeof policy.runtimeKernelVirtualOpenTarget === 'function'
      ? policy.runtimeKernelVirtualOpenTarget(
          parsed?.path,
          parsed?.request ?? {},
          {
            devices: normalizeProjectKernelDevices(request?.project?.kernelDevices),
            procEntryKind: parsed?.procEntryKind,
          }
        )
      : fallbackRuntimeKernelVirtualOpenTarget(
          parsed?.path,
          parsed?.request ?? {},
          {
            devices: normalizeProjectKernelDevices(request?.project?.kernelDevices),
            procEntryKind: parsed?.procEntryKind,
          }
        );
    return JSON.stringify(openTarget);
  };
  self.__tracecodeRuntimeKernelMutationTarget = (payload) => {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const policy = self.TraceRuntimeKernelPolicy;
    const mutationTarget = policy && typeof policy.runtimeKernelVirtualMutationTarget === 'function'
      ? policy.runtimeKernelVirtualMutationTarget(parsed?.path, {
          devices: normalizeProjectKernelDevices(request?.project?.kernelDevices),
        })
      : fallbackRuntimeKernelVirtualMutationTarget(
          parsed?.path,
          normalizeProjectKernelDevices(request?.project?.kernelDevices)
        );
    return JSON.stringify(mutationTarget);
  };
  self.__tracecodeInstallProjectFsMutationEvents = installPyodideProjectFsMutationEvents;
  self.__tracecodeKernelHttpListen = (optionsJson, handler) => httpBridge.listen(optionsJson, handler);
  self.__tracecodeKernelHttpDispatch = (requestJson, optionsJson) => httpBridge.dispatch(requestJson, optionsJson);
  const restoreProviderStdioBridge = installPyodideProjectStdioBridge(
    request?.project?.kernelDevices,
    request?.stdinPipe
  );
  const projectCode = `
import base64
import builtins
import contextlib
import io
import importlib
import json
import math
import os
import runpy
import shutil
import stat
import sys
import traceback
from js import self as _js_self

_request = json.loads(${JSON.stringify(requestJson)})
_root = "/tracecode_project"
_project_info = _request.get("project", {}) if isinstance(_request.get("project", {}), dict) else {}
def _normalize_virtual_root(_value, _fallback="/workspace"):
    _text = str(_value or _fallback).replace("\\\\", "/").rstrip("/")
    if not _text:
        _text = _fallback
    if not _text.startswith("/"):
        _text = "/" + _text
    return _text

_workspace_root = _normalize_virtual_root(_project_info.get("workspaceRoot") or _project_info.get("cwd") or "/workspace")
_workspace_alias_value = _project_info.get("workspaceAlias")
_workspace_alias = _normalize_virtual_root(_workspace_alias_value) if _workspace_alias_value else None
shutil.rmtree(_root, ignore_errors=True)
os.makedirs(_root, exist_ok=True)
_original_file_bytes = {}
_PROJECT_MAX_OUTPUT_STREAM_BYTES = ${PROJECT_MAX_OUTPUT_STREAM_BYTES}
_PROJECT_MAX_LIVE_FILE_CHANGES = ${PROJECT_MAX_LIVE_FILE_CHANGES}
_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES = ${PROJECT_MAX_LIVE_FILE_CHANGE_BYTES}
_project_live_file_change_count = 0
_project_live_file_change_bytes = 0

def _project_utf8_len(_value):
    return len(str(_value).encode("utf-8", "replace"))

def _project_truncate_utf8(_value, _max_bytes):
    if _max_bytes <= 0:
        return ""
    _out = []
    _used = 0
    for _char in str(_value):
        _next = len(_char.encode("utf-8", "replace"))
        if _used + _next > _max_bytes:
            break
        _used += _next
        _out.append(_char)
    return "".join(_out)

def _project_file_change_byte_size(_change):
    if not isinstance(_change, dict):
        return 0
    _size = _project_utf8_len(_change.get("path", ""))
    _contents = _change.get("contents")
    if isinstance(_contents, str):
        if _change.get("encoding") == "base64":
            _size += int((len(_contents) * 3 + 3) / 4)
        else:
            _size += _project_utf8_len(_contents)
    return _size

def _project_live_file_change_allowed(_change):
    global _project_live_file_change_count, _project_live_file_change_bytes
    _project_live_file_change_count += 1
    _size = _project_file_change_byte_size(_change)
    if _project_live_file_change_count > _PROJECT_MAX_LIVE_FILE_CHANGES:
        return False
    if _size > _PROJECT_MAX_LIVE_FILE_CHANGE_BYTES:
        return False
    if _project_live_file_change_bytes + _size > _PROJECT_MAX_LIVE_FILE_CHANGE_BYTES:
        return False
    _project_live_file_change_bytes += _size
    return True

def _project_file_size_within_live_budget(_absolute_path, _relative_path):
    try:
        _size = os.path.getsize(_absolute_path)
    except OSError:
        return True
    return _size + _project_utf8_len(_relative_path) <= _PROJECT_MAX_LIVE_FILE_CHANGE_BYTES

for _directory in _request.get("project", {}).get("directories", []):
    _relative_directory = str(_directory).replace("\\\\", "/")
    if (
        not _relative_directory
        or _relative_directory.startswith("/")
        or ".." in [part for part in _relative_directory.split("/") if part]
    ):
        raise ValueError(f"Unsafe project directory path: {_relative_directory}")
    os.makedirs(os.path.join(_root, _relative_directory), exist_ok=True)

for _file in _request.get("project", {}).get("files", []):
    _relative_path = str(_file.get("path", "")).replace("\\\\", "/")
    if (
        not _relative_path
        or _relative_path.startswith("/")
        or ".." in [part for part in _relative_path.split("/") if part]
    ):
        raise ValueError(f"Unsafe project file path: {_relative_path}")
    _target = os.path.join(_root, _relative_path)
    os.makedirs(os.path.dirname(_target), exist_ok=True)
    if _file.get("encoding") == "base64":
        _contents = base64.b64decode(str(_file.get("contents", "")))
    else:
        _contents = str(_file.get("contents", "")).encode("utf-8")
    _original_file_bytes[_relative_path] = _contents
    with open(_target, "wb") as _handle:
        _handle.write(_contents)

_restore_provider_fs_mutation_events = lambda: None
try:
    _restore_provider_fs_mutation_events = _js_self.__tracecodeInstallProjectFsMutationEvents(_root, json.dumps(_project_info.get("kernelDevices", [])))
except Exception:
    _restore_provider_fs_mutation_events = lambda: None

_source = _request.get("source")
_script_path = str(_request.get("scriptPath") or "")
_args = [str(value) for value in _request.get("args", [])]
_stdout = io.StringIO()
_stderr = io.StringIO()
_previous_argv = sys.argv[:]
_previous_stdin = sys.stdin
_previous_dunder_stdout = sys.__stdout__
_previous_dunder_stderr = sys.__stderr__
_previous_cwd = os.getcwd()
_previous_environ = os.environ.copy()
_previous_path = sys.path[:]
_previous_modules = set(sys.modules.keys())
_env = {str(key): str(value) for key, value in _request.get("env", {}).items()}
_exit_code = 0
_restore_workspace_paths = lambda: None
_active_project_cwd = _root
_project_original_open = builtins.open

def _read_project_input_byte(_device="/dev/stdin"):
    try:
        return int(_js_self.__tracecodeReadProjectStdinByte(str(_device)))
    except Exception:
        return -1

def _read_project_input(_device="/dev/stdin", _size=-1):
    _device_info = _kernel_devices.get(str(_device), {})
    if not bool(_device_info.get("readable")):
        raise OSError("Kernel device is not readable: " + str(_device))
    _limit = None if _size is None or int(_size) < 0 else max(0, int(_size))
    _data = bytearray()
    while _limit is None or len(_data) < _limit:
        _value = _read_project_input_byte(_device)
        if _value < 0:
            break
        _data.append(_value & 0xff)
    return bytes(_data)

def _emit_project_event(_event):
    try:
        if (
            isinstance(_event, dict)
            and _event.get("type") == "file-change"
            and _event.get("phase", "live") == "live"
            and not _project_live_file_change_allowed(_event.get("change", {}))
        ):
            return
        _js_self.__tracecodeProjectEvent(json.dumps(_event))
    except Exception:
        pass

class _TraceKernelHttpHandle:
    def __init__(self, _js_handle):
        self._js_handle = _js_handle
        self.closed = False

    @property
    def ready(self):
        return bool(getattr(self._js_handle, "ready", False))

    @property
    def error(self):
        return getattr(self._js_handle, "error", None)

    def raise_if_failed(self):
        _error = self.error
        if _error:
            raise OSError(str(_error))

    async def wait_ready(self, _timeout=0.25):
        import asyncio
        _loop = asyncio.get_event_loop()
        _deadline = _loop.time() + float(_timeout or 0)
        while not self.ready and not self.error and _loop.time() < _deadline:
            await asyncio.sleep(0.001)
        self.raise_if_failed()
        if not self.ready:
            raise OSError("Network listener registration did not complete")
        return None

    def close(self):
        if self.closed:
            return None
        self.closed = True
        try:
            self._js_handle.close()
        except Exception:
            pass
        return None

def _install_tracekernel_asgi_modules():
    import asyncio
    import io
    import inspect
    import types
    import urllib.parse
    import urllib.request

    async def _maybe_await(_value):
        if inspect.isawaitable(_value):
            return await _value
        return _value

    def _json_response(_value, _status=200):
        return {
            "status": int(_status),
            "headers": {"content-type": "application/json"},
            "rawHeaders": [["content-type", "application/json"]],
            "body": json.dumps(_value, separators=(",", ":")) + "\\n",
        }

    def _http_bytes_from_message(_message):
        _body = str((_message or {}).get("body") or "")
        if (_message or {}).get("bodyEncoding") == "base64":
            return base64.b64decode(_body.encode("ascii"))
        return _body.encode("utf-8")

    def _http_body_payload(_value):
        if _value is None:
            return {}
        if isinstance(_value, str):
            return {"body": _value}
        _bytes = bytes(_value) if isinstance(_value, (bytes, bytearray, memoryview)) else str(_value).encode("utf-8")
        try:
            return {"body": _bytes.decode("utf-8")}
        except UnicodeDecodeError:
            return {"body": base64.b64encode(_bytes).decode("ascii"), "bodyEncoding": "base64"}

    class HTTPException(Exception):
        def __init__(self, status_code, detail=None, headers=None):
            super().__init__(detail if detail is not None else f"HTTP {status_code}")
            self.status_code = int(status_code)
            self.detail = detail if detail is not None else f"HTTP {status_code}"
            self.headers = dict(headers or {})

    class _TraceKernelParam:
        def __init__(self, kind, default=None, alias=None):
            self.kind = kind
            self.default = default
            self.alias = alias

    def Query(default=None, alias=None, **_kwargs):
        return _TraceKernelParam("query", default, alias)

    def Path(default=None, alias=None, **_kwargs):
        return _TraceKernelParam("path", default, alias)

    def Header(default=None, alias=None, **_kwargs):
        return _TraceKernelParam("header", default, alias)

    class Request:
        def __init__(self, scope, body):
            self.scope = scope
            self.method = str(scope.get("method", "GET")).upper()
            self.url = scope.get("tracekernel.url", "")
            self.path_params = dict(scope.get("path_params") or {})
            self.query_params = dict(scope.get("query_params") or {})
            self.headers = {
                name.decode("latin1").lower(): value.decode("latin1")
                for name, value in scope.get("headers", [])
            }
            self._body = bytes(body or b"")

        async def body(self):
            return self._body

        async def json(self):
            if not self._body:
                return None
            return json.loads(self._body.decode("utf-8"))

    class Response:
        media_type = None

        def __init__(self, content="", status_code=200, headers=None, media_type=None):
            self.content = content
            self.status_code = int(status_code)
            self.headers = dict(headers or {})
            self.media_type = media_type if media_type is not None else self.media_type

        def render(self):
            if isinstance(self.content, (bytes, bytearray, memoryview)):
                return bytes(self.content)
            return str(self.content).encode("utf-8")

    class JSONResponse(Response):
        media_type = "application/json"

        def render(self):
            return (json.dumps(self.content, separators=(",", ":")) + "\\n").encode("utf-8")

    def _asgi_response(_value, _status=200):
        if isinstance(_value, Response):
            _body = _value.render()
            _headers = {str(name).lower(): str(value) for name, value in _value.headers.items()}
            if _value.media_type:
                _headers.setdefault("content-type", _value.media_type)
            return {
                "status": int(_value.status_code),
                "headers": _headers,
                "rawHeaders": [[name, value] for name, value in _headers.items()],
                **_http_body_payload(_body),
            }
        return _json_response(_value, _status)

    def _tracekernel_http_timeout_ms(_timeout):
        if _timeout is None:
            return None
        if isinstance(_timeout, (tuple, list)):
            _values = [float(_value) for _value in _timeout if _value is not None]
            if not _values:
                return None
            _timeout = max(_values)
        _seconds = float(_timeout)
        if _seconds <= 0:
            return 1
        return max(1, int(math.ceil(_seconds * 1000)))

    async def _tracekernel_http_dispatch_async(_request, _timeout=None):
        _options = {}
        _timeout_ms = _tracekernel_http_timeout_ms(_timeout)
        if _timeout_ms is not None:
            _options["timeoutMs"] = _timeout_ms
        _response_json = await _js_self.__tracecodeKernelHttpDispatch(json.dumps(_request), json.dumps(_options))
        return json.loads(str(_response_json))

    def _tracekernel_http_dispatch_sync(_request, _timeout=None):
        return asyncio.get_event_loop().run_until_complete(_tracekernel_http_dispatch_async(_request, _timeout))

    class _TraceKernelHTTPResponse:
        def __init__(self, _response):
            self.status = int(_response.get("status") or 0)
            self.code = self.status
            self.reason = ""
            self.headers = dict(_response.get("headers") or {})
            self._body = _http_bytes_from_message(_response)
            self._stream = io.BytesIO(self._body)

        def read(self, _size=-1):
            return self._stream.read(_size)

        def getcode(self):
            return self.status

        def getheaders(self):
            return list(self.headers.items())

        def getheader(self, _name, _default=None):
            return self.headers.get(str(_name).lower(), _default)

        def close(self):
            self._stream.close()

        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc, _tb):
            self.close()
            return False

    def _tracekernel_http_urlopen(_url, data=None, timeout=None, **_kwargs):
        _headers = {}
        _method = None
        if hasattr(_url, "full_url"):
            _target_url = str(_url.full_url)
            try:
                _method = _url.get_method()
            except Exception:
                _method = None
            try:
                _headers = {str(_name).lower(): str(_value) for _name, _value in _url.header_items()}
            except Exception:
                _headers = {}
            if data is None:
                data = getattr(_url, "data", None)
        else:
            _target_url = str(_url)
        if _method is None:
            _method = "POST" if data is not None else "GET"
        _body_payload = _http_body_payload(data)
        _parsed = urllib.parse.urlsplit(_target_url)
        _response = _tracekernel_http_dispatch_sync({
            "method": str(_method).upper(),
            "url": _target_url,
            "path": (_parsed.path or "/") + (("?" + _parsed.query) if _parsed.query else ""),
            "headers": _headers,
            **_body_payload,
        }, timeout)
        return _TraceKernelHTTPResponse(_response)

    class _TraceKernelHTTPConnection:
        def __init__(self, host, port=None, timeout=None, **_kwargs):
            self.host = str(host)
            self.port = int(port or 80)
            self.timeout = timeout
            self._response = None

        def request(self, method, url, body=None, headers=None, **_kwargs):
            _target = str(url)
            if not _target.startswith("/"):
                _target = "/" + _target
            _body_payload = _http_body_payload(body)
            self._response = _tracekernel_http_dispatch_sync({
                "method": str(method).upper(),
                "url": f"http://{self.host}:{self.port}{_target}",
                "path": _target,
                "headers": {str(_name).lower(): str(_value) for _name, _value in (headers or {}).items()},
                **_body_payload,
            }, self.timeout)

        def getresponse(self):
            return _TraceKernelHTTPResponse(self._response or {"status": 0, "body": ""})

        def close(self):
            self._response = None

    class _TraceKernelRequestsResponse:
        def __init__(self, _response):
            self.status_code = int(_response.get("status") or 0)
            self.headers = dict(_response.get("headers") or {})
            self.content = _http_bytes_from_message(_response)
            self.text = self.content.decode("utf-8", "replace")
            self.ok = 200 <= self.status_code < 400

        def json(self):
            return json.loads(self.text)

        def raise_for_status(self):
            if not self.ok:
                raise Exception(f"HTTP {self.status_code}")

    def _tracekernel_requests_request(method, url, **_kwargs):
        _headers = {str(_name).lower(): str(_value) for _name, _value in (_kwargs.get("headers") or {}).items()}
        _body = _kwargs.get("data")
        if "json" in _kwargs:
            _body = json.dumps(_kwargs.get("json"), separators=(",", ":"))
            _headers.setdefault("content-type", "application/json")
        _body_payload = _http_body_payload(_body)
        _parsed = urllib.parse.urlsplit(str(url))
        return _TraceKernelRequestsResponse(_tracekernel_http_dispatch_sync({
            "method": str(method).upper(),
            "url": str(url),
            "path": (_parsed.path or "/") + (("?" + _parsed.query) if _parsed.query else ""),
            "headers": _headers,
            **_body_payload,
        }, _kwargs.get("timeout")))

    def _install_tracekernel_http_client_modules():
        import http.client as _http_client
        urllib.request.urlopen = _tracekernel_http_urlopen
        _http_client.HTTPConnection = _TraceKernelHTTPConnection
        _requests_module = types.ModuleType("requests")
        _requests_module.request = _tracekernel_requests_request
        _requests_module.get = lambda url, **kwargs: _tracekernel_requests_request("GET", url, **kwargs)
        _requests_module.post = lambda url, **kwargs: _tracekernel_requests_request("POST", url, **kwargs)
        _requests_module.put = lambda url, **kwargs: _tracekernel_requests_request("PUT", url, **kwargs)
        _requests_module.patch = lambda url, **kwargs: _tracekernel_requests_request("PATCH", url, **kwargs)
        _requests_module.delete = lambda url, **kwargs: _tracekernel_requests_request("DELETE", url, **kwargs)
        sys.modules.setdefault("requests", _requests_module)

    class _TraceKernelHttpSocket:
        def __init__(self, _request_bytes):
            self._request = io.BytesIO(_request_bytes)
            self._response = io.BytesIO()
            self.closed = False

        def makefile(self, _mode="r", _buffering=None):
            if "r" in str(_mode):
                return self._request
            return self._response

        def sendall(self, _data):
            self._response.write(bytes(_data or b""))

        def getsockname(self):
            return ("127.0.0.1", 0)

        def getpeername(self):
            return ("127.0.0.1", 0)

        def settimeout(self, _timeout):
            return None

        def shutdown(self, _how=None):
            return None

        def close(self):
            self.closed = True

        def response_bytes(self):
            return self._response.getvalue()

    def _tracekernel_http_header_pairs(_request):
        _source = []
        if isinstance((_request or {}).get("rawHeaders"), list):
            _source = [
                (_entry[0], _entry[1])
                for _entry in (_request or {}).get("rawHeaders")
                if isinstance(_entry, list) and len(_entry) >= 2
            ]
        else:
            _source = list(((_request or {}).get("headers") or {}).items())
        _headers = []
        for _name, _value in _source:
            _header_name = str(_name).lower()
            _header_value = str(_value)
            if (
                not _header_name
                or any(_char in _header_name for _char in "\\r\\n\\x00")
                or any(_char in _header_value for _char in "\\r\\n\\x00")
            ):
                raise ValueError("Invalid HTTP header")
            _headers.append((_header_name, _header_value))
        return _headers

    def _tracekernel_http_validate_component(_value, _label):
        _text = str(_value)
        if any(_char in _text for _char in "\\r\\n\\x00"):
            raise ValueError("Invalid HTTP " + str(_label))
        return _text

    def _tracekernel_http_server_request_bytes(_request):
        _method = _tracekernel_http_validate_component((_request or {}).get("method") or "GET", "method").upper()
        _parsed = urllib.parse.urlsplit(str((_request or {}).get("url") or "http://localhost/"))
        _path = str((_request or {}).get("path") or ((_parsed.path or "/") + (("?" + _parsed.query) if _parsed.query else "")))
        _path = _tracekernel_http_validate_component(_path, "path")
        _headers = _tracekernel_http_header_pairs(_request)
        _body = _http_bytes_from_message(_request)
        _host = _tracekernel_http_validate_component(_parsed.netloc or "localhost", "host")
        _lines = [f"{_method} {_path or '/'} HTTP/1.1", f"Host: {_host}"]
        for _name, _value in _headers:
            if _name.lower() in ("host", "content-length"):
                continue
            _lines.append(f"{_name}: {_value}")
        _lines.append(f"Content-Length: {len(_body)}")
        _lines.append("Connection: close")
        return ("\\r\\n".join(_lines) + "\\r\\n\\r\\n").encode("latin1") + _body

    def _tracekernel_http_server_response(_raw_response):
        _header_bytes, _separator, _body = bytes(_raw_response or b"").partition(b"\\r\\n\\r\\n")
        if not _separator:
            _header_bytes, _separator, _body = bytes(_raw_response or b"").partition(b"\\n\\n")
        _header_lines = _header_bytes.replace(b"\\r\\n", b"\\n").split(b"\\n") if _header_bytes else []
        _status = 200
        if _header_lines:
            _status_parts = _header_lines[0].decode("latin1", "replace").split()
            if len(_status_parts) >= 2:
                try:
                    _status = int(_status_parts[1])
                except Exception:
                    _status = 200
        _headers = {}
        _raw_headers = []
        for _line in _header_lines[1:]:
            if b":" not in _line:
                continue
            _name, _value = _line.split(b":", 1)
            _header_name = _name.decode("latin1", "replace").strip()
            _header_value = _value.decode("latin1", "replace").strip()
            if not _header_name:
                continue
            _headers[_header_name.lower()] = _header_value
            _raw_headers.append([_header_name, _header_value])
        return {
            "status": _status,
            "headers": _headers,
            "rawHeaders": _raw_headers,
            **_http_body_payload(_body),
        }

    class _TraceKernelTCPServer:
        allow_reuse_address = False
        request_queue_size = 5
        address_family = 2
        socket_type = 1
        timeout = None

        def __init__(self, server_address, RequestHandlerClass, bind_and_activate=True):
            self.server_address = tuple(server_address or ("127.0.0.1", 8000))
            self.RequestHandlerClass = RequestHandlerClass
            self._tracekernel_handle = None
            self._tracekernel_handler_proxy = None
            self.__shutdown_request = False
            self.__is_shut_down = True
            self.server_name = str(self.server_address[0] or "127.0.0.1")
            self.server_port = int(self.server_address[1] or 0)
            if bind_and_activate:
                try:
                    self.server_bind()
                    self.server_activate()
                except Exception:
                    self.server_close()
                    raise

        def server_bind(self):
            self.server_address = (str(self.server_address[0] or "127.0.0.1"), int(self.server_address[1] or 0))
            self.server_name = self.server_address[0]
            self.server_port = self.server_address[1]

        def server_activate(self):
            from pyodide.ffi import create_proxy
            if self._tracekernel_handle is not None:
                return
            async def _handler(_request_json):
                return self._tracekernel_dispatch(_request_json)
            self._tracekernel_handler_proxy = create_proxy(_handler)
            self._tracekernel_handle = _TraceKernelHttpHandle(getattr(_js_self, "__tracecodeKernelHttpListen")(json.dumps({
                "host": self.server_name,
                "port": self.server_port,
                "protocol": "http",
            }), self._tracekernel_handler_proxy))
            _loop = asyncio.get_event_loop()
            if not _loop.is_running():
                _loop.run_until_complete(self._tracekernel_handle.wait_ready())

        def _tracekernel_dispatch(self, _request_json):
            _request = json.loads(str(_request_json))
            _socket = _TraceKernelHttpSocket(_tracekernel_http_server_request_bytes(_request))
            _client_address = ("127.0.0.1", 0)
            self.RequestHandlerClass(_socket, _client_address, self)
            return json.dumps(_tracekernel_http_server_response(_socket.response_bytes()))

        def serve_forever(self, poll_interval=0.05):
            self.__shutdown_request = False
            self.__is_shut_down = False
            try:
                _loop = asyncio.get_event_loop()
                async def _wait_until_closed():
                    while not self.__shutdown_request:
                        if self._tracekernel_handle is not None:
                            self._tracekernel_handle.raise_if_failed()
                        await asyncio.sleep(float(poll_interval or 0.05))
                return _loop.run_until_complete(_wait_until_closed())
            finally:
                self.__is_shut_down = True
                self.server_close()

        def shutdown(self):
            self.__shutdown_request = True

        def server_close(self):
            self.__shutdown_request = True
            if self._tracekernel_handle is not None:
                self._tracekernel_handle.close()
                self._tracekernel_handle = None
            if self._tracekernel_handler_proxy is not None:
                try:
                    self._tracekernel_handler_proxy.destroy()
                except Exception:
                    pass
                self._tracekernel_handler_proxy = None

        def close_request(self, _request):
            try:
                _request.close()
            except Exception:
                pass

        def fileno(self):
            return -1

        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc, _tb):
            self.server_close()
            return False

    class _TraceKernelHTTPServer(_TraceKernelTCPServer):
        pass

    class _TraceKernelThreadingHTTPServer(_TraceKernelHTTPServer):
        daemon_threads = True

    def _install_tracekernel_http_server_modules():
        import http.server as _http_server
        import socketserver as _socketserver
        _socketserver.TCPServer = _TraceKernelTCPServer
        _http_server.HTTPServer = _TraceKernelHTTPServer
        _http_server.ThreadingHTTPServer = _TraceKernelThreadingHTTPServer

    def _match_route(_template, _path):
        _template_parts = [part for part in str(_template).strip("/").split("/") if part]
        _path_parts = [part for part in str(_path).strip("/").split("/") if part]
        if str(_template) == "/" and str(_path) == "/":
            return {}
        if len(_template_parts) != len(_path_parts):
            return None
        _params = {}
        for _template_part, _path_part in zip(_template_parts, _path_parts):
            if _template_part.startswith("{") and _template_part.endswith("}"):
                _params[_template_part[1:-1]] = urllib.parse.unquote(_path_part)
            elif _template_part != _path_part:
                return None
        return _params

    class FastAPI:
        def __init__(self):
            self.routes = []

        def route(self, path, methods=None, status_code=200):
            _methods = [str(_method).upper() for _method in (methods or ["GET"])]
            def _decorator(_func):
                for _method in _methods:
                    self.routes.append({
                        "method": _method,
                        "path": str(path),
                        "func": _func,
                        "status_code": int(status_code),
                    })
                return _func
            return _decorator

        def get(self, path, **kwargs):
            return self.route(path, ["GET"], **kwargs)

        def post(self, path, **kwargs):
            return self.route(path, ["POST"], **kwargs)

        def put(self, path, **kwargs):
            return self.route(path, ["PUT"], **kwargs)

        def patch(self, path, **kwargs):
            return self.route(path, ["PATCH"], **kwargs)

        def delete(self, path, **kwargs):
            return self.route(path, ["DELETE"], **kwargs)

        async def __call__(self, scope, receive, send):
            _method = str(scope.get("method", "GET")).upper()
            _path = str(scope.get("path", "/"))
            _route = None
            _path_params = {}
            for _candidate in self.routes:
                if _candidate["method"] != _method:
                    continue
                _matched_params = _match_route(_candidate["path"], _path)
                if _matched_params is not None:
                    _route = _candidate
                    _path_params = _matched_params
                    break
            if _route is None:
                await send({"type": "http.response.start", "status": 404, "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"Not Found\\n"})
                return
            _body = b""
            while True:
                _message = await receive()
                if _message.get("type") != "http.request":
                    break
                _body += _message.get("body", b"")
                if not _message.get("more_body"):
                    break
            _headers = {name.decode("latin1").lower(): value.decode("latin1") for name, value in scope.get("headers", [])}
            _query_params = urllib.parse.parse_qs((scope.get("query_string") or b"").decode("utf-8"), keep_blank_values=True)
            _signature = inspect.signature(_route["func"])
            _reserved_query_names = {
                _name
                for _name, _param in _signature.parameters.items()
                if isinstance(_param.default, _TraceKernelParam) or _name == "request" or _param.annotation is Request
            }
            _kwargs = dict(_path_params)
            for _name, _values in _query_params.items():
                if _values and _name in _signature.parameters and _name not in _reserved_query_names:
                    _kwargs.setdefault(_name, _values[-1])
            _request_obj = Request({
                **scope,
                "path_params": _path_params,
                "query_params": {name: values[-1] for name, values in _query_params.items() if values},
            }, _body)
            for _name, _param in _signature.parameters.items():
                _default = _param.default
                if isinstance(_default, _TraceKernelParam):
                    _source_name = str(_default.alias or _name)
                    if _default.kind == "header":
                        _header_name = _source_name.lower().replace("_", "-")
                        if _header_name in _headers:
                            _kwargs[_name] = _headers[_header_name]
                        elif _default.default is not inspect.Parameter.empty:
                            _kwargs[_name] = _default.default
                    elif _default.kind == "query" and _source_name in _query_params and _query_params[_source_name]:
                        _kwargs[_name] = _query_params[_source_name][-1]
                    elif _default.kind == "path" and _source_name in _path_params:
                        _kwargs[_name] = _path_params[_source_name]
                    elif _default.default is not inspect.Parameter.empty:
                        _kwargs.setdefault(_name, _default.default)
                elif _name == "request" or _param.annotation is Request:
                    _kwargs[_name] = _request_obj
            _body_value = None
            _has_body_value = False
            if _method in ("POST", "PUT", "PATCH"):
                _content_type = _headers.get("content-type", "")
                if "application/json" in _content_type and _body:
                    _body_value = json.loads(_body.decode("utf-8"))
                    _has_body_value = True
                elif _body:
                    _body_value = _body.decode("utf-8")
                    _has_body_value = True
            if _has_body_value:
                _missing_params = [
                    _name for _name, _param in _signature.parameters.items()
                    if _name not in _kwargs and
                    _param.kind in (
                        inspect.Parameter.POSITIONAL_OR_KEYWORD,
                        inspect.Parameter.KEYWORD_ONLY,
                    )
                ]
                if len(_missing_params) == 1:
                    _kwargs[_missing_params[0]] = _body_value
                elif "body" in _signature.parameters and "body" not in _kwargs:
                    _kwargs["body"] = _body_value
                elif "item" in _signature.parameters and "item" not in _kwargs:
                    _kwargs["item"] = _body_value
            _accepted_kwargs = {
                _name: _value for _name, _value in _kwargs.items()
                if _name in _signature.parameters or any(
                    _param.kind == inspect.Parameter.VAR_KEYWORD
                    for _param in _signature.parameters.values()
                )
            }
            try:
                _result = await _maybe_await(_route["func"](**_accepted_kwargs))
                _response = _asgi_response(_result, _route["status_code"])
            except HTTPException as _error:
                _response = _asgi_response(
                    JSONResponse({"detail": _error.detail}, status_code=_error.status_code, headers=_error.headers)
                )
            await send({
                "type": "http.response.start",
                "status": _response["status"],
                "headers": [(key.encode("latin1"), value.encode("latin1")) for key, value in _response["headers"].items()],
            })
            await send({"type": "http.response.body", "body": _http_bytes_from_message(_response)})

    async def _tracekernel_asgi_dispatch(_app, _request_json):
        _request = json.loads(str(_request_json))
        _parsed = urllib.parse.urlsplit(str(_request.get("url") or "http://localhost/"))
        _path = str(_request.get("path") or (_parsed.path or "/"))
        _query = ""
        if "?" in _path:
            _path, _query = _path.split("?", 1)
        elif _parsed.query:
            _query = _parsed.query
        if (
            any(_char in _path for _char in "\\r\\n\\x00")
            or any(_char in _query for _char in "\\r\\n\\x00")
            or any(_char in str(_request.get("method") or "GET") for _char in "\\r\\n\\x00")
        ):
            raise ValueError("Invalid ASGI request")
        _headers = [
            (_name.encode("latin1"), _value.encode("latin1"))
            for _name, _value in _tracekernel_http_header_pairs(_request)
        ]
        _body = _http_bytes_from_message(_request)
        _sent = []
        _received = False
        async def _receive():
            nonlocal _received
            if _received:
                return {"type": "http.disconnect"}
            _received = True
            return {"type": "http.request", "body": _body, "more_body": False}
        async def _send(_message):
            _sent.append(_message)
        _scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": str(_request.get("method") or "GET").upper(),
            "scheme": "http",
            "path": _path or "/",
            "raw_path": (_path or "/").encode("utf-8"),
            "query_string": _query.encode("utf-8"),
            "headers": _headers,
            "tracekernel.url": str(_request.get("url") or ""),
        }
        await _maybe_await(_app(_scope, _receive, _send))
        _status = 200
        _response_headers = {}
        _response_raw_headers = []
        _chunks = []
        for _message in _sent:
            if _message.get("type") == "http.response.start":
                _status = int(_message.get("status") or 200)
                for _name, _value in _message.get("headers") or []:
                    _header_name = _name.decode("latin1")
                    _header_value = _value.decode("latin1")
                    _response_headers[_header_name.lower()] = _header_value
                    _response_raw_headers.append([_header_name, _header_value])
            elif _message.get("type") == "http.response.body":
                _chunks.append(bytes(_message.get("body") or b""))
        _body_payload = _http_body_payload(b"".join(_chunks))
        return json.dumps({
            "status": _status,
            "headers": _response_headers,
            "rawHeaders": _response_raw_headers,
            **_body_payload,
        })

    async def _tracekernel_serve_asgi(_app, host="127.0.0.1", port=8000):
        from pyodide.ffi import create_proxy
        async def _handler(_request_json):
            return await _tracekernel_asgi_dispatch(_app, _request_json)
        _handler_proxy = create_proxy(_handler)
        _js_handle = _js_self.__tracecodeKernelHttpListen(json.dumps({
            "host": str(host or "127.0.0.1"),
            "port": int(port),
            "protocol": "http",
        }), _handler_proxy)
        _handle = _TraceKernelHttpHandle(_js_handle)
        await _handle.wait_ready()
        try:
            while not _handle.closed:
                await asyncio.sleep(0.05)
        finally:
            _handler_proxy.destroy()

    def _uvicorn_run(_app, host="127.0.0.1", port=8000, **_kwargs):
        return asyncio.get_event_loop().run_until_complete(_tracekernel_serve_asgi(_app, host=host, port=port))

    _fastapi_module = types.ModuleType("fastapi")
    _fastapi_module.__path__ = []
    _fastapi_module.FastAPI = FastAPI
    _fastapi_module.Header = Header
    _fastapi_module.HTTPException = HTTPException
    _fastapi_module.Path = Path
    _fastapi_module.Query = Query
    _fastapi_module.Request = Request
    _fastapi_module.Response = Response
    sys.modules.setdefault("fastapi", _fastapi_module)
    _fastapi_responses_module = types.ModuleType("fastapi.responses")
    _fastapi_responses_module.JSONResponse = JSONResponse
    _fastapi_responses_module.Response = Response
    _fastapi_module.responses = _fastapi_responses_module
    sys.modules.setdefault("fastapi.responses", _fastapi_responses_module)
    _uvicorn_module = types.ModuleType("uvicorn")
    _uvicorn_module.run = _uvicorn_run
    sys.modules["uvicorn"] = _uvicorn_module
    _install_tracekernel_http_client_modules()
    _install_tracekernel_http_server_modules()

def _project_relative_path_from_absolute(_absolute_path):
    try:
        _absolute = os.path.abspath(os.fspath(_absolute_path))
    except Exception:
        return None
    if _absolute == _root or not _absolute.startswith(_root + os.sep):
        return None
    return os.path.relpath(_absolute, _root).replace(os.sep, "/")

def _project_realpath_within_root(_absolute_path):
    try:
        _real_root = os.path.realpath(_root)
        _real_path = os.path.realpath(_absolute_path)
    except Exception:
        return False
    return _real_path == _real_root or _real_path.startswith(_real_root + os.sep)

def _project_snapshot_absolute_path(_absolute_path):
    try:
        _absolute = os.path.abspath(os.fspath(_absolute_path))
    except Exception:
        return None
    if _absolute != _root and not _absolute.startswith(_root + os.sep):
        return None
    try:
        if os.path.islink(_absolute):
            return None
    except Exception:
        return None
    if not _project_realpath_within_root(_absolute):
        return None
    return _absolute

def _project_snapshot_directory_key(_absolute_path):
    try:
        _stat = os.lstat(_absolute_path)
        return (_stat.st_dev, _stat.st_ino)
    except Exception:
        return ("path", os.path.abspath(os.fspath(_absolute_path)))

def _runtime_file_change_for_absolute(_absolute_path):
    _absolute_path = _project_snapshot_absolute_path(_absolute_path)
    _relative_path = _project_relative_path_from_absolute(_absolute_path) if _absolute_path else None
    if not _relative_path or not os.path.isfile(_absolute_path):
        return None
    if not _project_file_size_within_live_budget(_absolute_path, _relative_path):
        return None
    with _project_original_open(_absolute_path, "rb") as _handle:
        _contents = _handle.read()
    if len(_contents) + _project_utf8_len(_relative_path) > _PROJECT_MAX_LIVE_FILE_CHANGE_BYTES:
        return None
    try:
        return {"path": _relative_path, "contents": _contents.decode("utf-8")}
    except UnicodeDecodeError:
        return {
            "path": _relative_path,
            "contents": base64.b64encode(_contents).decode("ascii"),
            "encoding": "base64",
        }

def _emit_file_change_for_absolute(_absolute_path):
    _change = _runtime_file_change_for_absolute(_absolute_path)
    if _change is not None:
        _emit_project_event({"type": "file-change", "phase": "live", "change": _change})

def _emit_file_delete_for_absolute(_absolute_path):
    _relative_path = _project_relative_path_from_absolute(_absolute_path)
    if _relative_path:
        _emit_project_event({"type": "file-change", "phase": "live", "change": {"path": _relative_path, "deleted": True}})

def _emit_directory_change_for_absolute(_absolute_path, _deleted=False):
    if not _deleted and _project_snapshot_absolute_path(_absolute_path) is None:
        return
    _relative_path = _project_relative_path_from_absolute(_absolute_path)
    if _relative_path:
        _change = {"path": _relative_path, "directory": True}
        if _deleted:
            _change["deleted"] = True
        _emit_project_event({"type": "file-change", "phase": "live", "change": _change})

def _emit_path_snapshot_for_absolute(_absolute_path):
    _absolute_path = _project_snapshot_absolute_path(_absolute_path)
    if _absolute_path is None:
        return
    if os.path.isfile(_absolute_path):
        _emit_file_change_for_absolute(_absolute_path)
        return
    if not os.path.isdir(_absolute_path):
        return
    _seen_dirs = set()
    for _dirpath, _dirnames, _filenames in os.walk(_absolute_path, followlinks=False):
        _dirpath = _project_snapshot_absolute_path(_dirpath)
        if _dirpath is None or not os.path.isdir(_dirpath):
            _dirnames[:] = []
            continue
        _directory_key = _project_snapshot_directory_key(_dirpath)
        if _directory_key in _seen_dirs:
            _dirnames[:] = []
            continue
        _seen_dirs.add(_directory_key)
        _emit_directory_change_for_absolute(_dirpath)
        _safe_dirnames = []
        for _dirname in _dirnames:
            _child_path = os.path.join(_dirpath, _dirname)
            if _project_snapshot_absolute_path(_child_path) is not None and os.path.isdir(_child_path):
                _safe_dirnames.append(_dirname)
        _dirnames[:] = sorted(_safe_dirnames)
        for _filename in sorted(_filenames):
            _emit_file_change_for_absolute(os.path.join(_dirpath, _filename))

class _TraceProjectBinaryBuffer:
    def __init__(self, _text_stream):
        self._text_stream = _text_stream
        self.closed = False

    def write(self, _value):
        if self.closed:
            raise ValueError("I/O operation on closed file.")
        _data = _value if isinstance(_value, (bytes, bytearray)) else bytes(_value)
        self._text_stream.write(bytes(_data).decode("utf-8", "replace"))
        return len(_data)

    def flush(self):
        return self._text_stream.flush()

    def close(self):
        self.closed = True

    def writable(self):
        return True


class _TraceProjectStream(io.StringIO):
    def __init__(self, _stream):
        super().__init__()
        self._stream = _stream
        self._binary_buffer = _TraceProjectBinaryBuffer(self)
        self._bytes_written = 0
        self._truncated = False

    @property
    def buffer(self):
        return self._binary_buffer

    def _budget_text(self, _text):
        if self._truncated:
            return ""
        _bytes = _project_utf8_len(_text)
        _remaining = _PROJECT_MAX_OUTPUT_STREAM_BYTES - self._bytes_written
        if _bytes <= _remaining:
            self._bytes_written += _bytes
            return _text
        self._truncated = True
        _marker = f"\\n[{self._stream} output truncated after {_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\\n"
        _out = _project_truncate_utf8(_text, max(0, _remaining)) + _marker
        self._bytes_written = _PROJECT_MAX_OUTPUT_STREAM_BYTES + _project_utf8_len(_marker)
        return _out

    def write(self, _value, _source_device=None, _output_device=None):
        _text = str(_value)
        _budgeted_text = self._budget_text(_text)
        _device = str(_output_device or ("/dev/stderr" if self._stream == "stderr" else "/dev/stdout"))
        if _budgeted_text:
            _event = {
                "type": "output",
                "stream": self._stream,
                "device": _device,
                "data": _budgeted_text,
            }
            if _source_device and _source_device != _device:
                _event["sourceDevice"] = _source_device
            _emit_project_event(_event)
            super().write(_budgeted_text)
        return len(_text)

    def writelines(self, _lines):
        _text = "".join(str(_line) for _line in _lines)
        if _text:
            self.write(_text)
        return None

class _TraceProjectInputStream(io.TextIOBase):
    def readable(self):
        return bool(_kernel_devices.get("/dev/stdin", {}).get("readable"))

    def read(self, _size=-1):
        if not self.readable():
            return ""
        return _read_project_input("/dev/stdin", _size).decode("utf-8", "replace")

    def readline(self, _size=-1):
        if not self.readable():
            return ""
        _limit = None if _size is None or int(_size) < 0 else int(_size)
        _line = bytearray()
        while _limit is None or len(_line) < _limit:
            _value = _read_project_input_byte("/dev/stdin")
            if _value < 0:
                break
            _line.append(_value & 0xff)
            if _value == 10:
                break
        return bytes(_line).decode("utf-8", "replace")

class _TraceDeviceFile:
    def __init__(self, _device, _mode="r"):
        self._device = _device
        self._mode = str(_mode or "r")
        self._binary = "b" in self._mode
        self.closed = False

    def readable(self):
        return bool(_kernel_devices.get(self._device, {}).get("readable")) and (
            "r" in self._mode or "+" in self._mode
        )

    def writable(self):
        return bool(_kernel_devices.get(self._device, {}).get("writable")) and any(
            _marker in self._mode for _marker in ("w", "a", "x", "+")
        )

    def read(self, _size=-1):
        if not self.readable():
            raise OSError("Kernel device is not readable: " + self._device)
        _data = _read_project_input(self._device, _size)
        return _data if self._binary else _data.decode("utf-8", "replace")

    def readline(self, _size=-1):
        if not self.readable():
            raise OSError("Kernel device is not readable: " + self._device)
        _limit = None if _size is None or int(_size) < 0 else int(_size)
        _line = bytearray()
        while _limit is None or len(_line) < _limit:
            _value = _read_project_input_byte(self._device)
            if _value < 0:
                break
            _line.append(_value & 0xff)
            if _value == 10:
                break
        _data = bytes(_line)
        if self._binary:
            return _data
        return _data.decode("utf-8", "replace")

    def write(self, _value):
        if not self.writable():
            raise OSError("Kernel device is not writable: " + self._device)
        _output_device = str(_kernel_devices.get(self._device, {}).get("outputDevice") or self._device)
        if _output_device == "/dev/null":
            return len(_value) if self._binary and isinstance(_value, (bytes, bytearray)) else len(str(_value))
        _target = _stderr if _output_device == "/dev/stderr" else _stdout
        _data = _value if isinstance(_value, (bytes, bytearray)) else str(_value).encode("utf-8")
        _target.write(bytes(_data).decode("utf-8", "replace"), self._device, _output_device)
        return len(_data) if self._binary else len(str(_value))

    def writelines(self, _lines):
        for _line in _lines:
            self.write(_line)
        return None

    def flush(self):
        return None

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
        return False

class _TraceDeviceFdFile:
    def __init__(self, _fd, _mode="r"):
        self._fd = _fd
        self._mode = str(_mode or "r")
        self._binary = "b" in self._mode
        self._read_buffer = b""
        self.closed = False

    def readable(self):
        return "r" in self._mode or "+" in self._mode

    def writable(self):
        return "w" in self._mode or "a" in self._mode or "+" in self._mode

    def _read_bytes(self, _size=-1):
        if not self.readable():
            raise OSError("Kernel device is not readable")
        if _size is None or int(_size) < 0:
            _chunks = [self._read_buffer]
            self._read_buffer = b""
            while True:
                _chunk = os.read(self._fd, 8192)
                if not _chunk:
                    break
                _chunks.append(_chunk)
            return b"".join(_chunks)
        _length = int(_size)
        if _length <= 0:
            return b""
        _data = self._read_buffer[:_length]
        self._read_buffer = self._read_buffer[_length:]
        if len(_data) < _length:
            _data += os.read(self._fd, _length - len(_data))
        return _data

    def read(self, _size=-1):
        _data = self._read_bytes(_size)
        return _data if self._binary else _data.decode("utf-8", "replace")

    def readline(self, _size=-1):
        if not self.readable():
            raise OSError("Kernel device is not readable")
        _limit = None if _size is None or int(_size) < 0 else int(_size)
        _line = bytearray()
        while _limit is None or len(_line) < _limit:
            _byte = self._read_bytes(1)
            if not _byte:
                break
            _line.extend(_byte)
            if _byte == b"\\n":
                break
        _text = bytes(_line)
        if self._binary:
            return _text
        return _text.decode("utf-8", "replace")

    def write(self, _value):
        if not self.writable():
            raise OSError("Kernel device is not writable")
        _data = _value if isinstance(_value, (bytes, bytearray)) else str(_value).encode("utf-8")
        _written = os.write(self._fd, _data)
        return _written if self._binary else len(str(_value))

    def writelines(self, _lines):
        for _line in _lines:
            self.write(_line)
        return None

    def flush(self):
        return None

    def close(self):
        if not self.closed:
            self.closed = True
            os.close(self._fd)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
        return False

class _TraceProjectFile:
    def __init__(self, _handle, _absolute_path, _mutates):
        self._handle = _handle
        self._absolute_path = _absolute_path
        self._mutates = _mutates

    def _emit(self):
        if self._mutates:
            try:
                self._handle.flush()
            except Exception:
                pass
            try:
                os.fsync(self._handle.fileno())
            except Exception:
                pass
            _emit_file_change_for_absolute(self._absolute_path)

    def write(self, *args, **kwargs):
        _result = self._handle.write(*args, **kwargs)
        self._emit()
        return _result

    def writelines(self, *args, **kwargs):
        _result = self._handle.writelines(*args, **kwargs)
        self._emit()
        return _result

    def truncate(self, *args, **kwargs):
        _result = self._handle.truncate(*args, **kwargs)
        self._emit()
        return _result

    def flush(self):
        _result = self._handle.flush()
        self._emit()
        return _result

    def close(self):
        try:
            self._emit()
            self._handle.close()
        finally:
            self._emit()

    def __enter__(self):
        self._handle.__enter__()
        return self

    def __exit__(self, *args):
        self._emit()
        _result = self._handle.__exit__(*args)
        self._emit()
        return _result

    def __iter__(self):
        return iter(self._handle)

    def __getattr__(self, _name):
        return getattr(self._handle, _name)

_stdout = _TraceProjectStream("stdout")
_stderr = _TraceProjectStream("stderr")

def _is_project_module(_module):
    _module_file = getattr(_module, "__file__", None)
    return isinstance(_module_file, str) and _module_file.startswith(_root + os.sep)

def _clear_project_import_state():
    for _module_name, _module in list(sys.modules.items()):
        if _module_name not in _previous_modules or _is_project_module(_module):
            sys.modules.pop(_module_name, None)
    for _cache_path in list(sys.path_importer_cache.keys()):
        if isinstance(_cache_path, str) and (_cache_path == _root or _cache_path.startswith(_root + os.sep)):
            sys.path_importer_cache.pop(_cache_path, None)
    importlib.invalidate_caches()

def _project_path_entry(_entry):
    _entry = str(_entry).replace("\\\\", "/")
    if not _entry:
        return None
    if _entry == ".":
        return _root
    _relative_entry = _project_relative_from_virtual_path(_entry)
    if _relative_entry is not None:
        _entry = _relative_entry
        _absolute = os.path.abspath(os.path.join(_root, _entry))
    elif _entry.startswith("/tracecode_project"):
        return _entry
    elif _entry.startswith("/"):
        raise ValueError(f"Project path must stay within the workspace: {_entry}")
    else:
        _absolute = os.path.abspath(os.path.join(_active_project_cwd, _entry))
    if _absolute != _root and not _absolute.startswith(_root + os.sep):
        raise ValueError(f"Project path must stay within the workspace: {_entry}")
    return _absolute

def _project_relative_from_virtual_path(_path):
    _path = str(_path).replace("\\\\", "/").rstrip("/") or "/"
    if _path == _workspace_root:
        return ""
    if _path.startswith(_workspace_root + "/"):
        return _path[len(_workspace_root) + 1:]
    if _workspace_alias:
        if _path == _workspace_alias:
            return ""
        if _path.startswith(_workspace_alias + "/"):
            return _path[len(_workspace_alias) + 1:]
    return None

def _virtual_path_from_project_relative(_relative):
    if not _relative or _relative == ".":
        return _workspace_root
    return _workspace_root + "/" + str(_relative).replace(os.sep, "/")

def _project_pythonpath_entries():
    _entries = [_root]
    for _entry in str(_env.get("PYTHONPATH", "")).split(os.pathsep):
        _path = _project_path_entry(_entry)
        if _path and _path not in _entries:
            _entries.append(_path)
    return _entries

def _project_files_after_execution():
    _files = []
    _seen_paths = set()
    _seen_dirs = set()
    for _dirpath, _dirnames, _filenames in os.walk(_root, followlinks=False):
        _dirpath = _project_snapshot_absolute_path(_dirpath)
        if _dirpath is None or not os.path.isdir(_dirpath):
            _dirnames[:] = []
            continue
        _directory_key = _project_snapshot_directory_key(_dirpath)
        if _directory_key in _seen_dirs:
            _dirnames[:] = []
            continue
        _seen_dirs.add(_directory_key)
        _safe_dirnames = []
        for _dirname in _dirnames:
            _child_path = os.path.join(_dirpath, _dirname)
            if _project_snapshot_absolute_path(_child_path) is not None and os.path.isdir(_child_path):
                _safe_dirnames.append(_dirname)
        _dirnames[:] = sorted(_safe_dirnames)
        for _filename in sorted(_filenames):
            _absolute_path = os.path.join(_dirpath, _filename)
            _absolute_path = _project_snapshot_absolute_path(_absolute_path)
            if _absolute_path is None or not os.path.isfile(_absolute_path):
                continue
            _relative_path = os.path.relpath(_absolute_path, _root).replace(os.sep, "/")
            _seen_paths.add(_relative_path)
            with open(_absolute_path, "rb") as _handle:
                _contents = _handle.read()
            if _original_file_bytes.get(_relative_path) == _contents:
                continue
            try:
                _text = _contents.decode("utf-8")
                _files.append({"path": _relative_path, "contents": _text})
            except UnicodeDecodeError:
                _files.append({
                    "path": _relative_path,
                    "contents": base64.b64encode(_contents).decode("ascii"),
                    "encoding": "base64",
                })
    for _relative_path in sorted(_original_file_bytes.keys()):
        if _relative_path not in _seen_paths:
            _files.append({"path": _relative_path, "deleted": True})
    return _files

def _project_cwd():
    _request_cwd_value = str(_request.get("cwd") or _workspace_root).replace("\\\\", "/").rstrip("/") or "/"
    _relative_cwd = _project_relative_from_virtual_path(_request_cwd_value)
    if _relative_cwd is not None:
        _parts = [part for part in _relative_cwd.split("/") if part and part != "."]
        if ".." not in _parts:
            return os.path.join(_root, *_parts)
    if _request_cwd_value == _root or _request_cwd_value.startswith(_root + "/"):
        return _request_cwd_value
    raise ValueError(f"Project cwd must stay inside the workspace: {_request_cwd_value}")

def _project_script_absolute_path():
    _raw_path = _script_path.replace("\\\\", "/")
    _relative_script_path = _project_relative_from_virtual_path(_raw_path)
    if _relative_script_path == "":
        raise ValueError(f"Project path must point to a file: {_script_path}")
    if _relative_script_path is not None:
        _absolute = os.path.abspath(os.path.join(_root, _relative_script_path))
    elif _raw_path.startswith("/"):
        raise ValueError(f"Project path must stay within the workspace: {_script_path}")
    else:
        _workspace_absolute = os.path.abspath(os.path.join(_root, _raw_path))
        if (
            _workspace_absolute != _root
            and _workspace_absolute.startswith(_root + os.sep)
            and os.path.exists(_workspace_absolute)
        ):
            _absolute = _workspace_absolute
        else:
            _absolute = os.path.abspath(os.path.join(_active_project_cwd, _raw_path))
    if _absolute == _root or not _absolute.startswith(_root + os.sep):
        raise ValueError(f"Project path must stay within the workspace: {_script_path}")
    return _absolute

def _map_workspace_path(_value):
    if isinstance(_value, (str, bytes, os.PathLike)):
        _original = os.fspath(_value)
        _relative_path = _project_relative_from_virtual_path(_original)
        if _relative_path is not None:
            return os.path.join(_root, _relative_path)
    return _value

_kernel_info = _project_info.get("kernel") if isinstance(_project_info.get("kernel"), dict) else {
    "name": "tracekernel",
    "version": "0.0.0",
    "workspaceRoot": _workspace_root,
    "workspace": {"name": _workspace_root.rstrip("/").split("/")[-1] or "workspace", "root": _workspace_root},
}

_kernel_devices = {}
_kernel_device_entries = _project_info.get("kernelDevices", [])
if not isinstance(_kernel_device_entries, list):
    _kernel_device_entries = []
for _entry in _kernel_device_entries:
    if not isinstance(_entry, dict):
        continue
    _path = str(_entry.get("path", "")).replace("\\\\", "/").rstrip("/")
    if _path.startswith("/dev/"):
        _kernel_devices[_path] = {
            "readable": bool(_entry.get("readable")),
            "writable": bool(_entry.get("writable")),
            "inputDevice": str(_entry.get("inputDevice") or ""),
            "outputDevice": str(_entry.get("outputDevice") or ""),
        }

_device_directories = {"/dev"}
for _device_path in _kernel_devices:
    _parts = [part for part in _device_path.split("/") if part]
    _current = ""
    for _part in _parts[:-1]:
        _current += "/" + _part
        _device_directories.add(_current)

def _canonical_virtual_namespace_path(_value):
    if not isinstance(_value, (str, bytes, os.PathLike)):
        return None
    _text = os.fspath(_value).replace("\\\\", "/")
    if not _text.startswith("/"):
        try:
            _text = os.path.join(os.getcwd(), _text).replace("\\\\", "/")
        except Exception:
            _text = "/" + _text
    _parts = []
    for _part in _text.split("/"):
        if not _part or _part == ".":
            continue
        if _part == "..":
            if _parts:
                _parts.pop()
            continue
        _parts.append(_part)
    return "/" + "/".join(_parts)

def _normalize_device_path(_value):
    _original = _canonical_virtual_namespace_path(_value)
    if _original in _kernel_devices:
        return _original
    return None

def _normalize_device_namespace_path(_value):
    _original = _canonical_virtual_namespace_path(_value)
    if _original == "/dev" or (isinstance(_original, str) and _original.startswith("/dev/")):
        return _original
    return None

def _device_entry_kind(_path):
    if _path in _device_directories:
        return "directory"
    if _path in _kernel_devices:
        return "file"
    return None

def _device_dir_entries(_path):
    if _path not in _device_directories:
        return None
    _prefix = _path.rstrip("/") + "/"
    _names = set()
    for _directory in _device_directories:
        if not _directory.startswith(_prefix) or _directory == _path:
            continue
        _rest = _directory[len(_prefix):]
        if _rest and "/" not in _rest:
            _names.add(_rest)
    for _device_path in _kernel_devices:
        if not _device_path.startswith(_prefix):
            continue
        _rest = _device_path[len(_prefix):]
        if _rest and "/" not in _rest:
            _names.add(_rest)
    return sorted(_names)

def _device_info_for_path(_path):
    if _path in _kernel_devices:
        return _kernel_devices.get(_path, {})
    return {"readable": True, "writable": False}

def _device_stat(_path):
    _kind = _device_entry_kind(_path)
    if _kind is None:
        raise FileNotFoundError(_path)
    _mode = (stat.S_IFDIR | 0o755) if _kind == "directory" else (stat.S_IFCHR | 0o666)
    return os.stat_result((_mode, 0, 0, 2 if _kind == "directory" else 1, 0, 0, 0, 0, 0, 0))

def _normalize_proc_path(_value):
    _original = _canonical_virtual_namespace_path(_value)
    if _original == "/proc" or (isinstance(_original, str) and _original.startswith("/proc/")):
        return _original
    return None

def _decode_kernel_file_text(_file):
    if not isinstance(_file, dict):
        return None
    _path = str(_file.get("path", "")).replace("\\\\", "/").rstrip("/")
    if not _path.startswith("/proc/"):
        return None
    if _file.get("encoding") == "base64":
        return base64.b64decode(str(_file.get("contents", ""))).decode("utf-8", "replace")
    return str(_file.get("contents", ""))

def _proc_mountinfo():
    _workspace_name = str((_kernel_info.get("workspace") or {}).get("name") or "workspace")
    _lines = [
        f"24 0 0:1 / {_workspace_root} rw,relatime - tracefs tracekernel:workspace rw,name={_workspace_name}",
        "25 0 0:2 / /dev rw,nosuid - tracefs tracekernel:dev rw,mode=755",
        "26 0 0:3 / /proc rw,nosuid,nodev,noexec - tracefs tracekernel:proc rw",
    ]
    if _workspace_alias:
        _lines.insert(1, f"27 24 0:1 / {_workspace_alias} rw,relatime alias={_workspace_root} - tracefs tracekernel:workspace rw,name={_workspace_name}")
    return "\\n".join(_lines) + "\\n"

_proc_files = {}
_kernel_files = _project_info.get("kernelFiles", [])
if not isinstance(_kernel_files, list):
    _kernel_files = []
for _kernel_file in _kernel_files:
    _decoded_text = _decode_kernel_file_text(_kernel_file)
    if _decoded_text is not None:
        _proc_files[str(_kernel_file.get("path", "")).replace("\\\\", "/").rstrip("/")] = _decoded_text
if not _proc_files:
    _proc_files["/proc/kernel/info"] = json.dumps(_kernel_info, indent=2) + "\\n"
    _proc_files["/proc/self/mountinfo"] = _proc_mountinfo()

_proc_directories = {"/proc"}
for _proc_file_path in _proc_files:
    _parts = [part for part in _proc_file_path.split("/") if part]
    _current = ""
    for _part in _parts[:-1]:
        _current += "/" + _part
        _proc_directories.add(_current)

def _proc_entry_kind(_path):
    if _path in _proc_directories:
        return "directory"
    if _path in _proc_files:
        return "file"
    return None

def _proc_dir_entries(_path):
    if _path not in _proc_directories:
        return None
    _prefix = _path.rstrip("/") + "/"
    _names = set()
    for _directory in _proc_directories:
        if not _directory.startswith(_prefix) or _directory == _path:
            continue
        _rest = _directory[len(_prefix):]
        if _rest and "/" not in _rest:
            _names.add(_rest)
    for _file_path in _proc_files:
        if not _file_path.startswith(_prefix):
            continue
        _rest = _file_path[len(_prefix):]
        if _rest and "/" not in _rest:
            _names.add(_rest)
    return sorted(_names)

def _proc_read_text(_path):
    if _path in _proc_files:
        return _proc_files[_path]
    if _proc_entry_kind(_path) == "directory":
        raise IsADirectoryError(_path)
    raise FileNotFoundError(_path)

def _proc_stat(_path):
    _kind = _proc_entry_kind(_path)
    if _kind is None:
        raise FileNotFoundError(_path)
    _mode = (stat.S_IFDIR | 0o555) if _kind == "directory" else (stat.S_IFREG | 0o444)
    _size = 0 if _kind == "directory" else len(_proc_read_text(_path).encode("utf-8"))
    return os.stat_result((_mode, 0, 0, 2 if _kind == "directory" else 1, 0, 0, _size, 0, 0, 0))

class _TraceDirEntry:
    def __init__(self, _parent, _name, _kind_fn, _stat_fn):
        self.name = _name
        self.path = (_parent.rstrip("/") + "/" + _name) if _parent != "/" else "/" + _name
        self._kind_fn = _kind_fn
        self._stat_fn = _stat_fn

    def is_dir(self, *args, **kwargs):
        return self._kind_fn(self.path) == "directory"

    def is_file(self, *args, **kwargs):
        return self._kind_fn(self.path) == "file"

    def is_symlink(self):
        return False

    def stat(self, *args, **kwargs):
        return self._stat_fn(self.path)

    def inode(self):
        return 0

    def __fspath__(self):
        return self.path

class _TraceScandirIterator:
    def __init__(self, _entries):
        self._entries = list(_entries)
        self._index = 0
        self._closed = False

    def __iter__(self):
        return self

    def __next__(self):
        if self._closed or self._index >= len(self._entries):
            raise StopIteration
        _entry = self._entries[self._index]
        self._index += 1
        return _entry

    def close(self):
        self._closed = True
        self._entries = []

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.close()
        return False

def _virtual_scandir(_path, _entries_fn, _kind_fn, _stat_fn):
    _entries = _entries_fn(_path)
    if _entries is None:
        if _kind_fn(_path) is None:
            raise FileNotFoundError(_path)
        raise NotADirectoryError(_path)
    return _TraceScandirIterator(_TraceDirEntry(_path, _name, _kind_fn, _stat_fn) for _name in _entries)

class _TraceProcFile:
    def __init__(self, _path, _mode="r"):
        self._path = _path
        self._mode = str(_mode or "r")
        self._binary = "b" in self._mode
        self._handle = io.BytesIO(_proc_read_text(_path).encode("utf-8")) if self._binary else io.StringIO(_proc_read_text(_path))
        self.closed = False

    def readable(self):
        return True

    def writable(self):
        return False

    def read(self, *args):
        return self._handle.read(*args)

    def readline(self, *args):
        return self._handle.readline(*args)

    def __iter__(self):
        return iter(self._handle)

    def write(self, *_args, **_kwargs):
        raise OSError("Kernel proc path is read-only: " + self._path)

    def flush(self):
        return None

    def close(self):
        self.closed = True
        return self._handle.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
        return False

    def __getattr__(self, _name):
        return getattr(self._handle, _name)

class _TraceProcFdFile:
    def __init__(self, _fd, _mode="r"):
        self._fd = _fd
        self._mode = str(_mode or "r")
        self._binary = "b" in self._mode
        self._read_buffer = b""
        self.closed = False

    def readable(self):
        return True

    def writable(self):
        return False

    def _read_bytes(self, _size=-1):
        if _size is None or int(_size) < 0:
            _chunks = [self._read_buffer]
            self._read_buffer = b""
            while True:
                _chunk = os.read(self._fd, 8192)
                if not _chunk:
                    break
                _chunks.append(_chunk)
            return b"".join(_chunks)
        _length = int(_size)
        if _length <= 0:
            return b""
        _data = self._read_buffer[:_length]
        self._read_buffer = self._read_buffer[_length:]
        if len(_data) < _length:
            _data += os.read(self._fd, _length - len(_data))
        return _data

    def read(self, _size=-1):
        _data = self._read_bytes(_size)
        return _data if self._binary else _data.decode("utf-8", "replace")

    def readline(self, _size=-1):
        _limit = None if _size is None or int(_size) < 0 else int(_size)
        _line = bytearray()
        while _limit is None or len(_line) < _limit:
            _byte = self._read_bytes(1)
            if not _byte:
                break
            _line.extend(_byte)
            if _byte == b"\\n":
                break
        _text = bytes(_line)
        if self._binary:
            return _text
        return _text.decode("utf-8", "replace")

    def write(self, *_args, **_kwargs):
        raise OSError("Kernel proc path is read-only")

    def flush(self):
        return None

    def close(self):
        if not self.closed:
            self.closed = True
            os.close(self._fd)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
        return False

def _is_mutating_file_mode(_mode):
    _mode_text = str(_mode or "r")
    return any(_marker in _mode_text for _marker in ("w", "a", "x", "+"))

def _file_mode_wants_read(_mode):
    _mode_text = str(_mode or "r")
    return "r" in _mode_text or "+" in _mode_text or not any(_marker in _mode_text for _marker in ("w", "a", "x"))

def _file_mode_wants_write(_mode):
    _mode_text = str(_mode or "r")
    return any(_marker in _mode_text for _marker in ("w", "a", "x", "+"))

def _is_mutating_fd_flags(_flags):
    try:
        _flag_value = int(_flags)
    except Exception:
        return False
    return bool(
        (_flag_value & getattr(os, "O_WRONLY", 0)) or
        (_flag_value & getattr(os, "O_RDWR", 0)) or
        (_flag_value & getattr(os, "O_CREAT", 0)) or
        (_flag_value & getattr(os, "O_TRUNC", 0)) or
        (_flag_value & getattr(os, "O_APPEND", 0))
    )

def _fd_flags_want_write(_flags):
    try:
        _flag_value = int(_flags)
    except Exception:
        return False
    return bool((_flag_value & getattr(os, "O_WRONLY", 0)) or (_flag_value & getattr(os, "O_RDWR", 0)))

def _fd_flags_want_read(_flags):
    try:
        _flag_value = int(_flags)
    except Exception:
        return True
    return bool(_flag_value & getattr(os, "O_RDWR", 0)) or not bool(_flag_value & getattr(os, "O_WRONLY", 0))

def _kernel_open_request_for_mode(_mode):
    _mode_text = str(_mode or "r")
    return {
        "readable": _file_mode_wants_read(_mode),
        "writable": _file_mode_wants_write(_mode),
        "create": any(_marker in _mode_text for _marker in ("w", "a", "x")),
        "truncate": "w" in _mode_text,
        "exclusive": "x" in _mode_text,
    }

def _kernel_open_request_for_flags(_flags):
    try:
        _flag_value = int(_flags)
    except Exception:
        _flag_value = 0
    return {
        "readable": _fd_flags_want_read(_flags),
        "writable": _fd_flags_want_write(_flags) or _is_mutating_fd_flags(_flags),
        "create": bool(_flag_value & getattr(os, "O_CREAT", 0)),
        "truncate": bool(_flag_value & getattr(os, "O_TRUNC", 0)),
        "exclusive": bool(_flag_value & getattr(os, "O_EXCL", 0)),
    }

def _fallback_kernel_open_target(_path, _request):
    _device_path = _normalize_device_namespace_path(_path)
    if _device_path:
        if _device_entry_kind(_device_path) == "directory":
            return {"kind": "error", "reason": "is-directory", "path": _device_path}
        _device_info = _kernel_devices.get(_device_path)
        if not _device_info:
            return {"kind": "error", "reason": "not-found", "path": _device_path}
        return {
            "kind": "device",
            "device": _device_path,
            "readable": bool(_device_info.get("readable")) and bool(_request.get("readable")),
            "writable": bool(_device_info.get("writable")) and bool(_request.get("writable")),
        }
    _proc_path = _normalize_proc_path(_path)
    if _proc_path:
        _entry_kind = _proc_entry_kind(_proc_path)
        if _entry_kind == "directory":
            return {"kind": "error", "reason": "is-directory", "path": _proc_path}
        if _entry_kind != "file":
            return {"kind": "error", "reason": "not-found", "path": _proc_path}
        if any(bool(_request.get(_field)) for _field in ("writable", "create", "truncate", "exclusive")):
            return {"kind": "error", "reason": "read-only", "path": _proc_path}
        return {"kind": "proc-file", "path": _proc_path, "readable": True, "writable": False}
    return {"kind": "workspace", "path": os.fspath(_path) if isinstance(_path, (str, bytes, os.PathLike)) else str(_path)}

def _kernel_open_target(_path, _request):
    _device_path = _normalize_device_namespace_path(_path)
    _proc_path = _normalize_proc_path(_path)
    _virtual_path = _device_path or _proc_path
    if not _virtual_path:
        return {"kind": "workspace", "path": os.fspath(_path) if isinstance(_path, (str, bytes, os.PathLike)) else str(_path)}
    try:
        return json.loads(_js_self.__tracecodeRuntimeKernelOpenTarget(json.dumps({
            "path": _virtual_path,
            "request": _request,
            "procEntryKind": _proc_entry_kind(_proc_path) if _proc_path else None,
        })))
    except Exception:
        return _fallback_kernel_open_target(_virtual_path, _request)

def _fallback_kernel_mutation_target(_path):
    _device_path = _normalize_device_namespace_path(_path)
    if _device_path:
        if _device_entry_kind(_device_path) is None:
            return {"kind": "error", "reason": "device-not-found", "path": _device_path}
        return {"kind": "error", "reason": "device-read-only", "path": _device_path}
    _proc_path = _normalize_proc_path(_path)
    if _proc_path:
        return {"kind": "error", "reason": "proc-read-only", "path": _proc_path}
    return {"kind": "workspace", "path": os.fspath(_path) if isinstance(_path, (str, bytes, os.PathLike)) else str(_path)}

def _kernel_mutation_target(_path):
    _device_path = _normalize_device_namespace_path(_path)
    _proc_path = _normalize_proc_path(_path)
    _virtual_path = _device_path or _proc_path
    if not _virtual_path:
        return {"kind": "workspace", "path": os.fspath(_path) if isinstance(_path, (str, bytes, os.PathLike)) else str(_path)}
    try:
        return json.loads(_js_self.__tracecodeRuntimeKernelMutationTarget(json.dumps({"path": _virtual_path})))
    except Exception:
        return _fallback_kernel_mutation_target(_virtual_path)

def _reject_kernel_mutation(_path, _operation):
    _target = _kernel_mutation_target(_path)
    if _target.get("kind") != "error":
        return
    _reason = str(_target.get("reason", ""))
    _target_path = str(_target.get("path", os.fspath(_path) if isinstance(_path, (str, bytes, os.PathLike)) else _path))
    if _reason in ("device-not-found", "not-found"):
        raise FileNotFoundError(_target_path)
    if _reason in ("proc-read-only", "kernel-read-only"):
        raise OSError("Kernel proc path is read-only: " + _target_path)
    raise OSError("Kernel device namespace is read-only: " + _target_path)

def _virtual_workspace_path(_value):
    if isinstance(_value, str):
        _relative = os.path.relpath(_value, _root)
        if _relative == ".":
            return _workspace_root
        if not _relative.startswith("..") and not os.path.isabs(_relative):
            return _virtual_path_from_project_relative(_relative)
    return _value

def _install_virtual_workspace_paths():
    _original_open = builtins.open
    _original_io_open = io.open
    _original_getcwd = os.getcwd
    _original_chdir = os.chdir
    _original_os_open = os.open
    _original_os_read = os.read
    _original_os_readv = getattr(os, "readv", None)
    _original_os_write = os.write
    _original_os_writev = getattr(os, "writev", None)
    _original_os_close = os.close
    _original_os_dup = getattr(os, "dup", None)
    _original_os_dup2 = getattr(os, "dup2", None)
    _original_os_truncate = getattr(os, "truncate", None)
    _original_os_ftruncate = getattr(os, "ftruncate", None)
    _original_os_fchmod = getattr(os, "fchmod", None)
    _original_os_fchown = getattr(os, "fchown", None)
    _original_os_statvfs = getattr(os, "statvfs", None)
    _open_file_descriptors = {}
    _workspace_file_descriptors = {}
    _device_file_descriptors = {}
    _proc_file_descriptors = {}
    _next_virtual_fd = 1000000
    _patched = []

    def _absolute_mapped_path(_path):
        if not isinstance(_path, (str, bytes, os.PathLike)):
            return None
        _file_path = os.fspath(_path)
        if os.path.isabs(_file_path):
            return os.path.abspath(_file_path)
        return os.path.abspath(os.path.join(_original_getcwd(), _file_path))

    def _patched_open(_file, *args, **kwargs):
        _mode = args[0] if args else kwargs.get("mode", "r")
        if isinstance(_file, int):
            if _file in _device_file_descriptors:
                return _TraceDeviceFdFile(_file, _mode)
            if _file in _proc_file_descriptors:
                if _is_mutating_file_mode(_mode):
                    raise OSError("Kernel proc path is read-only")
                return _TraceProcFdFile(_file, _mode)
            _handle = _original_open(_file, *args, **kwargs)
            return _TraceProjectFile(_handle, _open_file_descriptors.get(_file), _is_mutating_file_mode(_mode))
        _open_target = _kernel_open_target(_file, _kernel_open_request_for_mode(_mode))
        if _open_target.get("kind") == "device":
            _device = str(_open_target.get("device") or "")
            if _file_mode_wants_read(_mode) and not bool(_open_target.get("readable")):
                raise OSError("Kernel device is not readable: " + _device)
            if _file_mode_wants_write(_mode) and not bool(_open_target.get("writable")):
                raise OSError("Kernel device is not writable: " + _device)
            return _TraceDeviceFile(_device, _mode)
        if _open_target.get("kind") == "proc-file":
            return _TraceProcFile(str(_open_target.get("path")), _mode)
        if _open_target.get("kind") == "error":
            _reason = str(_open_target.get("reason") or "")
            _path = str(_open_target.get("path") or _file)
            if _reason == "is-directory":
                raise IsADirectoryError(_path)
            if _reason == "read-only":
                raise OSError("Kernel proc path is read-only: " + _path)
            raise FileNotFoundError(_path)
        _mapped_path = _map_workspace_path(_file)
        _handle = _original_open(_mapped_path, *args, **kwargs)
        return _TraceProjectFile(_handle, _absolute_mapped_path(_mapped_path), _is_mutating_file_mode(_mode))

    def _patched_getcwd():
        return _virtual_workspace_path(_original_getcwd())

    def _patched_chdir(_path):
        return _original_chdir(_map_workspace_path(_path))

    def _patched_os_open(_path, _flags, *args, **kwargs):
        nonlocal _next_virtual_fd
        _open_target = _kernel_open_target(_path, _kernel_open_request_for_flags(_flags))
        if _open_target.get("kind") == "device":
            _device = str(_open_target.get("device") or "")
            _wants_read = _fd_flags_want_read(_flags)
            _wants_write = _fd_flags_want_write(_flags) or _is_mutating_fd_flags(_flags)
            if _wants_read and not bool(_open_target.get("readable")):
                raise OSError("Kernel device is not readable: " + _device)
            if _wants_write and not bool(_open_target.get("writable")):
                raise OSError("Kernel device is not writable: " + _device)
            _fd = _next_virtual_fd
            _next_virtual_fd += 1
            _device_descriptor = {"device": _device}
            if _wants_read:
                _device_descriptor.update({"inputDevice": _device})
            _device_file_descriptors[_fd] = _device_descriptor
            return _fd
        if _open_target.get("kind") == "proc-file":
            _proc_path = str(_open_target.get("path"))
            _fd = _next_virtual_fd
            _next_virtual_fd += 1
            _proc_file_descriptors[_fd] = {
                "path": _proc_path,
                "handle": io.BytesIO(_proc_read_text(_proc_path).encode("utf-8")),
                "refs": 1,
            }
            return _fd
        if _open_target.get("kind") == "error":
            _reason = str(_open_target.get("reason") or "")
            _path_text = str(_open_target.get("path") or _path)
            if _reason == "is-directory":
                raise IsADirectoryError(_path_text)
            if _reason == "read-only":
                raise OSError("Kernel proc path is read-only: " + _path_text)
            raise FileNotFoundError(_path_text)
        _mapped_path = _map_workspace_path(_path)
        _absolute_path = _absolute_mapped_path(_mapped_path)
        _fd = _original_os_open(_mapped_path, _flags, *args, **kwargs)
        if _absolute_path:
            _workspace_file_descriptors[_fd] = _absolute_path
            if _is_mutating_fd_flags(_flags):
                _open_file_descriptors[_fd] = _absolute_path
                _emit_file_change_for_absolute(_absolute_path)
        return _fd

    def _patched_os_read(_fd, _length):
        _device_descriptor = _device_file_descriptors.get(_fd)
        if _device_descriptor is not None:
            _device = str(_device_descriptor.get("device", ""))
            if not bool(_kernel_devices.get(_device, {}).get("readable")):
                raise OSError("Kernel device is not readable: " + str(_device_descriptor.get("device", "")))
            return _read_project_input(_device, _length)
        _proc_handle = _proc_file_descriptors.get(_fd)
        if _proc_handle is not None:
            return _proc_handle.get("handle").read(_length)
        return _original_os_read(_fd, _length)

    def _patched_os_readv(_fd, _buffers):
        _device_descriptor = _device_file_descriptors.get(_fd)
        _proc_handle = _proc_file_descriptors.get(_fd)
        if _device_descriptor is None and _proc_handle is None:
            return _original_os_readv(_fd, _buffers)
        _total_length = sum(len(_buffer) for _buffer in _buffers)
        if _device_descriptor is not None:
            _device = str(_device_descriptor.get("device", ""))
            if not bool(_kernel_devices.get(_device, {}).get("readable")):
                raise OSError("Kernel device is not readable: " + str(_device_descriptor.get("device", "")))
            _data = _read_project_input(_device, _total_length)
        else:
            _data = _proc_handle.get("handle").read(_total_length)
        _offset = 0
        for _buffer in _buffers:
            if _offset >= len(_data):
                break
            _chunk = _data[_offset:_offset + len(_buffer)]
            _buffer[:len(_chunk)] = _chunk
            _offset += len(_chunk)
        return len(_data)

    def _patched_os_write(_fd, _data):
        _device_descriptor = _device_file_descriptors.get(_fd)
        if _device_descriptor is not None:
            _device = str(_device_descriptor.get("device", ""))
            _device_info = _kernel_devices.get(_device, {})
            _output_device = str(_device_info.get("outputDevice") or "")
            if not _output_device:
                raise OSError("Kernel device is not writable: " + _device)
            _bytes = bytes(_data)
            if _output_device == "/dev/null":
                return len(_bytes)
            _target = _stderr if _output_device == "/dev/stderr" else _stdout
            _target.write(_bytes.decode("utf-8", "replace"), _device, _output_device)
            return len(_bytes)
        if _fd in _proc_file_descriptors:
            raise OSError("Kernel proc path is read-only")
        _result = _original_os_write(_fd, _data)
        _absolute_path = _open_file_descriptors.get(_fd)
        if _absolute_path:
            _emit_file_change_for_absolute(_absolute_path)
        return _result

    def _patched_os_writev(_fd, _buffers):
        _device_descriptor = _device_file_descriptors.get(_fd)
        if _device_descriptor is not None:
            return _patched_os_write(_fd, b"".join(bytes(_buffer) for _buffer in _buffers))
        if _fd in _proc_file_descriptors:
            raise OSError("Kernel proc path is read-only")
        _result = _original_os_writev(_fd, _buffers)
        _absolute_path = _open_file_descriptors.get(_fd)
        if _absolute_path:
            _emit_file_change_for_absolute(_absolute_path)
        return _result

    def _patched_os_close(_fd):
        if _fd in _device_file_descriptors:
            _device_file_descriptors.pop(_fd, None)
            return None
        _proc_handle = _proc_file_descriptors.pop(_fd, None)
        if _proc_handle is not None:
            _proc_handle["refs"] = max(0, int(_proc_handle.get("refs", 1)) - 1)
            if int(_proc_handle.get("refs", 0)) == 0:
                _proc_handle.get("handle").close()
            return None
        _absolute_path = _open_file_descriptors.pop(_fd, None)
        _workspace_file_descriptors.pop(_fd, None)
        try:
            return _original_os_close(_fd)
        finally:
            if _absolute_path:
                _emit_file_change_for_absolute(_absolute_path)

    def _virtual_descriptor_kind(_fd):
        if _fd in _device_file_descriptors:
            return "device"
        if _fd in _proc_file_descriptors:
            return "proc"
        return None

    def _register_virtual_fd_duplicate(_old_fd, _new_fd):
        nonlocal _next_virtual_fd
        _kind = _virtual_descriptor_kind(_old_fd)
        if _kind == "device":
            _device_file_descriptors[_new_fd] = _device_file_descriptors[_old_fd]
        elif _kind == "proc":
            _proc_descriptor = _proc_file_descriptors[_old_fd]
            _proc_descriptor["refs"] = int(_proc_descriptor.get("refs", 1)) + 1
            _proc_file_descriptors[_new_fd] = _proc_descriptor
        else:
            raise OSError("Bad file descriptor")
        if _new_fd >= _next_virtual_fd:
            _next_virtual_fd = _new_fd + 1
        return _new_fd

    def _close_virtual_target_fd(_fd):
        if _virtual_descriptor_kind(_fd) is not None:
            _patched_os_close(_fd)
            return True
        return False

    def _patched_os_dup(_fd):
        nonlocal _next_virtual_fd
        if _virtual_descriptor_kind(_fd) is not None:
            _new_fd = _next_virtual_fd
            _next_virtual_fd += 1
            return _register_virtual_fd_duplicate(_fd, _new_fd)
        _new_fd = _original_os_dup(_fd)
        if _fd in _workspace_file_descriptors:
            _workspace_file_descriptors[_new_fd] = _workspace_file_descriptors[_fd]
        if _fd in _open_file_descriptors:
            _open_file_descriptors[_new_fd] = _open_file_descriptors[_fd]
        return _new_fd

    def _patched_os_dup2(_fd, _fd2, _inheritable=True):
        if _fd == _fd2:
            if _virtual_descriptor_kind(_fd) is not None:
                return _fd2
            try:
                return _original_os_dup2(_fd, _fd2, inheritable=_inheritable)
            except TypeError:
                return _original_os_dup2(_fd, _fd2)
        _close_virtual_target_fd(_fd2)
        if _virtual_descriptor_kind(_fd) is not None:
            return _register_virtual_fd_duplicate(_fd, _fd2)
        try:
            _new_fd = _original_os_dup2(_fd, _fd2, inheritable=_inheritable)
        except TypeError:
            _new_fd = _original_os_dup2(_fd, _fd2)
        if _fd in _workspace_file_descriptors:
            _workspace_file_descriptors[_new_fd] = _workspace_file_descriptors[_fd]
        if _fd in _open_file_descriptors:
            _open_file_descriptors[_new_fd] = _open_file_descriptors[_fd]
        return _new_fd

    def _patched_os_truncate(_path, _length):
        _reject_kernel_mutation(_path, "truncate")
        _mapped_path = _map_workspace_path(_path)
        _absolute_path = _absolute_mapped_path(_mapped_path)
        _result = _original_os_truncate(_mapped_path, _length)
        _emit_file_change_for_absolute(_absolute_path)
        return _result

    def _patched_os_ftruncate(_fd, _length):
        if _fd in _device_file_descriptors:
            raise OSError("Kernel device is not truncateable: " + str(_device_file_descriptors[_fd].get("device", "")))
        if _fd in _proc_file_descriptors:
            raise OSError("Kernel proc path is read-only")
        _result = _original_os_ftruncate(_fd, _length)
        _absolute_path = _open_file_descriptors.get(_fd)
        if _absolute_path:
            _emit_file_change_for_absolute(_absolute_path)
        return _result

    def _patched_os_fchmod(_fd, _mode):
        if _fd in _device_file_descriptors:
            return None
        if _fd in _proc_file_descriptors:
            raise OSError("Kernel proc path is read-only")
        _result = _original_os_fchmod(_fd, _mode)
        _absolute_path = _workspace_file_descriptors.get(_fd)
        if _absolute_path:
            _emit_path_snapshot_for_absolute(_absolute_path)
        return _result

    def _patched_os_fchown(_fd, _uid, _gid):
        if _fd in _device_file_descriptors:
            return None
        if _fd in _proc_file_descriptors:
            raise OSError("Kernel proc path is read-only")
        _result = _original_os_fchown(_fd, _uid, _gid)
        _absolute_path = _workspace_file_descriptors.get(_fd)
        if _absolute_path:
            _emit_path_snapshot_for_absolute(_absolute_path)
        return _result

    def _virtual_statvfs_result(_read_only=False):
        _block_size = 4096
        _blocks = 1048576
        _free = 1048000
        _files = 1000000
        _file_free = 999000
        _flag = getattr(os, "ST_RDONLY", 1) if _read_only else 0
        return os.statvfs_result((_block_size, _block_size, _blocks, _free, _free, _files, _file_free, _file_free, _flag, 255))

    def _patched_os_statvfs(_path):
        _device_path = _normalize_device_namespace_path(_path)
        if _device_path:
            if _device_entry_kind(_device_path) is None:
                raise FileNotFoundError(_device_path)
            return _virtual_statvfs_result(False)
        _proc_path = _normalize_proc_path(_path)
        if _proc_path:
            if _proc_entry_kind(_proc_path) is None:
                raise FileNotFoundError(_proc_path)
            return _virtual_statvfs_result(True)
        return _original_os_statvfs(_map_workspace_path(_path))

    builtins.open = _patched_open
    io.open = _patched_open
    os.getcwd = _patched_getcwd
    os.chdir = _patched_chdir
    os.open = _patched_os_open
    os.read = _patched_os_read
    if _original_os_readv is not None:
        os.readv = _patched_os_readv
    os.write = _patched_os_write
    if _original_os_writev is not None:
        os.writev = _patched_os_writev
    os.close = _patched_os_close
    if _original_os_dup is not None:
        os.dup = _patched_os_dup
    if _original_os_dup2 is not None:
        os.dup2 = _patched_os_dup2
    if _original_os_truncate is not None:
        os.truncate = _patched_os_truncate
    if _original_os_ftruncate is not None:
        os.ftruncate = _patched_os_ftruncate
    if _original_os_fchmod is not None:
        os.fchmod = _patched_os_fchmod
    if _original_os_fchown is not None:
        os.fchown = _patched_os_fchown
    if _original_os_statvfs is not None:
        os.statvfs = _patched_os_statvfs

    def _patch_one(_target, _name):
        _original = getattr(_target, _name, None)
        if _original is None:
            return
        def _patched_one(_path, *args, **kwargs):
            _device_path = _normalize_device_namespace_path(_path)
            if _device_path:
                _kind = _device_entry_kind(_device_path)
                if _name in ("chmod", "chown", "mkdir", "makedirs", "remove", "removedirs", "rmdir", "unlink", "utime"):
                    _reject_kernel_mutation(_path, _name)
                if _name in ("exists", "lexists"):
                    return _kind is not None
                if _name == "isfile":
                    return _kind == "file"
                if _name == "isdir":
                    return _kind == "directory"
                if _name == "islink":
                    return False
                if _name == "ismount":
                    return _device_path == "/dev"
                if _name == "listdir":
                    _entries = _device_dir_entries(_device_path)
                    if _entries is None:
                        if _kind is None:
                            raise FileNotFoundError(_device_path)
                        raise NotADirectoryError(_device_path)
                    return _entries
                if _name in ("stat", "lstat"):
                    return _device_stat(_device_path)
                if _name == "access":
                    if _kind is None:
                        return False
                    _mode = int(args[0]) if args else int(kwargs.get("mode", os.F_OK))
                    if _kind == "directory":
                        return (_mode & os.W_OK) == 0
                    _device_info = _device_info_for_path(_device_path)
                    if (_mode & os.R_OK) and not bool(_device_info.get("readable")):
                        return False
                    if (_mode & os.W_OK) and not bool(_device_info.get("writable")):
                        return False
                    return (_mode & os.X_OK) == 0
                if _name in ("getsize",):
                    return 0
                if _name in ("getatime", "getctime", "getmtime"):
                    return 0
                if _name == "realpath":
                    if _kind is None:
                        raise FileNotFoundError(_device_path)
                    return _device_path
                if _name == "scandir":
                    return _virtual_scandir(_device_path, _device_dir_entries, _device_entry_kind, _device_stat)
                if _name in ("readlink",):
                    raise OSError("Unsupported device operation: " + _name)
            _proc_path = _normalize_proc_path(_path)
            if _proc_path:
                _kind = _proc_entry_kind(_proc_path)
                if _name in ("chmod", "chown", "mkdir", "makedirs", "remove", "removedirs", "rmdir", "unlink", "utime"):
                    _reject_kernel_mutation(_path, _name)
                if _name in ("exists", "lexists"):
                    return _kind is not None
                if _name == "isfile":
                    return _kind == "file"
                if _name == "isdir":
                    return _kind == "directory"
                if _name == "listdir":
                    _entries = _proc_dir_entries(_proc_path)
                    if _entries is None:
                        raise NotADirectoryError(_proc_path)
                    return _entries
                if _name in ("stat", "lstat"):
                    return _proc_stat(_proc_path)
                if _name == "access":
                    if _kind is None:
                        return False
                    _mode = int(args[0]) if args else int(kwargs.get("mode", os.F_OK))
                    return (_mode & os.W_OK) == 0 and (_mode & os.X_OK) == 0
                if _name in ("getsize",):
                    return _proc_stat(_proc_path).st_size
                if _name in ("getatime", "getctime", "getmtime"):
                    return 0
                if _name == "realpath":
                    return _proc_path
                if _name == "scandir":
                    return _virtual_scandir(_proc_path, _proc_dir_entries, _proc_entry_kind, _proc_stat)
                if _name in ("readlink",):
                    raise OSError("Unsupported proc operation: " + _name)
            _mapped_path = _map_workspace_path(_path)
            _absolute_path = _absolute_mapped_path(_mapped_path)
            _result = _original(_mapped_path, *args, **kwargs)
            if _name in ("remove", "unlink"):
                _emit_file_delete_for_absolute(_absolute_path)
            elif _name in ("chmod", "chown", "utime"):
                _emit_path_snapshot_for_absolute(_absolute_path)
            return _result
        setattr(_target, _name, _patched_one)
        _patched.append((_target, _name, _original))

    def _patch_two(_target, _name):
        _original = getattr(_target, _name, None)
        if _original is None:
            if _target is not os or _name != "link":
                return
            def _original(_mapped_src, _mapped_dst, *args, **kwargs):
                if os.path.isdir(_mapped_src):
                    raise IsADirectoryError(_mapped_src)
                if os.path.exists(_mapped_dst):
                    raise FileExistsError(_mapped_dst)
                with _project_original_open(_mapped_src, "rb") as _source_handle:
                    with _project_original_open(_mapped_dst, "xb") as _destination_handle:
                        _destination_handle.write(_source_handle.read())
                return None
        def _patched_two(_src, _dst, *args, **kwargs):
            _reject_kernel_mutation(_src, _name)
            _reject_kernel_mutation(_dst, _name)
            if _name == "symlink":
                raise OSError(
                    getattr(__import__("errno"), "ENOSYS", 38),
                    "Symbolic links are not supported by the project file manifest",
                )
            _mapped_src = _map_workspace_path(_src)
            _mapped_dst = _map_workspace_path(_dst)
            _absolute_src = _absolute_mapped_path(_mapped_src)
            _absolute_dst = _absolute_mapped_path(_mapped_dst)
            _src_is_directory = bool(_absolute_src and os.path.isdir(_absolute_src))
            _result = _original(_mapped_src, _mapped_dst, *args, **kwargs)
            if _name in ("rename", "replace"):
                if _src_is_directory:
                    _emit_directory_change_for_absolute(_absolute_src, True)
                    _emit_path_snapshot_for_absolute(_absolute_dst)
                else:
                    _emit_file_delete_for_absolute(_absolute_src)
                    _emit_file_change_for_absolute(_absolute_dst)
            elif _name in ("link", "symlink"):
                _emit_file_change_for_absolute(_absolute_dst)
            return _result
        setattr(_target, _name, _patched_two)
        _patched.append((_target, _name, _original))

    for _name in [
        "access", "chmod", "chown", "listdir", "lstat", "mkdir", "makedirs", "readlink",
        "remove", "removedirs", "rmdir", "scandir", "stat", "unlink", "utime",
    ]:
        _patch_one(os, _name)

    for _name in ["link", "rename", "replace", "symlink"]:
        _patch_two(os, _name)

    for _name in [
        "exists", "lexists", "getatime", "getctime", "getmtime", "getsize", "isdir",
        "isfile", "islink", "ismount", "realpath",
    ]:
        _patch_one(os.path, _name)

    os.environ["PWD"] = _patched_getcwd()

    def _restore():
        builtins.open = _original_open
        io.open = _original_io_open
        os.getcwd = _original_getcwd
        os.chdir = _original_chdir
        os.open = _original_os_open
        os.read = _original_os_read
        if _original_os_readv is not None:
            os.readv = _original_os_readv
        os.write = _original_os_write
        if _original_os_writev is not None:
            os.writev = _original_os_writev
        os.close = _original_os_close
        if _original_os_dup is not None:
            os.dup = _original_os_dup
        if _original_os_dup2 is not None:
            os.dup2 = _original_os_dup2
        if _original_os_truncate is not None:
            os.truncate = _original_os_truncate
        if _original_os_ftruncate is not None:
            os.ftruncate = _original_os_ftruncate
        if _original_os_fchmod is not None:
            os.fchmod = _original_os_fchmod
        if _original_os_fchown is not None:
            os.fchown = _original_os_fchown
        if _original_os_statvfs is not None:
            os.statvfs = _original_os_statvfs
        for _target, _name, _original in reversed(_patched):
            setattr(_target, _name, _original)

    return _restore

def _project_argv():
    if _source == "argument":
        return ["-c"] + _args
    if _source == "stdin":
        return ["-"] + _args
    if _source == "module":
        try:
            _module_spec = importlib.util.find_spec(_script_path)
            _module_origin = getattr(_module_spec, "origin", None)
            if isinstance(_module_origin, str) and _module_origin:
                return [_module_origin] + _args
        except Exception:
            pass
    return [_script_path] + _args

try:
    _clear_project_import_state()
    os.environ.clear()
    os.environ.update(_previous_environ)
    os.environ.update(_env)
    if "HOME" not in _env:
        _workspace_parts = [part for part in _workspace_root.split("/") if part]
        if len(_workspace_parts) >= 2 and _workspace_parts[0] == "home":
            os.environ["HOME"] = "/" + "/".join(_workspace_parts[:2])
    _cwd = _project_cwd()
    _active_project_cwd = _cwd
    os.makedirs(_cwd, exist_ok=True)
    os.chdir(_cwd)
    _restore_workspace_paths = _install_virtual_workspace_paths()
    if _cwd not in sys.path:
        sys.path.insert(0, _cwd)
    for _index, _path_entry in enumerate(_project_pythonpath_entries()):
        if _path_entry not in sys.path:
            sys.path.insert(_index + 1, _path_entry)
    _script_absolute_path = _project_script_absolute_path() if _source == "file" else _script_path
    if _source == "file":
        _script_dir = os.path.dirname(os.path.abspath(_script_absolute_path))
        if _script_dir and _script_dir not in sys.path:
            sys.path.insert(0, _script_dir)
    _install_tracekernel_asgi_modules()
    sys.argv = _project_argv()
    sys.stdin = _TraceProjectInputStream()
    sys.__stdout__ = _stdout
    sys.__stderr__ = _stderr
    with contextlib.redirect_stdout(_stdout), contextlib.redirect_stderr(_stderr):
        try:
            if _source == "file":
                runpy.run_path(_script_absolute_path, run_name="__main__")
            elif _source == "module":
                runpy.run_module(_script_path, run_name="__main__")
            else:
                exec(compile(str(_request.get("code", "")), _script_path or "<string>", "exec"), {
                    "__name__": "__main__",
                })
        except SystemExit as exc:
            if exc.code is None:
                _exit_code = 0
            elif isinstance(exc.code, int):
                _exit_code = exc.code
            else:
                _stderr.write(str(exc.code) + "\\n")
                _exit_code = 1
        except BaseException:
            traceback.print_exc(file=_stderr)
            _exit_code = 1
finally:
    _restore_provider_fs_mutation_events()
    _restore_workspace_paths()
    sys.argv = _previous_argv
    sys.stdin = _previous_stdin
    sys.__stdout__ = _previous_dunder_stdout
    sys.__stderr__ = _previous_dunder_stderr
    os.environ.clear()
    os.environ.update(_previous_environ)
    sys.path[:] = _previous_path
    os.chdir(_previous_cwd)
    _clear_project_import_state()

json.dumps({
    "stdout": _stdout.getvalue(),
    "stderr": _stderr.getvalue(),
    "exitCode": _exit_code,
    "files": _project_files_after_execution(),
})
`;

  try {
    const resultJson = await pyodide.runPythonAsync(projectCode);
    const result = JSON.parse(resultJson);
    if (projectOutputEvents.length > 0) {
      result.stdout = projectOutputEvents
        .filter((event) => event.stream === 'stdout')
        .map((event) => String(event.data ?? ''))
        .join('');
      result.stderr = projectOutputEvents
        .filter((event) => event.stream === 'stderr')
        .map((event) => String(event.data ?? ''))
        .join('');
    }
    return result;
  } finally {
    restoreProviderStdioBridge();
    delete self.__tracecodeProjectEvent;
    delete self.__tracecodeRuntimeKernelOpenTarget;
    delete self.__tracecodeRuntimeKernelMutationTarget;
    delete self.__tracecodeInstallProjectFsMutationEvents;
    delete self.__tracecodeKernelHttpListen;
    delete self.__tracecodeKernelHttpDispatch;
    activeProjectHttpBridges.delete(messageId);
  }
}

async function executeProjectPython(request, messageId, protocolToken) {
  await loadPyodideInstance();
  return withPythonUserAuthorityLockdown(
    () => executeProjectPythonUserCall(request, messageId, protocolToken),
    request?.projectUserAuthorityMode ?? 'temporary'
  );
}

async function executeCodeBatch(code, functionName, inputBatch, executionStyle = 'function') {
  await loadPyodideInstance();
  const runtimeCore = loadPyodideRuntimeCore();
  return withPythonUserAuthorityLockdown(() =>
    runtimeCore.executeCodeBatch(
      buildRuntimeDeps(),
      code,
      functionName,
      inputBatch,
      executionStyle
    )
  );
}

async function processMessage(data) {
  const { id, type, payload, protocolToken } = data;
  try {
    if (id && typeof protocolToken !== 'string') {
      trustedPythonWorkerPostMessage({ id, type: 'error', payload: { error: 'Missing Python worker protocol token.' } });
      return;
    }
    switch (type) {
      case 'init': {
        const startTime = performance.now();
        configurePythonWorkerOptions(payload);
        configurePythonRuntimeAssets(payload?.runtimeAssets);
        await ensurePythonModuleBootstrap();
        const loadTimeMs = performance.now() - startTime;
        trustedPythonWorkerPostMessage({ id, type: 'init-result', payload: { success: true, loadTimeMs }, protocolToken });
        break;
      }

      case 'warmup': {
        const startTime = performance.now();
        await loadPyodideInstance();
        loadPyodideRuntimeCore();
        const loadTimeMs = performance.now() - startTime;
        trustedPythonWorkerPostMessage({ id, type: 'warmup-result', payload: { success: true, loadTimeMs }, protocolToken });
        break;
      }

      case 'execute-with-tracing': {
        const { code, functionName, inputs, executionStyle, options } = payload;
        const result = await executeWithTracing(code, functionName, inputs, executionStyle ?? 'function', options);
        analyzerInitialized = false;
        postTraceResultMessage(
          id,
          protocolToken,
          result,
          payload?.traceEventTransport,
          'trace.events'
        );
        break;
      }

      case 'execute-code': {
        const { code, functionName, inputs, executionStyle } = payload;
        const result = await executeCode(code, functionName, inputs, executionStyle ?? 'function');
        analyzerInitialized = false;
        trustedPythonWorkerPostMessage({ id, type: 'execute-result', payload: result, protocolToken });
        break;
      }

      case 'execute-code-batch': {
        const { code, functionName, inputBatch, executionStyle } = payload;
        const result = await executeCodeBatch(code, functionName, inputBatch, executionStyle ?? 'function');
        analyzerInitialized = false;
        trustedPythonWorkerPostMessage({ id, type: 'execute-result', payload: result, protocolToken });
        break;
      }

      case 'execute-code-interview': {
        const { code, functionName, inputs, executionStyle } = payload;
        const result = await executeCode(code, functionName, inputs, executionStyle ?? 'function', {
          interviewGuard: true,
        });
        analyzerInitialized = false;
        trustedPythonWorkerPostMessage({ id, type: 'execute-result', payload: result, protocolToken });
        break;
      }

      case 'execute-project-python': {
        const result = await executeProjectPython(payload, id, protocolToken);
        analyzerInitialized = false;
        trustedPythonWorkerPostMessage({ id, type: 'execute-result', payload: result, protocolToken });
        break;
      }

      case 'status': {
        trustedPythonWorkerPostMessage({
          id,
          type: 'status-result',
          protocolToken,
          payload: {
            isReady: pyodide !== null,
            isLoading,
          },
        });
        break;
      }

      case 'analyze-code': {
        const { code } = payload;
        const result = await analyzeCodeAST(code);
        trustedPythonWorkerPostMessage({ id, type: 'analyze-result', payload: result, protocolToken });
        break;
      }

      default:
        trustedPythonWorkerPostMessage({
          id,
          type: 'error',
          protocolToken,
          payload: { error: `Unknown message type: ${type}` },
        });
    }
  } catch (error) {
    trustedPythonWorkerPostMessage({
      id,
      type: 'error',
      protocolToken,
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

let messageQueue = Promise.resolve();

// Message handler
self.onmessage = function(event) {
  const messageData = event.data;
  const { id, type, payload, protocolToken } = messageData || {};
  if (type === 'kernel-http-request') {
    const bridge = activeProjectHttpBridges.get(id);
    if (!bridge || bridge.protocolToken !== protocolToken) return;
    if (payload?.type === 'kernel-http-request') {
      void bridge.handleRequest(payload.listenerId, payload.requestId, payload.request);
    }
    return;
  }
  if (type === 'kernel-http-abort-request') {
    const bridge = activeProjectHttpBridges.get(id);
    if (!bridge || bridge.protocolToken !== protocolToken) return;
    if (payload?.type === 'kernel-http-abort-request') {
      bridge.abortRequest(payload.requestId);
    }
    return;
  }
  if (type === 'kernel-http-listen-result') {
    const bridge = activeProjectHttpBridges.get(id);
    if (!bridge || bridge.protocolToken !== protocolToken) return;
    if (payload?.type === 'kernel-http-listen-result') {
      bridge.updateListenerInfo(payload.listenerId, payload.info);
    }
    return;
  }
  if (type === 'kernel-http-dispatch-result') {
    const bridge = activeProjectHttpBridges.get(id);
    if (!bridge || bridge.protocolToken !== protocolToken) return;
    if (payload?.type === 'kernel-http-dispatch-result') {
      bridge.resolveDispatch(payload.requestId, payload.response);
    }
    return;
  }
  if (type === 'kernel-http-error') {
    const bridge = activeProjectHttpBridges.get(id);
    if (!bridge || bridge.protocolToken !== protocolToken) return;
    if (payload?.type === 'kernel-http-error' && payload.requestId) {
      bridge.rejectDispatch(payload.requestId, payload.error);
    } else if (payload?.type === 'kernel-http-error' && payload.listenerId) {
      bridge.failListener(payload.listenerId, payload.error);
    }
    return;
  }
  messageQueue = messageQueue
    .then(() => processMessage(messageData))
    .catch((error) => {
      const { id, protocolToken } = messageData;
      trustedPythonWorkerPostMessage({
        id,
        type: 'error',
        protocolToken,
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    });
};

// Notify that worker is ready
emitRuntimeDiagnostic('info', 'worker-ready', 'Python worker is ready.');
trustedPythonWorkerPostMessage({ type: 'worker-ready' });

// ═══════════════════════════════════════════════════════════════════════════
// AST CODE ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Whether the AST analyzer has been initialized in Pyodide
 */
let analyzerInitialized = false;

function isAnalyzeNameError(message) {
  if (!message || typeof message !== 'string') return false;
  return /NameError/.test(message) && /name ['"]analyze['"] is not defined/.test(message);
}

/**
 * Initialize the AST analyzer (define the analyze_code function in Pyodide)
 */
async function initAnalyzer() {
  if (analyzerInitialized) return;
  
  await loadPyodideInstance();
  
  // The AST analyzer Python code - must match the semantic facts contract.
  const analyzerCode = `
import ast
import json
${resolveSharedPythonSnippet('PYTHON_CLASS_DEFINITIONS', PYTHON_CLASS_DEFINITIONS_SNIPPET)}

TRACKED_BUILTINS = frozenset([
    'max', 'min', 'len', 'sum', 'abs', 'sorted', 'reversed',
    'enumerate', 'range', 'zip', 'map', 'filter', 'any', 'all',
    'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple',
    'ord', 'chr', 'print', 'input', 'open', 'type', 'isinstance',
    'hasattr', 'getattr', 'setattr', 'delattr',
])

DICT_METHODS = frozenset([
    'get', 'keys', 'values', 'items', 'pop', 'setdefault',
    'update', 'clear', 'copy', 'fromkeys',
])

LIST_METHODS = frozenset([
    'append', 'pop', 'extend', 'insert', 'remove', 'clear',
    'index', 'count', 'sort', 'reverse', 'copy',
])

STRING_METHODS = frozenset([
    'split', 'join', 'strip', 'lstrip', 'rstrip', 'lower', 'upper',
    'replace', 'find', 'rfind', 'index', 'rindex', 'count',
    'startswith', 'endswith', 'isalpha', 'isdigit', 'isalnum',
    'format', 'encode', 'decode',
])

HEAP_FUNCS = frozenset([
    'heappush', 'heappop', 'heapify', 'heappushpop', 'heapreplace',
    'nlargest', 'nsmallest',
])


def analyze_code(code: str) -> dict:
    facts = {
        'valid': True,
        'syntaxError': None,
        'hasFunctionDef': False,
        'functionNames': [],
        'hasForLoop': False,
        'hasWhileLoop': False,
        'hasNestedLoop': False,
        'hasConditional': False,
        'hasRecursion': False,
        'usesDict': False,
        'usesList': False,
        'usesSet': False,
        'usesHeap': False,
        'usesDeque': False,
        'builtinsUsed': [],
        'augmentedAssignOps': [],
        'comparisonOps': [],
        'dictOps': [],
        'listOps': [],
        'stringOps': [],
        'hasReturn': False,
        'returnCount': 0,
        'hasEarlyReturn': False,
        'indexAccesses': False,
        'sliceAccesses': False,
        'slidingWindowPattern': None,
        'indexExpressions': [],
        'windowPatterns': [],
        'sliceExpressions': [],
        'subtractionAssignments': [],
        'hashLookupChecks': [],
        'hashAssignments': [],
        'returnCollectionShapes': [],
        'returnExpressions': [],
        'comparisonExpressions': [],
        'variableAssignments': [],
        'augmentedAssignments': [],
        'propertyAssignments': [],
        'methodCalls': [],
        'functionCalls': [],
        'loopIterations': [],
        'variablesAssigned': [],
        'functionParams': [],
    }

    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        facts['valid'] = False
        facts['syntaxError'] = f"Line {e.lineno}: {e.msg}" if e.lineno else str(e.msg)
        return facts

    function_names = set()
    builtins_used = set()
    aug_assign_ops = set()
    comparison_ops = set()
    dict_ops = set()
    list_ops = set()
    string_ops = set()
    variables_assigned = set()
    function_params = set()

    loop_depth = 0
    in_conditional = False
    deque_imported = False
    current_loop_var = None
    canonical_index_expressions = []
    subtraction_assignments = []
    hash_lookup_checks = []
    hash_assignments = []
    return_collection_shapes = []
    return_expressions = []
    comparison_expressions = []
    variable_assignments = []
    augmented_assignments = []
    property_assignments = []
    method_calls = []
    function_calls = []
    loop_iterations = []
    slice_expressions = []

    AUG_OP_MAP = {
        ast.Add: '+=',
        ast.Sub: '-=',
        ast.Mult: '*=',
        ast.Div: '/=',
        ast.FloorDiv: '//=',
        ast.Mod: '%=',
        ast.Pow: '**=',
        ast.BitOr: '|=',
        ast.BitAnd: '&=',
        ast.BitXor: '^=',
        ast.LShift: '<<=',
        ast.RShift: '>>=',
    }

    CMP_OP_MAP = {
        ast.Lt: '<',
        ast.LtE: '<=',
        ast.Gt: '>',
        ast.GtE: '>=',
        ast.Eq: '==',
        ast.NotEq: '!=',
        ast.In: 'in',
        ast.NotIn: 'not in',
        ast.Is: 'is',
        ast.IsNot: 'is not',
    }

    def _merge_coeffs(left_coeffs, right_coeffs):
        merged = dict(left_coeffs)
        for key, value in right_coeffs.items():
            merged[key] = merged.get(key, 0) + value
            if merged[key] == 0:
                del merged[key]
        return merged

    def _linearize_index_expr(node):
        if isinstance(node, ast.Name):
            return (0, {node.id: 1}, [node.id])
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool):
                return None
            if isinstance(node.value, int):
                return (int(node.value), {}, [])
            return None
        if isinstance(node, ast.UnaryOp):
            child = _linearize_index_expr(node.operand)
            if child is None:
                return None
            child_const, child_coeffs, child_order = child
            if isinstance(node.op, ast.UAdd):
                return (child_const, child_coeffs, child_order)
            if isinstance(node.op, ast.USub):
                neg_coeffs = {key: -value for key, value in child_coeffs.items()}
                return (-child_const, neg_coeffs, child_order)
            return None
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
            left = _linearize_index_expr(node.left)
            right = _linearize_index_expr(node.right)
            if left is None or right is None:
                return None
            left_const, left_coeffs, left_order = left
            right_const, right_coeffs, right_order = right
            if isinstance(node.op, ast.Sub):
                right_const = -right_const
                right_coeffs = {key: -value for key, value in right_coeffs.items()}
            const_delta = left_const + right_const
            coeffs = _merge_coeffs(left_coeffs, right_coeffs)
            order = list(left_order)
            for key in right_order:
                if key not in order:
                    order.append(key)
            return (const_delta, coeffs, order)
        return None

    def _to_canonical_index_expr(array_name, expr_node, preferred_base_var=None):
        linear = _linearize_index_expr(expr_node)
        if linear is None:
            return None
        const_delta, coeffs, order = linear
        if not coeffs:
            return None
        mutable_coeffs = dict(coeffs)
        base_var = None
        if preferred_base_var and mutable_coeffs.get(preferred_base_var) == 1:
            base_var = preferred_base_var
        else:
            for var_name in order:
                if mutable_coeffs.get(var_name) == 1:
                    base_var = var_name
                    break
        if base_var is None:
            return None
        mutable_coeffs[base_var] = mutable_coeffs.get(base_var, 0) - 1
        if mutable_coeffs[base_var] == 0:
            del mutable_coeffs[base_var]
        variable_delta_name = None
        variable_delta_sign = 0
        if len(mutable_coeffs) > 1:
            return None
        if len(mutable_coeffs) == 1:
            variable_delta_name, coeff = next(iter(mutable_coeffs.items()))
            if coeff not in (-1, 1):
                return None
            variable_delta_sign = coeff
        return {
            'arrayVar': array_name,
            'baseVar': base_var,
            'constantDelta': int(const_delta),
            'variableDeltaName': variable_delta_name,
            'variableDeltaSign': variable_delta_sign,
        }

    def _canonical_expr_key(expr):
        return (
            expr['arrayVar'],
            expr['baseVar'],
            int(expr.get('constantDelta', 0)),
            expr.get('variableDeltaName') or '',
            int(expr.get('variableDeltaSign') or 0),
        )

    def _is_plain_base_expr(expr):
        return (
            int(expr.get('constantDelta', 0)) == 0
            and int(expr.get('variableDeltaSign') or 0) == 0
            and not expr.get('variableDeltaName')
        )

    def _build_window_patterns(index_exprs):
        grouped = {}
        for expr in index_exprs:
            group_key = (expr['arrayVar'], expr['baseVar'])
            grouped.setdefault(group_key, []).append(expr)
        patterns = []
        for (array_var, base_var), expressions in grouped.items():
            unique = []
            seen = set()
            for expr in expressions:
                key = _canonical_expr_key(expr)
                if key in seen:
                    continue
                seen.add(key)
                unique.append(expr)
            if len(unique) < 2:
                continue
            plain = next((expr for expr in unique if _is_plain_base_expr(expr)), None)
            if plain is not None:
                shifted = next(
                    (
                        expr for expr in unique
                        if _canonical_expr_key(expr) != _canonical_expr_key(plain)
                        and (
                            int(expr.get('constantDelta', 0)) != 0
                            or int(expr.get('variableDeltaSign') or 0) != 0
                        )
                    ),
                    None
                )
                if shifted is not None:
                    patterns.append({
                        'arrayVar': array_var,
                        'baseVar': base_var,
                        'leftExpr': shifted,
                        'rightExpr': plain,
                    })
                    continue
            patterns.append({
                'arrayVar': array_var,
                'baseVar': base_var,
                'leftExpr': unique[0],
                'rightExpr': unique[1],
            })
        return patterns

    def _project_legacy_sliding_window(window_patterns):
        for pattern in window_patterns:
            left = pattern.get('leftExpr') or {}
            right = pattern.get('rightExpr') or {}
            plain = None
            shifted = None
            if _is_plain_base_expr(left):
                plain = left
                shifted = right
            elif _is_plain_base_expr(right):
                plain = right
                shifted = left
            else:
                continue
            offset_name = shifted.get('variableDeltaName')
            offset_sign = int(shifted.get('variableDeltaSign') or 0)
            offset_constant = int(shifted.get('constantDelta', 0))
            if offset_name and offset_sign in (-1, 1) and offset_constant == 0:
                return {
                    'loopVar': plain['baseVar'],
                    'offsetVar': offset_name,
                    'arrayVar': pattern['arrayVar'],
                    'offsetDirection': 'subtract' if offset_sign < 0 else 'add',
                }
            if not offset_name and offset_constant != 0:
                return {
                    'loopVar': plain['baseVar'],
                    'offsetVar': str(abs(offset_constant)),
                    'arrayVar': pattern['arrayVar'],
                    'offsetDirection': 'subtract' if offset_constant < 0 else 'add',
                }
        return None

    def _get_name_id(node):
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return _get_name_id(node.value) or node.attr
        if isinstance(node, ast.Subscript):
            return _get_name_id(node.value)
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, int)):
            return str(node.value)
        return None

    def _get_subtraction_operands(node):
        if (
            isinstance(node, ast.BinOp)
            and isinstance(node.op, ast.Sub)
            and isinstance(node.left, ast.Name)
            and isinstance(node.right, ast.Name)
        ):
            return {
                'leftVar': node.left.id,
                'rightVar': node.right.id,
            }
        return None

    def _get_loop_target_name(node):
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, (ast.Tuple, ast.List)):
            for element in node.elts:
                candidate = _get_loop_target_name(element)
                if candidate:
                    return candidate
        return None

    def _extract_range_sequence_source(node):
        if not isinstance(node, ast.Call):
            return None
        if not isinstance(node.func, ast.Name) or node.func.id != 'range':
            return None
        if not node.args:
            return None
        upper_candidate = node.args[-1]
        if (
            isinstance(upper_candidate, ast.Call)
            and isinstance(upper_candidate.func, ast.Name)
            and upper_candidate.func.id == 'len'
            and len(upper_candidate.args) == 1
            and isinstance(upper_candidate.args[0], ast.Name)
        ):
            return upper_candidate.args[0].id
        return None

    def _describe_loop_iteration(node):
        loop_var = _get_loop_target_name(node.target)
        if isinstance(node.iter, ast.Name):
            return {
                'kind': 'direct-sequence',
                'sourceVar': node.iter.id,
                'loopVar': loop_var,
            }
        if isinstance(node.iter, ast.Call) and isinstance(node.iter.func, ast.Name):
            if (
                node.iter.func.id == 'enumerate'
                and len(node.iter.args) >= 1
                and isinstance(node.iter.args[0], ast.Name)
            ):
                return {
                    'kind': 'direct-sequence',
                    'sourceVar': node.iter.args[0].id,
                    'loopVar': loop_var,
                }
            range_source = _extract_range_sequence_source(node.iter)
            if range_source:
                return {
                    'kind': 'indexed-sequence',
                    'sourceVar': range_source,
                    'loopVar': loop_var,
                }
            if node.iter.func.id == 'range':
                return {
                    'kind': 'other',
                    'sourceVar': _get_name_id(node.iter.args[-1]) if node.iter.args else None,
                    'loopVar': loop_var,
                }
        return {
            'kind': 'other',
            'sourceVar': _get_name_id(node.iter),
            'loopVar': loop_var,
        }

    def _is_hash_lookup_expr(node):
        if isinstance(node, ast.Subscript):
            return True
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            return node.func.attr in ('get',)
        return False

    def _is_hash_value_read_expr(node):
        if isinstance(node, ast.Subscript):
            return True
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            return node.func.attr in ('get',)
        return False

    def _get_call_name(node):
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return node.attr
        return None

    def _get_call_arg_names(args):
        names = []
        for arg in args:
            if isinstance(arg, ast.Name):
                names.append(arg.id)
        return names

    def _collect_identifier_names(node, names=None):
        if names is None:
            names = set()
        if node is None:
            return sorted(names)
        if isinstance(node, ast.Name):
            names.add(node.id)
            return sorted(names)
        for child in ast.iter_child_nodes(node):
            _collect_identifier_names(child, names)
        return sorted(names)

    def _get_property_path(node):
        if isinstance(node, ast.Attribute):
            return _get_property_path(node.value) + [node.attr]
        if isinstance(node, ast.Subscript):
            return _get_property_path(node.value) + [_get_name_id(node.slice) or '[computed]']
        return []

    def _describe_slice_bound(node):
        if node is None:
            return {'kind': 'omitted'}
        if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
            return {'kind': 'number', 'number': int(node.value)}
        if isinstance(node, ast.Name):
            return {'kind': 'identifier', 'var': node.id}
        return {'kind': 'omitted'}

    def _describe_value(node):
        if node is None:
            return {'valueKind': 'object'}
        if isinstance(node, ast.Constant):
            if node.value is None:
                return {'valueKind': 'null'}
            if isinstance(node.value, bool):
                return {'valueKind': 'boolean', 'booleanValue': bool(node.value)}
            if isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
                return {'valueKind': 'number', 'numberValue': node.value}
            if isinstance(node.value, str):
                return {'valueKind': 'string', 'stringValue': node.value}
        if isinstance(node, ast.Name):
            return {'valueKind': 'identifier', 'valueVar': node.id}
        if isinstance(node, ast.Attribute):
            return {
                'valueKind': 'property',
                'objectVar': _get_name_id(node.value),
                'propertyName': node.attr,
                'propertyPath': _get_property_path(node),
                'argumentVars': _collect_identifier_names(node.value),
            }
        if isinstance(node, ast.Subscript):
            return {
                'valueKind': 'property',
                'objectVar': _get_name_id(node.value),
                'propertyName': _get_name_id(node.slice),
                'propertyPath': _get_property_path(node),
                'argumentVars': _collect_identifier_names(node.slice),
            }
        if isinstance(node, ast.Call):
            return {
                'valueKind': 'call',
                'callName': _get_call_name(node.func),
                'argumentVars': _collect_identifier_names(node),
            }
        if isinstance(node, ast.BinOp):
            return {
                'valueKind': 'binary',
                'operator': type(node.op).__name__,
                'leftVar': _get_name_id(node.left),
                'rightVar': _get_name_id(node.right),
                'argumentVars': _collect_identifier_names(node),
            }
        if isinstance(node, ast.List):
            return {'valueKind': 'array'}
        if isinstance(node, ast.Dict):
            return {'valueKind': 'object'}
        return {'valueKind': 'object'}

    class FactExtractor(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            nonlocal function_names, function_params
            facts['hasFunctionDef'] = True
            function_names.add(node.name)
            for arg in node.args.args:
                function_params.add(arg.arg)
            self.generic_visit(node)

        def visit_AsyncFunctionDef(self, node):
            self.visit_FunctionDef(node)

        def visit_For(self, node):
            nonlocal loop_depth, current_loop_var, loop_iterations
            facts['hasForLoop'] = True
            loop_depth += 1
            if loop_depth > 1:
                facts['hasNestedLoop'] = True
            old_loop_var = current_loop_var
            if isinstance(node.target, ast.Name):
                current_loop_var = node.target.id
            loop_iterations.append(_describe_loop_iteration(node))
            self.generic_visit(node)
            current_loop_var = old_loop_var
            loop_depth -= 1

        def visit_While(self, node):
            nonlocal loop_depth
            facts['hasWhileLoop'] = True
            loop_depth += 1
            if loop_depth > 1:
                facts['hasNestedLoop'] = True
            self.generic_visit(node)
            loop_depth -= 1

        def visit_If(self, node):
            nonlocal in_conditional
            facts['hasConditional'] = True
            was_in_conditional = in_conditional
            in_conditional = True
            self.generic_visit(node)
            in_conditional = was_in_conditional

        def visit_Call(self, node):
            nonlocal builtins_used, dict_ops, list_ops, string_ops, hash_lookup_checks, method_calls, function_calls
            if isinstance(node.func, ast.Name):
                name = node.func.id
                function_calls.append({
                    'functionName': name,
                    'argumentVars': _get_call_arg_names(node.args),
                })
                if name in TRACKED_BUILTINS:
                    builtins_used.add(name)
                if name == 'dict':
                    facts['usesDict'] = True
                elif name == 'list':
                    facts['usesList'] = True
                elif name == 'set':
                    facts['usesSet'] = True
                if name in HEAP_FUNCS:
                    facts['usesHeap'] = True
                if name in function_names:
                    facts['hasRecursion'] = True
            elif isinstance(node.func, ast.Attribute):
                method = node.func.attr
                method_calls.append({
                    'receiverVar': _get_name_id(node.func.value),
                    'methodName': method,
                    'argumentVars': _get_call_arg_names(node.args),
                })
                if method in DICT_METHODS:
                    dict_ops.add(method)
                if method in ('get',):
                    hash_lookup_checks.append({
                        'operation': method,
                        'containerVar': _get_name_id(node.func.value),
                        'argumentVar': _get_name_id(node.args[0]) if len(node.args) > 0 else None,
                        'directSubtraction': _get_subtraction_operands(node.args[0]) if len(node.args) > 0 else None,
                    })
                if method in LIST_METHODS:
                    list_ops.add(method)
                if method in STRING_METHODS:
                    string_ops.add(method)
                if method in ('appendleft', 'popleft'):
                    facts['usesDeque'] = True
                elif method in ('append', 'pop') and deque_imported:
                    facts['usesDeque'] = True
                if method in HEAP_FUNCS:
                    facts['usesHeap'] = True
            self.generic_visit(node)

        def visit_Dict(self, node):
            facts['usesDict'] = True
            self.generic_visit(node)

        def visit_List(self, node):
            facts['usesList'] = True
            self.generic_visit(node)

        def visit_Set(self, node):
            facts['usesSet'] = True
            self.generic_visit(node)

        def visit_ListComp(self, node):
            facts['usesList'] = True
            self.generic_visit(node)

        def visit_DictComp(self, node):
            facts['usesDict'] = True
            self.generic_visit(node)

        def visit_SetComp(self, node):
            facts['usesSet'] = True
            self.generic_visit(node)

        def visit_AugAssign(self, node):
            nonlocal aug_assign_ops, augmented_assignments
            op_type = type(node.op)
            if op_type in AUG_OP_MAP:
                operator = AUG_OP_MAP[op_type]
                aug_assign_ops.add(operator)
                fact = {
                    'operator': operator,
                    'value': _describe_value(node.value),
                }
                if isinstance(node.target, ast.Name):
                    fact['targetVar'] = node.target.id
                elif isinstance(node.target, ast.Attribute):
                    fact['targetObjectVar'] = _get_name_id(node.target.value)
                    fact['targetPropertyName'] = node.target.attr
                    fact['targetPropertyPath'] = _get_property_path(node.target)
                elif isinstance(node.target, ast.Subscript):
                    fact['targetObjectVar'] = _get_name_id(node.target.value)
                    fact['targetPropertyName'] = _get_name_id(node.target.slice)
                    fact['targetPropertyPath'] = _get_property_path(node.target)
                augmented_assignments.append(fact)
            self.generic_visit(node)

        def visit_Compare(self, node):
            nonlocal comparison_ops, dict_ops, hash_lookup_checks, comparison_expressions
            for op in node.ops:
                op_type = type(op)
                if op_type in CMP_OP_MAP:
                    op_str = CMP_OP_MAP[op_type]
                    comparison_ops.add(op_str)
                    comparator = node.comparators[0] if node.comparators else None
                    comparison_expressions.append({
                        'operator': op_str,
                        'left': _describe_value(node.left),
                        'right': _describe_value(comparator),
                    })
                    if op_str == 'in' or op_str == 'not in':
                        dict_ops.add(op_str)
                        hash_lookup_checks.append({
                            'operation': op_str,
                            'containerVar': _get_name_id(comparator),
                            'argumentVar': _get_name_id(node.left),
                            'directSubtraction': _get_subtraction_operands(node.left),
                        })
            self.generic_visit(node)

        def visit_Assign(self, node):
            nonlocal variables_assigned, subtraction_assignments, hash_assignments, variable_assignments, property_assignments
            for target in node.targets:
                if isinstance(target, ast.Name):
                    variables_assigned.add(target.id)
                    assignment_fact = {'targetVar': target.id}
                    assignment_fact.update(_describe_value(node.value))
                    variable_assignments.append(assignment_fact)
                    subtraction = _get_subtraction_operands(node.value)
                    if subtraction:
                        subtraction_assignments.append({
                            'targetVar': target.id,
                            'leftVar': subtraction['leftVar'],
                            'rightVar': subtraction['rightVar'],
                        })
                elif isinstance(target, ast.Tuple) or isinstance(target, ast.List):
                    for elt in target.elts:
                        if isinstance(elt, ast.Name):
                            variables_assigned.add(elt.id)
                            assignment_fact = {'targetVar': elt.id}
                            assignment_fact.update(_describe_value(node.value))
                            variable_assignments.append(assignment_fact)
                elif isinstance(target, ast.Subscript):
                    hash_assignments.append({
                        'operation': 'setitem',
                        'containerVar': _get_name_id(target.value),
                        'keyVar': _get_name_id(target.slice),
                        'valueVar': _get_name_id(node.value),
                    })
                    property_assignment_fact = {
                        'objectVar': _get_name_id(target.value),
                        'propertyName': _get_name_id(target.slice),
                    }
                    property_assignment_fact.update(_describe_value(node.value))
                    property_assignments.append(property_assignment_fact)
                elif isinstance(target, ast.Attribute):
                    property_assignment_fact = {
                        'objectVar': _get_name_id(target.value),
                        'propertyName': target.attr,
                    }
                    property_assignment_fact.update(_describe_value(node.value))
                    property_assignments.append(property_assignment_fact)
            self.generic_visit(node)

        def visit_AnnAssign(self, node):
            nonlocal variables_assigned, subtraction_assignments, variable_assignments, property_assignments
            if isinstance(node.target, ast.Name):
                variables_assigned.add(node.target.id)
                assignment_fact = {'targetVar': node.target.id}
                assignment_fact.update(_describe_value(node.value))
                variable_assignments.append(assignment_fact)
                subtraction = _get_subtraction_operands(node.value)
                if subtraction:
                    subtraction_assignments.append({
                        'targetVar': node.target.id,
                        'leftVar': subtraction['leftVar'],
                        'rightVar': subtraction['rightVar'],
                    })
            elif isinstance(node.target, ast.Attribute):
                property_assignment_fact = {
                    'objectVar': _get_name_id(node.target.value),
                    'propertyName': node.target.attr,
                }
                property_assignment_fact.update(_describe_value(node.value))
                property_assignments.append(property_assignment_fact)
            self.generic_visit(node)

        def visit_Subscript(self, node):
            nonlocal canonical_index_expressions, current_loop_var, slice_expressions
            if isinstance(node.slice, ast.Slice):
                facts['sliceAccesses'] = True
                object_var = _get_name_id(node.value)
                if object_var:
                    lower = _describe_slice_bound(node.slice.lower)
                    upper = _describe_slice_bound(node.slice.upper)
                    slice_expressions.append({
                        'objectVar': object_var,
                        'lowerKind': lower['kind'],
                        'lowerVar': lower.get('var'),
                        'lowerNumber': lower.get('number'),
                        'upperKind': upper['kind'],
                        'upperVar': upper.get('var'),
                        'upperNumber': upper.get('number'),
                    })
            else:
                facts['indexAccesses'] = True
                if isinstance(node.value, ast.Name):
                    array_name = node.value.id
                    canonical_expr = _to_canonical_index_expr(
                        array_name,
                        node.slice,
                        current_loop_var
                    )
                    if canonical_expr:
                        canonical_index_expressions.append(canonical_expr)
            self.generic_visit(node)

        def visit_Return(self, node):
            nonlocal in_conditional, return_collection_shapes, return_expressions
            facts['hasReturn'] = True
            facts['returnCount'] += 1
            if in_conditional:
                facts['hasEarlyReturn'] = True
            if node.value is not None:
                return_expressions.append(_describe_value(node.value))
            if isinstance(node.value, (ast.List, ast.Tuple)):
                items = list(node.value.elts)
                return_collection_shapes.append({
                    'kind': 'array' if isinstance(node.value, ast.List) else 'tuple',
                    'itemCount': len(items),
                    'containsHashLookup': any(_is_hash_lookup_expr(item) for item in items),
                    'containsHashValueRead': any(_is_hash_value_read_expr(item) for item in items),
                    'containsIdentifier': any(isinstance(item, ast.Name) for item in items),
                })
            self.generic_visit(node)

        def visit_Import(self, node):
            for alias in node.names:
                if alias.name == 'heapq':
                    facts['usesHeap'] = True
            self.generic_visit(node)

        def visit_ImportFrom(self, node):
            nonlocal deque_imported
            if node.module == 'heapq':
                facts['usesHeap'] = True
            elif node.module == 'collections':
                for alias in node.names:
                    if alias.name == 'deque':
                        facts['usesDeque'] = True
                        deque_imported = True
            self.generic_visit(node)

    extractor = FactExtractor()
    extractor.visit(tree)

    facts['functionNames'] = sorted(function_names)
    facts['builtinsUsed'] = sorted(builtins_used)
    facts['augmentedAssignOps'] = sorted(aug_assign_ops)
    facts['comparisonOps'] = sorted(comparison_ops)
    facts['dictOps'] = sorted(dict_ops)
    facts['listOps'] = sorted(list_ops)
    facts['stringOps'] = sorted(string_ops)
    facts['variablesAssigned'] = sorted(variables_assigned)
    facts['functionParams'] = sorted(function_params)
    facts['subtractionAssignments'] = subtraction_assignments
    facts['hashLookupChecks'] = hash_lookup_checks
    facts['hashAssignments'] = hash_assignments
    facts['returnCollectionShapes'] = return_collection_shapes
    facts['returnExpressions'] = return_expressions
    facts['comparisonExpressions'] = comparison_expressions
    facts['variableAssignments'] = variable_assignments
    facts['augmentedAssignments'] = augmented_assignments
    facts['propertyAssignments'] = property_assignments
    facts['methodCalls'] = method_calls
    facts['functionCalls'] = function_calls
    facts['loopIterations'] = loop_iterations
    facts['sliceExpressions'] = slice_expressions

    deduped_index_exprs = []
    seen_expr_keys = set()
    for expr in canonical_index_expressions:
        key = _canonical_expr_key(expr)
        if key in seen_expr_keys:
            continue
        seen_expr_keys.add(key)
        deduped_index_exprs.append(expr)

    facts['indexExpressions'] = deduped_index_exprs
    facts['windowPatterns'] = _build_window_patterns(deduped_index_exprs)
    facts['slidingWindowPattern'] = _project_legacy_sliding_window(facts['windowPatterns'])

    return facts

def analyze(code: str) -> str:
    return json.dumps(analyze_code(code))
`;
  
  // The analyzer code defines `analyze()` in Pyodide's default globals.
  // We mark initialization done so we don't redefine each time.
  await pyodide.runPythonAsync(analyzerCode);
  analyzerInitialized = true;
}

/**
 * Analyze Python code using the AST analyzer
 */
async function analyzeCodeAST(code) {
  // Escape the code for embedding in a Python string
  const escaped = code
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  const analyzeCall = `analyze('${escaped}')`;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await initAnalyzer();
      const resultJson = await pyodide.runPythonAsync(analyzeCall);
      return JSON.parse(resultJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error;

      if (!isAnalyzeNameError(message) || attempt === 1) {
        throw error;
      }

      emitRuntimeDiagnostic('warn', 'ast-analyzer-reinit', 'analyze() missing; reinitializing AST analyzer.');
      analyzerInitialized = false;
    }
  }

  throw lastError || new Error('AST analysis failed');
}
