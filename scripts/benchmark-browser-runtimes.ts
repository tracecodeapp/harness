#!/usr/bin/env npx tsx

/**
 * End-to-end benchmark for the public Classic browser harness.
 *
 * This intentionally imports createBrowserHarness() in a real browser and only uses
 * BrowserHarness/RuntimeClient methods. It does not speak private worker
 * protocols, so changes to worker scheduling, cloning, and client adapters are
 * represented in the measurements consumers actually see.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type Request } from 'playwright';

type Language = 'python' | 'javascript' | 'typescript' | 'java' | 'csharp' | 'cpp';
type BrowserEngine = 'chromium' | 'firefox' | 'webkit';
type Mode = 'execute' | 'trace';
type ExecutionIsolation = 'safe' | 'unsafe-reuse';
type Phase =
  | 'cold-first-execute'
  | 'warm-exact-repeat'
  | 'warm-edited-source'
  | 'multiple-inputs'
  | 'concurrent-executes'
  | 'trace';

interface BenchmarkArgs {
  engine: BrowserEngine;
  languages: Language[];
  workloads: string[];
  modes: Mode[];
  iterations: number;
  caseLimit: number | null;
  requestTimeoutMs: number;
  seed: number;
  headful: boolean;
  smoke: boolean;
  cacheAssets: boolean;
  phaseDelayMs: number;
  prewarmRuntime: boolean;
  executionIsolation: ExecutionIsolation;
  concurrency: number;
  runtimeManifestsPath: string | null;
  reportPath: string | null;
}

interface TestCase {
  name: string;
  inputs: Record<string, unknown>;
  expected: unknown;
}

interface Workload {
  id: string;
  label: string;
  sources: Record<Language, string>;
  functionNames: Record<Language, string>;
  executionStyles: Record<Language, 'function' | 'solution-method'>;
  cases: TestCase[];
}

interface RuntimeTimingRecord {
  totalMs?: number;
  initMs?: number;
  warmupMs?: number;
  compilerLoadMs?: number;
  rewriteMs?: number;
  driverBuildMs?: number;
  compileMs?: number;
  pchMs?: number;
  linkMs?: number;
  wasmCompileMs?: number;
  classLoadMs?: number;
  runMs?: number;
  hostCallMs?: number;
  compileCacheHit?: boolean;
  artifactCacheHit?: boolean;
  pchCacheHit?: boolean;
}

interface BrowserMemorySnapshot {
  source: 'performance.memory';
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface ResourceTimingSummary {
  entries: number;
  transferBytes: number;
  encodedBodyBytes: number;
  decodedBodyBytes: number;
  durationMs: number;
}

interface LongTaskSummary {
  supported: boolean;
  count?: number;
  totalDurationMs?: number;
  maxDurationMs?: number;
}

interface PhaseRecord {
  language: Language;
  workloadId: string;
  workloadLabel: string;
  iteration: number;
  runOrdinal: number;
  phase: Phase;
  mode: Mode;
  sourceVariant: 'base' | 'edited';
  caseCount: number;
  concurrency: number;
  wallMs: number;
  success: boolean;
  outputs: unknown[];
  expected: unknown[];
  errors: string[];
  timings?: RuntimeTimingRecord;
  caseTimings: RuntimeTimingRecord[];
  artifactCacheHits?: boolean[];
  responseSerializedBytes: number;
  traceSerializedBytes?: number;
  traceEventCount?: number;
  lineEventCount?: number;
  traceStepCount?: number;
  resourceTiming: ResourceTimingSummary;
  longTasks: LongTaskSummary;
  memoryBefore?: BrowserMemorySnapshot;
  memoryAfter?: BrowserMemorySnapshot;
  unsupportedMetrics: string[];
}

interface InitRecord {
  language: Language;
  workloadId: string;
  iteration: number;
  runOrdinal: number;
  harnessConstructionMs: number;
  moduleImportMs: number;
  wallMs: number;
  runtimeLoadTimeMs?: number;
  runtimeWarmupWallMs?: number;
  runtimeWarmupLoadTimeMs?: number;
  success: boolean;
  error?: string;
  resourceTiming: ResourceTimingSummary;
  longTasks: LongTaskSummary;
  memoryBefore?: BrowserMemorySnapshot;
  memoryAfter?: BrowserMemorySnapshot;
}

interface BrowserRunResult {
  userAgent: string;
  crossOriginIsolated: boolean;
  memorySupport: {
    performanceMemory: boolean;
    userAgentSpecificMemory: boolean;
  };
  longTaskSupport: boolean;
  init: InitRecord;
  records: PhaseRecord[];
}

interface NetworkResourceRecord {
  runOrdinal: number;
  language: Language;
  workloadId: string;
  phase: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  protocol?: string;
  contentType?: string;
  contentLength?: number;
  /** Encoded response body bytes, falling back to Content-Length for worker requests Chromium reports as zero. */
  encodedBodyBytes?: number;
  requestHeadersBytes?: number;
  requestBodyBytes?: number;
  responseHeadersBytes?: number;
  responseBodyBytes?: number;
  /** Request plus response headers/body bytes observed on the wire. */
  totalTransferBytes?: number;
  startTimeMs?: number;
  responseStartMs?: number;
  responseEndMs?: number;
  failed?: string;
}

interface RunPlanItem {
  language: Language;
  workload: Workload;
  iteration: number;
  runOrdinal: number;
}

interface SummaryRecord {
  language: Language;
  workloadId: string;
  phase: Phase;
  samples: number;
  passed: number;
  wallP50Ms: number;
  wallP95Ms: number;
  wallAvgMs: number;
  totalAvgMs?: number;
  compileAvgMs?: number;
  runAvgMs?: number;
  traceEventsAvg?: number;
  responseBytesAvg: number;
  traceBytesAvg?: number;
  longTaskTotalAvgMs?: number;
  heapDeltaAvgBytes?: number;
  cacheHits?: number;
  cacheKnown?: number;
}

const ALL_LANGUAGES: Language[] = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'];
const ALL_ENGINES: BrowserEngine[] = ['chromium', 'firefox', 'webkit'];
const ALL_MODES: Mode[] = ['execute', 'trace'];
const DEFAULT_SEED = 17_729;

const addCases: TestCase[] = [
  { name: 'positive', inputs: { a: 2, b: 3 }, expected: 5 },
  { name: 'different-values', inputs: { a: 5, b: 6 }, expected: 11 },
  { name: 'negative', inputs: { a: -4, b: 9 }, expected: 5 },
  { name: 'zero', inputs: { a: 0, b: 0 }, expected: 0 },
  { name: 'large', inputs: { a: 12_345, b: 67_890 }, expected: 80_235 },
];

const twoSumCases: TestCase[] = [
  { name: 'front-pair', inputs: { nums: [2, 7, 11, 15], target: 9 }, expected: [0, 1] },
  { name: 'middle-pair', inputs: { nums: [3, 2, 4], target: 6 }, expected: [1, 2] },
  { name: 'duplicates', inputs: { nums: [3, 3], target: 6 }, expected: [0, 1] },
  { name: 'late-pair', inputs: { nums: [1, 5, 9, 12, 15, 18], target: 30 }, expected: [3, 5] },
];

function walkExpected(nums: number[]): number {
  return nums.reduce((total, value, index) => (
    index % 2 === 0
      ? total + value * (index + 1)
      : total - value * (index + 1)
  ), 0);
}

function walkCase(name: string, nums: number[]): TestCase {
  return { name, inputs: { nums }, expected: walkExpected(nums) };
}

const walkCases: TestCase[] = [
  walkCase('tiny', [1, 2, 3, 4]),
  walkCase('mixed', [5, -2, 7, 0, 3, 9]),
  walkCase('ascending', Array.from({ length: 24 }, (_, index) => index + 1)),
  walkCase('wide', Array.from({ length: 48 }, (_, index) => (index % 7) - 3)),
];

