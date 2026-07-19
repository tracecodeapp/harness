#!/usr/bin/env npx tsx

import {
  SQL_TRACE_SCHEMA_VERSION,
  assertValidSqlTrace,
  createEmptySqlTrace,
  createPgliteSqlTraceClient,
  createSqlTraceClient,
  inferPgliteSqlPersistence,
  redactSqlText,
  runIsolatedSqlCases,
  splitSqlStatements,
  validateSqlTrace,
  type SqlClientResult,
  type SqlClientLike,
  type SqlTrace,
} from '../packages/harness-sql/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eventKinds(trace: SqlTrace): string[] {
  return trace.events.map((event) => event.kind);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function testEmptyTrace(): void {
  const trace = createEmptySqlTrace({ runId: 'sql:test:empty' });
  assertCondition(trace.schemaVersion === SQL_TRACE_SCHEMA_VERSION, 'empty SQL trace should use the current schema');
  assertCondition(trace.engine.kind === 'custom', 'empty generic SQL trace should default to custom engine kind');
  assertCondition(trace.engine.dialect === 'unknown', 'empty generic SQL trace should default to unknown dialect');
  assertCondition(trace.capture.resultRows === 'none', 'empty generic SQL trace should disable row capture by default');
  assertCondition(trace.capture.hashes.sql === 'none', 'empty generic SQL trace should disable SQL hashes by default');
  assertCondition(trace.capture.hashes.plans === 'none', 'empty generic SQL trace should disable plan hashes by default');
  assertValidSqlTrace(trace, 'empty sql trace');
  console.log('PASS: SQL trace factory creates a valid empty trace');
}

function testPgliteTraceDefaults(): void {
  assertCondition(inferPgliteSqlPersistence(undefined) === 'memory', 'missing PGlite dataDir should infer memory persistence');
  assertCondition(inferPgliteSqlPersistence('memory://') === 'memory', 'memory:// should infer memory persistence');
  assertCondition(inferPgliteSqlPersistence('idb://tracecode-sql') === 'indexeddb', 'idb:// should infer IndexedDB persistence');

  const traced = createPgliteSqlTraceClient(
    {
      async query() {
        return { rows: [{ ok: true }], affectedRows: 0, fields: [{ name: 'ok', dataTypeID: 16 }] };
      },
    } as unknown as SqlClientLike,
    {
      runId: 'sql:test:pglite-defaults',
      dataDir: 'idb://tracecode-sql',
    }
  );
  const trace = traced.getTrace();
  assertCondition(trace.engine.kind === 'pglite', 'PGlite helper should set engine kind');
  assertCondition(trace.engine.dialect === 'postgres', 'PGlite helper should set Postgres dialect');
  assertCondition(trace.engine.persistence === 'indexeddb', 'PGlite helper should preserve persistence metadata');
  assertCondition(trace.engine.capabilities?.includes('transactions') === true, 'PGlite helper should label transaction capability');
  assertCondition(trace.engine.capabilities?.includes('explain-json') !== true, 'PGlite helper should not claim uncaptured plan capability by default');
  assertValidSqlTrace(trace, 'pglite defaults trace');
  console.log('PASS: PGlite trace helper labels browser Postgres capabilities');
}

function testSqlScriptSplitting(): void {
  const statements = splitSqlStatements([
    "SELECT ';' AS semi;",
    "-- comment ; should not split",
    "INSERT INTO users(email) VALUES ('a;b@example.com');",
    "SELECT $$dollar;quoted$$ AS body;",
    'SELECT "semi;identifier" FROM users;',
  ].join('\n'));

  assertCondition(statements.length === 4, `expected 4 split statements, received ${statements.length}`);
  assertCondition(statements[0]?.text === "SELECT ';' AS semi", 'single-quoted semicolon should stay in statement');
  assertCondition(
    statements[1]?.text.includes("VALUES ('a;b@example.com')"),
    'line comments and single-quoted semicolons should not split incorrectly'
  );
  assertCondition(
    statements[2]?.text === 'SELECT $$dollar;quoted$$ AS body',
    'dollar-quoted semicolon should stay in statement'
  );
  assertCondition(
    statements[3]?.text === 'SELECT "semi;identifier" FROM users',
    'double-quoted identifier semicolon should stay in statement'
  );
  console.log('PASS: SQL script splitter respects quotes, comments, and dollar quotes');
}

function testSqlRedactionCoversPostgresLiteralForms(): void {
  const redacted = redactSqlText("SELECT $$dollar_secret$$, $tag$tagged_secret$tag$, E'escaped\\'secret', 42, 'plain_secret'");
  assertCondition(!redacted.includes('dollar_secret'), `dollar-quoted literal should be redacted: ${redacted}`);
  assertCondition(!redacted.includes('tagged_secret'), `tagged dollar-quoted literal should be redacted: ${redacted}`);
  assertCondition(!redacted.includes('escaped') && !redacted.includes('secret'), `escape-string literal should be redacted: ${redacted}`);
  assertCondition(!redacted.includes('42') && redacted.includes('<number>'), `numeric literal should be redacted: ${redacted}`);
  console.log('PASS: SQL redaction covers PostgreSQL dollar and escape literal forms');
}

