/**
 * Canonical Python Harness Template
 *
 * This file is the single source of truth for shared harness snippets.
 * Generated artifacts:
 * - packages/harness-python/src/generated/python-harness-snippets.ts
 * - workers/python/generated-python-harness-snippets.js
 */

/**
 * Convert a JavaScript value to a Python literal string.
 * Handles null -> None, booleans -> True/False, and nested structures.
 */
export function templateToPythonLiteral(value: unknown): string {
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
    return '[' + value.map(templateToPythonLiteral).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${templateToPythonLiteral(v)}`)
      .join(', ');
    return '{' + entries + '}';
  }
  return JSON.stringify(value);
}

/**
 * Python class definitions for TreeNode and ListNode.
 * These must match the worker definitions.
 */
export const TEMPLATE_PYTHON_CLASS_DEFINITIONS = `
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
`;

/**
 * Python helper functions for converting dicts to TreeNode/ListNode.
 */
export const TEMPLATE_PYTHON_CONVERSION_HELPERS = `
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
`;

/**
 * Trace-mode Python serialization function.
 * Includes function filtering and node reference tracking for cycle-safe traces.
 */
export const TEMPLATE_PYTHON_TRACE_SERIALIZE_FUNCTION = `
# Sentinel to mark skipped values (functions, etc.) - distinct from None
_SKIP_SENTINEL = "__TRACECODE_SKIP__"
_MAX_SERIALIZE_DEPTH = 48
_MAX_OBJECT_FIELDS = 32

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
    elif hasattr(obj, '__dict__'):
        obj_ref = id(obj)
        if obj_ref in node_refs:
            return {"__ref__": node_refs[obj_ref]}
        node_id = f"object-{obj_ref}"
        node_refs[obj_ref] = node_id
        class_name = getattr(getattr(obj, '__class__', None), '__name__', 'object')
        result = {
            "__type__": "object",
            "__class__": class_name,
            "__id__": node_id,
        }
        try:
            raw_fields = getattr(obj, '__dict__', None)
        except Exception:
            raw_fields = None
        if isinstance(raw_fields, dict):
            added = 0
            for key, value in raw_fields.items():
                key_str = str(key)
                if key_str.startswith('_'):
                    continue
                if callable(value):
                    continue
                result[key_str] = _serialize(value, depth + 1, node_refs)
                added += 1
                if added >= _MAX_OBJECT_FIELDS:
                    result["__truncated__"] = True
                    break
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
`;

/**
 * Execute-mode Python serialization function.
 * Preserves current execute/interview output semantics.
 */
export const TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION = `
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
`;

/**
 * Practice materialization serializer with strict safety limits and markers.
 */
export const TEMPLATE_PYTHON_PRACTICE_MATERIALIZE_SERIALIZE_FUNCTION = `
def _serialize(obj, depth=0, state=None):
    if state is None:
        state = {"nodes": 0, "seen": set()}
    if depth > 64:
        return "__MAX_DEPTH__"
    if isinstance(obj, (int, float, str, bool, type(None))):
        return obj

    state["nodes"] += 1
    if state["nodes"] > 600:
        return "__MAX_NODES__"

    if isinstance(obj, (list, tuple)):
        return [_serialize(x, depth + 1, state) for x in obj]
    elif isinstance(obj, dict):
        return {str(k): _serialize(v, depth + 1, state) for k, v in obj.items()}
    elif isinstance(obj, set):
        serialized = [_serialize(x, depth + 1, state) for x in obj]
        try:
            serialized = sorted(serialized)
        except TypeError:
            pass
        return {"__type__": "set", "values": serialized}
    elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and (hasattr(obj, 'left') or hasattr(obj, 'right')):
        obj_id = id(obj)
        if obj_id in state["seen"]:
            return "__CYCLE__"
        state["seen"].add(obj_id)
        result = {"__type__": "TreeNode", "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1, state)}
        if hasattr(obj, 'left'):
            result["left"] = _serialize(obj.left, depth + 1, state)
        if hasattr(obj, 'right'):
            result["right"] = _serialize(obj.right, depth + 1, state)
        state["seen"].remove(obj_id)
        return result
    elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and hasattr(obj, 'next'):
        obj_id = id(obj)
        if obj_id in state["seen"]:
            return "__CYCLE__"
        state["seen"].add(obj_id)
        result = {"__type__": "ListNode", "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1, state)}
        result["next"] = _serialize(obj.next, depth + 1, state)
        state["seen"].remove(obj_id)
        return result
    else:
        return repr(obj)
`;

/**
 * Interview materialization serializer, preserving current legacy behavior.
 */
export const TEMPLATE_PYTHON_INTERVIEW_MATERIALIZE_SERIALIZE_FUNCTION = `
def _serialize(obj, depth=0):
    if depth > 10:
        return "<max depth>"
    if isinstance(obj, (int, float, str, bool, type(None))):
        return obj
    elif isinstance(obj, (list, tuple)):
        return [_serialize(x, depth + 1) for x in obj]
    elif isinstance(obj, dict):
        return {str(k): _serialize(v, depth + 1) for k, v in obj.items()}
    elif isinstance(obj, set):
        try:
            return {"__type__": "set", "values": sorted([_serialize(x, depth + 1) for x in obj])}
        except TypeError:
            return {"__type__": "set", "values": [_serialize(x, depth + 1) for x in obj]}
    elif hasattr(obj, 'val') and (hasattr(obj, 'left') or hasattr(obj, 'right')):
        result = {"__type__": "TreeNode", "val": _serialize(getattr(obj, 'val', None), depth + 1)}
        if hasattr(obj, 'left'):
            result["left"] = _serialize(obj.left, depth + 1)
        if hasattr(obj, 'right'):
            result["right"] = _serialize(obj.right, depth + 1)
        return result
    elif hasattr(obj, 'val') and hasattr(obj, 'next'):
        result = {"__type__": "ListNode", "val": _serialize(getattr(obj, 'val', None), depth + 1)}
        result["next"] = _serialize(obj.next, depth + 1)
        return result
    else:
        return repr(obj)
`;

/**
 * Backwards-compatible alias. Use TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION
 * for new callsites.
 */
export const TEMPLATE_PYTHON_SERIALIZE_FUNCTION = TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION;
