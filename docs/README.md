# TraceCode Harness Docs

These docs describe stable SDK contracts that consumers or contributors can rely
on. Temporary migration ledgers, parity status reports, spike notes, and corpus
triage logs should not live in this public docs tree.

## Public Contracts

- [Harness Execution Contract](./harness-execution-contract.md)
  Defines the language-neutral runtime trace model emitted by every harness.
- [Isolation Boundaries](./isolation-boundaries.md)
  Explains what browser and native execution isolate, and what they do not.
- [C++ Prepared Isolation Boundary](./cpp-prepared-isolation-boundary.md)
  Records why correctness batches retain the compiled module but create fresh
  WASI and WebAssembly state for every case.
- [Warm-and-Retire Worker Lifecycle Policy](./warm-and-retire-policy.md)
  Names the clean-standby, one-use retirement, replenishment, and ownership
  contract shared by browser runtime providers.
- [Java Algorithm Isolation Profile](./java-algorithm-isolation-profile.md)
  Defines artifact-derived admission to retained-JVM correctness batches and
  the fresh-process compatibility boundary.
- [Python Prepared-Execution Isolation Boundary](./python-prepared-isolation-boundary.md)
  Defines the fresh-case and state-restoration contract for prepared Python
  batches.
- [Project Terminal Sessions](./project-terminal-session.md)
  Documents the terminal UI API for project workspaces.
- [TraceKernel Workspaces](./tracekernel-workspaces.md)
  Documents workspace identity, sessions, scheduler, storage, and lifecycle
  knobs.
- [TraceKernel HTTP Simulation](./tracekernel-http.md)
  Documents the in-workspace HTTP model for browser project mode.
- [Browser Project Runtime Benchmark](./browser-project-runtime-benchmark.md)
  Defines the real-browser performance and correctness methodology for public
  project workspaces.
- [Root Package Publishing](./publishing.md)
  Documents the root-only release boundary and its local audit.

For package installation, asset syncing, examples, and release notes, start from
the root [README](../README.md) and [CHANGELOG](../CHANGELOG.md).
