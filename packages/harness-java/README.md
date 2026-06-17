# `@tracecode/harness-java`

Java runtime client and browser worker assets for TraceCode Harness.

Install this package only when your application needs the Java lane. It contains
the Java worker and Java helper JARs. CheerpJ is not vendored or redistributed by
this package; applications that enable the Java lane must provide a licensed
CheerpJ loader through a same-origin `/app/` asset path documented in
`THIRD_PARTY_NOTICES.md`.

Import path:

```ts
import { JavaWorkerClient, createJavaRuntimeClient } from '@tracecode/harness-java';
```

The umbrella package also exposes the same public surface at
`@tracecode/harness/java` for backwards-compatible all-in-one installs.

Runtime assets are published under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing this package, especially the CheerpJ and OpenJDK/JBR
sections.

The Java lane trusts the host application's CheerpJ asset pipeline. Browser
worker `importScripts()` does not provide browser-enforced subresource
integrity, so the worker rejects remote loader URLs and only imports same-origin
`/app/` asset paths. If your deployment needs self-hosted or bundled CheerpJ
artifacts, confirm the required CheerpJ license and maintain explicit
hashes/allowlists for those assets.
