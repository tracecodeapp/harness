# Browser execution origin

TraceCode browser runtimes should not share an origin with the application. A
Worker creates a separate JavaScript realm, but it retains the page origin's
IndexedDB, Cache Storage, cookies, and network authority. The bundled Classic
Java client also uses an IndexedDB-backed writable mount.

The browser harness therefore provides a narrow cross-origin Worker broker:

- the application keeps the workspace, TraceKernel policy, HTTP bridge, and
  synchronous SharedArrayBuffer protocol;
- a hidden iframe on the execution origin creates runtime Workers;
- the iframe accepts only an exact parent origin and exact worker origins;
- worker messages and SharedArrayBuffers are relayed over one MessagePort;
- implementation-specific runtime storage is enabled only when a client
  explicitly opts into that execution-origin contract.

## Execution-origin endpoint

Bundle this module on the dedicated execution origin:

~~~ts
import { installBrowserExecutionWorkerHost } from '@tracecode/harness/browser';

installBrowserExecutionWorkerHost({
  allowedParentOrigins: ['https://app.tracecode.app'],
});
~~~

The endpoint must not receive application authentication cookies or contain
application data. A representative response policy is:

~~~text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  worker-src 'self';
  connect-src 'self' https://cjrtnc.leaningtech.com;
  frame-ancestors https://app.tracecode.app
Referrer-Policy: no-referrer
~~~

The application page must also be cross-origin isolated. The harness rejects
execution-host creation otherwise because Java stdin and TraceKernel HTTP use
SharedArrayBuffer and Atomics.

## Provider routing

Classic can route any selected worker-backed provider through the host without
changing where the other providers load. Project mode can route Python,
JavaScript/TypeScript, C#, and C++ through the same host. Each hosted worker URL
must resolve on the execution origin; runtime manifests and CDN locations stay
consumer-owned.

~~~ts
const harness = createBrowserHarness({
  executionHost: {
    url: 'https://runtime.example.com/host.html',
    providers: ['java'],
  },
  assets: { runtimeManifests: { java: javaRuntimeManifest } },
});
~~~

Classic defaults to all selected providers when `executionHost.providers` is
omitted. JavaScript and TypeScript share one Classic worker and therefore must
be routed together. Project mode defaults to its selected non-Java providers.
TypeScript project compilation occurs in the trusted page and its emitted
JavaScript executes through the JavaScript project worker, so hosted TypeScript
requires the JavaScript project provider.

Browser Project Java is different: its Java 23 provider owns the Worker
boundary supplied by `java.createClient`. Project
`executionHost.providers` therefore rejects `java`; configure the provider's
client factory to create Workers on the desired credential-free origin.

~~~ts
const workspace = await createBrowserProjectWorkspace({
  providers: ['java'],
  java: {
    createClient: createJavaClientOnExecutionOrigin,
  },
  files,
});
~~~

Here `createJavaClientOnExecutionOrigin` is the application's compatible Java
provider factory, configured to create its Worker on the credential-free
origin.

The generic adapter admits every `javac` or `java` invocation to a fresh client
and terminates it at the invocation boundary. A provider may warm immutable
runtime infrastructure internally, but it must not reuse learner-observable VM
state. Destroying or disposing the workspace releases the provider and every
hosted worker owned by the workspace.

Consumers that explicitly pass the bundled low-level `javaWorkerClient` own
its asset, storage, origin, and retirement policy. Its current CheerpJ asset
requirements and licensing boundary are documented in
`THIRD_PARTY_NOTICES.md`; they are not part of the Java 23 provider contract.
