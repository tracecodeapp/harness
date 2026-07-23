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

Runtime-facing syscall contracts are ordinary data. The package includes a
bounded binary SharedArrayBuffer transport for synchronous APIs in dedicated
browser workers, but runtime adapters depend on a transport-neutral interface.
Effect, fibers, and services never cross that boundary.

The package now also contains the first session-local TCP foundation. Local
socket descriptors, port bindings, listener backlogs, duplex streams,
half-closes, and teardown are kernel-owned. Existing structured HTTP adapters
are intentionally still separate until they can be migrated onto the byte
stream model with protocol conformance coverage.

The browser JavaScript integration now maps the foundational event-driven
`node:net` server/client surface onto those syscalls. It uses an asynchronous
MessagePort request path for blocking socket operations while synchronous
filesystem APIs retain the SharedArrayBuffer path; both transports terminate at
the same host-owned syscall dispatcher.
