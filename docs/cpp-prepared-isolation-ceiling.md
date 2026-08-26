# C++ prepared isolation ceiling

## Decision

C++ should not add an `algorithm-fast` shared-instance tier.

The existing prepared provider already applies the safe optimization that the
other compiled-language lanes are adding: it keeps the trusted compiler
service, learner Worker, and immutable compiled `WebAssembly.Module` alive for
the evaluation and sends the correctness vector through one Worker request,
while constructing a fresh WASI process, `WebAssembly.Instance`, linear memory,
Wasm globals, constructors, and in-memory filesystem for every case.

This is the right C++ isolation boundary. Retaining the outer runner avoids
compiler and Worker startup per case. Reusing the learner Wasm instance would
save only the remaining instantiation floor while making cases share C++
process state.

## Product contract

The browser Judge path keeps these guarantees:

- one compilation and one immutable module per evaluation;
- one TraceKernel Judge process and one retained C++ learner Worker;
- one Worker protocol request for an ordinary correctness case vector;
- fresh learner Wasm state and input hydration for every correctness case;
- each completed ordinary-batch case reports progress to the host, which
  rearms the configured default per-case watchdog without adding another
  request; a hung case therefore cannot borrow the rest of the vector's time
  allowance, already-completed results survive its timeout, and the losing
  protocol request is interrupted independently of worker-termination policy;
- every full case result crosses the Worker boundary once in that correlated
  progress stream; the final batch reply contains only count and timing
  metadata, avoiding duplicate structured-clone and console-output retention;
- an explicit per-case wall-clock limit retains the one-request-per-case path,
  because synchronous Wasm cannot be interrupted between cases from inside
  one Worker message;
- the selected trace case executes first, with all other correctness cases
  drained without recording;
- a timeout, abort, or Worker failure retires the complete prepared session;
- project compilation and execution remain on the general capability-bearing
  path.

The compiled module, not a request field or a caller-provided digest, is the
execution authority. The worker-owned prepared-program table binds the module,
source, mode, driver ABI, trace settings, and generated input mode under one
opaque program id. There is no caller-selectable fast tier to relabel.

## Why a shared-instance tier is unsafe

One Wasm invocation across multiple cases shares every process-scoped C++
surface, including:

- namespace, class, function-local, and template static storage;
- the heap allocator, leaked allocations, pointer identity, and memory contents;
- thread-local storage when a future toolchain enables threads;
- global constructors, `atexit` handlers, and static destructors;
- C and C++ random-number generators;
- locale, errno, iostream formatting flags, buffers, and stream state;
- `setjmp`/`longjmp` targets and exception/runtime bookkeeping;
- the invocation's WASI filesystem and descriptor table; and
- any future ambient host import added to the program ABI.

A source-text allowlist cannot soundly prove those surfaces absent in C++.
Macros, templates, inline variables, implicit library state, aliases, separate
translation units, and compiler-generated runtime calls all defeat a lexical
classifier. A compiler semantic profile could identify many direct uses, but
would still need a closed-world proof over linked libc and runtime state. Even
then, one non-terminating case cannot be externally retired at its individual
deadline without also destroying the shared invocation.

Fresh Wasm instances make those questions irrelevant: the attack surfaces may
exist within one case, but their state cannot cross into the next case.

## Browser measurement

`scripts/benchmark-cpp-prepared-isolation-tiers.ts` runs two boundaries in real
Chromium with the pinned TraceCC compiler and assets:

1. the product `fresh-instance` prepared provider; and
2. an intentionally unsafe ceiling program that changes the learner ABI so all
   logical cases execute inside one Wasm invocation.

It separately measures the full browser Judge path from algorithm-bundle
creation through compile, all-case comparison, and receipt.

On Chromium 145.0.7632.6 on the local M1 Pro Mac, five reversed-order samples
on 2026-08-26 produced:

| Boundary | 10 cases p50 | 100 cases p50 | 100 cases p95 |
|---|---:|---:|---:|
| Prepared, fresh Wasm instance per case | 3.79 ms | 41.55 ms | 59.63 ms |
| Unsafe, one shared Wasm invocation | 2.32 ms | 26.40 ms | 35.76 ms |
| Full browser Judge, compile through receipt | 287.65 ms | 331.63 ms | 382.35 ms |

The unsafe design saves about 15.1 ms at 100 cases. Even treating that direct
prepared-boundary delta as fully additive to the separately measured Judge
sample, the warm full-flow ceiling is only about 1.05x. Compilation and Judge
orchestration remain roughly 87% of the 100-case wall clock. The first cold
10-case sample was 1.49 seconds because toolchain promotion dominated; sharing
learner state cannot improve that cold path.

Absolute timings are machine-specific. The structural result is not: C++ has
already removed repeat compilation and repeat outer-runner construction from
the case loop, and the remaining isolation floor is small relative to the full
learner-visible flow.

The checked-in raw samples are in
`reports/cpp-prepared-isolation-ceiling-2026-08-26.json`.

## Correct next optimization

Future C++ performance work should target the compilation/readiness path rather
than weaken case isolation:

- measure cold, background-prewarmed, and promoted-first-click flows
  independently;
- ensure the existing bounded TraceCC asset prewarm actually completes during
  learner think time when the product predicts C++ is the next runtime;
- retain and reuse the trusted compiler service and PCH shards without moving
  network or CPU delay onto every compile action; and
- investigate compiler/profile or generated-driver cost only with full Judge
  measurements and raw samples.

Do not describe the unsafe ceiling as a product result. It deliberately changes
the learner ABI and shares state that the Judge contract requires to be fresh.

## Reproduction

```bash
TRACECODE_CPP_TIER_SAMPLES=5 \
  node --import tsx scripts/benchmark-cpp-prepared-isolation-tiers.ts
```

The script prints raw samples, p50/p95 summaries, browser version, and the exact
measurement boundaries. The ordinary browser batch gate remains:

```bash
TRACECODE_ALGORITHM_BATCH_LANGUAGES=cpp \
  pnpm exec tsx --tsconfig tsconfig.base.json \
  tests/test-browser-algorithm-batch.ts
```
