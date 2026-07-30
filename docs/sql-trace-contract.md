# SQL Trace Contract

Status: implemented V1 contract in the private `@tracecode/runtime-sql`
workspace, with PGlite as the primary browser Postgres-compatible engine
target. The runtime workspace is not published independently, and
`@tracecode/harness` does not expose a `/sql` subpath.

## Purpose

TraceCode's V4 runtime trace contract is a programming-language contract. It is
line-spined, frame-aware, and centered on variables, object identity, indexed
reads, writes, mutations, stdout, exceptions, and trace budgets.

SQL needs a separate contract. SQL execution is statement-spined and database
state oriented: statements, transactions, result sets, relations, plans,
diagnostics, constraints, and notices. A SQL trace that pretends to be a V4
`RuntimeTrace` would either weaken V4 or produce misleading fake `line`,
`read`, `write`, and object-target events.

The SQL layer therefore uses a sibling contract:

```text
RuntimeTrace        language runtime trace, line spine, variable/object facts
SqlTrace            SQL runtime trace, statement spine, database facts
TraceEnvelope       optional future wrapper for correlating both traces
```

This note defines the implemented V1 boundary and the fidelity limits that
future SQL work should preserve.

## V1 Decision

The SQL trace contract should be:

- browser-first and engine-capability-labeled
- statement-first, with one required `statement` event per executed statement
- strict about raw facts and hostile to visualizer or semantic payload leakage
- conservative about relation access and plans
- private by default for SQL text, parameters, result rows, plan details,
  hashes, and error details

The V1 contract should not:

- add `sql` to the V4 `Language` type
- add SQL event kinds to `RuntimeTraceEventKind`
- use V4 `read`, `write`, or `mutate` for tables
- promise exact table, index, trigger, lock, MVCC, or row-level effects
- describe PGlite as production-equivalent Postgres
- depend on project mode

## Primary Engine And Package Boundary

PGlite is the primary engine candidate because it is a WASM Postgres build that
runs in the browser and supports in-memory or IndexedDB persistence. It gives
the harness a Postgres-compatible dialect without requiring a server process.

`@tracecode/runtime-sql` intentionally does not vendor PGlite. The private
workspace owns the trace contract, validation, redaction, result capture,
statement splitting, and dependency-injection wrappers. Monorepo browser apps
inject their chosen SQL client and use `createSqlRuntimeTraceClient(...)`,
setting known provider metadata such as `kind: 'pglite'` and
`dialect: 'postgres'` explicitly. Both runtime and low-level wrappers default
to `custom` / `unknown`, so the workspace never
attributes a provider or dialect it was not given.

The primary product claim should be:

> browser-only Postgres-compatible execution for teaching, debugging, and local
> harness runs

It should not be:

> production-equivalent Postgres in the browser

Important PGlite facts for V1:

- `query(sql, params?)` executes a single parameterized statement and returns a
  single result object.
- `exec(sql)` executes one or more statements and returns one result object per
  statement, but does not support parameters.
- PGlite's `.sql` tagged-template API is not intercepted by the generic wrapper;
  apps must route template calls through `traceQuery(..., { api:
  'sql-template' })` or an app-level helper if they should be traced.
- result objects expose rows, affected rows, and fields, which are enough for
  useful statement and result events.
- `describeQuery(...)` can expose parameter and result-field type metadata
  without executing the query; this is useful later but not required for V1.
- wrapper-level transactions are observable through `transaction(...)`.
- PGlite is a single-connection database. Multiplexed connection support is not
  the same as normal multi-backend Postgres.
- the live-query extension can expose reactive query changes, but it is not a
  general-purpose audit hook for every relation touched by every statement.

SQLite WASM remains a fallback or comparison engine. Its native trace hook
surface is stronger for low-level statement profiling, but SQLite is not the
right primary engine when the goal is Postgres-like app SQL.

DuckDB-WASM is a separate analytics-oriented option. It should not drive the V1
contract unless the product direction shifts toward CSV, Parquet, Arrow, or
OLAP workloads.

## Browser Smoke

`examples/sql-browser` runs real PGlite inside Chromium through Vite. The smoke
creates a table, inserts rows, updates rows, executes a parameterized `SELECT`,
exports `SqlTrace`, validates it with `assertValidSqlTrace(...)`, and covers a
failed unique-constraint transaction that rolls back.

