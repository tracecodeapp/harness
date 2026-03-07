/**
 * JavaScript Runtime Worker
 *
 * Executes JavaScript user code off the main thread.
 * Message contract mirrors the Python worker so runtime adapters can share
 * the same high-level interface.
 */

const WORKER_DEBUG = (() => {
  try {
    return typeof self !== 'undefined' && typeof self.location?.search === 'string' && self.location.search.includes('dev=');
  } catch {
    return false;
  }
})();

let isInitialized = false;
let isLoading = false;
let typeScriptLoadPromise = null;
const INTERVIEW_GUARD_DEFAULTS = Object.freeze({
  maxTraceSteps: 8000,
  maxLineEvents: 4000,
  maxSingleLineHits: 3000,
  maxCallDepth: 2000,
});
const TYPESCRIPT_COMPILER_URLS = [
  '/workers/vendor/typescript.js',
  'https://cdn.jsdelivr.net/npm/typescript@5.9.2/lib/typescript.js',
  'https://unpkg.com/typescript@5.9.2/lib/typescript.js',
];

const JAVASCRIPT_RUNTIME_PRELUDE = `
if (typeof globalThis.ListNode !== 'function') {
  globalThis.ListNode = class ListNode {
    constructor(val = 0, next = null) {
      this.val = val;
      this.next = next;
    }
  };
}
if (typeof globalThis.TreeNode !== 'function') {
  globalThis.TreeNode = class TreeNode {
    constructor(val = 0, left = null, right = null) {
      this.val = val;
      this.left = left;
      this.right = right;
    }
  };
}
`;

const TYPESCRIPT_RUNTIME_DECLARATIONS = `
declare class ListNode {
  val: any;
  next: ListNode | SerializedListNode | SerializedRef | null;
  prev?: ListNode | SerializedListNode | SerializedRef | null;
  constructor(val?: any, next?: ListNode | null);
}

declare class TreeNode {
  val: any;
  left: TreeNode | SerializedTreeNode | SerializedRef | null;
  right: TreeNode | SerializedTreeNode | SerializedRef | null;
  constructor(val?: any, left?: TreeNode | null, right?: TreeNode | null);
}

type SerializedRef = { __ref__: string };

type SerializedListNode = {
  __id__?: string;
  __type__?: 'ListNode';
  val?: any;
  next?: SerializedListNode | SerializedRef | ListNode | null;
  prev?: SerializedListNode | SerializedRef | ListNode | null;
};

type SerializedTreeNode = {
  __id__?: string;
  __type__?: 'TreeNode';
  val?: any;
  left?: SerializedTreeNode | SerializedRef | TreeNode | null;
  right?: SerializedTreeNode | SerializedRef | TreeNode | null;
};
`;

function performanceNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function formatConsoleArg(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createConsoleProxy(output) {
  const capture = (...args) => {
    output.push(args.map(formatConsoleArg).join(' '));
  };

  return {
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
  };
}

function isLikelyTreeNodeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasValue =
    Object.prototype.hasOwnProperty.call(value, 'val') ||
    Object.prototype.hasOwnProperty.call(value, 'value');
  const hasTreeLinks =
    Object.prototype.hasOwnProperty.call(value, 'left') ||
    Object.prototype.hasOwnProperty.call(value, 'right');
  return hasValue && hasTreeLinks;
}

function isLikelyListNodeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasValue =
    Object.prototype.hasOwnProperty.call(value, 'val') ||
    Object.prototype.hasOwnProperty.call(value, 'value');
  const hasTreeLinks =
    Object.prototype.hasOwnProperty.call(value, 'left') ||
    Object.prototype.hasOwnProperty.call(value, 'right');
  const hasListLinks =
    Object.prototype.hasOwnProperty.call(value, 'next') ||
    Object.prototype.hasOwnProperty.call(value, 'prev');
  return hasValue && hasListLinks && !hasTreeLinks;
}

function serializeValue(
  value,
  depth = 0,
  seen = new WeakSet(),
  nodeRefState = { ids: new Map(), nextId: 1 }
) {
  if (depth > 48) return '<max depth>';
  if (value === null || value === undefined) return value;

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return value;
  }
  if (valueType === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  }
  if (valueType === 'function') {
    return '<function>';
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, depth + 1, seen, nodeRefState));
  }
  if (value instanceof Set) {
    return {
      __type__: 'set',
      values: [...value].map((item) => serializeValue(item, depth + 1, seen, nodeRefState)),
    };
  }
  if (value instanceof Map) {
    return {
      __type__: 'map',
      entries: [...value.entries()].map(([k, v]) => [
        serializeValue(k, depth + 1, seen, nodeRefState),
        serializeValue(v, depth + 1, seen, nodeRefState),
      ]),
    };
  }
  if (valueType === 'object') {
    if (isLikelyTreeNodeValue(value) || isLikelyListNodeValue(value)) {
      const existingId = nodeRefState.ids.get(value);
      if (existingId) {
        return { __ref__: existingId };
      }
      const nodePrefix = isLikelyTreeNodeValue(value) ? 'tree' : 'list';
      const nodeId = `${nodePrefix}-${nodeRefState.nextId++}`;
      nodeRefState.ids.set(value, nodeId);

      if (nodePrefix === 'tree') {
        return {
          __type__: 'TreeNode',
          __id__: nodeId,
          val: serializeValue(value.val ?? value.value ?? null, depth + 1, seen, nodeRefState),
          left: serializeValue(value.left ?? null, depth + 1, seen, nodeRefState),
          right: serializeValue(value.right ?? null, depth + 1, seen, nodeRefState),
        };
      }

      return {
        __type__: 'ListNode',
        __id__: nodeId,
        val: serializeValue(value.val ?? value.value ?? null, depth + 1, seen, nodeRefState),
        next: serializeValue(value.next ?? null, depth + 1, seen, nodeRefState),
        ...(Object.prototype.hasOwnProperty.call(value, 'prev')
          ? { prev: serializeValue(value.prev ?? null, depth + 1, seen, nodeRefState) }
          : {}),
      };
    }

    if (seen.has(value)) return '<cycle>';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeValue(v, depth + 1, seen, nodeRefState);
    }
    seen.delete(value);
    return out;
  }

  return String(value);
}

function extractUserErrorLine(error) {
  if (error && typeof error === 'object' && '__tracecodeLine' in error) {
    const line = Number(error.__tracecodeLine);
    if (Number.isFinite(line)) return line;
  }

  const stack = error?.stack;
  if (!stack || typeof stack !== 'string') return undefined;
  const match = stack.match(/<anonymous>:(\d+):\d+/);
  if (!match) return undefined;
  const line = Number.parseInt(match[1], 10);
  return Number.isFinite(line) ? line : undefined;
}

function isPlainObjectRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.prototype.toString.call(value) === '[object Object]';
}

function collectReferenceTargets(value, byId, seen) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferenceTargets(item, byId, seen);
    }
    return;
  }

  if (!isPlainObjectRecord(value)) return;
  if (typeof value.__id__ === 'string' && value.__id__.length > 0 && !byId.has(value.__id__)) {
    byId.set(value.__id__, value);
  }

  for (const nested of Object.values(value)) {
    collectReferenceTargets(nested, byId, seen);
  }
}

function resolveReferenceGraph(value, byId, resolved) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (resolved.has(value)) {
    return resolved.get(value);
  }

  if (Array.isArray(value)) {
    const out = [];
    resolved.set(value, out);
    for (const item of value) {
      out.push(resolveReferenceGraph(item, byId, resolved));
    }
    return out;
  }

  if (!isPlainObjectRecord(value)) {
    return value;
  }

  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.__ref__ === 'string') {
    const target = byId.get(value.__ref__);
    if (!target) return null;
    return resolveReferenceGraph(target, byId, resolved);
  }

  const out = {};
  resolved.set(value, out);
  for (const [key, nested] of Object.entries(value)) {
    out[key] = resolveReferenceGraph(nested, byId, resolved);
  }
  return out;
}

function normalizeInputs(inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {};
  const byId = new Map();
  collectReferenceTargets(inputs, byId, new WeakSet());
  if (byId.size === 0) {
    return inputs;
  }
  const hydrated = resolveReferenceGraph(inputs, byId, new WeakMap());
  if (!hydrated || typeof hydrated !== 'object' || Array.isArray(hydrated)) {
    return inputs;
  }
  return hydrated;
}

