# Runtime V4 Parity Status

Last updated: 2026-04-29

## Purpose

The Runtime V4 parity corpus defines the language-agnostic harness contract for playback-facing traces. Fixtures should describe runtime facts only:

- which source line ran
- which variables were visible at that point
- which values were read, written, or mutated
- which calls, returns, stdout writes, exceptions, timeouts, or snapshots occurred

The fixture corpus must not encode semantic classification such as graph adjacency, linked lists, hash maps, or other visualizer-era structures. Those belong in the semantic engine and downstream runtime-fact attachment.

## Cutover Goal

The end state is native V4 trace emission from every language runtime. Python, JavaScript, TypeScript, and Java should produce `RuntimeV4Trace`-shaped events themselves instead of producing legacy trace steps that are then coerced through an adapter.

The current `runtimeTraceContractToV4Events(...)` path is a migration bridge only. It exists so the corpus can define and test the target contract before every runtime has native V4 output. It should not become a compatibility layer where new behavior is hidden by translating old V2/V3 trace shapes into V4 after the fact.

As of the V4 public-boundary cutover, `ExecutionResult.trace` is a `RuntimeV4Trace`. Public runtime clients must not return legacy trace-step arrays. Any remaining `LegacyTraceExecutionResult` usage is internal migration debt at worker/raw-instrumentation seams and should be pushed downward into native language emitters, not exposed to product consumers.

This means the V4 cutover is allowed to be breaking:

- Prefer exposing missing runtime facts as visible fixture gaps over masking them in the bridge adapter.
- Prefer deleting old trace dependencies once a language emits V4 natively.
- Do not add semantic classification or visualizer-specific recovery logic to the bridge.
- Do not make frontend correctness depend on both the old trace contract and the V4 contract at the same time.

## Current Corpus

- Fixture directory: `fixtures/runtime-parity`
- Fixture count: 25
- Languages covered per fixture: Python, JavaScript, TypeScript, Java
- Official gate: `pnpm test:runtime-v4`
- Gate: `pnpm test:runtime-v4-fixtures`
- Strict raw parity gate: `pnpm test:runtime-v4-fixtures:raw-strict`
- Raw emission contract gate: `pnpm test:runtime-raw-emission-contract`
- Synthetic parity smoke gate: `pnpm test:runtime-v4-parity`
- Gap report: `pnpm report:runtime-v4-known-gaps`

`pnpm test:runtime-v4` is part of both `pnpm test` and `pnpm test:ci`. Any runtime instrumentation change that alters cross-language V4 parity, introduces unsupported raw payloads, or reopens known gaps should fail before merge.

Python, JavaScript, TypeScript, and Java browser runtime clients now return V4 directly at `result.trace`; the browser clients no longer expose legacy trace steps. Java `TraceHooks` now emits native `v4:` event payloads, and Java worker-client results carry V4 at `trace`. The public Java runtime boundary is V4-only. The old synthetic `javaEvents` fixture field has been removed from the contract so fixture results cannot accidentally mask actual Java harness behavior.

The remaining legacy seams are internal raw worker traces used by migration checks and Python fixture execution while its runtime emitter is migrated. These are not supported public trace contracts.

## Baseline Known Gaps

Current known gap count: 0

By language:

- Java: 0
- JavaScript: 0
- Python: 0
- TypeScript: 0

Main clusters:

- No open fixture gaps in the current 25-fixture corpus.
- The corpus now covers indexed access, indexed writes, aggregate access counts, list append/pop, matrix writes, map/dict put/get/contains, set add/remove/contains, loops, break/continue, early return, function calls, recursion, stdout, caught exceptions, and object field read/write across Python, JavaScript, TypeScript, and Java.
- This is a baseline, not proof of completeness. New operations should be added to the corpus as soon as they become product-relevant or are discovered through corpus mining.

## Recently Tightened

Java local snapshot completeness now passes for the core loop and mutation fixtures:

- `for-loop/body`
- `break-continue/add`
- `nested-loop/body`
- `list-append/append`

