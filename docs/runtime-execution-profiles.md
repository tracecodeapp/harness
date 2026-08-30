# Runtime execution profiles

Prepared algorithm execution has two public profiles. Execution mode is a
separate dimension: either profile may prepare correctness code or traced code.

| Profile | Language boundary | Intended use |
| --- | --- | --- |
| `fast` | Retain immutable runtime/compiler state; create fresh mutable case state | Statically admitted algorithm code |
| `compatibility` | Use the language provider's general isolated runner, including a disposable outer runtime when required | Code outside the fast contract |

Both profiles run underneath TraceKernel's `algorithm` syscall profile. Neither
profile grants learner filesystem, process, thread, network, terminal, or
watchdog authority. `fast` is not an unsafe mode: it is a smaller language
capability surface whose missing subsystems make a smaller reset sufficient.

## Selection and fallback

The trusted provider selects a profile during immutable preparation. A stored
artifact cannot promote itself: providers revalidate fingerprints or admission
metadata before executing it.

Fallback is allowed only at an atomic boundary:

1. If source or input admission fails before learner code starts, execute the
   complete call with `compatibility`.
2. If a fast engine fails before publishing any case result, poison and retire
   it. A provider may replay the complete call with `compatibility`.
3. Never replay after exposing a partial result, and never return a failed or
   timed-out retained engine to the pool.

Learner failures are structured results and do not by themselves poison a
runtime. Cancellation, client timeout, malformed control output, cleanup
failure, worker failure, and failed quiescence do.

## Fresh-case-state contract

Every prepared program advertises `caseIsolation: 'fresh-case-state'`. The
concrete reset is language-specific, but the observable contract is shared:

- learner globals, statics, prototypes, class loaders, namespaces, and inputs
  do not cross case boundaries;
- trace buffers, console capture, counters, and resource limits start fresh;
- delayed work cannot run in the next case;
- mutable filesystem or ambient host state is absent in `fast`, or restored by
  `compatibility`; and
- retained compiler/runtime caches contain only trusted immutable artifacts.

The provider may keep an outer engine warm only while those properties remain
true. Periodic rotation is a memory policy, not an isolation substitute.

## Current provider mapping

| Language | Correctness | Trace |
| --- | --- | --- |
| Python | admitted reduced batch driver; otherwise compatibility | admitted source and plain inputs retain Pyodide with fresh namespaces and reset trace state; otherwise compatibility |
| JavaScript / TypeScript | admitted SES compartment per case; otherwise compatibility | trusted instrumentation plus the same fresh SES compartment boundary; otherwise compatibility |
| Java | admitted application class loader per case; otherwise compatibility | same prepared TraceJVM boundary |
| C# | admitted collectible load context/runner; otherwise compatibility | same prepared TraceCLR boundary |
| C++ | compiled module retained, fresh WASI instance/memory per case | same fresh-instance boundary |

Internal compiler classifiers may record finer diagnostic reasons. Those are
not additional execution profiles and must resolve to either `fast` or
`compatibility` at the provider contract.