async function testTracedQueryCapture(): Promise<void> {
  const mockClient = {
    async query() {
      return {
        rows: [
          { id: 1, email: 'a@example.com', payload: 'abcdefghijklmnopqrstuvwxyz' },
          { id: 2, email: 'b@example.com', payload: 'ignored by row cap' },
        ],
        affectedRows: 0,
        fields: [
          { name: 'id', dataTypeID: 23 },
          { name: 'email', dataTypeID: 25 },
          { name: 'payload', dataTypeID: 25 },
        ],
      };
    },
  };

  const traced = createSqlTraceClient(mockClient as unknown as SqlClientLike, {
    runId: 'sql:test:query',
    capture: {
      sqlText: 'redacted',
      params: 'redacted',
      resultRows: 'sampled',
      maxRowsPerResult: 1,
      maxCellBytes: 8,
      hashes: { params: 'stable' },
    },
    now: (() => {
      let value = 100;
      return () => {
        value += 5;
        return value;
      };
    })(),
  });

  await traced.query('SELECT id, email FROM users WHERE email = $1', ['secret@example.com']);
  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'traced query');
  assertCondition(eventKinds(trace).join(',') === 'statement,result', 'query should emit statement and result events');

  const statement = trace.events.find((event) => event.kind === 'statement');
  assertCondition(statement?.kind === 'statement', 'statement event should be present');
  assertCondition(statement.sql.text === undefined, 'redacted SQL capture should omit full SQL text');
  assertCondition(statement.sql.redactedText?.includes('SELECT'), 'redacted SQL text should be present');
  assertCondition(statement.params?.[0]?.valuePreview === undefined, 'redacted params should omit valuePreview');
  assertCondition(statement.params?.[0]?.byteLength === undefined, 'redacted params should omit byteLength by default');
  assertCondition(statement.params?.[0]?.valueHash !== undefined, 'redacted params should include a stable hash');
  assertCondition(statement.summary?.returnedRowsKnown === 2, 'statement summary should include known returned rows');
  assertCondition(statement.summary?.returnedRowsCaptured === 1, 'statement summary should include captured row count');

  const result = trace.events.find((event) => event.kind === 'result');
  assertCondition(result?.kind === 'result', 'result event should be present');
  assertCondition(result.fieldsSource === 'engine', 'result field provenance should come from engine metadata');
  assertCondition(result.rows.values.length === 1, 'result capture should obey maxRowsPerResult');
  assertCondition(result.rows.truncated === true, 'result should mark row truncation');
  const payloadCell = result.rows.values[0];
  assertCondition(!Array.isArray(payloadCell), 'object row capture should preserve object mode');
  assertCondition(payloadCell.payload?.truncated === true, 'long result cells should be marked truncated');
  console.log('PASS: traced SQL query captures redacted statement, params, and capped results');
}

async function testBinaryScalarAndClonePrivacy(): Promise<void> {
  const mockClient = {
    async query() {
      return {
        rows: [{ blob: new Uint8Array([1, 2, 3, 4]) }],
        affectedRows: 0,
        fields: [{ name: 'blob', dataTypeID: 17 }],
      };
    },
  };

  const traced = createSqlTraceClient(mockClient as unknown as SqlClientLike, {
    runId: 'sql:test:binary-privacy',
    capture: { resultRows: 'sampled', hashes: { sql: 'none', params: 'none', plans: 'none' } },
  });
  await traced.query('SELECT blob FROM files WHERE id = $1', [1]);
  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'binary privacy trace');
  const result = trace.events.find((event) => event.kind === 'result');
  assertCondition(result?.kind === 'result', 'binary privacy result should be present');
  const row = result.rows.values[0];
  assertCondition(!Array.isArray(row), 'binary privacy result should use object row mode');
  const blob = row.blob?.value;
  assertCondition(typeof blob === 'object' && blob !== null && 'kind' in blob && blob.kind === 'bytes', 'binary value should capture byte metadata');
  assertCondition(!('hash' in blob), 'binary value should not emit an ungated stable hash');

  const mutableTrace = traced.getTrace();
  mutableTrace.capture.hashes.sql = 'raw';
  assertCondition(traced.getTrace().capture.hashes.sql === 'none', 'getTrace should deep-clone capture.hashes');
  console.log('PASS: SQL binary scalars avoid ungated hashes and getTrace clones hash policy');
}

async function testExplainEstimatePlanCapture(): Promise<void> {
  const mockClient = {
    async query(sql: string) {
      if (sql.startsWith('EXPLAIN')) {
        return {
          rows: [
            {
              'QUERY PLAN': [
                {
                  Plan: {
                    'Node Type': 'Seq Scan',
                    'Relation Name': 'users',
                    'Plan Rows': 12,
                    'Total Cost': 4.25,
                  },
                },
              ],
            },
          ],
          affectedRows: 0,
          fields: [{ name: 'QUERY PLAN', dataTypeID: 114 }],
        };
      }
      return {
        rows: [{ id: 1 }],
        affectedRows: 0,
        fields: [{ name: 'id', dataTypeID: 23 }],
      };
    },
  };

  const traced = createSqlTraceClient(mockClient as unknown as SqlClientLike, {
    runId: 'sql:test:plan',
    engine: { dialect: 'postgres' },
    capture: { plans: 'estimate' },
  });
  await traced.query('SELECT id FROM users WHERE id = $1', [1]);
  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'explain estimate trace');
  assertCondition(eventKinds(trace).join(',') === 'statement,result,plan', 'estimate plan capture should emit statement, result, and plan events');
  const plan = trace.events.find((event) => event.kind === 'plan');
  assertCondition(plan?.kind === 'plan', 'plan event should be present');
  assertCondition(plan.requestedBy === 'harness' && plan.mode === 'estimate' && plan.safeToExecute, 'plan should be a safe harness estimate');
  assertCondition(plan.targetStatementExecuted === false, 'estimate plan should not execute the target statement');
  assertCondition(plan.diagnosticStatementExecuted === true, 'estimate plan should record diagnostic EXPLAIN execution');
  assertCondition(plan.sideEffectRisk === 'planner-only', 'estimate plan should mark planner-only side-effect risk');
  assertCondition(plan.timing?.durationMs !== undefined, 'plan event should include EXPLAIN timing');
  assertCondition(plan.summary?.rootNodeType === 'Seq Scan', 'plan summary should include root node type');
  assertCondition(plan.summary?.relations?.[0]?.relation.name === 'users', 'plan summary should include relation names from JSON plan');
  assertCondition(plan.rawPlan === undefined, 'estimate plan capture should be summary-only by default');
  console.log('PASS: traced SQL query can capture harness EXPLAIN JSON estimate plans');
}

