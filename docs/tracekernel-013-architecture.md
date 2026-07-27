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

Logical PID 1 is also a real wait owner even though the workspace bootstrap
process is not materialized as a runtime lease. A top-level spawn may request
retention after exit; its zombie then consumes process capacity until the host
reaps it through the same exact/any/group selector machinery used by ordinary
parents. Scoped `execute()` and non-retained host work auto-reap. This keeps
interactive shell jobs waitable without making every one-shot host command a
zombie or delegating top-level reaping to a second product process table.
Live-only inspection remains available for runtime coordination, while the
actor-filtered authoritative process-table snapshot includes retained exited
children until their parent reaps them. `/proc`, `ps`, and `jobs` can therefore
migrate to kernel state without inferring zombies from completion callbacks.

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

Scheduling state is orthogonal to lifecycle. A live process is `queued`,
`running`, or `blocked`; the host scheduler publishes those transitions through
the owning session instead of maintaining the inspection authority itself.
Starting a runtime lease defaults to `running`, while the product command
scheduler explicitly publishes `queued` before admission and `running` when
its callback begins. Process snapshots and scheduler diagnostics therefore
remain truthful even though TraceKernel does not dictate a particular host
scheduling algorithm.

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

`RuntimeProjectWorkspace` now uses TKFS as its physical backing store beneath
the existing policy, quota, event, and shell compatibility wrapper. The product
workspace and its internally owned extracted `TraceKernelSession` attach to the
same TKFS object; there is no live file mirror. Runtime caches receive TKFS's
own shared generation word. TKFS quota checks run inside the same critical
section as namespace and open-file-description mutations, including hard-link
accounting and already-open fd writes.

Every committed TKFS mutation carries its semantic operation and an optional
opaque in-process origin. The host compatibility adapter tags its own commits;
all untagged session/process commits invalidate product snapshot generations
and storage ledgers immediately. Origin is identity-only and never crosses the
runtime syscall boundary, avoiding async timing heuristics and duplicate host
observation.

TKFS checkpoints separate namespace entries from inode records, preserving
hard links, symlinks, metadata, and mutation generation. A host may hydrate a
new session from that lossless image or attach one host-owned TKFS to exactly
one live session. Session shutdown does not clear host-owned storage.

The syscall dispatcher also canonicalizes existing paths and missing-path
parents before applying the session filesystem policy. This closes symlink
aliases over hidden and readonly paths. Product runtime path syscalls now
terminate in that extracted session and use the calling process cwd; their
commits are therefore direct, process-side TKFS mutations.

Existing product executors attach through `TraceKernelControlledRuntime`.
TraceKernel allocates the PID and owns topology, descriptors, signal delivery,
interruption, and lease cleanup; the host runner only reports its eventual
execution result. This is the deliberate cutover seam for removing the
workspace's transitional process identity without rewriting every language
engine first.

Product command runners and language-initiated children now use those
kernel-allocated PIDs and topology records. Non-zombie child completion is
reaped from the session alongside the product wait model, so process capacity
is released once.

Every controlled product process also receives kernel-owned detached standard
descriptors: fd 0 is a `/dev/null` EOF reader and fd 1/2 are discard writers.
They are real device descriptors, not reserved integers, so subsequent file,
pipe, watch, and socket allocation begins at fd 3 in the single process table.
Terminal processes atomically replace those entries with read/write views of
one session-owned terminal resource before user code starts. Validation occurs
before the three-entry descriptor-table commit and replaced open descriptions
close only after all new identities are visible.

The workspace bootstrap session has a host-created console boundary because
its conventional session leader is kernel PID 1, outside the user process
table. A top-level process may bootstrap that console through a host-only API;
runtime syscalls cannot acquire terminals this way. Later processes in the
same session inherit controlling-terminal identity, while only processes
launched with terminal presentation remap stdio. `isatty`, `tcgetpgrp`, and
`tcsetpgrp` now read and mutate this kernel terminal and its process groups.

