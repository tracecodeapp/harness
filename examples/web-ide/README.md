# Example Web IDE

Minimal tracing/problem-style reference consumer for `@tracecode/harness`.

This app is intentionally small. It exists to prove that a third-party browser app can:

- install the package
- sync the published worker assets
- create an explicit browser harness instance
- execute and trace Python, JavaScript, TypeScript, Java, C#, and C++
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

## What It Demonstrates

- `createBrowserHarness(...)` from `@tracecode/harness/browser`
- worker asset syncing through `tracecode-harness sync-assets`
- runtime initialization for Python, JavaScript, TypeScript, Java, C#, and C++
- execution output and full trace payload rendering

## Production Note

This example uses the workspace package during local development. Outside this
repository, install the published package from npm and keep the same public API
usage.
