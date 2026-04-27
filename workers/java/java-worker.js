const CHEERPJ_LOADER_URL = 'https://cjrtnc.leaningtech.com/4.2/loader.js';
const HELPER_JAR_PATH = '/app/workers/vendor/java-browser-spike-helper.jar';
const JDK17_COMPILER_JAR_PATH = '/app/workers/vendor/jdk.compiler-17.jar';
const REWRITER_JAR_PATH = '/app/workers/vendor/java-practice-rewriter.jar';
const REWRITER_BRIDGE_JAR_PATH = '/app/workers/vendor/java-rewrite-bridge.jar';
const JAVAPARSER_JAR_PATH = '/app/workers/vendor/javaparser-core-3.25.10.jar';
const FULL_CLASSPATH = [
  HELPER_JAR_PATH,
  JDK17_COMPILER_JAR_PATH,
  REWRITER_JAR_PATH,
  REWRITER_BRIDGE_JAR_PATH,
  JAVAPARSER_JAR_PATH,
].join(':');
const DEFAULT_COMPILER_DEBUG_PROFILE = 'full';
const DEFAULT_MAX_STORED_EVENTS = 50_000;
const IDLE_TIMEOUT_MS = 90_000;
const SCRIPT_METHOD_NAME = '__tracecodeScript';

if (typeof self.importScripts === 'function') {
  self.importScripts('java-source-augmentations.cjs');
}

let workerReadyPromise = null;
let idleTimer = null;
let queue = Promise.resolve();
let helperLibraryPromise = null;
let compileLibraryClassPromise = null;
let rewriteLibraryClassPromise = null;
let idleGeneration = 0;
let hostWarmupPromise = null;
let initLoadTimeMs = null;

function postMessageResponse(message) {
  self.postMessage(message);
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
  }, IDLE_TIMEOUT_MS);
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
  if (!('val' in value || 'value' in value)) return false;
  if ('next' in value) return true;
  return typeof value.__id__ === 'string' && value.__id__.startsWith('list-');
}

function isTreeNodeShape(value) {
  if (!isRecord(value)) return false;
  if (!('val' in value || 'value' in value)) return false;
  if ('left' in value || 'right' in value) return true;
  return typeof value.__id__ === 'string' && value.__id__.startsWith('tree-');
}

function detectFeatures(source, input) {
  const values = Object.values(input ?? {});
  return {
    hasList: /\bListNode\b/.test(source) || values.some((value) => isListNodeShape(value)),
    hasTree: /\bTreeNode\b/.test(source) || values.some((value) => isTreeNodeShape(value)),
  };
}

function toJavaScalarLiteral(value) {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error(`Unsupported scalar literal: ${JSON.stringify(value)}`);
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
  return `java.util.List.of(${value.map((entry) => buildJavaExpression(entry, elementType)).join(', ')})`;
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
    if (typeof rawVal !== 'number' || !Number.isInteger(rawVal)) {
      throw new Error(`Unsupported list node value: ${JSON.stringify(rawVal)}`);
    }
    return rawVal;
  });

  return `buildList(new int[] { ${values.join(', ')} }, new int[] { ${nextIndices.join(', ')} })`;
}

function listExpression(value) {
  return `TraceHooks.reindexListIds(${listGraphExpression(value)})`;
}

function treeExpression(value) {
  const rawVal = value.val ?? value.value ?? 0;
  const left = value.left ? treeExpression(value.left) : 'null';
  const right = value.right ? treeExpression(value.right) : 'null';
  return `tree(${toJavaScalarLiteral(rawVal)}, ${left}, ${right})`;
}

