# Example Project Terminal

Fullscreen terminal demo for `@tracecode/harness` project mode and TraceKernel.

This app is intentionally tiny for screen recordings: one C++ stdin program,
plus an optional Java stdin program when the host supplies Java runtime assets.
Both run inside the browser project workspace.

## Run It

From the repository root:

```bash
pnpm --dir examples/project-terminal install
pnpm --dir examples/project-terminal dev
```

The app syncs harness worker assets into `public/workers` before `dev`, `build`, and `preview`.

CheerpJ is intentionally not synced or selected by the harness. A host that
wants the Java demo must set `window.__tracecodeRuntimeAssetManifests` before
the app boots, with a complete `java` manifest containing `worker`, `loader`,
`helperJar`, `compilerJar`, `rewriterJar`, and `parserJar`. The URLs may point
to the host's own origin or consumer-approved CDN; this example does not embed
a TraceCode product CDN.

## What It Demonstrates

- `createBrowserProjectWorkspace(...)` from `@tracecode/harness/browser/project`
- `workspace.createTerminalSession(...)` for prompt state and live stdin
- C++ compile/run through TraceKernel
- Java compile/run through TraceKernel when a complete consumer manifest is injected
- prompted stdin, stdout/stderr, and generated project files

Browser workspace persistence is intentionally not enabled by default in this
demo. Apps that persist workspaces should provide their own encrypted storage
key to `createIndexedDbKernelStorage(...)` and should not store that key in
same-origin browser storage.

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

Without the injected Java manifest, the Java command fails before Worker
construction with configuration guidance; the C++ demo remains fully usable.
