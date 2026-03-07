import type { Language } from './runtime-types';
import type {
  CallStackFrame,
  ExecutionResult,
  RawTraceStep,
  RuntimeObjectKind,
  RuntimeVisualizationPayload,
} from './types';

/**
 * Runtime trace contract schema version.
 *
 * Bump this when payload shape/normalization semantics change in a way that
 * should invalidate golden fixtures.
 */
export const RUNTIME_TRACE_CONTRACT_SCHEMA_VERSION = '2026-02-28';

export type RuntimeTraceContractEvent =
  | 'line'
  | 'call'
  | 'return'
  | 'exception'
  | 'timeout'
  | 'stdout';

export interface RuntimeTraceContractHashMapEntry {
  key: unknown;
  value: unknown;
  highlight?: boolean;
}

export interface RuntimeTraceContractHashMap {
  name: string;
  kind: 'hashmap' | 'map' | 'set';
  entries: RuntimeTraceContractHashMapEntry[];
  highlightedKey?: unknown;
  deletedKey?: unknown;
}

export interface RuntimeTraceContractVisualization {
  hashMaps?: RuntimeTraceContractHashMap[];
  objectKinds?: Partial<Record<string, RuntimeObjectKind>>;
}

export interface RuntimeTraceContractCallStackFrame {
  function: string;
  line: number;
  args: Record<string, unknown>;
}

export interface RuntimeTraceContractStep {
  event: RuntimeTraceContractEvent;
  line: number;
  function: string;
  variables: Record<string, unknown>;
  callStack?: RuntimeTraceContractCallStackFrame[];
  returnValue?: unknown;
  stdoutLineCount?: number;
  visualization?: RuntimeTraceContractVisualization;
}

export interface RuntimeTraceContractResult {
  schemaVersion: typeof RUNTIME_TRACE_CONTRACT_SCHEMA_VERSION;
  language: Language;
  success: boolean;
  output?: unknown;
  error?: string;
  errorLine?: number;
  consoleOutput: string[];
  trace: RuntimeTraceContractStep[];
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
  lineEventCount: number;
  traceStepCount: number;
}

const TRACE_EVENTS: ReadonlySet<string> = new Set([
  'line',
  'call',
  'return',
  'exception',
  'timeout',
  'stdout',
]);

function normalizeLineNumber(value: unknown, fallback = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeOutputLineCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
}

function normalizeEvent(value: unknown): RuntimeTraceContractEvent {
  if (typeof value === 'string' && TRACE_EVENTS.has(value)) {
    return value as RuntimeTraceContractEvent;
  }
  return 'line';
}

function normalizeFunctionName(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return '<module>';
}

function normalizeKind(value: unknown): 'hashmap' | 'map' | 'set' {
  if (value === 'map' || value === 'set' || value === 'hashmap') {
    return value;
  }
  return 'hashmap';
}

function normalizeObjectKind(value: unknown): RuntimeObjectKind | null {
  if (
    value === 'hashmap' ||
    value === 'map' ||
    value === 'set' ||
    value === 'tree' ||
    value === 'linked-list' ||
    value === 'graph-adjacency'
  ) {
    return value;
  }
  return null;
}

function normalizeScalar(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : String(value);
  }
  if (typeof value === 'function') return '<function>';
  return null;
}

function normalizeUnknown(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 48) return '<max depth>';

  const scalar = normalizeScalar(value);
  if (scalar !== null || value === null || value === undefined) {
    return scalar;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined) return null;
      return normalizeUnknown(item, depth + 1, seen);
    });
  }

  if (typeof value === 'object' && value) {
    if (seen.has(value)) return '<cycle>';
    seen.add(value);

    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      normalized[key] = normalizeUnknown(child, depth + 1, seen);
    }

    seen.delete(value);
    return normalized;
  }

  return String(value);
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return normalizeUnknown(value) as Record<string, unknown>;
}

function normalizeCallStackFrame(frame: CallStackFrame): RuntimeTraceContractCallStackFrame {
  return {
    function: normalizeFunctionName(frame?.function),
    line: normalizeLineNumber(frame?.line, 1),
    args: normalizeRecord(frame?.args),
  };
}

