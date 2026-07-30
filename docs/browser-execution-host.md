# Browser execution origin

TraceCode browser runtimes should not share an origin with the application. A
Worker creates a separate JavaScript realm, but it retains the page origin's
storage and network authority. Runtime implementation details must not inherit
application cookies, authenticated fetch access, or learner-visible data.

`BrowserRuntimeHost` can therefore route selected runtime Workers through a
narrow cross-origin broker:

- the application keeps the Judge plan, TraceKernel policy, workspace, and
  synchronous SharedArrayBuffer protocol;
- a hidden iframe on the execution origin creates runtime Workers;
- the iframe accepts only an exact parent origin and exact worker origins;
- worker messages and SharedArrayBuffers are relayed over one `MessagePort`;
- runtime storage, if any, remains on the credential-free execution origin.

The host owns asset resolution, readiness, warmup, and provider teardown. It
does not expose runtime clients, prepared providers, or direct execution
methods. `createBrowserRuntimeJudge` is the public composition boundary.

## Execution-origin endpoint

Bundle this module on the dedicated execution origin:

```ts
import {
  installBrowserExecutionWorkerHost,
} from '@tracecode/harness/browser';

installBrowserExecutionWorkerHost({
  allowedParentOrigins: ['https://app.tracecode.app'],
});
```

The endpoint must not receive application authentication cookies or contain
application data. A representative response policy is:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  worker-src 'self';
  connect-src 'self';
  frame-ancestors https://app.tracecode.app
Referrer-Policy: no-referrer
```

The application page must also be cross-origin isolated. Host creation fails
closed without the SharedArrayBuffer and Atomics support used by runtime I/O
and TraceKernel bridges. If immutable runtime assets live on another origin,
add only that exact origin to the endpoint CSP and configure its CORS and CORP
headers explicitly.

## Host and Judge composition

Route selected languages when creating the host, then create Judge inside an
Effect scope. The host can outlive one evaluation; the scope cannot.

```ts
import * as Effect from 'effect/Effect';
import {
  createBrowserRuntimeHost,
  type BrowserRuntimeAssetManifest,
} from '@tracecode/harness/browser';
import {
  createBrowserRuntimeJudge,
  type JudgeEvaluationPlan,
} from '@tracecode/harness/judge';

async function evaluateJava(
  plan: JudgeEvaluationPlan<Record<string, unknown>, unknown>,
  javaRuntimeManifest: BrowserRuntimeAssetManifest<'java'>
) {
  const host = createBrowserRuntimeHost({
    providers: ['java'],
    executionHost: {
      url: 'https://runtime.example.com/host.html',
      providers: ['java'],
    },
    assets: {
      runtimeManifests: {
        java: javaRuntimeManifest,
      },
    },
  });

  try {
    await host.preflightLanguage('java');
    await host.warmLanguage('java');

    return await Effect.runPromise(
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
}
```

The Effect scope releases TraceKernel sessions and prepared evaluation
artifacts on success, failure, or interruption. `host.dispose()` retires the
longer-lived browser runtime resources. A structurally similar object cannot
inject a provider into Browser Judge; the host must come from
`createBrowserRuntimeHost`.

When `executionHost.providers` is omitted, every language selected by the host
is routed through the broker. JavaScript and TypeScript share one browser
worker and must be routed together. Every hosted worker URL must resolve on the
execution origin; runtime manifests and their immutable asset locations remain
consumer-owned.

## Java runtime asset tree

The root `@tracecode/harness` asset set contains Java's Harness bridge worker
and Harness-owned helper assets. It intentionally does not make the external
engine distribution part of the npm package.

Serve the engine module, engine WASM, and complete runtime profile from one
versioned, immutable tree:

```text
https://assets.example.com/java/engine-2026-07-30/
  browser-client.js
  bjvm_main.wasm
  profiles/core/...
```

The configured tree URL must end in `/`. The bridge resolves module, WASM, and
profile requests relative to that base; without the slash, URL resolution
treats the last path component as a file and can escape the versioned
directory. Do not mix profile files or WASM from different releases, and do not
put mutable responses behind an immutable manifest address.

The bridge worker belongs on the credential-free execution origin. The engine
tree may be served there as well, or from a separately allowlisted static
origin with compatible cross-origin headers. This is an asset-delivery
contract, not a public engine selector or provider-specific API.

## Browser project workspaces

Browser project mode has a separate public composition at
`@tracecode/harness/browser/project`. Python, JavaScript/TypeScript, C#, and C++
project workers can use the execution broker. TypeScript compilation occurs in
the trusted page and emitted JavaScript runs through the JavaScript project
worker, so hosted TypeScript requires the JavaScript project provider.

Java project mode uses the implementation-neutral client factory supplied by
the application:

```ts
import {
  createBrowserProjectWorkspace,
} from '@tracecode/harness/browser/project';

const workspace = await createBrowserProjectWorkspace({
  providers: ['java'],
  java: {
    createClient: createJavaClientOnExecutionOrigin,
  },
  files,
});
```

The application-provided factory owns its Worker origin and runtime assets. It
must return a fresh disposable client for each admitted Java invocation so
learner-observable VM state cannot cross process boundaries. Destroying the
workspace releases the provider and all Workers owned by that workspace.

## Publication boundary

This repository publishes only `@tracecode/harness`. The supported package
entrypoints are the root, `/browser`, `/browser/project`, `/project`,
`/project-node`, `/judge`, and `/package.json`. Per-language, `/core`,
`/native`, and `/internal/*` subpaths are not public. See
[Root Package Publishing](./publishing.md) for the audited release path.
