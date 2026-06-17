#!/usr/bin/env npx tsx

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { executeJavaScriptCode, executeTypeScriptCode } from '../packages/harness-javascript/src/javascript-executor';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface WorkerSelfObject {
  location: { search: string };
  postMessage: (message: WorkerMessage) => void;
  onmessage: ((event: { data: WorkerMessage }) => void) | null;
  ts?: unknown;
}

interface CreateWorkerHarnessOptions {
  typeScriptCompiler?: unknown;
  importScripts?: (workerSelf: WorkerSelfObject, context: vm.Context, ...urls: string[]) => void;
}

type RuntimeAccessEvent = {
  variable?: string;
  kind?: string;
  indices?: number[];
  method?: string;
  pathDepth?: number;
};

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type RuntimeTraceEvent = {
  kind?: string;
  line?: number;
  column?: number;
  function?: string;
  frameId?: string;
  args?: unknown;
  value?: unknown;
  target?: { variable?: string; path?: Array<string | number>; indexSources?: Array<string | null>; scope?: string };
  binding?: { kind?: string; variable?: string };
  method?: string;
};

function traceEvents(result: { trace?: { events?: RuntimeTraceEvent[] } }): RuntimeTraceEvent[] {
  return Array.isArray(result.trace?.events) ? result.trace.events : [];
}

function traceLineEvents(result: { trace?: { events?: RuntimeTraceEvent[] } }): RuntimeTraceEvent[] {
  return traceEvents(result).filter((event) => event.kind === 'line');
}

function traceSnapshotEvents(result: { trace?: { events?: RuntimeTraceEvent[] } }): RuntimeTraceEvent[] {
  return traceEvents(result).filter((event) => event.kind === 'snapshot');
}

function traceAccessEvents(result: { trace?: { events?: RuntimeTraceEvent[] } }): RuntimeTraceEvent[] {
  return traceEvents(result).filter((event) =>
    event.kind === 'read' || event.kind === 'write' || event.kind === 'mutate'
  );
}

function runtimeRefId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { __id__?: unknown; __ref__?: unknown };
  if (typeof record.__id__ === 'string') return record.__id__;
  if (typeof record.__ref__ === 'string') return record.__ref__;
  return undefined;
}

function isAnonymousValueOnlyNode(value: unknown, expectedValue: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.val === expectedValue &&
    typeof record.__id__ !== 'string' &&
    typeof record.__ref__ !== 'string' &&
    typeof record.__type__ !== 'string'
  );
}

function traceLineFrames(result: { trace?: { events?: RuntimeTraceEvent[] } }, line: number): RuntimeTraceEvent[][] {
  const frames: RuntimeTraceEvent[][] = [];
  let currentFrame: RuntimeTraceEvent[] | null = null;
  for (const event of traceEvents(result)) {
    if (event.kind === 'line') {
      currentFrame = event.line === line ? [event] : null;
      if (currentFrame) {
        frames.push(currentFrame);
      }
      continue;
    }
    if (event.kind === 'call' || event.kind === 'return') {
      currentFrame = null;
      continue;
    }
    if (currentFrame) {
      currentFrame.push(event);
    }
  }
  return frames;
}

function traceSnapshotFrames(result: { trace?: { events?: RuntimeTraceEvent[] } }): Array<{
  line: number;
  snapshots: Record<string, unknown>;
}> {
  const frames: Array<{ line: number; snapshots: Record<string, unknown> }> = [];
  let currentFrame: { line: number; snapshots: Record<string, unknown> } | null = null;
  for (const event of traceEvents(result)) {
    if (event.kind === 'line') {
      currentFrame = { line: event.line ?? 0, snapshots: {} };
      frames.push(currentFrame);
      continue;
    }
    if (event.kind === 'call' || event.kind === 'return') {
      currentFrame = null;
      continue;
    }
    if (event.kind === 'snapshot' && currentFrame && event.target?.variable) {
      currentFrame.snapshots[event.target.variable] = event.value;
    }
  }
  return frames;
}

function assertNoRuntimeTraceVisualizerPayloadLeak(
  result: { trace?: { events?: RuntimeTraceEvent[] } },
  label: string
): void {
  const serialized = JSON.stringify(traceEvents(result));
  assertCondition(
    !serialized.includes('visualization') &&
      !serialized.includes('objectKinds') &&
      !serialized.includes('hashMaps') &&
      !serialized.includes('graph-adjacency') &&
      !serialized.includes('linked-list') &&
      !serialized.includes('node-') &&
      !serialized.includes('object-'),
    `${label} leaked semantic/visualizer payload markers into runtime trace events`
  );
}

async function loadWorkerSource(): Promise<string> {
  const workerPath = join(process.cwd(), 'workers', 'javascript', 'javascript-worker.js');
  return readFile(workerPath, 'utf8');
}

function loadJavaScriptLibrariesIntoContext(context: vm.Context): void {
  const vendorPath = join(process.cwd(), 'workers', 'vendor', 'javascript-libraries.js');
  vm.runInContext(readFileSync(vendorPath, 'utf8'), context, {
    filename: 'javascript-libraries.js',
  });
}

function createWorkerHarness(workerSource: string, options: CreateWorkerHarnessOptions = { typeScriptCompiler: ts }) {
  const pending = new Map<string, { protocolToken: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let ready = false;
  let nextId = 0;

  const selfObject: WorkerSelfObject = {
    location: { search: '' },
    postMessage: (message: WorkerMessage) => {
      if (message.type === 'worker-ready') {
        ready = true;
        return;
      }
      const id = message.id;
      if (!id) return;
      const entry = pending.get(id);
      if (!entry) return;
      if (message.protocolToken !== entry.protocolToken) return;
      pending.delete(id);
      if (message.type === 'error') {
        const payload = message.payload as { error?: unknown } | undefined;
        entry.reject(new Error(String(payload?.error ?? 'Worker error')));
        return;
      }
      entry.resolve(message.payload);
    },
    onmessage: null,
    ts: options.typeScriptCompiler,
  };

  const contextGlobals: Record<string, unknown> = {
    console,
    self: selfObject,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
  };

  const context = vm.createContext(contextGlobals);
  const defaultImportScripts = (...urls: string[]) => {
    for (const url of urls) {
      if (String(url).includes('javascript-libraries.js')) {
        loadJavaScriptLibrariesIntoContext(context);
      } else if (String(url).includes('typescript')) {
        selfObject.ts = ts;
      } else {
        throw new Error(`Unexpected importScripts URL in JavaScript worker test: ${url}`);
      }
    }
  };
  (context as Record<string, unknown>).importScripts = (...urls: string[]) => {
    if (options.importScripts) {
      return options.importScripts(selfObject, context, ...urls);
    }
    return defaultImportScripts(...urls);
  };

  vm.runInContext(workerSource, context, {
    filename: 'javascript-worker.js',
  });

  const onmessage = selfObject.onmessage;
  assertCondition(typeof onmessage === 'function', 'Worker did not register onmessage handler');
  assertCondition(ready, 'Worker did not emit worker-ready');

  async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    const protocolToken = `test-token-${id}`;
    const responsePromise = new Promise<T>((resolve, reject) => {
      pending.set(id, { protocolToken, resolve: resolve as (value: unknown) => void, reject });
      setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(new Error(`Timed out waiting for response: ${type}`));
      }, 5000);
    });

    onmessage?.({ data: { id, type, payload, protocolToken } });
    return responsePromise;
  }

  return { sendMessage };
}

