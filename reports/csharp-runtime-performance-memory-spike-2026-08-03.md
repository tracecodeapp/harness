# TraceCode C# browser runtime performance and memory spike

Date: 2026-08-03
Spike base commit: `a3da1a077ad9c0f8dcb4e6d51af26893635e840d`
Status: production-shaped candidate prepared for draft review; one-off experiment harnesses remain outside the production diff

## Executive verdict

Sub-second browser C# Judge is achievable without weakening TraceKernel.
The fastest validated prototype compiles an edited Judge submission in
137–194 ms in Chromium, 118–175 ms in WebKit, and 432–642 ms in Firefox once
the trusted compiler authority is warm. A complete ten-case Chromium Judge
lease takes 221 ms plain or 283 ms traced; WebKit takes 223/265 ms; Firefox
takes 787/853 ms. Chromium and WebKit can eagerly prepare both modes in about
503/488 ms. Firefox should prepare only the requested mode.

The overlooked cost was not C# itself, TraceKernel, or its filesystem. Every
submission re-parsed and re-emitted approximately 83,925 characters / 2,065
lines of trusted JSON hydration and Judge runtime code alongside the learner's
small source. Warm Chromium spent roughly 78 ms parsing that trusted source and
1,099 ms in Roslyn Emit. Compiling the trusted Judge runtime into the host once
shrinks normal learner artifacts from 43,008 bytes to 9,216 bytes plain or
9,728 bytes traced and moves steady compilation into the sub-second range in
all three browsers.

The best architecture is the TraceJVM 0.3 pattern:

1. one serialized, trusted, persistent Roslyn compiler authority;
2. a precompiled, versioned trusted Judge runtime and bounded immutable syntax
   templates;
3. immutable content-addressed learner PE artifacts crossing a capability
   boundary;
4. a separate compiler-free .NET runner bundle, prewarmed only with fixed
   trusted code;
5. one learner submission per disposable runner/process lease;
6. TraceKernel retains all learner filesystem, process, descriptor, signal,
   network, Mux, and retirement authority.

The compiler authority retains no learner source, syntax, mutable memory,
filesystem, process/kernel capability, trace state, or user authority. A
prewarmed runner has seen only fixed trusted warmup assemblies before it is
leased; after one learner it is destroyed. TraceKernel's process and Mux
isolation invariants remain the security boundary.

The 200-problem hybrid run matched all 200 status classifications and achieved
199/200 strict full-row parity. The sole difference is an already-invalid
`24-game` submission where the prepared path omits two secondary diagnostics;
its status and primary error match, and there is no successful-program output
or trace mismatch. All warmed compiles completed below one second: the 368
normal-mode compiles had a 127 ms median and 317 ms p95; the 32 compatibility
fallback compiles for learner-declared `ListNode`/`TreeNode` had a 668 ms median
and 787 ms p95.

The hybrid bundle adds 1,221,408 raw bytes / 414,619 Brotli bytes to today's
bundle. The current same-bundle prototype still loads Roslyn in both authority
and runner, so its memory and duplicate-fetch numbers are intentionally not the
production target. Building the compiler-free runner is the next production
prototype.

## Sub-second continuation

### Causal phase profile

Detailed timings were added at deserialization, artifact-keying, cache lookup,
learner parse, policy validation, trace rewrite, trusted runtime generation and
parse, references, driver generation and parse, compilation construction,
Emit, PE extraction, cache store, and base64 boundaries.

On a warm edited Chromium compile before precompiling the runtime:

| Phase | Representative time |
|---|---:|
| Trusted Judge runtime parse | ~78 ms |
| Roslyn Emit | ~1,099 ms |
| Learner parse/policy/driver/other | single-digit to low-double-digit ms each |

The interpreted Roslyn authority also tier-warms. Repeated distinct Chromium
edits fell from 1,125 ms to roughly 804–925 ms without changing flags; WebKit
settled at 623–798 ms and Firefox at 2.4–2.6 s. Caching trusted syntax templates
alone moved Chromium to 721–824 ms code / 670–735 ms trace, proving the large
runtime tree was causal but leaving Emit to process it on every submission.

### Precompiled trusted Judge runtime

The experimental build converts the existing generated Judge runtime source
into a normal trusted host compilation unit. Normal learner compilations then
contain only:

- learner source;
- trusted global imports/template state;
- the small per-problem driver;
- references to the immutable trusted Judge runtime.

Steady distinct-source compiler timings:

| Engine | Plain code | Traced code | First cold compiler |
|---|---:|---:|---:|
| Chromium | 137–180 ms | 135–160 ms | ~2.35 s |
| WebKit | 126–155 ms | 118–135 ms | ~2.25 s |
| Firefox | 456–578 ms | 432–494 ms | ~7.24 s |

The cold compiler cost can run behind page/session prewarm. It is not charged
to a learner submission once the trusted authority is ready.

The first direct precompiled prototype produced extra ordered trace events for
learner-declared `ListNode` and `TreeNode`: the old generated runtime emitted
type-specialized hydration while the precompiled runtime had to use its generic
constructor/reflection path. The hybrid therefore detects those declarations
and uses the existing embedded runtime for that bounded compatibility case.
This restored the focused node digest exactly and kept every warmed fallback
compile below one second.

### Prewarmed disposable Judge leases

The runner experiment performs fixed trusted plain and traced warmups before
lease, then accepts one learner submission and is retired. Its user-visible
ten-case timings were:

| Engine | Plain compile + run | Trace compile + run | Both sequential |
|---|---:|---:|---:|
| Chromium | 167 + 54 = 221 ms | 194 + 88 = 283 ms | 503 ms |
| WebKit | 152 + 71 = 223 ms | 175 + 90 = 265 ms | 488 ms |
| Firefox | 571 + 215 = 787 ms | 562 + 292 = 853 ms | 1,640 ms |

Hidden fixed-code prewarm was about 3.7 s in Chromium/WebKit and 11.84 s in
Firefox for this deliberately unoptimized prototype. Firefox should lazily
compile only the selected plain/trace mode; Chromium and WebKit can preserve
today's eager dual-mode UX under one second.

The fast Chromium Judge campaign peaked near 791 MiB and settled near 194 MiB.
The Firefox dual-mode campaign peaked near 1.50 GiB and retained roughly
995 MiB while its browser process remained alive. Those are same-bundle
prototype costs. The required compiler-free runner removes Roslyn assemblies,
metadata, compiler caches, and duplicate full-bundle fetches from disposable
leases.

### Corpus correctness

The final Chromium hybrid campaign covered all 200 C# corpus entries:

| Evidence | Result |
|---|---:|
| Status parity | 200/200 |
| Strict full-row parity | 199/200 |
| Successful output mismatch | 0 |
| Ordered trace digest/event-count mismatch after hybrid fallback | 0 |
| Code statuses | 112 completed / 75 compile-failed / 13 runtime-failed |
| Trace statuses | 111 completed / 76 compile-failed / 13 runtime-failed |
| Normal precompiled compiles | 368; median 127 ms; p95 317 ms |
| Node compatibility compiles | 32; median 668 ms; p95 787 ms |

The baseline half of this direct persistent-worker comparison took 59.91 s.
The prototype half took 194.62 s because the corpus harness intentionally
constructed and destroyed a fresh runner for every entry and did not consume
the prewarmed lease pool. Its purpose was isolation/correctness validation, not
the end-to-end timing represented by the table above. Peak browser-tree RSS was
1.229 GiB; after context close it settled at 205 MiB.

### General C# and filesystem validation

The hybrid bundle also passed the Chromium public Project fixtures for fresh
commands, diagnostic fidelity, filesystem, policy denial, HTTP bridge, process
I/O, cancellation, runtime cancellation, and disposal. TraceKernel filesystem
operations were already fast: 5.5 ms for the fixture, including approximately
0.45 ms host write, 0.20 ms host read, and 4.69 ms shell work. Policy denial was
4.1 ms, HTTP bridge 8.9 ms, process I/O 2.5 ms, and disposal 1.5 ms.

Fresh Project C# commands remained 2.37–2.56 s because Project correctly
compiles arbitrary files and does not use the Judge-only precompiled driver.
This is important causal evidence: Judge's win is not a filesystem shortcut.
For production, the trusted Judge runtime should be a separate assembly
referenced by the Judge compiler/runner only, so `ListNode`, `TreeNode`, and
Judge APIs do not enter ordinary Project, terminal, filesystem, network, or
server semantics.

### Rejected experiments

- Debug Roslyn emit did not improve compiler latency and increased the learner
  PE from 43,008 to 46,080 bytes.
- Full host AOT produced a 62.85 MB raw bundle and failed at runtime because
  reflection-based JSON metadata was disabled.
- Selectively AOTing Roslyn first produced missing wrapper/link failures.
  Rooting CoreLib and host state sufficiently to link then hit a Mono
  `interp.c:2737` assertion at the mixed AOT/interpreter boundary. It is not a
  credible next step while precompiling trusted Judge code already puts every
  warmed browser below one second.

### Download frontier

