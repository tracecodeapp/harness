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
const JAVA_SOURCE_AUGMENTATIONS_PATH = join(process.cwd(), 'workers', 'java', 'java-source-augmentations.js');
const JAVA_REWRITER_CLASSPATH = [
  join(process.cwd(), 'workers', 'vendor', 'java-rewriter.jar'),
  join(process.cwd(), 'workers', 'vendor', 'javaparser-core-3.25.10.jar'),
].join(':');
const JAVA_HELPER_JAR = join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar');
const CSHARP_ASSET_DIR = join(process.cwd(), 'workers', 'vendor', 'csharp');
const CPP_WORKER_PATH = join(process.cwd(), 'workers', 'cpp', 'cpp-worker.js');
const CPP_RUNTIME_HEADER_PATH = join(process.cwd(), 'workers', 'cpp', 'tracecode_runtime.hpp');
const CPP_COMPILER_BUNDLE_PATH = join(process.cwd(), 'node_modules', '@yowasp', 'clang', 'gen', 'bundle.js');
const JAVA_BIN_CANDIDATES = [
  process.env.TRACECODE_JAVA17_BIN,
  process.env.JAVA17_HOME ? join(process.env.JAVA17_HOME, 'bin', 'java') : undefined,
  '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home/bin/java',
  '/Users/obinnanwachukwu/Library/Java/JavaVirtualMachines/jbr-17.0.14/Contents/Home/bin/java',
  '/Library/Java/JavaVirtualMachines/temurin-25.jdk/Contents/Home/bin/java',
  'java',
].filter((candidate): candidate is string => Boolean(candidate));
const JAVA_BIN = JAVA_BIN_CANDIDATES.find((candidate) => candidate === 'java' || existsSync(candidate)) ?? 'java';

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
  languages?: Language[];
  inputs: Record<string, unknown>;
  anchors: Record<string, Record<Language, string>>;
  lineSequenceAnchors?: Record<string, Record<Language, string>>;
  expectLineSequence?: string[];
  expectLineSnapshots?: Array<{
    role: string;
    includes?: Record<string, unknown>;
    excludes?: string[];
  }>;
  expectLineSnapshotsByLanguage?: Partial<Record<Language, Array<{
    role: string;
    includes?: Record<string, unknown>;
    excludes?: string[];
  }>>>;
  expect: Record<string, {
    eventKinds: RuntimeTraceEventKind[];
    variableSnapshots: string[];
    accessTargets: RuntimeTraceParityAccessTarget[];
  }>;
  expectByLanguage?: Partial<Record<Language, Record<string, {
    eventKinds: RuntimeTraceEventKind[];
    variableSnapshots: string[];
    accessTargets: RuntimeTraceParityAccessTarget[];
  }>>>;
  expectSummary?: {
    accessTargets?: Array<RuntimeTraceParityAccessTarget & { count: number }>;
  };
  expectSummaryByLanguage?: Partial<Record<Language, {
    accessTargets?: Array<RuntimeTraceParityAccessTarget & { count: number }>;
  }>>;
  expectEventAssertions?: Record<string, RuntimeTraceEventAssertion[]>;
  expectEventAssertionsByLanguage?: Partial<Record<Language, Record<string, RuntimeTraceEventAssertion[]>>>;
  expectOpaqueRefs?: boolean;
  knownGaps?: Partial<Record<Language, Record<string, string>>>;
}

