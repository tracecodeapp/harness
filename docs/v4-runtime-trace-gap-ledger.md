# V4 Runtime Trace Gap Ledger

Last updated: 2026-05-20

This ledger tracks implicit V4 trace gaps that are currently encoded as per-language fixture overrides rather than `knownGaps`. `tests/report-runtime-trace-known-gaps.ts` reports zero formal known gaps, but the fixture corpus still contains many language-specific contracts.

## Current Fixture Override Inventory

- Fixture corpus: 73 runtime-parity fixtures.
- Formal `knownGaps`: 0.
- `expectByLanguage`: 152 language fixture overrides.
- `expectSummaryByLanguage`: 45 language summary overrides.
- `expectEventAssertionsByLanguage`: 34 language event assertion overrides.
- `expectFrameEventsByLanguage`: 8 language frame-event overrides.
- `expectLineSnapshotsByLanguage`: 1 language line-snapshot override.

By language, `expectByLanguage` override count:

- `csharp`: 37
- `java`: 32
- `python`: 23
- `javascript`: 20
- `typescript`: 20
- `cpp`: 20

## Gap Buckets

### 1. Path Depth And Access Shape

These are the largest visualizer-facing gaps because they affect how reads/writes map into nested collections and object fields.

Representative fixtures:

- `indexed-read-path1-parity`
- `indexed-write-path1-parity`
- `nested-indexed-read-write`
- `path-depth-polarity`
- `list-array-indexed-read`
- `array-map-keyed-write`
- `key-removal-vs-index-write`

Typical symptom:

- Same conceptual access appears as path depth 1 vs 2 across languages.
- Object/field paths and indexed collection paths are not normalized consistently.
- String/array row access differs by runtime API shape.

Priority: high. This directly affects visualizer edge placement and container highlighting.

#### Triage: 2026-05-20 Path-Depth/Access-Shape Bucket

Scoped fixtures:

- `path-depth-polarity`
- `indexed-read-path1-parity`
- `indexed-write-path1-parity`
- `nested-indexed-read-write`
- `list-array-indexed-read`
- `array-map-keyed-write`
- `key-removal-vs-index-write`

Gate status:

- `TRACECODE_RUNTIME_TRACE_FIXTURE=path-depth-polarity,indexed-read-path1-parity,indexed-write-path1-parity,nested-indexed-read-write,list-array-indexed-read,array-map-keyed-write,key-removal-vs-index-write pnpm test:runtime-trace-fixtures`
- Result: passing, 7 fixtures.

Classification:

