# C# WASM Roslyn Spike

This spike tests the first C# feasibility gate for TraceCode:

1. Build time uses local `dotnet publish` to package a browser-local .NET WASM app.
2. Execution time loads the published WASM asset bundle from Node.
3. JavaScript calls `TraceCode.CSharpHost.CompilerHost.Execute(requestJson)`.
4. The C# host uses Roslyn to compile user source into an assembly.
5. The C# host loads the emitted assembly, invokes a `public class Solution` method, captures stdout, and returns JSON.
6. A Playwright smoke loads the same app bundle inside a real browser Web Worker and repeats the compile/run/diagnostics checks.

The smoke runner intentionally does not import `node:child_process` and does not shell out to `dotnet` during execution. That separation is the point of the spike.

## Commands

```sh
pnpm run spike:csharp:publish
pnpm run spike:csharp:smoke
pnpm run spike:csharp:browser
```

Or run the full spike:

```sh
pnpm run spike:csharp
```

To refresh the vendored browser runtime used by the harness, run:

```sh
pnpm update:csharp-runtime
```

That command installs the target .NET SDK channel locally under `.dotnet/`, installs
`wasm-tools`, publishes the host, syncs `workers/vendor/csharp`, and regenerates
runtime language info. Set `TRACECODE_DOTNET_VERSION` to pin an exact SDK version
for a repeatable refresh.

## Scope

The initial host targets `public class Solution` methods and is wired into `createBrowserHarness()` through the experimental `csharp` language key. It supports generated-driver execution including `void` methods, `ListNode`/`TreeNode` prelude classes and JSON hydration, soft loop timeouts, trace-step budgets, block-bodied and expression-bodied method tracing, basic line/call/return-value/simple-write tracing, one-dimensional array indexed read/write tracing including simple compound writes, and initial `List<T>`/`Dictionary<K,V>`/`HashSet<T>`/`Queue<T>`/`Stack<T>` wrapper tracing for `var`, explicit local declarations, target-typed `new()`, collection initializers, common one-argument constructors, and `Dictionary`/`HashSet` comparer constructor overloads. It does not implement broad multi-argument collection constructors beyond the current comparer overloads, NuGet support, or project mode.

## Findings

- Roslyn must run with `concurrentBuild: false` under browser-WASM. The default concurrent path hits monitor waits that the runtime does not support.
- The browser-WASM runtime does not expose framework assembly paths like desktop .NET. The spike packages build-output DLLs into `/tracecode-refs` in the WASM virtual file system and creates Roslyn metadata references from those files.
- The worker must register inbound messages with `addEventListener('message', ...)` instead of assigning `self.onmessage` before loading `dotnet.js`. Newer .NET worker bootstraps use the unset `globalThis.onmessage` signal to enter sidecar mode.
