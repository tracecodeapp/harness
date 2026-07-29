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

## TraceJVM project provider

TraceJVM is the default Java project runtime in Harness 0.13. The
`@tracecode/harness-java/tracejvm-project` entry point adapts TraceJVM's generic
Java 23 API to TraceKernel's process and filesystem contracts. Applications
install TraceJVM independently and provide a factory for fresh Worker clients:

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

Harness does not declare TraceJVM as a package or peer dependency. The adapter
consumes a small exported structural client contract so Harness can build and
ship independently; applications that select this provider install and inject
their chosen compatible TraceJVM release explicitly.

CheerpJ is retained only as an explicit rollback in 0.13:

```ts
const workspace = await createBrowserProjectWorkspace({
  providers: ['java'],
  javaRuntime: 'legacy',
  assets: {
    runtimeManifests: {
      java: legacyJavaManifest,
    },
  },
});
```

There is no implicit fallback. A Java project without `traceJVM.createClient`
fails during workspace creation unless `javaRuntime: 'legacy'` is selected.

The adapter binds one coordinator to the TraceKernel PID but admits each
`javac` or `java` invocation to a fresh Worker. Compilation artifacts are
committed to TKFS and subsequent commands read them from TKFS, including
commands chained inside one kernel process.

Compilation remains value-oriented: `javac` receives an immutable TKFS snapshot
and commits its output as a final diff. Running Java programs use TraceJVM's
process-scoped host port for live kernel operations. Ordinary Java file and
random-access APIs use authoritative TKFS; stdin, stdout, stderr, pipes, and
socket channels use process-owned descriptors; `ProcessBuilder` creates
kernel-supervised children; selectors multiplex kernel readiness; and ordinary
`WatchService` registrations observe live cross-runtime TKFS changes.
The standalone `io.tracecode.tracekernel.TraceKernel` API adds process identity,
watchdog arm/pet/disarm/status, `setsid`, `setpgid`, `tcgetpgrp`, and
`tcsetpgrp` without patching `java.base`; the adapter routes those calls through
the same generic host port to authoritative TraceKernel state.

TraceJVM is independent of CheerpJ and its private filesystem/layout. The
adapter requires a fresh disposable Worker for every invocation and never
reuses mutable VM state across kernel process leases.

TraceJVM intentionally has no Trace Mode protocol. Harness remains responsible
for Java rewriting, instrumentation, trace limits, event transport, and trace
reconstruction. The semantic provider differential compares those observable
results against the previous Java provider during the 0.13 transition.

Review `THIRD_PARTY_NOTICES.md` before redistributing Java runtime assets.
