import type {
  ExecutionResult,
  RawTraceStep,
  RuntimeHashMapVisualization,
  RuntimeTraceAccessEvent,
  RuntimeVisualizationPayload,
} from '../types';
import { normalizeRuntimeTraceContract, type RuntimeTraceContractResult } from '../trace-contract';
import { adaptTraceExecutionResult } from './shared';

export interface JavaTraceResult {
  output: unknown;
  events: string[];
}

export interface JavaTraceContractResult
  extends Omit<RuntimeTraceContractResult, 'language'> {
  language: 'java';
}

function parseScalar(raw: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

function parseKeyValuePairs(fragment: string): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  const pairs = fragment.match(/[A-Za-z_][A-Za-z0-9_.]*=[^\s]+/g) ?? [];
  for (const pair of pairs) {
    const [rawKey, rawValue] = pair.split('=');
    if (!rawKey || rawValue === undefined) continue;
    if (rawKey === 'method') continue;
    variables[rawKey.replaceAll('.', '_')] = parseScalar(rawValue);
  }
  return variables;
}

function extractLineMetadata(event: string): { line: number; payload: string } {
  const match = event.match(/^line=(\d+)\s+(.+)$/);
  if (!match) {
    return { line: 1, payload: event };
  }
  return {
    line: Number.parseInt(match[1], 10),
    payload: match[2],
  };
}

function parseAccessEvent(payload: string): RuntimeTraceAccessEvent[] | undefined {
  const indexedRead = payload.match(/^access ([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]=(.+)$/);
  if (indexedRead) {
    return [{
      variable: indexedRead[1],
      kind: 'indexed-read',
      indices: [Number.parseInt(indexedRead[2], 10)],
      pathDepth: 1,
    }];
  }
  const indexedWrite = payload.match(/^write-array ([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]=(.+)$/);
  if (indexedWrite) {
    return [{
      variable: indexedWrite[1],
      kind: 'indexed-write',
      indices: [Number.parseInt(indexedWrite[2], 10)],
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
  return undefined;
}

function parseStructureState(payload: string): { structure: 'linked-list' | 'tree'; variable: string; value: unknown } | null {
  const match = payload.match(/^state (linked-list|tree) ([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (!match) return null;
  return {
    structure: match[1] as 'linked-list' | 'tree',
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

function eventsToRawTrace(events: string[]): RawTraceStep[] {
  const trace: RawTraceStep[] = [];
  const variables: Record<string, unknown> = {};
  const objectKinds: Record<string, 'linked-list' | 'tree'> = {};
  const stack: Array<{ function: string; line: number }> = [];
  let currentFunction = '<module>';

  for (const rawEvent of events) {
    if (rawEvent === 'clear' || rawEvent === 'reset') continue;
    const { line, payload } = extractLineMetadata(rawEvent);

    if (payload.startsWith('call ')) {
      const [functionName, ...rest] = payload.slice('call '.length).split(' ');
      Object.assign(variables, parseKeyValuePairs(rest.join(' ')));
      currentFunction = functionName || currentFunction;
      stack.push({ function: currentFunction, line });
      trace.push({
        line,
        event: 'call',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: {} })),
      });
      continue;
    }

    if (payload.startsWith('return ')) {
      const [functionName] = payload.slice('return '.length).split(' ');
      trace.push({
        line,
        event: 'return',
        function: functionName || currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: {} })),
      });
      stack.pop();
      currentFunction = stack[stack.length - 1]?.function ?? '<module>';
      continue;
    }

    const structureState = parseStructureState(payload);
    if (structureState) {
      variables[structureState.variable] = structureState.value;
      objectKinds[structureState.variable] = structureState.structure;
      trace.push({
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: {} })),
        visualization: {
          objectKinds: { ...objectKinds },
        },
      });
      continue;
    }

    const objectState = parseObjectState(payload);
    if (objectState) {
      variables[objectState.variable] = { __ref__: objectState.visualization.objectId ?? `${objectState.variable}-object` };
      trace.push({
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: {} })),
        visualization: {
          objectKinds: { [objectState.variable]: 'object' },
          hashMaps: [objectState.visualization],
        },
      });
      continue;
    }

    const objectField = parseObjectFieldEvent(payload);
    if (objectField) {
      variables[objectField.variable] = { __ref__: `${objectField.variable}-object` };
      trace.push({
        line,
        event: 'line',
        function: currentFunction,
        variables: { ...variables },
        callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: {} })),
        visualization: buildFieldVisualization(objectField),
      });
      continue;
    }

    Object.assign(variables, parseKeyValuePairs(payload));
    const accesses = parseAccessEvent(payload);
    trace.push({
      line,
      event: 'line',
      function: currentFunction,
      variables: { ...variables },
      ...(stack.length > 0
        ? { callStack: stack.map((frame) => ({ function: frame.function, line: frame.line, args: {} })) }
        : {}),
      ...(accesses ? { accesses } : {}),
    });
  }

  return trace;
}

export function buildJavaExecutionResult(output: unknown, events: string[], executionTimeMs = 0): ExecutionResult {
  const trace = eventsToRawTrace(events);
  return {
    success: true,
    output,
    trace,
    executionTimeMs,
    consoleOutput: [],
    lineEventCount: trace.filter((step) => step.event === 'line').length,
    traceStepCount: trace.length,
  };
}

export function normalizeJavaTraceContract(result: JavaTraceResult): JavaTraceContractResult {
  const normalized = normalizeRuntimeTraceContract('java', buildJavaExecutionResult(result.output, result.events));
  return {
    ...normalized,
    language: 'java',
  };
}

export function adaptJavaTraceExecutionResult(result: ExecutionResult): ExecutionResult {
  return adaptTraceExecutionResult('java', result);
}
