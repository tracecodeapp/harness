# Changelog

All notable changes to this project are documented here.

This repo uses Git tags as release boundaries. Version notes below summarize what shipped in each tagged release.

## [0.9.3] - 2026-06-05

### Changed

- Added true browser batch execution for JavaScript, TypeScript, Python, C#, and C++ so multi-case runs prepare or compile once and execute the full input batch in one worker call.
- Kept JavaScript, TypeScript, and Python batch cases isolated with fresh globals and freshly materialized mutable inputs, including linked-list/object inputs that user code can mutate.
- Added compile-once browser batch drivers for C# and C++ named-function, solution-method, and ops-class execution paths.

### Fixed

- Fixed Python browser batch handling for default imports, script-mode inputs, and custom class materialization.
- Added regression coverage for batch global isolation, mutable input isolation, C# browser batch execution, and C++ compile-once batch behavior.

## [0.9.2] - 2026-06-05

### Fixed

- Suppressed successful Java compiler diagnostics from single-file browser run, trace, and batch console output so benign `javac` notes such as unchecked/raw-type warnings no longer appear as user stdout.
- Preserved Java compiler diagnostics for failed compiles and project-mode terminal commands.

## [0.9.1] - 2026-06-05

### Fixed

- Fixed Java browser trace rewriting to emit typed `(String) null` index-source placeholders for generated indexed-write hooks, removing `javac` varargs warnings from instrumented user-code compiler diagnostics.
- Rebuilt the Java browser helper and rewriter JARs with the warning-free indexed-write instrumentation.

## [0.9.0] - 2026-06-04

### Added

- Added project-mode TraceKernel workspaces for browser and native execution, including virtual filesystem roots, `/proc` and `/dev` surfaces, command events, live and final file mutations, stdin/stdout/stderr routing, terminal sessions, readonly files, protected skills roots, and project examples.
- Added `@tracecode/harness-project` and project exports from the umbrella, browser, and native package surfaces.
- Added TraceKernel HTTP simulation for project workspaces, including in-kernel listeners, request dispatch, fetch/curl support, body helpers, request/listener diagnostics, Java project HTTP support, Python HTTP shims, and packaged HTTP smoke coverage.
- Added `@tracecode/harness-native` and `@tracecode/harness/native` for trusted host-native batch inference across Python, JavaScript, TypeScript, Java, C#, and C++.
- Added native queue APIs for multi-worker mixed-language job batches, plus compile-once/batch execution paths for high-volume corpus mining.
- Added C++ conformance fixture import tooling and expanded runtime parity/conformance coverage across JavaScript/TypeScript, Python, Java, C#, and C++.
- Added configurable V4 trace path depth and expanded fixtures for keyed/indexed provenance, recursive access, nested mutation, heap/queue/set/map behavior, stdout frames, and post-line state behavior.

### Changed

- Standardized V4 call, frame, stdout, provenance, keyed-removal, collection-mutation, and trace-budget behavior across supported runtimes.
- Improved browser JavaScript/TypeScript runtime support with a larger Node-like filesystem, stream, descriptor, stdio, watch, metadata, and TypeScript project-library surface.
- Routed Java, C#, C++, Python, and JavaScript/TypeScript project runners through shared TraceKernel policy for workspace roots, virtual devices, manifests, diagnostics, and file mutation handling.
- Split and trimmed CI stages for runtime trace, C# browser, C++ smoke, and package-surface validation.

### Fixed

