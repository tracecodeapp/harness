# Example Web IDE

Minimal reference consumer for `@tracecode/harness`.

This app is intentionally small. It exists to prove that a third-party browser app can:

- install the package
- sync the published worker assets
- create an explicit browser harness instance
- execute and trace Python, JavaScript, and TypeScript

It is not the canonical TraceCode product UI.

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
- runtime initialization for Python, JavaScript, and TypeScript
- execution output and full trace payload rendering

## Production Note

This example uses the workspace package during local development:

```json
"@tracecode/harness": "workspace:*"
```

Outside this repository, install the published package from npm and keep the same public API usage.

Project site: [tracecode.app](https://tracecode.app)
