import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  withRuntimeTraceOptions,
  type RuntimeTraceEvent,
  type RuntimeTrace,
  type RuntimeTraceOptions,
} from '../runtime-trace';
import {
  assertSupportedRawEmissions,
  normalizeJavaNativeTraceJsonPayload,
  summarizeJavaRawEmissions,
} from '../runtime-raw-emission-contract';

const JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS = 2048;
const JAVA_MAX_LOOP_HEADER_SNAPSHOT_CACHE = 2048;

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

function isNativeJavaTraceEvent(event: string): boolean {
  return event.startsWith('trace:');
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
  events: RuntimeTraceEvent[],
  sourceText: string | undefined
): RuntimeTraceEvent[] {
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

function collectJavaLineDeclarationsForHeaderExpansion(line: string): string[] {
  const names: string[] = [];
  const declarationPattern =
    /\b(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?==)/g;
  const skippedNames = new Set(['class', 'interface', 'enum', 'record', 'return', 'new']);
  for (const match of line.matchAll(declarationPattern)) {
    const typeSource = match[1] ?? '';
    const name = match[2];
    if (!name || skippedNames.has(name) || name.startsWith('__tracecode')) continue;
    if (typeSource.includes('[')) continue;
    names.push(name);
  }
  return names;
}

function collectJavaControlHeaderDeclarations(line: string): string[] {
  const forMatch = /\bfor\s*\(\s*(?:final\s+)?(?:[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^;=(){}:]+>)?|\w+(?:\s*\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)/.exec(line);
  return forMatch?.[1] ? [forMatch[1]] : [];
}

interface JavaLoopHeaderInfo {
  line: number;
  excludedVariables: Set<string>;
  headerVariables: Set<string>;
}

function buildJavaControlHeaderInfo(sourceText: string | undefined): {
  loopBodyLineToHeader: Map<number, JavaLoopHeaderInfo>;
  headerLineToExcludedVariables: Map<number, Set<string>>;
} | null {
  if (typeof sourceText !== 'string' || sourceText.length === 0) return null;
  const lines = sourceText.split(/\r?\n/);
  const loopBodyLineToHeader = new Map<number, JavaLoopHeaderInfo>();
  const headerLineToExcludedVariables = new Map<number, Set<string>>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const isLoopHeader = /\b(?:for|while)\s*\(/.test(line);
    const isControlHeader = /\b(?:for|while|if|else\s+if)\s*\(/.test(line);
    if (!isControlHeader || !line.includes('{')) continue;

    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const trimmed = (lines[bodyIndex] ?? '').trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('}')) break;
      const headerInfo: JavaLoopHeaderInfo = {
        line: index + 1,
        excludedVariables: new Set(collectJavaLineDeclarationsForHeaderExpansion(lines[bodyIndex] ?? '')),
        headerVariables: new Set(collectJavaControlHeaderDeclarations(line)),
      };
      if (isLoopHeader) loopBodyLineToHeader.set(bodyIndex + 1, headerInfo);
      headerLineToExcludedVariables.set(index + 1, headerInfo.excludedVariables);
      break;
    }
  }

  if (loopBodyLineToHeader.size === 0 && headerLineToExcludedVariables.size === 0) return null;
  return { loopBodyLineToHeader, headerLineToExcludedVariables };
}

function eventLine(event: RuntimeTraceEvent): number | null {
  return typeof event.line === 'number' && Number.isFinite(event.line) && event.line > 0
    ? event.line
    : null;
}

function eventSnapshotVariable(event: RuntimeTraceEvent): string | null {
  if (event.kind !== 'snapshot') return null;
  const target = event.target;
  if (!target || typeof target !== 'object' || !('variable' in target)) return null;
  const variable = target.variable;
  return typeof variable === 'string' && variable.length > 0 ? variable : null;
}

function cloneRuntimeEventAtLine(event: RuntimeTraceEvent, line: number): RuntimeTraceEvent {
  return { ...event, line };
}

function expandJavaLoopHeaderTraceEvents(
  events: RuntimeTraceEvent[],
  sourceText: string | undefined
): RuntimeTraceEvent[] {
  if (events.length === 0) return events;
  const controlHeaderInfo = buildJavaControlHeaderInfo(sourceText);
  if (!controlHeaderInfo) return events;
  const { loopBodyLineToHeader, headerLineToExcludedVariables } = controlHeaderInfo;

  const expanded: RuntimeTraceEvent[] = [];
  const latestSnapshotByVariable = new Map<string, RuntimeTraceEvent>();
  let lastLineEventLine: number | null = null;
  let syntheticHeaderEventCount = 0;
  const pushSyntheticHeaderEvent = (event: RuntimeTraceEvent): boolean => {
    if (syntheticHeaderEventCount >= JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS) return false;
    expanded.push(event);
    syntheticHeaderEventCount += 1;
    return true;
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const line = eventLine(event);
    const snapshotVariable = eventSnapshotVariable(event);
    if (
      line !== null &&
      snapshotVariable &&
      headerLineToExcludedVariables.get(line)?.has(snapshotVariable)
    ) {
      continue;
    }

    const headerInfo = line === null ? undefined : loopBodyLineToHeader.get(line);
    const headerLine = headerInfo?.line;
    if (headerInfo && typeof headerLine === 'number' && event.kind === 'line' && lastLineEventLine !== headerLine) {
      pushSyntheticHeaderEvent(cloneRuntimeEventAtLine(event, headerLine));
      for (const [variable, snapshotEvent] of latestSnapshotByVariable) {
        if (syntheticHeaderEventCount >= JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS) break;
        if (headerInfo.excludedVariables.has(variable)) continue;
        if (headerInfo.headerVariables.has(variable)) continue;
        pushSyntheticHeaderEvent(cloneRuntimeEventAtLine(snapshotEvent, headerLine));
      }
      lastLineEventLine = headerLine;
    }

    if (headerInfo && typeof headerLine === 'number' && event.kind === 'line') {
      for (let lookahead = index + 1; lookahead < events.length; lookahead += 1) {
        if (syntheticHeaderEventCount >= JAVA_MAX_LOOP_HEADER_SYNTHETIC_EVENTS) break;
        if (eventLine(events[lookahead]) !== line) break;
        const variable = eventSnapshotVariable(events[lookahead]);
        if (!variable || !headerInfo.headerVariables.has(variable)) continue;
        pushSyntheticHeaderEvent(cloneRuntimeEventAtLine(events[lookahead], headerLine));
      }
    }

    expanded.push(event);
    if (event.kind === 'line') {
      lastLineEventLine = line;
    }
    if (snapshotVariable) {
      if (latestSnapshotByVariable.has(snapshotVariable) || latestSnapshotByVariable.size < JAVA_MAX_LOOP_HEADER_SNAPSHOT_CACHE) {
        latestSnapshotByVariable.set(snapshotVariable, event);
      }
    }
  }
  return expanded;
}

function nativeJavaTraceEventsToTrace(
  events: string[],
  sourceText: string | undefined,
  options: RuntimeTraceOptions = {}
): RuntimeTrace {
  const runId = options.runId ?? 'java:run';
  let parsedEvents: RuntimeTraceEvent[] = events.map((event) => {
    let parsed: RuntimeTraceEvent;
    try {
      parsed = JSON.parse(normalizeJavaNativeTraceJsonPayload(event.slice('trace:'.length))) as RuntimeTraceEvent;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Java native runtime trace event: ${message}\n${event.slice(0, 500)}`);
    }
    if (parsed.kind === 'stdout' && !('text' in parsed)) {
      const value = (parsed as RuntimeTraceEvent & { value?: unknown }).value;
      const rest = { ...(parsed as RuntimeTraceEvent & { value?: unknown }) };
      delete rest.value;
      return {
        ...rest,
        text: value === undefined || value === null ? '' : String(value),
        runId,
        ...(options.file ? { file: options.file } : {}),
      } as RuntimeTraceEvent;
    }
    return {
      ...parsed,
      runId,
      ...(options.file ? { file: options.file } : {}),
    };
  });
  parsedEvents = removeSameLineMutationDeclarationSnapshotEvents(parsedEvents, sourceText);
  parsedEvents = expandJavaLoopHeaderTraceEvents(parsedEvents, sourceText);

  return withRuntimeTraceOptions({
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language: 'java',
    runId,
    events: parsedEvents,
    lineEventCount: parsedEvents.filter((event) => event.kind === 'line').length,
    traceStepCount: parsedEvents.length,
  }, options);
}

export function javaTraceHooksEventsToRuntimeTrace(
  events: string[],
  sourceText?: string,
  options: RuntimeTraceOptions = {}
): RuntimeTrace {
  assertSupportedRawEmissions(summarizeJavaRawEmissions(events), 'java');
  if (events.length === 0) {
    return {
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'java',
      runId: options.runId ?? 'java:run',
      events: [],
      lineEventCount: 0,
      traceStepCount: 0,
    };
  }
  if (!events.every(isNativeJavaTraceEvent)) {
    throw new Error('Java TraceHooks must emit native runtime trace events. Unsupported line=... events are no longer supported.');
  }
  return nativeJavaTraceEventsToTrace(events, sourceText, options);
}
