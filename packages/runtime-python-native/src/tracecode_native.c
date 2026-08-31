// TraceCode native tracer for Pyodide.
// See docs/python-native-tracer.md. This module owns the single-writer event
// buffer with exact budget accounting, a byte-parity value serializer for the
// hot types (python `_serialize` fallback for everything else), and native
// per-line snapshot emission that also returns the reps dict the python step
// machinery still consumes. Parity with the python implementations in
// workers/python/python-runtime.js is the hard requirement; every constant and
// formatting choice below mirrors that file.
#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <float.h>
#include <string.h>

// --- limits (mirror PYTHON_TRACE_SERIALIZE_FUNCTION) ---
#define TC_MAX_DEPTH 48
#define TC_MAX_ITEMS 64
#define TC_MAX_STRING_CHARS 16384

// ---------------------------------------------------------------------------
// growable byte buffer
// ---------------------------------------------------------------------------
typedef struct {
  char* data;
  size_t len;
  size_t cap;
} TcBuf;

static int tc_buf_reserve(TcBuf* buf, size_t extra) {
  if (buf->len + extra <= buf->cap) return 0;
  size_t cap = buf->cap ? buf->cap : 4096;
  while (cap < buf->len + extra) cap *= 2;
  char* data = PyMem_Realloc(buf->data, cap);
  if (!data) return -1;
  buf->data = data;
  buf->cap = cap;
  return 0;
}

static int tc_buf_append(TcBuf* buf, const char* bytes, size_t n) {
  if (tc_buf_reserve(buf, n) < 0) return -1;
  memcpy(buf->data + buf->len, bytes, n);
  buf->len += n;
  return 0;
}

static int tc_buf_append_cstr(TcBuf* buf, const char* s) {
  return tc_buf_append(buf, s, strlen(s));
}

static int tc_buf_append_char(TcBuf* buf, char c) {
  return tc_buf_append(buf, &c, 1);
}

static void tc_buf_clear(TcBuf* buf) { buf->len = 0; }

static void tc_buf_free(TcBuf* buf) {
  PyMem_Free(buf->data);
  buf->data = NULL;
  buf->len = buf->cap = 0;
}

// ---------------------------------------------------------------------------
// module state (single-threaded pyodide; plain statics are fine)
// ---------------------------------------------------------------------------
static TcBuf event_buffer;         // comma-joined event json array contents
static long long event_count = 0;  // events stored
static long long line_event_count = 0;
static long long stored_bytes = 0;
static long long max_stored_events = 0;
static long long max_trace_bytes = 0;
static long long max_event_bytes = 0;
static int limit_exceeded = 0;
static const char* timeout_reason = NULL;  // static strings only

static PyObject* internal_locals_set = NULL;    // frozenset of names
static PyObject* serialize_fallback = NULL;     // python _serialize
static PyObject* encode_fallback = NULL;        // python _TC_JSON_ENCODER.encode
static PyObject* skip_sentinel = NULL;          // "__TRACECODE_SKIP__"

// ---------------------------------------------------------------------------
// json string escaping — mirrors CPython json C encoder with ensure_ascii=False
// ---------------------------------------------------------------------------
static int tc_append_json_string(TcBuf* buf, PyObject* text) {
  Py_ssize_t utf8_len = 0;
  const char* utf8 = PyUnicode_AsUTF8AndSize(text, &utf8_len);
  if (!utf8) return -1;
  if (tc_buf_append_char(buf, '"') < 0) return -1;
  const char* chunk_start = utf8;
  for (Py_ssize_t i = 0; i < utf8_len; i++) {
    unsigned char c = (unsigned char)utf8[i];
    const char* escape = NULL;
    char unicode_escape[8];
    if (c == '"') escape = "\\\"";
    else if (c == '\\') escape = "\\\\";
    else if (c < 0x20) {
      switch (c) {
        case '\b': escape = "\\b"; break;
        case '\t': escape = "\\t"; break;
        case '\n': escape = "\\n"; break;
        case '\f': escape = "\\f"; break;
        case '\r': escape = "\\r"; break;
        default:
          snprintf(unicode_escape, sizeof(unicode_escape), "\\u%04x", c);
          escape = unicode_escape;
          break;
      }
    }
    if (escape) {
      if (tc_buf_append(buf, chunk_start, (utf8 + i) - chunk_start) < 0) return -1;
      if (tc_buf_append_cstr(buf, escape) < 0) return -1;
      chunk_start = utf8 + i + 1;
    }
  }
  if (tc_buf_append(buf, chunk_start, (utf8 + utf8_len) - chunk_start) < 0) return -1;
  return tc_buf_append_char(buf, '"');
}

