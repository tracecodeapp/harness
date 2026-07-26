# TraceKernel 0.13 architecture

Status: initial implementation contract

## Release intent

TraceKernel 0.13 is the kernelization release. TraceKernel becomes the
authoritative owner of processes, descriptors, blocking I/O, shared files,
runtime leases, and the foundation of the session-local network.

The architecture has four ownership layers:

```text
Runtime host
  -> Session
      -> Process
          -> Runtime engine lease
```

### Runtime host

The host owns expensive reusable, immutable infrastructure:

- downloaded assets;
- compiled WebAssembly modules;
- runtime factories;
- immutable caches;
- provider initialization and health.

It may outlive sessions. It must not own learner-visible mutable state.

### Session

A session is one isolated browser-native machine. It owns the filesystem,
environment defaults, process table, terminals, resource registry, network
namespace, ports, listeners, accounting, and session services.

Destroying a session terminates descendants, closes resources, releases runtime
leases, and makes all mutable session state unreachable.

### Process

A process is an explicit kernel record, not an Effect fiber or worker. It owns
PID relationships, arguments, resolved environment, cwd, descriptor table,
runtime lease, lifecycle, ownership policy, signals, and accounting.

`spawn`, `execute`, and terminal execution use this same process model.
`execute` is scoped spawn, wait, and output collection.

A session admits a configurable maximum number of live processes, defaulting
to 256. Admission beyond that ceiling fails with typed `EAGAIN` before a PID,
runtime lease, or process-table entry is allocated. Capacity returns only when
the process has completed descriptor cleanup and left the process table.

Explicit child processes must name a live parent in the same session. They
inherit the parent's process group and session unless the spawn request
overrides them. When a parent exits before its child, the child remains alive
and is reparented to the session's logical init PID 1; nonexistent parents fail
with `ESRCH` before process admission.

The process-bound `kill` syscall applies UNIX PID selectors inside the virtual
session: a positive PID addresses one process, `0` addresses the caller's
process group, a negative value below `-1` addresses that PGID, and `-1`
addresses every other signalable process. Group delivery never crosses a
TraceKernel session. An empty selection returns `ESRCH`; if every selected
member is protected from the caller it returns `EACCES`; partial permission is
successful when at least one member accepts delivery.

The lifecycle phase is:

```text
created -> starting -> running -> exiting -> exited
```

Normal exit, signal termination, and failure are termination causes recorded on
the final process state.

Catchable `SIGINT` and `SIGTERM` are offered to an optional runtime-lease signal
hook. Hook completion acknowledges delivery only: TraceKernel continues to own
the process deadline and waits for execution to finish for a configurable
session grace period (one second by default). A clean runtime exit during that
window retains its actual exit code and output. Missing or failed delivery and
grace-period expiry force-interrupt the process and record signal termination.
`SIGKILL` always bypasses runtime hooks and interrupts immediately. Descriptor
cleanup, lease release, and process-table removal remain attached to the same
supervised process fiber in every path.

Each process may own one kernel watchdog. The `watchdog` syscall arms, pets,
disarms, or inspects it; its monotonic lifetime belongs to the process rather
than a runtime event loop. Expiry delivers `SIGTERM` or unconditional
`SIGKILL` through the normal signal path. Re-arming atomically supersedes the
old timer, stale timers cannot signal after losing ownership, and process or
session teardown cancels the timer before releasing the process record.
Runtimes may expose these controls, but cannot implement or extend the deadline
independently.

Ownership policy is generic kernel metadata. System callers and a protected
process's owning principal may signal it; foreign non-system principals receive
`EACCES`. Actor-aware inspection hides an invisible process from foreign
callers while retaining it for its owner and the system. Product-specific role
names do not enter this policy.

### Runtime engine lease

A lease represents mutable language execution state assigned to one process.
Immutable initialization may be shared at host level; mutable state may be
reused only after a complete, proven reset.

Safe isolation is the default. Unsafe reuse requires explicit opt-in.

## Effect boundary

Effect is the structured-concurrency and resource-safety substrate, not the
definition of kernel semantics.

TraceKernel uses Effect for:

- `Scope` and `acquireRelease` around hosts, sessions, processes, descriptors,
  and runtime leases;
- lazy, concurrency-safe runtime initialization;
- interruption and supervised background fibers;
- bounded queues, deferred results, and synchronization;
- typed failures and separation of failure, interruption, and defects.

