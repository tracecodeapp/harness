# Python warm-session measurement diagnosis

Date: 2026-11-24

No new host samples were taken for this diagnosis. It uses the existing A/A,
closing-control, reference re-record and all-Python-warm session artifacts.

> Follow-up local worker-phase receipts identified the residual more precisely:
> it is the next preparation waiting for asynchronous replacement-standby
> warm-up, not observer cleanup. See `PYTHON-SAME-PAGE-RERUN.md` in the root-cause
> artifact directory. The schedule diagnosis and fresh-page correction below
> are unchanged.

## Finding

The Python warm distributions are controlled by whether the same version's
warm page runs twice consecutively, not by the package version. Reversing the
version order every round creates a same-version boundary between rounds:
`A,B` then `B,A`. The first `B` of the second round reuses the page and worker
that just completed the preceding sample and is about 180--205 ms slower.

The runner creates one browser context per version, keeps one warm page per
version for the entire group, calls `bench.release()` after every sample, and
closes the pages only after the group. The relevant implementation is
`java-runner/run-g8.mjs:511-512,520,523-543,597,626-628`. The alternating
function is `live-control.mjs:34-40`; the reference re-record uses the same
reverse-every-round pattern at `reference-rerecord.mjs:23-26`.

## Schedule comparison

| Session | Python warm groups | Pages and workers | Round order | 0.20.1 | Consecutive same-version boundaries |
| --- | --- | --- | --- | --- | ---: |
| A/A | BS/Perm Run and Submit, plus cold controls | Two independent version contexts; two pages per group; each page/worker reused for 20 samples, then closed | Seeded shuffle independently each round | No | BS Run 12; Perm Run 10 |
| Closing control | BS/Perm Submit only; no warm Run | Three independent contexts/pages per Submit group; reused for 20 samples, then closed | Fixed `0.17.3, 0.17.1, 0.20.1` every round | Submit only | 0 |
| Reference re-record | BS/Perm Submit only; no warm Run | Two independent control contexts/pages per group; reused for 20 samples, then closed | `0.17.1,0.20.1`, then reversed every round | Yes | 19 per group |
| All-Python-warm | BS/Perm Run and Submit | Two pages for Run, three for Submit; reused for 20 samples, then closed | Live-control order followed by its reverse every round | Submit only | 19 per group |

Contexts persist across groups, but pages and their workers do not. The
three-version all-warm Submit order is
`0.17.1,0.17.3,0.20.1` then `0.20.1,0.17.3,0.17.1`; therefore the two controls
repeat at round boundaries while 0.17.3, in the middle, never does. That makes
the apparent release advantage in those cells a schedule artifact.

## Existing-sample evidence

Warm Run elapsed medians split cleanly on the immediately preceding version:

| Session/cell | Same version immediately before | Different version immediately before |
| --- | ---: | ---: |
| A/A BS | n=12, 491.50 ms | n=28, 299.05 ms |
| A/A Perm | n=10, 559.50 ms | n=30, 360.45 ms |
| All-warm BS | n=19, 475.70 ms | n=21, 289.90 ms |
| All-warm Perm | n=19, 550.60 ms | n=21, 366.30 ms |

This is not merely a first-position effect. In the shuffled A/A schedule, a
position-zero sample that switched versions was fast; only position-zero
samples that repeated the version were slow. It is also not a group-start
effect: in the all-warm session both round-one BS samples were 327.1/336.3 ms,
while later repeated-version samples clustered near 476 ms. The round-one Perm
samples were 451.8/442.5 ms, while later repeated-version samples clustered
near 551 ms.

The one-minute load does not distinguish the modes. In A/A its median was 1.87
for both repeated and switched samples (both ranged 1.73--1.97). In the
all-warm session the medians were 1.33 and 1.31 respectively (both ranged
0.52--1.89).

Two same-version 0.17.3 pairs show where the extra time lands:

| Cell/sample | Elapsed | Compile | Sum of reported case runs | Unattributed inside initial-execute | Runtime load |
| --- | ---: | ---: | ---: | ---: | ---: |
| BS round 2, repeated page | 496.9 | 186.3 | 75.0 | 235.6 | 0.1 |
| BS round 3, switched page | 301.8 | 194.8 | 76.1 | 30.9 | 0.0 |
| Perm round 2, repeated page | 563.8 | 182.8 | 127.6 | 253.4 | 0.0 |
| Perm round 3, switched page | 368.7 | 186.1 | 133.0 | 49.6 | 0.0 |

Pyodide initialization/package loading is outside the measured Run: the
group's first `setupWarm.loadTimeMs` is 267--290 ms, and the measured compiler
reports approximately zero runtime-load time in both modes. Compile and
reported case-run times are stable. The extra roughly 200 ms is inside the
runner's `initial-execute` phase but outside the compiler and per-case timing.
These release-policy sessions did not record worker-phase timestamps, so the
existing artifacts cannot distinguish worker queue drain, GC, or another
asynchronous page-local cleanup within that residual.

Submit shows the same effect. The fixed-order closing control has no repeated
boundary and all three versions agree closely: BS medians are 116.2--118.9 ms
and Perm medians are 132.35--133.35 ms. In the alternating reference re-record,
repeated-boundary samples are 319.6 ms versus 109.5 ms after a version switch
for BS, and 329.3 ms versus 124.6 ms for Perm.

## Hypothesis and measurement correction

The evidence supports incomplete page-local quiescence after a warm Python
execution. `bench.release()` awaits `host.disposeExecution`, but the next use
of the same page immediately absorbs about 200 ms that is not attributed to
runtime load, compilation, or case execution. Running the other version in
between supplies enough idle time. A shared-browser or host-load explanation
does not fit the exact same-page transition and equal-load evidence; the third
page changes which label receives the repeated-boundary penalty but is not
required to reproduce it.

The durable correction is an explicit host/runtime idle fence: disposal must
not resolve until the Python execution queue, observation worker, and cleanup
are quiescent. The measurement runner should await that fence before another
sample can use the page. It should not rely on an arbitrary sleep.

Until that fence exists, the deterministic measurement fallback is a fresh,
independent page per sample: open the version's page, complete `warmLanguage`,
measure exactly one warm operation, release, and close it. Continue alternating
which label runs first per round. This removes consecutive reuse without
assigning one label a fixed position.

The proving A/A is two labels pointing to the exact pinned 0.17.1 bytes, BS and
Perm warm Run, n=20, fresh warmed page per attempt, alternating order. Accept
the design only if label-to-label median and p90 are each within 5%, and the
position-zero versus position-one distributions are also within 5%. Record the
warm-load, compile, case-run and residual components so a remaining bimodality
cannot hide in the aggregate.
