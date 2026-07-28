# TraceKernel 0.13 release boundary

## 0.13.0 contract

TraceKernel 0.13.0 is the kernelization release. The supported architecture is:

```text
host -> session -> process -> runtime lease
                  |
                  +-> process-owned descriptor table
                       +-> TKFS files
                       +-> pipes
                       +-> watches
                       +-> controlling terminal
                       +-> local TCP sockets
```

The kernel is authoritative for PID allocation, parent/group/session topology,
scheduling and termination state, process limits, descriptor installation and
inheritance, open-resource lifetime, filesystem mutation order, terminal
foreground ownership, watchdog deadlines, local port ownership, signal
selection, and runtime-lease release disposition.

The product layer may retain presentation and bounded coordination records for
shell output, journals, grading, and wait publication. Those records cannot
select process topology, mutate kernel resources, or provide a fallback
filesystem, descriptor table, network namespace, watchdog, or foreground
process group.

## Runtime adapter matrix

| Runtime | TKFS and descriptors | Spawn/wait/signals | Pipes/watch/poll | Local TCP | Terminal controls |
| --- | --- | --- | --- | --- | --- |
| JavaScript / TypeScript | First-class | First-class | First-class | `node:net` plus raw syscalls | First-class, live `SIGWINCH` |
| Python | First-class | First-class | First-class | `socket` plus raw syscalls | First-class, syscall safe-point `SIGWINCH` |
| C++ | First-class WASI bridge | First-class WASI bridge | First-class WASI bridge | First-class WASI bridge | First-class, syscall safe-point `SIGWINCH` |
| C# | First-class managed bridge | First-class managed bridge | First-class managed bridge | First-class managed bridge | First-class managed notification |
| Java / TraceJVM | First-class hosted POSIX bridge | First-class hosted process bridge | First-class hosted bridge | First-class NIO/socket bridge | First-class hosted notification |

CheerpJ is not part of this adapter contract. TraceJVM remains an independent,
lightweight browser JVM with a generic optional host boundary; the Harness
adapter supplies TraceKernel policy and process-scoped syscalls without
embedding TraceCode product policy into TraceJVM.

## Public and wire compatibility

- Supported package import: `@tracecode/tracekernel`.
- ESM and CommonJS root exports are built from the same source entry.
- Binary syscall schema: `tracekernel.syscall.v1`.
- Binary syscall version: `1`.
- Operation numbers are append-only within version 1.
- Existing operation numbers or payload shapes cannot change without a new
  wire version.
- Structured-clone requests use the same request/result types and POSIX error
  vocabulary as the binary transport.
- Effect services, fibers, causes, and scopes never cross a runtime boundary.

## Required 0.13.0 release gates

- All package and test TypeScript projects compile.
- The non-browser TraceKernel suite passes, including adversarial teardown.
- JavaScript, Python, C++, C#, and TraceJVM pass their real browser suites.
- TraceJVM passes Chromium, Firefox, and WebKit.
- Worker crash/revalidation tests prove destroy-on-unknown-state and
  exactly-once lease release.
- Child isolation tests prove separate heap/global state and explicit-only
  descriptor inheritance.
- Package build and packed-file inspection expose only the documented root
  entry and release artifacts.
- Generated worker and runtime assets match their checked-in sources.

## Deliberately deferred to 0.13.x or later

- suspended job control (`SIGTSTP`, `SIGTTIN`, `SIGTTOU`, `SIGCONT`);
- arbitrary asynchronous signal-handler injection into CPU-bound compiled code;
- positive socket deadlines;
- UDP datagrams;
- Unix-domain sockets;
- broader DNS and address-family behavior;
- additional termios modes;
- WebSockets as a first-class socket adapter;
- arbitrary external TCP/UDP;
- TLS implemented inside TraceKernel;
- HTTP/2;
- full POSIX job control or general Linux compatibility.

Deferral means the operation is not advertised as supported. It must not be
simulated by mutable product metadata or a second host-side resource model.
