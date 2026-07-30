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

## Portable authority bundles

An algorithm bundle contains:

- a schema and bundle id;
- the exact submitted workspace digest;
- language-neutral execution binding;
- ordered inputs and optional expected values;
- serializable comparator policy;
- workspace-bound semantic facts;
- declarative verdict and scoring policy.

A project bundle contains a versioned definition and attempt. The definition
declares workspace artifacts, isolated command or service-probe steps,
versioned evaluator patterns, and verdict policy. The attempt supplies the
submitted artifact, attributed observations, semantic facts, and optionally
precomputed technical evidence from an already-running browser TraceKernel
workspace.

Bundles are JSON-compatible authority messages. A client browser and a mux
browser slot validate and evaluate the same data model.

## Comparison and verdicts

Runtime providers publish raw values. They do not receive expected values,
comparators, or verdict policy. After a case process completes, Judge applies a
`JudgeComparator` and constructs one of these verdicts:

- `passed`;
- `failed`;
- `comparison-error`;
- `not-evaluated`, when no expected output exists or the case did not complete.

Comparator strategies are serializable. Judge materializes the executable
comparator inside the current authority, including registered custom
validators, without forwarding expected values to a runtime.

Trace metadata is part of the raw case observation. Judge preserves it in the
case result but compares only the published value, so tracing cannot change a
case verdict.

`passWhen` is a small three-valued policy language. It can combine case
outcomes, claims, process observations, and workspace-bound facts. A missing
required fact yields `unknown`, which becomes an indeterminate or not-evaluated
technical verdict. It never defaults to pass.

Weighted score dimensions are evaluated from the same expressions. Product
recommendations and explanatory prose remain above Judge.

## Pattern and definition versioning

Project protocol and authored content do not share a version counter:

- the project definition schema versions the portable workflow contract;
- each evaluator reference has a `kind` and independent `version`;
- the definition `revision` pins a particular authored assessment.

This allows a new debugging evaluator to coexist with existing definitions
without changing the transport schema, and lets content revisions remain
auditable without fabricating protocol versions.

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

The 0.14 browser integration provides one reusable `BrowserJudgeHost`.
Applications select runtime capacity but cannot acquire direct providers.
Algorithms call `evaluateAlgorithm`; projects call `createProjectJudge`.

Mux hosts the same browser module and multiplies it across replaceable slots.
It owns capacity, queues, readiness, and slot lifecycle only. The product
Worker and mux authenticate requests and sign exact responses; Judge receipts
remain portable data rather than embedding deployment credentials.

The remaining rollout work is operational: publish the root Harness artifact,
deploy matching immutable runtime assets, canary mux capacity, and compare
receipts with the final 0.13 oracle. No direct-runner fallback belongs in the
0.14 public API.
