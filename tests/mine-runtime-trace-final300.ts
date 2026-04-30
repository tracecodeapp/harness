#!/usr/bin/env npx tsx

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import type { Language, RuntimeExecutionStyle } from '../packages/harness-core/src/runtime-types';
import { createJavaRuntimeClient } from '../packages/harness-browser/src/java-runtime-client';
import type {
  JavaWorkerClient,
  JavaWorkerRawTraceResult,
  JavaWorkerTraceResult,
} from '../packages/harness-browser/src/java-worker-client';
import type { ExecutionResult } from '../packages/harness-core/src/types';
import {
  createEmptyRuntimeTrace,
  withRuntimeTraceOptions,
  type RuntimeTraceEvent,
  type RuntimeTrace,
} from '../packages/harness-core/src/runtime-trace';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/harness-python/src/python-harness';
import { javaTraceHooksEventsToRuntimeTrace } from '../packages/harness-core/src/trace-adapters/java';

const DEFAULT_FINAL300_PATH = '/Users/obinnanwachukwu/Code/algoflow/tests/v3-corpus/tracecode-final300-slice.json';
const PYTHON_RUNTIME_CORE_PATH = join(process.cwd(), 'workers', 'python', 'runtime-core.js');
const JAVASCRIPT_WORKER_PATH = join(process.cwd(), 'workers', 'javascript', 'javascript-worker.js');
const JAVA_SOURCE_AUGMENTATIONS_PATH = join(process.cwd(), 'workers', 'java', 'java-source-augmentations.js');
const JAVA_REWRITER_CLASSPATH = [
  join(process.cwd(), 'workers', 'vendor', 'java-rewriter.jar'),
  join(process.cwd(), 'workers', 'vendor', 'javaparser-core-3.25.10.jar'),
].join(':');
const JAVA_HELPER_JAR = join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar');
const JAVA_BIN_CANDIDATES = [
  process.env.TRACECODE_JAVA17_BIN,
  process.env.JAVA17_HOME ? join(process.env.JAVA17_HOME, 'bin', 'java') : undefined,
  '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home/bin/java',
  '/Users/obinnanwachukwu/Library/Java/JavaVirtualMachines/jbr-17.0.14/Contents/Home/bin/java',
  '/Library/Java/JavaVirtualMachines/temurin-25.jdk/Contents/Home/bin/java',
  'java',
].filter((candidate): candidate is string => Boolean(candidate));
const JAVA_BIN = JAVA_BIN_CANDIDATES.find((candidate) => candidate === 'java' || existsSync(candidate)) ?? 'java';

type MineLanguage = Extract<Language, 'python' | 'javascript' | 'typescript' | 'java'>;

interface Final300Entry {
  slug: string;
  family?: string;
  language: MineLanguage;
  functionName: string;
  source: { kind: string; path: string };
  runtimeExecutionStyle?: RuntimeExecutionStyle;
  inputs: Record<string, unknown>;
  expectedOutput?: unknown;
}

interface RuntimeCore {
  generateTracingCode: (
    deps: {
      PYTHON_CLASS_DEFINITIONS_SNIPPET: string;
      PYTHON_CONVERSION_HELPERS_SNIPPET: string;
      PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: string;
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: string;
      toPythonLiteral: (value: unknown) => string;
    },
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ) => { code: string };
}

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

interface TraceRun {
  language: MineLanguage;
  output: unknown;
  trace: RuntimeTrace;
  signature: MineSignature;
}

interface MineSignature {
  eventKindCounts: Record<string, number>;
  accessFacts: Record<string, number>;
  accessShapeFacts: Record<string, number>;
  snapshotVariables: string[];
  callCount: number;
  returnCount: number;
  stdoutCount: number;
  exceptionCount: number;
}

interface DriftRecord {
  slug: string;
  family?: string;
  comparedTo: MineLanguage | 'expectedOutput';
  language: MineLanguage;
  kinds: string[];
  output?: { expected: unknown; received: unknown };
  signatureDiff?: {
    expected: MineSignature;
    received: MineSignature;
  };
}

interface DriftCluster {
  key: string;
  count: number;
  examples: Array<{ slug: string; language: MineLanguage }>;
}

function parseStringFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseNumberFlag(name: string, fallback: number): number {
  const raw = parseStringFlag(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',') + '}';
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function targetKey(event: RuntimeTraceEvent): string | null {
  if ((event.kind !== 'read' && event.kind !== 'write' && event.kind !== 'mutate') || !('target' in event)) {
    return null;
  }
  if (!('variable' in event.target)) return null;
  const pathDepth = 'path' in event.target && Array.isArray(event.target.path) ? event.target.path.length : 0;
  const method = event.kind === 'mutate' && 'method' in event && event.method ? `:${event.method}` : '';
  return `${event.kind}:${event.target.variable}:path${pathDepth}${method}`;
}

function buildMineSignature(trace: RuntimeTrace): MineSignature {
  const eventKindCounts: Record<string, number> = {};
  const accessFacts: Record<string, number> = {};
  const accessShapeFacts: Record<string, number> = {};
  const snapshotVariables = new Set<string>();

  for (const event of trace.events) {
    increment(eventKindCounts, event.kind);
    const accessKey = targetKey(event);
    if (accessKey) {
      increment(accessFacts, accessKey);
      increment(accessShapeFacts, accessKey.replace(/^(read|write|mutate):[^:]+:/, '$1:*:'));
    }
    if (event.kind === 'snapshot' && 'variable' in event.target) {
      snapshotVariables.add(event.target.variable);
    }
  }

  return {
    eventKindCounts,
    accessFacts,
    accessShapeFacts,
    snapshotVariables: [...snapshotVariables].sort((left, right) => left.localeCompare(right)),
    callCount: eventKindCounts.call ?? 0,
    returnCount: eventKindCounts.return ?? 0,
    stdoutCount: eventKindCounts.stdout ?? 0,
    exceptionCount: eventKindCounts.exception ?? 0,
  };
}

async function runProcess(command: string, args: string[], input?: string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`));
    });
    child.stdin.end(input ?? '');
  });
}

async function loadPythonRuntimeCore(): Promise<RuntimeCore> {
  const source = await readFile(PYTHON_RUNTIME_CORE_PATH, 'utf8');
  const selfObject: Record<string, unknown> = {};
  const context = vm.createContext({ console, self: selfObject, globalThis: {} });
  vm.runInContext(source, context, { filename: 'runtime-core.js' });
  const runtime = selfObject.__TRACECODE_PYODIDE_RUNTIME__;
  if (!runtime || typeof runtime !== 'object') throw new Error('Unable to load Python runtime core');
  return runtime as RuntimeCore;
}

async function runPythonScript(script: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-runtime-trace-mine-python-'));
  const scriptPath = join(tempDir, 'trace.py');
  await writeFile(scriptPath, script, 'utf8');
  try {
    return await runProcess('python3', [scriptPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function executePythonTrace(
  runtime: RuntimeCore,
  entry: Final300Entry,
  code: string,
  maxTraceSteps: number,
  maxLineEvents: number,
  maxSingleLineHits: number
): Promise<TraceRun> {
  const tracingPayload = runtime.generateTracingCode(
    {
      PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
      PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
      PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
      toPythonLiteral,
    },
    code,
    entry.functionName,
    entry.inputs,
    entry.runtimeExecutionStyle ?? 'function',
    { maxTraceSteps, maxLineEvents, maxSingleLineHits }
  );
  const stdout = await runPythonScript(`${tracingPayload.code}
print(json.dumps({
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events,
        'lineEventCount': len([event for event in _trace_events if event.get('kind') == 'line']),
        'traceStepCount': len(_trace_events)
    },
    'result': _serialize(_result),
    'lineEventCount': _total_line_events,
    'traceStepCount': len(_trace_events),
    'traceLimitExceeded': bool(globals().get('_trace_limit_exceeded', False)),
    'timeoutReason': globals().get('_timeout_reason', None)
}))
`);
  const parsed = JSON.parse(stdout) as {
    runtimeTrace: RuntimeTrace;
    result: unknown;
    lineEventCount?: number;
    traceStepCount?: number;
    traceLimitExceeded?: boolean;
    timeoutReason?: string | null;
  };
  if (parsed.traceLimitExceeded && parsed.timeoutReason !== 'trace-limit') {
    throw new Error(`python tracing failed: ${parsed.timeoutReason ?? 'trace limit exceeded'}`);
  }
  const runId = `mine:${entry.slug}:python`;
  const events = Array.isArray(parsed.runtimeTrace.events) ? parsed.runtimeTrace.events : [];
  const trace: RuntimeTrace = {
    schemaVersion: parsed.runtimeTrace.schemaVersion,
    language: 'python',
    runId,
    events: events.map((event) => ({
      ...event,
      runId,
      file: entry.source.path,
    })),
    lineEventCount: events.filter((event) => event.kind === 'line').length,
    traceStepCount: parsed.runtimeTrace.traceStepCount ?? events.length,
  };
  return { language: 'python', output: parsed.result, trace, signature: buildMineSignature(trace) };
}

function createJavaScriptWorkerHarness(workerSource: string) {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }>();
  let ready = false;
  let nextId = 0;
  const selfObject: {
    location: { search: string };
    postMessage: (message: WorkerMessage) => void;
    onmessage: ((event: { data: WorkerMessage }) => void) | null;
    ts?: unknown;
  } = {
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
      pending.delete(id);
      clearTimeout(entry.timeoutId);
      if (message.type === 'error') {
        const payload = message.payload as { error?: unknown } | undefined;
        entry.reject(new Error(String(payload?.error ?? 'Worker error')));
        return;
      }
      entry.resolve(message.payload);
    },
    onmessage: null,
    ts,
  };
  const context = vm.createContext({ console, self: selfObject, performance: { now: () => Date.now() }, setTimeout, clearTimeout });
  vm.runInContext(workerSource, context, { filename: 'javascript-worker.js' });
  const onmessage = selfObject.onmessage;
  if (typeof onmessage !== 'function') throw new Error('JavaScript worker did not register onmessage');
  if (!ready) throw new Error('JavaScript worker did not emit worker-ready');

  async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    const responsePromise = new Promise<T>((resolvePromise, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response: ${type}`));
      }, 60_000);
      pending.set(id, { resolve: resolvePromise as (value: unknown) => void, reject, timeoutId });
    });
    onmessage({ data: { id, type, payload } });
    return responsePromise;
  }

  return { sendMessage };
}

