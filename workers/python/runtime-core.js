/**
 * Pyodide runtime core helpers loaded by pyodide-worker.js.
 *
 * Exposes runtime helpers behind a dependency-injected surface so
 * the top-level worker can stay focused on loading + message dispatch.
 */

(function initPyodideRuntimeCore(globalScope) {
function generateTracingCode(deps, userCode, functionName, inputs, executionStyle = 'function', options = {}) {
  const inputSetup = Object.entries(inputs)
    .map(([key, value]) => `${key} = ${deps.toPythonLiteral(value)}`)
    .join('\n');

  const escapedCode = userCode.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  const targetFunction = functionName || '';
  
  // Configurable limits
  const maxTraceSteps = options.maxTraceSteps || 2000;
  const maxLineEvents = options.maxLineEvents || 10000;
  const maxSingleLineHits = options.maxSingleLineHits || 500;
  const minimalTrace = options.minimalTrace === true;
  // Keep stdout capture deterministic for the app UI; worker-console mirroring
  // can cause recursive print chains across mixed runs in dev.
  const mirrorPrintToConsole = false;

  // Python harness code - all at column 0, using 4-space indentation
  const harnessPrefix = `
import sys
import json
import math
import ast
import builtins as _builtins
${deps.PYTHON_CLASS_DEFINITIONS_SNIPPET}

_trace_data = []
_console_output = []
_original_print = _builtins.print
_target_function = "${targetFunction}"
_MIRROR_PRINT_TO_WORKER_CONSOLE = ${mirrorPrintToConsole ? 'True' : 'False'}
_MINIMAL_TRACE = ${minimalTrace ? 'True' : 'False'}
_SCRIPT_MODE = ${functionName ? 'False' : 'True'}
_TRACE_INPUT_NAMES = set(${JSON.stringify(Object.keys(inputs))})

class _InfiniteLoopDetected(Exception):
    pass

def _custom_print(*args, **kwargs):
    output = " ".join(str(arg) for arg in args)
    _console_output.append(output)
    try:
        _frame = sys._getframe(1)
        _trace_data.append({
            'line': _frame.f_lineno,
            'event': 'stdout',
            'variables': {'output': output},
            'function': _frame.f_code.co_name,
            'callStack': [] if _MINIMAL_TRACE else [f.copy() for f in _call_stack],
            'stdoutLineCount': len(_console_output)
        })
    except Exception:
        pass
    # Do not mirror to worker console; app UI owns stdout rendering.

print = _custom_print

${deps.PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET}

_call_stack = []
_pending_accesses = {}
_prev_hashmap_snapshots = {}
_TRACE_MUTATING_METHODS = {'append', 'appendleft', 'pop', 'popleft', 'extend', 'insert'}
_internal_funcs = {'_serialize', '_tracer', '_custom_print', '_dict_to_tree', '_dict_to_list', '_is_structural_constructor_frame', '_snapshot_call_stack', '_snapshot_locals', '_stable_token', '_looks_like_adjacency_list', '_looks_like_indexed_adjacency_list', '_extract_hashmap_snapshot', '_classify_runtime_object_kind', '_infer_hashmap_delta', '_clear_frame_hashmap_snapshots', '_build_runtime_visualization', '_resolve_inplace_result', '__tracecode_record_access', '__tracecode_flush_accesses', '__tracecode_normalize_indices', '__tracecode_make_access_event', '__tracecode_read_value', '__tracecode_write_value', '__tracecode_apply_augmented_value', '_tracecode_read_index', '_tracecode_write_index', '_tracecode_augassign_index', '_tracecode_mutating_call', '__tracecode_attach_parents', '_tracecode_extract_named_subscript', '__TracecodeAccessTransformer', '__tracecode_compile_user_code', '<listcomp>', '<dictcomp>', '<setcomp>', '<genexpr>'}
_internal_locals = {
    '_trace_data', '_console_output', '_original_print', '_target_function',
    '_MIRROR_PRINT_TO_WORKER_CONSOLE', '_MINIMAL_TRACE', '_SKIP_SENTINEL',
    '_SCRIPT_MODE', '_TRACE_INPUT_NAMES', '_SCRIPT_PRE_USER_GLOBALS',
    '_call_stack', '_pending_accesses', '_prev_hashmap_snapshots', '_TRACE_MUTATING_METHODS', '_internal_funcs', '_internal_locals', '_max_trace_steps',
    '_trace_limit_exceeded', '_timeout_reason', '_total_line_events', '_max_line_events',
    '_line_hit_count', '_max_single_line_hits', '_infinite_loop_line',
    '_MAX_SERIALIZE_DEPTH', '_trace_failed', '_inplace',
    '_custom_print', '_tracer', '_serialize', '_dict_to_tree', '_dict_to_list',
    '_is_structural_constructor_frame', '_snapshot_call_stack', '_snapshot_locals', '_stable_token',
    '_looks_like_adjacency_list', '_looks_like_indexed_adjacency_list', '_extract_hashmap_snapshot', '_classify_runtime_object_kind', '_infer_hashmap_delta',
    '_clear_frame_hashmap_snapshots', '_build_runtime_visualization', '_resolve_inplace_result',
    '__tracecode_record_access', '__tracecode_flush_accesses', '__tracecode_normalize_indices',
    '__tracecode_make_access_event', '__tracecode_read_value', '__tracecode_write_value',
    '__tracecode_apply_augmented_value', '_tracecode_read_index', '_tracecode_write_index',
    '_tracecode_augassign_index', '_tracecode_mutating_call', '__tracecode_attach_parents',
    '_tracecode_extract_named_subscript', '__TracecodeAccessTransformer', '__tracecode_compile_user_code',
    '_InfiniteLoopDetected', '_tb', '_result', '_exc_type', '_exc_msg', '_exc_tb',
    '_error_line', '_solver', '_ops', '_args', '_cls', '_instance', '_out',
    '_i', '_op', '_call_args', '_method', '_user_code_str', '_textwrap',
    '_globals_dict', '_k', '_preserve', '_real_globals', '_real_list',
    '__tracecode_tree', '__tracecode_compiled'
}
_max_trace_steps = ${maxTraceSteps}
_trace_limit_exceeded = False
_timeout_reason = None
_total_line_events = 0
_max_line_events = ${maxLineEvents}
_line_hit_count = {}
_max_single_line_hits = ${maxSingleLineHits}
_infinite_loop_line = -1

def _is_structural_constructor_frame(frame):
    if frame.f_code.co_name != '__init__':
        return False
    try:
        arg_count = frame.f_code.co_argcount
        arg_names = frame.f_code.co_varnames[:arg_count]
        # Detect node constructors by signature so we can skip at call-time
        # before self.left/self.right/self.next are initialized.
        if arg_names and arg_names[0] == 'self':
            has_val_param = ('val' in arg_names) or ('value' in arg_names)
            has_tree_param = ('left' in arg_names) or ('right' in arg_names)
            has_list_param = ('next' in arg_names) or ('prev' in arg_names)
            if has_val_param and (has_tree_param or has_list_param):
                return True
    except Exception:
        pass
    try:
        self_obj = frame.f_locals.get('self')
    except Exception:
        return False
    if self_obj is None:
        return False
    try:
        has_val_like = hasattr(self_obj, 'val') or hasattr(self_obj, 'value')
        has_tree_links = hasattr(self_obj, 'left') or hasattr(self_obj, 'right')
        has_list_links = hasattr(self_obj, 'next') or hasattr(self_obj, 'prev')
        return has_val_like and (has_tree_links or has_list_links)
    except Exception:
        return False

def _snapshot_call_stack():
    if _MINIMAL_TRACE:
        return []
    return [f.copy() for f in _call_stack]

def _is_serialized_ref(value):
    return isinstance(value, dict) and len(value) == 1 and isinstance(value.get('__ref__'), str)

def _is_serialized_list_node(value):
    return isinstance(value, dict) and value.get('__type__') == 'ListNode' and isinstance(value.get('__id__'), str)

def _serialized_list_root_id(value):
    if _is_serialized_list_node(value):
        return value.get('__id__')
    if _is_serialized_ref(value):
        return value.get('__ref__')
    return None

def _collect_serialized_list_component(value, node_ids=None, ref_ids=None, seen=None):
    if node_ids is None:
        node_ids = set()
    if ref_ids is None:
        ref_ids = set()
    if seen is None:
        seen = set()

    if _is_serialized_ref(value):
        ref_ids.add(value.get('__ref__'))
        return (node_ids, ref_ids)

    if not _is_serialized_list_node(value):
        return (node_ids, ref_ids)

    marker = id(value)
    if marker in seen:
        return (node_ids, ref_ids)
    seen.add(marker)

    node_id = value.get('__id__')
    if isinstance(node_id, str):
        node_ids.add(node_id)

    for field_name in ('next', 'prev'):
        if field_name in value:
            _collect_serialized_list_component(value.get(field_name), node_ids, ref_ids, seen)

    return (node_ids, ref_ids)

def _clone_serialized_value(value):
    if isinstance(value, dict):
        return {key: _clone_serialized_value(nested) for key, nested in value.items()}
    if isinstance(value, list):
        return [_clone_serialized_value(item) for item in value]
    return value

def _inline_component_list_refs(value, root_payloads, seen_root_ids=None):
    if seen_root_ids is None:
        seen_root_ids = set()

    if _is_serialized_ref(value):
        ref_id = value.get('__ref__')
        if not isinstance(ref_id, str):
            return value
        target = root_payloads.get(ref_id)
        if target is None or ref_id in seen_root_ids:
            return value
        next_seen = set(seen_root_ids)
        next_seen.add(ref_id)
        return _inline_component_list_refs(_clone_serialized_value(target), root_payloads, next_seen)

    if isinstance(value, list):
        return [_inline_component_list_refs(item, root_payloads, seen_root_ids) for item in value]

    if not isinstance(value, dict):
        return value

    out = {}
    next_seen = set(seen_root_ids)
    value_id = value.get('__id__')
    if isinstance(value_id, str):
        next_seen.add(value_id)

    for key, nested in value.items():
        out[key] = _inline_component_list_refs(nested, root_payloads, next_seen)
    return out

def _normalize_top_level_linked_list_locals(local_vars):
    if not isinstance(local_vars, dict) or len(local_vars) < 2:
        return local_vars

    ordered_names = list(local_vars.keys())
    candidates = []

    for index, name in enumerate(ordered_names):
        value = local_vars.get(name)
        root_id = _serialized_list_root_id(value)
        if not isinstance(root_id, str):
            continue
        node_ids, ref_ids = _collect_serialized_list_component(value)
        all_ids = set(node_ids) | set(ref_ids)
        if not all_ids:
            all_ids.add(root_id)
        candidates.append({
            'name': name,
            'index': index,
            'value': value,
            'root_id': root_id,
            'is_ref_only': _is_serialized_ref(value),
            'node_ids': node_ids,
            'ref_ids': ref_ids,
            'all_ids': all_ids,
            'incoming': 0,
        })

    if len(candidates) < 2:
        return local_vars

    parent = list(range(len(candidates)))

    def _find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def _union(a, b):
        ra = _find(a)
        rb = _find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(len(candidates)):
        left = candidates[i]
        for j in range(i + 1, len(candidates)):
            right = candidates[j]
            if left['all_ids'].intersection(right['all_ids']):
                _union(i, j)
            if left['root_id'] in right['all_ids'] or right['root_id'] in left['all_ids']:
                _union(i, j)

    for i in range(len(candidates)):
        left = candidates[i]
        for j in range(len(candidates)):
            if i == j:
                continue
            right = candidates[j]
            if left['root_id'] in right['all_ids'] and left['root_id'] != right['root_id']:
                left['incoming'] += 1

    groups = {}
    for index, candidate in enumerate(candidates):
        groups.setdefault(_find(index), []).append(candidate)

    for group in groups.values():
        if len(group) < 2:
            continue

        root_payloads = {}
        for candidate in group:
            root_id = candidate.get('root_id')
            value = candidate.get('value')
            if isinstance(root_id, str) and _is_serialized_list_node(value):
                root_payloads[root_id] = _clone_serialized_value(value)

        canonical = max(
            group,
            key=lambda candidate: (
                0 if candidate['is_ref_only'] else 1,
                1 if candidate['incoming'] == 0 else 0,
                len(candidate['node_ids']) + len(candidate['ref_ids']),
                -candidate['index'],
            ),
        )

        if _is_serialized_list_node(canonical.get('value')):
            local_vars[canonical['name']] = _inline_component_list_refs(
                _clone_serialized_value(canonical['value']),
                root_payloads,
                set([canonical.get('root_id')]) if isinstance(canonical.get('root_id'), str) else set(),
            )

        for candidate in group:
            if candidate is canonical:
                continue
            root_id = candidate.get('root_id')
            if isinstance(root_id, str):
                local_vars[candidate['name']] = {'__ref__': root_id}

    return local_vars

_SCRIPT_PRE_USER_GLOBALS = set()

def _snapshot_local_sources(frame):
    if _MINIMAL_TRACE:
        return {}
    try:
        func_name = frame.f_code.co_name
        sources = {}
        for name in frame.f_locals.keys():
            if name in _internal_locals or name == '_' or name.startswith('__'):
                continue
            if _SCRIPT_MODE and func_name == '<module>':
                if name in _TRACE_INPUT_NAMES:
                    sources[name] = 'user-input'
                elif name in _SCRIPT_PRE_USER_GLOBALS:
                    sources[name] = 'harness-prelude'
                else:
                    sources[name] = 'user'
            else:
                sources[name] = 'user'
        return sources
    except Exception:
        return {}

def _snapshot_locals(frame, with_sources=False):
    if _MINIMAL_TRACE:
        return ({}, {}) if with_sources else {}
    try:
        _node_refs = {}
        _sources = _snapshot_local_sources(frame)
        local_vars = {
            k: v
            for k, v in (
                (k, _serialize(v, 0, _node_refs))
                for k, v in frame.f_locals.items()
                if k not in _internal_locals and k != '_' and not k.startswith('__') and _sources.get(k) != 'harness-prelude'
            )
            if v != _SKIP_SENTINEL
        }
        local_vars = _normalize_top_level_linked_list_locals(local_vars)
        local_sources = {name: _sources.get(name, 'user') for name in local_vars.keys()}
        return (local_vars, local_sources) if with_sources else local_vars
    except Exception:
        return ({}, {}) if with_sources else {}

def __tracecode_record_access(frame, event):
    if frame is None or not isinstance(event, dict):
        return
    frame_key = id(frame)
    _pending_accesses.setdefault(frame_key, []).append(event)

def __tracecode_flush_accesses(frame):
    if frame is None:
        return []
    return _pending_accesses.pop(id(frame), [])

def __tracecode_normalize_indices(indices, max_depth=2):
    if not isinstance(indices, (list, tuple)) or len(indices) == 0 or len(indices) > max_depth:
        return None
    normalized = []
    for index in indices:
        if not isinstance(index, int):
            return None
        normalized.append(int(index))
    return normalized

def __tracecode_make_access_event(var_name, kind, indices=None, method_name=None):
    event = {
        'variable': var_name,
        'kind': kind,
    }
    if indices is not None:
        event['indices'] = list(indices)
        event['pathDepth'] = len(indices)
    if method_name is not None:
        event['method'] = method_name
    return event

def __tracecode_read_value(container, indices):
    current = container
    for index in indices:
        current = current[index]
    return current

def __tracecode_write_value(container, indices, value):
    if len(indices) == 1:
        container[indices[0]] = value
        return value
    parent = container
    for index in indices[:-1]:
        parent = parent[index]
    parent[indices[-1]] = value
    return value

def __tracecode_apply_augmented_value(current, op_name, rhs):
    if op_name == 'add':
        return current + rhs
    if op_name == 'sub':
        return current - rhs
    if op_name == 'mul':
        return current * rhs
    if op_name == 'div':
        return current / rhs
    if op_name == 'floordiv':
        return current // rhs
    if op_name == 'mod':
        return current % rhs
    if op_name == 'pow':
        return current ** rhs
    if op_name == 'lshift':
        return current << rhs
    if op_name == 'rshift':
        return current >> rhs
    if op_name == 'bitand':
        return current & rhs
    if op_name == 'bitor':
        return current | rhs
    if op_name == 'bitxor':
        return current ^ rhs
    return rhs

def _tracecode_read_index(var_name, container, indices):
    normalized = __tracecode_normalize_indices(indices)
    if normalized is not None:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(
                var_name,
                'cell-read' if len(normalized) == 2 else 'indexed-read',
                normalized,
            ),
        )
    return __tracecode_read_value(container, list(indices))

def _tracecode_write_index(var_name, container, indices, value):
    effective_indices = list(indices)
    result = __tracecode_write_value(container, effective_indices, value)
    normalized = __tracecode_normalize_indices(effective_indices)
    if normalized is not None:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(
                var_name,
                'cell-write' if len(normalized) == 2 else 'indexed-write',
                normalized,
            ),
        )
    return result

def _tracecode_augassign_index(var_name, container, indices, op_name, rhs):
    effective_indices = list(indices)
    current = __tracecode_read_value(container, effective_indices)
    normalized = __tracecode_normalize_indices(effective_indices)
    if normalized is not None:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(
                var_name,
                'cell-read' if len(normalized) == 2 else 'indexed-read',
                normalized,
            ),
        )
    next_value = __tracecode_apply_augmented_value(current, op_name, rhs)
    __tracecode_write_value(container, effective_indices, next_value)
    if normalized is not None:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(
                var_name,
                'cell-write' if len(normalized) == 2 else 'indexed-write',
                normalized,
            ),
        )
    return next_value

def _tracecode_mutating_call(var_name, container, method_name, *args, **kwargs):
    result = getattr(container, method_name)(*args, **kwargs)
    if method_name in _TRACE_MUTATING_METHODS:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(var_name, 'mutating-call', method_name=method_name),
        )
    return result

def __tracecode_attach_parents(node, parent=None):
    for child in ast.iter_child_nodes(node):
        setattr(child, '__trace_parent__', node)
        __tracecode_attach_parents(child, node)

def _tracecode_extract_named_subscript(node):
    indices = []
    current = node
    while isinstance(current, ast.Subscript) and len(indices) < 3:
        indices.insert(0, current.slice)
        current = current.value
    if not isinstance(current, ast.Name) or len(indices) == 0 or len(indices) > 2:
        return None
    return current.id, indices

class __TracecodeAccessTransformer(ast.NodeTransformer):
    def visit_Subscript(self, node):
        parent = getattr(node, '__trace_parent__', None)
        if isinstance(parent, ast.Subscript) and getattr(parent, 'value', None) is node:
            return self.generic_visit(node)
        if isinstance(parent, ast.Assign) and node in getattr(parent, 'targets', []):
            return self.generic_visit(node)
        if isinstance(parent, ast.AugAssign) and getattr(parent, 'target', None) is node:
            return self.generic_visit(node)

        node = self.generic_visit(node)
        extracted = _tracecode_extract_named_subscript(node)
        if extracted is None or not isinstance(node.ctx, ast.Load):
            return node

        var_name, indices = extracted
        call = ast.Call(
            func=ast.Name(id='_tracecode_read_index', ctx=ast.Load()),
            args=[
                ast.Constant(value=var_name),
                ast.Name(id=var_name, ctx=ast.Load()),
                ast.List(elts=indices, ctx=ast.Load()),
            ],
            keywords=[],
        )
        return ast.copy_location(call, node)

    def visit_Assign(self, node):
        if len(node.targets) == 1:
            extracted = _tracecode_extract_named_subscript(node.targets[0])
            if extracted is not None:
                var_name, indices = extracted
                value = self.visit(node.value)
                call = ast.Call(
                    func=ast.Name(id='_tracecode_write_index', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        ast.Name(id=var_name, ctx=ast.Load()),
                        ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                        value,
                    ],
                    keywords=[],
                )
                return ast.copy_location(ast.Expr(value=call), node)
        return self.generic_visit(node)

    def visit_AugAssign(self, node):
        extracted = _tracecode_extract_named_subscript(node.target)
        if extracted is None:
            return self.generic_visit(node)

        op_names = {
            ast.Add: 'add',
            ast.Sub: 'sub',
            ast.Mult: 'mul',
            ast.Div: 'div',
            ast.FloorDiv: 'floordiv',
            ast.Mod: 'mod',
            ast.Pow: 'pow',
            ast.LShift: 'lshift',
            ast.RShift: 'rshift',
            ast.BitAnd: 'bitand',
            ast.BitOr: 'bitor',
            ast.BitXor: 'bitxor',
        }
        op_name = op_names.get(type(node.op))
        if op_name is None:
            return self.generic_visit(node)

        var_name, indices = extracted
        rhs = self.visit(node.value)
        call = ast.Call(
            func=ast.Name(id='_tracecode_augassign_index', ctx=ast.Load()),
            args=[
                ast.Constant(value=var_name),
                ast.Name(id=var_name, ctx=ast.Load()),
                ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                ast.Constant(value=op_name),
                rhs,
            ],
            keywords=[],
        )
        return ast.copy_location(ast.Expr(value=call), node)

    def visit_Call(self, node):
        node = self.generic_visit(node)
        if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            method_name = node.func.attr
            if method_name in _TRACE_MUTATING_METHODS:
                call = ast.Call(
                    func=ast.Name(id='_tracecode_mutating_call', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=node.func.value.id),
                        ast.Name(id=node.func.value.id, ctx=ast.Load()),
                        ast.Constant(value=method_name),
                        *node.args,
                    ],
                    keywords=node.keywords,
                )
                return ast.copy_location(call, node)
        return node

def __tracecode_compile_user_code(source):
    tree = ast.parse(source, filename='<user_code>', mode='exec')
    __tracecode_attach_parents(tree)
    tree = __TracecodeAccessTransformer().visit(tree)
    ast.fix_missing_locations(tree)
    return compile(tree, '<user_code>', 'exec')

def _stable_token(value):
    try:
        return json.dumps(value, sort_keys=True)
    except Exception:
        return repr(value)

def _looks_like_adjacency_list(value):
    if not isinstance(value, dict) or len(value) == 0:
        return False
    if not all(isinstance(v, list) for v in value.values()):
        return False
    key_set = {str(k) for k in value.keys()}
    has_valid_neighbor = False
    for neighbors in value.values():
        for neighbor in neighbors:
            if isinstance(neighbor, (str, int, float)) and str(neighbor) in key_set:
                has_valid_neighbor = True
                break
        if has_valid_neighbor:
            break
    return has_valid_neighbor

def _looks_like_indexed_adjacency_list(value):
    if not isinstance(value, list) or len(value) == 0:
        return False
    if not all(isinstance(row, list) for row in value):
        return False

    node_count = len(value)
    edge_count = 0
    for neighbors in value:
        for neighbor in neighbors:
            if not isinstance(neighbor, int):
                return False
            if neighbor < 0 or neighbor >= node_count:
                return False
            edge_count += 1

    if edge_count == 0:
        return False

    looks_like_adjacency_matrix = all(
        len(row) == node_count and all(cell in (0, 1) for cell in row)
        for row in value
    )
    if looks_like_adjacency_matrix:
        return False

    return True

def _extract_hashmap_snapshot(value):
    if not isinstance(value, dict):
        return None

    value_type = value.get('__type__')

    if value_type == 'set' and isinstance(value.get('values'), list):
        _values = value.get('values') or []
        return {
            'kind': 'set',
            'entries': [{'key': item, 'value': True} for item in _values],
            'setValues': {_stable_token(item): item for item in _values},
        }

    if value_type in ('TreeNode', 'ListNode'):
        return None

    if value_type == 'map' and isinstance(value.get('entries'), list):
        _entries = []
        _map_values = {}
        for entry in value.get('entries') or []:
            if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                _key = entry[0]
                _value = entry[1]
                _entries.append({'key': _key, 'value': _value})
                _map_values[str(_key)] = _value
        return {
            'kind': 'map',
            'entries': _entries,
            'mapValues': _map_values,
        }

    if value_type in ('map',):
        return None

    if '__ref__' in value and len(value) == 1:
        return None

    if _looks_like_adjacency_list(value):
        return None

    return {
        'kind': 'hashmap',
        'entries': [{'key': key, 'value': val} for key, val in value.items()],
        'mapValues': {str(key): val for key, val in value.items()},
    }

def _classify_runtime_object_kind(value):
    if isinstance(value, list):
        if _looks_like_indexed_adjacency_list(value):
            return 'graph-adjacency'
        return None

    if not isinstance(value, dict):
        return None

    value_type = value.get('__type__')
    if value_type == 'set' and isinstance(value.get('values'), list):
        return 'set'
    if value_type == 'map' and isinstance(value.get('entries'), list):
        return 'map'
    if value_type == 'TreeNode':
        return 'tree'
    if value_type == 'ListNode':
        return 'linked-list'
    if '__ref__' in value and len(value) == 1:
        return None
    if _looks_like_adjacency_list(value):
        return 'graph-adjacency'
    return 'hashmap'

def _infer_hashmap_delta(previous_snapshot, current_snapshot):
    if not previous_snapshot or not current_snapshot:
        return (None, None)

    if previous_snapshot.get('kind') != current_snapshot.get('kind'):
        return (None, None)

    highlighted_key = None
    deleted_key = None

    if current_snapshot.get('kind') in ('hashmap', 'map'):
        previous_map = previous_snapshot.get('mapValues') or {}
        current_map = current_snapshot.get('mapValues') or {}

        previous_keys = set(previous_map.keys())
        current_keys = set(current_map.keys())

        new_keys = [key for key in current_keys if key not in previous_keys]
        removed_keys = [key for key in previous_keys if key not in current_keys]
        changed_keys = [
            key for key in current_keys
            if key in previous_map and previous_map.get(key) != current_map.get(key)
        ]

        if len(new_keys) == 1:
            highlighted_key = new_keys[0]
        elif len(changed_keys) == 1:
            highlighted_key = changed_keys[0]

        if len(removed_keys) == 1:
            deleted_key = removed_keys[0]

        return (highlighted_key, deleted_key)

    if current_snapshot.get('kind') == 'set':
        previous_values = previous_snapshot.get('setValues') or {}
        current_values = current_snapshot.get('setValues') or {}

        added_tokens = [token for token in current_values.keys() if token not in previous_values]
        removed_tokens = [token for token in previous_values.keys() if token not in current_values]

        if len(added_tokens) == 1:
            highlighted_key = current_values.get(added_tokens[0])
        if len(removed_tokens) == 1:
            deleted_key = previous_values.get(removed_tokens[0])

    return (highlighted_key, deleted_key)

def _clear_frame_hashmap_snapshots(frame):
    frame_prefix = f"{id(frame)}::"
    stale_keys = [
        key for key in list(_prev_hashmap_snapshots.keys())
        if key.startswith(frame_prefix)
    ]
    for key in stale_keys:
        _prev_hashmap_snapshots.pop(key, None)

def _build_runtime_visualization(local_vars, frame):
    try:
        hash_maps = []
        object_kinds = {}
        active_snapshot_keys = set()
        frame_prefix = f"{id(frame)}::"

        for name, value in local_vars.items():
            kind = _classify_runtime_object_kind(value)
            if kind is not None:
                object_kinds[name] = kind

            snapshot = _extract_hashmap_snapshot(value)
            if snapshot is None:
                continue

            snapshot_key = f"{frame_prefix}{name}"
            active_snapshot_keys.add(snapshot_key)
            previous_snapshot = _prev_hashmap_snapshots.get(snapshot_key)
            highlighted_key, deleted_key = _infer_hashmap_delta(previous_snapshot, snapshot)

            payload = {
                'name': name,
                'kind': snapshot.get('kind', 'hashmap'),
                'entries': snapshot.get('entries', []),
            }
            if highlighted_key is not None:
                payload['highlightedKey'] = highlighted_key
            if deleted_key is not None:
                payload['deletedKey'] = deleted_key

            hash_maps.append(payload)
            _prev_hashmap_snapshots[snapshot_key] = snapshot

        stale_keys = [
            key for key in list(_prev_hashmap_snapshots.keys())
            if key.startswith(frame_prefix) and key not in active_snapshot_keys
        ]
        for key in stale_keys:
            _prev_hashmap_snapshots.pop(key, None)

        if len(hash_maps) > 0 or len(object_kinds) > 0:
            payload = {}
            if len(hash_maps) > 0:
                payload['hashMaps'] = hash_maps
            if len(object_kinds) > 0:
                payload['objectKinds'] = object_kinds
            return payload
        return {}
    except Exception:
        return {}

def _tracer(frame, event, arg):
    global _trace_limit_exceeded, _timeout_reason, _total_line_events, _line_hit_count, _infinite_loop_line
    func_name = frame.f_code.co_name

    if func_name in _internal_funcs:
        return _tracer

    # Skip visual noise from node constructors used only to build data structures.
    if _is_structural_constructor_frame(frame):
        return _tracer
    
    # Fast counter for any loops
    if event == 'line':
        _total_line_events += 1
        
        # Check total line events
        if _total_line_events >= _max_line_events:
            if not _trace_limit_exceeded:
                _trace_limit_exceeded = True
                _timeout_reason = 'line-limit'
                _infinite_loop_line = frame.f_lineno
                _trace_data.append({
                    'line': frame.f_lineno,
                    'event': 'timeout',
                    'variables': {'timeoutReason': _timeout_reason},
                    'function': func_name,
                    'callStack': _snapshot_call_stack(),
                    'stdoutLineCount': len(_console_output),
                    'accesses': __tracecode_flush_accesses(frame),
                })
                sys.settrace(None)
                raise _InfiniteLoopDetected(f"Exceeded {_max_line_events} line events")
        
        # Simple per-line counter (catches any line hit too many times)
        line_key = (func_name, frame.f_lineno)
        _line_hit_count[line_key] = _line_hit_count.get(line_key, 0) + 1
        if _line_hit_count[line_key] >= _max_single_line_hits:
            if not _trace_limit_exceeded:
                _trace_limit_exceeded = True
                _timeout_reason = 'single-line-limit'
                _infinite_loop_line = frame.f_lineno
                local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
                local_vars['timeoutReason'] = _timeout_reason
                _trace_data.append({
                    'line': frame.f_lineno,
                    'event': 'timeout',
                    'variables': local_vars,
                    'variableSources': local_sources,
                    'function': func_name,
                    'callStack': _snapshot_call_stack(),
                    'stdoutLineCount': len(_console_output),
                    'accesses': __tracecode_flush_accesses(frame),
                    'visualization': _build_runtime_visualization(local_vars, frame)
                })
                sys.settrace(None)
                raise _InfiniteLoopDetected(f"Line {frame.f_lineno} executed {_max_single_line_hits} times")
    
    # Hard limit on recorded trace steps
    if (not _MINIMAL_TRACE) and len(_trace_data) >= _max_trace_steps:
        if not _trace_limit_exceeded:
            _trace_limit_exceeded = True
            _timeout_reason = 'trace-limit'
            _infinite_loop_line = frame.f_lineno
            _trace_data.append({
                'line': frame.f_lineno,
                'event': 'timeout',
                'variables': {'timeoutReason': _timeout_reason},
                'function': func_name,
                'callStack': _snapshot_call_stack(),
                'stdoutLineCount': len(_console_output),
                'accesses': __tracecode_flush_accesses(frame),
            })
            sys.settrace(None)
            raise _InfiniteLoopDetected(f"Exceeded {_max_trace_steps} trace steps")

    if event == 'call':
        local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
        if func_name != '<module>':
            _call_stack.append({
                'function': func_name,
                'args': local_vars.copy() if not _MINIMAL_TRACE else {},
                'line': frame.f_lineno
            })
        if _MINIMAL_TRACE:
            return _tracer
        _trace_data.append({
            'line': frame.f_lineno,
            'event': 'call',
            'variables': local_vars,
            'variableSources': local_sources,
            'function': func_name,
            'callStack': _snapshot_call_stack(),
            'stdoutLineCount': len(_console_output),
            'accesses': __tracecode_flush_accesses(frame),
            'visualization': _build_runtime_visualization(local_vars, frame)
        })
    elif event == 'line':
        if _MINIMAL_TRACE:
            return _tracer
        local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
        _trace_data.append({
            'line': frame.f_lineno,
            'event': event,
            'variables': local_vars,
            'variableSources': local_sources,
            'function': func_name,
            'callStack': _snapshot_call_stack(),
            'stdoutLineCount': len(_console_output),
            'accesses': __tracecode_flush_accesses(frame),
            'visualization': _build_runtime_visualization(local_vars, frame)
        })
    elif event == 'return':
        if not _MINIMAL_TRACE:
            local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
            _trace_data.append({
                'line': frame.f_lineno,
                'event': 'return',
                'variables': local_vars,
                'variableSources': local_sources,
                'function': func_name,
                'returnValue': _serialize(arg),
                'callStack': _snapshot_call_stack(),
                'stdoutLineCount': len(_console_output),
                'accesses': __tracecode_flush_accesses(frame),
                'visualization': _build_runtime_visualization(local_vars, frame)
            })
        _clear_frame_hashmap_snapshots(frame)
        _pending_accesses.pop(id(frame), None)
        if _call_stack and _call_stack[-1]['function'] == func_name:
            _call_stack.pop()

    return _tracer

# Clear user-defined globals from previous runs
# Use __builtins__ to access real globals() and list() in case they were shadowed
_real_globals = __builtins__['globals'] if isinstance(__builtins__, dict) else getattr(__builtins__, 'globals')
_real_list = __builtins__['list'] if isinstance(__builtins__, dict) else getattr(__builtins__, 'list')
_globals_dict = _real_globals()
_preserve = {"TreeNode", "ListNode", 'sys', 'json', 'math', 'ast', 'print', '__builtins__', '__name__', '__doc__', '__package__', '__loader__', '__spec__'}
for _k in _real_list(_globals_dict.keys()):
    if not _k.startswith('_') and _k not in _preserve:
        _globals_dict.pop(_k, None)
del _preserve, _real_globals, _real_list

# Ensure print remains routed through the tracer harness after global cleanup
print = _custom_print

`;

  const userCodeStartLine = 1;

  // Separate tree inputs (have left/right) from list inputs (have next)
  const treeInputKeys = [];
  const listInputKeys = [];
  
  Object.entries(inputs).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && ('val' in value || 'value' in value)) {
      const hasLeft = 'left' in value;
      const hasRight = 'right' in value;
      const hasNext = 'next' in value;
      
      if (hasLeft || hasRight) {
        treeInputKeys.push(key);
      } else if (hasNext) {
        listInputKeys.push(key);
      } else {
        // Default to tree for backwards compatibility
        treeInputKeys.push(key);
      }
    }
  });

  const treeConversions = treeInputKeys.length > 0
    ? treeInputKeys.map(key => `${key} = _dict_to_tree(${key})`).join('\n')
    : '';
  
  const listConversions = listInputKeys.length > 0
    ? listInputKeys.map(key => `${key} = _dict_to_list(${key})`).join('\n')
    : '';

  const argList = Object.keys(inputs)
    .map((key) => `${key}=${key}`)
    .join(', ');
  const inplaceCandidates = ['nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid', 'head']
    .filter((key) => Object.prototype.hasOwnProperty.call(inputs, key));
  const inplaceCandidatesLiteral = JSON.stringify(inplaceCandidates);
  const executionCode = functionName
    ? executionStyle === 'solution-method'
      ? [
        `    if 'Solution' in globals() and hasattr(Solution, '${functionName}'):`,
        `        _solver = Solution()`,
        `        _result = getattr(_solver, '${functionName}')(${argList})`,
        `    elif '${functionName}' in globals() and callable(globals()['${functionName}']):`,
        `        _result = globals()['${functionName}'](${argList})`,
        `    else:`,
        `        raise NameError(\"Implement Solution.${functionName}(...)\")`,
      ].join('\n')
      : executionStyle === 'ops-class'
        ? [
          `    _ops = operations if 'operations' in locals() else (ops if 'ops' in locals() else None)`,
          `    _args = arguments if 'arguments' in locals() else (args if 'args' in locals() else None)`,
          `    if _ops is None or _args is None:`,
          `        raise ValueError(\"ops-class execution requires inputs.operations and inputs.arguments (or ops/args)\")`,
          `    if len(_ops) != len(_args):`,
          `        raise ValueError(\"operations and arguments must have the same length\")`,
          `    _cls = ${functionName}`,
          `    _instance = None`,
          `    _out = []`,
          `    for _i, _op in enumerate(_ops):`,
          `        _call_args = _args[_i] if _i < len(_args) else []`,
          `        if _call_args is None:`,
          `            _call_args = []`,
          `        if not isinstance(_call_args, (list, tuple)):`,
          `            _call_args = [_call_args]`,
          `        if _i == 0:`,
          `            _instance = _cls(*_call_args)`,
          `            _out.append(None)`,
          `        else:`,
          `            if not hasattr(_instance, _op):`,
          `                raise AttributeError(f"Required method '{_op}' is not implemented on {_cls.__name__}")`,
          `            _method = getattr(_instance, _op)`,
          `            _out.append(_method(*_call_args))`,
          `    _result = _out`,
        ].join('\n')
        : `    _result = ${functionName}(${argList})`
    : [
      `    exec(__tracecode_compiled, _globals_dict)`,
      `    _result = _globals_dict.get('result', None)`,
    ].join('\n');

  const userCodeTraceSetup = [
    `\n_user_code_str = """${escapedCode}"""`,
    `import textwrap as _textwrap`,
    `_user_code_str = _textwrap.dedent(_user_code_str.lstrip("\\n"))`,
    `__tracecode_compiled = __tracecode_compile_user_code(_user_code_str)`,
    ].join('\n');

  const preloadUserDefinitions = functionName ? `exec(__tracecode_compiled, _globals_dict)\n` : '';

  const harnessSuffix = `
${userCodeTraceSetup}
${deps.PYTHON_CONVERSION_HELPERS_SNIPPET}

def _resolve_inplace_result():
    for _name in ${inplaceCandidatesLiteral}:
        if _name in globals():
            return globals().get(_name)
    return None

${inputSetup}

${treeConversions}

${listConversions}

${preloadUserDefinitions}

if _SCRIPT_MODE:
    _SCRIPT_PRE_USER_GLOBALS = set(globals().keys()) - _TRACE_INPUT_NAMES

sys.settrace(_tracer)
_trace_failed = False

try:
${executionCode}
except _InfiniteLoopDetected as e:
    _trace_failed = True
    _result = None
    # Infinite loop was detected - trace data already has the timeout event
except Exception as e:
    _trace_failed = True
    # Stop tracing immediately so error-handling internals are never traced.
    sys.settrace(None)
    _result = None
    _exc_type = type(e).__name__
    _exc_msg = str(e)
    _error_line = -1
    _exc_tb = getattr(e, '__traceback__', None)
    while _exc_tb is not None:
        if _exc_tb.tb_lineno is not None:
            _error_line = _exc_tb.tb_lineno
        _exc_tb = _exc_tb.tb_next
    _trace_data.append({
        'line': _error_line,
        'event': 'exception',
        'variables': {
            'error': _exc_msg,
            'errorType': _exc_type,
            'errorLine': _error_line
        },
        'function': 'error',
        'callStack': _snapshot_call_stack(),
        'stdoutLineCount': len(_console_output),
        'accesses': __tracecode_flush_accesses(None)
    })

if (not _trace_failed) and _result is None:
    _inplace = _resolve_inplace_result()
    if _inplace is not None:
        _result = _inplace

sys.settrace(None)

_builtins.print = _original_print
print = _original_print

json.dumps({
    'trace': _trace_data,
    'result': _serialize(_result),
    'console': _console_output,
    'userCodeStartLine': ${userCodeStartLine},
    'traceLimitExceeded': _trace_limit_exceeded,
    'timeoutReason': _timeout_reason,
    'lineEventCount': _total_line_events,
    'traceStepCount': len(_trace_data)
})
`;

  const code = harnessPrefix + harnessSuffix;

  return { code, userCodeStartLine };
}

