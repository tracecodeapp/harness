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
pnpm add @tracecode/harness effect
```

`@tracecode/harness` is the only TraceCode package published from this
repository. Its public entrypoints are the package root plus `/browser`,
`/browser/project`, `/project`, `/project-node`, and `/judge`; `package.json`
is also exported for tooling. Language, core, native, SQL, and internal
workspaces are implementation boundaries, not public subpaths. Browser assets
can still be copied selectively with
`tracecode-harness sync-assets --languages ...`.

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

Create a browser-owned runtime host, then evaluate a Judge plan inside an
Effect scope:

```ts
import * as Effect from 'effect/Effect';
import {
  createBrowserRuntimeHost,
} from '@tracecode/harness/browser';
import {
  createBrowserRuntimeJudge,
  type JudgeEvaluationPlan,
} from '@tracecode/harness/judge';

const source = String.raw`
def solve(nums):
    return sum(nums)
`;

const plan: JudgeEvaluationPlan<
  { readonly nums: readonly number[] },
  number
> = {
  id: 'sum-example',
  runtime: 'python',
  workspace: {
    cwd: '/workspace',
    files: [{
      path: '/workspace/solution.py',
      contents: source,
      visibility: 'submission',
    }],
  },
  driver: { files: [] },
  run: {
    command: 'judge-case',
    timeoutMs: 1_000,
  },
  cases: [{
    id: 'small-list',
    input: { nums: [1, 2, 3] },
    expected: 6,
  }],
  isolation: {
    mode: 'fresh-session-per-case',
  },
};

const host = createBrowserRuntimeHost({
  assetBaseUrl: '/workers',
  providers: ['python'],
});

try {
  await host.preflightLanguage('python');
  await host.warmLanguage('python');

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const judge = yield* createBrowserRuntimeJudge({
          host,
          language: 'python',
          binding: {
            sourcePath: '/workspace/solution.py',
            functionName: 'solve',
            executionStyle: 'function',
          },
        });
        return yield* judge.evaluate(plan);
      })
    )
  );

  console.log(result.cases[0]?.verdict);
} finally {
  host.dispose();
}
```

`BrowserRuntimeHost` owns assets, readiness, warmup, and provider teardown. It
does not expose runtime clients, prepared providers, or direct execution
methods. `Effect.scoped` owns the Judge/TraceKernel composition and releases its
prepared program on success, failure, or interruption. A host may serve
multiple scoped evaluations; call `host.dispose()` when the application is
finished with it.

For Trace Mode, set `trace: true` and optional `traceOptions` on the Judge
binding. Expected values, comparators, verdicts, and case isolation remain
Judge policy rather than runtime-provider inputs.

### Judge facade

`@tracecode/harness/judge` is the supported 0.14 surface for algorithm
evaluation. It composes evaluation policy, a TraceKernel host, and the selected
browser runtime without exposing a provider-injection seam:

`BrowserRuntimeHost -> Browser Judge -> TraceKernel -> isolated cases`

The private Judge workspace owns comparison policy, lifecycle validation, and
result shaping. `createBrowserRuntimeJudge` accepts only a genuine
`BrowserRuntimeHost`; generic runtime-provider composition remains private.

## Packages

The root-only release exports exactly:

- `@tracecode/harness`
- `@tracecode/harness/browser`
- `@tracecode/harness/browser/project`
- `@tracecode/harness/project`
- `@tracecode/harness/project-node`
- `@tracecode/harness/judge`
- `@tracecode/harness/package.json`

There are no public `/python`, `/javascript`, `/java`, `/csharp`, `/cpp`,
`/sql`, `/core`, `/native`, or `/internal/*` subpaths. The matching
`packages/*` workspaces are private build, test, and ownership boundaries.

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

The private language workspaces maintain their own `workers/` directories with
the same target layout. The published root package assembles those assets, and
consumers can copy only selected languages with `sync-assets`. Advanced
consumers can override individual asset URLs through
`createBrowserRuntimeHost({ assets })`.

Runtime delivery is consumer-owned. Browser consumers may pass versioned
`assets.runtimeManifests` (or a `runtimeAssetProvider`) for Python, JavaScript,
TypeScript, Java, C#, and C++ without depending on a TraceCode-operated CDN. A
first-party TraceCode application can publish one such manifest as application
configuration; it is not embedded as a harness product dependency. See
[Isolation Boundaries](./docs/isolation-boundaries.md#runtime-assets-and-cdns)
for integrity, origin, and immutable-URL requirements.

For untrusted browser execution, route selected browser-host languages through
the [browser execution host](./docs/browser-execution-host.md) on a dedicated
credential-free origin.

The root asset set contains Java's Harness bridge worker and Harness-owned
helper files. The Java engine module, engine WASM, and runtime profile are
consumer-served runtime assets. Publish them as one versioned, immutable tree
and configure its base URL with a trailing slash, for example:

```text
/runtimes/java/2026-07-30/
  browser-client.js
  bjvm_main.wasm
  profiles/core/...
```

The slash is part of the contract: the bridge resolves every engine asset
relative to that tree. Splitting those files across mutable roots or omitting
the trailing slash can resolve requests outside the intended versioned
directory.

## Project Workspaces

Project/workspace mode is for browser IDEs, interview workspaces, terminal
demos, and local project runners that need shell-style multi-file execution.

Use `createBrowserProjectWorkspace(...)` for browser workspaces,
`createNativeProjectWorkspace(...)` for local trusted project execution, and
`workspace.createTerminalSession(...)` for terminal UIs. See
[Project Terminal Sessions](./docs/project-terminal-session.md) and the
[project IDE](./examples/project-ide) / [project terminal](./examples/project-terminal)
examples.

## Native Project Workspaces

`@tracecode/harness/project-node` provides
`createNativeProjectWorkspace(...)` for trusted local project execution and
CI. It runs host-native tools, so it is not a sandbox for arbitrary untrusted
code. There is no public `/native` package subpath.

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

The full gate schedules independent runtime families concurrently while keeping
build-dependent and timing-sensitive work behind explicit boundaries. It uses
a conservative capacity derived from the host by default. Set
`TRACECODE_TEST_JOBS=<n>` to lower the capacity on a constrained machine or to
opt into more local parallelism; `pnpm test:ci` uses the smaller CI profile.

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

Release history lives in [CHANGELOG.md](./CHANGELOG.md). The
[root release policy](./docs/publishing.md) documents the audited,
root-only publish path. Runtime dependency and license notes live in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md); keep that file with any
redistribution of worker assets.

License: AGPL-3.0-only
