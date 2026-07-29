# Changelog

All notable changes to this project are documented here.

This repo uses Git tags as release boundaries. Version notes below summarize what shipped in each tagged release.

## [Unreleased]

## [0.13.0-beta1] - 2026-07-28

This beta is the first release of the kernelized 0.13 architecture. It is
intended for product integration and compatibility testing before the final
0.13.0 ABI is declared stable.

### Added

- Extracted the public `@tracecode/tracekernel` package with matching ESM,
  CommonJS, and declaration surfaces plus the versioned
  `tracekernel.syscall.v1` binary and structured-clone wire contract.
- Added the host → session → process → runtime-lease lifecycle, including
  kernel-owned process identities, parent/group/session topology, signals,
  waits, resource ceilings, watchdogs, crash recovery, and exactly-once lease
  release.
- Added process-owned descriptors for TKFS files, pipes, watches, controlling
  terminals, and local TCP streams, with explicit inheritance, duplication,
  polling, fragmented I/O, bounded backpressure, half-close, and teardown
  behavior.
- Added the authoritative shared TKFS namespace so independently running
  JavaScript/TypeScript, Python, C++, C#, and Java processes observe the same
  live files and cross-process watch events.
- Added first-class language-initiated child spawning, descriptor wiring,
  process control, terminal control, local sockets, and shared-filesystem
  syscalls across every browser runtime. Java uses the independent TraceJVM
  host boundary rather than CheerpJ's private filesystem model.
- Routed local HTTP services through the TraceKernel TCP namespace while
  retaining structured service grading, journaling, cancellation, and logical
  host support.

### Changed

- Made TraceKernel the sole authority for filesystem state, descriptors,
  process scheduling and termination, signal selection, watchdog deadlines,
  terminal foreground ownership, runtime leases, and local port ownership.
  Product-layer records now project kernel state instead of maintaining
  fallback resource models.
- Unified direct execution, terminal execution, and spawned children around
  one process model. Descriptor-backed standard I/O is explicitly negotiated
  by each runtime adapter so legacy native runners retain their intended host
  streams.
- Defined Effect services, scopes, retries, and concurrency as host-side
  implementation tools only; Effect values never cross a language-worker wire
  boundary.

### Fixed

- Hardened concurrent worker wakeups, process teardown, pipe EOF retention,
  foreground process-group ownership, signal acknowledgement, path
  canonicalization, filesystem bootstrap permissions, and atomic language
  asset publication.
- Added adversarial lifecycle, isolation, resource, transport, HTTP/TCP, and
  browser-runtime gates covering real workers, independent heaps, explicit
  descriptor inheritance, blocked-operation cancellation, repeated teardown,
  and cross-worker cache invalidation.

## [0.12.6] - 2026-07-22

### Added

- Browser harness execution is now safe by default across every language. Python, Java, and C# serialize untrusted requests and retire their runtime worker after each execution; JavaScript and TypeScript already use fresh execution workers, and C++ uses a fresh program worker. Safe mode stays lazy, then replenishes one clean, fully warmed Python, Java, or C# standby after first use so later executions avoid cold startup without reusing learner-observable state. Java safe execution and per-command Project workers also clear CheerpJ's origin-persistent writable mount under a cross-context lock before learner code runs, closing the filesystem boundary that a fresh JVM alone cannot reset. Memory-constrained consumers can disable clean standby replenishment with `safeExecution.prewarmAfterUse: false`. Trusted consumers may explicitly request `executionIsolation: "unsafe-reuse"` to retain mutable runtimes, and configured runtime profiles expose that weaker boundary instead of presenting it as isolation.
- Safe Java and C# executions now retain bounded, content-addressed compiler artifacts in the browser host across disposable worker generations. Fresh JVM/.NET workers validate the exact compiler key and load only immutable class/PE output into a new execution realm; learner globals, filesystems, input values, and final results are never cached. Exact-repeat C# compilation falls from roughly one second to effectively zero after worker replacement, while edited source still recompiles.

