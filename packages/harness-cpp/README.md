# `@tracecode/harness-cpp`

C++ runtime client and browser worker assets for TraceCode Harness.

Install this package only when your application needs the C++ lane. It contains
the C++ worker, TraceCode runtime header, and browser compiler assets.

Import path:

```ts
import { CppWorkerClient, createCppRuntimeClient } from '@tracecode/harness-cpp';
```

The umbrella package also exposes the same public surface at
`@tracecode/harness/cpp` for backwards-compatible all-in-one installs.

Runtime assets are published under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing this package.

In a TraceKernel project workspace, compiled programs use synchronous
WASI-to-kernel syscalls for filesystem descriptors and local TCP sockets.
Compilation still consumes an immutable project snapshot; execution opens the
authoritative workspace namespace, so concurrent processes observe committed
file mutations without replaying worker-local diffs. Standalone clients without
a kernel syscall channel retain the snapshot filesystem and structured HTTP
compatibility path.
