import type { Language } from './runtime-types';
import type { RawTraceStep, RuntimeTraceAccessEvent } from './types';
import type { RuntimeV4Trace } from './trace-v4';

export type RuntimeRawEmissionKind =
  | 'line'
  | 'call'
  | 'return'
  | 'exception'
  | 'stdout'
  | 'snapshot'
  | 'read'
  | 'write'
  | 'mutate'
  | 'legacy-visualization-state';

export interface RuntimeRawEmissionSummary {
  language: Language;
  kinds: RuntimeRawEmissionKind[];
  unsupported: string[];
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function extractJavaPayload(event: string): string {
  const match = event.match(/^line=\d+(?:\s+(.*))?$/);
  if (!match) return event;
  return match[1] ?? '';
}

function isJavaLineEvent(event: string): boolean {
  return /^line=\d+(?:\s+.*)?$/.test(event);
}

function javaNativeV4PayloadKind(event: string): RuntimeRawEmissionKind | null {
  if (!event.startsWith('v4:')) return null;
  try {
    const parsed = JSON.parse(event.slice('v4:'.length)) as { kind?: unknown };
    if (parsed.kind === 'line') return 'line';
    if (parsed.kind === 'call') return 'call';
    if (parsed.kind === 'return') return 'return';
    if (parsed.kind === 'exception') return 'exception';
    if (parsed.kind === 'stdout') return 'stdout';
    if (parsed.kind === 'snapshot') return 'snapshot';
    if (parsed.kind === 'read') return 'read';
    if (parsed.kind === 'write') return 'write';
    if (parsed.kind === 'mutate') return 'mutate';
  } catch {
    return null;
  }
  return null;
}

function javaPayloadKind(payload: string): RuntimeRawEmissionKind | null {
  if (payload.length === 0) return 'line';
  if (payload.startsWith('call ')) return 'call';
  if (payload.startsWith('return ')) return 'return';
  if (payload.startsWith('exception ')) return 'exception';
  if (payload.startsWith('stdout ')) return 'stdout';
  if (payload.startsWith('access ')) return 'read';
  if (payload.startsWith('write ') || payload.startsWith('write-array ')) return 'write';
  if (payload.startsWith('mutate ') || payload.startsWith('mutate-indexed ') || payload.startsWith('keyed-call ')) return 'mutate';
  if (
    payload.startsWith('state ') ||
    payload.startsWith('object-state ') ||
    payload.startsWith('map-state ') ||
    payload.startsWith('set-state ')
  ) {
    return 'legacy-visualization-state';
  }
  if (/^[A-Za-z_][A-Za-z0-9_.]*=/.test(payload)) return 'snapshot';
  return null;
}

export function summarizeJavaRawEmissions(events: string[]): RuntimeRawEmissionSummary {
  const kinds: RuntimeRawEmissionKind[] = [];
  const unsupported: string[] = [];

  for (const event of events) {
    const nativeKind = javaNativeV4PayloadKind(event);
    if (nativeKind) {
      kinds.push(nativeKind);
      continue;
    }
    if (isJavaLineEvent(event)) {
      kinds.push('line');
    }
    const payload = extractJavaPayload(event);
    const kind = javaPayloadKind(payload);
    if (kind && kind !== 'line') {
      kinds.push(kind);
    } else {
      if (kind === 'line') continue;
      unsupported.push(event);
    }
  }

  return {
    language: 'java',
    kinds: sortedUnique(kinds),
    unsupported,
  };
}

function accessKind(access: RuntimeTraceAccessEvent): RuntimeRawEmissionKind {
  if (access.kind === 'indexed-read' || access.kind === 'cell-read') return 'read';
  if (access.kind === 'indexed-write' || access.kind === 'cell-write') return 'write';
  return 'mutate';
}

export function summarizeRawTraceEmissions(language: Language, trace: RawTraceStep[]): RuntimeRawEmissionSummary {
  const kinds: RuntimeRawEmissionKind[] = [];

  for (const step of trace) {
    if (step.event === 'line') kinds.push('line');
    if (step.event === 'call') kinds.push('call');
    if (step.event === 'return') kinds.push('return');
    if (step.event === 'exception') kinds.push('exception');
    if (step.event === 'stdout') kinds.push('stdout');
    if (Object.keys(step.variables ?? {}).length > 0) kinds.push('snapshot');
    for (const access of step.accesses ?? []) {
      kinds.push(accessKind(access));
    }
    if (step.visualization) {
      kinds.push('legacy-visualization-state');
    }
  }

  return {
    language,
    kinds: sortedUnique(kinds),
    unsupported: [],
  };
}

export function summarizeRuntimeV4Emissions(trace: RuntimeV4Trace): RuntimeRawEmissionSummary {
  const kinds: RuntimeRawEmissionKind[] = [];
  for (const event of trace.events) {
    if (event.kind === 'line') kinds.push('line');
    if (event.kind === 'call') kinds.push('call');
    if (event.kind === 'return') kinds.push('return');
    if (event.kind === 'exception') kinds.push('exception');
    if (event.kind === 'stdout') kinds.push('stdout');
    if (event.kind === 'snapshot') kinds.push('snapshot');
    if (event.kind === 'read') kinds.push('read');
    if (event.kind === 'write') kinds.push('write');
    if (event.kind === 'mutate') kinds.push('mutate');
    if (JSON.stringify(event).includes('visualization')) kinds.push('legacy-visualization-state');
  }
  return {
    language: trace.language,
    kinds: sortedUnique(kinds),
    unsupported: [],
  };
}

export function assertSupportedRawEmissions(summary: RuntimeRawEmissionSummary, label: string): void {
  if (summary.unsupported.length > 0) {
    throw new Error(
      `${label} emitted unsupported raw runtime payloads:\n${summary.unsupported.slice(0, 20).join('\n')}`
    );
  }
}

export interface RuntimeRawEmissionParityMismatch {
  language: Language;
  missing: RuntimeRawEmissionKind[];
  extra: RuntimeRawEmissionKind[];
}

const RAW_PARITY_IGNORED_KINDS = new Set<RuntimeRawEmissionKind>([
  // Legacy visualization state exists while the raw trace bridge is still being
  // retired. It must never create V4 facts directly, so it is ignored for the
  // coarse cross-language emission parity signal.
  'legacy-visualization-state',
]);

function parityKinds(summary: RuntimeRawEmissionSummary): RuntimeRawEmissionKind[] {
  return summary.kinds.filter((kind) => !RAW_PARITY_IGNORED_KINDS.has(kind));
}

export function compareRawEmissionParity(
  reference: RuntimeRawEmissionSummary,
  summaries: RuntimeRawEmissionSummary[]
): RuntimeRawEmissionParityMismatch[] {
  const expected = new Set(parityKinds(reference));
  const mismatches: RuntimeRawEmissionParityMismatch[] = [];

  for (const summary of summaries) {
    if (summary.language === reference.language) continue;
    const actual = new Set(parityKinds(summary));
    const missing = [...expected].filter((kind) => !actual.has(kind)).sort((left, right) => left.localeCompare(right));
    const extra = [...actual].filter((kind) => !expected.has(kind)).sort((left, right) => left.localeCompare(right));
    if (missing.length > 0 || extra.length > 0) {
      mismatches.push({ language: summary.language, missing, extra });
    }
  }

  return mismatches;
}