### Changed

- Updated the vendored C# browser runtime from .NET 10.0.9 to 10.0.10 while rebuilding the compiler host for cross-worker artifact restoration.

## [0.12.5] - 2026-07-21

### Fixed

- Rebuilt the published browser Project bundle with streamed filesystem-diagnostic normalization enabled. The packaged-surface gate now rejects a stale Project distribution before release.

## [0.12.4] - 2026-07-21

### Fixed

- Interactive Project terminals now normalize streamed filesystem diagnostics before they reach the host UI. Native-style `mkdir`, `touch`, and `mv` failures render exactly once instead of briefly exposing the internal `EROFS` error and then repeating the normalized message.

## [0.12.3] - 2026-07-21

### Fixed

- Interactive Project terminals now translate structured filesystem failures into native command-line prose. `cd`, shell redirections, and common file utilities retain POSIX error behavior without leaking TraceKernel's internal `ENOENT`, `ENOTDIR`, or `EROFS` error objects.
- Runtime file-change event queues now own asynchronous application failures immediately and report the first failure deterministically at flush, instead of allowing a live worker rejection to surface as an unhandled promise rejection.
- Worker-backed Browser Node now treats settled, unhandled HTTP failures as pending process work. Rejected asynchronous server binds such as `EADDRINUSE` can no longer be lost when the listener closes before the event-loop quiescence check.

## [0.12.2] - 2026-07-21

### Fixed

- Browser Node now drains detached Promise work before declaring a Project command complete, and alternates JavaScript and TraceKernel HTTP draining until both are quiet. Async CommonJS test programs can no longer exit successfully before their final assertions, output, or HTTP work finishes.

## [0.12.1] - 2026-07-21

### Added

- Added a TraceKernel-native `fastfetch` easter egg with a `neofetch` compatibility alias and a Braille-cell rendering of the TraceCode mark. It reports the guest's `wasm32` architecture and only modeled kernel, terminal, workspace, and runtime details, without inventing a Linux distribution or host hardware.

### Changed

- The root harness, every internal workspace package, and TraceKernel's default public version now share the published `@tracecode/harness` release number. Explicit `kernel.version` overrides remain supported for tests and specialized consumers.

## [0.12.0] - 2026-07-19

### Added

- Added caller-tunable execution limits to classic code requests. `limits.wallClockMs` sets the per-case deadline on every browser language; Python additionally honors guest-enforced `maxLineEvents`, `maxSingleLineHits`, `maxCallDepth`, and `maxMemoryBytes`. Limit trips are reported structurally through `timeoutReason` (`client-timeout`, `line-limit`, `single-line-limit`, `recursion-limit`, `memory-limit`) on case results instead of sentinel error strings. Languages declare which knobs they honor via `capabilities.execution.limits`, and capability guards reject unsupported limits explicitly per field.
- Added tagged worker-client error classes (`WorkerRequestTimeoutError`, `WorkerReadyTimeoutError`, `WorkerTerminatedError`, `WorkerCrashedError`, `ExecutionTimeoutError`, `ExecutionAbortedError`, `WorkerReportedError`). Transport and lifecycle failures now carry structured fields and stable `name`s in stack traces; recovery policies classify by type instead of matching message prose.

### Changed

