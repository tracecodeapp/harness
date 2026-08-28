# Third Party Notices

This project is licensed under AGPL-3.0-only. Its published npm package and
the browser assets copied by `tracecode-harness sync-assets` also use
third-party runtime, compiler, standard-library, and support components. This
file records which components are included directly, which are copied from
package dependencies, and which are loaded from separately deployed runtime
asset trees.

This inventory does not replace an upstream license file. When mirroring a
separate runtime distribution, preserve that distribution's license texts,
notices, source references, and package metadata alongside the assets.

## Python Runtime

### Pyodide

- Use: Python runtime loaded by `workers/python/python-worker.js`.
- Version: the Python 0.16 Judge provider ships an owned Pyodide `0.29.3`
  distribution and engine-specific clean CPython startup images. Project
  processes may use a consumer-owned runtime manifest; the module-worker
  adapter is also verified against Pyodide `314.0.2`.
- License: MPL-2.0.
- Source: https://github.com/pyodide/pyodide
- Bundled license: `workers/python/pyodide-0.29.3/LICENSE.pyodide.txt`.
- Deployment docs: https://pyodide.org/en/stable/usage/downloading-and-deploying.html
- Redistribution note: the vendored distribution contains CPython and Python
  standard-library components under their upstream licenses. The package
  preserves this notice, and deployments mirroring the assets must preserve
  the upstream package metadata and license texts too.

### CPython and Python Standard Library

- Use: Python interpreter and standard library distributed as part of Pyodide.
- License: Python Software Foundation License Agreement and historical Python
  license stack.
- Source: https://github.com/python/cpython
- Bundled license: `workers/python/pyodide-0.29.3/LICENSE.cpython.txt`.
- License summary: https://www.python.org/psf/summary/

## JavaScript and TypeScript Runtime

### TypeScript

- Use: TypeScript transpilation and diagnostics for the JavaScript/TypeScript
  worker lane.
- Vendored asset: `workers/vendor/typescript.js`.
- Version: `5.9.3` in the local workspace asset; the worker keeps CDN fallbacks
  for `5.9.2`.
- License: Apache-2.0.
- Source: https://github.com/microsoft/TypeScript
- Upstream notice: TypeScript distributes `ThirdPartyNoticeText.txt`; preserve
  that upstream notice when updating the vendored compiler asset.

### Lodash

- Use: JavaScript/TypeScript helper exposed as `_`, `lodash`, and through the
  worker-local `require("lodash")` shim.
- Vendored asset: `workers/vendor/javascript-libraries.js`.
- Version: `lodash` `4.17.21`.
- License: MIT.
- Source: https://github.com/lodash/lodash

### datastructures-js

- Use: JavaScript/TypeScript helper packages exposed through the worker-local
  `require("@datastructures-js/...")` shim.
- Vendored asset: `workers/vendor/javascript-libraries.js`.
- Versions: `@datastructures-js/binary-search-tree` `5.4.0`,
  `@datastructures-js/deque` `1.0.8`, `@datastructures-js/graph` `5.3.1`,
  `@datastructures-js/heap` `4.3.7`, `@datastructures-js/linked-list`
  `6.1.4`, `@datastructures-js/priority-queue` `6.3.5`,
  `@datastructures-js/queue` `3.1.4` and `4.3.0`,
  `@datastructures-js/set` `4.2.2`, `@datastructures-js/stack` `3.1.6`, and
  `@datastructures-js/trie` `4.2.3`.
- License: MIT.
- Source: https://github.com/datastructures-js

### SES / Endo

- Use: hardened algorithm execution for the SES compartment pool used by
  `workers/javascript/javascript-ses-algorithm-worker.js`.
- Vendored assets: `workers/javascript/javascript-ses-algorithm-worker.js`.
- License: Apache-2.0.
- Source: https://github.com/endojs/endo
- Bundled components:
  - `ses` `2.3.0`
  - `@endo/cache-map` `1.1.0`
  - `@endo/env-options` `1.1.11`
  - `@endo/immutable-arraybuffer` `2.0.0`
