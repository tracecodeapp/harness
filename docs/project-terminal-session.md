# Project Terminal Sessions

Project workspaces expose a terminal session API for apps that want a real
terminal surface instead of calling `workspace.runCommand(...)` directly. The
session owns shell prompt state, current working directory, command lifecycle,
and live stdin handoff for programs that ask the user for input.

Use this API for IDE terminals, fullscreen project terminals, interview
workspaces, and any consumer UI that needs to show an active
`user@host cwd $` command line.

## Basic Usage

```ts
import { createBrowserProjectWorkspace } from '@tracecode/harness/browser/project';
import type {
  RuntimeCommandEvent,
  RuntimeProjectTerminalInputState,
} from '@tracecode/harness/core';

const workspace = await createBrowserProjectWorkspace({
  assetBaseUrl: '/workers',
  kernel: {
    user: { username: 'ada' },
    host: { hostname: 'tracevm' },
    workspace: { name: 'weather-api' },
  },
  files: [
    { path: 'main.py', contents: 'name = input("Name: ")\nprint(f"hello {name}")\n' },
  ],
});

function renderInputState(state: RuntimeProjectTerminalInputState): void {
  promptElement.textContent = state.label;
  inputElement.value = '';
  inputElement.disabled = state.disabled;
  formElement.hidden = state.hidden;
  if (!state.hidden && !state.disabled) inputElement.focus();
}

const terminal = workspace.createTerminalSession({
  columns: 120,
  rows: 32,
  onTerminalEvent: (event) => {
    if (event.type === 'input-state') renderInputState(event.state);
  },
});

renderInputState(terminal.inputState);

async function submitCommand(command: string): Promise<void> {
  appendLine(`${terminal.prompt.text} ${command}`, 'command');

  const result = await terminal.run(command, {
    onEvent: (event: RuntimeCommandEvent) => {
      if (event.type !== 'output') return;

      // A stdin prompt is already represented by terminal input state.
      // Most terminal UIs should not also append it as a committed output line.
      if (event.terminal?.role === 'stdin-prompt') return;

      appendOutput(event.stream, event.data);
    },
  });

  // Keep exitCode for command state and automation. Interactive shells do not
  // print a synthetic `exit N` line after every failed command.
}

function submitInput(value: string): void {
  const state = terminal.inputState;

  if (state.mode === 'stdin') {
    appendLine(`${state.label}${value}`, 'stdin');
    terminal.writeStdin(`${value}\n`);
    return;
  }

  if (state.mode === 'command') {
    void submitCommand(value.trim());
  }
}
```

## Input State Contract

`terminal.inputState` is the source of truth for the active input row:

```ts
type RuntimeProjectTerminalInputMode = 'command' | 'busy' | 'stdin';

interface RuntimeProjectTerminalInputState {
  mode: RuntimeProjectTerminalInputMode;
  prompt: RuntimeProjectTerminalPrompt;
  label: string;
  hidden: boolean;
  disabled: boolean;
  command?: string;
}
```

Render the row from `label`, `hidden`, and `disabled`.

- `command`: the terminal is ready for a shell command. `label` is the shell prompt, for example `ada@tracevm weather-api $`.
- `busy`: a command is running but the process has not requested stdin. Hide or disable the input row; this matches normal terminal behavior while a foreground process owns the tty.
- `stdin`: the running process printed an unterminated stdout prompt. `label` is that process prompt, for example `Name: `. Submit user text with `terminal.writeStdin(...)`.

State changes are emitted through `onTerminalEvent` with one of these reasons:

- `command-start`
- `stdin-prompt`
- `stdin-submit`
- `stdin-eof`
- `command-finish`

The session also accepts a per-run `onTerminalEvent` in `terminal.run(command,
options)`. Use the session-level handler for UI rendering and the per-run
handler when a single command needs additional instrumentation.

## Prompt And Cwd

`terminal.prompt` exposes structured prompt data:

```ts
interface RuntimeProjectTerminalPrompt {
  user: string;
  host: string;
  cwd: string;
  label: string;
  text: string;
}
```

The prompt is derived from TraceKernel identity and the session cwd. Built-in
`cd` and leading compound commands such as `cd src && npm test` update the
terminal session cwd. Programmatic `workspace.runCommand(...)` calls do not
change a terminal session's cwd.

Use `terminal.prompt.text` when echoing submitted commands. Use
`terminal.inputState.label` when echoing stdin responses, because stdin prompts
belong to the running process rather than the shell.

The workspace and every terminal start with one coherent TraceKernel identity:
`USER`, `LOGNAME`, `HOME`, `HOSTNAME`, `SHELL`, `PATH`, `TMPDIR`, and `LANG`
match the configured kernel user and host. The standard home, `/tmp`, and
`/var/tmp` directories exist before the first command. `whoami`, `id`,
`hostname`, and `uname` report that identity; `uname` reports TraceKernel and
never invents a Linux host. `/tracekernel/bin` leads `PATH`, making shell
discovery commands report the same virtual executable path used for dispatch.

