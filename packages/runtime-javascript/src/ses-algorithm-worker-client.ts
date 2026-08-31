import { parse, type Node } from 'acorn';
import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimeExecutionLimits,
  RuntimeExecutionTimings,
  RuntimeTrace,
  RuntimeTraceOptions,
} from '@tracecode/runtime-contracts';
import type {
  BrowserWorkerFactory,
  BrowserWorkerLike,
} from '@tracecode/runtime-browser/internal';
import { isJavaScriptRuntimeSourceAllowed } from './javascript-runtime-source-policy';
import {
  isAdmittedJavaScriptModule,
  isJavaScriptRuntimeSelectorAllowed,
  SES_CONSOLE_COMPATIBILITY_REQUIRED,
} from './javascript-runtime-policy';

export type SesAlgorithmExecutionStyle =
  | 'function'
  | 'solution-method'
  | 'ops-class';

export interface SesAlgorithmInputArgument {
  readonly key: string;
  readonly rest?: boolean;
}

/** Immutable source material installed independently in every retained lane. */
export interface SesAlgorithmPreparedSource {
  readonly mode: 'code' | 'trace';
  readonly language: 'javascript' | 'typescript';
  readonly code: string;
  readonly instrumentedCode?: string;
  readonly functionName: string;
  readonly executionStyle: SesAlgorithmExecutionStyle;
  readonly requiredModules: readonly string[];
  readonly inputArguments: readonly SesAlgorithmInputArgument[];
  readonly materializers: Readonly<Record<string, unknown>>;
  readonly traceLineBounds?: {
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly traceOptions?: RuntimeTraceOptions;
}

export interface SesAlgorithmWorkerPoolOptions {
  readonly workerUrl: string | URL;
  readonly workerFactory?: BrowserWorkerFactory;
  readonly javascriptLibrariesUrl?: string;
  readonly javascriptLibrariesIntegrity?: string;
}

const SES_ALGORITHM_PREPARED_PROGRAM = Symbol('SesAlgorithmPreparedProgram');

/** Opaque preparation owned by the pool that created it. */
export interface SesAlgorithmPreparedProgram {
  readonly [SES_ALGORITHM_PREPARED_PROGRAM]: true;
}

type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
      readonly stage: 'compile' | 'control';
    };

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface ProgramRecord {
  readonly laneProgramIds: readonly string[];
  readonly mode: SesAlgorithmPreparedSource['mode'];
  readonly language: SesAlgorithmPreparedSource['language'];
}

const POOL_SIZE = 4;
const DEFAULT_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 10_000;
const PREPARE_TIMEOUT_MS = 2_000;
const LIBRARY_PREPARE_TIMEOUT_MS = 10_000;
const DISPOSE_TIMEOUT_MS = 1_000;
const MIN_QUIESCENCE_TIMEOUT_MS = 100;
const QUIESCENCE_TIMEOUT_FRACTION = 0.1;
const GLOBAL_MODULES: readonly [RegExp, string][] = [
  [/\b_(?=\s*(?:[.([]))/u, 'lodash'],
  [/\blodash\b/u, 'lodash'],
  [/\bDeque\b/u, '@datastructures-js/deque'],
  [/\b(?:Heap|MinHeap|MaxHeap)\b/u, '@datastructures-js/heap'],
  [
    /\b(?:LinkedList|LinkedListNode|DoublyLinkedList|DoublyLinkedListNode)\b/u,
    '@datastructures-js/linked-list',
  ],
  [
    /\b(?:PriorityQueue|MinPriorityQueue|MaxPriorityQueue)\b/u,
    '@datastructures-js/priority-queue',
  ],
  [/\bQueue\b/u, '@datastructures-js/queue'],
  [/\bEnhancedSet\b/u, '@datastructures-js/set'],
  [/\bStack\b/u, '@datastructures-js/stack'],
];

const LEGACY_ONLY_AMBIENT_IDENTIFIERS =
  /\b(?:crypto|WeakRef|FinalizationRegistry|Atomics|SharedArrayBuffer|setInterval|clearInterval|setTimeout|clearTimeout|queueMicrotask|performance|Date|runInContext|getPrototypeOf|setPrototypeOf)\b|\bMath\s*(?:\.\s*random|\[\s*['"]random['"]\s*\])|\b(?:_|lodash)\s*(?:\.\s*(?:random|sample|shuffle|now|delay|defer|debounce|throttle|template)|\[\s*['"](?:random|sample|shuffle|now|delay|defer|debounce|throttle|template)['"]\s*\])|<!--|-->/u;

const LEGACY_ONLY_LODASH_MEMBERS = new Set([
  'random', 'sample', 'shuffle', 'now', 'delay', 'defer', 'debounce',
  'throttle', 'template',
]);

const TIMING_KEYS = new Set<keyof RuntimeExecutionTimings>([
  'totalMs', 'initMs', 'warmupMs', 'compilerLoadMs', 'rewriteMs',
  'driverBuildMs', 'compileMs', 'pchMs', 'pchCacheHit', 'pchFallback',
  'linkMs', 'wasmCompileMs', 'classLoadMs', 'runMs', 'hostCallMs',
  'compileCacheHit', 'artifactCacheHit', 'algorithmFastBatch',
]);

const DIAGNOSTIC_STAGES = new Set([
  'compile', 'runtime', 'trace', 'driver-compile', 'trace-driver-compile',
  'driver-link',
]);

const LIMIT_REASONS = new Set([
  'trace-limit', 'trace-byte-limit', 'line-limit', 'single-line-limit',
  'recursion-limit', 'memory-limit', 'serialization-limit', 'client-timeout',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasEveryArrayIndex(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const admitted = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => admitted.has(key));
}

function walkSyntax(node: Node, visit: (candidate: Node) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isRecord(child) && typeof child.type === 'string') {
          walkSyntax(child as unknown as Node, visit);
        }
      }
    } else if (isRecord(value) && typeof value.type === 'string') {
      walkSyntax(value as unknown as Node, visit);
    }
  }
}

function patternBindsName(value: unknown, name: string): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'Identifier') return value.name === name;
  if (value.type === 'RestElement') return patternBindsName(value.argument, name);
  if (value.type === 'AssignmentPattern') return patternBindsName(value.left, name);
  if (value.type === 'ArrayPattern') {
    return Array.isArray(value.elements) &&
      value.elements.some((element) => patternBindsName(element, name));
  }
  if (value.type === 'ObjectPattern') {
    return Array.isArray(value.properties) && value.properties.some((property) =>
      isRecord(property) && (
        property.type === 'RestElement'
          ? patternBindsName(property.argument, name)
          : patternBindsName(property.value, name)
      )
    );
  }
  return false;
}

