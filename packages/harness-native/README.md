# `@tracecode/harness-native`

Native Node runtime clients and project runners for TraceCode harness.

This package is an opt-in throughput surface. It runs TraceCode's code and
trace APIs against host-native tools such as `python3` and a Node VM-backed
JavaScript/TypeScript worker. It is useful for local development, CI,
regression mining, and high-volume batch inference where browser startup and
WebAssembly runtime costs are too high.

Native harness is not a sandbox. It must not be used as the isolation boundary
for arbitrary untrusted code. Browser runtimes remain the default choice for
normal product usage; native mode trades isolation for speed and host-tool
access.

```ts
import { createNativeHarness } from '@tracecode/harness-native';

const harness = createNativeHarness({ pythonCommand: 'python3' });
const client = harness.getClient('python');

const result = await client.execute({
  kind: 'code',
  code: 'def solve(nums):\n    return sum(nums)\n',
  functionName: 'solve',
  cases: [
    { id: 'small', inputs: { nums: [1, 2, 3] }, expected: 6 },
  ],
});
```

For high-volume trusted batch inference, use the native queue. Each worker owns
its own runtime clients, and jobs can mix supported code-client languages.

```ts
const results = await harness.runJobs(
  [
    {
      id: 'case-js',
      language: 'javascript',
      request: {
        kind: 'code',
        code: 'function solve(x) { return x + 1; }',
        functionName: 'solve',
        cases: [{ inputs: { x: 41 }, expected: 42 }],
      },
    },
    {
      id: 'case-py',
      language: 'python',
      request: {
        kind: 'code',
        code: 'def solve(x):\n    return x + 1\n',
        functionName: 'solve',
        cases: [{ inputs: { x: 41 }, expected: 42 }],
      },
    },
  ],
  { workers: 8 }
);
```

For very large corpora, prefer the streaming form so results can be written as
they finish and the producer is backpressured by the worker pool:

```ts
await harness.runJobsEach(solutionJobs, async (result) => {
  await writeResult(result);
}, { workers: 8 });
```

For best throughput, make each job one solution with many `cases`; avoid one job
per individual test case. Native Python batches run in one Python process per
job, Java caches its tiny host launcher, and Java/C#/C++ compile once per
solution job where their native driver supports it. C++ compile-once batching is
used for `function`, `solution-method`, and `ops-class` requests; C++ `script`
requests keep the compatibility path.

`python`, `javascript`, `typescript`, `java`, `csharp`, and `cpp` support the
native code-client API and queue scheduling. Native event tracing is available
for Python, JavaScript, TypeScript, and C++; Java and C# native code clients run
and batch through host toolchains, but host-side trace instrumentation is still
reported as unsupported by `getNativeLanguageSupport()`.

For shell-style multi-file execution, use `createNativeProjectWorkspace` from
this package or `@tracecode/harness/project-node`.