async function main(): Promise<void> {
  const workerSource = await loadWorkerSource();
  const harness = createWorkerHarness(workerSource);

  const init = await harness.sendMessage<{ success: boolean; loadTimeMs: number }>('init');
  assertCondition(init.success === true, 'Init should succeed');
  assertCondition(typeof init.loadTimeMs === 'number', 'Init should return loadTimeMs');
  console.log('PASS: worker init');

  const spoofHarness = createWorkerHarness(workerSource);
  await spoofHarness.sendMessage<{ success: boolean }>('init');
  const spoofedResult = await spoofHarness.sendMessage<{ success: boolean; output: unknown }>('execute-code', {
    code: 'function solve() { try { postMessage({ id: "2", type: "execute-result", payload: { success: true, output: "spoofed" } }); } catch (_error) {} return 42; }',
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    spoofedResult.success === true && spoofedResult.output === 42,
    `JavaScript worker should ignore user-spoofed result messages: ${JSON.stringify(spoofedResult)}`
  );

  const globalEscape = await harness.sendMessage<{ success: boolean; output: unknown }>('execute-code', {
    code: 'function solve() { return Boolean(globalThis.process); }',
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    globalEscape.success === true && globalEscape.output === false,
    `JavaScript runtime synthetic global should not expose host process: ${JSON.stringify(globalEscape)}`
  );

  const functionEscape = await harness.sendMessage<{ success: boolean; error?: string }>('execute-code', {
    code: 'function solve() { return Function("return import(\\"node:fs\\")")(); }',
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    functionEscape.success === false && functionEscape.error?.includes('Harness blocked dynamic code evaluation'),
    `JavaScript runtime should block Function dynamic import escape: ${JSON.stringify(functionEscape)}`
  );

  const constructorEscape = await harness.sendMessage<{ success: boolean; error?: string }>('execute-code', {
    code: 'function solve() { return (async () => {}).constructor("return process")(); }',
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    constructorEscape.success === false && constructorEscape.error?.includes('constructor property access is not supported'),
    `JavaScript runtime should reject constructor-chain escapes: ${JSON.stringify(constructorEscape)}`
  );

  const importEscape = await harness.sendMessage<{ success: boolean; error?: string }>('execute-code', {
    code: 'async function solve() { return import("node:" + "fs"); }',
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    importEscape.success === false && importEscape.error?.includes('dynamic import expressions are not supported'),
    `JavaScript runtime should reject non-literal dynamic import escapes: ${JSON.stringify(importEscape)}`
  );
  const selectorEscape = await harness.sendMessage<{ success: boolean; output?: unknown; error?: string }>('execute-code', {
    code: 'function solve() { return 1; }',
    functionName: '({}).constructor.constructor("globalThis.__tracecode_selector_escape = 7331; return function(){ return globalThis.__tracecode_selector_escape; }")()',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    selectorEscape.success === false && selectorEscape.error?.includes('Function name must be a JavaScript identifier'),
    `JavaScript worker should reject selector eval escapes: ${JSON.stringify(selectorEscape)}`
  );
  const packageSelectorEscape = await executeJavaScriptCode(
    'function solve() { return 1; }',
    '({}).constructor.constructor("globalThis.__tracecode_selector_escape = 7331; return function(){ return globalThis.__tracecode_selector_escape; }")()',
    {},
    'function'
  );
  assertCondition(
    packageSelectorEscape.success === false && packageSelectorEscape.error?.includes('Function name must be a JavaScript identifier'),
    `Package executor should reject selector eval escapes: ${JSON.stringify(packageSelectorEscape)}`
  );
  assertCondition(
    (globalThis as typeof globalThis & { __tracecode_selector_escape?: unknown }).__tracecode_selector_escape === undefined,
    'Rejected package selector should not execute side effects'
  );
  const validDollarSelector = await executeJavaScriptCode(
    'function $solve(value) { return value + 1; }',
    '$solve',
    { value: 4 },
    'function'
  );
  assertCondition(
    validDollarSelector.success === true && validDollarSelector.output === 5,
    `Package executor should still allow valid JavaScript identifier selectors: ${JSON.stringify(validDollarSelector)}`
  );
  console.log('PASS: JavaScript runtime hardening blocks message/global/eval/import escapes');

  let plainJavaScriptCompilerImportCount = 0;
  const plainJavaScriptHarness = createWorkerHarness(workerSource, {
    typeScriptCompiler: undefined,
    importScripts: (_workerSelf, context, ...urls) => {
      for (const url of urls) {
        if (String(url).includes('typescript')) {
          plainJavaScriptCompilerImportCount += 1;
          throw new Error('Plain JavaScript execution should not import the TypeScript compiler');
        }
        if (String(url).includes('javascript-libraries.js')) {
          loadJavaScriptLibrariesIntoContext(context);
        }
      }
    },
  });
  const plainJavaScriptResult = await plainJavaScriptHarness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: `function subtract(a, b) { return a - b; }`,
    functionName: 'subtract',
    inputs: { b: 3, a: 10 },
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    plainJavaScriptResult.success === true,
    `Plain JavaScript execute-code should succeed without TypeScript: ${plainJavaScriptResult.error ?? 'unknown error'}`
  );
  assertCondition(plainJavaScriptResult.output === 7, 'Plain JavaScript execute-code should preserve function argument order');
  assertCondition(plainJavaScriptCompilerImportCount === 0, 'Plain JavaScript execute-code should not load the TypeScript compiler');
  console.log('PASS: plain JavaScript execute-code does not preload TypeScript');

  let typeScriptWarmupImportCount = 0;
  const warmupHarness = createWorkerHarness(workerSource, {
    typeScriptCompiler: undefined,
    importScripts: (workerSelf, context, ...urls) => {
      for (const url of urls) {
        if (String(url).includes('javascript-libraries.js')) {
          loadJavaScriptLibrariesIntoContext(context);
        } else if (String(url).includes('typescript')) {
          typeScriptWarmupImportCount += 1;
          workerSelf.ts = ts;
        } else {
          throw new Error(`Unexpected importScripts URL in TypeScript warmup test: ${url}`);
        }
      }
    },
  });
  const typeScriptWarmup = await warmupHarness.sendMessage<{
    success: boolean;
    loadTimeMs: number;
    timings?: { warmupMs?: number };
  }>('warmup', { language: 'typescript' });
  assertCondition(typeScriptWarmup.success === true, 'TypeScript warmup should succeed');
  assertCondition(typeScriptWarmupImportCount === 1, 'TypeScript warmup should load the TypeScript compiler once');
  assertCondition(typeof typeScriptWarmup.timings?.warmupMs === 'number', 'TypeScript warmup should report warmup timing');
  const typeScriptWarmupAgain = await warmupHarness.sendMessage<{ success: boolean }>('warmup', { language: 'typescript' });
  assertCondition(typeScriptWarmupAgain.success === true, 'Repeated TypeScript warmup should succeed');
  assertCondition(typeScriptWarmupImportCount === 1, 'Repeated TypeScript warmup should reuse the compiler');
  console.log('PASS: TypeScript warmup preloads compiler once');

  const executeJavaScriptLibraries = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: `function solve(nums) {
  const { MinPriorityQueue } = require('@datastructures-js/priority-queue');
  const { Trie } = require('@datastructures-js/trie');
  const pq = new MinPriorityQueue();
  for (const num of nums) pq.enqueue(num);
  const queue = new Queue();
  queue.enqueue(_.sum(nums));
  const trie = new Trie();
  trie.insert('leet');
  return [lodash.max(nums), pq.dequeue(), queue.dequeue(), trie.has('leet'), typeof BinarySearchTree];
}`,
    functionName: 'solve',
    inputs: { nums: [5, 1, 4] },
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    executeJavaScriptLibraries.success === true,
    `JavaScript library execution should succeed: ${executeJavaScriptLibraries.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(executeJavaScriptLibraries.output) === JSON.stringify([5, 1, 10, true, 'undefined']),
    'JavaScript worker should expose lodash globals, non-conflicting datastructures-js globals, and require() modules'
  );
  console.log('PASS: execute-code javascript library preload');

  const setForOfTracing = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const values = new Set([1, 2, 3]);
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(setForOfTracing.success === true, `Set for-of tracing should succeed: ${setForOfTracing.error ?? 'unknown error'}`);
  assertCondition(setForOfTracing.output === 6, 'Tracing must preserve native Set for-of iteration semantics');
  assertCondition(
    traceLineEvents(setForOfTracing).length > 0,
    'Set for-of tracing should keep line anchors'
  );
  console.log('PASS: execute-with-tracing preserves Set for-of semantics');

  const nullPropertyTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const item = null;
  return item.value;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(nullPropertyTracing.success === false, 'Null property tracing should preserve native TypeError failure');
  assertCondition(
    String(nullPropertyTracing.error ?? '').toLowerCase().includes('cannot read'),
    `Null property tracing should surface a native read error, received ${JSON.stringify(nullPropertyTracing)}`
  );

  const nestedUndefinedElementTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `function solve(matrix) {
  return matrix[0][1];
}`,
    functionName: 'solve',
    inputs: { matrix: [] },
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(nestedUndefinedElementTracing.success === false, 'Nested element tracing should preserve native TypeError failure');
  assertCondition(
    String(nestedUndefinedElementTracing.error ?? '').toLowerCase().includes('cannot read'),
    `Nested element tracing should surface a native read error, received ${JSON.stringify(nestedUndefinedElementTracing)}`
  );

  const strictThisPropertyTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `function solve() {
  'use strict';
  const read = function() {
    'use strict';
    return this.value;
  };
  return read();
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(strictThisPropertyTracing.success === false, 'Strict this-property tracing should preserve native TypeError failure');
  assertCondition(
    String(strictThisPropertyTracing.error ?? '').toLowerCase().includes('cannot read'),
    `Strict this-property tracing should surface a native read error, received ${JSON.stringify(strictThisPropertyTracing)}`
  );

  const optionalChainTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `function solve(item) {
  return item?.value ?? 7;
}`,
    functionName: 'solve',
    inputs: { item: null },
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    optionalChainTracing.success === true && optionalChainTracing.output === 7,
    `Optional-chain tracing should preserve native short-circuit semantics, received ${JSON.stringify(optionalChainTracing)}`
  );

  const getterValueTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const child = {
    get boom() { throw new Error('getter boom'); }
  };
  const values = [child];
  return values[0] === child;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    getterValueTracing.success === true && getterValueTracing.output === true,
    `Getter-backed property read tracing should not fail during serialization, received ${JSON.stringify(getterValueTracing)}`
  );
  assertCondition(
    traceAccessEvents(getterValueTracing).some((event) =>
      event.kind === 'read' &&
      event.target?.variable === 'values' &&
      event.target.path?.[0] === 0 &&
      event.value &&
      typeof event.value === 'object' &&
      (event.value as { boom?: unknown }).boom === '<accessor>'
    ),
    `Getter-backed property read tracing should preserve accessor markers, received ${JSON.stringify(traceAccessEvents(getterValueTracing))}`
  );
  console.log('PASS: execute-with-tracing preserves JS property and element error semantics');

  const sameLineMapGuardTracing = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const adj = new Map();
  const ch = 'w';
  if (!adj.has(ch)) adj.set(ch, new Set());
  return adj.size;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(
    sameLineMapGuardTracing.success === true,
    `Same-line Map guard tracing should succeed: ${sameLineMapGuardTracing.error ?? 'unknown error'}`
  );
  const sameLineMapGuardAccesses = traceAccessEvents(sameLineMapGuardTracing)
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.line === 4 && event.target?.variable === 'adj');
  const hasReadIndex = sameLineMapGuardAccesses.findIndex(({ event }) =>
    event.kind === 'read'
    && JSON.stringify(event.target?.path) === JSON.stringify(['w'])
    && event.value === false
  );
  const setWriteIndex = sameLineMapGuardAccesses.findIndex(({ event }) =>
    event.kind === 'write'
    && JSON.stringify(event.target?.path) === JSON.stringify(['w'])
  );
  assertCondition(
    hasReadIndex >= 0 && setWriteIndex >= 0 && hasReadIndex < setWriteIndex,
    `Same-line Map guard should emit has() read before set() write, received ${JSON.stringify(sameLineMapGuardAccesses)}`
  );
  console.log('PASS: execute-with-tracing preserves same-line Map guard access order');

  const indexedForOfTracing = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const graph = [[1], []];
  const course = 0;
  let seen = 0;
  for (const nextCourse of graph[course]) {
    seen += nextCourse;
  }
  return seen;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(
    indexedForOfTracing.success === true,
    `Indexed for-of tracing should succeed: ${indexedForOfTracing.error ?? 'unknown error'}`
  );
  assertCondition(indexedForOfTracing.output === 1, 'Indexed for-of tracing should preserve execution semantics');
  const indexedForOfBinding = traceAccessEvents(indexedForOfTracing).find(
    (event) =>
      event.kind === 'read' &&
      event.target?.variable === 'graph' &&
      JSON.stringify(event.target.path) === JSON.stringify([0, 0]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify(['course', null]) &&
      JSON.stringify(event.binding) === JSON.stringify({ kind: 'iteration', variable: 'nextCourse' })
  );
  assertCondition(
    Boolean(indexedForOfBinding),
    `Indexed for-of tracing should emit element binding provenance, received ${JSON.stringify(indexedForOfTracing.trace?.events)}`
  );
  console.log('PASS: execute-with-tracing indexed for-of binding provenance');

  const stringForOfBindingTracing = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const seen = [];
  const word = 'ab';
  for (const ch of word) {
    seen.push(ch);
  }
  return seen.join('');
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(
    stringForOfBindingTracing.success === true,
    `String for-of binding tracing should succeed: ${stringForOfBindingTracing.error ?? 'unknown error'}`
  );
  assertCondition(stringForOfBindingTracing.output === 'ab', 'String for-of binding tracing should preserve output');
  {
    const groups: RuntimeTraceEvent[][] = [];
    let current: RuntimeTraceEvent[] = [];
    for (const event of stringForOfBindingTracing.trace?.events ?? []) {
      if (event.kind === 'line') {
        if (current.length > 0) groups.push(current);
        current = [event];
      } else {
        current.push(event);
      }
    }
    if (current.length > 0) groups.push(current);
    const forOfGroups = groups.filter((group) => group[0]?.line === 4);
    assertCondition(forOfGroups.length >= 2, `String for-of should emit per-iteration header groups, received ${JSON.stringify(stringForOfBindingTracing.trace?.events)}`);
    for (const group of forOfGroups) {
      const bindingRead = group.find((event) =>
        event.kind === 'read'
        && event.target?.variable === 'word'
        && event.binding?.kind === 'iteration'
        && event.binding.variable === 'ch'
      );
      const chSnapshot = group.find((event) => event.kind === 'snapshot' && event.target?.variable === 'ch');
      assertCondition(
        bindingRead?.value === chSnapshot?.value,
        `String for-of binding read should match same-header ch snapshot, received ${JSON.stringify(group)}`
      );
    }
  }
  console.log('PASS: execute-with-tracing string for-of binding aligns with header snapshot');

  const indexedTypeScriptForOfTracing = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve(): number {
  const graph: number[][] = [[1], []];
  const course = 0;
  let seen = 0;
  for (const nextCourse of graph[course]) {
    seen += nextCourse;
  }
  return seen;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(
    indexedTypeScriptForOfTracing.success === true,
    `Indexed TypeScript for-of tracing should succeed: ${indexedTypeScriptForOfTracing.error ?? 'unknown error'}`
  );
  assertCondition(indexedTypeScriptForOfTracing.output === 1, 'Indexed TypeScript for-of tracing should preserve execution semantics');
  const indexedTypeScriptForOfBinding = traceAccessEvents(indexedTypeScriptForOfTracing).find(
    (event) =>
      event.kind === 'read' &&
      event.target?.variable === 'graph' &&
      JSON.stringify(event.target.path) === JSON.stringify([0, 0]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify(['course', null]) &&
      JSON.stringify(event.binding) === JSON.stringify({ kind: 'iteration', variable: 'nextCourse' })
  );
  assertCondition(Boolean(indexedTypeScriptForOfBinding), 'Indexed TypeScript for-of tracing should emit element binding provenance');
  console.log('PASS: execute-with-tracing indexed TypeScript for-of binding provenance');

  for (const language of ['javascript', 'typescript'] as const) {
    const literalForOfTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): number {
  let total = 0;
  for (const x of [1, 2]) {
    total += x;
  }
  return total;
}`
          : `function solve() {
  let total = 0;
  for (const x of [1, 2]) {
    total += x;
  }
  return total;
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      literalForOfTracing.success === true,
      `${language} literal for-of tracing should succeed: ${literalForOfTracing.error ?? 'unknown error'}`
    );
    assertCondition(literalForOfTracing.output === 3, `${language} literal for-of should preserve output`);
    const literalBinding = traceAccessEvents(literalForOfTracing).find((event) =>
      event.kind === 'read' &&
      event.target?.variable === '[1, 2]' &&
      JSON.stringify(event.target.path) === JSON.stringify([0]) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'x' &&
      event.value === 1
    );
    assertCondition(
      Boolean(literalBinding),
      `${language} literal for-of should emit iteration binding provenance, received ${JSON.stringify(literalForOfTracing.trace?.events)}`
    );

    const reverseSpreadForOfTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): string {
  const word = 'abc';
  const seen: string[] = [];
  for (const ch of [...word].reverse()) {
    seen.push(ch);
  }
  return seen.join('');
}`
          : `function solve() {
  const word = 'abc';
  const seen = [];
  for (const ch of [...word].reverse()) {
    seen.push(ch);
  }
  return seen.join('');
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      reverseSpreadForOfTracing.success === true,
      `${language} reverse-spread for-of tracing should succeed: ${reverseSpreadForOfTracing.error ?? 'unknown error'}`
    );
    assertCondition(reverseSpreadForOfTracing.output === 'cba', `${language} reverse-spread for-of should preserve output`);
    const reverseSpreadBinding = traceAccessEvents(reverseSpreadForOfTracing).find((event) =>
      event.kind === 'read' &&
      event.target?.variable === '[...word].reverse()' &&
      JSON.stringify(event.target.path) === JSON.stringify([0]) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'ch' &&
      event.value === 'c'
    );
    assertCondition(
      Boolean(reverseSpreadBinding),
      `${language} reverse-spread for-of should emit derived iterable binding provenance, received ${JSON.stringify(reverseSpreadForOfTracing.trace?.events)}`
    );

    const fallbackIndexedForOfTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): number {
  const adj: number[][] = [[2, 3], []];
  const u = 0;
  let total = 0;
  for (const v of (adj[u] || [])) {
    total += v;
  }
  return total;
}`
          : `function solve() {
  const adj = [[2, 3], []];
  const u = 0;
  let total = 0;
  for (const v of (adj[u] || [])) {
    total += v;
  }
  return total;
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      fallbackIndexedForOfTracing.success === true,
      `${language} fallback indexed for-of tracing should succeed: ${fallbackIndexedForOfTracing.error ?? 'unknown error'}`
    );
    assertCondition(fallbackIndexedForOfTracing.output === 5, `${language} fallback indexed for-of should preserve output`);
    const fallbackBinding = traceAccessEvents(fallbackIndexedForOfTracing).find((event) =>
      event.kind === 'read' &&
      event.target?.variable === 'adj' &&
      JSON.stringify(event.target.path) === JSON.stringify([0, 0]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify(['u', null]) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'v' &&
      event.value === 2
    );
    assertCondition(
      Boolean(fallbackBinding),
      `${language} fallback indexed for-of should emit indexed iteration binding provenance, received ${JSON.stringify(fallbackIndexedForOfTracing.trace?.events)}`
    );

    const destructuredLiteralForOfTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): number {
  const r = 1;
  const c = 2;
  let total = 0;
  for (const [nr, nc] of [[r + 1, c], [r, c + 1]]) {
    total += nr + nc;
  }
  return total;
}`
          : `function solve() {
  const r = 1;
  const c = 2;
  let total = 0;
  for (const [nr, nc] of [[r + 1, c], [r, c + 1]]) {
    total += nr + nc;
  }
  return total;
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      destructuredLiteralForOfTracing.success === true,
      `${language} destructured literal for-of tracing should succeed: ${destructuredLiteralForOfTracing.error ?? 'unknown error'}`
    );
    assertCondition(destructuredLiteralForOfTracing.output === 8, `${language} destructured literal for-of should preserve output`);
    for (const [bindingVariable, expectedPath, expectedValue] of [
      ['nr', [0, 0], 2],
      ['nc', [0, 1], 2],
    ] as Array<[string, Array<string | number>, number]>) {
      const destructuredLiteralBinding = traceAccessEvents(destructuredLiteralForOfTracing).find((event) =>
        event.kind === 'read' &&
        event.target?.variable === '[[r + 1, c], [r, c + 1]]' &&
        JSON.stringify(event.target.path) === JSON.stringify(expectedPath) &&
        event.binding?.kind === 'iteration' &&
        event.binding.variable === bindingVariable &&
        event.value === expectedValue
      );
      assertCondition(
        Boolean(destructuredLiteralBinding),
        `${language} destructured literal for-of should emit ${bindingVariable} binding provenance, received ${JSON.stringify(destructuredLiteralForOfTracing.trace?.events)}`
      );
    }
  }
  console.log('PASS: execute-with-tracing JS/TS derived for-of binding provenance');

  for (const language of ['javascript', 'typescript'] as const) {
    const entriesForOfTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): string {
  const groups = new Map<string, string[]>([['root', ['a', 'b']]]);
  let out = '';
  for (const [root, emails] of groups.entries()) {
    out += root + ':' + emails.length;
  }
  return out;
}`
          : `function solve() {
  const groups = new Map([['root', ['a', 'b']]]);
  let out = '';
  for (const [root, emails] of groups.entries()) {
    out += root + ':' + emails.length;
  }
  return out;
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      entriesForOfTracing.success === true,
      `${language} Map.entries for-of tracing should succeed: ${entriesForOfTracing.error ?? 'unknown error'}`
    );
    assertCondition(entriesForOfTracing.output === 'root:2', `${language} Map.entries for-of should preserve output`);
    const entriesBinding = traceAccessEvents(entriesForOfTracing).find((event) =>
      event.kind === 'read' &&
      event.target?.variable === 'groups' &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'root,emails'
    );
    assertCondition(
      Boolean(entriesBinding),
      `${language} Map.entries for-of should emit destructuring binding provenance, received ${JSON.stringify(entriesForOfTracing.trace?.events)}`
    );
    for (const bindingVariable of ['root', 'emails']) {
      const destructuredEntryBinding = traceAccessEvents(entriesForOfTracing).find((event) =>
        event.kind === 'read' &&
        event.target?.variable === 'groups' &&
        event.target.path?.length === 2 &&
        event.binding?.kind === 'iteration' &&
        event.binding.variable === bindingVariable
      );
      assertCondition(
        Boolean(destructuredEntryBinding),
        `${language} Map.entries for-of should emit per-name destructuring binding for ${bindingVariable}, received ${JSON.stringify(entriesForOfTracing.trace?.events)}`
      );
    }

    const tupleForOfTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): number {
  const edges: number[][] = [[0, 1, 5], [1, 2, 7]];
  let total = 0;
  for (const [u, v, w] of edges) {
    total += u + v + w;
  }
  return total;
}`
          : `function solve() {
  const edges = [[0, 1, 5], [1, 2, 7]];
  let total = 0;
  for (const [u, v, w] of edges) {
    total += u + v + w;
  }
  return total;
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      tupleForOfTracing.success === true,
      `${language} tuple destructuring for-of tracing should succeed: ${tupleForOfTracing.error ?? 'unknown error'}`
    );
    assertCondition(tupleForOfTracing.output === 16, `${language} tuple destructuring for-of should preserve output`);
    for (const [bindingVariable, expectedPath] of [
      ['u', [0, 0]],
      ['v', [0, 1]],
      ['w', [0, 2]],
    ] as Array<[string, Array<string | number>]>) {
      const tupleBinding = traceAccessEvents(tupleForOfTracing).find((event) =>
        event.kind === 'read' &&
        event.target?.variable === 'edges' &&
        JSON.stringify(event.target.path) === JSON.stringify(expectedPath) &&
        JSON.stringify(event.target.indexSources) === JSON.stringify([null, null]) &&
        event.binding?.kind === 'iteration' &&
        event.binding.variable === bindingVariable
      );
      assertCondition(
        Boolean(tupleBinding),
        `${language} tuple for-of should emit per-name binding for ${bindingVariable}, received ${JSON.stringify(tupleForOfTracing.trace?.events)}`
      );
    }

    const nullishGetForOfTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): number {
  const email = 'a';
  const valueToOwners = new Map<string, number[]>([['a', [1, 2]]]);
  let total = 0;
  for (const owner of valueToOwners.get(email) ?? []) {
    total += owner;
  }
  return total;
}`
          : `function solve() {
  const email = 'a';
  const valueToOwners = new Map([['a', [1, 2]]]);
  let total = 0;
  for (const owner of valueToOwners.get(email) ?? []) {
    total += owner;
  }
  return total;
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      nullishGetForOfTracing.success === true,
      `${language} Map.get nullish for-of tracing should succeed: ${nullishGetForOfTracing.error ?? 'unknown error'}`
    );
    assertCondition(nullishGetForOfTracing.output === 3, `${language} Map.get nullish for-of should preserve output`);
    const nullishBaseRead = traceAccessEvents(nullishGetForOfTracing).find((event) =>
      event.kind === 'read' &&
      event.target?.variable === 'valueToOwners' &&
      JSON.stringify(event.target.path) === JSON.stringify(['a']) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify(['email'])
    );
    assertCondition(
      Boolean(nullishBaseRead),
      `${language} Map.get nullish for-of should emit the keyed lookup before element iteration, received ${JSON.stringify(nullishGetForOfTracing.trace?.events)}`
    );
    const nullishBinding = traceAccessEvents(nullishGetForOfTracing).find((event) =>
      event.kind === 'read' &&
      event.target?.variable === 'valueToOwners' &&
      JSON.stringify(event.target.path) === JSON.stringify(['a', 0]) &&
      JSON.stringify(event.target.indexSources) === JSON.stringify(['email', null]) &&
      JSON.stringify(event.binding) === JSON.stringify({ kind: 'iteration', variable: 'owner' })
    );
    assertCondition(
      Boolean(nullishBinding),
      `${language} Map.get nullish for-of should emit keyed element binding provenance, received ${JSON.stringify(nullishGetForOfTracing.trace?.events)}`
    );

    const singleLineForOfMutationTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): number {
  const adj = new Map<string, Set<string>>([['a', new Set<string>()], ['b', new Set<string>()]]);
  const inDegree = new Map<string, number>();
  for (const ch of adj.keys()) inDegree.set(ch, 0);
  return inDegree.size;
}`
          : `function solve() {
  const adj = new Map([['a', new Set()], ['b', new Set()]]);
  const inDegree = new Map();
  for (const ch of adj.keys()) inDegree.set(ch, 0);
  return inDegree.size;
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      singleLineForOfMutationTracing.success === true,
      `${language} single-line for-of mutation tracing should succeed: ${singleLineForOfMutationTracing.error ?? 'unknown error'}`
    );
    assertCondition(singleLineForOfMutationTracing.output === 2, `${language} single-line for-of mutation should preserve output`);
    const singleLineIterationRead = traceAccessEvents(singleLineForOfMutationTracing).find((event) =>
      event.kind === 'read' &&
      event.target?.variable === 'adj' &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'ch'
    );
    assertCondition(
      Boolean(singleLineIterationRead),
      `${language} single-line for-of should emit iteration read, received ${JSON.stringify(singleLineForOfMutationTracing.trace?.events)}`
    );
    const singleLineSetMutate = traceAccessEvents(singleLineForOfMutationTracing).find((event) =>
      event.kind === 'mutate' &&
      event.target?.variable === 'inDegree' &&
      event.method === 'set' &&
      JSON.stringify(event.target.path) === JSON.stringify(['a'])
    );
    assertCondition(
      Boolean(singleLineSetMutate),
      `${language} single-line for-of body should emit Map.set mutation, received ${JSON.stringify(singleLineForOfMutationTracing.trace?.events)}`
    );

    const receiverInsertTracing = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Trie {
  words: string[] = [];
  insert(word: string): void {
    this.words.push(word);
  }
}
function solve(): number {
  const trie = new Trie();
  const word = 'oath';
  trie.insert(word);
  return trie.words.length;
}`
          : `class Trie {
  constructor() {
    this.words = [];
  }
  insert(word) {
    this.words.push(word);
  }
}
function solve() {
  const trie = new Trie();
  const word = 'oath';
  trie.insert(word);
  return trie.words.length;
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      receiverInsertTracing.success === true,
      `${language} receiver insert tracing should succeed: ${receiverInsertTracing.error ?? 'unknown error'}`
    );
    assertCondition(receiverInsertTracing.output === 1, `${language} receiver insert tracing should preserve output`);
    const receiverInsertMutate = traceAccessEvents(receiverInsertTracing).find((event) =>
      event.kind === 'mutate' &&
      event.target?.variable === 'trie' &&
      event.method === 'insert' &&
      JSON.stringify(event.args) === JSON.stringify(['oath'])
    );
    assertCondition(
      Boolean(receiverInsertMutate),
      `${language} receiver insert call should emit call-site mutate, received ${JSON.stringify(receiverInsertTracing.trace?.events)}`
    );
  }
  console.log('PASS: execute-with-tracing JS/TS Map-backed for-of binding provenance');

  const typeScriptNestedMapSetTracing = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve(): number {
  const parent = new Map<string | number, string | number>([['a', 'root']]);
  const email = 'a';
  function find(x: string | number): string | number {
    return x;
  }
  parent.set(email, find(parent.get(email) as string | number));
  return parent.size;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(
    typeScriptNestedMapSetTracing.success === true,
    `TypeScript nested Map.set tracing should succeed: ${typeScriptNestedMapSetTracing.error ?? 'unknown error'}`
  );
  const typeScriptNestedMapSetMutate = traceAccessEvents(typeScriptNestedMapSetTracing).find((event) =>
    event.kind === 'mutate' &&
    event.target?.variable === 'parent' &&
    event.method === 'set' &&
    JSON.stringify(event.target.path) === JSON.stringify(['a'])
  );
  assertCondition(
    Boolean(typeScriptNestedMapSetMutate),
    `TypeScript nested Map.set should emit mutate access, received ${JSON.stringify(typeScriptNestedMapSetTracing.trace?.events)}`
  );
  console.log('PASS: execute-with-tracing TypeScript nested Map.set mutate provenance');

  const globalPropertyTracing = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const best = Number.NEGATIVE_INFINITY;
  const values = [best];
  return values[0];
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(globalPropertyTracing.success === true, `Global property tracing should succeed: ${globalPropertyTracing.error ?? 'unknown error'}`);
  const numberRead = traceAccessEvents(globalPropertyTracing).find((event) =>
    event.kind === 'read' &&
    event.target?.variable === 'Number' &&
    event.target.path?.[0] === 'NEGATIVE_INFINITY'
  );
  assertCondition(
    numberRead?.target?.scope === 'global',
    'Runtime trace should mark non-local property receivers as global by construction'
  );
  const valuesRead = traceAccessEvents(globalPropertyTracing).find((event) =>
    event.kind === 'read' &&
    event.target?.variable === 'values' &&
    event.target.path?.[0] === 0
  );
  assertCondition(
    valuesRead?.target?.scope !== 'global',
    'Runtime trace should not mark locally declared receivers as global'
  );
  console.log('PASS: execute-with-tracing marks global property receivers');

  const execute = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    consoleOutput?: string[];
  }>('execute-code', {
    code: 'function add(a, b) { console.log("sum", a + b); return a + b; }',
    functionName: 'add',
    inputs: { a: 2, b: 3 },
    executionStyle: 'function',
  });
  assertCondition(execute.success === true, 'Function execution should succeed');
  assertCondition(execute.output === 5, 'Function execution output should equal 5');
  assertCondition(Array.isArray(execute.consoleOutput), 'Function execution should return consoleOutput');
  assertCondition(execute.consoleOutput?.[0] === 'sum 5', 'Console output capture should preserve value order');
  console.log('PASS: execute-code function style');

  const executeJavaScriptModuleExport = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: 'export function solve(values) { return values.filter(Boolean).length; }',
    functionName: 'solve',
    inputs: { values: [0, 1, '', 'x', false, true, null] },
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    executeJavaScriptModuleExport.success === true,
    `JavaScript named export function should execute: ${executeJavaScriptModuleExport.error ?? 'unknown error'}`
  );
  assertCondition(executeJavaScriptModuleExport.output === 3, 'JavaScript named export output should match');

  const executeSanitizedRuntimeHints = await harness.sendMessage<{
    success: boolean;
    error?: string;
  }>('execute-code', {
    code: 'function fail() { throw new ReferenceError("value is not defined. Did you mean `value2`?"); }',
    functionName: 'fail',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeSanitizedRuntimeHints.success === false, 'ReferenceError case should fail');
  assertCondition(
    typeof executeSanitizedRuntimeHints.error === 'string' &&
      !executeSanitizedRuntimeHints.error.toLowerCase().includes('did you mean'),
    'Runtime error messages should strip engine suggestion hints'
  );
  console.log('PASS: execute-code runtime hint sanitization');

  const executeScriptMode = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen.has(complement)) return [seen.get(complement), i];
    seen.set(nums[i], i);
  }
  return [];
}