// ---------------------------------------------------------------------------
// value serializer — emits json text AND returns the rep object python-side
// step machinery expects (scalars pass through; lists become fresh rep lists;
// anything exotic delegates to the python _serialize + encoder pair).
//
// Returns: 0 ok (rep set, json appended), 1 skip-sentinel (nothing appended),
// -1 error. `rep_out` receives a NEW reference when returning 0.
// ---------------------------------------------------------------------------
static int tc_serialize_value(
  TcBuf* buf,
  PyObject* value,
  int depth,
  PyObject* node_refs,
  PyObject** rep_out
);

static int tc_serialize_str(TcBuf* buf, PyObject* value, PyObject** rep_out) {
  Py_ssize_t chars = PyUnicode_GET_LENGTH(value);
  if (chars <= TC_MAX_STRING_CHARS) {
    if (tc_append_json_string(buf, value) < 0) return -1;
    Py_INCREF(value);
    *rep_out = value;
    return 0;
  }
  // _serialize_string: value[:16384] + f"…<truncated {remaining} chars>"
  // (PyUnicode_FromFormat requires an ASCII format string, so the ellipsis is
  // concatenated separately.)
  PyObject* head = PyUnicode_Substring(value, 0, TC_MAX_STRING_CHARS);
  if (!head) return -1;
  PyObject* suffix = PyUnicode_FromFormat(
    "<truncated %zd chars>", chars - TC_MAX_STRING_CHARS);
  if (!suffix) {
    Py_DECREF(head);
    return -1;
  }
  PyObject* ellipsis = PyUnicode_FromStringAndSize("\xe2\x80\xa6", 3);
  if (!ellipsis) {
    Py_DECREF(head);
    Py_DECREF(suffix);
    return -1;
  }
  PyObject* head_ellipsis = PyUnicode_Concat(head, ellipsis);
  Py_DECREF(head);
  Py_DECREF(ellipsis);
  if (!head_ellipsis) {
    Py_DECREF(suffix);
    return -1;
  }
  PyObject* truncated = PyUnicode_Concat(head_ellipsis, suffix);
  Py_DECREF(head_ellipsis);
  Py_DECREF(suffix);
  if (!truncated) return -1;
  if (tc_append_json_string(buf, truncated) < 0) {
    Py_DECREF(truncated);
    return -1;
  }
  *rep_out = truncated;
  return 0;
}

static int tc_serialize_float(TcBuf* buf, PyObject* value, PyObject** rep_out) {
  double d = PyFloat_AS_DOUBLE(value);
  if (Py_IS_NAN(d)) {
    if (tc_buf_append_cstr(buf, "\"NaN\"") < 0) return -1;
    *rep_out = PyUnicode_FromString("NaN");
    return *rep_out ? 0 : -1;
  }
  if (Py_IS_INFINITY(d)) {
    const char* text = d > 0 ? "Infinity" : "-Infinity";
    if (tc_buf_append_char(buf, '"') < 0 ||
        tc_buf_append_cstr(buf, text) < 0 ||
        tc_buf_append_char(buf, '"') < 0) return -1;
    *rep_out = PyUnicode_FromString(text);
    return *rep_out ? 0 : -1;
  }
  // json.dumps uses float.__repr__ ('r' mode, shortest round-trip, with .0)
  char* repr = PyOS_double_to_string(d, 'r', 0, Py_DTSF_ADD_DOT_0, NULL);
  if (!repr) return -1;
  int rc = tc_buf_append_cstr(buf, repr);
  PyMem_Free(repr);
  if (rc < 0) return -1;
  Py_INCREF(value);
  *rep_out = value;
  return 0;
}

static int tc_serialize_int(TcBuf* buf, PyObject* value, PyObject** rep_out) {
  int overflow = 0;
  long v = PyLong_AsLongAndOverflow(value, &overflow);
  if (!overflow && !(v == -1 && PyErr_Occurred())) {
    char digits[32];
    int n = snprintf(digits, sizeof(digits), "%ld", v);
    if (tc_buf_append(buf, digits, (size_t)n) < 0) return -1;
  } else {
    PyErr_Clear();
    PyObject* text = PyObject_Str(value);
    if (!text) return -1;
    int rc = tc_buf_append_cstr(buf, PyUnicode_AsUTF8(text));
    Py_DECREF(text);
    if (rc < 0) return -1;
  }
  Py_INCREF(value);
  *rep_out = value;
  return 0;
}