TraceKernel does not use Effect to replace:

- process identity or process tables;
- file descriptor and open-resource state;
- signals and signal policy;
- syscall linearization;
- scheduler-visible behavior;
- protocol contracts crossing worker or language boundaries.

Effect values never cross a worker boundary. Promise-facing adapters may exist
at product integration boundaries without weakening the Effect-native core.

Runtime adapters use a plain structured-cloneable syscall protocol. The
dispatcher composes Effect operations internally and translates typed failures
into POSIX-style wire errors. Requests, byte payloads, descriptor numbers, and
responses remain ordinary data suitable for JavaScript workers, WASM runtimes,
or SharedArrayBuffer transports.

## Descriptor and resource ownership

The session owns kernel resources. Each process owns a descriptor table whose
entries reference session-owned open-resource descriptions.

```text
process fd -> open-resource description -> file | pipe | tty | socket | device
```

The open-resource description owns shared offset/state, flags, reference count,
and resource-specific state. This supports `dup`, deterministic inheritance,
pipe EOF, terminal attachment, socket half-closes, and close-on-exit.

Each process descriptor table has a configurable ceiling, defaulting to 1024
open descriptors. Exhaustion returns `EMFILE` through the plain syscall wire
contract. Closing a descriptor makes the lowest available number reusable.
Failed file, pipe, socket, accepted-connection, and `dup` installs close the
provisional resource or reference before returning, so admission failure cannot
leak a session resource.

Child descriptor inheritance is explicit rather than an implicit side effect of
every spawn. A child may request all parent descriptors or a selected fd set.
The child retains the same numeric fd values, and each inherited entry
duplicates the parent's open-resource description, so offsets, pipe endpoint
counts, socket state, and final-close behavior remain shared. The kernel
validates the complete selection and acquires every reference before publishing
any child entry; `EBADF`, `EMFILE`, or duplication failure closes provisional
references and removes the failed child admission atomically. Omitting the
inheritance request produces an empty descriptor table.

## Shared filesystem

The session filesystem is authoritative. Its subsystem shorthand is **TKFS**
(TraceKernel filesystem); architecture and public documentation call it the
**TraceKernel VFS**. TKFS names the virtual kernel subsystem, not a persistent
on-disk format or storage backend.

TKFS separates namespace bindings from inode-like file nodes:

```text
path -> namespace binding -> node
                         ^
open file description ---|
```

An open file description retains its node when a path is renamed, unlinked, or
atomically replaced. The namespace operation changes future path resolution,
not the identity observed by already-open descriptors.

Multiple namespace bindings may reference the same non-directory node. Hard
links therefore share inode identity, bytes, metadata, and a live link count;
unlink removes one binding and an unlinked open node reports zero links.
Symbolic links are independent nodes containing a literal target. One bounded
resolver follows parent components for every path operation and follows the
final component only when the operation addresses the target. `lstat`,
`readlink`, `unlink`, and rename act on the link entry itself. Resolution is
limited to 40 link traversals and reports `ELOOP` deterministically.

Runtimes do not retain divergent mutable copies. Runtime syscalls use the
descriptor/syscall protocol.

Immutable reads may be cached only against kernel-issued generations. A kernel
mutation invalidates any cache whose generation is no longer current.

The 0.12 filesystem syscall experiment established that synchronous browser
workers can use a SharedArrayBuffer transport and that generation-validated hot
reads can approach snapshot performance. SharedArrayBuffer is one transport
implementation, not part of the public syscall contract.

The 0.13 transport keeps three layers separate:

```text
language filesystem adapter
  -> transport-neutral syscall client
      -> binary SharedArrayBuffer channel | async messages | native adapter
          -> TraceKernel syscall dispatcher
              -> TKFS
```

The synchronous browser channel has one in-flight syscall per runtime worker.
It uses a bounded binary request/response frame and an atomic
idle/request/processing/response/closed state machine. The worker sends only a
lightweight wakeup over its `MessagePort`; syscall bodies remain in shared
memory. A timeout or teardown closes the channel so a late host response cannot
be mistaken for a later process's response.

Bulk file reads return the file bytes and the session cache generation from one
TKFS critical section. Runtime adapters may keep a byte-bounded, entry-bounded
LRU only when the shared generation still equals the generation attached to
that read. Every TKFS mutation advances the shared generation, including host,
editor, and other-process writes. This global token is intentionally
conservative; path-scoped invalidation can be introduced later without changing
the syscall contract.

