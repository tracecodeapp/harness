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

function normalizeFunctionSource(source) {
  if (/\bpackage\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/.test(source)) {
    throw new Error('Java function style should not declare a package; the harness manages package isolation.');
  }

  if (/\bclass\s+Solution\b/.test(source)) {
    return source;
  }

  if (/\b(class|interface|enum|record)\b/.test(source)) {
    throw new Error(
      'Java function style currently expects a bare method fragment or a class named Solution containing the target method.'
    );
  }

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

  const importBlock = importLines.join('\n').trim();
  const body = bodyLines.join('\n').trim();
  if (!body) {
    throw new Error('Java function style requires a method fragment.');
  }

  return `${importBlock ? `${importBlock}\n\n` : ''}class Solution {\n${indentBlock(body, 2)}\n}`;
}

function normalizeJavaRequest(payload) {
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
  const normalizedPayload = normalizeJavaRequest(payload);
  const rewriteLibraryClass = await getRewriteLibraryClass();
  const exportsClassName = buildExportsClassName(requestId);
  const packageName = buildPackageName(requestId);
  const exportsSource = buildExportsSource(
    normalizedPayload.code,
    normalizedPayload.functionName,
    normalizedPayload.executionStyle,
    normalizedPayload.inputs ?? {}
  );
  return rewriteLibraryClass.rewriteSource(
    normalizedPayload.code,
    normalizedPayload.executionStyle,
    normalizedPayload.functionName,
    exportsSource,
    exportsClassName,
    packageName
  );
}

async function runJavaRequest(payload, requestId) {
  assertSupportedExecutionStyle(payload.executionStyle);
  if (typeof payload.functionName !== 'string' || payload.functionName.trim().length === 0) {
    throw new Error('Java execution requires a non-empty functionName or class entry name.');
  }

  const totalStart = performance.now();
  const rewriteStart = performance.now();
  const rewrittenSource = await rewriteSource(payload, requestId);
  const rewriteEnd = performance.now();

  const exportsClassName = buildExportsClassName(requestId);
  const packageName = buildPackageName(requestId);
  const sourcePath = `/str/${exportsClassName}.java`;
  const classesDir = `/files/java-worker/${requestId}/classes`;

  await self.cheerpOSAddStringFile(sourcePath, rewrittenSource);

  const compileLibraryClass = await getCompileLibraryClass();
  const libraryCallStart = performance.now();
  const reportText = await compileLibraryClass.compileAndTrace(
    sourcePath,
    classesDir,
    `${packageName}.${exportsClassName}`,
    HELPER_JAR_PATH,
    DEFAULT_COMPILER_DEBUG_PROFILE,
    String(resolveMaxStoredEvents(payload.options))
  );
  const libraryCallEnd = performance.now();

  const report = JSON.parse(reportText);
  const totalEnd = performance.now();
  const consoleOutput = [report.compilerStdout, report.compilerStderr].filter(
    (entry) => typeof entry === 'string' && entry.trim().length > 0
  );

  if (report.success !== true) {
    return {
      success: false,
      events: Array.isArray(report.events) ? report.events : [],
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
    events: Array.isArray(report.events) ? report.events : [],
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
          payload: { error: error instanceof Error ? error.message : String(error) },
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
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    });
    return;
  }
};

queueMicrotask(() => {
  postMessageResponse({ type: 'worker-ready' });
});
