# `@tracecode/harness-project`

Project-mode workspace primitives for TraceCode Harness.

Install this package when an app needs a virtual multi-file workspace instead
of only single-file runtime clients. It provides the shared TraceKernel
filesystem, shell, snapshot, and command-dispatch layer used by browser and
native project runners.

Import path:

```ts
import { createRuntimeWorkspace } from '@tracecode/harness-project';
```

Environment-specific factories wire language runners into the shared workspace:

- `createBrowserProjectWorkspace` from `@tracecode/harness-browser/project`
- `createNativeProjectWorkspace` from `@tracecode/harness/project-node`

Basic workspace use:

```ts
const workspace = await createRuntimeWorkspace({
  kernel: {
    user: { username: 'ada' },
    workspace: { name: 'weather-api' },
  },
  files: [{ path: 'src/main.py', contents: 'print("hello")\n' }],
});

await workspace.writeFile('src/generated.txt', 'created\n');
console.log(await workspace.readFile('src/generated.txt'));
```

TraceKernel exposes a canonical workspace root, optional `/workspace` alias,
virtual `/dev` and `/proc` files, read-only skill files under `/skills`, command
events, snapshots, patch export/import, and live/final file mutation events.

Terminal UIs should use `workspace.createTerminalSession(...)` instead of
inferring prompt and stdin state from raw stdout. See
[TraceKernel Workspaces](../../docs/tracekernel-workspaces.md) and
[Project Terminal Sessions](../../docs/project-terminal-session.md) for the
workspace and terminal contracts.
