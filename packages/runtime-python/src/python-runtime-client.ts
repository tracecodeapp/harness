import type {
  PythonPreparedProgramHandle,
  PythonProjectCommandRequest,
  PythonWorkerClient,
} from './python-worker-client';
import type {
  RuntimeClient,
  RuntimeCodeCall,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimeExecutionTimings,
  RuntimePreparedExecutionProvider,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedTraceCall,
  RuntimePreparedTraceBatchCall,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeTraceCall,
} from '@tracecode/runtime-contracts';
import type { RuntimeCommandResult } from '@tracecode/runtime-contracts';
import type { CodeExecutionResult, ExecutionLimitReason, ExecutionResult } from '@tracecode/runtime-contracts';
import { liftTraceOutcome } from '@tracecode/runtime-contracts';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  createEmptyRuntimeTrace,
  type RuntimeTrace,
  type RuntimeTraceCallFrame,
  type RuntimeTraceEvent,
  type RuntimeTraceEventKind,
  type RuntimeTraceSourceSpan,
  type RuntimeTraceTarget,
} from '@tracecode/runtime-contracts';
import { assertRuntimeRequestSupported } from '@tracecode/runtime-browser/internal';
import { getLanguageRuntimeProfile } from '@tracecode/runtime-browser/internal';
import {
  executeRuntimeRequest,
  isRuntimeProjectExecuteRequest,
} from '@tracecode/runtime-browser/internal';

const PYTHON_TRACE_EVENT_KINDS = new Set<RuntimeTraceEventKind>([
  'line',
  'call',
  'return',
  'read',
  'write',
  'mutate',
  'snapshot',
  'stdout',
  'exception',
  'timeout',
]);
const PYTHON_TIMEOUT_REASONS = new Set<ExecutionLimitReason>([
  'trace-limit',
  'trace-byte-limit',
  'line-limit',
  'single-line-limit',
  'recursion-limit',
  'memory-limit',
  'client-timeout',
]);
const PYTHON_TRACE_TIMEOUT_REASONS = new Set([
  'trace-limit',
  'trace-byte-limit',
  'line-limit',
  'single-line-limit',
  'recursion-limit',
  'memory-limit',
  'client-timeout',
]);
const MAX_NORMALIZED_TRACE_EVENTS = 500000;
const MAX_NORMALIZED_ARRAY_ITEMS = 256;
const MAX_NORMALIZED_OBJECT_FIELDS = 128;
const MAX_NORMALIZED_VALUE_DEPTH = 32;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizedString(value: unknown, maxLength = 20000): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalizedLine(value: unknown): number | undefined {
  const line = finiteNumber(value);
  return line === undefined ? undefined : Math.floor(line);
}

function sanitizeJsonValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  if (depth >= MAX_NORMALIZED_VALUE_DEPTH) {
    return '<max depth>';
  }
  if (seen.has(value)) {
    return '<cycle>';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_NORMALIZED_ARRAY_ITEMS)
      .map((item) => sanitizeJsonValue(item, depth + 1, seen));
    if (value.length > MAX_NORMALIZED_ARRAY_ITEMS) {
      out.push({ __truncated__: true, remaining: value.length - MAX_NORMALIZED_ARRAY_ITEMS });
    }
    return out;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, child] of entries.slice(0, MAX_NORMALIZED_OBJECT_FIELDS)) {
    const childValue = sanitizeJsonValue(child, depth + 1, seen);
    if (childValue !== undefined) out[key] = childValue;
  }
  if (entries.length > MAX_NORMALIZED_OBJECT_FIELDS) {
    out.__truncated__ = true;
    out.remaining = entries.length - MAX_NORMALIZED_OBJECT_FIELDS;
  }
  return out;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizedString(item) ?? '');
}

function normalizeExecutionTimings(value: unknown): RuntimeExecutionTimings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const timings: RuntimeExecutionTimings = {};
  for (const key of [
    'totalMs',
    'initMs',
    'warmupMs',
    'compilerLoadMs',
    'rewriteMs',
    'driverBuildMs',
    'compileMs',
    'pchMs',
    'linkMs',
    'wasmCompileMs',
    'classLoadMs',
    'runMs',
    'hostCallMs',
  ] as const) {
    const normalized = finiteNumber(record[key]);
    if (normalized !== undefined) timings[key] = normalized;
  }
  for (const key of [
    'pchCacheHit',
    'pchFallback',
    'compileCacheHit',
    'artifactCacheHit',
  ] as const) {
    if (typeof record[key] === 'boolean') timings[key] = record[key];
  }
  return Object.keys(timings).length > 0 ? timings : undefined;
}

