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

function emitRuntimeDiagnostic(level, phase, message, detail) {
  if (!WORKER_DEBUG && level !== 'error') return;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  console[method]('[TraceRuntime]', {
    schema: 'tracecode.runtime-diagnostic.v1',
    source: 'harness',
    component: 'JavaScriptWorker',
    runtime: 'javascript',
    phase,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

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
  './vendor/typescript.js',
  'https://cdn.jsdelivr.net/npm/typescript@5.9.2/lib/typescript.js',
  'https://unpkg.com/typescript@5.9.2/lib/typescript.js',
];
const JAVASCRIPT_LIBRARY_URLS = [
  './vendor/javascript-libraries.js',
];
let javascriptLibrariesLoadAttempted = false;

const JAVASCRIPT_RUNTIME_PRELUDE = `
if (typeof globalThis.module === 'undefined') {
  globalThis.module = { exports: {} };
}
if (typeof globalThis.exports === 'undefined') {
  globalThis.exports = globalThis.module.exports || {};
}
if (typeof globalThis.ListNode !== 'function') {
  globalThis.ListNode = class ListNode {
    constructor(val = 0, next = null) {
      this.val = val;
      this.value = val;
      this.next = next;
    }
  };
}
if (typeof globalThis.TreeNode !== 'function') {
  globalThis.TreeNode = class TreeNode {
    constructor(val = 0, left = null, right = null) {
      this.val = val;
      this.value = val;
      this.left = left;
      this.right = right;
    }
  };
}
`;

function ensureJavaScriptLibraries() {
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.__TRACECODE_JAVASCRIPT_LIBRARIES__ &&
    typeof globalThis.require === 'function'
  ) {
    return;
  }
  if (javascriptLibrariesLoadAttempted) return;
  javascriptLibrariesLoadAttempted = true;
  if (typeof importScripts !== 'function') return;

  const errors = [];
  for (const libraryUrl of JAVASCRIPT_LIBRARY_URLS) {
    try {
      importScripts(libraryUrl);
      if (
        typeof globalThis !== 'undefined' &&
        globalThis.__TRACECODE_JAVASCRIPT_LIBRARIES__ &&
        typeof globalThis.require === 'function'
      ) {
        return;
      }
      errors.push(`${libraryUrl} (loaded but module registry was missing)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${libraryUrl} (${message})`);
    }
  }

  if (errors.length > 0) {
    emitRuntimeDiagnostic('warn', 'library-preload-skipped', 'JavaScript library preload skipped.', { errors });
  }
}

const TYPESCRIPT_RUNTIME_DECLARATIONS = `
declare class ListNode {
  val: any;
  value: any;
  next: ListNode | SerializedListNode | SerializedRef | null;
  prev?: ListNode | SerializedListNode | SerializedRef | null;
  constructor(val?: any, next?: ListNode | null);
}

declare class TreeNode {
  val: any;
  value: any;
  left: TreeNode | SerializedTreeNode | SerializedRef | null;
  right: TreeNode | SerializedTreeNode | SerializedRef | null;
  constructor(val?: any, left?: TreeNode | null, right?: TreeNode | null);
}

type SerializedRef = { __ref__: string };

type SerializedListNode = {
  __id__?: string;
  __type__?: 'ListNode';
  val?: any;
  value?: any;
  next?: SerializedListNode | SerializedRef | ListNode | null;
  prev?: SerializedListNode | SerializedRef | ListNode | null;
};

type SerializedTreeNode = {
  __id__?: string;
  __type__?: 'TreeNode';
  val?: any;
  value?: any;
  left?: SerializedTreeNode | SerializedRef | TreeNode | null;
  right?: SerializedTreeNode | SerializedRef | TreeNode | null;
};
`;

const CUSTOM_OBJECT_MATERIALIZER_SOURCE = `
function __tracecodeMaterializeCustomObject(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => __tracecodeMaterializeCustomObject(item));
  if (typeof value !== 'object') return value;
  if (value.__type__ === 'TreeNode' || value.__type__ === 'ListNode' || value.__ref__) return value;
  const __typeName = typeof value.__type__ === 'string'
    ? value.__type__
    : (typeof value.__class__ === 'string' ? value.__class__ : null);
  if (!__typeName) return value;
  const __fields = { __type__: __typeName };
  if (typeof value.__class__ === 'string') __fields.__class__ = value.__class__;
  for (const [__key, __child] of Object.entries(value)) {
    if (__key === '__type__' || __key === '__class__' || __key === '__id__') continue;
    __fields[__key] = __tracecodeMaterializeCustomObject(__child);
  }
  let __ctor;
  try {
    __ctor = eval(__typeName);
  } catch (_err) {
    __ctor = undefined;
  }
  if (typeof __ctor !== 'function') return __fields;
  const __args = Object.entries(__fields)
    .filter(([__key]) => __key !== '__type__' && __key !== '__class__')
    .map(([, __value]) => __value);
  try {
    return new __ctor(...__args);
  } catch (_err) {
    const __instance = Object.create(__ctor.prototype);
    Object.assign(__instance, __fields);
    return __instance;
  }
}
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
  if (value.__type__ === 'TreeNode') return true;
  return value?.constructor?.name === 'TreeNode';
}

function isLikelyListNodeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.__type__ === 'ListNode') return true;
  return value?.constructor?.name === 'ListNode';
}

function getCustomClassName(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value instanceof Map || value instanceof Set) return null;
  if (isLikelyTreeNodeValue(value) || isLikelyListNodeValue(value)) return null;
  const name = typeof value?.constructor?.name === 'string' ? value.constructor.name : '';
  if (!name || name === 'Object' || name === 'Array' || name === 'Map' || name === 'Set') {
    return null;
  }
  return name;
}

const RUNTIME_VALUE_MAX_DEPTH = 48;
const RUNTIME_VALUE_MAX_ITEMS = 64;
const RUNTIME_VALUE_MAX_OBJECT_FIELDS = 32;
const TRACE_SERIALIZATION_LIMITS = { maxItems: RUNTIME_VALUE_MAX_ITEMS, maxFields: RUNTIME_VALUE_MAX_OBJECT_FIELDS };
const OUTPUT_SERIALIZATION_LIMITS = { maxItems: Number.POSITIVE_INFINITY, maxFields: Number.POSITIVE_INFINITY };
let activeSerializationLimits = TRACE_SERIALIZATION_LIMITS;

function truncationMarker(total, emitted) {
  return { __truncated__: true, remaining: Math.max(0, total - emitted) };
}

function limitedEntries(items, maxItems) {
  return {
    values: items.slice(0, maxItems),
    remaining: Math.max(0, items.length - maxItems),
  };
}

function serializeValue(
  value,
  depth = 0,
  seen = new WeakSet(),
  nodeRefState = { ids: new Map(), nextId: 1 }
) {
  if (depth > RUNTIME_VALUE_MAX_DEPTH) return '<max depth>';
  if (value === null || value === undefined) return value;

  const valueType = typeof value;
  if (valueType === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return value;
  }
  if (valueType === 'string' || valueType === 'boolean') {
    return value;
  }
  if (valueType === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  }
  if (valueType === 'function') {
    return '<function>';
  }
  if (Array.isArray(value)) {
    const limited = limitedEntries(value, activeSerializationLimits.maxItems);
    const result = limited.values.map((item) => serializeValue(item, depth + 1, seen, nodeRefState));
    if (limited.remaining > 0) result.push(truncationMarker(value.length, limited.values.length));
    return result;
  }
  if (value instanceof Set) {
    const items = [...value];
    const limited = limitedEntries(items, activeSerializationLimits.maxItems);
    const result = {
      __type__: 'set',
      values: limited.values.map((item) => serializeValue(item, depth + 1, seen, nodeRefState)),
    };
    if (limited.remaining > 0) {
      result.__truncated__ = true;
      result.remaining = limited.remaining;
    }
    return result;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()];
    const limited = limitedEntries(entries, activeSerializationLimits.maxItems);
    const result = {
      __type__: 'map',
      entries: limited.values.map(([k, v]) => [
        serializeValue(k, depth + 1, seen, nodeRefState),
        serializeValue(v, depth + 1, seen, nodeRefState),
      ]),
    };
    if (limited.remaining > 0) {
      result.__truncated__ = true;
      result.remaining = limited.remaining;
    }
    return result;
  }
  if (valueType === 'object') {
    if (isLikelyTreeNodeValue(value) || isLikelyListNodeValue(value)) {
      const existingId = nodeRefState.ids.get(value);
      if (existingId) {
        return { __ref__: existingId };
      }
      const isTree = isLikelyTreeNodeValue(value);
      const nodeId = `ref-${nodeRefState.nextId++}`;
      nodeRefState.ids.set(value, nodeId);

      const out =
        isTree
          ? {
              __type__: 'TreeNode',
              __id__: nodeId,
              val: serializeValue(value.val ?? value.value ?? null, depth + 1, seen, nodeRefState),
              left: serializeValue(value.left ?? null, depth + 1, seen, nodeRefState),
              right: serializeValue(value.right ?? null, depth + 1, seen, nodeRefState),
            }
          : {
              __type__: 'ListNode',
              __id__: nodeId,
              val: serializeValue(value.val ?? value.value ?? null, depth + 1, seen, nodeRefState),
              next: serializeValue(value.next ?? null, depth + 1, seen, nodeRefState),
              ...(Object.prototype.hasOwnProperty.call(value, 'prev')
                ? { prev: serializeValue(value.prev ?? null, depth + 1, seen, nodeRefState) }
                : {}),
            };
      const skipped =
        isTree
          ? new Set(['__id__', '__type__', '__class__', 'val', 'value', 'left', 'right'])
          : new Set(['__id__', '__type__', '__class__', 'val', 'value', 'next', 'prev']);
      const fields = Object.entries(value).filter(([k]) => !skipped.has(k));
      for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {
        out[k] = serializeValue(v, depth + 1, seen, nodeRefState);
      }
      if (fields.length > activeSerializationLimits.maxFields) {
        out.__truncated__ = true;
        out.remaining = fields.length - activeSerializationLimits.maxFields;
      }
      return out;
    }

    const customClassName = getCustomClassName(value);
    if (customClassName) {
      const existingId = nodeRefState.ids.get(value);
      if (existingId) {
        return { __ref__: existingId };
      }

      const objectId = `ref-${nodeRefState.nextId++}`;
      nodeRefState.ids.set(value, objectId);

      if (seen.has(value)) return { __ref__: objectId };
      seen.add(value);
      const out = {
        __type__: customClassName,
        __class__: customClassName,
        __id__: objectId,
      };
      const fields = Object.entries(value);
      for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {
        out[k] = serializeValue(v, depth + 1, seen, nodeRefState);
      }
      if (fields.length > activeSerializationLimits.maxFields) {
        out.__truncated__ = true;
        out.remaining = fields.length - activeSerializationLimits.maxFields;
      }
      seen.delete(value);
      return out;
    }

    if (seen.has(value)) return '<cycle>';
    seen.add(value);
    const out = {};
    const fields = Object.entries(value);
    for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {
      out[k] = serializeValue(v, depth + 1, seen, nodeRefState);
    }
    if (fields.length > activeSerializationLimits.maxFields) {
      out.__truncated__ = true;
      out.remaining = fields.length - activeSerializationLimits.maxFields;
    }
    seen.delete(value);
    return out;
  }

  return String(value);
}

function withSerializationLimits(limits, serialize) {
  const previous = activeSerializationLimits;
  activeSerializationLimits = limits;
  try {
    return serialize();
  } finally {
    activeSerializationLimits = previous;
  }
}

function serializeOutputValue(value) {
  return withSerializationLimits(OUTPUT_SERIALIZATION_LIMITS, () => serializeValue(value));
}

function serializeTopLevelValue(value, nodeRefState) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return serializeValue(value, 0, new WeakSet(), nodeRefState);
  }

  if (isLikelyTreeNodeValue(value) || isLikelyListNodeValue(value)) {
    const objectValue = value;
    const nodeValue = value;
    const isTree = isLikelyTreeNodeValue(value);
    let nodeId = nodeRefState.ids.get(objectValue);
    if (!nodeId) {
      nodeId = `ref-${nodeRefState.nextId++}`;
      nodeRefState.ids.set(objectValue, nodeId);
    }

    const out =
      isTree
        ? {
            __type__: 'TreeNode',
            __id__: nodeId,
            val: serializeValue(nodeValue.val ?? nodeValue.value ?? null, 1, new WeakSet(), nodeRefState),
            left: serializeValue(nodeValue.left ?? null, 1, new WeakSet(), nodeRefState),
            right: serializeValue(nodeValue.right ?? null, 1, new WeakSet(), nodeRefState),
          }
        : {
            __type__: 'ListNode',
            __id__: nodeId,
            val: serializeValue(nodeValue.val ?? nodeValue.value ?? null, 1, new WeakSet(), nodeRefState),
            next: serializeValue(nodeValue.next ?? null, 1, new WeakSet(), nodeRefState),
            ...('prev' in nodeValue
              ? { prev: serializeValue(nodeValue.prev ?? null, 1, new WeakSet(), nodeRefState) }
              : {}),
          };
    const skipped = isTree
      ? new Set(['__id__', '__type__', '__class__', 'val', 'value', 'left', 'right'])
      : new Set(['__id__', '__type__', '__class__', 'val', 'value', 'next', 'prev']);
    const fields = Object.entries(nodeValue).filter(([k]) => !skipped.has(k));
    for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {
      out[k] = serializeValue(v, 1, new WeakSet(), nodeRefState);
    }
    if (fields.length > activeSerializationLimits.maxFields) {
      out.__truncated__ = true;
      out.remaining = fields.length - activeSerializationLimits.maxFields;
    }
    return out;
  }

  const customClassName = getCustomClassName(value);
  if (customClassName) {
    const objectValue = value;
    let objectId = nodeRefState.ids.get(objectValue);
    if (!objectId) {
      objectId = `ref-${nodeRefState.nextId++}`;
      nodeRefState.ids.set(objectValue, objectId);
    }
    const seen = new WeakSet();
    seen.add(objectValue);
    const out = {
      __type__: 'object',
      __class__: customClassName,
      __id__: objectId,
    };
    const fields = Object.entries(value);
    for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {
      out[k] = serializeValue(v, 1, seen, nodeRefState);
    }
    if (fields.length > activeSerializationLimits.maxFields) {
      out.__truncated__ = true;
      out.remaining = fields.length - activeSerializationLimits.maxFields;
    }
    return out;
  }

  return serializeValue(value, 0, new WeakSet(), nodeRefState);
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

function cloneInputGraph(value, cloned = new WeakMap()) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (cloned.has(value)) {
    return cloned.get(value);
  }

  if (Array.isArray(value)) {
    const out = [];
    cloned.set(value, out);
    for (const item of value) {
      out.push(cloneInputGraph(item, cloned));
    }
    return out;
  }

  if (!isPlainObjectRecord(value)) {
    return value;
  }

  const out = {};
  cloned.set(value, out);
  for (const [key, nested] of Object.entries(value)) {
    out[key] = cloneInputGraph(nested, cloned);
  }
  return out;
}

function normalizeInputs(inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {};
  const byId = new Map();
  collectReferenceTargets(inputs, byId, new WeakSet());
  if (byId.size === 0) {
    return cloneInputGraph(inputs);
  }
  const hydrated = resolveReferenceGraph(inputs, byId, new WeakMap());
  if (!hydrated || typeof hydrated !== 'object' || Array.isArray(hydrated)) {
    return cloneInputGraph(inputs);
  }
  return hydrated;
}

function buildTreeNodeFromLevelOrder(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const firstValue = values[0];
  if (firstValue === null || firstValue === undefined) return null;
  const root = { val: firstValue, value: firstValue, left: null, right: null };
  const queue = [root];
  let index = 1;

  while (queue.length > 0 && index < values.length) {
    const node = queue.shift();
    if (!node) break;

    const leftValue = values[index++];
    if (leftValue !== null && leftValue !== undefined) {
      node.left = { val: leftValue, value: leftValue, left: null, right: null };
      queue.push(node.left);
    }

    if (index >= values.length) break;

    const rightValue = values[index++];
    if (rightValue !== null && rightValue !== undefined) {
      node.right = { val: rightValue, value: rightValue, left: null, right: null };
      queue.push(node.right);
    }
  }

  return root;
}

function materializeTreeInput(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return buildTreeNodeFromLevelOrder(value);
  }
  if (!isPlainObjectRecord(value)) {
    return value;
  }
  if (isLikelyTreeNodeValue(value) || value.__type__ === 'TreeNode') {
    const nodeValue = value;
    const node = {
      val: nodeValue.val ?? nodeValue.value ?? null,
      value: nodeValue.val ?? nodeValue.value ?? null,
      left: materializeTreeInput(nodeValue.left ?? null),
      right: materializeTreeInput(nodeValue.right ?? null),
    };
    for (const [key, nested] of Object.entries(value)) {
      if (key === '__id__' || key === '__type__' || key === '__class__' || key === 'val' || key === 'value' || key === 'left' || key === 'right') continue;
      node[key] = materializeTreeInput(nested);
    }
    return node;
  }
  return value;
}

function materializeListInput(value, refs = new Map(), materialized = new WeakMap()) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const head = { val: value[0], value: value[0], next: null };
    let current = head;
    for (let i = 1; i < value.length; i++) {
      current.next = { val: value[i], value: value[i], next: null };
      current = current.next;
    }
    return head;
  }
  if (!isPlainObjectRecord(value)) {
    return value;
  }
  if (typeof value.__ref__ === 'string') {
    return refs.get(value.__ref__) ?? null;
  }
  if (isLikelyListNodeValue(value) || value.__type__ === 'ListNode') {
    const existingMaterialized = materialized.get(value);
    if (existingMaterialized) {
      return existingMaterialized;
    }
    const node = {
      val: value.val ?? value.value ?? null,
      value: value.val ?? value.value ?? null,
      next: null,
    };
    materialized.set(value, node);
    if (typeof value.__id__ === 'string' && value.__id__.length > 0) {
      refs.set(value.__id__, node);
    }
    node.next = materializeListInput(value.next ?? null, refs, materialized);
    for (const [key, nested] of Object.entries(value)) {
      if (key === '__id__' || key === '__type__' || key === '__class__' || key === 'val' || key === 'value' || key === 'next') continue;
      node[key] = materializeListInput(nested, refs, materialized);
    }
    return node;
  }
  return value;
}

function detectMaterializerKind(ts, typeNode) {
  if (!typeNode) return null;
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return detectMaterializerKind(ts, typeNode.type);
  }
  if (ts.isUnionTypeNode(typeNode)) {
    for (const child of typeNode.types) {
      const resolved = detectMaterializerKind(ts, child);
      if (resolved) return resolved;
    }
    return null;
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeNameText = typeNode.typeName.getText();
    if (typeNameText === 'TreeNode') return 'tree';
    if (typeNameText === 'ListNode') return 'list';
    return null;
  }
  return null;
}

function collectInputMaterializers(ts, functionLikeNode) {
  const out = {};
  for (const parameter of functionLikeNode.parameters ?? []) {
    if (!ts.isIdentifier(parameter.name)) continue;
    if (parameter.name.text === 'this') continue;
    const kind = detectMaterializerKind(ts, parameter.type);
    if (kind) {
      out[parameter.name.text] = kind;
    }
  }
  return out;
}

async function resolveInputMaterializers(code, functionName, executionStyle, language) {
  if (!functionName || executionStyle === 'ops-class' || language !== 'typescript') {
    return {};
  }

  try {
    await ensureTypeScriptCompiler();
    const ts = getTypeScriptCompiler();
    if (!ts) return {};

    const sourceFile = ts.createSourceFile(
      'runtime-input.ts',
      code,
      ts.ScriptTarget.ES2020,
      true,
      ts.ScriptKind.TS
    );
    const target = findFunctionLikeNode(ts, sourceFile, functionName, executionStyle);
    if (!target) return {};
    return collectInputMaterializers(ts, target);
  } catch (_error) {
    return {};
  }
}

function applyInputMaterializers(inputs, materializers) {
  const next = { ...inputs };
  const combined = { ...inferFallbackInputMaterializers(inputs), ...(materializers ?? {}) };
  if (Object.keys(combined).length === 0) return inputs;
  for (const [name, kind] of Object.entries(combined)) {
    if (!Object.prototype.hasOwnProperty.call(next, name)) continue;
    next[name] = kind === 'tree' ? materializeTreeInput(next[name]) : materializeListInput(next[name]);
  }
  return next;
}

function inferFallbackInputMaterializers(inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {};
  const inferred = {};
  const LINKED_LIST_FALLBACK_NAMES = new Set(['head', 'l1', 'l2', 'list1', 'list2', 'node']);
  for (const [name, value] of Object.entries(inputs)) {
    const lowerName = String(name || '').toLowerCase();
    if (!Array.isArray(value)) continue;
    if (lowerName === 'root' || lowerName.endsWith('root') || lowerName.includes('tree')) {
      inferred[name] = 'tree';
      continue;
    }
    if (lowerName === 'head' || lowerName.endsWith('head') || LINKED_LIST_FALLBACK_NAMES.has(lowerName)) {
      inferred[name] = 'list';
      continue;
    }
  }
  return inferred;
}

function collectSimpleParameterNames(ts, functionLikeNode) {
  const names = [];

  for (const parameter of functionLikeNode.parameters ?? []) {
    if (!ts.isIdentifier(parameter.name)) {
      return null;
    }
    if (parameter.name.text === 'this') {
      continue;
    }
    names.push(parameter.name.text);
  }

  return names;
}

function getPropertyNameText(ts, name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function findFunctionLikeNode(ts, sourceFile, functionName, executionStyle) {
  let found = null;

  const visit = (node) => {
    if (found) return;

    if (executionStyle === 'solution-method' && ts.isClassDeclaration(node) && node.name?.text === 'Solution') {
      for (const member of node.members) {
        if (found) break;

        if (ts.isMethodDeclaration(member) && getPropertyNameText(ts, member.name) === functionName) {
          found = member;
          break;
        }

        if (
          ts.isPropertyDeclaration(member) &&
          getPropertyNameText(ts, member.name) === functionName &&
          member.initializer &&
          (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
        ) {
          found = member.initializer;
          break;
        }
      }
      return;
    }

    if (executionStyle === 'function') {
      if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
        found = node;
        return;
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === functionName &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        found = node.initializer;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripJavaScriptTriviaForSignatureScan(code) {
  let output = '';
  let i = 0;

  while (i < code.length) {
    const current = code[i];
    const next = code[i + 1];

    if (current === '/' && next === '/') {
      output += '  ';
      i += 2;
      while (i < code.length && code[i] !== '\n') {
        output += ' ';
        i += 1;
      }
      continue;
    }

    if (current === '/' && next === '*') {
      output += '  ';
      i += 2;
      while (i < code.length) {
        if (code[i] === '*' && code[i + 1] === '/') {
          output += '  ';
          i += 2;
          break;
        }
        output += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    if (current === '"' || current === "'" || current === '`') {
      const quote = current;
      output += quote;
      i += 1;
      while (i < code.length) {
        const char = code[i];
        if (char === '\\') {
          output += ' ';
          if (i + 1 < code.length) output += code[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        output += char === '\n' ? '\n' : ' ';
        i += 1;
        if (char === quote) break;
      }
      continue;
    }

    output += current;
    i += 1;
  }

  return output;
}

