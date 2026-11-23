# Harness 0.21 speed baseline

The browser entry uses lane AA's published-package alias approach from
`test/release-diff-0171` and lane V's browser timing boundary from
`bench/verdicts-first-timing`. Both releases load their own npm assets and production
dependencies. The scripts keep the private catalog and reference code on the build
host under `/root/ci/parity-app-data`. The output records only fixture hashes and
case IDs, package provenance, execution metadata and timings.

| App ref | Harness | Practice Run | Browser Submit | Lesson finish |
| --- | --- | --- | --- | --- |
| `083bf3f4a` | 0.17.1 | Interactive, all cases with trace for the selected case | Untraced | No last-step Run tests gate |
| `d0debe20a` | 0.20.1 | Same successful path | Untraced, stop at first runaway except Python | Calls Practice Run when runtime is ready and proceeds on a pass |

The browser Judge has no selected-step streaming endpoint on these releases. Its
initial response contains both the verdicts and the selected trace. When the
selected first case passes along with all the others, the drain starts the second
case immediately. The benchmark measures an immediate click that waits on that
first continuation. It cancels the trace session after the measured case. It
does not estimate warmed trace display from a later click, app paint time,
cloud verification, or the effect of a slower network.

The 4× CDP setting models a slower Chromium page and uses the conventional
Chromium trace budgets. A separate iOS/iPadOS heuristic in the app changes the
budgets on those devices. The benchmark has no iOS device measurements.

Use Node 22 and run browser work only on the build host through `ar-harness.sh`.
Start with a short smoke job. Its load and timings cannot count toward the baseline.

```sh
ar-harness.sh <worktree> speed-021-smoke bash benchmarks/speed-baseline-021/host-job.sh smoke smoke 212026 5
```

After coordinator approval, take the build host's exclusive lock for the long
job. The initial `true` releases the ordinary slot that `ar-harness.sh` consumes
before trying to acquire all of the slots. Everything after the no-op runs with
the exclusive lock. Use a separate suffix for each of `desktop-b`, `desktop-a`
and `phone`. Release the host between windows. Desktop uses 20 samples per cell
and 12 for Java. Phone uses 12 per cell and covers only the Run verdicts and
selected trace on warm and cold pages.

```sh
ar-harness.sh <worktree> speed-021-full "true && /root/ci/bin/heavy-exclusive env SPEED_EXCLUSIVE_WINDOW=1 bash benchmarks/speed-baseline-021/host-job.sh run desktop-b 212026 90"
```

The runner appends one JSON record per attempt, including discarded attempts.
It stops at its deadline or after it reaches the target. A group with too many
invalid attempts is left incomplete. Copy back `reports/speed-baseline-021/speed-<window>-metadata.json`
and `reports/speed-baseline-021/speed-<window>-samples.jsonl` with `scp`, then clean up the job.
Keep the results outside Git. The report script checks the schedule, counts,
load and timing values against the raw records. It exits nonzero for an incomplete
table.

```sh
node benchmarks/speed-baseline-021/report.mjs SPEED-BASELINE.md \
  speed-desktop-b-metadata.json speed-desktop-b-samples.jsonl \
  speed-desktop-a-metadata.json speed-desktop-a-samples.jsonl \
  speed-phone-metadata.json speed-phone-samples.jsonl
```
