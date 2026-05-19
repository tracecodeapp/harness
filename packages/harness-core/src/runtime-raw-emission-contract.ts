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
  | 'timeout';

export interface RuntimeRawEmissionSummary {
  language: Language;
  kinds: RuntimeRawEmissionKind[];
  unsupported: string[];
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const FORBIDDEN_RUNTIME_TRACE_TOKENS = [
  'visualization',
  'objectKinds',
  'hashMaps',
  'graph-adjacency',
  'linked-list',
  'tree',
] as const;

const FORBIDDEN_RUNTIME_TRACE_KEYS = new Set([
  'visualization',
  'objectKinds',
  'hashMaps',
  'graph-adjacency',
  'linked-list',
]);

export function normalizeJavaNativeTraceJsonPayload(payload: string): string {
  return payload
    .replace(/(?<![A-Za-z0-9_"])-Infinity(?![A-Za-z0-9_"])/g, '"-Infinity"')
    .replace(/(?<![A-Za-z0-9_"])Infinity(?![A-Za-z0-9_"])/g, '"Infinity"')
    .replace(/(?<![A-Za-z0-9_"])NaN(?![A-Za-z0-9_"])/g, '"NaN"');
}

function forbiddenRuntimeTraceTokens(value: unknown): string[] {
  const tokens = new Set<string>();
  collectForbiddenRuntimeTraceTokens(value, tokens, null, false);
  return FORBIDDEN_RUNTIME_TRACE_TOKENS.filter((token) => tokens.has(token));
}

function collectForbiddenRuntimeTraceTokens(
  value: unknown,
  tokens: Set<string>,
  parentKey: string | null,
  semanticPayload: boolean
): void {
  if (typeof value === 'string') {
    if (
      (semanticPayload || parentKey === 'kind' || parentKey === 'type' || parentKey === 'category') &&
      (FORBIDDEN_RUNTIME_TRACE_TOKENS as readonly string[]).includes(value)
    ) {
      tokens.add(value);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenRuntimeTraceTokens(item, tokens, parentKey, semanticPayload);
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const objectSemanticPayload = entries.some(([key, child]) => {
    if (parentKey !== 'args' && FORBIDDEN_RUNTIME_TRACE_KEYS.has(key)) return true;
    return (
      (key === 'kind' || key === 'type' || key === 'category') &&
      typeof child === 'string' &&
      (FORBIDDEN_RUNTIME_TRACE_TOKENS as readonly string[]).includes(child)
    );
  });
  for (const [key, child] of entries) {
    if (parentKey !== 'args' && FORBIDDEN_RUNTIME_TRACE_KEYS.has(key)) {
      tokens.add(key);
    }
    if (key === 'target' || key === 'variable' || key === 'function') continue;
    collectForbiddenRuntimeTraceTokens(child, tokens, key, semanticPayload || objectSemanticPayload);
  }
}

function unsupportedForbiddenPayload(label: string, value: unknown): string | null {
  const tokens = forbiddenRuntimeTraceTokens(value);
  if (tokens.length === 0) return null;
  return `${label} contains forbidden runtime trace token(s): ${tokens.join(', ')}`;
}

function javaNativeTracePayloadKind(event: string): RuntimeRawEmissionKind | null {
  if (!event.startsWith('trace:')) return null;
  try {
    const parsed = JSON.parse(normalizeJavaNativeTraceJsonPayload(event.slice('trace:'.length))) as { kind?: unknown };
    if (parsed.kind === 'line') return 'line';
    if (parsed.kind === 'call') return 'call';
    if (parsed.kind === 'return') return 'return';
    if (parsed.kind === 'exception') return 'exception';
    if (parsed.kind === 'timeout') return 'timeout';
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

  for (const [index, event] of events.entries()) {
    if (event.startsWith('trace:')) {
      try {
        const parsed = JSON.parse(normalizeJavaNativeTraceJsonPayload(event.slice('trace:'.length))) as unknown;
        const forbiddenPayload = unsupportedForbiddenPayload(`java trace event ${index}`, parsed);
        if (forbiddenPayload) {
          unsupported.push(forbiddenPayload);
          continue;
        }
      } catch {
        // Let the native-kind check below classify malformed trace payloads as unsupported.
      }
    }
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
  const unsupported: string[] = [];
  for (const [index, event] of trace.events.entries()) {
    const forbiddenPayload = unsupportedForbiddenPayload(`${trace.language} trace event ${index}`, event);
    if (forbiddenPayload) {
      unsupported.push(forbiddenPayload);
      continue;
    }
    switch (event.kind) {
      case 'line':
      case 'call':
      case 'return':
      case 'exception':
      case 'timeout':
      case 'stdout':
      case 'snapshot':
      case 'read':
      case 'write':
      case 'mutate':
        kinds.push(event.kind);
        break;
      default:
        unsupported.push(`${trace.language} trace event ${index} has unsupported kind "${String((event as { kind?: unknown }).kind)}"`);
    }
  }
  return {
    language: trace.language,
    kinds: sortedUnique(kinds),
    unsupported,
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

function parityKinds(summary: RuntimeRawEmissionSummary): RuntimeRawEmissionKind[] {
  return summary.kinds;
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