function findMatchingBraceIndex(code, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < code.length; i += 1) {
    const char = code[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractClassBodyForSignatureScan(code, className) {
  const classMatch = new RegExp(`\\bclass\\s+${escapeRegExp(className)}\\b[^{}]*\\{`, 'm').exec(code);
  if (!classMatch) return null;
  const openBraceIndex = classMatch.index + classMatch[0].lastIndexOf('{');
  const closeBraceIndex = findMatchingBraceIndex(code, openBraceIndex);
  if (closeBraceIndex < 0) return null;
  return code.slice(openBraceIndex + 1, closeBraceIndex);
}

function parseSimpleJavaScriptParameterNames(parameterText) {
  const names = [];
  const rawParameters = String(parameterText ?? '').split(',');

  for (const rawParameter of rawParameters) {
    const trimmed = rawParameter.trim();
    if (!trimmed) continue;
    const withoutDefault = trimmed.split('=')[0].trim();
    const name = withoutDefault.startsWith('...') ? withoutDefault.slice(3).trim() : withoutDefault;
    if (name === 'this') continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      return null;
    }
    names.push(name);
  }

  return names;
}

function extractSimpleJavaScriptParameterNames(code, functionName, executionStyle) {
  const strippedCode = stripJavaScriptTriviaForSignatureScan(code);
  const escapedName = escapeRegExp(functionName);
  const exportPrefix = String.raw`(?:export\s+default\s+|export\s+)?`;
  const functionPatterns = [
    new RegExp(String.raw`(?:^|[^\w$])${exportPrefix}(?:async\s+)?function\s+${escapedName}\s*\(([^)]*)\)`, 'm'),
    new RegExp(String.raw`(?:^|[^\w$])${exportPrefix}(?:const|let|var)\s+${escapedName}\s*=\s*(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)`, 'm'),
    new RegExp(String.raw`(?:^|[^\w$])${exportPrefix}(?:const|let|var)\s+${escapedName}\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>`, 'm'),
    new RegExp(String.raw`(?:^|[^\w$])${exportPrefix}(?:const|let|var)\s+${escapedName}\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>`, 'm'),
  ];
  const methodBody =
    executionStyle === 'solution-method'
      ? extractClassBodyForSignatureScan(strippedCode, 'Solution') ?? strippedCode
      : strippedCode;
  const methodPatterns = [
    new RegExp(String.raw`(?:^|[;{}\s])(?:async\s+)?${escapedName}\s*\(([^)]*)\)\s*\{`, 'm'),
    new RegExp(String.raw`(?:^|[;{}\s])${escapedName}\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>`, 'm'),
    new RegExp(String.raw`(?:^|[;{}\s])${escapedName}\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>`, 'm'),
    new RegExp(String.raw`(?:^|[;{}\s])${escapedName}\s*=\s*(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)`, 'm'),
  ];
  const patterns = executionStyle === 'solution-method' ? methodPatterns : functionPatterns;
  const scanCode = executionStyle === 'solution-method' ? methodBody : strippedCode;

  for (const pattern of patterns) {
    const match = pattern.exec(scanCode);
    if (!match) continue;
    return parseSimpleJavaScriptParameterNames(match[1] ?? '');
  }

  return null;
}

function orderInputKeysByParameterNames(parameterNames, inputs, fallbackKeys) {
  if (!parameterNames || parameterNames.length === 0) {
    return fallbackKeys;
  }

  const matchedKeys = parameterNames.filter((name) => Object.prototype.hasOwnProperty.call(inputs, name));
  if (matchedKeys.length === 0) {
    return fallbackKeys;
  }

  const extras = fallbackKeys.filter((key) => !matchedKeys.includes(key));
  return [...matchedKeys, ...extras];
}

async function resolveOrderedInputKeys(code, functionName, inputs, executionStyle, language = 'javascript') {
  const fallbackKeys = Object.keys(inputs ?? {});
  if (!functionName || executionStyle === 'ops-class' || fallbackKeys.length <= 1) {
    return fallbackKeys;
  }

  if (language !== 'typescript') {
    const parameterNames = extractSimpleJavaScriptParameterNames(code, functionName, executionStyle);
    return orderInputKeysByParameterNames(parameterNames, inputs, fallbackKeys);
  }

  try {
    await ensureTypeScriptCompiler();
    const ts = getTypeScriptCompiler();
    if (!ts) {
      return fallbackKeys;
    }

    const sourceFile = ts.createSourceFile(
      `runtime-input.${language === 'typescript' ? 'ts' : 'js'}`,
      code,
      ts.ScriptTarget.ES2020,
      true,
      language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS
    );
    const target = findFunctionLikeNode(ts, sourceFile, functionName, executionStyle);
    if (!target) {
      return fallbackKeys;
    }

    const parameterNames = collectSimpleParameterNames(ts, target);
    return orderInputKeysByParameterNames(parameterNames, inputs, fallbackKeys);
  } catch (_error) {
    return fallbackKeys;
  }
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

function isTraceablePathSegment(value) {
  return (typeof value === 'number' && Number.isInteger(value)) ||
    (typeof value === 'string' && value.length > 0);
}

function normalizeTraceIndices(indices, maxDepth = 2) {
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > maxDepth) {
    return null;
  }
  if (!indices.every(isTraceablePathSegment)) {
    return null;
  }
  return indices.map((index) => typeof index === 'number' ? Math.trunc(index) : index);
}

function normalizeTraceIndexSources(indexSources, maxDepth = 2) {
  if (!Array.isArray(indexSources) || indexSources.length === 0 || indexSources.length > maxDepth) {
    return null;
  }
  return indexSources.map((source) => typeof source === 'string' && source.length > 0 ? source : null);
}

function isTraceableMutatingMethod(methodName) {
  return ['push', 'pop', 'shift', 'unshift', 'splice', 'set', 'get', 'has', 'add', 'delete', 'clear'].includes(methodName);
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
  const runtimeTraceEvents = [];
  const callStack = [];
  const pendingAccessesByFrame = new Map();
  const deferredAccessesByFrame = new Map();
  const runtimeTraceAccessStatsByVariable = new Map();
  const lineHitCount = new Map();
  const stableNodeRefState = { ids: new Map(), nextId: 1 };
  const maxTraceSteps = getNumericOption(options.maxTraceSteps, 4000);
  const maxStoredEvents = getNumericOption(options.maxStoredEvents, maxTraceSteps);
  const effectiveMaxTraceSteps = Math.min(maxTraceSteps, maxStoredEvents);
  const effectiveMaxRuntimeTraceEvents = maxStoredEvents;
  const maxLineEvents = getNumericOption(options.maxLineEvents, 12000);
  const maxSingleLineHits = getNumericOption(options.maxSingleLineHits, 1000);
  const maxCallDepth = getNumericOption(options.maxCallDepth, 2000);

  let lineEventCount = 0;
  let traceLimitExceeded = false;
  let timeoutReason;
  let timeoutRecorded = false;
  let nextFrameId = 1;

  function markTraceCaptureLimit(lineNumber, functionName) {
    if (!traceLimitExceeded) {
      traceLimitExceeded = true;
      timeoutReason = 'trace-limit';
    }
    pendingAccessesByFrame.clear();
    deferredAccessesByFrame.clear();
    if (!timeoutRecorded && trace.length < effectiveMaxTraceSteps && runtimeTraceEvents.length < effectiveMaxRuntimeTraceEvents) {
      const timeoutStep = {
        line: normalizeLine(lineNumber, 1),
        event: 'timeout',
        variables: { timeoutReason: 'trace-limit' },
        function: functionName ?? callStack[callStack.length - 1]?.function ?? '<module>',
        callStack: snapshotCallStack(),
      };
      timeoutRecorded = true;
      trace.push(timeoutStep);
      appendRuntimeTraceEventsForStep(timeoutStep);
    }
  }

  function normalizeLine(lineNumber, fallback = 1) {
    const parsed = Number(lineNumber);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }

  function snapshotCallStack() {
    return callStack.map((frame) => ({
      id: frame.id,
      function: frame.function,
      args: frame.args,
      line: frame.line,
    }));
  }

  function sanitizeVariables(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    for (const [key, variableValue] of Object.entries(value)) {
      if (variableValue === undefined) continue;
      if (typeof variableValue === 'function') continue;
      try {
        result[key] = serializeTopLevelValue(variableValue, stableNodeRefState);
      } catch {
        // Skip variables that throw during serialization (e.g. transient proxy/getter failures).
      }
    }
    return result;
  }

  function sanitizeCallArgs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    for (const [key, variableValue] of Object.entries(value)) {
      if (typeof variableValue === 'function') continue;
      if (variableValue === undefined) {
        result[key] = '<undefined>';
        continue;
      }
      try {
        result[key] = serializeTopLevelValue(variableValue, stableNodeRefState);
      } catch {
        result[key] = '<unserializable>';
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

  function normalizeFrameMatchKey(functionName) {
    const normalized =
      typeof functionName === 'string' && functionName.length > 0 ? functionName : '<module>';
    if (normalized === 'constructor' || normalized.endsWith('.constructor')) {
      return 'constructor';
    }
    return normalized;
  }

  function flushPendingAccesses(frameId) {
    if (frameId === undefined || frameId === null) {
      return undefined;
    }
    const pending = pendingAccessesByFrame.get(frameId);
    const deferred = deferredAccessesByFrame.get(frameId);
    let deferredReady = [];
    if (deferred && Array.isArray(deferred.accesses) && deferred.accesses.length > 0) {
      if (deferred.skipLineFlushes > 0) {
        deferred.skipLineFlushes -= 1;
        deferredAccessesByFrame.set(frameId, deferred);
      } else {
        deferredReady = deferred.accesses;
        deferredAccessesByFrame.delete(frameId);
      }
    }
    if ((!Array.isArray(pending) || pending.length === 0) && deferredReady.length === 0) {
      return undefined;
    }
    pendingAccessesByFrame.delete(frameId);
    return [...(Array.isArray(pending) ? pending : []), ...deferredReady].map((access) => ({
      variable: access.variable,
      kind: access.kind,
      ...(Array.isArray(access.indices) && access.indices.length > 0
        ? { indices: access.indices }
        : {}),
      ...(Array.isArray(access.indexSources) && access.indexSources.length > 0
        ? { indexSources: access.indexSources }
        : {}),
      ...(access.method ? { method: access.method } : {}),
      ...(Array.isArray(access.args) ? { args: access.args } : {}),
      ...(access.pathDepth ? { pathDepth: access.pathDepth } : {}),
      ...(access.scope ? { scope: access.scope } : {}),
      ...(access.binding ? { binding: access.binding } : {}),
      ...(Number.isFinite(access.line) && access.line > 0 ? { line: access.line } : {}),
      ...(Number.isFinite(access.column) && access.column >= 0 ? { column: access.column } : {}),
      ...(Object.prototype.hasOwnProperty.call(access, 'value') ? { value: access.value } : {}),
    }));
  }

  function appendTrace(step, frameId = getCurrentFrameId()) {
    if (traceLimitExceeded) {
      return;
    }
    if (trace.length >= effectiveMaxTraceSteps) {
      markTraceCaptureLimit(step?.line, step?.function);
      return;
    }
    const accesses = flushPendingAccesses(frameId);
    const nextStep = {
      ...step,
      ...(accesses ? { accesses } : {}),
    };
    const previous = trace[trace.length - 1];
    if (canMergeConsecutiveLineSteps(previous, nextStep)) {
      previous.variables = {
        ...(previous.variables || {}),
        ...(nextStep.variables || {}),
      };
      if (nextStep.accesses?.length) {
        previous.accesses = [...(previous.accesses || []), ...nextStep.accesses];
      }
      previous.callStack = nextStep.callStack;
      previous.function = nextStep.function;
      appendRuntimeTraceEventsForStep({
        ...nextStep,
        event: '__merge_only__',
      });
      return;
    }
    trace.push(nextStep);
    appendRuntimeTraceEventsForStep(nextStep);
  }

  function runtimeTraceFrameIdForStep(step) {
    const stack = Array.isArray(step?.callStack) ? step.callStack : [];
    if (stack.length > 0) {
      const frame = stack[stack.length - 1];
      return `${frame.function}:${frame.line}:${frame.id ?? 'unknown'}`;
    }
    return `${step.function}:${step.line}:root`;
  }

  function runtimeTraceTargetForAccess(access) {
    const indices = Array.isArray(access?.indices) ? access.indices : [];
    const indexSources = Array.isArray(access?.indexSources) ? access.indexSources : [];
    const scope = typeof access?.scope === 'string' && access.scope.length > 0
      ? access.scope
      : undefined;
    const base = {
      variable: access.variable,
      ...(scope ? { scope } : {}),
    };
    if (indices.length > 0) {
      return {
        ...base,
        path: indices,
        ...(indexSources.length > 0 ? { indexSources } : {}),
      };
    }
    return base;
  }

  function runtimeTraceKindForAccess(access) {
    if (access.kind === 'indexed-read' || access.kind === 'cell-read') return 'read';
    if (access.kind === 'indexed-write' || access.kind === 'cell-write') return 'write';
    return 'mutate';
  }

  function runtimeTraceAccessValue(step, access) {
    if (access && Object.prototype.hasOwnProperty.call(access, 'value')) return access.value;
    return valueAtPath(step?.variables?.[access.variable], access.indices);
  }

  function traceStepFrameId(step) {
    const stack = Array.isArray(step?.callStack) ? step.callStack : [];
    return stack.length > 0 ? stack[stack.length - 1]?.id : undefined;
  }

  function updateRuntimeTraceAccessStats(access) {
    const variable = access?.variable;
    if (typeof variable !== 'string' || variable.length === 0) return;
    const stats = runtimeTraceAccessStatsByVariable.get(variable) ?? {
      hasCellRead: false,
      hasCellWrite: false,
      hasMutatingCall: false,
      hasNestedMutatingCall: false,
      hasIndexedWrite: false,
    };
    if (access.kind === 'cell-read') stats.hasCellRead = true;
    if (access.kind === 'cell-write') stats.hasCellWrite = true;
    if (access.kind === 'mutating-call') stats.hasMutatingCall = true;
    if (access.kind === 'mutating-call' && (access.pathDepth ?? 0) > 0) stats.hasNestedMutatingCall = true;
    if (access.kind === 'indexed-write') stats.hasIndexedWrite = true;
    runtimeTraceAccessStatsByVariable.set(variable, stats);
  }

  function appendRuntimeTraceEventsForStep(step) {
    if (traceLimitExceeded && timeoutReason === 'trace-limit' && step?.event !== 'timeout') {
      return;
    }
    const base = {
      runId: 'javascript:run',
      line: step.line,
      frameId: runtimeTraceFrameIdForStep(step),
    };
    const pushRuntimeTraceEvent = (event) => {
      if (runtimeTraceEvents.length >= effectiveMaxRuntimeTraceEvents) {
        markTraceCaptureLimit(step?.line, step?.function);
        return false;
      }
      runtimeTraceEvents.push(event);
      return true;
    };

    if (step.event === 'line') {
      pushRuntimeTraceEvent({ ...base, kind: 'line', function: step.function });
    } else if (step.event === 'call') {
      const stack = Array.isArray(step.callStack) ? step.callStack : [];
      pushRuntimeTraceEvent({ ...base, kind: 'call', function: step.function, args: stack.at(-1)?.args });
    } else if (step.event === 'return') {
      pushRuntimeTraceEvent({
        ...base,
        kind: 'return',
        function: step.function,
        ...(step.returnValue !== undefined ? { value: step.returnValue } : {}),
      });
    } else if (step.event === 'exception') {
      pushRuntimeTraceEvent({ ...base, kind: 'exception', message: String(step.returnValue ?? 'Runtime exception') });
    } else if (step.event === 'timeout') {
      pushRuntimeTraceEvent({ ...base, kind: 'timeout', message: 'Runtime timeout' });
    } else if (step.event === 'stdout') {
      pushRuntimeTraceEvent({
        kind: 'stdout',
        runId: 'javascript:run',
        ...(step.line ? { line: step.line } : {}),
        text: String(step.returnValue ?? ''),
      });
    }

    if (step.event !== '__merge_only__') {
      for (const [variable, value] of Object.entries(step.variables ?? {})) {
        if (!pushRuntimeTraceEvent({ ...base, kind: 'snapshot', target: { variable }, value })) return;
      }
    } else {
      for (const [variable, value] of Object.entries(step.variables ?? {})) {
        if (!pushRuntimeTraceEvent({ ...base, kind: 'snapshot', target: { variable }, value })) return;
      }
    }

    for (const access of step.accesses ?? []) {
      updateRuntimeTraceAccessStats(access);
      const kind = runtimeTraceKindForAccess(access);
      const target = runtimeTraceTargetForAccess(access);
      const accessBase = {
        ...base,
        ...(Number.isFinite(access.line) && access.line > 0 ? { line: access.line } : {}),
        ...(Number.isFinite(access.column) && access.column >= 0 ? { column: access.column } : {}),
      };
      if (kind === 'mutate') {
        const event = {
          ...accessBase,
          kind,
          target,
          ...(access.method ? { method: access.method } : {}),
          ...(Array.isArray(access.args) ? { args: access.args } : {}),
        };
        if (!pushRuntimeTraceEvent(event)) return;
      } else {
        const event = {
          ...accessBase,
          kind,
          target,
          value: runtimeTraceAccessValue(step, access),
          ...(access.binding ? { binding: access.binding } : {}),
        };
        if (!pushRuntimeTraceEvent(event)) return;
      }
    }
  }

  function canMergeConsecutiveLineSteps(previous, nextStep) {
    if (!previous || !nextStep) return false;
    if (previous.event !== 'line' || nextStep.event !== 'line') return false;
    if (previous.line !== nextStep.line) return false;
    if (previous.function !== nextStep.function) return false;
    if ((previous.accesses?.length ?? 0) > 0 || (nextStep.accesses?.length ?? 0) > 0) return false;
    return sameCallStackVisit(previous.callStack, nextStep.callStack);
  }

  function sameCallStackVisit(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const leftFrame = left[index];
      const rightFrame = right[index];
      if (!leftFrame || !rightFrame) return false;
      if (leftFrame.function !== rightFrame.function) return false;
      if (leftFrame.line !== rightFrame.line) return false;
    }
    return true;
  }

  function markTimeout(reason, lineNumber, message) {
    const normalizedLine = normalizeLine(lineNumber, 1);
    if (!traceLimitExceeded) {
      traceLimitExceeded = true;
      timeoutReason = reason;
    }
    if (!timeoutRecorded && trace.length < effectiveMaxTraceSteps) {
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

    const normalizedMatchKey = normalizeFrameMatchKey(normalizedFunctionName);
    let matchingFrameIndex = -1;
    for (let index = callStack.length - 1; index >= 0; index -= 1) {
      const frame = callStack[index];
      if (!frame) continue;
      if (
        frame.function === normalizedFunctionName ||
        normalizeFrameMatchKey(frame.function) === normalizedMatchKey
      ) {
        matchingFrameIndex = index;
        break;
      }
    }

    if (matchingFrameIndex >= 0) {
      while (callStack.length - 1 > matchingFrameIndex) {
        const frame = callStack.pop();
        if (frame?.id !== undefined) {
          pendingAccessesByFrame.delete(frame.id);
          deferredAccessesByFrame.delete(frame.id);
        }
      }
    }

    const topFrame = callStack[callStack.length - 1];
    if (topFrame && normalizeFrameMatchKey(topFrame.function) === normalizedMatchKey) {
      if (
        normalizedMatchKey === 'constructor' &&
        topFrame.function !== normalizedFunctionName &&
        normalizedFunctionName.endsWith('.constructor')
      ) {
        topFrame.function = normalizedFunctionName;
      }
      if (
        Object.keys(topFrame.args ?? {}).length === 0 &&
        inferredArgs &&
        typeof inferredArgs === 'object'
      ) {
        topFrame.args = sanitizeVariables(inferredArgs);
      }
      return normalizedFunctionName;
    }

    if (!topFrame) {
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
      });
      return normalizedFunctionName;
    }

    return normalizedFunctionName;
  }

  return {
    serialize(value) {
      return serializeValue(value, 0, new WeakSet(), stableNodeRefState);
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
      if (callStack.length + 1 > maxCallDepth) {
        markTimeout(
          'recursion-limit',
          normalizedLine,
          `Exceeded max call depth (${maxCallDepth})`
        );
      }
      if (traceLimitExceeded) {
        return;
      }
      this.attachPendingAccessesToPreviousLine();
      const normalizedArgs = sanitizeCallArgs(args);
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
      });
    },
    recordAccess(event) {
      if (traceLimitExceeded) {
        return;
      }
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
          ? { indices: normalizeTraceIndices(event.indices) ?? undefined }
          : {}),
        ...(Array.isArray(event.indexSources) && event.indexSources.length > 0
          ? { indexSources: normalizeTraceIndexSources(event.indexSources) ?? undefined }
          : {}),
        ...(typeof event.method === 'string' && event.method.length > 0
          ? { method: event.method }
          : {}),
        ...(Array.isArray(event.args)
          ? { args: event.args.map((arg) => this.serialize(arg)) }
          : {}),
        ...(event.pathDepth === 1 || event.pathDepth === 2 || event.pathDepth === 3 ? { pathDepth: event.pathDepth } : {}),
        ...(typeof event.scope === 'string' && event.scope.length > 0
          ? { scope: event.scope }
          : {}),
        ...(event.binding &&
        typeof event.binding === 'object' &&
        typeof event.binding.variable === 'string' &&
        event.binding.variable.length > 0
          ? {
              binding: {
                ...(event.binding.kind === 'iteration' ? { kind: 'iteration' } : {}),
                variable: event.binding.variable,
              },
            }
          : {}),
        ...(Number.isFinite(event.line) && event.line > 0
          ? { line: Math.trunc(event.line) }
          : {}),
        ...(Number.isFinite(event.column) && event.column >= 0
          ? { column: Math.trunc(event.column) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(event, 'value')
          ? { value: this.serialize(event.value) }
          : {}),
      };

      const existing = pendingAccessesByFrame.get(frameId) ?? [];
      existing.push(normalized);
      pendingAccessesByFrame.set(frameId, existing);
    },
    deferPendingAccesses(lineFlushes = 1) {
      if (traceLimitExceeded) {
        return;
      }
      const frameId = getCurrentFrameId();
      if (frameId === undefined) {
        return;
      }
      const pending = pendingAccessesByFrame.get(frameId);
      if (!Array.isArray(pending) || pending.length === 0) {
        return;
      }
      pendingAccessesByFrame.delete(frameId);
      const existing = deferredAccessesByFrame.get(frameId);
      deferredAccessesByFrame.set(frameId, {
        accesses: [...(Array.isArray(existing?.accesses) ? existing.accesses : []), ...pending],
        skipLineFlushes: Math.max(
          typeof existing?.skipLineFlushes === 'number' ? existing.skipLineFlushes : 0,
          Math.max(0, Math.trunc(lineFlushes))
        ),
      });
    },
    attachPendingAccessesToPreviousLine() {
      if (traceLimitExceeded) {
        return;
      }
      const frameId = getCurrentFrameId();
      if (frameId === undefined) {
        return;
      }
      const pending = pendingAccessesByFrame.get(frameId);
      if (!Array.isArray(pending) || pending.length === 0) {
        return;
      }
      const attachable = pending;
      pendingAccessesByFrame.delete(frameId);
      if (attachable.length === 0) {
        return;
      }
      for (let index = trace.length - 1; index >= 0; index -= 1) {
        const step = trace[index];
        if (!step || step.event !== 'line') continue;
        if (traceStepFrameId(step) !== frameId) continue;
        step.accesses = [...(step.accesses ?? []), ...attachable];
        appendRuntimeTraceEventsForStep({
          ...step,
          event: '__access_only__',
          accesses: attachable,
        });
        return;
      }
      pendingAccessesByFrame.set(frameId, attachable);
    },
    traceCondition(value) {
      this.attachPendingAccessesToPreviousLine();
      return value;
    },
    tracePostLineCondition(evaluate) {
      if (typeof evaluate !== 'function') {
        return evaluate;
      }
      return evaluate();
    },
    line(lineNumber, snapshotFactory, functionNameOverride, functionStartLine) {
      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);

      if (traceLimitExceeded) {
        return;
      }

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
      if (typeof snapshotFactory === 'function') {
        try {
          const snapshot = snapshotFactory();
          variables = sanitizeVariables(snapshot);
        } catch {
          variables = {};
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
      });
    },
    recordReturn(lineNumber, returnValue, functionNameOverride) {
      if (traceLimitExceeded) {
        return;
      }
      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);
      const functionName =
        typeof functionNameOverride === 'string' && functionNameOverride.length > 0
          ? functionNameOverride
          : callStack[callStack.length - 1]?.function ?? '<module>';
      const serializedReturnValue = serializeValue(returnValue);
      const variables = functionName === '<module>' ? { result: serializedReturnValue } : {};

      appendTrace({
        line: normalizedLine,
        event: 'return',
        variables,
        function: functionName,
        callStack: snapshotCallStack(),
        returnValue: serializedReturnValue,
      });
    },
    recordException(lineNumber, error, functionNameOverride) {
      if (traceLimitExceeded) {
        return;
      }
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
    recordStdout(lineNumber, text) {
      if (traceLimitExceeded) {
        return;
      }
      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);
      appendTrace({
        line: normalizedLine,
        event: 'stdout',
        variables: {},
        function: callStack[callStack.length - 1]?.function ?? '<module>',
        callStack: snapshotCallStack(),
        stdoutLineCount: 1,
        returnValue: String(text ?? ''),
      });
    },
    popCall() {
      if (callStack.length > 0) {
        const frame = callStack.pop();
        if (frame?.id !== undefined) {
          pendingAccessesByFrame.delete(frame.id);
          deferredAccessesByFrame.delete(frame.id);
        }
      }
    },
    popToFunction(functionName) {
      const target = typeof functionName === 'string' && functionName.length > 0 ? functionName : '<module>';
      while (callStack.length > 1 && callStack[callStack.length - 1]?.function !== target) {
        const frame = callStack.pop();
        if (frame?.id !== undefined) {
          pendingAccessesByFrame.delete(frame.id);
          deferredAccessesByFrame.delete(frame.id);
        }
      }
    },
    getTrace() {
      return trace;
    },
    getRuntimeTrace(language, runId = `${language}:run`, file) {
      const events = runtimeTraceEvents.map((event) => ({
        ...event,
        runId,
        ...(file ? { file } : {}),
      }));
      return {
        schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
        language,
        runId,
        events,
        lineEventCount: events.filter((event) => event.kind === 'line').length,
        traceStepCount: events.length,
      };
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

function createEmptyRuntimeTrace(language, runId = `${language}:run`) {
  return {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language,
    runId,
    events: [],
    lineEventCount: 0,
    traceStepCount: 0,
  };
}

function defaultRuntimeTraceFile(language) {
  return language === 'typescript' ? 'solution.ts' : 'solution.js';
}

function createSyntheticRuntimeTrace(payload, codeResult, language) {
  const syntheticTrace = createSyntheticTrace(payload, codeResult);
  const runId = `${language}:run`;
  const file = defaultRuntimeTraceFile(language);
  const events = [];
  for (const step of syntheticTrace) {
    const base = {
      runId,
      file,
      line: step.line,
      frameId: runtimeTraceFrameIdForSyntheticStep(step),
    };
    if (step.event === 'call') {
      events.push({ ...base, kind: 'call', function: step.function, args: step.callStack?.at(-1)?.args });
    } else if (step.event === 'line') {
      events.push({ ...base, kind: 'line', function: step.function });
    } else if (step.event === 'return') {
      events.push({ ...base, kind: 'return', function: step.function, value: step.returnValue });
    }
    for (const [variable, value] of Object.entries(step.variables ?? {})) {
      events.push({ ...base, kind: 'snapshot', target: { variable }, value });
    }
  }
  return {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language,
    runId,
    events,
    lineEventCount: events.filter((event) => event.kind === 'line').length,
    traceStepCount: events.length,
  };
}

const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';

function runtimeTraceFrameIdForSyntheticStep(step) {
  const stack = Array.isArray(step?.callStack) ? step.callStack : [];
  if (stack.length > 0) {
    const frame = stack[stack.length - 1];
    return `${frame.function}:${frame.line}`;
  }
  return `${step.function}:${step.line}`;
}

function valueAtPath(value, path) {
  if (!Array.isArray(path) || path.length === 0) return value;
  let current = value;
  for (const part of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[String(part)];
  }
  return current;
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
  ensureJavaScriptLibraries();
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

function collectBindingNames(ts, nameNode) {
  const names = new Set();
  addBindingNames(ts, nameNode, names);
  return [...names];
}

function addAssignmentTargetNames(ts, node, names) {
  if (!node) return;
  if (ts.isParenthesizedExpression(node)) {
    addAssignmentTargetNames(ts, node.expression, names);
    return;
  }
  if (ts.isIdentifier(node)) {
    if (!node.text.startsWith('__trace')) names.add(node.text);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        addAssignmentTargetNames(ts, element.expression, names);
      } else {
        addAssignmentTargetNames(ts, element, names);
      }
    }
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        addAssignmentTargetNames(ts, property.name, names);
      } else if (ts.isPropertyAssignment(property)) {
        addAssignmentTargetNames(ts, property.initializer, names);
      } else if (ts.isSpreadAssignment(property)) {
        addAssignmentTargetNames(ts, property.expression, names);
      }
    }
  }
}

