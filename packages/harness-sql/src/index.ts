export const SQL_TRACE_SCHEMA_VERSION = 'sql-trace-2026-06-13' as const;

export type SqlTraceSchemaVersion = typeof SQL_TRACE_SCHEMA_VERSION;

export type SqlEngineKind = 'pglite' | 'sqlite-wasm' | 'duckdb-wasm' | 'custom';
export type SqlDialect = 'postgres' | 'sqlite' | 'duckdb' | 'unknown';
export type SqlPersistence = 'memory' | 'indexeddb' | 'opfs' | 'file' | 'unknown';

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

export interface SqlTraceEngine {
  kind: SqlEngineKind;
  dialect: SqlDialect;
  engineVersion?: string;
  adapterVersion?: string;
  persistence?: SqlPersistence;
  capabilities?: SqlTraceCapability[];
  extras?: Record<string, unknown>;
}

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
  hashes: SqlTraceHashPolicy;
}

export interface SqlTraceHashPolicy {
  sql: 'none' | 'normalized-redacted' | 'raw';
  params: 'none' | 'per-run' | 'stable';
  plans: 'none' | 'per-run' | 'stable';
}

export interface SqlTrace {
  schemaVersion: SqlTraceSchemaVersion;
  runId: string;
  engine: SqlTraceEngine;
  capture: SqlTraceCapturePolicy;
  events: SqlTraceEvent[];
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

export type SqlStatementApi = 'query' | 'exec' | 'sql-template' | 'transaction-api' | 'protocol' | 'script';
export type SqlBatchApi = 'exec' | 'script' | 'migration';
export type SqlTimingSource = 'measured' | 'batch-derived' | 'posthoc' | 'unknown';

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

export interface SqlBatchEvent extends SqlBaseEvent {
  kind: 'batch';
  batchId: string;
  api: SqlBatchApi;
  sql: SqlCapturedText;
  timing?: SqlTiming;
  status: 'ok' | 'error' | 'timeout';
  statementCountKnown?: number;
  timingSource?: SqlTimingSource;
}

export interface SqlStatementEvent extends SqlBaseEvent {
  kind: 'statement';
  statementId: string;
  batchId?: string;
  statementIndex?: number;
  statementCountKnown?: number;
  api: SqlStatementApi;
  sql: SqlCapturedText & {
    operation?: SqlOperation;
    operationSource?: 'parser' | 'regex' | 'engine' | 'unknown';
    operationConfidence?: 'high' | 'medium' | 'low';
  };
  params?: SqlParam[];
  timing?: SqlTiming;
  timingSource?: SqlTimingSource;
  status: 'ok' | 'error' | 'timeout';
  transactionContext?: 'autocommit-implicit' | 'explicit-sql' | 'api-wrapper' | 'unknown';
  summary?: {
    affectedRows?: number;
    returnedRowsKnown?: number;
    returnedRowsCaptured?: number;
    fieldsCount?: number;
  };
}

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
  | { kind: 'bytes'; byteLength: number; hash?: string }
  | { kind: 'json'; preview: string; truncated: boolean };

export interface SqlResultEvent extends SqlBaseEvent {
  kind: 'result';
  statementId: string;
  batchId?: string;
  fields: SqlField[];
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

export interface SqlField {
  name: string;
  ordinal: number;
  dialectTypeName?: string;
  pgTypeId?: number;
  nullable?: boolean;
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

export interface SqlTraceValidationError {
  path: string;
  message: string;
}

export interface SqlTraceValidationResult {
  valid: boolean;
  errors: SqlTraceValidationError[];
}

export interface SplitSqlStatement {
  text: string;
  startOffset: number;
  endOffset: number;
  sourceSpan: SqlSourceSpan;
}

export interface SqlClientResult {
  rows?: unknown[];
  affectedRows?: number;
  fields?: Array<{
    name?: unknown;
    dataTypeID?: unknown;
    dataTypeId?: unknown;
    dataTypeName?: unknown;
  }>;
}

export interface SqlClientLike {
  query<T = unknown>(sql: string, params?: unknown[], options?: unknown): Promise<SqlClientResult & { rows?: T[] }>;
  exec?(sql: string, options?: unknown): Promise<SqlClientResult[]>;
  transaction?<T>(callback: (tx: SqlClientLike) => Promise<T>): Promise<T>;
}

export type SqlTraceCapturePolicyOptions = Partial<Omit<SqlTraceCapturePolicy, 'hashes'>> & {
  hashes?: Partial<SqlTraceHashPolicy>;
};

export interface CreateSqlTraceOptions {
  runId?: string;
  engine?: Partial<SqlTraceEngine>;
  capture?: SqlTraceCapturePolicyOptions;
}

export interface SqlTraceClientOptions extends CreateSqlTraceOptions {
  file?: string;
  now?: () => number;
  onEvent?: (event: SqlTraceEvent) => void;
}

export interface PgliteSqlTraceClientOptions extends SqlTraceClientOptions {
  dataDir?: string;
  persistence?: SqlPersistence;
  capabilities?: SqlTraceCapability[];
}

export interface SqlTraceQueryOptions {
  params?: unknown[];
  clientOptions?: unknown;
  api?: SqlStatementApi;
  file?: string;
  sourceSpan?: SqlSourceSpan;
  timeoutMs?: number;
}

export interface SqlTraceExecOptions {
  clientOptions?: unknown;
  file?: string;
  timeoutMs?: number;
}

export interface TracedSqlClient<TClient extends SqlClientLike = SqlClientLike> {
  readonly client: TClient;
  query<T = unknown>(sql: string, params?: unknown[], options?: unknown): Promise<SqlClientResult & { rows?: T[] }>;
  exec(sql: string, options?: unknown): Promise<SqlClientResult[]>;
  transaction<T>(callback: (tx: TracedSqlClient<SqlClientLike>) => Promise<T>): Promise<T>;
  traceQuery<T = unknown>(sql: string, options?: SqlTraceQueryOptions): Promise<SqlClientResult & { rows?: T[] }>;
  traceExec(sql: string, options?: SqlTraceExecOptions): Promise<SqlClientResult[]>;
  getTrace(): SqlTrace;
  clearTrace(): void;
}

export type SqlRunIsolationMode = 'fresh-database';

export interface SqlRunCase {
  id?: string;
  input?: Record<string, unknown>;
  assertions?: SqlRunAssertion[];
}

export interface SqlRunAssertion {
  id?: string;
  sql: string;
  params?: unknown[];
  expectedRows?: unknown[];
  expectedRowCount?: number;
  expectedAffectedRows?: number;
}

export interface SqlRunAssertionResult {
  id?: string;
  success: boolean;
  passed: boolean;
  rows?: unknown[];
  affectedRows?: number;
  expectedRows?: unknown[];
  expectedRowCount?: number;
  expectedAffectedRows?: number;
  error?: string;
}

export interface SqlRunCaseResult {
  id?: string;
  success: boolean;
  passed: boolean;
  output?: unknown;
  error?: string;
  assertions: SqlRunAssertionResult[];
  attemptTrace?: SqlTrace;
  setupTrace?: SqlTrace;
  assertionTrace?: SqlTrace;
}

export interface SqlRunResult {
  success: boolean;
  isolation: SqlRunIsolationMode;
  cases: SqlRunCaseResult[];
  setupTrace?: SqlTrace;
  setupError?: string;
}

export interface SqlRunDatabase<TClient extends SqlClientLike = SqlClientLike> {
  client: TClient;
  close?: () => void | Promise<void>;
  destroy?: () => void | Promise<void>;
}

export interface SqlRunDatabaseFactoryContext {
  problemId?: string;
  runId: string;
  phase: 'baseline' | 'case';
  caseId?: string;
  caseIndex?: number;
  baselineSnapshot?: unknown;
}

export interface SqlRunSnapshotContext {
  problemId?: string;
  runId: string;
}

export interface SqlRunTraceOptions {
  setup?: SqlTraceClientOptions;
  attempt?: SqlTraceClientOptions;
  assertions?: SqlTraceClientOptions;
  includeSetupTrace?: boolean;
  includeAssertionTrace?: boolean;
}

export interface SqlRunCaseContext<TClient extends SqlClientLike = SqlClientLike> {
  sql: TracedSqlClient<TClient>;
  client: TClient;
  testCase: SqlRunCase;
  caseIndex: number;
}

export type SqlRunSubmission<TClient extends SqlClientLike = SqlClientLike> =
  | string
  | ((context: SqlRunCaseContext<TClient>) => unknown | Promise<unknown>);

export interface RunIsolatedSqlCasesRequest<TClient extends SqlClientLike = SqlClientLike> {
  problemId?: string;
  runId?: string;
  setupSql?: string;
  seedSql?: string;
  submission: SqlRunSubmission<TClient>;
  cases: SqlRunCase[];
  isolation?: SqlRunIsolationMode;
  createDatabase(context: SqlRunDatabaseFactoryContext): Promise<SqlRunDatabase<TClient> | TClient> | SqlRunDatabase<TClient> | TClient;
  snapshotDatabase?: (client: TClient, context: SqlRunSnapshotContext) => Promise<unknown> | unknown;
  createTraceClient?: (client: TClient, options: SqlTraceClientOptions) => TracedSqlClient<TClient>;
  trace?: SqlRunTraceOptions;
}

const DEFAULT_CAPTURE: SqlTraceCapturePolicy = {
  sqlText: 'redacted',
  params: 'redacted',
  diagnostics: 'redacted',
  resultRows: 'none',
  maxRowsPerResult: 50,
  maxCellBytes: 1024,
  plans: 'none',
  planDetail: 'summary',
  relationAccess: 'none',
  hashes: {
    sql: 'none',
    params: 'none',
    plans: 'none',
  },
};

const SQL_EVENT_KINDS = new Set<SqlTraceEventKind>([
  'batch',
  'statement',
  'result',
  'transaction',
  'error',
  'timeout',
  'relation-access',
  'plan',
  'notice',
]);

const SQL_ENGINE_KINDS = new Set<SqlEngineKind>(['pglite', 'sqlite-wasm', 'duckdb-wasm', 'custom']);
const SQL_DIALECTS = new Set<SqlDialect>(['postgres', 'sqlite', 'duckdb', 'unknown']);
const SQL_PERSISTENCE = new Set<SqlPersistence>(['memory', 'indexeddb', 'opfs', 'file', 'unknown']);
const SQL_STATEMENT_APIS = new Set<SqlStatementApi>(['query', 'exec', 'sql-template', 'transaction-api', 'protocol', 'script']);
const SQL_BATCH_APIS = new Set<SqlBatchApi>(['exec', 'script', 'migration']);
const SQL_TIMING_SOURCES = new Set<SqlTimingSource>(['measured', 'batch-derived', 'posthoc', 'unknown']);
const SQL_TEXT_CAPTURE_VALUES = new Set(['none', 'redacted', 'full']);
const SQL_PARAM_CAPTURE_VALUES = new Set(['none', 'types', 'redacted', 'full']);
const SQL_DIAGNOSTIC_CAPTURE_VALUES = new Set(['none', 'redacted', 'full']);
const SQL_RESULT_ROW_CAPTURE_VALUES = new Set(['none', 'sampled']);
const SQL_PLAN_CAPTURE_VALUES = new Set(['none', 'estimate', 'analyze']);
const SQL_PLAN_DETAIL_VALUES = new Set(['summary', 'raw-capped', 'raw-full']);
const SQL_RELATION_CAPTURE_VALUES = new Set(['none', 'parser', 'explain', 'best-effort']);
const SQL_HASH_SQL_VALUES = new Set(['none', 'normalized-redacted', 'raw']);
const SQL_HASH_PARAM_VALUES = new Set(['none', 'per-run', 'stable']);
const SQL_HASH_PLAN_VALUES = new Set(['none', 'per-run', 'stable']);
const SQL_TRACE_ALLOWED_KEYS = new Set(['schemaVersion', 'runId', 'engine', 'capture', 'events']);
const SQL_ENGINE_ALLOWED_KEYS = new Set(['kind', 'dialect', 'engineVersion', 'adapterVersion', 'persistence', 'capabilities', 'extras']);
const SQL_CAPTURE_ALLOWED_KEYS = new Set([
  'sqlText',
  'params',
  'diagnostics',
  'resultRows',
  'maxRowsPerResult',
  'maxCellBytes',
  'maxTraceBytes',
  'plans',
  'planDetail',
  'relationAccess',
  'hashes',
]);
const SQL_HASH_ALLOWED_KEYS = new Set(['sql', 'params', 'plans']);
const SQL_CAPTURED_TEXT_ALLOWED_KEYS = new Set(['text', 'redactedText', 'hash', 'normalizedHash', 'dialect', 'operation', 'operationSource', 'operationConfidence']);
const SQL_TIMING_ALLOWED_KEYS = new Set(['startTimeMs', 'endTimeMs', 'durationMs']);
const SQL_SOURCE_SPAN_ALLOWED_KEYS = new Set(['start', 'end']);
const SQL_SOURCE_POSITION_ALLOWED_KEYS = new Set(['offset', 'line', 'column']);
const SQL_PARAM_ALLOWED_KEYS = new Set(['position', 'name', 'type', 'redacted', 'valuePreview', 'valueHash', 'byteLength', 'truncated']);
const SQL_PARAM_TYPE_ALLOWED_KEYS = new Set(['dialectTypeName', 'pgTypeId']);
const SQL_STATEMENT_SUMMARY_ALLOWED_KEYS = new Set(['affectedRows', 'returnedRowsKnown', 'returnedRowsCaptured', 'fieldsCount']);
const SQL_RESULT_FIELD_ALLOWED_KEYS = new Set(['name', 'ordinal', 'dialectTypeName', 'pgTypeId', 'nullable']);
const SQL_RESULT_ROWS_ALLOWED_KEYS = new Set(['mode', 'values', 'rowCountCaptured', 'rowCountKnown', 'truncated']);
const SQL_CELL_ALLOWED_KEYS = new Set(['value', 'redacted', 'truncated']);
const SQL_SCALAR_OBJECT_ALLOWED_KEYS: Record<string, ReadonlySet<string>> = {
  bigint: new Set(['kind', 'text']),
  bytes: new Set(['kind', 'byteLength']),
  json: new Set(['kind', 'preview', 'truncated']),
};
const SQL_PLAN_SUMMARY_ALLOWED_KEYS = new Set(['rootNodeType', 'estimatedRows', 'estimatedTotalCost', 'relations']);
const SQL_RAW_PLAN_ALLOWED_KEYS = new Set(['format', 'value', 'hash', 'truncated']);
const SQL_RELATION_ACCESS_ALLOWED_KEYS = new Set(['relation', 'access', 'columns', 'via']);
const SQL_RELATION_ALLOWED_KEYS = new Set(['schema', 'name', 'kind']);
const SQL_BASE_EVENT_KEYS = [
  'kind',
  'eventId',
  'runId',
  'ordinal',
  'batchId',
  'statementId',
  'transactionId',
  'file',
  'sourceSpan',
  'timestampMs',
  'extras',
] as const;
const SQL_EVENT_ALLOWED_KEYS: Record<SqlTraceEventKind, ReadonlySet<string>> = {
  batch: new Set([...SQL_BASE_EVENT_KEYS, 'api', 'sql', 'timing', 'status', 'statementCountKnown', 'timingSource']),
  statement: new Set([...SQL_BASE_EVENT_KEYS, 'api', 'sql', 'params', 'timing', 'timingSource', 'status', 'transactionContext', 'summary', 'statementIndex', 'statementCountKnown']),
  result: new Set([...SQL_BASE_EVENT_KEYS, 'fields', 'fieldsSource', 'rows', 'affectedRows']),
  transaction: new Set([...SQL_BASE_EVENT_KEYS, 'action', 'source', 'name', 'status', 'reason']),
  error: new Set([...SQL_BASE_EVENT_KEYS, 'severity', 'sqlState', 'message', 'detail', 'hint', 'position', 'schemaName', 'tableName', 'columnName', 'constraintName', 'dataTypeName', 'redacted']),
  timeout: new Set([...SQL_BASE_EVENT_KEYS, 'timeoutMs', 'elapsedMs', 'cancelled', 'executionMayHaveContinued', 'reason']),
  'relation-access': new Set([...SQL_BASE_EVENT_KEYS, 'source', 'confidence', 'accesses']),
  plan: new Set([...SQL_BASE_EVENT_KEYS, 'source', 'requestedBy', 'mode', 'safeToExecute', 'targetStatementExecuted', 'diagnosticStatementExecuted', 'sideEffectRisk', 'timing', 'summary', 'rawPlan']),
  notice: new Set([...SQL_BASE_EVENT_KEYS, 'severity', 'sqlState', 'message', 'detail', 'hint', 'position']),
};

const SQL_OPERATIONS = new Set<SqlOperation>([
  'select',
  'insert',
  'update',
  'delete',
  'merge',
  'create',
  'alter',
  'drop',
  'truncate',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'explain',
  'prepare',
  'execute',
  'copy',
  'analyze',
  'vacuum',
  'set',
  'show',
  'reset',
  'grant',
  'revoke',
  'listen',
  'notify',
  'unlisten',
  'call',
  'do',
  'declare',
  'fetch',
  'close',
  'other',
  'unknown',
]);

export const PGLITE_SQL_TRACE_CAPABILITIES: SqlTraceCapability[] = [
  'single-statement-query',
  'multi-statement-exec',
  'parameterized-query',
  'transactions',
];

const SQL_TRACE_CAPABILITIES = new Set<SqlTraceCapability>([
  'single-statement-query',
  'multi-statement-exec',
  'parameterized-query',
  'transactions',
  'describe-query',
  'explain-json',
  'notice-response',
  'relation-access-parser',
  'relation-access-explain',
  'live-changes',
  'sqlite-trace-hook',
  'sqlite-update-hook',
]);

const SEMANTIC_KEYS = new Set([
  'visualization',
  'objectKinds',
  'hashMaps',
  'algorithmFamily',
  'algorithm',
  'visualizer',
]);

const SEMANTIC_TOKENS = new Set(['graph-adjacency', 'linked-list', 'hash-map']);

let globalTraceCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nextRunId(): string {
  globalTraceCounter += 1;
  return `sql:run:${globalTraceCounter}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeSqlTraceCapturePolicy(
  policy: SqlTraceCapturePolicyOptions = {}
): SqlTraceCapturePolicy {
  const maxRowsPerResult = finiteNumber(policy.maxRowsPerResult) ?? DEFAULT_CAPTURE.maxRowsPerResult;
  const maxCellBytes = finiteNumber(policy.maxCellBytes) ?? DEFAULT_CAPTURE.maxCellBytes;
  return {
    sqlText: policy.sqlText ?? DEFAULT_CAPTURE.sqlText,
    params: policy.params ?? DEFAULT_CAPTURE.params,
    diagnostics: policy.diagnostics ?? DEFAULT_CAPTURE.diagnostics,
    resultRows: policy.resultRows ?? DEFAULT_CAPTURE.resultRows,
    maxRowsPerResult: Math.max(0, Math.floor(maxRowsPerResult)),
    maxCellBytes: Math.max(16, Math.floor(maxCellBytes)),
    ...(finiteNumber(policy.maxTraceBytes) !== undefined ? { maxTraceBytes: Math.max(0, Math.floor(policy.maxTraceBytes!)) } : {}),
    plans: policy.plans ?? DEFAULT_CAPTURE.plans,
    planDetail: policy.planDetail ?? DEFAULT_CAPTURE.planDetail,
    relationAccess: policy.relationAccess ?? DEFAULT_CAPTURE.relationAccess,
    hashes: {
      sql: policy.hashes?.sql ?? DEFAULT_CAPTURE.hashes.sql,
      params: policy.hashes?.params ?? DEFAULT_CAPTURE.hashes.params,
      plans: policy.hashes?.plans ?? DEFAULT_CAPTURE.hashes.plans,
    },
  };
}

export function createEmptySqlTrace(options: CreateSqlTraceOptions = {}): SqlTrace {
  return {
    schemaVersion: SQL_TRACE_SCHEMA_VERSION,
    runId: options.runId ?? nextRunId(),
    engine: {
      kind: options.engine?.kind ?? 'custom',
      dialect: options.engine?.dialect ?? 'unknown',
      ...(options.engine?.engineVersion ? { engineVersion: options.engine.engineVersion } : {}),
      ...(options.engine?.adapterVersion ? { adapterVersion: options.engine.adapterVersion } : {}),
      ...(options.engine?.persistence ? { persistence: options.engine.persistence } : {}),
      ...(options.engine?.capabilities ? { capabilities: [...options.engine.capabilities] } : {}),
      ...(options.engine?.extras ? { extras: structuredCloneFallback(options.engine.extras) } : {}),
    },
    capture: normalizeSqlTraceCapturePolicy(options.capture),
    events: [],
  };
}

export function stableSqlHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function redactSqlText(sql: string): string {
  return redactSqlSensitiveText(sql, { redactDoubleQuoted: false });
}

export function normalizeSqlTextForHash(sql: string): string {
  return redactSqlText(sql).toLowerCase();
}

export function classifySqlOperation(sql: string): { operation: SqlOperation; source: 'regex' | 'unknown'; confidence: 'high' | 'medium' | 'low' } {
  const text = stripSqlLeadingTrivia(sql).trimStart();
  const first = /^[A-Za-z]+/.exec(text)?.[0]?.toLowerCase();
  if (!first) return { operation: 'unknown', source: 'unknown', confidence: 'low' };
  if (first === 'with') return { operation: 'unknown', source: 'regex', confidence: 'low' };
  return {
    operation: SQL_OPERATIONS.has(first as SqlOperation) ? first as SqlOperation : 'other',
    source: 'regex',
    confidence: SQL_OPERATIONS.has(first as SqlOperation) ? 'medium' : 'low',
  };
}

function stripSqlLeadingTrivia(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    if (/\s/.test(sql[index] ?? '')) {
      index += 1;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const nextLine = sql.indexOf('\n', index + 2);
      index = nextLine === -1 ? sql.length : nextLine + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    break;
  }
  return sql.slice(index);
}

export function splitSqlStatements(sql: string): SplitSqlStatement[] {
  const statements: SplitSqlStatement[] = [];
  let start = 0;
  let index = 0;
  let state: 'normal' | 'single' | 'double' | 'line-comment' | 'block-comment' | 'dollar' = 'normal';
  let dollarDelimiter = '';

  const pushStatement = (end: number) => {
    const raw = sql.slice(start, end);
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    const statementStart = start + leading;
    const statementEnd = end - trailing;
    if (statementEnd > statementStart) {
      statements.push({
        text: sql.slice(statementStart, statementEnd),
        startOffset: statementStart,
        endOffset: statementEnd,
        sourceSpan: sourceSpanForOffsets(sql, statementStart, statementEnd),
      });
    }
    start = end + 1;
  };

  while (index < sql.length) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';

    if (state === 'line-comment') {
      if (char === '\n') state = 'normal';
      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'normal';
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (state === 'single') {
      if (char === "'" && next === "'") {
        index += 2;
        continue;
      }
      if (char === "'") state = 'normal';
      index += 1;
      continue;
    }

    if (state === 'double') {
      if (char === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (char === '"') state = 'normal';
      index += 1;
      continue;
    }

    if (state === 'dollar') {
      if (dollarDelimiter && sql.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length;
        state = 'normal';
        dollarDelimiter = '';
        continue;
      }
      index += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      state = 'line-comment';
      index += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      index += 2;
      continue;
    }
    if (char === "'") {
      state = 'single';
      index += 1;
      continue;
    }
    if (char === '"') {
      state = 'double';
      index += 1;
      continue;
    }
    if (char === '$') {
      const delimiter = readDollarQuoteDelimiter(sql, index);
      if (delimiter) {
        state = 'dollar';
        dollarDelimiter = delimiter;
        index += delimiter.length;
        continue;
      }
    }
    if (char === ';') {
      pushStatement(index);
      index += 1;
      continue;
    }
    index += 1;
  }

  pushStatement(sql.length);
  return statements;
}

function readDollarQuoteDelimiter(sql: string, start: number): string | null {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(start));
  return match?.[0] ?? null;
}

function sourceSpanForOffsets(source: string, start: number, end: number): SqlSourceSpan {
  const startPosition = lineColumnForOffset(source, start);
  const endPosition = lineColumnForOffset(source, end);
  return {
    start: { offset: start, line: startPosition.line, column: startPosition.column },
    end: { offset: end, line: endPosition.line, column: endPosition.column },
  };
}

function lineColumnForOffset(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

export function captureSqlParam(
  value: unknown,
  index: number,
  capture: SqlTraceCapturePolicy,
  runId = ''
): SqlParam | null {
  if (capture.params === 'none') return null;
  const param: SqlParam = {
    position: index + 1,
    redacted: capture.params !== 'full',
  };
  if (capture.params === 'full') {
    const scalar = toSqlScalar(value, capture.maxCellBytes);
    param.valuePreview = scalar;
    const truncated = scalarTruncated(value, scalar, capture.maxCellBytes);
    if (truncated) param.truncated = true;
  } else if (capture.params === 'redacted') {
    const preview = stablePreview(value);
    if (capture.hashes.params === 'stable') {
      param.valueHash = stableSqlHash(preview);
    } else if (capture.hashes.params === 'per-run') {
      param.valueHash = stableSqlHash(`${runId}:${preview}`);
    }
  }
  return param;
}

export function captureSqlParams(
  params: unknown[] | undefined,
  capture: SqlTraceCapturePolicy,
  runId = ''
): SqlParam[] | undefined {
  if (!Array.isArray(params) || capture.params === 'none') return undefined;
  return params.flatMap((value, index) => {
    const captured = captureSqlParam(value, index, capture, runId);
    return captured ? [captured] : [];
  });
}

export function toSqlScalar(value: unknown, maxCellBytes = DEFAULT_CAPTURE.maxCellBytes): SqlScalar {
  if (value === null) return null;
  if (typeof value === 'string') return truncateString(value, maxCellBytes).value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return { kind: 'bigint', text: String(value) };
  if (value instanceof Uint8Array) return { kind: 'bytes', byteLength: value.byteLength };
  if (value instanceof ArrayBuffer) return { kind: 'bytes', byteLength: value.byteLength };
  const preview = stablePreview(value);
  const truncated = truncateString(preview, maxCellBytes);
  return { kind: 'json', preview: truncated.value, truncated: truncated.truncated };
}

function stablePreview(value: unknown): string {
  if (value === undefined) return '<undefined>';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return '<function>';
  if (typeof value === 'symbol') return value.toString();
  try {
    return JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? String(child) : child) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncateString(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (byteLength(value) <= maxBytes) return { value, truncated: false };
  let next = '';
  for (const char of value) {
    if (byteLength(next + char) > maxBytes) break;
    next += char;
  }
  return { value: next, truncated: true };
}

function scalarTruncated(value: unknown, scalar: SqlScalar, maxBytes: number): boolean {
  if (typeof scalar === 'string') return byteLength(String(value ?? '')) > maxBytes;
  if (isRecord(scalar) && scalar.kind === 'json') return Boolean(scalar.truncated);
  return false;
}

export function captureSqlResult(
  result: SqlClientResult,
  options: {
    runId: string;
    eventId: string;
    ordinal: number;
    statementId: string;
    capture: SqlTraceCapturePolicy;
    batchId?: string;
    file?: string;
    sourceSpan?: SqlSourceSpan;
    transactionId?: string;
    timestampMs?: number;
  }
): SqlResultEvent {
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const capturedFields = captureSqlFields(result.fields, rows);
  const capturedRows = options.capture.resultRows === 'sampled'
    ? rows.slice(0, options.capture.maxRowsPerResult).map((row) => captureSqlRow(row, options.capture))
    : [];
  const rowMode = rows.some(Array.isArray) ? 'array' : 'object';
  return {
    kind: 'result',
    eventId: options.eventId,
    runId: options.runId,
    ordinal: options.ordinal,
    statementId: options.statementId,
    ...(options.batchId ? { batchId: options.batchId } : {}),
    ...(options.transactionId ? { transactionId: options.transactionId } : {}),
    ...(options.file ? { file: options.file } : {}),
    ...(options.sourceSpan ? { sourceSpan: options.sourceSpan } : {}),
    ...(options.timestampMs !== undefined ? { timestampMs: options.timestampMs } : {}),
    fields: capturedFields.fields,
    fieldsSource: capturedFields.source,
    rows: {
      mode: rowMode,
      values: capturedRows,
      rowCountCaptured: capturedRows.length,
      rowCountKnown: rows.length,
      truncated: rows.length > capturedRows.length,
    },
    ...(finiteNumber(result.affectedRows) !== undefined ? { affectedRows: result.affectedRows } : {}),
  };
}

function captureSqlFields(
  fields: SqlClientResult['fields'],
  rows: unknown[]
): { fields: SqlField[]; source: SqlResultEvent['fieldsSource'] } {
  if (Array.isArray(fields) && fields.length > 0) {
    return {
      source: 'engine',
      fields: fields.map((field, index) => ({
        name: stringValue(field.name) ?? `column_${index + 1}`,
        ordinal: index,
        ...(finiteNumber(field.dataTypeID) !== undefined ? { pgTypeId: field.dataTypeID as number } : {}),
        ...(finiteNumber(field.dataTypeId) !== undefined ? { pgTypeId: field.dataTypeId as number } : {}),
        ...(stringValue(field.dataTypeName) ? { dialectTypeName: stringValue(field.dataTypeName) } : {}),
      })),
    };
  }
  const firstRow = rows.find((row) => row !== null && typeof row === 'object');
  if (Array.isArray(firstRow)) {
    return {
      source: 'row-shape',
      fields: firstRow.map((_value, index) => ({ name: `column_${index + 1}`, ordinal: index })),
    };
  }
  if (isRecord(firstRow)) {
    return {
      source: 'row-shape',
      fields: Object.keys(firstRow).map((name, index) => ({ name, ordinal: index })),
    };
  }
  return { source: 'unknown', fields: [] };
}

function captureSqlRow(row: unknown, capture: SqlTraceCapturePolicy): Record<string, SqlCell> | SqlCell[] {
  if (Array.isArray(row)) {
    return row.map((value) => captureSqlCell(value, capture));
  }
  if (isRecord(row)) {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, captureSqlCell(value, capture)]));
  }
  return { value: captureSqlCell(row, capture) };
}

function captureSqlCell(value: unknown, capture: SqlTraceCapturePolicy): SqlCell {
  if (capture.resultRows === 'none') return { redacted: true };
  const scalar = toSqlScalar(value, capture.maxCellBytes);
  const truncated = typeof scalar === 'string'
    ? byteLength(String(value ?? '')) > capture.maxCellBytes
    : isRecord(scalar) && scalar.kind === 'json'
      ? Boolean(scalar.truncated)
      : false;
  return {
    value: scalar,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function sqlErrorFromUnknown(
  error: unknown,
  options: {
    runId: string;
    eventId: string;
    ordinal: number;
    batchId?: string;
    statementId?: string;
    transactionId?: string;
    file?: string;
    sourceSpan?: SqlSourceSpan;
    timestampMs?: number;
    redacted?: boolean;
    diagnostics?: SqlTraceCapturePolicy['diagnostics'];
  }
): SqlErrorEvent {
  const record = isRecord(error) ? error : {};
  const message = error instanceof Error ? error.message : stringValue(record.message) ?? String(error);
  const diagnostics = options.diagnostics ?? (options.redacted ? 'redacted' : 'full');
  return {
    kind: 'error',
    eventId: options.eventId,
    runId: options.runId,
    ordinal: options.ordinal,
    ...(options.batchId ? { batchId: options.batchId } : {}),
    ...(options.statementId ? { statementId: options.statementId } : {}),
    ...(options.transactionId ? { transactionId: options.transactionId } : {}),
    ...(options.file ? { file: options.file } : {}),
    ...(options.sourceSpan ? { sourceSpan: options.sourceSpan } : {}),
    ...(options.timestampMs !== undefined ? { timestampMs: options.timestampMs } : {}),
    severity: stringValue(record.severity) ?? stringValue(record.severity_local),
    sqlState: stringValue(record.sqlState) ?? stringValue(record.sqlstate) ?? stringValue(record.code),
    message: diagnostics === 'none' ? '<redacted>' : diagnostics === 'redacted' ? redactSqlDiagnostic(message) : message,
    ...(diagnostics !== 'full' ? { redacted: true } : {}),
    ...(stringValue(record.detail) && diagnostics === 'full' ? { detail: stringValue(record.detail) } : {}),
    ...(stringValue(record.hint) && diagnostics === 'full' ? { hint: stringValue(record.hint) } : {}),
    ...(diagnostics !== 'none' && finiteNumber(record.position) !== undefined ? { position: record.position as number } : {}),
    ...(diagnostics !== 'none' && stringValue(record.schema) ? { schemaName: stringValue(record.schema) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.schemaName) ? { schemaName: stringValue(record.schemaName) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.table) ? { tableName: stringValue(record.table) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.tableName) ? { tableName: stringValue(record.tableName) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.column) ? { columnName: stringValue(record.column) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.columnName) ? { columnName: stringValue(record.columnName) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.constraint) ? { constraintName: stringValue(record.constraint) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.constraintName) ? { constraintName: stringValue(record.constraintName) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.dataType) ? { dataTypeName: stringValue(record.dataType) } : {}),
    ...(diagnostics !== 'none' && stringValue(record.dataTypeName) ? { dataTypeName: stringValue(record.dataTypeName) } : {}),
  };
}

function redactSqlDiagnostic(message: string): string {
  return redactSqlSensitiveText(message, { redactDoubleQuoted: true })
    .replace(/\([^)]*\)/g, '(<redacted>)');
}

function redactSqlSensitiveText(value: string, options: { redactDoubleQuoted: boolean }): string {
  let output = '';
  let index = 0;
  while (index < value.length) {
    const ch = value[index] ?? '';
    const dollarQuote = parseSqlDollarQuoteTag(value, index);
    if (dollarQuote) {
      const endIndex = value.indexOf(dollarQuote.tag, index + dollarQuote.tag.length);
      output += "'<redacted>'";
      index = endIndex < 0 ? value.length : endIndex + dollarQuote.tag.length;
      continue;
    }
    if ((ch === 'E' || ch === 'e') && value[index + 1] === "'" && !/[A-Za-z0-9_]/.test(value[index - 1] ?? '')) {
      output += "'<redacted>'";
      index = skipSqlQuotedString(value, index + 1, "'", true);
      continue;
    }
    if (ch === "'") {
      output += "'<redacted>'";
      index = skipSqlQuotedString(value, index, "'", true);
      continue;
    }
    if (options.redactDoubleQuoted && ch === '"') {
      output += '"<redacted>"';
      index = skipSqlQuotedString(value, index, '"', false);
      continue;
    }
    if (/\d/.test(ch) && !/[A-Za-z0-9_]/.test(value[index - 1] ?? '')) {
      const numberMatch = value.slice(index).match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (numberMatch && !/[A-Za-z0-9_]/.test(value[index + numberMatch[0].length] ?? '')) {
        output += '<number>';
        index += numberMatch[0].length;
        continue;
      }
    }
    output += ch;
    index += 1;
  }
  return output.replace(/\s+/g, ' ').trim();
}

function parseSqlDollarQuoteTag(value: string, index: number): { tag: string } | null {
  if (value[index] !== '$') return null;
  const match = value.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match ? { tag: match[0] } : null;
}

function skipSqlQuotedString(value: string, quoteIndex: number, quote: '"' | "'", allowBackslashEscapes: boolean): number {
  let index = quoteIndex + 1;
  while (index < value.length) {
    const ch = value[index] ?? '';
    if (allowBackslashEscapes && ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === quote) {
      if (value[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return value.length;
}

export function validateSqlTrace(value: unknown): SqlTraceValidationResult {
  const errors: SqlTraceValidationError[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });

  if (!isRecord(value)) {
    return { valid: false, errors: [{ path: '$', message: 'SqlTrace must be an object' }] };
  }

  validateObjectKeys(value, '$', SQL_TRACE_ALLOWED_KEYS, 'SqlTrace', add);
  if (value.schemaVersion !== SQL_TRACE_SCHEMA_VERSION) add('$.schemaVersion', `Expected ${SQL_TRACE_SCHEMA_VERSION}`);
  if (typeof value.runId !== 'string' || value.runId.length === 0) add('$.runId', 'runId is required');
  if (!isRecord(value.engine)) {
    add('$.engine', 'engine is required');
  } else {
    validateEngine(value.engine, '$.engine', add);
  }
  if (!isRecord(value.capture)) {
    add('$.capture', 'capture policy is required');
  } else {
    validateCapturePolicy(value.capture, '$.capture', add);
  }
  if (!Array.isArray(value.events)) add('$.events', 'events must be an array');

  const capture = normalizeCaptureForValidation(value.capture);
  if (capture.maxTraceBytes !== undefined) {
    const traceBytes = byteLength(stablePreview(value));
    if (traceBytes > capture.maxTraceBytes) {
      add('$.capture.maxTraceBytes', `trace size ${traceBytes} exceeds maxTraceBytes ${capture.maxTraceBytes}`);
    }
  }
  const statementIds = new Set<string>();
  const batchIds = new Set<string>();
  const eventIds = new Set<string>();
  const ordinals = new Set<number>();
  const linkedStatementIds: Array<{ path: string; statementId: string }> = [];
  const linkedBatchIds: Array<{ path: string; batchId: string }> = [];
  const statementStatuses = new Map<string, { path: string; status: 'ok' | 'error' | 'timeout' }>();
  const batchStatuses = new Map<string, { path: string; status: 'ok' | 'error' | 'timeout' }>();
  const statementLinkedKinds = new Map<string, Set<SqlTraceEventKind>>();
  const batchLinkedKinds = new Map<string, Set<SqlTraceEventKind>>();

  if (Array.isArray(value.events)) {
    value.events.forEach((event, index) => {
      const path = `$.events[${index}]`;
      if (!isRecord(event)) {
        add(path, 'event must be an object');
        return;
      }
      const kind = event.kind;
      if (typeof kind !== 'string' || !SQL_EVENT_KINDS.has(kind as SqlTraceEventKind)) {
        add(`${path}.kind`, `unsupported SQL trace event kind "${String(kind)}"`);
        return;
      }
      if (typeof event.eventId !== 'string' || event.eventId.length === 0) add(`${path}.eventId`, 'eventId is required');
      if (typeof event.eventId === 'string') {
        if (eventIds.has(event.eventId)) add(`${path}.eventId`, `duplicate eventId "${event.eventId}"`);
        eventIds.add(event.eventId);
      }
      if (event.runId !== value.runId) add(`${path}.runId`, 'event runId must match trace runId');
      if (typeof event.ordinal !== 'number' || !Number.isInteger(event.ordinal) || event.ordinal < 0) {
        add(`${path}.ordinal`, 'ordinal must be a non-negative integer');
      } else {
        if (ordinals.has(event.ordinal)) add(`${path}.ordinal`, `duplicate ordinal ${event.ordinal}`);
        if (event.ordinal !== index) add(`${path}.ordinal`, `ordinal must be monotonic and match event index ${index}`);
        ordinals.add(event.ordinal);
      }
      validateAllowedKeys(event, path, SQL_EVENT_ALLOWED_KEYS[kind as SqlTraceEventKind], add);
      if (event.extras !== undefined && !isRecord(event.extras)) {
        add(`${path}.extras`, 'extras must be an object when present');
      }
      if (event.sourceSpan !== undefined) validateSourceSpan(event.sourceSpan, `${path}.sourceSpan`, add);
      validateSemanticPayload(event, path, add);

      if (kind === 'batch') {
        validateBatchEvent(event, path, capture, batchIds, batchStatuses, add);
        return;
      }

      if (kind === 'statement') {
        validateStatementEvent(event, path, capture, statementIds, statementStatuses, add);
        if (typeof event.batchId === 'string') linkedBatchIds.push({ path: `${path}.batchId`, batchId: event.batchId });
        return;
      }

      if ('statementId' in event && typeof event.statementId === 'string') {
        linkedStatementIds.push({ path: `${path}.statementId`, statementId: event.statementId });
        const linkedKinds = statementLinkedKinds.get(event.statementId) ?? new Set<SqlTraceEventKind>();
        linkedKinds.add(kind as SqlTraceEventKind);
        statementLinkedKinds.set(event.statementId, linkedKinds);
      }
      if ('batchId' in event && typeof event.batchId === 'string') {
        linkedBatchIds.push({ path: `${path}.batchId`, batchId: event.batchId });
        const linkedKinds = batchLinkedKinds.get(event.batchId) ?? new Set<SqlTraceEventKind>();
        linkedKinds.add(kind as SqlTraceEventKind);
        batchLinkedKinds.set(event.batchId, linkedKinds);
      }

      if ((kind === 'result' || kind === 'plan' || kind === 'relation-access') && typeof event.statementId !== 'string') {
        add(`${path}.statementId`, `${kind} events must reference a statementId`);
      }
      if (kind === 'result') validateResultEvent(event, path, capture, add);
      if (kind === 'error') validateErrorEvent(event, path, capture, add);
      if (kind === 'timeout') validateTimeoutEvent(event, path, add);
      if (kind === 'plan') validatePlanEvent(event, path, capture, add);
      if (kind === 'relation-access') validateRelationAccessEvent(event, path, capture, add);
      if (kind === 'transaction') validateTransactionEvent(event, path, add);
      if (kind === 'notice') validateNoticeEvent(event, path, capture, add);
    });
  }

  for (const linked of linkedStatementIds) {
    if (!statementIds.has(linked.statementId)) add(linked.path, `unknown statementId "${linked.statementId}"`);
  }
  for (const linked of linkedBatchIds) {
    if (!batchIds.has(linked.batchId)) add(linked.path, `unknown batchId "${linked.batchId}"`);
  }
  for (const [statementId, statement] of statementStatuses) {
    const linkedKinds = statementLinkedKinds.get(statementId) ?? new Set<SqlTraceEventKind>();
    if (statement.status === 'error' && !linkedKinds.has('error')) {
      add(`${statement.path}.status`, 'statement status error requires a linked error event');
    }
    if (statement.status === 'timeout' && !linkedKinds.has('timeout')) {
      add(`${statement.path}.status`, 'statement status timeout requires a linked timeout event');
    }
    if (statement.status === 'ok' && (linkedKinds.has('error') || linkedKinds.has('timeout'))) {
      add(`${statement.path}.status`, 'statement status ok must not have linked error or timeout events');
    }
  }
  for (const [batchId, batch] of batchStatuses) {
    const linkedKinds = batchLinkedKinds.get(batchId) ?? new Set<SqlTraceEventKind>();
    if (batch.status === 'error' && !linkedKinds.has('error')) {
      add(`${batch.path}.status`, 'batch status error requires a linked batch error event');
    }
    if (batch.status === 'timeout' && !linkedKinds.has('timeout')) {
      add(`${batch.path}.status`, 'batch status timeout requires a linked batch timeout event');
    }
    if (batch.status === 'ok' && (linkedKinds.has('error') || linkedKinds.has('timeout'))) {
      add(`${batch.path}.status`, 'batch status ok must not have linked batch error or timeout events');
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateEngine(
  engine: Record<string, unknown>,
  path: string,
  add: (path: string, message: string) => void
): void {
  validateObjectKeys(engine, path, SQL_ENGINE_ALLOWED_KEYS, 'SQL engine', add);
  if (typeof engine.kind !== 'string' || !SQL_ENGINE_KINDS.has(engine.kind as SqlEngineKind)) {
    add(`${path}.kind`, 'engine kind is unsupported');
  }
  if (typeof engine.dialect !== 'string' || !SQL_DIALECTS.has(engine.dialect as SqlDialect)) {
    add(`${path}.dialect`, 'engine dialect is unsupported');
  }
  if (engine.persistence !== undefined && (typeof engine.persistence !== 'string' || !SQL_PERSISTENCE.has(engine.persistence as SqlPersistence))) {
    add(`${path}.persistence`, 'engine persistence is unsupported');
  }
  if (engine.capabilities !== undefined) {
    if (!Array.isArray(engine.capabilities)) {
      add(`${path}.capabilities`, 'engine capabilities must be an array');
    } else {
      engine.capabilities.forEach((capability, index) => {
        if (typeof capability !== 'string' || !SQL_TRACE_CAPABILITIES.has(capability as SqlTraceCapability)) {
          add(`${path}.capabilities[${index}]`, 'engine capability is unsupported');
        }
      });
    }
  }
  if (engine.extras !== undefined && !isRecord(engine.extras)) {
    add(`${path}.extras`, 'engine extras must be an object when present');
  }
}

function validateCapturePolicy(
  capture: Record<string, unknown>,
  path: string,
  add: (path: string, message: string) => void
): void {
  validateObjectKeys(capture, path, SQL_CAPTURE_ALLOWED_KEYS, 'SQL capture policy', add);
  if (typeof capture.sqlText !== 'string' || !SQL_TEXT_CAPTURE_VALUES.has(capture.sqlText)) add(`${path}.sqlText`, 'sqlText capture mode is unsupported');
  if (typeof capture.params !== 'string' || !SQL_PARAM_CAPTURE_VALUES.has(capture.params)) add(`${path}.params`, 'params capture mode is unsupported');
  if (typeof capture.diagnostics !== 'string' || !SQL_DIAGNOSTIC_CAPTURE_VALUES.has(capture.diagnostics)) add(`${path}.diagnostics`, 'diagnostics capture mode is unsupported');
  if (typeof capture.resultRows !== 'string' || !SQL_RESULT_ROW_CAPTURE_VALUES.has(capture.resultRows)) add(`${path}.resultRows`, 'resultRows capture mode is unsupported');
  if (typeof capture.plans !== 'string' || !SQL_PLAN_CAPTURE_VALUES.has(capture.plans)) add(`${path}.plans`, 'plans capture mode is unsupported');
  if (typeof capture.planDetail !== 'string' || !SQL_PLAN_DETAIL_VALUES.has(capture.planDetail)) add(`${path}.planDetail`, 'planDetail capture mode is unsupported');
  if (typeof capture.relationAccess !== 'string' || !SQL_RELATION_CAPTURE_VALUES.has(capture.relationAccess)) add(`${path}.relationAccess`, 'relationAccess capture mode is unsupported');
  if (!isNonNegativeFinite(capture.maxRowsPerResult)) add(`${path}.maxRowsPerResult`, 'maxRowsPerResult must be a non-negative finite number');
  if (!isNonNegativeFinite(capture.maxCellBytes)) add(`${path}.maxCellBytes`, 'maxCellBytes must be a non-negative finite number');
  if (capture.maxTraceBytes !== undefined && !isNonNegativeFinite(capture.maxTraceBytes)) add(`${path}.maxTraceBytes`, 'maxTraceBytes must be a non-negative finite number');
  if (!isRecord(capture.hashes)) {
    add(`${path}.hashes`, 'hash policy is required');
    return;
  }
  validateObjectKeys(capture.hashes, `${path}.hashes`, SQL_HASH_ALLOWED_KEYS, 'SQL hash policy', add);
  if (typeof capture.hashes.sql !== 'string' || !SQL_HASH_SQL_VALUES.has(capture.hashes.sql)) add(`${path}.hashes.sql`, 'SQL hash mode is unsupported');
  if (typeof capture.hashes.params !== 'string' || !SQL_HASH_PARAM_VALUES.has(capture.hashes.params)) add(`${path}.hashes.params`, 'parameter hash mode is unsupported');
  if (typeof capture.hashes.plans !== 'string' || !SQL_HASH_PLAN_VALUES.has(capture.hashes.plans)) add(`${path}.hashes.plans`, 'plan hash mode is unsupported');
}

function validateObjectKeys(
  value: Record<string, unknown>,
  path: string,
  allowedKeys: ReadonlySet<string>,
  label: string,
  add: (path: string, message: string) => void
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      add(`${path}.${key}`, `unknown ${label} field "${key}"`);
    }
  }
}

function isNonNegativeFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateAllowedKeys(
  value: Record<string, unknown>,
  path: string,
  allowedKeys: ReadonlySet<string>,
  add: (path: string, message: string) => void
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      add(`${path}.${key}`, `unknown SQL trace event field "${key}"`);
    }
  }
}

function normalizeCaptureForValidation(value: unknown): SqlTraceCapturePolicy {
  return isRecord(value) ? normalizeSqlTraceCapturePolicy(value as SqlTraceCapturePolicyOptions) : DEFAULT_CAPTURE;
}

function validateBatchEvent(
  event: Record<string, unknown>,
  path: string,
  capture: SqlTraceCapturePolicy,
  batchIds: Set<string>,
  batchStatuses: Map<string, { path: string; status: 'ok' | 'error' | 'timeout' }>,
  add: (path: string, message: string) => void
): void {
  if (typeof event.batchId !== 'string' || event.batchId.length === 0) {
    add(`${path}.batchId`, 'batchId is required');
  } else if (batchIds.has(event.batchId)) {
    add(`${path}.batchId`, `duplicate batchId "${event.batchId}"`);
  } else {
    batchIds.add(event.batchId);
    if (event.status === 'ok' || event.status === 'error' || event.status === 'timeout') {
      batchStatuses.set(event.batchId, { path, status: event.status });
    }
  }
  if (typeof event.api !== 'string' || !SQL_BATCH_APIS.has(event.api as SqlBatchApi)) {
    add(`${path}.api`, 'batch api is unsupported');
  }
  if (event.status !== 'ok' && event.status !== 'error' && event.status !== 'timeout') {
    add(`${path}.status`, 'batch status must be ok, error, or timeout');
  }
  if (typeof event.timingSource === 'string' && !SQL_TIMING_SOURCES.has(event.timingSource as SqlTimingSource)) {
    add(`${path}.timingSource`, 'batch timingSource is unsupported');
  }
  if (event.timing !== undefined) validateTiming(event.timing, `${path}.timing`, add);
  validateCapturedSqlText(event.sql, `${path}.sql`, capture, add);
}

function validateStatementEvent(
  event: Record<string, unknown>,
  path: string,
  capture: SqlTraceCapturePolicy,
  statementIds: Set<string>,
  statementStatuses: Map<string, { path: string; status: 'ok' | 'error' | 'timeout' }>,
  add: (path: string, message: string) => void
): void {
  if (typeof event.statementId !== 'string' || event.statementId.length === 0) {
    add(`${path}.statementId`, 'statementId is required');
  } else if (statementIds.has(event.statementId)) {
    add(`${path}.statementId`, `duplicate statementId "${event.statementId}"`);
  } else {
    statementIds.add(event.statementId);
    if (event.status === 'ok' || event.status === 'error' || event.status === 'timeout') {
      statementStatuses.set(event.statementId, { path, status: event.status });
    }
  }
  if (typeof event.api !== 'string' || !SQL_STATEMENT_APIS.has(event.api as SqlStatementApi)) {
    add(`${path}.api`, 'statement api is unsupported');
  }
  if (typeof event.timingSource === 'string' && !SQL_TIMING_SOURCES.has(event.timingSource as SqlTimingSource)) {
    add(`${path}.timingSource`, 'statement timingSource is unsupported');
  }
  if (event.timing !== undefined) validateTiming(event.timing, `${path}.timing`, add);
  if (event.status !== 'ok' && event.status !== 'error' && event.status !== 'timeout') {
    add(`${path}.status`, 'statement status must be ok, error, or timeout');
  }
  if (
    event.transactionContext !== undefined &&
    event.transactionContext !== 'autocommit-implicit' &&
    event.transactionContext !== 'explicit-sql' &&
    event.transactionContext !== 'api-wrapper' &&
    event.transactionContext !== 'unknown'
  ) {
    add(`${path}.transactionContext`, 'statement transactionContext is unsupported');
  }
  const sql = isRecord(event.sql) ? event.sql : null;
  if (!sql) {
    add(`${path}.sql`, 'statement sql metadata is required');
    return;
  }
  validateCapturedSqlText(sql, `${path}.sql`, capture, add);
  validateStatementSummary(event.summary, `${path}.summary`, add);
  if (typeof sql.operation === 'string' && !SQL_OPERATIONS.has(sql.operation as SqlOperation)) {
    add(`${path}.sql.operation`, `unsupported SQL operation "${sql.operation}"`);
  }
  if (
    typeof sql.operationSource === 'string' &&
    sql.operationSource !== 'parser' &&
    sql.operationSource !== 'regex' &&
    sql.operationSource !== 'engine' &&
    sql.operationSource !== 'unknown'
  ) {
    add(`${path}.sql.operationSource`, 'operationSource is unsupported');
  }
  if (
    typeof sql.operationConfidence === 'string' &&
    sql.operationConfidence !== 'high' &&
    sql.operationConfidence !== 'medium' &&
    sql.operationConfidence !== 'low'
  ) {
    add(`${path}.sql.operationConfidence`, 'operationConfidence is unsupported');
  }
  if (capture.params === 'none' && Array.isArray(event.params) && event.params.length > 0) {
    add(`${path}.params`, 'parameter capture is disabled but params are present');
  }
  if (event.params !== undefined && !Array.isArray(event.params)) {
    add(`${path}.params`, 'params must be an array when present');
  }
  if (Array.isArray(event.params)) {
    event.params.forEach((param, paramIndex) => validateSqlParam(param, `${path}.params[${paramIndex}]`, capture, add));
  }
  if ((capture.params === 'types' || capture.params === 'redacted') && Array.isArray(event.params)) {
    event.params.forEach((param, paramIndex) => {
      if (isRecord(param) && 'valuePreview' in param) {
        add(`${path}.params[${paramIndex}].valuePreview`, 'full parameter value is present while params are redacted');
      }
      if (isRecord(param) && capture.hashes.params === 'none' && typeof param.valueHash === 'string') {
        add(`${path}.params[${paramIndex}].valueHash`, 'parameter hash is present while parameter hashes are disabled');
      }
    });
  }
}

function validateCapturedSqlText(
  sql: unknown,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(sql)) {
    add(path, 'SQL capture metadata is required');
    return;
  }
  validateObjectKeys(sql, path, SQL_CAPTURED_TEXT_ALLOWED_KEYS, 'SQL capture metadata', add);
  if (typeof sql.dialect !== 'string' || !SQL_DIALECTS.has(sql.dialect as SqlDialect)) {
    add(`${path}.dialect`, 'SQL dialect is unsupported');
  }
  if (capture.sqlText === 'none' && (typeof sql.text === 'string' || typeof sql.redactedText === 'string')) {
    add(path, 'sql text capture is disabled but text is present');
  }
  if (capture.sqlText === 'redacted' && typeof sql.text === 'string') {
    add(`${path}.text`, 'full sql text is present while capture.sqlText is redacted');
  }
  if (capture.hashes.sql === 'none' && (typeof sql.hash === 'string' || typeof sql.normalizedHash === 'string')) {
    add(path, 'SQL hash is present while SQL hashes are disabled');
  }
  if (capture.hashes.sql === 'normalized-redacted' && typeof sql.hash === 'string') {
    add(`${path}.hash`, 'raw SQL hash is present while only normalized redacted hashes are enabled');
  }
}

function validateSourceSpan(
  sourceSpan: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(sourceSpan)) {
    add(path, 'sourceSpan must be an object');
    return;
  }
  validateObjectKeys(sourceSpan, path, SQL_SOURCE_SPAN_ALLOWED_KEYS, 'SQL sourceSpan', add);
  validateSourcePosition(sourceSpan.start, `${path}.start`, add);
  validateSourcePosition(sourceSpan.end, `${path}.end`, add);
}

function validateSourcePosition(
  position: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(position)) {
    add(path, 'source position must be an object');
    return;
  }
  validateObjectKeys(position, path, SQL_SOURCE_POSITION_ALLOWED_KEYS, 'SQL source position', add);
  if (typeof position.offset !== 'number' || !Number.isInteger(position.offset) || position.offset < 0) {
    add(`${path}.offset`, 'source position offset must be a non-negative integer');
  }
  if (position.line !== undefined && (typeof position.line !== 'number' || !Number.isInteger(position.line) || position.line < 1)) {
    add(`${path}.line`, 'source position line must be a positive integer');
  }
  if (position.column !== undefined && (typeof position.column !== 'number' || !Number.isInteger(position.column) || position.column < 1)) {
    add(`${path}.column`, 'source position column must be a positive integer');
  }
}

function validateStatementSummary(
  summary: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (summary === undefined) return;
  if (!isRecord(summary)) {
    add(path, 'statement summary must be an object');
    return;
  }
  validateObjectKeys(summary, path, SQL_STATEMENT_SUMMARY_ALLOWED_KEYS, 'SQL statement summary', add);
  for (const key of SQL_STATEMENT_SUMMARY_ALLOWED_KEYS) {
    if (summary[key] !== undefined && !isNonNegativeFinite(summary[key])) {
      add(`${path}.${key}`, `${key} must be a non-negative finite number`);
    }
  }
}

function validateSqlParam(
  param: unknown,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(param)) {
    add(path, 'SQL parameter must be an object');
    return;
  }
  validateObjectKeys(param, path, SQL_PARAM_ALLOWED_KEYS, 'SQL parameter', add);
  if (param.position !== undefined && (typeof param.position !== 'number' || !Number.isInteger(param.position) || param.position < 1)) {
    add(`${path}.position`, 'parameter position must be a positive integer');
  }
  if (param.name !== undefined && typeof param.name !== 'string') add(`${path}.name`, 'parameter name must be a string');
  if (param.redacted !== true && param.redacted !== false) add(`${path}.redacted`, 'parameter redacted must be a boolean');
  if (param.type !== undefined) validateSqlParamType(param.type, `${path}.type`, add);
  if (param.valuePreview !== undefined) validateSqlScalar(param.valuePreview, `${path}.valuePreview`, add);
  if (param.valueHash !== undefined && typeof param.valueHash !== 'string') add(`${path}.valueHash`, 'parameter valueHash must be a string');
  if (param.byteLength !== undefined && !isNonNegativeFinite(param.byteLength)) add(`${path}.byteLength`, 'parameter byteLength must be a non-negative finite number');
  if (param.truncated !== undefined && typeof param.truncated !== 'boolean') add(`${path}.truncated`, 'parameter truncated must be a boolean');
  if (capture.params === 'redacted' && param.byteLength !== undefined) {
    add(`${path}.byteLength`, 'redacted parameter capture must not include byteLength');
  }
}

function validateSqlParamType(
  type: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(type)) {
    add(path, 'parameter type must be an object');
    return;
  }
  validateObjectKeys(type, path, SQL_PARAM_TYPE_ALLOWED_KEYS, 'SQL parameter type', add);
  if (type.dialectTypeName !== undefined && typeof type.dialectTypeName !== 'string') add(`${path}.dialectTypeName`, 'parameter dialectTypeName must be a string');
  if (type.pgTypeId !== undefined && !isNonNegativeFinite(type.pgTypeId)) add(`${path}.pgTypeId`, 'parameter pgTypeId must be a non-negative finite number');
}

function validateResultEvent(
  event: Record<string, unknown>,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  const rows = isRecord(event.rows) ? event.rows : null;
  if (!rows || !Array.isArray(rows.values)) {
    add(`${path}.rows`, 'result rows metadata is required');
    return;
  }
  validateObjectKeys(rows, `${path}.rows`, SQL_RESULT_ROWS_ALLOWED_KEYS, 'SQL result rows', add);
  if (event.fieldsSource !== 'engine' && event.fieldsSource !== 'row-shape' && event.fieldsSource !== 'unknown') {
    add(`${path}.fieldsSource`, 'result fieldsSource is required');
  }
  if (!Array.isArray(event.fields)) {
    add(`${path}.fields`, 'result fields must be an array');
  } else {
    event.fields.forEach((field, index) => validateResultField(field, `${path}.fields[${index}]`, add));
  }
  if (rows.mode !== 'object' && rows.mode !== 'array') {
    add(`${path}.rows.mode`, 'result row mode must be object or array');
  }
  if (rows.mode === 'object' && rows.values.some((row) => Array.isArray(row))) {
    add(`${path}.rows.mode`, 'object result row mode cannot contain array rows');
  }
  if (rows.mode === 'array' && rows.values.some((row) => !Array.isArray(row))) {
    add(`${path}.rows.mode`, 'array result row mode cannot contain object rows');
  }
  if (capture.resultRows === 'none' && rows.values.length > 0) {
    add(`${path}.rows.values`, 'result row capture is disabled but rows are present');
  }
  if (rows.values.length > capture.maxRowsPerResult) {
    add(`${path}.rows.values`, `captured rows exceed maxRowsPerResult ${capture.maxRowsPerResult}`);
  }
  rows.values.forEach((row, rowIndex) => {
    validateResultRow(row, `${path}.rows.values[${rowIndex}]`, rows.mode as 'object' | 'array', capture, add);
  });
}

function validateErrorEvent(
  event: Record<string, unknown>,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (typeof event.message !== 'string') add(`${path}.message`, 'error message is required');
  if (capture.diagnostics === 'none' && event.message !== '<redacted>') {
    add(`${path}.message`, 'diagnostics capture is disabled but message is present');
  }
  if (
    capture.diagnostics === 'none' &&
    (
      typeof event.detail === 'string' ||
      typeof event.hint === 'string' ||
      typeof event.position === 'number' ||
      typeof event.schemaName === 'string' ||
      typeof event.tableName === 'string' ||
      typeof event.columnName === 'string' ||
      typeof event.constraintName === 'string' ||
      typeof event.dataTypeName === 'string'
    )
  ) {
    add(path, 'diagnostics capture is disabled but diagnostic fields are present');
  }
  if (capture.diagnostics !== 'full' && (typeof event.detail === 'string' || typeof event.hint === 'string')) {
    add(path, 'diagnostic detail and hint require full diagnostics capture');
  }
}

function validateTimeoutEvent(
  event: Record<string, unknown>,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (typeof event.timeoutMs !== 'number' || !Number.isFinite(event.timeoutMs) || event.timeoutMs < 0) {
    add(`${path}.timeoutMs`, 'timeoutMs must be a non-negative finite number');
  }
  if (event.elapsedMs !== undefined && !isNonNegativeFinite(event.elapsedMs)) {
    add(`${path}.elapsedMs`, 'elapsedMs must be a non-negative finite number');
  }
}

function validateCapturedCellSizes(
  value: unknown,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateCapturedCellSizes(child, `${path}[${index}]`, capture, add));
    return;
  }
  if (!isRecord(value)) return;
  if ('value' in value) {
    const cellValue = value.value;
    if (typeof cellValue === 'string' && byteLength(cellValue) > capture.maxCellBytes) {
      add(`${path}.value`, 'captured string exceeds maxCellBytes');
    }
    if (isRecord(cellValue) && cellValue.kind === 'json' && typeof cellValue.preview === 'string' && byteLength(cellValue.preview) > capture.maxCellBytes) {
      add(`${path}.value.preview`, 'captured JSON preview exceeds maxCellBytes');
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    validateCapturedCellSizes(child, `${path}.${key}`, capture, add);
  }
}

function validateResultRow(
  row: unknown,
  path: string,
  mode: 'object' | 'array',
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (mode === 'array') {
    if (!Array.isArray(row)) return;
    row.forEach((cell, index) => validateSqlCell(cell, `${path}[${index}]`, capture, add));
    return;
  }
  if (!isRecord(row)) return;
  for (const [key, cell] of Object.entries(row)) {
    validateSqlCell(cell, `${path}.${key}`, capture, add);
  }
}

function validateSqlCell(
  cell: unknown,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(cell)) {
    add(path, 'SQL cell must be an object');
    return;
  }
  validateObjectKeys(cell, path, SQL_CELL_ALLOWED_KEYS, 'SQL cell', add);
  if (cell.value !== undefined) validateSqlScalar(cell.value, `${path}.value`, add);
  if (cell.redacted !== undefined && typeof cell.redacted !== 'boolean') add(`${path}.redacted`, 'SQL cell redacted must be a boolean');
  if (cell.truncated !== undefined && typeof cell.truncated !== 'boolean') add(`${path}.truncated`, 'SQL cell truncated must be a boolean');
  validateCapturedCellSizes(cell, path, capture, add);
}

function validateSqlScalar(
  scalar: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (scalar === null || typeof scalar === 'string' || typeof scalar === 'boolean') return;
  if (typeof scalar === 'number') {
    if (!Number.isFinite(scalar)) add(path, 'SQL scalar number must be finite');
    return;
  }
  if (!isRecord(scalar)) {
    add(path, 'SQL scalar must be null, string, number, boolean, or a known scalar object');
    return;
  }
  const kind = scalar.kind;
  if (typeof kind !== 'string' || !(kind in SQL_SCALAR_OBJECT_ALLOWED_KEYS)) {
    add(`${path}.kind`, 'SQL scalar object kind is unsupported');
    return;
  }
  validateObjectKeys(scalar, path, SQL_SCALAR_OBJECT_ALLOWED_KEYS[kind], 'SQL scalar', add);
  if (kind === 'bigint' && typeof scalar.text !== 'string') add(`${path}.text`, 'bigint scalar text must be a string');
  if (kind === 'bytes') {
    if (!isNonNegativeFinite(scalar.byteLength)) add(`${path}.byteLength`, 'bytes scalar byteLength must be a non-negative finite number');
    if ('hash' in scalar) add(`${path}.hash`, 'bytes scalar hash is not supported by the V1 hash policy');
  }
  if (kind === 'json') {
    if (typeof scalar.preview !== 'string') add(`${path}.preview`, 'json scalar preview must be a string');
    if (typeof scalar.truncated !== 'boolean') add(`${path}.truncated`, 'json scalar truncated must be a boolean');
  }
}

function validateTiming(
  timing: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(timing)) {
    add(path, 'timing must be an object');
    return;
  }
  validateObjectKeys(timing, path, SQL_TIMING_ALLOWED_KEYS, 'SQL timing', add);
  for (const key of ['startTimeMs', 'endTimeMs', 'durationMs'] as const) {
    if (timing[key] !== undefined && !isNonNegativeFinite(timing[key])) {
      add(`${path}.${key}`, `${key} must be a non-negative finite number`);
    }
  }
  if (
    isNonNegativeFinite(timing.startTimeMs) &&
    isNonNegativeFinite(timing.endTimeMs) &&
    (timing.endTimeMs as number) < (timing.startTimeMs as number)
  ) {
    add(`${path}.endTimeMs`, 'endTimeMs must be greater than or equal to startTimeMs');
  }
}

function validateResultField(
  field: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(field)) {
    add(path, 'result field must be an object');
    return;
  }
  if (typeof field.name !== 'string' || field.name.length === 0) add(`${path}.name`, 'result field name is required');
  if (typeof field.ordinal !== 'number' || !Number.isInteger(field.ordinal) || field.ordinal < 0) {
    add(`${path}.ordinal`, 'result field ordinal must be a non-negative integer');
  }
  if (field.pgTypeId !== undefined && !isNonNegativeFinite(field.pgTypeId)) add(`${path}.pgTypeId`, 'result field pgTypeId must be a non-negative finite number');
  if (field.dialectTypeName !== undefined && typeof field.dialectTypeName !== 'string') add(`${path}.dialectTypeName`, 'result field dialectTypeName must be a string');
  if (field.nullable !== undefined && typeof field.nullable !== 'boolean') add(`${path}.nullable`, 'result field nullable must be a boolean');
}

function validatePlanEvent(
  event: Record<string, unknown>,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (capture.plans === 'none') {
    add(path, 'plan event is present while plan capture is disabled');
  }
  if (event.source !== 'explain-json' && event.source !== 'engine' && event.source !== 'other') {
    add(`${path}.source`, 'plan source is unsupported');
  }
  if (event.mode !== 'estimate' && event.mode !== 'analyze') {
    add(`${path}.mode`, 'plan mode is unsupported');
  }
  if (event.mode === 'analyze' && capture.plans !== 'analyze') {
    add(`${path}.mode`, 'EXPLAIN ANALYZE plan capture is not enabled');
  }
  if (event.mode === 'analyze' && event.safeToExecute !== true) {
    add(`${path}.safeToExecute`, 'analyze plans must explicitly acknowledge safeToExecute');
  }
  if (event.requestedBy !== 'user' && event.requestedBy !== 'harness') {
    add(`${path}.requestedBy`, 'plan requestedBy must be user or harness');
  }
  if (event.safeToExecute !== true && event.safeToExecute !== false) {
    add(`${path}.safeToExecute`, 'plan safeToExecute must be a boolean');
  }
  if (event.targetStatementExecuted !== undefined && typeof event.targetStatementExecuted !== 'boolean') {
    add(`${path}.targetStatementExecuted`, 'plan targetStatementExecuted must be a boolean');
  }
  if (event.diagnosticStatementExecuted !== undefined && typeof event.diagnosticStatementExecuted !== 'boolean') {
    add(`${path}.diagnosticStatementExecuted`, 'plan diagnosticStatementExecuted must be a boolean');
  }
  if (
    event.sideEffectRisk !== undefined &&
    event.sideEffectRisk !== 'planner-only' &&
    event.sideEffectRisk !== 'executes-target' &&
    event.sideEffectRisk !== 'unknown'
  ) {
    add(`${path}.sideEffectRisk`, 'plan sideEffectRisk is unsupported');
  }
  if (event.timing !== undefined) validateTiming(event.timing, `${path}.timing`, add);
  if (event.summary !== undefined) validatePlanSummary(event.summary, `${path}.summary`, add);
  if (event.rawPlan !== undefined && !isRecord(event.rawPlan)) {
    add(`${path}.rawPlan`, 'rawPlan must be an object when present');
  }
  if (isRecord(event.rawPlan)) {
    validateObjectKeys(event.rawPlan, `${path}.rawPlan`, SQL_RAW_PLAN_ALLOWED_KEYS, 'SQL raw plan', add);
    if (event.rawPlan.format !== 'json') add(`${path}.rawPlan.format`, 'raw plan format must be json');
    if (event.rawPlan.hash !== undefined && typeof event.rawPlan.hash !== 'string') add(`${path}.rawPlan.hash`, 'raw plan hash must be a string');
    if (event.rawPlan.truncated !== undefined && typeof event.rawPlan.truncated !== 'boolean') add(`${path}.rawPlan.truncated`, 'raw plan truncated must be a boolean');
  }
  if (isRecord(event.rawPlan) && capture.planDetail === 'summary' && capture.hashes.plans === 'none') {
    add(`${path}.rawPlan`, 'raw plan metadata is present while plan detail and plan hashes are disabled');
  }
  if (isRecord(event.rawPlan) && capture.hashes.plans === 'none' && typeof event.rawPlan.hash === 'string') {
    add(`${path}.rawPlan.hash`, 'raw plan hash is present while plan hashes are disabled');
  }
  if (isRecord(event.rawPlan) && 'value' in event.rawPlan && capture.planDetail === 'summary') {
    add(`${path}.rawPlan.value`, 'raw plan value is present while plan detail is summary-only');
  }
  if (isRecord(event.rawPlan) && 'value' in event.rawPlan && capture.planDetail === 'raw-capped') {
    const rawPlanBytes = byteLength(stablePreview(event.rawPlan.value));
    if (rawPlanBytes > capture.maxCellBytes) {
      add(`${path}.rawPlan.value`, 'raw plan payload exceeds maxCellBytes in raw-capped mode');
    }
  }
}

function validateRelationAccessEvent(
  event: Record<string, unknown>,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (capture.relationAccess === 'none') {
    add(path, 'relation-access event is present while relation access capture is disabled');
  }
  if (capture.relationAccess === 'parser' && event.source !== 'parser') {
    add(`${path}.source`, 'relation-access source must be parser when capture.relationAccess is parser');
  }
  if (capture.relationAccess === 'explain' && event.source !== 'explain') {
    add(`${path}.source`, 'relation-access source must be explain when capture.relationAccess is explain');
  }
  if (
    event.source !== 'parser' &&
    event.source !== 'explain' &&
    event.source !== 'live-extension' &&
    event.source !== 'engine-hook' &&
    event.source !== 'manual'
  ) {
    add(`${path}.source`, 'relation-access source is required');
  }
  if (event.confidence !== 'high' && event.confidence !== 'medium' && event.confidence !== 'low') {
    add(`${path}.confidence`, 'relation-access confidence is required');
  }
  if (!Array.isArray(event.accesses)) add(`${path}.accesses`, 'relation-access accesses must be an array');
  if (Array.isArray(event.accesses)) {
    event.accesses.forEach((access, index) => validateRelationAccess(access, `${path}.accesses[${index}]`, add));
  }
}

function validatePlanSummary(
  summary: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(summary)) {
    add(path, 'plan summary must be an object');
    return;
  }
  validateObjectKeys(summary, path, SQL_PLAN_SUMMARY_ALLOWED_KEYS, 'SQL plan summary', add);
  if (summary.rootNodeType !== undefined && typeof summary.rootNodeType !== 'string') add(`${path}.rootNodeType`, 'plan rootNodeType must be a string');
  if (summary.estimatedRows !== undefined && !isNonNegativeFinite(summary.estimatedRows)) add(`${path}.estimatedRows`, 'plan estimatedRows must be a non-negative finite number');
  if (summary.estimatedTotalCost !== undefined && !isNonNegativeFinite(summary.estimatedTotalCost)) add(`${path}.estimatedTotalCost`, 'plan estimatedTotalCost must be a non-negative finite number');
  if (summary.relations !== undefined) {
    if (!Array.isArray(summary.relations)) {
      add(`${path}.relations`, 'plan summary relations must be an array');
    } else {
      summary.relations.forEach((access, index) => validateRelationAccess(access, `${path}.relations[${index}]`, add));
    }
  }
}

function validateTransactionEvent(
  event: Record<string, unknown>,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (typeof event.transactionId !== 'string' || event.transactionId.length === 0) {
    add(`${path}.transactionId`, 'transaction events must include transactionId');
  }
  if (
    event.action !== 'begin' &&
    event.action !== 'commit' &&
    event.action !== 'rollback' &&
    event.action !== 'savepoint' &&
    event.action !== 'release' &&
    event.action !== 'rollback-to'
  ) {
    add(`${path}.action`, 'transaction action is unsupported');
  }
  if (event.source !== 'sql' && event.source !== 'api' && event.source !== 'implicit') {
    add(`${path}.source`, 'transaction source is unsupported');
  }
  if (event.status !== undefined && event.status !== 'ok' && event.status !== 'error') {
    add(`${path}.status`, 'transaction status must be ok or error');
  }
  if (
    event.reason !== undefined &&
    event.reason !== 'callback-rejected' &&
    event.reason !== 'statement-error' &&
    event.reason !== 'manual' &&
    event.reason !== 'unknown'
  ) {
    add(`${path}.reason`, 'transaction reason is unsupported');
  }
}

function validateNoticeEvent(
  event: Record<string, unknown>,
  path: string,
  capture: SqlTraceCapturePolicy,
  add: (path: string, message: string) => void
): void {
  if (typeof event.message !== 'string') add(`${path}.message`, 'notice message is required');
  if (capture.diagnostics === 'none' && event.message !== '<redacted>') {
    add(`${path}.message`, 'diagnostics capture is disabled but notice message is present');
  }
  if (capture.diagnostics !== 'full' && (typeof event.detail === 'string' || typeof event.hint === 'string')) {
    add(path, 'notice detail and hint require full diagnostics capture');
  }
}

function validateRelationAccess(
  access: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (!isRecord(access)) {
    add(path, 'relation access must be an object');
    return;
  }
  validateObjectKeys(access, path, SQL_RELATION_ACCESS_ALLOWED_KEYS, 'SQL relation access', add);
  if (!isRecord(access.relation) || typeof access.relation.name !== 'string' || access.relation.name.length === 0) {
    add(`${path}.relation`, 'relation access must include a relation name');
  } else {
    validateRelation(access.relation, `${path}.relation`, add);
  }
  if (
    access.access !== 'read' &&
    access.access !== 'write' &&
    access.access !== 'insert' &&
    access.access !== 'update' &&
    access.access !== 'delete' &&
    access.access !== 'ddl' &&
    access.access !== 'index-read' &&
    access.access !== 'unknown'
  ) {
    add(`${path}.access`, 'relation access type is unsupported');
  }
  if (access.columns !== undefined) {
    if (!Array.isArray(access.columns) || access.columns.some((column) => typeof column !== 'string')) {
      add(`${path}.columns`, 'relation access columns must be an array of strings');
    }
  }
  if (access.via !== undefined && typeof access.via !== 'string') add(`${path}.via`, 'relation access via must be a string');
}

function validateRelation(
  relation: Record<string, unknown>,
  path: string,
  add: (path: string, message: string) => void
): void {
  validateObjectKeys(relation, path, SQL_RELATION_ALLOWED_KEYS, 'SQL relation', add);
  if (typeof relation.schema !== 'undefined' && typeof relation.schema !== 'string') add(`${path}.schema`, 'relation schema must be a string');
  if (typeof relation.name !== 'string' || relation.name.length === 0) add(`${path}.name`, 'relation name is required');
  if (
    relation.kind !== 'table' &&
    relation.kind !== 'view' &&
    relation.kind !== 'materialized-view' &&
    relation.kind !== 'index' &&
    relation.kind !== 'cte' &&
    relation.kind !== 'unknown'
  ) {
    add(`${path}.kind`, 'relation kind is unsupported');
  }
}

function validateSemanticPayload(
  value: unknown,
  path: string,
  add: (path: string, message: string) => void
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateSemanticPayload(child, `${path}[${index}]`, add));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SEMANTIC_KEYS.has(key)) {
      add(childPath, `forbidden SQL trace semantic key "${key}"`);
      continue;
    }
    if ((key === 'kind' || key === 'type' || key === 'category') && typeof child === 'string' && SEMANTIC_TOKENS.has(child)) {
      add(childPath, `forbidden SQL trace semantic token "${child}"`);
      continue;
    }
    if (childPath.includes('.rows.values.') || childPath.endsWith('.sql.text') || childPath.endsWith('.sql.redactedText') || childPath.endsWith('.message')) continue;
    validateSemanticPayload(child, childPath, add);
  }
}

export function assertValidSqlTrace(value: unknown, label = 'sql trace'): asserts value is SqlTrace {
  const validation = validateSqlTrace(value);
  if (!validation.valid) {
    throw new Error(
      `${label} is invalid:\n${validation.errors.map((error) => `${error.path}: ${error.message}`).join('\n')}`
    );
  }
}

export function inferPgliteSqlPersistence(dataDir: string | undefined): SqlPersistence {
  if (!dataDir || dataDir === ':memory:' || dataDir.startsWith('memory://')) return 'memory';
  if (dataDir.startsWith('idb://')) return 'indexeddb';
  if (dataDir.startsWith('opfs://')) return 'opfs';
  if (dataDir.startsWith('file://') || !/^[a-z][a-z0-9+.-]*:\/\//i.test(dataDir)) return 'file';
  return 'unknown';
}

export function createPgliteSqlTraceClient<TClient extends SqlClientLike>(
  client: TClient,
  options: PgliteSqlTraceClientOptions = {}
): TracedSqlClient<TClient> {
  const capabilities = Array.from(new Set([
    ...PGLITE_SQL_TRACE_CAPABILITIES,
    ...(options.capture?.plans === 'estimate' || options.capture?.plans === 'analyze' ? ['explain-json' as const] : []),
    ...(options.capabilities ?? []),
    ...(options.engine?.capabilities ?? []),
  ]));

  return createSqlTraceClient(client, {
    ...options,
    engine: {
      ...options.engine,
      kind: 'pglite',
      dialect: 'postgres',
      persistence: options.persistence ?? options.engine?.persistence ?? inferPgliteSqlPersistence(options.dataDir),
      capabilities,
    },
  });
}

export function createSqlTraceClient<TClient extends SqlClientLike>(
  client: TClient,
  options: SqlTraceClientOptions = {}
): TracedSqlClient<TClient> {
  const trace = createEmptySqlTrace(options);
  const now = options.now ?? (() => Date.now());
  let nextOrdinal = 0;
  let nextEventNumber = 0;
  let nextStatementNumber = 0;
  let nextTransactionNumber = 0;
  let nextBatchNumber = 0;
  let activeSqlTransactionId: string | undefined;

  const nextEventId = () => {
    nextEventNumber += 1;
    return `${trace.runId}:event:${nextEventNumber}`;
  };
  const nextStatementId = () => {
    nextStatementNumber += 1;
    return `${trace.runId}:statement:${nextStatementNumber}`;
  };
  const nextTransactionId = () => {
    nextTransactionNumber += 1;
    return `${trace.runId}:transaction:${nextTransactionNumber}`;
  };
  const nextBatchId = () => {
    nextBatchNumber += 1;
    return `${trace.runId}:batch:${nextBatchNumber}`;
  };
  const push = (event: any): SqlTraceEvent => {
    const nextEvent = {
      ...event,
      eventId: event.eventId ?? nextEventId(),
      runId: event.runId ?? trace.runId,
      ordinal: event.ordinal ?? nextOrdinal,
    } as unknown as SqlTraceEvent;
    nextOrdinal += 1;
    trace.events.push(nextEvent);
    options.onEvent?.(nextEvent);
    return nextEvent;
  };

  const recordStatement = async <TResult extends SqlClientResult>(
    sql: string,
    params: unknown[] | undefined,
    run: () => Promise<TResult>,
    recordOptions: {
      api: SqlStatementApi;
      file?: string;
      sourceSpan?: SqlSourceSpan;
      batchId?: string;
      statementIndex?: number;
      statementCountKnown?: number;
      transactionId?: string;
      timeoutMs?: number;
      timingSource?: SqlTimingSource;
      explain?: (explainSql: string, params: unknown[] | undefined) => Promise<SqlClientResult>;
    }
  ): Promise<TResult> => {
    const statementId = nextStatementId();
    const startedAt = now();
    const operation = classifySqlOperation(sql);
    const transactionBoundary = parseSqlTransactionBoundary(sql);
    const paramsCapture = captureSqlParams(params, trace.capture, trace.runId);
    const beginSqlTransactionId = transactionBoundary?.action === 'begin' ? nextTransactionId() : undefined;
    const eventTransactionId = recordOptions.transactionId ?? activeSqlTransactionId ?? beginSqlTransactionId;
    const transactionContext = transactionContextFor(recordOptions.transactionId, activeSqlTransactionId ?? beginSqlTransactionId);
    const base = {
      statementId,
      batchId: recordOptions.batchId,
      transactionId: eventTransactionId,
      file: recordOptions.file ?? options.file,
      sourceSpan: recordOptions.sourceSpan,
    };

    try {
      const result = await withOptionalTimeout(run(), recordOptions.timeoutMs);
      const endedAt = now();
      const rows = Array.isArray(result.rows) ? result.rows : [];
      const statementEvent = push({
        kind: 'statement',
        ...compactBase(base),
        api: recordOptions.api,
        sql: captureStatementSql(sql, trace),
        ...(paramsCapture ? { params: paramsCapture } : {}),
        timing: { startTimeMs: startedAt, endTimeMs: endedAt, durationMs: Math.max(0, endedAt - startedAt) },
        timingSource: recordOptions.timingSource ?? 'measured',
        ...(recordOptions.statementIndex !== undefined ? { statementIndex: recordOptions.statementIndex } : {}),
        ...(recordOptions.statementCountKnown !== undefined ? { statementCountKnown: recordOptions.statementCountKnown } : {}),
        status: 'ok',
        transactionContext,
        summary: {
          ...(finiteNumber(result.affectedRows) !== undefined ? { affectedRows: result.affectedRows } : {}),
          returnedRowsKnown: rows.length,
          returnedRowsCaptured: trace.capture.resultRows === 'sampled' ? Math.min(rows.length, trace.capture.maxRowsPerResult) : 0,
          fieldsCount: Array.isArray(result.fields) ? result.fields.length : captureSqlFields(result.fields, rows).fields.length,
        },
      });
      recordSqlTransactionBoundary(sql, statementEvent, 'ok');
      if (shouldEmitResultEvent(result, trace.capture)) {
        push(captureSqlResult(result, {
          runId: trace.runId,
          eventId: nextEventId(),
          ordinal: nextOrdinal,
          statementId,
          capture: trace.capture,
          ...(recordOptions.batchId ? { batchId: recordOptions.batchId } : {}),
          ...(eventTransactionId ? { transactionId: eventTransactionId } : {}),
          ...(recordOptions.file ?? options.file ? { file: recordOptions.file ?? options.file } : {}),
          ...(recordOptions.sourceSpan ? { sourceSpan: recordOptions.sourceSpan } : {}),
          timestampMs: endedAt,
        }));
      }
      if (shouldCaptureEstimatePlan(sql, operation, trace, recordOptions)) {
        const planEvent = await captureEstimatePlan(sql, params, {
          explain: recordOptions.explain,
          runId: trace.runId,
          statementId,
          batchId: recordOptions.batchId,
          transactionId: eventTransactionId,
          file: recordOptions.file ?? options.file,
          sourceSpan: recordOptions.sourceSpan,
          eventId: nextEventId,
          ordinal: () => nextOrdinal,
          capture: trace.capture,
          now,
        });
        if (planEvent) push(planEvent);
      }
      return result;
    } catch (error) {
      const endedAt = now();
      const timeout = isSqlTimeoutError(error);
      const statementEvent = push({
        kind: 'statement',
        ...compactBase(base),
        api: recordOptions.api,
        sql: captureStatementSql(sql, trace),
        ...(paramsCapture ? { params: paramsCapture } : {}),
        timing: { startTimeMs: startedAt, endTimeMs: endedAt, durationMs: Math.max(0, endedAt - startedAt) },
        timingSource: recordOptions.timingSource ?? 'measured',
        ...(recordOptions.statementIndex !== undefined ? { statementIndex: recordOptions.statementIndex } : {}),
        ...(recordOptions.statementCountKnown !== undefined ? { statementCountKnown: recordOptions.statementCountKnown } : {}),
        status: timeout ? 'timeout' : 'error',
        transactionContext,
        summary: { returnedRowsKnown: 0, returnedRowsCaptured: 0, fieldsCount: 0 },
      });
      recordSqlTransactionBoundary(sql, statementEvent, timeout ? 'error' : 'error');
      if (timeout) {
        push({
          kind: 'timeout',
          ...compactBase(base),
          timeoutMs: recordOptions.timeoutMs ?? 0,
          elapsedMs: Math.max(0, endedAt - startedAt),
          cancelled: false,
          executionMayHaveContinued: true,
          reason: 'harness-timeout',
        });
      } else {
        push(sqlErrorFromUnknown(error, {
          runId: trace.runId,
          eventId: nextEventId(),
          ordinal: nextOrdinal,
          statementId,
          ...(recordOptions.batchId ? { batchId: recordOptions.batchId } : {}),
          ...(eventTransactionId ? { transactionId: eventTransactionId } : {}),
          ...(recordOptions.file ?? options.file ? { file: recordOptions.file ?? options.file } : {}),
          ...(recordOptions.sourceSpan ? { sourceSpan: recordOptions.sourceSpan } : {}),
          timestampMs: endedAt,
          diagnostics: trace.capture.diagnostics,
        }));
      }
      throw error;
    }
  };

  const recordSqlTransactionBoundary = (
    sql: string,
    statement: SqlTraceEvent,
    status: 'ok' | 'error'
  ): void => {
    if (statement.kind !== 'statement') return;
    const boundary = parseSqlTransactionBoundary(sql);
    if (!boundary) return;
    let transactionId = activeSqlTransactionId;
    if (boundary.action === 'begin' && typeof statement.transactionId === 'string') {
      transactionId = statement.transactionId;
    } else if (boundary.action === 'begin' || !transactionId) {
      transactionId = nextTransactionId();
    }
    push({
      kind: 'transaction',
      batchId: statement.batchId,
      statementId: statement.statementId,
      transactionId,
      action: boundary.action,
      source: 'sql',
      ...(boundary.name ? { name: boundary.name } : {}),
      status,
    });
    if (status !== 'ok') return;
    if (boundary.action === 'begin') {
      activeSqlTransactionId = transactionId;
    } else if (boundary.action === 'commit' || boundary.action === 'rollback') {
      activeSqlTransactionId = undefined;
    }
  };

  const recordExecBatch = async (
    wrappedClient: SqlClientLike,
    sql: string,
    execOptions: SqlTraceExecOptions & { clientOptions?: unknown },
    recordOptions: { transactionId?: string; timeoutMs?: number }
  ): Promise<SqlClientResult[]> => {
    if (typeof wrappedClient.exec !== 'function') {
      throw new Error('SQL client does not support exec');
    }
    const batchId = nextBatchId();
    const statements = splitSqlStatements(sql);
    const startedAt = now();
    try {
      const results = await withOptionalTimeout(wrappedClient.exec(sql, execOptions.clientOptions), recordOptions.timeoutMs);
      const endedAt = now();
      push({
        kind: 'batch',
        batchId,
        api: 'exec',
        sql: captureBatchSql(sql, trace),
        timing: { startTimeMs: startedAt, endTimeMs: endedAt, durationMs: Math.max(0, endedAt - startedAt) },
        timingSource: 'measured',
        status: 'ok',
        statementCountKnown: statements.length,
        ...(execOptions.file ?? options.file ? { file: execOptions.file ?? options.file } : {}),
      });
      for (const [index, result] of results.entries()) {
        const statement = statements[index] ?? {
          text: sql,
          sourceSpan: sourceSpanForOffsets(sql, 0, sql.length),
        };
        await recordStatement(
          statement.text,
          undefined,
          async () => result,
          {
            api: 'exec',
            batchId,
            statementIndex: index,
            statementCountKnown: statements.length,
            timingSource: 'posthoc',
            transactionId: recordOptions.transactionId,
            file: execOptions.file ?? options.file,
            sourceSpan: statement.sourceSpan,
            timeoutMs: recordOptions.timeoutMs,
          }
        );
      }
      return results;
    } catch (error) {
      const endedAt = now();
      const timeout = isSqlTimeoutError(error);
      push({
        kind: 'batch',
        batchId,
        api: 'exec',
        sql: captureBatchSql(sql, trace),
        timing: { startTimeMs: startedAt, endTimeMs: endedAt, durationMs: Math.max(0, endedAt - startedAt) },
        timingSource: 'measured',
        status: timeout ? 'timeout' : 'error',
        statementCountKnown: statements.length,
        ...(execOptions.file ?? options.file ? { file: execOptions.file ?? options.file } : {}),
      });
      if (timeout) {
        push({
          kind: 'timeout',
          batchId,
          timeoutMs: recordOptions.timeoutMs ?? 0,
          elapsedMs: Math.max(0, endedAt - startedAt),
          cancelled: false,
          executionMayHaveContinued: true,
          reason: 'harness-timeout',
        });
      } else {
        push(sqlErrorFromUnknown(error, {
          runId: trace.runId,
          eventId: nextEventId(),
          ordinal: nextOrdinal,
          batchId,
          ...(execOptions.file ?? options.file ? { file: execOptions.file ?? options.file } : {}),
          timestampMs: endedAt,
          diagnostics: trace.capture.diagnostics,
        }));
      }
      throw error;
    }
  };

  const wrap = <TWrapped extends SqlClientLike>(wrappedClient: TWrapped, transactionId?: string): TracedSqlClient<TWrapped> => ({
    client: wrappedClient,
    query: <T = unknown>(sql: string, params?: unknown[], clientOptions?: unknown) => recordStatement(
      sql,
      params,
      () => wrappedClient.query<T>(sql, params, clientOptions) as Promise<SqlClientResult & { rows?: T[] }>,
      {
        api: 'query',
        transactionId,
        explain: (explainSql, explainParams) => wrappedClient.query(explainSql, explainParams, clientOptions),
      }
    ),
    exec: async (sql, clientOptions) => {
      if (typeof wrappedClient.exec !== 'function') {
        throw new Error('SQL client does not support exec');
      }
      return recordExecBatch(wrappedClient, sql, { clientOptions }, { transactionId });
    },
    traceQuery: <T = unknown>(sql: string, queryOptions: SqlTraceQueryOptions = {}) => recordStatement(
      sql,
      queryOptions.params,
      () => wrappedClient.query<T>(sql, queryOptions.params, queryOptions.clientOptions) as Promise<SqlClientResult & { rows?: T[] }>,
      {
        api: queryOptions.api ?? 'query',
        transactionId,
        file: queryOptions.file,
        sourceSpan: queryOptions.sourceSpan,
        timeoutMs: queryOptions.timeoutMs,
        explain: (explainSql, explainParams) => wrappedClient.query(explainSql, explainParams, queryOptions.clientOptions),
      }
    ),
    traceExec: async (sql, execOptions = {}) => {
      if (typeof wrappedClient.exec !== 'function') {
        throw new Error('SQL client does not support exec');
      }
      return recordExecBatch(wrappedClient, sql, execOptions, { transactionId, timeoutMs: execOptions.timeoutMs });
    },
    transaction: async <T>(callback: (tx: TracedSqlClient<SqlClientLike>) => Promise<T>): Promise<T> => {
      if (typeof wrappedClient.transaction !== 'function') {
        throw new Error('SQL client does not support transaction');
      }
      const txId = nextTransactionId();
      push({
        kind: 'transaction',
        transactionId: txId,
        action: 'begin',
        source: 'api',
        status: 'ok',
      });
      try {
        const result = await wrappedClient.transaction((tx) => callback(wrap(tx, txId)));
        push({
          kind: 'transaction',
          transactionId: txId,
          action: 'commit',
          source: 'api',
          status: 'ok',
        });
        return result;
      } catch (error) {
        push({
          kind: 'transaction',
          transactionId: txId,
          action: 'rollback',
          source: 'api',
          status: 'ok',
          reason: 'callback-rejected',
        });
        throw error;
      }
    },
    getTrace: () => cloneSqlTrace(trace),
    clearTrace: () => {
      trace.events.length = 0;
      nextOrdinal = 0;
      nextEventNumber = 0;
      nextStatementNumber = 0;
      nextTransactionNumber = 0;
      nextBatchNumber = 0;
      activeSqlTransactionId = undefined;
    },
  });

  return wrap(client);
}

export async function runIsolatedSqlCases<TClient extends SqlClientLike>(
  request: RunIsolatedSqlCasesRequest<TClient>
): Promise<SqlRunResult> {
  const isolation = request.isolation ?? 'fresh-database';
  if (isolation !== 'fresh-database') {
    throw new Error(`Unsupported SQL run isolation mode: ${isolation}`);
  }
  if (!Array.isArray(request.cases) || request.cases.length === 0) {
    throw new Error('SQL run request requires at least one case.');
  }

  const runId = request.runId ?? `sql:run:${Date.now().toString(36)}`;
  const createTraceClient = request.createTraceClient ?? createSqlTraceClient;
  let baselineSnapshot: unknown;
  let baselineSetupTrace: SqlTrace | undefined;

  if (request.snapshotDatabase) {
    let baselineDatabase: SqlRunDatabase<TClient> | undefined;
    try {
      baselineDatabase = normalizeSqlRunDatabase(await request.createDatabase({
        problemId: request.problemId,
        runId: `${runId}:baseline`,
        phase: 'baseline',
      }));
      const setupSql = createTraceClient(baselineDatabase.client, {
        ...request.trace?.setup,
        runId: `${runId}:baseline:setup`,
      });
      await runSqlSetupScripts(setupSql, request);
      baselineSetupTrace = setupSql.getTrace();
      baselineSnapshot = await request.snapshotDatabase(baselineDatabase.client, {
        problemId: request.problemId,
        runId,
      });
    } catch (error) {
      return {
        success: false,
        isolation,
        cases: [],
        ...(request.trace?.includeSetupTrace && baselineSetupTrace ? { setupTrace: baselineSetupTrace } : {}),
        setupError: sqlRunErrorMessage(error),
      };
    } finally {
      if (baselineDatabase) await closeSqlRunDatabase(baselineDatabase);
    }
  }

  const results: SqlRunCaseResult[] = [];
  for (const [caseIndex, testCase] of request.cases.entries()) {
    const caseId = testCase.id ?? String(caseIndex + 1);
    let database: SqlRunDatabase<TClient> | undefined;
    let setupTrace: SqlTrace | undefined;
    let attemptTrace: SqlTrace | undefined;
    let assertionTrace: SqlTrace | undefined;
    let output: unknown;
    let submissionError: string | undefined;
    const assertionResults: SqlRunAssertionResult[] = [];

    try {
      database = normalizeSqlRunDatabase(await request.createDatabase({
        problemId: request.problemId,
        runId,
        phase: 'case',
        caseId,
        caseIndex,
        baselineSnapshot,
      }));

      if (!request.snapshotDatabase) {
        const setupSql = createTraceClient(database.client, {
          ...request.trace?.setup,
          runId: `${runId}:case:${caseId}:setup`,
        });
        await runSqlSetupScripts(setupSql, request);
        setupTrace = setupSql.getTrace();
      }

      const attemptSql = createTraceClient(database.client, {
        ...request.trace?.attempt,
        runId: `${runId}:case:${caseId}:attempt`,
      });
      try {
        if (typeof request.submission === 'string') {
          await runSqlScriptWithTrace(attemptSql, request.submission);
        } else {
          output = await request.submission({
            sql: attemptSql,
            client: database.client,
            testCase,
            caseIndex,
          });
        }
      } catch (error) {
        submissionError = sqlRunErrorMessage(error);
      } finally {
        attemptTrace = attemptSql.getTrace();
      }

      if (!submissionError) {
        const assertionSql = createTraceClient(database.client, {
          ...request.trace?.assertions,
          runId: `${runId}:case:${caseId}:assertions`,
        });
        try {
          for (const assertion of testCase.assertions ?? []) {
            assertionResults.push(await runSqlAssertion(assertionSql, assertion));
          }
        } finally {
          assertionTrace = assertionSql.getTrace();
        }
      }
    } catch (error) {
      submissionError = submissionError ?? sqlRunErrorMessage(error);
    } finally {
      if (database) await closeSqlRunDatabase(database);
    }

    const success = submissionError === undefined && assertionResults.every((assertion) => assertion.success);
    const passed = success && assertionResults.every((assertion) => assertion.passed);
    results.push({
      ...(testCase.id ? { id: testCase.id } : {}),
      success,
      passed,
      ...(output !== undefined ? { output } : {}),
      ...(submissionError ? { error: submissionError } : {}),
      assertions: assertionResults,
      ...(attemptTrace ? { attemptTrace } : {}),
      ...(request.trace?.includeSetupTrace && setupTrace ? { setupTrace } : {}),
      ...(request.trace?.includeAssertionTrace && assertionTrace ? { assertionTrace } : {}),
    });
  }

  return {
    success: results.every((result) => result.passed),
    isolation,
    cases: results,
    ...(request.trace?.includeSetupTrace && baselineSetupTrace ? { setupTrace: baselineSetupTrace } : {}),
  };
}

function normalizeSqlRunDatabase<TClient extends SqlClientLike>(
  value: SqlRunDatabase<TClient> | TClient
): SqlRunDatabase<TClient> {
  if (isRecord(value) && 'client' in value && isSqlClientLike(value.client)) {
    return value as SqlRunDatabase<TClient>;
  }
  if (isSqlClientLike(value)) {
    return { client: value as TClient };
  }
  throw new Error('SQL run database factory must return a SQL client or { client }.');
}

function isSqlClientLike(value: unknown): value is SqlClientLike {
  return isRecord(value) && typeof value.query === 'function';
}

async function closeSqlRunDatabase(database: SqlRunDatabase): Promise<void> {
  let closeError: unknown;
  try {
    await database.close?.();
  } catch (error) {
    closeError = error;
  }
  try {
    await database.destroy?.();
  } catch (error) {
    closeError = closeError ?? error;
  }
  if (closeError) throw closeError;
}

async function runSqlSetupScripts(
  sql: TracedSqlClient,
  request: Pick<RunIsolatedSqlCasesRequest, 'setupSql' | 'seedSql'>
): Promise<void> {
  await runSqlScriptWithTrace(sql, request.setupSql);
  await runSqlScriptWithTrace(sql, request.seedSql);
}

async function runSqlScriptWithTrace(sql: TracedSqlClient, script: string | undefined): Promise<void> {
  if (!script || script.trim().length === 0) return;
  if (typeof sql.client.exec === 'function') {
    await sql.traceExec(script);
    return;
  }
  for (const statement of splitSqlStatements(script)) {
    if (statement.text.trim().length > 0) await sql.traceQuery(statement.text);
  }
}

async function runSqlAssertion(
  sql: TracedSqlClient,
  assertion: SqlRunAssertion
): Promise<SqlRunAssertionResult> {
  try {
    const result = await sql.traceQuery(assertion.sql, { params: assertion.params });
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const affectedRows = finiteNumber(result.affectedRows);
    const rowsMatch = assertion.expectedRows === undefined || sqlRunDeepEqual(rows, assertion.expectedRows);
    const rowCountMatches = assertion.expectedRowCount === undefined || rows.length === assertion.expectedRowCount;
    const affectedRowsMatches = assertion.expectedAffectedRows === undefined || affectedRows === assertion.expectedAffectedRows;
    const passed = rowsMatch && rowCountMatches && affectedRowsMatches;
    return {
      ...(assertion.id ? { id: assertion.id } : {}),
      success: true,
      passed,
      rows,
      ...(affectedRows !== undefined ? { affectedRows } : {}),
      ...(assertion.expectedRows !== undefined ? { expectedRows: assertion.expectedRows } : {}),
      ...(assertion.expectedRowCount !== undefined ? { expectedRowCount: assertion.expectedRowCount } : {}),
      ...(assertion.expectedAffectedRows !== undefined ? { expectedAffectedRows: assertion.expectedAffectedRows } : {}),
      ...(!passed ? { error: 'SQL assertion result did not match expected output.' } : {}),
    };
  } catch (error) {
    return {
      ...(assertion.id ? { id: assertion.id } : {}),
      success: false,
      passed: false,
      error: sqlRunErrorMessage(error),
      ...(assertion.expectedRows !== undefined ? { expectedRows: assertion.expectedRows } : {}),
      ...(assertion.expectedRowCount !== undefined ? { expectedRowCount: assertion.expectedRowCount } : {}),
      ...(assertion.expectedAffectedRows !== undefined ? { expectedAffectedRows: assertion.expectedAffectedRows } : {}),
    };
  }
}

function sqlRunDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sqlRunErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSqlTransactionBoundary(sql: string): { action: SqlTransactionEvent['action']; name?: string } | null {
  const text = stripSqlLeadingTrivia(sql).trim();
  const match = /^([A-Za-z]+)(?:\s+("?[\w-]+"?))?(?:\s+("?[\w-]+"?))?(?:\s+("?[\w-]+"?))?/i.exec(text);
  const first = match?.[1]?.toLowerCase();
  const second = match?.[2]?.toLowerCase();
  const secondToken = normalizeSqlIdentifierToken(match?.[2]);
  const thirdToken = normalizeSqlIdentifierToken(match?.[3]);
  const fourthToken = normalizeSqlIdentifierToken(match?.[4]);
  if (first === 'begin') return { action: 'begin' };
  if (first === 'commit') return { action: 'commit' };
  if (first === 'savepoint') return { action: 'savepoint', ...(secondToken ? { name: secondToken } : {}) };
  if (first === 'release') {
    const name = second === 'savepoint' ? thirdToken : secondToken;
    return { action: 'release', ...(name ? { name } : {}) };
  }
  if (first === 'rollback' && second === 'to') {
    const name = match?.[3]?.toLowerCase() === 'savepoint' ? fourthToken : thirdToken;
    return { action: 'rollback-to', ...(name ? { name } : {}) };
  }
  if (first === 'rollback') return { action: 'rollback' };
  return null;
}

function normalizeSqlIdentifierToken(token: string | undefined): string | undefined {
  return token?.replace(/^"|"$/g, '');
}

function shouldCaptureEstimatePlan(
  sql: string,
  operation: ReturnType<typeof classifySqlOperation>,
  trace: SqlTrace,
  options: { api: SqlStatementApi; explain?: (explainSql: string, params: unknown[] | undefined) => Promise<SqlClientResult> }
): boolean {
  if (trace.capture.plans !== 'estimate') return false;
  if (typeof options.explain !== 'function') return false;
  if (options.api !== 'query' && options.api !== 'sql-template') return false;
  if (operation.operation !== 'select') return false;
  if (classifySqlOperation(sql).operation === 'explain') return false;
  if (trace.engine.dialect !== 'postgres') return false;
  return true;
}

async function captureEstimatePlan(
  sql: string,
  params: unknown[] | undefined,
  options: {
    explain?: (explainSql: string, params: unknown[] | undefined) => Promise<SqlClientResult>;
    runId: string;
    statementId: string;
    batchId?: string;
    transactionId?: string;
    file?: string;
    sourceSpan?: SqlSourceSpan;
    eventId: () => string;
    ordinal: () => number;
    capture: SqlTraceCapturePolicy;
    now: () => number;
  }
): Promise<SqlPlanEvent | null> {
  if (typeof options.explain !== 'function') return null;
  try {
    const startedAt = options.now();
    const result = await options.explain(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    const endedAt = options.now();
    const planValue = extractExplainJsonPlan(result);
    if (planValue === undefined) return null;
    return {
      kind: 'plan',
      eventId: options.eventId(),
      runId: options.runId,
      ordinal: options.ordinal(),
      statementId: options.statementId,
      ...(options.batchId ? { batchId: options.batchId } : {}),
      ...(options.transactionId ? { transactionId: options.transactionId } : {}),
      ...(options.file ? { file: options.file } : {}),
      ...(options.sourceSpan ? { sourceSpan: options.sourceSpan } : {}),
      source: 'explain-json',
      requestedBy: 'harness',
      mode: 'estimate',
      safeToExecute: true,
      targetStatementExecuted: false,
      diagnosticStatementExecuted: true,
      sideEffectRisk: 'planner-only',
      timing: { startTimeMs: startedAt, endTimeMs: endedAt, durationMs: Math.max(0, endedAt - startedAt) },
      summary: summarizeExplainJsonPlan(planValue),
      ...captureRawPlan(planValue, options.capture, options.runId),
    };
  } catch {
    return null;
  }
}

function extractExplainJsonPlan(result: SqlClientResult): unknown {
  const firstRow = Array.isArray(result.rows) ? result.rows[0] : undefined;
  if (Array.isArray(firstRow)) return firstRow[0];
  if (isRecord(firstRow)) {
    if ('QUERY PLAN' in firstRow) return firstRow['QUERY PLAN'];
    if ('query_plan' in firstRow) return firstRow.query_plan;
    const firstValue = Object.values(firstRow)[0];
    return firstValue;
  }
  return undefined;
}

function summarizeExplainJsonPlan(planValue: unknown): SqlPlanEvent['summary'] {
  const rootPlan = rootPlanNode(planValue);
  if (!rootPlan) return {};
  return {
    ...(stringValue(rootPlan['Node Type']) ? { rootNodeType: stringValue(rootPlan['Node Type']) } : {}),
    ...(finiteNumber(rootPlan['Plan Rows']) !== undefined ? { estimatedRows: rootPlan['Plan Rows'] as number } : {}),
    ...(finiteNumber(rootPlan['Total Cost']) !== undefined ? { estimatedTotalCost: rootPlan['Total Cost'] as number } : {}),
    ...relationsFromPlan(rootPlan),
  };
}

function rootPlanNode(planValue: unknown): Record<string, unknown> | null {
  const first = Array.isArray(planValue) ? planValue[0] : planValue;
  if (isRecord(first) && isRecord(first.Plan)) return first.Plan;
  if (isRecord(first)) return first;
  return null;
}

function relationsFromPlan(root: Record<string, unknown>): Pick<NonNullable<SqlPlanEvent['summary']>, 'relations'> {
  const relations: SqlRelationAccess[] = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    const relationName = stringValue(node['Relation Name']);
    if (relationName) {
      relations.push({
        relation: {
          ...(stringValue(node['Schema']) ? { schema: stringValue(node['Schema']) } : {}),
          name: relationName,
          kind: 'table',
        },
        access: 'read',
      });
    }
    if (Array.isArray(node.Plans)) node.Plans.forEach(visit);
  };
  visit(root);
  return relations.length > 0 ? { relations } : {};
}

function captureRawPlan(planValue: unknown, capture: SqlTraceCapturePolicy, runId: string): Pick<SqlPlanEvent, 'rawPlan'> {
  if (capture.planDetail === 'summary' && capture.hashes.plans === 'none') return {};
  const preview = stablePreview(planValue);
  const truncated = byteLength(preview) > capture.maxCellBytes;
  const rawPlan: NonNullable<SqlPlanEvent['rawPlan']> = {
    format: 'json',
    ...(capture.planDetail === 'raw-full' || (capture.planDetail === 'raw-capped' && !truncated) ? { value: planValue } : {}),
    ...(capture.hashes.plans !== 'none' ? { hash: planHash(preview, capture, runId) } : {}),
    ...(capture.planDetail === 'raw-capped' && truncated ? { truncated: true } : {}),
  };
  return { rawPlan };
}

function planHash(value: string, capture: SqlTraceCapturePolicy, runId: string): string {
  if (capture.hashes.plans === 'per-run') return stableSqlHash(`${runId}:${value}`);
  return stableSqlHash(value);
}

function captureStatementSql(sql: string, trace: SqlTrace): SqlStatementEvent['sql'] {
  const operation = classifySqlOperation(sql);
  return {
    ...captureSqlText(sql, trace),
    operation: operation.operation,
    operationSource: operation.source,
    operationConfidence: operation.confidence,
  };
}

function captureBatchSql(sql: string, trace: SqlTrace): SqlCapturedText {
  return captureSqlText(sql, trace);
}

function transactionContextFor(
  apiTransactionId: string | undefined,
  sqlTransactionId: string | undefined
): SqlStatementEvent['transactionContext'] {
  if (apiTransactionId) return 'api-wrapper';
  if (sqlTransactionId) return 'explicit-sql';
  return 'autocommit-implicit';
}

function shouldEmitResultEvent(result: SqlClientResult, capture: SqlTraceCapturePolicy): boolean {
  if (capture.resultRows !== 'none') return true;
  if (Array.isArray(result.fields) && result.fields.length > 0) return true;
  return false;
}

function captureSqlText(sql: string, trace: SqlTrace): SqlCapturedText {
  return {
    ...(trace.capture.sqlText === 'full' ? { text: sql } : {}),
    ...(trace.capture.sqlText === 'redacted' ? { redactedText: redactSqlText(sql) } : {}),
    ...(trace.capture.hashes.sql === 'raw' ? { hash: stableSqlHash(sql) } : {}),
    ...(trace.capture.hashes.sql === 'raw' || trace.capture.hashes.sql === 'normalized-redacted'
      ? { normalizedHash: stableSqlHash(normalizeSqlTextForHash(sql)) }
      : {}),
    dialect: trace.engine.dialect,
  };
}

function compactBase(base: {
  batchId?: string;
  statementId?: string;
  transactionId?: string;
  file?: string;
  sourceSpan?: SqlSourceSpan;
}): {
  batchId?: string;
  statementId?: string;
  transactionId?: string;
  file?: string;
  sourceSpan?: SqlSourceSpan;
} {
  return {
    ...(base.batchId ? { batchId: base.batchId } : {}),
    ...(base.statementId ? { statementId: base.statementId } : {}),
    ...(base.transactionId ? { transactionId: base.transactionId } : {}),
    ...(base.file ? { file: base.file } : {}),
    ...(base.sourceSpan ? { sourceSpan: base.sourceSpan } : {}),
  };
}

class SqlTraceTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`SQL trace execution timed out after ${timeoutMs} milliseconds`);
    this.name = 'SqlTraceTimeoutError';
  }
}

function isSqlTimeoutError(error: unknown): error is SqlTraceTimeoutError {
  return error instanceof SqlTraceTimeoutError;
}

function withOptionalTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs === undefined || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SqlTraceTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function cloneSqlTrace(trace: SqlTrace): SqlTrace {
  return {
    ...trace,
    engine: {
      ...trace.engine,
      ...(trace.engine.capabilities ? { capabilities: [...trace.engine.capabilities] } : {}),
      ...(trace.engine.extras ? { extras: structuredCloneFallback(trace.engine.extras) } : {}),
    },
    capture: {
      ...trace.capture,
      hashes: { ...trace.capture.hashes },
    },
    events: trace.events.map((event) => structuredCloneFallback(event)),
  };
}

function structuredCloneFallback<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
