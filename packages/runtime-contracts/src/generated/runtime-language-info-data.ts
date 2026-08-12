/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Sources: runtime worker constants, package manifests, vendored runtime metadata.
 * Generator: scripts/generate-runtime-language-info.ts
 */

import type { Language } from '../runtime-types';
import type { LanguageRuntimeInfo } from '../runtime-language-info';
import type { RuntimeCommandName } from '../runtime-command-info';

export const LANGUAGE_RUNTIME_INFOS = Object.freeze(
  Object.assign(Object.create(null), {
  "python": {
    "language": "python",
    "displayName": "Python",
    "versionLabel": "Python 3.13.2",
    "executionPlatform": {
      "name": "TraceKernel",
      "version": "0.16.5"
    },
    "description": "Python 3.13.2 runs in TraceKernel's isolated Python runtime.\n\nCommon algorithm helpers are imported automatically, including array, bisect, collections, functools, heapq, itertools. Other standard-library modules can be imported normally.\n\nOptional third-party packages are consumer-owned runtime assets and are available only when declared by the TraceKernel runtime manifest.",
    "runtime": {
      "name": "Python",
      "version": "3.13.2",
      "detail": "Runs in TraceKernel's isolated Python runtime."
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
    "executionPlatform": {
      "name": "TraceKernel",
      "version": "0.16.5"
    },
    "runtime": {
      "name": "TraceKernel JavaScript runtime",
      "detail": "Runs in an isolated TraceKernel worker; Node.js is not required for execution."
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
    "standard": "ECMAScript 2023-compatible syntax in TraceKernel's JavaScript runtime.",
    "description": "JavaScript runs in TraceKernel's isolated JavaScript runtime with ECMAScript 2023-compatible syntax.\n\nLodash 4.17.21 is available as both lodash and _.\n\nThe @datastructures-js packages are bundled for common algorithm data structures. Queue, Stack, Deque, Heap, PriorityQueue, MinPriorityQueue, and MaxPriorityQueue are available globally.\n\nBundled @datastructures-js versions:\n\n\"@datastructures-js/binary-search-tree\": \"5.4.0\"\n\"@datastructures-js/deque\": \"1.0.8\"\n\"@datastructures-js/graph\": \"5.3.1\"\n\"@datastructures-js/heap\": \"4.3.7\"\n\"@datastructures-js/linked-list\": \"6.1.4\"\n\"@datastructures-js/priority-queue\": \"6.3.5\"\n\"@datastructures-js/queue\": \"4.3.0\"\n\"@datastructures-js/set\": \"4.2.2\"\n\"@datastructures-js/stack\": \"3.1.6\"\n\"@datastructures-js/trie\": \"4.2.3\"\n\nBinary Search Tree, Trie, and Graph are bundled too, but are not exposed globally because those names can collide with problem definitions. Import or require the matching package when you need one."
  },
  "typescript": {
    "language": "typescript",
    "displayName": "TypeScript",
    "versionLabel": "TypeScript 5.9.3",
    "executionPlatform": {
      "name": "TraceKernel",
      "version": "0.16.5"
    },
    "description": "TypeScript 5.9.3 is compiled with the TypeScript compiler and executed by TraceKernel's JavaScript runtime.\n\nCompiler options: --target ES2020 --module None --strict false --esModuleInterop\n\nLodash 4.17.21 is available as both lodash and _.\n\nThe @datastructures-js packages are bundled for common algorithm data structures. Queue, Stack, Deque, Heap, PriorityQueue, MinPriorityQueue, and MaxPriorityQueue are available globally.\n\nBundled @datastructures-js versions:\n\n\"@datastructures-js/binary-search-tree\": \"5.4.0\"\n\"@datastructures-js/deque\": \"1.0.8\"\n\"@datastructures-js/graph\": \"5.3.1\"\n\"@datastructures-js/heap\": \"4.3.7\"\n\"@datastructures-js/linked-list\": \"6.1.4\"\n\"@datastructures-js/priority-queue\": \"6.3.5\"\n\"@datastructures-js/queue\": \"4.3.0\"\n\"@datastructures-js/set\": \"4.2.2\"\n\"@datastructures-js/stack\": \"3.1.6\"\n\"@datastructures-js/trie\": \"4.2.3\"\n\nBinary Search Tree, Trie, and Graph are bundled too, but are not exposed globally because those names can collide with problem definitions. Import or require the matching package when you need one.\n\nThe compiled output runs on the same TraceKernel execution lane as JavaScript submissions.",
    "runtime": {
      "name": "TraceKernel JavaScript runtime",
      "detail": "TypeScript is compiled before execution and runs on TraceKernel's JavaScript runtime."
    },
    "compiler": {
      "name": "TypeScript",
      "version": "5.9.3"
    },
    "standard": "Transpiles to JavaScript for TraceKernel's JavaScript runtime.",
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
    "executionPlatform": {
      "name": "TraceKernel",
      "version": "0.16.5"
    },
    "description": "Java 23 is compiled with javac 23 and executed by the Java runtime on TraceKernel.\n\nCommon imports are added automatically: java.util.*, java.io.*, java.math.*, java.util.stream.*, javafx.util.Pair.",
    "runtime": {
      "name": "TraceKernel Java runtime",
      "version": "23",
      "detail": "Runs through the Java runtime on TraceKernel."
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
    "versionLabel": "C# 14",
    "executionPlatform": {
      "name": "TraceKernel",
      "version": "0.16.5"
    },
    "description": "C# 14 source is compiled and executed by TraceKernel's isolated C# runtime.\n\nCommon namespaces are imported automatically: System, System.Collections, System.Collections.Generic, System.IO, System.Linq, System.Numerics, System.Text, System.Text.RegularExpressions.",
    "runtime": {
      "name": "C#",
      "detail": "Runs in TraceKernel's isolated C# runtime."
    },
    "compiler": {
      "name": "C# compiler",
      "version": "C# 14"
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
    "versionLabel": "C++23",
    "executionPlatform": {
      "name": "TraceKernel",
      "version": "0.16.5"
    },
    "description": "C++ source is compiled using the C++23 standard.\n\nSubmissions compile to WebAssembly and run in TraceKernel's WASI execution lane. The compiler currently uses -O0 and -fno-exceptions, with a fixed program stack size.\n\nCommon standard library headers are included automatically, including <algorithm>, <array>, <bitset>, <climits>, <cmath>, <cstdint>, <functional>, <limits>, <numeric>, <sstream>, <tuple>, <vector>, <unordered_map>, <unordered_set> and more.",
    "runtime": {
      "name": "TraceKernel WASI runtime",
      "detail": "Compiled to WebAssembly and executed in TraceKernel's WASI runtime."
    },
    "compiler": {
      "name": "C++ compiler",
      "version": "C++23"
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
      "<version>",
      "<tracecode_socket.h>",
      "<tracecode_process.h>",
      "<tracecode_ioctl.h>"
    ],
    "libraries": [
      {
        "name": "C++ standard library and WASI libc",
        "detail": "Provided by the configured browser compiler resources."
      }
    ]
  }
})
) as Record<Language, LanguageRuntimeInfo>;

/**
 * Implementation identities for CLI shims. These stay separate from
 * provider-neutral language metadata but are generated from the shipped
 * runtime artifacts so terminal output cannot drift from the runtime.
 */
export const RUNTIME_COMMAND_VERSIONS = Object.freeze(
  Object.assign(Object.create(null), {
  "dotnet": "10.0.10",
  "clang++": "22.0.0"
})
) as Record<RuntimeCommandName, string>;