function collectAssignmentTargetNames(ts, node) {
  const names = new Set();
  addAssignmentTargetNames(ts, node, names);
  return [...names];
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
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      addAssignmentTargetNames(ts, node.left, names);
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
    ts.isWhileStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isEmptyStatement(statement) ||
    ts.isBlock(statement)
  );
}

function shouldMapStatementLineForFunctionContext(ts, statement) {
  return (
    shouldTraceStatement(ts, statement) ||
    ts.isWhileStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isForOfStatement(statement)
  );
}

function isSingleLineNode(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  return start === end;
}

function statementBypassesFollowingTraceLine(ts, statement) {
  if (
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement) ||
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement)
  ) {
    return true;
  }
  if (ts.isBlock(statement)) {
    return statement.statements.some((nested) => statementBypassesFollowingTraceLine(ts, nested));
  }
  return false;
}

function shouldTraceIfStatementPostLine(ts, sourceFile, statement) {
  if (!isSingleLineNode(sourceFile, statement)) {
    return false;
  }
  if (statementBypassesFollowingTraceLine(ts, statement.thenStatement)) {
    return false;
  }
  if (statement.elseStatement && statementBypassesFollowingTraceLine(ts, statement.elseStatement)) {
    return false;
  }
  return true;
}

function isPostLineStateStatement(ts, sourceFile, statement) {
  if (ts.isVariableStatement(statement)) {
    return true;
  }
  if (ts.isIfStatement(statement) && shouldTraceIfStatementPostLine(ts, sourceFile, statement)) {
    return true;
  }
  if (!ts.isExpressionStatement(statement)) {
    return false;
  }
  const expression = statement.expression;
  if (
    (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) &&
    ts.isIdentifier(expression.operand) &&
    (expression.operator === ts.SyntaxKind.PlusPlusToken ||
      expression.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (
    ts.isBinaryExpression(expression) &&
    isAssignmentOperatorToken(ts, expression.operatorToken.kind) &&
    ts.isIdentifier(expression.left)
  ) {
    return true;
  }
  if (isTraceStateMutationHelperCall(ts, expression)) {
    return true;
  }
  return false;
}

function isTraceStateMutationHelperCall(ts, expression) {
  let current = unwrapParenthesizedExpression(ts, expression);
  if (!current || !ts.isCallExpression(current) || !ts.isIdentifier(current.expression)) {
    return false;
  }
  return [
    '__traceMutatingCall',
    '__traceWriteIndex',
    '__traceAugAssignIndex',
    '__traceUpdateIndex',
    '__traceUpdateScalar',
  ].includes(current.expression.text);
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
    const originalNode = ts.getOriginalNode(node);
    const classLikeParent =
      node.parent && ts.isClassLike(node.parent)
        ? node.parent
        : originalNode?.parent && ts.isClassLike(originalNode.parent)
          ? originalNode.parent
          : null;
    const className =
      classLikeParent && classLikeParent.name && ts.isIdentifier(classLikeParent.name)
        ? classLikeParent.name.text
        : null;
    return className ? `${className}.constructor` : 'constructor';
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const originalNode = ts.getOriginalNode(node);
    const parent = node.parent ?? originalNode?.parent;
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

  function mapStatementLine(statementNode, functionName, functionStartLine, includeThisSnapshot) {
    const lineNumber = sourceFile.getLineAndCharacterOfPosition(statementNode.getStart(sourceFile)).line + 1;
    if (!lineFunctionMap.has(lineNumber)) {
      lineFunctionMap.set(lineNumber, {
        functionName,
        functionStartLine,
        includeThisSnapshot,
      });
    }
  }

  function visitNode(node, currentFunctionName, currentFunctionStartLine, includeThisSnapshot) {
    const nextFunctionName = ts.isFunctionLike(node)
      ? inferTraceFunctionName(ts, node, currentFunctionName)
      : currentFunctionName;
    const nextFunctionStartLine = ts.isFunctionLike(node)
      ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      : currentFunctionStartLine;
    const nextIncludeThisSnapshot = ts.isFunctionLike(node)
      ? functionLikeSnapshotsReceiver(ts, node)
      : includeThisSnapshot;

    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      for (const statement of node.statements) {
        visitNode(statement, currentFunctionName, currentFunctionStartLine, includeThisSnapshot);
      }
      return;
    }

    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (const statement of node.statements) {
        visitNode(statement, currentFunctionName, currentFunctionStartLine, includeThisSnapshot);
      }
      return;
    }

    if (ts.isFunctionLike(node)) {
      if (node.body) {
        visitNode(node.body, nextFunctionName, nextFunctionStartLine, nextIncludeThisSnapshot);
      }
      return;
    }

    if (ts.isStatement(node) && shouldMapStatementLineForFunctionContext(ts, node)) {
      mapStatementLine(node, currentFunctionName, currentFunctionStartLine, includeThisSnapshot);
    }

    ts.forEachChild(node, (child) => visitNode(child, currentFunctionName, currentFunctionStartLine, includeThisSnapshot));
  }

  visitNode(sourceFile, defaultFunctionName, 1, false);
  return lineFunctionMap;
}

