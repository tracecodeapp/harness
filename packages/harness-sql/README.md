# `@tracecode/harness-sql`

Browser-first SQL trace contracts and client wrappers for TraceCode Harness.

Import path:

```ts
import {
  createPgliteSqlTraceClient,
  createSqlTraceClient,
  runIsolatedSqlCases,
  assertValidSqlTrace,
  type SqlTrace,
} from '@tracecode/harness-sql';
```

Public surface:

- `SqlTrace` and SQL trace event types
- SQL trace validation helpers
- capture/redaction/truncation helpers
- a dependency-free wrapper for SQL clients with `query`, optional `exec`, and
  optional `transaction`
- PGlite metadata helpers that keep PGlite as an injected browser dependency
- an isolated SQL case runner that creates fresh database state per case

The umbrella package also exposes the same public surface at
`@tracecode/harness/sql` for backwards-compatible all-in-one installs.

This package does not vendor a SQL engine. Browser apps can pass a PGlite-like
client with `query`, `exec`, and optional `transaction` methods to
`createSqlTraceClient(...)`.

For PGlite, use `createPgliteSqlTraceClient(...)` to label the trace as
browser Postgres-compatible execution while still injecting the actual PGlite
client from the application. The generic wrapper defaults to `custom` /
`unknown`; only the PGlite helper labels a trace as PGlite/Postgres.

```ts
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSqlTraceClient } from '@tracecode/harness-sql';

const db = await PGlite.create('memory://tracecode-sql');
const traced = createPgliteSqlTraceClient(db, {
  dataDir: 'memory://tracecode-sql',
});

await traced.exec('CREATE TABLE todos (id SERIAL PRIMARY KEY, title TEXT)');
await traced.query('SELECT * FROM todos WHERE id = $1', [1]);
console.log(traced.getTrace());
```

PGlite's `.sql` tagged-template API is not automatically intercepted by this
wrapper. Route those calls through `traceQuery(..., { api: 'sql-template' })` or
another app-level helper if they should appear in the trace.

For problem/test execution, use `runIsolatedSqlCases(...)` on top of an injected
database factory. V1 always uses fresh database isolation per case. Setup/seed
and hidden assertion traces stay separate from the user-visible attempt trace.

V1 hardening notes:

- `exec(...)` emits a `batch` event and marks reconstructed per-statement timing
  as `posthoc`.
- Failed `exec(...)` calls emit a batch-level error instead of inventing
  per-statement success.
- Result rows default to `none`; examples opt into sampled rows explicitly.
- Redacted params do not include serialized byte length by default.
- Binary result/parameter scalars do not emit hashes in V1.
- SQL, parameter, and plan hashes are opt-in because stable hashes are still
  fingerprints, not privacy boundaries.
- `plans: 'estimate'` captures summary-only plan events by default; raw plan
  payloads and plan hashes require separate opt-in.
- `relationAccess` controls `relation-access` events; plan summaries may still
  include relation mentions when plan capture is enabled.
- `maxTraceBytes` is a validation budget, not an emission-time event dropping
  mechanism.
- SQL text redaction is best-effort query-shape redaction, not a security
  boundary. Use `sqlText: 'none'` when redacted query shape is still sensitive.
- SQL text, params, diagnostics, result rows, plans, plan detail, hashes, and
  relation access are all governed by capture policy and validated.

See `examples/sql-browser` for a Vite + Chromium smoke that runs real PGlite in
the browser, validates the emitted SQL trace, and covers failed transaction
rollback.

See `docs/sql-trace-privacy-modes.md` for recommended capture policies for
shared traces, teaching/debugging, and full local-only diagnostics.

See `docs/sql-trace-product-integration.md` for product-facing examples covering
PGlite setup, multiple database instances, isolated problem runs, concurrent
queries, and trace timeline rendering.
