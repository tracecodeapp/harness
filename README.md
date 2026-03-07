# TraceCode Harness

Opinionated browser-first execution harness for Python, JavaScript, and TypeScript.

This repo contains the runtime contract, browser worker clients, Python harness generation, and worker assets that power TraceCode's code execution and tracing pipeline.

## What This Repo Contains

- a shared runtime contract for execution results and trace payloads
- browser worker clients for Python, JavaScript, and TypeScript execution
- Python harness generation utilities and generated snippet artifacts
- worker assets used by the browser runtime
- regression tests for runtime parity and harness drift

This is not a generic workflow engine. It is an opinionated execution harness designed around interactive tracing and browser-hosted runtimes.

## Package Surface

The root package is `@tracecode/harness` and exposes these subpaths:

- `@tracecode/harness`
  Re-exports the full surface.
- `@tracecode/harness/core`
  Shared runtime contract, result types, and trace adapters.
- `@tracecode/harness/browser`
  Browser worker clients and runtime selection.
- `@tracecode/harness/python`
  Python harness generation helpers and snippet artifacts.
- `@tracecode/harness/javascript`
  JavaScript and TypeScript execution helpers.

## Capability Model

Runtime support is described by language profiles, not a few flat booleans.

The browser surface exports:

- `SUPPORTED_LANGUAGES`
- `getRuntimeClient(language)`
- `getLanguageRuntimeProfile(language)`
- `getSupportedLanguageProfiles()`
- `isLanguageSupported(language)`

Each language profile includes:

- `language`
- `maturity`
- `capabilities`

Capability areas are structured by feature domain:

- `execution`
- `tracing`
- `diagnostics`
- `structures`
- `visualization`

This is intentional. A future language can be present as `experimental` and honestly partial without pretending it has Python or JavaScript parity.

Example:

```ts
import { getLanguageRuntimeProfile } from '@tracecode/harness/browser';

const profile = getLanguageRuntimeProfile('typescript');

if (profile.capabilities.tracing.supported) {
  // enable trace UI
}

if (!profile.capabilities.execution.styles.script) {
  // hide script-mode entrypoint
}
```

Runtime clients are execution transports only. Static capability inspection comes from the profile registry, not from client instances.

## Worker Assets

The browser runtime currently expects these worker assets to be served by the consuming app:

- `workers/python/pyodide-worker.js`
- `workers/python/runtime-core.js`
- `workers/python/generated-python-harness-snippets.js`
- `workers/javascript/javascript-worker.js`
- `workers/vendor/typescript.js`

In TraceCode, those assets are served from `/workers/...`.

## Consuming From Another Repo

Right now the simplest integration path is a Git dependency.

```json
{
  "dependencies": {
    "@tracecode/harness": "github:tracecodeapp/harness"
  }
}
```

Then import from the root package or subpaths:

```ts
import { getRuntimeClient } from '@tracecode/harness/browser';
import type { ExecutionResult } from '@tracecode/harness/core';
```

If your app uses Next.js, you will likely want to transpile the package:

```ts
transpilePackages: ['@tracecode/harness']
```

## Development

Install dependencies:

```bash
pnpm install
```

Run the full local gate:

```bash
pnpm test
```

That runs:

- package typechecks
- smoke checks across the package surface
- trace adapter regressions
- Python harness drift checks
- JavaScript worker runtime tests
- cross-runtime contract tests

## Conformance Expectations

Capability claims are test-backed.

The contract suite checks:

- every supported language has a runtime profile
- every profile has a maturity level and complete nested capability object
- unsupported feature requests fail explicitly
- declared capabilities stay aligned with conformance coverage

Current stable languages:

- Python
- JavaScript
- TypeScript

The intended path for a new language is:

1. add a profile with an honest maturity level
2. implement only the supported execution paths
3. fail closed for unsupported features
4. expand conformance coverage before promoting maturity

## Releases

This repo uses explicit Git tags as release boundaries.

- `v0.1.0` is the pre-profile baseline
- `v0.2.0` introduces structured runtime capability profiles

TraceCode currently consumes tagged releases rather than floating commit SHAs.

## Repository Layout

- `packages/`
  Source packages for the runtime surface.
- `workers/`
  Browser worker assets.
- `fixtures/`
  Runtime trace fixture snapshots.
- `tests/`
  Regression coverage for the harness contract.
- `scripts/`
  Artifact generation helpers.

## Current Consumer Model

TraceCode currently consumes this repo as a dependency while preserving thin compatibility facades locally. That lets the harness evolve as its own project without forcing the app to refactor all execution imports at once.

## License

GPL-3.0-only