## Networking

The initial network foundation is session-local TCP:

```text
runtime socket API
  -> process socket descriptor
  -> session network namespace
  -> TCP stream
  -> higher-level protocol adapter
```

The first implemented slice is a local IPv4 namespace. Each session owns an
independent port table, so the same port may be bound in different sessions but
conflicting binds within one session return `EADDRINUSE`. `localhost` resolves
to `127.0.0.1`; `0.0.0.0` is a wildcard listener. Other addresses are rejected
instead of escaping to the host network.

Socket descriptors reference a shared socket open-file description:

```text
process fd
  -> TCP socket description
      -> listener backlog
      |  or
      -> inbound byte stream + outbound byte stream
```

`socket`, `bind`, `listen`, `accept`, `connect`, `send`, `recv`, `shutdown`,
`getsockname`, and `getpeername` use the same transport-neutral syscall
contract as TKFS. Listener backlogs and stream chunk queues are bounded.
`accept`, `recv`, and a connect waiting for backlog space are interruptible.
Write shutdown produces peer EOF without disabling the reverse stream. Final
descriptor close, process exit, listener close, and session teardown wake
blocked operations and release sockets and ports.

The transitional `RuntimeWorkspace` bridge now installs regular files and TCP
sockets in the same process descriptor table and routes all ten socket syscalls
to one workspace-owned TraceKernel network namespace. Capability enforcement
remains host-side: binding/listening requires the listen capability and
connecting requires dispatch capability. This establishes the real product
boundary beneath language-specific socket modules.

The browser JavaScript runtime exposes the first `node:net` adapter:
`createServer`, `Server.listen`, `net.connect`/`createConnection`, duplex socket
reads and writes, address inspection, half-close, and deterministic close.
These event-driven calls use an asynchronous command-port syscall path so a
blocked `accept` or `recv` does not stall the runtime worker. Synchronous file
APIs continue to use the bounded SharedArrayBuffer transport. Both paths reach
the same host dispatcher, process descriptor table, capability checks, and
session network namespace. Cross-process browser conformance proves an echo
exchange and half-close through two independently isolated runtime workers.

The first HTTP/1.1 stream codec is deliberately small and bounded. It
incrementally decodes fragmented request or response bytes, preserves repeated
headers and binary bodies, validates content lengths, and caps the start line,
header bytes, header count, and body bytes. Its initial one-message contract
rejects pipelining, obsolete header folding, and transfer codings other than
identity. Chunked coding and connection reuse require their own conformance
slice rather than silently weakening these bounds.

Structured local HTTP now routes through this substrate. Listener registration
owns a process descriptor and real TCP binding, and a listener-owned accept
loop parses each connection independently. Structured clients use the same
socket, bind, connect, send, receive, shutdown, and close operations as raw
clients. A raw TCP client can therefore speak HTTP to a structured service, and
a raw listener cannot claim a port already owned by structured HTTP.
Graceful listener close stops new accepts but drains already-accepted
connections; process exit and session teardown force-close them and abort their
handler signals.
Each listener admits at most 256 accepted HTTP connections, and an incomplete
request frame is closed after 30 seconds. Malformed, folded, pipelined, or
unsupported transfer-coded requests receive a bounded `400` response without
reaching the application handler.

The path is bidirectional: when a structured local HTTP client finds no
structured listener record, it connects to the advertised loopback TCP port
and speaks the same bounded HTTP/1.1 framing. This lets `node:http`, `fetch`,
curl, and host workspace requests call a raw `node:net` HTTP service. Successful
traffic and transport failures still enter the HTTP journal with `loopback`
provenance; trusted grading metadata remains available only on the structured
control-plane path.

Host-side capabilities, scenario services, journals, and graders remain the
control plane. A short-lived correlation record associates a structured
client's ephemeral source port with its trusted actor, abort signal, logical
URL, and response annotation; none of that authority is serialized into
learner-visible HTTP headers. Only non-runtime listeners may contribute trusted
grading annotations. Synthetic scenario hostnames retain their logical
identity while using private ephemeral loopback transport endpoints; loopback
and wildcard listeners bind their advertised ports directly.

External arbitrary TCP remains unavailable in browser environments; allowed
external HTTP remains a fetch-backed proxy. DNS beyond local aliases, UDP, TLS,
Unix-domain sockets, and the remainder of Node's advanced `net` options remain
later slices.

## Required invariants