result = twoSum([2, 7, 11, 15], 9);`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeScriptMode.success === true, 'Script execution should succeed');
  assertCondition(Array.isArray(executeScriptMode.output), 'Script execution output should be an array');
  const scriptOutput = executeScriptMode.output as unknown[];
  assertCondition(scriptOutput[0] === 0 && scriptOutput[1] === 1, 'Script execution output should equal [0, 1]');
  console.log('PASS: execute-code script mode result assignment');

  const executeScriptNoResultAfterAssignment = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: 'const untouched = 1;',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeScriptNoResultAfterAssignment.success === true, 'Script execution without result should succeed after prior result assignment');
  assertCondition(executeScriptNoResultAfterAssignment.output === null, 'Script execution should not reuse a previous script result');

  const executeScriptConstResult = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: `function sum(nums) {
  let total = 0;
  for (const value of nums) total += value;
  return total;
}

const result = sum([2, 1, 5, 1, 3, 2]);`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(
    executeScriptConstResult.success === true,
    `Script execution should allow user-declared const result, received ${executeScriptConstResult.error ?? 'unknown error'}`
  );
  assertCondition(executeScriptConstResult.output === 14, 'Script const result output should equal 14');
  console.log('PASS: execute-code script mode const result declaration');

  const executeScriptStdin = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: `const fs = require("fs");
const input = fs.readFileSync(0, "utf8").trim();
const nums = input.length === 0 ? [] : input.split(/\\s+/).map(Number);
console.log(nums.reduce((sum, value) => sum + value, 0));`,
    inputs: { stdin: '4 5 -2 10\n' },
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    executeScriptStdin.success === true,
    `Script stdin execution should support fs.readFileSync(0): ${executeScriptStdin.error ?? 'unknown error'}`
  );
  assertCondition(
    executeScriptStdin.output === '17\n',
    `Script stdin output should mirror stdout text, received ${JSON.stringify(executeScriptStdin.output)}`
  );

  const executeRuntimePreludeNodes = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `const head = new ListNode(1, new ListNode(2, new ListNode(3)));
