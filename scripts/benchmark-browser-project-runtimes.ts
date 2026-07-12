#!/usr/bin/env npx tsx

/**
 * End-to-end benchmark for the public project-browser workspace API.
 *
 * Node.js/tsx is only the Playwright orchestration process. Every measured
 * project command executes inside the selected browser engine through
 * createBrowserProjectWorkspace().
 * In particular, `node main.js` is the public browser JavaScript command syntax;
 * this benchmark does not assess or invoke a host Node.js project runtime.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Request } from 'playwright';

type Language = 'python' | 'javascript' | 'typescript' | 'java' | 'csharp' | 'cpp';
type BrowserEngine = 'chromium' | 'firefox' | 'webkit';
type Phase =
  | 'workspace-construction'
  | 'first-command'
  | 'second-fresh-command'
  | 'filesystem'
  | 'policy-denials'
  | 'http-bridge'
  | 'process-io'
  | 'cancellation'
  | 'disposal';
type PhaseStatus = 'passed' | 'failed' | 'skipped';

interface BenchmarkArgs {
  engine: BrowserEngine;
  languages: Language[];
  iterations: number;
  requestTimeoutMs: number;
  seed: number;
  prewarm: ProjectWorkerPrewarm;
  headful: boolean;
  smoke: boolean;
  cacheAssets: boolean;
  executionHost: boolean;
  runtimeManifestsPath: string | null;
  reportPath: string | null;
}

interface ProjectWorkerPrewarm {
  python: number;
  java: number;
  csharp: number;
}

interface ProjectFixture {
  entrypoint: string;
  command: string;
  expectedStdout: string;
  files: Array<{ path: string; contents: string }>;
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
  iteration: number;
  runOrdinal: number;
  phase: Phase;
  status: PhaseStatus;
  wallMs: number;
  errors: string[];
  skipReason?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  serializedResultBytes?: number;
  details?: Record<string, unknown>;
  resourceTiming: ResourceTimingSummary;
  longTasks: LongTaskSummary;
  memoryBefore?: BrowserMemorySnapshot;
  memoryAfter?: BrowserMemorySnapshot;
}

interface BrowserSampleResult {
  language: Language;
  iteration: number;
  runOrdinal: number;
  userAgent: string;
  crossOriginIsolated: boolean;
  moduleImportMs: number;
  memorySupport: {
    performanceMemory: boolean;
    userAgentSpecificMemory: boolean;
  };
  longTaskSupport: boolean;
  records: PhaseRecord[];
}

interface NetworkResourceRecord {
  runOrdinal: number;
  language: Language;
  iteration: number;
  phase: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  contentLength?: number;
  encodedBodyBytes?: number;
  requestHeadersBytes?: number;
  requestBodyBytes?: number;
  responseHeadersBytes?: number;
  responseBodyBytes?: number;
  totalTransferBytes?: number;
  startTimeMs?: number;
  responseStartMs?: number;
  responseEndMs?: number;
  failed?: string;
}

interface RunPlanItem {
  language: Language;
  iteration: number;
  runOrdinal: number;
}

interface SummaryRecord {
  language: Language;
  phase: Phase;
  samples: number;
  attempted: number;
  passed: number;
  failed: number;
  skipped: number;
  timedSamples: number;
  successRate: number | null;
  percentilesMeaningful: boolean;
  wallP50Ms: number | null;
  wallP95Ms: number | null;
  wallAvgMs: number | null;
  wallStddevMs: number | null;
  longTaskTotalAvgMs: number | null;
  heapDeltaAvgBytes: number | null;
  filesystemHostWriteAvgMs?: number | null;
  filesystemHostReadAvgMs?: number | null;
  filesystemShellAvgMs?: number | null;
}

const ALL_LANGUAGES: Language[] = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'];
const ALL_ENGINES: BrowserEngine[] = ['chromium', 'firefox', 'webkit'];
const PREWARM_LANGUAGES = ['python', 'java', 'csharp'] as const;
const ALL_PHASES: Phase[] = [
  'workspace-construction',
  'first-command',
  'second-fresh-command',
  'filesystem',
  'policy-denials',
  'http-bridge',
  'process-io',
  'cancellation',
  'disposal',
];
const DEFAULT_SEED = 20_260_711;
const EMPTY_RESOURCE_TIMING: ResourceTimingSummary = {
  entries: 0,
  transferBytes: 0,
  encodedBodyBytes: 0,
  decodedBodyBytes: 0,
  durationMs: 0,
};
const EMPTY_LONG_TASKS: LongTaskSummary = { supported: false };

const FIXTURES: Record<Language, ProjectFixture> = {
  python: {
    entrypoint: 'main.py',
    command: 'python3 main.py',
    expectedStdout: 'project-ok:42\n',
    files: [{ path: 'main.py', contents: 'value = 41\nprint(f"project-ok:{value + 1}")\n' }],
  },
  javascript: {
    entrypoint: 'main.js',
    // `node` is TraceCode's browser-project command spelling, not host Node.js.
    command: 'node main.js',
    expectedStdout: 'project-ok:42\n',
    files: [{ path: 'main.js', contents: 'const value = 41;\nconsole.log(`project-ok:${value + 1}`);\n' }],
  },
  typescript: {
    entrypoint: 'main.ts',
    command: 'tsc --project tsconfig.json && node dist/main.js',
    expectedStdout: 'project-ok:42\n',
    files: [
      { path: 'main.ts', contents: 'const value: number = 41;\nconsole.log(`project-ok:${value + 1}`);\n' },
      {
        path: 'tsconfig.json',
        contents: JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'CommonJS',
            outDir: 'dist',
            strict: true,
            skipLibCheck: true,
          },
          include: ['main.ts'],
        }, null, 2) + '\n',
      },
    ],
  },
  java: {
    entrypoint: 'Main.java',
    command: 'javac Main.java && java Main',
    expectedStdout: 'project-ok:42\n',
    files: [{
      path: 'Main.java',
      contents: [
        'public final class Main {',
        '  public static void main(String[] args) {',
        '    int value = 41;',
        '    System.out.println("project-ok:" + (value + 1));',
        '  }',
        '}',
        '',
      ].join('\n'),
    }],
  },
  csharp: {
    entrypoint: 'Program.cs',
    command: 'dotnet run --project App.csproj',
    expectedStdout: 'project-ok:42\n',
    files: [
      {
        path: 'App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>enable</Nullable>',
          '  </PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'Program.cs', contents: 'var value = 41;\nConsole.WriteLine($"project-ok:{value + 1}");\n' },
    ],
  },
  cpp: {
    entrypoint: 'main.cpp',
    command: 'clang++ -std=c++17 main.cpp -o project-bench && ./project-bench',
    expectedStdout: 'project-ok:42\n',
    files: [{
      path: 'main.cpp',
      contents: [
        '#include <iostream>',
        'int main() {',
        '  int value = 41;',
        '  std::cout << "project-ok:" << (value + 1) << "\\n";',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    }],
  },
};

function usage(): string {
  return [
    '',
    'Benchmarks the public createBrowserProjectWorkspace() API in a real browser engine.',
    'The Playwright Node.js process is orchestration only and is not benchmarked.',
    '',
    'Options:',
    '  --engine=chromium|firefox|webkit Browser engine. Default: chromium.',
    '  --languages=python,javascript,typescript,java,csharp,cpp',
    '                                  Project-browser runtimes. Default: all.',
    '  --iterations=5                  Fresh BrowserContext/workspace samples. Default: 5 (smoke: 1).',
    `  --seed=${DEFAULT_SEED}          Deterministic per-iteration shuffle seed.`,
    '  --prewarm=python:1,java:1       One-shot clean worker pool depths (0-2 each, total <=4). Default: all 0.',
    '  --request-timeout-ms=180000     Per public operation timeout.',
    '  --runtime-manifests=file.json   Consumer-owned cross-runtime asset manifests.',
    '  --smoke                         One JavaScript browser-project sample unless overridden.',
    '  --report=reports/file.json      JSON report path.',
    '  --no-report                     Do not write a JSON report.',
    '  --cache-assets                  Serve immutable cache headers so repeated commands exclude downloads.',
    '  --execution-host               Run Java through a dedicated cross-origin session host.',
    '  --headful                       Run the selected browser with a visible window.',
  ].join('\n');
}

function parseCsv<T extends string>(raw: string, allowed: readonly T[], label: string): T[] {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean) as T[];
  if (values.length === 0) throw new Error(`Expected at least one ${label}.`);
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new Error(`Unsupported ${label} "${value}". Expected one of: ${allowed.join(', ')}`);
    }
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

function parsePrewarm(raw: string): ProjectWorkerPrewarm {
  const result: ProjectWorkerPrewarm = { python: 0, java: 0, csharp: 0 };
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('--prewarm requires at least one language:depth entry.');
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = entry.match(/^([^:]+):(\d+)$/);
    if (!match) {
      throw new Error(`Invalid --prewarm entry "${entry}". Expected language:depth, for example python:1.`);
    }
    const language = match[1]!.trim();
    if (!(PREWARM_LANGUAGES as readonly string[]).includes(language)) {
      throw new Error(`Unsupported prewarm language "${language}". Expected: ${PREWARM_LANGUAGES.join(', ')}`);
    }
    if (seen.has(language)) throw new Error(`Duplicate --prewarm language "${language}".`);
    seen.add(language);
    const depth = Number(match[2]);
    if (!Number.isInteger(depth) || depth < 0 || depth > 2) {
      throw new Error(`Prewarm depth for ${language} must be an integer from 0 to 2.`);
    }
    result[language as keyof ProjectWorkerPrewarm] = depth;
  }
  const total = result.python + result.java + result.csharp;
  if (total > 4) throw new Error(`Total prewarm depth must not exceed 4; received ${total}.`);
  return result;
}

function parseArgs(argv: string[]): BenchmarkArgs {
  const args: BenchmarkArgs = {
    engine: 'chromium',
    languages: ALL_LANGUAGES,
    iterations: 5,
    requestTimeoutMs: 180_000,
    seed: DEFAULT_SEED,
    prewarm: { python: 0, java: 0, csharp: 0 },
    headful: false,
    smoke: false,
    cacheAssets: false,
    executionHost: false,
    runtimeManifestsPath: process.env.TRACECODE_BENCH_RUNTIME_MANIFESTS?.trim() || null,
    reportPath: join('reports', 'browser-project-runtime-benchmark.json'),
  };
  let explicitLanguages = false;
  let explicitIterations = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--headful') {
      args.headful = true;
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
    if (arg === '--execution-host') {
      args.executionHost = true;
      continue;
    }
    if (arg.startsWith('--engine=')) {
      const engines = parseCsv(arg.slice('--engine='.length), ALL_ENGINES, 'browser engine');
      if (engines.length !== 1) throw new Error('--engine accepts exactly one browser engine.');
      args.engine = engines[0]!;
      continue;
    }
    if (arg.startsWith('--languages=')) {
      args.languages = parseCsv(arg.slice('--languages='.length), ALL_LANGUAGES, 'language');
      explicitLanguages = true;
      continue;
    }
    if (arg.startsWith('--iterations=')) {
      args.iterations = positiveInteger(arg.slice('--iterations='.length), 'iterations');
      explicitIterations = true;
      continue;
    }
    if (arg.startsWith('--request-timeout-ms=')) {
      args.requestTimeoutMs = positiveInteger(arg.slice('--request-timeout-ms='.length), 'request-timeout-ms');
      continue;
    }
    if (arg.startsWith('--seed=')) {
      args.seed = nonNegativeInteger(arg.slice('--seed='.length), 'seed');
      continue;
    }
    if (arg.startsWith('--prewarm=')) {
      args.prewarm = parsePrewarm(arg.slice('--prewarm='.length));
      continue;
    }
    if (arg.startsWith('--runtime-manifests=')) {
      const pathname = arg.slice('--runtime-manifests='.length).trim();
      if (!pathname) throw new Error('--runtime-manifests requires a non-empty path.');
      args.runtimeManifestsPath = pathname;
      continue;
    }
    if (arg.startsWith('--report=')) {
      const pathname = arg.slice('--report='.length).trim();
      if (!pathname) throw new Error('--report requires a non-empty path.');
      args.reportPath = pathname;
      continue;
    }
    throw new Error(`Unknown option "${arg}".\n${usage()}`);
  }

  if (args.smoke) {
    if (!explicitLanguages) args.languages = ['javascript'];
    if (!explicitIterations) args.iterations = 1;
  }
  for (const language of PREWARM_LANGUAGES) {
    if (args.prewarm[language] > 0 && !args.languages.includes(language)) {
      throw new Error(
        `--prewarm configures ${language}:${args.prewarm[language]}, but ${language} is not in --languages. `
        + 'Prewarming an unmeasured runtime would contaminate the selected samples.'
      );
    }
  }
  return args;
}

function manifestsForExecutionOrigin(
  manifests: Record<string, unknown> | undefined,
  executionOrigin: string
): Record<string, unknown> | undefined {
  if (!manifests) return undefined;
  const cloned = structuredClone(manifests);
  const java = cloned.java as {
    assetBaseUrl?: string;
    assets?: Record<string, { url?: string; originPolicy?: unknown }>;
  } | undefined;
  if (!java?.assets) return cloned;
  const rawBase = java.assetBaseUrl ?? '/workers';
  const baseUrl = new URL(rawBase.endsWith('/') ? rawBase : `${rawBase}/`, `${executionOrigin}/`);
  for (const name of ['worker', 'helperJar', 'compilerJar', 'rewriterJar', 'parserJar']) {
    const descriptor = java.assets[name];
    if (!descriptor?.url) continue;
    descriptor.url = new URL(descriptor.url, baseUrl).href;
    descriptor.originPolicy = { mode: 'allow-list', origins: [executionOrigin] };
  }
  java.assetBaseUrl = baseUrl.href.replace(/\/$/u, '');
  return cloned;
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
  if (!isRecord(parsed)) throw new Error(`Browser runtime manifest file ${absolutePath} must contain a JSON object.`);
  const manifests = isRecord(parsed.runtimeManifests) ? parsed.runtimeManifests : parsed;
  if (Object.keys(manifests).length === 0) {
    throw new Error(`Browser runtime manifest file ${absolutePath} does not contain any runtime entries.`);
  }
  return manifests;
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.tar': return 'application/x-tar';
    case '.jar': return 'application/java-archive';
    default: return 'application/octet-stream';
  }
}

async function runAssetSync(targetDir: string, languages: readonly Language[]): Promise<void> {
  const cliPath = resolve(process.cwd(), 'src/cli.ts');
  const tsxCliPath = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  // The asset CLI aliases TypeScript to JavaScript because both share the
  // browser JS project worker and TypeScript compiler assets.
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

async function buildPublicProjectBundle(tempRoot: string): Promise<{
  path: string;
  rawBytes: number;
  gzipBytes: number;
  buildMs: number;
}> {
  const outfile = join(tempRoot, 'benchmark-project-harness.mjs');
  const startedAt = performance.now();
  await build({
    entryPoints: [resolve(process.cwd(), 'packages/harness-browser/src/project.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: false,
    logLevel: 'warning',
    alias: {
      zlib: resolve(process.cwd(), 'packages/harness-project/src/zlib-browser-shim.ts'),
      'node:zlib': resolve(process.cwd(), 'packages/harness-project/src/zlib-browser-shim.ts'),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
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

async function buildExecutionHostBundle(tempRoot: string): Promise<void> {
  await build({
    entryPoints: [resolve(process.cwd(), 'packages/harness-browser/src/execution-host.ts')],
    outfile: join(tempRoot, 'benchmark-execution-host.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
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
        'Cross-Origin-Resource-Policy': 'cross-origin',
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
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Timing-Allow-Origin': '*',
    };

    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : fileStat.size - 1;
      if (!match || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= fileStat.size) {
        response.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${fileStat.size}` });
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

    response.writeHead(200, { ...baseHeaders, 'Content-Length': String(fileStat.size) });
    createReadStream(filePath).pipe(response);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve benchmark server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
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

function createRunPlan(args: BenchmarkArgs): RunPlanItem[] {
  const plan: Array<Omit<RunPlanItem, 'runOrdinal'>> = [];
  for (let iteration = 0; iteration < args.iterations; iteration += 1) {
    const items = args.languages.map((language) => ({ language, iteration }));
    plan.push(...deterministicShuffle(items, args.seed + iteration));
  }
  return plan.map((item, runOrdinal) => ({ ...item, runOrdinal }));
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function redactNetworkUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const [name] of url.searchParams) {
      if (
        /(^|[-_])(token|secret|signature|credential|password|auth|authorization|key|code|session)([-_]|$)/i.test(name)
        || name.toLowerCase() === 'policy'
      ) {
        url.searchParams.set(name, 'redacted');
      }
    }
    return url.toString();
  } catch {
    return value.replace(
      /([?&][^=&#]*(?:token|secret|signature|credential|password|auth|key|code|session)[^=&#]*=)[^&#\s]*/gi,
      '$1redacted'
    );
  }
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

