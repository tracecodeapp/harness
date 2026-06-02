#!/usr/bin/env npx tsx

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const DEFAULT_ALGOFLOW_ROOT = process.env.TRACECODE_ALGOFLOW_ROOT || join(homedir(), 'Code', 'algoflow');
const DEFAULT_MULTILANG_ROOT = join(DEFAULT_ALGOFLOW_ROOT, 'experiments', 'trusted-visualizer-corpus');
const DEFAULT_PROBLEMS_ROOT = join(DEFAULT_MULTILANG_ROOT, 'generated-validated-cpp', 'problems');
const CPP_WORKER_PATH = join(process.cwd(), 'workers', 'cpp', 'cpp-worker.js');
const CPP_RUNTIME_HEADER_PATH = join(process.cwd(), 'workers', 'cpp', 'tracecode_runtime.hpp');
const YOWASP_COMPILER_BUNDLE_PATH = join(process.cwd(), 'node_modules', '@yowasp', 'clang', 'gen', 'bundle.js');

type ExecutionStyle = 'function' | 'solution-method' | 'ops-class';

interface AlgoflowProblem {
  slug: string;
  title?: string;
  executionStyle: ExecutionStyle;
  functionName: string;
  input: Record<string, unknown>;
  expectedOutput?: unknown;
  compareMode?: string;
}

interface CppWorkerResult {
  success: boolean;
  output: unknown;
  error?: string;
  errorLine?: number;
  consoleOutput?: string[];
  executionTimeMs?: number;
  trace?: {
    events?: Array<{ kind?: string }>;
    lineEventCount?: number;
    traceStepCount?: number;
  };
  lineEventCount?: number;
  traceStepCount?: number;
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
  generatedSource?: string;
}

interface CorpusRecord {
  slug: string;
  style: ExecutionStyle;
  compareMode: string;
  success: boolean;
  outputMatched: boolean;
  traceEvents: number;
  lineEvents: number;
  executionTimeMs: number;
  error?: string;
  errorLine?: number;
  expectedOutput?: unknown;
  receivedOutput?: unknown;
  languageComparisons?: LanguageComparison[];
}

interface LanguageComparison {
  language: 'javascript' | 'typescript' | 'python' | 'java';
  present: boolean;
  expectedMatched?: boolean;
  expectedOutput?: unknown;
  sourcePath?: string;
  problemPath?: string;
}

function parseStringFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseNumberFlag(name: string, fallback: number): number {
  const raw = parseStringFlag(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseLanguageListFlag(name: string): LanguageComparison['language'][] {
  const raw = parseStringFlag(name);
  if (!raw) return ['javascript', 'typescript', 'python', 'java'];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (value === 'js') return 'javascript';
      if (value === 'ts') return 'typescript';
      if (value === 'py') return 'python';
      if (value === 'javascript' || value === 'typescript' || value === 'python' || value === 'java') return value;
      throw new Error(`Unsupported --compare-languages entry: ${value}`);
    });
}

function stableStringify(value: unknown): string {
  value = normalizeOutputForComparison(value);
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const objectValue = value as Record<string, unknown>;
  return '{' + Object.keys(objectValue)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
    .join(',') + '}';
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
  if (typeof record.__id__ === 'string') refs.set(record.__id__, record);
  for (const child of Object.values(record)) collectSerializedRefs(child, refs, seen);
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
    if (key === '__id__' || key === '__class__' || key === '__type__') continue;
    if (key === 'value' && (looksLikeListNode || looksLikeTreeNode) && 'val' in input) continue;
    output[key] = normalizeOutputForComparison(child, refs, resolving);
  }
  return output;
}

function recursivelySortArrays(value: unknown): unknown {
  value = normalizeOutputForComparison(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => recursivelySortArrays(item))
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  }
  if (value === null || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort((left, right) => left.localeCompare(right))) {
    output[key] = recursivelySortArrays((value as Record<string, unknown>)[key]);
  }
  return output;
}

