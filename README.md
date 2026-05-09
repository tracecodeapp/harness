# TraceCode Harness

Browser-first execution and tracing harness for Python, JavaScript, TypeScript, experimental Java, experimental C#, and experimental C++ lanes.

`@tracecode/harness` is a browser-consumable runtime SDK for code execution and tracing: explicit browser runtime creation, package-managed worker assets, and no app-specific storage/bootstrap contract in the public API.

Project site: [tracecode.app](https://tracecode.app)

## Scope

This package provides an execution and tracing runtime for browser applications.

It includes:

- browser-hosted execution for Python, JavaScript, and TypeScript
- an experimental browser-local Java 17 lane for `function`, `solution-method`, `ops-class`, `script`, and `interviewMode` execution
- an experimental browser-local C# lane for `function`, `solution-method`, `ops-class`, `script`, and `interviewMode` execution
- an experimental browser-local C++ lane for `function`, `solution-method`, `ops-class`, `script`, and `interviewMode` execution
- trace capture and normalized runtime contracts
- browser worker assets and asset sync tooling

It does not include a full end-user product.

Specifically, this package does not ship:

- any curriculum or problem corpus
- guided-learning logic
- higher-level visualization planners or rendering strategy
- personalization, analytics, or product workflows
- a complete application UI

## Non-Goals

`@tracecode/harness` is not intended to be:

- a full web IDE framework
- a white-labeled teaching product
- a higher-level pedagogy or visualization-planning layer

Consuming apps are expected to own their own UI, persistence, product logic, and any higher-order visualization behavior built on top of neutral runtime trace facts.

## What You Get

- shared runtime contract types and trace adapters
- browser runtime clients for Python, JavaScript, TypeScript, Java, C#, and C++
- published worker assets plus a CLI to copy them into your app
- capability profiles for honest per-language support claims
- regression coverage for runtime parity, packaging, and consumer smoke tests

This is not a general workflow engine. It is an opinionated execution harness designed for interactive code execution and trace playback in browser apps.

## Installation

The umbrella package keeps the backwards-compatible all-in-one install:

```bash
pnpm add @tracecode/harness
```

For smaller installs, use the language packages you actually ship:

```bash
pnpm add @tracecode/harness-core @tracecode/harness-browser @tracecode/harness-python
pnpm add @tracecode/harness-javascript
pnpm add @tracecode/harness-java
pnpm add @tracecode/harness-csharp
pnpm add @tracecode/harness-cpp
```

Each language package publishes only its own worker assets under `workers/`.
That keeps license/runtime exposure scoped to the languages a consuming app
chooses to distribute.

If your app bundles dependencies, transpiling the package is usually the safest option. For Next.js:

```ts
transpilePackages: ['@tracecode/harness']
```

## Quick Start

1. Copy the worker assets into your app's public directory.

```bash
pnpm exec tracecode-harness sync-assets public/workers
```

2. Create an explicit browser harness instance.

```ts
import { createBrowserHarness } from '@tracecode/harness/browser';

const harness = createBrowserHarness({
  assetBaseUrl: '/workers',
});
```

3. Get a runtime client and execute code.

```ts
const client = harness.getClient('python');

await client.init();

const result = await client.executeCode(
  `
def solve(nums, target):
    seen = {}
    for index, value in enumerate(nums):
        complement = target - value
        if complement in seen:
            return [seen[complement], index]
        seen[value] = index
    return []
`,
  'solve',
  { nums: [2, 7, 11, 15], target: 9 }
);
```

4. Run tracing when the selected language profile supports it.

```ts
const trace = await client.executeWithTracing(
  code,
  'solve',
  inputs,
  { maxTraceSteps: 200 },
  'function'
);
```

## Public Package Surface

The package publishes built ESM and CommonJS entrypoints plus `.d.ts` files.

- `@tracecode/harness`
  Re-exports the documented public surface.
- `@tracecode/harness/browser`
  Browser harness factory, capability guards, and language profiles.
- `@tracecode/harness/core`
  Shared runtime contracts, result types, and trace helpers.
- `@tracecode/harness/python`
  Python runtime helpers, worker client, and snippet artifacts.
- `@tracecode/harness/javascript`
  JavaScript and TypeScript execution helpers and worker client.
- `@tracecode/harness/java`
  Java runtime client and worker client.
- `@tracecode/harness/csharp`
  C# runtime client and worker client.
- `@tracecode/harness/cpp`
  C++ runtime client and worker client.

The same surfaces are available as standalone language packages:

- `@tracecode/harness-core`
- `@tracecode/harness-browser`
- `@tracecode/harness-python`
- `@tracecode/harness-javascript`
- `@tracecode/harness-java`
- `@tracecode/harness-csharp`
- `@tracecode/harness-cpp`

The browser entrypoint is intentionally narrow. Low-level worker constructors, language gates, and isolation helpers are internal implementation details, not public SDK surface.

## Browser API

The browser package centers on `createBrowserHarness(options)`.

```ts
import {
  createBrowserHarness,
  getLanguageRuntimeProfile,
  isLanguageSupported,
  SUPPORTED_LANGUAGES,
} from '@tracecode/harness/browser';
```

The returned harness exposes:

- `getClient(language)`
- `getProfile(language)`
- `getSupportedLanguageProfiles()`
- `isLanguageSupported(language)`
- `warmLanguage(language)`
- `disposeLanguage(language)`
- `dispose()`

Configuration:

- `assetBaseUrl?: string`
- `assets?: Partial<{ pythonWorker; pythonRuntimeCore; pythonSnippets; javascriptWorker; typescriptCompiler; javaWorker; csharpWorker; csharpAssetBaseUrl; cppWorker; cppCompilerFrame; cppCompilerWorker; cppCompilerBundle; cppRuntimeHeader }>`
- `debug?: boolean`
- `java?: { workerIdleTimeoutMs?: number }`
- `cpp?: { workerIdleTimeoutMs?: number }`

Example:

```ts
const harness = createBrowserHarness({
  assetBaseUrl: '/workers',
});

const profile = harness.getProfile('typescript');

if (profile.capabilities.tracing.supported) {
  // show trace controls
}
```

For Java, `init()` only performs a light CheerpJ initialization. Call `warmLanguage('java')`
after the user selects Java, or after editor-driven assist work, to warm the heavier javac
path in the background. The hot Java worker idles for 5 minutes by default; call
`disposeLanguage('java')` when the editor closes or the user switches away to release it
immediately.

For C++, `init()` only records the worker asset URLs. Call `warmLanguage('cpp')` after the
user selects C++ to load and warm the browser-local Clang/WASI toolchain in the background.
The default browser client compiles through a disposable compiler frame/worker so the hot
compiler context can be released after compilation; warmup uses that external compiler path
when the frame or nested compiler worker is available, so the main C++ worker keeps only the
compiled program cache. Hosting `cppCompilerFrame` on a separate process-isolated origin
gives Chrome the strongest cleanup boundary. If the compiler frame is on another origin,
serve `cppCompilerWorker`, `cppCompilerBundle`, `cppRuntimeHeader`, and the YoWASP assets
from that origin too, or serve them with CORS headers. The hot C++ worker keeps its shorter
default idle timeout; call `disposeLanguage('cpp')` when C++ is no longer active.

## Worker Assets

`tracecode-harness sync-assets <target-dir>` copies the canonical browser asset set:

- `THIRD_PARTY_NOTICES.md`
- `pyodide-worker.js`
- `generated-python-harness-snippets.js`
- `pyodide/runtime-core.js`
- `javascript-worker.js`
- `vendor/typescript.js`
- `java-worker.js`
- `vendor/java-browser-helper.jar`
- `vendor/java-rewriter.jar`
- `vendor/javaparser-core-3.25.10.jar`
- `vendor/jdk.compiler-17.jar`
- `csharp-worker.js`
- `vendor/csharp/**`
- `cpp-worker.js`
- `cpp-compiler-frame.html`
- `cpp-compiler-worker.js`
- `cpp/tracecode_runtime.hpp`
- `vendor/cpp/yowasp/**`

You can copy a smaller set from the umbrella CLI:

```bash
pnpm exec tracecode-harness sync-assets public/workers --languages python,javascript
```

Standalone language packages publish their own `workers/` directories with the
same target layout, so consumers can copy only the package assets they install.

By default, `createBrowserHarness({ assetBaseUrl: '/workers' })` resolves those assets as:

- `/workers/THIRD_PARTY_NOTICES.md`
- `/workers/pyodide-worker.js`
- `/workers/generated-python-harness-snippets.js`
- `/workers/pyodide/runtime-core.js`
- `/workers/javascript-worker.js`
- `/workers/vendor/typescript.js`
- `/workers/java-worker.js`
- `/workers/vendor/java-browser-helper.jar`
- `/workers/vendor/java-rewriter.jar`
- `/workers/vendor/javaparser-core-3.25.10.jar`
- `/workers/vendor/jdk.compiler-17.jar`
- `/workers/csharp-worker.js`
- `/workers/vendor/csharp`
- `/workers/cpp-worker.js`
- `/workers/cpp/tracecode_runtime.hpp`
- `/workers/vendor/cpp/yowasp`

Advanced consumers can override individual asset URLs through the `assets` option.

## Capability Model

Runtime support is expressed through language profiles, not a few flat booleans.

Each profile includes:

- `language`
- `maturity`
- `capabilities`

Capability domains:

- `execution`
- `tracing`
- `diagnostics`
- `structures`

That lets the package be explicit about partial support and fail closed for unsupported requests.

Current language status:

- `python`: stable
- `javascript`: stable
- `typescript`: stable
- `java`: experimental, browser-local Java 17 lane
- `csharp`: experimental, browser-local .NET WASM + Roslyn lane

Current Java scope:

- supported: `function`, `solution-method`, `ops-class`, `script`, `interviewMode`, tracing, compile diagnostics, and neutral runtime trace facts
- script mode uses an empty function name with `executionStyle: "function"` and reads the top-level `result` variable

Current C# scope:

- supported: named `function` execution, script-style `function` execution with an empty function name and top-level `result`, `interviewMode` execution with sanitized timeout responses, `solution-method` execution for `public class Solution`, `ops-class` execution with JS/TS/Java-style operation-output arrays, generated drivers including `void` methods, `ListNode`/`TreeNode` prelude classes and JSON hydration including linked `__id__`/`__ref__` cycle refs, neutral graph-like map/list serialization, stdout capture, runtime errors, mapped Roslyn compile diagnostics, soft loop timeouts, trace budgets (`maxTraceSteps`, `maxLineEvents`, `maxSingleLineHits`, `maxStoredEvents`, `minimalTrace`), call-stack attachment for traced frames, `List<T>`/`Dictionary<K,V>`/`HashSet<T>`/array return-value serialization, block-bodied and expression-bodied method tracing, block-bodied and expression-bodied lambda tracing, basic line/call/return-value/simple-write tracing, one-dimensional array indexed read/write tracing including simple compound writes, and `List<T>`/`Dictionary<K,V>`/`HashSet<T>`/`Queue<T>`/`PriorityQueue<TElement,TPriority>`/`Stack<T>` wrapper tracing for `var`, explicit local declarations, target-typed `new()`, collection initializers, common collection constructors, comparer constructor overloads, and priority-queue capacity/comparer constructors
- not yet supported: NuGet packages, async/threading APIs, project files, multiple source files, unsafe code, expression-tree lambda rewriting, or full expression/value tracing fidelity

## Example Consumer

A minimal reference browser IDE lives in [examples/web-ide](./examples/web-ide). It is intentionally small and exists to prove that a third-party app can:

- consume the public browser API
- sync worker assets with the CLI
- initialize all supported runtimes
- execute and trace code without any app-specific state wiring

It is a reference consumer for the SDK contract, not a canonical product UI.

## Development

Install workspace dependencies:

```bash
pnpm install
```

Run the full gate:

```bash
pnpm test
```

That covers:

- package typechecks
- runtime and trace contract tests
- packaging/import smoke tests
- asset sync contract tests
- example app browser smoke tests

If you change Python harness templates or generated snippets, regenerate artifacts:

```bash
pnpm generate:python-harness
```

## Releases

This repo uses explicit versioned release boundaries.

- `0.6.2` enables experimental Java script-style execution using the empty function name and top-level `result` convention
- `0.6.1` resolves Dependabot-reported vulnerabilities in Vite, DOMPurify, and Picomatch dependency paths
- `0.6.0` adds an experimental browser-local Java 17 runtime lane for `function`, `solution-method`, `ops-class`, and `interviewMode` execution, plus public asset packaging and browser smoke coverage for Java
- `0.5.0` improves JavaScript tree/list input hydration, fixes sparse tree deserialization, and trims GitHub CI to the non-browser verification set
- `0.1.0` introduced the public harness baseline
- `0.2.0` introduced structured runtime capability profiles
- `0.3.0` introduced runtime access metadata in traces
- `0.4.0` makes the harness a clean browser SDK with explicit runtime creation and asset sync tooling

Detailed release notes live in [CHANGELOG.md](./CHANGELOG.md).

## Third-Party Runtime Notices

Runtime dependencies and license notes are tracked in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Keep that file with any
redistribution of worker assets.

## License

AGPL-3.0-only