- Fixed V4 trace correctness gaps across collection mutation, indexed reads/writes, nested mutations, iteration bindings, recursive calls, stdout frames, lambda/call activations, map/set/key provenance, and post-line state behavior.
- Fixed Java trace rewriting around nested/indexed mutations, enhanced-for receivers, dangling else handling, compact control blocks, `PriorityQueue`, `List.remove`, object-key map reads, array writes, and side-effecting expression replay.
- Fixed C# tracing around tuple/index provenance, from-end ranges, nested set mutations, constructor/input hydration bounds, partial stdout, private-field snapshots, and side-effecting collection keys.
- Fixed C++ tracing around aliasing, pointer reads, map/set keyed collections, `priority_queue`, nested vectors, scalar writes, lambda/script tracing, numeric literal inference, and compiler worker lifecycle.
- Fixed Python tracing around assignment writes, `heapq`, helper shadowing, cyclic input literals, project snapshots, invalid nested mutation paths, and set-name shadowing.
- Fixed JavaScript/TypeScript tracing around async conditions, destructuring, private fields, nested write evaluation order, property reads, set/map provenance, and trace serialization limits.

### Security

- Hardened browser/project runtime boundaries, worker isolation, compiler/runtime asset loading, virtual path mapping, workspace traversal, final-diff application, project event streams, and public TraceKernel proc identity.
- Added encrypted browser IndexedDB kernel storage and trusted IndexedDB options for examples.
- Gated browser JavaScript trusted execution modes and documented isolation boundaries.
- Pruned the C# browser network runtime surface and locked down compiler/runtime assets.
- Removed JavaScript input materializer type evaluation and bounded resource use across JavaScript input hydration, Java diagnostics/trace expansion, C# hydration, async contexts, and bulk trace budgets.
- Updated vulnerable npm dependencies, including `lodash` to `4.18.1` and a `postcss` override to `8.5.10`.

### Notes

- Native harness is not a sandbox and should only run trusted code. The browser runner remains the default path for normal product usage.
- Java and C# native code clients support host-native run/batch execution, but native host-side trace instrumentation is still reported as unsupported.

## [0.8.0] - 2026-05-21

### Added

- Added the V4 harness execution contract as the public runtime trace contract for browser harness consumers.
- Added native V4 runtime trace emission across JavaScript/TypeScript, Python, Java, C#, and C++.
- Added browser-local C# and C++ runtime support.
- Added language-split packages for core, browser, Python, JavaScript/TypeScript, Java, C#, and C++ harness consumers.
- Added generated runtime language metadata covering language versions, compiler/runtime details, standards, default imports, and bundled libraries.
- Added default runtime library support across supported runtimes, including JavaScript/TypeScript bundled libraries.
- Added explicit browser warmup APIs for heavyweight runtimes.
- Added language-filtered asset syncing through `tracecode-harness sync-assets --languages ...`.
- Added third-party runtime notices for bundled browser runtimes and toolchains.
- Added expanded runtime parity fixtures and contract gates for cross-language V4 trace behavior.

### Changed

- Changed the public trace result surface to V4 runtime traces.
- Reframed harness traces as low-level runtime facts rather than visualizer-specific payloads.
- Standardized runtime traces on post-line state, where line events describe facts visible after the source line executes.
- Standardized trace events around calls, lines, returns, snapshots, reads, writes, mutations, stdout, exceptions, timeouts, and trace-budget behavior.
- Standardized collection mutation and access provenance reporting across supported runtimes.
- Updated Java runtime tracing to emit native V4 traces by default.
- Updated browser runtime initialization so C#, C++, Java, Python, and TypeScript can be warmed intentionally before first execution.

### Fixed

- Improved Java rewrite-failure handling so parser failures surface as user-facing syntax or compiler diagnostics.
- Improved JavaScript/TypeScript non-trace execution so plain JavaScript runs no longer load the TypeScript compiler just to recover argument order.
- Improved Python serialization for script results and callable values.

### Notes

- `0.8.0` supersedes the unpublished `0.7.0-beta` line.
- This is a contract-establishing release for V4 runtime traces. Consumers upgrading from `0.6.6` should expect trace contract changes.

## [0.7.0-beta4] - 2026-05-10

### Changed

- Upgraded the C# browser-WASM runtime lane to .NET 10, C# 14, and Roslyn `Microsoft.CodeAnalysis.CSharp` 5.3.0.
- Added `pnpm update:csharp-runtime` to locally install/update the required .NET SDK channel, publish the C# WASM host, sync vendored assets, and regenerate runtime language info.

