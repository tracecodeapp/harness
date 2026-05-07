# `@tracecode/harness-browser`

Browser runtime entrypoint for TraceCode harness.

Import path:

```ts
import { createBrowserHarness } from '@tracecode/harness-browser';
```

Public surface:

- `createBrowserHarness(...)`
- runtime capability guards
- supported-language profiles

This entrypoint is intentionally high-level. Low-level worker constructors and internal bootstrap details are not the stable public API.

The umbrella package also exposes the same public surface at
`@tracecode/harness/browser` for backwards-compatible all-in-one installs.

Install the language packages whose runtime assets you actually ship, such as
`@tracecode/harness-python` or `@tracecode/harness-java`.

See the root README for installation, asset sync, and example integration guidance.