function stripEngineSuggestionHints(message) {
  if (typeof message !== 'string' || message.length === 0) {
    return String(message ?? '');
  }

  return message
    .replace(/\s*\(?Did you mean[^?\n]*\??\)?/gi, '')
    .replace(/\n+\s*Did you mean[^\n]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatRuntimeErrorMessage(error) {
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'Execution failed');
  if (!(error instanceof Error)) {
    return rawMessage;
  }

  const errorName = String(error.name || '');
  const shouldStripHints =
    error instanceof ReferenceError ||
    error instanceof TypeError ||
    error instanceof SyntaxError ||
    errorName === 'ReferenceError' ||
    errorName === 'TypeError' ||
    errorName === 'SyntaxError';

  if (!shouldStripHints) {
    return rawMessage;
  }

  const sanitized = stripEngineSuggestionHints(rawMessage);
  return sanitized.length > 0 ? sanitized : rawMessage;
}

function getNumericOption(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function isTraceableIntegerIndex(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function normalizeTraceIndices(indices, maxDepth = 2) {
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > maxDepth) {
    return null;
  }
  if (!indices.every(isTraceableIntegerIndex)) {
    return null;
  }
  return indices.map((index) => Math.trunc(index));
}

function isTraceableMutatingMethod(methodName) {
  return ['push', 'pop', 'shift', 'unshift', 'splice'].includes(methodName);
}

function readValueAtIndices(container, indices) {
  let current = container;
  for (const index of indices) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[index];
  }
  return current;
}

function writeValueAtIndices(container, indices, value) {
  if (!Array.isArray(indices) || indices.length === 0) {
    return value;
  }
  if (indices.length === 1) {
    container[indices[0]] = value;
    return value;
  }

  let parent = container;
  for (let i = 0; i < indices.length - 1; i += 1) {
    parent = parent?.[indices[i]];
  }
  if (parent !== null && parent !== undefined) {
    parent[indices[indices.length - 1]] = value;
  }
  return value;
}

function createTraceRecorder(options = {}) {
  const trace = [];
  const callStack = [];
  const pendingAccessesByFrame = new Map();
  const lineHitCount = new Map();
  const maxTraceSteps = getNumericOption(options.maxTraceSteps, 4000);
  const maxLineEvents = getNumericOption(options.maxLineEvents, 12000);
  const maxSingleLineHits = getNumericOption(options.maxSingleLineHits, 1000);
  const maxCallDepth = getNumericOption(options.maxCallDepth, 2000);

  let lineEventCount = 0;
  let traceLimitExceeded = false;
  let timeoutReason;
  let timeoutRecorded = false;
  let nextFrameId = 1;

  function normalizeLine(lineNumber, fallback = 1) {
    const parsed = Number(lineNumber);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }

  function snapshotCallStack() {
    return callStack.map((frame) => ({
      function: frame.function,
      args: frame.args,
      line: frame.line,
    }));
  }

  function sanitizeVariables(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    const nodeRefState = { ids: new Map(), nextId: 1 };
    for (const [key, variableValue] of Object.entries(value)) {
      if (variableValue === undefined) continue;
      try {
        result[key] = serializeValue(variableValue, 0, new WeakSet(), nodeRefState);
      } catch {
        // Skip variables that throw during serialization (e.g. transient proxy/getter failures).
      }
    }
    return result;
  }

  function isLikelyTreeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const hasValue = Object.prototype.hasOwnProperty.call(value, 'val') || Object.prototype.hasOwnProperty.call(value, 'value');
    const hasTreeLinks = Object.prototype.hasOwnProperty.call(value, 'left') || Object.prototype.hasOwnProperty.call(value, 'right');
    return hasValue && hasTreeLinks;
  }

  function isLikelyLinkedListObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const hasValue = Object.prototype.hasOwnProperty.call(value, 'val') || Object.prototype.hasOwnProperty.call(value, 'value');
    const hasTreeLinks = Object.prototype.hasOwnProperty.call(value, 'left') || Object.prototype.hasOwnProperty.call(value, 'right');
    const hasListLinks = Object.prototype.hasOwnProperty.call(value, 'next') || Object.prototype.hasOwnProperty.call(value, 'prev');
    return hasValue && hasListLinks && !hasTreeLinks;
  }

  function isLikelyAdjacencyListObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.length === 0) return false;
    if (!keys.every((key) => Array.isArray(value[key]))) return false;

    const keySet = new Set(keys.map((key) => String(key)));
    for (const neighbors of Object.values(value)) {
      for (const neighbor of neighbors) {
        if (keySet.has(String(neighbor))) {
          return true;
        }
      }
    }
    return false;
  }

  function isLikelyIndexedAdjacencyListArray(value) {
    if (!Array.isArray(value) || value.length === 0) return false;
    if (!value.every((row) => Array.isArray(row))) return false;

    const nodeCount = value.length;
    let edgeCount = 0;
    for (const neighbors of value) {
      for (const neighbor of neighbors) {
        if (typeof neighbor !== 'number' || !Number.isInteger(neighbor)) return false;
        if (neighbor < 0 || neighbor >= nodeCount) return false;
        edgeCount += 1;
      }
    }

    if (edgeCount === 0) return false;

    const looksLikeAdjacencyMatrix = value.every(
      (row) => row.length === nodeCount && row.every((cell) => cell === 0 || cell === 1)
    );
    if (looksLikeAdjacencyMatrix) return false;

    return true;
  }

  function shouldVisualizeObjectAsHashMap(name, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (isLikelyTreeObject(value) || isLikelyLinkedListObject(value)) return false;
    if (Object.keys(value).length === 1 && typeof value.__ref__ === 'string') return false;
    if (isLikelyAdjacencyListObject(value)) return false;

    const lowerName = String(name).toLowerCase();
    if (lowerName.includes('map') || lowerName.includes('seen') || lowerName.includes('dict')) {
      return true;
    }
    return Object.keys(value).length > 0;
  }

  function collectRuntimeVisualizations(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { hashMaps: [], objectKinds: {} };
    }

    const visualizations = [];
    const objectKinds = {};
    for (const [name, variableValue] of Object.entries(value)) {
      if (variableValue === undefined) continue;

      if (variableValue instanceof Map) {
        objectKinds[name] = 'map';
        visualizations.push({
          name,
          kind: 'map',
          entries: [...variableValue.entries()].map(([key, mapValue]) => ({
            key: serializeValue(key),
            value: serializeValue(mapValue),
          })),
        });
        continue;
      }

      if (variableValue instanceof Set) {
        objectKinds[name] = 'set';
        visualizations.push({
          name,
          kind: 'set',
          entries: [...variableValue.values()].map((item) => ({
            key: serializeValue(item),
            value: true,
          })),
        });
        continue;
      }

      if (isLikelyIndexedAdjacencyListArray(variableValue)) {
        objectKinds[name] = 'graph-adjacency';
        continue;
      }

      if (variableValue && typeof variableValue === 'object' && !Array.isArray(variableValue)) {
        const serializedValue = variableValue;

        if (serializedValue.__type__ === 'map' && Array.isArray(serializedValue.entries)) {
          objectKinds[name] = 'map';
          visualizations.push({
            name,
            kind: 'map',
            entries: serializedValue.entries
              .filter((entry) => Array.isArray(entry) && entry.length >= 2)
              .map((entry) => ({
                key: entry[0],
                value: entry[1],
              })),
          });
          continue;
        }

        if (serializedValue.__type__ === 'set' && Array.isArray(serializedValue.values)) {
          objectKinds[name] = 'set';
          visualizations.push({
            name,
            kind: 'set',
            entries: serializedValue.values.map((item) => ({
              key: item,
              value: true,
            })),
          });
          continue;
        }

        if (isLikelyTreeObject(serializedValue)) {
          objectKinds[name] = 'tree';
          continue;
        }

        if (isLikelyLinkedListObject(serializedValue)) {
          objectKinds[name] = 'linked-list';
          continue;
        }

        if (isLikelyAdjacencyListObject(serializedValue)) {
          objectKinds[name] = 'graph-adjacency';
          continue;
        }

        if (shouldVisualizeObjectAsHashMap(name, serializedValue)) {
          objectKinds[name] = 'hashmap';
          visualizations.push({
            name,
            kind: 'hashmap',
            entries: Object.entries(serializedValue).map(([key, entryValue]) => ({
              key,
              value: serializeValue(entryValue),
            })),
          });
        }
      }
    }

    return { hashMaps: visualizations, objectKinds };
  }

  function buildVisualizationPayload(value) {
    const { hashMaps, objectKinds } = collectRuntimeVisualizations(value);
    if (hashMaps.length === 0 && Object.keys(objectKinds).length === 0) return undefined;
    return {
      ...(hashMaps.length > 0 ? { hashMaps } : {}),
      ...(Object.keys(objectKinds).length > 0 ? { objectKinds } : {}),
    };
  }

  function createLimitError(reason, lineNumber, message) {
    const error = new Error(message);
    error.__traceLimitExceeded = true;
    error.__timeoutReason = reason;
    error.__traceLine = lineNumber;
    return error;
  }

  function getCurrentFrameId() {
    return callStack[callStack.length - 1]?.id;
  }

  function flushPendingAccesses(frameId) {
    if (frameId === undefined || frameId === null) {
      return undefined;
    }
    const pending = pendingAccessesByFrame.get(frameId);
    if (!Array.isArray(pending) || pending.length === 0) {
      return undefined;
    }
    pendingAccessesByFrame.delete(frameId);
    return pending.map((access) => ({
      variable: access.variable,
      kind: access.kind,
      ...(Array.isArray(access.indices) && access.indices.length > 0
        ? { indices: access.indices }
        : {}),
      ...(access.method ? { method: access.method } : {}),
      ...(access.pathDepth ? { pathDepth: access.pathDepth } : {}),
    }));
  }

  function appendTrace(step, frameId = getCurrentFrameId()) {
    if (trace.length >= maxTraceSteps) {
      const lineNumber = normalizeLine(step?.line, 1);
      if (!traceLimitExceeded) {
        traceLimitExceeded = true;
        timeoutReason = 'trace-limit';
      }
      if (!timeoutRecorded && trace.length < maxTraceSteps) {
        trace.push({
          line: lineNumber,
          event: 'timeout',
          variables: {},
          function: step?.function ?? callStack[callStack.length - 1]?.function ?? '<module>',
          callStack: snapshotCallStack(),
        });
        timeoutRecorded = true;
      }
      throw createLimitError('trace-limit', lineNumber, `Exceeded ${maxTraceSteps} trace steps`);
    }
    const accesses = flushPendingAccesses(frameId);
    trace.push({
      ...step,
      ...(accesses ? { accesses } : {}),
    });
  }

  function markTimeout(reason, lineNumber, message) {
    const normalizedLine = normalizeLine(lineNumber, 1);
    if (!traceLimitExceeded) {
      traceLimitExceeded = true;
      timeoutReason = reason;
    }
    if (!timeoutRecorded && trace.length < maxTraceSteps) {
      appendTrace({
        line: normalizedLine,
        event: 'timeout',
        variables: {},
        function: callStack[callStack.length - 1]?.function ?? '<module>',
        callStack: snapshotCallStack(),
      });
      timeoutRecorded = true;
    }
    throw createLimitError(reason, normalizedLine, message);
  }

  function alignCallStackForLine(functionName, lineNumber, functionStartLine, inferredArgs = {}) {
    const normalizedFunctionName =
      typeof functionName === 'string' && functionName.length > 0 ? functionName : '<module>';

    if (normalizedFunctionName === '<module>') {
      if (callStack.length === 0) {
        const moduleFrame = {
          id: nextFrameId++,
          function: '<module>',
          args: sanitizeVariables(inferredArgs),
          line: lineNumber,
        };
        callStack.push(moduleFrame);
      } else {
        const topFrame = callStack[callStack.length - 1];
        if (
          topFrame?.function === '<module>' &&
          Object.keys(topFrame.args ?? {}).length === 0 &&
          inferredArgs &&
          typeof inferredArgs === 'object'
        ) {
          topFrame.args = sanitizeVariables(inferredArgs);
        }
      }

      while (callStack.length > 1) {
        callStack.pop();
      }
      return '<module>';
    }

    const topFrame = callStack[callStack.length - 1];
    if (!topFrame || topFrame.function !== normalizedFunctionName) {
      const callLine = normalizeLine(functionStartLine, lineNumber);
      const inferredFrame = {
        id: nextFrameId++,
        function: normalizedFunctionName,
        args: sanitizeVariables(inferredArgs),
        line: callLine,
      };
      callStack.push(inferredFrame);
      appendTrace({
        line: callLine,
        event: 'call',
        variables: inferredFrame.args,
        function: normalizedFunctionName,
        callStack: snapshotCallStack(),
        visualization: buildVisualizationPayload(inferredArgs),
      });
    } else if (
      topFrame.function === normalizedFunctionName &&
      Object.keys(topFrame.args ?? {}).length === 0 &&
      inferredArgs &&
      typeof inferredArgs === 'object'
    ) {
      topFrame.args = sanitizeVariables(inferredArgs);
    }

    return normalizedFunctionName;
  }

  return {
    serialize(value) {
      return serializeValue(value);
    },
    read(getter) {
      try {
        return getter();
      } catch {
        return undefined;
      }
    },
    pushCall(functionName, args, lineNumber) {
      const normalizedLine = normalizeLine(lineNumber, 1);
      const normalizedArgs = sanitizeVariables(args);
      if (callStack.length + 1 > maxCallDepth) {
        markTimeout(
          'recursion-limit',
          normalizedLine,
          `Exceeded max call depth (${maxCallDepth})`
        );
      }
      const frame = {
        id: nextFrameId++,
        function: functionName || '<module>',
        args: normalizedArgs,
        line: normalizedLine,
      };
      callStack.push(frame);
      appendTrace({
        line: normalizedLine,
        event: 'call',
        variables: normalizedArgs,
        function: frame.function,
        callStack: snapshotCallStack(),
        visualization: buildVisualizationPayload(args),
      });
    },
    recordAccess(event) {
      if (!event || typeof event !== 'object') {
        return;
      }
      const variable =
        typeof event.variable === 'string' && event.variable.length > 0 ? event.variable : null;
      const kind = typeof event.kind === 'string' ? event.kind : null;
      if (!variable || !kind) {
        return;
      }

      const frameId = getCurrentFrameId();
      if (frameId === undefined) {
        return;
      }

      const normalized = {
        variable,
        kind,
        ...(Array.isArray(event.indices) && event.indices.length > 0
          ? { indices: event.indices.map((index) => Math.trunc(index)) }
          : {}),
        ...(typeof event.method === 'string' && event.method.length > 0
          ? { method: event.method }
          : {}),
        ...(event.pathDepth === 1 || event.pathDepth === 2 ? { pathDepth: event.pathDepth } : {}),
      };

      const existing = pendingAccessesByFrame.get(frameId) ?? [];
      existing.push(normalized);
      pendingAccessesByFrame.set(frameId, existing);
    },
    line(lineNumber, snapshotFactory, functionNameOverride, functionStartLine) {
      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);

      lineEventCount += 1;
      if (lineEventCount > maxLineEvents) {
        markTimeout('line-limit', normalizedLine, `Exceeded ${maxLineEvents} line events`);
      }

      const nextLineHits = (lineHitCount.get(normalizedLine) ?? 0) + 1;
      lineHitCount.set(normalizedLine, nextLineHits);
      if (nextLineHits > maxSingleLineHits) {
        markTimeout(
          'single-line-limit',
          normalizedLine,
          `Line ${normalizedLine} exceeded ${maxSingleLineHits} hits`
        );
      }

      let variables = {};
      let visualization;
      if (typeof snapshotFactory === 'function') {
        try {
          const snapshot = snapshotFactory();
          variables = sanitizeVariables(snapshot);
          visualization = buildVisualizationPayload(snapshot);
        } catch {
          variables = {};
          visualization = undefined;
        }
      }

      const traceFunctionName = alignCallStackForLine(
        functionNameOverride,
        normalizedLine,
        functionStartLine,
        variables
      );

      appendTrace({
        line: normalizedLine,
        event: 'line',
        variables,
        function: traceFunctionName,
        callStack: snapshotCallStack(),
        visualization,
      });
    },
    recordReturn(lineNumber, returnValue, functionNameOverride) {
      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);
      const functionName =
        typeof functionNameOverride === 'string' && functionNameOverride.length > 0
          ? functionNameOverride
          : callStack[callStack.length - 1]?.function ?? '<module>';
      const serializedReturnValue = serializeValue(returnValue);
      const variables = functionName === '<module>' ? { result: serializedReturnValue } : {};
      const visualization = functionName === '<module>'
        ? buildVisualizationPayload({ result: returnValue })
        : undefined;

      appendTrace({
        line: normalizedLine,
        event: 'return',
        variables,
        function: functionName,
        callStack: snapshotCallStack(),
        returnValue: serializedReturnValue,
        visualization,
      });
    },
    recordException(lineNumber, error, functionNameOverride) {
      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);
      appendTrace({
        line: normalizedLine,
        event: 'exception',
        variables: {},
        function:
          typeof functionNameOverride === 'string' && functionNameOverride.length > 0
            ? functionNameOverride
            : callStack[callStack.length - 1]?.function ?? '<module>',
        callStack: snapshotCallStack(),
        returnValue: error instanceof Error ? error.message : String(error),
      });
    },
    popCall() {
      if (callStack.length > 0) {
        const frame = callStack.pop();
        if (frame?.id !== undefined) {
          pendingAccessesByFrame.delete(frame.id);
        }
      }
    },
    popToFunction(functionName) {
      const target = typeof functionName === 'string' && functionName.length > 0 ? functionName : '<module>';
      while (callStack.length > 1 && callStack[callStack.length - 1]?.function !== target) {
        const frame = callStack.pop();
        if (frame?.id !== undefined) {
          pendingAccessesByFrame.delete(frame.id);
        }
      }
    },
    getTrace() {
      return trace;
    },
    getLineEventCount() {
      return lineEventCount;
    },
    getTraceStepCount() {
      return trace.length;
    },
    isTraceLimitExceeded() {
      return traceLimitExceeded;
    },
    getTimeoutReason() {
      return timeoutReason;
    },
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getExecutableLineNumbers(code) {
  if (typeof code !== 'string') return [];
  const lines = code.split('\n');
  const executable = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('//')) continue;
    if (trimmed === '/*' || trimmed === '*/' || trimmed.startsWith('*')) continue;
    executable.push(index + 1);
  }

  return executable;
}