Each terminal also owns a file-creation mask, defaulting to `0022`. `umask`
prints it, `umask MODE` accepts octal or symbolic updates for later submissions
in that terminal, `umask -S` shows the corresponding allowed permissions, and
`umask -p` emits a reusable shell command. New files and directories created by
shell commands honor the active mask. Programmatic
`workspace.runCommand(...)` calls are separate process invocations and start
from `0022` unless the caller supplies `RuntimeCommandOptions.umask`.

`df`, `df -h`, and `df -i` report the workspace's logical byte and entry
capacity. These values come from the same quota ledger that accepts or rejects
filesystem writes, rather than from fabricated host-disk statistics. The
reported filesystem is therefore `tracekernel`, mounted at the configured
workspace root. Browser Node's `fs.statfs` reads the same capacity snapshot and
updates its free-space view as the running process mutates files. `du` reports
logical usage below individual workspace paths without claiming host allocation
details that TraceKernel does not model.

`mount`, `/proc/mounts`, and `/proc/self/mountinfo` are rendered from one
TraceKernel mount table. They describe a read-only system root, explicit
writable `/tmp`, `/var/tmp`, workspace, and device mounts, and read-only proc,
control, and skills namespaces without claiming a Linux backing filesystem.
The same topology is enforced by mutation policy: absolute writes outside the
workspace and temporary mounts fail with `EROFS`. The topology is fixed for a
workspace; attempts to add or change mounts fail as an unsupported privileged
operation.

The standard identity files under `/etc` come from that same kernel model.
`os-release` identifies TraceKernel rather than Linux, while `passwd`, `group`,
`hostname`, `hosts`, `nsswitch.conf`, and `shells` agree with the active user,
host, and shell environment. The namespace is root-owned and read-only, and
the same files are forwarded into browser runtime snapshots so a Node process
does not observe a different machine from the terminal that launched it.

File permission bits and access/modify timestamps cross runtime boundaries as
part of the project snapshot and file-change contract. A mode set by the shell
is therefore visible to browser Node, and `chmod` or `utimes` performed by that
process remains visible to the next terminal command and after IndexedDB
hydration. Browser processes run as the TraceKernel user; ownership changes the
unprivileged user cannot perform fail with `EPERM` instead of reporting a
temporary success.

For apps that need a visible user shell and background agent commands in the
same project, keep both on one workspace. The user-facing terminal session owns
one foreground process at a time, while agent calls can use
`workspace.runCommand(...)` and the kernel scheduler. Simulated HTTP servers and
clients share that same workspace; see [TraceKernel HTTP Simulation](./tracekernel-http.md).

Set `kernel.maxProcesses` when a workspace needs a hard process-table limit.
The limit counts PID 1, persistent processes created through
`workspace.kernel.createProcess(...)`, queued and running commands, and
unreaped zombies. A command that cannot obtain a process-table slot returns a
structured `EAGAIN` error for the `fork` syscall; synchronous host-process
creation throws the same error. No PID or process journal entry is created for
the failed fork. `/proc/tracekernel/sched` and `tracekernelctl status` expose
current usage and the configured ceiling. This limit is kernel-wide and is
therefore separate from per-command `executionLimits` and scheduler concurrency.
The lone `wait` and `tracekernelctl wait` forms execute as builtins in their
existing parent process (PID 1 for direct workspace calls), so an exhausted
table can still reap a zombie without attempting the very fork that the reap
would make possible.

## Output Events

Terminal sessions preserve the normal command event stream, with one addition:
stdout chunks that become stdin prompts are marked with terminal metadata.

```ts
if (event.type === 'output' && event.terminal?.role === 'stdin-prompt') {
  // event.terminal.inputState is the same state emitted by onTerminalEvent.
}
```

Terminal UIs usually suppress these chunks as committed output and render the
prompt via `inputState` instead. This prevents the active line from gaining
different spacing than the committed line after the user presses Enter.

By default, terminal sessions hide status events unless TraceKernel verbose mode
is enabled. Direct `workspace.runCommand(...)` calls still receive status events
normally.

### Error presentation

Treat stdout and stderr as program-owned terminal streams. Language syntax
errors, compiler diagnostics, uncaught exceptions, missing files, and command
errors remain visible there with workspace paths and the exit code the native
tool would normally use. Do not append a generic `exit N` line; shells do not do
that for every failed foreground command.

Runner infrastructure is a separate boundary. A worker crash, execution-host
failure, bridge timeout, or kernel-side file synchronization failure returns a
nonzero result with a structured `result.error` and status-event metadata, but
does not print worker URLs, host filesystem paths, request IDs, or bridge stack
traces as if the learner's process wrote them. UIs may present a concise product
recovery state from the structured error, while diagnostics and telemetry keep
the internal detail. A signal uses shell-compatible exit status (`128 + signal`);
for Ctrl+C, render the terminal's `^C` behavior rather than an internal syscall
exception.

## Live Stdin

