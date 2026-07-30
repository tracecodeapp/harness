# `@tracecode/runtime-core`

Shared runtime contracts and trace helpers for TraceCode Harness.

This is a private implementation workspace used to build the published root
package. It is not a standalone registry contract, and the root package has no
`/core` subpath. Code inside this monorepo imports it directly:

```ts
import type { ExecutionResult } from '@tracecode/runtime-core';
```

Internal workspace surface:

- runtime/result types
- runtime trace types and helpers

Published consumers use the provider-neutral contracts exposed from
`@tracecode/harness`, `@tracecode/harness/browser`,
`@tracecode/harness/project`, or `@tracecode/harness/judge`, according to the
lifecycle they own. The private runtime package may become standalone only
after its independent contract is defined.

See the root README for the package overview.
