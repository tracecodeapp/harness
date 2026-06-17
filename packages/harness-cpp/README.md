# `@tracecode/harness-cpp`

C++ runtime client and browser worker assets for TraceCode Harness.

Install this package only when your application needs the C++ lane. It contains
the C++ worker, TraceCode runtime header, and YoWASP/LLVM compiler assets.

Import path:

```ts
import { CppWorkerClient, createCppRuntimeClient } from '@tracecode/harness-cpp';
```

The umbrella package also exposes the same public surface at
`@tracecode/harness/cpp` for backwards-compatible all-in-one installs.

Runtime assets are published under `workers/`. Review `THIRD_PARTY_NOTICES.md`
before redistributing this package, especially the YoWASP, LLVM, and WASI libc
sections.
