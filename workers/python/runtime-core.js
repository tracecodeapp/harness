/**
 * Python runtime core helpers loaded by python-worker.js.
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

// This list is the single source of truth for both preparation-time admission
// and the algorithm-batch runtime. A real builtin that is not listed here must
// route to the compatibility tier instead of becoming a fast-tier NameError.
const PYTHON_ALGORITHM_SAFE_BUILTIN_NAMES = [
  '__build_class__', 'abs', 'all', 'any', 'ascii', 'bin', 'bool',
  'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'complex', 'dict',
  'divmod', 'enumerate', 'filter', 'float', 'format', 'frozenset', 'hash',
  'hex', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map',
  'max', 'memoryview', 'min', 'next', 'object', 'oct', 'ord', 'pow', 'id',
  'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'slice',
  'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'zip',
  'NotImplemented', 'Ellipsis',
  'Exception', 'BaseExceptionGroup', 'ExceptionGroup',
  'ArithmeticError', 'AssertionError', 'AttributeError', 'BufferError',
  'EOFError', 'EnvironmentError', 'FileExistsError', 'FileNotFoundError',
  'FloatingPointError', 'GeneratorExit', 'ImportError', 'ImportWarning',
  'IndentationError', 'IndexError', 'InterruptedError', 'IOError', 'KeyError',
  'KeyboardInterrupt', 'LookupError', 'MemoryError', 'ModuleNotFoundError',
  'NameError', 'NotImplementedError', 'OSError', 'OverflowError',
  'PermissionError', 'ProcessLookupError', 'RecursionError', 'ReferenceError',
  'RuntimeError', 'RuntimeWarning', 'StopAsyncIteration', 'StopIteration',
  'SyntaxError', 'SyntaxWarning', 'SystemError', 'SystemExit', 'TabError',
  'TimeoutError', 'TypeError', 'UnboundLocalError', 'UnicodeError',
  'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeTranslateError',
  'UnicodeWarning', 'UserWarning', 'ValueError', 'Warning',
  'ZeroDivisionError', 'BytesWarning', 'DeprecationWarning',
  'EncodingWarning', 'FutureWarning', 'PendingDeprecationWarning',
  'ResourceWarning',
];

const PYTHON_ALGORITHM_REFLECTIVE_FUNCTOOLS_NAMES = [
  'singledispatch',
  'singledispatchmethod',
  'update_wrapper',
  'wraps',
];

const PYTHON_ALGORITHM_REFLECTIVE_ATTRIBUTE_NAMES = [
  'attrgetter', 'methodcaller', 'itemgetter', 'setitem', 'delitem',
  'format', 'format_map', 'get_field', 'get_value', 'vformat', 'Formatter',
  'mro',
  'ForwardRef', 'get_type_hints', 'evaluate_forward_ref',
  'f_back', 'f_builtins', 'f_code', 'f_globals', 'f_lasti', 'f_lineno',
  'f_locals', 'f_trace', 'f_trace_lines', 'f_trace_opcodes',
];

const PYTHON_ALGORITHM_REFLECTIVE_ATTRIBUTE_PREFIXES = [
  'gi_', 'cr_', 'ag_', 'tb_', 'co_',
];

// Shared stdlib objects may expose registration APIs whose state outlives a
// learner namespace. Calls rooted in an imported/default-import binding must
// not reach these APIs on the retained interpreter.
const PYTHON_ALGORITHM_SHARED_STATE_CALL_NAMES = [
  'clear_overloads', 'get_overloads', 'overload', 'register',
];

const PYTHON_LITERAL_SHAPE_ANNOTATION_HELPER = `
def _tracecode_annotation_preserves_literal_shape(_annotation):
    try:
        import typing as _tracecode_shape_typing
        import collections.abc as _tracecode_shape_collections_abc
    except Exception:
        return False
    if _annotation in (
        _builtins.object,
        _builtins.bool,
        _builtins.int,
        _builtins.float,
        _builtins.str,
        _builtins.bytes,
        _builtins.list,
        _builtins.dict,
        getattr(_tracecode_shape_typing, 'Any', None),
    ):
        return True
    _origin = _tracecode_shape_typing.get_origin(_annotation)
    _args = _tracecode_shape_typing.get_args(_annotation)
    if _origin is _builtins.list:
        return not _args or _tracecode_annotation_preserves_literal_shape(_args[0])
    if _origin in (
        _builtins.dict,
        _tracecode_shape_collections_abc.Mapping,
        _tracecode_shape_collections_abc.MutableMapping,
    ):
        return not _args or all(
            _tracecode_annotation_preserves_literal_shape(_arg)
            for _arg in _args[:2]
        )
    if _origin is _tracecode_shape_typing.Union:
        _non_none = [_arg for _arg in _args if _arg is not type(None)]
        return len(_non_none) == 1 and _tracecode_annotation_preserves_literal_shape(_non_none[0])
    return False
`;

const DEFAULT_TRACE_MAX_PATH_DEPTH = 3;
const MAX_TRACE_MAX_PATH_DEPTH = 8;
const DEFAULT_TRACE_MAX_BYTES = 4 * 1024 * 1024;
// Ceiling for explicitly requested budgets (equal-output benchmarking needs
// room to emit complete traces); the default above still guards the product.
const MAX_TRACE_MAX_BYTES = 64 * 1024 * 1024;
const isolatedPythonExecutionGuards = new WeakMap();
const isolatedPythonFilesystemManagers = new WeakMap();

function normalizePythonFilesystemPath(fs, path) {
  const raw = String(path ?? '');
  const absolute = raw.startsWith('/') ? raw : `${fs.cwd()}/${raw}`;
  const parts = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function createIsolatedPythonFilesystemManager(pyodide) {
  const fs = pyodide?.FS;
  if (!fs || typeof fs !== 'object') {
    throw new Error('Python filesystem isolation requires the Pyodide filesystem.');
  }

  let activeJournal = null;
  let restoring = false;
  const isMissingPath = (error) =>
    error &&
    typeof error === 'object' &&
    (error.errno === 44 || error.code === 'ENOENT');

  const pathForNode = (value) => {
    if (typeof value === 'string') {
      return normalizePythonFilesystemPath(fs, value);
    }
    if (value && typeof value === 'object' && typeof fs.getPath === 'function') {
      return normalizePythonFilesystemPath(fs, fs.getPath(value));
    }
    return null;
  };

  const snapshotPath = (path) => {
    try {
      const stat = fs.lstat(path);
      const metadata = {
        mode: stat.mode,
        timestamp:
          stat.mtime instanceof Date
            ? stat.mtime.getTime()
            : Number(stat.mtimeMs ?? stat.timestamp ?? Date.now()),
      };
      if (fs.isLink(stat.mode)) {
        return {
          kind: 'link',
          ...metadata,
          target: fs.readlink(path),
        };
      }
      if (fs.isDir(stat.mode)) {
        return {
          kind: 'directory',
          ...metadata,
          entries: fs.readdir(path)
            .filter((name) => name !== '.' && name !== '..')
            .map((name) => [
              name,
              snapshotPath(path === '/' ? `/${name}` : `${path}/${name}`),
            ]),
        };
      }
      return {
        kind: 'file',
        ...metadata,
        bytes: new Uint8Array(fs.readFile(path)),
      };
    } catch (error) {
      if (isMissingPath(error)) {
        return { kind: 'absent' };
      }
      throw error;
    }
  };

  const capture = (value) => {
    if (!activeJournal || restoring) return;
    const path = pathForNode(value);
    if (!path || activeJournal.has(path)) return;
    activeJournal.set(path, snapshotPath(path));
  };

  const removePath = (path) => {
    let stat;
    try {
      stat = fs.lstat(path);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
    if (fs.isDir(stat.mode) && !fs.isLink(stat.mode)) {
      for (const name of fs.readdir(path)) {
        if (name === '.' || name === '..') continue;
        removePath(path === '/' ? `/${name}` : `${path}/${name}`);
      }
      if (path !== '/') fs.rmdir(path);
      return;
    }
    fs.unlink(path);
  };

  const restorePath = (path, snapshot) => {
    removePath(path);
    if (snapshot.kind === 'absent') return;
    if (snapshot.kind === 'link') {
      fs.symlink(snapshot.target, path);
      return;
    }
    if (snapshot.kind === 'directory') {
      if (path !== '/') fs.mkdir(path, snapshot.mode);
      for (const [name, child] of snapshot.entries) {
        restorePath(path === '/' ? `/${name}` : `${path}/${name}`, child);
      }
      if (path !== '/' && typeof fs.chmod === 'function') {
        fs.chmod(path, snapshot.mode);
      }
      if (path !== '/' && typeof fs.utime === 'function') {
        fs.utime(path, snapshot.timestamp, snapshot.timestamp);
      }
      return;
    }
    fs.writeFile(path, snapshot.bytes, { canOwn: false });
    if (typeof fs.chmod === 'function') fs.chmod(path, snapshot.mode);
    if (typeof fs.utime === 'function') {
      fs.utime(path, snapshot.timestamp, snapshot.timestamp);
    }
  };

  const wrap = (name, before) => {
    const method = fs[name];
    if (typeof method !== 'function') return;
    fs[name] = function isolatedPythonFilesystemOperation(...args) {
      if (activeJournal && !restoring) before(...args);
      return method.apply(this, args);
    };
  };

  const mutatingOpen = (flags) => {
    if (typeof flags === 'string') {
      return flags.includes('w') || flags.includes('a') || flags.includes('+');
    }
    if (typeof flags !== 'number') return false;
    // POSIX O_ACCMODE, O_CREAT, and O_TRUNC values used by Emscripten.
    return (flags & 3) !== 0 || (flags & 64) !== 0 || (flags & 512) !== 0;
  };

  wrap('open', (path, flags) => {
    if (mutatingOpen(flags)) capture(path);
  });
  wrap('write', (stream) => capture(stream?.path ?? stream?.node));
  wrap('allocate', (stream) => capture(stream?.path ?? stream?.node));
  wrap('msync', (stream) => capture(stream?.path ?? stream?.node));
  wrap('truncate', (pathOrNode) => capture(pathOrNode));
  wrap('mknod', (path) => capture(path));
  wrap('mkdir', (path) => capture(path));
  wrap('symlink', (_target, path) => capture(path));
  wrap('rename', (oldPath, newPath) => {
    capture(oldPath);
    capture(newPath);
  });
  wrap('unlink', (path) => capture(path));
  wrap('rmdir', (path) => capture(path));
  wrap('chmod', (pathOrNode) => capture(pathOrNode));
  wrap('chown', (pathOrNode) => capture(pathOrNode));
  wrap('utime', (path) => capture(path));

  return {
    begin() {
      if (activeJournal) {
        throw new Error('Nested TraceCode Python filesystem execution scope.');
      }
      activeJournal = new Map();
    },
    restore() {
      if (!activeJournal) {
        throw new Error('TraceCode Python filesystem execution scope was not active.');
      }
      const journal = activeJournal;
      activeJournal = null;
      restoring = true;
      try {
        for (const [path, snapshot] of [...journal.entries()].reverse()) {
          restorePath(path, snapshot);
        }
      } finally {
        restoring = false;
      }
    },
  };
}

function isolatedPythonFilesystemManager(pyodide) {
  let manager = isolatedPythonFilesystemManagers.get(pyodide);
  if (!manager) {
    manager = createIsolatedPythonFilesystemManager(pyodide);
    isolatedPythonFilesystemManagers.set(pyodide, manager);
  }
  return manager;
}

function createIsolatedPythonExecutionGuard(pyodide) {
  const guard = pyodide.runPython(`
import builtins as __tracecode_guard_builtins
import base64 as __tracecode_guard_base64
import copy as _tracecode_guard_copy
import ast as _tracecode_guard_ast
import importlib.util as __tracecode_guard_importlib_util
import marshal as __tracecode_guard_marshal
import os as _tracecode_guard_os
import random as __tracecode_guard_random
import sys as __tracecode_guard_sys

class __TracecodeExecutionGuard:
    def __init__(
        self,
        ast_module,
        base64_module,
        builtins_module,
        importlib_util_module,
        marshal_module,
        os_module,
        random_module,
        sys_module,
        default_import_prelude,
        algorithm_safe_builtin_names,
        algorithm_reflective_functools_names,
        algorithm_reflective_attribute_names,
        algorithm_reflective_attribute_prefixes,
        algorithm_shared_state_call_names,
    ):
        self._ast = ast_module
        self._base64 = base64_module
        self._builtins_dict = builtins_module.__dict__
        self._importlib_util = importlib_util_module
        self._marshal = marshal_module
        self._modules = sys_module.modules
        self._sys = sys_module
        self._gettrace = sys_module.gettrace
        self._settrace = sys_module.settrace
        self._getrecursionlimit = sys_module.getrecursionlimit
        self._setrecursionlimit = sys_module.setrecursionlimit
        self._getcwd = os_module.getcwd
        self._chdir = os_module.chdir
        self._environ = os_module.environ
        self._random_getstate = random_module.getstate
        self._random_setstate = random_module.setstate
        self._algorithm_safe_builtin_names = set(algorithm_safe_builtin_names)
        self._algorithm_builtin_names = set(self._builtins_dict.keys())
        self._algorithm_reflective_functools_names = set(
            algorithm_reflective_functools_names
        )
        self._algorithm_reflective_attribute_names = set(
            algorithm_reflective_attribute_names
        ) | self._algorithm_reflective_functools_names
        self._algorithm_reflective_attribute_prefixes = tuple(
            algorithm_reflective_attribute_prefixes
        )
        self._algorithm_shared_state_call_names = set(
            algorithm_shared_state_call_names
        )
        algorithm_defaults = {'__builtins__': dict(self._builtins_dict)}
        exec(
            'import json\\nimport math\\nimport sys\\n' + str(default_import_prelude),
            algorithm_defaults,
        )
        self._algorithm_default_shared_names = {
            name for name in algorithm_defaults.keys()
            if not name.startswith('__')
        }
        self._algorithm_default_module_names = {
            name for name, value in algorithm_defaults.items()
            if isinstance(value, type(sys_module))
        }
        self._guard_globals = globals()
        self._deepcopy = _tracecode_guard_copy.deepcopy
        self._builtins_snapshot = None
        self._modules_snapshot = None
        self._module_dict_snapshots = None
        self._module_mutable_snapshots = None
        self._algorithm_environ_snapshot = None
        self._algorithm_path_snapshot = None
        self._algorithm_importer_cache_snapshot = None
        self._trace_snapshot = None
        self._recursion_limit_snapshot = None
        self._cwd_snapshot = None
        self._random_state_snapshot = None
        self._compiled = {}
        self._compiled_limit = 4

    def classify_algorithm_source(self, source, function_name, execution_style):
        reasons = []
        try:
            tree = self._ast.parse(str(source), filename='solution.py')
        except SyntaxError as error:
            return {
                'tier': 'hard-isolated',
                'reasons': ['syntax-error:' + str(error)],
            }

        denied_modules = {
            'asyncio', 'builtins', 'ctypes', 'importlib', 'inspect', 'io', 'js',
            'multiprocessing', 'os', 'pathlib', 'pickle', 'pyodide', 'resource',
            'signal', 'socket', 'subprocess', 'sys', 'tempfile', 'threading',
            'time', 'traceback', 'types', 'webbrowser',
        }
        allowed_modules = {
            'array', 'bisect', 'collections', 'functools', 'heapq',
            'itertools', 'math', 'operator', 'random', 're', 'statistics',
            'string', 'sortedcontainers', 'typing',
        }
        denied_names = {
            '__builtins__', '__import__', 'breakpoint', 'compile', 'delattr',
            'dir', 'eval', 'exec', 'exit', 'getattr', 'globals', 'hasattr',
            'help', 'input', 'locals', 'open', 'quit', 'setattr', 'type',
            'vars', '_builtins', 'attrgetter', 'methodcaller', 'itemgetter',
            'setitem', 'delitem', 'ForwardRef', 'get_type_hints',
            'evaluate_forward_ref',
        } | self._algorithm_reflective_functools_names
        imported_modules = set(self._algorithm_default_module_names)
        imported_values = set(self._algorithm_default_shared_names)

        for node in tree.body:
            local_names = []
            if isinstance(node, (self._ast.FunctionDef, self._ast.AsyncFunctionDef, self._ast.ClassDef)):
                local_names = [node.name]
            elif isinstance(node, (self._ast.Assign, self._ast.AnnAssign, self._ast.NamedExpr)):
                targets = node.targets if isinstance(node, self._ast.Assign) else [node.target]
                local_names = [
                    target.id for target in targets
                    if isinstance(target, self._ast.Name)
                ]
            for name in local_names:
                if name in imported_modules or name in imported_values:
                    reasons.append('rebound-default-binding:' + name)

        target = None
        if execution_style == 'solution-method':
            solution_classes = [
                node for node in tree.body
                if isinstance(node, self._ast.ClassDef) and node.name == 'Solution'
            ]
            if solution_classes:
                methods = [
                    node for node in solution_classes[-1].body
                    if isinstance(node, (self._ast.FunctionDef, self._ast.AsyncFunctionDef))
                    and node.name == function_name
                ]
                if methods:
                    target = methods[-1]
        elif execution_style == 'function':
            functions = [
                node for node in tree.body
                if isinstance(node, (self._ast.FunctionDef, self._ast.AsyncFunctionDef))
                and node.name == function_name
            ]
            if functions:
                target = functions[-1]
        else:
            reasons.append('unsupported-execution-style:' + str(execution_style))

        if target is None:
            reasons.append('missing-fast-target:' + str(function_name))
        else:
            if isinstance(target, self._ast.AsyncFunctionDef):
                reasons.append('async-fast-target')
            if target.args.posonlyargs or target.args.vararg or target.args.kwarg:
                reasons.append('unsupported-fast-signature')

        ast = self._ast
        def annotation_contains_string(annotation):
            return annotation is not None and any(
                isinstance(item, ast.Constant) and isinstance(item.value, str)
                for item in ast.walk(annotation)
            )

        call_argument_node_ids = set()
        for call in ast.walk(tree):
            if not isinstance(call, ast.Call):
                continue
            arguments = list(call.args) + [
                keyword.value for keyword in call.keywords
            ]
            for argument in arguments:
                call_argument_node_ids.update(
                    id(item) for item in ast.walk(argument)
                )

        reserved_runtime_prefixes = (
            '_tracecode_', '__tracecode_', '_interview_',
            '_INTERVIEW_', '_InterviewGuard', '_internal_',
            '_globals_', '_TRACE_', '_TC_', '_InfiniteLoopDetected',
        )
        reserved_runtime_exact_accesses = {
            '_serialize', '_serialize_output', '_tracer', '_custom_print',
        }
        reserved_runtime_exact_bindings = {'sys', '_builtins'}

        def record_reserved_runtime_name(name, is_binding=False):
            if is_binding and name == '__del__':
                reasons.append('object-finalizer')
            if (
                isinstance(name, str)
                and (
                    name.startswith(reserved_runtime_prefixes)
                    or name in reserved_runtime_exact_accesses
                    or (is_binding and name in reserved_runtime_exact_bindings)
                )
            ):
                reasons.append('reserved-runtime-binding:' + name)

        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                record_reserved_runtime_name(
                    node.id,
                    not isinstance(node.ctx, ast.Load),
                )
            elif isinstance(node, ast.arg):
                record_reserved_runtime_name(node.arg, True)
            elif isinstance(node, ast.alias):
                record_reserved_runtime_name(node.asname, True)
            elif isinstance(node, ast.ExceptHandler):
                record_reserved_runtime_name(node.name, True)
            elif hasattr(ast, 'MatchAs') and isinstance(node, ast.MatchAs):
                record_reserved_runtime_name(node.name, True)
            elif hasattr(ast, 'MatchStar') and isinstance(node, ast.MatchStar):
                record_reserved_runtime_name(node.name, True)
            elif hasattr(ast, 'MatchMapping') and isinstance(node, ast.MatchMapping):
                record_reserved_runtime_name(node.rest, True)
            elif (
                hasattr(ast, 'TypeVar')
                and isinstance(node, (ast.TypeVar, ast.ParamSpec, ast.TypeVarTuple))
            ):
                record_reserved_runtime_name(node.name, True)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                record_reserved_runtime_name(node.name, True)
            elif isinstance(node, (ast.Global, ast.Nonlocal)):
                for name in node.names:
                    record_reserved_runtime_name(name, True)
            if isinstance(node, (ast.arg, ast.AnnAssign)):
                annotation = getattr(node, 'annotation', None)
                if annotation_contains_string(annotation):
                    reasons.append('string-annotation')
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if annotation_contains_string(node.returns):
                    reasons.append('string-annotation')
            elif hasattr(ast, 'TypeAlias') and isinstance(node, ast.TypeAlias):
                reasons.append('type-alias')
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split('.')[0]
                    imported_modules.add(alias.asname or root)
                    if root in denied_modules or root not in allowed_modules:
                        reasons.append('denied-import:' + alias.name)
            elif isinstance(node, ast.ImportFrom):
                root = (node.module or '').split('.')[0]
                for alias in node.names:
                    imported_values.add(alias.asname or alias.name)
                    if alias.name == '*':
                        reasons.append('wildcard-import:' + (node.module or '<relative>'))
                    if alias.name.startswith('_'):
                        reasons.append('private-import:' + alias.name)
                    if root == 'operator' and alias.name in {
                        'attrgetter', 'methodcaller', 'itemgetter', 'setitem',
                        'delitem',
                    }:
                        reasons.append('reflective-import:operator.' + alias.name)
                    if root == 'typing' and alias.name in {
                        'ForwardRef', 'get_type_hints', 'evaluate_forward_ref',
                    }:
                        reasons.append('evaluating-import:typing.' + alias.name)
                    if (
                        root == 'functools'
                        and alias.name in self._algorithm_reflective_functools_names
                    ):
                        reasons.append('evaluating-import:functools.' + alias.name)
                    if alias.name in self._algorithm_shared_state_call_names:
                        reasons.append('shared-state-call:' + alias.name)
                if node.level or root in denied_modules or root not in allowed_modules:
                    reasons.append('denied-import:' + (node.module or '<relative>'))
            elif isinstance(node, ast.Name) and node.id == 'GeneratorExit':
                # Closing a started generator injects GeneratorExit during
                # refcount-driven namespace teardown. That happens outside the
                # retained case guard, so any direct or aliased reference to
                # this sentinel requires the fresh outer-worker boundary.
                reasons.append('generator-finalizer')
            elif isinstance(node, ast.Name) and node.id in denied_names:
                reasons.append('denied-name:' + node.id)
            elif (
                isinstance(node, ast.Constant)
                and id(node) in call_argument_node_ids
                and isinstance(node.value, str)
                and node.value.startswith('__')
            ):
                reasons.append('reflective-string-argument:' + node.value)
            elif (
                isinstance(node, ast.Name)
                and isinstance(node.ctx, ast.Load)
                and node.id in self._algorithm_builtin_names
                and node.id not in self._algorithm_safe_builtin_names
            ):
                reasons.append('unsupported-builtin:' + node.id)
            elif isinstance(node, ast.Attribute) and (
                node.attr.startswith('__')
                or node.attr in self._algorithm_reflective_attribute_names
                or node.attr.startswith(
                    self._algorithm_reflective_attribute_prefixes
                )
            ):
                reasons.append('reflective-attribute:' + node.attr)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                reasons.append('context-manager')
            elif isinstance(node, ast.ExceptHandler) and node.type is None:
                reasons.append('catch-all-exception-handler')
            elif (
                isinstance(node, ast.Try)
                or (
                    hasattr(ast, 'TryStar')
                    and isinstance(node, ast.TryStar)
                )
            ) and node.finalbody:
                reasons.append('exception-finalizer')
            elif isinstance(
                node,
                (ast.Await, ast.Yield, ast.YieldFrom, ast.GeneratorExp),
            ):
                reasons.append('suspending-control-flow')

        shared_names = imported_modules | imported_values

        def root_name(node):
            current = node
            while isinstance(current, (ast.Attribute, ast.Subscript)):
                current = current.value
            return current.id if isinstance(current, ast.Name) else None

        alias_edges = {}
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
                continue
            value = getattr(node, 'value', None)
            value_root = root_name(value)
            if value_root is None:
                continue
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target_node in targets:
                if isinstance(target_node, ast.Name):
                    alias_edges.setdefault(value_root, set()).add(target_node.id)
        proven_shared_aliases = set()
        alias_queue = list(shared_names)
        while alias_queue:
            source_name = alias_queue.pop()
            for target_name in alias_edges.get(source_name, ()):
                if target_name in shared_names:
                    continue
                shared_names.add(target_name)
                proven_shared_aliases.add(target_name)
                alias_queue.append(target_name)

        parent_by_id = {
            id(child): parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        annotation_node_ids = set()
        for annotation_owner in ast.walk(tree):
            annotations = []
            if isinstance(annotation_owner, ast.arg):
                annotations = [annotation_owner.annotation]
            elif isinstance(annotation_owner, ast.AnnAssign):
                annotations = [annotation_owner.annotation]
            elif isinstance(
                annotation_owner,
                (ast.FunctionDef, ast.AsyncFunctionDef),
            ):
                annotations = [annotation_owner.returns]
            for annotation in annotations:
                if annotation is not None:
                    annotation_node_ids.update(
                        id(item) for item in ast.walk(annotation)
                    )

        function_scope_bindings = {}
        function_scope_types = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)

        def collect_function_locals(function):
            names = {
                argument.arg
                for argument in (
                    list(function.args.posonlyargs)
                    + list(function.args.args)
                    + list(function.args.kwonlyargs)
                )
            }
            if function.args.vararg is not None:
                names.add(function.args.vararg.arg)
            if function.args.kwarg is not None:
                names.add(function.args.kwarg.arg)
            global_names = set()
            nonlocal_names = set()

            def visit(current):
                if current is not function and isinstance(
                    current,
                    function_scope_types + (ast.ClassDef,),
                ):
                    if hasattr(current, 'name'):
                        names.add(current.name)
                    return
                if current is not function and isinstance(
                    current,
                    (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp),
                ):
                    return
                if isinstance(current, ast.Global):
                    global_names.update(current.names)
                elif isinstance(current, ast.Nonlocal):
                    nonlocal_names.update(current.names)
                elif isinstance(current, ast.Name) and isinstance(current.ctx, ast.Store):
                    names.add(current.id)
                elif isinstance(current, ast.ExceptHandler) and current.name:
                    names.add(str(current.name))
                for child in ast.iter_child_nodes(current):
                    visit(child)

            statements = function.body if isinstance(function.body, list) else [function.body]
            for statement in statements:
                visit(statement)
            names.difference_update(global_names)
            names.difference_update(nonlocal_names)
            return names, global_names

        for scope in ast.walk(tree):
            if isinstance(scope, function_scope_types):
                local_names, global_names = collect_function_locals(scope)
                function_scope_bindings[id(scope)] = {
                    'locals': local_names,
                    'globals': global_names,
                }

        def node_is_in_function_body(node, function):
            direct_child = node
            parent = parent_by_id.get(id(direct_child))
            while parent is not None and parent is not function:
                direct_child = parent
                parent = parent_by_id.get(id(direct_child))
            if parent is not function:
                return False
            body = function.body
            return (
                direct_child in body
                if isinstance(body, list)
                else direct_child is body
            )

        def is_locally_shadowed(name_node):
            if name_node.id in proven_shared_aliases:
                return False
            current = parent_by_id.get(id(name_node))
            while current is not None:
                if isinstance(current, function_scope_types):
                    if node_is_in_function_body(name_node, current):
                        bindings = function_scope_bindings.get(id(current), {})
                        if name_node.id in bindings.get('globals', set()):
                            return False
                        if name_node.id in bindings.get('locals', set()):
                            return True
                current = parent_by_id.get(id(current))
            return False

        def root_name_node(node):
            current = node
            while isinstance(current, (ast.Attribute, ast.Subscript)):
                current = current.value
            return current if isinstance(current, ast.Name) else None

        safe_shared_constants = {
            'math': {
                'e', 'inf', 'nan', 'pi', 'tau',
            },
            're': {
                'A', 'ASCII', 'DEBUG', 'DOTALL', 'I', 'IGNORECASE',
                'L', 'LOCALE', 'M', 'MULTILINE', 'NOFLAG', 'S',
                'T', 'TEMPLATE', 'U', 'UNICODE', 'VERBOSE', 'X',
            },
            'string': {
                'ascii_letters', 'ascii_lowercase', 'ascii_uppercase',
                'digits', 'hexdigits', 'octdigits', 'printable',
                'punctuation', 'whitespace',
            },
            'sys': {'maxsize'},
        }

        def shared_attribute_is_directly_invoked(attribute_node):
            current = attribute_node
            parent = parent_by_id.get(id(current))
            while isinstance(parent, ast.Attribute) and parent.value is current:
                current = parent
                parent = parent_by_id.get(id(current))
            if isinstance(parent, ast.Call) and parent.func is current:
                return True
            if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                return current in parent.decorator_list
            return False

        for node in ast.walk(tree):
            targets = []
            if isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            elif isinstance(node, ast.AugAssign):
                targets = [node.target]
            elif isinstance(node, ast.Delete):
                targets = node.targets
            for target in targets:
                root_node = root_name_node(target)
                if (
                    root_node is not None
                    and root_node.id in shared_names
                    and not is_locally_shadowed(root_node)
                    and not isinstance(target, ast.Name)
                ):
                    reasons.append('shared-state-write')

            if (
                isinstance(node, ast.Attribute)
                and (attribute_root := root_name_node(node)) is not None
                and attribute_root.id in shared_names
                and not is_locally_shadowed(attribute_root)
                and isinstance(node.value, ast.Attribute)
            ):
                reasons.append(
                    'transitive-shared-access:' + attribute_root.id
                )
            if (
                isinstance(node, ast.Attribute)
                and (attribute_root := root_name_node(node)) is not None
                and attribute_root.id in shared_names
                and not is_locally_shadowed(attribute_root)
                and node.attr in self._algorithm_shared_state_call_names
                and shared_attribute_is_directly_invoked(node)
            ):
                reasons.append('shared-state-call:' + node.attr)
            if (
                isinstance(node, ast.Attribute)
                and (attribute_root := root_name_node(node)) is not None
                and attribute_root.id in shared_names
                and not is_locally_shadowed(attribute_root)
                and node.attr.startswith('_')
            ):
                reasons.append('private-shared-state-access:' + node.attr)
            if (
                isinstance(node, ast.Attribute)
                and (shared_root := root_name_node(node)) is not None
                and shared_root.id in shared_names
                and not is_locally_shadowed(shared_root)
                and not (
                    isinstance(parent_by_id.get(id(node)), ast.Attribute)
                    and parent_by_id[id(node)].value is node
                )
                and id(node) not in annotation_node_ids
                and node.attr not in safe_shared_constants.get(
                    shared_root.id,
                    set(),
                )
                and not shared_attribute_is_directly_invoked(node)
            ):
                reasons.append('shared-binding-escape:' + shared_root.id)
            if (
                isinstance(node, ast.Attribute)
                and (sys_root := root_name_node(node)) is not None
                and sys_root.id == 'sys'
                and not is_locally_shadowed(sys_root)
                and node.attr != 'maxsize'
            ):
                reasons.append('unsupported-sys-attribute:' + node.attr)

            if (
                not isinstance(node, ast.Name)
                or node.id not in shared_names
                or is_locally_shadowed(node)
            ):
                continue
            parent = parent_by_id.get(id(node))
            allowed = (
                isinstance(parent, ast.Attribute) and parent.value is node
            ) or (
                isinstance(parent, ast.Call) and parent.func is node
            ) or (
                isinstance(parent, ast.Subscript)
                and id(node) in annotation_node_ids
            ) or (
                isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and node in parent.decorator_list
            ) or isinstance(parent, (ast.Import, ast.ImportFrom))
            if not allowed and not isinstance(node.ctx, ast.Store):
                reasons.append('shared-binding-escape:' + node.id)

        unique_reasons = list(dict.fromkeys(reasons))
        hard_isolation_prefixes = (
            'denied-import:',
            'wildcard-import:',
            'private-import:',
            'reflective-import:',
            'evaluating-import:',
            'shared-state-call:',
            'denied-name:',
            'reflective-string-argument:',
            'unsupported-builtin:',
            'reflective-attribute:',
            'shared-state-write',
            'private-shared-state-access:',
            'shared-binding-escape:',
            'unsupported-sys-attribute:',
            'transitive-shared-access:',
            'reserved-runtime-binding:',
        )
        hard_isolation_reasons = [
            reason for reason in unique_reasons
            if reason == 'string-annotation'
            or reason == 'type-alias'
            or reason == 'context-manager'
            or reason == 'exception-finalizer'
            or reason == 'object-finalizer'
            or reason == 'generator-finalizer'
            or reason == 'catch-all-exception-handler'
            or reason.startswith(hard_isolation_prefixes)
        ]
        return {
            'tier': (
                'algorithm-fast'
                if not unique_reasons
                else 'hard-isolated'
                if hard_isolation_reasons
                else 'judge-compatible'
            ),
            'reasons': unique_reasons,
        }

    def _begin_common(self):
        if self._builtins_snapshot is not None:
            raise RuntimeError('Nested TraceCode Python execution scope')
        self._builtins_snapshot = dict(self._builtins_dict)
        self._modules_snapshot = dict(self._modules)
        self._module_dict_snapshots = []
        self._module_mutable_snapshots = []

        self._trace_snapshot = self._gettrace()
        self._recursion_limit_snapshot = self._getrecursionlimit()
        self._cwd_snapshot = self._getcwd()
        self._random_state_snapshot = self._random_getstate()

    def begin_algorithm(self):
        self._begin_common()
        self._algorithm_environ_snapshot = dict(self._environ)
        self._algorithm_path_snapshot = list(self._sys.path)
        self._algorithm_importer_cache_snapshot = dict(self._sys.path_importer_cache)

    def begin(self):
        self._begin_common()
        # sys.modules is interpreter-global in Pyodide. Preserve the
        # Python-visible module boundary explicitly: module attributes and the
        # built-in mutable containers reachable from them are restored after
        # each case. Opaque engine-owned state inside C-extension objects is
        # not cloneable here and is not treated as learner case state.
        for module in self._modules_snapshot.values():
            try:
                namespace = module.__dict__
            except Exception:
                continue
            if (
                isinstance(namespace, dict)
                and namespace is not self._guard_globals
                and namespace is not self._builtins_dict
            ):
                self._module_dict_snapshots.append((module, dict(namespace)))
                module_name = namespace.get('__name__')
                for name, value in namespace.items():
                    if module_name == 'os' and name == 'environ':
                        try:
                            self._module_mutable_snapshots.append(
                                (value, 'mapping', self._deepcopy(dict(value)))
                            )
                        except Exception:
                            pass
                        continue
                    if type(value) not in (dict, list, set, bytearray):
                        continue
                    try:
                        self._module_mutable_snapshots.append(
                            (value, type(value).__name__, self._deepcopy(value))
                        )
                    except Exception:
                        pass

    def restore(self):
        builtins_snapshot = self._builtins_snapshot
        modules_snapshot = self._modules_snapshot
        module_dict_snapshots = self._module_dict_snapshots
        module_mutable_snapshots = self._module_mutable_snapshots
        trace_snapshot = self._trace_snapshot
        recursion_limit_snapshot = self._recursion_limit_snapshot
        cwd_snapshot = self._cwd_snapshot
        random_state_snapshot = self._random_state_snapshot
        algorithm_environ_snapshot = self._algorithm_environ_snapshot
        algorithm_path_snapshot = self._algorithm_path_snapshot
        algorithm_importer_cache_snapshot = self._algorithm_importer_cache_snapshot
        self._builtins_snapshot = None
        self._modules_snapshot = None
        self._module_dict_snapshots = None
        self._module_mutable_snapshots = None
        self._trace_snapshot = None
        self._recursion_limit_snapshot = None
        self._cwd_snapshot = None
        self._random_state_snapshot = None
        self._algorithm_environ_snapshot = None
        self._algorithm_path_snapshot = None
        self._algorithm_importer_cache_snapshot = None
        if builtins_snapshot is None or modules_snapshot is None:
            raise RuntimeError('TraceCode Python execution scope was not active')
        self._settrace(None)
        for module, namespace_snapshot in module_dict_snapshots or ():
            try:
                namespace = module.__dict__
                namespace.clear()
                namespace.update(namespace_snapshot)
            except Exception:
                pass
        for value, value_kind, value_snapshot in module_mutable_snapshots or ():
            try:
                if value_kind in ('dict', 'mapping'):
                    value.clear()
                    value.update(value_snapshot)
                elif value_kind == 'list':
                    value[:] = value_snapshot
                elif value_kind == 'set':
                    value.clear()
                    value.update(value_snapshot)
                elif value_kind == 'bytearray':
                    value[:] = value_snapshot
            except Exception:
                pass
        self._builtins_dict.clear()
        self._builtins_dict.update(builtins_snapshot)
        self._modules.clear()
        self._modules.update(modules_snapshot)
        if algorithm_environ_snapshot is not None:
            self._environ.clear()
            self._environ.update(algorithm_environ_snapshot)
        if algorithm_path_snapshot is not None:
            self._sys.path[:] = algorithm_path_snapshot
        if algorithm_importer_cache_snapshot is not None:
            self._sys.path_importer_cache.clear()
            self._sys.path_importer_cache.update(algorithm_importer_cache_snapshot)
        restore_errors = []
        try:
            self._setrecursionlimit(recursion_limit_snapshot)
        except Exception as error:
            restore_errors.append(('recursion limit', error))
        try:
            self._random_setstate(random_state_snapshot)
        except Exception as error:
            restore_errors.append(('random state', error))
        try:
            self._chdir(cwd_snapshot)
        except Exception as error:
            restore_errors.append(('working directory', error))
        try:
            self._settrace(trace_snapshot)
        except Exception as error:
            restore_errors.append(('trace function', error))
        if restore_errors:
            label, error = restore_errors[0]
            raise RuntimeError(
                'TraceCode could not restore Python ' + label + ': ' + str(error)
            ) from error

    def run(self, source, namespace, result_name):
        code = self._compiled.pop(source, None)
        if code is None:
            code = compile(source, '<exec>', 'exec')
        self._compiled[source] = code
        while len(self._compiled) > self._compiled_limit:
            del self._compiled[next(iter(self._compiled))]
        exec(code, namespace)
        return namespace[result_name]

    def compile(self, source, filename):
        return compile(source, filename, 'exec')

    def artifact_fingerprint(self):
        return {
            'cacheTag': str(getattr(self._sys.implementation, 'cache_tag', '')),
            'magicNumber': self._importlib_util.MAGIC_NUMBER.hex(),
            'marshalVersion': int(self._marshal.version),
        }

    def serialize_code(self, code):
        return self._base64.b64encode(
            self._marshal.dumps(code, self._marshal.version)
        ).decode('ascii')

    def deserialize_code(self, encoded):
        return self._marshal.loads(
            self._base64.b64decode(str(encoded).encode('ascii'), validate=True)
        )

    def run_compiled(self, code, namespace, result_name):
        exec(code, namespace)
        return namespace[result_name]

    def set_compiled_limit(self, value):
        self._compiled_limit = max(0, min(16, int(value)))
        while len(self._compiled) > self._compiled_limit:
            del self._compiled[next(iter(self._compiled))]

__tracecode_execution_guard = __TracecodeExecutionGuard(
    _tracecode_guard_ast,
    __tracecode_guard_base64,
    __tracecode_guard_builtins,
    __tracecode_guard_importlib_util,
    __tracecode_guard_marshal,
    _tracecode_guard_os,
    __tracecode_guard_random,
    __tracecode_guard_sys,
    ${JSON.stringify(PYTHON_DEFAULT_IMPORT_PRELUDE)},
    ${JSON.stringify(PYTHON_ALGORITHM_SAFE_BUILTIN_NAMES)},
    ${JSON.stringify(PYTHON_ALGORITHM_REFLECTIVE_FUNCTOOLS_NAMES)},
    ${JSON.stringify(PYTHON_ALGORITHM_REFLECTIVE_ATTRIBUTE_NAMES)},
    ${JSON.stringify(PYTHON_ALGORITHM_REFLECTIVE_ATTRIBUTE_PREFIXES)},
    ${JSON.stringify(PYTHON_ALGORITHM_SHARED_STATE_CALL_NAMES)},
)
__tracecode_execution_guard
`);
  pyodide.globals.delete('__tracecode_execution_guard');
  pyodide.globals.delete('__TracecodeExecutionGuard');
  pyodide.globals.delete('__tracecode_guard_base64');
  pyodide.globals.delete('_tracecode_guard_ast');
  pyodide.globals.delete('__tracecode_guard_builtins');
  pyodide.globals.delete('_tracecode_guard_copy');
  pyodide.globals.delete('__tracecode_guard_importlib_util');
  pyodide.globals.delete('__tracecode_guard_marshal');
  pyodide.globals.delete('_tracecode_guard_os');
  pyodide.globals.delete('__tracecode_guard_random');
  pyodide.globals.delete('__tracecode_guard_sys');
  return guard;
}

function pythonAlgorithmIsolationProfile(
  deps,
  source,
  functionName,
  executionStyle
) {
  const pyodide = deps.getPyodide();
  const profileProxy = getIsolatedPythonExecutionGuard(
    pyodide
  ).classify_algorithm_source(
    source,
    functionName ?? '',
    executionStyle ?? 'function'
  );
  try {
    const profile = profileProxy.toJs({
      dict_converter: Object.fromEntries,
    });
    return {
      tier: profile.tier === 'algorithm-fast'
        ? 'algorithm-fast'
        : profile.tier === 'judge-compatible'
          ? 'judge-compatible'
          : 'hard-isolated',
      reasons: Array.isArray(profile.reasons)
        ? profile.reasons.map(String)
        : [],
    };
  } finally {
    profileProxy?.destroy?.();
  }
}

function getIsolatedPythonExecutionGuard(pyodide) {
  let guard = isolatedPythonExecutionGuards.get(pyodide);
  if (!guard) {
    guard = createIsolatedPythonExecutionGuard(pyodide);
    isolatedPythonExecutionGuards.set(pyodide, guard);
  }
  return guard;
}

async function runPythonInFreshExecutionScope(
  deps,
  source,
  resultName,
  bindings = undefined
) {
  const pyodide = deps.getPyodide();
  // Dependency-injected source-generation tests intentionally provide only
  // runPythonAsync. Real Pyodide exposes all three APIs used for the isolated
  // execution path.
  if (
    typeof pyodide?.runPython !== 'function' ||
    typeof pyodide?.toPy !== 'function' ||
    typeof pyodide?.globals?.delete !== 'function'
  ) {
    return pyodide.runPythonAsync(source);
  }
  const guard = getIsolatedPythonExecutionGuard(pyodide);
  const namespace = pyodide.toPy({ __name__: '__main__' });
  guard.set_compiled_limit(deps.pythonCompileCacheLimit ?? 4);
  guard.begin();
  try {
    setPythonNamespaceBindings(namespace, bindings);
    return guard.run(source, namespace, resultName);
  } finally {
    try {
      guard.restore();
    } finally {
      namespace?.destroy?.();
    }
  }
}

function setPythonNamespaceBindings(namespace, bindings) {
  if (!bindings) return;
  for (const [name, value] of Object.entries(bindings)) {
    namespace.set(name, value);
  }
}

function preparedPythonLiteral(deps, value, scopeTimings) {
  const startedAt = deps.performanceNow();
  const literal = deps.toPythonLiteral(value);
  if (scopeTimings) {
    scopeTimings.inputLiteralMs += deps.performanceNow() - startedAt;
  }
  return literal;
}

function pythonInputsRequireCustomMaterialization(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.some((entry) =>
        pythonInputsRequireCustomMaterialization(entry, seen)
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(value, '__type__') ||
      Object.prototype.hasOwnProperty.call(value, '__class__') ||
      Object.prototype.hasOwnProperty.call(value, '__id__') ||
      Object.prototype.hasOwnProperty.call(value, '__ref__') ||
      Object.prototype.hasOwnProperty.call(value, 'left') ||
      Object.prototype.hasOwnProperty.call(value, 'right') ||
      Object.prototype.hasOwnProperty.call(value, 'next')
    ) {
      return true;
    }
    return Object.values(value).some((entry) =>
      pythonInputsRequireCustomMaterialization(entry, seen)
    );
  } finally {
    seen.delete(value);
  }
}

async function compilePythonProgram(deps, source, filename) {
  const pyodide = deps.getPyodide();
  if (
    typeof pyodide?.runPython !== 'function' ||
    typeof pyodide?.globals?.delete !== 'function'
  ) {
    throw new Error('Prepared Python programs require the full browser Python runtime.');
  }
  const guard = getIsolatedPythonExecutionGuard(pyodide);
  return guard.compile(source, filename);
}

function pythonPreparedArtifactFingerprint(deps) {
  const pyodide = deps.getPyodide();
  if (typeof pyodide?.runPython !== 'function') {
    throw new Error('Prepared Python programs require the full browser Python runtime.');
  }
  const fingerprintProxy = getIsolatedPythonExecutionGuard(pyodide).artifact_fingerprint();
  try {
    return fingerprintProxy.toJs({
      dict_converter: Object.fromEntries,
    });
  } finally {
    fingerprintProxy?.destroy?.();
  }
}

function serializePythonCodeArtifact(deps, code) {
  const pyodide = deps.getPyodide();
  if (typeof pyodide?.runPython !== 'function') {
    throw new Error('Prepared Python programs require the full browser Python runtime.');
  }
  return getIsolatedPythonExecutionGuard(pyodide).serialize_code(code);
}

function deserializePythonCodeArtifact(deps, encoded) {
  const pyodide = deps.getPyodide();
  if (typeof pyodide?.runPython !== 'function') {
    throw new Error('Prepared Python programs require the full browser Python runtime.');
  }
  return getIsolatedPythonExecutionGuard(pyodide).deserialize_code(encoded);
}

async function runCompiledPythonInFreshExecutionScope(
  deps,
  code,
  resultName,
  bindings,
  scopeTimings = undefined,
  isolationTier = 'compatibility'
) {
  const pyodide = deps.getPyodide();
  if (
    typeof pyodide?.runPython !== 'function' ||
    typeof pyodide?.toPy !== 'function' ||
    typeof pyodide?.globals?.delete !== 'function'
  ) {
    throw new Error('Prepared Python programs require the full browser Python runtime.');
  }
  const guard = getIsolatedPythonExecutionGuard(pyodide);
  const namespaceStartedAt = deps.performanceNow();
  const namespace = pyodide.toPy({ __name__: '__main__' });
  if (scopeTimings) {
    scopeTimings.namespaceCreateMs += deps.performanceNow() - namespaceStartedAt;
  }
  const guardBeginStartedAt = deps.performanceNow();
  if (isolationTier === 'algorithm-fast') {
    guard.begin_algorithm();
  } else {
    guard.begin();
  }
  if (scopeTimings) {
    scopeTimings.guardBeginMs += deps.performanceNow() - guardBeginStartedAt;
  }
  try {
    const bindingStartedAt = deps.performanceNow();
    setPythonNamespaceBindings(namespace, bindings);
    if (scopeTimings) {
      scopeTimings.bindingMs += deps.performanceNow() - bindingStartedAt;
    }
    const compiledExecutionStartedAt = deps.performanceNow();
    const result = guard.run_compiled(code, namespace, resultName);
    if (scopeTimings) {
      scopeTimings.compiledExecutionMs +=
        deps.performanceNow() - compiledExecutionStartedAt;
    }
    return result;
  } finally {
    try {
      const guardRestoreStartedAt = deps.performanceNow();
      guard.restore();
      if (scopeTimings) {
        scopeTimings.guardRestoreMs += deps.performanceNow() - guardRestoreStartedAt;
      }
    } finally {
      const namespaceDestroyStartedAt = deps.performanceNow();
      namespace?.destroy?.();
      if (scopeTimings) {
        scopeTimings.namespaceDestroyMs +=
          deps.performanceNow() - namespaceDestroyStartedAt;
      }
    }
  }
}

function getTraceMaxPathDepth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TRACE_MAX_PATH_DEPTH;
  }
  return Math.min(MAX_TRACE_MAX_PATH_DEPTH, Math.max(1, Math.floor(value)));
}

function getTraceMaxBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TRACE_MAX_BYTES;
  }
  return Math.min(MAX_TRACE_MAX_BYTES, Math.max(1024, Math.floor(value)));
}

function buildOnDemandPythonExecutorCompilerSource(
  deps,
  traceSource,
  codeSource
) {
  const traceSourceLiteral = deps.toPythonLiteral(String(traceSource ?? ''));
  const codeSourceLiteral = deps.toPythonLiteral(String(codeSource ?? ''));
  return `
import ast as _tracecode_executor_ast

_tracecode_trace_executor_tree = _tracecode_executor_ast.parse(
    ${traceSourceLiteral},
    filename='<tracecode-prepared-trace-enabled>',
    mode='exec',
)
_tracecode_code_executor_tree = _tracecode_executor_ast.parse(
    ${codeSourceLiteral},
    filename='<tracecode-prepared-trace-disabled>',
    mode='exec',
)
_tracecode_executor_selector = _tracecode_executor_ast.If(
    test=_tracecode_executor_ast.Name(
        id='__tracecode_tracing_enabled',
        ctx=_tracecode_executor_ast.Load(),
    ),
    body=_tracecode_trace_executor_tree.body or [_tracecode_executor_ast.Pass()],
    orelse=_tracecode_code_executor_tree.body or [_tracecode_executor_ast.Pass()],
)
_tracecode_on_demand_executor_tree = _tracecode_executor_ast.Module(
    body=[_tracecode_executor_selector],
    type_ignores=[],
)
_tracecode_executor_ast.fix_missing_locations(
    _tracecode_on_demand_executor_tree
)
__tracecode_prepared_executor_result = compile(
    _tracecode_on_demand_executor_tree,
    '<tracecode-prepared-trace>',
    'exec',
)
__tracecode_prepared_executor_result
`;
}

function buildPythonAlgorithmFastBatchSource(
  deps,
  functionName,
  executionStyle
) {
  const functionNameLiteral = deps.toPythonLiteral(functionName ?? '');
  const executionStyleLiteral = deps.toPythonLiteral(
    executionStyle ?? 'function'
  );
  const defaultImportPreludeLiteral = deps.toPythonLiteral(
    PYTHON_DEFAULT_IMPORT_PRELUDE
  );
  const classDefinitionsLiteral = deps.toPythonLiteral(
    `
def getattr(obj, name, default=None):
    if name == "val":
        try:
            return obj.val
        except AttributeError:
            try:
                return obj.value
            except AttributeError:
                return default
    if name == "value":
        try:
            return obj.value
        except AttributeError:
            try:
                return obj.val
            except AttributeError:
                return default
    return default
${deps.PYTHON_CLASS_DEFINITIONS_SNIPPET}`
  );
  const defaults = deps.INTERVIEW_GUARD_DEFAULTS;
  return `
import ast as _tracecode_batch_ast
import builtins as _tracecode_batch_builtins
import collections.abc as _tracecode_batch_collections_abc
import inspect as _tracecode_batch_inspect
import json as _tracecode_batch_json
import math as _tracecode_batch_math
import random as _tracecode_batch_random
import re as _tracecode_batch_re
import sys as _tracecode_batch_sys
import time as _tracecode_batch_time
import traceback as _tracecode_batch_traceback
import types as _tracecode_batch_types
import typing as _tracecode_batch_typing

_tracecode_batch_host_import = _tracecode_batch_builtins.__import__
_tracecode_batch_importable_module_roots = {
    'array', 'bisect', 'collections', 'functools', 'heapq', 'itertools',
    'math', 'operator', 'random', 're', 'statistics', 'string',
    'sortedcontainers', 'typing',
}
_tracecode_batch_facade_module_roots = (
    _tracecode_batch_importable_module_roots | {'json', 'sys'}
)
_tracecode_batch_allowed_value_owner_roots = {
    'array': {'array'},
    'bisect': {'bisect', '_bisect'},
    'collections': {'collections', '_collections', '_collections_abc'},
    'functools': {'functools', '_functools'},
    'heapq': {'heapq', '_heapq'},
    'itertools': {'itertools'},
    'json': {'json'},
    'math': {'math'},
    'operator': {'operator', '_operator'},
    'random': {'random'},
    're': {'re', '_sre'},
    'statistics': {'statistics'},
    'string': {'string'},
    'sortedcontainers': {'sortedcontainers'},
    'sys': {'sys'},
    'typing': {'typing'},
}
_tracecode_batch_reflective_operator_names = {
    'attrgetter', 'methodcaller', 'itemgetter', 'setitem', 'delitem',
}
_tracecode_batch_reflective_functools_names = set(
    ${JSON.stringify(PYTHON_ALGORITHM_REFLECTIVE_FUNCTOOLS_NAMES)}
)
_tracecode_batch_reflective_attribute_names = set(
    ${JSON.stringify(PYTHON_ALGORITHM_REFLECTIVE_ATTRIBUTE_NAMES)}
) | _tracecode_batch_reflective_functools_names
_tracecode_batch_reflective_attribute_prefixes = tuple(
    ${JSON.stringify(PYTHON_ALGORITHM_REFLECTIVE_ATTRIBUTE_PREFIXES)}
)
_tracecode_batch_module_proxies = {}

class _TracecodeReadOnlyModule:
    __slots__ = (
        '_tracecode_name',
        '_tracecode_module',
        '_tracecode_authorized_names',
    )

    def __init__(self, name):
        module_name = str(name)
        object.__setattr__(self, '_tracecode_name', module_name)
        object.__setattr__(self, '_tracecode_module', None)
        object.__setattr__(self, '_tracecode_authorized_names', {})

    def __getattribute__(self, name):
        if str(name).startswith('_'):
            raise AttributeError('Private module attributes are unavailable')
        return object.__getattribute__(self, name)

    def __getattr__(self, name):
        module_name = object.__getattribute__(self, '_tracecode_name')
        module = object.__getattribute__(self, '_tracecode_module')
        if module is None:
            module = _tracecode_batch_host_import(
                module_name,
                {},
                {},
                ('*',),
                0,
            )
            object.__setattr__(self, '_tracecode_module', module)
        authorized_names = object.__getattribute__(
            self,
            '_tracecode_authorized_names',
        )
        root = module_name.split('.')[0]
        if str(name).startswith('_'):
            raise AttributeError('Private module attributes are unavailable')
        if root == 'operator' and name in _tracecode_batch_reflective_operator_names:
            raise AttributeError('Reflective operator helpers are unavailable')
        if root == 'functools' and name in _tracecode_batch_reflective_functools_names:
            raise AttributeError('Annotation-evaluating helpers are unavailable')
        if root == 'typing' and name in {
            'ForwardRef', 'get_type_hints', 'evaluate_forward_ref',
        }:
            raise AttributeError('Evaluating annotations is unavailable')
        if root == 'string' and name == 'Formatter':
            raise AttributeError('Reflective string formatting is unavailable')
        if root == 'sys' and name != 'maxsize':
            raise AttributeError('Only sys.maxsize is available')
        authorization = authorized_names.get(name)
        if authorization is not None:
            if authorization[0] == 'module':
                return _tracecode_batch_readonly_module(authorization[1])
            return authorization[1]
        value = getattr(module, name)
        if isinstance(value, _tracecode_batch_types.ModuleType):
            resolved_name = str(value.__name__)
            resolved_root = resolved_name.split('.')[0]
            if resolved_root not in _tracecode_batch_facade_module_roots:
                raise AttributeError(
                    'Transitive module is unavailable in algorithm execution'
                )
            authorized_names[name] = ('module', resolved_name)
            return _tracecode_batch_readonly_module(resolved_name)
        owner_name = str(getattr(value, '__module__', '') or '')
        if owner_name:
            owner_root = owner_name.split('.')[0]
            allowed_owners = _tracecode_batch_allowed_value_owner_roots.get(
                root,
                {root},
            )
            if owner_root not in allowed_owners:
                raise AttributeError(
                    'Transitive module value is unavailable in algorithm execution'
                )
        authorized_names[name] = ('value', value)
        return value

    def __setattr__(self, name, value):
        raise AttributeError('Imported modules are read-only in algorithm execution')

    def __delattr__(self, name):
        raise AttributeError('Imported modules are read-only in algorithm execution')

def _tracecode_batch_readonly_module(name):
    key = str(name)
    proxy = _tracecode_batch_module_proxies.get(key)
    if proxy is None:
        proxy = _TracecodeReadOnlyModule(key)
        _tracecode_batch_module_proxies[key] = proxy
    return proxy

def _tracecode_batch_safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    module_name = str(name)
    root = module_name.split('.')[0]
    if level != 0 or root not in _tracecode_batch_importable_module_roots:
        raise ImportError('Module is unavailable in algorithm execution: ' + module_name)
    requested = tuple(str(item) for item in (fromlist or ()))
    if '*' in requested:
        raise ImportError('Wildcard imports are unavailable in algorithm execution')
    if root == 'operator' and any(
        item in _tracecode_batch_reflective_operator_names for item in requested
    ):
        raise ImportError('Reflective operator helpers are unavailable')
    if root == 'functools' and any(
        item in _tracecode_batch_reflective_functools_names
        for item in requested
    ):
        raise ImportError('Annotation-evaluating helpers are unavailable')
    if root == 'typing' and any(
        item in {'ForwardRef', 'get_type_hints', 'evaluate_forward_ref'}
        for item in requested
    ):
        raise ImportError('Evaluating annotations is unavailable')
    imported = _tracecode_batch_host_import(
        module_name,
        globals or {},
        locals or {},
        requested,
        0,
    )
    resolved_name = module_name if requested else root
    if requested and isinstance(imported, _tracecode_batch_types.ModuleType):
        resolved_name = imported.__name__
    return _tracecode_batch_readonly_module(resolved_name)

_tracecode_batch_safe_builtin_names = set(
    ${JSON.stringify(PYTHON_ALGORITHM_SAFE_BUILTIN_NAMES)}
)
_tracecode_batch_safe_builtins = {
    name: getattr(_tracecode_batch_builtins, name)
    for name in _tracecode_batch_safe_builtin_names
}
_tracecode_batch_safe_builtins['__import__'] = _tracecode_batch_safe_import

_tracecode_batch_prelude = {
    '__builtins__': dict(vars(_tracecode_batch_builtins)),
}
exec(${defaultImportPreludeLiteral}, _tracecode_batch_prelude)

${deps.PYTHON_CLASS_DEFINITIONS_SNIPPET}
_builtins = _tracecode_batch_builtins
json = _tracecode_batch_json
math = _tracecode_batch_math
${deps.PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET}

_tracecode_batch_base = {
    '__name__': '__main__',
    '__builtins__': _tracecode_batch_safe_builtins,
    'TreeNode': TreeNode,
    'ListNode': ListNode,
    'math': _tracecode_batch_readonly_module('math'),
    'json': _tracecode_batch_readonly_module('json'),
    'sys': _tracecode_batch_readonly_module('sys'),
}
for _tracecode_name, _tracecode_value in _tracecode_batch_prelude.items():
    if _tracecode_name.startswith('__'):
        continue
    if _tracecode_name in _tracecode_batch_reflective_operator_names:
        continue
    if _tracecode_name in _tracecode_batch_reflective_functools_names:
        continue
    if isinstance(_tracecode_value, _tracecode_batch_types.ModuleType):
        _tracecode_value = _tracecode_batch_readonly_module(
            _tracecode_value.__name__
        )
    _tracecode_batch_base[_tracecode_name] = _tracecode_value
_tracecode_batch_base['pow'] = _tracecode_batch_builtins.pow

# Capture the trusted result encoder before learner code runs. Even if a future
# admission bug exposes a mutable stdlib class, batch verdict serialization no
# longer performs a fresh learner-reachable json.JSONEncoder lookup.
_tracecode_batch_encode_results = _tracecode_trusted_json_encode

_tracecode_batch_cases = _tracecode_batch_ast.literal_eval(
    __tracecode_input_batch_literal
)
_tracecode_batch_limits = _tracecode_batch_ast.literal_eval(
    __tracecode_limits_literal
)
_tracecode_batch_function_name = ${functionNameLiteral}
_tracecode_batch_execution_style = ${executionStyleLiteral}
_tracecode_batch_random_state = _tracecode_batch_random.getstate()
_tracecode_batch_encoded_results = []
_tracecode_batch_encoded_bytes = 2
_tracecode_batch_max_encoded_bytes = 32 * 1024 * 1024
_tracecode_batch_result_reserve_bytes = 512
if (
    len(_tracecode_batch_cases) * _tracecode_batch_result_reserve_bytes
    >= _tracecode_batch_max_encoded_bytes
):
    raise RuntimeError(
        'Prepared Python algorithm-fast batch is too large for its result envelope.'
    )
_tracecode_batch_print_code = compile(
    'def _tracecode_isolated_print(*args, **kwargs):\\n'
    '    _tracecode_console.append(" ".join(str(arg) for arg in args))\\n',
    '<tracecode-algorithm-print>',
    'exec',
)
_tracecode_batch_class_code = compile(
    ${classDefinitionsLiteral},
    '<tracecode-algorithm-classes>',
    'exec',
)

class _TracecodeAlgorithmLimit(BaseException):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)

def _tracecode_execute_serialize_checkpoint():
    if (
        _tracecode_case_deadline is not None
        and _tracecode_batch_time.perf_counter() >= _tracecode_case_deadline
    ):
        raise _TracecodeAlgorithmLimit('client-timeout')

${PYTHON_LITERAL_SHAPE_ANNOTATION_HELPER}

def _tracecode_batch_hydrate_for_annotation(value, annotation):
    if annotation is None:
        return value
    if (
        isinstance(annotation, type)
        and annotation.__name__ in ('TreeNode', 'ListNode')
    ):
        return value
    origin = _tracecode_batch_typing.get_origin(annotation)
    args = _tracecode_batch_typing.get_args(annotation)
    if origin in (_tracecode_batch_typing.Union, _tracecode_batch_types.UnionType):
        candidates = [item for item in args if item is not type(None)]
        return (
            _tracecode_batch_hydrate_for_annotation(value, candidates[0])
            if len(candidates) == 1
            else value
        )
    if origin in (list, tuple, set, frozenset) and isinstance(value, (list, tuple)):
        if origin is tuple and len(args) > 1 and args[-1] is not Ellipsis:
            items = [
                _tracecode_batch_hydrate_for_annotation(
                    item,
                    args[index] if index < len(args) else None,
                )
                for index, item in enumerate(value)
            ]
        else:
            item_annotation = args[0] if args else None
            items = [
                _tracecode_batch_hydrate_for_annotation(item, item_annotation)
                for item in value
            ]
        if origin is tuple:
            return tuple(items)
        if origin is set:
            return set(items)
        if origin is frozenset:
            return frozenset(items)
        return items
    if (
        origin in (
            dict,
            _tracecode_batch_collections_abc.Mapping,
            _tracecode_batch_collections_abc.MutableMapping,
        )
        and isinstance(value, dict)
    ):
        key_annotation = args[0] if len(args) > 0 else None
        value_annotation = args[1] if len(args) > 1 else None
        return {
            _tracecode_batch_hydrate_for_annotation(key, key_annotation):
                _tracecode_batch_hydrate_for_annotation(item, value_annotation)
            for key, item in value.items()
        }
    if isinstance(annotation, type) and isinstance(value, dict):
        fields = {
            key: item
            for key, item in value.items()
            if key not in ('__type__', '__class__', '__id__')
        }
        constructor = getattr(annotation, '__init__', None)
        constructor_annotations = (
            getattr(constructor, '__annotations__', {}) or {}
        )
        hydrated_fields = {
            key: _tracecode_batch_hydrate_for_annotation(
                item,
                constructor_annotations.get(key),
            )
            for key, item in fields.items()
        }
        try:
            return annotation(**hydrated_fields)
        except Exception:
            pass
        try:
            return annotation(*list(hydrated_fields.values()))
        except Exception:
            pass
        try:
            instance = annotation.__new__(annotation)
            for key, item in hydrated_fields.items():
                setattr(instance, key, item)
            return instance
        except Exception:
            return value
    return value

def _tracecode_batch_hydrate_inputs(target, values, case_globals):
    annotations = getattr(target, '__annotations__', {}) or {}
    for name in list(values.keys()):
        if name not in annotations:
            continue
        annotation = annotations[name]
        if not _tracecode_annotation_preserves_literal_shape(annotation):
            values[name] = _tracecode_batch_hydrate_for_annotation(
                values[name],
                annotation,
            )
            case_globals[name] = values[name]

def _tracecode_batch_prepare_call(target, values):
    try:
        signature = _tracecode_batch_inspect.signature(target)
    except Exception:
        return target, [], dict(values)
    args = []
    kwargs = {}
    has_varargs = any(
        parameter.kind is _tracecode_batch_inspect.Parameter.VAR_POSITIONAL
        for parameter in signature.parameters.values()
    )
    for parameter in signature.parameters.values():
        if parameter.name in ('self', 'cls'):
            continue
        kind = parameter.kind
        if kind is _tracecode_batch_inspect.Parameter.VAR_POSITIONAL:
            if parameter.name in values:
                raw = values[parameter.name]
                args.extend(raw if isinstance(raw, (list, tuple)) else [raw])
            continue
        if kind is _tracecode_batch_inspect.Parameter.VAR_KEYWORD:
            if parameter.name in values and isinstance(values[parameter.name], dict):
                kwargs.update(values[parameter.name])
            continue
        if parameter.name not in values:
            continue
        if kind is _tracecode_batch_inspect.Parameter.POSITIONAL_ONLY:
            args.append(values[parameter.name])
        elif kind is _tracecode_batch_inspect.Parameter.POSITIONAL_OR_KEYWORD and has_varargs:
            args.append(values[parameter.name])
        else:
            kwargs[parameter.name] = values[parameter.name]
    return target, args, kwargs

_tracecode_batch_user_tree = _tracecode_batch_ast.parse(
    __tracecode_prepared_user_source,
    filename='solution.py',
    mode='exec',
)
for _tracecode_batch_user_node in _tracecode_batch_ast.walk(
    _tracecode_batch_user_tree
):
    if isinstance(_tracecode_batch_user_node, _tracecode_batch_ast.Attribute):
        _tracecode_batch_attribute_name = str(
            _tracecode_batch_user_node.attr
        )
        if (
            _tracecode_batch_attribute_name.startswith('__')
            or _tracecode_batch_attribute_name
                in _tracecode_batch_reflective_attribute_names
            or _tracecode_batch_attribute_name.startswith(
                _tracecode_batch_reflective_attribute_prefixes
            )
        ):
            raise RuntimeError(
                'Prepared algorithm artifact contains reflective attribute: '
                + _tracecode_batch_attribute_name
            )
    if isinstance(
        _tracecode_batch_user_node,
        _tracecode_batch_ast.GeneratorExp,
    ):
        raise RuntimeError(
            'Prepared algorithm artifact contains suspending control flow'
        )
_tracecode_batch_call_argument_node_ids = set()
for _tracecode_batch_call_node in _tracecode_batch_ast.walk(
    _tracecode_batch_user_tree
):
    if not isinstance(_tracecode_batch_call_node, _tracecode_batch_ast.Call):
        continue
    _tracecode_batch_call_arguments = list(
        _tracecode_batch_call_node.args
    ) + [
        _tracecode_batch_keyword.value
        for _tracecode_batch_keyword in _tracecode_batch_call_node.keywords
    ]
    for _tracecode_batch_call_argument in _tracecode_batch_call_arguments:
        _tracecode_batch_call_argument_node_ids.update(
            id(_tracecode_batch_call_argument_item)
            for _tracecode_batch_call_argument_item
            in _tracecode_batch_ast.walk(_tracecode_batch_call_argument)
        )
for _tracecode_batch_user_node in _tracecode_batch_ast.walk(
    _tracecode_batch_user_tree
):
    if (
        isinstance(_tracecode_batch_user_node, _tracecode_batch_ast.Constant)
        and id(_tracecode_batch_user_node)
            in _tracecode_batch_call_argument_node_ids
        and isinstance(_tracecode_batch_user_node.value, str)
        and _tracecode_batch_user_node.value.startswith('__')
    ):
        raise RuntimeError(
            'Prepared algorithm artifact contains reflective string argument: '
            + _tracecode_batch_user_node.value
        )
_tracecode_batch_user_code = _tracecode_batch_builtins.compile(
    __tracecode_prepared_user_source,
    'solution.py',
    'exec',
)
def _tracecode_batch_append_result(entry):
    global _tracecode_batch_encoded_bytes
    try:
        encoded = _tracecode_batch_encode_results(
            entry,
            max_bytes=_MAX_SERIALIZED_BYTES,
            limit_type=_TracecodeSerializationLimit,
            checkpoint=_tracecode_execute_serialize_checkpoint,
        )
    except _TracecodeSerializationLimit:
        entry = {
            'success': False,
            'output': None,
            'error': 'Execution stopped: resource limit exceeded (serialization-limit).',
            'timeoutReason': 'serialization-limit',
            'consoleOutput': [],
            'timings': entry.get('timings', {
                'runMs': 0,
                'algorithmFastBatch': True,
            }),
        }
        encoded = _tracecode_batch_encode_results(entry)
    except _TracecodeAlgorithmLimit as error:
        entry = {
            'success': False,
            'output': None,
            'error': 'Execution stopped: resource limit exceeded (' + error.reason + ').',
            'timeoutReason': error.reason,
            'consoleOutput': [],
            'timings': entry.get('timings', {
                'runMs': 0,
                'algorithmFastBatch': True,
            }),
        }
        encoded = _tracecode_batch_encode_results(entry)
    except BaseException:
        entry = {
            'success': False,
            'output': None,
            'error': 'Execution failed',
            'consoleOutput': [],
            'timings': {
                'runMs': 0,
                'algorithmFastBatch': True,
            },
        }
        encoded = _tracecode_batch_encode_results(entry)
    separator_bytes = 1 if _tracecode_batch_encoded_results else 0
    encoded_bytes = len(encoded)
    remaining_case_count = (
        len(_tracecode_batch_cases)
        - len(_tracecode_batch_encoded_results)
        - 1
    )
    remaining_reserve_bytes = (
        remaining_case_count * _tracecode_batch_result_reserve_bytes
    )
    if (
        _tracecode_batch_encoded_bytes + separator_bytes + encoded_bytes
        + remaining_reserve_bytes
        > _tracecode_batch_max_encoded_bytes
    ):
        entry = {
            'success': False,
            'output': None,
            'error': 'Execution stopped: resource limit exceeded (serialization-limit).',
            'timeoutReason': 'serialization-limit',
            'consoleOutput': [],
            'timings': entry.get('timings', {
                'runMs': 0,
                'algorithmFastBatch': True,
            }),
        }
        encoded = _tracecode_batch_encode_results(entry)
        encoded_bytes = len(encoded)
    if (
        _tracecode_batch_encoded_bytes + separator_bytes + encoded_bytes
        + remaining_reserve_bytes
        > _tracecode_batch_max_encoded_bytes
    ):
        raise RuntimeError(
            'Prepared Python algorithm-fast batch exhausted its result reserve.'
        )
    _tracecode_batch_encoded_results.append(encoded)
    _tracecode_batch_encoded_bytes += separator_bytes + encoded_bytes

def _tracecode_batch_format_error(error):
    error_line = None
    try:
        frames = _tracecode_batch_traceback.extract_tb(error.__traceback__)
        user_frames = [
            frame for frame in frames if frame.filename == 'solution.py'
        ]
        error_line = user_frames[-1].lineno if user_frames else None
    except _TracecodeAlgorithmLimit as formatting_limit:
        return (
            None,
            'Execution stopped: resource limit exceeded ('
            + formatting_limit.reason
            + ').',
            '',
            formatting_limit.reason,
        )
    except _TracecodeSerializationLimit:
        return (
            None,
            'Execution stopped: resource limit exceeded '
            '(serialization-limit).',
            '',
            'serialization-limit',
        )
    except BaseException:
        error_line = None
    try:
        error_type = _tracecode_batch_builtins.BaseException.__getattribute__(
            error,
            '__class__',
        )
        error_prefix = _tracecode_batch_builtins.type.__getattribute__(
            error_type,
            '__name__',
        )
    except _TracecodeAlgorithmLimit as formatting_limit:
        return (
            None,
            'Execution stopped: resource limit exceeded ('
            + formatting_limit.reason
            + ').',
            '',
            formatting_limit.reason,
        )
    except _TracecodeSerializationLimit:
        return (
            None,
            'Execution stopped: resource limit exceeded '
            '(serialization-limit).',
            '',
            'serialization-limit',
        )
    except BaseException:
        error_prefix = 'ExecutionError'
    try:
        error_detail = str(error).strip().splitlines()[0]
    except _TracecodeAlgorithmLimit as formatting_limit:
        return (
            None,
            'Execution stopped: resource limit exceeded ('
            + formatting_limit.reason
            + ').',
            '',
            formatting_limit.reason,
        )
    except _TracecodeSerializationLimit:
        return (
            None,
            'Execution stopped: resource limit exceeded '
            '(serialization-limit).',
            '',
            'serialization-limit',
        )
    except BaseException:
        error_detail = 'Execution failed'
    return error_line, error_prefix, error_detail, None

for _tracecode_batch_inputs in _tracecode_batch_cases:
    # re's compiled-pattern cache is interpreter-global. It is not exposed by
    # the capability facade, but clearing it at every case boundary also
    # removes the timing/residency channel between retained-batch cases.
    _tracecode_batch_re.purge()
    _tracecode_case_started = _tracecode_batch_time.perf_counter()
    _tracecode_wall_clock_ms = _tracecode_batch_limits.get(
        'wallClockMs',
        None,
    )
    _tracecode_case_deadline = (
        _tracecode_case_started + max(1.0, float(_tracecode_wall_clock_ms)) / 1000.0
        if _tracecode_wall_clock_ms is not None
        else None
    )
    _tracecode_case_console = []
    _tracecode_case_globals = dict(_tracecode_batch_base)
    _tracecode_case_builtins = dict(_tracecode_batch_safe_builtins)
    _tracecode_print_namespace = {
        '__builtins__': {'str': str},
        '_tracecode_console': _tracecode_case_console,
    }
    exec(_tracecode_batch_print_code, _tracecode_print_namespace)
    _tracecode_case_builtins['print'] = _tracecode_print_namespace[
        '_tracecode_isolated_print'
    ]
    _tracecode_case_globals['__builtins__'] = _tracecode_case_builtins
    _tracecode_case_class_globals = {
        '__name__': '__main__',
        '__builtins__': {
            '__build_class__': _tracecode_batch_builtins.__build_class__,
            'AttributeError': _tracecode_batch_builtins.AttributeError,
            'KeyError': _tracecode_batch_builtins.KeyError,
        },
    }
    exec(_tracecode_batch_class_code, _tracecode_case_class_globals)
    TreeNode = _tracecode_case_class_globals['TreeNode']
    ListNode = _tracecode_case_class_globals['ListNode']
    _tracecode_case_globals['TreeNode'] = TreeNode
    _tracecode_case_globals['ListNode'] = ListNode
    _tracecode_case_input_names = tuple(
        str(name) for name in _tracecode_batch_inputs.keys()
    )
    for _tracecode_input_name, _tracecode_input_value in (
        _tracecode_batch_inputs.items()
    ):
        _tracecode_case_globals[str(_tracecode_input_name)] = (
            _tracecode_input_value
        )
    _tracecode_batch_random.setstate(_tracecode_batch_random_state)
    _tracecode_line_events = 0
    _tracecode_line_hits = {}
    _tracecode_call_depth = 0
    _tracecode_trusted_prep_active = False
    _tracecode_memory_started = False
    _tracecode_tracemalloc = None
    _tracecode_interview_limits_enabled = bool(
        _tracecode_batch_limits.get('interviewGuard', False)
    )
    _tracecode_limits_enabled = (
        _tracecode_interview_limits_enabled
        or _tracecode_case_deadline is not None
    )
    _tracecode_max_line_events = max(
        10000,
        int(_tracecode_batch_limits.get('maxLineEvents', ${Number(defaults.maxLineEvents)})),
    )
    _tracecode_max_single_line_hits = max(
        1000,
        int(_tracecode_batch_limits.get('maxSingleLineHits', ${Number(defaults.maxSingleLineHits)})),
    )
    _tracecode_max_call_depth = max(
        100,
        int(_tracecode_batch_limits.get('maxCallDepth', ${Number(defaults.maxCallDepth)})),
    )
    _tracecode_max_memory_bytes = max(
        8 * 1024 * 1024,
        int(_tracecode_batch_limits.get('maxMemoryBytes', ${Number(defaults.maxMemoryBytes)})),
    )
    _tracecode_memory_check_every = max(
        10,
        int(_tracecode_batch_limits.get('memoryCheckEvery', ${Number(defaults.memoryCheckEvery)})),
    )

    def _tracecode_case_tracer(frame, event, arg):
        global _tracecode_line_events, _tracecode_call_depth
        if frame.f_code.co_filename in (
            '<tracecode-algorithm-fast-batch>',
            '<tracecode-algorithm-print>',
        ):
            return _tracecode_case_tracer
        if (
            _tracecode_case_deadline is not None
            and _tracecode_batch_time.perf_counter() >= _tracecode_case_deadline
        ):
            raise _TracecodeAlgorithmLimit('client-timeout')
        if (
            _tracecode_trusted_prep_active
            and frame.f_code.co_filename != 'solution.py'
        ):
            return _tracecode_case_tracer
        if event == 'call' and _tracecode_interview_limits_enabled:
            _tracecode_call_depth += 1
            if _tracecode_call_depth > _tracecode_max_call_depth:
                raise _TracecodeAlgorithmLimit('recursion-limit')
        elif event == 'return' and _tracecode_interview_limits_enabled:
            if _tracecode_call_depth > 0:
                _tracecode_call_depth -= 1
        elif event == 'line' and _tracecode_interview_limits_enabled:
            _tracecode_line_events += 1
            if _tracecode_line_events >= _tracecode_max_line_events:
                raise _TracecodeAlgorithmLimit('line-limit')
            key = (frame.f_code.co_name, frame.f_lineno)
            count = _tracecode_line_hits.get(key, 0) + 1
            _tracecode_line_hits[key] = count
            if count >= _tracecode_max_single_line_hits:
                raise _TracecodeAlgorithmLimit('single-line-limit')
            if (
                _tracecode_tracemalloc is not None
                and _tracecode_memory_check_every > 0
                and _tracecode_line_events % _tracecode_memory_check_every == 0
            ):
                current, peak = _tracecode_tracemalloc.get_traced_memory()
                if max(current, peak) >= _tracecode_max_memory_bytes:
                    raise _TracecodeAlgorithmLimit('memory-limit')
        return _tracecode_case_tracer

    if _tracecode_limits_enabled:
        try:
            if _tracecode_interview_limits_enabled:
                import tracemalloc as _tracecode_tracemalloc
                if not _tracecode_tracemalloc.is_tracing():
                    _tracecode_tracemalloc.start()
                    _tracecode_memory_started = True
                else:
                    _tracecode_tracemalloc.reset_peak()
        except Exception:
            _tracecode_tracemalloc = None
        _tracecode_batch_sys.settrace(_tracecode_case_tracer)

    _tracecode_case_result = None
    try:
        exec(_tracecode_batch_user_code, _tracecode_case_globals)
        if _tracecode_batch_execution_style == 'solution-method':
            solution_type = _tracecode_case_globals.get('Solution')
            if solution_type is None:
                raise NameError('Implement class Solution')
            target = getattr(solution_type(), _tracecode_batch_function_name)
        else:
            target = _tracecode_case_globals.get(_tracecode_batch_function_name)
            if not callable(target):
                solution_type = _tracecode_case_globals.get('Solution')
                target = (
                    getattr(solution_type(), _tracecode_batch_function_name)
                    if solution_type is not None
                    else None
                )
            if not callable(target):
                raise NameError(
                    'Implement ' + _tracecode_batch_function_name + '(...)'
                )
        _tracecode_case_inputs = {
            name: _tracecode_case_globals[name]
            for name in _tracecode_case_input_names
            if name in _tracecode_case_globals
        }
        _tracecode_trusted_prep_active = True
        try:
            _tracecode_batch_hydrate_inputs(
                target,
                _tracecode_case_inputs,
                _tracecode_case_globals,
            )
            (
                _tracecode_call_target,
                _tracecode_call_args,
                _tracecode_call_kwargs,
            ) = _tracecode_batch_prepare_call(target, _tracecode_case_inputs)
        finally:
            _tracecode_trusted_prep_active = False
        output = _tracecode_call_target(
            *_tracecode_call_args,
            **_tracecode_call_kwargs,
        )
        if output is None:
            for _tracecode_inplace_name in (
                'nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid'
            ):
                if (
                    _tracecode_inplace_name in _tracecode_case_input_names
                    and _tracecode_inplace_name in _tracecode_case_globals
                ):
                    output = _tracecode_case_globals[_tracecode_inplace_name]
                    break
        _tracecode_case_result = {
            'success': True,
            'output': _serialize(
                output,
                checkpoint=_tracecode_execute_serialize_checkpoint,
                tree_node_root=TreeNode,
                list_node_root=ListNode,
            ),
            'consoleOutput': _tracecode_case_console,
            'timings': {
                'runMs': (
                    _tracecode_batch_time.perf_counter() - _tracecode_case_started
                ) * 1000,
                'algorithmFastBatch': True,
            },
        }
    except _TracecodeAlgorithmLimit as error:
        _tracecode_case_result = {
            'success': False,
            'output': None,
            'error': 'Execution stopped: resource limit exceeded (' + error.reason + ').',
            'timeoutReason': error.reason,
            'consoleOutput': _tracecode_case_console,
            'timings': {
                'runMs': (
                    _tracecode_batch_time.perf_counter() - _tracecode_case_started
                ) * 1000,
                'algorithmFastBatch': True,
            },
        }
    except _TracecodeSerializationLimit:
        _tracecode_case_result = {
            'success': False,
            'output': None,
            'error': 'Execution stopped: resource limit exceeded (serialization-limit).',
            'timeoutReason': 'serialization-limit',
            'consoleOutput': _tracecode_case_console,
            'timings': {
                'runMs': (
                    _tracecode_batch_time.perf_counter() - _tracecode_case_started
                ) * 1000,
                'algorithmFastBatch': True,
            },
        }
    except BaseException as error:
        (
            error_line,
            error_prefix,
            error_detail,
            formatting_limit_reason,
        ) = _tracecode_batch_format_error(error)
        if error_line is not None:
            error_prefix += ' on line ' + str(error_line)
        _tracecode_case_result = {
            'success': False,
            'output': None,
            'error': (
                error_prefix
                if formatting_limit_reason is not None
                else error_prefix + ': ' + error_detail
            ),
            'consoleOutput': [],
            'timings': {
                'runMs': (
                    _tracecode_batch_time.perf_counter() - _tracecode_case_started
                ) * 1000,
                'algorithmFastBatch': True,
            },
        }
        if error_line is not None:
            _tracecode_case_result['errorLine'] = error_line
        if formatting_limit_reason is not None:
            _tracecode_case_result['timeoutReason'] = formatting_limit_reason
            _tracecode_case_result['consoleOutput'] = _tracecode_case_console
    finally:
        _tracecode_batch_sys.settrace(None)
        if _tracecode_tracemalloc is not None and _tracecode_memory_started:
            try:
                _tracecode_tracemalloc.stop()
            except Exception:
                pass
    _tracecode_batch_append_result(_tracecode_case_result)

_tracecode_batch_re.purge()
_json_out = '[' + ','.join(_tracecode_batch_encoded_results) + ']'
_json_out
`;
}

/**
 * Shared input hydration and entry-call helpers for trace and Judge executors.
 * The namespace expression is deliberately supplied by each caller because
 * tracing uses its isolated globals mapping while Judge may use globals().
 */
