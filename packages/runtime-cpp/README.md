# `@tracecode/runtime-cpp`

C++ runtime client and browser worker assets for TraceCode Harness.

This is a private workspace bundled into the published root package. Import the
supported `@tracecode/harness/cpp` subpath when an application needs the C++
lane. It contains the C++ worker, TraceCode runtime header, and browser compiler
assets.

Import path:

```ts
import { CppWorkerClient, createCppRuntimeClient } from '@tracecode/harness/cpp';
```

Runtime assets are shipped under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing the root package.

In a TraceKernel project workspace, compiled programs use synchronous
WASI-to-kernel syscalls for filesystem descriptors and local TCP sockets.
Compilation still consumes an immutable project snapshot; execution opens the
authoritative workspace namespace, so concurrent processes observe committed
file mutations without replaying worker-local diffs. Standalone clients without
a kernel syscall channel retain the snapshot filesystem and structured HTTP
compatibility path.
