#!/usr/bin/env npx tsx

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import type { Language, RuntimeExecutionStyle } from '../packages/harness-core/src/runtime-types';
import type { ExecutionResult } from '../packages/harness-core/src/types';
import {
  createEmptyRuntimeTrace,
  type RuntimeTraceEventKind,
  type RuntimeTraceParityAccessTarget,
  type RuntimeTrace,
} from '../packages/harness-core/src/runtime-trace';
import {
  assertSupportedRawEmissions,
  compareRawEmissionParity,
  summarizeJavaRawEmissions,
  summarizeRuntimeTraceEmissions,
  type RuntimeRawEmissionSummary,
} from '../packages/harness-core/src/runtime-raw-emission-contract';
import { createJavaRuntimeClient } from '../packages/harness-browser/src/java-runtime-client';
import type {
  JavaWorkerClient,
  JavaWorkerRawTraceResult,
  JavaWorkerTraceResult,
} from '../packages/harness-browser/src/java-worker-client';
import { javaTraceHooksEventsToRuntimeTrace } from '../packages/harness-core/src/trace-adapters/java';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/harness-python/src/python-harness';

const FIXTURES_DIR = join(process.cwd(), 'fixtures', 'runtime-parity');
const PYTHON_RUNTIME_CORE_PATH = join(process.cwd(), 'workers', 'python', 'runtime-core.js');
const JAVASCRIPT_WORKER_PATH = join(process.cwd(), 'workers', 'javascript', 'javascript-worker.js');
const CPP_WORKER_PATH = join(process.cwd(), 'workers', 'cpp', 'cpp-worker.js');
const CPP_RUNTIME_HEADER_PATH = join(process.cwd(), 'workers', 'cpp', 'tracecode_runtime.hpp');
const CPP_COMPILER_BUNDLE_PATH = join(process.cwd(), 'node_modules', '@yowasp', 'clang', 'gen', 'bundle.js');
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
type TraceFixtureLanguage = Language;

// The fixture gate verifies that each language runtime emits the default
// runtime trace contract directly instead of depending on post-hoc coercion.

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

interface FixtureCase {
  id: string;
  functionName: string;
  executionStyle: RuntimeExecutionStyle;
  inputs: Record<string, unknown>;
  anchors: Record<string, Partial<Record<TraceFixtureLanguage, string>>>;
  expect: Record<string, {
    eventKinds: RuntimeTraceEventKind[];
    variableSnapshots: string[];
    accessTargets: RuntimeTraceParityAccessTarget[];
  }>;
  expectByLanguage?: Partial<Record<TraceFixtureLanguage, Record<string, {
    eventKinds: RuntimeTraceEventKind[];
    variableSnapshots: string[];
    accessTargets: RuntimeTraceParityAccessTarget[];
  }>>>;
  expectSummary?: {
    accessTargets?: Array<RuntimeTraceParityAccessTarget & { count: number }>;
  };
  expectSummaryByLanguage?: Partial<Record<TraceFixtureLanguage, {
    accessTargets?: Array<RuntimeTraceParityAccessTarget & { count: number }>;
  }>>;
  expectOpaqueRefs?: boolean;
  knownGaps?: Partial<Record<TraceFixtureLanguage, Record<string, string>>>;
}

type RuntimeCore = {
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
};

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',') + '}';
}

function stripAccessTargetMethods<T extends { accessTargets?: RuntimeTraceParityAccessTarget[] }>(entry: T): T {
  if (!Array.isArray(entry.accessTargets)) {
    return entry;
  }
  return {
    ...entry,
    accessTargets: sortedUniqueAccessTargets(entry.accessTargets.map((target) => ({
      kind: target.kind,
      ...(target.variable !== undefined ? { variable: target.variable } : {}),
      ...(target.pathDepth !== undefined ? { pathDepth: target.pathDepth } : {}),
    }))),
  };
}

function stripRoleSignatureMethods<T extends Record<string, {
  eventKinds: RuntimeTraceEventKind[];
  variableSnapshots: string[];
  accessTargets: RuntimeTraceParityAccessTarget[];
}>>(signature: T): T {
  return Object.fromEntries(
    Object.entries(signature).map(([role, entry]) => [role, stripAccessTargetMethods(entry)])
  ) as T;
}

