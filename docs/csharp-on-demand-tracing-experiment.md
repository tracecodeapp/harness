# C# on-demand tracing experiment

## Product contract

C# now separates two concerns that were previously represented by one `trace`
boolean:

- `trace` is the immutable capability of a compiled assembly. It remains part
  of the compiled-artifact key and cannot change during the artifact lifetime.
- `recordTrace` selects whether one execution of a trace-capable assembly
  records events. It is not part of the artifact key.

The public runtime contract is intentionally unchanged while this remains a
language-level experiment. `CSharpRuntimeClient.executePreparedTraceBatch`
accepts an experiment-only boolean vector with exactly one entry per case. The
normal prepared trace methods continue to trace every case.

This is the boundary needed by an application-managed drain: prepare once,
trace the selected case, then execute later cases from the same durable
artifact with recording disabled. Drain scheduling, interruption, and artifact
lifetime remain product/session responsibilities rather than worker policy.

## Implementation

The worker sends both the immutable assembly capability and the per-execution
recording selection to the managed runner. The runner validates the assembly
against `trace`, then configures `RuntimeTraceSink` from `recordTrace`.

The final disabled path moves the switch above the rewritten learner body. Each
instrumented learner method contains the original body and the traced body; one
method-entry check selects the original body while recording is disabled. This
bypasses statement hooks, trace delegates, snapshots, local collection
wrappers, loop machinery, and sink calls together.

C# has one necessary lower boundary. Selected collection fields use
trace-aware subclasses so mutations remain observable across helper methods.
Disabled bodies retain those field types for type and reflection compatibility,
and their collection operations return immediately after the underlying base
operation, before allocating or normalizing trace arguments.

The lower sink guards remain defense in depth. A disabled execution:

- emits no events;
- does not consume trace budgets or trace timeouts;
- avoids snapshot, mutation, alias, and index bookkeeping; and
- reaches instrumented helpers only at representation boundaries that cannot be
  removed without changing declared learner types.

Cases still execute in fresh runner workers. The reusable object is the
compiled assembly, not mutable process state.

## Correctness evidence

The unit boundary covers a mixed `[true, false, true]` batch and proves that it
uses one artifact, returns identical values, records only selected cases,
validates selector length, and rejects disposed handles.

The browser lifecycle test exercises the rebuilt compiler and runner bundles.
It executes the same prepared trace assembly once with recording enabled and
once disabled, proving identical output, a non-empty selected trace, an empty
disabled trace, and compiled/host artifact cache hits for both executions.

The corpus capability campaign intentionally bypasses Judge policy and uses the
real C# compiler authority plus isolated browser-WASM runners. For each of the
200 product problems it prepares one trace-capable assembly, traces one case,
and runs one additional case with recording disabled. Final raw results are in
`reports/csharp-on-demand-tracing-method-entry-capability-final-2026-08-08.json`.

The final campaign covered 200/200 programs with one persistent compiler worker
and 400 fresh case runners. It had zero preparation/execution failures, zero
missing timings, and zero trace-selection mismatches. Selected-trace wall
latency was 498 ms p50, 644 ms p90, and 974 ms p99. The maximum was 1.283 s for
word-search-ii, of which 518 ms was managed execution and the remainder was
runner startup/transport. Trace-disabled wall latency was 383 ms p50 and 473 ms
p99; managed disabled execution was 18.4 ms p50 and 67.2 ms maximum.

The final corpus report SHA-256 is
`161554e6ec331268a494bd9c481917a770f1941127b2bcbfdd3810387e837d88`.

## Opportunity-cost measurement

The focused benchmark compares:

1. one trace-capable assembly, with recording disabled for the drain; and
2. the same selected trace plus an incrementally prepared clean companion for
   the drain.

The decision clock removes the trace preparation and selected trace common to
both strategies. It compares the clean preparation cost plus clean managed
execution time against trace-disabled managed execution time. Fresh runner
startup is retained as a separate wall clock but is not allowed to hide the
instrumentation cost.

Four reversed A/B pairs after moving the switch to learner method entry
produced:

| Problem | Cases | Stable choice | Dual minus single opportunity | Estimated crossover |
| --- | ---: | --- | ---: | ---: |
| two-sum | 10 | one assembly | +183 ms | no measured clean crossover |
| coin-change | 12 | one assembly | +168 ms | no measured clean crossover |
| n-queens | 9 | one assembly | +231 ms | no measured clean crossover |
| open-the-lock | 12 | one assembly | +194 ms | 270 drain cases |

The sign is positive when the clean companion costs more. Disabled managed
drain time now matches the clean companion: 196.2 versus 196.4 ms for
coin-change, 347.5 versus 361.5 ms for n-queens, and 388.9 versus 381.1 ms for
open-the-lock. Before the method-entry switch those one-assembly drains cost
486.3, 631.1, and 878.0 ms respectively. Raw samples are in
`reports/csharp-on-demand-tracing-method-entry-hotpath-2026-08-08.json`.
Its SHA-256 is
`2ecec72b6e06bfda2278b26c9925fb89001206e40fbea5ac92efd70ecf116594`.

All four iteration signs agreed for every focused problem. The uncontended
run therefore reverses the three former clean-companion exceptions without an
adaptive artifact choice.

## Recommendation

One trace-capable assembly is both the product-facing model and the measured
C# implementation choice. A separate clean compile no longer wins any focused
workload. The method-entry split adds some assembly size and can add tens of
milliseconds to trace preparation or selected execution, but it removes
hundreds of milliseconds from guard-heavy drains and avoids the roughly
168-223 ms incremental clean preparation entirely.

Selected tracing is no longer pathological in the focused cases. In the
uncontended run the guard-heavy selected cases were roughly 0.5-0.86 seconds.
Fresh isolated runner startup is a large part of that wall clock and is
independent of whether recording is disabled.