async function testMultipleInstancesAndConcurrentQueries(): Promise<void> {
  const usersClient = {
    async query() {
      return { rows: [{ id: 1 }], affectedRows: 0, fields: [{ name: 'id', dataTypeID: 23 }] };
    },
  };
  const analyticsClient = {
    async query() {
      return { rows: [{ event: 'opened' }], affectedRows: 0, fields: [{ name: 'event', dataTypeID: 25 }] };
    },
  };

  const usersDb = createSqlTraceClient(usersClient as unknown as SqlClientLike, { runId: 'sql:test:users-db' });
  const analyticsDb = createSqlTraceClient(analyticsClient as unknown as SqlClientLike, { runId: 'sql:test:analytics-db' });
  await usersDb.query('SELECT id FROM users');
  await analyticsDb.query('SELECT event FROM events');
  const usersTrace = usersDb.getTrace();
  const analyticsTrace = analyticsDb.getTrace();
  assertValidSqlTrace(usersTrace, 'users db trace');
  assertValidSqlTrace(analyticsTrace, 'analytics db trace');
  assertCondition(usersTrace.runId !== analyticsTrace.runId, 'multiple DB instances should use independent run IDs');
  assertCondition(usersTrace.events.every((event) => event.runId === usersTrace.runId), 'users DB events should stay scoped to users trace');
  assertCondition(analyticsTrace.events.every((event) => event.runId === analyticsTrace.runId), 'analytics DB events should stay scoped to analytics trace');

  const slow = deferred<SqlClientResult>();
  const fast = deferred<SqlClientResult>();
  const concurrentClient = {
    async query(sql: string) {
      return sql.includes('slow') ? slow.promise : fast.promise;
    },
  };
  const concurrent = createSqlTraceClient(concurrentClient as unknown as SqlClientLike, {
    runId: 'sql:test:concurrent',
    now: (() => {
      let value = 0;
      return () => {
        value += 10;
        return value;
      };
    })(),
  });
  const slowQuery = concurrent.query('SELECT slow FROM jobs');
  const fastQuery = concurrent.query('SELECT fast FROM jobs');
  fast.resolve({ rows: [{ fast: true }], affectedRows: 0, fields: [{ name: 'fast', dataTypeID: 16 }] });
  await fastQuery;
  slow.resolve({ rows: [{ slow: true }], affectedRows: 0, fields: [{ name: 'slow', dataTypeID: 16 }] });
  await slowQuery;

  const trace = concurrent.getTrace();
  assertValidSqlTrace(trace, 'concurrent trace');
  const statements = trace.events.filter((event) => event.kind === 'statement');
  const fastStatement = statements.find((event) => event.sql.redactedText?.includes('fast'));
  const slowStatement = statements.find((event) => event.sql.redactedText?.includes('slow'));
  assertCondition(fastStatement?.kind === 'statement' && slowStatement?.kind === 'statement', 'concurrent trace should include fast and slow statements');
  assertCondition(fastStatement.ordinal < slowStatement.ordinal, 'concurrent event ordinals should follow completion/emission order');
  assertCondition((slowStatement.timing?.startTimeMs ?? 0) < (fastStatement.timing?.startTimeMs ?? 0), 'statement timings should preserve call-start overlap');
  console.log('PASS: SQL traces scope multiple DB instances and record concurrent completion order');
}

type MockSqlSnapshot = {
  tables: Record<string, Array<Record<string, unknown>>>;
};

class IsolatedMockSqlClient {
  closed = false;
  private tables: Record<string, Array<Record<string, unknown>>>;

  constructor(snapshot?: MockSqlSnapshot) {
    this.tables = snapshot ? cloneMockSqlTables(snapshot.tables) : {};
  }

  dumpSnapshot(): MockSqlSnapshot {
    return { tables: cloneMockSqlTables(this.tables) };
  }

  close(): void {
    this.closed = true;
  }

  async query(sql: string): Promise<SqlClientResult> {
    const normalized = sql.trim().toLowerCase();
    if (normalized === 'select count(*) as count from users') {
      this.assertTable('users');
      return {
        rows: [{ count: this.tables.users?.length ?? 0 }],
        affectedRows: 0,
        fields: [{ name: 'count', dataTypeID: 23 }],
      };
    }
    if (normalized === 'select email from users order by email') {
      this.assertTable('users');
      return {
        rows: [...(this.tables.users ?? [])].sort((left, right) => String(left.email).localeCompare(String(right.email))),
        affectedRows: 0,
        fields: [{ name: 'email', dataTypeID: 25 }],
      };
    }
    throw new Error(`unsupported mock query: ${sql}`);
  }

  async exec(sql: string): Promise<SqlClientResult[]> {
    return splitSqlStatements(sql).map((statement) => this.execStatement(statement.text));
  }

  private execStatement(sql: string): SqlClientResult {
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith('create table users')) {
      this.tables.users = this.tables.users ?? [];
      return { rows: [], affectedRows: 0, fields: [] };
    }
    if (normalized.startsWith('insert into users')) {
      this.assertTable('users');
      const emails = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter((value): value is string => typeof value === 'string');
      this.tables.users?.push(...emails.map((email) => ({ email })));
      return { rows: [], affectedRows: emails.length, fields: [] };
    }
    if (normalized === 'drop table users') {
      this.assertTable('users');
      delete this.tables.users;
      return { rows: [], affectedRows: 0, fields: [] };
    }
    throw new Error(`unsupported mock statement: ${sql}`);
  }

  private assertTable(name: string): void {
    if (!this.tables[name]) throw new Error(`relation "${name}" does not exist`);
  }
}