/**
 * Parse Python error message
 */
function parsePythonError(rawError, userCodeStartLine, userCodeLineCount) {
  const mapRawLineToUserLine = (rawLine, allowOutOfBounds = false) => {
    const adjustedLine = rawLine - userCodeStartLine + 1;
    if (adjustedLine <= 0) return undefined;
    if (
      !allowOutOfBounds &&
      typeof userCodeLineCount === 'number' &&
      userCodeLineCount > 0 &&
      adjustedLine > userCodeLineCount
    ) {
      return undefined;
    }
    return adjustedLine;
  };

  const rewriteEmbeddedLineRefs = (message) =>
    message.replace(/\b(on\s+)?line (\d+)\b/g, (fullMatch, onPrefix = '', lineNumText) => {
      const rawLine = parseInt(lineNumText, 10);
      const mappedLine =
        mapRawLineToUserLine(rawLine, false) ??
        mapRawLineToUserLine(rawLine, true);
      if (!mappedLine) return fullMatch;
      return `${onPrefix}line ${mappedLine}`;
    });

  // Prefer frame lines from user-compiled code, then fall back to generic "line N" matches.
  const frameLineMatches = [
    ...rawError.matchAll(/File "(?:<exec>|<string>|<user_code>)", line (\d+)/g),
  ];
  const frameRawLines = frameLineMatches.map((match) => parseInt(match[1], 10));
  const genericLineMatches = [...rawError.matchAll(/line (\d+)/g)];
  const genericRawLines = genericLineMatches.map((match) => parseInt(match[1], 10));
  const syntaxLineMatch = rawError.match(/\bon line (\d+)/);

  const orderedCandidates = [];
  if (syntaxLineMatch) {
    orderedCandidates.push(parseInt(syntaxLineMatch[1], 10));
  }

  // Tracebacks are outermost -> innermost, so reverse to prefer the innermost frame.
  for (let i = frameRawLines.length - 1; i >= 0; i -= 1) {
    orderedCandidates.push(frameRawLines[i]);
  }
  if (orderedCandidates.length === 0) {
    for (let i = genericRawLines.length - 1; i >= 0; i -= 1) {
      orderedCandidates.push(genericRawLines[i]);
    }
  }

  let userCodeLine;
  let hasTrustedUserLine = false;
  for (const rawLine of orderedCandidates) {
    const adjustedLine = mapRawLineToUserLine(rawLine, false);
    if (!adjustedLine) continue;
    userCodeLine = adjustedLine;
    hasTrustedUserLine = true;
    break;
  }

  if (userCodeLine === undefined) {
    for (const rawLine of orderedCandidates) {
      const adjustedLine = mapRawLineToUserLine(rawLine, true);
      if (adjustedLine) {
        userCodeLine = adjustedLine;
        break;
      }
    }
  }

  const errorTypeMatch = rawError.match(/\b((?:\w+Error)|(?:\w+Exception)|KeyError|StopIteration|AssertionError):\s*([\s\S]+)/);
  
  let formattedMessage;
  
  if (errorTypeMatch) {
    const [, errorType, errorMsg] = errorTypeMatch;
    const cleanedMsg = rewriteEmbeddedLineRefs(errorMsg.trim().split('\n')[0]);
    
    if (hasTrustedUserLine && userCodeLine !== undefined) {
      formattedMessage = `${errorType} on line ${userCodeLine}: ${cleanedMsg}`;
    } else {
      formattedMessage = `${errorType}: ${cleanedMsg}`;
    }
  } else {
    const lines = rawError.trim().split('\n');
    const lastLine = lines[lines.length - 1].trim();
    
    if (hasTrustedUserLine && userCodeLine !== undefined) {
      formattedMessage = `Error on line ${userCodeLine}: ${lastLine}`;
    } else {
      formattedMessage = lastLine || rawError;
    }
  }

  return {
    message: formattedMessage,
    line: hasTrustedUserLine ? userCodeLine : undefined,
  };
}

