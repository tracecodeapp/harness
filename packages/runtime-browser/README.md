# `@tracecode/runtime-browser`

Private browser infrastructure for the TraceCode Harness.

This workspace owns:

- runtime asset resolution and preflight
- browser capability and engine detection
- worker transport and credential-free execution hosts
- provider registration, leasing, warm capacity, and teardown
- browser persistence
- browser-specific assembly of a TraceKernel workspace

It is not a public application entrypoint. The root package composes it behind:

- `@tracecode/harness/tracekernel` for interactive workspaces
- `@tracecode/harness/judge` for judged execution

Applications must not import runtime providers, clients, workers, registries,
or this package directly. TraceKernel and Judge expose the supported
configuration without exposing those implementation seams.