function cloneMockSqlTables(
  tables: Record<string, Array<Record<string, unknown>>>
): Record<string, Array<Record<string, unknown>>> {
  return JSON.parse(JSON.stringify(tables)) as Record<string, Array<Record<string, unknown>>>;
}

async function testIsolatedSqlCasesUseFreshDatabaseState(): Promise<void> {
  const factoryCalls: string[] = [];
  const closedClients: IsolatedMockSqlClient[] = [];
  const result = await runIsolatedSqlCases({
    problemId: 'problem:isolated-users',
    runId: 'sql:test:isolated-cases',
    setupSql: 'CREATE TABLE users (email text);',
    seedSql: "INSERT INTO users (email) VALUES ('a@example.com'), ('b@example.com');",
    cases: [
      {
        id: 'destructive',
        input: { action: 'drop' },
        assertions: [
          {
            id: 'users-still-exist',
            sql: 'SELECT count(*) AS count FROM users',
            expectedRows: [{ count: 2 }],
          },
        ],
      },
      {
        id: 'fresh-read',
        input: { action: 'read' },
        assertions: [
          {
            id: 'baseline-count',
            sql: 'SELECT count(*) AS count FROM users',
            expectedRows: [{ count: 2 }],
          },
        ],
      },
    ],
    createDatabase(context) {
      factoryCalls.push(`${context.phase}:${context.caseId ?? 'baseline'}`);
      const client = new IsolatedMockSqlClient(context.baselineSnapshot as MockSqlSnapshot | undefined);
      closedClients.push(client);
      return { client: client as unknown as SqlClientLike, close: () => client.close() };
    },
    snapshotDatabase(client) {
      return (client as unknown as IsolatedMockSqlClient).dumpSnapshot();
    },
    async submission({ sql, testCase }) {
      if (testCase.input?.action === 'drop') {
        await sql.exec('DROP TABLE users;');
      }
    },
  });

  assertCondition(result.isolation === 'fresh-database', 'SQL run should report fresh-database isolation');
  assertCondition(factoryCalls.join(',') === 'baseline:baseline,case:destructive,case:fresh-read', `SQL runner should create a baseline and one DB per case: ${factoryCalls.join(',')}`);
  assertCondition(closedClients.every((client) => client.closed), 'SQL runner should close every created database');
  assertCondition(result.success === false, 'destructive case should make the overall run fail');
  assertCondition(result.setupTrace === undefined, 'setup trace should be hidden by default');
  const destructive = result.cases.find((testCase) => testCase.id === 'destructive');
  const freshRead = result.cases.find((testCase) => testCase.id === 'fresh-read');
  assertCondition(destructive?.passed === false, 'destructive case should fail its hidden assertion');
  assertCondition(freshRead?.passed === true, 'later case should see the untouched seeded baseline');
  assertCondition(freshRead.assertionTrace === undefined, 'assertion trace should be hidden by default');
  assertCondition(freshRead.assertions[0]?.rows?.[0] && (freshRead.assertions[0].rows[0] as { count?: number }).count === 2, 'fresh case assertion should observe seeded rows');
  assertValidSqlTrace(destructive?.attemptTrace, 'destructive attempt trace');
  assertCondition(
    destructive?.attemptTrace?.events.some((event) => event.kind === 'statement' && event.sql.operation === 'drop') === true,
    'attempt trace should show the user destructive statement without leaking setup/assertions'
  );
  console.log('PASS: isolated SQL runner restores fresh database state for every case');
}

async function testExecAndTransactionCapture(): Promise<void> {
  const mockClient = {
    async query() {
      return { rows: [{ ok: true }], affectedRows: 0, fields: [{ name: 'ok', dataTypeID: 16 }] };
    },
    async exec() {
      return [
        { rows: [], affectedRows: 0, fields: [] },
        { rows: [], affectedRows: 1, fields: [] },
      ];
    },
    async transaction(callback: (tx: SqlClientLike) => Promise<unknown>) {
      return callback({
        async query() {
          return { rows: [{ id: 1 }], affectedRows: 0, fields: [{ name: 'id', dataTypeID: 23 }] };
        },
      } as unknown as SqlClientLike);
    },
  };

  const traced = createSqlTraceClient(mockClient as unknown as SqlClientLike, {
    runId: 'sql:test:exec-tx',
    capture: { sqlText: 'full', params: 'full' },
  });
  await traced.exec('CREATE TABLE users(id int); INSERT INTO users(id) VALUES (1);');
  await traced.transaction(async (tx) => {
    await tx.query('SELECT id FROM users WHERE id = $1', [1]);
  });

  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'exec and transaction trace');
  assertCondition(
    eventKinds(trace).filter((kind) => kind === 'statement').length === 3,
    'exec plus transaction query should emit three statement events'
  );
  assertCondition(
    eventKinds(trace).filter((kind) => kind === 'batch').length === 1,
    'exec should emit one batch event'
  );
  assertCondition(
    eventKinds(trace).filter((kind) => kind === 'transaction').length === 2,
    'transaction wrapper should emit begin and commit events'
  );
  const batch = trace.events.find((event) => event.kind === 'batch');
  assertCondition(batch?.kind === 'batch' && batch.statementCountKnown === 2, 'exec batch should know split statement count');
  const execStatements = trace.events.filter((event) => event.kind === 'statement' && event.api === 'exec');
  assertCondition(
    execStatements.every((event, index) => event.batchId === batch?.batchId && (event as { statementIndex?: number }).statementIndex === index && (event as { timingSource?: string }).timingSource === 'posthoc'),
    'exec statements should link to the batch and mark posthoc timing'
  );
  const operations = trace.events
    .filter((event) => event.kind === 'statement')
    .map((event) => event.sql.operation);
  assertCondition(operations.includes('create') && operations.includes('insert') && operations.includes('select'), 'statements should classify operations');
  const apiStatement = trace.events.find((event) => event.kind === 'statement' && event.api === 'query');
  assertCondition(apiStatement?.kind === 'statement' && apiStatement.transactionContext === 'api-wrapper', 'API transaction statements should mark api-wrapper transaction context');
  console.log('PASS: traced SQL exec and transaction capture statement and transaction events');
}