function findFunctionStartLine(code, functionName, executionStyle) {
  if (typeof code !== 'string' || typeof functionName !== 'string' || functionName.length === 0) {
    return null;
  }

  const escapedName = escapeRegExp(functionName);
  const declarationPattern = new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`);
  const assignmentPattern = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=`);
  const classPattern = new RegExp(`\\bclass\\s+${escapedName}\\b`);
  const methodPattern = new RegExp(`\\b${escapedName}\\s*\\(`);
  const lines = code.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (declarationPattern.test(line) || assignmentPattern.test(line)) {
      return index + 1;
    }
    if (executionStyle === 'ops-class' && classPattern.test(line)) {
      return index + 1;
    }
    if (executionStyle === 'solution-method' && methodPattern.test(line)) {
      return index + 1;
    }
  }

  return null;
}

function findFunctionEndLine(code, startLine) {
  if (typeof code !== 'string' || !Number.isFinite(startLine) || startLine <= 0) return null;

  const lines = code.split('\n');
  let braceBalance = 0;
  let opened = false;

  for (let lineIndex = startLine - 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const char = line[charIndex];
      if (char === '{') {
        braceBalance += 1;
        opened = true;
      } else if (char === '}') {
        braceBalance -= 1;
        if (opened && braceBalance <= 0) {
          return lineIndex + 1;
        }
      }
    }
  }

  return null;
}

