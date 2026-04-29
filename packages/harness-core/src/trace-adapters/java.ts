import {
  RUNTIME_TRACE_V4_DRAFT_SCHEMA_VERSION,
  type RuntimeV4Event,
  type RuntimeV4Trace,
  type RuntimeV4TraceOptions,
} from '../trace-v4';
import { assertSupportedRawEmissions, summarizeJavaRawEmissions } from '../runtime-raw-emission-contract';

export function normalizeJavaSerializedResult(output: unknown): unknown {
  if (typeof output !== 'string') {
    return output;
  }
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
}

function isNativeJavaV4Event(event: string): boolean {
  return event.startsWith('v4:');
}

function stripInlineComments(line: string, inBlockComment: boolean): { text: string; inBlockComment: boolean } {
  let result = '';
  let index = 0;
  let inBlock = inBlockComment;
  while (index < line.length) {
    const current = line[index];
    const next = index + 1 < line.length ? line[index + 1] : '';

    if (inBlock) {
      if (current === '*' && next === '/') {
        inBlock = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      inBlock = true;
      index += 2;
      continue;
    }

    if (current === '/' && next === '/') break;
    result += current;
    index += 1;
  }

  return { text: result, inBlockComment: inBlock };
}

function isMethodDeclarationLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('@')) return false;
  if (!trimmed.includes('(') || !trimmed.includes(')')) return false;
  if (trimmed.endsWith(';')) return false;
  if (trimmed.includes('->')) return false;
  if (/^(?:if|for|while|switch|catch|do|try|else|return|throw|new)\b/.test(trimmed)) return false;
  if (!/[A-Za-z_][A-Za-z0-9_]*\s*\([^{};]*\)/.test(trimmed)) return false;
  return /(?:\{\s*)?$/.test(trimmed);
}

function buildLocalDeclarationNamesByLine(sourceText: string | undefined): Map<number, string[]> {
  const namesByLine = new Map<number, string[]>();
  if (typeof sourceText !== 'string' || sourceText.length === 0) return namesByLine;

  const lines = sourceText.split(/\r?\n/);
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const { text, inBlockComment: nextInBlockComment } = stripInlineComments(lines[index] ?? '', inBlockComment);
    inBlockComment = nextInBlockComment;
    if (isMethodDeclarationLine(text)) continue;

    const names: string[] = [];
    const declarationPattern =
      /\b(?:final\s+)?(?:[A-Za-z_][A-Za-z0-9_.$]*(?:\s*<[^;=(){}]+>)?(?:\s*\[\])?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    for (const match of text.matchAll(declarationPattern)) {
      if (match[1]) names.push(match[1]);
    }
    if (names.length > 0) namesByLine.set(index + 1, names);
  }

  return namesByLine;
}

function removeSameLineMutationDeclarationSnapshotEvents(
  events: RuntimeV4Event[],
  sourceText: string | undefined
): RuntimeV4Event[] {
  const declarationNamesByLine = buildLocalDeclarationNamesByLine(sourceText);
  if (declarationNamesByLine.size === 0) return events;
  const mutationVariablesByLine = new Map<number, Set<string>>();
  for (const event of events) {
    if (event.kind !== 'mutate' || typeof event.line !== 'number' || !('variable' in event.target)) continue;
    const variables = mutationVariablesByLine.get(event.line) ?? new Set<string>();
    variables.add(event.target.variable);
    mutationVariablesByLine.set(event.line, variables);
  }
  if (mutationVariablesByLine.size === 0) return events;
  return events.filter((event) => {
    if (event.kind !== 'snapshot' || typeof event.line !== 'number' || !('variable' in event.target)) return true;
    const declaredNames = declarationNamesByLine.get(event.line);
    if (!declaredNames?.includes(event.target.variable)) return true;
    const mutationVariables = mutationVariablesByLine.get(event.line);
    return mutationVariables?.has(event.target.variable) === true;
  });
}

function nativeJavaV4EventsToTrace(
  events: string[],
  sourceText: string | undefined,
  options: RuntimeV4TraceOptions = {}
): RuntimeV4Trace {
  const runId = options.runId ?? 'java:run';
  let parsedEvents: RuntimeV4Event[] = events.map((event) => {
    let parsed: RuntimeV4Event;
    try {
      parsed = JSON.parse(event.slice('v4:'.length)) as RuntimeV4Event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Java native V4 event: ${message}\n${event.slice(0, 500)}`);
    }
    return {
      ...parsed,
      runId,
      ...(options.file ? { file: options.file } : {}),
    };
  });
  parsedEvents = removeSameLineMutationDeclarationSnapshotEvents(parsedEvents, sourceText);

  return {
    schemaVersion: RUNTIME_TRACE_V4_DRAFT_SCHEMA_VERSION,
    language: 'java',
    runId,
    events: parsedEvents,
    lineEventCount: parsedEvents.filter((event) => event.kind === 'line').length,
    traceStepCount: parsedEvents.length,
  };
}

export function javaTraceHooksEventsToV4Trace(
  events: string[],
  sourceText?: string,
  options: RuntimeV4TraceOptions = {}
): RuntimeV4Trace {
  assertSupportedRawEmissions(summarizeJavaRawEmissions(events), 'java');
  if (events.length === 0) {
    return {
      schemaVersion: RUNTIME_TRACE_V4_DRAFT_SCHEMA_VERSION,
      language: 'java',
      runId: options.runId ?? 'java:run',
      events: [],
      lineEventCount: 0,
      traceStepCount: 0,
    };
  }
  if (!events.every(isNativeJavaV4Event)) {
    throw new Error('Java TraceHooks must emit native V4 events. Legacy line=... events are no longer supported.');
  }
  return nativeJavaV4EventsToTrace(events, sourceText, options);
}