function stripSummaryMethods<T extends { accessTargets?: Array<RuntimeTraceParityAccessTarget & { count: number }> }>(
  summary: T
): T {
  if (!Array.isArray(summary.accessTargets)) {
    return summary;
  }
  const counts = new Map<string, RuntimeTraceParityAccessTarget & { count: number }>();
  for (const target of summary.accessTargets) {
    const normalized: RuntimeTraceParityAccessTarget & { count: number } = {
      kind: target.kind,
      ...(target.variable !== undefined ? { variable: target.variable } : {}),
      ...(target.pathDepth !== undefined ? { pathDepth: target.pathDepth } : {}),
      count: 0,
    };
    const key = stableStringify({
      kind: normalized.kind,
      ...(normalized.variable !== undefined ? { variable: normalized.variable } : {}),
      ...(normalized.pathDepth !== undefined ? { pathDepth: normalized.pathDepth } : {}),
    });
    const existing = counts.get(key) ?? normalized;
    existing.count += target.count;
    counts.set(key, existing);
  }
  return {
    ...summary,
    accessTargets: [...counts.values()]
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortedUniqueAccessTargets(
  values: RuntimeTraceParityAccessTarget[]
): RuntimeTraceParityAccessTarget[] {
  const byKey = new Map<string, RuntimeTraceParityAccessTarget>();
  for (const value of values) {
    byKey.set(stableStringify(value), value);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function findAnchorLine(source: string, needle: string): number {
  const index = source.split(/\r?\n/).findIndex((line) => line.includes(needle));
  assertCondition(index >= 0, `Unable to find anchor line containing "${needle}"`);
  return index + 1;
}

function fixtureLanguageFile(language: TraceFixtureLanguage): string {
  if (language === 'python') return 'solution.py';
  if (language === 'javascript') return 'solution.js';
  if (language === 'typescript') return 'solution.ts';
  if (language === 'java') return 'Solution.java';
  return 'solution.cpp';
}

async function runProcess(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

async function loadPythonRuntimeCore(): Promise<RuntimeCore> {
  const source = await readFile(PYTHON_RUNTIME_CORE_PATH, 'utf8');
  const selfObject: Record<string, unknown> = {};
  const context = vm.createContext({
    console,
    self: selfObject,
    globalThis: {},
  });

  vm.runInContext(source, context, { filename: 'runtime-core.js' });
  const runtime = selfObject.__TRACECODE_PYODIDE_RUNTIME__;
  assertCondition(Boolean(runtime) && typeof runtime === 'object', 'Unable to load Python runtime core');
  return runtime as RuntimeCore;
}

async function runPythonScript(script: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-runtime-trace-python-'));
  const scriptPath = join(tempDir, 'trace.py');
  await writeFile(scriptPath, script, 'utf8');

  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(`python3 exited with ${code}\n${stderr}`));
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface FixtureTraceRun {
  trace: RuntimeTrace;
  rawSummary: RuntimeRawEmissionSummary;
}

async function executePythonTrace(code: string, fixture: FixtureCase): Promise<FixtureTraceRun> {
  const runtime = await loadPythonRuntimeCore();
  const tracingPayload = runtime.generateTracingCode(
    {
      PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
      PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
      PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
      toPythonLiteral,
    },
    code,
    fixture.functionName,
    fixture.inputs,
    fixture.executionStyle,
    { maxTraceSteps: 1000, maxLineEvents: 2000 }
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
    'result': _serialize_output(_result),
    'console': _console_output,
    'lineEventCount': _total_line_events,
    'traceStepCount': len(_trace_events)
}))
`);
  const parsed = JSON.parse(stdout) as { runtimeTrace: RuntimeTrace; lineEventCount?: number; traceStepCount?: number };
  const events = Array.isArray(parsed.runtimeTrace.events) ? parsed.runtimeTrace.events : [];
  const trace: RuntimeTrace = {
    schemaVersion: parsed.runtimeTrace.schemaVersion,
    language: 'python',
    runId: `python:${fixture.id}`,
    events: events.map((event) => ({
      ...event,
      runId: `python:${fixture.id}`,
      file: 'solution.py',
    })),
    lineEventCount: events.filter((event) => event.kind === 'line').length,
    traceStepCount: parsed.runtimeTrace.traceStepCount ?? events.length,
  };
  const rawSummary = summarizeRuntimeTraceEmissions(trace);
  assertSupportedRawEmissions(rawSummary, `${fixture.id}:python`);
  return { trace, rawSummary };
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
  const context = vm.createContext({
    console,
    self: selfObject,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(workerSource, context, { filename: 'javascript-worker.js' });
  const onmessage = selfObject.onmessage;
  assertCondition(typeof onmessage === 'function', 'JavaScript worker did not register onmessage');
  assertCondition(ready, 'JavaScript worker did not emit worker-ready');

  async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    const responsePromise = new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response: ${type}`));
      }, 5000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId });
    });
    onmessage({ data: { id, type, payload } });
    return responsePromise;
  }

  return { sendMessage };
}

