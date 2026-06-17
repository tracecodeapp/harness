# Example Project IDE

Project-mode reference consumer for `@tracecode/harness` and TraceKernel.

This app exists to test the full browser workspace experience:

- create a browser project workspace
- boot a configurable TraceKernel identity and `/home/<user>/<project>` root
- expose a VS Code-like editor, explorer, and terminal shell
- run project commands across Python, JavaScript, TypeScript, Java, C#, and C++
- exercise live file mutation events, stdio streaming, `/dev`, `/proc`, readonly files, hidden fixtures, and session commands

It is intentionally separate from `examples/web-ide`, which stays focused on tracing/problem-style runtime calls.

## Run It

From the repository root:

```bash
pnpm --dir examples/project-ide install
pnpm --dir examples/project-ide dev
```

The app syncs harness worker assets into `public/workers` before `dev`, `build`, and `preview`.

## What It Demonstrates

- `createBrowserProjectWorkspace(...)` from `@tracecode/harness/browser/project`
- `ProjectSession` commands, readonly starter files, and hidden fixture data
- shell-style project commands through TraceKernel
- live runtime filesystem and stdio events across browser runtimes

Browser workspace persistence is intentionally not enabled by default in this
demo. Apps that persist workspaces should provide their own encrypted storage
key to `createIndexedDbKernelStorage(...)` and should not store that key in
same-origin browser storage.

## Production Note

This example uses workspace packages during local development. Outside this
repository, install the published package from npm and keep the same public API
usage.