async function executeJavaScriptTrace(
  workerSource: string,
  entry: Final300Entry,
  code: string,
  maxTraceSteps: number,
  maxLineEvents: number,
  maxSingleLineHits: number
): Promise<TraceRun> {
  const harness = createJavaScriptWorkerHarness(workerSource);
  const init = await harness.sendMessage<{ success: boolean }>('init');
  if (init.success !== true) throw new Error(`${entry.language} worker init failed`);
  const result = await harness.sendMessage<ExecutionResult>('execute-with-tracing', {
    code,
    functionName: entry.functionName,
    inputs: entry.inputs,
    executionStyle: entry.runtimeExecutionStyle ?? 'function',
    language: entry.language,
    options: { maxTraceSteps, maxLineEvents, maxSingleLineHits },
  });
  if (!result.success) throw new Error(`${entry.language} tracing failed: ${result.error ?? 'unknown error'}`);
  const trace = result.trace;
  return { language: entry.language, output: result.output, trace, signature: buildMineSignature(trace) };
}


function normalizeTopLevelPublicClasses(source: string): string {
  return source.replace(/(^|\n)\s*public\s+class\s+/g, '$1class ');
}

function createLocalJavaWorkerClient(): JavaWorkerClient {
  const stringFiles = new Map<string, string>();
  const rootPromise = mkdtemp(join(tmpdir(), 'tracecode-runtime-trace-mine-java-'));

  async function rewriteSource(
    source: string,
    executionStyle: string,
    entryName: string,
    exportsSource: string,
    exportsClassName: string,
    packageName: string
  ): Promise<string> {
    const root = await rootPromise;
    const workDir = await mkdtemp(join(root, 'rewrite-'));
    const inputPath = join(workDir, 'Input.java');
    const outputPath = join(workDir, 'Output.java');
    const exportsPath = join(workDir, 'Exports.java');
    await writeFile(inputPath, normalizeTopLevelPublicClasses(source), 'utf8');
    await writeFile(exportsPath, exportsSource, 'utf8');
    await runProcess(JAVA_BIN, [
      '-cp',
      JAVA_REWRITER_CLASSPATH,
      'harness.browser.JavaRewriteLibrary',
      inputPath,
      outputPath,
      executionStyle,
      entryName,
      exportsPath,
      exportsClassName,
      packageName,
    ]);
    return readFile(outputPath, 'utf8');
  }

  async function compileAndTrace(
    sourcePath: string,
    classesDir: string,
    entryClass: string,
    _helperJarPath: string,
    _compilerProfile: string,
    maxStoredEvents?: string
  ): Promise<string> {
    const root = await rootPromise;
    const source = stringFiles.get(sourcePath);
    if (source === undefined) throw new Error(`Missing Java source for virtual path: ${sourcePath}`);
    const sourceFile = join(root, sourcePath.replace(/^\/+/, ''));
    const outputClassesDir = join(root, classesDir.replace(/^\/+/, '').replace(/\//g, '__'));
    const reportPath = join(root, `${entryClass.replace(/\W/g, '_')}.json`);
    await mkdir(dirname(sourceFile), { recursive: true });
    await mkdir(outputClassesDir, { recursive: true });
    await writeFile(sourceFile, source, 'utf8');
    await runProcess(JAVA_BIN, [
      '-cp',
      JAVA_HELPER_JAR,
      'tracecode.browser.BrowserCompileAndTraceMain',
      sourceFile,
      outputClassesDir,
      reportPath,
      entryClass,
      JAVA_HELPER_JAR,
      ...(maxStoredEvents ? [maxStoredEvents] : []),
    ]);
    return readFile(reportPath, 'utf8');
  }

  const workerClient = {
    init: async () => ({ success: true, loadTimeMs: 0 }),
    executeWithTracing: async (
      code: string,
      functionName: string,
      inputs: Record<string, unknown>,
      options: Record<string, unknown> | undefined,
      executionStyle: string
    ): Promise<JavaWorkerTraceResult> => {
      const workerSource = await readFile(join(process.cwd(), 'workers', 'java', 'java-worker.js'), 'utf8');
      const augmentationSource = await readFile(JAVA_SOURCE_AUGMENTATIONS_PATH, 'utf8');
      let response: JavaWorkerRawTraceResult | null = null;
      let errorResponse: Error | null = null;
      const activeWorkerTimers = new Set<ReturnType<typeof setTimeout>>();
      const workerSetTimeout: typeof setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const timer = setTimeout(() => {
          activeWorkerTimers.delete(timer);
          if (typeof handler === 'function') {
            handler(...args);
          } else {
            vm.runInContext(String(handler), context);
          }
        }, timeout);
        activeWorkerTimers.add(timer);
        return timer;
      }) as typeof setTimeout;
      const workerClearTimeout: typeof clearTimeout = ((timer?: string | number | NodeJS.Timeout) => {
        if (timer && typeof timer !== 'string' && typeof timer !== 'number') activeWorkerTimers.delete(timer);
        clearTimeout(timer);
      }) as typeof clearTimeout;
      const closeWorker = () => {
        for (const timer of activeWorkerTimers) clearTimeout(timer);
        activeWorkerTimers.clear();
      };

      const selfObject: {
        postMessage: (message: WorkerMessage) => void;
        onmessage: ((event: { data: WorkerMessage }) => void) | null;
        importScripts: (...urls: string[]) => void;
        cheerpjInit: () => Promise<void>;
        cheerpOSAddStringFile: (path: string, source: string) => Promise<void>;
        cheerpjRunLibrary: () => Promise<unknown>;
        close: () => void;
      } = {
        postMessage: (message: WorkerMessage) => {
          if (message.type === 'worker-ready') return;
          if (message.id !== 'trace') return;
          if (message.type === 'error') {
            const payload = message.payload as { error?: unknown } | undefined;
            errorResponse = new Error(String(payload?.error ?? 'Java worker error'));
            return;
          }
          response = message.payload as JavaWorkerRawTraceResult;
        },
        onmessage: null,
        importScripts: (...urls: string[]) => {
          for (const url of urls) {
            if (String(url).endsWith('java-source-augmentations.js')) {
              vm.runInContext(augmentationSource, context, { filename: 'java-source-augmentations.js' });
            }
          }
        },
        cheerpjInit: async () => {},
        cheerpOSAddStringFile: async (path: string, source: string) => {
          stringFiles.set(path, source);
        },
        cheerpjRunLibrary: async () => ({
          harness: { browser: { JavaRewriteLibrary: { rewriteSource } } },
          tracecode: { browser: { BrowserCompileAndTraceLibrary: { compileAndTrace } } },
        }),
        close: closeWorker,
      };
      const context = vm.createContext({
        console,
        self: selfObject,
        performance: { now: () => Date.now() },
        setTimeout: workerSetTimeout,
        clearTimeout: workerClearTimeout,
        queueMicrotask,
      });
      try {
        vm.runInContext(workerSource, context, { filename: 'java-worker.js' });
        if (typeof selfObject.onmessage !== 'function') throw new Error('Java worker did not register onmessage');
        selfObject.onmessage({ data: { id: 'init', type: 'init' } });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
        selfObject.onmessage({
          data: {
            id: 'trace',
            type: 'execute-with-tracing',
            payload: { code, functionName, inputs, options, executionStyle },
          },
        });
        const startedAt = Date.now();
        while (!response && !errorResponse && Date.now() - startedAt < 60_000) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        if (errorResponse) throw errorResponse;
        if (!response) throw new Error('Timed out waiting for local Java worker response');
        return {
          ...response,
          trace: response.success
            ? javaTraceHooksEventsToRuntimeTrace(response.events, response.sourceText, {
                runId: 'java:run',
                file: 'Solution.java',
              })
            : createEmptyRuntimeTrace('java', { runId: 'java:run', file: 'Solution.java' }),
        };
      } finally {
        closeWorker();
      }
    },
    executeCode: async () => { throw new Error('executeCode is not used by runtime trace mining'); },
    executeCodeInterviewMode: async () => { throw new Error('executeCodeInterviewMode is not used by runtime trace mining'); },
    terminate: () => {
      if (process.env.TRACECODE_KEEP_JAVA_MINE_TEMP === '1') return;
      void rootPromise.then((root) => rm(root, { recursive: true, force: true }));
    },
  };

  return workerClient as unknown as JavaWorkerClient;
}

