import type { PythonProjectCommandRequest, PythonWorkerClient } from './python-worker-client';
import type {
  RuntimeClient,
  RuntimeCodeCall,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
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
const PYTHON_TRACE_TIMEOUT_REASONS = new Set(['trace-limit', 'line-limit', 'single-line-limit', 'client-timeout']);
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
    },
    normalizePythonRuntimeTrace(record.trace),
    'Python tracing failed'
  );
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

export function createPythonRuntimeClient(workerClient: PythonWorkerClient): RuntimeClient {
  return new PythonRuntimeClient(workerClient);
}
