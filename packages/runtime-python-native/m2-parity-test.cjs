// M2 serializer parity test: native emit vs python _serialize + json encoder.
// Run from the repo root: node packages/runtime-python-native/m2-parity-test.cjs
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
globalThis.require = require;
globalThis.__dirname = path.join(root, 'workers/python/pyodide-0.29.3');
(0, eval)(fs.readFileSync(path.join(root, 'workers/python/pyodide-0.29.3/pyodide.js'), 'utf8'));

const TEST = `
import json, math, _tracecode_native as native

# Reference implementations lifted verbatim from the runtime serializer
# (PYTHON_TRACE_SERIALIZE_FUNCTION in generated-python-harness-snippets.js),
# trimmed to the shapes this test exercises plus the repr fallback.
_SKIP_SENTINEL = "__TRACECODE_SKIP__"
_MAX_SERIALIZE_DEPTH = 48
_MAX_SERIALIZED_ITEMS = 64
_MAX_SERIALIZED_STRING_CHARS = 16384
import builtins as _builtins

def _serialize_string(value):
    if len(value) <= _MAX_SERIALIZED_STRING_CHARS:
        return value
    remaining = len(value) - _MAX_SERIALIZED_STRING_CHARS
    return value[:_MAX_SERIALIZED_STRING_CHARS] + f"\\u2026<truncated {remaining} chars>"

def _truncation_marker(total, emitted):
    return {"__truncated__": True, "remaining": max(0, total - emitted)}

def _serialize_repr_fallback(obj):
    obj_type = getattr(obj, '__class__', None)
    class_name = getattr(obj_type, '__name__', 'object')
    if getattr(obj_type, '__module__', '') == 'builtins':
        try:
            repr_str = repr(obj)
        except Exception:
            return _SKIP_SENTINEL
        if repr_str.startswith('<') and repr_str.endswith('>'):
            return _SKIP_SENTINEL
        return _serialize_string(repr_str)
    return {"__type__": class_name, "__class__": class_name}

def _serialize(obj, depth=0, node_refs=None):
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
        values_list = _builtins.list(obj)
        emitted = min(len(values_list), _MAX_SERIALIZED_ITEMS)
        result = [_serialize(x, depth + 1, node_refs) for x in values_list[:emitted]]
        if emitted < len(values_list):
            result.append(_truncation_marker(len(values_list), emitted))
        return result
    elif isinstance(obj, _builtins.dict):
        items = _builtins.list(obj.items())
        emitted = min(len(items), _MAX_SERIALIZED_ITEMS)
        result = {_serialize_string(str(k)): _serialize(v, depth + 1, node_refs) for k, v in items[:emitted]}
        if emitted < len(items):
            result["__truncated__"] = True
            result["remaining"] = len(items) - emitted
        return result
    elif callable(obj):
        return _SKIP_SENTINEL
    else:
        return _serialize_repr_fallback(obj)

_ENC = json.JSONEncoder(ensure_ascii=False, separators=(',', ':'))

native.configure(frozenset(), _serialize, _ENC.encode, _SKIP_SENTINEL)

class Weird:
    pass

cases = {
    'ints': {'a': 0, 'b': -1, 'c': 2**80, 'd': True, 'e': False, 'f': None},
    'floats': {'a': 1.0, 'b': 0.1, 'c': -2.5e300, 'd': float('nan'), 'e': float('inf'), 'f': float('-inf'), 'g': 1e16, 'h': 5e-324},
    'strings': {'a': '', 'b': 'plain', 'c': 'quote"back\\\\slash', 'd': 'ctrl\\x01\\x1f\\n\\t', 'e': 'unicode \\u00fc\\u2603\\U0001f600', 'f': 'x' * 20000},
    'lists': {'a': [], 'b': [1, 2.5, 'x', None, True], 'c': list(range(100)), 'd': [[1, [2, [3]]]], 'e': (1, 2)},
    'depth': {'a': eval('[' * 60 + ']' * 60)},
    'exotic': {'a': {'k': 1, 2: 'v'}, 'b': Weird(), 'c': len, 'd': {1, 2, 3}, 'e': [len, 1]},
}

failures = []
for label, local_dict in cases.items():
    native.begin_run(10_000, 10_000_000, 1_000_000)
    reps = native.emit_snapshot_events(dict(local_dict), '{"p":1')
    buffer = native.take_buffer()
    native_events = json.loads('[' + buffer + ']') if buffer else []
    expected_events = []
    expected_reps = {}
    for name, value in local_dict.items():
        rep = _serialize(value)
        if rep == _SKIP_SENTINEL:
            continue
        expected_reps[name] = rep
        expected_events.append(json.loads('{"p":1' + ',"kind":"snapshot","target":{"variable":' + _ENC.encode(name) + '},"value":' + _ENC.encode(rep) + '}'))
    if native_events != expected_events:
        failures.append((label, 'events', str(native_events)[:400], str(expected_events)[:400]))
    if reps != expected_reps:
        failures.append((label, 'reps', str(reps)[:400], str(expected_reps)[:400]))
    # byte-level check too: rebuild expected json text exactly
    expected_text = ','.join(
        '{"p":1' + ',"kind":"snapshot","target":{"variable":' + _ENC.encode(name) + '},"value":' + _ENC.encode(rep) + '}'
        for name, rep in expected_reps.items()
    )
    if buffer != expected_text:
        failures.append((label, 'bytes', buffer[:400], expected_text[:400]))

json.dumps({'failures': failures, 'ok': not failures})
`;

(async () => {
  const pyodide = await globalThis.loadPyodide({ indexURL: path.join(root, 'workers/python/pyodide-0.29.3') + path.sep });
  await pyodide.loadPackage(
    pathToFileURL(path.join(__dirname, 'dist/tracecode_native-0.1.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl')).href
  );
  const result = JSON.parse(pyodide.runPython(TEST));
  if (!result.ok) {
    console.error('PARITY FAILURES:');
    for (const failure of result.failures) console.error(JSON.stringify(failure, null, 1));
    process.exit(1);
  }
  console.log('parity: all cases byte-identical');
})().catch((error) => {
  console.error('FAIL:', error);
  process.exit(1);
});
