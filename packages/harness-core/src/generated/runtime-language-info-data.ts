/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Sources: runtime worker constants, package manifests, vendored runtime metadata.
 * Generator: scripts/generate-runtime-language-info.ts
 */

import type { Language } from '../runtime-types';
import type { LanguageRuntimeInfo } from '../runtime-language-info';

export const LANGUAGE_RUNTIME_INFOS = Object.freeze(
  Object.assign(Object.create(null), {
  "python": {
    "language": "python",
    "displayName": "Python",
    "versionLabel": "Python 3.13.2",
    "description": "Python 3.13.2.\n\nCommon algorithm helpers are imported automatically, including array, bisect, collections, functools, heapq, itertools. Other standard-library modules can be imported normally.\n\nOptional third-party packages are consumer-owned runtime assets and are available only when declared by the browser runtime manifest.",
    "runtime": {
      "name": "Python",
      "version": "3.13.2",
      "detail": "Runs in an isolated browser runtime."
    },
    "defaultImports": [
      "array",
      "bisect",
      "collections",
      "functools",
      "heapq",
      "itertools",
      "operator",
      "re",
      "string",
      "typing"
    ]
  },
  "javascript": {
    "language": "javascript",
    "displayName": "JavaScript",
    "versionLabel": "JavaScript (ECMAScript 2023)",
    "runtime": {
      "name": "Browser Worker JavaScript runtime",
      "detail": "Runs in the host browser worker; Node.js is not required for browser execution."
    },
    "libraries": [
      {
        "name": "lodash",
        "version": "4.17.21",
        "importName": "lodash",
        "globalName": "_"
      },
      {
        "name": "@datastructures-js/binary-search-tree",
        "version": "5.4.0",
        "importName": "@datastructures-js/binary-search-tree"
      },
      {
        "name": "@datastructures-js/deque",
        "version": "1.0.8",
        "importName": "@datastructures-js/deque"
      },
      {
        "name": "@datastructures-js/graph",
        "version": "5.3.1",
        "importName": "@datastructures-js/graph"
      },
      {
        "name": "@datastructures-js/heap",
        "version": "4.3.7",
        "importName": "@datastructures-js/heap"
      },
      {
        "name": "@datastructures-js/linked-list",
        "version": "6.1.4",
        "importName": "@datastructures-js/linked-list"
      },
      {
        "name": "@datastructures-js/priority-queue",
        "version": "6.3.5",
        "importName": "@datastructures-js/priority-queue"
      },
      {
        "name": "@datastructures-js/queue",
        "version": "4.3.0",
        "importName": "@datastructures-js/queue"
      },
      {
        "name": "@datastructures-js/set",
        "version": "4.2.2",
        "importName": "@datastructures-js/set"
      },
      {
        "name": "@datastructures-js/stack",
        "version": "3.1.6",
        "importName": "@datastructures-js/stack"
      },
      {
        "name": "@datastructures-js/trie",
        "version": "4.2.3",
        "importName": "@datastructures-js/trie"
      }
    ],
    "standard": "ECMAScript 2023-compatible syntax in the browser worker lane.",
    "description": "JavaScript runs in an isolated browser Web Worker with ECMAScript 2023-compatible syntax.\n\nLodash 4.17.21 is available as both lodash and _.\n\nThe @datastructures-js packages are bundled for common algorithm data structures. Queue, Stack, Deque, Heap, PriorityQueue, MinPriorityQueue, and MaxPriorityQueue are available globally.\n\nBundled @datastructures-js versions:\n\n\"@datastructures-js/binary-search-tree\": \"5.4.0\"\n\"@datastructures-js/deque\": \"1.0.8\"\n\"@datastructures-js/graph\": \"5.3.1\"\n\"@datastructures-js/heap\": \"4.3.7\"\n\"@datastructures-js/linked-list\": \"6.1.4\"\n\"@datastructures-js/priority-queue\": \"6.3.5\"\n\"@datastructures-js/queue\": \"4.3.0\"\n\"@datastructures-js/set\": \"4.2.2\"\n\"@datastructures-js/stack\": \"3.1.6\"\n\"@datastructures-js/trie\": \"4.2.3\"\n\nBinary Search Tree, Trie, and Graph are bundled too, but are not exposed globally because those names can collide with problem definitions. Import or require the matching package when you need one."
  },
  "typescript": {
    "language": "typescript",
    "displayName": "TypeScript",
    "versionLabel": "TypeScript 5.9.3",
    "description": "TypeScript 5.9.3 is compiled in the browser and then executed on the JavaScript worker runtime.\n\nCompiler options: --target ES2020 --module None --strict false --esModuleInterop\n\nLodash 4.17.21 is available as both lodash and _.\n\nThe @datastructures-js packages are bundled for common algorithm data structures. Queue, Stack, Deque, Heap, PriorityQueue, MinPriorityQueue, and MaxPriorityQueue are available globally.\n\nBundled @datastructures-js versions:\n\n\"@datastructures-js/binary-search-tree\": \"5.4.0\"\n\"@datastructures-js/deque\": \"1.0.8\"\n\"@datastructures-js/graph\": \"5.3.1\"\n\"@datastructures-js/heap\": \"4.3.7\"\n\"@datastructures-js/linked-list\": \"6.1.4\"\n\"@datastructures-js/priority-queue\": \"6.3.5\"\n\"@datastructures-js/queue\": \"4.3.0\"\n\"@datastructures-js/set\": \"4.2.2\"\n\"@datastructures-js/stack\": \"3.1.6\"\n\"@datastructures-js/trie\": \"4.2.3\"\n\nBinary Search Tree, Trie, and Graph are bundled too, but are not exposed globally because those names can collide with problem definitions. Import or require the matching package when you need one.\n\nThe compiled output runs on the same browser worker execution lane as JavaScript submissions.",
    "runtime": {
      "name": "Browser Worker JavaScript runtime",
      "detail": "TypeScript is compiled before execution and runs on the JavaScript worker lane."
    },
    "compiler": {
      "name": "TypeScript",
      "version": "5.9.3"
    },
    "standard": "Transpiles to JavaScript for the browser worker lane.",
    "libraries": [
      {
        "name": "lodash",
        "version": "4.17.21",
        "importName": "lodash",
        "globalName": "_"
      },
      {
        "name": "@datastructures-js/binary-search-tree",
        "version": "5.4.0",
        "importName": "@datastructures-js/binary-search-tree"
      },
      {
        "name": "@datastructures-js/deque",
        "version": "1.0.8",
        "importName": "@datastructures-js/deque"
      },
      {
        "name": "@datastructures-js/graph",
        "version": "5.3.1",
        "importName": "@datastructures-js/graph"
      },
      {
        "name": "@datastructures-js/heap",
        "version": "4.3.7",
        "importName": "@datastructures-js/heap"
      },
      {
        "name": "@datastructures-js/linked-list",
        "version": "6.1.4",
        "importName": "@datastructures-js/linked-list"
      },
      {
        "name": "@datastructures-js/priority-queue",
        "version": "6.3.5",
        "importName": "@datastructures-js/priority-queue"
      },
      {
        "name": "@datastructures-js/queue",
        "version": "4.3.0",
        "importName": "@datastructures-js/queue"
      },
      {
        "name": "@datastructures-js/set",
        "version": "4.2.2",
        "importName": "@datastructures-js/set"
      },
      {
        "name": "@datastructures-js/stack",
        "version": "3.1.6",
        "importName": "@datastructures-js/stack"
      },
      {
        "name": "@datastructures-js/trie",
        "version": "4.2.3",
        "importName": "@datastructures-js/trie"
      }
    ]
  },
  "java": {
    "language": "java",
    "displayName": "Java",
    "versionLabel": "Java 23",
    "description": "Java 23 is compiled with javac 23 and executed through the consumer-configured browser Java provider.\n\nCommon imports are added automatically: java.util.*, java.io.*, java.math.*, java.util.stream.*, javafx.util.Pair.",
    "runtime": {
      "name": "Browser Java runtime",
      "version": "23",
      "detail": "Runs through the consumer-configured Java project provider."
    },
    "compiler": {
      "name": "javac",
      "version": "23"
    },
    "defaultImports": [
      "java.util.*",
      "java.io.*",
      "java.math.*",
      "java.util.stream.*",
      "javafx.util.Pair"
    ],
    "libraries": [
      {
        "name": "JavaParser",
        "version": "3.25.10",
        "detail": "Used internally for Java source rewriting."
      },
      {
        "name": "javafx.util.Pair",
        "detail": "Small compatibility Pair class bundled with the Java helper jar."
      }
    ]
  },
  "csharp": {
    "language": "csharp",
    "displayName": "C#",
    "versionLabel": "C# 14 (.NET 10.0.10)",
    "description": "C# 14 with .NET 10.0.10 runtime.\n\nCode is compiled with Microsoft.CodeAnalysis.CSharp 5.3.0 and executed by a browser-local .NET WebAssembly runtime.\n\nCommon namespaces are imported automatically: System, System.Collections, System.Collections.Generic, System.IO, System.Linq, System.Numerics, System.Text, System.Text.RegularExpressions.",
    "runtime": {
      "name": ".NET WebAssembly runtime",
      "version": "10.0.10",
      "detail": "Browser-local .NET runtime targeting net10.0."
    },
    "compiler": {
      "name": "Microsoft.CodeAnalysis.CSharp",
      "version": "5.3.0"
    },
    "standard": "C# 14",
    "defaultImports": [
      "System",
      "System.Collections",
      "System.Collections.Generic",
      "System.IO",
      "System.Linq",
      "System.Numerics",
      "System.Text",
      "System.Text.RegularExpressions"
    ]
  },
  "cpp": {
    "language": "cpp",
    "displayName": "C++",
    "versionLabel": "C++23 (YoWASP Clang 22)",
    "description": "C++ is compiled with YoWASP Clang/LLD 22.0.0-git20542-10 using the C++23 standard.\n\nSubmissions compile to WebAssembly and run in a browser-local WASI-style execution lane. The harness currently compiles with -O0 and -fno-exceptions, with a fixed program stack size.\n\nCommon standard library headers are included automatically, including <algorithm>, <array>, <bitset>, <climits>, <cmath>, <cstdint>, <functional>, <limits>, <numeric>, <sstream>, <tuple>, <vector>, <unordered_map>, <unordered_set> and more.",
    "runtime": {
      "name": "WASI/WebAssembly execution lane",
      "detail": "Compiled and executed in a browser-local WASI-style worker lane."
    },
    "compiler": {
      "name": "YoWASP Clang/LLD",
      "version": "22.0.0-git20542-10"
    },
    "standard": "C++23",
    "defaultImports": [
      "<algorithm>",
      "<array>",
      "<bitset>",
      "<climits>",
      "<cmath>",
      "<cstdint>",
      "<functional>",
      "<limits>",
      "<numeric>",
      "<sstream>",
      "<tuple>",
      "<vector>",
      "<unordered_map>",
      "<unordered_set>",
      "<map>",
      "<set>",
      "<deque>",
      "<queue>",
      "<stack>",
      "<utility>",
      "<string>",
      "<span>",
      "<ranges>",
      "<concepts>",
      "<any>",
      "<bit>",
      "<cctype>",
      "<cerrno>",
      "<cfloat>",
      "<charconv>",
      "<chrono>",
      "<cinttypes>",
      "<compare>",
      "<complex>",
      "<cstddef>",
      "<cstdio>",
      "<cstdlib>",
      "<cstring>",
      "<exception>",
      "<expected>",
      "<forward_list>",
      "<initializer_list>",
      "<iomanip>",
      "<ios>",
      "<iostream>",
      "<iterator>",
      "<list>",
      "<memory>",
      "<numbers>",
      "<optional>",
      "<random>",
      "<ratio>",
      "<regex>",
      "<stdexcept>",
      "<string_view>",
      "<type_traits>",
      "<typeindex>",
      "<typeinfo>",
      "<valarray>",
      "<variant>",
      "<version>"
    ],
    "libraries": [
      {
        "name": "C++ standard library and WASI libc",
        "detail": "Provided by the YoWASP Clang toolchain bundle."
      }
    ]
  }
})
) as Record<Language, LanguageRuntimeInfo>;
