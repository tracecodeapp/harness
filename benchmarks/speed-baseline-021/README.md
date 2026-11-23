# Harness 0.21 speed baseline

The browser entry uses lane AA's published-package alias approach from
`test/release-diff-0171` and lane V's browser timing boundary from
`bench/verdicts-first-timing`. Both releases load their own npm assets and production
dependencies. The scripts keep the private catalog and reference code on the build
host under `/root/ci/parity-app-data`. The output records only fixture hashes and
case IDs, package provenance, execution metadata and timings.

| App ref | Harness | Practice Run | Browser Submit | Lesson finish |
| --- | --- | --- | --- | --- |
| `083bf3f4a` | 0.17.1 | Interactive, all cases with trace for the selected case | Untraced, with a complexity fact for Binary Search | No last-step Run tests gate |
| `d0debe20a` | 0.20.1 | Same successful path | Untraced case-only policy, stop at first runaway except Python | Calls Practice Run when runtime is ready and proceeds on a pass |

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

The host installs each published tarball's production dependencies with
`npm ci` and the committed lock under `dependency-locks/`. The runner checks
the installed lock and the SHA-256 of the full `npm ls --omit=dev --all --json`
receipt before any browser timings. The two current locks reproduce the Desktop
A trees. A later candidate, including 0.21, needs its own committed lock and tree
digest before it can run, with compatible shared dependencies held at these
versions.

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

With coordinator approval, repeat both Desktop A Java switched Run groups in
their own exclusive window. The selector keeps the same fixtures, version
interleaving, sample targets and load cutoff. It leaves ordinary runs unchanged
when unset. The top-up metadata records the selector and runner commit.

```sh
ar-harness.sh <worktree> speed-021-topup "true && /root/ci/bin/heavy-exclusive env SPEED_EXCLUSIVE_WINDOW=1 SPEED_GROUP_SELECTOR=java-switched-run bash benchmarks/speed-baseline-021/host-job.sh run desktop-a 212026 25"
```

Copy the top-up's Desktop A files under distinct local names. Keep both raw
pairs. For the validator input, replace the two original groups in their entirety
with the top-up records, remapping group indices by the schedule entries. Verify
that the package, fixture, browser and host provenance matches before combining.

## S(Java) candidate

Stage the packed candidate with the Java receipt registration active. Pass its
source commit and independently recorded tarball SHA-256. Staging uses the
frozen 0.20.1 production dependency tree and records the installed Judge and
Java worker digests. It fails before any sampling if the tree differs.

```sh
node benchmarks/speed-baseline-021/stage-java-candidate.mjs <tarball> <sha256> <source-commit>
```

The coordinator runs each command in its own quiet host window with
`SPEED_EXCLUSIVE_WINDOW=1` under `heavy-exclusive`. Use the same staged package
for all three runs and preserve the raw JSONL, including discarded attempts.

```sh
SPEED_JAVA_SCOPE=desktop bash benchmarks/speed-baseline-021/host-job.sh run desktop-a 212026 90
SPEED_JAVA_SCOPE=phone bash benchmarks/speed-baseline-021/host-job.sh run phone 212026 90
SPEED_JAVA_SCOPE=spot bash benchmarks/speed-baseline-021/host-job.sh run desktop-a 212026 90
node benchmarks/speed-baseline-021/score-java-candidate.mjs reports/speed-baseline-021 <frozen-baseline-reports>
```

Use the archived Desktop A pair with the switched Java top-up. The scorer
checks the 25 desktop Java endpoints, eight 4× Java endpoints, and ten spot
endpoints. It compares joined public Run latency and immediate continuation
under both app policies against the frozen distributions and prints the C#
Submit advisory. The lesson comparison uses the main policy. An
excursion in the spot comparison requires the full matrix. The Java sample
also includes role-tagged worker init, preparation, enqueue and execution
timings, JVM starts, restores, the worker-reply-to-public-response interval,
and the immediate click latency.
