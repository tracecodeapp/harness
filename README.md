# TraceCode Harness

Browser-first execution and tracing harness for Python, JavaScript, and TypeScript.

`@tracecode/harness` is a browser-consumable runtime SDK for code execution and tracing: explicit browser runtime creation, package-managed worker assets, and no app-specific storage/bootstrap contract in the public API.

Project site: [tracecode.app](https://tracecode.app)

## Scope

This package provides an execution and tracing runtime for browser applications.

It includes:

- browser-hosted execution for Python, JavaScript, and TypeScript
- trace capture and normalized runtime contracts
- browser worker assets and asset sync tooling
- runtime-side structural annotations such as object kinds and hash/map payloads

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

Consuming apps are expected to own their own UI, persistence, product logic, and any higher-order visualization behavior built on top of the runtime payloads.

## What You Get

- shared runtime contract types and trace adapters
- browser runtime clients for Python, JavaScript, and TypeScript
- published worker assets plus a CLI to copy them into your app
- capability profiles for honest per-language support claims
- regression coverage for runtime parity, packaging, and consumer smoke tests

This is not a general workflow engine. It is an opinionated execution harness designed for interactive code execution and trace playback in browser apps.

## Installation

```bash
pnpm add @tracecode/harness
```

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
  Python harness generation helpers and snippet artifacts.
- `@tracecode/harness/javascript`
  JavaScript and TypeScript execution helpers.

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
- `disposeLanguage(language)`
- `dispose()`

Configuration:

- `assetBaseUrl?: string`
- `assets?: Partial<{ pythonWorker; pythonRuntimeCore; pythonSnippets; javascriptWorker; typescriptCompiler }>`
- `debug?: boolean`

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

## Worker Assets

`tracecode-harness sync-assets <target-dir>` copies the canonical browser asset set:

- `pyodide-worker.js`
- `generated-python-harness-snippets.js`
- `pyodide/runtime-core.js`
- `javascript-worker.js`
- `vendor/typescript.js`

By default, `createBrowserHarness({ assetBaseUrl: '/workers' })` resolves those assets as:

- `/workers/pyodide-worker.js`
- `/workers/generated-python-harness-snippets.js`
- `/workers/pyodide/runtime-core.js`
- `/workers/javascript-worker.js`
- `/workers/vendor/typescript.js`

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
- `visualization`

That lets the package be explicit about partial support and fail closed for unsupported requests.

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

- `0.1.0` introduced the public harness baseline
- `0.2.0` introduced structured runtime capability profiles
- `0.3.0` introduced runtime access metadata in traces
- `0.4.0` makes the harness a clean browser SDK with explicit runtime creation and asset sync tooling

Detailed release notes live in [CHANGELOG.md](./CHANGELOG.md).

## License

GPL-3.0-only
