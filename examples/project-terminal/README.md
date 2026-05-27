# Example Project Terminal

Fullscreen terminal demo for `@tracecode/harness` project mode and tracekernel.

This app is intentionally tiny for screen recordings: one C++ stdin program and one Java stdin program, both compiled and run inside the browser project workspace.

## Run It

From the repository root:

```bash
pnpm --dir examples/project-terminal install
pnpm --dir examples/project-terminal dev
```

The app syncs harness worker assets into `public/workers` before `dev`, `build`, and `preview`.

## What It Demonstrates

- `createBrowserProjectWorkspace(...)` from `@tracecode/harness/browser/project`
- `workspace.createTerminalSession(...)` for prompt state and live stdin
- `createIndexedDbKernelStorage(...)` for browser persistence
- C++ compile/run through tracekernel
- Java compile/run through tracekernel
- prompted stdin, stdout/stderr, and generated project files

The terminal does not parse stdout locally to decide whether to show the input
row. It renders `terminal.inputState` and writes prompted input with
`terminal.writeStdin(...)`. See
[Project Terminal Sessions](../../docs/project-terminal-session.md) for the
consumer contract.

## Demo Commands

```bash
cd cpp && clang++ -std=c++17 report.cpp -o ../report
./report
cat report.md

javac java/TicketTriage.java
java -cp java TicketTriage
cat ticket.json
```

Project site: [tracecode.app](https://tracecode.app)
