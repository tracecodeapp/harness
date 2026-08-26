# C# algorithm-fast batches

Date: 2026-08-26

## Product contract

A browser Judge correctness run compiles the learner source once, then executes
the full case batch before returning a verdict. The compiler selects one runner
tier before any learner code executes:

- `algorithm-fast`: one disposable outer runner for the batch, with a fresh
  collectible `AssemblyLoadContext` and fresh learner assembly for every case;
- `compatibility`: the existing disposable outer runner per case.

There is no retry or tier change after learner execution begins. Cancellation,
a client deadline, program disposal, or provider reset still terminates the
owned outer worker.

A fresh load context makes learner-defined statics, generated driver statics,
`Solution` instances, inputs, output buffers, and trace state case-local. The
runner resolves framework and host dependencies only from assemblies already
owned by the default runtime context; learner assemblies cannot add a new
dependency surface.

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
- any external non-`System` API not owned by the learner assembly.

Dynamic dispatch remains rejected by the existing prepared-Judge compiler
policy before runner selection; it never reaches either execution tier.

The admitted framework surface is deliberately algorithmic: primitive values,
arrays and spans, tuples, math and numerics, strings and builders, ordinary
collections, synchronous LINQ, and regular expressions. Common collection
imports and types remain supported. A valid program outside this subset is not
rejected; it keeps the compatibility runner.

The semantic profile is paired with the managed load-context boundary. Static
analysis selects the optimization, while the fresh assembly context is what
actually prevents learner state from crossing cases.

The compiler also embeds the artifact key and selected runner tier into the
emitted assembly. The managed runner verifies that exact binding before it
invokes the driver, so a compatibility artifact cannot enter the retained path
merely because its caller relabeled the descriptor as `algorithm-fast`.

## Lifecycle

The TypeScript runtime client retains one outer runner only for a
compiler-admitted algorithm batch and invokes it sequentially. The managed
execution core then:

1. creates a named collectible load context;
2. loads the immutable learner assembly from a byte stream;
3. resolves and invokes the generated driver;
4. returns only serialized output bytes; and
5. unloads the context in a `finally` block.

Compatibility batches continue through the existing bounded fresh-worker pool.
Project and terminal execution are unchanged.

## Browser Judge measurements

The benchmark uses the real `createBrowserJudgeHost` path, Chromium 145, the
C# Contains Duplicate reference solution, all-cases-pass policy, and the same
21,925 input integers used for the proposed 100-case corpus. Language warmup is
excluded from the measured bundle-to-receipt interval.

| Browser Judge path | 10 cases | 100 cases |
| --- | ---: | ---: |
| 0.16.8 compatibility baseline, one sample | 1,142 ms | 5,996 ms |
| Deliberately unsafe one-call ceiling, one sample | 1,610 ms | 1,581 ms |
| Capability-safe algorithm-fast candidate, three-sample p50 | 469 ms | 615 ms |
| Capability-safe algorithm-fast candidate, three-sample p95 | 523 ms | 625 ms |

The capability-safe 100-case path is about 9.8 times faster than the measured
strict baseline and remains below one second at p95. The deliberately unsafe
ceiling is slower here because that probe includes compilation inside the
single evaluation call, while the product candidate uses the real
prepare-once Judge boundary; it is not a comparable lower bound for C#.

## Required evidence

The browser compiler/runner boundary gate proves:

- two calls in one outer runner each observe learner static state at its initial
  value;
- a thrown line limit and an ordinary learner exception each leave the same
  outer runner clean for a successful later case;
- filesystem, environment, threading, shared-pool, memory-pinning,
  host-runtime, runtime-type, and blocking-collection references fail closed to
  compatibility, while dynamic dispatch remains rejected before tier selection;
- ordinary algorithm and collection code remains algorithm-fast;
- compiler artifacts execute in the compiler-free runner;
- reflective/tampered artifacts and compatibility-artifact relabeling remain
  rejected;
- code, trace selection, limits, structured inputs, and void-output semantics
  retain their existing behavior.

The prepared-provider tests separately prove one outer runner for an admitted
batch, sequential case order, exact release, cancellation checks, and unchanged
fresh-worker ownership for compatibility programs.
