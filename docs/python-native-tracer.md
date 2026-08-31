# Python native tracer

TraceCode ships a small CPython extension for the browser Python runtime. The
extension accelerates the tracing work that is expensive to perform in Python:
event buffering, budget accounting, serialization of common values, and
per-line snapshot emission. It does not create a second execution engine or a
second Judge path.

The authoritative implementation is split across:

- `workers/python/python-runtime.js`, which owns trace semantics and the
  Python fallback;
- `packages/runtime-python-native/src/tracecode_native.c`, which implements
  the native hot path;
- `packages/runtime-python-native/manifest.json`, which pins the Pyodide ABI,
  build recipe, wheel path, and wheel digest; and
- the vendored wheel under `workers/python/`, which is copied into published
  runtime packages and covered by the runtime asset lock.

## Runtime contract

The worker loads the wheel from its configured Python asset tree. If the wheel
cannot be loaded or imported, tracing falls back to the Python implementation.
The fallback is a resilience boundary, not a separate public profile: callers
request the same trace behavior either way.

The native and Python implementations must preserve these invariants:

- one ordered event stream across line, snapshot, and access events;
- byte-compatible serialization for supported values, including truncation,
  non-finite numbers, aliases, and reference topology;
- identical event, byte, per-event, and line-hit budget accounting;
- explicit per-run reset, because one Pyodide instance can execute many cases;
- no native module state crossing the prepared-program isolation boundary; and
- safe fallback for values the native serializer does not handle directly.

Any semantic change starts in `python-runtime.js`. The C implementation then
mirrors that behavior; it must never define an independent trace contract.

## Rebuilding the wheel

Use the exact versions and steps recorded in
`packages/runtime-python-native/manifest.json`. The target currently matches
the vendored Pyodide runtime: CPython 3.13 on the Pyodide 2025_0 wasm32 ABI.
The Emscripten toolchain must come from the matching Pyodide xbuild environment,
not from an unrelated system SDK.

After replacing the wheel:

1. update the wheel path and SHA-256 in the native manifest;
2. sync the language-package worker assets;
3. regenerate `runtime-assets.lock.json`; and
4. run the Python runtime, prepared-provider, browser-worker, asset-sync, and
   runtime-asset-lock gates.

The committed wheel and its manifest are one release unit. A locally built
wheel that is not reflected in both locations is not a valid Harness artifact.