const root = new TreeNode(2, new TreeNode(1), new TreeNode(3));
result = [head.val, head.value, head.next.val, head.next.value, root.left.val, root.left.value, root.right.val, root.right.value];`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeRuntimePreludeNodes.success === true, 'Runtime should expose ListNode/TreeNode prelude classes');
  assertCondition(Array.isArray(executeRuntimePreludeNodes.output), 'Prelude class execution output should be an array');
  const preludeOutput = executeRuntimePreludeNodes.output as unknown[];
  assertCondition(
    JSON.stringify(preludeOutput) === JSON.stringify([1, 1, 2, 2, 1, 1, 3, 3]),
    'Prelude class execution should preserve TraceCode ListNode/TreeNode val/value aliases'
  );
  console.log('PASS: execute-code runtime ListNode/TreeNode prelude support');

  const executeLinkedListCycleRefs = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `class Solution {
  hasCycle(head) {
    let slow = head;
    let fast = head;
    while (fast && fast.next) {
      slow = slow.next;
      fast = fast.next.next;
      if (slow === fast) return true;
    }
    return false;
  }
}`,
    functionName: 'hasCycle',
    executionStyle: 'solution-method',
    inputs: {
      head: {
        __id__: 'n0',
        val: 3,
        next: {
          __id__: 'n1',
          val: 2,
          next: {
            __id__: 'n2',
            val: 0,
            next: {
              __id__: 'n3',
              val: -4,
              next: { __ref__: 'n1' },
            },
          },
        },
      },
    },
  });
  assertCondition(executeLinkedListCycleRefs.success === true, 'Linked-list ref input execution should succeed');
  assertCondition(
    executeLinkedListCycleRefs.output === true,
    'Linked-list ref input should be hydrated so identity-based cycle checks pass'
  );
  console.log('PASS: execute-code linked-list ref hydration contract');

  const sharedLinkedListArrayInput = {
    lists: [
      {
        __type__: 'ListNode',
        val: 1,
        next: {
          __type__: 'ListNode',
          val: 2,
          next: null,
        },
      },
    ],
  };
  const mutateSharedLinkedListArray = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `class Solution {
  truncate(lists) {
    lists[0].next = null;
    return lists[0];
  }
}`,
    functionName: 'truncate',
    executionStyle: 'solution-method',
    inputs: sharedLinkedListArrayInput,
  });
  assertCondition(mutateSharedLinkedListArray.success === true, 'Linked-list array mutation execution should succeed');
  assertCondition(
    ((sharedLinkedListArrayInput.lists[0].next as Record<string, unknown> | null)?.val ?? null) === 2,
    'JavaScript worker execution should not mutate the caller-owned serialized linked-list input'
  );
  const readSharedLinkedListArray = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `class Solution {
  second(lists: Array<ListNode | null>): number {
    return lists[0]?.next?.val ?? -1;
  }
}`,
    functionName: 'second',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: sharedLinkedListArrayInput,
  });
  assertCondition(readSharedLinkedListArray.success === true, 'Linked-list array reuse execution should succeed');
  assertCondition(
    readSharedLinkedListArray.output === 2,
    'A later TypeScript run should see the original linked-list input, not a prior JavaScript mutation'
  );
  console.log('PASS: execute-code JS/TS linked-list input isolation contract');

  const executeTreeAliasRefs = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function hasAliasedChildren(root) {
  return !!root && root.left === root.right;
}`,
    functionName: 'hasAliasedChildren',
    executionStyle: 'function',
    inputs: {
      root: {
        __id__: 'root',
        val: 1,
        left: { __id__: 'left', val: 2, left: null, right: null },
        right: { __ref__: 'left' },
      },
    },
  });
  assertCondition(executeTreeAliasRefs.success === true, 'Tree alias ref input execution should succeed');
  assertCondition(
    executeTreeAliasRefs.output === true,
    'Tree alias ref input should be hydrated so shared child identity is preserved'
  );
  console.log('PASS: execute-code tree ref hydration contract');

  const executeJavaScriptTreeArrayInput = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function rightSideView(root) {
  if (!root) return [];
  return [root.val, root.right ? root.right.val : null];
}`,
    functionName: 'rightSideView',
    executionStyle: 'function',
    language: 'javascript',
    inputs: {
      root: [1, null, 3],
    },
  });
  assertCondition(executeJavaScriptTreeArrayInput.success === true, 'JavaScript tree array input execution should succeed');
  assertCondition(
    Array.isArray(executeJavaScriptTreeArrayInput.output) &&
      (executeJavaScriptTreeArrayInput.output as unknown[])[0] === 1 &&
      (executeJavaScriptTreeArrayInput.output as unknown[])[1] === 3,
    'JavaScript function-style tree inputs should hydrate level-order arrays into TreeNode objects'
  );
  console.log('PASS: execute-code javascript tree array hydration fallback');

  const executeJavaScriptSparseTreeArrayInput = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function collectRightChain(root) {
  const out = [];
  let node = root;
  while (node) {
    out.push(node.val);
    node = node.right;
  }
  return out;
}`,
    functionName: 'collectRightChain',
    executionStyle: 'function',
    language: 'javascript',
    inputs: {
      root: [1, null, 2, null, 3, null, 4, null, 5],
    },
  });
  assertCondition(executeJavaScriptSparseTreeArrayInput.success === true, 'JavaScript sparse tree array input execution should succeed');
  assertCondition(
    JSON.stringify(executeJavaScriptSparseTreeArrayInput.output) === JSON.stringify([1, 2, 3, 4, 5]),
    'JavaScript tree hydration should honor sparse level-order arrays'
  );
  console.log('PASS: execute-code javascript sparse tree array hydration');

  const executeSerializedCollections = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function snapshotCollections() {
  const seen = new Map([[2, 0], [7, 1]]);
  const visited = new Set([2, 7]);
  return { seen, visited };
}`,
    functionName: 'snapshotCollections',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeSerializedCollections.success === true, 'Collection serialization execution should succeed');
  const collectionsOutput = executeSerializedCollections.output as Record<string, unknown>;
  const seenOutput = collectionsOutput?.seen as { __type__?: unknown; entries?: unknown[] } | undefined;
  const visitedOutput = collectionsOutput?.visited as { __type__?: unknown; values?: unknown[] } | undefined;
  const firstSeenEntry = Array.isArray(seenOutput?.entries) ? seenOutput.entries[0] : undefined;
  assertCondition(seenOutput?.__type__ === 'map', 'Map values should serialize with __type__ = "map"');
  assertCondition(Array.isArray(seenOutput?.entries), 'Serialized map should expose entries array');
  assertCondition(
    Array.isArray(firstSeenEntry) && firstSeenEntry[0] === 2,
    'Serialized map entries should preserve key/value tuple ordering'
  );
  assertCondition(visitedOutput?.__type__ === 'set', 'Set values should serialize with __type__ = "set"');
  assertCondition(
    Array.isArray(visitedOutput?.values) && visitedOutput.values.length === 2,
    'Serialized set should expose values array'
  );
  console.log('PASS: execute-code map/set serialization contract');

  const executeLargeValueSerialization = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `function largeValueSnapshot() {
  const arr = Array.from({ length: 70 }, (_, i) => i);
  const map = new Map(arr.map((value) => [String(value), value]));
  const set = new Set(arr);
  return { arr, map, set };
}`,
    functionName: 'largeValueSnapshot',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(executeLargeValueSerialization.success === true, 'Large value serialization should succeed');
  const largeOutput = executeLargeValueSerialization.output as Record<string, unknown>;
  const largeArray = largeOutput.arr as unknown[];
  const largeMap = largeOutput.map as { entries?: unknown[]; __truncated__?: unknown; remaining?: unknown };
  const largeSet = largeOutput.set as { values?: unknown[]; __truncated__?: unknown; remaining?: unknown };
  assertCondition(
    Array.isArray(largeArray) &&
      largeArray.length === 70 &&
      largeArray[69] === 69,
    'Final output arrays should not use the trace snapshot item cap'
  );
  assertCondition(
    Array.isArray(largeMap.entries) &&
      largeMap.entries.length === 70 &&
      largeMap.__truncated__ !== true,
    'Final output maps should not use the trace snapshot item cap'
  );
  assertCondition(
    Array.isArray(largeSet.values) &&
      largeSet.values.length === 70 &&
      largeSet.__truncated__ !== true,
    'Final output sets should not use the trace snapshot item cap'
  );
  console.log('PASS: execute-code large final output serialization is uncapped');

  const traceLargeArrayBuffer = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function largeArrayBuffer() {
  const buffer = new ArrayBuffer(1024);
  const bytes = new Uint8Array(buffer);
  bytes[0] = 7;
  bytes[63] = 63;
  bytes[64] = 64;
  return { buffer };
}`,
    functionName: 'largeArrayBuffer',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(traceLargeArrayBuffer.success === true, 'Large ArrayBuffer trace execution should succeed');
  const traceBufferReturnValue = traceEvents(traceLargeArrayBuffer).find(
    (event) => event.kind === 'return' && event.function === 'largeArrayBuffer'
  )?.value as { buffer?: unknown[] } | undefined;
  const traceBufferOutput = traceBufferReturnValue?.buffer;
  const traceBufferMarker = Array.isArray(traceBufferOutput)
    ? traceBufferOutput.at(-1) as { __truncated__?: unknown; remaining?: unknown } | undefined
    : undefined;
  assertCondition(
    Array.isArray(traceBufferOutput) &&
      traceBufferOutput.length === 65 &&
      traceBufferOutput[0] === 7 &&
      traceBufferOutput[63] === 63 &&
      traceBufferMarker?.__truncated__ === true &&
      traceBufferMarker.remaining === 960,
    `Trace ArrayBuffer output should serialize only capped bytes plus truncation marker: ${JSON.stringify(traceBufferOutput)}`
  );
  console.log('PASS: execute-with-tracing caps ArrayBuffer serialization before copying');

  const executeTypeScript = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: 'function typedAdd(a: number, b: number): number { return a + b; }',
    functionName: 'typedAdd',
    inputs: { a: 4, b: 6 },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(executeTypeScript.success === true, 'TypeScript execution should succeed');
  assertCondition(executeTypeScript.output === 10, 'TypeScript output should equal 10');
  console.log('PASS: execute-code typescript transpilation');

  const executeJavaScriptStaticSolutionMethod = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: `class Solution {
  static join(left, right) {
    return left + ":" + right;
  }
}`,
    functionName: 'join',
    inputs: { left: 'a', right: 'b' },
    executionStyle: 'solution-method',
    language: 'javascript',
  });
  assertCondition(
    executeJavaScriptStaticSolutionMethod.success === true,
    `JavaScript static Solution method should execute: ${executeJavaScriptStaticSolutionMethod.error ?? 'unknown error'}`
  );
  assertCondition(executeJavaScriptStaticSolutionMethod.output === 'a:b', 'JavaScript static Solution method output should match');

  const traceTypeScriptStaticSolutionMethod = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `class Solution {
  static join(left: string, right: string): string {
    return left + ":" + right;
  }
}`,
    functionName: 'join',
    inputs: { right: 'b', left: 'a' },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    traceTypeScriptStaticSolutionMethod.success === true,
    `TypeScript static Solution method tracing should execute: ${traceTypeScriptStaticSolutionMethod.error ?? 'unknown error'}`
  );
  assertCondition(traceTypeScriptStaticSolutionMethod.output === 'a:b', 'TypeScript static Solution tracing output should match');
  console.log('PASS: execute-code solution-method supports static Solution methods');

  const executeTypeScriptCustomRecord = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: `class Campaign {
  constructor(public cap: number, public bid: number) {}
}

class Solution {
  score(campaigns: Record<string, Campaign>): number {
    return campaigns.a instanceof Campaign ? campaigns.a.cap + campaigns.a.bid : -1;
  }
}`,
    functionName: 'score',
    inputs: { campaigns: { a: { bid: 5, cap: 7 } } },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    executeTypeScriptCustomRecord.success === true,
    `TypeScript custom record hydration should succeed: ${executeTypeScriptCustomRecord.error ?? 'unknown error'}`
  );
  assertCondition(executeTypeScriptCustomRecord.output === 12, 'TypeScript annotations should hydrate custom record values');
  console.log('PASS: execute-code typescript custom record hydration');

  const executeJavaScriptExplicitCustomObject = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: `class Campaign {
  constructor(cap, bid) {
    this.cap = cap;
    this.bid = bid;
  }
}

class Solution {
  score(campaigns) {
    return campaigns.a instanceof Campaign ? campaigns.a.cap + campaigns.a.bid : -1;
  }
}`,
    functionName: 'score',
    inputs: { campaigns: { a: { __type__: 'Campaign', bid: 5, cap: 7 } } },
    executionStyle: 'solution-method',
    language: 'javascript',
  });
  assertCondition(
    executeJavaScriptExplicitCustomObject.success === true,
    `JavaScript explicit custom object hydration should succeed: ${executeJavaScriptExplicitCustomObject.error ?? 'unknown error'}`
  );
  assertCondition(executeJavaScriptExplicitCustomObject.output === -1, 'JavaScript untrusted __type__ metadata should not hydrate custom objects');
  console.log('PASS: execute-code javascript untrusted custom metadata stays inert');

  const executeTypeScriptLibraryImport = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
  }>('execute-code', {
    code: `import { MinPriorityQueue } from '@datastructures-js/priority-queue';

function smallest(nums: number[]): number {
  const pq = new MinPriorityQueue<number>();
  nums.forEach((num) => pq.enqueue(num));
  return pq.dequeue();
}`,
    functionName: 'smallest',
    inputs: { nums: [9, 4, 7] },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(
    executeTypeScriptLibraryImport.success === true,
    `TypeScript datastructures-js import should succeed: ${executeTypeScriptLibraryImport.error ?? 'unknown error'}`
  );
  assertCondition(
    executeTypeScriptLibraryImport.output === 4,
    'TypeScript worker should resolve datastructures-js imports through the JavaScript module registry'
  );
  console.log('PASS: execute-code typescript library import');

  const packageExecutorArgOrder = await executeTypeScriptCode(
    `class Solution {
  canSplitTeams(n: number, conflicts: number[][]): boolean {
    return typeof n === 'number' && Array.isArray(conflicts);
  }
}`,
    'canSplitTeams',
    {
      conflicts: [[0, 1]],
      n: 7,
    },
    'solution-method'
  );
  assertCondition(packageExecutorArgOrder.success === true, 'Package executor arg-order case should succeed');
  assertCondition(
    packageExecutorArgOrder.output === true,
    'Package executor should bind solution-method args by signature order, not object key order'
  );
  console.log('PASS: package executor solution-method arg order contract');

  const packageExecutorCustomRecord = await executeTypeScriptCode(
    `class Campaign {
  constructor(public cap: number, public bid: number) {}
}

class Solution {
  score(campaigns: Record<string, Campaign>): number {
    return campaigns.a instanceof Campaign ? campaigns.a.cap + campaigns.a.bid : -1;
  }
}`,
    'score',
    { campaigns: { a: { bid: 5, cap: 7 } } },
    'solution-method'
  );
  assertCondition(packageExecutorCustomRecord.success === true, 'Package executor custom record case should succeed');
  assertCondition(
    packageExecutorCustomRecord.output === 12,
    'Package executor should use TypeScript annotations to hydrate custom record values'
  );
  console.log('PASS: package executor TypeScript custom record hydration');

  const packageExecutorLibraryImport = await executeTypeScriptCode(
    `import { MinPriorityQueue } from '@datastructures-js/priority-queue';

function smallest(nums: number[]): number {
  const pq = new MinPriorityQueue<number>();
  nums.forEach((num) => pq.enqueue(num));
  return pq.dequeue();
}`,
    'smallest',
    { nums: [8, 2, 6] },
    'function'
  );
  assertCondition(
    packageExecutorLibraryImport.success === true,
    `Package executor datastructures-js import should succeed: ${packageExecutorLibraryImport.error ?? 'unknown error'}`
  );
  assertCondition(
    packageExecutorLibraryImport.output === 2,
    'Package executor should resolve TypeScript datastructures-js imports through the JavaScript module registry'
  );
  console.log('PASS: package executor TypeScript library import');

  const executeTypeScriptLinkedListCycleRefs = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `class Solution {
  hasCycle(head) {
    let slow = head;
    let fast = head;
    while (fast && fast.next) {
      slow = slow.next;
      fast = fast.next.next;
      if (slow === fast) return true;
    }
    return false;
  }
}`,
    functionName: 'hasCycle',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      head: {
        __id__: 'self-loop',
        val: 7,
        next: { __ref__: 'self-loop' },
      },
    },
  });
  assertCondition(
    executeTypeScriptLinkedListCycleRefs.success === true,
    'TypeScript linked-list ref execution should succeed'
  );
  assertCondition(
    executeTypeScriptLinkedListCycleRefs.output === true,
    'TypeScript linked-list ref inputs should hydrate before execution'
  );
  console.log('PASS: execute-code typescript linked-list ref hydration contract');

  const executeTypeScriptArgOrder = await harness.sendMessage<{
    success: boolean;
    output: unknown;
  }>('execute-code', {
    code: `class Solution {
  canSplitTeams(n: number, conflicts: number[][]): boolean {
    return typeof n === 'number' && Array.isArray(conflicts);
  }
}`,
    functionName: 'canSplitTeams',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      conflicts: [[0, 1]],
      n: 7,
    },
  });
  assertCondition(executeTypeScriptArgOrder.success === true, 'TypeScript arg-order execution should succeed');
  assertCondition(
    executeTypeScriptArgOrder.output === true,
    'TypeScript worker should bind solution-method args by signature order'
  );
  console.log('PASS: execute-code typescript solution-method arg order contract');

  const executeTypeScriptTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    trace: Array<{ event?: string; line?: number; function?: string }>;
  }>('execute-with-tracing', {
    code: `function typedSquare(x: number): number {
  const value = x * x;
  return value;
}`,
    functionName: 'typedSquare',
    inputs: { x: 5 },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptTracing.success === true, 'TypeScript tracing should succeed');
  assertCondition(
    traceLineEvents(executeTypeScriptTracing).some((event) => event.line === 2),
    'TypeScript tracing should map line events back to source line numbers'
  );
  assertCondition(
    traceLineEvents(executeTypeScriptTracing).some((event) => event.line === 3),
    'TypeScript tracing should preserve return-line mapping from source'
  );
  console.log('PASS: execute-with-tracing typescript line mapping contract');

  const executeTypeScriptOpsClassReceiverTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      event?: string;
      function?: string;
      line?: number;
      variables?: Record<string, unknown>;
    }>;
  }>('execute-with-tracing', {
    code: `class MedianFinder {
  constructor() {
    this.lo = [];
    this.hi = [];
  }

  addNum(num: number): null {
    this.lo.push(num);
    return null;
  }
}`,
    functionName: 'MedianFinder',
    executionStyle: 'ops-class',
    language: 'typescript',
    inputs: {
      operations: ['MedianFinder', 'addNum'],
      arguments: [[], [5]],
    },
  });
  assertCondition(executeTypeScriptOpsClassReceiverTracing.success === true, 'TypeScript ops-class tracing should succeed');
  const receiverTraceStep = traceSnapshotEvents(executeTypeScriptOpsClassReceiverTracing).find(
    (event) =>
      event.frameId?.startsWith('addNum:') &&
      event.target?.variable === 'this'
  );
  assertCondition(Boolean(receiverTraceStep), 'Ops-class method tracing should snapshot `this`');
  const receiverValue = receiverTraceStep?.value as Record<string, unknown> | undefined;
  assertCondition(receiverValue?.__class__ === 'MedianFinder', 'Receiver snapshot should preserve custom class identity');
  const mutatedReceiverTraceStep = traceSnapshotEvents(executeTypeScriptOpsClassReceiverTracing).find(
    (event) =>
      event.frameId?.startsWith('addNum:') &&
      event.target?.variable === 'this' &&
      Array.isArray((event.value as Record<string, unknown> | undefined)?.lo) &&
      ((event.value as Record<string, unknown>).lo as unknown[]).length === 1
  );
  assertCondition(Boolean(mutatedReceiverTraceStep), 'Ops-class method tracing should retain live receiver fields after mutation');
  const mutatedReceiverValue = mutatedReceiverTraceStep?.value as Record<string, unknown> | undefined;
  assertCondition(
    Array.isArray(mutatedReceiverValue?.lo) && (mutatedReceiverValue?.lo as unknown[])[0] === 5,
    'Receiver snapshot should expose live instance fields'
  );
  console.log('PASS: execute-with-tracing ops-class methods snapshot receiver state');

  const executeJavaScriptOpsClassMapSizeTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.cache = new Map();
    this.head = {};
    this.tail = {};
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  _remove(node) {
    const prevNode = node.prev;
    const nextNode = node.next;
    prevNode.next = nextNode;
    nextNode.prev = prevNode;
  }

  _addToFront(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
  }

  put(key, value) {
    if (this.cache.has(key)) {
      const node = this.cache.get(key);
      node.val = value;
      this._remove(node);
      this._addToFront(node);
      return null;
    }

    if (this.cache.size >= this.capacity) {
      const lru = this.tail.prev;
      this._remove(lru);
      this.cache.delete(lru.key);
    }

    const newNode = { key, val: value };
    this.cache.set(key, newNode);
    this._addToFront(newNode);
    return null;
  }

  get(key) {
    if (!this.cache.has(key)) {
      return -1;
    }

    const node = this.cache.get(key);
    this._remove(node);
    this._addToFront(node);
    return node.val;
  }
}`,
    functionName: 'LRUCache',
    executionStyle: 'ops-class',
    language: 'javascript',
    inputs: {
      operations: ['LRUCache', 'put', 'put', 'get', 'put', 'get', 'put', 'get', 'get', 'get'],
      arguments: [[2], [1, 1], [2, 2], [1], [3, 3], [2], [4, 4], [1], [3], [4]],
    },
  });
  assertCondition(
    executeJavaScriptOpsClassMapSizeTracing.success === true,
    `JavaScript traced LRU ops-class should succeed: ${executeJavaScriptOpsClassMapSizeTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(executeJavaScriptOpsClassMapSizeTracing.output) === JSON.stringify([null, null, null, 1, null, -1, null, -1, 3, 4]),
    `JavaScript tracing should preserve Map.size semantics in ops-class code, received ${JSON.stringify(executeJavaScriptOpsClassMapSizeTracing.output)}`
  );
  console.log('PASS: execute-with-tracing preserves JS Map.size runtime semantics in ops-class');

  const executeJavaScriptPrivateMapFieldTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `class Solution {
  #graph;

  constructor() {
    this.#graph = new Map([[0, []]]);
  }

  solve() {
    this.#graph.get(0).push(1);
    return this.#graph.get(0).length;
  }
}`,
    functionName: 'solve',
    executionStyle: 'solution-method',
    language: 'javascript',
    inputs: {},
  });
  assertCondition(
    executeJavaScriptPrivateMapFieldTracing.success === true,
    `JavaScript private Map field tracing should succeed: ${executeJavaScriptPrivateMapFieldTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    executeJavaScriptPrivateMapFieldTracing.output === 1,
    `JavaScript private Map field tracing should preserve output, got ${JSON.stringify(executeJavaScriptPrivateMapFieldTracing.output)}`
  );
  console.log('PASS: execute-with-tracing preserves JS private Map fields');

  const executeTypeScriptBfsLineMapping = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      line?: number;
      accesses?: RuntimeAccessEvent[];
    }>;
  }>('execute-with-tracing', {
    code: `class Solution {
  canSplitTeams(n: number, conflicts: number[][]): boolean {
    const graph: number[][] = Array.from({ length: n }, () => []);

    for (const [a, b] of conflicts) {
      graph[a].push(b);
      graph[b].push(a);
    }

    const color: number[] = new Array(n).fill(-1);

    for (let start = 0; start < n; start++) {
      if (color[start] !== -1) continue;

      const queue: number[] = [start];
      color[start] = 0;

      while (queue.length > 0) {
        const node = queue.shift()!;

        for (const nei of graph[node]) {
          if (color[nei] === -1) {
            color[nei] = 1 - color[node];
            queue.push(nei);
          } else if (color[nei] === color[node]) {
            return false;
          }
        }
      }
    }

    return true;
  }
}`,
    functionName: 'canSplitTeams',
    className: 'Solution',
    inputs: { n: 5, conflicts: [[0, 1], [1, 2], [2, 3], [3, 4]] },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptBfsLineMapping.success === true, 'TypeScript BFS tracing should succeed');
  const queuePushLines = traceAccessEvents(executeTypeScriptBfsLineMapping)
    .filter((event) => event.target?.variable === 'queue' && event.kind === 'mutate' && event.method === 'push')
    .map((event) => event.line);
  assertCondition(
    queuePushLines.length > 0 && queuePushLines.every((line) => line !== 16 && line !== 17 && line !== 18),
    'TypeScript BFS tracing should not attach queue.push effects to stale queue setup or blank lines'
  );
  const graphReadLines = traceAccessEvents(executeTypeScriptBfsLineMapping)
    .filter((event) => event.target?.variable === 'graph' && event.kind === 'read')
    .map((event) => event.line);
  assertCondition(
    graphReadLines.length > 0 && graphReadLines.every((line) => line !== 18 && line !== 20),
    'TypeScript BFS tracing should not attach graph neighbor reads to blank separator lines'
  );
  console.log('PASS: execute-with-tracing typescript BFS line alignment contract');

  const executeTypeScriptGraphConstructionState = await harness.sendMessage<{
    success: boolean;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  canFinish(numCourses: number, prerequisites: number[][]): boolean {
    const graph: number[][] = Array.from({ length: numCourses }, () => []);

    for (const [course, prereq] of prerequisites) {
      graph[prereq].push(course);
    }

    return true;
  }
}`,
    functionName: 'canFinish',
    className: 'Solution',
    inputs: { numCourses: 3, prerequisites: [[0, 1], [0, 2], [1, 2]] },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    executeTypeScriptGraphConstructionState.success === true,
    'TypeScript graph construction tracing should succeed'
  );
  const graphMutationEvents = traceAccessEvents(executeTypeScriptGraphConstructionState).filter(
    (event) => event.kind === 'mutate' && event.line === 6 && event.target?.variable === 'graph' && event.method === 'push'
  );
  const graphSnapshots = traceSnapshotFrames(executeTypeScriptGraphConstructionState).map((frame) => frame.snapshots.graph);
  assertCondition(
    graphMutationEvents.length === 3 && graphSnapshots.some((snapshot) => JSON.stringify(snapshot) === JSON.stringify([[], [0], [0, 1]])),
    `TypeScript mutating-call trace should retain all graph mutations and final graph state, received ${JSON.stringify(
      graphMutationEvents
    )}`
  );
  const graphConstructionBindingReads = traceAccessEvents(executeTypeScriptGraphConstructionState).filter(
    (event) =>
      event.kind === 'read' &&
      event.line === 5 &&
      event.target?.variable === 'prerequisites' &&
      Array.isArray(event.target.path) &&
      event.binding?.kind === 'iteration' &&
      event.binding.variable === 'course,prereq'
  );
  assertCondition(
    graphConstructionBindingReads.length === 3,
    `TypeScript destructured for-of should emit iteration binding reads, received ${JSON.stringify(
      graphConstructionBindingReads
    )}`
  );
  for (const [bindingVariable, expectedPath, expectedValue] of [
    ['course', [0, 0], 0],
    ['prereq', [0, 1], 1],
  ] as Array<[string, Array<string | number>, number]>) {
    const slotBindingRead = traceAccessEvents(executeTypeScriptGraphConstructionState).find(
      (event) =>
        event.kind === 'read' &&
        event.line === 5 &&
        event.target?.variable === 'prerequisites' &&
        JSON.stringify(event.target.path) === JSON.stringify(expectedPath) &&
        JSON.stringify(event.target.indexSources) === JSON.stringify([null, null]) &&
        event.binding?.kind === 'iteration' &&
        event.binding.variable === bindingVariable &&
        event.value === expectedValue
    );
    assertCondition(
      Boolean(slotBindingRead),
      `TypeScript destructured graph construction should emit ${bindingVariable} source-cell binding, received ${JSON.stringify(
        executeTypeScriptGraphConstructionState.trace?.events
      )}`
    );
  }
  console.log('PASS: execute-with-tracing typescript mutating-call post-line state contract');

  for (const language of ['javascript', 'typescript'] as const) {
    const bulkIndexedMutationState = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code: language === 'typescript'
        ? `class Solution {
  sortAndReverse(nums: number[]): number[] {
    nums.sort((left, right) => left - right);
    nums.reverse();
    return nums;
  }
}`
        : `class Solution {
  sortAndReverse(nums) {
    nums.sort((left, right) => left - right);
    nums.reverse();
    return nums;
  }
}`,
      functionName: 'sortAndReverse',
      className: 'Solution',
      inputs: { nums: [3, 1, 2] },
      executionStyle: 'solution-method',
      language,
    });
    assertCondition(
      bulkIndexedMutationState.success === true,
      `${language} bulk indexed mutation tracing should succeed: ${bulkIndexedMutationState.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(bulkIndexedMutationState.output) === JSON.stringify([3, 2, 1]),
      `${language} bulk indexed mutation tracing should preserve output`
    );
    const bulkAccesses = traceAccessEvents(bulkIndexedMutationState);
    assertCondition(
      bulkAccesses.some((event) =>
        event.kind === 'mutate' &&
        event.line === 3 &&
        event.target?.variable === 'nums' &&
        event.method === 'sort'
      ) &&
        bulkAccesses.some((event) =>
          event.kind === 'write' &&
          event.line === 3 &&
          event.target?.variable === 'nums' &&
          JSON.stringify(event.target.path) === JSON.stringify([0]) &&
          event.value === 1
        ),
      `${language} sort should emit receiver mutation plus concrete sorted-cell writes, received ${JSON.stringify(bulkAccesses)}`
    );
    assertCondition(
      bulkAccesses.some((event) =>
        event.kind === 'mutate' &&
        event.line === 4 &&
        event.target?.variable === 'nums' &&
        event.method === 'reverse'
      ) &&
        bulkAccesses.some((event) =>
          event.kind === 'write' &&
          event.line === 4 &&
          event.target?.variable === 'nums' &&
          JSON.stringify(event.target.path) === JSON.stringify([0]) &&
          event.value === 3
        ),
      `${language} reverse should emit receiver mutation plus concrete reversed-cell writes, received ${JSON.stringify(bulkAccesses)}`
    );
  }
  console.log('PASS: execute-with-tracing JS/TS bulk indexed mutations emit concrete cell writes');

  const executeTypeScriptSingleLineIfMutationState = await harness.sendMessage<{
    success: boolean;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  findMatch(s: string, p: string): number[] {
    const result: number[] = [];
    if (s.length === p.length) result.push(0);
    return result;
  }
}`,
    functionName: 'findMatch',
    className: 'Solution',
    inputs: { s: 'a', p: 'a' },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    executeTypeScriptSingleLineIfMutationState.success === true,
    'TypeScript single-line if mutation tracing should succeed'
  );
  const singleLineIfResultSnapshots = traceSnapshotFrames(executeTypeScriptSingleLineIfMutationState)
    .filter((frame) => frame.line === 4)
    .map((frame) => frame.snapshots.result);
  assertCondition(
    JSON.stringify(singleLineIfResultSnapshots) === JSON.stringify([[0]]),
    `TypeScript single-line if mutating-call should snapshot post-line result state, received ${JSON.stringify(singleLineIfResultSnapshots)}`
  );
  console.log('PASS: execute-with-tracing typescript single-line if mutating-call post-line state contract');

  const executeTypeScriptSingleLineIfReadLineState = await harness.sendMessage<{
    success: boolean;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  probe(nums: number[]): number {
    const heap: number[] = [];
    heap.push(nums[0]);
    let i = 0;
    const parent = 0;
    const isLess = (left: number, right: number): boolean => left < right;
    if (!isLess(heap[i], heap[parent])) heap.push(nums[1]);
    return heap.length;
  }
}`,
    functionName: 'probe',
    className: 'Solution',
    inputs: { nums: [2, 3] },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    executeTypeScriptSingleLineIfReadLineState.success === true,
    'TypeScript single-line if read alignment tracing should succeed'
  );
  const singleLineIfHeapReadLines = traceAccessEvents(executeTypeScriptSingleLineIfReadLineState)
    .filter((event) => event.kind === 'read' && event.target?.variable === 'heap')
    .map((event) => event.line);
  assertCondition(
    singleLineIfHeapReadLines.includes(8) &&
      !singleLineIfHeapReadLines.includes(6) &&
      !singleLineIfHeapReadLines.includes(7),
    `TypeScript single-line if condition reads should attach to the if line, received ${JSON.stringify(singleLineIfHeapReadLines)}`
  );
  console.log('PASS: execute-with-tracing typescript single-line if condition read line contract');

  const executeTypeScriptSingleLineWhileBodyReadLocation = await harness.sendMessage<{
    success: boolean;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  probe(): number {
    let fast: any = { next: { next: null } };
    let slow: any = { next: { next: null } };
    while (fast) { fast = fast.next; slow = slow.next; }
    return slow ? 1 : 0;
  }
}`,
    functionName: 'probe',
    className: 'Solution',
    inputs: {},
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    executeTypeScriptSingleLineWhileBodyReadLocation.success === true,
    'TypeScript single-line while body read location tracing should succeed'
  );
  const singleLineWhileSlowReadColumns = traceAccessEvents(executeTypeScriptSingleLineWhileBodyReadLocation)
    .filter((event) => event.kind === 'read' && event.target?.variable === 'slow')
    .map((event) => event.column);
  assertCondition(
    singleLineWhileSlowReadColumns.some((column) => typeof column === 'number' && column > 35),
    `TypeScript single-line while body property reads should carry expression columns, received ${JSON.stringify(singleLineWhileSlowReadColumns)}`
  );
  console.log('PASS: execute-with-tracing typescript single-line while body read column contract');

  for (const language of ['javascript', 'typescript'] as const) {
    const shortestPalindromeSingleLineWhile = await harness.sendMessage<{
      success: boolean;
      trace: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Solution {
  shortestPalindrome(s: string): string {
    const rev = s.split('').reverse().join('');
    const t = s + '#' + rev;
    const lps = new Array(t.length).fill(0);
    for (let i = 1; i < t.length; i++) {
      let j = lps[i - 1];
      while (j > 0 && t[i] !== t[j]) j = lps[j - 1];
      if (t[i] === t[j]) j++;
      lps[i] = j;
    }
    const palinLen = lps[t.length - 1];
    return rev.slice(0, s.length - palinLen) + s;
  }
}`
          : `class Solution {
  shortestPalindrome(s) {
    const rev = s.split('').reverse().join('');
    const t = s + '#' + rev;
    const lps = new Array(t.length).fill(0);
    for (let i = 1; i < t.length; i++) {
      let j = lps[i - 1];
      while (j > 0 && t[i] !== t[j]) j = lps[j - 1];
      if (t[i] === t[j]) j++;
      lps[i] = j;
    }
    const palinLen = lps[t.length - 1];
    return rev.slice(0, s.length - palinLen) + s;
  }
}`,
      functionName: 'shortestPalindrome',
      className: 'Solution',
      inputs: { s: 'aacecaaa' },
      executionStyle: 'solution-method',
      language,
    });
    assertCondition(
      shortestPalindromeSingleLineWhile.success === true,
      `${language} shortest-palindrome single-line while tracing should succeed`
    );
    const shortestPalindromeAccesses = traceAccessEvents(shortestPalindromeSingleLineWhile);
    const falseConditionFrames = traceLineFrames(shortestPalindromeSingleLineWhile, 9).filter((frame) => {
      const tReads = frame.filter((event) => event.kind === 'read' && event.target?.variable === 't');
      return tReads.some((event) => event.value === '#') && tReads.some((event) => event.value === 'a');
    });
    assertCondition(
      shortestPalindromeAccesses.some(
        (event) =>
          event.kind === 'read' &&
          event.target?.variable === 'lps' &&
          JSON.stringify(event.target.indexSources) === JSON.stringify(['j - 1'])
      ) &&
        shortestPalindromeAccesses.some(
          (event) =>
            event.kind === 'write' &&
            event.target?.variable === 'j'
        ),
      `${language} shortest-palindrome single-line while body should emit lps[j - 1] read and j write, received ${JSON.stringify(shortestPalindromeAccesses)}`
    );
    assertCondition(
      falseConditionFrames.length > 0 &&
        falseConditionFrames.every((frame) =>
          !frame.some((event) => event.kind === 'write' && event.target?.variable === 'j')
        ),
      `${language} shortest-palindrome false single-line if branch should not emit j write, received ${JSON.stringify(falseConditionFrames)}`
    );
  }
  console.log('PASS: execute-with-tracing JS/TS shortest-palindrome single-line while body access contract');

  const sortArrayTypeScriptSingleLineMerge = await harness.sendMessage<{
    success: boolean;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  sortArray(nums: number[]): number[] {
    const arr = nums;
    if (arr.length <= 1) return arr;
    const mid = arr.length >> 1;
    const left = this.sortArray(arr.slice(0, mid));
    const right = this.sortArray(arr.slice(mid));
    const merged: number[] = [];
    let i = 0, j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] <= right[j]) merged.push(left[i++]);
      else merged.push(right[j++]);
    }
    while (i < left.length) merged.push(left[i++]);
    while (j < right.length) merged.push(right[j++]);
    return merged;
  }
}`,
    functionName: 'sortArray',
    className: 'Solution',
    inputs: { nums: [5, 2, 3, 1] },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    sortArrayTypeScriptSingleLineMerge.success === true,
    'TypeScript sort-an-array single-line merge tracing should succeed'
  );
  const sortArrayAccesses = traceAccessEvents(sortArrayTypeScriptSingleLineMerge);
  assertCondition(
    sortArrayAccesses.some(
      (event) =>
        event.kind === 'read' &&
        event.target?.variable === 'left' &&
        JSON.stringify(event.target.indexSources) === JSON.stringify(['i'])
    ) &&
      sortArrayAccesses.some((event) => event.kind === 'write' && event.target?.variable === 'i') &&
      sortArrayAccesses.some(
        (event) =>
          event.kind === 'read' &&
          event.target?.variable === 'right' &&
          JSON.stringify(event.target.indexSources) === JSON.stringify(['j'])
      ) &&
      sortArrayAccesses.some((event) => event.kind === 'write' && event.target?.variable === 'j') &&
      sortArrayAccesses.some(
        (event) =>
          event.kind === 'mutate' &&
          event.target?.variable === 'merged' &&
          event.method === 'push'
      ),
    `TypeScript sort-an-array single-line merge should emit incrementing argument reads/writes and merged.push mutations, received ${JSON.stringify(sortArrayAccesses)}`
  );
  console.log('PASS: execute-with-tracing TypeScript sort-an-array single-line merge access contract');

  const executeTypeScriptSingleLineIfBreakReadLineState = await harness.sendMessage<{
    success: boolean;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  probe(nums: number[]): number {
    const heap: number[] = [];
    heap.push(nums[0]);
    heap.push(nums[1]);
    let i = 1;
    const parent = 0;
    const isLess = (left: number, right: number): boolean => left < right;
    while (i > 0) {
      if (!isLess(heap[i], heap[parent])) break;
      i--;
    }
    return heap.length;
  }
}`,
    functionName: 'probe',
    className: 'Solution',
    inputs: { nums: [2, 3] },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    executeTypeScriptSingleLineIfBreakReadLineState.success === true,
    'TypeScript single-line if break read alignment tracing should succeed'
  );
  const singleLineIfBreakHeapWrites = traceAccessEvents(executeTypeScriptSingleLineIfBreakReadLineState)
    .filter((event) => event.kind === 'write' && event.target?.variable === 'heap');
  assertCondition(
    singleLineIfBreakHeapWrites.some((event) => JSON.stringify(event.target?.path) === JSON.stringify([0]) && event.value === 2) &&
      singleLineIfBreakHeapWrites.some((event) => JSON.stringify(event.target?.path) === JSON.stringify([1]) && event.value === 3),
    `TypeScript array-backed heap pushes should emit concrete indexed writes, received ${JSON.stringify(singleLineIfBreakHeapWrites)}`
  );
  const singleLineIfBreakHeapReadLines = traceAccessEvents(executeTypeScriptSingleLineIfBreakReadLineState)
    .filter((event) =>
      event.kind === 'read' &&
      event.target?.variable === 'heap' &&
      event.target.path?.[0] !== 'length'
    )
    .map((event) => event.line);
  assertCondition(
    singleLineIfBreakHeapReadLines.includes(10) &&
      !singleLineIfBreakHeapReadLines.includes(12) &&
      !singleLineIfBreakHeapReadLines.includes(13),
    `TypeScript single-line if break condition reads should attach to the if line, received ${JSON.stringify(singleLineIfBreakHeapReadLines)}`
  );
  console.log('PASS: execute-with-tracing typescript single-line if break condition read line contract');

  const executeTypeScriptTopoLineMapping = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      line?: number;
      accesses?: RuntimeAccessEvent[];
    }>;
  }>('execute-with-tracing', {
    code: `class Solution {
  findOrder(numCourses: number, prerequisites: number[][]): number[] {
    const graph: number[][] = Array.from({ length: numCourses }, () => []);
    const indegree: number[] = new Array(numCourses).fill(0);

    for (const [a, b] of prerequisites) {
      graph[b].push(a);
      indegree[a]++;
    }

    const queue: number[] = [];
    for (let i = 0; i < numCourses; i++) {
      if (indegree[i] === 0) {
        queue.push(i);
      }
    }

    const order: number[] = [];
    let head = 0;

    while (head < queue.length) {
      const course = queue[head++];
      order.push(course);

      for (const next of graph[course]) {
        indegree[next]--;
        if (indegree[next] === 0) {
          queue.push(next);
        }
      }
    }

    return order.length === numCourses ? order : [];
  }
}`,
    functionName: 'findOrder',
    className: 'Solution',
    inputs: { numCourses: 4, prerequisites: [[1, 0], [2, 0], [3, 1], [3, 2]] },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptTopoLineMapping.success === true, 'TypeScript topological-sort tracing should succeed');
  const queuePushTopoLines = traceAccessEvents(executeTypeScriptTopoLineMapping)
    .filter((event) => event.target?.variable === 'queue' && event.kind === 'mutate' && event.method === 'push')
    .map((event) => event.line);
  assertCondition(
    queuePushTopoLines.length > 0 &&
      queuePushTopoLines.every((line) => line !== 11 && line !== 18 && line !== 19 && line !== 20),
    'TypeScript topological-sort tracing should not attach queue.push effects to stale queue/order setup lines'
  );
  const orderPushLines = traceAccessEvents(executeTypeScriptTopoLineMapping)
    .filter((event) => event.target?.variable === 'order' && event.kind === 'mutate' && event.method === 'push')
    .map((event) => event.line);
  assertCondition(
    orderPushLines.length > 0 && orderPushLines.every((line) => line === 23),
    'TypeScript topological-sort tracing should attach order.push effects to the line that executed the mutation'
  );
  const graphNeighborReadLines = traceAccessEvents(executeTypeScriptTopoLineMapping)
    .filter((event) => event.target?.variable === 'graph' && event.kind === 'read')
    .map((event) => event.line);
  assertCondition(
    graphNeighborReadLines.length > 0 &&
      graphNeighborReadLines.every((line) => line !== 18 && line !== 19 && line !== 20),
    'TypeScript topological-sort tracing should not attach graph neighbor reads to stale order/head setup lines'
  );
  console.log('PASS: execute-with-tracing typescript topological-sort line alignment contract');

  const executeTypeScriptArgOrderTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    trace: Array<{ event?: string; function?: string; returnValue?: unknown }>;
  }>('execute-with-tracing', {
    code: `class Solution {
  canSplitTeams(n: number, conflicts: number[][]): boolean {
    return typeof n === 'number' && Array.isArray(conflicts);
  }
}`,
    functionName: 'canSplitTeams',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      conflicts: [[0, 1]],
      n: 7,
    },
  });
  assertCondition(executeTypeScriptArgOrderTracing.success === true, 'TypeScript arg-order tracing should succeed');
  assertCondition(
    executeTypeScriptArgOrderTracing.output === true,
    'TypeScript traced execution should bind solution-method args by signature order'
  );
  assertCondition(
    traceEvents(executeTypeScriptArgOrderTracing).some(
      (event) => event.kind === 'return' && event.function === 'canSplitTeams' && event.value === true
    ),
    'TypeScript traced execution should preserve the successful return value for arg-order cases'
  );
  console.log('PASS: execute-with-tracing typescript solution-method arg order contract');

  const executeTypeScriptTreeInputTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    trace: Array<{
      line?: number;
      variables?: Record<string, unknown>;
    }>;
  }>('execute-with-tracing', {
    code: `class Solution {
  levelOrder(root: TreeNode | null): number[][] {
    if (!root) return [];
    const result: number[][] = [];
    const queue: TreeNode[] = [root];
    let front = 0;
    while (front < queue.length) {
      const levelSize = queue.length - front;
      const level: number[] = [];
      for (let i = 0; i < levelSize; i++) {
        const node = queue[front++];
        level.push(node.val);
        if (node.left) queue.push(node.left);
        if (node.right) queue.push(node.right);
      }
      result.push(level);
    }
    return result;
  }
}`,
    functionName: 'levelOrder',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      root: [3, 9, 20, null, null, 15, 7],
    },
  });
  assertCondition(executeTypeScriptTreeInputTracing.success === true, 'TypeScript tree-input tracing should succeed');
  assertCondition(
    JSON.stringify(executeTypeScriptTreeInputTracing.output) === JSON.stringify([[3], [9, 20], [15, 7]]),
    'TypeScript traced execution should materialize level-order arrays into TreeNode inputs'
  );
  const hasTreeTaggedLocal = traceSnapshotEvents(executeTypeScriptTreeInputTracing).some(
    (event) =>
      (event.target?.variable === 'root' || event.target?.variable === 'node') &&
      event.value &&
      typeof event.value === 'object'
  );
  assertCondition(
    hasTreeTaggedLocal,
    'TypeScript tree-input tracing should surface tree-tagged root/node locals once inputs are materialized'
  );
  assertNoRuntimeTraceVisualizerPayloadLeak(executeTypeScriptTreeInputTracing, 'typescript tree-input tracing');
  console.log('PASS: execute-with-tracing typescript tree input materialization contract');

  const executeTypeScriptPlainLeafTreeTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  maxPathSum(root: TreeNode | null): number {
    const dfs = (node: TreeNode | null): number => {
      if (!node) return 0;
      const leftGain = dfs(node.left);
      const rightGain = dfs(node.right);
      return node.val + Math.max(leftGain, rightGain);
    };
    return dfs(root);
  }
}`,
    functionName: 'maxPathSum',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      root: { val: 1, left: { val: 2 }, right: { val: 3 } },
    },
  });
  assertCondition(
    executeTypeScriptPlainLeafTreeTracing.success === true,
    `TypeScript plain-leaf tree tracing should succeed: ${executeTypeScriptPlainLeafTreeTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    executeTypeScriptPlainLeafTreeTracing.output === 4,
    'TypeScript plain-leaf tree tracing should preserve execution semantics'
  );
  const rootTreeSnapshot = traceSnapshotEvents(executeTypeScriptPlainLeafTreeTracing).find(
    (event) => event.target?.variable === 'root' && event.value && typeof event.value === 'object'
  )?.value as { left?: unknown; right?: unknown } | undefined;
  assertCondition(
    Boolean(runtimeRefId(rootTreeSnapshot?.left)) && Boolean(runtimeRefId(rootTreeSnapshot?.right)),
    `TypeScript plain tree leaf snapshots should receive stable child node ids, received ${JSON.stringify(rootTreeSnapshot)}`
  );
  const anonymousRecursiveChildArg = traceEvents(executeTypeScriptPlainLeafTreeTracing).some((event) => {
    if (event.kind !== 'call' || event.function !== 'dfs') return false;
    const node = (event.args as { node?: unknown } | undefined)?.node;
    return isAnonymousValueOnlyNode(node, 2) || isAnonymousValueOnlyNode(node, 3);
  });
  assertCondition(
    !anonymousRecursiveChildArg,
    'TypeScript recursive tree call args should preserve plain leaf node identity instead of emitting anonymous {val} objects'
  );
  console.log('PASS: execute-with-tracing typescript plain tree leaf identity contract');

  const executeJavaScriptDestructuringPropertySwapTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `class Solution {
  invertTree(root) {
    if (!root) return [];
    const invert = (node) => {
      if (!node) return;
      [node.left, node.right] = [node.right, node.left];
      invert(node.left);
      invert(node.right);
    };
    invert(root);
    return [root.val, root.left.val, root.right.val];
  }
}`,
    functionName: 'invertTree',
    executionStyle: 'solution-method',
    language: 'javascript',
    inputs: {
      root: [4, 2, 7],
    },
  });
  assertCondition(
    executeJavaScriptDestructuringPropertySwapTracing.success === true,
    `JavaScript destructuring property swap tracing should succeed: ${executeJavaScriptDestructuringPropertySwapTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(executeJavaScriptDestructuringPropertySwapTracing.output) === JSON.stringify([4, 7, 2]),
    'JavaScript destructuring property swap tracing should preserve execution semantics'
  );

  const executeTypeScriptDestructuringPropertySwapTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `class Solution {
  invertTree(root: TreeNode | null): number[] {
    if (!root) return [];
    const invert = (node: TreeNode | null): void => {
      if (!node) return;
      [node.left, node.right] = [node.right, node.left];
      invert(node.left);
      invert(node.right);
    };
    invert(root);
    return [root.val, root.left!.val, root.right!.val];
  }
}`,
    functionName: 'invertTree',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      root: [4, 2, 7],
    },
  });
  assertCondition(
    executeTypeScriptDestructuringPropertySwapTracing.success === true,
    `TypeScript destructuring property swap tracing should succeed: ${executeTypeScriptDestructuringPropertySwapTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(executeTypeScriptDestructuringPropertySwapTracing.output) === JSON.stringify([4, 7, 2]),
    'TypeScript destructuring property swap tracing should preserve execution semantics'
  );
  console.log('PASS: execute-with-tracing JS/TS destructuring property swap contract');

  for (const language of ['javascript', 'typescript'] as const) {
    const executeRecursiveUndefinedChildCallTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Solution {
  maxPathSum(root: TreeNode | null): number {
    const dfs = (node: TreeNode | null): number => {
      if (!node) return 0;
      return dfs(node.left) + dfs(node.right) + node.val;
    };
    return dfs(root);
  }
}`
          : `class Solution {
  maxPathSum(root) {
    const dfs = (node) => {
      if (!node) return 0;
      return dfs(node.left) + dfs(node.right) + node.val;
    };
    return dfs(root);
  }
}`,
      functionName: 'maxPathSum',
      executionStyle: 'solution-method',
      language,
      inputs: {
        root: { val: 4 },
      },
    });
    assertCondition(
      executeRecursiveUndefinedChildCallTracing.success === true,
      `${language} recursive undefined-child call tracing should succeed: ${executeRecursiveUndefinedChildCallTracing.error ?? 'unknown error'}`
    );
    const recursiveCallArgs = traceEvents(executeRecursiveUndefinedChildCallTracing)
      .filter((event) => event.kind === 'call' && event.function === 'dfs')
      .map((event) => event.args);
    assertCondition(
      recursiveCallArgs.some((args) => args?.node === '<undefined>'),
      `${language} recursive call events should preserve explicit undefined child arguments, received ${JSON.stringify(
        recursiveCallArgs
      )}`
    );
  }
  console.log('PASS: execute-with-tracing JS/TS recursive undefined-child call args contract');

  for (const language of ['javascript', 'typescript'] as const) {
    const executeDestructuringScalarAssignmentTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code: language === 'typescript'
        ? `class Solution {
  solve(a: number, b: number[][], c: number): number {
    let n: number;
    let edges: number[][];
    let src: number;
    [n, edges, src] = [a, b, c];
    return n + edges.length + src;
  }
}`
        : `class Solution {
  solve(a, b, c) {
    let n;
    let edges;
    let src;
    [n, edges, src] = [a, b, c];
    return n + edges.length + src;
  }
}`,
      functionName: 'solve',
      executionStyle: 'solution-method',
      language,
      inputs: { a: 4, b: [[0, 1, 1], [1, 2, 1]], c: 3 },
    });
    assertCondition(
      executeDestructuringScalarAssignmentTracing.success === true,
      `${language} destructuring scalar assignment tracing should succeed: ${executeDestructuringScalarAssignmentTracing.error ?? 'unknown error'}`
    );
    assertCondition(
      executeDestructuringScalarAssignmentTracing.output === 9,
      `${language} destructuring scalar assignment tracing should preserve execution semantics`
    );
    const writes = traceAccessEvents(executeDestructuringScalarAssignmentTracing).filter(
      (event) => event.line === 6 && event.kind === 'write'
    );
    for (const variable of ['n', 'edges', 'src']) {
      assertCondition(
        writes.some((event) => event.target?.variable === variable),
        `${language} destructuring assignment should emit scalar write for ${variable}, received ${JSON.stringify(writes)}`
      );
    }
  }
  console.log('PASS: execute-with-tracing JS/TS destructuring scalar assignment writes');

  const executeTypeScriptNonFiniteArrayFillTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  solve(n: number): number {
    const dist = new Array(n).fill(Infinity);
    return dist.length;
  }
}`,
    functionName: 'solve',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: { n: 3 },
  });
  assertCondition(
    executeTypeScriptNonFiniteArrayFillTracing.success === true,
    `TypeScript non-finite array fill tracing should succeed: ${executeTypeScriptNonFiniteArrayFillTracing.error ?? 'unknown error'}`
  );
  const distWrite = traceAccessEvents(executeTypeScriptNonFiniteArrayFillTracing).find(
    (event) => event.kind === 'write' && event.line === 3 && event.target?.variable === 'dist'
  );
  assertCondition(
    JSON.stringify(distWrite?.value) === JSON.stringify(['Infinity', 'Infinity', 'Infinity']),
    `TypeScript filled Infinity array write should preserve non-finite values, received ${JSON.stringify(distWrite)}`
  );
  console.log('PASS: execute-with-tracing TypeScript non-finite array fill serialization');

  for (const language of ['javascript', 'typescript'] as const) {
    const executeNestedLengthReadTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Solution {
  solve(grid: string[][]): number {
    if (!grid || grid.length === 0 || grid[0].length === 0) return 0;
    return grid[0].length;
  }
}`
          : `class Solution {
  solve(grid) {
    if (!grid || grid.length === 0 || grid[0].length === 0) return 0;
    return grid[0].length;
  }
}`,
      functionName: 'solve',
      executionStyle: 'solution-method',
      language,
      inputs: { grid: [['1', '0', '1']] },
    });
    assertCondition(
      executeNestedLengthReadTracing.success === true,
      `${language} nested length read tracing should succeed: ${executeNestedLengthReadTracing.error ?? 'unknown error'}`
    );
    const nestedLengthRead = traceAccessEvents(executeNestedLengthReadTracing).find(
      (event) =>
        event.kind === 'read' &&
        event.line === 3 &&
        event.target?.variable === 'grid' &&
        JSON.stringify(event.target.path) === JSON.stringify([0, 'length'])
    );
    assertCondition(
      nestedLengthRead?.value === 3,
      `${language} grid[0].length should emit concrete nested metadata read, received ${JSON.stringify(nestedLengthRead)}`
    );
  }
  console.log('PASS: execute-with-tracing JS/TS nested indexed metadata reads');

  const executeTypeScriptReverseListTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      line?: number;
      variables?: Record<string, unknown>;
    }>;
  }>('execute-with-tracing', {
    code: `class Solution {
  reverseList(head: ListNode | null): ListNode | null {
    let prev: ListNode | null = null;
    let curr: ListNode | null = head;
    while (curr !== null) {
      const nextTemp = curr.next;
      curr.next = prev;
      prev = curr;
      curr = nextTemp;
    }
    return prev;
  }
}`,
    functionName: 'reverseList',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: {
      head: [1, 2, 3, 4, 5],
    },
  });
  assertCondition(executeTypeScriptReverseListTracing.success === true, 'TypeScript reverse-list tracing should succeed');
  const lateListFrame = traceSnapshotEvents(executeTypeScriptReverseListTracing).find(
    (event) =>
      event.line === 9 &&
      event.target?.variable === 'prev' &&
      event.value &&
      typeof event.value === 'object' &&
      ((event.value as Record<string, unknown>).val !== undefined ||
        (event.value as Record<string, unknown>).next !== undefined)
  );
  assertCondition(
    Boolean(lateListFrame),
    'TypeScript reverse-list tracing should keep top-level linked-list variables materialized after the first iteration'
  );
  assertCondition(
    (lateListFrame?.value as { __type__?: string; __id__?: string } | undefined)?.__type__ === 'ListNode' &&
      typeof (lateListFrame?.value as { __id__?: string } | undefined)?.__id__ === 'string',
    `TypeScript reverse-list tracing should emit typed linked-list node ids, received ${JSON.stringify(lateListFrame?.value)}`
  );
  console.log('PASS: execute-with-tracing typescript reverse-list linked-list materialization contract');

  const executeTypeScriptAccessTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ accesses?: RuntimeAccessEvent[] }>;
  }>('execute-with-tracing', {
    code: `function inspect(arr: number[], matrix: number[][]): number {
  const value = arr[0];
  matrix[0][1] = value;
  arr[0]--;
  matrix[0][1]++;
  return matrix[0][1] + arr[0];
}`,
    functionName: 'inspect',
    inputs: {
      arr: [3, 5],
      matrix: [
        [0, 0],
        [0, 0],
      ],
    },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptAccessTracing.success === true, 'TypeScript tracing with access metadata should succeed');
  const flatTsAccesses = traceAccessEvents(executeTypeScriptAccessTracing);
  assertCondition(
    flatTsAccesses.some(
      (access) =>
        access.target?.variable === 'matrix' &&
        access.kind === 'write' &&
        access.target.path?.[0] === 0 &&
        access.target.path?.[1] === 1
    ),
    'TypeScript tracing should emit cell-write access events'
  );
  assertCondition(
    flatTsAccesses.some(
      (access) =>
        access.target?.variable === 'arr' &&
        access.kind === 'read' &&
        access.target.path?.[0] === 0
    ) &&
      flatTsAccesses.some(
        (access) =>
          access.target?.variable === 'arr' &&
          access.kind === 'write' &&
          access.target.path?.[0] === 0
      ),
    'TypeScript tracing should emit indexed read/write access events for compound assignments'
  );
  console.log('PASS: execute-with-tracing TypeScript access metadata');

  const executeTypeScriptSyntaxError = await harness.sendMessage<{
    success: boolean;
    error?: string;
    errorLine?: number;
  }>('execute-code', {
    code: 'function broken(a: number): number { return a + ; }',
    functionName: 'broken',
    inputs: { a: 1 },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(executeTypeScriptSyntaxError.success === false, 'TypeScript syntax errors should fail');
  assertCondition(
    typeof executeTypeScriptSyntaxError.error === 'string' &&
      executeTypeScriptSyntaxError.error.includes('TypeScript transpilation failed'),
    'TypeScript syntax errors should include transpilation failure context'
  );
  assertCondition(
    executeTypeScriptSyntaxError.errorLine === 1,
    'TypeScript transpilation errors should preserve source line mapping'
  );
  console.log('PASS: execute-code typescript transpilation error mapping');

  const tracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ event?: string; function?: string; returnValue?: unknown }>;
    executionTimeMs: number;
    lineEventCount?: number;
    traceStepCount?: number;
  }>('execute-with-tracing', {
    code: 'function square(x) { return x * x; }',
    functionName: 'square',
    inputs: { x: 7 },
    executionStyle: 'function',
  });
  assertCondition(tracing.success === true, 'Tracing execution should succeed');
  assertCondition(Array.isArray(tracing.trace?.events), 'Tracing execution should return runtime trace events');
  assertCondition(traceEvents(tracing).length >= 3, 'Tracing execution should include call/line/return steps');
  assertCondition(traceEvents(tracing)[0]?.kind === 'call', 'Tracing should start with call event');
  assertCondition(traceEvents(tracing)[1]?.kind === 'snapshot' || traceEvents(tracing).some((event) => event.kind === 'line'), 'Tracing should include line event');
  assertCondition(traceEvents(tracing).some((event) => event.kind === 'return'), 'Tracing should include return event');
  assertCondition(traceEvents(tracing)[0]?.function === 'square', 'Tracing should preserve function name');
  assertCondition(traceEvents(tracing).some((event) => event.kind === 'return' && event.value === 49), 'Tracing should include return value');
  assertCondition(tracing.lineEventCount === 1, 'Tracing should report line event count');
  assertCondition(tracing.traceStepCount === tracing.trace.traceStepCount, 'traceStepCount should match trace length');
  assertCondition(typeof tracing.executionTimeMs === 'number', 'Tracing execution should include timing');
  console.log('PASS: execute-with-tracing contract');

  const cappedTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    traceLimitExceeded?: boolean;
    timeoutReason?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function sumTo(n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += i;
  }
  return total;
}`,
    functionName: 'sumTo',
    inputs: { n: 200 },
    executionStyle: 'function',
    options: { maxTraceSteps: 5, maxStoredEvents: 20, maxLineEvents: 1000, maxSingleLineHits: 1000 },
  });
  assertCondition(cappedTracing.success === true, 'Trace capture limit should not fail JavaScript execution');
  assertCondition(cappedTracing.output === 19900, 'Trace capture limit should preserve JavaScript output');
  assertCondition(cappedTracing.traceLimitExceeded === true, 'Trace capture limit should set traceLimitExceeded');
  assertCondition(cappedTracing.timeoutReason === 'trace-limit', 'Trace capture limit should use trace-limit reason');
  assertCondition(
    traceEvents(cappedTracing).length <= 20,
    'Trace capture limit should bound returned JavaScript runtime events'
  );
  console.log('PASS: execute-with-tracing JavaScript trace capture limit preserves output');

  const loopTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    trace: Array<{ event?: string; line?: number }>;
    lineEventCount?: number;
  }>('execute-with-tracing', {
    code: `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen.has(complement)) return [seen.get(complement), i];
    seen.set(nums[i], i);
  }
  return [];
}`,
    functionName: 'twoSum',
    inputs: { nums: [2, 7, 11, 15], target: 9 },
    executionStyle: 'function',
  });
  assertCondition(loopTracing.success === true, 'Loop tracing should succeed');
  assertCondition(Array.isArray(loopTracing.trace?.events), 'Loop tracing should return runtime trace events');
  assertCondition(traceEvents(loopTracing).length > 3, 'Loop tracing should include more than synthetic 3 steps');
  assertCondition((loopTracing.lineEventCount ?? 0) > 1, 'Loop tracing should include multiple line events');
  assertCondition(loopTracing.output !== undefined, 'Loop tracing should include output');
  console.log('PASS: execute-with-tracing multi-step loop contract');

  const asyncConditionTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `async function solve(flags) {
  let i = 0;
  let total = 0;
  async function nextFlag() {
    return flags[i++] ?? false;
  }
  while (await nextFlag()) {
    total += i;
  }
  return total;
}`,
    functionName: 'solve',
    inputs: { flags: [true, true, false] },
    executionStyle: 'function',
  });
  assertCondition(
    asyncConditionTracing.success === true,
    `JavaScript tracing should preserve await in loop conditions: ${asyncConditionTracing.error ?? 'unknown error'}`
  );
  assertCondition(asyncConditionTracing.output === 3, 'JavaScript tracing should preserve async condition output');

  const generatorConditionTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `function solve() {
  function* counter() {
    let count = 0;
    while (yield count < 2) {
      count++;
    }
    return count;
  }
  const iterator = counter();
  const first = iterator.next();
  const second = iterator.next(true);
  const third = iterator.next(true);
  const done = iterator.next(false);
  return [first.value, second.value, third.value, done.value, done.done];
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(
    generatorConditionTracing.success === true,
    `JavaScript tracing should preserve yield in loop conditions: ${generatorConditionTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(generatorConditionTracing.output) === JSON.stringify([true, true, false, 2, true]),
    `JavaScript tracing should preserve generator condition output, got ${JSON.stringify(generatorConditionTracing.output)}`
  );

  const typeScriptNullPropertyTracing = await harness.sendMessage<{
    success: boolean;
    error?: string;
  }>('execute-with-tracing', {
    code: `function solve(): number {
  const box: { next?: { value: number } } | null = null;
  return box.next.value;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(typeScriptNullPropertyTracing.success === false, 'TypeScript null property tracing should fail');
  assertCondition(
    String(typeScriptNullPropertyTracing.error ?? '').includes("Cannot read properties of null"),
    `TypeScript null property tracing should preserve native null-property error, got ${JSON.stringify(typeScriptNullPropertyTracing)}`
  );

  const typeScriptAsyncConditionTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `async function solve(flags: boolean[]): Promise<number> {
  let i = 0;
  let total = 0;
  async function nextFlag(): Promise<boolean> {
    return flags[i++] ?? false;
  }
  while (await nextFlag()) {
    total += i;
  }
  return total;
}`,
    functionName: 'solve',
    inputs: { flags: [true, true, false] },
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(
    typeScriptAsyncConditionTracing.success === true,
    `TypeScript tracing should preserve await in loop conditions: ${typeScriptAsyncConditionTracing.error ?? 'unknown error'}`
  );
  assertCondition(typeScriptAsyncConditionTracing.output === 3, 'TypeScript tracing should preserve async condition output');
  console.log('PASS: execute-with-tracing JS async/generator condition contract');

  const tracingAccesses = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ accesses?: RuntimeAccessEvent[] }>;
  }>('execute-with-tracing', {
    code: `function inspect(arr, matrix) {
  const x = arr[1];
  arr[1]++;
  matrix[1][0] = x;
  matrix[1][0]--;
  const queue = [];
  queue.push(x);
  queue.pop();
  return matrix[1][0] + arr[1];
}`,
    functionName: 'inspect',
    inputs: {
      arr: [4, 7, 9],
      matrix: [
        [0, 0],
        [0, 0],
      ],
    },
    executionStyle: 'function',
  });
  assertCondition(tracingAccesses.success === true, 'JavaScript tracing with access metadata should succeed');
  const flatAccesses = traceAccessEvents(tracingAccesses);
  assertCondition(
    flatAccesses.some(
      (access) =>
        access.target?.variable === 'arr' &&
        access.kind === 'read' &&
        access.target.path?.[0] === 1
    ),
    'JavaScript tracing should emit indexed-read access events'
  );
  assertCondition(
    flatAccesses.some(
      (access) =>
        access.target?.variable === 'arr' &&
        access.kind === 'write' &&
        access.target.path?.[0] === 1
    ),
    'JavaScript tracing should emit indexed-write access events for compound assignments'
  );
  assertCondition(
    flatAccesses.some(
      (access) =>
        access.target?.variable === 'matrix' &&
        access.kind === 'write' &&
        access.target.path?.[0] === 1 &&
        access.target.path?.[1] === 0
    ),
    'JavaScript tracing should emit cell-write access events for nested element assignments'
  );
  const indexSourceTracing = await harness.sendMessage<{
    success: boolean;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function inspect(nums, grid) {
  let i = 1;
  let row = 0;
  let col = 1;
  nums[i] = grid[row][col];
  return nums[i];
}`,
    functionName: 'inspect',
    inputs: { nums: [0, 0, 0], grid: [[4, 5], [6, 7]] },
    executionStyle: 'function',
  });
  assertCondition(indexSourceTracing.success === true, 'JavaScript index-source tracing should succeed');
  const indexSourceAccesses = traceAccessEvents(indexSourceTracing);
  assertCondition(
    indexSourceAccesses.some(
      (access) =>
        access.target?.variable === 'grid' &&
        access.kind === 'read' &&
        JSON.stringify(access.target.indexSources) === JSON.stringify(['row', 'col'])
    ),
    `JavaScript tracing should emit indexSources for grid[row][col], received ${JSON.stringify(indexSourceAccesses)}`
  );
  assertCondition(
    indexSourceAccesses.some(
      (access) =>
        access.target?.variable === 'nums' &&
        access.kind === 'write' &&
        JSON.stringify(access.target.indexSources) === JSON.stringify(['i'])
    ),
    `JavaScript tracing should emit indexSources for nums[i] write, received ${JSON.stringify(indexSourceAccesses)}`
  );
  const charComputedIndexTracing = await harness.sendMessage<{
    success: boolean;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve(text) {
  const counts = Array(26).fill(0);
  const base = 'a'.charCodeAt(0);
  for (let i = 0; i < text.length; i++) {
    counts[text.charCodeAt(i) - base] += 1;
  }
  return counts[0];
}`,
    functionName: 'solve',
    inputs: { text: 'ab' },
    executionStyle: 'function',
  });
  assertCondition(charComputedIndexTracing.success === true, 'JavaScript char-computed index tracing should succeed');
  const charComputedIndexAccesses = traceAccessEvents(charComputedIndexTracing);
  assertCondition(
    charComputedIndexAccesses.some(
      (access) =>
        access.target?.variable === 'counts' &&
        access.kind === 'read' &&
        JSON.stringify(access.target.indexSources) === JSON.stringify(['text.charCodeAt(i) - base'])
    ) &&
      charComputedIndexAccesses.some(
        (access) =>
          access.target?.variable === 'counts' &&
          access.kind === 'write' &&
          JSON.stringify(access.target.indexSources) === JSON.stringify(['text.charCodeAt(i) - base'])
      ),
    `JavaScript tracing should emit indexSources for charCodeAt-derived computed indices, received ${JSON.stringify(charComputedIndexAccesses)}`
  );

  for (const language of ['javascript', 'typescript'] as const) {
    const popIndexSourceTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Solution {
  solve(bars: number[]): number {
    const stack: number[] = [1];
    return bars[stack.pop()!];
  }
}`
          : `class Solution {
  solve(bars) {
    const stack = [1];
    return bars[stack.pop()];
  }
}`,
      functionName: 'solve',
      inputs: { bars: [4, 9, 16] },
      executionStyle: 'solution-method',
      language,
    });
    assertCondition(
      popIndexSourceTracing.success === true,
      `${language} stack.pop index-source tracing should succeed: ${popIndexSourceTracing.error ?? 'unknown error'}`
    );
    assertCondition(popIndexSourceTracing.output === 9, `${language} stack.pop index-source tracing should preserve output`);
    const popIndexSourceAccesses = traceAccessEvents(popIndexSourceTracing);
    const expectedPopSource = language === 'typescript' ? 'stack.pop()!' : 'stack.pop()';
    assertCondition(
      popIndexSourceAccesses.some(
        (access) =>
          access.target?.variable === 'bars' &&
          access.kind === 'read' &&
          JSON.stringify(access.target.indexSources) === JSON.stringify([expectedPopSource])
      ),
      `${language} tracing should preserve stack.pop() index provenance, received ${JSON.stringify(popIndexSourceAccesses)}`
    );
  }

  for (const language of ['javascript', 'typescript'] as const) {
    const membershipTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Solution {
  solve(word: string): boolean {
    const node = { children: { a: 1 } as Record<string, number> };
    const char = word[0];
    return char in node.children;
  }
}`
          : `class Solution {
  solve(word) {
    const node = { children: { a: 1 } };
    const char = word[0];
    return char in node.children;
  }
}`,
      functionName: 'solve',
      inputs: { word: 'apple' },
      executionStyle: 'solution-method',
      language,
    });
    assertCondition(
      membershipTracing.success === true,
      `${language} object membership tracing should succeed: ${membershipTracing.error ?? 'unknown error'}`
    );
    assertCondition(membershipTracing.output === true, `${language} object membership tracing should preserve output`);
    const membershipAccesses = traceAccessEvents(membershipTracing);
    assertCondition(
      membershipAccesses.some(
        (access) =>
          access.target?.variable === 'node' &&
          access.kind === 'read' &&
          JSON.stringify(access.target.path) === JSON.stringify(['children', 'a']) &&
          JSON.stringify(access.target.indexSources) === JSON.stringify([null, 'char'])
      ),
      `${language} tracing should emit concrete key/source for char in node.children, received ${JSON.stringify(membershipAccesses)}`
    );
  }

  for (const language of ['javascript', 'typescript'] as const) {
    const setHasTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Solution {
  solve(n: number): boolean {
    const cols = new Set<number>([1]);
    const diag1 = new Set<number>([99]);
    const diag2 = new Set<number>([88]);
    const row = 1;
    const col = 2;
    return !cols.has(col) && !diag1.has(row - col) && !diag2.has(row + col);
  }
}`
          : `class Solution {
  solve(n) {
    const cols = new Set([1]);
    const diag1 = new Set([99]);
    const diag2 = new Set([88]);
    const row = 1;
    const col = 2;
    return !cols.has(col) && !diag1.has(row - col) && !diag2.has(row + col);
  }
}`,
      functionName: 'solve',
      inputs: { n: 4 },
      executionStyle: 'solution-method',
      language,
    });
    assertCondition(
      setHasTracing.success === true,
      `${language} Set.has tracing should succeed: ${setHasTracing.error ?? 'unknown error'}`
    );
    assertCondition(setHasTracing.output === true, `${language} Set.has tracing should preserve output`);
    const setHasAccesses = traceAccessEvents(setHasTracing);
    assertCondition(
      setHasAccesses.some(
        (access) =>
          access.target?.variable === 'cols' &&
          access.kind === 'read' &&
          JSON.stringify(access.target.path) === JSON.stringify([2]) &&
          JSON.stringify(access.target.indexSources) === JSON.stringify(['col'])
      ) &&
        setHasAccesses.some(
          (access) =>
            access.target?.variable === 'diag1' &&
            access.kind === 'read' &&
            JSON.stringify(access.target.path) === JSON.stringify([-1]) &&
            JSON.stringify(access.target.indexSources) === JSON.stringify(['row - col'])
        ) &&
        setHasAccesses.some(
          (access) =>
            access.target?.variable === 'diag2' &&
            access.kind === 'read' &&
            JSON.stringify(access.target.path) === JSON.stringify([3]) &&
            JSON.stringify(access.target.indexSources) === JSON.stringify(['row + col'])
        ),
      `${language} tracing should emit key/source provenance for Set.has reads, received ${JSON.stringify(setHasAccesses)}`
    );
  }

  for (const language of ['javascript', 'typescript'] as const) {
    const destructuredIndexedSwapTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Solution {
  solve(nums: number[]): number[] {
    const heap = nums.slice();
    let parent = 0;
    let i = 1;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    return heap;
  }
}`
          : `class Solution {
  solve(nums) {
    const heap = nums.slice();
    let parent = 0;
    let i = 1;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    return heap;
  }
}`,
      functionName: 'solve',
      inputs: { nums: [3, 1] },
      executionStyle: 'solution-method',
      language,
    });
    assertCondition(
      destructuredIndexedSwapTracing.success === true,
      `${language} destructuring indexed swap tracing should succeed: ${destructuredIndexedSwapTracing.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(destructuredIndexedSwapTracing.output) === JSON.stringify([1, 3]),
      `${language} destructuring indexed swap tracing should preserve output`
    );
    const destructuredIndexedSwapWrites = traceAccessEvents(destructuredIndexedSwapTracing).filter(
      (event) => event.target?.variable === 'heap' && event.kind === 'write'
    );
    assertCondition(
      destructuredIndexedSwapWrites.some(
        (event) =>
          JSON.stringify(event.target?.path) === JSON.stringify([0]) &&
          JSON.stringify(event.target?.indexSources) === JSON.stringify(['parent'])
      ) &&
        destructuredIndexedSwapWrites.some(
          (event) =>
            JSON.stringify(event.target?.path) === JSON.stringify([1]) &&
            JSON.stringify(event.target?.indexSources) === JSON.stringify(['i'])
        ),
      `${language} destructuring indexed swap should emit writes for both targets, received ${JSON.stringify(destructuredIndexedSwapWrites)}`
    );
  }

  const destructuringSideEffectTargetTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const arr = [0, 0];
  let i = 0;
  [arr[i++]] = [7];
  return { arr, i };
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    destructuringSideEffectTargetTracing.success === true,
    `JavaScript side-effecting destructuring target tracing should succeed: ${destructuringSideEffectTargetTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(destructuringSideEffectTargetTracing.output) === JSON.stringify({ arr: [7, 0], i: 1 }),
    `JavaScript side-effecting destructuring target should execute once, got ${JSON.stringify(destructuringSideEffectTargetTracing.output)}`
  );
  assertCondition(
    !traceAccessEvents(destructuringSideEffectTargetTracing).some(
      (event) =>
        event.kind === 'write' &&
        event.target?.variable === 'arr' &&
        JSON.stringify(event.target.path) === JSON.stringify([1])
    ),
    `JavaScript side-effecting destructuring target should not trace a replayed arr[1] write, received ${JSON.stringify(
      destructuringSideEffectTargetTracing.trace?.events
    )}`
  );

  const typeScriptDestructuringSideEffectTargetTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve(): { arr: number[]; i: number } {
  const arr = [0, 0];
  let i = 0;
  [arr[i++]] = [7];
  return { arr, i };
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(
    typeScriptDestructuringSideEffectTargetTracing.success === true,
    `TypeScript side-effecting destructuring target tracing should succeed: ${typeScriptDestructuringSideEffectTargetTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(typeScriptDestructuringSideEffectTargetTracing.output) === JSON.stringify({ arr: [7, 0], i: 1 }),
    `TypeScript side-effecting destructuring target should execute once, got ${JSON.stringify(typeScriptDestructuringSideEffectTargetTracing.output)}`
  );
  assertCondition(
    !traceAccessEvents(typeScriptDestructuringSideEffectTargetTracing).some(
      (event) =>
        event.kind === 'write' &&
        event.target?.variable === 'arr' &&
        JSON.stringify(event.target.path) === JSON.stringify([1])
    ),
    `TypeScript side-effecting destructuring target should not trace a replayed arr[1] write, received ${JSON.stringify(
      typeScriptDestructuringSideEffectTargetTracing.trace?.events
    )}`
  );

  const symbolKeyMutationTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const graph = {};
  const key = Symbol("node");
  graph[key] = [];
  graph[key].push(1);
  return graph[key].length;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    symbolKeyMutationTracing.success === true,
    `JavaScript Symbol-key nested mutation tracing should succeed: ${symbolKeyMutationTracing.error ?? 'unknown error'}`
  );
  assertCondition(symbolKeyMutationTracing.output === 1, 'JavaScript Symbol-key nested mutation should preserve output');
  assertCondition(
    !traceAccessEvents(symbolKeyMutationTracing).some(
      (event) =>
        event.line === 5 &&
        event.target?.variable === 'graph' &&
        (event.kind === 'read' || event.kind === 'mutate') &&
        !Array.isArray(event.target.path)
    ),
    `JavaScript untraceable Symbol-key mutation should not emit root graph accesses, received ${JSON.stringify(
      symbolKeyMutationTracing.trace?.events
    )}`
  );
  console.log('PASS: execute-with-tracing JS destructuring target replay guard');

  const typeScriptPrivateFieldTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class Solution {
  #graph = new Map<number, number[]>();
  solve(value: number): number {
    this.#graph.set(value, [value]);
    return this.#graph.get(value)![0];
  }
}`,
    functionName: 'solve',
    inputs: { value: 5 },
    executionStyle: 'solution-method',
    language: 'typescript',
  });
  assertCondition(
    typeScriptPrivateFieldTracing.success === true,
    `TypeScript private field tracing should succeed: ${typeScriptPrivateFieldTracing.error ?? 'unknown error'}`
  );
  assertCondition(typeScriptPrivateFieldTracing.output === 5, 'TypeScript private field tracing should preserve output');
  assertCondition(
    !traceAccessEvents(typeScriptPrivateFieldTracing).some(
      (event) =>
        event.target?.variable === 'this' &&
        Array.isArray(event.target.path) &&
        event.target.path.some((part) => String(part).includes('graph'))
    ),
    `TypeScript private field tracing should not emit bogus this.graph/#graph accesses, received ${JSON.stringify(typeScriptPrivateFieldTracing.trace?.events)}`
  );

  for (const language of ['javascript', 'typescript'] as const) {
    const spliceTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): number[][] {
  const front = [1, 2, 3];
  const middle = [4, 5, 6];
  const tail = [7, 8, 9];
  front.splice(0, 1);
  middle.splice(1, 1);
  tail.splice(-1, 1);
  return [front, middle, tail];
}`
          : `function solve() {
  const front = [1, 2, 3];
  const middle = [4, 5, 6];
  const tail = [7, 8, 9];
  front.splice(0, 1);
  middle.splice(1, 1);
  tail.splice(-1, 1);
  return [front, middle, tail];
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      spliceTracing.success === true,
      `${language} splice normalization tracing should succeed: ${spliceTracing.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(spliceTracing.output) === JSON.stringify([[2, 3], [4, 6], [7, 8]]),
      `${language} splice normalization should preserve output, received ${JSON.stringify(spliceTracing.output)}`
    );
    const spliceMutations = traceAccessEvents(spliceTracing).filter(
      (event) =>
        event.kind === 'mutate' &&
        (event.target?.variable === 'front' || event.target?.variable === 'middle' || event.target?.variable === 'tail')
    );
    assertCondition(
      spliceMutations.length >= 3 && spliceMutations.every((event) => event.method === 'splice'),
      `${language} splice mutations should remain method=splice, received ${JSON.stringify(spliceMutations)}`
    );
  }

  for (const language of ['javascript', 'typescript'] as const) {
    const functionValueReadTracing = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `function solve(): number {
  const obj = { fn(): number { return 2; } };
  const picked = obj.fn;
  return picked();
}`
          : `function solve() {
  const obj = { fn() { return 2; } };
  const picked = obj.fn;
  return picked();
}`,
      functionName: 'solve',
      inputs: {},
      executionStyle: 'function',
      language,
    });
    assertCondition(
      functionValueReadTracing.success === true,
      `${language} function-valued property tracing should succeed: ${functionValueReadTracing.error ?? 'unknown error'}`
    );
    assertCondition(functionValueReadTracing.output === 2, `${language} function-valued property tracing should preserve output`);
    const functionValueRead = traceAccessEvents(functionValueReadTracing).find(
      (event) =>
        event.kind === 'read' &&
        event.target?.variable === 'obj' &&
        JSON.stringify(event.target.path) === JSON.stringify(['fn'])
    );
    assertCondition(
      functionValueRead?.value === '<function>',
      `${language} function-valued property reads should emit clone-safe values, received ${JSON.stringify(functionValueRead)}`
    );
  }
  console.log('PASS: execute-with-tracing JS/TS splice and clone-safe function-value regressions');

  const nestedWriteEvaluationOrderTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `function solve() {
  const original = { c: 0 };
  const obj = { a: { b: original } };
  obj.a.b.c = (obj.a.b = {}, 1);
  return [original.c, Object.prototype.hasOwnProperty.call(obj.a.b, "c")];
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    nestedWriteEvaluationOrderTracing.success === true,
    `JavaScript nested write evaluation-order tracing should succeed: ${nestedWriteEvaluationOrderTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(nestedWriteEvaluationOrderTracing.output) === JSON.stringify([1, false]),
    `JavaScript nested write tracing should preserve native LHS/RHS evaluation order, got ${JSON.stringify(
      nestedWriteEvaluationOrderTracing.output
    )}`
  );
  console.log('PASS: execute-with-tracing JS nested write evaluation order');

  const tuplePushArgsTracing = await harness.sendMessage<{
    success: boolean;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `function solve() {
  const edges = [];
  const u = 1;
  const v = 2;
  const w = 3;
  edges.push([u, v, w]);
  return edges.length;
}`,
    functionName: 'solve',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(tuplePushArgsTracing.success === true, 'JavaScript tuple push args tracing should succeed');
  const tuplePushMutate = traceAccessEvents(tuplePushArgsTracing).find(
    (event) => event.target?.variable === 'edges' && event.kind === 'mutate' && event.method === 'push'
  );
  assertCondition(
    Boolean(tuplePushMutate) && JSON.stringify(tuplePushMutate?.args) === JSON.stringify([[1, 2, 3]]),
    `JavaScript edges.push([u,v,w]) should preserve the single tuple argument contract, received ${JSON.stringify(tuplePushMutate)}`
  );

  assertCondition(
    flatAccesses.some(
      (access) =>
        access.target?.variable === 'queue' &&
        access.kind === 'mutate' &&
        access.method === 'push'
    ) &&
      flatAccesses.some(
        (access) =>
          access.target?.variable === 'queue' &&
          access.kind === 'mutate' &&
          access.method === 'pop'
      ),
    'JavaScript tracing should emit mutating-call access events for worklists'
  );
  console.log('PASS: execute-with-tracing JavaScript access metadata');

  const scriptTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      event?: string;
      line?: number;
      function?: string;
      variables?: Record<string, unknown>;
      callStack?: Array<{ function?: string; args?: Record<string, unknown> }>;
    }>;
  }>('execute-with-tracing', {
    code: `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen.has(complement)) return [seen.get(complement), i];
    seen.set(nums[i], i);
  }
  return [];
}

