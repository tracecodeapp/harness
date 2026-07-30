# `@tracecode/harness-csharp`

C# runtime client and browser worker assets for TraceCode Harness.

Install this package only when your application needs the C# lane. It contains
the C# worker plus its browser runtime and compiler assets.

Import path:

```ts
import { CSharpWorkerClient, createCSharpRuntimeClient } from '@tracecode/harness-csharp';
```

The umbrella package also exposes the same public surface at
`@tracecode/harness/csharp` for backwards-compatible all-in-one installs.

Runtime assets are published at `workers/csharp-worker.js` and beneath
`workers/vendor/csharp/`. Review `THIRD_PARTY_NOTICES.md` before
redistributing the package.