- **BREAKING** Execution results are now discriminated outcome unions instead of `success` booleans with optional fields. `CodeExecutionResult` and `ExecutionResult` are `completed | failed | limit` on `kind`: `completed` carries `output`, `failed` carries `error`/`errorLine`/`diagnosticStage`, and `limit` means execution was stopped by a configured or built-in limit with a required `reason` (`timeoutReason` is removed). Tracing outcomes always carry `trace` and `executionTimeMs`; a run that finished while its trace recording hit a budget is `completed` with `traceTruncated` set to the tripped reason (`traceLimitExceeded` is removed), and the former top-level `lineEventCount`/`traceStepCount` live on the trace itself. Case results in `RuntimeExecuteResult` nest the full outcome under `outcome` (with `id`/`expected`/`passed` alongside), aggregate `success` on execute responses means every case completed, and batch results drop their redundant top-level `success`. The worker wire protocol keeps the legacy loose shape; clients lift it exactly once at the API boundary via the new exported `liftCodeOutcome`/`liftTraceOutcome`/`liftCodeBatchOutcome` helpers over `RawExecutionPayload`.
- **BREAKING** `executeCode`, `executeWithTracing`, and the batch execution methods now take a single call object (`RuntimeCodeCall`, `RuntimeTraceCall`, `RuntimeBatchCall`) instead of positional arguments, across `RuntimeClient`, every browser worker client, and the native harness. Trace budgets are consistently named `traceOptions` at every API surface.
- **BREAKING** Removed interview mode end to end: `executeCodeInterviewMode` on `RuntimeClient` and every worker client, the `interview` request flag, `capabilities.execution.styles.interviewMode`, the `execute-code-interview` worker protocol messages, the `interview` `diagnosticStage`, the C++ `interviewTimeoutMs` options, and every built-in `Time Limit Exceeded` redaction. Interview behavior is now a client-side policy: pass a `limits` preset and render verdicts from the structured `timeoutReason` on results.
- Rebuilt the Python worker client and the browser harness composition root on Effect. Worker sessions are scoped resources whose entire teardown checklist runs as a release finalizer; request/response, deadlines, and abort run on fiber interruption instead of hand-rolled timers, settled flags, and abort listeners; harness construction is a resource layer graph that disposes partially-acquired resources automatically on construction failure. Public Promise-facing APIs, abort semantics (`AbortError`), and error identities are preserved across the boundary, and execution requests now run under a single deadline instead of overlapping message and execution timers.
- Distinguished caller cancellation from internal Effect interruption at the Promise boundary. Only a fired caller `AbortSignal` produces `AbortError`; internal lifecycle interruption now remains a worker-termination failure instead of falsely reporting user cancellation.
- Unified client-side execution timeouts across JavaScript, Java, and C# on the shared tagged `ExecutionTimeoutError` (with per-runtime message labels preserved), so caller-configured wall-clock trips surface as structured `client-timeout` case results uniformly across languages.
- Python resource-guard trips now report a human-readable error (`Execution stopped: resource limit exceeded (line-limit).`) alongside the structured `timeoutReason` instead of encoding the reason in the error string.
- Tests and scripts are now typechecked (`pnpm typecheck` includes `typecheck:tests` over `tests/**` and `scripts/**`), and test entry points run under `node:test`, so suite failures report through the standard runner instead of ad-hoc `main().catch` exits.
- The full and CI gates now use a bounded, weighted test scheduler instead of one serial shell chain. Independent checks and runtime families overlap without allowing heavyweight compiler/VM work to saturate smaller CI machines, build-dependent tests remain behind the build boundary, and `TRACECODE_TEST_JOBS` can override the default capacity. Runtime trace fixtures now run once in strict mode instead of executing the same multi-runtime corpus twice.

## [0.11.4] - 2026-07-19

### Added