/**
 * Execute Python code with tracing
 * @param {string} code - The user's Python code
 * @param {string} functionName - The function to call
 * @param {object} inputs - Input parameters
 * @param {object} options - Optional limits for tracing
 */
async function executeWithTracing(deps, code, functionName, inputs, executionStyle = 'function', options = {}) {
  const startTime = deps.performanceNow();
  const userCodeLineCount = code.split('\n').length;
  const { code: tracingCode, userCodeStartLine } = generateTracingCode(deps, 
    code,
    functionName,
    inputs,
    executionStyle,
    options
  );

  try {
    await deps.loadPyodideInstance();
    
    const resultJson = await deps.getPyodide().runPythonAsync(tracingCode);
    const result = JSON.parse(resultJson);

    const executionTimeMs = deps.performanceNow() - startTime;

    const errorStep = result.trace.find(step => step.event === 'exception');
    const timeoutStep = result.trace.find(step => step.event === 'timeout');
    const timeoutReason =
      result.timeoutReason ||
      timeoutStep?.variables?.timeoutReason ||
      undefined;

    const adjustedTrace = result.trace.map(step => ({
      ...step,
      line: step.line > 0 ? step.line - userCodeStartLine + 1 : step.line,
    }));
    const filteredTrace = adjustedTrace.filter((step) => {
      if (!step || typeof step !== 'object') return false;
      const line = typeof step.line === 'number' ? step.line : Number(step.line);
      if (!Number.isFinite(line)) return false;
      // Keep only user-code line numbers; drop harness setup/teardown noise
      // such as module bootstrap locals and _resolve_inplace_result frames.
      return line >= 1 && line <= userCodeLineCount;
    });

    let errorMessage;
    let errorLine;
    
    const isTraceBudgetExceeded =
      timeoutReason === 'trace-limit' ||
      timeoutReason === 'line-limit' ||
      timeoutReason === 'single-line-limit' ||
      (result.traceLimitExceeded && timeoutReason !== 'client-timeout');

    // Handle tracing guard stops and execution timeouts
    if (result.traceLimitExceeded || timeoutStep) {
      const lastStep = adjustedTrace[adjustedTrace.length - 1];
      errorLine = lastStep?.line;
      const lineSuffix = errorLine && errorLine > 0 ? ` on line ${errorLine}` : '';

      if (timeoutReason === 'client-timeout') {
        errorMessage = `Execution timed out${lineSuffix}. This may indicate an infinite loop or very expensive execution.`;
      } else if (isTraceBudgetExceeded) {
        errorMessage = `Trace budget exceeded${lineSuffix}. Step-by-step visualization hit its safety limits before execution finished.`;
      } else {
        errorMessage = `Execution stopped${lineSuffix}.`;
      }
    } else if (errorStep) {
      const errorType = errorStep.variables?.errorType;
      const errorMsg = errorStep.variables?.error;
      const rawErrorLine = errorStep.variables?.errorLine;
      
      if (rawErrorLine && rawErrorLine > 0) {
        const mappedLine = rawErrorLine - userCodeStartLine + 1;
        if (mappedLine > 0 && mappedLine <= userCodeLineCount) {
          errorLine = mappedLine;
        }
      }
      
      if (errorType && errorMsg) {
        if (errorLine && errorLine > 0) {
          errorMessage = `${errorType} on line ${errorLine}: ${errorMsg}`;
        } else {
          errorMessage = `${errorType}: ${errorMsg}`;
        }
      } else {
        errorMessage = errorMsg || 'Unknown error';
      }
    }

    return {
      success: !errorStep && !result.traceLimitExceeded && !timeoutStep,
      output: result.result,
      error: errorMessage,
      errorLine,
      trace: filteredTrace,
      executionTimeMs,
      consoleOutput: result.console,
      traceLimitExceeded: result.traceLimitExceeded,
      timeoutReason,
      lineEventCount: result.lineEventCount,
      traceStepCount: result.traceStepCount,
    };
  } catch (error) {
    const executionTimeMs = deps.performanceNow() - startTime;
    const rawError = error instanceof Error ? error.message : String(error);
    
    const { message, line } = parsePythonError(rawError, userCodeStartLine, code.split('\n').length);
    const isClientTimeout = rawError.includes('timed out');

    return {
      success: false,
      error: isClientTimeout
        ? 'Execution timed out. This may indicate an infinite loop or very expensive execution.'
        : message,
      errorLine: line,
      trace: [],
      executionTimeMs,
      consoleOutput: [],
      timeoutReason: isClientTimeout ? 'client-timeout' : undefined,
      traceLimitExceeded: isClientTimeout ? true : undefined,
      lineEventCount: 0,
      traceStepCount: 0,
    };
  }
}

