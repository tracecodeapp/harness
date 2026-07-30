# `@tracecode/runtime-python`

Python runtime helpers and browser worker assets for TraceCode Harness.

This is a private implementation workspace used to build the root release. It
is not published independently, and the root package has no `/python`
subpath. Code inside this monorepo imports it directly:

```ts
import {
  PythonWorkerClient,
  createPythonPreparedExecutionProvider,
  createPythonRuntimeClient,
  generateSolutionScript,
} from '@tracecode/runtime-python';
```

Internal workspace surface:

- Python harness template helpers
- generated snippet exports
- Python-side serialization helpers used by the runtime/tests
- browser worker client and runtime client
- prepare-once code and trace execution backed by interpreter-fingerprinted,
  marshaled CPython code artifacts
- hard per-case isolation: each artifact runs in an owned, prewarmed worker
  generation that is retired after the case
- separate reset and final-termination lifecycles, so language release aborts
  current work and resources without preventing a later Python initialization

Published browser consumers select Python through the provider-neutral runtime
host and Judge contracts. Browser project consumers use
`@tracecode/harness/browser/project`; neither path exposes Python runtime
clients directly.

Runtime assets are shipped at `workers/python-worker.js` and
`workers/python/runtime-core.js`. Review `THIRD_PARTY_NOTICES.md` before
redistributing the root package, especially the Python runtime and CPython
sections.
