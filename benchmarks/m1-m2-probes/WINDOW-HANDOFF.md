# P0-F dry run and window hand-off

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
Binary Search uses the catalog's ten cases in their original order. N=100
repeats those ten cases ten times. Each heavy M1 cell repeats the
registered P0-C case N times.

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
route cannot produce the requested warm pair. The window records Java as
ineligible. C# remains eligible for the deciding Binary Search N=10 cell.
The registered C# heavy case selects the compatibility tier and cannot use
the retained-runner batch. The C# N=100 singleton cell is also unavailable
because the published runner rotates after at most 64 cases.

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
receipt exists. Use the dry output made by the sampling commit. The window
configuration uses the same `heavyPlan`, `heavySha256` and `rigCommit`
fields as the dry configuration. Add `selftestReceipt` with the absolute
path to P0-C's green receipt and `dryReceipt` with the absolute path to
`$out/dry-receipt.json`.

The following command is for the coordinator after the window is named.
It runs both phases in one invocation. The sampler checks the receipt's
P0-C commit and tarball hash against the selected plan and release. It also
checks the dry receipt and requires the recorded Chromium build.

```sh
base=/root/ci/h022-p0f
cd "$base/dry-94a37e11"
out="$base/out-94a37e11"
# Set this to P0-C's actual green receipt for the rig commit in dry-config.json.
test -f "$selftest_receipt" &&
jq --arg selftestReceipt "$selftest_receipt" --arg dryReceipt "$out/dry-receipt.json" \
  '. + {$selftestReceipt, $dryReceipt}' "$base/dry-config.json" > "$base/window-config.json" &&
P0F_COORDINATOR_WINDOW=1 node benchmarks/m1-m2-probes/probe.mjs \
  verify-window "$out" "$base/window-config.json" &&
P0F_COORDINATOR_WINDOW=1 /root/ci/bin/heavy-exclusive \
  nice -n 10 ionice -c3 node benchmarks/m1-m2-probes/probe.mjs \
  window "$out" "$base/window-config.json"
```

| Order | Cells | Minimum for full coverage |
| --- | --- | --- |
| M1 first | Binary Search N=10, all six languages | 3 discarded warm-up pairs and 20 admissible pairs per language, 138 pairs |
| M1 as time allows | Binary Search N=100, P0-C heavy N=10 and N=100 | 23 pairs per language and cell, another 414 pairs |
| M2 second | Four cases at Chromium 1× desktop and 4× phone across the three versions | 480 admissible trials plus six discarded warm-ups |

M1 alternates which arm goes first. Its timer starts at the beginning of
M1 and has a hard 45-minute cap, which discards the in-flight pair. M2
alternates version order within rounds and targets 20 admissible trials per
version and cell. The load gate is the rig's one-minute load of at most 2.0
immediately before dispatch. M2 has up to 40 minutes. Plan for 75–85 minutes
of active window time with M1 at the cap. Load exclusions and unfinished M1
supplementary cells may leave gaps.

The optional host controls record a null-payload worker echo and host timer
arm/cancel after the deciding M1 cells, if time remains. A direct reset-only cost is
unavailable in the published receipts. The managed C# call contains both the
load-context swap and learner execution. The sampler retains combined setup
fields where the release exposes them.

Score only after both phases have finished and the coordinator releases the
window. The scorer reads the append-only attempt journal. Its decision uses
the signed thresholds.

```sh
node benchmarks/m1-m2-probes/score.mjs "$out/samples.jsonl" "$out/M1-M2-RESULTS.md"
```

P0-F took no timing samples and did not open an exclusive window.