This is the practical fidelity line for V1: the contract is proven against a
browser Postgres-compatible engine, while relation access and plan events remain
optional derived facts instead of mandatory engine-internal truth.

## Concurrency And Multiple Databases

One `SqlTrace` represents one wrapped SQL client for one run. Apps that use
multiple browser database instances should create one traced client per database
and keep the resulting traces separate:

```ts
const usersDb = createSqlRuntimeTraceClient(usersPglite, {
  runId: 'sql:users-db',
  engine: { kind: 'pglite', dialect: 'postgres' },
  persistenceLocation: 'memory://users',
});

const analyticsDb = createSqlRuntimeTraceClient(analyticsPglite, {
  runId: 'sql:analytics-db',
  engine: { kind: 'pglite', dialect: 'postgres' },
  persistenceLocation: 'memory://analytics',
});
```

Event IDs and ordinals are scoped to the trace `runId`; they are not global
across database instances.

For concurrent calls on the same traced client, V1 event ordinals reflect
observed emission/completion order. Statement `timing` carries start/end/duration
and is the source of truth for overlapping operations. V1 does not claim
production Postgres concurrency fidelity: no connection-pool scheduling, lock
contention, deadlock, MVCC, or multi-backend behavior is modeled.

The generic wrapper has one active explicit-SQL transaction context per traced
client. Do not run overlapping explicit SQL transaction scripts on the same
traced client if you need precise transaction attribution. Use separate traced
clients/runs or serialize those operations.

## Isolated Case Runner

`runtime-sql` can run SQL problem cases through a runner layered above the trace
client. This runner keeps problem/test semantics out of `SqlTrace`; traces remain
raw execution facts.

The V1 runner isolation contract is `fresh-database`:

- setup and seed SQL are hidden harness inputs
- every case receives a fresh database created from the same baseline
- case assertions run after the user attempt and are hidden by default
- setup, attempt, and assertion traces use separate `runId`s
- setup/assertion traces are internal unless explicitly requested

The preferred browser implementation is baseline snapshot restore: create a
PGlite database, run setup/seed, call `dumpDataDir()`, then create each case
database with `loadDataDir`. If an engine or app does not provide a snapshot
hook, the runner can still preserve isolation by creating a new database for each
case and rerunning setup/seed.

Do not make shared-readonly execution a public V1 mode. Even SELECT-only prompts
are untrusted submissions unless a product separately enforces a restricted SQL
grammar.

## V1 Event Model

`statement` is the only required spine event. All other statement-scoped events
attach by `statementId`.

```ts
export type SqlTraceEventKind =
  | 'batch'
  | 'statement'
  | 'result'
  | 'transaction'
  | 'error'
  | 'timeout'
  | 'relation-access'
  | 'plan'
  | 'notice';
```

### Required

`batch`

Emitted for multi-statement `exec`, scripts, and migration-like inputs. The
batch event is the truth-bearing container for the whole submitted SQL string.
Successful batches can have reconstructed statement events with the same
`batchId`; failed batches should not pretend the harness knows which internal
statements succeeded unless the engine returned enough information.

Batch events carry:

- `batchId`
- API surface, such as `exec`, `script`, or `migration`
- captured SQL text/hashes according to policy
- whole-batch timing
- terminal status: `ok`, `error`, or `timeout`
- `statementCountKnown` when the harness can split the script. For generic
  `exec` wrappers this count is harness-splitter-derived, not engine-parse
  confirmation.
- `timingSource`, normally `measured`

`statement`

Emitted once for each executed SQL statement after the statement succeeds,
fails, or times out. This is the SQL analogue of V4's post-line model.

The event should carry:

- `statementId`
- ordinal within the run
- API surface, such as `query`, `exec`, `sql-template`, `script`, or `protocol`
- SQL text, redacted SQL text, or hashes according to capture policy
- parameter metadata according to capture policy
- operation category, with source and confidence if derived
- source span for multi-statement scripts when available
- monotonic start, end, and duration timing when available
- `batchId`, `statementIndex`, and `timingSource` when reconstructed from a
  multi-statement batch
- terminal status: `ok`, `error`, or `timeout`
- summary counts, such as affected rows, returned rows captured, and field count
- `transactionContext`, one of `autocommit-implicit`, `explicit-sql`,
  `api-wrapper`, or `unknown`

