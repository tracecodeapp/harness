# C++ on-demand tracing experiment

## Product question

Compile should trace the selected case immediately and drain the remaining
cases without recording. For C++, the language boundary is allowed to choose
the cheapest implementation of that product request. This experiment compares:

1. **One artifact:** prepare one trace-capable Wasm module, execute the selected
   case first with recording enabled, then execute the drain cases from the
   same module with recording disabled.
2. **Two artifacts:** prepare the same traced module for the selected case,
   then separately compile a clean Wasm module and execute the drain through
   that module.

The common traced preparation is required by either strategy. The actual sunk-
cost choice is therefore whether the clean compilation saves enough drain
execution time to pay for itself.

## Measurement boundary

`scripts/benchmark-cpp-on-demand-tracing.ts` deliberately bypasses Judge and
uses `CppWorkerClient` directly in Chromium. The browser still runs the real
TraceCC compiler Worker, PCH shards, generated driver, learner runner, Wasm
module, event transport, and prepared-program table. The benchmark excludes
Judge comparison, receipts, policy, and application scheduling because none of
those costs decides the C++ artifact strategy.

The exact runtime asset identity is:

```text
fb4b6f41f9e9b7db89b6c8425bb2c6218979219a4150f96619b6461b4b78d294
```

The campaign discovers the intersection of AlgoFlow problem definitions and
C++ reference solutions instead of relying on a handwritten list. At the time
of this run the intersection is 200 problems.

## Paired design and invariants

Each problem receives two paired iterations. Iteration one runs one-artifact
then two-artifact; iteration two reverses that order. Each strategy starts with
a fresh learner runner, while the trusted compiler authority remains warm as it
would during an interactive product session. The compiler artifact caches are
disabled so a repeated benchmark sample cannot turn a required compilation
into a cache hit. The compiler Worker uses the product's 64-compile retirement
boundary; an extra clean compilation therefore also owns its share of bounded
compiler replacement cost.

Every sample asserts:

- one learner runner is created;
- one-artifact issues exactly one compiler request;
- two-artifact issues exactly two compiler requests and receives two distinct
  prepared-program IDs;
- the selected case emits trace events;
- every drain case emits zero trace events;
- every execution completes;
- one- and two-artifact outputs are structurally identical after canonicalizing
  per-instance `__id__`/`__ref__` allocation metadata (aliases and graph
  back-references remain part of the comparison);
- selected-case event counts match between strategies.

Failures are isolated per problem. The raw JSON report is rewritten after each
sample, so a browser or machine interruption retains all completed evidence.

## Why the report has two deltas

TraceCC's first real driver compilation after a load-only warmup has visible
variance. A raw wall-clock comparison remains useful and is retained, but it
can make a common traced compile look like a strategy difference.

The confidence decision therefore uses the opportunity-cost delta:

```text
(marginal clean preparation + two-artifact execution)
  - one-artifact execution
```

Positive means the clean artifact did not repay its compile cost and the one-
artifact strategy wins. Negative means the clean drain saved enough execution
to justify the extra compilation. The sign is also recorded independently for
both reversed-order iterations.

For workloads where clean execution is faster, the report estimates a
crossover in drain cases:

```text
ceil(clean preparation / observed clean execution saving per drain case)
```

This is an empirical estimate for the measured test vector, not a claim that
all future inputs have identical per-case cost.

## Corpus result

The exact-policy campaign completed all 200 problems and all 2,352 unique test
cases. Across two reversed paired iterations this is 800 strategy samples,
9,408 case executions, 1,200 compiler requests, and 800 fresh learner runners.
There were no preparation failures, execution failures, output mismatches,
selected-trace event-count mismatches, or drain cases that emitted events.

| Result | Count |
|---|---:|
| Stable one-artifact wins | 198 |
| Stable two-artifact wins | 2 |
| Unstable problems | 0 |
| One-artifact iteration wins | 396 / 400 |
| Two-artifact iteration wins | 4 / 400 |

The raw end-to-end decision totals were **75.39 seconds for one artifact** and
**127.75 seconds for two artifacts**. Issuing the extra clean compilation cost
52.36 seconds across the suite, making two artifacts 69.5% slower in aggregate.

After removing the traced preparation common to both choices, the sunk-cost
opportunity totals were **5.962 seconds for one-artifact execution** versus
**64.833 seconds for clean preparation plus two-artifact execution**. A perfect
per-problem oracle would select the clean artifact only twice and save 544 ms
over always choosing one artifact. That is 9.12% of this deliberately narrow
post-trace execution clock, but less than one percent of the full one-artifact
decision total. The opportunity delta distribution was:

| Percentile | Two minus one |
|---|---:|
| Minimum | -356 ms |
| p25 | +216 ms |
| p50 | +246 ms |
| p75 | +310 ms |
| p90 | +383 ms |
| p99 | +902 ms |
| Maximum | +1,004 ms |

Positive values favor one artifact.

### The two real clean-artifact crossovers

`coin-change` and `open-the-lock` are the only programs where trace-capable
guard-off execution is expensive enough for a clean drain to repay compilation.

| Problem | Trace-capable drain | Clean drain | Clean preparation | Two-artifact win | Estimated crossover |
|---|---:|---:|---:|---:|---:|
| `coin-change` | 424 ms | 33 ms | 204 ms | 188 ms | 6 drain cases |
| `open-the-lock` | 1,024 ms | 344 ms | 324 ms | 356 ms | 6 drain cases |

Both signs were stable in the two-iteration corpus run. A separate six-pair
campaign then reproduced the result on every iteration: six of six two-artifact
wins for each problem. Across the corpus and extension, each candidate therefore
won all eight opportunity-cost pairs. The extension placed the empirical
crossover between roughly five and seven drain cases, consistent with the
six-case corpus estimate.

The engineering conclusion is not that C++ should generally compile twice. One
artifact is the correct default and wins 198/200 programs, every measured pair
for those programs, and the suite aggregate by a large margin. The language
runner may profitably choose a clean companion for an observed guard-heavy
workload once the remaining drain is long enough to cross its measured compile
cost. That choice remains an opaque runner optimization; the product request is
still simply which cases require tracing.

Raw reports:

- `reports/cpp-on-demand-tracing-corpus-paired-2026-08-08.json`
- `reports/cpp-on-demand-tracing-dual-candidates-extended-2026-08-08.json`

## Reproduction

```bash
node --import tsx scripts/benchmark-cpp-on-demand-tracing.ts \
  --iterations=2 \
  --tracecc-assets=.cache/tracecc-runtime-assets/fb4b6f41f9e9b7db89b6c8425bb2c6218979219a4150f96619b6461b4b78d294 \
  --out=reports/cpp-on-demand-tracing-corpus-paired-2026-08-08.json
```