const WORKLOADS: Workload[] = [
  {
    id: 'add',
    label: 'Add',
    functionNames: {
      python: 'add',
      javascript: 'add',
      typescript: 'add',
      java: 'sum',
      csharp: 'Sum',
      cpp: 'sum',
    },
    executionStyles: {
      python: 'function',
      javascript: 'function',
      typescript: 'function',
      java: 'solution-method',
      csharp: 'solution-method',
      cpp: 'solution-method',
    },
    sources: {
      python: 'def add(a, b):\n    return a + b',
      javascript: 'function add(a, b) { return a + b; }',
      typescript: 'function add(a: number, b: number): number { return a + b; }',
      java: [
        'class Solution {',
        '  int sum(int a, int b) {',
        '    return a + b;',
        '  }',
        '}',
      ].join('\n'),
      csharp: [
        'public class Solution {',
        '  public int Sum(int a, int b) {',
        '    return a + b;',
        '  }',
        '}',
      ].join('\n'),
      cpp: 'class Solution { public: int sum(int a, int b) { return a + b; } };',
    },
    cases: addCases,
  },
  {
    id: 'two-sum',
    label: 'Two Sum',
    functionNames: {
      python: 'two_sum',
      javascript: 'twoSum',
      typescript: 'twoSum',
      java: 'twoSum',
      csharp: 'TwoSum',
      cpp: 'twoSum',
    },
    executionStyles: {
      python: 'function',
      javascript: 'function',
      typescript: 'function',
      java: 'solution-method',
      csharp: 'solution-method',
      cpp: 'solution-method',
    },
    sources: {
      python: [
        'def two_sum(nums, target):',
        '    seen = {}',
        '    for i, value in enumerate(nums):',
        '        complement = target - value',
        '        if complement in seen:',
        '            return [seen[complement], i]',
        '        seen[value] = i',
        '    return []',
      ].join('\n'),
      javascript: [
        'function twoSum(nums, target) {',
        '  const seen = new Map();',
        '  for (let i = 0; i < nums.length; i += 1) {',
        '    const complement = target - nums[i];',
        '    if (seen.has(complement)) return [seen.get(complement), i];',
        '    seen.set(nums[i], i);',
        '  }',
        '  return [];',
        '}',
      ].join('\n'),
      typescript: [
        'function twoSum(nums: number[], target: number): number[] {',
        '  const seen = new Map<number, number>();',
        '  for (let i = 0; i < nums.length; i += 1) {',
        '    const complement = target - nums[i];',
        '    if (seen.has(complement)) return [seen.get(complement)!, i];',
        '    seen.set(nums[i], i);',
        '  }',
        '  return [];',
        '}',
      ].join('\n'),
      java: [
        'import java.util.*;',
        'class Solution {',
        '  int[] twoSum(int[] nums, int target) {',
        '    Map<Integer, Integer> seen = new HashMap<>();',
        '    for (int i = 0; i < nums.length; i++) {',
        '      int complement = target - nums[i];',
        '      if (seen.containsKey(complement)) return new int[] { seen.get(complement), i };',
        '      seen.put(nums[i], i);',
        '    }',
        '    return new int[0];',
        '  }',
        '}',
      ].join('\n'),
      csharp: [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int[] TwoSum(int[] nums, int target) {',
        '    var seen = new Dictionary<int, int>();',
        '    for (int i = 0; i < nums.Length; i++) {',
        '      int complement = target - nums[i];',
        '      if (seen.ContainsKey(complement)) return new[] { seen[complement], i };',
        '      seen[nums[i]] = i;',
        '    }',
        '    return new int[0];',
        '  }',
        '}',
      ].join('\n'),
      cpp: [
        'class Solution {',
        'public:',
        '  vector<int> twoSum(vector<int>& nums, int target) {',
        '    unordered_map<int, int> seen;',
        '    for (int i = 0; i < nums.size(); ++i) {',
        '      int complement = target - nums[i];',
        '      if (seen.count(complement)) return {seen[complement], i};',
        '      seen[nums[i]] = i;',
        '    }',
        '    return {};',
        '  }',
        '};',
      ].join('\n'),
    },
    cases: twoSumCases,
  },
  {
    id: 'loop-walk',
    label: 'Loop Walk',
    functionNames: {
      python: 'walk',
      javascript: 'walk',
      typescript: 'walk',
      java: 'walk',
      csharp: 'Walk',
      cpp: 'walk',
    },
    executionStyles: {
      python: 'function',
      javascript: 'function',
      typescript: 'function',
      java: 'solution-method',
      csharp: 'solution-method',
      cpp: 'solution-method',
    },
    sources: {
      python: [
        'def walk(nums):',
        '    total = 0',
        '    for i, value in enumerate(nums):',
        '        if i % 2 == 0:',
        '            total += value * (i + 1)',
        '        else:',
        '            total -= value * (i + 1)',
        '    return total',
      ].join('\n'),
      javascript: [
        'function walk(nums) {',
        '  let total = 0;',
        '  for (let i = 0; i < nums.length; i += 1) {',
        '    if ((i & 1) === 0) total += nums[i] * (i + 1);',
        '    else total -= nums[i] * (i + 1);',
        '  }',
        '  return total;',
        '}',
      ].join('\n'),
      typescript: [
        'function walk(nums: number[]): number {',
        '  let total = 0;',
        '  for (let i = 0; i < nums.length; i += 1) {',
        '    if ((i & 1) === 0) total += nums[i] * (i + 1);',
        '    else total -= nums[i] * (i + 1);',
        '  }',
        '  return total;',
        '}',
      ].join('\n'),
      java: [
        'class Solution {',
        '  int walk(int[] nums) {',
        '    int total = 0;',
        '    for (int i = 0; i < nums.length; i++) {',
        '      if ((i & 1) == 0) total += nums[i] * (i + 1);',
        '      else total -= nums[i] * (i + 1);',
        '    }',
        '    return total;',
        '  }',
        '}',
      ].join('\n'),
      csharp: [
        'public class Solution {',
        '  public int Walk(int[] nums) {',
        '    int total = 0;',
        '    for (int i = 0; i < nums.Length; i++) {',
        '      if ((i & 1) == 0) total += nums[i] * (i + 1);',
        '      else total -= nums[i] * (i + 1);',
        '    }',
        '    return total;',
        '  }',
        '}',
      ].join('\n'),
      cpp: [
        'class Solution {',
        'public:',
        '  int walk(vector<int>& nums) {',
        '    int total = 0;',
        '    for (int i = 0; i < nums.size(); ++i) {',
        '      if ((i & 1) == 0) total += nums[i] * (i + 1);',
        '      else total -= nums[i] * (i + 1);',
        '    }',
        '    return total;',
        '  }',
        '};',
      ].join('\n'),
    },
    cases: walkCases,
  },
];

function usage(): string {
  return [
    'Usage: pnpm bench:browser-runtimes [options]',
    '',
    'Benchmarks the public createBrowserHarness() Classic API in a real browser.',
    '',
    'Options:',
    '  --engine=chromium|firefox|webkit Browser engine. Default: chromium.',
    '  --languages=python,javascript,typescript,java,csharp,cpp',
    '                                  Browser runtimes to benchmark. Default: all.',
    '  --workloads=add,two-sum         Workloads to run. Default: all.',
    '  --modes=execute,trace          Public request modes. Default: all.',
    '  --iterations=5                  Fresh-context samples per language/workload. Default: 5 (smoke: 1).',
    '  --case-limit=2                  Limit cases used by the multi-input phase.',
    `  --seed=${DEFAULT_SEED}                 Deterministic run-order shuffle seed.`,
    '  --request-timeout-ms=180000     Per public API operation timeout. Default: 180000.',
    '  --runtime-manifests=file.json    Consumer-owned cross-runtime asset manifests.',
    '  --smoke                         Quick JS/add/execute run unless explicitly overridden.',
    '  --report=reports/file.json      JSON report path.',
    '  --no-report                     Do not write a JSON report.',
    '  --cache-assets                  Serve immutable cache headers so warm phases exclude downloads.',
    '  --phase-delay-ms=25             Delay between phases to model interactive think time. Default: 0.',
    '  --prewarm-runtime               Call harness.warmLanguage() before the first measured execute.',
    '  --execution-isolation=safe|unsafe-reuse',
    '                                  Runtime worker lifecycle. Default: safe.',
    '  --concurrency=4                 Add a phase with this many simultaneous executes. Default: 1 (disabled).',
    '  --headful                       Run the selected browser with a visible window.',
  ].join('\n');
}

function parseCsv<T extends string>(raw: string, allowed: readonly T[], label: string): T[] {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean) as T[];
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new Error(`Unsupported ${label} "${value}". Expected one of: ${allowed.join(', ')}`);
    }
  }
  if (values.length === 0) {
    throw new Error(`Expected at least one ${label}.`);
  }
  return [...new Set(values)];
}

function positiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected --${label} to be a positive integer, received "${raw}".`);
  }
  return value;
}

function nonNegativeInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected --${label} to be a non-negative safe integer, received "${raw}".`);
  }
  return value;
}

function parseArgs(argv: string[]): BenchmarkArgs {
  const args: BenchmarkArgs = {
    engine: 'chromium',
    languages: ALL_LANGUAGES,
    workloads: WORKLOADS.map((workload) => workload.id),
    modes: ALL_MODES,
    iterations: 5,
    caseLimit: null,
    requestTimeoutMs: 180_000,
    seed: DEFAULT_SEED,
    headful: false,
    smoke: false,
    cacheAssets: false,
    phaseDelayMs: 0,
    prewarmRuntime: false,
    executionIsolation: 'safe',
    concurrency: 1,
    runtimeManifestsPath: process.env.TRACECODE_BENCH_RUNTIME_MANIFESTS?.trim() || null,
    reportPath: join('reports', 'browser-runtime-benchmark.json'),
  };
  let explicitLanguages = false;
  let explicitWorkloads = false;
  let explicitModes = false;
  let explicitIterations = false;
  let explicitCaseLimit = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--headful') {
      args.headful = true;
      continue;
    }
    if (arg.startsWith('--engine=')) {
      args.engine = parseCsv(arg.slice('--engine='.length), ALL_ENGINES, 'engine')[0]!;
      continue;
    }
    if (arg === '--smoke' || arg === '--quick') {
      args.smoke = true;
      continue;
    }
    if (arg === '--no-report') {
      args.reportPath = null;
      continue;
    }
    if (arg === '--cache-assets') {
      args.cacheAssets = true;
      continue;
    }
    if (arg === '--prewarm-runtime') {
      args.prewarmRuntime = true;
      continue;
    }
    if (arg.startsWith('--execution-isolation=')) {
      const isolation = arg.slice('--execution-isolation='.length);
      if (isolation !== 'safe' && isolation !== 'unsafe-reuse') {
        throw new Error(`Unsupported execution isolation "${isolation}". Expected safe or unsafe-reuse.`);
      }
      args.executionIsolation = isolation;
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      args.concurrency = positiveInteger(arg.slice('--concurrency='.length), 'concurrency');
      continue;
    }
    if (arg.startsWith('--languages=')) {
      args.languages = parseCsv(arg.slice('--languages='.length), ALL_LANGUAGES, 'language');
      explicitLanguages = true;
      continue;
    }
    if (arg.startsWith('--workloads=')) {
      args.workloads = parseCsv(arg.slice('--workloads='.length), WORKLOADS.map((workload) => workload.id), 'workload');
      explicitWorkloads = true;
      continue;
    }
    if (arg.startsWith('--modes=')) {
      args.modes = parseCsv(arg.slice('--modes='.length), ALL_MODES, 'mode');
      explicitModes = true;
      continue;
    }
    if (arg.startsWith('--iterations=')) {
      args.iterations = positiveInteger(arg.slice('--iterations='.length), 'iterations');
      explicitIterations = true;
      continue;
    }
    if (arg.startsWith('--case-limit=')) {
      args.caseLimit = positiveInteger(arg.slice('--case-limit='.length), 'case-limit');
      explicitCaseLimit = true;
      continue;
    }
    if (arg.startsWith('--request-timeout-ms=')) {
      args.requestTimeoutMs = positiveInteger(arg.slice('--request-timeout-ms='.length), 'request-timeout-ms');
      continue;
    }
    if (arg.startsWith('--phase-delay-ms=')) {
      args.phaseDelayMs = nonNegativeInteger(arg.slice('--phase-delay-ms='.length), 'phase-delay-ms');
      continue;
    }
    if (arg.startsWith('--seed=')) {
      args.seed = nonNegativeInteger(arg.slice('--seed='.length), 'seed');
      continue;
    }
    if (arg.startsWith('--runtime-manifests=')) {
      const manifestPath = arg.slice('--runtime-manifests='.length).trim();
      if (!manifestPath) throw new Error('--runtime-manifests requires a non-empty path.');
      args.runtimeManifestsPath = manifestPath;
      continue;
    }
    if (arg.startsWith('--report=')) {
      const reportPath = arg.slice('--report='.length).trim();
      if (!reportPath) throw new Error('--report requires a non-empty path.');
      args.reportPath = reportPath;
      continue;
    }
    throw new Error(`Unknown option "${arg}".\n${usage()}`);
  }

  if (args.smoke) {
    if (!explicitLanguages) args.languages = ['javascript'];
    if (!explicitWorkloads) args.workloads = ['add'];
    if (!explicitModes) args.modes = ['execute'];
    if (!explicitIterations) args.iterations = 1;
    if (!explicitCaseLimit) args.caseLimit = 2;
  }

  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadRuntimeManifests(pathname: string | null): Promise<Record<string, unknown> | undefined> {
  if (!pathname) return undefined;
  const absolutePath = resolve(process.cwd(), pathname);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read browser runtime manifests from ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Browser runtime manifest file ${absolutePath} must contain a JSON object.`);
  }
  const manifests = isRecord(parsed.runtimeManifests) ? parsed.runtimeManifests : parsed;
  if (Object.keys(manifests).length === 0) {
    throw new Error(`Browser runtime manifest file ${absolutePath} does not contain any runtime entries.`);
  }
  return manifests;
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.tar':
      return 'application/x-tar';
    case '.jar':
      return 'application/java-archive';
    default:
      return 'application/octet-stream';
  }
}

async function runAssetSync(targetDir: string, languages: readonly Language[]): Promise<void> {
  const cliPath = resolve(process.cwd(), 'src/cli.ts');
  const tsxCliPath = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      tsxCliPath,
      cliPath,
      'sync-assets',
      targetDir,
      '--languages',
      languages.join(','),
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', (chunk) => process.stdout.write(String(chunk)));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Asset sync exited with code ${code}\n${stderr}`));
    });
  });
}