async function executeJavaScriptTrace(
  language: Extract<Language, 'javascript' | 'typescript'>,
  workerSource: string,
  code: string,
  fixture: FixtureCase
): Promise<FixtureTraceRun> {
  const harness = createJavaScriptWorkerHarness(workerSource);
  const init = await harness.sendMessage<{ success: boolean }>('init');
  assertCondition(init.success === true, `${language} worker init failed`);

  const result = await harness.sendMessage<ExecutionResult>('execute-with-tracing', {
    code,
    functionName: fixture.functionName,
    inputs: fixture.inputs,
    executionStyle: fixture.executionStyle,
    language,
    options: { maxTraceSteps: 1000, maxLineEvents: 2000 },
  });
  assertCondition(result.success === true, `${language} tracing failed: ${result.error ?? 'unknown error'}`);
  const rawSummary = summarizeRuntimeTraceEmissions(result.trace);
  assertSupportedRawEmissions(rawSummary, `${fixture.id}:${language}`);
  assertCondition(
    Array.isArray((result.trace as unknown as { events?: unknown[] }).events),
    `${fixture.id}:${language} worker trace must be native runtime trace`
  );
  return {
    trace: result.trace,
    rawSummary,
  };
}

function normalizeTopLevelPublicClasses(source: string): string {
  return source.replace(/(^|\n)\s*public\s+class\s+/g, '$1class ');
}