| Bundle | Files | Raw | gzip -9 | Brotli q11 |
|---|---:|---:|---:|---:|
| Current | 239 | 50,129,106 B | 17,467,979 B | 14,061,164 B |
| Hybrid experiment | 259 | 51,350,514 B | 17,956,464 B | 14,475,783 B |
| Delta | +20 | +1,221,408 B | +488,485 B | +414,619 B |

The experiment server deliberately disabled persistent caching, so compiler
and runner fetched duplicate full bundles: roughly 89 MB raw across 457
requests in the fast Judge run. Browser caching can share immutable bytes, but
the correct architecture remains two purpose-built artifacts: a retained
Roslyn authority and a small compiler-free runner.

## Scope and causal methodology

This work intentionally established clean-to-clean floors before comparing
TraceCode to native execution.

Measured layers:

1. clean native .NET 10 + Roslyn 5.3.0;
2. clean browser .NET/Mono Wasm with a `clean-csharp:42` program and no Roslyn;
3. raw TraceCode compiler preparation;
4. raw prepared artifact execution;
5. public Judge -> TraceKernel -> C# prepared provider, plain and traced;
6. public browser Project/terminal path;
7. persistent compiler + disposable runner prototype;
8. complete 200-entry C# corpus;
9. terminal/filesystem/HTTP/process/cancellation fixtures.

Wall time starts before the user-facing API call and ends after the result or
receipt is available. Browser physical memory is sampled every 50 ms from the
Playwright browser-server process tree with `ps`, not inferred from JS heap.
Chromium is the deep-introspection engine. Firefox and WebKit repeat semantic
and timing conclusions; macOS WebKit's external WebContent process topology
makes the current descendant-tree RSS counter an undercount, so its absolute
RSS is not used for the verdict.

The machine was an Apple M1 Pro with 32 GiB RAM, macOS 26.5 (25F71). No
memory-intensive campaigns were deliberately stacked by this task. Other host
load can still perturb wall time, so conclusions rely on repeated sweeps and
large causal deltas rather than single-digit percentages.

## Versions

| Component | Version |
|---|---:|
| Harness | 0.14.6 |
| Harness commit | `a3da1a077ad9c0f8dcb4e6d51af26893635e840d` |
| Node | 25.9.0 |
| pnpm | 10.4.1 |
| Playwright | 1.58.2 |
| Chromium | HeadlessChrome 145.0.7632.6 |
| Firefox | 146.0 |
| WebKit | Safari/WebKit 26.0 / 605.1.15 |
| Host .NET SDK/runtime | SDK 10.0.107, runtime 10.0.7 |
| Browser C# runtimeconfig | Microsoft.NETCore.App 10.0.10 |
| Roslyn | Microsoft.CodeAnalysis.CSharp 5.3.0 |
| TraceJVM 0.3 reference | release-prep commit `06b4fcd89ea9facaa0564f43b44ff7151ebf4d9d` |

The native floor is patch-close rather than bit-identical to the vendored
browser runtime: host .NET is 10.0.7 while the checked browser runtimeconfig is
10.0.10. Roslyn is exact.

## Existing architecture and why exact repeats are slow

Judge remains correctly layered over TraceKernel:

```text
Practice / Playground / Mock / Mux
              -> Judge
              -> JudgeKernelPort
              -> TraceKernel
              -> private prepared runtime provider
```

TraceKernel owns sessions, PIDs, filesystem images, descriptors, signals,
watchdogs, runtime leases, taint, and teardown. Judge prepares once and uses a
provider-isolated ten-case batch while preserving ordered results. Mux hosts
the same browser module in replaceable slots and owns capacity/queue/slot
lifecycle, not language semantics.

The C# client currently serializes prepared operations and wraps every one in
`runFreshPreparedGeneration()`:

1. terminate any worker;
2. initialize full .NET/Roslyn worker;
3. prepare source to PE;
4. terminate;
5. initialize a second full .NET/Roslyn worker;
6. load PE and run the batch;
7. terminate.

The host artifact cache can carry opaque PE bytes across worker generations,
but the preparation path still creates a new compiler runtime. Case timings
show `hostArtifactCacheHit: true` in the execution worker; that must not be
misread as a submission-level compile cache hit. End-to-end exact repeats do
not improve.

This retirement policy is honest today. A collectible
`AssemblyLoadContext` isolates a learner assembly, but not process-global .NET
state, filesystem, environment, current directory, cultures, switches, or
kernel capabilities. The optimization must split capabilities; it must not
reuse the learner's outer worker or weaken TraceKernel.

## Clean floors

### Native

`NativeClean.csproj` dynamically compiles and invokes a tiny `Add` method with
Roslyn 5.3.0, unloads a collectible assembly context, forces full GC, and
reports process working set and managed heap.

| Phase | First | Warm range |
|---|---:|---:|
| Reference initialization | 42.21 ms | retained |
| Parse | 37.03 ms | 0.058–0.140 ms |
| Emit | 490.95 ms | 2.47–10.22 ms |
| Assembly load + invoke | 0.358 ms | 0.220–0.330 ms |
| Process max RSS | 164.9 MiB | same process |
| Final managed heap | 14.7 MiB | after forced GC |
| Generated PE | 2,048 bytes | 2,048 bytes |

The process run was 1.13 s real; the build was 2.01 s real. Random assembly
names make each PE hash intentionally different, while output remains exact.

### Clean browser .NET

The clean AppBundle has no Roslyn and prints `clean-csharp:42`.

| Engine | Worker wall (3 runs) | Whole page wall (3 runs) | Notes |
|---|---:|---:|---|
| Chromium | 106.36–107.00 ms | 279.09–280.60 ms | JS import 2.79–26.98 ms; runtime create/run remainder |
| Firefox | 131.5–267.0 ms | 380.83–596.22 ms | first run slower |
| WebKit | 150.28–206.94 ms | 401.36–571.06 ms | process RSS undercounted |

Clean worker phase attribution:

| Engine | JS glue import | Runtime create bucket | Main + worker completion |
|---|---:|---:|---:|
| Chromium | 2.73–26.91 ms | 55.63–81.76 ms | 22.42–24.04 ms |
| Firefox | 3.96–7.00 ms | 82.24–134.74 ms | 45.02–125.26 ms |
| WebKit | 32.04–33.38 ms | 89.32–134.46 ms | 28.84–38.10 ms |

Chromium fetched 3,017,531 response-body bytes over 11 responses per clean
worker; WebKit reported 3,018,952/11. Firefox's Playwright response-size
observer reported only 2,563,728/7 and is treated as incomplete rather than as
a smaller runtime. The local server sent uncompressed bodies, so network
decompression was exactly zero in these timing runs. Gzip/Brotli deployable
sizes are measured separately in the artifact frontier.

The public .NET loader does not expose independent timestamps for Wasm
download, decode, native compilation, assembly materialization, and managed
runtime initialization. They are causally contained in the `runtime create`
bucket above; inventing a finer split from resource completion times would
double-count parallel work. Likewise, clean `main + worker completion`
contains managed entry-point execution and teardown. Native Roslyn separately
exposes reference initialization, parse, emit, assembly load/invoke, forced
GC, and final working set; TraceCode host timings expose runtime init,
parse/emit combined as `compileMs`, assembly execution as `runMs`, and
retirement/settling outside the host call.

The actual AppBundle is about 3.35 MB raw. The 37 MB publish asset directory
also contains static libraries and build inputs and is not a deployable size.

Chromium process-tree RSS rose from roughly 261–266 MiB baseline to
336–351 MiB peak. The clean page reported only about 0.67 MB used JS heap,
demonstrating why JS heap is not an acceptable memory proxy.

## Public production baseline

### Judge, ten eager cases

Each row uses the public `createBrowserJudgeHost()` and
`evaluateAlgorithm()` path through Judge and TraceKernel. Exact repeat means
the same bundle and source; edited means an otherwise-equivalent source with a
content change.

| Engine | Plain cold | Exact repeat | Edited | Trace cold | Current average |
|---|---:|---:|---:|---:|---:|
| Chromium | 8.85 s | 8.96 s | 8.83 s | 9.08 s | 8.93 s |
| Firefox | 27.05 s | 29.41 s | 26.69 s | 27.37 s | 27.70 s |
| WebKit | 10.46 s | 10.23 s | 9.04 s | 8.84 s | 9.50 s |

Every run passed all ten cases. Every case returned `1`, proving mutable static
state did not leak between cases. Each ten-case batch had one TraceKernel
session id, as designed.

The plain production evaluation fetched 420 responses and 86,774,799 response
body bytes in Chromium: two approximately 43.38 MB C# runtime generations.
Exact repeats and edited submissions transferred the same amount. A prior
`--cache-assets` project sweep still transferred the full runtime per fresh
worker, so ordinary browser HTTP caching does not currently remove this tax.

Tracing itself is not the dominant delay. Plain and traced production runs are
close because runtime/compiler startup dominates. The cross-engine traced
fixture produced six events per case and the exact same ordered event digest
in production and the split prototype:

`eb6d2a50082148fc48ee9f760709bb6183fcdb0efc0060d72a7dc9307dd71583`

Plain outputs likewise matched with digest:

`4d417efac51835eb0795550275c95bc7001c6e50f0c37e7ff381af198cfb7a8a`

### Browser Project / terminal path

Chromium, three fresh samples:

| Phase | Result |
|---|---:|
| Workspace construction | 55.6 ms average |
| First command | 3.99 s average |
| Second fresh command | 3.98 s average |
| Failure fidelity | 3.94 s average |
| Runtime payload per C# command | about 43.54 MB encoded / 209 resources |
| Browser tree baseline | 235–283 MiB |
| Browser tree peak | 707–718 MiB |
| Settled after disposal | 510–517 MiB |

Filesystem, policy denials, HTTP bridge, process I/O, cancellation, runtime
cancellation, and disposal all passed. The Project path uses one runtime per
command rather than Judge's prepare-plus-run pair, explaining its roughly
four-second Chromium wall time.

One-sample cross-engine validation used the same public Project API and the
same general fixtures:

| Engine | First command | Second fresh | Failure fidelity | Result |
|---|---:|---:|---:|---|
| Chromium | 3.99 s avg (3) | 3.98 s avg (3) | 3.94 s avg (3) | all phases passed |
| Firefox | 13.25 s | 13.02 s | 13.02 s | all phases passed |
| WebKit | 5.11 s | 3.88 s | 3.93 s | all phases passed |

Firefox emitted the WebAssembly exception-handling deprecation warning once
per runtime load: the current build still emits the deprecated `try`
instruction instead of `try_table`. Its Project tree rose from 322.6 MB to
1,396.4 MB and settled at 1,230.9 MB before outer browser closure. WebKit's
95.4–115.8 MB descendant result excludes its external WebContent processes and
is not an absolute memory measurement.

## Memory attribution

### Browser-tree measurements

| Engine | Start | Peak | After page/context close | Reliability |
|---|---:|---:|---:|---|
| Chromium Judge | 245 MiB | 741 MiB | 167 MiB | usable |
| Firefox Judge | 314 MiB | 1,192 MiB | 705 MiB | usable but allocator/process retention is high |
| WebKit Judge | 86 MiB | 110 MiB | 97 MiB | undercounts external WebContent processes |

In Chromium, after the current host was disposed the tree was about 428 MiB.
Keeping the compiler authority alive raised the phase peak to 568–584 MiB.
Adding the current full-bundle disposable runner raised it to 736–741 MiB.
After authority disposal the tree was about 443 MiB, and closing the page and
context returned it to 165–167 MiB. This puts the retained compiler's
incremental process cost around 140–160 MiB in this sweep, subject to browser
allocator reuse.

A live Chromium renderer `vmmap -summary` recorded 267.7 MiB physical
footprint and 422.2 MiB peak. Its largest writable/resident categories were:

- `Memory Tag 253`: 219.6 MiB resident;
- `VM_ALLOCATE`: 99.1 MiB resident;
- `Memory Tag 255`: 42.2 MiB resident.

`vmmap` could not inspect Chromium's PartitionAlloc zone, so those labels are
not a complete ownership map. They still rule out "JS heap" as the explanation.

The experiment-only worker probe reported an initial Wasm linear heap of
140,640,256 bytes in every production compiler worker. Runner heaps were
140,640,256 bytes for most entries and grew to 168,820,736 or 243,204,096
bytes for high-water entries. The full production corpus browser tree peaked
at 763,248,640 bytes and returned to 178,814,976 bytes after page/context
closure. This is direct evidence that linear memory is a major component while
also showing that it is not the whole browser RSS.

Interpretation:

- raw assets are only 50.13 MB, so the 500–900 MiB process increments are not
  file bytes alone;
- clean JS heap is under 1 MB;
- each compiler or runner begins with a 134.1 MiB linear heap; learner
  execution can grow one runner to 232.0 MiB;
- decoded assemblies/runtime metadata, compiled Wasm/native code, duplicated
  per-worker buffers, and browser allocator retention are the remaining large
  categories;
- terminating a worker removes live authority but does not force the browser
  process allocator to return every page immediately to the OS.

## Persistent compiler / disposable runner prototype

The prototype uses the existing worker protocol in an experiment-only
coordinator:

```text
serialized trusted compiler worker
  owns: Roslyn, immutable references, content-addressed PE cache
  lacks: TraceKernel process/filesystem/network/user authority
                 |
                 | PE bytes + key + diagnostics
                 v
fresh runner worker / TraceKernel process lease
  owns: one learner execution and runner-local mutable state
  retired: after submission/batch, timeout, cancel, crash, or taint
```

It intentionally calls `execute-prepared-*` without the current compiler
warmup on a fresh runner. That proves a prepared PE does not require Roslyn
initialization for execution. The current runner asset still contains Roslyn,
so this is a conservative speed result and a pessimistic memory/download
result.

| Engine | Cold compile | Exact compile | Edited compile | Fresh runner | Edited total | Exact total |
|---|---:|---:|---:|---:|---:|---:|
| Chromium | 3.85 s | 3.9 ms | 1.15 s | 1.09 s | 2.23 s | 1.09 s |
| Firefox | 12.06 s | 12.9 ms | 3.98 s | 2.65 s | 6.63 s | 2.67 s |
| WebKit | 3.50 s | 1.00 s | 1.09 s | 1.34 s | 2.43 s | 2.35 s |

WebKit reports an internal compiler cache hit on the exact repeat despite the
roughly one-second outer wall time. This likely reflects engine GC/scheduling
or message latency and should be remeasured in a longer sweep.

Chromium phase details:

- cold compile: 759 ms runtime initialization + 2,807 ms Roslyn compile;
- exact compile: 0.12 ms compiler work, 4 ms total;
- edited compile: 1,104 ms compile, no runtime reinitialization;
- runner's first case: roughly 654 ms runtime init + 213 ms host call;
- later cases: typically 6–13 ms each in collectible assembly contexts.

The prototype's current peak is worse than production when compiler and runner
overlap because both workers load the full 50 MB distribution. A separate
runner AppBundle is required before treating the memory result as an
architecture regression.

## Complete 200-entry C# corpus

Corpus:

`/Users/obinnanwachukwu/Code/algoflow/experiments/leetcode-kaysss/transpiled/python-v1-smoke200/tracecode-harness-corpus.json`

The file contains exactly 200 C# and 200 TypeScript entries. Only the 200 C#
entries are in scope. Compile failures, runtime failures, limits, and
diagnostics are retained as expected observations; the corpus is not filtered
to passing algorithms.

Direct current-worker oracle versus split prototype:

| Result | Current direct worker | Split prototype |
|---|---:|---:|
| Code completed | 112 | 112 |
| Code compile-failed | 75 | 75 |
| Code runtime-failed | 13 | 13 |
| Trace completed | 111 | 111 |
| Trace compile-failed | 76 | 76 |
| Trace runtime-failed | 13 | 13 |
| Exact rows | 199/200 | 199/200 |

The one direct-oracle mismatch is
`transpiled:python-v3:csharp:fbe828aeb1db12f97c873345`. Status, primary
diagnostics, output, limits, event counts, and event digest match. The direct
`Execute` path adds two `TraceCodeDriver.cs` secondary diagnostics while the
prepared `Prepare` path does not. This is a current direct-versus-prepared
diagnostic-surface difference, not learner execution drift. The production
Judge corpus below decides which surface is authoritative.

The direct oracle took 268.09 s. The split corpus took 427.58 s because it
retired one outer runner per submission while the direct oracle retained an
unsafe combined worker. The split fetched 5,212.4 MiB over 26,334 local
responses versus 41.4 MiB/208 responses for the retained direct worker. This
is exactly why a compiler-free runner and immutable asset delivery are
required; the current full bundle cannot be multiplied per lease at scale.

The authoritative public Judge -> TraceKernel corpus then ran all 200 traced
submissions:

| Production result | Count |
|---|---:|
| Completed | 111 |
| Compile-failed | 76 |
| Runtime-error | 13 |
| Harness/browser abort | 0 |

It took 1,545.67 s inside the user-facing operation (1,549.51 s whole
campaign), with 8.26 s median, 10.58 s p95, and 17.82 s maximum per entry.
The browser tree started at 167.7 MB, peaked at 763.2 MB, and settled at
178.8 MB after full closure.

The production run fetched 14,058,243,428 local response-body bytes across
68,116 requests. That is not a 14 GB artifact: it is the same roughly
43.38 MB runtime repeatedly instantiated. All 200 compiler workers load it,
and the 124 successfully compiled entries load it a second time for execution.
Compile failures correctly avoid the second generation.

Production versus the persistent-compiler/disposable-runner prototype:

| Exact check | Rows |
|---|---:|
| Source hash | 200/200 |
| Preparation/completion status | 200/200 |
| Output | 200/200 |
| Timeout/limit state | 200/200 |
| Trace event count | 200/200 |
| Ordered trace SHA-256 | 200/200 |
| Judge-compatible primary diagnostic | 200/200 |
| Full raw diagnostic array | 137/200 |

