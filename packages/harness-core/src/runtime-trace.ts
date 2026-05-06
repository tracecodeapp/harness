import type { Language } from './runtime-types';

export const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';

export type RuntimeTraceEventKind =
  | 'line'
  | 'call'
  | 'return'
  | 'read'
  | 'write'
  | 'mutate'
  | 'snapshot'
  | 'stdout'
  | 'exception'
  | 'timeout';

export type RuntimeTraceTarget =
  | { variable: string; scope?: 'local' | 'global' | 'builtin' | 'receiver' }
  | { variable: string; path: Array<string | number>; scope?: 'local' | 'global' | 'builtin' | 'receiver' }
  | { objectId: string; path?: Array<string | number> };

interface RuntimeTraceBaseEvent {
  kind: RuntimeTraceEventKind;
  runId: string;
  file?: string;
  line?: number;
  frameId?: string;
}

export type RuntimeTraceEvent =
  | (RuntimeTraceBaseEvent & { kind: 'line'; line: number; function?: string })
  | (RuntimeTraceBaseEvent & { kind: 'call'; line: number; function: string; args?: Record<string, unknown> })
  | (RuntimeTraceBaseEvent & { kind: 'return'; line: number; function?: string; value?: unknown })
  | (RuntimeTraceBaseEvent & { kind: 'read' | 'write'; line: number; target: RuntimeTraceTarget; value?: unknown })
  | (RuntimeTraceBaseEvent & { kind: 'mutate'; line: number; target: RuntimeTraceTarget; method?: string; args?: unknown[] })
  | (RuntimeTraceBaseEvent & { kind: 'snapshot'; line: number; target: RuntimeTraceTarget; value: unknown })
  | (RuntimeTraceBaseEvent & { kind: 'stdout'; text: string })
  | (RuntimeTraceBaseEvent & { kind: 'exception' | 'timeout'; message: string });

export interface RuntimeTrace {
  schemaVersion: typeof RUNTIME_TRACE_SCHEMA_VERSION;
  language: Language;
  runId: string;
  events: RuntimeTraceEvent[];
  lineEventCount: number;
  traceStepCount: number;
}

export interface RuntimeTraceOptions {
  runId?: string;
  file?: string;
}

export function createEmptyRuntimeTrace(
  language: Language,
  options: RuntimeTraceOptions = {}
): RuntimeTrace {
  return {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language,
    runId: options.runId ?? `${language}:run`,
    events: [],
    lineEventCount: 0,
    traceStepCount: 0,
  };
}

export interface RuntimeTraceParityAccessTarget {
  kind: 'read' | 'write' | 'mutate';
  variable?: string;
  pathDepth?: number;
}

export interface RuntimeTraceParitySignature {
  lineSequence: number[];
  eventKindsByLine: Record<number, RuntimeTraceEventKind[]>;
  variableSnapshotsByLine: Record<number, string[]>;
  accessTargetsByLine: Record<number, RuntimeTraceParityAccessTarget[]>;
  callReturnShape: Array<'call' | 'return'>;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortedUniqueEventKinds(values: RuntimeTraceEventKind[]): RuntimeTraceEventKind[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function withRuntimeTraceOptions(
  trace: RuntimeTrace,
  options: RuntimeTraceOptions = {}
): RuntimeTrace {
  const runId = options.runId ?? trace.runId;
  return {
    ...trace,
    runId,
    events: trace.events.map((event) => ({
      ...event,
      runId,
      ...(options.file ? { file: options.file } : {}),
    })),
  };
}

export function buildRuntimeTraceParitySignature(trace: RuntimeTrace): RuntimeTraceParitySignature {
  const lineSequence: number[] = [];
  const eventKindsByLine = new Map<number, RuntimeTraceEventKind[]>();
  const variableSnapshotsByLine = new Map<number, string[]>();
  const accessTargetsByLine = new Map<number, RuntimeTraceParityAccessTarget[]>();
  const callReturnShape: Array<'call' | 'return'> = [];

  for (const event of trace.events) {
    if (event.kind === 'line' && typeof event.line === 'number') {
      lineSequence.push(event.line);
    }

    if (event.kind === 'call' || event.kind === 'return') {
      callReturnShape.push(event.kind);
    }

    if (typeof event.line === 'number') {
      const kinds = eventKindsByLine.get(event.line) ?? [];
      kinds.push(event.kind);
      eventKindsByLine.set(event.line, kinds);
    }

    if (event.kind === 'snapshot' && 'variable' in event.target && typeof event.line === 'number') {
      const variables = variableSnapshotsByLine.get(event.line) ?? [];
      variables.push(event.target.variable);
      variableSnapshotsByLine.set(event.line, variables);
    }

    if (
      (event.kind === 'read' || event.kind === 'write' || event.kind === 'mutate') &&
      'variable' in event.target &&
      typeof event.line === 'number'
    ) {
      const accesses = accessTargetsByLine.get(event.line) ?? [];
      accesses.push({
        kind: event.kind,
        variable: event.target.variable,
        pathDepth: 'path' in event.target && Array.isArray(event.target.path)
          ? event.target.path.length
          : undefined,
      });
      accessTargetsByLine.set(event.line, accesses);
    }
  }

  return {
    lineSequence,
    eventKindsByLine: Object.fromEntries(
      [...eventKindsByLine.entries()].map(([line, kinds]) => [
        line,
        sortedUniqueEventKinds(kinds),
      ])
    ),
    variableSnapshotsByLine: Object.fromEntries(
      [...variableSnapshotsByLine.entries()].map(([line, variables]) => [
        line,
        sortedUnique(variables),
      ])
    ),
    accessTargetsByLine: Object.fromEntries(
      [...accessTargetsByLine.entries()].map(([line, accesses]) => [
        line,
        accesses.sort((left, right) => {
          const leftKey = `${left.kind}:${left.variable ?? ''}:${left.pathDepth ?? 0}`;
          const rightKey = `${right.kind}:${right.variable ?? ''}:${right.pathDepth ?? 0}`;
          return leftKey.localeCompare(rightKey);
        }),
      ])
    ),
    callReturnShape,
  };
}