function hasLodashIdentifierReference(root: Node): boolean {
  const parents = new WeakMap<object, Node>();
  walkSyntax(root, (candidate) => {
    for (const value of Object.values(candidate)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isRecord(child) && typeof child.type === 'string') {
            parents.set(child, candidate);
          }
        }
      } else if (isRecord(value) && typeof value.type === 'string') {
        parents.set(value, candidate);
      }
    }
  });
  let found = false;
  walkSyntax(root, (candidate) => {
    if (found || candidate.type !== 'Identifier' ||
        (candidate as Node & { readonly name?: string }).name !== '_') return;
    const parent = parents.get(candidate) as (Node & Record<string, unknown>) | undefined;
    if (!parent) { found = true; return; }
    if (
      (parent.type === 'MemberExpression' && parent.property === candidate && parent.computed === false) ||
      (parent.type === 'Property' && parent.key === candidate && parent.computed === false && parent.shorthand !== true) ||
      (parent.type === 'MethodDefinition' && parent.key === candidate && parent.computed === false) ||
      ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
        parent.type === 'ContinueStatement') && parent.label === candidate)
    ) return;
    let scope: Node | undefined = candidate;
    while ((scope = parents.get(scope))) {
      const record = scope as Node & Record<string, unknown>;
      if (
        (scope.type === 'FunctionDeclaration' || scope.type === 'FunctionExpression' ||
          scope.type === 'ArrowFunctionExpression') &&
        Array.isArray(record.params) &&
        record.params.some((parameter) => patternBindsName(parameter, '_'))
      ) return;
      if (scope.type === 'CatchClause' && patternBindsName(record.param, '_')) return;
    }
    found = true;
  });
  return found;
}

function hasAsyncContextIncompatibleAwaitIdentifier(code: string): boolean {
  try {
    const syntax = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
    const parents = new WeakMap<object, Node>();
    walkSyntax(syntax, (candidate) => {
      for (const value of Object.values(candidate)) {
        if (Array.isArray(value)) {
          for (const child of value) {
            if (isRecord(child) && typeof child.type === 'string') {
              parents.set(child, candidate);
            }
          }
        } else if (isRecord(value) && typeof value.type === 'string') {
          parents.set(value, candidate);
        }
      }
    });
    let found = false;
    walkSyntax(syntax, (candidate) => {
      if (
        found ||
        candidate.type !== 'Identifier' ||
        (candidate as Node & { readonly name?: string }).name !== 'await'
      ) return;
      const parent = parents.get(candidate) as (Node & Record<string, unknown>) | undefined;
      if (
        parent && (
          (parent.type === 'MemberExpression' && parent.property === candidate && parent.computed === false) ||
          (parent.type === 'Property' && parent.key === candidate && parent.computed === false && parent.shorthand !== true) ||
          (parent.type === 'MethodDefinition' && parent.key === candidate && parent.computed === false)
        )
      ) return;
      found = true;
    });
    return found;
  } catch {
    // TypeScript is checked again after trusted transpilation. A parser miss at
    // this stage must not route every typed algorithm to the legacy Worker.
    return false;
  }
}

function hasProgramBodyLegacyIncompatibleControlFlow(code: string): boolean {
  try {
    const syntax = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
    const visit = (candidate: Node, insideFunction: boolean): boolean => {
      const controlFlow = candidate as Node & {
        readonly await?: boolean;
        readonly kind?: string;
      };
      if (!insideFunction && (
        candidate.type === 'ReturnStatement' ||
        candidate.type === 'AwaitExpression' ||
        (candidate.type === 'ForOfStatement' && controlFlow.await === true) ||
        (candidate.type === 'VariableDeclaration' && controlFlow.kind === 'await using')
      )) return true;
      const childInsideFunction = insideFunction ||
        candidate.type === 'FunctionDeclaration' ||
        candidate.type === 'FunctionExpression' ||
        candidate.type === 'ArrowFunctionExpression';
      return Object.values(candidate).some((value) =>
        Array.isArray(value)
          ? value.some((child) =>
              isRecord(child) && typeof child.type === 'string' &&
              visit(child as unknown as Node, childInsideFunction)
            )
          : isRecord(value) && typeof value.type === 'string' &&
            visit(value as unknown as Node, childInsideFunction)
      );
    };
    return visit(syntax, false);
  } catch {
    // TypeScript is checked again after trusted transpilation.
    return false;
  }
}

type AmbientObjectKind = 'math' | 'lodash' | 'global';

function unwrapChainExpression(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return value.type === 'ChainExpression'
    ? unwrapChainExpression(value.expression)
    : value;
}

function staticMemberName(value: unknown): string | undefined {
  const member = unwrapChainExpression(value);
  if (!member || member.type !== 'MemberExpression') return undefined;
  const property = unwrapChainExpression(member.property);
  if (!property) return undefined;
  if (member.computed === false && property.type === 'Identifier' &&
      typeof property.name === 'string') {
    return property.name;
  }
  if (member.computed === true && property.type === 'Literal' &&
      typeof property.value === 'string') {
    return property.value;
  }
  return undefined;
}

function directAmbientObjectKind(value: unknown): AmbientObjectKind | undefined {
  const expression = unwrapChainExpression(value);
  if (!expression) return undefined;
  if (expression.type === 'Identifier') {
    if (expression.name === 'Math') return 'math';
    if (expression.name === '_' || expression.name === 'lodash') return 'lodash';
    if (expression.name === 'globalThis' || expression.name === 'window' ||
        expression.name === 'self') return 'global';
    return undefined;
  }
  if (expression.type === 'CallExpression') {
    const callee = unwrapChainExpression(expression.callee);
    const args = Array.isArray(expression.arguments) ? expression.arguments : [];
    const specifier = unwrapChainExpression(args[0]);
    if (callee?.type === 'Identifier' && callee.name === 'require' && args.length === 1 &&
        specifier?.type === 'Literal' &&
        (specifier.value === 'lodash' || specifier.value === 'lodash.js')) {
      return 'lodash';
    }
  }
  return undefined;
}

