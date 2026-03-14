import type { RuntimeExecutionStyle } from '../../harness-core/src/runtime-types';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import { withTypeScriptRuntimeDeclarations } from './typescript-runtime-declarations';

type TypeScriptModule = typeof import('typescript');

let typeScriptModulePromise: Promise<TypeScriptModule> | null = null;

type DynamicRunner = (...args: unknown[]) => unknown;

async function getTypeScriptModule(): Promise<TypeScriptModule> {
  if (!typeScriptModulePromise) {
    const specifier = 'typescript';
    typeScriptModulePromise = import(/* webpackIgnore: true */ specifier);
  }
  return typeScriptModulePromise;
}

function performanceNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function formatConsoleArg(value: unknown): string {
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

function createConsoleProxy(output: string[]): Console {
  const capture = (...args: unknown[]) => {
    output.push(args.map(formatConsoleArg).join(' '));
  };

  return {
    ...console,
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
  };
}

function isLikelyTreeNodeValue(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasValue = 'val' in value || 'value' in value;
  const hasTreeLinks = 'left' in value || 'right' in value;
  return hasValue && hasTreeLinks;
}

function isLikelyListNodeValue(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasValue = 'val' in value || 'value' in value;
  const hasTreeLinks = 'left' in value || 'right' in value;
  const hasListLinks = 'next' in value || 'prev' in value;
  return hasValue && hasListLinks && !hasTreeLinks;
}

function getCustomClassName(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value instanceof Map || value instanceof Set) return null;
  if (isLikelyTreeNodeValue(value) || isLikelyListNodeValue(value)) return null;
  const ctor = (value as { constructor?: { name?: unknown } }).constructor;
  const name = typeof ctor?.name === 'string' ? ctor.name : '';
  if (!name || name === 'Object' || name === 'Array' || name === 'Map' || name === 'Set') {
    return null;
  }
  return name;
}

function serializeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  nodeRefState: { ids: Map<object, string>; nextId: number } = { ids: new Map<object, string>(), nextId: 1 }
): unknown {
  if (depth > 48) return '<max depth>';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  }
  if (typeof value === 'function') {
    return '<function>';
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, depth + 1, seen));
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

  if (typeof value === 'object') {
    if (isLikelyTreeNodeValue(value) || isLikelyListNodeValue(value)) {
      const objectValue = value as object;
      const nodeValue = value as Record<string, unknown>;
      const existingId = nodeRefState.ids.get(objectValue);
      if (existingId) {
        return { __ref__: existingId };
      }

      const isTree = isLikelyTreeNodeValue(value);
      const nodePrefix = isTree ? 'tree' : 'list';
      const nodeId = `${nodePrefix}-${nodeRefState.nextId++}`;
      nodeRefState.ids.set(objectValue, nodeId);

      if (isTree) {
        return {
          __type__: 'TreeNode',
          __id__: nodeId,
          val: serializeValue(nodeValue.val ?? nodeValue.value ?? null, depth + 1, seen, nodeRefState),
          left: serializeValue(nodeValue.left ?? null, depth + 1, seen, nodeRefState),
          right: serializeValue(nodeValue.right ?? null, depth + 1, seen, nodeRefState),
        };
      }

      return {
        __type__: 'ListNode',
        __id__: nodeId,
        val: serializeValue(nodeValue.val ?? nodeValue.value ?? null, depth + 1, seen, nodeRefState),
        next: serializeValue(nodeValue.next ?? null, depth + 1, seen, nodeRefState),
        ...('prev' in nodeValue
          ? { prev: serializeValue(nodeValue.prev ?? null, depth + 1, seen, nodeRefState) }
          : {}),
      };
    }

    const customClassName = getCustomClassName(value);
    if (customClassName) {
      const objectValue = value as object;
      const existingId = nodeRefState.ids.get(objectValue);
      if (existingId) {
        return { __ref__: existingId };
      }

      const objectId = `object-${nodeRefState.nextId++}`;
      nodeRefState.ids.set(objectValue, objectId);

      if (seen.has(objectValue)) return { __ref__: objectId };
      seen.add(objectValue);
      const out: Record<string, unknown> = {
        __type__: 'object',
        __class__: customClassName,
        __id__: objectId,
      };
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = serializeValue(v, depth + 1, seen, nodeRefState);
      }
      seen.delete(objectValue);
      return out;
    }

    if (seen.has(value as object)) return '<cycle>';
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v, depth + 1, seen, nodeRefState);
    }
    seen.delete(value as object);
    return out;
  }

  return String(value);
}

