const CHEERPJ_LOADER_URL = 'https://cjrtnc.leaningtech.com/4.2/loader.js';
const HELPER_JAR_PATH = '/app/workers/vendor/java-browser-helper.jar';
const JDK17_COMPILER_JAR_PATH = '/app/workers/vendor/jdk.compiler-17.jar';
const REWRITER_JAR_PATH = '/app/workers/vendor/java-rewriter.jar';
const JAVAPARSER_JAR_PATH = '/app/workers/vendor/javaparser-core-3.25.10.jar';
const FULL_CLASSPATH = [
  HELPER_JAR_PATH,
  JDK17_COMPILER_JAR_PATH,
  REWRITER_JAR_PATH,
  JAVAPARSER_JAR_PATH,
].join(':');
const DEFAULT_COMPILER_DEBUG_PROFILE = 'full';
const DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE = 'none';
const DEFAULT_MAX_STORED_EVENTS = 50_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const SCRIPT_METHOD_NAME = '__tracecodeScript';
const DYNAMIC_INPUT_PREFIX = '/str/tracecode-java-input';
const JAVA_DEFAULT_IMPORTS = [
  'import java.util.*;',
  'import java.io.*;',
  'import java.math.*;',
  'import java.util.stream.*;',
  'import javafx.util.Pair;',
];
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
    component: 'JavaWorker',
    runtime: 'java',
    phase,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

if (typeof self.importScripts === 'function') {
  self.importScripts('java-source-augmentations.js');
}

let workerReadyPromise = null;
let idleTimer = null;
let queue = Promise.resolve();
let helperLibraryPromise = null;
let compileLibraryClassPromise = null;
let rewriteLibraryClassPromise = null;
let idleGeneration = 0;
let initLoadTimeMs = null;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
let runWarmupPromise = null;
let activeJavaProjectIo = null;

function postMessageResponse(message) {
  self.postMessage(message);
}

function emitLiveJavaProjectOutput(stream, data) {
  if (!activeJavaProjectIo?.messageId || typeof data !== 'string' || data.length === 0) return;
  const normalizedStream = stream === 'stderr' ? 'stderr' : 'stdout';
  if (normalizedStream === 'stderr') {
    activeJavaProjectIo.stderrEmitted = true;
  } else {
    activeJavaProjectIo.stdoutEmitted = true;
  }
  postProjectEvent(activeJavaProjectIo.messageId, {
    type: 'output',
    stream: normalizedStream,
    device: normalizedStream === 'stderr' ? '/dev/stderr' : '/dev/stdout',
    data,
  });
}

function emitLiveJavaProjectFileSnapshot(path, contents) {
  if (!activeJavaProjectIo?.messageId || typeof path !== 'string' || path.length === 0 || typeof contents !== 'string') {
    return;
  }
  postProjectEvent(activeJavaProjectIo.messageId, {
    type: 'file-change',
    phase: 'live',
    change: {
      path: normalizeProjectFilePath(path),
      contents,
      encoding: 'base64',
    },
  });
}

function emitLiveJavaProjectFileDelete(path) {
  if (!activeJavaProjectIo?.messageId || typeof path !== 'string' || path.length === 0) return;
  postProjectEvent(activeJavaProjectIo.messageId, {
    type: 'file-change',
    phase: 'live',
    change: {
      path: normalizeProjectFilePath(path),
      deleted: true,
    },
  });
}

function javaProjectNativeBridge() {
  return {
    Java_tracecode_browser_ProjectEvents_emitOutputNative: (_library, stream, data) => {
      emitLiveJavaProjectOutput(String(stream ?? 'stdout'), String(data ?? ''));
    },
    Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative: (_library, path, contents) => {
      emitLiveJavaProjectFileSnapshot(String(path ?? ''), String(contents ?? ''));
    },
    Java_tracecode_browser_ProjectEvents_emitFileDeleteNative: (_library, path) => {
      emitLiveJavaProjectFileDelete(String(path ?? ''));
    },
  };
}

function javaDefaultImportsBlock() {
  return JAVA_DEFAULT_IMPORTS.join('\n');
}

function addJavaDefaultImportsToPackagedSource(source) {
  const importBlock = javaDefaultImportsBlock();
  return String(source).replace(
    /^(package\s+[A-Za-z_][A-Za-z0-9_.]*\s*;\s*\n+)/,
    `$1${importBlock}\n`
  );
}

function formatWorkerErrorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (error && typeof error === 'object') {
    const directKeys = ['message', 'detail', 'reason', 'cause', 'stack', 'name', 'className'];
    for (const key of directKeys) {
      try {
        const value = error[key];
        if (typeof value === 'string' && value.length > 0) {
          return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
          return String(value);
        }
      } catch {}
    }
    try {
      const propertyNames = Object.getOwnPropertyNames(error);
      for (const key of propertyNames) {
        const value = error[key];
        if (typeof value === 'string' && value.length > 0) {
          return `${key}: ${value}`;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
          return `${key}: ${String(value)}`;
        }
      }
    } catch {}
    try {
      const tag = Object.prototype.toString.call(error);
      if (tag && tag.includes('ParseProblemException')) {
        return 'Java syntax error.';
      }
      if (tag && tag !== '[object Object]' && !tag.startsWith('[object ')) {
        return tag;
      }
    } catch {}
    try {
      if (typeof error.toString === 'function' && error.toString !== Object.prototype.toString) {
        const value = error.toString();
        if (value.includes('ParseProblemException')) {
          return 'Java syntax error.';
        }
        if (typeof value === 'string' && value.length > 0 && value !== '[object Object]') {
          return value;
        }
      }
    } catch {}
  }
  try {
    const stringified = String(error);
    if (stringified.includes('ParseProblemException')) {
      return 'Java syntax error.';
    }
    if (stringified && stringified !== '[object Object]') {
      return stringified;
    }
  } catch {}
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') {
      return json;
    }
  } catch {}
  return 'Unknown Java worker error';
}

function makeWorkerStageError(stage, error) {
  return new Error(`Java worker ${stage} failed: ${formatWorkerErrorMessage(error)}`);
}

function resetIdleTimer() {
  idleGeneration += 1;
  const generation = idleGeneration;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    if (generation !== idleGeneration) return;
    postMessageResponse({ type: 'idle-timeout' });
    self.close();
  }, idleTimeoutMs);
}

function applyWorkerOptions(payload) {
  const nextIdleTimeoutMs = Number(payload?.idleTimeoutMs);
  if (Number.isFinite(nextIdleTimeoutMs) && nextIdleTimeoutMs > 0) {
    idleTimeoutMs = Math.max(1_000, Math.floor(nextIdleTimeoutMs));
  }
}

function assertSupportedExecutionStyle(executionStyle) {
  if (executionStyle !== 'function' && executionStyle !== 'solution-method' && executionStyle !== 'ops-class') {
    throw new Error(`Java worker does not support execution style "${executionStyle}".`);
  }
}

function isScriptRequest(payload) {
  return typeof payload?.functionName !== 'string' || payload.functionName.trim().length === 0;
}