function objectPatternSelects(
  value: unknown,
  names: ReadonlySet<string>
): boolean {
  const pattern = unwrapChainExpression(value);
  if (!pattern || pattern.type !== 'ObjectPattern' || !Array.isArray(pattern.properties)) {
    return false;
  }
  return pattern.properties.some((property) => {
    if (!isRecord(property) || property.type !== 'Property') return false;
    const key = unwrapChainExpression(property.key);
    if (!key) return false;
    return (key.type === 'Identifier' && typeof key.name === 'string' && names.has(key.name)) ||
      (key.type === 'Literal' && typeof key.value === 'string' && names.has(key.value));
  });
}

function hasLegacyOnlySyntaxReference(code: string): boolean {
  try {
    const syntax = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
    const aliases = new Map<string, Set<AmbientObjectKind>>();
    const stringAliases = new Map<string, Set<string>>();
    const assignments: Array<{ target: string; source: unknown }> = [];
    walkSyntax(syntax, (candidate) => {
      const record = candidate as Node & Record<string, unknown>;
      if (candidate.type === 'VariableDeclarator') {
        const target = unwrapChainExpression(record.id);
        if (target?.type === 'Identifier' && typeof target.name === 'string') {
          assignments.push({ target: target.name, source: record.init });
        }
      } else if (candidate.type === 'AssignmentExpression' && record.operator === '=') {
        const target = unwrapChainExpression(record.left);
        if (target?.type === 'Identifier' && typeof target.name === 'string') {
          assignments.push({ target: target.name, source: record.right });
        }
      }
    });
    const staticMemberNameWithAliases = (value: unknown): string | undefined => {
      const direct = staticMemberName(value);
      if (direct !== undefined) return direct;
      const member = unwrapChainExpression(value);
      const property = member?.type === 'MemberExpression' && member.computed === true
        ? unwrapChainExpression(member.property)
        : undefined;
      if (property?.type !== 'Identifier' || typeof property.name !== 'string') return undefined;
      const values = stringAliases.get(property.name);
      return values?.size === 1 ? values.values().next().value : undefined;
    };
    const ambientKinds = (
      value: unknown,
      visiting = new Set<object>()
    ): ReadonlySet<AmbientObjectKind> => {
      const direct = directAmbientObjectKind(value);
      if (direct) return new Set([direct]);
      const expression = unwrapChainExpression(value);
      if (!expression) return new Set();
      if (expression.type === 'Identifier' && typeof expression.name === 'string') {
        return aliases.get(expression.name) ?? new Set();
      }
      if (visiting.has(expression)) return new Set();
      visiting.add(expression);
      const found = new Set<AmbientObjectKind>();
      const add = (candidate: unknown): void => {
        for (const kind of ambientKinds(candidate, visiting)) found.add(kind);
      };
      if (expression.type === 'MemberExpression') {
        const objectKinds = ambientKinds(expression.object, visiting);
        const name = staticMemberNameWithAliases(expression);
        if (objectKinds.has('global')) {
          if (name === 'Math') found.add('math');
          if (name === '_' || name === 'lodash') found.add('lodash');
        }
        for (const kind of objectKinds) {
          if (kind !== 'global') found.add(kind);
        }
      } else if (expression.type === 'SequenceExpression' && Array.isArray(expression.expressions)) {
        add(expression.expressions.at(-1));
      } else if (expression.type === 'LogicalExpression') {
        add(expression.left);
        add(expression.right);
      } else if (expression.type === 'ConditionalExpression') {
        add(expression.consequent);
        add(expression.alternate);
      } else if (expression.type === 'ArrayExpression' && Array.isArray(expression.elements)) {
        for (const element of expression.elements) add(element);
      } else if (expression.type === 'ObjectExpression' && Array.isArray(expression.properties)) {
        for (const property of expression.properties) {
          if (isRecord(property) && property.type === 'Property') add(property.value);
        }
      } else if (expression.type === 'AssignmentExpression') {
        add(expression.right);
      }
      visiting.delete(expression);
      return found;
    };
    const stringValues = (value: unknown): ReadonlySet<string> => {
      const expression = unwrapChainExpression(value);
      if (expression?.type === 'Literal' && typeof expression.value === 'string') {
        return new Set([expression.value]);
      }
      if (expression?.type === 'Identifier' && typeof expression.name === 'string') {
        return stringAliases.get(expression.name) ?? new Set();
      }
      return new Set();
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const assignment of assignments) {
        const targetKinds = aliases.get(assignment.target) ?? new Set<AmbientObjectKind>();
        for (const kind of ambientKinds(assignment.source)) {
          if (!targetKinds.has(kind)) {
            targetKinds.add(kind);
            changed = true;
          }
        }
        if (targetKinds.size > 0) aliases.set(assignment.target, targetKinds);
        const targetStrings = stringAliases.get(assignment.target) ?? new Set<string>();
        for (const value of stringValues(assignment.source)) {
          if (!targetStrings.has(value)) {
            targetStrings.add(value);
            changed = true;
          }
        }
        if (targetStrings.size > 0) stringAliases.set(assignment.target, targetStrings);
      }
    }
    let found = false;
    walkSyntax(syntax, (candidate) => {
      if (found) return;
      const record = candidate as Node & Record<string, unknown>;
      if (candidate.type === 'MemberExpression') {
        const name = staticMemberNameWithAliases(record);
        if (name === 'prototype') {
          found = true;
          return;
        }
        const kinds = ambientKinds(record.object);
        if ((kinds.has('math') && name === 'random') ||
            (kinds.has('lodash') && name !== undefined &&
              LEGACY_ONLY_LODASH_MEMBERS.has(name))) {
          found = true;
        }
        return;
      }
      if (candidate.type !== 'VariableDeclarator' &&
          candidate.type !== 'AssignmentExpression') {
        return;
      }
      const left = candidate.type === 'VariableDeclarator' ? record.id : record.left;
      const right = candidate.type === 'VariableDeclarator' ? record.init : record.right;
      const kinds = ambientKinds(right);
      if (objectPatternSelects(left, new Set(['prototype'])) ||
          (kinds.has('math') && objectPatternSelects(left, new Set(['random']))) ||
          (kinds.has('lodash') && objectPatternSelects(left, LEGACY_ONLY_LODASH_MEMBERS))) {
        found = true;
      }
    });
    return found;
  } catch {
    // TypeScript is checked again after trusted transpilation.
    return false;
  }
}