async function executeJavaTrace(
  entry: Final300Entry,
  code: string,
  maxTraceSteps: number,
  maxLineEvents: number,
  maxSingleLineHits: number
): Promise<TraceRun> {
  const workerClient = createLocalJavaWorkerClient();
  const client = createJavaRuntimeClient(workerClient);
  try {
    const result = await client.executeWithTracing(
      code,
      entry.functionName,
      entry.inputs,
      { maxTraceSteps, maxLineEvents, maxSingleLineHits },
      entry.runtimeExecutionStyle ?? 'function'
    );
    if (!result.success) throw new Error(`java tracing failed: ${result.error ?? 'unknown error'}`);
    const trace = withRuntimeTraceOptions(result.trace, {
      runId: `mine:${entry.slug}:java`,
      file: entry.source.path,
    });
    return { language: 'java', output: result.output, trace, signature: buildMineSignature(trace) };
  } finally {
    workerClient.terminate();
  }
}

function inferCorpusRoot(corpusPath: string): string {
  const explicit = parseStringFlag('source-root');
  if (explicit) return resolve(explicit);
  const normalized = resolve(corpusPath);
  const marker = `${join('tests', 'v3-corpus')}`;
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) return normalized.slice(0, index).replace(/[\/]$/, '');
  return dirname(dirname(dirname(normalized)));
}

