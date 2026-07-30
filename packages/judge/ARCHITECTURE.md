# Judge architecture

## Boundary

Judge is evaluation policy over TraceKernel. It is not a language engine and it
is not part of TraceKernel itself.

```text
Practice / Playground / Mock / Mux
                |
                v
       @tracecode/judge
                |
                v
        JudgeKernelPort
                |
                v
     @tracecode/tracekernel
                |
                v
      runtime provider
```

TraceKernel owns sessions, processes, PIDs, signals, filesystem images,
descriptors, watchdogs, and runtime leases. Runtime packages own language
semantics. Judge owns how those primitives become one evaluation.

## Evaluation plan

A plan is already lowered to process-level intent:

- submission files;
- private generated-driver files;
- an optional compile process;
- a run process template;
- ordered case inputs;
- isolation and concurrency policy.

Judge does not generate language-specific source in this package. A problem
adapter or runtime package may generate a driver and then supply it as a
`judge-private` file.

## Private driver boundary

Private files must live below `/.tracecode/judge/`. The TraceKernel adapter runs
compile and case commands as protected, invisible grader processes in
evaluation-only sessions. Results expose neither filesystem images nor private
file contents.

This is an authority boundary, not merely a naming convention. When an
interactive learner session is integrated, its namespace policy must not grant
learner processes access to the Judge-private subtree. The evaluation session
must not be reused as the visible product workspace.

## Structured result channel

Case input and structured output do not travel through learner stdout.

The adapter creates an opaque invocation id and places only that id in a
reserved process environment variable. A runtime provider reads the input and
publishes one result through `JudgeRuntimeControlPort`. Worker-backed runtimes
can implement the same port over a private `MessagePort`; the included in-memory
implementation is for same-realm providers and tests.

Stdout and stderr therefore retain normal language semantics and can be shown
to the learner verbatim.

## Isolation

The foundation intentionally exposes one safe mode:

```text
fresh-session-per-case
```

Judge mounts and compiles once, takes a quiescent TKFS image, then opens every
case in a new TraceKernel session from that image. This isolates:

- language process state;
- runtime leases;
- environment mutations;
- descriptors and pipes;
- filesystem writes;
- signals and process topology.

Concurrency changes scheduling only. `Effect.forEach` preserves input order in
the returned case results even when cases finish out of order.

An unsafe shared-session mode is deliberately absent. It should be added only
for an explicit trusted workload with measured need.

## Cancellation and timeout

Each process wait installs an interruption finalizer that sends `SIGKILL`.
TraceKernel owns final process interruption, lease release, and session
shutdown. Process timeouts use TraceKernel watchdogs and are reported as
structured timed-out phase results.

Cancellation itself remains Effect interruption rather than a fabricated test
result. Product adapters may map an interrupted evaluation to their own
cancelled UI state.

## What integration still needs

The 0.14 integration must reconcile:

1. the neutral runtime provider contract and final package names;
2. a worker-capable `JudgeRuntimeControlPort` transport;
3. language-specific driver generation outside Judge;
4. artifact/cache policy for compiled outputs;
5. product comparators and scoring above Judge;
6. root build, typecheck, packaged-surface, and release scripts;
7. browser differential coverage against the final 0.13 direct-runner oracle.

Judge must not be adapted by calling `createBrowserHarness` or a direct
`RuntimeClient`. The adapter boundary is TraceKernel sessions and processes.