function buildPythonExecutionHelpers({
  namespaceExpression,
  annotationLocalsExpression = namespaceExpression,
  inplaceCandidatesLiteral,
  includeMaterializeInput = false,
}) {
  const materializeInputHelper = includeMaterializeInput
    ? `
def _tracecode_materialize_input(obj):
    return _tracecode_materialize_custom_input(obj)
`
    : '';
  return `
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
        _cls = ${namespaceExpression}.get(_type_name) if isinstance(_type_name, _builtins.str) else None
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
        if _name in ${namespaceExpression}:
            ${namespaceExpression}[_name] = _tracecode_materialize_custom_input(${namespaceExpression}[_name])

${materializeInputHelper}
${PYTHON_LITERAL_SHAPE_ANNOTATION_HELPER}

def _tracecode_hydrate_for_annotation(_obj, _annotation):
    try:
        import typing as _tracecode_typing
        import collections.abc as _tracecode_collections_abc
    except Exception:
        return _obj
    if _annotation is None:
        return _obj
    if isinstance(_annotation, _builtins.str):
        _annotation = ${namespaceExpression}.get(_annotation, _annotation)
    if _annotation in (_builtins.object, getattr(_tracecode_typing, 'Any', None)):
        return _obj
    _origin = _tracecode_typing.get_origin(_annotation)
    _args = _tracecode_typing.get_args(_annotation)
    if _origin is _tracecode_typing.Union:
        _non_none = [_arg for _arg in _args if _arg is not type(None)]
        return _tracecode_hydrate_for_annotation(_obj, _non_none[0]) if len(_non_none) == 1 else _obj
    if _origin in (_builtins.list, _builtins.tuple, _builtins.set, _builtins.frozenset):
        if isinstance(_obj, _builtins.list):
            if _origin is _builtins.tuple and len(_args) > 1 and _args[-1] is not Ellipsis:
                _items = [
                    _tracecode_hydrate_for_annotation(
                        _item,
                        _args[_index] if _index < len(_args) else None,
                    )
                    for _index, _item in enumerate(_obj)
                ]
            else:
                _item_annotation = _args[0] if _args else None
                _items = [
                    _tracecode_hydrate_for_annotation(_item, _item_annotation)
                    for _item in _obj
                ]
            if _origin is _builtins.tuple:
                return tuple(_items)
            if _origin is _builtins.set:
                return _builtins.set(_items)
            if _origin is _builtins.frozenset:
                return _builtins.frozenset(_items)
            return _items
        return _obj
    if _origin in (_builtins.dict, _tracecode_collections_abc.Mapping, _tracecode_collections_abc.MutableMapping) and isinstance(_obj, _builtins.dict):
        _key_annotation = _args[0] if len(_args) > 0 else None
        _value_annotation = _args[1] if len(_args) > 1 else None
        return {
            _tracecode_hydrate_for_annotation(_key, _key_annotation): _tracecode_hydrate_for_annotation(_value, _value_annotation)
            for _key, _value in _obj.items()
        }
    if isinstance(_annotation, _builtins.type) and isinstance(_obj, _builtins.dict):
        if _annotation.__name__ in ('TreeNode', 'ListNode'):
            return _obj
        _fields = {key: value for key, value in _obj.items() if key not in ('__type__', '__class__', '__id__')}
        try:
            _ctor_hints = _tracecode_typing.get_type_hints(getattr(_annotation, '__init__'), ${namespaceExpression}, ${annotationLocalsExpression})
        except Exception:
            _ctor_hints = {}
        _hydrated_fields = {
            key: _tracecode_hydrate_for_annotation(value, _ctor_hints.get(key))
            for key, value in _fields.items()
        }
        try:
            return _annotation(**_hydrated_fields)
        except Exception:
            pass
        try:
            return _annotation(*_builtins.list(_hydrated_fields.values()))
        except Exception:
            pass
        try:
            _instance = _annotation.__new__(_annotation)
            for _key, _value in _hydrated_fields.items():
                setattr(_instance, _key, _value)
            return _instance
        except Exception:
            return _obj
    return _obj

def _tracecode_resolve_target_callable(_function_name, _execution_style):
    _namespace = ${namespaceExpression}
    _solution = _namespace.get('Solution')
    if _execution_style == 'solution-method' and _solution is not None and hasattr(_solution, _function_name):
        return getattr(_solution, _function_name)
    if _function_name in _namespace and callable(_namespace[_function_name]):
        return _namespace[_function_name]
    if _solution is not None and hasattr(_solution, _function_name):
        return getattr(_solution, _function_name)
    return None

def _tracecode_hydrate_annotated_inputs(_names, _function_name, _execution_style):
    try:
        import typing as _tracecode_typing
        _callable = _tracecode_resolve_target_callable(_function_name, _execution_style)
        if _callable is None:
            return
        try:
            _annotations = _tracecode_typing.get_type_hints(_callable, ${namespaceExpression}, ${annotationLocalsExpression})
        except Exception:
            _annotations = getattr(_callable, '__annotations__', {}) or {}
        for _name in _names:
            if _name in ${namespaceExpression} and _name in _annotations:
                _annotation = _annotations[_name]
                if not _tracecode_annotation_preserves_literal_shape(_annotation):
                    ${namespaceExpression}[_name] = _tracecode_hydrate_for_annotation(${namespaceExpression}[_name], _annotation)
    except Exception:
        return

def _tracecode_resolve_entry_callable(_function_name, _execution_style):
    _namespace = ${namespaceExpression}
    _solution = _namespace.get('Solution')
    if _execution_style == 'solution-method' and _solution is not None and hasattr(_solution, _function_name):
        _solver = _solution()
        return getattr(_solver, _function_name)
    if _function_name in _namespace and callable(_namespace[_function_name]):
        return _namespace[_function_name]
    if _solution is not None and hasattr(_solution, _function_name):
        _solver = _solution()
        return getattr(_solver, _function_name)
    return None

def _tracecode_invoke_entry(_function_name, _execution_style, _input_names):
    import inspect as _tracecode_inspect
    _callable = _tracecode_resolve_entry_callable(_function_name, _execution_style)
    if _callable is None:
        raise NameError(f"Implement {_function_name}(...) or Solution.{_function_name}(...)")
    _namespace = ${namespaceExpression}
    _values = {_name: _namespace[_name] for _name in _input_names if _name in _namespace}
    _fallback_kwargs = None
    try:
        _signature = _tracecode_inspect.signature(_callable)
    except Exception:
        _fallback_kwargs = _values
        _args = []
        _kwargs = {}
    else:
        _args = []
        _kwargs = {}
        _has_varargs = any(
            _parameter.kind is _tracecode_inspect.Parameter.VAR_POSITIONAL
            for _parameter in _signature.parameters.values()
        )
        for _parameter in _signature.parameters.values():
            if _parameter.name in ('self', 'cls'):
                continue
            _kind = _parameter.kind
            if _kind is _tracecode_inspect.Parameter.VAR_POSITIONAL:
                if _parameter.name in _values:
                    _raw = _values[_parameter.name]
                    if isinstance(_raw, (_builtins.list, _builtins.tuple)):
                        _args.extend(_raw)
                    else:
                        _args.append(_raw)
                continue
            if _kind is _tracecode_inspect.Parameter.VAR_KEYWORD:
                if _parameter.name in _values and isinstance(_values[_parameter.name], _builtins.dict):
                    _kwargs.update(_values[_parameter.name])
                continue
            if _parameter.name not in _values:
                continue
            if _kind is _tracecode_inspect.Parameter.POSITIONAL_ONLY:
                _args.append(_values[_parameter.name])
            elif _kind is _tracecode_inspect.Parameter.POSITIONAL_OR_KEYWORD and _has_varargs:
                _args.append(_values[_parameter.name])
            else:
                _kwargs[_parameter.name] = _values[_parameter.name]
    if _fallback_kwargs is not None:
        return _callable(**_fallback_kwargs)
    return _callable(*_args, **_kwargs)

def _resolve_inplace_result():
    for _name in ${inplaceCandidatesLiteral}:
        if _name in ${namespaceExpression}:
            return ${namespaceExpression}.get(_name)
    return None
`;
}

