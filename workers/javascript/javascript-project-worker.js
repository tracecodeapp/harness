var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/harness-core/src/runtime-project.ts
var RUNTIME_STDIN_PIPE_HEADER_INTS = 3;
var RUNTIME_STDIN_PIPE_HEADER_BYTES = RUNTIME_STDIN_PIPE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
var RUNTIME_STDIN_PIPE_READ_INDEX = 0;
var RUNTIME_STDIN_PIPE_WRITE_INDEX = 1;
var RUNTIME_STDIN_PIPE_CLOSED_INDEX = 2;
var RUNTIME_STDIN_PIPE_DEFAULT_CAPACITY = 64 * 1024;
function runtimeCommandStdinPipeState(pipe) {
  return {
    header: new Int32Array(pipe.buffer, 0, RUNTIME_STDIN_PIPE_HEADER_INTS),
    bytes: new Uint8Array(pipe.buffer, RUNTIME_STDIN_PIPE_HEADER_BYTES)
  };
}
function runtimeCommandStdinPipeAvailable(state) {
  const readIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
  const writeIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
  const capacity = state.bytes.byteLength;
  return readIndex <= writeIndex ? writeIndex - readIndex : capacity - readIndex + writeIndex;
}
function runtimeCommandStdinPipeClosed(pipe) {
  const { header } = runtimeCommandStdinPipeState(pipe);
  return Atomics.load(header, RUNTIME_STDIN_PIPE_CLOSED_INDEX) !== 0;
}
function runtimeCommandStdinPipeRemainingBytes(pipe) {
  return runtimeCommandStdinPipeAvailable(runtimeCommandStdinPipeState(pipe));
}
function readRuntimeCommandStdinPipeBytes(pipe, maxLength = RUNTIME_STDIN_PIPE_DEFAULT_CAPACITY) {
  const state = runtimeCommandStdinPipeState(pipe);
  const available = runtimeCommandStdinPipeAvailable(state);
  if (available <= 0 || maxLength <= 0) return new Uint8Array();
  const readIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
  const capacity = state.bytes.byteLength;
  const length = Math.min(Math.floor(maxLength), available);
  const out = new Uint8Array(length);
  const firstLength = Math.min(length, capacity - readIndex);
  out.set(state.bytes.subarray(readIndex, readIndex + firstLength), 0);
  if (firstLength < length) {
    out.set(state.bytes.subarray(0, length - firstLength), firstLength);
  }
  Atomics.store(state.header, RUNTIME_STDIN_PIPE_READ_INDEX, (readIndex + length) % capacity);
  return out;
}
function createRuntimeProjectIoBridge(onEvent) {
  return {
    output: (stream, data, device, sourceDevice) => {
      const outputDevice = device ?? (stream === "stdout" ? "/dev/stdout" : "/dev/stderr");
      onEvent?.({
        type: "output",
        stream,
        device: outputDevice,
        ...sourceDevice && sourceDevice !== outputDevice ? { sourceDevice } : {},
        data
      });
    },
    fileChange: (change, phase = "live") => {
      onEvent?.({ type: "file-change", change, phase });
    },
    status: (phase, message, detail) => {
      onEvent?.({
        type: "status",
        phase,
        message,
        ...detail ? { detail } : {}
      });
    }
  };
}
function runtimeFileChangePath(change) {
  return change.path;
}
function filterRuntimeCommandResultFiles(result, shouldFilter) {
  if (!result.files?.length) return result;
  const files = result.files.filter((change) => !shouldFilter(change));
  if (files.length === result.files.length) return result;
  if (files.length > 0) return { ...result, files };
  const { files: _files, ...rest } = result;
  return rest;
}
var RuntimeProjectOutputTracker = class {
  stdoutStreamed = "";
  stderrStreamed = "";
  observe(event) {
    if (event.type !== "output") return;
    if (event.stream === "stdout") this.stdoutStreamed += event.data;
    if (event.stream === "stderr") this.stderrStreamed += event.data;
  }
  emitMissingFinalOutput(result, output) {
    this.emitMissingStreamOutput("stdout", result.stdout, this.stdoutStreamed, output);
    this.emitMissingStreamOutput("stderr", result.stderr, this.stderrStreamed, output);
  }
  emitMissingStreamOutput(stream, finalOutput, streamedOutput, output) {
    if (!finalOutput) return;
    if (!streamedOutput) {
      output(stream, finalOutput);
      return;
    }
    if (finalOutput.startsWith(streamedOutput)) {
      const suffix = finalOutput.slice(streamedOutput.length);
      if (suffix) output(stream, suffix);
    }
  }
};
var RuntimeProjectEventQueue = class {
  queue = Promise.resolve();
  enqueue(event, options) {
    this.queue = this.queue.then(async () => {
      if (event.type !== "file-change") {
        options.emit(event);
        return;
      }
      const phase = event.phase ?? "live";
      const shouldEmit = await options.applyFileChange(event.change, phase);
      if (shouldEmit === false) return;
      options.emit({
        ...event,
        phase,
        actor: event.actor ?? options.actor
      });
    });
  }
  flush() {
    const pending = this.queue;
    this.queue = pending.catch(() => void 0);
    return pending;
  }
};
var RuntimeProjectLiveIoController = class {
  constructor(options) {
    this.options = options;
    this.eventQueue = options.applyFileChange ? new RuntimeProjectEventQueue() : null;
  }
  outputTracker = new RuntimeProjectOutputTracker();
  eventQueue;
  appliedFileChangePaths = /* @__PURE__ */ new Set();
  pendingFileChanges = 0;
  emit(event) {
    this.outputTracker.observe(event);
    this.options.onEvent?.(event);
  }
  handleRuntimeEvent(event) {
    if (event.type !== "file-change" && this.pendingFileChanges === 0) {
      this.emit(event);
      return;
    }
    if (!this.eventQueue) {
      this.emit(event);
      return;
    }
    if (event.type === "file-change") this.pendingFileChanges += 1;
    this.eventQueue.enqueue(event, {
      actor: this.options.actor,
      applyFileChange: async (change, phase) => {
        try {
          const shouldEmit = await this.options.applyFileChange?.(change, phase);
          this.appliedFileChangePaths.add(runtimeFileChangePath(change));
          return shouldEmit;
        } finally {
          this.pendingFileChanges = Math.max(0, this.pendingFileChanges - 1);
        }
      },
      emit: (nextEvent) => this.emit(nextEvent)
    });
  }
  async flush() {
    await this.eventQueue?.flush();
  }
  filterAppliedResultFiles(result) {
    if (this.appliedFileChangePaths.size === 0) return result;
    return filterRuntimeCommandResultFiles(
      result,
      (change) => this.appliedFileChangePaths.has(runtimeFileChangePath(change))
    );
  }
  emitMissingFinalOutput(result, output) {
    this.outputTracker.emitMissingFinalOutput(result, output);
  }
};

