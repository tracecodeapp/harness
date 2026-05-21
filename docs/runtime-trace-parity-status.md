# Runtime Trace Parity Status

Last updated: 2026-05-19

## Purpose

The Runtime Trace parity corpus defines the language-agnostic harness contract for playback-facing traces. Fixtures should describe runtime facts only:

- which source line ran
- which variables were visible at that point
- which values were read, written, or mutated
- which calls, returns, stdout writes, exceptions, timeouts, or snapshots occurred

Runtime trace frames use a post-line state model. A `line` event means the source line has executed, and snapshots/access facts attached to that line describe the state and runtime facts after that line's operation. Runtime trace playback is not a debugger-style "next line to execute" cursor. Declarations, assignments, mutations, and returns should therefore attach their resulting state to the source line that caused the state, not to the following line. Loop and branch condition lines still emit when the condition is evaluated; because condition evaluation normally does not mutate local state, the post-condition state is usually the same values that entered the condition plus any read facts caused by evaluating it.

The normative V4 execution contract is documented in [`docs/harness-execution-contract.md`](./harness-execution-contract.md). This status document tracks parity progress and known gaps; the execution contract defines what harnesses should emit.

The fixture corpus must not encode higher-level classification such as graph adjacency, linked lists, hash maps, or tree roles. Runtime traces should stay limited to execution facts; downstream consumers can derive presentation-specific meaning separately.

## Cutover Goal

The end state is native runtime trace emission from every language runtime. Python, JavaScript, TypeScript, and Java should produce `RuntimeTrace`-shaped events themselves instead of producing legacy trace steps that are then coerced through an adapter.

The old trace-step adapter path has been removed from the public runtime boundary. New behavior must be emitted as runtime trace facts by the language runtimes or rejected by the raw emission contract.

As of the runtime trace public-boundary cutover, `ExecutionResult.trace` is a `RuntimeTrace`. Public runtime clients must not return legacy trace-step arrays. Any remaining legacy trace-step usage is internal migration debt at worker/raw-instrumentation seams and should be pushed downward into native language emitters, not exposed to product consumers.

This means the runtime trace cutover is allowed to be breaking:

- Prefer exposing missing runtime facts as visible fixture gaps over masking them in the runtime trace adapter.
- Prefer deleting old trace dependencies once a language emits runtime trace natively.
- Do not add higher-level classification or presentation-specific recovery logic to runtime trace emission.
- Do not make frontend correctness depend on both the old trace contract and the runtime trace contract at the same time.

## TraceHooks Contract

`TraceHooks` is the shared name for the runtime-facing instrumentation boundary across languages. Java already exposes this boundary as `tracecode.user.TraceHooks`; Python, JavaScript, and TypeScript should use the same conceptual name for the code that observes execution and emits runtime facts.

`TraceHooks` owns language-specific mechanics only:

- observing source-line execution
- recording neutral reads, writes, and mutations
- recording calls, returns, stdout, exceptions, and timeouts
- snapshotting visible runtime state
- enforcing trace budgets
- assembling public `RuntimeTrace` events

`TraceHooks` must not own higher-level meaning:

- no graph/list/tree/hash-map classification
- no presentation selection
- no algorithm-family inference
- no language-specific payload category unless the category is accepted into the shared runtime trace contract

All language implementations should use the same vocabulary even if their underlying mechanics differ:

- `emitPostLineFrame` / completed-line frame emission
- `recordRead`
- `recordWrite`
- `recordMutation`
- `emitCall`
- `emitReturn`
- `emitException`
- `flushCompletedLine`

The public contract is `RuntimeTrace`, not the implementation shape of `TraceHooks`. A language may internally observe pre-line signals, AST-rewritten statement completions, bytecode callbacks, or explicit helper calls, but `TraceHooks` must expose the same post-line runtime trace model to consumers.

## Current Corpus