Runtime regular files, pipes, filesystem watches, and local TCP sockets now
share that same authoritative process descriptor table. `open`, descriptor
I/O, duplication, polling, metadata, socket operations, and child descriptor
inheritance dispatch through the extracted session. Structured child stdio is
created before the runtime lease starts, so fd mappings and ordered
dup/close actions are visible to the child from its first instruction.
Admission rollback kills an unpublished kernel child and closes every
parent-side pipe endpoint, preserving the no-orphan/no-leak invariant even
when the product scheduler rejects after kernel allocation.

Terminal input is now published to the session-owned terminal queue, so runtime
reads from kernel fd 0 block and resume on host input. During adapter migration
the same bytes are also fed to the legacy runner stdin pipe; each adapter uses
one input surface, and the dual feed can disappear after every language reads
stdio through descriptors. Runtime writes to kernel terminal fd 1/2 are drained
from the shared terminal queue and published through the calling command's
output controller, preserving PID/actor attribution without leaving a shadow
queue. Input EOF is a one-shot terminal marker: it releases one blocked fd 0
read with zero bytes without closing the terminal or poisoning later commands.
VINTR/VQUIT bytes enter the kernel terminal line discipline, which flushes
unread input and signals the authoritative foreground group. The compatibility
frontend recognizes them only to avoid duplicating control bytes into the
legacy runner pipe. Process-lifecycle compatibility state, journal, and
host-only structured HTTP adapter remain transitional. Foreground signal
selection/delivery and resize terminate at the session-owned terminal; their
product events are read-through diagnostics of kernel state. Host HTTP calls
that have no runtime process context intentionally use the compatibility
service; runtime socket calls never do.

Runtime identity, signal selection and delivery, `setsid`, and `setpgid` also
dispatch through the extracted session. The product process record is now a
read-through compatibility projection after topology changes rather than the
decision-maker for those operations. Foreground compatibility state releases
a process group only after its final live terminal member exits; one child
cannot detach its surviving group peers. Product-level wait publication and
shell job listings remain until the terminal/lifecycle cutovers can remove the
projection entirely.

Shell `fg` and `bg` placement now terminates in the extracted session rather
than toggling only product metadata. Foregrounding a compatibility job
atomically replaces fd 0/1/2 with descriptors for the session console before
transferring that terminal's foreground process-group ID. If this command was
the only reason a formerly detached product job acquired terminal stdio,
backgrounding it atomically restores null-device descriptors and returns
foreground ownership to the host console boundary only if that group still
owns it; backgrounding a stale/non-foreground job cannot steal placement from
a newer foreground group. The process remains a member of the console's
controlling session: controlling-terminal identity is session topology, while
standard descriptor placement is process state. Product `tty` and foreground
fields are a temporary read-through presentation of those two kernel facts.

`/proc`, `ps`, and `jobs` now enumerate the actor-filtered authoritative
process-table snapshot. PID topology, command/cwd/environment, scheduling
state, live versus
unreaped-zombie state, termination, descriptor count, and foreground-group
membership are projected from TraceKernel on every read. Product records
provide only presentation fields such as UI actor labels and the compatibility
tty label. Corrupting the
product topology or lifecycle projection cannot change these inspection
surfaces. Process-control commands still resolve their concrete host execution
handle through the product record after selecting the authoritative PID.

Runtime watchdog arm, status, pet, disarm, and expiry are process-owned kernel
operations as well. The deadline fiber is scoped to the session, is cleared by
process completion and teardown, and delivers its configured signal through
the same authoritative process signal path. Product shell diagnostics retain
a compatibility presentation but no runtime watchdog timer.