function determineTraceLineBounds(code, functionName, executionStyle) {
  const executableLines = getExecutableLineNumbers(code);
  if (executableLines.length === 0) {
    return { startLine: 1, endLine: 1 };
  }

  const hasNamedFunction = typeof functionName === 'string' && functionName.length > 0;
  if (!hasNamedFunction) {
    const firstExecutable = executableLines[0];
    const lastExecutable = executableLines[executableLines.length - 1];
    return { startLine: firstExecutable, endLine: lastExecutable };
  }

  const defaultStart = executableLines[0];
  const defaultEnd = executableLines[executableLines.length - 1];
  const startLine = findFunctionStartLine(code, functionName, executionStyle) ?? defaultStart;
  const endLine = findFunctionEndLine(code, startLine) ?? defaultEnd;
  return { startLine, endLine };
}

function createSyntheticTrace(payload, codeResult) {
  const { code, functionName, inputs, executionStyle = 'function' } = payload ?? {};
  const { startLine, endLine } = determineTraceLineBounds(code, functionName, executionStyle);
  const traceFunctionName =
    typeof functionName === 'string' && functionName.length > 0 ? functionName : '<module>';

  const normalizedInputs = normalizeInputs(inputs);
  const inputSnapshot = {};
  for (const [key, value] of Object.entries(normalizedInputs)) {
    inputSnapshot[key] = serializeValue(value);
  }

  const callFrame = {
    function: traceFunctionName,
    args: inputSnapshot,
    line: startLine,
  };

  const returnVariables = { ...inputSnapshot };
  if (traceFunctionName === '<module>') {
    returnVariables.result = codeResult.output;
  }

  return [
    {
      line: startLine,
      event: 'call',
      variables: inputSnapshot,
      function: traceFunctionName,
      callStack: [callFrame],
    },
    {
      line: startLine,
      event: 'line',
      variables: inputSnapshot,
      function: traceFunctionName,
      callStack: [callFrame],
    },
    {
      line: endLine,
      event: 'return',
      variables: returnVariables,
      function: traceFunctionName,
      callStack: [callFrame],
      returnValue: codeResult.output,
      stdoutLineCount: Array.isArray(codeResult.consoleOutput) ? codeResult.consoleOutput.length : 0,
    },
  ];
}

function getTypeScriptCompiler() {
  const ts = self?.ts;
  if (ts && typeof ts.transpileModule === 'function') {
    return ts;
  }
  return null;
}

async function ensureTypeScriptCompiler() {
  if (getTypeScriptCompiler()) return;
  if (typeScriptLoadPromise) return typeScriptLoadPromise;

  typeScriptLoadPromise = (async () => {
    if (typeof importScripts !== 'function') {
      throw new Error('TypeScript compiler is unavailable in this environment.');
    }

    const errors = [];
    for (const compilerUrl of TYPESCRIPT_COMPILER_URLS) {
      try {
        importScripts(compilerUrl);
        if (getTypeScriptCompiler()) {
          return;
        }
        errors.push(`${compilerUrl} (loaded but compiler object was missing)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${compilerUrl} (${message})`);
      }
    }

    throw new Error(`Unable to load TypeScript compiler. Tried: ${errors.join(' | ')}`);
  })();

  try {
    await typeScriptLoadPromise;
  } catch (error) {
    typeScriptLoadPromise = null;
    throw error;
  }
}

function transpileTypeScript(sourceCode) {
  const ts = getTypeScriptCompiler();
  if (!ts) {
    throw new Error('TypeScript compiler failed to initialize.');
  }

  const transpileInput = `${sourceCode}\n\n${TYPESCRIPT_RUNTIME_DECLARATIONS}\n`;
  const transpiled = ts.transpileModule(transpileInput, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      strict: false,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
    fileName: 'solution.ts',
  });

  const diagnostics = Array.isArray(transpiled.diagnostics) ? transpiled.diagnostics : [];
  const errors = diagnostics.filter((diag) => diag.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const first = errors[0];
    const messageText = ts.flattenDiagnosticMessageText(first.messageText, '\n');
    let lineNumber;
    if (first.file && typeof first.start === 'number') {
      const position = first.file.getLineAndCharacterOfPosition(first.start);
      lineNumber = position.line + 1;
    }
    const error = new Error(
      lineNumber ? `TypeScript transpilation failed (line ${lineNumber}): ${messageText}` : `TypeScript transpilation failed: ${messageText}`
    );
    if (lineNumber) {
      error.__tracecodeLine = lineNumber;
    }
    throw error;
  }

  return transpiled.outputText;
}

async function prepareExecutableCode(sourceCode, language) {
  if (language === 'typescript') {
    await ensureTypeScriptCompiler();
    return transpileTypeScript(sourceCode);
  }

  return sourceCode;
}

function addBindingNames(ts, nameNode, names) {
  if (!nameNode) return;
  if (ts.isIdentifier(nameNode)) {
    if (!nameNode.text.startsWith('__trace')) {
      names.add(nameNode.text);
    }
    return;
  }
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isBindingElement(element)) {
        addBindingNames(ts, element.name, names);
      }
    }
  }
}

function collectTraceVariableNames(ts, sourceFile) {
  const names = new Set();

  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      addBindingNames(ts, node.name, names);
    } else if (ts.isParameter(node)) {
      addBindingNames(ts, node.name, names);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingNames(ts, node.variableDeclaration.name, names);
    } else if (
      ts.isBinaryExpression(node) &&
      node.left &&
      ts.isIdentifier(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      names.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...names];
}

function shouldTraceStatement(ts, statement) {
  return !(
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEmptyStatement(statement) ||
    ts.isBlock(statement)
  );
}

function getNodeNameText(ts, nameNode) {
  if (!nameNode) return null;
  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
    return nameNode.text;
  }
  if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return String(nameNode.text);
  }
  return null;
}

function inferTraceFunctionName(ts, node, fallbackFunctionName) {
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }

  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return getNodeNameText(ts, node.name) || fallbackFunctionName;
  }

  if (ts.isConstructorDeclaration(node)) {
    const className =
      node.parent && ts.isClassLike(node.parent) && node.parent.name && ts.isIdentifier(node.parent.name)
        ? node.parent.name.text
        : null;
    return className ? `${className}.constructor` : 'constructor';
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (parent && ts.isPropertyAssignment(parent)) {
      return getNodeNameText(ts, parent.name) || fallbackFunctionName;
    }
    if (parent && ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left)) {
      return parent.left.text;
    }
  }

  return fallbackFunctionName;
}

function buildLineFunctionMap(ts, sourceFile, defaultFunctionName) {
  const lineFunctionMap = new Map();

  function mapStatementLine(statementNode, functionName, functionStartLine) {
    const lineNumber = sourceFile.getLineAndCharacterOfPosition(statementNode.getStart(sourceFile)).line + 1;
    if (!lineFunctionMap.has(lineNumber)) {
      lineFunctionMap.set(lineNumber, {
        functionName,
        functionStartLine,
      });
    }
  }

  function visitNode(node, currentFunctionName, currentFunctionStartLine) {
    const nextFunctionName = ts.isFunctionLike(node)
      ? inferTraceFunctionName(ts, node, currentFunctionName)
      : currentFunctionName;
    const nextFunctionStartLine = ts.isFunctionLike(node)
      ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      : currentFunctionStartLine;

    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      for (const statement of node.statements) {
        visitNode(statement, currentFunctionName, currentFunctionStartLine);
      }
      return;
    }

    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (const statement of node.statements) {
        visitNode(statement, currentFunctionName, currentFunctionStartLine);
      }
      return;
    }

    if (ts.isFunctionLike(node)) {
      if (node.body) {
        visitNode(node.body, nextFunctionName, nextFunctionStartLine);
      }
      return;
    }

    if (ts.isStatement(node) && shouldTraceStatement(ts, node)) {
      mapStatementLine(node, currentFunctionName, currentFunctionStartLine);
    }

    ts.forEachChild(node, (child) => visitNode(child, currentFunctionName, currentFunctionStartLine));
  }

  visitNode(sourceFile, defaultFunctionName, 1);
  return lineFunctionMap;
}

function unwrapParenthesizedExpression(ts, node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isAssignmentOperatorToken(ts, tokenKind) {
  return tokenKind >= ts.SyntaxKind.FirstAssignment && tokenKind <= ts.SyntaxKind.LastAssignment;
}

function isAssignmentLikeLeftOperand(ts, node) {
  const parent = node?.parent;
  return Boolean(
    parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignmentOperatorToken(ts, parent.operatorToken.kind)
  );
}

function isUpdateExpressionOperand(ts, node) {
  const parent = node?.parent;
  if (!parent) return false;

  if (ts.isPrefixUnaryExpression(parent)) {
    return (
      parent.operand === node &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    );
  }

  if (ts.isPostfixUnaryExpression(parent)) {
    return (
      parent.operand === node &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    );
  }

  return false;
}

function isDestructuringAssignmentTarget(ts, node) {
  let current = node;
  let parent = node?.parent;

  while (
    parent &&
    (ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent))
  ) {
    current = parent;
    parent = parent.parent;
  }

  return Boolean(
    parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === current &&
      isAssignmentOperatorToken(ts, parent.operatorToken.kind)
  );
}

function isNestedElementAccessExpression(ts, node) {
  const parent = node?.parent;
  return Boolean(parent && ts.isElementAccessExpression(parent) && parent.expression === node);
}

function extractTraceableElementAccess(ts, node) {
  const indices = [];
  let current = unwrapParenthesizedExpression(ts, node);

  while (current && ts.isElementAccessExpression(current) && indices.length < 3) {
    indices.unshift(current.argumentExpression);
    current = unwrapParenthesizedExpression(ts, current.expression);
  }

  if (!current || !ts.isIdentifier(current) || indices.length === 0 || indices.length > 2) {
    return null;
  }

  return {
    variableName: current.text,
    indices,
  };
}

