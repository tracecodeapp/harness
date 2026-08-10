# Java on-demand tracing experiment

Date: 2026-08-08

## Question

For one logical execution containing a selected case followed by background
drain cases, should Java:

1. compile one instrumented artifact and turn recording on or off per case, or
2. compile both trace and clean artifacts and execute them in separate inner
   TraceJVM runners?

The public API is intentionally out of scope for this experiment. The eventual
API should describe which cases need traces; choosing the cheapest mechanism is
a language-runner implementation detail.

## Benchmark boundary

`scripts/benchmark-java-on-demand-tracing.ts` bypasses Judge and the prepared
provider. It calls `JavaWorkerClient` directly while retaining the real browser
Worker, Java compiler, generated classes, TraceJVM process, fresh-case
isolation, and trace-event transport.

Both strategies use one outer browser Worker and execute the selected case
first. The one-artifact strategy uses one inner TraceJVM runner for the selected
case and the drain. The dual-artifact strategy uses one trace runner for the
selected case and one clean runner for the drain.

`decisionWallMs` starts immediately before trace preparation and includes all
preparation and execution needed by the strategy. It excludes the common outer
Worker warmup.

## Results

### Top-level clean companion follow-up

The follow-up implements the design proposed by the first corpus run. A trace
preparation now generates two entry points in separate generated packages:
the existing instrumented entry and a clean companion. TraceJVM submits both
source units in one compiler request and returns one restorable program
artifact. Each case selects its entry class once before learner code runs.
There is still one outer Worker, one compiler invocation, one artifact, and one
inner runner; there is no disabled-tracing branch inside clean learner loops.

The trace budget fallback uses the same companion. When a selected trace fills
its event budget, `TraceExecutionRunner` retains the truncated trace but
re-executes the case through the clean entry point to obtain the verdict. This
removes the post-budget guarded-hook replay.

The worst first-corpus case was N-Queens `n = 9`:

| N-Queens `n = 9` | Before | Top-level clean companion |
| --- | ---: | ---: |
| Selected trace run | 2,008–2,031 ms | **593–598 ms** |
| Complete nine-case mixed execution | 19.47 s | **825–849 ms** |
| Clean `n = 9` drain | 15.41–17.00 s instrumented-off | **136–141 ms** |
| Complete execution average | 2.16 s/case | **92–94 ms/case** |

The hook profiler explains the selected-trace improvement. The 16,000-event
budget tripped after about 328–331 ms. The old fallback then spent another
1.54–1.55 seconds replaying through the instrumented class and took 164,877
post-budget drop fast paths. The clean fallback takes about 139–141 ms and has
zero post-budget hook drops. Serialization is about 96–97 ms, event building
about 31–32 ms, storage about 18 ms, export about 7 ms, and host parsing about
1.5 ms. Those are now secondary costs rather than the dominant defect.

The original five dual-artifact outliers plus the formerly failing corpus
problem were rerun for two paired iterations:

| Follow-up result | One artifact | Trace + redundant clean artifact |
| --- | ---: | ---: |
| Problems won | **6** | 0 |
| Cases completed | **69 / 69** | 69 / 69 |
| Sum of median decision times | **10.390 s** | 11.789 s |

All six one-artifact wins were stable. Its advantage ranged from 175–272 ms.
`open-the-lock` remains the slowest suite at about 3.40 seconds of execution for
12 cases (about 283 ms/case). Its selected trace is 1.52–1.54 seconds and its
two exhaustive clean cases are about 0.78 seconds each. It misses an
aspirational one-second ceiling for every individual trace, but the complete
execution remains well below a one-second-per-case average.

The `serialize-deserialize-tree` failure was a separate type-preservation bug.
The rewriter transformed `String.valueOf(current.val)` into a generic
`<T> T readObjectFieldAtLine(...)` expression. That made both
`String.valueOf(Object)` and `String.valueOf(int)` applicable. Primitive field
read overloads now preserve the primitive return type (and avoid boxing on the
field-read hot path). The trace artifact now compiles and all 14 cases complete
under both strategies.

A final one-artifact-only compatibility pass exercised the complete corpus
after the implementation change. It is a coverage/performance pass rather than
another paired economics run (the six tail problems above retain the paired
comparison):

| Full follow-up corpus | Result |
| --- | ---: |
| Problems | **200 / 200** |
| Cases | **2,352 / 2,352** |
| Failed preparations/executions | **0** |
| Total execution time | 66.723 s |
| Mean execution time | **28 ms/case** |
| Per-case p50 / p90 / p99 | 4.2 / 14.4 / 271.5 ms |
| Slowest suite average | **284.6 ms/case** (`open-the-lock`) |

Only two selected traces exceeded one second: `open-the-lock` at 1.528 seconds
and `word-search-ii` at 1.004 seconds. No problem averaged one second per case.
The slowest individual case is therefore about 11 times faster than the old
16.2-second N-Queens median, and the corpus meets the product target of at most
one second per case on average with substantial margin.

### Systemic trace-budget and serialization hot path follow-up