async function testApiRollbackReasonCapture(): Promise<void> {
  const mockClient = {
    async query() {
      return { rows: [], affectedRows: 0, fields: [] };
    },
    async transaction(callback: (tx: SqlClientLike) => Promise<unknown>) {
      return callback({
        async query() {
          return { rows: [], affectedRows: 0, fields: [] };
        },
      } as unknown as SqlClientLike);
    },
  };

  const traced = createSqlTraceClient(mockClient as unknown as SqlClientLike, { runId: 'sql:test:api-rollback-reason' });
  try {
    await traced.transaction(async () => {
      throw new Error('callback broke after app logic');
    });
  } catch {
    // Expected.
  }

  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'API rollback reason trace');
  assertCondition(eventKinds(trace).join(',') === 'transaction,transaction', 'callback failure should emit API begin and rollback only');
  const rollback = trace.events.find((event) => event.kind === 'transaction' && event.action === 'rollback');
  assertCondition(rollback?.kind === 'transaction', 'rollback transaction event should be present');
  assertCondition(rollback.status === 'ok', 'rollback status should describe the rollback action success');
  assertCondition(rollback.reason === 'callback-rejected', 'rollback should record why it happened separately from status');
  console.log('PASS: API transaction rollback records successful rollback with callback rejection reason');
}

async function testExecFailureCapturesBatchOnly(): Promise<void> {
  const mockClient = {
    async query() {
      return { rows: [], affectedRows: 0, fields: [] };
    },
    async exec() {
      throw Object.assign(new Error("syntax error at or near 'BROKEN'"), { code: '42601' });
    },
  };

  const traced = createSqlTraceClient(mockClient as unknown as SqlClientLike, {
    runId: 'sql:test:exec-failure',
    capture: { diagnostics: 'redacted' },
  });

  try {
    await traced.exec('CREATE TABLE t(id int); BROKEN SQL; INSERT INTO t VALUES (1);');
  } catch {
    // Expected.
  }

  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'exec failure trace');
  assertCondition(eventKinds(trace).join(',') === 'batch,error', 'failed exec should emit batch and error without fake statement success');
  const batch = trace.events.find((event) => event.kind === 'batch');
  assertCondition(batch?.kind === 'batch' && batch.status === 'error', 'failed exec batch should be marked error');
  assertCondition(batch.statementCountKnown === 3, 'failed exec batch should still report split statement count');
  const error = trace.events.find((event) => event.kind === 'error');
  assertCondition(error?.kind === 'error' && error.batchId === batch.batchId, 'failed exec error should link to the batch');
  console.log('PASS: failed SQL exec captures batch-level error without false per-statement facts');
}

async function testExplicitSqlTransactionCapture(): Promise<void> {
  const mockClient = {
    async query() {
      return { rows: [], affectedRows: 0, fields: [] };
    },
    async exec() {
      return [
        { rows: [], affectedRows: 0, fields: [] },
        { rows: [], affectedRows: 0, fields: [] },
        { rows: [], affectedRows: 0, fields: [] },
        { rows: [], affectedRows: 0, fields: [] },
        { rows: [], affectedRows: 0, fields: [] },
      ];
    },
  };

  const traced = createSqlTraceClient(mockClient as unknown as SqlClientLike, { runId: 'sql:test:explicit-tx' });
  await traced.exec('BEGIN; SAVEPOINT s1; ROLLBACK TO s1; RELEASE s1; COMMIT;');
  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'explicit SQL transaction trace');
  const actions = trace.events
    .filter((event) => event.kind === 'transaction' && event.source === 'sql')
    .map((event) => (event as { action?: string }).action);
  const names = trace.events
    .filter((event) => event.kind === 'transaction' && event.source === 'sql')
    .map((event) => (event as { name?: string }).name ?? '');
  assertCondition(
    actions.join(',') === 'begin,savepoint,rollback-to,release,commit',
    `explicit SQL transaction events should preserve boundary actions: ${actions.join(',')}`
  );
  assertCondition(names.join(',') === ',s1,s1,s1,', `explicit SQL transaction events should preserve savepoint names: ${names.join(',')}`);
  const beginStatement = trace.events.find((event) => event.kind === 'statement' && event.sql.operation === 'begin');
  assertCondition(beginStatement?.kind === 'statement' && beginStatement.transactionId !== undefined, 'BEGIN statement should carry the explicit SQL transaction id');
  assertCondition(beginStatement.transactionContext === 'explicit-sql', 'BEGIN statement should mark explicit SQL transaction context');
  const commitStatement = trace.events.find((event) => event.kind === 'statement' && event.sql.operation === 'commit');
  assertCondition(commitStatement?.kind === 'statement' && commitStatement.transactionContext === 'explicit-sql', 'COMMIT statement should mark explicit SQL transaction context');
  console.log('PASS: explicit SQL transaction boundary statements emit transaction events');
}

