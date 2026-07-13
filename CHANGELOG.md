# Changelog

All notable changes to this project are documented here.

This repo uses Git tags as release boundaries. Version notes below summarize what shipped in each tagged release.

## [0.11.0] - 2026-07-12

### Added

- Added a structured browser runtime environment and preflight report with provider selection, engine/feature detection, surface-specific asset checks, readiness states, and explicit compatibility caveats.
- Added provider-scoped cross-origin execution hosting for Classic and project runtimes. Consumers can independently host Python, JavaScript/TypeScript execution, Java, C#, and C++ workers while retaining local delivery for every other provider; the existing project Java-only default remains compatible.
- Added lazy project-provider assembly, including filesystem-only workspaces, dynamically loaded provider modules, split ESM output, and browser bundle-size gates.
- Added real-browser Classic and project provider matrices across Chromium, Firefox, and WebKit, including active runtime cancellation and five-sample nightly performance gates.

### Changed

- Reduced exact-repeat Python Classic execution to roughly 1–3 ms across browser engines with a bounded compiled-source runner. Every command still receives fresh globals and restores builtins, module registration, and trace state; `python.compileCacheLimit` can bound or disable retained code objects.
- Reduced exact-repeat Java Classic execution to roughly 88 ms in Chromium by restoring content-addressed compiled classes into a fresh request directory and classloader. Cache keys include the generated source identity, mode, helper/compiler assets, and cache version; `java.compileCacheLimit` can bound or disable retained artifacts.
- Expanded the execution-host worker protocol to preserve transferable ownership and worker construction options across all worker-backed providers.
- Kept WebKit C++ readiness explicitly degraded after a clean 10-sample local baseline because an earlier hosted run observed an intermittent engine-level WebAssembly null-reference; nightly tests intentionally do not mask it with retries.

### Fixed

- Fixed generalized project execution hosting so a Java-only first-party host no longer redirects unrelated provider workers to the Java asset origin or rejects local consumer-provided clients for providers that are not hosted.
- Fixed TypeScript project profiling and matrix selection so compiled output uses its JavaScript execution dependency and cancellation is measured against active runtime work.
- Fixed Java compiled-artifact reuse so cache hits cannot share writable class directories, stale in-memory entries fall back to source compilation, restored manifests are validated, and request trees are always deleted.
- Fixed Python Classic cross-command state leakage through globals, `builtins`, and `sys.modules` registration while preserving warm-runtime performance.
- Fixed Python mutation tracing so user methods named like collection operations no longer suppress events for actual list, dictionary, set, deque, or array receivers, while custom objects remain free of false mutation events.
- Fixed C++ script traces so generated `tracecode*` lambda helpers and their call-stack frames remain hidden while explicitly declared user functions retain their names.
- Fixed C# indexed collection assignments so wrapper-level writes carry source provenance without emitting a second duplicate indexed write, and refreshed parity fixtures for the existing non-redundant read/loop-header contract.

## [0.10.1] - 2026-07-12

### Added

- Added a public browser-project provider matrix covering Python, JavaScript, TypeScript, Java, C#, and C++ across Chromium, Firefox, and WebKit. The matrix exercises compile/run, filesystem persistence, hidden/readonly policy, TraceKernel HTTP, stdio, cancellation, and disposal through public APIs.
- Added separate five-sample performance baselines and a nightly/manual regression gate for every provider/engine pair, keeping compatibility and performance conclusions distinct.

### Fixed

- Deleted each request-scoped CheerpJ `/files/java-worker/<compileId>` tree after Java project results and file changes are materialized, while preserving the workspace-session VM warmup tree.

## [0.10.0] - 2026-07-12

### Added

- Added consumer-owned browser runtime asset manifests across Python, JavaScript/TypeScript, Java, C#, and C++, with explicit runtime origins, delivery modes, integrity metadata, preflight validation, and configurable runtime paths. The harness remains CDN-neutral: consumers can use their own CDN or first-party infrastructure without coupling deployment to TraceCode.
- Added a cross-origin browser execution host for isolating runtime workers from the application origin, including origin policy, lifecycle controls, transferable trace batching, and project-workspace integration.
- Added permanent per-execution authority boundaries and disposable project workers while retaining explicitly trusted warm compiler/runtime coordinators. Browser runtime capabilities now remain scoped across computed, prototype, deferred, and cross-command access paths.
- Added browser project runtime benchmarking and deployment guidance, including cached A/B measurements, classic-provider performance ceilings, execution-host setup, runtime asset ownership, and isolation contracts.
- Added Java project workspace profiles for compiler-heavy session reuse and disposable command execution, plus persisted project resources and workspace-aware classpath handling.