function buildJavaExpression(value, expectedType) {
  const normalizedType = expectedType ? stripGenericType(expectedType) : null;
  if (Array.isArray(value)) {
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
  if (isListNodeShape(value)) return listExpression(value);
  if (isTreeNodeShape(value)) return treeExpression(value);
  return toJavaScalarLiteral(value);
}

function buildHelperMethods(features) {
  const members = [];
  if (features.hasList) {
    members.push(`
  private static ListNode list(int val, ListNode next) {
    ListNode node = new ListNode(val);
    node.next = next;
    return node;
  }

  private static ListNode buildList(int[] values, int[] nextIndices) {
    if (values.length == 0) {
      return null;
    }
    ListNode[] nodes = new ListNode[values.length];
    for (int i = 0; i < values.length; i++) {
      nodes[i] = new ListNode(values[i]);
    }
    for (int i = 0; i < values.length; i++) {
      int nextIndex = nextIndices[i];
      nodes[i].next = nextIndex >= 0 ? nodes[nextIndex] : null;
    }
    return nodes[0];
  }`);
  }
  if (features.hasTree) {
    members.push(`
  private static TreeNode tree(int val, TreeNode left, TreeNode right) {
    TreeNode node = new TreeNode(val);
    node.left = left;
    node.right = right;
    return node;
  }`);
  }
  return members.join('\n');
}

function extractMethodParameters(source, methodName) {
  const compact = source.replace(/\s+/g, ' ');
  const escapedMethod = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = compact.match(new RegExp(`\\b${escapedMethod}\\s*\\(([^)]*)\\)`));
  if (!match || !match[1] || !match[1].trim()) {
    return [];
  }

  return match[1]
    .split(',')
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
    });
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