function extractTraceableMutatingCall(ts, node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }

  const receiver = unwrapParenthesizedExpression(ts, node.expression.expression);
  const methodName = node.expression.name.text;
  if (!receiver || !ts.isIdentifier(receiver) || !isTraceableMutatingMethod(methodName)) {
    return null;
  }

  return {
    variableName: receiver.text,
    methodName,
  };
}

function getCompoundAssignmentOperatorName(ts, tokenKind) {
  switch (tokenKind) {
    case ts.SyntaxKind.PlusEqualsToken:
      return 'add';
    case ts.SyntaxKind.MinusEqualsToken:
      return 'sub';
    case ts.SyntaxKind.AsteriskEqualsToken:
      return 'mul';
    case ts.SyntaxKind.SlashEqualsToken:
      return 'div';
    case ts.SyntaxKind.PercentEqualsToken:
      return 'mod';
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
      return 'pow';
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
      return 'lshift';
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return 'rshift';
    case ts.SyntaxKind.AmpersandEqualsToken:
      return 'bitand';
    case ts.SyntaxKind.BarEqualsToken:
      return 'bitor';
    case ts.SyntaxKind.CaretEqualsToken:
      return 'bitxor';
    default:
      return null;
  }
}

function createIndicesArrayExpression(ts, indices) {
  return ts.factory.createArrayLiteralExpression(indices, false);
}

function createTraceReadIndexExpression(ts, variableName, indices) {
  return ts.factory.createCallExpression(ts.factory.createIdentifier('__traceReadIndex'), undefined, [
    ts.factory.createStringLiteral(variableName),
    ts.factory.createIdentifier(variableName),
    createIndicesArrayExpression(ts, indices),
  ]);
}

function createTraceWriteIndexExpression(ts, variableName, indices, value) {
  return ts.factory.createCallExpression(ts.factory.createIdentifier('__traceWriteIndex'), undefined, [
    ts.factory.createStringLiteral(variableName),
    ts.factory.createIdentifier(variableName),
    createIndicesArrayExpression(ts, indices),
    value,
  ]);
}

function createTraceAugAssignExpression(ts, variableName, indices, operatorName, rhs) {
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__traceAugAssignIndex'),
    undefined,
    [
      ts.factory.createStringLiteral(variableName),
      ts.factory.createIdentifier(variableName),
      createIndicesArrayExpression(ts, indices),
      ts.factory.createStringLiteral(operatorName),
      rhs,
    ]
  );
}

function createTraceUpdateExpression(ts, variableName, indices, operatorName, isPrefix) {
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__traceUpdateIndex'),
    undefined,
    [
      ts.factory.createStringLiteral(variableName),
      ts.factory.createIdentifier(variableName),
      createIndicesArrayExpression(ts, indices),
      ts.factory.createStringLiteral(operatorName),
      isPrefix ? ts.factory.createTrue() : ts.factory.createFalse(),
    ]
  );
}

function createTraceMutatingCallExpression(ts, variableName, methodName, args) {
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__traceMutatingCall'),
    undefined,
    [
      ts.factory.createStringLiteral(variableName),
      ts.factory.createIdentifier(variableName),
      ts.factory.createStringLiteral(methodName),
      ...args,
    ]
  );
}

function createSnapshotFactory(ts, variableNames) {
  const properties = variableNames.map((name) =>
    ts.factory.createPropertyAssignment(
      ts.factory.createIdentifier(name),
      ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier('__traceRecorder'),
          ts.factory.createIdentifier('read')
        ),
        undefined,
        [
          ts.factory.createArrowFunction(
            undefined,
            undefined,
            [],
            undefined,
            ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
            ts.factory.createIdentifier(name)
          ),
        ]
      )
    )
  );

  return ts.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.factory.createParenthesizedExpression(
      ts.factory.createObjectLiteralExpression(properties, false)
    )
  );
}

function createTraceLineStatement(ts, sourceFile, statement, variableNames, lineFunctionMap, defaultFunctionName) {
  const lineNumber = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
  const functionContext = lineFunctionMap.get(lineNumber);
  const traceFunctionName = functionContext?.functionName ?? defaultFunctionName;
  const traceFunctionStartLine = functionContext?.functionStartLine ?? lineNumber;
  return ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier('__traceRecorder'),
        ts.factory.createIdentifier('line')
      ),
      undefined,
      [
        ts.factory.createNumericLiteral(lineNumber),
        createSnapshotFactory(ts, variableNames),
        ts.factory.createStringLiteral(traceFunctionName),
        ts.factory.createNumericLiteral(traceFunctionStartLine),
      ]
    )
  );
}

function collectFunctionParameterNames(ts, functionLikeNode) {
  const names = new Set();
  for (const parameter of functionLikeNode.parameters ?? []) {
    addBindingNames(ts, parameter.name, names);
  }
  return [...names];
}

function createTraceRecorderStatement(ts, methodName, args) {
  return ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier('__traceRecorder'),
        ts.factory.createIdentifier(methodName)
      ),
      undefined,
      args
    )
  );
}

function createInstrumentedReturnBlock(ts, sourceFile, returnStatement, traceFunctionName) {
  const returnLine = sourceFile.getLineAndCharacterOfPosition(returnStatement.getStart(sourceFile)).line + 1;
  const capturedValueName = ts.factory.createUniqueName('__traceReturnValue');
  const returnValueInitializer = returnStatement.expression ?? ts.factory.createIdentifier('undefined');

  return ts.factory.createBlock(
    [
      ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              capturedValueName,
              undefined,
              undefined,
              returnValueInitializer
            ),
          ],
          ts.NodeFlags.Const
        )
      ),
      createTraceRecorderStatement(ts, 'recordReturn', [
        ts.factory.createNumericLiteral(returnLine),
        capturedValueName,
        ts.factory.createStringLiteral(traceFunctionName),
      ]),
      ts.factory.createReturnStatement(capturedValueName),
    ],
    true
  );
}

function rewriteFunctionReturnStatements(ts, sourceFile, context, functionBody, traceFunctionName) {
  const rewrite = (node) => {
    // Nested functions should own their own return instrumentation.
    if (node !== functionBody && ts.isFunctionLike(node)) {
      return node;
    }

    if (ts.isReturnStatement(node)) {
      return createInstrumentedReturnBlock(ts, sourceFile, node, traceFunctionName);
    }

    return ts.visitEachChild(node, rewrite, context);
  };

  return ts.visitEachChild(functionBody, rewrite, context);
}

function updateFunctionLikeWithBody(ts, functionLikeNode, body) {
  if (ts.isFunctionDeclaration(functionLikeNode)) {
    return ts.factory.updateFunctionDeclaration(
      functionLikeNode,
      functionLikeNode.modifiers,
      functionLikeNode.asteriskToken,
      functionLikeNode.name,
      functionLikeNode.typeParameters,
      functionLikeNode.parameters,
      functionLikeNode.type,
      body
    );
  }

  if (ts.isFunctionExpression(functionLikeNode)) {
    return ts.factory.updateFunctionExpression(
      functionLikeNode,
      functionLikeNode.modifiers,
      functionLikeNode.asteriskToken,
      functionLikeNode.name,
      functionLikeNode.typeParameters,
      functionLikeNode.parameters,
      functionLikeNode.type,
      body
    );
  }

  if (ts.isArrowFunction(functionLikeNode)) {
    return ts.factory.updateArrowFunction(
      functionLikeNode,
      functionLikeNode.modifiers,
      functionLikeNode.typeParameters,
      functionLikeNode.parameters,
      functionLikeNode.type,
      functionLikeNode.equalsGreaterThanToken,
      body
    );
  }

  if (ts.isMethodDeclaration(functionLikeNode)) {
    return ts.factory.updateMethodDeclaration(
      functionLikeNode,
      functionLikeNode.modifiers,
      functionLikeNode.asteriskToken,
      functionLikeNode.name,
      functionLikeNode.questionToken,
      functionLikeNode.typeParameters,
      functionLikeNode.parameters,
      functionLikeNode.type,
      body
    );
  }

  if (ts.isConstructorDeclaration(functionLikeNode)) {
    return ts.factory.updateConstructorDeclaration(
      functionLikeNode,
      functionLikeNode.modifiers,
      functionLikeNode.parameters,
      body
    );
  }

  if (ts.isGetAccessorDeclaration(functionLikeNode)) {
    return ts.factory.updateGetAccessorDeclaration(
      functionLikeNode,
      functionLikeNode.modifiers,
      functionLikeNode.name,
      functionLikeNode.parameters,
      functionLikeNode.type,
      body
    );
  }

  if (ts.isSetAccessorDeclaration(functionLikeNode)) {
    return ts.factory.updateSetAccessorDeclaration(
      functionLikeNode,
      functionLikeNode.modifiers,
      functionLikeNode.name,
      functionLikeNode.parameters,
      body
    );
  }

  return functionLikeNode;
}