interface RuntimeTraceEventAssertion {
  kind: RuntimeTraceEventKind;
  variable?: string;
  pathDepth?: number;
  indexSources?: Array<string | null>;
  bindingVariable?: string;
  method?: string;
  args?: unknown[];
  value?: unknown;
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

const ALL_FIXTURE_LANGUAGES: Language[] = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'];
const RAW_PARITY_REFERENCE_LANGUAGES: Language[] = ['python', 'javascript', 'typescript', 'java'];
const RAW_PARITY_COMPARE_LANGUAGES: Language[] = [...RAW_PARITY_REFERENCE_LANGUAGES, 'csharp'];

function selectedFixtureNames(allFixtureNames: string[]): string[] {
  const rawFilter = process.env.TRACECODE_RUNTIME_TRACE_FIXTURE;
  if (!rawFilter) return allFixtureNames;
  const selected = new Set(rawFilter.split(',').map((entry) => entry.trim()).filter(Boolean));
  return allFixtureNames.filter((fixtureName) => selected.has(fixtureName));
}

function selectedFixtureLanguages(): Language[] {
  const rawFilter = process.env.TRACECODE_RUNTIME_TRACE_LANGUAGES;
  if (!rawFilter) return ALL_FIXTURE_LANGUAGES;
  const selected = rawFilter.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const language of selected) {
    assertCondition(
      ALL_FIXTURE_LANGUAGES.includes(language as Language),
      `Unsupported runtime trace fixture language filter: ${language}`
    );
  }
  return selected as Language[];
}

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

function fixtureLanguageFile(language: Language): string {
  if (language === 'python') return 'solution.py';
  if (language === 'javascript') return 'solution.js';
  if (language === 'typescript') return 'solution.ts';
  if (language === 'csharp') return 'solution.cs';
  if (language === 'cpp') return 'solution.cpp';
  return 'solution.java';
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

type CSharpExecute = (requestJson: string) => string;
let csharpExecutePromise: Promise<CSharpExecute> | null = null;

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
  return source.replace(/^([ \t]*)public\s+class\s+/gm, '$1class ');
}

function mapJavaVirtualInputPaths(root: string, source: string): string {
  const hostInputPrefix = join(root, 'str', 'tracecode-java-input').replaceAll('\\', '\\\\');
  return source.replaceAll('/str/tracecode-java-input', hostInputPrefix);
}

async function loadCSharpExecuteExport(): Promise<CSharpExecute> {
  if (csharpExecutePromise) return csharpExecutePromise;

  csharpExecutePromise = (async () => {
    const dotnetJsPath = join(CSHARP_ASSET_DIR, '_framework', 'dotnet.js');
    if (!existsSync(dotnetJsPath)) {
      throw new Error('Missing C# WASM assets. Run `pnpm run spike:csharp:publish` and sync workers/vendor/csharp.');
    }

    const { dotnet } = (await import(pathToFileURL(dotnetJsPath).href)) as {
      dotnet: {
        withApplicationArguments(...args: string[]): {
          create(): Promise<{
            getAssemblyExports(assemblyName: string): Promise<Record<string, unknown>>;
            getConfig(): { mainAssemblyName: string };
          }>;
        };
      };
    };

    const runtime = await dotnet.withApplicationArguments('runtime-trace-fixtures').create();
    const config = runtime.getConfig();
    const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
    const compilerHost = exports.TraceCode?.CSharpHost?.CompilerHost as { Execute?: unknown } | undefined;
    if (typeof compilerHost?.Execute !== 'function') {
      throw new Error('Unable to locate TraceCode.CSharpHost.CompilerHost.Execute export.');
    }
    return compilerHost.Execute as CSharpExecute;
  })();

  return csharpExecutePromise;
}

