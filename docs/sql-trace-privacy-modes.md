# SQL Trace Privacy Modes

SQL traces can contain application data in SQL literals, parameters, result
rows, diagnostics, and plans. Treat capture policy as part of the public trace
contract, not just a runtime option.

## Safe Default

Use this for shared traces, persisted traces, demos with unknown inputs, and any
environment where query values may include user or business data.

```ts
const traced = createSqlTraceClient(client, {
  capture: {
    sqlText: 'redacted',
    params: 'redacted',
    diagnostics: 'redacted',
    resultRows: 'none',
    plans: 'none',
    planDetail: 'summary',
    relationAccess: 'none',
    hashes: {
      sql: 'none',
      params: 'none',
      plans: 'none',
    },
  },
});
```

This preserves statement shape, timing, operation category, row counts, field
metadata when the engine returns it, and redacted diagnostics. It does not store
SQL hashes, parameter hashes, plan hashes, result rows, or raw plans.
Redacted params do not include serialized byte length by default.

SQL redaction is best-effort query-shape redaction, not a security boundary.
Use `sqlText: 'none'` when redacted SQL text could still expose sensitive
identifier or query-shape information.

## Teaching Or Debugging

Use this for local teaching examples where sampled row values are useful and the
data is synthetic.

```ts
const traced = createPgliteSqlTraceClient(db, {
  capture: {
    sqlText: 'redacted',
    params: 'redacted',
    diagnostics: 'redacted',
    resultRows: 'sampled',
    maxRowsPerResult: 10,
    maxCellBytes: 256,
    plans: 'estimate',
    planDetail: 'summary',
    relationAccess: 'none',
    hashes: {
      sql: 'normalized-redacted',
      params: 'per-run',
      plans: 'none',
    },
  },
});
```

`plans: 'estimate'` may run `EXPLAIN (FORMAT JSON)` for successful Postgres
`SELECT` statements. The harness marks these plan events as
`requestedBy: 'harness'`, `mode: 'estimate'`, `targetStatementExecuted: false`,
and `sideEffectRisk: 'planner-only'`. Raw plan JSON and plan hashes are still
disabled unless separately enabled. Plan summaries may include relation mentions
when plan capture is enabled; `relationAccess` only controls separate
`relation-access` events.

## Full Local Only

Use this only for trusted local debugging with synthetic or intentionally
shareable data.

```ts
const traced = createSqlTraceClient(client, {
  capture: {
    sqlText: 'full',
    params: 'full',
    diagnostics: 'full',
    resultRows: 'sampled',
    maxRowsPerResult: 100,
    maxCellBytes: 4096,
    plans: 'estimate',
    planDetail: 'raw-capped',
    relationAccess: 'none',
    hashes: {
      sql: 'raw',
      params: 'stable',
      plans: 'stable',
    },
  },
});
```

Stable hashes are fingerprints, not a privacy boundary. They can support
cross-run correlation, but common values may be guessed by dictionary attacks.
Raw plans can contain relation names, aliases, filters, and other query details.
Do not use this mode for traces that leave a trusted local environment.