function wrapFunctionBodyForTracing(
  ts,
  sourceFile,
  context,
  functionLikeNode,
  functionBody,
  defaultFunctionName
) {
  const traceFunctionName = inferTraceFunctionName(ts, functionLikeNode, defaultFunctionName);
  const functionStartLine = sourceFile.getLineAndCharacterOfPosition(functionLikeNode.getStart(sourceFile)).line + 1;
  const functionEndPosition = Math.max(functionBody.getEnd() - 1, functionBody.getStart(sourceFile));
  const functionEndLine = sourceFile.getLineAndCharacterOfPosition(functionEndPosition).line + 1;
  const parameterNames = collectFunctionParameterNames(ts, functionLikeNode);

  const rewrittenBody = rewriteFunctionReturnStatements(
    ts,
    sourceFile,
    context,
    functionBody,
    traceFunctionName
  );

  const argsSnapshotExpression = ts.factory.createCallExpression(
    ts.factory.createParenthesizedExpression(createSnapshotFactory(ts, parameterNames)),
    undefined,
    []
  );

  const wrappedBody = ts.factory.createBlock(
    [
      createTraceRecorderStatement(ts, 'pushCall', [
        ts.factory.createStringLiteral(traceFunctionName),
        argsSnapshotExpression,
        ts.factory.createNumericLiteral(functionStartLine),
      ]),
      ts.factory.createTryStatement(
        ts.factory.createBlock(
          [
            ...rewrittenBody.statements,
            createTraceRecorderStatement(ts, 'recordReturn', [
              ts.factory.createNumericLiteral(functionEndLine),
              ts.factory.createIdentifier('undefined'),
              ts.factory.createStringLiteral(traceFunctionName),
            ]),
          ],
          true
        ),
        undefined,
        ts.factory.createBlock([createTraceRecorderStatement(ts, 'popCall', [])], true)
      ),
    ],
    true
  );

  return updateFunctionLikeWithBody(ts, functionLikeNode, wrappedBody);
}