- Added a real-browser cross-provider filesystem concurrency gate for Chromium, Firefox, and WebKit. It verifies authoritative live-write persistence, later-command visibility, point-in-time isolation for already-running workers, independent parallel writes, and deterministic `ESTALE` protection for same-path conflicts.
- Added a first-class terminal capability contract with TTY state, dimensions, resize support, session-owned history, and browser Node stdio geometry. Terminal commands now receive consistent `TERM`, `NO_COLOR`, `COLUMNS`, and `LINES` values.
- Added coherent TraceKernel user and host discovery through `whoami`, `id`, `hostname`, and `uname`, standard home and temporary directories, `mktemp`, command manuals, terminal capability inspection, `wget`, and `/dev/fd/{0,1,2}` descriptor aliases.
- Added terminal and environment discovery through `tty`, `locale`, `getconf`, `getent`, and `groups`. `kill -l` now lists the signals the kernel actually supports, and `kill -0` performs a process or process-group existence check without sending a signal.
- Added persistent per-terminal `umask` state. Numeric and symbolic masks, reusable `-p` output, and symbolic display now match shell expectations; captured commands start from `0022`, and the active mask governs newly created file and directory permissions.
- Added `df` reporting backed by the enforced workspace quota ledger. Byte, human-readable, and inode views now expose the actual logical capacity and usage that govern project writes.
- Added a TraceKernel-native `du` with byte, block, human-readable, summary, all-entry, depth, and total views over logical workspace contents.
- Added one canonical immutable mount table behind `mount`, `/proc/mounts`, and `/proc/self/mountinfo`, including a read-only system root, explicit writable temporary, workspace, and device filesystems, plus read-only proc, control, and skills namespaces.
- Added a TraceKernel-native `stat` with symbolic-link dereferencing and the common GNU format fields used by project scripts, including permission, ownership, timestamp, inode, and link-count views.
- Added a read-only `/etc` identity namespace backed by the active TraceKernel user, host, and version. Shell commands, workspace APIs, and browser runtimes now share `os-release`, `passwd`, `group`, `hostname`, `hosts`, `nsswitch.conf`, and `shells`.
- Added an optional kernel-wide process-table ceiling. `kernel.maxProcesses` accounts for PID 1, host-owned processes, commands, and unreaped zombies; exhausted forks fail with structured `EAGAIN` without consuming a PID, and usage is visible through TraceKernel diagnostics.

### Fixed

- C++ worker termination once again releases the current execution generation without permanently disabling the reusable client. Async preflight and initialization continuations now carry their lifecycle generation so a terminated command cannot recreate a stale worker.
- The reference Web IDE now supplies Java through an explicit consumer-owned runtime manifest, and its release smoke no longer targets the project terminal route that moved to the dedicated project examples.
- Parallel browser runtimes can now create different files in the same directory without one command incorrectly failing `ESTALE` merely because the other command advanced the directory generation. File creates retain structural locking and generation recording while freshness checks remain scoped to the target path.
- Browser Node signal listeners can now handle `SIGINT` and `SIGTERM`, close active resources, and exit naturally before the kernel forces termination. Worker-backed execution uses host-owned timers for the grace boundary so guest timer globals cannot delay or capture it.
- Closed stdin is snapshotted non-destructively when entering the project shell, preserving input for compiled executables in commands such as `compile && run`, while shell utilities still receive normal standard input.
- Patched the installed browser shell so `/dev/stdin` and `/dev/fd/0` resolve to the active command input rather than synthetic filesystem entries.
- Workspace executable paths now honor supported shebang interpreters, preserve Bash's text-file fallback when no shebang is present, retain Node shebang line numbering, and fail with command status 127 when the requested interpreter does not exist.
- Shell `test -t` and `[ -t ... ]` now report attached terminal descriptors without changing any other `test` expression behavior.
- Browser Node `fs.statfs` now derives block and entry capacity from the same enforced workspace quota snapshot as `df`, and tracks mutations made during the running process instead of reporting fabricated host-disk values.
- Project file snapshots and file-change transactions now preserve permission bits and access/modify timestamps across shell commands, browser Node processes, final diffs, project patches, and encrypted IndexedDB persistence. Browser files are owned by the TraceKernel user instead of synthetic root, and unsupported ownership changes fail with `EPERM` rather than disappearing after the process exits.
- TraceKernel's executable directory now participates in `PATH`, so `type`, `command -v`, `command -V`, and `which` agree on the executable users actually invoke instead of exposing just-bash's compatibility stubs under `/usr/bin`. Executable shims dispatch through private command identities after shell parsing, including inside nested npm lifecycle shells.
- Kernel filesystem policy failures now retain their POSIX error codes across shell redirections and command boundaries. Read-only and invalid virtual-path operations end the command normally instead of escaping as runner exceptions.
- Project snapshots, patches, encrypted persistence, and browser Node execution now retain symbolic links as links and preserve directory permission and timestamp metadata. Persisted snapshots reject duplicate directories, cross-kind path conflicts, and orphan directory metadata instead of silently normalizing corrupt state.