- Fixture directory: `fixtures/runtime-parity`
- Fixture count: 59
- Languages covered per fixture: Python, JavaScript, TypeScript, Java, C#, C++
- Official gate: `pnpm test:runtime-trace`
- Gate: `pnpm test:runtime-trace-fixtures`
- Strict raw parity gate: `pnpm test:runtime-trace-fixtures:raw-strict`
- Raw emission contract gate: `pnpm test:runtime-raw-emission-contract`
- Synthetic parity smoke gate: `pnpm test:runtime-trace-parity`
- Gap report: `pnpm report:runtime-trace-known-gaps`

`pnpm test:runtime-trace` is part of both `pnpm test` and `pnpm test:ci`. Any runtime instrumentation change that alters cross-language runtime trace parity, introduces unsupported raw payloads, or reopens known gaps should fail before merge.

Python, JavaScript, TypeScript, Java, C#, and C++ browser runtime clients now return runtime trace directly at `result.trace`; the browser clients no longer expose legacy trace steps. Java `TraceHooks` now emits native `trace:` event payloads, and Java worker-client results carry runtime trace at `trace`. C# emits native runtime trace events from its browser-local Roslyn/.NET compiler host. C++ emits native runtime trace events from the browser-local compiler/runtime worker. The public Java, C#, and C++ runtime boundaries are runtime trace-only. The old synthetic `javaEvents` fixture field has been removed from the contract so fixture results cannot accidentally mask actual Java harness behavior.

The remaining legacy seams are internal raw worker traces used by migration checks and Python fixture execution while raw language instrumentation is normalized into runtime trace events. These are not supported public trace contracts.

## Baseline Known Gaps

Current known gap count: 0

By language:

- Java: 0
- C#: 0
- C++: 0
- JavaScript: 0
- Python: 0
- TypeScript: 0

Main clusters:

- No open fixture gaps in the current 59-fixture corpus.
- The corpus now covers indexed access, indexed writes, aggregate access counts, list append/pop, matrix writes, map/dict put/get/contains, set add/remove/contains, loops, break/continue, early return, function calls, recursion, stdout, caught exceptions, and object field read/write across Python, JavaScript, TypeScript, Java, C#, and C++.
- This is a baseline, not proof of completeness. New operations should be added to the corpus as soon as they become product-relevant or are discovered through corpus mining.

## Recently Tightened

Java local snapshot completeness now passes for the core loop and mutation fixtures:

- `for-loop/body`
- `break-continue/add`
- `nested-loop/body`
- `list-append/append`

The fix was made in Java runtime source augmentation so Java emits the missing local snapshots itself before the raw runtime assembly seam sees the trace.

Java object-field access also now passes for `object-field-read-write/write` and `object-field-read-write/read`. Java emits field read/write hooks as neutral access facts instead of relying on legacy visualization-shaped object payloads.

C++ now participates in the 59-fixture runtime parity corpus. The C++ fixture gate compiles and runs each fixture through the browser-local C++ worker, emits native `RuntimeTrace` events, and rejects unsupported visualization-era payloads. C++ declaration lines now follow the post-line state model, so initialized locals are visible on the source line that creates them.

C++ also supports playground script-style execution through the public runtime API. A script request uses `executionStyle="function"` with an empty function name and must assign a serializable top-level `result` variable. The worker wraps those top-level statements in generated C++ glue, maps trace lines back to `solution.cpp`, and emits a native `<script>` call/return frame. C++ interview mode uses the same instrumented compiler path with a trace budget, then returns the standard non-trace execution result shape.

C++ TC83 export hardening now covers the first full all-language V4 compact-audit pass. The pass initially exposed seven C++ compile-dropout traces caused by provenance rewriting on plain STL fallbacks. The worker now avoids rewriting member-field keyed receivers such as `node->children[ch]` into nonexistent helper methods, skips pointer method calls such as `a->size()` in pointer-field read instrumentation, and routes indexed writes through a free `trace_index_ref` helper that supports both traced `tracecode::Vector<T>` values and plain `std::vector<T>` fallbacks, including `std::vector<bool>` and `std::vector<std::string>` character cells. The failing TC83 C++ subset now exports with `failureCount=0`.

C++ trace controls now match the public profile for `maxLineEvents`, `maxSingleLineHits`, `minimalTrace`, and call-stack attachment. `maxLineEvents` and `maxSingleLineHits` are enforced inside the generated C++/Wasm runtime as hard trace aborts with `line-limit` and `single-line-limit` timeout reasons, which keeps runaway loops bounded before the broader execution hardening pass.