- Acorn is bundled as the SES worker's parser dependency.

### Acorn

- Use: JavaScript parsing and exact-source validation in the SES algorithm
  worker.
- Vendored asset: `workers/javascript/javascript-ses-algorithm-worker.js`.
- Version: `8.16.0`.
- License: MIT.
- Source: https://github.com/acornjs/acorn

## Runtime Infrastructure

### Effect

- Use: scoped runtime lifecycle, resources, queues, and process coordination in
  the browser host, Judge, TraceKernel, and generated JavaScript project worker.
- Version: `3.22.0`.
- License: MIT.
- Copyright: 2023 Effectful Technologies Inc.
- Source: https://github.com/Effect-TS/effect

### fflate

- Use: gzip, deflate, and related byte compression in the browser project
  runtime and TraceKernel browser compatibility layer.
- Version: `0.8.3`.
- License: MIT.
- Copyright: 2026 Arjun Barrett.
- Source: https://github.com/101arrowz/fflate

### just-bash

- Use: shell parsing and execution for RuntimeWorkspace and TraceKernel project
  sessions. It is bundled into the root package's project and TraceKernel
  distributions through the private TraceKernel workspace package; it is not
  copied into the generated JavaScript project worker.
- Version: `3.1.0`, with the repository's documented compatibility patch
  applied at build time.
- License: Apache-2.0.
- Copyright: 2025 Vercel Inc.
- Source: https://github.com/vercel-labs/just-bash

The just-bash browser bundle also carries code from `re2js` (MIT, copyright
2023 Alexey Vasiliev) and `ieee754` (BSD-3-Clause, copyright 2008 Fair Oaks
Labs, Inc.). Their upstream sources are
https://github.com/le0pard/re2js and
https://github.com/feross/ieee754.

## Java Runtime

### Harness Java bridge

The npm package includes these TraceCode-authored Java integration assets:

- `workers/java/java-runtime-worker.js`
- `workers/java/java-worker.js`
- `workers/java/java-source-augmentations.js`
- `workers/vendor/java-browser-helper.jar`

They are covered by the project AGPL-3.0-only license. The bridge loads a
content-addressed TraceJVM runtime release supplied by the pinned
`@tracecode/tracejvm` dependency. `tracecode-harness sync-assets` copies that
release to the configured Java runtime asset base URL.

### Separately deployed TraceJVM assets

When a host deploys the separate TraceJVM asset tree used by the bridge, the
following provenance and licenses apply:

- TraceJVM is licensed under AGPL-3.0-only. Source:
  https://github.com/tracecodeapp/tracejvm
- Pinned dependency: `@tracecode/tracejvm` `0.4.1`.
- TraceJVM contains a pinned b-jvm engine snapshot from commit
  `3fd56c74656602eb32efefca46f51f074bef6bca`, licensed under MIT,
  copyright 2025 bjvm Authors. Source:
  https://github.com/anematode/b-jvm
- The TraceJVM 0.4.1 browser compiler is built from TeaVM-javac commit
  `7e4a44cf521694a4e326e33850dd8aec165eb5c9`, licensed under Apache
  License 2.0. Source:
  https://github.com/konsoletyper/teavm-javac
- TraceJVM applies a reproducible downstream overlay to TeaVM-javac. The
  changed files and patch checksums are recorded in
  `compiler/teavm-javac/manifest.json`; the deployed runtime retains both the
  Apache 2.0 license text and a modification notice.
- TraceJVM runtime profiles are assembled from Eclipse Temurin/OpenJDK
  `23.0.2+7`, distributed under GPL-2.0 WITH
  Classpath-exception-2.0. Distribution source:
  https://github.com/adoptium/temurin23-binaries
- OpenJDK GPLv2 + Classpath Exception text:
  https://openjdk.org/legal/gplv2+ce.html