function extractUserErrorLine(error: unknown): number | undefined {
  if (typeof error === 'object' && error && '__tracecodeLine' in error) {
    const line = Number((error as { __tracecodeLine?: unknown }).__tracecodeLine);
    if (Number.isFinite(line)) return line;
  }

  const stack =
    typeof error === 'object' && error && 'stack' in error
      ? String((error as { stack?: unknown }).stack ?? '')
      : '';
  if (!stack) return undefined;
  const match = stack.match(/<anonymous>:(\d+):\d+/);
  if (!match) return undefined;
  const line = Number.parseInt(match[1], 10);
  return Number.isFinite(line) ? line : undefined;
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.prototype.toString.call(value) === '[object Object]';
}

function collectReferenceTargets(
  value: unknown,
  byId: Map<string, Record<string, unknown>>,
  seen: WeakSet<object>
): void {
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

function resolveReferenceGraph(
  value: unknown,
  byId: Map<string, Record<string, unknown>>,
  resolved: WeakMap<object, unknown>
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (resolved.has(value)) {
    return resolved.get(value);
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
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

  const out: Record<string, unknown> = {};
  resolved.set(value, out);
  for (const [key, nested] of Object.entries(value)) {
    out[key] = resolveReferenceGraph(nested, byId, resolved);
  }
  return out;
}

function normalizeInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {};
  const byId = new Map<string, Record<string, unknown>>();
  collectReferenceTargets(inputs, byId, new WeakSet<object>());
  if (byId.size === 0) {
    return inputs;
  }
  const hydrated = resolveReferenceGraph(inputs, byId, new WeakMap<object, unknown>());
  if (!hydrated || typeof hydrated !== 'object' || Array.isArray(hydrated)) {
    return inputs;
  }
  return hydrated as Record<string, unknown>;
}

type InputMaterializerKind = 'tree' | 'list';

function buildTreeNodeFromLevelOrder(values: unknown[]): Record<string, unknown> | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const firstValue = values[0];
  if (firstValue === null || firstValue === undefined) return null;
  const root: Record<string, unknown> = {
    val: firstValue,
    value: firstValue,
    left: null,
    right: null,
  };
  const queue: Record<string, unknown>[] = [root];
  let index = 1;

  while (queue.length > 0 && index < values.length) {
    const node = queue.shift();
    if (!node) break;

    const leftValue = values[index++];
    if (leftValue !== null && leftValue !== undefined) {
      const leftNode: Record<string, unknown> = {
        val: leftValue,
        value: leftValue,
        left: null,
        right: null,
      };
      node.left = leftNode;
      queue.push(leftNode);
    }

    if (index >= values.length) break;

    const rightValue = values[index++];
    if (rightValue !== null && rightValue !== undefined) {
      const rightNode: Record<string, unknown> = {
        val: rightValue,
        value: rightValue,
        left: null,
        right: null,
      };
      node.right = rightNode;
      queue.push(rightNode);
    }
  }
  return root;
}

function materializeTreeInput(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return buildTreeNodeFromLevelOrder(value);
  }
  if (!isPlainObjectRecord(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (isLikelyTreeNodeValue(record)) {
    return {
      val: record.val ?? record.value ?? null,
      value: record.val ?? record.value ?? null,
      left: materializeTreeInput(record.left ?? null),
      right: materializeTreeInput(record.right ?? null),
    };
  }
  const taggedRecord = value as Record<string, unknown> & { __type__?: unknown };
  if (taggedRecord.__type__ === 'TreeNode') {
    return {
      val: taggedRecord.val ?? taggedRecord.value ?? null,
      value: taggedRecord.val ?? taggedRecord.value ?? null,
      left: materializeTreeInput(taggedRecord.left ?? null),
      right: materializeTreeInput(taggedRecord.right ?? null),
    };
  }
  return value;
}

function materializeListInput(
  value: unknown,
  refs: Map<string, Record<string, unknown>> = new Map(),
  materialized: WeakMap<object, Record<string, unknown>> = new WeakMap()
): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const head: Record<string, unknown> = {
      val: value[0],
      value: value[0],
      next: null,
    };
    let current: Record<string, unknown> = head;
    for (let i = 1; i < value.length; i++) {
      const nextNode: Record<string, unknown> = { val: value[i], value: value[i], next: null };
      current.next = nextNode;
      current = nextNode;
    }
    return head;
  }
  if (!isPlainObjectRecord(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.__ref__ === 'string') {
    return refs.get(record.__ref__) ?? null;
  }
  const taggedRecord = value as Record<string, unknown> & { __type__?: unknown };
  if (isLikelyListNodeValue(record) || taggedRecord.__type__ === 'ListNode') {
    const existingMaterialized = materialized.get(record as object);
    if (existingMaterialized) {
      return existingMaterialized;
    }
    const node: Record<string, unknown> = {
      val: taggedRecord.val ?? taggedRecord.value ?? null,
      value: taggedRecord.val ?? taggedRecord.value ?? null,
      next: null,
    };
    materialized.set(record as object, node);
    if (typeof taggedRecord.__id__ === 'string' && taggedRecord.__id__.length > 0) {
      refs.set(taggedRecord.__id__, node);
    }
    node.next = materializeListInput(taggedRecord.next ?? null, refs, materialized);
    return node;
  }
  return value;
}

