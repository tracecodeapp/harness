# TraceCode Harness

Browser-native execution for Python, JavaScript, TypeScript, Java, C#, and C++.

The package has two public code entrypoints:

- `@tracecode/harness/tracekernel` for interactive workspaces
- `@tracecode/harness/judge` for isolated evaluation

That is the entire public architecture. Runtime workers, provider registries,
language adapters, and browser transport are private implementation details.

Project site: [tracecode.app](https://tracecode.app)

## Install

```bash
pnpm add @tracecode/harness effect
```

For Next.js, transpile the package:

```ts
transpilePackages: ['@tracecode/harness']
```

Copy the browser assets into the application's public directory:

```bash
pnpm exec tracecode-harness sync-assets public/workers
```

Version 0.16 installs exact TraceJVM and TraceCC dependencies and copies their
owned runtime releases into that asset tree. The application does not install,
version, publish, or configure those engines independently. Keep the copied
tree intact and serve `.wasm` files as `application/wasm`.

Limit the copied assets when an application uses only some languages:

```bash
pnpm exec tracecode-harness sync-assets public/workers \
  --languages python,javascript
```

## TraceKernel

TraceKernel owns interactive execution. Its public surface includes the kernel,
workspace and terminal contracts, browser persistence, execution-host
plumbing, runtime capability information, and the browser workspace factory.

```ts
import {
  createBrowserWorkspace,
} from '@tracecode/harness/tracekernel';

const workspace = await createBrowserWorkspace({
  assetBaseUrl: '/workers',
  providers: ['javascript'],
  files: [
    {
      path: 'package.json',
      contents: JSON.stringify({
        scripts: { start: 'node src/index.js' },
      }),
    },
    {
      path: 'src/index.js',
      contents: 'console.log("hello from TraceKernel")\n',
    },
  ],
});

try {
  const result = await workspace.runCommand('npm start');
  console.log(result.stdout);
} finally {
  await workspace.destroy();
}
```

Use `workspace.createTerminalSession(...)` for an interactive terminal UI.
The same workspace can expose files, processes, HTTP endpoints, storage, and
multiple language runtimes without the application assembling those systems
itself.

## Judge

Judge owns evaluation. Products lower their problem or project definition into
a versioned, serializable bundle. A `BrowserJudgeHost` executes that bundle
through TraceKernel and returns a receipt containing raw process observations,
comparison results, policy evaluation, and the final technical verdict.

Expected values, comparator strategies, semantic facts, scoring rules, and
pass/fail policy stay in Judge. Language runtimes receive only source and case
input. The same bundle crosses unchanged into a browser mux slot, so local and
remote evaluation do not maintain separate correctness implementations.

```ts
import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '@tracecode/harness/judge';

const code = String.raw`
def solve(nums):
    return sum(nums)
`;

const bundle = await createAlgorithmJudgeBundle({
  id: 'sum-attempt',
  language: 'python',
  code,
  functionName: 'solve',
  cases: [{
    id: 'small-list',
    input: { nums: [1, 2, 3] },
    expected: 6,
  }],
  limits: { wallClockMs: 1_000 },
});

const host = createBrowserJudgeHost({
  assetBaseUrl: '/workers',
  providers: ['python'],
});

try {
  await host.warmLanguage('python');

  const receipt = await host.evaluateAlgorithm({ bundle });
  console.log(receipt.verdict);
} finally {
  host.dispose();
}
```

Set `trace: true` and optional `traceOptions` on the bundle for traced
evaluation. A `JudgeVerdictPolicy` can combine case outcomes with
workspace-bound facts such as semantic complexity:

```text
passWhen all cases pass AND runtime complexity is at most logarithmic
```

Facts identify their producer, version, verification tier, and exact workspace
digest. Missing, stale, or insufficiently trusted facts produce an
`indeterminate` verdict rather than silently passing.

Project Judge uses the same model at workspace scale. A project definition has
its own schema, id, and revision; each evaluator pattern has an independent
kind and version. The definition declares command and service-probe steps,
private artifacts, evaluator references, and `passWhen`. The resulting receipt
contains changed files, isolated process results, attributed observations,
claims, policy trace, score, and verdict.

## Browser and mux ownership

One browser Judge slot is the canonical execution authority. It owns a
TraceKernel-backed Judge host and can evaluate both algorithm and project
bundles. Mux is that browser slot multiplied by N:

```text
product bundle
  -> browser Judge slot
  -> Judge receipt

mux = browser Judge slot × N
    + queueing
    + capacity
    + slot replacement
```

Mux does not reimplement comparison or project grading. A product Worker signs
the exact request sent to mux and verifies a signature over the exact status
and response body before persisting a receipt.

## Public surface

The package export map contains exactly:

- `@tracecode/harness/tracekernel`
- `@tracecode/harness/judge`
- `@tracecode/harness/package.json`

There is intentionally no package-root code export and no public `/browser`,
`/project`, `/project-node`, `/core`, `/native`, `/python`, `/javascript`,
`/java`, `/csharp`, `/cpp`, `/sql`, or `/internal/*` entrypoint.

The repository still uses private workspaces to keep implementation ownership
clear:

- `tracekernel` owns processes, resources, syscalls, networking, filesystems,
  terminals, and interactive workspaces.
- `judge` owns evaluation plans, comparisons, verdicts, and isolated case
  lifecycle.
- `runtime-browser` owns browser assets, worker transport, environment
  detection, and runtime provider assembly.
- `runtime-*` packages own the implementation of each language.
- `runtime-contracts` owns contracts shared by those private packages.

Those names are not application architecture. Consumers choose TraceKernel or
Judge.

## Runtime assets

`assetBaseUrl` locates one Harness-owned release tree. It defaults to
`/workers`, matching the output of `sync-assets`. Changing it moves the whole
tree—for example to a credential-free static origin—but does not make the
application responsible for TraceJVM, TraceCC, Pyodide, or .NET versions.
Those dependency identities and every file digest are generated into
`runtime-assets.lock.json` by the Harness release.

`warmLanguage(language)` is the readiness boundary. It verifies required
browser features and immutable runtime assets, then initializes the provider;
the first execution performs the same check if warmup was skipped. A missing,
stale, or mixed runtime therefore fails before learner compilation.
`preflightLanguage` remains useful for diagnostics, but applications do not
need to orchestrate it.

Advanced deployments may provide runtime manifests or per-language base
overrides, but those locations must serve the exact release pinned by the
installed Harness. For untrusted execution, route workers through a dedicated,
credential-free execution origin. See
[Browser execution host](./docs/browser-execution-host.md) and
[Isolation boundaries](./docs/isolation-boundaries.md).

The same generated release metadata is available to client interfaces without
making the application parse notices or know engine paths:

```ts
import {
  getLanguageRuntimeOpenSourceInfo,
} from '@tracecode/harness/tracekernel';

const openSource = getLanguageRuntimeOpenSourceInfo('python', {
  assetBaseUrl: '/workers',
});
```

Each component includes its resolved version, SPDX license expression, and
UI-ready links to license text, notices, source, modifications, or
corresponding source when applicable. Package-owned links follow
`assetBaseUrl`, so a custom asset origin requires no client-side TraceJVM,
TraceCC, or Pyodide routing. The compact component list is intended for a
collapsed runtime-information section; full transitive notices remain in the
versioned engine release.

The default Python Judge deployment is self-contained under `/workers` after
`sync-assets`. A short-lived bootstrap Worker fetches and compiles the immutable
CPython startup image, then transfers it to provider scope without performing
runtime-image work on the page thread. The provider leases one clean Worker to
a submission for preparation plus its case batch, and then terminates that
Worker. A custom Python runtime manifest must include an engine-matched
`runtimeImage`; missing or cross-engine images fail closed.
Project Python processes continue to use the general TraceKernel process path
because their modules, filesystem, stdin, servers, and lifetime are
user-controlled.

Java uses the TraceJVM release pinned by the Harness. `sync-assets` installs
its executable engine module, WebAssembly binary, and runtime profiles under
`/workers`; the generated open-source metadata links the matching license,
notices, modifications, and corresponding source. An advanced deployment can
move that exact executable release to another immutable origin:

```ts
const workspace = await createBrowserWorkspace({
  providers: ['java'],
  assetBaseUrl: '/workers',
  java: {
    runtimeAssetBaseUrl: 'https://assets.example.com/java/2026-07-30/',
  },
});
```

The configured directory contains:

```text
browser-client.js
bjvm_main.wasm
profiles/core/...
```

Do not mix files from different runtime releases.

## Documentation

- [Harness execution contract](./docs/harness-execution-contract.md)
- [Judge architecture](./packages/judge/ARCHITECTURE.md)
- [TraceKernel workspaces](./docs/tracekernel-workspaces.md)
- [TraceKernel HTTP simulation](./docs/tracekernel-http.md)
- [Isolation boundaries](./docs/isolation-boundaries.md)
- [Warm-and-Retire worker lifecycle policy](./docs/warm-and-retire-policy.md)
- [Browser execution host](./docs/browser-execution-host.md)

## Development

```bash
pnpm install
pnpm test
```

The full gate schedules independent runtime families concurrently while
keeping build-dependent and timing-sensitive work behind explicit boundaries.
Set `TRACECODE_TEST_JOBS=<n>` to lower local concurrency.

Useful focused commands:

```bash
pnpm typecheck
pnpm test:packaged-surface
pnpm test:tracekernel
pnpm test:judge
```
