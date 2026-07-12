# Classic browser provider performance ceiling — 2026-07-11

## Answer

The Classic harness can be pushed farther, but not uniformly. Isolated
JavaScript, TypeScript, C# cache-hit, and C++ cache-hit paths are at or close to
their practical browser floor. Python still has removable wrapper overhead.
Fresh Java, C#, and C++ source is compiler-bound and remains hundreds of
milliseconds or seconds unless the compiler/cache architecture changes.

The largest remaining wins are Java compiled-artifact reuse, Python runner
reuse with a fresh namespace, selected-language background warmup, and
compiler-specific work for fresh C#/C++ source. General worker/message tuning
will no longer materially move the heavy-compiler rows.

## Method

- Public path only: `createBrowserHarness() -> getClient() -> init/warmLanguage/execute`.
- Chromium through Playwright; no Node/native runtime provider.
- Immutable asset caching and zero `PerformanceResourceTiming.transferSize`
  in every command phase cited below.
- JavaScript/TypeScript: 10 samples. C++ cache-hit: 5 samples. Heavy-runtime
  command-ready probe: 3 samples for Python, Java, C#, and C++.
- Java used the official CheerpJ 4.2 CDN loader through a consumer-owned
  manifest. The manifest is benchmark/deployment configuration, not a
  TraceCode product default.
- Interactive rows use `--phase-delay-ms=25`, which is outside command timing
  and gives a never-used one-shot worker time to become ready. Zero-delay rows
  remain the burst-stress workload.
- Runtime-ready rows use `--prewarm-runtime`; prewarm wall time is reported
  separately and is not counted as command time.

CheerpJ 4.3 is the current upstream release, but this benchmark intentionally
uses 4.2 because that is the selected faster deployment version. CheerpJ's
Community License permits FOSS use from the official cjrtnc.leaningtech.com CDN;
self-hosting CheerpJ itself requires the applicable commercial license. The
harness only supplies generic manifest capability and does not select a CDN or
license model for consumers.

## Measured command-ready results

| Provider | Prewarm wall, fresh context | First ready command p50 | Cached/repeat p50 | Edited source p50 | Practical target | Assessment |
|---|---:|---:|---:|---:|---:|---|
| JavaScript | init 19 ms | 3.2 ms | 2.7 ms | 2.7 ms | 2–4 ms | At practical isolated-worker floor |
| TypeScript | init 19 ms + warm 115 ms | 7.1 ms | 4.3 ms | 4.1 ms | 4–8 ms | At practical floor after compiler JIT warmup |
| Python | warm 1,964 ms | 24 ms | 20 ms | 18 ms | 8–12 ms | More room; wrapper/parser path dominates small programs |
| C# | warm 3,054 ms | 966 ms | 3.9 ms | 882 ms | cache hit 2–4 ms; new source 0.7–0.9 s | Cache hit is at floor; new source is Roslyn/emit-bound |
| C++ | warm 2,866 ms | 1,980 ms | 8.4 ms | 1,936 ms | cache hit 7–10 ms; new source 1.6–1.9 s | Cache hit is at floor; new source is local Clang/link-bound |
| Java (CheerpJ 4.2) | init 1,376 ms + warm 7,760 ms | 1,561 ms | 825 ms | 612 ms | cached artifact 20–80 ms; new source 0.5–1.5 s | javac-bound; repeat currently recompiles by design |

The fresh-context prewarm column includes local asset fetch, parsing,
WebAssembly compilation, and runtime initialization. It is shown to make the
cost visible, not to claim that startup disappeared. CDN/WAN download time is
not included in the command-ready rows.

The final Python timing probe attributes about 17.4 ms of the 18 ms edited-source
wall time to work inside the runtime worker. The browser message boundary is
therefore not the bottleneck; reducing Python latency requires changing the
generated wrapper/runner path.

The Java command phases also had zero measured browser transfer bytes. Java
reported 598–1,546 ms of javac time for fresh/isolated command paths. Every
request currently uses a fresh classes directory, so the helper's local compile
cache cannot hit; the measured exact repeat is another compile, not the true
bytecode-cache floor.

## Critical Java findings

| Finding | Why it mattered | Resolution/status |
|---|---|---|
| Delivery URL and CheerpJ VFS path were represented by one manifest field | A valid browser/CDN URL is not the /app/... classpath CheerpJ consumes | Added optional generic runtimePath; preflight continues to verify url |
| Generic authority lockdown denied all fetch during user execution | CheerpJ lazily range-fetches pinned JDK/runtime resources after warmup, causing a 20 s timeout | Java now receives a capability-limited fetch allowing only GET/HEAD to the pinned loader directory and declared JAR paths |
| Java project mode uses CheerpJ /files inside permanent authority denial | /files is IndexedDB-backed; reopening ambient same-origin IndexedDB would expose application databases | Resolved for interactive workspaces with an exact-origin, credential-free execution host; adversarial evaluation remains per-command |
| Java compile isolation creates a new classes directory on every command | Safe isolation also guarantees compileCacheHit=false, making exact repeats ~825 ms | Correct today, but a trusted content-addressed bytecode cache can copy artifacts into each fresh run directory |
| CheerpJ 4.3 is current upstream, but this deployment selected 4.2 | Runtime upgrades can change speed and compatibility independently from the harness | Keep the version in the consumer manifest and test it as a deployment choice |