function normalizeTracePath(value: unknown): Array<string | number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const path = value
    .slice(0, 8)
    .filter((part): part is string | number =>
      typeof part === 'string' || (typeof part === 'number' && Number.isFinite(part))
    )
    .map((part) => typeof part === 'number' ? Math.floor(part) : part);
  return path.length > 0 ? path : undefined;
}

function normalizeTraceTarget(value: unknown): RuntimeTraceTarget | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const variable = normalizedString(record.variable, 200);
  if (variable) {
    const path = normalizeTracePath(record.path);
    const indexSources = Array.isArray(record.indexSources)
      ? record.indexSources
          .slice(0, path?.length ?? 0)
          .map((source) => typeof source === 'string' && source.length > 0 ? source : null)
      : undefined;
    return {
      variable,
      ...(path ? { path } : {}),
      ...(indexSources && indexSources.length > 0 ? { indexSources } : {}),
    } as RuntimeTraceTarget;
  }
  const objectId = normalizedString(record.objectId, 200);
  if (objectId) {
    const path = normalizeTracePath(record.path);
    return { objectId, ...(path ? { path } : {}) };
  }
  return null;
}

function normalizeCallStack(value: unknown): RuntimeTraceCallFrame[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const frames = value.slice(0, 64).flatMap((frame): RuntimeTraceCallFrame[] => {
    if (!frame || typeof frame !== 'object') return [];
    const record = frame as Record<string, unknown>;
    const functionName = normalizedString(record.function, 200);
    if (!functionName) return [];
    const line = normalizedLine(record.line);
    const args = record.args && typeof record.args === 'object'
      ? sanitizeJsonValue(record.args) as Record<string, unknown>
      : undefined;
    return [{ function: functionName, ...(line !== undefined ? { line } : {}), ...(args ? { args } : {}) }];
  });
  return frames.length > 0 ? frames : undefined;
}

function normalizeSourceSpan(value: unknown): RuntimeTraceSourceSpan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const startLine = normalizedLine(record.startLine);
  if (startLine === undefined) return undefined;
  const startColumn = normalizedLine(record.startColumn);
  const endLine = normalizedLine(record.endLine);
  const endColumn = normalizedLine(record.endColumn);
  const file = normalizedString(record.file, 1000);
  return {
    ...(file ? { file } : {}),
    startLine,
    ...(startColumn !== undefined ? { startColumn } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(endColumn !== undefined ? { endColumn } : {}),
  };
}