function unwrapParenthesizedExpression(ts, node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      (typeof ts.isAsExpression === 'function' && ts.isAsExpression(current)) ||
      (typeof ts.isTypeAssertionExpression === 'function' && ts.isTypeAssertionExpression(current)) ||
      (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current)) ||
      (typeof ts.isNonNullExpression === 'function' && ts.isNonNullExpression(current)))
  ) {
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

function isTraceablePropertyWriteLeftOperand(ts, node) {
  const parent = node?.parent;
  return Boolean(
    parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
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

  while (current && indices.length < 3) {
    if (ts.isElementAccessExpression(current)) {
      indices.unshift(current.argumentExpression);
      current = unwrapParenthesizedExpression(ts, current.expression);
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      indices.unshift(ts.factory.createStringLiteral(current.name.text));
      current = unwrapParenthesizedExpression(ts, current.expression);
      continue;
    }
    break;
  }

  if (!current || indices.length === 0 || indices.length > 2) {
    return null;
  }
  if (ts.isThis(current)) {
    return {
      variableName: 'this',
      receiverExpression: ts.factory.createThis(),
      indices,
    };
  }
  if (!ts.isIdentifier(current)) {
    return null;
  }

  return {
    variableName: current.text,
    receiverExpression: ts.factory.createIdentifier(current.text),
    indices,
  };
}

function extractTraceablePropertyAccess(ts, node) {
  const current = unwrapParenthesizedExpression(ts, node);
  if (!current || !ts.isPropertyAccessExpression(current)) {
    return null;
  }
  const receiver = unwrapParenthesizedExpression(ts, current.expression);
  if (!receiver) {
    return null;
  }
  if (ts.isThis(receiver)) {
    return {
      variableName: 'this',
      propertyName: current.name.text,
      scope: 'receiver',
    };
  }
  if (!ts.isIdentifier(receiver)) {
    return null;
  }
  return {
    variableName: receiver.text,
    propertyName: current.name.text,
  };
}

function runtimeScopeForTraceableReceiver(receiverName, localVariableNames) {
  if (receiverName === 'this') return 'receiver';
  return localVariableNames.has(receiverName) ? 'local' : 'global';
}

function extractTraceableMutatingCall(ts, node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }

  const receiver = unwrapParenthesizedExpression(ts, node.expression.expression);
  const methodName = node.expression.name.text;
  if (!receiver || !isTraceableMutatingMethod(methodName)) {
    return null;
  }

  if (ts.isIdentifier(receiver)) {
    return {
      variableName: receiver.text,
      receiverExpression: ts.factory.createIdentifier(receiver.text),
      methodName,
      indices: [],
    };
  }

  if (
    ts.isPropertyAccessExpression(receiver) &&
    ts.isThis(unwrapParenthesizedExpression(ts, receiver.expression))
  ) {
    return {
      variableName: 'this',
      receiverExpression: ts.factory.createThis(),
      methodName,
      indices: [ts.factory.createStringLiteral(receiver.name.text)],
    };
  }

  const indexedReceiver = extractTraceableElementAccess(ts, receiver);
  if (indexedReceiver) {
    return {
      variableName: indexedReceiver.variableName,
      receiverExpression: indexedReceiver.receiverExpression,
      methodName,
      indices: indexedReceiver.indices,
    };
  }

  if (
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === 'get' &&
    receiver.arguments.length === 1
  ) {
    const mapReceiver = unwrapParenthesizedExpression(ts, receiver.expression.expression);
    if (ts.isIdentifier(mapReceiver)) {
      return {
        variableName: mapReceiver.text,
        receiverExpression: ts.factory.createIdentifier(mapReceiver.text),
        methodName,
        indices: [receiver.arguments[0]],
      };
    }
    const tracedMapReceiver = extractTraceableElementAccess(ts, mapReceiver);
    if (tracedMapReceiver) {
      return {
        variableName: tracedMapReceiver.variableName,
        receiverExpression: tracedMapReceiver.receiverExpression,
        methodName,
        indices: [...tracedMapReceiver.indices, receiver.arguments[0]],
      };
    }
  }

  return null;
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

function createIndexSourcesArrayExpression(ts, sourceFile, indices) {
  return ts.factory.createArrayLiteralExpression(
    indices.map((index) => {
      const source = indexSourceExpressionText(ts, sourceFile, index);
      return source ? ts.factory.createStringLiteral(source) : ts.factory.createNull();
    }),
    false
  );
}

function indexSourceExpressionText(ts, sourceFile, index) {
  if (ts.isIdentifier(index)) return index.text;
  if (typeof index.pos === 'number' && index.pos < 0) return null;
  let text = '';
  try {
    text = typeof index.getText === 'function' ? index.getText(sourceFile).trim().replace(/\s+/g, ' ') : '';
  } catch {
    text = '';
  }
  if (!text) return null;
  return isSafeIndexSourceExpression(ts, index) ? text : null;
}

function isSafeIndexSourceExpression(ts, node) {
  const unwrapped = unwrapParenthesizedExpression(ts, node);
  if (!unwrapped) return false;
  if (ts.isIdentifier(unwrapped) || ts.isNumericLiteral(unwrapped) || ts.isStringLiteral(unwrapped)) {
    return true;
  }
  if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(unwrapped)) {
    if (
      (unwrapped.operator === ts.SyntaxKind.PlusPlusToken || unwrapped.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(unwrapped.operand)
    ) {
      return true;
    }
    return (
      (unwrapped.operator === ts.SyntaxKind.PlusToken || unwrapped.operator === ts.SyntaxKind.MinusToken) &&
      isSafeIndexSourceExpression(ts, unwrapped.operand)
    );
  }
  if (ts.isPostfixUnaryExpression(unwrapped)) {
    return (
      (unwrapped.operator === ts.SyntaxKind.PlusPlusToken || unwrapped.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(unwrapped.operand)
    );
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return isSafeIndexSourceExpression(ts, unwrapped.expression);
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    return (
      isSafeIndexSourceExpression(ts, unwrapped.expression) &&
      Boolean(unwrapped.argumentExpression) &&
      isSafeIndexSourceExpression(ts, unwrapped.argumentExpression)
    );
  }
  if (ts.isCallExpression(unwrapped)) {
    const expression = unwrapParenthesizedExpression(ts, unwrapped.expression);
    if (!expression || !ts.isPropertyAccessExpression(expression)) return false;
    const safeIndexMethods = new Set(['at', 'charAt', 'charCodeAt', 'codePointAt']);
    return (
      safeIndexMethods.has(expression.name.text) &&
      isSafeIndexSourceExpression(ts, expression.expression) &&
      unwrapped.arguments.every((argument) => isSafeIndexSourceExpression(ts, argument))
    );
  }
  if (ts.isBinaryExpression(unwrapped)) {
    const allowedOperators = new Set([
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
    ]);
    return (
      allowedOperators.has(unwrapped.operatorToken.kind) &&
      isSafeIndexSourceExpression(ts, unwrapped.left) &&
      isSafeIndexSourceExpression(ts, unwrapped.right)
    );
  }
  return false;
}

function createTraceReadIndexExpression(ts, sourceFile, node, variableName, indices, indexSourceExpressions = indices) {
  const receiverExpression = variableName === 'this'
    ? ts.factory.createThis()
    : ts.factory.createIdentifier(variableName);
  return createTraceReadIndexExpressionForReceiver(
    ts,
    sourceFile,
    node,
    variableName,
    receiverExpression,
    indices,
    indexSourceExpressions
  );
}

function createTraceReadIndexExpressionForReceiver(
  ts,
  sourceFile,
  node,
  variableName,
  receiverExpression,
  indices,
  indexSourceExpressions = indices
) {
  return ts.factory.createCallExpression(ts.factory.createIdentifier('__traceReadIndex'), undefined, [
    ts.factory.createStringLiteral(variableName),
    receiverExpression,
    createIndicesArrayExpression(ts, indices),
    createIndexSourcesArrayExpression(ts, sourceFile, indexSourceExpressions),
    createSourceLocationObject(ts, sourceFile, node),
  ]);
}

function createTraceWriteIndexExpression(ts, sourceFile, node, variableName, indices, value, indexSourceExpressions = indices) {
  const receiverExpression = variableName === 'this'
    ? ts.factory.createThis()
    : ts.factory.createIdentifier(variableName);
  return ts.factory.createCallExpression(ts.factory.createIdentifier('__traceWriteIndex'), undefined, [
    ts.factory.createStringLiteral(variableName),
    receiverExpression,
    createIndicesArrayExpression(ts, indices),
    createIndexSourcesArrayExpression(ts, sourceFile, indexSourceExpressions),
    value,
    createSourceLocationObject(ts, sourceFile, node),
  ]);
}

function createSourceLocationObject(ts, sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return ts.factory.createObjectLiteralExpression(
    [
      ts.factory.createPropertyAssignment('line', ts.factory.createNumericLiteral(position.line + 1)),
      ts.factory.createPropertyAssignment('column', ts.factory.createNumericLiteral(position.character + 1)),
    ],
    false
  );
}

function createTraceReadPropertyExpression(ts, sourceFile, node, variableName, propertyName, scope) {
  const receiverExpression = variableName === 'this'
    ? ts.factory.createThis()
    : ts.factory.createIdentifier(variableName);
  const args = [
    ts.factory.createStringLiteral(variableName),
    receiverExpression,
    ts.factory.createStringLiteral(propertyName),
  ];
  if (scope) {
    args.push(ts.factory.createStringLiteral(scope));
  }
  args.push(createSourceLocationObject(ts, sourceFile, node));
  return ts.factory.createCallExpression(ts.factory.createIdentifier('__traceReadProperty'), undefined, args);
}

function createTraceWritePropertyExpression(ts, sourceFile, node, variableName, propertyName, value) {
  const receiverExpression = variableName === 'this'
    ? ts.factory.createThis()
    : ts.factory.createIdentifier(variableName);
  return ts.factory.createCallExpression(ts.factory.createIdentifier('__traceWriteIndex'), undefined, [
    ts.factory.createStringLiteral(variableName),
    receiverExpression,
    createIndicesArrayExpression(ts, [ts.factory.createStringLiteral(propertyName)]),
    ts.factory.createArrayLiteralExpression([ts.factory.createNull()], false),
    value,
    createSourceLocationObject(ts, sourceFile, node),
  ]);
}

function createTraceScalarWriteExpression(ts, sourceFile, node, variableName, value) {
  return ts.factory.createCallExpression(ts.factory.createIdentifier('__traceAssignScalar'), undefined, [
    ts.factory.createStringLiteral(variableName),
    value,
    createSourceLocationObject(ts, sourceFile, node),
  ]);
}

function createTraceScalarUpdateExpression(ts, sourceFile, node, variableName, operatorName, isPrefix) {
  return ts.factory.createCallExpression(ts.factory.createIdentifier('__traceUpdateScalar'), undefined, [
    ts.factory.createStringLiteral(variableName),
    ts.factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      isPrefix
        ? ts.factory.createPrefixUnaryExpression(
            operatorName === 'inc' ? ts.SyntaxKind.PlusPlusToken : ts.SyntaxKind.MinusMinusToken,
            ts.factory.createIdentifier(variableName)
          )
        : ts.factory.createPostfixUnaryExpression(
            ts.factory.createIdentifier(variableName),
            operatorName === 'inc' ? ts.SyntaxKind.PlusPlusToken : ts.SyntaxKind.MinusMinusToken
          )
    ),
    ts.factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      ts.factory.createIdentifier(variableName)
    ),
    isPrefix ? ts.factory.createTrue() : ts.factory.createFalse(),
    createSourceLocationObject(ts, sourceFile, node),
  ]);
}

function createTraceScalarWriteStatement(ts, sourceFile, node, variableName) {
  return ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(ts.factory.createIdentifier('__traceScalarWrite'), undefined, [
      ts.factory.createStringLiteral(variableName),
      ts.factory.createIdentifier(variableName),
      createSourceLocationObject(ts, sourceFile, node),
    ])
  );
}

