# P0-F dry run and window hand-off

The coordinator recorded the M1 decision before sampling. The kernel owns
case start, finish and deadline as events, and the workers keep their batch
loops. Java's shipped non-isolated route produced zero admissible warm
pairs. The window runs M2 first, then collects informational M1 data for K0.

The round-three amendment supplies a C# batch verb and selects the shipped
C++ prepared batch verb. Both probes start from the published 0.21.0 archive.
The C# site replaces one served JavaScript worker, and its batch handler runs
the existing prepared-code path once per case on the retained runner. The
managed assemblies, runtime configuration and WASM come from the archive.
Each case uses the same collectible load-context boundary as the singleton
arm. In C# the paired difference measures dispatch and transport. The
scorer also reports median singleton time per case.

The C++ probe calls the installed release's prepared batch and singleton
methods on the same client and prepared handle. The runtime supplies a new
WASI instance per execution. The other languages use their installed
prepared providers. The dry-run log includes the observed worker commands
and worker IDs, plus the verdict for every case in both arms.

## Inputs

The package and catalog pins are in [inputs.mjs](inputs.mjs). The three
catalog cases are read in place on AgentRunner. File hashes match app commit
`e4eca52506e838dacdef28078c39f012a5825cd7`. Program hashes cover the UTF-8
solution text and input hashes cover UTF-8 `JSON.stringify(input)`.
Informational M1 uses the catalog's ten Binary Search cases in their
original order.

The optional dry-run configuration points to P0-C's staged `plan-022.mjs`.
The loader checks the plan SHA-256 before using `heavyFixture022`. That
function checks each fixture's hash. M2 passes the line limits registered
with the Python fixture.

## Dry run

Run from the AgentRunner clone of the lane bundle. Count busy Harness lanes
from the shared job log before queueing. The documented jobs log outside
the checkout. Use a fresh output directory.

```sh
probe_commit=$(git rev-parse HEAD)
short=$(git rev-parse --short=8 HEAD)
base=/root/ci/h022-p0f
out="$base/out-$short"
config="$base/dry-config.json"
HEAVY_JOB_LANE=h022-p0f HEAVY_JOB_CANDIDATE="$short" HEAVY_JOB_CELL=m1-m2-dry \
  HEAVY_JOB_INPUT_HASH="$probe_commit" \
  /root/ci/bin/heavy nice -n 10 ionice -c3 timeout --kill-after=15s 12m \
  node benchmarks/m1-m2-probes/probe.mjs dry "$out" "$config" \
  > "$base/logs/dry-$short.log" 2>&1
```

The dry job also stages the published assets outside the checkout. It writes
`dry-receipt.json` with the per-language results. The registered P0-C
inputs for the amended run are rig commit
`ff2733b4d0dac7390de2d01a5f6136c3735ea681` and plan SHA-256
`b574fdef14f735384db2cc49ea547a4bc38aa297c2af2c493ffdabc4788dc8ee`.
The lane-owned copy is
`/root/ci/h022-p0f/p0c-ff2733b4/g8-candidates/plan-022.mjs`.

| Language | Mutation verdicts, batch / singleton | Binary Search verdicts | Transport | P0-C heavy verdicts |
| --- | --- | --- | --- | --- |
| Python | Pass / pass | Both arms pass 10/10 | 1 batch request and 10 singleton requests on one worker | Pass / pass |
| JavaScript | Pass / pass | Both arms pass 10/10 | 1 batch request and 10 singleton requests on one SES lane | Pass / pass |
| TypeScript | Pass / pass | Both arms pass 10/10 | 1 batch request and 10 singleton requests on one SES lane | Pass / pass |
| Java | Pass / pass | Both arms pass 10/10 | Singleton replaced the warm worker, so the Binary Search pair is ineligible | Pass / pass, one case per arm |
| C# | Pass / pass | Both arms pass 10/10 | 1 probe batch request and 10 ordinary singleton requests on one runner | No batch verdict, singleton passes |
| C++ | Pass / pass | Both arms pass 10/10 | 1 shipped batch request and 10 singleton requests on the same client and worker | Pass / pass |

The Python probe retains the prepared worker only after a completed
algorithm-fast batch that the runtime says can keep its interpreter. The
singleton arm invokes that shipped batch verb with one case per message.
For JavaScript and TypeScript, the probe sends the shipped SES batch verb
directly to one prepared lane. The normal SES pool sends one case per
message even for a multi-case batch.