function resolveMaxStoredEvents(options = {}) {
  const fromStored = Number(options.maxStoredEvents);
  if (Number.isFinite(fromStored) && fromStored > 0) {
    return Math.floor(fromStored);
  }
  const fromTraceSteps = Number(options.maxTraceSteps);
  if (Number.isFinite(fromTraceSteps) && fromTraceSteps > 0) {
    return Math.floor(fromTraceSteps);
  }
  return DEFAULT_MAX_STORED_EVENTS;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isListNodeShape(value) {
  if (!isRecord(value)) return false;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (typeName && typeName !== 'ListNode' && typeName !== 'object') return false;
  if (!('val' in value || 'value' in value)) return false;
  if ('next' in value) return true;
  return typeof value.__id__ === 'string' && value.__id__.startsWith('list-');
}

function isTreeNodeShape(value) {
  if (!isRecord(value)) return false;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (typeName && typeName !== 'TreeNode' && typeName !== 'object') return false;
  if (!('val' in value || 'value' in value)) return false;
  if ('left' in value || 'right' in value) return true;
  return typeof value.__id__ === 'string' && value.__id__.startsWith('tree-');
}

function detectFeatures(source, input, options = {}) {
  const values = Object.values(input ?? {});
  return {
    hasList: /\bListNode\b/.test(source) || values.some((value) => isListNodeShape(value)),
    hasTree: /\bTreeNode\b/.test(source) || values.some((value) => isTreeNodeShape(value)),
    hasCustomObject: values.some((value) => containsCustomObjectLiteral(value)),
    hasMap: values.some((value) => containsPlainObjectLiteral(value)),
    hasDynamicInputs: options.hasDynamicInputs === true,
  };
}

function containsCustomObjectLiteral(value) {
  if (Array.isArray(value)) return value.some((entry) => containsCustomObjectLiteral(entry));
  if (!isRecord(value)) return false;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (typeName && typeName !== 'TreeNode' && typeName !== 'ListNode' && typeName !== 'object') return true;
  return Object.values(value).some((entry) => containsCustomObjectLiteral(entry));
}

function containsPlainObjectLiteral(value) {
  if (Array.isArray(value)) return value.some((entry) => containsPlainObjectLiteral(entry));
  if (!isRecord(value)) return false;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (!typeName) return true;
  if (typeName !== 'TreeNode' && typeName !== 'ListNode' && typeName !== 'object') return false;
  return Object.entries(value)
    .filter(([key]) => key !== '__type__' && key !== '__class__' && key !== '__id__')
    .some(([, entry]) => containsPlainObjectLiteral(entry));
}

function toJavaScalarLiteral(value) {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error(`Unsupported scalar literal: ${JSON.stringify(value)}`);
}

function toJavaScalarLiteralForType(value, expectedType) {
  const normalized = expectedType ? stripGenericType(expectedType) : null;
  if ((normalized === 'long' || normalized === 'Long') && typeof value === 'number' && Number.isInteger(value)) {
    return `${String(value)}L`;
  }
  if ((normalized === 'double' || normalized === 'Double') && typeof value === 'number') {
    return Number.isInteger(value) ? `${String(value)}.0` : String(value);
  }
  if ((normalized === 'float' || normalized === 'Float') && typeof value === 'number') {
    return `${Number.isInteger(value) ? `${String(value)}.0` : String(value)}f`;
  }
  if (normalized === 'char' && typeof value === 'string' && value.length === 1) {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  return toJavaScalarLiteral(value);
}

function toJavaArrayLiteral(value) {
  if (value.length === 0) return 'new int[] {}';
  if (value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))) {
    return `new int[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (value.every((entry) => typeof entry === 'number')) {
    return `new double[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (value.every((entry) => typeof entry === 'string')) {
    return `new String[] { ${value.map((entry) => JSON.stringify(entry)).join(', ')} }`;
  }
  if (value.every((entry) => Array.isArray(entry))) {
    return `new int[][] { ${value.map((entry) => toJavaArrayLiteral(entry)).join(', ')} }`;
  }
  throw new Error(`Unsupported array literal: ${JSON.stringify(value)}`);
}

function stripGenericType(typeSource) {
  return typeSource.replace(/\s+/g, '');
}

function extractTypeArguments(typeSource) {
  const normalized = stripGenericType(typeSource);
  const start = normalized.indexOf('<');
  const end = normalized.lastIndexOf('>');
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }

  const body = normalized.slice(start + 1, end);
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '<') depth += 1;
    if (ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function splitTopLevelCommaList(source) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of source) {
    if (ch === '<' || ch === '(' || ch === '[') depth += 1;
    if (ch === '>' || ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function normalizedJavaInputType(typeSource) {
  return String(typeSource || 'Object')
    .replace(/\bfinal\b/g, '')
    .replace(/\s+/g, '')
    .replace(/\.\.\.$/, '[]');
}

function isDynamicJavaScalarType(typeSource, value) {
  const normalized = normalizedJavaInputType(typeSource);
  if (
    ['byte', 'Byte', 'short', 'Short', 'int', 'Integer', 'long', 'Long', 'float', 'Float', 'double', 'Double'].includes(normalized)
  ) {
    return typeof value === 'number';
  }
  if (normalized === 'boolean' || normalized === 'Boolean') {
    return typeof value === 'boolean';
  }
  if (normalized === 'String') {
    return typeof value === 'string';
  }
  if (normalized === 'char' || normalized === 'Character') {
    return typeof value === 'string' && value.length === 1;
  }
  return false;
}

function isDynamicJavaInputType(typeSource, value) {
  const normalized = normalizedJavaInputType(typeSource);
  if (normalized.endsWith('[]')) {
    if (!Array.isArray(value)) return false;
    const elementType = normalized.slice(0, -2);
    return value.every((entry) => isDynamicJavaInputType(elementType, entry));
  }
  return isDynamicJavaScalarType(normalized, value);
}

function dynamicJavaInputExpression(typeSource, inputPath) {
  const normalized = normalizedJavaInputType(typeSource);
  const quotedPath = JSON.stringify(inputPath);
  if (normalized.endsWith('[]')) {
    return `((${normalized}) readJsonInput(${quotedPath}, ${normalized}.class))`;
  }
  if (normalized === 'byte' || normalized === 'Byte') return `((Number) readJsonInput(${quotedPath}, Byte.class)).byteValue()`;
  if (normalized === 'short' || normalized === 'Short') return `((Number) readJsonInput(${quotedPath}, Short.class)).shortValue()`;
  if (normalized === 'int' || normalized === 'Integer') return `((Number) readJsonInput(${quotedPath}, Integer.class)).intValue()`;
  if (normalized === 'long' || normalized === 'Long') return `((Number) readJsonInput(${quotedPath}, Long.class)).longValue()`;
  if (normalized === 'float' || normalized === 'Float') return `((Number) readJsonInput(${quotedPath}, Float.class)).floatValue()`;
  if (normalized === 'double' || normalized === 'Double') return `((Number) readJsonInput(${quotedPath}, Double.class)).doubleValue()`;
  if (normalized === 'boolean' || normalized === 'Boolean') return `((Boolean) readJsonInput(${quotedPath}, Boolean.class)).booleanValue()`;
  if (normalized === 'char' || normalized === 'Character') return `((Character) readJsonInput(${quotedPath}, Character.class)).charValue()`;
  if (normalized === 'String') return `((String) readJsonInput(${quotedPath}, String.class))`;
  return null;
}

function toJavaTypedArrayLiteral(value, expectedType) {
  const normalized = stripGenericType(expectedType);
  if (!normalized.endsWith('[]')) {
    return toJavaArrayLiteral(value);
  }

  const elementType = normalized.slice(0, -2);
  if (value.every((entry) => Array.isArray(entry))) {
    return `new ${normalized} { ${value
      .map((entry) => toJavaTypedArrayLiteral(entry, elementType))
      .join(', ')} }`;
  }

  if (elementType === 'int' && value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))) {
    return `new int[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (elementType === 'double' && value.every((entry) => typeof entry === 'number')) {
    return `new double[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (elementType === 'boolean' && value.every((entry) => typeof entry === 'boolean')) {
    return `new boolean[] { ${value.map((entry) => String(entry)).join(', ')} }`;
  }
  if (elementType === 'String' && value.every((entry) => typeof entry === 'string')) {
    return `new String[] { ${value.map((entry) => JSON.stringify(entry)).join(', ')} }`;
  }
  if (elementType === 'char' && value.every((entry) => typeof entry === 'string' && entry.length === 1)) {
    return `new char[] { ${value
      .map((entry) => `'${String(entry).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
      .join(', ')} }`;
  }
  if (elementType === 'long' && value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))) {
    return `new long[] { ${value.map((entry) => `${String(entry)}L`).join(', ')} }`;
  }
  if (elementType === 'Object') {
    return `new Object[] { ${value.map((entry) => buildJavaExpression(entry)).join(', ')} }`;
  }

  return `new ${normalized} { ${value.map((entry) => buildJavaExpression(entry, elementType)).join(', ')} }`;
}

function toJavaListLiteral(value, expectedType) {
  const [elementType = 'Object'] = extractTypeArguments(expectedType);
  return `new java.util.ArrayList<${elementType}>(java.util.Arrays.asList(${value.map((entry) => buildJavaExpression(entry, elementType)).join(', ')}))`;
}

function toJavaMapLiteral(value, expectedType) {
  const [keyType = 'String', valueType = 'Object'] = extractTypeArguments(expectedType);
  const entries = Object.entries(value)
    .map(([key, child]) => `new Object[] { ${buildJavaExpression(key, keyType)}, ${buildJavaExpression(child, valueType)} }`);
  return `typedMap(new Object[][] { ${entries.join(', ')} })`;
}

function toJavaObjectExpression(value) {
  if (Array.isArray(value)) {
    return `new java.util.ArrayList<Object>(java.util.Arrays.asList(${value.map((entry) => toJavaObjectExpression(entry)).join(', ')}))`;
  }
  if (isRecord(value)) {
    return toJavaDynamicObjectExpression(value);
  }
  return toJavaScalarLiteral(value);
}

function customObjectTypeName(value) {
  if (!isRecord(value)) return null;
  const typeName = typeof value.__type__ === 'string' ? value.__type__ : typeof value.__class__ === 'string' ? value.__class__ : null;
  if (!typeName || typeName === 'TreeNode' || typeName === 'ListNode' || typeName === 'object') return null;
  return typeName;
}

function toJavaObjectFieldsExpression(value) {
  const entries = Object.entries(value)
    .filter(([key]) => key !== '__type__' && key !== '__class__' && key !== '__id__')
    .map(([key, child]) => `new Object[] { ${JSON.stringify(key)}, ${toJavaDynamicObjectExpression(child)} }`);
  return `objectFields(new Object[][] { ${entries.join(', ')} })`;
}

function toJavaDynamicObjectExpression(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `new java.util.ArrayList<Object>(java.util.Arrays.asList(${value.map((entry) => toJavaDynamicObjectExpression(entry)).join(', ')}))`;
  }
  if (isRecord(value)) {
    const typeName = customObjectTypeName(value);
    if (typeName) {
      return `materializeObject(${JSON.stringify(typeName)}, ${toJavaObjectFieldsExpression(value)})`;
    }
    const entries = Object.entries(value)
      .filter(([key]) => key !== '__type__' && key !== '__class__' && key !== '__id__')
      .map(([key, child]) => `new Object[] { ${JSON.stringify(key)}, ${toJavaDynamicObjectExpression(child)} }`);
    return `objectFields(new Object[][] { ${entries.join(', ')} })`;
  }
  return toJavaScalarLiteral(value);
}

function inputValueForParameter(input, key, index) {
  if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  return Object.values(input)[index];
}

function inputArgumentsForParameters(rawArgs, parameters) {
  if (parameters.length === 0) return [];
  if (Array.isArray(rawArgs)) return rawArgs;
  if (isRecord(rawArgs) && parameters.length > 0) {
    return parameters.map((parameter, index) => inputValueForParameter(rawArgs, parameter.name, index));
  }
  return [];
}

function uniqueJavaIdentifier(baseName, usedNames) {
  let candidate = baseName;
  let suffix = 0;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}${suffix}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function listLiteral(value) {
  const rawVal = value.val ?? value.value ?? 0;
  const next = value.next;
  return `list(${toJavaScalarLiteral(rawVal)}, ${next ? listLiteral(next) : 'null'})`;
}

function listGraphExpression(head) {
  const nodes = [];
  const indexByNode = new Map();
  const indexById = new Map();
  const nextIndices = [];
  const pendingRefs = [];

  const visit = (node) => {
    if (!node) return -1;
    if (indexByNode.has(node)) return indexByNode.get(node);

    const index = nodes.length;
    nodes.push(node);
    indexByNode.set(node, index);
    nextIndices[index] = -1;

    if (typeof node.__id__ === 'string') {
      indexById.set(node.__id__, index);
    }

    const next = node.next;
    if (isRecord(next) && !Array.isArray(next)) {
      if (typeof next.__ref__ === 'string') {
        pendingRefs.push({ sourceIndex: index, targetId: next.__ref__ });
      } else {
        nextIndices[index] = visit(next);
      }
    }

    return index;
  };

  visit(head);

  for (const pendingRef of pendingRefs) {
    const targetIndex = indexById.get(pendingRef.targetId);
    if (targetIndex !== undefined) {
      nextIndices[pendingRef.sourceIndex] = targetIndex;
    }
  }

  const values = nodes.map((node) => {
    const rawVal = node.val ?? node.value ?? 0;
    return rawVal;
  });

  return `buildList(new Object[] { ${values.map((value) => toJavaScalarLiteral(value)).join(', ')} }, new int[] { ${nextIndices.join(', ')} })`;
}

function listExpression(value) {
  return listGraphExpression(value);
}

function listArrayExpression(value) {
  return `buildList(new Object[] { ${value.map((entry) => toJavaScalarLiteral(entry)).join(', ')} }, sequentialNextIndices(${value.length}))`;
}

function treeExpression(value) {
  const rawVal = value.val ?? value.value ?? 0;
  const left = value.left ? treeExpression(value.left) : 'null';
  const right = value.right ? treeExpression(value.right) : 'null';
  return `tree(${toJavaScalarLiteral(rawVal)}, ${left}, ${right})`;
}

function treeLevelOrderExpression(value) {
  if (!value.every((entry) => entry === null || (typeof entry === 'number' && Number.isInteger(entry)))) {
    throw new Error(`Unsupported tree node value: ${JSON.stringify(value.find((entry) => entry !== null && (typeof entry !== 'number' || !Number.isInteger(entry))))}`);
  }
  const values = value.map((entry) => (entry === null ? 'null' : String(entry))).join(', ');
  return `buildTree(new Integer[] { ${values} })`;
}

function buildJavaExpression(value, expectedType) {
  const normalizedType = expectedType ? stripGenericType(expectedType) : null;
  if (value === null || typeof value !== 'object') {
    return toJavaScalarLiteralForType(value, normalizedType);
  }
  if (Array.isArray(value)) {
    if (normalizedType === 'Object') {
      return toJavaObjectExpression(value);
    }
    if (normalizedType === 'ListNode') {
      return listArrayExpression(value);
    }
    if (normalizedType === 'TreeNode') {
      return treeLevelOrderExpression(value);
    }
    if (normalizedType?.startsWith('List<')) {
      return toJavaListLiteral(value, normalizedType);
    }
    if (normalizedType?.endsWith('[]')) {
      return toJavaTypedArrayLiteral(value, normalizedType);
    }
    return toJavaArrayLiteral(value);
  }
  if (isRecord(value) && normalizedType === 'ListNode') return listExpression(value);
  if (isRecord(value) && normalizedType === 'TreeNode') return treeExpression(value);
  if (isRecord(value) && normalizedType?.startsWith('Map<')) return toJavaMapLiteral(value, normalizedType);
  if (isRecord(value) && customObjectTypeName(value)) {
    return `((${normalizedType ?? customObjectTypeName(value)}) ${toJavaDynamicObjectExpression(value)})`;
  }
  if (isListNodeShape(value)) return listExpression(value);
  if (isTreeNodeShape(value)) return treeExpression(value);
  return toJavaScalarLiteral(value);
}

function buildDynamicInputHelperMethods() {
  return `
  private static Object readJsonInput(String path, Class<?> targetType) {
    try {
      String source = java.nio.file.Files.readString(java.nio.file.Paths.get(path), java.nio.charset.StandardCharsets.UTF_8);
      return coerceJsonInput(new __TracecodeJsonParser(source).parse(), targetType);
    } catch (java.io.IOException error) {
      throw new RuntimeException("Unable to read TraceCode input " + path, error);
    }
  }

  private static Object coerceJsonInput(Object value, Class<?> targetType) {
    if (value == null) return null;
    if (targetType.isArray()) {
      java.util.List<?> list = (java.util.List<?>) value;
      Class<?> componentType = targetType.getComponentType();
      Object array = java.lang.reflect.Array.newInstance(componentType, list.size());
      for (int i = 0; i < list.size(); i++) {
        java.lang.reflect.Array.set(array, i, coerceJsonInput(list.get(i), componentType));
      }
      return array;
    }
    if ((targetType == byte.class || targetType == Byte.class) && value instanceof Number) return ((Number) value).byteValue();
    if ((targetType == short.class || targetType == Short.class) && value instanceof Number) return ((Number) value).shortValue();
    if ((targetType == int.class || targetType == Integer.class) && value instanceof Number) return ((Number) value).intValue();
    if ((targetType == long.class || targetType == Long.class) && value instanceof Number) return ((Number) value).longValue();
    if ((targetType == float.class || targetType == Float.class) && value instanceof Number) return ((Number) value).floatValue();
    if ((targetType == double.class || targetType == Double.class) && value instanceof Number) return ((Number) value).doubleValue();
    if ((targetType == boolean.class || targetType == Boolean.class) && value instanceof Boolean) return value;
    if ((targetType == char.class || targetType == Character.class) && value instanceof String && ((String) value).length() == 1) {
      return ((String) value).charAt(0);
    }
    if (targetType == String.class && value instanceof String) return value;
    return value;
  }

  private static final class __TracecodeJsonParser {
    private final String source;
    private int index = 0;

    __TracecodeJsonParser(String source) {
      this.source = source == null || source.isEmpty() ? "null" : source;
    }

    Object parse() {
      skipWhitespace();
      Object value = parseValue();
      skipWhitespace();
      if (index != source.length()) {
        throw new IllegalArgumentException("Unexpected trailing JSON input");
      }
      return value;
    }

    private Object parseValue() {
      skipWhitespace();
      char ch = peek();
      if (ch == '"') return parseString();
      if (ch == '[') return parseArray();
      if (ch == '{') return parseObject();
      if (ch == '-' || (ch >= '0' && ch <= '9')) return parseNumber();
      if (consume("true")) return Boolean.TRUE;
      if (consume("false")) return Boolean.FALSE;
      if (consume("null")) return null;
      throw new IllegalArgumentException("Invalid JSON input");
    }

    private java.util.List<Object> parseArray() {
      expect('[');
      java.util.ArrayList<Object> values = new java.util.ArrayList<>();
      skipWhitespace();
      if (peek() == ']') {
        index++;
        return values;
      }
      while (true) {
        values.add(parseValue());
        skipWhitespace();
        char separator = take();
        if (separator == ']') return values;
        if (separator != ',') throw new IllegalArgumentException("Invalid JSON array");
      }
    }

    private java.util.LinkedHashMap<String, Object> parseObject() {
      expect('{');
      java.util.LinkedHashMap<String, Object> values = new java.util.LinkedHashMap<>();
      skipWhitespace();
      if (peek() == '}') {
        index++;
        return values;
      }
      while (true) {
        skipWhitespace();
        String key = parseString();
        skipWhitespace();
        expect(':');
        values.put(key, parseValue());
        skipWhitespace();
        char separator = take();
        if (separator == '}') return values;
        if (separator != ',') throw new IllegalArgumentException("Invalid JSON object");
      }
    }

    private String parseString() {
      expect('"');
      StringBuilder out = new StringBuilder();
      while (true) {
        char ch = take();
        if (ch == '"') return out.toString();
        if (ch != '\\\\') {
          out.append(ch);
          continue;
        }
        char escaped = take();
        switch (escaped) {
          case '"': out.append('"'); break;
          case '\\\\': out.append('\\\\'); break;
          case '/': out.append('/'); break;
          case 'b': out.append('\\b'); break;
          case 'f': out.append('\\f'); break;
          case 'n': out.append('\\n'); break;
          case 'r': out.append('\\r'); break;
          case 't': out.append('\\t'); break;
          case 'u':
            int codePoint = 0;
            for (int i = 0; i < 4; i++) {
              codePoint = (codePoint << 4) + Character.digit(take(), 16);
            }
            out.append((char) codePoint);
            break;
          default:
            throw new IllegalArgumentException("Invalid JSON string escape");
        }
      }
    }

    private Number parseNumber() {
      int start = index;
      if (peek() == '-') index++;
      while (peek() >= '0' && peek() <= '9') index++;
      boolean floating = false;
      if (peek() == '.') {
        floating = true;
        index++;
        while (peek() >= '0' && peek() <= '9') index++;
      }
      if (peek() == 'e' || peek() == 'E') {
        floating = true;
        index++;
        if (peek() == '+' || peek() == '-') index++;
        while (peek() >= '0' && peek() <= '9') index++;
      }
      String raw = source.substring(start, index);
      return floating ? Double.valueOf(raw) : Long.valueOf(raw);
    }

    private boolean consume(String literal) {
      if (!source.startsWith(literal, index)) return false;
      index += literal.length();
      return true;
    }

    private void skipWhitespace() {
      while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++;
    }

    private char peek() {
      return index < source.length() ? source.charAt(index) : '\\0';
    }

    private char take() {
      if (index >= source.length()) throw new IllegalArgumentException("Unexpected end of JSON input");
      return source.charAt(index++);
    }

    private void expect(char expected) {
      char actual = take();
      if (actual != expected) throw new IllegalArgumentException("Unexpected JSON character");
    }
  }`;
}

function buildHelperMethods(features) {
  const members = [];
  if (features.hasDynamicInputs) {
    members.push(buildDynamicInputHelperMethods());
  }
  if (features.hasList || features.hasCustomObject) {
    members.push(`
  private static Object coerceMaterializedValue(Object value, Class<?> targetType) {
    if (value == null) {
      return null;
    }
    if (targetType.isInstance(value)) {
      return value;
    }
    if (targetType.isArray() && value instanceof java.util.List<?>) {
      java.util.List<?> list = (java.util.List<?>) value;
      Class<?> componentType = targetType.getComponentType();
      Object array = java.lang.reflect.Array.newInstance(componentType, list.size());
      for (int i = 0; i < list.size(); i++) {
        java.lang.reflect.Array.set(array, i, coerceMaterializedValue(list.get(i), componentType));
      }
      return array;
    }
    if ((targetType == int.class || targetType == Integer.class) && value instanceof Number) return ((Number) value).intValue();
    if ((targetType == long.class || targetType == Long.class) && value instanceof Number) return ((Number) value).longValue();
    if ((targetType == double.class || targetType == Double.class) && value instanceof Number) return ((Number) value).doubleValue();
    if ((targetType == float.class || targetType == Float.class) && value instanceof Number) return ((Number) value).floatValue();
    if ((targetType == short.class || targetType == Short.class) && value instanceof Number) return ((Number) value).shortValue();
    if ((targetType == byte.class || targetType == Byte.class) && value instanceof Number) return ((Number) value).byteValue();
    if ((targetType == boolean.class || targetType == Boolean.class) && value instanceof Boolean) return value;
    if ((targetType == char.class || targetType == Character.class) && value instanceof String && ((String) value).length() == 1) {
      return ((String) value).charAt(0);
    }
    return value;
  }`);
  }
  if (features.hasList) {
    members.push(`
  private static ListNode list(Object val, ListNode next) {
    try {
      for (java.lang.reflect.Constructor<?> ctor : ListNode.class.getDeclaredConstructors()) {
        Class<?>[] parameterTypes = ctor.getParameterTypes();
        if (parameterTypes.length == 2 && parameterTypes[1] == ListNode.class) {
          ctor.setAccessible(true);
          return (ListNode) ctor.newInstance(coerceMaterializedValue(val, parameterTypes[0]), next);
        }
      }
      for (java.lang.reflect.Constructor<?> ctor : ListNode.class.getDeclaredConstructors()) {
        Class<?>[] parameterTypes = ctor.getParameterTypes();
        if (parameterTypes.length == 1) {
          ctor.setAccessible(true);
          ListNode node = (ListNode) ctor.newInstance(coerceMaterializedValue(val, parameterTypes[0]));
          try {
            java.lang.reflect.Field nextField = ListNode.class.getDeclaredField("next");
            nextField.setAccessible(true);
            nextField.set(node, next);
          } catch (Exception ignored) {
          }
          return node;
        }
      }
      java.lang.reflect.Constructor<ListNode> ctor = ListNode.class.getDeclaredConstructor();
      ctor.setAccessible(true);
      ListNode node = ctor.newInstance();
      java.lang.reflect.Field valField = ListNode.class.getDeclaredField("val");
      valField.setAccessible(true);
      valField.set(node, coerceMaterializedValue(val, valField.getType()));
      java.lang.reflect.Field nextField = ListNode.class.getDeclaredField("next");
      nextField.setAccessible(true);
      nextField.set(node, next);
      return node;
    } catch (Exception error) {
      throw new RuntimeException("Unable to materialize ListNode", error);
    }
  }

  private static ListNode buildList(Object[] values, int[] nextIndices) {
    if (values.length == 0) {
      return null;
    }
    ListNode[] nodes = new ListNode[values.length];
    for (int i = 0; i < values.length; i++) {
      nodes[i] = list(values[i], null);
    }
    for (int i = 0; i < values.length; i++) {
      int nextIndex = nextIndices[i];
      nodes[i].next = nextIndex >= 0 ? nodes[nextIndex] : null;
    }
    return nodes[0];
  }

  private static int[] sequentialNextIndices(int length) {
    int[] indices = new int[length];
    for (int i = 0; i < length; i++) {
      indices[i] = i + 1 < length ? i + 1 : -1;
    }
    return indices;
  }`);
  }
  if (features.hasTree) {
    members.push(`
  private static TreeNode tree(int val, TreeNode left, TreeNode right) {
    TreeNode node = new TreeNode(val);
    node.left = left;
    node.right = right;
    return node;
  }

  private static TreeNode buildTree(Integer[] values) {
    if (values.length == 0 || values[0] == null) {
      return null;
    }
    TreeNode root = new TreeNode(values[0]);
    java.util.Queue<TreeNode> queue = new java.util.ArrayDeque<>();
    queue.add(root);
    int index = 1;
    while (!queue.isEmpty() && index < values.length) {
      TreeNode current = queue.remove();
      if (values[index] != null) {
        current.left = new TreeNode(values[index]);
        queue.add(current.left);
      }
      index++;
      if (index < values.length && values[index] != null) {
        current.right = new TreeNode(values[index]);
        queue.add(current.right);
      }
      index++;
    }
    return root;
  }`);
  }
  if (features.hasMap || features.hasCustomObject) {
    members.push(`
  @SuppressWarnings({"unchecked", "rawtypes"})
  private static <K, V> java.util.LinkedHashMap<K, V> typedMap(Object[][] entries) {
    java.util.LinkedHashMap<K, V> map = new java.util.LinkedHashMap<>();
    for (Object[] entry : entries) {
      map.put((K) entry[0], (V) entry[1]);
    }
    return map;
  }
`);
  }
  if (features.hasCustomObject) {
    members.push(`

  private static java.util.LinkedHashMap<String, Object> objectFields(Object[][] entries) {
    java.util.LinkedHashMap<String, Object> fields = new java.util.LinkedHashMap<>();
    for (Object[] entry : entries) {
      fields.put((String) entry[0], entry[1]);
    }
    return fields;
  }

  private static Object materializeObject(String typeName, java.util.LinkedHashMap<String, Object> fields) {
    try {
      Class<?> cls = Class.forName(new Object() {}.getClass().getPackageName() + "." + typeName);
      Object[] values = fields.values().toArray();
      for (java.lang.reflect.Constructor<?> ctor : cls.getDeclaredConstructors()) {
        if (ctor.getParameterCount() != values.length) {
          continue;
        }
        try {
          Class<?>[] parameterTypes = ctor.getParameterTypes();
          Object[] args = new Object[values.length];
          for (int i = 0; i < values.length; i++) {
            args[i] = coerceMaterializedValue(values[i], parameterTypes[i]);
          }
          ctor.setAccessible(true);
          return ctor.newInstance(args);
        } catch (Exception ignored) {
        }
      }
      for (java.lang.reflect.Constructor<?> ctor : cls.getDeclaredConstructors()) {
        if (ctor.getParameterCount() != 1 || values.length == 0) {
          continue;
        }
        try {
          Class<?>[] parameterTypes = ctor.getParameterTypes();
          ctor.setAccessible(true);
          Object instance = ctor.newInstance(coerceMaterializedValue(values[0], parameterTypes[0]));
          for (java.util.Map.Entry<String, Object> entry : fields.entrySet()) {
            try {
              java.lang.reflect.Field field = cls.getDeclaredField(entry.getKey());
              field.setAccessible(true);
              field.set(instance, coerceMaterializedValue(entry.getValue(), field.getType()));
            } catch (NoSuchFieldException ignored) {
            }
          }
          return instance;
        } catch (Exception ignored) {
        }
      }
      java.lang.reflect.Constructor<?> noArg = cls.getDeclaredConstructor();
      noArg.setAccessible(true);
      Object instance = noArg.newInstance();
      for (java.util.Map.Entry<String, Object> entry : fields.entrySet()) {
        java.lang.reflect.Field field = cls.getDeclaredField(entry.getKey());
        field.setAccessible(true);
        field.set(instance, coerceMaterializedValue(entry.getValue(), field.getType()));
      }
      return instance;
    } catch (Exception error) {
      throw new RuntimeException("Unable to materialize " + typeName, error);
    }
  }

`);
  }
  return members.join('\n');
}

function extractMethodParameters(source, methodName) {
  return extractMethodParameterOverloads(source, methodName)[0] ?? [];
}

function extractMethodParameterOverloads(source, methodName) {
  const compact = source.replace(/\s+/g, ' ');
  const escapedMethod = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const overloads = [];
  const pattern = new RegExp(`\\b${escapedMethod}\\s*\\(([^)]*)\\)`, 'g');
  for (const match of compact.matchAll(pattern)) {
    const rawParameters = match[1]?.trim();
    if (!rawParameters) {
      overloads.push([]);
      continue;
    }
    overloads.push(
      splitTopLevelCommaList(rawParameters)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .map((segment) => {
          const lastSpace = segment.lastIndexOf(' ');
          if (lastSpace === -1) {
            return { type: segment, name: segment };
          }
          return {
            type: segment.slice(0, lastSpace).trim(),
            name: segment.slice(lastSpace + 1).trim(),
          };
        })
    );
  }
  return overloads;
}

function extractMethodParametersForArguments(source, methodName, rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const overloads = extractMethodParameterOverloads(source, methodName);
  return overloads.find((parameters) => parameters.length === args.length) ?? overloads[0] ?? [];
}

function extractMethodReturnType(source, methodName) {
  const compact = source.replace(/\s+/g, ' ');
  const escapedMethod = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = compact.match(
    new RegExp(`\\b(?:public|private|protected|static|final|synchronized|abstract|native|strictfp|\\s)*([A-Za-z_][A-Za-z0-9_<>,.?\\[\\]\\s]*)\\s+${escapedMethod}\\s*\\(`)
  );
  return match?.[1]?.trim() ?? null;
}

function indentBlock(source, spaces = 2) {
  const prefix = ' '.repeat(spaces);
  return source
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : `${prefix}${line}`))
    .join('\n');
}

function isJavaIdentifierPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

function scanJavaCode(source, start, end, onNormalChar) {
  let state = 'normal';
  for (let index = start; index < end; index += 1) {
    const ch = source[index];
    const next = index + 1 < end ? source[index + 1] : '';

    if (state === 'line-comment') {
      if (ch === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        index += 1;
      }
      continue;
    }
    if (state === 'string') {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === '"') state = 'normal';
      continue;
    }
    if (state === 'char') {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === "'") state = 'normal';
      continue;
    }
    if (ch === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (ch === '"') {
      state = 'string';
      continue;
    }
    if (ch === "'") {
      state = 'char';
      continue;
    }

    const result = onNormalChar(index, ch);
    if (result === false) return index;
    if (typeof result === 'number') index = result;
  }
  return end;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let closeIndex = -1;
  scanJavaCode(source, openIndex, source.length, (index, ch) => {
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        return false;
      }
    }
    return undefined;
  });
  return closeIndex;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let closeIndex = -1;
  scanJavaCode(source, openIndex, source.length, (index, ch) => {
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        return false;
      }
    }
    return undefined;
  });
  return closeIndex;
}

function findSingleStatementEnd(source, bodyStart) {
  let cursor = bodyStart;
  while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  if (startsWithJavaKeyword(source, cursor, 'if')) {
    let headerStart = cursor + 'if'.length;
    while (/\s/.test(source[headerStart] ?? '')) headerStart += 1;
    if (source[headerStart] === '(') {
      const closeParen = findMatchingParen(source, headerStart);
      if (closeParen >= 0) {
        let nestedBodyStart = closeParen + 1;
        while (/\s/.test(source[nestedBodyStart] ?? '')) nestedBodyStart += 1;
        if (source[nestedBodyStart] === '{') {
          const closeBrace = findMatchingBrace(source, nestedBodyStart);
          if (closeBrace >= 0) return closeBrace;
        }
        if (source[nestedBodyStart] && source[nestedBodyStart] !== ';') {
          return findSingleStatementEnd(source, nestedBodyStart);
        }
      }
    }
  }
  const loopKeyword = startsWithJavaKeyword(source, cursor, 'for')
    ? 'for'
    : startsWithJavaKeyword(source, cursor, 'while')
      ? 'while'
      : null;
  if (loopKeyword) {
    let headerStart = cursor + loopKeyword.length;
    while (/\s/.test(source[headerStart] ?? '')) headerStart += 1;
    if (source[headerStart] === '(') {
      const closeParen = findMatchingParen(source, headerStart);
      if (closeParen >= 0) {
        let nestedBodyStart = closeParen + 1;
        while (/\s/.test(source[nestedBodyStart] ?? '')) nestedBodyStart += 1;
        if (source[nestedBodyStart] === '{') {
          const closeBrace = findMatchingBrace(source, nestedBodyStart);
          if (closeBrace >= 0) return closeBrace;
        }
        if (source[nestedBodyStart] && source[nestedBodyStart] !== ';') {
          return findSingleStatementEnd(source, nestedBodyStart);
        }
      }
    }
  }

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let statementEnd = -1;
  scanJavaCode(source, bodyStart, source.length, (index, ch) => {
    if (ch === '(') parenDepth += 1;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (ch === '[') bracketDepth += 1;
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (ch === '{') braceDepth += 1;
    if (ch === '}') {
      if (braceDepth === 0) return false;
      braceDepth -= 1;
    }
    if (ch === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      statementEnd = index;
      return false;
    }
    return undefined;
  });
  return statementEnd;
}

function startsWithJavaKeyword(source, index, keyword) {
  if (!source.startsWith(keyword, index)) return false;
  const after = source[index + keyword.length] ?? '';
  return !after || !isJavaIdentifierPart(after);
}

function braceDeltaForLine(line) {
  let delta = 0;
  scanJavaCode(line, 0, line.length, (_index, ch) => {
    if (ch === '{') delta += 1;
    if (ch === '}') delta -= 1;
    return undefined;
  });
  return delta;
}

function isUnbracedLoopHeaderLine(line) {
  const trimmed = line.trim();
  return /^(?:for|while)\s*\(.*\)\s*$/.test(trimmed) && !trimmed.includes('{') && !trimmed.endsWith(';');
}

function startsBracedLoopLine(line) {
  const trimmed = line.trim();
  return /^(?:for|while)\s*\(.*\)\s*\{/.test(trimmed);
}

function wrapNestedBracedLoopBodies(source) {
  const lines = source.split(/\r?\n/);
  const output = [];
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const next = lines[index + 1] ?? '';
    if (!isUnbracedLoopHeaderLine(line) || !startsBracedLoopLine(next)) {
      output.push(line);
      continue;
    }

    changed = true;
    output.push(`${line} {`);
    index += 1;
    let depth = 0;
    for (; index < lines.length; index += 1) {
      const nestedLine = lines[index] ?? '';
      output.push(nestedLine);
      depth += braceDeltaForLine(nestedLine);
      if (depth <= 0) break;
    }
    output.push(`${line.match(/^\s*/)?.[0] ?? ''}}`);
  }
  return changed ? output.join('\n') : source;
}

function wrapSingleStatementLoopBodies(source) {
  source = wrapNestedBracedLoopBodies(source);
  const inserts = [];
  scanJavaCode(source, 0, source.length, (index) => {
    const keyword = source.startsWith('for', index)
      ? 'for'
      : source.startsWith('while', index)
        ? 'while'
        : source.startsWith('if', index)
          ? 'if'
          : null;
    if (!keyword) return undefined;

    const before = index > 0 ? source[index - 1] : '';
    const after = source[index + keyword.length] ?? '';
    if ((before && isJavaIdentifierPart(before)) || (after && isJavaIdentifierPart(after))) {
      return undefined;
    }

    let cursor = index + keyword.length;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '(') return undefined;

    const closeParen = findMatchingParen(source, cursor);
    if (closeParen < 0) return undefined;

    let bodyStart = closeParen + 1;
    while (/\s/.test(source[bodyStart] ?? '')) bodyStart += 1;
    const bodyChar = source[bodyStart];
    if (!bodyChar || bodyChar === '{' || bodyChar === ';') return closeParen;
    if (
      startsWithJavaKeyword(source, bodyStart, 'switch') ||
      startsWithJavaKeyword(source, bodyStart, 'synchronized') ||
      startsWithJavaKeyword(source, bodyStart, 'try')
    ) {
      return closeParen;
    }

    const bodyEnd = findSingleStatementEnd(source, bodyStart);
    if (bodyEnd < 0) return closeParen;

    inserts.push({ index: bodyStart, text: '{ ' });
    inserts.push({ index: bodyEnd + 1, text: ' }' });
    return bodyEnd;
  });

  if (inserts.length === 0) return source;

  const insertsByIndex = new Map();
  for (const insert of inserts) {
    insertsByIndex.set(insert.index, `${insertsByIndex.get(insert.index) ?? ''}${insert.text}`);
  }

  let output = '';
  for (let index = 0; index <= source.length; index += 1) {
    output += insertsByIndex.get(index) ?? '';
    if (index < source.length) output += source[index];
  }
  return output === source ? output : wrapSingleStatementLoopBodies(output);
}

function splitTopLevelJavaList(value) {
  const parts = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    const previous = index > 0 ? value[index - 1] : '';
    if (quote) {
      if (ch === quote && previous !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (ch === '[') bracketDepth += 1;
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (ch === '<') angleDepth += 1;
    if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (
      ch === ',' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail.length > 0) {
    parts.push(tail);
  }
  return parts;
}

function parseJavaParameters(parametersSource) {
  return splitTopLevelJavaList(parametersSource)
    .map((parameter) => parameter.replace(/@\w+(?:\([^)]*\))?/g, '').replace(/\bfinal\b/g, '').trim())
    .map((parameter) => {
      const match = parameter.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\.\.)?$/);
      const name = match?.[1] ?? '';
      return {
        name,
        isArray: parameter.includes('[]') || parameter.includes('...'),
      };
    })
    .filter((parameter) => parameter.name.length > 0);
}

function parseJavaParameterNames(parametersSource) {
  return parseJavaParameters(parametersSource).map((parameter) => parameter.name);
}

function collectJavaArrayDeclarations(line) {
  const names = [];
  const declarationPattern =
    /\b(?:boolean|byte|char|short|int|long|float|double|String|[A-Za-z_][A-Za-z0-9_<>.?]*)\s*(?:\[\s*\])+\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const match of line.matchAll(declarationPattern)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNativeTraceLine(line) {
  const match = line.match(/TraceHooks\.emit(?:Line|Call|Return)AtLine\((\d+)\b/);
  if (!match) return null;
  const lineNumber = Number.parseInt(match[1], 10);
  return Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : null;
}

function augmentTraceCallArgumentSnapshots(source) {
  const lines = source.split('\n');
  const methodStack = [];
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({
        name: methodMatch[2],
        params: parseJavaParameterNames(methodMatch[3] ?? ''),
        depth: 1,
        patchedCall: false,
      });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;
    if (currentMethod && !currentMethod.patchedCall && currentMethod.params.length > 0) {
      const callPattern = new RegExp(
        `^(\\s*)TraceHooks\\.emitCallAtLine\\((\\d+),\\s*"${escapeRegExp(currentMethod.name)}",\\s*([^)]*)\\);\\s*$`
      );
      const callMatch = line.match(callPattern);
      if (callMatch) {
        const serializedArgs = currentMethod.params
          .map((paramName) => ` + " ${paramName}=" + TraceHooks.serializeResult(${paramName})`)
          .join('');
        nextLine = `${callMatch[1]}TraceHooks.emitCallAtLine(${callMatch[2]}, "${currentMethod.name}", ""${serializedArgs});`;
        currentMethod.patchedCall = true;
      }
    }

    if (currentMethod) {
      currentMethod.depth += braceDelta(nextLine);
      while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
        methodStack.pop();
      }
    }

    return nextLine;
  }).join('\n');
}

function collectJavaLocalDeclarations(line) {
  const names = [];
  const trimmedLine = String(line).trim();
  if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
    return names;
  }
  const declarationPattern =
    /\b(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?==)/g;
  const skippedNames = new Set(['class', 'interface', 'enum', 'record', 'return', 'new']);
  for (const match of line.matchAll(declarationPattern)) {
    const typeSource = match[1] ?? '';
    const name = match[2];
    if (name && !skippedNames.has(name) && !name.startsWith('__tracecode')) {
      names.push(name);
    }
  }
  const enhancedForMatch = line.match(
    /\bfor\s*\(\s*(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/
  );
  const enhancedForType = enhancedForMatch?.[1] ?? '';
  const enhancedForName = enhancedForMatch?.[2];
  if (enhancedForName && !skippedNames.has(enhancedForName) && !enhancedForName.startsWith('__tracecode')) {
    names.push(enhancedForName);
  }
  return names;
}

function visibleJavaLocalNames(scopeStack) {
  const names = [];
  const seen = new Set();
  for (const scope of scopeStack) {
    for (const name of scope.names) {
      if (!seen.has(name)) {
        names.push(name);
        seen.add(name);
      }
    }
  }
  return names;
}

function isUnbracedForDeclarationLine(line) {
  return /^\s*for\s*\(/.test(line) && !(line.includes('{'));
}

function isControlHeaderDeclarationLine(line) {
  return /^\s*(?:for|if|while|switch|catch)\s*\(/.test(line);
}

function traceEmitAlreadyIncludesVariable(emitExpression, name) {
  return new RegExp(`\\b${escapeRegExp(name)}=`).test(emitExpression);
}

function appendJavaLocalSnapshotsToEmitLine(line, scopeStack) {
  const visibleNames = visibleJavaLocalNames(scopeStack);
  if (visibleNames.length === 0 || !line.includes('TraceHooks.emitLineAtLine(')) {
    return line;
  }

  return line.replace(/TraceHooks\.emitLineAtLine\((\d+)(?:,\s*([^;]*?))?\);/g, (match, lineNumber, snapshotExpression) => {
    const emitExpression = snapshotExpression ?? '';
    const additions = visibleNames
      .filter((name) => !traceEmitAlreadyIncludesVariable(emitExpression, name))
      .map((name) => ` + " ${name}=" + TraceHooks.serializeResult(${name})`)
      .join('');
    if (!additions) return match;
    const prefix = emitExpression.trim().length > 0 ? emitExpression.trim() : '""';
    return `TraceHooks.emitLineAtLine(${Number.parseInt(lineNumber, 10)}, ${prefix}${additions});`;
  });
}

function appendJavaLocalSnapshotsAfterMutations(line, scopeStack) {
  const visibleNames = visibleJavaLocalNames(scopeStack);
  if (visibleNames.length === 0 || !line.includes('TraceHooks.emitMutatingCallAtLine(')) {
    return line;
  }

  return line.replace(
    /(TraceHooks\.emitMutatingCallAtLine\((\d+),[^;]+;\s*)/g,
    (match, statement, lineNumber) => {
      const additions = visibleNames
        .map((name) => ` + " ${name}=" + TraceHooks.serializeResult(${name})`)
        .join('');
      return `${statement} TraceHooks.emitLineAtLine(${lineNumber}, ""${additions});`;
    }
  );
}

function guardJavaLineEmit(line) {
  return line.replace(
    /^(\s*)TraceHooks\.emitLineAtLine\((.+)\);\s*$/,
    (_match, indent, argsSource) => `${indent}if (!TraceHooks.traceLimitExceeded()) TraceHooks.emitLineAtLine(${argsSource});`
  );
}

function augmentJavaLocalSnapshots(source) {
  const lines = source.split('\n');
  const output = [];
  const scopeStack = [];
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  for (const line of lines) {
    const leadingClosingCount = line.match(/^\s*}+/)?.[0].replace(/\s/g, '').length ?? 0;
    for (let index = 0; index < leadingClosingCount; index += 1) {
      if (scopeStack.length > 0) scopeStack.pop();
    }

    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      const params = parseJavaParameterNames(methodMatch[3] ?? '');
      scopeStack.push({ names: params });
      output.push(line);
      continue;
    }

    const transformedLine = guardJavaLineEmit(appendJavaLocalSnapshotsAfterMutations(
      appendJavaLocalSnapshotsToEmitLine(line, scopeStack),
      scopeStack
    ));
    output.push(transformedLine);

    const declarations = collectJavaLocalDeclarations(line);
    const declarationsBelongToCurrentScope =
      declarations.length > 0 && !isControlHeaderDeclarationLine(line);
    if (declarationsBelongToCurrentScope) {
      const currentScope = scopeStack[scopeStack.length - 1];
      if (currentScope) {
        for (const name of declarations) {
          currentScope.names.push(name);
        }
      }
    }
    const openingCount = (line.match(/{/g) ?? []).length;
    const closingCount = Math.max(0, (line.match(/}/g) ?? []).length - leadingClosingCount);
    for (let index = 0; index < openingCount; index += 1) {
      scopeStack.push({ names: index === 0 && !declarationsBelongToCurrentScope ? declarations : [] });
    }
    if (
      openingCount === 0 &&
      declarations.length > 0 &&
      !declarationsBelongToCurrentScope &&
      !isUnbracedForDeclarationLine(line)
    ) {
      const currentScope = scopeStack[scopeStack.length - 1];
      if (currentScope) {
        for (const name of declarations) {
          currentScope.names.push(name);
        }
      }
    }
    for (let index = 0; index < closingCount; index += 1) {
      if (scopeStack.length > 0) scopeStack.pop();
    }
  }

  return output.join('\n');
}

function collectJavaObjectDeclarations(line) {
  const names = [];
  const declarationPattern =
    /\b([A-Z][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+\1\s*\(/g;
  for (const match of line.matchAll(declarationPattern)) {
    if (match[2]) names.push(match[2]);
  }
  return names;
}

function rewriteJavaObjectFieldReads(expression, objectNames, lineNumber) {
  let output = expression;
  for (const name of objectNames) {
    const fieldPattern = new RegExp(`\\b${escapeRegExp(name)}\\.([A-Za-z_][A-Za-z0-9_]*)\\b`, 'g');
    output = output.replace(fieldPattern, (match, field, offset, fullSource) => {
      const marker = fullSource.lastIndexOf('TraceHooks.', offset);
      const delimiter = Math.max(fullSource.lastIndexOf(';', offset), fullSource.lastIndexOf('\n', offset));
      if (marker > delimiter) return match;
      const nextChar = fullSource[offset + match.length] ?? '';
      if (nextChar === '(') return match;
      return `TraceHooks.readObjectFieldAtLine(${lineNumber}, "${name}", "${field}", ${match})`;
    });
  }
  return output;
}

function augmentJavaObjectFieldOperations(source) {
  const lines = source.split('\n');
  const methodStack = [];
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({
        depth: 1,
        currentTraceLine: null,
        objectNames: new Set(),
      });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;
    if (!currentMethod) return nextLine;

    for (const name of collectJavaObjectDeclarations(line)) {
      currentMethod.objectNames.add(name);
    }

    const traceLine = parseNativeTraceLine(line);
    if (traceLine !== null) currentMethod.currentTraceLine = traceLine;

    const lineNumber = currentMethod.currentTraceLine;
    if (lineNumber !== null && currentMethod.objectNames.size > 0) {
      for (const name of currentMethod.objectNames) {
        const writePattern = new RegExp(`^(\\s*)${escapeRegExp(name)}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+);\\s*$`);
        const writeMatch = nextLine.match(writePattern);
        if (writeMatch) {
          const indent = writeMatch[1] ?? '';
          const field = writeMatch[2];
          const rhs = writeMatch[3];
          nextLine = `${indent}{ ${name}.${field} = ${rhs}; TraceHooks.emitFieldWriteAtLine(${lineNumber}, "${name}", "${field}", ${name}.${field}); }`;
          break;
        }
      }

      const returnMatch = nextLine.match(/^(\s*)return\s+(.+);\s*$/);
      if (returnMatch) {
        nextLine = `${returnMatch[1]}return ${rewriteJavaObjectFieldReads(returnMatch[2], currentMethod.objectNames, lineNumber)};`;
      }
    }

    currentMethod.depth += braceDelta(nextLine);
    while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
      methodStack.pop();
    }
    return nextLine;
  }).join('\n');
}

function augmentJavaThrowEvents(source) {
  const lines = source.split('\n');
  const methodStack = [];
  let thrownIndex = 0;
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({ depth: 1, currentTraceLine: null });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;
    if (!currentMethod) return nextLine;

    const traceLine = parseNativeTraceLine(line);
    if (traceLine !== null) currentMethod.currentTraceLine = traceLine;

    const throwMatch = nextLine.match(/^(\s*)throw\s+(.+);\s*$/);
    if (throwMatch && currentMethod.currentTraceLine !== null) {
      const indent = throwMatch[1] ?? '';
      const tempName = `__tracecodeThrown${thrownIndex++}`;
      const expression = throwMatch[2];
      nextLine = `${indent}{ var ${tempName} = ${expression}; TraceHooks.emitExceptionAtLine(${currentMethod.currentTraceLine}, String.valueOf(${tempName})); throw ${tempName}; }`;
    }

    currentMethod.depth += braceDelta(nextLine);
    while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
      methodStack.pop();
    }
    return nextLine;
  }).join('\n');
}

function augmentJavaStdoutEvents(source) {
  const lines = source.split('\n');
  const methodStack = [];
  let stdoutIndex = 0;
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({ depth: 1, currentTraceLine: null });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;
    if (!currentMethod) return nextLine;

    const traceLine = parseNativeTraceLine(line);
    if (traceLine !== null) currentMethod.currentTraceLine = traceLine;

    const stdoutMatch = nextLine.match(/^(\s*)System\.out\.println\((.+)\);\s*$/);
    if (stdoutMatch && currentMethod.currentTraceLine !== null) {
      const indent = stdoutMatch[1] ?? '';
      const tempName = `__tracecodeStdout${stdoutIndex++}`;
      const expression = stdoutMatch[2];
      nextLine = `${indent}{ var ${tempName} = ${expression}; System.out.println(${tempName}); TraceHooks.emitStdoutAtLine(${currentMethod.currentTraceLine}, String.valueOf(${tempName})); }`;
    }

    currentMethod.depth += braceDelta(nextLine);
    while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
      methodStack.pop();
    }
    return nextLine;
  }).join('\n');
}

function augmentArrayLengthReads(source) {
  const lines = source.split('\n');
  const methodStack = [];
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  return lines.map((line) => {
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      const parameters = parseJavaParameters(methodMatch[3] ?? '');
      methodStack.push({
        depth: 1,
        currentTraceLine: null,
        hasTraceEmit: false,
        arrayNames: new Set(parameters.filter((parameter) => parameter.isArray).map((parameter) => parameter.name)),
      });
      return line;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    let nextLine = line;

    if (currentMethod) {
      for (const name of collectJavaArrayDeclarations(line)) {
        currentMethod.arrayNames.add(name);
      }

      const traceLine = parseNativeTraceLine(line);
      if (traceLine !== null) {
        currentMethod.currentTraceLine = traceLine;
        currentMethod.hasTraceEmit = true;
      }

      if (
        currentMethod.hasTraceEmit &&
        currentMethod.currentTraceLine !== null &&
        !line.includes('TraceHooks.readArrayLengthAtLine')
      ) {
        for (const arrayName of currentMethod.arrayNames) {
          const lengthPattern = new RegExp(`\\b${escapeRegExp(arrayName)}\\.length\\b`, 'g');
          nextLine = nextLine.replace(
            lengthPattern,
            `TraceHooks.readArrayLengthAtLine(${currentMethod.currentTraceLine}, "${arrayName}", ${arrayName})`
          );
        }
      }

      currentMethod.depth += braceDelta(nextLine);
      while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
        methodStack.pop();
      }
    }

    return nextLine;
  }).join('\n');
}

function augmentTraceReturnValueSnapshots(source) {
  const lines = source.split('\n');
  const output = [];
  const methodStack = [];
  let returnValueIndex = 0;
  const methodStartPattern =
    /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*([A-Za-z_][A-Za-z0-9_<>\[\], ?]*(?:\[\])?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const methodMatch = line.match(methodStartPattern);
    if (methodMatch) {
      methodStack.push({
        name: methodMatch[3],
        returnType: (methodMatch[2] ?? '').trim(),
        depth: 1,
      });
      output.push(line);
      continue;
    }

    const currentMethod = methodStack[methodStack.length - 1];
    if (currentMethod && currentMethod.returnType !== 'void') {
      const returnEmitMatch = line.match(
        /^(\s*)TraceHooks\.emitReturnAtLine\((\d+),\s*"([A-Za-z_][A-Za-z0-9_]*)"\);\s*$/
      );
      const nextLine = lines[index + 1] ?? '';
      const returnMatch = nextLine.match(/^(\s*)return\s+(.+);\s*$/);
      if (returnEmitMatch && returnMatch && returnEmitMatch[3] === currentMethod.name) {
        const tempName = `__tracecodeReturnValue${returnValueIndex++}`;
        const indent = returnEmitMatch[1] ?? returnMatch[1] ?? '';
        const returnExpression = returnMatch[2].trim();
        output.push(`${indent}${currentMethod.returnType} ${tempName} = ${returnExpression};`);
        output.push(
          `${indent}TraceHooks.emitReturnAtLine(${returnEmitMatch[2]}, "${currentMethod.name}", ${tempName});`
        );
        output.push(`${returnMatch[1] ?? indent}return ${tempName};`);
        currentMethod.depth += braceDelta(line) + braceDelta(nextLine);
        index += 1;
        while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
          methodStack.pop();
        }
        continue;
      }
    }

    output.push(line);
    if (currentMethod) {
      currentMethod.depth += braceDelta(line);
      while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
        methodStack.pop();
      }
    }
  }

  return output.join('\n');
}

function splitImportPrelude(source) {
  const lines = source.split('\n');
  const importLines = [];
  const bodyLines = [];
  let inImportPrelude = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inImportPrelude && (trimmed === '' || trimmed.startsWith('import '))) {
      importLines.push(line);
      continue;
    }
    inImportPrelude = false;
    bodyLines.push(line);
  }

  return { importLines, bodyLines };
}

function splitImportPreludeEntries(source) {
  const lines = source.split('\n');
  const importEntries = [];
  const bodyEntries = [];
  let inImportPrelude = true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const entry = { line, sourceLine: index + 1 };
    const trimmed = line.trim();
    if (inImportPrelude && (trimmed === '' || trimmed.startsWith('import '))) {
      importEntries.push(entry);
      continue;
    }
    inImportPrelude = false;
    bodyEntries.push(entry);
  }

  return { importEntries, bodyEntries };
}

function trimBlankEntries(entries) {
  let start = 0;
  let end = entries.length;
  while (start < end && entries[start].line.trim().length === 0) start += 1;
  while (end > start && entries[end - 1].line.trim().length === 0) end -= 1;
  return entries.slice(start, end);
}

function isTopLevelMethodStart(line) {
  const trimmed = line.trim();
  return /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:[\w<>\[\], ?]+\s+)+[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*\)\s*\{/.test(trimmed);
}

function braceDelta(line) {
  let delta = 0;
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    const prev = index > 0 ? line[index - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') delta += 1;
    if (ch === '}') delta -= 1;
  }
  return delta;
}

function splitScriptMembersAndStatements(lines) {
  const memberLines = [];
  const statementLines = [];
  let statementDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const entry = lines[index];
    const line = typeof entry === 'string' ? entry : entry.line;
    if (statementDepth !== 0 || !isTopLevelMethodStart(line)) {
      statementLines.push(entry);
      statementDepth += braceDelta(line);
      if (statementDepth < 0) statementDepth = 0;
      continue;
    }

    let depth = 0;
    do {
      const current = lines[index] ?? '';
      const currentLine = typeof current === 'string' ? current : current.line;
      memberLines.push(current);
      depth += braceDelta(currentLine);
      index += 1;
    } while (index < lines.length && depth > 0);
    index -= 1;
  }
  return {
    memberLines,
    statementLines,
    memberEntries: memberLines,
    statementEntries: statementLines,
  };
}

function normalizeFunctionSource(source) {
  if (/\bpackage\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/.test(source)) {
    throw new Error('Java function style should not declare a package; the harness manages package isolation.');
  }

  if (/\bclass\s+Solution\b/.test(source)) {
    return wrapSingleStatementLoopBodies(source);
  }

  if (/\b(class|interface|enum|record)\b/.test(source)) {
    throw new Error(
      'Java function style currently expects a bare method fragment or a class named Solution containing the target method.'
    );
  }

  const { importLines, bodyLines } = splitImportPrelude(source);

  const importBlock = importLines.join('\n').trim();
  const body = bodyLines.join('\n').trim();
  if (!body) {
    throw new Error('Java function style requires a method fragment.');
  }

  return wrapSingleStatementLoopBodies(`${importBlock ? `${importBlock}\n\n` : ''}class Solution {\n${indentBlock(body, 2)}\n}`);
}

function normalizeScriptSource(source) {
  return normalizeScriptSourceWithLineMap(source).code;
}

function normalizeScriptSourceWithLineMap(source) {
  if (/\bpackage\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/.test(source)) {
    throw new Error('Java script style should not declare a package; the harness manages package isolation.');
  }

  const { importEntries, bodyEntries } = splitImportPreludeEntries(source);
  const { memberEntries, statementEntries } = splitScriptMembersAndStatements(bodyEntries);
  const trimmedMemberEntries = trimBlankEntries(memberEntries);
  const trimmedStatementEntries = trimBlankEntries(statementEntries);
  if (trimmedStatementEntries.length === 0) {
    throw new Error('Java script style requires executable statements and a result assignment.');
  }

  const outputLines = [];
  const lineMap = {};
  const firstStatementLine = trimmedStatementEntries[0]?.sourceLine;
  const lastStatementLine = trimmedStatementEntries[trimmedStatementEntries.length - 1]?.sourceLine;
  const declaresResult = trimmedStatementEntries.some((entry) =>
    /^(?:final\s+)?[\w<>\[\], ?]+\s+result\s*(?:=|;)/.test(entry.line.trim())
  );
  const pushLine = (line, sourceLine) => {
    outputLines.push(line);
    if (Number.isFinite(sourceLine) && sourceLine > 0) {
      lineMap[outputLines.length] = sourceLine;
    }
  };

  for (const entry of importEntries) {
    pushLine(entry.line, entry.sourceLine);
  }
  pushLine('class Solution {');
  for (const entry of trimmedMemberEntries) {
    pushLine(entry.line.trim().length === 0 ? '' : `  ${entry.line}`, entry.sourceLine);
  }
  pushLine(`  Object ${SCRIPT_METHOD_NAME}() {`, firstStatementLine);
  if (!declaresResult) {
    pushLine('    Object result = null;', firstStatementLine);
  }
  for (const entry of trimmedStatementEntries) {
    pushLine(entry.line.trim().length === 0 ? '' : `    ${entry.line}`, entry.sourceLine);
  }
  pushLine('    return result;', lastStatementLine);
  pushLine('  }');
  pushLine('}');

  return {
    code: wrapSingleStatementLoopBodies(outputLines.join('\n')),
    lineMap,
  };
}

function normalizeJavaRequest(payload) {
  if (isScriptRequest(payload)) {
    if (payload.executionStyle !== 'function') {
      throw new Error('Java script-mode execution only supports executionStyle="function".');
    }

    const normalizedScript = normalizeScriptSourceWithLineMap(payload.code);
    return {
      ...payload,
      code: normalizedScript.code,
      executionStyle: 'solution-method',
      functionName: SCRIPT_METHOD_NAME,
      sourceText: payload.code,
      sourceLineMap: normalizedScript.lineMap,
      userCodeLineCount: payload.code.split(/\r?\n/).length,
      scriptMode: true,
    };
  }

  if (payload.executionStyle === 'solution-method') {
    return {
      ...payload,
      sourceText: payload.code,
      code: wrapSingleStatementLoopBodies(payload.code),
    };
  }

  if (payload.executionStyle === 'ops-class') {
    return {
      ...payload,
      sourceText: payload.code,
      code: wrapSingleStatementLoopBodies(payload.code),
    };
  }

  if (payload.executionStyle !== 'function') {
    return payload;
  }

  return {
    ...payload,
    sourceText: payload.code,
    code: normalizeFunctionSource(payload.code),
    executionStyle: 'solution-method',
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  const source = typeof value === 'string' ? value : stableJson(value);
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    hashA ^= code;
    hashA = Math.imul(hashA, 0x01000193) >>> 0;
    hashB ^= code + index;
    hashB = Math.imul(hashB, 0x85ebca6b) >>> 0;
  }
  return `${hashA.toString(36)}${hashB.toString(36)}`;
}

function dynamicInputEntriesForPayload(payload, compileId) {
  if (payload.executionStyle === 'ops-class') return [];
  const parameters = extractMethodParameters(payload.code, payload.functionName);
  const invocationKeys = parameters.length > 0 ? parameters.map((parameter) => parameter.name) : Object.keys(payload.inputs ?? {});
  const entries = [];
  for (let index = 0; index < invocationKeys.length; index += 1) {
    const key = invocationKeys[index];
    const parameter = parameters[index];
    if (!parameter) continue;
    const value = inputValueForParameter(payload.inputs ?? {}, key, index);
    if (!isDynamicJavaInputType(parameter.type, value)) continue;
    const safeName = String(key).replace(/[^A-Za-z0-9_$-]/g, '_');
    entries.push({
      key,
      index,
      type: parameter.type,
      value,
      path: `${DYNAMIC_INPUT_PREFIX}-${compileId}-${index}-${safeName}.json`,
    });
  }
  return entries;
}

function buildJavaCompileSeed(payload, compileMode = 'trace') {
  if (payload.executionStyle === 'ops-class') {
    return {
      compileMode,
      code: payload.code,
      functionName: payload.functionName,
      executionStyle: payload.executionStyle,
      inputs: payload.inputs ?? {},
    };
  }

  const parameters = extractMethodParameters(payload.code, payload.functionName);
  const invocationKeys = parameters.length > 0 ? parameters.map((parameter) => parameter.name) : Object.keys(payload.inputs ?? {});
  const inputs = {};
  for (let index = 0; index < invocationKeys.length; index += 1) {
    const key = invocationKeys[index];
    const parameter = parameters[index];
    const value = inputValueForParameter(payload.inputs ?? {}, key, index);
    inputs[key] = parameter && isDynamicJavaInputType(parameter.type, value)
      ? { mode: 'dynamic-json-file', type: normalizedJavaInputType(parameter.type) }
      : { mode: 'literal', value };
  }

  return {
    compileMode,
    code: payload.code,
    functionName: payload.functionName,
    executionStyle: payload.executionStyle,
    scriptMode: payload.scriptMode === true,
    inputs,
  };
}

function buildJavaCompileId(payload, compileMode = 'trace') {
  return stableHash(buildJavaCompileSeed(payload, compileMode));
}

function buildJavaBatchCompileId(payload, inputBatch) {
  return stableHash({
    compileMode: 'execute-batch',
    cases: inputBatch.map((inputs) => buildJavaCompileSeed({ ...payload, inputs }, 'execute-batch-case')),
  });
}

async function writeDynamicInputFiles(dynamicInputs) {
  for (const input of dynamicInputs) {
    await self.cheerpOSAddStringFile(input.path, JSON.stringify(input.value));
  }
}

function dynamicInputByKey(dynamicInputs) {
  const out = new Map();
  for (const input of dynamicInputs) out.set(input.key, input);
  return out;
}

function buildExportsSource(source, functionName, executionStyle, input, options = {}) {
  const features = detectFeatures(source, input, options);
  const helperMethods = buildHelperMethods(features);
  const dynamicInputsByKey = dynamicInputByKey(options.dynamicInputs ?? []);

  if (executionStyle === 'ops-class') {
    const operations = Array.isArray(input.operations) ? input.operations : [];
    const argumentsList = Array.isArray(input.arguments) ? input.arguments : [];
    const lines = ['    java.util.List<Object> out = new java.util.ArrayList<>();'];
    const firstOperation = operations.length > 0 ? String(operations[0]) : null;
    const hasConstructorOperation =
      firstOperation === functionName ||
      firstOperation === '__init__' ||
      firstOperation === 'init' ||
      (firstOperation !== null && extractMethodReturnType(source, firstOperation) === null);
    const constructorParameters = extractMethodParametersForArguments(source, functionName, argumentsList[0]);
    const constructorArgs = hasConstructorOperation
      ? inputArgumentsForParameters(argumentsList[0], constructorParameters)
      : [];
    const constructorInvocationArgs = constructorArgs
      .map((arg, argIndex) => buildJavaExpression(arg, constructorParameters[argIndex]?.type))
      .join(', ');
    lines.push(`    ${functionName} instance = new ${functionName}(${constructorInvocationArgs});`);
    if (hasConstructorOperation) {
      lines.push('    out.add(null);');
    }

    operations.forEach((operation, index) => {
      if (hasConstructorOperation && index === 0) {
        return;
      }
      const operationName = String(operation);
      const parameters = extractMethodParametersForArguments(source, operationName, argumentsList[index]);
      const args = inputArgumentsForParameters(argumentsList[index], parameters);
      const invocationArgs = args.map((arg, argIndex) => buildJavaExpression(arg, parameters[argIndex]?.type)).join(', ');
      const returnType = extractMethodReturnType(source, operationName);
      if (returnType === 'void') {
        lines.push(`    instance.${operationName}(${invocationArgs});`);
        lines.push('    out.add(null);');
      } else {
        lines.push(`    out.add(instance.${operationName}(${invocationArgs}));`);
      }
    });

    return `public class Exports {
${helperMethods}

  public static String run() {
${lines.join('\n')}
    return TraceHooks.serializeOutputResult(out);
  }
}
`;
  }

  const parameters = extractMethodParameters(source, functionName);
  const returnType = extractMethodReturnType(source, functionName);
  const invocationKeys = parameters.length > 0 ? parameters.map((parameter) => parameter.name) : Object.keys(input);
  const usedLocalNames = new Set(['solution', ...invocationKeys]);
  const resultLocalName = uniqueJavaIdentifier('__tracecode_result', usedLocalNames);
  const materializedArgs = [];
  for (let index = 0; index < invocationKeys.length; index += 1) {
    const key = invocationKeys[index];
    const parameter = parameters[index];
    const type = parameter ? parameter.type : 'Object';
    const value = inputValueForParameter(input, key, index);
    const dynamicInput = dynamicInputsByKey.get(key);
    const expression = dynamicInput
      ? dynamicJavaInputExpression(type, dynamicInput.path)
      : buildJavaExpression(value, type);
    if (dynamicInput && !expression) {
      throw new Error(`Unsupported dynamic Java input type: ${type}`);
    }
    materializedArgs.push(`    ${type} ${key} = ${expression};`);
  }
  const invocationArgs = invocationKeys.join(', ');
  const invocationLine = returnType === 'void'
    ? `    solution.${functionName}(${invocationArgs});\n    return TraceHooks.serializeOutputResult(null);`
    : `    ${returnType || 'Object'} ${resultLocalName} = solution.${functionName}(${invocationArgs});\n    return TraceHooks.serializeOutputResult(${resultLocalName});`;

  return `public class Exports {
${helperMethods}

  public static String run() {
    Solution solution = new Solution();
${materializedArgs.join('\n')}
${invocationLine}
  }
}
`;
}

function buildPackageName(messageId) {
  return `harness.user.job${String(messageId).replace(/[^A-Za-z0-9]/g, '')}`;
}

function buildExportsClassName(messageId) {
  return `Exports${String(messageId).replace(/[^A-Za-z0-9]/g, '')}`;
}

function normalizeJavaSerializedOutput(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJavaSerializedOutput(item));
  }
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__class__') continue;
    if (value.__type__ === 'NestedInteger' && key === 'value' && child == null) continue;
    output[key] = normalizeJavaSerializedOutput(child);
  }
  return output;
}

async function ensureReady() {
  if (!workerReadyPromise) {
    workerReadyPromise = (async () => {
      const startedAt = performance.now();
      self.importScripts(CHEERPJ_LOADER_URL);
      if (typeof self.cheerpjInit !== 'function') {
        throw new Error('CheerpJ loader did not expose cheerpjInit');
      }
      await self.cheerpjInit({ version: 17, status: 'none', natives: javaProjectNativeBridge() });
      if (
        typeof self.cheerpjRunLibrary !== 'function' ||
        typeof self.cheerpOSAddStringFile !== 'function'
      ) {
        throw new Error('CheerpJ runtime APIs are unavailable in the worker');
      }
      initLoadTimeMs = performance.now() - startedAt;
    })();
  }
  await workerReadyPromise;
}

async function getHelperLibrary() {
  if (!helperLibraryPromise) {
    helperLibraryPromise = self.cheerpjRunLibrary(FULL_CLASSPATH);
  }
  return helperLibraryPromise;
}

async function getCompileLibraryClass() {
  if (!compileLibraryClassPromise) {
    compileLibraryClassPromise = (async () => {
      const library = await getHelperLibrary();
      return library.tracecode.browser.BrowserCompileAndTraceLibrary;
    })();
  }
  return compileLibraryClassPromise;
}

async function getRewriteLibraryClass() {
  if (!rewriteLibraryClassPromise) {
    rewriteLibraryClassPromise = (async () => {
      const library = await getHelperLibrary();
      return library.harness.browser.JavaRewriteLibrary;
    })();
  }
  return rewriteLibraryClassPromise;
}

async function warmRunHost() {
  if (!runWarmupPromise) {
    runWarmupPromise = (async () => {
      const totalStart = performance.now();
      const libraryClass = await getCompileLibraryClass();
      const runSourcePath = '/str/ExportsTracecodeRunWarmup.java';
      const runClassesDir = '/files/java-worker/__warm_run__/classes';
      const runWarmupSource = `
package harness.user.warmup;

import tracecode.user.TraceHooks;

class Solution {
  int add(int a, int b) {
    return a + b;
  }
}

public class ExportsTracecodeRunWarmup {
  public static String run() {
    Solution solution = new Solution();
    int a = 1;
    int b = 2;
    int result = solution.add(a, b);
    return TraceHooks.serializeOutputResult(result);
  }
}
`;
      await self.cheerpOSAddStringFile(runSourcePath, runWarmupSource);
      const hostCallStart = performance.now();
      const reportText = await libraryClass.compileAndRun(
        runSourcePath,
        runClassesDir,
        'harness.user.warmup.ExportsTracecodeRunWarmup',
        HELPER_JAR_PATH,
        DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
      );
      const hostCallEnd = performance.now();
      const report = JSON.parse(reportText);
      const totalEnd = performance.now();
      if (report.success !== true) {
        throw new Error(report.runtimeError || report.compilerStderr || report.compilerStdout || 'Java warmup failed');
      }
      return {
        success: true,
        loadTimeMs: Math.round(totalEnd - totalStart),
        timings: {
          totalMs: totalEnd - totalStart,
          hostCallMs: hostCallEnd - hostCallStart,
          compileMs: report.compileTimeMs ?? 0,
          classLoadMs: report.classLoadTimeMs ?? 0,
          runMs: report.runTimeMs ?? 0,
          compileCacheHit: report.compileCacheHit ?? false,
        },
      };
    })();
  }
  try {
    return await runWarmupPromise;
  } catch (error) {
    runWarmupPromise = null;
    throw error;
  }
}

async function rewriteSource(payload, compileId, dynamicInputs) {
  const rewriteLibraryClass = await getRewriteLibraryClass();
  const exportsClassName = buildExportsClassName(compileId);
  const packageName = buildPackageName(compileId);
  const exportsSource = buildExportsSource(
    payload.code,
    payload.functionName,
    payload.executionStyle,
    payload.inputs ?? {},
    {
      dynamicInputs,
      hasDynamicInputs: dynamicInputs.length > 0,
    }
  );
  const rewrittenSource = await rewriteLibraryClass.rewriteSource(
    payload.code,
    payload.executionStyle,
    payload.functionName,
    exportsSource,
    exportsClassName,
    packageName
  );
  return addJavaDefaultImportsToPackagedSource(rewrittenSource);
}

function normalizePublicClassDeclarations(source) {
  return String(source).replace(/^([ \t]*)public\s+class\s+/gm, '$1class ');
}

function buildPlainRunnableSource(payload, compileId, dynamicInputs) {
  const exportsClassName = buildExportsClassName(compileId);
  const packageName = buildPackageName(compileId);
  const exportsSource = buildExportsSource(
    payload.code,
    payload.functionName,
    payload.executionStyle,
    payload.inputs ?? {},
    {
      dynamicInputs,
      hasDynamicInputs: dynamicInputs.length > 0,
    }
  ).replaceAll(/\bpublic class Exports\b/g, `public class ${exportsClassName}`);

  return [
    `package ${packageName};`,
    '',
    'import tracecode.user.TraceHooks;',
    javaDefaultImportsBlock(),
    '',
    normalizePublicClassDeclarations(payload.code).trim(),
    '',
    exportsSource.trim(),
    '',
  ].join('\n');
}

function buildBatchRunnableSource(payload, compileId, inputBatch, dynamicInputBatch) {
  const exportsClassName = buildExportsClassName(compileId);
  const packageName = buildPackageName(compileId);
  const entryClasses = [];
  const sourceParts = [
    `package ${packageName};`,
    '',
    'import tracecode.user.TraceHooks;',
    javaDefaultImportsBlock(),
    '',
    normalizePublicClassDeclarations(payload.code).trim(),
    '',
  ];

  for (let index = 0; index < inputBatch.length; index += 1) {
    const className = index === 0 ? exportsClassName : `${exportsClassName}Case${index}`;
    const dynamicInputs = dynamicInputBatch[index] ?? [];
    const exportsSource = buildExportsSource(
      payload.code,
      payload.functionName,
      payload.executionStyle,
      inputBatch[index] ?? {},
      {
        dynamicInputs,
        hasDynamicInputs: dynamicInputs.length > 0,
      }
    ).replaceAll(
      /\bpublic class Exports\b/g,
      `${index === 0 ? 'public class' : 'class'} ${className}`
    );
    entryClasses.push(`${packageName}.${className}`);
    sourceParts.push(exportsSource.trim(), '');
  }

  return {
    source: sourceParts.join('\n'),
    entryClasses,
  };
}

function buildCompileProbeSource(payload, requestId, probeClassName, probePackageName) {
  const exportsSource = buildExportsSource(
    payload.code,
    payload.functionName,
    payload.executionStyle,
    payload.inputs ?? {}
  ).replaceAll(/\bpublic class Exports\b/g, `public class ${probeClassName}`);
  return [
    `package ${probePackageName};`,
    '',
    'import tracecode.user.TraceHooks;',
    javaDefaultImportsBlock(),
    '',
    normalizePublicClassDeclarations(payload.code).trim(),
    '',
    exportsSource.trim(),
    '',
  ].join('\n');
}

async function collectCompileProbeDiagnostics(payload, requestId, options) {
  const probeClassName = buildExportsClassName(`${requestId}RewriteProbe`);
  const probePackageName = buildPackageName(`${requestId}RewriteProbe`);
  const sourcePath = `/str/${probeClassName}.java`;
  const classesDir = `/files/java-worker/${requestId}/rewrite-probe/classes`;

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    return {
      consoleOutput: [],
      error: null,
      hostCallMs: 0,
      diagnosticError: formatWorkerErrorMessage(error),
    };
  }

  try {
    await self.cheerpOSAddStringFile(
      sourcePath,
      buildCompileProbeSource(payload, requestId, probeClassName, probePackageName)
    );
  } catch (error) {
    return {
      consoleOutput: [],
      error: null,
      hostCallMs: 0,
      diagnosticError: formatWorkerErrorMessage(error),
    };
  }

  const startedAt = performance.now();
  let reportText;
  try {
    reportText = await compileLibraryClass.compileAndTrace(
      sourcePath,
      classesDir,
      `${probePackageName}.${probeClassName}`,
      HELPER_JAR_PATH,
      DEFAULT_COMPILER_DEBUG_PROFILE,
      String(resolveMaxStoredEvents(options))
    );
  } catch (error) {
    return {
      consoleOutput: [],
      error: null,
      hostCallMs: performance.now() - startedAt,
      diagnosticError: formatWorkerErrorMessage(error),
    };
  }

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    return {
      consoleOutput: [],
      error: null,
      hostCallMs: performance.now() - startedAt,
      diagnosticError: `Invalid compile probe report: ${formatWorkerErrorMessage(error)}`,
    };
  }

  const consoleOutput = [report.compilerStdout, report.compilerStderr].filter(
    (entry) => typeof entry === 'string' && entry.trim().length > 0
  );
  const surfacedError =
    report.runtimeError ||
    report.compilerStderr ||
    report.compilerStdout ||
    null;

  return {
    consoleOutput,
    error: surfacedError,
    hostCallMs: performance.now() - startedAt,
    diagnosticError: null,
  };
}

function normalizeScriptTraceEvents(events, scriptMode, userCodeLineCount, sourceLineMap) {
  if (!scriptMode || !Array.isArray(events)) return events;
  return events.map((event) => {
    if (String(event).startsWith('trace:')) {
      try {
        const parsed = JSON.parse(String(event).slice('trace:'.length));
        if (parsed.function === SCRIPT_METHOD_NAME) parsed.function = '<module>';
        if (parsed.kind === 'call' && parsed.function === SCRIPT_METHOD_NAME) parsed.function = '<module>';
        if (parsed.kind === 'return' && parsed.function === SCRIPT_METHOD_NAME) parsed.function = '<module>';
        if (
          typeof parsed.line === 'number' &&
          sourceLineMap &&
          Object.prototype.hasOwnProperty.call(sourceLineMap, String(parsed.line))
        ) {
          const mappedLine = Number(sourceLineMap[String(parsed.line)]);
          if (Number.isFinite(mappedLine) && mappedLine > 0) parsed.line = mappedLine;
        }
        if (
          parsed.kind === 'return' &&
          parsed.function === '<module>' &&
          Number.isFinite(userCodeLineCount) &&
          userCodeLineCount > 0 &&
          parsed.line > userCodeLineCount
        ) {
          parsed.line = userCodeLineCount;
        }
        return `trace:${JSON.stringify(parsed)}`;
      } catch {
        return event;
      }
    }
    return event;
  });
}

function parseTraceLineNumber(event) {
  if (String(event).startsWith('trace:')) {
    try {
      const parsed = JSON.parse(String(event).slice('trace:'.length));
      const line = Number(parsed.line);
      return Number.isFinite(line) && line > 0 ? line : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isBareTraceLineEvent(event) {
  if (String(event).startsWith('trace:')) {
    try {
      const parsed = JSON.parse(String(event).slice('trace:'.length));
      return parsed.kind === 'line';
    } catch {
      return false;
    }
  }
  return false;
}

function buildBareTraceLineEvent(line, templateEvent) {
  if (String(templateEvent).startsWith('trace:')) {
    return `trace:${JSON.stringify({ kind: 'line', line })}`;
  }
  return `trace:${JSON.stringify({ kind: 'line', line })}`;
}

function cloneNativeSnapshotEventAtLine(event, line) {
  if (!String(event).startsWith('trace:')) return null;
  try {
    const parsed = JSON.parse(String(event).slice('trace:'.length));
    if (parsed.kind !== 'snapshot') return null;
    return `trace:${JSON.stringify({ ...parsed, line })}`;
  } catch {
    return null;
  }
}

function parseNativeSnapshotVariable(event) {
  if (!String(event).startsWith('trace:')) return null;
  try {
    const parsed = JSON.parse(String(event).slice('trace:'.length));
    if (parsed.kind !== 'snapshot') return null;
    const variable = parsed.target && typeof parsed.target.variable === 'string'
      ? parsed.target.variable
      : null;
    return variable;
  } catch {
    return null;
  }
}

function collectJavaLineDeclarationsForHeaderExpansion(line) {
  const names = [];
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

function collectJavaControlHeaderDeclarations(line) {
  const forMatch = /\bfor\s*\(\s*(?:final\s+)?(?:[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^;=(){}:]+>)?|\w+(?:\s*\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)/.exec(line);
  return forMatch?.[1] ? [forMatch[1]] : [];
}

function buildControlHeaderInfo(sourceText) {
  if (typeof sourceText !== 'string' || sourceText.length === 0) return null;
  const lines = sourceText.split(/\r?\n/);
  const loopBodyLineToHeader = new Map();
  const headerLineToExcludedVariables = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isLoopHeader = /\b(?:for|while)\s*\(/.test(line);
    const isControlHeader = /\b(?:for|while|if|else\s+if)\s*\(/.test(line);
    if (!isControlHeader || !line.includes('{')) continue;

    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const trimmed = lines[bodyIndex].trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('}')) break;
      const headerInfo = {
        line: index + 1,
        excludedVariables: new Set(collectJavaLineDeclarationsForHeaderExpansion(lines[bodyIndex])),
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

function expandLoopHeaderTraceEvents(events, sourceText) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const controlHeaderInfo = buildControlHeaderInfo(sourceText);
  if (!controlHeaderInfo) return events;
  const { loopBodyLineToHeader, headerLineToExcludedVariables } = controlHeaderInfo;

  const expanded = [];
  const latestSnapshotByVariable = new Map();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const line = parseTraceLineNumber(event);
    const snapshotVariable = parseNativeSnapshotVariable(event);
    if (
      line !== null &&
      snapshotVariable &&
      headerLineToExcludedVariables.get(line)?.has(snapshotVariable)
    ) {
      continue;
    }
    const headerInfo = line === null ? undefined : loopBodyLineToHeader.get(line);
    const headerLine = headerInfo?.line;
    const previousLine = expanded.length > 0 ? parseTraceLineNumber(expanded[expanded.length - 1]) : null;
    if (headerLine !== undefined && isBareTraceLineEvent(event) && previousLine !== headerLine) {
      expanded.push(buildBareTraceLineEvent(headerLine, event));
      for (const [variable, snapshotEvent] of latestSnapshotByVariable) {
        if (headerInfo.excludedVariables.has(variable)) continue;
        const clonedSnapshot = cloneNativeSnapshotEventAtLine(snapshotEvent, headerLine);
        if (clonedSnapshot) expanded.push(clonedSnapshot);
      }
    }
    if (headerLine !== undefined && isBareTraceLineEvent(event)) {
      for (let lookahead = index + 1; lookahead < events.length; lookahead += 1) {
        if (parseTraceLineNumber(events[lookahead]) !== line) break;
        const variable = parseNativeSnapshotVariable(events[lookahead]);
        if (!variable || !headerInfo.headerVariables.has(variable)) continue;
        const clonedSnapshot = cloneNativeSnapshotEventAtLine(events[lookahead], headerLine);
        if (clonedSnapshot) expanded.push(clonedSnapshot);
      }
    }
    expanded.push(event);
    if (snapshotVariable) {
      latestSnapshotByVariable.set(snapshotVariable, event);
    }
  }
  return expanded;
}

function normalizeJavaExecutionPayload(payload) {
  assertSupportedExecutionStyle(payload.executionStyle);
  if (typeof payload.code !== 'string') {
    throw new Error('`code` must be a string');
  }
  const scriptRequest = isScriptRequest(payload);
  if (!scriptRequest && (typeof payload.functionName !== 'string' || payload.functionName.trim().length === 0)) {
    throw new Error('Java execution requires a non-empty functionName or class entry name.');
  }

  try {
    return normalizeJavaRequest(payload);
  } catch (error) {
    throw makeWorkerStageError('request normalization', error);
  }
}

function javaReportConsoleOutput(report) {
  return [report.compilerStdout, report.compilerStderr].filter(
    (entry) => typeof entry === 'string' && entry.trim().length > 0
  );
}

function parseJavaReportOutput(output) {
  return output ? normalizeJavaSerializedOutput(JSON.parse(output)) : undefined;
}

function normalizeProjectFilePath(path) {
  const normalized = String(path ?? '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project file path must be relative: ${path}`);
  }

  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error(`Project file path must not escape the workspace: ${path}`);
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new Error(`Project file path must point to a file: ${path}`);
  }
  return parts.join('/');
}

