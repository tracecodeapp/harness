# GPT Pro Review Prompt: SQL Trace V1 Hardening

Use this prompt with GPT Pro for a skeptical architecture review of the
browser-first SQL trace work.

```text
You are reviewing TraceCode Harness architecture. Please be direct and
skeptical. I want to know whether this SQL trace V1 is solid enough to harden,
or whether the shape still has a foundational mistake.

Context:
- TraceCode Harness has an existing V4 runtime execution contract for
  programming languages.
- V4 is line/post-line oriented and has closed event kinds such as call, line,
  return, snapshot, read, write, mutate, stdout, exception, and timeout.
- V4 is for source-language runtime facts: executed lines, calls/returns,
  visible variables after a line, reads/writes/mutations, stdout, exceptions,
  timeouts, and trace budgets.
- V4 intentionally forbids downstream presentation/semantic facts such as data
  structure classification, visualizer choices, algorithm family facts,
  TraceLang lowering decisions, and presentation-only roles.
- SQL is browser-only for this project. That is non-negotiable.

Current SQL architecture:
- SQL remains a sibling trace contract, not an extension of V4 RuntimeTrace.
- The root `@tracecode/harness` export does not expose SQL helpers.
- SQL is available from `@tracecode/harness/sql` and from the standalone
  `@tracecode/harness-sql` workspace package.
- We are reusing V4 principles, not V4 event shapes:
  schemaVersion, runId on every event, closed event kinds, source spans,
  capture/redaction gates, trace budgets, validation, and no visualizer or
  semantic payload leakage.
- The contract is statement-spined rather than line-spined.
- Current SQL event kinds are:
  batch, statement, result, transaction, error, timeout, relation-access, plan,
  and notice.
- SQL events attach by statementId. Wrapper/API transaction boundaries attach by
  transactionId. Explicit SQL transaction statements such as BEGIN, COMMIT,
  ROLLBACK, SAVEPOINT, ROLLBACK TO, and RELEASE are represented through normal
  statement events plus transaction events.

Current capture/privacy defaults:
- Generic engine defaults are `kind: "custom"` and `dialect: "unknown"`.
- PGlite helper defaults are `kind: "pglite"` and `dialect: "postgres"`.
- SQL text defaults to redacted.
- Params default to redacted.
- Diagnostics default to redacted, separate from params.
- Result row capture defaults to none.
- Plans default to none.
- Relation access defaults to none.
- SQL hashes, parameter hashes, and plan hashes default to none.
- Plan detail defaults to summary only.
- Stable hashes are documented as fingerprints, not a privacy boundary.
- `maxRowsPerResult` and `maxCellBytes` are capture-time caps.
- `maxTraceBytes` is a validation budget in V1, not an emission-time event
  dropping mechanism.
- Redacted params do not include serialized byte length by default.
- Binary scalar values do not emit hashes in V1.

PGlite/browser direction:
- PGlite is the primary browser SQL runtime because it is a WASM Postgres build
  that runs in the browser and supports memory and IndexedDB persistence.
- The package does not import PGlite. Apps inject the PGlite client.
- `createPgliteSqlTraceClient(client, options)` only labels metadata and wraps
  the client.
- Default PGlite capabilities are limited to observed wrapper behavior:
  single-statement query, multi-statement exec, parameterized query, and
  transactions.
- The helper adds `explain-json` capability only when plan capture is enabled.
- PGlite is browser-local and single-connection-ish in this context, so the docs
  call it browser-only Postgres-compatible execution, not production-equivalent
  Postgres.

Current EXPLAIN behavior:
- Plan capture is conservative and opt-in via `capture.plans: "estimate"`.
- The wrapper only tries EXPLAIN JSON for SELECT statements.
- It only runs for query/sql-template APIs, not exec batches.
- It only runs when dialect is postgres.
- It records plan events as `source: "explain-json"`,
  `requestedBy: "harness"`, `mode: "estimate"`, `safeToExecute: true`,
  `targetStatementExecuted: false`, `diagnosticStatementExecuted: true`, and
  `sideEffectRisk: "planner-only"`.
- Plan events include timing for the hidden EXPLAIN query.
- The plan summary includes root node type, estimated rows, estimated total
  cost, and relation names when available.
- Raw plan values require `planDetail: "raw-capped"` or `"raw-full"`.
- Raw plan hashes require `hashes.plans: "per-run"` or `"stable"`.
- EXPLAIN ANALYZE remains unsafe by default and validation rejects analyze plans
  unless capture policy explicitly allows analyze and safeToExecute is true.

Current validation/test coverage:
- The validator rejects unknown public fields, unknown event kinds, unsupported
  enum values, duplicate event IDs, non-monotonic ordinals, trace byte budget
  violations, statement/result/error/timeout linkage problems, batch
  error/timeout linkage problems, result rows when rows are disabled,
  diagnostics that violate the diagnostics policy, hashes emitted when hashes
  are disabled, raw plan values/hashes outside plan-detail policy, unsafe
  analyze plans, oversized raw plan payloads, weak relation-access provenance,
  unknown nested public object fields, and visualizer/semantic leakage.
- Unit tests cover generic defaults, PGlite metadata, traced query capture,
  EXPLAIN estimate capture, exec batches, wrapper transaction commit/rollback,
  explicit SQL transaction boundaries, API rollback reason/status semantics,
  diagnostics redaction, privacy policy violations, timeout linkage, and
  validator rejection paths.
- Browser smoke runs real PGlite in Chromium through a Vite app, validates the
  exported trace, covers successful DDL/DML/query, failed transaction rollback,
  and opt-in EXPLAIN estimate plan capture.
- A golden fixture corpus now validates representative traces:
  query, exec batch, exec failure, API transaction rollback, explicit SQL
  transaction, EXPLAIN estimate summary plans, and privacy-none.
- `relationAccess` controls separate `relation-access` events. Plan summaries
  may still include relation mentions when plan capture is enabled.

Research findings that led here:
- PGlite `.query()` executes one parameterized statement and returns one result.
- PGlite `.exec()` executes one or more statements without parameters and
  returns one result per statement.
- PGlite transaction APIs are callback-based and commit on callback resolution,
  rollback on rejection.
- PGlite result objects expose rows, affectedRows, and fields with Postgres type
  IDs, enough for useful statement/result events.
- Exact relation/table effects are not realistically observable through
  PGlite's public high-level API. Relation access and plan events should remain
  optional derived facts with `source` and `confidence`.
- EXPLAIN JSON can be useful for derived plan/relation facts. EXPLAIN ANALYZE
  executes statements and must remain explicitly opt-in.

Where I am leaning:
- Keep SQL as a sibling contract.
- Keep SQL out of the root export; use `@tracecode/harness/sql` or
  `@tracecode/harness-sql`.
- Do not add SQL event kinds to V4.
- Do not add `sql` to the V4 `Language` union unless a future display envelope
  needs it.
- Add a future `TraceEnvelope` only if we need to correlate host-language traces
  with SQL traces in one run.
- Keep the PGlite helper in the SQL package, with no PGlite dependency, rather
  than making another adapter package now.

Questions:
1. Is the sibling contract still the right boundary now that fixtures, plan
   events, and transaction nuance exist?
2. Is the root export decision right: no SQL helpers from `@tracecode/harness`,
   but `@tracecode/harness/sql` and `@tracecode/harness-sql` are public?
3. Is the EXPLAIN estimate behavior too eager, too limited, or about right for
   a browser-first Postgres-compatible SQL trace?
4. Should plan events also emit relation-access events derived from EXPLAIN, or
   is it cleaner to keep plan summaries separate until relation provenance is
   deliberately requested?
5. Are the capture defaults strict enough for a privacy-first local/browser
   harness, especially diagnostics redaction and hash defaults?
6. Are the current fixture categories enough to stabilize V1, or what golden
   trace is missing before hardening?
7. Where could this contract still accidentally overclaim production Postgres
   fidelity?
8. Is there any concept from the V4 runtime contract we should reuse more
   directly, or would doing that make SQL less expressive?

Please answer with:
- Verdict
- Architecture risks
- Contract changes you would make before V1 hardens
- EXPLAIN/plan capture critique
- PGlite/browser fidelity caveats
- Fixture/test gaps
- Whether I am on the right path
```

Prompting note: this is structured for GPT Pro as a second architecture review
after the initial research and V1 hardening pass.