### Changed

- TraceKernel's default environment now reports one virtual-machine identity and no Linux identity through shell machine variables. Raw TCP/UDP sockets remain an explicit unsupported boundary; HTTP tools continue to use the allowlisted kernel transport.

## [0.11.3] - 2026-07-17

### Fixed

- Made encrypted Project workspace persistence safe on WebKit by completing revision allocation and AES-GCM encryption before opening the IndexedDB write transaction. The harness now queues the first object-store request synchronously with transaction creation instead of allowing Safari to auto-commit an idle transaction.
- Bundled Turndown's Domino fallback into the published package so clean Node consumers can import Project and native workspace entry points without relying on an undeclared ancestor dependency.

### Added

- Added a real-browser encrypted Project persistence gate. Regular CI covers Chromium, while the scheduled compatibility matrix covers Chromium, Firefox, and WebKit through save, load, revision, flush, and clear behavior.

## [0.11.2] - 2026-07-15

### Fixed

- Patched the published `just-bash` 3.1.0 browser bundle used by TraceKernel instead of maintaining a private source fork. Browser project shells now preserve Bash behavior for malformed POSIX character classes, assignment-only exit status, function-local loop control, `return --`, `exec`, `unset`, escaped tildes, `-nt`/`-ot` missing-file checks, `wc -L` display width, decimal sleep values without a leading zero, standard-input and final-newline behavior in `head`/`tail`, common `grep` filename, byte-offset, multi-pattern, pattern-file, and quiet-error flows, and common `xargs` argument-file, attached-batch, logical-EOF, empty-input, and exit-status behavior. Invalid `xargs -n` values now fail immediately instead of entering an unbounded loop. The patch also accepts practical `cp` compatibility flags and `find` path aliases, and adds browser-safe `base32`, `cksum`, `cmp`, `factor`, `fmt`, `getopt`, `hexdump -C`, `id`, `install`, `link`, `mktemp`, `realpath`, `truncate`, `sha384sum`, and `sha512sum` commands, with a harness-browser regression gate covering the installed package artifact.
- Made browser-project terminal failures follow native CLI boundaries: learner process errors retain language-native diagnostics and workspace paths, while worker crashes, request timeouts, execution-host failures, and live-file bridge failures stay out of stderr and remain available as structured kernel diagnostics.
- Replaced synthetic network and package-manager failures with native-shaped behavior. Blocked or unreachable fetches now fail as transport errors, `node:http` and `node:https` share the same error contract, `curl` distinguishes DNS and connection failures with native exit codes, and offline `npm install` reports an npm-style network failure.
- Made project CLI discovery and version commands report the embedded Python, Node.js compatibility level, TypeScript, OpenJDK, Clang, and .NET toolchains instead of exposing harness adapters. Browser Node projects now identify the operating system honestly as TraceKernel through `process`, `node:os`, package-manager metadata, and `/proc`; `npm start` honors npm's implicit `node server.js` fallback, and missing or malformed manifests use npm-shaped `ENOENT` and `EJSONPARSE` failures.
- Removed host filesystem paths, browser worker URLs, synthetic `exit N` lines, and TraceKernel-branded bridge messages from user-visible terminal output. Terminal prompts now use the conventional unprivileged `$` suffix and Ctrl+C returns signal status without leaking an internal `wait4` error.
- Made interactive terminal control shell-shaped: Ctrl+D closes a foreground process's stdin exactly once, `clear` uses a structured terminal event, and `exit` closes only its terminal session without disposing the workspace or sibling terminals, including top-level compound command lists and numeric error cases.
- Added native-shaped process and listener inspection with `ps aux`, `pgrep`, `pkill`, `ss -ltnp`, and `lsof -i :PORT`; split and combined flags compose normally. Expanded common `curl` flag composition, silent/show-error behavior, bounded redirects, cross-origin credential stripping, output-file failures, and write-out formatting for service debugging.
- Fixed `tsc file.ts` so explicit source files are compiled even when a nearby `tsconfig.json` excludes them, matching the native TypeScript command-line root-selection rule.
- Made cancellation interrupt a cold, directly warming browser provider immediately instead of waiting for Python, Java, C#, or C++ runtime initialization to finish before the command settles.
- Preserved the owning runtime actor and process ID when browser project workers write or delete files. Worker mutations now flow through the outer TraceKernel command context exactly once instead of being journaled as unattributed system changes.
- Routed package-script banners through the active command's live output context so terminal consumers receive one ordered stream whose bytes exactly match the returned stdout, including after Ctrl+C interrupts a nested script, without duplicating script output when the final result is reconciled or restored.
- Made live filesystem application abortable, restored same-realm browser globals before timed-out commands return, preserved final diffs that differ from an earlier live write to the same path, and converted readonly shell mutations into normal command failures.
- Hardened the project-workspace release gate so Node cannot exit while its asynchronous assertions are pending. The completed gate now covers foreground SIGINT exit status, expiration after hydration, executable path/glob normalization, transactional rollback, and cancellation while waiting on filesystem work.

