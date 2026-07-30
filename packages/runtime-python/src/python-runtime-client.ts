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
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
  RuntimeTraceCall,
} from '@tracecode/runtime-core';
import type { RuntimeCommandResult } from '@tracecode/runtime-core';
import type { CodeExecutionResult, ExecutionLimitReason, ExecutionResult } from '@tracecode/runtime-core';
import { liftTraceOutcome } from '@tracecode/runtime-core';
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  createEmptyRuntimeTrace,
  type RuntimeTrace,
  type RuntimeTraceCallFrame,
  type RuntimeTraceEvent,
  type RuntimeTraceEventKind,
  type RuntimeTraceSourceSpan,
  type RuntimeTraceTarget,
} from '@tracecode/runtime-core';
import { assertRuntimeRequestSupported } from '@tracecode/runtime-browser/internal';
import { getLanguageRuntimeProfile } from '@tracecode/runtime-browser/internal';
import {
  batchCodeResultToExecuteResult,
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
  'line-limit',
  'single-line-limit',
  'recursion-limit',
  'memory-limit',
  'client-timeout',
]);
const PYTHON_TRACE_TIMEOUT_REASONS = new Set([
  'trace-limit',
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
  /** Force-retire compiler, standby, and active case workers owned by this provider. */
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

    const codeRequest = request as RuntimeExecuteCodeRequest;
    const executionStyle = codeRequest.executionStyle ?? 'function';
    if (!codeRequest.trace && !codeRequest.limits && codeRequest.cases.length > 1) {
      assertRuntimeRequestSupported(getLanguageRuntimeProfile('python'), {
        request: 'execute',
        executionStyle,
        functionName: codeRequest.functionName ?? '',
      });
      const result = await this.workerClient.executeCodeBatch({
        code: codeRequest.code,
        functionName: codeRequest.functionName ?? '',
        inputBatch: codeRequest.cases.map((testCase) => testCase.inputs),
        executionStyle,
        signal: codeRequest.signal,
      });
      return batchCodeResultToExecuteResult(codeRequest, result);
    }

    return executeRuntimeRequest(codeRequest, {
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

class PreparedPythonProgramLifetime {
  private phase: 'active' | 'disposing' | 'disposed' = 'active';
  private operationTail: Promise<void> = Promise.resolve();
  private disposal: Promise<void> | undefined;
  private standby: Promise<WarmedPythonWorker> | null = null;
  private generation = 1;
  private readonly ownedWorkers = new Set<PythonWorkerClient>();

  constructor(
    private readonly handle: PythonPreparedProgramHandle,
    private readonly options: PythonPreparedExecutionProviderOptions,
    private readonly onDisposed: (lifetime: PreparedPythonProgramLifetime) => void
  ) {
    this.startStandby();
  }

  executeCode(
    call: Pick<RuntimeCodeCall, 'inputs' | 'signal' | 'limits'>
  ): Promise<CodeExecutionResult> {
    return this.executeSerial(call.signal, (client) =>
      client.executePreparedCode(this.handle, call)
    );
  }

  executeTrace(
    call: Pick<RuntimeTraceCall, 'inputs' | 'signal' | 'limits'>
  ): Promise<ExecutionResult> {
    return this.executeSerial(call.signal, async (client) =>
      normalizePythonExecutionResult(
        await client.executePreparedTrace(this.handle, call)
      )
    );
  }

  dispose = (): Promise<void> => {
    if (this.disposal) return this.disposal;
    this.phase = 'disposing';
    this.disposal = this.operationTail.then(async () => {
      this.generation += 1;
      const standby = this.standby;
      this.standby = null;
      if (standby) await standby.catch(() => undefined);
      this.terminateOwnedWorkers();
      this.phase = 'disposed';
      this.onDisposed(this);
    });
    this.operationTail = this.disposal.then(
      () => undefined,
      () => undefined
    );
    return this.disposal;
  };

  forceTerminate(): void {
    if (this.phase === 'disposed') return;
    this.phase = 'disposed';
    this.generation += 1;
    this.standby = null;
    this.terminateOwnedWorkers();
    this.onDisposed(this);
  }

  private executeSerial<T>(
    signal: AbortSignal | undefined,
    operation: (client: PythonWorkerClient) => Promise<T>
  ): Promise<T> {
    if (this.phase !== 'active') {
      return Promise.reject(new Error('Prepared Python program has been disposed.'));
    }
    const result = this.operationTail.then(async () => {
      if (this.phase === 'disposed') {
        throw new Error('Prepared Python program has been disposed.');
      }
      if (signal?.aborted) {
        throw signal.reason ?? new Error('Prepared Python execution was aborted.');
      }
      const { client } = await this.takeStandby();
      if (this.isDisposed()) {
        this.retireWorker(client);
        throw new Error('Prepared Python program has been disposed.');
      }
      try {
        return await operation(client);
      } finally {
        // Every case gets a hard interpreter boundary. The marshaled code
        // artifact survives; the Pyodide worker, heap, modules, cwd, RNG, and
        // filesystem do not.
        this.retireWorker(client);
        if (
          this.phase === 'active' &&
          (this.options.prewarmAfterUse ?? true)
        ) {
          this.startStandby();
        }
      }
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private startStandby(): Promise<WarmedPythonWorker> {
    if (this.standby) return this.standby;
    const generation = this.generation;
    const client = this.options.createWorkerClient();
    this.ownedWorkers.add(client);
    const standby = client.warmup().then(
      (warmup) => {
        if (generation !== this.generation || this.phase === 'disposed') {
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
    this.standby = standby;
    void standby.catch(() => undefined);
    return standby;
  }

  private async takeStandby(): Promise<WarmedPythonWorker> {
    const standby = this.standby ?? this.startStandby();
    this.standby = null;
    return standby;
  }

  private retireWorker(client: PythonWorkerClient): void {
    if (!this.ownedWorkers.delete(client)) return;
    client.terminate();
  }

  private terminateOwnedWorkers(): void {
    for (const worker of this.ownedWorkers) worker.terminate();
    this.ownedWorkers.clear();
  }

  private isDisposed(): boolean {
    return this.phase === 'disposed';
  }
}

class PythonPreparedExecutionProvider
  implements PythonPreparedExecutionProviderController {
  private preparationTail: Promise<void> = Promise.resolve();
  private compilerStandby: Promise<WarmedPythonWorker> | null = null;
  private generation = 1;
  private terminated = false;
  private readonly compilerWorkers = new Set<PythonWorkerClient>();
  private readonly programs = new Set<PreparedPythonProgramLifetime>();

  constructor(private readonly options: PythonPreparedExecutionProviderOptions) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    this.assertActive();
    return (await this.startCompilerStandby()).warmup;
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
    const result = this.preparationTail.then(() => this.prepareSerial(call));
    this.preparationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.generation += 1;
    this.compilerStandby = null;
    for (const client of this.compilerWorkers) client.terminate();
    this.compilerWorkers.clear();
    for (const program of [...this.programs]) program.forceTerminate();
    this.programs.clear();
  }

  private async prepareSerial(
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    this.assertActive();
    const { client } = await this.takeCompilerStandby();
    let result;
    try {
      result = await client.prepareProgram(call);
    } finally {
      this.retireCompiler(client);
    }
    // A provider shutdown can race an in-flight compiler request. The worker
    // may still settle its request after terminate() has retired it, but that
    // result must never publish a new program lifetime beyond the shutdown
    // boundary.
    this.assertActive();
    if (!result.success) {
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
    const lifetime = new PreparedPythonProgramLifetime(
      handle,
      this.options,
      (program) => this.programs.delete(program)
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
        dispose: lifetime.dispose,
      },
    };
  }

  private startCompilerStandby(): Promise<WarmedPythonWorker> {
    if (this.compilerStandby) return this.compilerStandby;
    this.assertActive();
    const generation = this.generation;
    const client = this.options.createWorkerClient();
    this.compilerWorkers.add(client);
    const standby = client.warmup().then(
      (warmup) => {
        if (generation !== this.generation || this.terminated) {
          this.retireCompiler(client);
          throw new Error('Prepared Python compiler warmup was superseded.');
        }
        return { client, warmup };
      },
      (error: unknown) => {
        if (generation === this.generation) this.compilerStandby = null;
        this.retireCompiler(client);
        throw error;
      }
    );
    this.compilerStandby = standby;
    void standby.catch(() => undefined);
    return standby;
  }

  private async takeCompilerStandby(): Promise<WarmedPythonWorker> {
    const standby = this.compilerStandby ?? this.startCompilerStandby();
    this.compilerStandby = null;
    return standby;
  }

  private retireCompiler(client: PythonWorkerClient): void {
    if (!this.compilerWorkers.delete(client)) return;
    client.terminate();
  }

  private assertActive(): void {
    if (this.terminated) {
      throw new Error('Prepared Python execution provider has been terminated.');
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
