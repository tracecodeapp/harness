# @tracecode/harness-project

Project-mode workspace primitives for TraceCode harness.

This package is intentionally additive. Existing single-file runtime clients do
not depend on it. Consumers install this package when they want a virtual
project workspace backed by `just-bash`.

`createRuntimeWorkspace` provides the shared tracekernel file-system, shell,
snapshot, and command-dispatch layer. Language commands such as `python3`,
`node`, `javac`, `dotnet`, and `clang++` are available when callers provide the
corresponding project command runner, or through the environment-specific
factories:

- `createBrowserProjectWorkspace` from `@tracecode/harness-browser/project`
- `createNativeProjectWorkspace` from `@tracecode/harness/project-node`

```ts
import { createRuntimeWorkspace } from '@tracecode/harness-project';

const workspace = await createRuntimeWorkspace({
  kernel: {
    user: { id: 'auth-user-123', username: 'ada' },
    host: { hostname: 'tracevm' },
    workspace: { id: 'weather-api-1', name: 'weather-api' },
  },
  directories: ['src/generated'],
  files: [
    { path: 'src/solution.py', contents: 'print("hello")\n' },
  ],
  entrypoint: 'src/solution.py',
});

await workspace.writeFile('src/generated.txt', 'created\n');
await workspace.appendFile('src/generated.txt', 'more\n');
await workspace.exists('src/generated.txt');
await workspace.stat('src/generated.txt');
await workspace.readDir('src');
await workspace.mkdir('src/generated');
await workspace.copyFile('src/solution.py', 'src/generated/solution.py');
await workspace.moveFile('src/generated/solution.py', 'src/generated/copy.py');
await workspace.remove('src/generated', { recursive: true });
await workspace.deleteFile('src/generated.txt');

console.log(workspace.cwd); // /home/ada/weather-api
console.log(workspace.kernel.info.name); // tracekernel
console.log(await workspace.readFile('/proc/kernel/info'));
console.log(await workspace.readFile('/proc/self/mountinfo'));
```

When `kernel` identity is provided, the canonical workspace root is
`/home/<user>/<project>`. `/workspace` is kept as a compatibility alias unless
`kernel.workspaceAlias` is set to `false`. `/dev/stdin`, `/dev/stdout`,
`/dev/stderr`, and `/dev/tty` are virtual devices connected to command I/O.
`workspace.watch(...)` and command `onEvent` handlers receive streaming output
and live/final file mutation events.

All language runners use the same project request shape: source, script path,
argv, cwd, environment, stdin, and a `RuntimeProjectSnapshot` containing the
current files, empty directories, optional entrypoint, `workspaceRoot`, and
optional `workspaceAlias`.