| Fixture | True language/source shape | Harness-normalizable gap |
| --- | --- | --- |
| `path-depth-polarity` | Root names differ by language: Python uses `self`, JS/TS/C++ use `this`, Java/C# field access lowers to `values`. C++ explicit `this->values[0][1]` produces field-plus-index path depth 3, while Java/C# `values[0][1]` produces depth 2. | Fixture source mixes 1D fields in Python/JS/TS with 2D fields in Java/C#/C++. If this fixture is meant to compare polarity only, normalize the source shapes or split object-field and nested-index concerns into separate fixtures. |
| `indexed-read-path1-parity` | Reading row length is API-specific: Python/C++ `len(matrix[0])` and `.size()` expose the row access as depth 1; JS/TS `.length`, Java `.length`/`.length()`, and C# `.Length` expose an additional property/method step as depth 2. | C# emits an extra receiver read with no path for `matrix[0].Length` and `pizza[0].Length`. Java emits both `matrix[0]` depth 1 and `matrix[0].length` depth 2 for matrix row length. Decide whether the visualizer wants property reads collapsed to the container element access for length-like APIs. |
| `indexed-write-path1-parity` | Map decrement syntax differs: Python/C# direct index assignment is read/write; JS/TS/Java/C++ map APIs also emit a language-native mutate event (`set`, `put`, `set`). | No path-depth gap on the decrement anchor itself; depth 1 read/write is consistent. Remaining differences belong more to mutation-method shape than path-depth. |
| `nested-indexed-read-write` | Nested grid reads/writes are consistently depth 2 across runtimes on the main read/write anchors. C++ has an extra read at return because it returns `grid[1][0]`, unlike languages returning `grid`. | C# emits an extra no-path receiver read on the nested read line. C++ fixture source has a different return shape and a manual snapshot call; that inflates summary counts but not the anchor contract. Normalize fixture source if summary parity matters. |
| `list-array-indexed-read` | Runtime collection construction differs: Python/JS/TS/C++ use loops; C# uses two explicit `values.Add(rows[i])` calls; Java list construction emits duplicate `values` writes. Mutating method names are language-native (`append`, `push`, `add`, `Add`, `push_back`). | C# emits both depth 1 and depth 2 reads for `values[0][1]` / `values[1][0]`; visualizer likely only needs the deepest concrete access for highlighting. This is a good bounded C# normalization candidate. |
| `array-map-keyed-write` | JS/TS `Map.set` should emit both path-depth write and mutate; Python/C++ direct nested assignment should emit write only. C# source names `first`/`second` dictionaries before placing them in `dp`, so snapshots/writes for those locals are true source shape. | Java `merge` currently appears as a path-depth write without a mutate event. C# emits both `second[4]` and `dp[1][key]` writes for the same conceptual write; visualizer should probably prefer the owner path `dp[1][key]` for nested container highlighting and treat alias-local writes as secondary. |
| `key-removal-vs-index-write` | Decrement is depth 1 across runtimes. Removal method names are language-native (`pop`, `delete`, `remove`, `Remove`, `erase`) and should stay true to source. JS/TS/Java/C++ decrement APIs emit mutate events; Python/C# direct assignment does not. | Python/JS/TS/Java/C# removal events currently omit the removed key path while C++ `erase("b")` includes path depth 1. Standardize keyed removal to include the removed key path/index source where statically available. C# dictionary initializer emits per-key writes, which are true source/runtime initialization detail but noisy for visualizer summaries. |

Current recommendation:

1. Do not force one global `pathDepth` meaning across all languages. `pathDepth` should remain the concrete runtime access path, because property/method reads, object fields, and container indices are genuinely different operations.
2. Add a visualizer-facing normalized access projection alongside raw events, rather than erasing raw runtime truth. The projection can expose fields such as `containerVariable`, `containerPathDepth`, `effectiveElementPathDepth`, `accessRole`, and `isAliasSecondary`.
3. First bounded patch: C# access normalization. Suppress or mark no-path receiver reads and intermediate depth-1 reads when the same line has a deeper path access for the same variable. This directly affects `indexed-read-path1-parity`, `nested-indexed-read-write`, and `list-array-indexed-read`.
4. Second bounded patch: keyed removal path standardization. Emit/derive the removed key path for Python/JS/TS/Java/C# removals so `key-removal-vs-index-write` gives the visualizer a consistent element target.
5. Third bounded patch: fixture cleanup. Split `path-depth-polarity` into object-field polarity and nested-index polarity, or align its source shapes so it stops mixing both concerns.

### 2. Keyed/Indexed Provenance

These gaps affect index-source attribution and whether the visualizer can explain why an element was touched.

Representative fixtures:

- `computed-index-source-provenance`
- `indexed-keyed-write-provenance`
- `indexed-list-mutate-provenance`
- `char-computed-index-provenance`
- `foreach-bound-indexed-read`

Typical symptom:

- `indexSources` differ by language.
- Some runtimes attach provenance to the receiver path, others to the keyed/indexed argument.
- C# and C++ often need runtime-specific assertions for equivalent operations.

Priority: high. This powers visual explanation of computed index/key access.

### 3. Mutation Method And Args Shape

These gaps affect how the visualizer labels operation intent.

Representative fixtures:

- `heapq-mutation`
- `map-nested-mutation`
- `empty-map-clear-mutate`
- `list-pop`
- `js-array-splice-pop`
- `queue-fifo`
- `set-add-remove`
- `monotonic-stack-daily-temperatures`

Typical symptom:

- Semantically equivalent operations use language-native method names: `Add`, `append`, `push_back`, `Enqueue`, `push`, `pop`, `RemoveAt`.
- Some runtimes emit `mutate`, some emit read/write plus snapshot.
- Mutation args may be present in one runtime and absent in another.