function generateTracingCode(
  deps,
  userCode,
  functionName,
  inputs,
  executionStyle = 'function',
  options = {},
  prepared = undefined
) {
  const usesPreparedBindings = prepared?.bindings === true;
  const preparedInputPrelude = usesPreparedBindings
    ? `
import ast as _tracecode_input_ast
_tracecode_raw_inputs = _tracecode_input_ast.literal_eval(__tracecode_inputs_literal)
_tracecode_case_limits = _tracecode_input_ast.literal_eval(__tracecode_limits_literal)
`
    : '';
  const inputSetup = usesPreparedBindings
    ? `
for _tracecode_input_name, _tracecode_input_value in _tracecode_raw_inputs.items():
    _globals_dict[str(_tracecode_input_name)] = _tracecode_input_value
`
    : Object.entries(inputs)
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
  const traceProfile = options.traceProfile === true;
  const maxPathDepth = getTraceMaxPathDepth(options.maxPathDepth);
  const maxTraceBytes = getTraceMaxBytes(options.maxTraceBytes);
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
import builtins as _builtins
import typing as _tracecode_typing
from typing import *
${deps.PYTHON_CLASS_DEFINITIONS_SNIPPET}
${preparedInputPrelude}

_TRACECODE_TYPING_GLOBALS = _builtins.set(getattr(_tracecode_typing, '__all__', ()))

_trace_data = []
_trace_events = []
# Native tracer module (loaded late, see the arm site); None = python paths.
_TC_NATIVE = None
_trace_line_event_count = 0
_TRACE_PROFILE = ${traceProfile ? 'True' : 'False'}
from time import perf_counter as _tc_perf
_tp_import_at = _tc_perf()
_tp_tracer = 0.0
_tp_snapshot = 0.0
_tp_stack = 0.0
_tp_step = 0.0
_tp_convert = 0.0

# PEP 669 tracing: sys.monitoring keeps the specializing interpreter, which
# sys.settrace disables for every traced frame (~8x on tight loops). The
# settrace path remains as the fallback for interpreters without monitoring.
_TC_MONITORING = getattr(sys, 'monitoring', None)
_TC_MONITORING_TOOL = 4
_TC_MONITORING_ACTIVE = False
_TC_MONITORING_ERROR = None if _TC_MONITORING is not None else 'sys.monitoring unavailable'
_TC_MONITORING_WAS_ARMED = False

def _tc_monitoring_on_line(code, line_number):
    if code.co_filename != 'solution.py':
        return _TC_MONITORING.DISABLE
    _tracer(sys._getframe(1), 'line', None)

def _tc_monitoring_on_start(code, offset):
    if code.co_filename != 'solution.py':
        return _TC_MONITORING.DISABLE
    _tracer(sys._getframe(1), 'call', None)

def _tc_monitoring_on_return(code, offset, retval):
    if code.co_filename != 'solution.py':
        return _TC_MONITORING.DISABLE
    _tracer(sys._getframe(1), 'return', retval)

def _tc_monitoring_on_raise(code, offset, exc):
    if code.co_filename != 'solution.py':
        return
    _tracer(sys._getframe(1), 'exception', (type(exc), exc, getattr(exc, '__traceback__', None)))

def _tracecode_arm_tracing():
    global _TC_MONITORING_ACTIVE
    # PEP 669 callbacks are optimized for observation and may disable
    # themselves after an exception. A per-case wall clock needs the stronger
    # propagation contract of sys.settrace so the BaseException guard reaches
    # the executor even from a tight learner loop.
    if _TC_MONITORING is not None and _wall_clock_ms <= 0.0:
        try:
            _TC_MONITORING.use_tool_id(_TC_MONITORING_TOOL, 'tracecode')
            _events = _TC_MONITORING.events
            _TC_MONITORING.register_callback(_TC_MONITORING_TOOL, _events.LINE, _tc_monitoring_on_line)
            _TC_MONITORING.register_callback(_TC_MONITORING_TOOL, _events.PY_START, _tc_monitoring_on_start)
            _TC_MONITORING.register_callback(_TC_MONITORING_TOOL, _events.PY_RETURN, _tc_monitoring_on_return)
            _TC_MONITORING.register_callback(_TC_MONITORING_TOOL, _events.RAISE, _tc_monitoring_on_raise)
            _TC_MONITORING.set_events(
                _TC_MONITORING_TOOL,
                _events.LINE | _events.PY_START | _events.PY_RETURN | _events.RAISE,
            )
            _TC_MONITORING_ACTIVE = True
            globals()['_TC_MONITORING_WAS_ARMED'] = True
            return
        except Exception as _tc_monitoring_exc:
            global _TC_MONITORING_ERROR
            _TC_MONITORING_ERROR = repr(_tc_monitoring_exc)
            _TC_MONITORING_ACTIVE = False
    sys.settrace(_tracer)

def _tracecode_stop_tracing():
    global _TC_MONITORING_ACTIVE
    sys.settrace(None)
    if _TC_MONITORING is not None and _TC_MONITORING_ACTIVE:
        _TC_MONITORING_ACTIVE = False
        try:
            _TC_MONITORING.set_events(_TC_MONITORING_TOOL, 0)
            _TC_MONITORING.free_tool_id(_TC_MONITORING_TOOL)
        except Exception:
            pass
_console_output = []
_original_print = _builtins.print
_tracecode_builtin_id = _builtins.id
_target_function = "${targetFunction}"
_MIRROR_PRINT_TO_WORKER_CONSOLE = ${mirrorPrintToConsole ? 'True' : 'False'}
_MINIMAL_TRACE = ${minimalTrace ? 'True' : 'False'}
_TRACE_MAX_PATH_DEPTH = ${maxPathDepth}
_TRACE_MAX_BULK_ACCESSES = 512
_SCRIPT_MODE = ${functionName ? 'False' : 'True'}
_TRACE_INPUT_NAMES = ${
    usesPreparedBindings
      ? '_builtins.set(str(_name) for _name in _tracecode_raw_inputs.keys())'
      : `_builtins.set(${JSON.stringify(Object.keys(inputs))})`
  }

class _InfiniteLoopDetected(BaseException):
    pass

def _custom_print(*args, **kwargs):
    output = " ".join(str(arg) for arg in args)
    _console_output.append(output)
    try:
        _frame = sys._getframe(1)
        _TracecodeTraceHooks.flush_completed_line(_frame)
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
_tracecode_tracemalloc_started = False
_TRACE_MUTATING_METHODS = {'append', 'appendleft', 'pop', 'popleft', 'extend', 'insert', 'add', 'remove', 'discard', 'clear', 'sort', 'reverse'}
_tracecode_user_class_names = _builtins.set()
_tracecode_explicit_return_function_names = _builtins.set()
_internal_funcs = {'_serialize', '_serialize_output', '_tracecode_ref_id', '_tracer', '_custom_print', '_dict_to_tree', '_dict_to_list', '_tracecode_materialize_input', '_tracecode_materialize_custom_input', '_tracecode_materialize_named_inputs', '_tracecode_annotation_preserves_literal_shape', '_tracecode_hydrate_for_annotation', '_tracecode_resolve_target_callable', '_tracecode_hydrate_annotated_inputs', '_tracecode_resolve_entry_callable', '_tracecode_invoke_entry', '_is_structural_constructor_frame', '_snapshot_call_stack', '_snapshot_locals', '_stable_token', '_looks_like_adjacency_list', '_looks_like_indexed_adjacency_list', '_resolve_inplace_result', 'TraceHooks', '_TracecodeTraceHooks', 'flush_completed_line', 'flush_callsite_line', '_resolve_previous_step', '_append_step_runtime_events', '__tracecode_pending_access_budget', '__tracecode_record_access', '__tracecode_flush_accesses', '__tracecode_append_trace_step', '__tracecode_append_trace_events_for_step', '__tracecode_append_runtime_event', '__tracecode_frame_id_for_step', '__tracecode_access_target', '__tracecode_access_binding', '__tracecode_access_kind', '__tracecode_value_at_path', '__tracecode_access_value', '__tracecode_attach_accesses_to_previous_step', '__tracecode_normalize_index_component', '__tracecode_normalize_index_sources', '__tracecode_normalize_indices', '__tracecode_serialize_call_arg', '__tracecode_serialize_call_args', '__tracecode_make_callsite_frame_id', '__tracecode_make_access_event', '__tracecode_make_iteration_access_event', '__tracecode_record_destructured_iteration_accesses', '__tracecode_is_indexable_sequence', '__tracecode_is_mutable_container', '__tracecode_read_value', '__tracecode_write_value', '__tracecode_delete_value', '__tracecode_apply_augmented_value', '__tracecode_apply_inplace_augmented_value', '_tracecode_user_call', '_tracecode_sum', '_tracecode_read_index', '_tracecode_write_index', '_tracecode_record_index_write', '_tracecode_write_scalar', '_tracecode_delete_index', '_tracecode_augassign_scalar', '_tracecode_augassign_index', '_tracecode_mutating_call', '_tracecode_mutating_index_call', '_tracecode_heapq_mutation', '_tracecode_read_attr', '_tracecode_write_attr', '_tracecode_record_attr_write', '_tracecode_contains_key', '_tracecode_contains_key_indexed', '_tracecode_dict_get', '_tracecode_dict_get_indexed', '_tracecode_len', '_tracecode_enumerate', '_tracecode_iter_bind', '_tracecode_iter_bind_literal', '_tracecode_iter_bind_expr', '_tracecode_iter_bind_indexed', '_tracecode_iter_bind_slice', '_tracecode_range_bind', '_tracecode_for_target_binding_name', '_tracecode_scalar_target_names', '_tracecode_assignment_write_targets', '_tracecode_source_string_node', '_tracecode_exception_value', '_tracecode_collect_user_function_names', '_tracecode_collect_user_method_names', '_tracecode_collect_user_class_names', '_tracecode_collect_explicit_return_function_names', '_tracecode_is_pure_literal_scaffold', '_tracecode_collect_collapsed_literal_lines', '__tracecode_attach_parents', '_tracecode_extract_named_subscript', '_tracecode_extract_mutable_container_target', '_tracecode_is_internal_name', '__TracecodeAccessTransformer', '__tracecode_compile_user_code', '<listcomp>', '<dictcomp>', '<setcomp>', '<genexpr>'}
_internal_locals = {
    '_trace_data', '_trace_events', '_trace_line_event_count', '_console_output', '_original_print', '_target_function',
    '_MIRROR_PRINT_TO_WORKER_CONSOLE', '_MINIMAL_TRACE', '_SKIP_SENTINEL',
    '_TRACE_MAX_BULK_ACCESSES',
    '_SCRIPT_MODE', '_TRACE_INPUT_NAMES', '_SCRIPT_PRE_USER_GLOBALS',
    '_tracecode_builtin_id', '_tracecode_operator', '_tracecode_typing',
    '_TRACECODE_TYPING_GLOBALS',
    '_call_stack', '_pending_accesses', '_last_trace_index_by_frame', '_tracecode_tracemalloc', '_tracecode_tracemalloc_started', '_TRACE_MUTATING_METHODS', '_tracecode_user_class_names', '_tracecode_explicit_return_function_names', '_internal_funcs', '_internal_locals', '_max_trace_steps',
    '_trace_limit_exceeded', '_timeout_reason', '_total_line_events', '_max_line_events', '_max_stored_events', '_max_trace_bytes', '_max_trace_event_bytes', '_trace_stored_bytes',
    '_line_hit_count', '_max_single_line_hits', '_max_call_depth', '_max_memory_bytes', '_memory_check_every', '_infinite_loop_line',
    '_hard_line_ceiling', '_hard_line_deadline', '_hard_line_grace_seconds',
    '_MAX_SERIALIZE_DEPTH', '_MAX_SERIALIZED_ITEMS', '_MAX_OBJECT_FIELDS', '_MAX_SERIALIZED_STRING_CHARS', '_serialize_string', '_trace_failed', '_execution_aborted', '_inplace',
    '_custom_print', '_tracer', '_serialize', '_serialize_output', '_tracecode_ref_id', '_dict_to_tree', '_dict_to_list', '_tracecode_materialize_input',
    '_tracecode_materialize_custom_input', '_tracecode_materialize_named_inputs', '_tracecode_annotation_preserves_literal_shape', '_tracecode_hydrate_for_annotation',
    '_tracecode_resolve_target_callable', '_tracecode_hydrate_annotated_inputs', '_tracecode_resolve_entry_callable', '_tracecode_invoke_entry',
    '_is_structural_constructor_frame', '_snapshot_call_stack', '_snapshot_locals', '_stable_token',
    '_looks_like_adjacency_list', '_looks_like_indexed_adjacency_list', '_resolve_inplace_result',
    '_TracecodeTraceHooks',
    '__tracecode_pending_access_budget', '__tracecode_record_access', '__tracecode_flush_accesses', '__tracecode_append_trace_step',
    '__tracecode_append_trace_events_for_step', '__tracecode_frame_id_for_step',
    '__tracecode_access_target', '__tracecode_access_binding', '__tracecode_access_kind', '__tracecode_value_at_path',
    '__tracecode_access_value',
    '__tracecode_attach_accesses_to_previous_step', '__tracecode_normalize_index_component', '__tracecode_normalize_index_sources', '__tracecode_normalize_indices',
    '__tracecode_serialize_call_arg', '__tracecode_serialize_call_args', '__tracecode_make_callsite_frame_id',
    '__tracecode_make_access_event', '__tracecode_make_iteration_access_event', '__tracecode_record_destructured_iteration_accesses',
    '__tracecode_is_indexable_sequence', '__tracecode_is_mutable_container', '__tracecode_read_value', '__tracecode_write_value',
    '__tracecode_delete_value', '__tracecode_apply_augmented_value', '__tracecode_apply_inplace_augmented_value', '_tracecode_read_index', '_tracecode_write_index', '_tracecode_record_index_write', '_tracecode_write_scalar',
    '_tracecode_delete_index', '_tracecode_augassign_scalar', '_tracecode_augassign_index', '_tracecode_user_call', '_tracecode_sum', '_tracecode_mutating_call', '_tracecode_mutating_index_call', '_tracecode_heapq_mutation', '_tracecode_read_attr', '_tracecode_write_attr', '_tracecode_record_attr_write', '_tracecode_contains_key', '_tracecode_contains_key_indexed', '_tracecode_dict_get', '_tracecode_dict_get_indexed', '_tracecode_enumerate', '_tracecode_iter_bind', '_tracecode_iter_bind_literal', '_tracecode_iter_bind_expr', '_tracecode_iter_bind_indexed', '_tracecode_iter_bind_slice', '_tracecode_range_bind', '_tracecode_for_target_binding_name', '_tracecode_scalar_target_names', '_tracecode_assignment_write_targets', '_tracecode_source_string_node', '_tracecode_exception_value', '_tracecode_collapsed_literal_lines',
    '_tracecode_collect_user_function_names', '_tracecode_collect_user_class_names', '_tracecode_collect_explicit_return_function_names', '_tracecode_is_pure_literal_scaffold', '_tracecode_collect_collapsed_literal_lines', '__tracecode_attach_parents',
    '_tracecode_extract_named_subscript', '_tracecode_extract_mutable_container_target', '_tracecode_is_internal_name', '__TracecodeAccessTransformer', '__tracecode_compile_user_code',
    '_InfiniteLoopDetected', '_tb', '_result', '_exc_type', '_exc_msg', '_exc_tb',
    '_error_line', '_solver', '_ops', '_args', '_cls', '_instance', '_out',
    '_i', '_op', '_call_args', '_method', '_user_code_str', '_textwrap',
    '_globals_dict', '_k', '_preserve', '_real_globals', '_real_list',
    '__tracecode_tree', '__tracecode_compiled'
}
_max_trace_steps = ${effectiveMaxTraceSteps}
_max_stored_events = ${maxStoredEvents}
_max_trace_bytes = ${maxTraceBytes}
_max_trace_event_bytes = min(256 * 1024, _max_trace_bytes)
_trace_stored_bytes = 256
_trace_limit_exceeded = False
_timeout_reason = None
_wall_clock_ms = ${
    usesPreparedBindings
      ? `(max(1.0, float(_tracecode_case_limits.get('wallClockMs', 0))) if _tracecode_case_limits.get('wallClockMs') is not None else 0.0)`
      : Math.max(0, options.wallClockMs ?? 0)
  }
_case_deadline = 0.0
_total_line_events = 0
_max_line_events = ${
    usesPreparedBindings
      ? `int(_tracecode_case_limits.get('maxLineEvents', ${maxLineEvents}))`
      : maxLineEvents
  }
_line_hit_count = {}
_max_single_line_hits = ${
    usesPreparedBindings
      ? `int(_tracecode_case_limits.get('maxSingleLineHits', ${maxSingleLineHits}))`
      : maxSingleLineHits
  }
_max_call_depth = ${
    usesPreparedBindings
      ? `(max(100, int(_tracecode_case_limits.get('maxCallDepth', 100))) if 'maxCallDepth' in _tracecode_case_limits else 0)`
      : 0
  }
_max_memory_bytes = ${
    usesPreparedBindings
      ? `(max(8 * 1024 * 1024, int(_tracecode_case_limits.get('maxMemoryBytes', 8 * 1024 * 1024))) if 'maxMemoryBytes' in _tracecode_case_limits else 0)`
      : 0
  }
_memory_check_every = 10
# Trace-budget exhaustion is NOT an execution error: once the budget trips the
# tracer stops recording but the program keeps running so the verdict is still
# produced (C++/Java/C# already behave this way). These separate, much larger
# ceilings remain fatal so a genuine infinite loop is still caught.
_hard_line_ceiling = max(_max_line_events, _max_single_line_hits) * 50
# Armed lazily on the first budget trip, not here: this preamble can run well
# before (and once for many cases of) the traced execution, so an absolute
# deadline set now could already be expired by the time user code trips.
_hard_line_deadline = 0.0
_hard_line_grace_seconds = 10.0
_infinite_loop_line = -1

try:
    import tracemalloc as _tracecode_tracemalloc
except Exception:
    _tracecode_tracemalloc = None

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

# Call-stack frames are frozen at call time (function/args/line never mutate)
# and the stack only changes at call/return transitions, so both the copied
# list and its encoded json are cacheable per generation.
_call_stack_generation = 0
_tc_stack_cache_generation = -1
_tc_stack_cache_copy = []
_tc_stack_cache_json = None
_tc_stack_cache_frame_id_json = None

def _snapshot_call_stack():
    global _tc_stack_cache_generation, _tc_stack_cache_copy, _tc_stack_cache_json, _tc_stack_cache_frame_id_json
    if _MINIMAL_TRACE:
        return []
    if _tc_stack_cache_generation != _call_stack_generation:
        _tc_stack_cache_copy = [f.copy() for f in _call_stack]
        _tc_stack_cache_json = None
        _tc_stack_cache_frame_id_json = None
        _tc_stack_cache_generation = _call_stack_generation
    return _tc_stack_cache_copy

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
        node_ids = _builtins.set()
    if ref_ids is None:
        ref_ids = _builtins.set()
    if seen is None:
        seen = _builtins.set()

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
        seen = _builtins.set()
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
        seen_root_ids = _builtins.set()

    if _is_serialized_ref(value):
        ref_id = value.get('__ref__')
        if not isinstance(ref_id, _builtins.str):
            return value
        target = root_payloads.get(ref_id)
        if target is None or ref_id in seen_root_ids:
            return value
        next_seen = _builtins.set(seen_root_ids)
        next_seen.add(ref_id)
        return _inline_component_list_refs(_clone_serialized_value(target), root_payloads, next_seen)

    if isinstance(value, _builtins.list):
        return [_inline_component_list_refs(item, root_payloads, seen_root_ids) for item in value]

    if not isinstance(value, _builtins.dict):
        return value

    out = {}
    next_seen = _builtins.set(seen_root_ids)
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
        all_ids = _builtins.set(node_ids) | _builtins.set(ref_ids)
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
                _builtins.set([canonical.get('root_id')]) if isinstance(canonical.get('root_id'), _builtins.str) else _builtins.set(),
            )

        for candidate in group:
            if candidate is canonical:
                continue
            root_id = candidate.get('root_id')
            if isinstance(root_id, _builtins.str):
                local_vars[candidate['name']] = {'__ref__': root_id}

    return local_vars

