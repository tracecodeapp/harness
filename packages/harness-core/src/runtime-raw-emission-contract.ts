import type { Language } from './runtime-types';
import type { RuntimeTrace } from './runtime-trace';

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
  | 'visualization-state';

export interface RuntimeRawEmissionSummary {
  language: Language;
  kinds: RuntimeRawEmissionKind[];
  unsupported: string[];
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function javaNativeTracePayloadKind(event: string): RuntimeRawEmissionKind | null {
  if (!event.startsWith('trace:')) return null;
  try {
    const parsed = JSON.parse(event.slice('trace:'.length)) as { kind?: unknown };
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

export function summarizeJavaRawEmissions(events: string[]): RuntimeRawEmissionSummary {
  const kinds: RuntimeRawEmissionKind[] = [];
  const unsupported: string[] = [];

  for (const event of events) {
    const nativeKind = javaNativeTracePayloadKind(event);
    if (nativeKind) {
      kinds.push(nativeKind);
      continue;
    }
    unsupported.push(event);
  }

  return {
    language: 'java',
    kinds: sortedUnique(kinds),
    unsupported,
  };
}

export function summarizeRuntimeTraceEmissions(trace: RuntimeTrace): RuntimeRawEmissionSummary {
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
    if (JSON.stringify(event).includes('visualization')) kinds.push('visualization-state');
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
  // Visualization state exists while the raw trace bridge is still being
  // retired. It must never create runtime trace facts directly, so it is ignored for the
  // coarse cross-language emission parity signal.
  'visualization-state',
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
