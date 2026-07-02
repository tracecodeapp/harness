# TraceKernel Workspaces

TraceKernel is the simulated workspace and process policy layer behind
project-mode execution. It gives browser and native runners one shared model for
paths, shell commands, virtual devices, project sessions, snapshots, terminal
state, and in-workspace HTTP.

TraceKernel is not the language tracer and it is not an operating-system
sandbox. For isolation limits, see [Isolation Boundaries](./isolation-boundaries.md).

## Creation

Browser apps usually create a workspace through the environment factory:

```ts
import { createBrowserProjectWorkspace } from '@tracecode/harness/browser/project';

const workspace = await createBrowserProjectWorkspace({
  assetBaseUrl: '/workers',
  kernel: {
    user: { username: 'ada' },
    host: { hostname: 'tracevm' },
    workspace: { name: 'weather-api' },
    scheduler: { maxConcurrentCommands: 4 },
  },
  files: [{ path: 'src/main.py', contents: 'print("hello")\n' }],
});
```

`createRuntimeWorkspace(...)` is the shared lower-level factory from
`@tracecode/harness-project`. It owns the workspace model; browser and native
factories add language runners.

## Kernel Identity

`kernel` controls the identity surfaced through prompts, snapshots, `/proc`, and
runner payloads:

- `kernel.user.id`, `username`, `home`
- `kernel.host.hostname`, `osName`
- `kernel.workspace.id`, `name`, `root`, `startedAt`
- `kernel.version`
- `kernel.workspaceAlias`
- `kernel.scheduler`

If `kernel.workspace.root` is omitted, TraceKernel derives a root from the user
home and workspace name, such as `/home/ada/weather-api`. If no kernel config is
provided, the default root is `/workspace`.

`workspaceAlias` defaults to `/workspace`. Set `workspaceAlias: false` to remove
that alias, or provide another absolute alias. TraceKernel maps the alias back
to the canonical workspace root for shell resolution and runner snapshots.

## Files And Sessions

Workspaces can be seeded directly:

- `files`: initial files
- `directories`: empty directories to preserve
- `skills`: read-only skill files exposed under `/skills`
- `entrypoint`: default source file for runner commands
- `cwd`: absolute workspace root override
- `env`: default environment variables

`projectSession` is the higher-level way to seed a durable problem or interview
workspace. It can provide:

- identity: `id`, `projectId`, `projectSlug`, `name`, `language`
- workspace defaults: `workspaceRoot`, `cwd`, `entrypoint`, `env`
- content: `files`, `directories`, `skills`
- commands: named command definitions for `workspace.runProjectCommand(...)`
- lifecycle: `createdAt`, `lastOpenedAt`, `expiresAt`, `expirationBehavior`
- metadata: app-owned structured data

Session files can set `readonly: true` or `hidden: true`. Hidden files are also
treated as read-only. Normal snapshots omit hidden files unless callers pass
`snapshot({ includeHidden: true })`, while runners that need hidden tests receive
them through controlled project payloads.

## Commands And Runners

TraceKernel provides the shell surface and command scheduling. Language execution
is supplied by runners:

- `pythonRunner`
- `nodeRunner`
- `typescriptRunner`
- `javaRunner`
- `csharpRunner`
- `cppRunner`

The browser factory wires these for you from browser workers. Native project
workspaces wire host-tool runners. Direct `createRuntimeWorkspace(...)` callers
can provide their own runners for tests or custom environments.

Useful command knobs:

- `commands`: command names to expose in the shell.
- `customCommands`: additional shell commands.
- `packageManager`: enables package-manager command handling.
- `executionLimits`: command count, loop, call-depth, output, and timeout
  limits.
- `kernel.scheduler.maxConcurrentCommands`: concurrent admitted commands,
  defaulting to 32 in Node runtimes and 4 in browser runtimes.
- `kernel.scheduler.maxQueuedCommands`: maximum queued commands; omitted means
  unlimited.

Terminal UIs should use `workspace.createTerminalSession(...)`. The terminal
session owns prompt state, foreground command lifecycle, and live stdin state.

## Virtual Namespaces

TraceKernel exposes kernel-owned namespaces to project code:

- `/proc`: kernel info, mount info, process/scheduler state, and diagnostics.
- `/dev`: stdin/stdout/stderr/tty/null plus configured virtual devices.
- `/skills`: read-only skill files seeded by the app.
- workspace root and optional alias, usually `/home/<user>/<workspace>` and
  `/workspace`.

Kernel namespaces are read-only to normal workspace and shell writes. Runtime
file changes are routed back through TraceKernel so live mutation events and
final-diff reconciliation can enforce readonly and hidden-file policy.

## Actors And HTTP

Workspace operations can run as actors:

- `principal`: visible user/app actor
- `test`: visible test/probe actor
- `hidden-test`: hidden test actor
- `runtime`: command process actor
- `system`: kernel-owned actor

Actors can carry filesystem and HTTP capabilities. The built-in HTTP presets are:

- `workspace`: simulated `listen`, simulated `dispatch`, diagnostics reads, and
  external fetch that follows workspace egress config.
- `system`: simulated HTTP plus external fetch capability regardless of the
  config default.
- `none`: no HTTP capabilities.

TraceKernel HTTP is an in-workspace transport, not host networking. See
[TraceKernel HTTP Simulation](./tracekernel-http.md) for listener, dispatch,
timeout, and built-in client details.

## Persistence

Browser project workspaces can persist snapshots through `kernelStorage`.
`createIndexedDbKernelStorage(...)` requires:

- `databaseName`
- `storeName`
- `key`
- `trustedSameOriginPersistence: true`
- an AES-GCM `encryptionKey`

Do not store the encryption key in same-origin browser storage. The helper
encrypts snapshots before writing to IndexedDB and rejects plaintext snapshots
unless `allowPlaintextSnapshotMigration: true` is set for migration.

For cloud sync, prefer compact overlays:

- `workspace.snapshot(...)` captures the current workspace.
- `workspace.exportPatch(baseSnapshot, { base })` creates a patch against a
  known base manifest.
- `workspace.importPatch(baseSnapshot, patch)` validates the base and per-file
  preconditions before mutating the workspace.

Apps still own problem IDs, account storage, conflict UX, and authorization.

## Lifecycle

`workspace.dispose()` detaches local listeners and owned workers. It does not
mean the user intended to delete persisted state.

`workspace.destroy({ clearStorage })` marks a session destroyed, stops the
workspace, and can clear browser storage when the browser factory supplied
storage.

`projectSession.expiresAt` is evaluated automatically the next time the
workspace receives a mutation or command after the expiration time. That lazy
transition stamps `expiredAt` and emits `session-expired` before applying the
configured behavior:

- `none`: mark lifecycle state only.
- `readonly`: future mutations fail as read-only.
- `destroy`: destroy the workspace and clear storage.

`workspace.checkExpiration(...)` remains available when the host wants eager
evaluation, for example to update idle UI before the next user action.

Use lifecycle events and `projectSession.lifecycle` for UI state instead of
guessing from command failures.
