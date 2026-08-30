import { parse, type Comment, type Node } from 'acorn';
import {
  isAdmittedJavaScriptModule,
  isJavaScriptRuntimeSelectorAllowed,
  SES_CONSOLE_COMPATIBILITY_REQUIRED,
} from './javascript-runtime-policy';

const WORKER_MODE = 'ses' as const;

declare const __TRACECODE_TRACE_RUNTIME_SUPPORT_SOURCE__: string;
declare const __TRACECODE_TRACE_RUNTIME_HELPERS_SOURCE__: string;

type ExecutionStyle = 'function' | 'solution-method' | 'ops-class';

interface PreparedSource {
  readonly mode: 'code' | 'trace';
  readonly language: 'javascript' | 'typescript';
  readonly code: string;
  readonly instrumentedCode?: string;
  readonly functionName: string;
  readonly executionStyle: ExecutionStyle;
  readonly requiredModules: readonly string[];
  readonly inputArguments: readonly {
    readonly key: string;
    readonly rest?: boolean;
  }[];
  readonly materializers: Readonly<Record<string, unknown>>;
  readonly traceLineBounds?: {
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly traceOptions?: Readonly<Record<string, unknown>>;
}

interface PreparedProgram {
  readonly mode: PreparedSource['mode'];
  readonly language: PreparedSource['language'];
  readonly codeLearnerFactorySource: string;
  readonly traceLearnerFactorySource?: string;
  readonly capabilityBootstrapSource: string;
  readonly moduleBootstrapSource: string;
  readonly functionName: string;
  readonly executionStyle: ExecutionStyle;
  readonly inputArguments: PreparedSource['inputArguments'];
  readonly materializers: PreparedSource['materializers'];
  readonly requiredModules: PreparedSource['requiredModules'];
  readonly traceLineBounds?: PreparedSource['traceLineBounds'];
  readonly traceOptions?: PreparedSource['traceOptions'];
}

interface WorkerRequest {
  readonly id: number;
  readonly type: 'init' | 'prepare' | 'execute-batch' | 'dispose-program' | 'ping';
  readonly programId?: string;
  readonly source?: PreparedSource;
  readonly inputBatch?: readonly Record<string, unknown>[];
  readonly traceEnabledBatch?: readonly boolean[];
  readonly javascriptLibrariesUrl?: string;
  readonly javascriptLibrariesIntegrity?: string;
}


const CONSOLE_BOOTSTRAP_SOURCE = `(() => {
  const output = [];
  const stringify = JSON.stringify;
  const mathMin = Math.min;
  const mathMax = Math.max;
  const truncationMarker = '…[truncated]';
  const truncate = (text, limit) => {
    if (text.length <= limit) return text;
    if (limit <= truncationMarker.length) return truncationMarker.slice(0, limit);
    return text.slice(0, limit - truncationMarker.length) + truncationMarker;
  };
  const format = (value) => {
    if (typeof value === 'string') {
      return truncate(value, 4096);
    }
    if (value === null || value === undefined ||
        typeof value === 'number' || typeof value === 'boolean') {
      return truncate(String(value), 4096);
    }
    try {
      const encoded = stringify(value);
      return typeof encoded === 'string' ? truncate(encoded, 4096) : '';
    } catch {
      try { return truncate(String(value), 4096); } catch { return '[Unprintable]'; }
    }
  };
  let totalCharacters = 0;
  let stopped = false;
  let budgetExceeded = false;
  const capture = (...values) => {
    if (stopped) return;
    if (output.length >= 99) {
      output.push(truncationMarker);
      stopped = true;
      budgetExceeded = true;
      return;
    }
    const argumentLimit = mathMin(values.length, 40);
    let line = '';
    for (let index = 0; index < argumentLimit; index += 1) {
      const rendered = format(values[index]);
      if (rendered.endsWith(truncationMarker)) budgetExceeded = true;
      line = truncate(line + (index === 0 ? '' : ' ') + rendered, 8192);
      if (line.endsWith(truncationMarker)) {
        budgetExceeded = true;
        break;
      }
    }
    if (values.length > argumentLimit && !line.endsWith(truncationMarker)) {
      budgetExceeded = true;
      line = truncate(line + ' … ' + (values.length - argumentLimit) + ' more', 8192);
    }
    const remaining = 65536 - totalCharacters;
    if (line.length > remaining) {
      line = truncate(line, mathMax(0, remaining));
      stopped = true;
      budgetExceeded = true;
    }
    output.push(line);
    totalCharacters += line.length;
  };
  globalThis.console = Object.freeze({
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
  });
  return () => stringify({ lines: output, budgetExceeded });
})()`;
const RUNTIME_BOOTSTRAP_SOURCE = `(() => {
  class ListNode {
    constructor(val = 0, next = null) {
      this.val = val;
      this.value = val;
      this.next = next;
    }
  }
  class TreeNode {
    constructor(val = 0, left = null, right = null) {
      this.val = val;
      this.value = val;
      this.left = left;
      this.right = right;
    }
  }
  Object.defineProperties(globalThis, {
    ListNode: { value: ListNode, writable: true, configurable: true },
    TreeNode: { value: TreeNode, writable: true, configurable: true },
  });
})()`;

const CASE_RUNTIME_BOUNDARY_SOURCE = `(() => {
  const blockedDynamicEvaluation = function () {
    throw Object.assign(new Error('Harness blocked dynamic code evaluation'), {
      code: 'ERR_HARNESS_DYNAMIC_EVAL',
    });
  };
  Object.defineProperties(globalThis, {
    global: { value: globalThis, writable: false, enumerable: false, configurable: false },
    self: { value: undefined, writable: false, enumerable: false, configurable: false },
    window: { value: undefined, writable: false, enumerable: false, configurable: false },
    document: { value: undefined, writable: false, enumerable: false, configurable: false },
    postMessage: { value: undefined, writable: false, enumerable: false, configurable: false },
    importScripts: { value: undefined, writable: false, enumerable: false, configurable: false },
    Worker: { value: undefined, writable: false, enumerable: false, configurable: false },
    SharedWorker: { value: undefined, writable: false, enumerable: false, configurable: false },
    WebAssembly: { value: undefined, writable: false, enumerable: false, configurable: false },
    process: { value: undefined, writable: false, enumerable: false, configurable: false },
    Function: { value: blockedDynamicEvaluation, writable: false, enumerable: false, configurable: false },
    eval: { value: blockedDynamicEvaluation, writable: false, enumerable: false, configurable: false },
    Compartment: { value: blockedDynamicEvaluation, writable: false, enumerable: false, configurable: false },
  });
})()`;
const programs = new Map<string, PreparedProgram>();
let javascriptLibrariesSource = '';
let javascriptLibraryEndowments: Readonly<Record<string, unknown>> | undefined;
let javascriptLibrariesUrl: string | undefined;
let javascriptLibrariesIntegrity: string | undefined;
let javascriptLibrariesLoad: Promise<void> | undefined;
let initialized = false;
let createFastTraceRecorder:
  | ((options?: Readonly<Record<string, unknown>>) => Record<string, (...args: unknown[]) => unknown>)
  | undefined;

const safeHostEndowmentCandidates: Record<string, unknown> = {
  ...('Float16Array' in globalThis
    ? { Float16Array: (globalThis as unknown as Record<string, unknown>).Float16Array }
    : {}),
  Float32Array,
  Float64Array,
  TextDecoder,
  TextEncoder,
  structuredClone: (value: unknown): unknown => globalThis.structuredClone(value),
  Intl,
  URL,
  URLSearchParams,
  atob: (value: string): string => globalThis.atob(value),
  btoa: (value: string): string => globalThis.btoa(value),
};
const safeHostEndowments = harden(
  safeHostEndowmentCandidates
) as Readonly<Record<string, unknown>>;

function isSafeSelector(value: unknown): value is string {
  return isJavaScriptRuntimeSelectorAllowed(value);
}

function assertPreparedShape(value: unknown): asserts value is PreparedSource {
  if (!value || typeof value !== 'object') {
    throw new Error('SES prepared source must be an object.');
  }
  const source = value as Partial<PreparedSource>;
  if (
    (source.mode !== 'code' && source.mode !== 'trace') ||
    (source.language !== 'javascript' && source.language !== 'typescript') ||
    typeof source.code !== 'string' ||
    !isSafeSelector(source.functionName)
  ) {
    throw new Error('SES prepared source has invalid code or target name.');
  }
  if (
    source.mode === 'trace' &&
    (
      typeof source.instrumentedCode !== 'string' ||
      !source.traceLineBounds ||
      !Number.isSafeInteger(source.traceLineBounds.startLine) ||
      !Number.isSafeInteger(source.traceLineBounds.endLine) ||
      source.traceLineBounds.startLine <= 0 ||
      source.traceLineBounds.endLine < source.traceLineBounds.startLine ||
      (source.traceOptions !== undefined &&
        (!source.traceOptions || typeof source.traceOptions !== 'object' ||
          Array.isArray(source.traceOptions)))
    )
  ) {
    throw new Error('SES trace preparation has an invalid instrumented artifact.');
  }
  if (!['function', 'solution-method', 'ops-class'].includes(source.executionStyle ?? '')) {
    throw new Error('SES prepared source has an invalid execution style.');
  }
  if (!Array.isArray(source.requiredModules)) {
    throw new Error('SES prepared source has invalid required modules.');
  }
  for (let index = 0; index < source.requiredModules.length; index += 1) {
    if (!(index in source.requiredModules) || typeof source.requiredModules[index] !== 'string') {
      throw new Error('SES prepared source has invalid required modules.');
    }
  }
  if (!Array.isArray(source.inputArguments)) {
    throw new Error('SES prepared source has invalid input arguments.');
  }
  for (let index = 0; index < source.inputArguments.length; index += 1) {
    const argument = source.inputArguments[index];
    if (
      !(index in source.inputArguments) ||
      !argument ||
      typeof argument !== 'object' ||
      typeof argument.key !== 'string' ||
      (argument.rest !== undefined && typeof argument.rest !== 'boolean')
    ) {
      throw new Error('SES prepared source has invalid input arguments.');
    }
  }
  if (!source.materializers || typeof source.materializers !== 'object' || Array.isArray(source.materializers)) {
    throw new Error('SES prepared source has invalid input materializers.');
  }
}

function assertAdmittedModules(source: PreparedSource): void {
  for (let index = 0; index < source.requiredModules.length; index += 1) {
    if (!isAdmittedJavaScriptModule(source.requiredModules[index])) {
      throw new Error('SES learner source requested an unadmitted module.');
    }
  }
}

function reply(id: number, value: unknown): void {
  postMessage({ id, ok: true, value });
}

function safeErrorText(error: unknown): string {
  const truncate = (text: string): string => text.length <= 8192
    ? text
    : `${text.slice(0, 8179)}…[truncated]`;
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      try {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') return truncate(message);
      } catch {
        // A learner-controlled getter must not defeat the control reply.
      }
    }
    try {
      return truncate(String(error));
    } catch {
      return 'Unknown SES execution error.';
    }
  } catch {
    return 'Unknown SES execution error.';
  }
}