After a process exits:

- no process-owned background task remains;
- old streams cannot emit new output;
- descriptors close unless explicitly transferred;
- ports and sockets are released;
- signal and cancellation state cannot affect another process;
- mutable runtime state is reset, validated, or destroyed.

After a session exits:

- its process table and resource registry are empty;
- descendants and runtime leases are gone;
- descriptors, listeners, and sockets are closed;
- session files and environment are unreachable;
- host immutable caches remain reusable.

## Initial implementation sequence

1. Host, session, process, and runtime-lease lifecycles.
2. Process-owned descriptor tables and session resource registry.
3. Standard streams, pipes, blocked I/O, and interruption.
4. Shared VFS syscalls and generation caches.
5. Runtime adapters and cross-language conformance.
6. Virtual network namespace and local TCP.
7. Progressive local HTTP transport migration.

## First product runtime adapter

Browser JavaScript is the first product runtime attached to the 0.13 syscall
wire contract. TypeScript uses the same adapter after compilation; the compiler
itself remains a host service and commits emitted files through the existing
workspace transaction boundary.

During the 0.12-to-0.13 migration, `RuntimeProjectWorkspace` remains the product
filesystem authority and exposes a transitional TraceKernel syscall handler.
That handler is deliberately behind the same transport-neutral request/result
contract as the new session VFS. Moving workspace storage onto the 0.13 session
VFS therefore replaces the handler, not each language adapter.

The browser runtime uses the binary SharedArrayBuffer channel for:

| Runtime API surface | 0.13 syscall |
| --- | --- |
| `readFile`, `readFileSync` | `readFile` |
| default replacement `writeFile`, `writeFileSync` | `writeFile` |
| `stat`, `statSync`, `access`, `existsSync` | `stat` |
| `lstat`, `lstatSync` | `lstat` |
| `realpath`, `realpathSync` | `realpath` |
| `readdir`, `readdirSync` | `readdir` |
| `mkdir`, `mkdirSync` | `mkdir` |
| `rmdir`, `rmdirSync` | `rmdir` |
| `unlink`, `unlinkSync` | `unlink` |
| `link`, `linkSync` | `link` |
| `symlink`, `symlinkSync` | `symlink` |
| `readlink`, `readlinkSync` | `readlink` |
| `rename`, `renameSync` | `rename` |
| recursive `rm`, `rmSync` | `stat` + `readdir` + `unlink` + `rmdir` |

Synchronous, callback, and promise forms share these operations. Conformance
requires that:

- two already-running JavaScript workers observe one authoritative namespace;
- a cached read is invalidated by a peer or host mutation;
- path operations return the same bytes, entry kinds, and POSIX-style errors
  for direct JavaScript and TypeScript-emitted JavaScript;
- actor capabilities and readonly policy are enforced by the host handler, not
  trusted to the runtime;
- the runtime worker bundle contains the transport client but no Effect
  implementation.

Regular-file descriptors are the second JavaScript migration slice. Node
`open`, descriptor `read`/`write`, `close`, `fstat`, `ftruncate`, FileHandle
operations, and file streams now use process-owned descriptor tables behind the
same syscall transport. Positioned I/O leaves the shared open-description
offset unchanged; `dup` shares it; append is linearized at the session-owned
file node. Open descriptions retain inode identity across rename, unlink, and
path replacement, and are closed as a unit when their process exits.

During the storage transition, `RuntimeProjectWorkspace` provides the
process-owned descriptor table and session-level inode nodes while
`KernelObservedFileSystem` remains the backing namespace. Pre-mutation
snapshots preserve the last linked bytes before any host, shell, or peer
deletion. This is an adapter behind the kernel contract, not a separate runtime
filesystem model. The 0.12 in-memory backend intentionally applies
copy-on-write to hard-link paths, so the transitional handler performs a
locked, rollback-capable update of every pathname bound to a TraceKernel inode.
That compatibility rule disappears when TKFS becomes the backing store.

Runtime-spawned workspace children inherit the parent's PGID and SID through
the transitional product bridge as well as the extracted kernel. Node
`child_process.spawn({ detached: true })` requests a child-led process group,
creates a child-led session, and `process.kill` accepts the same positive,
zero, negative-PGID, and `-1` selectors as the kernel syscall. Python maps
`subprocess.Popen(start_new_session=True)`, `process_group`, `os.kill`, and
`os.killpg` onto the same mechanism. Managed C# exposes
`SpawnOptions.StartNewSession`, `KernelProcess.Signal`, and
`KernelProcess.SignalProcessGroup`. Browser conformance creates detached
JavaScript leaders with JavaScript descendants from Node, Python, and C#
parents and proves one negative PGID signal terminates each tree without
reaching its parent.