- The TraceJVM WebAssembly engine and its JavaScript glue are built with
  Emscripten `4.0.2`, licensed under MIT, copyright 2018 Emscripten
  authors. Source: https://github.com/emscripten-core/emscripten

The TraceJVM runtime manifest pins the upstream archive and checksum. A
deployed runtime asset release must retain TraceJVM's
`THIRD_PARTY_NOTICES.md`, the b-jvm MIT notice, and the Eclipse
Temurin/OpenJDK, TeaVM-javac, and Emscripten legal notices and corresponding
source references. Those requirements belong to the separately deployed
runtime asset surface, not to the Harness npm tarball described above.

## C# Runtime

### .NET Runtime for WebAssembly

- Use: browser WebAssembly runtime and base class libraries for the C# lane.
- Vendored assets: `workers/vendor/csharp/**`.
- Target: `net10.0`, `browser-wasm`.
- License: MIT, plus .NET third-party notices for bundled components.
- Source: https://github.com/dotnet/runtime
- Upstream notices: https://github.com/dotnet/runtime/tree/main/src/installer/pkg/sfx/Microsoft.NETCore.App/THIRD-PARTY-NOTICES.TXT

### Roslyn / Microsoft.CodeAnalysis.CSharp

- Use: C# parsing, compilation, and diagnostics in the C# worker.
- Version: `Microsoft.CodeAnalysis.CSharp` `5.3.0`.
- License: MIT.
- NuGet package: https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp/5.3.0
- Source: https://github.com/dotnet/roslyn

## C++ Runtime

### TraceCC

- Use: the content-addressed browser C++ compiler release and TraceCode PCH
  and runtime assets.
- Published assets: `cpp/tracecc/<consumer-hash>/` supplied by the pinned
  `@tracecode/tracecc` dependency.
- Version: `@tracecode/tracecc` `0.1.0`.
- License: AGPL-3.0-only.
- Source: https://github.com/tracecodeapp/tracecc
- Upstream notices: preserve the `THIRD_PARTY_NOTICES.md` shipped by the
  TraceCC package when mirroring its runtime release.

### LLVM / Clang / LLD

- Use: compiler and linker components inside the TraceCC release.
- TraceCC's package-owned notice identifies the YoWASP LLVM fork as the source,
  frozen at revision `97196c8eeb1d495fa43bb8af2fb26af5ef5b89fb`.
- Source: https://github.com/YoWASP/llvm-project
- License: Apache License 2.0 with LLVM Exceptions.
- TraceCC is an independent project and is not affiliated with or endorsed by
  the LLVM Project or YoWASP.

### WASI libc and Sysroot Materials

- Use: the WASI reactor and `wasm32-wasip1` sysroot inputs described by the
  TraceCC package README and included in its immutable compiler release.
- The release's package-owned `THIRD_PARTY_NOTICES.md` and legal tree remain
  authoritative for the exact sysroot notices and licenses.

## Project-Authored Runtime Helpers

The following runtime helpers are authored for this project and are covered by
the project AGPL-3.0-only license unless otherwise noted by their embedded
third-party dependencies:

- `workers/python/python-worker.js`
- `workers/python/runtime-core.js`
- `workers/python/generated-python-harness-snippets.js`
- `workers/javascript/javascript-worker.js`
- `workers/javascript/javascript-ses-algorithm-worker.js`
- `workers/javascript/javascript-project-worker.js`
- `workers/java/java-worker.js`
- `workers/java/java-runtime-worker.js`
- `workers/java/java-source-augmentations.js`
- `workers/vendor/java-browser-helper.jar`
- `workers/csharp/csharp-worker.js`
- `workers/cpp/cpp-worker.js`
- `workers/cpp/cpp-compiler-frame.html`
- `workers/cpp/cpp-compiler-worker.js`
- `workers/cpp/tracecode_runtime.hpp`
- `workers/shared/runtime-kernel-policy-classic.js`
- `workers/shared/runtime-kernel-policy.js`