### Changed

- Improved browser runtime lifecycle and repeat execution performance with explicit warmup, one-shot prewarm pools, compile/artifact caching, bounded transferable trace batches, and runtime-specific coordinator/worker separation.
- Improved Python browser distribution with a consumer-configured module worker, explicit package manifests, deterministic package preload failure behavior, and self-hostable Pyodide asset plumbing.
- Reduced the shipped C# browser reference pack to the assemblies required by the supported contract and improved C# and C++ compiler cache lifecycle behavior.
- Improved browser project storage, concurrent command isolation, runtime HTTP bridging, filesystem observation, redirects, streaming responses, and command-scoped cleanup.
- Expanded build and release gates so generated policy, language assets, browser execution hosting, runtime authority, worker lifecycle, package preload, and external HTTP behavior are validated through their public surfaces.

### Fixed

- Fixed project filesystem observation and mutation behavior across path validation, file and directory operations, symlink handling, descriptor activity, final diffs, and event ordering.
- Fixed external HTTP validation and response handling across redirect policy, streaming bodies, header normalization, request budgets, aborts, timeouts, and listener cleanup.
- Fixed browser worker reuse and disposal edge cases so user execution state, pending HTTP work, runtime authority, compiler frames, and project resources do not leak into later commands.
- Fixed packaged runtime initialization so the generated shared browser policy is loaded before public worker execution.
- Fixed fresh-checkout source test resolution and canonical runtime asset lookup so checks do not depend on generated package build artifacts.
- Fixed real-browser regression setup and teardown so Chromium is present in CI and active server connections close consistently, including on launch failures.
- Updated Python project stdio regression coverage to match the bounded interpreter-level stream bridge while leaving provider-level callbacks host-owned.
- Documented the Java asset boundary: consumers supply the CheerpJ 4.2 loader URL, and this release does not redistribute or host CheerpJ runtime files.

## [0.9.10] - 2026-07-05

Re-release of the 0.9.9 changes with a correctly built `dist`. (0.9.9 was published from a stale `dist` and shipped none of the code below; a `prepublishOnly` build guard now prevents this.)

### Added

- Added a unified kernel journal: one append-only, absolutely-ordered log (a single sequence counter) of every kernel-observed transaction — filesystem writes, process `exec`/`exit`, and HTTP requests — emitted only from kernel-internal observation points, so in-workspace code cannot forge entries and every event is attributed by actor/pid. `Authorization` is stored as a non-reversible fingerprint (never the raw value), and `externalHttp` responses may attach an opaque `annotation`. The journal is exposed both live on the workspace event stream (`kernel-journal` events, ordered consistently with buffered output) and as a queryable `journal(sinceSeq?)` snapshot. HTTP journal records additionally carry redacted grading metadata: idempotency-key and request/response body fingerprints, plus `Content-Type`, `Retry-After`, and `X-RateLimit-*` values.
- Added a virtual-network host registry (`resolveHost`) and a `ping` reachability command: loopback, in-workspace HTTP listeners, and `externalHttp`-allowlisted hosts all resolve through one primitive with deterministic, hash-derived synthetic IP and latency (no wall clock or RNG). `ping` produces ping-shaped output and fails gracefully with an unknown-host error instead of a raw kernel throw.

### Changed

- Unified host reachability across `curl`, `ping`, and `workspace.http.request` through `resolveHost`: an unknown host now returns a typed `EHOSTUNREACH` (rendered by `curl` as exit 7, "Host unreachable") rather than leaking a raw kernel error, while a known host with a closed port still returns `ECONNREFUSED`; host allowlist/blocklist policy is unchanged. Also corrected the diagnostic port reported for failed HTTPS connections.
- Optimized C++ and C# batch execution: test cases that are safe to co-execute now share a single compile-and-run pass, with an automatic per-case fallback when a batch requires isolation.
- Added true C++ browser trace batching: multi-case trace requests now compile once, run the traced batch driver once, and split trace events back into per-case runtime traces. Benchmarks showed trace batching stays in the same compile-bound envelope as plain C++ batch execution instead of paying one compile per case.

