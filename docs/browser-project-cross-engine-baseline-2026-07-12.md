# Browser project cross-engine baseline — 2026-07-12

This checkpoint used the public `createBrowserWorkspace()` API, five
fresh BrowserContexts per provider/engine cell, immutable local asset delivery,
the consumer-owned CheerpJ 4.2 manifest fixture, and a dedicated Java execution
origin. Runtime downloads belong to the first-command environment; the second
fresh command is the command-ready comparison.

| Engine | Provider | First command p50 | Second command p50 |
|---|---|---:|---:|
| Chromium | Python | 2,038 ms | 1,414 ms |
| Chromium | JavaScript | 24 ms | 15 ms |
| Chromium | TypeScript | 197 ms | 41 ms |
| Chromium | Java | 9,624 ms | 882 ms |
| Chromium | C# | 3,672 ms | 3,594 ms |
| Chromium | C++ | 2,075 ms | 2,006 ms |
| Firefox | Python | 8,041 ms | 7,615 ms |
| Firefox | JavaScript | 34 ms | 27 ms |
| Firefox | TypeScript | 400 ms | 81 ms |
| Firefox | Java | 10,528 ms | 1,953 ms |
| Firefox | C# | 13,413 ms | 13,435 ms |
| Firefox | C++ | 7,648 ms | 6,952 ms |
| WebKit | Python | 1,967 ms | 1,774 ms |
| WebKit | JavaScript | 40 ms | 19 ms |
| WebKit | TypeScript | 298 ms | 50 ms |
| WebKit | Java | 7,386 ms | 868 ms |
| WebKit | C# | 3,636 ms | 4,492 ms |
| WebKit | C++ | 2,693 ms | 2,690 ms |

All 18 cells also passed filesystem persistence, hidden/readonly policy,
TraceKernel HTTP, stdin/stdout/stderr, cancellation, and idempotent disposal.
Firefox's slower WASM-heavy providers are therefore performance differences,
not missing capabilities. Do not combine these engine distributions into one
provider average.

An additional isolated WebKit/C++ five-context soak also passed every phase:
first command 2,824 ms p50, second fresh command 2,584 ms p50, and active
runtime cancellation 53 ms p50. Together with the baseline this is 10/10
current fresh-context samples. Readiness remains `degraded`, rather than being
promoted to `ready`, because an earlier hosted run observed an internal WebKit
null-reference while entering compiled C++ WebAssembly. The nightly matrix
continues to run five samples and intentionally has no retry masking; promotion
should follow repeated clean CI history, not one local soak.

The machine-readable p50 baseline and tolerances live in
`tests/fixtures/browser-project-performance-baseline.json`. Raw reports are
intentionally ignored and are retained as CI artifacts by the nightly workflow.
