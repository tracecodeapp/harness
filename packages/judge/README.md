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

It does not own:

- language compilation or execution;
- worker pools or runtime assets;
- TraceKernel process or filesystem semantics;
- expected-value comparison, scoring, recommendations, or assessment policy;
- TraceCode product persistence.

The public evaluation path is:

```text
evaluation plan
  -> @tracecode/judge
  -> JudgeKernelPort
  -> TraceKernel session/process
  -> language runtime provider
```

The initial TraceKernel adapter is exported from `@tracecode/judge/tracekernel`.
Runtime providers exchange case inputs and structured observations through a
private `JudgeRuntimeControlPort`; learner stdout and stderr remain ordinary
program output.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the ownership and integration
contract.