### Fixed

- Fixed `curl` URL scheme resolution and replaced raw kernel HTTP errors with typed ones so nothing leaks to the terminal: bare hostnames, `host:port`, and `localhost:3000` now resolve correctly, unsupported schemes return a proper `curl` protocol error, and malformed requests surface as graceful `curl` diagnostics instead of a raw `EINVAL`.

## [0.9.9] - 2026-07-05

Broken publish — shipped a stale `dist` with none of the intended changes. Superseded by [0.9.10]. Do not use.

## [0.9.8] - 2026-07-04

### Added

- Added app-mediated external HTTP egress: workspaces accept an `externalHttp` capability (host allowlist, plain-http opt-in, per-command budgets, concurrency cap, timeout, delegate `fetch`) so non-loopback requests from project code can be routed through the embedding application, with hardened blocklists for loopback/private/metadata hosts and `/proc/tracekernel/net/requests` logging.
- Added C++ in-workspace HTTP support through plain BSD sockets — no TraceCode-specific API. Project code writes standard POSIX networking (`<sys/socket.h>`, `<netinet/in.h>`, `<netdb.h>`: `socket`/`connect`/`bind`/`listen`/`accept`/`send`/`recv`/`getaddrinfo`) and the kernel intercepts it: `send`/`recv`/`accept` are handled at the WASI layer (`sock_send`/`sock_recv`/`sock_accept`), while the calls WASI preview1 cannot express come from an invisibly injected, auto-linked shim. HTTP bytes written to sockets are converted to TraceKernel HTTP messages (and back) over a synchronous SharedArrayBuffer bridge mirroring the Java worker protocol, so loopback listeners and app-mediated external hosts both work; `getaddrinfo` hostnames ride through to the bridge URL.
- Added terminal session environment persistence: `export FOO=…`, plain shell assignments, and `unset` now persist across terminal submissions (per-run `env` overlays still apply once), backed by a new `RuntimeCommandOptions.onEnvChanges` hook that reports shell variable deltas per command.

### Changed

- Split the `@tracecode/harness-project` monolith into focused modules (paths, session, locks, scheduler, patches, observed fs, arg parsers, package manager, language commands, ls, terminal session).
- Replaced the browser `AsyncLocalStorage` shim with explicit command-context threading (`CommandBoundFileSystem`), lifting browser TraceKernel command concurrency from one to the configured limit.
- Made `@tracecode/harness-core` a real workspace dependency shared as a single copy across published packages.
- Unified terminal command parsing onto the just-bash parser: background/`;` splitting, bare `cd`/`pwd` detection, and persistent leading `cd` are now derived from the interpreter's own AST, so quoting, comments, and subshells behave identically in the terminal layer and command execution (quoted `&`/`;` and subshell-internal `&` no longer split submissions; here-doc submissions run unsplit).
- Factored the Java worker client's synchronous TraceKernel HTTP bridge into a shared module now used by both the Java and C++ worker clients.
- Debounced and coalesced browser kernel-storage persistence, cached workspace snapshots keyed by filesystem mutation version, and enforced project session expiration lazily on mutation and run.

### Fixed

- Fixed C# tracing so loop conditions and enumerable headers emit one source-line frame with reads, writes, and snapshots attached instead of a duplicate same-line microframe.
- Fixed a synchronous TraceKernel HTTP bridge race shared by the Java and C++ workers where a program that responded to an in-flight request and immediately closed its listener (or exited) could overwrite the unread response with the closed state, turning a real response into a 503.
- Preserved readonly session file policy across kernel-storage rehydration and restored the abort controller in JS project worker execution state.

## [0.9.7] - 2026-06-19

### Added

- Added pinned C++ browser toolchain integrity manifests so consumers can host large YOWASP assets on a remote HTTPS origin while requiring exact SHA-256 digests before execution.

### Fixed

- Replaced the C++ browser worker's same-origin-only assumption with a stricter trust model: same-origin assets remain allowed, while cross-origin compiler bundles and WASM/sysroot assets must match an exact manifest entry.
- Loaded pinned remote C++ compiler bundles through verified Blob modules and rewrote their `import.meta.url` base so secondary YOWASP fetches are also checked against the same manifest.

## [0.9.6] - 2026-06-19

### Added