function normalizeVisualizationPayload(
  payload: RuntimeVisualizationPayload | undefined
): RuntimeTraceContractVisualization | undefined {
  const hashMaps = Array.isArray(payload?.hashMaps)
    ? payload.hashMaps
        .map((entry) => ({
          name: typeof entry?.name === 'string' ? entry.name : '',
          kind: normalizeKind(entry?.kind),
          entries: Array.isArray(entry?.entries)
            ? entry.entries.map((item) => ({
                key: normalizeUnknown(item?.key),
                value: normalizeUnknown(item?.value),
                ...(item?.highlight ? { highlight: true } : {}),
              }))
            : [],
          ...(entry?.highlightedKey !== undefined
            ? { highlightedKey: normalizeUnknown(entry.highlightedKey) }
            : {}),
          ...(entry?.deletedKey !== undefined
            ? { deletedKey: normalizeUnknown(entry.deletedKey) }
            : {}),
        }))
        .sort((a, b) => `${a.name}:${a.kind}`.localeCompare(`${b.name}:${b.kind}`))
    : [];

  const objectKinds =
    payload?.objectKinds && typeof payload.objectKinds === 'object'
      ? Object.fromEntries(
          Object.entries(payload.objectKinds)
            .filter(([name]) => typeof name === 'string' && name.length > 0)
            .map(([name, kind]) => [name, normalizeObjectKind(kind)])
            .filter((entry): entry is [string, RuntimeObjectKind] => entry[1] !== null)
            .sort((a, b) => a[0].localeCompare(b[0]))
        )
      : undefined;

  if (hashMaps.length === 0 && (!objectKinds || Object.keys(objectKinds).length === 0)) {
    return undefined;
  }

  return {
    ...(hashMaps.length > 0 ? { hashMaps } : {}),
    ...(objectKinds && Object.keys(objectKinds).length > 0 ? { objectKinds } : {}),
  };
}

function normalizeTraceStep(step: RawTraceStep): RuntimeTraceContractStep {
  const normalizedStdoutCount = normalizeOutputLineCount(step?.stdoutLineCount);
  const normalizedVisualization = normalizeVisualizationPayload(step?.visualization);

  return {
    event: normalizeEvent(step?.event),
    line: normalizeLineNumber(step?.line, 1),
    function: normalizeFunctionName(step?.function),
    variables: normalizeRecord(step?.variables),
    ...(Array.isArray(step?.callStack) && step.callStack.length > 0
      ? { callStack: step.callStack.map(normalizeCallStackFrame) }
      : {}),
    ...(step?.returnValue !== undefined ? { returnValue: normalizeUnknown(step.returnValue) } : {}),
    ...(normalizedStdoutCount !== undefined ? { stdoutLineCount: normalizedStdoutCount } : {}),
    ...(normalizedVisualization ? { visualization: normalizedVisualization } : {}),
  };
}

export function normalizeRuntimeTraceContract(
  language: Language,
  result: ExecutionResult
): RuntimeTraceContractResult {
  const normalizedTrace = Array.isArray(result.trace) ? result.trace.map(normalizeTraceStep) : [];
  const lineEventCount =
    typeof result.lineEventCount === 'number' && Number.isFinite(result.lineEventCount)
      ? Math.floor(result.lineEventCount)
      : normalizedTrace.filter((step) => step.event === 'line').length;

  const normalizedConsole = Array.isArray(result.consoleOutput)
    ? result.consoleOutput.map((line) => String(line))
    : [];

  return {
    schemaVersion: RUNTIME_TRACE_CONTRACT_SCHEMA_VERSION,
    language,
    success: Boolean(result.success),
    ...(Object.prototype.hasOwnProperty.call(result, 'output')
      ? { output: normalizeUnknown(result.output) }
      : {}),
    ...(typeof result.error === 'string' && result.error.length > 0
      ? { error: result.error }
      : {}),
    ...(typeof result.errorLine === 'number' && Number.isFinite(result.errorLine)
      ? { errorLine: Math.floor(result.errorLine) }
      : {}),
    consoleOutput: normalizedConsole,
    trace: normalizedTrace,
    ...(result.traceLimitExceeded !== undefined
      ? { traceLimitExceeded: Boolean(result.traceLimitExceeded) }
      : {}),
    ...(typeof result.timeoutReason === 'string' && result.timeoutReason.length > 0
      ? { timeoutReason: result.timeoutReason }
      : {}),
    lineEventCount: Math.max(0, lineEventCount),
    traceStepCount: normalizedTrace.length,
  };
}

export function stableStringifyRuntimeTraceContract(value: unknown): string {
  return JSON.stringify(normalizeUnknown(value), null, 2);
}