async function testErrorCapture(): Promise<void> {
  const mockClient = {
    async query() {
      throw Object.assign(new Error('duplicate key value "tenant_secret" violates unique constraint (email)=(\'secret@example.com\')'), {
        code: '23505',
        detail: "Key (email)=('secret@example.com') already exists.",
        constraint: 'users_email_key',
      });
    },
  };
  const traced = createSqlTraceClient(mockClient as unknown as SqlClientLike, {
    runId: 'sql:test:error',
    capture: { params: 'redacted' },
  });

  try {
    await traced.query('INSERT INTO users(email) VALUES ($1)', ['secret@example.com']);
  } catch {
    // Expected.
  }

  const trace = traced.getTrace();
  assertValidSqlTrace(trace, 'error trace');
  assertCondition(eventKinds(trace).join(',') === 'statement,error', 'failing query should emit statement and error events');
  const error = trace.events.find((event) => event.kind === 'error');
  assertCondition(error?.kind === 'error', 'error event should be present');
  assertCondition(error.sqlState === '23505', 'error should preserve SQLSTATE/code');
  assertCondition(error.constraintName === 'users_email_key', 'error should preserve constraint name');
  assertCondition(error.detail === undefined, 'redacted error capture should omit detail');
  assertCondition(error.message.includes('<redacted>'), 'redacted error message should hide quoted values');
  assertCondition(!error.message.includes('tenant_secret') && !error.message.includes('secret@example.com'), `redacted error message should not leak diagnostic values: ${error.message}`);
  console.log('PASS: traced SQL errors preserve diagnostics while redacting sensitive details');
}