function learnerErrorLine(error: unknown): number | undefined {
  try {
    const privilegedStackReader = (
      globalThis as typeof globalThis & {
        readonly getStackString?: (candidate: unknown) => unknown;
      }
    ).getStackString;
    const stack = typeof privilegedStackReader === 'function'
      ? privilegedStackReader(error)
      : error && typeof error === 'object'
        ? (error as { readonly stack?: unknown }).stack
        : undefined;
    if (typeof stack !== 'string') return undefined;
    const matches = [...stack.matchAll(/tracecode-ses-learner\.js:(\d+):\d+/gu)];
    const rawLine = matches.length > 0 ? Number(matches[0]?.[1]) : NaN;
    return Number.isSafeInteger(rawLine) && rawLine > 2 ? rawLine - 2 : undefined;
  } catch {
    return undefined;
  }
}

function fail(id: number, error: unknown, stage: 'compile' | 'control' = 'control'): void {
  const response = { id, ok: false, error: safeErrorText(error), stage };
  try {
    postMessage(response);
  } catch {
    try {
      postMessage({
        id: Number.isSafeInteger(id) ? id : -1,
        ok: false,
        error: 'SES worker could not serialize its failure response.',
        stage: 'control',
      });
    } catch {
      // The outer Worker watchdog remains the last-resort settlement boundary.
    }
  }
}

function isLearnerEngineSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function deterministicCapabilityPrelude(source: PreparedSource): string {
  const taskAndClock = `
  let __tracecodePerformanceClock = 0;
  let __tracecodeTimerSequence = 1;
  const __tracecodeTimers = new Map();
  const __tracecodeQueueMicrotask = (callback) => {
    if (typeof callback !== 'function') throw new TypeError('queueMicrotask callback must be a function');
    Promise.resolve().then(() => { try { callback(); } catch {} });
  };
  const __tracecodeSetTimeout = (callback, _delay, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('setTimeout callback must be a function');
    const id = __tracecodeTimerSequence++;
    __tracecodeTimers.set(id, true);
    Promise.resolve().then(() => {
      if (!__tracecodeTimers.delete(id)) return;
      try { callback(...args); } catch {}
    });
    return id;
  };
  const __tracecodeClearTimeout = (id) => { __tracecodeTimers.delete(id); };
  Object.defineProperties(globalThis, {
    performance: {
      value: Object.freeze({
        now: () => __tracecodePerformanceClock++,
        timeOrigin: 1700000000000,
      }),
      writable: false,
      configurable: false,
    },
    queueMicrotask: { value: __tracecodeQueueMicrotask, writable: false, configurable: false },
    setTimeout: { value: __tracecodeSetTimeout, writable: false, configurable: false },
    clearTimeout: { value: __tracecodeClearTimeout, writable: false, configurable: false },
  });`;
  const math = (/\bMath\b/u.test(source.code) || source.requiredModules.length > 0)
    ? `
  const __tracecodeSharedMath = globalThis.Math;
  let __tracecodeRandomState = 0x9e3779b9;
  const __tracecodeRandom = () => {
    __tracecodeRandomState ^= __tracecodeRandomState << 13;
    __tracecodeRandomState ^= __tracecodeRandomState >>> 17;
    __tracecodeRandomState ^= __tracecodeRandomState << 5;
    return (__tracecodeRandomState >>> 0) / 4294967296;
  };
  const __tracecodeMathDescriptors = Object.getOwnPropertyDescriptors(__tracecodeSharedMath);
  __tracecodeMathDescriptors.random = {
    value: __tracecodeRandom,
    writable: false,
    enumerable: false,
    configurable: false,
  };
  const Math = Object.freeze(Object.defineProperties({}, __tracecodeMathDescriptors));
  globalThis.Math = Math;`
    : '';
  const date = (/\bDate\b/u.test(source.code) || source.requiredModules.length > 0)
    ? `
  const __tracecodeSharedDate = globalThis.Date;
  let __tracecodeClock = 1700000000000;
  const __tracecodeDateNow = () => __tracecodeClock++;
  const Date = function (...args) {
    if (new.target) {
      return Reflect.construct(
        __tracecodeSharedDate,
        args.length === 0 ? [__tracecodeDateNow()] : args,
        new.target
      );
    }
    return Reflect.construct(__tracecodeSharedDate, [__tracecodeDateNow()]).toString();
  };
  Object.setPrototypeOf(Date.prototype, __tracecodeSharedDate.prototype);
  Object.defineProperties(Date, {
    name: { value: 'Date', configurable: true },
    length: { value: 7, configurable: true },
    parse: Object.getOwnPropertyDescriptor(__tracecodeSharedDate, 'parse'),
    UTC: Object.getOwnPropertyDescriptor(__tracecodeSharedDate, 'UTC'),
  });
  Object.defineProperty(Date, 'now', {
    value: __tracecodeDateNow,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.freeze(Date.prototype);
  Object.freeze(Date);
  globalThis.Date = Date;`
    : '';
  return `${taskAndClock}${math}${date}`;
}

