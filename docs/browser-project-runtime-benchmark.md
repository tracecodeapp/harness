# Public project-browser runtime benchmark

`scripts/benchmark-browser-project-runtimes.ts` measures the browser behavior a
consumer gets from the public project entrypoint:

```text
createBrowserProjectWorkspace() -> RuntimeWorkspace public methods -> dispose()
```

The measured product surface is **project-browser only**. Node.js/tsx launches
Playwright, serves the temporary static files, and writes the report; none of
that host-driver time is included. The JavaScript command is spelled
`node main.js` because that is the public project shell syntax, but it is
implemented by `javascript-project-worker.js` in Chromium. It does not invoke
or benchmark a host Node.js runtime.

This benchmark is independent from the Classic browser benchmark documented in
`docs/browser-runtime-benchmark.md`. The two surfaces have different lifecycle,
filesystem, policy, and HTTP behavior, so their results should not be merged.

## Run it

The full six-language matrix is the default:

```bash
pnpm bench:browser-project-runtimes
```

The default is five fresh samples per language. A fast JavaScript functional
check runs one sample:

```bash
pnpm bench:browser-project-runtimes --smoke
```

Useful overrides include:

```bash
pnpm bench:browser-project-runtimes --languages=python,typescript,cpp --iterations=10 --seed=20260711
pnpm bench:browser-project-runtimes --languages=python,java,csharp --prewarm=python:1,java:1,csharp:1
pnpm bench:browser-project-runtimes --runtime-manifests=./runtime-assets.json
pnpm bench:browser-project-runtimes --languages=java --prewarm=java:1 --execution-host --cache-assets
pnpm bench:browser-project-runtimes --report=reports/project-browser-before.json
```

`--runtime-manifests` accepts either a runtime map directly or an object with a
`runtimeManifests` property. `TRACECODE_BENCH_RUNTIME_MANIFESTS` is the CI
equivalent. This is the same generic, consumer-owned manifest mechanism used by
the public browser harness; it is not tied to TraceCode hosting and applies
across Python, JavaScript, TypeScript, Java, C#, and C++.

Java requires a complete consumer-provided runtime manifest (`worker`,
`loader`, `helperJar`, `compilerJar`, `rewriterJar`, and `parserJar`). The
harness deliberately does not redistribute or silently select CheerpJ. If the
manifest is missing or partial, Java fails before Worker construction; the
benchmark keeps the command failure in the report, continues the independent
workspace probes and remaining matrix, writes the partial report, and exits
non-zero.

`--execution-host` starts a second local origin and routes Java through the
public dedicated-origin contract. In this profile, `java:1` warms the one
workspace-session VM during construction; the two command phases reuse that VM
while retaining fresh project/class directories. This profile measures the
recommended interactive TraceCode architecture. Omit it to measure the stricter
one-shot Java profile.

## Browser fixtures

Every language uses a small deterministic project and the public project shell:

| Runtime | Browser-project command | Host Node involved? |
|---|---|---:|
| Python | `python3 main.py` | No |
| JavaScript | `node main.js` via the browser project worker | No |
| TypeScript | `tsc --project tsconfig.json && node dist/main.js` via browser compiler/worker assets | No |
| Java | `javac Main.java && java Main` | No |
| C# | `dotnet run --project App.csproj` | No |
| C++ | `clang++ -std=c++17 main.cpp -o project-bench && ./project-bench` | No |

Each language/iteration receives a new Playwright `BrowserContext`, then a new
workspace configured with `projectWorkerIsolation: "per-command"`. With
`--execution-host`, Java alone uses a workspace-session VM on the second origin;
the other project runtimes remain per-command. The run order is shuffled
independently per iteration using a seeded Fisher-Yates shuffle.

Prewarming is off by default (`python:0,java:0,csharp:0`), so the baseline does
not hide cold-start work. `--prewarm=python:1,java:1,csharp:1` exercises the
public security-preserving one-shot pools: a clean worker is warmed, leased for
at most one user command, terminated, and replaced. Depth is limited to 2 per
language and 4 total, matching the public API. JavaScript, TypeScript, and C++
do not accept this option. Use separate reports with identical seeds and sample
counts to compare cold-safe and prewarmed runs. Because each benchmark sample is
language-specific, its workspace receives only that language's requested depth;
warming unrelated runtimes would contaminate the comparison. The requested map
and per-sample applied map are retained in report options, methodology, and
workspace-construction records.

## Measured phases

| Phase | Public behavior measured | Correctness gate |
|---|---|---|
| `workspace-construction` | Await `createBrowserProjectWorkspace()` with fixture and protected session files | Workspace resolves successfully |
| `first-command` | First full compile/run or run command | Exit 0 and exact output |
| `second-fresh-command` | Identical command on the same workspace; worker-backed execution gets a new per-command user worker | Exit 0 and exact output |
| `filesystem` | Public `writeFile`/`readFile`, then shell write/read | Host and shell contents persist exactly |
| `policy-denials` | Ordinary shell reads a hidden file and overwrites a readonly file | Both actions are denied, the secret is not emitted, and readonly content is unchanged |
| `http-bridge` | Public `workspace.http.listen()` reached through public shell `curl` | Exact loopback status/body path |

Filesystem records also retain the separate host-write, host-read, and shell
subtimings. No private worker message or test-only protocol is used.

## Metrics and interpretation

The default JSON report is
`reports/browser-project-runtime-benchmark.json` and uses schema
`tracecode-public-browser-project-benchmark-v1`. It retains raw samples as well
as aggregates, including:

- Per-phase wall time, output, status, correctness errors, resource timing,
  window Long Tasks, and `performance.memory` snapshots when Chromium exposes
  them.
- Playwright network request sizes for page, worker, WebAssembly/toolchain, and
  consumer-CDN requests Chromium reports. `Content-Length` is the fallback when
  worker body-size counters are zero. Credentials and sensitive signed-URL query
  parameters are redacted from the stored URLs without changing byte counters.
- Raw Chrome DevTools Protocol `Performance.getMetrics` snapshots and deltas for
  each complete browser sample.
- Bundle raw/gzip size, deterministic run plan, runtime-manifest runtimes,
  skipped phases, infrastructure errors, and metric-support coverage.

The p50 and p95 fields are emitted only when a language/phase has at least five
passing timed samples. A one-sample `--smoke` run intentionally reports those
fields as unavailable; it is a browser integration check, not performance
evidence. Increase `--iterations` on noisy CI hosts and compare the raw samples,
standard deviation, pass counts, network ledger, and CDP deltas before drawing
conclusions from aggregate latency.

## Excluding runtime downloads

Use `--cache-assets` to measure repeated project commands after the first command
has populated the BrowserContext cache. The report includes per-phase browser
resource timing; strict download-free comparisons require zero transferred bytes
for every measured sample. Tokenized frame documents may remain deliberately
uncacheable and must be disclosed or excluded.
