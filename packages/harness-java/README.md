# `@tracecode/harness-java`

Java runtime client and browser worker assets for TraceCode harness.

Install this package only when your application needs the Java lane. It contains
the Java worker and Java helper JARs; the worker loads CheerpJ Core remotely from
Leaning Technologies' `cjrtnc.leaningtech.com` runtime domain.

Import path:

```ts
import { JavaWorkerClient, createJavaRuntimeClient } from '@tracecode/harness-java';
```

The umbrella package also exposes the same public surface at
`@tracecode/harness/java` for backwards-compatible all-in-one installs.

Runtime assets are published under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing this package, especially the CheerpJ and OpenJDK/JBR
sections.
