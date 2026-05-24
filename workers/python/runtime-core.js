/**
 * Pyodide runtime core helpers loaded by pyodide-worker.js.
 *
 * Exposes runtime helpers behind a dependency-injected surface so
 * the top-level worker can stay focused on loading + message dispatch.
 */

(function initPyodideRuntimeCore(globalScope) {
const PYTHON_DEFAULT_IMPORT_PRELUDE = `
import array
from array import array
import bisect
from bisect import *
import collections
from collections import *
import functools
from functools import *
import heapq
from heapq import *
import itertools
from itertools import *
import operator
from operator import *
import re
import string
try:
    from sortedcontainers import SortedDict, SortedList, SortedSet
except Exception:
    pass
`;

const DEFAULT_TRACE_MAX_PATH_DEPTH = 3;
const MAX_TRACE_MAX_PATH_DEPTH = 8;

function getTraceMaxPathDepth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TRACE_MAX_PATH_DEPTH;
  }
  return Math.min(MAX_TRACE_MAX_PATH_DEPTH, Math.max(1, Math.floor(value)));
}

function generateTracingCode(deps, userCode, functionName, inputs, executionStyle = 'function', options = {}) {
  const inputSetup = Object.entries(inputs)
    .map(([key, value]) => `${key} = ${deps.toPythonLiteral(value)}`)
    .join('\n');

  const escapedCode = userCode.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  const targetFunction = functionName || '';
  
  // Configurable limits
  const maxTraceSteps = options.maxTraceSteps || 2000;
  const maxStoredEvents = options.maxStoredEvents || Math.max(maxTraceSteps * 10, maxTraceSteps);
  const effectiveMaxTraceSteps = Math.min(maxTraceSteps, maxStoredEvents);
  const maxLineEvents = options.maxLineEvents || 10000;
  const maxSingleLineHits = options.maxSingleLineHits || 500;
  const minimalTrace = options.minimalTrace === true;
  const maxPathDepth = getTraceMaxPathDepth(options.maxPathDepth);
  // Keep stdout capture deterministic for the app UI; worker-console mirroring
  // can cause recursive print chains across mixed runs in dev.
  const mirrorPrintToConsole = false;

  // Python harness code - all at column 0, using 4-space indentation
  const harnessPrefix = `
import sys
import json
import math
import ast
import operator as _tracecode_operator
from typing import *
import builtins as _builtins
${deps.PYTHON_CLASS_DEFINITIONS_SNIPPET}

_TRACECODE_TYPING_GLOBALS = {name for name in globals().keys() if not name.startswith('_')}

_trace_data = []
_trace_events = []
_console_output = []
_original_print = _builtins.print
_tracecode_builtin_id = _builtins.id
_target_function = "${targetFunction}"
_MIRROR_PRINT_TO_WORKER_CONSOLE = ${mirrorPrintToConsole ? 'True' : 'False'}
_MINIMAL_TRACE = ${minimalTrace ? 'True' : 'False'}
_TRACE_MAX_PATH_DEPTH = ${maxPathDepth}
_SCRIPT_MODE = ${functionName ? 'False' : 'True'}
_TRACE_INPUT_NAMES = set(${JSON.stringify(Object.keys(inputs))})

class _InfiniteLoopDetected(Exception):
    pass

def _custom_print(*args, **kwargs):
    output = " ".join(str(arg) for arg in args)
    _console_output.append(output)
    try:
        _frame = sys._getframe(1)
        TraceHooks.flush_completed_line(_frame)
        __tracecode_append_trace_step(_frame, {
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
_last_trace_index_by_frame = {}
_TRACE_MUTATING_METHODS = {'append', 'appendleft', 'pop', 'popleft', 'extend', 'insert', 'add', 'remove', 'discard', 'clear', 'sort', 'reverse'}
_internal_funcs = {'_serialize', '_serialize_output', '_tracecode_ref_id', '_tracer', '_custom_print', '_dict_to_tree', '_dict_to_list', '_tracecode_materialize_input', '_is_structural_constructor_frame', '_snapshot_call_stack', '_snapshot_locals', '_stable_token', '_looks_like_adjacency_list', '_looks_like_indexed_adjacency_list', '_resolve_inplace_result', 'TraceHooks', 'flush_completed_line', 'flush_callsite_line', '_resolve_previous_step', '_append_step_runtime_events', '__tracecode_record_access', '__tracecode_flush_accesses', '__tracecode_append_trace_step', '__tracecode_append_trace_events_for_step', '__tracecode_append_runtime_event', '__tracecode_frame_id_for_step', '__tracecode_access_target', '__tracecode_access_binding', '__tracecode_access_kind', '__tracecode_value_at_path', '__tracecode_access_value', '__tracecode_attach_accesses_to_previous_step', '__tracecode_normalize_index_component', '__tracecode_normalize_indices', '__tracecode_serialize_call_arg', '__tracecode_serialize_call_args', '__tracecode_make_callsite_frame_id', '__tracecode_make_access_event', '__tracecode_make_iteration_access_event', '__tracecode_record_destructured_iteration_accesses', '__tracecode_is_indexable_sequence', '__tracecode_read_value', '__tracecode_write_value', '__tracecode_delete_value', '__tracecode_apply_augmented_value', '__tracecode_apply_inplace_augmented_value', '_tracecode_user_call', '_tracecode_sum', '_tracecode_read_index', '_tracecode_write_index', '_tracecode_write_scalar', '_tracecode_delete_index', '_tracecode_augassign_scalar', '_tracecode_augassign_index', '_tracecode_mutating_call', '_tracecode_mutating_index_call', '_tracecode_heapq_mutation', '_tracecode_contains_key_indexed', '_tracecode_dict_get', '_tracecode_dict_get_indexed', '_tracecode_len', '_tracecode_enumerate', '_tracecode_iter_bind', '_tracecode_iter_bind_literal', '_tracecode_iter_bind_expr', '_tracecode_iter_bind_indexed', '_tracecode_iter_bind_slice', '_tracecode_range_bind', '_tracecode_for_target_binding_name', '_tracecode_scalar_target_names', '_tracecode_source_string_node', '_tracecode_collect_user_function_names', '_tracecode_is_pure_literal_scaffold', '_tracecode_collect_collapsed_literal_lines', '__tracecode_attach_parents', '_tracecode_extract_named_subscript', '_tracecode_extract_mutable_container_target', '__TracecodeAccessTransformer', '__tracecode_compile_user_code', '<listcomp>', '<dictcomp>', '<setcomp>', '<genexpr>'}
_internal_locals = {
    '_trace_data', '_trace_events', '_console_output', '_original_print', '_target_function',
    '_MIRROR_PRINT_TO_WORKER_CONSOLE', '_MINIMAL_TRACE', '_SKIP_SENTINEL',
    '_SCRIPT_MODE', '_TRACE_INPUT_NAMES', '_SCRIPT_PRE_USER_GLOBALS',
    '_tracecode_builtin_id', '_tracecode_operator',
    '_TRACECODE_TYPING_GLOBALS',
    '_call_stack', '_pending_accesses', '_last_trace_index_by_frame', '_TRACE_MUTATING_METHODS', '_internal_funcs', '_internal_locals', '_max_trace_steps',
    '_trace_limit_exceeded', '_timeout_reason', '_total_line_events', '_max_line_events', '_max_stored_events',
    '_line_hit_count', '_max_single_line_hits', '_infinite_loop_line',
    '_MAX_SERIALIZE_DEPTH', '_trace_failed', '_inplace',
    '_custom_print', '_tracer', '_serialize', '_serialize_output', '_tracecode_ref_id', '_dict_to_tree', '_dict_to_list', '_tracecode_materialize_input',
    '_is_structural_constructor_frame', '_snapshot_call_stack', '_snapshot_locals', '_stable_token',
    '_looks_like_adjacency_list', '_looks_like_indexed_adjacency_list', '_resolve_inplace_result',
    '__tracecode_record_access', '__tracecode_flush_accesses', '__tracecode_append_trace_step',
    '__tracecode_append_trace_events_for_step', '__tracecode_frame_id_for_step',
    '__tracecode_access_target', '__tracecode_access_binding', '__tracecode_access_kind', '__tracecode_value_at_path',
    '__tracecode_access_value',
    '__tracecode_attach_accesses_to_previous_step', '__tracecode_normalize_index_component', '__tracecode_normalize_indices',
    '__tracecode_serialize_call_arg', '__tracecode_serialize_call_args', '__tracecode_make_callsite_frame_id',
    '__tracecode_make_access_event', '__tracecode_make_iteration_access_event', '__tracecode_record_destructured_iteration_accesses',
    '__tracecode_is_indexable_sequence', '__tracecode_read_value', '__tracecode_write_value',
    '__tracecode_delete_value', '__tracecode_apply_augmented_value', '__tracecode_apply_inplace_augmented_value', '_tracecode_read_index', '_tracecode_write_index', '_tracecode_write_scalar',
    '_tracecode_delete_index', '_tracecode_augassign_scalar', '_tracecode_augassign_index', '_tracecode_user_call', '_tracecode_sum', '_tracecode_mutating_call', '_tracecode_mutating_index_call', '_tracecode_heapq_mutation', '_tracecode_read_attr', '_tracecode_write_attr', '_tracecode_contains_key', '_tracecode_contains_key_indexed', '_tracecode_dict_get', '_tracecode_dict_get_indexed', '_tracecode_enumerate', '_tracecode_iter_bind', '_tracecode_iter_bind_literal', '_tracecode_iter_bind_expr', '_tracecode_iter_bind_indexed', '_tracecode_iter_bind_slice', '_tracecode_range_bind', '_tracecode_for_target_binding_name', '_tracecode_scalar_target_names', '_tracecode_source_string_node', '_tracecode_exception_value', '_tracecode_collapsed_literal_lines',
    '_tracecode_collect_user_function_names', '_tracecode_is_pure_literal_scaffold', '_tracecode_collect_collapsed_literal_lines', '__tracecode_attach_parents',
    '_tracecode_extract_named_subscript', '_tracecode_extract_mutable_container_target', '__TracecodeAccessTransformer', '__tracecode_compile_user_code',
    '_InfiniteLoopDetected', '_tb', '_result', '_exc_type', '_exc_msg', '_exc_tb',
    '_error_line', '_solver', '_ops', '_args', '_cls', '_instance', '_out',
    '_i', '_op', '_call_args', '_method', '_user_code_str', '_textwrap',
    '_globals_dict', '_k', '_preserve', '_real_globals', '_real_list',
    '__tracecode_tree', '__tracecode_compiled'
}
_max_trace_steps = ${effectiveMaxTraceSteps}
_max_stored_events = ${maxStoredEvents}
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
    return isinstance(value, _builtins.dict) and len(value) == 1 and isinstance(value.get('__ref__'), _builtins.str)

def _is_serialized_list_node(value):
    return isinstance(value, _builtins.dict) and value.get('__type__') == 'ListNode' and isinstance(value.get('__id__'), _builtins.str)

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

    marker = _tracecode_builtin_id(value)
    if marker in seen:
        return (node_ids, ref_ids)
    seen.add(marker)

    node_id = value.get('__id__')
    if isinstance(node_id, _builtins.str):
        node_ids.add(node_id)

    for field_name in ('next', 'prev'):
        if field_name in value:
            _collect_serialized_list_component(value.get(field_name), node_ids, ref_ids, seen)

    return (node_ids, ref_ids)

def _clone_serialized_value(value):
    if isinstance(value, _builtins.dict):
        return {key: _clone_serialized_value(nested) for key, nested in value.items()}
    if isinstance(value, _builtins.list):
        return [_clone_serialized_value(item) for item in value]
    return value

def _is_serialized_custom_object(value):
    return (
        isinstance(value, _builtins.dict) and
        isinstance(value.get('__id__'), _builtins.str) and
        isinstance(value.get('__class__'), _builtins.str) and
        value.get('__type__') not in ('TreeNode', 'ListNode')
    )

def _collect_serialized_custom_object_payloads(value, payloads=None, seen=None):
    if payloads is None:
        payloads = {}
    if seen is None:
        seen = set()
    if isinstance(value, _builtins.list):
        marker = _tracecode_builtin_id(value)
        if marker in seen:
            return payloads
        seen.add(marker)
        for item in value:
            _collect_serialized_custom_object_payloads(item, payloads, seen)
        return payloads
    if not isinstance(value, _builtins.dict):
        return payloads
    marker = _tracecode_builtin_id(value)
    if marker in seen:
        return payloads
    seen.add(marker)
    if _is_serialized_custom_object(value):
        payloads[value.get('__id__')] = value
    for nested in value.values():
        _collect_serialized_custom_object_payloads(nested, payloads, seen)
    return payloads

def _materialize_top_level_custom_object_aliases(local_vars):
    if not isinstance(local_vars, _builtins.dict) or len(local_vars) < 2:
        return local_vars
    payloads = {}
    for value in local_vars.values():
        _collect_serialized_custom_object_payloads(value, payloads)
    if not payloads:
        return local_vars
    for name, value in list(local_vars.items()):
        if not _is_serialized_ref(value):
            continue
        ref_id = value.get('__ref__')
        target = payloads.get(ref_id)
        if target is not None:
            local_vars[name] = _clone_serialized_value(target)
    return local_vars

def _inline_component_list_refs(value, root_payloads, seen_root_ids=None):
    if seen_root_ids is None:
        seen_root_ids = set()

    if _is_serialized_ref(value):
        ref_id = value.get('__ref__')
        if not isinstance(ref_id, _builtins.str):
            return value
        target = root_payloads.get(ref_id)
        if target is None or ref_id in seen_root_ids:
            return value
        next_seen = set(seen_root_ids)
        next_seen.add(ref_id)
        return _inline_component_list_refs(_clone_serialized_value(target), root_payloads, next_seen)

    if isinstance(value, _builtins.list):
        return [_inline_component_list_refs(item, root_payloads, seen_root_ids) for item in value]

    if not isinstance(value, _builtins.dict):
        return value

    out = {}
    next_seen = set(seen_root_ids)
    value_id = value.get('__id__')
    if isinstance(value_id, _builtins.str):
        next_seen.add(value_id)

    for key, nested in value.items():
        out[key] = _inline_component_list_refs(nested, root_payloads, next_seen)
    return out

def _normalize_top_level_linked_list_locals(local_vars):
    if not isinstance(local_vars, _builtins.dict) or len(local_vars) < 2:
        return local_vars

    ordered_names = list(local_vars.keys())
    candidates = []

    for index, name in enumerate(ordered_names):
        value = local_vars.get(name)
        root_id = _serialized_list_root_id(value)
        if not isinstance(root_id, _builtins.str):
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
            if isinstance(root_id, _builtins.str) and _is_serialized_list_node(value):
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
                set([canonical.get('root_id')]) if isinstance(canonical.get('root_id'), _builtins.str) else set(),
            )

        for candidate in group:
            if candidate is canonical:
                continue
            root_id = candidate.get('root_id')
            if isinstance(root_id, _builtins.str):
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
        local_vars = _materialize_top_level_custom_object_aliases(local_vars)
        local_sources = {name: _sources.get(name, 'user') for name in local_vars.keys()}
        return (local_vars, local_sources) if with_sources else local_vars
    except Exception:
        return ({}, {}) if with_sources else {}

def __tracecode_record_access(frame, event):
    if _trace_limit_exceeded:
        return
    if frame is None or not isinstance(event, _builtins.dict):
        return
    frame_key = _tracecode_builtin_id(frame)
    _pending_accesses.setdefault(frame_key, []).append(event)

def __tracecode_flush_accesses(frame):
    if _trace_limit_exceeded:
        return []
    if frame is None:
        return []
    return _pending_accesses.pop(_tracecode_builtin_id(frame), [])

def __tracecode_frame_id_for_step(step):
    stack = step.get('callStack') if isinstance(step, _builtins.dict) else []
    if isinstance(stack, _builtins.list) and len(stack) > 0:
        frame = stack[-1]
        if isinstance(frame, _builtins.dict):
            return str(frame.get('function')) + ':' + str(frame.get('line'))
    return str(step.get('function')) + ':' + str(step.get('line'))

def __tracecode_access_target(access):
    indices = access.get('indices') if isinstance(access, _builtins.dict) else None
    if isinstance(indices, _builtins.list) and len(indices) > 0:
        target = {'variable': access.get('variable'), 'path': indices}
        index_sources = access.get('indexSources')
        if isinstance(index_sources, _builtins.list) and len(index_sources) > 0:
            target['indexSources'] = index_sources
        return target
    return {'variable': access.get('variable')}

def __tracecode_access_binding(access):
    binding = access.get('binding') if isinstance(access, _builtins.dict) else None
    if not isinstance(binding, _builtins.dict):
        return None
    variable = binding.get('variable')
    if not isinstance(variable, _builtins.str) or len(variable) == 0:
        return None
    event = {'variable': variable}
    if binding.get('kind') == 'iteration':
        event['kind'] = 'iteration'
    return event

def __tracecode_access_kind(access):
    kind = access.get('kind') if isinstance(access, _builtins.dict) else None
    if kind in ('indexed-read', 'cell-read'):
        return 'read'
    if kind in ('indexed-write', 'cell-write'):
        return 'write'
    return 'mutate'

def __tracecode_value_at_path(value, path):
    if not isinstance(path, _builtins.list) or len(path) == 0:
        return value
    current = value
    for part in path:
        try:
            current = current[part]
        except Exception:
            return None
    return current

def __tracecode_access_value(step, access):
    if isinstance(access, _builtins.dict) and 'value' in access:
        return access.get('value')
    variables = step.get('variables') if isinstance(step, _builtins.dict) else {}
    root = variables.get(access.get('variable')) if isinstance(variables, _builtins.dict) else None
    return __tracecode_value_at_path(root, access.get('indices'))

def __tracecode_append_runtime_event(event):
    global _trace_limit_exceeded, _timeout_reason
    if len(_trace_events) >= _max_stored_events:
        if not _trace_limit_exceeded:
            _trace_limit_exceeded = True
            _timeout_reason = 'trace-limit'
        _pending_accesses.clear()
        return False
    _trace_events.append(event)
    return True

def __tracecode_append_trace_events_for_step(step):
    if not isinstance(step, _builtins.dict):
        return
    if _trace_limit_exceeded and step.get('event') != 'timeout':
        return
    line = step.get('line')
    event_kind = step.get('event')
    function_name = step.get('function')
    stack = step.get('callStack') if isinstance(step.get('callStack'), _builtins.list) else []
    base = {
        'runId': 'python:run',
        'line': line,
        'frameId': __tracecode_frame_id_for_step(step)
    }
    if len(stack) > 0:
        base['callStack'] = [f.copy() for f in stack]
    if event_kind == 'line':
        __tracecode_append_runtime_event({**base, 'kind': 'line', 'function': function_name})
    elif event_kind == 'call':
        frame = stack[-1] if len(stack) > 0 and isinstance(stack[-1], _builtins.dict) else {}
        event = {**base, 'kind': 'call', 'function': function_name, 'args': frame.get('args')}
        __tracecode_append_runtime_event(event)
    elif event_kind == 'return':
        event = {**base, 'kind': 'return', 'function': function_name}
        if 'returnValue' in step:
            event['value'] = step.get('returnValue')
        __tracecode_append_runtime_event(event)
    elif event_kind == 'exception':
        variables = step.get('variables') if isinstance(step.get('variables'), _builtins.dict) else {}
        __tracecode_append_runtime_event({**base, 'kind': 'exception', 'message': str(step.get('returnValue') or variables.get('error') or 'Runtime exception')})
    elif event_kind == 'timeout':
        __tracecode_append_runtime_event({**base, 'kind': 'timeout', 'message': 'Runtime timeout'})
    elif event_kind == 'stdout':
        variables = step.get('variables') if isinstance(step.get('variables'), _builtins.dict) else {}
        __tracecode_append_runtime_event({**base, 'kind': 'stdout', 'text': str(step.get('returnValue') or variables.get('output') or '')})

    variables = step.get('variables')
    if event_kind != '__access_only__' and isinstance(variables, _builtins.dict):
        for variable, value in variables.items():
            if not __tracecode_append_runtime_event({**base, 'kind': 'snapshot', 'target': {'variable': variable}, 'value': value}):
                return

    accesses = step.get('accesses')
    if isinstance(accesses, _builtins.list):
        for access in accesses:
            if not isinstance(access, _builtins.dict):
                continue
            kind = __tracecode_access_kind(access)
            target = __tracecode_access_target(access)
            if kind == 'mutate':
                method = access.get('method')
                event = {**base, 'kind': kind, 'target': target}
                if method:
                    event['method'] = method
                if isinstance(access.get('args'), _builtins.list):
                    event['args'] = access.get('args')
                if not __tracecode_append_runtime_event(event):
                    return
            else:
                event = {**base, 'kind': kind, 'target': target, 'value': __tracecode_access_value(step, access)}
                binding = __tracecode_access_binding(access)
                if binding is not None:
                    event['binding'] = binding
                if not __tracecode_append_runtime_event(event):
                    return

class TraceHooks:
    """
    RuntimeTrace is post-line: public line frames describe a source line after it
    completed. Python sys.settrace reports line events before execution, so the
    Python runtime keeps the legacy step pending and flushes it when execution
    advances to the next line or returns.
    """

    @staticmethod
    def _resolve_previous_step(frame):
        if frame is None:
            return None
        previous_index = _last_trace_index_by_frame.get(_tracecode_builtin_id(frame))
        if previous_index is None or previous_index < 0 or previous_index >= len(_trace_data):
            return None
        previous_step = _trace_data[previous_index]
        return previous_step if isinstance(previous_step, _builtins.dict) else None

    @staticmethod
    def _append_step_runtime_events(step):
        if step.get('__runtime_flushed'):
            return
        step['__runtime_flushed'] = True
        globals()['__tracecode_append_trace_events_for_step'](step)

    @staticmethod
    def flush_completed_line(frame):
        previous_step = TraceHooks._resolve_previous_step(frame)
        if previous_step is None:
            return
        if previous_step.get('event') != 'line':
            globals()['__tracecode_attach_accesses_to_previous_step'](frame)
            return
        if previous_step.get('__runtime_flushed'):
            globals()['__tracecode_attach_accesses_to_previous_step'](frame)
            return
        local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
        accesses = globals()['__tracecode_flush_accesses'](frame)
        previous_step['variables'] = local_vars
        previous_step['variableSources'] = local_sources
        previous_step['accesses'] = accesses
        previous_step['callStack'] = _snapshot_call_stack()
        previous_step['stdoutLineCount'] = len(_console_output)
        TraceHooks._append_step_runtime_events(previous_step)

    @staticmethod
    def flush_callsite_line(frame, line_number):
        previous_step = TraceHooks._resolve_previous_step(frame)
        if previous_step is None:
            return
        if previous_step.get('event') != 'line':
            return
        if previous_step.get('__runtime_flushed'):
            return
        if previous_step.get('line') != line_number:
            return
        local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
        accesses = globals()['__tracecode_flush_accesses'](frame)
        previous_step['variables'] = local_vars
        previous_step['variableSources'] = local_sources
        previous_step['accesses'] = accesses
        previous_step['callStack'] = _snapshot_call_stack()
        previous_step['stdoutLineCount'] = len(_console_output)
        TraceHooks._append_step_runtime_events(previous_step)

def __tracecode_append_trace_step(frame, step):
    global _trace_limit_exceeded, _timeout_reason
    if _trace_limit_exceeded and (not isinstance(step, _builtins.dict) or step.get('event') != 'timeout'):
        return
    if len(_trace_data) >= _max_trace_steps and (not isinstance(step, _builtins.dict) or step.get('event') != 'timeout'):
        if not _trace_limit_exceeded:
            _trace_limit_exceeded = True
            _timeout_reason = 'trace-limit'
        _pending_accesses.clear()
        return
    _trace_data.append(step)
    if not (isinstance(step, _builtins.dict) and step.get('event') == 'line'):
        if isinstance(step, _builtins.dict):
            step['__runtime_flushed'] = True
        __tracecode_append_trace_events_for_step(step)
    if frame is not None:
        _last_trace_index_by_frame[_tracecode_builtin_id(frame)] = len(_trace_data) - 1

def __tracecode_attach_accesses_to_previous_step(frame):
    accesses = __tracecode_flush_accesses(frame)
    if not accesses:
        return []
    frame_key = _tracecode_builtin_id(frame)
    previous_index = _last_trace_index_by_frame.get(frame_key)
    if previous_index is not None and 0 <= previous_index < len(_trace_data):
        previous_step = _trace_data[previous_index]
        existing_accesses = previous_step.get('accesses')
        if isinstance(existing_accesses, _builtins.list):
            existing_accesses.extend(accesses)
        else:
            previous_step['accesses'] = accesses
        for access in accesses:
            __tracecode_append_trace_events_for_step({
                'line': previous_step.get('line'),
                'event': '__access_only__',
                'variables': previous_step.get('variables', {}),
                'function': previous_step.get('function'),
                'callStack': previous_step.get('callStack', []),
                'accesses': [access],
            })
        return []
    return accesses

def __tracecode_normalize_index_component(index):
    if isinstance(index, slice):
        start = '' if index.start is None else str(index.start)
        stop = '' if index.stop is None else str(index.stop)
        step = '' if index.step is None else str(index.step)
        return f'{start}:{stop}' if step == '' else f'{start}:{stop}:{step}'
    if isinstance(index, int):
        return int(index)
    if isinstance(index, _builtins.str):
        return index
    if isinstance(index, (_builtins.tuple, _builtins.list)):
        normalized = []
        for part in index:
            if isinstance(part, slice):
                return None
            component = __tracecode_normalize_index_component(part)
            if component is None:
                return None
            normalized.append(component)
        return normalized
    return None

def __tracecode_normalize_indices(indices, max_depth=None):
    if max_depth is None:
        max_depth = _TRACE_MAX_PATH_DEPTH
    if not isinstance(indices, (list, _builtins.tuple)) or len(indices) == 0 or len(indices) > max_depth:
        return None
    normalized = []
    for index in indices:
        component = __tracecode_normalize_index_component(index)
        if component is None:
            return None
        normalized.append(component)
    return normalized

def __tracecode_serialize_call_arg(value):
    if callable(value):
        name = getattr(value, '__name__', None)
        return name if isinstance(name, _builtins.str) and name else '<callable>'
    return _serialize(value)

def __tracecode_serialize_call_args(args, kwargs=None):
    serialized = [__tracecode_serialize_call_arg(arg) for arg in args]
    if isinstance(kwargs, _builtins.dict):
        for key, value in kwargs.items():
            if isinstance(key, _builtins.str):
                serialized.append(f'{key}={__tracecode_serialize_call_arg(value)}')
    return serialized

def __tracecode_make_callsite_frame_id(frame, line_number):
    try:
        function_name = frame.f_code.co_name
    except Exception:
        function_name = '<unknown>'
    return str(function_name) + ':' + str(line_number)

def _tracecode_user_call(line_number, function_name, func, *args, **kwargs):
    _tracecode_previous_tracer = sys.gettrace()
    sys.settrace(None)
    try:
        TraceHooks.flush_callsite_line(sys._getframe(1), line_number)
    finally:
        sys.settrace(_tracecode_previous_tracer)
    return func(*args, **kwargs)

def __tracecode_normalize_index_sources(index_sources, path_length):
    if not isinstance(index_sources, (list, _builtins.tuple)) or not isinstance(path_length, int) or path_length <= 0:
        return None
    normalized = []
    for source in list(index_sources)[:path_length]:
        normalized.append(source if isinstance(source, _builtins.str) and len(source) > 0 else None)
    while len(normalized) < path_length:
        normalized.append(None)
    return normalized if any(source is not None for source in normalized) else None

def __tracecode_make_access_event(var_name, kind, indices=None, method_name=None, binding=None, value=None, index_sources=None, args=None):
    event = {
        'variable': var_name,
        'kind': kind,
    }
    if indices is not None:
        normalized_indices = __tracecode_normalize_indices(indices)
        if normalized_indices is None:
            return event
        event['indices'] = list(normalized_indices)
        event['pathDepth'] = len(normalized_indices)
        normalized_sources = __tracecode_normalize_index_sources(index_sources, len(normalized_indices))
        if normalized_sources is not None:
            event['indexSources'] = normalized_sources
    if method_name is not None:
        event['method'] = method_name
    if binding is not None:
        event['binding'] = binding
    if value is not None:
        event['value'] = value
    if args is not None:
        event['args'] = args
    return event

def __tracecode_make_iteration_access_event(var_name, kind, indices, binding_name, value, index_sources=None):
    event = __tracecode_make_access_event(
        var_name,
        kind,
        indices,
        binding={'kind': 'iteration', 'variable': binding_name} if isinstance(binding_name, _builtins.str) and binding_name else None,
        value=value,
        index_sources=index_sources,
    )
    if indices is not None and 'indexSources' not in event:
        event['indexSources'] = [None for _ in list(indices)]
    return event

def __tracecode_record_destructured_iteration_accesses(frame, var_name, base_indices, value, binding_names, index_sources=None):
    if not isinstance(binding_names, _builtins.list) or len(binding_names) <= 1:
        return
    if not isinstance(value, (_builtins.list, _builtins.tuple)):
        return
    normalized_base = list(base_indices)
    normalized_sources = list(index_sources) if isinstance(index_sources, _builtins.list) else [None for _ in normalized_base]
    for component_index, binding_name in enumerate(binding_names):
        if not isinstance(binding_name, _builtins.str) or not binding_name:
            continue
        if component_index >= len(value):
            break
        indices = [*normalized_base, component_index]
        sources = [*normalized_sources, None]
        __tracecode_record_access(
            frame,
            __tracecode_make_iteration_access_event(
                var_name,
                'cell-read' if len(indices) == 2 else 'indexed-read',
                indices,
                binding_name,
                _serialize(value[component_index]),
                sources,
            ),
        )

def __tracecode_is_indexable_sequence(value):
    return isinstance(value, (list, tuple, _builtins.str)) or (
        getattr(getattr(value, '__class__', None), '__name__', '') == 'deque'
    )

def __tracecode_read_value(container, indices):
    current = container
    for index in indices:
        if isinstance(current, _builtins.dict) or __tracecode_is_indexable_sequence(current):
            current = current[index]
        else:
            current = getattr(current, index)
    return current

def __tracecode_write_value(container, indices, value):
    if len(indices) == 1:
        if isinstance(container, _builtins.dict) or isinstance(container, _builtins.list):
            container[indices[0]] = value
        else:
            setattr(container, indices[0], value)
        return value
    parent = container
    for index in indices[:-1]:
        if isinstance(parent, _builtins.dict) or __tracecode_is_indexable_sequence(parent):
            parent = parent[index]
        else:
            parent = getattr(parent, index)
    if isinstance(parent, _builtins.dict) or isinstance(parent, _builtins.list):
        parent[indices[-1]] = value
    else:
        setattr(parent, indices[-1], value)
    return value

def __tracecode_delete_value(container, indices):
    if len(indices) == 1:
        if isinstance(container, _builtins.dict) or isinstance(container, _builtins.list):
            del container[indices[0]]
        else:
            delattr(container, indices[0])
        return None
    parent = container
    for index in indices[:-1]:
        if isinstance(parent, _builtins.dict) or __tracecode_is_indexable_sequence(parent):
            parent = parent[index]
        else:
            parent = getattr(parent, index)
    if isinstance(parent, _builtins.dict) or isinstance(parent, _builtins.list):
        del parent[indices[-1]]
    else:
        delattr(parent, indices[-1])
    return None

def __tracecode_apply_augmented_value(current, op_name, rhs):
    if op_name == 'add':
        return current + rhs
    if op_name == 'sub':
        return current - rhs
    if op_name == 'mul':
        return current * rhs
    if op_name == 'matmul':
        return current @ rhs
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

def __tracecode_apply_inplace_augmented_value(current, op_name, rhs):
    if op_name == 'add':
        return _tracecode_operator.iadd(current, rhs)
    if op_name == 'sub':
        return _tracecode_operator.isub(current, rhs)
    if op_name == 'mul':
        return _tracecode_operator.imul(current, rhs)
    if op_name == 'matmul':
        return _tracecode_operator.imatmul(current, rhs)
    if op_name == 'div':
        return _tracecode_operator.itruediv(current, rhs)
    if op_name == 'floordiv':
        return _tracecode_operator.ifloordiv(current, rhs)
    if op_name == 'mod':
        return _tracecode_operator.imod(current, rhs)
    if op_name == 'pow':
        return _tracecode_operator.ipow(current, rhs)
    if op_name == 'lshift':
        return _tracecode_operator.ilshift(current, rhs)
    if op_name == 'rshift':
        return _tracecode_operator.irshift(current, rhs)
    if op_name == 'bitand':
        return _tracecode_operator.iand(current, rhs)
    if op_name == 'bitor':
        return _tracecode_operator.ior(current, rhs)
    if op_name == 'bitxor':
        return _tracecode_operator.ixor(current, rhs)
    return rhs

def _tracecode_read_index(var_name, container, indices, index_sources=None):
    result = __tracecode_read_value(container, list(indices))
    normalized = __tracecode_normalize_indices(indices)
    if normalized is not None:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(
                var_name,
                'cell-read' if len(normalized) == 2 else 'indexed-read',
                normalized,
                index_sources=index_sources,
                value=_serialize(result),
            ),
        )
    return result

def _tracecode_write_index(var_name, container, indices, index_sources, value):
    effective_indices = list(indices)
    parent_value = None
    parent_indices = effective_indices[:-1]
    parent_normalized = __tracecode_normalize_indices(parent_indices) if len(parent_indices) > 0 else None
    if parent_normalized is not None:
        try:
            parent_value = __tracecode_read_value(container, parent_indices)
            __tracecode_record_access(
                sys._getframe(1),
                __tracecode_make_access_event(
                    var_name,
                    'cell-read' if len(parent_normalized) == 2 else 'indexed-read',
                    parent_normalized,
                    index_sources=list(index_sources or [])[:len(parent_normalized)] if isinstance(index_sources, _builtins.list) else None,
                    value=_serialize(parent_value),
                ),
            )
        except Exception:
            parent_value = None
    result = __tracecode_write_value(container, effective_indices, value)
    normalized = __tracecode_normalize_indices(effective_indices)
    if normalized is not None:
        if isinstance(container, _builtins.dict):
            __tracecode_record_access(
                sys._getframe(1),
                __tracecode_make_access_event(var_name, 'indexed-write', normalized, index_sources=index_sources, value=_serialize(result)),
            )
            return result
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(
                var_name,
                'cell-write' if len(normalized) == 2 else 'indexed-write',
                normalized,
                index_sources=index_sources,
                value=_serialize(result),
            ),
        )
    return result

def _tracecode_write_scalar(var_name, value):
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(var_name, 'indexed-write', value=_serialize(value)),
    )
    return value

def _tracecode_augassign_scalar(var_name, current, op_name, rhs):
    next_value = __tracecode_apply_inplace_augmented_value(current, op_name, rhs)
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(var_name, 'indexed-write', value=_serialize(next_value)),
    )
    return next_value

def _tracecode_delete_index(var_name, container, indices, index_sources=None):
    effective_indices = list(indices)
    __tracecode_delete_value(container, effective_indices)
    normalized = __tracecode_normalize_indices(effective_indices)
    if normalized is not None:
        args = [_serialize(effective_indices[-1])] if len(effective_indices) > 0 else []
        if isinstance(container, _builtins.dict):
            __tracecode_record_access(
                sys._getframe(1),
                __tracecode_make_access_event(var_name, 'mutating-call', normalized, method_name='remove', index_sources=index_sources, args=args),
            )
        else:
            __tracecode_record_access(
                sys._getframe(1),
                __tracecode_make_access_event(var_name, 'mutating-call', normalized, method_name='remove', index_sources=index_sources, args=args),
            )
    return None

def _tracecode_augassign_index(var_name, container, indices, index_sources, op_name, rhs):
    effective_indices = list(indices)
    current = __tracecode_read_value(container, effective_indices)
    normalized = __tracecode_normalize_indices(effective_indices)
    if normalized is not None:
        if isinstance(container, _builtins.dict):
            __tracecode_record_access(
                sys._getframe(1),
                __tracecode_make_access_event(var_name, 'indexed-read', normalized, index_sources=index_sources, value=_serialize(current)),
            )
        else:
            __tracecode_record_access(
                sys._getframe(1),
                __tracecode_make_access_event(
                    var_name,
                    'cell-read' if len(normalized) == 2 else 'indexed-read',
                    normalized,
                    index_sources=index_sources,
                    value=_serialize(current),
                ),
            )
    next_value = __tracecode_apply_augmented_value(current, op_name, rhs)
    __tracecode_write_value(container, effective_indices, next_value)
    if normalized is not None:
        if isinstance(container, _builtins.dict):
            __tracecode_record_access(
                sys._getframe(1),
                __tracecode_make_access_event(var_name, 'indexed-write', normalized, index_sources=index_sources, value=_serialize(next_value)),
            )
        else:
            __tracecode_record_access(
                sys._getframe(1),
                __tracecode_make_access_event(
                    var_name,
                    'cell-write' if len(normalized) == 2 else 'indexed-write',
                    normalized,
                    index_sources=index_sources,
                    value=_serialize(next_value),
                ),
            )
    return next_value

def _tracecode_mutating_call(var_name, container, method_name, *args, **kwargs):
    index_sources = kwargs.pop('__tracecode_index_sources', None)
    before_len = None
    try:
        container_class_name = getattr(getattr(container, '__class__', None), '__name__', '')
        if method_name in {'append', 'appendleft', 'extend', 'extendleft', 'insert'} and (
            isinstance(container, _builtins.list) or container_class_name == 'deque'
        ):
            before_len = len(container)
    except Exception:
        before_len = None
    result = getattr(container, method_name)(*args, **kwargs)
    if method_name in _TRACE_MUTATING_METHODS:
        if (
            len(args) >= 1 and
            method_name in {'pop', 'remove', 'discard'} and
            isinstance(container, (_builtins.dict, set))
        ):
            normalized = __tracecode_normalize_indices([args[0]])
            if normalized is not None:
                __tracecode_record_access(
                    sys._getframe(1),
                    __tracecode_make_access_event(
                        var_name,
                        'mutating-call',
                        normalized,
                        method_name=method_name,
                        index_sources=index_sources,
                        args=__tracecode_serialize_call_args(args, kwargs),
                    ),
                )
                return result
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(var_name, 'mutating-call', method_name=method_name, args=__tracecode_serialize_call_args(args, kwargs)),
        )
        if before_len is not None:
            if method_name == 'append' and len(args) >= 1:
                __tracecode_record_access(
                    sys._getframe(1),
                    __tracecode_make_access_event(var_name, 'indexed-write', [before_len], value=_serialize(args[0])),
                )
            elif method_name == 'appendleft' and len(args) >= 1:
                __tracecode_record_access(
                    sys._getframe(1),
                    __tracecode_make_access_event(var_name, 'indexed-write', [0], value=_serialize(args[0])),
                )
            elif method_name == 'extend' and len(args) >= 1:
                try:
                    for offset, value in enumerate(args[0]):
                        __tracecode_record_access(
                            sys._getframe(1),
                            __tracecode_make_access_event(var_name, 'indexed-write', [before_len + offset], value=_serialize(value)),
                        )
                except Exception:
                    pass
        elif method_name in {'sort', 'reverse'} and isinstance(container, _builtins.list):
            try:
                for index, value in enumerate(container):
                    __tracecode_record_access(
                        sys._getframe(1),
                        __tracecode_make_access_event(var_name, 'indexed-write', [index], value=_serialize(value)),
                    )
            except Exception:
                pass
    return result

def _tracecode_mutating_index_call(var_name, container, indices, index_sources, method_name, *args, **kwargs):
    effective_indices = list(indices)
    target = __tracecode_read_value(container, effective_indices)
    before_len = None
    try:
        if method_name in {'append', 'appendleft', 'extend', 'extendleft', 'insert'}:
            before_len = len(target)
    except Exception:
        before_len = None
    result = getattr(target, method_name)(*args, **kwargs)
    normalized = __tracecode_normalize_indices(effective_indices)
    if method_name in _TRACE_MUTATING_METHODS:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(var_name, 'indexed-read', normalized, index_sources=index_sources),
        )
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(var_name, 'mutating-call', normalized, method_name, index_sources=index_sources, args=__tracecode_serialize_call_args(args, kwargs)),
        )
        if normalized is not None and before_len is not None:
            if method_name == 'append' and len(args) >= 1:
                __tracecode_record_access(
                    sys._getframe(1),
                    __tracecode_make_access_event(var_name, 'indexed-write', list(normalized) + [before_len], index_sources=list(index_sources or []) + [None], value=_serialize(args[0])),
                )
            elif method_name == 'appendleft' and len(args) >= 1:
                __tracecode_record_access(
                    sys._getframe(1),
                    __tracecode_make_access_event(var_name, 'indexed-write', list(normalized) + [0], index_sources=list(index_sources or []) + [None], value=_serialize(args[0])),
                )
            elif method_name == 'extend' and len(args) >= 1:
                try:
                    for offset, value in enumerate(args[0]):
                        __tracecode_record_access(
                            sys._getframe(1),
                            __tracecode_make_access_event(var_name, 'indexed-write', list(normalized) + [before_len + offset], index_sources=list(index_sources or []) + [None], value=_serialize(value)),
                        )
                except Exception:
                    pass
        elif normalized is not None and method_name in {'sort', 'reverse'} and isinstance(target, _builtins.list):
            try:
                for index, value in enumerate(target):
                    __tracecode_record_access(
                        sys._getframe(1),
                        __tracecode_make_access_event(var_name, 'indexed-write', list(normalized) + [index], index_sources=list(index_sources or []) + [None], value=_serialize(value)),
                    )
            except Exception:
                pass
    return result

def _tracecode_heapq_mutation(var_name, container, indices, method_name, *args, **kwargs):
    import heapq as __tracecode_heapq
    effective_indices = list(indices or [])
    target = __tracecode_read_value(container, effective_indices) if effective_indices else container
    normalized = __tracecode_normalize_indices(effective_indices)
    try:
        before_values = list(target) if isinstance(target, _builtins.list) else None
    except Exception:
        before_values = None
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(
            var_name,
            'indexed-read',
            normalized,
            value=_serialize(target),
        ),
    )
    if method_name == 'heappush':
        result = __tracecode_heapq.heappush(target, *args, **kwargs)
    elif method_name == 'heappop':
        result = __tracecode_heapq.heappop(target, *args, **kwargs)
    else:
        result = getattr(__tracecode_heapq, method_name)(target, *args, **kwargs)
    if normalized:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(var_name, 'mutating-call', normalized, method_name=method_name, args=__tracecode_serialize_call_args(args, kwargs)),
        )
    else:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(var_name, 'mutating-call', method_name=method_name, args=__tracecode_serialize_call_args(args, kwargs)),
        )
    try:
        after_values = list(target) if before_values is not None else None
        if after_values is not None:
            path_prefix = list(normalized or [])
            source_prefix = [None for _ in path_prefix]
            for index, value in enumerate(after_values):
                if index >= len(before_values) or before_values[index] != value:
                    __tracecode_record_access(
                        sys._getframe(1),
                        __tracecode_make_access_event(
                            var_name,
                            'indexed-write',
                            path_prefix + [index],
                            index_sources=source_prefix + [None],
                            value=_serialize(value),
                        ),
                    )
    except Exception:
        pass
    return result

def _tracecode_read_attr(var_name, obj, attr_name):
    value = getattr(obj, attr_name)
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(var_name, 'indexed-read', [attr_name], value=_serialize(value)),
    )
    return value

def _tracecode_len(var_name, obj):
    value = len(obj)
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(var_name, 'indexed-read', ['len'], value=value),
    )
    return value

def _tracecode_sum(var_name, iterable, *args, **kwargs):
    frame = sys._getframe(1)
    try:
        if __tracecode_is_indexable_sequence(iterable) or isinstance(iterable, range):
            for index, value in enumerate(iterable):
                __tracecode_record_access(
                    frame,
                    __tracecode_make_access_event(var_name, 'indexed-read', [index], value=_serialize(value)),
                )
        else:
            __tracecode_record_access(
                frame,
                __tracecode_make_access_event(var_name, 'indexed-read', ['<iteration>']),
            )
    except Exception:
        pass
    return _builtins.sum(iterable, *args, **kwargs)

def _tracecode_write_attr(var_name, obj, attr_name, value):
    setattr(obj, attr_name, value)
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(var_name, 'indexed-write', [attr_name], value=_serialize(value)),
    )
    return value

def _tracecode_contains_key(var_name, container, key, key_source=None):
    result = key in container
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(
            var_name,
            'indexed-read',
            __tracecode_normalize_indices([key]),
            index_sources=[key_source] if isinstance(key_source, _builtins.str) and key_source else None,
            value=result,
        ),
    )
    return result

def _tracecode_contains_key_indexed(var_name, container, indices, index_sources, key, key_source=None):
    effective_indices = list(indices)
    target = __tracecode_read_value(container, effective_indices)
    result = key in target
    access_indices = effective_indices + [key]
    access_sources = list(index_sources) if isinstance(index_sources, _builtins.list) else []
    access_sources.append(key_source if isinstance(key_source, _builtins.str) and key_source else None)
    normalized = __tracecode_normalize_indices(access_indices)
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(
            var_name,
            'cell-read' if normalized is not None and len(normalized) == 2 else 'indexed-read',
            normalized,
            index_sources=access_sources,
            value=result,
        ),
    )
    return result

def _tracecode_dict_get(var_name, container, key, key_source=None, default=None):
    result = container.get(key, default)
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(
            var_name,
            'indexed-read',
            __tracecode_normalize_indices([key]),
            index_sources=[key_source] if isinstance(key_source, _builtins.str) and key_source else None,
            value=_serialize(result),
        ),
    )
    return result

def _tracecode_dict_get_indexed(var_name, container, indices, index_sources, key, key_source=None, default=None):
    target = __tracecode_read_value(container, list(indices))
    result = target.get(key, default)
    access_indices = list(indices) + [key]
    access_sources = list(index_sources) if isinstance(index_sources, _builtins.list) else []
    access_sources.append(key_source if isinstance(key_source, _builtins.str) and key_source else None)
    normalized = __tracecode_normalize_indices(access_indices)
    __tracecode_record_access(
        sys._getframe(1),
        __tracecode_make_access_event(
            var_name,
            'indexed-read',
            normalized,
            index_sources=access_sources,
            value=_serialize(result),
        ),
    )
    return result

def _tracecode_enumerate(var_name, container, binding_name=None, index_binding_name=None, binding_names=None, *args, **kwargs):
    for offset, (index, value) in enumerate(enumerate(container, *args, **kwargs)):
        frame = sys._getframe(1)
        if isinstance(index_binding_name, _builtins.str) and index_binding_name:
            __tracecode_record_access(
                frame,
                __tracecode_make_access_event(index_binding_name, 'indexed-write', value=_serialize(index)),
            )
        __tracecode_record_access(
            frame,
            __tracecode_make_iteration_access_event(
                var_name,
                'indexed-read',
                [offset],
                binding_name,
                _serialize(value),
                index_sources=[index_binding_name] if isinstance(index_binding_name, _builtins.str) and index_binding_name else None,
            ),
        )
        __tracecode_record_destructured_iteration_accesses(
            frame,
            var_name,
            [offset],
            value,
            binding_names,
            [index_binding_name] if isinstance(index_binding_name, _builtins.str) and index_binding_name else [None],
        )
        yield index, value

def _tracecode_iter_bind(var_name, container, binding_name, binding_names=None):
    for index, value in enumerate(container):
        frame = sys._getframe(1)
        __tracecode_record_access(
            frame,
            __tracecode_make_iteration_access_event(
                var_name,
                'indexed-read',
                [index],
                binding_name,
                _serialize(value),
                [None],
            ),
        )
        __tracecode_record_destructured_iteration_accesses(frame, var_name, [index], value, binding_names, [None])
        yield value

def _tracecode_iter_bind_literal(binding_name, container, binding_names=None):
    for index, value in enumerate(container):
        frame = sys._getframe(1)
        __tracecode_record_access(
            frame,
            __tracecode_make_iteration_access_event(
                binding_name,
                'indexed-read',
                [index],
                binding_name,
                _serialize(value),
                [None],
            ),
        )
        __tracecode_record_destructured_iteration_accesses(frame, binding_name, [index], value, binding_names, [None])
        yield value

def _tracecode_iter_bind_expr(iter_source, container, binding_name, binding_names=None):
    for index, value in enumerate(container):
        frame = sys._getframe(1)
        __tracecode_record_access(
            frame,
            __tracecode_make_iteration_access_event(
                iter_source,
                'indexed-read',
                [index],
                binding_name,
                _serialize(value),
                [None],
            ),
        )
        __tracecode_record_destructured_iteration_accesses(frame, iter_source, [index], value, binding_names, [None])
        yield value

def _tracecode_iter_bind_indexed(var_name, container, base_indices, index_sources, binding_name, binding_names=None):
    effective_base_indices = list(base_indices)
    normalized_base = __tracecode_normalize_indices(effective_base_indices)
    normalized_sources = list(index_sources) if isinstance(index_sources, _builtins.list) else []
    for index, value in enumerate(container):
        if normalized_base is not None:
            frame = sys._getframe(1)
            indices = [*normalized_base, index]
            sources = [*normalized_sources, None]
            __tracecode_record_access(
                frame,
                __tracecode_make_iteration_access_event(
                    var_name,
                    'cell-read' if len(indices) == 2 else 'indexed-read',
                    indices,
                    binding_name,
                    _serialize(value),
                    sources,
                ),
            )
            __tracecode_record_destructured_iteration_accesses(frame, var_name, indices, value, binding_names, sources)
        yield value

def _tracecode_iter_bind_slice(var_name, container, start, start_source, binding_name, binding_names=None):
    sliced = container[start:]
    try:
        normalized_start = start.__index__() if hasattr(start, '__index__') else start
        if normalized_start is None:
            offset = 0
        elif isinstance(normalized_start, int):
            length = len(container)
            offset = normalized_start if normalized_start >= 0 else max(length + normalized_start, 0)
            offset = min(offset, length)
        else:
            offset = 0
    except Exception:
        offset = 0
    sources = [start_source] if isinstance(start_source, _builtins.str) and start_source else [None]
    for index, value in enumerate(sliced):
        frame = sys._getframe(1)
        __tracecode_record_access(
            frame,
            __tracecode_make_iteration_access_event(
                var_name,
                'indexed-read',
                [offset + index],
                binding_name,
                _serialize(value),
                sources,
            ),
        )
        __tracecode_record_destructured_iteration_accesses(frame, var_name, [offset + index], value, binding_names, sources)
        yield value

def _tracecode_range_bind(binding_name, iterable):
    for value in iterable:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(binding_name, 'indexed-write', value=_serialize(value)),
        )
        yield value

def _tracecode_for_target_binding_name(target):
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for element in target.elts:
            if not isinstance(element, ast.Name):
                return None
            names.append(element.id)
        return ','.join(names) if names else None
    return None

def _tracecode_scalar_target_names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for element in target.elts:
            names.extend(_tracecode_scalar_target_names(element))
        return names
    return []

def _tracecode_exception_value(line_number, error):
    frame = sys._getframe(1)
    TraceHooks.flush_completed_line(frame)
    __tracecode_append_trace_step(frame, {
        'line': line_number,
        'event': 'exception',
        'variables': {},
        'function': frame.f_code.co_name,
        'callStack': _snapshot_call_stack(),
        'returnValue': str(error),
    })
    return error

def __tracecode_attach_parents(node, parent=None):
    for child in ast.iter_child_nodes(node):
        setattr(child, '__trace_parent__', node)
        __tracecode_attach_parents(child, node)

def _tracecode_extract_named_subscript(node):
    indices = []
    current = node
    while isinstance(current, ast.Subscript) and len(indices) < _TRACE_MAX_PATH_DEPTH:
        indices.insert(0, current.slice)
        current = current.value
    while isinstance(current, ast.Attribute) and len(indices) < _TRACE_MAX_PATH_DEPTH:
        indices.insert(0, ast.Constant(value=current.attr))
        current = current.value
    if not isinstance(current, ast.Name) or len(indices) == 0 or len(indices) > _TRACE_MAX_PATH_DEPTH:
        return None
    return current.id, indices

def _tracecode_index_source_node(index):
    if isinstance(index, ast.Name):
        return ast.Constant(value=index.id)
    has_name = False
    for child in ast.walk(index):
        if isinstance(child, ast.Name):
            has_name = True
            break
    if has_name:
        try:
            return ast.Constant(value=ast.unparse(index).strip())
        except Exception:
            return ast.Constant(value=None)
    return ast.Constant(value=None)

def _tracecode_source_string_node(node):
    try:
        source = ast.unparse(node).strip()
    except Exception:
        source = None
    return ast.Constant(value=source if source else '<iterable>')

def _tracecode_extract_named_attribute(node):
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        return node.value.id, node.attr
    return None

def _tracecode_extract_mutable_container_target(node):
    if isinstance(node, ast.Name):
        return node.id, ast.Name(id=node.id, ctx=ast.Load()), []
    extracted = _tracecode_extract_named_subscript(node)
    if extracted is not None:
        var_name, indices = extracted
        return var_name, ast.Name(id=var_name, ctx=ast.Load()), indices
    attr_extracted = _tracecode_extract_named_attribute(node)
    if attr_extracted is not None:
        var_name, attr_name = attr_extracted
        return var_name, ast.Name(id=var_name, ctx=ast.Load()), [ast.Constant(value=attr_name)]
    return None

def _tracecode_is_annotation_node(node):
    current = node
    parent = getattr(current, '__trace_parent__', None)
    while parent is not None:
        if (
            (isinstance(parent, ast.arg) and getattr(parent, 'annotation', None) is current) or
            (isinstance(parent, ast.AnnAssign) and getattr(parent, 'annotation', None) is current) or
            (isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)) and getattr(parent, 'returns', None) is current)
        ):
            return True
        current = parent
        parent = getattr(current, '__trace_parent__', None)
    return False

def _tracecode_collect_user_function_names(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
    return names

class __TracecodeAccessTransformer(ast.NodeTransformer):
    def __init__(self, user_function_names=None):
        super().__init__()
        self._tracecode_user_function_names = set(user_function_names or [])

    def _tracecode_wrap_comprehension_generators(self, generators):
        for generator in generators:
            binding_name = _tracecode_for_target_binding_name(generator.target)
            if binding_name is None:
                continue
            binding_names = _tracecode_scalar_target_names(generator.target)
            binding_names_node = ast.List(
                elts=[ast.Constant(value=name) for name in binding_names],
                ctx=ast.Load(),
            )
            if (
                isinstance(generator.iter, ast.Name)
            ):
                var_name = generator.iter.id
                generator.iter = ast.copy_location(
                    ast.Call(
                        func=ast.Name(id='_tracecode_iter_bind', ctx=ast.Load()),
                        args=[
                            ast.Constant(value=var_name),
                            ast.Name(id=var_name, ctx=ast.Load()),
                            ast.Constant(value=binding_name),
                            binding_names_node,
                        ],
                        keywords=[],
                    ),
                    generator.iter,
                )
                continue
            if (
                isinstance(generator.iter, ast.Call) and
                isinstance(generator.iter.func, ast.Name) and
                generator.iter.func.id == 'enumerate' and
                len(generator.iter.args) >= 1 and
                isinstance(generator.iter.args[0], ast.Name)
            ):
                var_name = generator.iter.args[0].id
                index_binding_name = None
                value_binding_name = binding_name
                if (
                    isinstance(generator.target, ast.Tuple) and
                    len(generator.target.elts) >= 2 and
                    isinstance(generator.target.elts[0], ast.Name) and
                    isinstance(generator.target.elts[1], (ast.Name, ast.Tuple, ast.List))
                ):
                    index_binding_name = generator.target.elts[0].id
                    value_binding_name = _tracecode_for_target_binding_name(generator.target.elts[1])
                    value_binding_names = _tracecode_scalar_target_names(generator.target.elts[1])
                else:
                    value_binding_names = binding_names
                value_binding_names_node = ast.List(
                    elts=[ast.Constant(value=name) for name in value_binding_names],
                    ctx=ast.Load(),
                )
                generator.iter = ast.copy_location(
                    ast.Call(
                        func=ast.Name(id='_tracecode_enumerate', ctx=ast.Load()),
                        args=[
                            ast.Constant(value=var_name),
                            ast.Name(id=var_name, ctx=ast.Load()),
                            ast.Constant(value=value_binding_name),
                            ast.Constant(value=index_binding_name),
                            value_binding_names_node,
                            *generator.iter.args[1:],
                        ],
                        keywords=generator.iter.keywords,
                    ),
                    generator.iter,
                )

    def visit_ListComp(self, node):
        node = self.generic_visit(node)
        self._tracecode_wrap_comprehension_generators(node.generators)
        return node

    def visit_DictComp(self, node):
        node = self.generic_visit(node)
        self._tracecode_wrap_comprehension_generators(node.generators)
        return node

    def visit_SetComp(self, node):
        node = self.generic_visit(node)
        self._tracecode_wrap_comprehension_generators(node.generators)
        return node

    def visit_For(self, node):
        original_iter = node.iter
        node = self.generic_visit(node)
        binding_name = _tracecode_for_target_binding_name(node.target)
        binding_names = _tracecode_scalar_target_names(node.target)
        binding_names_node = ast.List(
            elts=[ast.Constant(value=name) for name in binding_names],
            ctx=ast.Load(),
        )
        if (
            isinstance(node.iter, ast.Name) and
            binding_name is not None
        ):
            var_name = node.iter.id
            node.iter = ast.copy_location(
                ast.Call(
                    func=ast.Name(id='_tracecode_iter_bind', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        ast.Name(id=var_name, ctx=ast.Load()),
                        ast.Constant(value=binding_name),
                        binding_names_node,
                    ],
                    keywords=[],
                ),
                node.iter,
            )
            return node
        if (
            isinstance(original_iter, ast.Subscript) and
            isinstance(original_iter.value, ast.Name) and
            not isinstance(original_iter.slice, ast.Slice) and
            binding_name is not None
        ):
            var_name = original_iter.value.id
            extracted = _tracecode_extract_named_subscript(original_iter)
            if extracted is not None:
                _, indices = extracted
                node.iter = ast.copy_location(
                    ast.Call(
                        func=ast.Name(id='_tracecode_iter_bind_indexed', ctx=ast.Load()),
                        args=[
                            ast.Constant(value=var_name),
                            node.iter,
                            ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                            ast.List(elts=[_tracecode_index_source_node(index) for index in indices], ctx=ast.Load()),
                            ast.Constant(value=binding_name),
                            binding_names_node,
                        ],
                        keywords=[],
                    ),
                    node.iter,
                )
                return node
        if (
            isinstance(original_iter, ast.Subscript) and
            isinstance(original_iter.value, ast.Name) and
            isinstance(original_iter.slice, ast.Slice) and
            original_iter.slice.upper is None and
            original_iter.slice.step is None and
            binding_name is not None
        ):
            var_name = original_iter.value.id
            start_node = self.visit(original_iter.slice.lower) if original_iter.slice.lower is not None else ast.Constant(value=None)
            node.iter = ast.copy_location(
                ast.Call(
                    func=ast.Name(id='_tracecode_iter_bind_slice', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        ast.Name(id=var_name, ctx=ast.Load()),
                        start_node,
                        _tracecode_index_source_node(original_iter.slice.lower) if original_iter.slice.lower is not None else ast.Constant(value=None),
                        ast.Constant(value=binding_name),
                        binding_names_node,
                    ],
                    keywords=[],
                ),
                node.iter,
            )
            return node
        if (
            isinstance(node.iter, (ast.List, ast.Tuple, ast.Set, ast.Dict)) and
            binding_name is not None
        ):
            node.iter = ast.copy_location(
                ast.Call(
                    func=ast.Name(id='_tracecode_iter_bind_literal', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=binding_name),
                        node.iter,
                        binding_names_node,
                    ],
                    keywords=[],
                ),
                node.iter,
            )
            return node
        if (
            isinstance(node.iter, ast.Call) and
            isinstance(node.iter.func, ast.Name) and
            node.iter.func.id == 'range' and
            isinstance(node.target, ast.Name)
        ):
            binding_name = node.target.id
            node.iter = ast.copy_location(
                ast.Call(
                    func=ast.Name(id='_tracecode_range_bind', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=binding_name),
                        node.iter,
                    ],
                    keywords=[],
                ),
                node.iter,
            )
            return node
        if (
            isinstance(node.iter, ast.Call) and
            isinstance(node.iter.func, ast.Name) and
            node.iter.func.id == 'enumerate' and
            len(node.iter.args) >= 1
        ):
            var_name = node.iter.args[0].id if isinstance(node.iter.args[0], ast.Name) else None
            binding_name = None
            if (
                isinstance(node.target, ast.Tuple) and
                len(node.target.elts) >= 2 and
                isinstance(node.target.elts[0], ast.Name) and
                isinstance(node.target.elts[1], (ast.Name, ast.Tuple, ast.List))
            ):
                index_binding_name = node.target.elts[0].id
                binding_name = _tracecode_for_target_binding_name(node.target.elts[1])
                value_binding_names = _tracecode_scalar_target_names(node.target.elts[1])
            else:
                index_binding_name = None
                value_binding_names = binding_names
            value_binding_names_node = ast.List(
                elts=[ast.Constant(value=name) for name in value_binding_names],
                ctx=ast.Load(),
            )
            node.iter = ast.copy_location(
                ast.Call(
                    func=ast.Name(id='_tracecode_enumerate', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name) if var_name is not None else _tracecode_source_string_node(original_iter.args[0]),
                        ast.Name(id=var_name, ctx=ast.Load()) if var_name is not None else node.iter.args[0],
                        ast.Constant(value=binding_name),
                        ast.Constant(value=index_binding_name),
                        value_binding_names_node,
                        *node.iter.args[1:],
                    ],
                    keywords=node.iter.keywords,
                ),
                node.iter,
            )
            return node
        if binding_name is not None:
            node.iter = ast.copy_location(
                ast.Call(
                    func=ast.Name(id='_tracecode_iter_bind_expr', ctx=ast.Load()),
                    args=[
                        _tracecode_source_string_node(original_iter),
                        node.iter,
                        ast.Constant(value=binding_name),
                        binding_names_node,
                    ],
                    keywords=[],
                ),
                node.iter,
            )
        return node

    def visit_Subscript(self, node):
        if _tracecode_is_annotation_node(node):
            return self.generic_visit(node)
        parent = getattr(node, '__trace_parent__', None)
        if isinstance(parent, ast.Subscript) and getattr(parent, 'value', None) is node:
            return self.generic_visit(node)
        if isinstance(parent, ast.Assign) and node in getattr(parent, 'targets', []):
            return self.generic_visit(node)
        if isinstance(parent, ast.AugAssign) and getattr(parent, 'target', None) is node:
            return self.generic_visit(node)

        extracted = _tracecode_extract_named_subscript(node)
        if extracted is None or not isinstance(node.ctx, ast.Load):
            return self.generic_visit(node)

        var_name, indices = extracted
        index_sources = [_tracecode_index_source_node(index) for index in indices]
        call = ast.Call(
            func=ast.Name(id='_tracecode_read_index', ctx=ast.Load()),
            args=[
                ast.Constant(value=var_name),
                ast.Name(id=var_name, ctx=ast.Load()),
                ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                ast.List(elts=index_sources, ctx=ast.Load()),
            ],
            keywords=[],
        )
        return ast.copy_location(call, node)

    def visit_Assign(self, node):
        if len(node.targets) == 1:
            extracted = _tracecode_extract_named_subscript(node.targets[0])
            if extracted is not None:
                var_name, indices = extracted
                index_sources = [_tracecode_index_source_node(index) for index in indices]
                value = self.visit(node.value)
                call = ast.Call(
                    func=ast.Name(id='_tracecode_write_index', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        ast.Name(id=var_name, ctx=ast.Load()),
                        ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                        ast.List(elts=index_sources, ctx=ast.Load()),
                        value,
                    ],
                    keywords=[],
                )
                return ast.copy_location(ast.Expr(value=call), node)
            attr_extracted = _tracecode_extract_named_attribute(node.targets[0])
            if attr_extracted is not None:
                var_name, attr_name = attr_extracted
                value = self.visit(node.value)
                call = ast.Call(
                    func=ast.Name(id='_tracecode_write_attr', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        ast.Name(id=var_name, ctx=ast.Load()),
                        ast.Constant(value=attr_name),
                        value,
                    ],
                    keywords=[],
                )
                return ast.copy_location(ast.Expr(value=call), node)
        scalar_names = []
        for target in node.targets:
            scalar_names.extend(_tracecode_scalar_target_names(target))
        if scalar_names:
            visited = self.generic_visit(node)
            writes = []
            for scalar_name in scalar_names:
                write_call = ast.Expr(value=ast.Call(
                    func=ast.Name(id='_tracecode_write_scalar', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=scalar_name),
                        ast.Name(id=scalar_name, ctx=ast.Load()),
                    ],
                    keywords=[],
                ))
                writes.append(ast.copy_location(write_call, node))
            return [visited, *writes]
        return self.generic_visit(node)

    def visit_AnnAssign(self, node):
        if isinstance(node.target, ast.Name) and node.value is not None:
            visited = self.generic_visit(node)
            var_name = node.target.id
            call = ast.Expr(value=ast.Call(
                func=ast.Name(id='_tracecode_write_scalar', ctx=ast.Load()),
                args=[
                    ast.Constant(value=var_name),
                    ast.Name(id=var_name, ctx=ast.Load()),
                ],
                keywords=[],
            ))
            return [visited, ast.copy_location(call, node)]
        return self.generic_visit(node)

    def visit_AugAssign(self, node):
        op_names = {
            ast.Add: 'add',
            ast.Sub: 'sub',
            ast.Mult: 'mul',
            ast.MatMult: 'matmul',
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

        extracted = _tracecode_extract_named_subscript(node.target)
        if extracted is None:
            if isinstance(node.target, ast.Name):
                var_name = node.target.id
                call = ast.Call(
                    func=ast.Name(id='_tracecode_augassign_scalar', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        ast.Name(id=var_name, ctx=ast.Load()),
                        ast.Constant(value=op_name),
                        self.visit(node.value),
                    ],
                    keywords=[],
                )
                assign = ast.Assign(
                    targets=[ast.copy_location(ast.Name(id=var_name, ctx=ast.Store()), node.target)],
                    value=call,
                )
                return ast.copy_location(assign, node)
            return self.generic_visit(node)

        var_name, indices = extracted
        index_sources = [_tracecode_index_source_node(index) for index in indices]
        rhs = self.visit(node.value)
        call = ast.Call(
            func=ast.Name(id='_tracecode_augassign_index', ctx=ast.Load()),
            args=[
                ast.Constant(value=var_name),
                ast.Name(id=var_name, ctx=ast.Load()),
                ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                ast.List(elts=index_sources, ctx=ast.Load()),
                ast.Constant(value=op_name),
                rhs,
            ],
            keywords=[],
        )
        return ast.copy_location(ast.Expr(value=call), node)

    def visit_Delete(self, node):
        if len(node.targets) != 1:
            return self.generic_visit(node)
        extracted = _tracecode_extract_named_subscript(node.targets[0])
        if extracted is None:
            return self.generic_visit(node)
        var_name, indices = extracted
        index_sources = [_tracecode_index_source_node(index) for index in indices]
        call = ast.Call(
            func=ast.Name(id='_tracecode_delete_index', ctx=ast.Load()),
            args=[
                ast.Constant(value=var_name),
                ast.Name(id=var_name, ctx=ast.Load()),
                ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                ast.List(elts=index_sources, ctx=ast.Load()),
            ],
            keywords=[],
        )
        return ast.copy_location(ast.Expr(value=call), node)

    def visit_Call(self, node):
        if (
            isinstance(node.func, ast.Name) and
            node.func.id == 'sum' and
            node.func.id not in self._tracecode_user_function_names and
            len(node.args) >= 1 and
            isinstance(node.args[0], ast.Name)
        ):
            var_name = node.args[0].id
            call = ast.Call(
                func=ast.Name(id='_tracecode_sum', ctx=ast.Load()),
                args=[
                    ast.Constant(value=var_name),
                    ast.Name(id=var_name, ctx=ast.Load()),
                    *[self.visit(arg) for arg in node.args[1:]],
                ],
                keywords=[self.visit(keyword) for keyword in node.keywords],
            )
            return ast.copy_location(call, node)

        if (
            isinstance(node.func, ast.Name) and
            node.func.id == 'len' and
            len(node.args) == 1 and
            isinstance(node.args[0], ast.Name)
        ):
            var_name = node.args[0].id
            call = ast.Call(
                func=ast.Name(id='_tracecode_len', ctx=ast.Load()),
                args=[
                    ast.Constant(value=var_name),
                    ast.Name(id=var_name, ctx=ast.Load()),
                ],
                keywords=[],
            )
            return ast.copy_location(call, node)

        if (
            isinstance(node.func, ast.Attribute) and
            node.func.attr == 'get' and
            len(node.args) >= 1
        ):
            extracted = _tracecode_extract_mutable_container_target(node.func.value)
            if extracted is not None and len(extracted[2]) > 0:
                var_name, container, indices = extracted
                key_arg = node.args[0]
                default_args = node.args[1:2]
                call = ast.Call(
                    func=ast.Name(id='_tracecode_dict_get_indexed', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        container,
                        ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                        ast.List(elts=[_tracecode_index_source_node(index) for index in indices], ctx=ast.Load()),
                        self.visit(key_arg),
                        _tracecode_index_source_node(key_arg),
                        *[self.visit(arg) for arg in default_args],
                    ],
                    keywords=[self.visit(keyword) for keyword in node.keywords],
                )
                return ast.copy_location(call, node)

        if (
            isinstance(node.func, ast.Attribute) and
            isinstance(node.func.value, ast.Name) and
            node.func.value.id == 'heapq' and
            node.func.attr in {'heappush', 'heappop', 'heapify', 'heapreplace', 'heappushpop'} and
            len(node.args) >= 1
        ):
            extracted_heap = _tracecode_extract_mutable_container_target(node.args[0])
            if extracted_heap is not None:
                var_name, container, indices = extracted_heap
                call = ast.Call(
                    func=ast.Name(id='_tracecode_heapq_mutation', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        container,
                        ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                        ast.Constant(value=node.func.attr),
                        *[self.visit(arg) for arg in node.args[1:]],
                    ],
                    keywords=[self.visit(keyword) for keyword in node.keywords],
                )
                return ast.copy_location(call, node)

        if isinstance(node.func, ast.Attribute):
            method_name = node.func.attr
            if method_name in _TRACE_MUTATING_METHODS:
                extracted = _tracecode_extract_named_subscript(node.func.value)
                if extracted is not None:
                    var_name, indices = extracted
                    index_sources = [_tracecode_index_source_node(index) for index in indices]
                    call = ast.Call(
                        func=ast.Name(id='_tracecode_mutating_index_call', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        ast.Name(id=var_name, ctx=ast.Load()),
                        ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                        ast.List(elts=index_sources, ctx=ast.Load()),
                        ast.Constant(value=method_name),
                        *[self.visit(arg) for arg in node.args],
                    ],
                        keywords=[self.visit(keyword) for keyword in node.keywords],
                    )
                    return ast.copy_location(call, node)

        node = self.generic_visit(node)
        if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            method_name = node.func.attr
            if method_name == 'get' and len(node.args) >= 1:
                key_arg = node.args[0] if len(node.args) >= 1 else ast.Constant(value=None)
                default_args = node.args[1:2]
                call = ast.Call(
                    func=ast.Name(id='_tracecode_dict_get', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=node.func.value.id),
                        ast.Name(id=node.func.value.id, ctx=ast.Load()),
                        key_arg,
                        _tracecode_index_source_node(key_arg),
                        *default_args,
                    ],
                    keywords=node.keywords,
                )
                return ast.copy_location(call, node)
            if method_name in _TRACE_MUTATING_METHODS:
                keywords = node.keywords
                if method_name in {'pop', 'remove', 'discard'} and len(node.args) >= 1:
                    keywords = [
                        *node.keywords,
                        ast.keyword(
                            arg='__tracecode_index_sources',
                            value=ast.List(elts=[_tracecode_source_string_node(node.args[0])], ctx=ast.Load()),
                        ),
                    ]
                call = ast.Call(
                    func=ast.Name(id='_tracecode_mutating_call', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=node.func.value.id),
                        ast.Name(id=node.func.value.id, ctx=ast.Load()),
                        ast.Constant(value=method_name),
                        *node.args,
                    ],
                    keywords=keywords,
                )
                return ast.copy_location(call, node)
        if (
            isinstance(node.func, ast.Name) and
            node.func.id in self._tracecode_user_function_names
        ):
            call = ast.Call(
                func=ast.Name(id='_tracecode_user_call', ctx=ast.Load()),
                args=[
                    ast.Constant(value=getattr(node, 'lineno', 1)),
                    ast.Constant(value=node.func.id),
                    ast.Name(id=node.func.id, ctx=ast.Load()),
                    *node.args,
                ],
                keywords=node.keywords,
            )
            return ast.copy_location(call, node)
        return node

    def visit_Compare(self, node):
        if (
            len(node.ops) == 1 and
            len(node.comparators) == 1 and
            isinstance(node.ops[0], (ast.In, ast.NotIn))
        ):
            if isinstance(node.comparators[0], ast.Name):
                container_name = node.comparators[0].id
                call = ast.Call(
                    func=ast.Name(id='_tracecode_contains_key', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=container_name),
                        ast.Name(id=container_name, ctx=ast.Load()),
                        self.visit(node.left),
                        _tracecode_index_source_node(node.left),
                    ],
                    keywords=[],
                )
                value = ast.UnaryOp(op=ast.Not(), operand=call) if isinstance(node.ops[0], ast.NotIn) else call
                return ast.copy_location(value, node)
            extracted = _tracecode_extract_mutable_container_target(node.comparators[0])
            if extracted is not None and len(extracted[2]) > 0:
                var_name, container, indices = extracted
                call = ast.Call(
                    func=ast.Name(id='_tracecode_contains_key_indexed', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        container,
                        ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                        ast.List(elts=[_tracecode_index_source_node(index) for index in indices], ctx=ast.Load()),
                        self.visit(node.left),
                        _tracecode_index_source_node(node.left),
                    ],
                    keywords=[],
                )
                value = ast.UnaryOp(op=ast.Not(), operand=call) if isinstance(node.ops[0], ast.NotIn) else call
                return ast.copy_location(value, node)
        return self.generic_visit(node)

    def visit_Raise(self, node):
        if node.exc is None:
            return self.generic_visit(node)
        line_number = getattr(node, 'lineno', 1)
        call = ast.Call(
            func=ast.Name(id='_tracecode_exception_value', ctx=ast.Load()),
            args=[
                ast.Constant(value=line_number),
                self.visit(node.exc),
            ],
            keywords=[],
        )
        return ast.copy_location(ast.Raise(exc=call, cause=self.visit(node.cause) if node.cause else None), node)

    def visit_Attribute(self, node):
        parent = getattr(node, '__trace_parent__', None)
        if isinstance(parent, ast.Assign) and node in getattr(parent, 'targets', []):
            return self.generic_visit(node)
        if isinstance(parent, ast.Call) and getattr(parent, 'func', None) is node:
            return self.generic_visit(node)

        extracted = _tracecode_extract_named_subscript(node)
        if extracted is None or not isinstance(node.ctx, ast.Load):
            return self.generic_visit(node)

        var_name, indices = extracted
        call = ast.Call(
            func=ast.Name(id='_tracecode_read_index', ctx=ast.Load()),
            args=[
                ast.Constant(value=var_name),
                ast.Name(id=var_name, ctx=ast.Load()),
                ast.List(elts=[self.visit(index) for index in indices], ctx=ast.Load()),
                ast.List(elts=[_tracecode_index_source_node(index) for index in indices], ctx=ast.Load()),
            ],
            keywords=[],
        )
        return ast.copy_location(call, node)

def __tracecode_compile_user_code(source):
    tree = ast.parse(source, filename='solution.py', mode='exec')
    __tracecode_attach_parents(tree)
    tree = __TracecodeAccessTransformer(_tracecode_collect_user_function_names(tree)).visit(tree)
    ast.fix_missing_locations(tree)
    return compile(tree, 'solution.py', 'exec')

def _tracecode_is_pure_literal_scaffold(node):
    if isinstance(node, (ast.Constant, ast.Name)):
        return True
    if isinstance(node, ast.UnaryOp):
        return _tracecode_is_pure_literal_scaffold(node.operand)
    if isinstance(node, ast.BinOp):
        return _tracecode_is_pure_literal_scaffold(node.left) and _tracecode_is_pure_literal_scaffold(node.right)
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(_tracecode_is_pure_literal_scaffold(elt) for elt in node.elts)
    if isinstance(node, ast.Dict):
        return all(
            (key is None or _tracecode_is_pure_literal_scaffold(key)) and _tracecode_is_pure_literal_scaffold(value)
            for key, value in zip(node.keys, node.values)
        )
    return False

def _tracecode_collect_collapsed_literal_lines(source):
    try:
        tree = ast.parse(source, filename='solution.py', mode='exec')
    except Exception:
        return set()

    collapsed_lines = set()
    for node in ast.walk(tree):
        statement_line = getattr(node, 'lineno', None)
        value = None
        if isinstance(node, ast.Assign):
            value = node.value
        elif isinstance(node, ast.AnnAssign):
            value = node.value
        elif isinstance(node, ast.Return):
            value = node.value
        if value is None or statement_line is None:
            continue
        end_line = getattr(value, 'end_lineno', None)
        if end_line is None or end_line <= statement_line:
            continue
        if not _tracecode_is_pure_literal_scaffold(value):
            continue
        for line in range(statement_line + 1, end_line + 1):
            collapsed_lines.add(line)
    return collapsed_lines

def _stable_token(value):
    try:
        return json.dumps(value, sort_keys=True)
    except Exception:
        return repr(value)

def _looks_like_adjacency_list(value):
    if not isinstance(value, _builtins.dict) or len(value) == 0:
        return False
    if not all(isinstance(v, _builtins.list) for v in value.values()):
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
    if not isinstance(value, _builtins.list) or len(value) == 0:
        return False
    if not all(isinstance(row, _builtins.list) for row in value):
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
        if frame.f_code.co_filename == 'solution.py' and frame.f_lineno in _tracecode_collapsed_literal_lines:
            return _tracer
        previous_step = TraceHooks._resolve_previous_step(frame)
        if (
            isinstance(previous_step, _builtins.dict)
            and previous_step.get('event') == 'line'
            and previous_step.get('line') == frame.f_lineno
            and not previous_step.get('__runtime_flushed')
            and not _pending_accesses.get(_tracecode_builtin_id(frame))
        ):
            return _tracer
        TraceHooks.flush_completed_line(frame)
        _total_line_events += 1
        
        # Check total line events
        if _total_line_events >= _max_line_events:
            if not _trace_limit_exceeded:
                _trace_limit_exceeded = True
                _timeout_reason = 'line-limit'
                _infinite_loop_line = frame.f_lineno
                __tracecode_append_trace_step(frame, {
                    'line': frame.f_lineno,
                    'event': 'timeout',
                    'variables': {'timeoutReason': _timeout_reason},
                    'function': func_name,
                    'callStack': _snapshot_call_stack(),
                    'stdoutLineCount': len(_console_output),
                    'accesses': [],
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
                __tracecode_append_trace_step(frame, {
                    'line': frame.f_lineno,
                    'event': 'timeout',
                    'variables': local_vars,
                    'variableSources': local_sources,
                    'function': func_name,
                    'callStack': _snapshot_call_stack(),
                    'stdoutLineCount': len(_console_output),
                    'accesses': []
                })
                sys.settrace(None)
                raise _InfiniteLoopDetected(f"Line {frame.f_lineno} executed {_max_single_line_hits} times")
    
    # Hard limit on recorded trace steps
    if (not _MINIMAL_TRACE) and len(_trace_data) >= _max_trace_steps:
        if not _trace_limit_exceeded:
            _trace_limit_exceeded = True
            _timeout_reason = 'trace-limit'
            _infinite_loop_line = frame.f_lineno
            __tracecode_attach_accesses_to_previous_step(frame)
            __tracecode_append_trace_step(frame, {
                'line': frame.f_lineno,
                'event': 'timeout',
                'variables': {'timeoutReason': _timeout_reason},
                'function': func_name,
                'callStack': _snapshot_call_stack(),
                'stdoutLineCount': len(_console_output),
                'accesses': [],
            })
            _pending_accesses.clear()
            sys.settrace(None)
        return None

    if _trace_limit_exceeded and _timeout_reason == 'trace-limit':
        _pending_accesses.clear()
        sys.settrace(None)
        return None

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
        __tracecode_append_trace_step(frame, {
            'line': frame.f_lineno,
            'event': 'call',
            'variables': local_vars,
            'variableSources': local_sources,
            'function': func_name,
            'callStack': _snapshot_call_stack(),
            'stdoutLineCount': len(_console_output),
            'accesses': __tracecode_flush_accesses(frame)
        })
    elif event == 'line':
        if _MINIMAL_TRACE:
            return _tracer
        local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
        __tracecode_append_trace_step(frame, {
            'line': frame.f_lineno,
            'event': event,
            'variables': local_vars,
            'variableSources': local_sources,
            'function': func_name,
            'callStack': _snapshot_call_stack(),
            'stdoutLineCount': len(_console_output),
            'accesses': []
        })
    elif event == 'return':
        TraceHooks.flush_completed_line(frame)
        if not _MINIMAL_TRACE:
            local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
            __tracecode_append_trace_step(frame, {
                'line': frame.f_lineno,
                'event': 'return',
                'variables': local_vars,
                'variableSources': local_sources,
                'function': func_name,
                'returnValue': _serialize(arg),
                'callStack': _snapshot_call_stack(),
                'stdoutLineCount': len(_console_output),
                'accesses': []
            })
        _pending_accesses.pop(_tracecode_builtin_id(frame), None)
        _last_trace_index_by_frame.pop(_tracecode_builtin_id(frame), None)
        if _call_stack and _call_stack[-1]['function'] == func_name:
            _call_stack.pop()

    return _tracer

# Clear user-defined globals from previous runs
# Use __builtins__ to access real globals() and list() in case they were shadowed
_real_globals = __builtins__['globals'] if isinstance(__builtins__, _builtins.dict) else getattr(__builtins__, 'globals')
_real_list = __builtins__['list'] if isinstance(__builtins__, _builtins.dict) else getattr(__builtins__, 'list')
_globals_dict = _real_globals()
_preserve = {"TreeNode", "ListNode", "TraceHooks", 'sys', 'json', 'math', 'ast', 'print', '__builtins__', '__name__', '__doc__', '__package__', '__loader__', '__spec__'} | _TRACECODE_TYPING_GLOBALS
for _k in _real_list(_globals_dict.keys()):
    if not _k.startswith('_') and _k not in _preserve:
        _globals_dict.pop(_k, None)
del _preserve, _real_globals, _real_list

# Ensure print remains routed through the tracer harness after global cleanup
print = _custom_print

${PYTHON_DEFAULT_IMPORT_PRELUDE}
pow = _builtins.pow
`;

  const userCodeStartLine = 1;

  // Separate tree inputs (have left/right) from list inputs (have next)
  const treeInputKeys = [];
  const listInputKeys = [];
  
  Object.entries(inputs).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && ('val' in value || 'value' in value)) {
      const explicitType = typeof value.__type__ === 'string' ? value.__type__ : null;
      const hasLeft = 'left' in value;
      const hasRight = 'right' in value;
      const hasNext = 'next' in value;
      
      if (explicitType === 'TreeNode' || hasLeft || hasRight) {
        treeInputKeys.push(key);
      } else if (explicitType === 'ListNode' || hasNext) {
        listInputKeys.push(key);
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
  const inplaceCandidates = ['nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid']
    .filter((key) => Object.prototype.hasOwnProperty.call(inputs, key));
  const inplaceCandidatesLiteral = JSON.stringify(inplaceCandidates);
  const traceInputNamesLiteral = JSON.stringify(Object.keys(inputs));
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
          `        if not isinstance(_call_args, (_builtins.list, _builtins.tuple)):`,
          `            _call_args = [_call_args]`,
          `        _call_args = _tracecode_materialize_input(_call_args)`,
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
        : [
          `    if '${functionName}' in globals() and callable(globals()['${functionName}']):`,
          `        _result = globals()['${functionName}'](${argList})`,
          `    elif 'Solution' in globals() and hasattr(Solution, '${functionName}'):`,
          `        _solver = Solution()`,
          `        _result = getattr(_solver, '${functionName}')(${argList})`,
          `    else:`,
          `        raise NameError(\"Implement ${functionName}(...) or Solution.${functionName}(...)\")`,
        ].join('\n')
    : [
      `    exec(__tracecode_compiled, _globals_dict)`,
      `    _result = _globals_dict.get('result', None)`,
    ].join('\n');

  const userCodeTraceSetup = [
    `\n_user_code_str = """${escapedCode}"""`,
    `import textwrap as _textwrap`,
    `_user_code_str = _textwrap.dedent(_user_code_str.lstrip("\\n"))`,
    `_tracecode_collapsed_literal_lines = _tracecode_collect_collapsed_literal_lines(_user_code_str)`,
    `__tracecode_compiled = __tracecode_compile_user_code(_user_code_str)`,
    ].join('\n');

  const preloadUserDefinitions = functionName ? `exec(__tracecode_compiled, _globals_dict)\n` : '';

  const harnessSuffix = `
${userCodeTraceSetup}
${deps.PYTHON_CONVERSION_HELPERS_SNIPPET}


def _tracecode_materialize_custom_input(obj):
    if isinstance(obj, _builtins.list):
        return [_tracecode_materialize_custom_input(item) for item in obj]
    if isinstance(obj, _builtins.tuple):
        return tuple(_tracecode_materialize_custom_input(item) for item in obj)
    if isinstance(obj, _builtins.dict):
        if obj.get('__type__') == 'TreeNode' or 'left' in obj or 'right' in obj:
            return _dict_to_tree(obj)
        if obj.get('__type__') == 'ListNode' or 'next' in obj:
            return _dict_to_list(obj)
        _type_name = obj.get('__type__') if isinstance(obj.get('__type__'), _builtins.str) else obj.get('__class__')
        _fields = {key: _tracecode_materialize_custom_input(value) for key, value in obj.items() if key not in ('__type__', '__class__', '__id__')}
        if isinstance(_type_name, _builtins.str):
            _fields = {'__type__': _type_name, **_fields}
        _constructor_fields = {key: value for key, value in _fields.items() if key not in ('__type__', '__class__')}
        _cls = globals().get(_type_name) if isinstance(_type_name, _builtins.str) else None
        if isinstance(_cls, _builtins.type):
            try:
                return _cls(**_constructor_fields)
            except Exception:
                pass
            try:
                return _cls(*_builtins.list(_constructor_fields.values()))
            except Exception:
                pass
            try:
                _instance = _cls.__new__(_cls)
                for _key, _value in _constructor_fields.items():
                    setattr(_instance, _key, _value)
                return _instance
            except Exception:
                pass
        return _fields
    return obj

def _tracecode_materialize_named_inputs(_names):
    for _name in _names:
        if _name in globals():
            globals()[_name] = _tracecode_materialize_custom_input(globals()[_name])

def _tracecode_materialize_input(obj):
    return _tracecode_materialize_custom_input(obj)

def _resolve_inplace_result():
    for _name in ${inplaceCandidatesLiteral}:
        if _name in globals():
            return globals().get(_name)
    return None

${inputSetup}

${treeConversions}

${listConversions}

${preloadUserDefinitions}
_tracecode_materialize_named_inputs(${traceInputNamesLiteral})

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
    __tracecode_append_trace_step(None, {
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
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events,
        'lineEventCount': len([event for event in _trace_events if event.get('kind') == 'line']),
        'traceStepCount': len(_trace_events)
    },
    'result': _serialize_output(_result),
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
    ...rawError.matchAll(/File "(?:<exec>|<string>|<user_code>|solution\.py)", line (\d+)/g),
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

const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';

function remapPythonRuntimeTrace(runtimeTrace, userCodeStartLine, userCodeLineCount, runId = 'python:run', file) {
  const normalizedEvents = [];
  const events = runtimeTrace && Array.isArray(runtimeTrace.events) ? runtimeTrace.events : [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const normalized = {
      ...event,
      runId,
      ...(file ? { file } : {}),
    };
    if (typeof normalized.line === 'number') {
      normalized.line = normalized.line > 0 ? normalized.line - userCodeStartLine + 1 : normalized.line;
      if (normalized.line < 1 || normalized.line > userCodeLineCount) {
        continue;
      }
    }
    normalizedEvents.push(normalized);
  }
  return {
    schemaVersion: runtimeTrace?.schemaVersion ?? RUNTIME_TRACE_SCHEMA_VERSION,
    language: 'python',
    runId,
    events: normalizedEvents,
    lineEventCount: normalizedEvents.filter((event) => event.kind === 'line').length,
    traceStepCount: normalizedEvents.length,
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

    const traceOnlyBudgetExceeded = timeoutReason === 'trace-limit';

    // Handle tracing guard stops and execution timeouts
    if (result.traceLimitExceeded || timeoutStep) {
      const lastStep = adjustedTrace[adjustedTrace.length - 1];
      errorLine = lastStep?.line;
      const lineSuffix = errorLine && errorLine > 0 ? ` on line ${errorLine}` : '';

      if (timeoutReason === 'client-timeout') {
        errorMessage = `Execution timed out${lineSuffix}. This may indicate an infinite loop or very expensive execution.`;
      } else if (isTraceBudgetExceeded) {
        errorMessage = `Trace budget exceeded${lineSuffix}. Trace playback hit its safety limits before execution finished.`;
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
      success:
        !errorStep &&
        (!result.traceLimitExceeded || traceOnlyBudgetExceeded) &&
        (!timeoutStep || traceOnlyBudgetExceeded),
      output: result.result,
      error: errorMessage,
      errorLine,
      trace: remapPythonRuntimeTrace(
        result.runtimeTrace,
        userCodeStartLine,
        userCodeLineCount,
        'python:run',
        'solution.py'
      ),
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
      trace: remapPythonRuntimeTrace({ events: [] }, userCodeStartLine, userCodeLineCount, 'python:run', 'solution.py'),
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
        const explicitType = typeof value.__type__ === 'string' ? value.__type__ : null;
        const hasLeft = 'left' in value;
        const hasRight = 'right' in value;
        const hasNext = 'next' in value;
        
        if (explicitType === 'TreeNode' || hasLeft || hasRight) {
          treeInputKeys.push(key);
        } else if (explicitType === 'ListNode' || hasNext) {
          listInputKeys.push(key);
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
    const inplaceCandidates = ['nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid']
      .filter((key) => Object.prototype.hasOwnProperty.call(inputs, key));
    const inplaceCandidatesLiteral = JSON.stringify(inplaceCandidates);
    const traceInputNamesLiteral = JSON.stringify(Object.keys(inputs));
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
    if not isinstance(_call_args, (_builtins.list, _builtins.tuple)):
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
        : `if '${functionName}' in globals() and callable(globals()['${functionName}']):
    _result = globals()['${functionName}'](${inputArgs})
elif 'Solution' in globals() and hasattr(Solution, '${functionName}'):
    _solver = Solution()
    _result = getattr(_solver, '${functionName}')(${inputArgs})
else:
    raise NameError("Implement ${functionName}(...) or Solution.${functionName}(...)")`;
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
${PYTHON_DEFAULT_IMPORT_PRELUDE}
pow = _builtins.pow

_console_output = []
_original_print = _builtins.print
_tracecode_builtin_id = _builtins.id
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

def _tracecode_materialize_custom_input(obj):
    if isinstance(obj, _builtins.list):
        return [_tracecode_materialize_custom_input(item) for item in obj]
    if isinstance(obj, _builtins.tuple):
        return tuple(_tracecode_materialize_custom_input(item) for item in obj)
    if isinstance(obj, _builtins.dict):
        if obj.get('__type__') == 'TreeNode' or 'left' in obj or 'right' in obj:
            return _dict_to_tree(obj)
        if obj.get('__type__') == 'ListNode' or 'next' in obj:
            return _dict_to_list(obj)
        _type_name = obj.get('__type__') if isinstance(obj.get('__type__'), _builtins.str) else obj.get('__class__')
        _fields = {key: _tracecode_materialize_custom_input(value) for key, value in obj.items() if key not in ('__type__', '__class__', '__id__')}
        if isinstance(_type_name, _builtins.str):
            _fields = {'__type__': _type_name, **_fields}
        _constructor_fields = {key: value for key, value in _fields.items() if key not in ('__type__', '__class__')}
        _cls = globals().get(_type_name) if isinstance(_type_name, _builtins.str) else None
        if isinstance(_cls, _builtins.type):
            try:
                return _cls(**_constructor_fields)
            except Exception:
                pass
            try:
                return _cls(*_builtins.list(_constructor_fields.values()))
            except Exception:
                pass
            try:
                _instance = _cls.__new__(_cls)
                for _key, _value in _constructor_fields.items():
                    setattr(_instance, _key, _value)
                return _instance
            except Exception:
                pass
        return _fields
    return obj

def _tracecode_materialize_named_inputs(_names):
    for _name in _names:
        if _name in globals():
            globals()[_name] = _tracecode_materialize_custom_input(globals()[_name])

def _resolve_inplace_result():
    for _name in ${inplaceCandidatesLiteral}:
        if _name in globals():
            return globals().get(_name)
    return None

${inputSetup}

${treeConversions}

${listConversions}

_tracecode_materialize_named_inputs(${traceInputNamesLiteral})

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

def _tracecode_materialize_custom_input(obj):
    if isinstance(obj, _builtins.list):
        return [_tracecode_materialize_custom_input(item) for item in obj]
    if isinstance(obj, _builtins.tuple):
        return tuple(_tracecode_materialize_custom_input(item) for item in obj)
    if isinstance(obj, _builtins.dict):
        if obj.get('__type__') == 'TreeNode' or 'left' in obj or 'right' in obj:
            return _dict_to_tree(obj)
        if obj.get('__type__') == 'ListNode' or 'next' in obj:
            return _dict_to_list(obj)
        _type_name = obj.get('__type__') if isinstance(obj.get('__type__'), _builtins.str) else obj.get('__class__')
        _fields = {key: _tracecode_materialize_custom_input(value) for key, value in obj.items() if key not in ('__type__', '__class__', '__id__')}
        if isinstance(_type_name, _builtins.str):
            _fields = {'__type__': _type_name, **_fields}
        _constructor_fields = {key: value for key, value in _fields.items() if key not in ('__type__', '__class__')}
        _cls = globals().get(_type_name) if isinstance(_type_name, _builtins.str) else None
        if isinstance(_cls, _builtins.type):
            try:
                return _cls(**_constructor_fields)
            except Exception:
                pass
            try:
                return _cls(*_builtins.list(_constructor_fields.values()))
            except Exception:
                pass
            try:
                _instance = _cls.__new__(_cls)
                for _key, _value in _constructor_fields.items():
                    setattr(_instance, _key, _value)
                return _instance
            except Exception:
                pass
        return _fields
    return obj

def _tracecode_materialize_named_inputs(_names):
    for _name in _names:
        if _name in globals():
            globals()[_name] = _tracecode_materialize_custom_input(globals()[_name])

def _resolve_inplace_result():
    for _name in ${inplaceCandidatesLiteral}:
        if _name in globals():
            return globals().get(_name)
    return None

${inputSetup}

${treeConversions}

${listConversions}

_tracecode_materialize_named_inputs(${traceInputNamesLiteral})

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
