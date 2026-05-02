# C++ Runtime Dependency Contract

The C++ browser lane must stay language-specific. It should feel like the Java
lane's CheerpJ-specific worker pattern, not like a wrapper around a generic
multi-language container runtime.

## Requirements

1. Browser-local compile and run.
2. C++-specific or compiler-specific assets, not a generic app/container SDK.
3. Self-hostable or redistributable for the OSS harness and proprietary
   education product use.
4. Compatible with commercial educational use.
5. No server-side compile dependency.
6. Testable under Node using the same JavaScript and Wasm assets.
7. Testable in browser workers with Playwright.

## Candidate Order

1. Cheerp / LLVM / Clang / LLD / WASI custom package.
2. `wasm-clang`-style reference implementation owned or rebuilt by TraceCode.
3. Emscripten-built or LLVM-built compiler assets.
4. JSCPP fallback for an educational subset only.
5. Wasmer SDK only if all focused compiler paths fail.

## Initial Harness Shape

The checked-in scaffold owns these pieces:

```txt
workers/cpp/cpp-worker.js
workers/cpp/tracecode_runtime.hpp
packages/harness-browser/src/cpp-worker-client.ts
packages/harness-browser/src/cpp-runtime-client.ts
```

Preferred compiler assets:

```txt
workers/vendor/cpp/yowasp/bundle.js
workers/vendor/cpp/yowasp/llvm-resources.tar
workers/vendor/cpp/yowasp/llvm.core.wasm
workers/vendor/cpp/yowasp/llvm.core2.wasm
workers/vendor/cpp/yowasp/llvm.core3.wasm
workers/vendor/cpp/yowasp/llvm.core4.wasm
```

Fallback/reference external toolchain assets:

```txt
workers/vendor/cpp/clang.wasm
workers/vendor/cpp/lld.wasm
workers/vendor/cpp/sysroot.tar
```

The worker now owns the first compile/run pipeline:

```txt
TraceCode driver source
  -> focused compiler bundle emits C++23 program.wasm
  -> worker instantiates /tmp/program.wasm with the same minimal WASI/memfs glue
  -> stdout result marker becomes CodeExecutionResult.output
```

The first tracing slice is generated-driver based:

```txt
TraceCode driver source
  -> instruments the target Solution method with conservative line markers
  -> emits generic v4 call / line / stdout / return markers
  -> enforces an in-program trace budget for traced runs
  -> worker parses markers into RuntimeTrace events
  -> client hard timeout terminates the worker and recreates it for the next run
```

The source pass is intentionally line-based and conservative. It targets the
requested `Solution` method body, preserves `#line` mapping back to
`UserCode.cpp`, and avoids broader C++ parsing. It does not inspect STL memory.
The first container slice uses TraceCode-owned `tracecode::Vector<T>` wrappers
for traced vector parameters and simple local vector declarations. The wrapper
emits generic runtime `snapshot`, indexed `read`, indexed `write`, and `mutate`
events without adding visualization-specific payloads.

The second container slice adds `tracecode::UnorderedMap<K, V>` for simple local
`unordered_map<K,V>` declarations. It emits snapshots plus keyed reads/writes,
covering the common two-sum pattern (`count`, `operator[]`, assignment).

Nested `vector<vector<T>>` locals also emit two-dimensional indexed reads/writes
for DP-style code such as `dp[row][col]`, including constructor-style local
declarations like `vector<vector<int>> dp(m, vector<int>(n, 0));`.

The raw `clang.wasm`/`lld.wasm` path remains in the worker for reference
experiments, but the preferred path is the focused YoWASP Clang/LLD package
rather than the old `binji/wasm-clang` demo assets.
