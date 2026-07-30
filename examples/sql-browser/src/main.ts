import './styles.css';

import { PGlite } from '@electric-sql/pglite';
import {
  assertValidSqlTrace,
  createSqlRuntimeTraceClient,
  runIsolatedSqlCases,
  type SqlRunResult,
  type SqlTrace,
} from '@tracecode/harness/sql';

declare global {
  interface Window {
    __tracecodeSqlSmoke?: {
      status: 'loading' | 'ready' | 'error';
      trace?: SqlTrace;
      rowCount?: number;
      rollbackCount?: number;
      isolatedRun?: {
        success: boolean;
        isolation: string;
        caseCount: number;
        destructivePassed?: boolean;
        freshReadPassed?: boolean;
        freshReadCount?: number;
        attemptTraceKinds?: string[];
        setupTraceVisible: boolean;
        assertionTraceVisible: boolean;
      };
      error?: string;
    };
  }
}

window.__tracecodeSqlSmoke = { status: 'loading' };

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app');

function renderLoading(): void {
  app.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <h1>TraceCode SQL Browser Harness</h1>
          <p>Running PGlite in Chromium and exporting a SQL trace.</p>
        </div>
        <span id="status" class="status">Loading</span>
      </header>
      <section class="layout">
        <div class="panel">
          <h2>Query</h2>
          <pre id="sql"></pre>
        </div>
        <div class="panel">
          <h2>Trace</h2>
          <pre id="trace"></pre>
        </div>
        <div class="panel">
          <h2>Isolation</h2>
          <pre id="isolation"></pre>
        </div>
      </section>
    </section>
  `;
}

function setText(selector: string, value: string): void {
  const target = document.querySelector<HTMLElement>(selector);
  if (target) target.textContent = value;
}

async function boot(): Promise<void> {
  renderLoading();

  const db = await PGlite.create('memory://tracecode-sql-browser');
  const sql = [
    'CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL UNIQUE, done BOOLEAN NOT NULL DEFAULT false);',
    "INSERT INTO todos (title, done) VALUES ('Load PGlite', true);",
    "INSERT INTO todos (title, done) VALUES ('Trace SQL statements', false);",
    "UPDATE todos SET done = true WHERE title = 'Trace SQL statements';",
    'SELECT id, title, done FROM todos ORDER BY id;',
  ].join('\n');

  const traced = createSqlRuntimeTraceClient(db, {
    runId: 'sql:browser:smoke',
    engine: {
      kind: 'pglite',
      dialect: 'postgres',
    },
    persistenceLocation: 'memory://tracecode-sql-browser',
    capture: {
      sqlText: 'redacted',
      params: 'redacted',
      resultRows: 'sampled',
      maxRowsPerResult: 10,
      maxCellBytes: 256,
      plans: 'estimate',
    },
  });

  await traced.exec(sql);
  try {
    await traced.transaction(async (tx) => {
      await tx.query('INSERT INTO todos (title, done) VALUES ($1, $2)', ['Rolled back task', true]);
      await tx.query('INSERT INTO todos (title, done) VALUES ($1, $2)', ['Load PGlite', false]);
    });
  } catch {
    // Expected unique-constraint failure; the transaction wrapper should record rollback.
  }
  const result = await traced.query('SELECT count(*)::int AS count FROM todos WHERE done = $1', [true]);
  const rollbackResult = await traced.query('SELECT count(*)::int AS count FROM todos WHERE title = $1', ['Rolled back task']);
  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'browser PGlite SQL trace');

  const rowCount = Number(result.rows?.[0]?.count ?? 0);
  const rollbackCount = Number(rollbackResult.rows?.[0]?.count ?? 0);
  const isolatedRun = await runPgliteIsolationSmoke();
  window.__tracecodeSqlSmoke = { status: 'ready', trace, rowCount, rollbackCount, isolatedRun };

  const status = document.querySelector<HTMLElement>('#status');
  if (status) {
    status.textContent = 'Ready';
    status.className = 'status ready';
  }
  setText('#sql', sql);
  setText('#trace', JSON.stringify({
    schemaVersion: trace.schemaVersion,
    engine: trace.engine,
    eventKinds: trace.events.map((event) => event.kind),
    rowCount,
    rollbackCount,
  }, null, 2));
  setText('#isolation', JSON.stringify(isolatedRun, null, 2));
}

async function runPgliteIsolationSmoke(): Promise<NonNullable<Window['__tracecodeSqlSmoke']>['isolatedRun']> {
  const run = await runIsolatedSqlCases({
    problemId: 'sql-browser-active-customers',
    runId: 'sql:browser:isolation',
    setupSql: `
      CREATE TABLE customers (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        active BOOLEAN NOT NULL
      );
    `,
    seedSql: `
      INSERT INTO customers (email, active) VALUES
        ('a@example.com', true),
        ('b@example.com', false),
        ('c@example.com', true);
    `,
    cases: [
      {
        id: 'destructive',
        input: { action: 'drop' },
        assertions: [
          {
            id: 'customers-still-exist',
            sql: 'SELECT count(*)::int AS count FROM customers',
            expectedRows: [{ count: 3 }],
          },
        ],
      },
      {
        id: 'fresh-read',
        input: { action: 'read' },
        assertions: [
          {
            id: 'baseline-count',
            sql: 'SELECT count(*)::int AS count FROM customers',
            expectedRows: [{ count: 3 }],
          },
        ],
      },
    ],
    async createDatabase(context) {
      const dataDir = `memory://tracecode-sql-browser-${context.phase}-${context.caseId ?? 'baseline'}`;
      const db = await PGlite.create({
        dataDir,
        ...(context.baselineSnapshot ? { loadDataDir: context.baselineSnapshot as Blob | File } : {}),
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
        persistenceLocation: 'memory://tracecode-sql-browser-isolated-case',
        capture: {
          sqlText: 'redacted',
          params: 'redacted',
          resultRows: 'sampled',
          maxRowsPerResult: 10,
          maxCellBytes: 256,
          ...options.capture,
        },
      });
    },
    async submission({ sql, testCase }) {
      if (testCase.input?.action === 'drop') {
        await sql.exec('DROP TABLE customers;');
      } else {
        await sql.exec(`
          CREATE VIEW answer AS
          SELECT email FROM customers WHERE active = true;
        `);
      }
    },
  });
  return summarizeIsolationRun(run);
}