function testValidationFailures(): void {
  const invalidKind = validateSqlTrace({
    schemaVersion: SQL_TRACE_SCHEMA_VERSION,
    runId: 'sql:test:invalid',
    engine: { kind: 'pglite', dialect: 'postgres' },
    capture: {
      sqlText: 'redacted',
      params: 'redacted',
      diagnostics: 'redacted',
      resultRows: 'sampled',
      maxRowsPerResult: 10,
      maxCellBytes: 100,
      plans: 'none',
      planDetail: 'summary',
      relationAccess: 'none',
      hashes: { sql: 'none', params: 'none', plans: 'none' },
    },
    events: [{ kind: 'line', eventId: 'e1', runId: 'sql:test:invalid', ordinal: 0, line: 1 }],
  });
  assertCondition(!invalidKind.valid && invalidKind.errors.some((error) => error.message.includes('unsupported SQL trace event kind')), 'validator should reject V4 line events');

  const badPlan = createEmptySqlTrace({ runId: 'sql:test:bad-plan' });
  badPlan.events.push(
    {
      kind: 'statement',
      eventId: 'e1',
      runId: badPlan.runId,
      ordinal: 0,
      statementId: 's1',
      api: 'query',
      sql: { redactedText: 'SELECT 1', dialect: 'postgres', operation: 'select', operationSource: 'regex' },
      status: 'ok',
    },
    {
      kind: 'plan',
      eventId: 'e2',
      runId: badPlan.runId,
      ordinal: 1,
      statementId: 's1',
      source: 'explain-json',
      requestedBy: 'harness',
      mode: 'analyze',
      safeToExecute: false,
    }
  );
  const badPlanValidation = validateSqlTrace(badPlan);
  assertCondition(!badPlanValidation.valid && badPlanValidation.errors.some((error) => error.path.endsWith('.mode')), 'validator should reject default EXPLAIN ANALYZE capture');

  const badRelation = createEmptySqlTrace({ runId: 'sql:test:bad-relation' });
  badRelation.events.push(
    {
      kind: 'statement',
      eventId: 'e1',
      runId: badRelation.runId,
      ordinal: 0,
      statementId: 's1',
      api: 'query',
      sql: { redactedText: 'SELECT 1', dialect: 'postgres', operation: 'select', operationSource: 'regex' },
      status: 'ok',
    },
    {
      kind: 'relation-access',
      eventId: 'e2',
      runId: badRelation.runId,
      ordinal: 1,
      statementId: 's1',
      source: 'manual',
      confidence: undefined as never,
      accesses: [],
    }
  );
  const badRelationValidation = validateSqlTrace(badRelation);
  assertCondition(!badRelationValidation.valid && badRelationValidation.errors.some((error) => error.path.endsWith('.confidence')), 'validator should reject relation access without confidence');

  const rawHashDisabled = createEmptySqlTrace({
    runId: 'sql:test:raw-hash-disabled',
    capture: { hashes: { sql: 'none', params: 'none', plans: 'none' } },
  });
  rawHashDisabled.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: rawHashDisabled.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT 1', hash: 'h', normalizedHash: 'nh', dialect: 'postgres', operation: 'select', operationSource: 'regex' },
    status: 'ok',
  });
  const rawHashDisabledValidation = validateSqlTrace(rawHashDisabled);
  assertCondition(!rawHashDisabledValidation.valid && rawHashDisabledValidation.errors.some((error) => error.message.includes('SQL hash is present')), 'validator should reject SQL hashes when disabled');

  const duplicateEvent = createEmptySqlTrace({ runId: 'sql:test:duplicate-event' });
  duplicateEvent.events.push(
    {
      kind: 'statement',
      eventId: 'dup',
      runId: duplicateEvent.runId,
      ordinal: 0,
      statementId: 's1',
      api: 'query',
      sql: { redactedText: 'SELECT 1', dialect: 'postgres', operation: 'select', operationSource: 'regex' },
      status: 'ok',
    },
    {
      kind: 'statement',
      eventId: 'dup',
      runId: duplicateEvent.runId,
      ordinal: 1,
      statementId: 's2',
      api: 'query',
      sql: { redactedText: 'SELECT 2', dialect: 'postgres', operation: 'select', operationSource: 'regex' },
      status: 'ok',
    }
  );
  const duplicateEventValidation = validateSqlTrace(duplicateEvent);
  assertCondition(!duplicateEventValidation.valid && duplicateEventValidation.errors.some((error) => error.message.includes('duplicate eventId')), 'validator should reject duplicate event IDs');

  const unknownField = createEmptySqlTrace({ runId: 'sql:test:unknown-field' });
  unknownField.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: unknownField.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT 1', dialect: 'postgres', operation: 'select', operationSource: 'regex' },
    status: 'ok',
    visualization: 'bar-chart',
  } as never);
  const unknownFieldValidation = validateSqlTrace(unknownField);
  assertCondition(!unknownFieldValidation.valid && unknownFieldValidation.errors.some((error) => error.message.includes('unknown SQL trace event field')), 'validator should reject unknown event fields');

  const wrongRelationSource = createEmptySqlTrace({
    runId: 'sql:test:wrong-relation-source',
    capture: { relationAccess: 'parser' },
  });
  wrongRelationSource.events.push(
    {
      kind: 'statement',
      eventId: 'e1',
      runId: wrongRelationSource.runId,
      ordinal: 0,
      statementId: 's1',
      api: 'query',
      sql: { redactedText: 'SELECT * FROM users', dialect: 'postgres', operation: 'select', operationSource: 'regex' },
      status: 'ok',
    },
    {
      kind: 'relation-access',
      eventId: 'e2',
      runId: wrongRelationSource.runId,
      ordinal: 1,
      statementId: 's1',
      source: 'explain',
      confidence: 'medium',
      accesses: [{ relation: { name: 'users', kind: 'table' }, access: 'read' }],
    }
  );
  const wrongRelationSourceValidation = validateSqlTrace(wrongRelationSource);
  assertCondition(!wrongRelationSourceValidation.valid && wrongRelationSourceValidation.errors.some((error) => error.message.includes('source must be parser')), 'validator should reject relation access source outside capture mode');

  const unknownTopLevelValidation = validateSqlTrace({
    ...createEmptySqlTrace({ runId: 'sql:test:unknown-top-level' }),
    displayHint: 'table',
  });
  assertCondition(!unknownTopLevelValidation.valid && unknownTopLevelValidation.errors.some((error) => error.message.includes('unknown SqlTrace field')), 'validator should reject unknown top-level fields');

  const unknownEngineValidation = validateSqlTrace({
    ...createEmptySqlTrace({ runId: 'sql:test:unknown-engine' }),
    engine: { kind: 'custom', dialect: 'unknown', poolSize: 5 },
  });
  assertCondition(!unknownEngineValidation.valid && unknownEngineValidation.errors.some((error) => error.message.includes('unknown SQL engine field')), 'validator should reject unknown engine fields');

  const unknownCaptureValidation = validateSqlTrace({
    ...createEmptySqlTrace({ runId: 'sql:test:unknown-capture' }),
    capture: { ...createEmptySqlTrace().capture, sampleSql: true },
  });
  assertCondition(!unknownCaptureValidation.valid && unknownCaptureValidation.errors.some((error) => error.message.includes('unknown SQL capture policy field')), 'validator should reject unknown capture fields');

  const badCapabilityValidation = validateSqlTrace({
    ...createEmptySqlTrace({ runId: 'sql:test:bad-capability' }),
    engine: { kind: 'custom', dialect: 'unknown', capabilities: ['magical-plan-hook'] },
  });
  assertCondition(!badCapabilityValidation.valid && badCapabilityValidation.errors.some((error) => error.message.includes('engine capability is unsupported')), 'validator should reject unsupported capabilities');

  const diagnosticNoneLeak = createEmptySqlTrace({
    runId: 'sql:test:diagnostic-none-leak',
    capture: { diagnostics: 'none' },
  });
  diagnosticNoneLeak.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: diagnosticNoneLeak.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT 1', dialect: 'unknown', operation: 'select', operationSource: 'regex' },
    status: 'error',
  }, {
    kind: 'error',
    eventId: 'e2',
    runId: diagnosticNoneLeak.runId,
    ordinal: 1,
    statementId: 's1',
    message: '<redacted>',
    tableName: 'users',
    redacted: true,
  });
  const diagnosticNoneLeakValidation = validateSqlTrace(diagnosticNoneLeak);
  assertCondition(!diagnosticNoneLeakValidation.valid && diagnosticNoneLeakValidation.errors.some((error) => error.message.includes('diagnostic fields are present')), 'validator should reject diagnostics:none schema detail leakage');

  const rawPlanHashDisabled = createEmptySqlTrace({
    runId: 'sql:test:raw-plan-hash-disabled',
    capture: { plans: 'estimate', planDetail: 'summary', hashes: { plans: 'none' } },
  });
  rawPlanHashDisabled.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: rawPlanHashDisabled.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT 1', dialect: 'unknown', operation: 'select', operationSource: 'regex' },
    status: 'ok',
  }, {
    kind: 'plan',
    eventId: 'e2',
    runId: rawPlanHashDisabled.runId,
    ordinal: 1,
    statementId: 's1',
    source: 'explain-json',
    requestedBy: 'harness',
    mode: 'estimate',
    safeToExecute: true,
    rawPlan: { format: 'json', hash: 'fnv1a32:leak' },
  });
  const rawPlanHashDisabledValidation = validateSqlTrace(rawPlanHashDisabled);
  assertCondition(!rawPlanHashDisabledValidation.valid && rawPlanHashDisabledValidation.errors.some((error) => error.message.includes('raw plan hash is present')), 'validator should reject raw plan hashes when disabled');

  const badBatchLink = createEmptySqlTrace({ runId: 'sql:test:bad-batch-link' });
  badBatchLink.events.push({
    kind: 'batch',
    eventId: 'e1',
    runId: badBatchLink.runId,
    ordinal: 0,
    batchId: 'b1',
    api: 'exec',
    sql: { redactedText: 'BROKEN SQL', dialect: 'unknown' },
    status: 'error',
  });
  const badBatchLinkValidation = validateSqlTrace(badBatchLink);
  assertCondition(!badBatchLinkValidation.valid && badBatchLinkValidation.errors.some((error) => error.message.includes('linked batch error event')), 'validator should reject errored batches without linked error events');

  const nestedSqlLeak = createEmptySqlTrace({ runId: 'sql:test:nested-sql-leak' });
  nestedSqlLeak.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: nestedSqlLeak.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT 1', dialect: 'unknown', operation: 'select', operationSource: 'regex', role: 'graph-node' },
    status: 'ok',
  } as never);
  const nestedSqlLeakValidation = validateSqlTrace(nestedSqlLeak);
  assertCondition(!nestedSqlLeakValidation.valid && nestedSqlLeakValidation.errors.some((error) => error.message.includes('unknown SQL capture metadata field')), 'validator should reject unknown SQL metadata fields');

  const nestedParamLeak = createEmptySqlTrace({ runId: 'sql:test:nested-param-leak' });
  nestedParamLeak.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: nestedParamLeak.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT 1', dialect: 'unknown', operation: 'select', operationSource: 'regex' },
    params: [{ position: 1, redacted: true, rawValue: 'secret@example.com' }],
    status: 'ok',
  } as never);
  const nestedParamLeakValidation = validateSqlTrace(nestedParamLeak);
  assertCondition(!nestedParamLeakValidation.valid && nestedParamLeakValidation.errors.some((error) => error.message.includes('unknown SQL parameter field')), 'validator should reject unknown parameter fields');

  const nestedRawPlanLeak = createEmptySqlTrace({
    runId: 'sql:test:nested-raw-plan-leak',
    capture: { plans: 'estimate', planDetail: 'raw-capped', hashes: { plans: 'stable' } },
  });
  nestedRawPlanLeak.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: nestedRawPlanLeak.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT 1', dialect: 'unknown', operation: 'select', operationSource: 'regex' },
    status: 'ok',
  }, {
    kind: 'plan',
    eventId: 'e2',
    runId: nestedRawPlanLeak.runId,
    ordinal: 1,
    statementId: 's1',
    source: 'explain-json',
    requestedBy: 'harness',
    mode: 'estimate',
    safeToExecute: true,
    rawPlan: { format: 'json', hash: 'fnv1a32:12345678', secretExtra: 'leak' },
  } as never);
  const nestedRawPlanLeakValidation = validateSqlTrace(nestedRawPlanLeak);
  assertCondition(!nestedRawPlanLeakValidation.valid && nestedRawPlanLeakValidation.errors.some((error) => error.message.includes('unknown SQL raw plan field')), 'validator should reject unknown rawPlan fields');

  const nestedRelationLeak = createEmptySqlTrace({
    runId: 'sql:test:nested-relation-leak',
    capture: { relationAccess: 'explain' },
  });
  nestedRelationLeak.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: nestedRelationLeak.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT * FROM users', dialect: 'unknown', operation: 'select', operationSource: 'regex' },
    status: 'ok',
  }, {
    kind: 'relation-access',
    eventId: 'e2',
    runId: nestedRelationLeak.runId,
    ordinal: 1,
    statementId: 's1',
    source: 'explain',
    confidence: 'medium',
    accesses: [{ relation: { name: 'users', kind: 'table', extraSecret: 'leak' }, access: 'read' }],
  } as never);
  const nestedRelationLeakValidation = validateSqlTrace(nestedRelationLeak);
  assertCondition(!nestedRelationLeakValidation.valid && nestedRelationLeakValidation.errors.some((error) => error.message.includes('unknown SQL relation field')), 'validator should reject unknown relation fields');

  const nestedTimingLeak = createEmptySqlTrace({ runId: 'sql:test:nested-timing-leak' });
  nestedTimingLeak.events.push({
    kind: 'statement',
    eventId: 'e1',
    runId: nestedTimingLeak.runId,
    ordinal: 0,
    statementId: 's1',
    api: 'query',
    sql: { redactedText: 'SELECT 1', dialect: 'unknown', operation: 'select', operationSource: 'regex' },
    timing: { durationMs: 1, secretExtra: 2 },
    sourceSpan: { start: { offset: 0, line: 1, column: 1, extra: true }, end: { offset: 8, line: 1, column: 9 } },
    status: 'ok',
  } as never);
  const nestedTimingLeakValidation = validateSqlTrace(nestedTimingLeak);
  assertCondition(!nestedTimingLeakValidation.valid && nestedTimingLeakValidation.errors.some((error) => error.message.includes('unknown SQL timing field') || error.message.includes('unknown SQL source position field')), 'validator should reject unknown timing and sourceSpan fields');

  console.log('PASS: SQL trace validator rejects unsupported kinds, unsafe plans, weak relation access, and policy violations');
}

async function main(): Promise<void> {
  testEmptyTrace();
  testPgliteTraceDefaults();
  testSqlScriptSplitting();
  testSqlRedactionCoversPostgresLiteralForms();
  await testTracedQueryCapture();
  await testBinaryScalarAndClonePrivacy();
  await testExplainEstimatePlanCapture();
  await testMultipleInstancesAndConcurrentQueries();
  await testIsolatedSqlCasesUseFreshDatabaseState();
  await testExecAndTransactionCapture();
  await testApiRollbackReasonCapture();
  await testExecFailureCapturesBatchOnly();
  await testExplicitSqlTransactionCapture();
  await testErrorCapture();
  testValidationFailures();
  console.log('\nSQL trace contract tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
