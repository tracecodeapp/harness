# `@tracecode/harness/browser`

Browser runtime entrypoint for `@tracecode/harness`.

Import path:

```ts
import { createBrowserHarness } from '@tracecode/harness/browser';
```

Public surface:

- `createBrowserHarness(...)`
- runtime capability guards
- supported-language profiles

This entrypoint is intentionally high-level. Low-level worker constructors and internal bootstrap details are not the stable public API.

See the root README for installation, asset sync, and example integration guidance.
