# `@tracecode/judge`

`@tracecode/judge` turns a language-neutral evaluation plan into protected
TraceKernel compile and case processes.

It owns:

- workspace and generated-driver mounting;
- compile and run phase ordering;
- fresh-session-per-case isolation;
- timeout and cancellation supervision;
- ordered process observations;
- structured runtime results and diagnostics.
- pluggable expected-value comparison and per-case verdict construction.

It does not own:

- language compilation or execution;
- worker pools or runtime assets;
- TraceKernel process or filesystem semantics;
- scoring, recommendations, or assessment policy;
- TraceCode product persistence.

The public evaluation path is:

```text
evaluation plan
  -> @tracecode/judge
  -> comparator + verdict
  -> JudgeKernelPort
  -> TraceKernel session/process
  -> language runtime provider
```

The initial TraceKernel adapter is exported from `@tracecode/judge/tracekernel`.
Runtime providers exchange case inputs and structured observations through a
private `JudgeRuntimeControlPort`; learner stdout and stderr remain ordinary
program output.

Cases may provide an `expected` value. Judge compares completed raw values with
the plan's comparator, or with `structuralJsonComparator` by default. That
default intentionally preserves the former browser/native `JSON.stringify`
equality semantics for the 0.14 migration. Cases without `expected` remain
execution-only and receive an explicit `not-evaluated` verdict.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the ownership and integration
contract.