result = twoSum([2, 7, 11, 15], 9);`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(scriptTracing.success === true, 'Script tracing should succeed');
  assertCondition(traceEvents(scriptTracing).length > 3, 'Script tracing should include multiple executable steps');
  assertCondition(
    traceEvents(scriptTracing).some((event) => event.function === '<module>'),
    'Script tracing should include <module> function events'
  );
  assertCondition(
    traceEvents(scriptTracing).some((event) => event.function === 'twoSum'),
    'Script tracing should include named function events'
  );
  const scriptEvents = traceEvents(scriptTracing);
  const twoSumCallStep = scriptEvents.find(
    (event) => event.kind === 'call' && event.function === 'twoSum'
  );
  assertCondition(
    twoSumCallStep?.line === 1,
    'Script tracing should place twoSum call on function declaration line'
  );
  const twoSumCallArgs = (twoSumCallStep as RuntimeTraceEvent & { args?: Record<string, unknown> } | undefined)?.args;
  assertCondition(
    Boolean(twoSumCallArgs && Object.prototype.hasOwnProperty.call(twoSumCallArgs, 'nums')),
    'Script tracing should include twoSum call argument "nums"'
  );
  assertCondition(
    Boolean(twoSumCallArgs && Object.prototype.hasOwnProperty.call(twoSumCallArgs, 'target')),
    'Script tracing should include twoSum call argument "target"'
  );
  assertCondition(
    scriptEvents.some((event) => event.kind === 'call' && event.function === 'twoSum'),
    'Script tracing should capture nested function calls'
  );
  const twoSumReturnStepIndex = scriptEvents.findIndex(
    (event) => event.kind === 'return' && event.function === 'twoSum'
  );
  assertCondition(
    twoSumReturnStepIndex >= 0,
    'Script tracing should emit a return event for twoSum'
  );
  const resultAssignmentStepIndex = scriptEvents.findIndex((event) =>
    event.kind === 'snapshot' &&
    event.target?.variable === 'result' &&
    Array.isArray(event.value) &&
    event.value[0] === 0 &&
    event.value[1] === 1
  );
  assertCondition(
    resultAssignmentStepIndex > twoSumReturnStepIndex,
    'Script tracing should populate result after twoSum return event'
  );
  assertCondition(
    traceSnapshotEvents(scriptTracing).some((event) => event.target?.variable === 'result'),
    'Script tracing return step should include result variable'
  );
  console.log('PASS: execute-with-tracing script mode contract');

  const scriptTracingNoResultAfterAssignment = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: 'const untouched = 1;',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(
    scriptTracingNoResultAfterAssignment.success === true,
    `Script tracing without result should succeed after prior result assignment: ${scriptTracingNoResultAfterAssignment.error ?? 'unknown error'}`
  );
  assertCondition(scriptTracingNoResultAfterAssignment.output === null, 'Script tracing should not reuse a previous script result');

  const scriptConstResultTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
    trace: Array<{
      event?: string;
      function?: string;
      variables?: Record<string, unknown>;
    }>;
  }>('execute-with-tracing', {
    code: `function sum(nums) {
  let total = 0;
  for (const value of nums) total += value;
  return total;
}

