# Third Party Notices

This project is licensed under AGPL-3.0-only. The browser runtimes also use
third-party runtime, compiler, parser, and standard-library components. This
file is an attribution and redistribution inventory for those components.

It is not legal advice. Before a commercial release, verify the current upstream
license text and any use-case-specific terms against the linked upstream
sources.

## Python Runtime

### Pyodide

- Use: Python runtime loaded by `workers/python/pyodide-worker.js`.
- Version: the worker currently loads Pyodide `0.29.0` from public CDNs; the
  workspace package resolves `pyodide` `0.29.3`.
- License: MPL-2.0.
- Source: https://github.com/pyodide/pyodide
- Deployment docs: https://pyodide.org/en/stable/usage/downloading-and-deploying.html

### CPython and Python Standard Library

- Use: Python interpreter and standard library distributed as part of Pyodide.
- License: Python Software Foundation License Agreement and historical Python
  license stack.
- Source: https://github.com/python/cpython
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
  `@datastructures-js/queue` `4.3.0`, `@datastructures-js/set` `4.2.2`,
  `@datastructures-js/stack` `3.1.6`, and `@datastructures-js/trie` `4.2.3`.
- License: MIT.
- Source: https://github.com/datastructures-js

## Java Runtime

### CheerpJ Core

- Use: browser-hosted JVM runtime loaded by the Java worker.
- Runtime URL: `https://cjrtnc.leaningtech.com/4.2/loader.js`.
- Provider: Leaning Technologies.
- Terms: CheerpJ Community License or CheerpJ Commercial License depending on
  the user's use case.
- Licensing docs: https://cheerpj.com/docs/licensing
- Version/changelog docs: https://cheerpj.com/docs/changelog

CheerpJ is not vendored in this package; it is loaded from Leaning Technologies'
`cjrtnc.leaningtech.com` runtime domain. The Community License currently covers
individuals, one-person companies, FOSS projects, and technical evaluations.
Uses outside that scope can require a commercial license.

### JavaParser

- Use: Java source parsing and rewriting support.
- Vendored asset: `workers/vendor/javaparser-core-3.25.10.jar`.
- Version: `3.25.10`.
- License: dual licensed LGPL-3.0 or Apache-2.0. This project uses it under
  Apache-2.0.
- Source: https://github.com/javaparser/javaparser

### OpenJDK / JetBrains Runtime Compiler Module

- Use: Java compiler module consumed by the browser Java lane.
- Vendored asset: `workers/vendor/jdk.compiler-17.jar`.
- Local manifest: `Created-By: 17.0.14 (JetBrains s.r.o.)`.
- License: GPL-2.0-only WITH Classpath-exception-2.0.
- OpenJDK GPLv2 + Classpath Exception text: https://openjdk.org/legal/gplv2+ce.html
- JetBrains Runtime source: https://github.com/JetBrains/JetBrainsRuntime

Redistributing this asset should preserve the GPLv2 + Classpath Exception text
and provide the corresponding source location or source offer required by the
license.

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

### YoWASP Clang

- Use: browser C++ compiler bundle and LLVM resource bundle.
- Vendored/copied assets: `vendor/cpp/yowasp/bundle.js`,
  `vendor/cpp/yowasp/llvm-resources.tar`, and `vendor/cpp/yowasp/*.wasm`.
- Version: `@yowasp/clang` `22.0.0-git20542-10`.
- Local package metadata license: ISC.
- Upstream README license statement: Apache-2.0, matching the base LLVM license.
- Source: https://github.com/YoWASP/clang

The local package metadata and README identify different license labels. Until
that is clarified upstream, preserve both the package metadata notice and the
README/source license reference when redistributing these assets.

### LLVM / Clang / LLD

- Use: underlying compiler and linker components inside the YoWASP bundle.
- License: Apache-2.0 WITH LLVM-exception.
- Source: https://github.com/llvm/llvm-project
- License policy: https://llvm.org/docs/DeveloperPolicy.html#copyright-license-and-patents

### WASI libc and Sysroot Materials

- Use: libc/sysroot inputs included in the C++ compiler resources.
- License: mixed permissive licenses, including Apache-2.0 WITH LLVM-exception,
  Apache-2.0, MIT, BSD-2-Clause, and CC0-1.0.
- Source: https://github.com/WebAssembly/wasi-libc

## Project-Authored Runtime Helpers

The following runtime helpers are authored for this project and are covered by
the project AGPL-3.0-only license unless otherwise noted by their embedded
third-party dependencies:

- `workers/python/runtime-core.js`
- `workers/python/generated-python-harness-snippets.js`
- `workers/javascript/javascript-worker.js`
- `workers/java/java-worker.js`
- `workers/java/java-source-augmentations.js`
- `workers/vendor/java-browser-helper.jar`
- `workers/vendor/java-rewriter.jar`
- `workers/csharp/csharp-worker.js`
- `workers/cpp/cpp-worker.js`
- `workers/cpp/tracecode_runtime.hpp`
