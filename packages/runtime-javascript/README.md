# `@tracecode/runtime-javascript`

JavaScript and TypeScript execution helpers plus browser worker assets for
TraceCode Harness.

This is a private implementation workspace used to build the root release. It
is not published independently, and the root package has no `/javascript`
subpath. Code inside this monorepo imports it directly:

```ts
import {
  JavaScriptWorkerClient,
  createJavaScriptRuntimeClient,
  executeJavaScriptCode,
} from '@tracecode/runtime-javascript';
```

Internal workspace surface:

- JavaScript execution helpers
- TypeScript execution/transpilation helpers
- runtime declaration helpers used by the JS/TS worker layer
- browser worker client and runtime client

Published browser consumers select JavaScript or TypeScript through the
provider-neutral runtime host and Judge contracts. Browser project consumers
use `@tracecode/harness/browser/project`; neither path exposes language runtime
clients directly.

Runtime assets are shipped under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing the root package, especially the
TypeScript section.
