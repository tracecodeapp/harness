# Public browser harness benchmark

`scripts/benchmark-browser-runtimes.ts` measures the browser behavior consumers
get from the public Classic API:

```text
createBrowserHarness() -> getClient(language) -> init()/execute() -> dispose()
```

It intentionally does not call worker protocols directly. The measured browser
runtimes are Python, JavaScript, TypeScript, Java, C#, and C++. Node is not a
runtime in this benchmark. SQL remains separate because it is not a language
client exposed by `createBrowserHarness()`; folding its separate API into these
numbers would make the comparison look uniform when it is not.

## Runs

The full matrix is the default:

```bash
pnpm bench:browser-runtimes
```

A short end-to-end check is available for development:

```bash
pnpm bench:browser-runtimes --smoke
```

For command-ready latency, warm the selected runtime before the first measured
execute and allow a small interaction gap between dependent phases:

```bash
pnpm bench:browser-runtimes --cache-assets --prewarm-runtime --phase-delay-ms=25
```

`--prewarm-runtime` measures `harness.warmLanguage(language)` separately in the
init record. `--phase-delay-ms` does not count toward command wall time; it lets
clean one-shot worker replacements become ready during the same kind of idle
gap an interactive editor normally has between commands. Keep it at `0` when
measuring worst-case back-to-back burst latency. Reports with different values
for either option are different workloads and must not be presented as a direct
A/B comparison.

`--smoke` selects JavaScript, the `add` workload, execute mode, one iteration,
and two inputs unless those dimensions are explicitly overridden. For example,
this remains a small TypeScript trace check:

```bash
pnpm bench:browser-runtimes --smoke --languages=typescript --modes=execute,trace
```

Consumer CDN/self-hosted asset layouts can be exercised without changing the
harness or benchmark by passing the same generic runtime manifest map used by
`createBrowserHarness()`:

```bash
pnpm bench:browser-runtimes --runtime-manifests=./runtime-assets.json
```

The file may contain the runtime map directly or under a `runtimeManifests`
property. `TRACECODE_BENCH_RUNTIME_MANIFESTS` is the equivalent CI environment
variable. Java needs a complete consumer-provided runtime manifest, including
its CheerpJ loader and four runtime JARs; CheerpJ is deliberately not
redistributed by the harness. A Java run without that asset set records an
initialization failure rather than silently substituting a product-owned CDN.
For CheerpJ-hosted JARs, use each descriptor's url for the browser delivery
location and runtimePath for its /app/... classpath.

Every language/workload/iteration gets a fresh Playwright `BrowserContext` and
a fresh public harness. Run order is deterministically shuffled by `--seed`, so
repeat reports are comparable without always giving the same runtime the first
slot.

The full benchmark defaults to five independent samples per
language/workload. `--smoke` intentionally uses one sample as a functional
check; its p50/p95 fields are not performance evidence. Keep at least five
samples (and preferably more on noisy CI hosts) when comparing releases, and
use the report's raw phase records alongside aggregates.

Within one fresh client, execute mode runs these dependent phases in order:

1. `cold-first-execute`: first source and input after `RuntimeClient.init()`.
2. `warm-exact-repeat`: byte-identical source and input.
3. `warm-edited-source`: equivalent source with a comment appended, forcing a
   different source cache key.
4. `multiple-inputs`: the edited source with all selected inputs in one public
   execute request.

Trace and interview probes use the same edited source after the execute phases
when those modes are selected.

## Metrics and boundaries

The JSON report distinguishes measured values from unavailable ones:

- Operation wall time surrounds the public `RuntimeClient` call.
- Compile, run, total, cache-hit, and toolchain timings come only from public
  result timing fields. Missing runtime fields remain unsupported; wall time is
  never relabeled as compile or run time.
- Trace event count and serialized trace/response bytes are computed from the
  public canonical response before the large trace itself is discarded from
  the report.
- Playwright request sizes cover page, worker, and cross-origin requests that
  Chromium exposes. `Content-Length` is used as the encoded-body fallback for
  worker scripts whose Playwright body-size counter is zero.
- Window `PerformanceResourceTiming` is also captured per phase. It may omit
  resources fetched inside workers, so it complements rather than replaces the
  Playwright network ledger.
- The Long Tasks API measures the window main thread. Worker CPU work is not a
  main-thread long task and is represented by operation/runtime timings.
- Heap deltas use Chromium `performance.memory` with precise-memory reporting
  enabled. Chromium CDP performance counters are recorded for each complete
  fresh-context run. Unsupported browser memory surfaces are reported as such.

The default report is `reports/browser-runtime-benchmark.json` and uses schema
`tracecode-public-browser-benchmark-v2`. A failed runtime or wrong output is
recorded before the command exits non-zero, so partial evidence is not lost.

## Excluding runtime downloads

Use `--cache-assets` for command-to-result comparisons that exclude runtime
downloads. The benchmark serves immutable cache headers, lets the cold phase
populate the BrowserContext cache, and records `PerformanceResourceTiming`
transfer sizes for every later phase. Do not classify a phase as download-free
unless every measured sample reports zero transferred bytes.

Runtime prewarm time and command time are intentionally separate. A fresh
BrowserContext prewarm can still fetch, parse, compile, and instantiate runtime
assets. The subsequent phase is download-free only when its own transfer ledger
is zero; moving startup into prewarm does not relabel that startup work as a
performance gain.