Java's non-isolated client closes the Worker session after each prepared
singleton. The canary verifies fresh statics, but the published desktop
route cannot produce the requested warm pair. C# passed the Binary Search
dry run. The registered C# heavy case selected the compatibility tier,
which cannot use the retained-runner batch.

C# dry-run worker SHA-256
`a74d1690f4a7d405fac367a7af5d88edc673149176b16102998c11a7fd1aa01d`
identifies the JavaScript overlay. Staging verifies the original served
worker before copying that single file. A byte comparison of both
`vendor/csharp` and `vendor/csharp-runner` trees matched the extracted
release assets. No managed build ran.

AgentRunner job `20261127T041232.185267688-3283895` ran these checks at
`94a37e11f9ccbea05f29b8342099b385475536e0`. It exited 1 because Java
failed the warm transport check. It still completed all six languages
and M2. The full log is `/root/ci/h022-p0f/logs/dry-94a37e11.log`; the
staged receipt is `/root/ci/h022-p0f/out-94a37e11/dry-receipt.json`.
The amended dry run at `feea9031`, job
`20261127T040307.068504857-3256185`, reproduced the same split.

M2 passed all 30 plain Judge evaluations. Each version and profile passed
the three catalog cases, the registered P0-C Python heavy case, and a
separate in-runtime `tracemalloc.is_tracing()` witness. Each witness
returned false. Every result included compile and case receipts and
returned no drawing.

The pre-amendment catalog
check ran as job `20261127T034003.348827710-3211392` at commit `4e749456`.
All 18 verdicts passed, including all six 0.17.1 case/profile combinations.
Every row contained compile and case receipts with no drawing. That job's
log is `/root/ci/h022-p0f/logs/m2-4e749456.log`.

## Coordinator's window

The coordinator names and opens the window after P0-C's green self-test
receipt exists. Run from the staged sampler checkout and reuse the browser
assets and dry-run receipt from that commit. The window
configuration uses the same `heavyPlan`, `heavySha256` and `rigCommit`
fields as the dry configuration. Add `selftestReceipt` with the absolute
path to P0-C's green receipt and `dryReceipt` with the absolute path to
`$out/dry-receipt.json`.

The following command is for the coordinator after the window is named.
It runs both phases in one invocation. The sampler checks the receipt's
P0-C commit and tarball hash against the selected plan and release. It also
checks the dry receipt against the staged assets, verifies the browser
inputs against the dry-run commit, and requires the recorded Chromium build.

```sh
base=/root/ci/h022-p0f
cd "$base/window-sampler"
out="$base/out-$(git rev-parse --short=8 HEAD)"
P0F_COORDINATOR_WINDOW=1 node benchmarks/m1-m2-probes/probe.mjs \
  verify-window "$out" "$base/window-config.json" &&
P0F_COORDINATOR_WINDOW=1 /root/ci/bin/heavy-exclusive \
  nice -n 10 ionice -c3 node benchmarks/m1-m2-probes/probe.mjs \
  window "$out" "$base/window-config.json"
```

| Order | Cells | Minimum for full coverage |
| --- | --- | --- |
| M2 first | Four cases at Chromium 1× desktop and 4× phone across the three versions | 480 admissible trials plus six discarded warm-ups |
| Informational M1 second | Binary Search N=10 for Python, JavaScript, TypeScript, C# and C++ | 3 discarded warm-up pairs and 20 admissible pairs per language, 115 pairs for full coverage |

M2 alternates version order within rounds and targets 20 admissible trials
per version and cell. Its allowance is up to 40 minutes. Informational M1
alternates which arm goes first and discards any in-flight pair at its
hard 20-minute cap. The load gate is the rig's one-minute load of at most
2.0 immediately before dispatch. Allow **50–60 minutes** of active window
time, based on 30–40 minutes for M2 and up to 20 minutes for informational M1.

Score after both phases and after the coordinator releases the window.
The scorer applies the signed M2 thresholds and prints informational M1
medians for cells with 20 admissible pairs.

```sh
node benchmarks/m1-m2-probes/score.mjs \
  "$out/samples.jsonl" "$out/M2-INFORMATIONAL-M1-RESULTS.md"
```

P0-F took no timing samples and did not open an exclusive window.
