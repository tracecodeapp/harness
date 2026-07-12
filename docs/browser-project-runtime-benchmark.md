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
implemented by `javascript-project-worker.js` in the selected browser. It does not invoke
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
pnpm bench:browser-project-runtimes --engine=firefox --languages=python,csharp,cpp --iterations=5
pnpm bench:browser-project-runtimes --languages=python,java,csharp --prewarm=python:1,java:1,csharp:1
pnpm bench:browser-project-runtimes --runtime-manifests=./runtime-assets.json
pnpm bench:browser-project-runtimes --languages=java --prewarm=java:1 --execution-host --cache-assets
pnpm bench:browser-project-runtimes --report=reports/project-browser-before.json
```

`--engine` accepts exactly one of `chromium`, `firefox`, or `webkit` and
defaults to Chromium. Performance reports from different engines are separate
workloads and must not be merged into one latency distribution.

The correctness matrix runs all six providers against all three engines:

```bash
pnpm test:project-browser-matrix
```

`TRACECODE_PROJECT_MATRIX_ENGINES` and `TRACECODE_PROJECT_MATRIX_LANGUAGES`
can select a strict subset for local diagnosis. CI installs and runs all three
engines so browser compatibility cannot silently collapse back to Chromium.
Each provider-engine cell launches a fresh browser process, preventing a
previous provider's WASM/JIT memory from contaminating compatibility or timing.

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
| `process-io` | Shell pipeline plus distinct stdout/stderr writes | Exact stdin pipeline output and separate stderr |
| `cancellation` | Abort an active `sleep` command | Command settles as interrupted within five seconds |
| `disposal` | Dispose twice and inspect hosted frames | Disposal is idempotent and removes the execution-host iframe |

Filesystem records also retain the separate host-write, host-read, and shell
subtimings. No private worker message or test-only protocol is used.

## Metrics and interpretation

The default JSON report is
`reports/browser-project-runtime-benchmark.json` and uses schema
`tracecode-public-browser-project-benchmark-v1`. It retains raw samples as well
as aggregates, including:

- Per-phase wall time, output, status, correctness errors, resource timing,
  window Long Tasks, and `performance.memory` snapshots when the engine exposes
  them.
- Playwright network request sizes for page, worker, WebAssembly/toolchain, and
  consumer-CDN requests Playwright reports. `Content-Length` is the fallback when
  worker body-size counters are zero. Credentials and sensitive signed-URL query
  parameters are redacted from the stored URLs without changing byte counters.
- Raw Chrome DevTools Protocol `Performance.getMetrics` snapshots and deltas for
  Chromium samples. Firefox and WebKit report that metric surface as unsupported
  instead of fabricating equivalent values.
- Bundle raw/gzip size, deterministic run plan, runtime-manifest runtimes,
  skipped phases, infrastructure errors, and metric-support coverage.

The p50 and p95 fields are emitted only when a language/phase has at least five
passing timed samples. A one-sample `--smoke` run intentionally reports those
fields as unavailable; it is a browser integration check, not performance
evidence. Increase `--iterations` on noisy CI hosts and compare the raw samples,
standard deviation, pass counts, network ledger, and CDP deltas before drawing
conclusions from aggregate latency.

## Regression baseline

The compact five-sample baseline is stored in
`tests/fixtures/browser-project-performance-baseline.json`. It records p50 for
workspace construction, first command, and second fresh command independently
for every provider/engine pair. The raw multi-megabyte reports remain ignored
benchmark artifacts rather than source-controlled fixtures.

Check a compatible report with:

```bash
pnpm check:browser-project-performance \
  --report=reports/browser-project-runtime-chromium.json
```

The gate requires five passing samples per cell and applies both relative and
absolute tolerance. It is deliberately a broad regression detector, not a
promise that CI hardware reproduces a developer laptop to the millisecond.
`.github/workflows/browser-performance.yml` runs Chromium, Firefox, and WebKit
as separate nightly/manual jobs, measures each provider in its own browser
process, and retains the per-provider raw reports as artifacts.

The 2026-07-12 baseline also establishes an important engine distinction:
Firefox passed the full contract but was substantially slower for Python, C#,
and C++ than Chromium or WebKit. Capability remains green; performance is
reported and budgeted per engine instead of being flattened into a single
provider number. The measured table is in
`docs/browser-project-cross-engine-baseline-2026-07-12.md`.

## Excluding runtime downloads

Use `--cache-assets` to measure repeated project commands after the first command
has populated the BrowserContext cache. The report includes per-phase browser
resource timing; strict download-free comparisons require zero transferred bytes
for every measured sample. Tokenized frame documents may remain deliberately
uncacheable and must be disclosed or excluded.