function valuesEqual(expected: unknown, received: unknown): boolean {
  if (typeof expected === 'number' && typeof received === 'number') {
    if (Object.is(expected, received)) return true;
    const scale = Math.max(1, Math.abs(expected), Math.abs(received));
    return Math.abs(expected - received) <= 1e-6 * scale;
  }
  if (Array.isArray(expected) || Array.isArray(received)) {
    if (!Array.isArray(expected) || !Array.isArray(received) || expected.length !== received.length) return false;
    return expected.every((entry, index) => valuesEqual(entry, received[index]));
  }
  if (expected && received && typeof expected === 'object' && typeof received === 'object') {
    const expectedEntries = Object.entries(expected as Record<string, unknown>);
    const receivedRecord = received as Record<string, unknown>;
    const receivedKeys = Object.keys(receivedRecord);
    if (expectedEntries.length !== receivedKeys.length) return false;
    return expectedEntries.every(([key, value]) => Object.prototype.hasOwnProperty.call(receivedRecord, key) && valuesEqual(value, receivedRecord[key]));
  }
  return stableStringify(expected) === stableStringify(received);
}

function outputsEqual(expected: unknown, received: unknown, compareMode: string): boolean {
  if (compareMode === 'unordered-array' || (compareMode === 'any-valid' && hasFlag('loose-any-valid-output'))) {
    return valuesEqual(recursivelySortArrays(expected), recursivelySortArrays(received));
  }
  return valuesEqual(normalizeOutputForComparison(expected), normalizeOutputForComparison(received));
}

function tailString(value: string, maxLength = 1600): string {
  if (value.length <= maxLength) return value;
  const left = Math.floor(maxLength / 2);
  const right = Math.ceil(maxLength / 2);
  return `${value.slice(0, left)}\n...[truncated ${value.length - maxLength} chars]...\n${value.slice(value.length - right)}`;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function createCppWorkerHarness() {
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
    workerSource + '\nglobalThis.__tracecodeCppCorpus = { handleInit, handleCompileRun, handleExecuteWithTracing };',
    {
      importModuleDynamically(specifier) {
        return import(specifier);
      },
    }
  );
  await script.runInContext(context);

  const api = sandbox.__tracecodeCppCorpus as {
    handleInit: (payload: unknown) => Promise<CppWorkerResult>;
    handleCompileRun: (payload: unknown) => Promise<CppWorkerResult>;
    handleExecuteWithTracing: (payload: unknown) => Promise<CppWorkerResult>;
  };

  await api.handleInit({
    assets: {
      compilerBundleUrl: pathToFileURL(YOWASP_COMPILER_BUNDLE_PATH).href,
      clangWasmUrl: 'file:///missing/clang.wasm',
      lldWasmUrl: 'file:///missing/lld.wasm',
      sysrootUrl: 'file:///missing/sysroot.tar',
      runtimeHeaderUrl: pathToFileURL(CPP_RUNTIME_HEADER_PATH).href,
    },
  });

  return api;
}

async function loadProblem(root: string, slug: string): Promise<{ problem: AlgoflowProblem; code: string }> {
  const problemDir = join(root, slug);
  const problem = await readJsonFile<AlgoflowProblem>(join(problemDir, 'problem.json'));
  const code = await readFile(join(problemDir, 'cpp.cpp'), 'utf8');
  return { problem, code };
}

function comparisonProblemRoots(multilangRoot: string): Record<LanguageComparison['language'], string> {
  return {
    javascript: join(multilangRoot, 'generated-validated-candidates', 'problems'),
    typescript: join(multilangRoot, 'generated-validated-candidates', 'problems'),
    python: join(multilangRoot, 'generated-validated-candidates', 'problems'),
    java: join(multilangRoot, 'generated-validated-java', 'problems'),
  };
}

function comparisonSourceName(language: LanguageComparison['language']): string {
  if (language === 'javascript') return 'javascript.js';
  if (language === 'typescript') return 'typescript.ts';
  if (language === 'python') return 'python.py';
  return 'java.java';
}