function traceScalarWriteStatementsForVariableStatement(ts, sourceFile, statement) {
  if (!ts.isVariableStatement(statement)) return [];
  const statements = [];
  for (const declaration of statement.declarationList.declarations) {
    if (!declaration.initializer) continue;
    if (
      ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer) ||
      ts.isClassExpression(declaration.initializer)
    ) {
      continue;
    }
    for (const variableName of collectBindingNames(ts, declaration.name)) {
      statements.push(createTraceScalarWriteStatement(ts, sourceFile, declaration.name, variableName));
    }
  }
  return statements;
}

function traceScalarWriteStatementsForDestructuringAssignmentStatement(ts, sourceFile, statement) {
  if (!ts.isExpressionStatement(statement)) return [];
  const expression = ts.isParenthesizedExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression;
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return [];
  }
  if (!ts.isArrayLiteralExpression(expression.left) && !ts.isObjectLiteralExpression(expression.left)) {
    return [];
  }
  return collectAssignmentTargetNames(ts, expression.left)
    .map((variableName) => createTraceScalarWriteStatement(ts, sourceFile, expression.left, variableName));
}

function createTraceAugAssignExpression(
  ts,
  sourceFile,
  node,
  variableName,
  indices,
  operatorName,
  rhs,
  indexSourceExpressions = indices
) {
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__traceAugAssignIndex'),
    undefined,
    [
      ts.factory.createStringLiteral(variableName),
      ts.factory.createIdentifier(variableName),
      createIndicesArrayExpression(ts, indices),
      createIndexSourcesArrayExpression(ts, sourceFile, indexSourceExpressions),
      ts.factory.createStringLiteral(operatorName),
      rhs,
      createSourceLocationObject(ts, sourceFile, node),
    ]
  );
}