async function executeCSharpTrace(code: string, fixture: FixtureCase): Promise<FixtureTraceRun> {
  const execute = await loadCSharpExecuteExport();
  const raw = execute(JSON.stringify({
    source: code,
    functionName: fixture.functionName,
    inputs: fixture.inputs,
    executionStyle: fixture.executionStyle,
    trace: true,
    timeoutMs: 19_000,
    maxTraceSteps: 1000,
  }));
  const parsed = JSON.parse(raw) as {
    success: boolean;
    error?: string;
    events?: RuntimeTrace['events'];
    consoleOutput?: string[];
  };
  if (!parsed.success) {
    throw new Error(`C# tracing failed for ${fixture.id}: ${parsed.error ?? 'unknown error'}`);
  }

  const baseEvents = Array.isArray(parsed.events) ? parsed.events : [];
  const consoleOutput = parsed.consoleOutput ?? [];
  const events = [
    ...baseEvents,
    ...consoleOutput.map((text) => ({
      kind: 'stdout' as const,
      runId: 'csharp:run',
      file: 'solution.cs',
      text,
    })),
  ];
  const trace: RuntimeTrace = {
    schemaVersion: 'runtime-trace-2026-04-28',
    language: 'csharp',
    runId: `csharp:${fixture.id}`,
    events: events.map((event) => ({
      ...event,
      runId: `csharp:${fixture.id}`,
      file: 'solution.cs',
    })),
    lineEventCount: events.filter((event) => event.kind === 'line').length,
    traceStepCount: events.length,
  };
  const rawSummary = summarizeRuntimeTraceEmissions(trace);
  assertSupportedRawEmissions(rawSummary, `${fixture.id}:csharp`);
  return { trace, rawSummary };
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
    await writeFile(sourceFile, mapJavaVirtualInputPaths(root, source), 'utf8');
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
          const root = await rootPromise;
          const hostPath = join(root, path.replace(/^\/+/, ''));
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, source, 'utf8');
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
                file: 'solution.java',
              })
            : createEmptyRuntimeTrace('java', { runId: 'java:run', file: 'solution.java' }),
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
    } as unknown as JavaWorkerClient);
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

async function createCppWorkerHarness() {
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
    postMessage: () => {},
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
        return import(String(specifier));
      },
    }
  );
  await script.runInContext(context);
  const bridge = sandbox.__tracecodeCppFixture as {
    handleInit: (payload: unknown) => Promise<{ success: boolean; error?: string }>;
    handleExecuteWithTracing: (payload: unknown) => Promise<ExecutionResult>;
  };
  assertCondition(Boolean(bridge), 'C++ worker bridge did not initialize');
  const init = await bridge.handleInit({
    assets: {
      compilerBundleUrl: pathToFileURL(CPP_COMPILER_BUNDLE_PATH).href,
      clangWasmUrl: 'file:///missing/clang.wasm',
      lldWasmUrl: 'file:///missing/lld.wasm',
      sysrootUrl: 'file:///missing/sysroot.tar',
      runtimeHeaderUrl: pathToFileURL(CPP_RUNTIME_HEADER_PATH).href,
    },
  });
  assertCondition(init.success === true, `C++ worker init failed: ${init.error ?? 'unknown error'}`);
  return {
    executeWithTracing: (payload: unknown) => bridge.handleExecuteWithTracing(payload),
  };
}

type CppWorkerHarness = Awaited<ReturnType<typeof createCppWorkerHarness>>;

