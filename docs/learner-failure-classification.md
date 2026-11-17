# Learner Failure Classification

Every Judge result says where a failure came from. Consumers read that
classification and act on it; they must not second-guess it from process
termination, error text, or timing. This document is the contract the Harness
keeps and the conformance gate that holds it to that contract.

## What a consumer reads

Each compile result and each case carries `diagnostics`. The first `error`
diagnostic's `code` is the classification:

| `code` | Meaning | Who caused it |
| --- | --- | --- |
| `compile`, `driver-compile`, `trace-driver-compile`, `driver-link` | The learner's source did not compile, or did not fit the call the problem makes (missing method, wrong signature, a denied API). | The learner's program |
| `runtime`, `trace` | The learner's program raised, crashed its runtime, trapped, or exited while running. | The learner's program |
| `client-timeout`, `line-limit`, `single-line-limit`, `recursion-limit`, `memory-limit`, `serialization-limit`, `trace-limit`, `trace-byte-limit` | A limit stopped the program before it finished. The code names the limit. | The learner's program |
| `runtime-provider-error` | The runtime provider failed for a reason the program did not cause: an asset or toolchain failed to load, a transport broke, a worker died outside the program, or a runtime broke the result protocol. | The Harness or its deployment |

Learner failures carry a readable `message` and, when the language can know
it, the source `line`. `runtime-provider-error` is never used for a learner
failure, and a provider failure is never reported with a learner code.

A case whose time limit is enforced by the Judge's own watchdog is reported as
`timed-out` with `timedOut: true` and a `client-timeout` diagnostic, including
when a whole batch is stopped before the runtime could publish per-case
results. A watchdog timeout is never an infrastructure error.

## The runtime contract

Runtime providers implement `RuntimePreparedExecutionProvider`. Their outcomes
are typed so that the wrong answer cannot be produced by omission:

- `failed` means only that the learner's program failed. `diagnosticStage` is
  required on every `failed` variant (`CodeExecutionResult`,
  `ExecutionResult`, `RuntimeProgramPreparationResult`). TypeScript rejects a
  `failed` outcome that does not name its stage.
- `limit` means a limit stopped execution; `reason` names it.
- A provider failure is not an outcome. The provider rejects, preferably with
  `RuntimeProviderError` from `@tracecode/runtime-contracts`, and Judge reports
  the rejection as `runtime-provider-error`. Runtime initialization failures
  are reported the same way, on the process that needed the runtime.
- Worker payloads are lifted by `liftCodeOutcome` and `liftTraceOutcome`. A
  worker `success: false` payload must carry a `timeoutReason` or a
  `diagnosticStage`. One that carries neither has broken the protocol, and
  lifting rejects with a `RuntimeProviderError` that names the omission.
- An untyped provider that still returns a stageless `failed` outcome is
  reported as `runtime-provider-error` with a message naming the contract
  violation; it is never silently attributed to the learner or to the
  provider.

## Programs that take their runtime down

A learner's program can end its worker or engine: unbounded recursion, a
WebAssembly trap, exhausting memory, `sys.exit`, `System.exit`,
`Environment.Exit`, `exit()`, or `abort()`. These are the learner's runtime
failures. The Harness retires the affected worker, engine, or runner and runs
the next case in a fresh one; recovering the session is the Harness's job, not
the consumer's.

Whether a session survived is not encoded in the classification. Consumers do
not need to rebuild a host after a learner failure; they may rebuild after a
`runtime-provider-error`.

## Language notes

- Python: an exception raised in the program region (case setup, the learner's
  call, result serialization) is `runtime`, including `SystemExit`. A program
  that raises after a trace budget stopped recording reports its exception,
  not the budget. A worker crash during a case is `runtime`; the fast batch
  re-runs the affected cases one per fresh worker.
- JavaScript and TypeScript: syntax errors are `compile`; anything the
  program throws is `runtime`.
- Java: a failed run of a compiled program is `runtime`, including
  `StackOverflowError` and `OutOfMemoryError`.
- C#: the browser .NET runtime lacks exception message resources; the Harness
  maps common resource keys (`Arg_DivideByZero`) to the framework's English
  messages. `Environment.Exit` and fatal stack overflow end the .NET runtime;
  the case is `runtime` and the runner is retired.
- C++: the toolchain builds without exceptions. A `throw` that no lowered
  `catch` handles ends the program as an uncaught exception (`runtime`, with
  the throw's line). WebAssembly traps (integer divide by zero, out-of-bounds
  memory, `abort`, stack exhaustion) and non-zero exits are `runtime`.

## Conformance gate

`pnpm test:learner-failure-matrix` runs every language × run mode × failure
kind through the public `BrowserJudgeHost` in a real browser and asserts the
classification, the message, the line where the language can know it, and that
the same host runs a healthy program afterwards. Run modes are plain, plain
batch, traced, traced batch, and interactive with a trace continuation; program
preparation runs in every mode. Each runtime also gets one injected provider
failure (an unavailable runtime asset) that must be `runtime-provider-error`.

Cells that cannot be made right yet are listed in the test's `KNOWN_GAPS` with
the reason. A listed gap that starts passing fails the gate, so the list stays
honest. Fast unit coverage of the Judge mapping lives in
`tests/test-runtime-execution-judge.ts`.