static int tc_append_truncation_marker(TcBuf* buf, Py_ssize_t emitted, Py_ssize_t total, PyObject* rep_list) {
  // append_trace_value_truncation_marker mirror; also appended to rep list.
  if (emitted >= total) return 0;
  if (emitted > 0 && tc_buf_append_char(buf, ',') < 0) return -1;
  char marker[64];
  int n = snprintf(marker, sizeof(marker),
                   "{\"__truncated__\":true,\"remaining\":%zd}", total - emitted);
  if (tc_buf_append(buf, marker, (size_t)n) < 0) return -1;
  if (rep_list) {
    PyObject* rep_marker = Py_BuildValue("{s:O,s:n}", "__truncated__", Py_True,
                                         "remaining", total - emitted);
    if (!rep_marker) return -1;
    int rc = PyList_Append(rep_list, rep_marker);
    Py_DECREF(rep_marker);
    if (rc < 0) return -1;
  }
  return 0;
}

static int tc_serialize_sequence(
  TcBuf* buf,
  PyObject* value,
  int depth,
  PyObject* node_refs,
  PyObject** rep_out
) {
  Py_ssize_t total = PySequence_Fast_GET_SIZE(value);
  Py_ssize_t emitted = total <= TC_MAX_ITEMS ? total : TC_MAX_ITEMS;
  PyObject* rep = PyList_New(0);
  if (!rep) return -1;
  if (tc_buf_append_char(buf, '[') < 0) goto fail;
  for (Py_ssize_t i = 0; i < emitted; i++) {
    if (i > 0 && tc_buf_append_char(buf, ',') < 0) goto fail;
    PyObject* item = PySequence_Fast_GET_ITEM(value, i);
    PyObject* item_rep = NULL;
    int rc = tc_serialize_value(buf, item, depth + 1, node_refs, &item_rep);
    if (rc < 0) goto fail;
    if (rc == 1) {
      // _serialize never skips INSIDE sequences: nested callables fall through
      // to repr fallback there. The fallback path handles it; a skip here
      // means our fast path diverged — bail to the python serializer.
      goto bail;
    }
    rc = PyList_Append(rep, item_rep);
    Py_DECREF(item_rep);
    if (rc < 0) goto fail;
  }
  if (tc_append_truncation_marker(buf, emitted, total, rep) < 0) goto fail;
  if (tc_buf_append_char(buf, ']') < 0) goto fail;
  *rep_out = rep;
  return 0;
bail:
  Py_DECREF(rep);
  return 2;  // caller falls back to python serializer
fail:
  Py_DECREF(rep);
  return -1;
}

// Python-serializer fallback: rep = _serialize(value, depth, node_refs),
// json = encoder(rep). The reference table belongs to the whole snapshot so
// aliases crossing local variables retain the same __id__/__ref__ topology.
static int tc_serialize_fallback(
  TcBuf* buf,
  PyObject* value,
  int depth,
  PyObject* node_refs,
  PyObject** rep_out
) {
  if (!serialize_fallback || !encode_fallback) {
    PyErr_SetString(PyExc_RuntimeError, "tracecode native serializer not configured");
    return -1;
  }
  PyObject* depth_arg = PyLong_FromLong(depth);
  if (!depth_arg) return -1;
  PyObject* rep = PyObject_CallFunctionObjArgs(
    serialize_fallback,
    value,
    depth_arg,
    node_refs,
    NULL
  );
  Py_DECREF(depth_arg);
  if (!rep) return -1;
  if (skip_sentinel) {
    int is_skip = PyObject_RichCompareBool(rep, skip_sentinel, Py_EQ);
    if (is_skip < 0) {
      Py_DECREF(rep);
      return -1;
    }
    if (is_skip) {
      Py_DECREF(rep);
      return 1;
    }
  }
  PyObject* text = PyObject_CallOneArg(encode_fallback, rep);
  if (!text) {
    Py_DECREF(rep);
    return -1;
  }
  Py_ssize_t utf8_len = 0;
  const char* utf8 = PyUnicode_AsUTF8AndSize(text, &utf8_len);
  int rc = utf8 ? tc_buf_append(buf, utf8, (size_t)utf8_len) : -1;
  Py_DECREF(text);
  if (rc < 0) {
    Py_DECREF(rep);
    return -1;
  }
  *rep_out = rep;
  return 0;
}

