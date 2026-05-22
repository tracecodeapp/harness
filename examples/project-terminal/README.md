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
- `createIndexedDbKernelStorage(...)` for browser persistence
- C++ compile/run through tracekernel
- Java compile/run through tracekernel
- prompted stdin, stdout/stderr, and generated project files

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