Language `wait` now lets the kernel select and reap the child first, including
exact, any-child, caller-group, named-group, and nonblocking selectors. The
product zombie table is reconciled afterward only for legacy shell/proc
presentation. Controlled runtime results carry an optional explicit
termination record, so cooperative host signal delivery remains
`signal(SIGTERM)` rather than being collapsed into an unrelated `exit(143)`.
Top-level product commands opt into logical-PID-1 retention. Normal completion
auto-reaps that kernel child; shell-retained jobs remain waitable, and the
compatibility `wait` command's final reap now terminates at PID 1 in the
extracted session. Shell exact/any selection also starts in PID 1; the selected
kernel PID is reconciled with product completion only to publish the legacy
formatted result. A wait requested before host execution completes marks the
candidate waitable before entering the kernel, preventing normal host
auto-reaping from racing PID 1. Expired compatibility zombies are likewise
reaped from their authoritative parent instead of leaking kernel capacity.
Formatted wait publication remains transitional.

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
`os.killpg` onto the same mechanism. Its subprocess adapter translates
Pyodide-local descriptors for `pass_fds`, numeric stdio, `close_fds=False`,
and `stderr=STDOUT` into kernel mappings and ordered child actions. Managed C# exposes
`SpawnOptions.StartNewSession`, `KernelProcess.Signal`, and
`KernelProcess.SignalProcessGroup`. Browser conformance creates detached
JavaScript leaders with JavaScript descendants from Node, Python, and C#
parents and proves one negative PGID signal terminates each tree without
reaching its parent.

Node `child_process` also accepts numeric entries in the `stdio` array. The
adapter converts each parent-fd/child-index pair into an atomic kernel
descriptor mapping, including descriptors above stderr, while string
`pipe`/`inherit`/`ignore` modes retain their structured behavior. Arbitrary
extra piped descriptors and IPC channels return `ENOSYS` until the spawn
response can return a variable set of parent pipe endpoints.

Kernel wait/reap implements the traditional child selectors: a positive PID
waits for that exact child, `-1` waits for any child, `0` waits for a child in
the caller's process group, and a value below `-1` waits for a child in that
PGID. `WNOHANG` returns a running state without reserving or reaping a child.
An exited child is reaped exactly once; subsequent or competing waits return
`ECHILD`, and concurrent selector waiters cannot claim the same child.
Selection is event-driven and process-group changes wake affected waiters.
C++ maps the contract to ordinary `waitpid`, Python exposes `os.waitpid`,
`os.wait`, `Popen.poll()`, and timed waits, and managed C# exposes
`KernelProcess.WaitChild`/`TryWaitChild` in addition to instance waits.
JavaScript keeps its event-driven `ChildProcess` completion path on the same
authoritative blocking wait.

Process admission validates topology before allocating a PID or runtime lease.
A child can inherit its parent's session, create a new session (which also
makes it the process-group leader), or join an existing process group in that
same session. Foreign sessions, negative identifiers, and nonexistent or
cross-session groups fail atomically with `EINVAL`.

Running processes can mutate their own topology through kernel-owned
`setsid`/`setpgid` syscalls. The kernel rejects `setsid` for an existing group
leader, rejects process-group changes by session leaders, and permits group
joins only when the target group exists in the caller's session. C++ maps the
POSIX functions, Python maps `os.setsid`/`os.setpgid` plus identity queries,
and managed C# exposes caller-scoped session/group controls; JavaScript keeps
using its native `child_process` detached-spawn surface.

Process identity is also a syscall result rather than immutable worker-start
metadata. `pid`, `ppid`, `pgid`, and `sid` are read from the live process
record, so topology mutations and orphan reparenting are immediately visible
inside the runtime. The syscall can target the caller or another visible
process in the same session. C/C++ identity calls (including
`getpgid(child)`/`getsid(child)`), Python `os.getpid`/`getppid`/`getpgrp`/
`getpgid`/`getsid`, JavaScript `process.ppid`, and managed C#
`KernelProcess.GetIdentity` share that query. The transitional product bridge
reparents independently running children to logical init PID 1 when their
runtime parent exits, matching the extracted kernel rather than leaving a
stale parent snapshot in the child worker.

JavaScript child handles participate in process lifetime in the normal Node
shape: a referenced child keeps the parent worker's event loop alive, while
`ChildProcess.unref()` releases only that lifetime reference. The child process,
kernel wait, descriptors, and execution continue independently; if the parent
then exits, the host reparents the child and its live `process.ppid` becomes 1.
Piped stdio retains its own references, so unref does not incorrectly discard
active stream handles.