static int tc_serialize_value(
  TcBuf* buf,
  PyObject* value,
  int depth,
  PyObject* node_refs,
  PyObject** rep_out
) {
  if (value == Py_None) {
    if (tc_buf_append_cstr(buf, "null") < 0) return -1;
    Py_INCREF(Py_None);
    *rep_out = Py_None;
    return 0;
  }
  if (PyBool_Check(value)) {
    if (tc_buf_append_cstr(buf, value == Py_True ? "true" : "false") < 0) return -1;
    Py_INCREF(value);
    *rep_out = value;
    return 0;
  }
  // Exact types only: subclasses may have custom behavior the python
  // serializer resolves differently — fall back for those.
  if (PyLong_CheckExact(value)) return tc_serialize_int(buf, value, rep_out);
  if (PyUnicode_CheckExact(value)) return tc_serialize_str(buf, value, rep_out);
  if (PyFloat_CheckExact(value)) return tc_serialize_float(buf, value, rep_out);
  if (depth > TC_MAX_DEPTH) {
    if (tc_buf_append_cstr(buf, "\"<max depth>\"") < 0) return -1;
    *rep_out = PyUnicode_FromString("<max depth>");
    return *rep_out ? 0 : -1;
  }
  if (PyList_CheckExact(value) || PyTuple_CheckExact(value)) {
    size_t rollback = buf->len;
    int rc = tc_serialize_sequence(buf, value, depth, node_refs, rep_out);
    if (rc == 2) {
      buf->len = rollback;
      return tc_serialize_fallback(buf, value, depth, node_refs, rep_out);
    }
    return rc;
  }
  return tc_serialize_fallback(buf, value, depth, node_refs, rep_out);
}

// ---------------------------------------------------------------------------
// budgeted event append (mirrors __tracecode_append_runtime_event*)
// ---------------------------------------------------------------------------
static int tc_budget_append(const char* event, size_t event_len, int is_line) {
  if (event_count >= max_stored_events) {
    if (!limit_exceeded) {
      limit_exceeded = 1;
      timeout_reason = "trace-limit";
    }
    return 0;
  }
  long long event_bytes = (long long)event_len + (event_count > 0 ? 1 : 0);
  if (event_bytes > max_event_bytes || event_bytes > (max_trace_bytes - stored_bytes)) {
    if (!limit_exceeded) {
      limit_exceeded = 1;
      timeout_reason = "trace-byte-limit";
    }
    return 0;
  }
  if (event_count > 0 && tc_buf_append_char(&event_buffer, ',') < 0) return -1;
  if (tc_buf_append(&event_buffer, event, event_len) < 0) return -1;
  event_count += 1;
  if (is_line) line_event_count += 1;
  stored_bytes += event_bytes;
  return 1;
}

// ---------------------------------------------------------------------------
// python-facing API
// ---------------------------------------------------------------------------
static PyObject* configure(PyObject* self, PyObject* args) {
  (void)self;
  PyObject* internals = NULL;
  PyObject* serialize_cb = NULL;
  PyObject* encode_cb = NULL;
  PyObject* sentinel = NULL;
  if (!PyArg_ParseTuple(args, "OOOO", &internals, &serialize_cb, &encode_cb, &sentinel)) {
    return NULL;
  }
  Py_XDECREF(internal_locals_set);
  Py_XDECREF(serialize_fallback);
  Py_XDECREF(encode_fallback);
  Py_XDECREF(skip_sentinel);
  Py_INCREF(internals);
  Py_INCREF(serialize_cb);
  Py_INCREF(encode_cb);
  Py_INCREF(sentinel);
  internal_locals_set = internals;
  serialize_fallback = serialize_cb;
  encode_fallback = encode_cb;
  skip_sentinel = sentinel;
  Py_RETURN_NONE;
}

