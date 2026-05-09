#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

type Language = 'csharp' | 'cpp' | 'java';
type Mode = 'execute' | 'trace' | 'interview';

interface BenchmarkArgs {
  languages: Language[];
  workloads: string[];
  modes: Mode[];
  iterations: number;
  caseLimit: number | null;
  requestTimeoutMs: number;
  headful: boolean;
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
  modes: Mode[];
  sources: Record<Language, string>;
  functionNames: Record<Language, string>;
  executionStyles: Record<Language, 'function' | 'solution-method'>;
  cases: TestCase[];
}

interface CaseRecord {
  language: Language;
  workloadId: string;
  workloadLabel: string;
  mode: Mode;
  iteration: number;
  caseName: string;
  caseIndex: number;
  wallMs: number;
  success: boolean;
  output?: unknown;
  expected: unknown;
  error?: string;
  timings?: Record<string, unknown>;
  executionTimeMs?: number;
  traceEventCount?: number;
  lineEventCount?: number;
  traceStepCount?: number;
  consoleOutputCount?: number;
}

interface SummaryRecord {
  language: Language;
  workloadId: string;
  mode: Mode;
  cases: number;
  passed: number;
  wallP50Ms: number;
  wallP95Ms: number;
  wallAvgMs: number;
  totalAvgMs?: number;
  compileAvgMs?: number;
  runAvgMs?: number;
  hostCallAvgMs?: number;
  rewriteAvgMs?: number;
  classLoadAvgMs?: number;
  cacheHits?: number;
  cacheKnown?: number;
}

const ALL_LANGUAGES: Language[] = ['csharp', 'cpp', 'java'];
const ALL_MODES: Mode[] = ['execute', 'trace', 'interview'];

const addCases: TestCase[] = [
  { name: 'positive', inputs: { a: 2, b: 3 }, expected: 5 },
  { name: 'different-values-cache-hit', inputs: { a: 5, b: 6 }, expected: 11 },
  { name: 'negative', inputs: { a: -4, b: 9 }, expected: 5 },
  { name: 'zero', inputs: { a: 0, b: 0 }, expected: 0 },
  { name: 'large', inputs: { a: 12345, b: 67890 }, expected: 80235 },
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
    modes: ['execute', 'trace', 'interview'],
    functionNames: { csharp: 'Sum', cpp: 'sum', java: 'sum' },
    executionStyles: { csharp: 'solution-method', cpp: 'solution-method', java: 'solution-method' },
    sources: {
      csharp: [
        'using System;',
        'public class Solution {',
        '  public int Sum(int a, int b) {',
        '    return a + b;',
        '  }',
        '}',
      ].join('\n'),
      cpp: 'class Solution { public: int sum(int a, int b) { return a + b; } };',
      java: [
        'class Solution {',
        '  int sum(int a, int b) {',
        '    return a + b;',
        '  }',
        '}',
      ].join('\n'),
    },
    cases: addCases,
  },
  {
    id: 'two-sum',
    label: 'Two Sum',
    modes: ['execute', 'trace'],
    functionNames: { csharp: 'TwoSum', cpp: 'twoSum', java: 'twoSum' },
    executionStyles: { csharp: 'solution-method', cpp: 'solution-method', java: 'solution-method' },
    sources: {
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
    },
    cases: twoSumCases,
  },
  {
    id: 'loop-walk',
    label: 'Loop Walk',
    modes: ['execute', 'trace'],
    functionNames: { csharp: 'Walk', cpp: 'walk', java: 'walk' },
    executionStyles: { csharp: 'solution-method', cpp: 'solution-method', java: 'solution-method' },
    sources: {
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
    },
    cases: walkCases,
  },
];

