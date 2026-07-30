# `@tracecode/runtime-javascript`

JavaScript and TypeScript execution helpers plus browser worker assets for
TraceCode Harness.

This is a private workspace bundled into the published root package. Consumers
use the supported root subpath:

```ts
import { JavaScriptWorkerClient, createJavaScriptRuntimeClient, executeJavaScriptCode } from '@tracecode/harness/javascript';
```

Public surface:

- JavaScript execution helpers
- TypeScript execution/transpilation helpers
- runtime declaration helpers used by the JS/TS worker layer
- browser worker client and runtime client

Runtime assets are shipped under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing the root package, especially the
TypeScript section.