The two remaining one-second tail traces exposed a systemic Java budget bug,
not problem-specific behavior. The product supplies two independent ceilings:
`maxTraceSteps: 4,000` and `maxStoredEvents: 16,000`. Java previously preferred
the stored-event value whenever it was present, so `maxTraceSteps` had no
effect. Open Lock merely generated enough activity to reveal that the runner
was collecting 16,000 raw events (19,484 after normalization).

Java now resolves every positive trace ceiling and gives the runner the
strictest one. A prepared-provider regression test inspects the runner profile
directly: `{ maxTraceSteps: 1,000, maxStoredEvents: 2,000 }` must initialize a
1,000-event runner budget. This is one systemic rule for every problem; no
problem can override it.

The serialization profiler also found repeated reflection setup when snapshots
contained learner-defined objects. Serializable field metadata is now cached
once per learner class and per run. Keeping the cache run-local avoids pinning
learner class loaders. A broader scalar-JSON/list-index memoization experiment
was measured and discarded because it regressed end-to-end time.

| Selected trace (three-run focused median) | Before | After |
| --- | ---: | ---: |
| Open Lock | 1,566 ms | **504 ms** |
| Word Search II | 1,006 ms | **962 ms** |

Open Lock now fills exactly 4,000 raw events and completes in 503–507 ms across
the three profiled runs. Word Search II naturally completes before the cap with
3,376 raw events and finishes in 960–987 ms. Outputs and event-selection
invariants are unchanged.

The final production-mode compatibility pass after both changes completed all
200 problems and all 2,352 cases with no failures. Total execution was 65.817
seconds (28 ms/case mean); p50/p90/p99 were 4.4/14.7/271.1 ms. Word Search II
was the slowest individual and selected case at 965.6 ms. No Java trace exceeded
one second, and every sample used one outer Worker and one inner runner.

The complete paired economics run was then repeated over all 200 problems with
the final mechanism. Each problem ran twice per strategy, reversing A/B order
on the second iteration. This compares the real current alternatives: one trace
preparation containing its clean companion versus that same trace preparation
plus a redundant separately prepared clean artifact and second runner.

| Final paired corpus | One artifact | Dual artifact |
| --- | ---: | ---: |
| Problems won | **200** | 0 |
| Sum of per-problem median decision times | **217.666 s** | 267.378 s |
| Inner runners per sample | **1** | 2 |

Single artifact won all 400 iteration-level A/B pairs as well as all 200
per-problem medians. Its per-problem advantage ranged from 131 to 402 ms
(median 245 ms), saving 49.712 seconds across the corpus totals. Every paired
output and selected-case event count was identical, and no worker/runner
invariant failed. For this exact 200-program corpus, the result is therefore
unambiguous: single artifact is faster for every program measured. This remains
an empirical corpus conclusion, not a proof about every possible Java program.

### Full 200-problem corpus

The corpus run discovered the Java practice solutions and problem definitions
independently and used their exact intersection. At this app-repo revision both
trees contain the same 200 names: 190 `solution-method` problems and 10
`ops-class` problems, comprising 2,352 test cases.

Each problem ran two paired iterations. Iteration one ran one-artifact then
dual-artifact; iteration two reversed the order. The first declared case was
traced first, followed by the complete remaining drain. The synthetic
crossover sweep was deliberately not multiplied across the corpus.

199 problems (2,338 cases) completed both strategies in the original baseline. One problem,
`serialize-deserialize-tree` (14 cases), could not prepare the shared trace
artifact because generated Java had an ambiguous `String.valueOf` call between
the `Object` and `int` overloads. Since both strategies require the trace
artifact for the selected case, it is excluded from the economics. This is a
trace-artifact corpus compile failure; the run did not establish whether its
clean artifact compiles.

| Corpus result | One instrumented artifact | Trace + clean artifacts |
| --- | ---: | ---: |
| Problems won | 194 | 5 |
| Sum of per-problem median decision times | 257.277 s | 259.195 s |
| Difference | **1.919 s faster (0.74%)** | — |

The winner count strongly favors one artifact, but the suite totals are almost
tied. The 194 ordinary one-artifact wins save 46.075 seconds in aggregate. Five
compute-heavy outliers give 44.156 seconds back. Choosing the faster mechanism
per problem would take 213.121 seconds, a 17.16% improvement over the current
always-one implementation.

All five dual winners were stable in both paired iterations:

| Problem | Paired `dual - single` | Median advantage | Heaviest drained case, instrumented off / clean |
| --- | ---: | ---: | ---: |
| counting-sort | -208 ms, -277 ms | 242 ms dual | 513 ms / 14 ms |
| generate-parentheses | -652 ms, -632 ms | 642 ms dual | 703 ms / 23 ms |
| prefix-and-suffix-search | -2,503 ms, -2,516 ms | 2,510 ms dual | 1,533 ms / 7 ms |
| n-queens | -18,430 ms, -16,592 ms | 17,511 ms dual | 16,202 ms / 136 ms |
| open-the-lock | -23,465 ms, -23,039 ms | 23,252 ms dual | 11,978 ms / 798 ms |