/**
 * Routes ambient capabilities that SES intentionally withholds to the legacy
 * disposable Worker. A textual false positive is a safe performance fallback,
 * not a learner-visible rejection.
 */
export function isSesAlgorithmSourceEligible(code: string): boolean {
  return isJavaScriptRuntimeSourceAllowed(code) &&
    !LEGACY_ONLY_AMBIENT_IDENTIFIERS.test(code) &&
    !hasAsyncContextIncompatibleAwaitIdentifier(code) &&
    !hasProgramBodyLegacyIncompatibleControlFlow(code) &&
    !hasLegacyOnlySyntaxReference(code);
}

/**
 * Finds every library needed by exact require calls and supported convenience
 * globals. A null result means the source must use the disposable legacy path;
 * unsupported require forms are valid JavaScript and are not compile errors.
 */
export function detectSesAlgorithmRequiredModules(code: string): readonly string[] | null {
  const found = new Set<string>();
  try {
    const syntax = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
    walkSyntax(syntax, (candidate) => {
      const call = candidate as Node & {
        readonly type: string;
        readonly callee?: { readonly type?: string; readonly name?: string };
        readonly arguments?: ReadonlyArray<{
          readonly type?: string;
          readonly value?: unknown;
        }>;
      };
      if (
        call.type !== 'CallExpression' ||
        call.callee?.type !== 'Identifier' ||
        call.callee.name !== 'require'
      ) {
        return;
      }
      const argument = call.arguments?.[0];
      if (
        call.arguments?.length !== 1 ||
        argument?.type !== 'Literal' ||
        typeof argument.value !== 'string'
      ) {
        throw new Error('legacy-require');
      }
      if (!isAdmittedJavaScriptModule(argument.value)) {
        throw new Error('legacy-require');
      }
      found.add(argument.value);
    });
    if (hasLodashIdentifierReference(syntax)) found.add('lodash');
  } catch (error) {
    return null;
  }
  for (const [pattern, specifier] of GLOBAL_MODULES.slice(1)) {
    if (pattern.test(code)) found.add(specifier);
  }
  return Object.freeze([...found]);
}

function parseWorkerResponse(value: unknown): WorkerResponse | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.ok !== 'boolean') {
    return null;
  }
  if (value.ok === true) {
    if (!hasOnlyKeys(value, ['id', 'ok', 'value'])) return null;
    return { id: value.id as number, ok: true, value: value.value };
  }
  if (
    !hasOnlyKeys(value, ['id', 'ok', 'error'], ['stage']) ||
    typeof value.error !== 'string' ||
    (value.stage !== undefined && value.stage !== 'compile' && value.stage !== 'control')
  ) {
    return null;
  }
  return {
    id: value.id as number,
    ok: false,
    error: value.error,
    stage: value.stage === 'compile' ? 'compile' : 'control',
  };
}

function isConsoleOutput(value: unknown): value is string[] {
  return Array.isArray(value) && hasEveryArrayIndex(value) &&
    value.every((line) => typeof line === 'string');
}

function isTimings(value: unknown): value is RuntimeExecutionTimings {
  if (!isRecord(value)) return false;
  for (const [key, timing] of Object.entries(value)) {
    if (!TIMING_KEYS.has(key as keyof RuntimeExecutionTimings)) return false;
    if (key.endsWith('Hit') || key === 'pchFallback' || key === 'algorithmFastBatch') {
      if (typeof timing !== 'boolean') return false;
    } else if (typeof timing !== 'number' || !Number.isFinite(timing) || timing < 0) {
      return false;
    }
  }
  return true;
}

function hasValidCommonResultFields(value: Record<string, unknown>): boolean {
  return isConsoleOutput(value.consoleOutput) &&
    (value.timings === undefined || isTimings(value.timings));
}

function isCodeExecutionResult(value: unknown): value is CodeExecutionResult {
  if (!isRecord(value) || !hasValidCommonResultFields(value)) return false;
  switch (value.kind) {
    case 'completed':
      return hasOnlyKeys(value, ['kind', 'output', 'consoleOutput'], ['timings']);
    case 'failed':
      return hasOnlyKeys(
        value,
        ['kind', 'error', 'consoleOutput'],
        ['errorLine', 'diagnosticStage', 'diagnostic', 'timings']
      ) && typeof value.error === 'string' &&
        (value.errorLine === undefined || Number.isSafeInteger(value.errorLine)) &&
        (value.diagnosticStage === undefined ||
          DIAGNOSTIC_STAGES.has(value.diagnosticStage as string));
    case 'limit':
      return hasOnlyKeys(
        value,
        ['kind', 'reason', 'error', 'consoleOutput'],
        ['diagnostic', 'timings']
      ) && typeof value.error === 'string' && LIMIT_REASONS.has(value.reason as string);
    default:
      return false;
  }
}

function isRuntimeTrace(value: unknown): value is RuntimeTrace {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 'runtime-trace-2026-04-28' ||
    (value.language !== 'javascript' && value.language !== 'typescript') ||
    typeof value.runId !== 'string' ||
    !Array.isArray(value.events) ||
    !hasEveryArrayIndex(value.events) ||
    !Number.isSafeInteger(value.lineEventCount) ||
    (value.lineEventCount as number) < 0 ||
    !Number.isSafeInteger(value.traceStepCount) ||
    (value.traceStepCount as number) < 0
  ) return false;
  const kinds = new Set([
    'line', 'call', 'return', 'read', 'write', 'mutate', 'snapshot',
    'stdout', 'exception', 'timeout',
  ]);
  return value.events.every((event) =>
    isRecord(event) && kinds.has(event.kind as string) &&
    typeof event.runId === 'string'
  );
}