_SCRIPT_PRE_USER_GLOBALS = _builtins.set()

def _tracecode_is_internal_name(name, _cache={}):
    # Pure function of an (interned) name, called twice per local per line;
    # memoized because the startswith/contains chain dominates at volume.
    cached = _cache.get(name)
    if cached is None:
        cached = _builtins.bool(
            name in _internal_locals
            or name == '_'
            or name.startswith('__')
            or (
                isinstance(name, _builtins.str)
                and name.startswith('_')
                and ('__tracecode' in name or '__Tracecode' in name)
            )
        )
        if len(_cache) < 4096:
            _cache[name] = cached
    return cached

# Reusable encoder: json.dumps with non-default separators builds a fresh C
# encoder on every call, which is measurable at hundreds of thousands of
# events per trace.
_TC_JSON_ENCODER = json.JSONEncoder(ensure_ascii=False, separators=(',', ':'))

# --- per-object snapshot representation cache (flat builtin lists only) ---
# Line snapshots re-serialize every local on every line; for the hot pattern
# (a large flat list mutated one cell per line) that walk is redundant. The
# mutation hooks below keep cached representations in sync copy-on-write, so
# reuse is byte-exact. Safety: exact-type builtin list, scalar-only emitted
# elements, length match, an O(1) first-element spot check on every reuse, a
# full re-serialize comparison every 64th reuse, and conservative invalidation
# of any object passed to an untraced call. Any mismatch permanently disables
# the cache for the run. Entries hold strong references, so a cached id cannot
# be recycled by the allocator while the entry is alive.
_TC_REP_SCALARS = (_builtins.int, _builtins.float, _builtins.str, _builtins.type(None))
_TC_REP_CACHE_MAX = 2048
_tc_rep_cache = {}
_tc_rep_cache_enabled = True
_tc_rep_reuse_count = 0

