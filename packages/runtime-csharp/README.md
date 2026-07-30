# `@tracecode/runtime-csharp`

C# runtime client and browser worker assets for TraceCode Harness.

This is a private implementation workspace used to build the root release. It
is not published independently, and the root package has no `/csharp`
subpath. It contains the C# worker plus its browser runtime and compiler
assets.

Code inside this monorepo imports it directly:

```ts
import {
  CSharpWorkerClient,
  createCSharpRuntimeClient,
} from '@tracecode/runtime-csharp';
```

Published browser consumers select C# through the provider-neutral runtime host
and Judge contracts. Browser project consumers use
`@tracecode/harness/browser/project`; neither path exposes C# runtime clients
directly.

Runtime assets are shipped at `workers/csharp-worker.js` and beneath
`workers/vendor/csharp/`. Review `THIRD_PARTY_NOTICES.md` before
redistributing the root package.