async function compareLanguageCorpusEntries(
  slug: string,
  cppExpectedOutput: unknown,
  compareMode: string,
  multilangRoot: string,
  languages: LanguageComparison['language'][]
): Promise<LanguageComparison[]> {
  const roots = comparisonProblemRoots(multilangRoot);
  const comparisons: LanguageComparison[] = [];
  for (const language of languages) {
    const problemDir = join(roots[language], slug);
    const problemPath = join(problemDir, 'problem.json');
    const sourcePath = join(problemDir, comparisonSourceName(language));
    if (!existsSync(problemPath) || !existsSync(sourcePath)) {
      comparisons.push({ language, present: false });
      continue;
    }
    try {
      const problem = await readJsonFile<AlgoflowProblem>(problemPath);
      comparisons.push({
        language,
        present: true,
        expectedMatched: outputsEqual(cppExpectedOutput, problem.expectedOutput, problem.compareMode || compareMode),
        expectedOutput: problem.expectedOutput,
        problemPath,
        sourcePath,
      });
    } catch {
      comparisons.push({ language, present: false, problemPath, sourcePath });
    }
  }
  return comparisons;
}

async function discoverSlugs(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'problem.json')) && existsSync(join(root, entry.name, 'cpp.cpp')))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function runProblem(
  api: Awaited<ReturnType<typeof createCppWorkerHarness>>,
  root: string,
  slug: string,
  trace: boolean,
  maxStoredEvents: number,
  compareLanguages: boolean,
  multilangRoot: string,
  languages: LanguageComparison['language'][]
): Promise<CorpusRecord> {
  const { problem, code } = await loadProblem(root, slug);
  const payload = {
    code,
    functionName: problem.functionName,
    inputs: problem.input,
    executionStyle: problem.executionStyle,
    options: {
      maxStoredEvents,
    },
  };
  const result = trace
    ? await api.handleExecuteWithTracing(payload)
    : await api.handleCompileRun(payload);
  const compareMode = problem.compareMode || 'exact';
  const outputMatched = result.success && outputsEqual(problem.expectedOutput, result.output, compareMode);
  const languageComparisons = compareLanguages
    ? await compareLanguageCorpusEntries(slug, problem.expectedOutput, compareMode, multilangRoot, languages)
    : undefined;
  return {
    slug,
    style: problem.executionStyle,
    compareMode,
    success: result.success,
    outputMatched,
    traceEvents: result.trace?.events?.length ?? 0,
    lineEvents: result.trace?.lineEventCount ?? result.lineEventCount ?? 0,
    executionTimeMs: result.executionTimeMs ?? 0,
    ...(result.error ? { error: tailString(result.error) } : {}),
    ...(typeof result.errorLine === 'number' ? { errorLine: result.errorLine } : {}),
    ...(outputMatched ? {} : { expectedOutput: problem.expectedOutput, receivedOutput: result.output }),
    ...(languageComparisons ? { languageComparisons } : {}),
  };
}

function childMineArgs(reportPath: string, slug: string): string[] {
  const blocked = new Set(['jobs', 'report', 'limit', 'offset', 'sample', 'batch-size']);
  const args = process.argv.slice(2).filter((arg) => {
    if (arg === '--worker') return false;
    const match = /^--([^=]+)/.exec(arg);
    return !match || !blocked.has(match[1]);
  });
  return [...args, '--worker', `--sample=${slug}`, `--report=${reportPath}`];
}

