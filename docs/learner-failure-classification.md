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

A compile failure's message is the compiler's own diagnostics in the learner's
file and line numbering, with the primary error and the chain that explains it
intact (library-header locations included); only generated-source locations
are rewritten or left out. Raw compiler output travels as a structured
`diagnostic` (`tracecode.compiler-diagnostic.v1`).

A case whose time limit is enforced by the Judge's own watchdog is reported as
`timed-out` with `timedOut: true` and a `client-timeout` diagnostic, including
when a whole batch is stopped before the runtime could publish per-case
results. A watchdog timeout is never an infrastructure error.

## The Judge contract

Every Judge compile and case result that did not succeed carries a typed
`failure`, and consumers read it instead of inferring an origin from codes or
optional fields:

```ts
type JudgeFailure =
  | { origin: 'program'; stage: JudgeProgramStage; message: string; line?: number }
  | { origin: 'limit'; reason: JudgeLimitReason; message: string }
  | { origin: 'provider'; reason: 'runtime-failure' | 'protocol' | 'contract-violation'; message: string };
```

- `status: 'completed'` never has a `failure`; `runtime-error`, `timed-out`,
  `protocol-error` (and a failed or timed-out compile) always do.
- `protocol-error` is the provider's (`reason: 'protocol'`): the runtime
  finished without the structured result Judge requires. A learner program
  that ends early (`sys.exit(0)`, `os._exit(0)`, `exit(0)`,
  `Environment.Exit(0)`) is classified by its runtime as the program's
  `runtime` failure and never reaches Judge as a protocol error.
- `status: 'not-run'` (Run only, see below) carries `notRun` instead: the
  case was not executed, with the case and the limit that stopped the run. It
  has no failure and no limit of its own.

`judgeCaseExecutionOutcome` and `judgeCompileExecutionOutcome` (exported from
`@tracecode/harness/judge`) convert those results, totally, into the
execution outcomes a learner sees: `completed`, `failed` with its stage,
`limit` with its reason, or `not-run`. A provider failure is not an outcome:
the conversion rejects with `RuntimeProviderError`. Consumers forward; they
never choose an origin.

## Runaway programs and stopping

- Every case runs under a per-case bound owned by its runtime, reported as the
  learner's `limit` with its reason and, where the runtime knows it, the line.
  Untraced cases in a Python trace batch get the guest guard Submit uses (the
  same line budgets), so Run never stops a program Submit accepts.
- Run (an interactive execution) stops at the first case a time or line limit
  stopped; the remaining cases are `not-run`. Submit (`evaluateAlgorithm`)
  judges every case under its own bound unless the caller passes
  `stopAtFirstRunaway: true` (on `evaluateAlgorithm`, a non-interactive
  `execute`, or `RuntimeJudge.evaluateAlgorithm`), which gives a batch Run's
  stopping, reported the same way. It is off by default; the consumer chooses
  per action.
- The Judge watchdog is a backstop behind the providers' own limits
  (`run.timeoutRole: 'backstop'`). It waits for every case's own deadline plus
  the provider's declared `lifecycleAllowanceMs` and a recovery allowance per
  batched case, so the provider's limit, with its reason and line, always wins.
  If the backstop still fires, the runtime did not honour its own limits: the
  unreported cases are the provider's failure, never a fabricated time limit.
- A stopping evaluation (Run, or a batch with `stopAtFirstRunaway`) sends one
  batch to a provider whose prepared program declares
  `capabilities.stopsAtFirstRunaway` (Python); the provider stops at the first
  runaway and returns the prefix. Other providers get one request per case.
  `pnpm test:correct-program-timing` compares correct-program time with 0.19.0
  so this cannot regress unnoticed.
- Aborting a run (the caller's `AbortSignal`) interrupts it and rejects with
  the caller's `AbortError`. Providers terminate the busy worker or VM and a
  fresh one serves the next run; consumers do not dispose the runtime.

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
  the rejection as `runtime-provider-error`. A rejected batch makes every case
  in it the provider's failure; the evaluation itself still completes. Runtime initialization failures
  are reported the same way, on the process that needed the runtime.
- Worker payloads are lifted by `liftCodeOutcome` and `liftTraceOutcome`. A
  worker `success: false` payload must carry a `timeoutReason` or a
  `diagnosticStage`. One that carries neither has broken the protocol, and
  lifting rejects with a `RuntimeProviderError` that names the omission.
- Limit reasons and program stages are closed sets. A worker reply (or an
  untyped provider's outcome) that names a limit or stage outside them is a
  malformed provider message: lifting rejects with `RuntimeProviderError`, and
  Judge reports `origin: 'provider'`, `reason: 'protocol'`. It never becomes a
  learner limit.
- Compilation runs no learner code, so a compile deadline is never the
  learner's limit. In prepared execution (every Judge evaluation) C# and C++
  bound compilation at 120 s (well above a cold first compile on a slow
  device); Java, Python and JavaScript have no compile deadline. A compile that
  misses its deadline is the provider's failure. The direct
  `CppWorkerClient.executeCode` APIs compile and run under one clock; a
  deadline that expires before the program started running is the provider's
  failure there too.
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
  not the budget. Recording stops but the tracer stays installed, so the
  per-case clock and the untraced line ceiling still apply: a program they
  stop reports their limit (`client-timeout`, `line-limit`), with the
  recorded trace kept. A worker crash during a case is `runtime`; the fast batch
  re-runs the affected cases one per fresh worker.
- JavaScript and TypeScript: syntax errors are `compile`; anything the
  program throws is `runtime`.
- Java: a failed run of a compiled program is `runtime`, including
  `StackOverflowError` and `OutOfMemoryError`.
- C#: the browser .NET runtime lacks exception message resources; the Harness
  maps common resource keys (`Arg_DivideByZero`) to the framework's English
  messages. `Environment.Exit` and fatal stack overflow end the .NET runtime;
  the case is `runtime` and the runner is retired. The runner's managed hosts
  decide provenance structurally: an exception thrown by the generated
  driver's `Run` is the program's, every other exception is the host's
  (`hostFailure: true` from the compatibility host; a thrown error from the
  algorithm-fast host, which returns program failures on a separate channel).
  An exception the generated driver itself raises while decoding inputs or
  encoding the result also arrives through `Run`, so it is reported as the
  program's; the driver is produced by the compiler role, which this
  classification cannot change without rebuilding it.
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
