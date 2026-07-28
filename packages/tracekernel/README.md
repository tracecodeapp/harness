# `@tracecode/tracekernel`

TraceKernel is the browser-native machine boundary for TraceCode. It owns
sessions, processes, descriptors, shared resources, runtime leases, and their
lifecycles.

The 0.13 package is under active architectural development. Its Effect-native
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

The package root is the only supported code import. Deep imports into `src/` or
`dist/` are private implementation details. Both ESM and CommonJS consumers use
the same root export surface.

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

## 0.13 boundary

0.13.0 covers authoritative sessions, process lifecycle and topology,
process-owned descriptors, TKFS, pipes, watches, terminals, watchdogs, local
TCP, structured HTTP over the same TCP namespace, runtime leases, and the
JavaScript/TypeScript, Python, C++, C#, and TraceJVM adapter contracts.

Suspended jobs, CPU-bound asynchronous signal injection for compiled runtimes,
positive socket deadlines, UDP, Unix-domain sockets, broader DNS/address-family
behavior, additional termios modes, arbitrary external TCP, in-kernel TLS, and
HTTP/2 are not 0.13.0 compatibility claims.