### Changed

- Project workspaces now return as soon as the filesystem and terminal are ready while configured Python, JavaScript, TypeScript, Java, C#, and C++ providers warm in the background. A command issued during startup waits on that provider's existing initialization instead of starting a duplicate, including hosted Java execution-host readiness.
- Upgraded the project shell to just-bash 3.1.0. Redirects now preserve Bash-like create/truncate-before-write ordering, bundled `set -euo pipefail` works, and upstream fixes cover redirected file-descriptor routing, command substitutions containing heredocs, multiline quoted strings, and mixed text/byte output.

### Added

- Added a dedicated browser terminal-fidelity gate covering npm script banners, Node filesystem/module/syntax diagnostics, fetch and HTTPS transport errors, curl DNS behavior, interactive stdin/EOF, pipes, redirects, status expansion, background jobs, per-terminal shell state, listener/process inspection, terminal-local exit, and crash/timeout boundaries for Python, Java, C#, and C++ runners. The cross-engine provider matrix now also runs an invalid learner program for all six project languages and rejects any worker, host-path, Blob URL, harness-package, or TraceKernel branding in public diagnostics.
- Added generic kernel-owned process contexts for embedding applications. A host can assign a process name, actor, and `system-only` signal policy; direct file mutations retain that PID and actor, commands and terminal submissions retain parent lineage, and workspace `kill`, process-group signals, or `tracekernelctl reset` return `Operation not permitted` for protected processes while system control-plane disposal remains available.

## [0.11.1] - 2026-07-13

### Fixed

- Fixed browser-backed Node HTTP listener registration so `server.listen()` only reports success after TraceKernel accepts the bind. Conflicting listeners started from another project terminal now fail with `EADDRINUSE`, do not invoke the listen callback, and leave the original server running.

## [0.11.0] - 2026-07-12

### Added

- Added `terminal.interrupt()` to project terminal sessions. It sends `SIGINT` to the active foreground command, returns exit code 130 through the existing process lifecycle, restores the command prompt, and reports whether an interruptible command was present so terminal UIs can wire Ctrl+C without discovering kernel PIDs.
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
