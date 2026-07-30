# `@tracecode/runtime-native`

Native Node runtime clients and project runners for TraceCode Harness.

This is a private workspace bundled into the published root package. The
supported `@tracecode/harness/native` subpath is an opt-in throughput surface
for trusted local automation, CI, regression mining, and high-volume batch
inference. It runs host-native tools such as `python3`, Java, C#, C++, and a
Node-backed JavaScript/TypeScript worker.

Native harness is not a sandbox. Do not use it as the isolation boundary for
arbitrary untrusted code.

Import path:

```ts
import { createNativeHarness, createNativeProjectWorkspace } from '@tracecode/harness/native';
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

For shell-style multi-file execution, use `createNativeProjectWorkspace(...)`
from `@tracecode/harness/native` or `@tracecode/harness/project-node`.
