/**
 * Canonical Python Harness Template
 *
 * This file is the single source of truth for shared harness snippets.
 * Generated artifacts:
 * - packages/runtime-python/src/generated/python-harness-snippets.ts
 * - workers/python/generated-python-harness-snippets.js
 */

/**
 * Convert a JavaScript value to a Python literal string.
 * Handles null -> None, booleans -> True/False, and nested structures.
 */
export function templateToPythonLiteral(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
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
      return '[' + value.map((item) => templateToPythonLiteral(item, seen)).join(', ') + ']';
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return 'None';
    seen.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${JSON.stringify(k)}: ${templateToPythonLiteral(v, seen)}`)
        .join(', ');
      return '{' + entries + '}';
    } finally {
      seen.delete(value);
    }
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
`;

/**
 * Trace-mode Python serialization function.
 * Includes function filtering and node reference tracking for cycle-safe traces.
 */
export const TEMPLATE_PYTHON_TRACE_SERIALIZE_FUNCTION = `
# Sentinel to mark skipped values (functions, etc.) - distinct from None
_SKIP_SENTINEL = "__TRACECODE_SKIP__"
_MAX_SERIALIZE_DEPTH = 48
_MAX_SERIALIZED_ITEMS = 64
_MAX_OBJECT_FIELDS = 32
_MAX_SERIALIZED_STRING_CHARS = 16384
_tracecode_global_object_refs = {}
_tracecode_next_object_ref_id = 0

def _serialize_string(value):
    if len(value) <= _MAX_SERIALIZED_STRING_CHARS:
        return value
    remaining = len(value) - _MAX_SERIALIZED_STRING_CHARS
    return value[:_MAX_SERIALIZED_STRING_CHARS] + f"…<truncated {remaining} chars>"

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

def _serialize_repr_fallback(obj, node_refs=None, truncate_string=True):
    obj_type = getattr(obj, '__class__', None)
    class_name = getattr(obj_type, '__name__', 'object')
    if getattr(obj_type, '__module__', '') == 'builtins':
        try:
            repr_str = repr(obj)
        except Exception:
            return _SKIP_SENTINEL
        if repr_str.startswith('<') and repr_str.endswith('>'):
            return _SKIP_SENTINEL
        return _serialize_string(repr_str) if truncate_string else repr_str
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
    if isinstance(obj, (bool, int, type(None))):
        return obj
    elif isinstance(obj, str):
        return _serialize_string(obj)
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
        result = {_serialize_string(str(k)): _serialize(v, depth + 1, node_refs) for k, v in items[:emitted]}
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
                key_str = _serialize_string(str(key))
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
        return _serialize_repr_fallback(obj, node_refs, False)
`;

/**
 * Execute-mode Python serialization function.
 * Preserves current execute output semantics.
 */
export const TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION = `
_MAX_SERIALIZE_DEPTH = 48
_MAX_SERIALIZED_ITEMS = 250000
_MAX_SERIALIZED_NODES = 1000000
_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024

class _TracecodeSerializationLimit(BaseException):
    pass

def _tracecode_make_trusted_json_encoder(
    builtins_module=_builtins,
    escape_string=json.encoder.encode_basestring_ascii,
):
    builtin_type = builtins_module.type
    builtin_none_type = builtin_type(None)
    builtin_bool = builtins_module.bool
    builtin_int = builtins_module.int
    builtin_float = builtins_module.float
    builtin_str = builtins_module.str
    builtin_list = builtins_module.list
    builtin_tuple = builtins_module.tuple
    builtin_dict = builtins_module.dict
    builtin_int_repr = builtin_int.__repr__
    builtin_float_repr = builtin_float.__repr__

    def encode_value(value):
        value_type = builtin_type(value)
        if value_type is builtin_none_type:
            return 'null'
        if value_type is builtin_bool:
            return 'true' if value else 'false'
        if value_type is builtin_int:
            return builtin_int_repr(value)
        if value_type is builtin_float:
            return builtin_float_repr(value)
        if value_type is builtin_str:
            return escape_string(value)
        if value_type is builtin_list or value_type is builtin_tuple:
            return '[' + ','.join(encode_value(item) for item in value) + ']'
        if value_type is builtin_dict:
            return '{' + ','.join(
                escape_string(key) + ':' + encode_value(item)
                for key, item in value.items()
            ) + '}'
        raise builtins_module.TypeError(
            'Trusted JSON envelope contains an unsupported value.'
        )

    return encode_value

_tracecode_trusted_json_encode = _tracecode_make_trusted_json_encoder()

def _tracecode_make_execute_serializer(
    max_depth=_MAX_SERIALIZE_DEPTH,
    max_items=_MAX_SERIALIZED_ITEMS,
    max_nodes=_MAX_SERIALIZED_NODES,
    max_bytes=_MAX_SERIALIZED_BYTES,
    builtins_module=_builtins,
    math_module=math,
    limit_type=_TracecodeSerializationLimit,
    tree_node_type=TreeNode,
    list_node_type=ListNode,
    encode=_tracecode_trusted_json_encode,
):
    builtin_base_exception = builtins_module.BaseException
    builtin_exception = builtins_module.Exception
    builtin_type_error = builtins_module.TypeError
    builtin_bool = builtins_module.bool
    builtin_int = builtins_module.int
    builtin_float = builtins_module.float
    builtin_str = builtins_module.str
    builtin_type = builtins_module.type
    builtin_none_type = builtin_type(None)
    builtin_list = builtins_module.list
    builtin_tuple = builtins_module.tuple
    builtin_dict = builtins_module.dict
    builtin_set = builtins_module.set
    builtin_type_getattribute = builtins_module.type.__getattribute__
    builtin_isinstance = builtins_module.isinstance
    builtin_len = builtins_module.len
    builtin_callable = builtins_module.callable
    builtin_getattr = builtins_module.getattr
    builtin_hasattr = builtins_module.hasattr
    builtin_repr = builtins_module.repr
    builtin_sorted = builtins_module.sorted
    builtin_str_encode = builtins_module.str.encode
    math_isfinite = math_module.isfinite
    math_isnan = math_module.isnan

    def serialize_checkpoint(state):
        state["nodes"] += 1
        if state["nodes"] > max_nodes:
            raise limit_type()
        if state["nodes"] % 64 == 0 and state["checkpoint"] is not None:
            state["checkpoint"]()

    def serialize_type_metadata(obj):
        try:
            obj_type = builtin_type(obj)
            class_name = builtin_type_getattribute(obj_type, '__name__')
            module_name = builtin_type_getattribute(obj_type, '__module__')
        except builtin_base_exception:
            return 'object', ''
        if not builtin_isinstance(class_name, builtin_str):
            class_name = 'object'
        if not builtin_isinstance(module_name, builtin_str):
            module_name = ''
        return class_name, module_name

    def serialize_inherits_from(obj, root_type):
        try:
            obj_type = builtin_type(obj)
            type_mro = builtin_type_getattribute(obj_type, '__mro__')
        except builtin_base_exception:
            return False
        for entry in type_mro:
            if entry is root_type:
                return True
        return False

    def serialize_repr_fallback(obj):
        class_name, module_name = serialize_type_metadata(obj)
        if module_name == 'builtins':
            try:
                repr_str = builtin_repr(obj)
            except builtin_exception:
                return None
            if repr_str.startswith('<') and repr_str.endswith('>'):
                return None
            return repr_str
        return {"__type__": class_name, "__class__": class_name}

    def serialize_value(obj, depth, state):
        serialize_checkpoint(state)
        if builtin_isinstance(
            obj,
            (builtin_bool, builtin_int, builtin_str, builtin_none_type),
        ):
            return obj
        elif builtin_isinstance(obj, builtin_float):
            if not math_isfinite(obj):
                if math_isnan(obj):
                    return "NaN"
                return "Infinity" if obj > 0 else "-Infinity"
            return obj
        if depth > max_depth:
            return "<max depth>"
        if builtin_isinstance(obj, (builtin_list, builtin_tuple)):
            if builtin_len(obj) > max_items:
                raise limit_type()
            return [serialize_value(value, depth + 1, state) for value in obj]
        elif serialize_type_metadata(obj)[0] == 'deque':
            if builtin_len(obj) > max_items:
                raise limit_type()
            return [serialize_value(value, depth + 1, state) for value in obj]
        elif builtin_isinstance(obj, builtin_dict):
            if builtin_len(obj) > max_items:
                raise limit_type()
            return {
                builtin_str(key): serialize_value(value, depth + 1, state)
                for key, value in obj.items()
            }
        elif builtin_isinstance(obj, builtin_set):
            if builtin_len(obj) > max_items:
                raise limit_type()
            values = [serialize_value(value, depth + 1, state) for value in obj]
            try:
                values = builtin_sorted(values)
            except builtin_type_error:
                pass
            return {"__type__": "set", "values": values}
        elif serialize_inherits_from(obj, state["tree_node_type"]):
            result = {"__type__": "TreeNode", "val": serialize_value(builtin_getattr(obj, 'val', builtin_getattr(obj, 'value', None)), depth + 1, state)}
            if builtin_hasattr(obj, 'left'):
                result["left"] = serialize_value(obj.left, depth + 1, state)
            if builtin_hasattr(obj, 'right'):
                result["right"] = serialize_value(obj.right, depth + 1, state)
            return result
        elif serialize_inherits_from(obj, state["list_node_type"]):
            result = {"__type__": "ListNode", "val": serialize_value(builtin_getattr(obj, 'val', builtin_getattr(obj, 'value', None)), depth + 1, state)}
            result["next"] = serialize_value(obj.next, depth + 1, state)
            return result
        elif builtin_callable(obj):
            return None
        elif builtin_hasattr(obj, '__dict__'):
            class_name, _module_name = serialize_type_metadata(obj)
            result = {"__type__": class_name, "__class__": class_name}
            try:
                raw_fields = builtin_getattr(obj, '__dict__', None)
            except builtin_exception:
                raw_fields = None
            if builtin_isinstance(raw_fields, builtin_dict):
                emitted = 0
                for key, value in raw_fields.items():
                    key_str = builtin_str(key)
                    if key_str.startswith('_') or builtin_callable(value):
                        continue
                    if emitted >= max_items:
                        raise limit_type()
                    result[key_str] = serialize_value(value, depth + 1, state)
                    emitted += 1
            return result
        else:
            return serialize_repr_fallback(obj)

    def serialize(
        obj,
        depth=0,
        state=None,
        checkpoint=None,
        tree_node_root=tree_node_type,
        list_node_root=list_node_type,
    ):
        if state is None:
            state = {
                "nodes": 0,
                "checkpoint": checkpoint,
                "tree_node_type": tree_node_root,
                "list_node_type": list_node_root,
            }
        result = serialize_value(obj, depth, state)
        if depth == 0:
            encoded = encode(result)
            if builtin_len(builtin_str_encode(encoded, 'utf-8')) > max_bytes:
                raise limit_type()
        return result

    return serialize

_serialize = _tracecode_make_execute_serializer()
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

    if isinstance(obj, (_builtins.list, _builtins.tuple)):
        return [_serialize(x, depth + 1, state) for x in obj]
    elif isinstance(obj, _builtins.dict):
        return {str(k): _serialize(v, depth + 1, state) for k, v in obj.items()}
    elif isinstance(obj, set):
        serialized = [_serialize(x, depth + 1, state) for x in obj]
        try:
            serialized = sorted(serialized)
        except TypeError:
            pass
        return {"__type__": "set", "values": serialized}
    elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and (hasattr(obj, 'left') or hasattr(obj, 'right')):
        obj_id = _builtins.id(obj)
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
        obj_id = _builtins.id(obj)
        if obj_id in state["seen"]:
            return "__CYCLE__"
        state["seen"].add(obj_id)
        result = {"__type__": "ListNode", "val": _serialize(getattr(obj, 'val', getattr(obj, 'value', None)), depth + 1, state)}
        result["next"] = _serialize(obj.next, depth + 1, state)
        state["seen"].remove(obj_id)
        return result
    else:
        obj_type = getattr(obj, '__class__', None)
        if getattr(obj_type, '__module__', '') != 'builtins':
            return {"__type__": getattr(obj_type, '__name__', 'object'), "__class__": getattr(obj_type, '__name__', 'object')}
        return repr(obj)
`;

/**
 * Interview materialization serializer, preserving current current behavior.
 */
export const TEMPLATE_PYTHON_INTERVIEW_MATERIALIZE_SERIALIZE_FUNCTION = `
def _serialize(obj, depth=0):
    if depth > 10:
        return "<max depth>"
    if isinstance(obj, (int, float, str, bool, type(None))):
        return obj
    elif isinstance(obj, (_builtins.list, _builtins.tuple)):
        return [_serialize(x, depth + 1) for x in obj]
    elif isinstance(obj, _builtins.dict):
        return {str(k): _serialize(v, depth + 1) for k, v in obj.items()}
    elif isinstance(obj, set):
        try:
            return {"__type__": "set", "values": sorted([_serialize(x, depth + 1) for x in obj])}
        except TypeError:
            return {"__type__": "set", "values": [_serialize(x, depth + 1) for x in obj]}
    elif isinstance(obj, TreeNode):
        result = {"__type__": "TreeNode", "val": _serialize(getattr(obj, 'val', None), depth + 1)}
        if hasattr(obj, 'left'):
            result["left"] = _serialize(obj.left, depth + 1)
        if hasattr(obj, 'right'):
            result["right"] = _serialize(obj.right, depth + 1)
        return result
    elif isinstance(obj, ListNode):
        result = {"__type__": "ListNode", "val": _serialize(getattr(obj, 'val', None), depth + 1)}
        result["next"] = _serialize(obj.next, depth + 1)
        return result
    else:
        obj_type = getattr(obj, '__class__', None)
        if getattr(obj_type, '__module__', '') != 'builtins':
            return {"__type__": getattr(obj_type, '__name__', 'object'), "__class__": getattr(obj_type, '__name__', 'object')}
        return repr(obj)
`;

/**
 * Backwards-compatible alias. Use TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION
 * for new callsites.
 */
export const TEMPLATE_PYTHON_SERIALIZE_FUNCTION = TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION;