function usage(): string {
  return [
    'Usage: pnpm bench:browser-runtimes [options]',
    '',
    'Options:',
    '  --languages=csharp,cpp,java     Languages to benchmark. Default: all.',
    '  --workloads=add,two-sum         Workloads to run. Default: all.',
    '  --modes=execute,trace,interview Modes to run where supported by each workload. Default: all.',
    '  --iterations=2                  Repeat every workload case. Default: 1.',
    '  --case-limit=2                  Run only the first N cases per workload for quick checks.',
    '  --request-timeout-ms=180000     Per worker request timeout. Default: 180000.',
    '  --report=reports/file.json      Report output path. Default: reports/browser-runtime-benchmark.json.',
    '  --no-report                     Do not write a JSON report.',
    '  --headful                       Run Chromium with a visible window.',
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
  return [...new Set(values)];
}

function parseArgs(argv: string[]): BenchmarkArgs {
  const args: BenchmarkArgs = {
    languages: ALL_LANGUAGES,
    workloads: WORKLOADS.map((workload) => workload.id),
    modes: ALL_MODES,
    iterations: 1,
    caseLimit: null,
    requestTimeoutMs: 180_000,
    headful: false,
    reportPath: join('reports', 'browser-runtime-benchmark.json'),
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--headful') {
      args.headful = true;
      continue;
    }
    if (arg === '--no-report') {
      args.reportPath = null;
      continue;
    }
    if (arg.startsWith('--languages=')) {
      args.languages = parseCsv(arg.slice('--languages='.length), ALL_LANGUAGES, 'language');
      continue;
    }
    if (arg.startsWith('--workloads=')) {
      args.workloads = parseCsv(arg.slice('--workloads='.length), WORKLOADS.map((workload) => workload.id), 'workload');
      continue;
    }
    if (arg.startsWith('--modes=')) {
      args.modes = parseCsv(arg.slice('--modes='.length), ALL_MODES, 'mode');
      continue;
    }
    if (arg.startsWith('--iterations=')) {
      args.iterations = positiveInteger(arg.slice('--iterations='.length), 'iterations');
      continue;
    }
    if (arg.startsWith('--case-limit=')) {
      args.caseLimit = positiveInteger(arg.slice('--case-limit='.length), 'case-limit');
      continue;
    }
    if (arg.startsWith('--request-timeout-ms=')) {
      args.requestTimeoutMs = positiveInteger(arg.slice('--request-timeout-ms='.length), 'request-timeout-ms');
      continue;
    }
    if (arg.startsWith('--report=')) {
      args.reportPath = arg.slice('--report='.length);
      continue;
    }
    throw new Error(`Unknown option "${arg}".\n${usage()}`);
  }

  return args;
}

function positiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected --${label} to be a positive integer, received "${raw}".`);
  }
  return value;
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

async function runCommand(command: string, commandArgs: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, {
      cwd,
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
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} ${commandArgs.join(' ')} exited with code ${code}\n${stderr}`));
      }
    });
  });
}