async function runConcurrentMine(root: string, discovered: string[], reportPath: string, jobs: number): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'tracecode-cpp-corpus-shards-'));
  const scriptPath = resolve(process.argv[1]);
  const workerTimeoutMs = parseNumberFlag('worker-timeout-ms', 180_000);
  const batchSize = Math.max(1, parseNumberFlag('batch-size', 1));
  const records: CorpusRecord[] = [];
  let nextIndex = 0;

  async function runBatch(index: number): Promise<void> {
    const batchSlugs = discovered.slice(index, Math.min(discovered.length, index + batchSize));
    const lastIndex = index + batchSlugs.length - 1;
    const childReportPath = join(
      workDir,
      `${String(index).padStart(6, '0')}-${String(lastIndex).padStart(6, '0')}.json`
    );
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolvePromise, reject) => {
      const child = spawn('pnpm', ['exec', 'tsx', scriptPath, ...childMineArgs(childReportPath, batchSlugs.join(','))], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            process.kill(-child.pid, 'SIGKILL');
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
      for (const slug of batchSlugs) {
        records.push({
          slug,
          style: 'solution-method',
          compareMode: 'exact',
          success: false,
          outputMatched: false,
          traceEvents: 0,
          lineEvents: 0,
          executionTimeMs: workerTimeoutMs,
          error: tailString(
            output.timedOut
              ? `runner-process-timeout: child batch exceeded ${workerTimeoutMs}ms\n${output.stderr || output.stdout}`
              : `runner-process-crash: child batch exited with ${output.code}\n${output.stderr || output.stdout}`,
            12_000
          ),
        });
      }
      return;
    }
    const childReport = JSON.parse(await readFile(childReportPath, 'utf8')) as { records?: CorpusRecord[] };
    records.push(...(childReport.records ?? []));
  }

  async function worker(): Promise<void> {
    while (nextIndex < discovered.length) {
      const index = nextIndex;
      nextIndex += batchSize;
      await runBatch(index);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, jobs) }, () => worker()));
  records.sort((left, right) => discovered.indexOf(left.slug) - discovered.indexOf(right.slug));

  const failures = records.filter((record) => !record.success);
  const mismatches = records.filter((record) => record.success && !record.outputMatched);
  const missingTrace = hasFlag('no-trace') ? [] : records.filter((record) => record.success && record.outputMatched && record.traceEvents === 0);
  const languageComparisons = records.flatMap((record) => record.languageComparisons ?? []);
  const languageCoverage = summarizeLanguageCoverage(languageComparisons);
  const report = {
    problemsRoot: root,
    offset: parseNumberFlag('offset', 0),
    limit: parseNumberFlag('limit', 20),
    trace: !hasFlag('no-trace'),
    maxStoredEvents: parseNumberFlag('max-stored-events', 2000),
    jobs,
    batchSize,
    workerTimeoutMs,
    workerReportDir: workDir,
    scanned: records.length,
    passed: records.length - failures.length - mismatches.length - missingTrace.length,
    failures: failures.length,
    mismatches: mismatches.length,
    missingTrace: missingTrace.length,
    languageCoverage,
    records,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(
    `\nC++ Algoflow corpus concurrent: scanned=${report.scanned} passed=${report.passed} ` +
      `failures=${report.failures} mismatches=${report.mismatches} missingTrace=${report.missingTrace}`
  );
  console.log(`Language coverage: ${Object.entries(languageCoverage).map(([language, summary]) => `${language}=${summary.present}/${summary.total} matched=${summary.expectedMatched}`).join(' ')}`);
  console.log(`Worker reports: ${workDir}`);
  if (hasFlag('fail-on-failure') && (failures.length > 0 || mismatches.length > 0 || missingTrace.length > 0)) {
    process.exitCode = 1;
  }
}

function summarizeLanguageCoverage(comparisons: LanguageComparison[]): Record<string, { total: number; present: number; missing: number; expectedMatched: number; expectedMismatched: number }> {
  const summary: Record<string, { total: number; present: number; missing: number; expectedMatched: number; expectedMismatched: number }> = {};
  for (const comparison of comparisons) {
    const entry = summary[comparison.language] ?? { total: 0, present: 0, missing: 0, expectedMatched: 0, expectedMismatched: 0 };
    entry.total += 1;
    if (comparison.present) entry.present += 1;
    else entry.missing += 1;
    if (comparison.present && comparison.expectedMatched === true) entry.expectedMatched += 1;
    if (comparison.present && comparison.expectedMatched === false) entry.expectedMismatched += 1;
    summary[comparison.language] = entry;
  }
  return summary;
}

