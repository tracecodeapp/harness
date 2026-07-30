# `@tracecode/runtime-csharp`

C# runtime client and browser worker assets for TraceCode Harness.

This is a private workspace bundled into the published root package. Import the
supported `@tracecode/harness/csharp` subpath when an application needs the C#
lane. It contains the C# worker plus its browser runtime and compiler assets.

Import path:

```ts
import { CSharpWorkerClient, createCSharpRuntimeClient } from '@tracecode/harness/csharp';
```

Runtime assets are shipped at `workers/csharp-worker.js` and beneath
`workers/vendor/csharp/`. Review `THIRD_PARTY_NOTICES.md` before
redistributing the root package.
