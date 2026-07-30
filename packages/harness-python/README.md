# `@tracecode/harness-python`

Python runtime helpers and browser worker assets for TraceCode Harness.

Import path:

```ts
import { PythonWorkerClient, createPythonRuntimeClient, generateSolutionScript } from '@tracecode/harness-python';
```

Public surface:

- Python harness template helpers
- generated snippet exports
- Python-side serialization helpers used by the runtime/tests
- browser worker client and runtime client

The root package exposes the same Python surface at
`@tracecode/harness/python`.

Runtime assets are published at `workers/python-worker.js` and
`workers/python/runtime-core.js`. Review `THIRD_PARTY_NOTICES.md` before
redistributing this package, especially the Python runtime and CPython
sections.