// packages/harness-core/src/generated/runtime-language-info-data.ts
var LANGUAGE_RUNTIME_INFOS = Object.freeze({
  "python": {
    "language": "python",
    "displayName": "Python",
    "versionLabel": "Python 3.13.2 (Pyodide 0.29.0)",
    "description": "Python 3.13.2 (Pyodide 0.29.0).\n\nCommon algorithm helpers are imported automatically, including array, bisect, collections, functools, heapq, itertools. Other standard-library modules can be imported normally.\n\nsortedcontainers 2.4.0 is available for TreeMap, ordered-set, and sorted-list style workflows.",
    "runtime": {
      "name": "Pyodide",
      "version": "0.29.0",
      "detail": "CPython 3.13.2 compiled to WebAssembly."
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
    ],
    "libraries": [
      {
        "name": "sortedcontainers",
        "version": "2.4.0",
        "importName": "sortedcontainers",
        "detail": "SortedDict, SortedList, and SortedSet are loaded for tree-map/tree-set style use cases."
      }
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
    "description": 'JavaScript runs in an isolated browser Web Worker with ECMAScript 2023-compatible syntax.\n\nLodash 4.17.21 is available as both lodash and _.\n\nThe @datastructures-js packages are bundled for common algorithm data structures. Queue, Stack, Deque, Heap, PriorityQueue, MinPriorityQueue, and MaxPriorityQueue are available globally.\n\nBundled @datastructures-js versions:\n\n"@datastructures-js/binary-search-tree": "5.4.0"\n"@datastructures-js/deque": "1.0.8"\n"@datastructures-js/graph": "5.3.1"\n"@datastructures-js/heap": "4.3.7"\n"@datastructures-js/linked-list": "6.1.4"\n"@datastructures-js/priority-queue": "6.3.5"\n"@datastructures-js/queue": "4.3.0"\n"@datastructures-js/set": "4.2.2"\n"@datastructures-js/stack": "3.1.6"\n"@datastructures-js/trie": "4.2.3"\n\nBinary Search Tree, Trie, and Graph are bundled too, but are not exposed globally because those names can collide with problem definitions. Import or require the matching package when you need one.'
  },
  "typescript": {
    "language": "typescript",
    "displayName": "TypeScript",
    "versionLabel": "TypeScript 5.9.3",
    "description": 'TypeScript 5.9.3 is compiled in the browser and then executed on the JavaScript worker runtime.\n\nCompiler options: --target ES2020 --module None --strict false --esModuleInterop\n\nLodash 4.17.21 is available as both lodash and _.\n\nThe @datastructures-js packages are bundled for common algorithm data structures. Queue, Stack, Deque, Heap, PriorityQueue, MinPriorityQueue, and MaxPriorityQueue are available globally.\n\nBundled @datastructures-js versions:\n\n"@datastructures-js/binary-search-tree": "5.4.0"\n"@datastructures-js/deque": "1.0.8"\n"@datastructures-js/graph": "5.3.1"\n"@datastructures-js/heap": "4.3.7"\n"@datastructures-js/linked-list": "6.1.4"\n"@datastructures-js/priority-queue": "6.3.5"\n"@datastructures-js/queue": "4.3.0"\n"@datastructures-js/set": "4.2.2"\n"@datastructures-js/stack": "3.1.6"\n"@datastructures-js/trie": "4.2.3"\n\nBinary Search Tree, Trie, and Graph are bundled too, but are not exposed globally because those names can collide with problem definitions. Import or require the matching package when you need one.\n\nThe compiled output runs on the same browser worker execution lane as JavaScript submissions.',
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
    "versionLabel": "Java 17",
    "description": "Java 17 is compiled with javac 17 and executed in the browser through CheerpJ 4.2.\n\nCommon imports are added automatically: java.util.*, java.io.*, java.math.*, java.util.stream.*, javafx.util.Pair.",
    "runtime": {
      "name": "CheerpJ browser-local OpenJDK runtime",
      "version": "17",
      "detail": "Loaded through CheerpJ 4.2."
    },
    "compiler": {
      "name": "javac",
      "version": "17"
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
    "versionLabel": "C# 14 (.NET 10.0.8)",
    "description": "C# 14 with .NET 10.0.8 runtime.\n\nCode is compiled with Microsoft.CodeAnalysis.CSharp 5.3.0 and executed by a browser-local .NET WebAssembly runtime.\n\nCommon namespaces are imported automatically: System, System.Collections, System.Collections.Generic, System.IO, System.Linq, System.Numerics, System.Text, System.Text.RegularExpressions.",
    "runtime": {
      "name": ".NET WebAssembly runtime",
      "version": "10.0.8",
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
});

// packages/harness-core/src/runtime-language-info.ts
var SUPPORTED_LANGUAGE_RUNTIME_INFOS = Object.freeze(
  Object.values(LANGUAGE_RUNTIME_INFOS)
);
function getLanguageRuntimeInfo(language) {
  const info = LANGUAGE_RUNTIME_INFOS[language];
  if (!info) {
    throw new Error(`Runtime info for language "${language}" is not implemented yet.`);
  }
  return info;
}

// packages/harness-core/src/runtime-kernel.ts
var RUNTIME_KERNEL_DEVICE_ENTRIES = ["null", "stderr", "stdin", "stdout", "tty"];
function runtimeKernelReadonlyFileErrorMessage(path, operation) {
  return `EROFS: readonly project file, ${operation} '${path}'`;
}
function createRuntimeKernelReadonlyFileError(path, operation) {
  return Object.assign(new Error(runtimeKernelReadonlyFileErrorMessage(path, operation)), { code: "EROFS" });
}
function normalizeRuntimeAbsolutePath(path) {
  const raw = path.replace(/\\/g, "/");
  if (!raw.startsWith("/")) return null;
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
}
function normalizeRuntimeProcPath(path) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null) return null;
  return normalized === "/proc" || normalized.startsWith("/proc/") ? normalized : null;
}
function normalizeRuntimeDevicePath(path) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null) return null;
  if (normalized === "/dev") return "/dev";
  if (normalized === "/dev/stdin" || normalized === "/dev/stdout" || normalized === "/dev/stderr" || normalized === "/dev/null" || normalized === "/dev/tty") {
    return normalized;
  }
  return null;
}
function normalizeRuntimeKernelManifestDevicePath(path) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null || normalized === "/dev" || !normalized.startsWith("/dev/")) return null;
  return normalized.slice("/dev/".length).length > 0 ? normalized : null;
}
function classifyRuntimeKernelVirtualPath(path) {
  const procPath = normalizeRuntimeProcPath(path);
  if (procPath !== null) return { kind: "proc", path: procPath };
  const devicePath = normalizeRuntimeDevicePath(path);
  if (devicePath === "/dev") return { kind: "device-directory", path: devicePath };
  if (devicePath !== null) return { kind: "device", path: devicePath };
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized?.startsWith("/dev/") === true) return { kind: "device-namespace", path: normalized };
  return null;
}
function runtimeDeviceCanRead(device) {
  return device === "/dev/stdin" || device === "/dev/tty" || device === "/dev/null";
}
function runtimeDeviceCanWrite(device) {
  return device === "/dev/stdout" || device === "/dev/stderr" || device === "/dev/tty" || device === "/dev/null";
}
function runtimeDeviceInputSource(device) {
  if (!runtimeDeviceCanRead(device)) return null;
  return device === "/dev/null" ? "/dev/null" : "/dev/stdin";
}
function runtimeDeviceOutputTarget(device) {
  if (!runtimeDeviceCanWrite(device)) return null;
  if (device === "/dev/null") return "/dev/null";
  return device === "/dev/tty" ? "/dev/stdout" : device;
}
function runtimeKernelDeviceInfo(devices, device) {
  const entries = devices ?? runtimeKernelVirtualDevices();
  return entries.find((entry) => normalizeRuntimeKernelManifestDevicePath(entry.path) === device) ?? null;
}
function normalizeDeviceReference(value) {
  if (!value) return null;
  return normalizeRuntimeKernelManifestDevicePath(value);
}
function runtimeKernelDeviceInputSource(devices, device) {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.readable) return null;
  return normalizeDeviceReference(info.inputDevice) ?? device;
}
function runtimeKernelDeviceInputRoute(devices, device) {
  const inputDevice = devices ? runtimeKernelDeviceInputSource(devices, device) : runtimeDeviceInputSource(device);
  if (!inputDevice || inputDevice === "/dev/null") return null;
  return {
    inputDevice,
    ...device !== inputDevice ? { sourceDevice: device } : {}
  };
}
function runtimeKernelDeviceOutputTarget(devices, device) {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.writable) return null;
  return normalizeDeviceReference(info.outputDevice) ?? device;
}
function runtimeKernelDeviceOutputRoute(devices, device) {
  const outputDevice = devices ? runtimeKernelDeviceOutputTarget(devices, device) : runtimeDeviceOutputTarget(device);
  if (!outputDevice || outputDevice === "/dev/null") return null;
  return {
    outputDevice,
    stream: outputDevice === "/dev/stderr" ? "stderr" : "stdout",
    ...device !== outputDevice ? { sourceDevice: device } : {}
  };
}
function runtimeDeviceDirEntries(path, devices) {
  const directoryPath = path === "/dev" ? "/dev" : normalizeRuntimeKernelManifestDevicePath(path);
  if (!directoryPath) return null;
  const entries = devices ?? runtimeKernelVirtualDevices();
  const prefix = directoryPath === "/dev" ? "/dev/" : `${directoryPath}/`;
  const names = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const devicePath = normalizeRuntimeKernelManifestDevicePath(entry.path);
    if (!devicePath?.startsWith(prefix)) continue;
    const remainder = devicePath.slice(prefix.length);
    const [name] = remainder.split("/");
    if (name) names.add(name);
  }
  if (directoryPath !== "/dev" && names.size === 0) return null;
  return Array.from(names).sort();
}
function runtimeDeviceEntryKind(path, devices) {
  if (path === "/dev") return "directory";
  const devicePath = normalizeRuntimeKernelManifestDevicePath(path);
  if (devicePath && devices && runtimeKernelDeviceInfo(devices, devicePath)) return "file";
  if (devicePath && runtimeDeviceDirEntries(devicePath, devices)) return "directory";
  return "file";
}
function runtimeDeviceStat(path, devices) {
  const kind = runtimeDeviceEntryKind(path, devices);
  const isDirectory = kind === "directory";
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: !isDirectory,
    mode: isDirectory ? 493 : 438,
    size: 0,
    uid: 0,
    gid: 0,
    owner: "root",
    group: "root"
  };
}
function runtimeKernelWriteTarget(path, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "proc") {
    return { kind: "error", reason: "proc-read-only", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-directory") {
    return { kind: "error", reason: "device-directory", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "error", reason: "device-directory", path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: "error", reason: "device-not-found", path: virtualPath.path };
    }
    const outputDevice2 = runtimeKernelDeviceOutputTarget(devices, device);
    if (!outputDevice2) {
      return { kind: "error", reason: "device-read-only", path: virtualPath.path };
    }
    return { kind: "device", device, outputDevice: outputDevice2 };
  }
  const outputDevice = devices ? runtimeKernelDeviceOutputTarget(devices, virtualPath.path) : runtimeDeviceOutputTarget(virtualPath.path);
  if (!outputDevice) {
    return { kind: "error", reason: "device-read-only", path: virtualPath.path };
  }
  return { kind: "device", device: virtualPath.path, outputDevice };
}
function runtimeKernelWriteErrorCode(reason) {
  if (reason === "proc-read-only") return "EROFS";
  if (reason === "device-directory") return "EISDIR";
  if (reason === "device-read-only") return "EBADF";
  return "ENOENT";
}
function runtimeKernelWriteFsErrorMessage(path, target, operation = "open") {
  const code = runtimeKernelWriteErrorCode(target.reason);
  if (code === "EROFS") return `EROFS: read-only file system, ${operation} '${path}'`;
  if (code === "EBADF") return `EBADF: bad file descriptor, write`;
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}
function runtimeKernelMutationTarget(path, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "proc") {
    return { kind: "error", reason: "proc-read-only", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "error", reason: "device-read-only", path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: "error", reason: "device-not-found", path: virtualPath.path };
    }
    return { kind: "error", reason: "device-read-only", path: virtualPath.path };
  }
  if (virtualPath.kind === "device" && devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
    return { kind: "error", reason: "device-not-found", path: virtualPath.path };
  }
  return { kind: "error", reason: "device-read-only", path: virtualPath.path };
}
function runtimeKernelMutationErrorCode(reason) {
  return reason === "device-not-found" ? "ENOENT" : "EROFS";
}
function runtimeKernelMutationFsErrorMessage(path, target, operation, destination) {
  const suffix = destination === void 0 ? `${operation} '${path}'` : `${operation} '${path}' -> '${destination}'`;
  const code = runtimeKernelMutationErrorCode(target.reason);
  if (code === "ENOENT") return `ENOENT: no such file or directory, ${suffix}`;
  return `EROFS: read-only file system, ${suffix}`;
}
function runtimeKernelMetadataTarget(path, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "proc") {
    return { kind: "error", reason: "proc-read-only", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "ignored-device", path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: "error", reason: "device-not-found", path: virtualPath.path };
    }
    return { kind: "ignored-device", path: device };
  }
  if (virtualPath.kind === "device" && devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
    return { kind: "error", reason: "device-not-found", path: virtualPath.path };
  }
  return { kind: "ignored-device", path: virtualPath.path };
}
function runtimeKernelMetadataErrorCode(reason) {
  return reason === "proc-read-only" ? "EROFS" : "ENOENT";
}
function runtimeKernelAccessTarget(path, request = {}, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return request.write || request.execute ? { kind: "denied", reason: "permission-denied", path: device } : { kind: "allowed", path: device };
    }
    if (!device || !info) return { kind: "denied", reason: "not-found", path: virtualPath.path };
    return request.read && !info.readable || request.write && !info.writable || request.execute ? { kind: "denied", reason: "permission-denied", path: device } : { kind: "allowed", path: device };
  }
  if (virtualPath.kind === "device-directory") {
    return request.write || request.execute ? { kind: "denied", reason: "permission-denied", path: virtualPath.path } : { kind: "allowed", path: virtualPath.path };
  }
  if (virtualPath.kind === "device") {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: "denied", reason: "not-found", path: virtualPath.path };
    const readable = info ? info.readable : runtimeDeviceCanRead(virtualPath.path);
    const writable = info ? info.writable : runtimeDeviceCanWrite(virtualPath.path);
    return request.read && !readable || request.write && !writable || request.execute ? { kind: "denied", reason: "permission-denied", path: virtualPath.path } : { kind: "allowed", path: virtualPath.path };
  }
  if (!runtimeProcEntryKind(virtualPath.path)) {
    return { kind: "denied", reason: "not-found", path: virtualPath.path };
  }
  return request.write || request.execute ? { kind: "denied", reason: "permission-denied", path: virtualPath.path } : { kind: "allowed", path: virtualPath.path };
}
function runtimeKernelOpenTarget(path, request = {}, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "error", reason: "is-directory", path: device };
    }
    if (!device || !info) return { kind: "error", reason: "not-found", path: virtualPath.path };
    return {
      kind: "device",
      device,
      readable: info.readable && request.readable === true,
      writable: info.writable && request.writable === true
    };
  }
  if (virtualPath.kind === "device-directory") {
    return { kind: "error", reason: "is-directory", path: virtualPath.path };
  }
  if (virtualPath.kind === "device") {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: "error", reason: "not-found", path: virtualPath.path };
    return {
      kind: "device",
      device: virtualPath.path,
      readable: info ? info.readable && request.readable === true : runtimeDeviceCanRead(virtualPath.path) && request.readable === true,
      writable: info ? info.writable && request.writable === true : runtimeDeviceCanWrite(virtualPath.path) && request.writable === true
    };
  }
  const entryKind = runtimeProcEntryKind(virtualPath.path);
  if (!entryKind) {
    return { kind: "error", reason: "not-found", path: virtualPath.path };
  }
  if (entryKind === "directory") {
    return { kind: "error", reason: "is-directory", path: virtualPath.path };
  }
  if (request.writable || request.create || request.truncate || request.exclusive) {
    return { kind: "error", reason: "read-only", path: virtualPath.path };
  }
  return { kind: "proc-file", path: virtualPath.path, readable: true, writable: false };
}
function runtimeKernelOpenErrorCode(reason) {
  if (reason === "is-directory") return "EISDIR";
  if (reason === "read-only") return "EROFS";
  return "ENOENT";
}
function runtimeKernelOpenErrorMessage(path, target, operation = "open") {
  const code = runtimeKernelOpenErrorCode(target.reason);
  if (code === "EROFS") return `EROFS: read-only file system, ${operation} '${path}'`;
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}
function runtimeKernelReadTarget(path, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "device-directory", path: device };
    }
    if (!device || !info) return { kind: "error", reason: "not-found", path: virtualPath.path };
    return info.readable ? { kind: "device-file", path: device } : { kind: "error", reason: "permission-denied", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-directory") return virtualPath;
  if (virtualPath.kind === "device") {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: "error", reason: "not-found", path: virtualPath.path };
    const readable = info ? info.readable : runtimeDeviceCanRead(virtualPath.path);
    return readable ? { kind: "device-file", path: virtualPath.path } : { kind: "error", reason: "permission-denied", path: virtualPath.path };
  }
  const kind = runtimeProcEntryKind(virtualPath.path);
  if (kind === "file") return { kind: "proc-file", path: virtualPath.path };
  if (kind === "directory") return { kind: "proc-directory", path: virtualPath.path };
  return { kind: "error", reason: "not-found", path: virtualPath.path };
}
function runtimeKernelFileReadTarget(path, devices) {
  const readTarget = runtimeKernelReadTarget(path, devices);
  if (readTarget.kind === "device-file" || readTarget.kind === "proc-file" || readTarget.kind === "workspace") {
    return readTarget;
  }
  if (readTarget.kind === "device-directory" || readTarget.kind === "proc-directory") {
    return { kind: "error", reason: "is-directory", path: readTarget.path };
  }
  return readTarget;
}
function runtimeKernelFileReadErrorCode(reason) {
  if (reason === "permission-denied") return "EBADF";
  return reason === "is-directory" ? "EISDIR" : "ENOENT";
}
function runtimeKernelFileReadFsErrorMessage(path, target, operation = "open") {
  const code = runtimeKernelFileReadErrorCode(target.reason);
  if (code === "EBADF") return `EBADF: bad file descriptor, ${operation} '${path}'`;
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}
function runtimeKernelStatTarget(path, info, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "device-directory") {
    return { kind: "stat", path: virtualPath.path, stat: runtimeDeviceStat(virtualPath.path, devices) };
  }
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      if (device && runtimeDeviceDirEntries(device, devices)) {
        return { kind: "stat", path: device, stat: runtimeDeviceStat(device, devices) };
      }
      return { kind: "error", reason: "not-found", path: virtualPath.path };
    }
    return { kind: "stat", path: device, stat: runtimeDeviceStat(device, devices) };
  }
  if (virtualPath.kind === "device") {
    if (devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
      return { kind: "error", reason: "not-found", path: virtualPath.path };
    }
    return { kind: "stat", path: virtualPath.path, stat: runtimeDeviceStat(virtualPath.path, devices) };
  }
  const stat = runtimeProcStat(virtualPath.path, info);
  return stat ? { kind: "stat", path: virtualPath.path, stat } : { kind: "error", reason: "not-found", path: virtualPath.path };
}
function runtimeKernelDirectoryTarget(path, devices) {
  const readTarget = runtimeKernelReadTarget(path, devices);
  if (readTarget.kind === "workspace") return readTarget;
  if (readTarget.kind === "device-directory") {
    return {
      kind: "directory",
      path: readTarget.path,
      entries: (runtimeDeviceDirEntries(readTarget.path, devices) ?? []).map((name) => ({
        name,
        kind: runtimeDeviceEntryKind(`${readTarget.path === "/dev" ? "/dev" : readTarget.path}/${name}`, devices)
      }))
    };
  }
  if (readTarget.kind === "proc-directory") {
    return {
      kind: "directory",
      path: readTarget.path,
      entries: (runtimeProcDirEntries(readTarget.path) ?? []).map((name) => ({
        name,
        kind: runtimeProcEntryKind(`${readTarget.path}/${name}`) ?? "file"
      }))
    };
  }
  if (readTarget.kind === "device-file" || readTarget.kind === "proc-file") {
    return { kind: "error", reason: "not-directory", path: readTarget.path };
  }
  if (readTarget.reason === "permission-denied") {
    return { kind: "error", reason: "not-directory", path: readTarget.path };
  }
  return { kind: "error", reason: "not-found", path: readTarget.path };
}
function runtimeKernelDirectoryErrorCode(reason) {
  return reason === "not-directory" ? "ENOTDIR" : "ENOENT";
}
function runtimeKernelCopyTarget(source, destination, devices) {
  const sourceTarget = runtimeKernelReadTarget(source, devices);
  const writeTarget = runtimeKernelWriteTarget(destination, devices);
  if (sourceTarget.kind === "device-file" || sourceTarget.kind === "proc-file" || writeTarget.kind === "device" || writeTarget.kind === "error") {
    return { kind: "file-copy" };
  }
  if (sourceTarget.kind === "device-directory" || sourceTarget.kind === "proc-directory") {
    return { kind: "error", reason: "source-directory", path: sourceTarget.path };
  }
  if (sourceTarget.kind === "error") {
    return { kind: "error", reason: "source-not-found", path: sourceTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelCopyErrorCode(reason) {
  return reason === "source-directory" ? "EISDIR" : "ENOENT";
}
function runtimeKernelCopyErrorMessage(source, destination, target, operation = "cp") {
  const code = runtimeKernelCopyErrorCode(target.reason);
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${operation} '${source}'`;
  return `ENOENT: no such file or directory, ${operation} '${source}' -> '${destination}'`;
}
function runtimeKernelFileCopyTarget(source, destination, devices) {
  const writeTarget = runtimeKernelWriteTarget(destination, devices);
  if (writeTarget.kind === "error") {
    return { kind: "error", side: "destination", reason: writeTarget.reason, path: writeTarget.path };
  }
  const sourceTarget = runtimeKernelFileReadTarget(source, devices);
  if (sourceTarget.kind === "error") {
    return { kind: "error", side: "source", reason: sourceTarget.reason, path: sourceTarget.path };
  }
  if (writeTarget.kind === "device") {
    return { kind: "device-destination", device: writeTarget.device, outputDevice: writeTarget.outputDevice, source: sourceTarget };
  }
  if (sourceTarget.kind === "device-file" || sourceTarget.kind === "proc-file") {
    return { kind: "virtual-source", source: sourceTarget };
  }
  return { kind: "workspace" };
}
function runtimeKernelFileCopyErrorCode(target) {
  return target.side === "destination" ? runtimeKernelWriteErrorCode(target.reason) : runtimeKernelFileReadErrorCode(target.reason);
}
function runtimeKernelFileCopyErrorMessage(source, destination, target, operation = "copyfile") {
  const code = runtimeKernelFileCopyErrorCode(target);
  const suffix = `${operation} '${source}' -> '${destination}'`;
  if (code === "EROFS") return `EROFS: read-only file system, ${suffix}`;
  if (code === "EBADF") return `EBADF: bad file descriptor, ${suffix}`;
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${suffix}`;
  return `ENOENT: no such file or directory, ${suffix}`;
}
function runtimeKernelLinkTarget(source, destination, devices) {
  const sourceTarget = runtimeKernelMutationTarget(source, devices);
  if (sourceTarget.kind === "error") {
    return { kind: "error", side: "source", reason: sourceTarget.reason, path: sourceTarget.path };
  }
  const destinationTarget = runtimeKernelMutationTarget(destination, devices);
  if (destinationTarget.kind === "error") {
    return { kind: "error", side: "destination", reason: destinationTarget.reason, path: destinationTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelLinkErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelRenameTarget(source, destination, devices) {
  const sourceTarget = runtimeKernelMutationTarget(source, devices);
  if (sourceTarget.kind === "error") {
    return { kind: "error", side: "source", reason: sourceTarget.reason, path: sourceTarget.path };
  }
  const destinationTarget = runtimeKernelMutationTarget(destination, devices);
  if (destinationTarget.kind === "error") {
    return { kind: "error", side: "destination", reason: destinationTarget.reason, path: destinationTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelRenameErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelSymlinkTarget(linkPath, devices) {
  const linkTarget = runtimeKernelMutationTarget(linkPath, devices);
  if (linkTarget.kind === "error") {
    return { kind: "error", reason: linkTarget.reason, path: linkTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelSymlinkErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelRemoveTarget(path, devices) {
  const removeTarget = runtimeKernelMutationTarget(path, devices);
  if (removeTarget.kind === "error") {
    return { kind: "error", reason: removeTarget.reason, path: removeTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelRemoveErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelMkdirTarget(path, devices) {
  const mkdirTarget = runtimeKernelMutationTarget(path, devices);
  if (mkdirTarget.kind === "error") {
    return { kind: "error", reason: mkdirTarget.reason, path: mkdirTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelMkdirErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelTruncateTarget(path, devices) {
  const truncateTarget = runtimeKernelMutationTarget(path, devices);
  if (truncateTarget.kind === "error") {
    return { kind: "error", reason: truncateTarget.reason, path: truncateTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelTruncateErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeProcInfoJson(info) {
  return `${JSON.stringify(info, null, 2)}
`;
}
function runtimeMountInfoField(value) {
  return value.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011").replace(/\n/g, "\\012");
}
function runtimeProcMountInfo(info) {
  const workspaceRoot = runtimeMountInfoField(info.workspaceRoot);
  const workspaceName = runtimeMountInfoField(info.workspace.name);
  const aliasLine = info.workspaceAlias ? `27 24 0:1 / ${runtimeMountInfoField(info.workspaceAlias)} rw,relatime alias=${workspaceRoot} - tracefs tracekernel:workspace rw,name=${workspaceName}` : null;
  return [
    `24 0 0:1 / ${workspaceRoot} rw,relatime - tracefs tracekernel:workspace rw,name=${workspaceName}`,
    aliasLine,
    "25 0 0:2 / /dev rw,nosuid - tracefs tracekernel:dev rw,mode=755",
    "26 0 0:3 / /proc rw,nosuid,nodev,noexec - tracefs tracekernel:proc rw"
  ].filter((line) => Boolean(line)).join("\n") + "\n";
}
function runtimeProcKernelVersion(info) {
  return `${info.name} ${info.version}
`;
}
function runtimeProcDirEntries(path) {
  if (path === "/proc") return ["kernel", "self"];
  if (path === "/proc/kernel") return ["info", "version"];
  if (path === "/proc/self") return ["mountinfo"];
  return null;
}
function runtimeProcEntryKind(path) {
  if (runtimeProcDirEntries(path)) return "directory";
  if (path === "/proc/kernel/info" || path === "/proc/kernel/version" || path === "/proc/self/mountinfo") return "file";
  return null;
}
function runtimeKernelVirtualDevices() {
  return RUNTIME_KERNEL_DEVICE_ENTRIES.map((name) => {
    const path = `/dev/${name}`;
    const inputDevice = runtimeDeviceInputSource(path) ?? void 0;
    const outputDevice = runtimeDeviceOutputTarget(path) ?? void 0;
    return {
      path,
      readable: inputDevice !== void 0,
      writable: outputDevice !== void 0,
      ...inputDevice ? { inputDevice } : {},
      ...outputDevice ? { outputDevice } : {}
    };
  });
}
function readRuntimeProcFile(path, info) {
  if (path === "/proc/kernel/info") return runtimeProcInfoJson(info);
  if (path === "/proc/kernel/version") return runtimeProcKernelVersion(info);
  if (path === "/proc/self/mountinfo") return runtimeProcMountInfo(info);
  if (runtimeProcDirEntries(path)) {
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: "EISDIR" });
  }
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
}
function runtimeProcStat(path, info) {
  const kind = runtimeProcEntryKind(path);
  if (!kind) return null;
  const isDirectory = kind === "directory";
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: false,
    mode: isDirectory ? 365 : 292,
    size: isDirectory ? 0 : new TextEncoder().encode(readRuntimeProcFile(path, info)).byteLength,
    uid: 0,
    gid: 0,
    owner: "root",
    group: "root"
  };
}

// node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/browser.js
var browser_exports = {};
__export(browser_exports, {
  AsyncCompress: () => AsyncGzip,
  AsyncDecompress: () => AsyncDecompress,
  AsyncDeflate: () => AsyncDeflate,
  AsyncGunzip: () => AsyncGunzip,
  AsyncGzip: () => AsyncGzip,
  AsyncInflate: () => AsyncInflate,
  AsyncUnzipInflate: () => AsyncUnzipInflate,
  AsyncUnzlib: () => AsyncUnzlib,
  AsyncZipDeflate: () => AsyncZipDeflate,
  AsyncZlib: () => AsyncZlib,
  Compress: () => Gzip,
  DecodeUTF8: () => DecodeUTF8,
  Decompress: () => Decompress,
  Deflate: () => Deflate,
  EncodeUTF8: () => EncodeUTF8,
  FlateErrorCode: () => FlateErrorCode,
  Gunzip: () => Gunzip,
  Gzip: () => Gzip,
  Inflate: () => Inflate,
  Unzip: () => Unzip,
  UnzipInflate: () => UnzipInflate,
  UnzipPassThrough: () => UnzipPassThrough,
  Unzlib: () => Unzlib,
  Zip: () => Zip,
  ZipDeflate: () => ZipDeflate,
  ZipPassThrough: () => ZipPassThrough,
  Zlib: () => Zlib,
  compress: () => gzip,
  compressSync: () => gzipSync,
  decompress: () => decompress,
  decompressSync: () => decompressSync,
  deflate: () => deflate,
  deflateSync: () => deflateSync,
  gunzip: () => gunzip,
  gunzipSync: () => gunzipSync,
  gzip: () => gzip,
  gzipSync: () => gzipSync,
  inflate: () => inflate,
  inflateSync: () => inflateSync,
  strFromU8: () => strFromU8,
  strToU8: () => strToU8,
  unzip: () => unzip,
  unzipSync: () => unzipSync,
  unzlib: () => unzlib,
  unzlibSync: () => unzlibSync,
  zip: () => zip,
  zipSync: () => zipSync,
  zlib: () => zlib,
  zlibSync: () => zlibSync
});
var ch2 = {};
var wk = (function(c, id, msg, transfer, cb) {
  var w = new Worker(ch2[id] || (ch2[id] = URL.createObjectURL(new Blob([
    c + ';addEventListener("error",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})'
  ], { type: "text/javascript" }))));
  w.onmessage = function(e) {
    var d = e.data, ed = d.$e$;
    if (ed) {
      var err2 = new Error(ed[0]);
      err2["code"] = ed[1];
      err2.stack = ed[2];
      cb(err2, null);
    } else
      cb(null, d);
  };
  w.postMessage(msg, transfer);
  return w;
});
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flm = /* @__PURE__ */ hMap(flt, 9, 0);
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var FlateErrorCode = {
  UnexpectedEOF: 0,
  InvalidBlockType: 1,
  InvalidLengthLiteral: 2,
  InvalidDistance: 3,
  StreamFinished: 4,
  NoStreamHandler: 5,
  InvalidHeader: 6,
  NoCallback: 7,
  InvalidUTF8: 8,
  ExtraFieldTooLong: 9,
  InvalidDate: 10,
  FilenameTooLong: 11,
  StreamFinishing: 12,
  InvalidZipData: 13,
  UnknownCompressionMethod: 14
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var wbits = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
};
var wbits16 = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
  d[o + 2] |= v >> 16;
};
var hTree = function(d, mb) {
  var t = [];
  for (var i = 0; i < d.length; ++i) {
    if (d[i])
      t.push({ s: i, f: d[i] });
  }
  var s = t.length;
  var t2 = t.slice();
  if (!s)
    return { t: et, l: 0 };
  if (s == 1) {
    var v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return { t: v, l: 1 };
  }
  t.sort(function(a, b) {
    return a.f - b.f;
  });
  t.push({ s: -1, f: 25001 });
  var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 != s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  var maxSym = t2[0].s;
  for (var i = 1; i < s; ++i) {
    if (t2[i].s > maxSym)
      maxSym = t2[i].s;
  }
  var tr = new u16(maxSym + 1);
  var mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    var i = 0, dt = 0;
    var lft = mbt - mb, cst = 1 << lft;
    t2.sort(function(a, b) {
      return tr[b.s] - tr[a.s] || a.f - b.f;
    });
    for (; i < s; ++i) {
      var i2_1 = t2[i].s;
      if (tr[i2_1] > mb) {
        dt += cst - (1 << mbt - tr[i2_1]);
        tr[i2_1] = mb;
      } else
        break;
    }
    dt >>= lft;
    while (dt > 0) {
      var i2_2 = t2[i].s;
      if (tr[i2_2] < mb)
        dt -= 1 << mb - tr[i2_2]++ - 1;
      else
        ++i;
    }
    for (; i >= 0 && dt; --i) {
      var i2_3 = t2[i].s;
      if (tr[i2_3] == mb) {
        --tr[i2_3];
        ++dt;
      }
    }
    mbt = mb;
  }
  return { t: new u8(tr), l: mbt };
};
var ln = function(n, l, d) {
  return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = function(c) {
  var s = c.length;
  while (s && !c[--s])
    ;
  var cl = new u16(++s);
  var cli = 0, cln = c[0], cls = 1;
  var w = function(v) {
    cl[cli++] = v;
  };
  for (var i = 1; i <= s; ++i) {
    if (c[i] == cln && i != s)
      ++cls;
    else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138)
          w(32754);
        if (cls > 2) {
          w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6)
          w(8304);
        if (cls > 2)
          w(cls - 3 << 5 | 8208), cls = 0;
      }
      while (cls--)
        w(cln);
      cls = 1;
      cln = c[i];
    }
  }
  return { c: cl.subarray(0, cli), n: s };
};
var clen = function(cf, cl) {
  var l = 0;
  for (var i = 0; i < cl.length; ++i)
    l += cf[i] * cl[i];
  return l;
};
var wfblk = function(out, pos, dat) {
  var s = dat.length;
  var o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (var i = 0; i < s; ++i)
    out[o + i + 4] = dat[i];
  return (o + 4 + s) * 8;
};
var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
  wbits(out, p++, final);
  ++lf[256];
  var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
  var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
  var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
  var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
  var lcfreq = new u16(19);
  for (var i = 0; i < lclt.length; ++i)
    ++lcfreq[lclt[i] & 31];
  for (var i = 0; i < lcdt.length; ++i)
    ++lcfreq[lcdt[i] & 31];
  var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
  var nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
    ;
  var flen = bl + 5 << 3;
  var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
  if (bs >= 0 && flen <= ftlen && flen <= dtlen)
    return wfblk(out, p, dat.subarray(bs, bs + bl));
  var lm, ll, dm, dl;
  wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
    var llm = hMap(lct, mlcb, 0);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (var i = 0; i < nlcc; ++i)
      wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    var lcts = [lclt, lcdt];
    for (var it = 0; it < 2; ++it) {
      var clct = lcts[it];
      for (var i = 0; i < clct.length; ++i) {
        var len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15)
          wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (var i = 0; i < li; ++i) {
    var sym = syms[i];
    if (sym > 255) {
      var len = sym >> 18 & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7)
        wbits(out, p, sym >> 23 & 31), p += fleb[len];
      var dst = sym & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3)
        wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[sym]), p += ll[sym];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
};
var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
var et = /* @__PURE__ */ new u8(0);
var dflt = function(dat, lvl, plvl, pre, post, st) {
  var s = st.z || dat.length;
  var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
  var w = o.subarray(pre, o.length - post);
  var lst = st.l;
  var pos = (st.r || 0) & 7;
  if (lvl) {
    if (pos)
      w[0] = st.r >> 3;
    var opt = deo[lvl - 1];
    var n = opt >> 13, c = opt & 8191;
    var msk_1 = (1 << plvl) - 1;
    var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
    var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
    var hsh = function(i2) {
      return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
    };
    var syms = new i32(25e3);
    var lf = new u16(288), df = new u16(32);
    var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
    for (; i + 2 < s; ++i) {
      var hv = hsh(i);
      var imod = i & 32767, pimod = head[hv];
      prev[imod] = pimod;
      head[hv] = imod;
      if (wi <= i) {
        var rem = s - i;
        if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
          pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
          li = lc_1 = eb = 0, bs = i;
          for (var j = 0; j < 286; ++j)
            lf[j] = 0;
          for (var j = 0; j < 30; ++j)
            df[j] = 0;
        }
        var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
        if (rem > 2 && hv == hsh(i - dif)) {
          var maxn = Math.min(n, rem) - 1;
          var maxd = Math.min(32767, i);
          var ml = Math.min(258, rem);
          while (dif <= maxd && --ch_1 && imod != pimod) {
            if (dat[i + l] == dat[i + l - dif]) {
              var nl = 0;
              for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                ;
              if (nl > l) {
                l = nl, d = dif;
                if (nl > maxn)
                  break;
                var mmd = Math.min(dif, nl - 2);
                var md = 0;
                for (var j = 0; j < mmd; ++j) {
                  var ti = i - dif + j & 32767;
                  var pti = prev[ti];
                  var cd = ti - pti & 32767;
                  if (cd > md)
                    md = cd, pimod = ti;
                }
              }
            }
            imod = pimod, pimod = prev[imod];
            dif += imod - pimod & 32767;
          }
        }
        if (d) {
          syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
          var lin = revfl[l] & 31, din = revfd[d] & 31;
          eb += fleb[lin] + fdeb[din];
          ++lf[257 + lin];
          ++df[din];
          wi = i + l;
          ++lc_1;
        } else {
          syms[li++] = dat[i];
          ++lf[dat[i]];
        }
      }
    }
    for (i = Math.max(i, wi); i < s; ++i) {
      syms[li++] = dat[i];
      ++lf[dat[i]];
    }
    pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
    if (!lst) {
      st.r = pos & 7 | w[pos / 8 | 0] << 3;
      pos -= 7;
      st.h = head, st.p = prev, st.i = i, st.w = wi;
    }
  } else {
    for (var i = st.w || 0; i < s + lst; i += 65535) {
      var e = i + 65535;
      if (e >= s) {
        w[pos / 8 | 0] = lst;
        e = s;
      }
      pos = wfblk(w, pos + 1, dat.subarray(i, e));
    }
    st.i = s;
  }
  return slc(o, 0, pre + shft(pos) + post);
};
var crct = /* @__PURE__ */ (function() {
  var t = new Int32Array(256);
  for (var i = 0; i < 256; ++i) {
    var c = i, k = 9;
    while (--k)
      c = (c & 1 && -306674912) ^ c >>> 1;
    t[i] = c;
  }
  return t;
})();
var crc = function() {
  var c = -1;
  return {
    p: function(d) {
      var cr = c;
      for (var i = 0; i < d.length; ++i)
        cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
      c = cr;
    },
    d: function() {
      return ~c;
    }
  };
};
var adler = function() {
  var a = 1, b = 0;
  return {
    p: function(d) {
      var n = a, m = b;
      var l = d.length | 0;
      for (var i = 0; i != l; ) {
        var e = Math.min(i + 2655, l);
        for (; i < e; ++i)
          m += n += d[i];
        n = (n & 65535) + 15 * (n >> 16), m = (m & 65535) + 15 * (m >> 16);
      }
      a = n, b = m;
    },
    d: function() {
      a %= 65521, b %= 65521;
      return (a & 255) << 24 | (a & 65280) << 8 | (b & 255) << 8 | b >> 8;
    }
  };
};
var dopt = function(dat, opt, pre, post, st) {
  if (!st) {
    st = { l: 1 };
    if (opt.dictionary) {
      var dict = opt.dictionary.subarray(-32768);
      var newDat = new u8(dict.length + dat.length);
      newDat.set(dict);
      newDat.set(dat, dict.length);
      dat = newDat;
      st.w = dict.length;
    }
  }
  return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
};
var mrg = function(a, b) {
  var o = {};
  for (var k in a)
    o[k] = a[k];
  for (var k in b)
    o[k] = b[k];
  return o;
};
var wcln = function(fn, fnStr, td2) {
  var dt = fn();
  var st = fn.toString();
  var ks = st.slice(st.indexOf("[") + 1, st.lastIndexOf("]")).replace(/\s+/g, "").split(",");
  for (var i = 0; i < dt.length; ++i) {
    var v = dt[i], k = ks[i];
    if (typeof v == "function") {
      fnStr += ";" + k + "=";
      var st_1 = v.toString();
      if (v.prototype) {
        if (st_1.indexOf("[native code]") != -1) {
          var spInd = st_1.indexOf(" ", 8) + 1;
          fnStr += st_1.slice(spInd, st_1.indexOf("(", spInd));
        } else {
          fnStr += st_1;
          for (var t in v.prototype)
            fnStr += ";" + k + ".prototype." + t + "=" + v.prototype[t].toString();
        }
      } else
        fnStr += st_1;
    } else
      td2[k] = v;
  }
  return fnStr;
};
var ch = [];
var cbfs = function(v) {
  var tl = [];
  for (var k in v) {
    if (v[k].buffer) {
      tl.push((v[k] = new v[k].constructor(v[k])).buffer);
    }
  }
  return tl;
};
var wrkr = function(fns, init, id, cb) {
  if (!ch[id]) {
    var fnStr = "", td_1 = {}, m = fns.length - 1;
    for (var i = 0; i < m; ++i)
      fnStr = wcln(fns[i], fnStr, td_1);
    ch[id] = { c: wcln(fns[m], fnStr, td_1), e: td_1 };
  }
  var td2 = mrg({}, ch[id].e);
  return wk(ch[id].c + ";onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage=" + init.toString() + "}", id, td2, cbfs(td2), cb);
};
var bInflt = function() {
  return [u8, u16, i32, fleb, fdeb, clim, fl, fd, flrm, fdrm, rev, ec, hMap, max, bits, bits16, shft, slc, err, inflt, inflateSync, pbf, gopt];
};
var bDflt = function() {
  return [u8, u16, i32, fleb, fdeb, clim, revfl, revfd, flm, flt, fdm, fdt, rev, deo, et, hMap, wbits, wbits16, hTree, ln, lc, clen, wfblk, wblk, shft, slc, dflt, dopt, deflateSync, pbf];
};
var gze = function() {
  return [gzh, gzhl, wbytes, crc, crct];
};
var guze = function() {
  return [gzs, gzl];
};
var zle = function() {
  return [zlh, wbytes, adler];
};
var zule = function() {
  return [zls];
};
var pbf = function(msg) {
  return postMessage(msg, [msg.buffer]);
};
var gopt = function(o) {
  return o && {
    out: o.size && new u8(o.size),
    dictionary: o.dictionary
  };
};
var cbify = function(dat, opts, fns, init, id, cb) {
  var w = wrkr(fns, init, id, function(err2, dat2) {
    w.terminate();
    cb(err2, dat2);
  });
  w.postMessage([dat, opts], opts.consume ? [dat.buffer] : []);
  return function() {
    w.terminate();
  };
};
var astrm = function(strm) {
  strm.ondata = function(dat, final) {
    return postMessage([dat, final], [dat.buffer]);
  };
  return function(ev) {
    if (ev.data[0]) {
      strm.push(ev.data[0], ev.data[1]);
      postMessage([ev.data[0].length]);
    } else
      strm.flush(ev.data[1]);
  };
};
var astrmify = function(fns, strm, opts, init, id, flush, ext) {
  var t;
  var w = wrkr(fns, init, id, function(err2, dat) {
    if (err2)
      w.terminate(), strm.ondata.call(strm, err2);
    else if (!Array.isArray(dat))
      ext(dat);
    else if (dat.length == 1) {
      strm.queuedSize -= dat[0];
      if (strm.ondrain)
        strm.ondrain(dat[0]);
    } else {
      if (dat[1])
        w.terminate();
      strm.ondata.call(strm, err2, dat[0], dat[1]);
    }
  });
  w.postMessage(opts);
  strm.queuedSize = 0;
  strm.push = function(d, f) {
    if (!strm.ondata)
      err(5);
    if (t)
      strm.ondata(err(4, 0, 1), null, !!f);
    strm.queuedSize += d.length;
    w.postMessage([d, t = f], d.buffer instanceof ArrayBuffer ? [d.buffer] : []);
  };
  strm.terminate = function() {
    w.terminate();
  };
  if (flush) {
    strm.flush = function(sync) {
      w.postMessage([0, sync]);
    };
  }
};
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
var wbytes = function(d, b, v) {
  for (; v; ++b)
    d[b] = v, v >>>= 8;
};
var gzh = function(c, o) {
  var fn = o.filename;
  c[0] = 31, c[1] = 139, c[2] = 8, c[8] = o.level < 2 ? 4 : o.level == 9 ? 2 : 0, c[9] = 3;
  if (o.mtime != 0)
    wbytes(c, 4, Math.floor(new Date(o.mtime || Date.now()) / 1e3));
  if (fn) {
    c[3] = 8;
    for (var i = 0; i <= fn.length; ++i)
      c[i + 10] = fn.charCodeAt(i);
  }
};
var gzs = function(d) {
  if (d[0] != 31 || d[1] != 139 || d[2] != 8)
    err(6, "invalid gzip data");
  var flg = d[3];
  var st = 10;
  if (flg & 4)
    st += (d[10] | d[11] << 8) + 2;
  for (var zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++])
    ;
  return st + (flg & 2);
};
var gzl = function(d) {
  var l = d.length;
  return (d[l - 4] | d[l - 3] << 8 | d[l - 2] << 16 | d[l - 1] << 24) >>> 0;
};
var gzhl = function(o) {
  return 10 + (o.filename ? o.filename.length + 1 : 0);
};
var zlh = function(c, o) {
  var lv = o.level, fl2 = lv == 0 ? 0 : lv < 6 ? 1 : lv == 9 ? 3 : 2;
  c[0] = 120, c[1] = fl2 << 6 | (o.dictionary && 32);
  c[1] |= 31 - (c[0] << 8 | c[1]) % 31;
  if (o.dictionary) {
    var h = adler();
    h.p(o.dictionary);
    wbytes(c, 2, h.d());
  }
};
var zls = function(d, dict) {
  if ((d[0] & 15) != 8 || d[0] >> 4 > 7 || (d[0] << 8 | d[1]) % 31)
    err(6, "invalid zlib data");
  if ((d[1] >> 5 & 1) == +!dict)
    err(6, "invalid zlib data: " + (d[1] & 32 ? "need" : "unexpected") + " dictionary");
  return (d[1] >> 3 & 4) + 2;
};
function StrmOpt(opts, cb) {
  if (typeof opts == "function")
    cb = opts, opts = {};
  this.ondata = cb;
  return opts;
}
var Deflate = /* @__PURE__ */ (function() {
  function Deflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    this.o = opts || {};
    this.s = { l: 0, i: 32768, w: 32768, z: 32768 };
    this.b = new u8(98304);
    if (this.o.dictionary) {
      var dict = this.o.dictionary.subarray(-32768);
      this.b.set(dict, 32768 - dict.length);
      this.s.i = 32768 - dict.length;
    }
  }
  Deflate2.prototype.p = function(c, f) {
    this.ondata(dopt(c, this.o, 0, 0, this.s), f);
  };
  Deflate2.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    if (this.s.l)
      err(4);
    var endLen = chunk.length + this.s.z;
    if (endLen > this.b.length) {
      if (endLen > 2 * this.b.length - 32768) {
        var newBuf = new u8(endLen & -32768);
        newBuf.set(this.b.subarray(0, this.s.z));
        this.b = newBuf;
      }
      var split = this.b.length - this.s.z;
      this.b.set(chunk.subarray(0, split), this.s.z);
      this.s.z = this.b.length;
      this.p(this.b, false);
      this.b.set(this.b.subarray(-32768));
      this.b.set(chunk.subarray(split), 32768);
      this.s.z = chunk.length - split + 32768;
      this.s.i = 32766, this.s.w = 32768;
    } else {
      this.b.set(chunk, this.s.z);
      this.s.z += chunk.length;
    }
    this.s.l = final & 1;
    if (this.s.z > this.s.w + 8191 || final) {
      this.p(this.b, final || false);
      this.s.w = this.s.i, this.s.i -= 2;
    }
    if (final) {
      this.s = this.o = {};
      this.b = et;
    }
  };
  Deflate2.prototype.flush = function(sync) {
    if (!this.ondata)
      err(5);
    if (this.s.l)
      err(4);
    this.p(this.b, false);
    this.s.w = this.s.i, this.s.i -= 2;
    if (sync) {
      var c = new u8(6);
      c[0] = this.s.r >> 3;
      var ep = wfblk(c, this.s.r, et);
      this.s.r = 0;
      this.ondata(c.subarray(0, ep >> 3), false);
    }
  };
  return Deflate2;
})();
var AsyncDeflate = /* @__PURE__ */ (function() {
  function AsyncDeflate2(opts, cb) {
    astrmify([
      bDflt,
      function() {
        return [astrm, Deflate];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Deflate(ev.data);
      onmessage = astrm(strm);
    }, 6, 1);
  }
  return AsyncDeflate2;
})();
function deflate(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bDflt
  ], function(ev) {
    return pbf(deflateSync(ev.data[0], ev.data[1]));
  }, 0, cb);
}
function deflateSync(data, opts) {
  return dopt(data, opts || {}, 0, 0);
}
var Inflate = /* @__PURE__ */ (function() {
  function Inflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
    this.s = { i: 0, b: dict ? dict.length : 0 };
    this.o = new u8(32768);
    this.p = new u8(0);
    if (dict)
      this.o.set(dict);
  }
  Inflate2.prototype.e = function(c) {
    if (!this.ondata)
      err(5);
    if (this.d)
      err(4);
    if (!this.p.length)
      this.p = c;
    else if (c.length) {
      var n = new u8(this.p.length + c.length);
      n.set(this.p), n.set(c, this.p.length), this.p = n;
    }
  };
  Inflate2.prototype.c = function(final) {
    this.s.i = +(this.d = final || false);
    var bts = this.s.b;
    var dt = inflt(this.p, this.s, this.o);
    this.ondata(slc(dt, bts, this.s.b), this.d);
    this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
    this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
  };
  Inflate2.prototype.push = function(chunk, final) {
    this.e(chunk), this.c(final);
  };
  return Inflate2;
})();
var AsyncInflate = /* @__PURE__ */ (function() {
  function AsyncInflate2(opts, cb) {
    astrmify([
      bInflt,
      function() {
        return [astrm, Inflate];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Inflate(ev.data);
      onmessage = astrm(strm);
    }, 7, 0);
  }
  return AsyncInflate2;
})();
function inflate(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bInflt
  ], function(ev) {
    return pbf(inflateSync(ev.data[0], gopt(ev.data[1])));
  }, 1, cb);
}
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var Gzip = /* @__PURE__ */ (function() {
  function Gzip2(opts, cb) {
    this.c = crc();
    this.l = 0;
    this.v = 1;
    Deflate.call(this, opts, cb);
  }
  Gzip2.prototype.push = function(chunk, final) {
    this.c.p(chunk);
    this.l += chunk.length;
    Deflate.prototype.push.call(this, chunk, final);
  };
  Gzip2.prototype.p = function(c, f) {
    var raw = dopt(c, this.o, this.v && gzhl(this.o), f && 8, this.s);
    if (this.v)
      gzh(raw, this.o), this.v = 0;
    if (f)
      wbytes(raw, raw.length - 8, this.c.d()), wbytes(raw, raw.length - 4, this.l);
    this.ondata(raw, f);
  };
  Gzip2.prototype.flush = function(sync) {
    Deflate.prototype.flush.call(this, sync);
  };
  return Gzip2;
})();
var AsyncGzip = /* @__PURE__ */ (function() {
  function AsyncGzip2(opts, cb) {
    astrmify([
      bDflt,
      gze,
      function() {
        return [astrm, Deflate, Gzip];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Gzip(ev.data);
      onmessage = astrm(strm);
    }, 8, 1);
  }
  return AsyncGzip2;
})();
function gzip(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bDflt,
    gze,
    function() {
      return [gzipSync];
    }
  ], function(ev) {
    return pbf(gzipSync(ev.data[0], ev.data[1]));
  }, 2, cb);
}
function gzipSync(data, opts) {
  if (!opts)
    opts = {};
  var c = crc(), l = data.length;
  c.p(data);
  var d = dopt(data, opts, gzhl(opts), 8), s = d.length;
  return gzh(d, opts), wbytes(d, s - 8, c.d()), wbytes(d, s - 4, l), d;
}
var Gunzip = /* @__PURE__ */ (function() {
  function Gunzip2(opts, cb) {
    this.v = 1;
    this.r = 0;
    Inflate.call(this, opts, cb);
  }
  Gunzip2.prototype.push = function(chunk, final) {
    Inflate.prototype.e.call(this, chunk);
    this.r += chunk.length;
    if (this.v) {
      var p = this.p.subarray(this.v - 1);
      var s = p.length > 3 ? gzs(p) : 4;
      if (s > p.length) {
        if (!final)
          return;
      } else if (this.v > 1 && this.onmember) {
        this.onmember(this.r - p.length);
      }
      this.p = p.subarray(s), this.v = 0;
    }
    Inflate.prototype.c.call(this, 0);
    if (this.s.f && !this.s.l) {
      this.v = shft(this.s.p) + 9;
      this.s = { i: 0 };
      this.o = new u8(0);
      this.push(new u8(0), final);
    } else if (final) {
      Inflate.prototype.c.call(this, final);
    }
  };
  return Gunzip2;
})();
var AsyncGunzip = /* @__PURE__ */ (function() {
  function AsyncGunzip2(opts, cb) {
    var _this = this;
    astrmify([
      bInflt,
      guze,
      function() {
        return [astrm, Inflate, Gunzip];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Gunzip(ev.data);
      strm.onmember = function(offset) {
        return postMessage(offset);
      };
      onmessage = astrm(strm);
    }, 9, 0, function(offset) {
      return _this.onmember && _this.onmember(offset);
    });
  }
  return AsyncGunzip2;
})();
function gunzip(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bInflt,
    guze,
    function() {
      return [gunzipSync];
    }
  ], function(ev) {
    return pbf(gunzipSync(ev.data[0], ev.data[1]));
  }, 3, cb);
}
function gunzipSync(data, opts) {
  var st = gzs(data);
  if (st + 8 > data.length)
    err(6, "invalid gzip data");
  return inflt(data.subarray(st, -8), { i: 2 }, opts && opts.out || new u8(gzl(data)), opts && opts.dictionary);
}
var Zlib = /* @__PURE__ */ (function() {
  function Zlib2(opts, cb) {
    this.c = adler();
    this.v = 1;
    Deflate.call(this, opts, cb);
  }
  Zlib2.prototype.push = function(chunk, final) {
    this.c.p(chunk);
    Deflate.prototype.push.call(this, chunk, final);
  };
  Zlib2.prototype.p = function(c, f) {
    var raw = dopt(c, this.o, this.v && (this.o.dictionary ? 6 : 2), f && 4, this.s);
    if (this.v)
      zlh(raw, this.o), this.v = 0;
    if (f)
      wbytes(raw, raw.length - 4, this.c.d());
    this.ondata(raw, f);
  };
  Zlib2.prototype.flush = function(sync) {
    Deflate.prototype.flush.call(this, sync);
  };
  return Zlib2;
})();
var AsyncZlib = /* @__PURE__ */ (function() {
  function AsyncZlib2(opts, cb) {
    astrmify([
      bDflt,
      zle,
      function() {
        return [astrm, Deflate, Zlib];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Zlib(ev.data);
      onmessage = astrm(strm);
    }, 10, 1);
  }
  return AsyncZlib2;
})();
function zlib(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bDflt,
    zle,
    function() {
      return [zlibSync];
    }
  ], function(ev) {
    return pbf(zlibSync(ev.data[0], ev.data[1]));
  }, 4, cb);
}
function zlibSync(data, opts) {
  if (!opts)
    opts = {};
  var a = adler();
  a.p(data);
  var d = dopt(data, opts, opts.dictionary ? 6 : 2, 4);
  return zlh(d, opts), wbytes(d, d.length - 4, a.d()), d;
}
var Unzlib = /* @__PURE__ */ (function() {
  function Unzlib2(opts, cb) {
    Inflate.call(this, opts, cb);
    this.v = opts && opts.dictionary ? 2 : 1;
  }
  Unzlib2.prototype.push = function(chunk, final) {
    Inflate.prototype.e.call(this, chunk);
    if (this.v) {
      if (this.p.length < 6 && !final)
        return;
      this.p = this.p.subarray(zls(this.p, this.v - 1)), this.v = 0;
    }
    if (final) {
      if (this.p.length < 4)
        err(6, "invalid zlib data");
      this.p = this.p.subarray(0, -4);
    }
    Inflate.prototype.c.call(this, final);
  };
  return Unzlib2;
})();
var AsyncUnzlib = /* @__PURE__ */ (function() {
  function AsyncUnzlib2(opts, cb) {
    astrmify([
      bInflt,
      zule,
      function() {
        return [astrm, Inflate, Unzlib];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Unzlib(ev.data);
      onmessage = astrm(strm);
    }, 11, 0);
  }
  return AsyncUnzlib2;
})();
function unzlib(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bInflt,
    zule,
    function() {
      return [unzlibSync];
    }
  ], function(ev) {
    return pbf(unzlibSync(ev.data[0], gopt(ev.data[1])));
  }, 5, cb);
}
function unzlibSync(data, opts) {
  return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var Decompress = /* @__PURE__ */ (function() {
  function Decompress2(opts, cb) {
    this.o = StrmOpt.call(this, opts, cb) || {};
    this.G = Gunzip;
    this.I = Inflate;
    this.Z = Unzlib;
  }
  Decompress2.prototype.i = function() {
    var _this = this;
    this.s.ondata = function(dat, final) {
      _this.ondata(dat, final);
    };
  };
  Decompress2.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    if (!this.s) {
      if (this.p && this.p.length) {
        var n = new u8(this.p.length + chunk.length);
        n.set(this.p), n.set(chunk, this.p.length);
      } else
        this.p = chunk;
      if (this.p.length > 2) {
        this.s = this.p[0] == 31 && this.p[1] == 139 && this.p[2] == 8 ? new this.G(this.o) : (this.p[0] & 15) != 8 || this.p[0] >> 4 > 7 || (this.p[0] << 8 | this.p[1]) % 31 ? new this.I(this.o) : new this.Z(this.o);
        this.i();
        this.s.push(this.p, final);
        this.p = null;
      }
    } else
      this.s.push(chunk, final);
  };
  return Decompress2;
})();
var AsyncDecompress = /* @__PURE__ */ (function() {
  function AsyncDecompress2(opts, cb) {
    Decompress.call(this, opts, cb);
    this.queuedSize = 0;
    this.G = AsyncGunzip;
    this.I = AsyncInflate;
    this.Z = AsyncUnzlib;
  }
  AsyncDecompress2.prototype.i = function() {
    var _this = this;
    this.s.ondata = function(err2, dat, final) {
      _this.ondata(err2, dat, final);
    };
    this.s.ondrain = function(size) {
      _this.queuedSize -= size;
      if (_this.ondrain)
        _this.ondrain(size);
    };
  };
  AsyncDecompress2.prototype.push = function(chunk, final) {
    this.queuedSize += chunk.length;
    Decompress.prototype.push.call(this, chunk, final);
  };
  return AsyncDecompress2;
})();
function decompress(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return data[0] == 31 && data[1] == 139 && data[2] == 8 ? gunzip(data, opts, cb) : (data[0] & 15) != 8 || data[0] >> 4 > 7 || (data[0] << 8 | data[1]) % 31 ? inflate(data, opts, cb) : unzlib(data, opts, cb);
}
function decompressSync(data, opts) {
  return data[0] == 31 && data[1] == 139 && data[2] == 8 ? gunzipSync(data, opts) : (data[0] & 15) != 8 || data[0] >> 4 > 7 || (data[0] << 8 | data[1]) % 31 ? inflateSync(data, opts) : unzlibSync(data, opts);
}
var fltn = function(d, p, t, o) {
  for (var k in d) {
    var val = d[k], n = p + k, op = o;
    if (Array.isArray(val))
      op = mrg(o, val[1]), val = val[0];
    if (ArrayBuffer.isView(val))
      t[n] = [val, op];
    else {
      t[n += "/"] = [new u8(0), op];
      fltn(val, n, t, o);
    }
  }
};
var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i = 0; ; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
var DecodeUTF8 = /* @__PURE__ */ (function() {
  function DecodeUTF82(cb) {
    this.ondata = cb;
    if (tds)
      this.t = new TextDecoder();
    else
      this.p = et;
  }
  DecodeUTF82.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    final = !!final;
    if (this.t) {
      this.ondata(this.t.decode(chunk, { stream: true }), final);
      if (final) {
        if (this.t.decode().length)
          err(8);
        this.t = null;
      }
      return;
    }
    if (!this.p)
      err(4);
    var dat = new u8(this.p.length + chunk.length);
    dat.set(this.p);
    dat.set(chunk, this.p.length);
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (final) {
      if (r.length)
        err(8);
      this.p = null;
    } else
      this.p = r;
    this.ondata(s, final);
  };
  return DecodeUTF82;
})();
var EncodeUTF8 = /* @__PURE__ */ (function() {
  function EncodeUTF82(cb) {
    this.ondata = cb;
  }
  EncodeUTF82.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    if (this.d)
      err(4);
    this.ondata(strToU8(chunk), this.d = final || false);
  };
  return EncodeUTF82;
})();
function strToU8(str, latin1) {
  if (latin1) {
    var ar_1 = new u8(str.length);
    for (var i = 0; i < str.length; ++i)
      ar_1[i] = str.charCodeAt(i);
    return ar_1;
  }
  if (te)
    return te.encode(str);
  var l = str.length;
  var ar = new u8(str.length + (str.length >> 1));
  var ai = 0;
  var w = function(v) {
    ar[ai++] = v;
  };
  for (var i = 0; i < l; ++i) {
    if (ai + 5 > ar.length) {
      var n = new u8(ai + 8 + (l - i << 1));
      n.set(ar);
      ar = n;
    }
    var c = str.charCodeAt(i);
    if (c < 128 || latin1)
      w(c);
    else if (c < 2048)
      w(192 | c >> 6), w(128 | c & 63);
    else if (c > 55295 && c < 57344)
      c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
    else
      w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
  }
  return slc(ar, 0, ai);
}
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var dbf = function(l) {
  return l == 1 ? 3 : l < 6 ? 2 : l == 9 ? 1 : 0;
};
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
var exfl = function(ex) {
  var le = 0;
  if (ex) {
    for (var k in ex) {
      var l = ex[k].length;
      if (l > 65535)
        err(9);
      le += l + 4;
    }
  }
  return le;
};
var wzh = function(d, b, f, fn, u, c, ce, co) {
  var fl2 = fn.length, ex = f.extra, col = co && co.length;
  var exl = exfl(ex);
  wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
  if (ce != null)
    d[b++] = 20, d[b++] = f.os;
  d[b] = 20, b += 2;
  d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
  d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
  var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
  if (y < 0 || y > 119)
    err(10);
  wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
  if (c != -1) {
    wbytes(d, b, f.crc);
    wbytes(d, b + 4, c < 0 ? -c - 2 : c);
    wbytes(d, b + 8, f.size);
  }
  wbytes(d, b + 12, fl2);
  wbytes(d, b + 14, exl), b += 16;
  if (ce != null) {
    wbytes(d, b, col);
    wbytes(d, b + 6, f.attrs);
    wbytes(d, b + 10, ce), b += 14;
  }
  d.set(fn, b);
  b += fl2;
  if (exl) {
    for (var k in ex) {
      var exf = ex[k], l = exf.length;
      wbytes(d, b, +k);
      wbytes(d, b + 2, l);
      d.set(exf, b + 4), b += 4 + l;
    }
  }
  if (col)
    d.set(co, b), b += col;
  return b;
};
var wzf = function(o, b, c, d, e) {
  wbytes(o, b, 101010256);
  wbytes(o, b + 8, c);
  wbytes(o, b + 10, c);
  wbytes(o, b + 12, d);
  wbytes(o, b + 16, e);
};
var ZipPassThrough = /* @__PURE__ */ (function() {
  function ZipPassThrough2(filename) {
    this.filename = filename;
    this.c = crc();
    this.size = 0;
    this.compression = 0;
  }
  ZipPassThrough2.prototype.process = function(chunk, final) {
    this.ondata(null, chunk, final);
  };
  ZipPassThrough2.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    this.c.p(chunk);
    this.size += chunk.length;
    if (final)
      this.crc = this.c.d();
    this.process(chunk, final || false);
  };
  return ZipPassThrough2;
})();
var ZipDeflate = /* @__PURE__ */ (function() {
  function ZipDeflate2(filename, opts) {
    var _this = this;
    if (!opts)
      opts = {};
    ZipPassThrough.call(this, filename);
    this.d = new Deflate(opts, function(dat, final) {
      _this.ondata(null, dat, final);
    });
    this.compression = 8;
    this.flag = dbf(opts.level);
  }
  ZipDeflate2.prototype.process = function(chunk, final) {
    try {
      this.d.push(chunk, final);
    } catch (e) {
      this.ondata(e, null, final);
    }
  };
  ZipDeflate2.prototype.push = function(chunk, final) {
    ZipPassThrough.prototype.push.call(this, chunk, final);
  };
  return ZipDeflate2;
})();
var AsyncZipDeflate = /* @__PURE__ */ (function() {
  function AsyncZipDeflate2(filename, opts) {
    var _this = this;
    if (!opts)
      opts = {};
    ZipPassThrough.call(this, filename);
    this.d = new AsyncDeflate(opts, function(err2, dat, final) {
      _this.ondata(err2, dat, final);
    });
    this.compression = 8;
    this.flag = dbf(opts.level);
    this.terminate = this.d.terminate;
  }
  AsyncZipDeflate2.prototype.process = function(chunk, final) {
    this.d.push(chunk, final);
  };
  AsyncZipDeflate2.prototype.push = function(chunk, final) {
    ZipPassThrough.prototype.push.call(this, chunk, final);
  };
  return AsyncZipDeflate2;
})();
var Zip = /* @__PURE__ */ (function() {
  function Zip2(cb) {
    this.ondata = cb;
    this.u = [];
    this.d = 1;
  }
  Zip2.prototype.add = function(file) {
    var _this = this;
    if (!this.ondata)
      err(5);
    if (this.d & 2)
      this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, false);
    else {
      var f = strToU8(file.filename), fl_1 = f.length;
      var com = file.comment, o = com && strToU8(com);
      var u = fl_1 != file.filename.length || o && com.length != o.length;
      var hl_1 = fl_1 + exfl(file.extra) + 30;
      if (fl_1 > 65535)
        this.ondata(err(11, 0, 1), null, false);
      var header = new u8(hl_1);
      wzh(header, 0, file, f, u, -1);
      var chks_1 = [header];
      var pAll_1 = function() {
        for (var _i = 0, chks_2 = chks_1; _i < chks_2.length; _i++) {
          var chk = chks_2[_i];
          _this.ondata(null, chk, false);
        }
        chks_1 = [];
      };
      var tr_1 = this.d;
      this.d = 0;
      var ind_1 = this.u.length;
      var uf_1 = mrg(file, {
        f,
        u,
        o,
        t: function() {
          if (file.terminate)
            file.terminate();
        },
        r: function() {
          pAll_1();
          if (tr_1) {
            var nxt = _this.u[ind_1 + 1];
            if (nxt)
              nxt.r();
            else
              _this.d = 1;
          }
          tr_1 = 1;
        }
      });
      var cl_1 = 0;
      file.ondata = function(err2, dat, final) {
        if (err2) {
          _this.ondata(err2, dat, final);
          _this.terminate();
        } else {
          cl_1 += dat.length;
          chks_1.push(dat);
          if (final) {
            var dd = new u8(16);
            wbytes(dd, 0, 134695760);
            wbytes(dd, 4, file.crc);
            wbytes(dd, 8, cl_1);
            wbytes(dd, 12, file.size);
            chks_1.push(dd);
            uf_1.c = cl_1, uf_1.b = hl_1 + cl_1 + 16, uf_1.crc = file.crc, uf_1.size = file.size;
            if (tr_1)
              uf_1.r();
            tr_1 = 1;
          } else if (tr_1)
            pAll_1();
        }
      };
      this.u.push(uf_1);
    }
  };
  Zip2.prototype.end = function() {
    var _this = this;
    if (this.d & 2) {
      this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, true);
      return;
    }
    if (this.d)
      this.e();
    else
      this.u.push({
        r: function() {
          if (!(_this.d & 1))
            return;
          _this.u.splice(-1, 1);
          _this.e();
        },
        t: function() {
        }
      });
    this.d = 3;
  };
  Zip2.prototype.e = function() {
    var bt = 0, l = 0, tl = 0;
    for (var _i = 0, _a2 = this.u; _i < _a2.length; _i++) {
      var f = _a2[_i];
      tl += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0);
    }
    var out = new u8(tl + 22);
    for (var _b2 = 0, _c = this.u; _b2 < _c.length; _b2++) {
      var f = _c[_b2];
      wzh(out, bt, f, f.f, f.u, -f.c - 2, l, f.o);
      bt += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0), l += f.b;
    }
    wzf(out, bt, this.u.length, tl, l);
    this.ondata(null, out, true);
    this.d = 2;
  };
  Zip2.prototype.terminate = function() {
    for (var _i = 0, _a2 = this.u; _i < _a2.length; _i++) {
      var f = _a2[_i];
      f.t();
    }
    this.d = 2;
  };
  return Zip2;
})();
function zip(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  var r = {};
  fltn(data, "", r, opts);
  var k = Object.keys(r);
  var lft = k.length, o = 0, tot = 0;
  var slft = lft, files = new Array(lft);
  var term = [];
  var tAll = function() {
    for (var i2 = 0; i2 < term.length; ++i2)
      term[i2]();
  };
  var cbd = function(a, b) {
    mt(function() {
      cb(a, b);
    });
  };
  mt(function() {
    cbd = cb;
  });
  var cbf = function() {
    var out = new u8(tot + 22), oe = o, cdl = tot - o;
    tot = 0;
    for (var i2 = 0; i2 < slft; ++i2) {
      var f = files[i2];
      try {
        var l = f.c.length;
        wzh(out, tot, f, f.f, f.u, l);
        var badd = 30 + f.f.length + exfl(f.extra);
        var loc = tot + badd;
        out.set(f.c, loc);
        wzh(out, o, f, f.f, f.u, l, tot, f.m), o += 16 + badd + (f.m ? f.m.length : 0), tot = loc + l;
      } catch (e) {
        return cbd(e, null);
      }
    }
    wzf(out, o, files.length, cdl, oe);
    cbd(null, out);
  };
  if (!lft)
    cbf();
  var _loop_1 = function(i2) {
    var fn = k[i2];
    var _a2 = r[fn], file = _a2[0], p = _a2[1];
    var c = crc(), size = file.length;
    c.p(file);
    var f = strToU8(fn), s = f.length;
    var com = p.comment, m = com && strToU8(com), ms = m && m.length;
    var exl = exfl(p.extra);
    var compression = p.level == 0 ? 0 : 8;
    var cbl = function(e, d) {
      if (e) {
        tAll();
        cbd(e, null);
      } else {
        var l = d.length;
        files[i2] = mrg(p, {
          size,
          crc: c.d(),
          c: d,
          f,
          m,
          u: s != fn.length || m && com.length != ms,
          compression
        });
        o += 30 + s + exl + l;
        tot += 76 + 2 * (s + exl) + (ms || 0) + l;
        if (!--lft)
          cbf();
      }
    };
    if (s > 65535)
      cbl(err(11, 0, 1), null);
    if (!compression)
      cbl(null, file);
    else if (size < 16e4) {
      try {
        cbl(null, deflateSync(file, p));
      } catch (e) {
        cbl(e, null);
      }
    } else
      term.push(deflate(file, p, cbl));
  };
  for (var i = 0; i < slft; ++i) {
    _loop_1(i);
  }
  return tAll;
}
function zipSync(data, opts) {
  if (!opts)
    opts = {};
  var r = {};
  var files = [];
  fltn(data, "", r, opts);
  var o = 0;
  var tot = 0;
  for (var fn in r) {
    var _a2 = r[fn], file = _a2[0], p = _a2[1];
    var compression = p.level == 0 ? 0 : 8;
    var f = strToU8(fn), s = f.length;
    var com = p.comment, m = com && strToU8(com), ms = m && m.length;
    var exl = exfl(p.extra);
    if (s > 65535)
      err(11);
    var d = compression ? deflateSync(file, p) : file, l = d.length;
    var c = crc();
    c.p(file);
    files.push(mrg(p, {
      size: file.length,
      crc: c.d(),
      c: d,
      f,
      m,
      u: s != fn.length || m && com.length != ms,
      o,
      compression
    }));
    o += 30 + s + exl + l;
    tot += 76 + 2 * (s + exl) + (ms || 0) + l;
  }
  var out = new u8(tot + 22), oe = o, cdl = tot - o;
  for (var i = 0; i < files.length; ++i) {
    var f = files[i];
    wzh(out, f.o, f, f.f, f.u, f.c.length);
    var badd = 30 + f.f.length + exfl(f.extra);
    out.set(f.c, f.o + badd);
    wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
  }
  wzf(out, o, files.length, cdl, oe);
  return out;
}
var UnzipPassThrough = /* @__PURE__ */ (function() {
  function UnzipPassThrough2() {
  }
  UnzipPassThrough2.prototype.push = function(chunk, final) {
    this.ondata(null, chunk, final);
  };
  UnzipPassThrough2.compression = 0;
  return UnzipPassThrough2;
})();
var UnzipInflate = /* @__PURE__ */ (function() {
  function UnzipInflate2() {
    var _this = this;
    this.i = new Inflate(function(dat, final) {
      _this.ondata(null, dat, final);
    });
  }
  UnzipInflate2.prototype.push = function(chunk, final) {
    try {
      this.i.push(chunk, final);
    } catch (e) {
      this.ondata(e, null, final);
    }
  };
  UnzipInflate2.compression = 8;
  return UnzipInflate2;
})();
var AsyncUnzipInflate = /* @__PURE__ */ (function() {
  function AsyncUnzipInflate2(_, sz) {
    var _this = this;
    if (sz < 32e4) {
      this.i = new Inflate(function(dat, final) {
        _this.ondata(null, dat, final);
      });
    } else {
      this.i = new AsyncInflate(function(err2, dat, final) {
        _this.ondata(err2, dat, final);
      });
      this.terminate = this.i.terminate;
    }
  }
  AsyncUnzipInflate2.prototype.push = function(chunk, final) {
    if (this.i.terminate)
      chunk = slc(chunk, 0);
    this.i.push(chunk, final);
  };
  AsyncUnzipInflate2.compression = 8;
  return AsyncUnzipInflate2;
})();
var Unzip = /* @__PURE__ */ (function() {
  function Unzip2(cb) {
    this.onfile = cb;
    this.k = [];
    this.o = {
      0: UnzipPassThrough
    };
    this.p = et;
  }
  Unzip2.prototype.push = function(chunk, final) {
    var _this = this;
    if (!this.onfile)
      err(5);
    if (!this.p)
      err(4);
    if (this.c > 0) {
      var len = Math.min(this.c, chunk.length);
      var toAdd = chunk.subarray(0, len);
      this.c -= len;
      if (this.d)
        this.d.push(toAdd, !this.c);
      else
        this.k[0].push(toAdd);
      chunk = chunk.subarray(len);
      if (chunk.length)
        return this.push(chunk, final);
    } else {
      var f = 0, i = 0, is = void 0, buf = void 0;
      if (!this.p.length)
        buf = chunk;
      else if (!chunk.length)
        buf = this.p;
      else {
        buf = new u8(this.p.length + chunk.length);
        buf.set(this.p), buf.set(chunk, this.p.length);
      }
      var l = buf.length, oc = this.c, add = oc && this.d;
      var _loop_2 = function() {
        var sig = b4(buf, i);
        if (sig == 67324752) {
          f = 1, is = i;
          this_1.d = null;
          this_1.c = 0;
          var bf = b2(buf, i + 6), cmp_1 = b2(buf, i + 8), u = bf & 2048, dd = bf & 8, fnl = b2(buf, i + 26), es = b2(buf, i + 28);
          if (l > i + 30 + fnl + es) {
            var chks_3 = [];
            this_1.k.unshift(chks_3);
            f = 2;
            var lsc = b4(buf, i + 18), lsu = b4(buf, i + 22);
            var fn_1 = strFromU8(buf.subarray(i + 30, i += 30 + fnl), !u);
            var _a2 = z64hs(buf, i, es, 2, lsc, lsu, 0), sc_1 = _a2[0], su_1 = _a2[1], z64 = _a2[3];
            if (dd)
              sc_1 = -1 - z64;
            i += es;
            this_1.c = sc_1;
            var d_1;
            var file_1 = {
              name: fn_1,
              compression: cmp_1,
              start: function() {
                if (!file_1.ondata)
                  err(5);
                if (!sc_1)
                  file_1.ondata(null, et, true);
                else {
                  var ctr = _this.o[cmp_1];
                  if (!ctr)
                    file_1.ondata(err(14, "unknown compression type " + cmp_1, 1), null, false);
                  d_1 = sc_1 < 0 ? new ctr(fn_1) : new ctr(fn_1, sc_1, su_1);
                  d_1.ondata = function(err2, dat3, final2) {
                    file_1.ondata(err2, dat3, final2);
                  };
                  for (var _i = 0, chks_4 = chks_3; _i < chks_4.length; _i++) {
                    var dat2 = chks_4[_i];
                    d_1.push(dat2, false);
                  }
                  if (_this.k[0] == chks_3 && _this.c)
                    _this.d = d_1;
                  else
                    d_1.push(et, true);
                }
              },
              terminate: function() {
                if (d_1 && d_1.terminate)
                  d_1.terminate();
              }
            };
            if (sc_1 >= 0)
              file_1.size = sc_1, file_1.originalSize = su_1;
            this_1.onfile(file_1);
          }
          return "break";
        } else if (oc) {
          if (sig == 134695760) {
            is = i += 12 + (oc == -2 && 8), f = 3, this_1.c = 0;
            return "break";
          } else if (sig == 33639248) {
            is = i -= 4, f = 3, this_1.c = 0;
            return "break";
          }
        }
      };
      var this_1 = this;
      for (; i < l - 4; ++i) {
        var state_1 = _loop_2();
        if (state_1 === "break")
          break;
      }
      this.p = et;
      if (oc < 0) {
        var dat = f ? buf.subarray(0, is - 12 - (oc == -2 && 8) - (b4(buf, is - 16) == 134695760 && 4)) : buf.subarray(0, i);
        if (add)
          add.push(dat, !!f);
        else
          this.k[+(f == 2)].push(dat);
      }
      if (f & 2)
        return this.push(buf.subarray(i), final);
      this.p = buf.subarray(i);
    }
    if (final) {
      if (this.c)
        err(13);
      this.p = null;
    }
  };
  Unzip2.prototype.register = function(decoder) {
    this.o[decoder.compression] = decoder;
  };
  return Unzip2;
})();
var mt = typeof queueMicrotask == "function" ? queueMicrotask : typeof setTimeout == "function" ? setTimeout : function(fn) {
  fn();
};
function unzip(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  var term = [];
  var tAll = function() {
    for (var i2 = 0; i2 < term.length; ++i2)
      term[i2]();
  };
  var files = {};
  var cbd = function(a, b) {
    mt(function() {
      cb(a, b);
    });
  };
  mt(function() {
    cbd = cb;
  });
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558) {
      cbd(err(13, 0, 1), null);
      return tAll;
    }
  }
  ;
  var lft = b2(data, e + 8);
  if (lft) {
    var c = lft;
    var o = b4(data, e + 16);
    var z = b4(data, e - 20) == 117853008;
    if (z) {
      var ze = b4(data, e - 12);
      z = b4(data, ze) == 101075792;
      if (z) {
        c = lft = b4(data, ze + 32);
        o = b4(data, ze + 48);
      }
    }
    var fltr = opts && opts.filter;
    var _loop_3 = function(i2) {
      var _a2 = zh(data, o, z), c_1 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
      o = no;
      var cbl = function(e2, d) {
        if (e2) {
          tAll();
          cbd(e2, null);
        } else {
          if (d)
            files[fn] = d;
          if (!--lft)
            cbd(null, files);
        }
      };
      if (!fltr || fltr({
        name: fn,
        size: sc,
        originalSize: su,
        compression: c_1
      })) {
        if (!c_1)
          cbl(null, slc(data, b, b + sc));
        else if (c_1 == 8) {
          var infl = data.subarray(b, b + sc);
          if (su < 524288 || sc > 0.8 * su) {
            try {
              cbl(null, inflateSync(infl, { out: new u8(su) }));
            } catch (e2) {
              cbl(e2, null);
            }
          } else
            term.push(inflate(infl, { size: su }, cbl));
        } else
          cbl(err(14, "unknown compression type " + c_1, 1), null);
      } else
        cbl(null, null);
    };
    for (var i = 0; i < c; ++i) {
      _loop_3(i);
    }
  } else
    cbd(null, {});
  return tAll;
}
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0; i < c; ++i) {
    var _a2 = zh(data, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// packages/harness-javascript/package.json
var package_default = {
  name: "@tracecode/harness-javascript",
  version: "0.9.0",
  description: "JavaScript and TypeScript runtime helpers and browser worker assets for TraceCode harness.",
  license: "AGPL-3.0-only",
  homepage: "https://tracecode.app",
  repository: {
    type: "git",
    url: "https://github.com/tracecodeapp/harness.git",
    directory: "packages/harness-javascript"
  },
  type: "module",
  main: "./dist/index.cjs",
  module: "./dist/index.js",
  types: "./dist/index.d.ts",
  files: [
    "dist",
    "workers",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md"
  ],
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs",
      default: "./dist/index.js"
    },
    "./project-node": {
      types: "./dist/project-node.d.ts",
      import: "./dist/project-node.js",
      require: "./dist/project-node.cjs",
      default: "./dist/project-node.js"
    },
    "./project-browser": {
      types: "./dist/project-browser.d.ts",
      import: "./dist/project-browser.js",
      require: "./dist/project-browser.cjs",
      default: "./dist/project-browser.js"
    },
    "./workers/*": "./workers/*",
    "./package.json": "./package.json"
  },
  sideEffects: false,
  dependencies: {
    "@datastructures-js/binary-search-tree": "5.4.0",
    "@datastructures-js/deque": "1.0.8",
    "@datastructures-js/graph": "5.3.1",
    "@datastructures-js/heap": "4.3.7",
    "@datastructures-js/linked-list": "6.1.4",
    "@datastructures-js/priority-queue": "6.3.5",
    "@datastructures-js/queue": "4.3.0",
    "@datastructures-js/set": "4.2.2",
    "@datastructures-js/stack": "3.1.6",
    "@datastructures-js/trie": "4.2.3",
    lodash: "4.17.21",
    typescript: "^5.0.0"
  }
};