The 63 raw diagnostic-array differences are all compile failures. Judge
projects the primary diagnostic; the lower-level prototype returns that same
primary diagnostic plus the remaining Roslyn diagnostics. There is no
different diagnostic message at the primary position and no execution or
trace mismatch. This means the architecture passes the compiler/runtime
semantic gate, but a production provider adapter must retain Judge's existing
diagnostic projection. Until that adapter is exercised through Judge, claim
`200/200` for status/output/trace/limits/primary diagnostics and `137/200` for
byte-equivalent full
diagnostic arrays—not a blanket exact-parity claim.

## Artifact frontier

Current deployed tree before compression:

| Category | Raw |
|---|---:|
| Roslyn core assemblies | 9.48 MiB |
| Roslyn satellite diagnostic resources | 6.14 MiB |
| Compiler reference support files | 9.68 MiB |
| Other framework assemblies | 18.81 MiB |
| Runtime native JS/Wasm | 3.11 MiB |
| TraceCode host | 0.59 MiB |
| Total | 50,129,106 bytes / 239 files |

The boot manifest fetches 43.38 MB per worker in the local server sweep. A
public Judge evaluation starts two workers and fetches 86.77 MB.

An artifact-only prototype removed 26 Roslyn satellite resource assemblies,
6,446,394 total tree bytes (6,440,482 assembly bytes). The Chromium ten-case
plain and trace fixtures retained exact outputs and ordered trace hashes. It
saved only 5,929 fetched bytes per default-culture worker because satellite
assemblies were already lazy; this is a package/download-at-rest win, not a
startup win. The timing sweep was noisier and slower, so no latency benefit is
attributed. Localization remains a contract decision and still needs a
three-engine localized-diagnostics gate.

Exact inventory (gzip level 9, Brotli quality 11):

| Bundle | Files | Raw | Gzip | Brotli |
|---|---:|---:|---:|---:|
| Clean .NET runtime | 15 | 3,349,832 | 1,207,078 | 1,003,659 |
| Current combined runtime | 239 | 50,129,106 | 17,467,979 | 14,061,164 |
| No Roslyn satellites | 214 | 43,682,712 | 15,815,181 | 12,664,909 |
| Full-host AOT experiment | 121 | 62,854,684 | 18,946,587 | 14,088,685 |

The current largest compressed object is
`Microsoft.CodeAnalysis.CSharp.wasm`: 6,884,633 raw / 1,886,404 Brotli,
SHA-256
`e3a84ff5210099a5cba7b02bffdbdfd31f4b107eb707a84622006128b24e19bd`.
The AOT experiment moves most code into a 34,658,011-byte
`dotnet.native.wasm` (7,229,119 Brotli), SHA-256
`d7f0c22904cc7a4fe7cf8eea49cd3f126620310b721a411ac02a58ec2d0b44f1`.

The frontier is therefore:

1. clean runtime floor: ~3.35 MB raw, but no compiler/general runner host;
2. separate runner target: clean runtime + TraceCode host + the BCL closure
   required by Project/terminal/server fixtures, with no Roslyn or reference
   pack;
3. compiler authority: Roslyn + immutable reference pack, paid once per slot;
4. current combined bundle: 50.13 MB raw / 14.06 MB Brotli, paid once or
   twice per operation;
5. full-host AOT: 62.85 MB raw / 14.09 MB Brotli and not semantically viable;
6. multi-gigabyte single artifacts: rejected regardless of speed.

## Generality and isolation gates

The architecture is not allowed to specialize C# into a Solution-only engine.
The existing host also supports:

- top-level programs and normal console semantics;
- Project files and multi-file workspaces;
- terminal stdin/stdout/stderr;
- TKFS-backed filesystem reads, writes, and metadata;
- processes, cancellation, signals, and retirement;
- TraceKernel HTTP/network/server bridge;
- compile diagnostics and failure fidelity.

The public Project benchmark passed filesystem, policy, HTTP, process I/O,
cancellation, and runtime cancellation phases. Focused lifecycle and
TraceKernel test results are listed in the verification section.

Production split requirements:

- compiler requests serialized;
- compiler accepts source/reference inputs and emits only immutable PE/PDB,
  content key, and diagnostics;
- compiler cannot execute learner PE;
- compiler has no learner filesystem, process, TraceKernel, Mux, network,
  descriptor, environment, or user authority;
- runner cannot compile source and does not ship Roslyn;
- each runner is bound to a TraceKernel process lease and destroyed on release,
  taint, timeout, cancellation, crash, or reset failure;
- Project commands use the same runner substrate with explicit project
  capabilities; no algorithm-only shortcut;
- Mux keeps replaceable slots and authenticates/signs exact Judge bundles and
  receipts; it does not receive a direct runtime bypass.

## Provider and primitive evaluation

| Option | Verdict | Reason |
|---|---|---|
| Current .NET/Mono + Roslyn combined worker | Keep as oracle, replace topology | Correct modern semantics and broad runtime, but double initialization is dominant |
| Persistent Roslyn + compiler-free disposable .NET runner | **Recommended** | Preserves semantics/offline goals and matches TraceJVM's proven authority split |
| Custom-owned trimmed .NET browser builds | Recommended prototype | Needed to own compiler/runner closures, localization, boot fetch policy, and hashes |
| Wasm AOT of trusted compiler | Defer | Full-host AOT failed; selective Roslyn/CoreLib AOT linked but asserted at the mixed AOT/interpreter boundary |
| Precompiled trusted Judge runtime | **Recommended** | Measured 118–194 ms Chrome/WebKit and 432–642 ms Firefox compiles while learner assemblies remain dynamic |
| NativeAOT as learner runner | Reject | Official limitations include no dynamic assembly loading, which conflicts with learner PE execution |
| Mono `mcs` / legacy compiler | Reject | Wins by losing current C# language semantics |
| Server-side Roslyn/CoreCLR | Reject for default | Breaks client-side/offline goal; could be an explicit separate product policy only |
| Custom C# parser/interpreter | Reject | Cannot honestly preserve modern C# and general Project/server behavior |
| CS-Script or similar wrappers | Reject as fundamental change | They wrap Roslyn and do not remove runtime/compiler costs |

The current full host was published with Mono/Wasm AOT as a genuinely
different measured primitive. AOT required `PublishTrimmed=true`, completed in
130.45 s, and reached 3.84 GB maximum build-tree RSS. The linker warned about
dynamic JSON, `AssemblyLoadContext.LoadFromStream`, Roslyn, and TraceCode's
reflective normalization. Its Chromium Judge smoke then failed every worker
request before a phase could complete and closed the browser. Combined with
the larger frontier point above, full-host AOT is rejected.

Selective compiler AOT was subsequently attempted. A Roslyn-only scope failed
to link due to undefined wrappers. Adding CoreLib and rooted host state linked,
but Mono asserted at `interp.c:2737` across the mixed AOT/interpreter boundary.
That route is deferred: precompiling the trusted Judge runtime achieves the
Firefox sub-second goal without a fragile mixed-mode runtime or large AOT
frontier point.

Licenses were checked before recommending ownership:

- .NET runtime and distributions used here: MIT plus bundled third-party
  notices;
- Roslyn: MIT;
- the Harness remains AGPL-3.0-only;
- a fork/custom build must preserve .NET/Roslyn copyright, MIT text, and all
  relevant third-party notices in the separately deployed runtime release.

Primary references:

- https://github.com/dotnet/runtime/blob/main/LICENSE.TXT
- https://github.com/dotnet/roslyn/blob/main/License.txt
- https://github.com/dotnet/core/blob/main/license-information.md
- https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/

## TraceJVM 0.3 lesson

The inspected reference is the 0.3.0 release-preparation commit, not a tag:

`06b4fcd89ea9facaa0564f43b44ff7151ebf4d9d`

TraceJVM's compiler accepts compilation and rejects run/execute. Its runner
accepts run and does not load the compiler. `TraceJVMRuntimeHost` owns one warm
serialized compiler and disposable process runner leases without merging
their capabilities.

Its published experiment reports:

- compiler ready: 210.4 MiB incremental RSS;
- compiler after compilation: 294.5 MiB;
- peak with runner activity: 355.2 MiB;
- live allocation after runner 1: 219.02 MiB;
- live allocation after runner 100: 219.13 MiB;
- Wasm heap high-water reached early and then stayed stable;
- warm-compiler policy saves roughly 53–63%, 2.1–2.7x across engines.

The C# measurements reproduce the same causal shape. The difference is that
the C# prototype has not yet separated its deployable runner closure, so
download and peak memory remain artificially high.

## Ranked next work

1. Extract the generated trusted Judge runtime into a versioned, separately
   built assembly referenced only by Judge compilation and execution.
2. Build two owned AppBundles from the same pinned .NET/Roslyn release:
   `csharp-compiler` and `csharp-runner`.