The C/C++ WASI process compatibility slice is intentionally smaller than a
complete host libc. It supports exact-child blocking `waitpid`, `SIGINT`,
`SIGTERM`, and `SIGKILL`, and maps `posix_spawnp` through TraceKernel's runtime
command resolver. An explicit `envp` is forwarded as child environment
overrides; a null `envp` inherits the parent environment. Ordered
`posix_spawn_file_actions_adddup2` and `addclose` operations run against the
child descriptor table after inheritance and structured stdio setup.
Nonblocking and selector-based waits, arbitrary signal handlers,
PATH-compatible executable search, and `addopen` remain explicit later slices
rather than silently falling back to WASI placeholders.

Filesystem watches are now session resources exposed through process-owned
descriptors. `watch(path)` installs an `fs-watch` descriptor; ordinary
descriptor `read` blocks for a bounded binary event frame, and `close` or
process exit interrupts that read and unregisters the watch. Notifications are
published only after the authoritative namespace mutation commits, so host,
editor, sibling-process, and self mutations share one ordering source.
Directory watches may be recursive, queues are bounded, and dropped events
produce an explicit overflow record instead of silently presenting a complete
history. Browser JavaScript `fs.watch` and `fs.promises.watch` consume this
descriptor asynchronously while synchronous filesystem mutations continue to
use the SharedArrayBuffer syscall path.

Device and proc descriptors and descriptor metadata mutation remain on the
command-local compatibility surface. They should move only with their
corresponding kernel resource or namespace model.

## Implemented foundation

The initial 0.13 branch now establishes:

- scoped host and session resources;
- lazy, concurrency-deduplicated runtime provider initialization;
- session-owned process supervision;
- process-owned runtime leases released on exit, failure, signal, or teardown;
- explicit process lifecycle and termination records;
- lease-level graceful `SIGINT`/`SIGTERM` delivery with a kernel-owned deadline
  and unconditional `SIGKILL` force interruption;
- process-owned watchdog arm, pet, status, disarm, expiry, signal delivery, and
  teardown with a transport-neutral syscall and JavaScript adapter;
- process environment isolation;
- process-owned descriptor tables;
- atomic `dup2` replacement with validated self-duplication, descriptor-ceiling
  replacement, displaced-resource close, and failure rollback;
- explicit all-or-selected child descriptor inheritance plus atomic
  parent-fd-to-child-fd mappings, with shared open descriptions and failure
  rollback;
- ordered spawn-time descriptor `dup2` and close actions with whole-child
  rollback on failure;
- session-owned pipe resources;
- session-owned bounded filesystem-watch resources with descriptor lifecycle,
  cross-process and host mutation delivery, and explicit overflow;
- fragmented pipe reads, bounded chunk backpressure, EOF on final-writer close,
  and blocked-read wakeup when the reader process exits;
- an authoritative session regular-file store with mutation generations;
- a TKFS directory namespace with inode-like identity, metadata, deterministic
  directory reads, recursive creation, removal, and POSIX-style errors;
- file-backed open-resource descriptions with independent offsets per open and
  shared offsets after `dup`;
- atomic append/truncate behavior and stable open file nodes across
  unlink-and-recreate;
- atomic file replacement and directory-subtree rename while existing
  descriptors remain attached to their original nodes;
- hard-link identity, shared contents, and live link counts;
- relative and absolute symbolic links with `stat`/`lstat` separation,
  dangling-link behavior, parent-component traversal, realpath, and bounded
  loop detection;
- cross-process visibility without private mutable file snapshots;
- a language-neutral syscall dispatcher covering descriptor I/O and namespace
  operations whose wire contract does not expose Effect;
- a transport-neutral synchronous runtime adapter plus a bounded binary
  SharedArrayBuffer implementation for dedicated browser workers;
- atomic versioned bulk reads and a bounded generation-validated runtime read
  cache that invalidates across concurrent processes;
- a browser JavaScript/TypeScript path adapter using the real binary syscall
  transport, with cross-worker live data and namespace visibility plus browser
  conformance coverage;