async function instrumentCodeForTracing(sourceCode, language, traceFunctionName) {
  await ensureTypeScriptCompiler();
  const ts = getTypeScriptCompiler();
  if (!ts || typeof sourceCode !== 'string') {
    return null;
  }

  const scriptKind = language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    `trace-input.${language === 'typescript' ? 'ts' : 'js'}`,
    sourceCode,
    ts.ScriptTarget.ES2020,
    true,
    scriptKind
  );

  const variableNames = collectTraceVariableNames(ts, sourceFile);
  const effectiveFunctionName =
    typeof traceFunctionName === 'string' && traceFunctionName.length > 0
      ? traceFunctionName
      : '<module>';
  const lineFunctionMap = buildLineFunctionMap(ts, sourceFile, effectiveFunctionName);

  const transformer = (context) => {
    const visit = (node) => {
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        const tracedOperand = extractTraceableElementAccess(ts, node.operand);
        const operatorName =
          node.operator === ts.SyntaxKind.PlusPlusToken
            ? 'inc'
            : node.operator === ts.SyntaxKind.MinusMinusToken
              ? 'dec'
              : null;
        if (tracedOperand && operatorName) {
          const visitedIndices = tracedOperand.indices.map((indexExpr) => ts.visitNode(indexExpr, visit));
          return createTraceUpdateExpression(
            ts,
            tracedOperand.variableName,
            visitedIndices,
            operatorName,
            ts.isPrefixUnaryExpression(node)
          );
        }
      }

      if (ts.isBinaryExpression(node)) {
        const tracedLeft = extractTraceableElementAccess(ts, node.left);
        if (tracedLeft && isAssignmentOperatorToken(ts, node.operatorToken.kind)) {
          const visitedIndices = tracedLeft.indices.map((indexExpr) => ts.visitNode(indexExpr, visit));
          const visitedRight = ts.visitNode(node.right, visit);
          if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            return createTraceWriteIndexExpression(
              ts,
              tracedLeft.variableName,
              visitedIndices,
              visitedRight
            );
          }

          const operatorName = getCompoundAssignmentOperatorName(ts, node.operatorToken.kind);
          if (operatorName) {
            return createTraceAugAssignExpression(
              ts,
              tracedLeft.variableName,
              visitedIndices,
              operatorName,
              visitedRight
            );
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const tracedCall = extractTraceableMutatingCall(ts, node);
        if (tracedCall) {
          const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visit));
          return createTraceMutatingCallExpression(
            ts,
            tracedCall.variableName,
            tracedCall.methodName,
            visitedArgs
          );
        }
      }

      if (ts.isElementAccessExpression(node)) {
        if (
          isNestedElementAccessExpression(ts, node) ||
          isAssignmentLikeLeftOperand(ts, node) ||
          isUpdateExpressionOperand(ts, node) ||
          isDestructuringAssignmentTarget(ts, node)
        ) {
          return ts.visitEachChild(node, visit, context);
        }

        const tracedAccess = extractTraceableElementAccess(ts, node);
        if (tracedAccess) {
          const visitedIndices = tracedAccess.indices.map((indexExpr) => ts.visitNode(indexExpr, visit));
          return createTraceReadIndexExpression(ts, tracedAccess.variableName, visitedIndices);
        }
      }

      if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body)) {
        const visitedFunction = ts.visitEachChild(node, visit, context);
        if (!visitedFunction.body || !ts.isBlock(visitedFunction.body)) {
          return visitedFunction;
        }
        return wrapFunctionBodyForTracing(
          ts,
          sourceFile,
          context,
          visitedFunction,
          visitedFunction.body,
          effectiveFunctionName
        );
      }

      if (ts.isSourceFile(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        const nextStatements = [];
        for (const statement of visited.statements) {
          if (shouldTraceStatement(ts, statement)) {
            nextStatements.push(
              createTraceLineStatement(
                ts,
                sourceFile,
                statement,
                variableNames,
                lineFunctionMap,
                effectiveFunctionName
              )
            );
          }
          nextStatements.push(statement);
        }
        return ts.factory.updateSourceFile(visited, ts.factory.createNodeArray(nextStatements));
      }

      if (ts.isBlock(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        const nextStatements = [];
        for (const statement of visited.statements) {
          if (shouldTraceStatement(ts, statement)) {
            nextStatements.push(
              createTraceLineStatement(
                ts,
                sourceFile,
                statement,
                variableNames,
                lineFunctionMap,
                effectiveFunctionName
              )
            );
          }
          nextStatements.push(statement);
        }
        return ts.factory.updateBlock(visited, ts.factory.createNodeArray(nextStatements));
      }

      if (ts.isCaseClause(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        const nextStatements = [];
        for (const statement of visited.statements) {
          if (shouldTraceStatement(ts, statement)) {
            nextStatements.push(
              createTraceLineStatement(
                ts,
                sourceFile,
                statement,
                variableNames,
                lineFunctionMap,
                effectiveFunctionName
              )
            );
          }
          nextStatements.push(statement);
        }
        return ts.factory.updateCaseClause(visited, visited.expression, ts.factory.createNodeArray(nextStatements));
      }

      if (ts.isDefaultClause(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        const nextStatements = [];
        for (const statement of visited.statements) {
          if (shouldTraceStatement(ts, statement)) {
            nextStatements.push(
              createTraceLineStatement(
                ts,
                sourceFile,
                statement,
                variableNames,
                lineFunctionMap,
                effectiveFunctionName
              )
            );
          }
          nextStatements.push(statement);
        }
        return ts.factory.updateDefaultClause(visited, ts.factory.createNodeArray(nextStatements));
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (node) => ts.visitNode(node, visit);
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    const outputFile = transformed.transformed[0];
    const printer = ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    });
    return printer.printFile(outputFile);
  } finally {
    transformed.dispose();
  }
}

function buildScriptExecutionRunner(code) {
  return new Function(
    'console',
    `"use strict";
${JAVASCRIPT_RUNTIME_PRELUDE}
let result;
${code}
if (typeof result === 'undefined') {
  return null;
}
return result;`
  );
}

const TRACING_RUNTIME_HELPERS_SOURCE = `
function __traceNormalizeIndices(__indices, __maxDepth = 2) {
  if (!Array.isArray(__indices) || __indices.length === 0 || __indices.length > __maxDepth) return null;
  if (!__indices.every((__index) => typeof __index === 'number' && Number.isInteger(__index))) return null;
  return __indices.map((__index) => Math.trunc(__index));
}

function __traceReadValueAtIndices(__container, __indices) {
  let __current = __container;
  for (const __index of __indices) {
    if (__current === null || __current === undefined) return undefined;
    __current = __current[__index];
  }
  return __current;
}

function __traceWriteValueAtIndices(__container, __indices, __value) {
  if (__indices.length === 1) {
    __container[__indices[0]] = __value;
    return __value;
  }
  let __parent = __container;
  for (let __i = 0; __i < __indices.length - 1; __i++) {
    __parent = __parent?.[__indices[__i]];
  }
  if (__parent !== null && __parent !== undefined) {
    __parent[__indices[__indices.length - 1]] = __value;
  }
  return __value;
}

function __traceReadIndex(__varName, __container, __indices) {
  const __normalized = __traceNormalizeIndices(__indices);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',
      indices: __normalized,
      pathDepth: __normalized.length,
    });
  }
  return __traceReadValueAtIndices(__container, Array.isArray(__indices) ? __indices : []);
}

function __traceWriteIndex(__varName, __container, __indices, __value) {
  const __normalized = __traceNormalizeIndices(__indices);
  const __result = __traceWriteValueAtIndices(__container, Array.isArray(__indices) ? __indices : [], __value);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',
      indices: __normalized,
      pathDepth: __normalized.length,
    });
  }
  return __result;
}

function __traceApplyAugmentedValue(__current, __op, __rhs) {
  switch (__op) {
    case 'add': return __current + __rhs;
    case 'sub': return __current - __rhs;
    case 'mul': return __current * __rhs;
    case 'div': return __current / __rhs;
    case 'mod': return __current % __rhs;
    case 'pow': return __current ** __rhs;
    case 'lshift': return __current << __rhs;
    case 'rshift': return __current >> __rhs;
    case 'bitand': return __current & __rhs;
    case 'bitor': return __current | __rhs;
    case 'bitxor': return __current ^ __rhs;
    default: return __rhs;
  }
}

function __traceAugAssignIndex(__varName, __container, __indices, __op, __rhs) {
  const __normalized = __traceNormalizeIndices(__indices);
  const __effectiveIndices = Array.isArray(__indices) ? __indices : [];
  const __current = __traceReadValueAtIndices(__container, __effectiveIndices);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',
      indices: __normalized,
      pathDepth: __normalized.length,
    });
  }
  const __next = __traceApplyAugmentedValue(__current, __op, __rhs);
  __traceWriteValueAtIndices(__container, __effectiveIndices, __next);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',
      indices: __normalized,
      pathDepth: __normalized.length,
    });
  }
  return __next;
}

function __traceUpdateIndex(__varName, __container, __indices, __op, __isPrefix) {
  const __normalized = __traceNormalizeIndices(__indices);
  const __effectiveIndices = Array.isArray(__indices) ? __indices : [];
  const __current = __traceReadValueAtIndices(__container, __effectiveIndices);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',
      indices: __normalized,
      pathDepth: __normalized.length,
    });
  }
  const __delta = __op === 'dec' ? -1 : 1;
  const __next = __current + __delta;
  __traceWriteValueAtIndices(__container, __effectiveIndices, __next);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',
      indices: __normalized,
      pathDepth: __normalized.length,
    });
  }
  return __isPrefix ? __next : __current;
}

function __traceMutatingCall(__varName, __container, __method, ...__args) {
  const __result = __container[__method](...__args);
  if (['push', 'pop', 'shift', 'unshift', 'splice'].includes(__method)) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: 'mutating-call',
      method: __method,
      pathDepth: 1,
    });
  }
  return __result;
}
`;

function buildScriptTracingRunner(code) {
  return new Function(
    'console',
    '__traceRecorder',
    '__traceCtx',
    `"use strict";
${JAVASCRIPT_RUNTIME_PRELUDE}
${TRACING_RUNTIME_HELPERS_SOURCE}
let result;
${code}
if (typeof result === 'undefined') {
  return null;
}
return result;`
  );
}

function buildFunctionExecutionRunner(code, executionStyle, argNames) {
  if (executionStyle === 'function') {
    return new Function(
      'console',
      '__functionName',
      ...argNames,
      `"use strict";
${JAVASCRIPT_RUNTIME_PRELUDE}
${code}
let __target;
try {
  __target = eval(__functionName);
} catch (_err) {
  __target = undefined;
}
if (typeof __target !== 'function') {
  throw new Error('Function "' + __functionName + '" not found');
}
return __target(${argNames.join(', ')});`
    );
  }

  if (executionStyle === 'solution-method') {
    return new Function(
      'console',
      '__functionName',
      ...argNames,
      `"use strict";
${JAVASCRIPT_RUNTIME_PRELUDE}
${code}
if (typeof Solution !== 'function') {
  throw new Error('Class "Solution" not found');
}
const __solver = new Solution();
const __method = __solver[__functionName];
if (typeof __method !== 'function') {
  throw new Error('Method "Solution.' + __functionName + '" not found');
}
return __method.call(__solver, ${argNames.join(', ')});`
    );
  }

  if (executionStyle === 'ops-class') {
    return new Function(
      'console',
      '__className',
      '__operations',
      '__arguments',
      `"use strict";
${JAVASCRIPT_RUNTIME_PRELUDE}
${code}
if (!Array.isArray(__operations) || !Array.isArray(__arguments)) {
  throw new Error('ops-class execution requires inputs.operations and inputs.arguments (or ops/args)');
}
if (__operations.length !== __arguments.length) {
  throw new Error('operations and arguments must have the same length');
}
let __targetClass;
try {
  __targetClass = eval(__className);
} catch (_err) {
  __targetClass = undefined;
}
if (typeof __targetClass !== 'function') {
  throw new Error('Class "' + __className + '" not found');
}
let __instance = null;
const __out = [];
for (let __i = 0; __i < __operations.length; __i++) {
  const __op = __operations[__i];
  let __callArgs = __arguments[__i];
  if (__callArgs === null || __callArgs === undefined) {
    __callArgs = [];
  }
  if (!Array.isArray(__callArgs)) {
    __callArgs = [__callArgs];
  }
  if (__i === 0) {
    __instance = new __targetClass(...__callArgs);
    __out.push(null);
    continue;
  }
  if (!__instance || typeof __instance[__op] !== 'function') {
    throw new Error('Required method "' + __op + '" is not implemented on ' + (__className || 'target class'));
  }
  __out.push(__instance[__op](...__callArgs));
}
return __out;`
    );
  }

  throw new Error(`Execution style "${executionStyle}" is not supported for JavaScript runtime yet.`);
}

function buildFunctionTracingRunner(code, executionStyle, argNames) {
  if (executionStyle === 'function') {
    return new Function(
      'console',
      '__traceRecorder',
      '__traceCtx',
      '__functionName',
      ...argNames,
      `"use strict";
${JAVASCRIPT_RUNTIME_PRELUDE}
${TRACING_RUNTIME_HELPERS_SOURCE}
${code}
let __target;
try {
  __target = eval(__functionName);
} catch (_err) {
  __target = undefined;
}
if (typeof __target !== 'function') {
  throw new Error('Function "' + __functionName + '" not found');
}
return __target(${argNames.join(', ')});`
    );
  }

  if (executionStyle === 'solution-method') {
    return new Function(
      'console',
      '__traceRecorder',
      '__traceCtx',
      '__functionName',
      ...argNames,
      `"use strict";
${JAVASCRIPT_RUNTIME_PRELUDE}
${TRACING_RUNTIME_HELPERS_SOURCE}
${code}
if (typeof Solution !== 'function') {
  throw new Error('Class "Solution" not found');
}
const __solver = new Solution();
const __method = __solver[__functionName];
if (typeof __method !== 'function') {
  throw new Error('Method "Solution.' + __functionName + '" not found');
}
return __method.call(__solver, ${argNames.join(', ')});`
    );
  }

  if (executionStyle === 'ops-class') {
    return new Function(
      'console',
      '__traceRecorder',
      '__traceCtx',
      '__className',
      '__operations',
      '__arguments',
      `"use strict";
${JAVASCRIPT_RUNTIME_PRELUDE}
${TRACING_RUNTIME_HELPERS_SOURCE}
${code}
if (!Array.isArray(__operations) || !Array.isArray(__arguments)) {
  throw new Error('ops-class execution requires inputs.operations and inputs.arguments (or ops/args)');
}
if (__operations.length !== __arguments.length) {
  throw new Error('operations and arguments must have the same length');
}
let __targetClass;
try {
  __targetClass = eval(__className);
} catch (_err) {
  __targetClass = undefined;
}
if (typeof __targetClass !== 'function') {
  throw new Error('Class "' + __className + '" not found');
}
let __instance = null;
const __out = [];
for (let __i = 0; __i < __operations.length; __i++) {
  const __op = __operations[__i];
  let __callArgs = __arguments[__i];
  if (__callArgs === null || __callArgs === undefined) {
    __callArgs = [];
  }
  if (!Array.isArray(__callArgs)) {
    __callArgs = [__callArgs];
  }
  if (__i === 0) {
    __instance = new __targetClass(...__callArgs);
    __out.push(null);
    continue;
  }
  if (!__instance || typeof __instance[__op] !== 'function') {
    throw new Error('Required method "' + __op + '" is not implemented on ' + (__className || 'target class'));
  }
  __out.push(__instance[__op](...__callArgs));
}
return __out;`
    );
  }

  throw new Error(`Execution style "${executionStyle}" is not supported for JavaScript runtime yet.`);
}

function getOpsClassInputs(inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return { operations: null, argumentsList: null };
  }
  const operations = Array.isArray(inputs.operations)
    ? inputs.operations
    : (Array.isArray(inputs.ops) ? inputs.ops : null);
  const argumentsList = Array.isArray(inputs.arguments)
    ? inputs.arguments
    : (Array.isArray(inputs.args) ? inputs.args : null);
  return { operations, argumentsList };
}

async function executeCode(payload) {
  const {
    code,
    functionName,
    inputs,
    executionStyle = 'function',
    language = 'javascript',
  } = payload ?? {};
  const consoleOutput = [];
  const consoleProxy = createConsoleProxy(consoleOutput);
  const normalizedInputs = normalizeInputs(inputs);

  try {
    if (typeof code !== 'string') {
      throw new Error('`code` must be a string');
    }
    if (language !== 'javascript' && language !== 'typescript') {
      throw new Error(`Unsupported language for JavaScript worker: ${String(language)}`);
    }

    const executableCode = await prepareExecutableCode(code, language);
    const hasNamedFunction = typeof functionName === 'string' && functionName.length > 0;
    let output;

    if (hasNamedFunction) {
      if (executionStyle === 'ops-class') {
        const { operations, argumentsList } = getOpsClassInputs(normalizedInputs);
        const runner = buildFunctionExecutionRunner(executableCode, executionStyle, []);
        output = await Promise.resolve(runner(consoleProxy, functionName, operations, argumentsList));
      } else {
        const inputKeys = Object.keys(normalizedInputs);
        const argNames = inputKeys.map((_, index) => `__arg${index}`);
        const argValues = inputKeys.map((key) => normalizedInputs[key]);
        const runner = buildFunctionExecutionRunner(executableCode, executionStyle, argNames);
        output = await Promise.resolve(runner(consoleProxy, functionName, ...argValues));
      }
    } else {
      if (executionStyle !== 'function') {
        throw new Error('Script-mode execution only supports executionStyle="function".');
      }
      const runner = buildScriptExecutionRunner(executableCode);
      output = await Promise.resolve(runner(consoleProxy));
    }

    return {
      success: true,
      output: serializeValue(output),
      consoleOutput,
    };
  } catch (error) {
    const message = formatRuntimeErrorMessage(error);
    return {
      success: false,
      output: null,
      error: message,
      errorLine: extractUserErrorLine(error),
      consoleOutput,
    };
  }
}