function detectMaterializerKind(
  ts: TypeScriptModule,
  typeNode: import('typescript').TypeNode | undefined
): InputMaterializerKind | null {
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

function collectInputMaterializers(
  ts: TypeScriptModule,
  functionLikeNode: FunctionLikeNode
): Record<string, InputMaterializerKind> {
  const out: Record<string, InputMaterializerKind> = {};
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

async function resolveInputMaterializers(
  code: string,
  functionName: string,
  executionStyle: RuntimeExecutionStyle,
  language: 'javascript' | 'typescript'
): Promise<Record<string, InputMaterializerKind>> {
  if (!functionName || executionStyle === 'ops-class' || language !== 'typescript') {
    return {};
  }

  try {
    const ts = await getTypeScriptModule();
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
  } catch {
    return {};
  }
}

function applyInputMaterializers(
  inputs: Record<string, unknown>,
  materializers: Record<string, InputMaterializerKind>
): Record<string, unknown> {
  if (Object.keys(materializers).length === 0) return inputs;
  const next: Record<string, unknown> = { ...inputs };
  for (const [name, kind] of Object.entries(materializers)) {
    if (!Object.prototype.hasOwnProperty.call(next, name)) continue;
    next[name] = kind === 'tree' ? materializeTreeInput(next[name]) : materializeListInput(next[name]);
  }
  return next;
}

type FunctionLikeNode =
  | import('typescript').FunctionDeclaration
  | import('typescript').FunctionExpression
  | import('typescript').ArrowFunction
  | import('typescript').MethodDeclaration;

function collectSimpleParameterNames(
  ts: TypeScriptModule,
  functionLikeNode: FunctionLikeNode
): string[] | null {
  const names: string[] = [];

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

function getPropertyNameText(ts: TypeScriptModule, name: import('typescript').PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function findFunctionLikeNode(
  ts: TypeScriptModule,
  sourceFile: import('typescript').SourceFile,
  functionName: string,
  executionStyle: RuntimeExecutionStyle
): FunctionLikeNode | null {
  let found: FunctionLikeNode | null = null;

  const visit = (node: import('typescript').Node): void => {
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

async function resolveOrderedInputKeys(
  code: string,
  functionName: string,
  inputs: Record<string, unknown>,
  executionStyle: RuntimeExecutionStyle,
  language: 'javascript' | 'typescript' = 'javascript'
): Promise<string[]> {
  const fallbackKeys = Object.keys(inputs);
  if (!functionName || executionStyle === 'ops-class' || fallbackKeys.length <= 1) {
    return fallbackKeys;
  }

  try {
    const ts = await getTypeScriptModule();
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
    if (!parameterNames || parameterNames.length === 0) {
      return fallbackKeys;
    }

    const matchedKeys = parameterNames.filter((name) => Object.prototype.hasOwnProperty.call(inputs, name));
    if (matchedKeys.length === 0) {
      return fallbackKeys;
    }

    const extras = fallbackKeys.filter((key) => !matchedKeys.includes(key));
    return [...matchedKeys, ...extras];
  } catch {
    return fallbackKeys;
  }
}

function buildRunner(code: string, executionStyle: RuntimeExecutionStyle, argNames: string[]): DynamicRunner {
  if (executionStyle === 'function') {
    return new Function(
      'console',
      '__functionName',
      ...argNames,
      `"use strict";
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
    ) as DynamicRunner;
  }

  if (executionStyle === 'solution-method') {
    return new Function(
      'console',
      '__functionName',
      ...argNames,
      `"use strict";
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
    ) as DynamicRunner;
  }

  if (executionStyle === 'ops-class') {
    return new Function(
      'console',
      '__className',
      '__operations',
      '__arguments',
      `"use strict";
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
    ) as DynamicRunner;
  }

  throw new Error(`Execution style "${executionStyle}" is not supported for JavaScript runtime yet.`);
}

function getOpsClassInputs(inputs: Record<string, unknown>): {
  operations: unknown[] | null;
  argumentsList: unknown[] | null;
} {
  const operations = Array.isArray(inputs.operations)
    ? inputs.operations
    : (Array.isArray(inputs.ops) ? inputs.ops : null);
  const argumentsList = Array.isArray(inputs.arguments)
    ? inputs.arguments
    : (Array.isArray(inputs.args) ? inputs.args : null);
  return { operations, argumentsList };
}

async function transpileTypeScript(code: string): Promise<string> {
  const ts = await getTypeScriptModule();
  const transpileInput = withTypeScriptRuntimeDeclarations(code);
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
    let lineNumber: number | undefined;
    if (first.file && typeof first.start === 'number') {
      const position = first.file.getLineAndCharacterOfPosition(first.start);
      lineNumber = position.line + 1;
    }
    const error = new Error(
      lineNumber
        ? `TypeScript transpilation failed (line ${lineNumber}): ${messageText}`
        : `TypeScript transpilation failed: ${messageText}`
    );
    if (lineNumber) {
      (error as Error & { __tracecodeLine?: number }).__tracecodeLine = lineNumber;
    }
    throw error;
  }

  return transpiled.outputText;
}

export async function executeJavaScriptCode(
  code: string,
  functionName: string,
  inputs: Record<string, unknown>,
  executionStyle: RuntimeExecutionStyle = 'function',
  language: 'javascript' | 'typescript' = 'javascript'
): Promise<CodeExecutionResult> {
  const consoleOutput: string[] = [];
  const consoleProxy = createConsoleProxy(consoleOutput);
  const normalizedInputs = normalizeInputs(inputs);
  const materializers = await resolveInputMaterializers(code, functionName, executionStyle, language);
  const materializedInputs = applyInputMaterializers(normalizedInputs, materializers);

  try {
    let output: unknown;

    if (executionStyle === 'ops-class') {
      const { operations, argumentsList } = getOpsClassInputs(materializedInputs);
      const runner = buildRunner(code, executionStyle, []);
      output = await Promise.resolve(runner(consoleProxy, functionName, operations, argumentsList));
    } else {
      const inputKeys = await resolveOrderedInputKeys(code, functionName, materializedInputs, executionStyle, language);
      const argNames = inputKeys.map((_, index) => `__arg${index}`);
      const argValues = inputKeys.map((key) => materializedInputs[key]);
      const runner = buildRunner(code, executionStyle, argNames);
      output = await Promise.resolve(runner(consoleProxy, functionName, ...argValues));
    }

    return {
      success: true,
      output: serializeValue(output),
      consoleOutput,
    };
  } catch (error) {
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      errorLine: extractUserErrorLine(error),
      consoleOutput,
    };
  }
}

export async function executeJavaScriptWithTracing(
  code: string,
  functionName: string | null,
  inputs: Record<string, unknown>,
  executionStyle: RuntimeExecutionStyle = 'function',
  language: 'javascript' | 'typescript' = 'javascript'
): Promise<ExecutionResult> {
  const startedAt = performanceNow();
  const codeResult = await executeJavaScriptCode(code, functionName ?? '', inputs, executionStyle, language);
  const executionTimeMs = performanceNow() - startedAt;

  if (!codeResult.success) {
    return {
      success: false,
      error: codeResult.error,
      errorLine: codeResult.errorLine,
      trace: [],
      executionTimeMs,
      consoleOutput: codeResult.consoleOutput ?? [],
      lineEventCount: 0,
      traceStepCount: 0,
    };
  }

  return {
    success: true,
    output: codeResult.output,
    trace: [],
    executionTimeMs,
    consoleOutput: codeResult.consoleOutput ?? [],
    lineEventCount: 0,
    traceStepCount: 0,
  };
}

export async function executeTypeScriptCode(
  code: string,
  functionName: string,
  inputs: Record<string, unknown>,
  executionStyle: RuntimeExecutionStyle = 'function'
): Promise<CodeExecutionResult> {
  const normalizedInputs = normalizeInputs(inputs);
  const materializers = await resolveInputMaterializers(code, functionName, executionStyle, 'typescript');
  const materializedInputs = applyInputMaterializers(normalizedInputs, materializers);
  const transpiledCode = await transpileTypeScript(code);
  return executeJavaScriptCode(transpiledCode, functionName, materializedInputs, executionStyle, 'typescript');
}
