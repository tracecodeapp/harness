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

// Pyodide index URLs in fallback order
const PYODIDE_INDEX_URLS = [
  'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/',
  'https://unpkg.com/pyodide@0.29.0/',
];
const GENERATED_HARNESS_SNIPPETS_PATHS = [
  './generated-python-harness-snippets.js',
];

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

async function ensurePythonLibraryPackages(runtime) {
  if (!runtime || typeof runtime.loadPackage !== 'function') return;
  if (!pythonPackageLoadPromise) {
    pythonPackageLoadPromise = runtime.loadPackage(['sortedcontainers']).catch((error) => {
      pythonPackageLoadPromise = null;
      const message = error instanceof Error ? error.message : String(error);
      emitRuntimeDiagnostic('warn', 'package-preload-failed', 'Failed to preload Python packages.', { message });
    });
  }
  await pythonPackageLoadPromise;
}

// Load generated shared harness snippets when available. Keep worker startup
// resilient by falling back to embedded implementations if this import fails.
if (typeof importScripts === 'function') {
  for (const scriptPath of GENERATED_HARNESS_SNIPPETS_PATHS) {
    try {
      importScripts(scriptPath);
      emitRuntimeDiagnostic('info', 'generated-snippets-loaded', 'Loaded generated harness snippets.', { scriptPath });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitRuntimeDiagnostic('warn', 'generated-snippets-load-failed', 'Failed to load generated harness snippets.', {
        scriptPath,
        message,
      });
    }
  }
}

/**
 * Convert a JavaScript value to a Python literal string.
 * Prefer the generated shared implementation when available.
 */
function fallbackToPythonLiteral(value) {
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
    return '[' + value.map(fallbackToPythonLiteral).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${fallbackToPythonLiteral(v)}`)
      .join(', ');
    return '{' + entries + '}';
  }
  return JSON.stringify(value);
}

const toPythonLiteralImpl =
  typeof self !== 'undefined' && typeof self.__TRACECODE_toPythonLiteral === 'function'
    ? self.__TRACECODE_toPythonLiteral
    : fallbackToPythonLiteral;

function toPythonLiteral(value) {
  return toPythonLiteralImpl(value);
}

const sharedHarnessSnippets =
  typeof self !== 'undefined' &&
  self.__TRACECODE_PYTHON_HARNESS__ &&
  typeof self.__TRACECODE_PYTHON_HARNESS__ === 'object'
    ? self.__TRACECODE_PYTHON_HARNESS__
    : null;

function resolveSharedPythonSnippet(key, fallback) {
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

def _tracecode_ref_id(node_refs):
    return f"ref-{len(node_refs)}"

def _truncation_marker(total, emitted):
    return {"__truncated__": True, "remaining": max(0, total - emitted)}

def _serialize_sequence(values, depth, node_refs):
    values_list = list(values)
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
    elif isinstance(obj, (list, tuple)):
        return _serialize_sequence(obj, depth, node_refs)
    elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':
        return _serialize_sequence(obj, depth, node_refs)
    elif isinstance(obj, dict):
        items = list(obj.items())
        emitted = min(len(items), _MAX_SERIALIZED_ITEMS)
        result = {str(k): _serialize(v, depth + 1, node_refs) for k, v in items[:emitted]}
        if emitted < len(items):
            result["__truncated__"] = True
            result["remaining"] = len(items) - emitted
        return result
    elif isinstance(obj, set):
        # Use try/except for sorting to handle heterogeneous sets
        values = list(obj)
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
        node_id = _tracecode_ref_id(node_refs)
        node_refs[obj_ref] = node_id
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
        node_id = _tracecode_ref_id(node_refs)
        node_refs[obj_ref] = node_id
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
        node_id = _tracecode_ref_id(node_refs)
        node_refs[obj_ref] = node_id
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
        if isinstance(raw_fields, dict):
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
        repr_str = repr(obj)
        # Filter out function-like representations (e.g., <function foo at 0x...>)
        if repr_str.startswith('<') and repr_str.endswith('>'):
            return _SKIP_SENTINEL
        return repr_str

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
    elif isinstance(obj, (list, tuple)):
        return [_serialize_output(x, depth + 1, node_refs) for x in obj]
    elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':
        return [_serialize_output(x, depth + 1, node_refs) for x in obj]
    elif isinstance(obj, dict):
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
        node_id = _tracecode_ref_id(node_refs)
        node_refs[obj_ref] = node_id
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
        node_id = _tracecode_ref_id(node_refs)
        node_refs[obj_ref] = node_id
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
        node_id = _tracecode_ref_id(node_refs)
        node_refs[obj_ref] = node_id
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
        if isinstance(raw_fields, dict):
            for key, value in raw_fields.items():
                key_str = str(key)
                if key_str.startswith('_') or callable(value):
                    continue
                result[key_str] = _serialize_output(value, depth + 1, node_refs)
        return result
    else:
        repr_str = repr(obj)
        if repr_str.startswith('<') and repr_str.endswith('>'):
            return _SKIP_SENTINEL
        return repr_str

`
);

const PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET = resolveSharedPythonSnippet(
  'PYTHON_EXECUTE_SERIALIZE_FUNCTION',
  `
_MAX_SERIALIZE_DEPTH = 48

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
    elif isinstance(obj, (list, tuple)):
        return [_serialize(x, depth + 1) for x in obj]
    elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':
        return [_serialize(x, depth + 1) for x in obj]
    elif isinstance(obj, dict):
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
        if isinstance(raw_fields, dict):
            for key, value in raw_fields.items():
                key_str = str(key)
                if key_str.startswith('_') or callable(value):
                    continue
                result[key_str] = _serialize(value, depth + 1)
        return result
    else:
        repr_str = repr(obj)
        if repr_str.startswith('<') and repr_str.endswith('>'):
            return None
        return repr_str

`
);

/**
 * Load Pyodide
 */
async function loadPyodideInstance() {
  if (pyodide) return pyodide;
  if (loadPromise) return loadPromise;

  isLoading = true;

  loadPromise = (async () => {
    try {
      const bootstrapErrors = [];

      if (typeof self.loadPyodide !== 'function') {
        let loadedBootstrap = false;

        for (const indexURL of PYODIDE_INDEX_URLS) {
          try {
            importScripts(`${indexURL}pyodide.js`);
            loadedBootstrap = true;
            emitRuntimeDiagnostic('info', 'bootstrap-loaded', 'Loaded Python runtime bootstrap script.', { indexURL });
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            bootstrapErrors.push(`${indexURL}pyodide.js (${message})`);
          }
        }

        if (!loadedBootstrap || typeof self.loadPyodide !== 'function') {
          throw new Error(
            `Unable to load Pyodide bootstrap script. Tried: ${bootstrapErrors.join(' | ')}`
          );
        }
      }

      const initErrors = [];
      for (const indexURL of PYODIDE_INDEX_URLS) {
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

    if (typeof importScripts === 'function') {
      for (const scriptPath of PYODIDE_RUNTIME_CORE_PATHS) {
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

function buildRuntimeDeps() {
  return {
    toPythonLiteral,
    PYTHON_CLASS_DEFINITIONS_SNIPPET,
    PYTHON_CONVERSION_HELPERS_SNIPPET,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET,
    INTERVIEW_GUARD_DEFAULTS,
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
  return loadPyodideRuntimeCore().executeWithTracing(
    buildRuntimeDeps(),
    code,
    functionName,
    inputs,
    executionStyle,
    options
  );
}

/**
 * Execute Python code without tracing (for running tests).
 * Delegates to the runtime core module.
 */
async function executeCode(code, functionName, inputs, executionStyle = 'function', options = {}) {
  return loadPyodideRuntimeCore().executeCode(
    buildRuntimeDeps(),
    code,
    functionName,
    inputs,
    executionStyle,
    options
  );
}

async function executeProjectPython(request, messageId) {
  await loadPyodideInstance();

  const requestJson = JSON.stringify(request ?? {});
  self.__tracecodeProjectEvent = (event) => {
    const payload = typeof event === 'string' ? JSON.parse(event) : event;
    self.postMessage({ id: messageId, type: 'project-event', payload });
  };
  const projectCode = `
import base64
import builtins
import contextlib
import io
import importlib
import json
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

_source = _request.get("source")
_script_path = str(_request.get("scriptPath") or "")
_args = [str(value) for value in _request.get("args", [])]
_stdout = io.StringIO()
_stderr = io.StringIO()
_previous_argv = sys.argv[:]
_previous_stdin = sys.stdin
_previous_cwd = os.getcwd()
_previous_environ = os.environ.copy()
_previous_path = sys.path[:]
_previous_modules = set(sys.modules.keys())
_env = {str(key): str(value) for key, value in _request.get("env", {}).items()}
_exit_code = 0
_restore_workspace_paths = lambda: None
_active_project_cwd = _root
_project_original_open = builtins.open

def _emit_project_event(_event):
    try:
        _js_self.__tracecodeProjectEvent(json.dumps(_event))
    except Exception:
        pass

def _project_relative_path_from_absolute(_absolute_path):
    try:
        _absolute = os.path.abspath(os.fspath(_absolute_path))
    except Exception:
        return None
    if _absolute == _root or not _absolute.startswith(_root + os.sep):
        return None
    return os.path.relpath(_absolute, _root).replace(os.sep, "/")

def _runtime_file_change_for_absolute(_absolute_path):
    _relative_path = _project_relative_path_from_absolute(_absolute_path)
    if not _relative_path or not os.path.isfile(_absolute_path):
        return None
    with _project_original_open(_absolute_path, "rb") as _handle:
        _contents = _handle.read()
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

class _TraceProjectStream(io.StringIO):
    def __init__(self, _stream):
        super().__init__()
        self._stream = _stream

    def write(self, _value):
        _text = str(_value)
        if _text:
            _emit_project_event({
                "type": "output",
                "stream": self._stream,
                "device": "/dev/stderr" if self._stream == "stderr" else "/dev/stdout",
                "data": _text,
            })
        return super().write(_text)

class _TraceDeviceFile:
    def __init__(self, _device, _mode="r"):
        self._device = _device
        self._mode = _mode
        self.closed = False

    def readable(self):
        return bool(_kernel_devices.get(self._device, {}).get("readable")) and "w" not in self._mode and "a" not in self._mode

    def writable(self):
        return bool(_kernel_devices.get(self._device, {}).get("writable")) and "r" not in self._mode

    def read(self, *args):
        if not self.readable():
            raise OSError("Kernel device is not readable: " + self._device)
        return str(_request.get("stdin", ""))

    def readline(self, *args):
        return self.read(*args).splitlines(True)[0] if self.read(*args) else ""

    def write(self, _value):
        if not self.writable():
            raise OSError("Kernel device is not writable: " + self._device)
        _output_device = str(_kernel_devices.get(self._device, {}).get("outputDevice") or self._device)
        _target = _stderr if _output_device == "/dev/stderr" else _stdout
        return _target.write(_value)

    def flush(self):
        return None

    def close(self):
        self.closed = True

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
    for _dirpath, _dirnames, _filenames in os.walk(_root):
        _dirnames.sort()
        for _filename in sorted(_filenames):
            _absolute_path = os.path.join(_dirpath, _filename)
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
if not _kernel_devices:
    _kernel_devices = {
        "/dev/stdin": {"readable": True, "writable": False, "inputDevice": "/dev/stdin", "outputDevice": ""},
        "/dev/stdout": {"readable": False, "writable": True, "inputDevice": "", "outputDevice": "/dev/stdout"},
        "/dev/stderr": {"readable": False, "writable": True, "inputDevice": "", "outputDevice": "/dev/stderr"},
        "/dev/tty": {"readable": True, "writable": True, "inputDevice": "/dev/stdin", "outputDevice": "/dev/stdout"},
    }

def _normalize_device_path(_value):
    if isinstance(_value, (str, bytes, os.PathLike)):
        _original = os.fspath(_value).replace("\\\\", "/").rstrip("/")
        if _original in _kernel_devices:
            return _original
    return None

def _normalize_proc_path(_value):
    if isinstance(_value, (str, bytes, os.PathLike)):
        _original = os.fspath(_value).replace("\\\\", "/").rstrip("/") or "/"
        if _original == "/proc" or _original.startswith("/proc/"):
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

def _is_mutating_file_mode(_mode):
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
    _original_os_write = os.write
    _original_os_close = os.close
    _open_file_descriptors = {}
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
        _device = _normalize_device_path(_file)
        _mode = args[0] if args else kwargs.get("mode", "r")
        if _device:
            return _TraceDeviceFile(_device, _mode)
        _proc_path = _normalize_proc_path(_file)
        if _proc_path:
            if _is_mutating_file_mode(_mode):
                raise OSError("Kernel proc path is read-only: " + _proc_path)
            if _proc_entry_kind(_proc_path) == "directory":
                raise IsADirectoryError(_proc_path)
            return _TraceProcFile(_proc_path, _mode)
        _mapped_path = _map_workspace_path(_file)
        _handle = _original_open(_mapped_path, *args, **kwargs)
        return _TraceProjectFile(_handle, _absolute_mapped_path(_mapped_path), _is_mutating_file_mode(_mode))

    def _patched_getcwd():
        return _virtual_workspace_path(_original_getcwd())

    def _patched_chdir(_path):
        return _original_chdir(_map_workspace_path(_path))

    def _patched_os_open(_path, _flags, *args, **kwargs):
        nonlocal _next_virtual_fd
        _device = _normalize_device_path(_path)
        if _device:
            _mutating = _is_mutating_fd_flags(_flags)
            _device_info = _kernel_devices.get(_device, {})
            if bool(_device_info.get("writable")) and _mutating:
                _fd = _next_virtual_fd
                _next_virtual_fd += 1
                _device_file_descriptors[_fd] = {"device": _device}
                return _fd
            if bool(_device_info.get("readable")) and not _mutating:
                _fd = _next_virtual_fd
                _next_virtual_fd += 1
                _input_device = str(_device_info.get("inputDevice") or _device)
                _device_file_descriptors[_fd] = {
                    "device": _device,
                    "inputDevice": _input_device,
                    "contents": str(_request.get("stdin", "")).encode("utf-8"),
                    "offset": 0,
                }
                return _fd
            raise OSError("Kernel device mode is not supported: " + _device)
        _proc_path = _normalize_proc_path(_path)
        if _proc_path:
            if _is_mutating_fd_flags(_flags):
                raise OSError("Kernel proc path is read-only: " + _proc_path)
            if _proc_entry_kind(_proc_path) == "directory":
                raise IsADirectoryError(_proc_path)
            _fd = _next_virtual_fd
            _next_virtual_fd += 1
            _proc_file_descriptors[_fd] = io.BytesIO(_proc_read_text(_proc_path).encode("utf-8"))
            return _fd
        _mapped_path = _map_workspace_path(_path)
        _absolute_path = _absolute_mapped_path(_mapped_path)
        _fd = _original_os_open(_mapped_path, _flags, *args, **kwargs)
        if _absolute_path and _is_mutating_fd_flags(_flags):
            _open_file_descriptors[_fd] = _absolute_path
            _emit_file_change_for_absolute(_absolute_path)
        return _fd

    def _patched_os_read(_fd, _length):
        _device_descriptor = _device_file_descriptors.get(_fd)
        if _device_descriptor is not None:
            if "contents" not in _device_descriptor:
                raise OSError("Kernel device is not readable: " + str(_device_descriptor.get("device", "")))
            _offset = int(_device_descriptor.get("offset", 0))
            _contents = _device_descriptor.get("contents", b"")
            _chunk = _contents[_offset:_offset + int(_length)]
            _device_descriptor["offset"] = _offset + len(_chunk)
            return _chunk
        _proc_handle = _proc_file_descriptors.get(_fd)
        if _proc_handle is not None:
            return _proc_handle.read(_length)
        return _original_os_read(_fd, _length)

    def _patched_os_write(_fd, _data):
        _device_descriptor = _device_file_descriptors.get(_fd)
        if _device_descriptor is not None:
            _device = str(_device_descriptor.get("device", ""))
            _device_info = _kernel_devices.get(_device, {})
            _output_device = str(_device_info.get("outputDevice") or "")
            if not _output_device:
                raise OSError("Kernel device is not writable: " + _device)
            _bytes = bytes(_data)
            _target = _stderr if _output_device == "/dev/stderr" else _stdout
            _target.write(_bytes.decode("utf-8", "replace"))
            return len(_bytes)
        if _fd in _proc_file_descriptors:
            raise OSError("Kernel proc path is read-only")
        _result = _original_os_write(_fd, _data)
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
            _proc_handle.close()
            return None
        _absolute_path = _open_file_descriptors.pop(_fd, None)
        try:
            return _original_os_close(_fd)
        finally:
            if _absolute_path:
                _emit_file_change_for_absolute(_absolute_path)

    builtins.open = _patched_open
    io.open = _patched_open
    os.getcwd = _patched_getcwd
    os.chdir = _patched_chdir
    os.open = _patched_os_open
    os.read = _patched_os_read
    os.write = _patched_os_write
    os.close = _patched_os_close

    def _patch_one(_target, _name):
        _original = getattr(_target, _name, None)
        if _original is None:
            return
        def _patched_one(_path, *args, **kwargs):
            _proc_path = _normalize_proc_path(_path)
            if _proc_path:
                _kind = _proc_entry_kind(_proc_path)
                if _name in ("chmod", "chown", "mkdir", "makedirs", "remove", "removedirs", "rmdir", "unlink", "utime"):
                    raise OSError("Kernel proc path is read-only: " + _proc_path)
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
                if _name in ("readlink", "scandir"):
                    raise OSError("Unsupported proc operation: " + _name)
            _mapped_path = _map_workspace_path(_path)
            _absolute_path = _absolute_mapped_path(_mapped_path)
            _result = _original(_mapped_path, *args, **kwargs)
            if _name in ("remove", "unlink"):
                _emit_file_delete_for_absolute(_absolute_path)
            return _result
        setattr(_target, _name, _patched_one)
        _patched.append((_target, _name, _original))

    def _patch_two(_target, _name):
        _original = getattr(_target, _name, None)
        if _original is None:
            return
        def _patched_two(_src, _dst, *args, **kwargs):
            _proc_src = _normalize_proc_path(_src)
            _proc_dst = _normalize_proc_path(_dst)
            if _proc_src or _proc_dst:
                raise OSError("Kernel proc path is read-only: " + (_proc_src or _proc_dst))
            _mapped_src = _map_workspace_path(_src)
            _mapped_dst = _map_workspace_path(_dst)
            _absolute_src = _absolute_mapped_path(_mapped_src)
            _absolute_dst = _absolute_mapped_path(_mapped_dst)
            _result = _original(_mapped_src, _mapped_dst, *args, **kwargs)
            if _name in ("rename", "replace"):
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
        os.write = _original_os_write
        os.close = _original_os_close
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
    sys.argv = _project_argv()
    sys.stdin = io.StringIO(str(_request.get("stdin", "")))
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
    _restore_workspace_paths()
    sys.argv = _previous_argv
    sys.stdin = _previous_stdin
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
    return JSON.parse(resultJson);
  } finally {
    delete self.__tracecodeProjectEvent;
  }
}

async function processMessage(data) {
  const { id, type, payload } = data;
  try {
    switch (type) {
      case 'init': {
        const startTime = performance.now();
        const loadTimeMs = performance.now() - startTime;
        self.postMessage({ id, type: 'init-result', payload: { success: true, loadTimeMs } });
        break;
      }

      case 'warmup': {
        const startTime = performance.now();
        await loadPyodideInstance();
        const loadTimeMs = performance.now() - startTime;
        self.postMessage({ id, type: 'warmup-result', payload: { success: true, loadTimeMs } });
        break;
      }

      case 'execute-with-tracing': {
        const { code, functionName, inputs, executionStyle, options } = payload;
        const result = await executeWithTracing(code, functionName, inputs, executionStyle ?? 'function', options);
        analyzerInitialized = false;
        self.postMessage({ id, type: 'execute-result', payload: result });
        break;
      }

      case 'execute-code': {
        const { code, functionName, inputs, executionStyle } = payload;
        const result = await executeCode(code, functionName, inputs, executionStyle ?? 'function');
        analyzerInitialized = false;
        self.postMessage({ id, type: 'execute-result', payload: result });
        break;
      }

      case 'execute-code-interview': {
        const { code, functionName, inputs, executionStyle } = payload;
        const result = await executeCode(code, functionName, inputs, executionStyle ?? 'function', {
          interviewGuard: true,
        });
        analyzerInitialized = false;
        self.postMessage({ id, type: 'execute-result', payload: result });
        break;
      }

      case 'execute-project-python': {
        const result = await executeProjectPython(payload, id);
        analyzerInitialized = false;
        self.postMessage({ id, type: 'execute-result', payload: result });
        break;
      }

      case 'status': {
        self.postMessage({
          id,
          type: 'status-result',
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
        self.postMessage({ id, type: 'analyze-result', payload: result });
        break;
      }

      default:
        self.postMessage({
          id,
          type: 'error',
          payload: { error: `Unknown message type: ${type}` },
        });
    }
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

let messageQueue = Promise.resolve();

// Message handler
self.onmessage = function(event) {
  const messageData = event.data;
  messageQueue = messageQueue
    .then(() => processMessage(messageData))
    .catch((error) => {
      const { id } = messageData;
      self.postMessage({
        id,
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    });
};

// Notify that worker is ready
emitRuntimeDiagnostic('info', 'worker-ready', 'Python worker is ready.');
self.postMessage({ type: 'worker-ready' });

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
${PYTHON_CLASS_DEFINITIONS_SNIPPET}

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