/**
 * Execute Python code without tracing (for running tests)
 */
async function executeCode(deps, code, functionName, inputs, executionStyle = 'function', options = {}) {
  const userCodeLineCount = code.split('\n').length;
  let userCodeStartLine = 1;
  const interviewGuardEnabled = options.interviewGuard === true;
  const interviewGuardConfig = {
    maxLineEvents: Math.max(10000, options.maxLineEvents ?? deps.INTERVIEW_GUARD_DEFAULTS.maxLineEvents),
    maxSingleLineHits: Math.max(1000, options.maxSingleLineHits ?? deps.INTERVIEW_GUARD_DEFAULTS.maxSingleLineHits),
    maxCallDepth: Math.max(100, options.maxCallDepth ?? deps.INTERVIEW_GUARD_DEFAULTS.maxCallDepth),
    maxMemoryBytes: Math.max(8 * 1024 * 1024, options.maxMemoryBytes ?? deps.INTERVIEW_GUARD_DEFAULTS.maxMemoryBytes),
    memoryCheckEvery: Math.max(10, options.memoryCheckEvery ?? deps.INTERVIEW_GUARD_DEFAULTS.memoryCheckEvery),
  };

  try {
    await deps.loadPyodideInstance();

    const inputSetup = Object.entries(inputs)
      .map(([key, value]) => `${key} = ${deps.toPythonLiteral(value)}`)
      .join('\n');

    // Separate tree inputs (have left/right) from list inputs (have next)
    const treeInputKeys = [];
    const listInputKeys = [];
    
    Object.entries(inputs).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && ('val' in value || 'value' in value)) {
        const hasLeft = 'left' in value;
        const hasRight = 'right' in value;
        const hasNext = 'next' in value;
        
        if (hasLeft || hasRight) {
          treeInputKeys.push(key);
        } else if (hasNext) {
          listInputKeys.push(key);
        } else {
          treeInputKeys.push(key);
        }
      }
    });

    const treeConversions = treeInputKeys.length > 0
      ? treeInputKeys.map(key => `${key} = _dict_to_tree(${key})`).join('\n')
      : '';
    
    const listConversions = listInputKeys.length > 0
      ? listInputKeys.map(key => `${key} = _dict_to_list(${key})`).join('\n')
      : '';

    const inputArgs = Object.keys(inputs)
      .map((key) => `${key}=${key}`)
      .join(', ');
    const inplaceCandidates = ['nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid', 'head']
      .filter((key) => Object.prototype.hasOwnProperty.call(inputs, key));
    const inplaceCandidatesLiteral = JSON.stringify(inplaceCandidates);
    const executionCall = executionStyle === 'solution-method'
      ? `if 'Solution' in globals() and hasattr(Solution, '${functionName}'):
    _solver = Solution()
    _result = getattr(_solver, '${functionName}')(${inputArgs})
elif '${functionName}' in globals() and callable(globals()['${functionName}']):
    _result = globals()['${functionName}'](${inputArgs})
else:
    raise NameError("Implement Solution.${functionName}(...)")`
      : executionStyle === 'ops-class'
        ? `_ops = operations if 'operations' in locals() else (ops if 'ops' in locals() else None)
_args = arguments if 'arguments' in locals() else (args if 'args' in locals() else None)
if _ops is None or _args is None:
    raise ValueError("ops-class execution requires inputs.operations and inputs.arguments (or ops/args)")
if len(_ops) != len(_args):
    raise ValueError("operations and arguments must have the same length")
_cls = ${functionName}
_instance = None
_out = []
for _i, _op in enumerate(_ops):
    _call_args = _args[_i] if _i < len(_args) else []
    if _call_args is None:
        _call_args = []
    if not isinstance(_call_args, (list, tuple)):
        _call_args = [_call_args]
    if _i == 0:
        _instance = _cls(*_call_args)
        _out.append(None)
    else:
        if not hasattr(_instance, _op):
            raise AttributeError(f"Required method '{_op}' is not implemented on {_cls.__name__}")
        _method = getattr(_instance, _op)
        _out.append(_method(*_call_args))
_result = _out`
        : `_result = ${functionName}(${inputArgs})`;
    const executionCallInTry = executionCall
      .split('\n')
      .map((line) => (line ? `    ${line}` : line))
      .join('\n');
    const executionCallInNestedTry = executionCall
      .split('\n')
      .map((line) => (line ? `        ${line}` : line))
      .join('\n');

    // Keep stdout capture deterministic for the app UI; worker-console mirroring
    // can cause recursive print chains across mixed runs in dev.
    const mirrorPrintToConsole = false;
    const execPrefix = `
import json
import math
import sys
import builtins as _builtins
${deps.PYTHON_CLASS_DEFINITIONS_SNIPPET}

_console_output = []
_original_print = _builtins.print
_MIRROR_PRINT_TO_WORKER_CONSOLE = ${mirrorPrintToConsole ? 'True' : 'False'}

def _custom_print(*args, **kwargs):
    output = " ".join(str(arg) for arg in args)
    _console_output.append(output)
    # Do not mirror to worker console; app UI owns stdout rendering.

print = _custom_print

${deps.PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET}

${interviewGuardEnabled
  ? `