def _tc_rep_invalidate(obj):
    if _tc_rep_cache:
        _tc_rep_cache.pop(_tracecode_builtin_id(obj), None)

def _tc_rep_invalidate_args(args, kwargs=None):
    if not _tc_rep_cache:
        return
    for value in args:
        _tc_rep_cache.pop(_tracecode_builtin_id(value), None)
    if kwargs:
        for value in kwargs.values():
            _tc_rep_cache.pop(_tracecode_builtin_id(value), None)

def _tc_rep_scalar_rep(value):
    if isinstance(value, _builtins.str):
        return _serialize_string(value)
    if isinstance(value, _builtins.float) and not math.isfinite(value):
        if math.isnan(value):
            return "NaN"
        return "Infinity" if value > 0 else "-Infinity"
    return value

def _tc_rep_patch_write(container, indices, value):
    # The element write has already been applied to the container; mirror it
    # onto the cached representation when provably equivalent, else drop it.
    entry = _tc_rep_cache.get(_tracecode_builtin_id(container))
    if entry is None:
        return
    if (
        len(indices) == 1
        and isinstance(indices[0], _builtins.int)
        and not isinstance(indices[0], _builtins.bool)
        and isinstance(value, _TC_REP_SCALARS + (_builtins.bool,))
        and entry[0] is container
        and entry[2] == len(container)
    ):
        index = indices[0]
        if index < 0:
            index += entry[2]
        if 0 <= index < entry[1]:
            patched = _builtins.list(entry[3])
            patched[index] = _tc_rep_scalar_rep(value)
            entry[3] = patched
            return
        if entry[1] <= index < entry[2]:
            # Beyond the emitted window: the truncation marker's remaining
            # count depends only on total length, which did not change.
            return
    _tc_rep_cache.pop(_tracecode_builtin_id(container), None)

def _tc_serialize_local(value, node_refs):
    global _tc_rep_cache_enabled, _tc_rep_reuse_count
    if not _tc_rep_cache_enabled or type(value) is not _builtins.list:
        return _serialize(value, 0, node_refs)
    vid = _tracecode_builtin_id(value)
    entry = _tc_rep_cache.get(vid)
    if entry is not None and entry[0] is value and entry[2] == len(value):
        rep = entry[3]
        fresh_first = _tc_rep_scalar_rep(value[0]) if entry[1] > 0 else None
        first_ok = entry[1] == 0 or (
            isinstance(value[0], _TC_REP_SCALARS + (_builtins.bool,)) and rep[0] == fresh_first
        )
        _tc_rep_reuse_count += 1
        if first_ok and (_tc_rep_reuse_count & 63) != 0:
            return rep
        fresh = _serialize(value, 0, {})
        if first_ok and fresh == rep:
            return rep
        _tc_rep_cache_enabled = False
        _tc_rep_cache.clear()
        return fresh
    rep = _serialize(value, 0, node_refs)
    if (
        type(rep) is _builtins.list
        and len(_tc_rep_cache) < _TC_REP_CACHE_MAX
    ):
        emitted = min(len(value), _MAX_SERIALIZED_ITEMS)
        flat = True
        for item in rep[:emitted]:
            if not isinstance(item, _TC_REP_SCALARS + (_builtins.bool,)):
                flat = False
                break
        if flat:
            _tc_rep_cache[vid] = [value, emitted, len(value), rep]
    return rep

def _snapshot_local_sources(frame):
    if _MINIMAL_TRACE:
        return {}
    try:
        func_name = frame.f_code.co_name
        if func_name != '<module>':
            # Everything is 'user' outside module frames; skip the
            # per-name branching on the hot path.
            return {
                name: 'user'
                for name in frame.f_locals.keys()
                if not _tracecode_is_internal_name(name)
            }
        sources = {}
        for name in frame.f_locals.keys():
            if _tracecode_is_internal_name(name):
                continue
            if name in _TRACE_INPUT_NAMES:
                sources[name] = 'user-input'
            elif name in _SCRIPT_PRE_USER_GLOBALS:
                sources[name] = 'harness-prelude'
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
        # frame.f_locals materializes a fresh dict on every access; take it
        # once and classify names inline instead of via a sources pre-pass.
        f_locals = frame.f_locals
        script_module = frame.f_code.co_name == '<module>'
        local_vars = {}
        for k, v in f_locals.items():
            if _tracecode_is_internal_name(k):
                continue
            if script_module and k in _SCRIPT_PRE_USER_GLOBALS and k not in _TRACE_INPUT_NAMES:
                continue
            tv = type(v)
            # Inline scalar fast path: most locals are small ints/strs and the
            # full serializer dispatch dominates at per-line volume.
            if tv is _builtins.int or tv is _builtins.bool or v is None:
                local_vars[k] = v
                continue
            if tv is _builtins.str:
                local_vars[k] = v if len(v) <= _MAX_SERIALIZED_STRING_CHARS else _serialize_string(v)
                continue
            if tv is _builtins.float and math.isfinite(v):
                local_vars[k] = v
                continue
            rep = _tc_serialize_local(v, _node_refs)
            if rep != _SKIP_SENTINEL:
                local_vars[k] = rep
        local_vars = _normalize_top_level_linked_list_locals(local_vars)
        local_vars = _materialize_top_level_custom_object_aliases(local_vars)
        if not with_sources:
            return local_vars
        if script_module:
            local_sources = {
                name: 'user-input' if name in _TRACE_INPUT_NAMES else 'user'
                for name in local_vars.keys()
            }
        else:
            local_sources = {name: 'user' for name in local_vars.keys()}
        return (local_vars, local_sources)
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
            if isinstance(part, _builtins.str):
                try:
                    current = getattr(current, part)
                    continue
                except Exception:
                    pass
            return None
    return current

def __tracecode_access_value(step, access):
    if isinstance(access, _builtins.dict) and 'value' in access:
        return access.get('value')
    variables = step.get('variables') if isinstance(step, _builtins.dict) else {}
    root = variables.get(access.get('variable')) if isinstance(variables, _builtins.dict) else None
    return __tracecode_value_at_path(root, access.get('indices'))

def _tc_native_sync_limit():
    # Mirror a native-side budget trip onto the python flags.
    global _trace_limit_exceeded, _timeout_reason
    if not _trace_limit_exceeded:
        _trace_limit_exceeded = True
        reason = _TC_NATIVE.counters().get('timeoutReason') if _TC_NATIVE is not None else ''
        _timeout_reason = reason or 'trace-limit'
    _pending_accesses.clear()

def __tracecode_append_runtime_event(event):
    # Single-writer: this serialization IS the stored representation. The
    # event dict is not retained, so later frame mutation cannot leak into
    # already-recorded events and the final export embeds these strings
    # without re-serializing the whole trace.
    global _trace_limit_exceeded, _timeout_reason, _trace_stored_bytes, _trace_line_event_count
    if _TC_NATIVE is not None:
        try:
            event_json = _TC_JSON_ENCODER.encode(event)
        except Exception:
            _TC_NATIVE.mark_limit_exceeded('trace-byte-limit')
            _tc_native_sync_limit()
            return False
        if _TC_NATIVE.append_event_json(event_json, event.get('kind') == 'line'):
            return True
        _tc_native_sync_limit()
        return False
    if len(_trace_events) >= _max_stored_events:
        if not _trace_limit_exceeded:
            _trace_limit_exceeded = True
            _timeout_reason = 'trace-limit'
        _pending_accesses.clear()
        return False
    try:
        event_json = _TC_JSON_ENCODER.encode(event)
        # ASCII json needs no encode pass to know its byte length; non-ASCII
        # payloads (rare) fall back to a real utf-8 encode.
        event_bytes = (
            len(event_json) if event_json.isascii() else len(event_json.encode('utf-8'))
        ) + (1 if len(_trace_events) > 0 else 0)
    except Exception:
        event_json = None
        event_bytes = _max_trace_bytes + 1
    if (
        event_json is None or
        event_bytes > _max_trace_event_bytes or
        event_bytes > (_max_trace_bytes - _trace_stored_bytes)
    ):
        if not _trace_limit_exceeded:
            _trace_limit_exceeded = True
            _timeout_reason = 'trace-byte-limit'
        _pending_accesses.clear()
        return False
    _trace_events.append(event_json)
    if event.get('kind') == 'line':
        _trace_line_event_count += 1
    _trace_stored_bytes += event_bytes
    return True

def __tracecode_append_runtime_event_json(event_json):
    # Raw-string twin of __tracecode_append_runtime_event for callers that
    # assemble the json by fragment splicing (never 'line' events).
    global _trace_limit_exceeded, _timeout_reason, _trace_stored_bytes
    if _TC_NATIVE is not None:
        if _TC_NATIVE.append_event_json(event_json, False):
            return True
        _tc_native_sync_limit()
        return False
    if len(_trace_events) >= _max_stored_events:
        if not _trace_limit_exceeded:
            _trace_limit_exceeded = True
            _timeout_reason = 'trace-limit'
        _pending_accesses.clear()
        return False
    event_bytes = (
        len(event_json) if event_json.isascii() else len(event_json.encode('utf-8'))
    ) + (1 if len(_trace_events) > 0 else 0)
    if event_bytes > _max_trace_event_bytes or event_bytes > (_max_trace_bytes - _trace_stored_bytes):
        if not _trace_limit_exceeded:
            _trace_limit_exceeded = True
            _timeout_reason = 'trace-byte-limit'
        _pending_accesses.clear()
        return False
    _trace_events.append(event_json)
    _trace_stored_bytes += event_bytes
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
        # No copy: the event serializes immediately on append, which freezes
        # the current frame state without cloning it per event.
        base['callStack'] = stack
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

    # Fragment splicing: every event of this step shares the base fields
    # (including the call stack, the bulk of the bytes); encode them once and
    # append per-event suffixes. Composition is byte-identical to encoding the
    # merged dict because dict merge preserves insertion order.
    #
    # The call-stack fragment is the bulk of those bytes and only changes at
    # call/return transitions, so it is cached per stack-snapshot object (the
    # generation cache hands out the SAME list object until the stack moves —
    # an identity check is therefore exact, never stale).
    base_prefix = None
    try:
        if len(stack) > 0:
            global _tc_stack_cache_json
            if stack is _tc_stack_cache_copy and _tc_stack_cache_json is not None:
                stack_json = _tc_stack_cache_json
            else:
                stack_json = _TC_JSON_ENCODER.encode(stack)
                if stack is _tc_stack_cache_copy:
                    _tc_stack_cache_json = stack_json
            base_prefix = (
                '{"runId":"python:run","line":' + _TC_JSON_ENCODER.encode(line)
                + ',"frameId":' + _TC_JSON_ENCODER.encode(base['frameId'])
                + ',"callStack":' + stack_json
            )
        else:
            base_prefix = _TC_JSON_ENCODER.encode(base)[:-1]
    except Exception:
        base_prefix = None

    native_locals = step.pop('__native_frame_locals', None)
    if native_locals is not None and event_kind != '__access_only__':
        if _TC_NATIVE is not None and base_prefix is not None:
            reps = _TC_NATIVE.emit_snapshot_events(native_locals, base_prefix)
            step['variables'] = reps
            step['variableSources'] = {name: 'user' for name in reps}
            if _TC_NATIVE.counters()['limitExceeded'] and not _trace_limit_exceeded:
                _tc_native_sync_limit()
                return
        else:
            # Rare fallback (encode error or native lost mid-run): rebuild the
            # reps in python from the staged locals so step consumers and the
            # event stream stay correct.
            _node_refs = {}
            reps = {}
            for k, v in native_locals.items():
                if _tracecode_is_internal_name(k):
                    continue
                rep = _tc_serialize_local(v, _node_refs)
                if rep != _SKIP_SENTINEL:
                    reps[k] = rep
            step['variables'] = reps
            step['variableSources'] = {name: 'user' for name in reps}
            for variable, value in reps.items():
                if not __tracecode_append_runtime_event({**base, 'kind': 'snapshot', 'target': {'variable': variable}, 'value': value}):
                    return

    variables = step.get('variables')
    if native_locals is None and event_kind != '__access_only__' and isinstance(variables, _builtins.dict):
        for variable, value in variables.items():
            if base_prefix is not None:
                try:
                    appended = __tracecode_append_runtime_event_json(
                        base_prefix
                        + ',"kind":"snapshot","target":{"variable":'
                        + _TC_JSON_ENCODER.encode(variable)
                        + '},"value":'
                        + _TC_JSON_ENCODER.encode(value)
                        + '}'
                    )
                except Exception:
                    appended = __tracecode_append_runtime_event({**base, 'kind': 'snapshot', 'target': {'variable': variable}, 'value': value})
            else:
                appended = __tracecode_append_runtime_event({**base, 'kind': 'snapshot', 'target': {'variable': variable}, 'value': value})
            if not appended:
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
                value = __tracecode_access_value(step, access)
                binding = __tracecode_access_binding(access)
                appended = False
                if base_prefix is not None and binding is None:
                    try:
                        appended = __tracecode_append_runtime_event_json(
                            base_prefix
                            + ',"kind":"'
                            + kind
                            + '","target":'
                            + _TC_JSON_ENCODER.encode(target)
                            + ',"value":'
                            + _TC_JSON_ENCODER.encode(value)
                            + '}'
                        )
                    except Exception:
                        appended = __tracecode_append_runtime_event({**base, 'kind': kind, 'target': target, 'value': value})
                else:
                    event = {**base, 'kind': kind, 'target': target, 'value': value}
                    if binding is not None:
                        event['binding'] = binding
                    appended = __tracecode_append_runtime_event(event)
                if not appended:
                    return

def __tracecode_resolve_previous_step(frame):
    if frame is None:
        return None
    previous_index = _last_trace_index_by_frame.get(_tracecode_builtin_id(frame))
    if previous_index is None or previous_index < 0 or previous_index >= len(_trace_data):
        return None
    previous_step = _trace_data[previous_index]
    return previous_step if isinstance(previous_step, _builtins.dict) else None

def __tracecode_append_step_runtime_events(step):
    if step.get('__runtime_flushed'):
        return
    step['__runtime_flushed'] = True
    globals()['__tracecode_append_trace_events_for_step'](step)

def _tc_native_stage_snapshot(step, frame):
    # Defer the locals walk + serialization to the native emitter at convert
    # time (which has the base-prefix). The locals dict must be materialized
    # HERE: convert runs synchronously within this flush, but the dict pin
    # freezes the binding set at flush time exactly like the python walk did.
    if _TC_NATIVE is None or _MINIMAL_TRACE:
        return False
    if _SCRIPT_MODE and frame.f_code.co_name == '<module>':
        return False
    step['__native_frame_locals'] = dict(frame.f_locals)
    step['variables'] = {}
    step['variableSources'] = {}
    return True

def __tracecode_flush_completed_line(frame,
    _resolve_previous_step=__tracecode_resolve_previous_step,
    _append_step_runtime_events=__tracecode_append_step_runtime_events,
):
    previous_step = _resolve_previous_step(frame)
    if previous_step is None:
        return
    if previous_step.get('event') != 'line':
        globals()['__tracecode_attach_accesses_to_previous_step'](frame)
        return
    if previous_step.get('__runtime_flushed'):
        globals()['__tracecode_attach_accesses_to_previous_step'](frame)
        return
    if not _tc_native_stage_snapshot(previous_step, frame):
        local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
        previous_step['variables'] = local_vars
        previous_step['variableSources'] = local_sources
    accesses = globals()['__tracecode_flush_accesses'](frame)
    previous_step['accesses'] = accesses
    previous_step['callStack'] = _snapshot_call_stack()
    previous_step['stdoutLineCount'] = len(_console_output)
    _append_step_runtime_events(previous_step)

def __tracecode_flush_callsite_line(frame, line_number,
    _resolve_previous_step=__tracecode_resolve_previous_step,
    _append_step_runtime_events=__tracecode_append_step_runtime_events,
):
    previous_step = _resolve_previous_step(frame)
    if previous_step is None:
        return
    if previous_step.get('event') != 'line':
        return
    if previous_step.get('line') != line_number:
        return
    accesses = globals()['__tracecode_flush_accesses'](frame)
    if previous_step.get('__runtime_flushed'):
        callsite_step = {
            'line': line_number,
            'event': 'line',
            'variables': {},
            'variableSources': {},
            'function': frame.f_code.co_name,
            'callStack': _snapshot_call_stack(),
            'stdoutLineCount': len(_console_output),
            'accesses': accesses,
        }
        if not _tc_native_stage_snapshot(callsite_step, frame):
            local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
            callsite_step['variables'] = local_vars
            callsite_step['variableSources'] = local_sources
        globals()['__tracecode_append_trace_step'](frame, callsite_step)
        _append_step_runtime_events(callsite_step)
        return
    if not _tc_native_stage_snapshot(previous_step, frame):
        local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
        previous_step['variables'] = local_vars
        previous_step['variableSources'] = local_sources
    previous_step['accesses'] = accesses
    previous_step['callStack'] = _snapshot_call_stack()
    previous_step['stdoutLineCount'] = len(_console_output)
    _append_step_runtime_events(previous_step)

_tracecode_trusted_resolve_previous_step = __tracecode_resolve_previous_step
_tracecode_trusted_append_step_runtime_events = __tracecode_append_step_runtime_events
_tracecode_trusted_flush_completed_line = __tracecode_flush_completed_line
_tracecode_trusted_flush_callsite_line = __tracecode_flush_callsite_line

class _TracecodeTraceHooks:
    """
    Compatibility facade for callers that inspect TraceHooks. Runtime tracing
    uses default-bound function references so user code cannot replace these
    attributes and affect trace control flow.
    """
    _resolve_previous_step = staticmethod(_tracecode_trusted_resolve_previous_step)
    _append_step_runtime_events = staticmethod(_tracecode_trusted_append_step_runtime_events)
    flush_completed_line = staticmethod(_tracecode_trusted_flush_completed_line)
    flush_callsite_line = staticmethod(_tracecode_trusted_flush_callsite_line)

TraceHooks = _TracecodeTraceHooks

def _custom_print(*args, _tracecode_flush_completed_line=__tracecode_flush_completed_line, **kwargs):
    output = " ".join(str(arg) for arg in args)
    _console_output.append(output)
    try:
        _frame = sys._getframe(1)
        _tracecode_flush_completed_line(_frame)
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
    if _MIRROR_PRINT_TO_WORKER_CONSOLE:
        _original_print(*args, **kwargs)

def __tracecode_pending_access_budget(frame, reserve=0):
    if _trace_limit_exceeded or frame is None:
        return 0
    try:
        frame_key = _tracecode_builtin_id(frame)
        pending_count = len(_pending_accesses.get(frame_key, []))
        stored_events = _TC_NATIVE.stored_event_count() if _TC_NATIVE is not None else len(_trace_events)
        remaining_events = _max_stored_events - stored_events - pending_count - int(reserve)
        return max(0, min(_TRACE_MAX_BULK_ACCESSES, remaining_events))
    except Exception:
        return 0

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

def _tracecode_user_call(line_number, function_name, func, *args, _tracecode_flush_callsite_line=__tracecode_flush_callsite_line, **kwargs):
    _tracecode_flush_callsite_line(sys._getframe(1), line_number)
    # The callee may mutate argument containers through paths the rewriter
    # does not instrument (builtins like random.shuffle); drop their reps.
    _tc_rep_invalidate_args(args, kwargs)
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

