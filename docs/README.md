# TraceCode Harness Docs

These docs describe stable SDK contracts that consumers or contributors can rely
on. Temporary migration ledgers, parity status reports, spike notes, and corpus
triage logs should not live in this public docs tree.

## Public Contracts

- [Harness Execution Contract](./harness-execution-contract.md)
  Defines the language-neutral runtime trace model emitted by every harness.
- [Isolation Boundaries](./isolation-boundaries.md)
  Explains what browser and native execution isolate, and what they do not.
- [Project Terminal Sessions](./project-terminal-session.md)
  Documents the terminal UI API for project workspaces.
- [TraceKernel Workspaces](./tracekernel-workspaces.md)
  Documents workspace identity, sessions, scheduler, storage, and lifecycle
  knobs.
- [TraceKernel HTTP Simulation](./tracekernel-http.md)
  Documents the in-workspace HTTP model for browser project mode.

For package installation, asset syncing, examples, and release notes, start from
the root [README](../README.md) and [CHANGELOG](../CHANGELOG.md).