class _InterviewGuardTriggered(Exception):
    pass

_interview_timeout_reason = None
_interview_line_events = 0
_interview_line_hits = {}
_interview_call_depth = 0
_interview_tracemalloc_started = False

_INTERVIEW_GUARD_INTERNAL_FUNCS = {
    '_custom_print', '_serialize', '_dict_to_tree', '_dict_to_list',
    '_interview_guard_tracer', '_interview_check_memory',
    '_interview_guard_start', '_interview_guard_stop'
}

_INTERVIEW_GUARD_MAX_LINE_EVENTS = ${interviewGuardConfig.maxLineEvents}
_INTERVIEW_GUARD_MAX_SINGLE_LINE_HITS = ${interviewGuardConfig.maxSingleLineHits}
_INTERVIEW_GUARD_MAX_CALL_DEPTH = ${interviewGuardConfig.maxCallDepth}
_INTERVIEW_GUARD_MAX_MEMORY_BYTES = ${interviewGuardConfig.maxMemoryBytes}
_INTERVIEW_GUARD_MEMORY_CHECK_EVERY = ${interviewGuardConfig.memoryCheckEvery}

try:
    import tracemalloc as _interview_tracemalloc
except Exception:
    _interview_tracemalloc = None

def _interview_check_memory():
    global _interview_timeout_reason
    if _interview_tracemalloc is None or _INTERVIEW_GUARD_MAX_MEMORY_BYTES <= 0:
        return
    try:
        _current, _peak = _interview_tracemalloc.get_traced_memory()
    except Exception:
        return
    if _current >= _INTERVIEW_GUARD_MAX_MEMORY_BYTES or _peak >= _INTERVIEW_GUARD_MAX_MEMORY_BYTES:
        _interview_timeout_reason = 'memory-limit'
        raise _InterviewGuardTriggered('INTERVIEW_GUARD_TRIGGERED:memory-limit')