function normalizeProjectPathWithinWorkspace(path, allowEmpty = false) {
  const normalized = String(path ?? '').replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project path must be relative: ${path}`);
  }

  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error(`Project path must not escape the workspace: ${path}`);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    if (allowEmpty) return '';
    throw new Error(`Project path must point to a file: ${path}`);
  }
  return parts.join('/');
}

function normalizeProjectDirectoryPath(path) {
  return normalizeProjectPathWithinWorkspace(path, true);
}

function normalizeProjectRoot(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw || !raw.startsWith('/')) return '';
  return raw || '/';
}

function projectVirtualRoot(project) {
  return normalizeProjectRoot(project?.workspaceRoot || project?.cwd || '/workspace') || '/workspace';
}

function projectVirtualRoots(project, fallbackProjectCwd = '/workspace') {
  const roots = [];
  for (const value of [project?.workspaceRoot, project?.cwd, fallbackProjectCwd, project?.workspaceAlias, '/workspace']) {
    const root = normalizeProjectRoot(value);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function stripProjectVirtualPrefix(value, project, fallbackProjectCwd = '/workspace') {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  for (const root of projectVirtualRoots(project, fallbackProjectCwd)) {
    if (normalized === root) return '';
    if (root !== '/' && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  return null;
}

function projectRelativeCwd(payload) {
  const projectCwd = projectVirtualRoot(payload?.project);
  const requestCwd = String(payload?.cwd || projectCwd).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const stripped = stripProjectVirtualPrefix(requestCwd, payload?.project, projectCwd);
  if (stripped !== null) {
    return normalizeProjectDirectoryPath(stripped);
  }
  throw new Error(`Project cwd must stay inside the workspace: ${requestCwd}`);
}

function resolveProjectCommandPath(path, relativeCwd, projectCwd = '/workspace', allowEmpty = false, project) {
  const raw = String(path ?? '').replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    const stripped = stripProjectVirtualPrefix(raw, project, projectCwd);
    if (stripped !== null) return normalizeProjectPathWithinWorkspace(stripped, allowEmpty) || '.';
    throw new Error(`Project path must stay within the workspace: ${path}`);
  }
  const joined = relativeCwd ? `${relativeCwd}/${raw}` : raw;
  const resolved = normalizeProjectPathWithinWorkspace(joined, allowEmpty);
  return resolved || '.';
}

function javaStringLiteral(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function base64Utf8(value) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64');
  }

  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function projectJavaFiles(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  return files
    .map((file) => ({
      path: normalizeProjectFilePath(file?.path),
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    }))
    .filter((file) => file.path.endsWith('.java'))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function projectJavaClasspathFiles(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  return files
    .map((file) => ({
      path: normalizeProjectFilePath(file?.path),
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    }))
    .filter((file) => file.path.endsWith('.class') || file.path.endsWith('.jar'))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function projectJavaWorkspaceFiles(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  return files
    .map((file) => ({
      path: normalizeProjectFilePath(file?.path),
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function projectJavaWorkspaceDirectories(project) {
  const directories = Array.isArray(project?.directories) ? project.directories : [];
  return Array.from(new Set(
    directories
      .map((directory) => normalizeProjectDirectoryPath(directory))
      .filter(Boolean)
  )).sort((left, right) => left.localeCompare(right));
}

function projectFileMap(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  const map = new Map();
  for (const file of files) {
    map.set(normalizeProjectFilePath(file?.path), {
      contents: String(file?.contents ?? ''),
      encoding: file?.encoding ?? 'utf8',
    });
  }
  return map;
}

function projectFileManifestEntry(file) {
  const contents = file.encoding === 'base64' ? file.contents : base64Utf8(file.contents);
  return `${file.path}\t${contents}`;
}

function projectDirectoryManifestEntry(directory) {
  return `\tdir\t${directory}`;
}

function projectWorkspaceManifest(project) {
  return [
    ...projectJavaWorkspaceDirectories(project).map(projectDirectoryManifestEntry),
    ...projectJavaWorkspaceFiles(project).map(projectFileManifestEntry),
  ].join('\n');
}

function projectWorkspaceCwd(payload, workspaceRoot) {
  const relativeCwd = projectRelativeCwd(payload);
  return relativeCwd ? `${workspaceRoot}/${relativeCwd}` : workspaceRoot;
}

function assertProjectJavaSource(file) {
  if (file.encoding !== 'utf8') {
    throw new Error(`Browser Java project runner only supports utf8 Java source files: ${file.path}`);
  }
}

function assertProjectJavaClasspathFile(file) {
  if (file.encoding !== 'base64') {
    throw new Error(`Browser Java project runner only supports base64 Java classpath files: ${file.path}`);
  }
}

function assertProjectMainClass(value) {
  const mainClass = String(value ?? '').trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(mainClass)) {
    throw new Error(`Browser Java project runner requires a Java class name: ${value}`);
  }
  return mainClass;
}

function projectJarMainClass(payload) {
  const mainClass = payload?.options?.jarMainClass;
  if (typeof mainClass === 'string' && mainClass.trim().length > 0) {
    return assertProjectMainClass(mainClass);
  }
  throw new Error('Browser Java -jar execution requires a manifest Main-Class.');
}

function javaProjectBasename(path) {
  return path.split('/').at(-1);
}

function javaProjectSourcePath(file) {
  return file.path;
}

function augmentJavaProjectFileMutations(source) {
  return String(source ?? '')
    .replace(/\bjava\.nio\.file\.Files\.(writeString|write|newOutputStream|newBufferedWriter|deleteIfExists|delete|copy|move)\s*\(/g, 'tracecode.browser.ProjectEvents.$1(')
    .replace(/(?<![\w.])Files\.(writeString|write|newOutputStream|newBufferedWriter|deleteIfExists|delete|copy|move)\s*\(/g, 'tracecode.browser.ProjectEvents.$1(')
    .replace(/\bnew\s+java\.io\.FileWriter\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileWriter(')
    .replace(/(?<![\w.])new\s+FileWriter\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileWriter(')
    .replace(/\bnew\s+java\.io\.FileOutputStream\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileOutputStream(')
    .replace(/(?<![\w.])new\s+FileOutputStream\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectFileOutputStream(')
    .replace(/\bnew\s+java\.io\.PrintWriter\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectPrintWriter(')
    .replace(/(?<![\w.])new\s+PrintWriter\s*\(/g, 'new tracecode.browser.ProjectEvents.ProjectPrintWriter(');
}

function javaProjectSystemProperties(payload) {
  const properties = payload?.options?.systemProperties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return [];
  }
  return Object.entries(properties)
    .filter(([key]) => typeof key === 'string' && key.length > 0 && !key.includes('=') && !key.includes('\0'))
    .map(([key, value]) => [key, String(value ?? '')]);
}

function javaProjectEnvClasspath(payload) {
  return typeof payload?.env?.CLASSPATH === 'string' && payload.env.CLASSPATH.trim().length > 0
    ? payload.env.CLASSPATH
    : null;
}

function javaProjectEffectiveClasspath(payload) {
  return typeof payload?.options?.classpath === 'string'
    ? payload.options.classpath
    : javaProjectEnvClasspath(payload);
}

function buildProjectJavaAdapterSource(exportsClassName, mainClassName, args, compileOnly, stdin = '', systemProperties = []) {
  const argsSource = args.map((arg) => javaStringLiteral(arg)).join(', ');
  const stdinSource = javaStringLiteral(stdin);
  const propertyKeysSource = systemProperties.map(([key]) => javaStringLiteral(key)).join(', ');
  const propertyValuesSource = systemProperties.map(([, value]) => javaStringLiteral(value)).join(', ');
  const invocation = compileOnly
    ? ''
    : `      ${mainClassName}.main(new String[] { ${argsSource} });`;

  return `
import tracecode.user.TraceHooks;
import tracecode.browser.ProjectEvents;
import java.io.*;

public class ${exportsClassName} {
  private static String __tracecodeJsonString(String value) {
    if (value == null) return "null";
    StringBuilder out = new StringBuilder();
    out.append('"');
    for (int index = 0; index < value.length(); index += 1) {
      char ch = value.charAt(index);
      switch (ch) {
        case '"': out.append("\\\\\\""); break;
        case '\\\\': out.append("\\\\\\\\"); break;
        case '\\b': out.append("\\\\b"); break;
        case '\\f': out.append("\\\\f"); break;
        case '\\n': out.append("\\\\n"); break;
        case '\\r': out.append("\\\\r"); break;
        case '\\t': out.append("\\\\t"); break;
        default:
          if (ch < 0x20) {
            String hex = Integer.toHexString(ch);
            out.append("\\\\u");
            for (int pad = hex.length(); pad < 4; pad += 1) out.append('0');
            out.append(hex);
          } else {
            out.append(ch);
          }
      }
    }
    out.append('"');
    return out.toString();
  }

  private static String __tracecodeProjectResult(String stdout, String stderr, int exitCode) {
    return "{\\"stdout\\":" + __tracecodeJsonString(stdout)
      + ",\\"stderr\\":" + __tracecodeJsonString(stderr)
      + ",\\"exitCode\\":" + exitCode + "}";
  }

  public static String run() {
    java.io.PrintStream previousOut = System.out;
    java.io.PrintStream previousErr = System.err;
    java.io.InputStream previousIn = System.in;
    String[] propertyKeys = new String[] { ${propertyKeysSource} };
    String[] propertyValues = new String[] { ${propertyValuesSource} };
    java.util.Properties previousProperties = new java.util.Properties();
    java.io.ByteArrayOutputStream stdoutBytes = new java.io.ByteArrayOutputStream();
    java.io.ByteArrayOutputStream stderrBytes = new java.io.ByteArrayOutputStream();
    int exitCode = 0;
    try {
      for (String key : propertyKeys) {
        String previousValue = System.getProperty(key);
        if (previousValue != null) previousProperties.setProperty(key, previousValue);
      }
      for (int index = 0; index < propertyKeys.length; index += 1) {
        System.setProperty(propertyKeys[index], propertyValues[index]);
      }
      ProjectEvents.setProjectEventBridgeEnabled(true);
      ProjectEvents.setProjectWorkspaceRoot(java.nio.file.Paths.get(System.getProperty("user.dir", ".")));
      System.setOut(new java.io.PrintStream(ProjectEvents.streamingOutput(stdoutBytes, "stdout"), true, "UTF-8"));
      System.setErr(new java.io.PrintStream(ProjectEvents.streamingOutput(stderrBytes, "stderr"), true, "UTF-8"));
      System.setIn(new java.io.ByteArrayInputStream(${stdinSource}.getBytes("UTF-8")));
${invocation}
    } catch (Throwable error) {
      exitCode = 1;
      error.printStackTrace();
    } finally {
      System.out.flush();
      System.err.flush();
      System.setOut(previousOut);
      System.setErr(previousErr);
      System.setIn(previousIn);
      ProjectEvents.setProjectWorkspaceRoot(null);
      ProjectEvents.setProjectEventBridgeEnabled(false);
      for (String key : propertyKeys) {
        if (previousProperties.containsKey(key)) {
          System.setProperty(key, previousProperties.getProperty(key));
        } else {
          System.clearProperty(key);
        }
      }
    }
    try {
      return TraceHooks.serializeOutputResult(__tracecodeProjectResult(
        stdoutBytes.toString("UTF-8"),
        stderrBytes.toString("UTF-8"),
        exitCode
      ));
    } catch (java.io.UnsupportedEncodingException error) {
      return TraceHooks.serializeOutputResult(__tracecodeProjectResult("", error.toString(), 1));
    }
  }
}
`;
}

function buildProjectJavaRunnableSource(payload, compileId) {
  const files = projectJavaFiles(payload.project);
  if (files.length === 0) {
    throw new Error('Java project execution requires at least one .java file.');
  }

  files.forEach(assertProjectJavaSource);
  const classpathFiles = projectJavaClasspathFiles(payload.project);
  classpathFiles.forEach(assertProjectJavaClasspathFile);
  const exportsClassName = buildExportsClassName(compileId);
  const compileOnly = payload.source === 'compile';
  const relativeCwd = projectRelativeCwd(payload);
  const projectCwd = projectVirtualRoot(payload?.project);
  if (compileOnly) {
    assertBrowserProjectJavacOptionsSupported(payload.args, payload.project, relativeCwd, projectCwd);
  }
  const mainClassName = compileOnly ? javaProjectBasename(files[0].path).replace(/\.java$/, '') : assertProjectMainClass(payload.scriptPath);
  const projectFiles = files.map((file) => ({
    path: javaProjectSourcePath(file),
    source: compileOnly ? file.contents : augmentJavaProjectFileMutations(file.contents),
  }));
  const adapter = compileOnly
    ? null
    : {
        path: `${exportsClassName}.java`,
        source: buildProjectJavaAdapterSource(
          exportsClassName,
          mainClassName,
          Array.isArray(payload.args) ? payload.args : [],
          false,
          String(payload.stdin ?? ''),
          javaProjectSystemProperties(payload)
        ).trim(),
      };

  const classpathRoot = `/files/java-worker/${compileId}/classpath`;
  const workspaceRoot = `/files/java-worker/${compileId}/workspace`;
  const sourceEntries = adapter === null ? projectFiles : [...projectFiles, adapter];
  return {
    classpathManifest: classpathFiles
      .map((file) => `${file.path}\t${file.contents}`)
      .join('\n'),
    classpathRoot,
    compileClasspath: javaProjectClasspath(
      javaCompileClasspath(payload.args, payload.project, relativeCwd, projectCwd) ?? javaProjectEnvClasspath(payload),
      classpathRoot,
      compileOnly ? undefined : HELPER_JAR_PATH,
      relativeCwd,
      projectCwd,
      payload.project
    ),
    compileSourcePaths: javaCompileSourcePaths(payload.args, payload.project, relativeCwd, projectCwd).join('\n'),
    compileSourceRootPaths: javaCompileSourceRootPaths(payload.args, payload.project, relativeCwd, projectCwd).join('\n'),
    workspaceManifest: projectWorkspaceManifest(payload.project),
    workspaceRoot,
    workspaceCwd: projectWorkspaceCwd(payload, workspaceRoot),
    sourceManifest: sourceEntries
      .map((file) => `${file.path}\t${base64Utf8(file.source)}`)
      .join('\n'),
    sourceRoot: `/files/java-worker/${compileId}/sources`,
    classesDir: `/files/java-worker/${compileId}/classes`,
    mainClassName: exportsClassName,
  };
}

function buildProjectJavaClassRunnableSource(payload, compileId) {
  const classpathFiles = projectJavaClasspathFiles(payload.project);
  if (classpathFiles.length === 0) {
    throw new Error('Java classpath execution requires persisted .class or .jar files.');
  }

  classpathFiles.forEach(assertProjectJavaClasspathFile);
  const exportsClassName = buildExportsClassName(compileId);
  const mainClassName = typeof payload?.options?.jarPath === 'string'
    ? projectJarMainClass(payload)
    : assertProjectMainClass(payload.scriptPath);
  const relativeCwd = projectRelativeCwd(payload);
  const projectCwd = projectVirtualRoot(payload?.project);
  const adapter = {
    path: `${exportsClassName}.java`,
    source: buildProjectJavaAdapterSource(
      exportsClassName,
      mainClassName,
      Array.isArray(payload.args) ? payload.args : [],
      false,
      String(payload.stdin ?? ''),
      javaProjectSystemProperties(payload)
    ).trim(),
  };

  const classRoot = `/files/java-worker/${compileId}/classpath`;
  const workspaceRoot = `/files/java-worker/${compileId}/workspace`;
  return {
    classManifest: classpathFiles
      .map((file) => `${file.path}\t${file.contents}`)
      .join('\n'),
    sourceManifest: `${adapter.path}\t${base64Utf8(adapter.source)}`,
    sourceRoot: `/files/java-worker/${compileId}/sources`,
    classesDir: `/files/java-worker/${compileId}/classes`,
    classRoot,
    workspaceManifest: projectWorkspaceManifest(payload.project),
    workspaceRoot,
    workspaceCwd: projectWorkspaceCwd(payload, workspaceRoot),
    runtimeClasspath: javaProjectClasspath(javaProjectEffectiveClasspath(payload), classRoot, undefined, relativeCwd, projectCwd, payload.project),
    mainClassName: exportsClassName,
  };
}

function javaExpandedCompilerArgs(args, project, relativeCwd = '', projectCwd = '/workspace') {
  if (!Array.isArray(args)) return [];
  const files = projectFileMap(project);
  const expand = (items, seen) => {
    const out = [];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      if (!item.startsWith('@') || item === '@') {
        out.push(item);
        continue;
      }

      const argPath = resolveProjectCommandPath(item.slice(1), relativeCwd, projectCwd, false, project);
      if (seen.has(argPath)) {
        throw new Error(`Recursive Java argfile reference: ${argPath}`);
      }
      const file = files.get(argPath);
      if (!file) {
        throw new Error(`Java argfile not found: ${argPath}`);
      }
      if (file.encoding !== 'utf8') {
        throw new Error(`Java argfile must be utf8: ${argPath}`);
      }
      seen.add(argPath);
      out.push(...expand(parseJavaArgFile(file.contents), seen));
      seen.delete(argPath);
    }
    return out;
  };
  return expand(args, new Set());
}

function assertBrowserProjectJavacOptionsSupported(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  if (expandedArgs.includes('--enable-preview')) {
    throw new Error('javac: --enable-preview is not supported in the browser project environment');
  }
}

function parseJavaArgFile(contents) {
  const args = [];
  let current = '';
  let quote = null;
  let escaping = false;
  for (const ch of String(contents ?? '')) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current.length > 0) args.push(current);
  return args;
}

function javaCompileClasspath(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  let classpath = null;
  for (let index = 0; index < expandedArgs.length; index += 1) {
    const arg = expandedArgs[index];
    if (arg === '-cp' || arg === '-classpath' || arg === '--class-path') {
      classpath = typeof expandedArgs[index + 1] === 'string' ? expandedArgs[index + 1] : null;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--class-path=')) {
      classpath = arg.slice('--class-path='.length);
    }
  }
  return classpath;
}

const JAVAC_OPTIONS_WITH_OPERAND = new Set([
  '-bootclasspath',
  '-classpath',
  '-cp',
  '-d',
  '-encoding',
  '-endorseddirs',
  '-extdirs',
  '-h',
  '-module',
  '-modulepath',
  '-processor',
  '-processorpath',
  '-profile',
  '-s',
  '-source',
  '-sourcepath',
  '-target',
  '--add-exports',
  '--add-modules',
  '--add-reads',
  '--boot-class-path',
  '--class-path',
  '--default-module-for-created-files',
  '--limit-modules',
  '--module',
  '--module-path',
  '--module-source-path',
  '--processor',
  '--processor-module-path',
  '--processor-path',
  '--release',
  '--source',
  '--source-path',
  '--system',
  '--target',
  '--upgrade-module-path',
]);

function javacOptionConsumesNext(arg) {
  if (typeof arg !== 'string') return false;
  if (JAVAC_OPTIONS_WITH_OPERAND.has(arg)) return true;
  if (/^-A[^=].+/.test(arg)) return false;
  return false;
}

function javaCompileSourcePaths(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  const sources = [];
  for (let index = 0; index < expandedArgs.length; index += 1) {
    const arg = expandedArgs[index];
    if (javacOptionConsumesNext(arg)) {
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--') && arg.includes('=')) {
      continue;
    }
    if (typeof arg === 'string' && arg.endsWith('.java')) {
      sources.push(resolveProjectCommandPath(arg, relativeCwd, projectCwd, false, project));
    }
  }
  return sources;
}

function javaCompileSourceRootPaths(args, project, relativeCwd = '', projectCwd = '/workspace') {
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  const roots = [];
  for (let index = 0; index < expandedArgs.length; index += 1) {
    const arg = expandedArgs[index];
    if (arg === '-sourcepath' || arg === '--source-path') {
      const sourcepath = expandedArgs[index + 1];
      if (typeof sourcepath === 'string') {
        roots.push(...sourcepath
          .split(':')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => resolveProjectCommandPath(entry, relativeCwd, projectCwd, true, project)));
      }
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--source-path=')) {
      roots.push(...arg.slice('--source-path='.length)
        .split(':')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => resolveProjectCommandPath(entry, relativeCwd, projectCwd, true, project)));
    }
  }
  return roots;
}

function javaProjectClasspath(rawClasspath, classRoot, extraEntry, relativeCwd = '', projectCwd = '/workspace', project) {
  const entries = [];
  if (typeof rawClasspath !== 'string' || rawClasspath.trim().length === 0) {
    entries.push(relativeCwd ? `${classRoot}/${relativeCwd}` : classRoot);
  } else {
    entries.push(...rawClasspath
      .split(':')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const resolved = resolveProjectCommandPath(entry, relativeCwd, projectCwd, true, project);
        return resolved ? `${classRoot}/${resolved}` : classRoot;
      }));
  }

  if (typeof extraEntry === 'string' && extraEntry.length > 0) {
    entries.push(extraEntry);
  }
  return entries.join(':');
}

function javaJavacVerboseRequested(args, project, relativeCwd = '', projectCwd = '/workspace') {
  return javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd)
    .some((arg) => arg === '-verbose' || arg === '--verbose');
}

function javaSyntheticJavacVerboseOutput(payload, outputDir) {
  const relativeCwd = projectRelativeCwd(payload);
  const projectCwd = projectVirtualRoot(payload?.project);
  const sourcePaths = javaCompileSourcePaths(payload.args, payload.project, relativeCwd, projectCwd);
  const sourceRoots = javaCompileSourceRootPaths(payload.args, payload.project, relativeCwd, projectCwd);
  const classpath = javaCompileClasspath(payload.args, payload.project, relativeCwd, projectCwd);
  const classOutputDir = normalizeJavaOutputDir(outputDir);
  const lines = [
    '[parsing started SimpleFileObject[/workspace]]',
  ];
  for (const sourcePath of sourcePaths) {
    lines.push(`[parsing started DirectoryFileObject[${sourcePath}]]`);
    lines.push('[parsing completed 1ms]');
  }
  lines.push(`[search path for source files: ${sourceRoots.length > 0 ? sourceRoots.join(',') : '.'}]`);
  lines.push(`[search path for class files: ${classpath || '.'}]`);
  for (const sourcePath of sourcePaths) {
    lines.push(`[checking ${javaSyntheticClassNameForSource(sourcePath)}]`);
  }
  for (const sourcePath of sourcePaths) {
    lines.push(`[wrote ${javaSyntheticClassOutputPath(sourcePath, classOutputDir, projectCwd)}]`);
  }
  return `${lines.join('\n')}\n`;
}

function javaSyntheticClassNameForSource(sourcePath) {
  const fileName = String(sourcePath).split('/').pop() || 'Main.java';
  return fileName.replace(/\.java$/i, '');
}

function javaSyntheticClassOutputPath(sourcePath, outputDir, projectCwd = '/workspace') {
  const withoutExtension = String(sourcePath).replace(/\.java$/i, '.class');
  const relativeOutput = outputDir === '.' ? withoutExtension : `${outputDir}/${withoutExtension}`;
  return `${projectCwd.replace(/\/+$/, '') || '/workspace'}/${relativeOutput}`;
}

function postProjectEvent(id, payload) {
  if (!id) return;
  postMessageResponse({ id, type: 'project-event', payload });
}

function emitJavaProjectResultEvents(id, result, options = {}) {
  if (!id || !result) return;
  const skipStdout = options.skipStdout === true;
  const skipStderr = options.skipStderr === true;
  if (!skipStdout && typeof result.stdout === 'string' && result.stdout.length > 0) {
    postProjectEvent(id, {
      type: 'output',
      stream: 'stdout',
      device: '/dev/stdout',
      data: result.stdout,
    });
  }
  if (!skipStderr && typeof result.stderr === 'string' && result.stderr.length > 0) {
    postProjectEvent(id, {
      type: 'output',
      stream: 'stderr',
      device: '/dev/stderr',
      data: result.stderr,
    });
  }
  if (Array.isArray(result.files)) {
    for (const change of result.files) {
      postProjectEvent(id, {
        type: 'file-change',
        phase: 'final-diff',
        change,
      });
    }
  }
}

function commandResultFromJavaProjectReport(report, totalEnd, totalStart, libraryCallEnd, libraryCallStart, outputDir, payload) {
  let compilerOutput = javaReportConsoleOutput(report).join('\n');
  if (
    report.success === true &&
    payload?.source === 'compile' &&
    compilerOutput.length === 0 &&
    javaJavacVerboseRequested(
      payload.args,
      payload.project,
      projectRelativeCwd(payload),
      projectVirtualRoot(payload?.project)
    )
  ) {
    compilerOutput = javaSyntheticJavacVerboseOutput(payload, outputDir);
  }
  if (report.success !== true) {
    return {
      stdout: '',
      stderr: report.runtimeError || report.compilerStderr || report.compilerStdout || 'Java execution failed',
      exitCode: 1,
      timings: {
        hostCallMs: libraryCallEnd - libraryCallStart,
        totalMs: totalEnd - totalStart,
        compileMs: report.compileTimeMs ?? 0,
        classLoadMs: report.classLoadTimeMs ?? 0,
        runMs: report.runTimeMs ?? 0,
        compileCacheHit: report.compileCacheHit ?? false,
      },
    };
  }

  let parsedPayload;
  try {
    const serialized = parseJavaReportOutput(report.output);
    parsedPayload = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  } catch (error) {
    parsedPayload = {
      stdout: '',
      stderr: `Java project result parse failed: ${formatWorkerErrorMessage(error)}`,
      exitCode: 1,
    };
  }

  return {
    stdout: typeof parsedPayload?.stdout === 'string' ? parsedPayload.stdout : '',
    stderr: `${compilerOutput}${typeof parsedPayload?.stderr === 'string' ? parsedPayload.stderr : ''}`,
    exitCode: Number.isInteger(parsedPayload?.exitCode) ? parsedPayload.exitCode : 1,
    files: [
      ...projectCompiledFiles(report, outputDir),
      ...projectChangedFiles(report),
    ],
    timings: {
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: totalEnd - totalStart,
      compileMs: report.compileTimeMs ?? 0,
      classLoadMs: report.classLoadTimeMs ?? 0,
      runMs: report.runTimeMs ?? 0,
      compileCacheHit: report.compileCacheHit ?? false,
    },
  };
}

function javaCompileOutputDir(args, project, relativeCwd = '', projectCwd = '/workspace') {
  if (!Array.isArray(args)) return '.';
  const expandedArgs = javaExpandedCompilerArgs(args, project, relativeCwd, projectCwd);
  for (let index = 0; index < expandedArgs.length; index += 1) {
    const arg = expandedArgs[index];
    if (arg === '-d') {
      return typeof expandedArgs[index + 1] === 'string' && expandedArgs[index + 1].length > 0
        ? resolveProjectCommandPath(expandedArgs[index + 1], relativeCwd, projectCwd, true, project) || '.'
        : '.';
    }
  }
  return relativeCwd || '.';
}

function normalizeJavaOutputDir(path) {
  const raw = String(path ?? '.').trim();
  if (!raw || raw === '.') return '.';
  return normalizeProjectFilePath(raw);
}

function projectCompiledFiles(report, outputDir) {
  if (outputDir == null) return [];
  if (!Array.isArray(report?.compiledFiles)) return [];
  const normalizedOutputDir = normalizeJavaOutputDir(outputDir);
  return report.compiledFiles
    .filter((file) => file && typeof file.path === 'string' && typeof file.contents === 'string')
    .map((file) => ({
      path: normalizedOutputDir === '.'
        ? normalizeProjectFilePath(file.path)
        : normalizeProjectFilePath(`${normalizedOutputDir}/${file.path}`),
      contents: file.contents,
      encoding: file.encoding === 'base64' ? 'base64' : 'utf8',
    }));
}

function projectChangedFiles(report) {
  if (!Array.isArray(report?.changedFiles)) return [];
  return report.changedFiles
    .filter((file) => file && typeof file.path === 'string' && (file.deleted === true || typeof file.contents === 'string'))
    .map((file) => file.deleted === true
      ? { path: normalizeProjectFilePath(file.path), deleted: true }
      : {
          path: normalizeProjectFilePath(file.path),
          contents: file.contents,
          encoding: file.encoding === 'base64' ? 'base64' : 'utf8',
        });
}

async function runJavaTraceRequest(payload, requestId) {
  const totalStart = performance.now();
  const rewriteStart = performance.now();
  const normalizedPayload = normalizeJavaExecutionPayload(payload);

  const compileId = buildJavaCompileId(normalizedPayload, 'trace');
  const dynamicInputs = dynamicInputEntriesForPayload(normalizedPayload, compileId);

  let rewrittenSource;
  try {
    rewrittenSource = await rewriteSource(normalizedPayload, compileId, dynamicInputs);
    rewrittenSource = augmentTraceCallArgumentSnapshots(rewrittenSource);
    rewrittenSource = augmentArrayLengthReads(rewrittenSource);
    rewrittenSource = self.TraceCodeJavaSourceAugmentations.augmentJavaCollectionOperations(
      rewrittenSource,
      normalizedPayload.sourceText
    );
    rewrittenSource = augmentJavaObjectFieldOperations(rewrittenSource);
    rewrittenSource = augmentJavaStdoutEvents(rewrittenSource);
    rewrittenSource = augmentJavaThrowEvents(rewrittenSource);
    rewrittenSource = augmentJavaLocalSnapshots(rewrittenSource);
    rewrittenSource = augmentTraceReturnValueSnapshots(rewrittenSource);
  } catch (error) {
    const rewriteError = formatWorkerErrorMessage(error);
    const skipDiagnosticProbe = rewriteError.includes('unsupported legacy line= TraceHooks hooks');
    const diagnosticProbe = skipDiagnosticProbe
      ? { consoleOutput: [], error: null, hostCallMs: 0, diagnosticError: null }
      : await collectCompileProbeDiagnostics(
          normalizedPayload,
          requestId,
          payload.options
        );
    const totalEnd = performance.now();
    const surfacedError =
      (skipDiagnosticProbe ? null : diagnosticProbe.error) ??
      (rewriteError === 'Java syntax error.'
        ? 'Java syntax error. Check Code Assist for parser details.'
        : `Java source rewrite failed: ${rewriteError}`);
    return {
      success: false,
      events: [],
      ...(normalizedPayload.sourceText ? { sourceText: normalizedPayload.sourceText } : {}),
      executionTimeMs: totalEnd - totalStart,
      consoleOutput: diagnosticProbe.consoleOutput,
      error: surfacedError,
      timings: {
        rewriteMs: totalEnd - rewriteStart,
        hostCallMs: diagnosticProbe.hostCallMs,
        totalMs: totalEnd - totalStart,
      },
    };
  }
  const rewriteEnd = performance.now();

  const exportsClassName = buildExportsClassName(compileId);
  const packageName = buildPackageName(compileId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const classesDir = `/files/java-worker/${compileId}/classes`;

  try {
    await writeDynamicInputFiles(dynamicInputs);
  } catch (error) {
    throw makeWorkerStageError('dynamic input write', error);
  }

  try {
    await self.cheerpOSAddStringFile(sourcePath, rewrittenSource);
  } catch (error) {
    throw makeWorkerStageError('source file write', error);
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    throw makeWorkerStageError('compiler bridge load', error);
  }

  const libraryCallStart = performance.now();
  let reportText;
  try {
    reportText = await compileLibraryClass.compileAndTrace(
      sourcePath,
      classesDir,
      `${packageName}.${exportsClassName}`,
      HELPER_JAR_PATH,
      DEFAULT_COMPILER_DEBUG_PROFILE,
      String(resolveMaxStoredEvents(payload.options))
    );
  } catch (error) {
    throw makeWorkerStageError('compile and trace', error);
  }
  const libraryCallEnd = performance.now();

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    throw makeWorkerStageError('trace report parse', error);
  }
  const totalEnd = performance.now();
  const consoleOutput = javaReportConsoleOutput(report);

  if (report.success !== true) {
    return {
      success: false,
      events: expandLoopHeaderTraceEvents(
        normalizeScriptTraceEvents(
          Array.isArray(report.events) ? report.events : [],
          normalizedPayload.scriptMode,
          normalizedPayload.userCodeLineCount,
          normalizedPayload.sourceLineMap
        ),
        normalizedPayload.sourceText
      ),
      ...(normalizedPayload.sourceText ? { sourceText: normalizedPayload.sourceText } : {}),
      executionTimeMs: totalEnd - totalStart,
      consoleOutput,
      error:
        report.runtimeError ||
        report.compilerStderr ||
        report.compilerStdout ||
        'Java execution failed',
      ...(report.traceLimitExceeded !== undefined
        ? {
            traceLimitExceeded: Boolean(report.traceLimitExceeded),
            timeoutReason: report.traceLimitExceeded ? 'trace-limit' : undefined,
            droppedEventCount: report.droppedEventCount ?? 0,
          }
        : {}),
      timings: {
        rewriteMs: rewriteEnd - rewriteStart,
        hostCallMs: libraryCallEnd - libraryCallStart,
        totalMs: totalEnd - totalStart,
      },
    };
  }

  return {
    success: true,
    output: parseJavaReportOutput(report.output),
    events: expandLoopHeaderTraceEvents(
      normalizeScriptTraceEvents(
        Array.isArray(report.events) ? report.events : [],
        normalizedPayload.scriptMode,
        normalizedPayload.userCodeLineCount,
        normalizedPayload.sourceLineMap
      ),
      normalizedPayload.sourceText
    ),
    ...(normalizedPayload.sourceText ? { sourceText: normalizedPayload.sourceText } : {}),
    executionTimeMs: totalEnd - totalStart,
    consoleOutput,
    ...(report.traceLimitExceeded !== undefined
      ? {
          traceLimitExceeded: Boolean(report.traceLimitExceeded),
          timeoutReason: report.traceLimitExceeded ? 'trace-limit' : undefined,
          droppedEventCount: report.droppedEventCount ?? 0,
        }
      : {}),
    timings: {
      rewriteMs: rewriteEnd - rewriteStart,
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: totalEnd - totalStart,
      compileMs: report.compileTimeMs ?? 0,
      classLoadMs: report.classLoadTimeMs ?? 0,
      runMs: report.runTimeMs ?? 0,
      compileCacheHit: report.compileCacheHit ?? false,
    },
  };
}

async function runJavaCodeRequest(payload) {
  const totalStart = performance.now();
  const normalizedPayload = normalizeJavaExecutionPayload(payload);
  const compileId = buildJavaCompileId(normalizedPayload, 'execute');
  const dynamicInputs = dynamicInputEntriesForPayload(normalizedPayload, compileId);
  const exportsClassName = buildExportsClassName(compileId);
  const packageName = buildPackageName(compileId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const classesDir = `/files/java-worker/${compileId}/classes`;

  let runnableSource;
  try {
    runnableSource = buildPlainRunnableSource(normalizedPayload, compileId, dynamicInputs);
  } catch (error) {
    throw makeWorkerStageError('source generation', error);
  }

  try {
    await writeDynamicInputFiles(dynamicInputs);
  } catch (error) {
    throw makeWorkerStageError('dynamic input write', error);
  }

  try {
    await self.cheerpOSAddStringFile(sourcePath, runnableSource);
  } catch (error) {
    throw makeWorkerStageError('source file write', error);
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    throw makeWorkerStageError('compiler bridge load', error);
  }

  const libraryCallStart = performance.now();
  let reportText;
  try {
    reportText = await compileLibraryClass.compileAndRun(
      sourcePath,
      classesDir,
      `${packageName}.${exportsClassName}`,
      HELPER_JAR_PATH,
      DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
    );
  } catch (error) {
    throw makeWorkerStageError('compile and run', error);
  }
  const libraryCallEnd = performance.now();

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    throw makeWorkerStageError('execution report parse', error);
  }

  const totalEnd = performance.now();
  const consoleOutput = javaReportConsoleOutput(report);
  const timings = {
    hostCallMs: libraryCallEnd - libraryCallStart,
    totalMs: totalEnd - totalStart,
    compileMs: report.compileTimeMs ?? 0,
    classLoadMs: report.classLoadTimeMs ?? 0,
    runMs: report.runTimeMs ?? 0,
    compileCacheHit: report.compileCacheHit ?? false,
  };

  if (report.success !== true) {
    return {
      success: false,
      output: null,
      executionTimeMs: totalEnd - totalStart,
      consoleOutput,
      error:
        report.runtimeError ||
        report.compilerStderr ||
        report.compilerStdout ||
        'Java execution failed',
      timings,
    };
  }

  return {
    success: true,
    output: parseJavaReportOutput(report.output),
    executionTimeMs: totalEnd - totalStart,
    consoleOutput,
    timings,
  };
}

async function runJavaProjectRequest(payload, requestId) {
  const totalStart = performance.now();
  if (payload?.options?.enablePreview === true) {
    return {
      stdout: '',
      stderr: 'java: --enable-preview is not supported in the browser project environment\n',
      exitCode: 2,
    };
  }
  const explicitClasspath = payload.source === 'run' && typeof javaProjectEffectiveClasspath(payload) === 'string';
  const compileId = stableHash({
    compileMode: 'project',
    request: {
      files: explicitClasspath
        ? projectJavaClasspathFiles(payload.project).map((file) => [file.path, file.contents])
        : [
            ...projectJavaFiles(payload.project).map((file) => [file.path, file.contents]),
            ...projectJavaClasspathFiles(payload.project).map((file) => [file.path, file.contents]),
          ],
      source: payload.source,
      scriptPath: payload.scriptPath,
      args: Array.isArray(payload.args) ? payload.args : [],
      classpath: javaProjectEffectiveClasspath(payload) ?? '',
    },
  });

  let runnableSource;
  try {
    runnableSource = explicitClasspath
      ? buildProjectJavaClassRunnableSource(payload, compileId)
      : buildProjectJavaRunnableSource(payload, compileId);
  } catch (error) {
    return {
      stdout: '',
      stderr: `${formatWorkerErrorMessage(error)}\n`,
      exitCode: 1,
    };
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    throw makeWorkerStageError('compiler bridge load', error);
  }

  const libraryCallStart = performance.now();
  const projectIo = { messageId: requestId, stdoutEmitted: false, stderrEmitted: false };
  let reportText;
  try {
    activeJavaProjectIo = projectIo;
    reportText = explicitClasspath
      ? typeof compileLibraryClass.compileAndRunProjectClassFilesWithWorkspace === 'function'
        ? await compileLibraryClass.compileAndRunProjectClassFilesWithWorkspace(
          runnableSource.classManifest,
          runnableSource.classRoot,
          runnableSource.sourceManifest,
          runnableSource.sourceRoot,
          runnableSource.workspaceManifest,
          runnableSource.workspaceRoot,
          runnableSource.workspaceCwd,
          runnableSource.classesDir,
          runnableSource.mainClassName,
          runnableSource.runtimeClasspath,
          HELPER_JAR_PATH,
          DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
        )
        : await compileLibraryClass.compileAndRunProjectClassFiles(
          runnableSource.classManifest,
          runnableSource.classRoot,
          runnableSource.sourceManifest,
          runnableSource.sourceRoot,
          runnableSource.classesDir,
          runnableSource.mainClassName,
          runnableSource.runtimeClasspath,
          HELPER_JAR_PATH,
          DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
        )
      : payload.source === 'compile' && typeof compileLibraryClass.compileProjectSourcesWithResources === 'function'
        ? await compileLibraryClass.compileProjectSourcesWithResources(
            runnableSource.sourceManifest,
            runnableSource.sourceRoot,
            runnableSource.classpathManifest,
            runnableSource.classpathRoot,
            runnableSource.compileSourcePaths,
            runnableSource.compileSourceRootPaths,
            runnableSource.classesDir,
            runnableSource.compileClasspath,
            DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
          )
      : typeof compileLibraryClass.compileAndRunProjectSourcesWithWorkspace === 'function'
        ? await compileLibraryClass.compileAndRunProjectSourcesWithWorkspace(
            runnableSource.sourceManifest,
            runnableSource.sourceRoot,
            runnableSource.classpathManifest,
            runnableSource.classpathRoot,
            runnableSource.workspaceManifest,
            runnableSource.workspaceRoot,
            runnableSource.workspaceCwd,
            runnableSource.classesDir,
            runnableSource.mainClassName,
            runnableSource.compileClasspath,
            DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
          )
        : typeof compileLibraryClass.compileAndRunProjectSourcesWithResources === 'function'
          ? await compileLibraryClass.compileAndRunProjectSourcesWithResources(
            runnableSource.sourceManifest,
            runnableSource.sourceRoot,
            runnableSource.classpathManifest,
            runnableSource.classpathRoot,
            runnableSource.classesDir,
            runnableSource.mainClassName,
            runnableSource.compileClasspath,
            DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
          )
          : await compileLibraryClass.compileAndRunProjectSources(
            runnableSource.sourceManifest,
            runnableSource.sourceRoot,
            runnableSource.classesDir,
            runnableSource.mainClassName,
            runnableSource.compileClasspath,
            DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
          );
  } catch (error) {
    throw makeWorkerStageError('project compile and run', error);
  } finally {
    activeJavaProjectIo = null;
  }
  const libraryCallEnd = performance.now();

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    throw makeWorkerStageError('project execution report parse', error);
  }

  const totalEnd = performance.now();
  const result = commandResultFromJavaProjectReport(
    report,
    totalEnd,
    totalStart,
    libraryCallEnd,
    libraryCallStart,
    payload.source === 'compile'
      ? javaCompileOutputDir(
          payload.args,
          payload.project,
          projectRelativeCwd(payload),
          projectVirtualRoot(payload?.project)
        )
      : null,
    payload
  );
  emitJavaProjectResultEvents(requestId, result, {
    skipStdout: projectIo.stdoutEmitted,
    skipStderr: projectIo.stderrEmitted,
  });
  return result;
}

async function runJavaCodeBatchRequest(payload) {
  const totalStart = performance.now();
  const inputBatch = Array.isArray(payload.inputBatch)
    ? payload.inputBatch.map((inputs) => inputs && typeof inputs === 'object' ? inputs : {})
    : [];
  if (inputBatch.length === 0) {
    throw new Error('Java batch execution requires a non-empty inputBatch array.');
  }

  const normalizedPayload = normalizeJavaExecutionPayload({
    ...payload,
    inputs: inputBatch[0] ?? {},
  });
  const compileId = buildJavaBatchCompileId(normalizedPayload, inputBatch);
  const dynamicInputBatch = inputBatch.map((inputs, index) =>
    dynamicInputEntriesForPayload(
      { ...normalizedPayload, inputs },
      `${compileId}-${index}`
    )
  );
  const dynamicInputs = dynamicInputBatch.flat();
  const exportsClassName = buildExportsClassName(compileId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const classesDir = `/files/java-worker/${compileId}/classes`;

  let runnableSource;
  let entryClasses;
  try {
    const batchSource = buildBatchRunnableSource(normalizedPayload, compileId, inputBatch, dynamicInputBatch);
    runnableSource = batchSource.source;
    entryClasses = batchSource.entryClasses;
  } catch (error) {
    throw makeWorkerStageError('batch source generation', error);
  }

  try {
    await writeDynamicInputFiles(dynamicInputs);
  } catch (error) {
    throw makeWorkerStageError('dynamic input write', error);
  }

  try {
    await self.cheerpOSAddStringFile(sourcePath, runnableSource);
  } catch (error) {
    throw makeWorkerStageError('source file write', error);
  }

  let compileLibraryClass;
  try {
    compileLibraryClass = await getCompileLibraryClass();
  } catch (error) {
    throw makeWorkerStageError('compiler bridge load', error);
  }

  const libraryCallStart = performance.now();
  let reportText;
  try {
    reportText = await compileLibraryClass.compileAndRunBatch(
      sourcePath,
      classesDir,
      entryClasses.join('\n'),
      HELPER_JAR_PATH,
      DEFAULT_EXECUTE_COMPILER_DEBUG_PROFILE
    );
  } catch (error) {
    throw makeWorkerStageError('compile and run batch', error);
  }
  const libraryCallEnd = performance.now();

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    throw makeWorkerStageError('batch execution report parse', error);
  }

  const totalEnd = performance.now();
  const consoleOutput = javaReportConsoleOutput(report);
  const compileMs = report.compileTimeMs ?? 0;
  const compileCacheHit = report.compileCacheHit ?? false;
  const rawResults = Array.isArray(report.results) ? report.results : [];
  const results = rawResults.map((entry) => {
    const success = entry?.success === true;
    const classLoadMs = entry?.classLoadTimeMs ?? 0;
    const runMs = entry?.runTimeMs ?? 0;
    return {
      success,
      output: success ? parseJavaReportOutput(entry.output) : null,
      consoleOutput,
      ...(success ? {} : { error: entry?.runtimeError || report.runtimeError || 'Java execution failed' }),
      timings: {
        compileMs: 0,
        classLoadMs,
        runMs,
        hostCallMs: 0,
        totalMs: classLoadMs + runMs,
        compileCacheHit,
      },
    };
  });

  if (results.length > 0) {
    results[0].timings = {
      ...results[0].timings,
      compileMs,
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: totalEnd - totalStart,
    };
  }

  return {
    success: report.success === true,
    results,
    executionTimeMs: totalEnd - totalStart,
    consoleOutput,
    ...(report.success === true ? {} : { error: report.runtimeError || 'Java batch execution failed' }),
    timings: {
      hostCallMs: libraryCallEnd - libraryCallStart,
      totalMs: totalEnd - totalStart,
      compileMs,
      classLoadMs: rawResults.reduce((sum, entry) => sum + (entry?.classLoadTimeMs ?? 0), 0),
      runMs: rawResults.reduce((sum, entry) => sum + (entry?.runTimeMs ?? 0), 0),
      compileCacheHit,
    },
  };
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }

  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  idleGeneration += 1;

  if (message.type === 'terminate') {
    self.close();
    return;
  }

  if (message.type === 'init') {
    queue = queue.then(async () => {
      try {
        applyWorkerOptions(message.payload);
        const startedAt = performance.now();
        await ensureReady();
        const totalMs = performance.now() - startedAt;
        postMessageResponse({
          id: message.id,
          type: 'init',
          payload: {
            success: true,
            loadTimeMs: Math.round(totalMs),
            timings: {
              totalMs,
              initMs: initLoadTimeMs ?? 0,
              warmupMs: 0,
            },
          },
        });
      } catch (error) {
        emitRuntimeDiagnostic('error', 'worker-request-failed', 'Java worker init request failed.', {
          type: message.type,
          message: formatWorkerErrorMessage(error),
        });
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: formatWorkerErrorMessage(error) },
        });
      } finally {
        resetIdleTimer();
      }
    });
    return;
  }

  if (message.type === 'warmup') {
    queue = queue.then(async () => {
      try {
        applyWorkerOptions(message.payload);
        await ensureReady();
        const result = await warmRunHost();
        postMessageResponse({
          id: message.id,
          type: 'warmup',
          payload: result,
        });
      } catch (error) {
        emitRuntimeDiagnostic('error', 'worker-request-failed', 'Java worker warmup request failed.', {
          type: message.type,
          message: formatWorkerErrorMessage(error),
        });
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: formatWorkerErrorMessage(error) },
        });
      } finally {
        resetIdleTimer();
      }
    });
    return;
  }

  if (
    message.type === 'execute-with-tracing' ||
    message.type === 'execute-code' ||
    message.type === 'execute-code-batch' ||
    message.type === 'execute-code-interview' ||
    message.type === 'execute-project-java'
  ) {
    queue = queue.then(async () => {
      try {
        applyWorkerOptions(message.payload);
        await ensureReady();
        const result = message.type === 'execute-with-tracing'
          ? await runJavaTraceRequest(message.payload, message.id)
          : message.type === 'execute-code-batch'
            ? await runJavaCodeBatchRequest(message.payload)
            : message.type === 'execute-project-java'
              ? await runJavaProjectRequest(message.payload, message.id)
              : await runJavaCodeRequest(message.payload);
        postMessageResponse({
          id: message.id,
          type: message.type,
          payload: result,
        });
      } catch (error) {
        emitRuntimeDiagnostic('error', 'worker-request-failed', 'Java worker execution request failed.', {
          type: message.type,
          message: formatWorkerErrorMessage(error),
        });
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: formatWorkerErrorMessage(error) },
        });
      } finally {
        resetIdleTimer();
      }
    });
    return;
  }
};

queueMicrotask(() => {
  emitRuntimeDiagnostic('info', 'worker-ready', 'Java worker is ready.');
  postMessageResponse({ type: 'worker-ready' });
});