Priority: medium-high. Method labels should stay true to language, but event payload shape should be consistent enough for visualizer branching.

### 4. Line/Anchor And Snapshot Timing

These gaps affect step ordering and visualizer frame selection.

Representative fixtures:

- `while-loop`
- `nested-loop`
- `foreach-line-sequence`
- `post-line-state-rotated-search`
- `function-call`
- `stdout`
- `exception`
- `cpp-script-two-pointer-line-anchors`

Typical symptom:

- Events are anchored to function entry or loop header instead of the executed statement.
- Python post-line semantics differ from ahead-of-line runtimes.
- C++ and C# stdout now emit visualizer-facing frame context in the `stdout` fixture.

Priority: high for stdout/function/loop anchors; medium for acceptable language syntax differences.

### 5. Frame Context Contracts

Recent commits standardized most of this, but residual explicit per-language frame assertions remain.

Representative fixtures:

- `function-call`
- `recursion`
- `stdout`

Current state:

- `call` and `return` have named args and stack contracts.
- `line`/`snapshot` frame-stack contracts are gated for recursion/function calls.
- `stdout` frame stack is gated for Python, JS/TS, Java, C++, and C#.

Priority: low. The current explicit per-language frame assertions are mostly fixture bookkeeping around language-specific output statements.

### 6. Exception Shape

Representative fixtures:

- `exception`

Typical symptom:

- Python includes a return event on exception path.
- C#/Java/C++ exception surfaces differ based on host/runtime throw path.

Priority: medium. Visualizer primarily needs message, line, and active frame where available.

## Current Worker Split

### Completed: C++ Stdout Line Anchor

Scope:

- Fixed `stdout` source line anchoring in C++ runtime trace.
- `fixtures/runtime-parity/stdout/solution.cpp` emits stdout at line 4.
- Enabled `cpp` in `expectFrameEventsByLanguage.stdout.print`.

Likely files:

- `workers/cpp/cpp-worker.js`
- `packages/harness-cpp/workers/cpp-worker.js`
- `fixtures/runtime-parity/stdout/case.json`

### Completed: C# Inline Stdout Trace

Scope:

- Replaced synthetic post-run stdout as the primary trace source with host-side stdout events.
- Added host stdout trace events with source line/callStack when `Console.WriteLine` runs.
- Kept synthetic stdout as a fallback for older host results.
- Enabled `csharp` in `expectFrameEventsByLanguage.stdout.print`.

Likely files:

- `spikes/csharp-wasm-roslyn/TraceCode.CSharpHost/RuntimeTraceSink.cs`
- `spikes/csharp-wasm-roslyn/TraceCode.CSharpHost/CompilerHost.cs`
- `workers/csharp/csharp-worker.js`
- `packages/harness-browser/src/csharp-worker-client.ts`
- `fixtures/runtime-parity/stdout/case.json`

### Local Main Thread: Gap Ledger And Next Slices

Scope:

- Maintain this ledger.
- Use worker results to decide next parallel split.
- Candidate next split after stdout:
  - Path-depth parity cluster.
  - Keyed/index provenance cluster.
  - Mutation method/args cluster.

## Keyed/Indexed Provenance Slice Notes

Target fixtures reviewed:

- `computed-index-source-provenance`
- `char-computed-index-provenance`
- `indexed-keyed-write-provenance`
- `indexed-list-mutate-provenance`
- `foreach-bound-indexed-read`
- `field-map-keyed-read-write`

Targeted fixture gates pass, but these fixtures still encode visualizer-facing divergence through overrides rather than formal `knownGaps`.

Current findings:

- Computed index reads are structurally consistent: all runtimes attach `indexSources` to the indexed/keyed target at path depth 1. The raw source expression remains language-native (`len(prefix) - 1`, `prefix.length - 1`, `prefix.size() - 1`, `prefix.Count - 1`). This is probably not a runtime bug; a visualizer should treat `indexSources` as explanatory source text, not a cross-language semantic key.
- Character-derived index writes are structurally consistent on the `counts` target, but Python and C++ also emit a separate `text[i]` read while C# does not. That is runtime/source-shape richness, not a missing `counts` provenance signal.
- Indexed keyed writes all preserve `indexSources: ["item"]` on the `seen` write. JS/TS/Java/C++ also emit language-native mutate events, and JS/TS/Python/C# emit separate `item` reads for key/length evaluation. The standard contract should be "keyed write carries indexSources", while method/read richness remains language-specific.
- Indexed list mutation preserves receiver provenance across all runtimes: `graph` mutate path depth 1 with `indexSources: ["i"]` and arg `7`. Method names remain intentionally language-native (`append`, `push`, `add`, `Add`, `push_back`).
- Foreach-bound indexed reads preserve `bindingVariable: "account"` and `account[i]` index provenance across runtimes. C# additionally emits an explicit loop-variable write on bind and a separate `i` read at indexed access.
- Field map keyed reads/writes now have stale fixture expectations tightened for Java/C#: both runtimes emit `indexSources: [null, "key"]` on `this.counts[key]` read/write targets. Remaining C++ gap is narrower: C++ emits at least one unprovenanced `this.counts[key]` read/mutate before the provenanced write/read events, so event assertions still avoid requiring `indexSources` on its mutate.

Recommended next patch for this bucket:

- Normalize or enrich C++ unordered-map subscript mutation so the primary `mutate` event for `this->counts[key] = ...` carries `indexSources: [null, "key"]`. This would remove the last receiver-provenance branch in `field-map-keyed-read-write` without flattening language-native method names.
- After that, split a policy decision from runtime work: keep language-native `indexSources` strings as-is, but document a visualizer contract that only target path shape and source-expression presence are standardized, not expression spelling.

## Mutation Method/Args Shape Slice Notes

Target fixtures reviewed:

- `heapq-mutation`
- `queue-fifo`
- `set-add-remove`
- `list-pop`
- `js-array-splice-pop`
- `map-nested-mutation`
- `empty-map-clear-mutate`
- `monotonic-stack-daily-temperatures`

Targeted fixture gates pass for the reviewed mutation bucket.

Classification:

- Language-native `method` values should stay raw and source-true. Examples: `heappush`, `heappop`, `offer`, `poll`, `Enqueue`, `Dequeue`, `insert`, `erase`, `RemoveAt`, `splice`, `push_back`.
- Visualizer-standard payload fields should be stable across runtimes: `args`, `target.variable`, `target.path`, and `target.indexSources`.
- The concrete payload gap found in this slice was Java `Set.remove(key)`: it emitted a `mutate` event without `args`, unlike the other runtimes. This is now fixed and gated by `set-add-remove`.

Current fix:

- Java `removeSetAtLine` now emits `args: [key]`.
- `set-add-remove` now has cross-language event assertions requiring set add/remove mutation args.

Remaining gaps:

- The visualizer still needs to map raw language methods to semantic operation categories.
- Nested map/list setup mutations still differ by language (`set`, `put`, C++ synthetic `set`) and should probably get an optional normalized operation/category field rather than mutating raw `method`.
- Variable naming differences such as `values` vs `nums` and `stk` vs `stack` remain source-true and should not be normalized in V4.

Recommended next patch for this bucket:

- Add an optional normalized mutation field, for example `operation`, on `mutate` events while preserving raw `method`.
- Suggested operation values: `append`, `popBack`, `popFront`, `removeKey`, `clear`, `heapPush`, `heapPop`, `mapSet`.
- This would give the visualizer one stable semantic surface without losing runtime/language truth.

## Recommended Next Parallel Slices

1. `path-depth-polarity` + `indexed-read-path1-parity` + `nested-indexed-read-write`.
2. `computed-index-source-provenance` + `indexed-keyed-write-provenance` + `indexed-list-mutate-provenance`.
3. `heapq-mutation` + `queue-fifo` + `set-add-remove` + `list-pop`.
4. `while-loop` + `nested-loop` + `foreach-line-sequence` line-anchor cluster.
5. `exception` contract cleanup after stdout frame context is resolved.
