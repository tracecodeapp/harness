import type { Language } from './runtime-types';

export const RUNTIME_TRACE_V4_DRAFT_SCHEMA_VERSION = 'v4-draft-2026-04-28';

export type RuntimeV4EventKind =
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

export type RuntimeV4Target =
  | { variable: string }
  | { variable: string; path: Array<string | number> }
  | { objectId: string; path?: Array<string | number> };

interface RuntimeV4BaseEvent {
  kind: RuntimeV4EventKind;
  runId: string;
  file?: string;
  line?: number;
  frameId?: string;
}

export type RuntimeV4Event =
  | (RuntimeV4BaseEvent & { kind: 'line'; line: number; function?: string })
  | (RuntimeV4BaseEvent & { kind: 'call'; line: number; function: string; args?: Record<string, unknown> })
  | (RuntimeV4BaseEvent & { kind: 'return'; line: number; function?: string; value?: unknown })
  | (RuntimeV4BaseEvent & { kind: 'read' | 'write'; line: number; target: RuntimeV4Target; value?: unknown })
  | (RuntimeV4BaseEvent & { kind: 'mutate'; line: number; target: RuntimeV4Target; method?: string; args?: unknown[] })
  | (RuntimeV4BaseEvent & { kind: 'snapshot'; line: number; target: RuntimeV4Target; value: unknown })
  | (RuntimeV4BaseEvent & { kind: 'stdout'; text: string })
  | (RuntimeV4BaseEvent & { kind: 'exception' | 'timeout'; message: string });

export interface RuntimeV4Trace {
  schemaVersion: typeof RUNTIME_TRACE_V4_DRAFT_SCHEMA_VERSION;
  language: Language;
  runId: string;
  events: RuntimeV4Event[];
  lineEventCount: number;
  traceStepCount: number;
}

export interface RuntimeV4TraceOptions {
  runId?: string;
  file?: string;
}

export function createEmptyRuntimeV4Trace(
  language: Language,
  options: RuntimeV4TraceOptions = {}
): RuntimeV4Trace {
  return {
    schemaVersion: RUNTIME_TRACE_V4_DRAFT_SCHEMA_VERSION,
    language,
    runId: options.runId ?? `${language}:run`,
    events: [],
    lineEventCount: 0,
    traceStepCount: 0,
  };
}

export interface RuntimeV4ParityAccessTarget {
  kind: 'read' | 'write' | 'mutate';
  variable?: string;
  pathDepth?: number;
  method?: string;
}

export interface RuntimeV4ParitySignature {
  lineSequence: number[];
  eventKindsByLine: Record<number, RuntimeV4EventKind[]>;
  variableSnapshotsByLine: Record<number, string[]>;
  accessTargetsByLine: Record<number, RuntimeV4ParityAccessTarget[]>;
  callReturnShape: Array<'call' | 'return'>;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortedUniqueEventKinds(values: RuntimeV4EventKind[]): RuntimeV4EventKind[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function withRuntimeV4TraceOptions(
  trace: RuntimeV4Trace,
  options: RuntimeV4TraceOptions = {}
): RuntimeV4Trace {
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

export function buildRuntimeV4ParitySignature(trace: RuntimeV4Trace): RuntimeV4ParitySignature {
  const lineSequence: number[] = [];
  const eventKindsByLine = new Map<number, RuntimeV4EventKind[]>();
  const variableSnapshotsByLine = new Map<number, string[]>();
  const accessTargetsByLine = new Map<number, RuntimeV4ParityAccessTarget[]>();
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
        ...(event.kind === 'mutate' && event.method ? { method: event.method } : {}),
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
          const leftKey = `${left.kind}:${left.variable ?? ''}:${left.pathDepth ?? 0}:${left.method ?? ''}`;
          const rightKey = `${right.kind}:${right.variable ?? ''}:${right.pathDepth ?? 0}:${right.method ?? ''}`;
          return leftKey.localeCompare(rightKey);
        }),
      ])
    ),
    callReturnShape,
  };
}
