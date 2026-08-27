# C++ prepared isolation boundary

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

Do not describe an unsafe shared-instance experiment as a product result. It
changes the learner ABI and shares state that the Judge contract requires to be
fresh.
