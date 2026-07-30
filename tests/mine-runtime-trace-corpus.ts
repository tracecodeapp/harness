#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import type { Language, RuntimeExecutionStyle } from '../packages/harness-core/src/runtime-types';
import { createJavaRuntimeClient } from '../packages/harness-java/src/java-runtime-client';
import type {
  JavaWorkerClient,
  JavaWorkerRawTraceResult,
  JavaWorkerTraceResult,
} from '../packages/harness-java/src/java-worker-client';
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
import { liftCodeOutcome } from '../packages/harness-core/src/execution-outcome';

const DEFAULT_CORPUS_PATH = '/Users/obinnanwachukwu/Code/algoflow/tests/v3-corpus/tracecode-final300-slice.json';
const PYTHON_RUNTIME_CORE_PATH = join(process.cwd(), 'workers', 'python', 'runtime-core.js');
const JAVASCRIPT_WORKER_PATH = join(process.cwd(), 'workers', 'javascript', 'javascript-worker.js');
const CSHARP_ASSET_DIR = join(process.cwd(), 'workers', 'vendor', 'csharp');
const CSHARP_HOST_SOURCE_DIR = join(process.cwd(), 'runtimes', 'csharp', 'TraceCode.CSharpHost');
const CPP_WORKER_PATH = join(process.cwd(), 'workers', 'cpp', 'cpp-worker.js');
const CPP_RUNTIME_HEADER_PATH = join(process.cwd(), 'workers', 'cpp', 'tracecode_runtime.hpp');
const YOWASP_COMPILER_BUNDLE_PATH = join(process.cwd(), 'node_modules', '@yowasp', 'clang', 'gen', 'bundle.js');
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
const JAVAC_BIN = JAVA_BIN === 'java' ? 'javac' : join(dirname(dirname(JAVA_BIN)), 'bin', 'javac');

type MineLanguage = Extract<Language, 'python' | 'javascript' | 'typescript' | 'java' | 'csharp' | 'cpp'>;

interface CorpusEntry {
  slug: string;
  solutionId?: string;
  family?: string;
  compareMode?: string;
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
  executeCode: (
    deps: {
      PYTHON_CLASS_DEFINITIONS_SNIPPET: string;
      PYTHON_CONVERSION_HELPERS_SNIPPET: string;
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: string;
      PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: string;
      PYTHON_DEFAULT_IMPORT_PRELUDE?: string;
      INTERVIEW_GUARD_DEFAULTS: Record<string, number>;
      loadPyodideInstance: () => Promise<void>;
      getPyodide: () => { runPythonAsync: (code: string) => Promise<string> };
      toPythonLiteral: (value: unknown) => string;
    },
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ) => Promise<{ success: boolean; output?: unknown; error?: string; errorLine?: number; consoleOutput?: string[] }>;
}

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
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
  solutionId?: string;
  sourcePath?: string;
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

type DriftClassificationKind = 'fixture-worthy' | 'implementation-drift' | 'metric-sensitive';

