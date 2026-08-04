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

The compiler and runner trees are generated build outputs, not canonical
source-control inputs. Git tracks their deterministic, content-addressed ZIPs
and manifest under `workers/vendor/csharp-role-artifacts/`.
`pnpm materialize:csharp-role-assets` verifies the ZIP SHA-256, inventory
limits, every extracted path, and the complete tree digest before atomically
publishing either tree. Package asset synchronization and C# browser test
commands run that materializer automatically, so a clean checkout does not
depend on somebody's old local publish directory.

`pnpm update:csharp-runtime` is the sole regeneration path. It publishes all
three roles from source with the exact SDK in
`runtimes/csharp/Directory.Build.props`, skips mutable workload-manifest updates,
prunes and packs the outputs, validates the isolation-oriented role surfaces,
then replaces the canonical archives. The manifest records the SDK, target
framework, runtime framework, linker/reference profiles, byte sizes, archive
hashes, and expanded-tree hashes. The expanded compiler and runner directories
are ignored and may be deleted at any time; materialization recreates them
exactly without downloading a toolchain.

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

The disposable runner's managed Webcil assemblies are delivered in three
deterministic, balanced packs. The .NET native runtime remains a standalone
Wasm asset so browsers can compile it normally. A trusted boot-resource loader
checks the manifest-to-pack SHA-256 binding, pack size, index bounds, complete
assembly coverage, and per-entry metadata before returning assembly byte
slices to .NET. It releases a pack buffer after .NET consumes its final member.
This changes immutable runtime delivery only: learner filesystem, process,
network, Mux, TraceKernel, trace state, and user authority remain scoped to the
disposable runner exactly as before.

Deploy each tree beneath a content-addressed or release-versioned URL and serve
it with `Cache-Control: public, max-age=31536000, immutable`. Do not apply an
immutable policy to a URL whose bytes can be overwritten. A consumer-owned
browser runtime manifest should declare
`delivery: { mutability: 'immutable', address: 'content' | 'versioned' }` for
the role assets so successful preflights can be reused.

`pnpm test:csharp-role-assets` fails if the runner contains compiler
assemblies, the general Host, compiler VFS files, omits any rooted Minimal
Judge reference, ships loose managed assemblies or an invalid pack, or exceeds
its raw/Brotli size ceilings. Review
`THIRD_PARTY_NOTICES.md` before redistributing the root package.
