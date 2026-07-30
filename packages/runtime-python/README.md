# `@tracecode/runtime-python`

Python runtime helpers and browser worker assets for TraceCode Harness.

This is a private workspace bundled into the published root package. Consumers
use the supported root subpath:

```ts
import {
  PythonWorkerClient,
  createPythonPreparedExecutionProvider,
  createPythonRuntimeClient,
  generateSolutionScript,
} from '@tracecode/harness/python';
```

Public surface:

- Python harness template helpers
- generated snippet exports
- Python-side serialization helpers used by the runtime/tests
- browser worker client and runtime client
- prepare-once code and trace execution backed by interpreter-fingerprinted,
  marshaled CPython code artifacts
- hard per-case isolation: each artifact runs in an owned, prewarmed worker
  generation that is retired after the case

Runtime assets are shipped at `workers/python-worker.js` and
`workers/python/runtime-core.js`. Review `THIRD_PARTY_NOTICES.md` before
redistributing the root package, especially the Python runtime and CPython
sections.
