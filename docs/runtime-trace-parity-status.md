# Runtime Trace Parity Status

Last updated: 2026-05-02

## Purpose

The Runtime Trace parity corpus defines the language-agnostic harness contract for playback-facing traces. Fixtures should describe runtime facts only:

- which source line ran
- which variables were visible at that point
- which values were read, written, or mutated
- which calls, returns, stdout writes, exceptions, timeouts, or snapshots occurred

The fixture corpus must not encode semantic classification such as graph adjacency, linked lists, hash maps, or other visualizer-era structures. Those belong in the semantic engine and downstream runtime-fact attachment.

## Cutover Goal

The end state is native runtime trace emission from every language runtime. Python, JavaScript, TypeScript, and Java should produce `RuntimeTrace`-shaped events themselves instead of producing legacy trace steps that are then coerced through an adapter.

The old trace-step adapter path has been removed from the public runtime boundary. New behavior must be emitted as runtime trace facts by the language runtimes or rejected by the raw emission contract.

As of the runtime trace public-boundary cutover, `ExecutionResult.trace` is a `RuntimeTrace`. Public runtime clients must not return legacy trace-step arrays. Any remaining legacy trace-step usage is internal migration debt at worker/raw-instrumentation seams and should be pushed downward into native language emitters, not exposed to product consumers.

This means the runtime trace cutover is allowed to be breaking:

- Prefer exposing missing runtime facts as visible fixture gaps over masking them in the runtime trace adapter.
- Prefer deleting old trace dependencies once a language emits runtime trace natively.
- Do not add semantic classification or visualizer-specific recovery logic to runtime trace emission.
- Do not make frontend correctness depend on both the old trace contract and the runtime trace contract at the same time.

## Current Corpus

- Fixture directory: `fixtures/runtime-parity`
- Fixture count: 57
- Languages covered per fixture: Python, JavaScript, TypeScript, Java
- Official gate: `pnpm test:runtime-trace`
- Gate: `pnpm test:runtime-trace-fixtures`
- Strict raw parity gate: `pnpm test:runtime-trace-fixtures:raw-strict`
- Raw emission contract gate: `pnpm test:runtime-raw-emission-contract`
- Synthetic parity smoke gate: `pnpm test:runtime-trace-parity`
- Gap report: `pnpm report:runtime-trace-known-gaps`

`pnpm test:runtime-trace` is part of both `pnpm test` and `pnpm test:ci`. Any runtime instrumentation change that alters cross-language runtime trace parity, introduces unsupported raw payloads, or reopens known gaps should fail before merge.

Python, JavaScript, TypeScript, and Java browser runtime clients now return runtime trace directly at `result.trace`; the browser clients no longer expose legacy trace steps. Java `TraceHooks` now emits native `trace:` event payloads, and Java worker-client results carry runtime trace at `trace`. The public Java runtime boundary is runtime trace-only. The old synthetic `javaEvents` fixture field has been removed from the contract so fixture results cannot accidentally mask actual Java harness behavior.

The remaining legacy seams are internal raw worker traces used by migration checks and Python fixture execution while raw language instrumentation is normalized into runtime trace events. These are not supported public trace contracts.

## Baseline Known Gaps

Current known gap count: 0

By language:

- Java: 0
- JavaScript: 0
- Python: 0
- TypeScript: 0

Main clusters:

- No open fixture gaps in the current 57-fixture corpus.
- The corpus now covers indexed access, indexed writes, aggregate access counts, list append/pop, matrix writes, map/dict put/get/contains, set add/remove/contains, loops, break/continue, early return, function calls, recursion, stdout, caught exceptions, and object field read/write across Python, JavaScript, TypeScript, and Java.
- This is a baseline, not proof of completeness. New operations should be added to the corpus as soon as they become product-relevant or are discovered through corpus mining.

## Recently Tightened

Java local snapshot completeness now passes for the core loop and mutation fixtures:

- `for-loop/body`
- `break-continue/add`
- `nested-loop/body`
- `list-append/append`

The fix was made in Java runtime source augmentation so Java emits the missing local snapshots itself before the raw runtime assembly seam sees the trace.

Java object-field access also now passes for `object-field-read-write/write` and `object-field-read-write/read`. Java emits field read/write hooks as neutral access facts instead of relying on legacy visualization-shaped object payloads.

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
- Python and Java keyed field-map reads/writes now emit access to the owning object plus field and key path, matching JavaScript/TypeScript field `Map` behavior without visualizer-side recovery.
- TypeScript `as`/type-assertion receivers now preserve keyed parent mutation attribution, so `(map.get(key) as T[]).push(value)` emits the same neutral runtime mutation as JavaScript `map.get(key).push(value)`.
- Java object-field map operations now emit keyed owner paths, so `node.children.get/put/containsKey/putIfAbsent(key, ...)` produces `node.children[key]` runtime facts instead of field-only reads or generic mutations.

## Near-Term Priority

Next, shift from hand-authored fixture closure to corpus mining:

- Add a small failure-mining runner that executes generated or harvested snippets against the runtime trace parity signature.
- Promote every minimized failure into `fixtures/runtime-parity` before fixing it.
- Keep fixes in native language instrumentation where possible. Raw runtime assembly should stay mechanical and must not accumulate semantic coercion.