function createTraceUpdateExpression(
  ts,
  sourceFile,
  node,
  variableName,
  indices,
  operatorName,
  isPrefix,
  indexSourceExpressions = indices
) {
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__traceUpdateIndex'),
    undefined,
    [
      ts.factory.createStringLiteral(variableName),
      ts.factory.createIdentifier(variableName),
      createIndicesArrayExpression(ts, indices),
      createIndexSourcesArrayExpression(ts, sourceFile, indexSourceExpressions),
      ts.factory.createStringLiteral(operatorName),
      isPrefix ? ts.factory.createTrue() : ts.factory.createFalse(),
      createSourceLocationObject(ts, sourceFile, node),
    ]
  );
}

function createTraceMutatingCallExpression(
  ts,
  sourceFile,
  node,
  variableName,
  methodName,
  args,
  indices = [],
  indexSourceExpressions = indices
) {
  const receiverExpression = variableName === 'this'
    ? ts.factory.createThis()
    : ts.factory.createIdentifier(variableName);
  return createTraceMutatingCallExpressionForReceiver(
    ts,
    sourceFile,
    node,
    variableName,
    receiverExpression,
    methodName,
    args,
    indices,
    indexSourceExpressions
  );
}

function createTraceMutatingCallExpressionForReceiver(
  ts,
  sourceFile,
  node,
  variableName,
  receiverExpression,
  methodName,
  args,
  indices = [],
  indexSourceExpressions = indices
) {
  const effectiveIndexSourceExpressions = ['set', 'get', 'has'].includes(methodName) && args.length > 0
    ? [...indexSourceExpressions, args[0]]
    : indexSourceExpressions;
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__traceMutatingCall'),
    undefined,
    [
      ts.factory.createStringLiteral(variableName),
      receiverExpression,
      createIndicesArrayExpression(ts, indices),
      createIndexSourcesArrayExpression(ts, sourceFile, effectiveIndexSourceExpressions),
      ts.factory.createStringLiteral(methodName),
      createSourceLocationObject(ts, sourceFile, node),
      ...args,
    ]
  );
}

function isConsoleLogCall(ts, node) {
  return Boolean(
    ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console' &&
      node.expression.name.text === 'log'
  );
}

function createTraceStdoutExpression(ts, sourceFile, node) {
  const lineNumber = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__traceStdout'),
    undefined,
    [
      ts.factory.createNumericLiteral(lineNumber),
      ...node.arguments,
    ]
  );
}

function createTraceThrowExpression(ts, sourceFile, node) {
  const lineNumber = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return ts.factory.updateThrowStatement(
    node,
    ts.factory.createCallExpression(
      ts.factory.createIdentifier('__traceExceptionValue'),
      undefined,
      [
        ts.factory.createNumericLiteral(lineNumber),
        node.expression ?? ts.factory.createIdentifier('undefined'),
      ]
    )
  );
}

function createSnapshotFactory(ts, variableNames, includeThis = false) {
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

  if (includeThis) {
    properties.push(
      ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral('this'),
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
              ts.factory.createThis()
            ),
          ]
        )
      )
    );
  }

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

function functionLikeSnapshotsReceiver(ts, functionLikeNode) {
  return (
    ts.isMethodDeclaration(functionLikeNode) ||
    ts.isConstructorDeclaration(functionLikeNode) ||
    ts.isGetAccessorDeclaration(functionLikeNode) ||
    ts.isSetAccessorDeclaration(functionLikeNode)
  );
}

function createTraceLineStatement(ts, sourceFile, statement, variableNames, lineFunctionMap, defaultFunctionName) {
  const lineNumber = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
  const functionContext = lineFunctionMap.get(lineNumber);
  const traceFunctionName = functionContext?.functionName ?? defaultFunctionName;
  const traceFunctionStartLine = functionContext?.functionStartLine ?? lineNumber;
  const includeThisSnapshot = Boolean(functionContext?.includeThisSnapshot);
  return ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier('__traceRecorder'),
        ts.factory.createIdentifier('line')
      ),
      undefined,
      [
        ts.factory.createNumericLiteral(lineNumber),
        createSnapshotFactory(ts, variableNames, includeThisSnapshot),
        ts.factory.createStringLiteral(traceFunctionName),
        ts.factory.createNumericLiteral(traceFunctionStartLine),
      ]
    )
  );
}

function createAttachPendingAccessesStatement(ts) {
  return ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier('__traceRecorder'),
        ts.factory.createIdentifier('attachPendingAccessesToPreviousLine')
      ),
      undefined,
      []
    )
  );
}

function ensureBlockStatement(ts, statement) {
  if (ts.isBlock(statement)) {
    return statement;
  }
  return ts.factory.createBlock([statement], true);
}

function wrapTraceCondition(ts, expression, deferAccessesToNextLine = false) {
  const recorderMethod = deferAccessesToNextLine ? 'tracePostLineCondition' : 'traceCondition';
  const argument = deferAccessesToNextLine
    ? ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        expression
      )
    : expression;
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier('__traceRecorder'),
      ts.factory.createIdentifier(recorderMethod)
    ),
    undefined,
    [argument]
  );
}

function rewriteWhileStatementForTracing(ts, sourceFile, whileStatement, variableNames, lineFunctionMap, defaultFunctionName) {
  const originalNode = ts.getOriginalNode(whileStatement) ?? whileStatement;
  const tracedLine = createTraceLineStatement(
    ts,
    sourceFile,
    originalNode,
    variableNames,
    lineFunctionMap,
    defaultFunctionName
  );
  const visitedBodyBlock = ensureBlockStatement(ts, whileStatement.statement);
  const guardedBreak = ts.factory.createIfStatement(
    ts.factory.createPrefixUnaryExpression(
      ts.SyntaxKind.ExclamationToken,
      wrapTraceCondition(ts, whileStatement.expression)
    ),
    ts.factory.createBreakStatement(),
    undefined
  );
  return ts.factory.createWhileStatement(
    ts.factory.createTrue(),
    ts.factory.createBlock(
      [
        tracedLine,
        guardedBreak,
        ...visitedBodyBlock.statements,
      ],
      true
    )
  );
}

function rewriteForStatementForTracing(ts, sourceFile, forStatement, variableNames, lineFunctionMap, defaultFunctionName) {
  const originalNode = ts.getOriginalNode(forStatement) ?? forStatement;
  const tracedLineCall = createTraceLineStatement(
    ts,
    sourceFile,
    originalNode,
    variableNames,
    lineFunctionMap,
    defaultFunctionName
  ).expression;
  const condition = forStatement.condition ?? ts.factory.createTrue();
  const tracedCondition = ts.factory.createParenthesizedExpression(
    ts.factory.createBinaryExpression(
      tracedLineCall,
      ts.SyntaxKind.CommaToken,
      wrapTraceCondition(ts, condition)
    )
  );
  const initializerWriteStatements = [];
  if (forStatement.initializer && ts.isVariableDeclarationList(forStatement.initializer)) {
    for (const declaration of forStatement.initializer.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      initializerWriteStatements.push(createTraceScalarWriteStatement(ts, sourceFile, originalNode, declaration.name.text));
    }
  }
  const rewrittenFor = ts.factory.updateForStatement(
    forStatement,
    initializerWriteStatements.length > 0 ? undefined : forStatement.initializer,
    tracedCondition,
    forStatement.incrementor,
    forStatement.statement
  );
  if (initializerWriteStatements.length === 0 || !forStatement.initializer || !ts.isVariableDeclarationList(forStatement.initializer)) {
    return rewrittenFor;
  }
  return ts.factory.createBlock(
    [
      ts.factory.createVariableStatement(undefined, forStatement.initializer),
      ...initializerWriteStatements,
      rewrittenFor,
    ],
    true
  );
}

function rewriteForOfStatementForTracing(ts, sourceFile, context, forOfStatement, variableNames, lineFunctionMap, defaultFunctionName) {
  const originalNode = ts.getOriginalNode(forOfStatement) ?? forOfStatement;
  const visitedBodyBlock = ensureBlockStatement(ts, forOfStatement.statement);
  const originalExpression = originalNode.expression ?? forOfStatement.expression;
  const indexedSource = extractTraceableElementAccess(ts, originalExpression);
  const sourceName = ts.isIdentifier(forOfStatement.expression) ? forOfStatement.expression.text : null;
  const bindingName =
    ts.isVariableDeclarationList(forOfStatement.initializer) &&
    forOfStatement.initializer.declarations.length === 1 &&
    collectBindingNames(ts, forOfStatement.initializer.declarations[0].name).length > 0
      ? collectBindingNames(ts, forOfStatement.initializer.declarations[0].name).join(',')
      : ts.isIdentifier(forOfStatement.initializer)
        ? forOfStatement.initializer.text
        : null;
  const lineNumber = sourceFile.getLineAndCharacterOfPosition(originalNode.getStart(sourceFile)).line + 1;
  const tracedExpression =
    indexedSource && bindingName
      ? ts.factory.createCallExpression(
          ts.factory.createIdentifier('__traceIterableBindIndexed'),
          undefined,
          [
            ts.factory.createStringLiteral(indexedSource.variableName),
            forOfStatement.expression,
            createIndicesArrayExpression(ts, indexedSource.indices),
            createIndexSourcesArrayExpression(ts, sourceFile, indexedSource.indices),
            ts.factory.createStringLiteral(bindingName),
            ts.factory.createObjectLiteralExpression([
              ts.factory.createPropertyAssignment('line', ts.factory.createNumericLiteral(lineNumber)),
            ]),
          ]
        )
      : sourceName && bindingName
      ? ts.factory.createCallExpression(
          ts.factory.createIdentifier('__traceIterableBind'),
          undefined,
          [
            ts.factory.createStringLiteral(sourceName),
            forOfStatement.expression,
            ts.factory.createStringLiteral(bindingName),
            ts.factory.createObjectLiteralExpression([
              ts.factory.createPropertyAssignment('line', ts.factory.createNumericLiteral(lineNumber)),
            ]),
          ]
        )
      : forOfStatement.expression;
  const createHeaderLine = () => createTraceLineStatement(
    ts,
    sourceFile,
    originalNode,
    variableNames,
    lineFunctionMap,
    defaultFunctionName
  );
  const bodyTracedLine = createHeaderLine();
  const rewriteContinueForHeader = (node) => {
    if (ts.isFunctionLike(node)) return node;
    if (
      node !== visitedBodyBlock &&
      (ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node))
    ) {
      return node;
    }
    if (ts.isContinueStatement(node) && !node.label) {
      return ts.factory.createBlock([createHeaderLine(), node], true);
    }
    return ts.visitEachChild(node, rewriteContinueForHeader, context);
  };
  const bodyStatements = visitedBodyBlock.statements.map((statement) => ts.visitNode(statement, rewriteContinueForHeader));
  const bodyBlock = ts.factory.updateBlock(visitedBodyBlock, [
    bodyTracedLine,
    ...bodyStatements,
  ]);

  return ts.factory.createBlock(
    [
      ts.factory.updateForOfStatement(
        forOfStatement,
        forOfStatement.awaitModifier,
        forOfStatement.initializer,
        tracedExpression,
        bodyBlock
      ),
      createHeaderLine(),
      createAttachPendingAccessesStatement(ts),
    ],
    true
  );
}