// packages/harness-javascript/src/project-browser.ts
var AsyncFunction = Object.getPrototypeOf(async function noop() {
}).constructor;
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();
function moduleDefault(value) {
  return value.default;
}
var fflateRecord = browser_exports;
var fflate = typeof fflateRecord.gzipSync === "function" ? browser_exports : moduleDefault(browser_exports);
function normalizeProjectPath(path) {
  const cleaned = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/workspace\//, "");
  const parts = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}
function workspacePathInputToString(path) {
  if (path instanceof URL) {
    if (path.protocol !== "file:") {
      throw new TypeError("The URL must be of scheme file");
    }
    return decodeURIComponent(path.pathname);
  }
  return String(path);
}
function runtimeWriteTarget(path, devices) {
  if (typeof path === "number") return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "proc-read-only", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelWriteTarget(raw, devices);
}
function runtimeMetadataTarget(path, devices) {
  if (typeof path === "number") return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "proc-read-only", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelMetadataTarget(raw, devices);
}
function runtimeAccessTarget(path, mode, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    return (mode & 2) !== 0 ? { kind: "denied", reason: "permission-denied", path: procPath } : { kind: "allowed", path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) {
    return (mode & 2) !== 0 ? { kind: "denied", reason: "permission-denied", path: readonlyPath } : { kind: "denied", reason: "not-found", path: readonlyPath };
  }
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelAccessTarget(raw, {
    read: (mode & 4) !== 0,
    write: (mode & 2) !== 0,
    execute: (mode & 1) !== 0
  }, devices);
}
function runtimeOpenTarget(path, request, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    if (procKind === "directory") return { kind: "error", reason: "is-directory", path: procPath };
    if (request?.writable || request?.create || request?.truncate || request?.exclusive) {
      return { kind: "error", reason: "read-only", path: procPath };
    }
    return { kind: "proc-file", path: procPath, readable: true, writable: false };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) {
    return request?.writable || request?.create || request?.truncate || request?.exclusive ? { kind: "error", reason: "read-only", path: readonlyPath } : { kind: "error", reason: "not-found", path: readonlyPath };
  }
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelOpenTarget(raw, request, devices);
}
function runtimeReadTarget(path, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    return procKind === "file" ? { kind: "proc-file", path: procPath } : { kind: "proc-directory", path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "not-found", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelReadTarget(raw, devices);
}
function runtimeFileReadTarget(path, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    return procKind === "file" ? { kind: "proc-file", path: procPath } : { kind: "error", reason: "is-directory", path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "not-found", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelFileReadTarget(raw, devices);
}
function runtimeCopyTarget(source, destination, devices, procSnapshot) {
  if (typeof source === "number" || typeof destination === "number") return null;
  const sourceKind = browserProcEntryKind(procSnapshot, source);
  const destinationReadonlyPath = browserReadonlyKernelNamespacePath(destination);
  if (sourceKind === "file" || destinationReadonlyPath) return { kind: "file-copy" };
  if (sourceKind === "directory") return { kind: "error", reason: "source-directory", path: normalizeBrowserProcPath(source) ?? String(source) };
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelCopyTarget(sourceRaw, destinationRaw, devices);
}
function runtimeFileCopyTarget(source, destination, devices, procSnapshot) {
  if (typeof source === "number" || typeof destination === "number") return null;
  const destinationReadonlyPath = browserReadonlyKernelNamespacePath(destination);
  if (destinationReadonlyPath) {
    return { kind: "error", side: "destination", reason: "proc-read-only", path: destinationReadonlyPath };
  }
  const sourceKind = browserProcEntryKind(procSnapshot, source);
  if (sourceKind) {
    const sourcePath = normalizeBrowserProcPath(source) ?? String(source);
    if (sourceKind === "directory") {
      return { kind: "error", side: "source", reason: "is-directory", path: sourcePath };
    }
    const writeTarget = runtimeWriteTarget(destination, devices);
    if (writeTarget?.kind === "error") {
      return { kind: "error", side: "destination", reason: writeTarget.reason, path: writeTarget.path };
    }
    if (writeTarget?.kind === "device") {
      return {
        kind: "device-destination",
        device: writeTarget.device,
        outputDevice: writeTarget.outputDevice,
        source: { kind: "proc-file", path: sourcePath }
      };
    }
    return { kind: "virtual-source", source: { kind: "proc-file", path: sourcePath } };
  }
  const sourceReadonlyPath = browserReadonlyKernelNamespacePath(source);
  if (sourceReadonlyPath) {
    return { kind: "error", side: "source", reason: "not-found", path: sourceReadonlyPath };
  }
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelFileCopyTarget(sourceRaw, destinationRaw, devices);
}
function runtimeLinkTarget(source, destination, devices) {
  if (typeof source === "number" || typeof destination === "number") return null;
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelLinkTarget(sourceRaw, destinationRaw, devices);
}
function runtimeRenameTarget(source, destination, devices) {
  if (typeof source === "number" || typeof destination === "number") return null;
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelRenameTarget(sourceRaw, destinationRaw, devices);
}
function runtimeSymlinkTarget(linkPath, devices) {
  if (typeof linkPath === "number") return null;
  const raw = workspacePathInputToString(linkPath).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelSymlinkTarget(raw, devices);
}
function runtimeRemoveTarget(path, devices) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelRemoveTarget(raw, devices);
}
function runtimeMkdirTarget(path, devices) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelMkdirTarget(raw, devices);
}
function runtimeTruncateTarget(path, devices) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelTruncateTarget(raw, devices);
}
function runtimeDirectoryTarget(path, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    return procKind === "directory" ? { kind: "directory", path: procPath, entries: [...procSnapshot?.directories.get(procPath) ?? []] } : { kind: "error", reason: "not-directory", path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "not-found", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelDirectoryTarget(raw, devices);
}
function runtimeStatTarget(path, info, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    const contents = procKind === "file" ? browserProcFileContents(procSnapshot, procPath, info) : "";
    return {
      kind: "stat",
      path: procPath,
      stat: {
        isFile: procKind === "file",
        isDirectory: procKind === "directory",
        isCharacterDevice: false,
        mode: procKind === "directory" ? 365 : 292,
        size: textEncoder.encode(contents).byteLength
      }
    };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "not-found", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelStatTarget(raw, info, devices);
}
function throwRuntimeWriteTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelWriteErrorCode(target.reason) });
}
function throwRuntimeMetadataTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelMetadataErrorCode(target.reason) });
}
function throwRuntimeReadTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelFileReadErrorCode(target.reason) });
}
function throwRuntimeLinkTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelLinkErrorCode(target.reason) });
}
function throwRuntimeRenameTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelRenameErrorCode(target.reason) });
}
function throwRuntimeSymlinkTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelSymlinkErrorCode(target.reason) });
}
function throwRuntimeRemoveTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelRemoveErrorCode(target.reason) });
}
function throwRuntimeMkdirTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelMkdirErrorCode(target.reason) });
}
function throwRuntimeTruncateTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelTruncateErrorCode(target.reason) });
}
function throwRuntimeDirectoryTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelDirectoryErrorCode(target.reason) });
}
function normalizeAbsoluteWorkspaceRoot(path) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.startsWith("/") ? normalized || "/" : `/${normalized}`;
}
function createWorkspacePathContext(project) {
  return {
    root: normalizeAbsoluteWorkspaceRoot(project.workspaceRoot ?? project.cwd ?? "/workspace"),
    ...project.workspaceAlias ? { alias: normalizeAbsoluteWorkspaceRoot(project.workspaceAlias) } : {}
  };
}
function fallbackKernelInfo(project, workspace) {
  const root = workspace.root;
  const parts = root.split("/").filter(Boolean);
  const workspaceName = parts.at(-1) ?? "workspace";
  const username = parts.length >= 2 && parts[0] === "home" ? parts[1] ?? "user" : "user";
  const home = parts.length >= 2 && parts[0] === "home" ? `/${parts.slice(0, 2).join("/")}` : dirname(root) || root;
  const startedAt = (/* @__PURE__ */ new Date(0)).toISOString();
  return {
    name: "tracekernel",
    version: package_default.version,
    user: {
      id: username,
      username,
      home
    },
    host: {
      hostname: "tracevm",
      osName: "tracecode"
    },
    workspace: {
      id: `${workspaceName}-${startedAt.replace(/[:.]/g, "-")}`,
      name: workspaceName,
      root,
      startedAt
    },
    home,
    cwd: project.cwd ?? root,
    workspaceRoot: root,
    ...workspace.alias ? { workspaceAlias: workspace.alias } : {}
  };
}
function normalizeBrowserProcPath(path) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return raw === "/proc" || raw.startsWith("/proc/") || raw === "/skills" || raw.startsWith("/skills/") ? raw : null;
}
function browserReadonlyKernelNamespacePath(path) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return raw === "/skills" || raw.startsWith("/skills/") ? raw : null;
}
function createBrowserProcSnapshot(kernelFiles) {
  const files = /* @__PURE__ */ new Map();
  const directoryEntries = /* @__PURE__ */ new Map();
  const ensureDirectory = (path) => {
    if (!directoryEntries.has(path)) directoryEntries.set(path, /* @__PURE__ */ new Map());
    if (path === "/") return;
    const parent = dirname(path);
    if (parent && parent !== path) {
      ensureDirectory(parent);
      const name = path.slice(parent === "/" ? 1 : parent.length + 1);
      directoryEntries.get(parent)?.set(name, { name, kind: "directory" });
    }
  };
  const addFile = (path, contents) => {
    const normalized = normalizeBrowserProcPath(path);
    if (!normalized) return;
    files.set(normalized, contents);
    const parent = dirname(normalized);
    ensureDirectory(parent);
    const name = normalized.slice(parent === "/" ? 1 : parent.length + 1);
    directoryEntries.get(parent)?.set(name, { name, kind: "file" });
  };
  ensureDirectory("/skills");
  for (const file of kernelFiles ?? []) addFile(file.path, file.contents);
  const directories = /* @__PURE__ */ new Map();
  for (const [path, entries] of directoryEntries) {
    if (path === "/" || !(path === "/proc" || path.startsWith("/proc/") || path === "/skills" || path.startsWith("/skills/"))) continue;
    directories.set(path, [...entries.values()].sort((left, right) => left.name.localeCompare(right.name)));
  }
  return { files, directories };
}
function browserProcEntryKind(snapshot, path) {
  const normalized = normalizeBrowserProcPath(path);
  if (!normalized || !snapshot) return null;
  if (snapshot.files.has(normalized)) return "file";
  if (snapshot.directories.has(normalized)) return "directory";
  return null;
}
function browserProcFileContents(snapshot, path, info) {
  const contents = snapshot?.files.get(path);
  return contents !== void 0 ? contents : readRuntimeProcFile(path, info);
}
function workspaceRelativeFromAbsolutePath(rawPath, workspace) {
  const raw = normalizeAbsoluteWorkspaceRoot(rawPath);
  if (raw === workspace.root) return "";
  if (raw.startsWith(`${workspace.root}/`)) return raw.slice(workspace.root.length + 1);
  if (workspace.alias && raw === workspace.alias) return "";
  if (workspace.alias && raw.startsWith(`${workspace.alias}/`)) return raw.slice(workspace.alias.length + 1);
  return null;
}
function normalizeWorkspaceEntryPath(path, basePath = "", allowRoot = false, workspace = { root: "/workspace" }) {
  const rawInput = workspacePathInputToString(path);
  const raw = rawInput.replace(/\\/g, "/");
  const workspaceRelative = raw.startsWith("/") ? workspaceRelativeFromAbsolutePath(raw, workspace) : null;
  const withBase = workspaceRelative !== null ? workspaceRelative : raw.startsWith("/") ? raw : basePath ? `${basePath}/${raw}` : raw;
  const cleaned = withBase.replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.startsWith("/") || /^[A-Za-z]:\//.test(cleaned)) {
    throw new Error(`Path must be inside workspace: ${rawInput}`);
  }
  const parts = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new Error(`Path must not escape workspace: ${rawInput}`);
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    if (allowRoot) return "";
    throw new Error(`Path must point to a file: ${rawInput}`);
  }
  return parts.join("/");
}
function assertSafeWorkspaceFilePath(path, basePath = "", workspace = { root: "/workspace" }) {
  return normalizeWorkspaceEntryPath(path, basePath, false, workspace);
}
function utf8Bytes(value) {
  return textEncoder.encode(value);
}
function base64ToBytes(value) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}
function bytesToBase64(value) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value).toString("base64");
  }
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}
function fileBytes(file) {
  return file.encoding === "base64" ? base64ToBytes(file.contents) : utf8Bytes(file.contents);
}
function byteEqual(left, right) {
  if (!left || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
function bytesToRuntimeFile(path, contents) {
  const text = textDecoder.decode(contents);
  if (byteEqual(utf8Bytes(text), contents)) {
    return { path, contents: text };
  }
  return { path, contents: bytesToBase64(contents), encoding: "base64" };
}
function bytesFromNodeValue(value) {
  if (typeof value === "string") return utf8Bytes(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value)) return new Uint8Array(value.map((item) => Number(item) & 255));
  return utf8Bytes(String(value));
}
function requestedEncodingFromOptions(options) {
  if (typeof options === "string") return options;
  return typeof options?.encoding === "string" ? options.encoding : void 0;
}
function bytesFromFsWriteValue(value, options) {
  const encoding = requestedEncodingFromOptions(options);
  if (typeof value === "string" && typeof encoding === "string") {
    return BrowserBuffer.from(value, encoding);
  }
  return bytesFromNodeValue(value);
}
function browserBufferFromBytes(value) {
  return BrowserBuffer.from(value);
}
function textFromBytes(bytes) {
  return textDecoder.decode(bytes);
}
function bytesToRuntimeHttpBody(bytes) {
  const text = textDecoder.decode(bytes);
  return byteEqual(utf8Bytes(text), bytes) ? { body: text } : { body: bytesToBase64(bytes), bodyEncoding: "base64" };
}
function bytesFromRuntimeHttpBody(message) {
  if (message.body === void 0) return new Uint8Array();
  return message.bodyEncoding === "base64" ? base64ToBytes(message.body) : utf8Bytes(message.body);
}
function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function bytesToHex(value) {
  return Array.from(value).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(value) {
  const normalized = value.trim();
  const bytes = new Uint8Array(Math.ceil(normalized.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2).padEnd(2, "0"), 16) & 255;
  }
  return bytes;
}
var BrowserBuffer = class _BrowserBuffer extends Uint8Array {
  static from(value, encodingOrMapfn, thisArg) {
    if (typeof value === "string") {
      const encoding = typeof encodingOrMapfn === "string" ? encodingOrMapfn : void 0;
      if (encoding === "base64") return new _BrowserBuffer(base64ToBytes(value));
      if (encoding === "hex") return new _BrowserBuffer(hexToBytes(value));
      if (encoding === "latin1" || encoding === "binary") {
        return new _BrowserBuffer(Array.from(value, (char) => char.charCodeAt(0) & 255));
      }
      return new _BrowserBuffer(utf8Bytes(value));
    }
    if (typeof encodingOrMapfn === "function" && value != null) {
      return new _BrowserBuffer(Array.from(value, encodingOrMapfn, thisArg));
    }
    return new _BrowserBuffer(bytesFromNodeValue(value));
  }
  static alloc(size, fill = 0) {
    const bytes = new _BrowserBuffer(Math.max(0, Number(size) || 0));
    bytes.fill(Number(fill) & 255);
    return bytes;
  }
  static isBuffer(value) {
    return value instanceof _BrowserBuffer;
  }
  static concat(values) {
    const totalLength = values.reduce((sum, value) => sum + value.byteLength, 0);
    const bytes = new _BrowserBuffer(totalLength);
    let offset = 0;
    for (const value of values) {
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return bytes;
  }
  static byteLength(value, encoding) {
    if (typeof value === "string") return _BrowserBuffer.from(value, encoding).byteLength;
    return bytesFromNodeValue(value).byteLength;
  }
  toString(encoding = "utf8") {
    if (encoding === "base64") return bytesToBase64(this);
    if (encoding === "hex") return bytesToHex(this);
    if (encoding === "latin1" || encoding === "binary") {
      return Array.from(this, (byte) => String.fromCharCode(byte)).join("");
    }
    return textFromBytes(this);
  }
};
function createZlibApi() {
  return {
    gzipSync: (input) => browserBufferFromBytes(fflate.gzipSync(bytesFromNodeValue(input))),
    gunzipSync: (input) => browserBufferFromBytes(fflate.gunzipSync(bytesFromNodeValue(input))),
    deflateSync: (input) => browserBufferFromBytes(fflate.deflateSync(bytesFromNodeValue(input))),
    inflateSync: (input) => browserBufferFromBytes(fflate.inflateSync(bytesFromNodeValue(input)))
  };
}
function createReadableStdinDevice(readBytes, remainingBytes, isClosed = () => true, schedulePoll = (callback, delay) => setTimeout(callback, delay)) {
  let encoding;
  let flowScheduled = false;
  let pollScheduled = false;
  let destroyed = false;
  let ended = false;
  let readableFlowing = null;
  const dataListeners = [];
  const endListeners = [];
  const formatChunk = (chunk) => encoding ? chunk.toString(encoding) : chunk;
  const read = (size) => {
    if (remainingBytes() <= 0) {
      ended = isClosed();
      return null;
    }
    const requested = typeof size === "number" && size >= 0 ? Math.floor(size) : void 0;
    const chunk = BrowserBuffer.from(readBytes(requested));
    if (remainingBytes() <= 0) ended = true;
    return formatChunk(chunk);
  };
  const scheduleFlow = () => {
    if (flowScheduled) return;
    if (readableFlowing === false) return;
    flowScheduled = true;
    queueMicrotask(() => {
      if (destroyed) return;
      const chunk = read();
      if (chunk !== null) {
        for (const listener of dataListeners) listener(chunk);
        if (ended) {
          for (const listener of endListeners) listener();
        } else {
          flowScheduled = false;
          scheduleFlow();
        }
        return;
      }
      if (!isClosed()) {
        flowScheduled = false;
        if (!pollScheduled) {
          pollScheduled = true;
          schedulePoll(() => {
            pollScheduled = false;
            scheduleFlow();
          }, 8);
        }
        return;
      }
      ended = true;
      for (const listener of endListeners) listener();
    });
  };
  const on = (event, listener) => {
    if (event === "data") {
      dataListeners.push(listener);
      if (readableFlowing === null) readableFlowing = true;
      scheduleFlow();
    } else if (event === "end") {
      endListeners.push(listener);
      scheduleFlow();
    }
    return stream;
  };
  const removeListener = (event, listener) => {
    const listeners = event === "data" ? dataListeners : event === "end" ? endListeners : null;
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    }
    return stream;
  };
  const stream = {
    fd: 0,
    readable: true,
    isTTY: false,
    get readableEnded() {
      return ended;
    },
    get readableEncoding() {
      return encoding ?? null;
    },
    get readableFlowing() {
      return readableFlowing;
    },
    get readableLength() {
      return Math.max(0, remainingBytes());
    },
    setEncoding: (nextEncoding) => {
      encoding = nextEncoding;
      return stream;
    },
    read,
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once: (event, listener) => {
      const wrapped = (chunk) => {
        removeListener(event, wrapped);
        listener(chunk);
      };
      return stream.on(event, wrapped);
    },
    destroy: () => {
      destroyed = true;
      return stream;
    },
    get destroyed() {
      return destroyed;
    },
    resume: () => {
      readableFlowing = true;
      scheduleFlow();
      return stream;
    },
    pause: () => {
      readableFlowing = false;
      return stream;
    },
    [Symbol.asyncIterator]: async function* () {
      const chunk = read();
      if (chunk !== null) yield chunk;
    }
  };
  return stream;
}
function createPathApi(getCwd, workspaceRoot) {
  const normalizePath = (value) => {
    const raw = String(value).replace(/\\/g, "/");
    const isAbsolute2 = raw.startsWith("/");
    const parts = [];
    for (const part of raw.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        const previous = parts[parts.length - 1];
        if (previous && previous !== "..") {
          parts.pop();
        } else if (!isAbsolute2) {
          parts.push("..");
        }
      } else {
        parts.push(part);
      }
    }
    const normalized = parts.join("/");
    if (isAbsolute2) return normalized ? `/${normalized}` : "/";
    return normalized || ".";
  };
  const cwdAbsolutePath = () => {
    const cwd = getCwd();
    return cwd ? `${workspaceRoot}/${cwd}` : workspaceRoot;
  };
  const isAbsolute = (path) => String(path).startsWith("/");
  const normalize = (path) => normalizePath(path);
  const join = (...parts) => normalizePath(parts.filter((part) => String(part).length > 0).join("/"));
  const resolve = (...parts) => {
    const rawParts = parts.map((part) => String(part)).filter((part) => part.length > 0);
    let resolved = "";
    for (let index = rawParts.length - 1; index >= 0; index -= 1) {
      resolved = resolved ? `${rawParts[index]}/${resolved}` : rawParts[index] ?? "";
      if (resolved.startsWith("/")) return normalizePath(resolved);
    }
    return normalizePath(`${cwdAbsolutePath()}/${resolved}`);
  };
  const dirnameApi = (path) => {
    const normalized = normalizePath(path);
    if (normalized === "/") return "/";
    const withoutTrailingSlash = normalized.replace(/\/+$/, "");
    const index = withoutTrailingSlash.lastIndexOf("/");
    if (index === -1) return ".";
    if (index === 0) return "/";
    return withoutTrailingSlash.slice(0, index);
  };
  const basename = (path, suffix) => {
    const normalized = normalizePath(path).replace(/\/+$/, "");
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  };
  const extname = (path) => {
    const base = basename(path);
    const index = base.lastIndexOf(".");
    if (index <= 0) return "";
    return base.slice(index);
  };
  const relative = (from, to) => {
    const fromParts = resolve(from).split("/").filter(Boolean);
    const toParts = resolve(to).split("/").filter(Boolean);
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
      common += 1;
    }
    return [
      ...fromParts.slice(common).map(() => ".."),
      ...toParts.slice(common)
    ].join("/") || "";
  };
  const parse = (path) => {
    const normalized = normalizePath(path);
    const root = normalized.startsWith("/") ? "/" : "";
    const dir = dirnameApi(normalized);
    const base = basename(normalized);
    const ext = extname(base);
    const name = ext ? base.slice(0, -ext.length) : base;
    return {
      root,
      dir: dir === "." ? "" : dir,
      base,
      ext,
      name
    };
  };
  const format = (pathObject) => {
    const dir = pathObject.dir || pathObject.root || "";
    const base = pathObject.base ?? `${pathObject.name ?? ""}${pathObject.ext ?? ""}`;
    if (!dir) return base;
    if (dir === "/") return `/${base}`;
    return `${dir}/${base}`;
  };
  const api = {
    sep: "/",
    delimiter: ":",
    normalize,
    join,
    resolve,
    dirname: dirnameApi,
    basename,
    extname,
    isAbsolute,
    relative,
    parse,
    format
  };
  return { ...api, posix: api };
}
function inferWorkspaceHome(workspaceRoot) {
  const parts = workspaceRoot.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "home") {
    return `/${parts.slice(0, 2).join("/")}`;
  }
  const parent = dirname(workspaceRoot);
  return parent || workspaceRoot;
}
function workspaceUsername(workspaceHome) {
  const parts = workspaceHome.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "browser";
}
function createOsApi(workspaceRoot) {
  const home = inferWorkspaceHome(workspaceRoot);
  return {
    EOL: "\n",
    arch: () => "wasm32",
    cpus: () => [],
    endianness: () => "LE",
    homedir: () => home,
    hostname: () => "tracevm",
    platform: () => "browser",
    release: () => "",
    tmpdir: () => "/tmp",
    type: () => "tracekernel",
    userInfo: () => ({
      username: workspaceUsername(home),
      uid: -1,
      gid: -1,
      shell: null,
      homedir: home
    })
  };
}
function createBrowserEventLoopApi(executionState) {
  let nextTimerId = 1;
  let pendingTimerWork = Promise.resolve();
  let timerError;
  const timers = /* @__PURE__ */ new Map();
  const recordTimerWork = (work) => {
    pendingTimerWork = Promise.allSettled([pendingTimerWork, work]).then(() => void 0);
  };
  const runTimerCallback = (callback, args) => {
    const work = Promise.resolve().then(() => callback(...args)).then(
      () => void 0,
      (error) => {
        timerError ??= error;
      }
    );
    recordTimerWork(work);
  };
  const setTrackedTimeout = (callback, delay, ...args) => {
    const id = nextTimerId++;
    const handle = globalThis.setTimeout(() => {
      timers.delete(id);
      if (executionState.cancelled) return;
      runTimerCallback(callback, args);
    }, Math.max(0, Number(delay) || 0));
    timers.set(id, { handle, interval: false });
    return id;
  };
  const clearTrackedTimeout = (id) => {
    if (typeof id !== "number") return;
    const timer = timers.get(id);
    if (!timer) return;
    globalThis.clearTimeout(timer.handle);
    timers.delete(id);
  };
  const setTrackedInterval = (callback, delay, ...args) => {
    const id = nextTimerId++;
    const run = () => {
      if (!timers.has(id) || executionState.cancelled) return;
      runTimerCallback(callback, args);
      const timer = timers.get(id);
      if (!timer) return;
      timer.handle = globalThis.setTimeout(run, Math.max(0, Number(delay) || 0));
    };
    const handle = globalThis.setTimeout(run, Math.max(0, Number(delay) || 0));
    timers.set(id, { handle, interval: true });
    return id;
  };
  const setTrackedImmediate = (callback, ...args) => setTrackedTimeout(callback, 0, ...args);
  const drain = async () => {
    while (!executionState.cancelled && timers.size > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      await pendingTimerWork;
      if (timerError !== void 0) throw timerError;
      if ([...timers.values()].some((timer) => timer.interval)) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      }
    }
    await pendingTimerWork;
    if (timerError !== void 0) throw timerError;
  };
  const clearAll = () => {
    for (const timer of timers.values()) {
      globalThis.clearTimeout(timer.handle);
    }
    timers.clear();
  };
  return {
    setTimeout: setTrackedTimeout,
    clearTimeout: clearTrackedTimeout,
    setInterval: setTrackedInterval,
    clearInterval: clearTrackedTimeout,
    setImmediate: setTrackedImmediate,
    clearImmediate: clearTrackedTimeout,
    queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
    drain,
    clearAll
  };
}
function createUrlApi() {
  return {
    URL,
    URLSearchParams,
    domainToASCII: (domain) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return "";
      }
    },
    domainToUnicode: (domain) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return "";
      }
    },
    fileURLToPath: (value) => {
      const url = value instanceof URL ? value : new URL(value);
      if (url.protocol !== "file:") {
        throw new TypeError("The URL must be of scheme file");
      }
      return decodeURIComponent(url.pathname);
    },
    pathToFileURL: (path) => new URL(`file://${path.startsWith("/") ? path : `/${path}`}`)
  };
}
function createListenerMap() {
  const listeners = /* @__PURE__ */ new Map();
  const on = (event, listener) => {
    const next = listeners.get(event) ?? [];
    next.push(listener);
    listeners.set(event, next);
    return api;
  };
  const removeListener = (event, listener) => {
    const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
    if (next.length === 0) listeners.delete(event);
    else listeners.set(event, next);
    return api;
  };
  const emit = (event, ...args) => {
    const current = listeners.get(event) ?? [];
    for (const listener of current) listener(...args);
    return current.length > 0;
  };
  const api = {
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once: (event, listener) => {
      const wrapped = (...args) => {
        removeListener(event, wrapped);
        listener(...args);
      };
      return on(event, wrapped);
    },
    emit
  };
  return api;
}
function createIncomingMessage(request) {
  const events = createListenerMap();
  let encoding;
  let bodyRead = false;
  let bodyScheduled = false;
  let readableEnded = false;
  const bodyBytes = bytesFromRuntimeHttpBody(request);
  const rawHeaders = request.rawHeaders ? request.rawHeaders.flatMap(([name, value]) => [name, value]) : Object.entries(request.headers ?? {}).flatMap(([name, value]) => [name, value]);
  const formatBody = () => encoding ? BrowserBuffer.from(bodyBytes).toString(encoding) : BrowserBuffer.from(bodyBytes);
  const scheduleBody = () => {
    if (bodyScheduled) return;
    bodyScheduled = true;
    queueMicrotask(() => {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        events.emit("data", formatBody());
      }
      readableEnded = true;
      events.emit("end");
    });
  };
  const message = {
    method: request.method,
    url: request.path,
    headers: request.headers ?? {},
    rawHeaders,
    signal: request.signal,
    httpVersion: "1.1",
    complete: true,
    get readableEnded() {
      return readableEnded;
    },
    socket: { remoteAddress: "127.0.0.1" },
    setEncoding: (nextEncoding) => {
      encoding = nextEncoding;
      return message;
    },
    read: () => {
      if (bodyRead) return null;
      bodyRead = true;
      readableEnded = true;
      return formatBody();
    },
    on: (event, listener) => {
      events.on(event, listener);
      if (event === "data" || event === "end") scheduleBody();
      return message;
    },
    addListener: (event, listener) => message.on(event, listener),
    once: (event, listener) => {
      events.once(event, listener);
      if (event === "data" || event === "end") scheduleBody();
      return message;
    },
    removeListener: events.removeListener,
    off: events.removeListener,
    [Symbol.asyncIterator]: async function* () {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        readableEnded = true;
        yield formatBody();
      }
    }
  };
  return message;
}
function createServerResponse(resolve) {
  const events = createListenerMap();
  const headers = {};
  const headerEntries = /* @__PURE__ */ new Map();
  const chunks = [];
  let ended = false;
  const setHeaderValue = (name, value) => {
    const key = String(name).toLowerCase();
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const text = values.join(", ");
    headers[key] = text;
    headerEntries.set(key, { name: String(name), values });
  };
  const responseRawHeaders = () => {
    const result = [];
    for (const entry of headerEntries.values()) {
      for (const value of entry.values) result.push([entry.name, value]);
    }
    return result;
  };
  const response = {
    statusCode: 200,
    statusMessage: "OK",
    headersSent: false,
    writableEnded: false,
    setHeader: (name, value) => {
      setHeaderValue(name, value);
      return response;
    },
    getHeader: (name) => headers[String(name).toLowerCase()],
    getHeaders: () => ({ ...headers }),
    hasHeader: (name) => Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
    removeHeader: (name) => {
      const key = String(name).toLowerCase();
      delete headers[key];
      headerEntries.delete(key);
    },
    flushHeaders: () => {
      response.headersSent = true;
    },
    writeHead: (statusCode, reasonOrHeaders, maybeHeaders) => {
      response.statusCode = Number(statusCode) || 200;
      response.headersSent = true;
      const nextHeaders = typeof reasonOrHeaders === "object" && reasonOrHeaders !== null ? reasonOrHeaders : maybeHeaders;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) setHeaderValue(name, value);
      return response;
    },
    write: (chunk, encoding, callback) => {
      chunks.push(bytesFromFsWriteValue(chunk, typeof encoding === "string" ? encoding : void 0));
      const done = typeof encoding === "function" ? encoding : callback;
      done?.();
      return true;
    },
    end: (chunk, encoding, callback) => {
      if (ended) return response;
      if (chunk !== void 0 && chunk !== null) response.write(chunk, typeof encoding === "string" ? encoding : void 0);
      ended = true;
      response.writableEnded = true;
      const done = typeof encoding === "function" ? encoding : callback;
      done?.();
      events.emit("finish");
      events.emit("close");
      const bodyBytes = concatBytes(chunks);
      const rawHeaders = responseRawHeaders();
      resolve({
        status: response.statusCode,
        headers,
        ...rawHeaders.length > 0 ? { rawHeaders } : {},
        ...bytesToRuntimeHttpBody(bodyBytes)
      });
      return response;
    },
    on: events.on,
    addListener: events.addListener,
    once: events.once,
    removeListener: events.removeListener,
    off: events.off,
    emit: events.emit
  };
  return response;
}
var HTTP_STATUS_CODES = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  404: "Not Found",
  500: "Internal Server Error"
};
function createClientIncomingMessage(response) {
  const events = createListenerMap();
  let encoding;
  let bodyRead = false;
  let bodyScheduled = false;
  let readableEnded = false;
  const bodyBytes = bytesFromRuntimeHttpBody(response);
  const formatBody = () => encoding ? BrowserBuffer.from(bodyBytes).toString(encoding) : BrowserBuffer.from(bodyBytes);
  const scheduleBody = () => {
    if (bodyScheduled) return;
    bodyScheduled = true;
    queueMicrotask(() => {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        events.emit("data", formatBody());
      }
      readableEnded = true;
      events.emit("end");
    });
  };
  const message = {
    statusCode: response.status,
    statusMessage: HTTP_STATUS_CODES[response.status] ?? "",
    headers: response.headers ?? {},
    rawHeaders: response.rawHeaders ? response.rawHeaders.flatMap(([name, value]) => [name, value]) : Object.entries(response.headers ?? {}).flatMap(([name, value]) => [name, value]),
    httpVersion: "1.1",
    complete: true,
    get readableEnded() {
      return readableEnded;
    },
    setEncoding: (nextEncoding) => {
      encoding = nextEncoding;
      return message;
    },
    read: () => {
      if (bodyRead) return null;
      bodyRead = true;
      readableEnded = true;
      return formatBody();
    },
    on: (event, listener) => {
      events.on(event, listener);
      if (event === "data" || event === "end") scheduleBody();
      return message;
    },
    addListener: (event, listener) => message.on(event, listener),
    once: (event, listener) => {
      events.once(event, listener);
      if (event === "data" || event === "end") scheduleBody();
      return message;
    },
    removeListener: events.removeListener,
    off: events.removeListener,
    [Symbol.asyncIterator]: async function* () {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        readableEnded = true;
        yield formatBody();
      }
    }
  };
  return message;
}
function headersFromHttpOptions(headers) {
  const result = {};
  if (!headers || typeof headers !== "object") return result;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => {
      result[String(name).toLowerCase()] = String(value);
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      result[String(entry[0]).toLowerCase()] = String(entry[1]);
    }
    return result;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result[name.toLowerCase()] = value.map(String).join(", ");
    else if (value !== void 0) result[name.toLowerCase()] = String(value);
  }
  return result;
}
function bodyToHttpBody(body) {
  if (body === void 0 || body === null) return void 0;
  if (typeof body === "string") return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof ArrayBuffer) return bytesToRuntimeHttpBody(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return bytesToRuntimeHttpBody(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return { body: String(body) };
}
function normalizeHttpClientRequest(args) {
  const callback = args.find((arg) => typeof arg === "function");
  const parts = args.filter((arg) => typeof arg !== "function");
  const first = parts[0];
  const second = parts[1];
  const urlInput = typeof first === "string" || first instanceof URL ? first : void 0;
  const options = urlInput !== void 0 ? second : first;
  const baseUrl = urlInput !== void 0 ? new URL(urlInput) : void 0;
  const optionHost = typeof options?.hostname === "string" ? options.hostname : typeof options?.host === "string" ? options.host : void 0;
  const protocol = String(options?.protocol ?? baseUrl?.protocol ?? "http:");
  const hostname = optionHost ?? baseUrl?.hostname ?? "localhost";
  const port = options?.port !== void 0 ? String(options.port) : baseUrl?.port;
  const path = String(options?.path ?? `${baseUrl?.pathname ?? "/"}${baseUrl?.search ?? ""}`);
  const url = new URL(`${protocol}//${hostname}${port ? `:${port}` : ""}${path.startsWith("/") ? path : `/${path}`}`);
  return {
    ...callback ? { callback } : {},
    headers: headersFromHttpOptions(options?.headers),
    method: String(options?.method ?? "GET").toUpperCase(),
    ...typeof options?.signal === "object" && options?.signal !== null ? { signal: options.signal } : {},
    ...options?.timeout !== void 0 && Number.isFinite(Number(options.timeout)) ? { timeoutMs: Math.max(0, Number(options.timeout)) } : {},
    url
  };
}
function createHttpApi(kernelHttp, signal) {
  const activeHandles = /* @__PURE__ */ new Set();
  const activeClientAborters = /* @__PURE__ */ new Set();
  let activeClientRequests = 0;
  const closeWaiters = [];
  const notifyCloseWaiters = () => {
    if (activeHandles.size > 0 || activeClientRequests > 0) return;
    while (closeWaiters.length > 0) closeWaiters.shift()?.();
  };
  const closeHandle = (handle) => {
    if (!activeHandles.delete(handle)) return;
    handle.close();
    notifyCloseWaiters();
  };
  const closeAll = () => {
    for (const handle of [...activeHandles]) closeHandle(handle);
    for (const abortClient of [...activeClientAborters]) abortClient();
  };
  signal?.addEventListener("abort", closeAll, { once: true });
  const createServer = (requestListener) => {
    const events = createListenerMap();
    let handle = null;
    const server = {
      listening: false,
      listen: (...args) => {
        if (!kernelHttp) throw Object.assign(new Error("ENOSYS: tracekernel HTTP is not available"), { code: "ENOSYS" });
        const port = typeof args[0] === "number" || typeof args[0] === "string" ? Number(args[0]) : 80;
        const host = typeof args[1] === "string" ? args[1] : void 0;
        const callback = args.find((arg) => typeof arg === "function");
        handle = kernelHttp.listen({ port, ...host ? { host } : {} }, async (request2) => {
          const incoming = createIncomingMessage(request2);
          const responsePromise = new Promise((resolve) => {
            const response = createServerResponse(resolve);
            let handled = false;
            try {
              handled = events.emit("request", incoming, response);
            } catch (error) {
              if (!response.writableEnded) {
                response.statusCode = 500;
                response.end(error instanceof Error ? error.message : String(error));
              }
              return;
            }
            if (!handled && !response.writableEnded) {
              response.statusCode = 404;
              response.end("");
            }
          });
          return responsePromise;
        });
        activeHandles.add(handle);
        server.listening = true;
        events.emit("listening");
        callback?.();
        return server;
      },
      close: (callback) => {
        if (handle) closeHandle(handle);
        handle = null;
        server.listening = false;
        events.emit("close");
        callback?.();
        return server;
      },
      address: () => handle ? { address: handle.info.host, port: handle.info.port, family: "IPv4" } : null,
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit
    };
    if (requestListener) server.on("request", requestListener);
    return server;
  };
  const request = (...args) => {
    const events = createListenerMap();
    const chunks = [];
    const headers = {};
    let ended = false;
    let destroyed = false;
    let timeoutMs;
    let timeoutCallback;
    let requestOptions;
    try {
      requestOptions = normalizeHttpClientRequest(args);
      Object.assign(headers, requestOptions.headers);
      timeoutMs = requestOptions.timeoutMs;
    } catch (error) {
      requestOptions = {
        headers,
        method: "GET",
        url: new URL("http://localhost/")
      };
      queueMicrotask(() => events.emit("error", error));
    }
    const clientRequest = {
      destroyed: false,
      writableEnded: false,
      setTimeout: (milliseconds, callback) => {
        timeoutMs = Math.max(0, Number(milliseconds) || 0);
        timeoutCallback = callback;
        if (callback) events.once("timeout", callback);
        return clientRequest;
      },
      setHeader: (name, value) => {
        headers[String(name).toLowerCase()] = String(value);
        return clientRequest;
      },
      getHeader: (name) => headers[String(name).toLowerCase()],
      getHeaders: () => ({ ...headers }),
      hasHeader: (name) => Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
      removeHeader: (name) => {
        delete headers[String(name).toLowerCase()];
      },
      write: (chunk, encoding, callback) => {
        if (destroyed) return false;
        chunks.push(bytesFromFsWriteValue(chunk, typeof encoding === "string" ? encoding : void 0));
        const done = typeof encoding === "function" ? encoding : callback;
        done?.();
        return true;
      },
      end: (chunk, encoding, callback) => {
        if (ended || destroyed) return clientRequest;
        if (chunk !== void 0 && chunk !== null) clientRequest.write(chunk, typeof encoding === "string" ? encoding : void 0);
        ended = true;
        clientRequest.writableEnded = true;
        const done = typeof encoding === "function" ? encoding : callback;
        done?.();
        if (!kernelHttp) {
          activeClientRequests += 1;
          queueMicrotask(() => {
            events.emit("error", Object.assign(new Error("ENOSYS: tracekernel HTTP is not available"), { code: "ENOSYS" }));
            activeClientRequests -= 1;
            notifyCloseWaiters();
          });
          return clientRequest;
        }
        const body = bytesToRuntimeHttpBody(concatBytes(chunks));
        const rawHeaders = Object.entries(headers);
        activeClientRequests += 1;
        let active = true;
        let timeoutHandle;
        let requestAbortListener;
        const finishClientRequest = () => {
          if (!active) return;
          active = false;
          if (timeoutHandle !== void 0) globalThis.clearTimeout(timeoutHandle);
          if (requestAbortListener) requestOptions.signal?.removeEventListener?.("abort", requestAbortListener);
          activeClientAborters.delete(abortClientRequest);
          queueMicrotask(() => {
            queueMicrotask(() => {
              activeClientRequests -= 1;
              notifyCloseWaiters();
            });
          });
        };
        const abortClientRequest = (error) => {
          if (destroyed) return;
          destroyed = true;
          clientRequest.destroyed = true;
          if (error) events.emit("error", error);
          events.emit("close");
          finishClientRequest();
        };
        activeClientAborters.add(abortClientRequest);
        if (requestOptions.signal) {
          requestAbortListener = () => abortClientRequest(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          requestOptions.signal.addEventListener?.("abort", requestAbortListener, { once: true });
          if (requestOptions.signal.aborted) requestAbortListener();
        }
        if (!destroyed && timeoutMs !== void 0) {
          timeoutHandle = globalThis.setTimeout(() => {
            events.emit("timeout");
            abortClientRequest(Object.assign(new Error(`ETIMEDOUT: request timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
          }, timeoutMs);
        }
        void kernelHttp.dispatch({
          method: requestOptions.method,
          url: requestOptions.url.toString(),
          path: `${requestOptions.url.pathname}${requestOptions.url.search}`,
          headers,
          ...rawHeaders.length > 0 ? { rawHeaders } : {},
          ...chunks.length > 0 ? body : {}
        }).then((response) => {
          if (destroyed) return;
          if (response.status === 0) {
            events.emit("error", Object.assign(new Error(response.body ?? "connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
            finishClientRequest();
            return;
          }
          const incoming = createClientIncomingMessage(response);
          requestOptions.callback?.(incoming);
          events.emit("response", incoming);
          finishClientRequest();
        }, (error) => {
          if (!destroyed) events.emit("error", error);
          finishClientRequest();
        });
        return clientRequest;
      },
      abort: () => {
        clientRequest.destroy();
        events.emit("abort");
      },
      destroy: (error) => {
        if (destroyed) return clientRequest;
        destroyed = true;
        clientRequest.destroyed = true;
        if (error) events.emit("error", error);
        events.emit("close");
        return clientRequest;
      },
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit
    };
    return clientRequest;
  };
  const get = (...args) => {
    const clientRequest = request(...args);
    clientRequest.end();
    return clientRequest;
  };
  class TraceKernelHeaders {
    headerValues = /* @__PURE__ */ new Map();
    constructor(init) {
      const record = headersFromHttpOptions(init);
      for (const [name, value] of Object.entries(record)) this.set(name, value);
    }
    append(name, value) {
      const key = String(name).toLowerCase();
      const current = this.headerValues.get(key);
      this.headerValues.set(key, current === void 0 ? String(value) : `${current}, ${String(value)}`);
    }
    delete(name) {
      this.headerValues.delete(String(name).toLowerCase());
    }
    entries() {
      return this.headerValues.entries();
    }
    forEach(callback) {
      for (const [name, value] of this.headerValues) callback(value, name, this);
    }
    get(name) {
      return this.headerValues.get(String(name).toLowerCase()) ?? null;
    }
    has(name) {
      return this.headerValues.has(String(name).toLowerCase());
    }
    keys() {
      return this.headerValues.keys();
    }
    set(name, value) {
      this.headerValues.set(String(name).toLowerCase(), String(value));
    }
    values() {
      return this.headerValues.values();
    }
    toRecord() {
      return Object.fromEntries(this.headerValues);
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  }
  class TraceKernelRequest {
    headers;
    method;
    signal;
    url;
    bodyPayload;
    constructor(input, init) {
      const sourceRequest = input instanceof TraceKernelRequest ? input : null;
      const source = input;
      const inputUrl = typeof input === "string" || input instanceof URL ? String(input) : String(sourceRequest?.url ?? source.url ?? "");
      this.url = inputUrl;
      this.method = String(init?.method ?? sourceRequest?.method ?? source.method ?? "GET").toUpperCase();
      this.headers = new TraceKernelHeaders(sourceRequest?.headers ?? source.headers);
      const initHeaders = new TraceKernelHeaders(init?.headers);
      initHeaders.forEach((value, name) => this.headers.set(name, value));
      this.bodyPayload = init && Object.prototype.hasOwnProperty.call(init, "body") ? bodyToHttpBody(init.body) : sourceRequest?.bodyForDispatch() ?? (source.bodyEncoding === "base64" ? { body: String(source.body ?? ""), bodyEncoding: "base64" } : bodyToHttpBody(source.body));
      const initSignal = init?.signal;
      this.signal = initSignal && typeof initSignal === "object" ? initSignal : sourceRequest?.signal ?? source.signal;
    }
    async text() {
      return textFromBytes(bytesFromRuntimeHttpBody(this.bodyPayload ?? {}));
    }
    bodyForDispatch() {
      return this.bodyPayload;
    }
  }
  class TraceKernelResponse {
    headers;
    ok;
    redirected = false;
    status;
    statusText;
    type = "basic";
    url;
    bodyBytes;
    used = false;
    constructor(bodyOrResponse = "", initOrUrl) {
      const kernelResponse = typeof initOrUrl === "string" && bodyOrResponse !== null && typeof bodyOrResponse === "object" && "status" in bodyOrResponse ? bodyOrResponse : null;
      const init = !kernelResponse && initOrUrl && typeof initOrUrl === "object" ? initOrUrl : {};
      const status = kernelResponse ? kernelResponse.status : Math.trunc(Number(init.status ?? 200)) || 200;
      this.status = status;
      this.statusText = HTTP_STATUS_CODES[status] ?? "";
      this.ok = status >= 200 && status < 300;
      this.headers = new TraceKernelHeaders(kernelResponse ? kernelResponse.headers : init.headers);
      this.bodyBytes = kernelResponse ? bytesFromRuntimeHttpBody(kernelResponse) : bytesFromRuntimeHttpBody(bodyToHttpBody(bodyOrResponse) ?? {});
      this.url = typeof initOrUrl === "string" ? initOrUrl : "";
    }
    get bodyUsed() {
      return this.used;
    }
    consume() {
      if (this.used) throw new TypeError("Body has already been consumed.");
      this.used = true;
      return new Uint8Array(this.bodyBytes);
    }
    async arrayBuffer() {
      const bytes = this.consume();
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    }
    clone() {
      if (this.used) throw new TypeError("Body has already been consumed.");
      return new TraceKernelResponse({
        status: this.status,
        headers: this.headers.toRecord(),
        ...bytesToRuntimeHttpBody(this.bodyBytes)
      }, this.url);
    }
    async json() {
      return JSON.parse(textFromBytes(this.consume()));
    }
    async text() {
      return textFromBytes(this.consume());
    }
  }
  const fetch = async (input, init) => {
    if (!kernelHttp) throw Object.assign(new Error("ENOSYS: tracekernel HTTP is not available"), { code: "ENOSYS" });
    const request2 = new TraceKernelRequest(input, init);
    const url = new URL(request2.url);
    const body = request2.bodyForDispatch();
    const headers = request2.headers.toRecord();
    const rawHeaders = Object.entries(headers);
    activeClientRequests += 1;
    let active = true;
    let abortListener;
    let rejectFetch;
    const finishFetch = () => {
      if (!active) return;
      active = false;
      if (abortListener) request2.signal?.removeEventListener?.("abort", abortListener);
      activeClientAborters.delete(abortFetch);
      globalThis.setTimeout(() => {
        activeClientRequests -= 1;
        notifyCloseWaiters();
      }, 0);
    };
    const abortFetch = () => {
      rejectFetch?.(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
      finishFetch();
    };
    activeClientAborters.add(abortFetch);
    return new Promise((resolve, reject) => {
      rejectFetch = reject;
      if (request2.signal) {
        abortListener = abortFetch;
        request2.signal.addEventListener?.("abort", abortListener, { once: true });
        if (request2.signal.aborted) {
          abortFetch();
          return;
        }
      }
      if (!active) return;
      void kernelHttp.dispatch({
        method: request2.method,
        url: url.toString(),
        path: `${url.pathname}${url.search}`,
        headers,
        ...rawHeaders.length > 0 ? { rawHeaders } : {},
        ...body !== void 0 ? body : {}
      }).then((response) => {
        if (!active) return;
        if (response.status === 0) {
          reject(Object.assign(new TypeError(response.body ?? "fetch failed"), { code: "ECONNREFUSED" }));
          finishFetch();
          return;
        }
        resolve(new TraceKernelResponse(response, url.toString()));
        finishFetch();
      }, (error) => {
        if (!active) return;
        reject(error);
        finishFetch();
      });
    });
  };
  return {
    module: {
      createServer,
      request,
      get,
      Server: function Server(requestListener) {
        return createServer(requestListener);
      },
      STATUS_CODES: HTTP_STATUS_CODES
    },
    fetch,
    Headers: TraceKernelHeaders,
    Request: TraceKernelRequest,
    Response: TraceKernelResponse,
    hasActiveWork: () => activeHandles.size > 0 || activeClientRequests > 0,
    waitForClose: () => activeHandles.size === 0 && activeClientRequests === 0 ? Promise.resolve() : new Promise((resolve) => closeWaiters.push(resolve)),
    closeAll
  };
}
function dirname(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}
function workspaceFilename(path, workspaceRoot = "/workspace") {
  const normalized = normalizeProjectPath(path);
  return normalized ? `${workspaceRoot}/${normalized}` : workspaceRoot;
}
function workspaceFileUrl(path, workspaceRoot = "/workspace") {
  return `file://${workspaceFilename(path, workspaceRoot).split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}
function workspaceDirname(path, workspaceRoot = "/workspace") {
  const normalizedDir = dirname(normalizeProjectPath(path));
  return normalizedDir ? `${workspaceRoot}/${normalizedDir}` : workspaceRoot;
}
function joinModulePath(parentPath, specifier) {
  const parentDir = dirname(parentPath);
  const joined = `${parentDir}/${specifier}`.replace(/^\//, "");
  const parts = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}
function workspaceCwdPath(request) {
  const projectCwd = request.project.cwd ?? "/workspace";
  if (request.cwd === projectCwd) return "";
  if (request.cwd.startsWith(`${projectCwd}/`)) {
    return normalizeProjectPath(request.cwd.slice(projectCwd.length + 1));
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}
function moduleFileCandidates(path) {
  const normalized = normalizeProjectPath(path);
  const candidates = [normalized];
  if (!/\.(?:cjs|js|json|mjs)$/.test(normalized)) {
    candidates.push(`${normalized}.js`, `${normalized}.json`, `${normalized}.mjs`, `${normalized}.cjs`);
  }
  return candidates;
}
function parsePackageJson(modules, path) {
  const normalized = normalizeProjectPath(path);
  const packageJson = modules.get(normalized ? `${normalized}/package.json` : "package.json");
  if (!packageJson) return null;
  try {
    return JSON.parse(packageJson);
  } catch {
    return null;
  }
}
function manifestDeclaresDependency(manifest, dependency) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = manifest[field];
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies) && dependency in dependencies) {
      return true;
    }
  }
  return false;
}
function projectDeclaresDependency(modules, dependency) {
  for (const path of modules.keys()) {
    if (!path.endsWith("package.json")) continue;
    const directory = dirname(path);
    const manifest = parsePackageJson(modules, directory);
    if (manifest && manifestDeclaresDependency(manifest, dependency)) return true;
  }
  return false;
}
function packageExportTarget(value, condition) {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const record = value;
  return packageExportTarget(record[condition], condition) ?? packageExportTarget(record.node, condition) ?? packageExportTarget(record.default, condition) ?? packageExportTarget(condition === "require" ? record.import : record.require, condition);
}
function packageMainCandidates(modules, path, condition) {
  const normalized = normalizeProjectPath(path);
  const parsed = parsePackageJson(modules, normalized);
  if (!parsed) return [];
  const candidates = [];
  const exportsTarget = packageExportTarget(parsed.exports, condition);
  if (exportsTarget) {
    candidates.push(...moduleFileCandidates(`${normalized}/${exportsTarget}`));
  }
  if (parsed.exports && typeof parsed.exports === "object" && !Array.isArray(parsed.exports)) {
    const dotTarget = packageExportTarget(parsed.exports["."], condition);
    if (dotTarget) {
      candidates.push(...moduleFileCandidates(`${normalized}/${dotTarget}`));
    }
  }
  if (typeof parsed.module === "string" && parsed.module.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.module}`));
  }
  if (typeof parsed.main === "string" && parsed.main.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.main}`));
  }
  return candidates;
}
function packageSpecifierParts(specifier) {
  const parts = normalizeProjectPath(specifier).split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0]?.startsWith("@")) {
    if (parts.length < 2) return null;
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : "."
    };
  }
  return {
    packageName: parts[0] ?? "",
    subpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : "."
  };
}
function packageExportCandidates(modules, specifier, condition) {
  const parsedSpecifier = packageLocationForSpecifier(specifier);
  if (!parsedSpecifier) return [];
  const packageRoot = parsedSpecifier.packageRoot;
  const parsed = parsePackageJson(modules, packageRoot);
  if (!parsed?.exports) return [];
  const exportTarget = parsedSpecifier.subpath === "." ? packageExportTarget(parsed.exports, condition) : typeof parsed.exports === "object" && !Array.isArray(parsed.exports) ? packageExportTarget(parsed.exports[parsedSpecifier.subpath], condition) : null;
  if (!exportTarget) {
    return [];
  }
  return moduleFileCandidates(`${packageRoot}/${exportTarget}`);
}
function packageLocationForSpecifier(specifier) {
  const normalized = normalizeProjectPath(specifier);
  const parts = normalized.split("/").filter(Boolean);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex !== -1) {
    const packageStart = nodeModulesIndex + 1;
    const first = parts[packageStart];
    if (!first) return null;
    const packageLength = first.startsWith("@") ? 2 : 1;
    const packageParts = parts.slice(packageStart, packageStart + packageLength);
    if (packageParts.length !== packageLength || packageParts.some((part) => !part)) return null;
    const packageRoot = parts.slice(0, packageStart + packageLength).join("/");
    const subpathParts = parts.slice(packageStart + packageLength);
    return {
      packageRoot,
      subpath: subpathParts.length > 0 ? `./${subpathParts.join("/")}` : "."
    };
  }
  const parsedSpecifier = packageSpecifierParts(normalized);
  if (!parsedSpecifier) return null;
  return {
    packageRoot: `node_modules/${parsedSpecifier.packageName}`,
    subpath: parsedSpecifier.subpath
  };
}
function moduleCandidates(modules, path, condition) {
  const normalized = normalizeProjectPath(path);
  return [
    ...packageExportCandidates(modules, normalized, condition),
    ...moduleFileCandidates(normalized),
    ...packageMainCandidates(modules, normalized, condition),
    `${normalized}/index.js`,
    `${normalized}/index.json`
  ];
}
function nodePathEntries(request, cwdPath, workspace) {
  const rawNodePath = request.env.NODE_PATH;
  if (typeof rawNodePath !== "string" || rawNodePath.trim().length === 0) {
    return [];
  }
  return rawNodePath.split(":").map((entry) => entry.trim()).filter(Boolean).map((entry) => normalizeWorkspaceEntryPath(entry, cwdPath, true, workspace)).filter((entry, index, entries) => entries.indexOf(entry) === index);
}
function packageTypeForPath(modules, path) {
  const normalized = normalizeProjectPath(path);
  const parts = normalized.split("/");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join("/");
    const parsed = parsePackageJson(modules, directory);
    if (typeof parsed?.type === "string") return parsed.type;
  }
  return null;
}
function isEsmModule(modules, path) {
  const normalized = normalizeProjectPath(path);
  if (normalized.endsWith(".mjs")) return true;
  if (normalized.endsWith(".cjs") || normalized.endsWith(".json")) return false;
  return normalized.endsWith(".js") && packageTypeForPath(modules, normalized) === "module";
}
function toRequireBinding(specifier) {
  return `require(${JSON.stringify(specifier)})`;
}
function toDynamicImportBinding(specifier) {
  return `__import(${JSON.stringify(specifier)})`;
}
function transformDynamicImports(code) {
  return code.replace(
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    (_match, _quote, specifier) => toDynamicImportBinding(specifier)
  );
}
function defaultImportBinding(name, specifier, index) {
  const moduleName = `__tracecode_esm_default_${index}`;
  return [
    `const ${moduleName} = ${toRequireBinding(specifier)};`,
    `const ${name} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`
  ].join(" ");
}
function transformNamedBindings(bindings) {
  return bindings.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [importedName, localName] = part.split(/\s+as\s+/).map((value) => value.trim());
    return localName ? `${importedName}: ${localName}` : importedName;
  }).join(", ");
}
function namedExportAssignments(bindings, moduleName) {
  return bindings.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [localName, exportedName] = part.split(/\s+as\s+/).map((value) => value.trim());
    const targetName = exportedName ?? localName;
    const source = moduleName ? `${moduleName}.${localName}` : localName;
    return `exports.${targetName} = ${source};`;
  }).join(" ");
}
function transformStaticEsmToCommonJs(code, importMetaUrl) {
  let defaultImportIndex = 0;
  let reExportIndex = 0;
  return transformDynamicImports(code).replace(
    /\bimport\.meta\.url\b/g,
    JSON.stringify(importMetaUrl ?? "file:///workspace/[eval]")
  ).replace(
    /^\s*export\s+\*\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
    (_match, _quote, specifier) => {
      const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
      return `const ${moduleName} = ${toRequireBinding(specifier)}; for (const __tracecode_key of Object.keys(${moduleName})) { if (__tracecode_key !== "default") exports[__tracecode_key] = ${moduleName}[__tracecode_key]; }`;
    }
  ).replace(
    /^\s*export\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_match, namedExports, _quote, specifier) => {
      const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
      return `const ${moduleName} = ${toRequireBinding(specifier)}; ${namedExportAssignments(namedExports, moduleName)}`;
    }
  ).replace(
    /^\s*import\s+([\w$]+)\s*,\s*\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/gm,
    (_match, defaultName, namespaceName, _quote, specifier) => {
      const required = toRequireBinding(specifier);
      const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
      return `const ${namespaceName} = ${required}; const ${moduleName} = ${namespaceName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
    }
  ).replace(
    /^\s*import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/gm,
    (_match, defaultName, namedImports, _quote, specifier) => {
      const required = toRequireBinding(specifier);
      const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
      return `const ${moduleName} = ${required}; const { ${transformNamedBindings(namedImports)} } = ${moduleName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
    }
  ).replace(
    /^\s*import\s+\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_match, namespaceName, _quote, specifier) => `const ${namespaceName} = ${toRequireBinding(specifier)};`
  ).replace(
    /\bimport\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?/g,
    (_match, namedImports, _quote, specifier) => `const { ${transformNamedBindings(namedImports)} } = ${toRequireBinding(specifier)};`
  ).replace(
    /^\s*import\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_match, defaultName, _quote, specifier) => defaultImportBinding(defaultName, specifier, defaultImportIndex++)
  ).replace(
    /^\s*import\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
    (_match, _quote, specifier) => `${toRequireBinding(specifier)};`
  ).replace(
    /^\s*export\s+function\s+([\w$]+)\s*\(/gm,
    (_match, name) => `exports.${name} = function ${name}(`
  ).replace(
    /^\s*export\s+class\s+([\w$]+)\s*/gm,
    (_match, name) => `exports.${name} = class ${name} `
  ).replace(
    /^\s*export\s+(const|let|var)\s+([\w$]+)\s*=/gm,
    (_match, declaration, name) => `${declaration} ${name} = exports.${name} =`
  ).replace(
    /^\s*export\s+default\s+/gm,
    "exports.default = "
  ).replace(
    /^\s*export\s+\{([^}]+)\}\s*;?\s*$/gm,
    (_match, namedExports) => namedExportAssignments(namedExports)
  );
}
function resolveModulePath(modules, specifier, parentPath, nodePathSearchEntries = [], condition = "require") {
  const basePaths = specifier.startsWith(".") ? [joinModulePath(parentPath, specifier)] : [
    ...nodeModulesSearchPaths(parentPath, specifier),
    specifier,
    ...nodePathSearchEntries.map((entry) => entry ? `${entry}/${specifier}` : specifier)
  ];
  for (const basePath of basePaths) {
    for (const candidate of moduleCandidates(modules, basePath, condition)) {
      if (modules.has(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot find module '${specifier}'`);
}
function nodeModulesSearchPaths(parentPath, specifier) {
  const parentDirectory = dirname(normalizeProjectPath(parentPath));
  const parts = parentDirectory ? parentDirectory.split("/").filter(Boolean) : [];
  const paths = [];
  for (let index = parts.length; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join("/");
    paths.push(directory ? `${directory}/node_modules/${specifier}` : `node_modules/${specifier}`);
  }
  return paths;
}
function moduleSearchPaths(parentPath, workspaceRoot = "/workspace") {
  return nodeModulesSearchPaths(parentPath, "").map((path) => workspaceFilename(path.replace(/\/$/, ""), workspaceRoot));
}
function formatConsoleValues(values) {
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");
}
function formatBrowserJavaScriptErrorForStderr(error) {
  if (error instanceof Error) {
    const text = typeof error.stack === "string" && error.stack.trim() ? error.stack : error.message;
    return `${text.trimEnd()}
`;
  }
  return `${String(error)}
`;
}
function sanitizeBrowserJavaScriptStack(error, sourcePath) {
  if (!(error instanceof Error) || typeof error.stack !== "string" || !error.stack.trim()) {
    return error;
  }
  const mappedStack = error.stack.replace(
    /\(eval at [^,]+ \([^)]*\), <anonymous>:(\d+):(\d+)\)/g,
    (_match, line, column) => `(${sourcePath}:${Math.max(1, Number(line) - 2)}:${column})`
  );
  const lines = [];
  for (const line of mappedStack.split("\n")) {
    if (line.includes("/@fs/") || line.includes("/dist/browser/project.js") || line.includes("runBrowserJavaScriptProjectRequest") || line.includes("executeEntrypoint") || line.includes("executeModule")) {
      break;
    }
    lines.push(line);
  }
  Object.defineProperty(error, "stack", {
    configurable: true,
    value: (lines.length > 0 ? lines : [mappedStack.split("\n")[0] ?? error.message]).join("\n")
  });
  return error;
}
function processArgvForRequest(request) {
  if (request.source === "argument") {
    return ["node", ...request.args];
  }
  if (request.source === "stdin") {
    return ["node", "-", ...request.args];
  }
  return ["node", request.scriptPath, ...request.args];
}
function requireModulesForRequest(request) {
  return Array.isArray(request.options?.require) ? request.options.require.filter((item) => typeof item === "string") : [];
}
async function runBrowserJavaScriptProjectRequest(request, options, executionState) {
  if (options.allowDynamicEval === false) {
    const stderr2 = "node: browser JavaScript project runner requires dynamic evaluation\n";
    const io2 = createRuntimeProjectIoBridge(request.onEvent);
    io2.output("stderr", stderr2);
    io2.status("process-exit", "Browser Node exited", { command: "node", exitCode: 1 });
    return {
      stdout: "",
      stderr: stderr2,
      exitCode: 1
    };
  }
  const stdout = [];
  const stderr = [];
  const liveIo = new RuntimeProjectLiveIoController({
    applyFileChange: options.applyFileChange ? async (change, phase) => {
      if (executionState.cancelled) return false;
      return options.applyFileChange?.(change, phase);
    } : void 0,
    onEvent: (event) => {
      if (!executionState.cancelled) request.onEvent?.(event);
    }
  });
  const emitRuntimeEvent = (event) => {
    liveIo.handleRuntimeEvent(event);
  };
  const io = createRuntimeProjectIoBridge(emitRuntimeEvent);
  const workspacePathContext = createWorkspacePathContext(request.project);
  const workspaceRoot = workspacePathContext.root;
  const kernelInfo = request.project.kernel ?? fallbackKernelInfo(request.project, workspacePathContext);
  const kernelDevices = request.project.kernelDevices;
  const procSnapshot = createBrowserProcSnapshot(request.project.kernelFiles);
  const cwdPath = workspaceCwdPath(request);
  const hiddenFiles = Array.from(new Set(
    (request.project.hiddenFiles ?? []).map((path) => normalizeWorkspaceEntryPath(path, "", false, workspacePathContext))
  ));
  const hiddenNamespaces = /* @__PURE__ */ new Set();
  for (const hiddenPath of hiddenFiles) {
    if (!hiddenPath) continue;
    hiddenNamespaces.add(hiddenPath);
    const parts = hiddenPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      hiddenNamespaces.add(parts.slice(0, index).join("/"));
    }
  }
  const isHiddenNamespacePath = (path) => Boolean(path) && Array.from(hiddenNamespaces).some((hiddenPath) => path === hiddenPath || path.startsWith(`${hiddenPath}/`));
  const isHiddenProjectPath = (path) => isHiddenNamespacePath(path) || hiddenFiles.some((hiddenPath) => hiddenPath.startsWith(`${path}/`));
  const readonlyFiles = new Set(
    (request.project.readonlyFiles ?? []).map((path) => normalizeWorkspaceEntryPath(path, "", false, workspacePathContext))
  );
  io.status("process-start", "Starting browser Node", {
    command: "node",
    args: processArgvForRequest(request).slice(2),
    cwd: request.cwd
  });
  const visibleProjectFiles = request.project.files.filter(
    (file) => !isHiddenProjectPath(assertSafeWorkspaceFilePath(file.path, "", workspacePathContext))
  );
  const modules = new Map(
    visibleProjectFiles.filter((file) => file.encoding !== "base64").map((file) => [assertSafeWorkspaceFilePath(file.path, "", workspacePathContext), file.contents])
  );
  const virtualTextFiles = /* @__PURE__ */ new Map();
  const hasTypeScriptPackage = Array.from(modules.keys()).some((path) => path.startsWith("node_modules/typescript/"));
  if (!hasTypeScriptPackage && projectDeclaresDependency(modules, "typescript")) {
    const version = getLanguageRuntimeInfo("typescript").compiler?.version ?? "5.9.3";
    virtualTextFiles.set("node_modules/typescript/package.json", JSON.stringify({
      name: "typescript",
      version,
      main: "index.js"
    }, null, 2) + "\n");
    virtualTextFiles.set("node_modules/typescript/index.js", [
      `const version = ${JSON.stringify(version)};`,
      "module.exports = {",
      "  version,",
      '  versionMajorMinor: version.split(".").slice(0, 2).join("."),',
      "};",
      ""
    ].join("\n"));
  }
  for (const [path, contents] of virtualTextFiles) {
    modules.set(path, contents);
  }
  const fileStore = new Map(
    visibleProjectFiles.map((file) => [assertSafeWorkspaceFilePath(file.path, "", workspacePathContext), fileBytes(file)])
  );
  for (const [path, contents] of virtualTextFiles) {
    fileStore.set(path, textEncoder.encode(contents));
  }
  const directoryStore = /* @__PURE__ */ new Set([""]);
  for (const filePath of fileStore.keys()) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directoryStore.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directory of request.project.directories ?? []) {
    const directoryPath = normalizeWorkspaceEntryPath(directory, "", true, workspacePathContext);
    if (!directoryPath) continue;
    if (isHiddenProjectPath(directoryPath)) continue;
    const parts = directoryPath.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      directoryStore.add(parts.slice(0, index).join("/"));
    }
  }
  let fsTimestampMs = 1;
  const createEntryMetadata = (mode) => ({
    atimeMs: fsTimestampMs,
    birthtimeMs: fsTimestampMs,
    ctimeMs: fsTimestampMs,
    gid: 0,
    mode,
    mtimeMs: fsTimestampMs,
    uid: 0
  });
  const entryMetadata = new Map(
    Array.from(fileStore.keys()).map((filePath) => [filePath, createEntryMetadata(33188)])
  );
  for (const directoryPath of directoryStore) {
    if (!entryMetadata.has(directoryPath)) {
      entryMetadata.set(directoryPath, createEntryMetadata(16877));
    }
  }
  const touchEntryMetadata = (path) => {
    fsTimestampMs += 1;
    const previous = entryMetadata.get(path);
    entryMetadata.set(path, {
      atimeMs: previous?.atimeMs ?? fsTimestampMs,
      birthtimeMs: previous?.birthtimeMs ?? fsTimestampMs,
      ctimeMs: fsTimestampMs,
      gid: previous?.gid ?? 0,
      mode: previous?.mode,
      mtimeMs: fsTimestampMs,
      uid: previous?.uid ?? 0
    });
  };
  const updateEntryMetadata = (path, update) => {
    fsTimestampMs += 1;
    const previous = entryMetadata.get(path) ?? createEntryMetadata();
    entryMetadata.set(path, {
      ...previous,
      ...update,
      ctimeMs: fsTimestampMs
    });
  };
  const deleteEntryMetadata = (path) => {
    fsTimestampMs += 1;
    entryMetadata.delete(path);
  };
  const hardLinkGroups = /* @__PURE__ */ new Map();
  const hardLinkGroupForPath = (path) => hardLinkGroups.get(path) ?? /* @__PURE__ */ new Set([path]);
  const setHardLinkGroup = (paths) => {
    const group = new Set(paths);
    for (const path of group) hardLinkGroups.set(path, group);
    return group;
  };
  const linkPaths = (source, destination) => {
    setHardLinkGroup([...hardLinkGroupForPath(source), destination]);
  };
  const unlinkPathFromHardLinks = (path) => {
    const group = hardLinkGroups.get(path);
    if (!group) return;
    group.delete(path);
    hardLinkGroups.delete(path);
    if (group.size <= 1) {
      for (const remaining of group) hardLinkGroups.delete(remaining);
      return;
    }
    for (const remaining of group) hardLinkGroups.set(remaining, group);
  };
  const moveHardLinkPath = (oldPath, newPath) => {
    const group = hardLinkGroups.get(oldPath);
    if (!group) return;
    group.delete(oldPath);
    group.add(newPath);
    hardLinkGroups.delete(oldPath);
    for (const path of group) hardLinkGroups.set(path, group);
  };
  const linkedInodeForPath = (path) => {
    const group = hardLinkGroups.get(path);
    return inodeForPath(group ? [...group].sort((left, right) => left.localeCompare(right))[0] ?? path : path);
  };
  const originalFiles = new Map(fileStore);
  const cache = /* @__PURE__ */ new Map();
  const requireCache = {};
  let mainModule;
  const emitOutput = (stream, data, device, sourceDevice) => {
    if (stream === "stdout") {
      stdout.push(data);
    } else {
      stderr.push(data);
    }
    io.output(stream, data, device, sourceDevice);
  };
  const writeDevice = (device, data) => {
    const route = runtimeKernelDeviceOutputRoute(kernelDevices, device);
    if (!route) {
      if (runtimeKernelDeviceOutputTarget(kernelDevices, device) === "/dev/null") return;
      throw Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" });
    }
    emitOutput(route.stream, data, route.outputDevice, route.sourceDevice);
  };
  const readDeviceBytes = (device, size) => {
    const inputRoute = runtimeKernelDeviceInputRoute(kernelDevices, device);
    if (!inputRoute) return new Uint8Array();
    if (request.stdinPipe) {
      return readRuntimeCommandStdinPipeBytes(request.stdinPipe, size);
    }
    return new Uint8Array();
  };
  const remainingDeviceBytes = (device) => runtimeKernelDeviceInputRoute(kernelDevices, device) ? request.stdinPipe ? runtimeCommandStdinPipeRemainingBytes(request.stdinPipe) : 0 : 0;
  const deviceInputClosed = (device) => runtimeKernelDeviceInputRoute(kernelDevices, device) ? request.stdinPipe ? runtimeCommandStdinPipeClosed(request.stdinPipe) : true : true;
  const readDevice = (device) => textFromBytes(readDeviceBytes(device));
  const consoleApi = {
    log: (...values) => {
      emitOutput("stdout", `${formatConsoleValues(values)}
`);
    },
    error: (...values) => {
      emitOutput("stderr", `${formatConsoleValues(values)}
`);
    }
  };
  const createWritableDevice = (device, fd2) => {
    const listeners = /* @__PURE__ */ new Map();
    let destroyed = false;
    let closed = false;
    let bytesWritten = 0;
    let writableEnded = false;
    let writableFinished = false;
    const on = (event, listener) => {
      const next = listeners.get(event) ?? [];
      next.push(listener);
      listeners.set(event, next);
    };
    const removeListener = (event, listener) => {
      const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
      if (next.length === 0) listeners.delete(event);
      else listeners.set(event, next);
    };
    const emit = (event, ...args) => {
      const current = listeners.get(event) ?? [];
      for (const listener of current) listener(...args);
      return current.length > 0;
    };
    const stream = {
      fd: fd2,
      writable: true,
      isTTY: false,
      get closed() {
        return closed;
      },
      get bytesWritten() {
        return bytesWritten;
      },
      get writableEnded() {
        return writableEnded;
      },
      get writableFinished() {
        return writableFinished;
      },
      write: (value, encoding, callback) => {
        const bytes = bytesFromFsWriteValue(value, typeof encoding === "string" ? encoding : void 0);
        const data = textFromBytes(bytes);
        writeDevice(device, data);
        bytesWritten += bytes.byteLength;
        const done = typeof encoding === "function" ? encoding : callback;
        done?.(null);
        return true;
      },
      end: (value, encoding, callback) => {
        if (value !== void 0 && value !== null) {
          stream.write(value, typeof encoding === "string" ? encoding : void 0);
        }
        writableEnded = true;
        const done = typeof encoding === "function" ? encoding : callback;
        queueMicrotask(() => {
          done?.();
          writableFinished = true;
          emit("finish");
          closed = true;
          emit("close");
        });
        return stream;
      },
      on: (event, listener) => {
        on(event, listener);
        return stream;
      },
      addListener: (event, listener) => {
        on(event, listener);
        return stream;
      },
      removeListener: (event, listener) => {
        removeListener(event, listener);
        return stream;
      },
      off: (event, listener) => {
        removeListener(event, listener);
        return stream;
      },
      emit,
      destroy: (error) => {
        if (destroyed) return stream;
        destroyed = true;
        queueMicrotask(() => {
          if (error) emit("error", error);
          closed = true;
          emit("close");
        });
        return stream;
      },
      close: (callback) => {
        if (callback) stream.once("close", callback);
        return stream.destroy();
      },
      get destroyed() {
        return destroyed;
      },
      once: (event, listener) => {
        const wrapped = (...args) => {
          removeListener(event, wrapped);
          listener(...args);
        };
        on(event, wrapped);
        return stream;
      }
    };
    return stream;
  };
  const eventLoopApi = createBrowserEventLoopApi(executionState);
  const stdinDevice = createReadableStdinDevice(
    (size) => readDeviceBytes("/dev/stdin", size),
    () => remainingDeviceBytes("/dev/stdin"),
    () => deviceInputClosed("/dev/stdin"),
    eventLoopApi.setTimeout
  );
  const processApi = {
    argv: processArgvForRequest(request),
    env: request.env,
    cwd: () => request.cwd,
    stdin: stdinDevice,
    stdout: createWritableDevice("/dev/stdout", 1),
    stderr: createWritableDevice("/dev/stderr", 2),
    exit: (code = 0) => {
      throw Object.assign(new Error(`process.exit(${code})`), {
        exitCode: Number(code) || 0,
        suppressStderr: true
      });
    }
  };
  const nodePathSearchEntries = nodePathEntries(request, cwdPath, workspacePathContext);
  const syncTextModule = (path, bytes) => {
    const text = textFromBytes(bytes);
    if (byteEqual(utf8Bytes(text), bytes)) {
      modules.set(path, text);
    } else {
      modules.delete(path);
    }
  };
  const fsWatchers = /* @__PURE__ */ new Set();
  const fsFileWatchers = /* @__PURE__ */ new Set();
  const inodeForPath = (path) => {
    let hash = 2166136261;
    for (let index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0 || 1;
  };
  const statForNormalizedPath = (normalized) => {
    const isFile = fileStore.has(normalized);
    const prefix = normalized ? `${normalized}/` : "";
    const isDirectory = !isFile && (directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix)));
    if (!isFile && !isDirectory) return null;
    const metadata = entryMetadata.get(normalized) ?? createEntryMetadata(isDirectory ? 16877 : 33188);
    const size = isFile ? fileStore.get(normalized)?.byteLength ?? 0 : 0;
    const mode = metadata.mode ?? (isDirectory ? 16877 : 33188);
    return {
      atimeMs: metadata.atimeMs,
      birthtimeMs: metadata.birthtimeMs,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      ctimeMs: metadata.ctimeMs,
      dev: 1,
      gid: metadata.gid,
      ino: isFile ? linkedInodeForPath(normalized) : inodeForPath(normalized),
      mode,
      mtimeMs: metadata.mtimeMs,
      nlink: isDirectory ? 2 : hardLinkGroupForPath(normalized).size,
      rdev: 0,
      size,
      uid: metadata.uid,
      atime: new Date(metadata.atimeMs),
      birthtime: new Date(metadata.birthtimeMs),
      ctime: new Date(metadata.ctimeMs),
      mtime: new Date(metadata.mtimeMs),
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      isSocket: () => false,
      isSymbolicLink: () => false
    };
  };
  const statForKernelPath = (path, kernelStat) => {
    const modeType = kernelStat.isDirectory ? 16384 : kernelStat.isCharacterDevice ? 8192 : 32768;
    const mode = modeType | kernelStat.mode;
    return {
      atimeMs: fsTimestampMs,
      birthtimeMs: fsTimestampMs,
      blksize: 4096,
      blocks: Math.ceil(kernelStat.size / 512),
      ctimeMs: fsTimestampMs,
      dev: 1,
      gid: 0,
      ino: inodeForPath(path),
      mode,
      mtimeMs: fsTimestampMs,
      nlink: kernelStat.isDirectory ? 2 : 1,
      rdev: 0,
      size: kernelStat.size,
      uid: 0,
      atime: new Date(fsTimestampMs),
      birthtime: new Date(fsTimestampMs),
      ctime: new Date(fsTimestampMs),
      mtime: new Date(fsTimestampMs),
      isBlockDevice: () => false,
      isCharacterDevice: () => kernelStat.isCharacterDevice,
      isFIFO: () => false,
      isFile: () => kernelStat.isFile,
      isDirectory: () => kernelStat.isDirectory,
      isSocket: () => false,
      isSymbolicLink: () => false
    };
  };
  const statForKernelTarget = (path, options2) => {
    const statTarget = runtimeStatTarget(path, kernelInfo, kernelDevices, procSnapshot);
    if (!statTarget || statTarget.kind === "workspace") return null;
    if (statTarget.kind === "error") {
      if (options2?.throwIfNoEntry === false) return void 0;
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
    }
    return statForKernelPath(statTarget.path, statTarget.stat);
  };
  const browserFileSystemStat = (bigint = false) => {
    const stats = {
      type: 1953653605,
      bsize: 4096,
      blocks: 1048576,
      bfree: 1048e3,
      bavail: 1048e3,
      files: 1e6,
      ffree: 999e3
    };
    if (!bigint) return stats;
    return Object.fromEntries(
      Object.entries(stats).map(([key, value]) => [key, BigInt(value)])
    );
  };
  const browserStatsResult = (stats, options2) => {
    if (!options2?.bigint) return stats;
    return {
      ...stats,
      atimeMs: BigInt(Math.trunc(stats.atimeMs)),
      birthtimeMs: BigInt(Math.trunc(stats.birthtimeMs)),
      blksize: BigInt(stats.blksize),
      blocks: BigInt(stats.blocks),
      ctimeMs: BigInt(Math.trunc(stats.ctimeMs)),
      dev: BigInt(stats.dev),
      gid: BigInt(stats.gid),
      ino: BigInt(stats.ino),
      mode: BigInt(stats.mode),
      mtimeMs: BigInt(Math.trunc(stats.mtimeMs)),
      nlink: BigInt(stats.nlink),
      rdev: BigInt(stats.rdev),
      size: BigInt(stats.size),
      uid: BigInt(stats.uid)
    };
  };
  const missingFileStat = () => ({
    atime: /* @__PURE__ */ new Date(0),
    atimeMs: 0,
    birthtime: /* @__PURE__ */ new Date(0),
    birthtimeMs: 0,
    blksize: 4096,
    blocks: 0,
    ctime: /* @__PURE__ */ new Date(0),
    ctimeMs: 0,
    dev: 1,
    gid: 0,
    ino: 0,
    mode: 0,
    mtime: /* @__PURE__ */ new Date(0),
    mtimeMs: 0,
    nlink: 0,
    rdev: 0,
    size: 0,
    uid: 0,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isFile: () => false,
    isDirectory: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false
  });
  const watchedFilename = (watcher, changedPath) => {
    if (changedPath === watcher.path) return changedPath.split("/").pop() ?? changedPath;
    const prefix = watcher.path ? `${watcher.path}/` : "";
    if (!changedPath.startsWith(prefix)) return null;
    const relative = changedPath.slice(prefix.length);
    if (!watcher.recursive && relative.includes("/")) return null;
    return relative;
  };
  const emitFsWatch = (watcher, eventType, filename) => {
    if (watcher.closed) return;
    for (const listener of watcher.listeners.get("change") ?? []) listener(eventType, filename);
  };
  const notifyFsWatchers = (eventType, path) => {
    for (const watcher of fsWatchers) {
      const filename = watchedFilename(watcher, path);
      if (filename !== null) queueMicrotask(() => emitFsWatch(watcher, eventType, filename));
    }
  };
  const notifyWatchFileWatchers = (path) => {
    for (const watcher of fsFileWatchers) {
      if (watcher.path !== path) continue;
      const previous = watcher.previous;
      const current = statForNormalizedPath(path) ?? missingFileStat();
      watcher.previous = current;
      queueMicrotask(() => watcher.listener(current, previous));
    }
  };
  const notifyDirectoryMutation = (path) => {
    notifyFsWatchers("rename", path);
    notifyWatchFileWatchers(path);
  };
  const emitDirectoryCreate = (path) => {
    if (!path) return;
    io.fileChange({ path, directory: true }, "live");
  };
  const emitDirectoryDelete = (path) => {
    if (!path) return;
    io.fileChange({ path, directory: true, deleted: true }, "live");
  };
  const assertReadonlyFilePath = (normalized, operation) => {
    if (readonlyFiles.has(normalized) || isHiddenNamespacePath(normalized)) {
      throw createRuntimeKernelReadonlyFileError(normalized, operation);
    }
  };
  const setFileBytes = (path, bytes) => {
    const linkedPaths = Array.from(hardLinkGroupForPath(path)).filter((linkedPath) => fileStore.has(linkedPath) || linkedPath === path);
    for (const linkedPath of linkedPaths) {
      assertReadonlyFilePath(linkedPath, "write");
    }
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directoryPath = parts.slice(0, index).join("/");
      const existed = directoryStore.has(directoryPath);
      directoryStore.add(directoryPath);
      if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
      if (!existed) emitDirectoryCreate(directoryPath);
    }
    for (const linkedPath of linkedPaths) {
      fileStore.set(linkedPath, bytes);
      touchEntryMetadata(linkedPath);
      syncTextModule(linkedPath, bytes);
      cache.delete(linkedPath);
      io.fileChange(bytesToRuntimeFile(linkedPath, bytes), "live");
      notifyFsWatchers("change", linkedPath);
      notifyWatchFileWatchers(linkedPath);
    }
  };
  const createEventTarget = () => {
    const listeners = /* @__PURE__ */ new Map();
    const listenerTarget = (listener) => listener.listener ?? listener;
    const on = (event, listener) => {
      const next = listeners.get(event) ?? [];
      next.push(listener);
      listeners.set(event, next);
    };
    const prependListener = (event, listener) => {
      const next = listeners.get(event) ?? [];
      next.unshift(listener);
      listeners.set(event, next);
    };
    const removeListener = (event, listener) => {
      const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener && listenerTarget(candidate) !== listener);
      if (next.length === 0) listeners.delete(event);
      else listeners.set(event, next);
    };
    const once = (event, listener, prepend = false) => {
      const wrapped = (...args) => {
        removeListener(event, wrapped);
        listener(...args);
      };
      Object.defineProperty(wrapped, "listener", { value: listener });
      if (prepend) prependListener(event, wrapped);
      else on(event, wrapped);
    };
    return {
      emit: (event, ...args) => {
        const current = listeners.get(event) ?? [];
        for (const listener of current) listener(...args);
        return current.length > 0;
      },
      on,
      addListener: on,
      prependListener,
      removeListener,
      off: removeListener,
      once: (event, listener) => once(event, listener),
      prependOnceListener: (event, listener) => once(event, listener, true),
      removeAllListeners: (event) => {
        if (typeof event === "string") listeners.delete(event);
        else listeners.clear();
      },
      listenerCount: (event) => listeners.get(event)?.length ?? 0,
      listeners: (event) => (listeners.get(event) ?? []).map(listenerTarget),
      rawListeners: (event) => [...listeners.get(event) ?? []],
      eventNames: () => [...listeners.keys()]
    };
  };
  const createReadableStream = (bytes, encoding, onClose) => {
    const events = createEventTarget();
    let started = false;
    let closed = false;
    let destroyed = false;
    let ended = false;
    let offset = 0;
    let streamEncoding = encoding;
    let readableFlowing = null;
    const pipeBindings = [];
    const closeStream = () => {
      if (closed) return;
      closed = true;
      onClose?.();
      events.emit("close");
    };
    const formatChunk = (chunk) => {
      const buffer = BrowserBuffer.from(chunk);
      return streamEncoding ? buffer.toString(streamEncoding) : buffer;
    };
    const readChunk = (size) => {
      if (destroyed || offset >= bytes.byteLength) {
        ended = offset >= bytes.byteLength;
        return null;
      }
      const requested = typeof size === "number" && size >= 0 ? Math.floor(size) : bytes.byteLength - offset;
      const end = Math.min(bytes.byteLength, offset + requested);
      const chunk = bytes.slice(offset, end);
      offset = end;
      if (offset >= bytes.byteLength) ended = true;
      return formatChunk(chunk);
    };
    const scheduleRead = () => {
      if (started) return;
      if (readableFlowing === false) return;
      started = true;
      queueMicrotask(() => {
        if (closed || destroyed) return;
        const chunk = readChunk();
        if (chunk !== null && (typeof chunk !== "string" || chunk.length > 0) && (!(chunk instanceof Uint8Array) || chunk.byteLength > 0)) {
          events.emit("data", chunk);
        }
        events.emit("end");
        closeStream();
      });
    };
    const stream = {
      readable: true,
      get closed() {
        return closed;
      },
      get destroyed() {
        return destroyed;
      },
      get readableEnded() {
        return ended;
      },
      get readableEncoding() {
        return streamEncoding ?? null;
      },
      get readableLength() {
        return Math.max(0, bytes.byteLength - offset);
      },
      get readableFlowing() {
        return readableFlowing;
      },
      setEncoding: (nextEncoding) => {
        streamEncoding = nextEncoding;
        return stream;
      },
      read: (size) => readChunk(size),
      on: (event, listener) => {
        events.on(event, listener);
        if (event === "data") {
          if (readableFlowing === null) readableFlowing = true;
          scheduleRead();
        } else if (event === "end") {
          scheduleRead();
        }
        return stream;
      },
      addListener: (event, listener) => {
        stream.on(event, listener);
        return stream;
      },
      prependListener: (event, listener) => {
        events.prependListener(event, listener);
        if (event === "data") {
          if (readableFlowing === null) readableFlowing = true;
          scheduleRead();
        } else if (event === "end") {
          scheduleRead();
        }
        return stream;
      },
      removeListener: (event, listener) => {
        events.removeListener(event, listener);
        return stream;
      },
      off: (event, listener) => {
        events.off(event, listener);
        return stream;
      },
      emit: (event, ...args) => events.emit(event, ...args),
      once: (event, listener) => {
        events.once(event, listener);
        if (event === "data") {
          if (readableFlowing === null) readableFlowing = true;
          scheduleRead();
        } else if (event === "end") {
          scheduleRead();
        }
        return stream;
      },
      prependOnceListener: (event, listener) => {
        events.prependOnceListener(event, listener);
        if (event === "data") {
          if (readableFlowing === null) readableFlowing = true;
          scheduleRead();
        } else if (event === "end") {
          scheduleRead();
        }
        return stream;
      },
      removeAllListeners: (event) => {
        events.removeAllListeners(event);
        return stream;
      },
      listenerCount: (event) => events.listenerCount(event),
      listeners: (event) => events.listeners(event),
      rawListeners: (event) => events.rawListeners(event),
      eventNames: () => events.eventNames(),
      pause: () => {
        readableFlowing = false;
        return stream;
      },
      resume: () => {
        readableFlowing = true;
        scheduleRead();
        return stream;
      },
      destroy: (error) => {
        if (destroyed) return stream;
        destroyed = true;
        if (error) events.emit("error", error);
        closeStream();
        return stream;
      },
      close: (callback) => {
        if (callback) stream.once("close", callback);
        closeStream();
        return stream;
      },
      pipe: (destination, options2) => {
        const onData = (chunk) => destination.write?.(chunk);
        const onEnd = () => {
          if (options2?.end !== false) destination.end?.();
        };
        pipeBindings.push({ destination, onData, onEnd });
        events.on("data", onData);
        events.on("end", onEnd);
        destination.emit?.("pipe", stream);
        readableFlowing = true;
        scheduleRead();
        return destination;
      },
      unpipe: (destination) => {
        for (let index = pipeBindings.length - 1; index >= 0; index -= 1) {
          const binding = pipeBindings[index];
          if (!destination || binding.destination === destination) {
            events.removeListener("data", binding.onData);
            events.removeListener("end", binding.onEnd);
            binding.destination.emit?.("unpipe", stream);
            pipeBindings.splice(index, 1);
          }
        }
        return stream;
      }
    };
    return stream;
  };
  const createWritableStream = (path, options2) => {
    const events = createEventTarget();
    const optionFd = typeof options2 === "object" && typeof options2?.fd === "number" ? options2.fd : null;
    const encoding = requestedEncodingFromOptions(options2);
    const flags = typeof options2 === "object" && typeof options2?.flags === "string" ? options2.flags : "w";
    const parsed = parseOpenFlags(flags);
    const openTarget = optionFd === null ? runtimeOpenTarget(path, {
      ...parsed,
      writable: parsed.writable,
      create: parsed.create,
      truncate: parsed.truncate
    }, kernelDevices, procSnapshot) : null;
    if (openTarget?.kind === "error") {
      throw Object.assign(new Error(runtimeKernelOpenErrorMessage(String(path), openTarget)), {
        code: runtimeKernelOpenErrorCode(openTarget.reason)
      });
    }
    const device = openTarget?.kind === "device" ? openTarget.device : null;
    const autoClose = typeof options2 === "object" && options2?.autoClose === false ? false : true;
    const normalized = device || optionFd !== null ? null : assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
    if (normalized !== null) {
      assertWorkspaceFileWritePath(normalized, path, "write");
      if (!parsed.create && !fileStore.has(normalized)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
      }
      if (parsed.exclusive && fileStore.has(normalized)) {
        throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
      }
    }
    if (normalized !== null && parsed.truncate) {
      setFileBytes(normalized, new Uint8Array());
    }
    let closed = false;
    let destroyed = false;
    let bytesWritten = 0;
    let writableEnded = false;
    let writableFinished = false;
    let writableCorked = 0;
    let writeOffset = typeof options2 === "object" && typeof options2?.start === "number" ? Math.max(0, options2.start) : 0;
    const hasExplicitWriteStart = typeof options2 === "object" && typeof options2?.start === "number";
    const writeBytes = (value, writeEncoding) => {
      if (writableEnded) {
        throw Object.assign(new Error("ERR_STREAM_WRITE_AFTER_END: write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
      }
      if (closed || destroyed) {
        throw Object.assign(new Error("ERR_STREAM_DESTROYED: Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" });
      }
      const bytes = bytesFromFsWriteValue(value, writeEncoding ?? encoding);
      if (optionFd !== null) {
        if (hasExplicitWriteStart) {
          const entry = fileDescriptor(optionFd);
          const previousAppend = entry.append;
          entry.append = false;
          try {
            writeDescriptorBytes(entry, bytes, writeOffset);
          } finally {
            entry.append = previousAppend;
          }
          writeOffset += bytes.byteLength;
        } else {
          writeDescriptorFileBytes(optionFd, bytes, flags.includes("a"));
        }
        bytesWritten += bytes.byteLength;
        return bytes.byteLength;
      }
      if (device) {
        writeDevice(device, textFromBytes(bytes));
        bytesWritten += bytes.byteLength;
        return bytes.byteLength;
      }
      if (!parsed.writable) {
        throw Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" });
      }
      const previous = fileStore.get(normalized ?? "") ?? new Uint8Array();
      const start = parsed.append ? previous.byteLength : writeOffset;
      const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
      next.set(previous, 0);
      next.set(bytes, start);
      setFileBytes(normalized ?? "", next);
      writeOffset = start + bytes.byteLength;
      bytesWritten += bytes.byteLength;
      return bytes.byteLength;
    };
    const closeStream = (emitFinish, done, error) => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        if (error) events.emit("error", error);
        done?.();
        if (autoClose && optionFd !== null) fsApi.closeSync(optionFd);
        if (emitFinish) {
          writableFinished = true;
          events.emit("finish");
        }
        events.emit("close");
      });
    };
    const stream = {
      writable: true,
      get closed() {
        return closed;
      },
      get destroyed() {
        return destroyed;
      },
      get bytesWritten() {
        return bytesWritten;
      },
      get writableEnded() {
        return writableEnded;
      },
      get writableFinished() {
        return writableFinished;
      },
      get writableLength() {
        return 0;
      },
      get writableNeedDrain() {
        return false;
      },
      get writableCorked() {
        return writableCorked;
      },
      on: (event, listener) => {
        events.on(event, listener);
        return stream;
      },
      addListener: (event, listener) => {
        stream.on(event, listener);
        return stream;
      },
      prependListener: (event, listener) => {
        events.prependListener(event, listener);
        return stream;
      },
      removeListener: (event, listener) => {
        events.removeListener(event, listener);
        return stream;
      },
      off: (event, listener) => {
        events.off(event, listener);
        return stream;
      },
      emit: (event, ...args) => events.emit(event, ...args),
      once: (event, listener) => {
        events.once(event, listener);
        return stream;
      },
      prependOnceListener: (event, listener) => {
        events.prependOnceListener(event, listener);
        return stream;
      },
      removeAllListeners: (event) => {
        events.removeAllListeners(event);
        return stream;
      },
      listenerCount: (event) => events.listenerCount(event),
      listeners: (event) => events.listeners(event),
      rawListeners: (event) => events.rawListeners(event),
      eventNames: () => events.eventNames(),
      cork: () => {
        writableCorked += 1;
      },
      uncork: () => {
        writableCorked = Math.max(0, writableCorked - 1);
      },
      write: (value, writeEncoding, callback) => {
        const done = typeof writeEncoding === "function" ? writeEncoding : callback;
        try {
          writeBytes(value, typeof writeEncoding === "string" ? writeEncoding : void 0);
          done?.(null);
          return true;
        } catch (error) {
          const streamError = error;
          done?.(streamError);
          events.emit("error", streamError);
          return false;
        }
      },
      end: (value, writeEncoding, callback) => {
        const done = typeof writeEncoding === "function" ? writeEncoding : callback;
        if (value !== void 0 && value !== null) {
          try {
            writeBytes(value, typeof writeEncoding === "string" ? writeEncoding : void 0);
          } catch (error) {
            writableEnded = true;
            closeStream(false, void 0, error);
            return stream;
          }
        }
        writableEnded = true;
        closeStream(true, done);
        return stream;
      },
      destroy: (error) => {
        if (destroyed) return stream;
        destroyed = true;
        closeStream(false, void 0, error);
        return stream;
      },
      close: (callback) => {
        if (callback) stream.once("close", callback);
        closeStream(false);
        return stream;
      }
    };
    return stream;
  };
  const assertStreamRangeInteger = (name, value) => {
    if (value === void 0) return void 0;
    if (!Number.isInteger(value) || Number(value) < 0) {
      throw Object.assign(new RangeError(`The value of "${name}" is out of range.`), { code: "ERR_OUT_OF_RANGE" });
    }
    return Number(value);
  };
  const deleteFile = (path) => {
    const removeTarget = runtimeRemoveTarget(path, kernelDevices);
    if (removeTarget?.kind === "error") {
      const message = removeTarget.reason === "device-not-found" ? `ENOENT: no such file or directory, unlink '${path}'` : `EROFS: read-only file system, unlink '${path}'`;
      throwRuntimeRemoveTargetError(removeTarget, message);
    }
    const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
    assertReadonlyFilePath(normalized, "delete");
    if (!fileStore.delete(normalized)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${path}'`), { code: "ENOENT" });
    }
    detachOpenFileDescriptorsForPath(normalized);
    unlinkPathFromHardLinks(normalized);
    modules.delete(normalized);
    cache.delete(normalized);
    deleteEntryMetadata(normalized);
    io.fileChange({ path: normalized, deleted: true }, "live");
    notifyFsWatchers("rename", normalized);
    notifyWatchFileWatchers(normalized);
  };
  const fsConstants = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 64,
    O_EXCL: 128,
    O_TRUNC: 512,
    O_APPEND: 1024,
    S_IFMT: 61440,
    S_IFREG: 32768,
    S_IFDIR: 16384,
    S_IFLNK: 40960,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4
  };
  let mkdtempCounter = 0;
  const fileSystemEntryExists = (path) => {
    const accessTarget = runtimeAccessTarget(path, fsConstants.F_OK, kernelDevices, procSnapshot);
    if (accessTarget?.kind === "allowed") return true;
    if (accessTarget?.kind === "denied") return false;
    const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
    if (readTarget?.kind === "device-file" || readTarget?.kind === "device-directory" || readTarget?.kind === "proc-file" || readTarget?.kind === "proc-directory") {
      return true;
    }
    if (readTarget?.kind === "error") return false;
    const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
    const prefix = normalized ? `${normalized}/` : "";
    return fileStore.has(normalized) || directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
  };
  const isWorkspaceDirectoryPath = (normalized) => {
    const prefix = normalized ? `${normalized}/` : "";
    return directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
  };
  const workspaceFileAncestor = (normalized) => {
    const parts = normalized.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directoryPath = parts.slice(0, index).join("/");
      if (fileStore.has(directoryPath)) return directoryPath;
    }
    return null;
  };
  const assertWorkspaceParentDirectoryPath = (normalized, path, syscall) => {
    if (workspaceFileAncestor(normalized) !== null) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, ${syscall} '${path}'`), { code: "ENOTDIR" });
    }
    const parent = dirname(normalized);
    const parentPath = parent === "" ? "" : parent;
    if (parentPath && !directoryStore.has(parentPath)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: "ENOENT" });
    }
  };
  const assertWorkspaceFileWritePath = (normalized, path, operation, syscall = operation) => {
    if (!normalized) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`), { code: "EISDIR" });
    }
    assertReadonlyFilePath(normalized, operation);
    assertWorkspaceParentDirectoryPath(normalized, path, syscall);
    if (isWorkspaceDirectoryPath(normalized)) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`), { code: "EISDIR" });
    }
  };
  const assertFileSystemAccess = (path, mode = fsConstants.F_OK) => {
    const requested = Number(mode) || fsConstants.F_OK;
    const accessTarget = runtimeAccessTarget(path, requested, kernelDevices, procSnapshot);
    if (accessTarget?.kind === "allowed") return;
    if (accessTarget?.kind === "denied") {
      const code = accessTarget.reason === "not-found" ? "ENOENT" : "EACCES";
      const reason = accessTarget.reason === "not-found" ? "no such file or directory" : "permission denied";
      throw Object.assign(new Error(`${code}: ${reason}, access '${path}'`), { code });
    }
    const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
    if (workspaceFileAncestor(normalized) !== null) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, access '${path}'`), { code: "ENOTDIR" });
    }
    const stats = statForNormalizedPath(normalized);
    if (!stats) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: "ENOENT" });
    }
    const permissionMode = stats.mode & 511;
    const readable = (permissionMode & 292) !== 0;
    const writable = (permissionMode & 146) !== 0;
    const executable = (permissionMode & 73) !== 0;
    if ((requested & fsConstants.R_OK) !== 0 && !readable || (requested & fsConstants.W_OK) !== 0 && !writable || (requested & fsConstants.X_OK) !== 0 && !executable) {
      throw Object.assign(new Error(`EACCES: permission denied, access '${path}'`), { code: "EACCES" });
    }
  };
  const notifyMetadataMutation = (path) => {
    notifyFsWatchers("change", path);
    notifyWatchFileWatchers(path);
  };
  const metadataPathForEntry = (path) => {
    const metadataTarget = runtimeMetadataTarget(path, kernelDevices);
    if (metadataTarget?.kind === "ignored-device") return null;
    if (metadataTarget?.kind === "error") {
      const message = metadataTarget.reason === "proc-read-only" ? `EROFS: read-only file system, metadata '${path}'` : `ENOENT: no such file or directory, metadata '${path}'`;
      throwRuntimeMetadataTargetError(metadataTarget, message);
    }
    const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
    if (workspaceFileAncestor(normalized) !== null) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, metadata '${path}'`), { code: "ENOTDIR" });
    }
    if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
    }
    return normalized;
  };
  const timeToMs = (value) => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return Math.max(0, value * 1e3);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed * 1e3) : fsTimestampMs;
  };
  const stdioDescriptor = (device, append = false) => ({
    kind: "device",
    device,
    offset: 0,
    readable: runtimeKernelDeviceInputSource(kernelDevices, device) !== null,
    writable: runtimeKernelDeviceOutputTarget(kernelDevices, device) !== null,
    append
  });
  const fileDescriptors = /* @__PURE__ */ new Map([
    [0, stdioDescriptor("/dev/stdin")],
    [1, stdioDescriptor("/dev/stdout", true)],
    [2, stdioDescriptor("/dev/stderr", true)]
  ]);
  let nextFd = 3;
  const workspaceFileDescriptorRecords = () => [...fileDescriptors.values()].filter((entry) => entry.kind === "file");
  const detachOpenFileDescriptorsForPath = (path) => {
    const bytes = fileStore.get(path);
    for (const entry of workspaceFileDescriptorRecords()) {
      if (entry.path !== path) continue;
      entry.bytes = new Uint8Array(bytes ?? entry.bytes ?? new Uint8Array());
      entry.path = void 0;
    }
  };
  const moveOpenFileDescriptorPath = (oldPath, newPath) => {
    for (const entry of workspaceFileDescriptorRecords()) {
      if (entry.path === oldPath) entry.path = newPath;
    }
  };
  const parseOpenFlags = (flags = "r") => {
    if (typeof flags === "number") {
      const access = flags & 3;
      return {
        readable: access === 0 || access === 2,
        writable: access === 1 || access === 2,
        append: (flags & 1024) !== 0,
        truncate: (flags & 512) !== 0,
        create: (flags & 64) !== 0,
        exclusive: (flags & 128) !== 0
      };
    }
    const text = String(flags);
    return {
      readable: text.includes("+") || text.startsWith("r"),
      writable: text.includes("+") || text.startsWith("w") || text.startsWith("a"),
      append: text.startsWith("a"),
      truncate: text.startsWith("w"),
      create: text.startsWith("w") || text.startsWith("a"),
      exclusive: text.includes("x")
    };
  };
  const fileDescriptor = (fd2) => {
    const entry = fileDescriptors.get(Number(fd2));
    if (!entry) throw Object.assign(new Error(`EBADF: bad file descriptor, fd ${fd2}`), { code: "EBADF" });
    return entry;
  };
  const descriptorMetadataPath = (fd2, operation) => {
    const entry = fileDescriptor(fd2);
    if (entry.kind === "file" && !entry.path) return null;
    const path = entry.kind === "device" ? entry.device ?? "/dev/stdin" : entry.path ?? "";
    const metadataTarget = runtimeKernelMetadataTarget(path, kernelDevices);
    if (metadataTarget.kind === "ignored-device") return null;
    if (metadataTarget.kind === "error") {
      const message = metadataTarget.reason === "proc-read-only" ? `EROFS: read-only file system, ${operation}` : `ENOENT: no such file or directory, ${operation}`;
      throwRuntimeMetadataTargetError(metadataTarget, message);
    }
    return path;
  };
  const descriptorBytes = (entry) => {
    if (entry.kind === "device") return utf8Bytes(readDevice(entry.device ?? "/dev/stdin"));
    if (entry.kind === "proc") return utf8Bytes(browserProcFileContents(procSnapshot, entry.path ?? "", kernelInfo));
    if (entry.kind === "directory") {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${entry.path ?? ""}'`), { code: "EISDIR" });
    }
    if (entry.path && fileStore.has(entry.path)) return fileStore.get(entry.path) ?? new Uint8Array();
    return entry.bytes ?? new Uint8Array();
  };
  const readDescriptorFileBytes = (fd2) => {
    const entry = fileDescriptor(fd2);
    if (!entry.readable) throw Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" });
    if (entry.kind === "device") return readDeviceBytes(entry.device ?? "/dev/stdin");
    const source = descriptorBytes(entry);
    const start = entry.offset;
    const bytes = source.slice(start);
    entry.offset = source.byteLength;
    return bytes;
  };
  const writeDescriptorBytes = (entry, bytes, position) => {
    if (!entry.writable) throw Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" });
    if (entry.kind === "device") {
      writeDevice(entry.device ?? "/dev/stdout", textFromBytes(bytes));
      return;
    }
    if (entry.kind === "proc") {
      throw Object.assign(new Error(`EROFS: read-only file system, write '${entry.path ?? "/proc"}'`), { code: "EROFS" });
    }
    const previous = descriptorBytes(entry);
    const start = entry.append ? previous.byteLength : typeof position === "number" ? Math.max(0, position) : entry.offset;
    const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
    next.set(previous, 0);
    next.set(bytes, start);
    entry.bytes = next;
    if (entry.path && fileStore.has(entry.path)) setFileBytes(entry.path, next);
    if (position === void 0 || position === null) entry.offset = start + bytes.byteLength;
  };
  const writeDescriptorFileBytes = (fd2, bytes, append = false) => {
    const entry = fileDescriptor(fd2);
    const position = append && entry.kind !== "device" ? descriptorBytes(entry).byteLength : null;
    writeDescriptorBytes(entry, bytes, position);
    if (append && entry.kind !== "device" && typeof position === "number") entry.offset = position + bytes.byteLength;
  };
  const truncateFileBytes = (path, length = 0) => {
    const previous = fileStore.get(path);
    if (!previous) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, truncate '${path}'`), { code: "ENOENT" });
    }
    const size = Math.max(0, Number(length) || 0);
    const next = new Uint8Array(size);
    next.set(previous.slice(0, Math.min(previous.byteLength, size)));
    setFileBytes(path, next);
  };
  const truncateDescriptorBytes = (entry, length = 0) => {
    if (entry.kind !== "file") {
      if (entry.kind === "device") throw Object.assign(new Error("EINVAL: invalid argument, ftruncate"), { code: "EINVAL" });
      throw Object.assign(new Error(`EROFS: read-only file system, ftruncate '${entry.path ?? ""}'`), { code: "EROFS" });
    }
    const previous = descriptorBytes(entry);
    const size = Math.max(0, Number(length) || 0);
    const next = new Uint8Array(size);
    next.set(previous.slice(0, Math.min(previous.byteLength, size)));
    entry.bytes = next;
    if (entry.path && fileStore.has(entry.path)) setFileBytes(entry.path, next);
    if (entry.offset > size) entry.offset = size;
  };
  const realpathForEntry = (path) => {
    const accessTarget = runtimeAccessTarget(path, 0, kernelDevices, procSnapshot);
    if (accessTarget?.kind === "allowed") return accessTarget.path;
    if (accessTarget?.kind === "denied") {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: "ENOENT" });
    }
    const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
    if (readTarget?.kind === "device-file" || readTarget?.kind === "proc-file" || readTarget?.kind === "proc-directory") {
      return readTarget.path;
    }
    if (readTarget?.kind === "device-directory") return readTarget.path;
    if (readTarget?.kind === "error") {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: "ENOENT" });
    }
    const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
    if (workspaceFileAncestor(normalized) !== null) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, realpath '${path}'`), { code: "ENOTDIR" });
    }
    if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: "ENOENT" });
    }
    return workspaceFilename(normalized, workspaceRoot);
  };
  const copyEntrySync = (source, destination, options2 = {}) => {
    const copyTarget = runtimeCopyTarget(source, destination, kernelDevices, procSnapshot);
    if (copyTarget?.kind === "file-copy") {
      fsApi.copyFileSync(source, destination);
      return;
    }
    if (copyTarget?.kind === "error") {
      throw Object.assign(new Error(runtimeKernelCopyErrorMessage(String(source), String(destination), copyTarget)), {
        code: runtimeKernelCopyErrorCode(copyTarget.reason)
      });
    }
    const normalizedSource = normalizeWorkspaceEntryPath(source, cwdPath, true, workspacePathContext);
    const normalizedDestination = normalizeWorkspaceEntryPath(destination, cwdPath, true, workspacePathContext);
    const sourcePath = workspaceFilename(normalizedSource, workspaceRoot);
    const destinationPath = workspaceFilename(normalizedDestination, workspaceRoot);
    if (options2.filter && !options2.filter(sourcePath, destinationPath)) return;
    if (normalizedSource === normalizedDestination) {
      throw Object.assign(new Error(`${source} and dest cannot be the same ${destination}`), {
        code: "ERR_FS_CP_EINVAL"
      });
    }
    const destinationExists = fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination);
    if (destinationExists && options2.force === false) {
      if (options2.errorOnExist) {
        throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: "EEXIST" });
      }
      return;
    }
    const sourceBytes = fileStore.get(normalizedSource);
    if (sourceBytes) {
      setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
      return;
    }
    const sourcePrefix = normalizedSource ? `${normalizedSource}/` : "";
    const descendantFiles = Array.from(fileStore.entries()).filter(([filePath]) => filePath.startsWith(sourcePrefix));
    const descendantDirectories = Array.from(directoryStore).filter(
      (directoryPath) => directoryPath === normalizedSource || directoryPath.startsWith(sourcePrefix)
    );
    if (!directoryStore.has(normalizedSource) && descendantFiles.length === 0 && descendantDirectories.length === 0) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, cp '${source}' -> '${destination}'`), { code: "ENOENT" });
    }
    if (!options2.recursive) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, cp '${source}'`), { code: "EISDIR" });
    }
    if (normalizedDestination.startsWith(`${normalizedSource}/`)) {
      throw Object.assign(new Error(`Cannot copy ${source}/ to a subdirectory of self ${destination}`), {
        code: "ERR_FS_CP_EINVAL"
      });
    }
    if (fileStore.has(normalizedDestination)) {
      throw Object.assign(new Error(`Cannot overwrite non-directory ${destination} with directory ${source}`), {
        code: "ERR_FS_CP_DIR_TO_NON_DIR"
      });
    }
    const destinationDirectoryExisted = directoryStore.has(normalizedDestination);
    directoryStore.add(normalizedDestination);
    if (!destinationDirectoryExisted) emitDirectoryCreate(normalizedDestination);
    for (const directoryPath of descendantDirectories) {
      const relative = directoryPath === normalizedSource ? "" : directoryPath.slice(sourcePrefix.length);
      const nextDirectory = relative ? `${normalizedDestination}/${relative}` : normalizedDestination;
      if (options2.filter && !options2.filter(workspaceFilename(directoryPath, workspaceRoot), workspaceFilename(nextDirectory, workspaceRoot))) {
        continue;
      }
      const existed = directoryStore.has(nextDirectory);
      directoryStore.add(nextDirectory);
      if (!existed) emitDirectoryCreate(nextDirectory);
    }
    for (const [filePath, bytes] of descendantFiles) {
      const relative = filePath.slice(sourcePrefix.length);
      const nextPath = normalizedDestination ? `${normalizedDestination}/${relative}` : relative;
      if (options2.filter && !options2.filter(workspaceFilename(filePath, workspaceRoot), workspaceFilename(nextPath, workspaceRoot))) {
        continue;
      }
      setFileBytes(nextPath, new Uint8Array(bytes));
    }
  };
  const fsApi = {
    constants: fsConstants,
    F_OK: fsConstants.F_OK,
    R_OK: fsConstants.R_OK,
    W_OK: fsConstants.W_OK,
    X_OK: fsConstants.X_OK,
    O_RDONLY: fsConstants.O_RDONLY,
    O_WRONLY: fsConstants.O_WRONLY,
    O_RDWR: fsConstants.O_RDWR,
    O_CREAT: fsConstants.O_CREAT,
    O_EXCL: fsConstants.O_EXCL,
    O_TRUNC: fsConstants.O_TRUNC,
    O_APPEND: fsConstants.O_APPEND,
    S_IFMT: fsConstants.S_IFMT,
    S_IFREG: fsConstants.S_IFREG,
    S_IFDIR: fsConstants.S_IFDIR,
    S_IFLNK: fsConstants.S_IFLNK,
    COPYFILE_EXCL: fsConstants.COPYFILE_EXCL,
    COPYFILE_FICLONE: fsConstants.COPYFILE_FICLONE,
    COPYFILE_FICLONE_FORCE: fsConstants.COPYFILE_FICLONE_FORCE,
    accessSync: (path, mode = fsConstants.F_OK) => {
      assertFileSystemAccess(path, mode);
    },
    access: (path, mode, callback) => {
      const done = typeof mode === "function" ? mode : callback;
      try {
        assertFileSystemAccess(path, typeof mode === "number" ? mode : fsConstants.F_OK);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    chmodSync: (path, mode) => {
      const normalized = metadataPathForEntry(path);
      if (normalized !== null) {
        const stats = statForNormalizedPath(normalized);
        const typeMode = stats?.isDirectory() ? 16384 : 32768;
        updateEntryMetadata(normalized, { mode: typeMode | Number(mode) & 4095 });
        notifyMetadataMutation(normalized);
      }
      return void 0;
    },
    chmod: (path, mode, callback) => {
      try {
        fsApi.chmodSync(path, mode);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    chownSync: (path, uid, gid) => {
      const normalized = metadataPathForEntry(path);
      if (normalized !== null) {
        updateEntryMetadata(normalized, { uid: Number(uid) || 0, gid: Number(gid) || 0 });
        notifyMetadataMutation(normalized);
      }
      return void 0;
    },
    chown: (path, uid, gid, callback) => {
      try {
        fsApi.chownSync(path, uid, gid);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    utimesSync: (path, atime, mtime) => {
      const normalized = metadataPathForEntry(path);
      if (normalized !== null) {
        updateEntryMetadata(normalized, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
        notifyMetadataMutation(normalized);
      }
      return void 0;
    },
    utimes: (path, atime, mtime, callback) => {
      try {
        fsApi.utimesSync(path, atime, mtime);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    watch: (path, optionsOrListener, listener) => {
      assertFileSystemAccess(path);
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      const listeners = /* @__PURE__ */ new Map();
      const on = (event, callback) => {
        const next = listeners.get(event) ?? [];
        next.push(callback);
        listeners.set(event, next);
      };
      const watcher = {
        path: normalized,
        recursive: typeof optionsOrListener === "object" && optionsOrListener?.recursive === true,
        closed: false,
        listeners
      };
      const initialListener = typeof optionsOrListener === "function" ? optionsOrListener : listener;
      if (initialListener) on("change", initialListener);
      fsWatchers.add(watcher);
      const api = {
        on: (event, callback) => {
          on(event, callback);
          return api;
        },
        once: (event, callback) => {
          const wrapped = (...args) => {
            const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped);
            listeners.set(event, next);
            callback(...args);
          };
          on(event, wrapped);
          return api;
        },
        close: () => {
          watcher.closed = true;
          fsWatchers.delete(watcher);
          for (const closeListener of listeners.get("close") ?? []) closeListener();
        }
      };
      return api;
    },
    watchFile: (path, optionsOrListener, listener) => {
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      const changeListener = typeof optionsOrListener === "function" ? optionsOrListener : listener;
      if (!changeListener) {
        throw new TypeError('The "listener" argument must be of type function');
      }
      const watcher = {
        path: normalized,
        listener: changeListener,
        previous: statForNormalizedPath(normalized) ?? missingFileStat()
      };
      fsFileWatchers.add(watcher);
      const api = {
        ref: () => api,
        unref: () => api,
        close: () => {
          fsFileWatchers.delete(watcher);
        },
        on: (_event, nextListener) => {
          if (typeof nextListener === "function") watcher.listener = nextListener;
          return api;
        },
        addListener: (_event, nextListener) => {
          if (typeof nextListener === "function") watcher.listener = nextListener;
          return api;
        },
        removeListener: () => api
      };
      return api;
    },
    unwatchFile: (path, listener) => {
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      for (const watcher of Array.from(fsFileWatchers)) {
        if (watcher.path === normalized && (!listener || watcher.listener === listener)) {
          fsFileWatchers.delete(watcher);
        }
      }
    },
    openSync: (path, flags = "r") => {
      const parsed = parseOpenFlags(flags);
      const openTarget = runtimeOpenTarget(path, parsed, kernelDevices, procSnapshot);
      const fd2 = nextFd++;
      if (openTarget?.kind === "error") {
        throw Object.assign(new Error(runtimeKernelOpenErrorMessage(String(path), openTarget)), {
          code: runtimeKernelOpenErrorCode(openTarget.reason)
        });
      }
      if (openTarget?.kind === "device") {
        fileDescriptors.set(fd2, {
          kind: "device",
          device: openTarget.device,
          offset: 0,
          readable: openTarget.readable,
          writable: openTarget.writable,
          append: true
        });
        return fd2;
      }
      if (openTarget?.kind === "proc-file") {
        fileDescriptors.set(fd2, {
          kind: "proc",
          path: openTarget.path,
          offset: 0,
          readable: openTarget.readable,
          writable: openTarget.writable,
          append: false
        });
        return fd2;
      }
      const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      const directoryPrefix = normalized ? `${normalized}/` : "";
      const isDirectory = directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(directoryPrefix));
      if (isDirectory) {
        if (parsed.writable || parsed.create || parsed.truncate) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
        }
        fileDescriptors.set(fd2, {
          kind: "directory",
          path: normalized,
          offset: 0,
          readable: true,
          writable: false,
          append: false
        });
        return fd2;
      }
      if (!fileStore.has(normalized)) {
        if (!parsed.create) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
        }
        assertWorkspaceFileWritePath(normalized, path, "write", "open");
        setFileBytes(normalized, new Uint8Array());
      } else if (parsed.exclusive) {
        throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
      } else if (parsed.truncate) {
        assertWorkspaceFileWritePath(normalized, path, "truncate", "open");
        setFileBytes(normalized, new Uint8Array());
      }
      fileDescriptors.set(fd2, {
        kind: "file",
        path: normalized,
        bytes: new Uint8Array(fileStore.get(normalized) ?? new Uint8Array()),
        offset: parsed.append ? fileStore.get(normalized)?.byteLength ?? 0 : 0,
        readable: parsed.readable,
        writable: parsed.writable,
        append: parsed.append
      });
      return fd2;
    },
    open: (path, flags, modeOrCallback, callback) => {
      const done = typeof flags === "function" ? flags : typeof modeOrCallback === "function" ? modeOrCallback : callback;
      const openFlags = typeof flags === "function" || flags === void 0 ? "r" : flags;
      try {
        const fd2 = fsApi.openSync(path, openFlags);
        queueMicrotask(() => done?.(null, fd2));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    closeSync: (fd2) => {
      if (Number(fd2) < 3) return void 0;
      if (!fileDescriptors.delete(Number(fd2))) {
        throw Object.assign(new Error(`EBADF: bad file descriptor, close`), { code: "EBADF" });
      }
      return void 0;
    },
    close: (fd2, callback) => {
      try {
        fsApi.closeSync(fd2);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    readSync: (fd2, buffer, offset = 0, length = buffer.byteLength - offset, position) => {
      const entry = fileDescriptor(fd2);
      if (!entry.readable) throw Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" });
      if (entry.kind === "device") {
        const bytes = readDeviceBytes(entry.device ?? "/dev/stdin", Math.max(0, Math.min(length, buffer.byteLength - offset)));
        buffer.set(bytes, offset);
        return bytes.byteLength;
      }
      const source = descriptorBytes(entry);
      const start = typeof position === "number" ? Math.max(0, position) : entry.offset;
      const count = Math.max(0, Math.min(length, source.byteLength - start, buffer.byteLength - offset));
      buffer.set(source.slice(start, start + count), offset);
      if (position === void 0 || position === null) entry.offset = start + count;
      return count;
    },
    read: (fd2, buffer, offsetOrOptions, lengthOrCallback, positionOrCallback, callback) => {
      const options2 = typeof offsetOrOptions === "object" && offsetOrOptions !== null ? offsetOrOptions : void 0;
      const done = typeof offsetOrOptions === "function" ? offsetOrOptions : typeof lengthOrCallback === "function" ? lengthOrCallback : typeof positionOrCallback === "function" ? positionOrCallback : callback;
      const offset = options2?.offset ?? (typeof offsetOrOptions === "number" ? offsetOrOptions : 0);
      const length = options2?.length ?? (typeof lengthOrCallback === "number" ? lengthOrCallback : buffer.byteLength - offset);
      let position;
      if (options2 !== void 0) {
        position = options2.position;
      } else if (typeof positionOrCallback === "number") {
        position = positionOrCallback;
      } else {
        position = null;
      }
      try {
        const bytesRead = fsApi.readSync(fd2, buffer, offset, length, position);
        queueMicrotask(() => done?.(null, bytesRead, buffer));
      } catch (error) {
        queueMicrotask(() => done?.(error, void 0, buffer));
      }
    },
    readvSync: (fd2, buffers, position) => {
      let bytesRead = 0;
      let nextPosition = typeof position === "number" ? Math.max(0, position) : position;
      for (const buffer of buffers) {
        const count = fsApi.readSync(fd2, buffer, 0, buffer.byteLength, nextPosition);
        bytesRead += count;
        if (typeof nextPosition === "number") nextPosition += count;
        if (count === 0) break;
      }
      return bytesRead;
    },
    readv: (fd2, buffers, positionOrCallback, callback) => {
      const done = typeof positionOrCallback === "function" ? positionOrCallback : callback;
      const position = typeof positionOrCallback === "function" ? void 0 : positionOrCallback;
      try {
        const bytesRead = fsApi.readvSync(fd2, buffers, position);
        queueMicrotask(() => done?.(null, bytesRead, buffers));
      } catch (error) {
        queueMicrotask(() => done?.(error, void 0, buffers));
      }
    },
    writeSync: (fd2, value, offsetOrPosition, lengthOrEncoding, position) => {
      let bytes;
      let writePosition = position;
      if (typeof value === "string") {
        bytes = BrowserBuffer.from(value, typeof lengthOrEncoding === "string" ? lengthOrEncoding : void 0);
        writePosition = typeof offsetOrPosition === "number" ? offsetOrPosition : void 0;
      } else {
        const source = bytesFromNodeValue(value);
        const offset = typeof offsetOrPosition === "number" ? offsetOrPosition : 0;
        const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : source.byteLength - offset;
        bytes = source.slice(offset, offset + length);
      }
      writeDescriptorBytes(fileDescriptor(fd2), bytes, writePosition);
      return bytes.byteLength;
    },
    write: (fd2, value, offsetOrPosition, lengthOrEncoding, positionOrCallback, callback) => {
      const options2 = typeof offsetOrPosition === "object" && offsetOrPosition !== null ? offsetOrPosition : void 0;
      const done = typeof offsetOrPosition === "function" ? offsetOrPosition : typeof lengthOrEncoding === "function" ? lengthOrEncoding : typeof positionOrCallback === "function" ? positionOrCallback : callback;
      let writePosition;
      if (options2 !== void 0) {
        writePosition = options2.position;
      } else if (typeof positionOrCallback === "number") {
        writePosition = positionOrCallback;
      } else if (positionOrCallback === null) {
        writePosition = null;
      }
      try {
        const written = fsApi.writeSync(
          fd2,
          value,
          options2?.offset ?? (typeof offsetOrPosition === "number" ? offsetOrPosition : void 0),
          options2?.length ?? options2?.encoding ?? (typeof lengthOrEncoding === "number" || typeof lengthOrEncoding === "string" ? lengthOrEncoding : void 0),
          writePosition
        );
        queueMicrotask(() => done?.(null, written, value));
      } catch (error) {
        queueMicrotask(() => done?.(error, void 0, value));
      }
    },
    writevSync: (fd2, buffers, position) => {
      let bytesWritten = 0;
      let nextPosition = typeof position === "number" ? Math.max(0, position) : position;
      for (const buffer of buffers) {
        const written = fsApi.writeSync(fd2, buffer, 0, buffer.byteLength, nextPosition);
        bytesWritten += written;
        if (typeof nextPosition === "number") nextPosition += written;
      }
      return bytesWritten;
    },
    writev: (fd2, buffers, positionOrCallback, callback) => {
      const done = typeof positionOrCallback === "function" ? positionOrCallback : callback;
      const position = typeof positionOrCallback === "function" ? void 0 : positionOrCallback;
      try {
        const bytesWritten = fsApi.writevSync(fd2, buffers, position);
        queueMicrotask(() => done?.(null, bytesWritten, buffers));
      } catch (error) {
        queueMicrotask(() => done?.(error, void 0, buffers));
      }
    },
    fstatSync: (fd2, options2) => {
      const entry = fileDescriptor(fd2);
      let stats;
      if (entry.kind === "device") {
        const statTarget = runtimeKernelStatTarget(entry.device ?? "/dev/stdin", kernelInfo, kernelDevices);
        stats = statTarget.kind === "stat" ? statForKernelPath(statTarget.path, statTarget.stat) : missingFileStat();
      } else if (entry.kind === "proc") {
        stats = statForKernelTarget(entry.path ?? "") ?? missingFileStat();
      } else if (entry.kind === "directory") {
        stats = statForNormalizedPath(entry.path ?? "") ?? missingFileStat();
      } else {
        stats = entry.path && fileStore.has(entry.path) ? statForNormalizedPath(entry.path) ?? missingFileStat() : {
          ...missingFileStat(),
          size: descriptorBytes(entry).byteLength,
          isFile: () => true,
          isDirectory: () => false
        };
      }
      return browserStatsResult(stats, options2);
    },
    fstat: (fd2, optionsOrCallback, callback) => {
      const options2 = typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback;
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const stats = fsApi.fstatSync(fd2, options2);
        queueMicrotask(() => done?.(null, stats));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    fchmodSync: (fd2, mode) => {
      const path = descriptorMetadataPath(fd2, "fchmod");
      if (path !== null) {
        const stats = statForNormalizedPath(path);
        const typeMode = stats?.isDirectory() ? 16384 : 32768;
        updateEntryMetadata(path, { mode: typeMode | Number(mode) & 4095 });
        notifyMetadataMutation(path);
      }
      return void 0;
    },
    fchmod: (fd2, mode, callback) => {
      try {
        fsApi.fchmodSync(fd2, mode);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    fchownSync: (fd2, uid, gid) => {
      const path = descriptorMetadataPath(fd2, "fchown");
      if (path !== null) {
        updateEntryMetadata(path, { uid: Number(uid) || 0, gid: Number(gid) || 0 });
        notifyMetadataMutation(path);
      }
      return void 0;
    },
    fchown: (fd2, uid, gid, callback) => {
      try {
        fsApi.fchownSync(fd2, uid, gid);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    futimesSync: (fd2, atime, mtime) => {
      const path = descriptorMetadataPath(fd2, "futimes");
      if (path !== null) {
        updateEntryMetadata(path, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
        notifyMetadataMutation(path);
      }
      return void 0;
    },
    futimes: (fd2, atime, mtime, callback) => {
      try {
        fsApi.futimesSync(fd2, atime, mtime);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    ftruncateSync: (fd2, length = 0) => {
      const entry = fileDescriptor(fd2);
      if (!entry.writable) throw Object.assign(new Error("EBADF: bad file descriptor, ftruncate"), { code: "EBADF" });
      truncateDescriptorBytes(entry, length);
      return void 0;
    },
    ftruncate: (fd2, lengthOrCallback, callback) => {
      const done = typeof lengthOrCallback === "function" ? lengthOrCallback : callback;
      try {
        fsApi.ftruncateSync(fd2, typeof lengthOrCallback === "number" ? lengthOrCallback : 0);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    fsyncSync: (fd2) => {
      fileDescriptor(fd2);
      return void 0;
    },
    fsync: (fd2, callback) => {
      try {
        fsApi.fsyncSync(fd2);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    fdatasyncSync: (fd2) => {
      fileDescriptor(fd2);
      return void 0;
    },
    fdatasync: (fd2, callback) => {
      try {
        fsApi.fdatasyncSync(fd2);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    createReadStream: (path, options2) => {
      const optionFd = typeof options2 === "object" && typeof options2?.fd === "number" ? options2.fd : null;
      const readTarget = optionFd === null ? runtimeFileReadTarget(path, kernelDevices, procSnapshot) : null;
      const requestedEncoding = typeof options2 === "string" ? options2 : options2?.encoding;
      let sourceBytes;
      if (readTarget?.kind === "device-file") sourceBytes = utf8Bytes(readDevice(readTarget.path));
      else if (readTarget?.kind === "proc-file") sourceBytes = utf8Bytes(browserProcFileContents(procSnapshot, readTarget.path, kernelInfo));
      else if (readTarget?.kind === "error") {
        throwRuntimeReadTargetError(readTarget, runtimeKernelFileReadFsErrorMessage(String(path), readTarget));
      } else if (optionFd !== null) {
        const entry = fileDescriptor(optionFd);
        if (!entry.readable) throw Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" });
        if (typeof options2 === "object" && typeof options2?.start === "number") {
          sourceBytes = descriptorBytes(entry);
        } else {
          sourceBytes = readDescriptorFileBytes(optionFd);
        }
      } else {
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        if (workspaceFileAncestor(normalized) !== null) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: "ENOTDIR" });
        }
        if (isWorkspaceDirectoryPath(normalized)) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
        }
        sourceBytes = fileStore.get(normalized);
      }
      if (!sourceBytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
      }
      const requestedStart = typeof options2 === "object" ? assertStreamRangeInteger("start", options2?.start) : void 0;
      const requestedEnd = typeof options2 === "object" ? assertStreamRangeInteger("end", options2?.end) : void 0;
      if (requestedStart !== void 0 && requestedEnd !== void 0 && requestedEnd < requestedStart) {
        throw Object.assign(new RangeError('The value of "start" is out of range.'), { code: "ERR_OUT_OF_RANGE" });
      }
      const start = requestedStart ?? 0;
      const endInclusive = requestedEnd ?? sourceBytes.byteLength - 1;
      const autoClose = typeof options2 === "object" && options2?.autoClose === false ? false : true;
      return createReadableStream(
        sourceBytes.slice(start, Math.max(start, endInclusive + 1)),
        requestedEncoding,
        autoClose && optionFd !== null ? () => fsApi.closeSync(optionFd) : void 0
      );
    },
    createWriteStream: createWritableStream,
    readFileSync: (path, encoding) => {
      const requestedEncoding = typeof encoding === "string" ? encoding : encoding?.encoding;
      if (typeof path === "number") {
        const bytes2 = BrowserBuffer.from(readDescriptorFileBytes(path));
        return typeof requestedEncoding === "string" ? bytes2.toString(requestedEncoding) : bytes2;
      }
      const readTarget = runtimeFileReadTarget(path, kernelDevices, procSnapshot);
      if (readTarget?.kind === "device-file") {
        const contents = readDevice(readTarget.path);
        if (typeof requestedEncoding === "string") return BrowserBuffer.from(contents).toString(requestedEncoding);
        return BrowserBuffer.from(contents);
      }
      if (readTarget?.kind === "proc-file") {
        const contents = browserProcFileContents(procSnapshot, readTarget.path, kernelInfo);
        if (typeof requestedEncoding === "string") return BrowserBuffer.from(contents).toString(requestedEncoding);
        return BrowserBuffer.from(contents);
      }
      if (readTarget?.kind === "error") {
        throwRuntimeReadTargetError(readTarget, runtimeKernelFileReadFsErrorMessage(String(path), readTarget));
      }
      const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      if (workspaceFileAncestor(normalized) !== null) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: "ENOTDIR" });
      }
      if (isWorkspaceDirectoryPath(normalized)) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
      }
      const bytes = fileStore.get(normalized);
      if (!bytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
      }
      if (typeof requestedEncoding === "string") {
        return BrowserBuffer.from(bytes).toString(requestedEncoding);
      }
      return BrowserBuffer.from(bytes);
    },
    readFile: (path, encodingOrCallback, callback) => {
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      try {
        const data = fsApi.readFileSync(path, typeof encodingOrCallback === "function" ? void 0 : encodingOrCallback);
        queueMicrotask(() => done?.(null, data));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    writeFileSync: (path, value, options2) => {
      if (typeof path === "number") {
        writeDescriptorFileBytes(path, bytesFromFsWriteValue(value, options2));
        return;
      }
      const writeTarget = runtimeWriteTarget(path, kernelDevices);
      if (writeTarget?.kind === "error") {
        throwRuntimeWriteTargetError(writeTarget, runtimeKernelWriteFsErrorMessage(String(path), writeTarget));
      }
      if (writeTarget?.kind === "device") {
        writeDevice(writeTarget.device, textFromBytes(bytesFromFsWriteValue(value, options2)));
        return;
      }
      const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      assertWorkspaceFileWritePath(normalized, path, "write", "open");
      setFileBytes(normalized, bytesFromFsWriteValue(value, options2));
    },
    writeFile: (path, value, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        fsApi.writeFileSync(path, value, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    appendFileSync: (path, value, options2) => {
      if (typeof path === "number") {
        writeDescriptorFileBytes(path, bytesFromFsWriteValue(value, options2), true);
        return;
      }
      const writeTarget = runtimeWriteTarget(path, kernelDevices);
      if (writeTarget?.kind === "error") {
        throwRuntimeWriteTargetError(writeTarget, runtimeKernelWriteFsErrorMessage(String(path), writeTarget));
      }
      if (writeTarget?.kind === "device") {
        writeDevice(writeTarget.device, textFromBytes(bytesFromFsWriteValue(value, options2)));
        return;
      }
      const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      assertWorkspaceFileWritePath(normalized, path, "append", "open");
      const previous = fileStore.get(normalized) ?? new Uint8Array();
      const next = bytesFromFsWriteValue(value, options2);
      const combined = new Uint8Array(previous.byteLength + next.byteLength);
      combined.set(previous, 0);
      combined.set(next, previous.byteLength);
      setFileBytes(normalized, combined);
    },
    appendFile: (path, value, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        fsApi.appendFileSync(path, value, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    copyFileSync: (source, destination, mode = 0) => {
      const copyTarget = runtimeFileCopyTarget(source, destination, kernelDevices, procSnapshot);
      if (copyTarget?.kind === "error" && copyTarget.side === "destination") {
        throw Object.assign(new Error(runtimeKernelFileCopyErrorMessage(String(source), String(destination), copyTarget)), {
          code: runtimeKernelFileCopyErrorCode(copyTarget)
        });
      }
      let sourceBytes;
      const sourceTarget = copyTarget?.kind === "virtual-source" || copyTarget?.kind === "device-destination" ? copyTarget.source : runtimeFileReadTarget(source, kernelDevices, procSnapshot);
      if (sourceTarget?.kind === "device-file") sourceBytes = utf8Bytes(readDevice(sourceTarget.path));
      else if (sourceTarget?.kind === "proc-file") sourceBytes = utf8Bytes(browserProcFileContents(procSnapshot, sourceTarget.path, kernelInfo));
      else if (copyTarget?.kind === "error" && copyTarget.side === "source") {
        throw Object.assign(new Error(runtimeKernelFileCopyErrorMessage(String(source), String(destination), copyTarget)), {
          code: runtimeKernelFileCopyErrorCode(copyTarget)
        });
      } else if (sourceTarget?.kind === "error") {
        throwRuntimeReadTargetError(sourceTarget, sourceTarget.reason === "is-directory" ? `EISDIR: illegal operation on a directory, copyfile '${source}' -> '${destination}'` : sourceTarget.reason === "permission-denied" ? `EBADF: bad file descriptor, copyfile '${source}' -> '${destination}'` : `ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`);
      } else sourceBytes = fileStore.get(assertSafeWorkspaceFilePath(source, cwdPath, workspacePathContext));
      if (!sourceBytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`), { code: "ENOENT" });
      }
      if (copyTarget?.kind === "device-destination") {
        writeDevice(copyTarget.device, textFromBytes(sourceBytes));
        return;
      }
      const normalizedDestination = assertSafeWorkspaceFilePath(destination, cwdPath, workspacePathContext);
      assertWorkspaceFileWritePath(normalizedDestination, destination, "copy", "copyfile");
      if ((Number(mode) & fsConstants.COPYFILE_EXCL) !== 0 && fileSystemEntryExists(workspaceFilename(normalizedDestination, workspaceRoot))) {
        throw Object.assign(new Error(`EEXIST: file already exists, copyfile '${source}' -> '${destination}'`), { code: "EEXIST" });
      }
      setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
    },
    copyFile: (source, destination, modeOrCallback, callback) => {
      const done = typeof modeOrCallback === "function" ? modeOrCallback : callback;
      try {
        fsApi.copyFileSync(source, destination, typeof modeOrCallback === "number" ? modeOrCallback : 0);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    linkSync: (existingPath, newPath) => {
      const linkTarget = runtimeLinkTarget(existingPath, newPath, kernelDevices);
      if (linkTarget?.kind === "error") {
        throwRuntimeLinkTargetError(
          linkTarget,
          runtimeKernelMutationFsErrorMessage(String(existingPath), linkTarget, "link", String(newPath))
        );
      }
      const normalizedSource = assertSafeWorkspaceFilePath(existingPath, cwdPath, workspacePathContext);
      const normalizedDestination = assertSafeWorkspaceFilePath(newPath, cwdPath, workspacePathContext);
      const bytes = fileStore.get(normalizedSource);
      if (!bytes) {
        const sourceIsDirectory = directoryStore.has(normalizedSource) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(`${normalizedSource}/`));
        if (sourceIsDirectory) {
          throw Object.assign(new Error(`EPERM: operation not permitted, link '${existingPath}' -> '${newPath}'`), { code: "EPERM" });
        }
        throw Object.assign(new Error(`ENOENT: no such file or directory, link '${existingPath}' -> '${newPath}'`), { code: "ENOENT" });
      }
      assertReadonlyFilePath(normalizedSource, "link");
      if (fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination)) {
        throw Object.assign(new Error(`EEXIST: file already exists, link '${existingPath}' -> '${newPath}'`), { code: "EEXIST" });
      }
      assertWorkspaceFileWritePath(normalizedDestination, newPath, "link");
      fileStore.set(normalizedDestination, bytes);
      touchEntryMetadata(normalizedDestination);
      linkPaths(normalizedSource, normalizedDestination);
      syncTextModule(normalizedDestination, bytes);
      cache.delete(normalizedDestination);
      io.fileChange(bytesToRuntimeFile(normalizedDestination, bytes), "live");
      notifyFsWatchers("change", normalizedDestination);
      notifyWatchFileWatchers(normalizedDestination);
    },
    link: (existingPath, newPath, callback) => {
      try {
        fsApi.linkSync(existingPath, newPath);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    symlinkSync: (_target, linkPath) => {
      const symlinkTarget = runtimeSymlinkTarget(linkPath, kernelDevices);
      if (symlinkTarget?.kind === "error") {
        throwRuntimeSymlinkTargetError(symlinkTarget, runtimeKernelMutationFsErrorMessage(String(linkPath), symlinkTarget, "symlink"));
      }
      throw Object.assign(new Error(`ENOSYS: function not implemented, symlink '${linkPath}'`), { code: "ENOSYS" });
    },
    symlink: (target, linkPath, typeOrCallback, callback) => {
      const done = typeof typeOrCallback === "function" ? typeOrCallback : callback;
      try {
        fsApi.symlinkSync(target, linkPath);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    readlinkSync: (path, _options) => {
      const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
      if (readTarget?.kind && readTarget.kind !== "workspace") {
        throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: "EINVAL" });
      }
      assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: "EINVAL" });
    },
    readlink: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const linkString = fsApi.readlinkSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, linkString));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    cpSync: (source, destination, options2) => {
      copyEntrySync(source, destination, options2);
      return void 0;
    },
    cp: (source, destination, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        fsApi.cpSync(source, destination, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    renameSync: (oldPath, newPath) => {
      const renameTarget = runtimeRenameTarget(oldPath, newPath, kernelDevices);
      if (renameTarget?.kind === "error") {
        throwRuntimeRenameTargetError(
          renameTarget,
          runtimeKernelMutationFsErrorMessage(String(oldPath), renameTarget, "rename", String(newPath))
        );
      }
      const normalizedOldPath = assertSafeWorkspaceFilePath(oldPath, cwdPath, workspacePathContext);
      const normalizedNewPath = assertSafeWorkspaceFilePath(newPath, cwdPath, workspacePathContext);
      if (normalizedOldPath === normalizedNewPath) {
        const prefix = normalizedOldPath ? `${normalizedOldPath}/` : "";
        if (fileStore.has(normalizedOldPath) || directoryStore.has(normalizedOldPath) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix)) || Array.from(directoryStore).some((directoryPath) => directoryPath.startsWith(prefix))) {
          return;
        }
        throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: "ENOENT" });
      }
      const bytes = fileStore.get(normalizedOldPath);
      if (bytes) {
        assertReadonlyFilePath(normalizedOldPath, "move");
        assertWorkspaceFileWritePath(normalizedNewPath, newPath, "move", "rename");
        fileStore.delete(normalizedOldPath);
        moveOpenFileDescriptorPath(normalizedOldPath, normalizedNewPath);
        moveHardLinkPath(normalizedOldPath, normalizedNewPath);
        modules.delete(normalizedOldPath);
        cache.delete(normalizedOldPath);
        deleteEntryMetadata(normalizedOldPath);
        io.fileChange({ path: normalizedOldPath, deleted: true }, "live");
        notifyFsWatchers("rename", normalizedOldPath);
        notifyWatchFileWatchers(normalizedOldPath);
        setFileBytes(normalizedNewPath, bytes);
        notifyFsWatchers("rename", normalizedNewPath);
        return;
      }
      const oldPrefix = normalizedOldPath ? `${normalizedOldPath}/` : "";
      const sourceDirectories = Array.from(directoryStore).filter((directoryPath) => directoryPath === normalizedOldPath || directoryPath.startsWith(oldPrefix)).sort((left, right) => left.localeCompare(right));
      const sourceFiles = Array.from(fileStore.entries()).filter(([filePath]) => filePath.startsWith(oldPrefix)).sort(([left], [right]) => left.localeCompare(right));
      if (sourceDirectories.length === 0 && sourceFiles.length === 0) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: "ENOENT" });
      }
      for (const [filePath] of sourceFiles) {
        assertReadonlyFilePath(filePath, "move");
      }
      assertReadonlyFilePath(normalizedNewPath, "move");
      assertWorkspaceParentDirectoryPath(normalizedNewPath, newPath, "rename");
      if (fileStore.has(normalizedNewPath)) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, rename '${oldPath}' -> '${newPath}'`), { code: "ENOTDIR" });
      }
      const existingDestinationFiles = fileStore.has(normalizedNewPath) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(`${normalizedNewPath}/`));
      const existingDestinationDirectories = directoryStore.has(normalizedNewPath) || Array.from(directoryStore).some((directoryPath) => directoryPath.startsWith(`${normalizedNewPath}/`));
      if (existingDestinationFiles || existingDestinationDirectories) {
        throw Object.assign(new Error(`EEXIST: file already exists, rename '${oldPath}' -> '${newPath}'`), { code: "EEXIST" });
      }
      for (const [filePath] of sourceFiles) {
        fileStore.delete(filePath);
        const relative = filePath.slice(oldPrefix.length);
        const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
        moveOpenFileDescriptorPath(filePath, nextPath);
        moveHardLinkPath(filePath, nextPath);
        modules.delete(filePath);
        cache.delete(filePath);
        deleteEntryMetadata(filePath);
        io.fileChange({ path: filePath, deleted: true }, "live");
        notifyFsWatchers("rename", filePath);
        notifyWatchFileWatchers(filePath);
      }
      for (const directoryPath of [...sourceDirectories].sort((left, right) => right.length - left.length || right.localeCompare(left))) {
        directoryStore.delete(directoryPath);
        deleteEntryMetadata(directoryPath);
        emitDirectoryDelete(directoryPath);
        notifyDirectoryMutation(directoryPath);
      }
      for (const directoryPath of sourceDirectories) {
        const relative = directoryPath === normalizedOldPath ? "" : directoryPath.slice(oldPrefix.length);
        const nextDirectory = relative ? `${normalizedNewPath}/${relative}` : normalizedNewPath;
        const existed = directoryStore.has(nextDirectory);
        directoryStore.add(nextDirectory);
        if (!entryMetadata.has(nextDirectory)) touchEntryMetadata(nextDirectory);
        if (!existed) {
          emitDirectoryCreate(nextDirectory);
          notifyDirectoryMutation(nextDirectory);
        }
      }
      for (const [filePath, fileBytes2] of sourceFiles) {
        const relative = filePath.slice(oldPrefix.length);
        const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
        setFileBytes(nextPath, fileBytes2);
        notifyFsWatchers("rename", nextPath);
      }
    },
    rename: (oldPath, newPath, callback) => {
      try {
        fsApi.renameSync(oldPath, newPath);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    unlinkSync: deleteFile,
    unlink: (path, callback) => {
      try {
        fsApi.unlinkSync(path);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    rmSync: (path, options2) => {
      try {
        const removeTarget = runtimeRemoveTarget(path, kernelDevices);
        if (removeTarget?.kind === "error") {
          throwRuntimeRemoveTargetError(removeTarget, runtimeKernelMutationFsErrorMessage(String(path), removeTarget, "rm"));
        }
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        if (fileStore.has(normalized)) {
          deleteFile(path);
          return;
        }
        const prefix = normalized ? `${normalized}/` : "";
        assertWorkspaceParentDirectoryPath(normalized, path, "rm");
        const descendantFiles = Array.from(fileStore.keys()).filter((filePath) => filePath.startsWith(prefix));
        const descendantDirectories = Array.from(directoryStore).filter((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
        if (directoryStore.has(normalized) || descendantFiles.length > 0 || descendantDirectories.length > 0) {
          if (!options2?.recursive) {
            throw Object.assign(new Error(`ERR_FS_EISDIR: path is a directory, rm '${path}'`), { code: "ERR_FS_EISDIR" });
          }
          for (const filePath of descendantFiles) {
            assertReadonlyFilePath(filePath, "delete");
          }
          for (const filePath of descendantFiles) {
            fileStore.delete(filePath);
            modules.delete(filePath);
            cache.delete(filePath);
            deleteEntryMetadata(filePath);
            io.fileChange({ path: filePath, deleted: true }, "live");
            notifyFsWatchers("rename", filePath);
            notifyWatchFileWatchers(filePath);
          }
          for (const directoryPath of Array.from(directoryStore)) {
            if (directoryPath === normalized || directoryPath.startsWith(prefix)) {
              directoryStore.delete(directoryPath);
              deleteEntryMetadata(directoryPath);
              emitDirectoryDelete(directoryPath);
              notifyDirectoryMutation(directoryPath);
            }
          }
          return;
        }
        if (!options2?.force) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${path}'`), { code: "ENOENT" });
        }
      } catch (error) {
        if (options2?.force && error.code === "ENOENT") return;
        throw error;
      }
    },
    rm: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        fsApi.rmSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    existsSync: (path) => {
      try {
        const accessTarget = runtimeAccessTarget(path, fsConstants.F_OK, kernelDevices, procSnapshot);
        if (accessTarget?.kind === "allowed") return true;
        if (accessTarget?.kind === "denied") return false;
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        const prefix = normalized ? `${normalized}/` : "";
        return fileStore.has(normalized) || directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
      } catch {
        return false;
      }
    },
    exists: (path, callback) => {
      queueMicrotask(() => callback?.(fsApi.existsSync(path)));
    },
    readdirSync: (path, options2) => {
      const directoryTarget = runtimeDirectoryTarget(path, kernelDevices, procSnapshot);
      const withFileTypes = typeof options2 === "object" && options2?.withFileTypes === true;
      const makeDirent = (name, type, parentPath, characterDevice = false) => ({
        name,
        path: parentPath,
        parentPath,
        isBlockDevice: () => false,
        isCharacterDevice: () => characterDevice,
        isDirectory: () => type === "directory",
        isFIFO: () => false,
        isFile: () => type === "file",
        isSocket: () => false,
        isSymbolicLink: () => false
      });
      if (directoryTarget?.kind === "directory") {
        const names = directoryTarget.entries.map((entry) => entry.name);
        if (!withFileTypes) return names;
        return directoryTarget.entries.map((entry) => makeDirent(
          entry.name,
          entry.kind === "directory" ? "directory" : "file",
          directoryTarget.path,
          directoryTarget.path === "/dev" && entry.kind === "file"
        ));
      }
      if (directoryTarget?.kind === "error") {
        throwRuntimeDirectoryTargetError(directoryTarget, directoryTarget.reason === "not-directory" ? `ENOTDIR: not a directory, scandir '${path}'` : `ENOENT: no such file or directory, scandir '${path}'`);
      }
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (workspaceFileAncestor(normalized) !== null || fileStore.has(normalized)) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, scandir '${path}'`), { code: "ENOTDIR" });
      }
      const prefix = normalized ? `${normalized}/` : "";
      const recursive = typeof options2 === "object" && options2?.recursive === true;
      const makeWorkspaceDirent = (name, type, parentPath = normalized) => makeDirent(name, type, workspaceFilename(parentPath, workspaceRoot));
      if (recursive) {
        const entries2 = /* @__PURE__ */ new Map();
        for (const directoryPath of directoryStore) {
          if (directoryPath === normalized || !directoryPath.startsWith(prefix)) continue;
          const rest = directoryPath.slice(prefix.length);
          if (rest) entries2.set(rest, "directory");
        }
        for (const filePath of fileStore.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          if (rest) entries2.set(rest, "file");
        }
        if (entries2.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: "ENOENT" });
        }
        const sortedEntries2 = Array.from(entries2.entries()).sort(([left], [right]) => left.localeCompare(right));
        if (!withFileTypes) return sortedEntries2.map(([name]) => name);
        return sortedEntries2.map(([relativePath, type]) => {
          const parts = relativePath.split("/");
          const name = parts.pop() ?? relativePath;
          const parentPath = parts.length === 0 ? normalized : normalized ? `${normalized}/${parts.join("/")}` : parts.join("/");
          return makeWorkspaceDirent(name, type, parentPath);
        });
      }
      const entries = /* @__PURE__ */ new Map();
      for (const filePath of fileStore.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (!rest) continue;
        const [name, ...remaining] = rest.split("/");
        if (!name) continue;
        entries.set(name, remaining.length > 0 ? "directory" : "file");
      }
      for (const directoryPath of directoryStore) {
        if (!directoryPath.startsWith(prefix)) continue;
        const rest = directoryPath.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split("/")[0] ?? rest;
        if (!entries.has(name)) entries.set(name, "directory");
      }
      if (entries.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: "ENOENT" });
      }
      const sortedEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
      if (!withFileTypes) return sortedEntries.map(([name]) => name);
      return sortedEntries.map(([name, type]) => makeWorkspaceDirent(name, type));
    },
    readdir: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const entries = fsApi.readdirSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, entries));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    opendirSync: (path) => {
      const entries = fsApi.readdirSync(path, { withFileTypes: true });
      let index = 0;
      let closed = false;
      const assertOpen = () => {
        if (closed) throw Object.assign(new Error("ERR_DIR_CLOSED: Directory handle was closed"), { code: "ERR_DIR_CLOSED" });
      };
      const dir = {
        path: fsApi.realpathSync(path),
        readSync: () => {
          assertOpen();
          return entries[index++] ?? null;
        },
        read: (callback) => {
          try {
            const entry = dir.readSync();
            queueMicrotask(() => callback?.(null, entry));
          } catch (error) {
            queueMicrotask(() => callback?.(error));
          }
        },
        closeSync: () => {
          closed = true;
        },
        close: (callback) => {
          closed = true;
          queueMicrotask(() => callback?.(null));
        },
        async *[Symbol.asyncIterator]() {
          while (true) {
            const entry = dir.readSync();
            if (entry === null) break;
            yield entry;
          }
        }
      };
      return dir;
    },
    opendir: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const dir = fsApi.opendirSync(path);
        queueMicrotask(() => done?.(null, dir));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    statSync: (path, options2) => {
      const kernelStats = statForKernelTarget(path, options2);
      if (kernelStats === void 0) return void 0;
      let stats = kernelStats;
      if (stats === null) {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        if (workspaceFileAncestor(normalized) !== null) {
          if (options2?.throwIfNoEntry === false) return void 0;
          throw Object.assign(new Error(`ENOTDIR: not a directory, stat '${path}'`), { code: "ENOTDIR" });
        }
        stats = statForNormalizedPath(normalized);
      }
      if (!stats) {
        if (options2?.throwIfNoEntry === false) return void 0;
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
      }
      return browserStatsResult(stats, options2);
    },
    lstatSync: (path, options2) => fsApi.statSync(path, options2),
    statfsSync: (path, options2) => {
      fsApi.statSync(path);
      return browserFileSystemStat(Boolean(options2?.bigint));
    },
    stat: (path, optionsOrCallback, callback) => {
      const options2 = typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback;
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const stats = fsApi.statSync(path, options2);
        queueMicrotask(() => done?.(null, stats));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    lstat: (path, optionsOrCallback, callback) => {
      const options2 = typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback;
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const stats = fsApi.lstatSync(path, options2);
        if (stats === void 0 && options2?.throwIfNoEntry === false) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });
        }
        queueMicrotask(() => done?.(null, stats));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    statfs: (path, optionsOrCallback, callback) => {
      const options2 = typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback;
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const stats = fsApi.statfsSync(path, options2);
        queueMicrotask(() => done?.(null, stats));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    realpathSync: (path, options2) => {
      const resolved = realpathForEntry(path);
      const encoding = typeof options2 === "string" ? options2 : options2?.encoding;
      return encoding === "buffer" ? BrowserBuffer.from(resolved) : resolved;
    },
    realpath: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const resolved = fsApi.realpathSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, resolved));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    truncateSync: (path, length = 0) => {
      const truncateTarget = runtimeTruncateTarget(path, kernelDevices);
      if (truncateTarget?.kind === "error") {
        throwRuntimeTruncateTargetError(truncateTarget, runtimeKernelMutationFsErrorMessage(String(path), truncateTarget, "truncate"));
      }
      const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      assertWorkspaceFileWritePath(normalized, path, "truncate");
      truncateFileBytes(normalized, length);
      return void 0;
    },
    truncate: (path, lengthOrCallback, callback) => {
      const done = typeof lengthOrCallback === "function" ? lengthOrCallback : callback;
      try {
        fsApi.truncateSync(path, typeof lengthOrCallback === "number" ? lengthOrCallback : 0);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    mkdirSync: (path, options2) => {
      const mkdirTarget = runtimeMkdirTarget(path, kernelDevices);
      if (mkdirTarget?.kind === "error") {
        throwRuntimeMkdirTargetError(mkdirTarget, runtimeKernelMutationFsErrorMessage(String(path), mkdirTarget, "mkdir"));
      }
      const rawPath = workspacePathInputToString(path).replace(/\\/g, "/");
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (!normalized) return void 0;
      assertReadonlyFilePath(normalized, "mkdir");
      const parent = dirname(normalized);
      const parentPath = parent === "" ? "" : parent;
      const parts = normalized.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join("/");
        if (fileStore.has(directoryPath)) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, mkdir '${path}'`), { code: "ENOTDIR" });
        }
      }
      if (fileStore.has(normalized)) {
        throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: "EEXIST" });
      }
      if (directoryStore.has(normalized)) {
        if (!options2?.recursive) {
          throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: "EEXIST" });
        }
        return void 0;
      }
      if (!options2?.recursive && parentPath && !directoryStore.has(parentPath)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${path}'`), { code: "ENOENT" });
      }
      const start = options2?.recursive ? 1 : parts.length;
      let firstCreated;
      for (let index = start; index <= parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join("/");
        const existed = directoryStore.has(directoryPath);
        directoryStore.add(directoryPath);
        if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
        if (!existed) {
          firstCreated ??= directoryPath;
          emitDirectoryCreate(directoryPath);
          notifyDirectoryMutation(directoryPath);
        }
      }
      if (!options2?.recursive || firstCreated === void 0) return void 0;
      return rawPath.startsWith("/") ? workspaceFilename(firstCreated, workspaceRoot) : firstCreated;
    },
    mkdir: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const created = fsApi.mkdirSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, created));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    mkdtempSync: (prefix, options2) => {
      const rawPrefix = workspacePathInputToString(prefix);
      for (let attempt = 0; attempt < 1e3; attempt += 1) {
        mkdtempCounter += 1;
        const suffix = mkdtempCounter.toString(36).padStart(6, "0").slice(-6);
        const candidate = `${rawPrefix}${suffix}`;
        const normalized = normalizeWorkspaceEntryPath(candidate, cwdPath, false, workspacePathContext);
        if (fileStore.has(normalized) || directoryStore.has(normalized)) continue;
        fsApi.mkdirSync(candidate);
        const encoding = typeof options2 === "string" ? options2 : options2?.encoding;
        const result = rawPrefix.startsWith("/") ? workspaceFilename(normalized, workspaceRoot) : candidate;
        return encoding === "buffer" ? BrowserBuffer.from(result) : result;
      }
      throw Object.assign(new Error(`EEXIST: file already exists, mkdtemp '${prefix}'`), { code: "EEXIST" });
    },
    mkdtemp: (prefix, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const directory = fsApi.mkdtempSync(prefix, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, directory));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    rmdirSync: (path) => {
      const removeTarget = runtimeRemoveTarget(path, kernelDevices);
      if (removeTarget?.kind === "error") {
        throwRuntimeRemoveTargetError(removeTarget, runtimeKernelMutationFsErrorMessage(String(path), removeTarget, "rmdir"));
      }
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      assertWorkspaceParentDirectoryPath(normalized, path, "rmdir");
      if (fileStore.has(normalized)) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, rmdir '${path}'`), { code: "ENOTDIR" });
      }
      const prefix = normalized ? `${normalized}/` : "";
      const hasChildren = Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix)) || Array.from(directoryStore).some((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
      if (hasChildren) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), { code: "ENOTEMPTY" });
      }
      if (!directoryStore.delete(normalized)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, rmdir '${path}'`), { code: "ENOENT" });
      }
      deleteEntryMetadata(normalized);
      emitDirectoryDelete(normalized);
      notifyDirectoryMutation(normalized);
    },
    rmdir: (path, callback) => {
      try {
        fsApi.rmdirSync(path);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    }
  };
  const fileHandleTarget = (path) => typeof path === "object" && path !== null && !(path instanceof URL) && typeof path.fd === "number" ? path.fd : path;
  const fsPromisesApi = {
    constants: fsConstants,
    access: async (path, mode = fsConstants.F_OK) => {
      fsApi.accessSync(path, mode);
    },
    open: async (path, flags = "r") => {
      const fd2 = fsApi.openSync(path, flags);
      let closed = false;
      const assertFileHandleOpen = () => {
        if (closed) throw Object.assign(new Error("file closed"), { code: "EBADF" });
      };
      const readFileFromHandle = (encoding) => {
        assertFileHandleOpen();
        const entry = fileDescriptor(fd2);
        if (!entry.readable) throw Object.assign(new Error("EBADF: bad file descriptor, readFile"), { code: "EBADF" });
        const source = descriptorBytes(entry);
        const start = entry.offset;
        const bytes = BrowserBuffer.from(source.slice(start));
        entry.offset = source.byteLength;
        const requestedEncoding = typeof encoding === "string" ? encoding : encoding?.encoding;
        return typeof requestedEncoding === "string" ? bytes.toString(requestedEncoding) : bytes;
      };
      const writeFileToHandle = (value, options2) => {
        assertFileHandleOpen();
        const bytes = bytesFromFsWriteValue(value, options2);
        return fsApi.writeSync(fd2, bytes, 0, bytes.byteLength, null);
      };
      const appendFileToHandle = (value, options2) => {
        assertFileHandleOpen();
        const entry = fileDescriptor(fd2);
        const bytes = bytesFromFsWriteValue(value, options2);
        const position = entry.kind === "device" ? null : descriptorBytes(entry).byteLength;
        return fsApi.writeSync(fd2, bytes, 0, bytes.byteLength, position);
      };
      return {
        fd: fd2,
        read: async (bufferOrOptions, offset = 0, length, position) => {
          assertFileHandleOpen();
          const options2 = typeof bufferOrOptions === "object" && bufferOrOptions !== null && !ArrayBuffer.isView(bufferOrOptions) ? bufferOrOptions : void 0;
          const buffer = options2?.buffer ?? (ArrayBuffer.isView(bufferOrOptions) ? bufferOrOptions : BrowserBuffer.alloc(16 * 1024));
          const readOffset = options2?.offset ?? offset;
          const readLength = options2?.length ?? length ?? buffer.byteLength - readOffset;
          const readPosition = options2 !== void 0 ? options2.position : position;
          const bytesRead = fsApi.readSync(fd2, buffer, readOffset, readLength, readPosition);
          return { bytesRead, buffer };
        },
        readFile: async (encoding) => readFileFromHandle(encoding),
        readv: async (buffers, position) => {
          assertFileHandleOpen();
          const bytesRead = fsApi.readvSync(fd2, buffers, position);
          return { bytesRead, buffers };
        },
        write: async (value, offsetOrPosition, lengthOrEncoding, position) => {
          assertFileHandleOpen();
          const options2 = typeof offsetOrPosition === "object" && offsetOrPosition !== null ? offsetOrPosition : void 0;
          const bytesWritten = fsApi.writeSync(
            fd2,
            value,
            options2?.offset ?? (typeof offsetOrPosition === "number" ? offsetOrPosition : void 0),
            options2?.length ?? lengthOrEncoding,
            options2 !== void 0 ? options2.position : position
          );
          return {
            bytesWritten,
            buffer: value
          };
        },
        writeFile: async (value, options2) => {
          writeFileToHandle(value, options2);
        },
        createReadStream: (options2) => {
          assertFileHandleOpen();
          const streamOptions = typeof options2 === "string" ? { encoding: options2, fd: fd2 } : { ...options2 ?? {}, fd: fd2 };
          const stream = fsApi.createReadStream(null, streamOptions);
          if (typeof options2 !== "object" || options2?.autoClose !== false) {
            stream.once("close", () => {
              closed = true;
            });
          }
          return stream;
        },
        createWriteStream: (options2) => {
          assertFileHandleOpen();
          const streamOptions = typeof options2 === "string" ? { encoding: options2, fd: fd2 } : { ...options2 ?? {}, fd: fd2 };
          const stream = fsApi.createWriteStream(null, streamOptions);
          if (typeof options2 !== "object" || options2?.autoClose !== false) {
            stream.once("close", () => {
              closed = true;
            });
          }
          return stream;
        },
        appendFile: async (value, options2) => {
          appendFileToHandle(value, options2);
        },
        writev: async (buffers, position) => {
          assertFileHandleOpen();
          const bytesWritten = fsApi.writevSync(fd2, buffers, position);
          return { bytesWritten, buffers };
        },
        stat: async (options2) => {
          assertFileHandleOpen();
          return fsApi.fstatSync(fd2, options2);
        },
        chmod: async (mode) => {
          assertFileHandleOpen();
          fsApi.fchmodSync(fd2, mode);
        },
        chown: async (uid, gid) => {
          assertFileHandleOpen();
          fsApi.fchownSync(fd2, uid, gid);
        },
        utimes: async (atime, mtime) => {
          assertFileHandleOpen();
          fsApi.futimesSync(fd2, atime, mtime);
        },
        truncate: async (length = 0) => {
          assertFileHandleOpen();
          fsApi.ftruncateSync(fd2, length);
        },
        sync: async () => {
          assertFileHandleOpen();
          fsApi.fsyncSync(fd2);
        },
        datasync: async () => {
          assertFileHandleOpen();
          fsApi.fdatasyncSync(fd2);
        },
        close: async () => {
          if (closed) return;
          closed = true;
          fsApi.closeSync(fd2);
        }
      };
    },
    readFile: async (path, encoding) => fsApi.readFileSync(fileHandleTarget(path), encoding),
    writeFile: async (path, value, options2) => {
      fsApi.writeFileSync(fileHandleTarget(path), value, options2);
    },
    appendFile: async (path, value, options2) => {
      fsApi.appendFileSync(fileHandleTarget(path), value, options2);
    },
    copyFile: async (source, destination, mode = 0) => {
      fsApi.copyFileSync(source, destination, mode);
    },
    link: async (existingPath, newPath) => {
      fsApi.linkSync(existingPath, newPath);
    },
    symlink: async (target, linkPath) => {
      fsApi.symlinkSync(target, linkPath);
    },
    readlink: async (path, options2) => fsApi.readlinkSync(path, options2),
    cp: async (source, destination, options2) => {
      fsApi.cpSync(source, destination, options2);
    },
    chmod: async (path, mode) => {
      fsApi.chmodSync(path, mode);
    },
    chown: async (path, uid, gid) => {
      fsApi.chownSync(path, uid, gid);
    },
    utimes: async (path, atime, mtime) => {
      fsApi.utimesSync(path, atime, mtime);
    },
    rename: async (oldPath, newPath) => {
      fsApi.renameSync(oldPath, newPath);
    },
    unlink: async (path) => {
      fsApi.unlinkSync(path);
    },
    truncate: async (path, length = 0) => {
      fsApi.truncateSync(path, length);
    },
    rm: async (path, options2) => {
      fsApi.rmSync(path, options2);
    },
    readdir: async (path, options2) => fsApi.readdirSync(path, options2),
    opendir: async (path) => fsApi.opendirSync(path),
    watch: (path, options2) => {
      const entries = [];
      const waiters = [];
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        watcher.close();
        entries.length = 0;
        while (waiters.length > 0) {
          waiters.shift()?.({ done: true, value: void 0 });
        }
      };
      const watcher = fsApi.watch(path, typeof options2 === "string" ? void 0 : options2 ?? void 0, (eventType, filename) => {
        const entry = { eventType, filename };
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ done: false, value: entry });
          return;
        }
        entries.push(entry);
      });
      if (typeof options2 === "object" && options2?.signal) {
        if (options2.signal.aborted) {
          close();
        } else {
          options2.signal.addEventListener("abort", close, { once: true });
        }
      }
      const iterator = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        next: () => {
          if (entries.length > 0) return Promise.resolve({ done: false, value: entries.shift() });
          if (closed) return Promise.resolve({ done: true, value: void 0 });
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return: () => {
          close();
          return Promise.resolve({ done: true, value: void 0 });
        }
      };
      return iterator;
    },
    stat: async (path, options2) => fsApi.statSync(path, options2),
    lstat: async (path, options2) => {
      const stats = fsApi.lstatSync(path, options2);
      if (stats === void 0 && options2?.throwIfNoEntry === false) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });
      }
      return stats;
    },
    statfs: async (path, options2) => fsApi.statfsSync(path, options2),
    realpath: async (path, options2) => fsApi.realpathSync(path, options2),
    mkdir: async (path, options2) => fsApi.mkdirSync(path, options2),
    mkdtemp: async (prefix, options2) => fsApi.mkdtempSync(prefix, options2),
    rmdir: async (path) => {
      fsApi.rmdirSync(path);
    }
  };
  fsApi.realpath.native = fsApi.realpath;
  fsApi.realpathSync.native = fsApi.realpathSync;
  Object.assign(fsApi, { promises: fsPromisesApi });
  const zlibApi = createZlibApi();
  const httpApi = createHttpApi(request.kernelHttp, request.signal);
  const builtins = /* @__PURE__ */ new Map([
    ["fs", fsApi],
    ["node:fs", fsApi],
    ["fs/promises", fsPromisesApi],
    ["node:fs/promises", fsPromisesApi],
    ["path", createPathApi(() => cwdPath, workspaceRoot)],
    ["node:path", createPathApi(() => cwdPath, workspaceRoot)],
    ["os", createOsApi(workspaceRoot)],
    ["node:os", createOsApi(workspaceRoot)],
    ["url", createUrlApi()],
    ["node:url", createUrlApi()],
    ["buffer", { Buffer: BrowserBuffer }],
    ["node:buffer", { Buffer: BrowserBuffer }],
    ["http", httpApi.module],
    ["node:http", httpApi.module],
    ["zlib", zlibApi],
    ["node:zlib", zlibApi]
  ]);
  const normalizeModuleSpecifier = (specifier) => specifier.startsWith("/") ? normalizeWorkspaceEntryPath(specifier, "", false, workspacePathContext) : specifier;
  const requireModule = (specifier, parentPath, parentModule = null) => {
    if (builtins.has(specifier)) return builtins.get(specifier);
    const normalizedSpecifier = normalizeModuleSpecifier(specifier);
    return executeModule(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, "require"), parentModule);
  };
  const resolveRequireModule = (specifier, parentPath) => {
    if (builtins.has(specifier)) return specifier;
    const normalizedSpecifier = normalizeModuleSpecifier(specifier);
    return workspaceFilename(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, "require"), workspaceRoot);
  };
  const createWorkspaceRequire = (parentPath, parentModule = null) => {
    const localRequire = ((specifier) => requireModule(specifier, parentPath, parentModule));
    localRequire.cache = requireCache;
    localRequire.resolve = (specifier) => resolveRequireModule(specifier, parentPath);
    Object.defineProperty(localRequire, "main", {
      configurable: true,
      enumerable: true,
      get: () => mainModule
    });
    return localRequire;
  };
  const importModule = (specifier, parentPath) => builtins.has(specifier) ? Promise.resolve(builtins.get(specifier)) : Promise.resolve(executeModule(resolveModulePath(modules, normalizeModuleSpecifier(specifier), parentPath, nodePathSearchEntries, "import")));
  const preloadParentPath = cwdPath ? `${cwdPath}/repl.js` : "repl.js";
  const createModuleRecord = (normalizedPath, parent) => ({
    exports: {},
    id: workspaceFilename(normalizedPath, workspaceRoot),
    filename: workspaceFilename(normalizedPath, workspaceRoot),
    loaded: false,
    parent,
    children: [],
    path: workspaceDirname(normalizedPath, workspaceRoot),
    paths: moduleSearchPaths(normalizedPath, workspaceRoot)
  });
  const executeModule = (modulePath, parent = null, isMain = false) => {
    const normalizedPath = moduleCandidates(modules, modulePath, "require").find((candidate) => modules.has(candidate));
    if (!normalizedPath) {
      throw new Error(`Cannot find module '${modulePath}'`);
    }
    const cacheKey = workspaceFilename(normalizedPath, workspaceRoot);
    const cached = cache.get(normalizedPath);
    if (cached && requireCache[cacheKey]) {
      if (parent?.children && !parent.children.includes(cached)) parent.children.push(cached);
      return cached.exports;
    } else if (cached) {
      cache.delete(normalizedPath);
    }
    const code = modules.get(normalizedPath);
    if (code === void 0) {
      throw new Error(`Cannot find module '${modulePath}'`);
    }
    if (normalizedPath.endsWith(".json")) {
      const parsed = JSON.parse(code);
      const jsonModule = createModuleRecord(normalizedPath, parent);
      jsonModule.exports = parsed;
      jsonModule.loaded = true;
      cache.set(normalizedPath, jsonModule);
      requireCache[cacheKey] = jsonModule;
      if (parent?.children) parent.children.push(jsonModule);
      return parsed;
    }
    const module = createModuleRecord(normalizedPath, parent);
    if (isMain) {
      module.id = ".";
      mainModule = module;
    }
    cache.set(normalizedPath, module);
    requireCache[cacheKey] = module;
    if (parent?.children) parent.children.push(module);
    const localRequire = createWorkspaceRequire(normalizedPath, module);
    module.require = localRequire;
    const localImport = (specifier) => importModule(specifier, normalizedPath);
    const executableCode = isEsmModule(modules, normalizedPath) ? transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot)) : code;
    const fn = new Function(
      "require",
      "__import",
      "module",
      "exports",
      "console",
      "process",
      "Buffer",
      "__filename",
      "__dirname",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "queueMicrotask",
      "fetch",
      "Headers",
      "Request",
      "Response",
      executableCode
    );
    try {
      fn.call(
        isEsmModule(modules, normalizedPath) ? void 0 : module.exports,
        localRequire,
        localImport,
        module,
        module.exports,
        consoleApi,
        processApi,
        BrowserBuffer,
        workspaceFilename(normalizedPath, workspaceRoot),
        workspaceDirname(normalizedPath, workspaceRoot),
        eventLoopApi.setTimeout,
        eventLoopApi.clearTimeout,
        eventLoopApi.setInterval,
        eventLoopApi.clearInterval,
        eventLoopApi.setImmediate,
        eventLoopApi.clearImmediate,
        eventLoopApi.queueMicrotask,
        httpApi.fetch,
        httpApi.Headers,
        httpApi.Request,
        httpApi.Response
      );
    } catch (error) {
      throw sanitizeBrowserJavaScriptStack(error, workspaceFilename(normalizedPath, workspaceRoot));
    }
    module.loaded = true;
    return module.exports;
  };
  const executeEntrypoint = async (modulePath) => {
    const normalizedPath = moduleCandidates(modules, modulePath, "import").find((candidate) => modules.has(candidate));
    if (!normalizedPath) {
      throw new Error(`Cannot find module '${modulePath}'`);
    }
    if (!isEsmModule(modules, normalizedPath)) {
      executeModule(normalizedPath, null, true);
      await Promise.resolve();
      return;
    }
    const cached = cache.get(normalizedPath);
    if (cached) return;
    const code = modules.get(normalizedPath);
    if (code === void 0) {
      throw new Error(`Cannot find module '${modulePath}'`);
    }
    const module = createModuleRecord(normalizedPath, null);
    module.id = ".";
    mainModule = module;
    cache.set(normalizedPath, module);
    requireCache[workspaceFilename(normalizedPath, workspaceRoot)] = module;
    const localRequire = createWorkspaceRequire(normalizedPath, module);
    module.require = localRequire;
    const localImport = (specifier) => importModule(specifier, normalizedPath);
    const executableCode = transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot));
    const fn = new AsyncFunction(
      "require",
      "__import",
      "module",
      "exports",
      "console",
      "process",
      "Buffer",
      "__filename",
      "__dirname",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "queueMicrotask",
      "fetch",
      "Headers",
      "Request",
      "Response",
      executableCode
    );
    try {
      await fn.call(
        void 0,
        localRequire,
        localImport,
        module,
        module.exports,
        consoleApi,
        processApi,
        BrowserBuffer,
        workspaceFilename(normalizedPath, workspaceRoot),
        workspaceDirname(normalizedPath, workspaceRoot),
        eventLoopApi.setTimeout,
        eventLoopApi.clearTimeout,
        eventLoopApi.setInterval,
        eventLoopApi.clearInterval,
        eventLoopApi.setImmediate,
        eventLoopApi.clearImmediate,
        eventLoopApi.queueMicrotask,
        httpApi.fetch,
        httpApi.Headers,
        httpApi.Request,
        httpApi.Response
      );
    } catch (error) {
      throw sanitizeBrowserJavaScriptStack(error, workspaceFilename(normalizedPath, workspaceRoot));
    }
    module.loaded = true;
    await Promise.resolve();
  };
  try {
    for (const moduleName of requireModulesForRequest(request)) {
      requireModule(moduleName, preloadParentPath);
    }
    if (request.source === "file") {
      let entryPath = null;
      try {
        const workspaceRelativePath = assertSafeWorkspaceFilePath(request.scriptPath, "", workspacePathContext);
        if (modules.has(workspaceRelativePath)) {
          entryPath = workspaceRelativePath;
        }
      } catch {
      }
      await executeEntrypoint(entryPath ?? normalizeWorkspaceEntryPath(request.scriptPath, cwdPath, false, workspacePathContext));
    } else {
      const module = { exports: {} };
      const replPath = preloadParentPath;
      const requireFromRoot = createWorkspaceRequire(replPath);
      const importFromRoot = (specifier) => importModule(specifier, replPath);
      const evalCode = request.options?.inputType === "module" ? transformStaticEsmToCommonJs(request.code, workspaceFileUrl("[eval]", workspaceRoot)) : request.code;
      const fn = new AsyncFunction(
        "require",
        "__import",
        "module",
        "exports",
        "console",
        "process",
        "Buffer",
        "__filename",
        "__dirname",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "queueMicrotask",
        "fetch",
        "Headers",
        "Request",
        "Response",
        transformDynamicImports(evalCode)
      );
      try {
        await fn.call(
          module.exports,
          requireFromRoot,
          importFromRoot,
          module,
          module.exports,
          consoleApi,
          processApi,
          BrowserBuffer,
          `${workspaceRoot}/[eval]`,
          cwdPath ? `${workspaceRoot}/${cwdPath}` : workspaceRoot,
          eventLoopApi.setTimeout,
          eventLoopApi.clearTimeout,
          eventLoopApi.setInterval,
          eventLoopApi.clearInterval,
          eventLoopApi.setImmediate,
          eventLoopApi.clearImmediate,
          eventLoopApi.queueMicrotask,
          httpApi.fetch,
          httpApi.Headers,
          httpApi.Request,
          httpApi.Response
        );
      } catch (error) {
        throw sanitizeBrowserJavaScriptStack(error, `${workspaceRoot}/[eval]`);
      }
      await Promise.resolve();
    }
    if (httpApi.hasActiveWork()) {
      await httpApi.waitForClose();
    }
    await eventLoopApi.drain();
    await liveIo.flush();
    const resultFiles = [
      ...Array.from(fileStore.entries()).filter(([path, contents]) => !byteEqual(originalFiles.get(path), contents)).sort(([left], [right]) => left.localeCompare(right)).map(([path, contents]) => bytesToRuntimeFile(path, contents)),
      ...Array.from(originalFiles.keys()).filter((path) => !fileStore.has(path)).sort((left, right) => left.localeCompare(right)).map((path) => ({ path, deleted: true }))
    ].sort((left, right) => left.path.localeCompare(right.path));
    const files = liveIo.filterAppliedResultFiles({
      stdout: "",
      stderr: "",
      exitCode: 0,
      files: resultFiles
    }).files ?? [];
    httpApi.closeAll();
    eventLoopApi.clearAll();
    io.status("process-exit", "Browser Node exited", { command: "node", exitCode: 0 });
    return {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      exitCode: 0,
      ...files.length > 0 ? { files } : {}
    };
  } catch (error) {
    httpApi.closeAll();
    eventLoopApi.clearAll();
    const exitCode = typeof error.exitCode === "number" ? error.exitCode : 1;
    const stderrSuffix = error.suppressStderr ? "" : formatBrowserJavaScriptErrorForStderr(error);
    if (stderrSuffix) emitOutput("stderr", stderrSuffix);
    try {
      await liveIo.flush();
    } catch (flushError) {
      const flushStderr = flushError instanceof Error ? `${flushError.message}
` : `${String(flushError)}
`;
      createRuntimeProjectIoBridge(request.onEvent).output("stderr", flushStderr);
      io.status("process-exit", "Browser Node exited", { command: "node", exitCode: 1 });
      return {
        stdout: stdout.join(""),
        stderr: stderr.join("") + flushStderr,
        exitCode: 1
      };
    }
    io.status("process-exit", "Browser Node exited", { command: "node", exitCode });
    return {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      exitCode
    };
  }
}