const DRIVER_SOURCE = `(() => {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const arrayIsArray = Array.isArray;
  const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
  const objectEntries = Object.entries;
  const objectKeys = Object.keys;
  const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const objectIs = Object.is;
  const toText = String;
  const isPlainRecord = (value) => value !== null && typeof value === 'object' &&
    !arrayIsArray(value) && Object.prototype.toString.call(value) === '[object Object]';
  const collectReferenceTargets = (value, byId, seen) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (arrayIsArray(value)) {
      for (const item of value) collectReferenceTargets(item, byId, seen);
      return;
    }
    if (!isPlainRecord(value)) return;
    if (typeof value.__id__ === 'string' && value.__id__.length > 0 && !byId.has(value.__id__)) {
      byId.set(value.__id__, value);
    }
    for (const child of Object.values(value)) collectReferenceTargets(child, byId, seen);
  };
  const resolveReferenceGraph = (value, byId, resolved) => {
    if (value === null || typeof value !== 'object') return value;
    if (resolved.has(value)) return resolved.get(value);
    if (arrayIsArray(value)) {
      const out = [];
      resolved.set(value, out);
      for (const item of value) out.push(resolveReferenceGraph(item, byId, resolved));
      return out;
    }
    if (!isPlainRecord(value)) return value;
    const keys = objectKeys(value);
    if (keys.length === 1 && typeof value.__ref__ === 'string') {
      const target = byId.get(value.__ref__);
      return target ? resolveReferenceGraph(target, byId, resolved) : null;
    }
    const out = {};
    resolved.set(value, out);
    for (const [key, child] of objectEntries(value)) {
      out[key] = resolveReferenceGraph(child, byId, resolved);
    }
    return out;
  };
  const normalizeInput = (input) => {
    if (!isPlainRecord(input)) return {};
    const byId = new Map();
    collectReferenceTargets(input, byId, new WeakSet());
    return resolveReferenceGraph(input, byId, new WeakMap());
  };
  const nodeValue = (value) => value.val ?? value.value ?? null;
  const materializeTree = (value, materialized = new WeakMap(), depth = 0) => {
    if (value === null || value === undefined) return value;
    if (depth > 512) throw new Error('Input materializer exceeded maximum depth (512)');
    if (arrayIsArray(value)) {
      if (value.length === 0 || value[0] === null || value[0] === undefined) return null;
      const makeNode = (item) => ({ val: item, value: item, left: null, right: null });
      const root = makeNode(value[0]);
      const queue = [root];
      let queueIndex = 0;
      let index = 1;
      while (queueIndex < queue.length && index < value.length) {
        const node = queue[queueIndex++];
        const left = value[index++];
        if (left !== null && left !== undefined) {
          node.left = makeNode(left);
          queue.push(node.left);
        }
        if (index >= value.length) break;
        const right = value[index++];
        if (right !== null && right !== undefined) {
          node.right = makeNode(right);
          queue.push(node.right);
        }
      }
      return root;
    }
    if (!isPlainRecord(value)) return value;
    const looksLikeTree = value.__type__ === 'TreeNode' ||
      (value.constructor && value.constructor.name === 'TreeNode');
    if (!looksLikeTree) return value;
    const cached = materialized.get(value);
    if (cached) return cached;
    const item = nodeValue(value);
    const node = { val: item, value: item, left: null, right: null };
    materialized.set(value, node);
    node.left = materializeTree(value.left ?? null, materialized, depth + 1);
    node.right = materializeTree(value.right ?? null, materialized, depth + 1);
    for (const [key, child] of objectEntries(value)) {
      if (!['__id__', '__type__', '__class__', 'val', 'value', 'left', 'right'].includes(key)) {
        node[key] = materializeTree(child, materialized, depth + 1);
      }
    }
    return node;
  };
  const materializeList = (value, materialized = new WeakMap(), depth = 0) => {
    if (value === null || value === undefined) return value;
    if (depth > 512) throw new Error('Input materializer exceeded maximum depth (512)');
    if (arrayIsArray(value)) {
      if (value.length === 0) return null;
      const head = { val: value[0], value: value[0], next: null };
      let tail = head;
      for (let index = 1; index < value.length; index += 1) {
        tail.next = { val: value[index], value: value[index], next: null };
        tail = tail.next;
      }
      return head;
    }
    if (!isPlainRecord(value)) return value;
    const looksLikeList = value.__type__ === 'ListNode' ||
      (value.constructor && value.constructor.name === 'ListNode');
    if (!looksLikeList) return value;
    const cached = materialized.get(value);
    if (cached) return cached;
    const item = nodeValue(value);
    const node = { val: item, value: item, next: null };
    materialized.set(value, node);
    node.next = materializeList(value.next ?? null, materialized, depth + 1);
    if (hasOwn(value, 'prev')) node.prev = materializeList(value.prev ?? null, materialized, depth + 1);
    for (const [key, child] of objectEntries(value)) {
      if (!['__id__', '__type__', '__class__', 'val', 'value', 'next', 'prev'].includes(key)) {
        node[key] = materializeList(child, materialized, depth + 1);
      }
    }
    return node;
  };
  const resolveConstructor = (typeName) => {
    const registry = globalThis.__tracecodeConstructors;
    return registry && hasOwn(registry, typeName) ? registry[typeName] : undefined;
  };
  const materializeCustom = (value, targetTypeName, seen = new WeakMap()) => {
    if (value === null || typeof value !== 'object') return value;
    const cached = seen.get(value);
    if (cached) return cached;
    if (arrayIsArray(value)) {
      const out = [];
      seen.set(value, out);
      for (const item of value) out.push(materializeCustom(item, undefined, seen));
      return out;
    }
    if (value.__type__ === 'TreeNode' || value.__type__ === 'ListNode') return value;
    const typeName = typeof targetTypeName === 'string'
      ? targetTypeName
      : (typeof value.__type__ === 'string'
          ? value.__type__
          : (typeof value.__class__ === 'string' ? value.__class__ : null));
    const trustedTypeName = typeof targetTypeName === 'string';
    if (!typeName) {
      seen.set(value, value);
      for (const [key, child] of objectEntries(value)) {
        if (key === '__type__' || key === '__class__' || key === '__id__') continue;
        value[key] = materializeCustom(child, undefined, seen);
      }
      return value;
    }
    const fields = {};
    seen.set(value, fields);
    if (typeof value.__type__ === 'string') fields.__type__ = value.__type__;
    if (typeof value.__class__ === 'string') fields.__class__ = value.__class__;
    for (const [key, child] of objectEntries(value)) {
      if (key === '__type__' || key === '__class__' || key === '__id__') continue;
      fields[key] = materializeCustom(child, undefined, seen);
    }
    if (!trustedTypeName) return fields;
    const constructor = resolveConstructor(typeName);
    if (typeof constructor !== 'function') return fields;
    const args = objectValuesWithoutMetadata(fields);
    let instance;
    try { instance = new constructor(...args); }
    catch { instance = Object.create(constructor.prototype); }
    Object.assign(instance, fields);
    seen.set(value, instance);
    return instance;
  };
  const objectValuesWithoutMetadata = (value) => objectKeys(value)
    .filter((key) => key !== '__type__' && key !== '__class__')
    .map((key) => value[key]);
  const materialize = (value, kind, depth = 0) => {
    if (depth > 512) throw new Error('Input materializer exceeded maximum depth (512)');
    if (!kind) return materializeCustom(value);
    if (kind === 'tree') return materializeTree(value);
    if (kind === 'list') return materializeList(value);
    if (kind.kind === 'custom') return materializeCustom(value, kind.typeName);
    if (kind.kind === 'array') {
      return arrayIsArray(value)
        ? value.map((item) => materialize(item, kind.element, depth + 1))
        : value;
    }
    if (kind.kind === 'record' && isPlainRecord(value)) {
      const out = {};
      for (const [key, child] of objectEntries(value)) {
        out[key] = materialize(child, kind.value, depth + 1);
      }
      return out;
    }
    if (kind.kind === 'map') {
      const entries = arrayIsArray(value) ? value : (isPlainRecord(value) ? objectEntries(value) : null);
      return entries
        ? new Map(entries.map(([key, child]) => [key, materialize(child, kind.value, depth + 1)]))
        : value;
    }
    return materializeCustom(value);
  };
  const inferFallbackMaterializers = (input) => {
    const out = {};
    const listNames = new Set(['head', 'l1', 'l2', 'list1', 'list2', 'node']);
    for (const [name, value] of objectEntries(input)) {
      if (!arrayIsArray(value)) continue;
      const lowerName = toText(name).toLowerCase();
      if (lowerName === 'root' || lowerName.endsWith('root') || lowerName.includes('tree')) {
        out[name] = 'tree';
      } else if (lowerName.endsWith('head') || listNames.has(lowerName)) {
        out[name] = 'list';
      }
    }
    return out;
  };
  const explicitNodeType = (value) => {
    const constructorName = value && value.constructor && value.constructor.name;
    if (constructorName === 'TreeNode' || value.__type__ === 'TreeNode') return 'TreeNode';
    if (constructorName === 'ListNode' || value.__type__ === 'ListNode') return 'ListNode';
    return null;
  };
  const inferredPlainNodeType = (value) => {
    if (value.__type__ === 'TreeNode' || value.__type__ === 'ListNode') return null;
    const id = typeof value.__id__ === 'string' ? value.__id__ : '';
    if (id.startsWith('tree-') || id.startsWith('TreeNode:')) return 'TreeNode';
    if (id.startsWith('list-') || id.startsWith('ListNode:')) return 'ListNode';
    const hasValue = hasOwn(value, 'val') || hasOwn(value, 'value');
    if (hasValue && (hasOwn(value, 'left') || hasOwn(value, 'right'))) return 'TreeNode';
    if (hasValue && (hasOwn(value, 'next') || hasOwn(value, 'prev'))) return 'ListNode';
    return null;
  };
  const forcedNodeTypeForValue = (value, forcedNodeType) => {
    if (!forcedNodeType || !value || typeof value !== 'object' || arrayIsArray(value)) return null;
    return hasOwn(value, 'val') || hasOwn(value, 'value') ? forcedNodeType : null;
  };
  const customClassName = (value) => {
    const name = value && value.constructor && value.constructor.name;
    return typeof name === 'string' && !['', 'Object', 'Array', 'Map', 'Set', 'TreeNode', 'ListNode'].includes(name)
      ? name
      : null;
  };
  const ownEnumerableDataEntries = (value) => {
    if (!value || typeof value !== 'object') return [];
    const entries = [];
    for (const key of objectKeys(value)) {
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true) continue;
      entries.push([
        key,
        hasOwn(descriptor, 'value') ? descriptor.value : '<accessor>',
      ]);
    }
    return entries;
  };
  const encodeOutputTransport = (value, depth = 0) => {
    if (depth > 192) throw new Error('SES output transport exceeded maximum depth.');
    if (value === null) return ['null'];
    if (value === undefined) return ['undefined'];
    if (typeof value === 'string') return ['string', value];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return ['nan'];
      if (value === Infinity) return ['infinity'];
      if (value === -Infinity) return ['negative-infinity'];
      return objectIs(value, -0) ? ['negative-zero'] : ['number', value];
    }
    if (arrayIsArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(hasOwn(value, index)
          ? encodeOutputTransport(value[index], depth + 1)
          : ['hole']);
      }
      return ['array', items];
    }
    if (value !== null && typeof value === 'object') {
      return ['object', objectEntries(value).map(([key, child]) => [
        key,
        encodeOutputTransport(child, depth + 1),
      ])];
    }
    throw new Error('SES output serializer produced an unsupported transport value.');
  };
  const serialize = (value, depth = 0, seen = new WeakSet(), state = {
    ids: new WeakMap(), nextId: 1,
  }, forcedNodeType = null) => {
    if (depth > 48) return '<max depth>';
    if (value === null || value === undefined) return value;
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return 'NaN';
      if (value === Infinity) return 'Infinity';
      if (value === -Infinity) return '-Infinity';
      return value;
    }
    if (typeof value === 'bigint') {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : toText(value);
    }
    if (typeof value === 'symbol') return toText(value);
    if (typeof value === 'function') return '<function>';
    if (typeof value !== 'object') return value;
    if (arrayIsArray(value)) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      return value.map((item) => serialize(item, depth + 1, seen, state));
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      if (value instanceof DataView) {
        return Array.from({ length: value.byteLength }, (_, index) =>
          serialize(value.getUint8(index), depth + 1, seen, state));
      }
      return Array.from({ length: value.length }, (_, index) =>
        serialize(value[index], depth + 1, seen, state));
    }
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      const bytes = new Uint8Array(value);
      return Array.from({ length: bytes.byteLength }, (_, index) =>
        serialize(bytes[index], depth + 1, seen, state));
    }
    if (value instanceof Set) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      return { __type__: 'set', values: Array.from(value, (item) => serialize(item, depth + 1, seen, state)) };
    }
    if (value instanceof Map) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      return { __type__: 'map', entries: Array.from(value, ([key, child]) => [
        serialize(key, depth + 1, seen, state),
        serialize(child, depth + 1, seen, state),
      ]) };
    }
    const explicitType = explicitNodeType(value);
    const nodeType = explicitType ??
      forcedNodeTypeForValue(value, forcedNodeType) ??
      inferredPlainNodeType(value);
    if (nodeType) {
      const existingId = state.ids.get(value);
      if (existingId) return { __ref__: existingId };
      const id = typeof value.__id__ === 'string' && value.__id__.length > 0
        ? value.__id__
        : (explicitType ? 'ref-' : nodeType + ':') + state.nextId++;
      state.ids.set(value, id);
      seen.add(value);
      const out = nodeType === 'TreeNode'
        ? {
            __type__: 'TreeNode', __id__: id,
            val: serialize(nodeValue(value), depth + 1, seen, state),
            left: serialize(value.left ?? null, depth + 1, seen, state, 'TreeNode'),
            right: serialize(value.right ?? null, depth + 1, seen, state, 'TreeNode'),
          }
        : {
            __type__: 'ListNode', __id__: id,
            val: serialize(nodeValue(value), depth + 1, seen, state),
            next: serialize(value.next ?? null, depth + 1, seen, state, 'ListNode'),
            ...(hasOwn(value, 'prev')
              ? { prev: serialize(value.prev ?? null, depth + 1, seen, state, 'ListNode') }
              : {}),
          };
      const skipped = nodeType === 'TreeNode'
        ? new Set(['__id__', '__type__', '__class__', 'val', 'value', 'left', 'right'])
        : new Set(['__id__', '__type__', '__class__', 'val', 'value', 'next', 'prev']);
      for (const [key, child] of ownEnumerableDataEntries(value)) {
        if (!skipped.has(key)) out[key] = serialize(child, depth + 1, seen, state);
      }
      seen.delete(value);
      return out;
    }
    const existingNodeId = (hasOwn(value, 'val') || hasOwn(value, 'value'))
      ? state.ids.get(value)
      : undefined;
    if (existingNodeId) return { __ref__: existingNodeId };
    const className = customClassName(value);
    if (className) {
      const existingId = state.ids.get(value);
      if (existingId) return { __ref__: existingId };
      const id = 'ref-' + state.nextId++;
      state.ids.set(value, id);
      if (seen.has(value)) return { __ref__: id };
      seen.add(value);
      const out = { __type__: className, __class__: className, __id__: id };
      for (const [key, child] of ownEnumerableDataEntries(value)) {
        out[key] = serialize(child, depth + 1, seen, state);
      }
      seen.delete(value);
      return out;
    }
    if (seen.has(value)) return '<cycle>';
    seen.add(value);
    const out = {};
    for (const [key, child] of ownEnumerableDataEntries(value)) {
      out[key] = serialize(child, depth + 1, seen, state);
    }
    return out;
  };
  return async (inputJson, inputArgumentsJson, materializersJson, targetName, executionStyle) => {
    const input = normalizeInput(parse(inputJson));
      const inputArguments = parse(inputArgumentsJson);
      const materializers = {
        ...inferFallbackMaterializers(input),
        ...parse(materializersJson),
      };
      const target = globalThis.__tracecodeTarget;
      const args = [];
      const inputKeys = objectKeys(input);
      const matchedArguments = inputArguments.filter((argument) => hasOwn(input, argument.key));
      const orderedArguments = matchedArguments.length === 0
        ? inputKeys.map((key) => ({ key, rest: false }))
        : [
            ...matchedArguments,
            ...inputKeys
              .filter((key) => !matchedArguments.some((argument) => argument.key === key))
              .map((key) => ({ key, rest: false })),
          ];
      for (const argument of orderedArguments) {
        const value = materialize(input[argument.key], materializers[argument.key]);
        if (argument.rest) {
          if (value === null || value === undefined) continue;
          if (arrayIsArray(value)) args.push(...value);
          else args.push(value);
        } else {
          args.push(value);
        }
      }
      let output;
      if (executionStyle === 'function') {
        if (typeof target !== 'function') throw new Error('Function "' + targetName + '" not found');
        output = await target(...args);
      } else if (executionStyle === 'solution-method') {
        if (typeof target !== 'function') throw new Error('Class "Solution" not found');
        const prototypeMethod = target.prototype && target.prototype[targetName];
        if (typeof prototypeMethod === 'function') {
          const solver = new target();
          output = await prototypeMethod.call(solver, ...args);
        } else if (typeof target[targetName] === 'function') {
          output = await target[targetName].call(target, ...args);
        } else {
          const solver = new target();
          const method = solver[targetName];
          if (typeof method !== 'function') throw new Error('Method "Solution.' + targetName + '" not found');
          output = await method.call(solver, ...args);
        }
      } else if (executionStyle === 'ops-class') {
        const operations = input.operations ?? input.ops;
        const operationArguments = input.arguments ?? input.args;
        if (!arrayIsArray(operations) || !arrayIsArray(operationArguments)) {
          throw new Error('ops-class execution requires inputs.operations and inputs.arguments (or ops/args)');
        }
        if (operations.length !== operationArguments.length) {
          throw new Error('operations and arguments must have the same length');
        }
        if (typeof target !== 'function') throw new Error('Class "' + targetName + '" not found');
        let instance = null;
        output = [];
        for (let index = 0; index < operations.length; index += 1) {
          let callArgs = operationArguments[index];
          if (callArgs === null || callArgs === undefined) callArgs = [];
          if (!arrayIsArray(callArgs)) callArgs = [callArgs];
          callArgs = callArgs.map((argument) => materialize(argument, null));
          if (index === 0) {
            instance = new target(...callArgs);
            output.push(null);
            continue;
          }
          const operation = operations[index];
          if (!instance || typeof instance[operation] !== 'function') {
            throw new Error('Required method "' + operation + '" is not implemented on ' + targetName);
          }
          const result = instance[operation](...callArgs);
          output.push(result === undefined ? null : result);
        }
      } else {
        throw new Error('Unknown algorithm execution style.');
      }
      return stringify({
        success: true,
        output: encodeOutputTransport(output === undefined ? null : serialize(output)),
      });
  };
})()`;