- Added browser-first SQL tracing through `@tracecode/harness-sql` and `@tracecode/harness/sql`, including query, exec, transaction, rollback/failure, explain-plan, privacy-mode, and fixture-backed trace contracts.
- Added SQL trace documentation for contract semantics, privacy modes, product integration, and review workflows, plus a browser SQL example app.
- Added package-surface coverage for the SQL package and expanded standalone package checks for shipped runtime worker assets.

### Changed

- Refreshed public docs, READMEs, package metadata, runtime language info, third-party notices, and package asset syncing for the expanded package set.
- Moved C# browser host sources and generated runtime assets into the runtime tree and refreshed the packaged C# worker artifacts.
- Tightened TraceKernel project-mode routing and bookkeeping for command step budgets, live I/O controller options, cwd events, virtual paths/devices, final diffs, HTTP headers, and result filtering.

### Fixed

- Fixed project-mode filesystem and device behavior across live file changes, recursive directory snapshots, directory deletes, rename/copy targets, stdin/stdout routing, pending reads, file-handle streams, append/readv/opendir operations, and interrupted browser Node commands.
- Fixed cold Python and C# browser executions so runtime warmup uses the runtime-load budget before user-code execution timers begin.
- Fixed runtime trace correctness across Java, C#, C++, Python, and JavaScript/TypeScript for side-effecting expressions, mutation ordering, indexed writes/receivers, collection snapshots, heap/priority-queue operations, target-typed assignments, function-valued conditions, and snapshot alignment.
- Fixed Java project/runtime edge cases around diagnostic paths, event run binding, reader cleanup, NIO temp files, virtual copy options, PrintWriter charset errors, nested mutation order, `PriorityQueue` rewrites, var loop element inference, and indexed receiver casts.
- Fixed C# runtime edge cases around qualified API references, serialization bounds, kernel file mounts, custom dictionary input hydration, indexed assignment semantics, async returns, project diagnostics, target-typed field assignments, and mutation argument replay.
- Fixed C++ runtime/project edge cases around prefixed trace functions, line-limit failures, known device lookup, mapped reference mutations, aggregate template parsing, project stdio defaults, and directory rename targets.
- Fixed Python runtime/project edge cases around Pyodide path resolution, directory snapshot budgets, provider output routing, class-scope trace temporaries, heap target resolution, `heapq` call order, indexed user method calls, and `scandir` behavior.
- Fixed JavaScript/TypeScript runtime/project edge cases around bounded input materializers, collection snapshot budgets, fetch tuple headers, UTF-8 BOM/header byte preservation, web IDE language helpers, open exclusivity, global shadows, and file I/O bridge behavior.
- Fixed SQL diagnostic redaction for additional string and numeric literal forms.
- Fixed native C# dictionary input hydration for dictionary interface types.
- Fixed runtime info lookups and package-surface guards for current worker assets.

## [0.9.5] - 2026-06-09

### Added

- Added TraceKernel browser project support for overlapping terminal commands so background server jobs can stay running while later `curl`, `npm`, or diagnostic commands execute.
- Added terminal job launch output for background commands, printing the TraceKernel PID that can be used with `kill`, `wait`, `jobs -l`, and `/proc/<pid>`.
- Added browser Node builtin support for `assert`, `assert/strict`, `events`, `util`, `stream`, `timers/promises`, `crypto` random helpers, `process`, and their `node:` aliases.

### Fixed

- Fixed browser HTTP listener ownership for worker-backed JavaScript project commands so delayed `http.createServer(...).listen(...)` calls remain attached to the command process that created them.
- Fixed browser project scheduling so the browser `AsyncLocalStorage` shim no longer forces TraceKernel command concurrency down to one command.
- Honored `process.exitCode` in browser Node project commands, matching common Node test-file catch-handler behavior.

## [0.9.4] - 2026-06-06

### Added

- Added an optional `AbortSignal` to the browser runtime `execute` request contract for code, trace, interview, and batch execution.
- Threaded abort signals through JavaScript, TypeScript, Python, Java, C#, and C++ browser runtime clients so consumers can cancel in-flight code execution through the standard runtime request surface.

### Notes

- Browser runtime cancellation remains runtime-dependent: CPU-bound compiled runtime work may still require worker termination to stop immediately, which can discard warm compiler/runtime state.

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

- `0.6.0` was the first Java runtime preview release.

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
