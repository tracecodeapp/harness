# Browser runtime workspace

`packages/runtime-browser` is a private implementation workspace. It is bundled
into the root `@tracecode/harness` release and must not be installed or
imported as a standalone package.

Consumers create the browser-owned lifecycle from
`@tracecode/harness/browser` and compose it with Judge from
`@tracecode/harness/judge`:

```ts
import * as Effect from 'effect/Effect';
import {
  createBrowserRuntimeHost,
} from '@tracecode/harness/browser';
import {
  createBrowserRuntimeJudge,
  type JudgeEvaluationPlan,
} from '@tracecode/harness/judge';

async function evaluate(
  plan: JudgeEvaluationPlan<Record<string, unknown>, unknown>
) {
  const host = createBrowserRuntimeHost({
    providers: ['python'],
    assetBaseUrl: '/workers',
  });

  try {
    await host.preflightLanguage('python');

    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const judge = yield* createBrowserRuntimeJudge({
            host,
            language: 'python',
            binding: {
              sourcePath: '/workspace/solution.py',
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

`BrowserRuntimeHost` owns browser assets, readiness, provider warmup, optional
credential-free worker routing, and final teardown. It intentionally has no
client getter, prepared-provider getter, or direct execution method. Browser
Judge is the only public bridge from a genuine host to prepared evaluation.
`Effect.scoped` releases Judge and TraceKernel resources, while
`host.dispose()` releases the reusable browser lifecycle.

## Public package boundary

This repository has one registry release: `@tracecode/harness`. Its current
export map contains only:

- `@tracecode/harness`
- `@tracecode/harness/browser`
- `@tracecode/harness/browser/project`
- `@tracecode/harness/project`
- `@tracecode/harness/project-node`
- `@tracecode/harness/judge`
- `@tracecode/harness/package.json`

There are no public per-language, `/core`, `/native`, `/sql`, or `/internal/*`
subpaths. Provider registries, provider leases, runtime clients, prepared
providers, and worker constructors remain private workspace contracts.

The browser entrypoint exposes the host lifecycle, readiness and asset
configuration, execution-origin endpoint, capability guards, and
provider-neutral runtime metadata. It pre-registers the supported language
implementations internally so applications select languages without importing
provider packages.

## Project mode

Browser project/workspace mode is exposed separately:

```ts
import {
  createBrowserProjectWorkspace,
} from '@tracecode/harness/browser/project';
```

Shared project APIs use `@tracecode/harness/project`; trusted local runners use
`@tracecode/harness/project-node`. The browser host/Judge boundary above is for
single-submission algorithm evaluation and does not expose direct runtime
clients.

## Runtime assets

`tracecode-harness sync-assets` copies Harness-owned bridge workers and helper
assets from the root package. Consumer-owned engine distributions remain
outside the npm package and are supplied through versioned runtime manifests.

For Java, the root assets include the Harness bridge worker. Serve the engine
module, engine WASM, and complete runtime profile as one immutable versioned
tree whose base URL ends in `/`, for example:

```text
/runtimes/java/engine-2026-07-30/
  browser-client.js
  bjvm_main.wasm
  profiles/core/...
```

The bridge resolves all engine files relative to that slash-terminated base.
Do not mix engine releases, split one profile across mutable roots, or omit the
trailing slash.

See the [root README](../../README.md) for installation and a complete Judge
plan, and [Browser execution origin](../../docs/browser-execution-host.md) for
credential-free Worker hosting.
