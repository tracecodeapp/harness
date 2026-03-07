/**
 * Pyodide Web Worker
 * 
 * Runs Python code execution in a separate thread to avoid blocking the UI.
 * This worker handles loading Pyodide, executing code, and returning traces.
 * 
 * THIS IS THE CANONICAL IMPLEMENTATION for Pyodide execution in TraceCode.
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
  '/workers/generated-python-harness-snippets.js',
];

let pyodide = null;
let isLoading = false;
let loadPromise = null;
const WORKER_DEBUG = (() => {
  try {
    return typeof self !== 'undefined' && typeof self.location?.search === 'string' && self.location.search.includes('dev=');
  } catch {
    return false;
  }
})();

// Interview mode runtime guard defaults. These are intentionally coarse
// safeguards to stop runaway executions without exposing internals.
const INTERVIEW_GUARD_DEFAULTS = Object.freeze({
  maxLineEvents: 400000,
  maxSingleLineHits: 150000,
  maxCallDepth: 2000,
  maxMemoryBytes: 96 * 1024 * 1024, // 96 MB
  memoryCheckEvery: 200,
});

// Load generated shared harness snippets when available. Keep worker startup
// resilient by falling back to embedded implementations if this import fails.
if (typeof importScripts === 'function') {
  for (const scriptPath of GENERATED_HARNESS_SNIPPETS_PATHS) {
    try {
      importScripts(scriptPath);
      if (WORKER_DEBUG) {
        console.log('[PyodideWorker] Loaded generated harness snippets from', scriptPath);
      }
      break;
    } catch (error) {
      if (WORKER_DEBUG) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[PyodideWorker] Failed to load generated harness snippets from', scriptPath, message);
      }
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
    if not isinstance(d, dict):
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
    if not isinstance(d, dict):
        return d
    if '__ref__' in d:
        return _refs.get(d.get('__ref__'))
    if 'val' not in d and 'value' not in d:
        return d
    node = ListNode(d.get('val', d.get('value', 0)))
    _ensure_node_value_aliases(node)
    node_id = d.get('__id__')
    if isinstance(node_id, str) and node_id:
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
        return [_serialize(x, depth + 1, node_refs) for x in obj]
    elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':
        return [_serialize(x, depth + 1, node_refs) for x in obj]
    elif isinstance(obj, dict):
        return {str(k): _serialize(v, depth + 1, node_refs) for k, v in obj.items()}
    elif isinstance(obj, set):
        # Use try/except for sorting to handle heterogeneous sets
        try:
            sorted_vals = sorted([_serialize(x, depth + 1, node_refs) for x in obj])
        except TypeError:
            sorted_vals = [_serialize(x, depth + 1, node_refs) for x in obj]
        return {"__type__": "set", "values": sorted_vals}
    elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and (hasattr(obj, 'left') or hasattr(obj, 'right')):
        obj_ref = id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = f"tree-{obj_ref}"
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
    elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and hasattr(obj, 'next'):
        obj_ref = id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = f"list-{obj_ref}"
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
    else:
        repr_str = repr(obj)
        # Filter out function-like representations (e.g., <function foo at 0x...>)
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
    elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and (hasattr(obj, 'left') or hasattr(obj, 'right')):
        result = {"__type__": "TreeNode", "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1)}
        if hasattr(obj, 'left'):
            result["left"] = _serialize(obj.left, depth + 1)
        if hasattr(obj, 'right'):
            result["right"] = _serialize(obj.right, depth + 1)
        return result
    elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and hasattr(obj, 'next'):
        result = {"__type__": "ListNode", "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1)}
        result["next"] = _serialize(obj.next, depth + 1)
        return result
    elif callable(obj):
        return None
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
            if (WORKER_DEBUG) {
              console.log('[PyodideWorker] Loaded bootstrap script from', indexURL);
            }
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
          if (WORKER_DEBUG) {
            console.log('[PyodideWorker] Initialized runtime from', indexURL);
          }
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
  '/workers/pyodide/runtime-core.js',
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
          if (WORKER_DEBUG) {
            console.log('[PyodideWorker] Loaded runtime core from', scriptPath);
          }
          break;
        } catch (error) {
          if (WORKER_DEBUG) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[PyodideWorker] Failed to load runtime core from', scriptPath, message);
          }
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

async function processMessage(data) {
  const { id, type, payload } = data;
  try {
    switch (type) {
      case 'init': {
        const startTime = performance.now();
        await loadPyodideInstance();
        const loadTimeMs = performance.now() - startTime;
        self.postMessage({ id, type: 'init-result', payload: { success: true, loadTimeMs } });
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
  
  // The AST analyzer Python code - must match lib/analysis/ast-analyzer.ts
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

def analyze_code(code):
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
    
    AUG_OP_MAP = {
        ast.Add: '+=', ast.Sub: '-=', ast.Mult: '*=', ast.Div: '/=',
        ast.FloorDiv: '//=', ast.Mod: '%=', ast.Pow: '**=',
        ast.BitOr: '|=', ast.BitAnd: '&=', ast.BitXor: '^=',
        ast.LShift: '<<=', ast.RShift: '>>=',
    }
    
    CMP_OP_MAP = {
        ast.Lt: '<', ast.LtE: '<=', ast.Gt: '>', ast.GtE: '>=',
        ast.Eq: '==', ast.NotEq: '!=', ast.In: 'in', ast.NotIn: 'not in',
        ast.Is: 'is', ast.IsNot: 'is not',
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
            nonlocal loop_depth, current_loop_var
            facts['hasForLoop'] = True
            loop_depth += 1
            if loop_depth > 1:
                facts['hasNestedLoop'] = True
            old_loop_var = current_loop_var
            if isinstance(node.target, ast.Name):
                current_loop_var = node.target.id
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
            nonlocal builtins_used, dict_ops, list_ops, string_ops
            if isinstance(node.func, ast.Name):
                name = node.func.id
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
                if method in DICT_METHODS:
                    dict_ops.add(method)
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
            nonlocal aug_assign_ops
            op_type = type(node.op)
            if op_type in AUG_OP_MAP:
                aug_assign_ops.add(AUG_OP_MAP[op_type])
            self.generic_visit(node)
        
        def visit_Compare(self, node):
            nonlocal comparison_ops, dict_ops
            for op in node.ops:
                op_type = type(op)
                if op_type in CMP_OP_MAP:
                    op_str = CMP_OP_MAP[op_type]
                    comparison_ops.add(op_str)
                    if op_str == 'in' or op_str == 'not in':
                        dict_ops.add(op_str)
            self.generic_visit(node)
        
        def visit_Assign(self, node):
            nonlocal variables_assigned
            for target in node.targets:
                if isinstance(target, ast.Name):
                    variables_assigned.add(target.id)
                elif isinstance(target, (ast.Tuple, ast.List)):
                    for elt in target.elts:
                        if isinstance(elt, ast.Name):
                            variables_assigned.add(elt.id)
            self.generic_visit(node)
        
        def visit_AnnAssign(self, node):
            nonlocal variables_assigned
            if isinstance(node.target, ast.Name):
                variables_assigned.add(node.target.id)
            self.generic_visit(node)
        
        def visit_Subscript(self, node):
            nonlocal canonical_index_expressions, current_loop_var
            if isinstance(node.slice, ast.Slice):
                facts['sliceAccesses'] = True
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
            nonlocal in_conditional
            facts['hasReturn'] = True
            facts['returnCount'] += 1
            if in_conditional:
                facts['hasEarlyReturn'] = True
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

def analyze(code):
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

      if (WORKER_DEBUG) {
        console.warn('[Pyodide Worker] analyze() missing; reinitializing AST analyzer');
      }
      analyzerInitialized = false;
    }
  }

  throw lastError || new Error('AST analysis failed');
}