const result = sum([2, 1, 5, 1, 3, 2]);`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(
    scriptConstResultTracing.success === true,
    `Script tracing should allow user-declared const result, received ${scriptConstResultTracing.error ?? 'unknown error'}`
  );
  assertCondition(scriptConstResultTracing.output === 14, 'Script tracing const result output should equal 14');
  assertCondition(
    traceEvents(scriptConstResultTracing).some((event) => event.function === '<module>'),
    'Script const result tracing should include module events'
  );
  console.log('PASS: execute-with-tracing script mode const result declaration');

  const scriptStdinTracing = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-with-tracing', {
    code: `const fs = require("fs");
const input = fs.readFileSync(0, "utf8").trim();
const nums = input.length === 0 ? [] : input.split(/\\s+/).map(Number);
console.log(nums.reduce((sum, value) => sum + value, 0));`,
    inputs: { stdin: '4 5 -2 10\n' },
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    scriptStdinTracing.success === true,
    `Script stdin tracing should support fs.readFileSync(0): ${scriptStdinTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    scriptStdinTracing.output === '17\n',
    `Script stdin tracing output should mirror stdout text, received ${JSON.stringify(scriptStdinTracing.output)}`
  );

  const recursiveTreeTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      event?: string;
      function?: string;
      callStack?: Array<{ function?: string; args?: Record<string, unknown> }>;
    }>;
  }>('execute-with-tracing', {
    code: `function sumLeftBranch(root) {
  function dfs(node) {
    if (!node) return 0;
    return node.val + dfs(node.left);
  }
  return dfs(root);
}`,
    functionName: 'sumLeftBranch',
    inputs: {
      root: {
        val: 5,
        left: {
          val: 4,
          left: { val: 3, left: null, right: null },
          right: null,
        },
        right: { val: 8, left: null, right: null },
      },
    },
    executionStyle: 'function',
  });
  assertCondition(recursiveTreeTracing.success === true, 'Recursive tree tracing should succeed');
  const recursiveTreeCall = traceEvents(recursiveTreeTracing).find((event) => {
    const args = (event as RuntimeTraceEvent & { args?: Record<string, unknown> }).args ?? {};
    return event.kind === 'call' && event.function === 'dfs' && args.node && typeof args.node === 'object';
  });
  const recursiveTopNode = (recursiveTreeCall as RuntimeTraceEvent & { args?: Record<string, unknown> } | undefined)
    ?.args?.node as Record<string, unknown> | undefined;
  assertCondition(Boolean(recursiveTreeCall), 'Recursive tree tracing should capture nested dfs calls');
  assertCondition(
    Boolean(
      recursiveTopNode &&
        typeof recursiveTopNode.val !== 'undefined' &&
        ('left' in recursiveTopNode || 'right' in recursiveTopNode)
    ),
    'Recursive tree call args should keep nested tree inputs materialized'
  );
  console.log('PASS: execute-with-tracing recursive tree identity contract');

  const collectionTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
    }>;
  }>('execute-with-tracing', {
    code: `function capture() {
  const seen = new Map([[2, 0], [7, 1]]);
  const visited = new Set([2, 7]);
  return seen.size + visited.size;
}`,
    functionName: 'capture',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(collectionTracing.success === true, 'Collection tracing should succeed');
  const hasMapSnapshot = traceSnapshotEvents(collectionTracing).some(
    (event) => event.target?.variable === 'seen' && (event.value as Record<string, unknown> | undefined)?.__type__ === 'map'
  );
  const hasSetSnapshot = traceSnapshotEvents(collectionTracing).some(
    (event) => event.target?.variable === 'visited' && (event.value as Record<string, unknown> | undefined)?.__type__ === 'set'
  );
  assertCondition(hasMapSnapshot, 'Tracing should emit neutral runtime trace snapshots for Map locals');
  assertCondition(hasSetSnapshot, 'Tracing should emit neutral runtime trace snapshots for Set locals');
  console.log('PASS: execute-with-tracing collection snapshot payload contract');

  const objectHashTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
    }>;
  }>('execute-with-tracing', {
    code: `function captureObjectHash(nums, target) {
  const seen = {};
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen[complement] !== undefined) return [seen[complement], i];
    seen[nums[i]] = i;
  }
  return [];
}`,
    functionName: 'captureObjectHash',
    inputs: { nums: [2, 7, 11, 15], target: 9 },
    executionStyle: 'function',
  });
  assertCondition(objectHashTracing.success === true, 'Object-hash tracing should succeed');
  const hasObjectHashSnapshot = traceSnapshotEvents(objectHashTracing).some(
    (event) =>
      event.target?.variable === 'seen' &&
      event.value &&
      typeof event.value === 'object' &&
      Object.keys(event.value as Record<string, unknown>).length > 0
  );
  assertCondition(
    hasObjectHashSnapshot,
    'Tracing should emit neutral runtime trace snapshots for plain object hash locals'
  );
  console.log('PASS: execute-with-tracing object-hash snapshot payload contract');

  const typeScriptTrieObjectTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
      variables?: Record<string, unknown>;
    }>;
  }>('execute-with-tracing', {
    code: `class TrieNode {
  children: Map<string, TrieNode>;
  isEnd: boolean;

  constructor() {
    this.children = new Map();
    this.isEnd = false;
  }
}

class Trie {
  private root: TrieNode;

  constructor(...args: unknown[]) {
    this.root = new TrieNode();
  }

  insert(...args: unknown[]): unknown {
    const word = args[0] as string;
    let node = this.root;

    for (const char of word) {
      if (!node.children.has(char)) {
        node.children.set(char, new TrieNode());
      }
      node = node.children.get(char)!;
    }

    node.isEnd = true;
    return undefined;
  }
}`,
    functionName: 'Trie',
    executionStyle: 'ops-class',
    language: 'typescript',
    inputs: {
      operations: ['Trie', 'insert'],
      arguments: [[], ['apple']],
    },
  });
  assertCondition(typeScriptTrieObjectTracing.success === true, 'TypeScript trie object tracing should succeed');
  const trieNodeSnapshot = traceSnapshotEvents(typeScriptTrieObjectTracing).find(
    (event) =>
      event.target?.variable === 'node' &&
      (event.value as Record<string, unknown> | undefined)?.__class__ === 'TrieNode'
  );
  assertCondition(
    Boolean(trieNodeSnapshot),
    'Tracing should emit neutral runtime trace snapshots for ref-followed TrieNode locals'
  );
  const trieNodeValue = trieNodeSnapshot?.value as Record<string, unknown> | undefined;
  const childrenEntry = trieNodeValue?.children;
  assertCondition(
    Boolean(childrenEntry) &&
      typeof childrenEntry === 'object' &&
      childrenEntry !== null &&
      (childrenEntry as { __type__?: unknown }).__type__ === 'map',
    'TrieNode snapshot should preserve map-backed children fields'
  );
  const trieAliasFrame = traceSnapshotFrames(typeScriptTrieObjectTracing).find((frame) => {
    const receiver = frame.snapshots.this as { root?: { __id__?: unknown; __ref__?: unknown } } | undefined;
    const receiverRoot = frame.snapshots['this.root'] as { __id__?: unknown; __ref__?: unknown } | undefined;
    const node = frame.snapshots.node as { __id__?: unknown } | undefined;
    const rootId = receiverRoot?.__id__ ?? receiverRoot?.__ref__ ?? receiver?.root?.__id__ ?? receiver?.root?.__ref__;
    return (
      typeof rootId === 'string' &&
      typeof node?.__id__ === 'string' &&
      rootId === node.__id__
    );
  });
  assertCondition(
    Boolean(trieAliasFrame),
    'Trie tracing should preserve object identity when a local aliases this.root'
  );
  const typeScriptTrieChildWrite = traceAccessEvents(typeScriptTrieObjectTracing).find((event) =>
    event.kind === 'write' &&
    event.target?.variable === 'node' &&
    JSON.stringify(event.target.path) === JSON.stringify(['children', 'a'])
  );
  const typeScriptTrieChildMutate = traceAccessEvents(typeScriptTrieObjectTracing).find((event) =>
    event.kind === 'mutate' &&
    event.target?.variable === 'node' &&
    event.method === 'set' &&
    JSON.stringify(event.target.path) === JSON.stringify(['children', 'a'])
  );
  const typeScriptTrieChildRead = traceAccessEvents(typeScriptTrieObjectTracing).find((event) =>
    event.kind === 'read' &&
    event.target?.variable === 'node' &&
    JSON.stringify(event.target.path) === JSON.stringify(['children', 'a']) &&
    Boolean(runtimeRefId(event.value))
  );
  const typeScriptTrieWriteId = runtimeRefId(typeScriptTrieChildWrite?.value);
  const typeScriptTrieMutateArgs = Array.isArray(typeScriptTrieChildMutate?.args)
    ? typeScriptTrieChildMutate.args
    : [];
  const typeScriptTrieMutateId = runtimeRefId(typeScriptTrieMutateArgs[1]);
  const typeScriptTrieReadId = runtimeRefId(typeScriptTrieChildRead?.value);
  assertCondition(
    Boolean(typeScriptTrieWriteId) &&
      typeScriptTrieWriteId === typeScriptTrieMutateId &&
      typeScriptTrieWriteId === typeScriptTrieReadId,
    `TypeScript Map-backed trie child refs should agree across write/mutate/read, received ${JSON.stringify({
      write: typeScriptTrieChildWrite,
      mutate: typeScriptTrieChildMutate,
      read: typeScriptTrieChildRead,
    })}`
  );
  const javascriptTriePlainObjectAliasTracing = await harness.sendMessage<{
    success: boolean;
    trace: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class TrieNode {
  constructor() {
    this.children = {};
    this.index = -1;
  }
}

class WordFilter {
  constructor(words) {
    this.root = new TrieNode();
    const word = words[0];
    const key = word + '#' + word;
    let node = this.root;
    if (!('a' in node.children)) {
      node.children['a'] = new TrieNode();
    }
    return undefined;
  }
}`,
    functionName: 'WordFilter',
    executionStyle: 'ops-class',
    language: 'javascript',
    inputs: {
      operations: ['WordFilter'],
      arguments: [[['apple']]],
    },
  });
  assertCondition(
    javascriptTriePlainObjectAliasTracing.success === true,
    'JavaScript trie plain-object alias tracing should succeed'
  );
  const javascriptTrieAliasNodeIdsByLine = new Map<number, string>();
  const javascriptTrieAliasRootIdsByLine = new Map<number, string>();
  for (const event of traceEvents(javascriptTriePlainObjectAliasTracing)) {
    if (event.kind === 'snapshot' && event.target?.variable === 'node') {
      const node = event.value as { __id__?: unknown } | undefined;
      if (typeof event.line === 'number' && typeof node?.__id__ === 'string') {
        javascriptTrieAliasNodeIdsByLine.set(event.line, node.__id__);
      }
    }
    if (
      event.kind === 'read' &&
      event.target?.variable === 'this' &&
      JSON.stringify(event.target.path) === JSON.stringify(['root'])
    ) {
      const root = event.value as { __id__?: unknown; __ref__?: unknown } | undefined;
      const rootId = root?.__id__ ?? root?.__ref__;
      if (typeof event.line === 'number' && typeof rootId === 'string') {
        javascriptTrieAliasRootIdsByLine.set(event.line, rootId);
      }
    }
  }
  const javascriptTrieAliasFrame = Array.from(javascriptTrieAliasRootIdsByLine).find(
    ([line, rootId]) => javascriptTrieAliasNodeIdsByLine.get(line) === rootId
  );
  assertCondition(
    Boolean(javascriptTrieAliasFrame),
    'JavaScript trie tracing should preserve object identity when a local aliases this.root'
  );
  const javascriptScriptTrieTracing = await harness.sendMessage<{
    success: boolean;
    output: unknown;
    error?: string;
    trace?: { events?: RuntimeTraceEvent[] };
  }>('execute-with-tracing', {
    code: `class TrieNode {
  constructor() {
    this.children = new Map();
    this.is_end = false;
  }
}

class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(word) {
    let node = this.root;
    for (const char of word) {
      if (!node.children.has(char)) {
        node.children.set(char, new TrieNode());
      }
      node = node.children.get(char);
    }
    node.is_end = true;
  }

  search(word) {
    let node = this._find_node(word);
    return ((node !== null) && node.is_end);
  }

  startsWith(prefix) {
    return (this._find_node(prefix) !== null);
  }

  _find_node(prefix) {
    let node = this.root;
    for (const char of prefix) {
      if (!node.children.has(char)) {
        return null;
      }
      node = node.children.get(char);
    }
    return node;
  }
}

