# JavaScript/TypeScript warm-retire and Judge isolation spike

Date: 2026-08-04

Baseline: `origin/main` at `c24bd633e8876112896b6e823dc3dd8adba063f3` (`0.16.0`)

Candidate branch: `agent/javascript-runtime-warm-retire`

Node: `25.9.0`; pnpm: `10.4.1`; Playwright: `1.58.2`

## Verdict

JavaScript and TypeScript already had the right top-level shape: one trusted,
long-lived coordinator owns TypeScript compilation and trace preparation, while
learner code runs in disposable executor Workers. The important defect was
below that boundary. Judge's prepared batch path sent every case to one
executor realm while advertising `fresh-case-state`. Globals were recreated,
but intrinsics, module state, and deferred jobs were shared.

The candidate removes multi-case execution from the worker protocol. Prepared
artifacts remain immutable coordinator output, but every code or trace case is
sent to a never-before-used executor and that Worker is terminated immediately.
Worker construction is prewarmed in bounded waves of eight; learner cases still
execute in order with `maxConcurrency: 1`. One clean standby remains after the
batch. `retire-only` no longer replenishes a standby.

This is the isolation-equivalent browser floor with today's APIs. None of the
tested engines exposes `ShadowRealm`, compiled `Function` objects cannot be
structured-cloned into another Worker, and descriptor restoration in a reused
realm cannot reliably revoke closures, weak collections, module caches,
microtasks, or provider-owned state.

## Correctness and isolation

The actual public Judge route (`createBrowserJudgeHost` plus
`evaluateAlgorithm`) was tested, not only the lower-level runtime client.

The probe mutates `Array.prototype` in case 1 and expects case 2 to observe no
mutation:

| Engine | Main JS/TS | Candidate JS/TS |
| --- | ---: | ---: |
| Chromium 145.0.7632.6 | 1/2, 1/2 | 2/2, 2/2 |
| Firefox 146.0.1 | 1/2, 1/2 | 2/2, 2/2 |
| WebKit 26.0 | 1/2, 1/2 | 2/2, 2/2 |

Code and eager trace batches pass the same intrinsic/global isolation checks.
A case that exceeds its 50 ms wall-clock limit is terminated, and the following
case completes with the exact expected value. Language reset invalidates stale
prepared artifacts and retires the complete shared JS/TS generation. Full host
disposal is terminal and cannot silently respawn workers.

Project execution was inspected and retained as a separate topology. It already
uses a disposable command Worker and clean standby by default; reusable project
workers require the explicit trusted mode. No Project authority boundary was
weakened or merged into the algorithm runner.

## User-facing timing

Four-sample cross-browser sweep, milliseconds from bundle construction through
the public Judge receipt. Tiny-case values are intentionally a Worker-startup
stress test.

| Engine / route | 1 case | 15 code | 15 trace | 50 code |
| --- | ---: | ---: | ---: | ---: |
| Chromium main, unsafe batch | 16.60 | 17.69 | 18.28 | 16.74 |
| Chromium candidate | 16.29 | 106.24 | 122.46 | 345.90 |
| Firefox main, unsafe batch | 29.92 | 28.94 | 28.76 | 27.96 |
| Firefox candidate | 30.40 | 172.20 | 205.52 | 532.78 |
| WebKit main, unsafe batch | 20.64 | 20.22 | 23.42 | 19.56 |
| WebKit candidate | 19.62 | 118.80 | 153.84 | 386.20 |

Single-case latency is unchanged within noise. The old batch number is not a
valid isolation-equivalent baseline: it is fast because all cases share one
realm. Serial Worker creation was rejected (about 275 ms for 15 cases and
852 ms for 50 in Chromium). Concurrent construction is substantially faster.

Chromium pool sweep for 15 code cases:

| Wave size | Median | Peak live Workers |
| ---: | ---: | ---: |
| 2 | 171.08 ms | 4 |
| 4 | 129.93 ms | 6 |
| 8 | 104.05 ms | 10 |
| 16 | 88.75 ms | 18 |
| 32 | 97.55 ms | 34 |

Eight is the selected speed-memory knee. Sixteen saves about 15 ms for 15
trivial cases but adds eight more simultaneously live executor realms.

## Memory and artifacts

Chromium process-tree RSS was sampled every 20 ms in isolated one-batch
campaigns. The sampler perturbs timing, so these runs are used only for memory.
Across three 8-runner repetitions, candidate-minus-main peak RSS was
60.9-62.4 MB (median 62.1 MB). A final raw campaign measured 64.1 MB. Both
variants settle to two live Workers before host disposal and zero afterward.
Chromium retains approximately 59-63 MB of allocator/process RSS for at least
the first 50 ms after retiring the batch Workers; this is not live Worker state,
but it is real page-process pressure until the engine reclaims it.

For comparison, a 16-runner wave added 106.8-112.7 MB peak RSS (median
107.5 MB). The main-page `performance.memory` value does not include dedicated
Worker heaps and must not be used as the Python/JavaScript memory number.

Current candidate algorithm worker:

- Raw: 257,604 bytes
- gzip -9: 43,536 bytes
- Brotli -q 11: 35,893 bytes
- SHA-256: `9fba4acac1f0c7d2a2909e9e15dc15d2c438a671aa93734a1b8a708ce5b02c51`

The worker protocol deletion removes its unsafe batch materializers/handlers,
unused status endpoint, dead trace helpers, and the duplicate learner-source
field from prepared artifacts. There is no new runtime download.

## Reproduction

```sh
pnpm test:js-runtime
pnpm test:runtime-execution-judge
pnpm test:judge
pnpm typecheck

JAVASCRIPT_JUDGE_BENCH_SAMPLES=4 \
JAVASCRIPT_JUDGE_BENCH_ENGINES=chromium,firefox,webkit \
pnpm exec tsx --tsconfig tsconfig.base.json \
  scripts/benchmark-browser-javascript-judge.ts

JAVASCRIPT_JUDGE_BENCH_MEMORY_ONLY=1 \
JAVASCRIPT_JUDGE_BENCH_SAMPLES=1 \
JAVASCRIPT_JUDGE_BENCH_ENGINES=chromium \
JAVASCRIPT_JUDGE_BENCH_REPORT=reports/javascript-judge-warm-retire-memory-2026-08-04.json \
pnpm exec tsx --tsconfig tsconfig.base.json \
  scripts/benchmark-browser-javascript-judge.ts
```

Raw timing and memory reports:

- `reports/javascript-judge-warm-retire-2026-08-04.json`
- `reports/javascript-judge-warm-retire-memory-2026-08-04.json`

`test:prepared-provider-release-gate` currently has one unrelated baseline
failure: its Node-only default-host fixture does not provide a browser engine,
while the Python 0.16 provider now rejects the `unknown` engine. The JS/TS
prepared-provider and Judge tests in that command pass.

## Next production optimization

Do not retain a permanent eight-Worker standby fleet; it converts batch latency
into idle memory and conflicts with the one-clean-standby policy. The next safe
optimization is a small, bounded prepared-artifact cache in the trusted
coordinator, keyed by source, language, execution style, function selector, and
trace options. It can improve edited/repeated submissions without sharing any
learner realm. It will not remove the browser's fresh-Worker floor for strict
per-case isolation.