const OUTPUT_TRANSPORT_HOLE = Symbol('tracecode.output-transport-hole');

function decodeOutputTransport(value: unknown, depth = 0): unknown {
  if (depth > 192 || !Array.isArray(value) || value.length < 1 ||
      typeof value[0] !== 'string') {
    throw new Error('SES compartment returned an invalid output transport value.');
  }
  const tag = value[0];
  if (tag === 'null' && value.length === 1) return null;
  if (tag === 'undefined' && value.length === 1) return undefined;
  if (tag === 'negative-zero' && value.length === 1) return -0;
  if (tag === 'nan' && value.length === 1) return Number.NaN;
  if (tag === 'infinity' && value.length === 1) return Infinity;
  if (tag === 'negative-infinity' && value.length === 1) return -Infinity;
  if (tag === 'hole' && value.length === 1) return OUTPUT_TRANSPORT_HOLE;
  if (tag === 'string' && value.length === 2 && typeof value[1] === 'string') {
    return value[1];
  }
  if (tag === 'boolean' && value.length === 2 && typeof value[1] === 'boolean') {
    return value[1];
  }
  if (tag === 'number' && value.length === 2 && typeof value[1] === 'number' &&
      Number.isFinite(value[1])) {
    return value[1];
  }
  if (tag === 'array' && value.length === 2 && Array.isArray(value[1])) {
    const encodedItems = value[1];
    const decoded = new Array<unknown>(encodedItems.length);
    for (let index = 0; index < encodedItems.length; index += 1) {
      if (!(index in encodedItems)) {
        throw new Error('SES compartment returned a sparse output transport array.');
      }
      const item = decodeOutputTransport(encodedItems[index], depth + 1);
      if (item !== OUTPUT_TRANSPORT_HOLE) decoded[index] = item;
    }
    return decoded;
  }
  if (tag === 'object' && value.length === 2 && Array.isArray(value[1])) {
    const decoded: Record<string, unknown> = {};
    for (const encodedEntry of value[1]) {
      if (!Array.isArray(encodedEntry) || encodedEntry.length !== 2 ||
          typeof encodedEntry[0] !== 'string') {
        throw new Error('SES compartment returned an invalid output transport entry.');
      }
      const child = decodeOutputTransport(encodedEntry[1], depth + 1);
      if (child === OUTPUT_TRANSPORT_HOLE) {
        throw new Error('SES compartment returned an object transport hole.');
      }
      Object.defineProperty(decoded, encodedEntry[0], {
        value: child,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return decoded;
  }
  throw new Error('SES compartment returned an invalid output transport value.');
}

interface SourceReplacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

class SourceNormalizationInvariantError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SourceNormalizationInvariantError';
  }
}

function learnerRestriction(message: string, line?: number): SyntaxError {
  return new SyntaxError(
    `TraceCode algorithm runtime restriction${line ? ` at learner line ${line}` : ''}: ${message}`
  );
}

function maskComment(source: string): string {
  return source.replace(/[^\r\n\u2028\u2029]/g, ' ');
}

function escapeCensoredText(source: string): string {
  return source
    .replaceAll('<!--', '\\x3c!--')
    .replaceAll('-->', '\\x2d->')
    .replace(/\bimport(?=\s*(?:\(|\/[/*]))/gu, '\\x69mport');
}

function lineTerminators(source: string): readonly string[] {
  return source.match(/\r\n|[\n\r\u2028\u2029]/gu) ?? [];
}

function normalizationFingerprint(root: Node): string {
  const values: string[] = [];
  const visit = (node: Node): void => {
    const record = node as Node & Record<string, unknown>;
    if (node.type === 'Literal') {
      const literal = record as typeof record & {
        readonly value?: unknown;
        readonly regex?: { readonly pattern?: string; readonly flags?: string };
        readonly bigint?: string;
      };
      if (literal.regex) {
        values.push(`regexp:${literal.regex.pattern ?? ''}/${literal.regex.flags ?? ''}`);
      } else if (typeof literal.bigint === 'string') {
        values.push(`bigint:${literal.bigint}`);
      } else if (typeof literal.value === 'number') {
        const number = literal.value;
        values.push(`number:${Object.is(number, -0) ? '-0' : String(number)}`);
      } else {
        values.push(`${typeof literal.value}:${JSON.stringify(literal.value)}`);
      }
    } else if (node.type === 'TemplateElement') {
      const element = record as typeof record & {
        readonly value?: { readonly cooked?: string | null };
      };
      values.push(`template:${JSON.stringify(element.value?.cooked ?? null)}`);
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && typeof child.type === 'string') {
            visit(child as Node);
          }
        }
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value as Node);
      }
    }
  };
  visit(root);
  return JSON.stringify(values);
}

function preserveTokenLineCount(encoded: string, original: string): string {
  const terminators = lineTerminators(original);
  if (terminators.length === 0) return encoded;
  return encoded.slice(0, -1) + terminators.map((ending) => `\\${ending}`).join('') +
    encoded.slice(-1);
}

function encodeStringLiteral(value: string, original: string): string {
  const encoded = JSON.stringify(value)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return preserveTokenLineCount(escapeCensoredText(encoded), original);
}

function encodeTemplateElement(value: string, original: string): string {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (character === '\\') encoded += '\\\\';
    else if (character === '`') encoded += '\\`';
    else if (character === '$' && next === '{') encoded += '\\$';
    else if (character === '\n') encoded += '\\n';
    else if (character === '\r') encoded += '\\r';
    else if (character === '\u2028') encoded += '\\u2028';
    else if (character === '\u2029') encoded += '\\u2029';
    else if (character < ' ') {
      encoded += `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
    } else encoded += character;
  }
  const terminators = lineTerminators(original);
  return escapeCensoredText(encoded) + terminators.map((ending) => `\\${ending}`).join('');
}

function sanitizeLearnerSource(source: string): string {
  const comments: Comment[] = [];
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
    onComment: comments,
  });
  const replacements: SourceReplacement[] = comments.map((comment) => ({
    start: comment.start,
    end: comment.end,
    text: maskComment(source.slice(comment.start, comment.end)),
  }));
  const taggedTemplateElements = new Set<Node>();

  const visit = (node: Node): void => {
    const record = node as Node & Record<string, unknown>;
    if (node.type === 'TaggedTemplateExpression') {
      const quasi = record.quasi as (Node & { readonly quasis?: readonly Node[] }) | undefined;
      for (const element of quasi?.quasis ?? []) taggedTemplateElements.add(element);
    }
    if (node.type === 'CallExpression') {
      const callee = record.callee as (Node & { readonly name?: string }) | undefined;
      if (callee?.type === 'Identifier' && callee.name === 'eval') {
        throw learnerRestriction('direct eval is not supported.', callee.loc?.start.line);
      }
    }
    if (node.type === 'ImportExpression') {
      throw learnerRestriction('dynamic import is not supported.', node.loc?.start.line);
    }
    if (node.type === 'Literal') {
      const literal = record as typeof record & {
        readonly value?: unknown;
        readonly regex?: unknown;
      };
      if (literal.regex) {
        const raw = source.slice(node.start, node.end);
        if (escapeCensoredText(raw) !== raw) {
          throw learnerRestriction(
            'regular-expression source contains a source-censored token sequence.',
            node.loc?.start.line
          );
        }
      } else if (typeof literal.value === 'string') {
        const raw = source.slice(node.start, node.end);
        if (escapeCensoredText(raw) !== raw) {
          replacements.push({
            start: node.start,
            end: node.end,
            text: encodeStringLiteral(literal.value, raw),
          });
        }
      }
    }
    if (node.type === 'TemplateElement') {
      const element = record as typeof record & {
        readonly value?: { readonly cooked?: string | null };
      };
      const raw = source.slice(node.start, node.end);
      if (escapeCensoredText(raw) !== raw) {
        if (taggedTemplateElements.has(node)) {
          throw learnerRestriction(
            'tagged template raw text contains a source-censored token sequence.',
            node.loc?.start.line
          );
        }
        if (typeof element.value?.cooked !== 'string') {
          throw learnerRestriction(
            'template text could not be normalized safely.',
            node.loc?.start.line
          );
        }
        replacements.push({
          start: node.start,
          end: node.end,
          text: encodeTemplateElement(element.value.cooked, raw),
        });
      }
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && typeof child.type === 'string') {
            visit(child as Node);
          }
        }
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value as Node);
      }
    }
  };
  visit(ast);

  let sanitized = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    sanitized = sanitized.slice(0, replacement.start) + replacement.text + sanitized.slice(replacement.end);
  }
  const censoredIndex = sanitized.search(/<!--|-->/u);
  if (censoredIndex >= 0) {
    const line = sanitized.slice(0, censoredIndex).split(/\r\n?|\n|\u2028|\u2029/u).length;
    throw learnerRestriction('HTML comment tokens are not supported.', line);
  }
  const importIndex = sanitized.search(/(^|[^.]|\.\.\.)\bimport\s*(?:\(|\/[/*])/u);
  if (importIndex >= 0) {
    const line = sanitized.slice(0, importIndex).split(/\r\n?|\n|\u2028|\u2029/u).length;
    throw learnerRestriction('dynamic import-like source is not supported.', line);
  }
  let normalizedAst: Node;
  try {
    normalizedAst = parse(sanitized, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
  } catch (error) {
    throw new SourceNormalizationInvariantError(
      'SES source normalization produced invalid JavaScript.',
      { cause: error }
    );
  }
  if (
    normalizationFingerprint(normalizedAst) !== normalizationFingerprint(ast) ||
    lineTerminators(sanitized).length !== lineTerminators(source).length
  ) {
    throw new SourceNormalizationInvariantError(
      'SES source normalization changed learner literal values or line structure.'
    );
  }
  try {
    parse(`async function __tracecodeStrictProbe__() {\n"use strict";\n${sanitized}\n}`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      locations: true,
    });
  } catch (error) {
    const location = (error as { loc?: { line?: number } }).loc;
    const learnerLine = typeof location?.line === 'number'
      ? Math.max(1, location.line - 2)
      : undefined;
    const detail = (error instanceof Error ? error.message : safeErrorText(error))
      .replace(/\s*\(\d+:\d+\)\s*$/u, '');
    throw learnerRestriction(`JavaScript must be strict-compatible. ${detail}`, learnerLine);
  }
  return sanitized;
}

function collectCustomMaterializerNames(materializers: Readonly<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 32) return;
    const descriptor = value as {
      readonly kind?: unknown;
      readonly typeName?: unknown;
      readonly element?: unknown;
      readonly value?: unknown;
    };
    if (
      descriptor.kind === 'custom' &&
      typeof descriptor.typeName === 'string' &&
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(descriptor.typeName)
    ) {
      names.add(descriptor.typeName);
    }
    visit(descriptor.element, depth + 1);
    visit(descriptor.value, depth + 1);
  };
  for (const descriptor of Object.values(materializers)) visit(descriptor, 0);
  return [...names].sort();
}

function trustedConstructorRegistrySource(source: PreparedSource): string {
  const entries = collectCustomMaterializerNames(source.materializers).map((typeName) => {
    const [root, ...properties] = typeName.split('.');
    if (!root || !isSafeSelector(root)) return `${JSON.stringify(typeName)}: undefined`;
    const expression = properties.reduce(
      (current, property) => `${current}?.${property}`,
      root
    );
    return `${JSON.stringify(typeName)}: ` +
      `(typeof ${root} !== 'undefined' && typeof ${expression} === 'function' ` +
      `? ${expression} : undefined)`;
  });
  return `globalThis.__tracecodeConstructors = Object.freeze({${entries.join(',')}});`;
}

function learnerBody(source: PreparedSource, code: string): string {
  const targetIdentifier = source.executionStyle === 'solution-method'
    ? 'Solution'
    : source.functionName;
  return `${code}\n;${trustedConstructorRegistrySource(source)}\n` +
    `globalThis.__tracecodeTarget = ` +
    `typeof ${targetIdentifier} === 'undefined' ? undefined : ${targetIdentifier};`;
}

function traceMaxPathDepth(source: PreparedSource): number {
  const value = source.traceOptions?.maxPathDepth;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(8, Math.max(1, Math.floor(value)))
    : 3;
}

function learnerFactorySource(
  source: PreparedSource,
  code: string,
  tracing = false
): string {
  const tracePrelude = tracing
    ? `const __TRACE_V4_MAX_PATH_DEPTH = ${traceMaxPathDepth(source)};\n` +
      `${__TRACECODE_TRACE_RUNTIME_HELPERS_SOURCE__}\n`
    : '';
  const parameters = tracing ? '__traceRecorder, __traceCtx' : '';
  return `(async (${parameters}) => {\n"use strict";\n${tracePrelude}${learnerBody(source, code)}\n})` +
    '\n//# sourceURL=tracecode-ses-learner.js';
}

function assertSesSourceAdmissible(source: string): void {
  if (/<!--|-->/u.test(source) ||
      /(^|[^.]|\.\.\.)\bimport\s*(?:\(|\/[/*])/u.test(source)) {
    throw new SourceNormalizationInvariantError(
      'SES source normalization left a mandatory-censorship token in executable source.'
    );
  }
}

const LIBRARY_GLOBAL_NAMES = [
  '__TRACECODE_JAVASCRIPT_LIBRARIES__',
  'require',
  '_',
  'lodash',
  'Deque',
  'DoublyLinkedList',
  'DoublyLinkedListNode',
  'EnhancedSet',
  'Heap',
  'LinkedList',
  'LinkedListNode',
  'MaxHeap',
  'MaxPriorityQueue',
  'MinHeap',
  'MinPriorityQueue',
  'PriorityQueue',
  'Queue',
  'Stack',
] as const;

const LODASH_CONTEXT_NAMES = [
  'Array', 'Buffer', 'DataView', 'Date', 'Error', 'Float32Array',
  'Float64Array', 'Function', 'Int8Array', 'Int16Array', 'Int32Array',
  'Map', 'Math', 'Object', 'Promise', 'RegExp', 'Set', 'String', 'Symbol',
  'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array',
  'Uint32Array', 'WeakMap', 'clearTimeout', 'isFinite', 'parseInt',
  'setTimeout',
] as const;

function buildLibraryEndowments(): Readonly<Record<string, unknown>> | undefined {
  if (javascriptLibrariesSource.length === 0) return undefined;
  assertSesSourceAdmissible(javascriptLibrariesSource);
  const compartment = new Compartment();
  const librarySource: PreparedSource = {
    mode: 'code',
    language: 'javascript',
    code: 'Math Date',
    functionName: '__tracecodeLibraryProbe',
    executionStyle: 'function',
    requiredModules: ['lodash'],
    inputArguments: [],
    materializers: {},
  };
  compartment.evaluate(deterministicCapabilityPrelude(librarySource));
  compartment.evaluate(`var global = globalThis; var self = globalThis;\n${javascriptLibrariesSource}`);
  const endowments = Object.fromEntries(LIBRARY_GLOBAL_NAMES.map((name) => [
    name,
    compartment.globalThis[name],
  ]));
  harden(compartment.globalThis);
  return harden(endowments) as Readonly<Record<string, unknown>>;
}

function moduleBootstrapSource(source: PreparedSource): string {
  if (source.requiredModules.length > 0 && !javascriptLibraryEndowments) {
    throw new Error('JavaScript library runtime asset is unavailable.');
  }
  const requireBootstrap = source.requiredModules.length === 0
    ? `const require = (specifier) => {
      throw new Error('Cannot find module "' + specifier + '"');
    };`
    : '';
  return `(() => {
    const module = { exports: {} };
    ${requireBootstrap}
    Object.defineProperties(globalThis, {
      ${source.requiredModules.length === 0 ? `require: {
        value: Object.freeze(require),
        writable: false,
        enumerable: false,
        configurable: false,
      },` : ''}
      module: { value: module, writable: true, configurable: true },
      exports: { value: module.exports, writable: true, configurable: true },
    });
  })()`;
}

function compartmentBaseEndowmentsFor(
  requiredModules: readonly string[]
): Readonly<Record<string, unknown>> {
  if (requiredModules.length === 0) return safeHostEndowments;
  const shared = javascriptLibraryEndowments;
  if (!shared) {
    throw new Error('JavaScript library runtime asset is unavailable.');
  }
  const libraryGlobals = Object.fromEntries(Object.entries(shared).filter(([name]) =>
    name !== '__TRACECODE_JAVASCRIPT_LIBRARIES__' &&
    name !== 'require' &&
    name !== '_' &&
    name !== 'lodash'
  ));
  return harden({
    ...safeHostEndowments,
    ...libraryGlobals,
  });
}

function installCaseLibraries(
  compartment: Compartment,
  requiredModules: readonly string[]
): void {
  if (requiredModules.length === 0) return;
  const shared = javascriptLibraryEndowments;
  const sharedModules = shared?.__TRACECODE_JAVASCRIPT_LIBRARIES__;
  const sharedLodash = shared?.lodash;
  if (!shared || !sharedModules || typeof sharedModules !== 'object') {
    throw new Error('JavaScript library runtime asset has an invalid module surface.');
  }
  const usesLodash = requiredModules.includes('lodash') ||
    requiredModules.includes('lodash.js');
  let lodash: unknown;
  if (usesLodash) {
    if (
      typeof sharedLodash !== 'function' ||
      typeof (sharedLodash as { runInContext?: unknown }).runInContext !== 'function'
    ) {
      throw new Error('JavaScript library runtime has no lodash factory.');
    }
    // Lodash keeps counters and timing state in the closure created by
    // runInContext. Every context value is taken from this fresh case realm;
    // most importantly, lodash template compilation receives this case's
    // Function rather than the retained library realm's evaluator.
    const lodashContext = harden(Object.fromEntries(
      LODASH_CONTEXT_NAMES.map((name) => [name, compartment.globalThis[name]])
    ));
    lodash = (sharedLodash as unknown as {
      runInContext(context: Readonly<Record<string, unknown>>): unknown;
    }).runInContext(lodashContext);
    if (typeof lodash !== 'function') {
      throw new Error('JavaScript library runtime could not create case-local lodash.');
    }
    if (!Reflect.deleteProperty(lodash, 'runInContext')) {
      throw new Error('JavaScript library runtime could not disable retained-context access.');
    }
  }

  const sharedModuleMap = sharedModules as Record<string, unknown>;
  const modules = Object.freeze(Object.fromEntries(requiredModules.map((specifier) => [
    specifier,
    specifier === 'lodash' || specifier === 'lodash.js'
      ? lodash
      : sharedModuleMap[specifier],
  ]))) as Readonly<Record<string, unknown>>;
  const require = harden((specifier: string): unknown => {
    if (Object.hasOwn(modules, specifier)) {
      return modules[specifier];
    }
    throw new Error(`Cannot find module '${specifier}'`);
  });
  Object.defineProperties(compartment.globalThis, {
    __TRACECODE_JAVASCRIPT_LIBRARIES__: {
      value: modules, writable: false, enumerable: false, configurable: false,
    },
    require: { value: require, writable: false, enumerable: false, configurable: false },
    ...(usesLodash ? {
      _: { value: lodash, writable: true, enumerable: false, configurable: true },
      lodash: { value: lodash, writable: true, enumerable: false, configurable: true },
    } : {}),
  });
}

function compileLearnerFactory(
  compartment: Compartment,
  source: PreparedSource,
  sanitizedCode: string,
  tracing = false
): string {
  const factorySource = learnerFactorySource(source, sanitizedCode, tracing);
  assertSesSourceAdmissible(factorySource);
  const execute = compartment.evaluate(factorySource, {
    __rejectSomeDirectEvalExpressions__: false,
  });
  if (typeof execute !== 'function') {
    throw new Error('SES learner source did not compile to a callable program.');
  }
  return factorySource;
}

function validateInfrastructure(): void {
  const compartment = new Compartment();
  const takeConsole = compartment.evaluate(CONSOLE_BOOTSTRAP_SOURCE);
  if (typeof takeConsole !== 'function') {
    throw new Error('SES console bootstrap did not compile to a snapshot function.');
  }
  const infrastructureSource: PreparedSource = {
    mode: 'code',
    language: 'javascript',
    code: 'function __tracecodeInfrastructureProbe() { return null; }',
    functionName: '__tracecodeInfrastructureProbe',
    executionStyle: 'function',
    requiredModules: [],
    inputArguments: [],
    materializers: {},
  };
  const driver = compartment.evaluate(DRIVER_SOURCE);
  if (typeof driver !== 'function') {
    throw new Error('SES driver did not compile to a function.');
  }
  compartment.evaluate(deterministicCapabilityPrelude({
    ...infrastructureSource,
    code: 'Math Date',
  }));
  compartment.evaluate(RUNTIME_BOOTSTRAP_SOURCE);
  compartment.evaluate(moduleBootstrapSource(infrastructureSource));
  compileLearnerFactory(
    compartment,
    infrastructureSource,
    sanitizeLearnerSource(infrastructureSource.code)
  );

  const traceRuntimeCompartment = new Compartment();
  const recorderFactory = traceRuntimeCompartment.evaluate(
    `(() => {\n${__TRACECODE_TRACE_RUNTIME_SUPPORT_SOURCE__}\nreturn createTraceRecorder;\n})()`
  );
  if (typeof recorderFactory !== 'function') {
    throw new Error('SES trace recorder runtime did not compile to a function.');
  }
  createFastTraceRecorder = recorderFactory as typeof createFastTraceRecorder;
}

async function executeCase(
  program: PreparedProgram,
  inputs: Record<string, unknown>,
  tracingEnabled = program.mode === 'trace'
): Promise<unknown> {
  const startedAt = performance.now();
  const tracing = program.mode === 'trace' && tracingEnabled;
  const compartment = new Compartment(
    compartmentBaseEndowmentsFor(program.requiredModules)
  );
  const takeConsole = compartment.evaluate(CONSOLE_BOOTSTRAP_SOURCE) as unknown;
  if (typeof takeConsole !== 'function') {
    throw new Error('SES compartment returned an invalid console snapshot function.');
  }
  const snapshotConsole = (): { lines: string[]; budgetExceeded: boolean } => {
    const serialized = takeConsole();
    if (typeof serialized !== 'string') {
      throw new Error('SES console snapshot was not serialized.');
    }
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' ||
        !Array.isArray((parsed as { lines?: unknown }).lines) ||
        (parsed as { lines: unknown[] }).lines.some((line) => typeof line !== 'string') ||
        typeof (parsed as { budgetExceeded?: unknown }).budgetExceeded !== 'boolean') {
      throw new Error('SES console snapshot had an invalid shape.');
    }
    return parsed as { lines: string[]; budgetExceeded: boolean };
  };
  const consoleResult = (elapsedMs: number):
    | { lines: string[]; compatibilityRequired: false }
    | { compatibilityRequired: true; result: unknown } => {
    const snapshot = snapshotConsole();
    if (!snapshot.budgetExceeded) {
      return { lines: snapshot.lines, compatibilityRequired: false };
    }
    return {
      compatibilityRequired: true,
      result: {
        kind: 'failed',
        error: SES_CONSOLE_COMPATIBILITY_REQUIRED,
        diagnosticStage: 'runtime',
        consoleOutput: snapshot.lines,
        timings: {
          totalMs: elapsedMs,
          runMs: elapsedMs,
          artifactCacheHit: true,
          algorithmFastBatch: true,
        },
      },
    };
  };
  const emptyTrace = () => ({
    schemaVersion: 'runtime-trace-2026-04-28',
    language: program.language,
    runId: typeof program.traceOptions?.runId === 'string'
      ? program.traceOptions.runId
      : `${program.language}:run`,
    events: [],
    lineEventCount: 0,
    traceStepCount: 0,
  });
  const recorder = tracing
    ? createFastTraceRecorder?.(program.traceOptions)
    : undefined;
  if (tracing && !recorder) {
    throw new Error('SES trace recorder runtime is unavailable.');
  }
  if (recorder) harden(recorder);
  const snapshotTrace = (): Record<string, unknown> => {
    if (!recorder) return emptyTrace();
    const getRuntimeTrace = recorder.getRuntimeTrace;
    if (typeof getRuntimeTrace !== 'function') {
      throw new Error('SES trace recorder returned an invalid runtime surface.');
    }
    const runId = typeof program.traceOptions?.runId === 'string'
      ? program.traceOptions.runId
      : `${program.language}:run`;
    const file = typeof program.traceOptions?.file === 'string'
      ? program.traceOptions.file
      : program.language === 'typescript' ? 'solution.ts' : 'solution.js';
    return getRuntimeTrace(program.language, runId, file) as Record<string, unknown>;
  };
  const runtimeFailure = (error: unknown, elapsedMs: number): unknown => {
    const tracedErrorLine = error && typeof error === 'object' &&
      Number.isFinite((error as { readonly __traceLine?: unknown }).__traceLine)
        ? Number((error as { readonly __traceLine: number }).__traceLine)
        : undefined;
    const errorLine = tracedErrorLine ?? learnerErrorLine(error);
    const console = consoleResult(elapsedMs);
    if (console.compatibilityRequired) return console.result;
    const traceLimitExceeded = Boolean(
      error && typeof error === 'object' &&
      (error as { readonly __traceLimitExceeded?: unknown }).__traceLimitExceeded === true
    );
    const timeoutReason = error && typeof error === 'object' &&
      typeof (error as { readonly __timeoutReason?: unknown }).__timeoutReason === 'string'
        ? (error as { readonly __timeoutReason: string }).__timeoutReason
        : typeof recorder?.getTimeoutReason === 'function'
          ? recorder.getTimeoutReason()
          : undefined;
    if (recorder && !traceLimitExceeded && typeof recorder.recordException === 'function') {
      const traceErrorLine = error && typeof error === 'object' &&
        Number.isFinite((error as { readonly __traceLine?: unknown }).__traceLine)
          ? Number((error as { readonly __traceLine: number }).__traceLine)
          : errorLine ?? program.traceLineBounds?.endLine ?? 1;
      recorder.recordException(traceErrorLine, safeErrorText(error), program.functionName);
    }
    const base = {
      kind: 'failed',
      error: safeErrorText(error),
      ...(errorLine !== undefined ? { errorLine } : {}),
      diagnosticStage: 'runtime',
      consoleOutput: console.lines,
      timings: {
        totalMs: elapsedMs,
        runMs: elapsedMs,
        artifactCacheHit: true,
        algorithmFastBatch: true,
      },
    };
    if (program.mode !== 'trace') return base;
    const trace = snapshotTrace();
    return timeoutReason
      ? {
          ...base,
          kind: 'limit',
          reason: timeoutReason,
          trace,
          executionTimeMs: elapsedMs,
        }
      : { ...base, trace, executionTimeMs: elapsedMs };
  };
  compartment.evaluate(program.capabilityBootstrapSource);
  installCaseLibraries(compartment, program.requiredModules);
  compartment.evaluate(
    `${CASE_RUNTIME_BOUNDARY_SOURCE};\n${RUNTIME_BOOTSTRAP_SOURCE};\n${program.moduleBootstrapSource}`
  );
  const driver = compartment.evaluate(DRIVER_SOURCE);
  if (typeof driver !== 'function') {
    throw new Error('SES compartment returned a non-callable driver.');
  }
  const learnerFactorySource = tracing
    ? program.traceLearnerFactorySource
    : program.codeLearnerFactorySource;
  if (typeof learnerFactorySource !== 'string') {
    throw new Error('SES prepared program has no requested learner artifact.');
  }
  const executeLearner = compartment.evaluate(learnerFactorySource, {
    __rejectSomeDirectEvalExpressions__: false,
  });
  if (typeof executeLearner !== 'function') {
    throw new Error('SES compartment returned a non-callable learner program.');
  }
  try {
    await executeLearner(
      ...(tracing ? [recorder, { functionName: program.functionName }] : [])
    );
  } catch (error) {
    return runtimeFailure(error, performance.now() - startedAt);
  }
  let serialized: unknown;
  try {
    serialized = await driver(
      JSON.stringify(inputs),
      JSON.stringify(program.inputArguments),
      JSON.stringify(program.materializers),
      program.functionName,
      program.executionStyle
    );
  } catch (error) {
    return runtimeFailure(error, performance.now() - startedAt);
  }
  if (typeof serialized !== 'string') {
    throw new Error('SES compartment returned a non-serializable result.');
  }
  const result = JSON.parse(serialized) as {
    success?: boolean;
    output?: unknown;
    error?: string;
    errorLine?: number;
  };
  const elapsedMs = performance.now() - startedAt;
  const console = consoleResult(elapsedMs);
  if (console.compatibilityRequired) return console.result;
  const consoleOutput = console.lines;
  if (!result.success) {
    const errorLine = Number.isSafeInteger(result.errorLine) && result.errorLine! > 0
      ? result.errorLine
      : undefined;
    const base = {
      kind: 'failed',
      error: result.error ?? 'SES compartment execution failed.',
      ...(errorLine !== undefined ? { errorLine } : {}),
      diagnosticStage: 'runtime',
      consoleOutput,
      timings: {
        totalMs: elapsedMs,
        runMs: elapsedMs,
        artifactCacheHit: true,
        algorithmFastBatch: true,
      },
    };
    return program.mode === 'trace'
      ? { ...base, trace: snapshotTrace(), executionTimeMs: elapsedMs }
      : base;
  }
  const output = decodeOutputTransport(result.output);
  if (output === OUTPUT_TRANSPORT_HOLE) {
    throw new Error('SES compartment returned a top-level output transport hole.');
  }
  const completed = {
    kind: 'completed',
    output: output ?? null,
    consoleOutput,
    timings: {
      totalMs: elapsedMs,
      runMs: elapsedMs,
      artifactCacheHit: true,
      algorithmFastBatch: true,
    },
  };
  if (program.mode !== 'trace') return completed;
  const trace = snapshotTrace();
  const traceLimitExceeded = typeof recorder?.isTraceLimitExceeded === 'function' &&
    recorder.isTraceLimitExceeded() === true;
  const timeoutReason = typeof recorder?.getTimeoutReason === 'function'
    ? recorder.getTimeoutReason()
    : undefined;
  return {
    ...completed,
    trace,
    executionTimeMs: elapsedMs,
    ...(traceLimitExceeded
      ? { traceTruncated: typeof timeoutReason === 'string' ? timeoutReason : 'trace-limit' }
      : {}),
  };
}

function isHardenedWorkerRealm(): boolean {
  if (!Object.isFrozen(Object.prototype) || !Object.isFrozen(Function.prototype)) {
    return false;
  }
  try {
    const compartment = new Compartment();
    return compartment.evaluate(`(() => {
      if (!Object.isFrozen(Object.prototype)) return false;
      try { Math.random(); return false; } catch { return true; }
    })()`) === true;
  } catch {
    return false;
  }
}

async function assertIntegrity(bytes: ArrayBuffer, integrity: string): Promise<void> {
  const algorithms = new Map([
    ['sha256', 'SHA-256'],
    ['sha384', 'SHA-384'],
    ['sha512', 'SHA-512'],
  ]);
  const candidates = integrity.trim().split(/\s+/u).flatMap((token) => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(token);
    return match && match[1] && match[2]
      ? [{ algorithm: match[1], expected: match[2] }]
      : [];
  });
  if (candidates.length === 0) {
    throw new Error('JavaScript libraries integrity has no supported SRI token.');
  }
  for (const candidate of candidates) {
    const digest = await crypto.subtle.digest(algorithms.get(candidate.algorithm)!, bytes);
    const actual = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if (actual === candidate.expected) return;
  }
  throw new Error('JavaScript libraries failed declared integrity verification.');
}

async function initialize(
  librariesUrl?: string,
  librariesIntegrity?: string
): Promise<{ mode: string; hardened: boolean }> {
  const hardened = isHardenedWorkerRealm();
  if ((WORKER_MODE === 'ses') !== hardened) {
    throw new Error(`SES Worker hardening attestation failed for ${WORKER_MODE} artifact.`);
  }
  if (initialized) return { mode: WORKER_MODE, hardened };
  javascriptLibrariesUrl = librariesUrl;
  javascriptLibrariesIntegrity = librariesIntegrity;
  validateInfrastructure();
  initialized = true;
  return { mode: WORKER_MODE, hardened };
}

async function ensureJavascriptLibraries(): Promise<void> {
  if (javascriptLibraryEndowments) return;
  if (!javascriptLibrariesLoad) {
    javascriptLibrariesLoad = (async () => {
      const workerUrl = new URL(self.location.href);
      const workerSegments = workerUrl.pathname.split('/');
      const isCanonicalLanguageDirectory =
        workerSegments[workerSegments.length - 2] === 'javascript';
      const librariesUrl = javascriptLibrariesUrl ?? new URL(
        `${isCanonicalLanguageDirectory ? '../' : './'}vendor/javascript-libraries.js`,
        workerUrl
      ).toString();
      const response = await fetch(librariesUrl);
    if (!response.ok) {
      throw new Error(`Failed to load JavaScript libraries: HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    if (javascriptLibrariesIntegrity) {
      await assertIntegrity(bytes, javascriptLibrariesIntegrity);
    }
    javascriptLibrariesSource = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    javascriptLibraryEndowments = buildLibraryEndowments();
      if (!javascriptLibraryEndowments) {
        throw new Error('JavaScript library runtime asset produced no module surface.');
      }
    })();
  }
  try {
    await javascriptLibrariesLoad;
  } catch (error) {
    // A transient asset failure must not poison this retained lane forever.
    javascriptLibrariesLoad = undefined;
    throw error;
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!data || typeof data !== 'object') {
    fail(-1, new Error('SES worker control envelope must be an object.'));
    return;
  }
  const candidate = data as Partial<WorkerRequest>;
  if (!Number.isSafeInteger(candidate.id)) {
    fail(-1, new Error('SES worker control envelope has an invalid request id.'));
    return;
  }
  const request = candidate as WorkerRequest;
  const requestId = request.id;
  void (async () => {
    switch (request.type) {
      case 'init':
        reply(request.id, await initialize(
          request.javascriptLibrariesUrl,
          request.javascriptLibrariesIntegrity
        ));
        return;
      case 'prepare': {
        if (!initialized) throw new Error('SES worker has not been initialized.');
        if (!request.programId || !request.source) {
          throw new Error('SES prepare request is incomplete.');
        }
        assertPreparedShape(request.source);
        const validationCompartment = new Compartment();
        let sanitizedLearnerSource: string;
        let sanitizedTraceSource: string | undefined;
        try {
          assertAdmittedModules(request.source);
          sanitizedLearnerSource = sanitizeLearnerSource(request.source.code);
          sanitizedTraceSource = request.source.mode === 'trace'
            ? sanitizeLearnerSource(request.source.instrumentedCode!)
            : undefined;
        } catch (error) {
          if (error instanceof SourceNormalizationInvariantError) throw error;
          fail(request.id, error, 'compile');
          return;
        }
        if (request.source.requiredModules.length > 0) {
          try {
            await ensureJavascriptLibraries();
          } catch (error) {
            fail(request.id, error, 'control');
            return;
          }
        }
        let validatedCodeLearnerFactorySource: string;
        let validatedTraceLearnerFactorySource: string | undefined;
        try {
          validatedCodeLearnerFactorySource = compileLearnerFactory(
            validationCompartment,
            request.source,
            sanitizedLearnerSource
          );
          validatedTraceLearnerFactorySource = sanitizedTraceSource === undefined
            ? undefined
            : compileLearnerFactory(
                validationCompartment,
                request.source,
                sanitizedTraceSource,
                true
              );
        } catch (error) {
          if (!isLearnerEngineSyntaxError(error)) throw error;
          fail(request.id, error, 'compile');
          return;
        }
        programs.set(request.programId, {
          mode: request.source.mode,
          language: request.source.language,
          codeLearnerFactorySource: validatedCodeLearnerFactorySource,
          ...(validatedTraceLearnerFactorySource === undefined
            ? {}
            : { traceLearnerFactorySource: validatedTraceLearnerFactorySource }),
          capabilityBootstrapSource: deterministicCapabilityPrelude(request.source),
          moduleBootstrapSource: moduleBootstrapSource(request.source),
          functionName: request.source.functionName,
          executionStyle: request.source.executionStyle,
          inputArguments: request.source.inputArguments,
          materializers: request.source.materializers,
          requiredModules: Object.freeze([...request.source.requiredModules]),
          ...(request.source.traceLineBounds
            ? { traceLineBounds: Object.freeze({ ...request.source.traceLineBounds }) }
            : {}),
          ...(request.source.traceOptions
            ? { traceOptions: Object.freeze({ ...request.source.traceOptions }) }
            : {}),
        });
        reply(request.id, null);
        return;
      }
      case 'execute-batch': {
        if (!initialized) throw new Error('SES worker has not been initialized.');
        if (!request.programId || !request.inputBatch) {
          throw new Error('SES execute request is incomplete.');
        }
        const program = programs.get(request.programId);
        if (!program) throw new Error('Unknown SES prepared program.');
        const traceSelection = request.traceEnabledBatch ??
          request.inputBatch.map(() => program.mode === 'trace');
        if (
          traceSelection.length !== request.inputBatch.length ||
          traceSelection.some((enabled) => typeof enabled !== 'boolean')
        ) {
          throw new Error('SES trace selection must contain one boolean per batch case.');
        }
        const results = [];
        for (let index = 0; index < request.inputBatch.length; index += 1) {
          results.push(await executeCase(
            program,
            request.inputBatch[index]!,
            traceSelection[index]
          ));
        }
        reply(request.id, results);
        return;
      }
      case 'ping':
        if (!initialized) throw new Error('SES worker has not been initialized.');
        reply(request.id, null);
        return;
      case 'dispose-program':
        if (request.programId) programs.delete(request.programId);
        reply(request.id, null);
        return;
      default:
        throw new Error('SES worker request type is invalid.');
    }
  })().catch((error) => fail(requestId, error));
};
