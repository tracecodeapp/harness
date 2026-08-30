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

## Runtime capability boundary

Judge supervision and runtime authority are separate. `TraceKernelJudgePort`
may open a session, mount files, start one protected grader process, arm its
watchdog, wait for it, and signal it through host-side kernel APIs. None of
those powers are placed on the runtime-visible syscall port.

Every Judge process uses TraceKernel's `algorithm` syscall profile. That
profile admits only an atomic `readFile` of explicitly named submission files.
Process creation and inspection, writable filesystem operations, descriptor
and terminal APIs, watches, watchdog control, and networking return
`EOPNOTSUPP` before the corresponding subsystem is touched. Exact paths are
resolved against the process cwd, so aliases cannot widen the allowlist.
The immutable runtime context names the same profile, allowing a provider to
select a smaller implementation without making provider cooperation the
security boundary.

Language imports such as Python's `collections.deque` remain a runtime concern:
they resolve from the immutable language image rather than TKFS and do not
require granting a filesystem syscall. Runtime workers must still isolate
language-level global state between cases; the kernel profile removes OS-like
capabilities but does not replace that runner proof.

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

Judge exposes one observable case contract: `fresh-case-state`. A prepared
provider resolves that contract through one of two safe implementation
profiles:

- `fast` retains trusted immutable compiler/runtime state and creates the
  language's smallest proven fresh case realm; or
- `compatibility` uses the provider's general isolated runner, including a
  disposable outer language runtime when necessary.

Correctness and trace are execution modes, not isolation profiles. A provider
must independently prove its fast path for each mode. TraceKernel applies the
same `algorithm` syscall profile to both runtime profiles, so selecting `fast`
does not grant filesystem, process, thread, network, descriptor, terminal, or
watchdog authority.

The original compile-once path may still materialize a fresh TraceKernel
session from a quiescent image for every case. Prepared browser providers may
instead run a batch through one Judge process because the language provider
owns the fresh mutable case realm. In both paths, concurrency changes
scheduling only and results preserve input order.

See `docs/runtime-execution-profiles.md` for selection, poisoning, fallback,
and the language mapping.

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
