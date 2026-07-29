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

## Executable beta release profiles

The release criteria are executable rather than a prose-only checklist:

```bash
# Required on every Harness pull request. Uses bounded soak counts.
pnpm test:tracekernel-013-release:ci

# Required before tagging a beta. Runs the extended soak, every real browser
# adapter, the three-engine provider/live-TKFS matrices, TraceJVM's independent
# release suite, and packed artifact gates.
TRACECODE_TRACEJVM_ROOT=/absolute/path/to/tracejvm \
  pnpm test:tracekernel-013-release:full

# Independently rerunnable release surfaces.
pnpm test:tracekernel-013-release:tracejvm
pnpm test:tracekernel-013-release:artifacts
```

The CI profile runs:

- the complete non-browser TraceKernel conformance suite;
- a bounded mixed-runtime process/session soak;
- the real JavaScript/TypeScript browser adapter;
- Python spawning JavaScript with shared TKFS, pipes, process groups, watches,
  signals, watchdogs, and TCP;
- C++ spawning JavaScript and nested C++, plus JavaScript spawning C++, using
  POSIX descriptors, `posix_spawn`, `waitpid`, signals, watchdogs, and BSD
  sockets; and
- C# spawning JavaScript and C#, with shared TKFS, descriptors, watches,
  process groups, signals, watchdogs, and TCP.

The full profile additionally requires:

- 1,000 sequential mixed-runtime children in one session;
- 100 complete session create/teardown cycles with ten processes per session;
- 100 adversarial teardown rounds with blocked pipe reads, watch reads, TCP
  accepts, and child waits;
- Python/JavaScript live filesystem visibility in Chromium, Firefox, and
  WebKit;
- the Python, JavaScript, TypeScript, C#, and C++ project providers in
  Chromium, Firefox, and WebKit;
- the independent TraceJVM package, compatibility, runtime-profile, and
  lifecycle-stress suites;
- TraceKernel/TraceJVM integration in Chromium, Firefox, and WebKit; and
- the production build, packed surface, language-package surface, copied asset
  parity, and packed example consumer.

The mixed-runtime soak uses deliberately minimal runtime providers named for
the five adapters. Its job is to stress kernel process, lease, TKFS,
descriptor, pipe, socket, and teardown invariants at high iteration counts.
It does not substitute for the real browser adapter suites; both are required.

## Invariants checked

The release gates fail if any of these conditions are observed:

- a child remains in the process table after exactly-once reaping;
- a session leaves a process, zombie, descriptor, watch, terminal, socket,
  listener, port binding, or runtime lease behind;
- a child receives a parent-private descriptor without an explicit mapping;
- one process observes another process's heap, globals, prototype mutations,
  or process-scoped environment changes;
- a filesystem mutation is not committed through TKFS or is attributed to a
  forged/non-owning process origin;
- a runtime crash, watchdog expiry, signal, or repeated shutdown releases a
  lease more than once;
- pipe EOF, backpressure, TCP fragmentation, half-close, or listener ownership
  diverges from the kernel descriptor model; or
- generated, packed, and copied release artifacts differ.

## Physical iPad sign-off

Physical iPad validation remains a release sign-off because it cannot be
represented truthfully by desktop CI. WebKit iPad emulation belongs to
TraceJVM's independent standalone release suite, but it is not recorded as a
physical-device pass.

The device page runs the real TraceKernel + TraceJVM adapter fixture and
records filesystem sharing, descriptors, stdin, TCP, selectors, file watches,
child processes, process groups, sessions, terminal controls, watchdogs,
signals, worker retirement, and restart isolation as a JSON report.

First verify the page and report callback locally:

```bash
TRACECODE_TRACEJVM_ROOT=/absolute/path/to/tracejvm \
  pnpm test:tracekernel-013-physical:check
```

Then create a temporary HTTPS URL for the physical device:

```bash
TRACECODE_TRACEJVM_ROOT=/absolute/path/to/tracejvm \
  pnpm test:tracekernel-013-physical -- --tunnel
```

The command prints `PHYSICAL_IPAD_URL`. Keep it running while Safari completes
both required passes:

1. Open the URL and leave Safari in the foreground until the first report
   passes.
2. Background Safari for 30 seconds, return to the same tab, and choose
   **Run again**.
3. Confirm the second report passes, then stop the host with `Ctrl+C`.

The random tunnel is HTTPS because browser SharedArrayBuffer transports require
a secure, cross-origin-isolated context. It exists only while the command is
running. Device reports are written beneath the ignored
`reports/tracekernel-013-physical/` directory. A beta physical sign-off requires
two passing reports from the same device, with the second produced after the
background/foreground transition.

GitHub Actions is deliberately limited to generated-metadata checks,
typechecking, builds, package-surface checks, and the workspace smoke test.
Language-runtime suites, browser compatibility matrices, performance matrices,
TraceKernel release profiles, and physical-device validation run locally. They
must not be added to automatic or scheduled GitHub workflows.

The local generic provider matrix can continue to monitor CheerpJ for legacy
compatibility. It is intentionally not a TraceKernel 0.13 release dependency:
Java 0.13 is gated by the independent TraceJVM release and integration suites
above.

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