function isTraceExecutionResult(value: unknown): value is ExecutionResult {
  if (
    !isRecord(value) ||
    !hasValidCommonResultFields(value) ||
    !isRuntimeTrace(value.trace) ||
    typeof value.executionTimeMs !== 'number' ||
    !Number.isFinite(value.executionTimeMs) ||
    value.executionTimeMs < 0
  ) return false;
  switch (value.kind) {
    case 'completed':
      return hasOnlyKeys(
        value,
        ['kind', 'output', 'trace', 'executionTimeMs', 'consoleOutput'],
        ['traceTruncated', 'timings']
      ) && (value.traceTruncated === undefined ||
        LIMIT_REASONS.has(value.traceTruncated as string));
    case 'failed':
      return hasOnlyKeys(
        value,
        ['kind', 'error', 'trace', 'executionTimeMs', 'consoleOutput'],
        ['errorLine', 'diagnosticStage', 'diagnostic', 'timings']
      ) && typeof value.error === 'string' &&
        (value.errorLine === undefined || Number.isSafeInteger(value.errorLine)) &&
        (value.diagnosticStage === undefined ||
          DIAGNOSTIC_STAGES.has(value.diagnosticStage as string));
    case 'limit':
      return hasOnlyKeys(
        value,
        ['kind', 'reason', 'error', 'trace', 'executionTimeMs', 'consoleOutput'],
        ['diagnostic', 'timings']
      ) && typeof value.error === 'string' && LIMIT_REASONS.has(value.reason as string);
    default:
      return false;
  }
}

function isCodeExecutionBatch(
  value: unknown,
  expectedLength: number
): value is readonly CodeExecutionResult[] {
  return Array.isArray(value) && value.length === expectedLength &&
    hasEveryArrayIndex(value) && value.every(isCodeExecutionResult);
}

function isTraceExecutionBatch(
  value: unknown,
  expectedLength: number
): value is readonly ExecutionResult[] {
  return Array.isArray(value) && value.length === expectedLength &&
    hasEveryArrayIndex(value) && value.every(isTraceExecutionResult);
}

function normalizeDeadline(value: number | undefined): number | undefined {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (value === Infinity) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError('SES algorithm execution requires a positive finite wall-clock limit.');
  }
  return value;
}

function quiescenceDeadline(executionDeadlineMs: number | undefined): number {
  const proportionalBasis = executionDeadlineMs ?? DEFAULT_TIMEOUT_MS;
  return Math.max(
    MIN_QUIESCENCE_TIMEOUT_MS,
    proportionalBasis * QUIESCENCE_TIMEOUT_FRACTION
  );
}

function assertCoordinatorCompatibleSelector(
  selector: unknown,
  executionStyle: SesAlgorithmExecutionStyle
): asserts selector is string {
  if (isJavaScriptRuntimeSelectorAllowed(selector)) {
    return;
  }
  const label = executionStyle === 'solution-method'
    ? 'Solution method name'
    : executionStyle === 'ops-class'
      ? 'Class name'
      : 'Function name';
  throw new SesAlgorithmWorkerReportedError(
    `${label} must be a JavaScript identifier`,
    'compile'
  );
}

function snapshotMaterializer(value: unknown, depth = 0): unknown {
  if (depth > 64) {
    throw new TypeError('SES algorithm input materializer exceeds the maximum depth.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (!hasEveryArrayIndex(value)) {
      throw new TypeError('SES algorithm input materializer contains a sparse array.');
    }
    return Object.freeze(value.map((item) => snapshotMaterializer(item, depth + 1)));
  }
  if (!isRecord(value)) {
    throw new TypeError('SES algorithm input materializer contains an unsupported value.');
  }
  const entries = Object.entries(value).map(([key, child]) => [
    key,
    snapshotMaterializer(child, depth + 1),
  ] as const);
  return Object.freeze(Object.fromEntries(entries));
}

