# `@tracecode/harness-core`

Shared runtime contracts and trace helpers for TraceCode Harness.

Import path:

```ts
import type { ExecutionResult } from '@tracecode/harness-core';
```

Public surface:

- runtime/result types
- runtime trace types and helpers

The umbrella package also exposes the same public surface at
`@tracecode/harness/core` for backwards-compatible all-in-one installs.

Use this package when you need stable types and trace-shape utilities without
pulling in browser runtime assets.

See the root README for the package overview.