C++ execution hardening now has a two-layer timeout contract. Instrumented runs first use runtime trace guards for trace budgets, line-event budgets, and single-line hit budgets. If compile or runtime execution still blocks the worker, `CppWorkerClient` terminates and recreates the worker, returns `client-timeout` metadata, and keeps interview-mode errors sanitized as `Time Limit Exceeded`.

C++ also passes the full isolated generated C++ Algoflow corpus compile/run gate with no output mismatches: 2,256 scanned, 2,256 passed, 0 failures. The same run compared expected outputs against the other available language corpus entries: Java matched 2,256/2,256, while JavaScript, TypeScript, and Python each matched 2,093/2,256 where corresponding corpus entries exist. The local full gate is `pnpm local:mine:cpp-algoflow-corpus:isolated`, which intentionally runs with `--no-trace` because the full corpus gate is for output parity while trace semantics are covered by the runtime fixture corpus.

C# now exposes the same public execution-style set as C++: `function`, `solution-method`, `ops-class`, `script`, and `interviewMode`. C# interview mode uses the non-trace browser-local worker route, preserves normal compile/runtime diagnostics, and sanitizes timeout-like failures as `Time Limit Exceeded` with `diagnosticStage: "interview"` metadata.

C# traced events now carry call-stack frames. The Roslyn rewriter emits a precise leave hook after return-line snapshots, so call, line, snapshot, access, and return events inside a method retain the active frame while later caller events are not attributed to the callee.

C# object serialization now uses linked `__id__`/`__ref__` markers for repeated `ListNode`, `TreeNode`, and user-object references instead of opaque type-only refs, so the C# profile can advertise cycle-reference support. The C# rewriter also traces expression-bodied `Func`/`Action` lambdas and handles additional collection constructor shapes such as priority-queue capacity/comparer constructors.

JS/TS indexed access now passes for:

- `for-loop/body`
- `break-continue/add`
- `nested-loop/body`
- `indexed-write/write`
- `matrix-write/write`

JS/TS object-field access now passes for:

- `object-field-read-write/write`
- `object-field-read-write/read`

The final gap-removal pass also tightened:

- Python, JavaScript, TypeScript, and Java keyed map/dict reads now emit indexed `read` facts, not `mutate` facts.
- Python, JavaScript, TypeScript, and Java keyed map/dict writes now emit indexed `write` facts, not `mutate` facts.
- Java `Map.get`, `Map.getOrDefault`, `Map.containsKey`, `Set.contains`, and `Map.put` now emit native runtime trace reads/writes through `TraceHooks`.
- Java ops-class execution now handles both explicit constructor operations and omitted constructor operations without treating constructor aliases as instance methods.
- Java map/set rewrite matching no longer corrupts field receivers such as `node.children.containsKey(...)`.
- JavaScript/TypeScript runtime trace emission no longer prunes read/write facts based on later mutation facts.
- JavaScript/TypeScript `for` condition accesses are flushed on the condition line rather than leaking onto the next body line.
- Java function-call snapshots so callee entry snapshots expose callee arguments without caller-local leakage.
- Java list inputs so fixture-provided `List<T>` values are mutable and can model Java equivalents of cross-language list mutations.
- Java `List.remove(list.size() - 1)` so it emits the cross-language `pop` mutation operation directly.
- Java stdout so `System.out.println(...)` emits a line-attached runtime trace stdout fact.
- Java mutation-line snapshots so locals first declared by the mutation assignment do not leak as same-line state facts.
- JS/TS console logging and thrown exceptions so stdout and caught exception fixtures are line-attached runtime facts.
- Python dict/set membership, dict writes/reads, set mutations, object field access, and raised exceptions so they emit neutral runtime facts.
- Python and Java keyed field-map reads/writes now emit access to the owning object plus field and key path, matching JavaScript/TypeScript field `Map` behavior without presentation-side recovery.
- TypeScript `as`/type-assertion receivers now preserve keyed parent mutation attribution, so `(map.get(key) as T[]).push(value)` emits the same neutral runtime mutation as JavaScript `map.get(key).push(value)`.
- Java object-field map operations now emit keyed owner paths, so `node.children.get/put/containsKey/putIfAbsent(key, ...)` produces `node.children[key]` runtime facts instead of field-only reads or generic mutations.
- C++ plain local containers that intentionally remain unwrapped, including `std::vector<std::string>` and vectors with custom or variant element types, now emit fallback `mutate` events for `push_back(...)` while preserving nested argument reads such as `emailToName[email]`.
- C++ plain local set-like containers now emit fallback `mutate` events for `insert(...)` with evaluated mutation args instead of forcing consumers to infer inserts from snapshots.
- C++ reference locals such as `const std::string& w1 = words[i]` now remain visible to indexed-read instrumentation, so condition lines like `w1[j] != w2[j]` emit concrete string reads for both operands.
- C++ declaration tracking now ignores trailing source comments, so declarations like `std::unordered_map<int, int> rightIndex; // key -> index` still make later keyed writes visible to V4.
- C++ multi-line declaration scanning no longer starts from blank lines, so container declaration writes/snapshots after a spacer line are anchored to the actual declaration line instead of the blank line.
- C++ structured map range-for headers such as `for (const auto& [ch, _] : adj)` now emit iteration-binding read provenance for the key binding before body writes use that key as an index source.
- Python tuple-destructuring collection loops such as `for u, v, w in edges:` now emit iteration-binding read provenance for the produced source element instead of relying on scalar snapshots of the unpacked variables.
- JavaScript and TypeScript `for...of` loops now emit per-iteration binding reads on the loop header before the body runs, so binding values match same-header snapshots instead of being attached to the previous iteration.
- Python tuple/list destructuring assignments such as `rows, cols = ...` now emit scalar writes for each assigned local instead of relying on snapshots alone.
- Python list-comprehension assignments now collapse repeated same-line interpreter frames, so `cloned = [[] for _ in range(n)]` emits one public assignment frame with the completed `cloned` write instead of several empty line frames before the write.
- Python `enumerate(...)` loop headers now emit scalar writes for the index binding as well as iteration-read provenance for the value binding.
- Java local scalar declaration writes are being hardened so initialized locals such as `int leftGain = ...` can emit same-line `write` events instead of only appearing later in snapshots. The JS augmentation path has coverage, but the active browser worker/export seam still needs verification against the native Java rewrite output before this is considered fully closed.
- JavaScript and TypeScript destructuring assignments to local identifiers, such as `[n, edges, src] = [a, b, c]`, now emit scalar write events for each assigned local on the assignment line.
- JavaScript and TypeScript same-line guarded map initialization such as `if (!adj.has(ch)) adj.set(ch, new Set())` now preserves runtime event order by emitting the guard `has` read before the body `set` write/mutation.
- Java `Arrays.sort(array, ...)` now emits a receiver `sort` mutation event and a post-sort snapshot instead of leaving the line as snapshot-only state.
- Python in-place sequence ordering operations such as `list.sort(...)` and `list.reverse()` now emit receiver mutation events instead of relying on lambda reads and snapshots alone.
- Python object-field reads/writes now carry the observed access value immediately, preventing post-line mutations such as `curr.next = prev` from poisoning the earlier `curr.next` read event.
- JavaScript, TypeScript, Java, and C# nested indexed metadata reads such as `grid[0].length` / `grid[0].Length` now emit concrete nested read events instead of stopping at the row read and leaving the metadata value to snapshots.
- C++ `ListNode` and list-like pointer serialization now uses pointer-stable object ids, so distinct nodes do not reuse `ref-0` across separate variable snapshots in the same trace frame.
- C++ stack `TreeNode` and `ListNode` locals now participate in declaration writes and snapshots with full object serialization, so lines like `ListNode dummy(0);` are not reduced to `{}` or snapshot-only lifecycle evidence.
- C++ condition reads after short-circuit operators now preserve index-source provenance, so expressions such as `coin <= a && dp[a - coin] != INT_MAX` emit `target.indexSources:["a - coin"]` instead of treating the preceding `&&` as address-of suppression.
- C# trace-event object serialization now uses run-stable object ids for repeated user-object, `ListNode`, and `TreeNode` references, so linked/object traces do not relabel the same node across access events.
- JavaScript and TypeScript trace serialization now preserves non-finite numbers as `"Infinity"`, `"-Infinity"`, and `"NaN"` instead of allowing JSON serialization to collapse them to `null`.