def __tracecode_is_mutable_container(value):
    if _builtins.isinstance(value, (_builtins.list, _builtins.dict, _builtins.set, _builtins.bytearray)):
        return True
    value_class = _builtins.getattr(value, '__class__', None)
    class_module = _builtins.getattr(value_class, '__module__', '')
    class_name = _builtins.getattr(value_class, '__name__', '')
    return (
        (class_module in {'collections', '_collections'} and class_name == 'deque') or
        (class_module == 'array' and class_name == 'array')
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
        _tc_rep_patch_write(container, indices, value)
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
    _tc_rep_invalidate(container)
    _tc_rep_invalidate(parent)
    return value

def __tracecode_delete_value(container, indices):
    _tc_rep_invalidate(container)
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
    # Post-budget fast path: recording would be discarded, so only the
    # semantic read remains (mirrors the C++ admissibility pre-checks).
    if _trace_limit_exceeded:
        return __tracecode_read_value(container, list(indices))
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
    if _trace_limit_exceeded:
        return __tracecode_write_value(container, list(indices), value)
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

def _tracecode_record_index_write(var_name, container, indices, index_sources):
    effective_indices = list(indices)
    try:
        result = __tracecode_read_value(container, effective_indices)
    except Exception:
        result = None
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
    _tc_rep_invalidate(current)
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
    if _trace_limit_exceeded:
        _fast_indices = list(indices)
        _fast_next = __tracecode_apply_augmented_value(
            __tracecode_read_value(container, _fast_indices), op_name, rhs)
        __tracecode_write_value(container, _fast_indices, _fast_next)
        return _fast_next
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
    frame = sys._getframe(1)
    _tc_rep_invalidate(container)
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
    if method_name in _TRACE_MUTATING_METHODS and __tracecode_is_mutable_container(container):
        if (
            len(args) >= 1 and
            method_name in {'pop', 'remove', 'discard'} and
            isinstance(container, (_builtins.dict, _builtins.set))
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
                    budget = __tracecode_pending_access_budget(frame)
                    for offset, value in enumerate(args[0]):
                        if offset >= budget:
                            break
                        __tracecode_record_access(
                            frame,
                            __tracecode_make_access_event(var_name, 'indexed-write', [before_len + offset], value=_serialize(value)),
                        )
                except Exception:
                    pass
        elif method_name in {'sort', 'reverse'} and isinstance(container, _builtins.list):
            try:
                budget = __tracecode_pending_access_budget(frame)
                for index, value in enumerate(container):
                    if index >= budget:
                        break
                    __tracecode_record_access(
                        frame,
                        __tracecode_make_access_event(var_name, 'indexed-write', [index], value=_serialize(value)),
                    )
            except Exception:
                pass
    return result

def _tracecode_mutating_index_call(var_name, container, indices, index_sources, method_name, *args, **kwargs):
    frame = sys._getframe(1)
    _tc_rep_invalidate(container)
    effective_indices = list(indices)
    target = __tracecode_read_value(container, effective_indices)
    _tc_rep_invalidate(target)
    before_len = None
    try:
        if method_name in {'append', 'appendleft', 'extend', 'extendleft', 'insert'}:
            before_len = len(target)
    except Exception:
        before_len = None
    result = getattr(target, method_name)(*args, **kwargs)
    normalized = __tracecode_normalize_indices(effective_indices)
    if method_name in _TRACE_MUTATING_METHODS and __tracecode_is_mutable_container(target):
        if normalized is None:
            return result
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
                    budget = __tracecode_pending_access_budget(frame)
                    for offset, value in enumerate(args[0]):
                        if offset >= budget:
                            break
                        __tracecode_record_access(
                            frame,
                            __tracecode_make_access_event(var_name, 'indexed-write', list(normalized) + [before_len + offset], index_sources=list(index_sources or []) + [None], value=_serialize(value)),
                        )
                except Exception:
                    pass
        elif normalized is not None and method_name in {'sort', 'reverse'} and isinstance(target, _builtins.list):
            try:
                budget = __tracecode_pending_access_budget(frame)
                for index, value in enumerate(target):
                    if index >= budget:
                        break
                    __tracecode_record_access(
                        frame,
                        __tracecode_make_access_event(var_name, 'indexed-write', list(normalized) + [index], index_sources=list(index_sources or []) + [None], value=_serialize(value)),
                    )
            except Exception:
                pass
    return result

def _tracecode_heapq_mutation(heapq_func, var_name, target, indices, method_name, *args, **kwargs):
    frame = sys._getframe(1)
    _tc_rep_invalidate(target)
    effective_indices = list(indices or [])
    normalized = __tracecode_normalize_indices(effective_indices)
    invalid_nested_path = len(effective_indices) > 0 and normalized is None
    try:
        snapshot_budget = __tracecode_pending_access_budget(frame, reserve=2)
        before_values = list(target[:snapshot_budget]) if isinstance(target, _builtins.list) and snapshot_budget > 0 else None
    except Exception:
        before_values = None
    if not invalid_nested_path:
        __tracecode_record_access(
            sys._getframe(1),
            __tracecode_make_access_event(
                var_name,
                'indexed-read',
                normalized,
                value=_serialize(target),
            ),
        )
    result = heapq_func(target, *args, **kwargs)
    if invalid_nested_path:
        return result
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
        after_limit = max(len(before_values), min(len(target), __tracecode_pending_access_budget(frame))) if before_values is not None else 0
        after_values = list(target[:after_limit]) if before_values is not None else None
        if after_values is not None:
            path_prefix = list(normalized or [])
            source_prefix = [None for _ in path_prefix]
            if method_name == 'heappush' and len(args) >= 1:
                pushed_value = args[0]
                pushed_index = None
                for index, value in enumerate(after_values):
                    if value == pushed_value and (index >= len(before_values) or before_values[index] != value):
                        pushed_index = index
                        break
                if pushed_index is None:
                    for index, value in enumerate(after_values):
                        if value == pushed_value:
                            pushed_index = index
                            break
                if pushed_index is not None:
                    __tracecode_record_access(
                        sys._getframe(1),
                        __tracecode_make_access_event(
                            var_name,
                            'indexed-write',
                            path_prefix + [pushed_index],
                            index_sources=source_prefix + [None],
                            value=_serialize(pushed_value),
                        ),
                    )
                return result
            if method_name == 'heappop':
                return result
            budget = __tracecode_pending_access_budget(frame)
            for index, value in enumerate(after_values):
                if index >= budget:
                    break
                if index >= len(before_values) or before_values[index] != value:
                    __tracecode_record_access(
                        frame,
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
            budget = __tracecode_pending_access_budget(frame, reserve=1)
            total_length = None
            try:
                total_length = len(iterable)
            except Exception:
                pass
            if budget > 0:
                for index, value in enumerate(iterable):
                    if index >= budget:
                        break
                    __tracecode_record_access(
                        frame,
                        __tracecode_make_access_event(var_name, 'indexed-read', [index], value=_serialize(value)),
                    )
            if isinstance(total_length, int) and total_length > budget:
                __tracecode_record_access(
                    frame,
                    __tracecode_make_access_event(
                        var_name,
                        'indexed-read',
                        ['<truncated>'],
                        value=f'{total_length - budget} additional values',
                    ),
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

def _tracecode_record_attr_write(var_name, obj, attr_name):
    try:
        value = getattr(obj, attr_name)
    except Exception:
        value = None
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

def _tracecode_assignment_write_targets(target):
    if isinstance(target, (ast.Tuple, ast.List)):
        write_targets = []
        for element in target.elts:
            write_targets.extend(_tracecode_assignment_write_targets(element))
        return write_targets
    if _tracecode_extract_named_subscript(target) is not None:
        return [('index', target)]
    if _tracecode_extract_named_attribute(target) is not None:
        return [('attr', target)]
    return []

def _tracecode_exception_value(line_number, error, _tracecode_flush_completed_line=__tracecode_flush_completed_line):
    frame = sys._getframe(1)
    _tracecode_flush_completed_line(frame)
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
    while len(indices) < _TRACE_MAX_PATH_DEPTH:
        if isinstance(current, ast.Subscript):
            indices.insert(0, current.slice)
            current = current.value
            continue
        if isinstance(current, ast.Attribute):
            indices.insert(0, ast.Constant(value=current.attr))
            current = current.value
            continue
        break
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

def _tracecode_check_deadline():
    global _timeout_reason
    if _case_deadline > 0.0 and _tc_perf() >= _case_deadline:
        _timeout_reason = 'client-timeout'
        raise _InfiniteLoopDetected('Execution exceeded the per-case wall-clock limit')

def _tracecode_collect_user_function_names(tree):
    names = _builtins.set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
    return names

def _tracecode_collect_user_class_names(tree):
    names = _builtins.set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            names.add(node.name)
    return names

def _tracecode_collect_explicit_return_function_names(tree):
    names = _builtins.set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for child in ast.walk(node):
                if child is not node and isinstance(child, ast.Return):
                    names.add(node.name)
                    break
    return names

class __TracecodeAccessTransformer(ast.NodeTransformer):
    def __init__(self, user_function_names=None, user_class_names=None):
        super().__init__()
        self._tracecode_user_function_names = _builtins.set(user_function_names or [])
        self._tracecode_user_class_names = _builtins.set(user_class_names or [])
        self._tracecode_temp_counter = 0

    def _tracecode_next_temp_name(self, prefix):
        name = f'__tracecode_{prefix}_{self._tracecode_temp_counter}'
        self._tracecode_temp_counter += 1
        return name

    def _tracecode_replace_target_indices(self, target, index_temp_names):
        index_position = len(index_temp_names) - 1
        current = target
        while index_position >= 0:
            if isinstance(current, ast.Subscript):
                current.slice = ast.copy_location(
                    ast.Name(id=index_temp_names[index_position], ctx=ast.Load()),
                    current.slice,
                )
                current = current.value
                index_position -= 1
                continue
            if isinstance(current, ast.Attribute):
                current = current.value
                continue
            break

    def _tracecode_replace_target_indices_with_values(self, target, index_values):
        index_position = len(index_values) - 1
        current = target
        while index_position >= 0:
            if isinstance(current, ast.Subscript):
                current.slice = ast.copy_location(index_values[index_position], current.slice)
                current = current.value
                index_position -= 1
                continue
            if isinstance(current, ast.Attribute):
                current = current.value
                continue
            break

    def _tracecode_is_inside_comprehension_iter(self, node):
        current = node
        parent = getattr(current, '__trace_parent__', None)
        while parent is not None:
            if isinstance(parent, ast.comprehension) and getattr(parent, 'iter', None) is current:
                return True
            current = parent
            parent = getattr(current, '__trace_parent__', None)
        return False

    def _tracecode_target_path_components(self, target):
        components = []
        current = target
        while len(components) < _TRACE_MAX_PATH_DEPTH:
            if isinstance(current, ast.Subscript):
                components.insert(0, ('subscript', current.slice))
                current = current.value
                continue
            if isinstance(current, ast.Attribute):
                components.insert(0, ('attribute', ast.Constant(value=current.attr)))
                current = current.value
                continue
            break
        return components

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
        assignment_write_targets = []
        for target in node.targets:
            scalar_names.extend(_tracecode_scalar_target_names(target))
            assignment_write_targets.extend(_tracecode_assignment_write_targets(target))
        if scalar_names or assignment_write_targets:
            prelude = []
            prepared_write_targets = []
            if assignment_write_targets:
                value_temp_name = self._tracecode_next_temp_name('assign_value')
                value_temp_assign = ast.Assign(
                    targets=[ast.Name(id=value_temp_name, ctx=ast.Store())],
                    value=self.visit(node.value),
                )
                prelude.append(ast.copy_location(value_temp_assign, node))
                node.value = ast.copy_location(ast.Name(id=value_temp_name, ctx=ast.Load()), node.value)
                for target_type, target in assignment_write_targets:
                    if target_type == 'index':
                        extracted = _tracecode_extract_named_subscript(target)
                        if extracted is None:
                            continue
                        var_name, indices = extracted
                        index_temp_names = []
                        index_temp_refs = []
                        index_sources = []
                        for index in indices:
                            index_temp_name = self._tracecode_next_temp_name('target_index')
                            index_temp_names.append(index_temp_name)
                            index_temp_refs.append(ast.Name(id=index_temp_name, ctx=ast.Load()))
                            index_sources.append(_tracecode_index_source_node(index))
                            index_temp_assign = ast.Assign(
                                targets=[ast.Name(id=index_temp_name, ctx=ast.Store())],
                                value=self.visit(index),
                            )
                            prelude.append(ast.copy_location(index_temp_assign, node))
                        self._tracecode_replace_target_indices(target, index_temp_names)
                        prepared_write_targets.append(('index', var_name, index_temp_refs, index_sources))
                        continue
                    attr_extracted = _tracecode_extract_named_attribute(target)
                    if attr_extracted is None:
                        continue
                    prepared_write_targets.append(('attr', *attr_extracted))
            visited = self.generic_visit(node)
            writes = []
            for target_info in prepared_write_targets:
                target_type = target_info[0]
                if target_type == 'index':
                    _, var_name, indices, index_sources = target_info
                    write_call = ast.Expr(value=ast.Call(
                        func=ast.Name(id='_tracecode_record_index_write', ctx=ast.Load()),
                        args=[
                            ast.Constant(value=var_name),
                            ast.Name(id=var_name, ctx=ast.Load()),
                            ast.List(elts=indices, ctx=ast.Load()),
                            ast.List(elts=index_sources, ctx=ast.Load()),
                        ],
                        keywords=[],
                    ))
                    writes.append(ast.copy_location(write_call, node))
                    continue
                _, var_name, attr_name = target_info
                write_call = ast.Expr(value=ast.Call(
                    func=ast.Name(id='_tracecode_record_attr_write', ctx=ast.Load()),
                    args=[
                        ast.Constant(value=var_name),
                        ast.Name(id=var_name, ctx=ast.Load()),
                        ast.Constant(value=attr_name),
                    ],
                    keywords=[],
                ))
                writes.append(ast.copy_location(write_call, node))
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
            return [*prelude, visited, *writes]
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
                var_name, _container, indices = extracted_heap
                target_arg = node.args[0]
                subscript_index_values = []
                index_refs = []
                inside_comprehension_iter = self._tracecode_is_inside_comprehension_iter(node)
                if len(indices) > 0 and not inside_comprehension_iter:
                    components = self._tracecode_target_path_components(target_arg)
                    for position, index in enumerate(indices):
                        component_kind = components[position][0] if position < len(components) else 'subscript'
                        if component_kind == 'attribute':
                            index_refs.append(self.visit(index))
                            continue
                        temp_name = self._tracecode_next_temp_name('heapq_index')
                        index_refs.append(ast.Name(id=temp_name, ctx=ast.Load()))
                        subscript_index_values.append(ast.copy_location(
                            ast.NamedExpr(
                                target=ast.Name(id=temp_name, ctx=ast.Store()),
                                value=self.visit(index),
                            ),
                            index,
                        ))
                    self._tracecode_replace_target_indices_with_values(target_arg, subscript_index_values)
                elif len(indices) > 0:
                    components = self._tracecode_target_path_components(target_arg)
                    lambda_args = []
                    lambda_defaults = []
                    for position, index in enumerate(indices):
                        component_kind = components[position][0] if position < len(components) else 'subscript'
                        if component_kind == 'attribute':
                            index_refs.append(self.visit(index))
                            continue
                        temp_name = self._tracecode_next_temp_name('heapq_index')
                        temp_ref = ast.Name(id=temp_name, ctx=ast.Load())
                        index_refs.append(ast.copy_location(temp_ref, index))
                        subscript_index_values.append(ast.copy_location(ast.Name(id=temp_name, ctx=ast.Load()), index))
                        lambda_args.append(ast.arg(arg=temp_name))
                        lambda_defaults.append(self.visit(index))
                    self._tracecode_replace_target_indices_with_values(target_arg, subscript_index_values)
                call = ast.Call(
                    func=ast.Name(id='_tracecode_heapq_mutation', ctx=ast.Load()),
                    args=[
                        ast.copy_location(
                            ast.Attribute(
                                value=self.visit(node.func.value),
                                attr=node.func.attr,
                                ctx=ast.Load(),
                            ),
                            node.func,
                        ),
                        ast.Constant(value=var_name),
                        target_arg,
                        ast.List(
                            elts=index_refs if len(index_refs) > 0 else [self.visit(index) for index in indices],
                            ctx=ast.Load(),
                        ),
                        ast.Constant(value=node.func.attr),
                        *[self.visit(arg) for arg in node.args[1:]],
                    ],
                    keywords=[self.visit(keyword) for keyword in node.keywords],
                )
                if len(indices) > 0 and inside_comprehension_iter and len(lambda_args) > 0:
                    call = ast.copy_location(
                        ast.Call(
                            func=ast.Lambda(
                                args=ast.arguments(
                                    posonlyargs=[],
                                    args=lambda_args,
                                    vararg=None,
                                    kwonlyargs=[],
                                    kw_defaults=[],
                                    kwarg=None,
                                    defaults=lambda_defaults,
                                ),
                                body=call,
                            ),
                            args=[],
                            keywords=[],
                        ),
                        node,
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
            isinstance(node.func, ast.Attribute) and
            node.func.attr in self._tracecode_user_function_names
        ):
            call = ast.Call(
                func=ast.Name(id='_tracecode_user_call', ctx=ast.Load()),
                args=[
                    ast.Constant(value=getattr(node, 'lineno', 1)),
                    ast.Constant(value=node.func.attr),
                    node.func,
                    *node.args,
                ],
                keywords=node.keywords,
            )
            return ast.copy_location(call, node)
        if (
            isinstance(node.func, ast.Name) and
            (node.func.id in self._tracecode_user_function_names or node.func.id in self._tracecode_user_class_names)
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

def __tracecode_compile_user_code(source, on_demand=False):
    raw_tree = ast.parse(source, filename='solution.py', mode='exec')
    traced_tree = ast.parse(source, filename='solution.py', mode='exec')
    __tracecode_attach_parents(traced_tree)
    traced_tree = __TracecodeAccessTransformer(
        _tracecode_collect_user_function_names(traced_tree),
        _tracecode_collect_user_class_names(traced_tree),
    ).visit(traced_tree)
    if not on_demand:
        ast.fix_missing_locations(traced_tree)
        return compile(traced_tree, 'solution.py', 'exec')

    # One code object carries both implementations. The branch runs once when
    # the module is loaded for a case, so verdict-only execution pays neither
    # injected hook calls nor a branch at every access. Module docstrings and
    # future imports must remain outside the conditional to retain Python's
    # compilation semantics.
    prefix_count = 0
    if (
        len(raw_tree.body) > 0 and
        isinstance(raw_tree.body[0], ast.Expr) and
        isinstance(raw_tree.body[0].value, ast.Constant) and
        isinstance(raw_tree.body[0].value.value, str)
    ):
        prefix_count = 1
    while (
        prefix_count < len(raw_tree.body) and
        isinstance(raw_tree.body[prefix_count], ast.ImportFrom) and
        raw_tree.body[prefix_count].module == '__future__'
    ):
        prefix_count += 1
    raw_body = raw_tree.body[prefix_count:]
    traced_body = traced_tree.body[prefix_count:]
    selector_anchor = (
        raw_body[0]
        if len(raw_body) > 0
        else (raw_tree.body[0] if len(raw_tree.body) > 0 else None)
    )
    if len(raw_body) == 0:
        raw_body = [ast.Pass()]
    if len(traced_body) == 0:
        traced_body = [ast.Pass()]
    selector = ast.If(
        test=ast.Name(id='__tracecode_tracing_enabled', ctx=ast.Load()),
        body=traced_body,
        orelse=raw_body,
    )
    if selector_anchor is not None:
        selector = ast.copy_location(selector, selector_anchor)
    combined_tree = ast.Module(
        body=raw_tree.body[:prefix_count] + [selector],
        type_ignores=raw_tree.type_ignores,
    )
    ast.fix_missing_locations(combined_tree)
    return compile(combined_tree, 'solution.py', 'exec')

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
        return _builtins.set()

    collapsed_lines = _builtins.set()
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

def _tracer(frame, event, arg,
    _tracecode_resolve_previous_step=__tracecode_resolve_previous_step,
    _tracecode_flush_completed_line=__tracecode_flush_completed_line,
):
    global _trace_limit_exceeded, _timeout_reason, _total_line_events, _line_hit_count, _infinite_loop_line
    global _call_stack_generation, _hard_line_deadline
    _tracecode_check_deadline()

    # Degraded fast path. Once a trace budget trips we record nothing more, so
    # skip the whole classification preamble (filename, internal-func set, the
    # structural-constructor call) and keep only the runaway guards. Sampling
    # them every 1024 events keeps perf_counter() off the per-event path; the
    # ceiling is 50x the normal budget, so the coarse granularity is harmless.
    if _trace_limit_exceeded:
        if event != 'line':
            return _tracer
        _total_line_events += 1
        if (_total_line_events & 1023) == 0:
            if _hard_line_deadline == 0.0:
                _hard_line_deadline = _tc_perf() + _hard_line_grace_seconds
            if _total_line_events >= _hard_line_ceiling or _tc_perf() > _hard_line_deadline:
                _tracecode_stop_tracing()
                raise _InfiniteLoopDetected(
                    f"Execution guard tripped after {_total_line_events} line events"
                )
            if _max_memory_bytes > 0 and _tracecode_tracemalloc is not None:
                try:
                    _degraded_memory, _degraded_peak = _tracecode_tracemalloc.get_traced_memory()
                except Exception:
                    _degraded_memory, _degraded_peak = (0, 0)
                if _degraded_memory >= _max_memory_bytes or _degraded_peak >= _max_memory_bytes:
                    _tracecode_stop_tracing()
                    raise _InfiniteLoopDetected(f"Exceeded {_max_memory_bytes} bytes")
        return _tracer

    func_name = frame.f_code.co_name

    if frame.f_code.co_filename != 'solution.py':
        return _tracer

    # Skip visual noise from node constructors used only to build data structures.
    if _is_structural_constructor_frame(frame):
        return _tracer
    
    # Fast counter for any loops
    if event == 'line':
        if frame.f_code.co_filename == 'solution.py' and frame.f_lineno in _tracecode_collapsed_literal_lines:
            return _tracer
        _total_line_events += 1

        if (
            _max_memory_bytes > 0
            and _tracecode_tracemalloc is not None
            and (_total_line_events % _memory_check_every) == 0
        ):
            try:
                _current_memory, _peak_memory = _tracecode_tracemalloc.get_traced_memory()
            except Exception:
                _current_memory, _peak_memory = (0, 0)
            if _current_memory >= _max_memory_bytes or _peak_memory >= _max_memory_bytes:
                if not _trace_limit_exceeded:
                    _trace_limit_exceeded = True
                    _timeout_reason = 'memory-limit'
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
                    _tracecode_stop_tracing()
                    raise _InfiniteLoopDetected(f"Exceeded {_max_memory_bytes} bytes")

        # Check total line events before duplicate-line suppression so
        # tight no-op loops cannot bypass the in-runtime guard.
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
                # Degrade: stop recording, keep executing. Every later event
                # takes the degraded fast path at the top of _tracer.
                return _tracer

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
                # Degrade: stop recording, keep executing (see _hard_line_ceiling).
                return _tracer

        # Function-mode setup executes the learner module to load definitions.
        # Keep counting those lines for runaway protection, but do not publish
        # definition-time events or injected input globals as learner steps.
        if func_name == '<module>' and not _SCRIPT_MODE:
            return _tracer

        previous_step = _tracecode_resolve_previous_step(frame)
        if (
            isinstance(previous_step, _builtins.dict)
            and previous_step.get('event') == 'line'
            and previous_step.get('line') == frame.f_lineno
            and not previous_step.get('__runtime_flushed')
            and not _pending_accesses.get(_tracecode_builtin_id(frame))
        ):
            return _tracer
        _tracecode_flush_completed_line(frame)
    
    if func_name == '<module>' and not _SCRIPT_MODE:
        return _tracer

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
            _tracecode_stop_tracing()
        return None

    if _trace_limit_exceeded and _timeout_reason in ('trace-limit', 'trace-byte-limit'):
        _pending_accesses.clear()
        _tracecode_stop_tracing()
        return None

    if event == 'call':
        if _max_call_depth > 0 and func_name != '<module>' and len(_call_stack) + 1 > _max_call_depth:
            if not _trace_limit_exceeded:
                _trace_limit_exceeded = True
                _timeout_reason = 'recursion-limit'
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
                _tracecode_stop_tracing()
                raise _InfiniteLoopDetected(f"Exceeded {_max_call_depth} calls")
        local_vars, local_sources = _snapshot_locals(frame, with_sources=True)
        if func_name != '<module>':
            _call_stack_generation += 1
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
        _tracecode_flush_completed_line(frame)
        is_class_body_return = func_name in _tracecode_user_class_names and frame.f_code.co_filename == 'solution.py'
        is_implicit_none_return = (
            arg is None
            and frame.f_code.co_filename == 'solution.py'
            and func_name not in _tracecode_explicit_return_function_names
        )
        if not _MINIMAL_TRACE and not is_class_body_return and not is_implicit_none_return:
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
            _call_stack_generation += 1
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

  const treeConversions = !usesPreparedBindings && treeInputKeys.length > 0
    ? treeInputKeys.map(key => `${key} = _dict_to_tree(${key})`).join('\n')
    : '';
  
  const listConversions = !usesPreparedBindings && listInputKeys.length > 0
    ? listInputKeys.map(key => `${key} = _dict_to_list(${key})`).join('\n')
    : '';

  const inplaceCandidates = ['nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid']
    .filter((key) => Object.prototype.hasOwnProperty.call(inputs, key));
  const inplaceCandidatesLiteral = usesPreparedBindings
    ? "[_name for _name in ('nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid') if _name in _TRACE_INPUT_NAMES]"
    : JSON.stringify(inplaceCandidates);
  const traceInputNamesLiteral = usesPreparedBindings
    ? '_builtins.list(_TRACE_INPUT_NAMES)'
    : JSON.stringify(Object.keys(inputs));
  const functionNameLiteral = deps.toPythonLiteral(functionName);
  const executionStyleLiteral = deps.toPythonLiteral(executionStyle);
  const executionCode = functionName
    ? executionStyle === 'solution-method'
      ? [
        `    _result = _tracecode_invoke_entry(${JSON.stringify(functionName)}, ${JSON.stringify(executionStyle)}, ${traceInputNamesLiteral})`,
      ].join('\n')
      : executionStyle === 'ops-class'
        ? [
          `    _ops = _globals_dict.get('operations', _globals_dict.get('ops'))`,
          `    _args = _globals_dict.get('arguments', _globals_dict.get('args'))`,
          `    if _ops is None or _args is None:`,
          `        raise ValueError(\"ops-class execution requires inputs.operations and inputs.arguments (or ops/args)\")`,
          `    if len(_ops) != len(_args):`,
          `        raise ValueError(\"operations and arguments must have the same length\")`,
          `    _cls = _globals_dict[${functionNameLiteral}]`,
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
          `    _result = _tracecode_invoke_entry(${JSON.stringify(functionName)}, ${JSON.stringify(executionStyle)}, ${traceInputNamesLiteral})`,
        ].join('\n')
    : [
      `    exec(__tracecode_compiled, _globals_dict)`,
      `    _result = _globals_dict.get('result', None)`,
    ].join('\n');

  const userCodeTraceSetup = [
    `\n_user_code_str = """${escapedCode}"""`,
    `import textwrap as _textwrap`,
    `_user_code_str = _textwrap.dedent(_user_code_str.lstrip("\\n"))`,
    `_tracecode_user_class_names = _tracecode_collect_user_class_names(ast.parse(_user_code_str, filename='solution.py', mode='exec'))`,
    `_tracecode_explicit_return_function_names = _tracecode_collect_explicit_return_function_names(ast.parse(_user_code_str, filename='solution.py', mode='exec'))`,
    `_tracecode_collapsed_literal_lines = _tracecode_collect_collapsed_literal_lines(_user_code_str)`,
    usesPreparedBindings
      ? `__tracecode_compiled = __tracecode_prepared_user_code`
      : `__tracecode_compiled = __tracecode_compile_user_code(_user_code_str)`,
    ].join('\n');

  if (prepared?.compileUserOnly === true) {
    const preparationSetup = [
      `\n_user_code_str = """${escapedCode}"""`,
      `import textwrap as _textwrap`,
      `_user_code_str = _textwrap.dedent(_user_code_str.lstrip("\\n"))`,
      `_tracecode_user_class_names = _tracecode_collect_user_class_names(ast.parse(_user_code_str, filename='solution.py', mode='exec'))`,
      `_tracecode_explicit_return_function_names = _tracecode_collect_explicit_return_function_names(ast.parse(_user_code_str, filename='solution.py', mode='exec'))`,
      `_tracecode_collapsed_literal_lines = _tracecode_collect_collapsed_literal_lines(_user_code_str)`,
      `__tracecode_prepared_user_code_result = __tracecode_compile_user_code(_user_code_str, ${prepared?.onDemand === true ? 'True' : 'False'})`,
      `__tracecode_prepared_user_code_result`,
    ].join('\n');
    return {
      code: harnessPrefix + preparationSetup,
      userCodeStartLine,
    };
  }

  const preloadUserDefinitions = functionName ? `exec(__tracecode_compiled, _globals_dict)\n` : '';
  const traceCaseSetup = [
    inputSetup,
    treeConversions,
    listConversions,
    `_SCRIPT_PRE_USER_GLOBALS = _builtins.set(_globals_dict.keys()) - _TRACE_INPUT_NAMES`,
    preloadUserDefinitions,
    `if ${usesPreparedBindings ? '__tracecode_inputs_need_materialization' : 'True'}:\n    _tracecode_materialize_named_inputs(${traceInputNamesLiteral})`,
    `_tracecode_hydrate_annotated_inputs(${traceInputNamesLiteral}, ${functionNameLiteral}, ${executionStyleLiteral})`,
  ]
    .filter((source) => source.length > 0)
    .join('\n');
  const traceCaseSetupInTry = traceCaseSetup
    .split('\n')
    .map((line) => (line ? `    ${line}` : line))
    .join('\n');

  const harnessSuffix = `
${userCodeTraceSetup}
${deps.PYTHON_CONVERSION_HELPERS_SNIPPET}


${buildPythonExecutionHelpers({
      namespaceExpression: "_globals_dict",
      inplaceCandidatesLiteral,
      includeMaterializeInput: true,
    })}

if _max_memory_bytes > 0 and _tracecode_tracemalloc is not None:
    try:
        if not _tracecode_tracemalloc.is_tracing():
            _tracecode_tracemalloc.start()
            _tracecode_tracemalloc_started = True
    except Exception:
        _tracecode_tracemalloc_started = False

# Source augmentation can record setup accesses before user execution begins.
# They are not learner events and must not leak into the first traced line.
_pending_accesses.clear()

_tp_hooks = 0.0
_tp_serialize_all = 0.0
_tp_hook_calls = 0
_tp_depth = 0

if _TRACE_PROFILE:
    _internal_funcs.add('_tc_hook_wrapper')
    def _tc_wrap_hook(_tc_fn):
        def _tc_hook_wrapper(*_tc_a, **_tc_k):
            global _tp_hooks, _tp_depth, _tp_hook_calls
            if _tp_depth > 0:
                return _tc_fn(*_tc_a, **_tc_k)
            _tp_depth = 1
            _tp_hook_calls += 1
            _tc_t0 = _tc_perf()
            try:
                return _tc_fn(*_tc_a, **_tc_k)
            finally:
                _tp_hooks += _tc_perf() - _tc_t0
                _tp_depth = 0
        return _tc_hook_wrapper
    for _tc_hook_name in (
        '_tracecode_read_index', '_tracecode_write_index', '_tracecode_augassign_index',
        '_tracecode_augassign_scalar', '_tracecode_write_scalar', '_tracecode_len',
        '_tracecode_enumerate', '_tracecode_iter_bind', '_tracecode_iter_bind_indexed',
        '_tracecode_range_bind', '_tracecode_user_call', '_tracecode_dict_get',
        '_tracecode_mutating_call', '_tracecode_mutating_index_call', '_tracecode_sum',
        '_tracecode_contains_key_indexed', '_tracecode_record_index_write',
        '_tracecode_delete_index', '_tracecode_record_attr_write',
    ):
        if _tc_hook_name in globals():
            globals()[_tc_hook_name] = _tc_wrap_hook(globals()[_tc_hook_name])
    _internal_funcs.add('_tc_serialize_wrapper')
    _tc_orig_serialize_fn = _serialize
    def _tc_serialize_wrapper(obj, depth=0, node_refs=None):
        global _tp_serialize_all
        _tc_t0 = _tc_perf()
        try:
            return _tc_orig_serialize_fn(obj, depth, node_refs)
        finally:
            if depth == 0:
                _tp_serialize_all += _tc_perf() - _tc_t0
    _serialize = _tc_serialize_wrapper

if _TRACE_PROFILE:
    # Measurement-only accumulators. Buckets nest (snapshots run inside the
    # tracer and inside step appends), so interpret them as raw inclusive
    # totals rather than a partition.
    _tc_orig_snapshot_locals = _snapshot_locals
    def _snapshot_locals(frame, with_sources=False):
        global _tp_snapshot
        _t0 = _tc_perf()
        try:
            return _tc_orig_snapshot_locals(frame, with_sources)
        finally:
            _tp_snapshot += _tc_perf() - _t0
    _tc_orig_snapshot_call_stack = _snapshot_call_stack
    def _snapshot_call_stack():
        global _tp_stack
        _t0 = _tc_perf()
        try:
            return _tc_orig_snapshot_call_stack()
        finally:
            _tp_stack += _tc_perf() - _t0
    _tc_orig_append_trace_step = __tracecode_append_trace_step
    def __tracecode_append_trace_step(frame, step):
        global _tp_step
        _t0 = _tc_perf()
        try:
            return _tc_orig_append_trace_step(frame, step)
        finally:
            _tp_step += _tc_perf() - _t0
    _tc_orig_append_events_for_step = __tracecode_append_trace_events_for_step
    def __tracecode_append_trace_events_for_step(step):
        global _tp_convert
        _t0 = _tc_perf()
        try:
            return _tc_orig_append_events_for_step(step)
        finally:
            _tp_convert += _tc_perf() - _t0
    _tc_orig_tracer = _tracer
    def _tracer(frame, event, arg):
        global _tp_tracer
        _t0 = _tc_perf()
        try:
            _tc_result = _tc_orig_tracer(frame, event, arg)
        finally:
            _tp_tracer += _tc_perf() - _t0
        return _tracer if _tc_result is _tc_orig_tracer else _tc_result

# Native tracer hot path: configured late so every rebind (profiling wrappers
# included) has settled. Missing module → python paths, zero-risk fallback.
try:
    import _tracecode_native as _tc_native_module
    _tc_native_module.configure(
        frozenset(_internal_locals),
        _serialize,
        _TC_JSON_ENCODER.encode,
        _SKIP_SENTINEL,
    )
    _tc_native_module.begin_run(_max_stored_events, _max_trace_bytes, _max_trace_event_bytes, _trace_stored_bytes)
    _TC_NATIVE = _tc_native_module
except Exception:
    _TC_NATIVE = None

${usesPreparedBindings
  ? `_tracecode_executor_namespace = globals()
_tracecode_user_namespace = {
    _name: _value
    for _name, _value in _builtins.list(_tracecode_executor_namespace.items())
    if not _name.startswith('_')
}
for _name in _internal_funcs:
    if _name in _tracecode_executor_namespace:
        _tracecode_user_namespace[_name] = _tracecode_executor_namespace[_name]
_tracecode_user_namespace['__builtins__'] = _builtins
_tracecode_user_namespace['__name__'] = '__main__'
_tracecode_user_namespace['print'] = _custom_print
_tracecode_user_namespace['pow'] = _builtins.pow
_tracecode_user_namespace['_builtins'] = _builtins
_tracecode_user_namespace['__tracecode_tracing_enabled'] = __tracecode_tracing_enabled
_globals_dict = _tracecode_user_namespace`
  : ''}

_tp_arm_at = _tc_perf()
_case_deadline = (
    _tp_arm_at + (_wall_clock_ms / 1000.0)
    if _wall_clock_ms > 0.0
    else 0.0
)
_tracecode_arm_tracing()
_trace_failed = False
# True only when a guard aborted the program mid-flight (runaway loop, memory
# ceiling). A trace-budget trip alone degrades to "stop recording, keep running"
# and leaves this False, so the host can still trust _result.
_execution_aborted = False

try:
${traceCaseSetupInTry}
${executionCode}
    _tracecode_check_deadline()
except _InfiniteLoopDetected as e:
    _trace_failed = True
    _execution_aborted = True
    _result = None
    # Infinite loop was detected - trace data already has the timeout event
except Exception as e:
    _trace_failed = True
    # Stop tracing immediately so error-handling internals are never traced.
    _tracecode_stop_tracing()
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

_tracecode_stop_tracing()
_tp_stop_at = _tc_perf()
if _tracecode_tracemalloc is not None and _tracecode_tracemalloc_started:
    try:
        _tracecode_tracemalloc.stop()
    except Exception:
        pass

_builtins.print = _original_print
print = _original_print

def __tracecode_compact_last_step(kind=None):
    for step in reversed(_trace_data):
        if not isinstance(step, _builtins.dict):
            continue
        if kind is not None and step.get('event') != kind:
            continue
        compact = {
            'event': step.get('event'),
            'line': step.get('line'),
        }
        variables = step.get('variables')
        if isinstance(variables, _builtins.dict):
            selected = {}
            for key in ('timeoutReason', 'error', 'errorType', 'errorLine'):
                if key in variables:
                    selected[key] = variables.get(key)
            if selected:
                compact['variables'] = selected
        return compact
    return None

if _TRACE_PROFILE:
    _console_output.append('__TRACECODE_TRACE_PROFILE_JSON__:' + json.dumps({
        'language': 'python',
        'monitoring': _TC_MONITORING_ACTIVE,
        'monitoringError': _TC_MONITORING_ERROR,
        'monitoringArmed': _TC_MONITORING_WAS_ARMED,
        'setupMs': round((_tp_arm_at - _tp_import_at) * 1000, 1),
        'hookMs': round(_tp_hooks * 1000, 1),
        'hookCalls': _tp_hook_calls,
        'serializeAllMs': round(_tp_serialize_all * 1000, 1),
        'runPhaseMs': round((_tp_stop_at - _tp_arm_at) * 1000, 1),
        'exportPhaseMs': round((_tc_perf() - _tp_stop_at) * 1000, 1),
        'tracerMs': round(_tp_tracer * 1000, 1),
        'snapshotMs': round(_tp_snapshot * 1000, 1),
        'callStackMs': round(_tp_stack * 1000, 1),
        'stepAppendMs': round(_tp_step * 1000, 1),
        'eventConvertMs': round(_tp_convert * 1000, 1),
        'events': _TC_NATIVE.stored_event_count() if _TC_NATIVE is not None else len(_trace_events),
        'steps': len(_trace_data),
        'lineEvents': _total_line_events,
    }))

__tracecode_execution_result_json = (
    '{"traceSummary":' + json.dumps({
        'errorStep': __tracecode_compact_last_step('exception'),
        'timeoutStep': __tracecode_compact_last_step('timeout'),
        'lastStep': __tracecode_compact_last_step(),
    })
    + ',"runtimeTrace":{"schemaVersion":"runtime-trace-2026-04-28","language":"python","runId":"python:run","events":['
    + (_TC_NATIVE.take_buffer() if _TC_NATIVE is not None else ','.join(_trace_events))
    + '],"lineEventCount":' + str(
        _TC_NATIVE.counters()['lineEvents'] if _TC_NATIVE is not None else _trace_line_event_count
    )
    + ',"traceStepCount":' + str(
        _TC_NATIVE.stored_event_count() if _TC_NATIVE is not None else len(_trace_events)
    ) + '}'
    + ',"result":' + json.dumps(_serialize_output(_result))
    + ',"console":' + json.dumps(_console_output)
    + ',"userCodeStartLine":' + json.dumps(${userCodeStartLine})
    + ',"traceLimitExceeded":' + json.dumps(_trace_limit_exceeded)
    + ',"executionAborted":' + json.dumps(_execution_aborted)
    + ',"timeoutReason":' + json.dumps(_timeout_reason)
    + ',"lineEventCount":' + json.dumps(_total_line_events)
    + ',"traceStepCount":' + json.dumps(len(_trace_data)) + '}'
)
__tracecode_execution_result_json
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

function pythonErrorText(error) {
  if (error && typeof error === 'object') {
    const stack = typeof error.stack === 'string' ? error.stack : '';
    if (stack.includes('Traceback (most recent call last)')) return stack;
    if (typeof error.message === 'string' && error.message) {
      return error.message;
    }
    if (typeof error.type === 'string' || typeof error.value === 'string') {
      return [error.type, error.value].filter(Boolean).join(': ');
    }
  }
  return error instanceof Error ? error.message : String(error);
}

const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';

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

function remapPythonRuntimeTrace(runtimeTrace, userCodeStartLine, userCodeLineCount, runId = 'python:run', file, sourceCode = '') {
  const normalizedEvents = [];
  const events = runtimeTrace && Array.isArray(runtimeTrace.events) ? runtimeTrace.events : [];
  const statementSourceMap = buildRuntimeStatementSourceMap(sourceCode);
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
    Object.assign(normalized, runtimeTraceSourceOwnership(normalized.line, normalized.function, statementSourceMap));
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
async function executeWithTracing(
  deps,
  code,
  functionName,
  inputs,
  executionStyle = 'function',
  options = {},
  prepared = undefined
) {
  const startTime = deps.performanceNow();
  const userCodeLineCount = code.split('\n').length;
  const generated = generateTracingCode(deps,
    code,
    functionName,
    prepared ? {} : inputs,
    executionStyle,
    options,
    prepared ? { bindings: true } : undefined
  );
  const tracingCode = generated.code;
  const userCodeStartLine = prepared ? 1 : generated.userCodeStartLine;

  try {
    await deps.loadPyodideInstance();

    if (prepared?.compileOnly === true) {
      return {
        success: true,
        output: null,
        trace: { events: [] },
        executionTimeMs: deps.performanceNow() - startTime,
        consoleOutput: [],
        __preparedSource: tracingCode,
      };
    }

    const pyRunStartedAt = deps.performanceNow();
    const resultJson = prepared
      ? await runCompiledPythonInFreshExecutionScope(
          deps,
          prepared.executorCode,
          '__tracecode_execution_result_json',
          {
            __tracecode_prepared_user_code: prepared.userCodeObject,
            __tracecode_inputs_literal: preparedPythonLiteral(
              deps,
              inputs,
              prepared.scopeTimings
            ),
            __tracecode_limits_literal: preparedPythonLiteral(
              deps,
              prepared.limits?.guest ?? {},
              prepared.scopeTimings
            ),
            __tracecode_tracing_enabled: prepared.tracingEnabled !== false,
            __tracecode_inputs_need_materialization:
              pythonInputsRequireCustomMaterialization(inputs),
          },
          prepared.scopeTimings,
          prepared.isolationTier
        )
      : await runPythonInFreshExecutionScope(
          deps,
          tracingCode,
          '__tracecode_execution_result_json'
        );
    const pyRunMs = deps.performanceNow() - pyRunStartedAt;
    const jsonParseStartedAt = deps.performanceNow();
    const result = JSON.parse(resultJson);
    const jsonParseMs = deps.performanceNow() - jsonParseStartedAt;
    if (prepared?.scopeTimings) {
      prepared.scopeTimings.resultParseMs += jsonParseMs;
    }
    if (options.traceProfile === true) {
      // Worker-side phase split for the tracing-latency investigation.
      console.log('__TRACECODE_PYPROF__:' + JSON.stringify({
        generateMs: Math.round((pyRunStartedAt - startTime) * 10) / 10,
        pyRunMs: Math.round(pyRunMs * 10) / 10,
        jsonParseMs: Math.round(jsonParseMs * 10) / 10,
        resultChars: resultJson?.length ?? -1,
        prepared: Boolean(prepared),
      }));
    }

    const executionTimeMs = deps.performanceNow() - startTime;

    const adjustLegacyStep = (step) =>
      step && typeof step === 'object'
        ? {
            ...step,
            line: step.line > 0
              ? step.line - userCodeStartLine + 1
              : step.line,
          }
        : undefined;
    const errorStep = adjustLegacyStep(result.traceSummary?.errorStep);
    const timeoutStep = adjustLegacyStep(result.traceSummary?.timeoutStep);
    const lastStep = adjustLegacyStep(result.traceSummary?.lastStep);
    const timeoutReason =
      result.timeoutReason ||
      timeoutStep?.variables?.timeoutReason ||
      undefined;

    let errorMessage;
    let errorLine;
    
    const isTraceBudgetExceeded =
      timeoutReason === 'trace-limit' ||
      timeoutReason === 'trace-byte-limit' ||
      timeoutReason === 'line-limit' ||
      timeoutReason === 'single-line-limit' ||
      (result.traceLimitExceeded && timeoutReason !== 'client-timeout');

    // Every trace budget now degrades to "stop recording, keep executing", so a
    // budget trip alone no longer invalidates the result — the program still ran
    // to completion and `output` is real. Only an aborting guard (runaway loop,
    // memory ceiling) sets executionAborted, and that still fails the case.
    const traceOnlyBudgetExceeded =
      !result.executionAborted &&
      (timeoutReason === 'trace-limit' ||
        timeoutReason === 'trace-byte-limit' ||
        timeoutReason === 'line-limit' ||
        timeoutReason === 'single-line-limit');

    // Handle tracing guard stops and execution timeouts
    if (result.traceLimitExceeded || timeoutStep) {
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
        !result.executionAborted &&
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
        'solution.py',
        code
      ),
      executionTimeMs,
      consoleOutput: result.console,
      traceLimitExceeded: result.traceLimitExceeded,
      timeoutReason,
      lineEventCount: result.lineEventCount,
      traceStepCount: result.traceStepCount,
      timings: {
        totalMs: executionTimeMs,
        runMs: executionTimeMs,
      },
    };
  } catch (error) {
    const executionTimeMs = deps.performanceNow() - startTime;
    const rawError = pythonErrorText(error);
    
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
      timings: { totalMs: executionTimeMs, runMs: executionTimeMs },
    };
  }
}

/**
 * Execute Python code without tracing (for running tests)
 */
async function executeCode(
  deps,
  code,
  functionName,
  inputs,
  executionStyle = 'function',
  options = {},
  prepared = undefined
) {
  const startedAt = deps.performanceNow();
  const userCodeLineCount = code.split('\n').length;
  let userCodeStartLine = 1;
  const usesPreparedBindings = prepared !== undefined;
  // Prepared executors are compiled once, so their guard code must be present
  // even when the first case has no limits. Each execution decides whether to
  // enable it from its own immutable limits binding.
  const interviewGuardEnabled = options.interviewGuard === true || usesPreparedBindings;
  const interviewGuardConfig = {
    maxLineEvents: Math.max(10000, options.maxLineEvents ?? deps.INTERVIEW_GUARD_DEFAULTS.maxLineEvents),
    maxSingleLineHits: Math.max(1000, options.maxSingleLineHits ?? deps.INTERVIEW_GUARD_DEFAULTS.maxSingleLineHits),
    maxCallDepth: Math.max(100, options.maxCallDepth ?? deps.INTERVIEW_GUARD_DEFAULTS.maxCallDepth),
    maxMemoryBytes: Math.max(8 * 1024 * 1024, options.maxMemoryBytes ?? deps.INTERVIEW_GUARD_DEFAULTS.maxMemoryBytes),
    memoryCheckEvery: Math.max(10, options.memoryCheckEvery ?? deps.INTERVIEW_GUARD_DEFAULTS.memoryCheckEvery),
  };

  try {
    await deps.loadPyodideInstance();
    const executePyodide = deps.getPyodide();
    const supportsTrustedExecuteFinalization =
      typeof executePyodide?.runPython === 'function' &&
      typeof executePyodide?.toPy === 'function' &&
      typeof executePyodide?.globals?.delete === 'function';

    const preparedInputPrelude = usesPreparedBindings
      ? `
import ast as _tracecode_input_ast
_tracecode_raw_inputs = _tracecode_input_ast.literal_eval(__tracecode_inputs_literal)
_tracecode_case_limits = _tracecode_input_ast.literal_eval(__tracecode_limits_literal)
`
      : '';
    const inputSetup = usesPreparedBindings
      ? ''
      : Object.entries(inputs)
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

    const treeConversions = !usesPreparedBindings && treeInputKeys.length > 0
      ? treeInputKeys.map(key => `${key} = _dict_to_tree(${key})`).join('\n')
      : '';
    
    const listConversions = !usesPreparedBindings && listInputKeys.length > 0
      ? listInputKeys.map(key => `${key} = _dict_to_list(${key})`).join('\n')
      : '';

    const inplaceCandidates = ['nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid']
      .filter((key) => Object.prototype.hasOwnProperty.call(inputs, key));
    const inplaceCandidatesLiteral = usesPreparedBindings
      ? "[_name for _name in ('nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid') if _name in _tracecode_raw_inputs]"
      : JSON.stringify(inplaceCandidates);
    const traceInputNamesLiteral = usesPreparedBindings
      ? '_builtins.list(str(_name) for _name in _tracecode_raw_inputs.keys())'
      : JSON.stringify(Object.keys(inputs));
    const functionNameLiteral = deps.toPythonLiteral(functionName);
    const executionStyleLiteral = deps.toPythonLiteral(executionStyle);
    const caseNamespaceExpression = usesPreparedBindings
      ? '_tracecode_user_namespace'
      : 'globals()';
    const executionCall = executionStyle === 'solution-method'
      ? `_result = _tracecode_invoke_entry(${JSON.stringify(functionName)}, ${JSON.stringify(executionStyle)}, ${traceInputNamesLiteral})`
      : executionStyle === 'ops-class'
        ? `_tracecode_case_namespace = ${caseNamespaceExpression}
_ops = _tracecode_case_namespace.get('operations', _tracecode_case_namespace.get('ops'))
_args = _tracecode_case_namespace.get('arguments', _tracecode_case_namespace.get('args'))
if _ops is None or _args is None:
    raise ValueError("ops-class execution requires inputs.operations and inputs.arguments (or ops/args)")
if len(_ops) != len(_args):
    raise ValueError("operations and arguments must have the same length")
_cls = _tracecode_case_namespace[${functionNameLiteral}]
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
        : `_result = _tracecode_invoke_entry(${JSON.stringify(functionName)}, ${JSON.stringify(executionStyle)}, ${traceInputNamesLiteral})`;
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
import time as _interview_time
import traceback as _tracecode_execution_traceback
import builtins as _builtins
${deps.PYTHON_CLASS_DEFINITIONS_SNIPPET}
${PYTHON_DEFAULT_IMPORT_PRELUDE}
${preparedInputPrelude}
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

${usesPreparedBindings
  ? `_tracecode_user_namespace = {
    _name: _value
    for _name, _value in globals().items()
    if not _name.startswith('_')
}
_tracecode_user_namespace['__builtins__'] = _builtins
_tracecode_user_namespace['__name__'] = '__main__'
_tracecode_user_namespace['print'] = _custom_print
_tracecode_user_namespace['pow'] = _builtins.pow
_tracecode_user_namespace['__tracecode_tracing_enabled'] = __tracecode_tracing_enabled
for _tracecode_input_name, _tracecode_input_value in _tracecode_raw_inputs.items():
    _tracecode_user_namespace[str(_tracecode_input_name)] = _tracecode_input_value`
  : ''}

${deps.PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET}

${interviewGuardEnabled
  ? `
class _InterviewGuardTriggered(BaseException):
    pass

_interview_timeout_reason = None
_interview_case_deadline = None
_interview_line_events = 0
_interview_line_hits = {}
_interview_call_depth = 0
_interview_tracemalloc_started = False

_INTERVIEW_GUARD_ENABLED = ${
  usesPreparedBindings
    ? `_builtins.bool(_tracecode_case_limits.get('interviewGuard', False))`
    : 'True'
}
_INTERVIEW_GUARD_MAX_LINE_EVENTS = ${
  usesPreparedBindings
    ? `_builtins.max(10000, _builtins.int(_tracecode_case_limits.get('maxLineEvents', ${interviewGuardConfig.maxLineEvents})))`
    : interviewGuardConfig.maxLineEvents
}
_INTERVIEW_GUARD_WALL_CLOCK_MS = ${
  usesPreparedBindings
    ? `_builtins.max(1.0, float(_tracecode_case_limits.get('wallClockMs', 0))) if _tracecode_case_limits.get('wallClockMs') is not None else 0.0`
    : Math.max(0, options.wallClockMs ?? 0)
}
_INTERVIEW_GUARD_MAX_SINGLE_LINE_HITS = ${
  usesPreparedBindings
    ? `_builtins.max(1000, _builtins.int(_tracecode_case_limits.get('maxSingleLineHits', ${interviewGuardConfig.maxSingleLineHits})))`
    : interviewGuardConfig.maxSingleLineHits
}
_INTERVIEW_GUARD_MAX_CALL_DEPTH = ${
  usesPreparedBindings
    ? `_builtins.max(100, _builtins.int(_tracecode_case_limits.get('maxCallDepth', ${interviewGuardConfig.maxCallDepth})))`
    : interviewGuardConfig.maxCallDepth
}
_INTERVIEW_GUARD_MAX_MEMORY_BYTES = ${
  usesPreparedBindings
    ? `_builtins.max(8 * 1024 * 1024, _builtins.int(_tracecode_case_limits.get('maxMemoryBytes', ${interviewGuardConfig.maxMemoryBytes})))`
    : interviewGuardConfig.maxMemoryBytes
}
_INTERVIEW_GUARD_MEMORY_CHECK_EVERY = ${
  usesPreparedBindings
    ? `_builtins.max(10, _builtins.int(_tracecode_case_limits.get('memoryCheckEvery', ${interviewGuardConfig.memoryCheckEvery})))`
    : interviewGuardConfig.memoryCheckEvery
}

try:
    import tracemalloc as _interview_tracemalloc
except Exception:
    _interview_tracemalloc = None

def _interview_check_deadline():
    global _interview_timeout_reason
    if (
        _interview_case_deadline is not None
        and _interview_time.monotonic() >= _interview_case_deadline
    ):
        _interview_timeout_reason = 'client-timeout'
        raise _InterviewGuardTriggered('INTERVIEW_GUARD_TRIGGERED:client-timeout')

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

def _interview_assert_guard_clear():
    _interview_check_deadline()
    if _interview_timeout_reason is not None:
        raise _InterviewGuardTriggered(
            'INTERVIEW_GUARD_TRIGGERED:' + _interview_timeout_reason
        )

def _interview_guard_tracer(frame, event, arg):
    global _interview_timeout_reason, _interview_line_events, _interview_line_hits, _interview_call_depth
    _interview_check_deadline()
    _func_name = frame.f_code.co_name
    _is_user_frame = (
        frame.f_code.co_filename == 'solution.py'
        if ${usesPreparedBindings ? 'True' : 'False'}
        else (
            __TRACECODE_USER_CODE_START_LINE__ <= frame.f_code.co_firstlineno <= __TRACECODE_USER_CODE_END_LINE__
            or (
                _func_name == '<module>'
                and __TRACECODE_USER_CODE_START_LINE__ <= frame.f_lineno <= __TRACECODE_USER_CODE_END_LINE__
            )
        )
    )
    if not _is_user_frame:
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
    global _interview_tracemalloc_started, _interview_case_deadline
    _interview_case_deadline = (
        _interview_time.monotonic() + (_INTERVIEW_GUARD_WALL_CLOCK_MS / 1000.0)
        if _INTERVIEW_GUARD_WALL_CLOCK_MS > 0
        else None
    )
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
    global _interview_case_deadline
    sys.settrace(None)
    _interview_case_deadline = None
    if _interview_tracemalloc is not None and _interview_tracemalloc_started:
        try:
            _interview_tracemalloc.stop()
        except Exception:
            pass
`
  : ''}
`;
    userCodeStartLine = execPrefix.split('\n').length;
    const guardedCaseSetup = [
      usesPreparedBindings
        ? 'exec(__tracecode_prepared_user_code, _tracecode_user_namespace)'
        : '',
      inputSetup,
      treeConversions,
      listConversions,
      `if ${usesPreparedBindings ? '__tracecode_inputs_need_materialization' : 'True'}:\n    _tracecode_materialize_named_inputs(${traceInputNamesLiteral})`,
      `_tracecode_hydrate_annotated_inputs(${traceInputNamesLiteral}, ${functionNameLiteral}, ${executionStyleLiteral})`,
    ]
      .filter((source) => source.length > 0)
      .join('\n');
    const guardedCaseSetupInNestedTry = guardedCaseSetup
      .split('\n')
      .map((line) => (line ? `        ${line}` : line))
      .join('\n');
    const execSuffix = interviewGuardEnabled
      ? `
${deps.PYTHON_CONVERSION_HELPERS_SNIPPET}

${buildPythonExecutionHelpers({
      namespaceExpression: caseNamespaceExpression,
      inplaceCandidatesLiteral,
    })}

_result = None
_interview_guard_triggered = False
_interview_guard_reason = None
_tracecode_execution_failure = None
_tracecode_serialization_limit = False
_tracecode_serialized_output = None

try:
    if _INTERVIEW_GUARD_ENABLED:
        _interview_guard_start()
    try:
${guardedCaseSetupInNestedTry}
${executionCallInNestedTry}
        if _result is None:
            _inplace = _resolve_inplace_result()
            if _inplace is not None:
                _result = _inplace
        _tracecode_serialized_output = _serialize(
            _result,
            tree_node_root=${caseNamespaceExpression}.get('TreeNode', TreeNode),
            list_node_root=${caseNamespaceExpression}.get('ListNode', ListNode),
        )
        if _INTERVIEW_GUARD_ENABLED:
            _interview_assert_guard_clear()
    except _InterviewGuardTriggered:
        raise
    except _TracecodeSerializationLimit:
        _tracecode_serialization_limit = True
    except BaseException as _tracecode_execution_error:
        if not ${usesPreparedBindings ? 'True' : 'False'}:
            raise
        _tracecode_execution_frames = _tracecode_execution_traceback.extract_tb(
            _tracecode_execution_error.__traceback__
        )
        _tracecode_execution_user_frames = [
            _frame
            for _frame in _tracecode_execution_frames
            if _frame.filename == 'solution.py'
        ]
        _tracecode_execution_line = (
            _tracecode_execution_user_frames[-1].lineno
            if _tracecode_execution_user_frames
            else None
        )
        _tracecode_execution_message = str(
            _tracecode_execution_error
        ).strip().split('\\n')[0]
        _tracecode_execution_prefix = type(
            _tracecode_execution_error
        ).__name__
        if _tracecode_execution_line is not None:
            _tracecode_execution_prefix += (
                ' on line ' + str(_tracecode_execution_line)
            )
        _tracecode_execution_failure = {
            'message': (
                _tracecode_execution_prefix + ': ' +
                _tracecode_execution_message
            ),
            'line': _tracecode_execution_line,
        }
    finally:
        if _INTERVIEW_GUARD_ENABLED:
            _interview_guard_stop()
except _InterviewGuardTriggered as _guard_error:
    _interview_guard_triggered = True
    _interview_guard_reason = _interview_timeout_reason or str(_guard_error)
finally:
    _builtins.print = _original_print
    print = _original_print

if _interview_guard_triggered:
    _tracecode_raw_result = {
        "kind": "guard",
        "timeoutReason": _interview_guard_reason,
        "console": _console_output,
    }
elif _tracecode_execution_failure is not None:
    _tracecode_raw_result = {
        "kind": "execution-error",
        "executionError": _tracecode_execution_failure,
        "console": [],
    }
elif _tracecode_serialization_limit:
    _tracecode_raw_result = {
        "kind": "serialization-limit",
        "console": _console_output,
    }
else:
    _tracecode_raw_result = {
        "kind": "success-serialized",
        "output": _tracecode_serialized_output,
        "console": _console_output,
    }

_tracecode_raw_result
`
      : `
${deps.PYTHON_CONVERSION_HELPERS_SNIPPET}

${buildPythonExecutionHelpers({
      namespaceExpression: caseNamespaceExpression,
      annotationLocalsExpression: 'locals()',
      inplaceCandidatesLiteral,
    })}

${inputSetup}

${treeConversions}

${listConversions}

if ${usesPreparedBindings ? '__tracecode_inputs_need_materialization' : 'True'}:
    _tracecode_materialize_named_inputs(${traceInputNamesLiteral})
_tracecode_hydrate_annotated_inputs(${traceInputNamesLiteral}, ${functionNameLiteral}, ${executionStyleLiteral})

try:
${executionCallInTry}
finally:
    _builtins.print = _original_print
    print = _original_print

if _result is None:
    _inplace = _resolve_inplace_result()
    if _inplace is not None:
        _result = _inplace

_tracecode_raw_result = {
    "kind": "success",
    "output": _result,
    "console": _console_output,
    "treeNodeType": TreeNode,
    "listNodeType": ListNode,
}
_tracecode_raw_result
`;
    let execCode =
      execPrefix +
      (usesPreparedBindings
        ? ''
        : code) +
      execSuffix;
    execCode = execCode
      .replaceAll(
        '__TRACECODE_USER_CODE_START_LINE__',
        String(userCodeStartLine)
      )
      .replaceAll(
        '__TRACECODE_USER_CODE_END_LINE__',
        String(userCodeStartLine + userCodeLineCount - 1)
      );

    const executeFinalizerSource = `
import json
import math
import builtins as _builtins
${deps.PYTHON_CLASS_DEFINITIONS_SNIPPET}
${deps.PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET}

_tracecode_raw_result = __tracecode_raw_result
_tracecode_result_kind = _tracecode_raw_result.get("kind")
if _tracecode_result_kind == "guard":
    _tracecode_final_result = {
        "guardTriggered": True,
        "timeoutReason": _tracecode_raw_result.get("timeoutReason"),
        "console": _tracecode_raw_result.get("console", []),
    }
elif _tracecode_result_kind == "execution-error":
    _tracecode_final_result = {
        "executionError": _tracecode_raw_result.get("executionError"),
        "console": [],
    }
elif _tracecode_result_kind == "serialization-limit":
    _tracecode_final_result = {
        "serializationLimit": True,
        "console": _tracecode_raw_result.get("console", []),
    }
elif _tracecode_result_kind == "success-serialized":
    _tracecode_final_result = {
        "guardTriggered": False,
        "output": _tracecode_raw_result.get("output"),
        "console": _tracecode_raw_result.get("console", []),
    }
else:
    try:
        _tracecode_serialized_result = _serialize(
            _tracecode_raw_result.get("output"),
            tree_node_root=_tracecode_raw_result.get("treeNodeType", TreeNode),
            list_node_root=_tracecode_raw_result.get("listNodeType", ListNode),
        )
    except _TracecodeSerializationLimit:
        _tracecode_final_result = {
            "serializationLimit": True,
            "console": _tracecode_raw_result.get("console", []),
        }
    else:
        _tracecode_final_result = {
            "guardTriggered": False,
            "output": _tracecode_serialized_result,
            "console": _tracecode_raw_result.get("console", []),
        }

try:
    _json_out = _tracecode_trusted_json_encode(
        _tracecode_final_result,
        max_bytes=_MAX_SERIALIZED_BYTES,
        limit_type=_TracecodeSerializationLimit,
    )
except _TracecodeSerializationLimit:
    _json_out = _tracecode_trusted_json_encode({
        "serializationLimit": True,
        "console": [],
    })
_json_out
`;

    if (prepared?.compileOnly === true) {
      return {
        success: true,
        output: null,
        consoleOutput: [],
        timings: { totalMs: deps.performanceNow() - startedAt },
        __preparedSource: execCode,
      };
    }

    if (usesPreparedBindings) userCodeStartLine = 1;
    let resultJson;
    if (!supportsTrustedExecuteFinalization) {
      resultJson = await runPythonInFreshExecutionScope(
        deps,
        `${execCode}\n__tracecode_raw_result = _tracecode_raw_result\n${executeFinalizerSource}`,
        '_json_out'
      );
    } else {
      const rawResult = usesPreparedBindings
        ? await runCompiledPythonInFreshExecutionScope(
          deps,
          prepared.executorCode,
          '_tracecode_raw_result',
          {
            __tracecode_prepared_user_code: prepared.userCodeObject,
            __tracecode_inputs_literal: preparedPythonLiteral(
              deps,
              inputs,
              prepared.scopeTimings
            ),
            __tracecode_limits_literal: preparedPythonLiteral(
              deps,
              options,
              prepared.scopeTimings
            ),
            __tracecode_tracing_enabled: prepared.tracingEnabled === true,
            __tracecode_inputs_need_materialization:
              pythonInputsRequireCustomMaterialization(inputs),
          },
          prepared.scopeTimings,
          prepared.isolationTier
        )
        : await runPythonInFreshExecutionScope(
          deps,
          execCode,
          '_tracecode_raw_result'
        );
      try {
        resultJson = await runPythonInFreshExecutionScope(
          deps,
          executeFinalizerSource,
          '_json_out',
          { __tracecode_raw_result: rawResult }
        );
      } finally {
        rawResult?.destroy?.();
      }
    }
    const resultParseStartedAt = deps.performanceNow();
    const result = JSON.parse(resultJson);
    if (prepared?.scopeTimings) {
      prepared.scopeTimings.resultParseMs +=
        deps.performanceNow() - resultParseStartedAt;
    }

    if (result.guardTriggered) {
      const structuredReasons = ['client-timeout', 'line-limit', 'single-line-limit', 'recursion-limit', 'memory-limit'];
      const reason = structuredReasons.includes(result.timeoutReason) ? result.timeoutReason : undefined;
      return {
        success: false,
        output: null,
        error: reason
          ? `Execution stopped: resource limit exceeded (${reason}).`
          : 'Execution stopped: resource limit exceeded.',
        ...(reason ? { timeoutReason: reason } : {}),
        consoleOutput: Array.isArray(result.console) ? result.console : [],
        timings: { totalMs: deps.performanceNow() - startedAt },
      };
    }

    if (result.executionError) {
      return {
        success: false,
        output: null,
        error: String(result.executionError.message ?? 'Python execution failed.'),
        ...(Number.isInteger(result.executionError.line)
          ? { errorLine: result.executionError.line }
          : {}),
        consoleOutput: [],
        timings: { totalMs: deps.performanceNow() - startedAt },
      };
    }

    if (result.serializationLimit === true) {
      return {
        success: false,
        output: null,
        error: 'Execution stopped: resource limit exceeded (serialization-limit).',
        timeoutReason: 'serialization-limit',
        consoleOutput: Array.isArray(result.console) ? result.console : [],
        timings: { totalMs: deps.performanceNow() - startedAt },
      };
    }

    return {
      success: true,
      output: result.output,
      consoleOutput: Array.isArray(result.console) ? result.console : [],
      timings: { totalMs: deps.performanceNow() - startedAt },
    };
  } catch (error) {
    const rawError = pythonErrorText(error);
    const { message, line } = parsePythonError(rawError, userCodeStartLine, userCodeLineCount);

    return {
      success: false,
      output: null,
      error: message,
      errorLine: line,
      consoleOutput: [],
      timings: { totalMs: deps.performanceNow() - startedAt },
    };
  }
}

async function prepareProgram(
  deps,
  {
    mode,
    code,
    functionName,
    executionStyle = 'function',
    traceOptions = {},
  }
) {
  const startedAt = deps.performanceNow();
  let userCodeObject;
  let executorCode;
  let algorithmFastBatchCode;

  try {
    await deps.loadPyodideInstance();
    const isolationProfile = pythonAlgorithmIsolationProfile(
      deps,
      code,
      functionName,
      executionStyle
    );

    if (mode === 'trace') {
      const compilePayload = generateTracingCode(
        deps,
        code,
        functionName,
        {},
        executionStyle,
        traceOptions,
        { compileUserOnly: true, onDemand: true }
      );
      const compileDriver = await compilePythonProgram(
        deps,
        compilePayload.code,
        '<tracecode-trace-prepare>'
      );
      try {
        userCodeObject = await runCompiledPythonInFreshExecutionScope(
          deps,
          compileDriver,
          '__tracecode_prepared_user_code_result'
        );
      } finally {
        compileDriver?.destroy?.();
      }

      const executionPayload = await executeWithTracing(
        deps,
        code,
        functionName,
        {},
        executionStyle,
        traceOptions,
        { compileOnly: true }
      );
      const codeExecutionPayload = await executeCode(
        deps,
        code,
        functionName ?? '',
        {},
        executionStyle,
        {},
        { compileOnly: true }
      );
      const executorCompiler = await compilePythonProgram(
        deps,
        buildOnDemandPythonExecutorCompilerSource(
          deps,
          executionPayload.__preparedSource,
          codeExecutionPayload.__preparedSource
        ),
        '<tracecode-prepared-trace-compiler>'
      );
      try {
        executorCode = await runCompiledPythonInFreshExecutionScope(
          deps,
          executorCompiler,
          '__tracecode_prepared_executor_result'
        );
      } finally {
        executorCompiler?.destroy?.();
      }
    } else if (mode === 'code') {
      userCodeObject = await compilePythonProgram(deps, code, 'solution.py');
      const executionPayload = await executeCode(
        deps,
        code,
        functionName ?? '',
        {},
        executionStyle,
        {},
        { compileOnly: true }
      );
      executorCode = await compilePythonProgram(
        deps,
        executionPayload.__preparedSource,
        '<tracecode-prepared-code>'
      );
    } else {
      throw new Error(`Unsupported prepared Python mode: ${String(mode)}`);
    }

    if (mode === 'code' && isolationProfile.tier === 'algorithm-fast') {
      algorithmFastBatchCode = await compilePythonProgram(
        deps,
        buildPythonAlgorithmFastBatchSource(
          deps,
          functionName ?? '',
          executionStyle
        ),
        '<tracecode-algorithm-fast-batch>'
      );
    }

    const fingerprint = pythonPreparedArtifactFingerprint(deps);
    const artifact = {
      schemaVersion: 'tracecode.python.prepared-program.v4',
      fingerprint,
      mode,
      code,
      functionName: functionName ?? null,
      executionStyle,
      traceOptions,
      onDemandTracing: mode === 'trace',
      isolationProfile,
      ...(algorithmFastBatchCode
        ? {
            algorithmFastBatchCode: serializePythonCodeArtifact(
              deps,
              algorithmFastBatchCode
            ),
          }
        : {}),
      userCode: serializePythonCodeArtifact(deps, userCodeObject),
      executorCode: serializePythonCodeArtifact(deps, executorCode),
    };
    const preparationMs = deps.performanceNow() - startedAt;
    return {
      success: true,
      mode,
      artifact,
      consoleOutput: [],
      timings: {
        totalMs: preparationMs,
        compileMs: preparationMs,
        compileCacheHit: false,
        artifactCacheHit: false,
      },
    };
  } catch (error) {
    const rawError = pythonErrorText(error);
    const parsed = parsePythonError(rawError, 1, code.split('\n').length);
    const preparationMs = deps.performanceNow() - startedAt;
    return {
      success: false,
      error: parsed.message,
      errorLine: parsed.line,
      consoleOutput: [],
      timings: {
        totalMs: preparationMs,
        compileMs: preparationMs,
        compileCacheHit: false,
        artifactCacheHit: false,
      },
    };
  } finally {
    algorithmFastBatchCode?.destroy?.();
    executorCode?.destroy?.();
    userCodeObject?.destroy?.();
  }
}

function assertPythonPreparedArtifact(deps, artifact) {
  if (
    !artifact ||
    typeof artifact !== 'object' ||
    artifact.schemaVersion !== 'tracecode.python.prepared-program.v4' ||
    (artifact.mode !== 'code' && artifact.mode !== 'trace') ||
    typeof artifact.code !== 'string' ||
    typeof artifact.userCode !== 'string' ||
    typeof artifact.executorCode !== 'string' ||
    !artifact.isolationProfile ||
    (artifact.isolationProfile.tier !== 'algorithm-fast' &&
      artifact.isolationProfile.tier !== 'judge-compatible' &&
      artifact.isolationProfile.tier !== 'hard-isolated') ||
    !Array.isArray(artifact.isolationProfile.reasons) ||
    (artifact.mode === 'code' &&
      artifact.isolationProfile.tier === 'algorithm-fast' &&
      typeof artifact.algorithmFastBatchCode !== 'string')
  ) {
    throw new Error(
      'Invalid prepared Python artifact: ' + JSON.stringify({
        schemaVersion: artifact?.schemaVersion,
        mode: artifact?.mode,
        hasCode: typeof artifact?.code === 'string',
        hasUserCode: typeof artifact?.userCode === 'string',
        hasExecutorCode: typeof artifact?.executorCode === 'string',
        isolationProfile: artifact?.isolationProfile,
      })
    );
  }
  const current = pythonPreparedArtifactFingerprint(deps);
  const expected = artifact.fingerprint;
  if (
    !expected ||
    expected.cacheTag !== current.cacheTag ||
    expected.magicNumber !== current.magicNumber ||
    expected.marshalVersion !== current.marshalVersion
  ) {
    throw new Error(
      'Prepared Python artifact does not match the active interpreter generation.'
    );
  }
}

function pythonCodeResultAsEmptyTraceResult(result) {
  return {
    ...result,
    trace: {
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'python',
      runId: 'python:run',
      events: [],
      lineEventCount: 0,
      traceStepCount: 0,
    },
    executionTimeMs: result?.timings?.totalMs ?? 0,
    lineEventCount: 0,
    traceStepCount: 0,
  };
}

async function executePreparedProgram(
  deps,
  artifact,
  inputs,
  limits,
  tracingEnabled = artifact?.mode === 'trace'
) {
  const startedAt = deps.performanceNow();
  await deps.loadPyodideInstance();
  assertPythonPreparedArtifact(deps, artifact);
  let userCodeObject;
  let executorCode;
  try {
    userCodeObject = deserializePythonCodeArtifact(deps, artifact.userCode);
    executorCode = deserializePythonCodeArtifact(deps, artifact.executorCode);
    if (
      artifact.mode === 'trace' &&
      tracingEnabled === false &&
      artifact.onDemandTracing !== true
    ) {
      throw new Error(
        'Prepared Python artifact does not support on-demand trace selection.'
      );
    }
    const result = artifact.mode === 'trace' && tracingEnabled !== false
      ? await executeWithTracing(
          deps,
          artifact.code,
          artifact.functionName,
          inputs,
          artifact.executionStyle ?? 'function',
          artifact.traceOptions ?? {},
          {
            executorCode,
            userCodeObject,
            limits,
            tracingEnabled: true,
            isolationTier: 'compatibility',
          }
        )
      : await executeCode(
          deps,
          artifact.code,
          artifact.functionName ?? '',
          inputs,
          artifact.executionStyle ?? 'function',
          limits?.guest ?? {},
          {
            executorCode,
            userCodeObject,
            tracingEnabled: false,
            isolationTier: 'compatibility',
          }
        );
    const runMs = deps.performanceNow() - startedAt;
    const normalizedResult = artifact.mode === 'trace' && tracingEnabled === false
      ? pythonCodeResultAsEmptyTraceResult(result)
      : result;
    return {
      ...normalizedResult,
      timings: {
        ...(normalizedResult.timings ?? {}),
        totalMs: runMs,
        runMs,
        compileCacheHit: true,
        artifactCacheHit: true,
      },
    };
  } finally {
    executorCode?.destroy?.();
    userCodeObject?.destroy?.();
  }
}

async function executePreparedProgramBatch(
  deps,
  artifact,
  inputBatch,
  limits,
  traceEnabledBatch = undefined,
  forceJudgeCompatible = false
) {
  const startedAt = deps.performanceNow();
  await deps.loadPyodideInstance();
  assertPythonPreparedArtifact(deps, artifact);
  const cases = Array.isArray(inputBatch)
    ? inputBatch.map((inputs) =>
        inputs && typeof inputs === 'object' && !Array.isArray(inputs)
          ? inputs
          : {}
      )
    : [];
  if (cases.length === 0) {
    return {
      success: false,
      results: [],
      error: 'Prepared Python batch execution requires a non-empty inputBatch array.',
      consoleOutput: [],
      timings: { totalMs: deps.performanceNow() - startedAt },
    };
  }
  if (
    traceEnabledBatch !== undefined &&
    (
      artifact.mode !== 'trace' ||
      artifact.onDemandTracing !== true ||
      !Array.isArray(traceEnabledBatch) ||
      traceEnabledBatch.length !== cases.length ||
      traceEnabledBatch.some((enabled) => typeof enabled !== 'boolean')
    )
  ) {
    throw new Error(
      'Prepared Python trace selection must contain one boolean per batch case.'
    );
  }

  let userCodeObject;
  let executorCode;
  let algorithmFastBatchCode;
  try {
    // Deserialize only the immutable artifacts used by the selected path.
    // The fast batch has its own driver and does not pay to hydrate the
    // compatibility executor or the separately marshaled learner code.
    const isAlgorithmFastArtifact =
      artifact.mode === 'code' &&
      artifact.isolationProfile.tier === 'algorithm-fast' &&
      typeof artifact.algorithmFastBatchCode === 'string';
    const currentIsolationProfile = pythonAlgorithmIsolationProfile(
      deps,
      artifact.code,
      artifact.functionName ?? '',
      artifact.executionStyle ?? 'function'
    );
    if (currentIsolationProfile.tier !== artifact.isolationProfile.tier) {
      const runMs = deps.performanceNow() - startedAt;
      return {
        success: false,
        results: [],
        error: 'Prepared Python artifact isolation profile does not match its source.',
        consoleOutput: [],
        algorithmFastBatchUnavailable: true,
        algorithmFastBatchFailureClass: 'capability-fallback',
        timings: {
          totalMs: runMs,
          runMs,
          compileCacheHit: true,
          artifactCacheHit: true,
        },
      };
    }
    if (currentIsolationProfile.tier === 'hard-isolated') {
      const runMs = deps.performanceNow() - startedAt;
      return {
        success: false,
        results: [],
        error: 'Prepared Python hard-isolated programs require a fresh outer worker per case.',
        consoleOutput: [],
        algorithmFastBatchUnavailable: true,
        algorithmFastBatchFailureClass: 'capability-fallback',
        timings: {
          totalMs: runMs,
          runMs,
          compileCacheHit: true,
          artifactCacheHit: true,
        },
      };
    }
    const useAlgorithmFastBatch =
      isAlgorithmFastArtifact &&
      forceJudgeCompatible !== true &&
      currentIsolationProfile.tier === 'algorithm-fast' &&
      cases.every((inputs) => !pythonInputsRequireCustomMaterialization(inputs));
    if (useAlgorithmFastBatch) {
      try {
        algorithmFastBatchCode = deserializePythonCodeArtifact(
          deps,
          artifact.algorithmFastBatchCode
        );
        const resultJson = await runCompiledPythonInFreshExecutionScope(
          deps,
          algorithmFastBatchCode,
          '_json_out',
          {
            __tracecode_prepared_user_source: artifact.code,
            __tracecode_input_batch_literal: preparedPythonLiteral(deps, cases),
            __tracecode_limits_literal: preparedPythonLiteral(
              deps,
              limits?.guest ?? {}
            ),
          },
          undefined,
          'algorithm-fast'
        );
        const results = JSON.parse(resultJson);
        const resultsHaveTrustedShape =
          Array.isArray(results) &&
          results.length === cases.length &&
          results.every((result) =>
            result !== null &&
            typeof result === 'object' &&
            !Array.isArray(result) &&
            typeof result.success === 'boolean' &&
            Object.hasOwn(result, 'output') &&
            Array.isArray(result.consoleOutput) &&
            result.timings !== null &&
            typeof result.timings === 'object' &&
            result.timings.algorithmFastBatch === true
          );
        if (!resultsHaveTrustedShape) {
          throw new Error(
            'Prepared Python algorithm-fast batch returned an invalid result envelope.'
          );
        }
        const runMs = deps.performanceNow() - startedAt;
        return {
          success: results.every((result) => result?.success === true),
          results,
          consoleOutput: results.flatMap(
            (result) => result?.consoleOutput ?? []
          ),
          timings: {
            totalMs: runMs,
            runMs,
            compileCacheHit: true,
            artifactCacheHit: true,
            algorithmFastBatch: true,
          },
        };
      } catch (error) {
        // No partial batch result has crossed the worker boundary. Ask the
        // provider to retire this worker and retry each case in its own full
        // compatibility scope instead of exposing an internal driver error.
        const runMs = deps.performanceNow() - startedAt;
        deps.emitRuntimeDiagnostic?.(
          'error',
          'algorithm-fast-batch-fallback',
          'Python algorithm-fast batch driver failed; requesting hard isolation.',
          {
            caseCount: cases.length,
            runMs,
            failureClass:
              error instanceof Error ? 'runtime-error' : 'non-error',
          }
        );
        return {
          success: false,
          results: [],
          error: 'Prepared Python algorithm-fast batch requires hard isolation.',
          consoleOutput: [],
          algorithmFastBatchUnavailable: true,
          algorithmFastBatchFailureClass: 'driver-failure',
          timings: {
            totalMs: runMs,
            runMs,
            compileCacheHit: true,
            artifactCacheHit: true,
          },
        };
      }
    }
    userCodeObject = deserializePythonCodeArtifact(deps, artifact.userCode);
    executorCode = deserializePythonCodeArtifact(deps, artifact.executorCode);
    const results = [];
    // Trace execution and node/custom-input fallbacks still use the generic
    // executor, so they retain the full compatibility guard and filesystem
    // journal even when the source also qualified for code-batch admission.
    const filesystem = isolatedPythonFilesystemManager(deps.getPyodide());
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const inputs = cases[caseIndex];
      const scopeTimings = {
        inputLiteralMs: 0,
        namespaceCreateMs: 0,
        guardBeginMs: 0,
        bindingMs: 0,
        compiledExecutionMs: 0,
        guardRestoreMs: 0,
        namespaceDestroyMs: 0,
        resultParseMs: 0,
        filesystemBeginMs: 0,
        filesystemRestoreMs: 0,
      };
      const tracingEnabled = artifact.mode === 'trace'
        ? (traceEnabledBatch?.[caseIndex] ?? true)
        : false;
      const filesystemBeginStartedAt = deps.performanceNow();
      filesystem?.begin();
      scopeTimings.filesystemBeginMs +=
        deps.performanceNow() - filesystemBeginStartedAt;
      let result;
      try {
        result = artifact.mode === 'trace' && tracingEnabled
          ? await executeWithTracing(
              deps,
              artifact.code,
              artifact.functionName,
              inputs,
              artifact.executionStyle ?? 'function',
              artifact.traceOptions ?? {},
              {
                executorCode,
                userCodeObject,
                limits,
                tracingEnabled: true,
                scopeTimings,
                isolationTier: 'compatibility',
              }
            )
          : await executeCode(
              deps,
              artifact.code,
              artifact.functionName ?? '',
              inputs,
              artifact.executionStyle ?? 'function',
              limits?.guest ?? {},
              {
                executorCode,
                userCodeObject,
                tracingEnabled: false,
                scopeTimings,
                isolationTier: 'compatibility',
              }
            );
      } finally {
        const filesystemRestoreStartedAt = deps.performanceNow();
        filesystem?.restore();
        scopeTimings.filesystemRestoreMs +=
          deps.performanceNow() - filesystemRestoreStartedAt;
      }
      const timedResult = {
        ...result,
        timings: {
          ...(result?.timings ?? {}),
          ...scopeTimings,
        },
      };
      results.push(
        artifact.mode === 'trace' && !tracingEnabled
          ? pythonCodeResultAsEmptyTraceResult(timedResult)
          : timedResult
      );
    }
    const runMs = deps.performanceNow() - startedAt;
    return {
      success: results.every((result) => result.success === true),
      results,
      consoleOutput: results.flatMap((result) => result.consoleOutput ?? []),
      timings: {
        totalMs: runMs,
        runMs,
        compileCacheHit: true,
        artifactCacheHit: true,
      },
    };
  } finally {
    algorithmFastBatchCode?.destroy?.();
    executorCode?.destroy?.();
    userCodeObject?.destroy?.();
  }
}

  globalScope.__TRACECODE_PYODIDE_RUNTIME__ = {
    buildOnDemandPythonExecutorCompilerSource,
    generateTracingCode,
    parsePythonError,
    executeWithTracing,
    executeCode,
    prepareProgram,
    executePreparedProgram,
    executePreparedProgramBatch,
  };
})(typeof self !== 'undefined' ? self : globalThis);
