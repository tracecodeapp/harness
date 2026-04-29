#!/usr/bin/env npx tsx

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import type { Language, RuntimeExecutionStyle } from '../packages/harness-core/src/runtime-types';
import type { ExecutionResult, LegacyTraceExecutionResult, RawTraceStep } from '../packages/harness-core/src/types';
import { normalizeRuntimeTraceContract } from '../packages/harness-core/src/trace-contract';
import {
  createEmptyRuntimeV4Trace,
  runtimeTraceContractToV4Events,
  type RuntimeV4EventKind,
  type RuntimeV4ParityAccessTarget,
  type RuntimeV4Trace,
} from '../packages/harness-core/src/trace-v4';
import {
  assertSupportedRawEmissions,
  compareRawEmissionParity,
  summarizeJavaRawEmissions,
  summarizeRawTraceEmissions,
  summarizeRuntimeV4Emissions,
  type RuntimeRawEmissionSummary,
} from '../packages/harness-core/src/runtime-raw-emission-contract';
import { createJavaRuntimeClient } from '../packages/harness-browser/src/java-runtime-client';
import type {
  JavaWorkerClient,
  JavaWorkerRawTraceResult,
  JavaWorkerTraceResult,
} from '../packages/harness-browser/src/java-worker-client';
import { javaTraceHooksEventsToV4Trace } from '../packages/harness-core/src/trace-adapters/java';
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
const JAVA_SOURCE_AUGMENTATIONS_PATH = join(process.cwd(), 'workers', 'java', 'java-source-augmentations.cjs');
const JAVA_REWRITER_CLASSPATH = [
  join(process.cwd(), 'workers', 'vendor', 'java-practice-rewriter.jar'),
  join(process.cwd(), 'workers', 'vendor', 'javaparser-core-3.25.10.jar'),
].join(':');
const JAVA_HELPER_JAR = join(process.cwd(), 'workers', 'vendor', 'java-browser-spike-helper.jar');
const JAVA_BIN_CANDIDATES = [
  process.env.TRACECODE_JAVA17_BIN,
  process.env.JAVA17_HOME ? join(process.env.JAVA17_HOME, 'bin', 'java') : undefined,
  '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home/bin/java',
  '/Users/obinnanwachukwu/Library/Java/JavaVirtualMachines/jbr-17.0.14/Contents/Home/bin/java',
  '/Library/Java/JavaVirtualMachines/temurin-25.jdk/Contents/Home/bin/java',
  'java',
].filter((candidate): candidate is string => Boolean(candidate));
const JAVA_BIN = JAVA_BIN_CANDIDATES.find((candidate) => candidate === 'java' || existsSync(candidate)) ?? 'java';