## Near-Term Priority

Next, shift from hand-authored fixture closure to corpus mining:

- Add a small failure-mining runner that executes generated or harvested snippets against the runtime trace parity signature.
- Promote every minimized failure into `fixtures/runtime-parity` before fixing it.
- Keep fixes in native language instrumentation where possible. Raw runtime assembly should stay mechanical and must not accumulate higher-level coercion.

Useful mining commands:

- `pnpm mine:runtime-trace-corpus -- --limit=20`
- `pnpm mine:runtime-trace-corpus:parallel`

Treat corpus mining as failure discovery, not a strict gate. Harvested per-language solutions are often idiomatic implementations, not mechanically equivalent line-for-line fixtures, so drift clusters need triage before promotion. A cluster becomes a harness bug only after it is reduced into a small equivalent fixture that should emit the same runtime facts across languages.

The local compile gate is stricter about reliability than parity: it fails on hard harness failures such as generated Java compile errors, raw payload contract violations, and worker timeouts, but it does not fail on trace-budget exits or runtime-fact drift.

Do not patch the harness directly from mined runtime-fact drift clusters. Reduce a drift into a small equivalent runtime-parity fixture first, then fix the native language emitter if the fixture exposes a real parity gap.

## Contract Notes

A fixture is allowed to declare `knownGaps` for a language and role. The gate still executes that language and verifies that no unsupported classification leaks into runtime trace events, but skips parity comparison for the marked role.

A `knownGaps` entry is not a waiver for future behavior. When a harness fix lands, remove the corresponding gap entry in the same change so the baseline tightens over time.

Language-specific fixture overrides are not allowed as a steady state. If a language cannot meet the shared fixture expectation, mark the gap explicitly, reduce it into a smaller fixture when possible, and fix the native language instrumentation rather than coercing the raw runtime assembly seam.

The current raw-event assembly seams are temporary migration scaffolding. They may parse language instrumentation while native runtime trace emitters are being built, but they must not become the place where missing language facts are invented. Runtimes should emit line, snapshot, read, write, mutate, call, return, stdout, exception, and timeout facts directly in the runtime trace shape.

No language may introduce a raw payload category on its own. A payload such as `array-length` must either not exist or be accepted as a shared cross-language contract concept with parity coverage before higher layers are allowed to consume it.

Runtime trace events must not carry presentation-era or higher-level classification payloads. The raw emission contract rejects any runtime trace event containing `visualization`, `objectKinds`, `hashMaps`, `graph-adjacency`, `linked-list`, or `tree`. If this trips on a legitimate data snapshot, reduce that case and decide whether the runtime serializer needs a neutral representation before widening the contract.

## Raw Emission Contract

The harness now has a TraceLang-style raw runtime emission contract before runtime trace conversion:

- `pnpm test:runtime-raw-emission-contract`
- contract source: `packages/harness-core/src/runtime-raw-emission-contract.ts`

This contract rejects unsupported raw runtime payloads before they can become adapter behavior. For example, a Java-only payload such as `array-length` is invalid unless it is first added as a shared contract concept across languages.

The fixture gate also computes coarse raw emission categories for each language. C++ is included in unsupported-emission checks, while strict raw category parity currently compares the Python, JavaScript, TypeScript, Java, and C# reference-compatible set. By default, unsupported emissions fail and raw cross-language parity mismatches are advisory. Raw parity mismatches are also available as a strict gate:

- `pnpm test:runtime-trace-fixtures:raw-strict`

The strict raw parity gate is clean for the hand-authored runtime trace fixture corpus. If it fails on a new fixture, either the fixture setup is not equivalent across languages or a language emitted a runtime fact category the others did not. Reduce that mismatch before adding harness behavior.
