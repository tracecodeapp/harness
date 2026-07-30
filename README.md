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

Judge owns evaluation. A `BrowserJudgeHost` manages browser assets, warm
runtime capacity, and provider teardown. Each scoped Judge owns its
TraceKernel session, case processes, comparison policy, and prepared program.

```ts
import * as Effect from 'effect/Effect';
import {
  createBrowserJudgeHost,
  type JudgeEvaluationPlan,
} from '@tracecode/harness/judge';

const source = String.raw`
def solve(nums):
    return sum(nums)
`;

const plan: JudgeEvaluationPlan<
  { readonly nums: readonly number[] },
  number
> = {
  id: 'sum-example',
  runtime: 'python',
  workspace: {
    cwd: '/workspace',
    files: [{
      path: '/workspace/solution.py',
      contents: source,
      visibility: 'submission',
    }],
  },
  driver: { files: [] },
  run: {
    command: 'judge-case',
    timeoutMs: 1_000,
  },
  cases: [{
    id: 'small-list',
    input: { nums: [1, 2, 3] },
    expected: 6,
  }],
  isolation: {
    mode: 'fresh-session-per-case',
  },
};

const host = createBrowserJudgeHost({
  assetBaseUrl: '/workers',
  providers: ['python'],
});

try {
  await host.preflightLanguage('python');
  await host.warmLanguage('python');

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const judge = yield* host.createJudge({
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

  console.log(result.cases[0]?.verdict);
} finally {
  host.dispose();
}
```

Set `trace: true` and optional `traceOptions` on the Judge binding for traced
evaluation. Expected values, comparators, verdicts, scoring, and isolation stay
in Judge rather than leaking into language runtimes.

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

Browser consumers may use versioned runtime manifests or override individual
asset URLs. For untrusted execution, route workers through a dedicated,
credential-free execution origin. See
[Browser execution host](./docs/browser-execution-host.md) and
[Isolation boundaries](./docs/isolation-boundaries.md).

Java uses TraceJVM. Publish its engine module, WebAssembly binary, and runtime
profile as one immutable directory:

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
- [TraceKernel workspaces](./docs/tracekernel-workspaces.md)
- [TraceKernel HTTP simulation](./docs/tracekernel-http.md)
- [Isolation boundaries](./docs/isolation-boundaries.md)
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
