# `@tracecode/harness-java`

Java runtime client and browser worker assets for TraceCode Harness.

Install this package only when your application needs the Java lane. It contains
the Java worker and Java helper JARs. CheerpJ is not vendored or redistributed by
this package; applications that enable the Java lane must provide a licensed
CheerpJ loader through consumer-owned runtime asset configuration documented in
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

The Java lane trusts the host application's CheerpJ asset pipeline. Owned
browser project runners require a complete `assets.runtimeManifests.java`
declaration (`worker`, `loader`, `helperJar`, `compilerJar`, `rewriterJar`, and
`parserJar`) or a consumer-provided `javaWorkerClient`. Manifest URLs may be
self-hosted or served from a consumer-approved HTTP(S) CDN under the declared
origin policy. Because worker `importScripts()` does not provide
execution-bound SRI, use immutable URLs, confirm the required CheerpJ license,
and maintain explicit deployment hashes and allowlists.