The capability-limited fetch preserves the authority boundary: it does not
restore arbitrary network access. The allowed surface is derived from the
configured, pinned CheerpJ loader directory and Java runtime artifacts.

The dedicated-origin project profile now passes end to end. Across three fresh
Chromium contexts using CheerpJ 4.2 and `java:1` prewarm, workspace construction
averaged 14.03 s (cold runtime/JDK work), the first tiny javac-and-run command
averaged 1.45 s, and the identical second command averaged 0.77 s. Both command
phases recorded zero response-body bytes, so these are post-download command
costs. Shell filesystem, readonly/hidden policy, and public HTTP phases averaged
2.45 ms, 1.33 ms, and 1.70 ms. The session VM is the interactive TraceCode
profile; hidden tests and multi-principal workloads retain the slower one-shot
boundary.

## Latest implementation gain

| Path | Prior p50 | Current p50 | Change | What moved |
|---|---:|---:|---:|---|
| JavaScript first execute after `init()` | 19.1 ms | 3.1 ms | -83.8% | Clean executor is prepared concurrently with init |
| JavaScript interactive repeat | 16.0 ms | 2.7 ms | -83.1% | One unused executor is kept ready |
| TypeScript immediate exact repeat | 17.8 ms | 4.4 ms | -75.3% | Trusted coordinator + clean executor overlap |
| TypeScript interactive edited source | 17.5 ms | 4.1 ms | -76.6% | Executor bootstrap is outside command time |
| C++ interactive exact repeat | 17.4 ms | 8.4 ms | -51.7% | Next clean worker initializes during editor think time |

Every executed JavaScript/TypeScript/C++ worker is still retired after its one
user command. Only a clean worker that has received trusted initialization—and
no user code—is held ready. The optimization therefore does not trade away the
per-command authority boundary.

The coordinator no longer imports the executor-only JavaScript library bundle.
That removes about 383 KB of duplicate encoded body per JavaScript/TypeScript
init sample (about 29% of the measured init response body) and avoids parsing a
second copy in the trusted coordinator.

## Remaining work, in priority order

| Priority | Provider | Work | Likely impact | Constraint |
|---:|---|---|---:|---|
| 1 | Python | Install a trusted runner once, pass requests as data, and execute user code in a fresh namespace | Roughly 6–10 ms | Must prove builtins/modules and helper state cannot leak between commands |
| 2 | Consumer app | Call `warmLanguage()` on language selection/intent and serialize heavy warmups | Removes 2–3 s from click-to-result | Startup CPU/memory still exists and must not warm every runtime at once |
| 3 | Java | Add a bounded trusted content-addressed class-artifact cache, then copy bytecode into a fresh per-command directory | Repeat from ~825 ms toward tens of ms | Cache key must include generated source, runtime/helper versions, compiler flags, and execution mode |
| 4 | C# | Cache generated syntax trees/driver components; evaluate an AOT-compiled host | Tens to low hundreds of ms; AOT may do more | Emit dominates; AOT increases payload, build time, and startup memory |
| 5 | C++ | Split stable driver/runtime objects from the user translation unit; profile PCH/modules | Roughly 10–35% on new source | About 99% of edited-source time is compiler work |
| 6 | Heavy runtimes | Add opt-in persistent artifact caching across reloads | Near cache-hit latency for previously compiled exact sources | Same-origin persistence is mutable; secure deployments need authenticated metadata or must treat it as an untrusted cache |

## Realistic endpoint

| Path | Realistic endpoint without changing provider semantics | What would be required to go materially beyond it |
|---|---:|---|
| JavaScript | 2–4 ms interactive | Retain/reuse a user-tainted realm, weakening per-command isolation |
| TypeScript | 3–6 ms interactive | Prepared-source cache or retained realm; only ~1–2 ms remains |
| Python | 8–12 ms | Reusable trusted runner plus rigorously fresh namespace/module state |
| Java exact source | 20–80 ms | Trusted bytecode cache copied into a fresh classloader directory |
| Java new source | 0.5–1.5 s | Different/incremental compiler architecture or external compilation |
| Java project command | ~0.7–1.5 s after workspace-session warmup | Content-addressed bytecode cache or incremental compiler; per-command adversarial mode remains much slower |
| C# exact source | 2–4 ms | Already effectively at the browser boundary |
| C# new source | 0.5–0.9 s | AOT Roslyn host and/or incremental compiler pipeline |
| C++ exact source | 7–10 ms | Already close to worker/Wasm instantiation floor |
| C++ new source | 1.3–1.9 s | Split objects/modules, or a different/external compiler service |

## Burst versus interactive latency

A single standby worker optimizes real editor use without retaining a large
pool. Under a synthetic zero-delay burst, JavaScript/TypeScript replacement
workers cannot always replenish inside a 3–5 ms command, so later calls can be
about 12–13 ms. Raising the standby depth would improve that burst benchmark at
the cost of idle memory. Batched test cases already use one worker command, so a
larger default pool is not justified by the current product workload.

Chrome DevTools tracing validated a warmed TypeScript repeat at 6.2 ms while a
trace was active. The first evaluation after trace startup incurred about 225 ms
of tracing-tool startup perturbation, so the Playwright multi-sample timer—not
that first traced invocation—is the authoritative microbenchmark.