function summarizeIsolationRun(run: SqlRunResult): NonNullable<Window['__tracecodeSqlSmoke']>['isolatedRun'] {
  const destructive = run.cases.find((testCase) => testCase.id === 'destructive');
  const freshRead = run.cases.find((testCase) => testCase.id === 'fresh-read');
  assertValidSqlTrace(destructive?.attemptTrace, 'browser destructive isolation attempt trace');
  assertValidSqlTrace(freshRead?.attemptTrace, 'browser fresh-read isolation attempt trace');
  const freshReadCount = Number((freshRead?.assertions[0]?.rows?.[0] as { count?: unknown } | undefined)?.count ?? 0);
  return {
    success: run.success,
    isolation: run.isolation,
    caseCount: run.cases.length,
    destructivePassed: destructive?.passed,
    freshReadPassed: freshRead?.passed,
    freshReadCount,
    attemptTraceKinds: destructive?.attemptTrace?.events.map((event) => event.kind),
    setupTraceVisible: run.setupTrace !== undefined || run.cases.some((testCase) => testCase.setupTrace !== undefined),
    assertionTraceVisible: run.cases.some((testCase) => testCase.assertionTrace !== undefined),
  };
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  window.__tracecodeSqlSmoke = { status: 'error', error: message };
  renderLoading();
  const status = document.querySelector<HTMLElement>('#status');
  if (status) {
    status.textContent = 'Error';
    status.className = 'status error';
  }
  setText('#trace', message);
  setText('#isolation', message);
});