static PyObject* begin_run(PyObject* self, PyObject* args) {
  (void)self;
  long long max_events_arg = 0;
  long long max_bytes_arg = 0;
  long long max_event_bytes_arg = 0;
  long long initial_stored_bytes = 0;
  if (!PyArg_ParseTuple(args, "LLL|L", &max_events_arg, &max_bytes_arg,
                        &max_event_bytes_arg, &initial_stored_bytes)) {
    return NULL;
  }
  tc_buf_clear(&event_buffer);
  event_count = 0;
  line_event_count = 0;
  // The python counter seeds a small envelope reserve; mirror it exactly.
  stored_bytes = initial_stored_bytes;
  limit_exceeded = 0;
  timeout_reason = NULL;
  max_stored_events = max_events_arg;
  max_trace_bytes = max_bytes_arg;
  max_event_bytes = max_event_bytes_arg;
  Py_RETURN_NONE;
}

static PyObject* append_event_json(PyObject* self, PyObject* const* args, Py_ssize_t nargs) {
  (void)self;
  if (nargs < 1 || nargs > 2 || !PyUnicode_Check(args[0])) {
    PyErr_SetString(PyExc_TypeError, "append_event_json(text, is_line=False)");
    return NULL;
  }
  int is_line = nargs == 2 && PyObject_IsTrue(args[1]);
  Py_ssize_t utf8_len = 0;
  const char* utf8 = PyUnicode_AsUTF8AndSize(args[0], &utf8_len);
  if (!utf8) return NULL;
  int rc = tc_budget_append(utf8, (size_t)utf8_len, is_line);
  if (rc < 0) return PyErr_NoMemory();
  return PyBool_FromLong(rc);
}

// emit_snapshot_events(f_locals_dict, base_prefix) -> reps dict | None
// The caller passes an already-materialized locals dict (frame.f_locals in
// python materializes the 3.13 FrameLocalsProxy for us). None return means
// "python must handle this line" (budget already tripped mid-way is fine —
// budget parity is per-event and enforced inside).
static PyObject* emit_snapshot_events(PyObject* self, PyObject* const* args, Py_ssize_t nargs) {
  (void)self;
  if (nargs != 2 || !PyDict_Check(args[0]) || !PyUnicode_Check(args[1])) {
    PyErr_SetString(PyExc_TypeError, "emit_snapshot_events(locals_dict, base_prefix)");
    return NULL;
  }
  PyObject* locals_dict = args[0];
  Py_ssize_t prefix_len = 0;
  const char* prefix = PyUnicode_AsUTF8AndSize(args[1], &prefix_len);
  if (!prefix) return NULL;

  PyObject* reps = PyDict_New();
  if (!reps) return NULL;
  PyObject* node_refs = PyDict_New();
  if (!node_refs) {
    Py_DECREF(reps);
    return NULL;
  }

  TcBuf scratch = {0};
  PyObject* name = NULL;
  PyObject* value = NULL;
  Py_ssize_t pos = 0;
  while (PyDict_Next(locals_dict, &pos, &name, &value)) {
    if (!PyUnicode_Check(name)) continue;
    // _tracecode_is_internal_name mirror.
    if (internal_locals_set) {
      int contained = PySet_Contains(internal_locals_set, name);
      if (contained < 0) goto fail;
      if (contained) continue;
    }
    Py_ssize_t name_len = PyUnicode_GET_LENGTH(name);
    if (name_len >= 1 && PyUnicode_READ_CHAR(name, 0) == '_') {
      if (name_len == 1) continue;
      if (name_len >= 2 && PyUnicode_READ_CHAR(name, 1) == '_') continue;  // '__' prefix
      static PyObject* needle_lower = NULL;
      static PyObject* needle_upper = NULL;
      if (!needle_lower) needle_lower = PyUnicode_InternFromString("__tracecode");
      if (!needle_upper) needle_upper = PyUnicode_InternFromString("__Tracecode");
      if (!needle_lower || !needle_upper) goto fail;
      Py_ssize_t found_lower = PyUnicode_Find(name, needle_lower, 0, name_len, 1);
      if (found_lower == -2) goto fail;
      if (found_lower >= 0) continue;
      Py_ssize_t found_upper = PyUnicode_Find(name, needle_upper, 0, name_len, 1);
      if (found_upper == -2) goto fail;
      if (found_upper >= 0) continue;
    }

    tc_buf_clear(&scratch);
    if (tc_buf_append(&scratch, prefix, (size_t)prefix_len) < 0) goto fail;
    if (tc_buf_append_cstr(&scratch, ",\"kind\":\"snapshot\",\"target\":{\"variable\":") < 0) goto fail;
    if (tc_append_json_string(&scratch, name) < 0) goto fail;
    if (tc_buf_append_cstr(&scratch, "},\"value\":") < 0) goto fail;
    PyObject* rep = NULL;
    int rc = tc_serialize_value(&scratch, value, 0, node_refs, &rep);
    if (rc < 0) goto fail;
    if (rc == 1) continue;  // skip sentinel — omit variable entirely
    if (tc_buf_append_char(&scratch, '}') < 0) {
      Py_DECREF(rep);
      goto fail;
    }
    int appended = tc_budget_append(scratch.data, scratch.len, 0);
    if (appended < 0) {
      Py_DECREF(rep);
      PyErr_NoMemory();
      goto fail;
    }
    if (PyDict_SetItem(reps, name, rep) < 0) {
      Py_DECREF(rep);
      goto fail;
    }
    Py_DECREF(rep);
    if (!appended) break;  // budget tripped: stop emitting, mirror python loop
  }
  tc_buf_free(&scratch);
  Py_DECREF(node_refs);
  return reps;
fail:
  tc_buf_free(&scratch);
  Py_DECREF(node_refs);
  Py_DECREF(reps);
  return NULL;
}