`terminal.run(command)` creates the live stdin pipe for terminal commands. Most
consumers should not pass `stdinPipe` directly.

When a program asks for input:

1. The session emits `input-state` with `mode: 'stdin'`.
2. The UI displays `state.label` as the active prompt.
3. The user submits text.
4. The UI echoes `${state.label}${value}` as a committed stdin line.
5. The UI calls `terminal.writeStdin(value + "\n")`.

`writeStdin` returns `false` if no foreground process owns terminal stdin.
Call `terminal.endStdin()` for Ctrl+D. It closes the foreground process's stdin
without interrupting the process, allowing normal EOF handlers to run.

## Terminal Controls

`clear` and `exit` are terminal-session operations, not workspace-wide
mutations. They arrive through `onTerminalEvent` as structured `control`
events:

```ts
if (event.type === 'control' && event.action === 'clear') clearRenderedLines();
if (event.type === 'control' && event.action === 'exit') closeTerminalTab();
```

After `exit`, `terminal.closed` is `true` and further commands fail with
`EBADF`. Sibling terminal sessions and background workspace processes remain
available. Ctrl+L is a UI keyboard binding: consumers should clear their
rendered transcript through the same path as the `clear` control event.

Foreground output may use carriage returns to redraw one line. Consumers should
treat `\r` as a cursor reset within the current line, rather than committing a
new line, so progress output behaves like a terminal instead of producing a log
of every intermediate percentage.

### Geometry, capabilities, and history

Each terminal exposes `terminal.terminal`, `terminal.history`, and
`terminal.resize(columns, rows)`. Pass the rendered terminal dimensions when
creating or resizing a session. Subsequent commands receive `COLUMNS`, `LINES`,
`TERM=dumb`, and `NO_COLOR=1`; browser Node exposes the same geometry through
`process.stdout.columns`, `process.stdout.rows`, and its TTY flags. Direct
`workspace.runCommand(...)` calls are captured commands and therefore report
non-TTY stdio.

`history`, `history N`, and `history -c` operate on the session-owned history.
Host UIs should use the same `terminal.history` collection for Arrow Up and
Arrow Down navigation instead of keeping a second, divergent command list.
`stty size` and the supported `tput` queries expose the current geometry. Since
the default terminal is deliberately `dumb`, it advertises no color or cursor
addressing capability.

### Signals

`terminal.interrupt()` sends `SIGINT` to the foreground process. `kill`,
`pkill`, and kernel control operations deliver the requested signal to the
target process. Browser Node programs may register normal `process.on('SIGINT',
...)` or `process.on('SIGTERM', ...)` handlers and receive a short grace period
to close servers, flush work, and exit naturally. An unhandled signal retains
the shell-compatible `128 + signal` status. `SIGKILL` and `SIGSTOP` cannot be
caught, matching Node's process API.

`kill -l` reports only the signals implemented by the kernel. `kill -0 PID`
checks whether a process is visible and signalable without changing its state.
Executable workspace files use their shebang interpreter when it is available;
text executables without a shebang use the normal shell fallback, while a
missing shebang interpreter fails instead of silently treating the file as a
shell script.

The device namespace includes `/dev/stdin`, `/dev/stdout`, `/dev/stderr`,
`/dev/tty`, `/dev/null`, and `/dev/fd/{0,1,2}`. Descriptor aliases route to the
current command's real streams; they are not ordinary persisted files.

TraceKernel also provides the common inspection commands used while debugging a
service: `ps aux`, `pgrep`, `pkill`, `ss -ltnp`, `lsof -i :PORT`, `wget`,
`mktemp`, `man`, `df`, `du`, `mount`, `stat`, `tty`, `locale`, `getconf`, `getent`, and `groups`. They
report TraceKernel's own process, listener, storage, and identity models; they
do not claim a Linux kernel identity. Shell `test -t FD` and `[ -t FD ]` report
attached terminal descriptors while captured commands remain non-TTY. `wget`
uses the same allowlisted HTTP transport as `curl`. Raw
TCP/UDP sockets and `nc` are intentionally not simulated by the current HTTP
transport. Git repository emulation and suspended-job control such as Ctrl+Z
are separate capabilities and are not part of this terminal-session contract.

Browser live stdin and browser C/C++ execution require `SharedArrayBuffer` and
`Atomics`. Serve browser consumers with cross-origin isolation headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The `examples/project-terminal` Vite config includes these headers for `dev`
and `preview`.

Cross-origin isolation enables the browser primitives this harness needs; it is
not the full security model for hostile code. See
[Isolation Boundaries](./isolation-boundaries.md) for the TraceKernel sandbox
contract and native-runner caveats.

## Choosing The Right API

Use `workspace.runCommand(...)` for background jobs, analysis, grading, and
automation where the caller owns stdout/stderr and stdin.

Use `workspace.createTerminalSession(...)` for user-facing terminal UI. It gives
consumers one supported contract for shell prompt rendering, busy state, stdin
prompts, and command lifecycle.
