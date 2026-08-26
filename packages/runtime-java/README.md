# Java runtime workspace

`packages/runtime-java` is a private implementation workspace. It is bundled
into the root `@tracecode/harness` release and must not be installed or
imported as a standalone package. There is no public per-language Java
entrypoint.

Applications evaluate Java through the same public boundary as every other
algorithm runtime:

```ts
import * as Effect from 'effect/Effect';
import { createBrowserJudgeHost } from '@tracecode/harness/judge';

const host = createBrowserJudgeHost({
  providers: ['java'],
  assetBaseUrl: '/workers',
});

try {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const judge = yield* host.createJudge({
          language: 'java',
          binding: {
            sourcePath: '/workspace/Solution.java',
            functionName: 'solve',
            executionStyle: 'function',
          },
        });
        return yield* judge.evaluate(plan);
      })
    )
  );
} finally {
  host.dispose();
}
```

`BrowserJudgeHost` owns readiness, warmup, and provider teardown. Judge owns
program preparation, case execution, comparison policy, and the scoped
TraceKernel lifecycle. Runtime clients and prepared providers remain private.

Server-hosted browser authorities may set `java.externalCompilerUrl` to a
same-origin trusted compilation endpoint. That endpoint replaces only the
compiler: the host keeps the compiler authority warm, while each learner
program continues to execute in a fresh disposable Java runner. Browser-only
consumers should leave the option unset and use the built-in compiler.

## Runtime assets

The root package supplies the Java bridge and helper assets, and pins the exact
TraceJVM package owned by this Harness version. `tracecode-harness sync-assets`
copies TraceJVM's content-addressed release beneath `/workers/java/tracejvm/`.
The consumer serves the copied tree; it does not install, version, or publish
TraceJVM separately.

Harness normalizes that value as a directory, so a trailing slash is optional.
The bridge resolves all engine assets relative to the normalized directory.
One runtime release must not combine a mutable file, a profile from another
release, or assets from unrelated roots.

`java.runtimeAssetBaseUrl` remains an advanced location override. It must serve
the same pinned release descriptor and bytes; it cannot select a different
TraceJVM version. Individual engine, compiler, helper, or loader URLs are not
public configuration roles.

## Prepared evaluation

The private Java provider keeps one outer Worker and TraceJVM compiler warm for
the lifetime of a prepared program. Compilation produces an immutable class
snapshot. During trusted preparation, its artifact-derived isolation profile
selects one of two inner boundaries. Algorithm-scoped correctness cases retain
one TraceJVM process but receive a fresh application class loader and reset
execution scope; ambient or unverifiable bytecode receives a fresh inner JVM.
Every case still receives a fresh TraceKernel process scope and TKFS. Static
fields, class initialization, system properties, locale and time-zone defaults,
runtime filesystem writes, thread state, VM-global interned strings, and
shutdown hooks cannot cross the case boundary. APIs whose state is not reset by
the application class-loader boundary select compatibility. The full admission
and reset contract is documented in
[Java Algorithm Isolation Profile](../../docs/java-algorithm-isolation-profile.md).

Prepared input JSON travels as process-scoped Java properties rather than
provider-owned files. Learner filesystem calls still use the process-bound
TraceKernel syscall channel, so TraceKernel remains the filesystem authority.
If a document does not expose the synchronous shared-memory transport required
by that channel, the provider fails over to runner-local files and hard-retires
the entire outer Worker after each case. That compatibility mode preserves
isolation but deliberately gives up warm-compiler latency.

The prepared program advertises `fresh-case-state` isolation and serial case
execution. Judge applies backpressure and disposes the program when its Effect
scope ends. Releasing an idle language discards only standby state so a later
warmup can restart it; disposing the host is final.

Preparation fails closed when the bridge or external runtime tree is
incompatible. A crashed or cancelled outer Worker is restored from the
immutable snapshot on its replacement generation, but restored snapshots use
the fresh-JVM compatibility tier because the current caller-carried snapshot
has no independently trusted provenance binding. Ordinary successful
kernel-bound cases do not restore or recompile, and a retained JVM rebinds its
syscall host to the current outer request rather than retaining a released
channel client.

## Browser project workspaces

Browser project mode is exposed through
`@tracecode/harness/tracekernel`. Its Java lane accepts an
implementation-neutral structural client factory:

```ts
import {
  createBrowserWorkspace,
} from '@tracecode/harness/tracekernel';

const workspace = await createBrowserWorkspace({
  providers: ['java'],
  java: {
    createClient: createFreshJavaProjectClient,
  },
  files,
});
```

The application owns that factory's Worker origin when it replaces the built-in
factory. It must return a fresh disposable client for every admitted `javac` or `java`
invocation. The project adapter maps the client to TraceKernel process,
filesystem, descriptor, pipe, socket, selector, and watch-service contracts.
Compilation artifacts are committed to the TraceKernel filesystem so later
commands and other runtime processes observe the same workspace state.

The structural client is a project-workspace seam, not a public per-language
package. Destroying the workspace releases the provider and every Worker owned
by that workspace.
