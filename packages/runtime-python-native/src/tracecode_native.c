// TraceCode native tracer for Pyodide — M0 skeleton.
// See docs/python-native-tracer-plan.md for the architecture this grows into.
#define PY_SSIZE_T_CLEAN
#include <Python.h>

static PyObject* ping(PyObject* self, PyObject* args) {
  (void)self;
  (void)args;
  return PyLong_FromLong(1);
}

static PyMethodDef TracecodeNativeMethods[] = {
  {"ping", ping, METH_NOARGS, "Toolchain liveness probe."},
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