function normalizePythonTraceEvent(value: unknown, runId: string): RuntimeTraceEvent | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !PYTHON_TRACE_EVENT_KINDS.has(kind as RuntimeTraceEventKind)) {
    return null;
  }
  const line = normalizedLine(record.line);
  const functionName = normalizedString(record.function, 200);
  const callStack = normalizeCallStack(record.callStack);
  const base = {
    kind,
    runId,
    ...(normalizedString(record.file, 1000) ? { file: normalizedString(record.file, 1000) } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(normalizedString(record.frameId, 500) ? { frameId: normalizedString(record.frameId, 500) } : {}),
    ...(normalizedString(record.statementId, 500) ? { statementId: normalizedString(record.statementId, 500) } : {}),
    ...(normalizeSourceSpan(record.sourceSpan) ? { sourceSpan: normalizeSourceSpan(record.sourceSpan) } : {}),
    ...(callStack ? { callStack } : {}),
  };

  if (kind === 'line') {
    if (line === undefined) return null;
    return { ...base, kind, line, ...(functionName ? { function: functionName } : {}) } as RuntimeTraceEvent;
  }
  if (kind === 'call') {
    if (line === undefined || !functionName) return null;
    const args = record.args && typeof record.args === 'object'
      ? sanitizeJsonValue(record.args) as Record<string, unknown>
      : undefined;
    return { ...base, kind, line, function: functionName, ...(args ? { args } : {}) } as RuntimeTraceEvent;
  }
  if (kind === 'return') {
    if (line === undefined) return null;
    return {
      ...base,
      kind,
      line,
      ...(functionName ? { function: functionName } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, 'value') ? { value: sanitizeJsonValue(record.value) } : {}),
    } as RuntimeTraceEvent;
  }
  if (kind === 'read' || kind === 'write' || kind === 'mutate' || kind === 'snapshot') {
    if (line === undefined) return null;
    const target = normalizeTraceTarget(record.target);
    if (!target) return null;
    if (kind === 'mutate') {
      const args = Array.isArray(record.args)
        ? record.args.slice(0, 32).map((item) => sanitizeJsonValue(item))
        : undefined;
      return {
        ...base,
        kind,
        line,
        target,
        ...(normalizedString(record.method, 200) ? { method: normalizedString(record.method, 200) } : {}),
        ...(args ? { args } : {}),
      } as RuntimeTraceEvent;
    }
    if (kind === 'snapshot') {
      return { ...base, kind, line, target, value: sanitizeJsonValue(record.value) } as RuntimeTraceEvent;
    }
    const binding = record.binding && typeof record.binding === 'object'
      ? record.binding as Record<string, unknown>
      : null;
    const bindingVariable = binding ? normalizedString(binding.variable, 200) : undefined;
    return {
      ...base,
      kind,
      line,
      target,
      ...(Object.prototype.hasOwnProperty.call(record, 'value') ? { value: sanitizeJsonValue(record.value) } : {}),
      ...(bindingVariable ? { binding: { kind: binding?.kind === 'iteration' ? 'iteration' : undefined, variable: bindingVariable } } : {}),
    } as RuntimeTraceEvent;
  }
  if (kind === 'stdout') {
    return { ...base, kind, text: normalizedString(record.text) ?? '' } as RuntimeTraceEvent;
  }
  if (kind === 'exception') {
    return { ...base, kind, message: normalizedString(record.message) ?? 'Runtime exception' } as RuntimeTraceEvent;
  }
  if (kind === 'timeout') {
    const reason = typeof record.reason === 'string' && PYTHON_TRACE_TIMEOUT_REASONS.has(record.reason)
      ? record.reason
      : undefined;
    return {
      ...base,
      kind,
      message: normalizedString(record.message) ?? 'Runtime timeout',
      ...(reason ? { reason } : {}),
    } as RuntimeTraceEvent;
  }
  return null;
}

function normalizePythonRuntimeTrace(value: unknown): RuntimeTrace {
  if (!value || typeof value !== 'object') {
    return createEmptyRuntimeTrace('python', { runId: 'python:run', file: 'solution.py' });
  }
  const record = value as Record<string, unknown>;
  const runId = normalizedString(record.runId, 200) ?? 'python:run';
  const rawEvents = Array.isArray(record.events) ? record.events.slice(0, MAX_NORMALIZED_TRACE_EVENTS) : [];
  const events = rawEvents.flatMap((event): RuntimeTraceEvent[] => {
    const normalized = normalizePythonTraceEvent(event, runId);
    return normalized ? [normalized] : [];
  });
  return {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language: 'python',
    runId,
    events,
    lineEventCount: events.filter((event) => event.kind === 'line').length,
    traceStepCount: events.length,
  };
}

function normalizePythonExecutionResult(value: unknown): ExecutionResult {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const timeoutReason = typeof record.timeoutReason === 'string' && PYTHON_TIMEOUT_REASONS.has(record.timeoutReason as ExecutionLimitReason)
    ? record.timeoutReason as ExecutionLimitReason
    : undefined;
  const timings = normalizeExecutionTimings(record.timings);
  return liftTraceOutcome(
    {
      success: record.success === true,
      output: sanitizeJsonValue(record.output),
      ...(normalizedString(record.error) ? { error: normalizedString(record.error) } : {}),
      ...(normalizedLine(record.errorLine) !== undefined ? { errorLine: normalizedLine(record.errorLine) } : {}),
      executionTimeMs: finiteNumber(record.executionTimeMs) ?? 0,
      consoleOutput: normalizeStringArray(record.consoleOutput),
      ...(record.traceLimitExceeded === true ? { traceLimitExceeded: true } : {}),
      ...(timeoutReason ? { timeoutReason } : {}),
      ...(record.diagnostic !== undefined ? { diagnostic: sanitizeJsonValue(record.diagnostic) } : {}),
      ...(timings ? { timings } : {}),
    },
    normalizePythonRuntimeTrace(record.trace),
    'Python tracing failed'
  );
}