function resolveSourcePath(root: string, entry: Final300Entry): string {
  return isAbsolute(entry.source.path) ? entry.source.path : join(root, entry.source.path);
}

function signaturesEqual(left: MineSignature, right: MineSignature): boolean {
  const comparableLeft = {
    accessShapeKinds: Object.keys(left.accessShapeFacts).sort((a, b) => a.localeCompare(b)),
    stdoutCount: left.stdoutCount,
    exceptionCount: left.exceptionCount,
  };
  const comparableRight = {
    accessShapeKinds: Object.keys(right.accessShapeFacts).sort((a, b) => a.localeCompare(b)),
    stdoutCount: right.stdoutCount,
    exceptionCount: right.exceptionCount,
  };
  return stableStringify(comparableLeft) === stableStringify(comparableRight);
}

function compareRuns(
  slug: string,
  family: string | undefined,
  reference: TraceRun,
  run: TraceRun,
  compareRuntimeFacts: boolean,
  compareOutputToReference: boolean
): DriftRecord | null {
  const kinds: string[] = [];
  let output: DriftRecord['output'];
  let signatureDiff: DriftRecord['signatureDiff'];
  if (compareOutputToReference && stableStringify(reference.output) !== stableStringify(run.output)) {
    kinds.push('output');
    output = { expected: reference.output, received: run.output };
  }
  if (compareRuntimeFacts && !signaturesEqual(reference.signature, run.signature)) {
    kinds.push('runtime-facts');
    signatureDiff = { expected: reference.signature, received: run.signature };
  }
  if (kinds.length === 0) return null;
  return { slug, family, comparedTo: reference.language, language: run.language, kinds, output, signatureDiff };
}