- a browser C/C++ adapter using that same binary transport for TKFS, BSD TCP,
  process watchdog controls, and kernel-supervised child processes; in
  addition to `system()`, the injected WASI compatibility layer provides
  `posix_spawn`/`posix_spawnp`, spawn attributes for process groups and new
  sessions, `waitpid`, `kill`/`killpg`, process identity calls, and descriptor
  remapping actions, with real cross-language process-group and inherited-fd
  conformance;
- the browser Python/Pyodide adapter's first general synchronous binary
  syscall client, with `tracekernel.watchdog` process controls and an explicit
  `tracekernel.fs` path-operation surface backed by authoritative TKFS;
- a Pyodide filesystem mount that backs ordinary Python `open`, `os`, and
  `pathlib` path and regular-file descriptor operations with TKFS, including
  positioned I/O, truncate, rename, symlink traversal, and kernel-owned
  descriptor cleanup;
- Python `tracekernel.process` and `subprocess` adapters for kernel-supervised
  JavaScript and Python children, including process-owned piped stdio,
  synchronous wait/reap, signal delivery, shared TKFS visibility, and
  separate-worker interpreter isolation;
- a Python `socket` adapter for blocking IPv4 TCP sockets backed by
  process-owned TraceKernel descriptors, with bind/listen/accept/connect,
  fragmented send/recv, half-close, address inspection, and cross-language
  Python/JavaScript stream conformance; nonblocking mode, socket deadlines,
  UDP, and broader address-family compatibility remain later slices;
- a browser C# binary syscall client and Emscripten filesystem mount that back
  ordinary managed `System.IO` path and regular-file descriptor operations
  with authoritative TKFS; the mount preserves kernel-owned open-file offsets,
  truncate/rename behavior, cross-process visibility, and process-exit cleanup;
  the public managed `TraceKernel.Watchdog` surface arms, pets, inspects, and
  disarms the process-owned kernel watchdog;
- managed C# `KernelProcess`, `KernelDescriptor`, and `KernelPipe` surfaces for
  spawn, selected/all descriptor inheritance, piped stdio, raw descriptor I/O,
  signal delivery, synchronous wait/reap, and descriptor duplication/close;
  real browser conformance covers C# parents spawning both JavaScript and C#
  children, same-language worker/static-state isolation, shared TKFS mutation,
  and a JavaScript child writing through a selected inherited C# pipe fd;
- runtime process leases now declare preinstalled descriptor identities, and
  the JavaScript/Node adapter seeds those identities as direct kernel-backed
  descriptors so inherited file, pipe, and socket numbers remain usable without
  a runtime-local reopen;
- managed C# `KernelSocket` TCP descriptors with ephemeral/exclusive bind,
  listen/accept/connect, bounded fragmented send/receive, endpoint inspection,
  read/write/both half-close, and deterministic close; browser conformance
  covers C# listeners serving JavaScript and C# children through the same
  session-local virtual network namespace;
- browser C# symbolic-link snapshots and ordinary `System.IO` link traversal,
  creation, and target inspection backed by TKFS, plus managed hard-link,
  `readlink`, and `realpath` operations that preserve inode identity and raw
  link text; the legacy non-kernel runner continues to reject link snapshots;
- managed C# `KernelFileWatcher` descriptors with bounded recursive queues,
  fragmented frame reconstruction, explicit rename/change/overflow events, and
  close-on-dispose/process-exit; cross-language conformance observes a
  JavaScript child mutation through the C# parent watcher;
- process-owned regular-file descriptors in the JavaScript runtime, including
  independent open offsets, shared offsets after `dup`, positioned I/O,
  append, `fstat`, `ftruncate`, FileHandle and stream integration, automatic
  process-exit cleanup, and stable open nodes across rename/unlink/replacement;
- an isolated session-local TCP namespace with process-owned socket
  descriptors, exclusive port binding, bounded listener backlogs, blocking
  accept/connect, bidirectional fragmented streams, sender backpressure,
  half-close semantics, address inspection, and deterministic teardown;
- TCP syscall frames proven across two independent synchronous runtime workers;
- exactly-once lease and resource cleanup assertions.

The pipe is intentionally the first descriptor resource. It exercises blocking,
interruption, endpoint lifecycle, and backpressure before the same contracts are
applied to files, terminals, and sockets.

The governing invariant is:

> Reuse immutable host infrastructure. Isolate mutable session state. Processes
> own executions and descriptors. TraceKernel owns resources and every
> observable state transition.
