import type {
  RawTraceStep,
  RuntimeHashMapVisualization,
  RuntimeTraceAccessEvent,
  RuntimeVisualizationPayload,
} from '../types';
import { normalizeRuntimeTraceContract } from '../trace-contract';
import {
  runtimeTraceContractToV4Events,
  type RuntimeV4Trace,
  type RuntimeV4TraceOptions,
} from '../trace-v4';
import { assertSupportedRawEmissions, summarizeJavaRawEmissions } from '../runtime-raw-emission-contract';

function parseScalar(raw: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith('[') && raw.endsWith(']')) ||
    (raw.startsWith('{') && raw.endsWith('}'))
  ) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      // Fall through to raw string return.
    }
  }
  return raw;
}

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

function parseKeyValuePairs(fragment: string): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  const matches = Array.from(fragment.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)=/g));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const rawKey = match[1];
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = index + 1 < matches.length ? (matches[index + 1].index ?? fragment.length) : fragment.length;
    const rawValue = fragment.slice(valueStart, valueEnd).trim();
    if (!rawKey || rawValue === undefined) continue;
    if (rawKey === 'method') continue;
    variables[rawKey.replaceAll('.', '_')] = parseScalar(rawValue);
  }
  return variables;
}

function extractLineMetadata(event: string): { line: number; payload: string } {
  const match = event.match(/^line=(\d+)(?:\s+(.*))?$/);
  if (!match) {
    return { line: 1, payload: event };
  }
  return {
    line: Number.parseInt(match[1], 10),
    payload: match[2] ?? '',
  };
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

    if (current === '/' && next === '/') {
      break;
    }

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
  if (/^(?:if|for|while|switch|catch|do|try|else|return|throw|new)\b/.test(trimmed)) {
    return false;
  }
  if (!/[A-Za-z_][A-Za-z0-9_]*\s*\([^{};]*\)/.test(trimmed)) {
    return false;
  }
  return /(?:\{\s*)?$/.test(trimmed);
}

function buildLineRemap(sourceText: string | undefined): Map<number, number> | null {
  if (typeof sourceText !== 'string' || sourceText.length === 0) {
    return null;
  }

  const lines = sourceText.split(/\r?\n/);
  const executable = new Set<number>();
  let inBlockComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const { text, inBlockComment: nextInBlockComment } = stripInlineComments(lines[index] ?? '', inBlockComment);
    inBlockComment = nextInBlockComment;
    if (text.trim().length > 0) {
      executable.add(index + 1);
    }
  }

  if (executable.size === 0) {
    return null;
  }

  const nextExecutableAtOrAfter: Array<number | null> = new Array(lines.length + 2).fill(null);
  let nextExecutable: number | null = null;
  for (let line = lines.length; line >= 1; line -= 1) {
    if (executable.has(line)) {
      nextExecutable = line;
    }
    nextExecutableAtOrAfter[line] = nextExecutable;
  }

  const previousExecutableAtOrBefore: Array<number | null> = new Array(lines.length + 2).fill(null);
  let previousExecutable: number | null = null;
  for (let line = 1; line <= lines.length; line += 1) {
    if (executable.has(line)) {
      previousExecutable = line;
    }
    previousExecutableAtOrBefore[line] = previousExecutable;
  }

  const remap = new Map<number, number>();
  for (let line = 1; line <= lines.length; line += 1) {
    if (executable.has(line)) continue;
    const forward = nextExecutableAtOrAfter[line];
    const backward = previousExecutableAtOrBefore[line];
    const target = forward ?? backward;
    if (target !== null && target !== line) {
      remap.set(line, target);
    }
  }

  return remap;
}

function buildMethodDeclarationLineSet(sourceText: string | undefined): Set<number> | null {
  if (typeof sourceText !== 'string' || sourceText.length === 0) {
    return null;
  }

  const declarationLines = new Set<number>();
  const lines = sourceText.split(/\r?\n/);
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const { text, inBlockComment: nextInBlockComment } = stripInlineComments(lines[index] ?? '', inBlockComment);
    inBlockComment = nextInBlockComment;
    if (isMethodDeclarationLine(text)) {
      declarationLines.add(index + 1);
    }
  }

  return declarationLines;
}

function buildLocalDeclarationNamesByLine(sourceText: string | undefined): Map<number, string[]> {
  const namesByLine = new Map<number, string[]>();
  if (typeof sourceText !== 'string' || sourceText.length === 0) {
    return namesByLine;
  }

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
    if (names.length > 0) {
      namesByLine.set(index + 1, names);
    }
  }

  return namesByLine;
}