function instrumentStatementList(
  ts,
  sourceFile,
  originalStatements,
  visitedStatements,
  variableNames,
  lineFunctionMap,
  defaultFunctionName
) {
  const nextStatements = [];
  for (let index = 0; index < visitedStatements.length; index += 1) {
    const visitedStatement = visitedStatements[index];
    const originalStatement =
      originalStatements[index] ??
      ts.getOriginalNode(visitedStatement) ??
      visitedStatement;
    if (shouldTraceStatement(ts, visitedStatement)) {
      const tracedLineStatement = createTraceLineStatement(
        ts,
        sourceFile,
        originalStatement,
        variableNames,
        lineFunctionMap,
        defaultFunctionName
      );
      if (isPostLineStateStatement(ts, sourceFile, originalStatement)) {
        nextStatements.push(visitedStatement);
        nextStatements.push(...traceScalarWriteStatementsForVariableStatement(ts, sourceFile, originalStatement));
        nextStatements.push(tracedLineStatement);
        continue;
      }
      nextStatements.push(
        tracedLineStatement
      );
      nextStatements.push(visitedStatement);
      nextStatements.push(...traceScalarWriteStatementsForVariableStatement(ts, sourceFile, originalStatement));
      nextStatements.push(...traceScalarWriteStatementsForDestructuringAssignmentStatement(ts, sourceFile, originalStatement));
      nextStatements.push(createAttachPendingAccessesStatement(ts));
      continue;
    }
    nextStatements.push(visitedStatement);
  }
  return ts.factory.createNodeArray(nextStatements);
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
  const includeThisSnapshot = functionLikeSnapshotsReceiver(ts, functionLikeNode);

  const rewrittenBody = rewriteFunctionReturnStatements(
    ts,
    sourceFile,
    context,
    functionBody,
    traceFunctionName
  );

  const argsSnapshotExpression = ts.factory.createCallExpression(
    ts.factory.createParenthesizedExpression(createSnapshotFactory(ts, parameterNames, includeThisSnapshot)),
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
  const localVariableNames = new Set(variableNames);
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
            sourceFile,
            node,
            tracedOperand.variableName,
            visitedIndices,
            operatorName,
            ts.isPrefixUnaryExpression(node),
            tracedOperand.indices
          );
        }
        if (ts.isIdentifier(node.operand) && operatorName) {
          return createTraceScalarUpdateExpression(
            ts,
            sourceFile,
            node,
            node.operand.text,
            operatorName,
            ts.isPrefixUnaryExpression(node)
          );
        }
      }

      if (ts.isThrowStatement(node)) {
        return createTraceThrowExpression(ts, sourceFile, node);
      }

      if (ts.isBinaryExpression(node)) {
        const tracedLeft = extractTraceableElementAccess(ts, node.left);
        if (tracedLeft && isAssignmentOperatorToken(ts, node.operatorToken.kind)) {
          const visitedIndices = tracedLeft.indices.map((indexExpr) => ts.visitNode(indexExpr, visit));
          const visitedRight = ts.visitNode(node.right, visit);
          if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            return createTraceWriteIndexExpression(
              ts,
              sourceFile,
              node.left,
              tracedLeft.variableName,
              visitedIndices,
              visitedRight,
              tracedLeft.indices
            );
          }

          const operatorName = getCompoundAssignmentOperatorName(ts, node.operatorToken.kind);
          if (operatorName) {
            return createTraceAugAssignExpression(
              ts,
              sourceFile,
              node.left,
              tracedLeft.variableName,
              visitedIndices,
              operatorName,
              visitedRight,
              tracedLeft.indices
            );
          }
        }

        if (ts.isIdentifier(node.left) && isAssignmentOperatorToken(ts, node.operatorToken.kind)) {
          const visitedRight = ts.visitNode(node.right, visit);
          const rewrittenAssignment = ts.factory.updateBinaryExpression(
            node,
            node.left,
            node.operatorToken,
            visitedRight
          );
          return createTraceScalarWriteExpression(
            ts,
            sourceFile,
            node.left,
            node.left.text,
            rewrittenAssignment
          );
        }

        const tracedPropertyLeft = extractTraceablePropertyAccess(ts, node.left);
        if (tracedPropertyLeft && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const visitedRight = ts.visitNode(node.right, visit);
          return createTraceWritePropertyExpression(
            ts,
            sourceFile,
            node.left,
            tracedPropertyLeft.variableName,
            tracedPropertyLeft.propertyName,
            visitedRight
          );
        }
      }

      if (ts.isCallExpression(node)) {
        if (isConsoleLogCall(ts, node)) {
          return createTraceStdoutExpression(ts, sourceFile, node);
        }
        const tracedCall = extractTraceableMutatingCall(ts, node);
        if (tracedCall) {
          const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visit));
          return createTraceMutatingCallExpressionForReceiver(
            ts,
            sourceFile,
            node,
            tracedCall.variableName,
            tracedCall.receiverExpression,
            tracedCall.methodName,
            visitedArgs,
            tracedCall.indices?.map((indexExpr) => ts.visitNode(indexExpr, visit)) ?? [],
            tracedCall.indices ?? []
          );
        }
      }

      if (ts.isIfStatement(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        return ts.factory.updateIfStatement(
          visited,
          wrapTraceCondition(ts, visited.expression, shouldTraceIfStatementPostLine(ts, sourceFile, node)),
          visited.thenStatement,
          visited.elseStatement
        );
      }

      if (ts.isElementAccessExpression(node)) {
        const parent = node.parent;
        if (
          isNestedElementAccessExpression(ts, node) ||
          isAssignmentLikeLeftOperand(ts, node) ||
          isUpdateExpressionOperand(ts, node) ||
          isDestructuringAssignmentTarget(ts, node) ||
          (parent && ts.isCallExpression(parent) && parent.expression === node)
        ) {
          return ts.visitEachChild(node, visit, context);
        }

        const tracedAccess = extractTraceableElementAccess(ts, node);
        if (tracedAccess) {
          const visitedIndices = tracedAccess.indices.map((indexExpr) => ts.visitNode(indexExpr, visit));
          return createTraceReadIndexExpression(
            ts,
            sourceFile,
            node,
            tracedAccess.variableName,
            visitedIndices,
            tracedAccess.indices
          );
        }
      }

      if (ts.isPropertyAccessExpression(node)) {
        const parent = node.parent;
        const grandparent = parent?.parent;
        if (
          isTraceablePropertyWriteLeftOperand(ts, node) ||
          isDestructuringAssignmentTarget(ts, node) ||
          (parent && ts.isCallExpression(parent) && parent.expression === node) ||
          (parent &&
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node &&
            grandparent &&
            ts.isCallExpression(grandparent) &&
            grandparent.expression === parent)
        ) {
          return ts.visitEachChild(node, visit, context);
        }

        const tracedIndexedPropertyAccess = extractTraceableElementAccess(ts, node);
        if (tracedIndexedPropertyAccess && tracedIndexedPropertyAccess.indices.length > 1) {
          const visitedIndices = tracedIndexedPropertyAccess.indices.map((indexExpr) => ts.visitNode(indexExpr, visit));
          return createTraceReadIndexExpression(
            ts,
            sourceFile,
            node,
            tracedIndexedPropertyAccess.variableName,
            visitedIndices,
            tracedIndexedPropertyAccess.indices
          );
        }

        const tracedAccess = extractTraceablePropertyAccess(ts, node);
        if (tracedAccess) {
          return createTraceReadPropertyExpression(
            ts,
            sourceFile,
            node,
            tracedAccess.variableName,
            tracedAccess.propertyName,
            tracedAccess.scope ?? runtimeScopeForTraceableReceiver(tracedAccess.variableName, localVariableNames)
          );
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
        return ts.factory.updateSourceFile(
          visited,
          instrumentStatementList(
            ts,
            sourceFile,
            node.statements,
            visited.statements,
            variableNames,
            lineFunctionMap,
            effectiveFunctionName
          )
        );
      }

      if (ts.isBlock(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        return ts.factory.updateBlock(
          visited,
          instrumentStatementList(
            ts,
            sourceFile,
            node.statements,
            visited.statements,
            variableNames,
            lineFunctionMap,
            effectiveFunctionName
          )
        );
      }

      if (ts.isWhileStatement(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        return rewriteWhileStatementForTracing(
          ts,
          sourceFile,
          visited,
          variableNames,
          lineFunctionMap,
          effectiveFunctionName
        );
      }

      if (ts.isForStatement(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        return rewriteForStatementForTracing(
          ts,
          sourceFile,
          visited,
          variableNames,
          lineFunctionMap,
          effectiveFunctionName
        );
      }

      if (ts.isForOfStatement(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        return rewriteForOfStatementForTracing(
          ts,
          sourceFile,
          context,
          visited,
          variableNames,
          lineFunctionMap,
          effectiveFunctionName
        );
      }

      if (ts.isCaseClause(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        return ts.factory.updateCaseClause(
          visited,
          visited.expression,
          instrumentStatementList(
            ts,
            sourceFile,
            node.statements,
            visited.statements,
            variableNames,
            lineFunctionMap,
            effectiveFunctionName
          )
        );
      }

      if (ts.isDefaultClause(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        return ts.factory.updateDefaultClause(
          visited,
          instrumentStatementList(
            ts,
            sourceFile,
            node.statements,
            visited.statements,
            variableNames,
            lineFunctionMap,
            effectiveFunctionName
          )
        );
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
    `${JAVASCRIPT_RUNTIME_PRELUDE}
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
  if (!__indices.every((__index) =>
    (typeof __index === 'number' && Number.isInteger(__index)) ||
    (typeof __index === 'string' && __index.length > 0)
  )) return null;
  return __indices.map((__index) => typeof __index === 'number' ? Math.trunc(__index) : __index);
}

function __traceNormalizeIndexSources(__indexSources, __pathLength) {
  if (!Array.isArray(__indexSources) || !Number.isInteger(__pathLength) || __pathLength <= 0) return null;
  const __normalized = __indexSources.slice(0, __pathLength).map((__source) =>
    typeof __source === 'string' && __source.length > 0 ? __source : null
  );
  while (__normalized.length < __pathLength) __normalized.push(null);
  return __normalized.some((__source) => __source !== null) ? __normalized : null;
}

function __traceReadValueAtIndices(__container, __indices) {
  let __current = __container;
  for (const __index of __indices) {
    if (__current === null || __current === undefined) return undefined;
    __current = __traceIsMapLike(__current) ? __current.get(__index) : __current[__index];
  }
  return __current;
}

function __traceIsMapLike(__value) {
  return __value instanceof Map ||
    (!!__value &&
      typeof __value === 'object' &&
      typeof __value.get === 'function' &&
      typeof __value.set === 'function' &&
      typeof __value.has === 'function' &&
      typeof __value.delete === 'function');
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

function __traceReadIndex(__varName, __container, __indices, __indexSources, __location) {
  const __normalized = __traceNormalizeIndices(__indices);
  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);
  const __value = __traceReadValueAtIndices(__container, Array.isArray(__indices) ? __indices : []);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',
      indices: __normalized,
      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
      pathDepth: __normalized.length,
      value: __value,
      ...__traceNormalizeSourceLocation(__location),
    });
  }
  return __value;
}

function* __traceIterableBind(__varName, __iterable, __bindingName, __location) {
  if (
    typeof __varName !== 'string' ||
    typeof __bindingName !== 'string' ||
    (__iterable === null || __iterable === undefined) ||
    typeof __iterable[Symbol.iterator] !== 'function'
  ) {
    yield* __iterable;
    return;
  }
  let __index = 0;
  for (const __value of __iterable) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: 'indexed-read',
      indices: [__index],
      pathDepth: 1,
      value: __value,
      binding: { kind: 'iteration', variable: __bindingName },
      ...__traceNormalizeSourceLocation(__location),
    });
    __index += 1;
    yield __value;
  }
}

function* __traceIterableBindIndexed(__varName, __iterable, __baseIndices, __indexSources, __bindingName, __location) {
  if (
    typeof __varName !== 'string' ||
    typeof __bindingName !== 'string' ||
    (__iterable === null || __iterable === undefined) ||
    typeof __iterable[Symbol.iterator] !== 'function'
  ) {
    yield* __iterable;
    return;
  }
  const __base = __traceNormalizeIndices(__baseIndices);
  const __baseSources = __traceNormalizeIndexSources(__indexSources, __base?.length ?? 0);
  let __index = 0;
  for (const __value of __iterable) {
    if (__base) {
      const __path = [...__base, __index];
      const __sources = Array.isArray(__baseSources) ? [...__baseSources, null] : null;
      __traceRecorder.recordAccess({
        variable: __varName,
        kind: __path.length === 2 ? 'cell-read' : 'indexed-read',
        indices: __path,
        pathDepth: __path.length,
        value: __value,
        ...(Array.isArray(__sources) ? { indexSources: __sources } : {}),
        binding: { kind: 'iteration', variable: __bindingName },
        ...__traceNormalizeSourceLocation(__location),
      });
    }
    __index += 1;
    yield __value;
  }
}

function __traceIsMetadataProperty(__container, __propertyName) {
  if (__propertyName === 'length') {
    return Array.isArray(__container) || typeof __container === 'string';
  }
  if (__propertyName === 'size') {
    return __traceIsMapLike(__container) || __container instanceof Set;
  }
  return false;
}

function __traceNormalizeSourceLocation(__location) {
  if (!__location || typeof __location !== 'object') return {};
  const __line = Number(__location.line);
  const __column = Number(__location.column);
  return {
    ...(Number.isFinite(__line) && __line > 0 ? { line: Math.trunc(__line) } : {}),
    ...(Number.isFinite(__column) && __column >= 0 ? { column: Math.trunc(__column) } : {}),
  };
}

function __traceReadProperty(__varName, __container, __propertyName, __scopeOrLocation, __maybeLocation) {
  const __scope = typeof __scopeOrLocation === 'string' ? __scopeOrLocation : undefined;
  const __location = typeof __scopeOrLocation === 'string' ? __maybeLocation : __scopeOrLocation;
  __traceRecorder.recordAccess({
    variable: __varName,
    kind: 'indexed-read',
    indices: [__propertyName],
    pathDepth: 1,
    ...(__scope ? { scope: __scope } : {}),
    ...__traceNormalizeSourceLocation(__location),
  });
  return __container?.[__propertyName];
}

function __traceWriteIndex(__varName, __container, __indices, __indexSources, __value, __location) {
  const __normalized = __traceNormalizeIndices(__indices);
  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);
  const __result = __traceWriteValueAtIndices(__container, Array.isArray(__indices) ? __indices : [], __value);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',
      indices: __normalized,
      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
      pathDepth: __normalized.length,
      value: __result,
      ...__traceNormalizeSourceLocation(__location),
    });
  }
  return __result;
}

function __traceScalarWrite(__varName, __value, __location) {
  __traceRecorder.recordAccess({
    variable: __varName,
    kind: 'indexed-write',
    value: __value,
    ...__traceNormalizeSourceLocation(__location),
  });
  return __value;
}

function __traceAssignScalar(__varName, __value, __location) {
  return __traceScalarWrite(__varName, __value, __location);
}

function __traceUpdateScalar(__varName, __update, __current, __isPrefix, __location) {
  const __result = typeof __update === 'function' ? __update() : undefined;
  const __value = typeof __current === 'function' ? __current() : __result;
  __traceScalarWrite(__varName, __value, __location);
  return __isPrefix ? __value : __result;
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

function __traceAugAssignIndex(__varName, __container, __indices, __indexSources, __op, __rhs, __location) {
  const __normalized = __traceNormalizeIndices(__indices);
  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);
  const __effectiveIndices = Array.isArray(__indices) ? __indices : [];
  const __current = __traceReadValueAtIndices(__container, __effectiveIndices);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',
      indices: __normalized,
      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
      pathDepth: __normalized.length,
      ...__traceNormalizeSourceLocation(__location),
    });
  }
  const __next = __traceApplyAugmentedValue(__current, __op, __rhs);
  __traceWriteValueAtIndices(__container, __effectiveIndices, __next);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',
      indices: __normalized,
      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
      pathDepth: __normalized.length,
      value: __next,
      ...__traceNormalizeSourceLocation(__location),
    });
  }
  return __next;
}

function __traceUpdateIndex(__varName, __container, __indices, __indexSources, __op, __isPrefix, __location) {
  const __normalized = __traceNormalizeIndices(__indices);
  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);
  const __effectiveIndices = Array.isArray(__indices) ? __indices : [];
  const __current = __traceReadValueAtIndices(__container, __effectiveIndices);
  if (__normalized) {
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',
      indices: __normalized,
      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
      pathDepth: __normalized.length,
      ...__traceNormalizeSourceLocation(__location),
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
      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
      pathDepth: __normalized.length,
      value: __next,
      ...__traceNormalizeSourceLocation(__location),
    });
  }
  return __isPrefix ? __next : __current;
}

function __traceNormalizeMethodName(__container, __method, __args) {
  void __container;
  void __args;
  return __method;
}

function __traceStdout(__line, ...__args) {
  console.log(...__args);
  __traceRecorder.recordStdout(__line, __args.map((__arg) => String(__arg)).join(' '));
}

function __traceExceptionValue(__line, __error) {
  __traceRecorder.recordException(__line, __error);
  return __error;
}

function __traceMutatingCall(__varName, __container, __indices, __indexSources, __method, __location, ...__args) {
  const __sourceLocation = __traceNormalizeSourceLocation(__location);
  let __target = __container;
  for (const __index of __indices || []) {
    __target = __traceIsMapLike(__target) ? __target.get(__index) : __target?.[__index];
  }
  const __mayMutate = ['push', 'pop', 'shift', 'unshift', 'splice', 'set', 'add', 'delete', 'clear'].includes(__method);
  const __result = __target[__method](...__args);
  if (['push', 'pop', 'shift', 'unshift', 'splice', 'set', 'get', 'has', 'add', 'delete', 'clear'].includes(__method)) {
    const __path = __indices || [];
    const __isMapLike = __traceIsMapLike(__target);
    const __isNestedMap = __path.length > 0 && __traceIsMapLike(__target);
    if (__isMapLike && __method === 'set') {
      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length + 1);
      const __targetPath = [...__path, __args[0]];
      __traceRecorder.recordAccess({
        variable: __varName,
        kind: 'indexed-write',
        indices: __targetPath,
        pathDepth: __path.length + 1,
        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
        value: serializeValue(__args[1]),
        ...__sourceLocation,
      });
      __traceRecorder.recordAccess({
        variable: __varName,
        kind: 'mutating-call',
        method: __traceNormalizeMethodName(__target, __method, __args),
        args: __args,
        indices: __targetPath,
        pathDepth: __path.length + 1,
        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
        ...__sourceLocation,
      });
      return __result;
    }
    if (__isMapLike && (__method === 'get' || __method === 'has')) {
      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length + 1);
      __traceRecorder.recordAccess({
        variable: __varName,
        kind: 'indexed-read',
        indices: [...__path, __args[0]],
        pathDepth: __path.length + 1,
        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
        value: serializeValue(__result),
        ...__sourceLocation,
      });
      return __result;
    }
    if (__target instanceof Set && __method === 'has') {
      __traceRecorder.recordAccess({
        variable: __varName,
        kind: 'indexed-read',
        indices: [...__path, __args[0]],
        pathDepth: __path.length + 1,
        ...__sourceLocation,
      });
      return __result;
    }
    if (__path.length > 0) {
      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length);
      __traceRecorder.recordAccess({
        variable: __varName,
        kind: 'indexed-read',
        indices: __path,
        pathDepth: __path.length,
        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
        ...__sourceLocation,
      });
    }
    const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length);
    __traceRecorder.recordAccess({
      variable: __varName,
      kind: 'mutating-call',
      method: __traceNormalizeMethodName(__target, __method, __args),
      args: __args,
      indices: __path,
      pathDepth: __path.length,
      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),
      ...__sourceLocation,
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
    `${JAVASCRIPT_RUNTIME_PRELUDE}
${TRACING_RUNTIME_HELPERS_SOURCE}
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
${CUSTOM_OBJECT_MATERIALIZER_SOURCE}
let __target;
try {
  __target = eval(__functionName);
} catch (_err) {
  __target = undefined;
}
if (typeof __target !== 'function') {
  throw new Error('Function "' + __functionName + '" not found');
}
return __target(${argNames.map((name) => `__tracecodeMaterializeCustomObject(${name})`).join(', ')});`
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
${CUSTOM_OBJECT_MATERIALIZER_SOURCE}
if (typeof Solution !== 'function') {
  throw new Error('Class "Solution" not found');
}
const __solver = new Solution();
const __method = __solver[__functionName];
if (typeof __method !== 'function') {
  throw new Error('Method "Solution.' + __functionName + '" not found');
}
return __method.call(__solver, ${argNames.map((name) => `__tracecodeMaterializeCustomObject(${name})`).join(', ')});`
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
${CUSTOM_OBJECT_MATERIALIZER_SOURCE}
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
  __callArgs = __callArgs.map((__arg) => __tracecodeMaterializeCustomObject(__arg));
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
${CUSTOM_OBJECT_MATERIALIZER_SOURCE}
let __target;
try {
  __target = eval(__functionName);
} catch (_err) {
  __target = undefined;
}
if (typeof __target !== 'function') {
  throw new Error('Function "' + __functionName + '" not found');
}
return __target(${argNames.map((name) => `__tracecodeMaterializeCustomObject(${name})`).join(', ')});`
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
${CUSTOM_OBJECT_MATERIALIZER_SOURCE}
if (typeof Solution !== 'function') {
  throw new Error('Class "Solution" not found');
}
const __solver = new Solution();
const __method = __solver[__functionName];
if (typeof __method !== 'function') {
  throw new Error('Method "Solution.' + __functionName + '" not found');
}
return __method.call(__solver, ${argNames.map((name) => `__tracecodeMaterializeCustomObject(${name})`).join(', ')});`
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
${CUSTOM_OBJECT_MATERIALIZER_SOURCE}
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
  __callArgs = __callArgs.map((__arg) => __tracecodeMaterializeCustomObject(__arg));
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
  const materializers = await resolveInputMaterializers(code, functionName, executionStyle, language);
  const materializedInputs = applyInputMaterializers(normalizedInputs, materializers);

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
        const { operations, argumentsList } = getOpsClassInputs(materializedInputs);
        const runner = buildFunctionExecutionRunner(executableCode, executionStyle, []);
        output = await Promise.resolve(runner(consoleProxy, functionName, operations, argumentsList));
      } else {
        const inputKeys = await resolveOrderedInputKeys(code, functionName, materializedInputs, executionStyle, language);
        const argNames = inputKeys.map((_, index) => `__arg${index}`);
        const argValues = inputKeys.map((key) => materializedInputs[key]);
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
      output: serializeOutputValue(output),
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
  const materializers = await resolveInputMaterializers(code, functionName, executionStyle, language);
  const materializedInputs = applyInputMaterializers(normalizedInputs, materializers);
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
    traceLineBounds = determineTraceLineBounds(code, functionName, executionStyle);

    let instrumentedCode = null;
    try {
      if (language === 'typescript') {
        const instrumentedTypeScript = await instrumentCodeForTracing(code, language, traceFunctionName);
        instrumentedCode = instrumentedTypeScript ? transpileTypeScript(instrumentedTypeScript) : null;
      } else {
        instrumentedCode = await instrumentCodeForTracing(executableCode, language, traceFunctionName);
      }
    } catch (instrumentationError) {
      const message =
        instrumentationError instanceof Error ? instrumentationError.message : String(instrumentationError);
      emitRuntimeDiagnostic('warn', 'trace-instrumentation-fallback', 'Trace instrumentation failed; using synthetic fallback.', {
        message,
      });
    }

    if (!instrumentedCode) {
      const fallbackResult = await executeCode(payload);
      const executionTimeMs = performanceNow() - startedAt;

      if (!fallbackResult.success) {
        const trace = createEmptyRuntimeTrace(language);
        return {
          success: false,
          error: fallbackResult.error,
          errorLine: fallbackResult.errorLine,
          trace,
          executionTimeMs,
          consoleOutput: fallbackResult.consoleOutput ?? [],
          lineEventCount: trace.lineEventCount,
          traceStepCount: trace.traceStepCount,
        };
      }

      const trace = createSyntheticRuntimeTrace(payload, fallbackResult, language);
      return {
        success: true,
        output: fallbackResult.output,
        trace,
        executionTimeMs,
        consoleOutput: fallbackResult.consoleOutput ?? [],
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
      };
    }

    const serializedInputs = {};
    for (const [key, value] of Object.entries(materializedInputs)) {
      serializedInputs[key] = serializeValue(value);
    }

    let output;
    if (hasNamedFunction) {
      if (executionStyle === 'ops-class') {
        const { operations, argumentsList } = getOpsClassInputs(materializedInputs);
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
        const inputKeys = await resolveOrderedInputKeys(code, functionName, materializedInputs, executionStyle, language);
        const argNames = inputKeys.map((_, index) => `__arg${index}`);
        const argValues = inputKeys.map((key) => materializedInputs[key]);
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

    const serializedTraceOutput = serializeValue(output);
    const serializedOutput = serializeOutputValue(output);
    if (!hasNamedFunction) {
      traceRecorder.popToFunction(traceFunctionName);
      traceRecorder.recordReturn(traceLineBounds.endLine, serializedTraceOutput, traceFunctionName);
    }

    const executionTimeMs = performanceNow() - startedAt;
    const trace = traceRecorder.getRuntimeTrace(language, `${language}:run`, defaultRuntimeTraceFile(language));
    return {
      success: true,
      output: serializedOutput,
      trace,
      executionTimeMs,
      consoleOutput,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
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

    const trace = traceRecorder.getRuntimeTrace(language, `${language}:run`, defaultRuntimeTraceFile(language));
    return {
      success: false,
      output: null,
      error: message,
      errorLine,
      trace,
      executionTimeMs,
      consoleOutput,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
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
  ensureJavaScriptLibraries();
  isInitialized = true;
  isLoading = false;
  return { success: true, loadTimeMs: performanceNow() - startedAt };
}

async function warmRuntime(payload = {}) {
  const startedAt = performanceNow();
  const initStartedAt = performanceNow();
  await initRuntime();
  const initMs = performanceNow() - initStartedAt;
  let compilerWarmupMs = 0;

  if (payload?.language === 'typescript' || payload?.preloadTypeScriptCompiler === true) {
    const compilerStartedAt = performanceNow();
    await ensureTypeScriptCompiler();
    compilerWarmupMs = performanceNow() - compilerStartedAt;
  }

  const totalMs = performanceNow() - startedAt;
  return {
    success: true,
    loadTimeMs: totalMs,
    timings: {
      totalMs,
      initMs,
      warmupMs: compilerWarmupMs,
    },
  };
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

      case 'warmup': {
        const result = await warmRuntime(payload);
        self.postMessage({ id, type: 'warmup-result', payload: result });
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

emitRuntimeDiagnostic('info', 'worker-ready', 'JavaScript worker is ready.');
self.postMessage({ type: 'worker-ready' });