async function executeCppTrace(
  harness: CppWorkerHarness,
  code: string,
  fixture: FixtureCase
): Promise<FixtureTraceRun> {
  const result = await harness.executeWithTracing({
    code,
    functionName: fixture.functionName,
    inputs: fixture.inputs,
    executionStyle: fixture.executionStyle,
    options: { maxTraceSteps: 1000, maxLineEvents: 2000 },
  });
  assertCondition(result.success === true, `C++ tracing failed: ${result.error ?? 'unknown error'}`);
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

function projectLineSequence(trace: RuntimeTrace, roleLines: Record<string, number>): string[] {
  const rolesByLine = new Map<number, string[]>();
  for (const [role, line] of Object.entries(roleLines)) {
    const roles = rolesByLine.get(line) ?? [];
    roles.push(role);
    rolesByLine.set(line, roles);
  }
  for (const roles of rolesByLine.values()) {
    roles.sort((left, right) => left.localeCompare(right));
  }
  return trace.events.flatMap((event) => {
    if (event.kind !== 'line' || typeof event.line !== 'number') return [];
    return rolesByLine.get(event.line) ?? [];
  });
}

function projectLineSnapshotFrames(
  trace: RuntimeTrace,
  roleLines: Record<string, number>
): Array<{ role: string; snapshots: Record<string, unknown> }> {
  const rolesByLine = new Map<number, string[]>();
  for (const [role, line] of Object.entries(roleLines)) {
    const roles = rolesByLine.get(line) ?? [];
    roles.push(role);
    rolesByLine.set(line, roles);
  }
  for (const roles of rolesByLine.values()) {
    roles.sort((left, right) => left.localeCompare(right));
  }

  const frames: Array<{ role: string; snapshots: Record<string, unknown> }> = [];
  let activeFrames: Array<{ role: string; snapshots: Record<string, unknown> }> = [];
  for (const event of trace.events) {
    if (event.kind === 'line' && typeof event.line === 'number') {
      const roles = rolesByLine.get(event.line) ?? [];
      activeFrames = roles.map((role) => ({ role, snapshots: {} }));
      frames.push(...activeFrames);
      continue;
    }
    if (
      event.kind === 'snapshot' &&
      activeFrames.length > 0 &&
      'variable' in event.target
    ) {
      for (const frame of activeFrames) {
        frame.snapshots[event.target.variable] = event.value;
      }
    }
  }
  return frames;
}

function eventMatchesAssertion(event: RuntimeTrace['events'][number], assertion: RuntimeTraceEventAssertion): boolean {
  if (event.kind !== assertion.kind) return false;
  if (assertion.variable !== undefined) {
    if (!('target' in event) || !('variable' in event.target) || event.target.variable !== assertion.variable) {
      return false;
    }
  }
  if (assertion.pathDepth !== undefined) {
    if (!('target' in event) || !('path' in event.target) || !Array.isArray(event.target.path)) return false;
    if (event.target.path.length !== assertion.pathDepth) return false;
  }
  if (assertion.indexSources !== undefined) {
    if (!('target' in event) || !('path' in event.target) || !Array.isArray(event.target.indexSources)) return false;
    if (stableStringify(event.target.indexSources) !== stableStringify(assertion.indexSources)) return false;
  }
  if (assertion.bindingVariable !== undefined) {
    if (!('binding' in event) || event.binding?.kind !== 'iteration' || event.binding.variable !== assertion.bindingVariable) {
      return false;
    }
  }
  if (assertion.method !== undefined) {
    if (event.kind !== 'mutate' || event.method !== assertion.method) return false;
  }
  if (assertion.args !== undefined) {
    if (
      event.kind !== 'mutate' ||
      !Object.prototype.hasOwnProperty.call(event, 'args') ||
      stableStringify(event.args) !== stableStringify(assertion.args)
    ) {
      return false;
    }
  }
  if (assertion.value !== undefined) {
    if (!('value' in event) || stableStringify(event.value) !== stableStringify(assertion.value)) return false;
  }
  return true;
}

function assertRoleEventAssertions(
  trace: RuntimeTrace,
  roleLines: Record<string, number>,
  assertionsByRole: Record<string, RuntimeTraceEventAssertion[]>,
  label: string
): void {
  for (const [role, assertions] of Object.entries(assertionsByRole)) {
    const line = roleLines[role];
    assertCondition(
      typeof line === 'number' && line > 0,
      `${label}: event assertion role "${role}" does not have a resolved anchor line`
    );
    const roleEvents = trace.events.filter((event) => event.line === line);
    for (const assertion of assertions) {
      assertCondition(
        roleEvents.some((event) => eventMatchesAssertion(event, assertion)),
        `${label}: missing event assertion for role "${role}".\nExpected: ${stableStringify(assertion)}\nEvents: ${stableStringify(roleEvents)}`
      );
    }
  }
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
  cppHarness?: CppWorkerHarness
): Promise<void> {
  const fixtureDir = join(FIXTURES_DIR, fixtureName);
  const fixture = JSON.parse(await readFile(join(fixtureDir, 'case.json'), 'utf8')) as FixtureCase;
  const fixtureLanguages = fixture.languages ? new Set(fixture.languages) : null;
  const languages = selectedFixtureLanguages().filter((language) => !fixtureLanguages || fixtureLanguages.has(language));
  assertCondition(languages.length > 0, `${fixture.id}: no selected languages match fixture.languages`);
  const sources = {} as Partial<Record<Language, string>>;
  for (const language of languages) {
    const sourcePath = join(fixtureDir, fixtureLanguageFile(language));
    assertCondition(
      existsSync(sourcePath),
      `${fixture.id}: missing ${language} source file ${fixtureLanguageFile(language)}`
    );
    sources[language] = await readFile(sourcePath, 'utf8');
  }
  const runs = {} as Partial<Record<Language, FixtureTraceRun>>;
  for (const language of languages) {
    const source = sources[language];
    assertCondition(typeof source === 'string', `${fixture.id}: ${language} source was not loaded`);
    if (language === 'python') runs.python = await executePythonTrace(source, fixture);
    if (language === 'javascript') {
      runs.javascript = await executeJavaScriptTrace('javascript', workerSource, source, fixture);
    }
    if (language === 'typescript') {
      runs.typescript = await executeJavaScriptTrace('typescript', workerSource, source, fixture);
    }
    if (language === 'java') runs.java = await executeJavaTrace(source, fixture);
    if (language === 'csharp') runs.csharp = await executeCSharpTrace(source, fixture);
    if (language === 'cpp') {
      assertCondition(Boolean(cppHarness), `${fixture.id}: C++ harness was not initialized`);
      runs.cpp = await executeCppTrace(cppHarness as CppWorkerHarness, source, fixture);
    }
  }
  const traces = Object.fromEntries(
    Object.entries(runs).map(([language, run]) => [language, run.trace])
  ) as Partial<Record<Language, RuntimeTrace>>;
  if (process.env.TRACECODE_DEBUG_RUNTIME_TRACE_FIXTURE === fixture.id) {
    for (const language of Object.keys(traces) as Language[]) {
      console.log(`DEBUG ${fixture.id}:${language}`);
      console.log(JSON.stringify(traces[language]?.events, null, 2));
    }
  }
  const hasRawParityReferenceRuns = RAW_PARITY_REFERENCE_LANGUAGES.every((language) => runs[language]);
  if (hasRawParityReferenceRuns) {
    const completeRuns = runs as Record<Language, FixtureTraceRun>;
    const rawParityRuns = RAW_PARITY_COMPARE_LANGUAGES
      .filter((language) => completeRuns[language])
      .map((language) => completeRuns[language].rawSummary);
    const rawParityMismatches = compareRawEmissionParity(
      completeRuns.python.rawSummary,
      rawParityRuns
    );
    if (rawParityMismatches.length > 0 && process.env.TRACECODE_STRICT_RAW_EMISSION_PARITY === '1') {
      throw new Error(
        `${fixture.id}: raw runtime emission parity mismatch.\n${JSON.stringify(rawParityMismatches, null, 2)}`
      );
    }
  }

  for (const language of Object.keys(traces) as Language[]) {
    const trace = traces[language];
    assertCondition(Boolean(trace), `${fixture.id}: ${language} trace was not produced`);
    const roleLines = Object.fromEntries(
      Object.entries(fixture.anchors).map(([role, anchors]) => [
        role,
        findAnchorLine(sources[language] ?? '', anchors[language]),
      ])
    );
    const actual = projectRoleSignature(trace, roleLines);
    if (fixture.expectLineSequence) {
      const lineSequenceRoleLines = Object.fromEntries(
        Object.entries({
          ...fixture.anchors,
          ...(fixture.lineSequenceAnchors ?? {}),
        }).map(([role, anchors]) => [
          role,
          findAnchorLine(sources[language] ?? '', anchors[language]),
        ])
      );
      const actualLineSequence = projectLineSequence(trace, lineSequenceRoleLines);
      assertCondition(
        stableStringify(actualLineSequence) === stableStringify(fixture.expectLineSequence),
        `${fixture.id}: ${language} runtime trace line sequence drifted.\nExpected: ${stableStringify(fixture.expectLineSequence)}\nReceived: ${stableStringify(actualLineSequence)}`
      );
    }
    const expectedLineSnapshots = fixture.expectLineSnapshotsByLanguage?.[language] ?? fixture.expectLineSnapshots;
    if (expectedLineSnapshots) {
      const lineSequenceRoleLines = Object.fromEntries(
        Object.entries({
          ...fixture.anchors,
          ...(fixture.lineSequenceAnchors ?? {}),
        }).map(([role, anchors]) => [
          role,
          findAnchorLine(sources[language] ?? '', anchors[language]),
        ])
      );
      const actualLineFrames = projectLineSnapshotFrames(trace, lineSequenceRoleLines);
      assertCondition(
        actualLineFrames.length >= expectedLineSnapshots.length,
        `${fixture.id}: ${language} runtime trace line snapshot frame count drifted.\nExpected at least: ${expectedLineSnapshots.length}\nReceived: ${actualLineFrames.length}`
      );
      for (let index = 0; index < expectedLineSnapshots.length; index += 1) {
        const expectedFrame = expectedLineSnapshots[index];
        const actualFrame = actualLineFrames[index];
        assertCondition(
          actualFrame?.role === expectedFrame.role,
          `${fixture.id}: ${language} runtime trace line snapshot role drifted at frame ${index}.\nExpected: ${expectedFrame.role}\nReceived: ${actualFrame?.role ?? '<missing>'}`
        );
        for (const [name, expectedValue] of Object.entries(expectedFrame.includes ?? {})) {
          assertCondition(
            Object.prototype.hasOwnProperty.call(actualFrame.snapshots, name),
            `${fixture.id}: ${language} runtime trace line snapshot missing variable "${name}" at frame ${index} (${expectedFrame.role}).\nSnapshots: ${stableStringify(actualFrame.snapshots)}`
          );
          assertCondition(
            stableStringify(actualFrame.snapshots[name]) === stableStringify(expectedValue),
            `${fixture.id}: ${language} runtime trace line snapshot value drifted for "${name}" at frame ${index} (${expectedFrame.role}).\nExpected: ${stableStringify(expectedValue)}\nReceived: ${stableStringify(actualFrame.snapshots[name])}`
          );
        }
        for (const name of expectedFrame.excludes ?? []) {
          assertCondition(
            !Object.prototype.hasOwnProperty.call(actualFrame.snapshots, name),
            `${fixture.id}: ${language} runtime trace line snapshot unexpectedly included variable "${name}" at frame ${index} (${expectedFrame.role}).\nSnapshots: ${stableStringify(actualFrame.snapshots)}`
          );
        }
      }
    }
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
      const actualSummary = projectTraceSummary(trace);
      assertCondition(
        stableStringify(stripSummaryMethods(actualSummary).accessTargets) === stableStringify(stripSummaryMethods(expectedSummary).accessTargets),
        `${fixture.id}: ${language} runtime trace fixture summary drifted.\nExpected: ${stableStringify(stripSummaryMethods(expectedSummary).accessTargets)}\nReceived: ${stableStringify(stripSummaryMethods(actualSummary).accessTargets)}`
      );
    }
    const expectedEventAssertions = {
      ...(fixture.expectEventAssertions ?? {}),
      ...(fixture.expectEventAssertionsByLanguage?.[language] ?? {}),
    };
    if (Object.keys(expectedEventAssertions).length > 0) {
      assertRoleEventAssertions(
        trace,
        roleLines,
        expectedEventAssertions,
        `${fixture.id}:${language}`
      );
    }
    assertNoUnsupportedVisualization(trace, `${fixture.id}:${language}`);
    if (fixture.expectOpaqueRefs) {
      assertOpaqueRefs(trace, `${fixture.id}:${language}`);
    }
  }
}

async function main(): Promise<void> {
  const workerSource = await readFile(JAVASCRIPT_WORKER_PATH, 'utf8');
  const languages = selectedFixtureLanguages();
  const cppHarness = languages.includes('cpp') ? await createCppWorkerHarness() : undefined;
  const fixtureNames = selectedFixtureNames((await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort());

  for (const fixtureName of fixtureNames) {
    await runFixture(fixtureName, workerSource, cppHarness);
  }
  console.log(`PASS: runtime trace fixture parity (${fixtureNames.length} fixtures)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