export interface PythonPreparedExecutionProviderOptions {
  readonly createWorkerClient: () => PythonWorkerClient;
  readonly prewarmAfterUse?: boolean;
}

export interface PythonPreparedExecutionProviderController
  extends RuntimePreparedExecutionProvider {
  /** Release current programs and workers while keeping the provider reusable. */
  reset(): void;
  /**
   * Force-retire preparation standby and active execution workers owned by
   * this provider.
   */
  terminate(): void;
}

class PythonRuntimeClient implements RuntimeClient {
  constructor(private readonly workerClient: PythonWorkerClient) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.workerClient.init();
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    if (isRuntimeProjectExecuteRequest(request)) {
      return executeRuntimeRequest(request, {
        defaultExecutionStyle: 'function',
        executeProject: (projectRequest) =>
          this.workerClient.executeProjectPython(projectRequest as PythonProjectCommandRequest),
        executeCode: this.executeCode.bind(this),
        executeWithTracing: this.executeWithTracing.bind(this),
      });
    }

    return executeRuntimeRequest(request as RuntimeExecuteCodeRequest, {
      defaultExecutionStyle: 'function',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
    });
  }

  async executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
      request: 'trace',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
    });
    const result = await this.workerClient.executeWithTracing(call);
    return normalizePythonExecutionResult(result);
  }

  async executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
      request: 'execute',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
      limits: call.limits,
    });
    return this.workerClient.executeCode(call);
  }
}

type WarmedPythonWorker = {
  readonly client: PythonWorkerClient;
  readonly warmup: { success: boolean; loadTimeMs: number };
};

type PythonWorkerSlot = {
  readonly client: PythonWorkerClient;
  readonly ready: Promise<WarmedPythonWorker>;
};

function abortReason(signal: AbortSignal, fallback: string): unknown {
  return signal.reason ?? new DOMException(fallback, 'AbortError');
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  if (!source) return () => undefined;
  const forward = () => {
    if (!target.signal.aborted) {
      target.abort(abortReason(source, 'Python execution was aborted.'));
    }
  };
  if (source.aborted) {
    forward();
    return () => undefined;
  }
  source.addEventListener('abort', forward, { once: true });
  return () => source.removeEventListener('abort', forward);
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void = () => undefined
): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(
      abortReason(signal, 'Python execution was aborted.')
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      operation();
    };
    const handleAbort = () =>
      finish(() => {
        onAbort();
        reject(abortReason(signal, 'Python execution was aborted.'));
      });
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

class PreparedPythonProgramLifetime {
  private phase: 'active' | 'disposing' | 'disposed' = 'active';
  private operationTail: Promise<void> = Promise.resolve();
  private disposal: Promise<void> | undefined;
  private initialWorker: WarmedPythonWorker | null;
  private generation = 1;
  private disposedNotificationSent = false;
  private readonly ownedWorkers = new Set<PythonWorkerClient>();
  private readonly operationControllers = new Set<AbortController>();

  constructor(
    private readonly handle: PythonPreparedProgramHandle,
    private readonly createWorkerClient: () => PythonWorkerClient,
    private readonly onDisposed: (
      lifetime: PreparedPythonProgramLifetime,
      replenishPreparationStandby: boolean
    ) => void,
    initialWorker: WarmedPythonWorker
  ) {
    this.initialWorker = initialWorker;
    this.ownedWorkers.add(initialWorker.client);
  }

  executeCode(
    call: Pick<RuntimeCodeCall, 'inputs' | 'signal' | 'limits'>
  ): Promise<CodeExecutionResult> {
    return this.executeSerial(call.signal, (client, signal) =>
      client.executePreparedCode(this.handle, { ...call, signal })
    );
  }

