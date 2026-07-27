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

## TraceJVM provider for TraceKernel 0.13

TraceJVM is a separate, default-off Java 23 provider. Configure it with a
factory that returns a fresh `TraceJVMWorkerClient`:

```ts
import { TraceJVMWorkerClient } from '@tracecode/tracejvm';
import { createBrowserProjectWorkspace } from '@tracecode/harness-browser/project';

const workspace = await createBrowserProjectWorkspace({
  providers: ['java'],
  traceJVM: {
    createClient: () => new TraceJVMWorkerClient({
      engine: {
        assets: {
          wasmUrl: '/tracejvm/bjvm_main.wasm',
          runtimeProfileBaseUrls: {
            core: '/tracejvm/profiles/core',
          },
        },
        runtimeProfile: 'core',
      },
      createWorker: () => new Worker('/tracejvm/browser-worker.js', {
        type: 'module',
      }),
    }),
  },
});
```

The 0.13 adapter binds one coordinator to the TraceKernel PID but admits each
`javac` or `java` invocation to a fresh Worker. Compilation artifacts are
committed to TKFS and subsequent commands read them from TKFS, including
commands chained inside one kernel process.

This is intentionally a value adapter, not yet the final Java syscall adapter.
TraceJVM's current public host boundary does not expose application filesystem,
descriptor/stdin, or socket operations. Java application code therefore does
not yet claim live TKFS or socket support; those capabilities require a
TraceJVM host-port extension and corresponding kernel conformance tests.