async function startStaticServer(root: string): Promise<{ origin: string; close(): Promise<void> }> {
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
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const fileStat = statSync(filePath);
    const range = request.headers.range;
    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType(filePath),
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
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

function deepEqualJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function average(values: number[]): number | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function timingNumber(record: CaseRecord, key: string): number | undefined {
  const value = record.timings?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarize(records: CaseRecord[]): SummaryRecord[] {
  const groups = new Map<string, CaseRecord[]>();
  for (const record of records) {
    const key = `${record.language}\0${record.workloadId}\0${record.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  return [...groups.values()].map((items) => {
    const first = items[0]!;
    const cacheKnownItems = items.filter((item) => typeof item.timings?.compileCacheHit === 'boolean');
    return {
      language: first.language,
      workloadId: first.workloadId,
      mode: first.mode,
      cases: items.length,
      passed: items.filter((item) => item.success && deepEqualJson(item.output, item.expected)).length,
      wallP50Ms: percentile(items.map((item) => item.wallMs), 0.5),
      wallP95Ms: percentile(items.map((item) => item.wallMs), 0.95),
      wallAvgMs: average(items.map((item) => item.wallMs)) ?? 0,
      totalAvgMs: average(items.map((item) => timingNumber(item, 'totalMs')).filter((value): value is number => value !== undefined)),
      compileAvgMs: average(items.map((item) => timingNumber(item, 'compileMs')).filter((value): value is number => value !== undefined)),
      runAvgMs: average(items.map((item) => timingNumber(item, 'runMs')).filter((value): value is number => value !== undefined)),
      hostCallAvgMs: average(items.map((item) => timingNumber(item, 'hostCallMs')).filter((value): value is number => value !== undefined)),
      rewriteAvgMs: average(items.map((item) => timingNumber(item, 'rewriteMs')).filter((value): value is number => value !== undefined)),
      classLoadAvgMs: average(items.map((item) => timingNumber(item, 'classLoadMs')).filter((value): value is number => value !== undefined)),
      cacheHits: cacheKnownItems.filter((item) => item.timings?.compileCacheHit === true).length,
      cacheKnown: cacheKnownItems.length,
    };
  });
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return '-';
  if (value < 10) return value.toFixed(1);
  return String(Math.round(value));
}

function printSummary(initResults: Record<string, unknown>, summaries: SummaryRecord[]): void {
  console.log('\nBrowser runtime benchmark');
  console.log('Init:');
  for (const [language, init] of Object.entries(initResults)) {
    const typed = init as { loadTimeMs?: number; timings?: Record<string, unknown> };
    console.log(
      `  ${language}: load=${formatMs(typed.loadTimeMs)}ms total=${formatMs(typed.timings?.totalMs as number | undefined)}ms warmup=${formatMs(typed.timings?.warmupMs as number | undefined)}ms`
    );
  }

  console.log('\nlanguage  workload   mode       cases  wall p50  wall p95  avg total  avg compile  avg run  avg host  rewrite  classload  cache');
  for (const item of summaries) {
    const cache =
      item.cacheKnown && item.cacheKnown > 0
        ? `${item.cacheHits ?? 0}/${item.cacheKnown}`
        : '-';
    console.log(
      [
        item.language.padEnd(8),
        item.workloadId.padEnd(10),
        item.mode.padEnd(10),
        `${item.passed}/${item.cases}`.padEnd(6),
        formatMs(item.wallP50Ms).padStart(8),
        formatMs(item.wallP95Ms).padStart(8),
        formatMs(item.totalAvgMs).padStart(9),
        formatMs(item.compileAvgMs).padStart(11),
        formatMs(item.runAvgMs).padStart(7),
        formatMs(item.hostCallAvgMs).padStart(8),
        formatMs(item.rewriteAvgMs).padStart(7),
        formatMs(item.classLoadAvgMs).padStart(9),
        cache,
      ].join('  ')
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selectedWorkloads = WORKLOADS
    .filter((workload) => args.workloads.includes(workload.id))
    .map((workload) => ({
      ...workload,
      modes: workload.modes.filter((mode) => args.modes.includes(mode)),
      cases: args.caseLimit === null ? workload.cases : workload.cases.slice(0, args.caseLimit),
    }))
    .filter((workload) => workload.modes.length > 0 && workload.cases.length > 0);

  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-browser-bench-'));
  const workersRoot = join(tempRoot, 'workers');
  await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot, '--languages', args.languages.join(',')], process.cwd());
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>TraceCode browser runtime benchmark</title>', 'utf8');

  const server = await startStaticServer(resolve(tempRoot));
  const browser = await chromium.launch({ headless: !args.headful });

  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.error(`[browser ${message.type()}] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      console.error(`[browser pageerror] ${error.message}`);
    });
    page.setDefaultTimeout(args.requestTimeoutMs + 30_000);
    await page.goto(server.origin);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const report = await page.evaluate(
      async ({ languages, workloads, iterations, requestTimeoutMs }) => {
        const workerPaths = {
          csharp: '/workers/csharp-worker.js',
          cpp: '/workers/cpp-worker.js',
          java: '/workers/java-worker.js',
        };

        function createRunner(language) {
          const worker = language === 'java'
            ? new Worker(workerPaths[language])
            : new Worker(workerPaths[language], { type: 'module' });
          let nextId = 0;
          const pending = new Map();

          worker.onmessage = (event) => {
            const { id, type, payload } = event.data || {};
            if (type === 'worker-ready' || type === 'idle-timeout') return;
            if (!id || !pending.has(id)) return;
            const request = pending.get(id);
            pending.delete(id);
            clearTimeout(request.timeoutId);
            if (type === 'error') {
              request.reject(new Error(String((payload && payload.error) || `${language} worker error`)));
              return;
            }
            request.resolve(payload);
          };

          worker.onerror = (event) => {
            for (const request of pending.values()) {
              clearTimeout(request.timeoutId);
              request.reject(new Error(event.message || `${language} worker error`));
            }
            pending.clear();
          };

          function send(type, payload) {
            return new Promise((resolve, reject) => {
              const id = String(++nextId);
              const timeoutId = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${language} worker request timed out: ${type}`));
              }, requestTimeoutMs);
              pending.set(id, { resolve, reject, timeoutId });
              worker.postMessage({ id, type, payload });
            });
          }

          return {
            async init() {
              const startedAt = performance.now();
              const payload = language === 'csharp'
                ? { assetBaseUrl: '/workers/vendor/csharp' }
                : language === 'cpp'
                  ? {
                      assets: {
                        compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
                        clangWasmUrl: '',
                        lldWasmUrl: '',
                        sysrootUrl: '',
                        runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
                      },
                    }
                  : undefined;
              const result = await send('init', payload);
              return { ...result, wallMs: performance.now() - startedAt };
            },
            async run(mode, workload, testCase, iteration, caseIndex) {
              const type = language === 'cpp'
                ? mode === 'execute'
                  ? 'compile-run'
                  : mode === 'trace'
                    ? 'execute-with-tracing'
                    : 'execute-code-interview'
                : mode === 'execute'
                  ? 'execute-code'
                  : mode === 'trace'
                    ? 'execute-with-tracing'
                    : 'execute-code-interview';
              const payload = {
                code: workload.sources[language],
                functionName: workload.functionNames[language],
                inputs: testCase.inputs,
                executionStyle: workload.executionStyles[language],
                options: {
                  maxTraceSteps: 50_000,
                  maxStoredEvents: 50_000,
                },
              };
              const startedAt = performance.now();
              const result = await send(type, payload);
              const wallMs = performance.now() - startedAt;
              const traceEvents = Array.isArray(result?.events)
                ? result.events.length
                : Array.isArray(result?.trace?.events)
                  ? result.trace.events.length
                  : undefined;
              return {
                language,
                workloadId: workload.id,
                workloadLabel: workload.label,
                mode,
                iteration,
                caseName: testCase.name,
                caseIndex,
                wallMs,
                success: Boolean(result?.success),
                output: result?.output,
                expected: testCase.expected,
                error: result?.error,
                timings: result?.timings,
                executionTimeMs: result?.executionTimeMs,
                traceEventCount: traceEvents,
                lineEventCount: result?.lineEventCount ?? result?.trace?.lineEventCount,
                traceStepCount: result?.traceStepCount ?? result?.trace?.traceStepCount,
                consoleOutputCount: Array.isArray(result?.consoleOutput) ? result.consoleOutput.length : undefined,
              };
            },
            terminate() {
              worker.terminate();
            },
          };
        }

        const initResults = {};
        const records = [];

        for (const language of languages) {
          const runner = createRunner(language);
          try {
            initResults[language] = await runner.init();
            for (let iteration = 0; iteration < iterations; iteration += 1) {
              for (const workload of workloads) {
                for (const mode of workload.modes) {
                  for (let caseIndex = 0; caseIndex < workload.cases.length; caseIndex += 1) {
                    records.push(await runner.run(mode, workload, workload.cases[caseIndex], iteration, caseIndex));
                  }
                }
              }
            }
          } finally {
            runner.terminate();
          }
        }

        return {
          userAgent: navigator.userAgent,
          initResults,
          records,
        };
      },
      {
        languages: args.languages,
        workloads: selectedWorkloads,
        iterations: args.iterations,
        requestTimeoutMs: args.requestTimeoutMs,
      }
    );

    const records = report.records as CaseRecord[];
    const failures = records.filter((record) => !record.success || !deepEqualJson(record.output, record.expected));
    if (failures.length > 0) {
      throw new Error(
        [
          `Browser runtime benchmark had ${failures.length} failing case(s).`,
          ...failures.slice(0, 10).map((failure) =>
            `${failure.language}/${failure.workloadId}/${failure.mode}/${failure.caseName}: output=${JSON.stringify(failure.output)} expected=${JSON.stringify(failure.expected)} error=${failure.error ?? ''}`
          ),
        ].join('\n')
      );
    }

    const summaries = summarize(records);
    printSummary(report.initResults as Record<string, unknown>, summaries);

    const fullReport = {
      createdAt: new Date().toISOString(),
      options: {
        languages: args.languages,
        workloads: selectedWorkloads.map((workload) => workload.id),
        modes: args.modes,
        iterations: args.iterations,
        caseLimit: args.caseLimit,
        requestTimeoutMs: args.requestTimeoutMs,
      },
      userAgent: report.userAgent,
      initResults: report.initResults,
      summaries,
      records,
    };

    if (args.reportPath) {
      const outputPath = resolve(process.cwd(), args.reportPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(fullReport, null, 2)}\n`, 'utf8');
      console.log(`\nWrote ${outputPath}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
