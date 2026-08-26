# C# algorithm-fast batches

Date: 2026-08-26

## Product contract

A browser Judge correctness run compiles the learner source once, then executes
the full case batch before returning a verdict. The compiler selects one runner
tier before any learner code executes:

- `algorithm-fast`: a bounded sequence of disposable outer runners, with a
  fresh collectible `AssemblyLoadContext` and learner assembly for every case;
- `compatibility`: the existing disposable outer runner per case.

There is no retry or tier change after learner execution begins. Cancellation,
a client deadline, program disposal, or provider reset still terminates the
owned outer worker. A retained lease ends after 64 cases or once its reported
managed heap reaches 64 MiB, whichever happens first; the next case continues
transparently in a fresh runner.

A fresh load context makes learner-defined statics, generated driver statics,
`Solution` instances, inputs, output buffers, and trace state case-local. The
runner resolves framework and host dependencies only from assemblies already
available to the default runtime context; learner assemblies cannot add a new
probing path or dependency surface.

That isolation roots the trimmed `System.Runtime.Loader` module. The browser
wire gate therefore carries an explicit 8 KiB allowance above its original
4 MiB ceiling; the measured runner is 4,200,620 bytes, 7,631 bytes above the
pre-change 4,192,989-byte baseline and still 1,876 bytes below the ratchet.

## Compiler-owned admission

The compiler's Roslyn semantic model is the source of truth for admission. It
fails closed to compatibility for code that uses:

- filesystem, process, environment, console, network, reflection, loader,
  interop, security, thread, timer, shared-pool, or runtime-host APIs;
- managed-memory pinning, which otherwise leaks process-scoped GC handles when
  a learner drops the returned handle without disposing it;
- unsafe, external, async, generator, lock, pointer, stack-allocation,
  destructor, or top-level-statement constructs;
- writes, event subscription, ref/out aliases, or deconstruction targets that
  reach external static framework state;
- runtime type gateways (`typeof`, `object.GetType`, delegate/exception
  reflection), string interning, delegate dynamic invocation, blocking
  concurrent collections, PLINQ, or async LINQ; or
- any external non-`System` API not declared in the original learner source.

Source provenance, rather than assembly identity, is the ownership boundary.
Generated judge helpers can share the emitted learner assembly for compatibility
contracts, but that does not make them learner-owned or admissible in the fast
tier.

Dynamic dispatch remains rejected by the existing prepared-Judge compiler
policy before runner selection; it never reaches either execution tier.

The admitted framework surface is deliberately algorithmic: primitive values,
arrays and spans, tuples, math and numerics, strings and builders, ordinary
collections, synchronous LINQ, and regular expressions. Common collection
imports and types remain supported. A valid program outside this subset is not
rejected; it keeps the compatibility runner.

The harness-owned global `ListNode` and `TreeNode` definitions are trusted
judge support, not ambient framework APIs. Their contracts still use the
compatibility tier because the current direct wire represents only flattened
lists and level-order trees; it cannot preserve arbitrary cycles, aliases, or
shared topology. The compiler gate names that topology limitation explicitly
instead of misclassifying the support types. Moving these contracts to
`algorithm-fast` requires a graph-preserving wire codec first.

The semantic profile is paired with the managed load-context boundary. Static
analysis selects the optimization, while the fresh assembly context is what
actually prevents learner state from crossing cases.

The compiler also embeds the artifact key and selected runner tier into the
emitted assembly. The managed runner verifies that exact binding before it
invokes the driver, so a compatibility artifact cannot enter the retained path
merely because its caller relabeled the descriptor as `algorithm-fast`.

## Lifecycle

The TypeScript runtime client retains outer runners only for a
compiler-admitted algorithm batch and invokes each lease sequentially. Mono/Wasm
does not promptly reclaim unloaded collectible contexts, so the client rotates
the lease after 64 cases or 64 MiB of reported managed heap. The managed
execution core still gives every case the same semantic boundary:

1. creates a named collectible load context;
2. loads the immutable learner assembly from a byte stream;
3. resolves and invokes the generated driver;
4. returns only serialized output bytes; and
5. unloads the context in a `finally` block.

The outer-worker cap is the physical reclamation boundary; collectible contexts
remain the per-case state boundary.

Compatibility batches continue through the existing bounded fresh-worker pool.
Project and terminal execution are unchanged.

## Browser Judge measurements

`pnpm bench:csharp-isolation-ceiling` uses the real
`createBrowserJudgeHost` path, Chromium 145, the C# Contains Duplicate
reference solution, all-cases-pass policy, and 21,950 input integers in the
100-case corpus. It alternates unique and late-duplicate inputs so a constant
answer cannot pass. Language warmup is excluded from the measured
bundle-to-receipt interval.

| Browser Judge path | 10 cases | 100 cases |
| --- | ---: | ---: |
| Fresh-worker compatibility, three-sample p50 | 1,549 ms | 9,198 ms |
| Fresh-worker compatibility, three-sample p95 | 1,589 ms | 9,416 ms |
| Capability-safe algorithm-fast, three-sample p50 | 480 ms | 867 ms |
| Capability-safe algorithm-fast, three-sample p95 | 505 ms | 889 ms |

The capability-safe 100-case path is about 10.6 times faster at the median and
remains below one second at p95. Both paths compile once through the same
public Judge boundary. Compatibility reuses the warmed standby for its first
case and then creates 99 fresh outer workers, with at most three simultaneously
active after the compiler and standby capacities are excluded. Algorithm-fast
uses bounded retained-runner chunks and creates a fresh collectible load
context for all 100 cases.

A separate benchmark-only unsafe prototype cached the learner assembly and
method, sharing learner statics across cases. It measured 640 ms at the
100-case median before the physical-memory bound was added. The current safe
path pays roughly 227 ms more at the median to replace the outer worker once;
that replacement is what reclaims Mono/Wasm contexts that `Unload()` alone does
not promptly collect. The large gain over compatibility still comes from
removing repeated outer runtime, filesystem, and environment initialization;
fresh learner load contexts remain the semantic boundary inside each bounded
lease.

## Required evidence

The browser compiler/runner boundary gate proves:

- two calls in one outer runner each observe learner static state at its initial
  value;
- a 100-case allocation stress run rotates the outer worker before either 64
  cases or 64 MiB of managed heap can accumulate on one lease;
- a thrown line limit and an ordinary learner exception each leave the same
  outer runner clean for a successful later case;
- filesystem, environment, threading, shared-pool, memory-pinning,
  host-runtime, runtime-type, and blocking-collection references fail closed to
  compatibility, while dynamic dispatch remains rejected before tier selection;
- trusted `ListNode` and `TreeNode` contracts reach the explicit
  reference-topology compatibility gate rather than ambient-API rejection;
- compiler-injected compatibility helpers do not inherit learner-source
  provenance even when they share the emitted assembly;
- ordinary algorithm and collection code remains algorithm-fast;
- compiler artifacts execute in the compiler-free runner;
- reflective/tampered artifacts and compatibility-artifact relabeling remain
  rejected;
- code, trace selection, limits, structured inputs, and void-output semantics
  retain their existing behavior.

The prepared-provider tests separately prove one outer runner for a small
admitted batch, exact rotation at 64 cases, sequential case order, exact
release, cancellation checks, and unchanged fresh-worker ownership for
compatibility programs.
