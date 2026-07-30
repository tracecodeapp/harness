# `@tracecode/runtime-java`

Java runtime clients, project-provider contracts, and browser worker assets for
TraceCode Harness.

This is a private workspace bundled into the published root package. Import the
supported `@tracecode/harness/java` subpath when an application needs the Java
lane. The high-level Java 23 project contract is implementation-neutral. The
bundled Classic browser worker and helper JARs currently integrate with
CheerpJ; CheerpJ itself is not vendored or redistributed, and consumers of
those assets must provide a licensed loader as documented in
`THIRD_PARTY_NOTICES.md`.

Import path:

```ts
import { JavaWorkerClient, createJavaRuntimeClient } from '@tracecode/harness/java';
```

## Judge prepared provider

Judge-backed evaluation must bind Java through
`createJavaBrowserPreparedExecutionProvider`. The root browser registry passes
the explicitly selected prepared-worker URL, worker factory, and asset
preflights to that constructor:

```ts
const java = createJavaBrowserPreparedExecutionProvider({
  workerUrl: assets.javaWorker,
  workerFactory: workerFactoryFor('java'),
  assetPreflight: preflight('java', ['worker']),
});
```

That factory rewrites and compiles the source once into an immutable class
snapshot, then destroys the compiler worker. Every case restores that snapshot
into a brand-new hard Worker, runs exactly once, and destroys the Worker before
the next case starts. Mutable VM state cannot cross that boundary: static
fields and class initialization, system properties, locale and time-zone
defaults, runtime filesystem writes, thread state, shutdown hooks, and future
engine-owned host state all die with the case Worker. No case invokes `javac`.

Its program advertises `fresh-case-state` with `maxConcurrency: 1`. Judge owns
the corresponding backpressure and calls `dispose()` when the evaluation
ends. Concurrent case requests are serialized; disposal hard-aborts an active
Worker, drains the operation boundary, and prevents queued requests from
starting.

Browser-host language release calls `releaseStandby()`, which discards only an
unused warm Worker and allows the next `init()` or `prepareProgram()` to restart
lazily. Full `dispose()` is final and permanently invalidates the provider.

The prepared registry must not construct Java through
`createJavaRuntimeClient`. That is the legacy single-call adapter and would
silently recompile once per case. There is no legacy fallback in the prepared
factory: a missing or invalid prepared-worker URL is a construction error.
The URL must select the TraceJVM-backed Java worker. The classic/CheerpJ worker
does not expose the prepared artifact protocol, so preparation fails closed
instead of recompiling cases or falling back to the legacy client.
The root browser lease exposes this provider explicitly in its
`preparedProviders` map under `java`; it must never infer a prepared provider
from the legacy `clients` map.

## Java 23 project provider

The Java root subpath adapts a structural Java 23 client to TraceKernel's
process and filesystem contracts. Applications install a compatible runtime
independently and provide a factory for fresh Worker clients. For example,
TraceJVM satisfies that structural contract:

```ts
import { TraceJVMWorkerClient } from '@tracecode/tracejvm';
import { createBrowserProjectWorkspace } from '@tracecode/harness/browser/project';

const workspace = await createBrowserProjectWorkspace({
  providers: ['java'],
  java: {
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

Harness does not declare the example runtime as a package or peer dependency.
The adapter consumes a small exported structural client contract so Harness can
build and ship independently. Browser project workspaces expose this provider
only as `java`; there is no engine-branded selector or implicit fallback.
A workspace that selects Java must provide `java.createClient` or a low-level
`javaWorkerClient` satisfying the browser project command contract.

The adapter binds one coordinator to the TraceKernel PID but admits each
`javac` or `java` invocation to a fresh Worker. Compilation artifacts are
committed to TKFS and subsequent commands read them from TKFS, including
commands chained inside one kernel process.

Compilation remains value-oriented: `javac` receives an immutable TKFS snapshot
and commits its output as a final diff. Running Java programs use the
provider's process-scoped host port for live kernel operations. Ordinary Java
file and random-access APIs use authoritative TKFS; stdin, stdout, stderr,
pipes, and socket channels use process-owned descriptors; `ProcessBuilder`
creates kernel-supervised children; selectors multiplex kernel readiness; and
ordinary `WatchService` registrations observe live cross-runtime TKFS changes.
The standalone `io.tracecode.tracekernel.TraceKernel` API adds process identity,
watchdog arm/pet/disarm/status, `setsid`, `setpgid`, `tcgetpgrp`, and
`tcsetpgrp` without patching `java.base`; the adapter routes those calls through
the same generic host port to authoritative TraceKernel state.

The adapter requires a fresh disposable Worker for every invocation and never
reuses mutable VM state across kernel process leases.

The Java project provider contract intentionally has no Trace Mode protocol.
Harness remains responsible for Java rewriting, instrumentation, trace limits,
event transport, and trace reconstruction.

Review `THIRD_PARTY_NOTICES.md` before redistributing Java runtime assets.
