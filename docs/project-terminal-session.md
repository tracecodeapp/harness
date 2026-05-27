# Project Terminal Sessions

Project workspaces expose a terminal session API for apps that want a real
terminal surface instead of calling `workspace.runCommand(...)` directly. The
session owns shell prompt state, current working directory, command lifecycle,
and live stdin handoff for programs that ask the user for input.

Use this API for IDE terminals, fullscreen project terminals, interview
workspaces, and any consumer UI that needs to show an active
`user@host cwd %` command line.

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

  if (result.exitCode !== 0) appendLine(`exit ${result.exitCode}`, 'exit');
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

- `command`: the terminal is ready for a shell command. `label` is the shell prompt, for example `ada@tracevm weather-api %`.
- `busy`: a command is running but the process has not requested stdin. Hide or disable the input row; this matches normal terminal behavior while a foreground process owns the tty.
- `stdin`: the running process printed an unterminated stdout prompt. `label` is that process prompt, for example `Name: `. Submit user text with `terminal.writeStdin(...)`.

State changes are emitted through `onTerminalEvent` with one of these reasons:

- `command-start`
- `stdin-prompt`
- `stdin-submit`
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

The prompt is derived from tracekernel identity and the session cwd. Built-in
`cd` and leading compound commands such as `cd src && npm test` update the
terminal session cwd. Programmatic `workspace.runCommand(...)` calls do not
change a terminal session's cwd.

Use `terminal.prompt.text` when echoing submitted commands. Use
`terminal.inputState.label` when echoing stdin responses, because stdin prompts
belong to the running process rather than the shell.

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

By default, terminal sessions hide status events unless tracekernel verbose mode
is enabled. Direct `workspace.runCommand(...)` calls still receive status events
normally.

## Live Stdin

`terminal.run(command)` creates the live stdin pipe for terminal commands. Most
consumers should not pass `stdinPipe` directly.

When a program asks for input:

1. The session emits `input-state` with `mode: 'stdin'`.
2. The UI displays `state.label` as the active prompt.
3. The user submits text.
4. The UI echoes `${state.label}${value}` as a committed stdin line.
5. The UI calls `terminal.writeStdin(value + "\n")`.

`writeStdin` returns `false` if no foreground process is currently waiting for
terminal stdin.

Browser live stdin and browser C/C++ execution require `SharedArrayBuffer` and
`Atomics`. Serve browser consumers with cross-origin isolation headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The `examples/project-terminal` Vite config includes these headers for `dev`
and `preview`.

## Choosing The Right API

Use `workspace.runCommand(...)` for background jobs, analysis, grading, and
automation where the caller owns stdout/stderr and stdin.

Use `workspace.createTerminalSession(...)` for user-facing terminal UI. It gives
consumers one supported contract for shell prompt rendering, busy state, stdin
prompts, and command lifecycle.
