# `@tracecode/runtime-native`

Native Node runtime clients and project runners for TraceCode Harness.

This is a private implementation workspace used by trusted local automation,
CI, regression mining, and high-volume batch inference. It is not published
independently, and the root package has no `/native` subpath. It runs
host-native tools such as `python3`, Java, C#, C++, and a Node-backed
JavaScript/TypeScript worker.

Native harness is not a sandbox. Do not use it as the isolation boundary for
arbitrary untrusted code.

Code inside this monorepo imports the private batch surface directly:

```ts
import {
  createNativeHarness,
  createNativeProjectWorkspace,
} from '@tracecode/runtime-native';
```

Code-client example:

```ts
const harness = createNativeHarness({ pythonCommand: 'python3' });
const client = harness.getClient('python');

await client.execute({
  kind: 'code',
  code: 'def solve(nums):\n    return sum(nums)\n',
  functionName: 'solve',
  cases: [{ id: 'small', inputs: { nums: [1, 2, 3] }, expected: 6 }],
});
```

Use `runJobs(...)` or `runJobsEach(...)` for trusted batch workloads. For best
throughput, make each job one solution with many cases instead of one job per
test case.

The native project factory remains private with this workspace. Public
applications choose the browser TraceKernel workspace or Judge rather than a
second host-native API.