static PyObject* take_buffer(PyObject* self, PyObject* args) {
  (void)self;
  (void)args;
  return PyUnicode_DecodeUTF8(event_buffer.data ? event_buffer.data : "", (Py_ssize_t)event_buffer.len, "strict");
}

static PyObject* stored_event_count(PyObject* self, PyObject* args) {
  (void)self;
  (void)args;
  return PyLong_FromLongLong(event_count);
}

static PyObject* counters(PyObject* self, PyObject* args) {
  (void)self;
  (void)args;
  return Py_BuildValue(
    "{s:L,s:L,s:L,s:i,s:s}",
    "events", event_count,
    "lineEvents", line_event_count,
    "storedBytes", stored_bytes,
    "limitExceeded", limit_exceeded,
    "timeoutReason", timeout_reason ? timeout_reason : "");
}

static PyObject* mark_limit_exceeded(PyObject* self, PyObject* args) {
  (void)self;
  const char* reason = NULL;
  if (!PyArg_ParseTuple(args, "s", &reason)) return NULL;
  if (!limit_exceeded) {
    limit_exceeded = 1;
    timeout_reason = strcmp(reason, "trace-byte-limit") == 0 ? "trace-byte-limit" : "trace-limit";
  }
  Py_RETURN_NONE;
}

static PyObject* ping(PyObject* self, PyObject* args) {
  (void)self;
  (void)args;
  return PyLong_FromLong(1);
}

static PyMethodDef TracecodeNativeMethods[] = {
  {"ping", ping, METH_NOARGS, "Toolchain liveness probe."},
  {"configure", configure, METH_VARARGS,
   "configure(internal_names_set, serialize_fallback, encode_fallback, skip_sentinel)"},
  {"begin_run", begin_run, METH_VARARGS,
   "begin_run(max_events, max_bytes, max_event_bytes) — reset per-run state."},
  {"append_event_json", (PyCFunction)(void (*)(void))append_event_json, METH_FASTCALL,
   "append_event_json(text, is_line=False) -> bool (False when budget trips)."},
  {"emit_snapshot_events", (PyCFunction)(void (*)(void))emit_snapshot_events, METH_FASTCALL,
   "emit_snapshot_events(locals_dict, base_prefix) -> reps dict."},
  {"take_buffer", take_buffer, METH_NOARGS, "Comma-joined event json array body."},
  {"stored_event_count", stored_event_count, METH_NOARGS, "Stored event count."},
  {"counters", counters, METH_NOARGS, "Run counters."},
  {"mark_limit_exceeded", mark_limit_exceeded, METH_VARARGS, "Set the budget flag."},
  {NULL, NULL, 0, NULL},
};

static struct PyModuleDef tracecode_native_module = {
  PyModuleDef_HEAD_INIT,
  "_tracecode_native",
  "TraceCode native tracing hot path.",
  -1,
  TracecodeNativeMethods,
  NULL,
  NULL,
  NULL,
  NULL,
};

PyMODINIT_FUNC PyInit__tracecode_native(void) {
  return PyModule_Create(&tracecode_native_module);
}