The fix was made in Java runtime source augmentation so Java emits the missing local snapshots itself before the temporary V4 bridge sees the trace.

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

- Java function-call snapshots so callee entry snapshots expose callee arguments without caller-local leakage.
- Java list inputs so fixture-provided `List<T>` values are mutable and can model Java equivalents of cross-language list mutations.
- Java `List.remove(list.size() - 1)` so it emits the cross-language `pop` mutation operation directly.
- Java stdout so `System.out.println(...)` emits a line-attached V4 stdout fact.
- Java mutation-line snapshots so locals first declared by the mutation assignment do not leak as same-line state facts.
- JS/TS console logging and thrown exceptions so stdout and caught exception fixtures are line-attached runtime facts.
- Python dict/set membership, dict writes/reads, set mutations, object field access, and raised exceptions so they emit neutral V4 runtime facts.

## Near-Term Priority

Next, shift from hand-authored fixture closure to corpus mining:

- Add a small failure-mining runner that executes generated or harvested snippets against the V4 parity signature.
- Promote every minimized failure into `fixtures/runtime-parity` before fixing it.
- Keep fixes in native language instrumentation where possible. The temporary V4 bridge should keep shrinking, not accumulating semantic coercion.

Initial mining command:

- `pnpm mine:runtime-v4-final300 -- --limit=20`

The miner defaults to `/Users/obinnanwachukwu/Code/algoflow/tests/v3-corpus/tracecode-final300-slice.json` when that local corpus exists. The final300 slice lists Python, JavaScript, and TypeScript entries; the miner also synthesizes Java entries from `/Users/obinnanwachukwu/Code/algoflow/experiments/trusted-visualizer-corpus/generated-validated-java/problems/<slug>/java.java` when available.

Treat final300 mining as failure discovery, not a strict gate. The per-language final300 solutions are idiomatic implementations, not mechanically equivalent line-for-line fixtures, so drift clusters need triage before promotion. A cluster becomes a harness bug only after it is reduced into a small equivalent fixture that should emit the same V4 runtime facts across languages.

## Contract Notes

A fixture is allowed to declare `knownGaps` for a language and role. The gate still executes that language and verifies that no legacy visualization classification leaks into V4 events, but skips parity comparison for the marked role.

A `knownGaps` entry is not a waiver for future behavior. When a harness fix lands, remove the corresponding gap entry in the same change so the baseline tightens over time.

Language-specific fixture overrides are not allowed as a steady state. If a language cannot meet the shared fixture expectation, mark the gap explicitly, reduce it into a smaller fixture when possible, and fix the native language instrumentation rather than coercing the temporary V4 bridge.

The current raw-event assembly seams are temporary migration scaffolding. They may parse language instrumentation while native V4 emitters are being built, but they must not become the place where missing language facts are invented. Runtimes should emit line, snapshot, read, write, mutate, call, return, stdout, exception, and timeout facts directly in the V4 shape.

No language may introduce a raw payload category on its own. A payload such as `array-length` must either not exist or be accepted as a shared cross-language contract concept with parity coverage before higher layers are allowed to consume it.

## Raw Emission Contract

The harness now has a TraceLang-style raw runtime emission contract before V4 conversion:

- `pnpm test:runtime-raw-emission-contract`
- contract source: `packages/harness-core/src/runtime-raw-emission-contract.ts`

This contract rejects unsupported raw runtime payloads before they can become adapter behavior. For example, a Java-only payload such as `array-length` is invalid unless it is first added as a shared contract concept across languages.

The fixture gate also computes coarse raw emission categories for each language. By default, unsupported emissions fail and raw cross-language parity mismatches are advisory. Raw parity mismatches are also available as a strict gate:

- `pnpm test:runtime-v4-fixtures:raw-strict`

The strict raw parity gate is clean for the hand-authored V4 fixture corpus. If it fails on a new fixture, either the fixture setup is not equivalent across languages or a language emitted a runtime fact category the others did not. Reduce that mismatch before adding harness behavior.