function findSingleStatementEnd(source, bodyStart) {
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

function wrapSingleStatementLoopBodies(source) {
  const inserts = [];
  scanJavaCode(source, 0, source.length, (index) => {
    const keyword = source.startsWith('for', index)
      ? 'for'
      : source.startsWith('while', index)
        ? 'while'
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
      startsWithJavaKeyword(source, bodyStart, 'if') ||
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
  return output;
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
        `^(\\s*)TraceHooks\\.emit\\((\"line=\\d+ call ${escapeRegExp(currentMethod.name)}\").*\\);\\s*$`
      );
      const callMatch = line.match(callPattern);
      if (callMatch) {
        const serializedArgs = currentMethod.params
          .map((paramName) => ` + " ${paramName}=" + TraceHooks.serializeResult(${paramName})`)
          .join('');
        nextLine = `${callMatch[1]}TraceHooks.emit(${callMatch[2]}${serializedArgs});`;
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

      const traceLineMatch = line.match(/TraceHooks\.emit\("line=(\d+)(?:\s|")/);
      if (traceLineMatch) {
        currentMethod.currentTraceLine = Number.parseInt(traceLineMatch[1], 10);
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
        /^(\s*)TraceHooks\.emit\("line=(\d+) return ([A-Za-z_][A-Za-z0-9_]*)"\);\s*$/
      );
      const nextLine = lines[index + 1] ?? '';
      const returnMatch = nextLine.match(/^(\s*)return\s+(.+);\s*$/);
      if (returnEmitMatch && returnMatch && returnEmitMatch[3] === currentMethod.name) {
        const tempName = `__tracecodeReturnValue${returnValueIndex++}`;
        const indent = returnEmitMatch[1] ?? returnMatch[1] ?? '';
        const returnExpression = returnMatch[2].trim();
        output.push(`${indent}${currentMethod.returnType} ${tempName} = ${returnExpression};`);
        output.push(
          `${indent}TraceHooks.emit("line=${returnEmitMatch[2]} return ${currentMethod.name} value=" + TraceHooks.serializeResult(${tempName}));`
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

  if (payload.executionStyle !== 'function') {
    return payload;
  }

  return {
    ...payload,
    code: normalizeFunctionSource(payload.code),
    executionStyle: 'solution-method',
  };
}

function buildExportsSource(source, functionName, executionStyle, input) {
  const features = detectFeatures(source, input);
  const helperMethods = buildHelperMethods(features);

  if (executionStyle === 'ops-class') {
    const operations = Array.isArray(input.operations) ? input.operations : [];
    const argumentsList = Array.isArray(input.arguments) ? input.arguments : [];
    const lines = [
      `    ${functionName} instance = null;`,
      '    java.util.List<Object> out = new java.util.ArrayList<>();',
    ];

    operations.forEach((operation, index) => {
      const args = Array.isArray(argumentsList[index]) ? argumentsList[index] : [];
      if (index === 0) {
        lines.push(`    instance = new ${functionName}(${args.map((arg) => buildJavaExpression(arg)).join(', ')});`);
        lines.push('    out.add(null);');
      } else {
        lines.push(`    out.add(instance.${String(operation)}(${args.map((arg) => buildJavaExpression(arg)).join(', ')}));`);
      }
    });

    return `public class Exports {
${helperMethods}

  public static String run() {
${lines.join('\n')}
    return TraceHooks.serializeResult(out);
  }
}
`;
  }

  const parameters = extractMethodParameters(source, functionName);
  const invocationArgs = (parameters.length > 0 ? parameters.map((parameter) => parameter.name) : Object.keys(input))
    .map((key, index) => {
      const type = parameters[index] ? parameters[index].type : undefined;
      return buildJavaExpression(input[key], type);
    })
    .join(', ');

  return `public class Exports {
${helperMethods}

  public static String run() {
    Solution solution = new Solution();
    Object result = solution.${functionName}(${invocationArgs});
    return TraceHooks.serializeResult(result);
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

async function ensureReady() {
  if (!workerReadyPromise) {
    workerReadyPromise = (async () => {
      const startedAt = performance.now();
      self.importScripts(CHEERPJ_LOADER_URL);
      if (typeof self.cheerpjInit !== 'function') {
        throw new Error('CheerpJ loader did not expose cheerpjInit');
      }
      await self.cheerpjInit({ version: 17, status: 'none' });
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
  resetIdleTimer();
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
      return library.spike.browser.BrowserCompileAndTraceLibrary;
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

async function warmHost() {
  if (!hostWarmupPromise) {
    hostWarmupPromise = (async () => {
      const libraryClass = await getCompileLibraryClass();
      const sourcePath = '/str/ExportsTracecodeWarmup.java';
      const classesDir = '/files/java-worker/__warm__/classes';
      const warmupSource = `
package harness.user.warmup;

public class ExportsTracecodeWarmup {
  public static String run() {
    return "0";
  }
}
`;
      await self.cheerpOSAddStringFile(sourcePath, warmupSource);
      await libraryClass.compileAndTrace(
        sourcePath,
        classesDir,
        'harness.user.warmup.ExportsTracecodeWarmup',
        HELPER_JAR_PATH,
        DEFAULT_COMPILER_DEBUG_PROFILE
      );
    })();
  }
  await hostWarmupPromise;
}

async function rewriteSource(payload, requestId) {
  const rewriteLibraryClass = await getRewriteLibraryClass();
  const exportsClassName = buildExportsClassName(requestId);
  const packageName = buildPackageName(requestId);
  const exportsSource = buildExportsSource(
    payload.code,
    payload.functionName,
    payload.executionStyle,
    payload.inputs ?? {}
  );
  return rewriteLibraryClass.rewriteSource(
    payload.code,
    payload.executionStyle,
    payload.functionName,
    exportsSource,
    exportsClassName,
    packageName
  );
}

function normalizePublicClassDeclarations(source) {
  return String(source).replace(/(^|\n)\s*public\s+class\s+/g, '$1class ');
}

async function collectCompileProbeDiagnostics(source, requestId, options) {
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
    await self.cheerpOSAddStringFile(sourcePath, normalizePublicClassDeclarations(source));
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
    let normalizedEvent = String(event)
      .replace(new RegExp(`\\bcall\\s+${SCRIPT_METHOD_NAME}\\b`, 'g'), 'call <module>')
      .replace(new RegExp(`\\breturn\\s+${SCRIPT_METHOD_NAME}\\b`, 'g'), 'return <module>');

    const lineMatch = normalizedEvent.match(/^line=(\d+)(.*)$/);
    if (lineMatch && sourceLineMap && Object.prototype.hasOwnProperty.call(sourceLineMap, lineMatch[1])) {
      const mappedLine = Number(sourceLineMap[lineMatch[1]]);
      if (Number.isFinite(mappedLine) && mappedLine > 0) {
        normalizedEvent = `line=${mappedLine}${lineMatch[2] ?? ''}`;
      }
    }

    const match = normalizedEvent.match(/^line=(\d+)\s+return\s+<module>$/);
    if (!match || !Number.isFinite(userCodeLineCount) || userCodeLineCount <= 0) {
      return normalizedEvent;
    }
    const line = Number.parseInt(match[1], 10);
    if (line <= userCodeLineCount) return normalizedEvent;
    return `line=${userCodeLineCount} return <module>`;
  });
}

function parseTraceLineNumber(event) {
  const match = String(event).match(/^line=(\d+)(?:\s|$)/);
  if (!match) return null;
  const line = Number.parseInt(match[1], 10);
  return Number.isFinite(line) && line > 0 ? line : null;
}

function isBareTraceLineEvent(event) {
  return /^line=\d+$/.test(String(event));
}

function buildLoopBodyLineMap(sourceText) {
  if (typeof sourceText !== 'string' || sourceText.length === 0) return null;
  const lines = sourceText.split(/\r?\n/);
  const loopBodyLineToHeaderLine = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\b(?:for|while)\s*\(/.test(line) || !line.includes('{')) continue;

    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const trimmed = lines[bodyIndex].trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('}')) break;
      loopBodyLineToHeaderLine.set(bodyIndex + 1, index + 1);
      break;
    }
  }

  return loopBodyLineToHeaderLine.size > 0 ? loopBodyLineToHeaderLine : null;
}

function expandLoopHeaderTraceEvents(events, sourceText) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const loopBodyLineToHeaderLine = buildLoopBodyLineMap(sourceText);
  if (!loopBodyLineToHeaderLine) return events;

  const expanded = [];
  for (const event of events) {
    const line = parseTraceLineNumber(event);
    const headerLine = line === null ? undefined : loopBodyLineToHeaderLine.get(line);
    const previousLine = expanded.length > 0 ? parseTraceLineNumber(expanded[expanded.length - 1]) : null;
    if (headerLine !== undefined && isBareTraceLineEvent(event) && previousLine !== headerLine) {
      expanded.push(`line=${headerLine}`);
    }
    expanded.push(event);
  }
  return expanded;
}

async function runJavaRequest(payload, requestId) {
  assertSupportedExecutionStyle(payload.executionStyle);
  if (typeof payload.code !== 'string') {
    throw new Error('`code` must be a string');
  }
  const scriptRequest = isScriptRequest(payload);
  if (!scriptRequest && (typeof payload.functionName !== 'string' || payload.functionName.trim().length === 0)) {
    throw new Error('Java execution requires a non-empty functionName or class entry name.');
  }

  const totalStart = performance.now();
  const rewriteStart = performance.now();
  let normalizedPayload;
  try {
    normalizedPayload = normalizeJavaRequest(payload);
  } catch (error) {
    throw makeWorkerStageError('request normalization', error);
  }

  let rewrittenSource;
  try {
    rewrittenSource = await rewriteSource(normalizedPayload, requestId);
    rewrittenSource = augmentTraceCallArgumentSnapshots(rewrittenSource);
    rewrittenSource = augmentArrayLengthReads(rewrittenSource);
    rewrittenSource = self.TraceCodeJavaSourceAugmentations.augmentJavaCollectionOperations(rewrittenSource);
    rewrittenSource = augmentTraceReturnValueSnapshots(rewrittenSource);
  } catch (error) {
    const rewriteError = formatWorkerErrorMessage(error);
    const diagnosticProbe = await collectCompileProbeDiagnostics(
      normalizedPayload.code,
      requestId,
      payload.options
    );
    const totalEnd = performance.now();
    const surfacedError =
      diagnosticProbe.error ??
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

  const exportsClassName = buildExportsClassName(requestId);
  const packageName = buildPackageName(requestId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const classesDir = `/files/java-worker/${requestId}/classes`;

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
  const consoleOutput = [report.compilerStdout, report.compilerStderr].filter(
    (entry) => typeof entry === 'string' && entry.trim().length > 0
  );

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
    output: report.output ? JSON.parse(report.output) : undefined,
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
        await ensureReady();
        await warmHost();
        postMessageResponse({
          id: message.id,
          type: 'init',
          payload: {
            success: true,
            loadTimeMs: Math.round(initLoadTimeMs ?? 0),
          },
        });
      } catch (error) {
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: formatWorkerErrorMessage(error) },
        });
      }
    });
    return;
  }

  if (
    message.type === 'execute-with-tracing' ||
    message.type === 'execute-code' ||
    message.type === 'execute-code-interview'
  ) {
    queue = queue.then(async () => {
      try {
        await ensureReady();
        const result = await runJavaRequest(message.payload, message.id);
        postMessageResponse({
          id: message.id,
          type: message.type,
          payload: result,
        });
      } catch (error) {
        postMessageResponse({
          id: message.id,
          type: 'error',
          payload: { error: formatWorkerErrorMessage(error) },
        });
      }
    });
    return;
  }
};

queueMicrotask(() => {
  postMessageResponse({ type: 'worker-ready' });
});