function hasExpectedOutput(entry: Final300Entry): boolean {
  return Object.prototype.hasOwnProperty.call(entry, 'expectedOutput');
}

function diffKeySet(left: Record<string, number>, right: Record<string, number>): string[] {
  const leftKeys = new Set(Object.keys(left));
  const rightKeys = new Set(Object.keys(right));
  return [...new Set([...leftKeys, ...rightKeys])]
    .sort((a, b) => a.localeCompare(b))
    .filter((key) => !leftKeys.has(key) || !rightKeys.has(key))
    .map((key) => `${key}:${leftKeys.has(key) ? 'present' : 'missing'}->${rightKeys.has(key) ? 'present' : 'missing'}`);
}

function clusterDrifts(drifts: DriftRecord[]): DriftCluster[] {
  const clusters = new Map<string, DriftCluster>();
  for (const drift of drifts) {
    const shapeDiff = drift.signatureDiff
      ? diffKeySet(drift.signatureDiff.expected.accessShapeFacts, drift.signatureDiff.received.accessShapeFacts)
      : [];
    const key = [
      ...drift.kinds,
      ...shapeDiff.slice(0, 8),
    ].join('|');
    const cluster = clusters.get(key) ?? { key, count: 0, examples: [] };
    cluster.count += 1;
    if (cluster.examples.length < 8) {
      cluster.examples.push({ slug: drift.slug, language: drift.language });
    }
    clusters.set(key, cluster);
  }
  return [...clusters.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function synthesizeJavaEntry(sourceRoot: string, group: Final300Entry[]): Final300Entry | null {
  if (group.some((entry) => entry.language === 'java')) return null;
  const reference = group.find((entry) => entry.language === 'python') ?? group[0];
  if (!reference) return null;

  const javaPath = join(
    'experiments',
    'trusted-visualizer-corpus',
    'generated-validated-java',
    'problems',
    reference.slug,
    'java.java'
  );
  if (!existsSync(join(sourceRoot, javaPath))) return null;

  return {
    ...reference,
    language: 'java',
    source: { kind: 'file', path: javaPath },
  };
}

async function writeReport(reportPath: string, value: unknown): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const corpusPath = resolve(parseStringFlag('corpus') ?? DEFAULT_FINAL300_PATH);
  if (!existsSync(corpusPath)) {
    throw new Error(`Final300 corpus not found. Pass --corpus=/path/to/tracecode-final300-slice.json. Tried: ${corpusPath}`);
  }
  const sourceRoot = inferCorpusRoot(corpusPath);
  const limit = parseNumberFlag('limit', 20);
  const offset = parseNumberFlag('offset', 0);
  const reportPath = resolve(parseStringFlag('report') ?? join(process.cwd(), 'reports', 'runtime-trace-final300-mine.json'));
  const maxTraceSteps = parseNumberFlag('max-trace-steps', 10000);
  const maxLineEvents = parseNumberFlag('max-line-events', 20000);
  const maxSingleLineHits = parseNumberFlag('max-single-line-hits', 10000);
  const failOnDrift = hasFlag('fail-on-drift');
  const compareRuntimeFacts = hasFlag('compare-runtime-facts');

  const entries = JSON.parse(await readFile(corpusPath, 'utf8')) as Final300Entry[];
  const bySlug = new Map<string, Final300Entry[]>();
  for (const entry of entries) {
    if (!['python', 'javascript', 'typescript', 'java'].includes(entry.language)) continue;
    const group = bySlug.get(entry.slug) ?? [];
    group.push(entry);
    bySlug.set(entry.slug, group);
  }
  let synthesizedJavaEntries = 0;
  for (const [slug, group] of bySlug) {
    const javaEntry = synthesizeJavaEntry(sourceRoot, group);
    if (javaEntry) {
      bySlug.set(slug, [...group, javaEntry]);
      synthesizedJavaEntries += 1;
    }
  }

  const groups = [...bySlug.entries()]
    .filter(([, group]) => group.some((entry) => entry.language === 'python') && group.length > 1)
    .slice(offset, offset + limit);
  const pythonRuntime = await loadPythonRuntimeCore();
  const workerSource = await readFile(JAVASCRIPT_WORKER_PATH, 'utf8');
  const drifts: DriftRecord[] = [];
  const failures: Array<{ slug: string; language: MineLanguage; error: string }> = [];
  let compared = 0;

  for (const [slug, group] of groups) {
    const runs = new Map<MineLanguage, TraceRun>();
    const entriesByLanguage = new Map<MineLanguage, Final300Entry>();
    for (const entry of group.sort((left, right) => left.language.localeCompare(right.language))) {
      entriesByLanguage.set(entry.language, entry);
      const sourcePath = resolveSourcePath(sourceRoot, entry);
      try {
        const code = await readFile(sourcePath, 'utf8');
        const run = entry.language === 'python'
          ? await executePythonTrace(pythonRuntime, entry, code, maxTraceSteps, maxLineEvents, maxSingleLineHits)
          : entry.language === 'java'
            ? await executeJavaTrace(entry, code, maxTraceSteps, maxLineEvents, maxSingleLineHits)
            : await executeJavaScriptTrace(workerSource, entry, code, maxTraceSteps, maxLineEvents, maxSingleLineHits);
        runs.set(entry.language, run);
        if (hasExpectedOutput(entry) && stableStringify(entry.expectedOutput) !== stableStringify(run.output)) {
          drifts.push({
            slug,
            family: entry.family,
            comparedTo: 'expectedOutput',
            language: entry.language,
            kinds: ['output'],
            output: { expected: entry.expectedOutput, received: run.output },
          });
        }
      } catch (error) {
        failures.push({ slug, language: entry.language, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const reference = runs.get('python');
    if (!reference) continue;
    for (const language of ['javascript', 'typescript', 'java'] as MineLanguage[]) {
      const run = runs.get(language);
      if (!run) continue;
      compared += 1;
      const entry = entriesByLanguage.get(language);
      const drift = compareRuns(
        slug,
        group[0]?.family,
        reference,
        run,
        compareRuntimeFacts,
        !entry || !hasExpectedOutput(entry)
      );
      if (drift) drifts.push(drift);
    }
  }

  const report = {
    corpusPath,
    sourceRoot,
    offset,
    limit,
    maxTraceSteps,
    maxLineEvents,
    maxSingleLineHits,
    compareRuntimeFacts,
    groupsScanned: groups.length,
    synthesizedJavaEntries,
    comparisons: compared,
    driftCount: drifts.length,
    failureCount: failures.length,
    driftClusters: clusterDrifts(drifts),
    drifts,
    failures,
  };
  await writeReport(reportPath, report);

  console.log(`runtime trace final300 mining: groups=${groups.length} comparisons=${compared} drifts=${drifts.length} failures=${failures.length}`);
  console.log(`Synthesized Java entries: ${synthesizedJavaEntries}`);
  console.log(`Report: ${reportPath}`);
  for (const cluster of clusterDrifts(drifts).slice(0, 5)) {
    console.log(`CLUSTER x${cluster.count} ${cluster.key}`);
  }
  for (const drift of drifts.slice(0, 10)) {
    console.log(`DRIFT ${drift.slug} ${drift.language} kinds=${drift.kinds.join(',')}`);
  }
  for (const failure of failures.slice(0, 10)) {
    console.log(`FAIL ${failure.slug} ${failure.language}: ${failure.error.split('\n')[0]}`);
  }

  if (failOnDrift && (drifts.length > 0 || failures.length > 0)) {
    process.exitCode = 1;
  }
  // VM-backed worker shims can leave non-critical timer handles behind after
  // timeout cases. This is a report generator, so exit explicitly once the
  // report is flushed.
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
