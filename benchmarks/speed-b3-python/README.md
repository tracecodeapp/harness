# Python 0.21 joined-response qualification

Use only the exclusive Linux build-host window. The runner extends the frozen
`test/speed-baseline-021` runner at `4d21ce46`, verifies its fixtures and
installation locks, and retains its same-origin Chromium 145 settings,
workload, public API journeys, load threshold, deadlines and sample targets.
The two phone policies alternate within each fixture and page-state group.
Two endpoints measured from the joined public response should have the same
duration. A refusal never provides a trace sample.

Prepare the concurrent candidate from its pinned release-gate tarball. Prepare
the sequential control in a disposable checkout of the same candidate:

```sh
node benchmarks/speed-b3-python/sequential-overlay.mjs <checkout> <full-candidate-sha>
```

Build and pack the control in that checkout. The overlay limits the control
to a successful stopping batch on the fast tier. It transfers the warmed
worker after the batch reply, then prepares and executes the separately
instrumented code in the observer's compatibility scope. The ordinary
case globals and observer globals are distinct. The control is specific to
a benchmark page with one evaluation at a time. Keep its diff and tarball
digest with the timing artifacts.

Stage `v0.17.1` and `v0.20.1` using the baseline `host-job.sh` installation
steps and their committed locks. Stage `vconcurrent` and `vsequential` with
the same directory layout and the candidate's frozen production lock, under
the same dependency constraints. Each directory contains the original
`tracecode-harness-<packageVersion>.tgz`, the extracted `package` with the
production dependency lock and install, `site/workers` from that package's
`sync-assets` command, and its `npm ls --omit=dev --all --json` receipt
`dependencies.json`. Use an independent JSON manifest of candidate
provenance. Each policy entry specifies `commit`, `packageVersion`,
`tarballSha256`, `dependencyLockSha256`, and `dependenciesSha256`. Both
candidate entries must identify the same source commit.

Use a fresh output directory for each window and keep the candidate manifest,
metadata, raw samples and reports together.

```sh
SPEED_EXCLUSIVE_WINDOW=1 node benchmarks/speed-b3-python/run.mjs \
  <frozen-baseline-directory> <staged-output> phone <candidate-manifest>
SPEED_EXCLUSIVE_WINDOW=1 node benchmarks/speed-b3-python/run.mjs \
  <frozen-baseline-directory> <staged-output> desktop-b <candidate-manifest>
node benchmarks/speed-b3-python/report.mjs \
  <metadata.json> <samples.jsonl> concurrent
node benchmarks/speed-b3-python/report.mjs \
  <phone-metadata.json> <phone-samples.jsonl> sequential
```

The worker journal records actual worker IDs, admissions and replies. Review
worker overlap and phase durations from the ordinary and observer records as
well as the latency report. The coordinator runs the other-language spot check
and applies the release decision for the full matrix separately.
