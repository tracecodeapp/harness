# `@tracecode/runtime-core`

Shared runtime contracts and trace helpers for TraceCode Harness.

This is a private workspace bundled into the published root package. Consumers
use the supported root subpath:

```ts
import type { ExecutionResult } from '@tracecode/harness/core';
```

Public surface:

- runtime/result types
- runtime trace types and helpers

Use this subpath when you need stable types and trace-shape utilities without
importing a browser runtime entrypoint.

See the root README for the package overview.