function collectNetworkMetrics(
  context: BrowserContext,
  phaseRef: { current: string },
  item: RunPlanItem,
  records: NetworkResourceRecord[],
  pending: Promise<void>[]
): void {
  const phases = new WeakMap<Request, string>();
  context.on('request', (request) => phases.set(request, phaseRef.current));
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
      const encodedBodyBytes = responseBodyBytes && responseBodyBytes > 0 ? responseBodyBytes : contentLength;
      records.push({
        runOrdinal: item.runOrdinal,
        language: item.language,
        iteration: item.iteration,
        phase: phases.get(request) ?? phaseRef.current,
        url: redactNetworkUrl(request.url()),
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
        iteration: item.iteration,
        phase: phases.get(request) ?? phaseRef.current,
        url: redactNetworkUrl(request.url()),
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
      iteration: item.iteration,
      phase: phases.get(request) ?? phaseRef.current,
      url: redactNetworkUrl(request.url()),
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

function skippedRecord(item: RunPlanItem, phase: Phase, reason: string): PhaseRecord {
  return {
    language: item.language,
    iteration: item.iteration,
    runOrdinal: item.runOrdinal,
    phase,
    status: 'skipped',
    wallMs: 0,
    errors: [],
    skipReason: reason,
    resourceTiming: { ...EMPTY_RESOURCE_TIMING },
    longTasks: { ...EMPTY_LONG_TASKS },
  };
}

async function runBrowserPlanItem(
  browserOrigin: string,
  browser: Browser,
  item: RunPlanItem,
  args: BenchmarkArgs,
  networkRecords: NetworkResourceRecord[],
  runtimeManifests: Record<string, unknown> | undefined,
  executionHostUrl?: string
): Promise<{
  result?: BrowserSampleResult;
  error?: string;
  cdpMetrics?: { before: Record<string, number>; after: Record<string, number>; delta: Record<string, number> };
  cdpUnsupportedReason?: string;
  networkFlushComplete: boolean;
}> {
  const context = await browser.newContext();
  const phaseRef = { current: 'page-bootstrap' };
  const pendingNetwork: Promise<void>[] = [];
  collectNetworkMetrics(context, phaseRef, item, networkRecords, pendingNetwork);
  const page = await context.newPage();
  page.setDefaultTimeout(args.requestTimeoutMs + 30_000);

  let phaseWatchdog: ReturnType<typeof setTimeout> | undefined;
  let phaseWatchdogError: string | undefined;
  let rejectPhaseWatchdog: ((error: Error) => void) | undefined;
  const phaseWatchdogFailure = new Promise<never>((_resolve, reject) => {
    rejectPhaseWatchdog = reject;
  });
  await page.exposeFunction('__tracecodeProjectBenchPhase', (phase: string) => {
    phaseRef.current = phase;
    if (phaseWatchdog !== undefined) clearTimeout(phaseWatchdog);
    phaseWatchdog = setTimeout(() => {
      phaseWatchdogError = `${phase} blocked the browser renderer for more than ${args.requestTimeoutMs}ms`;
      rejectPhaseWatchdog?.(new Error(phaseWatchdogError));
      void context.close().catch(() => undefined);
    }, args.requestTimeoutMs + 1_000);
  });
  page.on('console', (message) => {
    if (process.env.TRACECODE_BENCH_DEBUG === '1' || message.type() === 'warning' || message.type() === 'error') {
      void Promise.all(message.args().map(async (argument) => {
        try {
          return await argument.jsonValue();
        } catch {
          return argument.toString();
        }
      })).then((values) => {
        const details = values.length > 0
          ? ` ${JSON.stringify(values)}`
          : '';
        console.error(`[project-browser ${item.language} ${message.type()}] ${message.text()}${details}`);
      });
    }
  });
  page.on('pageerror', (error) => console.error(`[project-browser ${item.language} pageerror] ${error.message}`));

  let cdpSession: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
  let cdpBefore: Record<string, number> | undefined;
  let cdpUnsupportedReason: string | undefined;
  const samplePrewarm: ProjectWorkerPrewarm = {
    python: item.language === 'python' ? args.prewarm.python : 0,
    java: item.language === 'java' ? args.prewarm.java : 0,
    csharp: item.language === 'csharp' ? args.prewarm.csharp : 0,
  };

  try {
    await page.goto(`${browserOrigin}/index.html?run=${item.runOrdinal}`, { waitUntil: 'load' });
    // esbuild's browser bundle helper is normally injected by bundled callers;
    // direct dynamic import needs the same harmless global binding.
    await page.evaluate('globalThis.__name = (fn) => fn');
    try {
      cdpSession = await context.newCDPSession(page);
      await cdpSession.send('Performance.enable');
      cdpBefore = metricMap((await cdpSession.send('Performance.getMetrics')).metrics);
    } catch (error) {
      cdpUnsupportedReason = error instanceof Error ? error.message : String(error);
    }

    const fixture = FIXTURES[item.language];
    const evaluation = page.evaluate(
      async ({ language, iteration, runOrdinal, fixture, requestTimeoutMs, runtimeManifests, prewarm, executionHostUrl }) => {
        const benchmarkPhase = (globalThis as typeof globalThis & {
          __tracecodeProjectBenchPhase?: (phase: string) => Promise<void>;
        }).__tracecodeProjectBenchPhase;
        const dependentPhases: Phase[] = [
          'first-command',
          'second-fresh-command',
          'filesystem',
          'policy-denials',
          'http-bridge',
          'process-io',
          'cancellation',
          'disposal',
        ];
        const encoder = new TextEncoder();
        const records: PhaseRecord[] = [];
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

        function errorMessage(error: unknown): string {
          return error instanceof Error ? error.message : String(error);
        }

        function memorySnapshot(): BrowserMemorySnapshot | undefined {
          const memory = (performance as Performance & {
            memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
          }).memory;
          if (
            typeof memory?.usedJSHeapSize !== 'number'
            || typeof memory.totalJSHeapSize !== 'number'
            || typeof memory.jsHeapSizeLimit !== 'number'
          ) return undefined;
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

        function serializedBytes(value: unknown): number {
          try {
            return encoder.encode(JSON.stringify(value) ?? '').byteLength;
          } catch {
            return 0;
          }
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

        async function measurePhase<T>(
          phase: Phase,
          operation: () => Promise<T>,
          validate: (value: T) => string[],
          shape: (value: T) => Partial<PhaseRecord> = () => ({})
        ): Promise<{ value?: T; record: PhaseRecord }> {
          await benchmarkPhase?.(phase);
          const resourceIndex = performance.getEntriesByType('resource').length;
          const longTaskIndex = longTaskEntries.length;
          const memoryBefore = memorySnapshot();
          const startedAt = performance.now();
          let value: T | undefined;
          let errors: string[] = [];
          try {
            value = await operation();
            errors = validate(value);
          } catch (error) {
            errors = [errorMessage(error)];
          }
          const wallMs = performance.now() - startedAt;
          await settleInstrumentation();
          const record: PhaseRecord = {
            language,
            iteration,
            runOrdinal,
            phase,
            status: errors.length === 0 ? 'passed' : 'failed',
            wallMs,
            errors,
            ...(value === undefined ? {} : shape(value)),
            resourceTiming: resourceSummary(resourceIndex),
            longTasks: longTaskSummary(longTaskIndex),
            memoryBefore,
            memoryAfter: memorySnapshot(),
          };
          records.push(record);
          return { value, record };
        }

        await benchmarkPhase?.('public-module-import');
        const moduleStartedAt = performance.now();
        const publicProjectModule = await import('/benchmark-project-harness.mjs') as {
          createBrowserProjectWorkspace(options: Record<string, unknown>): Promise<any>;
        };
        const moduleImportMs = performance.now() - moduleStartedAt;
        await settleInstrumentation();

        let workspace: any;
        const construction = await measurePhase(
          'workspace-construction',
          () => withTimeout(
            'workspace construction',
            publicProjectModule.createBrowserProjectWorkspace({
              assetBaseUrl: '/workers',
              ...(runtimeManifests ? { assets: { runtimeManifests } } : {}),
              ...(language === 'java' && executionHostUrl
                ? {
                    executionHost: {
                      url: executionHostUrl,
                      javaLifecycle: 'workspace-session',
                    },
                  }
                : {}),
              projectWorkerIsolation: 'per-command',
              projectWorkerPrewarm: prewarm,
              pythonProjectTimeoutMs: requestTimeoutMs,
              javaProjectTimeoutMs: requestTimeoutMs,
              csharpProjectTimeoutMs: requestTimeoutMs,
              cppProjectTimeoutMs: requestTimeoutMs,
              files: fixture.files,
              entrypoint: fixture.entrypoint,
              projectSession: {
                id: `browser-project-benchmark-${language}-${runOrdinal}`,
                language,
                files: [
                  { path: 'readonly.txt', contents: 'readonly-original\n', readonly: true },
                  { path: '.trace/hidden.txt', contents: 'hidden-secret\n', hidden: true, readonly: true },
                ],
              },
            })
          ),
          () => [],
          () => ({ details: { isolation: 'per-command', entrypoint: fixture.entrypoint, prewarm } })
        );
        workspace = construction.value;
        if (!workspace) {
          const reason = construction.record.errors.join('; ') || 'workspace construction failed';
          for (const phase of dependentPhases) {
            records.push({
              language,
              iteration,
              runOrdinal,
              phase,
              status: 'skipped',
              wallMs: 0,
              errors: [],
              skipReason: reason,
              resourceTiming: {
                entries: 0,
                transferBytes: 0,
                encodedBodyBytes: 0,
                decodedBodyBytes: 0,
                durationMs: 0,
              },
              longTasks: { supported: longTaskSupported, ...(longTaskSupported ? { count: 0, totalDurationMs: 0, maxDurationMs: 0 } : {}) },
            });
          }
          longTaskObserver?.disconnect();
          return {
            language,
            iteration,
            runOrdinal,
            userAgent: navigator.userAgent,
            crossOriginIsolated: globalThis.crossOriginIsolated,
            moduleImportMs,
            memorySupport: {
              performanceMemory: memorySnapshot() !== undefined,
              userAgentSpecificMemory: typeof (performance as Performance & { measureUserAgentSpecificMemory?: unknown }).measureUserAgentSpecificMemory === 'function',
            },
            longTaskSupport: longTaskSupported,
            records,
          } satisfies BrowserSampleResult;
        }

        try {
          const runProjectCommand = async (label: string, command: string) => {
            const controller = new AbortController();
            return withTimeout(label, workspace.runCommand(command, { signal: controller.signal }), controller);
          };
          const commandShape = (result: { exitCode: number; stdout: string; stderr: string }) => ({
            command: fixture.command,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            serializedResultBytes: serializedBytes(result),
          });
          const validateCommand = (result: { exitCode: number; stdout: string; stderr: string }): string[] => {
            const errors: string[] = [];
            if (result.exitCode !== 0) errors.push(`expected exit 0, received ${result.exitCode}`);
            if (result.stdout !== fixture.expectedStdout) {
              errors.push(`stdout mismatch: expected ${JSON.stringify(fixture.expectedStdout)}, received ${JSON.stringify(result.stdout)}`);
            }
            return errors;
          };

          await measurePhase(
            'first-command',
            () => runProjectCommand('first project command', fixture.command),
            validateCommand,
            commandShape
          );
          await measurePhase(
            'second-fresh-command',
            () => runProjectCommand('second project command', fixture.command),
            validateCommand,
            commandShape
          );

          await measurePhase(
            'filesystem',
            async () => {
              const writeStartedAt = performance.now();
              await withTimeout('workspace.writeFile', workspace.writeFile('host-written.txt', 'fs-host-ok\n'));
              const hostWriteMs = performance.now() - writeStartedAt;
              const readStartedAt = performance.now();
              const hostRead = await withTimeout('workspace.readFile', workspace.readFile('host-written.txt'));
              const hostReadMs = performance.now() - readStartedAt;
              const shellStartedAt = performance.now();
              const shell = await runProjectCommand(
                'filesystem shell command',
                "printf 'fs-shell-ok\\n' > shell-written.txt && cat shell-written.txt"
              );
              const shellMs = performance.now() - shellStartedAt;
              const persisted = await withTimeout('filesystem persisted read', workspace.readFile('shell-written.txt'));
              return { hostWriteMs, hostReadMs, shellMs, hostRead, shell, persisted };
            },
            (value) => {
              const errors: string[] = [];
              if (value.hostRead !== 'fs-host-ok\n') errors.push(`host read mismatch: ${JSON.stringify(value.hostRead)}`);
              if (value.shell.exitCode !== 0) errors.push(`shell exit code ${value.shell.exitCode}`);
              if (value.shell.stdout !== 'fs-shell-ok\n') errors.push(`shell stdout mismatch: ${JSON.stringify(value.shell.stdout)}`);
              if (value.persisted !== 'fs-shell-ok\n') errors.push(`shell persistence mismatch: ${JSON.stringify(value.persisted)}`);
              return errors;
            },
            (value) => ({
              command: "printf 'fs-shell-ok\\n' > shell-written.txt && cat shell-written.txt",
              exitCode: value.shell.exitCode,
              stdout: value.shell.stdout,
              stderr: value.shell.stderr,
              serializedResultBytes: serializedBytes(value),
              details: {
                hostWriteMs: value.hostWriteMs,
                hostReadMs: value.hostReadMs,
                shellMs: value.shellMs,
              },
            })
          );

          await measurePhase(
            'policy-denials',
            async () => {
              const settleDeniedCommand = async (label: string, command: string) => {
                try {
                  return { result: await runProjectCommand(label, command) };
                } catch (error) {
                  return { error: errorMessage(error) };
                }
              };
              const hiddenRead = await settleDeniedCommand('hidden file denial', 'cat .trace/hidden.txt');
              const readonlyWrite = await settleDeniedCommand(
                'readonly file denial',
                "printf 'changed\\n' > readonly.txt"
              );
              const readonlyAfter = await withTimeout('readonly verification', workspace.readFile('readonly.txt'));
              return { hiddenRead, readonlyWrite, readonlyAfter };
            },
            (value) => {
              const errors: string[] = [];
              const hiddenOutput = value.hiddenRead.result
                ? `${value.hiddenRead.result.stdout}\n${value.hiddenRead.result.stderr}`
                : value.hiddenRead.error ?? '';
              const hiddenDenied = value.hiddenRead.error !== undefined || value.hiddenRead.result?.exitCode !== 0;
              const readonlyDenied = value.readonlyWrite.error !== undefined || value.readonlyWrite.result?.exitCode !== 0;
              if (!hiddenDenied) errors.push('ordinary command unexpectedly read the hidden file');
              if (hiddenOutput.includes('hidden-secret')) errors.push('hidden contents leaked through command output');
              if (!readonlyDenied) errors.push('ordinary command unexpectedly wrote the readonly file');
              if (value.readonlyAfter !== 'readonly-original\n') {
                errors.push(`readonly file changed: ${JSON.stringify(value.readonlyAfter)}`);
              }
              return errors;
            },
            (value) => ({
              serializedResultBytes: serializedBytes(value),
              details: {
                hiddenReadExitCode: value.hiddenRead.result?.exitCode,
                hiddenReadStdout: value.hiddenRead.result?.stdout,
                hiddenReadStderr: value.hiddenRead.result?.stderr,
                hiddenReadError: value.hiddenRead.error,
                readonlyWriteExitCode: value.readonlyWrite.result?.exitCode,
                readonlyWriteStdout: value.readonlyWrite.result?.stdout,
                readonlyWriteStderr: value.readonlyWrite.result?.stderr,
                readonlyWriteError: value.readonlyWrite.error,
                readonlyAfter: value.readonlyAfter,
              },
            })
          );

          await measurePhase(
            'http-bridge',
            async () => {
              const listener = workspace.http.listen({ host: '127.0.0.1', port: 0 }, (request: { method: string; path: string }) => ({
                status: 200,
                headers: { 'content-type': 'text/plain' },
                body: `http-ok:${request.method}:${request.path}\n`,
              }));
              try {
                const command = `curl -s http://127.0.0.1:${listener.info.port}/probe`;
                const result = await runProjectCommand('TraceKernel HTTP bridge', command);
                return { command, result, port: listener.info.port };
              } finally {
                listener.close();
              }
            },
            (value) => {
              const errors: string[] = [];
              if (value.result.exitCode !== 0) errors.push(`curl exit code ${value.result.exitCode}`);
              if (value.result.stdout !== 'http-ok:GET:/probe\n') {
                errors.push(`HTTP bridge stdout mismatch: ${JSON.stringify(value.result.stdout)}`);
              }
              return errors;
            },
            (value) => ({
              command: value.command,
              exitCode: value.result.exitCode,
              stdout: value.result.stdout,
              stderr: value.result.stderr,
              serializedResultBytes: serializedBytes(value),
              details: { listenerPort: value.port, transport: 'public workspace.http.listen -> public shell curl' },
            })
          );

          await measurePhase(
            'process-io',
            () => runProjectCommand(
              'process stdio contract',
              "printf 'stdin-ok\\n' | cat && printf 'stdout-ok\\n' && printf 'stderr-ok\\n' >&2"
            ),
            (result) => {
              const errors: string[] = [];
              if (result.exitCode !== 0) errors.push(`stdio command exit code ${result.exitCode}`);
              if (result.stdout !== 'stdin-ok\nstdout-ok\n') {
                errors.push(`stdio stdout mismatch: ${JSON.stringify(result.stdout)}`);
              }
              if (result.stderr !== 'stderr-ok\n') {
                errors.push(`stdio stderr mismatch: ${JSON.stringify(result.stderr)}`);
              }
              return errors;
            },
            (result) => ({
              command: "printf 'stdin-ok\\n' | cat && printf 'stdout-ok\\n' && printf 'stderr-ok\\n' >&2",
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              serializedResultBytes: serializedBytes(result),
            })
          );

          await measurePhase(
            'cancellation',
            async () => {
              const controller = new AbortController();
              const startedAt = performance.now();
              const timer = setTimeout(() => controller.abort(), 25);
              try {
                const result = await workspace.runCommand('sleep 30', { signal: controller.signal });
                return { result, wallMs: performance.now() - startedAt };
              } catch (error) {
                return {
                  error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                  wallMs: performance.now() - startedAt,
                };
              } finally {
                clearTimeout(timer);
              }
            },
            (value) => {
              const errors: string[] = [];
              const resultError = value.result && 'error' in value.result ? value.result.error : undefined;
              const cancelled = value.error !== undefined || resultError !== undefined || value.result?.exitCode !== 0;
              if (!cancelled) errors.push(`cancelled command unexpectedly completed: ${JSON.stringify(value.result)}`);
              if (value.wallMs > 5_000) errors.push(`cancelled command took ${value.wallMs.toFixed(1)}ms to settle`);
              return errors;
            },
            (value) => ({
              command: 'sleep 30',
              exitCode: value.result?.exitCode,
              stdout: value.result?.stdout,
              stderr: value.result?.stderr,
              details: {
                cancellationError: value.error,
                resultError: value.result && 'error' in value.result ? value.result.error : undefined,
                cancellationWallMs: value.wallMs,
              },
              serializedResultBytes: serializedBytes(value),
            })
          );

          await measurePhase(
            'disposal',
            async () => {
              const iframeCountBefore = document.querySelectorAll('iframe').length;
              workspace.dispose();
              await new Promise((resolve) => setTimeout(resolve, 0));
              const iframeCountAfter = document.querySelectorAll('iframe').length;
              workspace.dispose();
              return { iframeCountBefore, iframeCountAfter };
            },
            (value) => {
              const errors: string[] = [];
              if (value.iframeCountAfter !== 0) {
                errors.push(`workspace disposal left ${value.iframeCountAfter} execution iframe(s)`);
              }
              if (language === 'java' && executionHostUrl && value.iframeCountBefore !== 1) {
                errors.push(`Java execution-host workspace expected one iframe before disposal, found ${value.iframeCountBefore}`);
              }
              return errors;
            },
            (value) => ({ details: value, serializedResultBytes: serializedBytes(value) })
          );
        } finally {
          workspace.dispose();
        }

        longTaskObserver?.disconnect();
        return {
          language,
          iteration,
          runOrdinal,
          userAgent: navigator.userAgent,
          crossOriginIsolated: globalThis.crossOriginIsolated,
          moduleImportMs,
          memorySupport: {
            performanceMemory: memorySnapshot() !== undefined,
            userAgentSpecificMemory: typeof (performance as Performance & { measureUserAgentSpecificMemory?: unknown }).measureUserAgentSpecificMemory === 'function',
          },
          longTaskSupport: longTaskSupported,
          records,
        } satisfies BrowserSampleResult;
      },
      {
        language: item.language,
        iteration: item.iteration,
        runOrdinal: item.runOrdinal,
        fixture,
        requestTimeoutMs: args.requestTimeoutMs,
        runtimeManifests,
        prewarm: samplePrewarm,
        executionHostUrl,
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
    const networkFlushComplete = await settleBeforeDeadline(Promise.allSettled(pendingNetwork), 2_000);
    return { result, cdpMetrics, cdpUnsupportedReason, networkFlushComplete };
  } catch (error) {
    if (phaseWatchdog !== undefined) clearTimeout(phaseWatchdog);
    const networkFlushComplete = await settleBeforeDeadline(Promise.allSettled(pendingNetwork), 2_000);
    return {
      error: phaseWatchdogError
        ? `${phaseWatchdogError}. The host closed the context because an in-page timer cannot fire while the renderer is blocked.`
        : error instanceof Error ? error.stack ?? error.message : String(error),
      cdpUnsupportedReason,
      networkFlushComplete,
    };
  } finally {
    if (phaseWatchdog !== undefined) clearTimeout(phaseWatchdog);
    await settleBeforeDeadline(context.close(), 2_000);
  }
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return 0;
  const mean = average(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index]!;
}

function numericDetail(record: PhaseRecord, key: string): number | undefined {
  const value = record.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarize(records: readonly PhaseRecord[]): SummaryRecord[] {
  const groups = new Map<string, PhaseRecord[]>();
  for (const record of records) {
    const key = `${record.language}\0${record.phase}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map((items) => {
    const first = items[0]!;
    const attempted = items.filter((item) => item.status !== 'skipped');
    const passed = items.filter((item) => item.status === 'passed');
    const wallValues = passed.map((item) => item.wallMs);
    const longTaskValues = passed
      .map((item) => item.longTasks.totalDurationMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const heapDeltas = passed
      .map((item) => item.memoryBefore && item.memoryAfter
        ? item.memoryAfter.usedJSHeapSize - item.memoryBefore.usedJSHeapSize
        : undefined)
      .filter((value): value is number => value !== undefined);
    const percentilesMeaningful = wallValues.length >= 5;
    const detailAverage = (key: string): number | null => average(
      passed.map((record) => numericDetail(record, key)).filter((value): value is number => value !== undefined)
    );
    return {
      language: first.language,
      phase: first.phase,
      samples: items.length,
      attempted: attempted.length,
      passed: passed.length,
      failed: items.filter((item) => item.status === 'failed').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      timedSamples: wallValues.length,
      successRate: attempted.length > 0 ? passed.length / attempted.length : null,
      percentilesMeaningful,
      wallP50Ms: percentilesMeaningful ? percentile(wallValues, 0.5) : null,
      wallP95Ms: percentilesMeaningful ? percentile(wallValues, 0.95) : null,
      wallAvgMs: average(wallValues),
      wallStddevMs: standardDeviation(wallValues),
      longTaskTotalAvgMs: average(longTaskValues),
      heapDeltaAvgBytes: average(heapDeltas),
      ...(first.phase === 'filesystem'
        ? {
            filesystemHostWriteAvgMs: detailAverage('hostWriteMs'),
            filesystemHostReadAvgMs: detailAverage('hostReadMs'),
            filesystemShellAvgMs: detailAverage('shellMs'),
          }
        : {}),
    };
  }).sort((left, right) => {
    const languageOrder = ALL_LANGUAGES.indexOf(left.language) - ALL_LANGUAGES.indexOf(right.language);
    return languageOrder || ALL_PHASES.indexOf(left.phase) - ALL_PHASES.indexOf(right.phase);
  });
}

function summarizeNetwork(records: readonly NetworkResourceRecord[]) {
  const groups = new Map<string, NetworkResourceRecord[]>();
  for (const record of records) {
    const key = `${record.language}\0${record.phase}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map((items) => {
    const first = items[0]!;
    const runs = new Set(items.map((item) => item.runOrdinal)).size;
    const encodedBodyBytes = items.reduce((sum, item) => sum + (item.encodedBodyBytes ?? 0), 0);
    const totalTransferBytes = items.reduce((sum, item) => sum + (item.totalTransferBytes ?? 0), 0);
    return {
      language: first.language,
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

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (Math.abs(value) < 10) return value.toFixed(1);
  return String(Math.round(value));
}

function printSummary(summaries: readonly SummaryRecord[], engine: BrowserEngine): void {
  console.log('\nPublic project-browser runtime benchmark');
  console.log(`Measured boundary: ${engine} project workspaces only; host Node.js is orchestration and excluded.`);
  console.log('\nlanguage    phase                    pass       p50 ms  p95 ms  avg ms  stddev');
  for (const item of summaries) {
    const pass = `${item.passed}/${item.attempted}${item.skipped ? ` (+${item.skipped}s)` : ''}`;
    console.log([
      item.language.padEnd(10),
      item.phase.padEnd(24),
      pass.padEnd(10),
      formatMs(item.wallP50Ms).padStart(7),
      formatMs(item.wallP95Ms).padStart(7),
      formatMs(item.wallAvgMs).padStart(7),
      formatMs(item.wallStddevMs).padStart(7),
    ].join('  '));
  }
}

function metricCoverage(
  records: readonly PhaseRecord[],
  networkRecords: readonly NetworkResourceRecord[],
  engine: BrowserEngine
) {
  const attempted = records.filter((record) => record.status !== 'skipped');
  return {
    operationWallTime: {
      supported: true,
      records: attempted.length,
      source: 'performance.now around public createBrowserProjectWorkspace/workspace methods',
    },
    mainThreadLongTasks: {
      supportedRecords: attempted.filter((record) => record.longTasks.supported).length,
      records: attempted.length,
      scope: 'window main thread only; worker activity is represented by public operation wall time',
    },
    memory: {
      supportedRecords: attempted.filter((record) => record.memoryBefore && record.memoryAfter).length,
      records: attempted.length,
      source: engine === 'chromium'
        ? 'Chromium performance.memory with --enable-precise-memory-info when exposed'
        : `${engine} performance.memory when exposed`,
    },
    network: {
      completedResources: networkRecords.filter((record) => !record.failed).length,
      failedResources: networkRecords.filter((record) => record.failed).length,
      encodedSizeResources: networkRecords.filter((record) => record.encodedBodyBytes !== undefined).length,
      source: `Playwright BrowserContext request sizes, including worker and CDN requests reported by ${engine}`,
    },
    cdp: {
      source: 'Chrome DevTools Protocol Performance.getMetrics before and after each complete browser sample',
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtimeManifests = await loadRuntimeManifests(args.runtimeManifestsPath);
  const runPlan = createRunPlan(args);
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-browser-project-bench-'));
  const workersRoot = join(tempRoot, 'workers');
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  let executionServer: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  let browser: Browser | undefined;

  try {
    await runAssetSync(workersRoot, args.languages);
    const bundle = await buildPublicProjectBundle(tempRoot);
    if (args.executionHost) await buildExecutionHostBundle(tempRoot);
    await writeFile(join(tempRoot, 'index.html'), [
      '<!doctype html>',
      '<meta charset="utf-8">',
      '<title>TraceCode public project-browser runtime benchmark</title>',
    ].join('\n'), 'utf8');
    server = await startStaticServer(resolve(tempRoot), args.cacheAssets);
    let effectiveRuntimeManifests = runtimeManifests;
    let executionHostUrl: string | undefined;
    if (args.executionHost) {
      executionServer = await startStaticServer(resolve(tempRoot), args.cacheAssets);
      executionHostUrl =
        `${executionServer.origin}/execution-host.html?parentOrigin=${encodeURIComponent(server.origin)}`;
      effectiveRuntimeManifests = manifestsForExecutionOrigin(runtimeManifests, executionServer.origin);
      await writeFile(join(tempRoot, 'execution-host.html'), [
        '<!doctype html>',
        '<meta charset="utf-8">',
        '<title>TraceCode benchmark execution host</title>',
        '<script type="module">',
        "import { installBrowserExecutionWorkerHost } from '/benchmark-execution-host.mjs';",
        "const parentOrigin = new URL(location.href).searchParams.get('parentOrigin');",
        "if (!parentOrigin) throw new Error('Missing parentOrigin');",
        'installBrowserExecutionWorkerHost({ allowedParentOrigins: [parentOrigin] });',
        '</script>',
      ].join('\n'), 'utf8');
    }
    const browserType = args.engine === 'firefox'
      ? firefox
      : args.engine === 'webkit'
        ? webkit
        : chromium;
    browser = await browserType.launch({
      headless: !args.headful,
      ...(args.engine === 'chromium' ? { args: ['--enable-precise-memory-info'] } : {}),
    });

    const samples: BrowserSampleResult[] = [];
    const records: PhaseRecord[] = [];
    const runErrors: Array<{ runOrdinal: number; language: Language; iteration: number; error: string }> = [];
    const runDiagnostics: Array<{ runOrdinal: number; language: Language; warning: string }> = [];
    const networkRecords: NetworkResourceRecord[] = [];
    const cdpMetrics: Array<{
      runOrdinal: number;
      language: Language;
      iteration: number;
      before?: Record<string, number>;
      after?: Record<string, number>;
      delta?: Record<string, number>;
      unsupportedReason?: string;
    }> = [];

    console.log(
      `Prewarm depths: python=${args.prewarm.python}, java=${args.prewarm.java}, csharp=${args.prewarm.csharp} `
      + '(default baseline is zero)'
    );
    console.log(`Run order seed ${args.seed}: ${runPlan.map((item) => `${item.language}#${item.iteration + 1}`).join(', ')}`);
    for (const item of runPlan) {
      console.log(`[${item.runOrdinal + 1}/${runPlan.length}] ${item.language} iteration ${item.iteration + 1}`);
      const run = await runBrowserPlanItem(
        server.origin,
        browser,
        item,
        args,
        networkRecords,
        effectiveRuntimeManifests,
        executionHostUrl
      );
      if (!run.networkFlushComplete) {
        runDiagnostics.push({
          runOrdinal: item.runOrdinal,
          language: item.language,
          warning: 'Playwright request-size collection did not settle within 2000ms; late worker entries may be absent.',
        });
      }
      if (run.result) {
        samples.push(run.result);
        records.push(...run.result.records);
      } else {
        const error = run.error ?? 'unknown browser sample failure';
        runErrors.push({ runOrdinal: item.runOrdinal, language: item.language, iteration: item.iteration, error });
        records.push(...ALL_PHASES.map((phase) => skippedRecord(item, phase, error)));
      }
      cdpMetrics.push({
        runOrdinal: item.runOrdinal,
        language: item.language,
        iteration: item.iteration,
        ...run.cdpMetrics,
        unsupportedReason: run.cdpUnsupportedReason,
      });
    }

    const summaries = summarize(records);
    const networkSummaries = summarizeNetwork(networkRecords);
    printSummary(summaries, args.engine);
    for (const diagnostic of runDiagnostics) {
      console.warn(`Network warning ${diagnostic.language}#${diagnostic.runOrdinal}: ${diagnostic.warning}`);
    }

    const fullReport = {
      schemaVersion: 'tracecode-public-browser-project-benchmark-v1',
      createdAt: new Date().toISOString(),
      measuredBoundary: {
        productSurface: 'project-browser',
        publicApi: 'createBrowserProjectWorkspace -> RuntimeWorkspace public methods',
        executionLocation: `${args.engine} page, Web Workers, and browser-hosted WebAssembly runtimes`,
        hostNodeRuntimeAssessed: false,
        hostDriver: 'Node.js/tsx launches Playwright, serves static assets, and writes JSON only; its timings are excluded',
        javascriptCommandNote: '`node` is the public browser-project CLI spelling backed by javascript-project-worker.js',
        classicBenchmarkIndependent: 'scripts/benchmark-browser-runtimes.ts',
      },
      methodology: {
        isolation: 'fresh Playwright BrowserContext and fresh project workspace per language/iteration sample',
        projectWorkerIsolation: args.executionHost
          ? 'Java workspace-session worker on a dedicated origin; other runtimes per-command'
          : 'per-command',
        projectWorkerPrewarm: args.prewarm,
        prewarmScope: 'each language sample receives only its configured language depth; unrelated runtime warmups remain zero',
        order: 'deterministic Fisher-Yates shuffle independently per iteration',
        assetCaching: args.cacheAssets
          ? 'immutable browser caching; repeated commands run after the first command populated the same BrowserContext cache'
          : 'disabled with Cache-Control: no-store',
        percentilePolicy: 'p50/p95 are emitted only with at least 5 passing timed samples; smoke results deliberately omit them',
        phases: {
          'workspace-construction': 'await public createBrowserProjectWorkspace with fixture and protected session files',
          'first-command': 'first full language project command on the workspace',
          'second-fresh-command': 'identical command; per-command isolation creates a new user-code worker for worker-backed execution',
          filesystem: 'public writeFile/readFile plus public shell write/read command',
          'policy-denials': 'ordinary shell attempts to read hidden and overwrite readonly session files',
          'http-bridge': 'public workspace.http.listen reached from public shell curl through TraceKernel',
          'process-io': 'shell pipeline plus distinct stdout and stderr streams',
          cancellation: 'AbortSignal cancellation of an active shell command with bounded settlement',
          disposal: 'idempotent workspace disposal and execution-host iframe removal',
        },
      },
      options: {
        engine: args.engine,
        languages: args.languages,
        iterations: args.iterations,
        requestTimeoutMs: args.requestTimeoutMs,
        seed: args.seed,
        cacheAssets: args.cacheAssets,
        executionHost: args.executionHost,
        prewarm: args.prewarm,
        smoke: args.smoke,
        runtimeManifestsPath: args.runtimeManifestsPath,
        runtimeManifestRuntimes: runtimeManifests ? Object.keys(runtimeManifests).sort() : [],
      },
      bundle: {
        entrypoint: 'packages/harness-browser/src/project.ts',
        rawBytes: bundle.rawBytes,
        gzipBytes: bundle.gzipBytes,
        buildMs: bundle.buildMs,
      },
      browser: {
        engine: args.engine,
        userAgents: [...new Set(samples.map((sample) => sample.userAgent))],
        crossOriginIsolatedValues: [...new Set(samples.map((sample) => sample.crossOriginIsolated))],
        longTaskSupport: samples.some((sample) => sample.longTaskSupport),
        memorySupport: {
          performanceMemory: samples.some((sample) => sample.memorySupport.performanceMemory),
          userAgentSpecificMemory: samples.some((sample) => sample.memorySupport.userAgentSpecificMemory),
        },
      },
      metricCoverage: metricCoverage(records, networkRecords, args.engine),
      fixtures: Object.fromEntries(args.languages.map((language) => [language, {
        entrypoint: FIXTURES[language].entrypoint,
        command: FIXTURES[language].command,
        execution: 'browser project adapter',
      }])),
      runPlan,
      summaries,
      networkSummaries,
      samples,
      records,
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

    const failedRecords = records.filter((record) => record.status === 'failed');
    if (failedRecords.length > 0 || runErrors.length > 0) {
      const examples = [
        ...failedRecords.map((record) => `${record.language}/${record.phase}: ${record.errors.join('; ') || 'failed'}`),
        ...runErrors.map((record) => `${record.language}/browser: ${record.error}`),
      ].slice(0, 10);
      throw new Error(
        `Browser project runtime benchmark had ${failedRecords.length + runErrors.length} failing sample phase(s).\n${examples.join('\n')}`
      );
    }
  } finally {
    await browser?.close();
    await executionServer?.close();
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