function removeSameLineMutationDeclarationSnapshots(
  trace: RawTraceStep[],
  sourceText: string | undefined
): void {
  const declarationNamesByLine = buildLocalDeclarationNamesByLine(sourceText);
  if (declarationNamesByLine.size === 0) return;
  const mutationVariablesByLine = new Map<number, Set<string>>();
  for (const step of trace) {
    for (const access of step.accesses ?? []) {
      if (access.kind !== 'mutating-call') continue;
      const variables = mutationVariablesByLine.get(step.line) ?? new Set<string>();
      variables.add(access.variable);
      mutationVariablesByLine.set(step.line, variables);
    }
  }
  if (mutationVariablesByLine.size === 0) return;

  for (const step of trace) {
    const accessedVariables = mutationVariablesByLine.get(step.line);
    if (step.event !== 'line' || !step.variables || !accessedVariables) {
      continue;
    }
    const declaredNames = declarationNamesByLine.get(step.line);
    if (!declaredNames?.length) continue;

    for (const name of declaredNames) {
      if (!accessedVariables.has(name)) {
        delete step.variables[name];
      }
    }
    if (Object.keys(step.variables).length === 0) {
      step.variables = {};
    }
  }
}

function parseAccessEvent(payload: string): RuntimeTraceAccessEvent[] | undefined {
  const isEphemeralOutputArrayName = (name: string): boolean =>
    /^(output|outputs)$/i.test(name);

  const cellRead = payload.match(/^access ([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\[(\d+)\]=(.+)$/);
  if (cellRead) {
    return [{
      variable: cellRead[1],
      kind: 'cell-read',
      indices: [Number.parseInt(cellRead[2], 10), Number.parseInt(cellRead[3], 10)],
      pathDepth: 2,
    }];
  }
  const indexedRead = payload.match(/^access ([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]=(.+)$/);
  if (indexedRead) {
    return [{
      variable: indexedRead[1],
      kind: 'indexed-read',
      indices: [Number.parseInt(indexedRead[2], 10)],
      pathDepth: 1,
    }];
  }
  const cellWrite = payload.match(/^write-array ([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\[(\d+)\]=(.+)$/);
  if (cellWrite) {
    return [{
      variable: cellWrite[1],
      kind: 'cell-write',
      indices: [Number.parseInt(cellWrite[2], 10), Number.parseInt(cellWrite[3], 10)],
      pathDepth: 2,
    }];
  }
  const indexedWrite = payload.match(/^write-array ([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]=(.+)$/);
  if (indexedWrite) {
    if (isEphemeralOutputArrayName(indexedWrite[1])) {
      return undefined;
    }
    return [{
      variable: indexedWrite[1],
      kind: 'indexed-write',
      indices: [Number.parseInt(indexedWrite[2], 10)],
      pathDepth: 1,
    }];
  }
  const fieldRead = payload.match(/^access ([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (fieldRead) {
    return [{
      variable: fieldRead[1],
      kind: 'indexed-read',
      indices: [fieldRead[2]],
      pathDepth: 1,
    }];
  }
  const fieldWrite = payload.match(/^write ([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (fieldWrite) {
    return [{
      variable: fieldWrite[1],
      kind: 'indexed-write',
      indices: [fieldWrite[2]],
      pathDepth: 1,
    }];
  }
  const mutatingCall = payload.match(/^mutate ([A-Za-z_][A-Za-z0-9_]*) method=([A-Za-z_][A-Za-z0-9_]*)$/);
  if (mutatingCall) {
    return [{
      variable: mutatingCall[1],
      kind: 'mutating-call',
      method: mutatingCall[2],
      pathDepth: 1,
    }];
  }
  const indexedMutatingCall = payload.match(/^mutate-indexed ([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\] method=([A-Za-z_][A-Za-z0-9_]*)$/);
  if (indexedMutatingCall) {
    return [{
      variable: indexedMutatingCall[1],
      kind: 'mutating-call',
      indices: [Number.parseInt(indexedMutatingCall[2], 10)],
      method: indexedMutatingCall[3],
      pathDepth: 1,
    }];
  }
  const keyedCall = payload.match(/^keyed-call ([A-Za-z_][A-Za-z0-9_]*) method=([A-Za-z_][A-Za-z0-9_]*)(?:\s+.*)?$/);
  if (keyedCall) {
    return [{
      variable: keyedCall[1],
      kind: 'mutating-call',
      method: keyedCall[2],
      pathDepth: 1,
    }];
  }
  return undefined;
}

function parseStructureState(payload: string): { structure: 'linked-list' | 'tree' | 'graph-adjacency'; variable: string; value: unknown } | null {
  const match = payload.match(/^state (linked-list|tree|graph-adjacency) ([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (!match) return null;
  return {
    structure: match[1] as 'linked-list' | 'tree' | 'graph-adjacency',
    variable: match[2],
    value: JSON.parse(match[3]) as unknown,
  };
}

function parseObjectState(payload: string): { variable: string; visualization: RuntimeHashMapVisualization } | null {
  const match = payload.match(/^object-state ([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (!match) return null;
  return {
    variable: match[1],
    visualization: JSON.parse(match[2]) as RuntimeHashMapVisualization,
  };
}

function parseMapState(payload: string): { variable: string; visualization: RuntimeHashMapVisualization } | null {
  const match = payload.match(/^map-state ([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (!match) return null;
  return {
    variable: match[1],
    visualization: JSON.parse(match[2]) as RuntimeHashMapVisualization,
  };
}

function parseSetState(payload: string): { variable: string; visualization: RuntimeHashMapVisualization } | null {
  const match = payload.match(/^set-state ([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (!match) return null;
  return {
    variable: match[1],
    visualization: JSON.parse(match[2]) as RuntimeHashMapVisualization,
  };
}

function parseObjectFieldEvent(payload: string): { variable: string; field: string; value: unknown } | null {
  const match = payload.match(/^(access|write) ([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (!match) return null;
  return {
    variable: match[2],
    field: match[3],
    value: parseScalar(match[4]),
  };
}

function buildFieldVisualization(event: { variable: string; field: string; value: unknown }): RuntimeVisualizationPayload {
  return {
    objectKinds: {
      [event.variable]: 'object',
    },
    hashMaps: [
      {
        name: event.variable,
        kind: 'object',
        objectClassName:
          event.field === 'next' || event.field === 'prev'
            ? 'ListNode'
            : event.field === 'left' || event.field === 'right'
              ? 'TreeNode'
              : undefined,
        objectId: `${event.variable}-object`,
        highlightedKey: event.field,
        entries: [{ key: event.field, value: event.value, highlight: true }],
      },
    ],
  };
}

function callStacksEqual(
  left: RawTraceStep['callStack'] | undefined,
  right: RawTraceStep['callStack'] | undefined
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function mergeVisualizationPayloads(
  left: RuntimeVisualizationPayload | undefined,
  right: RuntimeVisualizationPayload | undefined
): RuntimeVisualizationPayload | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    ...left,
    ...right,
    objectKinds: {
      ...(left.objectKinds ?? {}),
      ...(right.objectKinds ?? {}),
    },
    hashMaps: [
      ...(left.hashMaps ?? []),
      ...(right.hashMaps ?? []),
    ],
  };
}

function maybeMergeConsecutiveLineStep(trace: RawTraceStep[], nextStep: RawTraceStep): boolean {
  if (nextStep.event !== 'line') {
    return false;
  }
  const previous = trace.at(-1);
  if (!previous || previous.event !== 'line') {
    return false;
  }
  if (previous.line !== nextStep.line || previous.function !== nextStep.function) {
    return false;
  }
  if (!callStacksEqual(previous.callStack, nextStep.callStack)) {
    return false;
  }

  previous.variables = { ...(previous.variables ?? {}), ...(nextStep.variables ?? {}) };
  if (nextStep.accesses?.length) {
    previous.accesses = [...(previous.accesses ?? []), ...nextStep.accesses];
  }
  previous.visualization = mergeVisualizationPayloads(previous.visualization, nextStep.visualization);
  return true;
}

function filterStructuredVariables(
  variables: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!variables) {
    return undefined;
  }
  const isEphemeralOutputArrayName = (name: string): boolean =>
    /^(output|outputs)$/i.test(name);
  const entries = Object.entries(variables).filter(([name, value]) => {
    if (value === null || typeof value !== 'object') {
      return false;
    }
    if (!Array.isArray(value)) {
      return true;
    }
    if (Array.isArray(value[0])) {
      return true;
    }
    return !isEphemeralOutputArrayName(name);
  });
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function appendJavaTraceStep(
  trace: RawTraceStep[],
  step: RawTraceStep,
  pendingAccesses: RuntimeTraceAccessEvent[],
  options: { allowMerge?: boolean } = {}
): void {
  const nextStep: RawTraceStep = pendingAccesses.length > 0
    ? { ...step, accesses: [...pendingAccesses] }
    : step;
  pendingAccesses.length = 0;
  if (options.allowMerge !== false && maybeMergeConsecutiveLineStep(trace, nextStep)) {
    return;
  }
  trace.push(nextStep);
}

function mergeIntoPreviousMatchingLineStep(
  trace: RawTraceStep[],
  line: number,
  currentFunction: string,
  currentCallStack: RawTraceStep['callStack'],
  patch: Partial<Pick<RawTraceStep, 'variables' | 'accesses' | 'visualization'>>
): boolean {
  const candidate = trace.at(-1);
  if (!candidate || candidate.event !== 'line') {
    return false;
  }
  if (candidate.line !== line || candidate.function !== currentFunction) {
    return false;
  }
  if (!callStacksEqual(candidate.callStack, currentCallStack)) {
    return false;
  }

  candidate.variables = { ...(candidate.variables ?? {}), ...(patch.variables ?? {}) };
  if (patch.accesses?.length) {
    candidate.accesses = [...(candidate.accesses ?? []), ...patch.accesses];
  }
  candidate.visualization = mergeVisualizationPayloads(candidate.visualization, patch.visualization);
  return true;
}

function mergeAccessesIntoPreviousMatchingLineStep(
  trace: RawTraceStep[],
  line: number,
  currentFunction: string,
  currentCallStack: RawTraceStep['callStack'],
  accesses: RuntimeTraceAccessEvent[]
): boolean {
  return mergeIntoPreviousMatchingLineStep(trace, line, currentFunction, currentCallStack, {
    variables: undefined,
    accesses,
    visualization: undefined,
  });
}

function eventsToRawTrace(events: string[], sourceText?: string): RawTraceStep[] {
  const trace: RawTraceStep[] = [];
  const variables: Record<string, unknown> = {};
  const objectKinds: Record<string, 'linked-list' | 'tree' | 'graph-adjacency'> = {};
  const stack: Array<{ function: string; line: number; args: Record<string, unknown> }> = [];
  const pendingAccesses: RuntimeTraceAccessEvent[] = [];
  let currentFunction = '<module>';
  let previousRawLine: number | null = null;
  const lineRemap = buildLineRemap(sourceText);
  const declarationLines = buildMethodDeclarationLineSet(sourceText);

  for (const rawEvent of events) {
    if (rawEvent === 'clear' || rawEvent === 'reset') continue;
    const metadata = extractLineMetadata(rawEvent);
    const previousEventRawLine = previousRawLine;
    previousRawLine = metadata.line;
    const line = lineRemap?.get(metadata.line) ?? metadata.line;
    const payload = metadata.payload;
    const isDeclarationLine = declarationLines?.has(line) === true;

    if (payload.startsWith('call ')) {
      const match = payload.match(/^call\s+(\S+)(?:\s+(.*))?$/);
      const functionName = match?.[1] ?? currentFunction;
      const argsFragment = match?.[2] ?? '';
      const args = parseKeyValuePairs(argsFragment);
      Object.assign(variables, args);
      currentFunction = functionName || currentFunction;
      stack.push({ function: currentFunction, line, args });
      appendJavaTraceStep(trace, {
        line,
        event: 'call',
        function: currentFunction,
        variables: { ...args },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
      }, pendingAccesses);
      continue;
    }

    if (payload.startsWith('return ')) {
      const match = payload.match(/^return\s+(\S+)(?:\s+value=(.*))?$/);
      const functionName = match?.[1] ?? currentFunction;
      const returnValue = match?.[2] !== undefined ? parseScalar(match[2].trim()) : undefined;
      const returnVariables = functionName === '<module>'
        ? { ...variables }
        : (filterStructuredVariables(variables) ?? {});
      appendJavaTraceStep(trace, {
        line,
        event: 'return',
        function: functionName || currentFunction,
        variables: returnVariables,
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
        ...(returnValue !== undefined ? { returnValue } : {}),
      }, pendingAccesses);
      stack.pop();
      currentFunction = stack[stack.length - 1]?.function ?? '<module>';
      continue;
    }

    if (payload.startsWith('exception ')) {
      const message = payload.replace(/^exception\s+/, '');
      appendJavaTraceStep(trace, {
        line,
        event: 'exception',
        function: currentFunction,
        variables: {},
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
        returnValue: parseScalar(message),
      }, pendingAccesses);
      continue;
    }

    if (payload.startsWith('stdout ')) {
      appendJavaTraceStep(trace, {
        line,
        event: 'stdout',
        function: currentFunction,
        variables: {},
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
        stdoutLineCount: 1,
        returnValue: parseScalar(payload.replace(/^stdout\s+/, '')),
      }, pendingAccesses);
      continue;
    }

    if (isDeclarationLine) {
      continue;
    }

    if (payload.length === 0) {
      appendJavaTraceStep(trace, {
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        ...(stack.length > 0
          ? { callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })) }
          : {}),
      }, pendingAccesses, { allowMerge: previousEventRawLine !== metadata.line });
      continue;
    }

    const structureState = parseStructureState(payload);
    if (structureState) {
      variables[structureState.variable] = structureState.value;
      objectKinds[structureState.variable] = structureState.structure;
      appendJavaTraceStep(trace, {
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
        visualization: {
          objectKinds: { ...objectKinds },
        },
      }, pendingAccesses);
      continue;
    }

    const objectState = parseObjectState(payload);
    if (objectState) {
      variables[objectState.variable] = { __ref__: objectState.visualization.objectId ?? `${objectState.variable}-object` };
      appendJavaTraceStep(trace, {
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
        visualization: {
          objectKinds: { [objectState.variable]: 'object' },
          hashMaps: [objectState.visualization],
        },
      }, pendingAccesses);
      continue;
    }

    const mapState = parseMapState(payload);
    if (mapState) {
      const entries = mapState.visualization.entries.map((entry) => [entry.key, entry.value]);
      variables[mapState.variable] = { __type__: 'map', entries };
      appendJavaTraceStep(trace, {
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
        visualization: {
          objectKinds: { [mapState.variable]: 'map' },
          hashMaps: [mapState.visualization],
        },
      }, pendingAccesses);
      continue;
    }

    const setState = parseSetState(payload);
    if (setState) {
      const values = setState.visualization.entries.map((entry) => entry.key);
      variables[setState.variable] = { __type__: 'set', values };
      appendJavaTraceStep(trace, {
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
        visualization: {
          objectKinds: { [setState.variable]: 'set' },
          hashMaps: [setState.visualization],
        },
      }, pendingAccesses);
      continue;
    }

    const accesses = parseAccessEvent(payload);
    if (accesses) {
      const currentCallStack =
        stack.length > 0 ? stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })) : undefined;
      if (mergeAccessesIntoPreviousMatchingLineStep(trace, line, currentFunction, currentCallStack, accesses)) {
        continue;
      }
      pendingAccesses.push(...accesses);
      continue;
    }

    const objectField = parseObjectFieldEvent(payload);
    if (objectField) {
      variables[objectField.variable] = { __ref__: `${objectField.variable}-object` };
      const currentCallStack =
        stack.length > 0 ? stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })) : undefined;
      if (mergeIntoPreviousMatchingLineStep(trace, line, currentFunction, currentCallStack, {
        variables: { ...variables },
        accesses: undefined,
        visualization: buildFieldVisualization(objectField),
      })) {
        continue;
      }
      appendJavaTraceStep(trace, {
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })),
        visualization: buildFieldVisualization(objectField),
      }, pendingAccesses);
      continue;
    }

    Object.assign(variables, parseKeyValuePairs(payload));
    appendJavaTraceStep(trace, {
      line,
      event: 'line',
      function: currentFunction,
      variables: { ...variables },
      ...(stack.length > 0
        ? { callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: { ...frame.args } })) }
        : {}),
    }, pendingAccesses);
  }

  if (pendingAccesses.length > 0 && trace.length > 0) {
    const last = trace[trace.length - 1];
    last.accesses = [...(last.accesses ?? []), ...pendingAccesses];
  }

  removeSameLineMutationDeclarationSnapshots(trace, sourceText);

  return trace;
}

export function javaTraceHooksEventsToV4Trace(
  events: string[],
  sourceText?: string,
  options: RuntimeV4TraceOptions = {}
): RuntimeV4Trace {
  assertSupportedRawEmissions(summarizeJavaRawEmissions(events), 'java');
  const trace = eventsToRawTrace(events, sourceText);
  const contract = normalizeRuntimeTraceContract('java', {
    success: true,
    trace,
    executionTimeMs: 0,
    consoleOutput: [],
    lineEventCount: trace.filter((step) => step.event === 'line').length,
    traceStepCount: trace.length,
  });
  return runtimeTraceContractToV4Events(contract, options);
}