### Fixed

- Fixed newer .NET worker startup by registering C# worker messages with `addEventListener('message', ...)` so sidecar boot mode is detected correctly.
- Fixed local Java trace fixture dynamic input mapping so full runtime trace parity can validate browser-style input files under the host JVM.

## [0.7.0-beta3] - 2026-05-10

### Added

- Added generated runtime language info metadata and public browser/core APIs for language versions, compilers, standards, default imports, and bundled libraries.
- Added JavaScript and TypeScript runtime library support for lodash and datastructures-js packages.
- Expanded default import/header coverage for Python, Java, C#, and C++ runtime lanes.

## [0.7.0-beta2] - 2026-05-09

### Changed

- Added explicit browser warmup paths for Java, Python, TypeScript, C#, and C++ so heavy runtimes can stay lazy until the app intentionally warms them.
- Split C# and Python worker `init()` from runtime loading, preserving lazy first execution while allowing guided/code-assist flows to warm runtimes on demand.
- Isolated C++ compiler warmup and Java background warmup behavior behind `warmLanguage(...)`.
- Renamed Python worker-facing client/log labels from Pyodide-specific names to `PythonWorkerClient` and `[PythonWorker]`, while keeping backwards-compatible `PyodideWorkerClient` exports.

### Fixed

- Added a dedicated Java non-trace execution path, including run-only batch execution support.
- Stopped plain JavaScript non-trace execution from loading the TypeScript compiler just to recover function argument order.

## [0.7.0-beta1] - 2026-05-07

### Added

- Added third-party runtime notices covering CheerpJ, Pyodide/CPython, TypeScript, JavaParser, OpenJDK/JBR, .NET/Roslyn, YoWASP/LLVM, and WASI libc.
- Added publishable language-split packages for core, browser, Python, JavaScript/TypeScript, Java, C#, and C++.
- Added Java, C#, and C++ public root subpath exports.
- Added language-filtered asset sync through `tracecode-harness sync-assets --languages ...`.

### Changed

- The umbrella package remains backwards compatible, while standalone language packages now publish their own generated `workers/` assets.
- Package builds now generate per-package assets without committing duplicate runtime blobs.

## [0.6.6] - 2026-04-27

### Fixed

- Improved Java worker rewrite-failure handling so parser failures are surfaced as user-facing syntax errors instead of opaque Java object strings.
- Added a compile probe fallback when Java source rewriting fails, allowing harness clients to receive compiler stderr/stdout diagnostics in the standard failed execution payload.

## [0.6.5] - 2026-04-26

### Added

- Added Java visualizer harness support for public runtime trace metadata used by the app visualization path.

### Fixed

- Improved Java trace bookkeeping parity so emitted trace steps line up with the shared runtime contract.
- Fixed Python runtime access attribution regressions caught while validating cross-language visualization parity.
- Preserved Java script-mode tracing behavior through the updated harness assets.

### Notes

- `0.6.5` skips `0.6.4` intentionally because this release bundles the larger Java visualization compatibility update.

## [0.6.2] - 2026-04-23

### Added

- Enabled Java script-style browser execution using an empty function name, `executionStyle: "function"`, and the top-level `result` variable convention.
- Added direct Java worker regression coverage for script-mode normalization, result serialization, trace function mapping, and invalid style rejection.

## [0.6.1] - 2026-04-23

### Fixed

- Resolved Dependabot-reported vulnerabilities by moving the example app to patched Vite 7.3.2 and overriding transitive DOMPurify and Picomatch resolutions to patched versions.

## [0.6.0] - 2026-04-23

### Added

- Experimental browser-local Java runtime client and worker support.
- Java runtime capability profiles, worker asset sync coverage, and packaged browser harness surface.
- Java trace adapter support for line events, access metadata, visualization payloads, and runtime output normalization.

### Changed

- Runtime trace contract normalization now deduplicates noisy access metadata and enforces shared trace clipping semantics.
- JavaScript and Python workers now share the same trace budget controls used by the browser harness clients.
- Browser example app now exercises Java alongside Python, JavaScript, and TypeScript.