### Common V1 Events

`result`

Captures field metadata and, when enabled, sampled result rows. Result rows
default to disabled, must be capped when captured, and must be
truncation-labeled. `affectedRows` is separate from returned row count.
`fieldsSource` labels whether columns came from engine metadata or row-shape
inference.

`transaction`

Captures explicit `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, and
`ROLLBACK TO` when visible as SQL statements, plus wrapper-level transaction API
boundaries. Do not emit noisy implicit transaction events for every autocommit
statement by default; mark the statement with
`transactionContext: 'autocommit-implicit'` instead.

Transaction `status` describes the boundary action itself. A successful API
rollback caused by a rejected callback should be `status: 'ok'` with
`reason: 'callback-rejected'`, not `status: 'error'`.

`error`

Captures SQL diagnostics linked to a statement. Prefer stable database fields
such as SQLSTATE, severity, message, detail, hint, statement position, schema,
table, column, constraint, and data type when available. Detail, hint, and
context can leak row values and must obey the same redaction policy as params
and results.

`timeout`

Captures harness timeout, engine timeout, user cancellation, or unknown
cancellation. A timed-out statement should still have a terminal `statement` or
`batch` event with `status: 'timeout'`. Browser harness timeouts may race the
query promise without cancelling engine execution; mark
`executionMayHaveContinued` when cancellation is not guaranteed.

### Optional And Capability-Gated Events

`relation-access`

Represents best-effort relation involvement. It must include:

```ts
source: 'parser' | 'explain' | 'live-extension' | 'engine-hook' | 'manual';
confidence: 'high' | 'medium' | 'low';
```

Use one `relation-access` event rather than separate `relation-read` and
`relation-write` kinds. SQL statements are often mixed: `UPDATE` reads and
writes, `INSERT ... SELECT` reads one relation and writes another, `MERGE` can
do several operations, and triggers may touch relations that are not visible in
the original statement.

Parser-derived and EXPLAIN-derived relation access are useful, but they are not
the same as exact engine instrumentation.

`plan`

Captures a diagnostic plan. The event must distinguish user-authored `EXPLAIN`
from a harness-generated diagnostic query:

```ts
requestedBy: 'user' | 'harness';
mode: 'estimate' | 'analyze';
safeToExecute: boolean;
targetStatementExecuted?: boolean;
diagnosticStatementExecuted?: boolean;
sideEffectRisk?: 'planner-only' | 'executes-target' | 'unknown';
timing?: SqlTiming;
```

Default plan capture should use `EXPLAIN (FORMAT JSON)` without `ANALYZE` where
available. Estimate plan events are summary-only by default. Raw JSON plans and
plan hashes require separate opt-in through `planDetail` and `hashes.plans`.
`EXPLAIN ANALYZE` executes the statement and can have side effects; it must
remain opt-in and visibly marked.

`safeToExecute` is scoped to target statement execution. For estimate plans, the
harness still executes a diagnostic `EXPLAIN` statement; it does not execute the
target statement with `ANALYZE`.

`relationAccess` controls `relation-access` events. Plan summaries may still
include relation mentions when plan capture is enabled; those mentions are
derived plan-summary facts, not exact relation-access instrumentation.

`notice`

Captures database notices, warnings, and informational messages. It is not a
replacement for language-runtime `stdout`.

## Type Shape

The exported API follows this shape; see `packages/runtime-sql/src/index.ts`
for the exact source of truth.

```ts
export type SqlTraceSchemaVersion = 'sql-trace-2026-06-13';

export type SqlEngineKind = 'pglite' | 'sqlite-wasm' | 'duckdb-wasm' | 'custom';
export type SqlDialect = 'postgres' | 'sqlite' | 'duckdb' | 'unknown';
export type SqlPersistence = 'memory' | 'indexeddb' | 'opfs' | 'file' | 'unknown';

export interface SqlTrace {
  schemaVersion: SqlTraceSchemaVersion;
  runId: string;
  engine: SqlTraceEngine;
  capture: SqlTraceCapturePolicy;
  events: SqlTraceEvent[];
}

export interface SqlTraceEngine {
  kind: SqlEngineKind;
  dialect: SqlDialect;
  engineVersion?: string;
  adapterVersion?: string;
  persistence?: SqlPersistence;
  capabilities?: SqlTraceCapability[];
  extras?: Record<string, unknown>;
}