// The fixture gate currently normalizes legacy runtime outputs into V4 so the
// target contract can be tested before the native V4 cutover is complete. This
// bridge must shrink over time; language runtimes should ultimately emit V4
// events directly instead of depending on post-hoc adapter coercion.

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
  anchors: Record<string, Record<Language, string>>;
  expect: Record<string, {
    eventKinds: RuntimeV4EventKind[];
    variableSnapshots: string[];
    accessTargets: RuntimeV4ParityAccessTarget[];
  }>;
  expectByLanguage?: Partial<Record<Language, Record<string, {
    eventKinds: RuntimeV4EventKind[];
    variableSnapshots: string[];
    accessTargets: RuntimeV4ParityAccessTarget[];
  }>>>;
  expectSummary?: {
    accessTargets?: Array<RuntimeV4ParityAccessTarget & { count: number }>;
  };
  expectSummaryByLanguage?: Partial<Record<Language, {
    accessTargets?: Array<RuntimeV4ParityAccessTarget & { count: number }>;
  }>>;
  knownGaps?: Partial<Record<Language, Record<string, string>>>;
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

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortedUniqueAccessTargets(
  values: RuntimeV4ParityAccessTarget[]
): RuntimeV4ParityAccessTarget[] {
  const byKey = new Map<string, RuntimeV4ParityAccessTarget>();
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

function fixtureLanguageFile(language: Language): string {
  if (language === 'python') return 'solution.py';
  if (language === 'javascript') return 'solution.js';
  if (language === 'typescript') return 'solution.ts';
  return 'Solution.java';
}

function makeExecutionResult(trace: RawTraceStep[]): LegacyTraceExecutionResult {
  return {
    success: true,
    output: null,
    trace,
    executionTimeMs: 0,
    consoleOutput: [],
    lineEventCount: trace.filter((step) => step.event === 'line').length,
    traceStepCount: trace.length,
  };
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
  const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-v4-python-'));
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
  trace: RuntimeV4Trace;
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
    'trace': _trace_data,
    'result': _serialize(_result),
    'console': _console_output,
    'lineEventCount': _total_line_events,
    'traceStepCount': len(_trace_data)
}))
`);
  const parsed = JSON.parse(stdout) as { trace: RawTraceStep[]; lineEventCount?: number; traceStepCount?: number };
  const result = {
    ...makeExecutionResult(parsed.trace),
    lineEventCount: parsed.lineEventCount,
    traceStepCount: parsed.traceStepCount,
  };
  const rawSummary = summarizeRawTraceEmissions('python', parsed.trace);
  assertSupportedRawEmissions(rawSummary, `${fixture.id}:python`);
  return {
    trace: runtimeTraceContractToV4Events(
      normalizeRuntimeTraceContract('python', result),
      { runId: `python:${fixture.id}`, file: 'solution.py' }
    ),
    rawSummary,
  };
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
  const rawSummary = summarizeRuntimeV4Emissions(result.trace);
  assertSupportedRawEmissions(rawSummary, `${fixture.id}:${language}`);
  assertCondition(
    Array.isArray((result.trace as unknown as { events?: unknown[] }).events),
    `${fixture.id}:${language} worker trace must be native V4`
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
  const rootPromise = mkdtemp(join(tmpdir(), 'tracecode-v4-java-'));

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
    await writeFile(inputPath, normalizeTopLevelPublicClasses(source), 'utf8');
    await runProcess(JAVA_BIN, [
      '-cp',
      JAVA_REWRITER_CLASSPATH,
      'spike.rewriter.GenericPracticeRewriter',
      inputPath,
      outputPath,
      executionStyle,
      entryName,
    ]);
    const rewrittenSource = await readFile(outputPath, 'utf8');
    const renamedExports = exportsSource.replace(/\bpublic class Exports\b/g, `public class ${exportsClassName}`);
    return `package ${packageName};\n\n${rewrittenSource.trim()}\n\n${renamedExports.trim()}\n`;
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
      'spike.browser.BrowserCompileAndTraceMain',
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
            if (String(url).endsWith('java-source-augmentations.cjs')) {
              vm.runInContext(augmentationSource, context, { filename: 'java-source-augmentations.cjs' });
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
          spike: {
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
            ? javaTraceHooksEventsToV4Trace(response.events, response.sourceText, {
                runId: 'java:run',
                file: 'Solution.java',
              })
            : createEmptyRuntimeV4Trace('java', { runId: 'java:run', file: 'Solution.java' }),
        };
      } finally {
        closeWorker();
      }
    },
    executeCode: async () => {
      throw new Error('executeCode is not used by V4 fixtures');
    },
    executeCodeInterviewMode: async () => {
      throw new Error('executeCodeInterviewMode is not used by V4 fixtures');
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
      rawResult.events.every((event) => event.startsWith('v4:')),
      `${fixture.id}:java TraceHooks must emit native V4 events`
    );
    assertCondition(
      Array.isArray((result.trace as unknown as { events?: unknown[] }).events),
      `${fixture.id}:java public trace must be native V4`
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

function projectRoleSignature(
  trace: RuntimeV4Trace,
  roleLines: Record<string, number>
): Record<string, {
  eventKinds: RuntimeV4EventKind[];
  variableSnapshots: string[];
  accessTargets: RuntimeV4ParityAccessTarget[];
}> {
  const byRole: Record<string, {
    eventKinds: RuntimeV4EventKind[];
    variableSnapshots: string[];
    accessTargets: RuntimeV4ParityAccessTarget[];
  }> = {};

  for (const [role, line] of Object.entries(roleLines)) {
    const roleEvents = trace.events.filter((event) => event.line === line);
    byRole[role] = {
      eventKinds: sortedUnique(roleEvents.map((event) => event.kind)) as RuntimeV4EventKind[],
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
          ...(event.kind === 'mutate' && event.method ? { method: event.method } : {}),
        }];
      })),
    };
  }

  return byRole;
}

function assertNoLegacyVisualization(trace: RuntimeV4Trace, label: string): void {
  const serialized = stableStringify(trace.events);
  assertCondition(
    !serialized.includes('visualization') &&
      !serialized.includes('objectKinds') &&
      !serialized.includes('hashMaps') &&
      !serialized.includes('graph-adjacency') &&
      !serialized.includes('linked-list'),
    `${label} leaked legacy visualization classification into V4 events`
  );
}

function projectTraceSummary(trace: RuntimeV4Trace): {
  accessTargets: Array<RuntimeV4ParityAccessTarget & { count: number }>;
} {
  const counts = new Map<string, { target: RuntimeV4ParityAccessTarget & { count: number } }>();
  for (const event of trace.events) {
    if (
      (event.kind !== 'read' && event.kind !== 'write' && event.kind !== 'mutate') ||
      !('variable' in event.target)
    ) {
      continue;
    }
    const pathDepth =
      'path' in event.target && Array.isArray(event.target.path) ? event.target.path.length : undefined;
    const target: RuntimeV4ParityAccessTarget & { count: number } = {
      kind: event.kind,
      variable: event.target.variable,
      ...(pathDepth !== undefined ? { pathDepth } : {}),
      ...(event.kind === 'mutate' && event.method ? { method: event.method } : {}),
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

async function runFixture(fixtureName: string, workerSource: string): Promise<void> {
  const fixtureDir = join(FIXTURES_DIR, fixtureName);
  const fixture = JSON.parse(await readFile(join(fixtureDir, 'case.json'), 'utf8')) as FixtureCase;
  const sources = {
    python: await readFile(join(fixtureDir, 'solution.py'), 'utf8'),
    javascript: await readFile(join(fixtureDir, 'solution.js'), 'utf8'),
    typescript: await readFile(join(fixtureDir, 'solution.ts'), 'utf8'),
    java: await readFile(join(fixtureDir, 'Solution.java'), 'utf8'),
  };

  const runs: Record<Language, FixtureTraceRun> = {
    python: await executePythonTrace(sources.python, fixture),
    javascript: await executeJavaScriptTrace('javascript', workerSource, sources.javascript, fixture),
    typescript: await executeJavaScriptTrace('typescript', workerSource, sources.typescript, fixture),
    java: await executeJavaTrace(sources.java, fixture),
  };
  const traces: Record<Language, RuntimeV4Trace> = {
    python: runs.python.trace,
    javascript: runs.javascript.trace,
    typescript: runs.typescript.trace,
    java: runs.java.trace,
  };
  if (process.env.TRACECODE_DEBUG_RUNTIME_V4_FIXTURE === fixture.id) {
    for (const language of Object.keys(traces) as Language[]) {
      console.log(`DEBUG ${fixture.id}:${language}`);
      console.log(JSON.stringify(traces[language].events, null, 2));
    }
  }
  const rawParityMismatches = compareRawEmissionParity(
    runs.python.rawSummary,
    [runs.python.rawSummary, runs.javascript.rawSummary, runs.typescript.rawSummary, runs.java.rawSummary]
  );
  if (rawParityMismatches.length > 0 && process.env.TRACECODE_STRICT_RAW_EMISSION_PARITY === '1') {
    throw new Error(
      `${fixture.id}: raw runtime emission parity mismatch.\n${JSON.stringify(rawParityMismatches, null, 2)}`
    );
  }

  for (const language of Object.keys(traces) as Language[]) {
    const roleLines = Object.fromEntries(
      Object.entries(fixture.anchors).map(([role, anchors]) => [
        role,
        findAnchorLine(sources[language], anchors[language]),
      ])
    );
    const actual = projectRoleSignature(traces[language], roleLines);
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
      stableStringify(actualForLanguage) === stableStringify(expectedForLanguage),
      `${fixture.id}: ${language} V4 fixture signature drifted.\nExpected: ${stableStringify(expectedForLanguage)}\nReceived: ${stableStringify(actualForLanguage)}`
    );
    const expectedSummary = {
      ...(fixture.expectSummary ?? {}),
      ...(fixture.expectSummaryByLanguage?.[language] ?? {}),
    };
    if (expectedSummary.accessTargets) {
      const actualSummary = projectTraceSummary(traces[language]);
      assertCondition(
        stableStringify(actualSummary.accessTargets) === stableStringify(expectedSummary.accessTargets),
        `${fixture.id}: ${language} V4 fixture summary drifted.\nExpected: ${stableStringify(expectedSummary.accessTargets)}\nReceived: ${stableStringify(actualSummary.accessTargets)}`
      );
    }
    assertNoLegacyVisualization(traces[language], `${fixture.id}:${language}`);
  }
}

async function main(): Promise<void> {
  const workerSource = await readFile(JAVASCRIPT_WORKER_PATH, 'utf8');
  const fixtureNames = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const fixtureName of fixtureNames) {
    await runFixture(fixtureName, workerSource);
  }
  console.log(`PASS: Runtime V4 fixture parity (${fixtureNames.length} fixtures)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
