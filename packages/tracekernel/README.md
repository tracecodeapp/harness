# `@tracecode/tracekernel`

TraceKernel is the browser-native machine boundary for TraceCode. It owns
sessions, processes, descriptors, shared resources, runtime leases, and their
lifecycles.

This workspace is private in the 0.17 release line and is bundled behind the
published `@tracecode/harness` surfaces; it is not released independently.

The package is under active architectural development. Its Effect-native
API keeps acquisition, interruption, and release structurally connected while
leaving process and syscall semantics explicit in TraceKernel domain state.

The session-owned virtual filesystem is called **TKFS** internally and
**TraceKernel VFS** in public architecture language. TKFS is a kernel subsystem,
not a persistent disk format: storage and persistence backends remain separate
concerns.

Filesystem quota enforcement and mutation publication linearize with each TKFS
commit. Mutation records include the semantic operation plus optional opaque
host-side origin identity so product adapters can reconcile process writes
without timing heuristics or duplicate observation.

Runtime-facing syscall contracts are ordinary data. The package includes a
bounded binary SharedArrayBuffer transport for synchronous APIs in dedicated
browser workers, but runtime adapters depend on a transport-neutral interface.
Effect, fibers, and services never cross that boundary.

Host-owned execution engines can attach with `TraceKernelControlledRuntime`.
The controlled provider leaves PID, signal, descriptor, and lease authority in
TraceKernel while the host reports completion from an existing runner.
Every acquired runtime context includes the authoritative session identity and
a process-bound syscall port. Providers may bridge that port to an in-realm
adapter, Worker, or Wasm guest, but they do not receive session internals and
cannot issue a syscall as a different process.

Processes may also carry a runtime syscall policy. The default unrestricted
profile preserves the general Project and terminal machine contract. The
algorithm profile used by Judge exposes only atomic reads of exact TKFS source
paths; other requests fail with `EOPNOTSUPP` before filesystem, process,
network, terminal, descriptor, watch, or watchdog state is touched. Host-side
kernel supervision remains available, so restricting the runtime does not
prevent the Judge from spawning, timing out, or terminating its grader.
TraceKernel brackets every mutable lease itself and passes its exactly-once
release a kernel-classified disposition. A normally completed lease is still
destroyed unless it implements `revalidate()` and that reset check succeeds;
execution failure, signal termination, interruption, and failed validation can
never authorize pool reuse. Provider initialization remains lazily memoized, so
immutable assets survive recovery without retaining process-visible state.
Detached controlled processes can attach real `/dev/null` standard descriptors
at fd 0/1/2, reserving the conventional identities in the same table used by
files, pipes, watches, terminals, and sockets. Terminal launches atomically
replace all three identities with views of one session-owned controlling
terminal before runtime code starts.

The package now also contains the first session-local TCP foundation. Local
socket descriptors, port bindings, listener backlogs, duplex streams,
half-closes, and teardown are kernel-owned. Runtime structured HTTP and raw TCP
share this authoritative namespace and process-owned descriptor model; external
browser fetch egress remains a distinct host protocol service.

The project workspace represents trusted host services with an invisible,
protected process in that same session. Public PID 0 remains the stable host
identity, but its HTTP listeners and direct descriptor syscalls are physically
owned by the service process. A host listener and a language runtime therefore
cannot accidentally bind or connect through separate virtual networks.

The browser JavaScript integration now maps the foundational event-driven
`node:net` server/client surface onto those syscalls. It uses an asynchronous
MessagePort request path for blocking socket operations while synchronous
filesystem APIs retain the SharedArrayBuffer path; both transports terminate at
the same host-owned syscall dispatcher.

## Public compatibility boundary

The package root and `@tracecode/tracekernel/workspace` are the only supported
code imports. The workspace entry point owns TraceKernel's stateful workspace
implementation and configuration; runtime-neutral contracts remain outside
that boundary. Deep imports into `src/` or `dist/` are private implementation
details. Both ESM and CommonJS consumers use the same export surfaces.

Runtime adapters can identify the bounded binary protocol through:

- `TRACEKERNEL_SYSCALL_WIRE_SCHEMA`
- `TRACEKERNEL_SYSCALL_WIRE_VERSION`
- `TRACEKERNEL_SYSCALL_OPERATION_CODES`

The current schema is `tracekernel.syscall.v1`. Wire version 1 encodes its
version in the low byte of the frame magic. Operation
numbers are append-only for that version. Renumbering an operation or changing
an existing payload shape requires a new wire version; a decoder rejects a
different version with `EPROTO`. Effect values and errors remain host-local:
the wire carries plain request/result data and POSIX-style error codes.

## Supported kernel boundary

The supported boundary covers authoritative sessions, process lifecycle and
topology,
process-owned descriptors, TKFS, pipes, watches, terminals, watchdogs, local
TCP, structured HTTP over the same TCP namespace, runtime leases, and the
JavaScript/TypeScript, Python, C++, C#, and TraceJVM adapter contracts.

Suspended jobs, CPU-bound asynchronous signal injection for compiled runtimes,
positive socket deadlines, UDP, Unix-domain sockets, broader DNS/address-family
behavior, additional termios modes, arbitrary external TCP, in-kernel TLS, and
HTTP/2 are not compatibility claims.

## Conformance boundary

Runtime-provider conformance may call a provider directly to prove that its
compiler, runner, and protocol work in isolation. TraceKernel browser
conformance has a different responsibility: its primary language compile/run
flows must launch from a process-owned `RuntimeProjectTerminalSession`, using
the same command text, controlling terminal, stdin handoff, worker assets, and
lifecycle that an interactive product terminal uses.

Direct `workspace.runCommand(...)` coverage remains appropriate for deliberately
detached jobs, concurrent server/client probes, grading, and low-level kernel
mechanics. It does not substitute for terminal-path language conformance. A
consumer application should also keep one browser smoke matrix at its public
terminal boundary so cross-origin isolation and packaged worker/toolchain
assets are tested together rather than inferred from provider tests.