async function buildPublicHarnessBundle(tempRoot: string): Promise<{
  path: string;
  rawBytes: number;
  gzipBytes: number;
  buildMs: number;
}> {
  const outfile = join(tempRoot, 'benchmark-harness.mjs');
  const startedAt = performance.now();
  await build({
    entryPoints: [resolve(process.cwd(), 'src/browser.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: false,
    logLevel: 'warning',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });
  const buildMs = performance.now() - startedAt;
  const source = await readFile(outfile);
  return {
    path: outfile,
    rawBytes: source.byteLength,
    gzipBytes: gzipSync(source).byteLength,
    buildMs,
  };
}

async function startStaticServer(root: string, cacheAssets: boolean): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const candidate = normalize(join(root, decodedPath));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404, {
        'Access-Control-Allow-Origin': '*',
        'Timing-Allow-Origin': '*',
      });
      response.end('Not found');
      return;
    }

    const fileStat = statSync(filePath);
    const range = request.headers.range;
    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheAssets ? 'public, max-age=31536000, immutable' : 'no-store',
      'Content-Type': contentType(filePath),
      'Timing-Allow-Origin': '*',
    };

    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : fileStat.size - 1;
      if (!match || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= fileStat.size) {
        response.writeHead(416, {
          ...baseHeaders,
          'Content-Range': `bytes */${fileStat.size}`,
        });
        response.end();
        return;
      }
      response.writeHead(206, {
        ...baseHeaders,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
      });
      createReadStream(filePath, { start, end }).pipe(response);
      return;
    }

    response.writeHead(200, {
      ...baseHeaders,
      'Content-Length': String(fileStat.size),
    });
    createReadStream(filePath).pipe(response);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve benchmark server address.');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
      // Compiler workers and frames can leave HTTP keep-alive sockets open even
      // after their BrowserContext is gone. The benchmark is finished here, so
      // retaining those sockets only makes process shutdown nondeterministic.
      server.closeAllConnections?.();
    }),
  };
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function deterministicShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = createSeededRandom(seed);
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}

