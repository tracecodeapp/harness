# S(C++) candidate procedure

Apply [cpp-candidate.patch](cpp-candidate.patch) in the speed runner checkout at
`4d21ce46`. This reuses the frozen fixture digests, Practice Run and Submit
policies, page/cache lifecycle, immediate second-case click and load cutoff.
Use same-origin, non-isolated Chromium 145 on the baseline host.

After the coordinator installs the chosen C++ product registration, pack that
commit and verify its installed worker asset lock. Prepare an ordinary baseline
runner package directory with `package/`, `site/workers/`, the actual tarball
and `dependencies.json` from `npm ls --omit=dev --all --json`. Keep the
candidate's production lock and tree receipt. Candidate JSON names `root`,
`head`, `packageVersion`, `tarball`, `tarballSha256`,
`dependencyLockSha256`, `dependenciesSha256` and `policy` (concurrent or
sequential). The hashes pin the packed build and installation. Generate them
at packaging time.

Run each row below in its own coordinator-approved exclusive window. Use the
baseline host wrapper and lock as documented in the baseline README. Invoke
the runner with this command inside the exclusive window.

```sh
SPEED_EXCLUSIVE_WINDOW=1 SPEED_CPP_CANDIDATE=/path/to/candidate.json \
  SPEED_CPP_TIER=cpp node benchmarks/speed-baseline-021/run.mjs \
  /path/to/output run desktop-b 212026 90
```

| Window | Tier | Cells |
| --- | --- | --- |
| desktop-b | cpp | Binary Search and Permutations in warm, cold and switched states. Run verdicts, selected trace, second case and Submit, plus warm Binary Search lesson finish. |
| phone | cpp | Both fixtures, warm and cold at 4×. Run verdicts and selected trace. |
| desktop-a | spot | Every other language on warm Binary Search. Joined Run and Submit. |

Before phone qualification, compare coordinator-supplied concurrent and
ordinary-first candidate builds on the four phone groups. Alternate the
policies under the same conditions. Retain the actual worker IDs, scheduling
and phase receipts so a policy name alone cannot pass as evidence of separate
capacity or clean reuse. Compare each policy with the frozen phone cells, then
use the chosen registration for the qualification windows. If the
registration is still open, the procedure cannot establish installed drawing
or drawing latency coverage. A refusal can supply the joined verdict latency
when ordinary correctness passed. It leaves the drawing cell without a sample.

```sh
node benchmarks/speed-baseline-021/cpp-qualify.mjs \
  baseline-desktop-a-metadata.json,baseline-desktop-a-samples.jsonl,baseline-desktop-b-metadata.json,baseline-desktop-b-samples.jsonl,baseline-phone-metadata.json,baseline-phone-samples.jsonl \
  candidate-desktop-a-metadata.json,candidate-desktop-a-samples.jsonl,candidate-desktop-b-metadata.json,candidate-desktop-b-samples.jsonl,candidate-phone-metadata.json,candidate-phone-samples.jsonl
```

The checker reports all 33 S(C++) cells and 10 spot cells. The better
available median and p90 are picked independently for each cell. The lesson
uses 0.20.1. Any spot excursion over 5% median or 10% p90 requires the full
matrix before landing. A named exception requires owner approval separately.