let trie = new Trie();
trie.insert("cat");
trie.insert("car");
let result = [trie.search("car"), trie.search("cap"), trie.startsWith("ca")];`,
    inputs: {},
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    javascriptScriptTrieTracing.success === true,
    `JavaScript script trie tracing should succeed: ${javascriptScriptTrieTracing.error ?? 'unknown error'}`
  );
  assertCondition(
    JSON.stringify(javascriptScriptTrieTracing.output) === JSON.stringify([true, false, true]),
    'JavaScript script trie output should preserve behavior'
  );
  const javascriptScriptTrieChildWrite = traceAccessEvents(javascriptScriptTrieTracing).find((event) =>
    event.kind === 'write' &&
    event.target?.variable === 'node' &&
    JSON.stringify(event.target.path) === JSON.stringify(['children', 'c'])
  );
  const javascriptScriptTrieChildMutate = traceAccessEvents(javascriptScriptTrieTracing).find((event) =>
    event.kind === 'mutate' &&
    event.target?.variable === 'node' &&
    event.method === 'set' &&
    JSON.stringify(event.target.path) === JSON.stringify(['children', 'c'])
  );
  const javascriptScriptTrieChildRead = traceAccessEvents(javascriptScriptTrieTracing).find((event) =>
    event.kind === 'read' &&
    event.target?.variable === 'node' &&
    JSON.stringify(event.target.path) === JSON.stringify(['children', 'c']) &&
    Boolean(runtimeRefId(event.value))
  );
  const javascriptScriptTrieWriteId = runtimeRefId(javascriptScriptTrieChildWrite?.value);
  const javascriptScriptTrieMutateArgs = Array.isArray(javascriptScriptTrieChildMutate?.args)
    ? javascriptScriptTrieChildMutate.args
    : [];
  const javascriptScriptTrieMutateId = runtimeRefId(javascriptScriptTrieMutateArgs[1]);
  const javascriptScriptTrieReadId = runtimeRefId(javascriptScriptTrieChildRead?.value);
  assertCondition(
    Boolean(javascriptScriptTrieWriteId) &&
      javascriptScriptTrieWriteId === javascriptScriptTrieMutateId &&
      javascriptScriptTrieWriteId === javascriptScriptTrieReadId,
    `JavaScript script trie child refs should agree across write/mutate/read, received ${JSON.stringify({
      write: javascriptScriptTrieChildWrite,
      mutate: javascriptScriptTrieChildMutate,
      read: javascriptScriptTrieChildRead,
    })}`
  );
  const insertBodySteps = traceLineEvents(typeScriptTrieObjectTracing).filter(
    (event) => event.function === 'insert' && (event.line === 18 || event.line === 19 || event.line === 24)
  );
  assertCondition(insertBodySteps.length > 0, 'Trie tracing should include insert body steps');
  const helperConstructorSteps = traceLineEvents(typeScriptTrieObjectTracing).filter(
    (event) => event.function === 'TrieNode.constructor' && (event.line === 6 || event.line === 7)
  );
  assertCondition(helperConstructorSteps.length > 0, 'Trie tracing should include helper constructor steps');
  assertCondition(
    traceEvents(typeScriptTrieObjectTracing).some((event) => event.kind === 'call' && event.function === 'insert'),
    'Trie insert operation should expose a runtime trace call event'
  );
  console.log('PASS: execute-with-tracing typescript trie object snapshot contract');

  const helperFunctionTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ variables?: Record<string, unknown>; line?: number; event?: string }>;
  }>('execute-with-tracing', {
    code: `class Solution {
  countRangeSum(nums: number[], lower: number, upper: number): number {
    const sortCount = (left: number, right: number): number => {
      return right - left;
    };
    let i = 2;
    return sortCount(0, 1) + i;
  }
}`,
    functionName: 'countRangeSum',
    executionStyle: 'solution-method',
    language: 'typescript',
    inputs: { nums: [1, 2, 3], lower: -1, upper: 1 },
  });
  assertCondition(helperFunctionTracing.success === true, 'TypeScript helper-function tracing should succeed');
  const helperLine = traceSnapshotEvents(helperFunctionTracing).find(
    (event) => event.target?.variable === 'i' && event.value === 2
  );
  assertCondition(Boolean(helperLine), 'TypeScript helper-function tracing should include the scalar local state');
  assertCondition(
    !traceSnapshotEvents(helperFunctionTracing).some((event) => event.target?.variable === 'sortCount'),
    'TypeScript helper functions should not be emitted as traced locals'
  );
  assertCondition(helperLine?.value === 2, 'TypeScript helper-function tracing should keep scalar locals');
  console.log('PASS: execute-with-tracing omits callable helper locals');

  for (const language of ['javascript', 'typescript'] as const) {
    const nestedArrowTracing = await harness.sendMessage<{
      success: boolean;
      error?: string;
      trace?: { events?: RuntimeTraceEvent[] };
    }>('execute-with-tracing', {
      code:
        language === 'typescript'
          ? `class Solution {
  countRangeSum(nums: number[], lower: number, upper: number): number {
    const prefix = [0];
    for (const num of nums) {
      prefix.push(prefix[prefix.length - 1] + num);
    }
    const mergeSort = (lo: number, hi: number): number => {
      if (lo >= hi) return 0;
      const mid = Math.floor((lo + hi) / 2);
      return mergeSort(lo, mid) + mergeSort(mid + 1, hi);
    };
    return mergeSort(0, prefix.length - 1);
  }
}`
          : `class Solution {
  countRangeSum(nums, lower, upper) {
    const prefix = [0];
    for (const num of nums) {
      prefix.push(prefix[prefix.length - 1] + num);
    }
    const mergeSort = (lo, hi) => {
      if (lo >= hi) return 0;
      const mid = Math.floor((lo + hi) / 2);
      return mergeSort(lo, mid) + mergeSort(mid + 1, hi);
    };
    return mergeSort(0, prefix.length - 1);
  }
}`,
      functionName: 'countRangeSum',
      executionStyle: 'solution-method',
      language,
      inputs: { nums: [-2, 5, -1], lower: -2, upper: 2 },
    });
    assertCondition(
      nestedArrowTracing.success === true,
      `${language} nested arrow tracing should succeed: ${nestedArrowTracing.error ?? 'unknown error'}`
    );
    const lineEvents = traceLineEvents(nestedArrowTracing);
    assertCondition(
      lineEvents.some((event) => event.function === 'mergeSort'),
      `${language} nested arrow helper body should emit real line events, received ${JSON.stringify(lineEvents)}`
    );
    assertCondition(
      traceEvents(nestedArrowTracing).some((event) => event.kind === 'call' && event.function === 'mergeSort'),
      `${language} nested arrow helper should emit call events`
    );
    assertCondition(
      traceAccessEvents(nestedArrowTracing).some(
        (event) => event.kind === 'mutate' && event.target?.variable === 'prefix' && event.method === 'push'
      ),
      `${language} prefix construction should emit mutating-call access events`
    );
  }
  console.log('PASS: execute-with-tracing JS/TS nested arrow helper instrumentation');

  const graphKindTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
    }>;
  }>('execute-with-tracing', {
    code: `function captureGraph() {
  const graph = { 0: [1], 1: [2], 2: [] };
  return graph;
}`,
    functionName: 'captureGraph',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(graphKindTracing.success === true, 'Graph-kind tracing should succeed');
  const hasGraphSnapshot = traceSnapshotEvents(graphKindTracing).some(
    (event) => event.target?.variable === 'graph' && event.value && typeof event.value === 'object'
  );
  assertCondition(
    hasGraphSnapshot,
    'Tracing should emit neutral runtime trace snapshots for adjacency-list object locals'
  );
  assertNoRuntimeTraceVisualizerPayloadLeak(graphKindTracing, 'javascript graph-object tracing');
  console.log('PASS: execute-with-tracing graph snapshot contract');

  const indexedGraphKindTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
    }>;
  }>('execute-with-tracing', {
    code: `function captureIndexedGraph() {
  const graph = [[1], [2], [0]];
  return graph.length;
}`,
    functionName: 'captureIndexedGraph',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(indexedGraphKindTracing.success === true, 'Indexed-graph tracing should succeed');
  const hasIndexedGraphSnapshot = traceSnapshotEvents(indexedGraphKindTracing).some(
    (event) => event.target?.variable === 'graph' && Array.isArray(event.value)
  );
  assertCondition(
    hasIndexedGraphSnapshot,
    'Tracing should emit neutral runtime trace snapshots for indexed adjacency-list locals'
  );
  assertNoRuntimeTraceVisualizerPayloadLeak(indexedGraphKindTracing, 'javascript indexed-graph tracing');
  console.log('PASS: execute-with-tracing indexed graph snapshot contract');

  const listKindTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
    }>;
  }>('execute-with-tracing', {
    code: `function captureList() {
  const head = { val: 1, next: { val: 2, next: null } };
  return head;
}`,
    functionName: 'captureList',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(listKindTracing.success === true, 'List-kind tracing should succeed');
  const hasListSnapshot = traceSnapshotEvents(listKindTracing).some(
    (event) =>
      event.target?.variable === 'head' &&
      event.value &&
      typeof event.value === 'object' &&
      (event.value as Record<string, unknown>).__type__ === 'ListNode' &&
      typeof (event.value as Record<string, unknown>).__id__ === 'string' &&
      (event.value as { next?: { __type__?: string; __id__?: string } }).next?.__type__ === 'ListNode' &&
      typeof (event.value as { next?: { __id__?: string } }).next?.__id__ === 'string'
  );
  assertCondition(
    hasListSnapshot,
    'Tracing should emit neutral runtime trace snapshots with typed linked-list node ids'
  );
  assertNoRuntimeTraceVisualizerPayloadLeak(listKindTracing, 'javascript linked-list tracing');
  console.log('PASS: execute-with-tracing linked-list snapshot contract');

  const customObjectTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{
    }>;
  }>('execute-with-tracing', {
    code: `function captureCustomObject() {
  class Box {
    constructor(value) {
      this.value = value;
    }
  }
  const box = new Box(7);
  return box;
}`,
    functionName: 'captureCustomObject',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(customObjectTracing.success === true, 'Custom object tracing should succeed');
  assertCondition(
    traceSnapshotEvents(customObjectTracing).some((event) => event.target?.variable === 'box'),
    'Tracing should emit runtime trace snapshots for custom object locals'
  );
  assertNoRuntimeTraceVisualizerPayloadLeak(customObjectTracing, 'javascript custom-object tracing');
  console.log('PASS: execute-with-tracing custom object id neutrality contract');

  const topLevelOrderingTracing = await harness.sendMessage<{
    success: boolean;
    trace: Array<{ event?: string; line?: number; function?: string }>;
  }>('execute-with-tracing', {
    code: `function identity(x) {
  return x;
}