function createRunPlan(args: BenchmarkArgs, workloads: readonly Workload[]): RunPlanItem[] {
  const plan: Omit<RunPlanItem, 'runOrdinal'>[] = [];
  for (let iteration = 0; iteration < args.iterations; iteration += 1) {
    const iterationItems: Omit<RunPlanItem, 'runOrdinal'>[] = [];
    for (const language of args.languages) {
      for (const workload of workloads) {
        iterationItems.push({ language, workload, iteration });
      }
    }
    plan.push(...deterministicShuffle(iterationItems, args.seed + iteration));
  }
  return plan.map((item, runOrdinal) => ({ ...item, runOrdinal }));
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function settleBeforeDeadline(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolvePromise) => {
        timeoutId = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function flushNetworkRecords(pending: readonly Promise<void>[]): Promise<boolean> {
  return settleBeforeDeadline(Promise.allSettled([...pending]), 2_000);
}

function collectNetworkMetrics(
  context: BrowserContext,
  phaseRef: { current: string },
  item: RunPlanItem,
  records: NetworkResourceRecord[],
  pending: Promise<void>[]
): void {
  const phases = new WeakMap<Request, string>();
  context.on('request', (request) => {
    phases.set(request, phaseRef.current);
  });
  context.on('requestfinished', (request) => {
    const recordPromise = (async () => {
      const response = await request.response();
      const sizes = await request.sizes();
      const headers = response?.headers() ?? {};
      const timing = request.timing();
      const requestHeadersBytes = finiteNonNegative(sizes.requestHeadersSize);
      const requestBodyBytes = finiteNonNegative(sizes.requestBodySize);
      const responseHeadersBytes = finiteNonNegative(sizes.responseHeadersSize);
      const responseBodyBytes = finiteNonNegative(sizes.responseBodySize);
      const contentLength = finiteNonNegative(Number(headers['content-length']));
      const encodedBodyBytes = responseBodyBytes && responseBodyBytes > 0
        ? responseBodyBytes
        : contentLength;
      records.push({
        runOrdinal: item.runOrdinal,
        language: item.language,
        workloadId: item.workload.id,
        phase: phases.get(request) ?? phaseRef.current,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response?.status(),
        contentType: headers['content-type'],
        contentLength,
        encodedBodyBytes,
        requestHeadersBytes,
        requestBodyBytes,
        responseHeadersBytes,
        responseBodyBytes,
        totalTransferBytes: [requestHeadersBytes, requestBodyBytes, responseHeadersBytes, encodedBodyBytes]
          .filter((value): value is number => value !== undefined)
          .reduce((sum, value) => sum + value, 0),
        startTimeMs: finiteNonNegative(timing.startTime),
        responseStartMs: finiteNonNegative(timing.responseStart),
        responseEndMs: finiteNonNegative(timing.responseEnd),
      });
    })().catch((error) => {
      records.push({
        runOrdinal: item.runOrdinal,
        language: item.language,
        workloadId: item.workload.id,
        phase: phases.get(request) ?? phaseRef.current,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        failed: error instanceof Error ? error.message : String(error),
      });
    });
    pending.push(recordPromise);
  });
  context.on('requestfailed', (request) => {
    records.push({
      runOrdinal: item.runOrdinal,
      language: item.language,
      workloadId: item.workload.id,
      phase: phases.get(request) ?? phaseRef.current,
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      failed: request.failure()?.errorText ?? 'request failed',
    });
  });
}

function metricMap(metrics: Array<{ name: string; value: number }>): Record<string, number> {
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

function metricDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(after)
      .filter(([name, value]) => Number.isFinite(value) && Number.isFinite(before[name]))
      .map(([name, value]) => [name, value - before[name]!])
  );
}

async function runBrowserPlanItem(
  browserOrigin: string,
  browser: Browser,
  item: RunPlanItem,
  args: BenchmarkArgs,
  networkRecords: NetworkResourceRecord[],
  runtimeManifests: Record<string, unknown> | undefined
): Promise<{
  result?: BrowserRunResult;
  error?: string;
  cdpMetrics?: {
    before: Record<string, number>;
    after: Record<string, number>;
    delta: Record<string, number>;
  };
  cdpUnsupportedReason?: string;
  networkFlushComplete: boolean;
}> {
  const context = await browser.newContext();
  const phaseRef = { current: 'page-bootstrap' };
  const pendingNetwork: Promise<void>[] = [];
  let phaseWatchdog: ReturnType<typeof setTimeout> | undefined;
  let phaseWatchdogError: string | undefined;
  let rejectPhaseWatchdog: ((error: Error) => void) | undefined;
  const phaseWatchdogFailure = new Promise<never>((_resolve, reject) => {
    rejectPhaseWatchdog = reject;
  });
  collectNetworkMetrics(context, phaseRef, item, networkRecords, pendingNetwork);
  const page = await context.newPage();
  page.setDefaultTimeout(args.requestTimeoutMs + 30_000);
  await page.exposeFunction('__tracecodeBenchPhase', (phase: string) => {
    phaseRef.current = phase;
    if (phaseWatchdog !== undefined) clearTimeout(phaseWatchdog);
    phaseWatchdog = setTimeout(() => {
      phaseWatchdogError = `${phase} blocked the browser renderer for more than ${args.requestTimeoutMs}ms`;
      rejectPhaseWatchdog?.(new Error(phaseWatchdogError));
      void context.close().catch(() => undefined);
    }, args.requestTimeoutMs + 1_000);
  });
  page.on('console', (message) => {
    if (process.env.TRACECODE_BENCH_DEBUG === '1' || message.type() === 'error' || message.type() === 'warning') {
      console.error(`[browser ${item.language}/${item.workload.id} ${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    console.error(`[browser ${item.language}/${item.workload.id} pageerror] ${error.message}`);
  });

  let cdpSession: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
  let cdpBefore: Record<string, number> | undefined;
  let cdpUnsupportedReason: string | undefined;

  try {
    await page.goto(`${browserOrigin}/index.html?run=${item.runOrdinal}`, { waitUntil: 'load' });
    await page.evaluate('globalThis.__name = (fn) => fn');
    try {
      cdpSession = await context.newCDPSession(page);
      await cdpSession.send('Performance.enable');
      cdpBefore = metricMap((await cdpSession.send('Performance.getMetrics')).metrics);
    } catch (error) {
      cdpUnsupportedReason = error instanceof Error ? error.message : String(error);
    }

    const evaluation = page.evaluate(
      async ({ language, workload, iteration, runOrdinal, modes, requestTimeoutMs, phaseDelayMs, prewarmRuntime, executionIsolation, concurrency, runtimeManifests }) => {
        const benchmarkPhase = (globalThis as typeof globalThis & {
          __tracecodeBenchPhase?: (phase: string) => Promise<void>;
        }).__tracecodeBenchPhase;
        const encoder = new TextEncoder();
        const longTaskEntries: Array<{ startTime: number; duration: number }> = [];
        const longTaskSupported = typeof PerformanceObserver !== 'undefined'
          && PerformanceObserver.supportedEntryTypes?.includes('longtask');
        const longTaskObserver = longTaskSupported
          ? new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                longTaskEntries.push({ startTime: entry.startTime, duration: entry.duration });
              }
            })
          : null;
        longTaskObserver?.observe({ type: 'longtask', buffered: true });

        function memorySnapshot(): BrowserMemorySnapshot | undefined {
          const memory = (performance as Performance & {
            memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
          }).memory;
          if (
            typeof memory?.usedJSHeapSize !== 'number'
            || typeof memory.totalJSHeapSize !== 'number'
            || typeof memory.jsHeapSizeLimit !== 'number'
          ) {
            return undefined;
          }
          return {
            source: 'performance.memory',
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          };
        }

        function resourceSummary(fromIndex: number): ResourceTimingSummary {
          const entries = performance.getEntriesByType('resource').slice(fromIndex) as PerformanceResourceTiming[];
          return {
            entries: entries.length,
            transferBytes: entries.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
            encodedBodyBytes: entries.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
            decodedBodyBytes: entries.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
            durationMs: entries.reduce((sum, entry) => sum + (entry.duration || 0), 0),
          };
        }

        async function settleInstrumentation(): Promise<void> {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
          for (const entry of longTaskObserver?.takeRecords() ?? []) {
            longTaskEntries.push({ startTime: entry.startTime, duration: entry.duration });
          }
        }

        function longTaskSummary(fromIndex: number): LongTaskSummary {
          if (!longTaskSupported) return { supported: false };
          const entries = longTaskEntries.slice(fromIndex);
          return {
            supported: true,
            count: entries.length,
            totalDurationMs: entries.reduce((sum, entry) => sum + entry.duration, 0),
            maxDurationMs: entries.reduce((max, entry) => Math.max(max, entry.duration), 0),
          };
        }

        function editedSource(source: string): string {
          return `${source}\n${language === 'python' ? '#' : '//'} tracecode benchmark cache-key edit`;
        }

        function safeSerializedBytes(value: unknown): number {
          try {
            return encoder.encode(JSON.stringify(value, (_key, nested) => (
              typeof nested === 'bigint' ? `${nested.toString()}n` : nested
            )) ?? '').byteLength;
          } catch {
            return 0;
          }
        }

        function numberOrUndefined(value: unknown): number | undefined {
          return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
        }

        function sanitizeTimings(value: unknown): RuntimeTimingRecord | undefined {
          if (!value || typeof value !== 'object') return undefined;
          const input = value as Record<string, unknown>;
          const result: RuntimeTimingRecord = {};
          for (const key of [
            'totalMs',
            'initMs',
            'warmupMs',
            'compilerLoadMs',
            'rewriteMs',
            'driverBuildMs',
            'compileMs',
            'pchMs',
            'linkMs',
            'wasmCompileMs',
            'classLoadMs',
            'runMs',
            'hostCallMs',
          ] as const) {
            const metric = numberOrUndefined(input[key]);
            if (metric !== undefined) result[key] = metric;
          }
          if (typeof input.compileCacheHit === 'boolean') result.compileCacheHit = input.compileCacheHit;
          if (typeof input.artifactCacheHit === 'boolean') result.artifactCacheHit = input.artifactCacheHit;
          if (typeof input.pchCacheHit === 'boolean') result.pchCacheHit = input.pchCacheHit;
          return Object.keys(result).length > 0 ? result : undefined;
        }

        function traceMetrics(cases: Array<Record<string, any>>): {
          traceSerializedBytes: number;
          traceEventCount: number;
          lineEventCount: number;
          traceStepCount: number;
        } {
          let traceSerializedBytes = 0;
          let traceEventCount = 0;
          let lineEventCount = 0;
          let traceStepCount = 0;
          for (const testCase of cases) {
            if (!testCase.trace) continue;
            traceSerializedBytes += safeSerializedBytes(testCase.trace);
            traceEventCount += Array.isArray(testCase.trace.events) ? testCase.trace.events.length : 0;
            lineEventCount += numberOrUndefined(testCase.trace.lineEventCount) ?? 0;
            traceStepCount += numberOrUndefined(testCase.trace.traceStepCount) ?? 0;
          }
          return { traceSerializedBytes, traceEventCount, lineEventCount, traceStepCount };
        }

        function deepEqual(left: unknown, right: unknown): boolean {
          return JSON.stringify(left) === JSON.stringify(right);
        }

        function errorMessage(error: unknown): string {
          return error instanceof Error ? error.message : String(error);
        }

        async function withTimeout<T>(label: string, operation: Promise<T>, controller?: AbortController): Promise<T> {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
              controller?.abort();
              reject(new Error(`${label} timed out after ${requestTimeoutMs}ms`));
            }, requestTimeoutMs);
          });
          try {
            return await Promise.race([operation, timeout]);
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
        }

        await benchmarkPhase?.('public-module-import');
        const moduleStartedAt = performance.now();
        const publicHarnessModuleUrl = '/benchmark-harness.mjs';
        const publicHarnessModule = await import(publicHarnessModuleUrl) as {
          createBrowserHarness(options: {
            assetBaseUrl: string;
            debug?: boolean;
            executionIsolation?: ExecutionIsolation;
            assets?: { runtimeManifests: Record<string, unknown> };
          }): any;
        };
        const moduleImportMs = performance.now() - moduleStartedAt;
        await settleInstrumentation();

        await benchmarkPhase?.('harness-construction');
        const constructionStartedAt = performance.now();
        const harness = publicHarnessModule.createBrowserHarness({
          assetBaseUrl: '/workers',
          debug: false,
          executionIsolation,
          ...(runtimeManifests ? { assets: { runtimeManifests } } : {}),
        });
        const harnessConstructionMs = performance.now() - constructionStartedAt;
        const client = harness.getClient(language);
        const records: PhaseRecord[] = [];

        const initResourceIndex = performance.getEntriesByType('resource').length;
        const initLongTaskIndex = longTaskEntries.length;
        const initMemoryBefore = memorySnapshot();
        let initResult: { success?: boolean; loadTimeMs?: number } | undefined;
        let runtimeWarmupResult: { success?: boolean; loadTimeMs?: number } | undefined;
        let initError: string | undefined;
        let initWallMs = 0;
        let runtimeWarmupWallMs: number | undefined;
        await benchmarkPhase?.('runtime-init');
        const initStartedAt = performance.now();
        try {
          initResult = await withTimeout('runtime init', client.init());
        } catch (error) {
          initError = errorMessage(error);
        } finally {
          initWallMs = performance.now() - initStartedAt;
        }
        if (initError === undefined && initResult?.success === true && prewarmRuntime) {
          await benchmarkPhase?.('runtime-warmup');
          const warmupStartedAt = performance.now();
          try {
            runtimeWarmupResult = await withTimeout('runtime warmup', harness.warmLanguage(language));
            if (runtimeWarmupResult?.success !== true) {
              initError = 'Runtime warmup returned an unsuccessful result.';
            }
          } catch (error) {
            initError = errorMessage(error);
          } finally {
            runtimeWarmupWallMs = performance.now() - warmupStartedAt;
          }
        }
        await settleInstrumentation();
        const init: InitRecord = {
          language,
          workloadId: workload.id,
          iteration,
          runOrdinal,
          harnessConstructionMs,
          moduleImportMs,
          wallMs: initWallMs,
          runtimeLoadTimeMs: numberOrUndefined(initResult?.loadTimeMs),
          runtimeWarmupWallMs,
          runtimeWarmupLoadTimeMs: numberOrUndefined(runtimeWarmupResult?.loadTimeMs),
          success: initError === undefined && initResult?.success === true,
          error: initError,
          resourceTiming: resourceSummary(initResourceIndex),
          longTasks: longTaskSummary(initLongTaskIndex),
          memoryBefore: initMemoryBefore,
          memoryAfter: memorySnapshot(),
        };

        async function runPhase(
          phase: Phase,
          mode: Mode,
          source: string,
          sourceVariant: 'base' | 'edited',
          cases: TestCase[],
          copies = 1
        ): Promise<boolean> {
          if (records.length > 0 && phaseDelayMs > 0) {
            await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, phaseDelayMs));
          }
          const controller = new AbortController();
          const request = {
            kind: 'code',
            code: source,
            functionName: workload.functionNames[language],
            executionStyle: workload.executionStyles[language],
            cases: cases.map((testCase) => ({
              id: testCase.name,
              inputs: testCase.inputs,
              expected: testCase.expected,
            })),
            trace: mode === 'trace',
            traceOptions: mode === 'trace'
              ? {
                  maxTraceSteps: 50_000,
                  maxStoredEvents: 50_000,
                  minimalTrace: false,
                }
              : undefined,
            signal: controller.signal,
          };
          const resourceIndex = performance.getEntriesByType('resource').length;
          const longTaskIndex = longTaskEntries.length;
          const memoryBefore = memorySnapshot();
          let responses: any[] = [];
          let operationError: string | undefined;
          await benchmarkPhase?.(phase);
          const startedAt = performance.now();
          try {
            responses = await withTimeout(
              phase,
              Promise.all(Array.from({ length: copies }, () => client.execute(request))),
              controller
            );
          } catch (error) {
            operationError = errorMessage(error);
          }
          const wallMs = performance.now() - startedAt;
          await settleInstrumentation();
          // Flatten the outcome union onto each case record so metric extraction below reads one shape.
          const resultCases = responses.flatMap((response) =>
            Array.isArray(response?.cases) ? response.cases : []
          )
            .map((testCase: any) => ({ ...testCase, ...(testCase.outcome ?? {}) }));
          const outputs = resultCases.map((testCase: any) => testCase.output);
          const expected = Array.from({ length: copies }, () => cases.map((testCase) => testCase.expected)).flat();
          const errors = [
            ...(operationError ? [operationError] : []),
            ...resultCases
              .map((testCase: any) => typeof testCase.error === 'string' ? testCase.error : undefined)
              .filter((error: string | undefined): error is string => error !== undefined),
          ];
          const successful = operationError === undefined
            && responses.length === copies
            && responses.every((response) => response?.success === true)
            && resultCases.length === cases.length * copies
            && outputs.every((output: unknown, index: number) => deepEqual(output, expected[index]));
          const traces = mode === 'trace' ? traceMetrics(resultCases) : undefined;
          const timings = copies === 1 ? sanitizeTimings(responses[0]?.timings) : undefined;
          const caseTimings = resultCases
            .map((testCase: any) => sanitizeTimings(testCase.timings))
            .filter((value: RuntimeTimingRecord | undefined): value is RuntimeTimingRecord => value !== undefined);
          const unsupportedMetrics: string[] = [];
          const timingSources = [timings, ...caseTimings].filter(Boolean) as RuntimeTimingRecord[];
          if (!timingSources.some((value) => typeof value.compileMs === 'number')) unsupportedMetrics.push('compileMs');
          if (!timingSources.some((value) => typeof value.runMs === 'number')) unsupportedMetrics.push('runMs');
          if (!longTaskSupported) unsupportedMetrics.push('longTasks');
          if (!memoryBefore) unsupportedMetrics.push('jsHeap');
          records.push({
            language,
            workloadId: workload.id,
            workloadLabel: workload.label,
            iteration,
            runOrdinal,
            phase,
            mode,
            sourceVariant,
            caseCount: cases.length,
            concurrency: copies,
            wallMs,
            success: successful,
            outputs,
            expected,
            errors,
            timings,
            caseTimings,
            artifactCacheHits: resultCases
              .map((testCase: any) => testCase.timings?.artifactCacheHit)
              .filter((value: unknown): value is boolean => typeof value === 'boolean'),
            responseSerializedBytes: responses.reduce(
              (sum, response) => sum + safeSerializedBytes(response),
              0
            ),
            traceSerializedBytes: traces?.traceSerializedBytes,
            traceEventCount: traces?.traceEventCount,
            lineEventCount: traces?.lineEventCount,
            traceStepCount: traces?.traceStepCount,
            resourceTiming: resourceSummary(resourceIndex),
            longTasks: longTaskSummary(longTaskIndex),
            memoryBefore,
            memoryAfter: memorySnapshot(),
            unsupportedMetrics,
          });
          return successful;
        }

        try {
          if (init.success) {
            const firstCase = workload.cases[0]!;
            const changedSource = editedSource(workload.sources[language]);
            let runtimeHealthy = true;
            if (modes.includes('execute')) {
              runtimeHealthy = await runPhase(
                'cold-first-execute',
                'execute',
                workload.sources[language],
                'base',
                [firstCase]
              );
              if (runtimeHealthy) {
                runtimeHealthy = await runPhase(
                  'warm-exact-repeat',
                  'execute',
                  workload.sources[language],
                  'base',
                  [firstCase]
                );
              }
              if (runtimeHealthy) {
                runtimeHealthy = await runPhase(
                  'warm-edited-source',
                  'execute',
                  changedSource,
                  'edited',
                  [firstCase]
                );
              }
              if (runtimeHealthy) {
                runtimeHealthy = await runPhase(
                  'multiple-inputs',
                  'execute',
                  changedSource,
                  'edited',
                  workload.cases
                );
              }
              if (runtimeHealthy && concurrency > 1) {
                runtimeHealthy = await runPhase(
                  'concurrent-executes',
                  'execute',
                  changedSource,
                  'edited',
                  [firstCase],
                  concurrency
                );
              }
            }
            if (runtimeHealthy && modes.includes('trace')) {
              runtimeHealthy = await runPhase('trace', 'trace', changedSource, 'edited', [firstCase]);
            }
          }
        } finally {
          harness.dispose();
          longTaskObserver?.disconnect();
        }

        return {
          userAgent: navigator.userAgent,
          crossOriginIsolated: globalThis.crossOriginIsolated,
          memorySupport: {
            performanceMemory: memorySnapshot() !== undefined,
            userAgentSpecificMemory: typeof (performance as Performance & {
              measureUserAgentSpecificMemory?: unknown;
            }).measureUserAgentSpecificMemory === 'function',
          },
          longTaskSupport: longTaskSupported,
          init,
          records,
        } as BrowserRunResult;
      },
      {
        language: item.language,
        workload: item.workload,
        iteration: item.iteration,
        runOrdinal: item.runOrdinal,
        modes: args.modes,
        requestTimeoutMs: args.requestTimeoutMs,
        phaseDelayMs: args.phaseDelayMs,
        prewarmRuntime: args.prewarmRuntime,
        executionIsolation: args.executionIsolation,
        concurrency: args.concurrency,
        runtimeManifests,
      }
    );
    const result = await Promise.race([evaluation, phaseWatchdogFailure]);
    if (phaseWatchdog !== undefined) {
      clearTimeout(phaseWatchdog);
      phaseWatchdog = undefined;
    }

    let cdpMetrics: { before: Record<string, number>; after: Record<string, number>; delta: Record<string, number> } | undefined;
    if (cdpSession && cdpBefore) {
      const cdpAfter = metricMap((await cdpSession.send('Performance.getMetrics')).metrics);
      cdpMetrics = { before: cdpBefore, after: cdpAfter, delta: metricDelta(cdpBefore, cdpAfter) };
    }
    await page.waitForTimeout(25);
    const networkFlushComplete = await flushNetworkRecords(pendingNetwork);
    return { result, cdpMetrics, cdpUnsupportedReason, networkFlushComplete };
  } catch (error) {
    if (phaseWatchdog !== undefined) {
      clearTimeout(phaseWatchdog);
      phaseWatchdog = undefined;
    }
    const networkFlushComplete = await flushNetworkRecords(pendingNetwork);
    return {
      error: phaseWatchdogError
        ? `${phaseWatchdogError}. The context was terminated by the host watchdog because an in-page timer cannot fire while the renderer is blocked.`
        : error instanceof Error ? error.stack ?? error.message : String(error),
      cdpUnsupportedReason,
      networkFlushComplete,
    };
  } finally {
    if (phaseWatchdog !== undefined) clearTimeout(phaseWatchdog);
    await settleBeforeDeadline(context.close(), 2_000);
  }
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index]!;
}

function average(values: number[]): number | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function timingValue(record: PhaseRecord, key: keyof RuntimeTimingRecord): number | undefined {
  const topLevel = record.timings?.[key];
  if (typeof topLevel === 'number' && Number.isFinite(topLevel)) return topLevel;
  const caseValues = record.caseTimings
    .map((timings) => timings[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (caseValues.length === 0) return undefined;
  return caseValues.reduce((sum, value) => sum + value, 0);
}

function compileCacheHit(record: PhaseRecord): boolean | undefined {
  if (typeof record.timings?.compileCacheHit === 'boolean') return record.timings.compileCacheHit;
  const values = record.caseTimings
    .map((timings) => timings.compileCacheHit)
    .filter((value): value is boolean => typeof value === 'boolean');
  if (values.length === 0) return undefined;
  return values.every(Boolean);
}

function summarize(records: PhaseRecord[]): SummaryRecord[] {
  const groups = new Map<string, PhaseRecord[]>();
  for (const record of records) {
    const key = `${record.language}\0${record.workloadId}\0${record.phase}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map((items) => {
    const first = items[0]!;
    const cacheValues = items
      .map(compileCacheHit)
      .filter((value): value is boolean => value !== undefined);
    return {
      language: first.language,
      workloadId: first.workloadId,
      phase: first.phase,
      samples: items.length,
      passed: items.filter((item) => item.success).length,
      wallP50Ms: percentile(items.map((item) => item.wallMs), 0.5),
      wallP95Ms: percentile(items.map((item) => item.wallMs), 0.95),
      wallAvgMs: average(items.map((item) => item.wallMs)) ?? 0,
      totalAvgMs: average(items.map((item) => timingValue(item, 'totalMs')).filter((value): value is number => value !== undefined)),
      compileAvgMs: average(items.map((item) => timingValue(item, 'compileMs')).filter((value): value is number => value !== undefined)),
      runAvgMs: average(items.map((item) => timingValue(item, 'runMs')).filter((value): value is number => value !== undefined)),
      traceEventsAvg: average(items.map((item) => item.traceEventCount).filter((value): value is number => value !== undefined)),
      responseBytesAvg: average(items.map((item) => item.responseSerializedBytes)) ?? 0,
      traceBytesAvg: average(items.map((item) => item.traceSerializedBytes).filter((value): value is number => value !== undefined)),
      longTaskTotalAvgMs: average(items.map((item) => item.longTasks.totalDurationMs).filter((value): value is number => value !== undefined)),
      heapDeltaAvgBytes: average(items.map((item) => {
        if (!item.memoryBefore || !item.memoryAfter) return undefined;
        return item.memoryAfter.usedJSHeapSize - item.memoryBefore.usedJSHeapSize;
      }).filter((value): value is number => value !== undefined)),
      cacheHits: cacheValues.filter(Boolean).length,
      cacheKnown: cacheValues.length,
    };
  });
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return '-';
  if (Math.abs(value) < 10) return value.toFixed(1);
  return String(Math.round(value));
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return '-';
  if (value < 1024) return `${Math.round(value)}B`;
  return `${(value / 1024).toFixed(value < 10_240 ? 1 : 0)}K`;
}

function printSummary(initRecords: InitRecord[], summaries: SummaryRecord[]): void {
  console.log('\nPublic Classic browser harness benchmark');
  console.log('Cold init (fresh context per language/workload sample):');
  for (const language of ALL_LANGUAGES) {
    const records = initRecords.filter((record) => record.language === language);
    if (records.length === 0) continue;
    console.log(
      `  ${language.padEnd(10)} ${records.filter((record) => record.success).length}/${records.length} `
      + `wall avg=${formatMs(average(records.map((record) => record.wallMs)))}ms `
      + `runtime avg=${formatMs(average(records.map((record) => record.runtimeLoadTimeMs).filter((value): value is number => value !== undefined)))}ms `
      + `warmup avg=${formatMs(average(records.map((record) => record.runtimeWarmupWallMs).filter((value): value is number => value !== undefined)))}ms`
    );
  }

  console.log('\nlanguage    workload   phase                 pass    p50 ms  p95 ms  compile  run ms  trace     response  cache');
  for (const item of summaries) {
    const cache = item.cacheKnown ? `${item.cacheHits ?? 0}/${item.cacheKnown}` : '-';
    console.log([
      item.language.padEnd(10),
      item.workloadId.padEnd(10),
      item.phase.padEnd(21),
      `${item.passed}/${item.samples}`.padEnd(6),
      formatMs(item.wallP50Ms).padStart(7),
      formatMs(item.wallP95Ms).padStart(7),
      formatMs(item.compileAvgMs).padStart(7),
      formatMs(item.runAvgMs).padStart(6),
      formatMs(item.traceEventsAvg).padStart(7),
      formatBytes(item.responseBytesAvg).padStart(8),
      cache,
    ].join('  '));
  }
}

function metricCoverage(records: PhaseRecord[], networkRecords: NetworkResourceRecord[]) {
  const count = records.length;
  return {
    operationWallTime: { supported: true, records: count, source: 'performance.now around RuntimeClient.execute' },
    runtimeTotal: { supportedRecords: records.filter((record) => timingValue(record, 'totalMs') !== undefined).length, records: count },
    compile: { supportedRecords: records.filter((record) => timingValue(record, 'compileMs') !== undefined).length, records: count },
    run: { supportedRecords: records.filter((record) => timingValue(record, 'runMs') !== undefined).length, records: count },
    tracePayload: {
      supportedRecords: records.filter((record) => record.mode === 'trace' && record.traceSerializedBytes !== undefined).length,
      traceRecords: records.filter((record) => record.mode === 'trace').length,
    },
    mainThreadLongTasks: {
      supportedRecords: records.filter((record) => record.longTasks.supported).length,
      records: count,
      scope: 'window main thread only; worker CPU time is represented by operation wall/runtime timings',
    },
    memory: {
      supportedRecords: records.filter((record) => record.memoryBefore && record.memoryAfter).length,
      records: count,
      source: 'Chromium performance.memory with --enable-precise-memory-info when exposed',
    },
    network: {
      completedResources: networkRecords.filter((record) => !record.failed).length,
      failedResources: networkRecords.filter((record) => record.failed).length,
      encodedSizeResources: networkRecords.filter((record) => record.encodedBodyBytes !== undefined).length,
      source: 'Playwright context request sizes, including worker and cross-origin resources where Chromium reports them',
    },
  };
}

function summarizeNetwork(records: NetworkResourceRecord[]) {
  const groups = new Map<string, NetworkResourceRecord[]>();
  for (const record of records) {
    const key = `${record.language}\0${record.workloadId}\0${record.phase}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map((items) => {
    const first = items[0]!;
    const runs = new Set(items.map((item) => item.runOrdinal)).size;
    const encodedBodyBytes = items.reduce((sum, item) => sum + (item.encodedBodyBytes ?? 0), 0);
    const totalTransferBytes = items.reduce((sum, item) => sum + (item.totalTransferBytes ?? 0), 0);
    return {
      language: first.language,
      workloadId: first.workloadId,
      phase: first.phase,
      runs,
      resources: items.length,
      failedResources: items.filter((item) => item.failed).length,
      encodedBodyBytes,
      totalTransferBytes,
      encodedBodyBytesPerRun: runs > 0 ? encodedBodyBytes / runs : 0,
      totalTransferBytesPerRun: runs > 0 ? totalTransferBytes / runs : 0,
    };
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtimeManifests = await loadRuntimeManifests(args.runtimeManifestsPath);
  const selectedWorkloads = WORKLOADS
    .filter((workload) => args.workloads.includes(workload.id))
    .map((workload) => ({
      ...workload,
      cases: args.caseLimit === null ? workload.cases : workload.cases.slice(0, args.caseLimit),
    }))
    .filter((workload) => workload.cases.length > 0);
  const runPlan = createRunPlan(args, selectedWorkloads);
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-browser-bench-'));
  const workersRoot = join(tempRoot, 'workers');
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  let browser: Browser | undefined;

  try {
    await runAssetSync(workersRoot, args.languages);
    const bundle = await buildPublicHarnessBundle(tempRoot);
    await writeFile(join(tempRoot, 'index.html'), [
      '<!doctype html>',
      '<meta charset="utf-8">',
      '<title>TraceCode public browser harness benchmark</title>',
    ].join('\n'), 'utf8');
    server = await startStaticServer(resolve(tempRoot), args.cacheAssets);
    const browserType = args.engine === 'firefox' ? firefox : args.engine === 'webkit' ? webkit : chromium;
    browser = await browserType.launch({
      headless: !args.headful,
      ...(args.engine === 'chromium' ? { args: ['--enable-precise-memory-info'] } : {}),
    });

    const initRecords: InitRecord[] = [];
    const records: PhaseRecord[] = [];
    const runErrors: Array<{ runOrdinal: number; language: Language; workloadId: string; error: string }> = [];
    const runDiagnostics: Array<{
      runOrdinal: number;
      language: Language;
      workloadId: string;
      warning: string;
    }> = [];
    const networkRecords: NetworkResourceRecord[] = [];
    const cdpMetrics: Array<{
      runOrdinal: number;
      language: Language;
      workloadId: string;
      before?: Record<string, number>;
      after?: Record<string, number>;
      delta?: Record<string, number>;
      unsupportedReason?: string;
    }> = [];
    let userAgent = '';
    let crossOriginIsolated = false;
    let memorySupport = { performanceMemory: false, userAgentSpecificMemory: false };
    let longTaskSupport = false;

    console.log(`Run order seed ${args.seed}: ${runPlan.map((item) => `${item.language}/${item.workload.id}#${item.iteration}`).join(', ')}`);
    for (const item of runPlan) {
      console.log(`[${item.runOrdinal + 1}/${runPlan.length}] ${item.language}/${item.workload.id} iteration ${item.iteration + 1}`);
      const run = await runBrowserPlanItem(
        server.origin,
        browser,
        item,
        args,
        networkRecords,
        runtimeManifests
      );
      if (!run.networkFlushComplete) {
        runDiagnostics.push({
          runOrdinal: item.runOrdinal,
          language: item.language,
          workloadId: item.workload.id,
          warning: 'Playwright request-size collection did not settle within 2000ms; raw network records may omit late worker entries.',
        });
      }
      if (!run.result) {
        runErrors.push({
          runOrdinal: item.runOrdinal,
          language: item.language,
          workloadId: item.workload.id,
          error: run.error ?? 'unknown browser run failure',
        });
      } else {
        userAgent = run.result.userAgent;
        crossOriginIsolated = run.result.crossOriginIsolated;
        memorySupport = {
          performanceMemory: memorySupport.performanceMemory || run.result.memorySupport.performanceMemory,
          userAgentSpecificMemory: memorySupport.userAgentSpecificMemory || run.result.memorySupport.userAgentSpecificMemory,
        };
        longTaskSupport = longTaskSupport || run.result.longTaskSupport;
        initRecords.push(run.result.init);
        records.push(...run.result.records);
      }
      cdpMetrics.push({
        runOrdinal: item.runOrdinal,
        language: item.language,
        workloadId: item.workload.id,
        ...run.cdpMetrics,
        unsupportedReason: run.cdpUnsupportedReason,
      });
    }

    const summaries = summarize(records);
    const networkSummaries = summarizeNetwork(networkRecords);
    printSummary(initRecords, summaries);
    for (const diagnostic of runDiagnostics) {
      console.warn(
        `Network warning ${diagnostic.language}/${diagnostic.workloadId}#${diagnostic.runOrdinal}: ${diagnostic.warning}`
      );
    }
    const failedPhases = records.filter((record) => !record.success);
    const failedInits = initRecords.filter((record) => !record.success);
    const fullReport = {
      schemaVersion: 'tracecode-public-browser-benchmark-v2',
      createdAt: new Date().toISOString(),
      methodology: {
        apiBoundary: 'createBrowserHarness -> getClient -> init/execute/dispose',
        isolation: 'fresh Playwright BrowserContext and fresh harness for every language/workload/iteration',
        executionIsolation: args.executionIsolation,
        concurrency: args.concurrency,
        order: 'deterministic Fisher-Yates shuffle independently per iteration',
        assetCaching: args.cacheAssets
          ? 'immutable browser caching; warm phases run after the cold phase populated the same BrowserContext cache'
          : 'disabled with Cache-Control: no-store',
        phases: {
          'cold-first-execute': 'first source/case after RuntimeClient.init',
          'warm-exact-repeat': 'byte-identical source and input repeated on the same client',
          'warm-edited-source': 'same behavior with a comment appended to force a new source cache key',
          'multiple-inputs': 'edited source repeated with all selected cases in one public execute request',
          'concurrent-executes': `${args.concurrency} simultaneous public execute requests against one harness`,
          trace: 'one selected case through the public trace request and canonical trace response',
        },
      },
      options: {
        engine: args.engine,
        languages: args.languages,
        workloads: selectedWorkloads.map((workload) => workload.id),
        modes: args.modes,
        iterations: args.iterations,
        caseLimit: args.caseLimit,
        requestTimeoutMs: args.requestTimeoutMs,
        phaseDelayMs: args.phaseDelayMs,
        prewarmRuntime: args.prewarmRuntime,
        executionIsolation: args.executionIsolation,
        concurrency: args.concurrency,
        seed: args.seed,
        cacheAssets: args.cacheAssets,
        smoke: args.smoke,
        runtimeManifestRuntimes: runtimeManifests ? Object.keys(runtimeManifests).sort() : [],
      },
      bundle: {
        entrypoint: 'src/browser.ts',
        rawBytes: bundle.rawBytes,
        gzipBytes: bundle.gzipBytes,
        buildMs: bundle.buildMs,
      },
      browser: {
        userAgent,
        crossOriginIsolated,
        longTaskSupport,
        memorySupport,
      },
      metricCoverage: metricCoverage(records, networkRecords),
      runPlan: runPlan.map((item) => ({
        runOrdinal: item.runOrdinal,
        language: item.language,
        workloadId: item.workload.id,
        iteration: item.iteration,
      })),
      summaries,
      initRecords,
      records,
      networkSummaries,
      networkRecords,
      cdpMetrics,
      runDiagnostics,
      runErrors,
    };

    if (args.reportPath) {
      const outputPath = resolve(process.cwd(), args.reportPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(fullReport, null, 2)}\n`, 'utf8');
      console.log(`\nWrote ${outputPath}`);
    }

    const failureCount = failedPhases.length + failedInits.length + runErrors.length;
    if (failureCount > 0) {
      const examples = [
        ...failedInits.map((record) => `${record.language}/${record.workloadId}/init: ${record.error ?? 'failed'}`),
        ...failedPhases.map((record) => `${record.language}/${record.workloadId}/${record.phase}: ${record.errors.join('; ') || 'wrong output'}`),
        ...runErrors.map((record) => `${record.language}/${record.workloadId}/browser: ${record.error}`),
      ].slice(0, 10);
      throw new Error(`Browser runtime benchmark had ${failureCount} failing sample(s).\n${examples.join('\n')}`);
    }
  } finally {
    await browser?.close();
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