Descriptor-table entries also carry kernel-owned close-on-exec state.
`inheritDescriptors: "all"` filters `FD_CLOEXEC` entries in the kernel, while
explicit mappings remain spawn file actions and can intentionally pass a
flagged descriptor. `dup` and `dup2` create inheritable targets, matching the
traditional descriptor-flag rule. The binary syscall contract exposes the
flag through `fcntl`; C++ maps `F_GETFD`/`F_SETFD`, Python maps
`os.get_inheritable`, `os.set_inheritable`, and the `fcntl` module, JavaScript
marks Node-opened files close-on-exec, and managed C# exposes
`KernelDescriptor.CloseOnExec`/`Inheritable`.

`pipe2(O_CLOEXEC)` publishes both pipe endpoints with their descriptor flags
already set, and `dup3(..., O_CLOEXEC)` atomically replaces and flags its
target. The kernel rejects identical `dup3` source and target descriptors with
`EINVAL`; ordinary `dup2` retains its validated no-op and clears the target's
close-on-exec bit. C/C++ maps these through its forced WASI compatibility
header (including a nonzero `O_CLOEXEC` value), while managed C# exposes the
same atomic choices through `KernelPipe.Create` and
`KernelDescriptor.DuplicateTo`.

`O_NONBLOCK` is an open-description status flag, so a change through any
duplicated or inherited descriptor is immediately visible through every other
reference to that description. Nonblocking empty pipe reads and full pipe
writes, empty TCP receives and listener accepts, and backpressured TCP sends
return `EAGAIN`; queued data and final-writer or peer-FIN EOF retain their
normal distinct results. `pipe2(O_NONBLOCK)` publishes both endpoint
descriptions with the flag already set, and `fcntl` can inspect or mutate it
afterward. C/C++ maps `F_GETFL`/`F_SETFL`, Python maps `os.get_blocking`,
`os.set_blocking`, socket `setblocking`/`settimeout(0)`, and `fcntl`, and
managed C# exposes `KernelDescriptor.Nonblocking` and
`KernelSocket.Nonblocking`. Nonblocking connect is a descriptor-owned,
session-scoped operation: the initiating call returns `EINPROGRESS`, a second
call while pending returns `EALREADY`, write/error readiness reports
completion, and `getsockopt(SO_ERROR)` consumes the final error exactly once.
Final close interrupts the pending connection and releases its provisional
binding.

Descriptor readiness is one level-triggered kernel syscall rather than a
runtime-specific probe loop. `poll` snapshots regular files, pipes, filesystem
watches, TCP listeners, and connected TCP streams; state transitions complete
descriptor-owned deferred signals, while an explicit caller timeout is the
only timer. Pipe capacity, queued watch events, listener backlogs, TCP stream
capacity, EOF, HUP, error, and invalid descriptors therefore share one
process-owned FD contract. C/C++ maps both `poll(2)` and `select(2)`, Python
maps `select.poll`, `select.select`, and the standard `selectors` module, and
managed C# exposes `KernelPoll`. JavaScript retains its event-driven Node
streams while its binary syscall codec shares the same poll frame contract.
Python `os.pipe` and `os.pipe2` install ordinary Pyodide descriptor identities
whose stream operations reference the kernel endpoints. Consequently
`os.read`/`write`/`close`, `dup`, inheritable flags, `pass_fds`, and
cross-language child mappings do not require a parallel Python-only pipe
registry. Python's `os.pipe` follows PEP 446 and defaults both endpoints to
close-on-exec; `os.pipe2` retains explicit `O_CLOEXEC` and `O_NONBLOCK`
behavior.

The C/C++ WASI process compatibility slice is intentionally smaller than a
complete host libc. It supports blocking and nonblocking `waitpid` with exact,
any-child, caller-PGID, and named-PGID selectors, `SIGINT`, `SIGTERM`, and
`SIGKILL`, and maps `posix_spawnp` through TraceKernel's runtime command
resolver. An explicit `envp` is forwarded as child environment overrides; a
null `envp` inherits the parent environment. Ordered
`posix_spawn_file_actions_adddup2` and `addclose` operations run against the
child descriptor table after inheritance and structured stdio setup.
Arbitrary signal handlers, PATH-compatible executable search, stopped/continued
child states, and `addopen` remain explicit later slices rather than silently
falling back to WASI placeholders.

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
- lease-level graceful `SIGHUP`/`SIGINT`/`SIGQUIT`/`SIGTERM` delivery with a
  kernel-owned deadline and unconditional `SIGKILL` force interruption;