export type SqlTraceCapability =
  | 'single-statement-query'
  | 'multi-statement-exec'
  | 'parameterized-query'
  | 'transactions'
  | 'describe-query'
  | 'explain-json'
  | 'notice-response'
  | 'relation-access-parser'
  | 'relation-access-explain'
  | 'live-changes'
  | 'sqlite-trace-hook'
  | 'sqlite-update-hook';

export interface SqlTraceCapturePolicy {
  sqlText: 'none' | 'redacted' | 'full';
  params: 'none' | 'types' | 'redacted' | 'full';
  diagnostics: 'none' | 'redacted' | 'full';
  resultRows: 'none' | 'sampled';
  maxRowsPerResult: number;
  maxCellBytes: number;
  maxTraceBytes?: number;
  plans: 'none' | 'estimate' | 'analyze';
  planDetail: 'summary' | 'raw-capped' | 'raw-full';
  relationAccess: 'none' | 'parser' | 'explain' | 'best-effort';
  hashes: {
    sql: 'none' | 'normalized-redacted' | 'raw';
    params: 'none' | 'per-run' | 'stable';
    plans: 'none' | 'per-run' | 'stable';
  };
}

export interface SqlSourceSpan {
  start: { offset: number; line?: number; column?: number };
  end: { offset: number; line?: number; column?: number };
}

export interface SqlBaseEvent {
  eventId: string;
  runId: string;
  kind: SqlTraceEventKind;
  ordinal: number;
  batchId?: string;
  statementId?: string;
  transactionId?: string;
  file?: string;
  sourceSpan?: SqlSourceSpan;
  timestampMs?: number;
  extras?: Record<string, unknown>;
}

export type SqlTraceEvent =
  | SqlBatchEvent
  | SqlStatementEvent
  | SqlResultEvent
  | SqlTransactionEvent
  | SqlErrorEvent
  | SqlTimeoutEvent
  | SqlRelationAccessEvent
  | SqlPlanEvent
  | SqlNoticeEvent;

export interface SqlBatchEvent extends SqlBaseEvent {
  kind: 'batch';
  batchId: string;
  api: 'exec' | 'script' | 'migration';
  sql: SqlCapturedText;
  timing?: SqlTiming;
  status: 'ok' | 'error' | 'timeout';
  statementCountKnown?: number;
  timingSource?: 'measured' | 'batch-derived' | 'posthoc' | 'unknown';
}

export interface SqlStatementEvent extends SqlBaseEvent {
  kind: 'statement';
  statementId: string;
  batchId?: string;
  statementIndex?: number;
  statementCountKnown?: number;
  api: 'query' | 'exec' | 'sql-template' | 'transaction-api' | 'protocol' | 'script';
  sql: SqlCapturedText & {
    operation?: SqlOperation;
    operationSource?: 'parser' | 'regex' | 'engine' | 'unknown';
    operationConfidence?: 'high' | 'medium' | 'low';
  };
  params?: SqlParam[];
  timing?: SqlTiming;
  timingSource?: 'measured' | 'batch-derived' | 'posthoc' | 'unknown';
  status: 'ok' | 'error' | 'timeout';
  transactionContext?: 'autocommit-implicit' | 'explicit-sql' | 'api-wrapper' | 'unknown';
  summary?: {
    affectedRows?: number;
    returnedRowsKnown?: number;
    returnedRowsCaptured?: number;
    fieldsCount?: number;
  };
}

export interface SqlCapturedText {
  text?: string;
  redactedText?: string;
  hash?: string;
  normalizedHash?: string;
  dialect: SqlDialect;
}

export interface SqlTiming {
  startTimeMs?: number;
  endTimeMs?: number;
  durationMs?: number;
}

export type SqlOperation =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'merge'
  | 'create'
  | 'alter'
  | 'drop'
  | 'truncate'
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'savepoint'
  | 'release'
  | 'explain'
  | 'prepare'
  | 'execute'
  | 'copy'
  | 'analyze'
  | 'vacuum'
  | 'set'
  | 'show'
  | 'reset'
  | 'grant'
  | 'revoke'
  | 'listen'
  | 'notify'
  | 'unlisten'
  | 'call'
  | 'do'
  | 'declare'
  | 'fetch'
  | 'close'
  | 'other'
  | 'unknown';

