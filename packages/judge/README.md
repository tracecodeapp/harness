# `@tracecode/judge`

`@tracecode/judge` turns a language-neutral evaluation plan into protected
TraceKernel compile and case processes.

This workspace is private in the 0.14 release line. Consumers use the supported
`@tracecode/harness/judge` root subpath.

It owns:

- workspace and generated-driver mounting;
- compile and run phase ordering;
- fresh-session-per-case isolation;
- timeout and cancellation supervision;
- ordered process observations;
- structured runtime results and diagnostics;
- serializable comparator strategies and per-case verdict construction;
- versioned algorithm and project bundle validation;
- workspace-bound semantic facts;
- declarative `passWhen`, weighted scoring, and final technical verdicts;
- versioned project evaluator patterns and claim receipts.

It does not own:

- language compilation or execution;
- worker pools or runtime assets;
- TraceKernel process or filesystem semantics;
- recommendations, pedagogy, or product presentation;
- TraceCode product persistence.

The public evaluation path is:

```text
algorithm or project bundle
  -> @tracecode/judge
  -> isolated execution
  -> comparator / evaluator patterns
  -> passWhen + score + verdict
  -> JudgeKernelPort
  -> TraceKernel session/process
  -> language runtime provider
```

The initial TraceKernel adapter is exported from `@tracecode/judge/tracekernel`.
Runtime providers exchange case inputs and structured observations through a
private `JudgeRuntimeControlPort`; learner stdout and stderr remain ordinary
program output.

Bundles are plain JSON-compatible data. Cases may provide an `expected` value
and a serializable comparator strategy. Judge compares completed raw values
inside the current authority. Cases without `expected` remain execution-only
and receive an explicit `not-evaluated` verdict.

Project definitions and project evaluator patterns are versioned separately.
Changing the workflow shape increments the definition schema; changing the
meaning of a debugging or behavior pattern increments that evaluator's
version. A definition revision pins authored content without pretending it is
a new protocol.

Judge facts are bound to a workspace digest and name their producer, producer
version, confidence, and verification tier. This lets `passWhen` require facts
such as semantic complexity without moving the semantic engine into Judge.
Stale or missing required facts evaluate to `unknown`.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the ownership and integration
contract.