async function executeWithTracing(payload) {
  const startedAt = performanceNow();
  const {
    code,
    functionName,
    inputs,
    options,
    executionStyle = 'function',
    language = 'javascript',
  } = payload ?? {};
  const consoleOutput = [];
  const consoleProxy = createConsoleProxy(consoleOutput);
  const normalizedInputs = normalizeInputs(inputs);
  const hasNamedFunction = typeof functionName === 'string' && functionName.length > 0;
  const traceFunctionName = hasNamedFunction ? functionName : '<module>';
  const traceRecorder = createTraceRecorder(options);

  let traceLineBounds = { startLine: 1, endLine: 1 };

  try {
    if (typeof code !== 'string') {
      throw new Error('`code` must be a string');
    }
    if (language !== 'javascript' && language !== 'typescript') {
      throw new Error(`Unsupported language for JavaScript worker: ${String(language)}`);
    }

    const executableCode = await prepareExecutableCode(code, language);
    traceLineBounds = determineTraceLineBounds(executableCode, functionName, executionStyle);

    let instrumentedCode = null;
    try {
      instrumentedCode = await instrumentCodeForTracing(executableCode, language, traceFunctionName);
    } catch (instrumentationError) {
      if (WORKER_DEBUG) {
        const message =
          instrumentationError instanceof Error ? instrumentationError.message : String(instrumentationError);
        console.warn('[JavaScriptWorker] trace instrumentation failed, using synthetic fallback:', message);
      }
    }

    if (!instrumentedCode) {
      const fallbackResult = await executeCode(payload);
      const executionTimeMs = performanceNow() - startedAt;

      if (!fallbackResult.success) {
        return {
          success: false,
          error: fallbackResult.error,
          errorLine: fallbackResult.errorLine,
          trace: [],
          executionTimeMs,
          consoleOutput: fallbackResult.consoleOutput ?? [],
          lineEventCount: 0,
          traceStepCount: 0,
        };
      }

      const syntheticTrace = createSyntheticTrace(payload, fallbackResult);
      return {
        success: true,
        output: fallbackResult.output,
        trace: syntheticTrace,
        executionTimeMs,
        consoleOutput: fallbackResult.consoleOutput ?? [],
        lineEventCount: syntheticTrace.filter((step) => step.event === 'line').length,
        traceStepCount: syntheticTrace.length,
      };
    }

    const serializedInputs = {};
    for (const [key, value] of Object.entries(normalizedInputs)) {
      serializedInputs[key] = serializeValue(value);
    }

    let output;
    if (hasNamedFunction) {
      if (executionStyle === 'ops-class') {
        const { operations, argumentsList } = getOpsClassInputs(normalizedInputs);
        const runner = buildFunctionTracingRunner(instrumentedCode, executionStyle, []);
        output = await Promise.resolve(
          runner(
            consoleProxy,
            traceRecorder,
            { functionName: traceFunctionName },
            functionName,
            operations,
            argumentsList
          )
        );
      } else {
        const inputKeys = Object.keys(normalizedInputs);
        const argNames = inputKeys.map((_, index) => `__arg${index}`);
        const argValues = inputKeys.map((key) => normalizedInputs[key]);
        const runner = buildFunctionTracingRunner(instrumentedCode, executionStyle, argNames);
        output = await Promise.resolve(
          runner(consoleProxy, traceRecorder, { functionName: traceFunctionName }, functionName, ...argValues)
        );
      }
    } else {
      if (executionStyle !== 'function') {
        throw new Error('Script-mode execution only supports executionStyle="function".');
      }
      const runner = buildScriptTracingRunner(instrumentedCode);
      output = await Promise.resolve(
        runner(consoleProxy, traceRecorder, { functionName: traceFunctionName })
      );
    }

    const serializedOutput = serializeValue(output);
    if (!hasNamedFunction) {
      traceRecorder.popToFunction(traceFunctionName);
      traceRecorder.recordReturn(traceLineBounds.endLine, serializedOutput, traceFunctionName);
    }

    const executionTimeMs = performanceNow() - startedAt;
    return {
      success: true,
      output: serializedOutput,
      trace: traceRecorder.getTrace(),
      executionTimeMs,
      consoleOutput,
      lineEventCount: traceRecorder.getLineEventCount(),
      traceStepCount: traceRecorder.getTraceStepCount(),
      traceLimitExceeded: traceRecorder.isTraceLimitExceeded(),
      timeoutReason: traceRecorder.getTimeoutReason(),
    };
  } catch (error) {
    const executionTimeMs = performanceNow() - startedAt;
    const message = formatRuntimeErrorMessage(error);
    const errorLine = extractUserErrorLine(error);
    const traceErrorLine =
      error && typeof error === 'object' && '__traceLine' in error
        ? Number(error.__traceLine)
        : errorLine ?? traceLineBounds.endLine;
    const traceLimitExceeded =
      (error && typeof error === 'object' && error.__traceLimitExceeded === true) ||
      traceRecorder.isTraceLimitExceeded();
    const timeoutReason =
      (error && typeof error === 'object' && typeof error.__timeoutReason === 'string'
        ? error.__timeoutReason
        : traceRecorder.getTimeoutReason()) ?? undefined;

    if (!traceLimitExceeded) {
      traceRecorder.popToFunction(traceFunctionName);
      traceRecorder.recordException(traceErrorLine, message, traceFunctionName);
    }

    return {
      success: false,
      output: null,
      error: message,
      errorLine,
      trace: traceRecorder.getTrace(),
      executionTimeMs,
      consoleOutput,
      lineEventCount: traceRecorder.getLineEventCount(),
      traceStepCount: traceRecorder.getTraceStepCount(),
      traceLimitExceeded,
      timeoutReason,
    };
  }
}

async function executeCodeInterview(payload) {
  const guardedOptions = {
    ...INTERVIEW_GUARD_DEFAULTS,
    ...(payload?.options && typeof payload.options === 'object' ? payload.options : {}),
  };

  const tracedResult = await executeWithTracing({
    ...payload,
    options: guardedOptions,
  });

  if (!tracedResult.success) {
    const normalized = String(tracedResult.error ?? '').toLowerCase();
    const timeoutReason = tracedResult.timeoutReason ?? '';
    const timeoutIndicators = [
      'trace-limit',
      'line-limit',
      'single-line-limit',
      'recursion-limit',
    ];
    const isGuardTimeout =
      timeoutIndicators.includes(timeoutReason) ||
      normalized.includes('timed out') ||
      normalized.includes('infinite loop') ||
      normalized.includes('line events') ||
      normalized.includes('trace steps') ||
      normalized.includes('call depth');

    if (isGuardTimeout) {
      return {
        success: false,
        output: null,
        error: 'Time Limit Exceeded',
        consoleOutput: tracedResult.consoleOutput ?? [],
      };
    }

    return {
      success: false,
      output: null,
      error: tracedResult.error,
      errorLine: tracedResult.errorLine,
      consoleOutput: tracedResult.consoleOutput ?? [],
    };
  }

  return {
    success: true,
    output: tracedResult.output,
    consoleOutput: tracedResult.consoleOutput ?? [],
  };
}

async function initRuntime() {
  if (isInitialized) {
    return { success: true, loadTimeMs: 0 };
  }

  isLoading = true;
  const startedAt = performanceNow();
  isInitialized = true;
  isLoading = false;
  return { success: true, loadTimeMs: performanceNow() - startedAt };
}

async function processMessage(data) {
  const { id, type, payload } = data;

  try {
    switch (type) {
      case 'init': {
        const result = await initRuntime();
        self.postMessage({ id, type: 'init-result', payload: result });
        break;
      }

      case 'execute-with-tracing': {
        const result = await executeWithTracing(payload);
        self.postMessage({ id, type: 'execute-result', payload: result });
        break;
      }

      case 'execute-code': {
        const result = await executeCode(payload);
        self.postMessage({ id, type: 'execute-result', payload: result });
        break;
      }

      case 'execute-code-interview': {
        const result = await executeCodeInterview(payload);
        self.postMessage({ id, type: 'execute-result', payload: result });
        break;
      }

      case 'status': {
        self.postMessage({
          id,
          type: 'status-result',
          payload: {
            isReady: isInitialized,
            isLoading,
          },
        });
        break;
      }

      default: {
        self.postMessage({
          id,
          type: 'error',
          payload: { error: `Unknown message type: ${type}` },
        });
      }
    }
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

let messageQueue = Promise.resolve();

self.onmessage = function(event) {
  const messageData = event.data;
  messageQueue = messageQueue
    .then(() => processMessage(messageData))
    .catch((error) => {
      const { id } = messageData;
      self.postMessage({
        id,
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    });
};

if (WORKER_DEBUG) {
  console.log('[JavaScriptWorker] ready');
}
self.postMessage({ type: 'worker-ready' });
