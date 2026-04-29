import type { Language } from './runtime-types';
import type { ExecutionResult, RuntimeTraceAccessEvent } from './types';
import {
  normalizeRuntimeTraceContract,
  type RuntimeTraceContractResult,
  type RuntimeTraceContractStep,
} from './trace-contract';

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

/**
 * Migration bridge only.
 *
 * V4's end state is for each language runtime to emit RuntimeV4Trace directly.
 * This converter exists to bootstrap the parity corpus while the harness still
 * has legacy RuntimeTraceContract producers. Do not treat this as the permanent
 * V4 production path or add new semantics here to make old traces look V4-like.
 */
const MUTATION_METHOD_ALIASES: Record<string, string> = {
  add: 'append',
  append: 'append',
  push: 'append',
  put: 'set',
  set: 'set',
};

function frameIdForStep(step: RuntimeTraceContractStep): string {
  const stack = step.callStack ?? [];
  if (stack.length > 0) {
    const frame = stack[stack.length - 1];
    return `${frame.function}:${frame.line}`;
  }
  return `${step.function}:${step.line}`;
}

function targetForAccess(access: RuntimeTraceAccessEvent): RuntimeV4Target {
  const indices = Array.isArray(access.indices) ? access.indices : [];
  if (indices.length > 0) {
    return { variable: access.variable, path: indices };
  }
  return { variable: access.variable };
}

function valueAtPath(value: unknown, path: Array<string | number> | undefined): unknown {
  if (!path || path.length === 0) return value;
  let current = value;
  for (const part of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[String(part)];
  }
  return current;
}

function valueForAccess(step: RuntimeTraceContractStep, access: RuntimeTraceAccessEvent): unknown {
  const root = step.variables?.[access.variable];
  return valueAtPath(root, access.indices);
}

function accessKindToEventKind(access: RuntimeTraceAccessEvent): 'read' | 'write' | 'mutate' {
  if (access.kind === 'indexed-read' || access.kind === 'cell-read') return 'read';
  if (access.kind === 'indexed-write' || access.kind === 'cell-write') return 'write';
  return 'mutate';
}

function normalizeMutationMethod(method: string | undefined): string | undefined {
  if (!method) return undefined;
  return MUTATION_METHOD_ALIASES[method] ?? method;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortedUniqueEventKinds(values: RuntimeV4EventKind[]): RuntimeV4EventKind[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function runtimeTraceContractToV4Events(
  contract: RuntimeTraceContractResult,
  options: RuntimeV4TraceOptions = {}
): RuntimeV4Trace {
  const runId = options.runId ?? `${contract.language}:run`;
  const events: RuntimeV4Event[] = [];

  for (const step of contract.trace) {
    const frameId = frameIdForStep(step);
    const base = {
      runId,
      ...(options.file ? { file: options.file } : {}),
      line: step.line,
      frameId,
    };

    if (step.event === 'line') {
      events.push({ ...base, kind: 'line', function: step.function });
    } else if (step.event === 'call') {
      events.push({
        ...base,
        kind: 'call',
        function: step.function,
        args: step.callStack?.at(-1)?.args,
      });
    } else if (step.event === 'return') {
      events.push({
        ...base,
        kind: 'return',
        function: step.function,
        ...(step.returnValue !== undefined ? { value: step.returnValue } : {}),
      });
    } else if (step.event === 'exception') {
      events.push({
        ...base,
        kind: 'exception',
        message: typeof step.returnValue === 'string' ? step.returnValue : 'Runtime exception',
      });
    } else if (step.event === 'timeout') {
      events.push({ ...base, kind: 'timeout', message: 'Runtime timeout' });
    } else if (step.event === 'stdout') {
      events.push({
        kind: 'stdout',
        runId,
        ...(options.file ? { file: options.file } : {}),
        ...(step.line ? { line: step.line } : {}),
        text: String(step.stdoutLineCount ?? ''),
      });
    }

    for (const [variable, value] of Object.entries(step.variables ?? {})) {
      events.push({
        ...base,
        kind: 'snapshot',
        target: { variable },
        value,
      });
    }

    for (const access of step.accesses ?? []) {
      const kind = accessKindToEventKind(access);
      const target = targetForAccess(access);
      if (kind === 'mutate') {
        events.push({
          ...base,
          kind,
          target,
          ...(normalizeMutationMethod(access.method) ? { method: normalizeMutationMethod(access.method) } : {}),
        });
      } else {
        events.push({
          ...base,
          kind,
          target,
          value: valueForAccess(step, access),
        });
      }
    }
  }

  return {
    schemaVersion: RUNTIME_TRACE_V4_DRAFT_SCHEMA_VERSION,
    language: contract.language,
    runId,
    events,
    lineEventCount: contract.lineEventCount,
    traceStepCount: contract.traceStepCount,
  };
}

export function executionResultToV4Trace(
  language: Language,
  result: ExecutionResult,
  options: RuntimeV4TraceOptions = {}
): RuntimeV4Trace {
  return runtimeTraceContractToV4Events(
    normalizeRuntimeTraceContract(language, result),
    options
  );
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
