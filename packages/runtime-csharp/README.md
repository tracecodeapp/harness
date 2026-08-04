# `@tracecode/runtime-csharp`

C# runtime client and browser worker assets for TraceCode Harness.

This is a private implementation workspace used to build the root release. It
is not published independently, and the root package has no `/csharp`
subpath. It contains the C# worker plus its browser runtime and compiler
assets.

Code inside this monorepo imports it directly:

```ts
import {
  CSharpWorkerClient,
  createCSharpRuntimeClient,
} from '@tracecode/runtime-csharp';
```

Published browser consumers select C# through the provider-neutral runtime host
and Judge contracts. Browser project consumers use
`@tracecode/harness/tracekernel`; neither path exposes C# runtime clients
directly.

Runtime assets are shipped at `workers/csharp-worker.js` and in three role
trees:

- `workers/vendor/csharp/` is the general Project, terminal, filesystem,
  process, network, and server-capable host.
- `workers/vendor/csharp-compiler/` is the persistent trusted C# compiler
  authority used by Judge preparation.
- `workers/vendor/csharp-runner/` is the compiler-free disposable Judge
  runner.

The compiler may retain only trusted toolchain state and immutable compiled
artifacts. Every runner that receives a learner assembly is terminated after
its eager case batch. The runner validates both the source-derived artifact key
and SHA-256 of the exact PE bytes before assembly load.

Judge startup performs one fixed trusted traced compilation in the serialized
compiler authority while loading a clean standby runner in parallel. The
SHA-bound trusted artifact is then executed once in that runner to initialize
the shared compilation, tracing, assembly-load, and reflection paths. It uses
fixed inputs and a collectible load context; it carries no learner source,
filesystem, process, network, TraceKernel, or Mux authority. If a runner has
already been leased, background priming never appends work after the learner.

The runner publish uses the `JudgeReferences` linker profile. Because learner
assemblies are compiled and loaded after publishing, the linker cannot
discover their BCL calls. The profile therefore roots every assembly exposed
by the compiler's Minimal Judge reference pack and removes only assemblies
outside that declared language surface. The general and compiler bundles
remain unlinked.
The role-split release script fails closed if asked for the broader
`Compatibility` compiler pack: that pack requires a correspondingly rooted
runner and must never be paired with the Minimal runner accidentally.

Deploy each tree beneath a content-addressed or release-versioned URL and serve
it with `Cache-Control: public, max-age=31536000, immutable`. Do not apply an
immutable policy to a URL whose bytes can be overwritten. A consumer-owned
browser runtime manifest should declare
`delivery: { mutability: 'immutable', address: 'content' | 'versioned' }` for
the role assets so successful preflights can be reused.

`pnpm test:csharp-role-assets` fails if the runner contains compiler
assemblies, the general Host, compiler VFS files, omits any rooted Minimal
Judge reference, or exceeds its raw/Brotli size ceilings. Review
`THIRD_PARTY_NOTICES.md` before redistributing the root package.