// packages/harness-javascript/src/project-browser-worker.ts
var workerScope = self;
var postWorkerMessage = workerScope.postMessage.bind(workerScope);
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var WorkerKernelHttpBridge = class {
  constructor(postProtocolMessage) {
    this.postProtocolMessage = postProtocolMessage;
  }
  nextListenerId = 1;
  nextRequestId = 1;
  listeners = /* @__PURE__ */ new Map();
  listenerInfo = /* @__PURE__ */ new Map();
  dispatchRequests = /* @__PURE__ */ new Map();
  serverRequestAbortControllers = /* @__PURE__ */ new Map();
  listen(options, handler) {
    const listenerId = `worker-http-${this.nextListenerId++}`;
    const optimisticInfo = {
      id: listenerId,
      pid: 0,
      host: options.host ?? "127.0.0.1",
      port: options.port,
      protocol: options.protocol ?? "http",
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.listeners.set(listenerId, handler);
    this.listenerInfo.set(listenerId, optimisticInfo);
    this.postProtocolMessage({
      type: "kernel-http-listen",
      listenerId,
      options
    });
    let closed = false;
    const listenerInfo = this.listenerInfo;
    return {
      id: listenerId,
      get info() {
        return listenerInfo.get(listenerId) ?? optimisticInfo;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.listeners.delete(listenerId);
        this.listenerInfo.delete(listenerId);
        this.postProtocolMessage({ type: "kernel-http-close", listenerId });
      }
    };
  }
  dispatch(request) {
    const requestId = `worker-dispatch-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      this.dispatchRequests.set(requestId, { resolve, reject });
      this.postProtocolMessage({
        type: "kernel-http-dispatch",
        requestId,
        request
      });
    });
  }
  resolveDispatch(requestId, response) {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.resolve(response);
  }
  rejectDispatch(requestId, error) {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.reject(new Error(error));
  }
  updateListenerInfo(listenerId, info) {
    this.listenerInfo.set(listenerId, info);
  }
  failListener(listenerId) {
    this.listeners.delete(listenerId);
    this.listenerInfo.delete(listenerId);
  }
  abortRequest(requestId) {
    this.serverRequestAbortControllers.get(requestId)?.abort();
  }
  async handleRequest(listenerId, requestId, request) {
    const handler = this.listeners.get(listenerId);
    if (!handler) {
      this.postProtocolMessage({
        type: "kernel-http-error",
        requestId,
        listenerId,
        error: `TraceKernel HTTP listener not found: ${listenerId}`
      });
      return;
    }
    const abortController = new AbortController();
    this.serverRequestAbortControllers.set(requestId, abortController);
    try {
      const response = await handler({
        ...request,
        signal: abortController.signal
      });
      this.postProtocolMessage({
        type: "kernel-http-response",
        requestId,
        response
      });
    } catch (error) {
      this.postProtocolMessage({
        type: "kernel-http-error",
        requestId,
        listenerId,
        error: errorMessage(error)
      });
    } finally {
      this.serverRequestAbortControllers.delete(requestId);
    }
  }
};
var activeHttpBridges = /* @__PURE__ */ new Map();
function postCommandMessage(postMessage2, id, protocolToken, type, payload) {
  postMessage2({ id, type, payload, protocolToken });
}
function handleKernelHttpHostMessage(message) {
  const { id, type, payload, protocolToken } = message;
  if (!id) return false;
  const command = activeHttpBridges.get(id);
  if (!command) return false;
  if (protocolToken !== command.protocolToken) return true;
  if (type === "kernel-http-request") {
    const message2 = payload;
    if (message2.type === "kernel-http-request") {
      void command.bridge.handleRequest(message2.listenerId, message2.requestId, message2.request);
    }
    return true;
  }
  if (type === "kernel-http-abort-request") {
    const message2 = payload;
    if (message2.type === "kernel-http-abort-request") {
      command.bridge.abortRequest(message2.requestId);
    }
    return true;
  }
  if (type === "kernel-http-listen-result") {
    const message2 = payload;
    if (message2.type === "kernel-http-listen-result") {
      command.bridge.updateListenerInfo(message2.listenerId, message2.info);
    }
    return true;
  }
  if (type === "kernel-http-dispatch-result") {
    const message2 = payload;
    if (message2.type === "kernel-http-dispatch-result") {
      command.bridge.resolveDispatch(message2.requestId, message2.response);
    }
    return true;
  }
  if (type === "kernel-http-error") {
    const message2 = payload;
    if (message2.type === "kernel-http-error" && message2.requestId) {
      command.bridge.rejectDispatch(message2.requestId, message2.error);
    } else if (message2.type === "kernel-http-error" && message2.listenerId) {
      command.bridge.failListener(message2.listenerId);
    }
    return true;
  }
  return false;
}
workerScope.onmessage = (event) => {
  const { id, type, payload, protocolToken, port } = event.data;
  if (!id) return;
  if (handleKernelHttpHostMessage(event.data)) return;
  if (type !== "execute-project-javascript") {
    postWorkerMessage({ id, type: "error", payload: { error: `Unsupported JavaScript project worker message: ${type}` } });
    return;
  }
  if (typeof protocolToken !== "string" || protocolToken.length === 0) {
    postWorkerMessage({ id, type: "error", payload: { error: "Missing JavaScript project worker protocol token." } });
    return;
  }
  const commandPort = port ?? null;
  const postToHost = commandPort ? commandPort.postMessage.bind(commandPort) : postWorkerMessage;
  commandPort?.start?.();
  if (commandPort) {
    commandPort.onmessage = (messageEvent) => {
      handleKernelHttpHostMessage(messageEvent.data);
    };
  }
  const request = payload;
  const options = {};
  const executionState = { cancelled: false };
  const kernelHttp = new WorkerKernelHttpBridge((message) => {
    postCommandMessage(postToHost, id, protocolToken, message.type, message);
  });
  activeHttpBridges.set(id, { bridge: kernelHttp, protocolToken });
  runBrowserJavaScriptProjectRequest(
    {
      ...request,
      kernelHttp,
      onEvent: (runtimeEvent) => {
        if (runtimeEvent.type === "status" && (runtimeEvent.phase === "process-start" || runtimeEvent.phase === "process-exit")) {
          return;
        }
        postCommandMessage(postToHost, id, protocolToken, "project-event", runtimeEvent);
      }
    },
    options,
    executionState
  ).then(
    (result) => {
      activeHttpBridges.delete(id);
      postCommandMessage(postToHost, id, protocolToken, "execute-result", result);
      commandPort?.close();
    },
    (error) => {
      activeHttpBridges.delete(id);
      postCommandMessage(postToHost, id, protocolToken, "error", { error: errorMessage(error) });
      commandPort?.close();
    }
  );
};
postWorkerMessage({ type: "worker-ready" });