function snapshotSource(source: SesAlgorithmPreparedSource): SesAlgorithmPreparedSource {
  if (
    (source.mode !== 'code' && source.mode !== 'trace') ||
    (source.language !== 'javascript' && source.language !== 'typescript') ||
    typeof source.code !== 'string' ||
    !['function', 'solution-method', 'ops-class'].includes(source.executionStyle) ||
    !Array.isArray(source.requiredModules) ||
    !hasEveryArrayIndex(source.requiredModules) ||
    !source.requiredModules.every((specifier) => typeof specifier === 'string') ||
    !Array.isArray(source.inputArguments) ||
    !hasEveryArrayIndex(source.inputArguments) ||
    !isRecord(source.materializers)
  ) {
    throw new TypeError('SES algorithm preparation source has an invalid shape.');
  }
  if (
    source.mode === 'trace' &&
    (
      typeof source.instrumentedCode !== 'string' ||
      !source.traceLineBounds ||
      !Number.isSafeInteger(source.traceLineBounds.startLine) ||
      !Number.isSafeInteger(source.traceLineBounds.endLine) ||
      source.traceLineBounds.startLine <= 0 ||
      source.traceLineBounds.endLine < source.traceLineBounds.startLine
    )
  ) {
    throw new TypeError('SES trace preparation has an invalid instrumented artifact.');
  }
  if (
    source.traceOptions !== undefined &&
    (
      !isRecord(source.traceOptions) ||
      !hasOnlyKeys(source.traceOptions, [], ['runId', 'file', 'maxPathDepth']) ||
      (source.traceOptions.runId !== undefined && typeof source.traceOptions.runId !== 'string') ||
      (source.traceOptions.file !== undefined && typeof source.traceOptions.file !== 'string') ||
      (source.traceOptions.maxPathDepth !== undefined &&
        (typeof source.traceOptions.maxPathDepth !== 'number' ||
          !Number.isFinite(source.traceOptions.maxPathDepth) ||
          source.traceOptions.maxPathDepth <= 0))
    )
  ) {
    throw new TypeError('SES trace preparation has invalid trace options.');
  }
  assertCoordinatorCompatibleSelector(source.functionName, source.executionStyle);
  const modules = new Set<string>();
  for (const specifier of source.requiredModules) {
    if (!isAdmittedJavaScriptModule(specifier)) {
      throw new SesAlgorithmWorkerReportedError(
        `SES algorithm mode does not admit module ${JSON.stringify(specifier)}.`,
        'compile'
      );
    }
    modules.add(specifier);
  }
  const inputArguments = source.inputArguments.map((argument) => {
    if (
      !isRecord(argument) ||
      !hasOnlyKeys(argument, ['key'], ['rest']) ||
      typeof argument.key !== 'string' ||
      (argument.rest !== undefined && typeof argument.rest !== 'boolean')
    ) {
      throw new TypeError('SES algorithm preparation has invalid input arguments.');
    }
    return Object.freeze({
      key: argument.key,
      ...(argument.rest === undefined ? {} : { rest: argument.rest }),
    });
  });
  const materializers = snapshotMaterializer(source.materializers);
  if (!isRecord(materializers)) {
    throw new TypeError('SES algorithm input materializers must be an object.');
  }
  return Object.freeze({
    mode: source.mode,
    language: source.language,
    code: source.code,
    ...(source.instrumentedCode === undefined
      ? {}
      : { instrumentedCode: source.instrumentedCode }),
    functionName: source.functionName,
    executionStyle: source.executionStyle,
    requiredModules: Object.freeze([...modules]),
    inputArguments: Object.freeze(inputArguments),
    materializers,
    ...(source.traceLineBounds
      ? { traceLineBounds: Object.freeze({ ...source.traceLineBounds }) }
      : {}),
    ...(source.traceOptions
      ? { traceOptions: Object.freeze({ ...source.traceOptions }) }
      : {}),
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export class SesAlgorithmWorkerReportedError extends Error {
  constructor(
    message: string,
    readonly stage: 'compile' | 'control'
  ) {
    super(message);
    this.name = 'SesAlgorithmWorkerReportedError';
  }
}

export class SesAlgorithmCompatibilityRequiredError extends Error {
  constructor(readonly reason: 'console-budget') {
    super(`SES algorithm execution requires compatibility fallback: ${reason}.`);
    this.name = 'SesAlgorithmCompatibilityRequiredError';
  }
}

class SesAlgorithmUnpostedRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SesAlgorithmUnpostedRequestError';
  }
}

class SesAlgorithmDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`SES algorithm execution exceeded ${deadlineMs}ms.`);
    this.name = 'SesAlgorithmDeadlineError';
  }
}

class SesAlgorithmWorkerLane {
  private worker: BrowserWorkerLike | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly preparedSources = new Map<string, SesAlgorithmPreparedSource>();
  private readonly preparedWorkerIds = new Set<string>();
  private nextRequestId = 1;
  private nextProgramId = 1;
  private terminated = false;
  private initialized = false;
  private operationTail: Promise<void> = Promise.resolve();
  private lifecycleEpoch = 0;

  constructor(
    private readonly options: SesAlgorithmWorkerPoolOptions,
    private readonly laneIndex: number
  ) {}

  private createWorker(): BrowserWorkerLike {
    const workerOptions: WorkerOptions = { type: 'module' };
    return this.options.workerFactory
      ? this.options.workerFactory(this.options.workerUrl, workerOptions)
      : new Worker(this.options.workerUrl, workerOptions);
  }