def _interview_guard_tracer(frame, event, arg):
    global _interview_timeout_reason, _interview_line_events, _interview_line_hits, _interview_call_depth
    _func_name = frame.f_code.co_name

    if _func_name in _INTERVIEW_GUARD_INTERNAL_FUNCS:
        return _interview_guard_tracer

    if event == 'call':
        _interview_call_depth += 1
        if _interview_call_depth > _INTERVIEW_GUARD_MAX_CALL_DEPTH:
            _interview_timeout_reason = 'recursion-limit'
            raise _InterviewGuardTriggered('INTERVIEW_GUARD_TRIGGERED:recursion-limit')
    elif event == 'return':
        if _interview_call_depth > 0:
            _interview_call_depth -= 1
    elif event == 'line':
        _interview_line_events += 1
        if _interview_line_events >= _INTERVIEW_GUARD_MAX_LINE_EVENTS:
            _interview_timeout_reason = 'line-limit'
            raise _InterviewGuardTriggered('INTERVIEW_GUARD_TRIGGERED:line-limit')

        _line_key = (_func_name, frame.f_lineno)
        _line_hits = _interview_line_hits.get(_line_key, 0) + 1
        _interview_line_hits[_line_key] = _line_hits
        if _line_hits >= _INTERVIEW_GUARD_MAX_SINGLE_LINE_HITS:
            _interview_timeout_reason = 'single-line-limit'
            raise _InterviewGuardTriggered('INTERVIEW_GUARD_TRIGGERED:single-line-limit')

        if _INTERVIEW_GUARD_MEMORY_CHECK_EVERY > 0 and (_interview_line_events % _INTERVIEW_GUARD_MEMORY_CHECK_EVERY) == 0:
            _interview_check_memory()

    return _interview_guard_tracer

