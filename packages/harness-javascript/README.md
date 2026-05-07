# `@tracecode/harness-javascript`

JavaScript and TypeScript execution helpers plus browser worker assets for
TraceCode harness.

Import path:

```ts
import { JavaScriptWorkerClient, createJavaScriptRuntimeClient, executeJavaScriptCode } from '@tracecode/harness-javascript';
```

Public surface:

- JavaScript execution helpers
- TypeScript execution/transpilation helpers
- runtime declaration helpers used by the JS/TS worker layer
- browser worker client and runtime client

The umbrella package also exposes the same public surface at
`@tracecode/harness/javascript` for backwards-compatible all-in-one installs.

Runtime assets are published under `workers/`. Review
`THIRD_PARTY_NOTICES.md` before redistributing this package, especially the
TypeScript section.