3. Move Roslyn parse/emit, immutable syntax templates, references, and the
   bounded content-addressed cache behind a serialized compiler-only worker
   protocol. Prewarm this authority per Mux or client slot.
4. Move PE load/invoke, runtime trace sink, Project/terminal/TraceKernel
   bridges, and only their BCL closure into the runner. Prove the runner starts
   without loading/fetching `Microsoft.CodeAnalysis*`.
5. Prewarm disposable runner leases only with fixed trusted assemblies, bind
   each lease to one learner submission, and destroy it through TraceKernel
   retirement. Keep `fresh-case-state`.
6. Add immutable caching/service-worker/CDN tests so replacement runners do
   not transfer the same runtime bytes repeatedly.
7. Gate the split against the 200-entry corpus plus Project, terminal,
   filesystem, HTTP/server, cancellation, and retirement tests in Chromium,
   Firefox, and WebKit.
8. Use eager plain+trace preparation in Chromium/WebKit and lazy requested-mode
   preparation in Firefox until its retained authority memory is reduced.
9. Decide diagnostic localization policy, then gate the 6.14 MiB satellite
   pruning prototype.

## Commands

Representative commands (all run from the Harness worktree):

```sh
pnpm install --offline --frozen-lockfile
pnpm build

dotnet build experiments/csharp-performance-spike/native-clean/NativeClean.csproj -c Release
/usr/bin/time -l dotnet run --project experiments/csharp-performance-spike/native-clean/NativeClean.csproj -c Release --no-build

dotnet publish experiments/csharp-performance-spike/clean-browser/CleanBrowser.csproj -c Release
pnpm exec tsx --tsconfig tsconfig.base.json experiments/csharp-performance-spike/clean-browser-benchmark.ts --engine=chromium --iterations=3 ...
pnpm exec tsx --tsconfig tsconfig.base.json experiments/csharp-performance-spike/clean-browser-benchmark.ts --engine=firefox --iterations=3 ...
pnpm exec tsx --tsconfig tsconfig.base.json experiments/csharp-performance-spike/clean-browser-benchmark.ts --engine=webkit --iterations=3 ...

pnpm bench:browser-project-runtimes --languages=csharp --iterations=3 --engine=chromium ...
pnpm bench:browser-project-runtimes --languages=csharp --iterations=1 --engine=firefox ...
pnpm bench:browser-project-runtimes --languages=csharp --iterations=1 --engine=webkit ...

pnpm exec tsx --tsconfig tsconfig.base.json experiments/csharp-performance-spike/judge-spike-benchmark.ts --engine=chromium ...
pnpm exec tsx --tsconfig tsconfig.base.json experiments/csharp-performance-spike/judge-spike-benchmark.ts --engine=firefox ...
pnpm exec tsx --tsconfig tsconfig.base.json experiments/csharp-performance-spike/judge-spike-benchmark.ts --engine=webkit ...

pnpm exec tsx --tsconfig tsconfig.base.json experiments/csharp-performance-spike/judge-spike-benchmark.ts --mode=corpus --limit=200 --engine=chromium ...
pnpm exec tsx --tsconfig tsconfig.base.json experiments/csharp-performance-spike/judge-spike-benchmark.ts --mode=production-corpus --limit=200 --engine=chromium ...

node experiments/csharp-performance-spike/compare-production-corpus.mjs \
  .../corpus/production-chromium-full.json \
  .../corpus/chromium-full.json \
  .../corpus/production-vs-prototype-summary.json

node experiments/csharp-performance-spike/artifact-inventory.mjs \
  .../artifacts/inventory.json \
  workers/vendor/csharp \
  experiments/csharp-performance-spike/clean-browser/bin/Release/net10.0/browser-wasm/AppBundle \
  .../artifacts/csharp-no-satellites-v2 \
  .../aot-current/AppBundle

dotnet publish runtimes/csharp/TraceCode.CSharpHost/TraceCode.CSharpHost.csproj \
  -c Release -p:RunAOTCompilation=true -p:WasmBuildNative=true \
  -p:PublishTrimmed=true ...

# Sub-second trusted-runtime prototype
node experiments/csharp-performance-spike/generate-precompiled-judge-runtime.mjs
dotnet build runtimes/csharp/TraceCode.CSharpHost/TraceCode.CSharpHost.csproj \
  -c Release -p:TraceCodePrecompiledJudgeRuntime=true

pnpm exec tsx --tsconfig tsconfig.base.json \
  experiments/csharp-performance-spike/judge-spike-benchmark.ts \
  --mode=compiler --engine=chromium --asset-source=.../AppBundle \
  --report=.../chromium.json

pnpm exec tsx --tsconfig tsconfig.base.json \
  experiments/csharp-performance-spike/judge-spike-benchmark.ts \
  --mode=fast-judge --engine=chromium --asset-source=.../AppBundle \
  --report=.../fast-judge-chromium.json

pnpm exec tsx --tsconfig tsconfig.base.json \
  experiments/csharp-performance-spike/judge-spike-benchmark.ts \
  --mode=corpus --limit=200 --engine=chromium \
  --asset-source=.../AppBundle \
  --report=.../corpus-chromium-200.json

pnpm exec tsx scripts/benchmark-browser-project-runtimes.ts \
  --languages=csharp --iterations=1 --engine=chromium \
  --csharp-asset-source=.../AppBundle \
  --report=.../project-chromium.json

pnpm test:tracekernel:csharp-browser
pnpm test:csharp-worker-browser
pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-project-fs-parity.ts
pnpm typecheck
```

## Raw evidence

Root:

`/Volumes/External Storage/tracecode-csharp-performance-spike-2026-08-03`

Important reports:

- `evidence-sha256.txt` (report and principal raw-evidence hashes)
- `native/run.json`
- `native/run.time.txt`
- `clean-browser/chromium.json`
- `clean-browser/firefox.json`
- `clean-browser/webkit.json`
- `project-chromium-cached-rss.json`
- `project/project-firefox-rss.json`
- `project/project-webkit-rss.json`
- `judge/chromium-canonical.json`
- `judge/firefox.json`
- `judge/webkit.json`
- `judge/chromium-no-satellites.json`
- `corpus/chromium-full.json`
- `corpus/production-chromium-full.json`
- `corpus/production-vs-prototype-summary.json`
- `memory/chromium-production-renderer-vmmap.txt`
- `artifacts/inventory.json`
- `artifacts/csharp-no-satellites-v2.build-report.json`
- `aot-current/publish-trimmed.time.txt`
- `aot-current/publish-trimmed.binlog`
- `aot-current/AppBundle`
- `subsecond/phase-profile/{chromium,firefox,webkit}-distribution.json`
- `subsecond/trusted-template/chromium.json`
- `subsecond/debug-emit/chromium.json`
- `subsecond/precompiled-runtime-hybrid/artifact-inventory.json`
- `subsecond/precompiled-runtime-hybrid/corpus-chromium-200.json`
- `subsecond/precompiled-runtime-hybrid/fast-judge-chromium.json`
- `subsecond/precompiled-runtime-hybrid/fast-judge-webkit.json`
- `subsecond/precompiled-runtime-hybrid/fast-judge-firefox-trace-warm.json`
- `subsecond/precompiled-runtime-hybrid/project-chromium.json`
- `subsecond/aot-roslyn/*.binlog`
- `subsecond/aot-roslyn/chromium-diagnostics.json`

The failed first satellite-pruning copy remains at
`artifacts/csharp-no-satellites-v1`; it is an experiment-owned partial copy
that failed before manifest editing. It was not broadly deleted from the
external drive.

## Verification and known limitations

Completed:

- clean exact output in Chromium, Firefox, WebKit;
- production ten-case plain and trace receipts in all three engines;
- exact production/prototype output and ordered trace digests in all three;
- Project filesystem/policy/HTTP/process/cancellation phases in Chromium,
  Firefox, and WebKit;
- 200-entry direct/prototype corpus run;
- public Judge/TraceKernel 200-entry corpus run with 200/200 status, output,
  limit, trace count, and ordered trace digest parity against the split;
- process-tree RSS sampling and live Chromium `vmmap`;
- Wasm linear heap sampling across the production corpus;
- raw/gzip/Brotli quality-11 bundle inventory and SHA-256 hashes;
- Roslyn-satellite Chromium semantic smoke;
- full-host Mono/Wasm AOT build and failed runtime smoke;
- selective Roslyn/CoreLib AOT link and mixed-mode runtime failure capture;
- detailed Roslyn phase and repeated tier-warm sweeps in all three engines;
- precompiled trusted Judge runtime sweeps in all three engines;
- prewarmed one-learner disposable Judge leases in all three engines;
- hybrid 200-entry corpus with 200/200 status and 199/200 strict row parity;
- hybrid public Project filesystem/policy/HTTP/process/cancellation phases in
  Chromium;
- hybrid raw/gzip/Brotli inventory and principal artifact hashes;
- TraceKernel C# browser conformance;
- C# worker/browser lifecycle suite;
- C# Project filesystem parity;
- repository typecheck;
- local and upstream license verification.