async function main() {
  const root = parseStringFlag('problems-root') || DEFAULT_PROBLEMS_ROOT;
  if (!existsSync(root)) {
    throw new Error(`Algoflow C++ problems root does not exist: ${root}`);
  }

  const sampleFlag = parseStringFlag('sample');
  const offset = parseNumberFlag('offset', 0);
  const limit = parseNumberFlag('limit', sampleFlag ? 0 : 20);
  const maxStoredEvents = parseNumberFlag('max-stored-events', 2000);
  const trace = !hasFlag('no-trace');
  const failOnFailure = hasFlag('fail-on-failure');
  const reportPath = parseStringFlag('report');
  const jobs = parseNumberFlag('jobs', 1);
  const compareLanguages = hasFlag('compare-languages') || Boolean(parseStringFlag('compare-languages'));
  const compareLanguageList = parseLanguageListFlag('compare-languages');
  const multilangRoot = parseStringFlag('multilang-root') || DEFAULT_MULTILANG_ROOT;

  const discovered = sampleFlag
    ? sampleFlag.split(',').map((slug) => slug.trim()).filter(Boolean)
    : (await discoverSlugs(root)).slice(offset, limit > 0 ? offset + limit : undefined);

  if (!hasFlag('worker') && (jobs > 1 || Boolean(parseStringFlag('worker-timeout-ms')))) {
    await runConcurrentMine(root, discovered, reportPath ? resolve(reportPath) : join(process.cwd(), 'reports', 'cpp-algoflow-corpus.json'), jobs);
    process.exit(process.exitCode ?? 0);
  }

  const api = await createCppWorkerHarness();
  const records: CorpusRecord[] = [];

  for (const [index, slug] of discovered.entries()) {
    try {
      const record = await runProblem(api, root, slug, trace, maxStoredEvents, compareLanguages, multilangRoot, compareLanguageList);
      records.push(record);
      const status = record.success && record.outputMatched ? 'ok' : record.success ? 'mismatch' : 'fail';
      console.log(
        `[${index + 1}/${discovered.length}] ${status} ${slug} ` +
          `style=${record.style} traceEvents=${record.traceEvents} timeMs=${record.executionTimeMs}`
      );
      if (status !== 'ok' && record.error) {
        console.log(`  ${record.error.split(/\r?\n/).slice(0, 4).join('\n  ')}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      records.push({
        slug,
        style: 'solution-method',
        compareMode: 'exact',
        success: false,
        outputMatched: false,
        traceEvents: 0,
        lineEvents: 0,
        executionTimeMs: 0,
        error: tailString(message),
      });
      console.log(`[${index + 1}/${discovered.length}] fail ${slug}`);
      console.log(`  ${message.split(/\r?\n/).slice(0, 4).join('\n  ')}`);
    }
  }

  const failures = records.filter((record) => !record.success);
  const mismatches = records.filter((record) => record.success && !record.outputMatched);
  const missingTrace = trace ? records.filter((record) => record.success && record.outputMatched && record.traceEvents === 0) : [];
  const languageComparisons = records.flatMap((record) => record.languageComparisons ?? []);
  const report = {
    problemsRoot: root,
    offset,
    limit,
    trace,
    maxStoredEvents,
    scanned: records.length,
    passed: records.length - failures.length - mismatches.length - missingTrace.length,
    failures: failures.length,
    mismatches: mismatches.length,
    missingTrace: missingTrace.length,
    languageCoverage: summarizeLanguageCoverage(languageComparisons),
    records,
  };

  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(
    `\nC++ Algoflow corpus: scanned=${report.scanned} passed=${report.passed} ` +
      `failures=${report.failures} mismatches=${report.mismatches} missingTrace=${report.missingTrace}`
  );
  if (languageComparisons.length > 0) {
    console.log(`Language coverage: ${Object.entries(report.languageCoverage).map(([language, summary]) => `${language}=${summary.present}/${summary.total} matched=${summary.expectedMatched}`).join(' ')}`);
  }
  for (const record of [...failures, ...mismatches, ...missingTrace].slice(0, 10)) {
    console.log(`- ${record.slug}: ${record.error || `expected ${stableStringify(record.expectedOutput)}, received ${stableStringify(record.receivedOutput)}`}`);
  }

  if (failOnFailure && (failures.length > 0 || mismatches.length > 0 || missingTrace.length > 0)) {
    process.exitCode = 1;
  }
}

await main();
