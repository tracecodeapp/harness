# C++ Runtime Support

The browser C++ lane is experimental and intentionally v4-native. It emits `RuntimeTrace` events directly and must not emit legacy trace-step or visualizer-shaped payloads.

## Compiler

- Standard: C++23 (`-std=c++23`).
- Primary toolchain: YoWASP Clang bundle loaded in the browser worker.
- Fallback shape: raw Clang/LLD/WASI assets with TraceCode-owned filesystem glue.
- Execution styles: `solution-method`, plus experimental `ops-class` for constructor + method operation sequences.

## Supported Today

- `class Solution` methods with primitive, string, vector, map, set, queue, stack, deque, priority queue, `ListNode*`, and `TreeNode*` inputs/results.
- Common TraceCode node representations: object ids/refs for aliasing and cycles, plus array-shaped `ListNode` and level-order `TreeNode` materialization.
- C++23 language smoke coverage including concepts, ranges, spans, lambdas, self-recursive generic lambdas, tuples, arrays, pairs, and namespace helpers.
- TraceCode wrappers for `vector`, `unordered_map`, `map`, `set`, `unordered_set`, `deque`, `queue`, `stack`, and `priority_queue`.
- Native access events for simple local object fields such as `box.value` and one-level keyed fields such as `node.children[key]`. Traced `vector`, `deque`, `queue`, `stack`, `priority_queue`, `unordered_map`, `map`, `set`, and `unordered_set` class fields can also emit `this.field` and indexed/keyed/slot path events.
- Experimental `ops-class` driver support for TraceCode class fixtures, including traced map/set fields and nested vector mutation through keyed map fields.
- Arbitrary C++ objects are snapshotted as opaque values unless they are one of the supported TraceCode data shapes.
- Native runtime trace facts for calls, returns, lines, reads, writes, mutations, snapshots, stdout capture, control transfer, exceptions, timeouts, and trace budget termination.

## Fixture Coverage

C++ is opt-in inside `fixtures/runtime-parity`: a fixture participates in the C++ matrix when it has `solution.cpp` and C++ anchors in `case.json`.

The current C++ parity set covers representative atomic operations from the existing Python/JavaScript/TypeScript/Java corpus:

- indexed read/write
- vector append/pop
- map put/get/contains/remove
- set add/remove
- queue FIFO operations
- priority queue push/pop
- for/while loops
- break/continue
- function calls and recursion
- stdout smoke
- string indexing smoke
- matrix and nested indexed read/write
- simple object field read/write
- object field keyed map access
- solution-method class vector field assignment and nested mutation
- ops-class keyed map read/write
- ops-class map-to-vector nested mutation
- ops-class map, set, and unordered_set field persistence smoke coverage
- ops-class deque, queue, stack, and priority_queue field persistence smoke coverage

The C++ lane currently has fewer line-local local-variable snapshots than the mature runtimes. C++ fixture expectations should call that out with `expectByLanguage.cpp` instead of weakening the shared fixture expectation.

## Boundaries

These are not supported as stable contracts yet:

- `function`, `script`, and interview-mode execution styles.
- Arbitrary multi-file projects or user-provided filesystem layouts.
- Raw STL memory inspection. Container events come from TraceCode wrappers.
- Deep arbitrary class/object serialization. Field access can be traced, but unsupported custom object snapshots remain opaque.
- General traced class fields beyond the container field patterns covered by the tests and parity fixtures.
- General `ops-class` overloads, inheritance-heavy classes, and constructor argument materialization beyond the covered fixture shapes.
- Full source-to-source parsing for every macro-heavy or template-metaprogramming pattern.
- Visualizer classifications such as graph, linked-list, tree, hash-map, primary/companion ownership, or algorithm family.

## Robustness Rule

When C++ rewriter behavior changes, add one of these before widening support:

- a generated-source assertion in `tests/test-cpp-rewriter.ts`
- a compile/run or trace fixture in `tests/test-cpp-runtime.ts`
- a matching `solution.cpp` in `fixtures/runtime-parity` when the behavior is one of the shared atomic runtime operations