### Fixed

- TypeScript `for...of` tracing now delays iterable access metadata to the next executable step while preserving loop-header flushes for body mutations.
- Java worker asset checks now cover the helper, rewriter, bridge, parser, and compiler jars needed by the Java lane.

### Notes

- `0.6.0` is the first Java runtime preview release. Java remains capability-profiled as experimental.

## [0.5.0] - 2026-03-14

### Fixed

- JavaScript function-style tree inputs now hydrate fallback `root`/`head` array inputs even when no explicit static parameter materializer is available.
- Sparse level-order tree arrays now deserialize correctly in the JavaScript worker instead of being rebuilt as complete binary trees.

### Changed

- GitHub CI now runs the non-browser harness verification set and skips Playwright/Chrome example-app coverage.

### Notes

- `0.5.0` is a JavaScript runtime correctness and CI-trim release ahead of the next app cut.

## [0.4.0] - 2026-03-10

### Added

- Built ESM and CommonJS package outputs plus `.d.ts` publishing.
- `createBrowserHarness(...)` as the stable public browser runtime factory.
- `tracecode-harness sync-assets <target-dir>` for copying the canonical worker asset set into consumer apps.
- Packaging, asset-contract, and example-consumer smoke tests.
- In-repo minimal example app at `examples/web-ide`.

### Changed

- The public browser SDK now uses explicit runtime instances instead of app-coupled ambient bootstrap.
- Browser asset resolution is centralized around `assetBaseUrl` and per-asset overrides.
- `@tracecode/harness/browser` now exports the high-level stable API instead of low-level worker internals.

### Notes

- `0.4.0` is the clean public SDK cut for browser consumers.

## [0.3.4] - 2026-03-07

### Fixed

- TypeScript tracer line alignment for debugger-style playback.
- JS/TS runtime coverage around traced queue and traversal steps.

### Notes

- `0.3.4` is a tracer-alignment patch release focused on TypeScript step accuracy.

## [0.3.3] - 2026-03-07

### Fixed

- JavaScript tracer line mapping for debugger-style playback.
- JS runtime behavior around queue mutations, loop headers, and traversal line alignment.

### Notes

- `0.3.3` improves JS trace semantics without changing the public contract shape.

## [0.3.2] - 2026-03-07

### Fixed

- JavaScript/TypeScript input binding order during harness execution.

### Notes

- `0.3.2` is a JS/TS execution correctness patch release.

## [0.3.1] - 2026-03-07

### Fixed

- Python class-scope access instrumentation mangling in the tracing runtime.

### Notes

- `0.3.1` fixes Python access metadata emission for class-based solutions.

## [0.3.0] - 2026-03-07

### Added

- Runtime access metadata in the shared trace contract via an optional `accesses` field on trace steps.
- Public access event types for:
  - `indexed-read`
  - `indexed-write`
  - `cell-read`
  - `cell-write`
  - `mutating-call`
- JavaScript/TypeScript runtime instrumentation for array and grid access events, including indexed reads/writes and mutating queue/array calls.
- Python runtime instrumentation for aligned access metadata during tracing.

### Changed

- Trace adapters now preserve runtime access metadata end to end.
- Runtime contract coverage now validates the new access metadata surface.

### Notes

- `0.3.0` is an additive, backward-compatible contract release.
- Access metadata is state-aligned with debugger-style trace playback, so events appear on the next emitted step alongside the post-line state.

## [0.2.0] - 2026-03-06

### Added

- Structured runtime capability profiles for supported languages.
- Browser runtime capability guards and shared runtime-type metadata.
- Contract tests validating language profiles and declared support levels.

### Notes

- `0.2.0` formalizes the public runtime capability surface.

## [0.1.0] - 2026-03-06

### Added

- Initial public harness baseline with repository documentation and published package metadata.

### Notes

- `0.1.0` is the pre-profile baseline release.