- process-owned watchdog arm, pet, status, disarm, expiry, signal delivery, and
  teardown with a transport-neutral syscall and JavaScript adapter;
- process environment isolation;
- process-owned descriptor tables;
- atomic `dup2` replacement with validated self-duplication, descriptor-ceiling
  replacement, displaced-resource close, and failure rollback;
- atomic `dup3` replacement plus close-on-exec pipe creation, with C/C++ and
  managed C# runtime conformance;
- open-description `O_NONBLOCK` state shared across descriptor duplication
  and inheritance, with typed pipe `EAGAIN` behavior and C++, Python, and C#
  runtime conformance;
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
- authoritative process-identity queries that expose live parent, process
  group, and session topology across runtime workers, including product-bridge
  orphan reparenting to PID 1;
- session-owned controlling terminals with process-owned terminal descriptors,
  foreground process-group transfer, background-read rejection, new-session
  detachment, host/process byte streams, and kernel-owned terminal snapshots;
- terminal job-control syscalls (`isatty`, `tcgetpgrp`, and `tcsetpgrp`) across
  JavaScript/TypeScript, C/C++, Python, and C#, including ordinary runtime API
  surfaces rather than TraceKernel-only test hooks;
- authoritative terminal-generated `VINTR` and `VQUIT` delivery to the
  foreground process group, plus `SIGHUP` delivery and controlling-session
  detachment when the terminal closes;
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
  remapping actions, plus `poll`/`select` readiness and nonblocking socket I/O,
  with real cross-language process-group and inherited-fd conformance;
- the browser Python/Pyodide adapter's first general synchronous binary
  syscall client, with `tracekernel.watchdog` process controls and an explicit
  `tracekernel.fs` path-operation surface backed by authoritative TKFS;
- a Pyodide filesystem mount that backs ordinary Python `open`, `os`, and
  `pathlib` path and regular-file descriptor operations with TKFS, including
  positioned I/O, truncate, rename, symlink traversal, and kernel-owned
  descriptor cleanup;
- Python `os.pipe`/`os.pipe2` descriptors backed by session-owned kernel pipes,
  including duplication, close-on-exec flags, and inheritance into a
  JavaScript child through `pass_fds`;
- Python `tracekernel.process` and `subprocess` adapters for kernel-supervised
  JavaScript and Python children, including process-owned piped stdio,
  synchronous wait/reap, signal delivery, local-to-kernel descriptor
  inheritance/remapping, shared TKFS visibility, and separate-worker
  interpreter isolation; ordinary `os.waitpid`/`os.wait` expose exact,
  any-child, caller-PGID, and named-PGID selection with `WNOHANG`, POSIX status
  words, and `ChildProcessError(ECHILD)`;
- a Python `socket` adapter for IPv4 TCP sockets backed by
  process-owned TraceKernel descriptors, with bind/listen/accept/connect,
  fragmented send/recv, half-close, address inspection, local Pyodide
  descriptor identities, poll/select/selectors readiness, nonblocking
  accept/connect/receive/send, `SO_ERROR`, and cross-language
  Python/JavaScript stream conformance; positive socket deadlines, UDP, and
  broader address-family compatibility remain later slices;
- a browser C# binary syscall client and Emscripten filesystem mount that back
  ordinary managed `System.IO` path and regular-file descriptor operations
  with authoritative TKFS; the mount preserves kernel-owned open-file offsets,
  truncate/rename behavior, cross-process visibility, and process-exit cleanup;
  the public managed `TraceKernel.Watchdog` surface arms, pets, inspects, and
  disarms the process-owned kernel watchdog;
