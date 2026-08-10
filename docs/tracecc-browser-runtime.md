# TraceCC browser runtime

[TraceCC](https://github.com/tracecodeapp/tracecc) is the C/C++ toolchain used
internally by TraceKernel in the browser. Its repository
owns the pinned LLVM-derived compiler reactor, sysroot, downstream patches,
reproducible build, generic compile/link protocol, and corresponding-source
release. The harness owns only the TraceKernel adapter, TraceCode runtime
header, PCH profiles, and matching runtime objects.

## Runtime architecture

The browser runtime has two separate lifecycles:

- one trusted compiler service remains warm across compilations
- compiled learner modules execute only in disposable TraceKernel runners

The compiler receives source plus integrity-pinned immutable assets and returns
a transferable WebAssembly module. It never instantiates learner output and it
does not receive learner process, terminal, socket, or filesystem capabilities.
Practice, Judge, and Project use this same compiler service. Project requests
support C and C++ translation units, headers, include paths, preprocessor
definitions, object output and linking, explicit output paths, and nested
working directories.

Judge remains a TraceKernel consumer. TraceCC changes the compiler authority and
lifecycle, not the execution or isolation boundary.

## Assets

Applications install only `@tracecode/harness`, run `tracecode-harness
sync-assets`, and serve the resulting `/workers` tree. The Harness release pins
the exact TraceCC package. Asset sync copies its owned release beneath
`/workers/cpp/tracecc/<content-hash>/`; ordinary applications do not publish
compiler assets or construct a C++ manifest.

Harness maintainers create that content-addressed browser directory from a
TraceCC release and the matching TraceCode PCH directory:

```sh
TRACECC_RELEASE_DIR=/path/to/tracecc-release \
TRACECC_PCH_DIR=/path/to/tracecode-pch-shards \
TRACECC_ASSET_OUTPUT_ROOT=/path/to/output \
pnpm prepare:tracecc-assets
```

The command verifies every digest, writes the pinned runtime manifest, and
refuses output whose consumer hash differs from
`TRACECC_RUNTIME_CONTENT_HASH`. TraceCC's package release stores the generated
hash directory at:

```text
/workers/cpp/tracecc/<content-hash>/
```

An `assetBaseUrl` override moves this same pinned tree to another origin. There
is no client-side rollout flag or alternate compiler fallback.

The complete release is 144,798,363 raw bytes. The initial narrow profile is
85,175,315 raw bytes; broad and map PCH/object profiles load lazily. Measured
independently, the full directory is 58,231,063 gzip bytes or 47,839,149 Brotli
quality-5 bytes. The narrow route is 28,030,257 gzip bytes or 23,168,265 Brotli
bytes.

## Compatibility

The immutable manifest is the compatibility boundary:

- TraceKernel or Judge changes do not rebuild LLVM.
- A runtime-header ABI change rebuilds only the consumer PCH/object assets.
- Compiler and consumer assets fail closed when hashes or integrity metadata
  drift.

The current Chromium gates cover consecutive warm edits, a 200-problem
correctness corpus, generic multi-file C++ Project compilation, C object
compilation/linking, nested working directories, and the authenticated app
Project path. The 200-problem run matched its baseline for preparation, result
kind, output, trace event count, and trace hash.
