# `@tracecode/harness-java`

Java runtime client and browser worker assets for TraceCode Harness.

Install this package only when your application needs the Java lane. It contains
the Java worker and Java helper JARs; the worker loads CheerpJ Core remotely from
Leaning Technologies' `cjrtnc.leaningtech.com` runtime domain at the pinned
versioned loader path documented in `THIRD_PARTY_NOTICES.md`. CheerpJ is not
vendored or redistributed by this package.

Import path:

```ts
import { JavaWorkerClient, createJavaRuntimeClient } from '@tracecode/harness-java';
```

The umbrella package also exposes the same public surface at
`@tracecode/harness/java` for backwards-compatible all-in-one installs.

Runtime assets are published under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing this package, especially the CheerpJ and OpenJDK/JBR
sections.

The Java lane trusts Leaning Technologies' hosted CheerpJ runtime. The worker
restricts the remote loader to the pinned CheerpJ runtime CDN path, but browser
worker `importScripts()` does not provide browser-enforced subresource
integrity. If your deployment requires hash-locked CheerpJ artifacts or
self-hosting, use a CheerpJ Commercial License and provide those assets through
your own controlled runtime asset pipeline.
