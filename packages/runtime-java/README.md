# Java runtime workspace

`packages/runtime-java` is a private implementation workspace. It is bundled
into the root `@tracecode/harness` release and must not be installed or
imported as a standalone package. There is no public per-language Java
entrypoint.

Applications evaluate Java through the same public boundary as every other
algorithm runtime:

```ts
import * as Effect from 'effect/Effect';
import { createBrowserRuntimeHost } from '@tracecode/harness/browser';
import { createBrowserRuntimeJudge } from '@tracecode/harness/judge';

const host = createBrowserRuntimeHost({
  providers: ['java'],
  assetBaseUrl: '/workers',
  java: {
    runtimeAssetBaseUrl: 'https://assets.example.com/java/2026-07-30/',
  },
});

try {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const judge = yield* createBrowserRuntimeJudge({
          host,
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

`BrowserRuntimeHost` owns readiness, warmup, and provider teardown. Judge owns
program preparation, case execution, comparison policy, and the scoped
TraceKernel lifecycle. Runtime clients and prepared providers remain private.

## Runtime assets

The root package supplies the Harness Java bridge worker and Harness-owned
helper assets. The bridge uses TraceJVM internally. The TraceJVM engine module,
WebAssembly binary, and runtime profile are not bundled into the npm package;
the consumer serves them as one versioned, immutable tree and configures its
directory through `java.runtimeAssetBaseUrl`.

Harness normalizes that value as a directory, so a trailing slash is optional.
The bridge resolves all engine assets relative to the normalized directory.
One runtime release must not combine a mutable file, a profile from another
release, or assets from unrelated roots.

The provider option is intentionally expressed as a runtime asset directory.
Individual engine, compiler, helper, or loader URLs are not public
configuration roles.

## Prepared evaluation

The private Java provider compiles a submission once into an immutable class
snapshot. Each Judge case restores that snapshot into a fresh Worker, executes
once, and destroys the Worker before another case begins. Static fields, class
initialization, system properties, locale and time-zone defaults, runtime
filesystem writes, thread state, and shutdown hooks therefore cannot cross the
case boundary.

The prepared program advertises `fresh-case-state` isolation and serial case
execution. Judge applies backpressure and disposes the program when its Effect
scope ends. Releasing an idle language discards only standby state so a later
warmup can restart it; disposing the host is final.

Preparation fails closed when the bridge or external runtime tree is
incompatible. There is no public direct-client or alternate-engine fallback.

## Browser project workspaces

Browser project mode is exposed through
`@tracecode/harness/browser/project`. Its Java lane accepts an
implementation-neutral structural client factory:

```ts
import {
  createBrowserProjectWorkspace,
} from '@tracecode/harness/browser/project';

const workspace = await createBrowserProjectWorkspace({
  providers: ['java'],
  java: {
    createClient: createFreshJavaProjectClient,
  },
  files,
});
```

The application owns that factory's Worker origin and external runtime assets.
It must return a fresh disposable client for every admitted `javac` or `java`
invocation. The project adapter maps the client to TraceKernel process,
filesystem, descriptor, pipe, socket, selector, and watch-service contracts.
Compilation artifacts are committed to the TraceKernel filesystem so later
commands and other runtime processes observe the same workspace state.

The structural client is a project-workspace seam, not a public per-language
package. Destroying the workspace releases the provider and every Worker owned
by that workspace.