interface ClassifiedDriftRecord extends DriftRecord {
  classification: DriftClassificationKind;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

interface DriftClassificationSummary {
  counts: Record<DriftClassificationKind, number>;
  byLanguage: Record<MineLanguage, Record<DriftClassificationKind, number>>;
  examples: Record<DriftClassificationKind, Array<{ slug: string; language: MineLanguage; evidence: string[] }>>;
}

interface DriftCluster {
  key: string;
  count: number;
  examples: Array<{ slug: string; language: MineLanguage }>;
}

interface OperationTokenCluster {
  token: string;
  direction: 'missing' | 'extra';
  count: number;
  examples: Array<{ slug: string; language: MineLanguage; comparedTo: MineLanguage | 'expectedOutput' }>;
}

interface FailureRecord {
  slug: string;
  solutionId?: string;
  sourcePath?: string;
  language: MineLanguage;
  error: string;
}

interface TemporalInvariantViolation {
  slug: string;
  language: MineLanguage;
  kind: 'body-local-leaked-to-control-header';
  variable: string;
  declarationLine: number;
  observedLine: number;
  headerLine?: number;
  evidence: string;
}

interface MineReport {
  corpusPath: string;
  sourceRoot: string;
  offset: number;
  limit: number;
  maxTraceSteps: number;
  maxLineEvents: number;
  maxSingleLineHits: number;
  referenceLanguage: MineLanguage;
  comparisonLanguages: MineLanguage[];
  compareRuntimeFacts: boolean;
  includeSignatureDiffs: boolean;
  maxReportDrifts: number;
  maxReportFailures: number;
  failOnFailure: boolean;
  groupsScanned: number;
  synthesizedJavaEntries: number;
  comparisons: number;
  driftCount: number;
  driftCountsByLanguage: Record<MineLanguage, number>;
  failureCount: number;
  hardFailureCount: number;
  driftClusters: DriftCluster[];
  operationTokenClusters: OperationTokenCluster[];
  classificationSummary: DriftClassificationSummary;
  reportedDriftCount: number;
  reportedFailureCount: number;
  temporalInvariantViolationCount: number;
  reportedTemporalInvariantViolationCount: number;
  temporalInvariantViolations: TemporalInvariantViolation[];
  drifts: Array<DriftRecord | ClassifiedDriftRecord>;
  failures: FailureRecord[];
  executionTimingMs?: Record<MineLanguage, number>;
  executionCounts?: Record<MineLanguage, number>;
  executionCacheHits?: number;
  executionCacheMisses?: number;
}

interface ExecutionCacheRecord {
  version: 1;
  key: string;
  status: 'success' | 'failure';
  language: MineLanguage;
  output?: unknown;
  error?: string;
  createdAt: string;
}

interface ExecutionCache {
  path: string | null;
  rows: Map<string, ExecutionCacheRecord>;
  hits: number;
  misses: number;
}

type CSharpExecute = (requestJson: string) => string;
let csharpExecutePromise: Promise<CSharpExecute> | null = null;
let csharpNativeHostPromise: Promise<{ dotnetBin: string; dllPath: string } | null> | null = null;

interface CppWorkerResult {
  success: boolean;
  output: unknown;
  error?: string;
  trace?: RuntimeTrace;
  lineEventCount?: number;
  traceStepCount?: number;
}

type CppWorkerHarness = {
  handleInit: (payload: unknown) => Promise<CppWorkerResult>;
  handleCompileRun: (payload: unknown) => Promise<CppWorkerResult>;
  handleExecuteWithTracing: (payload: unknown) => Promise<CppWorkerResult>;
  buildDriverSource: (source: string, functionName: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => string;
  buildOpsClassDriverSource: (source: string, className: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => string;
  buildScriptDriverSource: (source: string, options?: Record<string, unknown>) => string;
  parseProgramStdout: (stdout: string, options?: Record<string, unknown>) => { output: unknown; consoleOutput: string[] };
};

let cppHarnessPromise: Promise<CppWorkerHarness> | null = null;
let nativeCppCompilerPath: string | null | undefined;
let javaHelperPromise: Promise<JavaNativeHelpers> | null = null;
let javaInvokerPromise: Promise<{ root: string; classpath: string }> | null = null;

interface JavaNativeHelpers {
  normalizeJavaExecutionPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
  buildJavaCompileId: (payload: Record<string, unknown>, mode?: string) => string;
  dynamicInputEntriesForPayload: (payload: Record<string, unknown>, compileId: string) => Array<{ path: string; value: unknown }>;
  buildPlainRunnableSource: (payload: Record<string, unknown>, compileId: string, dynamicInputs: Array<{ path: string; value: unknown }>) => string;
  parseJavaReportOutput: (output?: string) => unknown;
  javaReportConsoleOutput: (report: Record<string, unknown>) => string[];
}

function parseStringFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseReferenceLanguage(): MineLanguage {
  const raw = parseStringFlag('reference-language') ?? 'python';
  if (raw === 'python' || raw === 'javascript' || raw === 'typescript' || raw === 'java' || raw === 'csharp' || raw === 'cpp') return raw;
  throw new Error(`Unsupported --reference-language=${raw}. Expected python, javascript, typescript, java, csharp, or cpp.`);
}

function parseMineLanguageListFlag(name: string, fallback: MineLanguage[]): MineLanguage[] {
  const raw = parseStringFlag(name);
  if (!raw) return fallback;
  const languages = raw.split(',').map((language) => language.trim()).filter(Boolean);
  const parsed: MineLanguage[] = [];
  for (const language of languages) {
    if (language === 'python' || language === 'javascript' || language === 'typescript' || language === 'java' || language === 'csharp' || language === 'cpp') {
      parsed.push(language);
    } else {
      throw new Error(`Unsupported --${name} entry ${language}. Expected python, javascript, typescript, java, csharp, or cpp.`);
    }
  }
  return [...new Set(parsed)];
}

function parseNumberFlag(name: string, fallback: number): number {
  const raw = parseStringFlag(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function tailString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.floor(maxLength / 2))}\n...[truncated ${value.length - maxLength} chars]...\n${value.slice(value.length - Math.ceil(maxLength / 2))}`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function isTraceBudgetFailure(error: string): boolean {
  return /Exceeded \d+ trace steps/.test(error) ||
    error.includes('trace limit exceeded') ||
    error.includes('trace step limit exceeded') ||
    error.includes('timeoutReason') && error.includes('trace-limit');
}

function stableStringify(value: unknown): string {
  value = normalizeOutputForComparison(value);
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',') + '}';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function executionCachePath(): string | null {
  const explicit = parseStringFlag('execution-cache') ?? parseStringFlag('execution-cache-path');
  if (explicit) return resolve(explicit);
  const dir = parseStringFlag('execution-cache-dir');
  return dir ? resolve(dir, 'execution-cache.jsonl') : null;
}

async function loadExecutionCache(): Promise<ExecutionCache> {
  const path = executionCachePath();
  const cache: ExecutionCache = { path, rows: new Map(), hits: 0, misses: 0 };
  if (!path || !existsSync(path)) return cache;
  const contents = await readFile(path, 'utf8');
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as ExecutionCacheRecord;
      if (row.version === 1 && typeof row.key === 'string') cache.rows.set(row.key, row);
    } catch {
      // A concurrent append can leave a partial line if a process is killed. Ignore it.
    }
  }
  return cache;
}

function executionCacheKey(entry: CorpusEntry, code: string): string {
  return sha256(stableStringify({
    version: 1,
    mode: hasFlag('no-trace') ? 'no-trace' : 'trace',
    language: entry.language,
    sourceSha256: sha256(code),
    functionName: entry.functionName,
    runtimeExecutionStyle: entry.runtimeExecutionStyle ?? 'solution-method',
    inputs: entry.inputs,
  }));
}

async function appendExecutionCache(cache: ExecutionCache, row: ExecutionCacheRecord): Promise<void> {
  cache.rows.set(row.key, row);
  if (!cache.path) return;
  await mkdir(dirname(cache.path), { recursive: true });
  await appendFile(cache.path, `${JSON.stringify(row)}\n`, 'utf8');
}

async function executeEntryWithCache(
  cache: ExecutionCache,
  pythonRuntime: RuntimeCore,
  workerSource: string,
  entry: CorpusEntry,
  code: string,
  maxTraceSteps: number,
  maxLineEvents: number,
  maxSingleLineHits: number
): Promise<TraceRun> {
  if (!hasFlag('no-trace')) {
    return executeEntry(pythonRuntime, workerSource, entry, code, maxTraceSteps, maxLineEvents, maxSingleLineHits);
  }
  const key = executionCacheKey(entry, code);
  const cached = cache.rows.get(key);
  if (cached) {
    cache.hits += 1;
    if (cached.status === 'failure') throw new Error(cached.error ?? 'cached execution failure');
    return emptyTraceRun(cached.language, entry, cached.output);
  }
  cache.misses += 1;
  try {
    const run = await executeEntry(pythonRuntime, workerSource, entry, code, maxTraceSteps, maxLineEvents, maxSingleLineHits);
    await appendExecutionCache(cache, {
      version: 1,
      key,
      status: 'success',
      language: entry.language,
      output: run.output,
      createdAt: new Date().toISOString(),
    });
    return run;
  } catch (error) {
    await appendExecutionCache(cache, {
      version: 1,
      key,
      status: 'failure',
      language: entry.language,
      error: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
    });
    throw error;
  }
}

function collectDeclaredVariables(language: MineLanguage, sourceLine: string): string[] {
  if (language === 'python') return [];
  const declarations: string[] = [];
  if (language === 'javascript' || language === 'typescript') {
    const declarationPattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
    for (const match of sourceLine.matchAll(declarationPattern)) {
      if (match[1]) declarations.push(match[1]);
    }
    return declarations;
  }

  const skipped = new Set(['class', 'interface', 'enum', 'record', 'return', 'new']);
  const declarationPattern =
    /\b(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?==)/g;
  for (const match of sourceLine.matchAll(declarationPattern)) {
    const typeSource = match[1] ?? '';
    const name = match[2];
    if (!name || skipped.has(name) || name.startsWith('__tracecode')) continue;
    if (typeSource.includes('[')) continue;
    declarations.push(name);
  }
  return declarations;
}

function buildControlBodyFirstLineMap(sourceText: string): Map<number, number> {
  const lines = sourceText.split(/\r?\n/);
  const bodyLineToHeaderLine = new Map<number, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\b(?:for|while|if|else\s+if)\s*\(/.test(line) || !line.includes('{')) continue;
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const trimmed = lines[bodyIndex].trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('}')) break;
      bodyLineToHeaderLine.set(bodyIndex + 1, index + 1);
      break;
    }
  }
  return bodyLineToHeaderLine;
}

function projectSnapshotFrames(trace: RuntimeTrace): Array<{ line: number; snapshots: Record<string, unknown> }> {
  const frames: Array<{ line: number; snapshots: Record<string, unknown> }> = [];
  let activeFrame: { line: number; snapshots: Record<string, unknown> } | null = null;
  for (const event of trace.events) {
    if (event.kind === 'line' && typeof event.line === 'number') {
      activeFrame = { line: event.line, snapshots: {} };
      frames.push(activeFrame);
      continue;
    }
    if (activeFrame && event.kind === 'snapshot' && 'variable' in event.target) {
      activeFrame.snapshots[event.target.variable] = event.value;
    }
  }
  return frames;
}

function auditTemporalInvariants(entry: CorpusEntry, sourceText: string, trace: RuntimeTrace): TemporalInvariantViolation[] {
  if (entry.language === 'python') return [];
  const lines = sourceText.split(/\r?\n/);
  const frames = projectSnapshotFrames(trace);
  const violations: TemporalInvariantViolation[] = [];
  const bodyLineToHeaderLine = buildControlBodyFirstLineMap(sourceText);
  const declarations = new Map<number, string[]>();
  const seenViolations = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const names = collectDeclaredVariables(entry.language, lines[index]);
    if (names.length === 0) continue;
    declarations.set(lineNumber, names);
  }

  for (const [declarationLine, names] of declarations) {
    const headerLine = bodyLineToHeaderLine.get(declarationLine);
    if (headerLine === undefined) continue;
    for (let index = 0; index < frames.length - 1; index += 1) {
      const headerFrame = frames[index];
      const nextFrame = frames[index + 1];
      if (headerFrame.line !== headerLine || nextFrame.line !== declarationLine) continue;
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(headerFrame.snapshots, name)) {
          const key = `${entry.slug}:${entry.language}:${name}:${headerLine}:${declarationLine}`;
          if (seenViolations.has(key)) continue;
          seenViolations.add(key);
          violations.push({
            slug: entry.slug,
            language: entry.language,
            kind: 'body-local-leaked-to-control-header',
            variable: name,
            declarationLine,
            observedLine: headerLine,
            headerLine,
            evidence: `variable "${name}" declared on line ${declarationLine} was present on preceding control header line ${headerLine}`,
          });
        }
      }
    }
  }

  return violations;
}

function recursivelySortArrays(value: unknown): unknown {
  const normalized = normalizeOutputForComparison(value);
  if (Array.isArray(normalized)) {
    return normalized
      .map((item) => recursivelySortArrays(item))
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  }
  if (normalized === null || typeof normalized !== 'object') return normalized;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(normalized as Record<string, unknown>).sort((left, right) => left.localeCompare(right))) {
    output[key] = recursivelySortArrays((normalized as Record<string, unknown>)[key]);
  }
  return output;
}

function outputComparisonKey(value: unknown, compareMode?: string): string {
  if (
    hasFlag('loose-any-valid-output') &&
    (compareMode === 'any-valid' || compareMode === 'unordered-array')
  ) {
    return stableStringify(recursivelySortArrays(value));
  }
  return stableStringify(value);
}

function outputsEqual(left: unknown, right: unknown, compareMode?: string): boolean {
  return outputComparisonKey(left, compareMode) === outputComparisonKey(right, compareMode);
}

function entryExpectedOutputMatches(entry: CorpusEntry, received: unknown): boolean {
  // Native harness case.passed uses runtime deep equality. Corpus mining must
  // keep the compareMode-aware validator because some corpus outputs allow
  // looser matching, such as unordered or any-valid outputs.
  return outputsEqual(entry.expectedOutput, received, entry.compareMode);
}

function collectSerializedRefs(value: unknown, refs: Map<string, Record<string, unknown>>, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return;
  const objectValue = value as object;
  if (seen.has(objectValue)) return;
  seen.add(objectValue);
  if (Array.isArray(value)) {
    for (const item of value) collectSerializedRefs(item, refs, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.__id__ === 'string' && record.__id__.length > 0) {
    refs.set(record.__id__, record);
  }
  for (const child of Object.values(record)) {
    collectSerializedRefs(child, refs, seen);
  }
}

function normalizeOutputForComparison(
  value: unknown,
  refs?: Map<string, Record<string, unknown>>,
  resolving = new Set<string>()
): unknown {
  if (!refs) {
    const collected = new Map<string, Record<string, unknown>>();
    collectSerializedRefs(value, collected);
    return normalizeOutputForComparison(value, collected);
  }
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => normalizeOutputForComparison(item, refs, resolving));
  const input = value as Record<string, unknown>;
  if (typeof input.__ref__ === 'string' && Object.keys(input).length === 1) {
    if (resolving.has(input.__ref__)) return { __ref__: input.__ref__ };
    const target = refs.get(input.__ref__);
    if (!target) return null;
    resolving.add(input.__ref__);
    const normalized = normalizeOutputForComparison(target, refs, resolving);
    resolving.delete(input.__ref__);
    return normalized;
  }
  const output: Record<string, unknown> = {};
  const looksLikeListNode = ('next' in input) && ('val' in input || 'value' in input);
  const looksLikeTreeNode = ('left' in input || 'right' in input) && ('val' in input || 'value' in input);
  const explicitType = typeof input.__type__ === 'string' && input.__type__ !== 'object' ? input.__type__ : undefined;
  if (looksLikeListNode) output.__type__ = 'ListNode';
  else if (looksLikeTreeNode) output.__type__ = 'TreeNode';
  else if (explicitType) output.__type__ = explicitType;
  for (const [key, child] of Object.entries(input)) {
    if (key === '__id__' || key === '__class__') continue;
    if (key === '__type__') continue;
    if (key === 'value' && (looksLikeListNode || looksLikeTreeNode) && 'val' in input) continue;
    output[key] = normalizeOutputForComparison(child, refs, resolving);
  }
  return output;
}

function normalizeOutputForReport(value: unknown): unknown {
  return normalizeOutputForComparison(value);
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
  return `${event.kind}:${event.target.variable}:path${pathDepth}`;
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
    const maxOutputChars = parseNumberFlag('max-process-output-chars', 16_000_000);
    let truncatedStdout = false;
    let truncatedStderr = false;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxOutputChars) {
        stdout += String(chunk).slice(0, maxOutputChars - stdout.length);
      } else {
        truncatedStdout = true;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxOutputChars) {
        stderr += String(chunk).slice(0, maxOutputChars - stderr.length);
      } else {
        truncatedStderr = true;
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (truncatedStdout) stdout += '\n[stdout truncated by runtime trace miner]';
      if (truncatedStderr) stderr += '\n[stderr truncated by runtime trace miner]';
      if (truncatedStdout || truncatedStderr) {
        reject(new Error(`${command} process output exceeded ${maxOutputChars} chars`));
        return;
      }
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`));
    });
    child.stdin.end(input ?? '');
  });
}

async function runProcessResult(
  command: string,
  args: string[],
  input?: string,
  timeoutMs = 20_000
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2_000).unref();
    }, timeoutMs);
    timeoutId.unref();
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(input ?? '');
  });
}