if (1 === 1) {
  console.log('A');
}

result = identity(42);`,
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(topLevelOrderingTracing.success === true, 'Top-level ordering tracing should succeed');
  assertCondition(traceEvents(topLevelOrderingTracing).length > 0, 'Top-level ordering tracing should include steps');
  assertCondition(
    traceEvents(topLevelOrderingTracing)[0]?.kind === 'line' &&
      traceEvents(topLevelOrderingTracing)[0]?.function === '<module>' &&
      traceEvents(topLevelOrderingTracing)[0]?.line === 5,
    'Script tracing should start at first executable top-level statement line'
  );
  console.log('PASS: execute-with-tracing top-level start line contract');

  const opsClassStyle = await harness.sendMessage<{
    success: boolean;
    output?: unknown;
    error?: string;
  }>('execute-code', {
    code: `class Counter {
  constructor(start) { this.v = start; }
  inc(delta) { this.v += delta; return this.v; }
  get() { return this.v; }
}`,
    functionName: 'Counter',
    inputs: {
      operations: ['Counter', 'inc', 'inc', 'get'],
      arguments: [[1], [2], [3], []],
    },
    executionStyle: 'ops-class',
  });
  assertCondition(opsClassStyle.success === true, 'ops-class execution should succeed');
  assertCondition(
    Array.isArray(opsClassStyle.output) &&
      opsClassStyle.output[0] === null &&
      opsClassStyle.output[1] === 3 &&
      opsClassStyle.output[2] === 6 &&
      opsClassStyle.output[3] === 6,
    'ops-class execution should match Python-style operation replay output'
  );
  console.log('PASS: execute-code ops-class style');

  const typeScriptBatchIsolation = await harness.sendMessage<{
    success: boolean;
    results?: Array<{ success: boolean; output?: unknown; error?: string }>;
    error?: string;
  }>('execute-code-batch', {
    code: `let seen: number[] = [];
function solve(x: number): number {
  seen.push(x);
  return seen.length;
}`,
    functionName: 'solve',
    inputBatch: [{ x: 1 }, { x: 2 }],
    executionStyle: 'function',
    language: 'typescript',
  });
  assertCondition(
    typeScriptBatchIsolation.success === true,
    `TypeScript execute-code-batch should succeed: ${JSON.stringify(typeScriptBatchIsolation)}`
  );
  assertCondition(
    JSON.stringify(typeScriptBatchIsolation.results?.map((result) => result.output)) === JSON.stringify([1, 1]),
    `TypeScript execute-code-batch should isolate user globals per case: ${JSON.stringify(typeScriptBatchIsolation)}`
  );

  const sharedHead = { __type__: 'ListNode', val: 1, next: { __type__: 'ListNode', val: 2, next: null } };
  const javaScriptBatchMutationIsolation = await harness.sendMessage<{
    success: boolean;
    results?: Array<{ success: boolean; output?: unknown; error?: string }>;
    error?: string;
  }>('execute-code-batch', {
    code: `function reverseList(head) {
  let prev = null;
  let cur = head;
  while (cur) {
    const next = cur.next;
    cur.next = prev;
    prev = cur;
    cur = next;
  }
  return prev;
}`,
    functionName: 'reverseList',
    inputBatch: [{ head: sharedHead }, { head: sharedHead }],
    executionStyle: 'function',
    language: 'javascript',
  });
  assertCondition(
    javaScriptBatchMutationIsolation.success === true,
    `JavaScript execute-code-batch mutable case should succeed: ${JSON.stringify(javaScriptBatchMutationIsolation)}`
  );
  assertCondition(
    JSON.stringify(javaScriptBatchMutationIsolation.results?.map((result) => result.output)) === JSON.stringify([
      { __type__: 'ListNode', __id__: 'ref-1', val: 2, next: { __type__: 'ListNode', __id__: 'ref-2', val: 1, next: null } },
      { __type__: 'ListNode', __id__: 'ref-1', val: 2, next: { __type__: 'ListNode', __id__: 'ref-2', val: 1, next: null } },
    ]),
    `JavaScript execute-code-batch should isolate mutable linked-list inputs per case: ${JSON.stringify(javaScriptBatchMutationIsolation)}`
  );
  console.log('PASS: execute-code-batch isolates JS/TS globals and mutable inputs');

  const interviewResult = await harness.sendMessage<{
    success: boolean;
    error?: string;
  }>('execute-code-interview', {
    code: 'function boom() { throw new Error("kaboom"); }',
    functionName: 'boom',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(interviewResult.success === false, 'Interview execution should surface errors');
  assertCondition(
    String(interviewResult.error ?? '').toLowerCase().includes('kaboom'),
    'Interview execution should preserve non-timeout errors'
  );
  console.log('PASS: interview execution contract');

  const interviewTimeout = await harness.sendMessage<{
    success: boolean;
    error?: string;
  }>('execute-code-interview', {
    code: `function spin() { let x = 0; while (true) { x += 1; } }`,
    functionName: 'spin',
    inputs: {},
    executionStyle: 'function',
  });
  assertCondition(interviewTimeout.success === false, 'Interview timeout case should fail');
  assertCondition(
    String(interviewTimeout.error ?? '') === 'Time Limit Exceeded',
    'Interview timeout should normalize to Time Limit Exceeded'
  );
  console.log('PASS: interview timeout normalization contract');

  console.log('\nJavaScript runtime worker tests passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
