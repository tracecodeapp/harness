# P0-F dry run and window hand-off

**Window blocked.** The published 0.21.0 C# prepared provider has no
single-dispatch batch path on its worker. Its host-side batch loop sends one
prepared request per case, the same transport shape as the singleton arm.
The warm runner does create a collectible assembly load context per case.
That boundary establishes fresh state, while the prepared worker protocol
still lacks the other arm of M1.

Evidence from the exact published archive, SHA-256
`935c61d9f3f961056216a88922af31fa03279b58beefe2a8ff5d829563b9da62`:

- `package/dist/judge.js:6044` iterates the batch on the host. At line 6180
  the prepared provider calls that loop with `runner.executePreparedCode`.
- `package/workers/csharp/csharp-worker.js:4812` describes the prepared
  batch as a host-side sequence of single-case commands. Each request attests
  case index zero relative to that request. The other verb,
  `execute-code-batch`, takes a source program, through a different path.
- The managed algorithm runner's `InvokeDriver` groups construction, load,
  driver execution and unload in one call. The release receipts have no
  field for the load-context swap alone. The aggregate time cannot identify
  this cost.

C++ has a similar provider distinction. The prepared provider's
`executeCodeCases` calls `client.executePreparedCode` per case even though
the lower-level client also implements a batch verb.

The signed rule handles a language failing the fresh-state canary. Here the
C# batch arm itself is missing, so there is no canary failure or M1 verdict
to report. A provider change or an explicitly re-signed probe boundary is
needed before the coordinator can schedule this window.

## Completed M2 dry run

AgentRunner job `20261127T034003.348827710-3211392` ended with exit code 0.
The checkout was `4e7494567c64dbfae74718b43cfc7dda0cd315c8`. Its log is
`/root/ci/h022-p0f/logs/m2-4e749456.log`.

```sh
cd /root/ci/h022-p0f/dry-4e749456
HEAVY_JOB_LANE=h022-p0f HEAVY_JOB_CANDIDATE=4e749456 HEAVY_JOB_CELL=m2-dry \
  HEAVY_JOB_INPUT_HASH=4e7494567c64dbfae74718b43cfc7dda0cd315c8 \
  /root/ci/bin/heavy nice -n 10 ionice -c3 timeout --kill-after=15s 12m \
  node benchmarks/m1-m2-probes/probe.mjs m2-dry /root/ci/h022-p0f/out-4e749456
```

All 18 Python verdicts passed. Each of the three releases passed each of the
three catalog cases in non-isolated Chromium 145.0.7632.6 at 1× desktop and
4× phone CPU throttling. Every evaluation supplied a compile receipt and
a case receipt, with no drawing. The dry-run output records receipt
presence and verdicts. It takes no elapsed-time samples.

The command used the published tarball bytes and reused the rig's installed
production dependencies for the historical releases. It used the existing
exact-release consumer's pnpm dependencies for 0.21.0. The archived dry-run
output directory already exists. Use a fresh output path and check the
Harness lane count before any rerun.

Catalog files were read in place. The file hashes match
`data/problems/{n-queens,open-the-lock}.json` at app commit
`e4eca52506e838dacdef28078c39f012a5825cd7`. The release archive hashes,
catalog paths, case IDs and file, program and input SHA-256s are pinned in
[`inputs.mjs`](inputs.mjs). Program hashes cover the UTF-8 solution text
and input hashes cover UTF-8 `JSON.stringify(input)`.

The dry run omits the memory limit and confirms the plain verdict path and
available timing fields. An in-runtime tracemalloc witness remains pending.
P0-C's Python heavy fixture also remains pending.

## Window requirements once unblocked

The coordinator opens the window after P0-C's self-test is green. All sampling
runs in one window, with scoring offline afterward. The following counts are
the signed minimums. There is no executable sampling command on this branch.

| Order | Cells | Required runs |
| --- | --- | --- |
| M1 first | Binary Search, N = 10, all six languages | 3 discarded warm-up pairs and 20 admissible pairs per language, 138 pairs minimum |
| M1 as time allows | Binary Search N = 100, P0-C heavy N = 10 and N = 100, all six languages | 23 pairs minimum per cell including warm-ups, up to 414 more pairs for full coverage |
| M2 second | Four cases on desktop and phone, across 0.21.0, 0.20.1 and 0.17.1 | 20 admissible trials per version for each of eight cells, 480 total, plus one discarded warm-up run per version and profile |

Alternate the two M1 arms on every pair. Stop M1 at 45 minutes, discarding
any in-flight pair. M2 alternates the version order within rounds. Both
measurements apply the rig's 1-minute load cutoff of 2.0 and discard invalid
or timed-out runs under the signed rules. The existing estimate is 75–85
minutes for the active window at the 45-minute M1 cap and 30–40 minutes for
M2, subject to the load gate. This is a planning estimate only.

No measurement window, timing samples, Boat runs, or M1 mutation canaries
were executed, and no results decision was produced.