def _interview_guard_start():
    global _interview_tracemalloc_started
    if _interview_tracemalloc is not None:
        try:
            if not _interview_tracemalloc.is_tracing():
                _interview_tracemalloc.start()
                _interview_tracemalloc_started = True
        except Exception:
            _interview_tracemalloc_started = False
    _interview_check_memory()
    sys.settrace(_interview_guard_tracer)

def _interview_guard_stop():
    sys.settrace(None)
    if _interview_tracemalloc is not None and _interview_tracemalloc_started:
        try:
            _interview_tracemalloc.stop()
        except Exception:
            pass
`
  : ''}
`;
    userCodeStartLine = execPrefix.split('\n').length;
    const execSuffix = interviewGuardEnabled
      ? `
${deps.PYTHON_CONVERSION_HELPERS_SNIPPET}

def _resolve_inplace_result():
    for _name in ${inplaceCandidatesLiteral}:
        if _name in globals():
            return globals().get(_name)
    return None

${inputSetup}

${treeConversions}

${listConversions}

_result = None
_interview_guard_triggered = False
_interview_guard_reason = None

try:
    _interview_guard_start()
    try:
${executionCallInNestedTry}
    finally:
        _interview_guard_stop()
except _InterviewGuardTriggered as _guard_error:
    _interview_guard_triggered = True
    _interview_guard_reason = _interview_timeout_reason or str(_guard_error)
finally:
    _builtins.print = _original_print
    print = _original_print

if _interview_guard_triggered:
    _json_out = json.dumps({
        "guardTriggered": True,
        "timeoutReason": _interview_guard_reason,
        "console": _console_output,
    })
else:
    if _result is None:
        _inplace = _resolve_inplace_result()
        if _inplace is not None:
            _result = _inplace
    _json_out = json.dumps({
        "guardTriggered": False,
        "output": _serialize(_result),
        "console": _console_output,
    })

_json_out
`
      : `
${deps.PYTHON_CONVERSION_HELPERS_SNIPPET}

def _resolve_inplace_result():
    for _name in ${inplaceCandidatesLiteral}:
        if _name in globals():
            return globals().get(_name)
    return None

${inputSetup}

${treeConversions}

${listConversions}

try:
${executionCallInTry}
finally:
    _builtins.print = _original_print
    print = _original_print

if _result is None:
    _inplace = _resolve_inplace_result()
    if _inplace is not None:
        _result = _inplace

json.dumps({
    "output": _serialize(_result),
    "console": _console_output,
})
`;
    const execCode = execPrefix + code + execSuffix;

    const resultJson = await deps.getPyodide().runPythonAsync(execCode);
    const result = JSON.parse(resultJson);

    if (result.guardTriggered) {
      return {
        success: false,
        output: null,
        error: result.timeoutReason || 'INTERVIEW_GUARD_TRIGGERED:resource-limit',
        consoleOutput: Array.isArray(result.console) ? result.console : [],
      };
    }

    return {
      success: true,
      output: result.output,
      consoleOutput: Array.isArray(result.console) ? result.console : [],
    };
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    const { message, line } = parsePythonError(rawError, userCodeStartLine, userCodeLineCount);

    return {
      success: false,
      output: null,
      error: message,
      errorLine: line,
      consoleOutput: [],
    };
  }
}

  globalScope.__TRACECODE_PYODIDE_RUNTIME__ = {
    generateTracingCode,
    parsePythonError,
    executeWithTracing,
    executeCode,
  };
})(typeof self !== 'undefined' ? self : globalThis);
