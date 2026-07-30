# Example Web IDE

Minimal tracing/problem-style reference consumer for `@tracecode/harness`.

This app is intentionally small. It exists to prove that a third-party browser app can:

- install the package
- sync the published worker assets
- create a browser-owned Judge host
- evaluate each action through the scoped browser Judge
- execute and trace Python, JavaScript, TypeScript, C++, C#, and optionally Java
- render execution output and full trace payloads

It is not the canonical TraceCode product UI, and it does not exercise
project-mode workspace semantics. Use `examples/project-ide` for the
TraceKernel project workspace example.

## Run It

From the repository root:

```bash
pnpm --dir examples/web-ide install
pnpm --dir examples/web-ide dev
```

The app syncs harness worker assets into `public/workers` before `dev`, `build`, and `preview`.
The browser Judge host resolves the package's canonical bridge assets from
that directory. Java is enabled only when the build defines an external,
immutable Java runtime asset root:

```bash
VITE_JAVA_RUNTIME_ASSET_BASE_URL=https://assets.example.com/java/v1/ pnpm --dir examples/web-ide dev
```

The URL is passed through the provider-neutral
`java.runtimeAssetBaseUrl` host option. The external tree must expose the
versioned engine modules, Wasm, and profile files expected by the Java bridge,
with CORS and cross-origin resource headers compatible with the app's
cross-origin-isolated deployment. The example deliberately does not publish a
runtime-specific manifest or copy that engine tree into the root package.
Without the environment variable, Java is omitted from the language selector.

## What It Demonstrates

- `createBrowserJudgeHost(...)` from `@tracecode/harness/judge`
- `host.createJudge(...)` for each scoped evaluation
- `Effect.scoped(...)` ownership for each Judge evaluation
- worker asset syncing through `tracecode-harness sync-assets`
- runtime initialization for Python, JavaScript, TypeScript, C++, C#, and
  configured Java deployments
- execution output and full trace payload rendering
- interruption of a previous action before starting the next one
- host disposal after active scoped work has finished

## Production Note

This example uses the workspace package during local development. Outside this
repository, install the published package from npm and keep the same public API
usage.
