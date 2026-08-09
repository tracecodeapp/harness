# JavaScript and TypeScript on-demand tracing experiment

Date: 2026-08-08

## Decision

JavaScript and TypeScript should use one prepared trace artifact for an
interactive compile session. Each case selects tracing at execution time. A
disabled case takes a top-level clean branch before the trace recorder, runtime
source map, serialization snapshots, or instrumented runner are created.

This remains a language-level experiment. Judge and the portable prepared
program contract are intentionally unchanged.

## Why one artifact has no drain penalty

Trusted preparation already builds and retains both representations:

- `executableCode`: the normal JavaScript executable (or the one TypeScript
  transpilation of the original source), plus input materializers and parameter
  descriptors;
- `instrumentedCode`: the separately instrumented executable used only by a
  tracing-enabled case.

The tracing-disabled executor calls the existing `executeCode` path with
`executableCode`. This is the same clean code and the same materialization path
that a separately prepared code artifact would execute. There are no injected
hooks or per-hook guards on the clean path.

A dual-artifact strategy therefore cannot make drain execution cheaper. It can
only repeat trusted preparation. Across the focused real-Chromium runs, the
median incremental second preparation cost stayed positive and ranged from:

| Language | Observed median range |
| --- | ---: |
| JavaScript | 1.1–1.5 ms |
| TypeScript | 2.7–10.3 ms |

Raw total and drain clocks vary by tens of milliseconds because every case is
intentionally isolated in a fresh disposable Worker. Those A/B differences are
worker-startup noise, not different user-code hot paths, so they are not used
to choose the artifact strategy.

## Boundary and lifecycle

`JavaScriptWorkerClient.executePreparedTraceBatch` is the experiment-only
entry point. It accepts a live trace program created by that exact client and
one boolean per input. The client keeps the trusted prepared payload private in
a `WeakMap`; the public program never exposes source artifacts or executable
objects. Foreign, disposed, clean-mode, or length-mismatched programs are
rejected.

Each input still runs in a fresh executor Worker. The long-lived coordinator
only prepares immutable artifacts and never observes executor mutations.

## Evidence

The lifecycle test runs JavaScript and TypeScript batches with
`[true, false, true]` and proves:

- outputs are identical and in order;
- only selected cases contain trace events;
- every case reports a prepared-artifact cache hit;
- the coordinator prepares exactly once;
- TypeScript executors never load the TypeScript compiler;
- selector length validation and disposal ownership are enforced.

The complete JavaScript runtime, lifecycle, and real-Chromium authority suites
pass. The focused benchmark uses the direct language client rather than Judge:

```sh
node --import tsx scripts/benchmark-javascript-on-demand-tracing.ts \
  --iterations=3 \
  --out=reports/javascript-on-demand-tracing-focused-2026-08-08.json
```

The raw report is intentionally gitignored; this document records the durable
mechanism and measurements.