Not completed and intentionally not overstated:

- the experiment split is not yet wired through the public Judge adapter, so
  its lower-level full Roslyn diagnostic arrays differ from Judge's
  primary-diagnostic projection on 63 compile failures;
- localized diagnostic behavior for the satellite-pruned tree has not been
  validated in all three engines;
- a compiler-free owned runner bundle has not yet been built; the same-bundle
  split is a topology proof, not a production artifact;
- a production-shaped compiler-only AOT bundle has not been completed;
  full-host AOT and a selective mixed AOT/interpreter build were measured and
  rejected;
- the precompiled trusted Judge runtime is still linked into the experimental
  combined host rather than a Judge-only assembly.

Limitations:

- macOS WebKit descendant RSS is an undercount;
- process RSS is noisy and browser allocators retain pages;
- Project report `peakByPhase.sampleCount` values from this campaign reset when
  a later peak was observed; baseline/peak/settled RSS and phase peak RSS are
  correct, and the experiment instrumentation is fixed for future runs;
- `vmmap` could not introspect Chromium PartitionAlloc;
- browser runtime 10.0.10 and native runtime 10.0.7 differ by three patch
  revisions;
- local HTTP eliminates internet latency but accurately exposes request count,
  body bytes, runtime initialization, decode/compile, and host work;
- the current prototype uses the full compiler bundle as runner and therefore
  is not the final memory/download architecture.

## Production-shaped port addendum

This addendum supersedes the prototype-only limitations above. The split is
now wired through the public C# runtime provider in this worktree, but remains
uncommitted as requested.

### Implemented architecture

- The normal C# worker remains available for Project, terminal, filesystem,
  process, TCP/server, and direct program execution.
- Judge preparation uses one persistent `compiler`-role worker. Roslyn,
  immutable reference assemblies, trusted compilation templates, and the
  bounded content-addressed artifact cache live there.
- Judge execution uses a `runner`-role worker. It has no Roslyn assemblies and
  no compiler VFS. Each learner assembly is loaded into a fresh collectible
  `AssemblyLoadContext`; the outer runner lease is terminated after the eager
  case batch.
- One runner containing only trusted toolchain/runtime state is prewarmed.
  A replacement is created only after the prior learner-bearing lease has
  terminated. No learner static state, filesystem, TraceKernel process state,
  trace state, or authority crosses the lease boundary.
- The PE handoff includes both the source-derived artifact key and SHA-256 of
  the exact assembly bytes. The runner recomputes SHA-256 before loading and
  fails closed on malformed, oversized, mismatched, or non-PE payloads.
- Prepared execution and trace normalization live in a Roslyn-free type graph.
  Method-level separation was insufficient because Mono resolved a
  compiler-generated `CompilerHost+<>c` closure containing Roslyn field types.
- Project filesystem behavior is unchanged: C# continues to use TraceKernel
  TKFS through the Mux/syscall boundary. Judge has no filesystem hot path.

### Final measured frontier

Warm ten-case Judge, including learner compilation and all ten isolated runs:

| Engine | Plain | Trace | Both modes |
|---|---:|---:|---:|
| Chromium | 250 ms | 262 ms | 512 ms |
| Firefox | 834 ms | 875 ms | 1,709 ms |
| WebKit | 211 ms | 234 ms | 444 ms |

The compiler portions were 188/183 ms in Chromium, 605/597 ms in Firefox, and
157/164 ms in WebKit. The corresponding ten-case runner portions were
63/79 ms, 229/277 ms, and 54/70 ms. All six mode/engine runs succeeded with
identical outputs and ordered trace digests.

The final public-Judge Chromium corpus run covered 200 C# entries and compared
against the previous production report entry-for-entry:

- total wall time: 146,948 ms versus 1,545,666 ms (`10.5x`);
- median full submission: 694 ms;
- p95: 1,322 ms;
- source identity mismatches: 0;
- preparation/completion status mismatches: 0;
- output mismatches: 0;
- diagnostics/limit mismatches: 0;
- trace event-count mismatches: 0;
- ordered trace SHA-256 mismatches: 0.

The final Chromium corpus process-tree peak was 979,156,992 bytes and settled
to 183,173,120 bytes after page/context teardown. Warm fast-Judge peaks were
559,005,696 bytes in Chromium and 1,472,512,000 bytes in Firefox. Firefox
settled at 984,563,712 bytes in this Playwright process-tree sample and should
therefore use more aggressive idle retirement than Chromium/WebKit.

Artifact frontier (per-file compression summed across the bundle):

| Bundle | Raw | gzip-9 | Brotli-5 |
|---|---:|---:|---:|
| General C# | 50,234,009 B | 17,514,039 B | 15,908,177 B |
| Compiler authority | 50,234,009 B | 17,514,039 B | 15,908,177 B |
| Disposable runner | 23,631,966 B | 8,697,338 B | 7,748,184 B |

The runner boot manifest SHA-256 is
`68b8047ca34c5a0586f209ba268ffa4d69f29c1ea3e87dafc28ec42d6c5f3713`.
The runner host assembly asset SHA-256 is
`ad61d546616c2ca3440d4529804034ec8fd92c4711a2bece836966e4c7577972`.
A file scan found no `Microsoft.CodeAnalysis` or `supportFiles` compiler
assets in the runner.

### Final verification

- `dotnet build .../TraceCode.CSharpHost.csproj -c Release --no-restore`
- root, runtime-browser, and runtime-csharp TypeScript typechecks
- public C# package surface and generated runtime-info synchronization
- public ten-case Judge code/trace batches with bounded workers
- full TraceKernel C# browser conformance, including TKFS, descriptors,
  processes/groups/signals, terminal control, links/watches, TCP, and
  same-language worker isolation
- Chromium 200-entry strict production corpus
- Chromium, Firefox, and WebKit warm fast-Judge sweeps

Final raw reports:

- `production-port/production-corpus-chromium-200-strict-final.json`
- `production-port/fast-judge-chromium.json`
- `production-port/fast-judge-firefox.json`
- `production-port/fast-judge-webkit.json`

One benchmark-specific caveat remains: its local static server intentionally
does not model an immutable CDN cache, so repeatedly created runners refetched
about 2.97 GB across the 200-entry campaign. Production must serve the
content-addressed role bundles with immutable HTTP caching; the shipped
download frontier is the compressed bundle table above, not that cumulative
no-cache benchmark transfer.

## Dedicated-runner production hardening

This final section supersedes the remaining same-bundle caveat in the earlier
addenda. The disposable runner is now an independent .NET project and publish
target, not a copy of the Host bundle with files removed after publication.

### Build and artifact boundary

- `TraceCode.CSharpJudgeRuntime` owns the Roslyn-free Judge runtime helpers,
  trace sink, and trace backfill.
- `TraceCode.CSharpJudgeRunner` references only
  `TraceCode.CSharpJudgeRuntime`. It has no project or package reference to
  `TraceCode.CSharpHost` or `Microsoft.CodeAnalysis`.
- `TraceCode.CSharpHost` remains the general/compiler build and references the
  shared Judge runtime.
- `scripts/update-csharp-wasm-runtime.sh` publishes Host and runner separately,
  then copies Host to the general/compiler trees and the independent runner to
  the runner tree.
- `scripts/validate-csharp-runtime-role-assets.ts` fails closed on the wrong
  main assembly, missing role assembly, Roslyn/Host leakage into the runner,
  any runner compiler VFS entry, or size regression.
- The post-publish runner surgery experiment was deleted. The safety property
  now comes from the project dependency graph.

The exact rebuild used SDK `10.0.110`, runtime `10.0.10`, and Roslyn
`5.3.0`. The SDK and Wasm workload are retained at:

`/Volumes/External Storage/tracecode-csharp-performance-spike-2026-08-03/toolchains/dotnet-sdk-10.0.110`

The SDK executable SHA-256 is
`ed8eb05ce0598b40df34f464d16063b30896c7e28dc1ac9e94554a8aff9676ed`.
The upstream Emscripten `clang` wrapper required quoting its computed binary
path because the external volume name contains a space; that one-line
toolchain-local patch is retained with the installed toolchain.

Final role inventory (per-file Brotli quality 6):

| Role | Files | Raw bytes | Brotli bytes |
|---|---:|---:|---:|
| General | 241 | 50,213,357 | 15,805,158 |
| Compiler | 241 | 50,213,357 | 15,805,158 |
| Runner | 165 | 23,054,851 | 7,588,956 |

The runner is 54.1% smaller raw than the compiler bundle. Its initial Wasm heap
is 32 MiB; the compiler/general build starts at 37.375 MiB. Principal final
hashes:

- general `dotnet.native.wasm`:
  `c0cad774db5e12ee7e0ef417d9e5d9eaa5b2e2e6ccbede90cdbf0e8596da99d9`
- runner `dotnet.native.wasm`:
  `f437db85c58ecd3b25be02ad9ec7c0f66f1525a9ed98395920f28a12f8a402df`