export interface SqlParam {
  position?: number;
  name?: string;
  type?: { dialectTypeName?: string; pgTypeId?: number };
  redacted: boolean;
  valuePreview?: SqlScalar;
  valueHash?: string;
  byteLength?: number;
  truncated?: boolean;
}

export type SqlScalar =
  | null
  | string
  | number
  | boolean
  | { kind: 'bigint'; text: string }
  | { kind: 'bytes'; byteLength: number }
  | { kind: 'json'; preview: string; truncated: boolean };

export interface SqlResultEvent extends SqlBaseEvent {
  kind: 'result';
  statementId: string;
  batchId?: string;
  fields: Array<{
    name: string;
    ordinal: number;
    dialectTypeName?: string;
    pgTypeId?: number;
    nullable?: boolean;
  }>;
  fieldsSource: 'engine' | 'row-shape' | 'unknown';
  rows: {
    mode: 'object' | 'array';
    values: Array<Record<string, SqlCell> | SqlCell[]>;
    rowCountCaptured: number;
    rowCountKnown?: number;
    truncated: boolean;
  };
  affectedRows?: number;
}

export interface SqlCell {
  value?: SqlScalar;
  redacted?: boolean;
  truncated?: boolean;
}

export interface SqlTransactionEvent extends SqlBaseEvent {
  kind: 'transaction';
  transactionId: string;
  action: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback-to';
  source: 'sql' | 'api' | 'implicit';
  name?: string;
  status?: 'ok' | 'error';
  reason?: 'callback-rejected' | 'statement-error' | 'manual' | 'unknown';
}

export interface SqlErrorEvent extends SqlBaseEvent {
  kind: 'error';
  statementId?: string;
  severity?: string;
  sqlState?: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: number;
  schemaName?: string;
  tableName?: string;
  columnName?: string;
  constraintName?: string;
  dataTypeName?: string;
  redacted?: boolean;
}

export interface SqlTimeoutEvent extends SqlBaseEvent {
  kind: 'timeout';
  statementId?: string;
  timeoutMs: number;
  elapsedMs?: number;
  cancelled?: boolean;
  executionMayHaveContinued?: boolean;
  reason?: 'harness-timeout' | 'engine-timeout' | 'user-cancel' | 'unknown';
}

export interface SqlRelationAccessEvent extends SqlBaseEvent {
  kind: 'relation-access';
  statementId: string;
  source: 'parser' | 'explain' | 'live-extension' | 'engine-hook' | 'manual';
  confidence: 'high' | 'medium' | 'low';
  accesses: SqlRelationAccess[];
}

export interface SqlRelationAccess {
  relation: {
    schema?: string;
    name: string;
    kind: 'table' | 'view' | 'materialized-view' | 'index' | 'cte' | 'unknown';
  };
  access: 'read' | 'write' | 'insert' | 'update' | 'delete' | 'ddl' | 'index-read' | 'unknown';
  columns?: string[];
  via?: string;
}

export interface SqlPlanEvent extends SqlBaseEvent {
  kind: 'plan';
  statementId: string;
  source: 'explain-json' | 'engine' | 'other';
  requestedBy: 'user' | 'harness';
  mode: 'estimate' | 'analyze';
  safeToExecute: boolean;
  targetStatementExecuted?: boolean;
  diagnosticStatementExecuted?: boolean;
  sideEffectRisk?: 'planner-only' | 'executes-target' | 'unknown';
  timing?: SqlTiming;
  summary?: {
    rootNodeType?: string;
    estimatedRows?: number;
    estimatedTotalCost?: number;
    relations?: SqlRelationAccess[];
  };
  rawPlan?: {
    format: 'json';
    value?: unknown;
    hash?: string;
    truncated?: boolean;
  };
}

