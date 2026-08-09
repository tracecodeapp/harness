# Interactive execution sessions

Status: design decision, 2026-08-08

## Core model

Trace is a capability of execution, not a separate program or top-level
operation. Drain is product scheduling over a durable execution context, not a
worker lifecycle mode.

The browser-facing surface is one `execute` command with two forms:

```ts
const initial = await judgeHost.execute({
  bundle,
  interactive: true,
  tracing: { caseIds: [selectedCaseId] },
});

await judgeHost.execute({
  executionId: initial.executionId,
  tracing: { caseIds: nextDrainCaseIds },
});

await judgeHost.disposeExecution(initial.executionId);
```

`execute({ bundle })` is deliberately conservative: it prepares a clean
artifact, records no traces, retains no session, and disposes the evaluation
before returning. `tracing` is never inferred. `interactive: true` is never
inferred. Either explicit option makes the initial preparation trace-capable;
an omitted `tracing` selection still records no cases.

The interactive initial call retains the immutable code revision, case manifest
and inputs, language options, comparator metadata, prepared artifact, and
comparison policy. It returns an opaque `executionId`; verdicts and traces are
returned tranche by tranche to the caller. Continuation calls address retained
cases by ID, so callers do not resend code or inputs and the runtime does not
reacquire a Worker, assets, or compiler merely to trace another case.

`executionId` is a lifecycle capability, not a content hash. An internal
artifact key may be content-addressed by source, language, compiler/runtime
version, instrumentation mode, and relevant options, but cache identity must
not be confused with ownership of a live execution.

Disposal invalidates the capability immediately and releases its prepared
program lease exactly once. A host-level content cache may keep an immutable,
unreferenced artifact warm under its ordinary bounded TTL; it does not retain
the execution id, case authority, mutable runtime state, or a usable session.

The lower-level scoped `RuntimeJudge` exposes the same initial/continuation
forms over a `JudgeEvaluationPlan`. Closing its Effect scope disposes every
retained execution even if a caller forgot the explicit disposal call.

## TraceKernel ownership

An interactive Judge execution maps to a long-lived logical TraceKernel process
under the existing TraceKernel authority. This need not boot another physical
kernel for every compile. The process owns:

- the opaque execution capability;
- the prepared language artifact and warm runtime lease;
- retained normalized cases and inputs;
- fresh isolated child case runs;
- cancellation, deadlines, and event streaming;
- cached verdicts and completed traces;
- worker retirement, reconstruction, and final disposal.

The Judge exposes `execute` and routes the capability. TraceKernel supplies the
durable identity and lifecycle. Each language runner privately chooses the
cheapest way to satisfy the requested trace selection.

## Product-owned drain

The product owns the queue because priority depends on live product state: the
selected case, failures, nearby cases, navigation, code revisions, and user
cancellation. It sends finite, cancellable trace requests—normally small
tranches—against the retained execution.

The worker may support ordered finite batches and incremental per-case results,
but it must not autonomously continue a product drain after the product has lost
interest. Cancelling a tranche leaves the execution usable. Compiling a new
revision advances the product generation, cancels and disposes the prior
execution, and causes late results from the old execution ID to be ignored.

## Artifact policy

- **Submit:** one clean artifact with no tracing hooks; the TraceKernel execution
  is ephemeral and disposed after all cases complete.
- **Interactive compile:** one trace-capable artifact by default, with recording
  selected per case; the execution is resumable and lives until replaced or
  disposed. “Trace-capable” does not require disabled cases to execute injected
  hooks: Python can keep raw and transformed module bodies in one code object
  behind a single case-load branch, while C++ can use one instrumented body with
  a runtime sink switch. Java can compile traced and clean generated entry
  points into one TraceJVM program and select the entry once per case.
- A language may internally choose another implementation only when measurement
  shows it is materially cheaper. That choice never changes the public API into
  separate code and trace executions.

This keeps the layers aligned: the application schedules drain, Judge exposes a
single execution abstraction, TraceKernel owns durable execution state, and
language runtimes implement trace selection opaquely.

## Off-switch invariant

Every language must place its per-case tracing switch at the highest
semantically safe execution boundary. Configuring a sink before execution is
not sufficient when transformed learner code still constructs trace arguments,
delegates, snapshots, or wrapper state. A disabled case should enter a clean
body before any of that work occurs.

The preferred order is:

1. choose the clean or traced entry once per isolated case;
2. if a language cannot preserve semantics with whole-entry variants, choose
   at learner function or method entry; and
3. retain lower guards only at unavoidable trace-aware representation
   boundaries, before they allocate or normalize trace data.

The implementation may differ by language, but the observable invariant does
not: a disabled case emits no events, consumes no trace budgets or trace
timeouts, preserves clean output and isolation, and does no avoidable tracing
work. Opportunity-cost benchmarks must measure both the remaining managed
overhead and any preparation cost introduced by a higher switch.

## Language proof points

The first language experiments support the stable contract while showing why
the mechanism must stay private to each runner:

- **C++:** one TraceCC-compiled Wasm module now accepts a per-case recording
  vector. A direct worker batch using `[true, false, true]` returned all three
  outputs from that module, emitted events only for the selected cases, and did
  not acquire a second compiler or artifact. Trace admission and budget checks
  return before counter mutation when recording is disabled.
- **Python:** one marshaled user code object contains raw and transformed module
  bodies behind a case-load selector, and one marshaled executor code object
  contains the complete trace and clean harnesses behind another top-level
  selector. Both selectors run once per isolated case; the clean path contains
  no injected per-access hooks. Across two direct Pyodide worker runs, three
  disabled cases differed from a separately prepared clean artifact by only
  0.12–2.61 ms (0.04–0.90%). A selected-plus-two-drain batch was 3.82–4.98 ms
  faster as one artifact than when split across trace and clean artifacts,
  while the second clean preparation itself cost another 5.83–6.45 ms.
- **Java:** the original full 200-problem experiment in
  `docs/java-on-demand-tracing-experiment.md` exposed five severe per-hook
  disabled-branch outliers. The follow-up now compiles traced and clean source
  units together into one restorable TraceJVM program. One runner selects the
  entry class per case, and trace-budget verdict fallbacks use the same clean
  companion. N-Queens `n = 9` fell from 15.4–17.0 seconds disabled to
  136–141 ms clean, while its selected trace fell from about 2.02 seconds to
  593–598 ms. The original five outliers plus the former compile failure all
  favor the one-artifact implementation after the change. A final compatibility
  pass completed all 200 problems and 2,352 cases with zero failures and a
  28 ms/case execution average; no problem averaged more than one second per
  case.
- **C#:** one trace-capable assembly selects the untouched learner body at each
  invoked learner method before statement, delegate, snapshot, local collection,
  and sink instrumentation. C# must retain trace-aware subclasses for selected
  collection fields so mutations remain observable across helper methods; those
  wrappers therefore have their own early disabled branch immediately after the
  underlying collection operation and before trace argument allocation. This is
  the highest safe switch that preserves one assembly, declared type identity,
  reflection behavior, and one Roslyn emit.

The absolute timings are machine-specific. The important result is structural:
all languages can honor the same trace-selection request, while their
cheapest internal implementations need not be identical.