- runner entry assembly:
  `ffceb6e92993255bac0329a88dac13095af7cfa270fbd48991cc41dd9e753017`
- shared Judge runtime in runner:
  `a3a53acb62ef7a3482352eba4e4801d6fc98cf1b2ebf0bd43decce907d24dbbc`

### Final cross-browser speed and memory

Warm trusted preinitialization followed by one visible plain and one visible
trace submission, each with compilation plus ten isolated cases:

| Engine | Plain compile | Plain total | Trace compile | Trace total |
|---|---:|---:|---:|---:|
| Chromium | 194 ms | 258 ms | 193 ms | 279 ms |
| Firefox | 667 ms | 911 ms | 619 ms | 914 ms |
| WebKit | 170 ms | 227 ms | 164 ms | 239 ms |

All six runs succeeded. This preserves the sub-one-second barrier even in
Firefox. The general worker lifecycle gate separately measured 704 ms cold
compile, 24 ms edited-source compile, and 0 ms exact-repeat compile; its cold
end-to-end run was 1,165 ms because runtime startup remains outside compile.

Process-tree RSS from the same role-build sweep:

| Engine | Baseline | Peak | Settled after page/context close |
|---|---:|---:|---:|
| Chromium | 232.0 MiB | 719.8 MiB | 185.1 MiB |
| Firefox | 274.1 MiB | 1,267.2 MiB | 820.6 MiB |
| WebKit | 89.1 MiB | 109.6 MiB | 104.1 MiB |

WebKit descendant RSS remains an undercount. Firefox's retention result is
large and repeatable enough to justify policy: compiler and unused prewarmed
runner workers retire after 20 seconds of inactivity by default on Firefox.
Other engines retain the existing 90-second worker default. Applications can
override compiler and runner idle timeouts separately. Learner-bearing runners
are terminated immediately after every lease on every engine.

The local no-cache server fetched 65.4-66.2 MB over 362-371 requests while
prewarming both role trees. This is not the repeat-view download contract.
Deployment must use content-addressed or release-versioned role URLs with
`Cache-Control: public, max-age=31536000, immutable`; mutable URLs must never
receive that header. The runtime manifest contract already supports immutable
delivery attestations, and the C# package README now makes this a deployment
requirement.

### Final gates and evidence

Passing commands:

```text
pnpm test:csharp-role-assets
pnpm test:csharp-runtime
pnpm test:csharp-worker-browser
pnpm test:csharp-public-surface
pnpm test:tracekernel:csharp-browser
TRACECODE_BROWSER_BATCH_LANGUAGES=csharp pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-algorithm-batch.ts
dotnet build runtimes/csharp/TraceCode.CSharpHost/TraceCode.CSharpHost.csproj -c Release --no-restore
dotnet build runtimes/csharp/TraceCode.CSharpJudgeRunner/TraceCode.CSharpJudgeRunner.csproj -c Release --no-restore
```

The prepared-boundary browser gate compiles in the trusted authority, executes
the exact PE in a disposable runner, then changes only the SHA-256 field. The
valid artifact returned `42`; the tampered artifact failed closed with
`compileCacheHit=false` and `artifactCacheHit=false`.

The full C# browser worker suite passed general program, terminal/project,
filesystem, HTTP, cancellation, tracing, failure, cache, disposal, and
replacement-worker behavior. TraceKernel browser conformance passed TKFS,
descriptor I/O and inheritance, processes/groups/signals, terminal job
control, topology mutation, waits, pipes/polling, TCP and half-close, links,
watches, and same-language worker isolation.

Final cross-browser raw reports:

- `production-port/final-role-build-fast-judge-chromium.json`
- `production-port/final-role-build-fast-judge-firefox.json`
- `production-port/final-role-build-fast-judge-webkit.json`

The strict 200-entry public-Judge corpus evidence remains:

- `production-port/production-corpus-chromium-200-strict-final.json`
- `production-port/final-role-build-production-corpus-chromium-200.json`
- `production-port/final-role-build-production-corpus-chromium-200-comparison.json`
- final wall time 136,731 ms, median 728 ms, p95 1,234 ms;
- process-tree peak 1,007,468,544 bytes and settled RSS 180,191,232 bytes;
- 200/200 exact source identity, verdict, preparation/completion status,
  output, diagnostics, stdout/stderr, timeout, trace-count, and ordered
  trace-digest matches; 0 mismatches in every field.

Two orphaned Chromium benchmark process groups from earlier spike attempts were
found after approximately seven hours and terminated by their exact process
group IDs. No unrelated processes or external-drive data were removed.

## Linked disposable-runner frontier

An additional experiment tested IL linking only on the compiler-free Judge
runner. The general Project/terminal/filesystem/network/server runtime and the
trusted Roslyn compiler authority remained unlinked and unchanged.

### Rejected unrestricted linking

The unrestricted partial-link build was only 4.34 MiB raw / 1.49 MiB Brotli,
but it was semantically invalid for dynamically loaded learner assemblies.
After preserving reflection-based `JsonSerializer` support, a learner call to
`JsonDocument.Parse(string, JsonDocumentOptions)` still failed at runtime with
`Method not found`. The linker cannot statically see BCL calls made from PE
assemblies compiled after the runner was published. This profile is rejected;
its size is not part of the viable frontier.

Raw failure evidence:

- `download-frontier/linked-reflection-runner-fast-judge-chromium.json`

### Reference-rooted linking

The viable profile roots every assembly in the compiler's `Minimal` Judge
reference pack, plus the runner and shared Judge runtime, while allowing
assemblies outside that declared language surface to be removed as whole
units. The profile is conditioned on
`TraceCodeRunnerTrimProfile=JudgeReferences` and remains experiment-only.

Build command:

```text
/Volumes/External Storage/tracecode-csharp-performance-spike-2026-08-03/toolchains/dotnet-sdk-10.0.110/dotnet publish \
  runtimes/csharp/TraceCode.CSharpJudgeRunner/TraceCode.CSharpJudgeRunner.csproj \
  -c ReleaseTrimmedJudgeReferences \
  -p:PublishTrimmed=true \
  -p:TrimMode=partial \
  -p:JsonSerializerIsReflectionEnabledByDefault=true \
  -p:TraceCodeRunnerTrimProfile=JudgeReferences
```

Candidate inventory:

| Profile | Files | Raw | gzip-9 | Brotli-6 |
|---|---:|---:|---:|---:|
| Current independent runner | 165 | 23,054,851 B | — | 7,588,956 B |
| Reference-rooted linked runner | 97 | 13,125,020 B | 4,697,073 B | 4,315,545 B |

This removes 43.1% of both raw and Brotli runner bytes. Candidate hashes:

- `dotnet.boot.js`:
  `b9eeafb342779d2e303f8da15abab4f9e9db994ec82607ef4090dce31fcc8c40`
- `TraceCode.CSharpJudgeRunner.wasm`:
  `d7e1531009a27cc2125d77ff555790733942a4a59280d9577068b8eda5bdb6c3`

### Speed, memory, and exactness

Warm ten-case Judge results:

| Engine | Prewarm | Plain | Trace | Peak RSS | Settled RSS |
|---|---:|---:|---:|---:|---:|
| Chromium | 3,864 ms | 242 ms | 263 ms | 707.3 MiB | 185.0 MiB |
| Firefox | 13,134 ms | 886 ms | 967 ms | 1,121.6 MiB | 747.7 MiB |
| WebKit | 3,823 ms | 213 ms | 227 ms | 110.0 MiB | 110.0 MiB |

All six visible runs succeeded. Firefox remained below one second in both
modes and dropped about 145.6 MiB of peak process-tree RSS versus the unlinked
role build. Chromium prewarm fetched 56,275,135 bytes in 303 requests, versus
66,206,166 bytes in 371 requests for the unlinked role build.

The complete 200-entry Chromium public-Judge corpus was then rerun:

- wall time: 124,251 ms versus 136,731 ms;
- median: 599 ms versus 728 ms;
- p95: 1,254 ms versus 1,234 ms;
- process-tree peak: 985,300,992 B versus 1,007,468,544 B;
- 200/200 exact source identity, preparation/completion status, verdict,
  output, diagnostics, stdout/stderr, timeout state, trace event count, and
  ordered trace SHA-256;
- zero mismatches in every compared field.

The no-cache corpus server transferred 1,634,827,211 bytes in 11,792 requests,
versus 2,870,910,181 bytes in 20,229 requests for the unlinked runner. These
are repeated local fetch totals, not shipped artifact sizes.

The prepared-boundary browser gate was expanded to cover a dynamically loaded
learner POCO, property hydration, `List<T>`, `Dictionary<TKey,TValue>`, LINQ,
regular expressions, tuple metadata, `JsonDocument.Parse`, and tracing. The
unlinked control and linked candidate both returned
`Ada:6:7:True:True`, emitted 29 trace events, and rejected a modified artifact
SHA-256. This directly covers the dynamic method-retention failure observed in
the rejected unrestricted profile.

Raw evidence:

