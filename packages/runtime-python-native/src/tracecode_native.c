// TraceCode native tracer for Pyodide — M0 skeleton.
// See docs/python-native-tracer-plan.md for the architecture this grows into.
#define PY_SSIZE_T_CLEAN
#include <Python.h>

static PyObject* ping(PyObject* self, PyObject* args) {
  (void)self;
  (void)args;
  return PyLong_FromLong(1);
}

// M1: minimal LINE callback — measures the native monitoring-callback floor
// (callback dispatch + C entry, no recording work).
static long long line_probe_hits = 0;

static PyObject* line_probe(PyObject* self, PyObject* const* args, Py_ssize_t nargs) {
  (void)self;
  (void)args;
  (void)nargs;
  line_probe_hits += 1;
  Py_RETURN_NONE;
}

static PyObject* line_probe_count(PyObject* self, PyObject* args) {
  (void)self;
  (void)args;
  return PyLong_FromLongLong(line_probe_hits);
}

static PyObject* line_probe_reset(PyObject* self, PyObject* args) {
  (void)self;
  (void)args;
  line_probe_hits = 0;
  Py_RETURN_NONE;
}

static PyMethodDef TracecodeNativeMethods[] = {
  {"ping", ping, METH_NOARGS, "Toolchain liveness probe."},
  {"line_probe", (PyCFunction)(void (*)(void))line_probe, METH_FASTCALL,
   "sys.monitoring LINE callback that only counts."},
  {"line_probe_count", line_probe_count, METH_NOARGS, "Probe hit count."},
  {"line_probe_reset", line_probe_reset, METH_NOARGS, "Reset probe count."},
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