- managed C# `KernelProcess`, `KernelDescriptor`, and `KernelPipe` surfaces for
  spawn, selected/all descriptor inheritance, atomic parent-to-child descriptor
  mappings, ordered child `dup2`/close actions, piped stdio, raw descriptor I/O,
  signal delivery, synchronous wait/reap, selector-based
  `WaitChild`/`TryWaitChild`, and descriptor duplication/close;
  real browser conformance covers C# parents spawning both JavaScript and C#
  children, same-language worker/static-state isolation, shared TKFS mutation,
  and a JavaScript child writing through a remapped inherited C# pipe fd;
- runtime process leases now declare preinstalled descriptor identities, and
  the JavaScript/Node adapter seeds those identities as direct kernel-backed
  descriptors so inherited file, pipe, and socket numbers remain usable without
  a runtime-local reopen;
- managed C# `KernelSocket` TCP descriptors with ephemeral/exclusive bind,
  listen/accept/connect, bounded fragmented send/receive, endpoint inspection,
  read/write/both half-close, nonblocking state, and deterministic close;
  `KernelPoll` multiplexes pipe, listener, stream, and watch descriptors, and
  `GetAndClearConnectError` exposes asynchronous connect completion.
  Browser conformance covers C# listeners serving JavaScript and C# children
  through the same session-local virtual network namespace;
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
  half-close semantics, address inspection, descriptor readiness,
  nonblocking accept/connect/receive/send, consume-on-read connection errors,
  and deterministic teardown;
- TCP syscall frames proven across two independent synchronous runtime workers;
- exactly-once lease and resource cleanup assertions.

The pipe is intentionally the first descriptor resource. It exercises blocking,
interruption, endpoint lifecycle, and backpressure before the same contracts are
applied to files, terminals, and sockets.

## Remaining kernelization gates

The syscall contract and language adapters are no longer the main migration
risk. Product storage is now authoritative TKFS and the workspace owns an
extracted session over that same object. Product process identity, TKFS, and
runtime file/pipe/watch/TCP/terminal descriptors are now authoritative
TraceKernel state. The product still has a legacy stdio feed, shell
process-control presentation, journal/resource event attribution, and a
host-only structured HTTP service.

The remaining authority migration must preserve, in order:

1. move every language adapter onto descriptor stdio, then remove the temporary
   legacy input dual feed and its control-byte suppression; metadata, resize,
   input/output bytes, one-shot EOF, line discipline, foreground signal
   delivery, and fd 0/1/2 descriptors are already authoritative;
2. move remaining host execution handles behind kernel-owned process metadata,
   then delete the mutable product topology/lifecycle projection;
   scheduler state, shell/language wait selection and reaping, `/proc`, `ps`,
   `jobs`, foreground-group/descriptor placement, and logical PID 1 ownership
   already read or mutate authoritative state;
3. attribute journal and resource events directly to the authoritative process
   and eliminate the remaining transitional lifecycle observations;
4. migrate local structured HTTP onto TCP only after the HTTP conformance
   corpus proves fragmented reads, backpressure, half-closes, cancellation, and
   concurrent connections; host-only fetch egress remains a protocol service;
5. crash recovery that destroys or revalidates every mutable runtime lease while
   retaining only immutable host caches.

Suspended job control (`SIGTSTP`, `SIGTTIN`, `SIGTTOU`, and `SIGCONT`) is a
separate runtime-contract gate. Browser hosts cannot honestly suspend arbitrary
CPU-bound worker code by changing process-table metadata. TraceKernel must add a
runtime lease suspend/resume capability, and each language adapter must prove
that capability, before exposing those signals as supported.

Terminal window-size ioctls and `SIGWINCH`, additional termios modes, positive
socket deadlines, UDP, broader DNS/address-family behavior, and Unix-domain
sockets remain later subsystem slices. TraceJVM should attach through the same
session/process/descriptor contracts rather than adapting the legacy CheerpJ
filesystem layout into the kernel.

The governing invariant is:

> Reuse immutable host infrastructure. Isolate mutable session state. Processes
> own executions and descriptors. TraceKernel owns resources and every
> observable state transition.