- `download-frontier/linked-judge-references-runner-fast-judge-chromium.json`
- `download-frontier/linked-judge-references-runner-fast-judge-firefox.json`
- `download-frontier/linked-judge-references-runner-fast-judge-webkit.json`
- `download-frontier/linked-judge-references-production-corpus-chromium-200.json`
- `download-frontier/linked-judge-references-production-corpus-chromium-200-comparison.json`

### Cold-prewarm attribution

An instrumented Chromium repeat attributed the 3,896 ms trusted prewarm:

| Stage | Wall time | First-stage fetched bytes / requests |
|---|---:|---:|
| Compiler runtime + first trusted code emit | 2,464 ms | 43,481,203 B / 211 |
| Runner runtime + first trusted code batch | 556 ms | 12,793,932 B / 91 |
| First trusted trace emit | 218 ms | cached assets |
| First trusted trace batch | 114 ms | cached assets |
| Three additional benchmark-only compiler emits | 176 + 172 + 160 ms | cached assets |

The final three emits are benchmark stabilization, not a new runtime
initialization requirement, and must not be copied into production prewarm.
The compiler's first trusted emit is the important hidden work: a runtime-only
warmup leaves Roslyn's first emit at roughly 1.7–2.6 seconds even after assets
are loaded, whereas subsequent distinct-source emits settle near 160–200 ms.
A production prewarm should therefore prime exactly one fixed trusted
compilation in the serialized compiler authority and load one clean runner in
parallel. The compiler may retain only its trusted template/toolchain state
and the content-addressed trusted artifact; no learner authority or mutable
learner state crosses this boundary.

At visible submission time, the measured practical floor remains approximately
230–280 ms for compile plus ten isolated Judge cases in Chromium/WebKit and
approximately 0.9–1.0 seconds in Firefox. TraceKernel/Mux does not dominate
this Judge path: runner execution is tens of milliseconds in Chromium/WebKit,
while Roslyn emit is the largest visible component. The next production
prototype should combine the reference-rooted runner with exactly-one trusted
compiler priming, concurrent compiler/runner asset prewarm, immutable CDN
caching, and existing immediate learner-bearing runner retirement.

Prewarm attribution report:

- `download-frontier/linked-judge-references-runner-prewarm-breakdown-chromium.json`

## Promoted linked runner and trusted traced prime

The reference-rooted runner profile is now the default production publish
shape. `update-csharp-wasm-runtime.sh` passes the profile explicitly, the
runner project defaults to it, and the release validator requires every
Minimal Judge reference assembly while enforcing 16 MiB raw / 6 MiB Brotli
ceilings. The general Project/terminal/filesystem/network/server runtime and
the compiler authority remain unlinked.

The role-split release script now rejects
`TRACECODE_CSHARP_REFERENCE_PACK=Compatibility`. A compiler may not expose a
broader BCL than its linked runner preserves. Compatibility remains a distinct
future runner profile/build, not a flag that can silently create a
compile-success/runtime-failure surface.

Final shipped role inventory:

| Role | Files | Raw bytes | Brotli-6 bytes |
|---|---:|---:|---:|
| General | 241 | 50,213,357 | 15,805,158 |
| Compiler | 241 | 50,213,357 | 15,805,158 |
| Linked runner | 95 | 13,122,947 | 4,313,090 |

Final runner hashes:

- boot manifest:
  `bbe4ffeb54c3b57813e6bcbbfe949ed40a19772d34f3b7069370fbb69e656d41`
- runner entry assembly:
  `ffceb6e92993255bac0329a88dac13095af7cfa270fbd48991cc41dd9e753017`
- shared Judge runtime:
  `a3a53acb62ef7a3482352eba4e4801d6fc98cf1b2ebf0bd43decce907d24dbbc`
- runner native Wasm:
  `5fd74c54721e62e0cb9ad3159f400df1a76d8d80be3aa47d51756f3a26bc1c97`
- C# worker:
  `f916afb7e97bbc2671fc76f4a7d20a2afe73a4dbf02de78cca94cd686ac84703`

### Production prewarm

The compiler and clean standby runner start concurrently. The serialized
compiler authority performs exactly one fixed trusted **traced** compilation.
After both loads finish, the provider sends that SHA-bound immutable artifact
to the still-unleased standby runner with fixed inputs. This one traced
artifact warms the superset of normal compilation/execution and tracing:
Roslyn emit, trace rewriting, trace sink, assembly load, reflection, and
collectible-context teardown.

The provider does not append background work after learner execution:

- if the standby runner was leased before the two warmups completed, the
  trusted runner prime is skipped;
- once the trusted execution is queued, learner work serializes behind it;
- every learner-bearing runner is still terminated after its eager batch;
- the compiler retains only trusted toolchain/template state and immutable
  content-addressed artifacts;
- the fixed request has no learner source/input, filesystem, process, network,
  TraceKernel, or Mux authority.

The compiler warmup artifact is never accepted on trust alone: the disposable
runner performs the same source-derived key and PE SHA-256 validation as for a
learner artifact and loads it in a collectible context.

### Final production-shaped speed

One hidden traced prime followed by a visible plain and traced ten-case Judge
submission:

| Engine | Hidden prewarm | Plain compile | Plain total | Trace compile | Trace total |
|---|---:|---:|---:|---:|---:|
| Chromium | 3,232 ms | 202 ms | 268 ms | 195 ms | 256 ms |
| Firefox sweep 1 | 9,065 ms | 725 ms | 989 ms | 670 ms | 919 ms |
| Firefox sweep 2 | 10,873 ms | 725 ms | 991 ms | 651 ms | 921 ms |
| WebKit | 3,756 ms | 194 ms | 268 ms | 178 ms | 241 ms |

The requested sub-one-second compile barrier is therefore met in every engine
and mode, including both noisy Firefox repeats. Ten-case end-to-end Judge is
also below one second in those repeats, though Firefox plain has only about
9–11 ms of margin and should be treated as approximately one second rather
than a hard latency SLA.

Process-tree memory from the same sweeps:

| Engine | Peak RSS | Settled RSS |
|---|---:|---:|
| Chromium | 740,179,968 B | 194,805,760 B |
| Firefox | 1,285,062,656–1,356,660,736 B | 852,754,432–911,278,080 B |
| WebKit | 114,786,304 B | 106,938,368 B |

Firefox retains the existing 20-second compiler/unused-runner idle retirement
policy. Learner-bearing runners still retire immediately in all engines.

Raw reports:

- `production-port/promoted-linked-trace-prime-fast-judge-chromium.json`
- `production-port/promoted-linked-trace-prime-fast-judge-firefox.json`
- `production-port/promoted-linked-trace-prime-fast-judge-firefox-repeat.json`
- `production-port/promoted-linked-trace-prime-fast-judge-webkit.json`

### Final strict corpus

The promoted public provider and assets passed the complete 200-entry traced
Chromium corpus against the previous final-role baseline:

- 200/200 exact and zero mismatches;
- exact source path and SHA-256;
- exact verdict and preparation/completion status;
- exact output, diagnostics, stdout/stderr, and timeout state;
- exact trace event count and ordered trace SHA-256;
- median: 651 ms versus 732 ms;
- p95: 1,212 ms versus 1,237 ms;
- peak RSS: 942,702,592 B versus 1,007,468,544 B;
- settled RSS: 127,205,376 B versus 180,191,232 B;
- no-cache repeated transfer: 1,665,704,903 B / 11,720 requests versus
  2,876,769,754 B / 20,232 requests.

The single aggregate wall sample was 141,692 ms versus 133,277 ms. Its first
submission paid 5,220 ms versus 3,492 ms because this benchmark intentionally
submits immediately instead of allowing background prewarm to finish; the
remaining difference is campaign noise, while median and p95 both improved.
The production UX should start prewarm at host/session creation and avoid
advertising readiness until the selected language is warm when a hard first
submission target matters.

Corpus evidence:

- `production-port/promoted-linked-trace-prime-production-corpus-chromium-200.json`
- `production-port/promoted-linked-trace-prime-production-corpus-chromium-200-comparison.json`

Final release gates passed:

```text
pnpm update:csharp-runtime  # pinned SDK 10.0.110/runtime 10.0.10
pnpm test:csharp-role-assets
pnpm test:csharp-runtime
pnpm test:csharp-public-surface
pnpm test:csharp-worker-browser
pnpm test:tracekernel:csharp-browser
TRACECODE_BROWSER_BATCH_LANGUAGES=csharp \
  pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-algorithm-batch.ts
pnpm typecheck:root
pnpm typecheck:tests
pnpm exec tsc -p packages/runtime-browser/tsconfig.json --noEmit
pnpm exec tsc -p packages/runtime-csharp/tsconfig.json --noEmit
pnpm test:asset-sync
pnpm test:runtime-info-sync
git diff --check
```

The public browser-batch gate now observes worker commands and fails unless
the real provider completes the fixed trusted traced standby-runner prime
before the tested lease. The prepared-boundary gate independently validates
the trusted artifact output, learner POCO/collection/JSON/regex hydration,
29-event tracing, and modified-SHA rejection.
