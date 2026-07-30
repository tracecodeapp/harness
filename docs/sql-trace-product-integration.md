# SQL Trace Product Integration

This guide shows how a browser product inside the Harness monorepo can use the
private `@tracecode/runtime-sql` workspace with PGlite while keeping the SQL
trace contract separate from product UI state. The workspace is not published
independently, and `@tracecode/harness` does not expose a `/sql` subpath.

## Basic Browser Flow

```ts
import { PGlite } from '@electric-sql/pglite';
import {
  assertValidSqlTrace,
  createSqlRuntimeTraceClient,
} from '@tracecode/runtime-sql';

const db = await PGlite.create('memory://lesson-sql');

const sql = createSqlRuntimeTraceClient(db, {
  runId: 'sql:lesson:run:1',
  engine: {
    kind: 'pglite',
    dialect: 'postgres',
  },
  persistenceLocation: 'memory://lesson-sql',
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
    hashes: { sql: 'none', params: 'none', plans: 'none' },
  },
});

await sql.exec(`
  CREATE TABLE todos (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    done BOOLEAN NOT NULL DEFAULT false
  );

  INSERT INTO todos (title, done)
  VALUES ('Load PGlite', true), ('Trace SQL', false);
`);

const result = await sql.query(
  'SELECT id, title, done FROM todos WHERE done = $1 ORDER BY id',
  [true]
);

const trace = sql.getTrace();
assertValidSqlTrace(trace);
```

A product can render `result.rows` as the current query output and render
`trace.events` as the execution timeline.

## Product State Shape

Keep product/editor state outside `SqlTrace`. The trace should stay raw and
portable.

```ts
interface SqlWorkbenchState {
  activeDatabaseId: string;
  editorText: string;
  queryResultRows: unknown[];
  selectedEventId?: string;
  tracesByDatabaseId: Record<string, SqlTrace>;
}
```

Use product state to track selected tabs, editor content, panels, lesson steps,
and UI affordances. Do not put UI roles, visualizer choices, lesson IDs, or
component IDs inside SQL trace events.

## Multiple Database Instances

Create one traced client per browser database instance.

```ts
const usersSql = createSqlRuntimeTraceClient(usersDb, {
  runId: 'sql:users:run:1',
  engine: { kind: 'pglite', dialect: 'postgres' },
  persistenceLocation: 'memory://users',
});

const analyticsSql = createSqlRuntimeTraceClient(analyticsDb, {
  runId: 'sql:analytics:run:1',
  engine: { kind: 'pglite', dialect: 'postgres' },
  persistenceLocation: 'memory://analytics',
});

await usersSql.query('SELECT id, email FROM users');
await analyticsSql.query('SELECT event_name FROM events');

const tracesByDatabaseId = {
  users: usersSql.getTrace(),
  analytics: analyticsSql.getTrace(),
};
```

Each trace has its own `runId`, event IDs, ordinals, engine metadata, and capture
policy. Do not merge event ordinals across databases. If a product needs a
combined view, sort by event timestamps or statement timing in the UI layer.

## Concurrent Queries

V1 ordinals are per trace and reflect event emission/completion order. Timing
fields show overlap.

```ts
const [openTodos, doneTodos] = await Promise.all([
  sql.query('SELECT id, title FROM todos WHERE done = $1', [false]),
  sql.query('SELECT id, title FROM todos WHERE done = $1', [true]),
]);

const trace = sql.getTrace();
const statements = trace.events.filter((event) => event.kind === 'statement');
```

For overlapping operations on the same client:

- `ordinal` tells you when the event was emitted.
- `timing.startTimeMs` and `timing.endTimeMs` tell you when the operation ran.
- V1 does not model production Postgres connection pools, MVCC, deadlocks, lock
  waits, or multi-backend scheduling.

Avoid overlapping explicit SQL transaction scripts on the same traced client.
If precise transaction attribution matters, serialize those scripts or use
separate traced clients/runs.

## Isolated Problem Runs

SQL problem runners should assume untrusted submissions. Even if the prompt asks
for a `SELECT`, the submitted SQL or host code can still mutate schema or data.
The default product contract is therefore fresh database state per test case.

```ts
import { PGlite } from '@electric-sql/pglite';
import {
  createSqlRuntimeTraceClient,
  runIsolatedSqlCases,
} from '@tracecode/runtime-sql';

const result = await runIsolatedSqlCases({
  problemId: 'active-customers',
  runId: 'sql:active-customers:attempt-1',
  setupSql: `
    CREATE TABLE customers (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      active BOOLEAN NOT NULL
    );
  `,
  seedSql: `
    INSERT INTO customers (email, active) VALUES
      ('a@example.com', true),
      ('b@example.com', false);
  `,
  cases: [
    {
      id: 'baseline',
      assertions: [{
        sql: 'SELECT email FROM answer ORDER BY email',
        expectedRows: [{ email: 'a@example.com' }],
      }],
    },
  ],
  async createDatabase(context) {
    const db = await PGlite.create({
      dataDir: `memory://${context.runId}:${context.phase}:${context.caseId ?? 'baseline'}`,
      ...(context.baselineSnapshot ? { loadDataDir: context.baselineSnapshot as Blob } : {}),
    });
    return { client: db, close: () => db.close() };
  },
  snapshotDatabase(db) {
    return db.dumpDataDir();
  },
  createTraceClient(client, options) {
    return createSqlRuntimeTraceClient(client, {
      ...options,
      engine: {
        ...options.engine,
        kind: 'pglite',
        dialect: 'postgres',
      },
    });
  },
  submission: `
    CREATE VIEW answer AS
    SELECT email FROM customers WHERE active = true;
  `,
});
```

The runner creates a hidden baseline database, runs `setupSql` and `seedSql`,
snapshots that baseline when `snapshotDatabase` is provided, and then creates a
fresh database for each case. If snapshotting is not provided, it still preserves
isolation by creating a new database per case and rerunning setup/seed.

Keep traces separate:

- setup/seed trace: hidden/internal
- attempt trace: user-visible
- assertion trace: hidden/internal

V1 intentionally does not expose a shared-readonly mode. A future product can add
that as a private optimization only for trusted, statically constrained SELECT
exercises.

## Rendering A Trace Timeline

```ts
function timelineRows(trace: SqlTrace) {
  return trace.events.map((event) => ({
    id: event.eventId,
    ordinal: event.ordinal,
    kind: event.kind,
    statementId: event.statementId,
    transactionId: event.transactionId,
    label:
      event.kind === 'statement'
        ? event.sql.operation ?? 'sql'
        : event.kind,
  }));
}
```

For a first product UI, render:

- a query editor
- a result table for the latest query
- an event timeline grouped by `statementId`
- statement detail with redacted SQL, params, timing, and summary counts
- result detail when sampled rows are enabled
- plan detail when `plans: 'estimate'` is enabled
- transaction markers for API and explicit SQL boundaries

## Import Boundary

Code inside this monorepo imports the private workspace directly:

```ts
import { createSqlRuntimeTraceClient } from '@tracecode/runtime-sql';
```

There is currently no standalone registry package and no
`@tracecode/harness/sql` compatibility subpath. Product code outside this
monorepo should wait for a deliberately versioned standalone SQL contract
rather than depending on private workspace internals.