Initial mining command:

- `pnpm mine:runtime-trace-final300 -- --limit=20`
- `pnpm local:test:runtime-trace-final300-compile`

The miner is a local/private validation path, not public harness CI. It defaults to `/Users/obinnanwachukwu/Code/algoflow/tests/v3-corpus/tracecode-final300-slice.json` when that local corpus exists. The final300 slice lists Python, JavaScript, and TypeScript entries; the miner also synthesizes Java entries from `/Users/obinnanwachukwu/Code/algoflow/experiments/trusted-visualizer-corpus/generated-validated-java/problems/<slug>/java.java` when available.

Treat final300 mining as failure discovery, not a strict gate. The per-language final300 solutions are idiomatic implementations, not mechanically equivalent line-for-line fixtures, so drift clusters need triage before promotion. A cluster becomes a harness bug only after it is reduced into a small equivalent fixture that should emit the same runtime facts across languages.

The local compile gate is stricter about reliability than parity: it fails on hard harness failures such as generated Java compile errors, raw payload contract violations, and worker timeouts, but it does not fail on trace-budget exits or runtime-fact drift.

Current local mining status:

- Final300 runtime corpus: 300 language entries grouped into 100 problem groups.
- Final300 post-v4 clean check: 100 groups, 300 comparisons, 0 drifts, 0 failures.
- Final300 report: `reports/runtime-trace-final300-000-099-post-java-v4-cleancheck.json`.
- TC83 runtime corpus: 83 groups, 249 manifest entries, 79 synthesized Java entries in the latest run.
- TC83 post-v4 source-root check: 83 groups, 245 comparisons, 0 hard failures.
- TC83 output drift count: 14, all observed drifts are unordered-output/corpus compare issues, not harness crashes.
- TC83 strict runtime-facts report remains advisory: 54 drifts were observed after promoting keyed field-map access, TypeScript assertion-receiver mutation, and Java object-field map access into fixture-backed harness fixes. Remaining drifts are mostly implementation/corpus representation drift rather than minimized equivalent parity failures.
- TC83 strict runtime-facts reports now include `classificationSummary` and per-drift `classification`, `confidence`, and `evidence`. Latest split: 0 `fixture-worthy`, 48 `implementation-drift`, and 6 `metric-sensitive`. Use `fixture-worthy` as the queue for reduced fixture promotion, `implementation-drift` for likely corpus or solution-structure differences, and `metric-sensitive` for cases where the same runtime operation kinds are present but current scoring/display metrics are sensitive to path depth, count, or naming.
- TC83 reports: `reports/runtime-trace-tc83-post-java-v4-source-root.json`, `reports/runtime-trace-tc83-post-java-v4-runtime-facts.json`, and `reports/runtime-trace-tc83-parity.json`.

Do not patch the harness directly from TC83 runtime-fact drift clusters. Reduce a drift into a small equivalent runtime-parity fixture first, then fix the native language emitter if the fixture exposes a real parity gap.

## Contract Notes

A fixture is allowed to declare `knownGaps` for a language and role. The gate still executes that language and verifies that no legacy visualization classification leaks into runtime trace events, but skips parity comparison for the marked role.

A `knownGaps` entry is not a waiver for future behavior. When a harness fix lands, remove the corresponding gap entry in the same change so the baseline tightens over time.

Language-specific fixture overrides are not allowed as a steady state. If a language cannot meet the shared fixture expectation, mark the gap explicitly, reduce it into a smaller fixture when possible, and fix the native language instrumentation rather than coercing the raw runtime assembly seam.

The current raw-event assembly seams are temporary migration scaffolding. They may parse language instrumentation while native runtime trace emitters are being built, but they must not become the place where missing language facts are invented. Runtimes should emit line, snapshot, read, write, mutate, call, return, stdout, exception, and timeout facts directly in the runtime trace shape.

No language may introduce a raw payload category on its own. A payload such as `array-length` must either not exist or be accepted as a shared cross-language contract concept with parity coverage before higher layers are allowed to consume it.

Runtime trace events must not carry visualizer-era or semantic classification payloads. The raw emission contract rejects any runtime trace event containing `visualization`, `objectKinds`, `hashMaps`, `graph-adjacency`, `linked-list`, or `tree`. If this trips on a legitimate data snapshot, reduce that case and decide whether the runtime serializer needs a neutral representation before widening the contract.

## Raw Emission Contract

The harness now has a TraceLang-style raw runtime emission contract before runtime trace conversion:

- `pnpm test:runtime-raw-emission-contract`
- contract source: `packages/harness-core/src/runtime-raw-emission-contract.ts`

This contract rejects unsupported raw runtime payloads before they can become adapter behavior. For example, a Java-only payload such as `array-length` is invalid unless it is first added as a shared contract concept across languages.

The fixture gate also computes coarse raw emission categories for each language. By default, unsupported emissions fail and raw cross-language parity mismatches are advisory. Raw parity mismatches are also available as a strict gate:

- `pnpm test:runtime-trace-fixtures:raw-strict`

The strict raw parity gate is clean for the hand-authored runtime trace fixture corpus. If it fails on a new fixture, either the fixture setup is not equivalent across languages or a language emitted a runtime fact category the others did not. Reduce that mismatch before adding harness behavior.
