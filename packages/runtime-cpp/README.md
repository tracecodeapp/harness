# `@tracecode/runtime-cpp`

C++ runtime client and browser worker assets for TraceCode Harness.

This is a private implementation workspace used to build the root release. It
is not published independently, and the root package has no `/cpp` subpath. It
contains the C++ worker, TraceCode runtime header, and browser compiler assets.

Code inside this monorepo imports it directly:

```ts
import {
  CppWorkerClient,
  createCppRuntimeClient,
} from '@tracecode/runtime-cpp';
```

Published browser consumers select C++ through the provider-neutral runtime
host and Judge contracts. Browser project consumers use
`@tracecode/harness/tracekernel`; neither path exposes C++ runtime clients
directly.

Runtime assets are shipped under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing the root package.

In a TraceKernel project workspace, compiled programs use synchronous
WASI-to-kernel syscalls for filesystem descriptors and local TCP sockets.
Compilation still consumes an immutable project snapshot; execution opens the
authoritative workspace namespace, so concurrent processes observe committed
file mutations without replaying worker-local diffs. Standalone clients without
a kernel syscall channel retain the snapshot filesystem and structured HTTP
compatibility path.
