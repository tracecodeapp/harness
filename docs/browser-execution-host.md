# Browser execution origin

TraceCode browser project runtimes should not share an origin with the
application. A Worker creates a separate JavaScript realm, but it retains the
page origin's IndexedDB, Cache Storage, cookies, and network authority. CheerpJ
also requires its IndexedDB-backed /files mount for full Java project mode.

The browser harness therefore provides a narrow cross-origin Worker broker:

- the application keeps the workspace, TraceKernel policy, HTTP bridge, and
  synchronous SharedArrayBuffer protocol;
- a hidden iframe on the execution origin creates runtime Workers;
- the iframe accepts only an exact parent origin and exact worker origins;
- worker messages and SharedArrayBuffers are relayed over one MessagePort;
- CheerpJ runtime storage is enabled only for Java workers created through this
  explicit execution-origin contract.

For `workspace-session`, the execution origin—not mutation of CheerpJ's live
JavaScript globals—is the application-authority boundary. The Java VM remains
mutable for the lifetime of that one workspace and is terminated on workspace
dispose. The host origin must therefore be credential-free and enforce a
network CSP; it is not a second application origin.

## Execution-origin endpoint

Bundle this module on the dedicated execution origin:

~~~ts
import { installBrowserExecutionWorkerHost } from '@tracecode/harness-browser';

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

## TraceCode workspace profile

~~~ts
const workspace = await createBrowserProjectWorkspace({
  executionHost: {
    url: 'https://exec.tracecode.app/host.html',
    javaLifecycle: 'workspace-session',
  },
  assets: {
    runtimeManifests: {
      java: javaRuntimeManifest,
    },
  },
  files,
});
~~~

Java runtime assets must use delivery URLs on the execution/CDN origins. JAR
descriptors use runtimePath for CheerpJ's VFS:

~~~ts
{
  url: 'https://exec.tracecode.app/workers/vendor/java-browser-helper.jar',
  runtimePath: '/app/workers/vendor/java-browser-helper.jar'
}
~~~

TraceCode's first-party manifest may select the official CheerpJ 4.2 loader.
The harness does not embed that URL or version; other consumers remain free to
publish their own manifests.

## Lifecycle profiles

| Surface | Java lifecycle | Reason |
|---|---|---|
| Interactive editor | workspace-session | Pay CheerpJ/JDK warmup once; use fresh classloaders and command state |
| Hidden tests or adversarial evaluation | per-command with clean prewarm depth 1 | Retire all user runtime state after each evaluated command |

A dedicated origin protects the TraceCode application, but a session-lived VM
does not by itself prove that hostile Java threads or runtime state cannot
influence a later command. Hidden-test and multi-principal workloads should use
the per-command profile until the compiler and execution VMs are separated.

Destroying or disposing the workspace terminates hosted workers, closes the
MessagePort, and removes the iframe. Execution-origin storage should also have
server/product-level quota and expiration cleanup.

In a three-context Chromium measurement with the official CheerpJ 4.2 loader,
`java:1` prewarm averaged 14.03 s during workspace construction, then 1.45 s
for the first tiny `javac && java` command and 0.77 s for the identical second
command. Both measured command phases transferred zero response-body bytes.
These are development-machine measurements, not universal latency guarantees.