  executeTrace(
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult> {
    return this.executeSerial(call.signal, async (client, signal) =>
      normalizePythonExecutionResult(
        await client.executePreparedTrace(this.handle, { ...call, signal })
      )
    );
  }

  executeCodeBatch(
    call: RuntimePreparedCodeBatchCall
  ): Promise<readonly CodeExecutionResult[]> {
    return this.executeSerial(call.signal, async (client, signal) => {
      const result = await client.executePreparedCodeBatch(this.handle, {
        ...call,
        signal,
      });
      return result.results;
    });
  }

  executeTraceBatch(
    call: RuntimePreparedTraceBatchCall
  ): Promise<readonly ExecutionResult[]> {
    return this.executeSerial(call.signal, async (client, signal) => {
      const result = await client.executePreparedTraceBatch(this.handle, {
        ...call,
        signal,
      });
      return (result.results ?? []).map((entry) =>
        normalizePythonExecutionResult(entry)
      );
    });
  }

  dispose = (): Promise<void> => {
    if (this.disposal) return this.disposal;
    if (this.phase === 'disposed') return Promise.resolve();
    this.phase = 'disposing';
    this.abortAndRetire(
      new DOMException('Prepared Python program has been disposed.', 'AbortError')
    );
    this.disposal = this.operationTail.then(() => {
      this.finishDisposed(true);
    });
    this.operationTail = this.disposal.then(
      () => undefined,
      () => undefined
    );
    return this.disposal;
  };

  forceTerminate(
    reason: unknown = new DOMException(
      'Prepared Python program has been terminated.',
      'AbortError'
    )
  ): void {
    if (this.phase === 'disposed') return;
    this.phase = 'disposing';
    this.abortAndRetire(reason);
    this.finishDisposed(false);
  }

  private executeSerial<T>(
    signal: AbortSignal | undefined,
    operation: (client: PythonWorkerClient, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.phase !== 'active') {
      return Promise.reject(new Error('Prepared Python program has been disposed.'));
    }
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    this.operationControllers.add(controller);
    const previous = this.operationTail;
    const underlying = previous.then(async () => {
      let client: PythonWorkerClient | undefined;
      try {
        if (this.phase !== 'active') {
          throw new Error('Prepared Python program has been disposed.');
        }
        if (controller.signal.aborted) {
          throw abortReason(
            controller.signal,
            'Prepared Python execution was aborted.'
          );
        }
        ({ client } = await this.takeWorker(controller.signal));
        if (this.phase !== 'active') {
          throw new Error('Prepared Python program has been disposed.');
        }
        return await operation(client, controller.signal);
      } finally {
        // Every prepared execution call gets a hard interpreter boundary.
        // Batch calls retain the runtime's existing per-case reset semantics
        // inside one disposable worker. The marshaled code artifact survives;
        // the Pyodide worker, heap, modules, cwd, RNG, and filesystem do not.
        if (client) this.retireWorker(client);
      }
    });
    this.operationTail = underlying.then(
      () => undefined,
      () => undefined
    );
    void underlying.then(
      () => {
        unlink();
        this.operationControllers.delete(controller);
      },
      () => {
        unlink();
        this.operationControllers.delete(controller);
      }
    );
    // A queued caller observes its own cancellation immediately without
    // breaking the internal serialization tail that preserves maxConcurrency.
    return raceWithAbort(underlying, controller.signal);
  }

  private takeWorker(signal: AbortSignal): Promise<WarmedPythonWorker> {
    if (this.phase !== 'active') {
      return Promise.reject(
        new Error('Prepared Python program has been disposed.')
      );
    }
    if (this.initialWorker) {
      const worker = this.initialWorker;
      this.initialWorker = null;
      return raceWithAbort(
        Promise.resolve(worker),
        signal,
        () => this.retireWorker(worker.client)
      );
    }
    const generation = this.generation;
    const client = this.createWorkerClient();
    this.ownedWorkers.add(client);
    const ready = client.warmup().then(
      (warmup) => {
        if (
          generation !== this.generation ||
          this.phase !== 'active' ||
          !this.ownedWorkers.has(client)
        ) {
          this.retireWorker(client);
          throw new Error('Prepared Python worker warmup was superseded.');
        }
        return { client, warmup };
      },
      (error: unknown) => {
        this.retireWorker(client);
        throw error;
      }
    );
    void ready.catch(() => undefined);
    return raceWithAbort(ready, signal, () => this.retireWorker(client));
  }

  private retireWorker(client: PythonWorkerClient): void {
    // Deletion is the ownership gate and makes retirement idempotent. An
    // abort can retire a warming worker before warmup settles; that settlement
    // deliberately reaches this method again without terminating twice.
    if (!this.ownedWorkers.delete(client)) return;
    client.terminate();
  }

  private terminateOwnedWorkers(): void {
    for (const worker of this.ownedWorkers) worker.terminate();
    this.ownedWorkers.clear();
  }

  private abortAndRetire(reason: unknown): void {
    this.generation += 1;
    this.initialWorker = null;
    const controllers = [...this.operationControllers];
    this.operationControllers.clear();
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    this.terminateOwnedWorkers();
  }

  private finishDisposed(replenishPreparationStandby: boolean): void {
    this.phase = 'disposed';
    if (this.disposedNotificationSent) return;
    this.disposedNotificationSent = true;
    this.onDisposed(this, replenishPreparationStandby);
  }
}

class PythonPreparedExecutionProvider
  implements PythonPreparedExecutionProviderController {
  private preparationTail: Promise<void> = Promise.resolve();
  // The shared runtime-image factory lives outside these disposable workers.
  // This standby restores that image ahead of preparation, then becomes the
  // first isolated execution worker so its interpreter bootstrap is not lost.
  private preparationStandby: PythonWorkerSlot | null = null;
  private generation = 1;
  private terminated = false;
  private readonly preparationWorkers = new Set<PythonWorkerClient>();
  private readonly programs = new Set<PreparedPythonProgramLifetime>();
  private readonly preparationControllers = new Set<AbortController>();

  constructor(private readonly options: PythonPreparedExecutionProviderOptions) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    this.assertActive();
    return (await this.startPreparationStandby().ready).warmup;
  }