The median `dual - single` across all valid problems was +239 ms. Two small
one-artifact winners (`count-range-sum` and
`how-many-numbers-are-smaller-than-current`) changed sign between their paired
iterations, but all five material dual winners and the other 192 winners were
stable. The extra clean preparation median was 92 ms (83–161 ms range).

The raw report contains 796 samples and every per-case timing:
`reports/java-on-demand-tracing-corpus-2026-08-08.json`.

### Focused preliminary sample

The earlier focused values below are medians of three runs. Positive
`dual - single` means the one-artifact strategy was faster. They correctly
characterized ordinary suites, but the full corpus shows why three problems
cannot establish the tail behavior of a disabled hot path.

| Problem | Selected case | One artifact | Dual artifact | Dual - single |
| --- | ---: | ---: | ---: | ---: |
| two-sum | first | 858 ms | 1,086 ms | +228 ms |
| two-sum | guard-heavy | 847 ms | 1,081 ms | +234 ms |
| coin-change | first | 1,036 ms | 1,172 ms | +136 ms |
| coin-change | trace-heavy `g2` | 1,770 ms | 1,968 ms | +198 ms |
| binary-tree-inorder-traversal | first | 996 ms | 1,272 ms | +276 ms |
| binary-tree-inorder-traversal | guard-heavy | 1,145 ms | 1,415 ms | +270 ms |

Every pair returned identical outputs. Only the selected case emitted events.
The strategies used one outer Worker each; the one-artifact path used one inner
runner and the dual path used two.

### Sunk-cost crossover

Calibration runs the instrumented `coin-change` artifact with recording off and
ignores the first case's one-time class-loading cost. Case `g2` was the most
expensive remaining case at about 61 ms, versus roughly 3–8 ms for ordinary
cases.

The crossover sweep traces one ordinary selected case and then drains repeated
copies of `g2`:

| Guard-heavy drain cases | One artifact | Dual artifact | Dual - single |
| ---: | ---: | ---: | ---: |
| 1 | 939 ms | 1,152 ms | +213 ms |
| 2 | 1,002 ms | 1,168 ms | +166 ms |
| 4 | 1,123 ms | 1,173 ms | +50 ms |
| 6 | 1,255 ms | 1,197 ms | -58 ms |
| 8 | 1,358 ms | 1,221 ms | -136 ms |

The focused synthetic crossover is between four and six copies of the focused
sample's worst guard-off case. The extra clean preparation was about 90–100 ms, and its second
inner runner also paid a fresh class-loading/startup cost. Those fixed costs
dominate ordinary test suites; repeated guard-heavy computation eventually
repays them.

## Decision

The API decision and the present Java implementation decision are different.

The API should still expose one interactive execution/artifact capability and
per-case trace selection. It should not expose trace and clean artifacts or ask
the product to select a compiler strategy. Submit remains a separate, wholly
clean compilation.

Java's original implementation of that one-artifact idea—execute the same
instrumented methods while every hook's recording guard is off—is not safe as a
universal performance policy. It wins 97.5% of valid problems, yet the few
hook-dense compute outliers make always-one only 0.74% faster overall and make
individual drains as much as 23 seconds slower. The three-problem result hid
this tail.

The implemented Java policy is therefore one physical TraceJVM program artifact
containing traced and clean generated entry points. It preserves one asset
load, one compiler invocation, one outer Worker, one prepared capability, and
one inner runner while delivering clean-equivalent drain performance. The same
clean entry point is the trace-budget verdict fallback. A second preparation is
no longer justified by the measured outliers and remains absent from the API.

## Reproduce

```sh
TRACECODE_TRACEJVM_ROOT=/Users/obinnanwachukwu/Code/tracecodeapp/tracejvm \
  node --import tsx scripts/benchmark-java-on-demand-tracing.ts \
  --iterations=3 \
  --out=/tmp/java-on-demand-tracing.json
```

Full corpus:

```sh
TRACECODE_TRACEJVM_ROOT=/Users/obinnanwachukwu/Code/tracecodeapp/tracejvm \
  node --import tsx scripts/benchmark-java-on-demand-tracing.ts \
  --corpus \
  --iterations=2 \
  --out=reports/java-on-demand-tracing-corpus-2026-08-08.json
```

Add `--trace-profile` to retain per-case `TraceHooks` profiles in the raw
samples. The focused N-Queens follow-up report is
`reports/java-on-demand-tracing-n-queens-clean-fallback-2026-08-08.json`; the
six-problem tail report is
`reports/java-on-demand-tracing-outliers-top-level-2026-08-08.json`.
The complete one-artifact compatibility report is
`reports/java-on-demand-tracing-corpus-top-level-2026-08-08.json`; reproduce it
with `--corpus --one-artifact-only --iterations=1`.

The raw JSON contains calibration timings, every sample, event counts, outputs,
Worker/runner counts, and medians. Absolute timings are machine-dependent; the
benchmark is intended to compare paired strategies on the same machine. The
direct-runner boundary asserts byte-for-byte JSON output equality between the
two strategies and selected-only event emission, but intentionally bypasses
Judge comparison against expected answers. The corpus result therefore proves
strategy equivalence at this boundary, not independent answer correctness.
