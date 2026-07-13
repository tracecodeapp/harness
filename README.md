# TraceCode Harness

Browser-first execution and tracing runtime for Python, JavaScript,
TypeScript, Java, C#, and C++.

`@tracecode/harness` is a runtime SDK for browser applications that need code
execution, runtime traces, package-managed worker assets, and explicit
capability profiles. It is not a curriculum product, web IDE framework,
visualizer planner, analytics layer, or complete application UI.

Project site: [tracecode.app](https://tracecode.app)

## Install

Use the umbrella package for the full public surface:

```bash
pnpm add @tracecode/harness
```

For smaller installs, combine the core/browser packages with only the language
assets your app ships:

```bash
pnpm add @tracecode/harness-core @tracecode/harness-browser @tracecode/harness-python
pnpm add @tracecode/harness-javascript
pnpm add @tracecode/harness-java
pnpm add @tracecode/harness-csharp
pnpm add @tracecode/harness-cpp
pnpm add @tracecode/harness-sql
```

Add project/workspace execution only when you need shell-style multi-file
workspaces:

```bash
pnpm add @tracecode/harness-project
```

If your app bundles dependencies, transpiling the package is usually safest. For
Next.js:

```ts
transpilePackages: ['@tracecode/harness']
```

## Quick Start

Copy browser worker assets into your app's public directory:

```bash
pnpm exec tracecode-harness sync-assets public/workers
```

Create a browser harness and execute code:

```ts
import { createBrowserHarness } from '@tracecode/harness/browser';

const harness = createBrowserHarness({ assetBaseUrl: '/workers' });
const client = harness.getClient('python');

await client.init();

const source = `
def solve(nums):
    return sum(nums)
`;

const result = await client.executeCode(
  source,
  'solve',
  { nums: [1, 2, 3] }
);

const trace = await client.executeWithTracing(
  source,
  'solve',
  { nums: [1, 2, 3] },
  { maxTraceSteps: 200 },
  'function'
);
```

Use `harness.warmLanguage(language)` when Python, TypeScript, Java, C#, or C++
is selected so runtime/compiler startup happens before the first latency-sensitive
execution. JavaScript `init()` prepares a clean one-shot executor directly.

## Packages

The umbrella package exposes `/browser`, `/core`, `/python`, `/javascript`,
`/java`, `/csharp`, `/cpp`, `/sql`, `/project`, `/project-node`, and `/native`
entrypoints. Standalone packages expose the same surfaces with smaller installs:
`@tracecode/harness-core`, `@tracecode/harness-browser`, the language packages,
`@tracecode/harness-sql`, `@tracecode/harness-project`, and
`@tracecode/harness-native`.

All supported languages are stable. Use `getLanguageRuntimeProfile(language)`
for detailed capability checks and `getLanguageRuntimeInfo(language)` for
runtime labels/descriptions.

## Worker Assets

`tracecode-harness sync-assets <target-dir>` copies the canonical browser asset
set for installed languages, including runtime workers, vendored compiler
assets, and `THIRD_PARTY_NOTICES.md`.

Copy only selected languages from the umbrella package:

```bash
pnpm exec tracecode-harness sync-assets public/workers --languages python,javascript
```

Standalone language packages publish their own `workers/` directories with the
same target layout, so consumers can distribute only the runtime assets they
install. Advanced consumers can override individual asset URLs through
`createBrowserHarness({ assets })`.

Runtime delivery is consumer-owned. Browser consumers may pass versioned
`assets.runtimeManifests` (or a `runtimeAssetProvider`) for Python, JavaScript,
TypeScript, Java, C#, and C++ without depending on a TraceCode-operated CDN. A
first-party TraceCode application can publish one such manifest as application
configuration; it is not embedded as a harness product dependency. See
[Isolation Boundaries](./docs/isolation-boundaries.md#runtime-assets-and-cdns)
for integrity, origin, and immutable-URL requirements.

For untrusted browser execution, route selected Classic or project providers
through the [browser execution host](./docs/browser-execution-host.md) on a
dedicated credential-free origin. Provider routing is explicit, so a consumer
can host Java remotely while Python, JavaScript/TypeScript, C#, and C++ continue
to use its application-owned asset paths. This is the TraceCode-recommended
Java project profile because CheerpJ's /files mount is IndexedDB-backed and
must not share the application origin.

CheerpJ is not redistributed. An owned browser project Java runner therefore
requires a complete `assets.runtimeManifests.java` asset set before its first
Java command (or a consumer-provided `javaWorkerClient`). Non-Java workspaces
remain lazy and do not need Java assets.

## Project Workspaces

Project/workspace mode is for browser IDEs, interview workspaces, terminal
demos, and local project runners that need shell-style multi-file execution.

Use `createBrowserProjectWorkspace(...)` for browser workspaces,
`createNativeProjectWorkspace(...)` for local trusted project execution, and
`workspace.createTerminalSession(...)` for terminal UIs. See
[Project Terminal Sessions](./docs/project-terminal-session.md) and the
[project IDE](./examples/project-ide) / [project terminal](./examples/project-terminal)
examples.

## Native Harness

Native harness is for trusted local automation, CI, regression mining, and
high-throughput batch inference. It runs host-native tools and Node VM contexts,
so it is not a sandbox for arbitrary untrusted code.

Use `createNativeHarness(...)` for trusted local execution and `runJobs` /
`runJobsEach` for batch workloads.

## Docs And Examples

- [Docs index](./docs/README.md)
- [Harness Execution Contract](./docs/harness-execution-contract.md)
- [Isolation Boundaries](./docs/isolation-boundaries.md)
- [TraceKernel Workspaces](./docs/tracekernel-workspaces.md)
- [TraceKernel HTTP Simulation](./docs/tracekernel-http.md)
- [Example Web IDE](./examples/web-ide)
- [Example Project IDE](./examples/project-ide)
- [Example Project Terminal](./examples/project-terminal)

## Development

```bash
pnpm install
pnpm test
```

Useful focused commands:

```bash
pnpm generate:python-harness
pnpm update:csharp-runtime
pnpm test:runtime-info-sync
```

The C# runtime updater reads the host under
`runtimes/csharp/TraceCode.CSharpHost`, publishes the browser-WASM bundle,
replaces `workers/vendor/csharp`, and regenerates runtime language info.
It publishes the browser-oriented minimal compiler reference pack by default;
asset publishers that need the broader BCL surface can set
`TRACECODE_CSHARP_REFERENCE_PACK=Compatibility` for that bundle.

## Releases And Notices

Release history lives in [CHANGELOG.md](./CHANGELOG.md). Runtime dependency and
license notes live in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md); keep
that file with any redistribution of worker assets.

License: AGPL-3.0-only