function createLocalJavaWorkerClient(): JavaWorkerClient {
  const stringFiles = new Map<string, string>();
  const rootPromise = mkdtemp(join(tmpdir(), 'tracecode-runtime-trace-java-'));

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
    helperJarPath: string,
    _compilerProfile: string,
    maxStoredEvents?: string
  ): Promise<string> {
    const root = await rootPromise;
    const source = stringFiles.get(sourcePath);
    if (source === undefined) {
      throw new Error(`Missing Java source for virtual path: ${sourcePath}`);
    }
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
        if (timer && typeof timer !== 'string' && typeof timer !== 'number') {
          activeWorkerTimers.delete(timer);
        }
        clearTimeout(timer);
      }) as typeof clearTimeout;
      const closeWorker = () => {
        for (const timer of activeWorkerTimers) {
          clearTimeout(timer);
        }
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
          harness: {
            browser: {
              JavaRewriteLibrary: { rewriteSource },
            },
          },
          tracecode: {
            browser: {
              BrowserCompileAndTraceLibrary: { compileAndTrace },
            },
          },
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
        if (typeof selfObject.onmessage !== 'function') {
          throw new Error('Java worker did not register onmessage');
        }
        selfObject.onmessage({
          data: {
            id: 'init',
            type: 'init',
            payload: undefined,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        selfObject.onmessage({
          data: {
            id: 'trace',
            type: 'execute-with-tracing',
            payload: { code, functionName, inputs, options, executionStyle },
          },
        });

        const startedAt = Date.now();
        while (!response && !errorResponse && Date.now() - startedAt < 60_000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
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
    executeCode: async () => {
      throw new Error('executeCode is not used by runtime trace fixtures');
    },
    executeCodeInterviewMode: async () => {
      throw new Error('executeCodeInterviewMode is not used by runtime trace fixtures');
    },
    terminate: () => {
      void rootPromise.then((root) => rm(root, { recursive: true, force: true }));
    },
  };

  return workerClient as unknown as JavaWorkerClient;
}

async function executeJavaTrace(code: string, fixture: FixtureCase): Promise<FixtureTraceRun> {
  const workerClient = createLocalJavaWorkerClient();
  try {
    const rawResult = await workerClient.executeWithTracing(
      code,
      fixture.functionName ?? '',
      fixture.inputs,
      { maxTraceSteps: 1000, maxLineEvents: 2000 },
      fixture.executionStyle as Parameters<JavaWorkerClient['executeWithTracing']>[4]
    );
    if (!rawResult.success) {
      throw new Error(`Java tracing failed for ${fixture.id}: ${rawResult.error ?? 'unknown error'}`);
    }
    const client = createJavaRuntimeClient({
      ...workerClient,
      executeWithTracing: async () => rawResult,
    } as JavaWorkerClient);
    const result = await client.executeWithTracing(
      code,
      fixture.functionName,
      fixture.inputs,
      { maxTraceSteps: 1000, maxLineEvents: 2000 },
      fixture.executionStyle
    );
    if (!result.success) {
      throw new Error(`Java tracing failed for ${fixture.id}: ${result.error ?? 'unknown error'}`);
    }
    const rawSummary = summarizeJavaRawEmissions(rawResult.events);
    assertSupportedRawEmissions(rawSummary, `${fixture.id}:java`);
    assertCondition(
      rawResult.events.every((event) => event.startsWith('trace:')),
      `${fixture.id}:java TraceHooks must emit native runtime trace events`
    );
    assertCondition(
      Array.isArray((result.trace as unknown as { events?: unknown[] }).events),
      `${fixture.id}:java public trace must be native runtime trace`
    );
    return {
      trace: result.trace,
      rawSummary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Java tracing failed for ${fixture.id}: ${message}`);
  } finally {
    workerClient.terminate();
  }
}

async function createCppWorkerHarness(): Promise<{
  executeWithTracing: (code: string, fixture: FixtureCase) => Promise<ExecutionResult>;
}> {
  const workerSource = await readFile(CPP_WORKER_PATH, 'utf8');
  const compilerBundle = await import(pathToFileURL(CPP_COMPILER_BUNDLE_PATH).href);
  const readAsset = async (url: string) => {
    const pathname = String(url).replace('file://', '');
    const data = await readFile(pathname);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      text: async () => data.toString('utf8'),
    };
  };
  const sandbox: Record<string, unknown> = {
    console,
    TextEncoder,
    TextDecoder,
    WebAssembly,
    Date,
    performance,
    Uint8Array,
    BigInt,
    Map,
    Set,
    Error,
    JSON,
    Object,
    String,
    Number,
    Math,
    RegExp,
    Promise,
    postMessage() {},
    fetch: readAsset,
    crypto: globalThis.crypto,
    __tracecodeCppCompilerBundle: compilerBundle,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const script = new vm.Script(
    `${workerSource}\nglobalThis.__tracecodeCppFixture = { handleInit, handleExecuteWithTracing };`,
    {
      importModuleDynamically(specifier) {
        return import(specifier);
      },
    }
  );
  await script.runInContext(context);
  const bridge = sandbox.__tracecodeCppFixture as {
    handleInit: (payload: unknown) => Promise<unknown>;
    handleExecuteWithTracing: (payload: unknown) => Promise<ExecutionResult>;
  } | undefined;
  assertCondition(Boolean(bridge), 'Unable to load C++ fixture worker bridge');

  await bridge!.handleInit({
    assets: {
      compilerBundleUrl: pathToFileURL(CPP_COMPILER_BUNDLE_PATH).href,
      clangWasmUrl: 'file:///missing/clang.wasm',
      lldWasmUrl: 'file:///missing/lld.wasm',
      sysrootUrl: 'file:///missing/sysroot.tar',
      runtimeHeaderUrl: pathToFileURL(CPP_RUNTIME_HEADER_PATH).href,
    },
  });

  return {
    executeWithTracing: async (code: string, fixture: FixtureCase) =>
      bridge!.handleExecuteWithTracing({
        code,
        functionName: fixture.functionName,
        inputs: fixture.inputs,
        executionStyle: fixture.executionStyle,
        options: { maxTraceSteps: 1000, maxLineEvents: 2000 },
      }),
  };
}

async function executeCppTrace(
  harness: Awaited<ReturnType<typeof createCppWorkerHarness>>,
  code: string,
  fixture: FixtureCase
): Promise<FixtureTraceRun> {
  const result = await harness.executeWithTracing(code, fixture);
  if (!result.success) {
    throw new Error(`C++ tracing failed for ${fixture.id}: ${result.error ?? 'unknown error'}`);
  }
  const rawSummary = summarizeRuntimeTraceEmissions(result.trace);
  assertSupportedRawEmissions(rawSummary, `${fixture.id}:cpp`);
  assertCondition(
    Array.isArray((result.trace as unknown as { events?: unknown[] }).events),
    `${fixture.id}:cpp worker trace must be native runtime trace`
  );
  return {
    trace: result.trace,
    rawSummary,
  };
}

function projectRoleSignature(
  trace: RuntimeTrace,
  roleLines: Record<string, number>
): Record<string, {
  eventKinds: RuntimeTraceEventKind[];
  variableSnapshots: string[];
  accessTargets: RuntimeTraceParityAccessTarget[];
}> {
  const byRole: Record<string, {
    eventKinds: RuntimeTraceEventKind[];
    variableSnapshots: string[];
    accessTargets: RuntimeTraceParityAccessTarget[];
  }> = {};

  for (const [role, line] of Object.entries(roleLines)) {
    const roleEvents = trace.events.filter((event) => event.line === line);
    byRole[role] = {
      eventKinds: sortedUnique(roleEvents.map((event) => event.kind)) as RuntimeTraceEventKind[],
      variableSnapshots: sortedUnique(roleEvents.flatMap((event) =>
        event.kind === 'snapshot' && 'variable' in event.target ? [event.target.variable] : []
      )),
      accessTargets: sortedUniqueAccessTargets(roleEvents.flatMap((event) => {
        if (
          (event.kind !== 'read' && event.kind !== 'write' && event.kind !== 'mutate') ||
          !('variable' in event.target)
        ) {
          return [];
        }
        const pathDepth =
          'path' in event.target && Array.isArray(event.target.path) ? event.target.path.length : undefined;
        return [{
          kind: event.kind,
          variable: event.target.variable,
          ...(pathDepth !== undefined ? { pathDepth } : {}),
        }];
      })),
    };
  }

  return byRole;
}

function assertNoUnsupportedVisualization(trace: RuntimeTrace, label: string): void {
  const serialized = stableStringify(trace.events);
  assertCondition(
    !serialized.includes('visualization') &&
      !serialized.includes('objectKinds') &&
      !serialized.includes('hashMaps') &&
      !serialized.includes('graph-adjacency') &&
      !serialized.includes('linked-list'),
    `${label} leaked visualization classification into runtime trace events`
  );
}

function assertOpaqueRefs(trace: RuntimeTrace, label: string): void {
  const serialized = stableStringify(trace.events);
  assertCondition(
    serialized.includes('__ref__'),
    `${label} did not emit opaque reference payloads`
  );
  assertCondition(
    !serialized.includes('<cycle>'),
    `${label} emitted legacy cycle placeholders instead of opaque references`
  );
}

function projectTraceSummary(trace: RuntimeTrace): {
  accessTargets: Array<RuntimeTraceParityAccessTarget & { count: number }>;
} {
  const counts = new Map<string, { target: RuntimeTraceParityAccessTarget & { count: number } }>();
  for (const event of trace.events) {
    if (
      (event.kind !== 'read' && event.kind !== 'write' && event.kind !== 'mutate') ||
      !('variable' in event.target)
    ) {
      continue;
    }
    const pathDepth =
      'path' in event.target && Array.isArray(event.target.path) ? event.target.path.length : undefined;
    const target: RuntimeTraceParityAccessTarget & { count: number } = {
      kind: event.kind,
      variable: event.target.variable,
      ...(pathDepth !== undefined ? { pathDepth } : {}),
      count: 0,
    };
    const key = stableStringify(target);
    const existing = counts.get(key) ?? { target };
    existing.target.count += 1;
    counts.set(key, existing);
  }
  return {
    accessTargets: [...counts.values()]
      .map((entry) => entry.target)
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
  };
}

async function runFixture(
  fixtureName: string,
  workerSource: string,
  cppHarness: Awaited<ReturnType<typeof createCppWorkerHarness>> | null
): Promise<void> {
  const fixtureDir = join(FIXTURES_DIR, fixtureName);
  const fixture = JSON.parse(await readFile(join(fixtureDir, 'case.json'), 'utf8')) as FixtureCase;
  const sources: Partial<Record<TraceFixtureLanguage, string>> = {
    python: await readFile(join(fixtureDir, 'solution.py'), 'utf8'),
    javascript: await readFile(join(fixtureDir, 'solution.js'), 'utf8'),
    typescript: await readFile(join(fixtureDir, 'solution.ts'), 'utf8'),
    java: await readFile(join(fixtureDir, 'Solution.java'), 'utf8'),
  };
  const cppSourcePath = join(fixtureDir, fixtureLanguageFile('cpp'));
  if (existsSync(cppSourcePath)) {
    sources.cpp = await readFile(cppSourcePath, 'utf8');
  }

  const runs: Partial<Record<TraceFixtureLanguage, FixtureTraceRun>> = {
    python: await executePythonTrace(sources.python!, fixture),
    javascript: await executeJavaScriptTrace('javascript', workerSource, sources.javascript!, fixture),
    typescript: await executeJavaScriptTrace('typescript', workerSource, sources.typescript!, fixture),
    java: await executeJavaTrace(sources.java!, fixture),
  };
  if (cppHarness && sources.cpp) {
    runs.cpp = await executeCppTrace(cppHarness, sources.cpp, fixture);
  }
  const traces = Object.fromEntries(
    Object.entries(runs).map(([language, run]) => [language, run!.trace])
  ) as Partial<Record<TraceFixtureLanguage, RuntimeTrace>>;
  const languages = Object.keys(traces) as TraceFixtureLanguage[];
  if (process.env.TRACECODE_DEBUG_RUNTIME_TRACE_FIXTURE === fixture.id) {
    for (const language of languages) {
      console.log(`DEBUG ${fixture.id}:${language}`);
      console.log(JSON.stringify(traces[language]!.events, null, 2));
    }
  }
  const rawParityMismatches = compareRawEmissionParity(
    runs.python!.rawSummary,
    [runs.python!, runs.javascript!, runs.typescript!, runs.java!].map((run) => run.rawSummary)
  );
  if (rawParityMismatches.length > 0 && process.env.TRACECODE_STRICT_RAW_EMISSION_PARITY === '1') {
    throw new Error(
      `${fixture.id}: raw runtime emission parity mismatch.\n${JSON.stringify(rawParityMismatches, null, 2)}`
    );
  }

  for (const language of languages) {
    const roleLines = Object.fromEntries(
      Object.entries(fixture.anchors)
        .filter(([, anchors]) => Boolean(anchors[language]))
        .map(([role, anchors]) => [
          role,
          findAnchorLine(sources[language]!, anchors[language]!),
        ])
    );
    const actual = projectRoleSignature(traces[language]!, roleLines);
    const expected = {
      ...fixture.expect,
      ...(fixture.expectByLanguage?.[language] ?? {}),
    };
    const expectedForLanguage = Object.fromEntries(
      Object.entries(expected).filter(([role]) => !fixture.knownGaps?.[language]?.[role])
    );
    const actualForLanguage = Object.fromEntries(
      Object.entries(actual).filter(([role]) => !fixture.knownGaps?.[language]?.[role])
    );
    assertCondition(
      stableStringify(stripRoleSignatureMethods(actualForLanguage)) === stableStringify(stripRoleSignatureMethods(expectedForLanguage)),
      `${fixture.id}: ${language} runtime trace fixture signature drifted.\nExpected: ${stableStringify(stripRoleSignatureMethods(expectedForLanguage))}\nReceived: ${stableStringify(stripRoleSignatureMethods(actualForLanguage))}`
    );
    const expectedSummary = {
      ...(fixture.expectSummary ?? {}),
      ...(fixture.expectSummaryByLanguage?.[language] ?? {}),
    };
    if (expectedSummary.accessTargets) {
      const actualSummary = projectTraceSummary(traces[language]);
      assertCondition(
        stableStringify(stripSummaryMethods(actualSummary).accessTargets) === stableStringify(stripSummaryMethods(expectedSummary).accessTargets),
        `${fixture.id}: ${language} runtime trace fixture summary drifted.\nExpected: ${stableStringify(stripSummaryMethods(expectedSummary).accessTargets)}\nReceived: ${stableStringify(stripSummaryMethods(actualSummary).accessTargets)}`
      );
    }
    assertNoUnsupportedVisualization(traces[language]!, `${fixture.id}:${language}`);
    if (fixture.expectOpaqueRefs) {
      assertOpaqueRefs(traces[language]!, `${fixture.id}:${language}`);
    }
  }
}

async function main(): Promise<void> {
  const workerSource = await readFile(JAVASCRIPT_WORKER_PATH, 'utf8');
  const cppHarness = existsSync(CPP_WORKER_PATH) && existsSync(CPP_COMPILER_BUNDLE_PATH)
    ? await createCppWorkerHarness()
    : null;
  const fixtureNames = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const fixtureName of fixtureNames) {
    await runFixture(fixtureName, workerSource, cppHarness);
  }
  console.log(`PASS: runtime trace fixture parity (${fixtureNames.length} fixtures)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