export interface SqlNoticeEvent extends SqlBaseEvent {
  kind: 'notice';
  statementId?: string;
  severity?: string;
  sqlState?: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: number;
}
```

## Capture And Privacy

The trace must include capture policy so consumers know whether data is absent
because nothing existed or because the harness intentionally suppressed it.

Defaults should be privacy-preserving:

- SQL text: redacted by default when user data may be embedded as literals
- params: redacted by default; redacted params expose position/name/type only
  and do not include serialized byte length
- SQL, parameter, and plan hashes: disabled by default unless fingerprints are
  explicitly enabled
- result rows: disabled by default; sampled rows must be explicit and capped
- error detail, hint, and context: redacted by default
- relation access and plans: disabled unless explicitly requested
- raw plan payloads: disabled unless `planDetail` is explicitly raised above
  `summary`
- full SQL, full params, full diagnostics, raw SQL hashes, plan hashes, raw
  plans, and larger result capture: explicit opt-in only

Never interpolate parameters into SQL text by default. Store SQL text and
parameters separately. SQL redaction is best-effort query-shape redaction, not a
security boundary. Stable hashes are fingerprints, not privacy boundaries.
Binary `bytes` scalars do not emit hashes in V1.

`maxTraceBytes` is a validation budget in V1. `maxRowsPerResult` and
`maxCellBytes` are capture-time caps; `maxTraceBytes` rejects oversized traces
during validation rather than dropping events during emission.

## Validation Strategy

The SQL contract should mirror V4's raw-emission discipline without reusing V4
event kinds.

Contract validation should:

- reject unknown event kinds
- require `schemaVersion`, `runId`, `engine`, `capture`, and `events`
- reject unknown top-level, engine, capture, and hash-policy fields outside
  explicit `extras`
- validate engine, dialect, API, capture mode, timing source, and operation
  enums
- require every event to have unique `eventId`, matching `runId`, `kind`, and
  monotonic `ordinal`
- require every `batch` to have a unique `batchId`
- require every `statement` to have a unique `statementId`
- require batch-linked and statement-linked events to reference existing IDs
- require statement `status: 'error'` / `status: 'timeout'` to have a linked
  error or timeout event
- require batch `status: 'error'` / `status: 'timeout'` to have a linked batch
  error or timeout event
- reject unknown event fields outside the explicit `extras` object
- reject unknown nested public fields in SQL metadata, params, timings,
  summaries, rows, fields, cells, source spans, raw plans, and relation access
  objects
- enforce result row and cell caps
- enforce capture policy for SQL text, params, hashes, result rows, diagnostics,
  plans, and relation access
- enforce `maxTraceBytes` during validation when configured
- reject visualizer or semantic payload keys outside ordinary SQL identifiers
- reject `plan.mode: 'analyze'` unless capture policy allows analyze plans
- reject raw plan values and hashes unless `planDetail` / `hashes.plans`
  explicitly allow them
- reject `relation-access` events that omit `source` or `confidence`

Golden fixtures should cover:

- `CREATE TABLE`
- parameterized `INSERT`
- deterministic `SELECT`
- `UPDATE` and `DELETE`
- explicit `BEGIN`, `COMMIT`, and `ROLLBACK`
- wrapper-level transaction success and rollback
- syntax errors
- missing table errors
- unique constraint errors
- result truncation
- large cell truncation
- quoted identifiers
- CTEs, joins, subqueries, and `INSERT ... SELECT`
- optional `EXPLAIN (FORMAT JSON)` plan capture
- refusal of default `EXPLAIN ANALYZE`

Engine parity should be capability-gated. A small core parity signature can
compare statement order, status, operation category, result fields, sampled rows
for deterministic selects, affected rows where exposed, explicit transaction
events, and coarse error category. Do not require plan parity across engines,
and do not require relation-access parity unless the same derivation mode is
used.

Browser gates should run the PGlite integration in real browsers. In-memory
mode can be the deterministic baseline; IndexedDB and OPFS should be separate
capability tests because browser storage behavior varies by platform and origin
state.

## V1 Non-Claims

V1 must not claim exact observability for:

- row-level before/after values for arbitrary statements
- table and index read sets from the Postgres executor
- trigger side effects
- cascading effects
- lock waits, deadlocks, or MVCC snapshots
- production connection-pool behavior
- production timing or planner parity
- unrestricted persistence durability in browser storage

If a future engine hook or patched engine can observe one of these facts, expose
it as a capability-labeled event rather than silently upgrading the meaning of
parser-derived or EXPLAIN-derived facts.

## References

- [PGlite: What is PGlite](https://pglite.dev/docs/about)
- [PGlite API](https://pglite.dev/docs/api)
- [PGlite Socket](https://pglite.dev/docs/pglite-socket)
- [PGlite Live Queries](https://pglite.dev/docs/live-queries)
- [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html)
- [SQLite SQL Trace Event Codes](https://sqlite.org/c3ref/c_trace.html)
