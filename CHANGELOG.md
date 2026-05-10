# Changelog

All notable changes to this project are documented here.

This repo uses Git tags as release boundaries. Version notes below summarize what shipped in each tagged release.

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
