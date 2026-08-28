/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Sources: runtime-assets.lock.json, package manifests, vendored runtime metadata.
 * Generator: scripts/generate-runtime-open-source-info.ts
 */

import type { Language } from '../runtime-types';
import type { LanguageRuntimeOpenSourceInfo } from '../runtime-open-source-info';

export const LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS = Object.freeze(
  Object.assign(Object.create(null), {
  "python": {
    "language": "python",
    "components": [
      {
        "name": "CPython",
        "version": "3.13.2",
        "license": "PSF-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "assetPath": "python/pyodide-0.29.3/LICENSE.cpython.txt"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/python/cpython/tree/v3.13.2"
          }
        ]
      },
      {
        "name": "Pyodide",
        "version": "0.29.3",
        "license": "MPL-2.0",
        "detail": "Browser distribution and WebAssembly runtime image.",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "assetPath": "python/pyodide-0.29.3/LICENSE.pyodide.txt"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/pyodide/pyodide/tree/0.29.3"
          },
          {
            "kind": "modifications",
            "label": "Runtime modifications",
            "url": "https://github.com/tracecodeapp/harness/tree/v0.17.0/workers/python/pyodide-0.29.3"
          }
        ]
      }
    ]
  },
  "javascript": {
    "language": "javascript",
    "components": [
      {
        "name": "ses",
        "version": "2.3.0",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/ses@2.3.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/endojs/endo"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/ses/v/2.3.0"
          }
        ]
      },
      {
        "name": "acorn",
        "version": "8.16.0",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/acorn@8.16.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/acornjs/acorn"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/acorn/v/8.16.0"
          }
        ]
      },
      {
        "name": "@endo/cache-map",
        "version": "1.1.0",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@endo/cache-map@1.1.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/endojs/endo"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@endo/cache-map/v/1.1.0"
          }
        ]
      },
      {
        "name": "@endo/env-options",
        "version": "1.1.11",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@endo/env-options@1.1.11/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/endojs/endo"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@endo/env-options/v/1.1.11"
          }
        ]
      },
      {
        "name": "@endo/immutable-arraybuffer",
        "version": "2.0.0",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@endo/immutable-arraybuffer@2.0.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/endojs/endo"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@endo/immutable-arraybuffer/v/2.0.0"
          }
        ]
      },
      {
        "name": "lodash",
        "version": "4.17.21",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/lodash@4.17.21/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/lodash/lodash"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/lodash/v/4.17.21"
          }
        ]
      },
      {
        "name": "@datastructures-js/binary-search-tree",
        "version": "5.4.0",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/binary-search-tree@5.4.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/binary-search-tree"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/binary-search-tree/v/5.4.0"
          }
        ]
      },
      {
        "name": "@datastructures-js/deque",
        "version": "1.0.8",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/deque@1.0.8/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/deque"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/deque/v/1.0.8"
          }
        ]
      },
      {
        "name": "@datastructures-js/graph",
        "version": "5.3.1",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/graph@5.3.1/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/graph"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/graph/v/5.3.1"
          }
        ]
      },
      {
        "name": "@datastructures-js/heap",
        "version": "4.3.7",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/heap@4.3.7/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/heap"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/heap/v/4.3.7"
          }
        ]
      },
      {
        "name": "@datastructures-js/linked-list",
        "version": "6.1.4",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/linked-list@6.1.4/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/linked-list"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/linked-list/v/6.1.4"
          }
        ]
      },
      {
        "name": "@datastructures-js/priority-queue",
        "version": "6.3.5",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/priority-queue@6.3.5/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/priority-queue"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/priority-queue/v/6.3.5"
          }
        ]
      },
      {
        "name": "@datastructures-js/queue",
        "version": "4.3.0",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/queue@4.3.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/queue"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/queue/v/4.3.0"
          }
        ]
      },
      {
        "name": "@datastructures-js/set",
        "version": "4.2.2",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/set@4.2.2/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/set"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/set/v/4.2.2"
          }
        ]
      },
      {
        "name": "@datastructures-js/stack",
        "version": "3.1.6",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/stack@3.1.6/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/stack"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/stack/v/3.1.6"
          }
        ]
      },
      {
        "name": "@datastructures-js/trie",
        "version": "4.2.3",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/trie@4.2.3/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/trie"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/trie/v/4.2.3"
          }
        ]
      }
    ]
  },
  "typescript": {
    "language": "typescript",
    "components": [
      {
        "name": "typescript",
        "version": "5.9.3",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/typescript@5.9.3/LICENSE.txt"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/microsoft/TypeScript"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/typescript/v/5.9.3"
          }
        ]
      },
      {
        "name": "ses",
        "version": "2.3.0",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/ses@2.3.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/endojs/endo"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/ses/v/2.3.0"
          }
        ]
      },
      {
        "name": "acorn",
        "version": "8.16.0",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/acorn@8.16.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/acornjs/acorn"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/acorn/v/8.16.0"
          }
        ]
      },
      {
        "name": "@endo/cache-map",
        "version": "1.1.0",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@endo/cache-map@1.1.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/endojs/endo"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@endo/cache-map/v/1.1.0"
          }
        ]
      },
      {
        "name": "@endo/env-options",
        "version": "1.1.11",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@endo/env-options@1.1.11/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/endojs/endo"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@endo/env-options/v/1.1.11"
          }
        ]
      },
      {
        "name": "@endo/immutable-arraybuffer",
        "version": "2.0.0",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@endo/immutable-arraybuffer@2.0.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/endojs/endo"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@endo/immutable-arraybuffer/v/2.0.0"
          }
        ]
      },
      {
        "name": "lodash",
        "version": "4.17.21",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/lodash@4.17.21/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/lodash/lodash"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/lodash/v/4.17.21"
          }
        ]
      },
      {
        "name": "@datastructures-js/binary-search-tree",
        "version": "5.4.0",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/binary-search-tree@5.4.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/binary-search-tree"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/binary-search-tree/v/5.4.0"
          }
        ]
      },
      {
        "name": "@datastructures-js/deque",
        "version": "1.0.8",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/deque@1.0.8/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/deque"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/deque/v/1.0.8"
          }
        ]
      },
      {
        "name": "@datastructures-js/graph",
        "version": "5.3.1",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/graph@5.3.1/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/graph"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/graph/v/5.3.1"
          }
        ]
      },
      {
        "name": "@datastructures-js/heap",
        "version": "4.3.7",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/heap@4.3.7/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/heap"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/heap/v/4.3.7"
          }
        ]
      },
      {
        "name": "@datastructures-js/linked-list",
        "version": "6.1.4",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/linked-list@6.1.4/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/linked-list"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/linked-list/v/6.1.4"
          }
        ]
      },
      {
        "name": "@datastructures-js/priority-queue",
        "version": "6.3.5",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/priority-queue@6.3.5/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/priority-queue"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/priority-queue/v/6.3.5"
          }
        ]
      },
      {
        "name": "@datastructures-js/queue",
        "version": "4.3.0",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/queue@4.3.0/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/queue"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/queue/v/4.3.0"
          }
        ]
      },
      {
        "name": "@datastructures-js/set",
        "version": "4.2.2",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/set@4.2.2/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/set"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/set/v/4.2.2"
          }
        ]
      },
      {
        "name": "@datastructures-js/stack",
        "version": "3.1.6",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/stack@3.1.6/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/stack"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/stack/v/3.1.6"
          }
        ]
      },
      {
        "name": "@datastructures-js/trie",
        "version": "4.2.3",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://unpkg.com/@datastructures-js/trie@4.2.3/LICENSE"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/datastructures-js/trie"
          },
          {
            "kind": "package",
            "label": "Package",
            "url": "https://www.npmjs.com/package/@datastructures-js/trie/v/4.2.3"
          }
        ]
      }
    ]
  },
  "java": {
    "language": "java",
    "components": [
      {
        "name": "TraceJVM",
        "version": "0.4.1",
        "license": "AGPL-3.0-only",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://github.com/tracecodeapp/tracejvm/blob/v0.4.1/LICENSE"
          },
          {
            "kind": "notices",
            "label": "Third-party notices",
            "url": "https://github.com/tracecodeapp/tracejvm/blob/v0.4.1/THIRD_PARTY_NOTICES.md"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/tracecodeapp/tracejvm/tree/v0.4.1"
          }
        ]
      },
      {
        "name": "Eclipse Temurin OpenJDK",
        "version": "23.0.2+7",
        "license": "GPL-2.0-only WITH Classpath-exception-2.0",
        "detail": "Runtime image; the distributed release also carries the Assembly Exception and module notices.",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://openjdk.org/legal/gplv2+ce.html"
          },
          {
            "kind": "corresponding-source",
            "label": "Corresponding source",
            "url": "https://github.com/adoptium/jdk23u/archive/ff87e76b386d3f67234ccafc65049b155645ce85.tar.gz"
          },
          {
            "kind": "modifications",
            "label": "Build and modifications",
            "url": "https://github.com/tracecodeapp/tracejvm/tree/v0.4.1/runtime"
          }
        ]
      },
      {
        "name": "TeaVM javac",
        "version": "7e4a44cf5216",
        "license": "Apache-2.0",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://github.com/tracecodeapp/tracejvm/blob/v0.4.1/compiler/teavm-javac/LICENSE"
          },
          {
            "kind": "modifications",
            "label": "Notice and modifications",
            "url": "https://github.com/tracecodeapp/tracejvm/tree/v0.4.1/compiler/teavm-javac"
          },
          {
            "kind": "corresponding-source",
            "label": "Corresponding source",
            "url": "https://github.com/konsoletyper/teavm-javac/archive/7e4a44cf521694a4e326e33850dd8aec165eb5c9.tar.gz"
          },
          {
            "kind": "source",
            "label": "Upstream source",
            "url": "https://github.com/konsoletyper/teavm-javac/tree/7e4a44cf521694a4e326e33850dd8aec165eb5c9"
          }
        ]
      },
      {
        "name": "b-jvm",
        "version": "3fd56c746566",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://github.com/anematode/b-jvm/blob/3fd56c74656602eb32efefca46f51f074bef6bca/LICENSE"
          },
          {
            "kind": "source",
            "label": "Upstream source",
            "url": "https://github.com/anematode/b-jvm/tree/3fd56c74656602eb32efefca46f51f074bef6bca"
          }
        ]
      }
    ]
  },
  "csharp": {
    "language": "csharp",
    "components": [
      {
        "name": ".NET Runtime",
        "version": "10.0.10",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://github.com/dotnet/runtime/blob/v10.0.10/LICENSE.TXT"
          },
          {
            "kind": "notices",
            "label": "Third-party notices",
            "url": "https://github.com/dotnet/runtime/blob/v10.0.10/THIRD-PARTY-NOTICES.TXT"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/dotnet/runtime/tree/v10.0.10"
          }
        ]
      },
      {
        "name": "Roslyn C# compiler",
        "version": "5.3.0",
        "license": "MIT",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://github.com/dotnet/roslyn/blob/main/License.txt"
          },
          {
            "kind": "notices",
            "label": "Third-party notices",
            "url": "https://github.com/dotnet/roslyn/blob/main/THIRD-PARTY-NOTICES.txt"
          },
          {
            "kind": "package",
            "label": "NuGet package",
            "url": "https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp/5.3.0"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/dotnet/roslyn"
          }
        ]
      }
    ]
  },
  "cpp": {
    "language": "cpp",
    "components": [
      {
        "name": "TraceCC",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://spdx.org/licenses/AGPL-3.0-only.html"
          },
          {
            "kind": "notices",
            "label": "Third-party notices",
            "url": "https://github.com/tracecodeapp/tracecc/blob/v0.1.0/THIRD_PARTY_NOTICES.md"
          },
          {
            "kind": "source",
            "label": "Source",
            "url": "https://github.com/tracecodeapp/tracecc/tree/v0.1.0"
          }
        ]
      },
      {
        "name": "LLVM, Clang, LLD, and libc++",
        "license": "Apache-2.0 WITH LLVM-exception",
        "detail": "Compiler, linker, and C++ standard-library resources pinned by the TraceCC release.",
        "resources": [
          {
            "kind": "license",
            "label": "License",
            "url": "https://llvm.org/LICENSE.txt"
          },
          {
            "kind": "notices",
            "label": "TraceCC third-party notices",
            "url": "https://github.com/tracecodeapp/tracecc/blob/v0.1.0/THIRD_PARTY_NOTICES.md"
          },
          {
            "kind": "source",
            "label": "Upstream source",
            "url": "https://github.com/llvm/llvm-project"
          }
        ]
      },
      {
        "name": "WASI libc and sysroot materials",
        "license": "Apache-2.0 AND MIT AND BSD-2-Clause AND CC0-1.0",
        "detail": "Mixed permissive licenses recorded by the TraceCC release notices.",
        "resources": [
          {
            "kind": "notices",
            "label": "TraceCC third-party notices",
            "url": "https://github.com/tracecodeapp/tracecc/blob/v0.1.0/THIRD_PARTY_NOTICES.md"
          },
          {
            "kind": "source",
            "label": "Upstream source",
            "url": "https://github.com/WebAssembly/wasi-libc"
          }
        ]
      }
    ]
  }
})
) as Record<Language, LanguageRuntimeOpenSourceInfo>;