async function resolveNativeCppCompiler(): Promise<string | null> {
  if (nativeCppCompilerPath !== undefined) return nativeCppCompilerPath;
  const explicit = parseStringFlag('cpp-compiler');
  const candidates = explicit ? [explicit] : ['clang++', 'g++'];
  for (const candidate of candidates) {
    try {
      const result = await runProcessResult('sh', ['-lc', `command -v ${candidate}`], undefined, 5_000);
      const path = result.stdout.trim().split(/\r?\n/)[0];
      if (result.code === 0 && path) {
        nativeCppCompilerPath = path;
        return path;
      }
    } catch {
      // Try the next candidate.
    }
  }
  nativeCppCompilerPath = null;
  return null;
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

function emptyTraceRun(language: MineLanguage, entry: CorpusEntry, output: unknown): TraceRun {
  const trace = createEmptyRuntimeTrace(language, { runId: `mine:${entry.slug}:${language}`, file: entry.source.path });
  return { language, output, trace, signature: buildMineSignature(trace) };
}

async function executePythonCode(
  runtime: RuntimeCore,
  entry: CorpusEntry,
  code: string
): Promise<TraceRun> {
  const result = await runtime.executeCode(
    {
      PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
      PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
      PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
      INTERVIEW_GUARD_DEFAULTS: {
        maxLineEvents: 20_000,
        maxSingleLineHits: 10_000,
        maxCallDepth: 1_000,
        maxMemoryBytes: 256 * 1024 * 1024,
        memoryCheckEvery: 100,
      },
      loadPyodideInstance: async () => {},
      getPyodide: () => ({
        runPythonAsync: async (script: string) => {
          const runnable = script.replace('import string\n', 'import string\nfrom typing import *\nfrom math import *\nfrom copy import *\nfrom re import *\n').replace(
            /\njson\.dumps\(\{\n    "output": _serialize\(_result\),\n    "console": _console_output,\n\}\)\n?$/,
            '\n_tracecode_result_json = json.dumps({\n    "output": _serialize(_result),\n    "console": _console_output,\n})\nprint(_tracecode_result_json)\n'
          );
          return (await runPythonScript(runnable)).trim();
        },
      }),
      toPythonLiteral,
    },
    code,
    entry.functionName,
    entry.inputs,
    entry.runtimeExecutionStyle ?? 'function'
  );
  if (!result.success) throw new Error(`python execution failed: ${result.error ?? 'unknown error'}`);
  return emptyTraceRun('python', entry, result.output);
}

async function executePythonTrace(
  runtime: RuntimeCore,
  entry: CorpusEntry,
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
    'result': _serialize_output(_result),
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
  const pending = new Map<
    string,
    { protocolToken: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();
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
      if (message.protocolToken !== entry.protocolToken) return;
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
    const protocolToken = `javascript-mine-token-${id}`;
    const responsePromise = new Promise<T>((resolvePromise, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response: ${type}`));
      }, 60_000);
      pending.set(id, { protocolToken, resolve: resolvePromise as (value: unknown) => void, reject, timeoutId });
    });
    onmessage!({ data: { id, type, payload, protocolToken } });
    return responsePromise;
  }

  return { sendMessage };
}

async function executeJavaScriptTrace(
  workerSource: string,
  entry: CorpusEntry,
  code: string,
  maxTraceSteps: number,
  maxLineEvents: number,
  maxSingleLineHits: number
): Promise<TraceRun> {
  const harness = createJavaScriptWorkerHarness(workerSource);
  const init = await harness.sendMessage<{ success: boolean }>('init');
  if (init.success !== true) throw new Error(`${entry.language} worker init failed`);
  const result = await harness.sendMessage<{ success: boolean; output?: unknown; error?: string; trace: RuntimeTrace }>('execute-with-tracing', {
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

async function executeJavaScriptCode(
  workerSource: string,
  entry: CorpusEntry,
  code: string
): Promise<TraceRun> {
  const harness = createJavaScriptWorkerHarness(workerSource);
  const init = await harness.sendMessage<{ success: boolean }>('init');
  if (init.success !== true) throw new Error(`${entry.language} worker init failed`);
  const result = await harness.sendMessage<{ success: boolean; output?: unknown; error?: string }>('execute-code', {
    code,
    functionName: entry.functionName,
    inputs: entry.inputs,
    executionStyle: entry.runtimeExecutionStyle ?? 'function',
    language: entry.language,
  });
  if (!result.success) throw new Error(`${entry.language} execution failed: ${result.error ?? 'unknown error'}`);
  return emptyTraceRun(entry.language, entry, result.output);
}

async function loadCSharpExecuteExport(): Promise<CSharpExecute> {
  if (csharpExecutePromise) return csharpExecutePromise;

  csharpExecutePromise = (async () => {
    const dotnetJsPath = join(CSHARP_ASSET_DIR, '_framework', 'dotnet.js');
    if (!existsSync(dotnetJsPath)) {
      throw new Error('Missing C# WASM assets. Run `pnpm update:csharp-runtime` and sync workers/vendor/csharp.');
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

    const runtime = await dotnet.withApplicationArguments('runtime-trace-corpus-mine').create();
    const config = runtime.getConfig();
    const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
    const compilerHost = (exports as { TraceCode?: { CSharpHost?: { CompilerHost?: unknown } } }).TraceCode?.CSharpHost?.CompilerHost as { Execute?: unknown } | undefined;
    if (typeof compilerHost?.Execute !== 'function') {
      throw new Error('Unable to locate TraceCode.CSharpHost.CompilerHost.Execute export.');
    }
    return compilerHost.Execute as CSharpExecute;
  })();

  return csharpExecutePromise;
}

async function executeCSharpTrace(
  entry: CorpusEntry,
  code: string,
  maxTraceSteps: number
): Promise<TraceRun> {
  const execute = await loadCSharpExecuteExport();
  const raw = execute(JSON.stringify({
    source: code,
    functionName: entry.functionName,
    inputs: entry.inputs,
    executionStyle: entry.runtimeExecutionStyle ?? 'solution-method',
    trace: true,
    timeoutMs: 19_000,
    maxTraceSteps,
  }));
  const parsed = JSON.parse(raw) as {
    success: boolean;
    output?: unknown;
    error?: string;
    events?: RuntimeTraceEvent[];
    consoleOutput?: string[];
    executionTimeMs?: number;
    traceLimitExceeded?: boolean;
    timeoutReason?: string;
  };
  if (!parsed.success) {
    throw new Error(`csharp tracing failed: ${parsed.error ?? 'unknown error'}`);
  }

  const baseEvents = Array.isArray(parsed.events) ? parsed.events : [];
  const consoleOutput = parsed.consoleOutput ?? [];
  const runId = `mine:${entry.slug}:csharp`;
  const events: RuntimeTraceEvent[] = [
    ...baseEvents,
    ...consoleOutput.map((text): RuntimeTraceEvent => ({
      kind: 'stdout',
      runId,
      file: entry.source.path,
      text,
    })),
  ];
  const trace: RuntimeTrace = {
    schemaVersion: 'runtime-trace-2026-04-28',
    language: 'csharp',
    runId,
    events: events.map((event) => ({
      ...event,
      runId,
      file: entry.source.path,
    })),
    lineEventCount: events.filter((event) => event.kind === 'line').length,
    traceStepCount: events.length,
  };
  return { language: 'csharp', output: parsed.output, trace, signature: buildMineSignature(trace) };
}

async function executeCSharpCode(
  entry: CorpusEntry,
  code: string
): Promise<TraceRun> {
  if ((parseStringFlag('csharp-runner') ?? 'native') === 'native') {
    const nativeRun = await executeCSharpCodeNative(entry, code);
    if (nativeRun) return nativeRun;
  }
  const execute = await loadCSharpExecuteExport();
  const raw = execute(JSON.stringify({
    source: code,
    functionName: entry.functionName,
    inputs: entry.inputs,
    executionStyle: entry.runtimeExecutionStyle ?? 'solution-method',
    trace: false,
    timeoutMs: 19_000,
  }));
  const parsed = JSON.parse(raw) as {
    success: boolean;
    output?: unknown;
    error?: string;
  };
  if (!parsed.success) {
    throw new Error(`csharp execution failed: ${parsed.error ?? 'unknown error'}`);
  }
  return emptyTraceRun('csharp', entry, parsed.output);
}

async function resolveDotnet10(): Promise<string | null> {
  const explicit = parseStringFlag('dotnet-bin') ?? process.env.DOTNET_10_BIN;
  const candidates = explicit ? [explicit] : ['/root/.dotnet/dotnet', 'dotnet'];
  for (const candidate of candidates) {
    try {
      const result = await runProcessResult(candidate, ['--version'], undefined, 10_000);
      if (result.code === 0 && result.stdout.trim().startsWith('10.')) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function ensureCSharpNativeHost(): Promise<{ dotnetBin: string; dllPath: string } | null> {
  if (csharpNativeHostPromise) return csharpNativeHostPromise;
  csharpNativeHostPromise = (async () => {
    const dotnetBin = await resolveDotnet10();
    if (!dotnetBin || !existsSync(CSHARP_HOST_SOURCE_DIR)) return null;
    const explicitHost = parseStringFlag('csharp-native-host') ?? process.env.TRACECODE_CSHARP_NATIVE_HOST;
    const defaultHost = '/tmp/tracecode-csharp-native-host/bin/Release/net10.0/TraceCode.CSharpNativeHost.dll';
    const reusableHost = explicitHost && existsSync(explicitHost)
      ? explicitHost
      : existsSync(defaultHost)
        ? defaultHost
        : null;
    if (reusableHost) return { dotnetBin, dllPath: reusableHost };
    const root = await mkdtemp(join(tmpdir(), 'tracecode-csharp-native-host-'));
    for (const file of await readdir(CSHARP_HOST_SOURCE_DIR)) {
      if (file.endsWith('.cs')) {
        await copyFile(join(CSHARP_HOST_SOURCE_DIR, file), join(root, file));
      }
    }
    const projectPath = join(root, 'TraceCode.CSharpNativeHost.csproj');
    await writeFile(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.3.0" />
  </ItemGroup>
</Project>
`, 'utf8');
    await writeFile(join(root, 'Program.cs'), `using TraceCode.CSharpHost;

string request = Console.In.ReadToEnd();
Console.Write(CompilerHost.Execute(request));
`, 'utf8');
    await runProcess(dotnetBin, ['restore', projectPath, '--force', '--no-cache'], undefined);
    await runProcess(dotnetBin, ['build', projectPath, '-c', 'Release', '--no-restore'], undefined);
    const dllPath = join(root, 'bin', 'Release', 'net10.0', 'TraceCode.CSharpNativeHost.dll');
    if (!existsSync(dllPath)) throw new Error('C# native host build did not produce a dll');
    return { dotnetBin, dllPath };
  })();
  return csharpNativeHostPromise;
}

async function executeCSharpCodeNative(
  entry: CorpusEntry,
  code: string
): Promise<TraceRun | null> {
  const host = await ensureCSharpNativeHost();
  if (!host) return null;
  const request = JSON.stringify({
    source: code,
    functionName: entry.functionName,
    inputs: entry.inputs,
    executionStyle: entry.runtimeExecutionStyle ?? 'solution-method',
    trace: false,
    timeoutMs: 19_000,
  });
  const result = await runProcessResult(
    host.dotnetBin,
    [host.dllPath],
    request,
    parseNumberFlag('csharp-native-timeout-ms', 30_000)
  );
  if (result.code !== 0) {
    throw new Error(`csharp native host failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  const parsed = JSON.parse(result.stdout) as {
    success: boolean;
    output?: unknown;
    error?: string;
  };
  if (!parsed.success) {
    throw new Error(`csharp execution failed: ${parsed.error ?? 'unknown error'}`);
  }
  return emptyTraceRun('csharp', entry, parsed.output);
}

async function createCppWorkerHarness(): Promise<CppWorkerHarness> {
  if (cppHarnessPromise) return cppHarnessPromise;

  cppHarnessPromise = (async () => {
    const workerSource = await readFile(CPP_WORKER_PATH, 'utf8');
    const compilerBundle = await import(pathToFileURL(YOWASP_COMPILER_BUNDLE_PATH).href);
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
      globalThis: null,
      self: null,
      postMessage() {},
      fetch: readAsset,
      crypto: globalThis.crypto,
      __tracecodeCppCompilerBundle: compilerBundle,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    const context = vm.createContext(sandbox);
    const script = new vm.Script(
      workerSource + '\nglobalThis.__tracecodeCppMine = { handleInit, handleCompileRun, handleExecuteWithTracing, buildDriverSource, buildOpsClassDriverSource, buildScriptDriverSource, parseProgramStdout };',
      {
        importModuleDynamically(specifier) {
          return import(specifier);
        },
      }
    );
    await script.runInContext(context);
    const api = sandbox.__tracecodeCppMine as CppWorkerHarness | undefined;
    if (!api) throw new Error('Unable to load C++ worker harness');

    const init = await api.handleInit({
      assets: {
        compilerBundleUrl: pathToFileURL(YOWASP_COMPILER_BUNDLE_PATH).href,
        compilerWasmUrl: 'file:///missing/clang.wasm',
        linkerWasmUrl: 'file:///missing/lld.wasm',
        sysrootUrl: 'file:///missing/sysroot.tar',
        runtimeHeaderUrl: pathToFileURL(CPP_RUNTIME_HEADER_PATH).href,
      },
    });
    if (!init.success) throw new Error(`cpp worker init failed: ${init.error ?? 'unknown error'}`);
    return api;
  })();

  return cppHarnessPromise;
}

async function executeCppTrace(
  entry: CorpusEntry,
  code: string,
  maxStoredEvents: number
): Promise<TraceRun> {
  const api = await createCppWorkerHarness();
  const payload = {
    code,
    functionName: entry.functionName,
    inputs: entry.inputs,
    executionStyle: entry.runtimeExecutionStyle ?? 'solution-method',
    options: { maxStoredEvents },
  };
  const result = hasFlag('no-trace')
    ? await api.handleCompileRun(payload)
    : await api.handleExecuteWithTracing(payload);
  if (!result.success) throw new Error(`cpp tracing failed: ${result.error ?? 'unknown error'}`);
  const runId = `mine:${entry.slug}:cpp`;
  const trace = withRuntimeTraceOptions(
    result.trace ?? createEmptyRuntimeTrace('cpp', { runId, file: entry.source.path }),
    { runId, file: entry.source.path }
  );
  return { language: 'cpp', output: result.output, trace, signature: buildMineSignature(trace) };
}

async function executeCppCode(
  entry: CorpusEntry,
  code: string
): Promise<TraceRun> {
  if ((parseStringFlag('cpp-runner') ?? 'native') === 'native') {
    const nativeRun = await executeCppCodeNative(entry, code);
    if (nativeRun) return nativeRun;
  }
  const api = await createCppWorkerHarness();
  const result = await api.handleCompileRun({
    code,
    functionName: entry.functionName,
    inputs: entry.inputs,
    executionStyle: entry.runtimeExecutionStyle ?? 'solution-method',
  });
  if (!result.success) throw new Error(`cpp execution failed: ${result.error ?? 'unknown error'}`);
  return emptyTraceRun('cpp', entry, result.output);
}

async function executeCppCodeNative(
  entry: CorpusEntry,
  code: string
): Promise<TraceRun | null> {
  const compiler = await resolveNativeCppCompiler();
  if (!compiler) return null;
  const api = await createCppWorkerHarness();
  const executionStyle = entry.runtimeExecutionStyle ?? 'solution-method';
  const rawDriverSource = executionStyle === 'ops-class'
    ? api.buildOpsClassDriverSource(code, entry.functionName, entry.inputs, { executionStyle })
    : executionStyle === 'function' && !entry.functionName
      ? api.buildScriptDriverSource(code, { executionStyle })
      : api.buildDriverSource(code, entry.functionName, entry.inputs, { executionStyle });
  const driverSource = rawDriverSource.replace(
    '#include "/tracecode_runtime.hpp"',
    '#include "tracecode_runtime.hpp"'
  );
  const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-cpp-native-mine-'));
  try {
    const driverPath = join(tempDir, 'TraceCodeDriver.cpp');
    const headerPath = join(tempDir, 'tracecode_runtime.hpp');
    const executablePath = join(tempDir, 'program');
    await writeFile(driverPath, driverSource, 'utf8');
    await writeFile(headerPath, await readFile(CPP_RUNTIME_HEADER_PATH, 'utf8'), 'utf8');
    const compile = await runProcessResult(
      compiler,
      [
        driverPath,
        '-std=c++20',
        '-O0',
        '-fno-exceptions',
        '-I',
        tempDir,
        '-o',
        executablePath,
      ],
      undefined,
      parseNumberFlag('cpp-native-compile-timeout-ms', 30_000)
    );
    if (compile.code !== 0) {
      throw new Error(`cpp native compilation failed: ${compile.stderr || compile.stdout || `exit ${compile.code}`}`);
    }
    const run = await runProcessResult(
      executablePath,
      [],
      JSON.stringify(entry.inputs || {}),
      parseNumberFlag('cpp-native-run-timeout-ms', 20_000)
    );
    if (run.code !== 0) {
      throw new Error(
        run.timedOut
          ? 'cpp native execution timed out'
          : `cpp native execution failed: ${run.stderr || run.stdout || `exit ${run.code}`}`
      );
    }
    const parsed = api.parseProgramStdout(run.stdout, { tracing: false, defaultLine: 1, allowMissingResult: false });
    return emptyTraceRun('cpp', entry, parsed.output);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeTopLevelPublicClasses(source: string): string {
  return source.replace(/^([ \t]*)public\s+class\s+/gm, '$1class ');
}

function mapJavaVirtualInputPaths(root: string, source: string): string {
  const hostInputPrefix = join(root, 'str', 'tracecode-java-input').replaceAll('\\', '\\\\');
  return source.replaceAll('/str/tracecode-java-input', hostInputPrefix);
}

async function loadJavaNativeHelpers(): Promise<JavaNativeHelpers> {
  if (javaHelperPromise) return javaHelperPromise;
  javaHelperPromise = (async () => {
    const workerSource = await readFile(join(process.cwd(), 'workers', 'java', 'java-worker.js'), 'utf8');
    const selfObject = {
      location: { search: '' },
      postMessage() {},
      onmessage: null as ((event: { data: WorkerMessage }) => void) | null,
      importScripts: () => {},
    };
    const context = vm.createContext({
      console,
      self: selfObject,
      performance: { now: () => Date.now() },
      setTimeout,
      clearTimeout,
      queueMicrotask,
    });
    vm.runInContext(
      workerSource + '\nglobalThis.__tracecodeJavaMine = { normalizeJavaExecutionPayload, buildJavaCompileId, dynamicInputEntriesForPayload, buildPlainRunnableSource, parseJavaReportOutput, javaReportConsoleOutput };',
      context,
      { filename: 'java-worker.js' }
    );
    const helpers = (context as Record<string, unknown>).__tracecodeJavaMine as JavaNativeHelpers | undefined;
    if (!helpers) throw new Error('Unable to load Java native helper surface');
    return helpers;
  })();
  return javaHelperPromise;
}

async function ensureJavaCompileRunInvoker(): Promise<{ root: string; classpath: string }> {
  if (javaInvokerPromise) return javaInvokerPromise;
  javaInvokerPromise = (async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracecode-java-native-invoker-'));
    const invokerPath = join(root, 'TracecodeCompileRunInvoker.java');
    await writeFile(invokerPath, `
public final class TracecodeCompileRunInvoker {
  public static void main(String[] args) throws Exception {
    String report = tracecode.browser.BrowserCompileAndTraceLibrary.compileAndRun(
      args[0], args[1], args[2], args[3], args[4]
    );
    java.nio.file.Files.writeString(java.nio.file.Path.of(args[5]), report);
  }
}
`, 'utf8');
    await runProcess(JAVAC_BIN, ['-cp', JAVA_HELPER_JAR, '-d', root, invokerPath]);
    return { root, classpath: [root, JAVA_HELPER_JAR].join(':') };
  })();
  return javaInvokerPromise;
}

async function executeJavaCodeNative(
  entry: CorpusEntry,
  code: string
): Promise<TraceRun | null> {
  if ((parseStringFlag('java-runner') ?? 'native') !== 'native') return null;
  const helpers = await loadJavaNativeHelpers();
  const normalizedPayload = helpers.normalizeJavaExecutionPayload({
    code,
    functionName: entry.functionName,
    inputs: entry.inputs,
    executionStyle: entry.runtimeExecutionStyle ?? 'function',
  });
  const compileId = helpers.buildJavaCompileId(normalizedPayload, 'execute');
  const dynamicInputs = helpers.dynamicInputEntriesForPayload(normalizedPayload, compileId);
  const runnableSource = helpers.buildPlainRunnableSource(normalizedPayload, compileId, dynamicInputs);
  const root = await mkdtemp(join(tmpdir(), 'tracecode-java-native-mine-'));
  try {
    const exportsClassName = runnableSource.match(/\bpublic\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    if (!exportsClassName) throw new Error('Unable to resolve generated Java exports class name');
    const sourcePath = join(root, `${exportsClassName}.java`);
    const classesDir = join(root, 'classes');
    const reportPath = join(root, 'report.json');
    const packageName = runnableSource.match(/\bpackage\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/)?.[1];
    if (!packageName) throw new Error('Unable to resolve generated Java package name');
    const entryClass = `${packageName}.${exportsClassName}`;
    await mkdir(classesDir, { recursive: true });
    for (const input of dynamicInputs) {
      const hostPath = join(root, input.path.replace(/^\/+/, ''));
      await mkdir(dirname(hostPath), { recursive: true });
      await writeFile(hostPath, JSON.stringify(input.value), 'utf8');
    }
    await writeFile(sourcePath, mapJavaVirtualInputPaths(root, runnableSource), 'utf8');
    const invoker = await ensureJavaCompileRunInvoker();
    const run = await runProcessResult(
      JAVA_BIN,
      [
        '-cp',
        invoker.classpath,
        'TracecodeCompileRunInvoker',
        sourcePath,
        classesDir,
        entryClass,
        JAVA_HELPER_JAR,
        'none',
        reportPath,
      ],
      undefined,
      parseNumberFlag('java-native-timeout-ms', 30_000)
    );
    if (run.code !== 0) {
      throw new Error(`java native execution failed: ${run.stderr || run.stdout || `exit ${run.code}`}`);
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    if (report.success !== true) {
      throw new Error(
        String(report.runtimeError || report.compilerStderr || report.compilerStdout || 'Java execution failed')
      );
    }
    const output = helpers.parseJavaReportOutput(typeof report.output === 'string' ? report.output : undefined);
    return emptyTraceRun('java', entry, output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

  async function compileAndRun(
    sourcePath: string,
    classesDir: string,
    entryClass: string,
    _helperJarPath: string,
    compilerProfile: string
  ): Promise<string> {
    const root = await rootPromise;
    const source = stringFiles.get(sourcePath);
    if (source === undefined) throw new Error(`Missing Java source for virtual path: ${sourcePath}`);
    const sourceFile = join(root, sourcePath.replace(/^\/+/, ''));
    const outputClassesDir = join(root, classesDir.replace(/^\/+/, '').replace(/\//g, '__'));
    const invokerDir = join(root, '__tracecode_invoker');
    const invokerPath = join(invokerDir, 'TracecodeCompileRunInvoker.java');
    const reportPath = join(root, `${entryClass.replace(/\W/g, '_')}.execute.json`);
    await mkdir(dirname(sourceFile), { recursive: true });
    await mkdir(outputClassesDir, { recursive: true });
    await mkdir(invokerDir, { recursive: true });
    await writeFile(sourceFile, mapJavaVirtualInputPaths(root, source), 'utf8');
    await writeFile(invokerPath, `
public final class TracecodeCompileRunInvoker {
  public static void main(String[] args) throws Exception {
    String report = tracecode.browser.BrowserCompileAndTraceLibrary.compileAndRun(
      args[0], args[1], args[2], args[3], args[4]
    );
    java.nio.file.Files.writeString(java.nio.file.Path.of(args[5]), report);
  }
}
`, 'utf8');
    await runProcess(JAVAC_BIN, ['-cp', JAVA_HELPER_JAR, '-d', invokerDir, invokerPath]);
    await runProcess(JAVA_BIN, [
      '-cp',
      [invokerDir, JAVA_HELPER_JAR].join(':'),
      'TracecodeCompileRunInvoker',
      sourceFile,
      outputClassesDir,
      entryClass,
      JAVA_HELPER_JAR,
      compilerProfile,
      reportPath,
    ]);
    return readFile(reportPath, 'utf8');
  }

  const workerClient = {
    init: async () => ({ success: true, loadTimeMs: 0 }),
    executeWithTracing: async (call: {
      code: string;
      functionName: string | null;
      inputs: Record<string, unknown>;
      traceOptions?: Record<string, unknown>;
      executionStyle?: string;
    }): Promise<JavaWorkerTraceResult> => {
      const { code, inputs, traceOptions: options, executionStyle = 'function' } = call;
      const functionName = call.functionName ?? '';
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
      }) as unknown as typeof setTimeout;
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
          const root = await rootPromise;
          const hostPath = join(root, path.replace(/^\/+/, ''));
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, source, 'utf8');
        },
        cheerpjRunLibrary: async () => ({
          harness: { browser: { JavaRewriteLibrary: { rewriteSource } } },
          tracecode: { browser: { BrowserCompileAndTraceLibrary: { compileAndTrace, compileAndRun } } },
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
        const settledResponse = response as unknown as JavaWorkerRawTraceResult | null;
        if (!settledResponse) throw new Error('Timed out waiting for local Java worker response');
        return {
          ...settledResponse,
          trace: settledResponse.success
            ? javaTraceHooksEventsToRuntimeTrace(settledResponse.events, settledResponse.sourceText, {
                runId: 'java:run',
                file: 'solution.java',
              })
            : createEmptyRuntimeTrace('java', { runId: 'java:run', file: 'solution.java' }),
        };
      } finally {
        closeWorker();
      }
    },
    executeCode: async (call: {
      code: string;
      functionName: string;
      inputs: Record<string, unknown>;
      traceOptions?: Record<string, unknown>;
      executionStyle?: string;
    }) => {
      const { code, functionName, inputs, traceOptions: options, executionStyle = 'function' } = call;
      const workerSource = await readFile(join(process.cwd(), 'workers', 'java', 'java-worker.js'), 'utf8');
      const augmentationSource = await readFile(JAVA_SOURCE_AUGMENTATIONS_PATH, 'utf8');
      let response: { success: boolean; output?: unknown; error?: string; errorLine?: number; consoleOutput?: string[] } | null = null;
      let errorResponse: Error | null = null;
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
          if (message.id !== 'execute') return;
          if (message.type === 'error') {
            const payload = message.payload as { error?: unknown } | undefined;
            errorResponse = new Error(String(payload?.error ?? 'Java worker error'));
            return;
          }
          response = message.payload as typeof response;
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
          harness: { browser: { JavaRewriteLibrary: { rewriteSource } } },
          tracecode: { browser: { BrowserCompileAndTraceLibrary: { compileAndTrace, compileAndRun } } },
        }),
        close: () => {},
      };
      const context = vm.createContext({
        console,
        self: selfObject,
        performance: { now: () => Date.now() },
        setTimeout,
        clearTimeout,
        queueMicrotask,
      });
      vm.runInContext(workerSource, context, { filename: 'java-worker.js' });
      if (typeof selfObject.onmessage !== 'function') throw new Error('Java worker did not register onmessage');
      selfObject.onmessage({ data: { id: 'init', type: 'init' } });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      selfObject.onmessage({
        data: {
          id: 'execute',
          type: 'execute-code',
          payload: { code, functionName, inputs, options, executionStyle },
        },
      });
      const startedAt = Date.now();
      while (!response && !errorResponse && Date.now() - startedAt < 60_000) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      if (errorResponse) throw errorResponse;
      const settledResponse = response as unknown as { success: boolean; output?: unknown; error?: string; errorLine?: number; consoleOutput?: string[] } | null;
      if (!settledResponse) throw new Error('Timed out waiting for local Java worker response');
      return liftCodeOutcome(
        {
          success: settledResponse.success,
          output: settledResponse.output,
          error: settledResponse.error,
          errorLine: settledResponse.errorLine,
          consoleOutput: settledResponse.consoleOutput ?? [],
        },
        'Java execution failed'
      );
    },
    terminate: () => {
      if (process.env.TRACECODE_KEEP_JAVA_MINE_TEMP === '1') return;
      void rootPromise.then((root) => rm(root, { recursive: true, force: true }));
    },
  };

  return workerClient as unknown as JavaWorkerClient;
}

async function executeJavaTrace(
  entry: CorpusEntry,
  code: string,
  maxTraceSteps: number,
  maxLineEvents: number,
  maxSingleLineHits: number
): Promise<TraceRun> {
  const workerClient = createLocalJavaWorkerClient();
  const client = createJavaRuntimeClient(workerClient);
  try {
    const result = await client.executeWithTracing({ code: code, functionName: entry.functionName, inputs: entry.inputs, traceOptions: { maxTraceSteps, maxLineEvents, maxSingleLineHits }, executionStyle: entry.runtimeExecutionStyle ?? 'function' });
    if (result.kind !== 'completed') throw new Error(`java tracing failed: ${result.kind === 'failed' || result.kind === 'limit' ? result.error : 'unknown error'}`);
    const trace = withRuntimeTraceOptions(result.trace, {
      runId: `mine:${entry.slug}:java`,
      file: entry.source.path,
    });
    return { language: 'java', output: result.output, trace, signature: buildMineSignature(trace) };
  } finally {
    workerClient.terminate();
  }
}

async function executeJavaCode(
  entry: CorpusEntry,
  code: string
): Promise<TraceRun> {
  const nativeRun = await executeJavaCodeNative(entry, code);
  if (nativeRun) return nativeRun;
  const workerClient = createLocalJavaWorkerClient();
  const client = createJavaRuntimeClient(workerClient);
  try {
    const result = await client.executeCode({ code: code, functionName: entry.functionName, inputs: entry.inputs, executionStyle: entry.runtimeExecutionStyle ?? 'function' });
    if (result.kind !== 'completed') throw new Error(`java execution failed: ${result.kind === 'failed' || result.kind === 'limit' ? result.error : 'unknown error'}`);
    return emptyTraceRun('java', entry, result.output);
  } finally {
    workerClient.terminate();
  }
}

async function executeEntry(
  pythonRuntime: RuntimeCore,
  workerSource: string,
  entry: CorpusEntry,
  code: string,
  maxTraceSteps: number,
  maxLineEvents: number,
  maxSingleLineHits: number
): Promise<TraceRun> {
  if (hasFlag('no-trace')) {
    return entry.language === 'python'
      ? executePythonCode(pythonRuntime, entry, code)
      : entry.language === 'java'
        ? executeJavaCode(entry, code)
        : entry.language === 'csharp'
          ? executeCSharpCode(entry, code)
          : entry.language === 'cpp'
            ? executeCppCode(entry, code)
            : executeJavaScriptCode(workerSource, entry, code);
  }
  return entry.language === 'python'
    ? executePythonTrace(pythonRuntime, entry, code, maxTraceSteps, maxLineEvents, maxSingleLineHits)
    : entry.language === 'java'
      ? executeJavaTrace(entry, code, maxTraceSteps, maxLineEvents, maxSingleLineHits)
      : entry.language === 'csharp'
        ? executeCSharpTrace(entry, code, maxTraceSteps)
        : entry.language === 'cpp'
          ? executeCppTrace(entry, code, parseNumberFlag('max-stored-events', maxTraceSteps))
          : executeJavaScriptTrace(workerSource, entry, code, maxTraceSteps, maxLineEvents, maxSingleLineHits);
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

function resolveSourcePath(root: string, entry: CorpusEntry): string {
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
  compareOutputToReference: boolean,
  compareMode?: string
): DriftRecord | null {
  const kinds: string[] = [];
  let output: DriftRecord['output'];
  let signatureDiff: DriftRecord['signatureDiff'];
  if (compareOutputToReference && !outputsEqual(reference.output, run.output, compareMode)) {
    kinds.push('output');
    output = { expected: normalizeOutputForReport(reference.output), received: normalizeOutputForReport(run.output) };
  }
  if (compareRuntimeFacts && !signaturesEqual(reference.signature, run.signature)) {
    kinds.push('runtime-facts');
    signatureDiff = { expected: reference.signature, received: run.signature };
  }
  if (kinds.length === 0) return null;
  return { slug, family, comparedTo: reference.language, language: run.language, kinds, output, signatureDiff };
}

function hasExpectedOutput(entry: CorpusEntry): boolean {
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

function operationTokenDiffs(drift: DriftRecord): Array<{ token: string; direction: 'missing' | 'extra' }> {
  if (!drift.signatureDiff) return [];
  const expectedKeys = new Set(Object.keys(drift.signatureDiff.expected.accessShapeFacts));
  const receivedKeys = new Set(Object.keys(drift.signatureDiff.received.accessShapeFacts));
  const diffs: Array<{ token: string; direction: 'missing' | 'extra' }> = [];
  for (const token of [...new Set([...expectedKeys, ...receivedKeys])].sort((left, right) => left.localeCompare(right))) {
    if (expectedKeys.has(token) && !receivedKeys.has(token)) {
      diffs.push({ token, direction: 'missing' });
    } else if (!expectedKeys.has(token) && receivedKeys.has(token)) {
      diffs.push({ token, direction: 'extra' });
    }
  }
  return diffs;
}

function parseShapeToken(token: string): { kind: string; depth: string } | null {
  const match = /^(read|write|mutate):\*:path(\d+)$/.exec(token);
  if (!match) return null;
  return { kind: match[1], depth: match[2] };
}

function parseAccessToken(token: string): { kind: string; variable: string; depth: string } | null {
  const match = /^(read|write|mutate):([^:]+):path(\d+)$/.exec(token);
  if (!match) return null;
  return { kind: match[1], variable: match[2], depth: match[3] };
}

function accessVariables(signature: MineSignature): Set<string> {
  return new Set(
    Object.keys(signature.accessFacts)
      .map((token) => parseAccessToken(token)?.variable)
      .filter((variable): variable is string => Boolean(variable))
  );
}

function missingAccessVariables(expected: MineSignature, received: MineSignature): string[] {
  const receivedVariables = new Set([...received.snapshotVariables, ...accessVariables(received)]);
  return [
    ...new Set(
      Object.keys(expected.accessFacts)
        .filter((token) => !(token in received.accessFacts))
        .map((token) => parseAccessToken(token)?.variable)
        .filter((variable): variable is string => variable !== undefined && variable !== '' && !receivedVariables.has(variable))
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function extraAccessVariables(expected: MineSignature, received: MineSignature): string[] {
  const expectedVariables = new Set([...expected.snapshotVariables, ...accessVariables(expected)]);
  return [
    ...new Set(
      Object.keys(received.accessFacts)
        .filter((token) => !(token in expected.accessFacts))
        .map((token) => parseAccessToken(token)?.variable)
        .filter((variable): variable is string => variable !== undefined && variable !== '' && !expectedVariables.has(variable))
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function accessOperationKindsByVariable(signature: MineSignature): Map<string, Set<string>> {
  const operations = new Map<string, Set<string>>();
  for (const token of Object.keys(signature.accessFacts)) {
    const parsed = parseAccessToken(token);
    if (!parsed) continue;
    const kinds = operations.get(parsed.variable) ?? new Set<string>();
    kinds.add(parsed.kind);
    operations.set(parsed.variable, kinds);
  }
  return operations;
}

function missingAccessTokens(expected: MineSignature, received: MineSignature): string[] {
  return Object.keys(expected.accessFacts)
    .filter((token) => !(token in received.accessFacts))
    .sort((left, right) => left.localeCompare(right));
}

function extraAccessTokens(expected: MineSignature, received: MineSignature): string[] {
  return Object.keys(received.accessFacts)
    .filter((token) => !(token in expected.accessFacts))
    .sort((left, right) => left.localeCompare(right));
}

function operationReplacedOnSameVariable(tokens: string[], other: MineSignature): boolean {
  if (tokens.length === 0) return false;
  const otherOperations = accessOperationKindsByVariable(other);
  return tokens.every((token) => {
    const parsed = parseAccessToken(token);
    if (!parsed) return false;
    const operations = otherOperations.get(parsed.variable);
    return Boolean(operations && [...operations].some((kind) => kind !== parsed.kind));
  });
}

function accessIntroducedOnSnapshotOnlyVariable(expected: MineSignature, received: MineSignature): boolean {
  const expectedOperations = accessOperationKindsByVariable(expected);
  return extraAccessTokens(expected, received).some((token) => {
    const parsed = parseAccessToken(token);
    return Boolean(parsed && !expectedOperations.has(parsed.variable));
  });
}

function shapeKindSet(signature: MineSignature): Set<string> {
  return new Set(
    Object.keys(signature.accessShapeFacts)
      .map((token) => parseShapeToken(token)?.kind)
      .filter((kind): kind is string => Boolean(kind))
  );
}

function shapeDepthsByKind(signature: MineSignature): Map<string, Set<string>> {
  const depths = new Map<string, Set<string>>();
  for (const token of Object.keys(signature.accessShapeFacts)) {
    const parsed = parseShapeToken(token);
    if (!parsed) continue;
    const existing = depths.get(parsed.kind) ?? new Set<string>();
    existing.add(parsed.depth);
    depths.set(parsed.kind, existing);
  }
  return depths;
}

function setEquals<T>(left: Set<T>, right: Set<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function classifyRuntimeDrift(drift: DriftRecord): ClassifiedDriftRecord {
  const evidence: string[] = [];
  if (!drift.signatureDiff) {
    return {
      ...drift,
      classification: 'implementation-drift',
      confidence: drift.kinds.includes('output') ? 'high' : 'medium',
      evidence: drift.kinds.includes('output')
        ? ['output differs from the comparison target']
        : ['no runtime signature diff was available for operation-level classification'],
    };
  }

  const expected = drift.signatureDiff.expected;
  const received = drift.signatureDiff.received;
  const diffs = operationTokenDiffs(drift);
  const missing = diffs.filter((diff) => diff.direction === 'missing').map((diff) => diff.token);
  const extra = diffs.filter((diff) => diff.direction === 'extra').map((diff) => diff.token);
  const expectedKinds = shapeKindSet(expected);
  const receivedKinds = shapeKindSet(received);
  const expectedDepths = shapeDepthsByKind(expected);
  const receivedDepths = shapeDepthsByKind(received);
  const callRatio = expected.callCount === 0 ? received.callCount : received.callCount / expected.callCount;
  const callStructureLooksDifferent = callRatio >= 4 || callRatio <= 0.25;
  const callCountsDiffer = expected.callCount !== received.callCount;
  const missingVariables = missingAccessVariables(expected, received);
  const extraVariables = extraAccessVariables(expected, received);
  const missingOperationsReplaced = operationReplacedOnSameVariable(missingAccessTokens(expected, received), received);
  const extraOperationsReplaced = operationReplacedOnSameVariable(extraAccessTokens(expected, received), expected);
  const introducedSnapshotOnlyAccess = accessIntroducedOnSnapshotOnlyVariable(expected, received);

  if (expectedKinds.size === 0 || receivedKinds.size === 0) {
    evidence.push('one side has no runtime access shape facts');
    return { ...drift, classification: 'implementation-drift', confidence: 'high', evidence };
  }

  if (callStructureLooksDifferent) {
    evidence.push(`call-count ratio is ${callRatio.toFixed(2)}, suggesting different helper/library structure`);
  } else if (callCountsDiffer) {
    evidence.push(`call count differs: expected=${expected.callCount} received=${received.callCount}`);
  }

  if (missingVariables.length > 0) {
    evidence.push(`missing access variables absent from received trace: ${missingVariables.join(', ')}`);
  }

  if (extraVariables.length > 0) {
    evidence.push(`extra access variables absent from expected trace: ${extraVariables.join(', ')}`);
  }

  if (missingOperationsReplaced || extraOperationsReplaced) {
    evidence.push('access operations are represented by different operation kinds on the same variables');
  }

  if (introducedSnapshotOnlyAccess) {
    evidence.push('received trace introduces access operations on variables that were snapshot-only in expected trace');
  }

  if (
    missingVariables.length > 0 ||
    extraVariables.length > 0 ||
    callStructureLooksDifferent ||
    callCountsDiffer ||
    missingOperationsReplaced ||
    extraOperationsReplaced ||
    introducedSnapshotOnlyAccess
  ) {
    return { ...drift, classification: 'implementation-drift', confidence: 'high', evidence };
  }

  if (setEquals(expectedKinds, receivedKinds)) {
    const changedDepths = [...expectedKinds].filter((kind) =>
      !setEquals(expectedDepths.get(kind) ?? new Set(), receivedDepths.get(kind) ?? new Set())
    );
    if (changedDepths.length > 0) {
      evidence.push(`same operation kinds with different path depths for ${changedDepths.join(', ')}`);
      return {
        ...drift,
        classification: 'metric-sensitive',
        confidence: callStructureLooksDifferent ? 'medium' : 'high',
        evidence,
      };
    }
    evidence.push('same operation kinds with count/name sensitivity only');
    return { ...drift, classification: 'metric-sensitive', confidence: 'high', evidence };
  }

  const missingMutate = missing.some((token) => token.startsWith('mutate:'));
  const missingWrite = missing.some((token) => token.startsWith('write:'));
  const missingRead = missing.some((token) => token.startsWith('read:'));
  const hasCompensatingWrite = extra.some((token) => token.startsWith('write:'));
  const hasCompensatingMutate = extra.some((token) => token.startsWith('mutate:'));
  const hasCompensatingRead = extra.some((token) => token.startsWith('read:'));

  if (
    missing.length > 0 &&
    extra.length <= 1 &&
    !callStructureLooksDifferent &&
    (missingMutate || missingWrite || missingRead) &&
    !(missingMutate && hasCompensatingWrite) &&
    !(missingWrite && hasCompensatingMutate)
  ) {
    evidence.push(`missing runtime operation shapes: ${missing.join(', ')}`);
    if (extra.length > 0) evidence.push(`only small extra shape set: ${extra.join(', ')}`);
    return { ...drift, classification: 'fixture-worthy', confidence: extra.length === 0 ? 'high' : 'medium', evidence };
  }

  if (
    (missingMutate && hasCompensatingWrite) ||
    (missingWrite && hasCompensatingMutate) ||
    (missingRead && hasCompensatingRead)
  ) {
    evidence.push('operation shapes are replaced by a different representation rather than simply missing');
    evidence.push(`missing=${missing.join(', ') || 'none'} extra=${extra.join(', ') || 'none'}`);
    return { ...drift, classification: 'implementation-drift', confidence: 'medium', evidence };
  }

  if (evidence.length > 0 || missing.length + extra.length >= 4) {
    evidence.push(`large shape diff: missing=${missing.join(', ') || 'none'} extra=${extra.join(', ') || 'none'}`);
    return { ...drift, classification: 'implementation-drift', confidence: evidence.length > 1 ? 'high' : 'medium', evidence };
  }

  evidence.push(`small shape diff: missing=${missing.join(', ') || 'none'} extra=${extra.join(', ') || 'none'}`);
  return { ...drift, classification: 'metric-sensitive', confidence: 'low', evidence };
}

function emptyClassificationCounts(): Record<DriftClassificationKind, number> {
  return {
    'fixture-worthy': 0,
    'implementation-drift': 0,
    'metric-sensitive': 0,
  };
}

function summarizeClassifiedDrifts(drifts: ClassifiedDriftRecord[]): DriftClassificationSummary {
  const byLanguage: Record<MineLanguage, Record<DriftClassificationKind, number>> = {
    python: emptyClassificationCounts(),
    javascript: emptyClassificationCounts(),
    typescript: emptyClassificationCounts(),
    java: emptyClassificationCounts(),
    csharp: emptyClassificationCounts(),
    cpp: emptyClassificationCounts(),
  };
  const summary: DriftClassificationSummary = {
    counts: emptyClassificationCounts(),
    byLanguage,
    examples: {
      'fixture-worthy': [],
      'implementation-drift': [],
      'metric-sensitive': [],
    },
  };
  for (const drift of drifts) {
    summary.counts[drift.classification] += 1;
    summary.byLanguage[drift.language][drift.classification] += 1;
    const examples = summary.examples[drift.classification];
    if (examples.length < 12) {
      examples.push({ slug: drift.slug, language: drift.language, evidence: drift.evidence.slice(0, 3) });
    }
  }
  return summary;
}

function isClassifiedDrift(drift: DriftRecord | ClassifiedDriftRecord): drift is ClassifiedDriftRecord {
  return 'classification' in drift && 'confidence' in drift && Array.isArray((drift as ClassifiedDriftRecord).evidence);
}

function countDriftsByLanguage(drifts: DriftRecord[]): Record<MineLanguage, number> {
  const counts = { python: 0, javascript: 0, typescript: 0, java: 0, csharp: 0, cpp: 0 };
  for (const drift of drifts) {
    counts[drift.language] += 1;
  }
  return counts;
}

function emptyLanguageNumberMap(): Record<MineLanguage, number> {
  return { python: 0, javascript: 0, typescript: 0, java: 0, csharp: 0, cpp: 0 };
}

function clusterOperationTokenDiffs(drifts: DriftRecord[]): OperationTokenCluster[] {
  const clusters = new Map<string, OperationTokenCluster>();
  for (const drift of drifts) {
    for (const diff of operationTokenDiffs(drift)) {
      const key = `${diff.direction}:${diff.token}`;
      const cluster = clusters.get(key) ?? { ...diff, count: 0, examples: [] };
      cluster.count += 1;
      if (cluster.examples.length < 8) {
        cluster.examples.push({ slug: drift.slug, language: drift.language, comparedTo: drift.comparedTo });
      }
      clusters.set(key, cluster);
    }
  }
  return [...clusters.values()].sort((left, right) =>
    right.count - left.count ||
    left.direction.localeCompare(right.direction) ||
    left.token.localeCompare(right.token)
  );
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

function trimDriftForReport<T extends DriftRecord>(drift: T, includeSignatureDiff: boolean): T {
  return {
    ...drift,
    ...(includeSignatureDiff ? { signatureDiff: drift.signatureDiff } : { signatureDiff: undefined }),
  } as T;
}

function trimFailureForReport(failure: FailureRecord, maxErrorChars: number): FailureRecord {
  return {
    ...failure,
    error: tailString(failure.error, maxErrorChars),
  };
}

function synthesizeJavaEntry(sourceRoot: string, group: CorpusEntry[]): CorpusEntry | null {
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

async function loadMineGroups(corpusPath: string, sourceRoot: string): Promise<Array<[string, CorpusEntry[]]>> {
  const entries = JSON.parse(await readFile(corpusPath, 'utf8')) as CorpusEntry[];
  if (hasFlag('expected-only')) {
    if (hasFlag('expected-only-group-by-source')) {
      const bySource = new Map<string, CorpusEntry[]>();
      for (const entry of entries) {
        if (!['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'].includes(entry.language)) continue;
        const key = `${entry.slug}:${entry.language}:${entry.functionName}:${entry.source.path}`;
        const group = bySource.get(key) ?? [];
        group.push(entry);
        bySource.set(key, group);
      }
      return [...bySource.entries()];
    }
    return entries
      .filter((entry) => ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'].includes(entry.language))
      .map((entry) => [`${entry.slug}:${entry.solutionId ?? entry.source.path}`, [entry]]);
  }
  const bySlug = new Map<string, CorpusEntry[]>();
  for (const entry of entries) {
    if (!['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'].includes(entry.language)) continue;
    const group = bySlug.get(entry.slug) ?? [];
    group.push(entry);
    bySlug.set(entry.slug, group);
  }
  for (const [slug, group] of bySlug) {
    const javaEntry = synthesizeJavaEntry(sourceRoot, group);
    if (javaEntry) {
      bySlug.set(slug, [...group, javaEntry]);
    }
  }
  return [...bySlug.entries()]
    .filter(([, group]) => group.some((entry) => entry.language === 'python') && group.length > 1);
}

function mergeCountMaps<T extends string>(left: Record<T, number>, right: Record<T, number>): Record<T, number> {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right) as Array<[T, number]>) {
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

function mergeDriftClusters(reports: MineReport[]): DriftCluster[] {
  const clusters = new Map<string, DriftCluster>();
  for (const report of reports) {
    for (const incoming of report.driftClusters) {
      const cluster = clusters.get(incoming.key) ?? { key: incoming.key, count: 0, examples: [] };
      cluster.count += incoming.count;
      for (const example of incoming.examples) {
        if (cluster.examples.length >= 8) break;
        cluster.examples.push(example);
      }
      clusters.set(incoming.key, cluster);
    }
  }
  return [...clusters.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function mergeOperationTokenClusters(reports: MineReport[]): OperationTokenCluster[] {
  const clusters = new Map<string, OperationTokenCluster>();
  for (const report of reports) {
    for (const incoming of report.operationTokenClusters) {
      const key = `${incoming.direction}:${incoming.token}`;
      const cluster = clusters.get(key) ?? {
        token: incoming.token,
        direction: incoming.direction,
        count: 0,
        examples: [],
      };
      cluster.count += incoming.count;
      for (const example of incoming.examples) {
        if (cluster.examples.length >= 8) break;
        cluster.examples.push(example);
      }
      clusters.set(key, cluster);
    }
  }
  return [...clusters.values()].sort((left, right) =>
    right.count - left.count ||
    left.direction.localeCompare(right.direction) ||
    left.token.localeCompare(right.token)
  );
}

function mergeClassificationSummaries(reports: MineReport[]): DriftClassificationSummary {
  const merged: DriftClassificationSummary = {
    counts: emptyClassificationCounts(),
    byLanguage: {
      python: emptyClassificationCounts(),
      javascript: emptyClassificationCounts(),
      typescript: emptyClassificationCounts(),
      java: emptyClassificationCounts(),
      csharp: emptyClassificationCounts(),
      cpp: emptyClassificationCounts(),
    },
    examples: {
      'fixture-worthy': [],
      'implementation-drift': [],
      'metric-sensitive': [],
    },
  };
  for (const report of reports) {
    const summary = report.classificationSummary;
    if (!summary) continue;
    for (const classification of Object.keys(merged.counts) as DriftClassificationKind[]) {
      merged.counts[classification] += summary.counts[classification] ?? 0;
      for (const language of Object.keys(merged.byLanguage) as MineLanguage[]) {
        merged.byLanguage[language][classification] += summary.byLanguage?.[language]?.[classification] ?? 0;
      }
      for (const example of summary.examples[classification] ?? []) {
        if (merged.examples[classification].length >= 12) break;
        merged.examples[classification].push(example);
      }
    }
  }
  return merged;
}

function childMineArgs(reportPath: string, offset: number, limit: number): string[] {
  const blocked = new Set(['jobs', 'report', 'limit', 'offset']);
  const args = process.argv.slice(2).filter((arg) => {
    if (arg === '--worker') return false;
    const match = /^--([^=]+)/.exec(arg);
    return !match || !blocked.has(match[1]);
  });
  return [...args, '--worker', `--limit=${limit}`, `--offset=${offset}`, `--report=${reportPath}`];
}

async function runConcurrentMine(
  corpusPath: string,
  sourceRoot: string,
  reportPath: string,
  limit: number,
  offset: number,
  jobs: number
): Promise<void> {
  const groups = (await loadMineGroups(corpusPath, sourceRoot)).slice(offset, offset + limit);
  const workDir = await mkdtemp(join(tmpdir(), 'tracecode-runtime-trace-mine-shards-'));
  const scriptPath = resolve(process.argv[1]);
  const reports: MineReport[] = [];
  const failures: FailureRecord[] = [];
  const workerTimeoutMs = parseNumberFlag('worker-timeout-ms', 180_000);
  const chunkSize = parseNumberFlag('chunk-size', 1);
  const chunks: Array<{ start: number; limit: number }> = [];
  for (let start = 0; start < groups.length; start += chunkSize) {
    chunks.push({ start, limit: Math.min(chunkSize, groups.length - start) });
  }
  let nextIndex = 0;
  let completedGroups = 0;
  let completedChunks = 0;
  const startedAt = Date.now();
  console.log(
    `runtime trace corpus concurrent mining started: groups=${groups.length} chunks=${chunks.length} ` +
      `chunkSize=${chunkSize} jobs=${jobs} offset=${offset} noTrace=${hasFlag('no-trace')}`
  );

  async function runOne(chunkIndex: number): Promise<void> {
    const chunk = chunks[chunkIndex];
    const absoluteOffset = offset + chunk.start;
    const chunkGroups = groups.slice(chunk.start, chunk.start + chunk.limit);
    const firstSlug = chunkGroups[0]?.[0] ?? '<empty>';
    const lastSlug = chunkGroups[chunkGroups.length - 1]?.[0] ?? firstSlug;
    const chunkEntryCount = chunkGroups.reduce((sum, [, group]) => sum + group.length, 0);
    const childReportPath = join(workDir, `${String(absoluteOffset).padStart(6, '0')}-${chunk.limit}.json`);
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolvePromise, reject) => {
      const child = spawn('pnpm', ['exec', 'tsx', scriptPath, ...childMineArgs(childReportPath, absoluteOffset, chunk.limit)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, 5_000).unref();
      }, workerTimeoutMs);
      timeoutId.unref();
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeoutId);
        resolvePromise({ code, stdout, stderr, timedOut });
      });
    });
    if (output.code !== 0 || !existsSync(childReportPath)) {
      for (const [slug, group] of chunkGroups) {
        for (const entry of group) {
          failures.push({
            slug,
            solutionId: entry.solutionId,
            sourcePath: entry.source.path,
            language: entry.language,
            error: tailString(
              output.timedOut
                ? `runner-process-timeout: child exceeded ${workerTimeoutMs}ms\n${output.stderr || output.stdout}`
                : `runner-process-crash: child exited with ${output.code}\n${output.stderr || output.stdout}`,
              12_000
            ),
          });
        }
      }
      completedGroups += chunk.limit;
      completedChunks += 1;
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      console.log(
        `[${completedGroups}/${groups.length}] fail chunk ${completedChunks}/${chunks.length} ` +
          `${firstSlug}..${lastSlug} entries=${chunkEntryCount} elapsed=${elapsedSeconds}s`
      );
      return;
    }
    const childReport = JSON.parse(await readFile(childReportPath, 'utf8')) as MineReport;
    reports.push(childReport);
    completedGroups += childReport.groupsScanned;
    completedChunks += 1;
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    console.log(
      `[${completedGroups}/${groups.length}] done chunk ${completedChunks}/${chunks.length} ` +
        `${firstSlug}..${lastSlug} entries=${chunkEntryCount} groups=${childReport.groupsScanned} ` +
        `comparisons=${childReport.comparisons} drifts=${childReport.driftCount} ` +
        `failures=${childReport.failureCount} elapsed=${elapsedSeconds}s`
    );
  }

  async function worker(): Promise<void> {
    while (nextIndex < chunks.length) {
      const groupIndex = nextIndex;
      nextIndex += 1;
      await runOne(groupIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, jobs) }, () => worker()));

  const driftCount = reports.reduce((sum, report) => sum + report.driftCount, 0);
  const failureCount = reports.reduce((sum, report) => sum + report.failureCount, 0) + failures.length;
  const hardFailureCount = reports.reduce((sum, report) => sum + report.hardFailureCount, 0) + failures.length;
  const executionTimingMs = reports.reduce(
    (counts, report) => mergeCountMaps(counts, report.executionTimingMs ?? emptyLanguageNumberMap()),
    emptyLanguageNumberMap()
  );
  const executionCounts = reports.reduce(
    (counts, report) => mergeCountMaps(counts, report.executionCounts ?? emptyLanguageNumberMap()),
    emptyLanguageNumberMap()
  );
  const executionCacheHits = reports.reduce((sum, report) => sum + (report.executionCacheHits ?? 0), 0);
  const executionCacheMisses = reports.reduce((sum, report) => sum + (report.executionCacheMisses ?? 0), 0);
  const driftCountsByLanguage = reports.reduce(
    (counts, report) => mergeCountMaps(counts, report.driftCountsByLanguage),
    { python: 0, javascript: 0, typescript: 0, java: 0, csharp: 0, cpp: 0 }
  );
  const reportFailures = [
    ...reports.flatMap((report) => report.failures),
    ...failures,
  ];
  const classifiedDrifts = reports
    .flatMap((report) => report.drifts)
    .map((drift) => (isClassifiedDrift(drift) ? drift : classifyRuntimeDrift(drift as DriftRecord)));
  const temporalInvariantViolations = reports.flatMap((report) => report.temporalInvariantViolations ?? []);
  const mergedClassificationSummary = mergeClassificationSummaries(reports);
  const classificationSummary =
    Object.values(mergedClassificationSummary.counts).reduce((sum, count) => sum + count, 0) > 0
      ? mergedClassificationSummary
      : summarizeClassifiedDrifts(classifiedDrifts);
  const maxReportDrifts = parseNumberFlag('max-report-drifts', 250);
  const maxReportFailures = parseNumberFlag('max-report-failures', 250);
  const maxReportErrorChars = parseNumberFlag('max-report-error-chars', 12_000);
  const includeSignatureDiffs = hasFlag('include-signature-diffs');
  const referenceLanguage = parseReferenceLanguage();
  const comparisonLanguages = parseMineLanguageListFlag('comparison-languages', ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp']);
  const mergedReport: MineReport & {
    jobs: number;
    chunkSize: number;
    chunkCount: number;
    workerReportDir: string;
    runnerCrashCount: number;
    workerTimeoutMs: number;
  } = {
    corpusPath,
    sourceRoot,
    offset,
    limit,
    maxTraceSteps: parseNumberFlag('max-trace-steps', 10000),
    maxLineEvents: parseNumberFlag('max-line-events', 20000),
    maxSingleLineHits: parseNumberFlag('max-single-line-hits', 10000),
    referenceLanguage,
    comparisonLanguages,
    compareRuntimeFacts: hasFlag('compare-runtime-facts'),
    includeSignatureDiffs,
    maxReportDrifts,
    maxReportFailures,
    failOnFailure: hasFlag('fail-on-failure'),
    groupsScanned: groups.length,
    synthesizedJavaEntries: reports.reduce((sum, report) => sum + report.synthesizedJavaEntries, 0),
    comparisons: reports.reduce((sum, report) => sum + report.comparisons, 0),
    driftCount,
    driftCountsByLanguage,
    failureCount,
    hardFailureCount,
    driftClusters: mergeDriftClusters(reports),
    operationTokenClusters: mergeOperationTokenClusters(reports),
    classificationSummary,
    reportedDriftCount: Math.min(maxReportDrifts, classifiedDrifts.length),
    reportedFailureCount: Math.min(maxReportFailures, reportFailures.length),
    temporalInvariantViolationCount: temporalInvariantViolations.length,
    reportedTemporalInvariantViolationCount: Math.min(250, temporalInvariantViolations.length),
    temporalInvariantViolations: temporalInvariantViolations.slice(0, 250),
    drifts: classifiedDrifts
      .slice(0, maxReportDrifts)
      .map((drift) => trimDriftForReport(drift, includeSignatureDiffs)),
    failures: reportFailures
      .slice(0, maxReportFailures)
      .map((failure) => trimFailureForReport(failure, maxReportErrorChars)),
    executionTimingMs,
    executionCounts,
    executionCacheHits,
    executionCacheMisses,
    jobs,
    chunkSize,
    chunkCount: chunks.length,
    workerReportDir: workDir,
    runnerCrashCount: failures.length,
    workerTimeoutMs,
  };
  await writeReport(reportPath, mergedReport);

  console.log(`runtime trace corpus concurrent mining: groups=${groups.length} jobs=${jobs} comparisons=${mergedReport.comparisons} drifts=${driftCount} failures=${failureCount}`);
  console.log(`Hard failures: ${hardFailureCount}`);
  console.log(`Runner crashes recorded as failures: ${failures.length}`);
  console.log(`Drifts by language: ${Object.entries(driftCountsByLanguage).map(([language, count]) => `${language}=${count}`).join(' ')}`);
  console.log(`Drift classifications: ${Object.entries(mergedReport.classificationSummary.counts).map(([classification, count]) => `${classification}=${count}`).join(' ')}`);
  console.log(`Execution timing ms: ${Object.entries(executionTimingMs).map(([language, ms]) => `${language}=${Math.round(ms)}/${executionCounts[language as MineLanguage] ?? 0}`).join(' ')}`);
  console.log(`Execution cache: hits=${executionCacheHits} misses=${executionCacheMisses}`);
  console.log(`Temporal invariant violations: ${mergedReport.temporalInvariantViolationCount}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Worker reports: ${workDir}`);

  if (hasFlag('fail-on-failure') && hardFailureCount > 0) {
    process.exitCode = 1;
  } else if (hasFlag('fail-on-drift') && (driftCount > 0 || hardFailureCount > 0)) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const corpusPath = resolve(parseStringFlag('corpus') ?? DEFAULT_CORPUS_PATH);
  if (!existsSync(corpusPath)) {
    throw new Error(
      [
        'Runtime trace corpus mining is a local/private validation path, not a public harness CI gate.',
        'It requires a local TraceCode/algoflow checkout or an explicit --corpus path.',
        `Tried: ${corpusPath}`,
        'Pass --corpus=/path/to/runtime-corpus.json when running outside the default local workspace.',
      ].join('\n')
    );
  }
  const sourceRoot = inferCorpusRoot(corpusPath);
  const limit = parseNumberFlag('limit', 20);
  const offset = parseNumberFlag('offset', 0);
  const reportPath = resolve(parseStringFlag('report') ?? join(process.cwd(), 'reports', 'runtime-trace-corpus-mine.json'));
  const jobs = parseNumberFlag('jobs', 1);
  if (jobs > 1 && !hasFlag('worker')) {
    await runConcurrentMine(corpusPath, sourceRoot, reportPath, limit, offset, jobs);
    process.exit(process.exitCode ?? 0);
  }
  const maxTraceSteps = parseNumberFlag('max-trace-steps', 10000);
  const maxLineEvents = parseNumberFlag('max-line-events', 20000);
  const maxSingleLineHits = parseNumberFlag('max-single-line-hits', 10000);
  const failOnDrift = hasFlag('fail-on-drift');
  const failOnFailure = hasFlag('fail-on-failure');
  const compareRuntimeFacts = hasFlag('compare-runtime-facts');
  const includeSignatureDiffs = hasFlag('include-signature-diffs');
  const referenceLanguage = parseReferenceLanguage();
  const comparisonLanguages = parseMineLanguageListFlag('comparison-languages', ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp']);
  const maxReportDrifts = parseNumberFlag('max-report-drifts', 250);
  const maxReportFailures = parseNumberFlag('max-report-failures', 250);
  const maxReportErrorChars = parseNumberFlag('max-report-error-chars', 12_000);

  const allGroups = await loadMineGroups(corpusPath, sourceRoot);
  const groups = allGroups.slice(offset, offset + limit);
  const synthesizedJavaEntries = groups.filter(([, group]) =>
    group.some((entry) => entry.language === 'java' && entry.source.path.includes('generated-validated-java'))
  ).length;
  const pythonRuntime = await loadPythonRuntimeCore();
  const workerSource = await readFile(JAVASCRIPT_WORKER_PATH, 'utf8');
  const executionCache = await loadExecutionCache();
  const sourceTextCache = new Map<string, string>();
  const drifts: DriftRecord[] = [];
  const failures: FailureRecord[] = [];
  const temporalInvariantViolations: TemporalInvariantViolation[] = [];
  const executionTimingMs = emptyLanguageNumberMap();
  const executionCounts = emptyLanguageNumberMap();
  let compared = 0;

  for (const [slug, group] of groups) {
    const runs = new Map<MineLanguage, TraceRun>();
    const entriesByLanguage = new Map<MineLanguage, CorpusEntry>();
    for (const entry of group.sort((left, right) => left.language.localeCompare(right.language))) {
      entriesByLanguage.set(entry.language, entry);
      const sourcePath = resolveSourcePath(sourceRoot, entry);
      let executionStartedAt: number | null = null;
      try {
        let code = sourceTextCache.get(sourcePath);
        if (code === undefined) {
          code = await readFile(sourcePath, 'utf8');
          sourceTextCache.set(sourcePath, code);
        }
        executionStartedAt = performance.now();
        const run = await executeEntryWithCache(
          executionCache,
          pythonRuntime,
          workerSource,
          entry,
          code,
          maxTraceSteps,
          maxLineEvents,
          maxSingleLineHits
        );
        executionTimingMs[entry.language] += performance.now() - executionStartedAt;
        executionCounts[entry.language] += 1;
        runs.set(entry.language, run);
        temporalInvariantViolations.push(...auditTemporalInvariants(entry, code, run.trace));
        if (hasExpectedOutput(entry) && !entryExpectedOutputMatches(entry, run.output)) {
          drifts.push({
            slug,
            solutionId: entry.solutionId,
            sourcePath: entry.source.path,
            family: entry.family,
            comparedTo: 'expectedOutput',
            language: entry.language,
            kinds: ['output'],
            output: { expected: normalizeOutputForReport(entry.expectedOutput), received: normalizeOutputForReport(run.output) },
          });
        }
      } catch (error) {
        if (executionStartedAt !== null) {
          executionTimingMs[entry.language] += performance.now() - executionStartedAt;
        }
        executionCounts[entry.language] += 1;
        failures.push({
          slug,
          solutionId: entry.solutionId,
          sourcePath: entry.source.path,
          language: entry.language,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (hasFlag('expected-only')) continue;
    const reference = runs.get(referenceLanguage);
    if (!reference) continue;
    for (const language of comparisonLanguages) {
      if (language === referenceLanguage) continue;
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
        !entry || !hasExpectedOutput(entry),
        entry?.compareMode ?? group[0]?.compareMode
      );
      if (drift) drifts.push(drift);
    }
  }

  const hardFailures = failures.filter((failure) => !isTraceBudgetFailure(failure.error));
  const classifiedDrifts = drifts.map((drift) => classifyRuntimeDrift(drift));
  const driftClusters = clusterDrifts(drifts);
  const driftCountsByLanguage = countDriftsByLanguage(drifts);
  const operationTokenClusters = clusterOperationTokenDiffs(drifts);
  const reportedDrifts = classifiedDrifts
    .slice(0, maxReportDrifts)
    .map((drift) => trimDriftForReport(drift, includeSignatureDiffs));
  const reportedFailures = failures
    .slice(0, maxReportFailures)
    .map((failure) => trimFailureForReport(failure, maxReportErrorChars));
  const report = {
    corpusPath,
    sourceRoot,
    offset,
    limit,
    maxTraceSteps,
    maxLineEvents,
    maxSingleLineHits,
    referenceLanguage,
    comparisonLanguages,
    compareRuntimeFacts,
    includeSignatureDiffs,
    maxReportDrifts,
    maxReportFailures,
    failOnFailure,
    groupsScanned: groups.length,
    synthesizedJavaEntries,
    comparisons: compared,
    driftCount: drifts.length,
    driftCountsByLanguage,
    failureCount: failures.length,
    hardFailureCount: hardFailures.length,
    driftClusters,
    operationTokenClusters,
    classificationSummary: summarizeClassifiedDrifts(classifiedDrifts),
    reportedDriftCount: reportedDrifts.length,
    reportedFailureCount: reportedFailures.length,
    temporalInvariantViolationCount: temporalInvariantViolations.length,
    reportedTemporalInvariantViolationCount: Math.min(250, temporalInvariantViolations.length),
    temporalInvariantViolations: temporalInvariantViolations.slice(0, 250),
    drifts: reportedDrifts,
    failures: reportedFailures,
    executionTimingMs,
    executionCounts,
    executionCacheHits: executionCache.hits,
    executionCacheMisses: executionCache.misses,
  };
  await writeReport(reportPath, report);

  console.log(`runtime trace corpus mining: groups=${groups.length} comparisons=${compared} drifts=${drifts.length} failures=${failures.length}`);
  console.log(`Hard failures: ${hardFailures.length}`);
  console.log(`Drifts by language: ${Object.entries(driftCountsByLanguage).map(([language, count]) => `${language}=${count}`).join(' ')}`);
  console.log(`Drift classifications: ${Object.entries(report.classificationSummary.counts).map(([classification, count]) => `${classification}=${count}`).join(' ')}`);
  console.log(`Execution timing ms: ${Object.entries(executionTimingMs).map(([language, ms]) => `${language}=${Math.round(ms)}/${executionCounts[language as MineLanguage] ?? 0}`).join(' ')}`);
  console.log(`Execution cache: hits=${executionCache.hits} misses=${executionCache.misses}${executionCache.path ? ` path=${executionCache.path}` : ''}`);
  console.log(`Temporal invariant violations: ${report.temporalInvariantViolationCount}`);
  console.log(`Synthesized Java entries: ${synthesizedJavaEntries}`);
  console.log(`Report: ${reportPath}`);
  for (const cluster of driftClusters.slice(0, 5)) {
    const examples = cluster.examples.map((example) => `${example.slug}/${example.language}`).join(', ');
    console.log(`CLUSTER x${cluster.count} ${cluster.key} examples=${examples}`);
  }
  for (const cluster of operationTokenClusters.slice(0, 10)) {
    const examples = cluster.examples
      .map((example) => `${example.slug}/${example.language}->${example.comparedTo}`)
      .join(', ');
    console.log(`OP_TOKEN ${cluster.direction} x${cluster.count} ${cluster.token} examples=${examples}`);
  }
  for (const drift of drifts.slice(0, 10)) {
    console.log(`DRIFT ${drift.slug} ${drift.language} kinds=${drift.kinds.join(',')}`);
  }
  for (const failure of failures.slice(0, 10)) {
    console.log(`FAIL ${failure.slug} ${failure.language}: ${failure.error.split('\n')[0]}`);
  }

  if (failOnFailure && hardFailures.length > 0) {
    process.exitCode = 1;
  } else if (failOnDrift && (drifts.length > 0 || hardFailures.length > 0)) {
    process.exitCode = 1;
  }
  // VM-backed worker shims can leave non-critical timer handles behind after
  // timeout cases. This is a report generator, so exit explicitly once the
  // report is flushed.
  process.exit(process.exitCode ?? 0);
}

test('mine runtime trace corpus', main);
