# `@tracecode/runtime-browser`

Browser runtime entrypoint for TraceCode Harness.

This is a private workspace bundled into the published root package. The
supported browser and language subpaths remain provider-neutral:

```ts
import {
  createBrowserHarness,
  createBrowserRuntimeProviderRegistry,
} from '@tracecode/harness/browser';
import { createPythonBrowserRuntimeProvider } from '@tracecode/harness/python';

const providerRegistry = createBrowserRuntimeProviderRegistry([
  createPythonBrowserRuntimeProvider(),
]);

const harness = createBrowserHarness({
  providerRegistry,
  providers: ['python'],
  assetBaseUrl: '/workers',
});
```

Public surface:

- `createBrowserHarness(...)` with an injected provider registry
- `createBrowserRuntimeProviderRegistry(...)`
- runtime capability guards
- supported-language profiles

Project/workspace mode is exposed separately:

```ts
import { createBrowserProjectWorkspace } from '@tracecode/harness/browser/project';
```

The `/project` subpath wires TraceKernel workspace policy to browser Python,
JavaScript, Java, C#, and C++ project runners. The main browser entrypoint stays
focused on single-file runtime clients.

This entrypoint is intentionally high-level. Low-level worker constructors and
bootstrap details are not the stable public API.

The umbrella package exposes `@tracecode/harness/browser` with all five
language-package providers pre-registered for backwards-compatible all-in-one
installs.

Import the language subpaths whose runtime assets you actually ship, such as
`@tracecode/harness/python` or `@tracecode/harness/java`.

See the root README for installation, asset sync, and examples.