  prepareProgram(
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    this.assertActive();
    assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
      request: call.mode === 'trace' ? 'trace' : 'execute',
      executionStyle: call.executionStyle ?? 'function',
      functionName: call.functionName,
    });
    const generation = this.generation;
    const controller = new AbortController();
    const unlink = linkAbortSignal(call.signal, controller);
    this.preparationControllers.add(controller);
    const previous = this.preparationTail;
    const underlying = previous.then(() =>
      this.prepareSerial(call, generation, controller.signal)
    );
    this.preparationTail = underlying.then(
      () => undefined,
      () => undefined
    );
    void underlying.then(
      () => {
        unlink();
        this.preparationControllers.delete(controller);
      },
      () => {
        unlink();
        this.preparationControllers.delete(controller);
      }
    );
    return raceWithAbort(underlying, controller.signal);
  }

  reset(): void {
    this.assertActive();
    this.releaseResources(
      new DOMException(
        'Prepared Python execution provider was reset.',
        'AbortError'
      )
    );
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.releaseResources(
      new DOMException(
        'Prepared Python execution provider was terminated.',
        'AbortError'
      )
    );
  }

  private releaseResources(reason: unknown): void {
    this.generation += 1;
    this.preparationStandby = null;
    this.preparationTail = Promise.resolve();
    const controllers = [...this.preparationControllers];
    this.preparationControllers.clear();
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    for (const client of this.preparationWorkers) client.terminate();
    this.preparationWorkers.clear();
    for (const program of [...this.programs]) program.forceTerminate(reason);
    this.programs.clear();
  }

  private async prepareSerial(
    call: RuntimeProgramPreparationCall,
    generation: number,
    signal: AbortSignal
  ): Promise<RuntimeProgramPreparationResult> {
    this.assertGeneration(generation);
    let preparationWorker: WarmedPythonWorker | undefined;
    let result;
    try {
      preparationWorker = await this.takePreparationStandby(signal);
      result = await preparationWorker.client.prepareProgram({
        ...call,
        signal,
      });
    } catch (error) {
      if (preparationWorker) {
        this.retirePreparationWorker(preparationWorker.client);
      }
      this.replenishPreparationStandby();
      throw error;
    }
    // A provider shutdown can race an in-flight preparation request. The worker
    // may still settle its request after termination, reset, or caller
    // cancellation has retired it, but that result must never publish a new
    // program lifetime beyond the abandoned request boundary.
    if (signal.aborted) {
      this.retirePreparationWorker(preparationWorker.client);
      this.replenishPreparationStandby();
      throw abortReason(signal, 'Prepared Python compilation was aborted.');
    }
    try {
      this.assertGeneration(generation);
    } catch (error) {
      this.retirePreparationWorker(preparationWorker.client);
      this.replenishPreparationStandby();
      throw error;
    }
    if (!result.success) {
      this.retirePreparationWorker(preparationWorker.client);
      this.replenishPreparationStandby();
      return {
        kind: 'failed',
        error: result.error,
        ...(result.errorLine !== undefined ? { errorLine: result.errorLine } : {}),
        diagnosticStage: 'compile',
        consoleOutput: result.consoleOutput,
        ...(result.timings ? { timings: result.timings } : {}),
      };
    }

    const handle: PythonPreparedProgramHandle = result;
    this.preparationWorkers.delete(preparationWorker.client);
    const lifetime = new PreparedPythonProgramLifetime(
      handle,
      this.options.createWorkerClient,
      (program, replenishPreparationStandby) => {
        this.programs.delete(program);
        if (replenishPreparationStandby) {
          this.replenishPreparationStandby();
        }
      },
      preparationWorker
    );
    this.programs.add(lifetime);

    if (call.mode === 'trace') {
      return {
        kind: 'prepared',
        consoleOutput: result.consoleOutput,
        ...(result.timings ? { timings: result.timings } : {}),
        program: {
          mode: 'trace',
          capabilities: {
            caseIsolation: 'fresh-case-state',
            maxConcurrency: 1,
          },
          executeIsolated: (executionCall) =>
            lifetime.executeTrace(executionCall),
          executeBatchIsolated: (executionCall) =>
            lifetime.executeTraceBatch(executionCall),
          dispose: lifetime.dispose,
        },
      };
    }

    return {
      kind: 'prepared',
      consoleOutput: result.consoleOutput,
      ...(result.timings ? { timings: result.timings } : {}),
      program: {
        mode: 'code',
        capabilities: {
          caseIsolation: 'fresh-case-state',
          maxConcurrency: 1,
        },
        executeIsolated: (executionCall) =>
          lifetime.executeCode(executionCall),
        executeBatchIsolated: (executionCall) =>
          lifetime.executeCodeBatch(executionCall),
        dispose: lifetime.dispose,
      },
    };
  }

  private startPreparationStandby(): PythonWorkerSlot {
    if (this.preparationStandby) return this.preparationStandby;
    this.assertActive();
    const generation = this.generation;
    const client = this.options.createWorkerClient();
    this.preparationWorkers.add(client);
    const ready = client.warmup().then(
      (warmup) => {
        if (
          generation !== this.generation ||
          this.terminated ||
          !this.preparationWorkers.has(client)
        ) {
          this.retirePreparationWorker(client);
          throw new Error(
            'Prepared Python preparation worker warmup was superseded.'
          );
        }
        return { client, warmup };
      },
      (error: unknown) => {
        if (generation === this.generation) this.preparationStandby = null;
        this.retirePreparationWorker(client);
        throw error;
      }
    );
    const standby = { client, ready };
    this.preparationStandby = standby;
    void ready.catch(() => undefined);
    return standby;
  }

  private takePreparationStandby(
    signal: AbortSignal
  ): Promise<WarmedPythonWorker> {
    const standby =
      this.preparationStandby ?? this.startPreparationStandby();
    this.preparationStandby = null;
    return raceWithAbort(standby.ready, signal, () =>
      this.retirePreparationWorker(standby.client)
    );
  }

  private retirePreparationWorker(client: PythonWorkerClient): void {
    if (!this.preparationWorkers.delete(client)) return;
    client.terminate();
  }

  private replenishPreparationStandby(): void {
    if (
      (this.options.prewarmAfterUse ?? true) &&
      !this.terminated &&
      !this.preparationStandby
    ) {
      this.startPreparationStandby();
    }
  }

  private assertActive(): void {
    if (this.terminated) {
      throw new Error('Prepared Python execution provider has been terminated.');
    }
  }

  private assertGeneration(generation: number): void {
    this.assertActive();
    if (generation !== this.generation) {
      throw new Error('Prepared Python execution provider was reset.');
    }
  }
}

export function createPythonRuntimeClient(
  workerClient: PythonWorkerClient
): RuntimeClient {
  return new PythonRuntimeClient(workerClient);
}

export function createPythonPreparedExecutionProvider(
  options: PythonPreparedExecutionProviderOptions
): PythonPreparedExecutionProviderController {
  return new PythonPreparedExecutionProvider(options);
}