  private getWorker(): BrowserWorkerLike {
    if (this.terminated) throw new Error('SES algorithm Worker lane is terminated.');
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent) => {
      if (this.worker !== worker) return;
      const response = parseWorkerResponse(event.data);
      if (!response) {
        this.retire(new Error('SES algorithm Worker returned an invalid control response.'));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      pending.cleanup();
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new SesAlgorithmWorkerReportedError(response.error, response.stage));
    };
    worker.onerror = (event: ErrorEvent) => {
      if (this.worker !== worker) return;
      this.retire(new Error(
        event.message || `SES algorithm Worker lane ${this.laneIndex} crashed.`
      ));
    };
    this.worker = worker;
    return worker;
  }

  private retire(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.initialized = false;
    this.preparedWorkerIds.clear();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.cleanup();
      request.reject(error);
    }
  }

  private call(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    deadlineMs?: number
  ): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new SesAlgorithmUnpostedRequestError(
        'SES algorithm request was aborted before posting.'
      ));
    }
    if (this.pending.size !== 0) {
      return Promise.reject(new Error(
        'SES algorithm Worker lane admitted concurrent control requests.'
      ));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        if (!this.pending.has(id)) return;
        this.retire(abortError('SES algorithm execution was aborted.'));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        if (timeout !== undefined) clearTimeout(timeout);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      if (deadlineMs !== undefined) {
        const retirementLeadMs = Math.min(25, Math.max(1, deadlineMs * 0.05));
        timeout = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.retire(new SesAlgorithmDeadlineError(deadlineMs));
        }, Math.max(1, deadlineMs - retirementLeadMs));
      }
      try {
        this.getWorker().postMessage({ id, ...request });
      } catch (error) {
        if (this.pending.delete(id)) cleanup();
        reject(new SesAlgorithmUnpostedRequestError(
          'SES algorithm request could not be posted to its Worker.',
          { cause: error }
        ));
      }
    });
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const expectedEpoch = this.lifecycleEpoch;
    const run = async (): Promise<T> => {
      if (this.terminated) throw new Error('SES algorithm Worker lane is terminated.');
      if (expectedEpoch !== this.lifecycleEpoch) {
        throw new Error('SES algorithm operation was invalidated by a lifecycle reset.');
      }
      return operation();
    };
    const result = this.operationTail.then(run, run);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async initUnlocked(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    try {
      const attestation = await this.call(
        {
          type: 'init',
          ...(this.options.javascriptLibrariesUrl
            ? { javascriptLibrariesUrl: this.options.javascriptLibrariesUrl }
            : {}),
          ...(this.options.javascriptLibrariesIntegrity
            ? { javascriptLibrariesIntegrity: this.options.javascriptLibrariesIntegrity }
            : {}),
        },
        signal,
        INIT_TIMEOUT_MS
      );
      if (
        !isRecord(attestation) ||
        !hasOnlyKeys(attestation, ['mode', 'hardened']) ||
        attestation.mode !== 'ses' ||
        attestation.hardened !== true
      ) {
        throw new Error('SES algorithm Worker hardening attestation failed.');
      }
      this.initialized = true;
    } catch (error) {
      this.retire(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  init(): Promise<void> {
    return this.runExclusive(() => this.initUnlocked());
  }

  private async prepareOnWorker(
    programId: string,
    source: SesAlgorithmPreparedSource,
    signal: AbortSignal | undefined,
    allowLearnerCompileFailure: boolean
  ): Promise<void> {
    try {
      const response = await this.call(
        { type: 'prepare', programId, source },
        signal,
        source.requiredModules.length > 0
          ? LIBRARY_PREPARE_TIMEOUT_MS
          : PREPARE_TIMEOUT_MS
      );
      if (response !== null) {
        throw new Error('SES algorithm Worker returned an invalid prepare acknowledgement.');
      }
    } catch (error) {
      const reusableCompileFailure = allowLearnerCompileFailure &&
        error instanceof SesAlgorithmWorkerReportedError && error.stage === 'compile';
      if (!reusableCompileFailure && !(error instanceof SesAlgorithmUnpostedRequestError)) {
        this.retire(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  }

  prepare(source: SesAlgorithmPreparedSource, signal?: AbortSignal): Promise<string> {
    return this.runExclusive(async () => {
      await this.initUnlocked(signal);
      const programId = `ses-lane-${this.laneIndex}-program-${this.nextProgramId++}`;
      await this.prepareOnWorker(programId, source, signal, true);
      this.preparedSources.set(programId, source);
      this.preparedWorkerIds.add(programId);
      return programId;
    });
  }

  executeCase(
    programId: string,
    inputs: Record<string, unknown>,
    limits?: RuntimeExecutionLimits,
    signal?: AbortSignal,
    tracingEnabled?: boolean
  ): Promise<CodeExecutionResult | ExecutionResult> {
    return this.runExclusive(async () => {
      const executionDeadlineMs = normalizeDeadline(limits?.wallClockMs);
      const source = this.preparedSources.get(programId);
      if (!source) throw new Error('Unknown SES algorithm prepared program.');
      if (!this.preparedWorkerIds.has(programId)) {
        await this.initUnlocked(signal);
        await this.prepareOnWorker(programId, source, signal, false);
        this.preparedWorkerIds.add(programId);
      }
      let result: CodeExecutionResult | ExecutionResult;
      try {
        const response = await this.call(
          {
            type: 'execute-batch',
            programId,
            inputBatch: [inputs],
            ...(source.mode === 'trace'
              ? { traceEnabledBatch: [tracingEnabled ?? true] }
              : {}),
          },
          signal,
          executionDeadlineMs
        );
        const valid = source.mode === 'trace'
          ? isTraceExecutionBatch(response, 1)
          : isCodeExecutionBatch(response, 1);
        if (!valid) {
          throw new Error('SES algorithm Worker returned an invalid execution result.');
        }
        result = (response as readonly (CodeExecutionResult | ExecutionResult)[])[0]!;
      } catch (error) {
        if (!(error instanceof SesAlgorithmUnpostedRequestError)) {
          this.retire(error instanceof Error ? error : new Error(String(error)));
          if (!this.terminated) void this.init().catch(() => undefined);
        }
        throw error;
      }
      try {
        const response = await this.call(
          { type: 'ping' },
          signal,
          quiescenceDeadline(executionDeadlineMs)
        );
        if (response !== null) {
          throw new Error('SES algorithm Worker returned an invalid quiescence acknowledgement.');
        }
      } catch (error) {
        this.retire(error instanceof Error ? error : new Error(String(error)));
        if (signal?.aborted) throw error;
        if (!this.terminated) void this.init().catch(() => undefined);
      }
      return result;
    });
  }

  disposeProgram(programId: string): Promise<void> {
    return this.runExclusive(async () => {
      this.preparedSources.delete(programId);
      if (!this.preparedWorkerIds.delete(programId)) return;
      try {
        const response = await this.call(
          { type: 'dispose-program', programId },
          undefined,
          DISPOSE_TIMEOUT_MS
        );
        if (response !== null) {
          throw new Error('SES algorithm Worker returned an invalid disposal acknowledgement.');
        }
      } catch (error) {
        if (!(error instanceof SesAlgorithmUnpostedRequestError)) {
          this.retire(error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
      }
    });
  }

  reset(): void {
    if (this.terminated) return;
    this.lifecycleEpoch += 1;
    this.preparedSources.clear();
    this.retire(new Error('SES algorithm Worker lane was reset.'));
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.lifecycleEpoch += 1;
    this.preparedSources.clear();
    this.retire(new Error('SES algorithm Worker lane was terminated.'));
  }
}

/**
 * Four retained, hardened V8 Workers. Every case receives a fresh SES
 * Compartment; retaining Workers only amortizes Worker and lockdown startup.
 */
export class SesAlgorithmWorkerPool {
  private readonly lanes: readonly SesAlgorithmWorkerLane[];
  private readonly programs = new Map<SesAlgorithmPreparedProgram, ProgramRecord>();
  private terminated = false;

  constructor(options: SesAlgorithmWorkerPoolOptions) {
    this.lanes = Array.from(
      { length: POOL_SIZE },
      (_, index) => new SesAlgorithmWorkerLane(options, index)
    );
  }

  private assertActive(): void {
    if (this.terminated) throw new Error('SES algorithm Worker pool is terminated.');
  }

  private recordFor(program: SesAlgorithmPreparedProgram): ProgramRecord {
    this.assertActive();
    const record = this.programs.get(program);
    if (!record) {
      throw new Error('SES algorithm preparation is unknown, disposed, or invalidated.');
    }
    return record;
  }

  async init(): Promise<void> {
    this.assertActive();
    const attempts = await Promise.allSettled(this.lanes.map((lane) => lane.init()));
    const failed = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected'
    );
    if (failed) throw failed.reason;
  }

  async prepare(
    source: SesAlgorithmPreparedSource,
    signal?: AbortSignal
  ): Promise<SesAlgorithmPreparedProgram> {
    this.assertActive();
    const immutableSource = snapshotSource(source);
    const attempts = await Promise.allSettled(
      this.lanes.map((lane) => lane.prepare(immutableSource, signal))
    );
    const failed = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected'
    );
    if (failed) {
      await Promise.allSettled(attempts.map((attempt, index) =>
        attempt.status === 'fulfilled'
          ? this.lanes[index]!.disposeProgram(attempt.value)
          : Promise.resolve()
      ));
      throw failed.reason;
    }
    const laneProgramIds = Object.freeze(attempts.map(
      (attempt) => (attempt as PromiseFulfilledResult<string>).value
    ));
    const program = Object.freeze({ [SES_ALGORITHM_PREPARED_PROGRAM]: true as const });
    this.programs.set(program, {
      laneProgramIds,
      mode: immutableSource.mode,
      language: immutableSource.language,
    });
    return program;
  }

  private async executeBatchInternal(
    program: SesAlgorithmPreparedProgram,
    inputBatch: readonly Record<string, unknown>[],
    limits?: RuntimeExecutionLimits,
    signal?: AbortSignal,
    traceEnabledBatch?: readonly boolean[]
  ): Promise<readonly (CodeExecutionResult | ExecutionResult)[]> {
    const record = this.recordFor(program);
    if (!Array.isArray(inputBatch) || !hasEveryArrayIndex(inputBatch)) {
      throw new TypeError('SES algorithm Worker pool received a sparse input batch.');
    }
    if (
      record.laneProgramIds.length !== this.lanes.length ||
      !hasEveryArrayIndex(record.laneProgramIds)
    ) {
      throw new Error('SES algorithm Worker pool preparation is incomplete.');
    }
    if (
      traceEnabledBatch !== undefined &&
      (traceEnabledBatch.length !== inputBatch.length ||
        !hasEveryArrayIndex(traceEnabledBatch) ||
        traceEnabledBatch.some((enabled) => typeof enabled !== 'boolean'))
    ) {
      throw new TypeError('SES trace selection must contain one boolean per batch case.');
    }
    const results = new Array<CodeExecutionResult | ExecutionResult>(inputBatch.length);
    let nextIndex = 0;
    const laneRuns = this.lanes.map(async (lane, laneIndex) => {
      while (nextIndex < inputBatch.length) {
        const index = nextIndex++;
        try {
          results[index] = await lane.executeCase(
            record.laneProgramIds[laneIndex]!,
            inputBatch[index]!,
            limits,
            signal,
            traceEnabledBatch?.[index]
          );
        } catch (error) {
          if (
            error instanceof SesAlgorithmDeadlineError &&
            limits?.wallClockMs !== undefined &&
            limits.wallClockMs !== Infinity
          ) {
            results[index] = record.mode === 'trace'
              ? {
                  kind: 'limit',
                  reason: 'client-timeout',
                  error: error.message,
                  trace: {
                    schemaVersion: 'runtime-trace-2026-04-28',
                    language: record.language,
                    runId: `${record.language}:run`,
                    events: [],
                    lineEventCount: 0,
                    traceStepCount: 0,
                  },
                  executionTimeMs: error.deadlineMs,
                  consoleOutput: [],
                  timings: { totalMs: error.deadlineMs },
                }
              : {
                  kind: 'limit',
                  reason: 'client-timeout',
                  error: error.message,
                  consoleOutput: [],
                  timings: { totalMs: error.deadlineMs },
                };
            continue;
          }
          throw error;
        }
      }
    });
    const settled = await Promise.allSettled(laneRuns);
    const failed = settled.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected'
    );
    if (failed) throw failed.reason;
    if (!hasEveryArrayIndex(results)) {
      throw new Error('SES algorithm Worker pool assembled a sparse result batch.');
    }
    if (results.some((result) =>
      result.kind === 'failed' && result.error === SES_CONSOLE_COMPATIBILITY_REQUIRED
    )) {
      throw new SesAlgorithmCompatibilityRequiredError('console-budget');
    }
    return results;
  }

  async executeBatch(
    program: SesAlgorithmPreparedProgram,
    inputBatch: readonly Record<string, unknown>[],
    limits?: RuntimeExecutionLimits,
    signal?: AbortSignal
  ): Promise<readonly CodeExecutionResult[]> {
    const record = this.recordFor(program);
    if (record.mode !== 'code') {
      throw new Error('SES trace preparation cannot execute as a correctness batch.');
    }
    return await this.executeBatchInternal(
      program,
      inputBatch,
      limits,
      signal
    ) as readonly CodeExecutionResult[];
  }

  async executeTraceBatch(
    program: SesAlgorithmPreparedProgram,
    inputBatch: readonly Record<string, unknown>[],
    traceEnabledBatch: readonly boolean[] | undefined,
    limits?: RuntimeExecutionLimits,
    signal?: AbortSignal
  ): Promise<readonly ExecutionResult[]> {
    const record = this.recordFor(program);
    if (record.mode !== 'trace') {
      throw new Error('SES correctness preparation cannot execute as a trace batch.');
    }
    return await this.executeBatchInternal(
      program,
      inputBatch,
      limits,
      signal,
      traceEnabledBatch
    ) as readonly ExecutionResult[];
  }

  async disposeProgram(program: SesAlgorithmPreparedProgram): Promise<void> {
    const record = this.programs.get(program);
    if (!record) return;
    this.programs.delete(program);
    const attempts = await Promise.allSettled(this.lanes.map((lane, index) =>
      lane.disposeProgram(record.laneProgramIds[index]!)
    ));
    const failed = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected'
    );
    if (failed) throw failed.reason;
  }

  reset(): void {
    if (this.terminated) return;
    this.programs.clear();
    for (const lane of this.lanes) lane.reset();
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.programs.clear();
    for (const lane of this.lanes) lane.terminate();
  }
}
